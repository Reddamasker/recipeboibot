import { db } from './db.js';
import { config } from './config.js';
import { getTrialStatus, getSubscriptionAccess } from './subscriptions.js';
import { getNotificationSchedule, saveNotificationSchedule, nextNotificationAt } from './notification-store.js';

// Operational state, also the delivery analytics source. Never infer a read from a send.
db.exec(`CREATE TABLE IF NOT EXISTS trial_digest_rollout (
 id INTEGER PRIMARY KEY CHECK(id=1), started_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS trial_digest_members (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 created_at TEXT NOT NULL, trial_started_at TEXT NOT NULL,
 auto_enabled INTEGER NOT NULL, opted_out_at TEXT);
 CREATE TABLE IF NOT EXISTS trial_digest_batches (
 delivery_id TEXT PRIMARY KEY REFERENCES notification_deliveries(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 created_at TEXT NOT NULL, recipe_ids_json TEXT NOT NULL, day_key TEXT NOT NULL,
 UNIQUE(user_id,day_key));
 CREATE TABLE IF NOT EXISTS trial_digest_parts (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 part_key TEXT NOT NULL, kind TEXT NOT NULL,
 delivery_id TEXT REFERENCES notification_deliveries(id) ON DELETE CASCADE,
 created_at TEXT NOT NULL, due_at TEXT NOT NULL, claimed_at TEXT, sent_at TEXT,
 status TEXT NOT NULL CHECK(status IN ('pending','sending','sent','failed','unknown','cancelled')),
 attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT, error_code TEXT,
 PRIMARY KEY(user_id,part_key));`);

export function initializeTrialDigest(at = new Date()) {
  if (config.botPlatform !== 'telegram') return null;
  db.prepare('INSERT OR IGNORE INTO trial_digest_rollout VALUES(1,?)').run(at.toISOString());
  return digestStartedAt();
}
export const digestStartedAt = () => db.prepare('SELECT started_at FROM trial_digest_rollout WHERE id=1').get()?.started_at || null;
export const digestMember = userId => config.botPlatform === 'telegram' && typeof userId==='string' ? db.prepare('SELECT * FROM trial_digest_members WHERE user_id=?').get(userId) : null;
export function eligibleDigestUser(userId, at = new Date()) {
  const since = digestStartedAt();
  if (config.botPlatform !== 'telegram' || !since) return false;
  return Boolean(db.prepare(`SELECT 1 FROM users u JOIN user_trials t ON t.user_id=u.id
    WHERE u.id=? AND u.created_at>? AND t.starts_at>=? AND t.expires_at>? AND u.is_allowed=1
    AND u.telegram_id NOT LIKE 'max:%'
    AND NOT EXISTS(SELECT 1 FROM private_test_profiles p WHERE p.test_user_id=u.id OR p.owner_user_id=u.id)`)
    .get(userId,since,since,at.toISOString()));
}
export function enrollTrialDigest(userId, timezone, at = new Date()) {
  if (digestMember(userId)) return true;
  if (!eligibleDigestUser(userId,at) || !getSubscriptionAccess(userId,at).active) return false;
  const trial = getTrialStatus(userId,at);
  let zone = typeof timezone === 'string' && timezone.length < 80 ? timezone : 'Europe/Moscow';
  try { new Intl.DateTimeFormat('en-GB',{timeZone:zone}).format(at); } catch { zone='Europe/Moscow'; }
  const local = new Intl.DateTimeFormat('en-GB',{timeZone:zone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'})
    .format(new Date(trial.startsAt)).split(':').map(Number);
  const minute=(local[0]*60+local[1]-15+1440)%1440;
  const time=`${String(Math.floor(minute/60)).padStart(2,'0')}:${String(minute%60).padStart(2,'0')}`;
  db.exec('BEGIN IMMEDIATE');
  try {
    const existing = db.prepare('SELECT 1 FROM notification_schedules WHERE user_id=?').get(userId);
    // A user's explicit setting (including disabled) always wins over automatic enrollment.
    if (!existing) {
      const schedule={enabled:true,weekdays:[0,1,2,3,4,5,6],time,timezone:zone};
      saveNotificationSchedule(userId,schedule,new Date(trial.startsAt));
      // A repeated DST hour must not trigger a second welcome-time notification.
      const next=nextNotificationAt(schedule,new Date(Math.max(Date.parse(trial.startsAt)+20*3600000,at.getTime())));
      db.prepare('UPDATE notification_schedules SET next_due_at=? WHERE user_id=?').run(next.toISOString(),userId);
    }
    db.prepare('INSERT OR IGNORE INTO trial_digest_members VALUES(?,?,?,?,NULL)').run(userId,at.toISOString(),trial.startsAt,existing?0:1);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return true;
}
export function stopTrialDigest(userId, at = new Date()) {
  if (!digestMember(userId)) return false;
  const schedule = getNotificationSchedule(userId,at);
  saveNotificationSchedule(userId,{...schedule,enabled:false},at);
  db.prepare('UPDATE trial_digest_members SET opted_out_at=COALESCE(opted_out_at,?) WHERE user_id=?').run(at.toISOString(),userId);
  return true;
}
export const digestTerminal = code => Object.assign(new Error(code),{digestTerminal:true,code});
export function cancelDigestParts(deliveryId) {
  db.prepare(`UPDATE trial_digest_parts SET status=CASE WHEN status='sending' THEN 'unknown' ELSE 'cancelled' END,
    error_code=CASE WHEN status='sending' THEN 'interrupted' ELSE 'stopped' END
    WHERE delivery_id=? AND status IN ('sending','pending')`).run(deliveryId);
}

// Checkpoint each confirmed message. An ambiguous network result is never replayed.
export async function sendDigestPart({userId,key,kind,deliveryId=null,dueAt}, send, at = new Date()) {
  const timestamp = at.toISOString();
  db.prepare(`INSERT OR IGNORE INTO trial_digest_parts(user_id,part_key,kind,delivery_id,created_at,due_at,status)
    VALUES(?,?,?,?,?,?,'pending')`).run(userId,key,kind,deliveryId,timestamp,dueAt||timestamp);
  let row = db.prepare('SELECT * FROM trial_digest_parts WHERE user_id=? AND part_key=?').get(userId,key);
  if (row.status==='sent') return;
  if (row.status==='sending' && Date.parse(row.claimed_at)<=at.getTime()-120000) {
    db.prepare("UPDATE trial_digest_parts SET status='unknown',error_code='interrupted' WHERE user_id=? AND part_key=? AND status='sending'").run(userId,key);
    throw digestTerminal('delivery_uncertain');
  }
  if (['failed','unknown','cancelled'].includes(row.status)) throw digestTerminal(row.error_code||row.status);
  if (!db.prepare(`UPDATE trial_digest_parts SET status='sending',claimed_at=?,attempts=attempts+1
    WHERE user_id=? AND part_key=? AND status='pending' AND (next_attempt_at IS NULL OR next_attempt_at<=?)`)
    .run(timestamp,userId,key,timestamp).changes) throw new Error('digest_part_waiting');
  try {
    await send();
    db.prepare("UPDATE trial_digest_parts SET status='sent',sent_at=?,error_code=NULL WHERE user_id=? AND part_key=? AND status='sending'")
      .run(new Date().toISOString(),userId,key);
  } catch (error) {
    const retry = error?.telegramStatus===429 && row.attempts<4;
    const status = retry ? 'pending' : error?.telegramStatus>=400 && error.telegramStatus<500 ? 'failed' : 'unknown';
    const code = retry ? 'rate_limit' : status==='failed' ? 'rejected' : 'delivery_uncertain';
    const delay = Math.max(60000,Math.min(3600000,(Number(error?.retryAfter)||60)*1000));
    db.prepare('UPDATE trial_digest_parts SET status=?,error_code=?,next_attempt_at=? WHERE user_id=? AND part_key=?')
      .run(status,code,retry?new Date(at.getTime()+delay).toISOString():null,userId,key);
    if (!retry) throw digestTerminal(code);
    throw Object.assign(new Error(code),{retryAfter:delay/1000});
  }
}

export function trialDigestReport(cohort, campaign=false) {
  const trackingSince = digestStartedAt();
  if (!trackingSince || config.botPlatform!=='telegram') return null;
  const users = new Map(cohort.map(u=>[u.id,u]));
  const eligible = r => users.has(r.user_id) && (!campaign || r.created_at>=users.get(r.user_id).started_at);
  const members=db.prepare('SELECT * FROM trial_digest_members').all().filter(eligible);
  const parts=db.prepare('SELECT * FROM trial_digest_parts').all().filter(eligible);
  const sent=parts.filter(p=>p.status==='sent');
  const batches=db.prepare(`SELECT b.*,d.status FROM trial_digest_batches b JOIN notification_deliveries d ON d.id=b.delivery_id`).all().filter(eligible);
  const delays=sent.map(p=>Math.max(0,Date.parse(p.sent_at)-Date.parse(p.due_at))).sort((a,b)=>a-b);
  return {trackingSince,enrolled:members.length,autoEnabled:members.filter(m=>m.auto_enabled).length,
    optedOut:members.filter(m=>m.opted_out_at).length,welcomeSent:sent.filter(p=>p.kind==='welcome').length,
    personalizationSent:sent.filter(p=>p.kind==='personalization').length,
    batches:batches.length,batchesSent:batches.filter(b=>b.status==='sent'||b.status==='chosen').length,
    batchesFailed:batches.filter(b=>b.status==='failed').length,cancelled:parts.filter(p=>p.status==='cancelled').length,
    cardsSent:sent.filter(p=>p.kind==='recipe').length,failed:parts.filter(p=>p.status==='failed').length,
    unknown:parts.filter(p=>p.status==='unknown').length,waiting:parts.filter(p=>['pending','sending'].includes(p.status)).length,
    deliveryTiming:{samples:delays.length,p50:delays.length?delays[Math.ceil(delays.length*.5)-1]:null,p95:delays.length?delays[Math.ceil(delays.length*.95)-1]:null}};
}
