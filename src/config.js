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
  openaiKey: process.env.OPENAI_API_KEY || '',
  textModel: process.env.OPENAI_TEXT_MODEL || '',
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
}
