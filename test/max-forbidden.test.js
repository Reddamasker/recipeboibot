import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
const file = `data/max-forbidden-${randomUUID()}.sqlite`;
Object.assign(process.env, { DATABASE_PATH:file, BOT_PLATFORM:'max', MAX_BOT_TOKEN:'unit-secret', MAX_BOT_USERNAME:'recipe_test_bot', TELEGRAM_POLLING:'false', DINNER_LLM_ENABLED:'false', DINNER_IMAGES_ENABLED:'false', OPENAI_API_KEY:'disabled', TEST_CONTOUR:'false' });
const { db, resolvePrivateTelegramUser } = await import('../src/db.js');
const { createMaxStore, maxStore } = await import('../src/max-store.js');
const { createMaxClient } = await import('../src/max-client.js');
const { MaxApiError, withMaxDelivery } = await import('../src/max-api-error.js');
const { startMaxWorker, enqueueMaxUpdate } = await import('../src/max-events.js');
const { handleChatUpdate } = await import('../src/telegram.js');
const { productReport, validProductReport } = await import('../src/product-analytics.js');
const incoming = (id=17, text='Ужин') => ({ update_type:'message_created', timestamp:Date.now(), message:{ sender:{user_id:id,is_bot:false}, recipient:{chat_id:id+1000,chat_type:'dialog'}, body:{mid:randomUUID(),text} } });
const message = id => ({ message:{recipient:{chat_id:id+1000,chat_type:'dialog'},body:{mid:randomUUID(),text:'Готово'}} });
test.after(()=>{db.close();for(const suffix of ['','-wal','-shm'])fs.rmSync(file+suffix,{force:true});});

test('403 is terminal for one update: no fallback send, duplicate delivery or restart retry; new update succeeds',async()=>{
 const database=new DatabaseSync(':memory:'),store=createMaxStore(database),event=incoming();
 const queued=enqueueMaxUpdate(event,{store}),reports=[];let calls=0,work=0,forbidden=true;
 const client=createMaxClient({maxToken:'secret'},{store,sleep:async()=>{},fetchImpl:async()=>{calls++;return forbidden?Response.json({code:'bot.blocked',message:'private text and secret'},{status:403}):Response.json(message(17));}});
 const run=()=>startMaxWorker(async()=>{work++;try{await client.chatCall('sendMessage',{chat_id:'max:17',text:'result'});}catch{try{await client.chatCall('sendMessage',{chat_id:'max:17',text:'error'});}catch{ /* Existing workflow may swallow a send error. */ }}},{store,retryDelayMs:0,onError:r=>reports.push(r)});
 try{
  let worker=run();await worker.wake();await worker.stop();
  assert.equal(calls,1);assert.equal(work,1);assert.deepEqual({...store.status(queued.eventId)},{status:'failed',attempts:1});
  assert.equal(reports[0].status,403);assert.equal(reports[0].terminal,true);assert.equal(reports[0].providerCode,'bot.blocked');
  assert.equal(JSON.stringify(reports).includes('private text'),false);
  assert.equal(enqueueMaxUpdate(event,{store}).inserted,false);
  worker=run();await worker.wake();await worker.stop();assert.equal(work,1);
  forbidden=false;const next=enqueueMaxUpdate(incoming(),{store});worker=run();await worker.wake();await worker.stop();
  assert.equal(calls,2);assert.equal(work,2);assert.equal(store.status(next.eventId).status,'done');
 }finally{database.close();}
});

test('non-JSON 403 retains terminal status and arbitrary upstream code/message never enters diagnostics',async()=>{
 for(const payload of [()=>new Response('private gateway page',{status:403}),()=>Response.json({code:'sk-private-or-user-text',message:'secret URL'},{status:403})]){
  const client=createMaxClient({maxToken:'secret'},{fetchImpl:async()=>payload()});
  await assert.rejects(withMaxDelivery(()=>client.api('/messages',{method:'POST',query:{user_id:17}})),e=>{
   assert.ok(e instanceof MaxApiError);assert.equal(e.status,403);assert.equal(e.providerCode,'unknown');assert.equal(e.reason,'forbidden');assert.equal(e.apiResource,'messages');
   assert.doesNotMatch(JSON.stringify(e),/private|secret|user_id/);return true;
  });
 }
});

test('429, 5xx and network failures keep bounded retries; terminal context never contaminates another update',async()=>{
 for(const status of [429,503,null]){
  const database=new DatabaseSync(':memory:'),store=createMaxStore(database);const queued=enqueueMaxUpdate(incoming(),{store});let calls=0;
  const client=createMaxClient({maxToken:'secret'},{store,sleep:async()=>{},fetchImpl:async()=>{if(++calls===1){if(status===null)throw Error('network');return Response.json({message:'temporary'},{status});}return Response.json(message(17));}});
  const worker=startMaxWorker(()=>client.chatCall('sendMessage',{chat_id:'max:17',text:'result'}),{store,retryDelayMs:0});
  await worker.wake();await worker.stop();assert.equal(calls,2);assert.equal(store.status(queued.eventId).status,'done');database.close();
 }
 const client=createMaxClient({maxToken:'secret'},{fetchImpl:async url=>Number(url.searchParams.get('user_id'))===17?new Response('',{status:403}):Response.json({ok:true})});
 const results=await Promise.allSettled([withMaxDelivery(()=>client.api('/messages',{query:{user_id:17}})),withMaxDelivery(()=>client.api('/messages',{query:{user_id:18}}))]);
 assert.equal(results[0].status,'rejected');assert.equal(results[1].status,'fulfilled');
});

test('real MAX start handler stores one 403 operation, no delivery, valid filtered dashboard, then accepts another update',async()=>{
 const original=global.fetch;let calls=0,denied=true;
 global.fetch=async(url)=>{
  assert.equal(new URL(url).hostname,'platform-api2.max.ru');calls++;
  return denied?Response.json({code:'forbidden',message:'redacted fixture'},{status:403}):Response.json(message(77171));
 };
 const event=incoming(77171,'/start'),queued=enqueueMaxUpdate(event),reports=[];
 try{
  let worker=startMaxWorker(handleChatUpdate,{retryDelayMs:0,onError:r=>reports.push(r)});await worker.wake();await worker.stop();
  assert.equal(calls,1);assert.equal(maxStore.status(queued.eventId).status,'failed');
  const user=resolvePrivateTelegramUser({id:'max:77171'});
  const operations=db.prepare("SELECT detail_json FROM product_events WHERE user_id=? AND event='operation_finished'").all(user.id);
  assert.equal(operations.length,1);assert.equal(JSON.parse(operations[0].detail_json).status,403);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM product_events WHERE user_id=? AND event='chat_prompt_delivered'").get(user.id).n,0);
  const report=productReport([user]);assert.equal(validProductReport(report),true);assert.equal(report.errors[0].code,'http_403');
  assert.equal(productReport([]).errors.length,0);
  denied=false;const second=enqueueMaxUpdate(incoming(77171,'/start'));worker=startMaxWorker(handleChatUpdate,{retryDelayMs:0});await worker.wake();await worker.stop();
  assert.equal(maxStore.status(second.eventId).status,'done');assert.ok(calls>1);
 }finally{global.fetch=original;}
});
