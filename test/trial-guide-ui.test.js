import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync('public/app.js', 'utf8');
function fixture({ active = true, step = null, cached = false } = {}) {
  const profile = { preferredCategories: { pasta: 1 }, dishPreferences: { pasta: 1 }, excludedIngredients: [], tastePreferencesStatus: 'completed' };
  const requests = [], routes = [], pages = [], store = new Map(), nodes = {};
  const state = { me: { id: 'guide-user' }, payment: { active, accessSource: 'trial', firstRecipe: { trialGateUsed: true }, pendingFirstRecipe: { recipeId: 'same-first', unlocked: true } }, dinner: cached ? { profile, recommendations: [] } : null };
  const guideKey = 'recipeboibot-trial-guide-v1:guide-user', legacyKey = 'recipeboibot-trial-onboarding-v1:guide-user';
  store.set(legacyKey, 'payment-success'); if (step) store.set(guideKey, step);
  const sandbox = { state, root: { innerHTML: '' }, dinnerPollTimer: null, clearTimeout() {}, resetPageScroll() {}, header: () => '', esc: String,
    window: { localStorage: { getItem: key => store.get(key), setItem: (key, value) => store.set(key, value), removeItem: key => store.delete(key) } },
    document: { querySelector: key => nodes[key] ||= { value: '', disabled: false, focus() {} }, querySelectorAll: () => [] },
    bindCommon() {}, toast: assert.fail, closeOverlay() {}, tg: {}, AbortSignal,
    setRoute(route) { routes.push(route); },
    dinnerView() { sandbox.tastePreferencesView(); },
    notificationSettingsPage: async () => pages.push('notifications-settings'),
    providerOfferPage: () => pages.push('pricing'),
    async render() { if (routes.at(-1)?.view === 'trial-guide') await sandbox.startTrialGuide(); else pages.push(routes.at(-1)?.view); },
    api: async (path, options = {}) => { requests.push({ path, method: options.method || 'GET', body: options.body }); assert.equal(path, '/api/dinner/profile'); return profile; },
    beginDinner: assert.fail
  };
  vm.createContext(sandbox);
  vm.runInContext(source.slice(source.indexOf('const trialGuideKey ='), source.indexOf('function header()')), sandbox);
  vm.runInContext(source.slice(source.indexOf('function openTrialGuide()'), source.indexOf('function benefitsPage()')), sandbox);
  vm.runInContext(source.slice(source.indexOf('function tasteChoices('), source.indexOf('async function loadDinnerRecommendation()')), sandbox);
  return { sandbox, state, store, nodes, requests, routes, pages, guideKey, legacyKey };
}

test('optional trial guide starts explicitly with only profile GET and preserves the chosen recipe', async () => {
  const f = fixture();
  assert.equal(f.requests.length, 0);
  await f.sandbox.startTrialGuide();
  assert.deepEqual(f.requests.map(r => [r.path, r.method]), [['/api/dinner/profile', 'GET']]);
  assert.equal(f.state.payment.pendingFirstRecipe.recipeId, 'same-first');
  assert.equal(f.state.trialOnboarding, 'taste');
  assert.match(f.sandbox.root.innerHTML, /Спасибо, что пробуешь/);
  assert.match(f.sandbox.root.innerHTML, /Вернуться к рецепту/);
  assert.equal(f.store.get(f.guideKey), 'taste');
  assert.equal(f.store.get(f.legacyKey), 'payment-success');
  f.sandbox.returnFromTrialGuide();
  assert.equal(f.routes.at(-1).view, 'collection');
  assert.equal(f.routes.at(-1).recipe, 'same-first');
  assert.equal(f.store.get(f.guideKey), 'taste');
  assert.equal(f.state.onboarding, null);
  assert.equal(f.state.trialGuideActive, false);
});

test('cached profile guide skips tastes and reminders, resumes collection on explicit reopen and clears only its own progress on finish', async () => {
  const f = fixture({ cached: true });
  await f.sandbox.startTrialGuide();
  assert.equal(f.requests.length, 0);
  await f.nodes['#taste-skip'].onclick();
  assert.deepEqual(f.requests.map(r => [r.path, r.method]), [['/api/dinner/profile', 'PUT']]);
  assert.equal(JSON.parse(f.requests[0].body).tastePreferencesStatus, 'skipped');
  assert.equal(f.store.get(f.guideKey), 'notifications');
  assert.equal(f.routes.at(-1).view, 'trial-guide');
  assert.match(f.sandbox.root.innerHTML, /Не думай об ужине заранее/);
  f.nodes['#trial-notifications-skip'].onclick();
  assert.equal(f.store.get(f.guideKey), 'collection');
  assert.match(f.sandbox.root.innerHTML, /Собери рецепты/);
  f.sandbox.returnFromTrialGuide();
  await f.sandbox.startTrialGuide();
  assert.match(f.sandbox.root.innerHTML, /Собери рецепты/);
  assert.equal(f.requests.length, 1);
  f.nodes['#trial-finish'].onclick();
  assert.equal(f.store.has(f.guideKey), false);
  assert.equal(f.store.get(f.legacyKey), 'payment-success');
  assert.equal(f.routes.at(-1).recipe, 'same-first');
});

test('guide reopens the saved reminder-settings step without creating a dinner or trial', async () => {
  const f = fixture({ step: 'notifications-settings' });
  await f.sandbox.startTrialGuide();
  assert.deepEqual(f.pages, ['notifications-settings']);
  assert.equal(f.requests.length, 0);
  assert.equal(f.state.trialOnboarding, 'notifications-settings');
});

test('expired access cannot start feature guide and returns to tariffs without profile or trial requests', async () => {
  const f = fixture({ active: false, step: 'notifications' });
  await f.sandbox.startTrialGuide();
  assert.deepEqual(f.pages, ['pricing']);
  assert.equal(f.requests.length, 0);
  assert.equal(f.routes.at(-1).view, 'pricing');
  assert.equal(f.store.get(f.guideKey), 'notifications');
});

test('closing the optional guide during a save cannot reopen its next screen after the late response', async () => {
  const f = fixture({ cached: true }); await f.sandbox.startTrialGuide();
  let finish; f.sandbox.api = () => new Promise(resolve => { finish = resolve; });
  const saving = f.nodes['#taste-skip'].onclick();
  f.sandbox.returnFromTrialGuide(); finish({}); await saving;
  assert.equal(f.routes.at(-1).view, 'collection');
  assert.equal(f.state.trialGuideActive, false);
  assert.equal(f.store.get(f.guideKey), 'taste');
  assert.equal(f.store.get(f.legacyKey), 'payment-success');
});


test('paid access can use the optional guide without claiming a new free trial', async () => {
  const f = fixture({ cached: true }); f.state.payment.accessSource = 'subscription';
  await f.sandbox.startTrialGuide();
  assert.match(f.sandbox.root.innerHTML, /Спасибо, что ты с нами/);
  assert.doesNotMatch(f.sandbox.root.innerHTML, /ПРОБНЫЙ ПЕРИОД НАЧАЛСЯ/);
  assert.equal(f.requests.length, 0);
});


test('ordinary menu navigation exits an optional guide and a late save cannot force it back', async () => {
  const f = fixture({ cached: true }); await f.sandbox.startTrialGuide();
  let finish; f.sandbox.api = () => new Promise(resolve => { finish = resolve; });
  const saving = f.nodes['#taste-skip'].onclick();
  f.sandbox.location = { search: '?view=menu' }; f.sandbox.URLSearchParams = URLSearchParams;
  f.sandbox.mainMenuPage = () => f.pages.push('menu');
  vm.runInContext(source.slice(source.indexOf('async function render()'), source.indexOf('async function refresh()')), f.sandbox);
  await f.sandbox.render(); finish({}); await saving;
  assert.deepEqual(f.pages, ['menu']);
  assert.equal(f.state.trialGuideActive, false);
  assert.equal(f.state.trialOnboarding, null);
  assert.equal(f.state.onboarding, null);
  assert.equal(f.store.get(f.guideKey), 'taste');
  assert.equal(f.store.get(f.legacyKey), 'payment-success');
});
