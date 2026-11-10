import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

Object.assign(process.env, {
  BOT_PLATFORM: 'max', MAX_BOT_TOKEN: 'max-reset-test-token', MAX_BOT_USERNAME: 'recipe_test_bot',
  MAX_TEST_RESET_USER_ID: '17', TEST_CONTOUR: 'false', TELEGRAM_POLLING: 'false',
  TELEGRAM_BOT_TOKEN: '', DATABASE_PATH: path.resolve('data', `max-reset-${process.pid}.sqlite`),
  APP_URL: 'https://max-recipes.example.test', DINNER_LLM_ENABLED: 'false', DINNER_IMAGES_ENABLED: 'false',
  OPENAI_API_KEY: 'test-key', OPENAI_TEXT_MODEL: 'test-model', OPENAI_TRANSCRIBE_MODEL: 'test-transcribe'
});
const { db, resolvePrivateTelegramUser, allowUser, createRecipe, recordAiAttempt, setPendingIntent, getPendingIntent } = await import('../src/db.js');
const { canResetTestUser, resetTestUser, mockPaymentStatus } = await import('../src/contour-sandbox.js');
const { handleChatUpdate, handleTestResetCallback } = await import('../src/telegram.js');
const { normalizeMaxUpdate } = await import('../src/max-events.js');
const { maxStore } = await import('../src/max-store.js');
const { startTrial, getTrialStatus } = await import('../src/subscriptions.js');
const { getFoodProfile, saveFoodProfile } = await import('../src/dinner-store.js');

let serial = 0;
const outgoing = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  const target = new URL(url);
  assert.equal(target.hostname, 'platform-api2.max.ru', 'Tests must never make AI or Telegram requests');
  const body = JSON.parse(options.body);
  outgoing.push({ path: target.pathname, userId: target.searchParams.get('user_id'), body });
  if (target.pathname === '/answers') {
    if (!body.notification?.trim() && !body.message) return new Response(JSON.stringify({ code: 'proto.payload', message: 'Invalid request. `message` or `notification` required' }), { status: 400 });
    return new Response(JSON.stringify({ success: true }));
  }
  const userId = target.searchParams.get('user_id');
  return new Response(JSON.stringify({ message: {
    sender: { user_id: 777, is_bot: true }, recipient: { chat_type: 'dialog', chat_id: 90000 + Number(userId) },
    body: { mid: `mid.reset-${++serial}`, text: body.text, attachments: body.attachments }
  } }));
};
const message = (id, text) => normalizeMaxUpdate({ update_type: 'message_created', message: {
  sender: { user_id: id, first_name: 'Тест' }, recipient: { chat_type: 'dialog', chat_id: 90000 + id },
  body: { mid: `mid.incoming-${++serial}`, text }
} });
const callbackEvent = (id, mid, payload) => ({ update_type: 'message_callback', callback: {
  callback_id: `callback.reset-${++serial}`, payload, user: { user_id: id, first_name: 'Тест' }
}, message: { sender: { user_id: 777, is_bot: true }, recipient: { chat_type: 'dialog', chat_id: 90000 + id }, body: { mid } } });
test.after(() => {
  globalThis.fetch = realFetch;
  db.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(process.env.DATABASE_PATH + suffix, { force: true });
});

test('MAX reset is disabled without a valid owner setting and remains disabled in main Telegram', () => {
  for (const [platform, ownerId] of [['max', ''], ['max', '17,18'], ['telegram', '17']]) {
    const filename = path.resolve('data', `max-reset-denied-${process.pid}-${platform}-${ownerId.length}.sqlite`);
    try {
      const child = spawnSync(process.execPath, ['--input-type=module', '-e',
        "import {canResetTestUser} from './src/contour-sandbox.js'; if(canResetTestUser('max:17') || canResetTestUser(17)) process.exit(1);"],
      { encoding: 'utf8', env: { ...process.env, BOT_PLATFORM: platform, MAX_TEST_RESET_USER_ID: ownerId, DATABASE_PATH: filename } });
      assert.equal(child.status, 0, child.stderr);
    } finally {
      for (const suffix of ['', '-wal', '-shm']) fs.rmSync(filename + suffix, { force: true });
    }
  }
});

test('MAX reset authorizes only the configured namespaced account and keeps mock payments disabled', async () => {
  assert.equal(canResetTestUser('max:17'), true);
  assert.throws(() => mockPaymentStatus('unused'), { status: 404 });
  for (const id of ['max:18', 17, '17', 'max:017', 'max:17:18', null]) assert.equal(canResetTestUser(id), false);
  const other = resolvePrivateTelegramUser({ id: 'max:18', first_name: 'Другой' });
  const recipe = createRecipe(other.id, { title: 'Другой рецепт', status: 'ready' });
  assert.throws(() => resetTestUser('max:18'), { status: 404 });
  await handleChatUpdate(message(18, '/test_reset'));
  assert.match(outgoing.at(-1).body.text, /только владельцу/);
  assert.deepEqual(outgoing.at(-1).body.attachments, []);
  assert.ok(db.prepare('SELECT id FROM recipes WHERE id=?').get(recipe.id));
  assert.equal(await handleTestResetCallback({ id: 'forged', from: { id: 'max:18' }, data: 'test:reset:confirm', message: { chat: { id: 'max:18', type: 'private' } } }), false);
  assert.equal(await handleTestResetCallback({ id: 'wrong-chat', from: { id: 'max:17' }, data: 'test:reset:confirm', message: { chat: { id: 'max:18', type: 'private' } } }), false);
  assert.equal(await handleTestResetCallback({ id: 'group', from: { id: 'max:17' }, data: 'test:reset:confirm', message: { chat: { id: 'max:17', type: 'group' } } }), false);
});

test('MAX reset command and cancel preserve profile, recipes and trial until explicit confirmation', async () => {
  const owner = resolvePrivateTelegramUser({ id: 'max:17', first_name: 'Тест' });
  allowUser(owner.id);
  createRecipe(owner.id, { title: 'Первый ужин', status: 'ready' });
  saveFoodProfile(owner.id, { ...getFoodProfile(owner.id), onboardingCompleted: true, preferredCategories: { pasta: 1 } });
  setPendingIntent(owner.id, { kind: 'dinner-confirm', intake: { servings: 2 } });
  const trial = startTrial(owner.id);
  await handleChatUpdate(message(17, '/test_reset'));
  const prompt = outgoing.at(-1);
  assert.match(prompt.body.text, /пробный и оплаченный доступ в MAX/);
  assert.doesNotMatch(prompt.body.text, /имитации оплаты/);
  const buttons = prompt.body.attachments[0].payload.buttons;
  assert.equal(buttons[0][0].payload, 'test:reset:confirm');
  assert.equal(buttons[1][0].payload, 'test:reset:cancel');
  assert.equal(getTrialStatus(owner.id).expiresAt, trial.expiresAt);
  await handleChatUpdate(normalizeMaxUpdate(callbackEvent(17, `mid.reset-${serial}`, 'test:reset:cancel'), { botId: 777 }));
  assert.equal(getFoodProfile(owner.id).onboardingCompleted, true);
  assert.equal(getPendingIntent(owner.id), null);
  assert.equal(JSON.parse(db.prepare('SELECT payload_json FROM pending_intents WHERE user_id=?').get(owner.id).payload_json).kind, 'dinner-confirm');
  assert.equal(getTrialStatus(owner.id).expiresAt, trial.expiresAt);
});

test('MAX reset confirmation deletes only its owner, keeps AI accounting and restarts fresh onboarding', async () => {
  const owner = db.prepare("SELECT * FROM users WHERE telegram_id='max:17'").get();
  const other = db.prepare("SELECT * FROM users WHERE telegram_id='max:18'").get();
  recordAiAttempt();
  const aiBefore = db.prepare('SELECT count(*) AS n FROM ai_reservations').get().n;
  db.prepare('INSERT INTO user_subscriptions(user_id,plan,starts_at,expires_at,updated_at) VALUES(?,?,?,?,?)')
    .run(owner.id, 'subscription', new Date().toISOString(), new Date(Date.now() + 86400000).toISOString(), new Date().toISOString());
  db.prepare('INSERT INTO first_dinner_previews(user_id,selected_id) VALUES(?,?)').run(owner.id, 'selected');
  await handleChatUpdate(message(17, '/test_reset'));
  const event = callbackEvent(17, `mid.reset-${serial}`, 'test:reset:confirm');
  const forged = { ...event, callback: { ...event.callback, user: { user_id: 18 } } };
  assert.equal(normalizeMaxUpdate(forged, { botId: 777 }), null);
  await handleChatUpdate(normalizeMaxUpdate(event, { botId: 777 }));
  for (const table of ['users', 'recipes', 'user_trials', 'user_subscriptions', 'first_dinner_previews', 'food_profiles', 'pending_intents']) {
    const column = table === 'users' ? 'id' : 'user_id';
    assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${column}=?`).get(owner.id).n, 0, table);
  }
  assert.equal(db.prepare('SELECT count(*) AS n FROM ai_reservations').get().n, aiBefore);
  assert.ok(db.prepare('SELECT id FROM users WHERE id=?').get(other.id));
  assert.equal(db.prepare('SELECT count(*) AS n FROM recipes WHERE user_id=?').get(other.id).n, 1);
  assert.equal(maxStore.chatForUser('17'), null);
  assert.equal(maxStore.userForCallback(event.callback.callback_id), null);
  assert.equal(normalizeMaxUpdate(event, { botId: 777 }), null, 'Old reset button cannot delete a new profile');
  assert.match(outgoing.at(-1).body.text, /Нажмите \/start/);
  await handleChatUpdate(message(17, '/start'));
  const fresh = db.prepare("SELECT * FROM users WHERE telegram_id='max:17'").get();
  assert.notEqual(fresh.id, owner.id);
  assert.equal(getTrialStatus(fresh.id).used, false);
  assert.equal(getTrialStatus(fresh.id).active, false);
  assert.equal(getFoodProfile(fresh.id).onboardingCompleted, false);
  assert.equal(db.prepare('SELECT count(*) AS n FROM recipes WHERE user_id=?').get(fresh.id).n, 0);
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
});
