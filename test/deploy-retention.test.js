import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (name) => fs.readFileSync(path.resolve('deploy', name), 'utf8');

test('production deploy retains bounded rollback data and removes uploaded releases', () => {
  const script = read('apply-release.sh');
  assert.match(script, /recipeboibot-docker-deploy\.lock/);
  assert.match(script, /source-before-git-\*\.tgz' 5/);
  assert.match(script, /recipes-\*\.sqlite\.enc' 30/);
  assert.match(script, /recipeboibot-recipeboibot 'before-git-' 3/);
  assert.match(script, /recipeboibot-release-\*\.tgz/);
  assert.match(script, /docker builder prune --all --force --keep-storage 1GB/);
  assert.ok(script.indexOf('cleanup_retention ||') > script.indexOf("grep -F '\"ok\":true'"));
});

test('test deploy uses the same bounded retention without touching its database volume', () => {
  const script = read('apply-test-release.sh');
  assert.match(script, /recipeboibot-docker-deploy\.lock/);
  assert.match(script, /source-before-parity-\*\.tgz' 5/);
  assert.match(script, /recipes-before-parity-\*\.sqlite\.enc' 30/);
  assert.match(script, /tests-\*\.log' 10/);
  assert.match(script, /recipeboibot-test-app 'before-parity-' 3/);
  assert.match(script, /recipeboibot-test-release-\*\.tgz/);
  assert.match(script, /docker builder prune --all --force --keep-storage 1GB/);
  assert.match(script, /\[\[ -d deploy \]\] && backup_paths\+=\(deploy\)/);
  assert.match(script, /\$PWD\/deploy:\/app\/deploy:ro/);
  assert.doesNotMatch(script, /docker volume (rm|prune)/);
  assert.ok(script.indexOf('cleanup_retention ||') > script.indexOf("grep -F '\"ok\":true'"));
});
