import { createHash, randomUUID } from 'node:crypto';
import { db, deleteUserData, getUserByTelegramId } from './db.js';
import { config } from './config.js';

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
    status TEXT NOT NULL CHECK(status IN ('pending','success','failure','cancel')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS mock_orders_user_created ON mock_orders(user_id,created_at DESC);`);
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

export function mockPaymentStatus(userId) {
  if (!config.testContour) throw error('Не найдено', 404);
  const offer = offerFor(userId);
  const payment = db.prepare('SELECT active,last_result,updated_at FROM mock_payments WHERE user_id=?').get(userId);
  const pending = db.prepare("SELECT id,method,amount_rub,variant,created_at FROM mock_orders WHERE user_id=? AND status='pending' ORDER BY created_at DESC LIMIT 1").get(userId);
  return {
    active: Boolean(payment?.active), lastResult: payment?.last_result || null, updatedAt: payment?.updated_at || null,
    hasFirstRecipe: hasRecipe(userId), offerShown: Boolean(offer.shown_at),
    offer: { variant: offer.variant, priceRub: offer.amount_rub, currency: 'RUB', period: 'month' },
    pendingOrder: pending ? { id: pending.id, method: pending.method, priceRub: pending.amount_rub, variant: pending.variant, createdAt: pending.created_at } : null
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
  return !status.hasFirstRecipe || status.active;
}

export function createMockOrder(userId, method) {
  const status = mockPaymentStatus(userId);
  if (!status.hasFirstRecipe) throw error('Сначала сохраните первый рецепт', 409);
  if (status.active) throw error('Тестовый доступ уже активен', 409);
  if (!['card', 'sbp'].includes(method)) throw error('Неверный способ оплаты', 400);
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare("UPDATE mock_orders SET status='cancel',updated_at=? WHERE user_id=? AND status='pending'").run(now, userId);
  db.prepare('INSERT INTO mock_orders(id,user_id,variant,amount_rub,method,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(id, userId, status.offer.variant, status.offer.priceRub, method, 'pending', now, now);
  return { id, method, priceRub: status.offer.priceRub, variant: status.offer.variant, status: 'pending', createdAt: now };
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
      const active = result === 'success' ? 1 : Number(db.prepare('SELECT active FROM mock_payments WHERE user_id=?').get(userId)?.active || 0);
      db.prepare(`INSERT INTO mock_payments(user_id,active,last_result,updated_at) VALUES(?,?,?,?)
        ON CONFLICT(user_id) DO UPDATE SET active=excluded.active,last_result=excluded.last_result,updated_at=excluded.updated_at`)
        .run(userId, active, result, now);
      db.exec('COMMIT');
    } catch (cause) { db.exec('ROLLBACK'); throw cause; }
  }
  return { order: { id: orderId, method: order.method, priceRub: order.amount_rub, variant: order.variant, status: result }, payment: mockPaymentStatus(userId) };
}

export function resetTestUser(telegramId) {
  requireTestOwner(telegramId);
  const user = getUserByTelegramId(telegramId);
  if (!user) return false;
  // Provider accounting remains for honest cost tracking.
  return deleteUserData(user.id);
}
