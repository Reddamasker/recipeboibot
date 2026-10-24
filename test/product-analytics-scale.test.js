import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
const file=`data/product-scale-${randomUUID()}.sqlite`;
Object.assign(process.env,{DATABASE_PATH:file,TELEGRAM_BOT_TOKEN:'scale-test',TELEGRAM_POLLING:'false',TEST_CONTOUR:'false',BOT_PLATFORM:'telegram',DINNER_LLM_ENABLED:'false',DINNER_IMAGES_ENABLED:'false',OPENAI_API_KEY:'disabled'});
const {db,upsertTelegramUser}=await import('../src/db.js');
await import('../src/server.js');
const {recordProduct,productReport}=await import('../src/product-analytics.js');
test.after(()=>{db.close();for(const suffix of ['','-wal','-shm'])fs.rmSync(file+suffix,{force:true});});

test('large account cohort stays below the bridge deadline and preserves per-user progress',()=>{
  const cohort=[],at='2026-10-01T00:00:00.000Z';
  db.exec('BEGIN');
  try {
    for(let i=0;i<5000;i++) {
      const u=upsertTelegramUser({id:9000000+i});cohort.push({...u,started_at:at});
      for(const step of ['home','household','offer']) assert.equal(recordProduct(u.id,'screen_view',{step,at}),true);
      if(i%2===0) assert.equal(recordProduct(u.id,'step_submit',{step:'offer',at}),true);
    }
    db.exec('COMMIT');
  } catch(e) {db.exec('ROLLBACK');throw e;}
  const start=performance.now();
  const report=productReport(cohort,false,'2026-10-03T00:00:00.000Z');
  const elapsed=performance.now()-start;
  assert.equal(report.steps.find(r=>r.step==='offer').inactive,2500);
  assert.equal(report.steps.find(r=>r.step==='household').inactive,0);
  assert.deepEqual(report.checkout.ordered,[5000,0,0,0,0]);
  assert.ok(elapsed<2000,`17,500 events / 5,000 accounts took ${Math.round(elapsed)}ms (bridge timeout is 5s)`);
});
