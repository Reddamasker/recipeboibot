import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
const file = `data/log-status-${randomUUID()}.sqlite`;
Object.assign(process.env,{DATABASE_PATH:file,TELEGRAM_BOT_TOKEN:'log-status-test',TELEGRAM_POLLING:'false',TEST_CONTOUR:'false',BOT_PLATFORM:'telegram',DINNER_LLM_ENABLED:'false',DINNER_IMAGES_ENABLED:'false',OPENAI_API_KEY:'disabled'});
const {db,upsertTelegramUser,allowUser}=await import('../src/db.js');
const {productOperation,productReport}=await import('../src/product-analytics.js');
const {log}=await import('../src/log.js');
test.after(()=>{db.close();for(const suffix of ['','-wal','-shm'])fs.rmSync(file+suffix,{force:true});});

test('caught chat access restrictions keep their status in stored events and dashboard',async()=>{
 for(const [index,status,expected] of [[1,402,402],[2,409,409],[3,undefined,500],[4,200,500],[5,'402',500]]){
  const u=upsertTelegramUser({id:890000+index});allowUser(u.id);
  await productOperation('request',async()=>{
   try{throw Object.assign(new Error('Synthetic restriction'),{status});}
   catch(error){log('error','synthetic_handled_error',{error});return 'handled';}
  },{userId:u.id});
  const rows=db.prepare('SELECT detail_json FROM product_events WHERE user_id=? AND event=?').all(u.id,'operation_finished');
  assert.equal(rows.length,1);
  assert.equal(JSON.parse(rows[0].detail_json).status,expected);
  assert.equal(productReport([{id:u.id}]).errors[0].code,`http_${expected}`);
 }
});

test('an error in another concurrent request never marks a successful operation',async()=>{
 const a=upsertTelegramUser({id:890010}),b=upsertTelegramUser({id:890011});allowUser(a.id);allowUser(b.id);
 await Promise.all([
  productOperation('request',async()=>{await new Promise(r=>setTimeout(r,10));},{userId:a.id}),
  productOperation('request',async()=>{log('error','synthetic_failure',{error:new Error('Synthetic failure')});},{userId:b.id})
 ]);
 assert.equal(productReport([{id:a.id}]).errors.length,0);
 assert.equal(productReport([{id:b.id}]).errors[0].code,'http_500');
});
