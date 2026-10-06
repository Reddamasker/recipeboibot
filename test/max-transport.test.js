import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'recipe-max-transport-'));
process.env.DATABASE_PATH = path.join(directory, 'recipes.sqlite');
process.env.TELEGRAM_POLLING = 'false';
process.env.MAX_BOT_TOKEN = 'max-unit-token';
process.env.DINNER_LLM_ENABLED = 'false';
process.env.DINNER_IMAGES_ENABLED = 'false';
const { db } = await import('../src/db.js');
const { createMaxStore } = await import('../src/max-store.js');
const { createMaxClient, maxKeyboard, maxUserId, splitMaxText } = await import('../src/max-client.js');
const { normalizeMaxUpdate, enqueueMaxUpdate, startMaxWorker } = await import('../src/max-events.js');
test.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });

function fresh() { const database = new DatabaseSync(':memory:'); return { database, store: createMaxStore(database) }; }
const incoming = (id = 17, type = 'dialog') => ({ update_type: 'message_created', timestamp: 1000, message: { sender: { user_id: id, first_name: 'Макс', is_bot: false }, recipient: { chat_id: 900, chat_type: type }, body: { mid: 'mid.incoming', text: 'Рис' } } });
const sentMessage = { sender: { user_id: 5, is_bot: true }, recipient: { chat_id: 900, chat_type: 'dialog' }, body: { mid: 'mid.sent', text: 'Ужин' } };
const callback = (actor = 17) => ({ update_type: 'message_callback', timestamp: 2000, callback: { callback_id: 'callback1', payload: 'dinner:size:2', user: { user_id: actor, first_name: 'Макс' } }, message: structuredClone(sentMessage) });

test('MAX private identity is namespaced; groups and bots cannot establish bindings', () => {
  const { store, database } = fresh();
  assert.equal(normalizeMaxUpdate(incoming(17, 'chat'), { store }), null);
  const bot = incoming(); bot.message.sender.is_bot = true;
  assert.equal(normalizeMaxUpdate(bot, { store }), null);
  const event = normalizeMaxUpdate(incoming(), { store });
  assert.equal(event.message.from.id, 'max:17');
  assert.equal(event.message.chat.id, 'max:17');
  assert.equal(event.message.message_id, 'mid.incoming');
  assert.equal(store.userForChat(900), '17');
  assert.equal(normalizeMaxUpdate(incoming(18), { store }), null);
  database.close();
});

test('MAX callbacks require persisted chat and sent-message ownership', () => {
  const { store, database } = fresh();
  assert.equal(normalizeMaxUpdate(callback(), { store }), null);
  store.rememberMessage('mid.sent', 17, 900);
  assert.equal(normalizeMaxUpdate(callback(18), { store }), null);
  const group = callback(); group.message.recipient.chat_type = 'chat';
  assert.equal(normalizeMaxUpdate(group, { store }), null);
  const notBot = callback(); notBot.message.sender.is_bot = false;
  assert.equal(normalizeMaxUpdate(notBot, { store }), null);
  const unknown = callback(); unknown.message.body.mid = 'mid.foreign';
  assert.equal(normalizeMaxUpdate(unknown, { store }), null);
  assert.equal(normalizeMaxUpdate(callback(), { store, botId: 6 }), null);
  const normalized = normalizeMaxUpdate(callback(), { store, botId: 5 });
  assert.equal(normalized.callback_query.from.id, 'max:17');
  assert.equal(normalized.callback_query.message.chat.id, 'max:17');
  assert.equal(store.userForCallback('callback1'), '17');
  database.close();
});

test('start, audio and photo normalize without inventing an audio duration', () => {
  const { store, database } = fresh();
  assert.equal(normalizeMaxUpdate({ update_type: 'bot_started', timestamp: 1, chat_id: 900, user: { user_id: 17 }, payload: 'ref_1' }, { store }).message.text, '/start ref_1');
  const event = incoming();
  event.message.body.attachments = [{ type: 'audio', payload: { url: 'https://cdn.example/audio', token: 'audio1' } }, { type: 'image', payload: { url: 'https://cdn.example/photo', token: 'photo1' } }];
  const message = normalizeMaxUpdate(event, { store }).message;
  assert.equal(message.audio.file_id, 'https://cdn.example/audio');
  assert.equal(message.audio.duration, undefined);
  assert.equal(message.photo[0].file_id, 'https://cdn.example/photo');
  assert.equal(message.caption, 'Рис');
  database.close();
});

test('mini app routes encode UTF-8 JSON into MAX open_app payload', () => {
  const markup = { inline_keyboard: [[{ text: 'Открыть', web_app: { url: 'https://recipes.example/?view=recipe&recipe=тест' } }, { text: 'Два', callback_data: 'dinner:size:2' }]] };
  const buttons = maxKeyboard(markup, 'recipe_bot')[0].payload.buttons[0];
  assert.equal(buttons[0].type, 'open_app');
  assert.equal(buttons[0].web_app, 'recipe_bot');
  assert.deepEqual(JSON.parse(Buffer.from(buttons[0].payload, 'base64url')), { view: 'recipe', recipe: 'тест' });
  assert.equal(buttons[1].payload, 'dinner:size:2');
  assert.throws(() => maxKeyboard(markup, ''), /username/);
  assert.throws(() => maxUserId(17), /private target/);
});

test('forward-only MAX messages preserve text and media with a unique event identity', () => {
  const { store, database } = fresh();
  const event = incoming();
  event.message.body = null;
  event.message.link = { type: 'forward', sender: { user_id: 999 }, message: { mid: 'mid.original', text: 'Ингредиенты: рис и курица', attachments: [{ type: 'image', payload: { url: 'https://cdn.example/forward-photo', token: 'forward-photo' } }, { type: 'audio', payload: { url: 'https://cdn.example/forward-audio', token: 'forward-audio' } }] } };
  const message = normalizeMaxUpdate(event, { store }).message;
  assert.equal(message.from.id, 'max:17');
  assert.equal(message.text, 'Ингредиенты: рис и курица');
  assert.equal(message.photo[0].file_id, 'https://cdn.example/forward-photo');
  assert.equal(message.audio.file_id, 'https://cdn.example/forward-audio');
  assert.match(message.message_id, /^event:[0-9a-f]{64}$/);
  assert.notEqual(normalizeMaxUpdate({ ...event, timestamp: 2000 }, { store }).message.message_id, message.message_id);
  assert.equal(normalizeMaxUpdate(event, { store, eventId: 'durable-event-id' }).message.message_id, 'event:durable-event-id');
  database.close();
});

test('MAX comments accompany forwarded recipes while reply references do not become new recipe input', () => {
  const { store, database } = fresh();
  const event = incoming();
  event.message.body.text = 'Сделай на троих';
  event.message.link = { type: 'forward', message: { mid: 'mid.original', text: 'Рецепт пасты', attachments: [{ type: 'image', payload: { url: 'https://cdn.example/forward-photo' } }] } };
  const message = normalizeMaxUpdate(event, { store }).message;
  assert.equal(message.message_id, 'mid.incoming');
  assert.equal(message.text, 'Сделай на троих\n\nРецепт пасты');
  assert.equal(message.caption, message.text);
  event.message.link.type = 'reply';
  const replied = normalizeMaxUpdate(event, { store }).message;
  assert.equal(replied.text, 'Сделай на троих');
  assert.equal(replied.photo, undefined);
  database.close();
});

test('MAX unsupported files expose an explicit marker and forwarded links remain useful input', () => {
  const { store, database } = fresh();
  const event = incoming(); event.message.body.text = '';
  event.message.body.attachments = [{ type: 'file', filename: 'recipe.pdf', payload: { url: 'https://cdn.example/recipe.pdf' } }];
  assert.deepEqual(normalizeMaxUpdate(event, { store }).message.maxUnsupportedMedia, ['file']);
  event.message.body = null;
  event.message.link = { type: 'forward', message: { mid: 'mid.original', attachments: [{ type: 'share', payload: { url: 'https://recipes.example/recipe' } }] } };
  assert.equal(normalizeMaxUpdate(event, { store }).message.text, 'https://recipes.example/recipe');
  database.close();
});

test('MAX sends by user_id, retains string mids, rate limits and edits only owned messages', async () => {
  const { store, database } = fresh(); const calls = []; const delays = []; let time = 0;
  const client = createMaxClient({ maxToken: 'private-token', maxBotUsername: 'recipe_bot' }, { store, now: () => time, sleep: async (ms) => { delays.push(ms); time += ms; }, fetchImpl: async (url, options) => { calls.push({ url: new URL(url), options, body: options.body && JSON.parse(options.body) }); return { ok: true, status: 200, json: async () => options.method === 'POST' && url.pathname === '/messages' ? { message: sentMessage } : { success: true } }; } });
  const result = await client.chatCall('sendMessage', { chat_id: 'max:17', text: 'Ужин' });
  assert.equal(result.message_id, 'mid.sent');
  assert.equal(calls[0].url.searchParams.get('user_id'), '17');
  assert.equal(calls[0].url.searchParams.has('chat_id'), false);
  assert.equal(calls[0].options.headers.Authorization, 'private-token');
  assert.equal(calls[0].url.href.includes('private-token'), false);
  await client.chatCall('editMessageText', { chat_id: 'max:17', message_id: 'mid.sent', text: 'Изменено', reply_markup: { inline_keyboard: [] } });
  assert.deepEqual(delays, [550]);
  assert.equal(calls[1].url.searchParams.get('message_id'), 'mid.sent');
  await assert.rejects(client.chatCall('editMessageText', { chat_id: 'max:18', message_id: 'mid.sent', text: 'Чужое' }), /ownership/);
  await assert.rejects(client.chatCall('answerCallbackQuery', { callback_query_id: 'unknown' }), /Unknown/);
  store.rememberCallback('callback1', '17');
  await client.chatCall('answerCallbackQuery', { callback_query_id: 'callback1', text: 'Готово' });
  assert.equal(calls[2].body.notification, 'Готово');
  database.close();
});

test('MAX callback acknowledgements satisfy the API payload requirement for shared actions without text', async () => {
  const { store, database } = fresh();
  const answers = [];
  store.rememberCallback('empty-answer', '17');
  store.rememberCallback('explicit-answer', '17');
  const client = createMaxClient({ maxToken: 'test' }, { store, sleep: async () => {}, fetchImpl: async (url, options) => {
    assert.equal(url.pathname, '/answers');
    assert.equal(options.method, 'POST');
    const body = JSON.parse(options.body);
    answers.push({ callback: url.searchParams.get('callback_id'), body });
    const accepted = Boolean(body.notification?.trim() || body.message);
    return new Response(JSON.stringify(accepted ? { success: true } : { code: 'proto.payload', message: 'Invalid request. `message` or `notification` required' }), { status: accepted ? 200 : 400 });
  } });
  try {
    await client.chatCall('answerCallbackQuery', { callback_query_id: 'empty-answer' });
    await client.chatCall('answerCallbackQuery', { callback_query_id: 'explicit-answer', text: 'Готово' });
    assert.deepEqual(answers, [
      { callback: 'empty-answer', body: { notification: 'Принято' } },
      { callback: 'explicit-answer', body: { notification: 'Готово' } }
    ]);
  } finally { database.close(); }
});

test('MAX photos attach native images; opaque photos retain caption and buttons', async () => {
  const { store, database } = fresh(); const bodies = [];
  const client = createMaxClient({ maxToken: 'test', maxBotUsername: 'recipe_bot' }, { store, sleep: async () => {}, fetchImpl: async (url, options) => { bodies.push(JSON.parse(options.body)); return { ok: true, status: 200, json: async () => ({ message: sentMessage }) }; } });
  const reply_markup = { inline_keyboard: [[{ text: 'Сохранить', callback_data: 'save' }]] };
  await client.chatCall('sendPhoto', { chat_id: 'max:17', photo: 'https://recipes.example/photo.jpg', caption: 'Рецепт', reply_markup });
  assert.equal(bodies[0].attachments[0].type, 'image');
  await client.chatCall('editMessageReplyMarkup', { chat_id: 'max:17', message_id: 'mid.sent', reply_markup: { inline_keyboard: [] } });
  assert.equal(bodies[1].attachments[0].type, 'image');
  assert.equal(bodies[1].attachments.length, 1);
  await client.chatCall('sendPhoto', { chat_id: 'max:17', photo: 'telegram-file-id', caption: 'Рецепт', reply_markup });
  assert.equal(bodies[2].text, 'Рецепт');
  assert.equal(bodies[2].attachments[0].type, 'inline_keyboard');
  database.close();
});

test('MAX ephemeral deletion replies retain no chat/message bindings or callback buttons', async () => {
  const { store, database } = fresh(); let outbound;
  const client = createMaxClient({ maxToken: 'test' }, { store, fetchImpl: async (url, options) => { outbound = JSON.parse(options.body); return { ok: true, status: 200, json: async () => ({ message: sentMessage }) }; } });
  const result = await client.chatCall('sendMessage', { chat_id: 'max:17', text: 'Данные удалены', max_ephemeral: true, reply_markup: { inline_keyboard: [[{ text: 'Кнопка', callback_data: 'save' }]] } });
  assert.equal(result.message_id, 'mid.sent');
  assert.equal(store.chatForUser('17'), null);
  assert.equal(store.userForChat(900), null);
  assert.equal(store.ownsMessage('mid.sent', 17, 900), false);
  assert.deepEqual(outbound.attachments, []);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM max_messages').get().count, 0);
  database.close();
});

test('MAX API rejects unsafe origins/redirects and sanitizes network/server errors', async () => {
  for (const maxApiOrigin of ['http://platform-api2.max.ru', 'https://evil.example', 'https://platform-api2.max.ru@evil.example', 'https://platform-api2.max.ru/a']) assert.throws(() => createMaxClient({ maxApiOrigin }), /origin/);
  const client = createMaxClient({ maxToken: 'secret' }, { fetchImpl: async () => { throw new Error('secret'); } });
  await assert.rejects(client.api('/me'), (error) => !error.message.includes('secret'));
  const failed = createMaxClient({ maxToken: 'secret' }, { fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ message: 'secret' }) }) });
  await assert.rejects(failed.api('/me'), (error) => error.message.includes('401') && !error.message.includes('secret'));
});

test('long MAX recipes become complete plain paragraphs with keyboard only on final card', async () => {
  const { store, database } = fresh(); const bodies = []; let serial = 0;
  const client = createMaxClient({ maxToken: 'test' }, { store, sleep: async () => {}, fetchImpl: async (url, options) => { bodies.push(JSON.parse(options.body)); return { ok: true, status: 200, json: async () => ({ message: { ...sentMessage, body: { mid: `mid.${++serial}` } } }) }; } });
  const text = '<b>Рецепт &amp; ужин</b>\n\n' + ('Ингредиенты и действия.\n'.repeat(350)) + '&#128512;';
  const split = splitMaxText(text);
  assert.equal(split.format, undefined);
  assert.ok(split.texts.every((part) => part.length <= 3900 && !part.includes('<b>')));
  assert.ok(split.texts[0].startsWith('Рецепт & ужин'));
  const result = await client.chatCall('sendMessage', { chat_id: 'max:17', text, reply_markup: { inline_keyboard: [[{ text: 'Сохранить', callback_data: 'save' }]] } });
  assert.equal(bodies.length, split.texts.length);
  assert.equal(result.message_id, `mid.${bodies.length}`);
  assert.ok(bodies.slice(0, -1).every((body) => !body.attachments && !body.format));
  assert.equal(bodies.at(-1).attachments[0].type, 'inline_keyboard');
  assert.equal(bodies.at(-1).format, undefined);
  const before = bodies.length;
  await client.chatCall('editMessageText', { chat_id: 'max:17', message_id: result.message_id, text });
  assert.equal(bodies.length - before, split.texts.length);
  database.close();
});

test('durable MAX inbox deduplicates reordered JSON and retries failed work', async () => {
  const { store, database } = fresh(); const event = incoming();
  const first = enqueueMaxUpdate(event, { store });
  assert.equal(first.inserted, true);
  assert.equal(enqueueMaxUpdate({ message: event.message, timestamp: event.timestamp, update_type: event.update_type }, { store }).inserted, false);
  let attempts = 0;
  const worker = startMaxWorker(async (update) => { assert.equal(update.message.from.id, 'max:17'); if (++attempts === 1) throw new Error('temporary'); }, { store, retryDelayMs: 0 });
  await worker.wake(); await worker.stop();
  assert.equal(attempts, 2);
  assert.equal(store.status(first.eventId).status, 'done');
  assert.equal(enqueueMaxUpdate(event, { store }).inserted, false);
  database.close();
});

test('durable MAX worker recovers work left processing after a restart', async () => {
  const { store, database } = fresh();
  const first = store.enqueue(incoming());
  assert.ok(store.claim());
  let handled = 0;
  const worker = startMaxWorker(async () => { handled++; }, { store });
  await worker.wake(); await worker.stop();
  assert.equal(handled, 1);
  assert.equal(store.status(first.eventId).status, 'done');
  database.close();
});

test('MAX persisted inbox and ownership survive closing and reopening SQLite', () => {
  const filename = path.join(directory, 'durability.sqlite');
  let database = new DatabaseSync(filename); let store = createMaxStore(database);
  const queued = store.enqueue(incoming());
  store.rememberMessage('mid.persisted', 17, 900);
  database.close();
  database = new DatabaseSync(filename); store = createMaxStore(database);
  assert.equal(store.userForChat(900), '17');
  assert.equal(store.ownsMessage('mid.persisted', 17, 900), true);
  assert.equal(store.claim().eventId, queued.eventId);
  database.close();
});
