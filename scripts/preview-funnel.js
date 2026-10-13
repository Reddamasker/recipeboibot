// Isolated dashboard demo: no production database, Telegram polling or AI.
import fs from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
process.env.DATABASE_PATH = './data/funnel-preview.sqlite';
process.env.DASHBOARD_PREVIEW = 'true';
process.env.NODE_ENV = 'development';
process.env.APP_URL = 'http://127.0.0.1:3091';
process.env.TELEGRAM_BOT_TOKEN = 'local-preview-only';
process.env.TELEGRAM_POLLING = 'false';
process.env.DINNER_LLM_ENABLED = 'false';
process.env.DINNER_IMAGES_ENABLED = 'false';
process.env.OPENAI_API_KEY = 'local-preview-disabled';
const { createServer } = await import('../src/server.js');
const { db, upsertTelegramUser, allowUser, createRecipe, recordRecipeRequestResult } = await import('../src/db.js');
const { createCampaign, setCampaignStats, recordBotStart } = await import('../src/funnel.js');
const { startTrial } = await import('../src/subscriptions.js');
const { saveNotificationSchedule } = await import('../src/notification-store.js');
const { createDashboardPassword } = await import('../src/funnel-auth.js');
const { recordEngagement } = await import('../src/recipe-engagement.js');
const { recordProduct } = await import('../src/product-analytics.js');
const since = '2026-10-01T08:00:00.000Z';
const placements = [['kitchen-oct', 'Канал «Домашняя кухня»', 12400, 9100, 380], ['telegram-oct', 'Telegram — октябрь', 8300, 6100, 220], ['friends', 'Рекомендации и друзья', 2700, null, 90]];
for (const [slug, name, impressions, reach, clicks] of placements) {
  createCampaign(slug, name); setCampaignStats(slug, impressions, reach);
  const count = db.prepare('SELECT COUNT(*) AS n FROM acquisition_clicks WHERE campaign=?').get(slug).n;
  for (let i = count; i < clicks; i++) db.prepare('INSERT INTO acquisition_clicks(token,campaign,created_at) VALUES(?,?,?)').run(randomBytes(18).toString('base64url'), slug, since);
}
for (let i = 0; i < 60; i++) {
  const user = upsertTelegramUser({ id: 999500000 + i, first_name: 'Демо пользователь' });
  const slug = placements[i < 32 ? 0 : i < 51 ? 1 : 2][0];
  const clicks = db.prepare('SELECT token FROM acquisition_clicks WHERE campaign=? ORDER BY token').all(slug);
  if (!db.prepare('SELECT 1 FROM acquisition_starts WHERE user_id=?').get(user.id)) recordBotStart(user, `/start ad_${clicks[i].token}`, new Date(since));
  allowUser(user.id);
  if (i < 30) recordProduct(user.id,'screen_view',{id:`demo-home-${i}`,step:'home',at:since});
  if (i < 24) recordProduct(user.id,'screen_view',{id:`demo-request-${i}`,step:'request',at:since});
  if (i < 20) recordProduct(user.id,'step_submit',{id:`demo-submit-${i}`,step:'request',at:since});
  if (i < 20) recordProduct(user.id,'operation_finished',{id:`demo-operation-${i}`,step:'request',durationMs:3000+i*500,detail:{status:i<18?200:503},at:since});
  if (i < 18) recordProduct(user.id,'request_visible',{id:`demo-visible-${i}`,step:'request',durationMs:4000+i*500,at:since});
  if (i < 12) recordProduct(user.id,'screen_view',{id:`demo-price-${i}`,step:'offer',at:since});
  if (i < 30) recordEngagement(user.id, 'recipe_opened', { eventId: `demo-open-${i}`, key: `demo-recipe-${i}`, at: '2026-10-01T08:03:00.000Z' });
  if (i < 9) recordEngagement(user.id, 'recipe_opened', { eventId: `demo-reread-${i}`, key: `demo-recipe-${i}`, at: '2026-10-02T08:03:00.000Z' });
  if (i < 24) recordEngagement(user.id, 'trial_offer_viewed', { eventId: `demo-offer-${i}`, at: '2026-10-01T08:01:00.000Z' });
  if (i < 22) recordEngagement(user.id, 'trial_clicked', { eventId: `demo-click-${i}`, at: '2026-10-01T08:01:30.000Z' });
  if (i < 20) recordEngagement(user.id, 'trial_activated', { eventId: `demo-trial-${i}`, at: '2026-10-01T08:02:00.000Z' });
  if (i < 44) recordRecipeRequestResult(user.id, `demo:first:${i}`, 'generated', '2026-10-01T08:01:00.000Z');
  if (i < 18) recordRecipeRequestResult(user.id, `demo:repeat:${i}`, 'generated', `2026-10-0${i < 12 ? 2 : 1}T09:01:00.000Z`);
  if (i < 44 && !db.prepare('SELECT 1 FROM recipes WHERE user_id=?').get(user.id)) {
    const recipe = createRecipe(user.id, { status: 'ready', title: 'Демонстрационный рецепт' });
    db.prepare('UPDATE recipes SET created_at=? WHERE id=?').run('2026-10-01T08:01:00.000Z', recipe.id);
  }
  if (i < 20) startTrial(user.id, new Date('2026-10-01T08:02:00.000Z'));
  if (i < 10) saveNotificationSchedule(user.id, { enabled: true, weekdays: [1, 3, 5], time: '18:00', timezone: 'Europe/Moscow' }, new Date('2026-10-01T08:04:00.000Z'));
  if (i < 13 && !db.prepare('SELECT 1 FROM payment_orders WHERE user_id=?').get(user.id)) db.prepare(`INSERT INTO payment_orders(id,user_id,experiment_key,variant,amount_kopeks,kind,status,created_at,updated_at,paid_at,is_test) VALUES(?,?,'demo','demo',19900,'initial','paid',?,?,?,0)`).run(randomUUID(), user.id, since, '2026-10-01T08:03:00.000Z', '2026-10-01T08:03:00.000Z');
}
const access = { url: 'http://127.0.0.1:3091/dashboard', password: createDashboardPassword(), demo: true };
fs.writeFileSync('data/funnel-preview-access.json', JSON.stringify(access));
createServer().listen(3091, '127.0.0.1', () => console.log(`DASHBOARD_PREVIEW=${access.url}; access: data/funnel-preview-access.json`));
