import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
process.env.DATABASE_PATH = path.resolve('data', `meal-request-${process.pid}.sqlite`);
process.env.DINNER_LLM_ENABLED = 'true';
process.env.DINNER_IMAGES_ENABLED = 'false';
process.env.OPENAI_API_KEY = 'test-key';
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
const db = await import('../src/db.js');
const store = await import('../src/dinner-store.js');
const service = await import('../src/dinner-service.js');
const suggestions = await import('../src/suggestions.js');
const { parseMealRequest, matchesMealRequest } = await import('../src/meal-request.js');
const { parseDinnerIntakeFallback, combineDinnerIntakeExtraction } = await import('../src/dinner-intake.js');
const { rankCandidates, SEED_RECIPES } = await import('../src/dinner.js');
const { dinnerContextKey } = await import('../src/dinner-buffer.js');
let serial = 7000;
const user = () => db.upsertTelegramUser({ id: serial++, first_name: 'Контракт' });
const steak = () => ({ title: 'Стейк из говядины', description: 'Стейк на сковороде', servings: 4, prepMinutes: 5, cookMinutes: 20,
  ingredients: [{ name: 'говядина', quantity: 800, unit: 'г' }, { name: 'растительное масло', quantity: 10, unit: 'мл' }],
  steps: [{ text: 'Обсушите говядину и нарежьте на стейки.' }, { text: 'Разогрейте сковороду с растительным маслом.' }, { text: 'Обжарьте стейки с двух сторон до готовности.' }, { text: 'Дайте мясу отдохнуть перед подачей.' }], tags: ['мясо'], warnings: [] });
test.after(async () => { await new Promise(setImmediate); db.db.close(); for (const suffix of ['', '-wal', '-shm']) fs.rmSync(process.env.DATABASE_PATH + suffix, { force: true }); });

test('today request preserves arbitrary dish identity separately from pantry and persistent tastes', () => {
  for (const dish of ['стейк', 'лазанья', 'бефстроганов']) {
    const parsed = parseDinnerIntakeFallback(`Сегодня хочу ${dish}`);
    assert.equal(parsed.mealRequest.dish, dish);
    assert.deepEqual(parsed.availableIngredients, []);
    assert.deepEqual(parsed.preferredCategories, {});
    const combined = combineDinnerIntakeExtraction({ availableIngredients: [dish], requestedCategories: ['meat'] }, parsed);
    assert.equal(combined.mealRequest.dish, dish);
    assert.deepEqual(combined.availableIngredients, []);
  }
  const taste = parseDinnerIntakeFallback('люблю стейк', { bareCategoriesAsLikes: true });
  assert.equal(taste.dishPreferences['стейк'], 1);
  assert.equal(taste.mealRequest, undefined);
});

test('dish, ingredients, method, time and servings are independent mandatory checks', () => {
  const request = parseMealRequest('хочу стейк из говядины на сковороде на четверых за 30 минут без чеснока');
  assert.equal(request.dish, 'стейк'); assert.equal(request.servings, 4);
  assert.deepEqual(request.requiredIngredients, ['говядины']);
  assert.deepEqual(request.excludedIngredients, ['чеснока']);
  assert.equal(matchesMealRequest(steak(), request), true);
  for (const patch of [{ title: 'Гуляш из говядины', tags: ['стейк'] }, { servings: 2 }, { cookMinutes: 40 }, { ingredients: [{ name: 'курица' }] }, { steps: [{ text: 'Запеките в духовке' }] }]) assert.equal(matchesMealRequest({ ...steak(), ...patch }, request), false);
});

test('exact request survives storage and buffer; wrong AI and fallback cannot replace steak with goulash', async () => {
  const owner = user();
  service.confirmDinnerIntake(owner.id, parseDinnerIntakeFallback('сегодня хочу стейк'));
  const session = service.startDinner(owner.id);
  assert.equal(session.mealRequest.dish, 'стейк');
  assert.equal(JSON.parse(store.getDinnerSession(owner.id, session.sessionId).meal_request_json).dish, 'стейк');
  let calls = 0;
  const result = await service.recommendDinner(owner.id, session.sessionId, { generate: async (input) => {
    calls++; assert.equal(input.mealRequest.dish, 'стейк');
    return { recipes: [{ role: 'familiar', recipe: { ...steak(), title: 'Гуляш из говядины' } }] };
  } });
  assert.ok(calls >= 1);
  assert.equal(result.recommendations.length, 0);
  assert.match(result.message, /соответствует всем условиям/);
  const next = service.changeDinnerRequest(owner.id, 'стейк');
  assert.notEqual(next.sessionId, session.sessionId);
  const good = await service.recommendDinner(owner.id, next.sessionId, { generate: async () => ({ recipes: [{ role: 'familiar', recipe: steak() }] }) });
  assert.equal(good.recommendations.length, 1);
  assert.match(good.recommendations[0].recipe.title, /Стейк/);
  service.changeDinnerRequest(owner.id, '');
  assert.equal(store.getDinnerMealRequest(owner.id), null);
  assert.throws(() => service.dinnerContext(owner.id, next.sessionId), { status: 409 });
});

test('recipe request rejects wrong dish even when provider tags contain the requested word', async () => {
  const owner = user();
  await assert.rejects(suggestions.resolveRecipeRequest(owner.id, 'стейк', { generate: async () => ({ ...steak(), title: 'Гуляш', tags: ['стейк'] }) }), { status: 422 });
  assert.equal(db.listRecipes(owner.id).length, 0);
});

test('cached suggestion and save revalidate changed exclusions, children, portions and time', async () => {
  const owner = user();
  const first = await suggestions.resolveRecipeRequest(owner.id, 'стейк', { generate: async () => steak() });
  service.updateDinnerProfile(owner.id, { excludedIngredients: ['говядина'] });
  assert.throws(() => suggestions.assertSuggestionCurrent(owner.id, first.suggestion), { status: 422 });
  let calls = 0;
  await assert.rejects(suggestions.resolveRecipeRequest(owner.id, 'стейк', { generate: async () => { calls++; return steak(); } }), { status: 422 });
  assert.equal(calls, 1);
  for (const patch of [{ excludedIngredients: [], householdSize: 5 }, { householdSize: 2, preferredMaxCookingTime: 10 }]) {
    service.updateDinnerProfile(owner.id, patch);
    assert.throws(() => suggestions.assertSuggestionCurrent(owner.id, first.suggestion), { status: 422 });
  }
  service.updateDinnerProfile(owner.id, { preferredMaxCookingTime: 30, hasChildren: true });
  assert.throws(() => suggestions.assertSuggestionCurrent(owner.id, { ...first.suggestion, recipe: { ...steak(), steps: [{ text: 'Добавьте перец чили' }] } }), { status: 422 });
});

test('generation response is checked again if profile changed while awaiting provider', async () => {
  const owner = user();
  await assert.rejects(suggestions.resolveRecipeRequest(owner.id, 'стейк', { generate: async () => {
    service.updateDinnerProfile(owner.id, { excludedIngredients: ['говядина'] }); return steak();
  } }), { status: 422 });
  assert.equal(db.findRecipeSuggestion(owner.id, 'request:стейк'), null);
});

test('insufficient portions and spicy child meals are filtered before all ranking bonuses', () => {
  assert.equal(rankCandidates([{ ...steak(), id: 'a', userSaved: true, servings: 2 }], { profile: { householdSize: 4, preferredCategories: { meat: 1 } } }).length, 0);
  assert.equal(rankCandidates([{ ...steak(), id: 'a', steps: [{ text: 'Добавьте чили' }] }], { profile: { hasChildren: true } }).length, 0);
});

test('feedback changes next context, asks actual missing items and never stores them as allergies', async () => {
  const owner = user();
  const session = service.startDinner(owner.id);
  const initial = await service.recommendDinner(owner.id, session.sessionId, { generate: assert.fail });
  const ids = initial.recommendations.map((r) => r.id);
  service.rejectDinnerBatch(owner.id, ids);
  const before = service.dinnerContext(owner.id, session.sessionId);
  assert.deepEqual(service.setDinnerRejectionReason(owner.id, ids[0], 'missing_ingredients'), { saved: false, needsIngredients: true });
  service.setDinnerRejectionReason(owner.id, ids[0], 'missing_ingredients', { ids, missingIngredients: ['говядина'] });
  const after = service.dinnerContext(owner.id, session.sessionId);
  assert.notEqual(dinnerContextKey(before), dinnerContextKey(after));
  assert.deepEqual(after.feedback.unavailableIngredients, ['говядина']);
  assert.deepEqual(store.getFoodProfile(owner.id).excludedIngredients, []);
  assert.equal(rankCandidates([{ ...steak(), id: 'a' }], after).length, 0);
  assert.equal(rankCandidates([{ ...steak(), id: 'a', ingredients: Array.from({ length: 9 }, () => ({ name: 'говядина' })) }], { feedback: { simpleOnly: true } }).length, 0);
  assert.equal(rankCandidates([{ ...steak(), id: 'a' }], { feedback: { avoidTitles: ['Стейк из говядины'] } }).length, 0);
  assert.ok(SEED_RECIPES.length > 0);
});
