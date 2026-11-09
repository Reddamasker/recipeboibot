// Publish an isolated, versioned static review. Never recreate a container.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOST = 'root@89.223.123.75';
const ORIGIN = 'https://recipeboibot-test.89-223-123-75.sslip.io';
const TYPES = new Set(['.html', '.css', '.js', '.json', '.txt', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.avif', '.gif', '.woff', '.woff2', '.ttf', '.otf']);
export const REVIEW_LIMIT = 64 * 1024 * 1024;
const digest = data => createHash('sha256').update(data).digest('hex');

export function parseReviewArgs(args) {
  const [mode, flag, value, ...extra] = args;
  if (!['--check', '--apply'].includes(mode) || extra.length || (flag !== undefined && (flag !== '--slug' || !value))) throw new Error('Usage: node scripts/deploy-test-review.js --check | --apply [--slug recime-YYYYMMDD[-suffix]]');
  const slug = value || 'recime-20261109';
  if (!/^recime-\d{8}(?:-[a-z0-9]{1,24})?$/.test(slug)) throw new Error('Invalid review slug');
  return { mode, slug };
}

export function reviewUrl(slug) {
  parseReviewArgs(['--check', '--slug', slug]);
  return `${ORIGIN}/review/${slug}/index.html?view=collection`;
}

export function createReviewManifest(directory, slug, revision = null) {
  const base = path.resolve(directory);
  parseReviewArgs(['--check', '--slug', slug]);
  if (!fs.existsSync(base) || fs.lstatSync(base).isSymbolicLink() || !fs.statSync(base).isDirectory()) throw new Error('Review directory must be a real directory');
  if (fs.realpathSync(base) !== base) throw new Error('Review path cannot traverse a symlink');
  const files = [];
  let total = 0;
  function visit(relative = '') {
    for (const entry of fs.readdirSync(path.join(base, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entry.name)) throw new Error('Review paths must use safe, non-hidden ASCII names');
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error('Review symlinks are forbidden');
      if (entry.isDirectory()) { visit(name); continue; }
      if (!entry.isFile() || !TYPES.has(path.extname(name).toLowerCase())) throw new Error('Unsupported review file');
      const bytes = fs.readFileSync(path.join(base, name));
      total += bytes.length;
      if (total > REVIEW_LIMIT || files.length >= 512) throw new Error('Review bundle exceeds its size or file limit');
      files.push({ path: name, bytes: bytes.length, sha256: digest(bytes) });
    }
  }
  visit();
  if (!files.some(file => file.path === 'index.html')) throw new Error('Review index.html is required');
  files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  return { schema: 1, slug, url: reviewUrl(slug), revision, totalBytes: total, files };
}

export function stageReview(directory, manifest, destination) {
  // Re-read and compare before packaging: changing files cannot silently enter a release.
  const current = createReviewManifest(directory, manifest.slug, manifest.revision);
  if (JSON.stringify(current) !== JSON.stringify(manifest)) throw new Error('Review changed during release preparation');
  fs.mkdirSync(path.join(destination, 'files'), { recursive: true });
  fs.writeFileSync(path.join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  for (const file of manifest.files) {
    const bytes = fs.readFileSync(path.join(directory, file.path));
    if (bytes.length !== file.bytes || digest(bytes) !== file.sha256) throw new Error('Review changed during packaging');
    const target = path.join(destination, 'files', file.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
  }
}

function run(command, args, { capture = false, input } = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...(input !== undefined ? { input } : {}), stdio: capture || input !== undefined ? 'pipe' : 'inherit' });
  if (result.error || result.status !== 0) {
    // Remote errors are already sanitized. Never print transport arguments or environment.
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    throw new Error(`${command} failed (${result.status ?? 'unavailable'})`);
  }
  return result.stdout?.trim() || '';
}

async function main() {
  const { mode, slug } = parseReviewArgs(process.argv.slice(2));
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js 24+ required');
  const directory = path.join(root, 'public', 'review', slug);
  const revision = run('git', ['rev-parse', 'HEAD'], { capture: true });
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Invalid Git revision');
  const manifest = createReviewManifest(directory, slug, revision);
  // Required existing read-only preflight; --apply of that script is never used.
  run(process.execPath, [path.join(root, 'scripts/deploy-test.js'), '--check']);
  const options = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes'];
  const identity = process.env.DEPLOY_IDENTITY || path.join(homedir(), '.ssh', 'recipeboibot_ed25519');
  if (fs.existsSync(identity)) options.push('-i', identity);
  const script = fs.readFileSync(path.join(root, 'deploy/apply-test-review.sh'), 'utf8').replace(/\r\n?/g, '\n');
  const local = fs.mkdtempSync(path.join(tmpdir(), 'recipeboibot-test-review-'));
  let archiveHash = '-';
  if (mode === '--apply') {
    run(process.execPath, ['--test', '--test-concurrency=1']);
    const stage = path.join(local, 'stage');
    stageReview(directory, manifest, stage);
    const archive = path.join(local, 'review.tgz');
    // Only explicitly enumerated manifest files, never a recursive repository archive.
    run('tar', ['-czf', archive, '-C', stage, 'manifest.json', ...manifest.files.map(file => `files/${file.path}`)]);
    archiveHash = digest(fs.readFileSync(archive));
    run('scp', [...options, archive, `${HOST}:/root/recipeboibot-test-review-${archiveHash}.tgz`]);
  }
  const output = run('ssh', [...options, HOST, `bash -s -- ${mode} ${slug} ${archiveHash}`], { input: script });
  const report = JSON.parse(output);
  report.localManifest = manifest;
  report.applyScriptSha256 = digest(script);
  const reportFile = path.join(local, 'report.json');
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ ok: report.ok, mode, url: manifest.url, reportFile, remoteReport: report.reportPath || null, rollbackMenuCommand: report.rollbackMenuCommand || null, rootEntryUnchanged: true }, null, 2));
}

const direct = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (direct && !process.env.NODE_TEST_CONTEXT) main().catch(error => { console.error(error.message); process.exitCode = 1; });
