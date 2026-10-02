import { db } from './db.js';
import { getSubscriptionAccess, grantSubscription, monthAfter } from './subscriptions.js';
import { campaignPromoAvailable, DINNER_PRICE_EXPERIMENT } from './campaign-prices.js';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const discounts = new Map([['PICHU99', 99], ['PICHU100', 100]]);
db.exec(`CREATE TABLE IF NOT EXISTS promo_redemptions (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  order_id TEXT,
  redeemed_at TEXT,
  expires_at TEXT,
  PRIMARY KEY(user_id,code)
);`);

export function promoQuote(userId, input) {
  if (typeof input !== 'string' || input.length > 64) throw fail('Введите промокод');
  const code = input.replace(/\s+/g, '').toUpperCase();
  if (code === DINNER_PRICE_EXPERIMENT.promoCode) {
    const used = db.prepare('SELECT redeemed_at FROM promo_redemptions WHERE user_id=? AND code=?').get(userId, code);
    if (used?.redeemed_at) throw fail('Этот промокод уже использован', 409);
    if (!campaignPromoAvailable(userId)) throw fail('Промокод доступен только пользователям, которым он предоставлен, до первой покупки.', 403);
    return { code, discountPercent: null, discountRub: 40, basePriceRub: 199, priceRub: 159, period: 'month', periodMonths: 1 };
  }
  const discountPercent = discounts.get(code);
  if (!discountPercent) throw fail('Промокод не найден');
  const used = db.prepare('SELECT redeemed_at FROM promo_redemptions WHERE user_id=? AND code=?').get(userId, code);
  if (used?.redeemed_at) throw fail('Этот промокод уже использован', 409);
  return { code, discountPercent, basePriceRub: 199, priceRub: discountPercent === 100 ? 0 : 1.99, period: 'month' };
}

export function reservedPromoOrder(userId, code) {
  return db.prepare('SELECT order_id FROM promo_redemptions WHERE user_id=? AND code=?').get(userId, code)?.order_id;
}

export function reservePromo(userId, code, orderId) {
  db.prepare('INSERT INTO promo_redemptions(user_id,code,order_id) VALUES(?,?,?)').run(userId, code, orderId);
}

// Called inside the payment transaction, only after its verified success.
export function consumePromo(userId, orderId, at, expiresAt) {
  db.prepare('UPDATE promo_redemptions SET redeemed_at=?,expires_at=? WHERE user_id=? AND order_id=? AND redeemed_at IS NULL')
    .run(at.toISOString(), expiresAt, userId, orderId);
}

export function releasePromo(userId, orderId) {
  db.prepare('DELETE FROM promo_redemptions WHERE user_id=? AND order_id=? AND redeemed_at IS NULL').run(userId, orderId);
}

export function extendPromoAccess(userId, at = new Date()) {
  const access = getSubscriptionAccess(userId, at);
  const expiresAt = monthAfter(access.active ? access.expiresAt : at);
  grantSubscription(userId, access.plan === 'premium' ? 'premium' : 'subscription', expiresAt, at);
  // An existing renewal must not charge before the newly extended period ends.
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='payment_recurring'").get()) {
    db.prepare('UPDATE payment_recurring SET next_charge_at=?,updated_at=? WHERE user_id=? AND enabled=1')
      .run(new Date(Date.parse(expiresAt) - 86400000).toISOString(), at.toISOString(), userId);
  }
  return expiresAt;
}

export function redeemFreePromo(userId, input, at = new Date()) {
  db.exec('BEGIN IMMEDIATE');
  try {
    // A repeat request must never extend access again.
    const code = typeof input === 'string' && input.length <= 64 ? input.replace(/\s+/g, '').toUpperCase() : '';
    const previous = db.prepare('SELECT expires_at FROM promo_redemptions WHERE user_id=? AND code=? AND redeemed_at IS NOT NULL').get(userId, code);
    if (code === 'PICHU100' && previous) { db.exec('COMMIT'); return { code, expiresAt: previous.expires_at, alreadyRedeemed: true }; }
    const quote = promoQuote(userId, input);
    if (quote.discountPercent !== 100) throw fail('Этот промокод требует оплаты');
    const expiresAt = extendPromoAccess(userId, at);
    db.prepare('INSERT INTO promo_redemptions(user_id,code,redeemed_at,expires_at) VALUES(?,?,?,?)')
      .run(userId, quote.code, at.toISOString(), expiresAt);
    db.exec('COMMIT');
    return { ...quote, expiresAt, alreadyRedeemed: false };
  } catch (cause) { db.exec('ROLLBACK'); throw cause; }
}
