import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tagged-starts-'));
Object.assign(process.env,{DATABASE_PATH:path.join(dir,'db.sqlite'),BOT_PLATFORM:'telegram',TELEGRAM_POLLING:'false',TEST_CONTOUR:'false',DASHBOARD_PREVIEW:'false'});
const {db,upsertTelegramUser}=await import('../src/db.js');
const {recordBotStart,createCampaign,advertisingRedirect}=await import('../src/funnel.js');
const {recordLandingView,landingRedirect}=await import('../src/landing-funnel.js');
const {taggedStartSnapshot,taggedStartsSince}=await import('../src/tagged-bot-starts.js');
const {landingStartOutcomes,reconcileLandingStarts,validateTaggedSnapshot}=await import('../src/landing-start-outcomes.js');
const token=()=>randomBytes(18).toString('base64url'),user=id=>upsertTelegramUser({id,first_name:'QA'});
const now=()=>new Date();
test.after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});
function click(campaign='qa-tagged') {
  createCampaign(campaign);
  const id=randomBytes(16).toString('hex');
  recordLandingView({visitId:id,query:'campaign='+campaign});
  const payload=new URL(landingRedirect(id)).searchParams.get('start');
  return {payload,token:payload.slice(3),id};
}
test('all tagged starts including repeats are durable; delivery retries and source changes preserve first touch',()=>{
  const a=click(),b=click('qa-second'),u=user(910001);
  recordBotStart(u,'/start '+a.payload,now(),'update-1');
  const first=db.prepare('SELECT * FROM acquisition_starts WHERE user_id=?').get(u.id);
  recordBotStart({...u,is_allowed:1},'/start '+a.payload,now(),'update-1');
  recordBotStart(u,'/start '+a.payload,now(),'update-2');
  recordBotStart(u,'/start '+b.payload,now(),'update-3');
  assert.deepEqual(db.prepare('SELECT * FROM acquisition_starts WHERE user_id=?').get(u.id),first);
  const events=db.prepare('SELECT * FROM tagged_bot_starts WHERE user_id=? ORDER BY rowid').all(u.id);
  assert.equal(events.length,3);assert.deepEqual(events.map(r=>r.is_returning),[0,1,1]);
  const s=taggedStartSnapshot([a.token,b.token]);
  assert.equal(s.rows[0].launches,2);assert.ok(s.rows[0].newAt);assert.ok(s.rows[0].returningAt);
  assert.equal(s.rows[1].newAt,null);assert.ok(s.rows[1].returningAt);
  const forwarded=user(910002);recordBotStart(forwarded,'/start '+a.payload,now(),'update-4');
  assert.equal(taggedStartSnapshot([a.token]).rows[0].launches,3);
  // ad_ links also record repeat launches; arbitrary unknown tokens do not.
  const ad=new URL(advertisingRedirect('qa-tagged')).searchParams.get('start');
  recordBotStart(u,'/start '+ad,now(),'ad-1');recordBotStart(u,'/start '+ad,now(),'ad-2');
  assert.equal(taggedStartSnapshot([ad.slice(3)]).rows[0].launches,2);
  recordBotStart(u,'/start ad_'+token(),now(),'bad');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM tagged_bot_starts WHERE user_id=?').get(u.id).n,5);
});
test('reconciliation partitions clicks, excludes internal starts, retains unknown history and never counts repeats as more clicks',async()=>{
  const a=click('qa-outcomes'),b=click('qa-outcomes'),c=click('qa-outcomes'),d=click('qa-outcomes');
  const u=user(910003);recordBotStart(u,'/start '+a.payload,now(),'o1');recordBotStart(u,'/start '+a.payload,now(),'o2');
  recordBotStart(u,'/start '+b.payload,now(),'o3');
  recordBotStart(user('6971956699'),'/start '+d.payload,now(),'o4');
  const [r,remote]=await landingStartOutcomes('qa-outcomes');
  assert.equal(r.clicks,4);assert.equal(r.newUsers,1);assert.equal(r.existingUsers,1);assert.equal(r.withoutStart,1);
  assert.equal(r.excludedInternal,1);assert.equal(r.bothKinds,1);assert.equal(r.launches,3);assert.equal(r.pending24h,1);
  assert.equal(remote.status,'unavailable');assert.equal(remote.withoutStart,null);
  const history={trackingSince:'2026-11-12T00:00:00.000Z',rows:[]};
  const old=reconcileLandingStarts([{token:c.token,campaign:'qa-outcomes',at:'2026-11-10T00:00:00.000Z'},{token:null,campaign:'qa-outcomes',at:'2026-11-10T00:00:00.000Z'}],history,'telegram');
  assert.equal(old.historicalUnknown,1);assert.equal(old.missingToken,1);assert.equal(old.withoutStart,0);
  assert.equal(r.clicks,r.newUsers+r.existingUsers+r.withoutStart+r.historicalUnknown+r.excludedInternal+r.missingToken);
});
test('bridge rejects missing, duplicate, malformed and incompatible rows; unavailable remote is null',async()=>{
  const t=token(),sample=taggedStartSnapshot([t]);
  assert.equal(validateTaggedSnapshot(sample,[t],'telegram'),sample);
  for(const changed of [{...sample,version:2},{...sample,platform:'max'},{...sample,rows:[]},{...sample,rows:[{...sample.rows[0],launches:-1}]},{...sample,rows:[{...sample.rows[0],newAt:'yesterday'}]}]) {
    assert.throws(()=>validateTaggedSnapshot(changed,[t],'telegram'));
  }
  assert.throws(()=>taggedStartSnapshot([t,t]));assert.throws(()=>taggedStartSnapshot(['raw payload']));
  const options={origin:'https://recipeboibot-max.89-223-123-75.sslip.io',token:'a'.repeat(43)};
  const ok=await landingStartOutcomes('qa-outcomes',{...options,transport:async(_url,req)=>{
    assert.equal(req.method,'POST');const tokens=JSON.parse(req.body).tokens;
    return Response.json({...taggedStartSnapshot(tokens),platform:'max'});
  }});assert.equal(ok[1].status,'ready');
  for(const transport of [async()=>{throw Error('offline');},async()=>Response.json({version:0}),async()=>new Response('bad',{status:503})]) {
    const r=await landingStartOutcomes('qa-outcomes',{...options,transport});assert.equal(r[0].status,'ready');assert.equal(r[1].status,'unavailable');assert.equal(r[1].newUsers,null);
  }
  assert.ok(taggedStartsSince());
});
test('real Telegram handler supplies stable update identity and still welcomes when telemetry storage fails',async()=>{
  const {handleChatUpdate:handleUpdate}=await import('../src/telegram.js');
  const a=click('qa-handler'),from={id:910004,first_name:'QA'},original=globalThis.fetch,messages=[];
  globalThis.fetch=async(url,options)=>{assert.ok(String(url).startsWith('https://api.telegram.org/'));messages.push(JSON.parse(options.body));return Response.json({ok:true,result:{message_id:1}});};
  const update={update_id:923456,message:{message_id:100,from,chat:{id:from.id,type:'private'},text:'/start '+a.payload}};
  try {
    await handleUpdate(update);await handleUpdate(update);
    assert.equal(taggedStartSnapshot([a.token]).rows[0].launches,1);
    await handleUpdate({...update,update_id:923457});
    assert.equal(taggedStartSnapshot([a.token]).rows[0].launches,2);
    db.exec("CREATE TRIGGER qa_tagged_failure BEFORE INSERT ON tagged_bot_starts BEGIN SELECT RAISE(FAIL,'qa'); END");
    const before=messages.length;await handleUpdate({...update,update_id:923458});assert.ok(messages.length>before);
    assert.equal(taggedStartSnapshot([a.token]).rows[0].launches,2);
  } finally {db.exec('DROP TRIGGER IF EXISTS qa_tagged_failure');globalThis.fetch=original;}
});
