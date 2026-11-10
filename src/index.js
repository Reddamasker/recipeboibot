import { assertConfig, config } from './config.js';
import { createServer } from './server.js';
import { recoverPhotoDrafts } from './photo-drafts.js';
import { sendTrialWelcomeMessage, sendNotificationRecipeLink, sendNotificationReminder, sendFeedbackNotification, startTelegramPolling, stopTelegramPolling, handleChatUpdate } from './telegram.js';
import { maxApiCall } from './max-client.js';
import { startMaxWorker } from './max-events.js';
import { startFeedbackScheduler, stopFeedbackScheduler } from './feedback.js';
import { log } from './log.js';
import { getRecipe, interruptActiveJobs, listGeneratedRecipesWithoutImages } from './db.js';
import { ensureRecipeImage } from './recipe-images.js';
import { startNotificationScheduler, stopNotificationScheduler } from './notifications.js';
import { startBillingScheduler, stopBillingScheduler } from './billing.js';
import { startTrialWelcomeScheduler, stopTrialWelcomeScheduler } from './trial-welcome.js';
import { startDirectScheduler, stopDirectScheduler } from './yandex-direct.js';
import { startTrialReminderScheduler, stopTrialReminderScheduler } from './trial-reminders.js';
import { sendTrialRecipeReminder } from './telegram.js';
import { initializeTrialDigest } from './trial-digest-store.js';
import { startCatalogHandoffScheduler, stopCatalogHandoffScheduler } from './catalog-handoff-transport.js';

assertConfig();
if (config.telegramPolling && config.legacyDinnerNotificationsEnabled) initializeTrialDigest();
let maxBotId;
if (config.botPlatform === 'max') {
  const bot = await maxApiCall('/me');
  if (!bot.is_bot || bot.username?.toLowerCase() !== config.maxBotUsername.toLowerCase()) throw new Error('Unexpected bot token for MAX contour');
  maxBotId = bot.user_id;
}
const interruptedJobs = interruptActiveJobs();
recoverPhotoDrafts();
if (interruptedJobs) log('warn', 'import_jobs_recovered', { count: interruptedJobs });
const server = createServer();
const maxWorker = config.botPlatform === 'max' ? startMaxWorker(handleChatUpdate, { botId: maxBotId, onError: detail => log('warn', 'max_update_failed', detail) }) : null;
server.listen(config.port, '0.0.0.0', () => {
  log('info', 'server_started', { port: config.port, appUrlConfigured: Boolean(config.appUrl) });
  startBillingScheduler();
  startDirectScheduler();
  startCatalogHandoffScheduler();
  if (config.imageModel) void (async () => {
    for (const item of listGeneratedRecipesWithoutImages()) await ensureRecipeImage(item.userId, getRecipe(item.userId, item.id));
  })().catch((error) => log('warn', 'recipe_image_backfill_failed', { error }));
  if (config.telegramPolling || config.botPlatform === 'max') {
    if (config.legacyRecipeFlowsEnabled) startTrialWelcomeScheduler(sendTrialWelcomeMessage);
    startTrialReminderScheduler(sendTrialRecipeReminder);
    startFeedbackScheduler(sendFeedbackNotification);
    if (config.legacyDinnerNotificationsEnabled) startNotificationScheduler({ sendReminder: sendNotificationReminder, sendChoice: sendNotificationRecipeLink });
    if (config.telegramPolling) startTelegramPolling().catch((error) => log('error', 'telegram_fatal', { error }));
  }
});
let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  stopCatalogHandoffScheduler();
  stopTrialReminderScheduler();
  stopTrialWelcomeScheduler(); stopDirectScheduler(); stopFeedbackScheduler(); stopBillingScheduler(); stopNotificationScheduler(); stopTelegramPolling();
  const deadline = setTimeout(() => process.exit(1), 80000); deadline.unref();
  await Promise.all([maxWorker?.stop(), new Promise(resolve => server.close(resolve))]);
  clearTimeout(deadline); process.exit(0);
});
