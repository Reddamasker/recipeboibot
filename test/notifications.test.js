// Explicit compatibility mode: these tests exercise the archived scheduling implementation.
process.env.LEGACY_DINNER_NOTIFICATIONS_ENABLED = 'true';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';

const testDb = path.resolve('data', `notifications-${randomUUID()}.sqlite`);
process.env.TEST_CONTOUR = 'false';
process.env.DATABASE_PATH = testDb;
process.env.TELEGRAM_BOT_TOKEN = '123456:test-secret';
process.env.OPENAI_API_KEY = 'test-key';
process.env.OPENAI_TEXT_MODEL = 'test-model';
process.env.OPENAI_TRANSCRIBE_MODEL = 'test-transcribe';
process.env.DINNER_LLM_ENABLED = 'false';
process.env.APP_URL = 'https://recipes.example.test';

const database = await import('../src/db.js');
const dinnerStore = await import('../src/dinner-store.js');
const dinnerService = await import('../src/dinner-service.js');
const notificationStore = await import('../src/notification-store.js');
const subscriptions = await import('../src/subscriptions.js');
const grant = (userId, plan = 'subscription') => subscriptions.grantSubscription(userId, plan, '2099-01-01T00:00:00Z', new Date('2026-01-01T00:00:00Z'));
const notifications = await import('../src/notifications.js');
const telegram = await import('../src/telegram.js');
const security = await import('../src/security.js');
const { createServer } = await import('../src/server.js');

test.after(() => {
  database.db.close();
  for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(testDb + suffix); } catch {} }
});
test.afterEach(() => database.db.prepare('UPDATE notification_schedules SET enabled=0').run());

test('schedule validates weekdays and computes the next minute in the saved timezone', () => {
  const user = database.upsertTelegramUser({ id: 7101, first_name: 'Расписание' });
  grant(user.id);
  const from = new Date('2026-09-27T12:00:00.000Z'); // Sunday, 15:00 in Moscow.
  const schedule = notificationStore.saveNotificationSchedule(user.id, { enabled: true, weekdays: [1, 3, 5], time: '18:30', timezone: 'Europe/Moscow' }, from);
  assert.deepEqual(schedule.weekdays, [1, 3, 5]);
  assert.equal(schedule.nextDueAt, '2026-09-28T15:30:00.000Z');
  assert.throws(() => notificationStore.saveNotificationSchedule(user.id, { enabled: true, weekdays: [], time: '18:30', timezone: 'Europe/Moscow' }), /хотя бы один день/);
  assert.throws(() => notificationStore.saveNotificationSchedule(user.id, { enabled: true, weekdays: [1], time: '25:00', timezone: 'Europe/Moscow' }), /время/);
  assert.throws(() => notificationStore.saveNotificationSchedule(user.id, { enabled: true, weekdays: [1], time: '18:30', timezone: 'Mars\/Olympus' }), /часовой пояс/);
  notificationStore.saveNotificationSchedule(user.id, { enabled: false, weekdays: schedule.weekdays, time: schedule.time, timezone: schedule.timezone }, from);
});

test('a due minute sends one Telegram reminder and never duplicates the same local occurrence', async () => {
  const telegramUser = { id: 7102, first_name: 'Напоминание' };
  const user = database.upsertTelegramUser(telegramUser); database.allowUser(user.id);
  grant(user.id);
  dinnerStore.saveFoodProfile(user.id, { householdType: 'self', householdSize: 1, hasChildren: false, preferredMaxCookingTime: 30, excludedIngredients: [], preferredCategories: {}, onboardingCompleted: true, tastePreferencesStatus: 'completed' });
  const from = new Date('2026-09-27T12:00:00.000Z');
  const due = new Date('2026-09-28T15:30:00.000Z');
  notificationStore.saveNotificationSchedule(user.id, { enabled: true, weekdays: [1], time: '18:30', timezone: 'Europe/Moscow' }, from);
  const reminders = [];
  await notifications.runNotificationCycle({ sendReminder: async (delivery) => reminders.push(delivery), sendChoice: assert.fail }, due);
  assert.equal(reminders.length, 1);
  assert.equal(reminders[0].telegramId, String(telegramUser.id));
  assert.ok(reminders[0].sessionId);
  assert.equal(database.db.prepare('SELECT status FROM notification_deliveries').get().status, 'sent');
  await notifications.runNotificationCycle({ sendReminder: async (delivery) => reminders.push(delivery), sendChoice: assert.fail }, due);
  assert.equal(reminders.length, 1);
  assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM notification_deliveries').get().count, 1);
});

test('notification choice is bound to its user and session, then queues one recipe link', async () => {
  const telegramUser = { id: 7103, first_name: 'Выбор' };
  const user = database.upsertTelegramUser(telegramUser); database.allowUser(user.id);
  grant(user.id, 'premium');
  dinnerStore.saveFoodProfile(user.id, { householdType: 'couple', householdSize: 2, hasChildren: false, preferredMaxCookingTime: 45, excludedIngredients: [], preferredCategories: {}, onboardingCompleted: true, tastePreferencesStatus: 'completed' });
  const from = new Date('2026-09-27T12:00:00.000Z');
  const due = new Date('2026-09-28T15:30:00.000Z');
  notificationStore.saveNotificationSchedule(user.id, { enabled: true, weekdays: [1], time: '18:30', timezone: 'Europe/Moscow' }, from);
  let delivery;
  await notifications.runNotificationCycle({ sendReminder: async (value) => { delivery = value; }, sendChoice: assert.fail }, due);
  const opened = notifications.openNotificationDinner(user.id, delivery.id);
  const dinner = await dinnerService.recommendDinner(user.id, opened.sessionId);
  assert.equal(dinner.recommendations.length, 3);
  const selected = notifications.selectNotificationDinner(user.id, delivery.id, dinner.recommendations[1].id);
  assert.equal(selected.status, 'accepted');
  assert.equal(selected.recipe.id, dinner.recommendations[1].recipe.id);
  const stranger = database.upsertTelegramUser({ id: 7104, first_name: 'Чужой' });
  assert.throws(() => notifications.openNotificationDinner(stranger.id, delivery.id), /недоступно/);
  assert.throws(() => notifications.selectNotificationDinner(user.id, delivery.id, dinner.recommendations[0].id), /уже выбран/);
  const links = [];
  await notifications.runNotificationCycle({ sendReminder: assert.fail, sendChoice: async (pending, recipe) => links.push([pending, recipe]) }, new Date(Date.now() + 60000));
  assert.equal(links.length, 1);
  assert.equal(links[0][0].telegramId, String(telegramUser.id));
  assert.equal(links[0][1].id, selected.recipe.id);
  await notifications.runNotificationCycle({ sendReminder: assert.fail, sendChoice: async () => links.push('duplicate') }, new Date(Date.now() + 120000));
  assert.equal(links.length, 1);
  const reopened = notifications.openNotificationDinner(user.id, delivery.id);
  assert.equal(reopened.acceptedOption.recipe.id, selected.recipe.id);
});

test('schedule API is private and persists device timezone without accepting an empty enabled week', async () => {
  const telegramUser = { id: 7105, first_name: 'API' };
  const user = database.upsertTelegramUser(telegramUser); database.allowUser(user.id);
  const server = createServer(); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { authorization: `tma ${security.makeTelegramInitData(telegramUser, process.env.TELEGRAM_BOT_TOKEN)}`, 'content-type': 'application/json' };
  try {
    assert.equal((await fetch(`${base}/api/notifications/schedule`)).status, 401);
    const initial = await (await fetch(`${base}/api/notifications/schedule`, { headers })).json();
    assert.equal(initial.enabled, false);
    assert.equal(initial.access.active, false);
    const denied = await fetch(`${base}/api/notifications/schedule`, { method: 'PUT', headers, body: JSON.stringify({ enabled: true, weekdays: [1], time: '19:00', timezone: 'Europe/Moscow', access: { active: true }, premium: true }) });
    assert.equal(denied.status, 402, 'client cannot grant itself subscription access');
    assert.equal(notificationStore.getNotificationSchedule(user.id).enabled, false);
    grant(user.id);
    const rejected = await fetch(`${base}/api/notifications/schedule`, { method: 'PUT', headers, body: JSON.stringify({ enabled: true, weekdays: [], time: '19:00', timezone: 'Europe/Moscow' }) });
    assert.equal(rejected.status, 400);
    const savedResponse = await fetch(`${base}/api/notifications/schedule`, { method: 'PUT', headers, body: JSON.stringify({ enabled: true, weekdays: [2, 4], time: '19:00', timezone: 'Asia/Yekaterinburg' }) });
    assert.equal(savedResponse.status, 200);
    const saved = await savedResponse.json();
    assert.deepEqual(saved.weekdays, [2, 4]);
    assert.equal(saved.timezone, 'Asia/Yekaterinburg');
    subscriptions.revokeSubscription(user.id);
    const expired = await (await fetch(`${base}/api/notifications/schedule`, { headers })).json();
    assert.equal(expired.paused, true);
    assert.equal(expired.nextDueAt, null);
    const disabled = await fetch(`${base}/api/notifications/schedule`, { method: 'PUT', headers, body: JSON.stringify({ ...saved, enabled: false }) });
    assert.equal(disabled.status, 200);
    assert.equal((await disabled.json()).enabled, false);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('Telegram messages contain the scheduled collection and chosen recipe web-app links', async () => {
  const originalFetch = globalThis.fetch; const sent = [];
  globalThis.fetch = async (_url, options) => { sent.push(JSON.parse(options.body)); return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 }); };
  try {
    const delivery = { id: '11111111-1111-4111-8111-111111111111', telegramId: '7106' };
    await telegram.sendNotificationReminder(delivery);
    await telegram.sendNotificationRecipeLink(delivery, { id: 'seed:vegetable-soup', title: 'Овощной суп' });
    assert.match(sent[0].reply_markup.inline_keyboard[0][0].web_app.url, /view=dinner/);
    assert.match(sent[0].reply_markup.inline_keyboard[0][0].web_app.url, /notification=11111111-1111-4111-8111-111111111111/);
    assert.match(sent[1].text, /Овощной суп/);
    assert.match(sent[1].reply_markup.inline_keyboard[0][0].web_app.url, /recipe=seed%3Avegetable-soup/);
  } finally { globalThis.fetch = originalFetch; }
});

test('mobile settings expose the notification schedule controls and narrow-screen layout', () => {
  const app = fs.readFileSync(path.resolve('public/app.js'), 'utf8');
  const styles = fs.readFileSync(path.resolve('public/styles.css'), 'utf8');
  assert.match(app, /Напоминания об ужине/);
  assert.match(app, /name="weekday"/);
  assert.match(app, /type="time"/);
  assert.match(app, /resolvedOptions\(\)\.timeZone/);
  assert.match(styles, /\.notification-days/);
  assert.match(styles, /grid-template-columns:\s*repeat\(7,\s*minmax\(0,\s*1fr\)\)/);
});

test('subscription expiry skips an occurrence without generating dinner; renewal resumes the saved schedule', async (t) => {
  const from = new Date('2026-09-27T12:00:00Z'), due = new Date('2026-09-28T15:30:00Z');
  // The scheduler and recipe access checks must share this historical clock.
  t.mock.timers.enable({ apis: ['Date'], now: from });
  const user = database.upsertTelegramUser({ id: 7201, first_name: 'Expiry' });
  subscriptions.grantSubscription(user.id, 'subscription', due, from);
  notificationStore.saveNotificationSchedule(user.id, { enabled: true, weekdays: [1], time: '18:30', timezone: 'Europe/Moscow' }, from);
  t.mock.timers.setTime(due.getTime());
  await notifications.runNotificationCycle({ sendReminder: assert.fail, sendChoice: assert.fail }, due);
  assert.equal(database.db.prepare('SELECT COUNT(*) AS n FROM dinner_sessions WHERE user_id=?').get(user.id).n, 0);
  assert.equal(database.db.prepare('SELECT COUNT(*) AS n FROM notification_deliveries WHERE user_id=?').get(user.id).n, 0);
  const paused = notificationStore.getNotificationSchedule(user.id, due);
  assert.equal(paused.enabled, true);
  assert.equal(paused.paused, true);
  assert.equal(paused.nextDueAt, null);
  subscriptions.grantSubscription(user.id, 'premium', '2026-11-01T00:00:00Z', due);
  const resumed = notificationStore.getNotificationSchedule(user.id, due);
  assert.equal(resumed.paused, false);
  assert.deepEqual(resumed.weekdays, [1]);
  assert.equal(resumed.nextDueAt, '2026-10-05T15:30:00.000Z');
  let sends = 0;
  t.mock.timers.setTime(Date.parse(resumed.nextDueAt));
  await notifications.runNotificationCycle({ sendReminder: async () => sends++, sendChoice: assert.fail }, new Date(resumed.nextDueAt));
  assert.equal(sends, 1);
});

test('revoked subscription cancels queued reminders before preparation and allows disabling the schedule', async () => {
  const user = database.upsertTelegramUser({ id: 7202, first_name: 'Revoked' });
  const from = new Date('2026-09-27T12:00:00Z'), due = new Date('2026-09-28T15:30:00Z');
  grant(user.id);
  const input = { enabled: true, weekdays: [1], time: '18:30', timezone: 'Europe/Moscow' };
  notificationStore.saveNotificationSchedule(user.id, input, from);
  const [id] = notificationStore.enqueueDueNotifications(due);
  subscriptions.revokeSubscription(user.id, due);
  await notifications.runNotificationCycle({ sendReminder: assert.fail, sendChoice: assert.fail }, due);
  assert.equal(notificationStore.getNotificationDelivery(user.id, id).status, 'failed');
  assert.equal(database.db.prepare('SELECT COUNT(*) AS n FROM dinner_sessions WHERE user_id=?').get(user.id).n, 0);
  assert.equal(notificationStore.saveNotificationSchedule(user.id, { ...input, enabled: false }, due).enabled, false);
});

test('expiry blocks opening/choosing an old notification and drops unsent choice retries', async () => {
  const user = database.upsertTelegramUser({ id: 7203, first_name: 'Old link' });
  grant(user.id);
  const from = new Date('2026-09-27T12:00:00Z'), due = new Date('2026-09-28T15:30:00Z');
  notificationStore.saveNotificationSchedule(user.id, { enabled: true, weekdays: [1], time: '18:30', timezone: 'Europe/Moscow' }, from);
  let delivery;
  await notifications.runNotificationCycle({ sendReminder: async (value) => { delivery = value; }, sendChoice: assert.fail }, due);
  const dinner = await dinnerService.recommendDinner(user.id, delivery.sessionId);
  subscriptions.revokeSubscription(user.id);
  assert.throws(() => notifications.openNotificationDinner(user.id, delivery.id), { status: 402 });
  assert.throws(() => notifications.selectNotificationDinner(user.id, delivery.id, dinner.recommendations[0].id), { status: 402 });
  grant(user.id);
  notifications.selectNotificationDinner(user.id, delivery.id, dinner.recommendations[0].id);
  subscriptions.revokeSubscription(user.id);
  await notifications.runNotificationCycle({ sendReminder: assert.fail, sendChoice: assert.fail }, new Date(Date.now() + 60000));
  grant(user.id);
  await notifications.runNotificationCycle({ sendReminder: assert.fail, sendChoice: assert.fail }, new Date(Date.now() + 120000));
  const row = database.db.prepare('SELECT * FROM notification_deliveries WHERE id=?').get(delivery.id);
  assert.equal(row.status, 'chosen');
  assert.equal(row.choice_sent_at, null);
  assert.equal(row.choice_retry_at, null);
});

test('production ignores mock payments and Telegram premium; subscription state cannot cross users', () => {
  const user = database.upsertTelegramUser({ id: 7204, first_name: 'Free', is_premium: true });
  database.db.exec('CREATE TABLE IF NOT EXISTS mock_payments (user_id TEXT PRIMARY KEY, active INTEGER, updated_at TEXT)');
  database.db.prepare('INSERT INTO mock_payments VALUES(?,1,?)').run(user.id, new Date().toISOString());
  assert.equal(subscriptions.getSubscriptionAccess(user.id).active, false);
  const other = database.upsertTelegramUser({ id: 7205, first_name: 'Premium' });
  grant(other.id, 'premium');
  assert.equal(subscriptions.getSubscriptionAccess(other.id).active, true);
  assert.equal(subscriptions.getSubscriptionAccess(user.id).active, false);
  assert.throws(() => subscriptions.grantSubscription(user.id, 'premium', 'invalid'));
  assert.throws(() => subscriptions.grantSubscription(user.id, 'premium', '2000-01-01T00:00:00Z'));
});

test('notification UI locks free access, permits opting out after expiry, and refreshes entitlement on return', async () => {
  const source = fs.readFileSync('public/app.js', 'utf8');
  const handler = source.slice(source.indexOf('async function notificationSettingsPage()'), source.indexOf('\nasync function render()'));
  let schedule = { enabled: false, weekdays: [1], time: '18:00', timezone: 'Europe/Moscow', access: { active: false }, paused: false };
  const elements = Object.fromEntries(['#notifications-back', '#notification-enabled', '#notification-fields', '#notification-form', '#notification-form [type=submit]', '#notification-error', '#notification-time'].map((id) => [id, {}]));
  elements['#notification-time'].value = '18:00';
  elements['#notification-error'].focus = () => {};
  const notices = [], writes = [];
  elements['#notification-form'].before = (notice) => notices.push(notice);
  elements['#notification-form'].querySelector = () => elements['#notification-form [type=submit]'];
  const sandbox = { root: {}, state: { me: { testContour: false } }, Intl, AbortSignal,
    header: () => '', esc: String, bindCommon() {}, trialGuideCloseButton: () => '', setRoute() {}, render() {}, openOffer() {}, toast() {},
    document: { querySelector: (id) => elements[id], querySelectorAll: () => [{ value: '1' }], createElement: () => ({ setAttribute() {}, querySelector: () => null }) },
    api: async (_path, options) => {
      if (options?.method === 'PUT') { const input = JSON.parse(options.body); writes.push(input); schedule = { ...schedule, ...input }; }
      elements['#notification-enabled'].checked = schedule.enabled;
      return schedule;
    }
  };
  sandbox.window = { RecipePlatform: { label: 'MAX' } };
  vm.runInNewContext(handler, sandbox);
  await sandbox.notificationSettingsPage();
  assert.match(sandbox.root.innerHTML, /УВЕДОМЛЕНИЯ В MAX/);
  assert.equal(elements['#notification-enabled'].disabled, true);
  assert.equal(elements['#notification-fields'].disabled, true);
  assert.equal(elements['#notification-form [type=submit]'].disabled, true);
  assert.match(notices.at(-1).innerHTML, /активной подпиской/);
  schedule = { ...schedule, enabled: true, paused: true };
  await sandbox.notificationSettingsPage();
  assert.match(notices.at(-1).innerHTML, /приостановлены/);
  assert.equal(elements['#notification-enabled'].disabled, false);
  elements['#notification-enabled'].checked = false;
  elements['#notification-enabled'].onchange();
  assert.equal(elements['#notification-form [type=submit]'].disabled, false);
  await elements['#notification-form'].onsubmit({ preventDefault() {}, currentTarget: elements['#notification-form'] });
  assert.equal(writes[0].enabled, false);
  schedule = { ...schedule, paused: false, access: { active: true } };
  await sandbox.notificationSettingsPage();
  assert.equal(elements['#notification-enabled'].disabled, false);
  elements['#notification-enabled'].checked = true;
  elements['#notification-enabled'].onchange();
  assert.equal(elements['#notification-fields'].disabled, false);
  assert.equal(elements['#notification-form [type=submit]'].disabled, false);
});
