import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

process.env.DATABASE_PATH = path.resolve('data', `billing-${process.pid}.sqlite`);
process.env.TELEGRAM_BOT_TOKEN = '123456:billing-test-secret';
process.env.TELEGRAM_POLLING = 'false';
process.env.TEST_CONTOUR = 'true';
process.env.TEST_OWNER_TELEGRAM_ID = '6971956699';
process.env.TEST_BOT_USERNAME = 'recipeboi_test_bot';
process.env.ROBOKASSA_MERCHANT_LOGIN = 'billing-test-shop';
process.env.ROBOKASSA_PASSWORD1 = 'billing-password-one';
process.env.ROBOKASSA_PASSWORD2 = 'billing-password-two';
process.env.ROBOKASSA_HASH_ALGORITHM = 'md5';
process.env.ROBOKASSA_TEST = 'true';
process.env.ROBOKASSA_RECURRING_ENABLED = 'true';
process.env.PAYMENT_TAX = 'none';
process.env.PAYMENT_PRICE_VARIANTS = '129,199';
process.env.PAYMENT_EXPERIMENT_KEY = 'billing-test-v1';
process.env.APP_URL = 'https://billing.example.test';

const { db, upsertTelegramUser, allowUser, createRecipe } = await import('../src/db.js');
const {
  cancelAutoRenew,
  createPaymentOrder,
  getBillingOffer,
  getPaymentOrder,
  paymentRedirectDocument,
  processRobokassaResult,
  recordBillingExposure,
  runRecurringCycle
} = await import('../src/billing.js');
const { getSubscriptionAccess } = await import('../src/subscriptions.js');
const { createServer } = await import('../src/server.js');
const { makeTelegramInitData } = await import('../src/security.js');

const user = upsertTelegramUser({ id: 600000001, first_name: 'Покупатель' });
createRecipe(user.id, {
  title: 'Тестовый суп', status: 'ready', servings: 2,
  ingredients: [{ name: 'вода', amount: 1, unit: 'л' }],
  steps: [{ text: 'Сварить.' }]
});

const digest = (value) => createHash('md5').update(value).digest('hex');
const callback = (order, at, extra = {}) => {
  const outSum = Number(order.priceRub).toFixed(2);
  return processRobokassaResult({
    OutSum: outSum,
    InvId: String(order.invId),
    SignatureValue: digest(`${outSum}:${order.invId}:${process.env.ROBOKASSA_PASSWORD2}`),
    PaymentMethod: 'BankCard',
    ...extra
  }, at);
};

test.after(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DATABASE_PATH + suffix); } catch {}
  }
});

test('price experiment is stable, recorded once, and an initial order is signed without exposing secrets', () => {
  const first = getBillingOffer(user.id, new Date('2026-09-28T10:00:00.000Z'));
  const second = getBillingOffer(user.id, new Date('2026-09-29T10:00:00.000Z'));
  assert.equal(first.available, true);
  assert.equal(first.mode, 'provider');
  assert.ok([129, 199].includes(first.offer.priceRub));
  assert.deepEqual(second.offer, first.offer);
  assert.equal(recordBillingExposure(user.id), true);
  assert.equal(recordBillingExposure(user.id), false);

  const order = createPaymentOrder(user.id, { autoRenew: true }, new Date('2026-09-28T10:05:00.000Z'));
  const duplicate = createPaymentOrder(user.id, { autoRenew: true }, new Date('2026-09-28T10:10:00.000Z'));
  assert.equal(duplicate.id, order.id);
  assert.equal(order.autoRenew, true);
  assert.equal(order.paymentUrl, `https://billing.example.test/payment/start/${order.id}`);
  const document = paymentRedirectDocument(order.id);
  assert.match(document, /action="https:\/\/auth\.robokassa\.ru\/Merchant\/Index\.aspx"/);
  assert.match(document, /name="Recurring" value="true"/);
  assert.match(document, /name="PaymentMethods" value="BankCard"/);
  assert.match(document, /name="Receipt"/);
  assert.match(document, /name="ResultUrl2" value="https:\/\/billing\.example\.test\/api\/payments\/robokassa\/result"/);
  assert.doesNotMatch(document, /billing-password-(?:one|two)/);
});

test('signed callback activates exactly one month and duplicate delivery is idempotent', () => {
  const createdAt = new Date('2026-09-28T11:00:00.000Z');
  const order = createPaymentOrder(user.id, { autoRenew: true }, createdAt);
  assert.equal(callback(order, createdAt), `OK${order.invId}`);
  const access = getSubscriptionAccess(user.id, createdAt);
  assert.equal(access.active, true);
  assert.equal(access.source, 'subscription');
  assert.equal(access.expiresAt, '2026-10-28T11:00:00.000Z');
  assert.equal(getBillingOffer(user.id, createdAt).recurring.enabled, true);

  assert.equal(callback(order, new Date('2026-10-01T11:00:00.000Z')), `OK${order.invId}`);
  assert.equal(getSubscriptionAccess(user.id, createdAt).expiresAt, access.expiresAt);
  assert.equal(db.prepare('SELECT count(*) AS n FROM payment_events WHERE inv_id=?').get(order.invId).n, 1);
});

test('callback rejects a bad signature or amount without granting access', () => {
  const other = upsertTelegramUser({ id: 600000002, first_name: 'Другой' });
  createRecipe(other.id, { title: 'Каша', status: 'ready', ingredients: [{ name: 'крупа' }], steps: [{ text: 'Сварить.' }] });
  const order = createPaymentOrder(other.id, {}, new Date('2026-09-28T12:00:00.000Z'));
  assert.throws(() => processRobokassaResult({ OutSum: order.priceRub.toFixed(2), InvId: order.invId, SignatureValue: 'bad' }), /подпись/i);
  const wrong = (order.priceRub + 1).toFixed(2);
  assert.throws(() => processRobokassaResult({ OutSum: wrong, InvId: order.invId, SignatureValue: digest(`${wrong}:${order.invId}:${process.env.ROBOKASSA_PASSWORD2}`) }), /сумма/i);
  assert.equal(getSubscriptionAccess(other.id).active, false);
  assert.equal(getPaymentOrder(other.id, order.id).status, 'pending');
});

test('authenticated billing API creates an order and the public form callback confirms it', async () => {
  const telegram = { id: 600000003, first_name: 'API' };
  const apiUser = upsertTelegramUser(telegram);
  allowUser(apiUser.id);
  createRecipe(apiUser.id, { title: 'Пирог', status: 'ready', ingredients: [{ name: 'мука' }], steps: [{ text: 'Испечь.' }] });
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = {
    authorization: `tma ${makeTelegramInitData(telegram, process.env.TELEGRAM_BOT_TOKEN)}`,
    'content-type': 'application/json'
  };
  try {
    const offerResponse = await fetch(`${base}/api/billing/offer`, { headers });
    assert.equal(offerResponse.status, 200);
    assert.equal((await offerResponse.json()).mode, 'provider');
    const createResponse = await fetch(`${base}/api/billing/orders`, { method: 'POST', headers, body: JSON.stringify({ autoRenew: true }) });
    assert.equal(createResponse.status, 201);
    const order = await createResponse.json();
    const outSum = order.priceRub.toFixed(2);
    const form = new URLSearchParams({ OutSum: outSum, InvId: String(order.invId), SignatureValue: digest(`${outSum}:${order.invId}:${process.env.ROBOKASSA_PASSWORD2}`) });
    const result = await fetch(`${base}/api/payments/robokassa/result`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form });
    assert.equal(result.status, 200);
    assert.equal(await result.text(), `OK${order.invId}`);
    assert.equal(getPaymentOrder(apiUser.id, order.id).status, 'paid');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('recurring cycle creates a signed child order, callback extends access, and cancellation stops renewal', async () => {
  const recurring = db.prepare('SELECT * FROM payment_recurring WHERE user_id=?').get(user.id);
  assert.ok(recurring?.enabled);
  const dueAt = new Date('2026-10-27T12:00:00.000Z');
  db.prepare('UPDATE payment_recurring SET next_charge_at=? WHERE user_id=?').run(dueAt.toISOString(), user.id);
  let submitted;
  await runRecurringCycle(dueAt, async (url, options) => {
    submitted = { url, body: options.body };
    return { ok: true, status: 200, text: async () => `OK+${options.body.get('InvoiceID')}` };
  });
  assert.equal(submitted.url, 'https://auth.robokassa.ru/Merchant/Recurring');
  const child = db.prepare("SELECT * FROM payment_orders WHERE user_id=? AND kind='recurring' ORDER BY inv_id DESC LIMIT 1").get(user.id);
  assert.equal(submitted.body.get('PreviousInvoiceID'), String(recurring.parent_inv_id));
  assert.equal(submitted.body.get('InvoiceID'), String(child.inv_id));
  assert.equal(submitted.body.get('SignatureValue'), digest([
    process.env.ROBOKASSA_MERCHANT_LOGIN,
    (child.amount_kopeks / 100).toFixed(2),
    child.inv_id,
    submitted.body.get('Receipt'),
    'https://billing.example.test/api/payments/robokassa/result',
    process.env.ROBOKASSA_PASSWORD1
  ].join(':')));

  const publicChild = getPaymentOrder(user.id, child.id);
  assert.equal(callback(publicChild, new Date('2026-10-27T12:05:00.000Z')), `OK${child.inv_id}`);
  assert.equal(getSubscriptionAccess(user.id, new Date('2026-10-27T12:05:00.000Z')).expiresAt, '2026-11-28T11:00:00.000Z');
  assert.equal(cancelAutoRenew(user.id).enabled, false);
  assert.equal(getBillingOffer(user.id).recurring.nextChargeAt, null);
});
