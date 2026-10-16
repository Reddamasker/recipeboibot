// Publish the same shared src/public tree to the separate test bot.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, copyFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2];
if (!['--check', '--apply'].includes(mode) || process.argv.length !== 3) {
  // Node's default test discovery treats deploy-test.js as a test file.
  // In that context this command-line utility must be an inert, successful file.
  if (process.env.NODE_TEST_CONTEXT) process.exit(0);
  console.error('Usage: node scripts/deploy-test.js --check | --apply'); process.exit(2);
}
const target = 'root@89.223.123.75';
const options = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes'];
const identity = process.env.DEPLOY_IDENTITY || path.join(homedir(), '.ssh', 'recipeboibot_ed25519');
if (existsSync(identity)) options.push('-i', identity);
function run(command, args, capture = false) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})`);
  return capture ? result.stdout.trim() : '';
}
try {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js 24+ required');
  run('ssh', [...options, target, 'cd /opt/recipeboibot-test && docker compose -f compose.test.yaml ps && curl -fsS http://127.0.0.1:3088/healthz']);
  if (mode === '--apply') {
    if (run('git', ['status', '--porcelain'], true)) throw new Error('Commit project changes before deploying. Only committed files are published.');
    run(process.execPath, ['--test', '--test-concurrency=1']);
    const temp = mkdtempSync(path.join(tmpdir(), 'recipeboibot-test-release-'));
    const archive = path.join(temp, 'release.tgz'), script = path.join(temp, 'apply.sh');
    run('git', ['archive', '--format=tar.gz', '-o', archive, 'HEAD',
      'src', 'public', 'Dockerfile', 'package.json', 'test', 'scripts',
      'deploy/enable-persistent-logs.py', 'deploy/apply-release.sh', 'deploy/apply-test-release.sh', 'deploy/apply-max-release.sh', 'deploy/ops-monitor.sh', 'deploy/retention.sh', 'deploy/backup.sh']);
    const hash = createHash('sha256').update(readFileSync(archive)).digest('hex');
    copyFileSync(path.join(root, 'deploy', 'apply-test-release.sh'), script);
    const remote = `/root/recipeboibot-test-release-${hash}`;
    run('scp', [...options, archive, `${target}:${remote}.tgz`]);
    run('scp', [...options, script, `${target}:${remote}.sh`]);
    run('ssh', [...options, target, `bash '${remote}.sh' '${hash}'`]);
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
