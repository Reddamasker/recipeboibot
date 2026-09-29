import { createHash, randomUUID } from 'node:crypto';
import { db, deleteUserData, getUserByTelegramId } from './db.js';
import { config } from './config.js';
import { getSubscriptionAccess, getTrialStatus, hasUsedTrialOrPromo } from './subscriptions.js';
import { promoQuote, reservePromo, reservedPromoOrder, releasePromo, consumePromo, extendPromoAccess } from './promos.js';

const error = (message, status) => Object.assign(new Error(message), { status });

export function requireTestOwner(telegramId) {
  if (!config.testContour) throw error('Не найдено', 404);
  if (String(telegramId) !== config.testOwnerTelegramId) throw error('Тестовый контур закрыт', 403);
}

function ensureMockTables() {
  db.exec(`CREATE TABLE IF NOT EXISTS mock_payments (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    active INTEGER NOT NULL DEFAULT 0,
    last_result TEXT CHECK(last_result IN ('success','failure','cancel')),
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS mock_offers (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    variant TEXT NOT NULL,
    amount_rub INTEGER NOT NULL,
    shown_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS mock_orders (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    variant TEXT NOT NULL,
    amount_rub INTEGER NOT NULL,
    method TEXT NOT NULL CHECK(method IN ('card','sbp')),
    auto_renew INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL CHECK(status IN ('pending','success','failure','cancel')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS mock_orders_user_created ON mock_orders(user_id,created_at DESC);`);
  if (!db.prepare('PRAGMA table_info(mock_orders)').all().some((column) => column.name === 'auto_renew')) db.exec('ALTER TABLE mock_orders ADD COLUMN auto_renew INTEGER NOT NULL DEFAULT 0');
  if (!db.prepare('PRAGMA table_info(mock_orders)').all().some((column) => column.name === 'promo_code')) db.exec('ALTER TABLE mock_orders ADD COLUMN promo_code TEXT');
}

function offerFor(userId) {
  ensureMockTables();
  let offer = db.prepare('SELECT * FROM mock_offers WHERE user_id=?').get(userId);
  if (!offer) {
    const user = db.prepare('SELECT telegram_id FROM users WHERE id=?').get(userId);
    if (!user) throw error('Пользователь не найден', 404);
    const hash = createHash('sha256').update(String(user.telegram_id)).digest().readUInt32BE(0);
    const amount = config.testPriceVariants[hash % config.testPriceVariants.length];
    db.prepare('INSERT INTO mock_offers(user_id,variant,amount_rub,created_at) VALUES(?,?,?,?)')
      .run(userId, `price_${amount}`, amount, new Date().toISOString());
    offer = db.prepare('SELECT * FROM mock_offers WHERE user_id=?').get(userId);
  }
  return offer;
}

function hasRecipe(userId) {
  return Boolean(db.prepare("SELECT 1 FROM recipes WHERE user_id=? AND status='ready' LIMIT 1").get(userId));
}

function hasCookedDinner(userId) {
  return Boolean(db.prepare("SELECT 1 FROM dinner_events WHERE user_id=? AND event='recipe_cooked' LIMIT 1").get(userId));
}

export function mockPaymentStatus(userId) {
  if (!config.testContour) throw error('Не найдено', 404);
  const offer = offerFor(userId);
  const payment = db.prepare('SELECT active,last_result,updated_at FROM mock_payments WHERE user_id=?').get(userId);
  const pending = db.prepare("SELECT id,method,amount_rub,variant,auto_renew,created_at,promo_code FROM mock_orders WHERE user_id=? AND status='pending' ORDER BY created_at DESC LIMIT 1").get(userId);
  const recurring = db.prepare("SELECT auto_renew,updated_at FROM mock_orders WHERE user_id=? AND status='success' ORDER BY updated_at DESC LIMIT 1").get(userId);
  const firstValue = hasRecipe(userId) ? 'saved' : hasCookedDinner(userId) ? 'cooked' : null;
  const access = getSubscriptionAccess(userId);
  const trial = getTrialStatus(userId);
  return {
    accessSource: access.source, trial: { ...trial, eligible: !trial.used && !access.active },
    active: access.active, expiresAt: access.expiresAt, lastResult: payment?.last_result || null, updatedAt: payment?.updated_at || null,
    hasFirstRecipe: Boolean(firstValue), firstValue, offerShown: Boolean(offer.shown_at),
    mode: 'mock', available: true, recurringSupported: true,
    recurring: { enabled: Boolean(recurring?.auto_renew), nextChargeAt: recurring?.auto_renew && access.expiresAt ? new Date(Date.parse(access.expiresAt) - 24 * 60 * 60 * 1000).toISOString() : null },
    offer: { variant: offer.variant, priceRub: offer.amount_rub, currency: 'RUB', period: 'month' },
    pendingOrder: pending ? { id: pending.id, method: pending.method, autoRenew: Boolean(pending.auto_renew), priceRub: pending.amount_rub, variant: pending.variant, createdAt: pending.created_at, promoCode: pending.promo_code || null } : null
  };
}

export function claimMockOffer(userId) {
  const status = mockPaymentStatus(userId);
  if (!status.hasFirstRecipe || status.active || status.offerShown) return false;
  return db.prepare('UPDATE mock_offers SET shown_at=? WHERE user_id=? AND shown_at IS NULL')
    .run(new Date().toISOString(), userId).changes > 0;
}

export function canUseTestImport(userId) {
  if (!config.testContour) return true;
  const status = mockPaymentStatus(userId);
  if (hasUsedTrialOrPromo(userId)) return status.active;
  return !status.hasFirstRecipe || status.active;
}

export function createMockOrder(userId, method, autoRenew = false, promoCode) {
  const status = mockPaymentStatus(userId);
  if (promoCode !== undefined) {
    const promo = promoQuote(userId, promoCode);
    if (promo.discountPercent === 100) throw error('Активируйте бесплатный месяц без оплаты', 400);
    if (autoRenew) throw error('Промокод действует на один месяц без автопродления', 400);
    if (!['card', 'sbp'].includes(method)) throw error('Неверный способ оплаты', 400);
    const reserved = reservedPromoOrder(userId, promo.code);
    const existing = reserved && db.prepare("SELECT * FROM mock_orders WHERE id=? AND user_id=? AND status='pending'").get(reserved, userId);
    if (reserved && !existing) throw error('Заказ с этим промокодом уже завершён', 409);
    const id = existing?.id || randomUUID(), now = new Date().toISOString();
    if (!existing) {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare("INSERT INTO mock_orders(id,user_id,variant,amount_rub,method,auto_renew,status,created_at,updated_at,promo_code) VALUES(?,?,?,1.99,?,0,'pending',?,?,?)")
          .run(id, userId, 'promo_99', method, now, now, promo.code);
        reservePromo(userId, promo.code, id);
        db.exec('COMMIT');
      } catch (cause) { db.exec('ROLLBACK'); throw cause; }
    }
    return { id, method: existing?.method || method, autoRenew: false, priceRub: 1.99, variant: 'promo_99', promoCode: promo.code, status: 'pending', createdAt: existing?.created_at || now };
  }
  if (!status.hasFirstRecipe && !status.trial.used) throw error('Сначала сохраните первый рецепт', 409);
  if (status.active) throw error('Тестовый доступ уже активен', 409);
  if (!['card', 'sbp'].includes(method)) throw error('Неверный способ оплаты', 400);
  if (autoRenew && method !== 'card') throw error('Автопродление доступно только при оплате картой', 400);
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare("UPDATE mock_orders SET status='cancel',updated_at=? WHERE user_id=? AND status='pending' AND promo_code IS NULL").run(now, userId);
  db.prepare('INSERT INTO mock_orders(id,user_id,variant,amount_rub,method,auto_renew,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(id, userId, status.offer.variant, status.offer.priceRub, method, autoRenew ? 1 : 0, 'pending', now, now);
  return { id, method, autoRenew: Boolean(autoRenew), priceRub: status.offer.priceRub, variant: status.offer.variant, status: 'pending', createdAt: now };
}

export function finishMockOrder(userId, orderId, result) {
  if (!['success', 'failure', 'cancel'].includes(result)) throw error('Неверный исход тестовой оплаты', 400);
  if (!/^[0-9a-f-]{36}$/i.test(String(orderId))) throw error('Неверный номер заказа', 400);
  ensureMockTables();
  const order = db.prepare('SELECT * FROM mock_orders WHERE id=? AND user_id=?').get(orderId, userId);
  if (!order) throw error('Заказ не найден', 404);
  if (order.status !== 'pending' && order.status !== result) throw error('Заказ уже завершён', 409);
  if (order.status === 'pending') {
    db.exec('BEGIN IMMEDIATE');
    try {
      const now = new Date().toISOString();
      db.prepare('UPDATE mock_orders SET status=?,updated_at=? WHERE id=?').run(result, now, orderId);
      if (order.promo_code) {
        if (result === 'success') {
          const at = new Date(now), expiresAt = extendPromoAccess(userId, at);
          consumePromo(userId, orderId, at, expiresAt);
        } else releasePromo(userId, orderId);
      }
      const active = result === 'success' ? 1 : Number(db.prepare('SELECT active FROM mock_payments WHERE user_id=?').get(userId)?.active || 0);
      db.prepare(`INSERT INTO mock_payments(user_id,active,last_result,updated_at) VALUES(?,?,?,?)
        ON CONFLICT(user_id) DO UPDATE SET active=excluded.active,last_result=excluded.last_result,updated_at=excluded.updated_at`)
        .run(userId, active, result, now);
      db.exec('COMMIT');
    } catch (cause) { db.exec('ROLLBACK'); throw cause; }
  }
  return { order: { id: orderId, method: order.method, autoRenew: Boolean(order.auto_renew), priceRub: order.amount_rub, variant: order.variant, status: result }, payment: mockPaymentStatus(userId) };
}

export function cancelMockAutoRenew(userId) {
  db.prepare("UPDATE mock_orders SET auto_renew=0,updated_at=? WHERE user_id=? AND status='success'").run(new Date().toISOString(), userId);
  return mockPaymentStatus(userId).recurring;
}

export function resetTestUser(telegramId) {
  requireTestOwner(telegramId);
  const user = getUserByTelegramId(telegramId);
  if (!user) return false;
  // Provider accounting remains for honest cost tracking.
  return deleteUserData(user.id);
}
