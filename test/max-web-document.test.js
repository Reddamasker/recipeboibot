import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { buildWebDocument } from '../src/web-document.js';

const bridgeSource = fs.readFileSync('public/platform-bridge.js', 'utf8');
function bridgeFixture(name, app = {}) {
  const opened = [], shared = [];
  const window = { __recipePlatform: { name, botUsername: 'recipe_max_bot' },
    WebApp: { initData: 'signed-max-data', openMaxLink(url) { opened.push(url); }, shareMaxContent(input) { shared.push(input); }, ...app },
    Telegram: { WebApp: { initData: 'signed-telegram-data', openTelegramLink(url) { opened.push(url); } } } };
  vm.runInNewContext(bridgeSource, { window, URL, URLSearchParams, TextDecoder, Uint8Array, atob, navigator: {} });
  return { bridge: window.RecipePlatform, opened, shared, window };
}

test('MAX document loads its SDK before app, with platform bootstrap before boot and valid inline hashes', () => {
  const document = buildWebDocument(path.resolve('public'), { botPlatform: 'max', botUsername: 'recipe_max_bot' });
  const html = document.bytes.toString();
  assert.match(html, /<script src="https:\/\/st.max.ru\/js\/max-web-app.js"><\/script>/);
  const choices = html.match(/<div class="lp-platforms"[\s\S]*?<\/div>/)[0];
  const choiceLabels = choices.replace(/<[^>]+>/g, '');
  assert.match(choiceLabels, /Попробовать бесплатно в Telegram/);
  assert.match(choiceLabels, /Попробовать бесплатно в MAX/);
  assert.match(choices, /href="https:\/\/t\.me\/Recipeboibot\?start=save"/);
  assert.match(choices, /href="\/open\/recipe-bot\/max"/);
  assert.doesNotMatch(html.replace(/<div class="lp-platforms"[\s\S]*?<\/div>/g, ''), /TelegramWebviewProxy=function|href="https:\/\/t\.me\/Recipeboibot\?start=/);
  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.ok(inline[0][1].indexOf('window.__recipePlatform=') < inline[0][1].indexOf("report('boot-script')"));
  assert.ok(html.indexOf('https://st.max.ru/js/max-web-app.js') < html.indexOf("window.miniProbe?.('app-script')"));
  assert.match(html, /href="https:\/\/max.ru\/recipe_max_bot\?start=save"/);
  assert.match(html, /список покупок в MAX/);
  for (const [, source] of inline) {
    new vm.Script(source);
    assert.ok(document.scriptHashes.includes(`'sha256-${createHash('sha256').update(source).digest('base64')}'`));
  }
});

test('platform is explicit, auth uses only raw SDK initData, and MAX navigation never uses Telegram', async () => {
  const max = bridgeFixture('max', { initDataUnsafe: { user: { id: 'untrusted-user' } } });
  assert.equal(max.bridge.authHeader(), 'mxa signed-max-data');
  max.bridge.openBot('ingredients');
  assert.deepEqual(max.opened, ['https://max.ru/recipe_max_bot?start=ingredients']);
  await max.bridge.share({ title: 'Рецепт', text: 'Смотри рецепт', url: 'https://recipes.test/share/abc' });
  assert.equal(max.shared[0].link, 'https://recipes.test/share/abc');
  assert.equal(max.opened.length, 1);
  const telegram = bridgeFixture(undefined);
  assert.equal(telegram.bridge.name, 'telegram');
  assert.equal(telegram.bridge.authHeader(), 'tma signed-telegram-data');
  telegram.bridge.setProfile({ botUsername: 'recipeboi_test_bot' });
  assert.equal(telegram.bridge.botUrl('dish'), 'https://t.me/recipeboi_test_bot?start=dish');
});

test('MAX start payload provides only bounded route fields, never authentication or account identity', () => {
  const encoded = Buffer.from(JSON.stringify({ view: 'dinner', notification: '12345678-1234-1234-1234-123456789012', userId: 'other-user', token: 'secret', url: 'https://other.test' })).toString('base64url');
  const { bridge } = bridgeFixture('max', { initDataUnsafe: { start_param: encoded } });
  assert.deepEqual(JSON.parse(JSON.stringify(bridge.initialRoute())), { view: 'dinner', notification: '12345678-1234-1234-1234-123456789012' });
  for (const start_param of ['invalid!', 'a'.repeat(513), Buffer.from('{bad-json').toString('base64url'), Buffer.from(JSON.stringify({ view: 'https://other.test', recipe: '../secret' })).toString('base64url')]) {
    assert.equal(bridgeFixture('max', { initDataUnsafe: { start_param } }).bridge.initialRoute(), null);
  }
});

test('MAX route payload preserves Unicode search queries and every existing view without accepting arbitrary parameters', () => {
  for (const view of ['menu', 'dinner', 'collection', 'offer', 'benefits', 'pricing', 'feedback', 'notifications', 'results', 'request', 'search', 'add', 'promo', 'checkout', 'payment-result', 'trial-onboarding', 'trial-guide']) {
    const input = { view, q: 'Ужин из риса без орехов', userId: 'other-account', url: 'https://other.test', payment: 'paid' };
    const encoded = Buffer.from(JSON.stringify(input)).toString('base64url');
    const { bridge } = bridgeFixture('max', { initDataUnsafe: { start_param: encoded } });
    const expected = ['results', 'request', 'search'].includes(view) ? { view, q: input.q } : { view };
    assert.deepEqual(JSON.parse(JSON.stringify(bridge.initialRoute())), expected);
    assert.equal(bridge.authHeader(), 'mxa signed-max-data');
  }
  for (const q of ['bad\u0000query', 123, { userId: 'other' }]) {
    const encoded = Buffer.from(JSON.stringify({ view: 'results', q })).toString('base64url');
    assert.deepEqual(JSON.parse(JSON.stringify(bridgeFixture('max', { initDataUnsafe: { start_param: encoded } }).bridge.initialRoute())), { view: 'results' });
  }
});

test('MAX boot reveals authenticated app shell and signals ready without a Telegram native event', () => {
  const stages = [], app = { hidden: true }, landing = { hidden: false };
  let ready = 0;
  const { window } = bridgeFixture('max', { ready() { ready++; } });
  window.addEventListener = () => {};
  window.TelegramWebviewProxy = { postEvent() { assert.fail('MAX must not use Telegram bridge'); } };
  vm.runInNewContext(fs.readFileSync('public/mini-boot.js', 'utf8'), {
    window, location: { hash: '#WebAppData=signed' },
    document: { addEventListener() {}, documentElement: {}, querySelector: selector => selector === '#app' ? app : landing },
    fetch: url => { stages.push(new URL(url, 'https://recipes.test').searchParams.get('mini')); return Promise.resolve(); },
    MutationObserver: class { observe() {} disconnect() {} }, setInterval() {}, setTimeout() {}, clearInterval() {}
  });
  assert.equal(app.hidden, false);
  assert.equal(landing.hidden, true);
  assert.equal(ready, 1);
  assert.deepEqual(stages, ['boot-script', 'max-ready']);
});

test('MAX launch navigation is read only after /api/me authentication succeeds', () => {
  const source = fs.readFileSync('public/app.js', 'utf8');
  const boot = source.slice(source.indexOf('async function boot()'));
  assert.ok(boot.indexOf("await api('/api/me'") < boot.indexOf('initialRoute()'));
  assert.match(source, /authorization: window\.RecipePlatform\?\.authHeader\(\)/);
});

test('MAX application startup works with the official SDK shape without Telegram ready or expand methods', () => {
  const { window } = bridgeFixture('max');
  assert.equal(window.WebApp.ready, undefined);
  assert.equal(window.WebApp.expand, undefined);
  const source = fs.readFileSync('public/app.js', 'utf8');
  vm.runInNewContext(source.slice(0, source.indexOf('const esc =')) + '\nwindow.startupAuth = window.RecipePlatform.authHeader();', { window, document: { querySelector: () => ({}) } });
  assert.equal(window.startupAuth, 'mxa signed-max-data');
});

test('MAX boot finishes when its SDK has no ready method and does not report a missing bridge', () => {
  const stages = [], timers = [], app = { hidden: true }, landing = { hidden: false };
  const { window } = bridgeFixture('max'); window.addEventListener = () => {};
  vm.runInNewContext(fs.readFileSync('public/mini-boot.js', 'utf8'), {
    window, location: { hash: '#WebAppData=signed' }, document: { addEventListener() {}, documentElement: {}, querySelector: selector => selector === '#app' ? app : landing },
    fetch: url => { stages.push(new URL(url, 'https://recipes.test').searchParams.get('mini')); return Promise.resolve(); },
    MutationObserver: class { observe() {} disconnect() {} }, setInterval() {}, setTimeout(fn, delay) { timers.push({ fn, delay }); }, clearInterval() {}
  });
  timers.find(timer => timer.delay === 10000).fn();
  assert.equal(app.hidden, false); assert.equal(landing.hidden, true);
  assert.deepEqual(stages, ['boot-script', 'max-ready']);
});
