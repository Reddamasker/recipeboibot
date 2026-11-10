import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHmac } from 'node:crypto';
import { validateMaxInitData } from '../src/max-auth.js';
import { SEED_RECIPES } from '../src/dinner-seeds.js';

const bridgeSource = fs.readFileSync('public/platform-bridge.js', 'utf8');
const appSource = fs.readFileSync('public/app.js', 'utf8');
const secret = 'isolated-max-navigation-test';
const generatedKey = 'dinner:12345678-1234-1234-1234-123456789012';
const encode = route => Buffer.from(JSON.stringify(route)).toString('base64url');
function signed(payload) {
  const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: 123, first_name: 'Автор' }) });
  if (payload !== undefined) params.set('start_param', payload);
  const check = [...params].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => `${key}=${value}`).join('\n');
  const key = createHmac('sha256', 'WebAppData').update(secret).digest();
  params.set('hash', createHmac('sha256', key).update(check).digest('hex'));
  return params.toString();
}

async function bootFixture({ route, payload = route && encode(route), search = '?view=dinner', hash = '', platform = 'max', unsafe = true, authFails = false, shared = false, pendingTrial = false, paymentStatus, trialEligible = false, firstGate = false, firstUnlocked = false, guide = false, chatStarted } = {}) {
  const location = new URL(`https://recipes.test/${shared ? 'share/' + 'a'.repeat(32) : ''}${search}`);
  location.hash = hash;
  const requests = [], pages = [], details = [], probes = [], navigations = [];
  const root = { hidden: true, innerHTML: '' }, landing = { hidden: false };
  const initData = signed(payload);
  const sdk = { initData, initDataUnsafe: unsafe && payload ? { start_param: payload, user: { id: 'unsafe-other-account' } } : {} };
  const window = { __recipePlatform: { name: platform }, WebApp: sdk, Telegram: { WebApp: sdk }, addEventListener() {}, miniProbe(stage) { probes.push(stage); } };
  if (pendingTrial) window.localStorage = { getItem() { return 'notifications'; } };
  const sandbox = {
    window, location, URL, URLSearchParams, TextDecoder, Uint8Array, atob, AbortSignal, navigator: {},
    document: { querySelector(selector) { return selector === '#app' ? root : selector === '#landing' ? landing : null; } },
    history: { state: {}, replaceState(state, unused, url) { navigations.push(String(url)); location.href = String(url); }, pushState() { assert.fail('Launch should replace rather than push history'); } },
    recordPage(value) { pages.push(value); }, recordDetail(value) { details.push(value); },
    async fetch(path, options = {}) {
      requests.push({ path, authorization: options.headers?.authorization });
      if (path.startsWith('/api/shares/')) return { ok: true, status: 200, json: async () => ({ id: 'public-recipe', title: 'Публичный рецепт' }) };
      const authorization = options.headers?.authorization || '';
      assert.ok(authorization.startsWith(platform === 'max' ? 'mxa ' : 'tma '));
      // The mock API checks the actual signed data; unsafe SDK identity is never trusted.
      const identity = validateMaxInitData(authorization.slice(4), secret);
      assert.equal(identity.id, 'max:123');
      if (authFails) return { ok: false, status: 401, json: async () => ({ error: 'Авторизация отклонена' }) };
      let response;
      if (path === '/api/me') response = { id: identity.id, displayName: identity.first_name, platform, chatStarted };
      else if (path === '/api/library') response = { recipes: [], jobs: [] };
      else if (path === '/api/billing/offer') response = { active: pendingTrial || paymentStatus === 'paid' || firstUnlocked, available: !!paymentStatus || trialEligible, mode: paymentStatus || trialEligible ? 'provider' : undefined, trial: trialEligible || firstGate ? { eligible: true, used: false } : undefined, firstRecipe: firstGate || firstUnlocked || guide ? { awaitingTrial: firstGate, trialGateUsed: true } : undefined, pendingFirstRecipe: firstGate || firstUnlocked ? { recipeId: generatedKey, title: 'Выбранная паста', unlocked: firstUnlocked } : undefined };
      else if (path === '/api/dinner/profile' && guide) response = { preferredCategories: { pasta: 1 }, dishPreferences: {}, tastePreferencesStatus: 'pending' };
      else if (path.startsWith('/api/billing/orders/')) response = { id: decodeURIComponent(path.split('/').at(-1)), status: paymentStatus };
      else if (/^\/api\/(?:dinner\/)?recipes\//.test(path)) response = { id: decodeURIComponent(path.split('/').at(-1)), title: 'Выбранный рецепт' };
      else assert.fail(`Unexpected request (including AI generation): ${path}`);
      return { ok: true, status: 200, json: async () => response };
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(bridgeSource, sandbox);
  // Keep the real boot, authentication, refresh, render routing and openRecipe fetch.
  // Replace only DOM-heavy page/dialog boundaries; the fixture never invokes AI.
  vm.runInContext(appSource.replace(/boot\(\);\s*$/, '') + `
    paymentResultPage = () => recordPage('payment:' + state.checkoutOrder?.status);
    benefitsPage = () => recordPage('benefits');
    providerOfferPage = () => recordPage('pricing');
    home = () => recordPage('home');
    mainMenuPage = () => recordPage('menu');
    collection = () => recordPage('collection');
    beginDinner = async () => recordPage('dinner');
    showDinnerTastePreferences = () => recordPage('guide:taste');
    trialOnboardingPage = () => recordPage('guide:' + state.trialOnboarding);
    notificationSettingsPage = async () => recordPage('guide:notifications-settings');
    recipeDetail = (recipe, options) => recordDetail({ recipe, shared: options?.shared === true });
    closeOverlay = () => {};
    window.runBoot = boot;
    window.getAuthenticatedId = () => state.me?.id;
  `, sandbox);
  const initialRoute = window.RecipePlatform.initialRoute;
  window.RecipePlatform = { ...window.RecipePlatform, initialRoute() { assert.equal(window.getAuthenticatedId(), 'max:123'); return initialRoute(); } };
  await window.runBoot();
  return { location, requests, pages, details, probes, navigations, root, window };
}

test('MAX generated recipe payload replaces registered dinner URL after signed authentication and opens that recipe', async () => {
  const f = await bootFixture({ route: { recipe: generatedKey, userId: 'foreign-user', url: 'https://foreign.test' } });
  assert.equal(f.location.searchParams.get('recipe'), generatedKey);
  assert.equal(f.location.searchParams.has('view'), false);
  assert.deepEqual(f.pages, ['home']);
  assert.equal(f.details[0]?.recipe.id, generatedKey);
  assert.equal(f.window.getAuthenticatedId(), 'max:123');
  assert.deepEqual(f.requests.map(request => request.path), ['/api/me', '/api/library', '/api/billing/offer', `/api/dinner/recipes/${encodeURIComponent(generatedKey)}`]);
  assert.equal(f.navigations.length, 1);
  assert.equal(f.location.origin, 'https://recipes.test');
  assert.equal(f.location.searchParams.has('userId'), false);
});

test('MAX raw signed start_param opens recipe when initDataUnsafe does not contain it', async () => {
  const f = await bootFixture({ route: { recipe: generatedKey }, unsafe: false });
  assert.equal(f.details[0]?.recipe.id, generatedKey);
  assert.equal(f.location.searchParams.get('recipe'), generatedKey);
});

test('MAX WebAppStartParam opens recipe from ordinary, legacy second-question-mark and hash launches', async () => {
  const encoded = encode({ recipe: generatedKey });
  for (const options of [
    { search: `?WebAppStartParam=${encoded}` },
    { search: `?view=dinner?WebAppStartParam=${encoded}` },
    { search: '?view=dinner', hash: `#WebAppStartParam=${encoded}` }
  ]) {
    const f = await bootFixture({ ...options, unsafe: false });
    assert.equal(f.details[0]?.recipe.id, generatedKey);
    assert.equal(f.requests.at(-1).path, `/api/dinner/recipes/${encodeURIComponent(generatedKey)}`);
    assert.equal(f.location.searchParams.get('recipe'), generatedKey);
  }
});

test('signed SDK payload takes precedence over URL hints and explicit MAX recipe bypasses pending trial onboarding', async () => {
  const f = await bootFixture({ route: { recipe: generatedKey }, search: `?view=dinner?WebAppStartParam=${encode({ recipe: 'foreign-recipe', url: 'https://foreign.test' })}`, pendingTrial: true });
  assert.equal(f.details[0]?.recipe.id, generatedKey);
  assert.equal(f.requests.at(-1).path, `/api/dinner/recipes/${encodeURIComponent(generatedKey)}`);
  assert.equal(f.location.searchParams.get('recipe'), generatedKey);
});

test('MAX malformed and duplicate URL navigation hints preserve existing recipe URLs', async () => {
  for (const suffix of [
    '&WebAppStartParam=invalid!',
    `&WebAppStartParam=${encode({ recipe: '../foreign', view: 'https://foreign.test', userId: 'foreign-user' })}`,
    `&WebAppStartParam=${encode({ recipe: generatedKey })}&WebAppStartParam=${encode({ recipe: 'foreign-recipe' })}`
  ]) {
    const f = await bootFixture({ search: '?view=collection&recipe=private-recipe' + suffix, unsafe: false });
    assert.equal(f.navigations.length, 0);
    assert.equal(f.location.origin, 'https://recipes.test');
    assert.equal(f.details.length, 1);
    assert.equal(f.details[0].recipe.id, 'private-recipe');
  }
});

test('MAX seed catalog recipe keys retain their namespace', async () => {
  for (const recipe of SEED_RECIPES) {
    const f = await bootFixture({ route: { recipe: recipe.id }, unsafe: false });
    assert.equal(f.details[0]?.recipe.id, recipe.id);
    assert.equal(f.requests.at(-1).path, `/api/dinner/recipes/${encodeURIComponent(recipe.id)}`);
  }
});

test('invalid MAX payload preserves direct recipe URL and no payload preserves registered dinner page', async () => {
  for (const payload of ['invalid!', encode({ recipe: 'https://foreign.test' }), encode({ recipe: 'seed:../../foreign' }), encode({ recipe: 'dinner:extra:namespace' })]) {
    const f = await bootFixture({ payload, search: '?view=collection&recipe=private-recipe' });
    assert.equal(f.location.search, '?view=collection&recipe=private-recipe');
    assert.equal(f.details[0]?.recipe.id, 'private-recipe');
    assert.equal(f.navigations.length, 0);
  }
  const f = await bootFixture();
  assert.deepEqual(f.pages, ['dinner']);
  assert.equal(f.navigations.length, 0);
});

test('failed MAX authentication never applies payload or requests recipe', async () => {
  const f = await bootFixture({ route: { recipe: generatedKey }, authFails: true });
  assert.deepEqual(f.requests.map(request => request.path), ['/api/me']);
  assert.equal(f.location.search, '?view=dinner');
  assert.equal(f.navigations.length, 0);
  assert.equal(f.details.length, 0);
  assert.match(f.root.innerHTML, /Авторизация отклонена/);
});

test('Telegram query route and public share startup ignore MAX navigation', async () => {
  const telegram = await bootFixture({ platform: 'telegram', route: { recipe: generatedKey }, search: '?view=collection&recipe=telegram-recipe' });
  assert.equal(telegram.details[0]?.recipe.id, 'telegram-recipe');
  assert.equal(telegram.navigations.length, 0);
  const shared = await bootFixture({ route: { recipe: generatedKey }, shared: true });
  assert.equal(shared.details[0]?.recipe.id, 'public-recipe');
  assert.equal(shared.details[0]?.shared, true);
  assert.deepEqual(shared.requests.map(request => request.path), ['/api/shares/' + 'a'.repeat(32)]);
  assert.equal(shared.navigations.length, 0);
});

test('MAX payment return retrieves its exact owned order and bypasses pending onboarding', async () => {
  const order = '12345678-1234-1234-1234-123456789012';
  for (const status of ['pending','paid']) {
    const f = await bootFixture({route:{view:'payment-result',order},paymentStatus:status,pendingTrial:true});
    assert.ok(f.requests.some(r=>r.path === '/api/billing/orders/'+order));
    assert.deepEqual(f.pages,['payment:'+status]);
    assert.equal(new URLSearchParams(f.location.search).get('order'),order);
  }
});

test('MAX benefits and pricing open through signed SDK and URL-only payload after authentication', async () => {
  for (const view of ['benefits', 'pricing']) {
    const expected = view === 'pricing' ? 'pricing' : 'benefits';
    const sdk = await bootFixture({ route: { view }, trialEligible: true, unsafe: false });
    assert.deepEqual(sdk.pages, [expected]);
    assert.equal(sdk.location.searchParams.get('view'), view);
    const url = await bootFixture({ search: '?WebAppStartParam=' + encode({ view }), trialEligible: true, unsafe: false });
    assert.deepEqual(url.pages, [expected]);
    assert.equal(url.location.searchParams.get('view'), view);
    for (const f of [sdk, url]) assert.deepEqual(f.requests.map(r => r.path), ['/api/me', '/api/library', '/api/billing/offer']);
  }
});


test('pending first choice survives fresh boot and recipe deep links on MAX and Telegram without fetching full ingredients', async () => {
  for (const platform of ['max', 'telegram']) {
    for (const search of ['', '?view=dinner', '?view=collection&recipe=' + encodeURIComponent(generatedKey)]) {
      const f = await bootFixture({ platform, search, firstGate: true });
      assert.deepEqual(f.pages, ['benefits']);
      assert.equal(f.location.searchParams.get('view'), 'benefits');
      assert.deepEqual(f.requests.map(r => r.path), ['/api/me', '/api/library', '/api/billing/offer']);
      assert.equal(f.details.length, 0);
    }
  }
});

test('pending first choice permits explicit pricing, promo, feedback and menu navigation', async () => {
  for (const view of ['pricing', 'menu']) {
    const f = await bootFixture({ search: '?view=' + view, firstGate: true, trialEligible: true });
    assert.deepEqual(f.pages, [view === 'pricing' ? 'pricing' : 'menu']);
    assert.equal(f.location.searchParams.get('view'), view);
  }
});


test('confirmed first trial reopens the same recipe from a stale benefits or offer launch on both platforms', async () => {
  for (const platform of ['max', 'telegram']) {
    for (const view of ['benefits', 'offer']) {
      const f = await bootFixture({ platform, search: '?view=' + view, firstUnlocked: true, pendingTrial: true });
      assert.deepEqual(f.pages, ['collection']);
      assert.equal(f.details[0]?.recipe.id, generatedKey);
      assert.equal(f.location.searchParams.get('recipe'), generatedKey);
      assert.deepEqual(f.requests.map(r => r.path), ['/api/me', '/api/library', '/api/billing/offer', '/api/dinner/recipes/' + encodeURIComponent(generatedKey)]);
    }
  }
});


test('explicit feature-guide route starts the old screens on both platforms after authentication without trial or recipe generation', async () => {
  for (const platform of ['max', 'telegram']) {
    const f = await bootFixture({ platform, search: '?view=trial-guide', pendingTrial: true, guide: true });
    assert.deepEqual(f.pages, ['guide:notifications']);
    assert.deepEqual(f.requests.map(r => r.path), ['/api/me', '/api/library', '/api/billing/offer']);
    assert.equal(f.location.searchParams.get('view'), 'trial-guide');
    const fresh = await bootFixture({ platform, search: '?view=trial-guide', firstUnlocked: true, guide: true });
    assert.deepEqual(fresh.pages, ['guide:taste']);
    assert.deepEqual(fresh.requests.map(r => r.path), ['/api/me', '/api/library', '/api/billing/offer', '/api/dinner/profile']);
    assert.equal(fresh.details.length, 0);
  }
});

test('MAX signed feature-guide launch is retained independently of generic recipe resume', async () => {
  const f = await bootFixture({ route: { view: 'trial-guide' }, firstUnlocked: true, guide: true, unsafe: false });
  assert.deepEqual(f.pages, ['guide:taste']);
  assert.equal(f.location.searchParams.get('view'), 'trial-guide');
  assert.equal(f.details.length, 0);
});


test('MAX app-first entry opens collection from registered base without changing explicit destinations', async () => {
  for (const search of ['', '?view=dinner', '?view=menu']) {
    const f = await bootFixture({ search, chatStarted: false });
    assert.deepEqual(f.pages, ['collection']);
    assert.equal(f.location.searchParams.get('view'), 'collection');
    assert.deepEqual(f.requests.map(r => r.path), ['/api/me', '/api/library', '/api/billing/offer']);
  }
  const linked = await bootFixture({ route: { recipe: generatedKey }, chatStarted: false });
  assert.equal(linked.details[0].recipe.id, generatedKey);
  const returning = await bootFixture({ chatStarted: true });
  assert.deepEqual(returning.pages, ['dinner']);
  const telegram = await bootFixture({ platform: 'telegram', chatStarted: false });
  assert.deepEqual(telegram.pages, ['dinner']);
});

test('entry failure has retry and a platform chat link without discarding requested route', async () => {
  for (const platform of ['max', 'telegram']) {
    const f = await bootFixture({ platform, search: '?view=collection&recipe=private-recipe', authFails: true });
    assert.match(f.root.innerHTML, /id="entry-retry"/);
    assert.match(f.root.innerHTML, /id="entry-open-bot"/);
    assert.match(f.root.innerHTML, platform === 'max' ? /https:\/\/max.ru\// : /https:\/\/t.me\//);
    assert.equal(f.location.search, '?view=collection&recipe=private-recipe');
    assert.equal(f.navigations.length, 0);
  }
});
