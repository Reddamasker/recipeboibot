import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'trial-reminders-max-'));
Object.assign(process.env,{DATABASE_PATH:path.join(directory,'test.sqlite'),BOT_PLATFORM:'max',MAX_BOT_TOKEN:'max-test-secret',TELEGRAM_POLLING:'false',DINNER_LLM_ENABLED:'false',DINNER_IMAGES_ENABLED:'false',TEST_CONTOUR:'false'});
const {db,resolvePrivateTelegramUser,allowUser}=await import('../src/db.js');
const {startTrial}=await import('../src/subscriptions.js');
const {runTrialReminderCycle}=await import('../src/trial-reminders.js');
const {sendTrialRecipeReminder,handleChatUpdate}=await import('../src/telegram.js');
const {normalizeMaxUpdate}=await import('../src/max-events.js');
const {maxStore}=await import('../src/max-store.js');
test.after(()=>{db.close();fs.rmSync(directory,{recursive:true,force:true});});
test('MAX rollout excludes older trials and retains its start timestamp across reads',async()=>{
 const at=new Date('2032-01-02T09:00:00Z'),before=new Date('2032-01-01T09:00:00Z');
 db.prepare("UPDATE trial_reminder_rollout SET started_at=? WHERE platform='max'").run(before.toISOString());
 const old=resolvePrivateTelegramUser({id:'max:87655',first_name:'Before rollout'});
 allowUser(old.id);maxStore.bind('98766','87655');startTrial(old.id,new Date(before.getTime()-3600000));
 await runTrialReminderCycle(assert.fail,at);
 assert.equal(db.prepare('SELECT 1 FROM trial_reminder_members WHERE user_id=?').get(old.id),undefined);
 assert.equal(db.prepare("SELECT started_at FROM trial_reminder_rollout WHERE platform='max'").get().started_at,before.toISOString());
});
test('MAX trial reminder uses owned callback buttons and persists add and opt-out actions', async () => {
  const at = new Date('2026-11-01T09:00:00Z'), owner = resolvePrivateTelegramUser({ id:'max:87654',first_name:'Trial test' });
  allowUser(owner.id);startTrial(owner.id,at);
  db.prepare('UPDATE trial_reminder_settings SET started_at=?').run(at.toISOString());
  db.prepare("UPDATE trial_reminder_rollout SET started_at=? WHERE platform='max'").run(at.toISOString());
  maxStore.bind('98765','87654');
  const messages=[],original=global.fetch;
  global.fetch=async(url,options)=>{
    assert.equal(new URL(url).hostname,'platform-api2.max.ru');
    const body=JSON.parse(options.body);
    if(new URL(url).pathname==='/answers')return Response.json({success:true});
    messages.push(body);
    return Response.json({message:{body:{mid:'nudge-'+messages.length,text:body.text},recipient:{chat_type:'dialog',chat_id:98765}}});
  };
  try {
    await runTrialReminderCycle(sendTrialRecipeReminder,new Date(at.getTime()+86400000));
    assert.equal(messages.length,1);
    const buttons=messages[0].attachments[0].payload.buttons;
    for(const [index,action] of ['add','stop'].entries()) {
      const event={update_type:'message_callback',callback:{callback_id:'nudge-action-'+index,payload:buttons[index][0].payload,user:{user_id:87654,first_name:'Trial test'}},message:{sender:{user_id:777,is_bot:true},recipient:{chat_type:'dialog',chat_id:98765},body:{mid:'nudge-1'}}};
      const update=normalizeMaxUpdate(event,{botId:777});assert.ok(update);
      await handleChatUpdate(update);
      const delivery=db.prepare('SELECT * FROM trial_reminder_deliveries WHERE user_id=?').get(owner.id);
      assert.ok(action==='add'?delivery.clicked_at:delivery.opted_out_at);
    }
    assert.ok(messages.some(m=>m.text.includes('Пришлите ссылку, фото')));
    assert.equal(db.prepare('SELECT stop_reason FROM trial_reminder_members WHERE user_id=?').get(owner.id).stop_reason,'opt_out');
  } finally {global.fetch=original;}
});
