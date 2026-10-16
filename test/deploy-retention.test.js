import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const shell = process.platform === 'win32' ? path.join(process.env.ProgramFiles || 'C:/Program Files', 'Git/bin/bash.exe') : '/bin/bash';
const quote = value => `'${value.replaceAll('\\', '/').replace(/^([A-Za-z]):\//, (_, drive) => `/${drive.toLowerCase()}/`).replaceAll("'", "'\\''")}'`;
const script = path.resolve('deploy/retention.sh');
const policies = [
  ['production', 'recipeboibot-recipeboibot', 'before-git-', 'source-before-git-', 'recipes-', 'recipeboibot-release-'],
  ['test', 'recipeboibot-test-app', 'before-parity-', 'source-before-parity-', 'recipes-before-parity-', 'recipeboibot-test-release-'],
  ['max', 'recipeboibot-max-app', 'before-max-', 'source-before-max-', 'recipes-before-max-', 'recipeboibot-max-release-']
];

const mock = `
const fs=require('node:fs');
const file=process.env.RETENTION_FIXTURE_STATE;
const state=JSON.parse(fs.readFileSync(file));
const args=process.argv.slice(2);
state.calls.push(args);fs.writeFileSync(file,JSON.stringify(state));
if(args[0]==='image'&&args[1]==='ls') {
  if(state.failList)process.exit(1);
  console.log(state.images.map(i=>i.replace(':',' ')).join('\\n'));
} else if(args[0]==='image'&&args[1]==='rm') {
  if(state.failDelete)process.exit(1);
  if(args.length!==3||args[2].endsWith(':latest'))process.exit(2);
  state.images=state.images.filter(i=>i!==args[2]);fs.writeFileSync(file,JSON.stringify(state));
} else if(args[0]==='builder'&&args[1]==='prune') {
  if(state.failCache)process.exit(1);
} else process.exit(2);
`;

function fixture(policy = policies[2], overrides = {}) {
  const [scope, repository, imagePrefix, sourcePrefix, databasePrefix, uploadPrefix] = policy;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'recipe-retention-'));
  const base = path.join(directory, 'base'), backups = path.join(base, 'backups'), uploads = path.join(directory, 'uploads');
  for (const d of [backups, uploads, path.join(base, 'data')]) fs.mkdirSync(d, {recursive: true});
  const create = (folder, name, stamp = 1) => {
    const file = path.join(folder, name); fs.writeFileSync(file, `preserve bytes: ${name}`); fs.utimesSync(file, stamp, stamp);
    return file;
  };
  for (let i = 1; i <= 8; i++) create(backups, `${sourcePrefix}${String(i).padStart(4, '0')}.tgz`, i);
  for (let i = 1; i <= 33; i++) create(backups, `${databasePrefix}${String(i).padStart(4, '0')}.sqlite.enc`, i);
  for (let i = 1; i <= 13; i++) create(backups, `tests-${String(i).padStart(4, '0')}.log`, i);
  const protectedFiles = [create(base, '.env.local'), create(backups, 'backup.key'), create(backups, 'offsite-last-success'),
    create(backups, 'incident-evidence.tgz'), create(path.join(base, 'data'), 'recipes.sqlite'), create(uploads, 'another-project.tgz'),
    create(uploads, `${uploadPrefix}secret.env`)];
  create(uploads, `${uploadPrefix}old.tgz`); create(uploads, `${uploadPrefix}old.sh`);
  const helper = path.join(directory, 'docker.cjs'), stateFile = path.join(directory, 'state.json');
  fs.writeFileSync(helper, mock);
  fs.writeFileSync(stateFile, JSON.stringify({calls: [], images: [
    ...Array.from({length: 8}, (_, i) => `${repository}:${imagePrefix}${String(i + 1).padStart(4, '0')}`),
    `${repository}:latest`, `${repository}:manual-preserve`, 'other-project:before-max-0001'
  ], ...overrides}));
  return {
    base, backups, uploads, protectedFiles,
    state: () => JSON.parse(fs.readFileSync(stateFile)),
    run(mode = '--apply') {
      return spawnSync(shell, ['-c', `
        . ${quote(script)}
        docker() { ${quote(process.execPath)} ${quote(helper)} "$@"; }
        retention_config ${scope}
        retention_root=${quote(base)}
        retention_upload_directories=(${quote(uploads)})
        retention_execute ${mode}
      `], {encoding: 'utf8', env: {...process.env, RETENTION_FIXTURE_STATE: stateFile}});
    },
    cleanup: () => fs.rmSync(directory, {recursive: true, force: true})
  };
}

for (const policy of policies) test(`${policy[0]} actually bounds files/images, preserves data and is idempotent`, () => {
  const context = fixture(policy);
  try {
    const before = context.protectedFiles.map(file => fs.readFileSync(file));
    assert.notEqual(context.run('--check').status, 0, 'An overfull contour must fail the audit');
    assert.equal(context.state().calls.some(call => call[1] === 'rm'), false, 'Audit must not delete images');
    const result = context.run();
    assert.equal(result.status, 0, result.stderr);
    const files = fs.readdirSync(context.backups);
    assert.equal(files.filter(name => name.startsWith(policy[3])).length, 5);
    assert.equal(files.filter(name => name.startsWith(policy[4]) && name.endsWith('.sqlite.enc')).length, 30);
    assert.equal(files.filter(name => name.startsWith('tests-')).length, 10);
    assert.ok(files.includes(`${policy[3]}0008.tgz`), 'Newest source backup survives');
    assert.ok(!files.includes(`${policy[3]}0001.tgz`), 'Oldest source backup is removed');
    const remaining = context.state().images;
    assert.deepEqual(remaining.filter(name => name.startsWith(`${policy[1]}:${policy[2]}`)),
      [6, 7, 8].map(i => `${policy[1]}:${policy[2]}${String(i).padStart(4, '0')}`));
    assert.ok(remaining.includes(`${policy[1]}:latest`));
    assert.ok(remaining.includes('other-project:before-max-0001'));
    assert.ok(!fs.existsSync(path.join(context.uploads, `${policy[5]}old.tgz`)));
    context.protectedFiles.forEach((file, i) => assert.deepEqual(fs.readFileSync(file), before[i]));
    const deleteCount = context.state().calls.filter(call => call[1] === 'rm').length;
    assert.equal(context.run().status, 0);
    assert.equal(context.run('--check').status, 0);
    assert.equal(context.state().calls.filter(call => call[1] === 'rm').length, deleteCount);
    assert.ok(context.state().calls.every(call => !call.includes('--force') || call[0] === 'builder'));
    assert.ok(context.state().calls.every(call => !call.includes('volume') && !call.includes('system')));
  } finally {context.cleanup();}
});

for (const failure of ['failList', 'failDelete', 'failCache']) test(`retention ${failure} cannot report success and remains visible to monitoring`, () => {
  const context = fixture(policies[2], {[failure]: true});
  try {
    assert.notEqual(context.run().status, 0);
    assert.ok(fs.existsSync(path.join(context.backups, 'retention-error')));
    assert.notEqual(context.run('--check').status, 0);
  } finally {context.cleanup();}
});

test('daily database rotation preserves source archives, images and unfinished release diagnostics', () => {
  const context = fixture(policies[0]);
  try {
    fs.writeFileSync(path.join(context.backups, 'retention-error'), 'previous release failed');
    const result = context.run('--database-only');
    assert.equal(result.status, 0, result.stderr);
    const files = fs.readdirSync(context.backups);
    assert.equal(files.filter(name => name.endsWith('.sqlite.enc')).length, 30);
    assert.equal(files.filter(name => name.endsWith('.tgz')).length, 9);
    assert.equal(fs.readFileSync(path.join(context.backups, 'retention-error'), 'utf8'), 'previous release failed');
    assert.deepEqual(context.state().calls, []);
    const backup = fs.readFileSync('deploy/backup.sh', 'utf8');
    assert.match(backup, /flock -w 60 9/);
    assert.ok(backup.indexOf('production --database-only') > backup.indexOf('Encrypted backup created'));
    assert.match(fs.readFileSync('deploy/apply-release.sh', 'utf8'), /backups --during-deploy/);
  } finally {context.cleanup();}
});

test('every deployment uses the shared policy only after confirmed readiness and ships it', () => {
  const files = fs.readdirSync('deploy').filter(name => /^apply(?:-.*)?-release\.sh$/.test(name));
  assert.deepEqual(files.sort(), ['apply-max-release.sh', 'apply-release.sh', 'apply-test-release.sh']);
  for (const file of files) {
    const source = fs.readFileSync(path.join('deploy', file), 'utf8');
    const call = source.indexOf('bash deploy/retention.sh ');
    assert.ok(call > source.indexOf(file.includes('max') ? '\nassert_endpoints\n' : "grep -F '\"ok\":true'"), file);
    assert.match(source, /Runtime published, but retention failed/);
    assert.doesNotMatch(source, /cleanup_retention \|\| echo/);
    assert.match(source, /recipeboibot-docker-deploy\.lock/);
    if (!file.includes('max')) assert.ok(fs.readFileSync(file.includes('test') ? 'scripts/deploy-test.js' : 'scripts/deploy.js', 'utf8').includes("'deploy/retention.sh'"));
  }
});

test('unknown contour or operation is rejected before Docker or file deletion', () => {
  for (const args of [['other', '--apply'], ['max', '--prune-all'], []]) {
    const result = spawnSync(shell, [script, ...args], {encoding: 'utf8'});
    assert.equal(result.status, 2, result.stderr);
  }
});
