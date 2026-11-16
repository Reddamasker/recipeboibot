import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'campaign-journey-'));
Object.assign(process.env,{DATABASE_PATH:path.join(dir,'db.sqlite'),BOT_PLATFORM:'telegram',TELEGRAM_POLLING:'false',TEST_CONTOUR:'false',DASHBOARD_PREVIEW:'false',OPENAI_API_KEY:'disabled',TELEGRAM_BOT_TOKEN:'local-only'});
const {db,upsertTelegramUser}=await import('../src/db.js');
const {createServer}=await import('../src/server.js');
const {createCampaign,recordBotStart}=await import('../src/funnel.js');
const {recordLandingView,landingRedirect}=await import('../src/landing-funnel.js');
const {recordProduct}=await import('../src/product-analytics.js');
const {campaignJourneySnapshot,validateCampaignJourney,campaignJourneyFilters,campaignJourneyReport}=await import('../src/campaign-journey.js');
const now='2026-11-16T12:00:00.000Z', at='2026-11-10T12:00:00.000Z';
let nextUser=981000;
function fixture(campaign='qa-journey',userId=++nextUser) {
  createCampaign(campaign);
  const id=randomUUID().replaceAll('-','');recordLandingView({visitId:id,query:'campaign='+campaign});
  const payload=new URL(landingRedirect(id)).searchParams.get('start');
  db.prepare('UPDATE landing_visits SET opened_at=?,telegram_clicked_at=? WHERE id=?').run(at,at,id);
  const user=upsertTelegramUser({id:userId,first_name:'QA'});
  recordBotStart(user,'/start '+payload,new Date(at),'delivery-'+id);
  return {id,user,payload,visit:{token:payload.slice(3),campaign,at}};
}
function save(f,time='2026-11-10T13:00:00.000Z',status='ready') {
  db.prepare('INSERT INTO recipes(id,user_id,status,title,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(randomUUID(),f.user.id,status,'QA',time,time);
}
function view(f,time='2026-11-11T12:00:00.000Z',event='screen_view') {recordProduct(f.user.id,event,{at:time,step:'collection'});}
function pay(f,time='2026-11-12T12:00:00.000Z',isTest=0) {
  db.prepare("INSERT INTO payment_orders(id,user_id,experiment_key,variant,amount_kopeks,kind,status,created_at,updated_at,paid_at,is_test) VALUES(?,?, 'qa','A',15900,'initial','paid',?,?,?,?)").run(randomUUID(),f.user.id,time,time,time,isTest);
}
test.after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});

test('six stages require ordered facts from one account; repeat delivery and repeated screens do not duplicate visits',async()=>{
  const f=fixture();save(f);view(f);view(f);pay(f);
  recordBotStart(f.user,'/start '+f.payload,new Date(at),'delivery-'+f.id);
  const snap=campaignJourneySnapshot([f.visit],now);
  assert.equal(snap.rows[0].stage,4);assert.equal(snap.rows[0].paidAfterStart,true);
  const report=await campaignJourneyReport({campaign:'qa-journey',from:'2026-11-10',to:'2026-11-10'},{now});
  assert.deepEqual(report.platforms[0].counts,[1,1,1,1,1,1]);
  assert.deepEqual(report.platforms[0].conversions,[null,100,100,100,100,100]);
  assert.equal(report.platforms[1].counts[2],null);
});
test('drafts, background operations, same-day views and test payments cannot complete the chain',()=>{
  const draft=fixture();save(draft,undefined,'draft');view(draft);pay(draft);
  assert.equal(campaignJourneySnapshot([draft.visit],now).rows[0].stage,1);
  const f=fixture();save(f);view(f,'2026-11-10T20:59:00.000Z');view(f,'2026-11-11T12:00:00.000Z','operation_finished');pay(f);
  let r=campaignJourneySnapshot([f.visit],now).rows[0];assert.equal(r.stage,2);assert.equal(r.paidAfterStart,true);
  view(f,'2026-11-12T21:00:00.000Z');pay(f,'2026-11-13T12:00:00.000Z',1);
  assert.equal(campaignJourneySnapshot([f.visit],now).rows[0].stage,3);
  pay(f,'2026-11-14T12:00:00.000Z');assert.equal(campaignJourneySnapshot([f.visit],now).rows[0].stage,4);
});
test('Moscow next day counts; payments before return remain outside the full chain; pre-start saves ignored',async()=>{
  const f=fixture('qa-outside');save(f,'2026-11-10T20:58:00.000Z');pay(f,'2026-11-10T20:59:00.000Z');view(f,'2026-11-10T21:00:00.000Z');
  const r=await campaignJourneyReport({campaign:'qa-outside',from:'2026-11-10',to:'2026-11-10'},{now});
  assert.deepEqual(r.platforms[0].counts,[1,1,1,1,1,0]);assert.equal(r.platforms[0].paidOutsideChain,1);
  const before=fixture();save(before,'2026-11-09T00:00:00.000Z');view(before);assert.equal(campaignJourneySnapshot([before.visit],now).rows[0].stage,1);
});
test('shared links never splice saves, returns and payments across accounts',()=>{
  const f=fixture();save(f);view(f);
  const other=upsertTelegramUser({id:++nextUser,first_name:'QA'});
  recordBotStart(other,'/start '+f.payload,new Date(at),'forwarded');pay({user:other});
  const r=campaignJourneySnapshot([f.visit],now).rows[0];assert.equal(r.stage,3);assert.equal(r.paidAfterStart,true);
});
test('internal users excluded, source/date filters isolate cohorts; zero denominator is unknown',async()=>{
  const internal=fixture('qa-internal','6971956699');save(internal);view(internal);pay(internal);
  const r=await campaignJourneyReport({campaign:'qa-internal',from:'2026-11-10',to:'2026-11-10'},{now});
  assert.deepEqual(r.platforms[0].counts,[0,0,0,0,0,0]);assert.equal(r.platforms[0].excludedInternal,1);assert.ok(r.platforms[0].conversions.every(x=>x===null));
  const empty=await campaignJourneyReport({campaign:'qa-journey',from:'2026-11-11',to:'2026-11-12'},{now});assert.deepEqual(empty.platforms[0].counts,[0,0,0,0,0,0]);
});
test('remote protocol is strict, missing/old/error MAX is unavailable, never zero',async()=>{
  const f=fixture('qa-bridge');
  db.prepare('UPDATE landing_visits SET max_clicked_at=?,max_click_token=? WHERE id=?').run(at,f.visit.token,f.id);
  const opts={now,origin:'https://recipeboibot-max.89-223-123-75.sslip.io',token:'a'.repeat(43)};
  const filters={campaign:'qa-bridge',from:'2026-11-10',to:'2026-11-10'};
  const valid={...campaignJourneySnapshot([f.visit],now),platform:'max'};
  assert.equal(validateCampaignJourney(valid,[f.visit],'max',now),valid);
  for(const bad of [{...valid,version:2},{...valid,rows:[]},{...valid,generatedAt:at},{...valid,rows:[{...valid.rows[0],stage:5}]},{...valid,rows:[{...valid.rows[0],internal:true}]}]) assert.throws(()=>validateCampaignJourney(bad,[f.visit],'max',now));
  const ready=await campaignJourneyReport(filters,{...opts,transport:async()=>Response.json(valid)});assert.equal(ready.platforms[1].counts[2],1);
  for(const transport of [async()=>Response.json({version:0}),async()=>{throw Error('offline');},async()=>new Response('error',{status:503})]) {
    const r=await campaignJourneyReport(filters,{...opts,transport});assert.deepEqual(r.platforms[1].counts,[1,1,null,null,null,null]);assert.equal(r.platforms[0].status,'ready');
  }
});
test('bad dates/tokens rejected and report requires dashboard authentication',async()=>{
  for(const q of ['from=2026-02-30','from=2026-11-12&to=2026-11-10','campaign=../secret'])assert.throws(()=>campaignJourneyFilters(new URLSearchParams(q)));
  assert.throws(()=>campaignJourneySnapshot([{token:'bad'}],now));
  const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try {
    const base='http://127.0.0.1:'+server.address().port;
    assert.equal((await fetch(base+'/api/dashboard/campaign-journey')).status,401);
    assert.equal((await fetch(base+'/api/internal/campaign-journey',{method:'POST'})).status,404);
    assert.equal((await fetch(base+'/dashboard-campaign-journey.js')).status,200);
  } finally {await new Promise(r=>server.close(r));}
});

test('actual MAX endpoint authenticates and returns the same chronological chain',()=>{
  const f=fixture('qa-max-http');save(f);view(f);pay(f);
  const script=`const {createServer}=await import('./src/server.js');
    const {db,upsertTelegramUser}=await import('./src/db.js');
    const user=upsertTelegramUser({id:'max:981111',first_name:'QA'});
    db.prepare('INSERT INTO tagged_bot_starts VALUES(?,?,?,?,?,?)').run('qa-max-event',user.id,'qa-max-http',${JSON.stringify(f.visit.token)},${JSON.stringify(at)},0);
    db.prepare("INSERT INTO recipes(id,user_id,status,title,created_at,updated_at) VALUES('qa-max-recipe',?,'ready','QA','2026-11-10T13:00:00.000Z','2026-11-10T13:00:00.000Z')").run(user.id);
    const {recordProduct}=await import('./src/product-analytics.js');recordProduct(user.id,'screen_view',{at:'2026-11-11T12:00:00.000Z',step:'collection'});
    db.prepare("INSERT INTO payment_orders(id,user_id,experiment_key,variant,amount_kopeks,kind,status,created_at,updated_at,paid_at,is_test) VALUES('qa-max-pay',?,'qa','A',15900,'initial','paid','2026-11-12T12:00:00.000Z','2026-11-12T12:00:00.000Z','2026-11-12T12:00:00.000Z',0)").run(user.id);
    const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
    const base='http://127.0.0.1:'+server.address().port+'/api/internal/campaign-journey';
    const body=JSON.stringify({visits:${JSON.stringify([f.visit])},now:${JSON.stringify(now)}});
    const denied=await fetch(base,{method:'POST',body});
    const response=await fetch(base,{method:'POST',headers:{authorization:'Bearer '+process.env.MAX_FUNNEL_TOKEN,'content-type':'application/json'},body});
    console.log(JSON.stringify({denied:denied.status,status:response.status,data:await response.json()}));
    await new Promise(r=>server.close(r));`;
  const child=spawnSync(process.execPath,['--input-type=module','-'],{input:script,encoding:'utf8',env:{...process.env,DATABASE_PATH:path.join(dir,'max.sqlite'),BOT_PLATFORM:'max',MAX_FUNNEL_TOKEN:'a'.repeat(43)},timeout:20000});
  assert.equal(child.status,0,child.stderr);
  const result=JSON.parse(child.stdout.trim());assert.equal(result.denied,404);assert.equal(result.status,200);assert.equal(result.data.platform,'max');assert.equal(result.data.rows[0].stage,4);
});

test('historical first starts remain usable, missing tokens and unconfirmed history are explicit',async()=>{
  const f=fixture('qa-history');save(f);view(f);
  db.prepare('DELETE FROM tagged_bot_starts WHERE click_token=?').run(f.visit.token);
  assert.equal(campaignJourneySnapshot([f.visit],now).rows[0].stage,3);
  const id=randomUUID().replaceAll('-','');recordLandingView({visitId:id,query:'campaign=qa-history'});
  db.prepare('UPDATE landing_visits SET opened_at=?,telegram_clicked_at=? WHERE id=?').run(at,at,id);
  const r=await campaignJourneyReport({campaign:'qa-history',from:'2026-11-10',to:'2026-11-10'},{now});assert.deepEqual(r.platforms[0].counts,[2,2,1,1,1,0]);assert.equal(r.platforms[0].missingToken,1);
});
