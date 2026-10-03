import { db } from './db.js';
import { getSubscriptionAccess, grantSubscription, monthsAfter } from './subscriptions.js';
import { subscriptionPlan, SUBSCRIPTION_PLANS } from './plans.js';
import { campaignPromoPlans, campaignPromoRedemption, DINNER_PRICE_EXPERIMENT } from './campaign-prices.js';

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
if (!db.prepare('PRAGMA table_info(promo_redemptions)').all().some(column => column.name === 'period_months')) db.exec('ALTER TABLE promo_redemptions ADD COLUMN period_months INTEGER NOT NULL DEFAULT 1');

const promoPeriod = months => months === 12 ? 'year' : months === 3 ? 'quarter' : 'month';

export function promoQuote(userId, input, periodMonths = 1) {
  const plan = subscriptionPlan(periodMonths);
  if (!plan) throw fail('Выберите срок подписки');
  if (typeof input !== 'string' || input.length > 64) throw fail('Введите промокод');
  const code = input.replace(/\s+/g, '').toUpperCase();
  if (code === DINNER_PRICE_EXPERIMENT.promoCode) {
    const used = campaignPromoRedemption(userId);
    if (used?.redeemed_at) throw fail('Этот промокод уже использован', 409);
    const plans = campaignPromoPlans(), selected = plans.find(p => p.months === plan.months);
    return { code, discountPercent: null, discountRub: selected.discountRub, basePriceRub: selected.basePriceRub,
      priceRub: selected.priceRub, period: promoPeriod(plan.months), periodMonths: plan.months, plans };
  }
  const discountPercent = discounts.get(code);
  if (!discountPercent) throw fail('Промокод не найден');
  const used = db.prepare('SELECT redeemed_at FROM promo_redemptions WHERE user_id=? AND code=?').get(userId, code);
  if (used?.redeemed_at) throw fail('Этот промокод уже использован', 409);
  const plans = SUBSCRIPTION_PLANS.map(p => {
    // Round in kopeks so the quote, payment and receipt have the same amount.
    const priceRub = Math.round(p.priceRub * (100 - discountPercent)) / 100;
    return { months: p.months, basePriceRub: p.priceRub, priceRub, discountRub: Math.round((p.priceRub - priceRub) * 100) / 100 };
  });
  const selected = plans.find(p => p.months === plan.months);
  return { code, discountPercent, basePriceRub: selected.basePriceRub, priceRub: selected.priceRub,
    discountRub: selected.discountRub, period: promoPeriod(plan.months), periodMonths: plan.months, plans };
}

export function reservedPromoOrder(userId, code) {
  if (code === DINNER_PRICE_EXPERIMENT.promoCode) return campaignPromoRedemption(userId)?.order_id;
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

export function extendPromoAccess(userId, at = new Date(), periodMonths = 1) {
  const access = getSubscriptionAccess(userId, at);
  const expiresAt = monthsAfter(access.active ? access.expiresAt : at, periodMonths);
  grantSubscription(userId, access.plan === 'premium' ? 'premium' : 'subscription', expiresAt, at);
  // An existing renewal must not charge before the newly extended period ends.
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='payment_recurring'").get()) {
    db.prepare('UPDATE payment_recurring SET next_charge_at=?,updated_at=? WHERE user_id=? AND enabled=1')
      .run(new Date(Date.parse(expiresAt) - 86400000).toISOString(), at.toISOString(), userId);
  }
  return expiresAt;
}

export function redeemFreePromo(userId, input, at = new Date(), periodMonths = 1) {
  const plan = subscriptionPlan(periodMonths);
  if (!plan) throw fail('Выберите срок подписки');
  db.exec('BEGIN IMMEDIATE');
  try {
    // A repeat request must never extend access again.
    const code = typeof input === 'string' && input.length <= 64 ? input.replace(/\s+/g, '').toUpperCase() : '';
    const previous = db.prepare('SELECT expires_at,period_months FROM promo_redemptions WHERE user_id=? AND code=? AND redeemed_at IS NOT NULL').get(userId, code);
    if (code === 'PICHU100' && previous) { db.exec('COMMIT'); return { code, expiresAt: previous.expires_at, periodMonths: previous.period_months, alreadyRedeemed: true }; }
    const quote = promoQuote(userId, input, plan.months);
    if (quote.discountPercent !== 100) throw fail('Этот промокод требует оплаты');
    const expiresAt = extendPromoAccess(userId, at, plan.months);
    db.prepare('INSERT INTO promo_redemptions(user_id,code,redeemed_at,expires_at,period_months) VALUES(?,?,?,?,?)')
      .run(userId, quote.code, at.toISOString(), expiresAt, plan.months);
    db.exec('COMMIT');
    return { ...quote, expiresAt, alreadyRedeemed: false };
  } catch (cause) { db.exec('ROLLBACK'); throw cause; }
}
