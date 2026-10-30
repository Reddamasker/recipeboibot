import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

const database = `data/catalog-details-${randomUUID()}.sqlite`;
Object.assign(process.env,{DATABASE_PATH:database,TELEGRAM_BOT_TOKEN:'catalog-detail-test',TELEGRAM_POLLING:'false',
  TEST_CONTOUR:'true',BOT_PLATFORM:'telegram',DINNER_LLM_ENABLED:'false',DINNER_IMAGES_ENABLED:'false',OPENAI_API_KEY:'disabled'});
const {db}=await import('../src/db.js');
const {createCampaign}=await import('../src/funnel.js');
const {acceptProductEvents,recordProduct,productReport}=await import('../src/product-analytics.js');
const {catalogDetailReport,catalogDetailFilters,validCatalogDetailReport,dashboardCatalogDetails}=await import('../src/catalog-detail-analytics.js');
const {recordCatalogJourneyPublic,recordCatalogJourneyServer}=await import('../src/catalog-journey-analytics.js');
const {createServer}=await import('../src/server.js');
const {createDashboardPassword,openDashboardSession}=await import('../src/funnel-auth.js');
test.after(()=>{db.close();for(const suffix of ['','-wal','-shm'])try{fs.unlinkSync(database+suffix);}catch(error){if(error.code!=='ENOENT')throw error;}});

const iso='2026-10-01T12:00:00.000Z';
const at=seconds=>new Date(Date.parse(iso)+seconds*1000).toISOString();
function visit(campaign){createCampaign(campaign);return {flowId:randomUUID(),sessionId:randomUUID(),campaign};}
function event(v,name,detail={},time=iso){
  const row={id:randomUUID(),event:name,step:'catalog',flowId:v.flowId,journey:'recipe-first-v1',campaign:v.campaign,...detail};
  const {durationMs,...safe}=detail;
  recordProduct(null,name,{id:row.id,visitor:v.sessionId,step:'catalog',flowId:v.flowId,detail:{journey:'recipe-first-v1',...safe},durationMs:durationMs??null,at:time});
  recordCatalogJourneyPublic(row,v.sessionId,time);return row;
}
const start=(v,screen='list',time=iso)=>{const pageId=randomUUID();event(v,'catalog_page_started',{pageId,screen,navigation:'initial',viewport:'compact',pageNumber:1},time);return pageId;};
const report=(campaign,options={})=>catalogDetailReport({campaign,...options},{at:'2026-10-02T12:00:00.000Z'});

test('new public events are atomic, bounded and safe; page start registers a visit without a visible result',()=>{
  const v=visit('details-ingress'),pageId=randomUUID();
  const started={id:randomUUID(),event:'catalog_page_started',step:'catalog',flowId:v.flowId,journey:'recipe-first-v1',campaign:v.campaign,
    pageId,screen:'list',navigation:'initial',viewport:'compact',pageNumber:1,query:'private-query',recipeId:'private-recipe'};
  assert.equal(acceptProductEvents(null,{visitor:v.sessionId,events:[started]}).accepted.length,1);
  acceptProductEvents(null,{visitor:v.sessionId,events:[started]});
  const stored=db.prepare('SELECT detail_json FROM product_events WHERE flow_id=?').all(v.flowId);
  assert.equal(stored.length,1);assert.ok(!JSON.stringify(stored).includes('private-'));
  const originalStart=db.prepare('SELECT created_at FROM catalog_journey_visits WHERE flow_id=?').get(v.flowId).created_at;
  acceptProductEvents(null,{visitor:v.sessionId,events:[{...started,ageMs:86400000}]});
  assert.equal(db.prepare('SELECT created_at FROM catalog_journey_visits WHERE flow_id=?').get(v.flowId).created_at,originalStart,'replaying an ID cannot rewrite the visit date');
  let r=catalogDetailReport({campaign:v.campaign});
  assert.equal(r.totalVisits,1);assert.equal(r.summary.pageViews,1);assert.equal(r.summary.measuredVisits,0);assert.equal(r.summary.visibleMsTotal,null);
  assert.equal(r.visits[0].visibleMs,null);assert.equal(r.visits[0].pages[0].loadMs,null);
  assert.equal(productReport([],false,new Date().toISOString(),v.campaign).catalogJourney.visible,0);
  assert.equal(productReport([]).catalog.some(row=>row.event==='catalog_page_started'),false);
  for(const bad of [
    {event:'catalog_page_started',pageId:'https://private.invalid'},
    {event:'catalog_page_started',navigation:'private',pageNumber:1},
    {event:'catalog_page_started',pageNumber:1001},
    {event:'catalog_section_visible',section:'ingredients'},
    {event:'catalog_page_progress',visibleMs:10,elapsedMs:9,scrollDepth:0,cardsSeen:0,reason:'heartbeat'},
    {event:'catalog_page_progress',visibleMs:1,elapsedMs:1,scrollDepth:101,cardsSeen:0,reason:'heartbeat'},
    {event:'catalog_action',action:'print'},
    {event:'catalog_action',action:'filter_change',control:'raw-food'},
    {event:'catalog_action',action:'card_open',position:25},
    {event:'catalog_page_started',journey:undefined},
  ]){
    assert.throws(()=>acceptProductEvents(null,{visitor:v.sessionId,events:[{...started,id:randomUUID()},{...started,...bad,id:randomUUID()}]}),{status:400});
  }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM product_events WHERE flow_id=?').get(v.flowId).n,1);
});

test('per-page cumulative maxima, safe timelines and real outcomes preserve source and target separation',()=>{
  const v=visit('details-measured'),pageId=start(v);
  event(v,'catalog_list',{pageId,screen:'list',durationMs:220,results:24,filters:2},at(1));
  for(const [seconds,visibleMs,scrollDepth,cardsSeen,reason]of [[5,5000,20,2,'heartbeat'],[8,3000,15,1,'hidden'],[10,9000,70,8,'navigation']])
    event(v,'catalog_page_progress',{pageId,screen:'list',visibleMs,elapsedMs:seconds*1000,scrollDepth,cardsSeen,reason},at(seconds));
  event(v,'catalog_section_visible',{pageId,screen:'list',section:'results'},at(2));
  event(v,'catalog_section_visible',{pageId,screen:'list',section:'results'},at(3));
  event(v,'catalog_action',{pageId,screen:'list',action:'card_open',position:3,query:'private-query',recipeId:'private-recipe'},at(9));
  const recipe=start(v,'recipe',at(10));
  event(v,'catalog_open',{pageId:recipe,screen:'recipe',durationMs:40},at(11));
  event(v,'catalog_page_progress',{pageId:recipe,screen:'recipe',visibleMs:4000,elapsedMs:5000,scrollDepth:100,cardsSeen:0,reason:'hidden'},at(15));
  event(v,'catalog_action',{pageId:recipe,screen:'recipe',action:'save_open'},at(15));
  event(v,'catalog_platform_selected',{pageId:recipe,screen:'recipe',platform:'max'},at(16));
  event(v,'client_error',{pageId:recipe,screen:'recipe',code:'network'},at(17));
  recordCatalogJourneyServer('catalog_bot_started',{...v,platform:'max',occurredAt:at(18)});
  recordCatalogJourneyServer('catalog_recipe_saved',{...v,platform:'max',occurredAt:at(19)});
  recordCatalogJourneyServer('catalog_save_failed',{...v,platform:'telegram',occurredAt:at(20)});
  const r=report(v.campaign),item=r.visits[0];
  assert.equal(validCatalogDetailReport(r),true);
  assert.deepEqual({...r.summary},{visits:1,measuredVisits:1,visibleMsTotal:13000,pageViews:2,onlyListVisits:0,recipeVisits:1,saveIntentVisits:1,starts:1,saved:1,errors:1});
  assert.equal(r.platform,'telegram');assert.equal(item.visibleMs,13000);assert.equal(item.observedSpanMs,20000);
  assert.deepEqual(item.pages[0].sections,['results']);assert.equal(item.pages[0].visibleMs,9000);assert.equal(item.pages[0].cardsSeen,8);
  assert.equal(item.pages[0].loadMs,220);assert.equal(item.pages[0].incomplete,false);assert.equal(item.pages[1].incomplete,true);
  assert.equal(item.events.some(e=>e.event==='catalog_page_progress'),false);assert.equal(item.events.find(e=>e.event==='catalog_platform_selected').platform,'max');
  assert.equal(item.outcomes.filter(e=>e.platform==='max').length,2);
  const text=JSON.stringify(r);for(const value of [v.flowId,v.sessionId,pageId,'private-query','private-recipe','recipeId','detail_json'])assert.ok(!text.includes(value),value);
  const cutoff=catalogDetailReport({campaign:v.campaign},{at:at(12)});
  assert.equal(cutoff.summary.visibleMsTotal,9000);assert.equal(cutoff.summary.saved,0);assert.equal(cutoff.summary.errors,0);
  assert.equal(cutoff.visits[0].lastEventAt,at(11));assert.equal(cutoff.visits[0].outcomes.length,0);
  assert.ok(cutoff.visits[0].events.every(e=>e.at<=at(12)));
});

test('legacy and unmeasured pages remain null; visitor-only actions and wrong subjects are not joined',()=>{
  const v=visit('details-legacy');
  event(v,'catalog_list',{durationMs:31},iso);event(v,'catalog_open',{},at(2));
  recordProduct(null,'catalog_favorite_add',{visitor:v.sessionId,step:'catalog',at:at(3)});
  recordProduct(null,'catalog_action',{visitor:randomUUID(),step:'catalog',flowId:v.flowId,detail:{journey:'recipe-first-v1',pageId:randomUUID(),screen:'recipe',action:'print'},at:at(4)});
  const r=report(v.campaign),item=r.visits[0];
  assert.equal(item.legacy,true);assert.equal(item.visibleMs,null);assert.equal(r.summary.visibleMsTotal,null);
  assert.equal(item.pages.length,2);assert.ok(item.pages.every(p=>p.visibleMs===null&&p.legacy));assert.equal(item.events.length,2);
  assert.equal(validCatalogDetailReport(r),true);
});

test('Moscow visit-start cohorts handle out-of-order delivery and keep later actions until the snapshot',()=>{
  const v=visit('details-midnight'),pageId=randomUUID();
  event(v,'catalog_list',{pageId,screen:'list'},'2026-10-01T21:00:01.000Z');
  event(v,'catalog_page_started',{pageId,screen:'list',navigation:'initial',viewport:'wide',pageNumber:1},'2026-10-01T20:59:59.000Z');
  event(v,'catalog_action',{pageId,screen:'list',action:'card_open',position:1},'2026-10-02T00:00:00.000Z');
  assert.equal(report(v.campaign,{from:'2026-10-01',to:'2026-10-01'}).totalVisits,1);
  assert.equal(report(v.campaign,{from:'2026-10-02',to:'2026-10-02'}).totalVisits,0);
  assert.equal(report(v.campaign,{from:'2026-10-01',to:'2026-10-01'}).visits[0].events.length,3);
  for(const invalid of [{from:'2026-02-30'},{from:'2026-10-02',to:'2026-10-01'},{page:0},{page:'1.5'},{campaign:'https://invalid'},{platform:'all'},{group:'unknown'},{group:'all?private=1'}])assert.throws(()=>catalogDetailFilters(invalid),{status:400});
  const unknown=catalogDetailReport({campaign:'unknown-campaign'});
  assert.equal(unknown.status,'ready');assert.equal(unknown.totalVisits,0);assert.equal(unknown.campaign,'unknown-campaign');
});

test('all filtered totals exceed displayed pages while histories are explicitly bounded',()=>{
  const campaign='details-paging';let first;
  for(let i=0;i<12;i++){const v=visit(campaign);first??=v;const pageId=start(v,'list',at(i));event(v,'catalog_page_progress',{pageId,screen:'list',visibleMs:100,elapsedMs:100,scrollDepth:0,cardsSeen:0,reason:'heartbeat'},at(i+1));}
  for(let i=0;i<23;i++){const pageId=start(first,'list',at(30+i));for(let n=0;n<4;n++)event(first,'catalog_action',{pageId,screen:'list',action:'sort_change'},at(30+i));}
  const internal=visit(campaign);start(internal);recordCatalogJourneyServer('catalog_bot_started',{...internal,platform:'telegram',isInternal:true,occurredAt:iso});
  const remoteOnly=visit(campaign);recordCatalogJourneyServer('catalog_bot_started',{...remoteOnly,platform:'max',occurredAt:iso});
  const other=visit('details-other');start(other);
  const one=report(campaign),two=report(campaign,{page:2}),last=two.visits.at(-1);
  assert.equal(one.totalVisits,12);assert.equal(one.visits.length,10);assert.equal(two.visits.length,2);assert.deepEqual(one.summary,two.summary);
  assert.equal(one.summary.pageViews,35);assert.equal(one.summary.visibleMsTotal,1200);assert.equal(one.summary.starts,0);
  assert.equal(last.number,1);assert.equal(last.pages.length,20);assert.equal(last.pagesTruncated,true);assert.equal(last.events.length,80);assert.equal(last.eventsTruncated,true);
  assert.equal(validCatalogDetailReport(one),true);assert.equal(validCatalogDetailReport(two),true);assert.equal(report(campaign,{page:3}).visits.length,0);
});

test('MAX bridge validates full schema and exact scope, with missing or corrupt data unavailable',async()=>{
  createCampaign('details-empty');
  const empty={...report('details-empty'),platform:'max'};
  const options={remoteEnabled:true,origin:'https://recipeboibot-max.89-223-123-75.sslip.io',token:'t'.repeat(43)};
  const scope={campaign:'details-empty',platform:'max'};
  const transport=payload=>async(url,request)=>{assert.equal(new URL(url).pathname,'/api/internal/catalog-visits');assert.equal(request.redirect,'error');return new Response(JSON.stringify(payload));};
  const good=await dashboardCatalogDetails(scope,{...options,transport:transport(empty)});
  assert.equal(good.status,'ready');assert.equal(good.totalVisits,0);assert.equal(good.summary.visibleMsTotal,null);
  for(const payload of [{...empty,version:1},{...empty,version:3},{...empty,campaign:'all'},{...empty,from:'2026-10-01'},{...empty,group:'one_recipe'},{...empty,secret:'private'}, {...empty,summary:{...empty.summary,visits:1}}]){
    const result=await dashboardCatalogDetails(scope,{...options,transport:transport(payload)});
    assert.equal(result.status,'unavailable');assert.equal(result.summary,null);assert.equal(result.totalVisits,null);
  }
  const large=await dashboardCatalogDetails(scope,{...options,transport:async()=>new Response(' '.repeat(512001))});assert.equal(large.status,'unavailable');
  const outage=await dashboardCatalogDetails(scope,{...options,transport:async()=>{throw Error('network');}});assert.equal(outage.status,'unavailable');
  const disabled=await dashboardCatalogDetails(scope,{...options,remoteEnabled:false,transport:()=>assert.fail('no network')});assert.equal(disabled.status,'unavailable');
  const badOrigin=await dashboardCatalogDetails(scope,{...options,origin:'https://invalid.example',transport:()=>assert.fail('no network')});assert.equal(badOrigin.status,'unavailable');
  const measured={...report('details-measured'),platform:'max'};
  assert.equal(validCatalogDetailReport(measured),true);
  const leaked=structuredClone(measured);leaked.visits[0].events[0].recipeId='private';assert.equal(validCatalogDetailReport(leaked),false);
  const invalidTime=structuredClone(measured);invalidTime.visits[0].pages[0].visibleMs=-1;assert.equal(validCatalogDetailReport(invalidTime),false);
  const missing=structuredClone(measured);missing.visits=[];assert.equal(validCatalogDetailReport(missing),false);
  const ordinal=structuredClone(measured);ordinal.visits[0].number=2;assert.equal(validCatalogDetailReport(ordinal),false);
  const future=structuredClone(measured);future.visits[0].events[0].at='2099-01-01T00:00:00.000Z';assert.equal(validCatalogDetailReport(future),false);
  const span=structuredClone(measured);span.visits[0].observedSpanMs++;assert.equal(validCatalogDetailReport(span),false);
  const skew=structuredClone(measured);skew.visits[0].outcomes[0].at=new Date(Date.parse(skew.visits[0].startedAt)-1000).toISOString();
  assert.equal(validCatalogDetailReport(skew),true,'remote clock skew does not erase a confirmed outcome or change the visit cohort');
});

test('HTTP report requires dashboard authentication and public ingestion never exposes identities',async()=>{
  const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  try{
    assert.equal((await fetch(base+'/api/dashboard/catalog-visits')).status,401);
    assert.equal((await fetch(base+'/api/internal/catalog-visits')).status,404);
    const token=openDashboardSession(createDashboardPassword()),headers={cookie:'funnel_session='+token};
    const response=await fetch(base+'/api/dashboard/catalog-visits?campaign=details-measured',{headers});
    assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(validCatalogDetailReport(await response.json()),true);
    assert.equal((await fetch(base+'/api/dashboard/catalog-visits?from=invalid',{headers})).status,400);
    assert.equal((await fetch(base+'/api/dashboard/catalog-visits',{method:'POST',headers:{...headers,'x-funnel-request':'1'}})).status,405);
    const v=visit('details-http'),pageId=randomUUID();
    const payload={visitor:v.sessionId,events:[{id:randomUUID(),event:'catalog_page_started',step:'catalog',journey:'recipe-first-v1',flowId:v.flowId,campaign:v.campaign,pageId,screen:'recipe',navigation:'initial',viewport:'compact',pageNumber:1}]};
    const accepted=await fetch(base+'/api/analytics/public',{method:'POST',headers:{'content-type':'application/json','x-analytics-request':'1'},body:JSON.stringify(payload)});
    assert.equal(accepted.status,200);assert.equal((await accepted.json()).accepted.length,1);
    const result=await (await fetch(base+'/api/dashboard/catalog-visits?campaign=details-http',{headers})).json();
    assert.equal(result.totalVisits,1);assert.equal(result.summary.recipeVisits,0);assert.equal(result.visits[0].pages[0].screen,'recipe');
  }finally{await new Promise(resolve=>server.close(resolve));}
});
