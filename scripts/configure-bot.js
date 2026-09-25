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
  { command: 'start', description: 'Начать или продолжить знакомство' },
  { command: 'dinner', description: 'Что приготовить сегодня?' },
  { command: 'ingredients', description: 'Рассказать, какие продукты есть дома' },
  { command: 'find', description: 'Найти рецепт: /find курица до 30 минут' },
  { command: 'usage', description: 'Расход AI-запросов и токенов' },
  { command: 'help', description: 'Как пользоваться и получить помощь' },
  { command: 'privacy', description: 'Какие данные сохраняются' },
  { command: 'terms', description: 'Условия закрытого теста' }
] });
const description = 'Что приготовить сегодня? Помогу выбрать ужин из того, что есть дома.\n\nНажмите «Начать», затем за 30–60 секунд назовите голосом продукты, на сколько человек готовите и что нельзя есть. Можно написать текстом. Я уточню список и предложу варианты.\n\nСохраняйте любимые рецепты — они помогут лучше подбирать ужин.';
for (const language_code of ['', 'ru']) await call('setMyDescription', { description, language_code });
await call('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Открыть приложение', web_app: { url: appUrl } } });
console.log(JSON.stringify({ ok: true, username: bot.username, appUrl, menuConfigured: true }));
