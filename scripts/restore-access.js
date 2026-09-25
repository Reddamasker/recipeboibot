// Расшифровать архив доступа, скачанный из приватного GitHub Release.
import { createDecipheriv } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const [input, encodedKey] = process.argv.slice(2);
if (!input || !encodedKey) {
  console.error('Usage: node scripts/restore-access.js <recipeboibot-access.zip.enc> <transfer-key>');
  process.exit(2);
}
try {
  const key = Buffer.from(encodedKey, 'base64url');
  if (key.length !== 32) throw new Error('Неверный ключ переноса');
  const payload = fs.readFileSync(input);
  if (payload.length < 36 || payload.subarray(0, 4).toString('ascii') !== 'RBA1') throw new Error('Неверный формат архива');
  const decipher = createDecipheriv('aes-256-gcm', key, payload.subarray(4, 16));
  decipher.setAuthTag(payload.subarray(16, 32));
  const zip = Buffer.concat([decipher.update(payload.subarray(32)), decipher.final()]);
  if (zip.subarray(0, 4).toString('hex') !== '504b0304') throw new Error('Неверный ZIP');
  const output = path.join(path.dirname(path.resolve(input)), 'recipeboibot-access.zip');
  fs.writeFileSync(output, zip, { flag: 'wx', mode: 0o600 });
  console.log(`Архив готов: ${output}`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
