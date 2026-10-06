import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, generateKeyPairSync, sign } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

process.env.DATABASE_PATH = path.resolve('data', 'max-billing-' + process.pid + '.sqlite');
Object.assign(process.env, {
  BOT_PLATFORM: 'max', MAX_BOT_TOKEN: 'max-billing-token', MAX_BOT_USERNAME: 'max_test_bot',
  TELEGRAM_POLLING: 'false', TEST_CONTOUR: 'false', ROBOKASSA_TEST: 'false',
  ROBOKASSA_MERCHANT_LOGIN: 'max-billing-shop', ROBOKASSA_PASSWORD1: 'max-password-one', ROBOKASSA_PASSWORD2: 'max-password-two',
  ROBOKASSA_HASH_ALGORITHM: 'md5', ROBOKASSA_RECURRING_ENABLED: 'true', PAYMENT_TAX: 'none',
  APP_URL: 'https://max-billing.example.test', PAYMENT_PRICE_VARIANTS: '199', PAYMENT_EXPERIMENT_KEY: 'max-billing-v1'
});
const { db, upsertTelegramUser, allowUser, createRecipe } = await import('../src/db.js');
const { createPaymentOrder, getPaymentOrder, getBillingOffer, paymentRedirectDocument, paymentReturnDocument, processRobokassaResult, processRobokassaResultJws, runRecurringCycle, cancelAutoRenew } = await import('../src/billing.js');
const { MAX_INVOICE_FLOOR } = await import('../src/payment-routing.js');
const { getSubscriptionAccess } = await import('../src/subscriptions.js');
const { createServer } = await import('../src/server.js');
const { paymentConsentDocuments } = await import('../src/payment-consent.js');
const at = new Date('2026-10-06T12:00:00Z');
let nextUser = 910000001;
function buyer(max = true) {
  const user = upsertTelegramUser({ id: (max ? 'max:' : '') + nextUser++, first_name: 'Покупатель' });
  createRecipe(user.id, { title: 'Каша', status: 'ready', ingredients: [{ name: 'овсянка' }], steps: [{ text: 'Сварить.' }] });
  return user;
}
const digest = (value) => createHash('md5').update(value).digest('hex');
function callbackParams(order, contour = 'max', overrides = {}) {
  const params = { OutSum: order.priceRub.toFixed(2), InvId: String(order.invId), ...(contour === undefined ? {} : { Shp_contour: contour }), ...overrides };
  const shp = Object.entries(params).filter(([key]) => key.startsWith('Shp_')).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => key + '=' + value);
  params.SignatureValue = digest([params.OutSum, params.InvId, process.env.ROBOKASSA_PASSWORD2, ...shp].join(':'));
  return params;
}
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
function jws(order, overrides = {}) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ header: { type: 'PaymentStateNotification', version: '1.0.0' }, data: { shop: process.env.ROBOKASSA_MERCHANT_LOGIN, invId: String(order.invId), incSum: order.priceRub.toFixed(2), state: 'OK', ...overrides } })).toString('base64url');
  return header + '.' + payload + '.' + sign('RSA-SHA256', Buffer.from(header + '.' + payload), keys.privateKey).toString('base64url');
}
function auth(id) {
  const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id, first_name: 'Покупатель' }) });
  const secret = createHmac('sha256', 'WebAppData').update(process.env.MAX_BOT_TOKEN).digest();
  const check = [...params].sort(([a], [b]) => a < b ? -1 : 1).map(([key, value]) => key + '=' + value).join('\n');
  params.set('hash', createHmac('sha256', secret).update(check).digest('hex'));
  return { authorization: 'mxa ' + params, 'content-type': 'application/json' };
}

test('MAX namespace starts at reserved boundary, survives module restart and signs native checkout', () => {
  const user = buyer();
  const order = createPaymentOrder(user.id, { periodMonths: 3 }, at);
  assert.equal(order.invId, MAX_INVOICE_FLOOR);
  const restart = spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./src/billing.js'); const {db}=await import('./src/db.js'); console.log(db.prepare(\"SELECT seq FROM sqlite_sequence WHERE name='payment_orders'\").get().seq); db.close();"], { encoding: 'utf8', env: process.env });
  assert.equal(restart.status, 0, restart.stderr);
  assert.equal(Number(restart.stdout.trim()), order.invId);
  const fields = Object.fromEntries([...paymentRedirectDocument(order.id, at).matchAll(/name="([^"]+)" value="([^"]*)"/g)].map((m) => [m[1], m[2].replaceAll('&amp;', '&')]));
  assert.equal(fields.Shp_contour, 'max');
  assert.equal(fields.InvId, String(MAX_INVOICE_FLOOR));
  assert.equal(fields.SignatureValue, digest([fields.MerchantLogin, fields.OutSum, fields.InvId, fields.Receipt, fields.ResultUrl2, fields.SuccessUrl2, fields.SuccessUrl2Method, fields.FailUrl2, fields.FailUrl2Method, process.env.ROBOKASSA_PASSWORD1, 'Shp_contour=max'].join(':')));
  assert.equal(fields.IsTest, undefined);
  const returnHtml = paymentReturnDocument('success', order.id);
  const returnUrl = new URL(returnHtml.match(/href="([^"]+)"/)[1]);
  assert.equal(returnUrl.origin, 'https://max.ru');
  assert.equal(returnUrl.pathname, '/max_test_bot');
  assert.deepEqual(JSON.parse(Buffer.from(returnUrl.searchParams.get('startapp'), 'base64url')), { view: 'payment-result', order: order.id });
  assert.doesNotMatch(returnHtml, /t\.me\//);
  assert.equal(getSubscriptionAccess(user.id, at).active, false, 'return page alone cannot grant access');
});

test('signed MAX callback rejects wrong or missing contour, tampering, amounts and Telegram IDs without crediting', () => {
  const user = buyer(); const telegram = buyer(false);
  const order = createPaymentOrder(user.id, {}, at);
  for (const contour of ['production', 'test', null]) {
    const params = callbackParams(order, contour);
    if (contour === null) { delete params.Shp_contour; params.SignatureValue = digest(params.OutSum + ':' + params.InvId + ':' + process.env.ROBOKASSA_PASSWORD2); }
    assert.throws(() => processRobokassaResult(params, at), { status: 400 });
  }
  assert.throws(() => processRobokassaResult({ ...callbackParams(order), Shp_contour: 'production' }, at), /подпись/);
  assert.throws(() => processRobokassaResult(callbackParams(order, 'max', { OutSum: '1.00' }), at), /сумма/);
  assert.throws(() => processRobokassaResult(callbackParams(order, 'max', { InvId: '1' }), at), /контуру/);
  assert.equal(getPaymentOrder(user.id, order.id).status, 'pending');
  assert.equal(getSubscriptionAccess(user.id, at).active, false);
  assert.equal(getSubscriptionAccess(telegram.id, at).active, false);
  assert.equal(processRobokassaResult(callbackParams(order), at), 'OK' + order.invId);
  const expiry = getSubscriptionAccess(user.id, at).expiresAt;
  assert.equal(processRobokassaResult(callbackParams(order), at), 'OK' + order.invId);
  assert.equal(getSubscriptionAccess(user.id, at).expiresAt, expiry);
  assert.equal(getSubscriptionAccess(telegram.id, at).active, false);
});

test('discounted MAX order shares namespace, reserves once and only confirmed payment consumes promo', () => {
  const user = buyer();
  const order = createPaymentOrder(user.id, { promoCode: 'PICHU99' }, at);
  assert.ok(order.invId >= MAX_INVOICE_FLOOR);
  assert.equal(order.priceRub, 1.99);
  assert.equal(createPaymentOrder(user.id, { promoCode: 'PICHU99' }, at).id, order.id);
  assert.equal(db.prepare('SELECT redeemed_at FROM promo_redemptions WHERE user_id=?').get(user.id).redeemed_at, null);
  processRobokassaResult(callbackParams(order), at);
  assert.equal(db.prepare('SELECT redeemed_at FROM promo_redemptions WHERE user_id=?').get(user.id).redeemed_at, at.toISOString());
  assert.equal(getBillingOffer(user.id, at).recurring.enabled, false);
  const failHtml = paymentReturnDocument('fail', 'https://attacker.invalid');
  const url = new URL(failHtml.match(/href="([^"]+)"/)[1]);
  assert.deepEqual(JSON.parse(Buffer.from(url.searchParams.get('startapp'), 'base64url')), { view: 'payment-result' });
});

test('MAX JWS checks certificate, shop, amount and namespace before granting once', () => {
  const user = buyer(); const order = createPaymentOrder(user.id, { periodMonths: 12 }, at);
  for (const overrides of [{ shop: 'another' }, { invId: '1' }, { incSum: '0.01' }]) assert.throws(() => processRobokassaResultJws(jws(order, overrides), at, keys.publicKey), { status: 400 });
  const token = jws(order); const bad = token.slice(0, -10) + 'AAAAAAAAAA';
  assert.throws(() => processRobokassaResultJws(bad, at, keys.publicKey), { status: 400 });
  assert.equal(getSubscriptionAccess(user.id, at).active, false);
  assert.equal(processRobokassaResultJws(token, at, keys.publicKey), 'OK' + order.invId);
  assert.equal(processRobokassaResultJws(token, at, keys.publicKey), 'OK' + order.invId);
  assert.equal(getSubscriptionAccess(user.id, at).expiresAt, '2027-10-06T12:00:00.000Z');
});

test('MAX recurring child uses reserved namespace and only its paid, consented MAX parent; cancellation persists', async () => {
  const user = buyer();
  assert.throws(() => createPaymentOrder(user.id, { autoRenew: true }, at), { status: 400 });
  const parent = createPaymentOrder(user.id, { autoRenew: true, consentVersion: '2026-10-03-v1' }, at);
  processRobokassaResult(callbackParams(parent), at);
  const dueAt = new Date(db.prepare('SELECT next_charge_at FROM payment_recurring WHERE user_id=?').get(user.id).next_charge_at);
  let child;
  await runRecurringCycle(dueAt, async (_url, options) => {
    const fields = options.body;
    assert.equal(fields.get('Shp_contour'), 'max');
    assert.equal(Number(fields.get('PreviousInvoiceID')), parent.invId);
    assert.ok(Number(fields.get('InvoiceID')) >= MAX_INVOICE_FLOOR);
    const row = db.prepare('SELECT id FROM payment_orders WHERE inv_id=?').get(Number(fields.get('InvoiceID')));
    child = getPaymentOrder(user.id, row.id);
    assert.equal(processRobokassaResult(callbackParams(child), dueAt), 'OK' + child.invId);
    return new Response('OK+' + child.invId);
  });
  assert.equal(child.status, 'pending');
  assert.equal(getPaymentOrder(user.id, child.id).status, 'paid');
  cancelAutoRenew(user.id, dueAt);
  processRobokassaResult(callbackParams(parent), dueAt);
  assert.equal(getBillingOffer(user.id, dueAt).recurring.enabled, false);
});

test('authenticated MAX checkout and real HTTP signed callback activate owner without Telegram auth', async () => {
  const id = nextUser++; const user = upsertTelegramUser({ id: 'max:' + id, first_name: 'HTTP' });
  createRecipe(user.id, { title: 'Суп', status: 'ready', ingredients: [{ name: 'вода' }], steps: [{ text: 'Вскипятить.' }] });
  allowUser(user.id);
  const other = upsertTelegramUser({ id: 'max:' + (id + 1), first_name: 'Другой' }); allowUser(other.id);
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    for (const name of ['offer', 'privacy']) {
      const legal = await fetch(base + '/' + name + '.html');
      assert.equal(legal.status, 200);
      const content = await legal.text();
      assert.equal(content, paymentConsentDocuments[name].content);
      assert.equal(createHash('sha256').update(content).digest('hex'), paymentConsentDocuments[name].sha256);
      assert.doesNotMatch(content, /Оплата в MAX пока не подключена/);
    }
    const result = await fetch(base + '/api/billing/orders', { method: 'POST', headers: auth(id), body: '{}' });
    assert.equal(result.status, 201); const order = await result.json();
    assert.ok(order.invId >= MAX_INVOICE_FLOOR);
    const denied = await fetch(base + '/api/billing/orders/' + order.id, { headers: auth(id + 1) });
    assert.equal(denied.status, 404);
    const callback = await fetch(base + '/api/payments/robokassa/result', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(callbackParams(order)) });
    assert.equal(callback.status, 200); assert.equal(await callback.text(), 'OK' + order.invId);
    assert.equal(getSubscriptionAccess(user.id).active, true);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('namespace exhaustion rejects allocation and Telegram startup cannot reuse MAX database', () => {
  const sequence = Number(db.prepare("SELECT seq FROM sqlite_sequence WHERE name='payment_orders'").get().seq);
  db.prepare("UPDATE sqlite_sequence SET seq=? WHERE name='payment_orders'").run(Number.MAX_SAFE_INTEGER);
  try { assert.throws(() => createPaymentOrder(buyer().id, {}, at), /контуру/); }
  finally { db.prepare("UPDATE sqlite_sequence SET seq=? WHERE name='payment_orders'").run(sequence); }
  const telegram = spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./src/billing.js')"], { encoding: 'utf8', env: { ...process.env, BOT_PLATFORM: 'telegram' } });
  assert.notEqual(telegram.status, 0);
  assert.match(telegram.stderr, /другому платёжному контуру/);
});

test.after(() => { db.close(); for (const suffix of ['', '-wal', '-shm']) fs.rmSync(process.env.DATABASE_PATH + suffix, { force: true }); });
