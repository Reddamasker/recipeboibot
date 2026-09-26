import { db, deleteUserData, getUserByTelegramId } from './db.js';
import { config } from './config.js';

export function requireTestOwner(telegramId) {
  if (!config.testContour) throw Object.assign(new Error('Не найдено'), { status: 404 });
  if (String(telegramId) !== config.testOwnerTelegramId) throw Object.assign(new Error('Тестовый контур закрыт'), { status: 403 });
}

function ensureMockPayments() {
  db.exec(`CREATE TABLE IF NOT EXISTS mock_payments (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    active INTEGER NOT NULL DEFAULT 0,
    last_result TEXT CHECK(last_result IN ('success','failure','cancel')),
    updated_at TEXT NOT NULL
  )`);
}

export function mockPaymentStatus(userId) {
  if (!config.testContour) throw Object.assign(new Error('Не найдено'), { status: 404 });
  ensureMockPayments();
  const row = db.prepare('SELECT active,last_result,updated_at FROM mock_payments WHERE user_id=?').get(userId);
  return { active: Boolean(row?.active), lastResult: row?.last_result || null, updatedAt: row?.updated_at || null };
}

export function simulateMockPayment(userId, result) {
  if (!config.testContour) throw Object.assign(new Error('Не найдено'), { status: 404 });
  if (!['success', 'failure', 'cancel'].includes(result)) throw Object.assign(new Error('Неверный исход тестовой оплаты'), { status: 400 });
  ensureMockPayments();
  const active = result === 'success' ? 1 : Number(mockPaymentStatus(userId).active);
  db.prepare(`INSERT INTO mock_payments(user_id,active,last_result,updated_at) VALUES(?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET active=excluded.active,last_result=excluded.last_result,updated_at=excluded.updated_at`)
    .run(userId, active, result, new Date().toISOString());
  return mockPaymentStatus(userId);
}

export function resetTestUser(telegramId) {
  requireTestOwner(telegramId);
  const user = getUserByTelegramId(telegramId);
  if (!user) return false;
  // Cascading deletes clear the profile, recipes, dinner history, pending intent,
  // and mock entitlement. Provider accounting remains for honest cost tracking.
  return deleteUserData(user.id);
}
