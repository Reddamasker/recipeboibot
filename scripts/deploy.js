// Публикация коммита на существующий сервер. Секреты остаются на сервере.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = 'nikita@72.56.97.79';
const mode = process.argv[2];
if (!['--check', '--apply'].includes(mode) || process.argv.length !== 3) {
  console.error('Usage: node scripts/deploy.js --check | --apply'); process.exit(2);
}
function run(command, args, capture = false) {
  const r = spawnSync(command, args, { cwd: root, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${command} failed (${r.status})${capture ? ': ' + r.stderr.trim() : ''}`);
  return capture ? r.stdout.trim() : '';
}
const sshOptions = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes'];
try {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js 24+ required');
  const revision = run('git', ['rev-parse', 'HEAD'], true);
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Invalid Git revision');
  run('ssh', [...sshOptions, target, 'cd /opt/recipeboibot && test -f .env.local && sudo -n docker compose ps && curl -fsS http://127.0.0.1:3087/healthz']);
  if (mode === '--check') { console.log(`\nSSH and server ready. Local revision: ${revision}`); process.exit(0); }
  if (run('git', ['status', '--porcelain'], true)) throw new Error('Commit project changes before deploying. Only committed files are published.');
  run(process.execPath, ['--test', '--test-concurrency=1']);
  const temp = mkdtempSync(path.join(tmpdir(), 'recipeboibot-release-'));
  const archive = path.join(temp, 'release.tgz'), script = path.join(temp, 'apply.sh');
  const remoteBase = `/home/nikita/recipeboibot-release-${revision}`;
  run('git', ['archive', '--format=tar.gz', '-o', archive, revision, 'src', 'public', 'Dockerfile', 'package.json']);
  copyFileSync(path.join(root, 'deploy', 'apply-release.sh'), script);
  run('scp', [...sshOptions, archive, `${target}:${remoteBase}.tgz`]);
  run('scp', [...sshOptions, script, `${target}:${remoteBase}.sh`]);
  run('ssh', [...sshOptions, target, `sh '${remoteBase}.sh' '${revision}'`]);
  console.log(`Release artifacts: ${temp}`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
