import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'recipeboibot-trial-test-'));
process.env.DATABASE_PATH = path.join(directory, 'recipes.sqlite');
process.env.TEST_CONTOUR = 'false';
process.env.BILLING_REQUIRED = 'false';
process.env.TELEGRAM_BOT_TOKEN = '123456:trial-test';
process.env.TELEGRAM_POLLING = 'false';
process.env.DINNER_LLM_ENABLED = 'false';
process.env.DINNER_IMAGES_ENABLED = 'false';
const { db, upsertTelegramUser, allowUser, createRecipe, getRecipe, archiveRecipe } = await import('../src/db.js');
const { startTrial, getTrialStatus, getSubscriptionAccess, grantSubscription, requireNotificationSubscription } = await import('../src/subscriptions.js');
const { getBillingOffer, canUseAutomaticImport } = await import('../src/billing.js');
const { canUsePlaylistImport } = await import('../src/telegram.js');
const { createServer } = await import('../src/server.js');
const { makeTelegramInitData } = await import('../src/security.js');
const { recommendDinner, prefetchDinner } = await import('../src/dinner-service.js');
const { resolveRecipeRequest } = await import('../src/suggestions.js');
const { saveNotificationSchedule, getNotificationSchedule } = await import('../src/notification-store.js');
let serial = 610000100;
function fresh() { const telegram = { id: serial++, first_name: 'Trial' }; const user = upsertTelegramUser(telegram); allowUser(user.id); return { user, telegram }; }
test.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });

test('trial starts only on request, lasts exactly seven days and survives retries and process restart', () => {
  const { user } = fresh();
  const at = new Date('2026-09-29T13:14:15.000Z');
  assert.equal(getBillingOffer(user.id, at).trial.eligible, true);
  assert.equal(getTrialStatus(user.id).used, false);
  const trial = startTrial(user.id, at);
  assert.equal(trial.expiresAt, '2026-10-06T13:14:15.000Z');
  assert.deepEqual(startTrial(user.id, new Date('2026-09-30T00:00:00Z')), trial);
  assert.equal(getSubscriptionAccess(user.id, new Date('2026-10-06T13:14:14.999Z')).source, 'trial');
  assert.equal(getSubscriptionAccess(user.id, new Date(trial.expiresAt)).active, false);
  assert.equal(startTrial(user.id, new Date('2026-10-10')).active, false);
  assert.equal(canUseAutomaticImport(user.id, new Date(trial.expiresAt)), false);
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `const {getTrialStatus}=await import('./src/subscriptions.js'); console.log(JSON.stringify(getTrialStatus(${JSON.stringify(user.id)},new Date('2026-10-07'))));`], { encoding: 'utf8', env: process.env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).expiresAt, trial.expiresAt);
  assert.equal(JSON.parse(result.stdout).active, false);
});

test('expiry blocks premium operations without a payment provider while keeping saved recipes and schedules', async () => {
  const { user } = fresh();
  startTrial(user.id);
  assert.equal(canUseAutomaticImport(user.id), true);
  assert.equal(canUsePlaylistImport(user.id), true);
  assert.equal(requireNotificationSubscription(user.id).source, 'trial');
  saveNotificationSchedule(user.id, { enabled: true, weekdays: [1], time: '18:00', timezone: 'Europe/Moscow' });
  const recipe = createRecipe(user.id, { title: 'Пробная каша', status: 'ready', ingredients: [{ name: 'рис' }], steps: [{ text: 'Сварить.' }] });
  db.prepare('UPDATE user_trials SET starts_at=?,expires_at=? WHERE user_id=?').run('2026-01-01T00:00:00Z', '2026-01-08T00:00:00Z', user.id);
  assert.equal(canUseAutomaticImport(user.id), false);
  assert.equal(canUsePlaylistImport(user.id), false);
  assert.throws(() => requireNotificationSubscription(user.id), { status: 402 });
  assert.equal(getNotificationSchedule(user.id).paused, true);
  assert.equal(getRecipe(user.id, recipe.id).title, recipe.title);
  await assert.rejects(() => recommendDinner(user.id, 'unused'), { status: 402 });
  assert.throws(() => prefetchDinner(user.id, 'unused'), { status: 402 });
  let generated = false;
  await assert.rejects(() => resolveRecipeRequest(user.id, 'Несуществующее блюдо', { generate: () => { generated = true; } }), { status: 402 });
  assert.equal(generated, false);
  archiveRecipe(user.id, recipe.id);
  assert.equal(canUseAutomaticImport(user.id), false);
  grantSubscription(user.id, 'subscription', new Date(Date.now() + 86400000).toISOString());
  assert.equal(canUseAutomaticImport(user.id), true);
  assert.equal(canUsePlaylistImport(user.id), true);
  assert.equal(getNotificationSchedule(user.id).paused, false);
});

test('trial API is authenticated, idempotent and ignores client identity and dates', async () => {
  const { user, telegram } = fresh();
  const other = fresh().user;
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { authorization: `tma ${makeTelegramInitData(telegram, process.env.TELEGRAM_BOT_TOKEN)}`, 'content-type': 'application/json' };
  try {
    assert.equal((await fetch(base + '/api/billing/trial', { method: 'POST' })).status, 401);
    const results = await Promise.all([1, 2].map(() => fetch(base + '/api/billing/trial', { method: 'POST', headers, body: JSON.stringify({ userId: other.id, expiresAt: '2099-01-01' }) }).then(r => r.json())));
    assert.equal(results[0].accessSource, 'trial');
    assert.equal(results[0].trial.expiresAt, results[1].trial.expiresAt);
    assert.equal(Date.parse(results[0].trial.expiresAt) - Date.parse(results[0].trial.startsAt), 7 * 86400000);
    assert.equal(getTrialStatus(other.id).used, false);
    assert.equal(db.prepare('SELECT count(*) AS n FROM payment_orders WHERE user_id=?').get(user.id).n, 0);
    db.prepare('UPDATE user_trials SET starts_at=?,expires_at=? WHERE user_id=?').run('2026-01-01T00:00:00Z', '2026-01-08T00:00:00Z', user.id);
    const repeated = await (await fetch(base + '/api/billing/trial', { method: 'POST', headers })).json();
    assert.equal(repeated.active, false);
    assert.equal(repeated.trial.eligible, false);
    assert.equal((await fetch(base + '/api/import', { method: 'POST', headers, body: '{}' })).status, 402);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('starting trial cannot replace or extend existing paid access', () => {
  const { user } = fresh();
  const expires = new Date(Date.now() + 30 * 86400000).toISOString();
  grantSubscription(user.id, 'premium', expires);
  assert.throws(() => startTrial(user.id), { status: 409 });
  assert.equal(getTrialStatus(user.id).used, false);
  assert.equal(getSubscriptionAccess(user.id).expiresAt, expires);
});
