import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

// Also executed against the published code with an isolated database and intercepted transport.
const probe = String.raw`
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
const originalFetch=globalThis.fetch,messages=[];
globalThis.fetch=async(url,options={})=>{
  const address=new URL(url),body=JSON.parse(options.body||'{}');
  assert.ok(['api.telegram.org','platform-api2.max.ru'].includes(address.hostname),'No AI or real network');
  messages.push(body);
  return Response.json({ok:true,result:{message_id:messages.length},success:true,message:{body:{mid:'retired-'+messages.length,text:body.text},recipient:{chat_type:'dialog',chat_id:Number(address.searchParams.get('user_id')||address.searchParams.get('chat_id')||997001)}}});
};
const {config}=await import('./src/config.js');
assert.equal(config.legacyRecipeFlowsEnabled,false);assert.equal(config.legacyDinnerNotificationsEnabled,false);assert.equal(config.chatRecipeGenerationEnabled,false);
const {db,resolvePrivateTelegramUser,allowUser,setPendingIntent,getPendingIntent,createRecipe}=await import('./src/db.js');
const {handleChatUpdate,handleMyChatMember,sendTrialWelcomeMessage,sendTrialRecipeReminder}=await import('./src/telegram.js');
const {queueTrialWelcome,deliverTrialWelcome,startTrialWelcomeScheduler,stopTrialWelcomeScheduler}=await import('./src/trial-welcome.js');
const {startTrial,grantSubscription}=await import('./src/subscriptions.js');
const {collectionWelcome}=await import('./src/collection-onboarding.js');
const {maxStore}=await import('./src/max-store.js');
const from={id:config.botPlatform==='max'?'max:997001':997001,first_name:'Retirement fixture'},chat={id:from.id,type:'private'};
const user=resolvePrivateTelegramUser(from);allowUser(user.id);
if(config.botPlatform==='max'){maxStore.bind(997001,997001);maxStore.rememberCallback('old','997001');}
const send=text=>handleChatUpdate({message:{from,chat,text}});
const snapshot=()=>db.prepare('SELECT payload_json FROM pending_intents WHERE user_id=?').get(user.id)?.payload_json;
setPendingIntent(user.id,{kind:'dinner-confirm',profileOnly:true,intake:{householdSize:3}});const old=snapshot();
assert.equal(getPendingIntent(user.id),null);assert.equal(snapshot(),old);
await send('на троих');assert.equal(snapshot(),old);assert.match(messages.at(-1).text,/сценарий отключён/);
for(const command of ['/dinner','/find','/find суп','/ingredients','/preferences','/search суп']){await send(command);assert.match(messages.at(-1).text,/сценарий отключён/);}
await handleChatUpdate({callback_query:{id:'old',from,message:{chat},data:'dinner:confirm'}});
assert.equal(snapshot(),old);
for(const command of ['/start','/start dinner','/start dish','/start ingredients']){
  await send(command);assert.equal(messages.at(-1).text,collectionWelcome);assert.equal(getPendingIntent(user.id).kind,'recipe-save');
}
await send('/cancel');assert.equal(getPendingIntent(user.id),null);
setPendingIntent(user.id,{kind:'feedback',resumeIntent:{kind:'recipe-save',resumeIntent:{kind:'dinner-intake'}}});
assert.equal(getPendingIntent(user.id).resumeIntent.kind,'recipe-save');assert.equal(getPendingIntent(user.id).resumeIntent.resumeIntent,null);
await send('/start');await send('/cancel');
await handleMyChatMember({chat,from,old_chat_member:{status:'kicked'},new_chat_member:{status:'member'}});
assert.equal(messages.at(-1).text,collectionWelcome);
startTrial(user.id);
assert.equal(queueTrialWelcome(user.id,from.id,{ready:true}),false);
db.prepare("INSERT INTO trial_welcome_messages(user_id,chat_id,trial_started_at,ready,next_attempt_at) VALUES(?,?,?,1,?)").run(user.id,String(from.id),new Date().toISOString(),new Date().toISOString());
const welcome=JSON.stringify(db.prepare('SELECT * FROM trial_welcome_messages').all());
assert.equal(await deliverTrialWelcome(user.id,assert.fail),false);assert.equal(await sendTrialWelcomeMessage(user.id,from.id,{active:true}),false);
startTrialWelcomeScheduler(assert.fail);stopTrialWelcomeScheduler();assert.equal(JSON.stringify(db.prepare('SELECT * FROM trial_welcome_messages').all()),welcome);
grantSubscription(user.id,'subscription','2099-01-01T00:00:00Z');
const {saveCatalogRecipeForUser}=await import('./src/catalog-handoff.js');const saved=saveCatalogRecipeForUser(user.id,'pasta-tomato').recipe;
const {createServer}=await import('./src/server.js');const {makeTelegramInitData}=await import('./src/security.js');
const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
const data=new URLSearchParams({user:JSON.stringify({id:997001,first_name:'Fixture'}),auth_date:String(Math.floor(Date.now()/1000))});
const secret=createHmac('sha256','WebAppData').update(config.maxToken||'test').digest();
data.set('hash',createHmac('sha256',secret).update([...data].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>k+'='+v).join('\n')).digest('hex'));
const headers={authorization:config.botPlatform==='max'?'mxa '+data:'tma '+makeTelegramInitData(from,config.telegramToken),'content-type':'application/json'};
try{
 for(const [method,route] of [['POST','/api/dinner/open'],['POST','/api/dinner/onboarding/start'],['POST','/api/dinner/recommend'],['POST','/api/dinner/prefetch'],['POST','/api/dinner/next'],['PUT','/api/dinner/profile'],['GET','/api/dinner/tastes'],['PUT','/api/dinner/request'],['POST','/api/recipe-request'],['POST','/api/recipe-request/transcribe'],['POST','/api/suggestions'],['POST','/api/dinner/recommendations/00000000-0000-4000-8000-000000000001/replace']]){
  const res=await originalFetch(base+route,{method,headers,...(method==='GET'?{}:{body:'{}'})});assert.equal(res.status,410,route);
 }
 for(const route of ['/api/me','/api/library','/api/workspace','/api/recipes/'+saved.id,'/api/search?q=паста'])assert.equal((await originalFetch(base+route,{headers})).status,200,route);
 const denials=db.prepare("SELECT duration_ms FROM product_events WHERE user_id=? AND event='operation_finished' AND json_extract(detail_json,'$.status')=410").all(user.id);
 assert.equal(denials.length,12);assert.ok(denials.every(d=>d.duration_ms>=0));
}finally{await new Promise(r=>server.close(r));}
const {runTrialReminderCycle,trialReminderReport,trialReminderAction}=await import('./src/trial-reminders.js');
const {productReport,validProductReport}=await import('./src/product-analytics.js');
const at=new Date('2030-01-02T09:00:00Z'),before=new Date('2030-01-01T09:00:00Z');
db.prepare('UPDATE trial_reminder_settings SET started_at=?').run(before.toISOString());
if(config.botPlatform==='max')db.prepare('UPDATE trial_reminder_rollout SET started_at=?').run(before.toISOString());
// Historical digest rollout must no longer divert the retained save chain.
db.prepare('INSERT OR IGNORE INTO trial_digest_rollout VALUES(1,?)').run('2020-01-01T00:00:00Z');
const fresh=resolvePrivateTelegramUser({id:config.botPlatform==='max'?'max:997002':997002,first_name:'Reminder fixture'});allowUser(fresh.id);startTrial(fresh.id,before);
if(config.botPlatform==='max'){
 await runTrialReminderCycle(assert.fail,at);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM trial_reminder_deliveries WHERE user_id=?').get(fresh.id).n,0);
 assert.equal(db.prepare('SELECT stopped_at FROM trial_reminder_members WHERE user_id=?').get(fresh.id).stopped_at,null);
 maxStore.bind(997002,997002);
}
const delivered=[];const transport=async d=>{delivered.push(d);await sendTrialRecipeReminder(d);};
await runTrialReminderCycle(transport,at);await runTrialReminderCycle(transport,at);assert.equal(delivered.length,1);
const reminder=delivered[0],callback={id:'save-current',from:{id:config.botPlatform==='max'?'max:997002':997002,first_name:'Fixture'},message:{chat:{id:config.botPlatform==='max'?'max:997002':997002,type:'private'}},data:'trial-reminder:add:'+reminder.id};
if(config.botPlatform==='max')maxStore.rememberCallback('save-current','997002');
await handleChatUpdate({callback_query:callback});assert.equal(getPendingIntent(fresh.id).kind,'recipe-save');
const firstClick=db.prepare('SELECT clicked_at FROM trial_reminder_deliveries WHERE id=?').get(reminder.id).clicked_at;
await handleChatUpdate({callback_query:callback});assert.equal(db.prepare('SELECT clicked_at FROM trial_reminder_deliveries WHERE id=?').get(reminder.id).clicked_at,firstClick);
assert.equal(trialReminderAction(user.id,reminder.id,'stop'),false);
createRecipe(fresh.id,{title:'Own import',sourceType:'text',status:'ready'});
db.prepare('UPDATE recipes SET created_at=? WHERE user_id=?').run(new Date(at.getTime()+3600000).toISOString(),fresh.id);
await runTrialReminderCycle(assert.fail,new Date(at.getTime()+48*3600000));
assert.equal(db.prepare('SELECT stop_reason FROM trial_reminder_members WHERE user_id=?').get(fresh.id).stop_reason,'recipe_added');
const cohort=[{...fresh,started_at:before.toISOString()}],report=trialReminderReport(cohort,false,new Date(at.getTime()+24*3600000).toISOString());
assert.equal(report.sent,1);assert.equal(report.clicked,1);assert.equal(report.added24h,1);assert.equal(trialReminderReport([],false).sent,0);
assert.equal(trialReminderReport(cohort,false,new Date(at.getTime()+23*3600000).toISOString()).eligible24h,0);
assert.equal(validProductReport({...productReport(cohort),platform:'max'}),true);
console.log(JSON.stringify({platform:config.botPlatform,retiredApis:12,reminders:'delivered-clicked-stopped',network:'mocked',history:'retained'}));
db.close();
`;
for(const platform of ['telegram','max'])test(`${platform}: retire old entry, cached APIs and welcome; preserve current import entry and measured save reminder`,()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'retired-flows-'));
 try{
  const result=spawnSync(process.execPath,['--input-type=module','-e',probe],{encoding:'utf8',timeout:60000,env:{...process.env,DATABASE_PATH:path.join(dir,'test.sqlite'),BOT_PLATFORM:platform,TELEGRAM_BOT_TOKEN:'123:test',MAX_BOT_TOKEN:'max-test',MAX_BOT_USERNAME:'recipe_test_bot',TELEGRAM_POLLING:'false',TEST_CONTOUR:'false',LEGACY_RECIPE_FLOWS_ENABLED:'',LEGACY_DINNER_NOTIFICATIONS_ENABLED:'true',CHAT_RECIPE_GENERATION_ENABLED:'true',APP_URL:'https://recipes.example.test',DINNER_LLM_ENABLED:'false',DINNER_IMAGES_ENABLED:'false',OPENAI_API_KEY:'unused'}});
  assert.equal(result.status,0,result.stdout+'\n'+result.stderr);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
