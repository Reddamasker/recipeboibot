import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
for(const platform of ['telegram','max'])test(`${platform}: unified collection onboarding, access, retry and analytics`,()=>{
  const result=spawnSync(process.execPath,['scripts/check-collection-onboarding.mjs'],{env:{...process.env,QA_PLATFORM:platform},encoding:'utf8'});
  assert.equal(result.status,0,result.stdout+'\n'+result.stderr);
  assert.match(result.stdout,/"database":"temporary"/);
});
