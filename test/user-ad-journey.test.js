import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

const database=`data/user-ad-journey-${randomUUID()}.sqlite`;
Object.assign(process.env,{DATABASE_PATH:database,TELEGRAM_BOT_TOKEN:'journey-test',TELEGRAM_POLLING:'false',TEST_CONTOUR:'true',BOT_PLATFORM:'telegram',DINNER_LLM_ENABLED:'false',DINNER_IMAGES_ENABLED:'false',OPENAI_API_KEY:'disabled'});
const {db}=await import('../src/db.js');
const {createCampaign}=await import('../src/funnel.js');
await import('../src/user-ad-attribution.js');
await import('../src/billing.js');
const {recordProduct}=await import('../src/product-analytics.js');
const {userAdJourneyFilters,userAdJourneyReport,validUserAdJourneyReport,dashboardUserAdJourneys}=await import('../src/user-ad-journey.js');
test.after(()=>{db.close();for(const suffix of ['','-wal','-shm'])try{fs.unlinkSync(database+suffix);}catch(error){if(error.code!=='ENOENT')throw error;}});
const at='2026-11-11T12:00:00.000Z';
function user(campaign,{accountId='test-'+randomUUID(),created='2026-11-10T12:00:00.000Z',legacy=false,name='Тестовый посетитель'}={}) {
  const id=randomUUID(),token=randomUUID().replaceAll('-','').slice(0,24);
  db.prepare('INSERT INTO users(id,telegram_id,display_name,created_at,updated_at) VALUES(?,?,?,?,?)').run(id,accountId,name,created,created);
  if(campaign){createCampaign(campaign);db.prepare('INSERT INTO acquisition_clicks(token,campaign,created_at,tags_json) VALUES(?,?,?,?)').run(token,campaign,created,JSON.stringify({utm_content:'1926569031941060981',utm_term:'ключ рекламодателя',campaign_id:'716018649',adgroup_id:'5822301389'}));
    if(legacy)db.prepare('INSERT INTO acquisition_starts(user_id,campaign,click_token,started_at,is_returning) VALUES(?,?,?,?,0)').run(id,campaign,token,created);
    else db.prepare('INSERT INTO user_ad_attributions VALUES(?,?,?,?,?,?)').run(id,campaign,token,'telegram',created,'app_entry');}
  return {id,token};
}

test('app-only attribution shows ad identifier, unknown query, last real screen and prior error without inventing chat start',()=>{
  const u=user('journey-app-only');
  recordProduct(u.id,'operation_finished',{id:'entry-failed-000000',step:'boot',at:'2026-11-10T12:01:00.000Z',durationMs:36,detail:{status:403,message:'SECRET MUST NOT LEAK'}});
  recordProduct(u.id,'screen_view',{id:'visible-screen-0000',step:'collection',at:'2026-11-10T12:02:00.000Z'});
  recordProduct(u.id,'screen_view',{id:'visible-screen-0000',step:'offer',at:'2026-11-10T12:03:00.000Z'});
  recordProduct(u.id,'telemetry_health',{step:'other',at:'2026-11-10T12:04:00.000Z'});
  const report=userAdJourneyReport({campaign:'journey-app-only'},{at});const row=report.users[0];
  assert.equal(validUserAdJourneyReport(report),true);assert.equal(row.chatStartedAt,null);assert.equal(row.ad.id,'1926569031941060981');assert.equal(row.search.query,null);assert.equal(row.search.keyword,'ключ рекламодателя');assert.equal(row.search.status,'pending');
  assert.equal(row.lastStep.event,'screen_view');assert.equal(row.lastStep.step,'collection');assert.equal(row.lastError.status,403);assert.equal(row.lastError.durationMs,36);
  assert.equal(row.timeline.filter(e=>e.event==='screen_view').length,1);assert.equal(JSON.stringify(report).includes('SECRET MUST NOT LEAK'),false);
});

test('legacy attribution is retained; accounts without source are not attributed by timestamp',()=>{
  const legacy=user('journey-legacy',{legacy:true});const unknown=user(null,{name:'Уникальный непривязанный'});
  const r=userAdJourneyReport({campaign:'journey-legacy'},{at});assert.equal(r.total,1);assert.equal(r.users[0].userId,legacy.id);assert.ok(r.users[0].chatStartedAt);
  const other=userAdJourneyReport({q:'Уникальный непривязанный'},{at}).users[0];assert.equal(other.userId,unknown.id);assert.equal(other.campaign,null);assert.equal(other.search.status,'unlinked');
});

test('source, MSK date filters, account search, platform and exclusions apply before pagination',()=>{
  const campaign='journey-pagination';for(let i=0;i<12;i++)user(campaign,{name:'Страница '+i});
  user(campaign,{accountId:'6971956699'});user(campaign,{accountId:'private-test:abc'});user(campaign,{accountId:'max:12345'});
  user(campaign,{created:'2026-11-09T20:59:59.000Z'});const boundary=user(campaign,{created:'2026-11-09T21:00:00.000Z',name:'Начало суток'});
  const filters={campaign,from:'2026-11-10',to:'2026-11-10'};
  const one=userAdJourneyReport(filters,{at}),two=userAdJourneyReport({...filters,page:2},{at});assert.equal(one.total,13);assert.equal(one.users.length,10);assert.equal(two.users.length,3);assert.equal(new Set([...one.users,...two.users].map(u=>u.userId)).size,13);
  assert.equal(userAdJourneyReport({...filters,q:'Начало суток'},{at}).users[0].userId,boundary.id);
  assert.equal(userAdJourneyReport({...filters,q:'%'},{at}).total,0);
  for(const bad of [{from:'2026-02-30'},{page:-1},{platform:'all'},{campaign:'x OR 1=1'},{q:'\n'}])assert.throws(()=>userAdJourneyFilters(bad),e=>e.status===400);
});

test('current saved results, failed import and confirmed non-test payment are distinct milestones',()=>{
  const u=user('journey-results');
  db.prepare("INSERT INTO recipes(id,user_id,status,title,created_at,updated_at) VALUES(?,?,'ready','SECRET RECIPE',?,?)").run(randomUUID(),u.id,'2026-11-10T13:00:00.000Z','2026-11-10T13:00:00.000Z');
  db.prepare("INSERT INTO import_jobs(id,user_id,source_type,status,error_code,created_at,updated_at) VALUES(?,?,'photo','failed','AI_TIMEOUT',?,?)").run(randomUUID(),u.id,'2026-11-10T12:01:00.000Z','2026-11-10T12:02:00.000Z');
  db.prepare("INSERT INTO user_trials VALUES(?,?,?)").run(u.id,'2026-11-10T13:01:00.000Z','2026-11-17T13:01:00.000Z');
  db.prepare("INSERT INTO payment_orders(id,user_id,experiment_key,variant,amount_kopeks,kind,status,created_at,updated_at,paid_at,is_test) VALUES(?,?, 'x','a',15900,'initial','paid',?,?,?,1)").run(randomUUID(),u.id,at,at,at);
  const row=userAdJourneyReport({campaign:'journey-results'},{at}).users[0];assert.equal(row.outcomes.savedRecipes,1);assert.equal(row.outcomes.failedImports,1);assert.equal(row.outcomes.paidAt,null);assert.equal(row.lastError.event,'import_failed');assert.equal(row.lastError.code,'AI_TIMEOUT');assert.equal(row.lastStep.event,'trial_activated');assert.equal(JSON.stringify(row).includes('SECRET RECIPE'),false);
});

test('MAX bridge validates version, filter echo, bounds and identity before showing data; failures remain unavailable',async()=>{
  const local=userAdJourneyReport({campaign:'journey-app-only'},{at});const remote=structuredClone(local);remote.platform='max';for(const u of remote.users){u.platform='max';u.accountId='max:100';}
  const options={remoteEnabled:true,origin:'https://recipeboibot-max.89-223-123-75.sslip.io',token:'a'.repeat(43)};
  let seen;
  const good=await dashboardUserAdJourneys({platform:'max',campaign:'journey-app-only'},{...options,transport:async(url,init)=>{seen={url,init};return new Response(JSON.stringify(remote));}});
  assert.equal(good.status,'ready');assert.match(seen.url,/\/api\/internal\/user-ad-journeys/);assert.equal(seen.init.headers.authorization,'Bearer '+'a'.repeat(43));
  for(const bad of [{...remote,version:0},{...remote,total:0},{...remote,campaign:'other'},{...remote,users:[{...remote.users[0],timeline:Array(31).fill(remote.users[0].lastStep)}]}]){
    const result=await dashboardUserAdJourneys({platform:'max',campaign:'journey-app-only'},{...options,transport:async()=>new Response(JSON.stringify(bad))});assert.equal(result.status,'unavailable');assert.equal(result.total,null);
  }
  const tooLarge=await dashboardUserAdJourneys({platform:'max'},{...options,transport:async()=>new Response(' '.repeat(256001))});assert.equal(tooLarge.status,'unavailable');
  const missing=await dashboardUserAdJourneys({platform:'max'},{...options,transport:async()=>new Response('',{status:404})});assert.equal(missing.total,null);
});

test('failed payment return is visible as latest observed step without claiming confirmed payment failure',()=>{
  const u=user('journey-payment-return');
  recordProduct(u.id,'provider_handoff',{step:'checkout',at:'2026-11-10T14:00:00.000Z'});
  recordProduct(u.id,'provider_return',{step:'payment_result',at:'2026-11-10T14:01:00.000Z',detail:{outcome:'fail'}});
  const row=userAdJourneyReport({campaign:'journey-payment-return'},{at}).users[0];
  assert.equal(row.lastStep.event,'provider_return');assert.equal(row.lastError.outcome,'fail');assert.equal(row.outcomes.paidAt,null);
});

test('server completion retains the bounded workspace action from the same observed operation',()=>{
  const u=user('journey-workspace-action'),flowId=randomUUID();
  recordProduct(u.id,'workspace_saved',{step:'other',flowId,durationMs:1,at:'2026-11-10T14:00:00.000Z',detail:{feature:'meal_plan',action:'plan.add'}});
  recordProduct(u.id,'operation_finished',{step:'other',flowId,at:'2026-11-10T14:00:00.001Z',detail:{status:200}});
  const step=userAdJourneyReport({campaign:'journey-workspace-action'},{at}).users[0].lastStep;
  assert.equal(step.action,'plan.add');assert.equal(step.feature,'meal_plan');assert.equal(step.status,200);
});

test('HTTP user report is protected, strips internal attribution tokens and refuses unsupported methods',async()=>{
  const {createServer}=await import('../src/server.js');
  const {createDashboardPassword,openDashboardSession}=await import('../src/funnel-auth.js');
  const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(base+'/api/dashboard/user-ad-journeys')).status,401);
    assert.equal((await fetch(base+'/api/internal/user-ad-journeys')).status,404);
    const token=openDashboardSession(createDashboardPassword()),headers={cookie:'funnel_session='+token,'x-funnel-request':'1'};
    const response=await fetch(base+'/api/dashboard/user-ad-journeys?campaign=journey-app-only',{headers});
    assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
    const data=await response.json();assert.equal(data.status,'ready');assert.equal(data.users.length,1);assert.equal(Object.hasOwn(data.users[0],'clickToken'),false);
    assert.equal((await fetch(base+'/api/dashboard/user-ad-journeys?from=invalid',{headers})).status,400);
    assert.equal((await fetch(base+'/api/dashboard/user-ad-journeys',{method:'POST',headers})).status,405);
  } finally { await new Promise(resolve=>server.close(resolve)); }
});
