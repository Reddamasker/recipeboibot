import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { createRecipeWorkspace } from '../src/recipe-workspace.js';

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  db.exec(`PRAGMA foreign_keys=ON;CREATE TABLE users(id TEXT PRIMARY KEY);
    CREATE TABLE recipes(id TEXT PRIMARY KEY,user_id TEXT,status TEXT,title TEXT,description TEXT,servings REAL,
    ingredients_json TEXT,steps_json TEXT,thumbnail_url TEXT,updated_at TEXT);`);
  t.after(() => db.close());
  const user = randomUUID(), other = randomUUID();
  for (const id of [user, other]) db.prepare('INSERT INTO users VALUES(?)').run(id);
  let tick = 0;
  const store = createRecipeWorkspace(db, { now: () => new Date(Date.UTC(2026, 10, 10, 0, 0, tick++)).toISOString() });
  const recipe = ({ owner = user, servings = 2, ingredients = [{ name: 'Рис', quantity: 200, unit: 'г' }, { name: 'Соль', quantity: null, comment: 'по вкусу' }] } = {}) => {
    const id = randomUUID();db.prepare('INSERT INTO recipes VALUES(?,?,?,?,?,?,?,?,?,?)').run(id, owner, 'ready', 'Рис', 'Описание', servings, JSON.stringify(ingredients), JSON.stringify([{ text: 'Сварить' }]), '/assets/dinner/rice.jpg', '2026-11-09');return id;
  };
  const command = (action, data = {}, owner = user) => store.mutate(owner, { action, operationId: randomUUID(), expectedVersion: store.read(owner).version, ...data });
  const preview = input => store.groceriesPreview(user, input);
  const pick = (entry, extra = {}) => ({ entryId: entry.entryId, servings: entry.servings, ingredientKeys: entry.selectedIngredientKeys, recipeRevision: entry.recipeRevision, ...extra });
  const stateRow = () => db.prepare('SELECT * FROM recipe_workspaces WHERE user_id=?').get(user);
  return { db, user, other, store, recipe, command, preview, pick, stateRow };
}

test('preview normalizes and scales ingredients while leaving legacy JSON, all rows and version untouched', t => {
  const f = fixture(t), id = f.recipe({ ingredients: [{ name: 'Мука', quantity: 200, unit: 'г' }, { name: 'Мука', quantity: 0.3, unit: 'кг' }, { name: 'Соль', quantity: null, comment: 'по вкусу' }] });
  let s = f.command('plan.add', { recipeId: id, date: '2026-11-12', servings: 4 });
  const entryId = s.plan[0].id;
  s = f.command('plan.add', { kind: 'note', note: 'Не ингредиент', date: '2026-11-13' });
  const state = JSON.parse(f.stateRow().data_json);for (const key of ['kind', 'note', 'cooked']) delete state.plan[0][key];
  f.db.prepare('UPDATE recipe_workspaces SET data_json=? WHERE user_id=?').run(JSON.stringify(state), f.user);
  const before = f.stateRow(), changes = f.db.prepare('SELECT total_changes() n').get().n;
  const result = f.preview({ entryIds: s.plan.map(entry => entry.id) });
  assert.equal(result.version, s.version);assert.equal(result.entries.length, 1);
  const entry = result.entries[0];assert.equal(entry.entryId, entryId);assert.equal(entry.recipeId, id);assert.equal(entry.date, '2026-11-12');assert.equal(entry.meal, null);
  assert.equal(entry.servings, 4);assert.equal(entry.baseServings, 2);assert.match(entry.recipeRevision, /^[0-9a-f]{64}$/);assert.equal(entry.thumbnailUrl, '/assets/dinner/rice.jpg');
  assert.deepEqual(entry.ingredients.map(i => [i.quantity, i.unit]), [[400, 'г'], [600, 'г'], [null, '']]);
  assert.equal(entry.ingredients[2].amountText, 'по вкусу');assert.equal(new Set(entry.ingredients.map(i => i.key)).size, 3);
  assert.deepEqual(entry.selectedIngredientKeys, entry.ingredients.map(i => i.key));
  const direct = f.preview({ recipeId: id, servings: 6 }).entries[0];assert.equal(direct.entryId, null);assert.equal(direct.date, null);assert.equal(direct.meal, null);assert.equal(direct.ingredients[0].quantity, 600);
  assert.equal(direct.recipeRevision, entry.recipeRevision, 'Shopping portions do not alter the source revision');
  assert.deepEqual(f.stateRow(), before);assert.equal(f.db.prepare('SELECT total_changes() n').get().n, changes);
});

test('selection applies exact ingredients and shopping portions atomically without changing plan or unrelated purchases', t => {
  const f = fixture(t), id = f.recipe(), other = f.recipe({ ingredients: [{ name: 'Хлеб', quantity: 1, unit: 'шт' }] });
  let s = f.command('groceries.addManual', { name: 'Молоко', quantity: 1, unit: 'л' });const manual = s.groceries.items[0].id;
  f.command('groceries.setChecked', { itemId: manual, checked: true });f.command('groceries.fromRecipe', { recipeId: other });
  f.command('plan.add', { recipeId: id, date: '2026-11-12', servings: 2 });
  s = f.command('plan.add', { recipeId: id, date: '2026-11-13', servings: 3 });
  const planBefore = s.plan, recipeBefore = f.db.prepare('SELECT * FROM recipes WHERE id=?').get(id);
  const preview = f.preview({ entryIds: s.plan.map(entry => entry.id) }), [a,b] = preview.entries;
  const payload = { action: 'groceries.fromPlan', operationId: randomUUID(), expectedVersion: preview.version, entryIds: [a.entryId,b.entryId], selections: [
    f.pick(a, { servings: 4, ingredientKeys: [a.ingredients[0].key] }), f.pick(b, { servings: 6, ingredientKeys: [b.ingredients[1].key] })] };
  s = f.store.mutate(f.user, payload);
  assert.equal(s.operation.result.count, 2);assert.equal(s.groceries.sources.length, 3);assert.deepEqual(s.plan, planBefore);
  assert.equal(s.groceries.items.find(i => i.name === 'Рис').quantity, 400);assert.equal(s.groceries.items.find(i => i.name === 'Соль').quantity, null);
  assert.equal(s.groceries.items.find(i => i.id === manual).checked, true);assert.equal(s.groceries.items.find(i => i.name === 'Хлеб').quantity, 1);
  assert.ok(s.groceries.sources.every(source => source.thumbnailUrl === '/assets/dinner/rice.jpg'));
  assert.equal(f.store.mutate(f.user, payload).operation.replayed, true);assert.deepEqual(f.db.prepare('SELECT * FROM recipes WHERE id=?').get(id), recipeBefore);
  const restored = f.preview({ entryIds: [a.entryId,b.entryId] });
  assert.deepEqual(restored.entries.map(entry => entry.servings), [4,6]);assert.deepEqual(restored.entries.map(entry => entry.selectedIngredientKeys), [[a.ingredients[0].key],[b.ingredients[1].key]]);
});

test('preview retains exclusions and current source portions; a fresh explicit selection replaces only that source choice', t => {
  const f = fixture(t), id = f.recipe();let s = f.command('groceries.fromRecipe', { recipeId: id, servings: 4 });
  const rice = s.groceries.items.find(i => i.name === 'Рис');f.command('groceries.setChecked', { itemId: rice.id, checked: true });
  f.command('groceries.removeItem', { itemId: s.groceries.items.find(i => i.name === 'Соль').id });
  f.db.prepare('UPDATE recipes SET ingredients_json=? WHERE id=?').run(JSON.stringify([{ name: 'Рис', quantity: 200, unit: 'г' }, { name: 'Соль', quantity: null, comment: 'по вкусу' }, { name: 'Морковь', quantity: 100, unit: 'г' }]), id);
  let p = f.preview({ recipeId: id }).entries[0];assert.equal(p.servings, 4);assert.deepEqual(p.selectedIngredientKeys, [p.ingredients[0].key]);
  s = f.command('groceries.fromRecipe', { recipeId: id, servings: 4, ingredientKeys: [p.ingredients[0].key,p.ingredients[2].key], recipeRevision: p.recipeRevision });
  assert.equal(s.groceries.items.find(i => i.id === rice.id).checked, true, 'Same aggregate quantity retains the purchase mark');
  assert.equal(s.groceries.items.find(i => i.name === 'Морковь').quantity, 200);assert.equal(s.groceries.items.some(i => i.name === 'Соль'), false);
  p = f.preview({ recipeId: id }).entries[0];s = f.command('groceries.fromRecipe', { recipeId: id, servings: 6, ingredientKeys: p.selectedIngredientKeys, recipeRevision: p.recipeRevision });
  assert.equal(s.groceries.items.find(i => i.id === rice.id).quantity, 600);assert.equal(s.groceries.items.find(i => i.id === rice.id).checked, false);
  s = f.command('groceries.fromRecipe', { recipeId: id });assert.equal(s.groceries.items.some(i => i.name === 'Соль'), false, 'Legacy refresh preserves exclusions');
  s = f.command('groceries.fromRecipe', { recipeId: id, restoreExcluded: true });assert.equal(s.groceries.items.some(i => i.name === 'Соль'), true);
});

test('content and original serving changes reject stale selections and roll back every source in the batch', t => {
  const f = fixture(t), a = f.recipe(), b = f.recipe();
  f.command('plan.add', { recipeId: a, date: '2026-11-12' });let s = f.command('plan.add', { recipeId: b, date: '2026-11-13' });
  const p = f.preview({ entryIds: s.plan.map(entry => entry.id) });
  const payload = { entryIds: p.entries.map(entry => entry.entryId), selections: p.entries.map(entry => f.pick(entry, { servings: 4 })) };
  f.db.prepare('UPDATE recipes SET ingredients_json=? WHERE id=?').run(JSON.stringify([{ name: 'Рис', quantity: 350, unit: 'г' }]), b);
  const before = f.store.read(f.user), operations = f.db.prepare('SELECT COUNT(*) n FROM recipe_workspace_operations').get().n;
  assert.throws(() => f.command('groceries.fromPlan', payload), { status: 409, code: 'RECIPE_CHANGED' });assert.deepEqual(f.store.read(f.user), before);
  const direct = f.preview({ recipeId: a }).entries[0];f.db.prepare('UPDATE recipes SET servings=3 WHERE id=?').run(a);
  assert.throws(() => f.command('groceries.fromRecipe', { recipeId: a, ingredientKeys: direct.selectedIngredientKeys, recipeRevision: direct.recipeRevision }), { status: 409, code: 'RECIPE_CHANGED' });
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM recipe_workspace_operations').get().n, operations);
  assert.deepEqual(f.store.read(f.user).groceries, before.groceries);
  const refreshed = f.preview({ entryIds: payload.entryIds });s = f.command('groceries.fromPlan', { entryIds: payload.entryIds, selections: refreshed.entries.map(entry => f.pick(entry)) });
  assert.equal(s.groceries.sources.length, 2);
});

test('preview and selection enforce ownership, note handling, exact coverage and strict bounded fields', t => {
  const f = fixture(t), id = f.recipe(), foreign = f.recipe({ owner: f.other });let s = f.command('plan.add', { recipeId: id, date: '2026-11-12' });
  const entryId = s.plan[0].id;s = f.command('plan.add', { kind: 'note', note: 'В гостях', date: '2026-11-13' });const noteId = s.plan.find(entry => entry.kind === 'note').id;
  const p = f.preview({ entryIds: [entryId] }).entries[0], chosen = f.pick(p);
  const before = f.store.read(f.user), changes = f.db.prepare('SELECT total_changes() n').get().n;
  for (const input of [{}, { entryIds: [] }, { entryIds: Array(61).fill(entryId) }, { entryIds: [entryId,entryId] }, { recipeId: id, entryIds: [entryId] }, { entryIds: [entryId], servings: 4 }, { recipeId: id, unknown: true }]) assert.throws(() => f.preview(input), { status: 400 });
  assert.throws(() => f.preview({ recipeId: foreign }), { status: 404 });assert.throws(() => f.store.groceriesPreview(f.other, { entryIds: [entryId] }), { status: 404 });
  assert.throws(() => f.preview({ entryIds: [noteId] }), { code: 'PLAN_RECIPES_REQUIRED' });
  for (const selections of [[], [chosen,chosen], [{ ...chosen, entryId: noteId }], [{ ...chosen, servings: '4' }], [{ ...chosen, ingredientKeys: [] }], [{ ...chosen, ingredientKeys: [chosen.ingredientKeys[0],chosen.ingredientKeys[0]] }], [{ ...chosen, ingredientKeys: ['made-up'] }], [{ ...chosen, recipeRevision: 'wrong' }], [{ ...chosen, extra: true }], [{ ...chosen, servings: undefined }]]) assert.throws(() => f.command('groceries.fromPlan', { entryIds: [entryId], selections }), { status: 400 });
  assert.throws(() => f.command('groceries.fromPlan', { entryIds: [entryId], selections: [chosen], restoreExcluded: false }), { status: 400 });
  assert.throws(() => f.command('groceries.fromRecipe', { recipeId: id, ingredientKeys: chosen.ingredientKeys }), { status: 400 });
  assert.throws(() => f.command('groceries.fromRecipe', { recipeId: id, recipeRevision: chosen.recipeRevision }), { status: 400 });
  assert.throws(() => f.command('groceries.fromPlan', { entryIds: [noteId], selections: [{ ...chosen, entryId: noteId }] }), { status: 422 });
  assert.deepEqual(f.store.read(f.user), before);assert.equal(f.db.prepare('SELECT total_changes() n').get().n, changes);
});

test('unknown source portions remain null and explicit choices cannot invent scaling', t => {
  const f = fixture(t), id = f.recipe({ servings: null });const s = f.command('plan.add', { recipeId: id, date: '2026-11-12' });
  const p = f.preview({ entryIds: [s.plan[0].id] }).entries[0];assert.equal(p.servings, null);assert.equal(p.baseServings, null);assert.equal(p.ingredients[0].quantity, 200);
  assert.throws(() => f.preview({ recipeId: id, servings: 2 }), { code: 'SERVINGS_UNKNOWN' });
  assert.throws(() => f.command('groceries.fromPlan', { entryIds: [p.entryId], selections: [f.pick(p, { servings: 2 })] }), { code: 'SERVINGS_UNKNOWN' });
  const saved = f.command('groceries.fromPlan', { entryIds: [p.entryId], selections: [f.pick(p)] });assert.equal(saved.groceries.sources[0].servings, null);assert.equal(saved.groceries.items[0].quantity, 200);
  const known = f.recipe();let changed = f.command('plan.add', { recipeId: known, date: '2026-11-14', servings: 4 });const changedId = changed.plan.find(entry => entry.recipeId === known).id;
  f.command('groceries.fromPlan', { entryIds: [changedId] });f.db.prepare('UPDATE recipes SET servings=NULL WHERE id=?').run(known);
  const nowUnknown = f.preview({ entryIds: [changedId] }).entries[0];assert.equal(nowUnknown.servings, null);assert.equal(nowUnknown.baseServings, null);assert.equal(nowUnknown.ingredients[0].quantity, 200);
  changed = f.command('groceries.fromPlan', { entryIds: [changedId], selections: [f.pick(nowUnknown)] });
  assert.equal(changed.groceries.sources.find(source => source.planEntryId === changedId).servings, null);assert.equal(changed.plan.find(entry => entry.id === changedId).servings, 4, 'Preview and shopping do not rewrite the plan after a source edit');
});

test('selected source commit failure is atomic and a successful UUID replays after later recipe changes', t => {
  const f = fixture(t), id = f.recipe(), p = f.preview({ recipeId: id }).entries[0];
  const operation = { action: 'groceries.fromRecipe', operationId: randomUUID(), expectedVersion: 0, recipeId: id, servings: 4, ingredientKeys: [p.ingredients[0].key], recipeRevision: p.recipeRevision };
  f.db.exec("CREATE TEMP TRIGGER reject_selection BEFORE INSERT ON recipe_workspace_operations BEGIN SELECT RAISE(ABORT,'selection failed'); END");
  assert.throws(() => f.store.mutate(f.user, operation), /selection failed/);assert.equal(f.store.read(f.user).version, 0);assert.equal(f.store.read(f.user).groceries.items.length, 0);
  f.db.exec('DROP TRIGGER reject_selection');const saved = f.store.mutate(f.user, operation);assert.equal(saved.operation.replayed, false);
  f.db.prepare("UPDATE recipes SET ingredients_json='[]' WHERE id=?").run(id);
  const replay = f.store.mutate(f.user, operation);assert.equal(replay.operation.replayed, true);assert.equal(replay.groceries.items[0].quantity, 400);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM recipe_workspace_operations').get().n, 1);
});

test('newly known base portions make unscaled legacy sources editable without rewriting them during preview', t => {
  const f = fixture(t), id = f.recipe({ servings: null });
  const plan = f.command('plan.add', { recipeId: id, date: '2026-11-12' });const entryId = plan.plan[0].id;
  f.command('groceries.fromRecipe', { recipeId: id });
  let state = f.command('groceries.fromPlan', { entryIds: [entryId] });
  for (const item of state.groceries.items.filter(item => item.name === 'Соль')) f.command('groceries.removeItem', { itemId: item.id });
  f.db.prepare('UPDATE recipes SET servings=2 WHERE id=?').run(id);
  const before = f.stateRow(), beforeRecipe = f.db.prepare('SELECT * FROM recipes WHERE id=?').get(id), changes = f.db.prepare('SELECT total_changes() n').get().n;
  const direct = f.preview({ recipeId: id }).entries[0], explicitNull = f.preview({ recipeId: id, servings: null }).entries[0];
  const planned = f.preview({ entryIds: [entryId] }).entries[0];
  for (const entry of [direct, explicitNull, planned]) {
    assert.equal(entry.baseServings, 2);assert.equal(entry.servings, 2);assert.equal(entry.ingredients[0].quantity, 200);
    assert.deepEqual(entry.selectedIngredientKeys, [entry.ingredients[0].key]);
  }
  assert.deepEqual(f.stateRow(), before);assert.equal(f.db.prepare('SELECT total_changes() n').get().n, changes);
  state = f.command('groceries.fromPlan', { entryIds: [entryId], selections: [f.pick(planned, { servings: 4 })] });
  assert.equal(state.groceries.sources.find(source => source.planEntryId === entryId).servings, 4);
  assert.equal(state.groceries.items.find(item => item.name === 'Рис').quantity, 600, '200 from the untouched direct source plus 400 from the scaled plan source');
  assert.equal(state.groceries.items.some(item => item.name === 'Соль'), false);
  assert.equal(state.plan[0].servings, null, 'Shopping edits do not alter legacy plan portions');
  assert.deepEqual(f.db.prepare('SELECT * FROM recipes WHERE id=?').get(id), beforeRecipe);
});

test('one bounded preview and selection supports all 60 entries beyond the old small request limit', t => {
  const f = fixture(t), id = f.recipe({ ingredients: Array.from({ length: 20 }, (_,i) => ({ name: 'Продукт ' + i, quantity: 1, unit: 'г' })) });
  const s = f.command('plan.apply', { entries: Array.from({ length: 60 }, (_,i) => ({ recipeId: id, date: new Date(Date.UTC(2026, 10, 1 + i)).toISOString().slice(0,10) })) });
  const p = f.preview({ entryIds: s.plan.map(entry => entry.id) }), operation = { action: 'groceries.fromPlan', operationId: randomUUID(), expectedVersion: p.version, entryIds: p.entries.map(entry => entry.entryId), selections: p.entries.map(entry => f.pick(entry)) };
  assert.ok(Buffer.byteLength(JSON.stringify(operation)) > 64000);
  const saved = f.store.mutate(f.user, operation);assert.equal(saved.operation.result.count, 60);assert.equal(saved.groceries.sources.length, 60);assert.equal(saved.groceries.items[0].quantity, 60);
});

test('independent 60-entry and 400-ingredient bounds still respect the atomic 2 MiB workspace budget', t => {
  const f = fixture(t), id = f.recipe({ ingredients: Array.from({ length: 400 }, (_, i) => ({ name: 'Продукт ' + i, quantity: 1, unit: 'г' })) });
  const otherRecipe = f.recipe({ owner: f.other });
  f.command('groceries.fromRecipe', { recipeId: otherRecipe }, f.other);
  const manual = f.command('groceries.addManual', { name: 'Молоко', quantity: 1, unit: 'л' }).groceries.items[0];
  f.command('groceries.setChecked', { itemId: manual.id, checked: true });
  f.command('groceries.fromRecipe', { recipeId: id, servings: 2 });
  const s = f.command('plan.apply', { entries: Array.from({ length: 60 }, (_, i) => ({ recipeId: id, date: new Date(Date.UTC(2026, 10, 1 + i)).toISOString().slice(0, 10) })) });
  const p = f.preview({ entryIds: s.plan.map(entry => entry.id) });
  assert.equal(p.entries.length, 60);assert.ok(p.entries.every(entry => entry.ingredients.length === 400));
  const operation = { action: 'groceries.fromPlan', operationId: randomUUID(), expectedVersion: p.version, entryIds: p.entries.map(entry => entry.entryId), selections: p.entries.map(entry => f.pick(entry)) };
  assert.ok(Buffer.byteLength(JSON.stringify(operation)) < 1_800_000, 'The request itself satisfies the selected-plan payload limit');
  const before = f.stateRow(), ownSnapshot = f.store.read(f.user), otherSnapshot = f.store.read(f.other);
  const operationsBefore = f.db.prepare('SELECT * FROM recipe_workspace_operations ORDER BY user_id,operation_id').all();
  const recipesBefore = f.db.prepare('SELECT * FROM recipes ORDER BY id').all();
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.throws(() => f.store.mutate(f.user, operation), { status: 413, code: 'WORKSPACE_LIMIT' });
    assert.deepEqual(f.stateRow(), before);assert.deepEqual(f.store.read(f.user), ownSnapshot);assert.deepEqual(f.store.read(f.other), otherSnapshot);
    assert.deepEqual(f.db.prepare('SELECT * FROM recipe_workspace_operations ORDER BY user_id,operation_id').all(), operationsBefore);
    assert.deepEqual(f.db.prepare('SELECT * FROM recipes ORDER BY id').all(), recipesBefore);
  }
  const reduced = { ...operation, operationId: randomUUID(), entryIds: [p.entries[0].entryId], selections: [f.pick(p.entries[0])] };
  const saved = f.store.mutate(f.user, reduced);
  assert.equal(saved.version, p.version + 1);assert.equal(saved.groceries.sources.length, 2);
  assert.equal(saved.groceries.items.find(item => item.id === manual.id).checked, true);
});
