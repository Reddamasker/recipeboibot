import { assertConfig, config } from '../src/config.js';

assertConfig();
if (!config.testContour || !config.appUrl.startsWith('https://')) throw new Error('Expected an HTTPS test contour');

async function call(method, body = {}) {
  const response = await fetch(`https://api.telegram.org/bot${config.telegramToken}/${method}`, {
    method: 'POST', signal: AbortSignal.timeout(15000),
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  const value = await response.json();
  if (!value.ok) throw new Error(`${method} failed (${response.status})`);
  return value.result;
}

const bot = await call('getMe');
if (bot.username?.toLowerCase() !== config.testBotUsername.toLowerCase()) throw new Error('Unexpected bot; refusing to change settings');
const webhook = await call('getWebhookInfo');
if (webhook.url) throw new Error('An existing webhook is configured; review it before polling');
await call('setMyCommands', { commands: [
  { command: 'start', description: 'Начать тестовый сценарий' },
  { command: 'dinner', description: 'Выбрать ужин' },
  { command: 'ingredients', description: 'Рассказать о продуктах' },
  { command: 'offer', description: 'Предложение и тестовая оплата' },
  { command: 'test_reset', description: 'Сбросить мой тестовый профиль' },
  { command: 'help', description: 'Как пользоваться ботом' }
] });
const description = 'Тестовый бот «Рецепты». Здесь можно пройти путь нового пользователя и проверить изменения. Начните с кнопки «Начать». Данные отделены от рабочего бота, оплата только имитируется.';
for (const language_code of ['', 'ru']) await call('setMyDescription', { description, language_code });
await call('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Тестовое приложение', web_app: { url: new URL('/', config.appUrl).href } } });
console.log(JSON.stringify({ ok: true, username: bot.username, appUrl: config.appUrl }));
