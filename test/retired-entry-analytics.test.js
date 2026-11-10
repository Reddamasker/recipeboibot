import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

for (const file of ['public/app.js', 'public/review/recime-20261109/core.js']) test(`${file}: a retired launch URL never counts the boot placeholder as its former screen`, () => {
  const source = fs.readFileSync(file, 'utf8');
  const start = source.indexOf("if (globalThis.window?.RecipeAnalytics && typeof MutationObserver");
  const end = source.indexOf('\nfunction entryRecovery(', start);
  const observed = [], callbacks = [], state = { me: null };
  const screen = { matches: () => false };
  const root = { dataset: { analyticsStep: 'collection' }, querySelector: selector => selector.startsWith('main,') ? screen : null };
  const window = { __miniRendered: false, RecipeAnalytics: { step() {}, observe: (...args) => observed.push(args) } };
  const context = { state, root, window, URLSearchParams, location: { search: '?view=trial-guide' }, latestRecipeFlow: null,
    MutationObserver: class { constructor(callback) { callbacks.push(callback); } observe() {} },
    document: { body: {}, querySelector: () => null, addEventListener() {} } };
  vm.runInNewContext(source.slice(start, end), context);
  assert.equal(observed.length, 0);
  state.me = { id: 'verified' }; callbacks[0]();
  assert.equal(observed.length, 0, 'authentication alone does not establish a visible rendered screen');
  window.__miniRendered = true; callbacks[0](); callbacks[1]();
  assert.equal(observed.length, 1);
  assert.deepEqual(observed[0], [screen, 'screen_view', 'collection']);
});
