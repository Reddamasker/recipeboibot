import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHmac } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import https from 'node:https';
import dns from 'node:dns/promises';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

if (!process.env.MULTIPHOTO_PLATFORM) {
  for (const platform of ['telegram', 'max']) test('multi-photo HTTP, chat, retries and analytics: ' + platform, () => {
    const env = { ...process.env, MULTIPHOTO_PLATFORM: platform }; delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', fileURLToPath(import.meta.url)], { encoding: 'utf8', env });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /tests 9/, result.stdout);
  });
} else {
  const platform = process.env.MULTIPHOTO_PLATFORM, file = path.resolve('data', 'multi-photo-' + randomUUID() + '.sqlite');
  Object.assign(process.env, { DATABASE_PATH: file, BOT_PLATFORM: platform, TELEGRAM_BOT_TOKEN: 'photo-fixture', MAX_BOT_TOKEN: 'photo-fixture', MAX_BOT_USERNAME: 'fixture_bot', MAX_WEBHOOK_SECRET: 's'.repeat(64), TELEGRAM_POLLING: 'false', TEST_CONTOUR: 'false', OPENAI_API_KEY: 'fixture', OPENAI_TEXT_MODEL: 'fixture', OPENAI_HTTPS_PROXY: '', DINNER_LLM_ENABLED: 'false', DINNER_IMAGES_ENABLED: 'false', APP_URL: 'https://recipes.example.test' });
  const { db, upsertTelegramUser, allowUser, deleteUserData } = await import('../src/db.js');
  const { grantSubscription } = await import('../src/subscriptions.js');
  const { handleChatUpdate } = await import('../src/telegram.js');
  const { normalizeMaxUpdate } = await import('../src/max-events.js');
  const { maxStore } = await import('../src/max-store.js');
  const { getPhotoDraft, addPhotoDraft, claimPhotoDraft, recoverPhotoDrafts } = await import('../src/photo-drafts.js');
  const { importText } = await import('../src/importer.js');
  const { productReport, validProductReport, recordProduct } = await import('../src/product-analytics.js');
  const { createServer } = await import('../src/server.js');
  const { recipePhotos } = await import('../src/photo-sources.js');
  let serial = 971000, responseSerial = 0, output, ai = [], sent = [], downloads = [], providerGate = null;
  const originals = { fetch: globalThis.fetch, request: https.request, lookup: dns.lookup };
  const bytes = n => Buffer.from([255, 216, 255, 224, 0, 16, n]);
  const photo = n => ({ buffer: bytes(n), mime: 'image/jpeg' });
  const complete = () => ({ title: 'Рецепт по всем фото', description: '', sourceText: 'Приватный текст источника', coverageComplete: true, missingParts: [], servings: 2, totalMinutes: 30, prepMinutes: null, cookMinutes: null, ingredients: [{ raw: 'Мука — 100 г', name: 'Мука', quantity: 100, unit: 'г', confidence: 1 }], steps: [{ position: 1, text: 'Замесить тесто.', confidence: 1 }, { position: 2, text: 'Выпекать 20 минут.', confidence: 1 }], tags: [], warnings: [], sourceName: null, nutrition: { calories: 100, protein: 3, fat: 5, carbs: 10, basis: 'serving', source: 'calculated', servings: 2, assumptions: [] } });
  function fresh(paid = true) {
    const id = ++serial, from = { id: platform === 'max' ? 'max:' + id : id, first_name: 'Проверка' }, chat = { id: from.id, type: 'private' };
    const user = upsertTelegramUser(from); allowUser(user.id);
    if (paid) grantSubscription(user.id, 'subscription', new Date(Date.now() + 86400000).toISOString());
    if (platform === 'max') maxStore.bind(String(id + 100000), String(id));
    return { id, from, chat, user };
  }
  function message(who, n, messageId = n) {
    if (platform === 'max') return normalizeMaxUpdate({ update_type: 'message_created', timestamp: Date.now(), message: { sender: { user_id: who.id, first_name: 'Проверка' }, recipient: { chat_type: 'dialog', chat_id: who.id + 100000 }, body: { mid: 'incoming-' + messageId, attachments: [{ type: 'image', payload: { url: 'https://photos.example.test/' + n } }] } } }).message;
    return { from: who.from, chat: who.chat, message_id: messageId, media_group_id: 'album-fixture', photo: [{ file_id: 'small-' + n, file_unique_id: 'small-' + n }, { file_id: String(n), file_unique_id: 'photo-' + n }] };
  }
  async function callback(who, draft, action = 'build') {
    const id = randomUUID();
    if (platform === 'max') maxStore.rememberCallback(id, who.id);
    await handleChatUpdate({ callback_query: { id, from: who.from, message: { chat: who.chat, message_id: 'outgoing' }, data: `photos:${action}:${draft.id}:${draft.revision}` } });
  }
  function auth(who) {
    const params = new URLSearchParams({ user: JSON.stringify({ id: who.id, first_name: 'Проверка' }), auth_date: String(Math.floor(Date.now() / 1000)) });
    const check = [...params].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
    const key = createHmac('sha256', 'WebAppData').update('photo-fixture').digest();
    params.set('hash', createHmac('sha256', key).update(check).digest('hex'));
    return { authorization: (platform === 'max' ? 'mxa ' : 'tma ') + params, 'content-type': 'application/json' };
  }
  let server, base;
  test.before(async () => {
    server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); base = 'http://127.0.0.1:' + server.address().port;
    globalThis.fetch = async (url, options = {}) => {
      const parsed = new URL(url);
      if (parsed.hostname === '127.0.0.1') return originals.fetch(url, options);
      if (parsed.hostname === 'api.openai.com') { ai.push(JSON.parse(options.body)); if (providerGate) await providerGate; return Response.json({ status: 'completed', output_text: JSON.stringify(output), usage: { input_tokens: 10, output_tokens: 20 } }); }
      const body = options.body ? JSON.parse(options.body) : {};
      if (parsed.hostname === 'api.telegram.org') {
        if (parsed.pathname.includes('/file/')) { downloads.push(parsed.pathname.split('/').at(-1)); return new Response(bytes(Number(parsed.pathname.split('/').at(-1)))); }
        const method = parsed.pathname.split('/').at(-1);
        if (method === 'getFile') return Response.json({ ok: true, result: { file_path: body.file_id, file_size: 7 } });
        sent.push(body); return Response.json({ ok: true, result: { message_id: ++responseSerial } });
      }
      if (parsed.hostname === 'platform-api2.max.ru') {
        sent.push(body); const id = Number(parsed.searchParams.get('user_id') || 1);
        return Response.json({ success: true, message: { body: { mid: 'outgoing-' + ++responseSerial, text: body.text }, recipient: { chat_type: 'dialog', chat_id: id + 100000 } } });
      }
      throw Error('Unexpected network destination');
    };
    dns.lookup = async host => { assert.equal(host, 'photos.example.test'); return [{ address: '8.8.8.8', family: 4 }]; };
    https.request = (url, options, done) => {
      assert.equal(url.hostname, 'photos.example.test');
      const req = new EventEmitter(); req.destroy = () => {};
      req.end = () => queueMicrotask(() => { downloads.push(url.pathname.slice(1)); const stream = Readable.from([bytes(Number(url.pathname.slice(1)))]); stream.statusCode = 200; stream.headers = { 'content-type': 'image/jpeg' }; done(stream); });
      return req;
    };
  });
  test.beforeEach(() => { output = complete(); ai = []; sent = []; downloads = []; });
  test.after(async () => { globalThis.fetch = originals.fetch; https.request = originals.request; dns.lookup = originals.lookup; await new Promise(resolve => server.close(resolve)); db.close(); for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true }); });

  test('HTTP sends all ordered originals; repeated source and duplicate bytes create one recipe', async () => {
    const who = fresh();
    const post = body => fetch(base + '/api/import', { method: 'POST', headers: auth(who), body: JSON.stringify(body) });
    const body = { kind: 'image', photos: [1, 2, 2, 3].map(n => ({ mime: 'image/jpeg', value: bytes(n).toString('base64') })) };
    const response = await post(body); assert.equal(response.status, 201); const saved = await response.json();
    assert.equal(saved.recipe.steps.length, 2); assert.equal(ai.length, 1);
    const inputs = ai[0].input[0].content.filter(c => c.type === 'input_image');
    assert.deepEqual(inputs.map(c => c.image_url), [1, 2, 3].map(n => 'data:image/jpeg;base64,' + bytes(n).toString('base64')));
    assert.ok(inputs.every(c => c.detail === 'high')); assert.ok(ai[0].text.format.schema.required.includes('coverageComplete'));
    assert.equal((await (await post(body)).json()).state, 'existing'); assert.equal(ai.length, 1);
    const r = productReport([who.user]); assert.equal(r.photoImports.multiple, 1); assert.equal(r.photoImports.images, 3); assert.equal(r.photoImports.ready, 1);
    assert.ok(!JSON.stringify(r).includes('Приватный')); assert.equal(saved.recipe.coverageComplete, undefined);
  });
  test('HTTP rejects count, type, total size and body overflow before AI; old single-image API stays valid', async () => {
    const who = fresh(), one = { mime: 'image/jpeg', value: bytes(9).toString('base64') };
    const post = body => fetch(base + '/api/import', { method: 'POST', headers: auth(who), body: JSON.stringify(body) });
    for (const [photos, status] of [[[], 400], [Array(11).fill(one), 400], [[{ ...one, mime: 'image/png' }], 415], [[{ mime: 'image/jpeg', value: Buffer.alloc(6 * 1024 * 1024 + 1).toString('base64') }], 413]]) assert.equal((await post({ kind: 'image', photos })).status, status);
    assert.equal(ai.length, 0);
    assert.equal((await post({ kind: 'image', ...one })).status, 201);
  });
  test('chat stages all parts, uses current button, preserves order and never processes twice', async () => {
    const who = fresh();
    await handleChatUpdate({ message: message(who, 21) });
    const old = getPhotoDraft(who.user.id, who.chat.id, who.from.id);
    await handleChatUpdate({ message: message(who, 22) });
    await handleChatUpdate({ message: message(who, 22) });
    const draft = getPhotoDraft(who.user.id, who.chat.id, who.from.id);
    assert.equal(draft.parts.length, 2); assert.equal(ai.length, 0);
    await callback(who, old); assert.equal(ai.length, 0);
    await callback(who, draft); assert.equal(ai.length, 1); assert.deepEqual(downloads, ['21', '22']);
    assert.equal(getPhotoDraft(who.user.id, who.chat.id, who.from.id), null);
    await callback(who, draft); assert.equal(ai.length, 1);
    assert.equal(productReport([who.user]).photoImports.drafts, 1);
  });
  test('MAX message with several attachments retains every photo; Telegram sizes remain one photo', async () => {
    const who = fresh(); let m = message(who, 31);
    if (platform === 'max') m = normalizeMaxUpdate({ update_type: 'message_created', timestamp: Date.now(), message: { sender: { user_id: who.id }, recipient: { chat_type: 'dialog', chat_id: who.id + 100000 }, body: { mid: 'multi', attachments: [31, 32, 33].map(n => ({ type: 'image', payload: { url: 'https://photos.example.test/' + n } })) } } }).message;
    await handleChatUpdate({ message: m });
    const draft = getPhotoDraft(who.user.id, who.chat.id, who.from.id);
    assert.equal(draft.parts.length, platform === 'max' ? 3 : 1);
    await callback(who, draft); assert.equal(ai.length, 1); assert.equal(downloads.length, platform === 'max' ? 3 : 1);
  });
  test('missing continuation refuses ready, retains draft, retries same job and reports error time', async () => {
    const who = fresh(); await handleChatUpdate({ message: message(who, 41) }); await handleChatUpdate({ message: message(who, 42) });
    const draft = getPhotoDraft(who.user.id, who.chat.id, who.from.id);
    output = { ...complete(), coverageComplete: false, missingParts: ['Пропущены шаги'] };
    await callback(who, draft); assert.equal(ai.length, 2); assert.ok(getPhotoDraft(who.user.id, who.chat.id, who.from.id));
    let r = productReport([who.user]); assert.equal(r.photoImports.failed, 1); assert.equal(r.steps.find(s => s.step === 'import').errors, 1);
    assert.equal(db.prepare('SELECT count(*) n FROM recipes WHERE user_id=?').get(who.user.id).n, 0);
    output = complete(); await callback(who, draft); assert.equal(ai.length, 3);
    r = productReport([who.user]); assert.equal(r.photoImports.ready, 1); assert.equal(r.photoImports.multiple, 1);
    assert.equal(db.prepare('SELECT count(*) n FROM import_jobs WHERE user_id=?').get(who.user.id).n, 1);
  });
  test('separate users, remove, cancel, expiry and account deletion preserve isolation', async () => {
    const who = fresh(), other = fresh();
    for (const n of [51, 52]) await handleChatUpdate({ message: message(who, n) });
    const original = getPhotoDraft(who.user.id, who.chat.id, who.from.id);
    await callback(other, original, 'cancel'); assert.ok(getPhotoDraft(who.user.id, who.chat.id, who.from.id));
    await callback(who, original, 'remove'); const reduced = getPhotoDraft(who.user.id, who.chat.id, who.from.id); assert.equal(reduced.parts.length, 1);
    await callback(who, reduced, 'cancel'); await callback(who, reduced, 'cancel');
    assert.equal(productReport([who.user]).photoImports.cancelled, 1);
    await handleChatUpdate({ message: message(who, 53) });
    db.prepare("UPDATE photo_import_drafts SET updated_at='2020-01-01T00:00:00Z' WHERE user_id=?").run(who.user.id);
    assert.equal(getPhotoDraft(who.user.id, who.chat.id, who.from.id), null);
    await handleChatUpdate({ message: message(who, 54) }); await handleChatUpdate({ message: message(other, 55) });
    deleteUserData(who.user.id); assert.equal(getPhotoDraft(who.user.id, who.chat.id, who.from.id), null); assert.ok(getPhotoDraft(other.user.id, other.chat.id, other.from.id));
  });
  test('concurrent callbacks cannot extract twice or mutate a processing draft', async () => {
    const who = fresh();
    for (const n of [81, 82]) await handleChatUpdate({ message: message(who, n) });
    const draft = getPhotoDraft(who.user.id, who.chat.id, who.from.id);
    let release; providerGate = new Promise(resolve => { release = resolve; });
    const building = callback(who, draft);
    try {
      for (let i = 0; i < 80 && !ai.length; i++) await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(ai.length, 1);
      await callback(who, draft); assert.equal(ai.length, 1);
      assert.throws(() => addPhotoDraft(who.user.id, message(who, 83)), e => e.status === 409);
    } finally { release(); providerGate = null; await building; }
    assert.equal(productReport([who.user]).photoImports.ready, 1);
  });
  test('expired access blocks assembly without discarding photos or calling AI', async () => {
    const who = fresh(); await handleChatUpdate({ message: message(who, 91) });
    const draft = getPhotoDraft(who.user.id, who.chat.id, who.from.id);
    db.prepare("UPDATE user_subscriptions SET expires_at='2020-01-08T00:00:00Z' WHERE user_id=?").run(who.user.id);
    db.prepare('INSERT INTO user_trials(user_id,starts_at,expires_at) VALUES(?,?,?)').run(who.user.id,'2020-01-01T00:00:00Z','2020-01-08T00:00:00Z');
    await callback(who,draft); assert.equal(ai.length,0); assert.ok(getPhotoDraft(who.user.id,who.chat.id,who.from.id));
    assert.equal(productReport([who.user]).steps.find(s=>s.step==='import').errors,1);
  });
  test('draft count and aggregate size limits are enforced; source filters and bridge remain strict', () => {
    const who = fresh();
    for (let n = 60; n < 70; n++) addPhotoDraft(who.user.id, message(who, n));
    assert.throws(() => addPhotoDraft(who.user.id, message(who, 70)), e => e.status === 413);
    assert.equal(getPhotoDraft(who.user.id, who.chat.id, who.from.id).parts.length, 10);
    const stored = getPhotoDraft(who.user.id, who.chat.id, who.from.id);
    assert.equal(claimPhotoDraft(stored), true); assert.equal(claimPhotoDraft(stored), false);
    assert.equal(recoverPhotoDrafts(), 1);
    assert.equal(getPhotoDraft(who.user.id, who.chat.id, who.from.id).parts.length, 10);
    assert.throws(() => recipePhotos({ photos: [{ mime: 'image/jpeg', buffer: Buffer.alloc(4 * 1024 * 1024) }, { mime: 'image/jpeg', buffer: Buffer.alloc(3 * 1024 * 1024) }] }), e => e.status === 413);
    const r = productReport([who.user]); const asMax = { ...r, platform: 'max', trialReminders: null };
    assert.equal(validProductReport(asMax), true);
    assert.equal(validProductReport({ ...asMax, photoImports: { ...asMax.photoImports, images: -1 } }), false);
    const legacy = { ...asMax }; delete legacy.photoImports; assert.equal(validProductReport(legacy), true);
    assert.equal(productReport([]).photoImports.drafts, 0);
    assert.equal(productReport([{ ...who.user, started_at: '2099-01-01T00:00:00Z' }], true).photoImports.drafts, 0);
  });
}
