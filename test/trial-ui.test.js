import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync('public/app.js', 'utf8');

test('trial button starts server entitlement directly without checkout and begins onboarding', async () => {
  const handlers = {};
  const nodes = Object.fromEntries(['#offer-back', '#trial-return', '#trial-buy-month', '#trial-subscribe', '#start-trial'].map(id => [id, { addEventListener: (_event, fn) => { handlers[id] = fn; } }]));
  const root = { innerHTML: '' }, calls = [], steps = [], routes = [], checkouts = [], offers = [];
  const state = { payment: { available: false, active: false, trial: { eligible: true, used: false } } };
  const sandbox = { state, root, header: () => '', esc: String, bindCommon() {}, document: { querySelector: id => nodes[id] },
    api: async (path, options) => { calls.push([path, options.method]); return { active: true, accessSource: 'trial', trial: { used: true, eligible: false, expiresAt: '2026-10-06T10:00:00Z' } }; },
    setTrialOnboardingStep: s => steps.push(s), setRoute: route => routes.push(route), checkoutPage: () => checkouts.push(true), providerOfferPage: () => offers.push(true), beginDinner: async (...args) => steps.push(args), render() {}, toast: assert.fail };
  vm.runInNewContext(source.slice(source.indexOf('function trialOfferPage()'), source.indexOf('\nfunction offerPage()')), sandbox);
  sandbox.trialOfferPage();
  assert.match(root.innerHTML, /7 дней бесплатно/);
  assert.match(root.innerHTML, /Без карты и автоматического списания/);
  await handlers['#start-trial']({ currentTarget: { disabled: false } });
  assert.deepEqual(calls, [['/api/billing/trial', 'POST']]);
  assert.deepEqual(steps, ['taste', [false, true]]);
  assert.equal(state.payment.active, true);
  state.payment.active = false;
  state.payment.accessSource = null;
  sandbox.trialOfferPage();
  assert.match(root.innerHTML, /Пробный период закончился/);
  assert.match(root.innerHTML, /Оплата пока подключается/);
  assert.doesNotMatch(root.innerHTML, /id="start-trial"/);

  state.payment = { available: true, active: true, accessSource: 'trial', offer: { priceRub: 199 }, trial: { eligible: false, used: true, expiresAt: '2026-10-06T10:00:00Z' } };
  state.paymentPromoQuote = { discountPercent: 99 };
  sandbox.trialOfferPage();
  assert.match(root.innerHTML, /Выбрать тариф/);
  assert.match(root.innerHTML, /Оплаченный период начнётся после окончания пробного периода/);
  handlers['#trial-buy-month']();
  assert.equal(state.paymentPeriodMonths, 1);
  assert.equal(state.paymentPromoQuote, null);
  assert.equal(offers.length, 1);
  assert.equal(checkouts.length, 0);
  state.payment.active = false;
  state.payment.accessSource = null;
  sandbox.trialOfferPage();
  handlers['#trial-subscribe']();
  assert.equal(offers.length, 2);
});

test('trial offer and expiry remain visible even when the payment provider is not connected', () => {
  const sandbox = { state: { payment: { available: false, trial: { eligible: true, used: false } } }, esc: String };
  vm.runInNewContext(source.slice(source.indexOf('function offerBanner()'), source.indexOf('\nfunction openOffer')), sandbox);
  assert.match(sandbox.offerBanner(), /Попробовать 7 дней бесплатно/);
  sandbox.state.payment.trial = { used: true, eligible: false };
  assert.match(sandbox.offerBanner(), /Пробный период закончился/);
});

test('a fresh user sees no trial sales banner until the first recipe is delivered', () => {
  const sandbox = { state: { payment: { available: true, firstRecipe: { available: true, delivered: false }, trial: { eligible: true, used: false } } }, esc: String };
  vm.runInNewContext(source.slice(source.indexOf('function offerBanner()'), source.indexOf('\nfunction openOffer')), sandbox);
  assert.equal(sandbox.offerBanner(), '');
  sandbox.state.payment.firstRecipe = { available: false, pending: true, delivered: false };
  assert.equal(sandbox.offerBanner(), '');
  sandbox.state.payment.firstRecipe = { available: false, pending: false, delivered: true };
  assert.match(sandbox.offerBanner(), /Попробовать 7 дней бесплатно/);
});
