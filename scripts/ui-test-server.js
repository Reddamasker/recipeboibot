// Local test harness only. Never included in the production Docker image.
// Telegram identity is a test fixture; OpenAI calls are real and counted in usage.
import http from 'node:http';
import path from 'node:path';
import { buildWebDocument } from '../src/web-document.js';
process.env.DATABASE_PATH ||= './data/ui-test.sqlite';
process.env.TELEGRAM_POLLING = 'false';
const { config } = await import('../src/config.js');
const { createServer } = await import('../src/server.js');
const { makeTelegramInitData } = await import('../src/security.js');
const { upsertTelegramUser, allowUser } = await import('../src/db.js');
const user = { id: 999000001, first_name: 'Тест интерфейса' };
allowUser(upsertTelegramUser(user).id);
const handler = createServer().listeners('request')[0];
const port = Number(process.env.UI_TEST_PORT || 3090);
http.createServer((req, res) => {
  if (new URL(req.url, 'http://127.0.0.1').pathname === '/') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    const telegramSdk = `window.Telegram={WebApp:{initData:${JSON.stringify(makeTelegramInitData(user, config.telegramToken))},ready(){},expand(){},setHeaderColor(){},setBackgroundColor(){},openLink(url){window.__lastOpenLink=url}}};`;
    res.end(buildWebDocument(path.resolve('public'), { telegramSdk }).bytes);
  } else if (req.url === '/test-sdk.js') {
    res.setHeader('Content-Type', 'text/javascript'); res.setHeader('Cache-Control', 'no-store');
    res.end(`window.Telegram={WebApp:{initData:${JSON.stringify(makeTelegramInitData(user, config.telegramToken))},ready(){},expand(){},setHeaderColor(){},setBackgroundColor(){},openLink(url){window.__lastOpenLink=url}}};`);
  } else handler(req, res);
}).listen(port, '127.0.0.1', () => console.log(`LOCAL_UI_TEST=http://127.0.0.1:${port}`));
