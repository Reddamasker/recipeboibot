import fs from 'node:fs';
import path from 'node:path';

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
const robokassaCredentials = {
  merchantLogin: process.env.ROBOKASSA_MERCHANT_LOGIN || '',
  password1: process.env.ROBOKASSA_PASSWORD1 || '',
  password2: process.env.ROBOKASSA_PASSWORD2 || ''
};

export const config = Object.freeze({
  port: integer('PORT', 3087),
  appUrl: (process.env.APP_URL || '').replace(/\/$/, ''),
  databasePath: path.resolve(process.env.DATABASE_PATH || './data/recipes.sqlite'),
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramPolling: process.env.TELEGRAM_POLLING !== 'false',
  testContour: process.env.TEST_CONTOUR === 'true',
  testOwnerTelegramId: process.env.TEST_OWNER_TELEGRAM_ID || '',
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
  aiMaxInputChars: integer('AI_MAX_INPUT_CHARS', 30000),
  maxUploadBytes: integer('MAX_UPLOAD_BYTES', 6 * 1024 * 1024),
  maxRemoteBytes: integer('MAX_REMOTE_BYTES', 1536 * 1024),
  trustProxy: process.env.TRUST_PROXY === 'true',
  production: process.env.NODE_ENV === 'production'
});

export function assertConfig() {
  const missing = [];
  for (const [name, value] of [['OPENAI_API_KEY', config.openaiKey], ['OPENAI_TEXT_MODEL', config.textModel], ['OPENAI_TRANSCRIBE_MODEL', config.transcribeModel], ['TELEGRAM_BOT_TOKEN', config.telegramToken]]) {
    if (!value) missing.push(name);
  }
  if (missing.length) throw new Error(`Не настроены: ${missing.join(', ')}`);
  if (config.testContour && !/^[1-9][0-9]*$/.test(config.testOwnerTelegramId)) throw new Error('Не настроен TEST_OWNER_TELEGRAM_ID');
  if (config.testContour && !/^[A-Za-z0-9_]{5,32}$/.test(config.testBotUsername)) throw new Error('Не настроен TEST_BOT_USERNAME');
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
  if (config.robokassaRecurring && !config.robokassaConfigured) throw new Error('Автопродление требует полной настройки Robokassa');
  if (config.billingRequired && config.testContour) throw new Error('BILLING_REQUIRED предназначен только для основного контура');
  if (config.billingRequired && !config.robokassaConfigured) throw new Error('BILLING_REQUIRED=true требует полной настройки Robokassa');
}
