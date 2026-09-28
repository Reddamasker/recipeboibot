import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync('public/app.js', 'utf8');
const handler = source.slice(source.indexOf('function clearImportError('), source.indexOf('\nfunction closeDetailRoute()'));

function fixture(tab = 'text') {
  let focused, closed = 0, offers = 0;
  const requests = [], notices = [], opened = [];
  const element = (props = {}) => ({
    attributes: {}, ...props,
    setAttribute(key, value) { this.attributes[key] = value; },
    removeAttribute(key) { delete this.attributes[key]; },
    focus() { focused = this; },
  });
  const button = element({ disabled: false, textContent: 'Сохранить' });
  const message = element({ id: 'import-error', hidden: true, textContent: '' });
  const text = element({ value: '' }), file = element({ files: [] }), caption = element({ value: '' });
  const tabs = [element(), element(), element()];
  const controls = { '#source-value': text, '#source-file': file, '#source-caption': caption, '#import-error': message, 'button[type=submit]': button };
  const form = element({ isConnected: true, querySelector: (key) => controls[key], querySelectorAll: () => [text, file].filter(el => el.attributes['aria-invalid'] === 'true'), closest: () => ({ querySelectorAll: () => tabs }) });
  const sandbox = {
    state: { tab }, URL, TypeError,
    api: async (url, options) => { requests.push([url, JSON.parse(options.body)]); return { recipe: { id: 'saved' } }; },
    closeOverlay() { closed++; form.isConnected = false; }, refresh: async () => {}, render: async () => {},
    openRecipe: async (id) => opened.push(id), openOffer() { offers++; }, toast: value => notices.push(value),
    FileReader: class { readAsDataURL() { this.result = 'data:image/png;base64,dGVzdA=='; this.onload(); } },
  };
  vm.runInNewContext(handler, sandbox);
  return { sandbox, button, message, text, file, caption, tabs, form, requests, notices, opened,
    get focused() { return focused; }, get closed() { return closed; }, get offers() { return offers; },
    submit: () => sandbox.submitImport({ preventDefault() {}, currentTarget: form }) };
}

test('empty import is a persistent field error, not a transient toast', async () => {
  const f = fixture();
  await f.submit();
  assert.equal(f.requests.length, 0);
  assert.equal(f.message.hidden, false);
  assert.match(f.message.textContent, /Вставьте текст/);
  assert.equal(f.text.attributes['aria-describedby'], 'import-error');
  assert.equal(f.text.attributes['aria-invalid'], 'true');
  assert.equal(f.focused, f.text);
  assert.equal(f.button.disabled, false);
  assert.deepEqual(f.notices, []);
  f.sandbox.clearImportError(f.form);
  assert.equal(f.message.hidden, true);
  assert.equal(f.text.attributes['aria-invalid'], undefined);
  assert.equal(f.text.attributes['aria-describedby'], undefined);
});

test('link import rejects malformed or unsafe protocols and retains valid source text', async () => {
  for (const value of ['not a link', 'javascript:alert(1)', 'file:///a']) {
    const f = fixture('url'); f.text.value = value; await f.submit();
    assert.equal(f.requests.length, 0); assert.equal(f.text.value, value);
    assert.equal(f.message.hidden, false); assert.equal(f.focused, f.text);
  }
  const f = fixture('url'); f.text.value = 'https://example.com/recipe'; await f.submit();
  assert.deepEqual(f.requests[0], ['/api/import', { kind: 'url', value: f.text.value }]);
  assert.deepEqual(f.opened, ['saved']);
});

test('playlist import reports a batch result without opening one recipe', async () => {
  const f = fixture('url'); f.text.value = 'https://youtube.com/playlist?list=PL1234567890';
  f.sandbox.api = async () => ({ state: 'playlist', accepted: true, limit: 30 });
  await f.submit();
  assert.equal(f.closed, 1);
  assert.deepEqual(f.opened, []);
  assert.match(f.notices[0], /Плейлист принят/);
});

test('photo validation handles missing and oversized files, valid photo retains caption', async () => {
  const f = fixture('image'); await f.submit();
  assert.match(f.message.textContent, /Выберите фото/);
  f.file.files = [{ size: 7 * 1024 * 1024 }]; await f.submit();
  assert.match(f.message.textContent, /6 МБ/); assert.equal(f.requests.length, 0);
  f.file.files = [{ size: 1024, type: 'image/png' }]; f.caption.value = 'Из тетради';
  await f.submit();
  assert.deepEqual(f.requests[0][1], { kind: 'image', value: 'dGVzdA==', mime: 'image/png', caption: 'Из тетради' });
});

test('failed request keeps draft, restores controls and succeeds on explicit retry', async () => {
  const f = fixture(); f.text.value = 'Рецепт с ингредиентами';
  const success = f.sandbox.api;
  f.sandbox.api = async () => { throw new TypeError('Failed to fetch'); };
  await f.submit();
  assert.equal(f.closed, 0); assert.equal(f.message.hidden, false);
  assert.match(f.message.textContent, /Проверьте соединение/);
  assert.equal(f.text.value, 'Рецепт с ингредиентами'); assert.equal(f.focused, f.message);
  assert.equal(f.text.attributes['aria-invalid'], undefined);
  assert.equal(f.button.textContent, 'Повторить сохранение');
  assert.equal(f.button.disabled, false); assert.ok(f.tabs.every(tab => !tab.disabled));
  assert.equal(f.form.attributes['aria-busy'], undefined); assert.deepEqual(f.notices, []);
  f.sandbox.api = success; await f.submit();
  assert.equal(f.closed, 1); assert.deepEqual(f.opened, ['saved']);
});

test('in-flight import locks source tabs and suppresses duplicate submits', async () => {
  const f = fixture(); f.text.value = 'Рецепт'; let finish, calls = 0;
  f.sandbox.api = () => { calls++; return new Promise(resolve => { finish = resolve; }); };
  const first = f.submit(); await f.submit();
  assert.equal(calls, 1); assert.ok(f.tabs.every(tab => tab.disabled));
  assert.equal(f.form.attributes['aria-busy'], 'true');
  finish({ state: 'processing' }); await first;
  assert.equal(f.closed, 1); assert.ok(f.tabs.every(tab => !tab.disabled));
});

test('closed form ignores a late error; access-required response preserves offer route', async () => {
  const f = fixture(); f.text.value = 'Рецепт';
  f.sandbox.api = async () => { f.form.isConnected = false; throw new Error('Offline'); };
  await f.submit(); assert.equal(f.message.hidden, true); assert.equal(f.focused, undefined);
  const g = fixture(); g.text.value = 'Рецепт';
  g.sandbox.api = async () => { throw Object.assign(new Error('Access required'), { status: 402 }); };
  await g.submit(); assert.equal(g.closed, 1); assert.equal(g.offers, 1);
});

test('dismissed successful request cannot close a newer dialog; refresh failure is not an import failure', async () => {
  const f = fixture(); f.text.value = 'Рецепт';
  f.sandbox.api = async () => { f.form.isConnected = false; return { recipe: { id: 'saved' } }; };
  await f.submit(); assert.equal(f.closed, 0); assert.deepEqual(f.opened, []);
  const g = fixture(); g.text.value = 'Рецепт';
  g.sandbox.refresh = async () => { throw new Error('Offline'); };
  await g.submit(); assert.equal(g.closed, 1);
  assert.match(g.notices[0], /Источник получен/);
});
