import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

process.env.DATABASE_PATH = path.resolve('data', `dialogue-${process.pid}-${randomUUID()}.sqlite`);
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.TELEGRAM_POLLING = 'false';
process.env.OPENAI_API_KEY = 'test-key';
process.env.OPENAI_TEXT_MODEL = 'test-model';
process.env.OPENAI_TRANSCRIBE_MODEL = 'test-model';
process.env.DINNER_LLM_ENABLED = 'false';
process.env.DINNER_IMAGES_ENABLED = 'false';
process.env.OPENAI_IMAGE_MODEL = '';
process.env.APP_URL = 'https://recipes.example.test';
const database = await import('../src/db.js');
const dialogueStore = await import('../src/recipe-dialogue.js');
const telegram = await import('../src/telegram.js');
const { resolveRecipeRequest } = await import('../src/suggestions.js');
const { startTrial } = await import('../src/subscriptions.js');
const { normalizeMealRequest } = await import('../src/meal-request.js');
const { SEED_RECIPES } = await import('../src/dinner.js');
let serial = 14000;
const user = () => {
  const from = { id: serial++, first_name: 'Диалог' }, chat = { id: from.id, type: 'private' };
  const owner = database.upsertTelegramUser(from); database.allowUser(owner.id); startTrial(owner.id);
  return { from, chat, owner, message: text => ({ from, chat, text }) };
};
const request = normalizeMealRequest({ text: 'необычный ужин из фарша, который давно не ели', kind: 'open', confidence: 'high',
  requiredIngredients: ['фарш'], semanticCriteria: [{ description: 'Необычное блюдо для ужина', importance: 'required' }] });
const recipe = title => ({ title, description: 'Необычное блюдо из фарша', servings: 4, prepMinutes: 10, cookMinutes: 15,
  ingredients: [{ name: 'говяжий фарш', raw: 'говяжий фарш', quantity: 500, unit: 'г', comment: null, confidence: 1 }],
  steps: [{ position: 1, text: 'Приготовьте фарш на сковороде до полной готовности.', confidence: 1 }], tags: ['мясо'], warnings: [], sourceName: null, discovery: 'Необычная подача',
  nutrition: { calories: 350, protein: 30, fat: 20, carbs: 5, basis: 'serving', source: 'calculated', servings: 4 } });

async function withProvider(run, { generatedTitles = ['Кефтедес с мятой', 'Кебаб с овощами', 'Фарш с баклажанами'], dialogueResponse = null, acceptSeeds = true } = {}) {
  const original = globalThis.fetch, calls = [], sent = [], generations = [];
  globalThis.fetch = async (url, options = {}) => {
    const address = String(url);
    if (address.includes('/file/bot')) return new Response(Buffer.from('voice'));
    if (address.includes('api.telegram.org')) {
      const body = JSON.parse(options.body); sent.push({ method: address.split('/').at(-1), ...body });
      return Response.json({ ok: true, result: address.endsWith('/getFile') ? { file_path: 'voice.ogg' } : { message_id: sent.length } });
    }
    if (address.endsWith('/audio/transcriptions')) return Response.json({ text: 'на троих' });
    assert.ok(address.endsWith('/responses'), `Unexpected request: ${address}`);
    const body = JSON.parse(options.body), operation = body.text.format.name;
    const input = operation === 'meal_request_interpretation' ? body.input[0].content[0].text : JSON.parse(body.input[0].content[0].text);
    calls.push({ operation, input, instructions: body.instructions });
    let output;
    if (operation === 'meal_request_interpretation') output = request;
    else if (operation === 'recipe_semantic_validation') output = { candidates: input.candidates.map(candidate => ({ id: candidate.id,
      criteria: input.criteria.map((_, index) => ({ index, matches: (acceptSeeds && candidate.title === 'Соборо-дон') || generatedTitles.includes(candidate.title), confidence: 'high', evidence: candidate.title })) })) };
    else if (operation === 'requested_recipe_generation') {
      generations.push(input); output = recipe(generatedTitles[Math.min(generations.length - 1, generatedTitles.length - 1)]);
    } else if (operation === 'recipe_dialogue') output = typeof dialogueResponse === 'function' ? dialogueResponse(input) : dialogueResponse;
    else assert.fail(`Unexpected operation: ${operation}`);
    return Response.json({ status: 'completed', output_text: JSON.stringify(output), usage: { input_tokens: 1, output_tokens: 1 } });
  };
  try { await run({ calls, sent, generations }); } finally { globalThis.fetch = original; }
}

test.after(() => { database.db.close(); for (const suffix of ['', '-wal', '-shm']) fs.rmSync(process.env.DATABASE_PATH + suffix, { force: true }); });

test('screenshot sequence keeps mince and novelty after refusal, refinements and voice', async () => {
  const u = user();
  await withProvider(async ({ calls, sent, generations }) => {
    await telegram.handleMessage(u.message('Подбери необычный ужин из фарша, который давно не ели'));
    const first = dialogueStore.getRecipeDialogue(u.owner.id);
    assert.equal(first.recipe.title, 'Соборо-дон');
    const card = sent.find(item => item.caption?.includes('Соборо') || item.text?.startsWith('<b>Соборо'));
    assert.ok(card.reply_markup.inline_keyboard.flat().some(button => button.text === 'Другой вариант'));
    await telegram.handleMessage(u.message('Не хочу его'));
    const second = dialogueStore.getRecipeDialogue(u.owner.id);
    assert.equal(second.recipe.title, 'Кефтедес с мятой');
    assert.deepEqual(second.mealRequest.requiredIngredients, ['фарш']);
    assert.deepEqual(second.mealRequest.semanticCriteria, request.semanticCriteria);
    assert.ok(generations[0].recentTitles.includes('Соборо-дон'));
    assert.equal(calls.filter(item => item.operation === 'meal_request_interpretation').length, 1);
    await telegram.handleMessage(u.message('без риса'));
    const third = dialogueStore.getRecipeDialogue(u.owner.id);
    assert.deepEqual(third.mealRequest.excludedIngredients, ['риса']);
    assert.deepEqual(third.mealRequest.requiredIngredients, ['фарш']);
    await telegram.handleMessage({ from: u.from, chat: u.chat, voice: { file_id: 'voice', file_unique_id: 'voice-unique', duration: 2, mime_type: 'audio/ogg' } });
    const persisted = dialogueStore.getRecipeDialogue(u.owner.id);
    assert.notEqual(persisted.id, third.id);
    assert.equal(persisted.mealRequest.servings, 3);
    assert.deepEqual(persisted.mealRequest.excludedIngredients, ['риса']);
    assert.ok(generations.at(-1).mealRequest.servings === 3);
    assert.equal(calls.some(item => item.input.query === 'Не хочу его'), false);
  });
});

test('dialogue survives another process and old cards remain owner scoped', async () => {
  const u = user(), other = user();
  const d = dialogueStore.createRecipeDialogue(u.owner.id, { query: request.text, mealRequest: request, recipe: { ...recipe('Первый'), id: 'seed:first' }, rejectedRecipes: [] });
  const later = dialogueStore.createRecipeDialogue(u.owner.id, { query: 'новый суп', mealRequest: { text: 'суп' }, recipe: recipe('Суп'), rejectedRecipes: [] });
  assert.equal(dialogueStore.getRecipeDialogue(other.owner.id, d.id), null);
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `const s=await import('./src/recipe-dialogue.js'); console.log(JSON.stringify(s.getRecipeDialogue(${JSON.stringify(u.owner.id)})));`], { encoding: 'utf8', env: process.env });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout.trim()).id, later.id);
  await withProvider(async ({ sent }) => {
    await telegram.handleRecipeDialogueCallback({ id: 'edit-old', data: `dialog:edit:${d.id}`, from: u.from, message: { chat: u.chat, message_id: 1 } });
    assert.equal(sent.at(-1).show_alert, true);
    assert.equal(dialogueStore.getRecipeDialogue(u.owner.id).id, later.id);
    await telegram.handleRecipeDialogueCallback({ id: 'foreign', data: `dialog:other:${d.id}`, from: other.from, message: { chat: other.chat, message_id: 1 } });
    assert.equal(sent.at(-1).show_alert, true);
    assert.equal(dialogueStore.getRecipeDialogue(other.owner.id), null);
  });
});

test('rejection bypasses old generation cache and repeated rejected generation is refused', async () => {
  const u = user();
  const validate = async ({ recipes }) => recipes.map(item => ({ recipe: item, accepted: ['Кефтедес с мятой', 'Кебаб с овощами'].includes(item.title), preferredScore: 100 }));
  const first = await resolveRecipeRequest(u.owner.id, request.text, { mealRequest: request, generate: async () => recipe('Кефтедес с мятой'), validate });
  const rejectedRecipes = [{ title: first.suggestion.recipe.title }];
  let attempts = 0;
  const second = await resolveRecipeRequest(u.owner.id, request.text, { mealRequest: request, rejectedRecipes, validate, generate: async input => {
    assert.ok(input.recentTitles.includes('Кефтедес с мятой')); attempts++;
    return recipe(attempts === 1 ? 'Кефтедес с мятой' : 'Кебаб с овощами');
  } });
  assert.equal(attempts, 2);
  assert.equal(second.suggestion.recipe.title, 'Кебаб с овощами');
  await assert.rejects(resolveRecipeRequest(u.owner.id, request.text, { mealRequest: request,
    rejectedRecipes: [...rejectedRecipes, { title: 'Кебаб с овощами' }], validate, generate: async () => recipe('Кефтедес с мятой') }), { status: 422 });
});

test('questions use current recipe and keep the task without generation', async () => {
  const u = user();
  const d = dialogueStore.createRecipeDialogue(u.owner.id, { query: request.text, mealRequest: request, recipe: recipe('Кефтедес с мятой'), rejectedRecipes: [] });
  await withProvider(async ({ calls, sent, generations }) => {
    await telegram.handleMessage(u.message('Чем заменить мяту?'));
    assert.equal(calls[0].input.recipe.title, 'Кефтедес с мятой');
    assert.match(sent.at(-1).text, /петрушк/);
    assert.equal(generations.length, 0);
    assert.equal(dialogueStore.getRecipeDialogue(u.owner.id).id, d.id);
    assert.equal(dialogueStore.getRecipeDialogue(u.owner.id).messages.length, 2);
  }, { dialogueResponse: { action: 'question', query: '', mealRequest: null, answer: 'В кефтедес мяту можно заменить петрушкой.' } });
});

test('skip saving differs from rejecting the dish and text save is not an import', async () => {
  const u = user();
  const suggestion = database.createRecipeSuggestion(u.owner.id, 'request:кефтедес', recipe('Кефтедес с мятой'), request);
  const d = dialogueStore.createRecipeDialogue(u.owner.id, { query: request.text, mealRequest: request, recipe: suggestion.recipe, suggestionId: suggestion.id, rejectedRecipes: [] });
  await withProvider(async ({ calls, sent }) => {
    await telegram.handleMessage(u.message('Не сохраняй'));
    assert.equal(database.listRecipes(u.owner.id).length, 0);
    assert.deepEqual(dialogueStore.getRecipeDialogue(u.owner.id).rejectedRecipes, []);
    await telegram.handleMessage(u.message('Сохрани'));
    assert.equal(database.listRecipes(u.owner.id).length, 1);
    assert.equal(calls.length, 0);
    assert.match(sent.at(-1).text, /Сохранено/);
    assert.ok(dialogueStore.getRecipeDialogue(u.owner.id).savedRecipeId);
    assert.equal(dialogueStore.getRecipeDialogue(u.owner.id).id, d.id);
  });
});

test('menu starts a new task and offers collection, explicit import and profile', async () => {
  const u = user();
  const { saveFoodProfile, getFoodProfile } = await import('../src/dinner-store.js');
  saveFoodProfile(u.owner.id, { ...getFoodProfile(u.owner.id), householdSize: 2, onboardingCompleted: true });
  dialogueStore.createRecipeDialogue(u.owner.id, { query: request.text, recipe: recipe('Первый'), mealRequest: request });
  await withProvider(async ({ sent, calls }) => {
    await telegram.handleMessage(u.message('Что приготовить'));
    assert.equal(dialogueStore.getRecipeDialogue(u.owner.id), null);
    assert.match(sent.at(-1).text, /Что хотите приготовить/);
    await telegram.handleMessage(u.message('Мои рецепты'));
    assert.match(sent.at(-1).reply_markup.inline_keyboard[0][0].web_app.url, /view=collection/);
    await telegram.handleMessage(u.message('Сохранить рецепт'));
    assert.equal(database.getPendingIntent(u.owner.id).kind, 'recipe-save');
    await telegram.handleMessage(u.message('/cancel'));
    assert.equal(database.getPendingIntent(u.owner.id), null);
    await telegram.handleMessage(u.message('Мои предпочтения'));
    assert.equal(database.getPendingIntent(u.owner.id).profileOnly, true);
    assert.equal(calls.length, 0);
  });
});

test('without dialogue refusal asks for context rather than searching for the refusal', async () => {
  const u = user();
  await withProvider(async ({ sent, calls }) => {
    await telegram.handleMessage(u.message('Не хочу его'));
    assert.equal(calls.length, 0);
    assert.match(sent.at(-1).text, /к какому рецепту/);
  });
});

test('seed save is idempotent and deleting user removes all dialogue snapshots', async () => {
  const u = user(), seed = SEED_RECIPES.find(item => item.title === 'Соборо-дон');
  const d = dialogueStore.createRecipeDialogue(u.owner.id, { query: request.text, mealRequest: request, recipe: seed, rejectedRecipes: [] });
  await withProvider(async () => {
    const callback = { id: 'save-seed', data: `dialog:save:${d.id}`, from: u.from, message: { chat: u.chat, message_id: 1 } };
    await telegram.handleRecipeDialogueCallback(callback); await telegram.handleRecipeDialogueCallback(callback);
    assert.equal(database.listRecipes(u.owner.id).length, 1);
  });
  database.deleteUserData(u.owner.id);
  assert.equal(dialogueStore.getRecipeDialogue(u.owner.id, d.id), null);
});

test('contextual refinement keeps the original task, while an explicit new request resets refusals', async () => {
  const u = user();
  dialogueStore.createRecipeDialogue(u.owner.id, { query: request.text, mealRequest: request,
    recipe: recipe('Прежний вариант'), rejectedRecipes: [{ title: 'Соборо-дон' }] });
  await withProvider(async () => {
    await telegram.handleMessage(u.message('Лучше в духовке, но всё остальное оставь'));
    const refined = dialogueStore.getRecipeDialogue(u.owner.id);
    assert.deepEqual(refined.mealRequest.requiredIngredients, ['фарш']);
    assert.deepEqual(refined.mealRequest.semanticCriteria, request.semanticCriteria);
    assert.deepEqual(refined.mealRequest.methods, ['духовка']);
    assert.equal(refined.rejectedRecipes.length, 2);
  }, { dialogueResponse: { action: 'refine', query: '', answer: '', mealRequest: { ...request, text: `${request.text}, в духовке`, methods: ['духовка'] } } });
  await withProvider(async ({ calls }) => {
    await telegram.handleMessage(u.message('Теперь хочу суп'));
    assert.equal(calls.find(item => item.operation === 'meal_request_interpretation').input, 'суп');
    assert.deepEqual(dialogueStore.getRecipeDialogue(u.owner.id).rejectedRecipes, []);
  }, { dialogueResponse: { action: 'new', query: 'суп', answer: '', mealRequest: null } });
});

test('missing ingredient and cooking time buttons refine their card without changing the profile', async () => {
  const u = user();
  const { getFoodProfile } = await import('../src/dinner-store.js');
  const before = getFoodProfile(u.owner.id);
  const d = dialogueStore.createRecipeDialogue(u.owner.id, { query: request.text, mealRequest: request,
    recipe: { ...recipe('Прежний вариант'), cookMinutes: 40 }, rejectedRecipes: [] });
  await withProvider(async () => {
    await telegram.handleRecipeDialogueCallback({ id: 'refuse', data: `dialog:refuse:${d.id}`, from: u.from, message: { chat: u.chat, message_id: 1 } });
    const prompt = dialogueStore.getRecipeDialogue(u.owner.id);
    await telegram.handleRecipeDialogueCallback({ id: 'missing', data: `dialog:missing:${d.id}`, from: u.from, message: { chat: u.chat, message_id: prompt.promptMessageId } });
    await telegram.handleMessage(u.message('рис'));
    const refined = dialogueStore.getRecipeDialogue(u.owner.id);
    assert.deepEqual(refined.mealRequest.excludedIngredients, ['рис']);
    assert.deepEqual(refined.mealRequest.requiredIngredients, ['фарш']);
    dialogueStore.updateRecipeDialogue(u.owner.id, refined.id, { recipe: { ...refined.recipe, cookMinutes: 40 } });
    await telegram.handleRecipeDialogueCallback({ id: 'refuse-new', data: `dialog:refuse:${refined.id}`, from: u.from, message: { chat: u.chat, message_id: refined.messageId } });
    const newPrompt = dialogueStore.getRecipeDialogue(u.owner.id);
    await telegram.handleRecipeDialogueCallback({ id: 'slow', data: `dialog:slow:${refined.id}`, from: u.from, message: { chat: u.chat, message_id: newPrompt.promptMessageId } });
    assert.equal(dialogueStore.getRecipeDialogue(u.owner.id).mealRequest.maxMinutes, 30);
    assert.deepEqual(getFoodProfile(u.owner.id), before);
  });
});

test('screenshot: an old refusal button cannot switch back to soboro after a new card', async () => {
  const u = user();
  await withProvider(async ({ sent, generations }) => {
    await telegram.handleMessage(u.message('Подбери необычный ужин из фарша'));
    const first = dialogueStore.getRecipeDialogue(u.owner.id);
    const cb = (action, d, messageId = d.messageId) => ({ id: `${action}-${sent.length}`, data: `dialog:${action}:${d.id}`, from: u.from, message: { chat: u.chat, message_id: messageId } });
    const firstCard = sent.find(item => item.caption?.includes(first.recipe.title) || item.text?.startsWith(`<b>${first.recipe.title}`));
    assert.ok(firstCard.reply_markup.inline_keyboard.flat().some(item => item.text === 'Не хочу'));
    await telegram.handleRecipeDialogueCallback(cb('other', first));
    const second = dialogueStore.getRecipeDialogue(u.owner.id);
    assert.notEqual(second.id, first.id);
    assert.ok(sent.some(item => item.method === 'editMessageReplyMarkup' && item.message_id === first.messageId
      && !item.reply_markup.inline_keyboard.flat().some(button => button.text === 'Другой вариант')));
    // Legacy reason buttons from the previous release remain in Telegram history.
    await telegram.handleRecipeDialogueCallback(cb('missing', first, 900));
    assert.equal(sent.at(-1).show_alert, true);
    assert.equal(dialogueStore.getRecipeDialogue(u.owner.id).id, second.id);
    await telegram.handleRecipeDialogueCallback(cb('refuse', second));
    const rejection = dialogueStore.getRecipeDialogue(u.owner.id);
    assert.equal(rejection.promptKind, 'rejection');
    assert.ok(sent.at(-1).reply_markup.inline_keyboard.flat().some(item => item.text === 'Не хочу'));
    const before = generations.length;
    await telegram.handleRecipeDialogueCallback(cb('missing', second, rejection.promptMessageId));
    const missing = dialogueStore.getRecipeDialogue(u.owner.id);
    assert.equal(missing.promptKind, 'missing');
    assert.ok(sent.some(item => item.method === 'editMessageText' && item.message_id === rejection.promptMessageId));
    await telegram.handleRecipeDialogueCallback(cb('other', second));
    const third = dialogueStore.getRecipeDialogue(u.owner.id);
    assert.notEqual(third.id, second.id);
    assert.equal(third.promptKind, undefined);
    assert.ok(sent.some(item => item.method === 'editMessageText' && item.message_id === missing.promptMessageId && item.reply_markup.inline_keyboard.length === 0));
    const count = generations.length;
    assert.ok(count > before);
    await telegram.handleRecipeDialogueCallback(cb('other', second));
    await telegram.handleRecipeDialogueCallback(cb('other', second, rejection.promptMessageId));
    assert.equal(generations.length, count);
    assert.equal(dialogueStore.getRecipeDialogue(u.owner.id).id, third.id);
    await telegram.handleRecipeDialogueCallback(cb('open', first));
    assert.equal(dialogueStore.getRecipeDialogue(u.owner.id).id, third.id);
  });
});

test('one refusal prompt, optional generic refusal, and cancelling preserves the current recipe', async () => {
  const u = user();
  await withProvider(async ({ sent, calls }) => {
    await telegram.handleMessage(u.message('Подбери необычный ужин из фарша'));
    const first = dialogueStore.getRecipeDialogue(u.owner.id);
    const cb = (action, id) => ({ id: `${action}-${sent.length}`, data: `dialog:${action}:${first.id}`, from: u.from, message: { chat: u.chat, message_id: id } });
    await telegram.handleRecipeDialogueCallback(cb('refuse', first.messageId));
    const older = dialogueStore.getRecipeDialogue(u.owner.id);
    await telegram.handleRecipeDialogueCallback(cb('refuse', first.messageId));
    const newer = dialogueStore.getRecipeDialogue(u.owner.id);
    assert.notEqual(older.promptMessageId, newer.promptMessageId);
    assert.ok(sent.some(item => item.method === 'editMessageText' && item.message_id === older.promptMessageId));
    const count = calls.length;
    await telegram.handleRecipeDialogueCallback(cb('other', older.promptMessageId));
    assert.equal(sent.at(-1).show_alert, true);
    assert.equal(calls.length, count);
    await telegram.handleRecipeDialogueCallback(cb('cancel', newer.promptMessageId));
    const cancelled = dialogueStore.getRecipeDialogue(u.owner.id);
    assert.equal(cancelled.id, first.id);
    assert.equal(cancelled.promptKind, null);
    assert.equal(cancelled.awaitingEdit, false);
    assert.deepEqual(cancelled.rejectedRecipes, []);
    await telegram.handleRecipeDialogueCallback(cb('refuse', first.messageId));
    const latest = dialogueStore.getRecipeDialogue(u.owner.id);
    await telegram.handleRecipeDialogueCallback(cb('other', latest.promptMessageId));
    assert.notEqual(dialogueStore.getRecipeDialogue(u.owner.id).id, first.id);
  });
});

test('contextual AI and replacement respect expired access without an AI call', async () => {
  const u = user();
  database.db.prepare('UPDATE user_trials SET expires_at=? WHERE user_id=?').run('2000-01-01T00:00:00.000Z', u.owner.id);
  dialogueStore.createRecipeDialogue(u.owner.id, { query: request.text, mealRequest: request, recipe: recipe('Прежний вариант'), rejectedRecipes: [] });
  await withProvider(async ({ calls }) => {
    await telegram.handleMessage(u.message('Чем заменить мяту?'));
    await telegram.handleMessage(u.message('Не хочу его'));
    assert.equal(calls.length, 0);
    assert.equal(dialogueStore.getRecipeDialogue(u.owner.id).query, request.text);
  });
});

test('actual cooking history reaches validation and saving alone never implies eating', async () => {
  const u = user();
  const { addDinnerEvent } = await import('../src/dinner-store.js');
  const seed = SEED_RECIPES.find(item => item.title === 'Соборо-дон');
  database.saveDinnerRecipe(u.owner.id, seed.id, seed);
  let history;
  const validate = async input => { history = input.cookingHistory; return input.recipes.map(item => ({ recipe: item, accepted: true, preferredScore: 1 })); };
  await resolveRecipeRequest(u.owner.id, request.text, { mealRequest: request, validate, generate: assert.fail });
  assert.deepEqual(history, []);
  addDinnerEvent(u.owner.id, 'recipe_cooked', { recipeKey: seed.id });
  await resolveRecipeRequest(u.owner.id, request.text, { mealRequest: request, validate, generate: assert.fail });
  assert.equal(history[0].title, seed.title);
  assert.ok(history[0].cookedAt);
});

test('a completed user starts a direct cooking request without reopening the profile', async () => {
  const u = user();
  const { saveFoodProfile, getFoodProfile } = await import('../src/dinner-store.js');
  saveFoodProfile(u.owner.id, { ...getFoodProfile(u.owner.id), householdSize: 2, onboardingCompleted: true });
  await withProvider(async ({ calls }) => {
    await telegram.handleMessage(u.message('Хочу необычный ужин из фарша'));
    assert.ok(dialogueStore.getRecipeDialogue(u.owner.id));
    assert.equal(database.getPendingIntent(u.owner.id), null);
    assert.equal(calls[0].operation, 'meal_request_interpretation');
  });
});
