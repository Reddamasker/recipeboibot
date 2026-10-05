// MAX has a separate container, environment and database; release sources are shared.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MAX_HOST = 'recipeboibot-max.89-223-123-75.sslip.io';
export const LOCAL_ENV_KEYS = Object.freeze(['MAX_BOT_TOKEN', 'MAX_WEBHOOK_SECRET']);

export function validateMaxEnvironment(source) {
  const result = {};
  for (const line of source.split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (!match || !LOCAL_ENV_KEYS.includes(match[1])) throw new Error('MAX local environment contains an unsupported setting');
    if (Object.hasOwn(result, match[1])) throw new Error('Duplicate MAX local environment setting');
    const value = match[2];
    if (!/^[A-Za-z0-9._:-]+$/.test(value)) throw new Error('MAX local environment values must be unquoted plain tokens');
    result[match[1]] = value;
  }
  if (!result.MAX_BOT_TOKEN) throw new Error('MAX_BOT_TOKEN is required in .env.max.local');
  if (result.MAX_WEBHOOK_SECRET && !/^[A-Za-z0-9_-]{32,256}$/.test(result.MAX_WEBHOOK_SECRET)) throw new Error('MAX_WEBHOOK_SECRET must contain 32–256 safe characters');
  return result;
}

export function sourceHash(directory = root) {
  const hash = createHash('sha256');
  function visit(relative) {
    for (const entry of readdirSync(path.join(directory, relative), { withFileTypes: true }).sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)))) {
      const name = `${relative}/${entry.name}`;
      if (entry.isDirectory()) visit(name);
      else if (entry.isFile()) hash.update(name).update('\0').update(readFileSync(path.join(directory, name)));
      else throw new Error('Release sources must not contain symlinks');
    }
  }
  visit('src'); visit('public');
  return hash.digest('hex');
}

function main() {
  const mode = process.argv[2];
  if (!['--check', '--apply', '--setup-check', '--setup'].includes(mode) || process.argv.length !== 3) throw new Error('Usage: node scripts/deploy-max.js --setup-check | --setup | --check | --apply');
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js 24+ required');
  const target = 'root@89.223.123.75';
  const options = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes'];
  const identity = process.env.DEPLOY_IDENTITY || path.join(homedir(), '.ssh', 'recipeboibot_ed25519');
  if (existsSync(identity)) options.push('-i', identity);
  function run(command, args, { capture = false, input } = {}) {
    const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', input, stdio: input ? ['pipe', 'inherit', 'inherit'] : capture ? 'pipe' : 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${command} failed (${result.status})`);
    return capture ? result.stdout.trim() : '';
  }
  const script = readFileSync(path.join(root, 'deploy/apply-max-release.sh'));
  const checkMode = mode.startsWith('--setup') ? '--setup-check' : '--check';
  if (checkMode === '--setup-check') validateMaxEnvironment(readFileSync(path.join(root, '.env.max.local'), 'utf8'));
  run('ssh', [...options, target, `bash -s -- ${checkMode}`], { input: script });
  if (mode.endsWith('check')) return;
  if (run('git', ['status', '--porcelain'], { capture: true })) throw new Error('Commit project changes before deploying. Only committed files are published.');
  const revision = run('git', ['rev-parse', 'HEAD'], { capture: true });
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Invalid Git revision');
  run(process.execPath, ['--test', '--test-concurrency=1']);
  const temporary = mkdtempSync(path.join(tmpdir(), 'recipeboibot-max-release-'));
  try {
    const archive = path.join(temporary, 'release.tgz');
    run('git', ['archive', '--format=tar.gz', '-o', archive, revision, 'src', 'public', 'Dockerfile', 'package.json', 'test', 'scripts', 'deploy']);
    const checksum = createHash('sha256').update(readFileSync(archive)).digest('hex');
    const remote = `/root/recipeboibot-max-release-${checksum}`;
    run('scp', [...options, archive, `${target}:${remote}.tgz`]);
    run('scp', [...options, path.join(root, 'deploy/apply-max-release.sh'), `${target}:${remote}.sh`]);
    if (mode === '--setup') {
      // The secret file travels through SSH/SCP, never argv or terminal output.
      run('ssh', [...options, target, `umask 077; cat > '${remote}.env'`], { input: readFileSync(path.join(root, '.env.max.local')) });
    }
    run('ssh', [...options, target, `bash '${remote}.sh' '${mode}' '${revision}' '${checksum}' '${sourceHash()}'`]);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && !process.env.NODE_TEST_CONTEXT) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
