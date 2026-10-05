import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sourceHash, validateMaxEnvironment } from '../scripts/deploy-max.js';

test('MAX bootstrap accepts only its credentials and rejects credential leakage without echoing values', () => {
  assert.deepEqual(validateMaxEnvironment('# MAX credentials\nMAX_BOT_TOKEN=safe-test-token\n'), { MAX_BOT_TOKEN: 'safe-test-token' });
  assert.deepEqual(validateMaxEnvironment(`MAX_BOT_TOKEN=safe-test-token\nMAX_WEBHOOK_SECRET=${'a'.repeat(32)}\n`), { MAX_BOT_TOKEN: 'safe-test-token', MAX_WEBHOOK_SECRET: 'a'.repeat(32) });
  const sensitive = 'do-not-print-this-secret';
  for (const source of [
    `MAX_BOT_TOKEN=token\nTELEGRAM_BOT_TOKEN=${sensitive}`,
    `MAX_BOT_TOKEN=token\nROBOKASSA_PASSWORD1=${sensitive}`,
    `MAX_BOT_TOKEN=token\nYANDEX_DIRECT_TOKEN=${sensitive}`,
    `MAX_BOT_TOKEN=token\nOPENAI_API_KEY=${sensitive}`,
    'MAX_BOT_TOKEN=token\nMAX_BOT_TOKEN=other',
    'MAX_BOT_TOKEN=token\nMAX_WEBHOOK_SECRET=short',
    'MAX_BOT_TOKEN=$(echo secret)',
    'MAX_BOT_TOKEN="quoted-token"',
    ''
  ]) assert.throws(() => validateMaxEnvironment(source), error => !error.message.includes(sensitive));
});

test('MAX source parity covers names, binary bytes and removed files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'max-deploy-hash-'));
  try {
    fs.mkdirSync(path.join(root, 'src'));
    fs.mkdirSync(path.join(root, 'public'));
    fs.writeFileSync(path.join(root, 'src/b.js'), 'b');
    fs.writeFileSync(path.join(root, 'src/a.js'), 'a');
    fs.writeFileSync(path.join(root, 'public/image.png'), Buffer.from([0, 128, 255]));
    const expected = createHash('sha256').update('src/a.js\0a').update('src/b.js\0b').update('public/image.png\0').update(Buffer.from([0, 128, 255])).digest('hex');
    assert.equal(sourceHash(root), expected);
    fs.renameSync(path.join(root, 'src/a.js'), path.join(root, 'src/z.js'));
    assert.notEqual(sourceHash(root), expected);
    fs.renameSync(path.join(root, 'src/z.js'), path.join(root, 'src/a.js'));
    assert.equal(sourceHash(root), expected);
    fs.rmSync(path.join(root, 'src/a.js'));
    assert.notEqual(sourceHash(root), expected);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('MAX deploy is inert during Node test discovery and imports never run SSH', () => {
  const result = spawnSync(process.execPath, ['scripts/deploy-max.js'], { encoding: 'utf8', env: { ...process.env, NODE_TEST_CONTEXT: 'child-v8' } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});
