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
process.env.DINNER_LLM_ENABLED = 'false';
process.env.APP_URL = 'https://recipes.example.test';

const database = await import('../src/db.js');
const importer = await import('../src/importer.js');
const telegramModule = await import('../src/telegram.js');
const openaiModule = await import('../src/openai.js');
const suggestions = await import('../src/suggestions.js');
const dinnerStore = await import('../src/dinner-store.js');

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
  dinnerStore.saveFoodProfile(owner.id, { ...dinnerStore.getFoodProfile(owner.id), preferredCategories: { home: 1, asian: -1 }, tastePreferencesStatus: 'completed' });
  let calls = 0, generationInput;
  const generate = async (input) => { calls += 1; generationInput = input; return normalizedRecipe('Новый ужин с фасолью'); };
  const proposal = await suggestions.suggestForEmptySearch(owner.id, 'ужин с фасолью', { generate });
  assert.deepEqual(generationInput.profile.preferredCategories, { home: 1, asian: -1 });
  assert.equal(database.listRecipes(owner.id).length, 0);
  assert.equal((await suggestions.suggestForEmptySearch(owner.id, 'ужин с фасолью', { generate })).id, proposal.id);
  assert.equal(calls, 1);
  assert.equal(database.saveRecipeSuggestion(other.id, proposal.id), null);
  const saved = database.saveRecipeSuggestion(owner.id, proposal.id);
  assert.equal(saved.origin, 'generated');
  assert.equal(saved.status, 'ready');
  assert.equal(saved.sourceName, 'Создано в «Рецептах»');
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

test('request uses saved and seed recipes before generating one unsaved recipe', async () => {
  const savedOwner = database.upsertTelegramUser({ id: 6172, first_name: 'Готовый рецепт' });
  const savedProposal = database.createRecipeSuggestion(savedOwner.id, 'бобовый рататуй', normalizedRecipe('Бобовый рататуй'));
  const saved = database.saveRecipeSuggestion(savedOwner.id, savedProposal.id);
  const fromCollection = await suggestions.resolveRecipeRequest(savedOwner.id, 'Хочу бобовый рататуй', { generate: assert.fail });
  assert.equal(fromCollection.kind, 'existing');
  assert.equal(fromCollection.recipe.id, saved.id);

  const owner = database.upsertTelegramUser({ id: 6170, first_name: 'Рецепт по запросу' });
  const other = database.upsertTelegramUser({ id: 6171, first_name: 'Другой' });
  dinnerStore.saveFoodProfile(owner.id, { householdType: 'couple', householdSize: 2, hasChildren: false,
    preferredMaxCookingTime: 30, excludedIngredients: ['орехи'], preferredCategories: {}, onboardingCompleted: true });
  const fromBase = await suggestions.resolveRecipeRequest(owner.id, 'рис с овощами', { generate: assert.fail });
  assert.equal(fromBase.kind, 'existing');
  assert.match(fromBase.recipe.id, /^seed:/);
  const fromOneWord = await suggestions.resolveRecipeRequest(owner.id, 'Суп', { generate: assert.fail });
  assert.equal(fromOneWord.kind, 'existing');
  assert.match(fromOneWord.recipe.title, /суп/iu);
  const light = await suggestions.resolveRecipeRequest(owner.id, 'лёгкий ужин', { generate: assert.fail });
  assert.equal(light.kind, 'existing');
  assert.ok(light.recipe.tags.some((tag) => /л[её]гк/iu.test(tag)));

  const familyOwner = database.upsertTelegramUser({ id: 6173, first_name: 'Семья' });
  dinnerStore.saveFoodProfile(familyOwner.id, { householdType: 'family', householdSize: 4, hasChildren: true,
    preferredMaxCookingTime: 120, excludedIngredients: [], preferredCategories: {}, onboardingCompleted: true });
  const borscht = await suggestions.resolveRecipeRequest(familyOwner.id, 'борщ', { generate: assert.fail });
  assert.equal(borscht.kind, 'existing');
  assert.equal(borscht.recipe.id, 'seed:borscht-beef');
  assert.ok(borscht.recipe.servings >= 4);

  const recipe = { ...normalizedRecipe('Арбузный суп'), servings: 2, prepMinutes: 10, cookMinutes: 15,
    ingredients: [{ name: 'арбуз', raw: 'арбуз', quantity: 300, unit: 'г', comment: null }] };
  let input;
  const result = await suggestions.resolveRecipeRequest(owner.id, 'хочу арбузный суп', { generate: async (value) => { input = value; return recipe; } });
  assert.equal(result.kind, 'generated');
  const suggestion = result.suggestion;
  assert.equal(input.query, 'хочу арбузный суп');
  assert.deepEqual(input.profile.excludedIngredients, ['орехи']);
  assert.equal(database.listRecipes(owner.id).length, 0);
  assert.match(suggestion.query, /^request:/);
  assert.equal(database.saveRecipeSuggestion(other.id, suggestion.id), null);
  const again = await suggestions.resolveRecipeRequest(owner.id, 'хочу арбузный суп', { generate: assert.fail });
  assert.equal(again.suggestion.id, suggestion.id);
  await assert.rejects(suggestions.resolveRecipeRequest(owner.id, 'арбузный салат', { generate: async () => ({ ...recipe, title: 'Ореховый салат', ingredients: [{ name: 'орехи' }] }) }), { status: 422 });
  await assert.rejects(suggestions.resolveRecipeRequest(owner.id, 'арбузный крем', { generate: async () => ({ ...recipe, title: 'Долгий крем', cookMinutes: 35 }) }), { status: 422 });
  const added = database.saveRecipeSuggestion(owner.id, suggestion.id);
  assert.equal(added.title, 'Арбузный суп');
  assert.equal(database.listRecipes(owner.id).length, 1);
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

test('group search offer rejects a non-owner before generation', async () => {
  const owner = database.upsertTelegramUser({ id: 6166, first_name: 'Владелец' });
  database.setGroupAccessByTelegramId(6166, true);
  database.activateTelegramGroup(owner.id, { id: -61660, type: 'group', title: 'Семья' });
  const offerId = database.createSearchOffer(owner.id, 'ужин');
  const originalFetch = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, options) => { calls.push({ url: String(url), body: JSON.parse(options.body) }); return { json: async () => ({ ok: true, result: {} }) }; };
  try {
    await telegramModule.handleSuggestionCallback({ id: 'offer-group', data: `offer:create:${offerId}`, message: { message_id: 1, chat: { id: -61660, type: 'group' } }, from: { id: 6167, first_name: 'Участник' } });
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /answerCallbackQuery/);
    assert.equal(calls[0].body.show_alert, true);
    assert.equal(database.listRecipes(owner.id).length, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test('private Telegram request generates only after no ready recipe and waits for save', async () => {
  const telegramUser = { id: 6165, first_name: 'Поиск' };
  const owner = database.upsertTelegramUser(telegramUser); database.allowUser(owner.id);
  dinnerStore.saveFoodProfile(owner.id, { ...dinnerStore.getFoodProfile(owner.id), preferredCategories: { soup: 1, fish: -1 }, tastePreferencesStatus: 'completed' });
  const originalFetch = globalThis.fetch; const sent = []; let aiCalls = 0;
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('api.openai.com')) {
      aiCalls += 1;
      const body = JSON.parse(options.body);
      assert.equal(body.text.format.name, 'requested_recipe_generation');
      assert.match(body.instructions, /preferredCategories/);
      assert.deepEqual(JSON.parse(body.input[0].content[0].text).profile.preferredCategories, { soup: 1, fish: -1 });
      return new Response(JSON.stringify({ status: 'completed', model: 'test-model', output_text: JSON.stringify({ ...normalizedRecipe('Суп с тыквой'), servings: 2, prepMinutes: 10, cookMinutes: 20 }), usage: { input_tokens: 10, output_tokens: 20 } }), { status: 200 });
    }
    sent.push(JSON.parse(options.body));
    return { json: async () => ({ ok: true, result: { message_id: 12 } }) };
  };
  try {
    await telegramModule.handleMessage({ chat: { id: 6165, type: 'private' }, from: telegramUser, text: 'Найди суп с тыквой' });
    assert.equal(aiCalls, 1);
    assert.equal(database.listRecipes(owner.id).length, 0);
    assert.match(sent[0].text, /Составляю новый/);
    const callback = { id: 'callback-private', message: { message_id: 12, chat: { id: 6165, type: 'private' } }, from: telegramUser };
    const suggestionMessage = sent.find((message) => message.text?.includes('Суп с тыквой'));
    assert.match(suggestionMessage.text, /Создано в «Рецептах»/);
    const callbackData = suggestionMessage.reply_markup.inline_keyboard[0][0].callback_data;
    assert.match(callbackData, /^suggest:save:/);
    await telegramModule.handleSuggestionCallback({ ...callback, data: callbackData });
    assert.equal(database.listRecipes(owner.id).length, 1);
    assert.equal(database.listRecipes(owner.id)[0].sourceName, 'Создано в «Рецептах»');
  } finally { globalThis.fetch = originalFetch; }
});

test('intent detection searches short text and saves detailed recipe text', () => {
  assert.equal(telegramModule.detectIntent('Есть курица, что приготовить на ужин?'), 'search');
  assert.equal(telegramModule.detectIntent('Найди те крылышки с мёдом'), 'search');
  assert.equal(telegramModule.detectIntent('Сохрани мой рецепт: курица, мёд, масло'), 'save');
  assert.equal(telegramModule.detectIntent('Добавь рецепт борща'), 'save');
  assert.equal(telegramModule.detectIntent('/save курица, мёд, масло'), 'save');
  assert.equal(telegramModule.detectIntent('Курица и мёд'), 'search');
  assert.equal(telegramModule.detectIntent('Хочу что-то интересное к ужину, но пока не знаю, что именно выбрать из своей коллекции.'), 'ambiguous');
  assert.equal(telegramModule.detectIntent('Ингредиенты: курица 500 г, соль, мёд и сливочное масло. Нарежьте курицу, смешайте с мёдом и солью, запекайте 40 мин до готовности.'), 'save');
  assert.equal(telegramModule.detectIntent('Найди рецепт и сохрани его'), 'ambiguous');
  assert.equal(telegramModule.detectIntent('', { hasPhoto: true }), 'save');
  assert.equal(telegramModule.detectIntent('https://example.com/recipe', { hasUrl: true }), 'save');
});

test('plain private message chooses a ready recipe without an AI call', async () => {
  const telegramUser = { id: 6168, first_name: 'Обычный запрос' };
  const owner = database.upsertTelegramUser(telegramUser); database.allowUser(owner.id);
  const originalFetch = globalThis.fetch; const sent = [];
  globalThis.fetch = async (url, options) => { assert.doesNotMatch(String(url), /api\.openai\.com/); sent.push(JSON.parse(options.body)); return { json: async () => ({ ok: true, result: {} }) }; };
  try {
    await telegramModule.handleMessage({ chat: { id: 6168, type: 'private' }, from: telegramUser, text: 'Рис с овощами' });
    assert.equal(sent.length, 2);
    assert.match(sent[0].text, /Подобрал готовый рецепт/);
    assert.match(sent[1].caption, /Рис с овощами/);
    assert.equal(database.getPendingIntent(owner.id), null);
    assert.equal(database.listRecipes(owner.id).length, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test('a new search replaces an unanswered intent question', async () => {
  const telegramUser = { id: 6171, first_name: 'Новый запрос' };
  const owner = database.upsertTelegramUser(telegramUser); database.allowUser(owner.id);
  const originalFetch = globalThis.fetch; const sent = [];
  globalThis.fetch = async (_url, options) => { sent.push(JSON.parse(options.body)); return { json: async () => ({ ok: true, result: {} }) }; };
  try {
    const message = { chat: { id: 6171, type: 'private' }, from: telegramUser };
    await telegramModule.handleMessage({ ...message, text: 'Найди рецепт и сохрани его' });
    assert.match(sent.at(-1).text, /Найти в вашей коллекции или сохранить/);
    assert.ok(database.getPendingIntent(owner.id));
    await telegramModule.handleMessage({ ...message, text: 'Найди рис с овощами' });
    assert.match(sent.at(-1).caption, /Рис с овощами/);
    assert.equal(database.getPendingIntent(owner.id), null);
  } finally { globalThis.fetch = originalFetch; }
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
      assert.match(error.message, /не удалось получить рецепт в нужном формате/i);
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
    assert.match(sent[0].text, /Использование сервиса/);
    assert.match(sent[0].text, /120/);
    assert.match(sent[0].text, /80/);
    assert.match(sent[0].text, /reasoning: 30/);
    assert.match(sent[0].text, /Всего: <b>200<\/b>/);
    assert.doesNotMatch(sent[0].text, /Запросы сегодня: <b>[^<]*\//);
    assert.doesNotMatch(sent[0].text, /Запросы всего: <b>[^<]*\//);
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

test('save deep link imports short text without dinner onboarding or recipe generation', async () => {
  const originalFetch = globalThis.fetch, sent = []; let extractionCalls = 0;
  const from = { id: 6580, first_name: 'Сохранение' }, chat = { id: from.id, type: 'private' };
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('api.openai.com')) {
      extractionCalls += 1;
      assert.equal(JSON.parse(options.body).text.format.name, 'recipe_extraction');
      return Response.json({ status: 'completed', model: 'test-model', output_text: JSON.stringify(normalizedRecipe('Рецепт по ссылке с лендинга')), usage: { input_tokens: 10, output_tokens: 20 } });
    }
    sent.push(JSON.parse(options.body));
    return { json: async () => ({ ok: true, result: {} }) };
  };
  try {
    await telegramModule.handleMessage({ chat, from, text: '/start save' });
    const user = database.getUserByTelegramId(from.id);
    assert.equal(user.is_allowed, 1);
    assert.equal(database.getPendingIntent(user.id).kind, 'recipe-save');
    assert.match(sent.at(-1).text, /Сохранить рецепт/);
    await telegramModule.handleMessage({ chat, from, text: 'Крылышки с мёдом' });
    assert.equal(extractionCalls, 1);
    assert.equal(database.listRecipes(user.id).length, 1);
    assert.equal(database.getPendingIntent(user.id), null);
    assert.equal(dinnerStore.getFoodProfile(user.id).onboardingCompleted, false);
    assert.match(sent.at(-1).text, /Сохранено/);
  } finally { globalThis.fetch = originalFetch; }
});

test('save entry retains dinner draft across repeated entry, unsupported input and cancellation', async () => {
  const originalFetch = globalThis.fetch, sent = [];
  const from = { id: 6581, first_name: 'Черновик' }, chat = { id: from.id, type: 'private' };
  const user = database.upsertTelegramUser(from); database.allowUser(user.id);
  const draft = { kind: 'dinner-intake', profileOnly: true, intake: { householdSize: 3, excludedIngredients: ['орехи'] } };
  database.setPendingIntent(user.id, draft);
  globalThis.fetch = async (_url, options) => { sent.push(JSON.parse(options.body)); return { json: async () => ({ ok: true, result: {} }) }; };
  try {
    await telegramModule.handleMessage({ chat, from, text: '/start save' });
    await telegramModule.handleMessage({ chat, from, text: '/start@Recipeboibot save' });
    assert.deepEqual(database.getPendingIntent(user.id).resumeIntent, draft);
    await telegramModule.handleMessage({ chat, from, sticker: { file_id: 'unsupported' } });
    assert.equal(database.getPendingIntent(user.id).kind, 'recipe-save');
    await telegramModule.handleMessage({ chat, from, text: '/cancel' });
    assert.deepEqual(database.getPendingIntent(user.id), draft);
    assert.match(sent.at(-1).text, /отменено/);
    await telegramModule.handleMessage({ chat, from, text: '/start save' });
    await telegramModule.handleMessage({ chat, from, text: '/start' });
    assert.equal(database.getPendingIntent(user.id).kind, 'dinner-intake');
    assert.equal(database.getPendingIntent(user.id).intake.householdSize, 3);
  } finally { globalThis.fetch = originalFetch; }
});

test('save entry survives extraction failure and restores the previous draft after retry', async () => {
  const originalFetch = globalThis.fetch;
  const from = { id: 6582, first_name: 'Повтор' }, chat = { id: from.id, type: 'private' };
  const user = database.upsertTelegramUser(from); database.allowUser(user.id);
  const draft = { kind: 'dinner-intake', profileOnly: true, intake: { householdSize: 2 } };
  database.setPendingIntent(user.id, draft);
  let fail = true;
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('api.openai.com')) {
      assert.equal(JSON.parse(options.body).text.format.name, 'recipe_extraction');
      if (fail) return Response.json({ error: { code: 'server_is_overloaded', message: 'Test failure' } }, { status: 503 });
      return Response.json({ status: 'completed', model: 'test-model', output_text: JSON.stringify(normalizedRecipe('Рецепт после повторной попытки')), usage: { input_tokens: 10, output_tokens: 20 } });
    }
    return { json: async () => ({ ok: true, result: {} }) };
  };
  try {
    await telegramModule.handleMessage({ chat, from, text: '/start save' });
    await telegramModule.handleMessage({ chat, from, text: 'Крылышки с мёдом для двоих' });
    assert.equal(database.getPendingIntent(user.id).kind, 'recipe-save');
    assert.equal(database.listRecipes(user.id).length, 0);
    fail = false;
    await telegramModule.handleMessage({ chat, from, text: 'Крылышки с мёдом для двоих' });
    assert.equal(database.listRecipes(user.id).length, 1);
    assert.deepEqual(database.getPendingIntent(user.id), draft);
  } finally { globalThis.fetch = originalFetch; }
});

test('landing save promises use the dedicated entry and the quiz is removed', () => {
  const html = fs.readFileSync('public/index.html', 'utf8');
  const script = fs.readFileSync('public/landing.js', 'utf8');
  const links = [...html.matchAll(/href="(https:\/\/t\.me\/Recipeboibot[^\"]*)"/g)];
  assert.ok(links.length >= 3);
  assert.ok(links.every((match) => new URL(match[1]).searchParams.get('start') === 'save'));
  assert.match(html, /Твои рецепты — главная/);
  assert.doesNotMatch(html + script, /lp-quiz/);
});

test('first Start restores chat introduction without requiring ingredients; skip is remembered', async () => {
  const originalFetch = globalThis.fetch; const sent = [];
  globalThis.fetch = async (_url, options) => { sent.push(JSON.parse(options.body)); return { json: async () => ({ ok: true, result: {} }) }; };
  try {
    const message = { chat: { id: 6401, type: 'private' }, from: { id: 6401, first_name: 'Новый' }, text: '/start' };
    await telegramModule.handleMessage(message); await telegramModule.handleMessage(message);
    assert.equal(database.getUserByTelegramId(6401).is_allowed, 1);
    assert.equal(sent.length, 2);
    assert.match(sent[0].text, /<b>Запишите голосовое сообщение<\/b>/);
    assert.match(sent[0].text, /микрофон справа от поля ввода/);
    assert.match(sent[0].text, /какие блюда вы обычно любите и что хотите именно сегодня/);
    assert.equal(sent[0].reply_markup, undefined);
    assert.equal(database.getPendingIntent(database.getUserByTelegramId(6401).id).profileOnly, true);
    assert.match(sent[1].text, /Давай подберём ужин специально для тебя/);
    const messagesBeforeSkip = sent.filter((body) => body.chat_id).length;
    await telegramModule.handleDinnerIntakeCallback({ id: 'skip-first', data: 'dinner:skip', message, from: message.from });
    await telegramModule.handleMessage(message);
    assert.equal(sent.filter((body) => body.chat_id).length, messagesBeforeSkip);
    assert.ok(sent.every((body) => !/Что приготовить сегодня|Выбрать ужин/.test(body.text || '')));
    await telegramModule.handleMessage({ ...message, text: '/ingredients' });
    assert.match(sent.at(-1).text, /назовите продукты/);
    assert.match(sent.at(-1).text, /<b>Запишите голосовое сообщение<\/b>/);
    assert.equal(sent.at(-1).reply_markup, undefined);
    assert.equal(database.getPendingIntent(database.getUserByTelegramId(6401).id).profileOnly, false);
    assert.ok(sent.every((body) => !/код приглашения/i.test(body.text || '')));
  } finally { globalThis.fetch = originalFetch; }
});

test('profile introduction accepts partial text, missing size, correction and confirmation without pantry', async () => {
  const originalFetch = globalThis.fetch, sent = [];
  globalThis.fetch = async (_url, options) => { sent.push(JSON.parse(options.body)); return { json: async () => ({ ok: true, result: {} }) }; };
  const from = { id: 6491, first_name: 'Знакомство' }, chat = { id: from.id, type: 'private' };
  const { getFoodProfile, getDinnerContext } = await import('../src/dinner-store.js');
  try {
    await telegramModule.handleMessage({ chat, from, text: '/start' });
    const user = database.getUserByTelegramId(from.id);
    assert.equal(getFoodProfile(user.id).onboardingCompleted, false);
    await telegramModule.handleMessage({ chat, from, text: 'С ребёнком, без орехов, до 30 минут. Люблю пасту и курицу. Не люблю рыбу.' });
    assert.match(sent.at(-1).text, /На сколько человек/);
    assert.doesNotMatch(sent.at(-1).text, /продукты/);
    await telegramModule.handleDinnerIntakeCallback({ id: 'profile-size', data: 'dinner:size:3', message: { chat }, from });
    assert.match(sent.at(-1).text, /Готовим на: 3/);
    assert.match(sent.at(-1).text, /Дети: да/);
    assert.match(sent.at(-1).text, /Любим: паста, курица/);
    assert.match(sent.at(-1).text, /Не любим: рыба/);
    assert.doesNotMatch(sent.at(-1).text, /Есть дома/);
    await telegramModule.handleDinnerIntakeCallback({ id: 'profile-redo', data: 'dinner:redo', message: { chat }, from });
    await telegramModule.handleMessage({ chat, from, text: 'До 60 минут.' });
    await telegramModule.handleMessage({ chat, from, text: '/start' });
    const pending = database.getPendingIntent(user.id);
    assert.equal(pending.profileOnly, true);
    assert.equal(pending.intake.householdSize, 3);
    assert.equal(pending.intake.maxMinutes, 60);
    assert.deepEqual(pending.intake.excludedIngredients, ['орехов']);
    assert.deepEqual(pending.intake.availableIngredients, []);
    assert.deepEqual(pending.intake.preferredCategories, { pasta: 1, chicken: 1, fish: -1 });
    assert.match(sent.at(-1).text, /Проверьте/);
    assert.equal(getFoodProfile(user.id).onboardingCompleted, false);
    const messagesBeforeConfirm = sent.filter((body) => body.chat_id && !body.message_id).length;
    await telegramModule.handleDinnerIntakeCallback({ id: 'profile-confirm', data: 'dinner:confirm', message: { chat, message_id: 401 }, from });
    assert.equal(getFoodProfile(user.id).onboardingCompleted, true);
    assert.equal(getFoodProfile(user.id).preferredMaxCookingTime, 60);
    assert.deepEqual(getFoodProfile(user.id).excludedIngredients, ['орехов']);
    assert.deepEqual(getFoodProfile(user.id).preferredCategories, { pasta: 1, chicken: 1, fish: -1 });
    assert.equal(getFoodProfile(user.id).tastePreferencesStatus, 'completed');
    assert.deepEqual(getDinnerContext(user.id), []);
    assert.equal(database.getPendingIntent(user.id), null);
    assert.equal(sent.filter((body) => body.chat_id && !body.message_id).length, messagesBeforeConfirm);
    assert.equal(sent.at(-2).text, 'Ответы сохранены');
    assert.equal(sent.at(-1).message_id, 401);
    assert.equal(sent.at(-1).reply_markup.inline_keyboard[0][0].text, 'Открыть варианты ужина');
    const dinnerUrl = new URL(sent.at(-1).reply_markup.inline_keyboard[0][0].web_app.url);
    assert.equal(dinnerUrl.searchParams.get('view'), 'dinner');
    assert.ok(dinnerUrl.searchParams.has('launch'));
    await telegramModule.handleMessage({ chat, from, text: '/start' });
    assert.equal(sent.filter((body) => body.chat_id && !body.message_id).length, messagesBeforeConfirm);
    await telegramModule.handleDinnerIntakeCallback({ id: 'stale-skip', data: 'dinner:skip', message: { chat }, from });
    assert.equal(sent.at(-1).show_alert, true);
    assert.deepEqual(getFoodProfile(user.id).excludedIngredients, ['орехов']);
    await telegramModule.handleMessage({ chat, from, text: 'Забыл сказать, без детей.' });
    assert.equal(database.getPendingIntent(user.id).profileOnly, true);
    assert.equal(database.getPendingIntent(user.id).intake.hasChildren, false);
    assert.deepEqual(database.getPendingIntent(user.id).intake.excludedIngredients, ['орехов']);
  } finally { globalThis.fetch = originalFetch; }
});

test('profile correction accepts a bare cuisine name as a preference', async () => {
  const originalFetch = globalThis.fetch, sent = [];
  globalThis.fetch = async (_url, options) => { sent.push(JSON.parse(options.body)); return { json: async () => ({ ok: true, result: {} }) }; };
  const from = { id: 6495, first_name: 'Кухня' }, chat = { id: from.id, type: 'private' };
  try {
    await telegramModule.handleMessage({ chat, from, text: '/start' });
    await telegramModule.handleMessage({ chat, from, text: 'На одного.' });
    assert.match(sent.at(-1).text, /Любим: не указано/);
    await telegramModule.handleDinnerIntakeCallback({ id: 'bare-cuisine-redo', data: 'dinner:redo', message: { chat }, from });
    await telegramModule.handleMessage({ chat, from, text: 'Итальянская кухня' });
    const user = database.getUserByTelegramId(from.id);
    const pending = database.getPendingIntent(user.id);
    assert.deepEqual(pending.intake.preferredCategories, { italian: 1 });
    assert.deepEqual(pending.intake.availableIngredients, []);
    assert.match(sent.at(-1).text, /Любим: италия/);
  } finally { globalThis.fetch = originalFetch; }
});

test('first profile voice message goes to confirmation without asking for products', async () => {
  const originalFetch = globalThis.fetch, sent = [];
  globalThis.fetch = async (url, options) => {
    const address = String(url);
    if (address.includes('/file/bot')) return new Response(Buffer.from('voice'));
    if (address.includes('/v1/audio/transcriptions')) return Response.json({ text: 'На двоих, без детей, аллергия на орехи, до 30 минут. Люблю пасту и рис. Сегодня хочу азиатское с рисом.' });
    if (address.endsWith('/getFile')) return { json: async () => ({ ok: true, result: { file_path: 'voice.ogg', file_size: 5 } }) };
    sent.push(JSON.parse(options.body));
    return { json: async () => ({ ok: true, result: {} }) };
  };
  const from = { id: 6492, first_name: 'Голосовое знакомство' }, chat = { id: from.id, type: 'private' };
  try {
    await telegramModule.handleMessage({ chat, from, text: '/start' });
    await telegramModule.handleMessage({ chat, from, voice: { file_id: 'profile-voice', duration: 15 } });
    const pending = database.getPendingIntent(database.getUserByTelegramId(from.id).id);
    assert.equal(pending.profileOnly, true);
    assert.deepEqual(pending.intake.availableIngredients, []);
    assert.equal(pending.intake.householdSize, 2);
    assert.equal(pending.intake.hasChildren, false);
    assert.deepEqual(pending.intake.excludedIngredients, ['орехи']);
    assert.deepEqual(pending.intake.preferredCategories, { pasta: 1, rice: 1 });
    assert.deepEqual(new Set(pending.intake.requestedCategories), new Set(['asian', 'rice']));
    assert.match(sent.at(-1).text, /Проверьте/);
    assert.match(sent.at(-1).text, /Сегодня обязательно: рис, азия/);
    assert.doesNotMatch(sent.at(-1).text, /назовите продукты/);
    await telegramModule.handleDinnerIntakeCallback({ id: 'confirm-profile-voice', data: 'dinner:confirm', message: { chat, message_id: 492 }, from });
    const user = database.getUserByTelegramId(from.id);
    const { getDinnerContext, getDinnerRequestCategories, getFoodProfile } = await import('../src/dinner-store.js');
    assert.deepEqual(getDinnerContext(user.id), []);
    assert.deepEqual(new Set(getDinnerRequestCategories(user.id)), new Set(['asian', 'rice']));
    assert.deepEqual(getFoodProfile(user.id).preferredCategories, { pasta: 1, rice: 1 });
  } finally { globalThis.fetch = originalFetch; }
});

test('first voice intake confirms pantry and restrictions before opening dinner', async () => {
  const originalFetch = globalThis.fetch; const sent = [];
  globalThis.fetch = async (url, options) => {
    const address = String(url);
    if (address.includes('/file/bot')) return new Response(Buffer.from('voice'), { status: 200 });
    if (address.includes('/v1/audio/transcriptions')) return new Response(JSON.stringify({ text: 'Есть курица, рис, лук и морковь. На троих, с ребёнком, без грибов, до 30 минут. Люблю домашнюю еду и супы. Не люблю салаты.' }), { status: 200, headers: { 'content-type': 'application/json' } });
    const body = JSON.parse(options.body);
    if (address.endsWith('/getFile')) return { json: async () => ({ ok: true, result: { file_path: 'voice.ogg', file_size: 5 } }) };
    sent.push(body);
    return { json: async () => ({ ok: true, result: {} }) };
  };
  try {
    const from = { id: 6403, first_name: 'Голос' }, chat = { id: 6403, type: 'private' };
    await telegramModule.handleMessage({ chat, from, text: '/start' });
    await telegramModule.handleMessage({ chat, from, text: '/ingredients' });
    await telegramModule.handleMessage({ chat, from, voice: { file_id: 'voice-1', duration: 45, mime_type: 'audio/ogg' } });
    const user = database.getUserByTelegramId(6403);
    const pending = database.getPendingIntent(user.id);
    assert.equal(pending.kind, 'dinner-confirm');
    assert.deepEqual(pending.intake.availableIngredients, ['курица', 'рис', 'лук', 'морковь']);
    assert.deepEqual(pending.intake.excludedIngredients, ['грибов']);
    assert.equal(pending.intake.householdSize, 3);
    assert.equal(pending.intake.hasChildren, true);
    assert.equal(pending.intake.maxMinutes, 30);
    assert.deepEqual(pending.intake.preferredCategories, { soup: 1, salad: -1, home: 1 });
    assert.match(sent.at(-1).text, /Проверьте/);
    assert.match(sent.at(-1).text, /Любим: супы, домашняя еда/);
    assert.match(sent.at(-1).text, /Не любим: салаты/);
    assert.equal(sent.at(-1).reply_markup.inline_keyboard[0][0].callback_data, 'dinner:confirm');
    const messagesBeforeConfirm = sent.filter((body) => body.chat_id && !body.message_id).length;
    await telegramModule.handleDinnerIntakeCallback({ id: 'confirm-6403', data: 'dinner:confirm', message: { chat, message_id: 403 }, from });
    assert.equal(database.getPendingIntent(user.id), null);
    assert.equal(sent.filter((body) => body.chat_id && !body.message_id).length, messagesBeforeConfirm);
    assert.equal(sent.at(-2).text, 'Ответы сохранены');
    assert.equal(sent.at(-1).message_id, 403);
    assert.equal(new URL(sent.at(-1).reply_markup.inline_keyboard[0][0].web_app.url).searchParams.get('view'), 'dinner');
    const { getFoodProfile, getDinnerContext } = await import('../src/dinner-store.js');
    assert.deepEqual(getDinnerContext(user.id), ['курица', 'рис', 'лук', 'морковь']);
    assert.equal(getFoodProfile(user.id).householdSize, 3);
    assert.equal(getFoodProfile(user.id).hasChildren, true);
    assert.deepEqual(getFoodProfile(user.id).excludedIngredients, ['грибов']);
    assert.deepEqual(getFoodProfile(user.id).preferredCategories, { soup: 1, salad: -1, home: 1 });
    assert.equal(getFoodProfile(user.id).tastePreferencesStatus, 'completed');
    await telegramModule.handleMessage({ chat, from, text: '/ingredients' });
    await telegramModule.handleDinnerIntakeCallback({ id: 'skip-6403', data: 'dinner:skip', message: { chat }, from });
    assert.deepEqual(getDinnerContext(user.id), []);
  } finally { globalThis.fetch = originalFetch; }
});

test('text intake asks for missing household size before confirmation', async () => {
  const originalFetch = globalThis.fetch; const sent = [];
  globalThis.fetch = async (_url, options) => { sent.push(JSON.parse(options.body)); return { json: async () => ({ ok: true, result: {} }) }; };
  try {
    const from = { id: 6404, first_name: 'Текст' }, chat = { id: 6404, type: 'private' };
    await telegramModule.handleMessage({ chat, from, text: '/start' });
    await telegramModule.handleMessage({ chat, from, text: '/ingredients' });
    await telegramModule.handleMessage({ chat, from, text: 'Есть яйца, сыр, без грибов' });
    assert.match(sent.at(-1).text, /На сколько человек/);
    assert.equal(sent.at(-1).reply_markup.inline_keyboard[0][2].callback_data, 'dinner:size:3');
    await telegramModule.handleDinnerIntakeCallback({ id: 'size-6404', data: 'dinner:size:3', message: { chat }, from });
    assert.match(sent.at(-1).text, /Готовим на: 3/);
    await telegramModule.handleDinnerIntakeCallback({ id: 'confirm-6404', data: 'dinner:confirm', message: { chat }, from });
    const { getFoodProfile, getDinnerContext } = await import('../src/dinner-store.js');
    const user = database.getUserByTelegramId(6404);
    assert.deepEqual(getDinnerContext(user.id), ['яйца', 'сыр']);
    assert.equal(getFoodProfile(user.id).householdSize, 3);
    assert.deepEqual(getFoodProfile(user.id).excludedIngredients, ['грибов']);
  } finally { globalThis.fetch = originalFetch; }
});

test('multi-message onboarding and the correction button retain earlier answers', async () => {
  const originalFetch = globalThis.fetch; const sent = [];
  globalThis.fetch = async (_url, options) => { sent.push(JSON.parse(options.body)); return { json: async () => ({ ok: true, result: {} }) }; };
  const from = { id: 6409, first_name: 'Дополнение' }, chat = { id: 6409, type: 'private' };
  try {
    await telegramModule.handleMessage({ chat, from, text: '/start dinner' });
    await telegramModule.handleMessage({ chat, from, text: '/ingredients' });
    await telegramModule.handleMessage({ chat, from, text: 'Есть курица, рис. На троих, до 30 минут.' });
    const user = database.getUserByTelegramId(from.id);
    await telegramModule.handleDinnerIntakeCallback({ id: 'redo-6409', data: 'dinner:redo', message: { chat }, from });
    assert.deepEqual(database.getPendingIntent(user.id).intake.availableIngredients, ['курица', 'рис']);
    await telegramModule.handleMessage({ chat, from, text: 'Забыл сказать, есть ребёнок. Аллергия на орехи. Люблю азиатскую еду, не люблю рыбу.' });
    const intake = database.getPendingIntent(user.id).intake;
    assert.deepEqual(intake.availableIngredients, ['курица', 'рис']);
    assert.equal(intake.householdSize, 3);
    assert.equal(intake.hasChildren, true);
    assert.equal(intake.maxMinutes, 30);
    assert.deepEqual(intake.excludedIngredients, ['орехи']);
    assert.deepEqual(intake.preferredCategories, { asian: 1, fish: -1 });
    assert.match(sent.at(-1).text, /Аллергия и исключения/);
    await telegramModule.handleDinnerIntakeCallback({ id: 'confirm-6409', data: 'dinner:confirm', message: { chat }, from });
    const { getFoodProfile, getDinnerContext } = await import('../src/dinner-store.js');
    assert.deepEqual(getDinnerContext(user.id), ['курица', 'рис']);
    assert.equal(getFoodProfile(user.id).hasChildren, true);
    await telegramModule.handleMessage({ chat, from, text: 'Забыл сказать, без детей.' });
    assert.equal(database.getPendingIntent(user.id).intake.hasChildren, false);
    assert.deepEqual(database.getPendingIntent(user.id).intake.availableIngredients, ['курица', 'рис']);
    await telegramModule.handleMessage({ chat, from, text: '/ingredients' });
    await telegramModule.handleMessage({ chat, from, text: 'Ещё есть сыр.' });
    assert.deepEqual(database.getPendingIntent(user.id).intake.availableIngredients, ['курица', 'рис', 'сыр']);
    assert.equal(database.getPendingIntent(user.id).intake.householdSize, 3);
  } finally { globalThis.fetch = originalFetch; }
});

test('onboarding restart marker keeps account access and opens intake on the next Start', async () => {
  const originalFetch = globalThis.fetch; const sent = [];
  globalThis.fetch = async (_url, options) => { sent.push(JSON.parse(options.body)); return { json: async () => ({ ok: true, result: {} }) }; };
  try {
    const from = { id: 6406, first_name: 'Повторный вход' }, chat = { id: 6406, type: 'private' };
    const user = database.upsertTelegramUser(from); database.allowUser(user.id);
    for (const text of ['/start', '/start dinner']) {
      database.setPendingIntent(user.id, { kind: 'dinner-onboarding-restart' });
      await telegramModule.handleMessage({ chat, from, text });
      assert.equal(database.getUserByTelegramId(from.id).is_allowed, 1);
      assert.equal(database.getPendingIntent(user.id).kind, 'dinner-intake');
      assert.match(sent.at(-1).text, /<b>Запишите голосовое сообщение<\/b>/);
      assert.equal(sent.at(-1).reply_markup, undefined);
    }
  } finally { globalThis.fetch = originalFetch; }
});

test('unblocking restores introduction and the accompanying Start does not duplicate it', async () => {
  const originalFetch = globalThis.fetch; const sent = [];
  globalThis.fetch = async (_url, options) => { sent.push(JSON.parse(options.body)); return { json: async () => ({ ok: true, result: {} }) }; };
  const from = { id: 6407, first_name: 'Разблокировка' }, chat = { id: 6407, type: 'private' };
  try {
    await telegramModule.handleMyChatMember({ chat, from, old_chat_member: { status: 'member' }, new_chat_member: { status: 'kicked' } });
    assert.equal(sent.length, 0);
    await telegramModule.handleMyChatMember({ chat, from, old_chat_member: { status: 'kicked' }, new_chat_member: { status: 'member' } });
    const user = database.getUserByTelegramId(from.id);
    assert.equal(user.is_allowed, 1);
    assert.equal(database.getPendingIntent(user.id).profileOnly, true);
    assert.match(sent[0].text, /Давай подберём ужин специально для тебя/);
    await telegramModule.handleMessage({ chat, from, text: '/start dinner' });
    assert.equal(sent.length, 1);
    const otherFrom = { id: 6410, first_name: 'Первый вход' }, otherChat = { id: 6410, type: 'private' };
    await telegramModule.handleMessage({ chat: otherChat, from: otherFrom, text: '/start' });
    assert.equal(sent.length, 2);
    await telegramModule.handleMyChatMember({ chat: otherChat, from: otherFrom, old_chat_member: { status: 'kicked' }, new_chat_member: { status: 'member' } });
    assert.equal(sent.length, 2, 'Start followed by unblock must also send only one entry');
  } finally { globalThis.fetch = originalFetch; }
});

test('reopening intake preserves a draft; completed profiles prepare dinner without an extra message', async () => {
  const originalFetch = globalThis.fetch; const sent = [];
  globalThis.fetch = async (_url, options) => { sent.push(JSON.parse(options.body)); return { json: async () => ({ ok: true, result: {} }) }; };
  const from = { id: 6408, first_name: 'Продолжение' }, chat = { id: 6408, type: 'private' };
  const user = database.upsertTelegramUser(from); database.allowUser(user.id);
  const intake = { availableIngredients: ['курица', 'рис'], excludedIngredients: ['грибы'], householdSize: 3, hasChildren: true, maxMinutes: 30 };
  try {
    database.setPendingIntent(user.id, { kind: 'dinner-confirm', intake });
    await telegramModule.handleMessage({ chat, from, text: '/start dinner' });
    assert.match(sent.at(-1).text, /Проверьте/);
    assert.deepEqual(database.getPendingIntent(user.id).intake, intake);
    await telegramModule.handleMyChatMember({ chat, from, old_chat_member: { status: 'kicked' }, new_chat_member: { status: 'member' } });
    assert.match(sent.at(-1).text, /Проверьте/);
    assert.deepEqual(database.getPendingIntent(user.id).intake, intake);
    const messagesBeforeConfirm = sent.filter((body) => body.chat_id && !body.message_id).length;
    await telegramModule.handleDinnerIntakeCallback({ id: 'confirm-resume', data: 'dinner:confirm', message: { chat, message_id: 408 }, from });
    await telegramModule.handleMyChatMember({ chat, from, old_chat_member: { status: 'kicked' }, new_chat_member: { status: 'member' } });
    assert.equal(sent.filter((body) => body.chat_id && !body.message_id).length, messagesBeforeConfirm);
    assert.equal(sent.at(-1).message_id, 408);
    assert.equal(sent.at(-1).reply_markup.inline_keyboard[0][0].text, 'Открыть варианты ужина');
    assert.equal(database.getPendingIntent(user.id), null);
  } finally { globalThis.fetch = originalFetch; }
});

test('polling completes a dinner callback without routing it as an absent message', async () => {
  const originalFetch = globalThis.fetch;
  const from = { id: 6405, first_name: 'Polling' }, chat = { id: 6405, type: 'private' };
  const user = database.upsertTelegramUser(from); database.allowUser(user.id);
  database.setPendingIntent(user.id, { kind: 'dinner-intake' });
  let polls = 0;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/getUpdates')) {
      polls += 1;
      if (polls > 1) telegramModule.stopTelegramPolling();
      return { json: async () => ({ ok: true, result: polls === 1 ? [{ update_id: 76405, callback_query: { id: 'polling-dinner', data: 'dinner:skip', message: { chat }, from } }] : [] }) };
    }
    return { json: async () => ({ ok: true, result: {} }) };
  };
  try {
    await telegramModule.startTelegramPolling();
    assert.equal(database.db.prepare('SELECT status FROM processed_updates WHERE update_id=?').get('76405').status, 'done');
    assert.equal(database.getPendingIntent(user.id), null);
  } finally { telegramModule.stopTelegramPolling(); globalThis.fetch = originalFetch; }
});

test('dinner deep link introduces a new client and prepares dinner after explicit skip without an extra message', async () => {
  const originalFetch = globalThis.fetch; const sent = [];
  globalThis.fetch = async (_url, options) => { sent.push(JSON.parse(options.body)); return { json: async () => ({ ok: true, result: {} }) }; };
  try {
    const message = { chat: { id: 6402, type: 'private' }, from: { id: 6402, first_name: 'Ужин' }, text: '/start dinner' };
    await telegramModule.handleMessage(message);
    assert.equal(database.getUserByTelegramId(6402).is_allowed, 1);
    assert.match(sent[0].text, /Давай подберём ужин специально для тебя/);
    assert.equal(database.getPendingIntent(database.getUserByTelegramId(6402).id).profileOnly, true);
    await telegramModule.handleMessage({ ...message, text: '/skip' });
    await telegramModule.handleMessage(message);
    assert.equal(sent.filter((body) => body.chat_id).length, 1);
    assert.ok(sent.every((body) => !/Что приготовить сегодня|Выбрать ужин/.test(body.text || '')));
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
  assert.match(app, /detail-media-source">\$\{sourceChip\}/);
  assert.match(app, /class="detail-back"[^>]*data-close[^>]*>.*Назад/);
  assert.doesNotMatch(app, /detail-toolbar/);
  assert.match(app, /recipe-detail-sheet/);
  assert.match(app, /data-tag=/);
  assert.match(css, /\.recipe-detail-sheet \{/);
  assert.match(css, /\.detail-actions \{ position: fixed/);
  assert.match(css, /\.recipe-panel \{[\s\S]*border-top: 1px solid var\(--line\)/);
  assert.match(index, /refinements\.css\?v=[a-zA-Z0-9.-]+/);
  assert.match(index, /app\.js\?v=[a-zA-Z0-9.-]+/);
});

test('recipe detail exposes sharing to the owner and a read-only public view', () => {
  const app = fs.readFileSync(path.resolve('public/app.js'), 'utf8');
  const css = fs.readFileSync(path.resolve('public/refinements.css'), 'utf8');
  assert.match(app, /id="share">Поделиться/);
  assert.match(app, /detail-heading-tools[^`]*\$\{editButton\}/);
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
