import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const testDb = path.resolve('data', `workflow-${process.pid}.sqlite`);
process.env.DATABASE_PATH = testDb;
process.env.TELEGRAM_BOT_TOKEN = '123456:test-secret';
process.env.OPENAI_API_KEY = 'test-key';
process.env.OPENAI_TEXT_MODEL = 'test-model';
process.env.OPENAI_TRANSCRIBE_MODEL = 'test-transcribe';
process.env.APP_URL = 'https://recipes.example.test';

const database = await import('../src/db.js');
const importer = await import('../src/importer.js');
const telegramModule = await import('../src/telegram.js');
const openaiModule = await import('../src/openai.js');

test.after(() => {
  database.db.close();
  for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(testDb + suffix); } catch {} }
});

const normalizedRecipe = (title = 'Крылышки с мёдом') => ({
  title, description: '', servings: null, prepMinutes: null, cookMinutes: null,
  ingredients: [{ raw: 'куриные крылышки', name: 'куриные крылышки', quantity: null, unit: null, comment: null, confidence: 1 }],
  steps: [{ position: 1, text: 'Приготовить', confidence: 1 }], tags: ['курица'], warnings: [], sourceName: null
});

test('intent detection routes clear voice/text requests and asks on ambiguity', () => {
  assert.equal(telegramModule.detectIntent('Есть курица, что приготовить на ужин?'), 'search');
  assert.equal(telegramModule.detectIntent('Найди те крылышки с мёдом'), 'search');
  assert.equal(telegramModule.detectIntent('Сохрани мой рецепт: курица, мёд, масло'), 'save');
  assert.equal(telegramModule.detectIntent('Курица и мёд'), 'ambiguous');
  assert.equal(telegramModule.detectIntent('', { hasPhoto: true }), 'save');
});

test('voice path calls ASR once and keeps Telegram file identity for idempotency', async () => {
  let transcriptions = 0; let receivedFilename;
  const interpreted = await telegramModule.interpretVoice({ voice: { duration: 9, file_id: 'file-1', file_unique_id: 'unique-1', mime_type: 'audio/ogg' } }, { id: 'u1' }, {
    download: async () => ({ buffer: Buffer.from('ogg'), path: 'voice/file-1.oga' }),
    transcribe: async ({ filename }) => { transcriptions += 1; receivedFilename = filename; return 'Найди те крылышки с мёдом'; }
  });
  assert.equal(transcriptions, 1);
  assert.equal(receivedFilename, 'file-1.ogg');
  assert.equal(interpreted.text, 'Найди те крылышки с мёдом');
  assert.equal(interpreted.sourceKey, 'telegram-voice:unique-1');
});

test('Responses API failures preserve safe diagnostics and return an actionable error', async () => {
  const originalFetch = globalThis.fetch;
  const user = database.upsertTelegramUser({ id: 6150, first_name: 'Диагностика' });
  globalThis.fetch = async (_url, options) => {
    assert.match(options.headers['x-client-request-id'], /^[0-9a-f-]{36}$/i);
    assert.equal(JSON.parse(options.body).max_output_tokens, 10000);
    return new Response(JSON.stringify({ error: { code: 'server_is_overloaded', type: 'service_unavailable_error', message: 'Model capacity is temporarily unavailable.' } }), { status: 503, headers: { 'x-request-id': 'req_test_overload', 'retry-after': '3' } });
  };
  try {
    await assert.rejects(
      openaiModule.normalizeRecipe({ userId: user.id, text: 'Курица 500 г. Обжарить до готовности.', sourceName: 'Тест' }),
      (error) => {
        assert.equal(error.providerStatus, 503);
        assert.equal(error.errorCode, 'server_is_overloaded');
        assert.equal(error.requestId, 'req_test_overload');
        assert.match(error.message, /временно перегружена/);
        assert.match(error.message, /req_test_overload/);
        return true;
      }
    );
    const saved = database.db.prepare("SELECT provider_status,error_code,error_type,error_message,request_id,client_request_id,incomplete_reason,retry_after FROM provider_requests WHERE operation='recipe_extraction' ORDER BY created_at DESC LIMIT 1").get();
    assert.deepEqual({ ...saved, client_request_id: Boolean(saved.client_request_id) }, {
      provider_status: 503,
      error_code: 'server_is_overloaded',
      error_type: 'service_unavailable_error',
      error_message: 'Model capacity is temporarily unavailable.',
      request_id: 'req_test_overload',
      client_request_id: true,
      incomplete_reason: null,
      retry_after: '3'
    });
  } finally { globalThis.fetch = originalFetch; }
});

test('incomplete and malformed structured responses are distinguished', async () => {
  const originalFetch = globalThis.fetch;
  const user = database.upsertTelegramUser({ id: 6151, first_name: 'Структура' });
  const payloads = [
    { id: 'resp_incomplete', model: 'test-model', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, usage: { input_tokens: 11, input_tokens_details: { cached_tokens: 3 }, output_tokens: 17, output_tokens_details: { reasoning_tokens: 13 }, total_tokens: 28 }, output: [] },
    { id: 'resp_bad_json', model: 'test-model', status: 'completed', usage: { input_tokens: 12, output_tokens: 5 }, output_text: '{not json' }
  ];
  globalThis.fetch = async () => new Response(JSON.stringify(payloads.shift()), { status: 200, headers: { 'x-request-id': `req_structure_${payloads.length}` } });
  try {
    await assert.rejects(openaiModule.normalizeRecipe({ userId: user.id, text: 'Ингредиенты и шаги тестового рецепта', sourceName: 'Тест' }), (error) => {
      assert.equal(error.errorCode, 'response_incomplete');
      assert.equal(error.incompleteReason, 'max_output_tokens');
      assert.match(error.message, /max_output_tokens/);
      return true;
    });
    await assert.rejects(openaiModule.normalizeRecipe({ userId: user.id, text: 'Ингредиенты и шаги второго рецепта', sourceName: 'Тест' }), (error) => {
      assert.equal(error.errorCode, 'invalid_structured_output');
      assert.match(error.message, /не в ожидаемом формате/);
      return true;
    });
  } finally { globalThis.fetch = originalFetch; }
});

test('/usage reports exact monitored tokens without an AI call', async () => {
  const originalFetch = globalThis.fetch; const sent = [];
  globalThis.fetch = async (_url, options) => { sent.push(JSON.parse(options.body)); return { json: async () => ({ ok: true, result: {} }) }; };
  try {
    const telegramId = 6152;
    const user = database.upsertTelegramUser({ id: telegramId, first_name: 'Мониторинг' });
    database.allowUser(user.id);
    database.recordProviderRequest({ userId: user.id, operation: 'recipe_extraction', model: 'test-model', inputUnits: 120, outputUnits: 80, reasoningUnits: 30, cachedInputUnits: 20, totalUnits: 200, usageComplete: true, status: 'ok', clientRequestId: 'client-test' });
    await telegramModule.handleMessage({ chat: { id: telegramId, type: 'private' }, from: { id: telegramId, first_name: 'Мониторинг' }, text: '/usage' });
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /Использование AI/);
    assert.match(sent[0].text, /120/);
    assert.match(sent[0].text, /80/);
    assert.match(sent[0].text, /reasoning: 30/);
    assert.match(sent[0].text, /Всего: <b>200<\/b>/);
  } finally { globalThis.fetch = originalFetch; }
});

test('parallel and repeated imports create one recipe and one AI call per user', async () => {
  const alice = database.upsertTelegramUser({ id: 6101, first_name: 'Алиса' });
  const bob = database.upsertTelegramUser({ id: 6102, first_name: 'Боб' });
  let release; const gate = new Promise((resolve) => { release = resolve; }); let calls = 0;
  const normalize = async () => { calls += 1; await gate; return normalizedRecipe(); };
  const first = importer.importText(alice.id, 'мой рецепт', { sourceKey: 'telegram-text:same', normalize });
  await Promise.resolve();
  const second = await importer.importText(alice.id, 'мой рецепт', { sourceKey: 'telegram-text:same', normalize });
  assert.equal(second.state, 'processing');
  release(); const created = await first;
  assert.equal(created.state, 'created'); assert.equal(calls, 1);
  const repeated = await importer.importText(alice.id, 'мой рецепт', { sourceKey: 'telegram-text:same', normalize });
  assert.equal(repeated.state, 'existing'); assert.equal(calls, 1);
  const otherUser = await importer.importText(bob.id, 'мой рецепт', { sourceKey: 'telegram-text:same', normalize: async () => { calls += 1; return normalizedRecipe(); } });
  assert.equal(otherUser.state, 'created'); assert.equal(calls, 2);
});

test('different sources with similar titles are never merged', async () => {
  const user = database.upsertTelegramUser({ id: 6201, first_name: 'Маша' });
  const normalize = async () => normalizedRecipe('Куриные крылышки');
  await importer.importText(user.id, 'source one', { sourceKey: 'url:https://example.test/one', normalize });
  await importer.importText(user.id, 'source two', { sourceKey: 'url:https://example.test/two', normalize });
  assert.equal(database.listRecipes(user.id).filter((x) => x.title === 'Куриные крылышки').length, 2);
});

test('failed process and Telegram update can be reclaimed safely', () => {
  const user = database.upsertTelegramUser({ id: 6301, first_name: 'Ира' });
  const claim = database.claimImport(user.id, { sourceType: 'url', sourceKey: 'url:https://example.test/recover', sourceUrl: 'https://example.test/recover', label: 'example.test' });
  database.updateJob(claim.job.id, 'normalizing');
  assert.ok(database.interruptActiveJobs() >= 1);
  assert.equal(database.claimImport(user.id, { sourceType: 'url', sourceKey: 'url:https://example.test/recover' }).state, 'claimed');
  assert.equal(database.claimUpdate(7001), true); database.failUpdate(7001);
  assert.equal(database.claimUpdate(7001), true); database.completeUpdate(7001);
  assert.equal(database.claimUpdate(7001), false);
});

test('YouTube identity strips tracking and exposes a real source preview', () => {
  const first = importer.normalizeSourceUrl('https://youtu.be/79aqvX4RnEU?si=tracking');
  const second = importer.normalizeSourceUrl('https://www.youtube.com/watch?v=79aqvX4RnEU&utm_source=x');
  assert.equal(first.sourceKey, 'youtube:79aqvX4RnEU');
  assert.equal(first.sourceKey, second.sourceKey);
  assert.match(first.thumbnailUrl, /79aqvX4RnEU\/hqdefault\.jpg$/);
});

test('Mini App deep links retain exact recipe or result query', () => {
  const recipe = new URL(telegramModule.webAppUrl({ recipe: 'recipe id' }));
  assert.equal(recipe.searchParams.get('recipe'), 'recipe id');
  const results = new URL(telegramModule.webAppUrl({ view: 'results', q: 'крылышки с мёдом' }));
  assert.equal(results.searchParams.get('view'), 'results');
  assert.equal(results.searchParams.get('q'), 'крылышки с мёдом');
});

test('new and returning users can Start without an invite code', async () => {
  const originalFetch = globalThis.fetch; const sent = [];
  globalThis.fetch = async (_url, options) => { sent.push(JSON.parse(options.body)); return { json: async () => ({ ok: true, result: {} }) }; };
  try {
    const message = { chat: { id: 6401, type: 'private' }, from: { id: 6401, first_name: 'Новый' }, text: '/start' };
    await telegramModule.handleMessage(message); await telegramModule.handleMessage(message);
    assert.equal(database.getUserByTelegramId(6401).is_allowed, 1);
    assert.equal(sent.length, 2);
    assert.ok(sent.every((body) => body.reply_markup?.inline_keyboard?.[0]?.[0]?.web_app?.url));
    assert.ok(sent.every((body) => !/код приглашения/i.test(body.text)));
  } finally { globalThis.fetch = originalFetch; }
});

test('mobile collection is fixed to two columns with an honest preview fallback', () => {
  const css = fs.readFileSync(path.resolve('public/styles.css'), 'utf8');
  const app = fs.readFileSync(path.resolve('public/app.js'), 'utf8');
  assert.match(css, /\.grid \{ display: grid; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(app, /Превью<br>недоступно/);
  assert.doesNotMatch(app, /AI-идея/);
});

test('recipe detail keeps the source first with a Telegram-native link', () => {
  const app = fs.readFileSync(path.resolve('public/app.js'), 'utf8');
  const css = fs.readFileSync(path.resolve('public/refinements.css'), 'utf8');
  const index = fs.readFileSync(path.resolve('public/index.html'), 'utf8');
  assert.match(app, /<a class="source-chip" data-source-link href=/);
  assert.match(app, /tg\.openLink\(r\.sourceUrl\)/);
  assert.match(app, /detail-toolbar">\$\{sourceChip\}/);
  assert.match(app, /recipe-detail-sheet/);
  assert.match(app, /data-tag=/);
  assert.match(css, /\.recipe-detail-sheet \{/);
  assert.match(css, /\.detail-actions \{ position: fixed/);
  assert.match(css, /\.recipe-panel \{[\s\S]*border-top: 1px solid var\(--line\)/);
  assert.match(index, /refinements\.css\?v=6/);
  assert.match(index, /app\.js\?v=6/);
});

test('home prioritizes choosing and the collection, with manual saving last', () => {
  const app = fs.readFileSync(path.resolve('public/app.js'), 'utf8');
  const home = app.slice(app.indexOf('function home()'), app.indexOf('function searchView()'));
  assert.ok(home.indexOf('id="choose"') >= 0);
  assert.ok(home.indexOf('id="choose"') < home.indexOf('id="collection"'));
  assert.ok(home.indexOf('id="collection"') < home.indexOf('id="add"'));
  assert.match(home, /home-footer[\s\S]*id="add"/);
  assert.doesNotMatch(home, /home-hero|hero-art|save-action|empty-add/);
});
