import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

test('Mini App does not repeat chat onboarding; preferences open only on request', async () => {
  const source = fs.readFileSync('public/app.js', 'utf8');
  const handler = source.slice(source.indexOf('async function beginDinner('), source.indexOf('\nasync function showDinnerOnboarding'));
  let needsOnboarding = true, questions = 0, recipes = 0;
  const sandbox = { state: {}, dinnerPollTimer: null, clearTimeout() {}, AbortSignal,
    api: async () => ({ sessionId: 'fresh', profile: {}, needsOnboarding }),
    showDinnerOnboarding: async () => { questions++; }, loadDinnerRecommendation: async () => { recipes++; },
    toast: assert.fail, setRoute() {}, home() {} };
  vm.runInNewContext(handler, sandbox);
  await sandbox.beginDinner(); assert.equal(questions, 0); assert.equal(recipes, 1);
  needsOnboarding = false;
  await sandbox.beginDinner(); assert.equal(questions, 0); assert.equal(recipes, 2);
  await sandbox.beginDinner(true); assert.equal(questions, 1);
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

test('Mini App hides the landing and exposes the app shell before signaling readiness', () => {
  const index = fs.readFileSync('public/index.html', 'utf8');
  assert.ok(index.indexOf('/mini-boot.js?v=3') < index.indexOf('/styles.css?v=8.1'));
  assert.ok(index.indexOf('/vendor/telegram-web-app.js?v=20260714') < index.indexOf('/app.js?v=dinner-10.3'));
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
