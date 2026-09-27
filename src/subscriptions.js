import { db } from './db.js';
import { config } from './config.js';

// Only trusted server administration/payment integrations may write this table.
db.exec(`CREATE TABLE IF NOT EXISTS user_subscriptions (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  plan TEXT NOT NULL CHECK(plan IN ('subscription','premium')),
  starts_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  updated_at TEXT NOT NULL
);`);

export function monthAfter(timestamp) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return null;
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + 1);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return date.toISOString();
}

export function getSubscriptionAccess(userId, at = new Date()) {
  const row = db.prepare('SELECT * FROM user_subscriptions WHERE user_id=?').get(userId);
  if (row && !row.revoked_at && Date.parse(row.starts_at) <= at.getTime() && Date.parse(row.expires_at) > at.getTime()) {
    return { active: true, plan: row.plan, expiresAt: row.expires_at, source: 'subscription' };
  }
  // Mock payment is an entitlement only inside the separate test contour.
  if (config.testContour && db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='mock_payments'").get()) {
    const payment = db.prepare('SELECT active,updated_at FROM mock_payments WHERE user_id=?').get(userId);
    if (payment?.active) {
      const orderTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='mock_orders'").get();
      const success = orderTable && db.prepare("SELECT updated_at FROM mock_orders WHERE user_id=? AND status='success' ORDER BY updated_at DESC LIMIT 1").get(userId);
      const startedAt = success?.updated_at || payment.updated_at;
      const expiresAt = monthAfter(startedAt);
      if (Date.parse(startedAt) <= at.getTime() && Date.parse(expiresAt) > at.getTime()) return { active: true, plan: 'subscription', expiresAt, source: 'test_payment' };
    }
  }
  return { active: false, plan: null, expiresAt: row?.expires_at || null, source: null };
}

export function requireNotificationSubscription(userId, at = new Date()) {
  const access = getSubscriptionAccess(userId, at);
  if (!access.active) throw Object.assign(new Error('Напоминания доступны с активной подпиской или премиум-доступом к боту'), { status: 402 });
  return access;
}

export function grantSubscription(userId, plan, expiresAt, at = new Date()) {
  const expires = new Date(expiresAt);
  if (!['subscription', 'premium'].includes(plan) || !Number.isFinite(expires.getTime()) || expires <= at) throw new Error('Укажите тариф subscription|premium и будущий срок окончания');
  const timestamp = at.toISOString();
  db.prepare(`INSERT INTO user_subscriptions(user_id,plan,starts_at,expires_at,updated_at) VALUES(?,?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET plan=excluded.plan,starts_at=excluded.starts_at,expires_at=excluded.expires_at,revoked_at=NULL,updated_at=excluded.updated_at`)
    .run(userId, plan, timestamp, expires.toISOString(), timestamp);
  return getSubscriptionAccess(userId, at);
}

export function revokeSubscription(userId, at = new Date()) {
  db.prepare('UPDATE user_subscriptions SET revoked_at=?,updated_at=? WHERE user_id=?').run(at.toISOString(), at.toISOString(), userId);
  return getSubscriptionAccess(userId, at);
}
