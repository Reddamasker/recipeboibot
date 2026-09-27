import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

test('home keeps dinner separate and resolves a written recipe request', async () => {
  const source = fs.readFileSync('public/app.js', 'utf8');
  const handler = source.slice(source.indexOf('function home()'), source.indexOf('\nasync function beginDinner'));
  const submit = { innerHTML: '', textContent: '', disabled: false };
  const elements = Object.fromEntries(['#choose','#home-search-form','#home-search-input','#voice-request','#collection','#add'].map((key) => [key, { value: '', innerHTML: '', disabled: false }]));
  elements['#home-search-form'].querySelector = () => submit;
  elements['#home-search-form'].requestSubmit = () => elements['#home-search-form'].onsubmit({ preventDefault() {}, currentTarget: elements['#home-search-form'] });
  const example = { textContent: 'Суп' };
  const root = { innerHTML: '' };
  const routes = [], requests = [], opened = []; let rendered; let response = { kind: 'existing', recipe: { id: 'seed:chicken-rice' } };
  const sandbox = { root, state: { recipes: [], jobs: [], query: '' }, header: () => '<header></header>', offerBanner: () => '', card: () => '', bindCommon() {}, importSheet() {},
    document: { querySelector: (key) => elements[key], querySelectorAll: () => [example] }, setRoute: (value) => routes.push(value), beginDinner() {}, render() {}, loadAndRender() {},
    api: async (path, options) => { requests.push([path, options.method, JSON.parse(options.body).query]); return response; },
    openRecipe: async (id) => opened.push(id), location: { search: '' }, URLSearchParams, recipeDetail: (recipe, options) => { rendered = [recipe, options]; }, toast: assert.fail };
  vm.runInNewContext(handler, sandbox);
  sandbox.home();
  assert.match(root.innerHTML, /Найти конкретный рецепт/);
  assert.match(root.innerHTML, /Предложить три блюда/);
  assert.doesNotMatch(root.innerHTML, /<h1><button/);
  assert.match(root.innerHTML, /Надиктовать пожелание/);
  assert.match(root.innerHTML, /Можно коротко/);
  assert.match(root.innerHTML, /Сначала поищу готовый рецепт/);
  elements['#choose'].onclick();
  assert.equal(routes.at(-1).view, 'dinner');
  elements['#home-search-input'].value = 'курица с рисом';
  await elements['#home-search-form'].onsubmit({ preventDefault() {}, currentTarget: elements['#home-search-form'] });
  assert.deepEqual(requests, [['/api/recipe-request', 'POST', 'курица с рисом']]);
  assert.deepEqual(opened, ['seed:chicken-rice']);
  await example.onclick();
  assert.deepEqual(requests.at(-1), ['/api/recipe-request', 'POST', 'Суп']);
  response = { kind: 'generated', suggestion: { id: 'proposal', recipe: { title: 'Новое блюдо' } } };
  elements['#home-search-input'].value = 'паста с грушей';
  await elements['#home-search-form'].onsubmit({ preventDefault() {}, currentTarget: elements['#home-search-form'] });
  assert.equal(rendered[0].title, 'Новое блюдо');
  assert.equal(rendered[1].suggestion.id, 'proposal');
});

test('dinner cards omit ingredient previews, keep shopping needs and use the same time format', () => {
  const source = fs.readFileSync('public/app.js', 'utf8');
  const handler = source.slice(source.indexOf('function dinnerChoiceCard('), source.indexOf('\nfunction updateDinnerIngredients'));
  const sandbox = {
    state: { dinner: { profile: { householdSize: 2 } } },
    totalTime: () => 25,
    safeImage: () => '',
    esc: (value) => String(value),
  };
  vm.runInNewContext(handler, sandbox);
  const recipe = { title: 'Ужин', servings: 2, ingredients: [{ name: 'говяжий фарш' }, { name: 'паста' }, { name: 'лук' }] };
  const familiar = sandbox.dinnerChoiceCard({ id: 'a', role: 'familiar', recipe, pitch: { label: 'Основа уже есть', reason: 'говяжий фарш уже есть дома' }, pantryMatch: { missing: ['паста'] } }, 0);
  assert.match(familiar, /Основа уже есть · 25 мин/);
  assert.match(familiar, /Докупить: паста/);
  assert.doesNotMatch(familiar, /говяжий фарш|<p class="dinner-menu-ingredients">/);
  const quick = sandbox.dinnerChoiceCard({ id: 'b', role: 'quick', recipe, pitch: { label: 'Быстро', reason: '25 минут на готовку' } }, 1);
  assert.match(quick, /Быстро · 25 мин/);
  assert.doesNotMatch(quick, /на готовку|говяжий фарш|паста|<p class="dinner-menu-ingredients">/);
  assert.doesNotMatch(source, /dinner-picks"><div class="eyebrow">СЕГОДНЯ НА УЖИН/);
  assert.doesNotMatch(source, /Из того, что ты назвал/);
});

test('first dinner waits until trial success before starting taste onboarding; explicit settings remain available', async () => {
  const source = fs.readFileSync('public/app.js', 'utf8');
  const document = fs.readFileSync('public/index.html', 'utf8');
  const handler = source.slice(source.indexOf('async function beginDinner('), source.indexOf('\nasync function showDinnerOnboarding'));
  assert.match(document, /app\.js\?v=dinner-10\.15/);
  let needsOnboarding = true, needsTastePreferences = true, questions = 0, tastes = 0, recipes = 0;
  const sandbox = { state: {}, dinnerPollTimer: null, clearTimeout() {}, AbortSignal,
    api: async () => ({ sessionId: 'fresh', profile: {}, needsOnboarding, needsTastePreferences }),
    showDinnerTastePreferences: () => { tastes++; },
    showDinnerOnboarding: async () => { questions++; }, loadDinnerRecommendation: async () => { recipes++; },
    toast: assert.fail, setRoute() {}, home() {} };
  vm.runInNewContext(handler, sandbox);
  await sandbox.beginDinner(); assert.equal(questions, 0); assert.equal(tastes, 0); assert.equal(recipes, 1);
  await sandbox.beginDinner(false, true); assert.equal(questions, 0); assert.equal(tastes, 1); assert.equal(recipes, 1);
  needsOnboarding = false; needsTastePreferences = false;
  await sandbox.beginDinner(false, true); assert.equal(questions, 0); assert.equal(recipes, 2); assert.equal(tastes, 1);
  await sandbox.beginDinner(); assert.equal(questions, 0); assert.equal(recipes, 3); assert.equal(tastes, 1);
  await sandbox.beginDinner(true); assert.equal(questions, 1);
});

test('successful test payment routes pending users into taste preferences', async () => {
  const source = fs.readFileSync('public/app.js', 'utf8');
  const handler = source.slice(source.indexOf('function checkoutPage()'), source.indexOf('\nfunction paymentResultPage'));
  let paymentHandler, route, dinnerArgs, resultPageCalls = 0;
  const resultButton = { dataset: { paymentResult: 'success' }, addEventListener(_name, fn) { paymentHandler = fn; } };
  const checkoutBack = {};
  const state = { payment: { hasFirstRecipe: true, active: false, offer: { priceRub: 199 } }, checkoutOrder: { id: '11111111-1111-4111-8111-111111111111', method: 'card', priceRub: 199 }, paymentMethod: 'card' };
  const sandbox = { root: { innerHTML: '' }, state, esc: String,
    document: { querySelector: (selector) => selector === '#checkout-back' ? checkoutBack : null, querySelectorAll: (selector) => selector === '[data-payment-result]' ? [resultButton] : [] },
    api: async () => ({ order: { status: 'success' } }), refresh: async () => {}, toast: assert.fail,
    setRoute: (value) => { route = value; }, beginDinner: async (...args) => { dinnerArgs = args; }, paymentResultPage: () => { resultPageCalls++; } };
  vm.runInNewContext(handler, sandbox);
  sandbox.checkoutPage();
  await paymentHandler();
  assert.equal(route.view, 'dinner');
  assert.deepEqual(dinnerArgs, [false, true]);
  assert.equal(resultPageCalls, 0);
  assert.equal(state.checkoutOrder, null);
});

test('an already successful test payment resumes pending taste preferences on the next launch', async () => {
  const source = fs.readFileSync('public/app.js', 'utf8');
  const handler = source.slice(source.indexOf('async function resumePendingTrialTastePreferences()'), source.indexOf('\nasync function showDinnerOnboarding'));
  let route, dinnerArgs, profileStatus = 'pending';
  const sandbox = { state: { me: { testContour: true }, payment: { active: true } }, AbortSignal,
    api: async () => ({ tastePreferencesStatus: profileStatus }),
    setRoute: (value, options) => { route = { value, options }; }, beginDinner: async (...args) => { dinnerArgs = args; } };
  vm.runInNewContext(handler, sandbox);
  assert.equal(await sandbox.resumePendingTrialTastePreferences(), true);
  assert.equal(route.value.view, 'dinner');
  assert.equal(route.options.replace, true);
  assert.deepEqual(dinnerArgs, [false, true]);
  profileStatus = 'completed'; route = null; dinnerArgs = null;
  assert.equal(await sandbox.resumePendingTrialTastePreferences(), false);
  assert.equal(route, null);
  assert.equal(dinnerArgs, null);
});

test('taste tags switch between like, dislike and neutral; failed saves retain draft, skip omits it', async () => {
  const source = fs.readFileSync('public/app.js', 'utf8');
  const handler = source.slice(source.indexOf('function tasteChoices('), source.indexOf('\nasync function loadDinnerRecommendation'));
  const buttons = [1, -1].map((value) => ({ dataset: { taste: 'fish', value: String(value) } }));
  const elements = Object.fromEntries(['#taste-save', '#taste-skip'].map((key) => [key, {}]));
  const root = { innerHTML: '' }, requests = [], errors = [];
  let fail = true, dinners = 0;
  const state = { dinner: { profile: { preferredCategories: { pasta: 0.8 } } } };
  const sandbox = { root, state, clearTimeout() {}, dinnerPollTimer: null, header: () => '', bindCommon() {},
    document: { querySelectorAll: () => buttons, querySelector: (key) => elements[key] || { focus() {} } },
    dinnerView: () => sandbox.tastePreferencesView(),
    beginDinner: async () => { dinners++; }, toast: (message) => errors.push(message),
    api: async (url, options) => { requests.push(JSON.parse(options.body)); if (fail) throw new Error('offline'); return {}; } };
  vm.runInNewContext(handler, sandbox);
  sandbox.showDinnerTastePreferences();
  assert.match(root.innerHTML, /Нравится/); assert.match(root.innerHTML, /Не нравится/);
  buttons[0].onclick(); assert.equal(state.onboarding.preferredCategories.fish, 1);
  buttons[1].onclick(); assert.equal(state.onboarding.preferredCategories.fish, -1);
  assert.match(root.innerHTML, /data-taste="fish" data-value="-1" aria-pressed="true"/);
  buttons[1].onclick(); assert.equal(state.onboarding.preferredCategories.fish, undefined);
  buttons[1].onclick();
  await elements['#taste-save'].onclick();
  assert.equal(dinners, 0); assert.deepEqual(errors, ['offline']);
  assert.equal(state.onboarding.preferredCategories.fish, -1); assert.equal(state.onboarding.saving, false);
  fail = false;
  await elements['#taste-save'].onclick();
  assert.deepEqual(requests.at(-1), { preferredCategories: { pasta: 0.8, fish: -1 }, tastePreferencesStatus: 'completed' });
  assert.equal(state.onboarding, null); assert.equal(dinners, 1);
  sandbox.showDinnerTastePreferences(); buttons[0].onclick();
  await elements['#taste-skip'].onclick();
  assert.deepEqual(requests.at(-1), { tastePreferencesStatus: 'skipped' });
  assert.equal(dinners, 2);
});

test('dinner image polling recovers after a network failure', async () => {
  const source = fs.readFileSync('public/app.js', 'utf8');
  const handler = source.slice(source.indexOf('let dinnerPollTimer;'), source.indexOf('\nasync function showNextDinner'));
  const dinner = { sessionId: 's', recommendations: [{ id: 'a', recipe: {} }], reserve: [], imagesPending: true };
  const timers = []; let requests = 0, paints = 0;
  const sandbox = { state: { dinner }, clearTimeout() {}, setTimeout(fn) { timers.push(fn); },
    location: { search: '?view=dinner' }, URLSearchParams, AbortSignal,
    api: async () => { if (++requests === 1) throw new Error('temporary offline'); return { recommendations: [{ id: 'a', recipe: { thumbnailUrl: '/image.jpg' } }], reserve: [1,2,3], imagesPending: false }; },
    dinnerView() { paints++; } };
  vm.runInNewContext(handler, sandbox);
  sandbox.scheduleDinnerPrefetch(dinner);
  await timers.shift()(); assert.equal(timers.length, 1);
  await timers.shift()(); assert.equal(paints, 1);
  assert.equal(dinner.recommendations[0].recipe.thumbnailUrl, '/image.jpg');
  assert.equal(timers.length, 0);
});

test('open full recipe keeps waiting for its image after a transient fetch failure', async () => {
  const source = fs.readFileSync('public/app.js', 'utf8');
  const handler = source.slice(source.indexOf('async function waitForRecipeImage('), source.indexOf('\nfunction recipeDetail'));
  let requests = 0, rendered;
  const sandbox = { state: { recipes: [] }, URLSearchParams, AbortSignal,
    location: { search: '?recipe=dinner%3Aimage' }, document: { querySelector: () => ({}) },
    setTimeout(fn) { fn(); }, api: async () => { if (++requests === 1) throw new Error('offline'); return { id: 'dinner:image', thumbnailUrl: '/ready.jpg' }; },
    closeOverlay() {}, recipeDetail(recipe) { rendered = recipe; } };
  vm.runInNewContext(handler, sandbox);
  await sandbox.waitForRecipeImage('dinner:image');
  assert.equal(requests, 2); assert.equal(rendered.thumbnailUrl, '/ready.jpg');
});

test('recipe details never show a generated-image disclaimer', () => {
  const source = fs.readFileSync('public/app.js', 'utf8');
  assert.doesNotMatch(source, /Изображение создано ИИ|generated-image-note/);
});

test('Mini App hides the landing and exposes the app shell before signaling readiness', () => {
  const index = fs.readFileSync('public/index.html', 'utf8');
  assert.ok(index.indexOf('/mini-boot.js?v=3') < index.indexOf('/styles.css?v='));
  assert.ok(index.indexOf('/vendor/telegram-web-app.js?v=20260714') < index.indexOf('/app.js?v='));
  const stages = [];
  let poll;
  let nativeReadyCalls = 0;
  let parsed = false;
  const app = { hidden: true }, landing = { hidden: false };
  const window = { addEventListener() {}, TelegramWebviewProxy: { postEvent(event, data) { assert.equal(event, 'web_app_ready'); assert.equal(data, '""'); assert.equal(app.hidden, false); assert.equal(landing.hidden, true); nativeReadyCalls += 1; } } };
  vm.runInNewContext(fs.readFileSync('public/mini-boot.js', 'utf8'), {
    window,
    document: { addEventListener() {}, documentElement: {}, querySelector(id) { return parsed ? id === '#app' ? app : landing : null; } },
    location: { hash: '' },
    MutationObserver: class { observe() {} disconnect() {} },
    fetch: async (url) => { stages.push(new URL(url, 'https://test.local').searchParams.get('mini')); },
    setInterval(callback) { poll = callback; return 1; },
    setTimeout() {},
  });
  assert.equal(nativeReadyCalls, 0);
  parsed = true;
  let readyCalls = 0;
  window.Telegram = { WebApp: { ready() { readyCalls += 1; } } };
  poll();
  poll();
  assert.equal(readyCalls, 1);
  assert.equal(nativeReadyCalls, 1);
  assert.deepEqual(stages, ['boot-script', 'native-ready', 'telegram-ready']);
});

test('public landing is not replaced by a Telegram timeout in a normal browser', () => {
  const timers = [], stages = [];
  const window = { addEventListener() {}, Telegram: { WebApp: { initData: '', ready() { assert.fail('not a Telegram launch'); } } } };
  vm.runInNewContext(fs.readFileSync('public/mini-boot.js', 'utf8'), {
    window, location: { hash: '#questions' },
    document: { documentElement: {}, addEventListener() {}, querySelector() { assert.fail('public page must be left visible'); } },
    MutationObserver: class { observe() {} disconnect() {} },
    fetch: async (url) => stages.push(url), setInterval() {}, clearInterval() {},
    setTimeout(callback) { timers.push(callback); },
  });
  timers.forEach((callback) => callback());
  assert.equal(window.__miniLaunch, undefined);
  assert.deepEqual(stages, ['/healthz?mini=boot-script']);
});

test('More renders cached reserve before its HTTP request completes and recovers on network failure', async () => {
  const source = fs.readFileSync('public/app.js', 'utf8');
  const handler = source.slice(source.indexOf('async function showNextDinner()'), source.indexOf('\nfunction onboardingView()'));
  const old = [{ id: 'a' },{ id: 'b' },{ id: 'c' }], reserve = [{ id: 'd' },{ id: 'e' },{ id: 'f' }];
  const state = { dinner: { recommendations: old, recommendation: old[0], reserve } };
  let fail, request, painted;
  const sandbox = { state, dinnerPollTimer: null, clearTimeout() {}, toast() {}, scheduleDinnerPrefetch() {},
    dinnerView() { painted = state.dinner.recommendations.map((o) => o.id); },
    api(url, init) { request = { url, body: JSON.parse(init.body) }; return new Promise((_, reject) => { fail = reject; }); } };
  vm.runInNewContext(handler, sandbox);
  const pending = sandbox.showNextDinner();
  assert.deepEqual(painted, ['d','e','f']);
  assert.deepEqual(request.body.ids, ['a','b','c']);
  assert.equal(request.url, '/api/dinner/next'); assert.equal(state.dinner.switching, true);
  fail(new Error('offline')); await pending;
  assert.deepEqual(painted, ['a','b','c']); assert.equal(state.dinner.switching, false);
});
