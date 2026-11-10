import fs from 'node:fs';
import path from 'node:path';
import { MAX_RESULT_URL } from './payment-routing.js';

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || process.env[match[1]]) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[match[1]] = value;
  }
}

loadEnvFile(path.resolve('.env.local'));
loadEnvFile(path.resolve('.env'));

const integer = (name, fallback) => {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) ? value : fallback;
};

const csvIntegers = (name, fallback) => (process.env[name] || fallback)
  .split(',').map((value) => Number(value.trim()));

const robokassaHash = String(process.env.ROBOKASSA_HASH_ALGORITHM || 'md5').toLowerCase();
const paymentPriceVariants = csvIntegers('PAYMENT_PRICE_VARIANTS', '199');
const botPlatform = process.env.BOT_PLATFORM || 'telegram';
const robokassaCredentials = {
  merchantLogin: process.env.ROBOKASSA_MERCHANT_LOGIN || '',
  password1: process.env.ROBOKASSA_PASSWORD1 || '',
  password2: process.env.ROBOKASSA_PASSWORD2 || ''
};

export const config = Object.freeze({
  botPlatform,
  maxToken: process.env.MAX_BOT_TOKEN || '',
  maxBotUsername: process.env.MAX_BOT_USERNAME || '',
  maxApiOrigin: (process.env.MAX_API_ORIGIN || 'https://platform-api2.max.ru').replace(/\/+$/, ''),
  maxWebhookSecret: process.env.MAX_WEBHOOK_SECRET || '',
  maxFeedbackUserId: process.env.MAX_FEEDBACK_USER_ID || '',
  maxTestResetUserId: process.env.MAX_TEST_RESET_USER_ID || '',
  port: integer('PORT', 3087),
  appUrl: (process.env.APP_URL || '').replace(/\/$/, ''),
  databasePath: path.resolve(process.env.DATABASE_PATH || './data/recipes.sqlite'),
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || '',
  feedbackChatId: process.env.FEEDBACK_CHAT_ID || '6971956699',
  analyticsOwnerId: botPlatform === 'max' ? 'max:' + (process.env.MAX_ANALYTICS_OWNER_ID || process.env.MAX_TEST_RESET_USER_ID || '6971956699') : process.env.ANALYTICS_OWNER_ID || '6971956699',
  maxFunnelToken: process.env.MAX_FUNNEL_TOKEN || '',
  maxFunnelOrigin: process.env.MAX_FUNNEL_ORIGIN || '',
  dashboardPreview: process.env.DASHBOARD_PREVIEW === 'true' && process.env.NODE_ENV !== 'production',
  yandexDirectToken: process.env.YANDEX_DIRECT_TOKEN || '',
  yandexMetrikaCounterId: integer('YANDEX_METRIKA_COUNTER_ID', 0),
  yandexMetrikaToken: process.env.YANDEX_METRIKA_TOKEN || '',
  yandexDirectLogin: process.env.YANDEX_DIRECT_LOGIN || '',
  yandexDirectCampaignId: process.env.YANDEX_DIRECT_CAMPAIGN_ID || '715053149',
  yandexDirectLandingCampaignId: process.env.YANDEX_DIRECT_LANDING_CAMPAIGN_ID || '',
  yandexDirectOutsideCampaignId: process.env.YANDEX_DIRECT_OUTSIDE_CAMPAIGN_ID || '',
  yandexDirectMaxCampaignId: process.env.YANDEX_DIRECT_MAX_CAMPAIGN_ID || '',
  yandexDirectRecipeFirstCampaignId: process.env.YANDEX_DIRECT_RECIPE_FIRST_CAMPAIGN_ID || '',
  yandexDirectProductCampaignId: process.env.YANDEX_DIRECT_PRODUCT_CAMPAIGN_ID || '',
  yandexDirectRsyaCampaignId: process.env.YANDEX_DIRECT_RSYA_CAMPAIGN_ID || '',
  yandexDirectPlacement: process.env.YANDEX_DIRECT_PLACEMENT || 'ya-dinner-202610',
  telegramPolling: botPlatform === 'telegram' && process.env.TELEGRAM_POLLING !== 'false',
  testContour: process.env.TEST_CONTOUR === 'true',
  // Retired with the collection-first product. Saved schedules must never opt users back in.
  legacyDinnerNotificationsEnabled: process.env.LEGACY_DINNER_NOTIFICATIONS_ENABLED === 'true',
  chatRecipeGenerationEnabled: process.env.CHAT_RECIPE_GENERATION_ENABLED
    ? process.env.CHAT_RECIPE_GENERATION_ENABLED !== 'false' : process.env.TEST_CONTOUR !== 'true',
  testBotUsername: process.env.TEST_BOT_USERNAME || '',
  testPriceVariants: csvIntegers('TEST_PRICE_VARIANTS', '129'),
  billingRequired: process.env.BILLING_REQUIRED === 'true',
  paymentPriceVariants,
  paymentExperimentKey: process.env.PAYMENT_EXPERIMENT_KEY || 'monthly-price-199-v1',
  paymentTax: process.env.PAYMENT_TAX || '',
  paymentSno: process.env.PAYMENT_SNO || '',
  paymentMethod: process.env.PAYMENT_METHOD || 'full_payment',
  robokassaMerchantLogin: robokassaCredentials.merchantLogin,
  robokassaPassword1: robokassaCredentials.password1,
  robokassaPassword2: robokassaCredentials.password2,
  robokassaHash,
  robokassaTest: process.env.ROBOKASSA_TEST === 'true',
  robokassaRecurring: process.env.ROBOKASSA_RECURRING_ENABLED === 'true',
  robokassaTestResultUrl: (process.env.ROBOKASSA_TEST_RESULT_URL || '').replace(/\/$/, ''),
  robokassaMaxResultUrl: process.env.ROBOKASSA_MAX_RESULT_URL || MAX_RESULT_URL,
  robokassaConfigured: Object.values(robokassaCredentials).every(Boolean) && Boolean(process.env.PAYMENT_TAX),
  openaiKey: process.env.OPENAI_API_KEY || '',
  textModel: process.env.OPENAI_TEXT_MODEL || '',
  dinnerTextModel: process.env.DINNER_TEXT_MODEL || process.env.OPENAI_TEXT_MODEL || '',
  dinnerValidatorModel: process.env.DINNER_VALIDATOR_MODEL || process.env.DINNER_TEXT_MODEL || process.env.OPENAI_TEXT_MODEL || '',
  dinnerLlmEnabled: process.env.DINNER_LLM_ENABLED !== 'false',
  dinnerGenerationTimeoutMs: Math.min(120000, Math.max(10000, integer('DINNER_GENERATION_TIMEOUT_MS', 60000))),
  dinnerImagesEnabled: process.env.DINNER_IMAGES_ENABLED !== 'false',
  imageModel: process.env.OPENAI_IMAGE_MODEL || '',
  transcribeModel: process.env.OPENAI_TRANSCRIBE_MODEL || '',
  ytDlpPath: process.env.YTDLP_PATH || 'yt-dlp',
  ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
  ffprobePath: process.env.FFPROBE_PATH || 'ffprobe',
  aiMaxInputChars: integer('AI_MAX_INPUT_CHARS', 30000),
  maxUploadBytes: integer('MAX_UPLOAD_BYTES', 6 * 1024 * 1024),
  maxRemoteBytes: integer('MAX_REMOTE_BYTES', 1536 * 1024),
  trustProxy: process.env.TRUST_PROXY === 'true',
  webLoginPrototypeEnabled: process.env.WEB_LOGIN_PROTOTYPE_ENABLED === 'true',
  webLoginOwnerId: process.env.WEB_LOGIN_OWNER_MAX_ID || '',
  webLoginOrigin: process.env.WEB_LOGIN_ORIGIN || '',
  production: process.env.NODE_ENV === 'production'
});

export function assertConfig() {
  if (!['telegram', 'max'].includes(config.botPlatform)) throw new Error('Неверный BOT_PLATFORM');
  const missing = [];
  const transportCredential = config.botPlatform === 'max' ? ['MAX_BOT_TOKEN', config.maxToken] : ['TELEGRAM_BOT_TOKEN', config.telegramToken];
  for (const [name, value] of [['OPENAI_API_KEY', config.openaiKey], ['OPENAI_TEXT_MODEL', config.textModel], ['OPENAI_TRANSCRIBE_MODEL', config.transcribeModel], transportCredential]) {
    if (!value) missing.push(name);
  }
  if (missing.length) throw new Error(`Не настроены: ${missing.join(', ')}`);
  if (config.botPlatform === 'max') {
    if (!/^[A-Za-z0-9_]{5,64}$/.test(config.maxBotUsername)) throw new Error('Не настроен MAX_BOT_USERNAME');
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(config.maxWebhookSecret)) throw new Error('Не настроен MAX_WEBHOOK_SECRET');
    if (config.maxApiOrigin !== 'https://platform-api2.max.ru') throw new Error('Неверный MAX_API_ORIGIN');
    if (config.telegramToken) throw new Error('MAX-контур не должен содержать TELEGRAM_BOT_TOKEN');
    if (config.yandexDirectToken) throw new Error('MAX-контур не должен содержать YANDEX_DIRECT_TOKEN');
    if (config.testContour || config.robokassaTest) throw new Error('Оплата MAX использует отдельный основной контур');
  }
  if (config.botPlatform === 'telegram' && config.testContour && !/^[A-Za-z0-9_]{5,32}$/.test(config.testBotUsername)) throw new Error('Не настроен TEST_BOT_USERNAME');
  if (config.testContour && (config.testPriceVariants.length === 0 || config.testPriceVariants.some((value) => !Number.isSafeInteger(value) || value < 1 || value > 100000) || new Set(config.testPriceVariants).size !== config.testPriceVariants.length)) throw new Error('Неверный TEST_PRICE_VARIANTS');
  if (config.paymentPriceVariants.length === 0 || config.paymentPriceVariants.some((value) => !Number.isSafeInteger(value) || value < 1 || value > 100000) || new Set(config.paymentPriceVariants).size !== config.paymentPriceVariants.length) throw new Error('Неверный PAYMENT_PRICE_VARIANTS');
  if (!['md5', 'ripemd160', 'sha1', 'sha256', 'sha384', 'sha512'].includes(config.robokassaHash)) throw new Error('Неверный ROBOKASSA_HASH_ALGORITHM');
  const robokassaValues = [config.robokassaMerchantLogin, config.robokassaPassword1, config.robokassaPassword2];
  if (robokassaValues.some(Boolean) && !robokassaValues.every(Boolean)) throw new Error('ROBOKASSA_MERCHANT_LOGIN, ROBOKASSA_PASSWORD1 и ROBOKASSA_PASSWORD2 должны быть заданы вместе');
  if (robokassaValues.every(Boolean) && !config.paymentTax) throw new Error('Для Robokassa необходимо настроить PAYMENT_TAX');
  if (!config.testContour && config.robokassaTest) throw new Error('ROBOKASSA_TEST нельзя включать в основном контуре');
  if (config.robokassaTestResultUrl) {
    let testResultUrl;
    try { testResultUrl = new URL(config.robokassaTestResultUrl); } catch { throw new Error('Неверный ROBOKASSA_TEST_RESULT_URL'); }
    if (testResultUrl.protocol !== 'https:' || testResultUrl.pathname !== '/api/payments/robokassa/result') throw new Error('Неверный ROBOKASSA_TEST_RESULT_URL');
  }
  if (config.robokassaMaxResultUrl !== MAX_RESULT_URL) throw new Error('Неверный ROBOKASSA_MAX_RESULT_URL');
  if (config.robokassaRecurring && !config.robokassaConfigured) throw new Error('Автопродление требует полной настройки Robokassa');
  if (config.billingRequired && config.testContour) throw new Error('BILLING_REQUIRED предназначен только для основного контура');
  if (config.billingRequired && !config.robokassaConfigured) throw new Error('BILLING_REQUIRED=true требует полной настройки Robokassa');
}
