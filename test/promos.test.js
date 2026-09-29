import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'recipe-promo-'));
process.env.DATABASE_PATH = path.join(directory, 'test.sqlite');
process.env.TEST_CONTOUR = 'false';
process.env.TELEGRAM_BOT_TOKEN = '123456:promo-test';
process.env.TELEGRAM_POLLING = 'false';
process.env.BILLING_REQUIRED = 'false';
delete process.env.ROBOKASSA_MERCHANT_LOGIN;
const { db, upsertTelegramUser, allowUser, deleteUserData } = await import('../src/db.js');
const { promoQuote, redeemFreePromo } = await import('../src/promos.js');
const { getSubscriptionAccess, startTrial, requireUnexpiredTrial, grantSubscription } = await import('../src/subscriptions.js');
const { canUseAutomaticImport, createPaymentOrder } = await import('../src/billing.js');
const { createServer } = await import('../src/server.js');
const { makeTelegramInitData } = await import('../src/security.js');
let serial = 620000000;
function fresh() { const telegram = { id: serial++, first_name: 'Promo' }; const user = upsertTelegramUser(telegram); allowUser(user.id); return { user, telegram }; }
test.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });

test('promo names normalize spaces and case; amounts are server-owned and old typo is rejected', () => {
  const { user } = fresh();
  assert.deepEqual(promoQuote(user.id, ' pichu99 '), { code: 'PICHU99', discountPercent: 99, basePriceRub: 199, priceRub: 1.99, period: 'month' });
  assert.equal(promoQuote(user.id, 'PICHU 100').priceRub, 0);
  for (const code of ['PICHU9', 'bad', '', null, {}, 'a'.repeat(65)]) assert.throws(() => promoQuote(user.id, code), { status: 400 });
  assert.equal(getSubscriptionAccess(user.id).active, false);
});

test('free month needs no provider, preserves trial, survives restart, cannot repeat and expires closed', () => {
  const { user } = fresh(), at = new Date('2026-09-29T10:00:00Z');
  startTrial(user.id, at);
  const result = redeemFreePromo(user.id, 'PICHU 100', at);
  assert.equal(result.expiresAt, '2026-11-06T10:00:00.000Z');
  assert.equal(redeemFreePromo(user.id, 'pichu100', new Date('2026-10-01')).expiresAt, result.expiresAt);
  assert.equal(db.prepare('SELECT count(*) AS n FROM payment_orders WHERE user_id=?').get(user.id).n, 0);
  assert.throws(() => promoQuote(user.id, 'PICHU100'), { status: 409 });
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `const {redeemFreePromo}=await import('./src/promos.js'); console.log(JSON.stringify(redeemFreePromo(${JSON.stringify(user.id)}, 'PICHU100')));`], { encoding: 'utf8', env: process.env });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout.trim()).expiresAt, result.expiresAt);
  assert.equal(canUseAutomaticImport(user.id, new Date(result.expiresAt)), false);
  assert.throws(() => requireUnexpiredTrial(user.id, new Date(result.expiresAt)), { status: 402 });
});

test('promo without trial also expires closed and preserves premium access and renewal date', () => {
  const { user } = fresh(), at = new Date('2026-01-31T10:00:00Z');
  const result = redeemFreePromo(user.id, 'PICHU100', at);
  assert.equal(result.expiresAt, '2026-02-28T10:00:00.000Z');
  assert.equal(canUseAutomaticImport(user.id, new Date(result.expiresAt)), false);
  assert.throws(() => requireUnexpiredTrial(user.id, new Date(result.expiresAt)), { status: 402 });
  const paid = fresh().user;
  grantSubscription(paid.id, 'premium', '2026-03-31T10:00:00Z', at);
  assert.equal(redeemFreePromo(paid.id, 'PICHU100', at).expiresAt, '2026-04-30T10:00:00.000Z');
  assert.equal(getSubscriptionAccess(paid.id, at).plan, 'premium');
  deleteUserData(paid.id);
  assert.equal(db.prepare('SELECT count(*) AS n FROM promo_redemptions WHERE user_id=?').get(paid.id).n, 0);
});

test('99 percent requires payment, no disconnected-provider order or code consumption', () => {
  const { user } = fresh();
  assert.throws(() => redeemFreePromo(user.id, 'PICHU99'), { status: 400 });
  assert.throws(() => createPaymentOrder(user.id, { promoCode: 'PICHU99' }), { status: 503 });
  assert.equal(promoQuote(user.id, 'PICHU99').priceRub, 1.99);
  assert.equal(getSubscriptionAccess(user.id).active, false);
});

test('authenticated promo API ignores forged identity, amount and duration; parallel retries grant once', async () => {
  const { user, telegram } = fresh(), other = fresh().user;
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { authorization: `tma ${makeTelegramInitData(telegram, process.env.TELEGRAM_BOT_TOKEN)}`, 'content-type': 'application/json' };
  try {
    for (const endpoint of ['quote', 'redeem']) assert.equal((await fetch(base + '/api/billing/promo/' + endpoint, { method: 'POST', body: '{}' })).status, 401);
    const results = await Promise.all([1, 2].map(() => fetch(base + '/api/billing/promo/redeem', { method: 'POST', headers, body: JSON.stringify({ code: 'PICHU 100', userId: other.id, expiresAt: '2099-01-01', discountPercent: 99 }) }).then(r => r.json())));
    assert.equal(results[0].expiresAt, results[1].expiresAt);
    assert.equal(results[0].payment.active, true);
    assert.equal(getSubscriptionAccess(other.id).active, false);
    assert.equal(db.prepare('SELECT count(*) AS n FROM promo_redemptions WHERE user_id=?').get(user.id).n, 1);
    const forged = await fetch(base + '/api/billing/promo/redeem', { method: 'POST', headers, body: JSON.stringify({ code: 'PICHU99', discountPercent: 100, amount: 0 }) });
    assert.equal(forged.status, 400);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
