import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHmac, randomUUID } from 'node:crypto';

const dbPath = path.resolve('data', `max-integration-${randomUUID()}.sqlite`);
Object.assign(process.env, { BOT_PLATFORM: 'max', MAX_BOT_TOKEN: 'max-test-secret', MAX_BOT_USERNAME: 'recipe_test_bot', MAX_WEBHOOK_SECRET: 's'.repeat(64), TELEGRAM_BOT_TOKEN: '', TELEGRAM_POLLING: 'false', DATABASE_PATH: dbPath, APP_URL: 'https://max-recipes.example.test', OPENAI_API_KEY: 'test-key', OPENAI_TEXT_MODEL: 'test-model', OPENAI_TRANSCRIBE_MODEL: 'test-transcribe', DINNER_LLM_ENABLED: 'false', DINNER_IMAGES_ENABLED: 'false' });
const { db, resolvePrivateTelegramUser, allowUser } = await import('../src/db.js');
const { createServer } = await import('../src/server.js');
const { normalizeMaxUpdate, startMaxWorker } = await import('../src/max-events.js');
const { maxStore } = await import('../src/max-store.js');
const { handleChatUpdate, interpretVoice, startTelegramPolling } = await import('../src/telegram.js');
const { startTrial, getTrialStatus } = await import('../src/subscriptions.js');
const { assertConfig, config } = await import('../src/config.js');

let server, base;
test.before(async () => {
  server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  db.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
});
function authorization(id, token = process.env.MAX_BOT_TOKEN, scheme = 'mxa') {
  const params = new URLSearchParams({ user: JSON.stringify({ id, first_name: 'Автор' }), auth_date: String(Math.floor(Date.now() / 1000)) });
  const check = [...params].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  params.set('hash', createHmac('sha256', secret).update(check).digest('hex'));
  return { authorization: `${scheme} ${params}` };
}

test('MAX photo import rejects incomplete extraction, then retries one job and preserves total time', async () => {
  const owner = resolvePrivateTelegramUser({ id: 'max:98127', first_name: 'Фото' }); allowUser(owner.id); startTrial(owner.id);
  const original = global.fetch; let complete = false, calls = 0;
  global.fetch = async (url, options) => {
    if (!String(url).startsWith('https://api.openai.com/')) return original(url, options);
    calls++;
    assert.equal(JSON.parse(options.body).input[0].content[1].detail, 'high');
    return Response.json({ status: 'completed', output_text: JSON.stringify({ title: 'Овощи', description: '', servings: 6, totalMinutes: 50, prepMinutes: null, cookMinutes: null,
      ingredients: [{ name: 'Кабачок', raw: 'Кабачок — 1 шт.', quantity: 1, unit: 'шт.', confidence: 0.99 }], steps: complete ? [{ position: 1, text: 'Нарезать и запечь.', confidence: 0.99 }] : [], warnings: [], tags: [],
      nutrition: { calories: 100, protein: 2, fat: 5, carbs: 10, basis: 'serving', source: 'calculated', servings: 6, assumptions: [] } }), usage: { input_tokens: 10, output_tokens: 20 } });
  };
  const post = () => fetch(base + '/api/import', { method: 'POST', headers: { ...authorization(98127), 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'image', mime: 'image/jpeg', value: Buffer.from([255, 216, 255, 224, 0, 16]).toString('base64') }) });
  try {
    const failure = await post(); assert.equal(failure.status, 422); assert.equal(calls, 2);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM recipes WHERE user_id=?').get(owner.id).n, 0);
    const { productReport, validProductReport } = await import('../src/product-analytics.js');
    const { maxFunnelSnapshot } = await import('../src/max-funnel.js');
    assert.deepEqual(productReport([owner]).imports, { failed: 1 });
    assert.equal(productReport([owner]).steps.find(s => s.step === 'import').errors, 1);
    complete = true;
    const saved = await (await post()).json(); assert.equal(saved.recipe.totalMinutes, 50); assert.equal(saved.recipe.prepMinutes, null);
    assert.equal((await (await post()).json()).state, 'existing'); assert.equal(calls, 3);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM import_jobs WHERE user_id=?').get(owner.id).n, 1);
    const snapshot = maxFunnelSnapshot();
    assert.equal(validProductReport(snapshot.all.productAnalytics.platforms[0], { legacy: snapshot.version === 6 }), true);
  } finally { global.fetch = original; }
});
test('MAX config excludes Telegram polling and credentials', async () => {
  assertConfig();
  assert.equal(config.telegramPolling, false);
  const original = global.fetch;
  let called = false;
  global.fetch = async () => { called = true; throw new Error('Unexpected network'); };
  try { await startTelegramPolling(); assert.equal(called, false); } finally { global.fetch = original; }
});
test('server authenticates MAX and rejects cross-platform signed data', async () => {
  const max = resolvePrivateTelegramUser({ id: 'max:123', first_name: 'Автор' });
  const telegram = resolvePrivateTelegramUser({ id: 123, first_name: 'Автор' });
  allowUser(max.id); allowUser(telegram.id);
  const response = await fetch(base + '/api/me', { headers: authorization(123) });
  assert.equal(response.status, 200);
  const me = await response.json();
  assert.equal(me.id, max.id);
  assert.notEqual(me.id, telegram.id);
  assert.equal(me.platform, 'max');
  assert.equal(me.botUrl, 'https://max.ru/recipe_test_bot');
  assert.equal((await fetch(base + '/api/me', { headers: authorization(123, 'max-test-secret', 'tma') })).status, 401);
  assert.equal((await fetch(base + '/api/me', { headers: authorization(123, 'other-secret') })).status, 401);
});
test('MAX HTML includes its SDK, CSP and authenticated bridge', async () => {
  const response = await fetch(base + '/?view=dinner');
  const html = await response.text();
  assert.match(html, /https:\/\/st\.max\.ru\/js\/max-web-app\.js/);
  assert.match(response.headers.get('content-security-policy'), /https:\/\/st\.max\.ru/);
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors https:\/\/max\.ru/);
  assert.doesNotMatch(html, /telegram-web-app\.js/);
});
test('webhook rejects absent secret and persists once before any handler work', async () => {
  const event = { update_type: 'bot_started', timestamp: 1760000000000, chat_id: 9991, user: { user_id: 234, first_name: 'Автор' } };
  const send = headers => fetch(base + '/api/max/webhook', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(event) });
  assert.equal((await send({})).status, 401);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM max_inbox').get().n, 0);
  for (let i = 0; i < 2; i++) assert.equal((await send({ 'x-max-bot-api-secret': process.env.MAX_WEBHOOK_SECRET })).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM max_inbox').get().n, 1);
  let handled = 0;
  const worker = startMaxWorker(async update => { handled++; assert.equal(update.message.chat.id, 'max:234'); assert.equal(update.message.text, '/start'); });
  await worker.wake(); await worker.stop();
  assert.equal(handled, 1);
});
test('shared recipe workflow supports MAX trial once and owns private callbacks', async () => {
  const owner = resolvePrivateTelegramUser({ id: 'max:345', first_name: 'Автор' }); allowUser(owner.id);
  maxStore.bind('9000', '345'); maxStore.rememberMessage('mid-trial', '345', '9000');
  const event = { update_type: 'message_callback', timestamp: Date.now(), callback: { callback_id: 'callback-1', payload: 'trial:start', user: { user_id: 345, first_name: 'Автор' } }, message: { sender: { user_id: 777, is_bot: true }, recipient: { chat_type: 'dialog', chat_id: 9000 }, body: { mid: 'mid-trial' } } };
  const original = global.fetch;
  global.fetch = async (url, options) => {
    assert.equal(new URL(url).hostname, 'platform-api2.max.ru');
    assert.equal(options.headers.Authorization, 'max-test-secret');
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  };
  try {
    const update = normalizeMaxUpdate(event, { botId: 777 });
    await handleChatUpdate(update);
    const trial = getTrialStatus(owner.id); assert.equal(trial.active, true);
    const second = normalizeMaxUpdate({ ...event, callback: { ...event.callback, callback_id: 'callback-2' } }, { botId: 777 });
    await handleChatUpdate(second);
    assert.equal(getTrialStatus(owner.id).expiresAt, trial.expiresAt);
    assert.equal(normalizeMaxUpdate({ ...event, callback: { ...event.callback, user: { user_id: 346 } } }, { botId: 777 }), null);
  } finally { global.fetch = original; }
});
test('MAX voice is blocked before access and inspects actual duration before transcription', async () => {
  const owner = resolvePrivateTelegramUser({ id: 'max:456', first_name: 'Автор' });
  db.prepare("INSERT INTO first_recipe_results(user_id,request_key,owner,started_at,result_json) VALUES(?,?,?,?,?)").run(owner.id, 'first-recipe', 'test', new Date().toISOString(), '{}');
  let downloaded = 0, inspected = 0, transcribed = 0;
  const adapters = { download: async () => { downloaded++; return { buffer: Buffer.from('fake-audio') }; }, inspectAudio: async () => { inspected++; return { duration: 3, mime: 'audio/ogg', extension: 'ogg' }; }, transcribe: async () => { transcribed++; return 'Приготовить пасту'; } };
  const message = { audio: { file_id: 'https://media.example.test/voice' } };
  await assert.rejects(interpretVoice(message, owner, adapters), { status: 402 });
  assert.equal(downloaded, 0);
  startTrial(owner.id);
  const result = await interpretVoice(message, owner, adapters);
  assert.match(result.sourceKey, /^max-voice:/);
  assert.equal(inspected, 1); assert.equal(transcribed, 1);
  await assert.rejects(interpretVoice(message, owner, { ...adapters, inspectAudio: async () => { throw new Error('Too long'); } }), /Too long/);
  assert.equal(transcribed, 1);
});

test('account deletion purges MAX routing and retained pending text without affecting another user', async () => {
  const owner = resolvePrivateTelegramUser({ id: 'max:567', first_name: 'Автор' }); allowUser(owner.id);
  maxStore.bind('9800', '567'); maxStore.rememberMessage('mid-delete', '567', '9800'); maxStore.rememberCallback('callback-delete', '567');
  const ownEvent = maxStore.enqueue({ update_type: 'message_created', message: { sender: { user_id: 567 }, body: { mid: 'mid-private', text: 'Private message' } } });
  const otherEvent = maxStore.enqueue({ update_type: 'message_created', message: { sender: { user_id: 568 }, body: { mid: 'mid-other', text: 'Other message' } } });
  const response = await fetch(base + '/api/account', { method: 'DELETE', headers: authorization(567) });
  assert.equal(response.status, 204);
  assert.equal(maxStore.chatForUser('567'), null);
  assert.equal(maxStore.userForCallback('callback-delete'), null);
  const retained = db.prepare('SELECT event_json,status FROM max_inbox WHERE event_id=?').get(ownEvent.eventId);
  assert.equal(retained.event_json, '{}'); assert.equal(retained.status, 'done');
  assert.match(db.prepare('SELECT event_json FROM max_inbox WHERE event_id=?').get(otherEvent.eventId).event_json, /Other message/);
});
