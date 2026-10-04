import { assertConfig, config } from './config.js';
import { createServer } from './server.js';
import { sendNotificationRecipeLink, sendNotificationReminder, sendFeedbackNotification, startTelegramPolling, stopTelegramPolling } from './telegram.js';
import { startFeedbackScheduler, stopFeedbackScheduler } from './feedback.js';
import { log } from './log.js';
import { getRecipe, interruptActiveJobs, listGeneratedRecipesWithoutImages } from './db.js';
import { ensureRecipeImage } from './recipe-images.js';
import { startNotificationScheduler, stopNotificationScheduler } from './notifications.js';
import { startBillingScheduler, stopBillingScheduler } from './billing.js';
import { startDirectScheduler, stopDirectScheduler } from './yandex-direct.js';

assertConfig();
const interruptedJobs = interruptActiveJobs();
if (interruptedJobs) log('warn', 'import_jobs_recovered', { count: interruptedJobs });
const server = createServer();
server.listen(config.port, '0.0.0.0', () => {
  log('info', 'server_started', { port: config.port, appUrlConfigured: Boolean(config.appUrl) });
  startBillingScheduler();
  startDirectScheduler();
  if (config.imageModel) void (async () => {
    for (const item of listGeneratedRecipesWithoutImages()) await ensureRecipeImage(item.userId, getRecipe(item.userId, item.id));
  })().catch((error) => log('warn', 'recipe_image_backfill_failed', { error }));
  if (config.telegramPolling) {
    startFeedbackScheduler(sendFeedbackNotification);
    startNotificationScheduler({ sendReminder: sendNotificationReminder, sendChoice: sendNotificationRecipeLink });
    startTelegramPolling().catch((error) => log('error', 'telegram_fatal', { error }));
  }
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopDirectScheduler(); stopFeedbackScheduler(); stopBillingScheduler(); stopNotificationScheduler(); stopTelegramPolling(); server.close(() => process.exit(0)); });
