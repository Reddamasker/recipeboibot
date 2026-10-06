import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { archiveSourceHash, sourceHash, validateMaxEnvironment, parseDeployMaxArgs } from '../scripts/deploy-max.js';

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

test('MAX release parity uses Git archived bytes despite checkout line ending differences', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'max-archive-parity-'));
  try {
    fs.mkdirSync(path.join(root, 'src'));
    fs.mkdirSync(path.join(root, 'public'));
    fs.writeFileSync(path.join(root, 'src/app.js'), 'const value = 1;\n');
    fs.writeFileSync(path.join(root, 'public/style.css'), 'body {}\n');
    fs.writeFileSync(path.join(root, 'public/image.webp'), Buffer.from([0, 128, 255]));
    const originalHash = sourceHash(root);
    // Generated with git archive from a clean fixture repository using
    // *.js text eol=lf and *.css text eol=crlf. No Git binary is needed in Docker tests.
    const archive = new URL('./fixtures/max-source-eol.tgz', import.meta.url);
    const shippedHash = createHash('sha256').update('src/app.js\0const value = 1;\n')
      .update('public/image.webp\0').update(Buffer.from([0, 128, 255]))
      .update('public/style.css\0body {}\r\n').digest('hex');
    assert.notEqual(shippedHash, originalHash);
    assert.equal(archiveSourceHash(fileURLToPath(archive)), shippedHash);
    assert.throws(() => archiveSourceHash(path.join(root, 'missing.tgz')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('MAX payment activation requires the explicit apply flag; checks/setup cannot activate it', () => {
  for (const mode of ['--check','--apply','--setup-check','--setup']) assert.deepEqual(parseDeployMaxArgs([mode]), { mode, enablePayments: false });
  assert.deepEqual(parseDeployMaxArgs(['--apply','--enable-payments']), { mode: '--apply', enablePayments: true });
  for (const args of [[],['--check','--enable-payments'],['--setup','--enable-payments'],['--setup-check','--enable-payments'],['--apply','--enable-payments','--enable-payments'],['--apply','unexpected'],['--enable-payments','--apply']]) assert.throws(() => parseDeployMaxArgs(args), /Usage/);
});

test('invalid MAX activation arguments fail before any server command', () => {
  const result = spawnSync(process.execPath, ['scripts/deploy-max.js', '--check', '--enable-payments'], { encoding: 'utf8', env: { ...process.env, NODE_TEST_CONTEXT: '' } });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^Usage:/);
  assert.ok(!result.stderr.includes('ssh'));
});

test('MAX invoice activation rejects wrong namespaces and exhausted sequences without altering the database', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'max-invoice-deploy-check-'));
  try {
    const script = fs.readFileSync(new URL('../deploy/apply-max-release.sh', import.meta.url), 'utf8');
    const section = script.slice(script.indexOf('assert_payment_namespace() {'), script.indexOf('\nassert_endpoints() {'));
    const match = section.match(/node --input-type=module -e '([\s\S]*?)\n  ' >\/dev\/null/);
    assert.ok(match);
    const code = match[1].replace('"/app/data/recipes.sqlite"', 'process.env.MAX_FIXTURE_DATABASE');
    for (const [name, statement, expected] of [
      ['empty', '', 0],
      ['max-valid', 'INSERT INTO payment_orders(inv_id) VALUES(1000000000000)', 0],
      ['low-positive', 'INSERT INTO payment_orders(inv_id) VALUES(1)', 1],
      ['zero', 'INSERT INTO payment_orders(inv_id) VALUES(0)', 1],
      ['negative', 'INSERT INTO payment_orders(inv_id) VALUES(-1)', 1],
      ['unsafe', 'INSERT INTO payment_orders(inv_id) VALUES(9007199254740992)', 1],
      ['exhausted', "INSERT INTO sqlite_sequence(name,seq) VALUES('payment_orders',9007199254740991)", 1],
      ['negative-sequence', "INSERT INTO sqlite_sequence(name,seq) VALUES('payment_orders',-1)", 1]
    ]) {
      const filename = path.join(directory, `${name}.sqlite`);
      const db = new DatabaseSync(filename);
      db.exec('CREATE TABLE payment_orders(inv_id INTEGER PRIMARY KEY AUTOINCREMENT)');
      if (statement) db.exec(statement);
      db.close();
      const before = fs.readFileSync(filename);
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', env: { ...process.env, MAX_FIXTURE_DATABASE: filename } });
      assert.equal(result.status, expected, `${name}: ${result.stderr}`);
      assert.deepEqual(fs.readFileSync(filename), before, name);
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('MAX payment rollback restores environment and compose before restarting the previous image', (context) => {
  const candidates = process.platform === 'win32' ? ['C:/Program Files/Git/bin/bash.exe','C:/Program Files/Git/usr/bin/bash.exe'] : ['/bin/bash'];
  const bash = candidates.find((candidate) => fs.existsSync(candidate));
  if (!bash) { context.skip('Bash unavailable; server uses Bash'); return; }
  const script = fs.readFileSync(new URL('../deploy/apply-max-release.sh', import.meta.url), 'utf8');
  const start = script.indexOf('rollback() {');
  const end = script.indexOf('\ntrap rollback ERR', start);
  assert.ok(start > 0 && end > start);
  const rollback = script.slice(start,end);
  // Every external/destructive operation is a shell function mock. No server,
  // production file, credentials, Docker runtime or network can be accessed.
  const mocks = [
    'rm(){ printf "mock-rm\\n"; }',
    'tar(){ printf "restore-source\\n"; }',
    'install(){ printf "restore:%s\\n" "$3"; }',
    'docker(){ if [[ "$1" = tag ]]; then printf "restore-image\\n"; else printf "restart-container\\n"; fi; }',
    'cat(){ printf "old-revision\\n"; }',
    'root=/unused-max; existing=true; source_backup=source; previous=old-image; image=new-image; secret_file=unused;',
    'env_backup=env-backup; compose_backup=compose-backup; payment_config_changed=true;',
  ].join('\n');
  const result = spawnSync(bash, ['-c', mocks+'\n'+rollback+'\nrollback'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  const actions=result.stdout.trim().split(/\r?\n/);
  assert.ok(actions.indexOf('restore:env-backup')>=0);
  assert.ok(actions.indexOf('restore:compose-backup')>actions.indexOf('restore:env-backup'));
  assert.ok(actions.indexOf('restore-image')>actions.indexOf('restore:compose-backup'));
  assert.ok(actions.indexOf('restart-container')>actions.indexOf('restore-image'));
  const unchanged = spawnSync(bash, ['-c', mocks.replace('payment_config_changed=true','payment_config_changed=false')+'\n'+rollback+'\nrollback'], { encoding: 'utf8' });
  assert.equal(unchanged.status,1);
  assert.ok(!unchanged.stdout.includes('restore:env-backup'));
  assert.ok(!unchanged.stdout.includes('restore:compose-backup'));
});
