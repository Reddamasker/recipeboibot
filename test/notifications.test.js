import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const testDb = path.resolve('data', `notifications-${process.pid}.sqlite`);
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
const notifications = await import('../src/notifications.js');
const telegram = await import('../src/telegram.js');
const security = await import('../src/security.js');
const { createServer } = await import('../src/server.js');

test.after(() => {
  database.db.close();
  for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(testDb + suffix); } catch {} }
});

test('schedule validates weekdays and computes the next minute in the saved timezone', () => {
  const user = database.upsertTelegramUser({ id: 7101, first_name: 'Расписание' });
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
    const rejected = await fetch(`${base}/api/notifications/schedule`, { method: 'PUT', headers, body: JSON.stringify({ enabled: true, weekdays: [], time: '19:00', timezone: 'Europe/Moscow' }) });
    assert.equal(rejected.status, 400);
    const savedResponse = await fetch(`${base}/api/notifications/schedule`, { method: 'PUT', headers, body: JSON.stringify({ enabled: true, weekdays: [2, 4], time: '19:00', timezone: 'Asia/Yekaterinburg' }) });
    assert.equal(savedResponse.status, 200);
    const saved = await savedResponse.json();
    assert.deepEqual(saved.weekdays, [2, 4]);
    assert.equal(saved.timezone, 'Asia/Yekaterinburg');
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
