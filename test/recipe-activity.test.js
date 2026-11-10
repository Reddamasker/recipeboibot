// Explicit compatibility mode: these tests exercise the archived scheduling implementation.
process.env.LEGACY_DINNER_NOTIFICATIONS_ENABLED = 'true';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const file = path.resolve('data', `recipe-activity-${randomUUID()}.sqlite`);
Object.assign(process.env, { DATABASE_PATH: file, TELEGRAM_BOT_TOKEN: 'activity-test', TELEGRAM_POLLING: 'false',
  TEST_CONTOUR: 'false', DINNER_LLM_ENABLED: 'false', DINNER_IMAGES_ENABLED: 'false' });
const { db, upsertTelegramUser, allowUser, createRecipe, createRecipeSuggestion, saveRecipeSuggestion, recordRecipeRequestResult, deleteUserData } = await import('../src/db.js');
const { openDinnerSession, insertDinnerOption, createDinnerRecommendations, markDinnerSessionOpened } = await import('../src/dinner-store.js');
const { saveNotificationSchedule } = await import('../src/notification-store.js');
const { startTrial } = await import('../src/subscriptions.js');
const { createCampaign, recordBotStart, advertisingRedirect, funnelReport } = await import('../src/funnel.js');
const { recipeActivityReport } = await import('../src/recipe-activity.js');
const { maxFunnelSnapshot, mergeMaxFunnelReport } = await import('../src/max-funnel.js');
test.after(() => { db.close(); for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true }); });
let identity = 47000;
const user = () => { const value = upsertTelegramUser({ id: ++identity, first_name: 'Activity' }); allowUser(value.id); return value; };
const at = text => `2026-10-${text}.000Z`;
const report = value => recipeActivityReport([{ id: value.id }]);
const prepared = (value, time, { opened = true, key = 'dish' } = {}) => {
  const session = openDinnerSession(value.id, { prefetchOnly: true });
  createDinnerRecommendations(value.id, session, [{ recipeKey: key, categories: [] }]);
  db.prepare('UPDATE dinner_recommendations SET shown_at=? WHERE session_id=?').run(time, session);
  if (opened) db.prepare('UPDATE dinner_sessions SET viewed_at=? WHERE id=?').run(time, session);
  return session;
};

test('recipe counts exclude reserve, deduplicate variants and never count a passive reminder as returning', () => {
  const value = user(), session = prepared(value, at('01T09:00:00'));
  createDinnerRecommendations(value.id, session, [{ recipeKey: 'dish', categories: [] }, { recipeKey: 'second', categories: [] }]);
  db.prepare('UPDATE dinner_recommendations SET shown_at=? WHERE session_id=?').run(at('01T09:00:00'), session);
  insertDinnerOption(value.id, session, { id: randomUUID(), recipe: { id: 'reserve' } }, 'reserve-signature');
  prepared(value, at('02T09:00:00'), { opened: false });
  assert.equal(report(value).preparedRecipes, 3);
  assert.equal(report(value).recipeUsers, 1);
  assert.equal(report(value).repeatRecipeUsers, 0);
  assert.equal(report(value).returnedRecipeUsers, 0);
  prepared(value, at('01T10:00:00'));
  assert.equal(report(value).repeatRecipeUsers, 1);
  assert.equal(report(value).returnedRecipeUsers, 0);
  prepared(value, at('02T10:00:00'));
  assert.equal(report(value).returnedRecipeUsers, 1);
  assert.equal(report(value).returnRate, 100);
  markDinnerSessionOpened(value.id, session);
  assert.equal(report(value).preparedRecipes, 5);
});

test('Moscow dates, single recipe requests, cohort dates and exclusions use real result records', () => {
  createCampaign('activity');
  const value = user();
  const payload = new URL(advertisingRedirect('activity')).searchParams.get('start');
  recordBotStart({ ...value, is_allowed: 0 }, `/start ${payload}`, new Date(at('01T20:00:00')));
  recordRecipeRequestResult(value.id, 'early', 'generated', at('01T19:00:00'));
  recordRecipeRequestResult(value.id, 'first', 'existing', at('01T20:59:00'));
  recordRecipeRequestResult(value.id, 'second', 'generated', at('01T21:01:00'));
  recordRecipeRequestResult(value.id, 'second', 'generated', at('02T09:00:00'));
  const result = funnelReport('activity').recipeActivity;
  assert.equal(result.preparedRecipes, 2);
  assert.equal(result.returnedRecipeUsers, 1);
  assert.equal(result.repeatRecipeUsers, 1);
  const owner = upsertTelegramUser({ id: '6971956699' });
  recordBotStart(owner, `/start ${payload}`); allowUser(owner.id);
  recordRecipeRequestResult(owner.id, 'internal', 'generated');
  assert.deepEqual(funnelReport('activity').recipeActivity, result);
  const privateUser = upsertTelegramUser({ id: 'private-test:activity' }); allowUser(privateUser.id);
  const before = funnelReport().recipeActivity;
  recordRecipeRequestResult(privateUser.id, 'private', 'generated');
  assert.deepEqual(funnelReport().recipeActivity, before);
});

test('saving and archiving do not inflate generated results; cache cleanup preserves analytics and account deletion cascades', () => {
  const value = user();
  const suggestion = createRecipeSuggestion(value.id, 'Soup', { title: 'Soup', ingredients: [], steps: [] });
  const recipe = saveRecipeSuggestion(value.id, suggestion.id);
  saveRecipeSuggestion(value.id, suggestion.id);
  createRecipe(value.id, { title: 'Draft' });
  createRecipe(value.id, { title: 'Import', status: 'ready' });
  db.prepare("UPDATE recipes SET status='archived' WHERE id=?").run(recipe.id);
  db.prepare('DELETE FROM recipe_suggestions WHERE id=?').run(suggestion.id);
  assert.equal(report(value).preparedRecipes, 1);
  assert.equal(report(value).savedRecipes, 2);
  assert.equal(report(value).savedRecipeUsers, 1);
  deleteUserData(value.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM recipe_request_results WHERE user_id=?').get(value.id).n, 0);
  assert.equal(report(value).preparedRecipes, 0);
});

test('only successful enabling configures notifications, disabling keeps history and denied enabling creates no metric', () => {
  const value = user(), schedule = { enabled: true, weekdays: [1, 3], time: '18:00', timezone: 'Europe/Moscow' };
  assert.throws(() => saveNotificationSchedule(value.id, schedule));
  assert.equal(report(value).notificationUsers, 0);
  startTrial(value.id);
  saveNotificationSchedule(value.id, schedule);
  saveNotificationSchedule(value.id, schedule);
  assert.equal(report(value).notificationUsers, 1);
  assert.equal(report(value).notificationsEnabledUsers, 1);
  saveNotificationSchedule(value.id, { ...schedule, enabled: false });
  assert.equal(report(value).notificationUsers, 1);
  assert.equal(report(value).notificationsEnabledUsers, 0);
});

test('upgrade recovers retained suggestions and enabled schedules once, then preserves records after cleanup and disable', () => {
  const legacyFile = path.resolve('data', `activity-upgrade-${randomUUID()}.sqlite`);
  const run = code => {
    const response = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8',
      env: { ...process.env, DATABASE_PATH: legacyFile } });
    assert.equal(response.status, 0, response.stderr);
    return JSON.parse(response.stdout);
  };
  try {
    run(`const {db,upsertTelegramUser}=await import('./src/db.js');await import('./src/notification-store.js');
      const u=upsertTelegramUser({id:47099});
      db.prepare("INSERT INTO recipe_suggestions(id,user_id,query,recipe_json,created_at) VALUES('legacy',?,'soup','{}','2026-10-01T09:00:00.000Z')").run(u.id);
      db.exec('DROP TABLE recipe_request_results; ALTER TABLE notification_schedules DROP COLUMN first_enabled_at');
      db.prepare("INSERT INTO notification_schedules(user_id,enabled,created_at,updated_at) VALUES(?,1,'2026-10-01T09:00:00.000Z','2026-10-01T09:00:00.000Z')").run(u.id);
      db.close();console.log('{}');`);
    const migrated = run(`const {db}=await import('./src/db.js');await import('./src/notification-store.js');
      console.log(JSON.stringify({n:db.prepare('SELECT COUNT(*) AS n FROM recipe_request_results').get().n,
      enabledAt:db.prepare('SELECT first_enabled_at FROM notification_schedules').get().first_enabled_at}));
      db.exec('DELETE FROM recipe_suggestions;UPDATE notification_schedules SET enabled=0');db.close();`);
    assert.equal(migrated.n, 1);
    assert.equal(migrated.enabledAt, '2026-10-01T09:00:00.000Z');
    const restarted = run(`const {db}=await import('./src/db.js');await import('./src/notification-store.js');
      console.log(JSON.stringify({n:db.prepare('SELECT COUNT(*) AS n FROM recipe_request_results').get().n,
      enabledAt:db.prepare('SELECT first_enabled_at FROM notification_schedules').get().first_enabled_at}));db.close();`);
    assert.deepEqual(restarted, migrated);
  } finally { for (const suffix of ['', '-wal', '-shm']) fs.rmSync(legacyFile + suffix, { force: true }); }
});

test('MAX activity adds counters and recalculates return rate; outage and invalid counts stay explicit', async () => {
  const local = funnelReport(), snapshot = maxFunnelSnapshot();
  const options = { enabled: true, origin: 'https://recipeboibot-max.89-223-123-75.sslip.io', token: 'a'.repeat(43), transport: async () => Response.json(snapshot) };
  const combined = await mergeMaxFunnelReport(local, options);
  assert.equal(combined.recipeActivity.preparedRecipes, local.recipeActivity.preparedRecipes * 2);
  assert.equal(combined.recipeActivity.returnedRecipeUsers, local.recipeActivity.returnedRecipeUsers * 2);
  assert.equal(combined.recipeActivity.returnRate, local.recipeActivity.returnRate);
  const specific = { ...local, campaign: { slug: snapshot.placement } };
  const failed = await mergeMaxFunnelReport(specific, { ...options, transport: async () => { throw new Error('offline'); } });
  assert.equal(failed.recipeActivity.preparedRecipes, null);
  snapshot.campaign.recipeActivity.returnedRecipeUsers = 999;
  const invalid = await mergeMaxFunnelReport(specific, options);
  assert.equal(invalid.remoteFunnel.status, 'error');
});
