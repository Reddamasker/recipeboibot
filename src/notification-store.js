import { randomUUID } from 'node:crypto';
import { db } from './db.js';
import { getSubscriptionAccess, requireNotificationSubscription } from './subscriptions.js';

db.exec(`
CREATE TABLE IF NOT EXISTS notification_schedules (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0,
  weekdays_json TEXT NOT NULL DEFAULT '[]',
  local_time TEXT NOT NULL DEFAULT '18:00',
  timezone TEXT NOT NULL DEFAULT 'Europe/Moscow',
  next_due_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notification_deliveries (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES dinner_sessions(id) ON DELETE CASCADE,
  scheduled_for TEXT NOT NULL,
  local_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','sent','chosen','failed')),
  recommendation_id TEXT REFERENCES dinner_recommendations(id) ON DELETE SET NULL,
  recipe_key TEXT,
  reminder_attempts INTEGER NOT NULL DEFAULT 0,
  reminder_retry_at TEXT,
  reminder_sent_at TEXT,
  choice_attempts INTEGER NOT NULL DEFAULT 0,
  choice_retry_at TEXT,
  choice_sent_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, local_key)
);
CREATE INDEX IF NOT EXISTS notification_schedules_due ON notification_schedules(enabled, next_due_at);
CREATE INDEX IF NOT EXISTS notification_deliveries_pending ON notification_deliveries(status, reminder_retry_at, choice_retry_at);
`);
if (!db.prepare('PRAGMA table_info(notification_schedules)').all().some(c => c.name === 'first_enabled_at')) {
  db.exec(`ALTER TABLE notification_schedules ADD COLUMN first_enabled_at TEXT;
    UPDATE notification_schedules SET first_enabled_at=COALESCE(
      (SELECT MIN(created_at) FROM notification_deliveries d WHERE d.user_id=notification_schedules.user_id),updated_at)
    WHERE enabled=1 OR EXISTS(SELECT 1 FROM notification_deliveries d WHERE d.user_id=notification_schedules.user_id);`);
}

const nowIso = (date = new Date()) => date.toISOString();
const parseJson = (value, fallback) => { try { return JSON.parse(value); } catch { return fallback; } };
const WEEKDAYS = new Map([['Sun', 0], ['Mon', 1], ['Tue', 2], ['Wed', 3], ['Thu', 4], ['Fri', 5], ['Sat', 6]]);
const formatterCache = new Map();

function formatter(timezone) {
  if (!formatterCache.has(timezone)) formatterCache.set(timezone, new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }));
  return formatterCache.get(timezone);
}

function localParts(date, timezone) {
  const parts = Object.fromEntries(formatter(timezone).formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return { weekday: WEEKDAYS.get(parts.weekday), date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

export function validateNotificationSchedule(input) {
  const enabled = input?.enabled === true;
  const weekdays = Array.isArray(input?.weekdays) ? [...new Set(input.weekdays)] : [];
  if (weekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) throw Object.assign(new Error('Проверьте выбранные дни'), { status: 400 });
  weekdays.sort((a, b) => a - b);
  if (enabled && !weekdays.length) throw Object.assign(new Error('Выберите хотя бы один день'), { status: 400 });
  const time = String(input?.time || '').trim();
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) throw Object.assign(new Error('Проверьте время уведомления'), { status: 400 });
  const timezone = String(input?.timezone || '').trim();
  try { formatter(timezone).format(new Date()); }
  catch { throw Object.assign(new Error('Не удалось определить часовой пояс'), { status: 400 }); }
  return { enabled, weekdays, time, timezone };
}

export function nextNotificationAt(schedule, from = new Date()) {
  if (!schedule.enabled || !schedule.weekdays.length) return null;
  const start = Math.floor((from.getTime() + 60000) / 60000) * 60000;
  const selected = new Set(schedule.weekdays);
  for (let minute = 0; minute <= 8 * 24 * 60; minute += 1) {
    const candidate = new Date(start + minute * 60000);
    const local = localParts(candidate, schedule.timezone);
    if (selected.has(local.weekday) && local.time === schedule.time) return candidate;
  }
  throw new Error('Не удалось рассчитать следующее уведомление');
}

function parseSchedule(row) {
  if (!row) return { enabled: false, weekdays: [1, 2, 3, 4, 5], time: '18:00', timezone: null, nextDueAt: null };
  return { enabled: Boolean(row.enabled), weekdays: parseJson(row.weekdays_json, []), time: row.local_time, timezone: row.timezone, nextDueAt: row.next_due_at };
}

export function getNotificationSchedule(userId, at = new Date()) {
  const schedule = parseSchedule(db.prepare('SELECT * FROM notification_schedules WHERE user_id=?').get(userId));
  const access = getSubscriptionAccess(userId, at);
  return { ...schedule, nextDueAt: access.active ? schedule.nextDueAt : null, access, paused: schedule.enabled && !access.active };
}

export function saveNotificationSchedule(userId, input, at = new Date()) {
  const schedule = validateNotificationSchedule(input);
  if (schedule.enabled) requireNotificationSubscription(userId, at);
  const nextDueAt = nextNotificationAt(schedule, at)?.toISOString() || null;
  const timestamp = nowIso(at);
  if (!schedule.enabled && db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='trial_digest_members'").get()) {
    db.prepare(`UPDATE trial_digest_members SET opted_out_at=COALESCE(opted_out_at,?) WHERE user_id=?
      AND EXISTS(SELECT 1 FROM notification_schedules s WHERE s.user_id=? AND s.enabled=1)`).run(timestamp,userId,userId);
  }
  db.prepare(`INSERT INTO notification_schedules(user_id,enabled,weekdays_json,local_time,timezone,next_due_at,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET enabled=excluded.enabled,weekdays_json=excluded.weekdays_json,
    local_time=excluded.local_time,timezone=excluded.timezone,next_due_at=excluded.next_due_at,updated_at=excluded.updated_at`)
    .run(userId, schedule.enabled ? 1 : 0, JSON.stringify(schedule.weekdays), schedule.time, schedule.timezone, nextDueAt, timestamp, timestamp);
  if (schedule.enabled) db.prepare('UPDATE notification_schedules SET first_enabled_at=COALESCE(first_enabled_at,?) WHERE user_id=?').run(timestamp, userId);
  return getNotificationSchedule(userId, at);
}

export function enqueueDueNotifications(at = new Date()) {
  const due = db.prepare(`SELECT * FROM notification_schedules WHERE enabled=1 AND next_due_at IS NOT NULL AND next_due_at<=?
    ORDER BY next_due_at LIMIT 100`).all(nowIso(at));
  const created = [];
  for (const row of due) {
    const schedule = parseSchedule(row);
    const scheduledAt = new Date(row.next_due_at);
    const local = localParts(scheduledAt, schedule.timezone);
    const localKey = `${local.date}|${schedule.time}`;
    const timestamp = nowIso(at);
    db.exec('BEGIN IMMEDIATE');
    try {
      const fresh = db.prepare('SELECT * FROM notification_schedules WHERE user_id=?').get(row.user_id);
      if (!fresh?.enabled || fresh.next_due_at !== row.next_due_at) { db.exec('COMMIT'); continue; }
      if (getSubscriptionAccess(row.user_id, at).active && at.getTime() - scheduledAt.getTime() <= 15 * 60000) {
        const id = randomUUID();
        if (db.prepare(`INSERT OR IGNORE INTO notification_deliveries(id,user_id,scheduled_for,local_key,reminder_retry_at,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?)`).run(id, row.user_id, row.next_due_at, localKey, timestamp, timestamp, timestamp).changes) created.push(id);
      }
      const next = nextNotificationAt(schedule, new Date(Math.max(at.getTime(), scheduledAt.getTime())));
      db.prepare('UPDATE notification_schedules SET next_due_at=?,updated_at=? WHERE user_id=?').run(next.toISOString(), timestamp, row.user_id);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  return created;
}

const deliverySelect = `SELECT d.*,COALESCE(owner.telegram_id,u.telegram_id) AS telegram_id
  FROM notification_deliveries d JOIN users u ON u.id=d.user_id
  LEFT JOIN private_test_profiles p ON p.test_user_id=u.id
  LEFT JOIN users owner ON owner.id=p.owner_user_id`;

function parseDelivery(row) {
  return row ? { id: row.id, userId: row.user_id, telegramId: row.telegram_id, sessionId: row.session_id,
    scheduledFor: row.scheduled_for, status: row.status, recommendationId: row.recommendation_id, recipeKey: row.recipe_key,
    reminderAttempts: row.reminder_attempts, reminderSentAt: row.reminder_sent_at,
    choiceAttempts: row.choice_attempts, choiceSentAt: row.choice_sent_at } : null;
}

export function getNotificationDelivery(userId, id) {
  return parseDelivery(db.prepare(`${deliverySelect} WHERE d.id=? AND d.user_id=?`).get(id, userId));
}

export function getNotificationDeliveryForDispatch(id) {
  return parseDelivery(db.prepare(`${deliverySelect} WHERE d.id=?`).get(id));
}

export function discardNotificationDelivery(id, at = new Date()) {
  // Keep the choice/history, but never replay a stale delivery after renewal.
  db.prepare(`UPDATE notification_deliveries SET status=CASE WHEN status='queued' THEN 'failed' ELSE status END,
    reminder_retry_at=NULL,choice_retry_at=NULL,updated_at=? WHERE id=?`).run(nowIso(at), id);
}

export function listPendingReminderDeliveries(at = new Date()) {
  return db.prepare(`${deliverySelect} WHERE d.status='queued' AND d.reminder_attempts<5 AND d.reminder_retry_at<=? ORDER BY d.scheduled_for LIMIT 20`)
    .all(nowIso(at)).map(parseDelivery);
}

export function attachNotificationSession(id, sessionId) {
  db.prepare('UPDATE notification_deliveries SET session_id=COALESCE(session_id,?),updated_at=? WHERE id=?').run(sessionId, nowIso(), id);
  return getNotificationDeliveryForDispatch(id);
}

export function markReminderSent(id, at = new Date()) {
  db.prepare("UPDATE notification_deliveries SET status='sent',reminder_attempts=reminder_attempts+1,reminder_sent_at=?,updated_at=? WHERE id=? AND status='queued'")
    .run(nowIso(at), nowIso(at), id);
}

export function markReminderFailed(id, at = new Date()) {
  const row = db.prepare('SELECT reminder_attempts FROM notification_deliveries WHERE id=?').get(id);
  if (!row) return;
  const attempts = row.reminder_attempts + 1;
  const retryAt = new Date(at.getTime() + Math.min(3600000, 60000 * 2 ** Math.max(0, attempts - 1))).toISOString();
  db.prepare("UPDATE notification_deliveries SET status=?,reminder_attempts=?,reminder_retry_at=?,updated_at=? WHERE id=? AND status='queued'")
    .run(attempts >= 5 ? 'failed' : 'queued', attempts, retryAt, nowIso(at), id);
}

export function chooseNotificationRecipe(userId, id, recommendationId, recipeKey) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db.prepare('SELECT * FROM notification_deliveries WHERE id=? AND user_id=?').get(id, userId);
    if (!row || !['sent', 'chosen'].includes(row.status)) { db.exec('COMMIT'); return null; }
    if (row.status === 'chosen' && row.recommendation_id !== recommendationId) { db.exec('COMMIT'); return false; }
    if (row.status === 'sent') db.prepare(`UPDATE notification_deliveries SET status='chosen',recommendation_id=?,recipe_key=?,choice_retry_at=?,updated_at=? WHERE id=?`)
      .run(recommendationId, recipeKey, new Date(Date.now() + 30000).toISOString(), nowIso(), id);
    db.exec('COMMIT');
    return getNotificationDelivery(userId, id);
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function listPendingChoiceDeliveries(at = new Date()) {
  return db.prepare(`${deliverySelect} WHERE d.status='chosen' AND d.choice_sent_at IS NULL AND d.choice_attempts<5 AND d.choice_retry_at<=?
    ORDER BY d.updated_at LIMIT 20`).all(nowIso(at)).map(parseDelivery);
}

export function markChoiceSent(id, at = new Date()) {
  db.prepare('UPDATE notification_deliveries SET choice_attempts=choice_attempts+1,choice_sent_at=?,updated_at=? WHERE id=? AND choice_sent_at IS NULL')
    .run(nowIso(at), nowIso(at), id);
}

export function markChoiceFailed(id, at = new Date()) {
  const row = db.prepare('SELECT choice_attempts FROM notification_deliveries WHERE id=?').get(id);
  if (!row) return;
  const attempts = row.choice_attempts + 1;
  const retryAt = new Date(at.getTime() + Math.min(3600000, 60000 * 2 ** Math.max(0, attempts - 1))).toISOString();
  db.prepare('UPDATE notification_deliveries SET choice_attempts=?,choice_retry_at=?,updated_at=? WHERE id=? AND choice_sent_at IS NULL')
    .run(attempts, retryAt, nowIso(at), id);
}
