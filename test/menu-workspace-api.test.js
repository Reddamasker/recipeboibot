import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

const file = `data/menu-workspace-api-${randomUUID()}.sqlite`;
const platform = process.env.WORKSPACE_TEST_PLATFORM === 'max' ? 'max' : 'telegram';
Object.assign(process.env, { DATABASE_PATH: file, BOT_PLATFORM: platform, TEST_CONTOUR: 'true',
  TELEGRAM_BOT_TOKEN: 'menu-api-local-only', TELEGRAM_POLLING: 'false', BILLING_REQUIRED: 'false', MAX_BOT_TOKEN: 'menu-max-api-local-only',
  APP_URL: 'https://test-recipes.example.test', DINNER_LLM_ENABLED: 'false', DINNER_IMAGES_ENABLED: 'false', OPENAI_API_KEY: 'disabled', OPENAI_HTTPS_PROXY: '' });
const { db, upsertTelegramUser, allowUser, createRecipe, getRecipe } = await import('../src/db.js');
const { createServer } = await import('../src/server.js');
const { makeTelegramInitData } = await import('../src/security.js');
let server, base, serial = 719400000;
function account() {
  const telegram = { id: serial++, first_name: 'Menu API fixture' };
  const user = upsertTelegramUser(platform === 'max' ? { ...telegram, id: `max:${telegram.id}` } : telegram); allowUser(user.id);
  return { user, authorization: `${platform === 'max' ? 'mxa' : 'tma'} ${makeTelegramInitData(telegram, platform === 'max' ? process.env.MAX_BOT_TOKEN : process.env.TELEGRAM_BOT_TOKEN)}` };
}
const command = (expectedVersion, action, fields = {}) => ({ operationId: randomUUID(), expectedVersion, action, ...fields });
async function request(who, body = null, status = 200) {
  const response = await fetch(base + '/api/workspace', { method: body ? 'POST' : 'GET', headers: {
    ...(who ? { authorization: who.authorization } : {}), 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const value = await response.json(); assert.equal(response.status, status, JSON.stringify(value)); return value;
}
test.before(async () => { server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true }); });

test('menu notes, optional meals and cooked use the private workspace API without recipe gates or AI leakage', async () => {
  const a = account(), b = account(), saved = createRecipe(a.user.id, { status: 'ready', title: 'Закрытый рис', servings: 2,
    ingredients: [{ name: 'Рис', quantity: 200, unit: 'г' }], steps: [{ text: 'Сварить' }] });
  db.prepare('INSERT INTO first_dinner_previews(user_id,trial_gate) VALUES(?,1)').run(a.user.id);
  const beforeProviders = db.prepare('SELECT COUNT(*) n FROM provider_requests').get().n;
  const beforeReservations = db.prepare('SELECT COUNT(*) n FROM ai_reservations').get().n;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (url, options) => { assert.equal(new URL(url).origin, base, 'Menu edits must never call AI or external services'); return previousFetch(url, options); };
  try {
    await request(null, null, 401);
    const add = command(0, 'plan.add', { kind: 'note', date: '2026-11-12', note: 'Личная заметка о встрече', meal: null });
    let s = await request(a, add), entryId = s.plan[0].id;
    assert.equal(s.plan[0].kind, 'note'); assert.equal(s.plan[0].recipe, null); assert.equal(s.plan[0].recipeId, null); assert.equal(s.plan[0].servings, null);
    assert.equal(s.plan[0].cooked, false); assert.equal(s.plan[0].meal, null);
    assert.equal((await request(a, add)).operation.replayed, true);
    await request(a, command(s.version, 'plan.add', { recipeId: saved.id, date: '2026-11-12' }), 402);
    const onlyNotes = await request(a, command(s.version, 'groceries.fromPlan', { entryIds: [entryId] }), 422);
    assert.equal(onlyNotes.code, 'PLAN_RECIPES_REQUIRED');
    await request(b, command(0, 'plan.update', { entryId, cooked: true }), 404);
    s = await request(a, command(s.version, 'plan.update', { entryId, cooked: true, date: '2026-11-13', meal: 'lunch', note: 'Личное изменение' }));
    assert.equal(s.plan[0].cooked, true); assert.equal(s.plan[0].note, 'Личное изменение');
    const version = s.version;
    await request(a, command(version - 1, 'plan.delete', { entryId }), 409);
    await request(a, command(version, 'plan.update', { entryId, cooked: 'true' }), 400);
    await request(a, command(version, 'plan.update', { entryId, kind: 'recipe', recipeId: saved.id }), 402);
    assert.equal((await request(a)).version, version);
    s = await request(a, command(version, 'collections.saveCatalog', { catalogId: 'pasta-tomato' }));
    const recipeId = s.operation.result.recipeId, original = getRecipe(a.user.id, recipeId);
    s = await request(a, command(s.version, 'plan.apply', { entries: [
      { recipeId, date: '2026-11-14', cooked: true }, { kind: 'note', note: 'Свободная заметка', date: '2026-11-15' }
    ] }));
    const recipeEntry = s.plan.find(entry => entry.recipeId === recipeId);
    assert.equal(recipeEntry.kind, 'recipe'); assert.equal(recipeEntry.meal, null); assert.equal(recipeEntry.cooked, true);
    assert.equal(recipeEntry.note, null); assert.equal(recipeEntry.recipeAvailable, true);
    s = await request(a, command(s.version, 'groceries.fromPlan', { entryIds: s.plan.map(entry => entry.id) }));
    assert.equal(s.operation.result.count, 1); assert.equal(s.groceries.sources.length, 1); assert.ok(s.groceries.items.length);
    assert.equal(s.groceries.sources[0].planEntryId, recipeEntry.id);
    s = await request(a, command(s.version, 'plan.update', { entryId: recipeEntry.id, kind: 'note', note: 'Блюдо отменено' }));
    assert.equal(s.plan.find(entry => entry.id === recipeEntry.id).cooked, false); assert.equal(s.groceries.sources.length, 0); assert.equal(s.groceries.items.length, 0);
    assert.deepEqual(getRecipe(a.user.id, recipeId), original);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM recipe_card_metadata WHERE user_id=?').get(a.user.id).n, 0, 'Entry cooked is separate from recipe cooked');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM dinner_events WHERE user_id=?').get(a.user.id).n, 0, 'Entry cooked does not fabricate dinner history');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM provider_requests').get().n, beforeProviders);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM ai_reservations').get().n, beforeReservations);
    const events = db.prepare("SELECT id,flow_id,detail_json FROM product_events WHERE user_id=? AND event='workspace_saved'").all(a.user.id);
    assert.equal(events.length, 6); assert.equal(new Set(events.map(event => event.id)).size, 6);
    assert.ok(events.every(event => event.id === 'workspace-' + event.flow_id));
    assert.ok(events.every(event => Object.keys(JSON.parse(event.detail_json)).sort().join(',') === 'action,feature'));
    assert.ok(events.every(event => !event.detail_json.includes('Личн') && !event.detail_json.includes('cooked') && !event.detail_json.includes('note')));
  } finally { globalThis.fetch = previousFetch; }
});
