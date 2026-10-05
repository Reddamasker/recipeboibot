import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync('public/app.js', 'utf8');

test('trial button starts server entitlement directly without checkout and begins onboarding', async () => {
  const { sandbox, nodes, state, calls, steps, routes } = combinedOfferHarness({ ...expiredPayment,
    available: false, hasFirstRecipe: false, trial: { eligible: true, used: false } });
  assert.match(sandbox.root.innerHTML, /7 дней бесплатно/);
  assert.match(sandbox.root.innerHTML, /Без карты и автоматического списания/);
  assert.equal(calls.length, 0); // Rendering never starts trial or creates an order.
  await nodes['#start-trial'].handler({ currentTarget: { disabled: false } });
  assert.deepEqual(calls, [['/api/billing/trial', 'POST']]);
  assert.deepEqual(steps, ['taste', [false, true]]);
  assert.equal(routes[0].view, 'dinner');
  assert.equal(state.payment.active, true);
});

function combinedOfferHarness(payment, quote = null) {
  const nodes = {}, calls = [], steps = [], routes = [];
  const state = { payment, paymentPeriodMonths: quote?.periodMonths || 1, paymentPromoQuote: quote, paymentPromoMessage: '' };
  const root = { innerHTML: '' };
  const sandbox = { state, root, esc: String, header: () => '', bindCommon() {}, bindPaymentOfferControls() {},
    document: { querySelector: id => nodes[id] ||= { addEventListener(_event, fn) { this.handler = fn; } } },
    api: async (path, options) => {
      if (path.endsWith('/exposure')) return {};
      calls.push([path, options.method]);
      return { ...payment, active: true, accessSource: 'trial', trial: { used: true, eligible: false, expiresAt: '2026-10-08T10:00:00Z' } };
    },
    setTrialOnboardingStep: step => steps.push(step), beginDinner: async (...args) => steps.push(args),
    setRoute: route => routes.push(route), closeOverlay() {}, render() {}, toast: assert.fail };
  vm.runInNewContext(source.slice(source.indexOf('async function activateTrial('), source.indexOf('function bindCommon()')), sandbox);
  vm.runInNewContext(source.slice(source.indexOf('const paymentMoney ='), source.indexOf('function bindPaymentOfferControls()')), sandbox);
  vm.runInNewContext(source.slice(source.indexOf('function providerOfferPage()'), source.indexOf('\nfunction providerCheckoutPage()')), sandbox);
  vm.runInNewContext(source.slice(source.indexOf('function trialOfferPage()'), source.indexOf('\nfunction checkoutPage()')), sandbox);
  sandbox.offerPage();
  return { sandbox, nodes, state, calls, steps, routes };
}

const combinedOffer = (payment, quote) => combinedOfferHarness(payment, quote).sandbox.root.innerHTML;

const expiredPayment = {
  active: false, hasFirstRecipe: true, mode: 'provider', trial: { used: true, eligible: false },
  plans: [
    { months: 1, priceRub: 199, fullPriceRub: 199, savingRub: 0, discountPercent: 0 },
    { months: 3, priceRub: 499, fullPriceRub: 597, savingRub: 98, discountPercent: 16 },
    { months: 12, priceRub: 1499, fullPriceRub: 2388, savingRub: 889, discountPercent: 37 }
  ]
};

test('the same three tariffs appear before trial, during trial, after trial and with paid access', () => {
  const trial = { used: true, eligible: false, expiresAt: '2026-10-08T10:00:00Z' };
  for (const available of [true, false]) {
    for (const status of [
      { hasFirstRecipe: false, trial: { used: false, eligible: true } },
      { active: true, accessSource: 'trial', trial },
      { active: false, trial },
      { active: true, accessSource: 'subscription', trial, expiresAt: '2026-11-08T10:00:00Z' }
    ]) {
      const { sandbox, calls } = combinedOfferHarness({ ...expiredPayment, available, ...status });
      const html = sandbox.root.innerHTML;
      assert.equal((html.match(/<h1>/g) || []).length, 1);
      assert.equal((html.match(/data-period-months=/g) || []).length, 3);
      assert.doesNotMatch(html, /trial-buy-month|trial-subscribe|paywall-trial-card|paywall-after|Выбрать тариф/);
      assert.equal(calls.length, 0);
      if (status.trial.eligible) {
        assert.match(html, /id="start-trial"/);
        assert.match(html, /id="offer-pay" disabled>Сначала начните пробный период/);
      } else if (status.accessSource === 'trial') {
        assert.match(html, /Пробный период активен/);
        assert.match(html, /08\.10\.2026/);
        assert.match(html, /Оплаченный период начнётся после окончания пробного периода/);
        assert.match(html, /id="trial-return"/);
        assert.match(html, available ? /id="offer-pay">Оплатить 199 ₽/ : /id="offer-pay" disabled/);
      } else if (status.active) assert.match(html, /Продлить доступ/);
      else assert.match(html, /Пробный период закончился/);
    }
  }
});

test('active trial keeps the selected promo term on the combined page and returns to recipes', () => {
  const quote = { code: 'DINNER159', periodMonths: 12, priceRub: 1199, discountPercent: 20 };
  const { sandbox, nodes, state, calls, routes } = combinedOfferHarness({ ...expiredPayment, available: true,
    active: true, accessSource: 'trial', trial: { used: true, expiresAt: '2026-10-08T10:00:00Z' } }, quote);
  assert.match(sandbox.root.innerHTML, /data-period-months="12" aria-pressed="true"/);
  assert.match(sandbox.root.innerHTML, /id="offer-pay">Оплатить 1 199 ₽/);
  assert.equal(state.paymentPromoQuote, quote);
  nodes['#trial-return'].handler();
  assert.equal(Object.keys(routes[0]).length, 0);
  assert.equal(calls.length, 0);
});

test('expired trial immediately shows one page with expiry message and all tariffs, including unavailable payments', () => {
  for (const available of [true, false]) {
    const html = combinedOffer({ ...expiredPayment, available, mode: available ? 'provider' : 'unavailable' });
    assert.equal((html.match(/<h1>/g) || []).length, 1);
    assert.match(html, /Пробный период закончился/);
    assert.match(html, /Ваши рецепты сохранены/);
    assert.equal((html.match(/class="paywall-benefits"/g) || []).length, 1);
    assert.equal((html.match(/data-period-months=/g) || []).length, 3);
    assert.doesNotMatch(html, /trial-subscribe|start-trial|paywall-trial-card|paywall-after|offer-price-summary|Без скидки|за месяц/);
    assert.match(html, available ? /id="offer-pay">Оплатить 199 ₽/ : /id="offer-pay" disabled>Оплата пока подключается/);
  }
});

test('combined expired paywall shows discounted tariffs and payment amount without repeating the quote summary', () => {
  const quote = { code: 'DINNER159', periodMonths: 3, priceRub: 399, basePriceRub: 499, discountRub: 100,
    plans: [{ months: 1, priceRub: 159, basePriceRub: 199, discountRub: 40 }, { months: 3, priceRub: 399, basePriceRub: 499, discountRub: 100 }] };
  const html = combinedOffer({ ...expiredPayment, available: true }, quote);
  assert.match(html, /id="offer-pay">Оплатить 399 ₽/);
  assert.match(html, /data-period-months="3" aria-pressed="true"/);
  assert.match(html, /Промокод применён/);
  assert.doesNotMatch(html, /offer-price-summary|Скидка 100 ₽|399 ₽ за 3 месяца|По промокоду:/);
  assert.equal((html.match(/Автопродление по промокоду не подключается/g) || []).length, 1);
});

function directOffer({ months = 1, quote = null, fail = false, browser = false } = {}) {
  const nodes = {}, calls = [], routes = [], links = [], results = [];
  const state = { payment: { ...expiredPayment, available: true, recurringSupported: false }, paymentPeriodMonths: months, paymentPromoQuote: quote };
  const sandbox = { state, root: {}, header: () => '', esc: String, bindCommon() {}, bindPaymentOfferControls() {},
    document: { querySelector: id => nodes[id] ||= { addEventListener(_event, fn) { this.handler = fn; } } },
    api: async (url, options) => {
      if (!url.endsWith('/orders')) return {};
      calls.push(JSON.parse(options.body));
      if (fail) throw new Error('Не удалось создать заказ');
      return { id: 'order-1', mode: 'provider', paymentUrl: 'https://example.test/pay' };
    },
    setRoute: route => routes.push(route), providerPaymentResultPage: () => results.push(true),
    tg: browser ? null : { openLink: url => links.push(url) }, window: { open: url => links.push(url) } };
  vm.runInNewContext(source.slice(source.indexOf('const paymentMoney ='), source.indexOf('function bindPaymentOfferControls()')), sandbox);
  vm.runInNewContext(source.slice(source.indexOf('function providerOfferPage()'), source.indexOf('\nfunction providerCheckoutPage()')), sandbox);
  sandbox.providerOfferPage();
  return { sandbox, nodes, state, calls, routes, links, results };
}

test('tariff payment opens the provider directly for every term and paid promo, including browser fallback', async () => {
  for (const months of [1, 3, 12]) {
    for (const promo of [false, true]) {
      const quote = promo ? { code: 'DINNER159', periodMonths: months, priceRub: 159, discountPercent: 20 } : null;
      const { sandbox, nodes, state, calls, routes, links, results } = directOffer({ months, quote, browser: months === 12 });
      assert.doesNotMatch(sandbox.root.innerHTML, /checkout-shell|checkout-continue|К оплате сейчас/);
      assert.match(sandbox.root.innerHTML, /Нажимая кнопку, вы принимаете/);
      if (!quote) assert.match(sandbox.root.innerHTML, /Без автоматического продления/);
      await nodes['#offer-pay'].handler({ currentTarget: {} });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].periodMonths, months);
      assert.equal(calls[0].promoCode, quote?.code);
      assert.equal(calls[0].autoRenew, false);
      assert.deepEqual(links, ['https://example.test/pay']);
      assert.equal(routes[0].view, 'payment-result');
      assert.equal(results.length, 1);
      assert.equal(state.checkoutOrder.id, 'order-1');
      assert.equal(state.paymentResult, 'pending');
    }
  }
});

test('renewal consent remains visible but disabled before provider approval and cannot enable an order', async () => {
  for (const months of [1, 3, 12]) {
    const { sandbox, nodes, state, calls } = directOffer({ months });
    state.payment.consentText = 'Я даю согласие на регулярные списания';
    state.payment.consentVersion = 'v1';
    state.payment.plans = state.payment.plans.map(plan => ({ ...plan, consentTerms: `${plan.priceRub} ₽ за выбранный период` }));
    sandbox.providerOfferPage();
    assert.match(sandbox.root.innerHTML, /id="auto-renew"[^>]* disabled/);
    assert.doesNotMatch(sandbox.root.innerHTML, /id="auto-renew"[^>]* checked/);
    assert.match(sandbox.root.innerHTML, /<strong>Автопродление<\/strong>/);
    assert.match(sandbox.root.innerHTML, /Автопродление пока недоступно/);
    assert.match(sandbox.root.innerHTML, /Я даю согласие на регулярные списания/);
    assert.match(sandbox.root.innerHTML, /href="\/offer.html#auto-renew"/);
    // Even a manipulated checkbox cannot bypass the server availability flag.
    nodes['#auto-renew'] = { checked: true };
    await nodes['#offer-pay'].handler({ currentTarget: {} });
    assert.equal(calls[0].autoRenew, false);
    assert.equal(calls[0].consentVersion, undefined);
    assert.equal(calls[0].periodMonths, months);
  }
  const promo = directOffer({ quote: { code: 'DINNER159', priceRub: 159, discountPercent: 20 } });
  assert.match(promo.sandbox.root.innerHTML, /id="auto-renew"[^>]* disabled/);
  assert.match(promo.sandbox.root.innerHTML, /Автопродление по промокоду недоступно/);
  assert.match(promo.sandbox.root.innerHTML, /Автопродление по промокоду не подключается/);
});

test('paid and free promo offers show consent even with recurring enabled or the provider unavailable', async () => {
  for (const recurringSupported of [false, true]) {
    for (const discountPercent of [20, 99, 100]) {
      const { sandbox, nodes, state, calls } = directOffer({ quote: { code: 'PROMO', priceRub: 159, discountPercent } });
      state.payment.recurringSupported = recurringSupported;
      state.payment.consentText = 'Согласие на регулярные списания';
      sandbox.providerOfferPage();
      assert.match(sandbox.root.innerHTML, /id="auto-renew"[^>]* disabled/);
      assert.doesNotMatch(sandbox.root.innerHTML, /id="auto-renew"[^>]* checked/);
      assert.match(sandbox.root.innerHTML, /Автопродление по промокоду недоступно/);
      assert.match(sandbox.root.innerHTML, /href="\/offer.html#auto-renew"/);
      if (discountPercent !== 100) {
        nodes['#auto-renew'] = { checked: true };
        await nodes['#offer-pay'].handler({ currentTarget: {} });
        assert.equal(calls[0].autoRenew, false);
        assert.equal(calls[0].consentVersion, undefined);
      } else {
        state.payment.mode = 'unavailable';
        state.payment.available = false;
        sandbox.providerOfferPage();
        assert.match(sandbox.root.innerHTML, /id="auto-renew"[^>]* disabled/);
        assert.match(sandbox.root.innerHTML, /id="offer-pay">Получить месяц бесплатно/);
      }
    }
  }
});

test('order failure keeps the selected tariff and restores payment; old checkout links never create an order', async () => {
  const { sandbox, nodes, state, calls, routes, links } = directOffer({ months: 12, fail: true });
  await nodes['#offer-pay'].handler({ currentTarget: {} });
  assert.equal(state.paymentPeriodMonths, 12);
  assert.match(sandbox.root.innerHTML, /Не удалось создать заказ/);
  assert.match(sandbox.root.innerHTML, /id="offer-pay">Оплатить 1 499 ₽/);
  assert.equal(links.length, 0);
  assert.equal(routes.length, 0);
  const compatibility = source.slice(source.indexOf('function providerCheckoutPage()'), source.indexOf('\nasync function completeProviderPayment'));
  vm.runInNewContext(compatibility, sandbox);
  sandbox.providerCheckoutPage();
  assert.equal(calls.length, 1);
  assert.equal(routes[0].view, 'offer');
});

test('paywall displays free three-month and annual terms and sends the chosen term to redemption without a provider', async () => {
  for (const months of [3, 12]) {
    const nodes = {}, calls = [];
    const quote = { code: 'FREE-CODE', discountPercent: 100, periodMonths: months, priceRub: 0,
      plans: expiredPayment.plans.map(p => ({ months: p.months, basePriceRub: p.priceRub, priceRub: 0, discountRub: p.priceRub })) };
    const state = { payment: { ...expiredPayment, available: false }, paymentPeriodMonths: months, paymentPromoQuote: quote, paymentPromoMessage: '' };
    const root = { innerHTML: '' };
    const sandbox = { state, root, header: () => '', esc: String, bindCommon() {}, bindPaymentOfferControls() {},
      document: { querySelector: id => nodes[id] ||= { addEventListener: (_event, fn) => { nodes[id].handler = fn; } } },
      api: async (url, options) => { calls.push([url, JSON.parse(options.body)]); return { periodMonths: months, payment: { ...state.payment, active: true, expiresAt: '2027-10-03T10:00:00Z' } }; } };
    vm.runInNewContext(source.slice(source.indexOf('const paymentMoney ='), source.indexOf('function bindPaymentOfferControls()')), sandbox);
    vm.runInNewContext(source.slice(source.indexOf('function providerOfferPage()'), source.indexOf('\nfunction providerCheckoutPage()')), sandbox);
    sandbox.providerOfferPage();
    assert.match(root.innerHTML, months === 12 ? /Получить 1 год бесплатно/ : /Получить 3 месяца бесплатно/);
    assert.equal((root.innerHTML.match(/offer-period-price">0 ₽/g) || []).length, 3);
    await nodes['#offer-pay'].handler({ currentTarget: { disabled: false } });
    const redemption = calls.find(([url]) => url.endsWith('/promo/redeem'));
    assert.equal(redemption[1].periodMonths, months);
    assert.equal(state.payment.active, true);
    assert.match(state.paymentPromoMessage, months === 12 ? /на 1 год активирован/ : /на 3 месяца активирован/);
  }
});

test('trial offer and expiry remain visible even when the payment provider is not connected', () => {
  const sandbox = { state: { payment: { available: false, trial: { eligible: true, used: false } } }, esc: String };
  vm.runInNewContext(source.slice(source.indexOf('function offerBanner()'), source.indexOf('\nfunction openOffer')), sandbox);
  assert.match(sandbox.offerBanner(), /Учту твои предпочтения для будущих рецептов/);
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
  assert.match(sandbox.offerBanner(), /Учту твои предпочтения для будущих рецептов/);
  assert.match(sandbox.offerBanner(), /data-open-benefits/);
  assert.doesNotMatch(sandbox.offerBanner(), /data-open-offer|data-start-trial/);
});

test('benefits trial button activates with one click, ignores a concurrent click and preserves retry after failure', async () => {
  const calls = [], steps = [], routes = [], errors = [], buttons = [];
  const state = { payment: { trial: { eligible: true, used: false }, firstRecipe: { delivered: true } } };
  let release, fail = false;
  const sandbox = { state, esc: String, document: { querySelectorAll: () => buttons },
    api: async (url, options) => {
      calls.push([url, options.method]);
      await new Promise(resolve => { release = resolve; });
      if (fail) throw new Error('Попробуйте ещё раз');
      return { active: true, accessSource: 'trial' };
    },
    closeOverlay() {}, setRoute: route => routes.push(route), setTrialOnboardingStep: step => steps.push(step),
    beginDinner: async (...args) => steps.push(args), toast: message => errors.push(message), openOffer: assert.fail };
  vm.runInNewContext(source.slice(source.indexOf('async function activateTrial('), source.indexOf('function bindCommon()')), sandbox);
  vm.runInNewContext(source.slice(source.indexOf('function offerBanner()'), source.indexOf('\nfunction openOffer')), sandbox);
  assert.match(sandbox.offerBanner(), /data-open-benefits/);
  const button = { disabled: false, addEventListener(_name, handler) { this.click = handler; } };
  buttons.push(button); sandbox.bindTrialButtons();
  assert.equal(calls.length, 0);
  fail = true;
  const failed = button.click({ currentTarget: button });
  await button.click({ currentTarget: button });
  assert.equal(calls.length, 1);
  assert.equal(button.disabled, true);
  release(); await failed;
  assert.equal(button.disabled, false);
  assert.equal(state.trialStarting, false);
  assert.deepEqual(errors, ['Попробуйте ещё раз']);
  fail = false;
  const retry = button.click({ currentTarget: button });
  release(); await retry;
  assert.deepEqual(calls, [['/api/billing/trial', 'POST'], ['/api/billing/trial', 'POST']]);
  assert.equal(state.payment.active, true);
  assert.deepEqual(steps, ['taste', [false, true]]);
  assert.equal(routes[0].view, 'dinner');
});

test('first recipe banner opens three benefits and only their trial button starts access', () => {
  const nodes = {}, routes = [], calls = [];
  const sandbox = {
    state: { payment: { trial: { eligible: true, used: false }, active: false } },
    root: {}, header: () => '', closeOverlay() {}, offerPage: assert.fail,
    setRoute: route => routes.push(route),
    render() { if (routes.at(-1)?.view === 'benefits') sandbox.benefitsPage(); },
    document: { querySelector: id => nodes[id] ||= {} },
    bindCommon() { nodes.trial = { click: () => calls.push('/api/billing/trial') }; }
  };
  vm.runInNewContext(source.slice(source.indexOf('function openBenefits('), source.indexOf('function mainMenuPage(')), sandbox);
  sandbox.openBenefits();
  assert.equal(routes.at(-1).view, 'benefits');
  assert.equal(calls.length, 0);
  assert.equal((sandbox.root.innerHTML.match(/class="offer-feature"/g) || []).length, 3);
  assert.match(sandbox.root.innerHTML, /Сохраняем за тебя/);
  assert.match(sandbox.root.innerHTML, /Подбираем на вечер/);
  assert.match(sandbox.root.innerHTML, /Напоминаем вовремя/);
  assert.match(sandbox.root.innerHTML, /data-start-trial>Попробовать 7 дней бесплатно/);
  assert.doesNotMatch(sandbox.root.innerHTML, /data-period-months|offer-pay/);
  nodes['#benefits-back'].onclick();
  assert.equal(routes.at(-1).view, 'dinner');
  assert.equal(calls.length, 0);
  nodes.trial.click();
  assert.deepEqual(calls, ['/api/billing/trial']);
});
