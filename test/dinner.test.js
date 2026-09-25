import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

process.env.DATABASE_PATH = path.resolve('data', `dinner-test-${process.pid}.sqlite`);
process.env.TELEGRAM_BOT_TOKEN = '123456:test-secret';
process.env.DINNER_LLM_ENABLED = 'false';

const { db, upsertTelegramUser, allowUser, createRecipe } = await import('../src/db.js');
const { hasExcludedIngredient, isDinnerCandidate, pantryCoverage, rankCandidates, recipeCategories, selectDinnerChoices, shortlistDinnerCandidates, SEED_RECIPES } = await import('../src/dinner.js');
const { mergeDinnerIntake, normalizeDinnerIntake, parseDinnerIntakeFallback } = await import('../src/dinner-intake.js');
const { confirmDinnerIntake, recommendDinner, rejectDinnerBatch, startDinner } = await import('../src/dinner-service.js');
const { createServer } = await import('../src/server.js');
const { makeTelegramInitData } = await import('../src/security.js');

test.after(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(process.env.DATABASE_PATH + suffix); } catch {} }
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

test('voice intake separates pantry, people, children, food exclusions and time', () => {
  const parsed = parseDinnerIntakeFallback('Есть курица, рис, лук и морковь. На троих, с ребёнком, без грибов, до 30 минут.');
  assert.deepEqual(parsed, { availableIngredients: ['курица', 'рис', 'лук', 'морковь'], excludedIngredients: ['грибов'], householdSize: 3, householdType: 'family', hasChildren: true, maxMinutes: 30 });
  const noKids = parseDinnerIntakeFallback('Есть яйца, помидоры. На двоих, без детей.');
  assert.equal(noKids.hasChildren, false);
  assert.deepEqual(noKids.excludedIngredients, []);
  assert.deepEqual(normalizeDinnerIntake({ availableIngredients: [' рис ', 'рис', 'грибы'], excludedIngredients: ['грибы'] }).availableIngredients, ['рис']);
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
  const children = mergeDinnerIntake(initial, parseDinnerIntakeFallback('Забыл сказать, у нас есть ребёнок.'));
  assert.deepEqual(children.availableIngredients, ['курица', 'рис']);
  assert.equal(children.hasChildren, true);
  assert.equal(children.householdSize, 3);
  assert.equal(children.maxMinutes, 30);
  assert.deepEqual(children.excludedIngredients, ['орехи']);
  const correction = mergeDinnerIntake(children, parseDinnerIntakeFallback('На двоих, без детей. Ещё есть сыр. Рис закончился.'));
  assert.equal(correction.householdSize, 2);
  assert.equal(correction.hasChildren, false);
  assert.deepEqual(correction.availableIngredients, ['курица', 'сыр']);
  assert.deepEqual(correction.excludedIngredients, ['орехи']);
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

test('real mince, potato, rice and pasta intake gives three different trios with a discovery in each', async () => {
  const user = upsertTelegramUser({ id: 606, first_name: 'Фарш' });
  confirmDinnerIntake(user.id, { availableIngredients: ['говяжий фарш', 'картошка', 'рис', 'паста'], householdSize: 4, hasChildren: true, maxMinutes: 30 });
  const session = startDinner(user.id);
  const seen = new Set();
  for (let batch = 0; batch < 3; batch++) {
    const result = await recommendDinner(user.id, session.sessionId);
    assert.equal(result.recommendations.length, 3);
    assert.equal(result.recommendations[2].pitch.label, 'Попробовать новое');
    assert.ok(result.recommendations[2].recipe.discovery);
    for (const option of result.recommendations) {
      assert.ok(!seen.has(option.recipe.id), option.recipe.title);
      seen.add(option.recipe.id);
      assert.ok(option.recipe.prepMinutes + option.recipe.cookMinutes <= 30);
      assert.equal(option.pantryMatch.missingMainIngredients.length, 0);
      assert.ok(option.recipe.steps.length >= 4);
    }
    rejectDinnerBatch(user.id, result.recommendations.map((r) => r.id));
  }
  const last = await recommendDinner(user.id, session.sessionId);
  assert.equal(last.recommendations.length, 1);
  rejectDinnerBatch(user.id, last.recommendations.map((r) => r.id));
  const empty = await recommendDinner(user.id, session.sessionId);
  assert.equal(empty.recommendations.length, 0);
  assert.match(empty.message, /готовый запас закончился/);
  const noBeef = rankCandidates(SEED_RECIPES, { pantry: session.pantry, profile: { excludedIngredients: ['говядина'] } });
  assert.ok(noBeef.every((c) => !c.recipe.discovery));
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
