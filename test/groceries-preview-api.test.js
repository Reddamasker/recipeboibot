import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

const file = `data/groceries-preview-api-${randomUUID()}.sqlite`;
const platform = process.env.WORKSPACE_TEST_PLATFORM === 'max' ? 'max' : 'telegram';
Object.assign(process.env, { DATABASE_PATH: file, BOT_PLATFORM: platform, TEST_CONTOUR: 'true', TELEGRAM_BOT_TOKEN: 'groceries-preview-local-only',
  TELEGRAM_POLLING: 'false', MAX_BOT_TOKEN: 'groceries-preview-max-only', BILLING_REQUIRED: 'false', APP_URL: 'https://test-recipes.example.test',
  DINNER_LLM_ENABLED: 'false', DINNER_IMAGES_ENABLED: 'false', OPENAI_API_KEY: 'disabled', OPENAI_HTTPS_PROXY: '' });
const { db, upsertTelegramUser, allowUser, createRecipe, getRecipe } = await import('../src/db.js');
const { createServer } = await import('../src/server.js');
const { makeTelegramInitData } = await import('../src/security.js');
const { stageSelection } = await import('../src/first-recipe-selection.js');
const { grantSubscription } = await import('../src/subscriptions.js');
let server, base, serial = 719500000;
const sign = telegram => `${platform === 'max' ? 'mxa' : 'tma'} ${makeTelegramInitData(telegram, platform === 'max' ? process.env.MAX_BOT_TOKEN : process.env.TELEGRAM_BOT_TOKEN)}`;
function account() {
  const telegram = { id: serial++, first_name: 'Groceries preview fixture' }, user = upsertTelegramUser(platform === 'max' ? { ...telegram, id: `max:${telegram.id}` } : telegram);
  allowUser(user.id);return { user, authorization: sign(telegram) };
}
const recipe = (user, fields = {}) => createRecipe(user.id, { status: 'ready', title: 'Личный рис', servings: 2, ingredients: [{ name: 'Рис', quantity: 200, unit: 'г' }, { name: 'Соль', quantity: null, comment: 'по вкусу' }], steps: [{ text: 'Сварить' }], ...fields });
const command = (expectedVersion, action, data = {}) => ({ action, operationId: randomUUID(), expectedVersion, ...data });
async function request(who, route, body, status = 200, method = 'POST') {
  const response = await fetch(base + route, { method, headers: { ...(who ? { authorization: who.authorization } : {}), 'content-type': 'application/json' }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) });
  const value = await response.json();assert.equal(response.status, status, JSON.stringify(value));return value;
}
const preview = (who, body, status = 200, method) => request(who, '/api/workspace/groceries-preview', body, status, method);
const mutate = (who, body, status = 200) => request(who, '/api/workspace', body, status);
const pick = entry => ({ entryId: entry.entryId, servings: entry.servings, ingredientKeys: entry.selectedIngredientKeys, recipeRevision: entry.recipeRevision });
function databaseRows() {
  return Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({name})=>[name,
    db.prepare('SELECT * FROM "'+name.replaceAll('"','""')+'"').all().map(row=>JSON.stringify(row,(_,value)=>typeof value==='bigint'?String(value):value)).sort()]));
}
test.before(async () => { server = createServer();await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));base = `http://127.0.0.1:${server.address().port}`; });
test.after(async () => { await new Promise(resolve => server.close(resolve));db.close();for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true }); });

test('authenticated preview is strictly read-only including account timestamps, private mapping and all analytics', async () => {
  const a = account(), b = account(), saved = recipe(a.user), foreign = recipe(b.user, { servings: null });
  const before = databaseRows(), beforeChanges = db.prepare('SELECT total_changes() n').get().n, previousFetch = globalThis.fetch;
  globalThis.fetch = (url, options) => { assert.equal(new URL(url).origin, base, 'Preview must never call an external service or AI');return previousFetch(url, options); };
  try {
    await preview(null, { recipeId: saved.id }, 401);
    await preview({ authorization: sign({ id: serial++, first_name: 'Not registered' }) }, { recipeId: saved.id }, 403);
    await preview(a, { recipeId: saved.id }, 405, 'GET');
    await preview(b, { recipeId: saved.id }, 404);
    await preview(a, { recipeId: saved.id, entryIds: [] }, 400);
    const p = await preview(a, { recipeId: saved.id, servings: 4 });
    assert.equal(p.version, 0);assert.equal(p.entries[0].ingredients[0].quantity, 400);assert.equal(p.entries[0].servings, 4);
    assert.equal(p.entries[0].entryId, null);assert.equal(p.entries[0].ingredients[1].quantity, null);assert.equal(p.entries[0].ingredients[1].amountText, 'по вкусу');
    assert.deepEqual(databaseRows(), before);assert.equal(db.prepare('SELECT total_changes() n').get().n, beforeChanges);
    db.prepare('INSERT INTO private_test_profiles(owner_user_id,test_user_id,created_at) VALUES(?,?,?)').run(a.user.id, b.user.id, new Date().toISOString());
    const mappedBefore = databaseRows();
    await preview(a, { recipeId: saved.id }, 404);
    const mapped = await preview(a, { recipeId: foreign.id });assert.equal(mapped.entries[0].recipeId, foreign.id);assert.equal(mapped.entries[0].servings, null);
    assert.deepEqual(databaseRows(), mappedBefore);
  } finally { globalThis.fetch = previousFetch; }
});

test('preview preserves first-recipe gates and catalog grants without unlocking a pending selection', async () => {
  const a = account(), saved = recipe(a.user);
  db.prepare('INSERT INTO first_dinner_previews(user_id,trial_gate) VALUES(?,1)').run(a.user.id);
  stageSelection(a.user.id, { recipe: saved, recipeId: saved.id, source: 'request' });
  const lockedBefore = databaseRows();await preview(a, { recipeId: saved.id }, 402);assert.deepEqual(databaseRows(), lockedBefore);
  const grant = await mutate(a, command(0, 'collections.saveCatalog', { catalogId: 'pasta-tomato' }));
  const grantedBefore = databaseRows(), publicId = grant.operation.result.recipeId;
  const catalog = await preview(a, { recipeId: publicId });assert.ok(catalog.entries[0].ingredients.length, 'A granted public recipe must not be redacted as a locked personal recipe');
  assert.deepEqual(databaseRows(), grantedBefore);await preview(a, { recipeId: saved.id }, 402);
  grantSubscription(a.user.id, 'subscription', new Date(Date.now() + 86400000).toISOString());
  db.prepare('UPDATE first_recipe_selections SET unlocked_at=NULL WHERE user_id=?').run(a.user.id);
  const subscribedBefore = databaseRows(), changes = db.prepare('SELECT total_changes() n').get().n;
  assert.ok((await preview(a, { recipeId: saved.id })).entries[0].ingredients.length);
  assert.deepEqual(databaseRows(), subscribedBefore);assert.equal(db.prepare('SELECT total_changes() n').get().n, changes);
  assert.equal(db.prepare('SELECT unlocked_at FROM first_recipe_selections WHERE user_id=?').get(a.user.id).unlocked_at, null);
});

test('HTTP selected grocery save freezes version, rejects changed recipes, replays once and sends no private analytics fields', async () => {
  const a = account(), saved = recipe(a.user), original = getRecipe(a.user.id, saved.id);
  let s = await mutate(a, command(0, 'plan.add', { recipeId: saved.id, date: '2026-11-12', servings: 2 }));
  const entryId = s.plan[0].id;
  let p = await preview(a, { entryIds: [entryId] });
  await mutate(a, command(s.version, 'groceries.addManual', { name: 'Молоко', quantity: 1, unit: 'л' }));
  const old = command(p.version, 'groceries.fromPlan', { entryIds: [entryId], selections: [pick(p.entries[0])] });
  const conflict = await mutate(a, old, 409);assert.equal(conflict.code, 'VERSION_CONFLICT');
  p = await preview(a, { entryIds: [entryId] });
  const choice = { ...pick(p.entries[0]), servings: 4, ingredientKeys: [p.entries[0].ingredients[0].key] };
  const save = command(p.version, 'groceries.fromPlan', { entryIds: [entryId], selections: [choice] });
  s = await mutate(a, save);assert.equal(s.groceries.items.find(i => !i.manual).quantity, 400);assert.equal(s.plan[0].servings, 2);
  assert.equal(s.groceries.items.some(i => i.name === 'Соль'), false);assert.ok(s.groceries.items.some(i => i.manual));
  assert.equal((await mutate(a, save)).operation.replayed, true);assert.deepEqual(getRecipe(a.user.id, saved.id), original);
  p = await preview(a, { recipeId: saved.id });
  db.prepare('UPDATE recipes SET servings=3 WHERE id=?').run(saved.id);
  const stale = await mutate(a, command(s.version, 'groceries.fromRecipe', { recipeId: saved.id, ingredientKeys: p.entries[0].selectedIngredientKeys, recipeRevision: p.entries[0].recipeRevision }), 409);
  assert.equal(stale.code, 'RECIPE_CHANGED');
  const events = db.prepare("SELECT id,detail_json FROM product_events WHERE user_id=? AND event='workspace_saved'").all(a.user.id);
  assert.equal(events.length, 3);assert.equal(events.filter(event => event.id === 'workspace-' + save.operationId).length, 1);
  assert.ok(events.every(event => Object.keys(JSON.parse(event.detail_json)).sort().join(',') === 'action,feature'));
  for (const table of ['provider_requests','recipe_engagement']) assert.equal(db.prepare('SELECT COUNT(*) n FROM '+table+' WHERE user_id=?').get(a.user.id).n, 0);
});

test('HTTP accepts one preview and one atomic selection for 60 entries with a payload above 64KB', async () => {
  const a = account(), saved = recipe(a.user, { ingredients: Array.from({ length: 20 }, (_,i) => ({ name: 'Продукт ' + i, quantity: 1, unit: 'г' })) });
  const state = await mutate(a, command(0, 'plan.apply', { entries: Array.from({ length: 60 }, (_,i) => ({ recipeId: saved.id, date: new Date(Date.UTC(2026, 10, 1 + i)).toISOString().slice(0,10) })) }));
  const p = await preview(a, { entryIds: state.plan.map(entry => entry.id) });assert.equal(p.entries.length, 60);
  const save = command(p.version, 'groceries.fromPlan', { entryIds: p.entries.map(entry => entry.entryId), selections: p.entries.map(pick) });assert.ok(Buffer.byteLength(JSON.stringify(save)) > 64000);
  const result = await mutate(a, save);assert.equal(result.operation.result.count, 60);assert.equal(result.groceries.sources.length, 60);assert.equal(result.groceries.items[0].quantity, 60);
});
