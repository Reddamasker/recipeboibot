// Historical compatibility only; deployed defaults are covered by retired-flows.test.js.
process.env.LEGACY_RECIPE_FLOWS_ENABLED = 'true';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const directory=fs.mkdtempSync(path.join(os.tmpdir(),'recipe-max-entry-welcome-'));
Object.assign(process.env,{
 BOT_PLATFORM:'max',MAX_BOT_TOKEN:'max-entry-welcome-test',MAX_BOT_USERNAME:'recipe_test_bot',
 TELEGRAM_BOT_TOKEN:'',TELEGRAM_POLLING:'false',TEST_CONTOUR:'false',BILLING_REQUIRED:'false',
 DATABASE_PATH:path.join(directory,'recipes.sqlite'),APP_URL:'https://recipes.example.test',
 DINNER_LLM_ENABLED:'false',DINNER_IMAGES_ENABLED:'false',LEGACY_DINNER_NOTIFICATIONS_ENABLED:'false'
});
const {db,resolvePrivateTelegramUser}=await import('../src/db.js');
const {startTrial,getTrialStatus}=await import('../src/subscriptions.js');
const {queueTrialWelcome,deliverTrialWelcome,startTrialWelcomeScheduler,stopTrialWelcomeScheduler}=await import('../src/trial-welcome.js');
const {normalizeMaxUpdate}=await import('../src/max-events.js');
const {maxStore}=await import('../src/max-store.js');
const {handleChatUpdate}=await import('../src/telegram.js');
let serial=930000,mid=0;
const originalFetch=globalThis.fetch;
globalThis.fetch=async(url,options)=>{
 const target=new URL(url);
 assert.equal(target.hostname,'platform-api2.max.ru','No real network or AI calls');
 assert.equal(target.pathname,'/messages');
 const userId=target.searchParams.get('user_id'),body=JSON.parse(options.body);
 return Response.json({message:{sender:{user_id:777,is_bot:true},recipient:{chat_type:'dialog',chat_id:1000000+Number(userId)},body:{mid:`welcome-${++mid}`,text:body.text,attachments:body.attachments}}});
};
test.after(()=>{stopTrialWelcomeScheduler();globalThis.fetch=originalFetch;db.close();fs.rmSync(directory,{recursive:true,force:true});});
const row=id=>db.prepare('SELECT * FROM trial_welcome_messages WHERE user_id=?').get(id);
function fresh(){
 const id=serial++,user=resolvePrivateTelegramUser({id:`max:${id}`,first_name:'App-first test'});
 startTrial(user.id);queueTrialWelcome(user.id,`max:${id}`,{ready:true});
 return {id,user};
}

test('app-only MAX trial waits silently, then an actual start enables exactly one welcome',async()=>{
 const account=fresh(),deadline=getTrialStatus(account.user.id).expiresAt;
 let sent=0;
 for(let i=0;i<3;i++)assert.equal(await deliverTrialWelcome(account.user.id,async()=>{sent++;}),false);
 assert.equal(sent,0);assert.equal(row(account.user.id).status,'pending');
 assert.equal(row(account.user.id).attempts,0);assert.equal(row(account.user.id).last_error,null);
 assert.equal(db.prepare('SELECT is_allowed FROM users WHERE id=?').get(account.user.id).is_allowed,0);
 assert.equal(db.prepare('SELECT 1 FROM acquisition_starts WHERE user_id=?').get(account.user.id),undefined);
 const update=normalizeMaxUpdate({update_type:'bot_started',timestamp:Date.now(),chat_id:1000000+account.id,user:{user_id:account.id,first_name:'App-first test'},payload:'collection'});
 await handleChatUpdate({...update,update_id:'max-entry-welcome-start'});
 assert.equal(db.prepare('SELECT is_returning FROM acquisition_starts WHERE user_id=?').get(account.user.id).is_returning,0);
 assert.equal(db.prepare('SELECT is_allowed FROM users WHERE id=?').get(account.user.id).is_allowed,1);
 assert.equal(await deliverTrialWelcome(account.user.id,async()=>{sent++;}),true);
 assert.equal(await deliverTrialWelcome(account.user.id,async()=>{sent++;}),false);
 assert.equal(sent,1);assert.equal(row(account.user.id).attempts,1);assert.equal(row(account.user.id).status,'sent');
 assert.equal(getTrialStatus(account.user.id).expiresAt,deadline);
});

test('expired app-only trial is cancelled without a delivery attempt',async()=>{
 const account=fresh();
 db.prepare('UPDATE user_trials SET expires_at=? WHERE user_id=?').run('2020-01-01',account.user.id);
 await deliverTrialWelcome(account.user.id,async()=>assert.fail('Expired trial must not send'));
 assert.equal(row(account.user.id).status,'cancelled');assert.equal(row(account.user.id).attempts,0);
});

test('waiting MAX app-only accounts cannot starve connected welcome delivery',async()=>{
 for(let i=0;i<25;i++)fresh();
 const connected=fresh();maxStore.bind(1000000+connected.id,connected.id);
 const sends=[];
 startTrialWelcomeScheduler(async(userId)=>{sends.push(userId);});
 try{
  for(let i=0;i<50&&row(connected.user.id).status!=='sent';i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.deepEqual(sends,[connected.user.id]);
  assert.equal(row(connected.user.id).status,'sent');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM trial_welcome_messages WHERE status='pending' AND attempts<>0").get().n,0);
 }finally{stopTrialWelcomeScheduler();}
});

test('private test welcome follows the verified owner chat without changing owner trial',async()=>{
 const owner=resolvePrivateTelegramUser({id:`max:${serial++}`,first_name:'Owner'});
 const profile=resolvePrivateTelegramUser({id:'private-test:max-entry-welcome',first_name:'Isolated profile'});
 db.prepare('INSERT INTO private_test_profiles(owner_user_id,test_user_id,created_at) VALUES(?,?,?)').run(owner.id,profile.id,new Date().toISOString());
 startTrial(profile.id);queueTrialWelcome(profile.id,owner.telegram_id,{ready:true});
 let sent=0;
 await deliverTrialWelcome(profile.id,async()=>{sent++;});assert.equal(sent,0);
 maxStore.bind(1000000+serial,owner.telegram_id.slice(4));
 await deliverTrialWelcome(profile.id,async(userId,chatId)=>{assert.equal(userId,profile.id);assert.equal(chatId,owner.telegram_id);sent++;});
 assert.equal(sent,1);assert.equal(getTrialStatus(owner.id).used,false);
});
