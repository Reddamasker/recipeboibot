import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function fixture(options = {}) {
  const scripts = [], calls = [];
  const root = { hidden: false, getClientRects: () => [1] };
  const window = { beTracker: { t: data => calls.push(data) } };
  window.self = window; window.top = options.frame ? {} : window;
  if (options.mini) window.__miniLaunch = true;
  const document = { visibilityState: options.hidden ? 'hidden' : 'visible', getElementById: () => root,
    querySelector: () => options.disabled ? null : {}, createElement: () => ({}), head: { append: script => scripts.push(script) } };
  const context = vm.createContext({ window, document, location: new URL('https://dishfinder.ru/' + (options.query || '')),
    navigator: { userAgent: 'Browser' }, localStorage: { getItem: () => options.internal ? Date.now() + 60000 : null }, URLSearchParams });
  vm.runInContext(fs.readFileSync('public/landing-metricool.js', 'utf8').replace('export function', 'function') + ';start();start();', context);
  return { scripts, calls, root, window, document };
}
test('Metricool sends one view with owner hash; failed SDK does not throw', () => {
  const p = fixture({ query: '?utm_source=test' });
  assert.equal(p.scripts.length, 1);
  assert.equal(p.scripts[0].src, 'https://tracker.metricool.com/resources/be.js');
  p.scripts[0].onload(); p.scripts[0].onload();
  assert.equal(p.calls.length, 1);
  assert.equal(p.calls[0].hash, 'f7b60bf68b13d4e147d33e409a82c004');
  const failed = fixture(); failed.window.beTracker.t = () => { throw Error('offline'); };
  assert.doesNotThrow(() => failed.scripts[0].onerror());
  assert.doesNotThrow(() => failed.scripts[0].onload());
});
test('Metricool excludes private/hidden/internal/embedded/nonproduction views and late Mini App launch', () => {
  for (const options of [{ hidden: true }, { internal: true }, { mini: true }, { frame: true }, { disabled: true },
    { query: '?view=collection' }, { query: '?token=secret' }, { query: '#tgWebAppData=secret' }]) {
    assert.equal(fixture(options).scripts.length, 0, JSON.stringify(options));
  }
  const p = fixture(); p.window.__miniLaunch = true; p.scripts[0].onload(); assert.equal(p.calls.length, 0);
});
