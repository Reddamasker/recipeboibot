import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
const file=`data/app-entry-${randomUUID()}.sqlite`;
Object.assign(process.env,{DATABASE_PATH:file,BOT_PLATFORM:'max',MAX_BOT_TOKEN:'entry-test',MAX_BOT_USERNAME:'entry_test_bot',TELEGRAM_POLLING:'false',TEST_CONTOUR:'false',OPENAI_API_KEY:'disabled',DINNER_LLM_ENABLED:'false'});
const {db,upsertTelegramUser}=await import('../src/db.js');
const {recordProduct,acceptProductEvents,productReport,validProductReport}=await import('../src/product-analytics.js');
const {createCampaign,recordBotStart,funnelReport}=await import('../src/funnel.js');
const {maxFunnelSnapshot,mergeMaxFunnelReport}=await import('../src/max-funnel.js');
const since='2026-11-10T00:00:00.000Z';
db.prepare("UPDATE product_analytics_metadata SET value=? WHERE key='app_entry_since'").run(since);
let seq=990000;
const user=(id)=>upsertTelegramUser({id:id||`max:${++seq}`,first_name:'Entry'});
const boot=(u,status=200,at='2026-11-10T10:00:00.000Z',id=randomUUID())=>recordProduct(u?.id||null,u?'operation_finished':'auth_error',{id,visitor:u?null:randomUUID(),step:'boot',durationMs:u?20:null,detail:{status},at});
test.after(()=>{db.close();for(const suffix of ['','-wal','-shm'])fs.rmSync(file+suffix,{force:true});});
test('app-only entry is visible in product analytics, never a bot start or campaign',()=>{
 const u=user(),internal=user('max:464796559'),privateUser=user('private-test:entry');
 boot(u);boot(internal);boot(privateUser);
 const all=funnelReport();assert.equal(all.totals.starts,0);assert.equal(all.productAnalytics.platforms[0].appEntry.users,1);
 assert.equal(db.prepare('select count(*) n from acquisition_starts').get().n,0);
 assert.equal(db.prepare('select is_allowed from users where id=?').get(u.id).is_allowed,0);
 recordBotStart(u,'/start');assert.equal(funnelReport().totals.starts,1);assert.equal(db.prepare('select is_returning from acquisition_starts where user_id=?').get(u.id).is_returning,0);
});
test('entry separates response success from visible screens, retries, failures and unknown identities',()=>{
 const u=user(),blocked=user();const id=randomUUID();boot(u,200,undefined,id);boot(u,200,undefined,id);boot(u);boot(blocked,403);boot(null,401);
 const batch={events:[{id:randomUUID(),event:'screen_view',step:'collection',ageMs:0,version:'product-1',session:randomUUID()}]};
 acceptProductEvents(u.id,batch);acceptProductEvents(u.id,batch);
 const r=productReport([u,blocked]).appEntry;assert.equal(r.attempts,4);assert.equal(r.successes,2);assert.equal(r.errors,2);assert.equal(r.users,1);assert.equal(r.visibleUsers,1);assert.equal(r.unidentifiedErrors,1);assert.equal(r.timing.samples,3);
 assert.equal(validProductReport(productReport([u,blocked])),true);
});
test('campaign entry excludes unknown errors, pre-start events and unattributed app users',()=>{
 const u=user();createCampaign('entry-source','Entry source');
 db.prepare('insert into acquisition_starts(user_id,campaign,started_at,is_returning) values(?,?,?,0)').run(u.id,'entry-source','2026-11-10T11:00:00.000Z');
 boot(u,200,'2026-11-10T10:00:00.000Z');boot(u,200,'2026-11-10T12:00:00.000Z');
 const r=funnelReport('entry-source').productAnalytics.platforms[0].appEntry;assert.equal(r.attempts,1);assert.equal(r.users,1);assert.equal(r.unidentifiedErrors,0);
});
test('new entry aggregate has an explicit start date and validates missing/invalid remote data',()=>{
 const u=user();boot(u,200,'2026-11-09T23:59:59.000Z');assert.equal(productReport([u]).appEntry.attempts,1); // anonymous error is in the unfiltered total
 const r=productReport([u]);assert.equal(r.appEntry.users,0);delete r.appEntry;assert.equal(validProductReport(r),true);
 r.appEntry={...productReport([u]).appEntry,users:100};assert.equal(validProductReport(r),false);
 const snap=maxFunnelSnapshot();assert.ok(snap.all.productAnalytics.platforms[0].appEntry);assert.equal(validProductReport(snap.all.productAnalytics.platforms[0]),true);
});

test('MAX bridge preserves app entry, reports absent data as null and rejects invalid counts',async()=>{
 const report=funnelReport(),snap=maxFunnelSnapshot();
 const merge=data=>mergeMaxFunnelReport(report,{enabled:true,origin:'https://recipeboibot-max.89-223-123-75.sslip.io',token:'x'.repeat(48),transport:async()=>Response.json(data)});
 const good=await merge(snap);assert.equal(good.remoteFunnel.status,'ready');assert.ok(good.productAnalytics.platforms.at(-1).appEntry);
 const legacy=structuredClone(snap);for(const scope of ['all','campaign'])delete legacy[scope].productAnalytics.platforms[0].appEntry;
 const old=await merge(legacy);assert.equal(old.remoteFunnel.status,'ready');assert.equal(old.productAnalytics.platforms.at(-1).appEntry,null);
 const bad=structuredClone(snap);bad.all.productAnalytics.platforms[0].appEntry.attempts=-1;
 assert.equal((await merge(bad)).remoteFunnel.status,'error');
});
