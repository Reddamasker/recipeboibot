import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';

const database=`data/catalog-path-groups-${randomUUID()}.sqlite`;
Object.assign(process.env,{DATABASE_PATH:database,TELEGRAM_BOT_TOKEN:'catalog-path-test',TELEGRAM_POLLING:'false',
  TEST_CONTOUR:'true',BOT_PLATFORM:'telegram',DINNER_LLM_ENABLED:'false',DINNER_IMAGES_ENABLED:'false',OPENAI_API_KEY:'disabled'});
const {db}=await import('../src/db.js');
const {createCampaign}=await import('../src/funnel.js');
const {acceptProductEvents,recordProduct}=await import('../src/product-analytics.js');
const {recordCatalogJourneyPublic,recordCatalogJourneyServer}=await import('../src/catalog-journey-analytics.js');
const {catalogPathGroups,catalogDetailReport,validCatalogDetailReport,dashboardCatalogDetails}=await import('../src/catalog-detail-analytics.js');
test.after(()=>{db.close();for(const suffix of ['','-wal','-shm'])try{fs.unlinkSync(database+suffix);}catch(error){if(error.code!=='ENOENT')throw error;}});

const epoch=Date.parse('2026-10-01T12:00:00.000Z'),at=seconds=>new Date(epoch+seconds*1000).toISOString();
const snapshot='2026-10-03T12:00:00.000Z';
function visit(campaign,time=at(0)) {createCampaign(campaign);return {flowId:randomUUID(),sessionId:randomUUID(),campaign,time};}
function event(v,name,detail={},time=v.time) {
  const row={id:randomUUID(),event:name,step:'catalog',flowId:v.flowId,journey:'recipe-first-v1',campaign:v.campaign,...detail};
  recordProduct(null,name,{id:row.id,visitor:v.sessionId,step:'catalog',flowId:v.flowId,detail:{journey:'recipe-first-v1',...detail},at:time});
  recordCatalogJourneyPublic(row,v.sessionId,time);return row;
}
function page(v,{screen='list',visible=true,cards=null,time=v.time}={}) {
  const pageId=randomUUID();
  event(v,'catalog_page_started',{pageId,screen,navigation:'initial',viewport:'compact',pageNumber:1},time);
  if(visible)event(v,screen==='list'?'catalog_list':'catalog_open',{pageId,screen},time);
  if(cards!==null)event(v,'catalog_page_progress',{pageId,screen,visibleMs:1000,elapsedMs:1000,scrollDepth:0,cardsSeen:cards,reason:'heartbeat'},time);
  return pageId;
}
const report=(campaign,extra={},time=snapshot)=>catalogDetailReport({campaign,...extra},{at:time});
const counts=r=>Object.fromEntries(r.groups.map(g=>[g.id,g.count]));
const category=v=>report(v.campaign).visits.find(item=>item.startedAt===v.time)?.group;
const outcome=(v,name,platform='telegram',time=v.time)=>recordCatalogJourneyServer(name,{...v,platform,occurredAt:time});

test('groups partition full visits by explicit action, empty result and confirmed visibility, retaining unknown cards',()=>{
  const campaign='path-partition';
  const v0=visit(campaign,at(0));page(v0,{visible:false,cards:12});
  const v1=visit(campaign,at(1));page(v1,{cards:1});event(v1,'catalog_filter',{filters:2});event(v1,'catalog_search',{results:24});
  const v2=visit(campaign,at(2));page(v2,{cards:8});
  const v3=visit(campaign,at(3));page(v3,{cards:9});
  const v4=visit(campaign,at(4));const p4=page(v4,{cards:24});event(v4,'catalog_action',{pageId:p4,screen:'list',action:'filters_expand'});
  const v5=visit(campaign,at(5));const p5=page(v5);event(v5,'catalog_action',{pageId:p5,screen:'list',action:'search_submit'});event(v5,'catalog_empty',{});
  const v6=visit(campaign,at(6));event(v6,'catalog_list');
  const v7=visit(campaign,at(7));page(v7);
  const v8=visit(campaign,at(8));page(v8,{cards:0});
  const v9=visit(campaign,at(9));page(v9,{cards:5});page(v9,{cards:5,time:at(10)});
  const r=report(campaign),c=counts(r);
  assert.equal(r.version,3);assert.equal(r.group,'all');assert.deepEqual(r.groups.map(g=>g.id),catalogPathGroups);
  assert.equal(r.totalVisits,10);assert.equal(r.groups.reduce((sum,g)=>sum+g.count,0),10);
  assert.deepEqual(c,{unconfirmed:1,brief_catalog:3,deep_catalog:1,active_catalog:1,empty_results:1,one_recipe:0,multiple_recipes:0,legacy_catalog:1,unknown_catalog:2,save_intent:0,bot_started:0,saved:0});
  assert.equal(category(v1),'brief_catalog','URL filter/search metadata are not explicit actions');
  assert.equal(category(v9),'brief_catalog','max positions across pages is not the sum of repeated cards');
  assert.equal(category(v0),'unconfirmed','page start, sections or progress do not assert a visible result');
  assert.equal(validCatalogDetailReport(r),true);
});

test('exact recipe opens outrank empty and actions; server outcomes outrank missing client stages',()=>{
  const campaign='path-priority';
  const one=visit(campaign,at(0));page(one);event(one,'catalog_empty');page(one,{screen:'recipe',time:at(1)});
  const many=visit(campaign,at(2));page(many,{screen:'recipe'});page(many,{screen:'recipe',time:at(3)});event(many,'catalog_empty');
  const intent=visit(campaign,at(4));const p=page(intent,{screen:'recipe'});event(intent,'catalog_action',{pageId:p,screen:'recipe',action:'save_open'});
  const started=visit(campaign,at(5));page(started,{visible:false});outcome(started,'catalog_bot_started');
  const saved=visit(campaign,at(6));page(saved,{visible:false});outcome(saved,'catalog_recipe_saved','max');
  const both=visit(campaign,at(7));page(both,{screen:'recipe'});event(both,'catalog_save_intent');outcome(both,'catalog_bot_started');outcome(both,'catalog_recipe_saved');
  const r=report(campaign),c=counts(r);
  assert.equal(c.one_recipe,1);assert.equal(c.multiple_recipes,1);assert.equal(c.save_intent,1);assert.equal(c.bot_started,1);assert.equal(c.saved,2);
  assert.equal(c.empty_results,0);assert.equal(r.summary.recipeVisits,4);assert.equal(r.summary.saved,2);assert.equal(r.summary.starts,2);
  assert.equal(category(one),'one_recipe');assert.equal(category(many),'multiple_recipes');assert.equal(category(both),'saved');
  assert.equal(validCatalogDetailReport(r),true);
});

test('classification sees recipe opens, empty results, actions and card measurements beyond display truncation',()=>{
  const campaign='path-long';
  function longVisit(time){const v=visit(campaign,time);for(let n=0;n<25;n++){const p=page(v,{time:at(Date.parse(time)/1000-epoch/1000+n)});for(let j=0;j<3;j++)event(v,'catalog_section_visible',{pageId:p,screen:'list',section:'results'},at(Date.parse(time)/1000-epoch/1000+n));}return v;}
  const one=longVisit(at(0));page(one,{screen:'recipe',time:at(30)});
  const many=longVisit(at(100));page(many,{screen:'recipe',time:at(130)});page(many,{screen:'recipe',time:at(131)});
  const empty=longVisit(at(200));event(empty,'catalog_empty',{},at(230));
  const active=longVisit(at(300));event(active,'catalog_action',{pageId:randomUUID(),screen:'list',action:'pagination'},at(330));
  const deep=longVisit(at(400));page(deep,{cards:24,time:at(430)});
  const r=report(campaign),c=counts(r);
  assert.equal(c.one_recipe,1);assert.equal(c.multiple_recipes,1);assert.equal(c.empty_results,1);assert.equal(c.active_catalog,1);assert.equal(c.deep_catalog,1);
  assert.ok(r.visits.every(v=>v.eventsTruncated&&v.pagesTruncated));
  assert.ok(r.visits.every(v=>v.events.length===80&&v.pages.length===20));
  assert.ok(r.visits.every(v=>!v.events.some(e=>['catalog_open','catalog_empty','catalog_action'].includes(e.event))),'the limited timeline alone cannot classify these paths');
  assert.ok(r.visits.every(v=>v.pages.every(p=>p.cardsSeen===null)));
  assert.equal(category(one),'one_recipe');assert.equal(category(many),'multiple_recipes');assert.equal(validCatalogDetailReport(r),true);
});

test('group pagination retains full-cohort summary and stable global ordinals across interleaved paths',()=>{
  const campaign='path-pagination';
  for(let i=0;i<26;i++){const v=visit(campaign,at(i));page(v,{cards:i%2===0?3:15});}
  const all=report(campaign),first=report(campaign,{group:'brief_catalog'}),second=report(campaign,{group:'brief_catalog',page:2});
  assert.equal(all.totalVisits,26);assert.equal(first.totalVisits,13);assert.equal(second.totalVisits,13);
  assert.equal(first.visits.length,10);assert.equal(second.visits.length,3);assert.equal(report(campaign,{group:'brief_catalog',page:3}).visits.length,0);
  assert.deepEqual(first.summary,all.summary);assert.deepEqual(second.summary,all.summary);assert.deepEqual(first.groups,all.groups);
  assert.deepEqual([...first.visits,...second.visits].map(v=>v.number),[25,23,21,19,17,15,13,11,9,7,5,3,1]);
  assert.ok(first.visits.every(v=>v.group==='brief_catalog'));
  for(const v of all.visits.filter(v=>v.group==='brief_catalog'))assert.equal(first.visits.find(row=>row.startedAt===v.startedAt).number,v.number);
  assert.equal(validCatalogDetailReport(first),true);assert.equal(validCatalogDetailReport(second),true);
  const empty=report(campaign,{group:'saved'});assert.equal(empty.totalVisits,0);assert.equal(empty.summary.visits,26);assert.equal(validCatalogDetailReport(empty),true);
});

test('group membership honors cutoff, Moscow cohort dates, source, exact subject and internal exclusions',()=>{
  const campaign='path-scope',v=visit(campaign,'2026-10-01T20:59:59.000Z');page(v,{cards:3});page(v,{screen:'recipe',time:'2026-10-01T21:00:01.000Z'});
  outcome(v,'catalog_recipe_saved','max','2026-10-01T21:00:03.000Z');
  const early=report(campaign,{from:'2026-10-01',to:'2026-10-01'},'2026-10-01T21:00:00.000Z');assert.equal(early.visits[0].group,'brief_catalog');
  const middle=report(campaign,{from:'2026-10-01',to:'2026-10-01'},'2026-10-01T21:00:02.000Z');assert.equal(middle.visits[0].group,'one_recipe');
  const late=report(campaign,{from:'2026-10-01',to:'2026-10-01'});assert.equal(late.visits[0].group,'saved');
  assert.equal(report(campaign,{from:'2026-10-02',to:'2026-10-02'}).totalVisits,0);
  const internal=visit(campaign,at(10));page(internal,{cards:24});recordCatalogJourneyServer('catalog_bot_started',{...internal,platform:'telegram',isInternal:true,occurredAt:internal.time});
  const remoteOnly=visit(campaign,at(11));outcome(remoteOnly,'catalog_recipe_saved','max');
  const wrongSource=visit('path-other',at(12));page(wrongSource,{cards:24});
  recordProduct(null,'catalog_open',{visitor:randomUUID(),flowId:v.flowId,step:'catalog',detail:{journey:'recipe-first-v1'},at:'2026-10-01T20:59:59.000Z'});
  const final=report(campaign);assert.equal(final.totalVisits,1);assert.equal(counts(final).saved,1);assert.equal(final.summary.recipeVisits,1);
  assert.equal(counts(report(campaign,{},'2026-10-01T21:00:00.000Z')).brief_catalog,1,'another subject cannot add an opening to this flow');
  assert.equal(validCatalogDetailReport(final),true);
});

test('public retries keep exactly one opening and group while new event IDs remain separate observations',()=>{
  const v=visit('path-retries'),pageId=randomUUID(),base={id:randomUUID(),step:'catalog',flowId:v.flowId,journey:'recipe-first-v1',campaign:v.campaign,pageId,screen:'recipe'};
  const input={visitor:v.sessionId,events:[{...base,event:'catalog_page_started',navigation:'initial',viewport:'compact',pageNumber:1},{...base,id:randomUUID(),event:'catalog_open'}]};
  acceptProductEvents(null,input);acceptProductEvents(null,input);
  let r=catalogDetailReport({campaign:v.campaign});assert.equal(r.totalVisits,1);assert.equal(r.visits[0].group,'one_recipe');assert.equal(r.visits[0].events.filter(e=>e.event==='catalog_open').length,1);
  acceptProductEvents(null,{visitor:v.sessionId,events:[{...input.events[1],id:randomUUID(),pageId:randomUUID()}]});
  r=catalogDetailReport({campaign:v.campaign});assert.equal(r.visits[0].group,'multiple_recipes');assert.equal(validCatalogDetailReport(r),true);
});

test('MAX v2 checks exact group, full group totals, visit membership and privacy without recomputing truncated histories',async()=>{
  const local=report('path-long',{group:'multiple_recipes'}),remote={...local,platform:'max'};
  const scope={campaign:'path-long',platform:'max',group:'multiple_recipes'};
  const options={remoteEnabled:true,origin:'https://recipeboibot-max.89-223-123-75.sslip.io',token:'t'.repeat(43)};
  const transport=payload=>async(url)=>{assert.equal(new URL(url).searchParams.get('group'),'multiple_recipes');return new Response(JSON.stringify(payload));};
  assert.equal(validCatalogDetailReport(remote,scope),true);
  const good=await dashboardCatalogDetails(scope,{...options,transport:transport(remote)});assert.equal(good.status,'ready');assert.equal(good.summary.visits,5);assert.equal(good.totalVisits,1);assert.equal(good.visits[0].events.some(e=>e.event==='catalog_open'),false);
  const changes=[r=>r.version=1,r=>r.group='all',r=>r.groups[0].count++,r=>r.groups.pop(),r=>r.groups[1].id=r.groups[0].id,
    r=>r.groups[0].private='secret',r=>r.visits[0].group='one_recipe',r=>r.visits[0].number=0,r=>r.visits[0].recipeId='private',r=>r.totalVisits=5];
  for(const change of changes){const bad=structuredClone(remote);change(bad);assert.equal(validCatalogDetailReport(bad,scope),false);
    const result=await dashboardCatalogDetails(scope,{...options,transport:transport(bad)});assert.equal(result.status,'unavailable');assert.equal(result.groups,null);assert.equal(result.totalVisits,null);}
});
