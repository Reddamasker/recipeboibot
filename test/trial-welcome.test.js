import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'recipe-trial-welcome-'));
Object.assign(process.env, {
  DATABASE_PATH: path.join(directory, 'recipes.sqlite'), BOT_PLATFORM: 'telegram',
  TELEGRAM_BOT_TOKEN: '123456:trial-welcome-test', TELEGRAM_POLLING: 'false',
  TEST_CONTOUR: 'false', BILLING_REQUIRED: 'false', APP_URL: 'https://recipes.example.test',
  DINNER_LLM_ENABLED: 'false', DINNER_IMAGES_ENABLED: 'false', OPENAI_API_KEY: 'unused-test-key'
});
const { db, upsertTelegramUser, allowUser, createRecipe, activatePrivateTestProfile } = await import('../src/db.js');
const { startTrial, withFirstRecipe, getPendingFirstRecipe, grantSubscription, revokeSubscription } = await import('../src/subscriptions.js');
const { queueTrialWelcome, markTrialWelcomeReady, deliverTrialWelcome, markFirstRecipeReadForWelcome, startTrialWelcomeScheduler, stopTrialWelcomeScheduler } = await import('../src/trial-welcome.js');
const { createServer } = await import('../src/server.js');
const { makeTelegramInitData } = await import('../src/security.js');
const { SEED_RECIPES } = await import('../src/dinner.js');

let serial = 619200000;
let server, base;
const originalFetch = globalThis.fetch;
const telegramMessages = [];
test.before(async () => {
  server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  globalThis.fetch = async (url, options) => {
    if (new URL(url).origin === base) return originalFetch(url, options);
    if (String(url).startsWith('https://api.telegram.org/')) {
      telegramMessages.push(JSON.parse(options.body));
      return Response.json({ ok: true, result: { message_id: telegramMessages.length } });
    }
    assert.fail('Trial welcome tests must never access an external service');
  };
});
test.after(async () => {
  stopTrialWelcomeScheduler();
  globalThis.fetch = originalFetch;
  await new Promise(resolve => server.close(resolve));
  db.close();
  fs.rmSync(directory, { recursive: true, force: true });
});
function fresh() {
  const telegram = { id: serial++, first_name: 'Trial welcome' };
  const user = upsertTelegramUser(telegram);
  allowUser(user.id);
  return { user, telegram };
}
const row = account => db.prepare('SELECT * FROM trial_welcome_messages WHERE user_id=?').get(account.user.id);
function ready(account) {
  startTrial(account.user.id);
  queueTrialWelcome(account.user.id, account.telegram.id, { ready: false });
  markTrialWelcomeReady(account.user.id);
}
const past = sample => typeof sample === 'number' ? Date.now() - 180000 : new Date(Date.now() - 180000).toISOString();
async function call(account, route, method = 'GET', body, status = 200) {
  const response = await fetch(base + route, {
    method, headers: { authorization: `tma ${makeTelegramInitData(account.telegram, process.env.TELEGRAM_BOT_TOKEN)}`, 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
  const value = await response.json();
  assert.equal(response.status, status, `${method} ${route}: ${JSON.stringify(value)}`);
  return value;
}

test('queued welcome waits for readiness, never activates trial, and cannot be queued for a foreign recipient', async () => {
  const noTrial = fresh();
  queueTrialWelcome(noTrial.user.id, noTrial.telegram.id, { ready: true });
  assert.equal(row(noTrial), undefined);
  const account = fresh(), foreign = fresh();
  startTrial(account.user.id);
  try { queueTrialWelcome(account.user.id, foreign.telegram.id, { ready: true }); } catch { /* Explicit refusal also satisfies recipient safety. */ }
  assert.equal(row(account), undefined, 'Foreign recipient must not be persisted');
  queueTrialWelcome(account.user.id, account.telegram.id, { ready: false });
  assert.equal(String(row(account).chat_id), String(account.telegram.id));
  assert.equal(row(account).ready, 0);
  const sent = [];
  await deliverTrialWelcome(account.user.id, async (...args) => sent.push(args));
  assert.equal(sent.length, 0);
  assert.equal(row(account).attempts, 0);
  markTrialWelcomeReady(account.user.id);
  await deliverTrialWelcome(account.user.id, async (...args) => sent.push(args));
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], account.user.id);
  assert.equal(sent[0][1], account.telegram.id);
  assert.equal(sent[0][2].active, true);
  assert.equal(row(account).status, 'sent');
  assert.ok(row(account).sent_at);
});

test('concurrent delivery and repeated queue calls claim exactly one welcome', async () => {
  const account = fresh();
  ready(account);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let sends = 0;
  const sender = async () => { sends++; await gate; };
  const first = deliverTrialWelcome(account.user.id, sender);
  assert.equal(row(account).status, 'sending');
  await deliverTrialWelcome(account.user.id, sender);
  assert.equal(sends, 1);
  release();
  await first;
  const persisted = row(account);
  for (let attempt = 0; attempt < 3; attempt++) {
    queueTrialWelcome(account.user.id, account.telegram.id, { ready: true });
    markTrialWelcomeReady(account.user.id);
    await deliverTrialWelcome(account.user.id, sender);
  }
  assert.equal(sends, 1);
  assert.equal(row(account).sent_at, persisted.sent_at);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM trial_welcome_messages WHERE user_id=?').get(account.user.id).n, 1);
});

test('failed delivery is persisted and retried with exponential delay without changing the trial', async () => {
  const account = fresh();
  ready(account);
  const deadline = db.prepare('SELECT expires_at FROM user_trials WHERE user_id=?').get(account.user.id).expires_at;
  let sends = 0;
  const failing = async () => { sends++; throw new Error('Temporary transport failure'); };
  await deliverTrialWelcome(account.user.id, failing);
  const firstFailure = row(account);
  assert.equal(firstFailure.status, 'pending');
  assert.equal(firstFailure.attempts, 1);
  assert.match(firstFailure.last_error, /Temporary transport failure/);
  const firstDelay = Date.parse(firstFailure.next_attempt_at) - Date.now();
  assert.ok(firstDelay > 0, 'Failed deliveries must back off');
  await deliverTrialWelcome(account.user.id, failing);
  assert.equal(sends, 1, 'Not yet due means no second transport call');
  db.prepare('UPDATE trial_welcome_messages SET next_attempt_at=? WHERE user_id=?').run(past(firstFailure.next_attempt_at), account.user.id);
  await deliverTrialWelcome(account.user.id, failing);
  const secondFailure = row(account);
  assert.equal(secondFailure.attempts, 2);
  const secondDelay = Date.parse(secondFailure.next_attempt_at) - Date.now();
  assert.ok(secondDelay > firstDelay * 1.5, 'Second retry must use a longer backoff');
  db.prepare('UPDATE trial_welcome_messages SET next_attempt_at=? WHERE user_id=?').run(past(secondFailure.next_attempt_at), account.user.id);
  await deliverTrialWelcome(account.user.id, async () => { sends++; });
  assert.equal(row(account).status, 'sent');
  assert.equal(sends, 3);
  assert.equal(db.prepare('SELECT expires_at FROM user_trials WHERE user_id=?').get(account.user.id).expires_at, deadline);
});

test('expired and revoked access suppress pending messages instead of delivering outdated welcomes', async () => {
  const expired = fresh();
  ready(expired);
  db.prepare('UPDATE user_trials SET starts_at=?,expires_at=? WHERE user_id=?').run('2020-01-01', '2020-01-08', expired.user.id);
  let sends = 0;
  await deliverTrialWelcome(expired.user.id, async () => { sends++; });
  assert.equal(sends, 0);
  assert.notEqual(row(expired).status, 'sent');
  const revoked = fresh();
  ready(revoked);
  grantSubscription(revoked.user.id, 'subscription', new Date(Date.now() + 86400000));
  revokeSubscription(revoked.user.id);
  await deliverTrialWelcome(revoked.user.id, async () => { sends++; });
  assert.equal(sends, 0);
  assert.notEqual(row(revoked).status, 'sent');
});

test('private test profile uses its mapped owner recipient and rejects another account', async () => {
  const owner = fresh(), foreign = fresh();
  const mapping = activatePrivateTestProfile(owner.telegram.id);
  const profile = { user: { id: mapping.testUserId }, telegram: owner.telegram };
  startTrial(profile.user.id);
  try { queueTrialWelcome(profile.user.id, foreign.telegram.id, { ready: true }); } catch { /* Recipient mismatch must be refused. */ }
  assert.equal(row(profile), undefined);
  queueTrialWelcome(profile.user.id, owner.telegram.id, { ready: false });
  assert.equal(String(row(profile).chat_id), String(owner.telegram.id));
  markTrialWelcomeReady(profile.user.id);
  const sent = [];
  await deliverTrialWelcome(profile.user.id, async (...args) => { sent.push(args); });
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], profile.user.id);
  assert.equal(sent[0][1], owner.telegram.id);
  assert.equal(row(profile).status, 'sent');
  assert.equal(row(owner), undefined, 'Test profile welcome must not mutate owner trial history');
});

test('pending readiness survives process restart and only expired sending leases can be recovered', async () => {
  const account = fresh();
  ready(account);
  const restarted = spawnSync(process.execPath, ['--input-type=module', '-e', `const {db}=await import('./src/db.js');await import('./src/trial-welcome.js');console.log(JSON.stringify(db.prepare('SELECT * FROM trial_welcome_messages WHERE user_id=?').get(${JSON.stringify(account.user.id)})));db.close();`], { encoding: 'utf8', env: process.env, cwd: process.cwd() });
  assert.equal(restarted.status, 0, restarted.stderr);
  assert.deepEqual(JSON.parse(restarted.stdout), { ...row(account) });
  db.prepare('UPDATE trial_welcome_messages SET status=?,claimed_at=? WHERE user_id=?').run('sending', new Date().toISOString(), account.user.id);
  let sends = 0;
  await deliverTrialWelcome(account.user.id, async () => { sends++; });
  assert.equal(sends, 0, 'A live sending lease must not be stolen');
  db.prepare('UPDATE trial_welcome_messages SET claimed_at=? WHERE user_id=?').run(past(row(account).claimed_at), account.user.id);
  await deliverTrialWelcome(account.user.id, async () => { sends++; });
  assert.equal(sends, 1);
  assert.equal(row(account).status, 'sent');
});

test('Mini App trial queues silently and the chosen recipe GET alone releases its welcome', async () => {
  const account = fresh();
  let recipe;
  await withFirstRecipe(account.user.id, 'request:welcome-fixture', async () => {
    recipe = createRecipe(account.user.id, { ...SEED_RECIPES[0], id: undefined, title: 'Chosen welcome recipe', status: 'ready', origin: 'imported' });
    return { kind: 'existing', recipe };
  });
  const pending = getPendingFirstRecipe(account.user.id);
  assert.equal(pending.recipeId, recipe.id);
  const beforeMessages = telegramMessages.length;
  await call(account, '/api/billing/trial', 'POST', {});
  assert.equal(row(account).ready, 0);
  await deliverTrialWelcome(account.user.id, async () => assert.fail('Welcome must wait for chosen recipe read'));
  assert.equal(telegramMessages.length, beforeMessages);
  await call(account, '/api/billing/offer');
  await call(account, '/api/library');
  assert.equal(row(account).ready, 0);
  const other = createRecipe(account.user.id, { ...SEED_RECIPES[1], id: undefined, title: 'Other welcome recipe', status: 'ready', origin: 'imported' });
  await call(account, `/api/recipes/${other.id}`);
  assert.equal(row(account).ready, 0, 'Reading another recipe must not release the welcome');
  markFirstRecipeReadForWelcome(account.user.id, 'foreign-recipe-id');
  assert.equal(row(account).ready, 0);
  await call(account, `/api/recipes/${recipe.id}`);
  assert.equal(row(account).ready, 1);
  await deliverTrialWelcome(account.user.id, async () => {});
  assert.equal(row(account).status, 'sent');
  await call(account, '/api/billing/trial', 'POST', {});
  await call(account, `/api/recipes/${recipe.id}`);
  await deliverTrialWelcome(account.user.id, async () => assert.fail('Welcome must not repeat'));
  assert.equal(row(account).status, 'sent');
});

test('chosen catalog recipe_key also releases its welcome, while other catalog ids do not', async () => {
  const account = fresh();
  const chosen = SEED_RECIPES[2];
  await withFirstRecipe(account.user.id, 'request:catalog-welcome-fixture', async () => ({ kind: 'existing', recipe: chosen }));
  // A dinner choice may have a collection UUID while its original catalog key remains a valid read alias.
  const saved = createRecipe(account.user.id, { ...chosen, id: undefined, status: 'ready', origin: 'imported' });
  db.prepare('UPDATE first_recipe_selections SET recipe_id=? WHERE user_id=?').run(saved.id, account.user.id);
  assert.notEqual(getPendingFirstRecipe(account.user.id).recipeId, chosen.id);
  await call(account, '/api/billing/trial', 'POST', {});
  const other = SEED_RECIPES.find(item => item.id !== chosen.id);
  await call(account, `/api/dinner/recipes/${encodeURIComponent(other.id)}`);
  assert.equal(row(account).ready, 0);
  await call(account, `/api/dinner/recipes/${encodeURIComponent(chosen.id)}`);
  assert.equal(row(account).ready, 1);
  await deliverTrialWelcome(account.user.id, async () => {});
  assert.equal(row(account).status, 'sent');
});

test('delivery revalidates a persisted recipient and cancels a forged foreign target', async () => {
  const account = fresh(), foreign = fresh();
  ready(account);
  db.prepare('UPDATE trial_welcome_messages SET chat_id=? WHERE user_id=?').run(String(foreign.telegram.id), account.user.id);
  await deliverTrialWelcome(account.user.id, async () => assert.fail('Foreign recipient must never receive the welcome'));
  assert.equal(row(account).status, 'cancelled');
});

test('scheduler immediately drains only ready entries and uses the configured sender', { timeout: 3000 }, async () => {
  const account = fresh(), waiting = fresh();
  ready(account);
  startTrial(waiting.user.id);
  queueTrialWelcome(waiting.user.id, waiting.telegram.id, { ready: false });
  let complete;
  const delivered = new Promise(resolve => { complete = resolve; });
  const calls = [];
  try {
    startTrialWelcomeScheduler(async (...args) => { calls.push(args); complete(); });
    await delivered;
    // Let the awaited send finish its database transition before stopping the loop.
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], account.user.id);
    assert.equal(calls[0][1], account.telegram.id);
    assert.equal(row(account).status, 'sent');
    assert.equal(row(waiting).status, 'pending');
    assert.equal(row(waiting).ready, 0);
    assert.equal(row(waiting).attempts, 0);
  } finally { stopTrialWelcomeScheduler(); }
});

test('reopening an already used trial does not retrospectively create a welcome', async () => {
  const account = fresh();
  const trial = startTrial(account.user.id);
  assert.equal(row(account), undefined);
  const reopened = await call(account, '/api/billing/trial', 'POST', {});
  assert.equal(reopened.trial.expiresAt, trial.expiresAt);
  assert.equal(row(account), undefined);
  await deliverTrialWelcome(account.user.id, async () => assert.fail('Old trials must not receive a new welcome'));
});
