import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

process.env.DATABASE_PATH = path.resolve('data', `test-contour-${process.pid}.sqlite`);
process.env.TELEGRAM_BOT_TOKEN = '123456:test-contour-test';
process.env.TEST_CONTOUR = 'true';
process.env.TEST_OWNER_TELEGRAM_ID = '75101';
process.env.TEST_BOT_USERNAME = 'recipeboi_test_bot';
process.env.DINNER_LLM_ENABLED = 'false';
process.env.DINNER_IMAGES_ENABLED = 'false';
const store = await import('../src/db.js');
const { getFoodProfile, saveFoodProfile } = await import('../src/dinner-store.js');
const { createServer } = await import('../src/server.js');
const { makeTelegramInitData } = await import('../src/security.js');
const { handleMessage, handleTestResetCallback, startTelegramPolling } = await import('../src/telegram.js');
const { buildWebDocument } = await import('../src/web-document.js');

test.after(() => {
  store.db.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(process.env.DATABASE_PATH + suffix, { force: true });
});

test('owner can simulate payment outcomes and reset only the test account', async () => {
  const ownerTg = { id: 75101, first_name: 'Owner' };
  const otherTg = { id: 75102, first_name: 'Other' };
  const owner = store.upsertTelegramUser(ownerTg);
  store.allowUser(owner.id);
  await handleMessage({ from: otherTg, chat: { id: otherTg.id, type: 'private' }, text: '/start' });
  assert.equal(store.getUserByTelegramId(otherTg.id), undefined);
  store.createRecipe(owner.id, { title: 'Test recipe', ingredients: [], steps: [] });
  saveFoodProfile(owner.id, { householdType: null, householdSize: 2, hasChildren: false, preferredMaxCookingTime: 30, excludedIngredients: [], preferredCategories: {}, onboardingCompleted: true });
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = (user) => ({ authorization: `tma ${makeTelegramInitData(user, process.env.TELEGRAM_BOT_TOKEN)}`, 'content-type': 'application/json' });
  const payment = (result) => fetch(base + '/api/test/payment', { method: 'POST', headers: headers(ownerTg), body: JSON.stringify({ result }) });
  try {
    assert.equal((await fetch(base + '/api/me', { headers: headers(otherTg) })).status, 403);
    assert.equal(store.getUserByTelegramId(otherTg.id), undefined);
    assert.equal((await fetch(base + '/api/test/payment', { headers: headers(ownerTg) })).status, 200);
    assert.equal((await (await payment('failure')).json()).active, false);
    assert.equal((await (await payment('success')).json()).active, true);
    assert.equal((await (await payment('cancel')).json()).active, true, 'cancel does not revoke paid test access');
    assert.equal((await payment('forged')).status, 400);
    assert.equal((await fetch(base + '/api/test/reset', { method: 'POST', headers: headers(otherTg) })).status, 403);
    assert.equal((await fetch(base + '/api/test/reset', { method: 'POST', headers: headers(ownerTg) })).status, 200);
    assert.equal(store.getUserByTelegramId(ownerTg.id), undefined);
    assert.equal(store.listRecipes(owner.id).length, 0);
    assert.equal(getFoodProfile(owner.id).onboardingCompleted, false);
    assert.equal(store.db.prepare('SELECT count(*) n FROM mock_payments').get().n, 0);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('test Mini App links lead back to the test bot', () => {
  const html = buildWebDocument(path.resolve('public'), { botUsername: 'recipeboi_test_bot' }).bytes.toString();
  assert.match(html, /https:\/\/t\.me\/recipeboi_test_bot\?start=dinner/);
  assert.doesNotMatch(html, /https:\/\/t\.me\/Recipeboibot/);
});

test('test polling rejects a token for another bot before getUpdates', async () => {
  const realFetch = globalThis.fetch;
  const methods = [];
  globalThis.fetch = async (url) => {
    methods.push(String(url).split('/').at(-1));
    return new Response(JSON.stringify({ ok: true, result: { username: 'Recipeboibot' } }), { status: 200 });
  };
  try {
    await assert.rejects(startTelegramPolling(), /Unexpected bot token/);
    assert.deepEqual(methods, ['getMe']);
  } finally { globalThis.fetch = realFetch; }
});

test('Telegram reset requires owner confirmation and next Start creates a fresh profile', async () => {
  const ownerTg = { id: 75101, first_name: 'Owner' };
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith('https://api.telegram.org/')) {
      calls.push({ method: String(url).split('/').at(-1), body: JSON.parse(options.body) });
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
    }
    return realFetch(url, options);
  };
  try {
    await handleMessage({ from: ownerTg, chat: { id: ownerTg.id, type: 'private' }, text: '/start' });
    const oldId = store.getUserByTelegramId(ownerTg.id).id;
    await handleMessage({ from: ownerTg, chat: { id: ownerTg.id, type: 'private' }, text: '/test_reset' });
    assert.ok(store.getUserByTelegramId(ownerTg.id), 'prompt alone does not delete');
    assert.match(calls.at(-1).body.text, /Сбросить тестового пользователя/);
    await handleTestResetCallback({ id: 'callback-1', from: ownerTg, message: { chat: { id: ownerTg.id, type: 'private' } }, data: 'test:reset:confirm' });
    assert.equal(store.getUserByTelegramId(ownerTg.id), undefined);
    await handleMessage({ from: ownerTg, chat: { id: ownerTg.id, type: 'private' }, text: '/start' });
    assert.notEqual(store.getUserByTelegramId(ownerTg.id).id, oldId);
    assert.match(calls.at(-1).body.text, /Давайте познакомимся/);
  } finally { globalThis.fetch = realFetch; }
});
