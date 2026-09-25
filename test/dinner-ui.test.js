import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

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
