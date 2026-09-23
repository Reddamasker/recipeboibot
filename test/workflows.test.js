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
const suggestions = await import('../src/suggestions.js');

test.after(() => {
  database.db.close();
  for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(testDb + suffix); } catch {} }
});

const normalizedRecipe = (title = 'Крылышки с мёдом') => ({
  title, description: '', servings: null, prepMinutes: null, cookMinutes: null,
  ingredients: [{ raw: 'куриные крылышки', name: 'куриные крылышки', quantity: null, unit: null, comment: null, confidence: 1 }],
  steps: [{ position: 1, text: 'Приготовить', confidence: 1 }], tags: ['курица'], warnings: [], sourceName: null
});

test('empty search proposes a recipe and saves it only after owner confirmation', async () => {
  const owner = database.upsertTelegramUser({ id: 6160, first_name: 'Автор' });
  const other = database.upsertTelegramUser({ id: 6161, first_name: 'Другой' });
  let calls = 0;
  const generate = async () => { calls += 1; return normalizedRecipe('Новый ужин с фасолью'); };
  const proposal = await suggestions.suggestForEmptySearch(owner.id, 'ужин с фасолью', { generate });
  assert.equal(database.listRecipes(owner.id).length, 0);
  assert.equal((await suggestions.suggestForEmptySearch(owner.id, 'ужин с фасолью', { generate })).id, proposal.id);
  assert.equal(calls, 1);
  assert.equal(database.saveRecipeSuggestion(other.id, proposal.id), null);
  const saved = database.saveRecipeSuggestion(owner.id, proposal.id);
  assert.equal(saved.origin, 'generated');
  assert.equal(saved.status, 'ready');
  assert.equal(saved.sourceName, 'Создано для меня · AI');
  assert.equal(database.saveRecipeSuggestion(owner.id, proposal.id).id, saved.id);
  assert.equal(database.listRecipes(owner.id).length, 1);
  await assert.rejects(suggestions.suggestForEmptySearch(owner.id, 'фасоль', { generate }), (error) => error.status === 409);
});

test('parallel empty searches share one generation request', async () => {
  const owner = database.upsertTelegramUser({ id: 6164, first_name: 'Параллельно' });
  let release; const gate = new Promise((resolve) => { release = resolve; }); let calls = 0;
  const generate = async () => { calls += 1; await gate; return normalizedRecipe('Пирог с яблоком'); };
  const first = suggestions.suggestForEmptySearch(owner.id, 'пирог с яблоком', { generate });
  const second = suggestions.suggestForEmptySearch(owner.id, 'пирог с яблоком', { generate });
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.equal(a.id, b.id);
});

test('group suggestion can only be added by the collection owner', async () => {
  const owner = database.upsertTelegramUser({ id: 6162, first_name: 'Владелец' });
  database.setGroupAccessByTelegramId(6162, true);
  database.activateTelegramGroup(owner.id, { id: -61620, type: 'group', title: 'Семья' });
  const proposal = database.createRecipeSuggestion(owner.id, 'пирог с грушей', normalizedRecipe('Грушевый пирог'));
  const originalFetch = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, options) => { calls.push({ method: new URL(url).pathname.split('/').at(-1), body: JSON.parse(options.body) }); return { json: async () => ({ ok: true, result: {} }) }; };
  try {
    const callback = { id: 'callback-1', data: `suggest:save:${proposal.id}`, message: { message_id: 11, chat: { id: -61620, type: 'group' } }, from: { id: 6163, first_name: 'Участник' } };
    await telegramModule.handleSuggestionCallback(callback);
    assert.equal(database.listRecipes(owner.id).length, 0);
    assert.equal(calls[0].body.show_alert, true);
    calls.length = 0;
    await telegramModule.handleSuggestionCallback({ ...callback, from: { id: 6162, first_name: 'Владелец' } });
    assert.equal(database.listRecipes(owner.id).length, 1);
    assert.deepEqual(calls.map((call) => call.method), ['answerCallbackQuery', 'editMessageReplyMarkup', 'sendMessage']);
  } finally { globalThis.fetch = originalFetch; }
});

test('private Telegram search shows a generated recipe and waits for the save button', async () => {
  const telegramUser = { id: 6165, first_name: 'Поиск' };
  const owner = database.upsertTelegramUser(telegramUser); database.allowUser(owner.id);
  const originalFetch = globalThis.fetch; const sent = []; let aiCalls = 0;
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('api.openai.com')) {
      aiCalls += 1;
      assert.equal(JSON.parse(options.body).text.format.name, 'recipe_generation');
      return new Response(JSON.stringify({ status: 'completed', model: 'test-model', output_text: JSON.stringify(normalizedRecipe('Суп с тыквой')), usage: { input_tokens: 10, output_tokens: 20 } }), { status: 200 });
    }
    sent.push(JSON.parse(options.body));
    return { json: async () => ({ ok: true, result: { message_id: 12 } }) };
  };
  try {
    await telegramModule.handleMessage({ chat: { id: 6165, type: 'private' }, from: telegramUser, text: 'Найди суп с тыквой' });
    assert.equal(aiCalls, 1);
    assert.equal(database.listRecipes(owner.id).length, 0);
    assert.match(sent[0].text, /ничего подходящего/);
    assert.match(sent[1].text, /Суп с тыквой/);
    const callbackData = sent[1].reply_markup.inline_keyboard[0][0].callback_data;
    assert.match(callbackData, /^suggest:save:/);
    await telegramModule.handleSuggestionCallback({ id: 'callback-private', data: callbackData, message: { message_id: 12, chat: { id: 6165, type: 'private' } }, from: telegramUser });
    assert.equal(database.listRecipes(owner.id).length, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test('intent detection routes clear voice/text requests and asks on ambiguity', () => {
  assert.equal(telegramModule.detectIntent('Есть курица, что приготовить на ужин?'), 'search');
  assert.equal(telegramModule.detectIntent('Найди те крылышки с мёдом'), 'search');
  assert.equal(telegramModule.detectIntent('Сохрани мой рецепт: курица, мёд, масло'), 'save');
  assert.equal(telegramModule.detectIntent('/save курица, мёд, масло'), 'save');
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
  assert.equal(database.listImportJobs(user.id).length, 0);
  assert.equal(database.claimImport(user.id, { sourceType: 'url', sourceKey: 'url:https://example.test/recover' }).state, 'claimed');
  assert.equal(database.listImportJobs(user.id).length, 1);
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

test('first Start explains the bot with three actions; returning Start stays concise', async () => {
  const originalFetch = globalThis.fetch; const sent = [];
  globalThis.fetch = async (_url, options) => { sent.push(JSON.parse(options.body)); return { json: async () => ({ ok: true, result: {} }) }; };
  try {
    const message = { chat: { id: 6401, type: 'private' }, from: { id: 6401, first_name: 'Новый' }, text: '/start' };
    await telegramModule.handleMessage(message); await telegramModule.handleMessage(message);
    assert.equal(database.getUserByTelegramId(6401).is_allowed, 1);
    assert.equal(sent.length, 2);
    assert.match(sent[0].text, /Что я умею/);
    assert.match(sent[0].text, /Как начать/);
    assert.deepEqual(sent[0].reply_markup.inline_keyboard.map((row) => row[0].text), ['Сохранить рецепт', 'Что приготовить?', 'Мои рецепты']);
    assert.equal(new URL(sent[0].reply_markup.inline_keyboard[0][0].web_app.url).searchParams.get('view'), 'add');
    assert.equal(new URL(sent[0].reply_markup.inline_keyboard[1][0].web_app.url).searchParams.get('view'), 'search');
    assert.equal(new URL(sent[0].reply_markup.inline_keyboard[2][0].web_app.url).searchParams.get('view'), 'collection');
    assert.match(sent[1].text, /С возвращением/);
    assert.equal(sent[1].reply_markup.inline_keyboard[0][0].text, 'Открыть приложение');
    assert.ok(sent.every((body) => !/код приглашения/i.test(body.text)));
  } finally { globalThis.fetch = originalFetch; }
});

test('group access is denied by default, allows three active groups, and frees a removed slot', async () => {
  const originalFetch = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ method: new URL(url).pathname.split('/').at(-1), body: JSON.parse(options.body) });
    return { json: async () => ({ ok: true, result: {} }) };
  };
  try {
    const deniedChange = {
      chat: { id: -65020, type: 'group', title: 'Без права' },
      from: { id: 6502, first_name: 'Нет права' },
      old_chat_member: { status: 'left' }, new_chat_member: { status: 'member' }
    };
    await telegramModule.handleMyChatMember(deniedChange);
    assert.deepEqual(calls.map((x) => x.method), ['sendMessage', 'leaveChat']);
    assert.match(calls[0].body.text, /Групповой доступ пока не подключён/);
    assert.equal(calls[0].body.reply_markup.inline_keyboard[0][0].url, 'https://recipes.spas-sky.ru/groups.html');
    assert.equal(database.getActiveTelegramGroup(-65020), null);

    calls.length = 0;
    const owner = database.upsertTelegramUser({ id: 6501, first_name: 'Владелец' });
    database.setGroupAccessByTelegramId(6501, true);
    for (const chatId of [-65011, -65012, -65013]) {
      await telegramModule.handleMyChatMember({
        chat: { id: chatId, type: 'supergroup', title: `Группа ${chatId}` }, from: { id: 6501, first_name: 'Владелец' },
        old_chat_member: { status: 'left' }, new_chat_member: { status: 'member' }
      });
    }
    assert.equal(database.listActiveTelegramGroups(owner.id).length, 3);
    assert.ok(calls.every((x) => x.method === 'sendMessage'));

    calls.length = 0;
    await telegramModule.handleMyChatMember({
      chat: { id: -65014, type: 'group', title: 'Лишняя' }, from: { id: 6501, first_name: 'Владелец' },
      old_chat_member: { status: 'left' }, new_chat_member: { status: 'member' }
    });
    assert.deepEqual(calls.map((x) => x.method), ['sendMessage', 'leaveChat']);
    assert.match(calls[0].body.text, /Все 3 места уже заняты/);

    await telegramModule.handleMyChatMember({
      chat: { id: -65011, type: 'supergroup', title: 'Удалённая' }, from: { id: 6501, first_name: 'Владелец' },
      old_chat_member: { status: 'member' }, new_chat_member: { status: 'left' }
    });
    calls.length = 0;
    await telegramModule.handleMyChatMember({
      chat: { id: -65014, type: 'group', title: 'Новая третья' }, from: { id: 6501, first_name: 'Владелец' },
      old_chat_member: { status: 'left' }, new_chat_member: { status: 'member' }
    });
    assert.equal(database.listActiveTelegramGroups(owner.id).length, 3);
    assert.deepEqual(calls.map((x) => x.method), ['sendMessage']);
  } finally { globalThis.fetch = originalFetch; }
});

test('an active group uses its owner collection and leaves after access is revoked', async () => {
  const originalFetch = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ method: new URL(url).pathname.split('/').at(-1), body: JSON.parse(options.body) });
    return { json: async () => ({ ok: true, result: {} }) };
  };
  try {
    const owner = database.upsertTelegramUser({ id: 6510, first_name: 'Хозяин коллекции' });
    database.setGroupAccessByTelegramId(6510, true);
    database.activateTelegramGroup(owner.id, { id: -65100, type: 'group', title: 'Семейная' });
    database.createRecipe(owner.id, { status: 'ready', title: 'Курица с лимоном', ingredients: [{ name: 'курица', raw: 'курица' }], steps: [{ position: 1, text: 'Запечь' }] });

    await telegramModule.handleMessage({ chat: { id: -65100, type: 'group' }, from: { id: 6511, first_name: 'Участник' }, text: '/find@Recipeboibot курица' });
    assert.equal(calls.length, 2);
    assert.ok(calls.every((x) => x.method === 'sendMessage'));
    assert.match(calls[0].body.text, /коллекции владельца группы/);
    assert.match(calls[1].body.text, /Курица с лимоном/);
    assert.ok(calls.every((x) => !x.body.reply_markup?.inline_keyboard?.flat().some((button) => button.web_app)));

    calls.length = 0;
    await telegramModule.handleMessage({ chat: { id: -65100, type: 'group' }, from: { id: 6510, first_name: 'Хозяин коллекции' }, new_chat_members: [{ id: 123456, is_bot: true }] });
    assert.equal(calls.length, 0);

    database.setGroupAccessByTelegramId(6510, false);
    await telegramModule.handleMessage({ chat: { id: -65100, type: 'group' }, from: { id: 6511, first_name: 'Участник' }, text: '/find курица' });
    assert.deepEqual(calls.map((x) => x.method), ['sendMessage', 'leaveChat']);
    assert.equal(database.getActiveTelegramGroup(-65100), null);
  } finally { globalThis.fetch = originalFetch; }
});

test('group access page explains the offer and links back to the bot', () => {
  const page = fs.readFileSync(path.resolve('public/groups.html'), 'utf8');
  assert.match(page, /Решайте, что приготовить, вместе/);
  assert.match(page, /До трёх групп/);
  assert.match(page, /https:\/\/t\.me\/Recipeboibot\?start=group_access/);
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

test('recipe detail exposes sharing to the owner and a read-only public view', () => {
  const app = fs.readFileSync(path.resolve('public/app.js'), 'utf8');
  const css = fs.readFileSync(path.resolve('public/refinements.css'), 'utf8');
  assert.match(app, /id="share">Поделиться/);
  assert.match(app, /detail-edit" id="edit">Изменить/);
  assert.match(app, /\/api\/recipes\/\$\{encodeURIComponent\(recipe\.id\)\}\/share/);
  assert.match(app, /\/api\/shares\/\$\{encodeURIComponent\(token\)\}/);
  assert.match(app, /sharedBy/);
  assert.match(css, /\.shared-intro \{/);
  assert.match(css, /\.detail-actions\.shared-actions \{ grid-template-columns: 1fr; \}/);
});

test('recipe cards expose only a confirmable delete control before opening the detail view', () => {
  const app = fs.readFileSync(path.resolve('public/app.js'), 'utf8');
  const css = fs.readFileSync(path.resolve('public/styles.css'), 'utf8');
  assert.match(app, /class="card-open" data-recipe=/);
  assert.match(app, /data-remove-recipe=/);
  assert.doesNotMatch(app, /data-edit-recipe=/);
  assert.match(app, /function removeRecipeFromList/);
  assert.match(app, /confirm\('Убрать рецепт из библиотеки\?'\)/);
  assert.match(css, /\.card-remove \{ position: absolute; top: 8px; right: 8px/);
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

test('empty collection offers a first-recipe action that opens the import form', () => {
  const app = fs.readFileSync(path.resolve('public/app.js'), 'utf8');
  const collection = app.slice(app.indexOf('function collection('), app.indexOf('async function render()'));
  assert.match(collection, /class="empty collection-empty"/);
  assert.match(collection, /class="primary accent" id="add" type="button">Добавить первый рецепт/);
  assert.match(collection, /document\.querySelector\('#add'\)\.onclick = importSheet/);
  assert.match(app, /firstRecipe \? 'Добавить первый рецепт' : 'Сохранить вручную'/);
});
