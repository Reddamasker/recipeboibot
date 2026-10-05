// Update only the pre-Start Telegram description; never starts polling.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const description = 'Идеальный рецепт за 15 секунд\n\nПривет! Я твой личный ассистент по управлению рецептами. Помню твои предпочтения, сохранённые рецепты и ограничения.\n\nНажми «Старт», и мы подберём тебе рецепт за 15 секунд.';

async function update(expectedBot, description, apply) {
  const { config } = await import('./src/config.js');
  const { writeFileSync } = await import('node:fs');
  const origin = (process.env.TELEGRAM_API_ORIGIN || 'https://api.telegram.org').replace(/\/+$/, '');
  async function call(method, body = {}) {
    const response = await fetch(`${origin}/bot${config.telegramToken}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15000)
    });
    const result = await response.json();
    if (!result.ok) throw new Error(`${method} failed (${response.status})`);
    return result.result;
  }
  const bot = await call('getMe');
  if (bot.username !== expectedBot) throw new Error('Unexpected bot identity');
  const previous = [];
  for (const language_code of ['', 'ru']) {
    previous.push({ language_code, ...(await call('getMyDescription', { language_code })) });
  }
  if (apply) {
    const backup = `/app/data/bot-description-before-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    writeFileSync(backup, JSON.stringify({ bot: expectedBot, previous }, null, 2), { mode: 0o600 });
    for (const language_code of ['', 'ru']) {
      await call('setMyDescription', { language_code, description });
      const actual = await call('getMyDescription', { language_code });
      if (actual.description !== description) throw new Error('Description verification failed');
    }
    console.log(JSON.stringify({ bot: expectedBot, verified: true, backup, description }));
  } else console.log(JSON.stringify({ bot: expectedBot, ready: true, previous, description }));
}

const mode = process.argv[2], contour = process.argv[3];
if (!['--check', '--apply'].includes(mode) || !['--test', '--main'].includes(contour) || process.argv.length !== 4) {
  console.error('Usage: node scripts/update-bot-description.js --check|--apply --test|--main');
  process.exitCode = 2;
} else {
  const options = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes'];
  const identity = process.env.DEPLOY_IDENTITY || path.join(homedir(), '.ssh', 'recipeboibot_ed25519');
  if (existsSync(identity)) options.push('-i', identity);
  const [container, bot] = contour === '--test' ? ['recipeboibot-test', 'recipeboi_test_bot'] : ['recipeboibot', 'Recipeboibot'];
  const source = `const update = ${update.toString()}; await update(${JSON.stringify(bot)}, ${JSON.stringify(description)}, ${mode === '--apply'});`;
  const result = spawnSync('ssh', [...options, 'root@89.223.123.75', `docker exec -i -w /app ${container} node --input-type=module`], {
    input: Buffer.from(source, 'utf8'), encoding: 'utf8', timeout: 90000, maxBuffer: 1024 * 1024
  });
  if (result.error || result.status !== 0) {
    console.error(result.error?.message || result.stderr.trim()); process.exitCode = 1;
  } else process.stdout.write(result.stdout);
}
