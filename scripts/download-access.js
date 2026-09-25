// Скачать зашифрованный архив из приватного GitHub Release через настроенный Git Credential Manager.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repo = 'Reddamasker/recipeboibot';
const tag = 'workstation-access-2026-09-25';
const name = 'recipeboibot-access.zip.enc';
const expectedHash = '0a61db0223c6a0588d07e6e0b069ff70ac944003b850f7394ae492f8c40a8d3e';
const auth = spawnSync('git', ['credential', 'fill'], {
  input: `protocol=https\nhost=github.com\npath=${repo}.git\n\n`, encoding: 'utf8',
  env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
});
if (auth.status !== 0) throw new Error('Сначала клонируй приватный репозиторий и войди в GitHub через Git Credential Manager');
const credential = Object.fromEntries(auth.stdout.trim().split('\n').map((line) => {
  const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)];
}));
if (!credential.password) throw new Error('Не найден доступ к приватному GitHub');
const api = `https://api.github.com/repos/${repo}`;
const headers = { Authorization: `Bearer ${credential.password}`, 'User-Agent': 'recipeboibot-transfer', Accept: 'application/vnd.github+json' };
const releaseResponse = await fetch(`${api}/releases/tags/${tag}`, { headers });
if (!releaseResponse.ok) throw new Error(`Не удалось найти архив доступа: GitHub HTTP ${releaseResponse.status}`);
const release = await releaseResponse.json();
const asset = release.assets.find((item) => item.name === name);
if (!asset) throw new Error('В релизе нет архива доступа');
const download = await fetch(`${api}/releases/assets/${asset.id}`, { headers: { ...headers, Accept: 'application/octet-stream' } });
if (!download.ok || download.headers.get('content-type')?.includes('json')) throw new Error(`Не удалось скачать архив: GitHub HTTP ${download.status}`);
const bytes = Buffer.from(await download.arrayBuffer());
if (createHash('sha256').update(bytes).digest('hex') !== expectedHash) throw new Error('Хеш скачанного архива не совпал');
const folder = path.join(os.homedir(), 'Downloads');
fs.mkdirSync(folder, { recursive: true });
const output = path.join(folder, name);
if (fs.existsSync(output)) {
  if (createHash('sha256').update(fs.readFileSync(output)).digest('hex') !== expectedHash) throw new Error(`Другой файл уже существует: ${output}`);
} else fs.writeFileSync(output, bytes, { flag: 'wx', mode: 0o600 });
console.log(`Зашифрованный архив скачан: ${output}`);
