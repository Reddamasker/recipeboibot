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
const { db, upsertTelegramUser, allowUser, createRecipe, getRecipe, archiveRecipe, getPendingIntent } = await import('../src/db.js');
const { startTrial, getTrialStatus, getSubscriptionAccess, getFirstRecipeStatus, withFirstRecipe, grantSubscription, requireNotificationSubscription } = await import('../src/subscriptions.js');
const { getBillingOffer, canUseAutomaticImport } = await import('../src/billing.js');
const { canUsePlaylistImport, interpretVoice, handleMessage, handleDinnerIntakeCallback, handleTrialCallback } = await import('../src/telegram.js');
const { importTextWithAccess } = await import('../src/importer.js');
const { createServer } = await import('../src/server.js');
const { makeTelegramInitData } = await import('../src/security.js');
const { recommendDinner, prefetchDinner, startDinner, updateDinnerProfile, nextDinner, decideDinner } = await import('../src/dinner-service.js');
const { resolveRecipeRequest, suggestForEmptySearch } = await import('../src/suggestions.js');
const { canUseTestImport } = await import('../src/contour-sandbox.js');
const { saveNotificationSchedule, getNotificationSchedule } = await import('../src/notification-store.js');
let serial = 610000100;
function fresh() { const telegram = { id: serial++, first_name: 'Trial' }; const user = upsertTelegramUser(telegram); allowUser(user.id); return { user, telegram }; }
test.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });

test('a new user receives one free recipe before trial; further AI entry points require access', async () => {
  const { user } = fresh();
  const adapters = { generate: assert.fail, interpret: assert.fail, validate: assert.fail };
  assert.equal(canUseAutomaticImport(user.id), true);
  assert.equal(canUseTestImport(user.id), true);
  assert.equal(canUsePlaylistImport(user.id), false);
  const voice = await interpretVoice({ voice: { duration: 10, file_id: 'first' } }, user,
    { download: async () => ({ buffer: Buffer.from('test') }), transcribe: async () => 'Хочу рис с овощами' });
  assert.equal(voice.text, 'Хочу рис с овощами');
  assert.equal(getFirstRecipeStatus(user.id).available, true);
  assert.throws(() => prefetchDinner(user.id, 'unused'), { status: 404 });
  const first = await resolveRecipeRequest(user.id, 'рис с овощами', { generate: assert.fail });
  assert.equal(first.kind, 'existing');
  assert.equal(getTrialStatus(user.id).used, false);
  assert.equal(getFirstRecipeStatus(user.id).delivered, true);
  assert.equal(getBillingOffer(user.id).hasFirstRecipe, true);
  assert.deepEqual(await resolveRecipeRequest(user.id, 'рис с овощами', adapters), first);
  assert.equal(canUseAutomaticImport(user.id), false);
  assert.equal(canUseTestImport(user.id), false);
  await assert.rejects(() => resolveRecipeRequest(user.id, 'Суп', adapters), { status: 402 });
  await assert.rejects(() => suggestForEmptySearch(user.id, 'Суп', adapters), { status: 402 });
  await assert.rejects(() => interpretVoice({ voice: { duration: 10, file_id: 'unused' } }, user,
    { download: assert.fail, transcribe: assert.fail }), { status: 402 });
  const restarted = spawnSync(process.execPath, ['--input-type=module', '-e', `const {resolveRecipeRequest}=await import('./src/suggestions.js'); console.log(JSON.stringify(await resolveRecipeRequest(${JSON.stringify(user.id)},'рис с овощами',{generate:()=>{throw Error('Must replay');},interpret:()=>{throw Error('Must replay');}})));`], { encoding: 'utf8', env: process.env });
  assert.equal(restarted.status, 0, restarted.stderr);
  assert.deepEqual(JSON.parse(restarted.stdout), first);
  startTrial(user.id);
  const cached = await resolveRecipeRequest(user.id, 'рис с овощами', { generate: assert.fail });
  assert.equal(cached.kind, 'existing');
  db.prepare('UPDATE user_trials SET starts_at=?,expires_at=? WHERE user_id=?').run('2026-01-01', '2026-01-08', user.id);
  await assert.rejects(() => resolveRecipeRequest(user.id, 'рис с овощами', adapters), { status: 402 });
});

test('HTTP rejects paid actions before trial activation but preserves library access', async () => {
  const { user, telegram } = fresh();
  createRecipe(user.id, { title: 'Сохранённый рецепт', status: 'ready' });
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { authorization: `tma ${makeTelegramInitData(telegram, process.env.TELEGRAM_BOT_TOKEN)}`, 'content-type': 'application/json' };
  try {
    for (const [path, method, input] of [
      ['/api/import', 'POST', {}], ['/api/recipe-request', 'POST', { query: 'Суп' }],
      ['/api/suggestions', 'POST', { query: 'Суп' }], ['/api/recipe-request/transcribe', 'POST', {}],
      ['/api/dinner/recommend', 'POST', { sessionId: 'unused' }], ['/api/dinner/request', 'PUT', { query: 'Суп' }]
    ]) {
      const response = await fetch(base + path, { method, headers, body: JSON.stringify(input) });
      assert.equal(response.status, 402, path);
      assert.match((await response.json()).error, /Начните бесплатный пробный период/);
    }
    assert.equal((await fetch(base + '/api/library', { headers })).status, 200);
    assert.equal(getTrialStatus(user.id).used, false);
    assert.equal((await fetch(base + '/api/billing/trial', { method: 'POST', headers, body: '{}' })).status, 200);
    assert.equal(JSON.parse(db.prepare("SELECT detail_json FROM dinner_events WHERE user_id=? AND event='trial_started'").get(user.id).detail_json).source, 'app');
    assert.equal(canUseAutomaticImport(user.id), true);
    assert.equal(canUseTestImport(user.id), true);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('first dinner keeps three choices and replacements free until one like', async () => {
  const { user } = fresh();
  updateDinnerProfile(user.id, { onboardingCompleted: true });
  const session = startDinner(user.id);
  const first = await recommendDinner(user.id, session.sessionId);
  assert.equal(first.recommendations.length, 3);
  assert.equal(first.firstFreeRecipe, undefined);
  assert.equal(getFirstRecipeStatus(user.id).delivered, false);
  assert.equal(getTrialStatus(user.id).used, false);
  assert.deepEqual((await recommendDinner(user.id, session.sessionId)).recommendations, first.recommendations);
  assert.equal(prefetchDinner(user.id, session.sessionId).current, undefined);
  const next = await nextDinner(user.id, first.recommendations.map(item => item.id));
  assert.equal(next.recommendations.length, 3);
  await assert.rejects(() => resolveRecipeRequest(user.id, 'Суп', { generate: assert.fail, interpret: assert.fail }), { status: 402 });
  const selected = decideDinner(user.id, next.recommendation.id, 'accepted');
  assert.equal(selected.firstFreeRecipe, true);
  assert.ok(selected.savedRecipe);
  assert.equal(getFirstRecipeStatus(user.id).delivered, true);
  assert.equal(getTrialStatus(user.id).used, false);
  assert.equal(decideDinner(user.id, next.recommendation.id, 'accepted').savedRecipe.id, selected.savedRecipe.id);
  assert.throws(() => decideDinner(user.id, next.recommendations[1].id, 'accepted'), { status: 402 });
  assert.throws(() => prefetchDinner(user.id, session.sessionId), { status: 402 });
  await assert.rejects(() => recommendDinner(user.id, startDinner(user.id).sessionId), { status: 402 });
  startTrial(user.id);
  assert.equal((await recommendDinner(user.id, startDinner(user.id).sessionId)).recommendations.length, 3);
});

test('legacy unliked first dinner resumes three choices without resetting the account', async () => {
  const { user } = fresh();
  updateDinnerProfile(user.id, { onboardingCompleted: true });
  const session = startDinner(user.id);
  await withFirstRecipe(user.id, 'dinner:' + session.sessionId, async () => ({ recommendation: { recipe: { title: 'Старый показ' } } }));
  const picks = await recommendDinner(user.id, session.sessionId);
  assert.equal(picks.recommendations.length, 3);
  assert.equal(getFirstRecipeStatus(user.id).delivered, false);
  const selected = decideDinner(user.id, picks.recommendation.id, 'accepted');
  assert.equal(selected.firstFreeRecipe, true);
  assert.equal(getTrialStatus(user.id).used, false);
});

test('a preview cannot bypass trial expiry even if no dish was liked', async () => {
  const { user } = fresh();
  updateDinnerProfile(user.id, { onboardingCompleted: true });
  const session = startDinner(user.id);
  await recommendDinner(user.id, session.sessionId);
  startTrial(user.id, new Date('2026-01-01'));
  await assert.rejects(() => recommendDinner(user.id, session.sessionId), { status: 402 });
  assert.throws(() => prefetchDinner(user.id, session.sessionId), { status: 402 });
});

test('a failed first attempt can be retried; concurrent different requests cannot receive two free results', async () => {
  const { user } = fresh();
  await assert.rejects(() => withFirstRecipe(user.id, 'failed', async () => { throw new Error('provider unavailable'); }), /provider unavailable/);
  assert.equal(getFirstRecipeStatus(user.id).available, true);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const first = withFirstRecipe(user.id, 'first', async () => { calls++; await gate; return { recipe: { title: 'Первый рецепт' } }; });
  const duplicate = withFirstRecipe(user.id, 'first', assert.fail);
  await assert.rejects(() => withFirstRecipe(user.id, 'second', assert.fail), { status: 409 });
  release();
  assert.deepEqual(await first, await duplicate);
  assert.equal(calls, 1);
  await assert.rejects(() => withFirstRecipe(user.id, 'second', assert.fail), { status: 402 });
  assert.equal(getTrialStatus(user.id).used, false);
});

test('HTTP first request succeeds before trial and only then exposes the offer', async () => {
  const { user, telegram } = fresh();
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { authorization: `tma ${makeTelegramInitData(telegram, process.env.TELEGRAM_BOT_TOKEN)}`, 'content-type': 'application/json' };
  try {
    const before = await (await fetch(base + '/api/billing/offer', { headers })).json();
    assert.equal(before.firstRecipe.available, true);
    assert.equal(before.hasFirstRecipe, false);
    updateDinnerProfile(user.id, { onboardingCompleted: true });
    const session = await (await fetch(base + '/api/dinner/open', { method: 'POST', headers, body: '{}' })).json();
    const response = await fetch(base + '/api/dinner/recommend', { method: 'POST', headers, body: JSON.stringify({ sessionId: session.sessionId }) });
    assert.equal(response.status, 200);
    const picks = await response.json();
    assert.equal(picks.recommendations.length, 3);
    assert.equal(getFirstRecipeStatus(user.id).delivered, false);
    decideDinner(user.id, picks.recommendation.id, 'accepted');
    const after = await (await fetch(base + '/api/billing/offer', { headers })).json();
    assert.equal(after.hasFirstRecipe, true);
    assert.equal(after.firstRecipe.available, false);
    assert.equal(after.trial.eligible, true);
    assert.equal(after.trial.used, false);
    assert.equal((await fetch(base + '/api/recipe-request', { method: 'POST', headers, body: JSON.stringify({ query: 'Суп' }) })).status, 402);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('first import is shared with recipe allowance; failed imports and archiving do not bypass the rule', async () => {
  const { user } = fresh();
  await assert.rejects(() => importTextWithAccess(user.id, 'рис'), { status: 400 });
  assert.equal(getFirstRecipeStatus(user.id).available, true);
  let calls = 0;
  const source = 'Каша из риса: отварить рис в воде до готовности.';
  const first = await importTextWithAccess(user.id, source, { normalize: async () => { calls++; return { title: 'Рисовая каша', ingredients: [{ name: 'рис' }], steps: [{ text: 'Отварить рис.' }] }; } });
  assert.equal(first.state, 'created');
  assert.equal(first.firstFreeRecipe, true);
  assert.deepEqual(await importTextWithAccess(user.id, source, { normalize: assert.fail }), first);
  assert.equal(calls, 1);
  archiveRecipe(user.id, first.recipe.id);
  assert.equal(getFirstRecipeStatus(user.id).available, false);
  await assert.rejects(() => importTextWithAccess(user.id, source + ' Новый вариант.', { normalize: assert.fail }), { status: 402 });
  await assert.rejects(() => resolveRecipeRequest(user.id, 'Суп', { generate: assert.fail, interpret: assert.fail }), { status: 402 });
});

test('a first Telegram launch provides the recipe before sending the trial offer', async () => {
  const from = { id: serial++, first_name: 'Первый вход' }, chat = { id: from.id, type: 'private' };
  const user = upsertTelegramUser(from);
  const originalFetch = globalThis.fetch, sent = [];
  globalThis.fetch = async (url, options) => {
    assert.match(String(url), /api\.telegram\.org/);
    sent.push(JSON.parse(options.body));
    return Response.json({ ok: true, result: { message_id: 101 } });
  };
  try {
    await handleMessage({ from, chat, text: '/start' });
    assert.equal(getFirstRecipeStatus(user.id).available, true);
    assert.equal(sent.some(body => /7 дней бесплатно|199 рублей/.test(body.text || '')), false);
    // The profile conversation has completed; confirmation must deliver its first result without a trial.
    const { setPendingIntent } = await import('../src/db.js');
    setPendingIntent(user.id, { kind: 'dinner-confirm', profileOnly: true, intake: {
      householdSize: 2, hasChildren: false, maxMinutes: 30, availableIngredients: [], excludedIngredients: [], preferredCategories: {}, dishPreferences: {}, requestedCategories: [], mealRequest: null
    } });
    await handleDinnerIntakeCallback({ id: 'first-confirm', data: 'dinner:confirm', from, message: { chat, message_id: 101 } });
    assert.equal(sent.some(body => /Ингредиенты\n/.test(body.text || '')), false);
    assert.equal(sent.some(body => /Попробуйте 7 дней бесплатно/.test(body.text || '')), false);
    assert.ok(sent.some(body => body.reply_markup?.inline_keyboard));
    assert.equal(getTrialStatus(user.id).used, false);
    assert.equal(getFirstRecipeStatus(user.id).delivered, false);
    assert.equal(getPendingIntent(user.id), null);
  } finally { globalThis.fetch = originalFetch; }
});

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

test('Telegram trial button belongs to the private account and activates once without opening tariffs', async () => {
  const { user, telegram: from } = fresh(), chat = { id: from.id, type: 'private' };
  const sent = [], originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.match(String(url), /api\.telegram\.org/);
    sent.push({ method: String(url).split('/').at(-1), ...JSON.parse(options.body) });
    return Response.json({ ok: true, result: { message_id: 123 } });
  };
  const callback = { id: 'trial-1', data: 'trial:start', from, message: { chat, message_id: 123 } };
  try {
    assert.equal(await handleTrialCallback({ ...callback, from: { ...from, id: from.id + 999 } }), false);
    assert.equal(await handleTrialCallback({ ...callback, message: { chat: { ...chat, type: 'group' } } }), false);
    assert.equal(getTrialStatus(user.id).used, false);
    assert.equal(sent.length, 0);
    assert.equal(await handleTrialCallback(callback), true);
    const first = getTrialStatus(user.id);
    assert.equal(first.active, true);
    assert.equal(Date.parse(first.expiresAt) - Date.parse(first.startsAt), 7 * 86400000);
    assert.match(sent.find(body => body.method === 'editMessageText').text, /Пробный период начался/);
    assert.equal(sent.some(body => JSON.stringify(body).includes('view=offer')), false);
    assert.equal(await handleTrialCallback(callback), true);
    assert.deepEqual(getTrialStatus(user.id), first);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM dinner_events WHERE user_id=? AND event='trial_started'").get(user.id).n, 1);
    db.prepare('UPDATE user_trials SET starts_at=?,expires_at=? WHERE user_id=?').run('2026-01-01', '2026-01-08', user.id);
    await handleTrialCallback(callback);
    assert.equal(getTrialStatus(user.id).active, false);
    assert.match(sent.at(-1).text, /Пробный период закончился/);
    const paid = fresh();
    grantSubscription(paid.user.id, 'subscription', new Date(Date.now() + 86400000).toISOString());
    await handleTrialCallback({ ...callback, from: paid.telegram, message: { chat: { id: paid.telegram.id, type: 'private' } } });
    assert.equal(getTrialStatus(paid.user.id).used, false);
    assert.equal(getSubscriptionAccess(paid.user.id).source, 'subscription');
  } finally { globalThis.fetch = originalFetch; }
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
  await assert.rejects(() => resolveRecipeRequest(user.id, 'Несуществующее блюдо', {
    generate: () => { generated = true; },
    validate: async ({ recipes }) => recipes.map((candidate) => ({ recipe: candidate, accepted: false, preferredScore: 0, failedCriteria: ['Нет смыслового соответствия'], evidence: [] }))
  }), { status: 402 });
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
