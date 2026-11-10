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
const { startTrial, getSubscriptionAccess, monthsAfter } = await import('../src/subscriptions.js');
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

test('outside-Russia campaign uses the same stable pricing experiment without mixing acquisition cohorts', () => {
  const slug = 'ya-dinner-outside-202610'; createCampaign(slug);
  const user = fresh();
  const payload = new URL(advertisingRedirect(slug)).searchParams.get('start');
  recordBotStart(user, `/start ${payload}`, start); allowUser(user.id);
  const assignment = campaignPriceAssignment(user.id);
  const expected = createHash('sha256').update(`${DINNER_PRICE_EXPERIMENT.key}:${user.id}`).digest()[0] < 128 ? 'A' : 'B';
  assert.equal(assignment.variant, expected); assert.equal(assignment.campaign, slug);
  assert.ok(funnelReport(slug).priceExperiment);
  assert.equal(funnelReport(slug).totals.starts, 1);
  assert.equal(campaignPromotion(user.id)?.priceRub ?? 199, expected === 'B' ? 159 : 199);
  assert.deepEqual(campaignPriceAssignment(user.id), assignment);
});

test('paid promo codes use the selected tariff in provider receipts, callbacks and mock checkout', () => {
  for (const [code, prices] of [['PICHU99', [1.59, 3.19, 5.99]], ['DINNER159', [159, 319, 599]]]) {
    for (const [index, months] of [1, 3, 12].entries()) {
      const user = fresh(), at = after(3);
      const order = createPaymentOrder(user.id, { promoCode: code, periodMonths: months, priceRub: 0 }, at);
      assert.equal(order.priceRub, prices[index]); assert.equal(order.periodMonths, months);
      assert.equal(getSubscriptionAccess(user.id, at).active, false);
      assert.equal(createPaymentOrder(user.id, { promoCode: code, periodMonths: months }, at).id, order.id);
      assert.throws(() => createPaymentOrder(user.id, { promoCode: code, periodMonths: months === 1 ? 12 : 1 }, at), { status: 409 });
      const document = paymentRedirectDocument(order.id, at);
      const receipt = JSON.parse(decodeURIComponent(document.match(/name="Receipt" value="([^"]+)"/)[1]));
      assert.equal(receipt.items[0].sum, prices[index]);
      pay(order, at); pay(order, at);
      assert.equal(getSubscriptionAccess(user.id, at).expiresAt, monthsAfter(at, months));
      for (const term of [1, 3, 12]) assert.throws(() => promoQuote(user.id, code, term), { status: 409 });
      assert.equal(db.prepare('SELECT * FROM payment_recurring WHERE user_id=?').get(user.id), undefined);
      const mockUser = fresh(), mockAt = new Date();
      firstRecipe(mockUser);
      const mock = createMockOrder(mockUser.id, 'card', false, code, months);
      assert.equal(mock.priceRub, prices[index]); assert.equal(mock.periodMonths, months);
      assert.throws(() => createMockOrder(mockUser.id, 'card', false, code, months === 1 ? 12 : 1), { status: 409 });
      finishMockOrder(mockUser.id, mock.id, 'success');
      const expiry = getSubscriptionAccess(mockUser.id).expiresAt;
      assert.ok(Math.abs(Date.parse(expiry) - Date.parse(monthsAfter(mockAt, months))) < 5000);
      finishMockOrder(mockUser.id, mock.id, 'success');
      assert.equal(getSubscriptionAccess(mockUser.id).expiresAt, expiry);
      assert.throws(() => promoQuote(mockUser.id, code, months), { status: 409 });
    }
  }
});

test('campaign assignment is immutable and only new attributed users receive it', () => {
  const a = recruited('A'), b = recruited('B');
  assert.equal(campaignPromotion(a.id), null);
  assert.equal(campaignPromotion(b.id).priceRub, 159);
  assert.equal(promoQuote(a.id, 'DINNER159').priceRub, 159);
  const previous = campaignPriceAssignment(b.id);
  const later = new URL(advertisingRedirect('other')).searchParams.get('start');
  recordBotStart({ ...b, is_allowed: 1 }, `/start ${later}`, after(1));
  assert.deepEqual(campaignPriceAssignment(b.id), previous);
  const returning = fresh(); allowUser(returning.id);
  recordBotStart({ ...returning, is_allowed: 1 }, `/start ${new URL(advertisingRedirect(campaign)).searchParams.get('start')}`, start);
  assert.equal(campaignPriceAssignment(returning.id), null);
  const organic = fresh(); recordBotStart(organic, '/start', start);
  assert.equal(campaignPriceAssignment(organic.id), null);
  assert.equal(createPaymentOrder(organic.id, { promoCode: 'DINNER159', priceRub: 1 }).priceRub, 159);
  assert.equal(promoQuote(returning.id, 'DINNER159', 3).priceRub, 319);
  assert.equal(recordCampaignPriceExposure(organic.id), false);
  deleteUserData(b.id);
  assert.equal(db.prepare('SELECT 1 FROM campaign_price_assignments WHERE user_id=?').get(b.id), undefined);
});

test('promo bills exactly 159 rubles once, forbids unsupported terms and auto renewal, and leaves catalog prices unchanged', () => {
  const user = recruited('B'); firstRecipe(user); startTrial(user.id, after(2));
  const offer = getBillingOffer(user.id, after(3));
  assert.equal(offer.offer.priceRub, 159);
  assert.equal(offer.plans.find(plan => plan.months === 3).priceRub, 319);
  assert.equal(offer.campaignPromotion.priceRub, 159);
  assert.equal(promoQuote(user.id, ' dinner 159 ').discountRub, 0);
  assert.throws(() => createPaymentOrder(user.id, { promoCode: 'DINNER159', periodMonths: 2 }), { status: 400 });
  assert.throws(() => createPaymentOrder(user.id, { promoCode: 'DINNER159', autoRenew: true, consentVersion: '2026-10-03-v1' }), { status: 400 });
  const order = createPaymentOrder(user.id, { promoCode: 'DINNER159', amount: 1, priceRub: 1 }, after(3));
  assert.equal(order.priceRub, 159); assert.equal(order.periodMonths, 1); assert.equal(order.autoRenew, false);
  assert.equal(db.prepare('SELECT amount_kopeks,experiment_key FROM payment_orders WHERE id=?').get(order.id).amount_kopeks, 15900);
  assert.equal(db.prepare('SELECT experiment_key FROM payment_orders WHERE id=?').get(order.id).experiment_key, DINNER_PRICE_EXPERIMENT.key);
  const document = paymentRedirectDocument(order.id, after(3));
  assert.match(document, /value="159\.00"/);
  const receipt = JSON.parse(decodeURIComponent(document.match(/name="Receipt" value="([^"]+)"/)[1]));
  assert.equal(receipt.items[0].sum, 159);
  assert.equal(createPaymentOrder(user.id, { promoCode: 'dinner159' }, after(3)).id, order.id);
  const before = getSubscriptionAccess(user.id, after(3)).expiresAt;
  assert.equal(pay(order), `OK${order.invId}`); assert.equal(pay(order), `OK${order.invId}`);
  assert.notEqual(getSubscriptionAccess(user.id, after(4)).expiresAt, before);
  assert.equal(getSubscriptionAccess(user.id, after(4)).expiresAt, '2026-10-27T08:02:00.000Z');
  assert.throws(() => promoQuote(user.id, 'DINNER159'), { status: 409 });
  assert.equal(getBillingOffer(user.id, after(5)).campaignPromotion, null);
  assert.equal(db.prepare('SELECT * FROM payment_recurring WHERE user_id=?').get(user.id), undefined);
  const next = createPaymentOrder(user.id, {}, after(5)); assert.equal(next.priceRub, 159);
});

test('regular three-month purchase and renewal stay 319 and do not prevent entering an unused promo', async () => {
  for (const variant of ['A', 'B']) {
    const user = recruited(variant); firstRecipe(user); startTrial(user.id, after(2));
    const order = createPaymentOrder(user.id, { periodMonths: 3, autoRenew: true, consentVersion: '2026-10-03-v1' }, after(3));
    assert.equal(order.priceRub, 319); assert.equal(order.periodMonths, 3);
    assert.equal(getBillingOffer(user.id, after(3)).pendingOrder.periodMonths, 3);
    pay(order);
    assert.equal(getSubscriptionAccess(user.id, after(4)).expiresAt, '2026-12-27T08:02:00.000Z');
    const renewal = db.prepare('SELECT amount_kopeks,period_months FROM payment_recurring WHERE user_id=?').get(user.id);
    assert.deepEqual({ ...renewal }, { amount_kopeks: 31900, period_months: 3 });
    assert.equal(Boolean(campaignPromotion(user.id)), variant === 'B');
    assert.equal(promoQuote(user.id, 'DINNER159').priceRub, 159);
    assert.equal(promoQuote(user.id, 'DINNER159', 3).priceRub, 319);
  }
  await runRecurringCycle(new Date('2026-12-28T08:00:00.000Z'), async (_url, request) => {
    assert.equal(request.body.get('OutSum'), '319.00');
    return { ok: true, text: async () => `OK+${request.body.get('InvoiceID')}` };
  });
  const children = db.prepare("SELECT experiment_key,amount_kopeks,period_months FROM payment_orders WHERE kind='recurring'").all();
  assert.equal(children.length, 2);
  for (const child of children) {
    assert.equal(child.experiment_key, DINNER_PRICE_EXPERIMENT.key);
    assert.equal(child.amount_kopeks, 31900); assert.equal(child.period_months, 3);
  }
});

test('mock checkout agrees with real quote and cannot turn test payments into experiment revenue', () => {
  const user = recruited('B'); firstRecipe(user);
  assert.equal(mockPaymentStatus(user.id).campaignPromotion.priceRub, 159);
  const order = createMockOrder(user.id, 'card', false, 'DINNER159');
  assert.equal(order.priceRub, 159); assert.equal(order.periodMonths, 1);
  assert.equal(createMockOrder(user.id, 'card', false, 'DINNER159').id, order.id);
  const before = funnelReport(campaign).priceExperiment.rows.find(row => row.variant === 'B');
  finishMockOrder(user.id, order.id, 'success');
  assert.equal(campaignPromotion(user.id), null);
  const afterRow = funnelReport(campaign).priceExperiment.rows.find(row => row.variant === 'B');
  assert.equal(afterRow.paid, before.paid); assert.equal(afterRow.revenueRub, before.revenueRub);
});
test('three months with the campaign code bills 319, extends by three months and consumes the shared code once', () => {
  const user = recruited('B'); firstRecipe(user); startTrial(user.id, after(2));
  const quote = promoQuote(user.id, 'DINNER159', 3);
  assert.equal(quote.priceRub, 319); assert.equal(quote.basePriceRub, 319); assert.equal(quote.discountRub, 0);
  assert.equal(campaignPromotion(user.id).plans.find(plan => plan.months === 3).priceRub, 319);
  assert.equal(promoQuote(recruited('A').id, 'DINNER159', 3).priceRub, 319);
  assert.throws(() => createPaymentOrder(user.id, { promoCode: 'DINNER159', periodMonths: 3, autoRenew: true, consentVersion: '2026-10-03-v1' }), { status: 400 });
  const order = createPaymentOrder(user.id, { promoCode: 'DINNER159', periodMonths: 3, priceRub: 1 }, after(3));
  assert.equal(order.priceRub, 319); assert.equal(order.periodMonths, 3);
  assert.equal(createPaymentOrder(user.id, { promoCode: 'DINNER159', periodMonths: 3 }, after(3)).id, order.id);
  assert.throws(() => createPaymentOrder(user.id, { promoCode: 'DINNER159', periodMonths: 1 }, after(3)), { status: 409 });
  const document = paymentRedirectDocument(order.id, after(3));
  assert.match(document, /value="319\.00"/);
  const receipt = JSON.parse(decodeURIComponent(document.match(/name="Receipt" value="([^"]+)"/)[1]));
  assert.equal(receipt.items[0].sum, 319);
  pay(order); pay(order);
  assert.equal(getSubscriptionAccess(user.id, after(4)).expiresAt, '2026-12-27T08:02:00.000Z');
  assert.equal(db.prepare('SELECT * FROM payment_recurring WHERE user_id=?').get(user.id), undefined);
  assert.throws(() => promoQuote(user.id, 'DINNER159', 1), { status: 409 });
  db.prepare('UPDATE payment_orders SET is_test=0 WHERE id=?').run(order.id);
  const row = funnelReport(campaign).priceExperiment.rows.find(row => row.variant === 'B');
  assert.ok(row.threeMonthsPaid >= 1 && row.promoPaid >= 1 && row.revenueRub >= 319);
  const mockUser = recruited('B'); firstRecipe(mockUser);
  const mock = createMockOrder(mockUser.id, 'card', false, 'DINNER159', 3);
  assert.equal(mock.priceRub, 319); assert.equal(mock.periodMonths, 3);
  finishMockOrder(mockUser.id, mock.id, 'success');
  const now = new Date(); now.setUTCMonth(now.getUTCMonth() + 3);
  assert.ok(Math.abs(Date.parse(getSubscriptionAccess(mockUser.id).expiresAt) - now.getTime()) < 5000);
});

test('experiment revenue and mature trial conversion use real payments, periods, unique users and exposure', () => {
  const user = recruited('B'); firstRecipe(user); startTrial(user.id, after(2));
  assert.equal(recordCampaignPriceExposure(user.id, after(3)), true);
  assert.equal(recordCampaignPriceExposure(user.id, after(4)), false);
  const initial = funnelReport(campaign).priceExperiment.rows.find(row => row.variant === 'B');
  const order = createPaymentOrder(user.id, { promoCode: 'DINNER159' }, after(3)); pay(order);
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
test('any account can enter the code and paying with it does not change the assigned A/B group', () => {
  const owner = upsertTelegramUser({ id: 6971956699, first_name: 'Owner' });
  assert.equal(promoQuote(owner.id, 'DINNER159', 3).priceRub, 319);
  assert.equal(campaignPriceAssignment(owner.id), null);
  const user = recruited('A'); firstRecipe(user);
  assert.equal(getBillingOffer(user.id).campaignPromotion, null);
  const before = funnelReport(campaign).priceExperiment.rows.find(row => row.variant === 'A');
  const order = createPaymentOrder(user.id, { promoCode: 'DINNER159', periodMonths: 3 }, after(3));
  assert.equal(order.priceRub, 319);
  pay(order); db.prepare('UPDATE payment_orders SET is_test=0 WHERE id=?').run(order.id);
  assert.equal(campaignPriceAssignment(user.id).variant, 'A');
  const report = funnelReport(campaign).priceExperiment;
  assert.equal(report.promoPublic, true);
  const afterRow = report.rows.find(row => row.variant === 'A');
  assert.equal(afterRow.promoPaid, before.promoPaid + 1);
  assert.equal(afterRow.threeMonthsPaid, before.threeMonthsPaid + 1);
  assert.equal(afterRow.revenueRub, before.revenueRub + 319);
  assert.throws(() => promoQuote(user.id, 'DINNER159'), { status: 409 });
});

test('renamed DINNER159 preserves old reservations and redemption limits in real and mock checkout', () => {
  const user = recruited('B');
  assert.equal(campaignPromotion(user.id).code, 'DINNER159');
  assert.throws(() => promoQuote(user.id, 'UZHIN159'), { status: 400 });
  const order = createPaymentOrder(user.id, { promoCode: 'DINNER159', periodMonths: 3 }, after(3));
  db.prepare("UPDATE promo_redemptions SET code='UZHIN159' WHERE user_id=?").run(user.id);
  db.prepare("UPDATE payment_orders SET promo_code='UZHIN159' WHERE id=?").run(order.id);
  const resumed = createPaymentOrder(user.id, { promoCode: ' dinner 159 ', periodMonths: 3 }, after(3));
  assert.equal(resumed.id, order.id);
  assert.equal(resumed.priceRub, 319);
  assert.throws(() => createPaymentOrder(user.id, { promoCode: 'DINNER159', periodMonths: 1 }, after(3)), { status: 409 });
  pay(order); pay(order);
  assert.throws(() => promoQuote(user.id, 'DINNER159'), { status: 409 });
  assert.equal(campaignPromotion(user.id), null);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM promo_redemptions WHERE user_id=?').get(user.id).count, 1);

  const mockUser = recruited('B'); firstRecipe(mockUser);
  const mock = createMockOrder(mockUser.id, 'card', false, 'DINNER159');
  db.prepare("UPDATE promo_redemptions SET code='UZHIN159' WHERE user_id=?").run(mockUser.id);
  db.prepare("UPDATE mock_orders SET promo_code='UZHIN159' WHERE id=?").run(mock.id);
  assert.equal(createMockOrder(mockUser.id, 'card', false, 'DINNER159').id, mock.id);
  finishMockOrder(mockUser.id, mock.id, 'success');
  assert.throws(() => promoQuote(mockUser.id, 'DINNER159', 3), { status: 409 });
  assert.equal(campaignPromotion(mockUser.id), null);
});
