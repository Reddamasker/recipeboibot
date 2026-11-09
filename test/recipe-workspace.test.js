import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { createRecipeWorkspace } from '../src/recipe-workspace.js';

function fixture(t, options = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id TEXT PRIMARY KEY);
    CREATE TABLE recipes(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL,title TEXT NOT NULL,servings REAL,ingredients_json TEXT NOT NULL,
      thumbnail_url TEXT,updated_at TEXT NOT NULL);`);
  t.after(() => db.close());
  const user = randomUUID(), stranger = randomUUID();
  db.prepare('INSERT INTO users VALUES(?)').run(user); db.prepare('INSERT INTO users VALUES(?)').run(stranger);
  let tick = 0;
  const store = createRecipeWorkspace(db, { now: () => new Date(Date.parse('2026-11-09T12:00:00Z') + tick++ * 1000).toISOString(), ...options });
  const add = ({ owner = user, title = 'Рис с овощами', servings = 2, ingredients = [{ name: 'Рис', quantity: 200, unit: 'г' }], status = 'ready' } = {}) => {
    const id = randomUUID();
    db.prepare('INSERT INTO recipes VALUES(?,?,?,?,?,?,?,?)').run(id, owner, status, title, servings, JSON.stringify(ingredients), '/assets/dinner/rice.jpg', '2026-11-09T10:00:00.000Z');
    return id;
  };
  const command = (action, data = {}, owner = user) => store.mutate(owner, { action, operationId: randomUUID(), expectedVersion: store.read(owner).version, ...data });
  const editIngredients = (recipeId, ingredients) => db.prepare('UPDATE recipes SET ingredients_json=?,updated_at=? WHERE id=?').run(JSON.stringify(ingredients), '2026-11-09T15:00:00.000Z', recipeId);
  return { db, store, user, stranger, add, command, editIngredients };
}

test('collections retain real recipes across rename, many memberships and deletion', t => {
  const f = fixture(t), a = f.add(), b = f.add({ title: 'Суп' });
  let s = f.command('collections.create', { name: 'Ужины', recipeIds: [a, a] });
  const first = s.collections[0].id;
  assert.deepEqual(s.collections[0].recipeIds, [a]);
  s = f.command('collections.create', { name: 'Быстро', recipeIds: [a, b] });
  assert.equal(s.collections.length, 2);
  s = f.command('collections.rename', { collectionId: first, name: 'На неделю' });
  assert.equal(s.collections.find(c => c.id === first).name, 'На неделю');
  assert.throws(() => f.command('collections.rename', { collectionId: first, name: 'быстро' }), { code: 'COLLECTION_NAME_EXISTS' });
  s = f.command('collections.setRecipes', { collectionId: first, recipeIds: [b] });
  assert.deepEqual(s.collections.find(c => c.id === first).recipeIds, [b]);
  s = f.command('collections.delete', { collectionId: first });
  assert.equal(s.collections.length, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM recipes').get().n, 2);
  const reopened = createRecipeWorkspace(f.db).read(f.user);
  assert.deepEqual(reopened, f.store.read(f.user));
});

test('catalog callback is injected, synchronous, owner checked and rolled back with the workspace', t => {
  const f = fixture(t), foreign = f.add({ owner: f.stranger });
  assert.throws(() => f.command('collections.saveCatalog', { catalogId: 'pasta-tomato' }), { code: 'CATALOG_UNAVAILABLE' });
  let calls = 0;
  const store = createRecipeWorkspace(f.db, { saveCatalogRecipe(userId, catalogId, options) {
    calls++; assert.equal(userId, f.user); assert.equal(catalogId, 'pasta-tomato'); assert.ok(options.flowId);
    f.add(); return { recipe: { id: foreign } };
  } });
  const command = { operationId: randomUUID(), expectedVersion: 0, action: 'collections.saveCatalog', catalogId: 'pasta-tomato' };
  assert.throws(() => store.mutate(f.user, command), { code: 'RECIPE_NOT_FOUND' });
  assert.equal(calls, 1); assert.equal(f.db.prepare('SELECT COUNT(*) n FROM recipes WHERE user_id=?').get(f.user).n, 0);
  assert.equal(store.read(f.user).version, 0);
  const asyncStore = createRecipeWorkspace(f.db, { saveCatalogRecipe: () => Promise.resolve({ recipe: { id: foreign } }) });
  assert.throws(() => asyncStore.mutate(f.user, command), /must be synchronous/);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM recipe_workspace_operations').get().n, 0);
});

test('operation replay is independent of current version and mismatched reuse cannot mutate', t => {
  const f = fixture(t), operation = { action: 'collections.create', name: 'Одна', operationId: randomUUID(), expectedVersion: 0 };
  const first = f.store.mutate(f.user, operation);
  assert.equal(first.operation.replayed, false);
  f.command('collections.create', { name: 'Вторая' });
  const replay = f.store.mutate(f.user, structuredClone(operation));
  assert.equal(replay.operation.replayed, true);
  assert.equal(replay.version, 2);
  assert.deepEqual(replay.collections.map(c => c.name), ['Одна', 'Вторая']);
  assert.throws(() => f.store.mutate(f.user, { ...operation, name: 'Не должна появиться' }), { status: 409, code: 'OPERATION_MISMATCH' });
  assert.throws(() => f.store.mutate(f.user, { ...operation, operationId: randomUUID() }), { status: 409, code: 'VERSION_CONFLICT', currentVersion: 2 });
  assert.equal(f.store.read(f.user).collections.length, 2);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM recipe_workspace_operations').get().n, 2);
});

test('private state and operations cannot refer to another user or draft/archived recipe', t => {
  const f = fixture(t), foreign = f.add({ owner: f.stranger }), draft = f.add({ status: 'draft' }), archived = f.add({ status: 'archived' });
  for (const id of [foreign, draft, archived]) {
    assert.throws(() => f.command('collections.create', { name: 'Чужое', recipeIds: [id] }), { status: 404, code: 'RECIPE_NOT_FOUND' });
    assert.throws(() => f.command('plan.add', { recipeId: id, date: '2026-11-10', meal: 'dinner' }), { status: 404, code: 'RECIPE_NOT_FOUND' });
    assert.throws(() => f.command('groceries.fromRecipe', { recipeId: id }), { status: 404, code: 'RECIPE_NOT_FOUND' });
  }
  const c = f.command('collections.create', { name: 'Личное' }).collections[0];
  assert.throws(() => f.command('collections.delete', { collectionId: c.id }, f.stranger), { status: 404 });
  assert.equal(f.store.read(f.stranger).version, 0);
  assert.equal(f.store.read(f.user).collections.length, 1);
});

test('recipe access callback is applied after ownership, version and replay, transaction rolls back', t => {
  let checks = 0, blocked = false;
  const f = fixture(t, { getRecipe(user, id) { checks++; if (blocked) throw Object.assign(new Error('Доступ'), { status: 402 }); return { id, title: 'Проверено', servings: 2, ingredients: [{ name: 'Рис', quantity: 200, unit: 'г' }] }; } });
  const recipeId = f.add(), foreign = f.add({ owner: f.stranger });
  assert.throws(() => f.command('groceries.fromRecipe', { recipeId: foreign }), { status: 404 });
  assert.equal(checks, 0);
  const operation = { action: 'groceries.fromRecipe', recipeId, operationId: randomUUID(), expectedVersion: 0 };
  f.store.mutate(f.user, operation); assert.equal(checks, 1);
  blocked = true;
  assert.equal(f.store.mutate(f.user, operation).operation.replayed, true); assert.equal(checks, 1);
  const snapshot = f.store.read(f.user);
  assert.throws(() => f.command('plan.add', { recipeId, date: '2026-11-11', meal: 'lunch' }), { status: 402 });
  assert.deepEqual(f.store.read(f.user), snapshot);
});

test('calendar validates real dates and slots; bulk confirmation is all-or-nothing and preserves occupied slots', t => {
  const f = fixture(t), recipeId = f.add();
  for (const d of ['2026-02-30', '2025-02-29', '2026-00-01', 'tomorrow']) assert.throws(() => f.command('plan.add', { recipeId, date: d, meal: 'dinner' }), { status: 400 });
  assert.throws(() => f.command('plan.add', { recipeId, date: '2026-11-10', meal: 'unknown' }), { status: 400 });
  let s = f.command('plan.add', { recipeId, date: '2026-11-10', meal: 'dinner', servings: 4 });
  const id = s.plan[0].id, before = f.store.read(f.user);
  assert.throws(() => f.command('plan.apply', { entries: [
    { recipeId, date: '2026-11-11', meal: 'dinner' }, { recipeId, date: '2026-11-10', meal: 'dinner' }
  ] }), { status: 409, code: 'PLAN_SLOT_OCCUPIED' });
  assert.deepEqual(f.store.read(f.user), before);
  s = f.command('plan.apply', { entries: [
    { recipeId, date: '2026-11-11', meal: 'dinner' }, { recipeId, date: '2026-11-12', meal: 'lunch' }
  ] });
  assert.equal(s.plan.length, 3); assert.equal(s.operation.result.count, 2);
  s = f.command('plan.update', { entryId: id, date: '2026-11-15', meal: 'breakfast', servings: 3 });
  assert.deepEqual(s.plan.find(p => p.id === id), { ...s.plan.find(p => p.id === id), date: '2026-11-15', meal: 'breakfast', servings: 3 });
  s = f.command('plan.delete', { entryId: id }); assert.equal(s.plan.length, 2);
  assert.equal(f.db.prepare('SELECT servings FROM recipes WHERE id=?').get(recipeId).servings, 2);
});

test('scaling never changes source recipes, merges compatible units only and preserves unknown amounts', t => {
  const f = fixture(t), ingredients = [
    { name: 'Мука', quantity: 200, unit: 'г' }, { name: 'Мука', quantity: 0.3, unit: 'кг' },
    { name: 'Мука', quantity: 1, unit: 'стакан' }, { name: 'Мука', quantity: 100, unit: 'мл' },
    { name: 'Соль', quantity: null, unit: null, comment: 'по вкусу' },
    { name: 'Сахар', quantity: '1/2', unit: 'ч. л.' }
  ], recipeId = f.add({ ingredients });
  let s = f.command('groceries.fromRecipe', { recipeId, servings: 4 });
  assert.equal(s.groceries.items.find(i => i.name === 'Мука' && i.unit === 'г').quantity, 1000);
  assert.equal(s.groceries.items.filter(i => i.name === 'Мука').length, 3);
  const salt = s.groceries.items.find(i => i.name === 'Соль');
  assert.equal(salt.quantity, null); assert.equal(salt.amountText, 'по вкусу');
  assert.equal(s.groceries.items.find(i => i.name === 'Сахар').quantity, 1);
  assert.equal(s.groceries.sources[0].servings, 4);
  assert.deepEqual(JSON.parse(f.db.prepare('SELECT ingredients_json FROM recipes WHERE id=?').get(recipeId).ingredients_json), ingredients);
  s = f.command('groceries.fromRecipe', { recipeId, servings: 4 });
  assert.equal(s.groceries.sources.length, 1); assert.equal(s.groceries.items.find(i => i.unit === 'г').quantity, 1000);
});

test('manual rows survive recipe/plan refresh and are edited independently', t => {
  const f = fixture(t), recipeId = f.add();
  let s = f.command('groceries.addManual', { name: 'Рис', quantity: 1, unit: 'кг' });
  const manual = s.groceries.items[0].id;
  s = f.command('groceries.fromRecipe', { recipeId });
  assert.equal(s.groceries.items.length, 2);
  s = f.command('plan.add', { recipeId, date: '2026-11-12', meal: 'dinner' });
  s = f.command('groceries.fromPlan', { entryIds: [s.plan[0].id] });
  assert.equal(s.groceries.items.find(i => !i.manual).quantity, 400);
  s = f.command('groceries.setChecked', { itemId: manual, checked: true });
  assert.equal(s.groceries.items.find(i => i.id === manual).checked, true);
  s = f.command('groceries.updateManual', { itemId: manual, quantity: 2 });
  assert.equal(s.groceries.items.find(i => i.id === manual).checked, false);
  assert.equal(s.groceries.items.find(i => i.id === manual).quantity, 2);
  s = f.command('groceries.removeSource', { sourceId: s.groceries.sources.find(source => source.kind === 'plan').id });
  assert.equal(s.groceries.items.find(i => i.id === manual).quantity, 2);
  assert.equal(s.groceries.items.find(i => !i.manual).quantity, 200);
});

test('refresh of changed recipe quantities resets purchased while stale source snapshots remain readable', t => {
  const f = fixture(t), recipeId = f.add();
  let s = f.command('groceries.fromRecipe', { recipeId });
  const itemId = s.groceries.items[0].id;
  f.command('groceries.setChecked', { itemId, checked: true });
  f.editIngredients(recipeId, [{ name: 'Рис', quantity: 300, unit: 'г' }]);
  s = f.store.read(f.user);
  assert.equal(s.groceries.sources[0].stale, true);
  assert.equal(s.groceries.items[0].quantity, 200); assert.equal(s.groceries.items[0].checked, true);
  s = f.command('groceries.fromRecipe', { recipeId });
  assert.equal(s.groceries.sources[0].stale, false);
  assert.equal(s.groceries.items[0].id, itemId);
  assert.equal(s.groceries.items[0].quantity, 300); assert.equal(s.groceries.items[0].checked, false);
});

test('plan source refresh is scoped, portions track plan changes and replacement is atomic', t => {
  const f = fixture(t), recipeId = f.add(), other = f.add({ title: 'Картофель', servings: 3, ingredients: [{ name: 'Картофель', quantity: 600, unit: 'г' }] });
  f.command('plan.add', { recipeId, date: '2026-11-12', meal: 'dinner' });
  let s = f.command('plan.add', { recipeId, date: '2026-11-19', meal: 'dinner' });
  const [first, next] = s.plan;
  f.command('groceries.fromPlan', { entryIds: [first.id] });
  s = f.command('groceries.fromPlan', { entryIds: [next.id] });
  assert.equal(s.groceries.sources.length, 2);
  const itemId = s.groceries.items[0].id; f.command('groceries.setChecked', { itemId, checked: true });
  s = f.command('plan.update', { entryId: first.id, servings: 4 });
  assert.equal(s.groceries.items[0].quantity, 600); assert.equal(s.groceries.items[0].checked, false);
  s = f.command('plan.update', { entryId: first.id, recipeId: other });
  assert.equal(s.plan.find(p => p.id === first.id).servings, 3);
  assert.equal(s.groceries.items.find(i => i.name === 'Картофель').quantity, 600);
  assert.equal(s.groceries.items.find(i => i.name === 'Рис').quantity, 200);
  const before = s;
  assert.throws(() => f.command('plan.update', { entryId: first.id, recipeId: f.add({ owner: f.stranger }) }), { status: 404 });
  assert.deepEqual(f.store.read(f.user), Object.fromEntries(Object.entries(before).filter(([key]) => key !== 'operation')));
  s = f.command('plan.delete', { entryId: first.id });
  assert.equal(s.groceries.sources.length, 1); assert.equal(s.groceries.sources[0].planEntryId, next.id);
});

test('removing derived items keeps exclusions through refresh; clear checked preserves unrelated manual entries', t => {
  const f = fixture(t), recipeId = f.add({ ingredients: [
    { name: 'Рис', quantity: 200, unit: 'г' }, { name: 'Соль', quantity: null, unit: '', comment: 'по вкусу' },
    { name: 'Соль', quantity: null, unit: '', comment: 'по вкусу' }
  ] });
  let s = f.command('groceries.fromRecipe', { recipeId });
  const unknown = s.groceries.items.filter(i => i.quantity === null);
  assert.equal(unknown.length, 2);
  s = f.command('groceries.removeItem', { itemId: unknown[0].id });
  assert.equal(s.groceries.items.filter(i => i.quantity === null).length, 1);
  s = f.command('groceries.fromRecipe', { recipeId });
  assert.equal(s.groceries.items.filter(i => i.quantity === null).length, 1);
  const rice = s.groceries.items.find(i => i.name === 'Рис');
  f.command('groceries.setChecked', { itemId: rice.id, checked: true });
  f.command('groceries.addManual', { name: 'Хлеб', quantity: 1, unit: 'шт' });
  s = f.command('groceries.clearChecked');
  assert.equal(s.groceries.items.some(i => i.name === 'Рис'), false);
  assert.equal(s.groceries.items.some(i => i.name === 'Хлеб' && i.manual), true);
  s = f.command('groceries.fromRecipe', { recipeId, servings: 4 });
  assert.equal(s.groceries.items.some(i => i.name === 'Рис'), false);
});

test('unknown original servings allow unscaled planning and shopping, refuse invented scaling', t => {
  const f = fixture(t), recipeId = f.add({ servings: null });
  let s = f.command('plan.add', { recipeId, date: '2026-11-12', meal: 'dinner' });
  assert.equal(s.plan[0].servings, null);
  s = f.command('groceries.fromPlan', { entryIds: [s.plan[0].id] });
  assert.equal(s.groceries.items[0].quantity, 200);
  assert.equal(s.groceries.sources[0].servings, null);
  const before = f.store.read(f.user);
  assert.throws(() => f.command('groceries.fromRecipe', { recipeId, servings: 2 }), { status: 422, code: 'SERVINGS_UNKNOWN' });
  assert.throws(() => f.command('plan.update', { entryId: s.plan[0].id, servings: 2 }), { status: 422, code: 'SERVINGS_UNKNOWN' });
  assert.deepEqual(f.store.read(f.user), before);
});

test('archiving a recipe retains plan provenance and shopping snapshots; account deletion cascades workspace state', t => {
  const f = fixture(t), recipeId = f.add();
  f.command('collections.create', { name: 'Сохранённое', recipeIds: [recipeId] });
  let s = f.command('plan.add', { recipeId, date: '2026-11-12', meal: 'dinner' });
  f.command('groceries.fromPlan', { entryIds: [s.plan[0].id] });
  f.command('groceries.addManual', { name: 'Хлеб' });
  f.db.prepare("UPDATE recipes SET status='archived' WHERE id=?").run(recipeId);
  s = f.store.read(f.user);
  assert.deepEqual(s.collections[0].recipeIds, []);
  assert.equal(s.plan[0].recipeAvailable, false); assert.equal(s.plan[0].recipe, null);
  assert.equal(s.groceries.sources[0].recipeAvailable, false);
  assert.equal(s.groceries.items.find(i => i.name === 'Рис').quantity, 200);
  assert.equal(s.groceries.items.some(i => i.name === 'Хлеб'), true);
  assert.throws(() => f.command('groceries.fromPlan', { entryIds: [s.plan[0].id] }), { code: 'RECIPE_NOT_FOUND' });
  f.db.prepare('DELETE FROM users WHERE id=?').run(f.user);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM recipe_workspaces').get().n, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM recipe_workspace_operations').get().n, 0);
});

test('malformed operation IDs, unknown fields, negative amounts and nonboolean checks are rejected without writes', t => {
  const f = fixture(t);
  assert.throws(() => f.store.mutate(f.user, { action: 'collections.create', name: 'Проверка', operationId: 'arbitrary-operation-id', expectedVersion: 0 }), { status: 400 });
  assert.throws(() => f.command('groceries.addManual', { name: 'Рис', quantity: -1 }), { status: 400 });
  assert.throws(() => f.command('groceries.addManual', { name: 'Рис', quantity: '2' }), { status: 400 });
  assert.throws(() => f.command('collections.create', { name: 'Проверка', userId: f.stranger }), { status: 400 });
  assert.equal(f.store.read(f.user).version, 0);
  const s = f.command('groceries.addManual', { name: 'Рис' });
  assert.throws(() => f.command('groceries.setChecked', { itemId: s.groceries.items[0].id, checked: 'true' }), { status: 400 });
  assert.equal(f.store.read(f.user).groceries.items[0].checked, false);
});
