import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createImportFailureStore, IMPORT_FAILURE_TTL } from '../src/import-failure-store.js';

function fixture() {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'import-failures-'));
  let at=1800000000000; const file=path.join(dir,'temporary','diagnostics.sqlite');
  const store=createImportFailureStore(file,{now:()=>at});
  return {store,file,advance:n=>{at+=n;},done(){store.close();fs.rmSync(dir,{recursive:true,force:true});}};
}
test('TTL is fixed at first failure, repeats deduplicate, and expiry erases text from the file',()=>{
  const f=fixture();try{
    const text='private-input-marker-7359';const input={userId:'u',text,error:{code:'RECIPE_NOT_FOUND',status:422}};
    f.store.capture(input);const first=f.store.report().rows[0];f.advance(IMPORT_FAILURE_TTL-1);f.store.capture(input);
    const repeat=f.store.report().rows[0];assert.equal(repeat.attempts,2);assert.equal(repeat.expiresAt,first.expiresAt);
    f.advance(1);assert.equal(f.store.purge(),1);assert.equal(f.store.report().rows.length,0);
    assert.equal(fs.readFileSync(f.file).includes(Buffer.from(text)),false);assert.equal(fs.existsSync(f.file+'-wal'),false);
  }finally{f.done();}
});
test('bounds, secret removal, account erasure and successful retry remove retained text',()=>{
  const f=fixture();try{
    f.store.capture({userId:'a',text:'recipe https://example.test/private?token=secret password=secret '+ 'x'.repeat(13000)});
    let row=f.store.report().rows[0];assert.equal(row.text.length,12000);assert.equal(row.truncated,1);assert.doesNotMatch(row.text,/example.test|password=secret/);
    for(let i=0;i<30;i++){f.advance(1);f.store.capture({userId:'b',text:'recipe '+i});}
    assert.equal(f.store.report().rows.length,21);assert.equal(f.store.report().counters.evicted,10);
    f.store.resolved('b','recipe 29');assert.equal(f.store.report().rows.length,20);
    f.store.forget('b');assert.equal(f.store.report().rows.length,1);
    f.store.remove(row.id);assert.equal(f.store.report().rows.length,0);
    for(let i=0;i<510;i++)f.store.capture({userId:'user'+i,text:'limit test'});
    assert.equal(f.store.report().rows.length,500);
  }finally{f.done();}
});

for(const platform of ['telegram','max']) test(`${platform}: real importer, owner signature, denial, deletion, and account cleanup`,()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'import-failure-api-'));
 const code=`
 import assert from 'node:assert/strict';import fs from 'node:fs';
 const {db,upsertTelegramUser,deleteUserData}=await import('./src/db.js');
 const {importText}=await import('./src/importer.js');
 const {importFailureReport,stopImportFailureCleanup}=await import('./src/import-failures.js');
 const {makeTelegramInitData}=await import('./src/security.js');
 const {createServer}=await import('./src/server.js');
 const {openDashboardSession,createDashboardPassword}=await import('./src/funnel-auth.js');
 const user=upsertTelegramUser({id:'${platform==='max'?'max:':''}9002',first_name:'Test'});
 const failure=()=>{throw Object.assign(new Error('unsafe error containing secret text'),{code:'RECIPE_NOT_FOUND',status:422});};
 await assert.rejects(importText(user.id,'private source from form',{normalize:failure,sourceName:'Текст из Mini App'}));
 assert.equal(importFailureReport().rows.length,1);assert.equal(importFailureReport().rows[0].source,'miniapp');
 await assert.rejects(importText(user.id,'tiny'));assert.equal(importFailureReport().rows.length,2);
 await assert.rejects(importText(user.id,'not captured audio',{normalize:failure,sourceType:'audio'}));assert.equal(importFailureReport().rows.length,2);
 await assert.rejects(importText(user.id,'not captured group',{normalize:failure,diagnosticsDisabled:true}));assert.equal(importFailureReport().rows.length,2);
 await assert.rejects(importText(user.id,'   '));assert.equal(importFailureReport().rows.length,2);
 await assert.rejects(importText(user.id,'retry will succeed',{normalize:failure}));assert.equal(importFailureReport().rows.length,3);
 await importText(user.id,'retry will succeed',{normalize:()=>({title:'Проверочный рецепт',ingredients:[{name:'яблоко',quantity:1}],steps:[{text:'Нарезать'}]})});assert.equal(importFailureReport().rows.length,2);
 const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 const auth=(id,token='fixture-token',age=0)=>'${platform==='max'?'mxa':'tma'} '+makeTelegramInitData({id,first_name:'Test'},token,Math.floor(Date.now()/1000)-age);
 const url=base+'/api/owner/import-failures';
 try{
 for(const headers of [{},{authorization:auth(9002)},{authorization:auth(9001,'wrong')},{authorization:auth(9001,'fixture-token',90000)},{cookie:'funnel_session='+openDashboardSession(createDashboardPassword())}]){
  const r=await fetch(url,{headers});assert.ok([401,403].includes(r.status));assert.doesNotMatch(await r.text(),/private source|tiny/);
 }
 const r=await fetch(url,{headers:{authorization:auth(9001)}});assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');
 const data=await r.json();assert.equal(data.rows.length,2);assert.equal(data.platform,'${platform}');assert.ok(!JSON.stringify(data).includes('user_id'));
 const id=data.rows[0].id;
 assert.equal((await fetch(url+'/'+id,{method:'DELETE',headers:{authorization:auth(9002)}})).status,403);
 assert.equal((await fetch(url+'/'+id,{method:'DELETE',headers:{authorization:auth(9001),origin:'https://evil.test'}})).status,403);
 assert.equal((await fetch(url+'/'+id,{method:'DELETE',headers:{authorization:auth(9001)}})).status,200);
 assert.equal(importFailureReport().rows.length,1);
 assert.equal((await fetch(base+'/api/internal/max-funnel',{headers:{authorization:'Bearer '+ 'z'.repeat(64)}})).status,404);
 deleteUserData(user.id);assert.equal(importFailureReport().rows.length,0);
 const erased=upsertTelegramUser({id:'${platform==='max'?'max:':''}9003',first_name:'Deleted during import'});
 await assert.rejects(importText(erased.id,'deleted during import',{normalize:()=>{deleteUserData(erased.id);return failure();}}));assert.equal(importFailureReport().rows.length,0);
 stopImportFailureCleanup();fs.rmSync(process.env.DATABASE_PATH+'.failed-imports',{recursive:true,force:true});fs.writeFileSync(process.env.DATABASE_PATH+'.failed-imports','blocked test path');
 const blocked=upsertTelegramUser({id:'${platform==='max'?'max:':''}9004',first_name:'Storage failure test'});
 await assert.rejects(importText(blocked.id,'storage failure preserves import error',{normalize:failure}),e=>e.code==='RECIPE_NOT_FOUND');
 const dump=db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();assert.equal(dump.some(r=>r.name==='failures'),false);
 }finally{await new Promise(r=>server.close(r));stopImportFailureCleanup();db.close();}
 `;
 try{const r=spawnSync(process.execPath,['--input-type=module','-e',code],{encoding:'utf8',timeout:30000,env:{...process.env,DATABASE_PATH:path.join(dir,'recipes.sqlite'),BOT_PLATFORM:platform,TELEGRAM_BOT_TOKEN:'fixture-token',MAX_BOT_TOKEN:'fixture-token',MAX_BOT_USERNAME:'fixture_bot',ANALYTICS_OWNER_ID:'9001',MAX_ANALYTICS_OWNER_ID:'9001',TEST_CONTOUR:'false',TELEGRAM_POLLING:'false',OPENAI_API_KEY:'',OPENAI_TEXT_MODEL:'',APP_URL:'https://example.test'}});assert.equal(r.status,0,r.stdout+'\n'+r.stderr);}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
