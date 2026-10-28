import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-handoff-'));
Object.assign(process.env, {
  DATABASE_PATH: path.join(directory, 'recipes.sqlite'), BOT_PLATFORM: 'telegram',
  TELEGRAM_BOT_TOKEN: '123456:catalog-fixture', TELEGRAM_POLLING: 'false',
  TEST_CONTOUR: 'false', BILLING_REQUIRED: 'false', APP_URL: 'https://recipes.example.test',
  DINNER_LLM_ENABLED: 'false', DINNER_IMAGES_ENABLED: 'false', OPENAI_API_KEY: 'unused-test-key'
});
const { db, upsertTelegramUser, createRecipe, getRecipe, updateRecipe, archiveRecipe, listRecipes } = await import('../src/db.js');
const { getFoodProfile, saveFoodProfile } = await import('../src/dinner-store.js');
const { saveCatalogRecipeForUser, isPublicCatalogRecipe, publicCatalogRecipeIds, hasCatalogFirstRecipe } = await import('../src/catalog-handoff.js');
const { getTrialStatus, startTrial, getFirstRecipeStatus, requireDinnerEntry, stageFirstRecipe,
  isFirstRecipeAwaitingTrial, getPendingFirstRecipe, assertFirstRecipeReadable, protectFirstRecipeResponse,
  requireRecipeEntry, grantSubscription, getSubscriptionAccess } = await import('../src/subscriptions.js');

let serial = 628310000;
const fresh = () => upsertTelegramUser({ id: serial++, first_name: 'Catalog fixture' });
const flowId = 'catalog_fixture_flow_0001';
const originalFetch = globalThis.fetch;
test.before(() => { globalThis.fetch = () => assert.fail('Catalog saving must never use a network or AI provider'); });
test.after(() => { globalThis.fetch = originalFetch; db.close(); fs.rmSync(directory, { recursive: true, force: true }); });

test('a public recipe is saved fully without trial or answering a profile questionnaire', () => {
  const user = fresh(), profile = getFoodProfile(user.id);
  const result = saveCatalogRecipeForUser(user.id, 'pasta-tomato', { flowId });
  assert.equal(result.created, true);
  assert.ok(result.recipe.ingredients.length && result.recipe.steps.length);
  assert.equal(result.recipe.publicCatalogSaved, true);
  assert.equal(getTrialStatus(user.id).used, false);
  assert.deepEqual(getFoodProfile(user.id), profile);
  assert.equal(hasCatalogFirstRecipe(user.id), true);
  assert.equal(getFirstRecipeStatus(user.id).available, false);
  assert.equal(getFirstRecipeStatus(user.id).catalogObtained, true);
  assert.deepEqual(getFirstRecipeStatus(user.id).publicCatalogRecipeIds, [result.recipe.id]);
  assert.doesNotThrow(() => assertFirstRecipeReadable(user.id, { recipeId: result.recipe.id }));
  assert.throws(() => requireRecipeEntry(user.id), { status: 402 });
  assert.throws(() => requireDinnerEntry(user.id), { status: 402 });
});

test('repeated links and a process restart reuse the same saved recipe and grant', () => {
  const user = fresh();
  const first = saveCatalogRecipeForUser(user.id, 'pasta-tomato', { flowId });
  const second = saveCatalogRecipeForUser(user.id, 'pasta-tomato', { flowId: 'catalog_fixture_flow_0002' });
  assert.equal(second.created, false);
  assert.equal(second.recipe.id, first.recipe.id);
  const restarted = spawnSync(process.execPath, ['--input-type=module', '-e',
    `const {saveCatalogRecipeForUser}=await import('./src/catalog-handoff.js');console.log(JSON.stringify(saveCatalogRecipeForUser(${JSON.stringify(user.id)},'pasta-tomato')));`], { encoding: 'utf8', env: process.env });
  assert.equal(restarted.status, 0, restarted.stderr);
  assert.equal(JSON.parse(restarted.stdout).recipe.id, first.recipe.id);
  assert.equal(listRecipes(user.id).length, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM catalog_recipe_grants WHERE user_id=?').get(user.id).n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM catalog_onboarding WHERE user_id=?').get(user.id).n, 1);
  archiveRecipe(user.id, first.recipe.id);
  const restored = saveCatalogRecipeForUser(user.id, 'pasta-tomato');
  assert.equal(restored.recipe.id, first.recipe.id);
  assert.equal(restored.recipe.status, 'ready');
});

test('saving preserves expired trial, active paid access and an existing food profile', () => {
  const expired = fresh(), paid = fresh();
  startTrial(expired.id, new Date('2020-01-01T00:00:00Z'));
  const before = getTrialStatus(expired.id);
  const profile = { ...getFoodProfile(expired.id), householdSize: 3, excludedIngredients: ['орехи'], onboardingCompleted: true, tastePreferencesStatus: 'completed' };
  saveFoodProfile(expired.id, profile);
  const existingProfile = getFoodProfile(expired.id);
  saveCatalogRecipeForUser(expired.id, 'pasta-tomato');
  assert.deepEqual(getTrialStatus(expired.id), before);
  assert.deepEqual(getFoodProfile(expired.id), existingProfile);
  grantSubscription(paid.id, 'subscription', new Date(Date.now() + 86400000).toISOString());
  const access = getSubscriptionAccess(paid.id);
  saveCatalogRecipeForUser(paid.id, 'pasta-tomato');
  assert.deepEqual(getSubscriptionAccess(paid.id), access);
  assert.equal(getTrialStatus(paid.id).used, false);
});

test('a personally edited saved copy is preserved while a repeated site selection saves its canonical recipe once', () => {
  const user = fresh();
  const original = saveCatalogRecipeForUser(user.id, 'pasta-tomato').recipe;
  updateRecipe(user.id, original.id, { ...original, title: 'Моя версия без помидоров', ingredients: [{ name: 'Макароны', quantity: 200, unit: 'г' }] });
  const edited = getRecipe(user.id, original.id);
  const selected = saveCatalogRecipeForUser(user.id, 'pasta-tomato');
  assert.notEqual(selected.recipe.id, original.id);
  assert.equal(selected.recipe.title, original.title);
  assert.deepEqual(selected.recipe.ingredients, original.ingredients);
  assert.deepEqual(getRecipe(user.id, original.id), edited);
  assert.equal(isPublicCatalogRecipe(user.id, original.id), true);
  assert.equal(isPublicCatalogRecipe(user.id, selected.recipe.id), true);
  assert.equal(saveCatalogRecipeForUser(user.id, 'pasta-tomato').recipe.id, selected.recipe.id);
  assert.equal(listRecipes(user.id).length, 2);
});

test('a public grant never unlocks a different first recipe waiting for trial', () => {
  const user = fresh();
  requireDinnerEntry(user.id);
  const locked = createRecipe(user.id, { title: 'Private chosen recipe', status: 'ready', ingredients: [{ name: 'Private ingredient' }], steps: [{ text: 'Private step' }] });
  stageFirstRecipe(user.id, { recipe: locked, recipeId: locked.id, source: 'request' });
  const before = getPendingFirstRecipe(user.id);
  const saved = saveCatalogRecipeForUser(user.id, 'pasta-tomato').recipe;
  assert.equal(isFirstRecipeAwaitingTrial(user.id), true);
  assert.deepEqual(getPendingFirstRecipe(user.id), before);
  assert.doesNotThrow(() => assertFirstRecipeReadable(user.id, { recipeId: saved.id }));
  assert.throws(() => assertFirstRecipeReadable(user.id, { recipeId: locked.id }), { status: 402 });
  assert.throws(() => requireRecipeEntry(user.id), { status: 402 });
  const response = protectFirstRecipeResponse(user.id, { recipes: [saved, locked] });
  assert.ok(response.recipes[0].ingredients.length);
  assert.equal(response.recipes[0].publicCatalogSaved, true);
  assert.equal(response.recipes[1].ingredients, undefined);
  assert.equal(response.recipes[1].previewOnly, true);
  assert.ok(protectFirstRecipeResponse(user.id, getRecipe(user.id, saved.id)).steps.length);
  assert.equal(getTrialStatus(user.id).used, false);
});

test('editing recipe provenance or using another account cannot forge a public grant', () => {
  const user = fresh(), other = fresh();
  requireDinnerEntry(user.id);
  const forged = createRecipe(user.id, { title: 'Not public', status: 'ready', sourceType: 'catalog', sourceKey: 'dinner-choice:seed:pasta-tomato', ingredients: [{ name: 'private' }], steps: [{ text: 'private' }] });
  stageFirstRecipe(user.id, { recipe: forged, recipeId: forged.id, source: 'request' });
  assert.equal(isPublicCatalogRecipe(user.id, forged.id), false);
  assert.throws(() => assertFirstRecipeReadable(user.id, { recipeId: forged.id }), { status: 402 });
  const saved = saveCatalogRecipeForUser(other.id, 'pasta-tomato').recipe;
  assert.equal(isPublicCatalogRecipe(user.id, saved.id), false);
  assert.deepEqual(publicCatalogRecipeIds(user.id), []);
  assert.throws(() => saveCatalogRecipeForUser(user.id, '../private'), { status: 404 });
  assert.equal(hasCatalogFirstRecipe(user.id), false);
});

test('a failed persistence transaction leaves neither a partial saved recipe nor a completed milestone', () => {
  const user = fresh();
  db.exec("CREATE TEMP TRIGGER reject_catalog_grant BEFORE INSERT ON catalog_recipe_grants BEGIN SELECT RAISE(ABORT,'fixture grant failure'); END");
  try { assert.throws(() => saveCatalogRecipeForUser(user.id, 'pasta-tomato'), /fixture grant failure/); }
  finally { db.exec('DROP TRIGGER reject_catalog_grant'); }
  assert.equal(listRecipes(user.id).length, 0);
  assert.equal(hasCatalogFirstRecipe(user.id), false);
  assert.equal(getFirstRecipeStatus(user.id).available, true);
  assert.equal(getTrialStatus(user.id).used, false);
});

test('recipe deletion removes its grant without reintroducing the first-recipe questionnaire', () => {
  const user = fresh();
  const saved = saveCatalogRecipeForUser(user.id, 'pasta-tomato').recipe;
  db.prepare('DELETE FROM recipes WHERE user_id=? AND id=?').run(user.id, saved.id);
  assert.equal(isPublicCatalogRecipe(user.id, saved.id), false);
  assert.equal(hasCatalogFirstRecipe(user.id), true);
  assert.equal(getFirstRecipeStatus(user.id).available, false);
  db.prepare('DELETE FROM users WHERE id=?').run(user.id);
  assert.equal(hasCatalogFirstRecipe(user.id), false);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});
