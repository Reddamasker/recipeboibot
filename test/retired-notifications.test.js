import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Run against both platform configurations, twice against the same retained data.
// No production credentials, transport, polling or AI calls are used.
const probe = String.raw`
  import assert from 'node:assert/strict';
  import { randomUUID } from 'node:crypto';
  const {config}=await import('./src/config.js');
  assert.equal(config.legacyDinnerNotificationsEnabled,false);
  const {db,upsertTelegramUser,allowUser}=await import('./src/db.js');
  const {grantSubscription,startTrial}=await import('./src/subscriptions.js');
  const store=await import('./src/notification-store.js');
  const digest=await import('./src/trial-digest-store.js');
  const notifications=await import('./src/notifications.js');
  const {sendNotificationReminder}=await import('./src/telegram.js');
  const {sendDigestBatch,sendDigestWelcome}=await import('./src/trial-digest.js');
  const {recoverDigestWelcomes}=await import('./src/trial-welcome.js');
  const at=new Date(),old=new Date(at.getTime()-86400000).toISOString();
  const raw={id:71999101,first_name:'Retirement fixture'};
  const user=upsertTelegramUser(raw);allowUser(user.id);
  grantSubscription(user.id,'subscription','2099-01-01T00:00:00Z');
  if(!db.prepare('SELECT 1 FROM notification_schedules WHERE user_id=?').get(user.id)) {
    db.prepare('INSERT INTO notification_schedules(user_id,enabled,weekdays_json,local_time,timezone,next_due_at,created_at,updated_at,first_enabled_at) VALUES(?,1,?,?,?,?,?,?,?)')
      .run(user.id,'[0,1,2,3,4,5,6]','17:20','Europe/Moscow',old,old,old,old);
    db.prepare('INSERT INTO trial_digest_rollout VALUES(1,?)').run(old);
    db.prepare('INSERT INTO trial_digest_members VALUES(?,?,?,?,NULL)').run(user.id,old,old,1);
    for(const status of ['queued','sent','chosen']) db.prepare('INSERT INTO notification_deliveries(id,user_id,scheduled_for,local_key,status,reminder_retry_at,choice_retry_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(randomUUID(),user.id,old,status,status,old,old,old,old);
    db.prepare("INSERT INTO trial_digest_parts(user_id,part_key,kind,created_at,due_at,status,next_attempt_at) VALUES(?,'pending-part','recipe',?,?,'pending',?)").run(user.id,old,old,old);
  }
  const tables=['notification_schedules','notification_deliveries','trial_digest_rollout','trial_digest_members','trial_digest_parts','dinner_sessions'];
  const snapshot=()=>JSON.stringify(tables.map(t=>db.prepare('SELECT * FROM '+t).all()));
  const before=snapshot();
  const reportBefore=digest.trialDigestReport([{id:user.id}],false);
  globalThis.fetch=async()=>assert.fail('Retired notifications must not reach any network/AI transport');
  const adapters={sendReminder:assert.fail,sendChoice:assert.fail,send:assert.fail,url:assert.fail};
  for(const time of [at,new Date(at.getTime()+86400000),new Date(at.getTime()+7*86400000)]) {
    assert.deepEqual(store.enqueueDueNotifications(time),[]);
    await notifications.runNotificationCycle(adapters,time);
    notifications.startNotificationScheduler(adapters);
    notifications.stopNotificationScheduler();
    assert.equal(digest.initializeTrialDigest(time),null);
    assert.equal(digest.enrollTrialDigest(user.id,'UTC',time),false);
    recoverDigestWelcomes(time);
  }
  const schedule=store.getNotificationSchedule(user.id);
  assert.equal(schedule.available,false);assert.equal(schedule.enabled,false);assert.equal(schedule.nextDueAt,null);
  assert.throws(()=>store.saveNotificationSchedule(user.id,{enabled:true}),e=>e.status===410);
  await assert.rejects(sendNotificationReminder({userId:user.id}),e=>e.status===410);
  await assert.rejects(sendDigestBatch({userId:user.id},adapters),e=>e.code==='scenario_retired');
  await assert.rejects(digest.sendDigestPart({userId:user.id,key:'pending-part',kind:'recipe'},assert.fail),e=>e.code==='scenario_retired');
  assert.equal(await sendDigestWelcome(user.id,raw.id,{active:true},adapters),false);
  assert.equal(snapshot(),before,'History, saved preferences, queues and recipe sessions remain unchanged');
  assert.deepEqual(digest.trialDigestReport([{id:user.id}],false),reportBefore);
  const fresh=upsertTelegramUser({id:71999102,first_name:'New fixture'});allowUser(fresh.id);startTrial(fresh.id);
  assert.equal(digest.enrollTrialDigest(fresh.id,'Europe/Moscow'),false);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM notification_schedules WHERE user_id=?').get(fresh.id).n,0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM trial_digest_members WHERE user_id=?').get(fresh.id).n,0);
  if(config.botPlatform==='telegram') {
    const {createServer}=await import('./src/server.js');
    const {makeTelegramInitData}=await import('./src/security.js');
    const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
    // Only the isolated local HTTP server may be reached in this part of the probe.
    const fetch=originalFetch;
    const base='http://127.0.0.1:'+server.address().port;
    const headers={authorization:'tma '+makeTelegramInitData(raw,config.telegramToken),'content-type':'application/json'};
    try {
      const current=await (await fetch(base+'/api/notifications/schedule',{headers})).json();
      assert.equal(current.available,false);assert.equal(current.enabled,false);assert.equal(current.dailyDigest,false);
      for(let i=0;i<2;i++) assert.equal((await fetch(base+'/api/notifications/schedule',{method:'PUT',headers,body:JSON.stringify({enabled:true})})).status,410);
      assert.equal(snapshot(),before);
      const denials=db.prepare("SELECT duration_ms FROM product_events WHERE user_id=? AND event='operation_finished' AND step='notifications' AND json_extract(detail_json,'$.status')=410").all(user.id);
      assert.ok(denials.length>=2);assert.ok(denials.every(row=>row.duration_ms>=0));
    } finally {await new Promise(r=>server.close(r));}
  }
  db.close();console.log('retirement verified');
`;

for (const platform of ['telegram', 'max']) test(`${platform}: old schedules, retries and trial enrollment stay inactive across restart`, () => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'retired-notifications-'));
  try {
    for(let restart=0;restart<2;restart++) {
      const result=spawnSync(process.execPath,['--input-type=module','-e','const originalFetch=globalThis.fetch;\n'+probe],{
        encoding:'utf8',timeout:30000,
        env:{...process.env,DATABASE_PATH:path.join(directory,'test.sqlite'),BOT_PLATFORM:platform,TELEGRAM_BOT_TOKEN:'123456:retirement-test',TELEGRAM_POLLING:'false',TEST_CONTOUR:'false',LEGACY_DINNER_NOTIFICATIONS_ENABLED:restart?'false':'',DINNER_LLM_ENABLED:'false',DINNER_IMAGES_ENABLED:'false',OPENAI_API_KEY:'unused-test-key',APP_URL:'https://recipes.example.test',MAX_BOT_TOKEN:'test-max-token'}
      });
      assert.equal(result.status,0,result.stdout+'\n'+result.stderr);
      assert.match(result.stdout,/retirement verified/);
    }
  } finally {fs.rmSync(directory,{recursive:true,force:true});}
});
