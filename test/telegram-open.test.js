import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { telegramOpenDocument } from '../src/telegram-open.js';

const script = fs.readFileSync(new URL('../public/telegram-open.js', import.meta.url), 'utf8');
function browser({ visibility = 'visible', failScheme = false } = {}) {
  const events = {}, timers = new Map(), navigation = [];
  const link = { href: 'https://t.me/recipeboi_test_bot?start=dinner',
    dataset: { appUrl: 'tg://resolve?domain=recipeboi_test_bot&start=dinner' },
    addEventListener(name, callback) { events[name] = callback; } };
  const status = {};
  const document = { visibilityState: visibility,
    getElementById(id) { return id === 'telegram-fallback' ? link : status; },
    addEventListener(name, callback) { events[name] = callback; } };
  vm.runInNewContext(script, {
    document, window: { addEventListener(name, callback) { events[name] = callback; } },
    location: {
      assign(url) { if (failScheme) throw new Error('scheme rejected'); navigation.push(url); },
      replace(url) { navigation.push(url); }
    },
    setTimeout(callback) { timers.set(1, callback); return 1; },
    clearTimeout(id) { timers.delete(id); }
  });
  return { navigation, timers, document, events };
}

test('automatic app attempt needs no button click and fallback retains the payload', () => {
  const b = browser();
  assert.deepEqual(b.navigation, ['tg://resolve?domain=recipeboi_test_bot&start=dinner']);
  b.timers.get(1)();
  assert.deepEqual(b.navigation, ['tg://resolve?domain=recipeboi_test_bot&start=dinner',
    'https://t.me/recipeboi_test_bot?start=dinner']);
});
test('leaving for the app cancels fallback and returning does not launch it again', () => {
  for (const event of ['visibilitychange', 'pagehide', 'click']) {
    const b = browser(), pending = b.timers.get(1);
    b.document.visibilityState = 'hidden'; b.events[event]();
    assert.equal(b.timers.size, 0);
    b.document.visibilityState = 'visible'; b.events.visibilitychange(); pending();
    assert.equal(b.navigation.length, 1);
  }
});
test('opening in a background tab waits until visible and attempts only once', () => {
  const b = browser({ visibility: 'hidden' });
  assert.equal(b.navigation.length, 0);
  b.document.visibilityState = 'visible'; b.events.visibilitychange(); b.events.visibilitychange();
  assert.equal(b.navigation.length, 1);
});
test('synchronous scheme rejection immediately falls back without a second timer navigation', () => {
  const b = browser({ failScheme: true });
  assert.deepEqual(b.navigation, ['https://t.me/recipeboi_test_bot?start=dinner']);
  assert.equal(b.timers.size, 0);
});
test('document retains exact advertising payload in both destinations and excludes arbitrary hosts', () => {
  const html = telegramOpenDocument('https://t.me/Recipeboibot?start=ad_abcdefghijklmnopqrstuvwx');
  assert.ok(html.includes('tg://resolve?domain=Recipeboibot&amp;start=ad_abcdefghijklmnopqrstuvwx'));
  assert.ok(html.includes('https://t.me/Recipeboibot?start=ad_abcdefghijklmnopqrstuvwx'));
  for (const url of ['https://evil.example/Recipeboibot?start=dinner',
    'https://t.me/Recipeboibot?start=%22%3E%3Cscript%3E',
    'https://t.me/Recipeboibot?start=dinner&url=https://evil.example',
    'https://t.me/Recipeboibot?start=dinner#other']) {
    assert.throws(() => telegramOpenDocument(url), { status: 400 });
  }
});
