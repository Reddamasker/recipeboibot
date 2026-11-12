import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
test('real encrypted backup migration, restore validation, time/byte limits and failure safety',t=>{
 const candidates=[process.env.REVIEW_TEST_PYTHON,'python3','python',path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe')].filter(Boolean);
 const python=candidates.find(p=>spawnSync(p,['--version'],{encoding:'utf8'}).status===0);
 if(!python){t.skip('Run storage_test.py on the deployment host');return;}
 const env={...process.env,PYTHONDONTWRITEBYTECODE:'1'};if(process.platform==='win32')env.PATH='C:/Program Files/Git/usr/bin;'+env.PATH;
 const r=spawnSync(python,['test/storage_test.py'],{encoding:'utf8',env});
 assert.equal(r.status,0,r.stdout+r.stderr);
});
test('ordinary releases ship storage tooling and gate space before builds; daily backup covers all contours',()=>{
 for(const file of ['scripts/deploy.js','scripts/deploy-test.js'])assert.ok(fs.readFileSync(file,'utf8').includes("'deploy/storage.py'"));
 for(const file of ['deploy/apply-release.sh','deploy/apply-test-release.sh','deploy/apply-max-release.sh']){
  const s=fs.readFileSync(file,'utf8');assert.ok(s.indexOf('storage.py preflight')<s.indexOf(' build '));assert.match(s,/storage.py/);
 }
 assert.match(fs.readFileSync('deploy/backup.sh','utf8'),/scopes='production test max'/);
 assert.match(fs.readFileSync('deploy/ops-monitor.sh','utf8'),/sqlite.gz.enc/);
 const apply=fs.readFileSync('deploy/apply-storage.sh','utf8');
 assert.doesNotMatch(apply,/compose (?:up|stop|restart)|docker (?:stop|restart)|\.env.local/);
 assert.match(apply,/recipeboibot-docker-deploy.lock/);
});
