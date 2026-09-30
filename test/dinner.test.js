import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

process.env.DATABASE_PATH = path.resolve('data', `dinner-test-${process.pid}.sqlite`);
process.env.TELEGRAM_BOT_TOKEN = '123456:test-secret';
process.env.DINNER_LLM_ENABLED = 'false';

const { db, upsertTelegramUser, allowUser, createRecipe } = await import('../src/db.js');
const { hasExcludedIngredient, isDinnerCandidate, pantryCoverage, rankCandidates, recipeCategories, selectDinnerChoices, shortlistDinnerCandidates, SEED_RECIPES } = await import('../src/dinner.js');
const { combineDinnerIntakeExtraction, mergeDinnerIntake, normalizeDinnerIntake, parseDinnerIntakeFallback } = await import('../src/dinner-intake.js');
const { confirmDinnerIntake, recommendDinner, rejectDinnerBatch, startDinner, updateDinnerProfile } = await import('../src/dinner-service.js');
const { getFoodProfile } = await import('../src/dinner-store.js');
const { createServer } = await import('../src/server.js');
const { makeTelegramInitData } = await import('../src/security.js');

test.after(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(process.env.DATABASE_PATH + suffix); } catch {} }
});

test('explicit likes and dislikes change ranking even with strong history, without weakening exclusions', () => {
  const pasta = { id: 'pasta', title: 'Паста', ingredients: [{ name: 'макароны' }] };
  const fish = { id: 'fish', title: 'Рыба', ingredients: [{ name: 'рыба' }] };
  const profile = { preferredCategories: { pasta: 1, fish: -1 } };
  const ranked = rankCandidates([fish, pasta], { profile });
  assert.deepEqual(ranked.map((item) => item.recipe.id), ['pasta', 'fish']);
  assert.equal(ranked[0].score, 2);
  assert.equal(ranked[1].score, -2);
  const neutral = rankCandidates([fish], { categorySignals: { fish: 100 } })[0];
  const disliked = rankCandidates([fish], { profile, categorySignals: { fish: 100 } })[0];
  assert.equal(neutral.score - disliked.score, 2);
  assert.deepEqual(rankCandidates([pasta], { profile: { ...profile, excludedIngredients: ['глютен'] } }), []);
});

test('completed chat onboarding does not repeat tastes; explicit answers and edits remain independent', async () => {
  const user = upsertTelegramUser({ id: 650, first_name: 'Вкусы' });
  assert.equal(startDinner(user.id).needsTastePreferences, true);
  updateDinnerProfile(user.id, { onboardingCompleted: true, excludedIngredients: ['орехи'], householdSize: 2 });
  assert.equal(startDinner(user.id).needsTastePreferences, false, 'completed chat introduction must not ask the same taste question again');
  updateDinnerProfile(user.id, { preferredCategories: { pasta: 1, fish: -1 }, tastePreferencesStatus: 'completed' });
  const session = startDinner(user.id);
  assert.equal(session.needsTastePreferences, false);
  const first = await recommendDinner(user.id, session.sessionId);
  updateDinnerProfile(user.id, { preferredCategories: { pasta: -1, fish: 1 } });
  const updated = await recommendDinner(user.id, session.sessionId);
  assert.ok(updated.recommendations.every((item) => !first.recommendations.some((old) => old.id === item.id)));
  updateDinnerProfile(user.id, { tastePreferencesStatus: 'skipped' });
  const saved = getFoodProfile(user.id);
  assert.deepEqual(saved.preferredCategories, { pasta: -1, fish: 1 });
  assert.deepEqual(saved.excludedIngredients, ['орехи']);
  assert.equal(saved.householdSize, 2);
  assert.equal(saved.onboardingCompleted, true);
  assert.equal(startDinner(user.id).needsTastePreferences, false);
  updateDinnerProfile(user.id, { preferredCategories: {}, tastePreferencesStatus: 'completed' });
  assert.deepEqual(getFoodProfile(user.id).preferredCategories, {});
  const stranger = upsertTelegramUser({ id: 651, first_name: 'Другой' });
  assert.equal(startDinner(stranger.id).needsTastePreferences, true);
  assert.deepEqual(getFoodProfile(stranger.id).preferredCategories, {});
});

test('invalid taste values cannot modify the profile; old positive preferences remain supported', () => {
  const user = upsertTelegramUser({ id: 652, first_name: 'Проверка' });
  updateDinnerProfile(user.id, { preferredCategories: { pasta: 0.8 } });
  const original = getFoodProfile(user.id);
  assert.equal(original.tastePreferencesStatus, 'completed');
  assert.equal(startDinner(user.id).needsTastePreferences, false, 'saved tastes must not be requested again');
  for (const preferredCategories of [{ unknown: 1 }, { fish: -2 }, { pasta: 2 }, { fish: '1' }, { fish: NaN }, [], null]) {
    assert.throws(() => updateDinnerProfile(user.id, { preferredCategories }), (error) => error.status === 400);
    assert.deepEqual(getFoodProfile(user.id), original);
  }
  assert.throws(() => updateDinnerProfile(user.id, { tastePreferencesStatus: null }), (error) => error.status === 400);
});

test('scoring applies food exclusions, time limits, saved preference and recent cooking', () => {
  const pasta = { id: 'a', title: 'Паста с томатами', tags: [], ingredients: [{ name: 'томаты' }], prepMinutes: 5, cookMinutes: 20, userSaved: true };
  const mushrooms = { id: 'b', title: 'Гречка с грибами', tags: [], ingredients: [{ name: 'шампиньоны' }], prepMinutes: 5, cookMinutes: 20, userSaved: true };
  const slow = { id: 'c', title: 'Суп', ingredients: [{ name: 'картофель' }], prepMinutes: 20, cookMinutes: 40, userSaved: true };
  assert.deepEqual(recipeCategories(pasta), ['pasta']);
  assert.equal(isDinnerCandidate({ title: 'Чизкейк', ingredients: [{ name: 'сыр' }], steps: [{ text: 'Смешать' }] }), false);
  assert.equal(isDinnerCandidate({ title: 'Курица', ingredients: [{ name: 'курица' }], steps: [] }), false);
  assert.equal(hasExcludedIngredient(mushrooms, ['грибы']), true);
  assert.deepEqual(rankCandidates([pasta, mushrooms, slow], { profile: { excludedIngredients: ['грибы'], preferredMaxCookingTime: 30, preferredCategories: { pasta: 0.8 } } }).map((item) => item.recipe.id), ['a']);
  const history = [{ recipeKey: 'a', event: 'recipe_cooked', createdAt: new Date().toISOString() }];
  assert.ok(rankCandidates([pasta], { history })[0].score < rankCandidates([pasta])[0].score);
  assert.deepEqual(rankCandidates([pasta], { rejected: ['a'] }), []);
});

test('generic meat exclusions and requests cover concrete meats without merging preference facets', () => {
  const recipe = (name) => ({ title: `Блюдо с ${name}`, ingredients: [{ name }], steps: [{ text: 'Приготовьте.' }] });
  for (const meat of ['говядина', 'свинина', 'куриное филе', 'индейка', 'баранина']) {
    assert.equal(hasExcludedIngredient(recipe(meat), ['мясо']), true, meat);
    assert.equal(rankCandidates([recipe(meat)], { requestedCategories: ['meat'] }).length, 1, meat);
  }
  assert.ok(recipeCategories(recipe('говядина')).includes('meat'));
  assert.ok(!recipeCategories(recipe('куриное филе')).includes('meat'), 'the chicken preference facet stays independent');
  assert.equal(hasExcludedIngredient(recipe('рыба'), ['мясо']), false);
  assert.equal(hasExcludedIngredient(recipe('грибы'), ['мясо']), false);
  assert.equal(hasExcludedIngredient(recipe('соевый фарш'), ['мясо']), false);
  assert.equal(hasExcludedIngredient(recipe('свинина'), ['говядина']), false);
  assert.equal(hasExcludedIngredient(recipe('чесночный соус'), ['чеснок']), true, 'existing inflection fallback remains intact');
});

test('dinner trio gives a saved, quick and different option', () => {
  const candidate = (id, minutes, categories, userSaved = false, score = 1) => ({ recipe: { id, userSaved }, minutes, categories, score });
  const ranked = [candidate('saved', 30, ['chicken'], true, 9), candidate('similar', 25, ['chicken'], false, 8), candidate('new', 20, ['fish'], false, 5), candidate('fast', 15, ['salad'], false, 2)];
  const shortlist = shortlistDinnerCandidates(ranked);
  assert.ok(shortlist.length <= 8);
  const choices = selectDinnerChoices(shortlist);
  assert.deepEqual(choices.map(({ role }) => role), ['familiar', 'quick', 'variety']);
  assert.equal(choices[0].candidate.recipe.id, 'saved');
  assert.equal(choices[1].candidate.recipe.id, 'fast');
  assert.equal(choices[2].candidate.recipe.id, 'new');
});

test('voice intake separates pantry, people, children, food exclusions, time and tastes', () => {
  const parsed = parseDinnerIntakeFallback('Есть курица, рис, лук и морковь. На троих, с ребёнком, без грибов, до 30 минут. Люблю пасту и курицу. Не люблю рыбу и супы.');
  assert.deepEqual(parsed, { availableIngredients: ['курица', 'рис', 'лук', 'морковь'], excludedIngredients: ['грибов'], householdSize: 3, householdType: 'family', hasChildren: true, maxMinutes: 30, preferredCategories: { pasta: 1, chicken: 1, fish: -1, soup: -1 }, requestedCategories: [] });
  const noKids = parseDinnerIntakeFallback('Есть яйца, помидоры. На двоих, без детей.');
  assert.equal(noKids.hasChildren, false);
  assert.deepEqual(noKids.excludedIngredients, []);
  assert.deepEqual(normalizeDinnerIntake({ availableIngredients: [' рис ', 'рис', 'грибы'], excludedIngredients: ['грибы'] }).availableIngredients, ['рис']);
});

test('rice is a saved taste while a wish for today is an imperative request', () => {
  const tastes = parseDinnerIntakeFallback('Люблю пасту и рис.');
  assert.deepEqual(tastes.preferredCategories, { pasta: 1, rice: 1 });
  assert.deepEqual(tastes.requestedCategories, []);

  const today = parseDinnerIntakeFallback('Сегодня хочу азиатское с рисом.');
  assert.deepEqual(new Set(today.requestedCategories), new Set(['asian', 'rice']));
  assert.deepEqual(today.preferredCategories, {});
  assert.deepEqual(today.availableIngredients, []);
  assert.equal(today.replaceRequestedCategories, true);

  const exact = rankCandidates(SEED_RECIPES, { requestedCategories: today.requestedCategories });
  assert.ok(exact.length >= 1);
  assert.ok(exact[0].categories.includes('asian') && exact[0].categories.includes('rice'), 'category matches are retrieval hints');
  assert.ok(exact.some((candidate) => candidate.recipe.id === 'seed:keema-potato'), 'nonmatches remain available for the semantic validator instead of being hard-rejected');
  assert.deepEqual(recipeCategories({ title: 'Салат с рисовым уксусом', ingredients: [{ name: 'рисовый уксус' }] }), ['salad']);
});

test('a bare cuisine reply in the profile dialog is kept even when AI extraction is empty', () => {
  const fallback = parseDinnerIntakeFallback('Итальянская кухня и грузинская кухня', { bareCategoriesAsLikes: true });
  assert.deepEqual(fallback.preferredCategories, { georgian: 1, italian: 1 });
  assert.deepEqual(fallback.availableIngredients, []);

  const emptyExtraction = {
    availableIngredients: [], excludedIngredients: [], removedIngredients: [], replaceIngredients: false,
    householdSize: null, hasChildren: null, maxMinutes: null, likedCategories: [], dislikedCategories: [],
    requestedCategories: [], replaceRequestedCategories: false
  };
  const combined = combineDinnerIntakeExtraction(emptyExtraction, fallback);
  assert.deepEqual(normalizeDinnerIntake(combined).preferredCategories, { georgian: 1, italian: 1 });

  const today = parseDinnerIntakeFallback('Сегодня хочу азиатское с рисом', { bareCategoriesAsLikes: true });
  assert.deepEqual(today.preferredCategories, {});
  assert.deepEqual(new Set(today.requestedCategories), new Set(['asian', 'rice']));
});

test('dish and cuisine tags overlap without replacing one another', () => {
  const pizza = SEED_RECIPES.find((recipe) => recipe.id === 'seed:pizza-margherita-family');
  assert.ok(pizza);
  assert.ok(fs.existsSync(path.join('public', pizza.thumbnailUrl)));
  const pizzaTags = recipeCategories(pizza);
  for (const key of ['pizza', 'fastfood', 'italian', 'european']) assert.ok(pizzaTags.includes(key), key);

  const georgian = SEED_RECIPES.find((recipe) => recipe.id === 'seed:chakhokhbili');
  const georgianTags = recipeCategories(georgian);
  assert.ok(georgianTags.includes('georgian'));
  assert.ok(georgianTags.includes('caucasian'));

  const sushiTags = recipeCategories({ title: 'Суши-роллы', tags: ['японское'], ingredients: [{ name: 'рис' }] });
  for (const key of ['sushi', 'japanese', 'asian']) assert.ok(sushiTags.includes(key), key);
  const greekTags = recipeCategories(SEED_RECIPES.find((recipe) => recipe.id === 'seed:keftedes'));
  assert.ok(!greekTags.includes('sushi'), 'сушёная мята не означает суши');
  assert.ok(!greekTags.includes('japanese'), 'сушёная мята не означает японскую кухню');
});

test('confirmed pantry changes candidate filtering, ranking and the dinner session', async () => {
  const recipe = { ingredients: ['куриное филе', 'рис', 'морковь', 'лук', 'растительное масло'] };
  assert.deepEqual(pantryCoverage(recipe, ['курица', 'рис', 'лук', 'морковь']).missing, ['растительное масло']);
  assert.deepEqual(pantryCoverage({ title: 'Чечевичный суп', ingredients: ['красная чечевица', 'морковь', 'лук', 'томатная паста'] }, ['рис', 'морковь', 'лук']).missingMainIngredients, ['красная чечевица']);
  const user = upsertTelegramUser({ id: 604, first_name: 'Продукты' });
  const { profile, pantry } = confirmDinnerIntake(user.id, parseDinnerIntakeFallback('Есть курица, рис, лук и морковь. На троих, с ребёнком, без грибов, до 30 минут.'));
  assert.deepEqual(pantry, ['курица', 'рис', 'лук', 'морковь']);
  assert.equal(profile.householdSize, 3);
  assert.equal(profile.hasChildren, true);
  assert.equal(profile.preferredMaxCookingTime, 30);
  const session = startDinner(user.id);
  assert.equal(session.needsOnboarding, false);
  assert.deepEqual(session.pantry, pantry);
  const dinner = await recommendDinner(user.id, session.sessionId);
  assert.equal(dinner.recommendations.length, 3);
  assert.equal(dinner.recommendation.recipe.id, 'seed:chicken-rice-soup');
  assert.deepEqual(dinner.recommendation.pantryMatch.missing, []);
  assert.ok(dinner.recommendations.every((option) => option.pantryMatch.missingMainIngredients.length === 0 && option.pantryMatch.missing.length <= 5));
  assert.ok(dinner.recommendations.every((option) => !hasExcludedIngredient(option.recipe, ['грибов'])));
  assert.ok(dinner.recommendations.every((option) => option.recipe.prepMinutes + option.recipe.cookMinutes <= 30));
  assert.ok(dinner.recommendations.some((option) => !/рис/iu.test(option.recipe.title)), 'the initial trio must include a different side');
});

test('intake patches preserve prior fields, append products, and respect explicit corrections', () => {
  const initial = parseDinnerIntakeFallback('Есть курица, рис. На троих, до 30 минут, аллергия на орехи.');
  const children = mergeDinnerIntake(initial, parseDinnerIntakeFallback('Забыл сказать, у нас есть ребёнок. Люблю пасту, не люблю рыбу.'));
  assert.deepEqual(children.availableIngredients, ['курица', 'рис']);
  assert.equal(children.hasChildren, true);
  assert.equal(children.householdSize, 3);
  assert.equal(children.maxMinutes, 30);
  assert.deepEqual(children.excludedIngredients, ['орехи']);
  assert.deepEqual(children.preferredCategories, { pasta: 1, fish: -1 });
  const correction = mergeDinnerIntake(children, parseDinnerIntakeFallback('На двоих, без детей. Ещё есть сыр. Рис закончился. Теперь люблю рыбу.'));
  assert.equal(correction.householdSize, 2);
  assert.equal(correction.hasChildren, false);
  assert.deepEqual(correction.availableIngredients, ['курица', 'сыр']);
  assert.deepEqual(correction.excludedIngredients, ['орехи']);
  assert.deepEqual(correction.preferredCategories, { pasta: 1, fish: 1 });
  assert.deepEqual(mergeDinnerIntake(correction, parseDinnerIntakeFallback('Теперь только курица.')).availableIngredients, ['курица']);
  assert.deepEqual(parseDinnerIntakeFallback('Аллергии нет').availableIngredients, []);
});

test('a main ingredient admits new sides but never bypasses allergies or invents the base', () => {
  const candidates = rankCandidates(SEED_RECIPES, { pantry: ['курица'], profile: { preferredMaxCookingTime: 30 } });
  assert.ok(candidates.length >= 7);
  const pasta = candidates.find((c) => c.recipe.id === 'seed:chicken-pasta');
  assert.ok(pasta.pantryMatch.missing.includes('паста'));
  const noMilk = rankCandidates(SEED_RECIPES, { pantry: ['курица'], profile: { excludedIngredients: ['молоко'] } });
  assert.ok(!noMilk.some((c) => c.recipe.id === 'seed:chicken-creamy'));
  const cutlet = { id: 'cutlet', title: 'Домашняя котлета', ingredients: [{ name: 'мясной фарш' }, { name: 'яйца' }, { name: 'лук' }] };
  assert.equal(rankCandidates([cutlet], { pantry: ['яйца', 'лук'] }).length, 0);
  assert.equal(rankCandidates([cutlet], { pantry: ['фарш'] }).length, 1);
  assert.equal(rankCandidates(SEED_RECIPES, { pantry: ['курица'], profile: { excludedIngredients: ['курица'] } }).length, 0);
});

test('chicken-only intake offers successive different trios with explicit shopping lists', async () => {
  const user = upsertTelegramUser({ id: 605, first_name: 'Курица' });
  confirmDinnerIntake(user.id, { availableIngredients: ['курица'], householdSize: 2, maxMinutes: 30 });
  const session = startDinner(user.id);
  const first = await recommendDinner(user.id, session.sessionId);
  assert.equal(first.recommendations.length, 3);
  rejectDinnerBatch(user.id, first.recommendations.map((r) => r.id));
  const next = await recommendDinner(user.id, session.sessionId);
  assert.equal(next.recommendations.length, 3);
  assert.ok(next.recommendations.every((r) => !first.recommendations.some((p) => p.recipe.id === r.recipe.id)));
  assert.ok([...first.recommendations, ...next.recommendations].every((r) => r.pantryMatch.missing.length > 0));
});

test('pantry matches potato synonyms and distinguishes mince from meat cuts and other mince', () => {
  const potato = SEED_RECIPES.find((r) => r.id === 'seed:potato-skillet');
  assert.equal(pantryCoverage(potato, ['картошка']).missingMainIngredients.length, 0);
  assert.equal(pantryCoverage(potato, ['картошки']).missingMainIngredients.length, 0);
  const mince = SEED_RECIPES.find((r) => r.id === 'seed:mince-pasta');
  assert.equal(rankCandidates([mince], { pantry: ['говяжий фарш', 'паста'] }).length, 1);
  assert.equal(rankCandidates([mince], { pantry: ['куриный фарш', 'паста'] }).length, 0);
  assert.equal(rankCandidates([mince], { pantry: ['говядина', 'паста'] }).length, 0);
  assert.equal(rankCandidates([mince], { pantry: ['фарш'], profile: { excludedIngredients: ['говядина'] } }).length, 0);
  const tomato = pantryCoverage({ ingredients: ['томатная паста', 'сливочное масло'] }, ['паста', 'томаты', 'растительное масло']);
  assert.deepEqual(tomato.missing, ['томатная паста', 'сливочное масло']);
  assert.equal(hasExcludedIngredient(SEED_RECIPES.find((r) => r.id === 'seed:keftedes'), ['глютен']), true);
});

test('expanded catalog treats legumes, mushrooms, cabbage and potato as real pantry bases', () => {
  for (const pantry of ['нут', 'фасоль', 'грибы', 'капуста', 'картошка']) {
    const candidates = rankCandidates(SEED_RECIPES, { pantry: [pantry], profile: { preferredMaxCookingTime: 90 } });
    assert.ok(candidates.length >= 1, pantry);
    assert.ok(candidates.every((candidate) => candidate.pantryMatch.missingMainIngredients.length === 0), pantry);
  }
});

test('editorial discovery survives the shortlist and keeps the third slot even when it is fastest', () => {
  const candidates = Array.from({ length: 12 }, (_, i) => ({ recipe: { id: `ordinary-${i}` }, categories: ['meat'], minutes: 25, score: 20 - i }));
  const discovery = { recipe: { id: 'discovery', discovery: 'Понятное описание блюда' }, categories: ['asian'], minutes: 15, score: -2 };
  candidates.push(discovery);
  const shortlist = shortlistDinnerCandidates(candidates);
  assert.equal(shortlist.length, 8);
  assert.ok(shortlist.includes(discovery));
  const choices = selectDinnerChoices(shortlist);
  assert.equal(choices[2].candidate.recipe.id, 'discovery');
  assert.equal(new Set(choices.map((c) => c.candidate.recipe.id)).size, 3);
  assert.equal(selectDinnerChoices([discovery]).length, 1);
  assert.equal(selectDinnerChoices([discovery, candidates[0]]).length, 2);
});

test('visible trio includes the strongest explicit taste match instead of leaving it in reserve', () => {
  const profile = { householdSize: 4, preferredCategories: { pasta: 1, meat: 1 } };
  const ranked = rankCandidates(SEED_RECIPES, { profile });
  const shortlist = shortlistDinnerCandidates(ranked, [], 8, profile.preferredCategories);
  const choices = selectDinnerChoices(shortlist, [], { preferredCategories: profile.preferredCategories });
  assert.ok(!recipeCategories(SEED_RECIPES.find((recipe) => recipe.id === 'seed:beef-goulash-mash')).includes('pasta'), 'томатная паста не является категорией блюда «паста»');
  assert.ok(!recipeCategories(SEED_RECIPES.find((recipe) => recipe.id === 'seed:egg-salad')).includes('meat'), 'тег «без мяса» не является категорией блюда «мясо»');
  assert.ok(choices[0].candidate.categories.includes('pasta'));
  assert.ok(choices[0].candidate.categories.includes('meat'));
});

test('visible trio represents separate cuisine preferences when matching recipes exist', () => {
  const preferredCategories = { italian: 1, georgian: 1 };
  const ranked = rankCandidates(SEED_RECIPES, { profile: { preferredCategories } });
  const shortlist = shortlistDinnerCandidates(ranked, [], 8, preferredCategories);
  const choices = selectDinnerChoices(shortlist, [], { preferredCategories });
  const visible = new Set(choices.flatMap(({ candidate }) => candidate.categories));
  assert.ok(visible.has('italian'));
  assert.ok(visible.has('georgian'));
});

test('family pantry batches stop honestly when suitable four-portion recipes run out', async () => {
  const user = upsertTelegramUser({ id: 606, first_name: 'Фарш' });
  confirmDinnerIntake(user.id, { availableIngredients: ['говяжий фарш', 'картошка', 'рис', 'паста'], householdSize: 4, hasChildren: true, maxMinutes: 30 });
  const session = startDinner(user.id);
  const seen = new Set();
  for (let batch = 0; batch < 20; batch++) {
    const result = await recommendDinner(user.id, session.sessionId);
    if (!result.recommendations.length) break;
    assert.ok(result.recommendations.length <= 3);
    for (const option of result.recommendations) {
      assert.ok(!seen.has(option.recipe.id), option.recipe.title);
      seen.add(option.recipe.id);
      assert.ok(option.recipe.prepMinutes + option.recipe.cookMinutes <= 30);
      assert.ok(option.recipe.servings >= 4);
      assert.equal(option.pantryMatch.missingMainIngredients.length, 0);
      assert.ok(option.recipe.steps.length >= 4);
    }
    rejectDinnerBatch(user.id, result.recommendations.map((r) => r.id));
  }
  assert.ok(seen.size >= 3);
  const empty = await recommendDinner(user.id, session.sessionId);
  assert.equal(empty.recommendations.length, 0);
  assert.match(empty.message, /готовый запас закончился/);
  const noBeef = rankCandidates(SEED_RECIPES, { pantry: session.pantry, profile: { excludedIngredients: ['говядина'] } });
  assert.ok(noBeef.every((c) => !/говяд|говяж/iu.test(c.recipe.ingredients.map((item) => item.name).join(' '))));
  assert.ok(SEED_RECIPES.some((recipe) => recipe.discovery && !/говяд|говяж/iu.test(recipe.ingredients.map((item) => item.name).join(' '))));
});

test('cold start, profile, recommendation, retry, reason and cooked decision work through HTTP', async () => {
  const tg = { id: 601, first_name: 'Ужин' };
  const user = upsertTelegramUser(tg); allowUser(user.id);
  const headers = { authorization: `tma ${makeTelegramInitData(tg, process.env.TELEGRAM_BOT_TOKEN)}`, 'content-type': 'application/json' };
  const server = createServer(); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (url, body = {}) => { const res = await fetch(base + url, { method: 'POST', headers, body: JSON.stringify(body) }); assert.equal(res.status, 200, url); return res.json(); };
  try {
    const firstSession = await post('/api/dinner/open');
    assert.equal(firstSession.needsOnboarding, true);
    const immediate = await post('/api/dinner/recommend', { sessionId: firstSession.sessionId });
    assert.equal(immediate.recommendations.length, 3);
    assert.deepEqual(immediate.recommendations.map((item) => item.role), ['familiar', 'quick', 'variety']);
    assert.equal(new Set(immediate.recommendations.map((item) => item.pitch.label)).size, 3);
    assert.ok(immediate.recommendations.every((item) => !/есть ингредиенты|всё есть дома/i.test(item.pitch.reason)));
    assert.equal(immediate.recommendation.id, immediate.recommendations[0].id);
    assert.ok(immediate.recommendations.every((item) => !item.recipe.userSaved));
    const detail = await fetch(base + '/api/dinner/recipes/' + encodeURIComponent(immediate.recommendation.recipe.id), { headers });
    assert.equal(detail.status, 200);
    const fullRecipe = await detail.json();
    assert.ok(fullRecipe.thumbnailUrl.startsWith('/assets/dinner/'));
    assert.ok(fullRecipe.steps.length >= 4);
    assert.ok(fullRecipe.ingredients.every((item) => item.quantity > 0 && item.unit));
    assert.equal((await fetch(base + '/api/dinner/recipes/seed:unknown', { headers })).status, 404);
    const strangerTg = { id: 603, first_name: 'Чужой' }; const stranger = upsertTelegramUser(strangerTg); allowUser(stranger.id);
    const strangerHeaders = { ...headers, authorization: `tma ${makeTelegramInitData(strangerTg, process.env.TELEGRAM_BOT_TOKEN)}` };
    const foreignSession = await fetch(base + '/api/dinner/recommend', { method: 'POST', headers: strangerHeaders, body: JSON.stringify({ sessionId: firstSession.sessionId }) });
    assert.equal(foreignSession.status, 404);
    await post('/api/dinner/onboarding/start', { sessionId: firstSession.sessionId });
    const profileResponse = await fetch(base + '/api/dinner/profile', { method: 'PUT', headers, body: JSON.stringify({ householdType: 'couple', preferredMaxCookingTime: 30, excludedIngredients: ['грибы'], preferredCategories: { pasta: 0.8 }, onboardingCompleted: true }) });
    assert.equal(profileResponse.status, 200);
    const flowSession = await post('/api/dinner/open');
    const initial = await post('/api/dinner/recommend', { sessionId: flowSession.sessionId });
    assert.equal(initial.recommendations.length, 3);
    assert.ok(initial.recommendations.every((item) => !hasExcludedIngredient(item.recipe, ['грибы'])));
    const buffered = await post('/api/dinner/prefetch', { sessionId: flowSession.sessionId });
    assert.equal(buffered.reserve.length, 3);
    const second = await post('/api/dinner/next', { ids: initial.recommendations.map((item) => item.id) });
    assert.equal(second.retryCount, 1);
    assert.equal(second.rejectedCount, 3);
    assert.deepEqual(second.recommendations.map((item) => item.id), buffered.reserve.map((item) => item.id));
    assert.equal(second.recommendations.length, 3);
    assert.ok(second.recommendations.every((item) => !initial.recommendations.some((earlier) => earlier.recipe.id === item.recipe.id)));
    const secondReject = await post('/api/dinner/reject-batch', { ids: second.recommendations.map((item) => item.id) });
    assert.equal(secondReject.retryCount, 2);
    await post(`/api/dinner/recommendations/${second.recommendation.id}/reason`, { reason: 'too_long' });
    const third = await post('/api/dinner/recommend', { sessionId: flowSession.sessionId });
    assert.notEqual(third.recommendation.recipe.id, second.recommendation.recipe.id);
    assert.ok(third.recommendations.length > 0 && third.recommendations.length <= 3);
    assert.ok(third.recommendations.every((option) => option.recipe.prepMinutes + option.recipe.cookMinutes <= Math.max(15, second.recommendation.recipe.prepMinutes + second.recommendation.recipe.cookMinutes - 5)));
    await post(`/api/dinner/recommendations/${third.recommendation.id}/accept`);
    await post(`/api/dinner/recommendations/${third.recommendation.id}/cooked`);
    const events = db.prepare('SELECT event FROM dinner_events WHERE user_id=?').all(user.id).map((row) => row.event);
    for (const event of ['dinner_recommendation_opened', 'onboarding_started', 'onboarding_completed', 'recommendation_shown', 'recommendation_rejected', 'dinner_retry', 'dinner_rejection_reason', 'recommendation_accepted', 'recipe_cooked']) assert.ok(events.includes(event), event);

    const own = createRecipe(user.id, { title: 'Быстрая паста', status: 'ready', ingredients: [{ name: 'томаты' }, { name: 'паста' }], steps: [{ text: 'Сварить' }], prepMinutes: 5, cookMinutes: 15 });
    createRecipe(user.id, { title: 'Грибы с рисом', status: 'ready', ingredients: [{ name: 'шампиньоны' }], prepMinutes: 5, cookMinutes: 15 });
    const nextSession = await post('/api/dinner/open');
    assert.equal(nextSession.needsOnboarding, false);
    const ownDinner = await post('/api/dinner/recommend', { sessionId: nextSession.sessionId });
    assert.equal(ownDinner.recommendation.recipe.id, own.id);
    assert.equal(ownDinner.recommendations.length, 3);
    const repeated = await post('/api/dinner/reject-batch', { ids: ownDinner.recommendations.map((item) => item.id) });
    assert.equal(repeated.retryCount, 1);
    const afterReject = await post('/api/dinner/recommend', { sessionId: nextSession.sessionId });
    assert.ok(afterReject.recommendations.every((item) => item.recipe.id !== own.id));
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
