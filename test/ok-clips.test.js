import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

for (const platform of ['telegram','max']) test(`${platform}: OK clip failures, retry, saved source and duplicate accounting`, () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ok-import-test-'));
  try {
    const source=`
      import assert from 'node:assert/strict';
      const {db,upsertTelegramUser}=await import('./src/db.js');
      const {importUrl}=await import('./src/importer.js');
      const {productOperation}=await import('./src/product-analytics.js');
      const user=upsertTelegramUser({id:'${platform==='max'?'max:':''}9011',first_name:'Fixture'});
      const url='https://ok.ru/clip?clip_id=456241789&owner_id=-211246947&ref=ok';
      let extracts=0,normalizes=0,fail=true;
      const adapters={extractSocial:async (input,options)=>{
        extracts++;assert.equal(input,'https://ok.ru/clip?owner_id=-211246947&clip_id=456241789');assert.equal(options.userId,user.id);
        if(fail)throw Object.assign(new Error('Публичное видео недоступно'),{status:422,code:'SOCIAL_VIDEO_UNAVAILABLE'});
        return {url:input,sourceName:'Одноклассники · Автор',text:'Яйца 4 шт. Мука 80 г. Взбить яйца с сахаром, добавить муку, выпекать десять минут. Охладить с кремом один час.',warnings:[]};
      },normalize:async input=>{
        normalizes++;assert.match(input.text,/Яйца 4 шт/);assert.equal(input.sourceName,'Одноклассники · Автор');
        return {title:'Молочный ломтик',ingredients:[{name:'яйцо',quantity:4,unit:'шт'}],steps:[{text:'Выпечь бисквит и охладить с кремом.'}],warnings:[]};
      }};
      const run=input=>productOperation('import',()=>importUrl(user.id,input,adapters),{userId:user.id});
      await assert.rejects(run(url),e=>e.code==='SOCIAL_VIDEO_UNAVAILABLE');
      assert.equal(normalizes,0);
      assert.equal(db.prepare('SELECT status FROM import_jobs WHERE user_id=?').get(user.id).status,'failed');
      fail=false;const saved=await run(url);
      assert.equal(saved.state,'created');assert.equal(saved.recipe.sourceName,'Одноклассники · Автор');
      assert.equal(saved.recipe.sourceUrl,'https://ok.ru/clip?owner_id=-211246947&clip_id=456241789');
      for(const variant of ['https://m.ok.ru/clip/-211246947/456241789?ref=test','https://vk.com/clip-211246947_456241789']){
        const duplicate=await run(variant);assert.equal(duplicate.state,'existing');assert.equal(duplicate.recipe.id,saved.recipe.id);
      }
      assert.equal(extracts,2);assert.equal(normalizes,1);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM import_jobs WHERE user_id=?').get(user.id).n,1);
      assert.equal(db.prepare('SELECT status FROM import_jobs WHERE user_id=?').get(user.id).status,'ready');
      assert.equal(db.prepare('SELECT COUNT(*) n FROM recipes WHERE user_id=?').get(user.id).n,1);
      const events=db.prepare("SELECT duration_ms,detail_json FROM product_events WHERE user_id=? AND event='operation_finished' ORDER BY rowid").all(user.id);
      assert.deepEqual(events.map(x=>JSON.parse(x.detail_json).status),[422,200,200,200]);
      assert.ok(events.every(x=>x.duration_ms>=0));assert.doesNotMatch(JSON.stringify(events),/ok.ru|Молочный|456241789/);
      db.close();console.log('OK');
    `;
    const r=spawnSync(process.execPath,['--input-type=module','-e',source],{encoding:'utf8',env:{...process.env,
      DATABASE_PATH:path.join(dir,'test.sqlite'),BOT_PLATFORM:platform,TELEGRAM_POLLING:'false',OPENAI_API_KEY:'fixture',TEST_CONTOUR:'false'},timeout:30000});
    assert.equal(r.status,0,r.stderr+'\n'+r.stdout);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
