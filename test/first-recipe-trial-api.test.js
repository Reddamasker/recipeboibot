import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'recipe-first-trial-api-'));
Object.assign(process.env, {
  DATABASE_PATH: path.join(directory, 'recipes.sqlite'), BOT_PLATFORM: 'telegram',
  TELEGRAM_BOT_TOKEN: '123456:first-trial-api-test', TELEGRAM_POLLING: 'false',
  TEST_CONTOUR: 'false', BILLING_REQUIRED: 'false', APP_URL: 'https://recipes.example.test',
  DINNER_LLM_ENABLED: 'false', DINNER_IMAGES_ENABLED: 'false', OPENAI_API_KEY: 'unused-test-key'
});
const { db, upsertTelegramUser, allowUser, createRecipe, createRecipeSuggestion, getRecipe } = await import('../src/db.js');
const { withFirstRecipe, getPendingFirstRecipe, getTrialStatus, protectFirstRecipeResponse } = await import('../src/subscriptions.js');
const { createServer } = await import('../src/server.js');
const { makeTelegramInitData } = await import('../src/security.js');
const { SEED_RECIPES } = await import('../src/dinner.js');
const { updateDinnerProfile } = await import('../src/dinner-service.js');

let serial = 619100000;
let server, base;
const originalFetch = globalThis.fetch;
test.before(async () => {
  server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  globalThis.fetch = (url, options) => {
    assert.equal(new URL(url).origin, base, 'These tests must never call AI or external services');
    return originalFetch(url, options);
  };
});
test.after(async () => {
  globalThis.fetch = originalFetch;
  await new Promise(resolve => server.close(resolve));
  db.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

function fresh() {
  const telegram = { id: serial++, first_name: 'First trial API' };
  const user = upsertTelegramUser(telegram);
  allowUser(user.id);
  return { user, telegram };
}
async function call(account, route, { method = 'GET', body, status = 200 } = {}) {
  const response = await fetch(base + route, {
    method, headers: { authorization: `tma ${makeTelegramInitData(account.telegram, process.env.TELEGRAM_BOT_TOKEN)}`, 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
  const value = await response.json();
  assert.equal(response.status, status, `${method} ${route}: ${JSON.stringify(value)}`);
  return value;
}
const post = (account, route, body = {}, status = 200) => call(account, route, { method: 'POST', body, status });
function assertPreview(value, label = 'response') {
  if (Array.isArray(value)) { value.forEach((item, index) => assertPreview(item, `${label}[${index}]`)); return; }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.ok(!['ingredients', 'steps', 'pantryMatch', 'mainIngredients', 'sourceText'].includes(key), `${label}.${key} reveals recipe details`);
    assertPreview(child, `${label}.${key}`);
  }
  const encoded = JSON.stringify(value);
  assert.ok(!encoded.includes('SECRET_COOKING_STEP'), `${label} exposes a step through another field`);
  assert.ok(!encoded.includes('876543'), `${label} exposes a quantity through another field`);
}
function secretRecipe(title = 'Закрытый рис') {
  return {
    title, description: 'SECRET_COOKING_STEP description', servings: 2, prepMinutes: 5, cookMinutes: 15,
    ingredients: [{ name: 'рис', raw: 'рис', quantity: 876543, unit: 'г' }],
    steps: [{ position: 1, text: 'SECRET_COOKING_STEP сварить рис' }],
    tags: ['ужин'], warnings: ['SECRET_COOKING_STEP warning'], notes: 'SECRET_COOKING_STEP note',
    nutrition: { calories: 300, protein: 8, fat: 5, carbs: 55, basis: 'serving', source: 'calculated', servings: 2, assumptions: [] }
  };
}
async function dinnerPreview(account) {
  updateDinnerProfile(account.user.id, { onboardingCompleted: true });
  const session = await post(account, '/api/dinner/open');
  const preview = await post(account, '/api/dinner/recommend', { sessionId: session.sessionId });
  return { session, preview };
}

test('fresh catalog cannot expose full recipes even before a preview marker exists', async () => {
  const account = fresh();
  const route = `/api/dinner/recipes/${encodeURIComponent(SEED_RECIPES[0].id)}`;
  assert.equal(db.prepare('SELECT 1 FROM first_dinner_previews WHERE user_id=?').get(account.user.id), undefined);
  assertPreview(await call(account, route, { status: 402 }));
  assertPreview(await post(account, route + '/share', {}, 402));
  await call(account, '/api/dinner/recipes/seed%3Adoes-not-exist', { status: 404 });
  assert.equal(getTrialStatus(account.user.id).used, false);
});

test('all dinner previews, replacements, next batches and rejection responses hide cooking details', async () => {
  const account = fresh();
  const { session, preview } = await dinnerPreview(account);
  assert.equal(preview.recommendations.length, 3);
  assertPreview(preview);
  assert.equal(db.prepare('SELECT trial_gate FROM first_dinner_previews WHERE user_id=?').get(account.user.id).trial_gate, 1);
  assertPreview(await post(account, '/api/dinner/prefetch', { sessionId: session.sessionId }));
  const replaced = await post(account, `/api/dinner/recommendations/${preview.recommendation.id}/replace`, { reason: 'not_today' });
  assertPreview(replaced);
  const next = await post(account, '/api/dinner/next', { ids: replaced.recommendations.map(item => item.id) });
  assertPreview(next);
  assertPreview(await post(account, `/api/dinner/recommendations/${next.recommendation.id}/reject`));
  assert.equal(getPendingFirstRecipe(account.user.id), null);
  assert.equal(getTrialStatus(account.user.id).used, false);
});

test('like persists one chosen recipe, blocks alternate reads, and trial unlocks that exact recipe idempotently', async () => {
  const account = fresh();
  const foreign = fresh();
  const { preview } = await dinnerPreview(account);
  const option = preview.recommendation;
  const route = `/api/dinner/recommendations/${option.id}`;
  const chosen = await post(account, route + '/accept');
  assertPreview(chosen);
  assert.equal(chosen.awaitingTrial, true);
  assert.equal(chosen.firstFreeRecipe, false);
  const pending = chosen.pendingFirstRecipe;
  assert.equal(pending.title, option.recipe.title);
  assert.equal(pending.selectedId, option.id);
  assert.equal(pending.source, 'dinner');
  assert.equal(pending.unlocked, false);
  assert.match(pending.recipeId, /^[0-9a-f-]{36}$/i);
  assert.deepEqual((await post(account, route + '/accept')).pendingFirstRecipe, pending);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM first_recipe_selections WHERE user_id=?').get(account.user.id).n, 1);
  assert.equal(getTrialStatus(account.user.id).used, false);
  const restarted = spawnSync(process.execPath, ['--input-type=module', '-e', `const {getPendingFirstRecipe}=await import('./src/subscriptions.js');console.log(JSON.stringify(getPendingFirstRecipe(${JSON.stringify(account.user.id)})));`], { encoding: 'utf8', env: process.env, cwd: process.cwd() });
  assert.equal(restarted.status, 0, restarted.stderr);
  assert.deepEqual(JSON.parse(restarted.stdout), pending);
  const offer = await call(account, '/api/billing/offer');
  assert.deepEqual(offer.pendingFirstRecipe, pending);
  assert.equal(offer.firstRecipe.awaitingTrial, true);
  assert.equal(offer.firstRecipe.trialGateUsed, true);
  for (const endpoint of ['/api/library', '/api/recipes', '/api/search?q=' + encodeURIComponent(option.recipe.title)]) assertPreview(await call(account, endpoint));
  const recipePath = `/api/recipes/${pending.recipeId}`;
  const catalogPath = `/api/dinner/recipes/${encodeURIComponent(option.recipe.id)}`;
  for (const endpoint of [recipePath, catalogPath]) {
    assertPreview(await call(account, endpoint, { status: 402 }));
    assertPreview(await post(account, endpoint + '/share', {}, 402));
  }
  assertPreview(await call(account, recipePath, { method: 'PUT', body: { title: 'Attempt to edit' }, status: 402 }));
  assertPreview(await post(account, route + '/cooked', {}, 402));
  await call(foreign, recipePath, { status: 404 });
  await post(foreign, route + '/accept', {}, 404);
  const trial = await post(account, '/api/billing/trial');
  assert.equal(trial.pendingFirstRecipe.recipeId, pending.recipeId);
  assert.equal(trial.pendingFirstRecipe.unlocked, true);
  assert.equal(trial.firstRecipe.awaitingTrial, false);
  assert.equal(trial.trial.active, true);
  const deadline = trial.trial.expiresAt;
  assert.equal(Date.parse(deadline) - Date.parse(trial.trial.startsAt), 7 * 86400000);
  const repeated = await post(account, '/api/billing/trial');
  assert.equal(repeated.trial.expiresAt, deadline);
  assert.equal(repeated.pendingFirstRecipe.recipeId, pending.recipeId);
  const full = await call(account, recipePath);
  assert.equal(full.id, pending.recipeId);
  assert.equal(full.title, option.recipe.title);
  assert.ok(full.ingredients.length && full.steps.length);
  const original = await call(account, catalogPath);
  assert.deepEqual(full.ingredients, original.ingredients);
  assert.deepEqual(full.steps, original.steps);
  const shared = await post(account, recipePath + '/share');
  assert.ok(shared.token);
  db.prepare('UPDATE user_trials SET starts_at=?,expires_at=? WHERE user_id=?').run('2020-01-01', '2020-01-08', account.user.id);
  assert.ok((await call(account, recipePath)).steps.length, 'Unlocked first recipe survives trial expiry');
  await post(account, '/api/recipe-request', { query: 'Новый суп' }, 402);
  assert.equal((await post(account, '/api/billing/trial')).trial.expiresAt, '2020-01-08');
});

test('cached generated request materializes a locked UUID and all HTTP copies remain metadata-only', async () => {
  const account = fresh();
  const query = 'Закрытый рис';
  const key = `request:${JSON.stringify([query, null, []])}`;
  let suggestion;
  await withFirstRecipe(account.user.id, key, async () => {
    suggestion = createRecipeSuggestion(account.user.id, 'request:fixture', secretRecipe(query));
    return { kind: 'generated', query, suggestion };
  });
  const pending = getPendingFirstRecipe(account.user.id);
  assert.match(pending.recipeId, /^[0-9a-f-]{36}$/i);
  assert.equal(pending.source, 'request');
  assert.ok(getRecipe(account.user.id, pending.recipeId).steps[0].text.includes('SECRET_COOKING_STEP'));
  const replay = await post(account, '/api/recipe-request', { query });
  assertPreview(replay);
  assert.equal(replay.awaitingTrial, true);
  assert.equal(replay.pendingFirstRecipe.recipeId, pending.recipeId);
  assertPreview(await call(account, '/api/library'));
  assertPreview(await call(account, '/api/search?q=' + encodeURIComponent(query)));
  assertPreview(await call(account, `/api/suggestions/${suggestion.id}`, { status: 402 }));
  assertPreview(await post(account, `/api/suggestions/${suggestion.id}/save`, {}, 402));
  assertPreview(protectFirstRecipeResponse(account.user.id, { nested: [{ recipe: secretRecipe() }], reserve: [{ pantryMatch: { missing: ['SECRET_COOKING_STEP'] }, recipe: secretRecipe() }] }));
  await post(account, '/api/billing/trial');
  const full = await call(account, `/api/recipes/${pending.recipeId}`);
  assert.equal(full.ingredients[0].quantity, 876543);
  assert.equal(full.steps[0].text, 'SECRET_COOKING_STEP сварить рис');
  assert.equal((await call(account, `/api/suggestions/${suggestion.id}`)).recipe.steps[0].text, full.steps[0].text);
});

test('cached first import and library cannot reveal its stored recipe before trial', async () => {
  const account = fresh();
  const source = 'Fixture import text that must replay without normalization';
  const key = `import:${createHash('sha256').update(source).digest('hex')}`;
  await withFirstRecipe(account.user.id, key, async () => ({ state: 'created', recipe: createRecipe(account.user.id, { ...secretRecipe('Импортированный рис'), status: 'ready', sourceType: 'text' }) }));
  const pending = getPendingFirstRecipe(account.user.id);
  assert.equal(pending.source, 'import');
  const replay = await post(account, '/api/import', { kind: 'text', value: source }, 201);
  assertPreview(replay);
  assert.equal(replay.pendingFirstRecipe.recipeId, pending.recipeId);
  assertPreview(await call(account, '/api/library'));
  assertPreview(await call(account, `/api/recipes/${pending.recipeId}`, { status: 402 }));
  await post(account, '/api/billing/trial');
  const full = await call(account, `/api/recipes/${pending.recipeId}`);
  assert.equal(full.steps[0].text, 'SECRET_COOKING_STEP сварить рис');
  assert.equal(full.ingredients[0].quantity, 876543);
});

test('legacy previews and already delivered historical recipes keep their full read entitlement', async () => {
  const legacy = fresh();
  db.prepare('INSERT INTO first_dinner_previews(user_id) VALUES(?)').run(legacy.user.id);
  const { preview } = await dinnerPreview(legacy);
  assert.equal(db.prepare('SELECT trial_gate FROM first_dinner_previews WHERE user_id=?').get(legacy.user.id).trial_gate, 0);
  assert.ok(preview.recommendation.recipe.ingredients.length && preview.recommendation.recipe.steps.length);
  const selected = await post(legacy, `/api/dinner/recommendations/${preview.recommendation.id}/accept`);
  assert.equal(selected.firstFreeRecipe, true);
  assert.ok(selected.savedRecipe.steps.length);
  assert.equal(getPendingFirstRecipe(legacy.user.id), null);
  assert.ok((await call(legacy, `/api/recipes/${selected.savedRecipe.id}`)).steps.length);
  const delivered = fresh();
  const recipe = createRecipe(delivered.user.id, { ...secretRecipe('Старый рецепт'), status: 'ready' });
  db.prepare('INSERT INTO first_recipe_results(user_id,request_key,owner,started_at,result_json) VALUES(?,?,?,?,?)').run(delivered.user.id, 'old-request', 'legacy-owner', new Date().toISOString(), JSON.stringify({ recipe, firstFreeRecipe: true }));
  assert.equal(db.prepare('SELECT trial_required FROM first_recipe_results WHERE user_id=?').get(delivered.user.id).trial_required, 0);
  const full = await call(delivered, `/api/recipes/${recipe.id}`);
  assert.equal(full.ingredients[0].quantity, 876543);
  assert.equal(full.steps[0].text, 'SECRET_COOKING_STEP сварить рис');
  assert.equal(getTrialStatus(delivered.user.id).used, false);
  assert.equal((await call(delivered, '/api/library')).recipes[0].steps[0].text, full.steps[0].text);
});
