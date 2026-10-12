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
const { db, upsertTelegramUser: rawUpsertTelegramUser, listRecipes, getRecipeImage, allowUser } = await import('../src/db.js');
const { startDinner, recommendDinner, nextDinner, prefetchDinner, confirmDinnerIntake, updateDinnerProfile, getDinnerRecipe, decideDinner, finishDinner, dinnerContext, replaceDinner } = await import('../src/dinner-service.js');
const { SEED_RECIPES, hasExcludedIngredient, recipeCategories } = await import('../src/dinner.js');
const { backfillAcceptedDinnerRecipes, listDinnerOptions, setDinnerContext, setDinnerOptionImage, insertDinnerOption, invalidateDinnerBuffer, promoteDinnerOptions } = await import('../src/dinner-store.js');
const { validateGeneratedDinner, rotateDinnerCandidates, dinnerContextKey } = await import('../src/dinner-buffer.js');
const { extractDinnerIntake, generateDinnerRecipes } = await import('../src/openai.js');
const { startTrial } = await import('../src/subscriptions.js');
const upsertTelegramUser = (telegram) => { const user = rawUpsertTelegramUser(telegram); startTrial(user.id); return user; };
const { createServer } = await import('../src/server.js');
const { makeTelegramInitData } = await import('../src/security.js');
const tick = () => new Promise(setImmediate);
const batch = () => ['mince-meatballs','mince-pasta','keema-potato','mince-potato','soboro-don','keftedes'].map((id, i) => ({
  role: ['familiar','quick','variety'][i % 3], discovery: i % 3 === 2 ? 'Необычное блюдо из знакомых продуктов' : null,
  recipe: structuredClone(SEED_RECIPES.find((r) => r.id === `seed:${id}`))
}));
const fixture = (id) => { const user = upsertTelegramUser({ id, first_name: 'Генерация' }); confirmDinnerIntake(user.id, { availableIngredients: ['говяжий фарш','картошка','рис','паста'], householdSize: 4, maxMinutes: 30 }); return user; };

test('rice-only generation receives rejection feedback and supplies a replacement without unavailable protein', async () => {
  const user = upsertTelegramUser({ id: 989621, first_name: 'Rice replacement' });
  confirmDinnerIntake(user.id, { availableIngredients: ['рис'], householdSize: 2, maxMinutes: 60 });
  let calls = 0;
  const generate = async ({ validationFailures, roles }) => {
    calls++;
    if (calls === 1) return { recipes: [batch()[0]] };
    if (calls === 2) {
      assert.ok(validationFailures.length);
      assert.ok(validationFailures[0].missingMainIngredients.length);
      assert.equal(validationFailures[0].maxShoppingIngredients, 5);
    }
    return { recipes: roles.map((role, index) => ({ role, discovery: 'Другой способ приготовления доступного риса', recipe: {
      ...structuredClone(SEED_RECIPES.find(recipe => recipe.id === 'seed:rice-carrot-onion')),
      title: (calls === 2 ? ['Рисовые оладьи', 'Овощной плов', 'Рисовая запеканка'] : ['Рисовый суп', 'Рисовые котлеты', 'Рис с томатами'])[index]
    } })) };
  };
  const session = startDinner(user.id);
  const options = { generate, images: false, catalogFirst: false };
  const initial = await recommendDinner(user.id, session.sessionId, options);
  const target = initial.recommendations[0];
  const result = await replaceDinner(user.id, target.id, 'not_today', options);
  assert.equal(calls, 3);
  assert.notEqual(result.recommendations[0].id, target.id);
  assert.equal(result.recommendations[1].id, initial.recommendations[1].id);
});
test.after(() => { db.close(); for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(process.env.DATABASE_PATH + suffix); } catch {} } });

test('fresh client gets catalog recipes with local images and no provider requests', async () => {
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
    if (option.recipe.thumbnailUrl) assert.ok(fs.existsSync(path.join('public', option.recipe.thumbnailUrl)));
    else assert.equal(option.recipe.imageGenerated, false);
    assert.equal(hasExcludedIngredient(option.recipe, ['арахис']), false);
  }
  assert.equal(generationCalls, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM ai_reservations').get().n, before);
  const next = await nextDinner(user.id, result.recommendations.map(o => o.id), { generate });
  assert.deepEqual(next.recommendations.map(o => o.id), result.reserve.map(o => o.id));
  const accepted = decideDinner(user.id, next.recommendation.id, 'accepted');
  assert.equal(accepted.savedRecipe.title, next.recommendation.recipe.title);
  assert.equal(accepted.savedRecipe.thumbnailUrl, next.recommendation.recipe.thumbnailUrl);
  assert.equal(accepted.savedRecipe.sourceKey, `dinner-choice:${next.recommendation.recipe.id}`);
  assert.equal(listRecipes(user.id).length, 1);
});

test('all house recipes are complete and have a reusable local JPEG', () => {
  assert.ok(SEED_RECIPES.length >= 56);
  assert.equal(new Set(SEED_RECIPES.map((recipe) => recipe.id)).size, SEED_RECIPES.length);
  for (const recipe of SEED_RECIPES) {
    assert.ok(recipe.ingredients.length >= 2);
    assert.ok(recipe.steps.length >= 4);
    assert.ok(Number.isInteger(recipe.prepMinutes) && recipe.prepMinutes >= 5);
    assert.ok(Number.isInteger(recipe.cookMinutes) && recipe.cookMinutes >= 5);
    assert.ok(recipe.mainIngredients.length >= 1);
    assert.ok(recipe.thumbnailUrl);
    const bytes = fs.readFileSync(path.join('public', recipe.thumbnailUrl));
    assert.equal(bytes.readUInt16BE(0), 0xffd8);
  }
});

test('legacy saved recipes, shares and buffered cards receive catalog photos without changing stored content', async () => {
  const { saveDinnerRecipe, getRecipe, createDinnerRecipeShare, getSharedRecipe } = await import('../src/db.js');
  const { getDinnerOption } = await import('../src/dinner-store.js');
  const { withSeedImage } = await import('../src/dinner-seeds.js');
  const user = fixture(989625), { sessionId } = startDinner(user.id);
  const original = SEED_RECIPES.find(recipe => recipe.id === 'seed:chicken-apple-thyme');
  const legacy = { ...structuredClone(original), thumbnailUrl: null, imageGenerated: false, notes: 'Моя заметка', title: 'Мой вариант курицы' };
  const saved = saveDinnerRecipe(user.id, legacy.id, legacy);
  assert.equal(saved.thumbnailUrl, original.thumbnailUrl);
  assert.equal(getRecipe(user.id, saved.id).title, legacy.title);
  assert.equal(getRecipe(user.id, saved.id).notes, legacy.notes);
  assert.equal(listRecipes(user.id)[0].thumbnailUrl, original.thumbnailUrl);
  assert.equal(db.prepare('SELECT thumbnail_url FROM recipes WHERE id=?').get(saved.id).thumbnail_url, null);
  insertDinnerOption(user.id, sessionId, { id: 'legacy-catalog-photo', recipe: legacy }, 'legacy-catalog-photo');
  assert.equal(getDinnerOption(user.id, 'legacy-catalog-photo').recipe.thumbnailUrl, original.thumbnailUrl);
  const share = createDinnerRecipeShare(user.id, legacy.id, legacy);
  assert.equal(getSharedRecipe(share).thumbnailUrl, original.thumbnailUrl);
  assert.equal(getSharedRecipe(share).title, legacy.title);
  assert.equal(legacy.thumbnailUrl, null);
  const customUrl = '/recipe-images/custom-photo';
  db.prepare('UPDATE recipes SET thumbnail_url=? WHERE id=?').run(customUrl, saved.id);
  assert.equal(getRecipe(user.id, saved.id).thumbnailUrl, customUrl);
  assert.equal(withSeedImage({ ...legacy, thumbnailUrl: customUrl }).thumbnailUrl, customUrl);
  assert.equal(withSeedImage({ id: 'seed:unknown', thumbnailUrl: null }).thumbnailUrl, null);
  assert.equal(withSeedImage({ id: 'generated:chicken-apple-thyme', thumbnailUrl: null }).thumbnailUrl, null);
});

test('polling completes an existing pair from ready recipes once and keeps both cards in place', async () => {
  const user = fixture(640), { sessionId } = startDinner(user.id);
  invalidateDinnerBuffer(user.id, sessionId, dinnerContextKey(dinnerContext(user.id, sessionId)));
  const source = batch();
  const roles = ['familiar', 'variety', 'familiar', 'quick', 'quick', 'variety'];
  const options = source.map((item, index) => ({ ...item, id: `pair-${index}`, role: roles[index], method: 'generated', categories: recipeCategories(item.recipe) }));
  for (const option of options) insertDinnerOption(user.id, sessionId, option, option.recipe.title);
  promoteDinnerOptions(user.id, sessionId, options.slice(0, 2).map(option => option.id));
  const generate = async () => assert.fail('ready reserve is sufficient');
  const result = prefetchDinner(user.id, sessionId, { generate, images: false });
  assert.deepEqual(result.recommendations.map(option => option.id), ['pair-0', 'pair-1', 'pair-3']);
  assert.equal(result.reserve.length, 3);
  const repeated = await Promise.all([recommendDinner(user.id, sessionId, { generate }), recommendDinner(user.id, sessionId, { generate })]);
  for (const response of repeated) assert.deepEqual(response.recommendations.map(option => option.id), result.recommendations.map(option => option.id));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM dinner_events WHERE session_id=? AND event='recommendation_shown'").get(sessionId).n, 3);
  decideDinner(user.id, result.recommendation.id, 'accepted');
  promoteDinnerOptions(user.id, sessionId, result.reserve.map(option => option.id), { complete: true });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM dinner_events WHERE session_id=? AND event='recommendation_shown'").get(sessionId).n, 3);
});

test('duplicate third candidate is replaced before returning the visible trio', async () => {
  const user = fixture(642), { sessionId } = startDinner(user.id);
  const requests = [];
  const source = batch();
  const generate = async input => {
    requests.push(input);
    if (requests.length === 1) return { recipes: [source[0], source[1], { ...source[0], role: 'variety', discovery: 'Другая подача знакомого блюда' }] };
    if (requests.length === 2) return { recipes: [source[2]] };
    return { recipes: [] };
  };
  const result = await recommendDinner(user.id, sessionId, { catalogFirst: false, generate, images: false });
  assert.equal(result.recommendations.length, 3);
  assert.deepEqual(result.recommendations.slice(0, 2).map(item => item.recipe.title), source.slice(0, 2).map(item => item.recipe.title));
  assert.equal(requests[0].count, 3);
  assert.equal(requests[1].count, 1);
  assert.ok(requests[1].rejectedTitles.includes(source[0].recipe.title));
  const event = db.prepare("SELECT detail_json FROM dinner_events WHERE session_id=? AND event='dinner_buffer_filled' ORDER BY created_at LIMIT 1").get(sessionId);
  const detail = JSON.parse(event.detail_json);
  assert.equal(detail.attempts, 2);
  assert.deepEqual(detail.filteredCandidates, [{ title: source[0].recipe.title, reason: 'duplicate' }]);
  await tick();
});

test('generation completes an existing pair without replacing either shown card', async () => {
  const user = fixture(643), { sessionId } = startDinner(user.id);
  invalidateDinnerBuffer(user.id, sessionId, dinnerContextKey(dinnerContext(user.id, sessionId)));
  const source = batch();
  for (let i = 0; i < 2; i++) insertDinnerOption(user.id, sessionId, { ...source[i], id: `existing-${i}`, method: 'generated' }, source[i].recipe.title);
  promoteDinnerOptions(user.id, sessionId, ['existing-0', 'existing-1']);
  const requests = [];
  prefetchDinner(user.id, sessionId, { catalogFirst: false, images: false, generate: async input => { requests.push(input); return { recipes: [source[2]] }; } });
  await tick();
  const result = await recommendDinner(user.id, sessionId, { catalogFirst: false, images: false, generate: async () => ({ recipes: [] }) });
  assert.equal(requests[0].count, 1);
  assert.deepEqual(result.recommendations.slice(0, 2).map(item => item.id), ['existing-0', 'existing-1']);
  assert.equal(result.recommendations.length, 3);
  await tick();
});

test('completion leaves the single first free recipe unchanged', () => {
  const user = fixture(641), { sessionId } = startDinner(user.id);
  const options = batch().slice(0, 3).map((item, index) => ({ ...item, id: `free-${index}`, method: index ? 'generated' : 'first_recipe', categories: recipeCategories(item.recipe) }));
  for (const option of options) insertDinnerOption(user.id, sessionId, option, option.recipe.title);
  promoteDinnerOptions(user.id, sessionId, [options[0].id]);
  assert.deepEqual(promoteDinnerOptions(user.id, sessionId, options.slice(1).map(option => option.id), { complete: true }).map(option => option.id), ['free-0']);
});

test('saved and catalog copies count as one dish before rotation fills a trio', () => {
  const recipes = batch().slice(0, 3).map(item => item.recipe);
  const saved = { ...recipes[0], id: 'saved-copy', userSaved: true };
  const ranked = [saved, ...recipes].map((recipe, index) => ({ recipe, score: 100 - index }));
  const shown = [{ recipe: recipes[2], createdAt: new Date().toISOString() }];
  assert.deepEqual(rotateDinnerCandidates(ranked, shown).map(item => item.recipe.id), [saved.id, recipes[1].id, recipes[2].id]);
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
  const accepted = decideDinner(user.id, selected.id, 'accepted');
  assert.equal(accepted.savedRecipe.title, selected.recipe.title);
  assert.equal(accepted.savedRecipe.origin, 'generated');
  assert.equal(accepted.savedRecipe.sourceKey, `dinner-choice:${selected.recipe.id}`);
  assert.equal(listRecipes(user.id).length, 1);
  assert.equal(decideDinner(user.id, selected.id, 'accepted').savedRecipe.id, accepted.savedRecipe.id);
  assert.equal(listRecipes(user.id).length, 1);
  const jpeg = Buffer.from([0xff,0xd8,0xff,0x01,0xff,0xd9]);
  setDinnerOptionImage(selected.id, 'ready', { mime: 'image/jpeg', bytes: jpeg });
  const savedWithImage = listRecipes(user.id)[0];
  assert.match(savedWithImage.thumbnailUrl, /\/recipe-images\//);
  assert.deepEqual(Buffer.from(getRecipeImage(savedWithImage.id).bytes), jpeg);
  db.prepare('DELETE FROM recipes WHERE id=?').run(savedWithImage.id);
  assert.equal(listRecipes(user.id).length, 0);
  assert.ok(backfillAcceptedDinnerRecipes() >= 1);
  assert.equal(listRecipes(user.id).length, 1);
  finishDinner(user.id, selected.id);
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

test('generated dinner accepts absent-food prose while still rejecting positive hidden mentions', () => {
  const item = batch()[0];
  const context = { profile: { householdSize: 4, excludedIngredients: ['соевый соус'], preferredMaxCookingTime: 30 }, pantry: [], requestedCategories: [], feedback: {}, rejected: [], history: [], categorySignals: {} };
  item.recipe.title += ' без соевого соуса';
  item.recipe.ingredients[0].comment = 'без соевого соуса';
  item.recipe.steps[0].text += ' Соевый соус не добавляйте.';
  assert.ok(validateGeneratedDinner(item, context));
  item.recipe.steps[0].text += ' Затем добавьте соевый соус.';
  assert.equal(validateGeneratedDinner(item, context), null);
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
    const shareResponse = await fetch(url + '/share', { method: 'POST', headers, body: '{}' });
    assert.equal(shareResponse.status, 200);
    const share = await shareResponse.json();
    const publicRecipe = await (await fetch(base + share.path.replace('/share/', '/api/shares/'))).json();
    assert.equal(publicRecipe.title, selected.recipe.title);
    assert.equal(publicRecipe.sharedBy, 'Генерация');
    assert.match(publicRecipe.thumbnailUrl, /^\/shared-recipe-images\/[A-Za-z0-9_-]{32}$/);
    const publicImage = await fetch(base + publicRecipe.thumbnailUrl);
    assert.equal(publicImage.status, 200);
    assert.deepEqual(Buffer.from(await publicImage.arrayBuffer()), jpeg);
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
    return { recipes: exact };
  };
  let validations = 0;
  const validate = async ({ recipes, requestedCategories }) => {
    validations++;
    assert.deepEqual(requestedCategories, ['asian', 'rice']);
    return recipes.map((recipe) => {
      const categories = recipeCategories(recipe);
      const accepted = requestedCategories.every((category) => categories.includes(category));
      return { recipe, accepted, preferredScore: accepted ? 100 : 0, failedCriteria: accepted ? [] : ['Не соответствует категории'] };
    });
  };
  const structuralContext = { profile: { householdSize: 2, excludedIngredients: [] }, pantry: [], requestedCategories: ['asian', 'rice'], mealRequest: null, feedback: {}, rejected: [], history: [], recentRecipes: [], library: [], categorySignals: {} };
  assert.ok(validateGeneratedDinner(batch()[1], structuralContext), 'category meaning must not be rejected before semantic validation');
  const dinner = await recommendDinner(user.id, session.sessionId, { generate, validate });
  assert.ok(generationCounts.length >= 1 && generationCounts.every((count) => count === 3));
  assert.ok(generatedFor.every((categories) => JSON.stringify(categories) === JSON.stringify(['asian', 'rice'])));
  assert.ok(validations >= 1);
  assert.equal(dinner.recommendations.length, 3);
  assert.ok(dinner.recommendations.every(({ recipe }) => {
    const categories = recipeCategories(recipe);
    return categories.includes('asian') && categories.includes('rice');
  }));
});

test('generic meat and lentil request produces a complete family trio', async () => {
  const user = upsertTelegramUser({ id: 613, first_name: 'Чечевица и мясо' });
  updateDinnerProfile(user.id, { householdSize: 4, hasChildren: true, onboardingCompleted: true });
  const mealRequest = {
    text: 'что-то с чечевицей и мясом на 4, 2 детей', kind: 'open', confidence: 'high', dish: '',
    requiredIngredients: ['чечевица', 'мясо'], semanticCriteria: [], excludedIngredients: [], methods: [], maxMinutes: null, servings: 4
  };
  setDinnerContext(user.id, [], ['meat'], mealRequest);
  const titles = ['Рагу из чечевицы с мясом', 'Чечевичный суп с мясом', 'Котлеты с чечевицей'];
  const generated = [batch()[0], batch()[1], batch()[3]].map((item, index) => ({
    ...item,
    role: ['familiar', 'quick', 'variety'][index],
    discovery: index === 2 ? 'Сытное сочетание чечевицы и мясных котлет' : item.discovery,
    recipe: {
      ...item.recipe,
      title: titles[index],
      servings: 4,
      ingredients: [...item.recipe.ingredients, { name: 'красная чечевица', raw: 'красная чечевица', quantity: 150, unit: 'г', comment: null }]
    }
  }));
  const validationContext = { profile: { householdSize: 4, hasChildren: true, excludedIngredients: [] }, pantry: [], requestedCategories: ['meat'], mealRequest, feedback: {}, rejected: [], history: [], recentRecipes: [], library: [], categorySignals: {} };
  assert.deepEqual(generated.map((item) => Boolean(validateGeneratedDinner(item, validationContext))), [true, true, true]);
  let calls = 0;
  const result = await recommendDinner(user.id, startDinner(user.id).sessionId, {
    catalogFirst: false,
    generate: async ({ roles, mealRequest: received }) => {
      calls++;
      assert.deepEqual(roles, ['familiar', 'quick', 'variety']);
      assert.deepEqual(received.requiredIngredients, ['чечевица', 'мясо']);
      return { recipes: generated };
    }
  });
  assert.ok(calls >= 1, 'the visible trio must be generated');
  assert.equal(result.recommendations.length, 3);
  assert.ok(result.recommendations.every(({ recipe }) => recipe.servings >= 4 && recipeCategories(recipe).includes('meat')));
});

test('generation abstraction creates independent roles concurrently using strict low-reasoning JSON', async () => {
  const user = fixture(606), original = globalThis.fetch;
  const calls = [], pending = [];
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    const body = JSON.parse(init.body); assert.equal(body.model, 'test-model'); assert.equal(body.text.format.strict, true); assert.equal(body.text.format.name, 'dinner_generation');
    assert.equal(body.reasoning.effort, 'low'); assert.equal(body.text.verbosity, 'low');
    const input = JSON.parse(body.input[0].content[0].text); assert.equal(input.count, 1); assert.deepEqual(input.profile.excludedIngredients, ['орехи']);
    assert.deepEqual(input.profile.preferredCategories, { fish: 1, pasta: -1 });
    assert.deepEqual(input.requestedCategories, ['asian', 'rice']);
    assert.deepEqual(body.text.format.schema.properties.recipes.items.properties.role.enum, [input.role]);
    assert.match(body.instructions, /рецепт должен одновременно соответствовать всем перечисленным категориям/);
    assert.match(body.instructions, /pizza означает пиццу, italian — итальянскую кухню, georgian — грузинскую/);
    if (input.pantry.length) assert.match(body.instructions, /Используй названные продукты как основу/);
    if (input.pantry.length) {
      assert.match(body.instructions, /все основные ингредиенты должны быть среди pantry/);
      assert.match(body.instructions, /включая масло, соусы, лук и чеснок/);
      assert.deepEqual(input.validationFailures, []);
      assert.equal(input.pantryConstraints.maxShoppingIngredients, 5);
      assert.ok(input.pantryConstraints.mainIngredientGroups.some(group => group.includes('rice')));
      assert.ok(input.pantryConstraints.freeIngredientNames.includes('черный перец'));
    }
    else { assert.match(body.instructions, /Продукты дома не указаны/); assert.doesNotMatch(body.instructions, /привычное блюдо из имеющихся продуктов/); }
    calls.push(input);
    const source = batch()[input.candidateIndex];
    const response = new Promise((resolve) => pending.push(() => resolve(new Response(JSON.stringify({ status: 'completed', output_text: JSON.stringify({ recipes: [{ ...source, role: input.role }] }), usage: { input_tokens: 100, output_tokens: 200 } }), { status: 200 }))));
    if (pending.length === 6) pending.splice(0).forEach((resolve) => resolve());
    return response;
  };
  try {
    for (const pantry of [['фарш'], []]) {
      const result = await generateDinnerRecipes({ userId: user.id, count: 6, profile: { excludedIngredients: ['орехи'], preferredCategories: { fish: 1, pasta: -1 } }, pantry, requestedCategories: ['asian', 'rice'], signals: {}, recentRecipes: [], rejectedTitles: [] });
      assert.equal(result.recipes.length, 6);
      assert.deepEqual(result.recipes.map((item) => item.role), ['familiar','quick','variety','familiar','quick','variety']);
    }
    assert.equal(calls.length, 12);
  }
  finally { globalThis.fetch = original; }
});

test('AI dinner intake extracts explicit likes and dislikes separately from exclusions', async () => {
  const user = upsertTelegramUser({ id: 621, first_name: 'Вкусы голосом' }), original = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.text.format.name, 'dinner_intake');
    assert.equal(body.reasoning.effort, 'none');
    assert.equal(body.text.verbosity, 'low');
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


test('dinner rotation avoids recent titles across IDs and reuses oldest only when needed', () => {
  const now = Date.now();
  const ranked = SEED_RECIPES.slice(0, 8).map((recipe, i) => ({ recipe, score: 100 - i }));
  const shown = ranked.slice(0, 5).map((item, i) => ({ recipe: { ...item.recipe, id: 'other:' + i }, createdAt: new Date(now - (i + 1) * 86400000).toISOString() }));
  assert.deepEqual(rotateDinnerCandidates(ranked, shown, now), ranked.slice(5));
  assert.deepEqual(rotateDinnerCandidates(ranked.slice(0, 6), shown, now), [ranked[5], ranked[4], ranked[3]]);
  assert.deepEqual(rotateDinnerCandidates(ranked, shown, now + 8 * 86400000), ranked);
});

test('saved collection changes invalidate dinner buffer but history does not', () => {
  const context = { profile: {}, pantry: [], saved: [SEED_RECIPES[0]] };
  const key = dinnerContextKey(context);
  assert.notEqual(key, dinnerContextKey({ ...context, saved: [...context.saved, SEED_RECIPES[1]] }));
  assert.notEqual(key, dinnerContextKey({ ...context, saved: [{ ...context.saved[0], cookMinutes: 99 }] }));
  assert.equal(key, dinnerContextKey({ ...context, recentShownRecipes: [{ recipe: SEED_RECIPES[0], createdAt: new Date().toISOString() }] }));
});


test('new dinner sessions rotate visible dishes while reopening keeps the current choice', async () => {
  const user = upsertTelegramUser({ id: 62999, first_name: 'Rotation' });
  updateDinnerProfile(user.id, { onboardingCompleted: true });
  const generate = async () => { throw new Error('catalog should suffice'); };
  const titles = new Set();
  for (let day = 0; day < 3; day++) {
    const session = startDinner(user.id).sessionId;
    const result = await recommendDinner(user.id, session, { generate });
    assert.equal(result.recommendations.length, 3);
    for (const option of result.recommendations) {
      assert.equal(titles.has(option.recipe.title), false);
      titles.add(option.recipe.title);
    }
    const reopened = await recommendDinner(user.id, startDinner(user.id).sessionId, { generate });
    assert.deepEqual(reopened.recommendations.map(o => o.id), result.recommendations.map(o => o.id));
    db.prepare('UPDATE dinner_sessions SET opened_at=? WHERE id=?').run(new Date(Date.now() - 7 * 3600000).toISOString(), session);
  }
});


test('replacement waits for an in-flight reserve before rejecting the visible card', async () => {
  const user = upsertTelegramUser({ id: 989620, first_name: 'Replacement waiting' });
  updateDinnerProfile(user.id, { preferredMaxCookingTime: 60, onboardingCompleted: true });
  const session = startDinner(user.id);
  const initial = await recommendDinner(user.id, session.sessionId, { images: false });
  const reserve = listDinnerOptions(user.id, session.sessionId).filter(o => o.state === 'ready');
  db.prepare("UPDATE dinner_options SET state='discarded' WHERE session_id=? AND state='ready'").run(session.sessionId);
  let release, calls = 0;
  const generate = async () => { calls++; return await new Promise(resolve => { release = resolve; }); };
  const options = { generate, images: false, catalogFirst: false };
  prefetchDinner(user.id, session.sessionId, options);
  const target = initial.recommendations[0];
  let settled = false;
  const pending = replaceDinner(user.id, target.id, 'not_today', options).finally(() => { settled = true; });
  const repeated = replaceDinner(user.id, target.id, 'not_today', options);
  await tick();
  assert.equal(settled, false);
  assert.equal(calls, 1);
  assert.equal(db.prepare('SELECT status FROM dinner_recommendations WHERE id=?').get(target.id).status, 'shown');
  // Make the delayed provider completion produce usable reserve options.
  for (const option of reserve) db.prepare("UPDATE dinner_options SET state='ready' WHERE id=?").run(option.id);
  release({ recipes: [] });
  const result = await pending;
  assert.deepEqual((await repeated).recommendations.map(o => o.id), result.recommendations.map(o => o.id));
  assert.notEqual(result.recommendations[0].id, target.id);
  assert.equal(result.recommendations[1].id, initial.recommendations[1].id);
  assert.equal(result.recommendations[2].id, initial.recommendations[2].id);
  assert.equal(result.rejectedCount, 1);
});
