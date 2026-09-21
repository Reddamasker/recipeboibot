import { config } from '../src/config.js';
const appUrl = config.appUrl || 'https://recipes.spas-sky.ru';
async function call(method, body = {}) {
  const r = await fetch(`https://api.telegram.org/bot${config.telegramToken}/${method}`, { method: 'POST', signal: AbortSignal.timeout(15000), headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const value = await r.json(); if (!value.ok) throw new Error(`${method} failed (${r.status})`); return value.result;
}
const bot = await call('getMe');
if (bot.username?.toLowerCase() !== 'recipeboibot') throw new Error('Unexpected bot; refusing to change settings');
const webhook = await call('getWebhookInfo');
if (webhook.url) throw new Error('An existing webhook is configured; review it before polling');
await call('setMyCommands', { commands: [
  { command: 'start', description: 'Открыть библиотеку рецептов' },
  { command: 'find', description: 'Найти рецепт: /find курица до 30 минут' },
  { command: 'usage', description: 'Расход AI-запросов и токенов' },
  { command: 'help', description: 'Как пользоваться и получить помощь' },
  { command: 'privacy', description: 'Какие данные сохраняются' },
  { command: 'terms', description: 'Условия закрытого теста' }
] });
await call('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Открыть приложение', web_app: { url: appUrl } } });
console.log(JSON.stringify({ ok: true, username: bot.username, appUrl, menuConfigured: true }));
