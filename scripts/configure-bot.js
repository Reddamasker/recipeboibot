import { config } from '../src/config.js';
if (!config.appUrl) throw new Error('APP_URL is required');
const appUrl = new URL('/', config.appUrl).href;
const apiOrigin = (process.env.TELEGRAM_API_ORIGIN || 'https://api.telegram.org').replace(/\/+$/, '');
async function call(method, body = {}) {
  const r = await fetch(`${apiOrigin}/bot${config.telegramToken}/${method}`, { method: 'POST', signal: AbortSignal.timeout(15000), headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const value = await r.json(); if (!value.ok) throw new Error(`${method} failed (${r.status})`); return value.result;
}
const bot = await call('getMe');
if (bot.username?.toLowerCase() !== 'recipeboibot') throw new Error('Unexpected bot; refusing to change settings');
const webhook = await call('getWebhookInfo');
if (webhook.url) throw new Error('An existing webhook is configured; review it before polling');
await call('setMyCommands', { commands: [
  { command: 'start', description: 'Выбрать ужин' },
  { command: 'dinner', description: 'Что приготовить сегодня?' },
  { command: 'ingredients', description: 'Рассказать, какие продукты есть дома' },
  { command: 'find', description: 'Найти рецепт: /find курица до 30 минут' },
  { command: 'usage', description: 'Расход AI-запросов и токенов' },
  { command: 'help', description: 'Как пользоваться и получить помощь' },
  { command: 'feedback', description: 'Обратная связь: вопрос, предложение или жалоба' },
  { command: 'privacy', description: 'Какие данные сохраняются' },
  { command: 'terms', description: 'Условия закрытого теста' }
] });
// Bot descriptions are managed by the owner in BotFather.
// Configuring menus and commands must not overwrite manual text or create locale overrides.
await call('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Открыть приложение', web_app: { url: appUrl } } });
console.log(JSON.stringify({ ok: true, username: bot.username, appUrl, menuConfigured: true }));
