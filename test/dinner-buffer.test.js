import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
process.env.DATABASE_PATH = path.resolve('data', `dinner-buffer-${process.pid}.sqlite`);
process.env.OPENAI_API_KEY = 'test-key';
process.env.OPENAI_TEXT_MODEL = 'test-model';
process.env.TELEGRAM_BOT_TOKEN = 'test-bot-token';
process.env.DINNER_LLM_ENABLED = 'true';
process.env.DINNER_IMAGES_ENABLED = 'false';
const { db, upsertTelegramUser, listRecipes, allowUser } = await import('../src/db.js');
const { startDinner, recommendDinner, nextDinner, prefetchDinner, confirmDinnerIntake, updateDinnerProfile, getDinnerRecipe, decideDinner, finishDinner } = await import('../src/dinner-service.js');
const { SEED_RECIPES, hasExcludedIngredient, recipeCategories } = await import('../src/dinner.js');
const { listDinnerOptions, setDinnerContext, setDinnerOptionImage } = await import('../src/dinner-store.js');
const { validateGeneratedDinner } = await import('../src/dinner-buffer.js');
const { extractDinnerIntake, generateDinnerRecipes } = await import('../src/openai.js');
const { createServer } = await import('../src/server.js');
const { makeTelegramInitData } = await import('../src/security.js');
const tick = () => new Promise(setImmediate);
const batch = () => ['mince-meatballs','mince-pasta','keema-potato','mince-potato','soboro-don','keftedes'].map((id, i) => ({
  role: ['familiar','quick','variety'][i % 3], discovery: i % 3 === 2 ? 'Необычное блюдо из знакомых продуктов' : null,
  recipe: structuredClone(SEED_RECIPES.find((r) => r.id === `seed:${id}`))
}));
const fixture = (id) => { const user = upsertTelegramUser({ id, first_name: 'Генерация' }); confirmDinnerIntake(user.id, { availableIngredients: ['говяжий фарш','картошка','рис','паста'], householdSize: 4, maxMinutes: 30 }); return user; };
test.after(() => { db.close(); for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(process.env.DATABASE_PATH + suffix); } catch {} } });

test('fresh client gets catalog recipes with existing images and no provider requests', async () => {
  const user = upsertTelegramUser({ id: 620, first_name: 'Fresh catalog' });
  updateDinnerProfile(user.id, { excludedIngredients: ['арахис'], preferredMaxCookingTime: 30, onboardingCompleted: true });
  const before = db.prepare('SELECT count(*) n FROM ai_reservations').get().n;
  let generationCalls = 0;
  const generate = async () => { generationCalls++; throw new Error('catalog must be sufficient'); };
  const started = performance.now();
  const result = await recommendDinner(user.id, startDinner(user.id).sessionId, { generate });
  assert.ok(performance.now() - started < 1000);
  assert.equal(result.recommendations.length, 3);
  assert.equal(result.reserve.length, 3);
  assert.equal(result.preparing, false); assert.equal(result.imagesPending, false);
  assert.equal(result.notice, null);
  for (const option of [...result.recommendations, ...result.reserve]) {
    assert.equal(option.recipe.origin, 'seed');
    assert.equal(option.recipe.dinnerGenerated, undefined);
    assert.ok(fs.existsSync(path.join('public', option.recipe.thumbnailUrl)));
    assert.equal(hasExcludedIngredient(option.recipe, ['арахис']), false);
  }
  assert.equal(generationCalls, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM ai_reservations').get().n, before);
  const next = await nextDinner(user.id, result.recommendations.map(o => o.id), { generate });
  assert.deepEqual(next.recommendations.map(o => o.id), result.reserve.map(o => o.id));
});

test('all house recipes have a complete recipe and a reusable local JPEG', () => {
  assert.ok(SEED_RECIPES.length >= 56);
  assert.equal(new Set(SEED_RECIPES.map((recipe) => recipe.id)).size, SEED_RECIPES.length);
  for (const recipe of SEED_RECIPES) {
    assert.ok(recipe.ingredients.length >= 2);
    assert.ok(recipe.steps.length >= 4);
    assert.ok(Number.isInteger(recipe.prepMinutes) && recipe.prepMinutes >= 5);
    assert.ok(Number.isInteger(recipe.cookMinutes) && recipe.cookMinutes >= 5);
    assert.ok(recipe.mainIngredients.length >= 1);
    const bytes = fs.readFileSync(path.join('public', recipe.thumbnailUrl));
    assert.equal(bytes.readUInt16BE(0), 0xffd8);
  }
});

test('house catalog covers families, fish, meatless meals, soups and varied discoveries', () => {
  const text = (recipe) => [recipe.title, ...recipe.tags, ...recipe.ingredients.map((item) => item.name)].join(' ');
  const meat = /куриц|индейк|говяд|свинин|фарш|рыб|тунц|минта/iu;
  assert.ok(SEED_RECIPES.filter((recipe) => recipe.servings >= 4).length >= 24);
  assert.ok(SEED_RECIPES.filter((recipe) => /рыб|тунц|минта/iu.test(text(recipe))).length >= 6);
  assert.ok(SEED_RECIPES.filter((recipe) => !meat.test(text(recipe))).length >= 14);
  assert.ok(SEED_RECIPES.filter((recipe) => /суп|борщ|щи\b|рассольник/iu.test(text(recipe))).length >= 8);
  const discoveries = SEED_RECIPES.filter((recipe) => recipe.discovery);
  assert.ok(discoveries.length >= 8);
  assert.ok(discoveries.some((recipe) => !/говяд|говяж/iu.test(text(recipe))));
});

test('visible trio returns before reserve generation and reserve promotion does not wait for refill', async () => {
  const user = fixture(602), session = startDinner(user.id);
  let calls = 0, resolveRefill;
  const generate = async ({ count, profile, pantry, rejectedTitles }) => {
    calls++; assert.equal(profile.householdSize, 4); assert.equal(pantry.length, 4);
    assert.equal(count, 3);
    if (calls === 1) return { recipes: batch().slice(0,3) };
    assert.equal(rejectedTitles.length, calls === 2 ? 3 : 6);
    return new Promise((resolve) => { resolveRefill = resolve; });
  };
  const first = await recommendDinner(user.id, session.sessionId, { catalogFirst: false, generate });
  assert.equal(first.recommendations.length, 3); assert.equal(first.reserve.length, 0);
  assert.equal(first.preparing, true); assert.equal(calls, 2);
  assert.equal(first.imagesPending, false);
  assert.ok([...first.recommendations,...first.reserve].every((o) => o.method === 'generated' && o.recipe.id.startsWith('dinner:')));
  assert.equal(listRecipes(user.id).length, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM dinner_events WHERE user_id=? AND event='recommendation_shown'").get(user.id).n, 3);
  const reopened = await recommendDinner(user.id, startDinner(user.id).sessionId, { catalogFirst: false, generate });
  assert.deepEqual(reopened.recommendations.map((o) => o.id), first.recommendations.map((o) => o.id)); assert.equal(calls, 2);
  resolveRefill({ recipes: batch().slice(3) }); await tick();
  const prepared = prefetchDinner(user.id, session.sessionId, { catalogFirst: false, generate });
  assert.equal(prepared.reserve.length, 3);
  const ids = first.recommendations.map((o) => o.id);
  const next = await nextDinner(user.id, ids, { catalogFirst: false, generate });
  assert.deepEqual(next.recommendations.map((o) => o.id), prepared.reserve.map((o) => o.id));
  assert.equal(next.preparing, true); assert.equal(next.reserve.length, 0); assert.equal(calls, 3);
  const replay = await nextDinner(user.id, ids, { catalogFirst: false, generate });
  assert.deepEqual(replay.recommendations.map((o) => o.id), next.recommendations.map((o) => o.id)); assert.equal(replay.retryCount, 1); assert.equal(calls, 3);
  const refill = batch().slice(0,3); ['Рагу мясника','Паста с мясной крошкой','Мясные шарики с пряным соусом'].forEach((title, i) => { refill[i].recipe.title = title; });
  resolveRefill({ recipes: refill }); await tick();
  const ready = prefetchDinner(user.id, session.sessionId, { catalogFirst: false, generate });
  assert.equal(ready.reserve.length, 3); assert.equal(ready.preparing, false);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM dinner_events WHERE user_id=? AND event='recommendation_shown'").get(user.id).n, 6);
  const selected = next.recommendation;
  assert.equal(getDinnerRecipe(user.id, selected.recipe.id).steps.length, 4);
  const stranger = fixture(603); assert.equal(getDinnerRecipe(stranger.id, selected.recipe.id), null);
  await assert.rejects(nextDinner(stranger.id, next.recommendations.map((o) => o.id), { catalogFirst: false, generate }), { status: 404 });
  decideDinner(user.id, selected.id, 'accepted'); finishDinner(user.id, selected.id);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM dinner_events WHERE recommendation_id=? AND event='recipe_cooked'").get(selected.id).n, 1);
});

test('provider failure returns six deterministic recipes without a retry storm', async () => {
  const user = fixture(604); let calls = 0;
  const generate = async () => { calls++; throw new Error('provider down'); };
  const session = startDinner(user.id), first = await recommendDinner(user.id, session.sessionId, { catalogFirst: false, generate });
  assert.equal(first.recommendations.length, 3); assert.equal(first.reserve.length, 3);
  assert.ok([...first.recommendations,...first.reserve].every((o) => o.method === 'deterministic'));
  assert.match(first.notice, /готовые рецепты/);
  const next = await nextDinner(user.id, first.recommendations.map((o) => o.id), { catalogFirst: false, generate });
  assert.deepEqual(next.recommendations.map((o) => o.id), first.reserve.map((o) => o.id));
  prefetchDinner(user.id, session.sessionId, { catalogFirst: false, generate }); assert.equal(calls, 1);
});

test('semantic dinner request never falls back to an unjudged recipe', async () => {
  const user = fixture(612), mealRequest = {
    text: 'удиви меня блюдом из фарша', kind: 'open', confidence: 'high', dish: '', requiredIngredients: ['говяжий фарш'],
    semanticCriteria: [{ description: 'неповседневное блюдо, которое удивит', importance: 'required' }], excludedIngredients: [], methods: [], maxMinutes: 30, servings: 4
  };
  setDinnerContext(user.id, ['говяжий фарш'], [], mealRequest);
  let validations = 0;
  const result = await recommendDinner(user.id, startDinner(user.id).sessionId, {
    catalogFirst: false, generate: async () => ({ recipes: batch().slice(0, 3) }),
    validate: async ({ recipes }) => { validations++; return recipes.map((recipe) => ({ recipe, accepted: false, preferredScore: 0, failedCriteria: ['Повседневное блюдо'] })); }
  });
  assert.ok(validations >= 1);
  assert.equal(result.recommendations.length, 0);
  assert.match(result.message, /соответствует всем условиям/);
  assert.equal(listDinnerOptions(user.id, result.sessionId).filter((option) => option.method === 'deterministic' && option.state !== 'discarded').length, 0);
});

test('concurrent initial requests generate once and prepared recipes survive a new process', async () => {
  const user = fixture(608), session = startDinner(user.id); let calls = 0, resolve;
  const generate = async () => { calls++; return new Promise((done) => { resolve = done; }); };
  const a = recommendDinner(user.id, session.sessionId, { catalogFirst: false, generate });
  const b = recommendDinner(user.id, session.sessionId, { catalogFirst: false, generate });
  assert.equal(calls, 1); resolve({ recipes: batch() });
  const [first, second] = await Promise.all([a,b]);
  assert.deepEqual(first.recommendations.map((o) => o.id), second.recommendations.map((o) => o.id));
  assert.equal(calls, 2); resolve({ recipes: batch().slice(3) }); await tick();
  const child = spawnSync(process.execPath, ['--input-type=module','-e', `
    import {recommendDinner} from './src/dinner-service.js';
    let called=false; const r=await recommendDinner(${JSON.stringify(user.id)},${JSON.stringify(session.sessionId)},{catalogFirst:false,generate:async()=>{called=true;throw new Error('must use stored recipes');}});
    console.log(JSON.stringify({called,ids:r.recommendations.map(o=>o.id),reserve:r.reserve.length}));
  `], { encoding: 'utf8', env: process.env });
  assert.equal(child.status, 0, child.stderr);
  const stored = JSON.parse(child.stdout.trim());
  assert.equal(stored.called, false); assert.equal(stored.reserve, 3); assert.deepEqual(stored.ids, first.recommendations.map((o) => o.id));
});

test('generated validation rejects allergies, missing base, invalid amounts, slow and hidden ingredients', () => {
  const context = { pantry: ['говяжий фарш','картошка','рис','паста'], profile: { householdSize: 4, preferredMaxCookingTime: 30, excludedIngredients: [] } };
  const item = batch()[0]; assert.ok(validateGeneratedDinner(item, context));
  assert.equal(validateGeneratedDinner(item, { ...context, profile: { ...context.profile, excludedIngredients: ['говядина'] } }), null);
  assert.equal(validateGeneratedDinner(item, { ...context, pantry: ['курица'] }), null);
  const invalid = structuredClone(item); invalid.recipe.ingredients[0].quantity = null; assert.equal(validateGeneratedDinner(invalid, context), null);
  const slow = structuredClone(item); slow.recipe.cookMinutes = 90; assert.equal(validateGeneratedDinner(slow, context), null);
  const hidden = structuredClone(item); hidden.recipe.steps[0].text += ' Добавьте молоко.';
  assert.equal(validateGeneratedDinner(hidden, { ...context, profile: { ...context.profile, excludedIngredients: ['молоко'] } }), null);
  const hiddenComment = structuredClone(item); hiddenComment.recipe.ingredients[0].comment = 'Смешать с молоком';
  assert.equal(validateGeneratedDinner(hiddenComment, { ...context, profile: { ...context.profile, excludedIngredients: ['молоко'] } }), null);
  const unusualContext = { ...context, mealRequest: { kind: 'open', semanticCriteria: [{ description: 'необычное блюдо', importance: 'required' }], requiredIngredients: [], excludedIngredients: [], methods: [] } };
  assert.ok(validateGeneratedDinner(item, unusualContext), 'structural validation must not decide a semantic criterion');
  const unusual = structuredClone(item); unusual.discovery = 'Узнаваемое региональное блюдо с непривычной подачей';
  assert.ok(validateGeneratedDinner(unusual, unusualContext));
});

test('full generated detail is private and its generated illustration is served from the stored bytes', async () => {
  const user = fixture(610); allowUser(user.id);
  const result = await recommendDinner(user.id, startDinner(user.id).sessionId, { catalogFirst: false, generate: async () => ({ recipes: batch() }) });
  const selected = result.recommendation, jpeg = Buffer.from([0xff,0xd8,0xff,0x01,0xff,0xd9]);
  setDinnerOptionImage(selected.id, 'ready', { mime: 'image/jpeg', bytes: jpeg });
  const server = createServer(); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { authorization: `tma ${makeTelegramInitData({ id: 610, first_name: 'Генерация' }, process.env.TELEGRAM_BOT_TOKEN)}` };
  try {
    const url = base + '/api/dinner/recipes/' + encodeURIComponent(selected.recipe.id);
    assert.equal((await fetch(url)).status, 401);
    const response = await fetch(url, { headers }); assert.equal(response.status, 200);
    const detail = await response.json();
    assert.equal(detail.steps.length, selected.recipe.steps.length);
    assert.equal(detail.ingredients.length, selected.recipe.ingredients.length);
    assert.equal(detail.thumbnailUrl, `/dinner-images/${selected.id}`);
    const image = await fetch(base + detail.thumbnailUrl);
    assert.equal(image.headers.get('content-type'), 'image/jpeg');
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), jpeg);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('raw rice needs realistic cooking instructions and ingredient preparation is preserved', () => {
  const context = { pantry: ['говяжий фарш','рис'], profile: { householdSize: 4, preferredMaxCookingTime: 30, excludedIngredients: [] } };
  const item = batch()[4];
  item.recipe.ingredients[0].comment = 'разделить на небольшие кусочки';
  item.recipe.steps[0].text = 'Промойте рис и варите в воде 9–10 минут до готовности.';
  assert.equal(validateGeneratedDinner(item, context), null);
  item.recipe.steps[0].text = 'Промойте рис и варите в воде 15–20 минут до готовности.';
  assert.equal(validateGeneratedDinner(item, context).recipe.ingredients[0].comment, 'разделить на небольшие кусочки');
});

test('warming a buffer does not count as opening or showing it', async () => {
  const user = fixture(609), session = startDinner(user.id, { prefetchOnly: true });
  prefetchDinner(user.id, session.sessionId, { catalogFirst: false, generate: async () => ({ recipes: batch() }) }); await tick();
  assert.equal(listDinnerOptions(user.id, session.sessionId).filter((o) => o.state === 'ready').length, 3);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM dinner_events WHERE user_id=? AND event IN ('recommendation_shown','dinner_recommendation_opened')").get(user.id).n, 0);
  const opened = startDinner(user.id);
  assert.equal(opened.sessionId, session.sessionId);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM dinner_events WHERE user_id=? AND event='dinner_recommendation_opened'").get(user.id).n, 1);
});

test('duplicate recipes are filtered and changed hard constraints invalidate the reserve', async () => {
  const user = fixture(605), session = startDinner(user.id);
  const generate = async () => ({ recipes: [batch()[0], batch()[0], ...batch().slice(2)] });
  const first = await recommendDinner(user.id, session.sessionId, { catalogFirst: false, generate });
  assert.equal(new Set([...first.recommendations,...first.reserve].map((o) => o.recipe.title)).size, 6);
  updateDinnerProfile(user.id, { excludedIngredients: ['говядина'] });
  const safe = await recommendDinner(user.id, session.sessionId, { catalogFirst: false, generate }); await tick();
  assert.ok([...safe.recommendations,...safe.reserve].every((o) => !hasExcludedIngredient(o.recipe, ['говядина'])));
  assert.ok(listDinnerOptions(user.id, session.sessionId).some((o) => o.state === 'discarded'));
});

test('a request for today is mandatory for every visible dinner option', async () => {
  const user = upsertTelegramUser({ id: 607, first_name: 'Запрос на сегодня' });
  updateDinnerProfile(user.id, { householdSize: 2, onboardingCompleted: true });
  setDinnerContext(user.id, [], ['asian', 'rice']);
  const session = startDinner(user.id);
  const generationCounts = [], generatedFor = [];
  const exact = batch().slice(0, 3).map((item, index) => ({
    ...item,
    recipe: {
      ...item.recipe,
      title: `Азиатский рис ${index + 1}`,
      tags: [...(item.recipe.tags || []), 'азиатское'],
      ingredients: [...item.recipe.ingredients, { name: 'рис', raw: 'рис', quantity: 100, unit: 'г', comment: null }]
    }
  }));
  const generate = async (input) => {
    generationCounts.push(input.count);
    generatedFor.push(input.requestedCategories);
    return generationCounts.length === 1 ? { recipes: [exact[0], ...batch().slice(1, 3)] } : { recipes: exact.slice(1) };
  };
  const dinner = await recommendDinner(user.id, session.sessionId, { generate });
  assert.deepEqual(generationCounts.slice(0, 2), [3, 2]);
  assert.deepEqual(generatedFor.slice(0, 2), [['asian', 'rice'], ['asian', 'rice']]);
  assert.equal(dinner.recommendations.length, 3);
  assert.ok(dinner.recommendations.every(({ recipe }) => {
    const categories = recipeCategories(recipe);
    return categories.includes('asian') && categories.includes('rice');
  }));
});

test('generation abstraction sends constraints and six recipes using strict JSON', async () => {
  const user = fixture(606), original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    const body = JSON.parse(init.body); assert.equal(body.model, 'test-model'); assert.equal(body.text.format.strict, true); assert.equal(body.text.format.name, 'dinner_generation');
    const input = JSON.parse(body.input[0].content[0].text); assert.equal(input.count, 6); assert.deepEqual(input.profile.excludedIngredients, ['орехи']);
    assert.deepEqual(input.profile.preferredCategories, { fish: 1, pasta: -1 });
    assert.deepEqual(input.requestedCategories, ['asian', 'rice']);
    assert.match(body.instructions, /КАЖДЫЙ рецепт должен одновременно соответствовать всем перечисленным категориям/);
    assert.match(body.instructions, /pizza означает пиццу, italian — итальянскую кухню, georgian — грузинскую/);
    if (input.pantry.length) assert.match(body.instructions, /Используй названные продукты как основу/);
    else { assert.match(body.instructions, /Продукты дома не указаны/); assert.doesNotMatch(body.instructions, /привычное из имеющихся продуктов/); }
    return new Response(JSON.stringify({ status: 'completed', output_text: JSON.stringify({ recipes: batch() }), usage: { input_tokens: 100, output_tokens: 200 } }), { status: 200 });
  };
  try {
    for (const pantry of [['фарш'], []]) {
      const result = await generateDinnerRecipes({ userId: user.id, count: 6, profile: { excludedIngredients: ['орехи'], preferredCategories: { fish: 1, pasta: -1 } }, pantry, requestedCategories: ['asian', 'rice'], signals: {}, recentRecipes: [], rejectedTitles: [] });
      assert.equal(result.recipes.length, 6);
    }
  }
  finally { globalThis.fetch = original; }
});

test('AI dinner intake extracts explicit likes and dislikes separately from exclusions', async () => {
  const user = upsertTelegramUser({ id: 621, first_name: 'Вкусы голосом' }), original = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.text.format.name, 'dinner_intake');
    assert.ok(body.text.format.schema.required.includes('likedCategories'));
    assert.ok(body.text.format.schema.required.includes('dislikedCategories'));
    assert.ok(body.text.format.schema.required.includes('requestedCategories'));
    assert.ok(body.text.format.schema.required.includes('replaceRequestedCategories'));
    assert.ok(body.text.format.schema.properties.mealRequest.required.includes('kind'));
    assert.ok(body.text.format.schema.properties.mealRequest.required.includes('confidence'));
    assert.ok(body.text.format.schema.properties.mealRequest.required.includes('semanticCriteria'));
    assert.deepEqual(body.text.format.schema.properties.mealRequest.properties.kind.enum, ['exact','open']);
    assert.deepEqual(body.text.format.schema.properties.mealRequest.properties.semanticCriteria.items.properties.importance.enum, ['required','preferred']);
    assert.match(body.instructions, /semanticCriteria/u);
    const categories = body.text.format.schema.properties.likedCategories.items.enum;
    for (const key of ['pizza','georgian','italian','european','asian']) assert.ok(categories.includes(key), key);
    assert.match(body.instructions, /«Не люблю» — dislikedCategories, а не excludedIngredients/);
    assert.match(body.instructions, /«Итальянская кухня» даёт italian.*«Грузинская» даёт georgian/u);
    return new Response(JSON.stringify({ status: 'completed', output_text: JSON.stringify({
      availableIngredients: [], excludedIngredients: ['орехи'], removedIngredients: [], replaceIngredients: false,
      householdSize: 3, hasChildren: true, maxMinutes: 30, likedCategories: ['pasta','rice','chicken'], dislikedCategories: ['fish'],
      requestedCategories: ['asian','rice'], replaceRequestedCategories: true
    }), usage: { input_tokens: 20, output_tokens: 30 } }), { status: 200 });
  };
  try {
    const result = await extractDinnerIntake({ userId: user.id, transcript: 'Люблю пасту, рис и курицу, не люблю рыбу. Сегодня хочу азиатское с рисом. Аллергия на орехи.', profileOnly: true });
    assert.deepEqual(result.likedCategories, ['pasta','rice','chicken']);
    assert.deepEqual(result.dislikedCategories, ['fish']);
    assert.deepEqual(result.requestedCategories, ['asian','rice']);
    assert.equal(result.replaceRequestedCategories, true);
    assert.deepEqual(result.excludedIngredients, ['орехи']);
  } finally { globalThis.fetch = original; }
});
