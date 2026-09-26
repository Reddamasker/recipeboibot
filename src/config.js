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

export const config = Object.freeze({
  port: integer('PORT', 3087),
  appUrl: (process.env.APP_URL || '').replace(/\/$/, ''),
  databasePath: path.resolve(process.env.DATABASE_PATH || './data/recipes.sqlite'),
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramPolling: process.env.TELEGRAM_POLLING !== 'false',
  testContour: process.env.TEST_CONTOUR === 'true',
  testOwnerTelegramId: process.env.TEST_OWNER_TELEGRAM_ID || '',
  testBotUsername: process.env.TEST_BOT_USERNAME || '',
  openaiKey: process.env.OPENAI_API_KEY || '',
  textModel: process.env.OPENAI_TEXT_MODEL || '',
  dinnerTextModel: process.env.DINNER_TEXT_MODEL || process.env.OPENAI_TEXT_MODEL || '',
  dinnerLlmEnabled: process.env.DINNER_LLM_ENABLED !== 'false',
  dinnerGenerationTimeoutMs: Math.min(120000, Math.max(10000, integer('DINNER_GENERATION_TIMEOUT_MS', 60000))),
  dinnerImagesEnabled: process.env.DINNER_IMAGES_ENABLED !== 'false',
  imageModel: process.env.OPENAI_IMAGE_MODEL || '',
  transcribeModel: process.env.OPENAI_TRANSCRIBE_MODEL || '',
  ytDlpPath: process.env.YTDLP_PATH || 'yt-dlp',
  aiMaxDailyRequests: integer('AI_MAX_DAILY_REQUESTS', 40),
  aiMaxTotalRequests: Math.min(80, integer('AI_MAX_TOTAL_REQUESTS', 80)),
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
}
