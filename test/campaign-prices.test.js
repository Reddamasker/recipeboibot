import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

const file = path.resolve('data', `campaign-prices-${randomUUID()}.sqlite`);
process.env.DATABASE_PATH = file;
process.env.TELEGRAM_BOT_TOKEN = 'campaign-price-test';
process.env.TELEGRAM_POLLING = 'false';
process.env.TEST_CONTOUR = 'true';
process.env.ROBOKASSA_TEST = 'true';
process.env.ROBOKASSA_RECURRING_ENABLED = 'true';
process.env.ROBOKASSA_MERCHANT_LOGIN = 'campaign-price-shop';
process.env.ROBOKASSA_PASSWORD1 = 'campaign-password-one';
process.env.ROBOKASSA_PASSWORD2 = 'campaign-password-two';
process.env.ROBOKASSA_HASH_ALGORITHM = 'md5';
process.env.PAYMENT_TAX = 'none';

const { db, upsertTelegramUser, allowUser, createRecipe, deleteUserData } = await import('../src/db.js');
const { createCampaign, advertisingRedirect, recordBotStart, funnelReport } = await import('../src/funnel.js');
const { campaignPriceAssignment, campaignPromotion, recordCampaignPriceExposure, DINNER_PRICE_EXPERIMENT } = await import('../src/campaign-prices.js');
const { promoQuote } = await import('../src/promos.js');
const { createPaymentOrder, getBillingOffer, processRobokassaResult, paymentRedirectDocument, runRecurringCycle } = await import('../src/billing.js');
const { startTrial, getSubscriptionAccess } = await import('../src/subscriptions.js');
const { createMockOrder, finishMockOrder, mockPaymentStatus } = await import('../src/contour-sandbox.js');
const campaign = DINNER_PRICE_EXPERIMENT.campaign;
createCampaign(campaign, 'Яндекс ужин'); createCampaign('other');
let serial = 960000000;
const start = new Date('2026-09-20T08:00:00.000Z');
const after = minutes => new Date(start.getTime() + minutes * 60000);
function fresh() { return upsertTelegramUser({ id: ++serial, first_name: 'Проверка цены' }); }
function recruited(variant) {
  for (let i = 0; i < 80; i++) {
    const user = fresh();
    const payload = new URL(advertisingRedirect(campaign)).searchParams.get('start');
    recordBotStart(user, `/start ${payload}`, start); allowUser(user.id);
    const assignment = campaignPriceAssignment(user.id);
    const expected = createHash('sha256').update(`${DINNER_PRICE_EXPERIMENT.key}:${user.id}`).digest()[0] < 128 ? 'A' : 'B';
    assert.equal(assignment.variant, expected);
    if (assignment.variant === variant) return user;
  }
  throw new Error(`Не найден вариант ${variant}`);
}
function firstRecipe(user) {
  const recipe = createRecipe(user.id, { status: 'ready', title: 'Первый ужин' });
  db.prepare('UPDATE recipes SET created_at=? WHERE id=?').run(after(1).toISOString(), recipe.id);
}
function pay(order, at = after(4)) {
  const OutSum = order.priceRub.toFixed(2), InvId = order.invId;
  const SignatureValue = createHash('md5').update(`${OutSum}:${InvId}:campaign-password-two`).digest('hex');
  return processRobokassaResult({ OutSum, InvId, SignatureValue }, at);
}
test.after(() => { db.close(); for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(file + suffix); } catch {} } });

test('campaign assignment is immutable and only new attributed users receive it', () => {
  const a = recruited('A'), b = recruited('B');
  assert.equal(campaignPromotion(a.id), null);
  assert.equal(campaignPromotion(b.id).priceRub, 159);
  assert.throws(() => promoQuote(a.id, 'UZHIN159'), { status: 403 });
  const previous = campaignPriceAssignment(b.id);
  const later = new URL(advertisingRedirect('other')).searchParams.get('start');
  recordBotStart({ ...b, is_allowed: 1 }, `/start ${later}`, after(1));
  assert.deepEqual(campaignPriceAssignment(b.id), previous);
  const returning = fresh(); allowUser(returning.id);
  recordBotStart({ ...returning, is_allowed: 1 }, `/start ${new URL(advertisingRedirect(campaign)).searchParams.get('start')}`, start);
  assert.equal(campaignPriceAssignment(returning.id), null);
  const organic = fresh(); recordBotStart(organic, '/start', start);
  assert.equal(campaignPriceAssignment(organic.id), null);
  assert.throws(() => createPaymentOrder(organic.id, { promoCode: 'UZHIN159', priceRub: 159 }), { status: 403 });
  assert.equal(recordCampaignPriceExposure(organic.id), false);
  deleteUserData(b.id);
  assert.equal(db.prepare('SELECT 1 FROM campaign_price_assignments WHERE user_id=?').get(b.id), undefined);
});

test('promo bills exactly 159 rubles once, forbids other terms and auto renewal, and leaves catalog prices unchanged', () => {
  const user = recruited('B'); firstRecipe(user); startTrial(user.id, after(2));
  const offer = getBillingOffer(user.id, after(3));
  assert.equal(offer.offer.priceRub, 199);
  assert.equal(offer.plans.find(plan => plan.months === 3).priceRub, 499);
  assert.equal(offer.campaignPromotion.priceRub, 159);
  assert.equal(promoQuote(user.id, ' uzhin 159 ').discountRub, 40);
  assert.throws(() => createPaymentOrder(user.id, { promoCode: 'UZHIN159', periodMonths: 12 }), { status: 400 });
  assert.throws(() => createPaymentOrder(user.id, { promoCode: 'UZHIN159', autoRenew: true }), { status: 400 });
  const order = createPaymentOrder(user.id, { promoCode: 'UZHIN159', amount: 1, priceRub: 1 }, after(3));
  assert.equal(order.priceRub, 159); assert.equal(order.periodMonths, 1); assert.equal(order.autoRenew, false);
  assert.equal(db.prepare('SELECT amount_kopeks,experiment_key FROM payment_orders WHERE id=?').get(order.id).amount_kopeks, 15900);
  assert.equal(db.prepare('SELECT experiment_key FROM payment_orders WHERE id=?').get(order.id).experiment_key, DINNER_PRICE_EXPERIMENT.key);
  const document = paymentRedirectDocument(order.id, after(3));
  assert.match(document, /value="159\.00"/);
  const receipt = JSON.parse(decodeURIComponent(document.match(/name="Receipt" value="([^"]+)"/)[1]));
  assert.equal(receipt.items[0].sum, 159);
  assert.equal(createPaymentOrder(user.id, { promoCode: 'uzhin159' }, after(3)).id, order.id);
  const before = getSubscriptionAccess(user.id, after(3)).expiresAt;
  assert.equal(pay(order), `OK${order.invId}`); assert.equal(pay(order), `OK${order.invId}`);
  assert.notEqual(getSubscriptionAccess(user.id, after(4)).expiresAt, before);
  assert.equal(getSubscriptionAccess(user.id, after(4)).expiresAt, '2026-10-27T08:02:00.000Z');
  assert.throws(() => promoQuote(user.id, 'UZHIN159'), { status: 409 });
  assert.equal(getBillingOffer(user.id, after(5)).campaignPromotion, null);
  assert.equal(db.prepare('SELECT * FROM payment_recurring WHERE user_id=?').get(user.id), undefined);
  const next = createPaymentOrder(user.id, {}, after(5)); assert.equal(next.priceRub, 199);
});

test('three month purchase and renewal are 499 for A and B, first regular purchase ends promo eligibility', async () => {
  for (const variant of ['A', 'B']) {
    const user = recruited(variant); firstRecipe(user); startTrial(user.id, after(2));
    const order = createPaymentOrder(user.id, { periodMonths: 3, autoRenew: true }, after(3));
    assert.equal(order.priceRub, 499); assert.equal(order.periodMonths, 3);
    assert.equal(getBillingOffer(user.id, after(3)).pendingOrder.periodMonths, 3);
    pay(order);
    assert.equal(getSubscriptionAccess(user.id, after(4)).expiresAt, '2026-12-27T08:02:00.000Z');
    const renewal = db.prepare('SELECT amount_kopeks,period_months FROM payment_recurring WHERE user_id=?').get(user.id);
    assert.deepEqual({ ...renewal }, { amount_kopeks: 49900, period_months: 3 });
    assert.equal(campaignPromotion(user.id), null);
    assert.throws(() => promoQuote(user.id, 'UZHIN159'), { status: 403 });
  }
  await runRecurringCycle(new Date('2026-12-28T08:00:00.000Z'), async (_url, request) => {
    assert.equal(request.body.get('OutSum'), '499.00');
    return { ok: true, text: async () => `OK+${request.body.get('InvoiceID')}` };
  });
  const children = db.prepare("SELECT experiment_key,amount_kopeks,period_months FROM payment_orders WHERE kind='recurring'").all();
  assert.equal(children.length, 2);
  for (const child of children) {
    assert.equal(child.experiment_key, DINNER_PRICE_EXPERIMENT.key);
    assert.equal(child.amount_kopeks, 49900); assert.equal(child.period_months, 3);
  }
});

test('mock checkout agrees with real quote and cannot turn test payments into experiment revenue', () => {
  const user = recruited('B'); firstRecipe(user);
  assert.equal(mockPaymentStatus(user.id).campaignPromotion.priceRub, 159);
  const order = createMockOrder(user.id, 'card', false, 'UZHIN159');
  assert.equal(order.priceRub, 159); assert.equal(order.periodMonths, 1);
  assert.equal(createMockOrder(user.id, 'card', false, 'UZHIN159').id, order.id);
  const before = funnelReport(campaign).priceExperiment.rows.find(row => row.variant === 'B');
  finishMockOrder(user.id, order.id, 'success');
  assert.equal(campaignPromotion(user.id), null);
  const afterRow = funnelReport(campaign).priceExperiment.rows.find(row => row.variant === 'B');
  assert.equal(afterRow.paid, before.paid); assert.equal(afterRow.revenueRub, before.revenueRub);
});
test('three months with the campaign code bills 399, extends by three months and consumes the shared code once', () => {
  const user = recruited('B'); firstRecipe(user); startTrial(user.id, after(2));
  const quote = promoQuote(user.id, 'UZHIN159', 3);
  assert.equal(quote.priceRub, 399); assert.equal(quote.basePriceRub, 499); assert.equal(quote.discountRub, 100);
  assert.equal(campaignPromotion(user.id).plans.find(plan => plan.months === 3).priceRub, 399);
  assert.throws(() => promoQuote(recruited('A').id, 'UZHIN159', 3), { status: 403 });
  assert.throws(() => createPaymentOrder(user.id, { promoCode: 'UZHIN159', periodMonths: 3, autoRenew: true }), { status: 400 });
  const order = createPaymentOrder(user.id, { promoCode: 'UZHIN159', periodMonths: 3, priceRub: 1 }, after(3));
  assert.equal(order.priceRub, 399); assert.equal(order.periodMonths, 3);
  assert.equal(createPaymentOrder(user.id, { promoCode: 'UZHIN159', periodMonths: 3 }, after(3)).id, order.id);
  assert.throws(() => createPaymentOrder(user.id, { promoCode: 'UZHIN159', periodMonths: 1 }, after(3)), { status: 409 });
  const document = paymentRedirectDocument(order.id, after(3));
  assert.match(document, /value="399\.00"/);
  const receipt = JSON.parse(decodeURIComponent(document.match(/name="Receipt" value="([^"]+)"/)[1]));
  assert.equal(receipt.items[0].sum, 399);
  pay(order); pay(order);
  assert.equal(getSubscriptionAccess(user.id, after(4)).expiresAt, '2026-12-27T08:02:00.000Z');
  assert.equal(db.prepare('SELECT * FROM payment_recurring WHERE user_id=?').get(user.id), undefined);
  assert.throws(() => promoQuote(user.id, 'UZHIN159', 1), { status: 409 });
  db.prepare('UPDATE payment_orders SET is_test=0 WHERE id=?').run(order.id);
  const row = funnelReport(campaign).priceExperiment.rows.find(row => row.variant === 'B');
  assert.ok(row.threeMonthsPaid >= 1 && row.promoPaid >= 1 && row.revenueRub >= 399);
  const mockUser = recruited('B'); firstRecipe(mockUser);
  const mock = createMockOrder(mockUser.id, 'card', false, 'UZHIN159', 3);
  assert.equal(mock.priceRub, 399); assert.equal(mock.periodMonths, 3);
  finishMockOrder(mockUser.id, mock.id, 'success');
  const now = new Date(); now.setUTCMonth(now.getUTCMonth() + 3);
  assert.ok(Math.abs(Date.parse(getSubscriptionAccess(mockUser.id).expiresAt) - now.getTime()) < 5000);
});

test('experiment revenue and mature trial conversion use real payments, periods, unique users and exposure', () => {
  const user = recruited('B'); firstRecipe(user); startTrial(user.id, after(2));
  assert.equal(recordCampaignPriceExposure(user.id, after(3)), true);
  assert.equal(recordCampaignPriceExposure(user.id, after(4)), false);
  const initial = funnelReport(campaign).priceExperiment.rows.find(row => row.variant === 'B');
  const order = createPaymentOrder(user.id, { promoCode: 'UZHIN159' }, after(3)); pay(order);
  assert.equal(funnelReport(campaign).priceExperiment.rows.find(row => row.variant === 'B').revenueRub, initial.revenueRub);
  db.prepare('UPDATE payment_orders SET is_test=0 WHERE id=?').run(order.id);
  const report = funnelReport(campaign).priceExperiment.rows.find(row => row.variant === 'B');
  assert.equal(report.paid, initial.paid + 1); assert.equal(report.promoPaid, initial.promoPaid + 1);
  assert.equal(report.monthlyPaid, initial.monthlyPaid + 1); assert.equal(report.threeMonthsPaid, initial.threeMonthsPaid);
  assert.equal(report.revenueRub, initial.revenueRub + 159);
  assert.equal(report.maturedPaid, initial.maturedPaid + 1);
  assert.equal(report.revenuePerUserRub, Number((report.revenueRub / report.starts).toFixed(2)));
  assert.equal(funnelReport('other').priceExperiment, null);
});
