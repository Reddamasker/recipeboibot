import { randomUUID } from 'node:crypto';
import { db, getPendingIntent, clearPendingIntent, setPendingIntent } from './db.js';
import { log } from './log.js';

db.exec(`CREATE TABLE IF NOT EXISTS feedback_messages (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_key TEXT NOT NULL,
  telegram_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  username TEXT,
  message TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  UNIQUE(user_id, request_key)
);
CREATE INDEX IF NOT EXISTS feedback_delivery ON feedback_messages(delivered_at, next_attempt_at);`);

const inFlight = new Map();
export async function deliverFeedback(row, send) {
  if (row.delivered_at || row.next_attempt_at > Date.now()) return Boolean(row.delivered_at);
  if (inFlight.has(row.id)) return inFlight.get(row.id);
  const delivery = (async () => {
    try {
      await send(row);
      db.prepare('UPDATE feedback_messages SET delivered_at=? WHERE id=?').run(new Date().toISOString(), row.id);
      return true;
    } catch (error) {
      const delay = Math.min(3600000, 60000 * 2 ** Math.min(row.attempts, 6));
      db.prepare('UPDATE feedback_messages SET attempts=attempts+1, next_attempt_at=? WHERE id=?').run(Date.now() + delay, row.id);
      log('warn', 'feedback_delivery_failed', { feedbackId: row.id });
      return false;
    }
  })();
  inFlight.set(row.id, delivery);
  try { return await delivery; } finally { inFlight.delete(row.id); }
}

export async function submitFeedback(userId, sender, input, send) {
  const message = typeof input.message === 'string' ? input.message.trim() : '';
  if (!message || message.length > 3000) throw Object.assign(new Error('Напишите сообщение длиной от 1 до 3000 символов.'), { status: 400 });
  if (typeof input.requestKey !== 'string' || !/^[A-Za-z0-9:_-]{8,100}$/.test(input.requestKey)) throw Object.assign(new Error('Не удалось отправить сообщение. Откройте форму ещё раз.'), { status: 400 });
  let row = db.prepare('SELECT * FROM feedback_messages WHERE user_id=? AND request_key=?').get(userId, input.requestKey);
  if (row && row.message !== message) throw Object.assign(new Error('Это обращение уже отправлено. Откройте новую форму.'), { status: 409 });
  if (!row) {
    const count = db.prepare('SELECT COUNT(*) AS count FROM feedback_messages WHERE telegram_id=? AND created_at>?').get(String(sender.id), new Date(Date.now() - 600000).toISOString()).count;
    if (count >= 5) throw Object.assign(new Error('Вы уже отправили несколько обращений. Попробуйте через 10 минут.'), { status: 429 });
    const id = randomUUID();
    db.prepare(`INSERT INTO feedback_messages(id,user_id,request_key,telegram_id,display_name,username,message,source,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(id, userId, input.requestKey, String(sender.id), [sender.first_name, sender.last_name].filter(Boolean).join(' ').slice(0, 100) || 'Пользователь', sender.username || null, message, input.source === 'telegram' ? 'telegram' : 'app', new Date().toISOString());
    row = db.prepare('SELECT * FROM feedback_messages WHERE id=?').get(id);
  }
  return { id: row.id, delivered: await deliverFeedback(row, send) };
}

let timer;
export function restoreFeedbackConversation(userId) {
  const pending = getPendingIntent(userId);
  if (pending?.kind !== 'feedback') return;
  clearPendingIntent(userId);
  if (pending.resumeIntent) setPendingIntent(userId, pending.resumeIntent);
}

let draining = false;
export async function flushFeedback(send) {
  if (draining) return;
  draining = true;
  try {
    for (const row of db.prepare('SELECT * FROM feedback_messages WHERE delivered_at IS NULL AND next_attempt_at<=? ORDER BY created_at LIMIT 10').all(Date.now())) await deliverFeedback(row, send);
  } finally { draining = false; }
}
export function startFeedbackScheduler(send) {
  if (timer) return;
  const flush = () => void flushFeedback(send).catch(() => log('warn', 'feedback_queue_failed'));
  timer = setInterval(flush, 60000); timer.unref(); flush();
}
export function stopFeedbackScheduler() { clearInterval(timer); timer = null; }
