import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'recipe-digest-'));
Object.assign(process.env,{DATABASE_PATH:path.join(directory,'recipes.sqlite'),BOT_PLATFORM:'telegram',TELEGRAM_BOT_TOKEN:'123456:digest-test',TELEGRAM_POLLING:'false',TEST_CONTOUR:'false',BILLING_REQUIRED:'false',APP_URL:'https://recipes.example.test',DINNER_LLM_ENABLED:'false',DINNER_IMAGES_ENABLED:'false',OPENAI_API_KEY:'unused-test-key'});
const {db,upsertTelegramUser,allowUser}=await import('../src/db.js');
const {startTrial,getTrialStatus,grantSubscription}=await import('../src/subscriptions.js');
const {initializeTrialDigest,digestStartedAt,digestMember,enrollTrialDigest,stopTrialDigest,sendDigestPart,trialDigestReport}=await import('../src/trial-digest-store.js');
const {sendDigestWelcome,sendDigestBatch,digestRecipes}=await import('../src/trial-digest.js');
const {getNotificationSchedule,saveNotificationSchedule,enqueueDueNotifications,getNotificationDeliveryForDispatch}=await import('../src/notification-store.js');
const {queueTrialWelcome,deliverTrialWelcome,recoverDigestWelcomes}=await import('../src/trial-welcome.js');
const {runNotificationCycle}=await import('../src/notifications.js');
const {runTrialReminderCycle}=await import('../src/trial-reminders.js');
const {saveFoodProfile,getFoodProfile}=await import('../src/dinner-store.js');
const {rankCandidates,SEED_RECIPES}=await import('../src/dinner.js');
const {sendTrialWelcomeMessage,sendNotificationReminder,handleTrialReminderCallback,handleTrialCallback}=await import('../src/telegram.js');
const {productReport,validProductReport}=await import('../src/product-analytics.js');
const {createServer}=await import('../src/server.js');
const {makeTelegramInitData}=await import('../src/security.js');
const cutoff=new Date(Date.now()-86400000),start=new Date(Math.ceil(Date.now()/86400000)*86400000+16*3600000);
let serial=799100000;
const url=params=>{const u=new URL('https://recipes.example.test/');for(const [k,v] of Object.entries(params))u.searchParams.set(k,v);return u.toString();};
const adapter=messages=>({url,send:async(method,body)=>{messages.push({method,...body});return {message_id:messages.length};}});
function user({old=false,at=start,trial=true}={}) {
 const raw={id:++serial,first_name:'Fixture'},u=upsertTelegramUser(raw);allowUser(u.id);
 db.prepare('UPDATE users SET created_at=? WHERE id=?').run(new Date(cutoff.getTime()+(old?-60000:60000)).toISOString(),u.id);
 if(trial)startTrial(u.id,at);return {...u,raw};
}
function member(options={}) {const u=user(options);assert.equal(enrollTrialDigest(u.id,options.zone||'Europe/Moscow',options.at||start),true);return u;}
function due(u,at) {const ids=enqueueDueNotifications(at);const d=ids.map(getNotificationDeliveryForDispatch).find(d=>d.userId===u.id);assert.ok(d);return d;}
test.before(()=>initializeTrialDigest(cutoff));
test.afterEach(()=>db.prepare('UPDATE notification_schedules SET enabled=0').run());
test.after(()=>{db.close();fs.rmSync(directory,{recursive:true,force:true});});

test('rollout cutoff survives restart; old accounts activating later are never enrolled or altered',()=>{
 const u=user({old:true});const before=db.prepare('SELECT * FROM users WHERE id=?').get(u.id);
 assert.equal(enrollTrialDigest(u.id,'UTC',start),false);assert.equal(digestMember(u.id),undefined);
 assert.equal(getNotificationSchedule(u.id,start).enabled,false);assert.equal(initializeTrialDigest(start),cutoff.toISOString());
 const result=spawnSync(process.execPath,['--input-type=module','-e',"const m=await import('./src/trial-digest-store.js'); console.log(m.initializeTrialDigest(new Date('2099-01-01')));"],{encoding:'utf8',env:process.env});
 assert.equal(result.status,0,result.stderr);assert.match(result.stdout,new RegExp(cutoff.toISOString().replaceAll('.','\\.')));
 assert.deepEqual(db.prepare('SELECT * FROM users WHERE id=?').get(u.id),before);
});
test('activation minus 15 minutes, seven weekdays, first delivery approximately 24 hours later, device timezone persisted',()=>{
 for(const [at,zone,time,next] of [
  ['2026-10-26T16:00:00Z','Europe/Moscow','18:45','2026-10-27T15:45:00.000Z'],
  ['2026-10-26T21:05:00Z','Europe/Moscow','23:50','2026-10-27T20:50:00.000Z'],
  ['2026-10-26T16:00:00Z','Asia/Yekaterinburg','20:45','2026-10-27T15:45:00.000Z']]) {
   const u=member({at:new Date(at),zone}),s=getNotificationSchedule(u.id,new Date(at));
   assert.equal(s.time,time);assert.equal(s.timezone,zone);assert.equal(s.nextDueAt,next);assert.deepEqual(s.weekdays,[0,1,2,3,4,5,6]);
 }
});
test('explicit disabled schedule wins; repeated enrollment never re-enables or overwrites changed schedule',()=>{
 const u=user();saveNotificationSchedule(u.id,{enabled:false,weekdays:[1],time:'12:30',timezone:'UTC'},start);
 const before=getNotificationSchedule(u.id,start);assert.equal(enrollTrialDigest(u.id,'Asia/Tokyo',start),true);
 assert.deepEqual(getNotificationSchedule(u.id,start),before);assert.equal(digestMember(u.id).auto_enabled,0);
 assert.equal(enrollTrialDigest(u.id,'UTC',start),true);assert.deepEqual(getNotificationSchedule(u.id,start),before);
});
test('DST clock rollback never schedules the first batch in the repeated activation hour',()=>{
 const at=new Date('2026-10-25T00:05:00Z'),u=member({at,zone:'Europe/Berlin'}),s=getNotificationSchedule(u.id,at);
 assert.equal(s.time,'01:50');assert.ok(Date.parse(s.nextDueAt)-at.getTime()>20*3600000);
});
test('failed follow-up resumes without repeating the confirmed welcome, parallel calls do not claim twice',async()=>{
 const u=member(),messages=[],trial=getTrialStatus(u.id,start),a=adapter(messages),send=a.send;
 let calls=0;a.send=async(method,body)=>{if(++calls===2)throw {telegramStatus:429,retryAfter:60};return send(method,body);};
 await assert.rejects(sendDigestWelcome(u.id,u.telegram_id,trial,a,start),/rate_limit/);assert.equal(messages.length,1);
 await sendDigestWelcome(u.id,u.telegram_id,trial,a,new Date(start.getTime()+60000));assert.equal(messages.length,2);
 const v=member(),parallel=[];await Promise.allSettled([sendDigestWelcome(v.id,v.telegram_id,getTrialStatus(v.id,start),adapter(parallel),start),sendDigestWelcome(v.id,v.telegram_id,getTrialStatus(v.id,start),adapter(parallel),start)]);
 assert.equal(parallel.length,2);
});
test('two immediate messages replace old guide and go directly to taste editor, repeated calls do not repeat parts',async()=>{
 const u=member(),messages=[];const a=adapter(messages),trial=getTrialStatus(u.id,start);
 await sendDigestWelcome(u.id,u.telegram_id,trial,a,start);await sendDigestWelcome(u.id,u.telegram_id,trial,a,start);
 assert.equal(messages.length,2);assert.match(messages[0].text,/18:45/);assert.equal(messages[1].disable_notification,true);
 assert.equal(new URL(messages[1].reply_markup.inline_keyboard[0][0].web_app.url).searchParams.get('view'),'tastes');
 assert.equal(messages[0].reply_markup.inline_keyboard[0][1].callback_data,'digest:stop');
});
test('daily cycle sends 3 real photo recipes; personalization once, expiry in last two batches, no AI sessions or expired sends',async()=>{
 const u=member(),messages=[],allIds=[],sessions=db.prepare('SELECT COUNT(*) n FROM dinner_sessions').get().n;
 const first=new Date(getNotificationSchedule(u.id,start).nextDueAt);
 for(let day=0;day<8;day++) {
  const at=new Date(first.getTime()+day*86400000),batch=[];
  await runNotificationCycle({sendReminder:d=>sendDigestBatch(d,adapter(batch),at),sendChoice:assert.fail},at);
  await runNotificationCycle({sendReminder:assert.fail,sendChoice:assert.fail},at);
  if(day===7) {assert.equal(batch.length,0);continue;}
  assert.equal(batch.length,3);assert.equal(batch.filter(m=>!m.disable_notification).length,1);
  assert.ok(batch.every(m=>m.method==='sendPhoto'&&m.photo.startsWith('https://recipes.example.test/assets/')));
  assert.equal(batch.filter(m=>/Пробный период заканчивается/.test(m.caption)).length,day>=5?1:0);
  assert.equal(batch.filter(m=>/Отметь хотя бы три/.test(m.caption)).length,day===0?1:0);
  const ids=batch.map(m=>new URL(m.reply_markup.inline_keyboard[0][0].web_app.url).searchParams.get('recipe'));
  assert.ok(ids.every(id=>SEED_RECIPES.some(r=>r.id===id)));allIds.push(...ids);messages.push(...batch);
 }
 assert.equal(new Set(allIds).size,21);assert.equal(db.prepare('SELECT COUNT(*) n FROM dinner_sessions').get().n,sessions);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM notification_deliveries WHERE user_id=? AND status='sent'").get(u.id).n,7);
});
test('paid subscriber continues after trial and never receives expiry CTA',async()=>{
 const u=member();grantSubscription(u.id,'subscription',new Date(start.getTime()+40*86400000),start);
 const at=new Date(start.getTime()+8*86400000-15*60000);
 db.prepare('UPDATE notification_schedules SET next_due_at=? WHERE user_id=?').run(at.toISOString(),u.id);
 const messages=[];await runNotificationCycle({sendReminder:d=>sendDigestBatch(d,adapter(messages),at),sendChoice:assert.fail},at);
 assert.equal(messages.length,3);assert.ok(messages.every(m=>!/Пробный период заканчивается/.test(m.caption)));
});
test('composition and method ratings use common ranker; exclusions and changed dislikes are never relaxed',()=>{
 const u=member();const chosen=SEED_RECIPES.find(r=>/Рубленые куриные котлеты/i.test(r.title));assert.ok(chosen);
 const other=SEED_RECIPES.find(r=>/Борщ с говядиной/i.test(r.title));assert.ok(other);
 saveFoodProfile(u.id,{...getFoodProfile(u.id),dishRatings:{[chosen.id]:1,[other.id]:-1},excludedIngredients:['картофель']});
 const result=digestRecipes(u.id,start),ranked=rankCandidates(SEED_RECIPES.filter(r=>r.thumbnailUrl),{profile:getFoodProfile(u.id),now:start.getTime()});
 assert.ok(result.length);assert.ok(result.every(r=>ranked.some(c=>c.recipe.id===r.id)&&r.id!==other.id));
 assert.ok(result.some(r=>r.id===chosen.id));
});
test('disable in chat is owned and persisted; API schedule disable records opt-out; no further cards',async()=>{
 const u=member(),messages=[],at=new Date(getNotificationSchedule(u.id,start).nextDueAt),delivery=due(u,at);
 const a=adapter(messages),send=a.send;
 a.send=async(method,body)=>{const r=await send(method,body);stopTrialDigest(u.id,at);return r;};
 await assert.rejects(sendDigestBatch(delivery,a,at),e=>e.digestTerminal);
 assert.equal(messages.length,1);assert.ok(digestMember(u.id).opted_out_at);
 assert.equal(await handleTrialReminderCallback({data:'digest:stop',from:{id:serial},message:{chat:{id:serial+1,type:'private'}}}),false);
 const v=member();saveNotificationSchedule(v.id,{...getNotificationSchedule(v.id,start),enabled:false},start);
 assert.ok(digestMember(v.id).opted_out_at);
});
test('rate limit resumes after confirmed part without duplicate; ambiguous delivery is terminal, even after restart',async()=>{
 const u=member(),messages=[],at=new Date(getNotificationSchedule(u.id,start).nextDueAt),delivery=due(u,at);
 let count=0;const a=adapter(messages),send=a.send;
 a.send=async(method,body)=>{if(++count===2)throw {telegramStatus:429,retryAfter:60};return send(method,body);};
 await assert.rejects(sendDigestBatch(delivery,a,at),/rate_limit/);assert.equal(messages.length,1);
 await sendDigestBatch(delivery,a,new Date(at.getTime()+60000));assert.equal(messages.length,3);
 assert.equal(new Set(messages.map(m=>m.photo)).size,3);
 await assert.rejects(sendDigestPart({userId:u.id,key:'ambiguous',kind:'welcome'},async()=>{throw new Error('socket timeout');},at),e=>e.digestTerminal);
 await assert.rejects(sendDigestPart({userId:u.id,key:'ambiguous',kind:'welcome'},assert.fail,new Date(at.getTime()+180000)),e=>e.digestTerminal);
 db.prepare("INSERT INTO trial_digest_parts(user_id,part_key,kind,created_at,due_at,claimed_at,status) VALUES(?,'crash','welcome',?,?,?,'sending')").run(u.id,at.toISOString(),at.toISOString(),at.toISOString());
 await assert.rejects(sendDigestPart({userId:u.id,key:'crash',kind:'welcome'},assert.fail,new Date(at.getTime()+180000)),e=>e.digestTerminal);
 assert.equal(db.prepare("SELECT status FROM trial_digest_parts WHERE user_id=? AND part_key='crash'").get(u.id).status,'unknown');
});
test('late queued delivery is discarded and same local date cannot be resent after schedule change',async()=>{
 const u=member(),at=new Date(getNotificationSchedule(u.id,start).nextDueAt);due(u,at);
 await runNotificationCycle({sendReminder:assert.fail,sendChoice:assert.fail},new Date(at.getTime()+16*60000));
 const v=member(),d=due(v,at);await sendDigestBatch(d,adapter([]),at);
 saveNotificationSchedule(v.id,{enabled:true,weekdays:[0,1,2,3,4,5,6],time:'19:30',timezone:'Europe/Moscow'},at);
 const later=new Date(at.getTime()+45*60000),second=due(v,later);
 await assert.rejects(sendDigestBatch(second,{url,send:assert.fail},later),e=>e.code==='already_sent_today');
});
test('empty safe catalog does not invent recipes or override constraints',async()=>{
 const u=member();saveFoodProfile(u.id,{...getFoodProfile(u.id),householdSize:10,preferredMaxCookingTime:10});
 const messages=[],at=new Date(getNotificationSchedule(u.id,start).nextDueAt);
 await sendDigestBatch(due(u,at),adapter(messages),at);
 assert.equal(messages.length,1);assert.equal(messages[0].method,'sendMessage');assert.match(messages[0].text,/не нашлось/);
});
test('old reminder chain excludes new cohort and welcome recovery repairs crash between trial activation and queue',async()=>{
 const now=new Date(),u=user({at:now});recoverDigestWelcomes(now);assert.ok(digestMember(u.id));
 assert.equal(db.prepare('SELECT ready FROM trial_welcome_messages WHERE user_id=?').get(u.id).ready,1);
 await runTrialReminderCycle(async d=>assert.notEqual(d.userId,u.id),new Date(now.getTime()+2*86400000));
 assert.equal(db.prepare('SELECT * FROM trial_reminder_members WHERE user_id=?').get(u.id),undefined);
});
test('actual trial API and Telegram transport send immediate pair, persist timezone, and preserve old account behavior',async()=>{
 const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 const original=globalThis.fetch,messages=[];
 globalThis.fetch=async(u,o)=>String(u).startsWith(base)?original(u,o):(messages.push({method:String(u).split('/').at(-1),...JSON.parse(o.body)}),Response.json({ok:true,result:{message_id:messages.length}}));
 try {
  const u=user({trial:false});const response=await fetch(base+'/api/billing/trial',{method:'POST',headers:{authorization:'tma '+makeTelegramInitData(u.raw,process.env.TELEGRAM_BOT_TOKEN),'content-type':'application/json'},body:JSON.stringify({timezone:'Asia/Tokyo'})});
  assert.equal(response.status,200);assert.ok(digestMember(u.id));assert.equal(getNotificationSchedule(u.id).timezone,'Asia/Tokyo');
  await deliverTrialWelcome(u.id,sendTrialWelcomeMessage);assert.equal(messages.length,2);
  assert.ok(messages[1].reply_markup.inline_keyboard[0][0].web_app.url.endsWith('view=tastes'));
  const settings=await(await fetch(base+'/api/notifications/schedule',{headers:{authorization:'tma '+makeTelegramInitData(u.raw,process.env.TELEGRAM_BOT_TOKEN)}})).json();assert.equal(settings.dailyDigest,true);
  const old=user({old:true,at:new Date()});queueTrialWelcome(old.id,old.telegram_id,{ready:true});await deliverTrialWelcome(old.id,sendTrialWelcomeMessage);
  assert.equal(messages.length,3);assert.match(messages[2].text,/Познакомься с возможностями/);
  const chatUser=user({trial:false});await handleTrialCallback({data:'trial:start',id:'digest-fixture-start',from:chatUser.raw,message:{message_id:21,chat:{id:chatUser.raw.id,type:'private'}}});
  assert.ok(digestMember(chatUser.id));assert.equal(db.prepare("SELECT COUNT(*) n FROM trial_digest_parts WHERE user_id=? AND status='sent'").get(chatUser.id).n,2);
  await handleTrialReminderCallback({data:'digest:stop',id:'digest-fixture-stop',from:chatUser.raw,message:{chat:{id:chatUser.raw.id,type:'private'}}});assert.equal(getNotificationSchedule(chatUser.id).enabled,false);
 } finally {globalThis.fetch=original;await new Promise(r=>server.close(r));}
});
test('analytics filters sources, contains no food payload, keeps unavailable MAX data null and validates optional aggregate',()=>{
 const all=db.prepare('SELECT * FROM users').all(),report=trialDigestReport(all);
 assert.ok(report.enrolled>0);assert.ok(report.cardsSent>=21);assert.equal(trialDigestReport([]).enrolled,0);
 assert.equal(trialDigestReport(all.map(u=>({...u,started_at:'2099-01-01'})),true).enrolled,0);
 assert.doesNotMatch(JSON.stringify(report),/recipe_ids|user_id|telegram_id|котлет|http/);
 const base=productReport(all);base.platform='max';assert.equal(validProductReport(base),true);
 const old={...base};delete old.trialDigest;assert.equal(validProductReport(old),true);
 assert.equal(validProductReport({...base,trialDigest:{...report,cardsSent:-1}}),false);
 const result=spawnSync(process.execPath,['--input-type=module','-e',"const m=await import('./src/trial-digest-store.js'); console.log(JSON.stringify([m.initializeTrialDigest(),m.trialDigestReport([]),m.digestMember('x')]));"],{encoding:'utf8',env:{...process.env,BOT_PLATFORM:'max',MAX_BOT_TOKEN:'preview-only'}});
 assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/\[null,null,null\]/);
});
