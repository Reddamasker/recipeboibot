import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const directory = fs.mkdtempSync(path.join(os.tmpdir(),'trial-reminders-'));
Object.assign(process.env,{ DATABASE_PATH:path.join(directory,'test.sqlite'),TELEGRAM_BOT_TOKEN:'123:test',TELEGRAM_POLLING:'false',BOT_PLATFORM:'telegram',TEST_CONTOUR:'false',DINNER_LLM_ENABLED:'false',DINNER_IMAGES_ENABLED:'false' });
const { db,upsertTelegramUser,allowUser,createRecipe } = await import('../src/db.js');
const { startTrial,grantSubscription,revokeSubscription } = await import('../src/subscriptions.js');
const { runTrialReminderCycle,trialReminderAction,trialReminderReport,configureTrialReminders } = await import('../src/trial-reminders.js');
const { sendTrialRecipeReminder,handleTrialReminderCallback } = await import('../src/telegram.js');
const { productReport,validProductReport } = await import('../src/product-analytics.js');
const started = new Date('2026-10-15T09:00:00Z');
const hour = h => new Date(started.getTime()+h*3600000);
let serial=800100000;
function account() { const from={id:serial++,first_name:'Test'},user=upsertTelegramUser(from);allowUser(user.id);startTrial(user.id,started);return { from,user }; }
function reset() {
  db.exec('DELETE FROM trial_reminder_deliveries; DELETE FROM trial_reminder_members');
  db.prepare('DELETE FROM user_trials').run();
  db.prepare('UPDATE trial_reminder_settings SET started_at=?').run(started.toISOString());
  configureTrialReminders({delayHours:24,intervalHours:48,maxMessages:3,enabled:true});
}
const deliveries = user => db.prepare('SELECT * FROM trial_reminder_deliveries WHERE user_id=?').all(user.id);
test.beforeEach(reset);
test.after(()=>{ db.close();fs.rmSync(directory,{recursive:true,force:true}); });

test('only new trials enter; delay, cadence, duplicate ticks and expiration',async()=>{
  const {user}=account(),old=account();
  db.prepare('UPDATE user_trials SET starts_at=? WHERE user_id=?').run(hour(-1).toISOString(),old.user.id);
  const sent=[];const send=async d=>sent.push(d);
  await runTrialReminderCycle(send,hour(23));assert.equal(sent.length,0);
  await runTrialReminderCycle(send,hour(24));await runTrialReminderCycle(send,hour(24));assert.equal(sent.length,1);
  await runTrialReminderCycle(send,hour(48));assert.equal(sent.length,1);
  await runTrialReminderCycle(send,hour(72));await runTrialReminderCycle(send,hour(120));assert.equal(sent.length,3);
  await runTrialReminderCycle(send,hour(144));await runTrialReminderCycle(send,hour(168));assert.equal(sent.length,3);
  assert.equal(deliveries(old.user).length,0);assert.equal(deliveries(user).length,3);
});
test('quiet hours delay one message; overdue slots are never sent as a burst',async()=>{
  account();let count=0;const send=async()=>count++;
  await runTrialReminderCycle(send,hour(35));assert.equal(count,0);
  await runTrialReminderCycle(send,hour(96));await runTrialReminderCycle(send,hour(96));assert.equal(count,1);
});
test('own import stops reminders; catalogue save does not',async()=>{
  const imported=account(),catalog=account();
  createRecipe(imported.user.id,{title:'Own',status:'ready',sourceType:'text'});
  createRecipe(catalog.user.id,{title:'Catalogue',status:'ready',sourceType:'catalog'});
  const sent=[];await runTrialReminderCycle(async d=>sent.push(d),hour(24));
  assert.deepEqual(sent.map(d=>d.userId),[catalog.user.id]);
});
test('paid access and revoked access suppress delivery',async()=>{
  const paid=account(),revoked=account();
  grantSubscription(paid.user.id,'subscription',hour(200),started);
  grantSubscription(revoked.user.id,'subscription',hour(200),started);
  revokeSubscription(revoked.user.id,started);
  await runTrialReminderCycle(async()=>assert.fail('must not send'),hour(24));
});
test('opt-out is persistent and another account cannot click or stop a delivery',async()=>{
  const a=account(),b=account(),sent=[];
  await runTrialReminderCycle(async d=>sent.push(d),hour(24));
  const d=sent.find(d=>d.userId===a.user.id);
  assert.equal(trialReminderAction(b.user.id,d.id,'stop',hour(25)),false);
  assert.equal(trialReminderAction(a.user.id,d.id,'add',hour(25)),true);
  assert.equal(trialReminderAction(a.user.id,d.id,'add',hour(26)),true);
  assert.equal(deliveries(a.user)[0].clicked_at,hour(25).toISOString());
  trialReminderAction(a.user.id,d.id,'stop',hour(26));
  await runTrialReminderCycle(async d=>assert.notEqual(d.userId,a.user.id),hour(72));
});
test('network uncertainty and blocked recipient stop the chain without retry or error text storage',async()=>{
  const a=account();await runTrialReminderCycle(async()=>{throw new Error('secret URL network failure');},hour(24));
  assert.equal(deliveries(a.user)[0].status,'unknown');
  assert.equal(deliveries(a.user)[0].error_code,'delivery_uncertain');
  await runTrialReminderCycle(async()=>assert.fail('no replay'),hour(72));
});
test('overlapping cycles claim a single message',async()=>{
  const a=account();let release;const gate=new Promise(resolve=>release=resolve);let sends=0;
  const pending=runTrialReminderCycle(async()=>{sends++;await gate;},hour(24));
  await runTrialReminderCycle(async()=>sends++,hour(24));release();await pending;
  assert.equal(sends,1);assert.equal(deliveries(a.user).length,1);
});
test('analytics use completed 24-hour windows and cohort/source filters',async()=>{
  const a=account(),b=account();await runTrialReminderCycle(async()=>{},hour(24));
  createRecipe(a.user.id,{title:'Own',status:'ready',sourceType:'url'});
  db.prepare('UPDATE recipes SET created_at=? WHERE user_id=?').run(hour(25).toISOString(),a.user.id);
  const cohort=[{...a.user,started_at:started.toISOString()}];
  const early=trialReminderReport(cohort,false,hour(47).toISOString());assert.equal(early.eligible24h,0);assert.equal(early.rate24h,null);
  const mature=trialReminderReport(cohort,false,hour(48).toISOString());assert.equal(mature.sentUsers,1);assert.equal(mature.added24h,1);assert.equal(mature.rate24h,100);
  assert.equal(trialReminderReport([{...a.user,started_at:hour(26).toISOString()}],true,hour(48).toISOString()).sent,0);
  assert.equal(trialReminderReport([],false).sent,0);
  const report={...productReport(cohort,false,hour(48).toISOString()),platform:'max'};
  assert.equal(validProductReport(report),true);report.trialReminders.added24h=9;assert.equal(validProductReport(report),false);
});
test('real callback handler opens the existing save flow and the stop button persists opt-out',async()=>{
  const a=account(),messages=[],originalFetch=globalThis.fetch;
  globalThis.fetch=async(url,options)=>{
    assert.ok(String(url).startsWith('https://api.telegram.org/'));
    messages.push(JSON.parse(options.body));return Response.json({ok:true,result:{message_id:1}});
  };
  try {
    await runTrialReminderCycle(sendTrialRecipeReminder,hour(24));
    const markup=messages[0].reply_markup.inline_keyboard;
    assert.ok(markup[0][0].callback_data.length<=64);
    const callback=data=>({id:'callback',from:a.from,message:{chat:{id:a.from.id,type:'private'}},data});
    assert.equal(await handleTrialReminderCallback(callback(markup[0][0].callback_data)),true);
    assert.ok(messages.some(m=>m.text?.includes('Пришлите ссылку, фото')));
    assert.equal(await handleTrialReminderCallback(callback(markup[1][0].callback_data)),true);
    assert.equal(db.prepare('SELECT stop_reason FROM trial_reminder_members WHERE user_id=?').get(a.user.id).stop_reason,'opt_out');
  } finally { globalThis.fetch=originalFetch; }
});
