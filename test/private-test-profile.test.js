import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

process.env.DATABASE_PATH = path.resolve('data', `private-profile-test-${randomUUID()}.sqlite`);
process.env.TELEGRAM_BOT_TOKEN = '123456:private-profile-test';
process.env.APP_URL = 'https://recipes.example';
process.env.DINNER_LLM_ENABLED = 'false';
process.env.DINNER_IMAGES_ENABLED = 'false';
const store = await import('../src/db.js');
const { getFoodProfile, getDinnerContext } = await import('../src/dinner-store.js');
const { confirmDinnerIntake } = await import('../src/dinner-service.js');
const { handleMessage } = await import('../src/telegram.js');
const { createServer } = await import('../src/server.js');
const { makeTelegramInitData } = await import('../src/security.js');

test.after(() => {
  store.db.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(process.env.DATABASE_PATH + suffix, { force: true });
});

test('private fresh profile shares authenticated bot/API identity and preserves original data and quota', async () => {
  const tg = { id: 75101, first_name: 'Owner' };
  const owner = store.upsertTelegramUser(tg);
  store.allowUser(owner.id);
  const recipe = store.createRecipe(owner.id, { title: 'Original recipe', ingredients: [], steps: [] });
  confirmDinnerIntake(owner.id, { availableIngredients: ['рис'], householdSize: 4, excludedIngredients: ['орехи'], maxMinutes: 30 });
  store.setPendingIntent(owner.id, { kind: 'dinner-intake', text: 'Original draft' });
  const originalProfile = getFoodProfile(owner.id);
  const originalContext = getDinnerContext(owner.id);
  store.db.prepare('INSERT INTO ai_reservations VALUES(?,?)').run('existing-accounting', new Date().toISOString());
  const mode = store.activatePrivateTestProfile(tg.id);
  assert.notEqual(mode.testUserId, owner.id);
  assert.deepEqual(store.activatePrivateTestProfile(tg.id), mode, 'start is idempotent');
  assert.equal(store.resolvePrivateTelegramUser(tg).id, mode.testUserId);
  assert.equal(store.getUserByTelegramId(tg.id).id, owner.id, 'group/account lookup stays original');
  assert.equal(store.getUserById(mode.testUserId).is_allowed, 0, 'first Start has not happened');
  assert.equal(store.listRecipes(mode.testUserId).length, 0);
  assert.deepEqual(getDinnerContext(mode.testUserId), []);
  assert.deepEqual(getFoodProfile(mode.testUserId).excludedIngredients, []);
  assert.equal(store.getPendingIntent(mode.testUserId), null);

  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { authorization: `tma ${makeTelegramInitData(tg, process.env.TELEGRAM_BOT_TOKEN)}`, 'content-type': 'application/json' };
  const realFetch = globalThis.fetch;
  const messages = [];
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith('https://api.telegram.org/')) {
      messages.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
    }
    return realFetch(url, options);
  };
  try {
    assert.equal((await fetch(base + '/api/me', { headers })).status, 403);
    await handleMessage({ from: tg, chat: { id: tg.id, type: 'private' }, text: '/start' });
    assert.equal(messages.length, 1);
    assert.equal(messages[0].chat_id, tg.id);
    assert.match(messages[0].text, /Давай подберём ужин специально для тебя/);
    assert.equal(store.getPendingIntent(mode.testUserId).profileOnly, true);
    assert.doesNotMatch(messages[0].text, /возвращением|назовите продукты/i);
    assert.equal(store.getUserById(mode.testUserId).is_allowed, 1);
    assert.equal((await (await fetch(base + '/api/me', { headers })).json()).id, mode.testUserId);
    assert.deepEqual((await (await fetch(base + '/api/library', { headers })).json()).recipes, []);
    assert.equal((await fetch(base + '/api/recipes/' + recipe.id, { headers })).status, 404);
    assert.equal((await fetch(base + '/api/billing/trial', { method: 'POST', headers, body: '{}' })).status, 200);
    const session = await (await fetch(base + '/api/dinner/open', { method: 'POST', headers, body: '{}' })).json();
    const choices = await (await fetch(base + '/api/dinner/recommend', { method: 'POST', headers, body: JSON.stringify({ sessionId: session.sessionId }) })).json();
    assert.equal(choices.recommendations.length, 3);

    const otherTg = { id: 75102, first_name: 'Other' };
    const other = store.upsertTelegramUser(otherTg); store.allowUser(other.id);
    const otherHeaders = { authorization: `tma ${makeTelegramInitData(otherTg, process.env.TELEGRAM_BOT_TOKEN)}`, 'x-test-profile': mode.testUserId };
    assert.equal((await (await fetch(base + '/api/me?testProfile=' + mode.testUserId, { headers: otherHeaders })).json()).id, other.id);
    assert.equal((await fetch(base + '/api/me?testProfile=' + mode.testUserId)).status, 401);

    assert.equal(store.deactivatePrivateTestProfile(tg.id).active, false);
    assert.equal((await (await fetch(base + '/api/me', { headers })).json()).id, owner.id);
    assert.equal(store.listRecipes(owner.id)[0].id, recipe.id);
    assert.deepEqual(getFoodProfile(owner.id), originalProfile);
    assert.deepEqual(getDinnerContext(owner.id), originalContext);
    assert.equal(store.getPendingIntent(owner.id).text, 'Original draft');
    assert.equal(store.db.prepare('SELECT count(*) n FROM ai_reservations').get().n, 1);
    assert.ok(store.getUserById(mode.testUserId), 'test history remains after stop');
  } finally {
    globalThis.fetch = realFetch;
    await new Promise(resolve => server.close(resolve));
  }
});

test('admin refuses missing/synthetic identities without creating profiles', () => {
  const before = store.db.prepare('SELECT count(*) n FROM users').get().n;
  assert.throws(() => store.activatePrivateTestProfile('9999999'), /not found/);
  assert.throws(() => store.activatePrivateTestProfile('private-test:any'), /real Telegram/);
  assert.equal(store.db.prepare('SELECT count(*) n FROM users').get().n, before);
});
