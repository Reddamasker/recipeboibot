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
  if(args.includes('dangling=true')) {
    const project=args.find(a=>a.startsWith('label=')).split('=').at(-1);
    console.log((state.dangling||[]).filter(i=>i.project===project).map(i=>i.id).join('\\n'));
  } else console.log(state.images.map(i=>i.replace(':',' ')).join('\\n'));
} else if(args[0]==='image'&&args[1]==='inspect') {
  if(args.includes('{{.Id}}')) {
    const tag=args.at(-1), n=tag.match(/(\\d+)$/)?.[1];
    console.log(state.imageIds?.[tag]||('sha256:'+n.padStart(64,'0')));process.exit(0);
  }
  if(state.failInspect)process.exit(1);
  const i=state.dangling.find(i=>i.id===args.at(-1));
  if(!i)process.exit(1);
  console.log([i.tags||0,i.digests||0,i.project].join(' '));
} else if(args[0]==='ps') {
  if(state.failContainers)process.exit(1);
  const i=state.dangling.find(i=>args.includes('ancestor='+i.id));
  if(i?.container)console.log(i.container);
} else if(args[0]==='image'&&args[1]==='rm') {
  if(state.failDelete)process.exit(1);
  if(args.length!==3||args[2].endsWith(':latest'))process.exit(2);
  state.images=state.images.filter(i=>i!==args[2]);fs.writeFileSync(file,JSON.stringify(state));
  state.dangling=(state.dangling||[]).filter(i=>i.id!==args[2]);fs.writeFileSync(file,JSON.stringify(state));
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
  ], dangling: [], ...overrides}));
  return {
    base, backups, uploads, protectedFiles, stateFile,
    state: () => JSON.parse(fs.readFileSync(stateFile)),
    run(mode = '--apply') {
      return spawnSync(shell, ['-c', `
        . ${quote(script)}
        docker() { ${quote(process.execPath)} ${quote(helper)} "$@"; }
        retention_config ${scope}
        retention_root=${quote(base)}
        retention_upload_directories=(${quote(uploads)})
        # Real encrypted database behavior is exercised in storage_test.py.
        retention_database() { printf '%s\n' "$1" >> ${quote(path.join(directory,'database-calls'))}; }
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
    assert.equal(files.filter(name => name.startsWith(policy[4]) && name.endsWith('.sqlite.enc')).length, 33);
    assert.match(fs.readFileSync(path.join(context.base,'../database-calls'),'utf8'), /--apply[\s\S]*--check/);
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

test('repeated failed releases cannot crowd older distinct rollback images out with duplicate tags', () => {
  const context=fixture(policies[2],{imageIds:{
    'recipeboibot-max-app:before-max-0008':`sha256:${'a'.repeat(64)}`,
    'recipeboibot-max-app:before-max-0007':`sha256:${'a'.repeat(64)}`,
    'recipeboibot-max-app:before-max-0006':`sha256:${'a'.repeat(64)}`
  }});
  try {
    assert.equal(context.run().status,0);
    assert.deepEqual(context.state().images.filter(n=>n.startsWith('recipeboibot-max-app:before-max-')),
      [4,5,8].map(n=>`recipeboibot-max-app:before-max-${String(n).padStart(4,'0')}`));
    assert.equal(context.run('--check').status,0);
  } finally {context.cleanup();}
});

test('daily database rotation preserves source archives, images and unfinished release diagnostics', () => {
  const context = fixture(policies[0]);
  try {
    fs.writeFileSync(path.join(context.backups, 'retention-error'), 'previous release failed');
    const result = context.run('--database-only');
    assert.equal(result.status, 0, result.stderr);
    const files = fs.readdirSync(context.backups);
    assert.equal(files.filter(name => name.endsWith('.sqlite.enc')).length, 33);
    assert.equal(files.filter(name => name.endsWith('.tgz')).length, 9);
    assert.equal(fs.readFileSync(path.join(context.backups, 'retention-error'), 'utf8'), 'previous release failed');
    assert.deepEqual(context.state().calls, []);
    const backup = fs.readFileSync('deploy/backup.sh', 'utf8');
    assert.match(backup, /flock -w 60 9/);
    assert.ok(backup.indexOf('"$scope" --database-only') > backup.indexOf('storage.py create'));
    assert.match(fs.readFileSync('deploy/apply-release.sh', 'utf8'), /backups --during-deploy/);
  } finally {context.cleanup();}
});

test('every deployment uses the shared policy only after confirmed readiness and ships it', () => {
  const files = fs.readdirSync('deploy').filter(name => /^apply(?:-.*)?-release\.sh$/.test(name));
  assert.deepEqual(files.sort(), ['apply-max-release.sh', 'apply-release.sh', 'apply-test-release.sh']);
  for (const file of files) {
    const source = fs.readFileSync(path.join('deploy', file), 'utf8');
    const call = source.lastIndexOf('bash deploy/retention.sh ');
    assert.ok(call > source.indexOf(file.includes('max') ? '\nassert_endpoints\n' : "grep -F '\"ok\":true'"), file);
    assert.match(source, /Runtime published, but retention failed/);
    assert.doesNotMatch(source, /cleanup_retention \|\| echo/);
    assert.match(source, /recipeboibot-docker-deploy\.lock/);
    if (!file.includes('max')) {
      const wrapper = fs.readFileSync(file.includes('test') ? 'scripts/deploy-test.js' : 'scripts/deploy.js', 'utf8');
      for (const dependency of ['deploy/retention.sh', 'deploy/backup.sh']) assert.ok(wrapper.includes(`'${dependency}'`), `${file} must ship ${dependency}`);
    }
  }
});

test('untagged owned images are audited and removed, preserving tagged, pinned, used and foreign images', () => {
  const id = n => `sha256:${String(n).padStart(64, '0')}`;
  const context = fixture(policies[2], {dangling: [
    {id:id(1), project:'recipeboibot-max'},
    {id:id(2), project:'recipeboibot-max', container:'stopped-container'},
    {id:id(3), project:'recipeboibot-max', tags:1},
    {id:id(4), project:'recipeboibot-max', digests:1},
    {id:id(5), project:'unrelated-project'}
  ]});
  try {
    // Remove only the ordinary excess files/tags first, leaving the image audit reachable.
    assert.equal(context.run().status, 0);
    assert.deepEqual(context.state().dangling.map(i=>i.id), [2,3,4,5].map(id));
    assert.equal(context.run('--check').status, 0);
    assert.equal(context.state().calls.filter(c=>c[0]==='image'&&c[1]==='rm'&&c[2]===id(1)).length, 1);
    assert.equal(context.run().status, 0);
    const state=context.state(); state.dangling.push({id:id(6),project:'recipeboibot-max'});
    fs.writeFileSync(context.stateFile,JSON.stringify(state));
    const result=context.run('--check');
    assert.notEqual(result.status,0);
    assert.match(result.stderr,/Unused untagged project image remains/);
    assert.ok(context.state().dangling.some(i=>i.id===id(6)), 'Read-only audit does not delete');
  } finally {context.cleanup();}
});

for (const failure of ['failInspect', 'failContainers']) test(`dangling image ${failure} fails closed and leaves retry marker`, () => {
  const context=fixture(policies[2], {[failure]:true,dangling:[{id:`sha256:${'a'.repeat(64)}`,project:'recipeboibot-max'}]});
  try {
    assert.notEqual(context.run().status,0);
    assert.ok(fs.existsSync(path.join(context.backups,'retention-error')));
    assert.equal(context.state().dangling.length,1);
  } finally {context.cleanup();}
});

test('hourly cleanup protects recent uploads before they acquire the deployment lock', () => {
  const context=fixture();
  try {
    const pending=path.join(context.uploads,'recipeboibot-max-release-pending.tgz');
    fs.writeFileSync(pending,'pending release');
    assert.equal(context.run().status,0);
    assert.equal(fs.readFileSync(pending,'utf8'),'pending release');
    assert.equal(context.run('--check').status,0);
    fs.utimesSync(pending,1,1);
    assert.equal(context.run().status,0);
    assert.equal(fs.existsSync(pending),false);
  } finally {context.cleanup();}
});

test('upload audit allows the next hourly cleanup but still detects missed maintenance', () => {
  const context=fixture();
  try {
    assert.equal(context.run().status,0);
    const pending=path.join(context.uploads,'recipeboibot-max-release-completed.tgz');
    fs.writeFileSync(pending,'completed upload');
    const age=minutes=>{const time=Date.now()/1000-minutes*60;fs.utimesSync(pending,time,time);};
    age(70);
    assert.equal(context.run('--check').status,0,'Eligible uploads may await the hourly cleanup');
    assert.equal(context.run().status,0);
    assert.equal(fs.existsSync(pending),false,'Cleanup still removes uploads older than 60 minutes');
    fs.writeFileSync(pending,'missed cleanup');age(140);
    assert.notEqual(context.run('--check').status,0,'Missing the entire cleanup window remains an incident');
    assert.equal(fs.existsSync(pending),true,'Audit never deletes files');
  } finally {context.cleanup();}
});

test('retention is scheduled independently from successful releases with the shared lock', () => {
  const service=fs.readFileSync('deploy/recipeboibot-retention.service','utf8');
  const timer=fs.readFileSync('deploy/recipeboibot-retention.timer','utf8');
  assert.match(service,/flock -n -E 0 \/tmp\/recipeboibot-docker-deploy.lock .*retention.sh --apply-all/);
  assert.match(timer,/OnCalendar=hourly/);
  assert.match(timer,/Persistent=true/);
  assert.match(fs.readFileSync('deploy/enable-monitor.sh','utf8'),/enable --now recipeboibot-retention.timer/);
  for(const file of ['scripts/deploy.js','scripts/deploy-test.js']) {
    const source=fs.readFileSync(file,'utf8');
    for(const suffix of ['service','timer']) assert.ok(source.includes(`'deploy/recipeboibot-retention.${suffix}'`));
  }
});

for (const [file, contour] of [['apply-release.sh','production'], ['apply-test-release.sh','test'], ['apply-max-release.sh','max']]) {
  for (const health of ['healthy','starting']) test(`${contour} real rollback function bounds artifacts only after healthy restoration and still reports failure (${health})`, () => {
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),'recipe-rollback-'));
    try {
      fs.mkdirSync(path.join(directory,'deploy'));
      fs.writeFileSync(path.join(directory,'DEPLOYED_REVISION'),'old-revision');
      fs.writeFileSync(path.join(directory,'deploy/retention.sh'), '#!/bin/bash\nprintf "cleanup:%s\\n" "$*" >> "$ROLLBACK_EVENTS"\nexit 1\n');
      const events=path.join(directory,'events');
      const source=fs.readFileSync(path.join('deploy',file),'utf8');
      const start=source.indexOf('rollback() {');
      const rollback=source.slice(start,source.indexOf('\n}',start)+2);
      const result=spawnSync(shell,['-c',`
        set -eu
        cd ${quote(directory)}
        export ROLLBACK_EVENTS=${quote(events)}
        record() { printf '%s\\n' "$*" >> "$ROLLBACK_EVENTS"; }
        sudo() { shift; "$@"; }
        tar() { record restore; }
        rm() { record remove-source; }
        replace_source_directories() { record replace-source; }
        docker() {
          if [ "$1" = inspect ]; then record health; printf '%s\\n' '${health}';
          elif [ "$1" = compose ]; then record restore-runtime;
          else record docker-tag; fi
        }
        backup=backup.tgz source_backup=backup.tgz previous=previous-image
        existing=true payment_config_changed=false container=fixture image=fixture secret_file=fixture root=.
        ${rollback}
        rollback
      `],{encoding:'utf8'});
      assert.equal(result.status,1,result.stderr);
      const actions=fs.readFileSync(events,'utf8');
      assert.match(actions,/restore-runtime\nhealth/);
      if(health==='healthy') {
        assert.ok(actions.includes(`cleanup:${contour} --apply`));
        assert.match(result.stderr,/retention needs retry/);
      } else assert.doesNotMatch(actions,/cleanup:/);
      assert.match(source,/trap rollback (?:ERR )?HUP INT TERM/);
    } finally {fs.rmSync(directory,{recursive:true,force:true});}
  });
}

test('unknown contour or operation is rejected before Docker or file deletion', () => {
  for (const args of [['other', '--apply'], ['max', '--prune-all'], []]) {
    const result = spawnSync(shell, [script, ...args], {encoding: 'utf8'});
    assert.equal(result.status, 2, result.stderr);
  }
});
