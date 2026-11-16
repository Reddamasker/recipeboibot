import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'landing-direct-'));
Object.assign(process.env,{DATABASE_PATH:path.join(dir,'test.sqlite'),TELEGRAM_BOT_TOKEN:'fixture',TELEGRAM_POLLING:'false',TEST_CONTOUR:'false',BOT_PLATFORM:'telegram',OPENAI_API_KEY:'disabled'});
const {db,upsertTelegramUser}=await import('../src/db.js');
const {createCampaign,recordBotStart,funnelReport}=await import('../src/funnel.js');
const {recordLandingView,landingReport}=await import('../src/landing-funnel.js');
const {recordDirectLandingClick}=await import('../src/landing-direct-links.js');
const {createServer}=await import('../src/server.js');
const slug='ya-product-landing-202611';createCampaign(slug);
const visit=()=>{const visitId=randomUUID().replaceAll('-','');return{visitId,...recordLandingView({visitId,query:'campaign='+slug})};};
test.after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});

test('prepared links do not inflate clicks; direct events, legacy requests and retries share one token',async()=>{
  const before=landingReport(slug),adBefore=funnelReport(slug).clicks,v=visit();
  assert.match(v.links.telegram,/^https:\/\/t.me\/Recipeboibot\?start=lp_[\w-]{24}$/);
  assert.match(v.links.max,/^https:\/\/max.ru\/id500912857935_bot\?start=lc_ya-product-landing-202611_[\w-]{24}$/);
  assert.equal(landingReport(slug).telegramClicks,before.telegramClicks);
  assert.equal(landingReport(slug).maxClicks,before.maxClicks);
  assert.equal(funnelReport(slug).clicks,adBefore);
  assert.deepEqual(recordLandingView({visitId:v.visitId,query:'campaign=other'}).links,v.links);
  for(const platform of ['telegram','max'])for(let i=0;i<2;i++)recordDirectLandingClick({visitId:v.visitId,platform,elapsedMs:0});
  assert.equal(landingReport(slug).telegramClicks,before.telegramClicks+1);
  assert.equal(landingReport(slug).maxClicks,before.maxClicks+1);
  assert.equal(funnelReport(slug).clicks,adBefore+1);
  assert.equal(landingReport('site-landing').directLinks.length,0);
});

test('Telegram start before click receipt retains attribution; late retry preserves earlier time and does not duplicate',()=>{
  const v=visit(),u=upsertTelegramUser({id:880001001}),payload=new URL(v.links.telegram).searchParams.get('start');
  const startAt=new Date(Date.now()+1000);
  recordBotStart(u,'/start '+payload,startAt,'direct-race-1');
  assert.equal(db.prepare('SELECT campaign FROM acquisition_starts WHERE user_id=?').get(u.id).campaign,slug);
  assert.equal(landingReport(slug).directLinks.find(r=>r.platform==='telegram').recoveredWithoutReceipt,1);
  const before=landingReport(slug).telegramClicks;
  const event={visitId:v.visitId,platform:'telegram',elapsedMs:0};
  recordDirectLandingClick(event);const first=db.prepare('SELECT telegram_clicked_at FROM landing_visits WHERE id=?').get(v.visitId).telegram_clicked_at;
  assert.ok(first<startAt.toISOString());
  recordDirectLandingClick({...event,elapsedMs:100});
  assert.equal(db.prepare('SELECT telegram_clicked_at FROM landing_visits WHERE id=?').get(v.visitId).telegram_clicked_at,first);
  assert.equal(landingReport(slug).telegramClicks,before);
  assert.equal(landingReport(slug).directLinks.find(r=>r.platform==='telegram').recoveredWithoutReceipt,0);
});

test('click endpoint rejects cross-origin, invalid, missing and probe events; storage error is retryable',async()=>{
  const v=visit(),server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const url=`http://127.0.0.1:${server.address().port}/api/landing/click`,event={visitId:v.visitId,platform:'max',elapsedMs:0};
  const send=(body=event,headers={})=>fetch(url,{method:'POST',headers:{'content-type':'application/json','x-landing-request':'1',...headers},body:JSON.stringify(body)});
  try{
    assert.equal((await fetch(url)).status,405);
    assert.equal((await send(event,{origin:'https://evil.example'})).status,403);
    assert.equal((await send({...event,elapsedMs:-1})).status,400);
    assert.equal((await send({...event,visitId:'0'.repeat(32)})).status,404);
    assert.equal((await send(event,{'user-agent':'YandexBot'})).status,200);
    assert.equal(db.prepare('SELECT max_clicked_at FROM landing_visits WHERE id=?').get(v.visitId).max_clicked_at,null);
    db.exec("CREATE TEMP TRIGGER direct_fail BEFORE UPDATE OF max_clicked_at ON landing_visits BEGIN SELECT RAISE(ABORT,'fixture'); END");
    assert.equal((await send()).status,500);db.exec('DROP TRIGGER direct_fail');
    assert.equal((await send()).status,200);
    assert.ok(db.prepare('SELECT max_clicked_at FROM landing_visits WHERE id=?').get(v.visitId).max_clicked_at);
  }finally{await new Promise(r=>server.close(r));}
});

async function client({failClick=false,storageFails=false,stored=null}={}){
  const calls=[],events={},timers=[],storage=new Map(stored?[["recipe-landing-clicks-v1",stored]]:[]);
  class Element{closest(){return this;}}
  const tg=Object.assign(new Element(),{href:'https://t.me/Recipeboibot?start=collection',dataset:{landingPlatform:'telegram'}});
  const max=Object.assign(new Element(),{href:'https://max.ru/id500912857935_bot?start=collection',dataset:{landingPlatform:'max'}});
  const root={hidden:false,getClientRects:()=>[{}],querySelectorAll:()=>[tg,max],addEventListener:(name,fn)=>events['root:'+name]=fn};
  const document={visibilityState:'visible',readyState:'complete',getElementById:()=>root,addEventListener:(name,fn)=>events['doc:'+name]=fn};
  let fail=failClick;
  const links={telegram:'https://t.me/Recipeboibot?start=lp_'+'a'.repeat(24),max:'https://max.ru/id500912857935_bot?start=lc_site-landing_'+'b'.repeat(24)};
  vm.runInNewContext(fs.readFileSync('public/landing-metrics.js','utf8'),{document,Element,window:{addEventListener:(name,fn)=>events[name]=fn},location:{origin:'https://site.example',search:''},
    crypto:{getRandomValues:b=>b.fill(1)},URL,URLSearchParams,Uint8Array,AbortSignal,performance:{now:()=>25},navigator:{onLine:true},
    sessionStorage:{getItem:k=>{if(storageFails)throw Error('blocked');return storage.get(k);},setItem:(k,v)=>{if(storageFails)throw Error('blocked');storage.set(k,v);}},
    setTimeout:fn=>{timers.push(fn);return timers.length;},clearTimeout:()=>{},
    fetch:async(url,options)=>{calls.push({url,body:JSON.parse(options.body),keepalive:options.keepalive});if(url.endsWith('/click')&&fail)throw Error('offline');return{ok:true,json:async()=>({links,linkAgesMs:{telegram:0,max:0}})};}});
  const tick=()=>new Promise(r=>setImmediate(r));await tick();
  const click=(target,isTrusted=true)=>events['root:click']({target,isTrusted,preventDefault:()=>assert.fail('Navigation must remain native')});
  return{calls,events,timers,storage,tg,max,root,document,click,tick,recover:()=>{fail=false;}};
}

test('native clicks navigate directly while failed telemetry retries the same event without duplicate or hidden clicks',async()=>{
  const c=await client({failClick:true});assert.ok(c.tg.href.startsWith('https://t.me/'));assert.ok(c.max.href.startsWith('https://max.ru/'));
  c.click(c.tg,false);assert.equal(c.calls.length,1);
  c.document.visibilityState='hidden';c.click(c.tg);assert.equal(c.calls.length,1);c.document.visibilityState='visible';
  c.click(c.tg);await c.tick();const first=c.calls[1];assert.equal(first.url,'/api/landing/click');assert.equal(first.keepalive,true);
  c.click(c.tg);await c.tick();assert.equal(c.calls.length,2);
  c.recover();await c.timers.shift()();await c.tick();assert.deepEqual(c.calls[2].body,first.body);
  assert.equal(JSON.parse(c.storage.get('recipe-landing-clicks-v1')).queue.length,0);
  c.click(c.max);await c.tick();assert.equal(c.calls[3].body.platform,'max');
});

test('blocked storage keeps direct navigation and in-memory delivery; pending events resume after page reload',async()=>{
  const blocked=await client({storageFails:true});blocked.click(blocked.max);await blocked.tick();assert.equal(blocked.calls[1].body.storageError,1);
  const first=await client({failClick:true});first.click(first.max);await first.tick();
  const restored=await client({stored:first.storage.get('recipe-landing-clicks-v1')});
  assert.equal(restored.calls.filter(c=>c.url.endsWith('/click')).length,1);
  assert.equal(JSON.parse(restored.storage.get('recipe-landing-clicks-v1')).queue.length,0);
});
