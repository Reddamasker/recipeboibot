import { randomUUID } from 'node:crypto';
import { db } from './db.js';
import { config } from './config.js';
import { getSubscriptionAccess } from './subscriptions.js';
import { log } from './log.js';
import { eligibleDigestUser, digestMember } from './trial-digest-store.js';

// Delivery state is also the analytics source. No message contents are stored.
db.exec(`CREATE TABLE IF NOT EXISTS trial_reminder_settings (
 id INTEGER PRIMARY KEY CHECK(id=1), started_at TEXT NOT NULL,
 delay_hours INTEGER NOT NULL DEFAULT 24, interval_hours INTEGER NOT NULL DEFAULT 48,
 max_messages INTEGER NOT NULL DEFAULT 3, enabled INTEGER NOT NULL DEFAULT 1);
 CREATE TABLE IF NOT EXISTS trial_reminder_members (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 created_at TEXT NOT NULL, trial_started_at TEXT NOT NULL, next_due_at TEXT NOT NULL,
 stopped_at TEXT, stop_reason TEXT, added_at TEXT);
 CREATE TABLE IF NOT EXISTS trial_reminder_deliveries (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 sequence INTEGER NOT NULL, created_at TEXT NOT NULL, due_at TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('sending','sent','failed','unknown')),
 sent_at TEXT, clicked_at TEXT, opted_out_at TEXT, error_code TEXT,
 UNIQUE(user_id,sequence));`);
db.prepare('INSERT OR IGNORE INTO trial_reminder_settings(id,started_at) VALUES(1,?)').run(new Date().toISOString());
export const trialReminderSettings = () => db.prepare('SELECT * FROM trial_reminder_settings WHERE id=1').get();
export function configureTrialReminders({ delayHours, intervalHours, maxMessages, enabled }) {
  if (!Number.isInteger(delayHours) || delayHours < 1 || delayHours > 144
    || !Number.isInteger(intervalHours) || intervalHours < 24 || intervalHours > 168
    || !Number.isInteger(maxMessages) || maxMessages < 1 || maxMessages > 7 || typeof enabled !== 'boolean') {
    throw new Error('Задержка: 1–144 ч; интервал: 24–168 ч; сообщений: 1–7; enabled: true/false');
  }
  db.prepare('UPDATE trial_reminder_settings SET delay_hours=?,interval_hours=?,max_messages=?,enabled=? WHERE id=1')
    .run(delayHours, intervalHours, maxMessages, Number(enabled));
  return trialReminderSettings();
}
const ownRecipe = userId => db.prepare(`SELECT created_at FROM recipes WHERE user_id=?
 AND source_type IN ('text','url','image','audio','manual') ORDER BY created_at LIMIT 1`).get(userId);
const stop = (userId, reason, at) => db.prepare('UPDATE trial_reminder_members SET stopped_at=?,stop_reason=? WHERE user_id=? AND stopped_at IS NULL').run(at,reason,userId);
function recipient(userId) {
  const user = db.prepare('SELECT telegram_id,is_allowed FROM users WHERE id=?').get(userId);
  return user?.is_allowed && (config.botPlatform === 'max' ? /^max:[1-9][0-9]*$/ : /^[1-9][0-9]*$/).test(user.telegram_id) ? user.telegram_id : null;
}
export function trialReminderAction(userId, id, action, at = new Date()) {
  if (!['add','stop'].includes(action)) return false;
  const row = db.prepare("SELECT * FROM trial_reminder_deliveries WHERE id=? AND user_id=? AND status IN ('sent','unknown','sending')").get(id,userId);
  if (!row) return false;
  const timestamp = at.toISOString();
  if (action === 'stop') {
    db.prepare('UPDATE trial_reminder_deliveries SET opted_out_at=COALESCE(opted_out_at,?) WHERE id=?').run(timestamp,id);
    stop(userId,'opt_out',timestamp);
  } else {
    // This timestamp is analytics only: failure must not block the /save flow.
    try { db.prepare('UPDATE trial_reminder_deliveries SET clicked_at=COALESCE(clicked_at,?) WHERE id=?').run(timestamp,id); }
    catch { log('warn','trial_reminder_click_tracking_failed',{}); }
  }
  return true;
}
let running = false, timer;
export async function runTrialReminderCycle(send, at = new Date()) {
  if (running) return;
  running = true;
  try {
    const settings = trialReminderSettings(), timestamp = at.toISOString();
    if (!settings.enabled) return;
    // A crash/network ambiguity must never cause a replay of the same message.
    db.prepare("UPDATE trial_reminder_deliveries SET status='unknown',error_code='interrupted' WHERE status='sending' AND created_at<?")
      .run(new Date(at.getTime()-120000).toISOString());
    db.prepare(`INSERT OR IGNORE INTO trial_reminder_members(user_id,created_at,trial_started_at,next_due_at)
      SELECT t.user_id,?,t.starts_at,strftime('%Y-%m-%dT%H:%M:%fZ',t.starts_at,'+' || ? || ' hours')
      FROM user_trials t JOIN users u ON u.id=t.user_id
      WHERE t.starts_at>=? AND t.starts_at<=? AND t.expires_at>? AND u.is_allowed=1
      AND NOT EXISTS(SELECT 1 FROM trial_digest_rollout r WHERE u.created_at>r.started_at AND t.starts_at>=r.started_at)
      AND NOT EXISTS(SELECT 1 FROM private_test_profiles p WHERE p.test_user_id=t.user_id OR p.owner_user_id=t.user_id)`)
      .run(timestamp,settings.delay_hours,settings.started_at,timestamp,timestamp);
    const members = db.prepare('SELECT * FROM trial_reminder_members WHERE stopped_at IS NULL ORDER BY next_due_at LIMIT 500').all();
    let dispatched = 0;
    for (const member of members) {
      if (digestMember(member.user_id) || eligibleDigestUser(member.user_id,at)) { stop(member.user_id,'daily_digest',timestamp); continue; }
      const added = ownRecipe(member.user_id);
      if (added) {
        db.prepare('UPDATE trial_reminder_members SET added_at=? WHERE user_id=?').run(added.created_at,member.user_id);
        stop(member.user_id,'recipe_added',timestamp); continue;
      }
      const access = getSubscriptionAccess(member.user_id,at);
      if (!access.active || access.source !== 'trial') { stop(member.user_id,'access_changed',timestamp); continue; }
      const chatId = recipient(member.user_id);
      if (!chatId) { stop(member.user_id,'recipient_unavailable',timestamp); continue; }
      const count = db.prepare('SELECT COUNT(*) n FROM trial_reminder_deliveries WHERE user_id=?').get(member.user_id).n;
      if (count >= settings.max_messages) { stop(member.user_id,'limit',timestamp); continue; }
      if (member.next_due_at > timestamp || dispatched >= 20) continue;
      // Use the user's chosen timezone when available, otherwise Moscow. Only 10:00–20:00.
      const hasSchedule = db.prepare("SELECT 1 FROM sqlite_master WHERE name='notification_schedules' AND type='table'").get();
      const timezone = hasSchedule && db.prepare('SELECT timezone FROM notification_schedules WHERE user_id=?').get(member.user_id)?.timezone || 'Europe/Moscow';
      let hour;
      try { hour = Number(new Intl.DateTimeFormat('en-GB',{ timeZone:timezone,hour:'2-digit',hourCycle:'h23' }).format(at)); }
      catch { hour = (at.getUTCHours()+3)%24; }
      if (hour < 10 || hour >= 20) continue;
      const id = randomUUID();
      db.exec('BEGIN IMMEDIATE');
      let claimed;
      try {
        claimed = db.prepare(`INSERT OR IGNORE INTO trial_reminder_deliveries(id,user_id,sequence,created_at,due_at,status)
          SELECT ?,user_id,?,?,next_due_at,'sending' FROM trial_reminder_members
          WHERE user_id=? AND stopped_at IS NULL AND next_due_at<=?`)
          .run(id,count+1,timestamp,member.user_id,timestamp).changes;
        if (claimed) db.prepare('UPDATE trial_reminder_members SET next_due_at=? WHERE user_id=?')
          .run(new Date(at.getTime()+settings.interval_hours*3600000).toISOString(),member.user_id);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      if (!claimed) continue;
      dispatched++;
      try {
        await send({ id,userId:member.user_id,chatId,sequence:count+1 });
        db.prepare("UPDATE trial_reminder_deliveries SET status='sent',sent_at=? WHERE id=?").run(timestamp,id);
      } catch (error) {
        const blocked = /blocked|forbidden|deactivated|chat not found/i.test(String(error?.message));
        db.prepare("UPDATE trial_reminder_deliveries SET status=?,error_code=? WHERE id=?")
          .run(blocked?'failed':'unknown',blocked?'recipient_unavailable':'delivery_uncertain',id);
        stop(member.user_id,blocked?'recipient_unavailable':'delivery_uncertain',timestamp);
        log('warn','trial_reminder_delivery_failed',{ code:blocked?'recipient_unavailable':'delivery_uncertain' });
      }
    }
  } finally { running = false; }
}
export function startTrialReminderScheduler(send) {
  stopTrialReminderScheduler();
  const tick = () => runTrialReminderCycle(send).catch(() => log('warn','trial_reminder_cycle_failed',{}));
  timer = setInterval(tick,30000); timer.unref(); void tick();
}
export function stopTrialReminderScheduler() { if (timer) clearInterval(timer); timer = null; }

export function trialReminderReport(cohort, campaign = false, at = new Date().toISOString()) {
  const users = new Map(cohort.map(u => [u.id,u]));
  const eligible = r => users.has(r.user_id) && (!campaign || r.created_at >= users.get(r.user_id).started_at);
  const members = db.prepare('SELECT * FROM trial_reminder_members').all().filter(eligible);
  const deliveries = db.prepare('SELECT * FROM trial_reminder_deliveries').all().filter(eligible);
  const sent = deliveries.filter(d => d.status === 'sent');
  const firstSent = new Map();
  for (const d of sent) if (!firstSent.has(d.user_id) || firstSent.get(d.user_id) > d.sent_at) firstSent.set(d.user_id,d.sent_at);
  const completedWindow = [...firstSent].filter(([,sentAt]) => Date.parse(at)-Date.parse(sentAt)>=86400000);
  const converted = completedWindow.filter(([userId,sentAt]) => db.prepare(`SELECT 1 FROM recipes WHERE user_id=?
    AND source_type IN ('text','url','image','audio','manual') AND created_at>=? AND created_at<=? LIMIT 1`)
    .get(userId,sentAt,new Date(Date.parse(sentAt)+86400000).toISOString())).length;
  const timing = values => {
    values.sort((a,b)=>a-b);
    return { samples:values.length,p50:values.length?values[Math.ceil(values.length*.5)-1]:null,p95:values.length?values[Math.ceil(values.length*.95)-1]:null };
  };
  return { trackingSince:trialReminderSettings().started_at, enrolled:members.length,
    deliveries:deliveries.length, sent:sent.length, sentUsers:firstSent.size,
    clicked:deliveries.filter(d=>d.clicked_at).length, optedOut:members.filter(m=>m.stop_reason==='opt_out').length,
    failed:deliveries.filter(d=>d.status==='failed').length, unknown:deliveries.filter(d=>d.status==='unknown').length,
    waiting:deliveries.filter(d=>d.status==='sending').length,
    eligible24h:completedWindow.length, added24h:converted,
    rate24h:completedWindow.length?Math.round(converted/completedWindow.length*1000)/10:null,
    deliveryTiming:timing(sent.map(d=>Math.max(0,Date.parse(d.sent_at)-Date.parse(d.due_at)))),
    clickTiming:timing(sent.filter(d=>d.clicked_at).map(d=>Math.max(0,Date.parse(d.clicked_at)-Date.parse(d.sent_at)))) };
}
