// Run the real form handler on an isolated server database and verify the text
// echoed back by Telegram. Send UTF-8 bytes directly to SSH, avoiding shell pipes.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

async function checkFeedback(expectedBot) {
  const fs = await import('node:fs');
  const { randomUUID } = await import('node:crypto');
  process.env.DATABASE_PATH = `/tmp/feedback-encoding-${randomUUID()}.sqlite`;
  process.env.TELEGRAM_POLLING = 'false';
  const { config } = await import('./src/config.js');
  const { db, upsertTelegramUser, allowUser } = await import('./src/db.js');
  const { createServer } = await import('./src/server.js');
  const { makeTelegramInitData } = await import('./src/security.js');
  const originalFetch = globalThis.fetch;
  const server = createServer();
  let returnedMessage;
  try {
    const origin = (process.env.TELEGRAM_API_ORIGIN || 'https://api.telegram.org').replace(/\/+$/, '');
    const identityResponse = await originalFetch(`${origin}/bot${config.telegramToken}/getMe`, { signal: AbortSignal.timeout(15000) });
    const identity = await identityResponse.json();
    if (!identity.ok || identity.result.username !== expectedBot) throw new Error('Unexpected bot identity');
    const sender = { id: Number(config.feedbackChatId), first_name: 'Проверка кириллицы' };
    const user = upsertTelegramUser(sender); allowUser(user.id);
    const message = 'Проверка кодировки: вопрос, предложение, жалоба. Ёжик, съешь ещё этих мягких булок — всё читается правильно. Предыдущее служебное сообщение с вопросительными знаками было повреждено при проверке через PowerShell.';
    globalThis.fetch = async (url, options) => {
      const response = await originalFetch(url, options);
      if (String(url) === `${origin}/bot${config.telegramToken}/sendMessage`) returnedMessage = (await response.clone().json()).result;
      return response;
    };
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/feedback`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `tma ${makeTelegramInitData(sender, config.telegramToken)}` },
      body: JSON.stringify({ message, requestKey: randomUUID() }), signal: AbortSignal.timeout(20000)
    });
    const result = await response.json();
    if (response.status !== 201 || !result.delivered) throw new Error('Form delivery failed');
    const stored = db.prepare('SELECT message,display_name FROM feedback_messages WHERE id=?').get(result.id);
    if (stored.message !== message || stored.display_name !== sender.first_name) throw new Error('Stored text was corrupted');
    if (!returnedMessage?.text?.includes(message) || !returnedMessage.text.includes(sender.first_name)) throw new Error('Telegram returned corrupted text');
    if (db.prepare('SELECT COUNT(*) AS count FROM provider_requests').get().count !== 0) throw new Error('Unexpected provider request');
    console.log(JSON.stringify({ bot: expectedBot, httpFormVerified: true, storedCyrillicExact: true, telegramCyrillicExact: true, messageId: returnedMessage.message_id, temporaryDatabase: true }));
  } finally {
    globalThis.fetch = originalFetch;
    if (server.listening) await new Promise(resolve => server.close(resolve));
    db.close();
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(config.databasePath + suffix, { force: true });
  }
}

const mode = process.argv[2];
if (!['--test', '--main', '--both'].includes(mode) || process.argv.length !== 3) {
  console.error('Usage: node scripts/check-feedback.js --test | --main | --both'); process.exit(2);
}
const options = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes'];
const identity = process.env.DEPLOY_IDENTITY || path.join(homedir(), '.ssh', 'recipeboibot_ed25519');
if (existsSync(identity)) options.push('-i', identity);
const contours = [['recipeboibot-test', 'recipeboi_test_bot'], ['recipeboibot', 'Recipeboibot']];
try {
  for (const [container, bot] of mode === '--both' ? contours : [contours[mode === '--test' ? 0 : 1]]) {
    const source = `const checkFeedback = ${checkFeedback.toString()}; await checkFeedback(${JSON.stringify(bot)});`;
    const result = spawnSync('ssh', [...options, 'root@89.223.123.75', `docker exec -i -w /app ${container} node --input-type=module`], {
      input: Buffer.from(source, 'utf8'), encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Feedback check failed (${result.status}): ${result.stderr.trim()}`);
    process.stdout.write(result.stdout);
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
