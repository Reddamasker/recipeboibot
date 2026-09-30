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
const { SEED_RECIPES } = await import('../src/dinner.js');
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

test('search ignores generic recipe wording and requires the requested dish', () => {
  const owner = database.upsertTelegramUser({ id: 203, first_name: 'Поиск' });
  database.createRecipe(owner.id, { title: 'Протеиновое мороженое', description: 'Простой рецепт десерта', ingredients: [{ name: 'молоко' }] });
  database.createRecipe(owner.id, { title: 'Жареные баклажаны', ingredients: [{ name: 'баклажаны' }] });
  const fermented = database.createRecipe(owner.id, { title: 'Квашеные баклажаны', ingredients: [{ name: 'баклажаны' }] });
  assert.deepEqual(database.searchRecipes(owner.id, 'Рецепт квашеных баклажанов').map((recipe) => recipe.id), [fermented.id]);
  assert.deepEqual(database.searchRecipes(owner.id, 'квашеные баклажаны').map((recipe) => recipe.id), [fermented.id]);
  assert.equal(database.searchRecipes(owner.id, 'курицей').length, 0);
});

test('manual edits survive and ready status is saved', () => {
  const user = database.upsertTelegramUser({ id: 301, first_name: 'Маша' });
  const recipe = database.createRecipe(user.id, { title: 'Черновик', ingredients: [], steps: [] });
  const updated = database.updateRecipe(user.id, recipe.id, { ...recipe, title: 'Мой суп', status: 'ready', notes: 'Больше перца' });
  assert.equal(updated.title, 'Мой суп'); assert.equal(updated.status, 'ready'); assert.equal(updated.notes, 'Больше перца');
});

test('recipe share links are stable, read-only and do not expose personal notes', () => {
  const owner = database.upsertTelegramUser({ id: 302, first_name: 'Марина' });
  const stranger = database.upsertTelegramUser({ id: 303, first_name: 'Чужой' });
  const recipe = database.createRecipe(owner.id, {
    title: 'Сырники', description: 'Домашний рецепт', notes: 'Секретная заметка',
    ingredients: [{ name: 'творог', raw: 'творог' }], steps: [{ position: 1, text: 'Смешать' }]
  });
  const token = database.createRecipeShare(owner.id, recipe.id);
  assert.match(token, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(database.createRecipeShare(owner.id, recipe.id), token);
  assert.equal(database.createRecipeShare(stranger.id, recipe.id), null);
  const shared = database.getSharedRecipe(token);
  assert.equal(shared.title, 'Сырники');
  assert.equal(shared.sharedBy, 'Марина');
  assert.equal('notes' in shared, false);
  assert.equal('user_id' in shared, false);
  database.archiveRecipe(owner.id, recipe.id);
  assert.equal(database.getSharedRecipe(token), null);
});

test('dinner recipe shares are stable snapshots with an optional public image', () => {
  const owner = database.upsertTelegramUser({ id: 304, first_name: 'Павел' });
  const recipe = {
    id: 'dinner:11111111-1111-4111-8111-111111111111', origin: 'generated', title: 'Форель с овощами',
    description: 'Ужин для семьи', servings: 4, prepMinutes: 10, cookMinutes: 25,
    ingredients: [{ name: 'форель' }], steps: [{ position: 1, text: 'Запечь' }], tags: ['ужин'], warnings: [],
    sourceUrl: null, sourceName: 'Создано для тебя', dinnerGenerated: true, pantryMatch: { missing: ['лимон'] }
  };
  const image = { mime: 'image/jpeg', bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) };
  const token = database.createDinnerRecipeShare(owner.id, recipe.id, recipe);
  assert.match(token, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(database.createDinnerRecipeShare(owner.id, recipe.id, recipe, image), token);
  const shared = database.getSharedRecipe(token);
  assert.equal(shared.title, 'Форель с овощами');
  assert.equal(shared.sharedBy, 'Павел');
  assert.equal(shared.thumbnailUrl, `/shared-recipe-images/${token}`);
  assert.equal('pantryMatch' in shared, false);
  assert.deepEqual(Buffer.from(database.getSharedRecipeImage(token).bytes), image.bytes);
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

test('AI attempts remain counted past the former daily and lifetime limits', () => {
  for (let i=0; i<81; i++) database.recordAiAttempt();
  assert.equal(database.db.prepare('SELECT COUNT(*) AS n FROM ai_reservations').get().n, 81);
  assert.equal(database.aiUsageSummary(null).reservations.total, 81);
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

test('playlist import API requires active paid access before fetching YouTube', async () => {
  const telegramUser = { id: 409, first_name: 'Плейлист' };
  const user = database.upsertTelegramUser(telegramUser); database.allowUser(user.id);
  const initData = security.makeTelegramInitData(telegramUser, process.env.TELEGRAM_BOT_TOKEN);
  const server = createServer(); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${base}/api/import`, {
      method: 'POST', headers: { authorization: `tma ${initData}`, 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'url', value: 'https://www.youtube.com/playlist?list=PLMKH9rJBrNkyqFQ9BoHhivNs8A4FvRiX0' })
    });
    assert.equal(response.status, 402);
    assert.match((await response.json()).error, /активной подпиской/);
    assert.equal(database.listRecipes(user.id).length, 0);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('existing document routes serve a compressed startup with CSP and keep API authentication', async () => {
  const server = createServer(); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const route of ['/', '/?view=dinner', '/index.html', `/share/${'x'.repeat(32)}`]) {
      const response = await fetch(`${base}${route}`, { headers: { 'accept-encoding': 'gzip' } });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-encoding'), 'gzip');
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('vary'), 'Accept-Encoding');
      assert.match(response.headers.get('content-security-policy'), /script-src[^;]*'sha256-/);
      assert.doesNotMatch(response.headers.get('content-security-policy').split('style-src')[0], /unsafe-inline/);
      const html = await response.text();
      assert.match(html, /id="app"/);
      assert.doesNotMatch(html, /<script[^>]+src=/);
    }
    const plain = await fetch(base, { headers: { 'accept-encoding': 'identity' } });
    assert.equal(plain.headers.get('content-encoding'), null);
    assert.equal((await fetch(`${base}/api/me`)).status, 401);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('owner can create a public recipe link that opens without Telegram auth', async () => {
  const telegramUser = { id: 403, first_name: 'Лена' };
  const owner = database.upsertTelegramUser(telegramUser); database.allowUser(owner.id);
  const recipe = database.createRecipe(owner.id, { title: 'Шарлотка', notes: 'Только для меня', ingredients: [{ name: 'яблоки' }], steps: [{ text: 'Испечь' }] });
  const initData = security.makeTelegramInitData(telegramUser, process.env.TELEGRAM_BOT_TOKEN);
  const server = createServer(); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const created = await fetch(`${base}/api/recipes/${recipe.id}/share`, { method: 'POST', headers: { authorization: `tma ${initData}`, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(created.status, 200);
    const share = await created.json();
    assert.match(share.path, /^\/share\/[A-Za-z0-9_-]{32}$/);
    const publicResponse = await fetch(`${base}/api/shares/${share.token}`);
    assert.equal(publicResponse.status, 200);
    const publicRecipe = await publicResponse.json();
    assert.equal(publicRecipe.title, 'Шарлотка');
    assert.equal(publicRecipe.sharedBy, 'Лена');
    assert.equal('notes' in publicRecipe, false);
    const dinnerCreated = await fetch(`${base}/api/dinner/recipes/${encodeURIComponent(SEED_RECIPES[0].id)}/share`, { method: 'POST', headers: { authorization: `tma ${initData}`, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(dinnerCreated.status, 200);
    const dinnerShare = await dinnerCreated.json();
    const publicDinner = await (await fetch(`${base}/api/shares/${dinnerShare.token}`)).json();
    assert.equal(publicDinner.title, SEED_RECIPES[0].title);
    assert.equal(publicDinner.sharedBy, 'Лена');
    assert.equal((await fetch(`${base}/api/shares/${'x'.repeat(32)}`)).status, 404);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('suggestion save API requires the owner and confirms only once', async () => {
  const ownerTg = { id: 404, first_name: 'Оля' }, otherTg = { id: 405, first_name: 'Вера' };
  const owner = database.upsertTelegramUser(ownerTg), other = database.upsertTelegramUser(otherTg);
  database.allowUser(owner.id); database.allowUser(other.id);
  const proposal = database.createRecipeSuggestion(owner.id, 'суп с чечевицей', {
    title: 'Суп с чечевицей', ingredients: [{ name: 'чечевица', raw: 'чечевица' }], steps: [{ position: 1, text: 'Сварить' }]
  });
  const server = createServer(); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/suggestions/${proposal.id}/save`;
  try {
    const headersFor = (tg) => ({ authorization: `tma ${security.makeTelegramInitData(tg, process.env.TELEGRAM_BOT_TOKEN)}` });
    assert.equal((await fetch(url, { method: 'POST', headers: headersFor(otherTg) })).status, 404);
    assert.equal(database.listRecipes(owner.id).length, 0);
    const first = await fetch(url, { method: 'POST', headers: headersFor(ownerTg) });
    assert.equal(first.status, 200);
    const saved = await first.json();
    assert.equal(saved.origin, 'generated');
    const repeated = await fetch(url, { method: 'POST', headers: headersFor(ownerTg) });
    assert.equal((await repeated.json()).id, saved.id);
    assert.equal(database.listRecipes(owner.id).length, 1);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('trusted nginx client IP keeps unrelated visitors in separate rate-limit buckets', () => {
  const request = { socket: { remoteAddress: '172.18.0.1' }, headers: { 'x-real-ip': '203.0.113.10', 'x-forwarded-for': '198.51.100.20, 172.18.0.1' } };
  assert.equal(serverModule.clientIp(request, true), '203.0.113.10');
  assert.equal(serverModule.clientIp(request, false), '172.18.0.1');
  assert.equal(serverModule.clientIp({ socket: { remoteAddress: '172.18.0.1' }, headers: { 'x-real-ip': 'not-an-ip', 'x-forwarded-for': '198.51.100.20, 172.18.0.1' } }, true), '198.51.100.20');
  assert.equal(serverModule.clientIp({ socket: { remoteAddress: '172.18.0.1' }, headers: { 'x-real-ip': 'invalid' } }, true), '172.18.0.1');
});

test('Mini App voice request transcribes a short spoken dish and allows its microphone', async () => {
  const telegramUser = { id: 9410, first_name: 'Голос' };
  const owner = database.upsertTelegramUser(telegramUser);
  database.allowUser(owner.id);
  const initData = security.makeTelegramInitData(telegramUser, process.env.TELEGRAM_BOT_TOKEN);
  const server = createServer(); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith(base)) return originalFetch(url, options);
    assert.match(String(url), /audio\/transcriptions$/);
    assert.match(options.body.get('prompt'), /не суп/);
    assert.match(options.body.get('prompt'), /чечевица/);
    calls++;
    return Response.json({ text: 'Суп' });
  };
  try {
    const page = await fetch(`${base}/`);
    assert.match(page.headers.get('permissions-policy'), /microphone=\(self\)/);
    const response = await fetch(`${base}/api/recipe-request/transcribe`, { method: 'POST', headers: { authorization: `tma ${initData}`, 'content-type': 'application/json' }, body: JSON.stringify({ mime: 'audio/webm', value: Buffer.from('voice').toString('base64') }) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { text: 'Суп' });
    assert.equal(calls, 1);
    const unsupported = await fetch(`${base}/api/recipe-request/transcribe`, { method: 'POST', headers: { authorization: `tma ${initData}`, 'content-type': 'application/json' }, body: JSON.stringify({ mime: 'text/plain', value: 'dm9pY2U=' }) });
    assert.equal(unsupported.status, 415);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = originalFetch; await new Promise((resolve) => server.close(resolve)); }
});
