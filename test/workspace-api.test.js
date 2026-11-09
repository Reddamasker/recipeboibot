import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

const file = `data/workspace-api-${randomUUID()}.sqlite`;
const platform = process.env.WORKSPACE_TEST_PLATFORM === 'max' ? 'max' : 'telegram';
Object.assign(process.env, { DATABASE_PATH: file, BOT_PLATFORM: platform, TEST_CONTOUR: 'true',
  TELEGRAM_BOT_TOKEN: 'workspace-api-local-only', TELEGRAM_POLLING: 'false', BILLING_REQUIRED: 'false',
  MAX_BOT_TOKEN: 'workspace-max-api-local-only',
  APP_URL: 'https://test-recipes.example.test',
  DINNER_LLM_ENABLED: 'false', DINNER_IMAGES_ENABLED: 'false', OPENAI_API_KEY: 'disabled' });
const { db, upsertTelegramUser, allowUser, createRecipe, getRecipe, deleteUserData } = await import('../src/db.js');
const { createServer } = await import('../src/server.js');
const { makeTelegramInitData } = await import('../src/security.js');
const { getTrialStatus, requireDinnerEntry, stageFirstRecipe, getPendingFirstRecipe, isFirstRecipeAwaitingTrial } = await import('../src/subscriptions.js');
const { isPublicCatalogRecipe } = await import('../src/catalog-handoff.js');
let server, base, serial = 719300000;
function account() {
  const telegram = { id: serial++, first_name: 'Workspace API fixture' };
  const user = upsertTelegramUser(platform === 'max' ? { ...telegram, id: `max:${telegram.id}` } : telegram); allowUser(user.id);
  const token = platform === 'max' ? process.env.MAX_BOT_TOKEN : process.env.TELEGRAM_BOT_TOKEN;
  return { user, authorization: `${platform === 'max' ? 'mxa' : 'tma'} ${makeTelegramInitData(telegram, token)}` };
}
function recipe(user) {
  return createRecipe(user.id, { status: 'ready', title: 'Локальный рис', servings: 2,
    ingredients: [{ name: 'рис', quantity: 200, unit: 'г', raw: '200 г риса' }],
    steps: [{ text: 'Сварить', position: 1 }] });
}
async function request(who, body, expected = 200) {
  const response = await fetch(base + '/api/workspace', { method: body ? 'POST' : 'GET',
    headers: { ...(who ? { authorization: who.authorization } : {}), 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  const value = await response.json();
  assert.equal(response.status, expected, JSON.stringify(value)); return value;
}
const command = (expectedVersion, action, fields = {}) => ({ operationId: randomUUID(), expectedVersion, action, ...fields });
test.before(async () => {
  server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  await new Promise(resolve => server.close(resolve)); db.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
});

test('workspace HTTP requires signed identity and preserves account isolation', async () => {
  await request(null, null, 401);
  const a = account(), b = account(), saved = recipe(a.user);
  assert.equal((await request(a)).version, 0);
  const create = command(0, 'collections.create', { name: 'Ужины' });
  const first = await request(a, create);
  assert.equal(first.collections[0].name, 'Ужины');
  const replay = await request(a, create);
  assert.equal(replay.version, first.version); assert.equal(replay.operation.replayed, true);
  const stale = await request(a, command(0, 'collections.create', { name: 'Завтраки' }), 409);
  assert.equal(stale.code, 'VERSION_CONFLICT'); assert.equal(stale.currentVersion, first.version);
  await request(a, { ...create, name: 'Другое имя' }, 409);
  await request(b, command(0, 'plan.add', { date: '2026-11-10', meal: 'dinner', recipeId: saved.id, servings: 4 }), 404);
  const second = await request(b);
  assert.equal(second.version, 0); assert.equal(second.collections.length, 0); assert.equal(second.plan.length, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM product_events WHERE user_id=? AND event='workspace_saved'").get(a.user.id).n, 1);
  const detail = db.prepare("SELECT detail_json FROM product_events WHERE user_id=? AND event='workspace_saved'").get(a.user.id).detail_json;
  assert.ok(!detail.includes('Ужины')); assert.equal(JSON.parse(detail).feature, 'collections');
});

test('workspace recipe use respects first-recipe lock and never alters originals', async () => {
  const a = account(), saved = recipe(a.user), original = getRecipe(a.user.id, saved.id);
  db.prepare('INSERT INTO first_dinner_previews(user_id,trial_gate) VALUES(?,1)').run(a.user.id);
  await request(a, command(0, 'plan.add', { date: '2026-11-10', meal: 'lunch', recipeId: saved.id, servings: 4 }), 402);
  assert.equal((await request(a)).version, 0);
  // Standalone personal groceries remain available without opening a locked recipe.
  const manual = await request(a, command(0, 'groceries.addManual', { name: 'Хлеб', quantity: 1, unit: 'шт' }));
  assert.equal(manual.groceries.items.length, 1);
  assert.deepEqual(getRecipe(a.user.id, saved.id), original);
  deleteUserData(a.user.id);
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
});

test('an empty library can save a catalog recipe and use it for meals and groceries without trial or AI', async () => {
  const a = account(), previousFetch = globalThis.fetch;
  const providerRequests = db.prepare('SELECT COUNT(*) n FROM provider_requests').get().n;
  const reservations = db.prepare('SELECT COUNT(*) n FROM ai_reservations').get().n;
  globalThis.fetch = (url, options) => {
    assert.equal(new URL(url).origin, base, 'catalog saving must make no external network or AI request');
    return previousFetch(url, options);
  };
  try {
    const save = command(0, 'collections.saveCatalog', { catalogId: 'pasta-tomato' });
    const first = await request(a, save), id = first.operation.result.recipeId;
    assert.ok(id); assert.equal(first.version, 1);
    assert.deepEqual(first.operation.result, { changed: true, count: 1, recipeId: id });
    assert.equal(isPublicCatalogRecipe(a.user.id, id), true);
    const original = getRecipe(a.user.id, id);
    assert.ok(original.ingredients.length && original.steps.length);
    const replay = await request(a, save);
    assert.equal(replay.operation.replayed, true); assert.equal(replay.operation.result.recipeId, id);
    const repeated = await request(a, command(1, 'collections.saveCatalog', { catalogId: 'pasta-tomato' }));
    assert.equal(repeated.version, 1); assert.equal(repeated.operation.result.changed, false);
    assert.equal(repeated.operation.result.recipeId, id);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM recipes WHERE user_id=?').get(a.user.id).n, 1);
    let snapshot = await request(a, command(1, 'plan.add', { recipeId: id, date: '2026-11-10', meal: 'dinner', servings: 4 }));
    snapshot = await request(a, command(snapshot.version, 'groceries.fromPlan', { entryIds: [snapshot.plan[0].id] }));
    assert.ok(snapshot.groceries.items.length); assert.equal(snapshot.groceries.sources[0].recipeId, id);
    assert.deepEqual(getRecipe(a.user.id, id), original);
    db.prepare("UPDATE recipes SET status='archived' WHERE id=?").run(id);
    const restored = await request(a, command(snapshot.version, 'collections.saveCatalog', { catalogId: 'pasta-tomato' }));
    assert.equal(restored.version, snapshot.version + 1); assert.equal(restored.operation.result.changed, true);
    assert.equal(restored.operation.result.recipeId, id); assert.equal(getRecipe(a.user.id, id).status, 'ready');
    assert.equal(getTrialStatus(a.user.id).used, false);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM provider_requests').get().n, providerRequests);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM ai_reservations').get().n, reservations);
    const savedEvents = db.prepare("SELECT detail_json FROM product_events WHERE user_id=? AND event='workspace_saved' AND detail_json LIKE '%saveCatalog%'").all(a.user.id);
    assert.equal(savedEvents.length, 3, 'replay adds no server analytics event');
    assert.ok(savedEvents.every(row => row.detail_json === JSON.stringify({ feature: 'collections', action: 'collections.saveCatalog' })));
  } finally { globalThis.fetch = previousFetch; }
});

test('catalog grants leave a different first recipe locked and never cross user accounts', async () => {
  const a = account(), b = account();
  requireDinnerEntry(a.user.id);
  const locked = recipe(a.user);
  stageFirstRecipe(a.user.id, { recipe: locked, recipeId: locked.id, source: 'request' });
  const pending = getPendingFirstRecipe(a.user.id);
  const save = command(0, 'collections.saveCatalog', { catalogId: 'pasta-tomato' });
  const first = await request(a, save), id = first.operation.result.recipeId;
  assert.equal(isFirstRecipeAwaitingTrial(a.user.id), true);
  assert.deepEqual(getPendingFirstRecipe(a.user.id), pending);
  await request(a, command(first.version, 'plan.add', { recipeId: locked.id, date: '2026-11-10', meal: 'dinner' }), 402);
  const groceries = await request(a, command(first.version, 'groceries.fromRecipe', { recipeId: id }));
  assert.ok(groceries.groceries.items.length);
  await request(b, command(0, 'groceries.fromRecipe', { recipeId: id }), 404);
  const other = await request(b, save);
  assert.notEqual(other.operation.result.recipeId, id); assert.equal(other.operation.replayed, false);
  assert.equal(getRecipe(b.user.id, id), null); assert.equal(isPublicCatalogRecipe(b.user.id, id), false);
  assert.equal(getTrialStatus(a.user.id).used, false); assert.equal(getTrialStatus(b.user.id).used, false);
});

test('catalog saving rejects unknown ids and client recipe contents before writing', async () => {
  const a = account();
  for (const catalogId of [null, 123, '../private', ' pasta-tomato', 'https://example.test/recipe'])
    await request(a, command(0, 'collections.saveCatalog', { catalogId }), 400);
  await request(a, command(0, 'collections.saveCatalog', { catalogId: 'missing-catalog-recipe' }), 404);
  await request(a, command(0, 'collections.saveCatalog', { catalogId: 'pasta-tomato', recipe: { title: 'Client override' } }), 400);
  await request(a, command(1, 'collections.saveCatalog', { catalogId: 'pasta-tomato' }), 409);
  assert.equal((await request(a)).version, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM recipes WHERE user_id=?').get(a.user.id).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM recipe_workspace_operations WHERE user_id=?').get(a.user.id).n, 0);
});

test('catalog recipe, grant, version and operation roll back together on failed commit', async () => {
  const a = account(), save = command(0, 'collections.saveCatalog', { catalogId: 'pasta-tomato' });
  db.exec("CREATE TEMP TRIGGER reject_workspace_catalog BEFORE INSERT ON recipe_workspace_operations BEGIN SELECT RAISE(ABORT,'workspace catalog failure'); END");
  try { await request(a, save, 500); } finally { db.exec('DROP TRIGGER reject_workspace_catalog'); }
  assert.equal((await request(a)).version, 0);
  for (const table of ['recipes', 'catalog_recipe_grants', 'catalog_onboarding', 'recipe_workspaces', 'recipe_workspace_operations'])
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE user_id=?`).get(a.user.id).n, 0, table);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM product_events WHERE user_id=? AND event='workspace_saved'").get(a.user.id).n, 0);
  const retry = await request(a, save);
  assert.equal(retry.version, 1); assert.equal(retry.operation.replayed, false);
  assert.ok(getRecipe(a.user.id, retry.operation.result.recipeId));
});

if (platform === 'telegram') test('test polling setup preserves the workspace entry after a future authorized release', async () => {
  const { configureTelegramMenuButton } = await import('../src/telegram.js');
  const previous = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ method: new URL(url).pathname.split('/').at(-1), body: JSON.parse(options.body) });
    return { json: async () => ({ ok: true, result: true }) };
  };
  try {
    await configureTelegramMenuButton();
    const menu = calls.find(call => call.method === 'setChatMenuButton').body.menu_button;
    const url = new URL(menu.web_app.url);
    assert.equal(url.origin, 'https://test-recipes.example.test');
    assert.equal(url.pathname, '/review/recime-20261109/index.html');
    assert.equal(url.searchParams.get('view'), 'collection');
  } finally { globalThis.fetch = previous; }
});
