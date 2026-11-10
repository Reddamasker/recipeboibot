import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

test('production Telegram and MAX initialize workspace interaction collection once and preserve the boundary on restart',()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'workspace-tracking-'));
 try{
  for(const platform of ['telegram','max']){
   const env={...process.env,DATABASE_PATH:path.join(directory,platform+'.sqlite'),BOT_PLATFORM:platform,TEST_CONTOUR:'false',TELEGRAM_POLLING:'false',TELEGRAM_BOT_TOKEN:'tracking-fixture',MAX_BOT_TOKEN:'tracking-fixture',OPENAI_API_KEY:'disabled',DINNER_LLM_ENABLED:'false'};
   const run=()=>{const result=spawnSync(process.execPath,['--input-type=module','-e',`import {workspaceInteractionsTrackingSince,productReport} from './src/product-analytics.js';import {db} from './src/db.js';console.log(JSON.stringify({since:workspaceInteractionsTrackingSince(),interactions:productReport([]).workspace.interactions}));db.close();`],{env,encoding:'utf8',timeout:20000});assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);};
   const first=run();assert.ok(Number.isFinite(Date.parse(first.since)));assert.ok(first.interactions);assert.equal(first.interactions.trackingSince,first.since);assert.deepEqual(run(),first);
  }
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
