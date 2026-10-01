import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeNutrition, estimateNutrition, nutritionKey, parseNutritionLimits, matchesNutritionLimits } from '../src/nutrition.js';
process.env.DATABASE_PATH = path.resolve('data', `nutrition-${process.pid}-${randomUUID()}.sqlite`);
process.env.OPENAI_API_KEY = 'test-key';
process.env.OPENAI_TEXT_MODEL = 'test-model';
process.env.DINNER_IMAGES_ENABLED = 'false';
const db = await import('../src/db.js');
const { ensureNutrition } = await import('../src/nutrition-service.js');
const { SEED_RECIPES } = await import('../src/dinner.js');
const { startTrial } = await import('../src/subscriptions.js');
const { resolveRecipeRequest } = await import('../src/suggestions.js');
const { parseMealRequest, mergeMealRequests, normalizeMealRequest } = await import('../src/meal-request.js');
const { normalizeRecipe } = await import('../src/openai.js');
const n = { calories: 800, protein: 60, fat: 20, carbs: 90, basis: 'total', source: 'recipe', servings: 2, assumptions: [] };
let serial = 88500;
const user = () => { const owner = db.upsertTelegramUser({ id: serial++, first_name: 'КБЖУ' }); startTrial(owner.id); return owner; };
const chicken = () => ({ title: 'Экспериментальный суп', status: 'ready', description: 'Суп с курицей', servings: 2, prepMinutes: 10, cookMinutes: 20,
  ingredients: [{ name: 'куриное филе', quantity: 300, unit: 'г' }, { name: 'рис', quantity: 100, unit: 'г' }, { name: 'масло', quantity: 10, unit: 'г' }], steps: [{ text: 'Отварите рис и курицу, добавьте масло.' }], tags: [], warnings: [] });
test.after(() => { db.db.close(); for (const suffix of ['', '-wal', '-shm']) fs.rmSync(process.env.DATABASE_PATH + suffix, { force: true }); });
test('source totals and per-100g values convert to servings without relabelling unknown weight', () => {
  assert.equal(normalizeNutrition(n).calories, 400);
  assert.equal(normalizeNutrition(n).source, 'recipe');
  assert.equal(normalizeNutrition({ ...n, basis: '100g', weightGrams: 500 }).protein, 150);
  assert.equal(normalizeNutrition({ ...n, basis: '100g' }), null);
  assert.equal(normalizeNutrition({ ...n, fat: undefined }), null);
  assert.equal(normalizeNutrition({ ...n, protein: -1 }), null);
  assert.equal(normalizeNutrition({ ...n, basis: 'serving' }, { servings: 4 }), null);
});
test('local calculation includes oil, quantities and portions, and marks assumptions', () => {
  const result = estimateNutrition(chicken());
  assert.equal(result.calories, 406.7);
  assert.equal(result.protein, 37.3);
  assert.equal(result.fat, 9.3);
  assert.equal(result.carbs, 40);
  assert.equal(result.source, 'calculated');
  assert.ok(result.assumptions.length);
  assert.equal(estimateNutrition({ ...chicken(), ingredients: [{ name: 'неизвестный продукт', quantity: 100, unit: 'г' }] }), null);
  assert.equal(estimateNutrition({ ...chicken(), ingredients: [{ name: 'рис', quantity: 1, unit: 'стакан' }] }), null);
  assert.match(estimateNutrition({ ...chicken(), ingredients: [{ name: 'курица' }] }).assumptions.join(' '), /не указано/);
});
test('every catalogue recipe has all four nutrition values', () => {
  for (const recipe of SEED_RECIPES) {
    assert.ok(recipe.nutrition, recipe.title);
    for (const key of ['calories', 'protein', 'fat', 'carbs']) assert.ok(Number.isFinite(recipe.nutrition[key]), recipe.title);
  }
});
test('nutrition survives save and sharing; ingredient and serving edits recalculate', () => {
  const owner = user(), recipe = db.createRecipe(owner.id, { ...chicken(), nutrition: n });
  assert.equal(recipe.nutrition.calories, 400);
  assert.equal(db.getRecipe(owner.id, recipe.id).nutrition.source, 'recipe');
  const share = db.createRecipeShare(owner.id, recipe.id);
  assert.equal(db.getSharedRecipe(share).nutrition.protein, 30);
  const edited = db.updateRecipe(owner.id, recipe.id, { servings: 4 });
  assert.equal(edited.nutrition.calories, 203.4);
  assert.equal(edited.nutrition.source, 'calculated');
  const doubledOil = db.updateRecipe(owner.id, recipe.id, { ingredients: chicken().ingredients.map(i => i.name === 'масло' ? { ...i, quantity: 20 } : i) });
  assert.ok(doubledOil.nutrition.calories > edited.nutrition.calories);
  assert.equal(db.updateRecipe(owner.id, recipe.id, { notes: 'заметка' }).nutrition.calories, doubledOil.nutrition.calories);
});
test('legacy enrichment deduplicates concurrent calls and persists by recipe content', async () => {
  const recipe = { ...chicken(), ingredients: [{ name: 'редкий продукт', quantity: 300, unit: 'г' }] };
  let calls = 0;
  const estimate = async () => { calls++; await new Promise(setImmediate); return { ...n, basis: 'serving', source: 'calculated' }; };
  const [a, b] = await Promise.all([ensureNutrition(null, recipe, { estimate }), ensureNutrition(null, recipe, { estimate })]);
  assert.equal(calls, 1); assert.deepEqual(a.nutrition, b.nutrition);
  await ensureNutrition(null, recipe, { estimate }); assert.equal(calls, 1);
  assert.ok(db.db.prepare('SELECT nutrition_json FROM recipe_nutrition_cache WHERE recipe_key=?').get(nutritionKey(recipe)));
  const changed = { ...recipe, servings: 3 };
  assert.notEqual(nutritionKey(changed), nutritionKey(recipe));
  assert.equal(db.cachedNutrition(changed), null);
});
test('invalid estimation fails without caching fabricated zeros', async () => {
  const recipe = { ...chicken(), title: 'Неполный расчёт', ingredients: [{ name: 'неизвестный продукт' }] };
  await assert.rejects(ensureNutrition(null, recipe, { estimate: async () => ({ calories: 500 }) }), { status: 502 });
  assert.equal(db.cachedNutrition(recipe), null);
});
test('Russian limits parse independently of dish, exclude violating recipes and survive request patches', () => {
  const request = parseMealRequest('Курица до 500 ккал, не меньше 30 г белка, жира не более 20 г');
  assert.deepEqual(request.nutritionLimits, { calories: { min: null, max: 500 }, protein: { min: 30, max: null }, fat: { min: null, max: 20 } });
  assert.ok(matchesNutritionLimits(chicken(), request.nutritionLimits));
  assert.equal(matchesNutritionLimits({ ...chicken(), nutrition: { ...n, basis: 'serving' } }, request.nutritionLimits), false);
  assert.equal(matchesNutritionLimits({ title: 'Неизвестно' }, request.nutritionLimits), false);
  assert.equal(mergeMealRequests(request, parseMealRequest('до 600 ккал')).nutritionLimits.calories.max, 600);
  assert.equal(normalizeMealRequest({ text: 'до 500 ккал', nutritionLimits: { calories: { max: 600 } } }).nutritionLimits.calories.max, 500);
  assert.throws(() => parseNutritionLimits('до 100 ккал на 100 г'), { status: 400 });
});
test('ready recipe selection respects numeric nutrition limits', async () => {
  const owner = user();
  const recipe = db.createRecipe(owner.id, chicken());
  const result = await resolveRecipeRequest(owner.id, 'Экспериментальный суп до 500 ккал, от 30 г белка', {
    validate: async ({ recipes }) => recipes.map(r => ({ recipe: r, accepted: r.id === recipe.id, preferredScore: 100 })), generate: assert.fail
  });
  assert.equal(result.kind, 'existing'); assert.equal(result.recipe.id, recipe.id);
});
test('generation retries nutrition violation; caches and saves only matching candidate', async () => {
  const owner = user(); let calls = 0;
  const validate = async ({ recipes }) => recipes.map(r => ({ recipe: r, accepted: r.title === chicken().title, preferredScore: 100 }));
  const result = await resolveRecipeRequest(owner.id, 'Экспериментальный суп до 500 ккал', { validate, generate: async input => {
    calls++; assert.equal(input.mealRequest.nutritionLimits.calories.max, 500);
    if (calls === 2) assert.ok(input.validationFeedback.length);
    return { ...chicken(), nutrition: { ...n, calories: calls === 1 ? 700 : 400, basis: 'serving', source: 'calculated' } };
  } });
  assert.equal(calls, 2); assert.equal(result.suggestion.recipe.nutrition.calories, 400);
  assert.equal(db.saveRecipeSuggestion(owner.id, result.suggestion.id).nutrition.calories, 400);
});
test('import asks provider for mandatory source nutrition and converts returned totals', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.ok(body.text.format.schema.required.includes('nutrition'));
    assert.match(body.instructions, /Если все четыре значения есть в источнике/);
    return new Response(JSON.stringify({ status: 'completed', output_text: JSON.stringify({ ...chicken(), nutrition: n }) }), { status: 200 });
  };
  try { const recipe = await normalizeRecipe({ userId: user().id, text: 'Суп, КБЖУ всего блюда', sourceName: 'Текст' }); assert.equal(recipe.nutrition.calories, 400); assert.equal(recipe.nutrition.source, 'recipe'); }
  finally { globalThis.fetch = original; }
});
