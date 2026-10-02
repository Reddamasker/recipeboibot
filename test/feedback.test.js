import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const file = path.resolve('data', `feedback-${process.pid}.sqlite`);
process.env.DATABASE_PATH = file;
process.env.TELEGRAM_BOT_TOKEN = 'test-feedback-token';
process.env.APP_URL = 'https://recipes.example.test';
process.env.FEEDBACK_CHAT_ID = '6971956699';
const { db, upsertTelegramUser, allowUser, getPendingIntent, setPendingIntent } = await import('../src/db.js');
const { submitFeedback, flushFeedback } = await import('../src/feedback.js');
const { handleMessage, sendFeedbackNotification } = await import('../src/telegram.js');
const { createServer } = await import('../src/server.js');
const { makeTelegramInitData } = await import('../src/security.js');
let sequence = 74000;
function fixture() { const sender = { id: ++sequence, first_name: 'Автор <теста>', username: 'feedback_author' }; return { sender, user: upsertTelegramUser(sender) }; }
test.after(() => { db.close(); for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(file + suffix); } catch {} } });

test('feedback validates text, is idempotent and keeps a single delivery during parallel requests', async () => {
  const { sender, user } = fixture(); let calls = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const send = async () => { calls++; await gate; };
  const input = { message: '  Пожелание\nи жалоба  ', requestKey: 'duplicate-key' };
  const a = submitFeedback(user.id, sender, input, send), b = submitFeedback(user.id, sender, input, send);
  release(); const results = await Promise.all([a, b]);
  assert.equal(calls, 1); assert.equal(results[0].id, results[1].id); assert.equal(results[0].delivered, true);
  assert.equal((await submitFeedback(user.id, sender, input, assert.fail)).id, results[0].id);
  for (const message of ['', '   ', 'x'.repeat(3001), {}]) await assert.rejects(submitFeedback(user.id, sender, { ...input, message }, assert.fail), { status: 400 });
  await assert.rejects(submitFeedback(user.id, sender, { ...input, message: 'другой текст' }, assert.fail), { status: 409 });
});

test('failed delivery persists and the queue retries with backoff without losing the message', async () => {
  const { sender, user } = fixture();
  const result = await submitFeedback(user.id, sender, { message: 'Ошибка приложения', requestKey: 'retry-key-001' }, async () => { throw new Error('network'); });
  assert.equal(result.delivered, false);
  const stored = db.prepare('SELECT * FROM feedback_messages WHERE id=?').get(result.id);
  assert.equal(stored.message, 'Ошибка приложения'); assert.equal(stored.attempts, 1); assert.ok(stored.next_attempt_at > Date.now());
  await flushFeedback(assert.fail);
  db.prepare('UPDATE feedback_messages SET next_attempt_at=0 WHERE id=?').run(result.id);
  let delivered; await flushFeedback(async row => { delivered = row; });
  assert.equal(delivered.id, result.id); assert.ok(db.prepare('SELECT delivered_at FROM feedback_messages WHERE id=?').get(result.id).delivered_at);
});

test('feedback has a persistent per-Telegram-account rate limit', async () => {
  const { sender, user } = fixture();
  for (let i = 0; i < 5; i++) await submitFeedback(user.id, sender, { message: 'Обращение', requestKey: `rate-key-${i}` }, async () => {});
  await assert.rejects(submitFeedback(user.id, sender, { message: 'Обращение', requestKey: 'rate-key-extra' }, assert.fail), { status: 429 });
});

test('HTTP feedback requires authentication, works without subscription, and cannot spoof sender or recipient', async () => {
  const { sender, user } = fixture(); allowUser(user.id);
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const original = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith('https://api.telegram.org/')) { calls.push(JSON.parse(options.body)); return new Response(JSON.stringify({ ok: true, result: {} })); }
    return original(url, options);
  };
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/feedback`;
    const body = JSON.stringify({ message: '<b>Жалоба</b> & вопрос', requestKey: 'http-key-001', telegram_id: '1', chat_id: '1' });
    assert.equal((await fetch(url, { method: 'POST', body })).status, 401);
    const headers = { authorization: `tma ${makeTelegramInitData(sender, process.env.TELEGRAM_BOT_TOKEN)}`, 'content-type': 'application/json' };
    setPendingIntent(user.id, { kind: 'feedback', resumeIntent: { kind: 'recipe-save' } });
    const response = await fetch(url, { method: 'POST', headers, body });
    assert.equal(response.status, 201); assert.equal((await response.json()).delivered, true);
    assert.equal(calls.length, 1); assert.equal(calls[0].chat_id, '6971956699');
    assert.equal(getPendingIntent(user.id).kind, 'recipe-save');
    assert.ok(calls[0].text.includes(`tg://user?id=${sender.id}`)); assert.ok(calls[0].text.includes('&lt;b&gt;Жалоба&lt;/b&gt; &amp; вопрос'));
    await fetch(url, { method: 'POST', headers, body }); assert.equal(calls.length, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM provider_requests WHERE user_id=?').get(user.id).count, 0);
  } finally { globalThis.fetch = original; await new Promise(resolve => server.close(resolve)); }
});

test('chat feedback accepts plain text before onboarding, preserves pending work, and cancels without AI', async () => {
  const { sender, user } = fixture(), calls = [], original = globalThis.fetch;
  setPendingIntent(user.id, { kind: 'dinner-intake', intake: { servings: 3 } });
  globalThis.fetch = async (_url, options) => { calls.push(JSON.parse(options.body)); return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } })); };
  const message = text => ({ from: sender, chat: { id: sender.id, type: 'private' }, message_id: 42, text });
  try {
    await handleMessage(message('/feedback')); assert.equal(getPendingIntent(user.id).kind, 'feedback');
    await handleMessage({ ...message(undefined), voice: { file_id: 'never-transcribe' } }); assert.ok(calls.at(-1).text.includes('текстом'));
    await handleMessage(message('/cancel')); assert.equal(getPendingIntent(user.id).kind, 'dinner-intake');
    await handleMessage(message('/feedback')); await handleMessage(message('Не открывается рецепт'));
    assert.equal(getPendingIntent(user.id).kind, 'dinner-intake');
    assert.equal(calls.filter(call => call.chat_id === '6971956699').length, 1);
    assert.ok(calls.at(-1).text.includes('отправлено владельцу'));
    await handleMessage({ ...message('/feedback'), chat: { id: -1, type: 'channel' } });
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM feedback_messages WHERE user_id=?').get(user.id).count, 1);
  } finally { globalThis.fetch = original; }
});
