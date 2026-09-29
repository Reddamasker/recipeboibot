import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

process.env.DATABASE_PATH = path.resolve('data', `contour-${process.pid}.sqlite`);
process.env.TELEGRAM_BOT_TOKEN = '123456:test-contour-secret';
process.env.TELEGRAM_POLLING = 'false';
process.env.TEST_CONTOUR = 'true';
process.env.TEST_OWNER_TELEGRAM_ID = '6971956699';
process.env.TEST_BOT_USERNAME = 'recipeboi_test_bot';
process.env.DINNER_LLM_ENABLED = 'false';
process.env.DINNER_IMAGES_ENABLED = 'false';

const { db, upsertTelegramUser, allowUser, createRecipe, recordAiAttempt } = await import('../src/db.js');
const { createServer } = await import('../src/server.js');
const { makeTelegramInitData } = await import('../src/security.js');
const { buildWebDocument } = await import('../src/web-document.js');
const { getSubscriptionAccess, monthAfter, startTrial } = await import('../src/subscriptions.js');
const { mockPaymentStatus, canUseTestImport } = await import('../src/contour-sandbox.js');
const telegramUser = { id: 6971956699, first_name: 'Тест' };
const user = upsertTelegramUser(telegramUser);
allowUser(user.id);
const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const headers = { authorization: `tma ${makeTelegramInitData(telegramUser, process.env.TELEGRAM_BOT_TOKEN)}`, 'content-type': 'application/json' };
const call = (url, method = 'GET', body) => fetch(base + url, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
  for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(process.env.DATABASE_PATH + suffix); } catch {} }
});

test('test contour uses the real seven-day entitlement without creating a mock payment', () => {
  const fresh = upsertTelegramUser({ id: 6971956680, first_name: 'Trial' });
  startTrial(fresh.id);
  const status = mockPaymentStatus(fresh.id);
  assert.equal(status.active, true);
  assert.equal(status.accessSource, 'trial');
  assert.equal(status.trial.durationDays, 7);
  assert.equal(canUseTestImport(fresh.id), true);
  assert.equal(db.prepare('SELECT count(*) AS n FROM mock_orders WHERE user_id=?').get(fresh.id).n, 0);
  db.prepare('UPDATE user_trials SET starts_at=?,expires_at=? WHERE user_id=?').run('2026-01-01', '2026-01-08', fresh.id);
  assert.equal(canUseTestImport(fresh.id), false);
  assert.equal(mockPaymentStatus(fresh.id).trial.eligible, false);
});

test('test contour retains current tastes, specific recipe requests and mock checkout together', async () => {
  const me = await (await call('/api/me')).json();
  assert.equal(me.testContour, true);
  const initial = await (await call('/api/dinner/open', 'POST', {})).json();
  assert.equal(initial.needsTastePreferences, true);
  const saved = await call('/api/dinner/profile', 'PUT', { preferredCategories: { pasta: 1, fish: -1 }, tastePreferencesStatus: 'completed', onboardingCompleted: true });
  assert.equal(saved.status, 200);
  const profile = await (await call('/api/dinner/profile')).json();
  assert.deepEqual(profile.preferredCategories, { pasta: 1, fish: -1 });
  assert.equal(profile.tastePreferencesStatus, 'completed');
  const dinner = await (await call('/api/dinner/open', 'POST', {})).json();
  assert.equal(dinner.needsTastePreferences, false);
  const recipe = createRecipe(user.id, { title: 'Суп', status: 'ready', ingredients: [{ name: 'картофель' }], steps: [{ text: 'Сварить до готовности' }], servings: 2, prepMinutes: 5, cookMinutes: 20 });
  const requested = await call('/api/recipe-request', 'POST', { query: 'Суп' });
  assert.equal(requested.status, 200);
  const result = await requested.json();
  assert.equal(result.kind, 'existing');
  assert.equal(result.recipe.id, recipe.id);
  const payment = await (await call('/api/test/payment')).json();
  assert.equal(payment.hasFirstRecipe, true);
  const schedule = { enabled: true, weekdays: [1], time: '18:00', timezone: 'Europe/Moscow' };
  assert.equal((await call('/api/notifications/schedule', 'PUT', schedule)).status, 402);
  const created = await call('/api/test/orders', 'POST', { method: 'sbp' });
  assert.equal(created.status, 201);
  const order = await created.json();
  const completed = await call(`/api/test/orders/${order.id}/result`, 'POST', { result: 'success' });
  assert.equal(completed.status, 200);
  assert.equal((await completed.json()).payment.active, true);
  assert.equal((await call('/api/notifications/schedule', 'PUT', schedule)).status, 200);
  const access = getSubscriptionAccess(user.id);
  assert.equal(access.source, 'test_payment');
  assert.equal(getSubscriptionAccess(user.id, new Date(access.expiresAt)).active, false);
  assert.equal(monthAfter('2026-01-31T12:00:00Z'), '2026-02-28T12:00:00.000Z');
  assert.equal(monthAfter('2028-01-31T12:00:00Z'), '2028-02-29T12:00:00.000Z');
  assert.deepEqual((await (await call('/api/dinner/profile')).json()).preferredCategories, profile.preferredCategories);
  assert.equal((await (await call('/api/recipe-request', 'POST', { query: 'Суп' })).json()).recipe.id, recipe.id);
  assert.equal(db.prepare('SELECT count(*) AS n FROM ai_reservations').get().n, 0);
});

test('test account data stays isolated and only the test owner can reset it', async () => {
  const other = { id: 987654, first_name: 'Другой' };
  const otherUser = upsertTelegramUser(other); allowUser(otherUser.id);
  const otherHeaders = { authorization: `tma ${makeTelegramInitData(other, process.env.TELEGRAM_BOT_TOKEN)}`, 'content-type': 'application/json' };
  const response = await fetch(base + '/api/dinner/profile', { headers: otherHeaders });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).preferredCategories, {});
  const reset = await fetch(base + '/api/test/reset', { method: 'POST', headers: otherHeaders, body: '{}' });
  assert.equal(reset.status, 403);
});

test('expired mock subscription can be renewed and duplicate success cannot extend the period', async () => {
  db.prepare("UPDATE mock_orders SET updated_at='2026-01-01T12:00:00.000Z' WHERE user_id=? AND status='success'").run(user.id);
  assert.equal((await (await call('/api/test/payment')).json()).active, false);
  const renewed = await (await call('/api/billing/orders', 'POST', { method: 'card', autoRenew: true })).json();
  assert.ok(renewed.id);
  const response = await call(`/api/billing/orders/${renewed.id}/result`, 'POST', { result: 'success' });
  assert.equal(response.status, 200);
  const paid = (await response.json()).payment;
  assert.equal(paid.active, true);
  assert.equal(paid.recurring.enabled, true);
  const repeated = await (await call(`/api/test/orders/${renewed.id}/result`, 'POST', { result: 'success' })).json();
  assert.equal(repeated.payment.expiresAt, paid.expiresAt);
  assert.equal((await (await call('/api/billing/auto-renew/cancel', 'POST', {})).json()).enabled, false);
  assert.equal((await (await call('/api/notifications/schedule')).json()).paused, false);
});

test('same shipped UI includes tastes, written and voice requests, plus test-only controls', () => {
  const document = buildWebDocument(path.resolve('public'), { botUsername: 'recipeboi_test_bot' }).bytes.toString();
  assert.match(document, /home-search-form/);
  assert.match(document, /voice-request/);
  assert.match(document, /Мои вкусы/);
  assert.match(document, /test-reset/);
  assert.match(document, /https:\/\/t.me\/recipeboi_test_bot/);
  assert.doesNotMatch(document, /https:\/\/t.me\/Recipeboibot/);
});

test('explicit test reset preserves AI accounting and removes only the test owner data', async () => {
  recordAiAttempt();
  const count = db.prepare('SELECT count(*) AS n FROM ai_reservations').get().n;
  const other = upsertTelegramUser({ id: 654321, first_name: 'Сохранить' });
  const recipe = createRecipe(other.id, { title: 'Чужой рецепт', status: 'ready' });
  assert.equal((await call('/api/test/reset', 'POST', {})).status, 200);
  assert.equal(db.prepare('SELECT count(*) AS n FROM ai_reservations').get().n, count);
  assert.ok(db.prepare('SELECT id FROM recipes WHERE id=?').get(recipe.id));
});
