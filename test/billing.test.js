import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

process.env.DATABASE_PATH = path.resolve('data', `billing-${process.pid}.sqlite`);
process.env.TELEGRAM_BOT_TOKEN = '123456:billing-test-secret';
process.env.TELEGRAM_POLLING = 'false';
process.env.TEST_CONTOUR = 'true';
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
  processRobokassaResultJws,
  recordBillingExposure,
  runRecurringCycle
} = await import('../src/billing.js');
const { getSubscriptionAccess, startTrial } = await import('../src/subscriptions.js');
const { promoQuote, redeemFreePromo } = await import('../src/promos.js');
const { createServer } = await import('../src/server.js');
const { makeTelegramInitData } = await import('../src/security.js');

const user = upsertTelegramUser({ id: 600000001, first_name: 'Покупатель' });
createRecipe(user.id, {
  title: 'Тестовый суп', status: 'ready', servings: 2,
  ingredients: [{ name: 'вода', amount: 1, unit: 'л' }],
  steps: [{ text: 'Сварить.' }]
});

const digest = (value) => createHash('md5').update(value).digest('hex');
const jwsKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const compactJws = (order, overrides = {}) => {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    header: { type: 'PaymentStateNotification', version: '1.0.0', timestamp: '2026-09-29T12:00:00Z' },
    data: {
      shop: process.env.ROBOKASSA_MERCHANT_LOGIN,
      opKey: 'test-operation-key',
      invId: String(order.invId),
      paymentMethod: 'BankCard',
      incSum: Number(order.priceRub).toFixed(2),
      state: 'OK',
      ...overrides
    }
  })).toString('base64url');
  const signature = sign('RSA-SHA256', Buffer.from(`${header}.${payload}`, 'ascii'), jwsKeys.privateKey).toString('base64url');
  return `${header}.${payload}.${signature}`;
};
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

test('recurring consent rejects missing/stale versions and preserves evidence after cancellation and late callback', () => {
  const account = upsertTelegramUser({ id: 600000099, first_name: 'Consent' });
  const at = new Date('2026-10-03T12:00:00Z');
  startTrial(account.id, at);
  for (const consentVersion of [undefined, 'old']) assert.throws(() => createPaymentOrder(account.id, { autoRenew: true, consentVersion }, at), { status: 400 });
  const order = createPaymentOrder(account.id, { autoRenew: true, consentVersion: '2026-10-03-v1', periodMonths: 3 }, at);
  createPaymentOrder(account.id, { autoRenew: true, consentVersion: '2026-10-03-v1', periodMonths: 3 }, at);
  const evidence = db.prepare('SELECT * FROM payment_consent_history WHERE user_id=? ORDER BY rowid').all(account.id);
  assert.equal(evidence.length, 2);
  assert.equal(evidence[0].amount_kopeks, 49900);
  assert.equal(evidence[0].period_months, 3);
  assert.match(evidence[0].consent_text, /обработку персональных данных/);
  assert.match(evidence[0].terms_text, /24 часа/);
  assert.match(JSON.parse(evidence[0].documents_json).offer.sha256, /^[a-f0-9]{64}$/);
  assert.match(JSON.parse(evidence[0].documents_json).offer.content, /auto-renew/);
  cancelAutoRenew(account.id, at);
  callback(order, new Date('2026-10-03T12:01:00Z'));
  assert.equal(getBillingOffer(account.id, at).recurring.enabled, false);
  assert.equal(getSubscriptionAccess(account.id, at).active, true);
  assert.equal(db.prepare('SELECT action FROM payment_consent_history WHERE user_id=? ORDER BY rowid DESC').get(account.id).action, 'revoked');
  assert.deepEqual(db.prepare('SELECT * FROM payment_consent_history WHERE user_id=? ORDER BY rowid LIMIT 2').all(account.id), evidence);
});

test('99 percent order charges 1.99, signs the discounted receipt, reserves once and grants only after callback', () => {
  const promoUser = upsertTelegramUser({ id: 600000088, first_name: 'Promo' });
  const at = new Date();
  const trial = startTrial(promoUser.id, at);
  const normal = createPaymentOrder(promoUser.id, {}, at);
  const order = createPaymentOrder(promoUser.id, { promoCode: 'PICHU99', amount: 0 }, at);
  assert.notEqual(order.id, normal.id);
  assert.equal(order.priceRub, 1.99);
  assert.equal(order.autoRenew, false);
  assert.equal(order.promoCode, 'PICHU99');
  assert.equal(createPaymentOrder(promoUser.id, { promoCode: 'pichu99' }, at).id, order.id);
  assert.equal(createPaymentOrder(promoUser.id, {}, at).id, normal.id);
  assert.throws(() => createPaymentOrder(promoUser.id, { promoCode: 'PICHU99', autoRenew: true, consentVersion: '2026-10-03-v1' }, at), { status: 400 });
  const document = paymentRedirectDocument(order.id, at);
  assert.match(document, /name="OutSum" value="1.99"/);
  const receipt = JSON.parse(decodeURIComponent(document.match(/name="Receipt" value="([^"]+)"/)[1]));
  assert.equal(receipt.items[0].sum, 1.99);
  assert.equal(getSubscriptionAccess(promoUser.id, at).expiresAt, trial.expiresAt);
  assert.throws(() => callback(order, at, { OutSum: '0.00', SignatureValue: digest(`0.00:${order.invId}:${process.env.ROBOKASSA_PASSWORD2}`) }), { status: 400 });
  callback(order, at);
  const expiry = getSubscriptionAccess(promoUser.id, at).expiresAt;
  assert.ok(Date.parse(expiry) > Date.parse(trial.expiresAt));
  callback(order, at);
  assert.equal(getSubscriptionAccess(promoUser.id, at).expiresAt, expiry);
  assert.throws(() => promoQuote(promoUser.id, 'PICHU99'), { status: 409 });
  assert.throws(() => createPaymentOrder(promoUser.id, { promoCode: 'PICHU99' }, at), { status: 409 });
});

test('free month postpones an existing renewal without changing its amount or enabling new charges', () => {
  const account = upsertTelegramUser({ id: 600000087, first_name: 'Renewal promo' });
  const at = new Date();
  startTrial(account.id, at);
  const order = createPaymentOrder(account.id, { autoRenew: true, consentVersion: '2026-10-03-v1' }, at);
  callback(order, at);
  const before = db.prepare('SELECT * FROM payment_recurring WHERE user_id=?').get(account.id);
  const result = redeemFreePromo(account.id, 'PICHU 100', at);
  const after = db.prepare('SELECT * FROM payment_recurring WHERE user_id=?').get(account.id);
  assert.equal(after.enabled, before.enabled);
  assert.equal(after.amount_kopeks, before.amount_kopeks);
  assert.equal(after.next_charge_at, new Date(Date.parse(result.expiresAt) - 86400000).toISOString());
  const discounted = createPaymentOrder(account.id, { promoCode: 'PICHU99' }, at);
  callback(discounted, at);
  const extended = db.prepare('SELECT * FROM payment_recurring WHERE user_id=?').get(account.id);
  assert.equal(extended.amount_kopeks, before.amount_kopeks);
  assert.equal(extended.next_charge_at, new Date(Date.parse(getSubscriptionAccess(account.id, at).expiresAt) - 86400000).toISOString());
});

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
  assert.deepEqual(first.plans.map(({ months, priceRub, discountPercent, savingRub }) => ({ months, priceRub, discountPercent, savingRub })), [
    { months: 1, priceRub: 199, discountPercent: 0, savingRub: 0 },
    { months: 3, priceRub: 499, discountPercent: 16, savingRub: 98 },
    { months: 12, priceRub: 1499, discountPercent: 37, savingRub: 889 }
  ]);
  assert.deepEqual(second.offer, first.offer);
  assert.equal(recordBillingExposure(user.id), true);
  assert.equal(recordBillingExposure(user.id), false);

  const order = createPaymentOrder(user.id, { autoRenew: true, consentVersion: '2026-10-03-v1' }, new Date('2026-09-28T10:05:00.000Z'));
  const duplicate = createPaymentOrder(user.id, { autoRenew: true, consentVersion: '2026-10-03-v1' }, new Date('2026-09-28T10:10:00.000Z'));
  assert.equal(duplicate.id, order.id);
  assert.equal(order.autoRenew, true);
  assert.equal(order.paymentUrl, `https://billing.example.test/payment/start/${order.id}`);
  const document = paymentRedirectDocument(order.id, new Date('2026-09-28T10:10:00.000Z'));
  assert.match(document, /action="https:\/\/auth\.robokassa\.ru\/Merchant\/Index\.aspx"/);
  assert.match(document, /name="Recurring" value="true"/);
  assert.match(document, /name="PaymentMethods" value="BankCard"/);
  assert.match(document, /name="Receipt"/);
  assert.match(document, /name="ResultUrl2" value="https:\/\/billing\.example\.test\/api\/payments\/robokassa\/result"/);
  assert.match(document, /name="Shp_contour" value="test"/);
  const fields = Object.fromEntries([...document.matchAll(/name="([^"]+)" value="([^"]*)"/g)].map((match) => [match[1], match[2].replaceAll('&amp;', '&')]));
  assert.equal(fields.SignatureValue, digest([
    process.env.ROBOKASSA_MERCHANT_LOGIN,
    fields.OutSum,
    fields.InvId,
    fields.Receipt,
    fields.ResultUrl2,
    fields.SuccessUrl2,
    fields.SuccessUrl2Method,
    fields.FailUrl2,
    fields.FailUrl2Method,
    process.env.ROBOKASSA_PASSWORD1,
    'Shp_contour=test'
  ].join(':')));
  assert.doesNotMatch(document, /billing-password-(?:one|two)/);
});

test('three-month and annual orders charge discounted prices and grant the purchased period', () => {
  const threeMonthUser = upsertTelegramUser({ id: 600000041, first_name: 'Three months' });
  createRecipe(threeMonthUser.id, { title: 'Запеканка', status: 'ready', ingredients: [{ name: 'картофель' }], steps: [{ text: 'Запечь.' }] });
  const threeAt = new Date('2026-09-29T12:00:00.000Z');
  const three = createPaymentOrder(threeMonthUser.id, { periodMonths: 3 }, threeAt);
  assert.equal(three.priceRub, 499);
  assert.equal(three.periodMonths, 3);
  const threeDocument = paymentRedirectDocument(three.id, threeAt);
  assert.match(threeDocument, /name="OutSum" value="499.00"/);
  assert.match(threeDocument, /на 3 месяца/);
  callback(three, threeAt);
  assert.equal(getSubscriptionAccess(threeMonthUser.id, threeAt).expiresAt, '2026-12-29T12:00:00.000Z');

  const annualUser = upsertTelegramUser({ id: 600000042, first_name: 'Annual' });
  createRecipe(annualUser.id, { title: 'Рагу', status: 'ready', ingredients: [{ name: 'овощи' }], steps: [{ text: 'Потушить.' }] });
  const annualAt = new Date('2026-09-29T13:00:00.000Z');
  const annual = createPaymentOrder(annualUser.id, { periodMonths: 12 }, annualAt);
  assert.equal(annual.priceRub, 1499);
  assert.equal(annual.periodMonths, 12);
  callback(annual, annualAt);
  assert.equal(getSubscriptionAccess(annualUser.id, annualAt).expiresAt, '2027-09-29T13:00:00.000Z');
});

test('signed callback activates exactly one month and duplicate delivery is idempotent', () => {
  const createdAt = new Date('2026-09-28T11:00:00.000Z');
  const order = createPaymentOrder(user.id, { autoRenew: true, consentVersion: '2026-10-03-v1' }, createdAt);
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

test('signed ResultUrl2 JWS activates the order and rejects forged notifications', () => {
  const buyer = upsertTelegramUser({ id: 600000012, first_name: 'JWS buyer' });
  createRecipe(buyer.id, { title: 'Салат', status: 'ready', ingredients: [{ name: 'огурец' }], steps: [{ text: 'Нарезать.' }] });
  const at = new Date('2026-09-29T12:00:00.000Z');
  const order = createPaymentOrder(buyer.id, {}, at);
  const token = compactJws(order);
  assert.equal(processRobokassaResultJws(token, at, jwsKeys.publicKey), `OK${order.invId}`);
  assert.equal(getPaymentOrder(buyer.id, order.id).status, 'paid');
  assert.equal(db.prepare('SELECT provider_method FROM payment_orders WHERE inv_id=?').get(order.invId).provider_method, 'BankCard');
  assert.equal(processRobokassaResultJws(token, at, jwsKeys.publicKey), `OK${order.invId}`);

  const other = upsertTelegramUser({ id: 600000013, first_name: 'Forged JWS' });
  createRecipe(other.id, { title: 'Каша', status: 'ready', ingredients: [{ name: 'крупа' }], steps: [{ text: 'Сварить.' }] });
  const pending = createPaymentOrder(other.id, {}, at);
  // Change a signature byte, not unused padding bits in the last base64url
  // character: A -> B there can decode to the same valid signature.
  const parts = compactJws(pending).split('.');
  const signature = Buffer.from(parts[2], 'base64url');
  signature[0] ^= 1;
  parts[2] = signature.toString('base64url');
  const forged = parts.join('.');
  assert.throws(() => processRobokassaResultJws(forged, at, jwsKeys.publicKey), /подпись/i);
  assert.throws(() => processRobokassaResultJws(compactJws(pending, { shop: 'another-shop' }), at, jwsKeys.publicKey), /уведомление/i);
  assert.equal(getPaymentOrder(other.id, pending.id).status, 'pending');
});

test('payment during trial adds a month after the seven free days without shortening them', () => {
  const trialUser = upsertTelegramUser({ id: 600000009, first_name: 'Trial buyer' });
  const at = new Date('2026-09-29T10:00:00Z');
  startTrial(trialUser.id, at);
  const order = createPaymentOrder(trialUser.id, {}, new Date('2026-09-30T10:00:00Z'));
  callback(order, new Date('2026-09-30T10:00:00Z'));
  const access = getSubscriptionAccess(trialUser.id, new Date('2026-09-30T10:01:00Z'));
  assert.equal(access.source, 'subscription');
  assert.equal(access.expiresAt, '2026-11-06T10:00:00.000Z');
  callback(order, new Date('2026-10-01T10:00:00Z'));
  assert.equal(getSubscriptionAccess(trialUser.id, new Date('2026-10-01T10:01:00Z')).expiresAt, access.expiresAt);
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
    const createResponse = await fetch(`${base}/api/billing/orders`, { method: 'POST', headers, body: JSON.stringify({ autoRenew: true, consentVersion: '2026-10-03-v1' }) });
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
  assert.equal(submitted.body.get('Shp_contour'), 'test');
  assert.equal(submitted.body.get('SignatureValue'), digest([
    process.env.ROBOKASSA_MERCHANT_LOGIN,
    (child.amount_kopeks / 100).toFixed(2),
    child.inv_id,
    submitted.body.get('Receipt'),
    'https://billing.example.test/api/payments/robokassa/result',
    process.env.ROBOKASSA_PASSWORD1,
    'Shp_contour=test'
  ].join(':')));

  const publicChild = getPaymentOrder(user.id, child.id);
  assert.equal(callback(publicChild, new Date('2026-10-27T12:05:00.000Z')), `OK${child.inv_id}`);
  assert.equal(getSubscriptionAccess(user.id, new Date('2026-10-27T12:05:00.000Z')).expiresAt, '2026-11-28T11:00:00.000Z');
  assert.equal(cancelAutoRenew(user.id).enabled, false);
  assert.equal(getBillingOffer(user.id).recurring.nextChargeAt, null);
});

test('recurring callbacks during submission preserve the paid period even after a transport error', async () => {
  db.prepare('UPDATE payment_recurring SET next_charge_at=NULL').run();
  const at = new Date('2026-11-01T12:00:00Z');
  for (const fails of [false, true]) {
    const account = upsertTelegramUser({ id: fails ? 600000102 : 600000101, first_name: 'Fast callback' });
    startTrial(account.id, at);
    const parent = createPaymentOrder(account.id, { autoRenew: true, consentVersion: '2026-10-03-v1' }, at);
    callback(parent, at);
    const due = new Date(db.prepare('SELECT next_charge_at FROM payment_recurring WHERE user_id=?').get(account.id).next_charge_at);
    await runRecurringCycle(due, async (_, options) => {
      const child = db.prepare('SELECT id FROM payment_orders WHERE inv_id=?').get(Number(options.body.get('InvoiceID')));
      callback(getPaymentOrder(account.id, child.id), due);
      if (fails) throw new Error('response lost after payment');
      return { ok: true, status: 200, text: async () => `OK+${options.body.get('InvoiceID')}` };
    });
    const renewal = getBillingOffer(account.id, due).recurring;
    assert.equal(renewal.nextChargeAt, new Date(Date.parse(getSubscriptionAccess(account.id, due).expiresAt) - 86400000).toISOString());
    assert.equal(db.prepare("SELECT status FROM payment_orders WHERE user_id=? AND kind='recurring'").get(account.id).status, 'paid');
    cancelAutoRenew(account.id, due);
  }
});

test('cancellation during recurring submission leaves no next charge after a late paid callback', async () => {
  const account = upsertTelegramUser({ id: 600000103, first_name: 'Cancel pending' });
  const at = new Date('2026-11-01T12:00:00Z');
  startTrial(account.id, at);
  callback(createPaymentOrder(account.id, { autoRenew: true, consentVersion: '2026-10-03-v1' }, at), at);
  const due = new Date(db.prepare('SELECT next_charge_at FROM payment_recurring WHERE user_id=?').get(account.id).next_charge_at);
  await runRecurringCycle(due, async (_, options) => {
    cancelAutoRenew(account.id, due);
    const child = db.prepare('SELECT id FROM payment_orders WHERE inv_id=?').get(Number(options.body.get('InvoiceID')));
    callback(getPaymentOrder(account.id, child.id), due);
    return { ok: true, status: 200, text: async () => `OK+${options.body.get('InvoiceID')}` };
  });
  assert.equal(getBillingOffer(account.id, due).recurring.enabled, false);
  assert.equal(getBillingOffer(account.id, due).recurring.nextChargeAt, null);
});

test('recurring skips parents with unknown or other payment mode and missing consent', async () => {
  const at = new Date('2026-11-01T12:00:00Z');
  for (const [index, mode] of [null, 0, 1].entries()) {
    const account = upsertTelegramUser({ id: 600000104 + index, first_name: 'Parent guard' });
    startTrial(account.id, at);
    const parent = createPaymentOrder(account.id, { autoRenew: true, consentVersion: '2026-10-03-v1' }, at);
    callback(parent, at);
    db.prepare('UPDATE payment_orders SET is_test=? WHERE inv_id=?').run(mode, parent.invId);
    if (mode === 1) db.prepare('DELETE FROM payment_consent_history WHERE user_id=?').run(account.id);
    const due = new Date(db.prepare('SELECT next_charge_at FROM payment_recurring WHERE user_id=?').get(account.id).next_charge_at);
    let submissions = 0;
    await runRecurringCycle(due, async () => { submissions++; throw new Error('unexpected charge'); });
    assert.equal(submissions, 0);
    cancelAutoRenew(account.id, due);
  }
});
