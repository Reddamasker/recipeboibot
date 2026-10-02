import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync('public/app.js', 'utf8');
function page(available = false, mode = 'unavailable') {
  const nodes = {}, calls = [], routes = [], root = { innerHTML: '' }, opened = [];
  for (const id of ['#promo-back', '#promo-form', '#promo-code', '#promo-message', '#promo-apply']) nodes[id] = { value: '', addEventListener: (_event, fn) => { nodes[id].handler = fn; } };
  const context = { root, state: { payment: { available, mode } }, esc: String, header: () => '', bindCommon() {},
    document: { querySelector: id => nodes[id] }, setRoute: route => routes.push(route), render() {},
    checkoutPage() { opened.push('mock'); }, providerPaymentResultPage() { opened.push('provider'); },
    tg: { openLink: url => opened.push(url) },
    api: async (url, options) => { calls.push([url, JSON.parse(options.body)]); return context.response; } };
  vm.runInNewContext(source.slice(source.indexOf('const paymentMoney ='), source.indexOf('function availablePaymentPlans()')), context);
  vm.runInNewContext(source.slice(source.indexOf('function promoPage('), source.indexOf('\nfunction trialOfferPage()')), context);
  return { context, nodes, calls, root, opened };
}
test('promo field checks code then free confirmation redeems without opening checkout', async () => {
  const { context, nodes, calls, root, opened } = page();
  context.promoPage();
  assert.match(root.innerHTML, /Введите промокод/);
  nodes['#promo-code'].value = 'PICHU 100';
  context.response = { code: 'PICHU100', priceRub: 0, basePriceRub: 199, discountPercent: 100 };
  await nodes['#promo-form'].onsubmit({ preventDefault() {} });
  assert.match(root.innerHTML, /Получить месяц бесплатно/);
  context.response = { expiresAt: '2026-11-01T10:00:00Z', payment: { active: true } };
  await nodes['#promo-apply'].handler({ currentTarget: nodes['#promo-apply'] });
  assert.equal(calls[0][0], '/api/billing/promo/quote');
  assert.equal(calls[1][0], '/api/billing/promo/redeem');
  assert.equal(calls[1][1].code, 'PICHU100');
  assert.equal(context.state.payment.active, true);
  assert.match(nodes['#promo-message'].textContent, /активирован/);
  assert.deepEqual(opened, []);
});
test('99 percent displays 1.99 and preserves code when provider is disconnected', () => {
  const { context, root } = page();
  context.promoPage({ code: 'PICHU99', priceRub: 1.99, basePriceRub: 199, discountPercent: 99 });
  assert.match(root.innerHTML, /1,99 ₽/);
  assert.match(root.innerHTML, /Промокод не потрачен/);
  assert.doesNotMatch(root.innerHTML, /id="promo-apply"/);
});
test('campaign recipient sees assigned code and an exact 40 ruble discount, order request uses only the code', async () => {
  const { context, nodes, calls, root, opened } = page(true, 'provider');
  context.state.payment.campaignPromotion = { code: 'DINNER159', basePriceRub: 199, priceRub: 159 };
  context.promoPage();
  assert.match(root.innerHTML, /value="DINNER159"/);
  context.promoPage({ code: 'DINNER159', basePriceRub: 199, priceRub: 159, discountPercent: null, discountRub: 40 });
  assert.match(root.innerHTML, /Скидка 40 ₽/);
  assert.match(root.innerHTML, /Оплатить 159,00 ₽/);
  assert.doesNotMatch(root.innerHTML, /null%/);
  context.response = { id: 'campaign-order', mode: 'provider', paymentUrl: 'https://example.test/pay' };
  await nodes['#promo-apply'].handler({ currentTarget: nodes['#promo-apply'] });
  assert.deepEqual(calls, [['/api/billing/orders', { promoCode: 'DINNER159', autoRenew: false, method: 'card', periodMonths: 1 }]]);
  assert.ok(opened.includes('provider'));
});
test('99 percent confirmation sends code only and follows provider or test order mode', async () => {
  for (const mode of ['mock', 'provider']) {
    const { context, nodes, calls, opened } = page(true, mode);
    context.promoPage({ code: 'PICHU99', priceRub: 1.99, basePriceRub: 199, discountPercent: 99 });
    context.response = { id: 'order-id', mode, paymentUrl: 'https://example.test/pay' };
    await nodes['#promo-apply'].handler({ currentTarget: nodes['#promo-apply'] });
    assert.deepEqual(calls, [['/api/billing/orders', { promoCode: 'PICHU99', autoRenew: false, method: 'card', periodMonths: 1 }]]);
    assert.ok(opened.includes(mode));
  }
  assert.match(source, /id="promo-settings"/);
  assert.match(source, /href="\/\?view=promo"/);
  assert.doesNotMatch(source, /PICHU99|PICHU100/); // Do not publish the codes in the client bundle.
});
test('three-month promo confirmation shows 399 rubles and sends the chosen three-month term', async () => {
  const { context, nodes, calls, root } = page(true, 'provider');
  context.state.paymentPeriodMonths = 3;
  context.state.payment.campaignPromotion = { code: 'DINNER159', plans: [{ months: 1, priceRub: 159 }, { months: 3, priceRub: 399 }] };
  context.promoPage({ code: 'DINNER159', priceRub: 399, basePriceRub: 499, discountRub: 100, periodMonths: 3 });
  assert.match(root.innerHTML, /Скидка 100 ₽ на 3 месяца/);
  assert.match(root.innerHTML, /Оплатить 399,00 ₽/);
  assert.match(root.innerHTML, /value="3" selected/);
  context.response = { id: 'quarter-order', mode: 'provider', paymentUrl: 'https://example.test/pay' };
  await nodes['#promo-apply'].handler({ currentTarget: nodes['#promo-apply'] });
  assert.deepEqual(calls, [['/api/billing/orders', { promoCode: 'DINNER159', autoRenew: false, method: 'card', periodMonths: 3 }]]);
});
