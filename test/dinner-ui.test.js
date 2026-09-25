import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

test('Mini App signals Telegram readiness before rendering and records its startup stage', () => {
  const index = fs.readFileSync('public/index.html', 'utf8');
  assert.ok(index.indexOf('/mini-boot.js?v=1') < index.indexOf('/vendor/telegram-web-app.js?v=20260714'));
  assert.ok(index.indexOf('/vendor/telegram-web-app.js?v=20260714') < index.indexOf('/app.js?v=dinner-10.2'));
  const stages = [];
  let poll;
  const window = { addEventListener() {} };
  vm.runInNewContext(fs.readFileSync('public/mini-boot.js', 'utf8'), {
    window,
    fetch: async (url) => { stages.push(new URL(url, 'https://test.local').searchParams.get('mini')); },
    setInterval(callback) { poll = callback; return 1; },
    setTimeout() {},
  });
  let readyCalls = 0;
  window.Telegram = { WebApp: { ready() { readyCalls += 1; } } };
  poll();
  poll();
  assert.equal(readyCalls, 1);
  assert.deepEqual(stages, ['boot-script', 'telegram-ready']);
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
