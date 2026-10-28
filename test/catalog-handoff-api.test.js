import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-handoff-api-'));
Object.assign(process.env, {
  DATABASE_PATH: path.join(directory, 'recipes.sqlite'), BOT_PLATFORM: 'telegram',
  TELEGRAM_BOT_TOKEN: '123456:catalog-api-fixture', TELEGRAM_POLLING: 'false',
  TEST_CONTOUR: 'false', BILLING_REQUIRED: 'false', APP_URL: 'https://recipes.example.test',
  DINNER_LLM_ENABLED: 'false', DINNER_IMAGES_ENABLED: 'false', OPENAI_API_KEY: 'unused-test-key'
});
const { db, upsertTelegramUser, allowUser, createRecipe } = await import('../src/db.js');
const { getTrialStatus, startTrial, requireDinnerEntry, stageFirstRecipe, getPendingFirstRecipe } = await import('../src/subscriptions.js');
const { saveCatalogRecipeForUser } = await import('../src/catalog-handoff.js');
const { createServer } = await import('../src/server.js');
const { makeTelegramInitData } = await import('../src/security.js');
let server, base, serial = 628330000;
const originalFetch = globalThis.fetch;
test.before(async () => {
  server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  globalThis.fetch = (url, options) => {
    assert.equal(new URL(url).origin, base, 'Saved public recipes must not make AI or external network calls');
    return originalFetch(url, options);
  };
});
test.after(async () => {
  globalThis.fetch = originalFetch;
  await new Promise(resolve => server.close(resolve));
  db.close(); fs.rmSync(directory, { recursive: true, force: true });
});
function fresh() {
  const telegram = { id: serial++, first_name: 'Catalog API fixture' };
  const user = upsertTelegramUser(telegram); allowUser(user.id);
  return { telegram, user };
}
async function call(account, route, { method = 'GET', body, status = 200 } = {}) {
  const response = await fetch(base + route, { method,
    headers: { authorization: `tma ${makeTelegramInitData(account.telegram, process.env.TELEGRAM_BOT_TOKEN)}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json();
  assert.equal(response.status, status, `${method} ${route}: ${JSON.stringify(result)}`);
  return result;
}

test('HTTP can reopen, share and edit a public saved recipe after trial expiration without AI', async () => {
  const account = fresh();
  startTrial(account.user.id, new Date('2020-01-01T00:00:00Z'));
  const trial = getTrialStatus(account.user.id);
  const saved = saveCatalogRecipeForUser(account.user.id, 'pasta-tomato').recipe;
  const route = `/api/recipes/${saved.id}`;
  const opened = await call(account, route);
  assert.equal(opened.id, saved.id);
  assert.equal(opened.publicCatalogSaved, true);
  assert.ok(opened.ingredients.length && opened.steps.length && opened.recipeViewToken);
  const shared = await call(account, route + '/share', { method: 'POST', body: {} });
  assert.match(shared.path, /^\/share\//);
  const edited = await call(account, route, { method: 'PUT', body: { ...saved, title: 'Мой рецепт пасты', ingredients: [{ name: 'Макароны', quantity: 150, unit: 'г' }] } });
  assert.equal(edited.title, 'Мой рецепт пасты');
  assert.equal(edited.publicCatalogSaved, true);
  assert.equal((await call(account, route)).ingredients[0].quantity, 150);
  assert.deepEqual(getTrialStatus(account.user.id), trial);
  await call(account, '/api/recipe-request', { method: 'POST', body: { query: 'Суп' }, status: 402 });
});

test('HTTP preserves one public recipe while unrelated staged first-recipe details remain inaccessible', async () => {
  const account = fresh();
  requireDinnerEntry(account.user.id);
  const privateRecipe = createRecipe(account.user.id, { title: 'Locked first recipe', status: 'ready', ingredients: [{ name: 'private ingredient' }], steps: [{ text: 'private step' }] });
  stageFirstRecipe(account.user.id, { recipe: privateRecipe, recipeId: privateRecipe.id, source: 'request' });
  const pending = getPendingFirstRecipe(account.user.id);
  const saved = saveCatalogRecipeForUser(account.user.id, 'pasta-tomato').recipe;
  const opened = await call(account, `/api/recipes/${saved.id}`);
  assert.ok(opened.ingredients.length && opened.steps.length);
  assert.equal(opened.publicCatalogSaved, true);
  assert.equal(opened.awaitingTrial, undefined);
  const library = await call(account, '/api/library');
  assert.ok(library.recipes.find(recipe => recipe.id === saved.id).steps.length);
  assert.equal(library.recipes.find(recipe => recipe.id === privateRecipe.id).steps, undefined);
  assert.match((await call(account, `/api/recipes/${saved.id}/share`, { method: 'POST', body: {} })).path, /^\/share\//);
  await call(account, `/api/recipes/${privateRecipe.id}`, { status: 402 });
  await call(account, `/api/recipes/${privateRecipe.id}/share`, { method: 'POST', body: {}, status: 402 });
  assert.deepEqual(getPendingFirstRecipe(account.user.id), pending);
  assert.equal(getTrialStatus(account.user.id).used, false);
});

test('HTTP authorization does not expose another account public-granted recipe', async () => {
  const owner = fresh(), other = fresh();
  const saved = saveCatalogRecipeForUser(owner.user.id, 'pasta-tomato').recipe;
  await call(other, `/api/recipes/${saved.id}`, { status: 404 });
  await call(other, `/api/recipes/${saved.id}/share`, { method: 'POST', body: {}, status: 404 });
});
