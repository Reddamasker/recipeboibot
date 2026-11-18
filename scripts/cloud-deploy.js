import { spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const hostAlias = 'recipeboibot-cloud-release';
const hostKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOohYkqEA+Zg3IMo83KbV8+DbPM/gsvTIRxFq2bcejWI';

export function deployFromCloud(contour, mode) {
  if (!['--check', '--apply', '--validate'].includes(mode)) {
    throw new Error('Cloud SSH supports checking and releasing the existing bots');
  }
  if (!['test', 'production', 'max'].includes(contour)) throw new Error('Unknown release contour');
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js 24+ required');
  const { RECIPEBOIBOT_CLOUD_DEPLOY_KEY: secret, ...environment } = process.env;
  const host = environment.RECIPEBOIBOT_CLOUD_DEPLOY_HOST;
  if (!/^[a-z0-9][a-z0-9.-]*$/i.test(host || '')) throw new Error('Missing or invalid cloud SSH hostname');
  if (!secret) throw new Error('Set RECIPEBOIBOT_CLOUD_DEPLOY_KEY in the personal vault');
  const privateKey = Buffer.from(secret.trim(), 'base64').toString();
  if (!privateKey.startsWith('-----BEGIN OPENSSH PRIVATE KEY-----\n')
    || !privateKey.trimEnd().endsWith('-----END OPENSSH PRIVATE KEY-----')) {
    throw new Error('Cloud SSH secret must contain the base64-encoded OpenSSH private key');
  }

  function run(command, args, { capture = false, input = 'ignore' } = {}) {
    const result = spawnSync(command, args, {
      cwd: root, env: environment, encoding: 'utf8',
      stdio: [input, capture ? 'pipe' : 'inherit', 'inherit'],
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.signal})`);
    return result.stdout?.trim();
  }

  const temporary = mkdtempSync(path.join(tmpdir(), 'recipebot-cloud-release-'));
  try {
    const identity = path.join(temporary, 'identity');
    const knownHosts = path.join(temporary, 'known_hosts');
    writeFileSync(identity, privateKey, { mode: 0o600, flag: 'wx' });
    writeFileSync(knownHosts, `${hostAlias} ${hostKey}\n`, { mode: 0o600, flag: 'wx' });
    const options = [
      '-F', '/dev/null', '-T', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
      '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15',
      '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4',
      '-o', `UserKnownHostsFile=${knownHosts}`, '-o', `HostKeyAlias=${hostAlias}`,
      '-o', 'HostKeyAlgorithms=ssh-ed25519',
      '-o', 'ProxyCommand=node scripts/cloud-ssh-proxy.js %h %p',
      '-i', identity, `recipe-deploy@${host}`,
    ];
    run('ssh', [...options, `check ${contour}`]);
    if (mode === '--check') return;
    if (run('git', ['status', '--porcelain'], { capture: true })) {
      throw new Error('Commit project changes before deploying. Only committed files are published.');
    }
    const revision = run('git', ['rev-parse', 'HEAD'], { capture: true });
    if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Invalid Git revision');
    if (mode === '--apply') run(process.execPath, ['--test', '--test-concurrency=1']);
    const archive = path.join(temporary, 'release.tgz');
    run('git', ['archive', '--format=tar.gz', '-o', archive, revision, 'src', 'public', 'test', 'package.json']);
    const input = openSync(archive, 'r');
    try {
      run('ssh', [...options, `${mode.slice(2)} ${contour} ${revision}`], { input });
    } finally {
      closeSync(input);
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && !process.env.NODE_TEST_CONTEXT) {
  try {
    deployFromCloud(process.argv[2], process.argv[3]);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
