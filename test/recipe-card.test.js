import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { createRecipeCardStore } from '../src/recipe-card.js';
import { createRecipeWorkspace } from '../src/recipe-workspace.js';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aSqsAAAAASUVORK5CYII=';
function fixture(t, options = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(`PRAGMA foreign_keys=ON; CREATE TABLE users(id TEXT PRIMARY KEY);
    CREATE TABLE recipes(id TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id) ON DELETE CASCADE,status TEXT,title TEXT,servings REAL,
      ingredients_json TEXT,steps_json TEXT,tags_json TEXT,notes TEXT,thumbnail_url TEXT,nutrition_json TEXT,updated_at TEXT);
    INSERT INTO users VALUES('owner'),('other');`);
  t.after(() => db.close());
  const add = (id, owner = 'owner', status = 'ready') => db.prepare('INSERT INTO recipes VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id, owner, status, 'Рис', null,
    JSON.stringify([{ name: 'Рис', quantity: 200, unit: 'г' }]), JSON.stringify([{ text: 'Сварить' }]), '["Ужин"]', 'Старая заметка', '/assets/dinner/rice.jpg', null, '2026-11-09T10:00:00Z');
  add('recipe'); add('foreign', 'other'); add('draft', 'owner', 'draft');
  let at = Date.parse('2026-11-09T12:00:00Z');
  const cards = createRecipeCardStore(db, { now: () => new Date(at).toISOString(), ...options });
  const workspace = createRecipeWorkspace(db, { cardStore: cards });
  const command = (action, fields, owner = 'owner') => workspace.mutate(owner, { operationId: randomUUID(), expectedVersion: workspace.read(owner).version, action, ...fields });
  return { db, cards, workspace, command, add, advance: ms => { at += ms; }, row: () => db.prepare("SELECT * FROM recipes WHERE id='recipe'").get() };
}

test('card fields persist privately with strict partial updates, replay and unchanged unknown servings/nutrition', t => {
  const f = fixture(t), original = f.row();
  assert.equal(f.cards.read('owner', 'recipe').rating, 0);
  const operation = { action: 'collections.updateCard', recipeId: 'recipe', pinned: true, cooked: true, rating: 5,
    notes: 'Моя заметка\nВторая строка', tags: ['Ужин', 'Быстро'], operationId: randomUUID(), expectedVersion: 0 };
  const saved = f.workspace.mutate('owner', operation);
  assert.equal(saved.version, 1); assert.equal(saved.recipeCards.recipe.pinned, true);
  assert.equal(saved.recipeCards.recipe.cooked, true); assert.ok(saved.recipeCards.recipe.cookedAt);
  assert.equal(Object.hasOwn(saved.recipeCards.recipe, 'notes'), false);
  assert.equal(f.cards.read('owner', 'recipe').notes, operation.notes);
  assert.deepEqual(f.cards.read('owner', 'recipe').tags, operation.tags);
  assert.deepEqual({ ...f.row() }, { ...original, notes: operation.notes, tags_json: JSON.stringify(operation.tags) });
  assert.equal(f.workspace.mutate('owner', operation).operation.replayed, true);
  assert.equal(f.command('collections.updateCard', { recipeId: 'recipe', pinned: true }).operation.result.changed, false);
  f.advance(1000);
  f.command('collections.updateCard', { recipeId: 'recipe', cooked: false, rating: 0, notes: '', tags: [] });
  const card = f.cards.read('owner', 'recipe');
  assert.equal(card.pinned, true); assert.equal(card.cooked, false); assert.equal(card.cookedAt, null); assert.equal(card.rating, 0); assert.equal(card.notes, '');
  assert.equal(f.row().servings, null); assert.equal(f.row().nutrition_json, null);
  assert.deepEqual(f.cards.list('other'), {});
  assert.throws(() => f.cards.read('other', 'recipe'), { status: 404 });
  assert.throws(() => f.command('collections.updateCard', { recipeId: 'foreign', pinned: true }), { status: 404 });
  for (const fields of [{}, { rating: 2.5 }, { rating: 6 }, { rating: null }, { pinned: 1 }, { cooked: 'true' }, { notes: null }, { tags: [''] }, { tags: Array(21).fill('a') }])
    assert.throws(() => f.command('collections.updateCard', { recipeId: 'recipe', ...fields }), { status: 400 });
});

test('private photos never replace the original image and commit atomically with version/idempotency', t => {
  const f = fixture(t), original = f.row();
  const s = f.command('collections.setPhoto', { recipeId: 'recipe', mime: 'image/png', value: png });
  assert.equal(s.recipeCards.recipe.hasPhoto, true); assert.ok(s.recipeCards.recipe.photoVersion);
  assert.equal(JSON.stringify(s).includes(png), false);
  const photo = f.cards.read('owner', 'recipe').photo;
  assert.equal(photo.dataUrl, 'data:image/png;base64,' + png); assert.deepEqual(f.row(), original);
  assert.equal(f.command('collections.setPhoto', { recipeId: 'recipe', mime: 'image/png', value: png }).operation.result.changed, false);
  assert.throws(() => f.cards.read('other', 'recipe'), { status: 404 });
  for (const input of [{ mime: 'image/jpeg', value: png }, { mime: 'image/svg+xml', value: png }, { mime: 'image/png', value: 'data:image/png;base64,' + png }, { mime: 'image/png', value: 'notbase64' }])
    assert.throws(() => f.command('collections.setPhoto', { recipeId: 'recipe', ...input }), { status: 415 });
  const large = Buffer.alloc(1024 * 1024 + 1); Buffer.from(png, 'base64').copy(large);
  assert.throws(() => f.command('collections.setPhoto', { recipeId: 'recipe', mime: 'image/png', value: large.toString('base64') }), { status: 413 });
  f.db.exec("CREATE TEMP TRIGGER reject_card_operation BEFORE INSERT ON recipe_workspace_operations BEGIN SELECT RAISE(ABORT,'fixture rollback'); END");
  try { assert.throws(() => f.command('collections.removePhoto', { recipeId: 'recipe' }), /fixture rollback/); }
  finally { f.db.exec('DROP TRIGGER reject_card_operation'); }
  assert.equal(f.cards.read('owner', 'recipe').photo.version, photo.version);
  f.command('collections.removePhoto', { recipeId: 'recipe' });
  assert.equal(f.cards.read('owner', 'recipe').photo, null); assert.deepEqual(f.row(), original);
});

test('metadata and note writes roll back on a later operation failure and preserve read gates', t => {
  const f = fixture(t), original = f.row();
  f.db.exec("CREATE TEMP TRIGGER reject_card_operation BEFORE INSERT ON recipe_workspace_operations BEGIN SELECT RAISE(ABORT,'fixture rollback'); END");
  try { assert.throws(() => f.command('collections.updateCard', { recipeId: 'recipe', notes: 'Не сохранить', pinned: true }), /fixture rollback/); }
  finally { f.db.exec('DROP TRIGGER reject_card_operation'); }
  assert.deepEqual(f.row(), original); assert.deepEqual(f.cards.list('owner'), {}); assert.equal(f.workspace.read('owner').version, 0);
  const gated = createRecipeCardStore(f.db, { getRecipe() { throw Object.assign(new Error('Locked'), { status: 402 }); } });
  assert.throws(() => gated.read('owner', 'recipe'), { status: 402 });
  assert.throws(() => gated.update('owner', 'recipe', { pinned: true }), { status: 402 });
  assert.throws(() => gated.setPhoto('owner', 'recipe', { mime: 'image/png', value: png }), { status: 402 });
});

test('questions use server recipe context once, replay durably, isolate users and never mutate the recipe', async t => {
  let answerCalls = 0, authorizationCalls = 0, finish;
  const f = fixture(t, { authorizeAsk() { authorizationCalls++; }, answer: async input => {
    answerCalls++; assert.equal(input.recipe.title, 'Рис'); assert.equal(input.recipe.steps[0].text, 'Сварить');
    await new Promise(resolve => { finish = resolve; }); return { answer: 'Вари под крышкой.' };
  } }), original = f.row(), input = { operationId: randomUUID(), question: 'Как варить?' };
  const first = f.cards.ask('owner', 'recipe', input);
  const concurrent = await f.cards.ask('owner', 'recipe', input);
  assert.equal(concurrent.status, 'pending'); assert.equal(concurrent.replayed, true);
  assert.equal(answerCalls, 1); assert.equal(authorizationCalls, 1);
  finish(); const result = await first;
  assert.equal(result.answer, 'Вари под крышкой.'); assert.equal(result.replayed, false);
  const reopened = createRecipeCardStore(f.db, { answer: () => assert.fail('Replay must not call AI'), authorizeAsk: () => assert.fail('Replay must not consume access again') });
  assert.equal((await reopened.ask('owner', 'recipe', input)).replayed, true);
  await assert.rejects(() => f.cards.ask('owner', 'recipe', { ...input, question: 'Другой вопрос' }), { status: 409 });
  await assert.rejects(() => f.cards.ask('other', 'recipe', input), { status: 404 });
  assert.throws(() => f.workspace.mutate('owner', { operationId: input.operationId, expectedVersion: 0, action: 'collections.create', name: 'Другая операция' }), { status: 409 });
  const operation = { operationId: randomUUID(), expectedVersion: 0, action: 'collections.create', name: 'Подборка' };
  f.workspace.mutate('owner', operation);
  await assert.rejects(() => f.cards.ask('owner', 'recipe', { operationId: operation.operationId, question: 'Вопрос' }), { status: 409 });
  assert.deepEqual(f.row(), original);
});

test('terminal question failures are replayed without new AI; interrupted pending attempts are never submitted twice', async t => {
  let calls = 0;
  const f = fixture(t, { answer: async () => { calls++; throw Object.assign(new Error('Fixture unavailable'), { status: 503 }); } });
  const input = { operationId: randomUUID(), question: 'Вопрос' };
  await assert.rejects(() => f.cards.ask('owner', 'recipe', input), { status: 503, replayed: false, operationId: input.operationId });
  await assert.rejects(() => f.cards.ask('owner', 'recipe', input), { status: 503, replayed: true });
  assert.equal(calls, 1);
  f.db.prepare("UPDATE recipe_card_questions SET status='pending' WHERE operation_id=?").run(input.operationId);
  f.advance(46000);
  await assert.rejects(() => f.cards.ask('owner', 'recipe', input), { status: 409, code: 'ASK_INTERRUPTED', replayed: true });
  assert.equal(calls, 1);
  for (const bad of [{ operationId: 'bad', question: 'a' }, { operationId: randomUUID(), question: '' }, { operationId: randomUUID(), question: 'a', recipe: {} }])
    await assert.rejects(() => f.cards.ask('owner', 'recipe', bad), { status: 400 });
  const gated = createRecipeCardStore(f.db, { authorizeAsk: () => { throw Object.assign(new Error('Access'), { status: 402 }); }, answer: () => assert.fail('Forbidden AI call') });
  const denied = { operationId: randomUUID(), question: 'Вопрос' };
  await assert.rejects(() => gated.ask('owner', 'recipe', denied), { status: 402 });
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM recipe_card_questions WHERE operation_id=?').get(denied.operationId).n, 0);
});

test('account deletion cascades all private card state and request answers', async t => {
  const f = fixture(t, { answer: async () => ({ answer: 'Ответ' }) });
  f.command('collections.updateCard', { recipeId: 'recipe', cooked: true });
  f.command('collections.setPhoto', { recipeId: 'recipe', mime: 'image/png', value: png });
  await f.cards.ask('owner', 'recipe', { operationId: randomUUID(), question: 'Вопрос' });
  f.db.prepare("DELETE FROM users WHERE id='owner'").run();
  for (const table of ['recipe_card_metadata', 'recipe_card_photos', 'recipe_card_questions']) assert.equal(f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0);
  assert.equal(f.db.prepare('PRAGMA foreign_key_check').all().length, 0);
});
