import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const testDb = path.resolve('data', `test-${process.pid}.sqlite`);
process.env.DATABASE_PATH = testDb;
process.env.TELEGRAM_BOT_TOKEN = '123456:test-secret';
process.env.OPENAI_API_KEY = 'test-key';
process.env.OPENAI_TEXT_MODEL = 'test-model';
process.env.OPENAI_TRANSCRIBE_MODEL = 'test-transcribe';
process.env.INVITE_CODE = 'test-invite-code';

const security = await import('../src/security.js');
const database = await import('../src/db.js');
const { createServer } = await import('../src/server.js');
const serverModule = await import('../src/server.js');

test.after(() => {
  database.db.close();
  for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(testDb + suffix); } catch {} }
});

test('Telegram initData validates authentic data and rejects tampering', () => {
  const user = { id: 101, first_name: 'Анна' };
  const value = security.makeTelegramInitData(user, process.env.TELEGRAM_BOT_TOKEN);
  assert.equal(security.validateTelegramInitData(value, process.env.TELEGRAM_BOT_TOKEN).id, 101);
  assert.throws(() => security.validateTelegramInitData(value.replace('%D0%90', '%D0%91'), process.env.TELEGRAM_BOT_TOKEN), /Telegram/);
});

test('expired Telegram initData is rejected', () => {
  const value = security.makeTelegramInitData({ id: 102, first_name: 'Иван' }, process.env.TELEGRAM_BOT_TOKEN, Math.floor(Date.now() / 1000) - 7200);
  assert.throws(() => security.validateTelegramInitData(value, process.env.TELEGRAM_BOT_TOKEN), /устарела/);
});

test('recipe access and search are isolated by owner', () => {
  const alice = database.upsertTelegramUser({ id: 201, first_name: 'Алиса' });
  const bob = database.upsertTelegramUser({ id: 202, first_name: 'Боб' });
  const recipe = database.createRecipe(alice.id, { title: 'Курица с томатами', ingredients: [{ name: 'курица', raw: 'курица' }], steps: [{ position: 1, text: 'Запечь' }] });
  assert.equal(database.getRecipe(alice.id, recipe.id).title, 'Курица с томатами');
  assert.equal(database.getRecipe(bob.id, recipe.id), null);
  assert.equal(database.searchRecipes(alice.id, 'курица').length, 1);
  assert.equal(database.searchRecipes(bob.id, 'курица').length, 0);
  assert.equal(database.updateRecipe(bob.id, recipe.id, { title: 'Чужой' }), null);
  assert.equal(database.archiveRecipe(bob.id, recipe.id), false);
});

test('manual edits survive and ready status is saved', () => {
  const user = database.upsertTelegramUser({ id: 301, first_name: 'Маша' });
  const recipe = database.createRecipe(user.id, { title: 'Черновик', ingredients: [], steps: [] });
  const updated = database.updateRecipe(user.id, recipe.id, { ...recipe, title: 'Мой суп', status: 'ready', notes: 'Больше перца' });
  assert.equal(updated.title, 'Мой суп'); assert.equal(updated.status, 'ready'); assert.equal(updated.notes, 'Больше перца');
});

test('SSRF guard rejects localhost and private addresses', async () => {
  await assert.rejects(security.assertSafeRemoteUrl('http://localhost/secret'), /Локальные/);
  await assert.rejects(security.assertSafeRemoteUrl('http://127.0.0.1/secret'), /запрещён/);
  await assert.rejects(security.assertSafeRemoteUrl('file:///etc/passwd'), /http\/https/);
});

test('Telegram update idempotency drops a duplicate', () => {
  assert.equal(database.markUpdate(999), true);
  assert.equal(database.markUpdate(999), false);
});

test('SSRF rejects special-use and mapped IPv6 addresses', () => {
  for (const ip of ['100.64.0.1','169.254.169.254','198.18.0.1','::ffff:7f00:1','::ffff:172.16.1.1','fe80::1','2002:7f00:1::']) assert.equal(security.isPrivateIp(ip), true, ip);
  assert.equal(security.isPrivateIp('93.184.215.14'), false);
});

test('AI quota reserves before calls and survives failed attempts', () => {
  for (let i=0; i<40; i++) database.reserveAiRequest();
  assert.throws(() => database.reserveAiRequest(), /Лимит AI/);
  assert.equal(database.db.prepare('SELECT COUNT(*) AS n FROM ai_reservations').get().n, 40);
  database.db.prepare("UPDATE ai_reservations SET created_at = datetime('now', '-1 day')").run();
  for (let i=0; i<40; i++) database.reserveAiRequest();
  database.db.prepare("UPDATE ai_reservations SET created_at = datetime('now', '-1 day')").run();
  assert.throws(() => database.reserveAiRequest(), /Лимит AI/);
  assert.equal(database.db.prepare('SELECT COUNT(*) AS n FROM ai_reservations').get().n, 80);
});

test('HTTP API requires signed Telegram auth and an allowed user', async () => {
  const allowedTg = { id: 401, first_name: 'Ольга' };
  const allowed = database.upsertTelegramUser(allowedTg); database.allowUser(allowed.id);
  const blockedTg = { id: 402, first_name: 'Ева' }; database.upsertTelegramUser(blockedTg);
  const server = createServer(); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/api/recipes`)).status, 401);
    const blockedInit = security.makeTelegramInitData(blockedTg, process.env.TELEGRAM_BOT_TOKEN);
    assert.equal((await fetch(`${base}/api/recipes`, { headers: { authorization: `tma ${blockedInit}` } })).status, 403);
    const allowedInit = security.makeTelegramInitData(allowedTg, process.env.TELEGRAM_BOT_TOKEN);
    const response = await fetch(`${base}/api/recipes`, { headers: { authorization: `tma ${allowedInit}` } });
    assert.equal(response.status, 200); assert.ok(Array.isArray(await response.json()));
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('trusted nginx client IP keeps unrelated visitors in separate rate-limit buckets', () => {
  const request = { socket: { remoteAddress: '172.18.0.1' }, headers: { 'x-real-ip': '203.0.113.10', 'x-forwarded-for': '198.51.100.20, 172.18.0.1' } };
  assert.equal(serverModule.clientIp(request, true), '203.0.113.10');
  assert.equal(serverModule.clientIp(request, false), '172.18.0.1');
  assert.equal(serverModule.clientIp({ socket: { remoteAddress: '172.18.0.1' }, headers: { 'x-real-ip': 'not-an-ip', 'x-forwarded-for': '198.51.100.20, 172.18.0.1' } }, true), '198.51.100.20');
  assert.equal(serverModule.clientIp({ socket: { remoteAddress: '172.18.0.1' }, headers: { 'x-real-ip': 'invalid' } }, true), '172.18.0.1');
});
