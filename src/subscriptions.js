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

db.exec(`CREATE TABLE IF NOT EXISTS user_trials (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  starts_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);`);

export function getTrialStatus(userId, at = new Date()) {
  const trial = db.prepare('SELECT starts_at,expires_at FROM user_trials WHERE user_id=?').get(userId);
  return {
    used: Boolean(trial),
    active: Boolean(trial && Date.parse(trial.starts_at) <= at.getTime() && at.getTime() < Date.parse(trial.expires_at)),
    startsAt: trial?.starts_at || null,
    expiresAt: trial?.expires_at || null,
    durationDays: 7
  };
}

export function startTrial(userId, at = new Date()) {
  // The unique user key makes retries and concurrent clicks idempotent.
  if (getTrialStatus(userId, at).used) return getTrialStatus(userId, at);
  if (getSubscriptionAccess(userId, at).active) throw Object.assign(new Error('У вас уже есть активный доступ'), { status: 409 });
  db.prepare('INSERT OR IGNORE INTO user_trials(user_id,starts_at,expires_at) VALUES(?,?,?)')
    .run(userId, at.toISOString(), new Date(at.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString());
  return getTrialStatus(userId, at);
}

export function monthsAfter(timestamp, months = 1) {
  const date = new Date(timestamp);
  const count = Number(months);
  if (!Number.isFinite(date.getTime()) || !Number.isSafeInteger(count) || count < 1 || count > 120) return null;
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + count);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return date.toISOString();
}

export function monthAfter(timestamp) {
  return monthsAfter(timestamp, 1);
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
      const success = orderTable && db.prepare("SELECT * FROM mock_orders WHERE user_id=? AND status='success' ORDER BY updated_at DESC LIMIT 1").get(userId);
      const startedAt = success?.updated_at || payment.updated_at;
      const expiresAt = monthsAfter(startedAt, success?.period_months || 1);
      if (Date.parse(startedAt) <= at.getTime() && Date.parse(expiresAt) > at.getTime()) return { active: true, plan: 'subscription', expiresAt, source: 'test_payment' };
    }
  }
  const trial = getTrialStatus(userId, at);
  if (trial.active && !row?.revoked_at) return { active: true, plan: 'trial', expiresAt: trial.expiresAt, source: 'trial' };
  return { active: false, plan: null, expiresAt: row?.expires_at || trial.expiresAt || null, source: null };
}

export function requireNotificationSubscription(userId, at = new Date()) {
  const access = getSubscriptionAccess(userId, at);
  if (!access.active) throw Object.assign(new Error('Напоминания доступны с активной подпиской или премиум-доступом к боту'), { status: 402 });
  return access;
}

export function requireUnexpiredTrial(userId, at = new Date()) {
  if (!getSubscriptionAccess(userId, at).active) {
    const message = hasUsedTrialOrPromo(userId, at)
      ? 'Бесплатный период закончился. Оформите подписку, чтобы продолжить.'
      : 'Начните бесплатный пробный период на 7 дней или оформите подписку, чтобы продолжить.';
    throw Object.assign(new Error(message), { status: 402, offerPath: '/?view=offer' });
  }
}

export function hasUsedTrialOrPromo(userId, at = new Date()) {
  return getTrialStatus(userId, at).used || Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='promo_redemptions'").get()
    && db.prepare('SELECT 1 FROM promo_redemptions WHERE user_id=? AND redeemed_at IS NOT NULL LIMIT 1').get(userId));
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
