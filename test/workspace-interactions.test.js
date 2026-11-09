import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';

const file=`data/workspace-interactions-${randomUUID()}.sqlite`;
Object.assign(process.env,{DATABASE_PATH:file,TELEGRAM_BOT_TOKEN:'workspace-interactions-local',TELEGRAM_POLLING:'false',TEST_CONTOUR:'true',BOT_PLATFORM:'telegram',DINNER_LLM_ENABLED:'false',DINNER_IMAGES_ENABLED:'false',OPENAI_API_KEY:'disabled'});
const {db,upsertTelegramUser,allowUser}=await import('../src/db.js');
const since=new Date(Date.now()-86400000).toISOString();
db.exec('CREATE TABLE IF NOT EXISTS product_analytics_metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
db.prepare("INSERT INTO product_analytics_metadata VALUES('workspace_interactions_since',?)").run(since);
const {recordProduct:record,acceptProductEvents:accept,productReport:report,workspaceInteractionsTrackingSince}=await import('../src/product-analytics.js');
const {workspaceInteractionOutcomes,workspaceInteractionReport,validWorkspaceInteractions,validWorkspaceReport,workspaceReport}=await import('../src/workspace-analytics.js');
const {funnelReport,recordBotStart,createCampaign}=await import('../src/funnel.js');
const {maxFunnelSnapshot,mergeMaxFunnelReport}=await import('../src/max-funnel.js');
const {analyticsExcludedIds}=await import('../src/analytics-exclusions.js');
let serial=972000;
const user=id=>{const value=upsertTelegramUser({id:id||++serial});allowUser(value.id);return value;};
const at=offset=>new Date(Date.parse(since)+offset).toISOString();
const row=(extra={})=>({id:randomUUID(),event:'workspace_interaction',step:'other',kind:'groceries_preview',outcome:'started',flowId:randomUUID(),...extra});
const batch=(...events)=>({visitor:randomUUID(),events});
const emit=(u,kind,outcome,flowId,extra={})=>record(u?.id||null,'workspace_interaction',{visitor:u?null:randomUUID(),step:'other',flowId,durationMs:outcome==='started'?null:250,detail:{kind,outcome},at:at(1000),...extra});
test.after(()=>{db.close();for(const suffix of['','-wal','-shm'])fs.rmSync(file+suffix,{force:true});});

test('interaction intake has closed private kinds/outcomes/fields and rejects an entire invalid batch',()=>{
  const u=user();
  for(const [kind,outcomes] of Object.entries(workspaceInteractionOutcomes))for(const outcome of outcomes){const event=row({kind,outcome,durationMs:outcome==='started'?undefined:50});assert.equal(accept(u.id,batch(event)).accepted.length,1);assert.equal(accept(u.id,batch(event)).accepted.length,1);}
  const count=db.prepare('SELECT COUNT(*) n FROM product_events WHERE user_id=?').get(u.id).n;
  const invalid=[{kind:'recipes'},{kind:'groceries_preview',outcome:'copied'},{kind:'groceries_share',outcome:'visible'},
    {outcome:'delivered'},{step:'recipe'},{flowId:'not-random'},{durationMs:-1},{durationMs:86400001},{durationMs:1.5},
    {outcome:'visible'},{outcome:'error',durationMs:1,code:'http'}];
  for(const field of['feature','action','name','recipeId','ingredients','ingredientKeys','servings','url','recipient','question','note','selection','presentation'])invalid.push({[field]:'private'});
  for(const change of invalid)assert.throws(()=>accept(u.id,batch(row(),row(change))),{status:400});
  assert.throws(()=>accept(null,batch(row())),{status:400});
  assert.equal(db.prepare('SELECT COUNT(*) n FROM product_events WHERE user_id=?').get(u.id).n,count);
  assert.ok(db.prepare('SELECT detail_json FROM product_events WHERE user_id=?').all(u.id).every(entry=>!entry.detail_json.includes('private')));
  assert.equal(record(u.id,'workspace_saved',{step:'other',flowId:randomUUID(),durationMs:1,detail:{kind:'groceries_share',outcome:'copied'}}),false);
});

test('interaction aggregation deduplicates account/kind/flow/outcome and never increases recipe latency, opens or saves',()=>{
  const u=user(),other=user(),flow=randomUUID(),orphan=randomUUID();
  const before=report([u,other]);
  emit(u,'groceries_preview','visible',flow,{durationMs:250,at:at(1100)});
  emit(u,'groceries_preview','started',flow,{at:at(1200)}); // Offline queue may arrive out of order.
  emit(u,'groceries_preview','visible',flow,{durationMs:900,at:at(1300)});
  emit(other,'groceries_preview','visible',flow);
  emit(u,'groceries_share','started',flow);
  for(const outcome of['copied','handed_off','manual_copy_shown','cancelled','error'])emit(u,'groceries_share',outcome,flow);
  emit(u,'groceries_share','copied',flow);emit(other,'groceries_share','copied',orphan);
  emit(u,'groceries_preview','started',randomUUID(),{at:at(-1)});
  const after=report([u,other]),interactions=after.workspace.interactions;
  assert.deepEqual(interactions.kinds.groceries_preview,{started:1,visible:2,matchedVisible:1,cancelled:0,errors:0,unmatchedOutcomes:1,visibleTiming:{samples:1,p50:250,p95:250}});
  assert.deepEqual(interactions.kinds.groceries_share,{started:1,copied:2,handedOff:1,manualCopyShown:1,cancelled:1,errors:1,unmatchedOutcomes:1});
  assert.equal(validWorkspaceInteractions(interactions),true);
  assert.deepEqual(after.latency,before.latency);assert.deepEqual(after.timing,before.timing);
  assert.deepEqual(after.steps.find(entry=>entry.step==='recipe'),before.steps.find(entry=>entry.step==='recipe'));
  assert.deepEqual(after.workspace.features,before.workspace.features);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM recipe_engagement WHERE user_id IN (?,?)").get(u.id,other.id).n,0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM product_events WHERE user_id IN (?,?) AND event IN ('workspace_saved','request_started','request_visible','screen_view')").get(u.id,other.id).n,0);
});

test('interaction start persists, historical events stay excluded and source/private cohort filters apply',async()=>{
  assert.equal(workspaceInteractionsTrackingSince(),since);
  const reloaded=await import('../src/product-analytics.js?interactions-reload='+randomUUID());assert.equal(reloaded.workspaceInteractionsTrackingSince(),since);
  const u=user(),outside=user(),flow=randomUUID();
  emit(u,'groceries_preview','started',flow,{at:at(100)});emit(u,'groceries_preview','visible',flow,{at:at(300)});
  emit(outside,'groceries_preview','started',randomUUID(),{at:at(300)});
  const scoped=report([{...u,started_at:at(200)}],true).workspace.interactions.kinds.groceries_preview;
  assert.equal(scoped.started,0);assert.equal(scoped.visible,1);assert.equal(scoped.matchedVisible,0);
  const campaign=createCampaign('interaction-source-test').slug,included=user(),excluded=[...analyticsExcludedIds,'private-test:interaction'].map(user);
  for(const account of[included,...excluded]){const token=randomUUID();db.prepare('INSERT INTO acquisition_clicks(token,campaign,created_at) VALUES(?,?,?)').run(token,campaign,at(100));recordBotStart(account,'/start ad_'+token,new Date(at(200)));const id=randomUUID();emit(account,'groceries_preview','started',id,{at:at(300)});emit(account,'groceries_preview','visible',id,{at:at(500)});}
  const result=funnelReport(campaign).productAnalytics.platforms.find(p=>p.platform==='telegram').workspace.interactions;
  assert.equal(result.kinds.groceries_preview.started,1);assert.equal(result.kinds.groceries_preview.matchedVisible,1);
  assert.ok(!JSON.stringify(result).includes('private-test'));
  const old=workspaceInteractionReport([{event:'workspace_interaction',user_id:u.id,step:'other',flow_id:randomUUID(),created_at:at(-1),duration_ms:0,detail_json:'{"kind":"groceries_preview","outcome":"started"}'}],since);
  assert.equal(old.kinds.groceries_preview.started,0);
});

test('exact bridge schema accepts nullable legacy interactions and rejects invalid counters, timing and payloads',async()=>{
  const empty=workspaceInteractionReport([],since),summary=workspaceReport([],since,since);assert.equal(validWorkspaceReport(summary),true);
  for(const change of[
    r=>{r.query='private';},r=>{r.kinds.groceries_share.recipient='private';},r=>{r.kinds.groceries_preview.started=-1;},
    r=>{r.kinds.groceries_preview.matchedVisible=1;},r=>{r.kinds.groceries_preview.visibleTiming.samples=1;},
    r=>{r.kinds.groceries_preview.visibleTiming.p50=0;},r=>{r.kinds.groceries_share.copied=1.5;},
    r=>{r.kinds.groceries_share.unmatchedOutcomes=1;},r=>{r.trackingSince='unknown';},r=>{delete r.kinds.groceries_share;}
  ]){const value=structuredClone(empty);change(value);assert.equal(validWorkspaceInteractions(value),false);assert.equal(validWorkspaceReport({...summary,interactions:value}),false);}
  const snapshot=maxFunnelSnapshot(),options={enabled:true,origin:'https://recipeboibot-max.89-223-123-75.sslip.io',token:'a'.repeat(43)};
  const merge=value=>mergeMaxFunnelReport(funnelReport('all'),{...options,transport:async()=>Response.json(value)});
  let merged=await merge(snapshot);assert.equal(merged.remoteFunnel.status,'ready');assert.deepEqual(merged.productAnalytics.platforms.find(p=>p.platform==='max').workspace.interactions,snapshot.all.productAnalytics.platforms[0].workspace.interactions);
  const legacy=structuredClone(snapshot);for(const scope of['all','campaign'])delete legacy[scope].productAnalytics.platforms[0].workspace.interactions;
  merged=await merge(legacy);assert.equal(merged.remoteFunnel.status,'ready');assert.equal(merged.productAnalytics.platforms.find(p=>p.platform==='max').workspace.interactions,null);
  const invalid=structuredClone(snapshot);invalid.all.productAnalytics.platforms[0].workspace.interactions.kinds.groceries_share.delivered=1;assert.equal((await merge(invalid)).remoteFunnel.status,'error');
});

test('actual client observer waits for visible preview/manual text and retries the same event ID without private payloads',async()=>{
  const u=user(),flow=randomUUID(),share=randomUUID(),storage=new Map(),listeners={},sent=[];let timer,hit=false,online=false;
  const element={isConnected:true,getBoundingClientRect:()=>({left:0,top:0,right:300,bottom:300}),contains:()=>hit};
  const sandbox={location:{pathname:'/'},crypto:{randomUUID},Date,Promise,AbortSignal,navigator:{onLine:true},innerWidth:400,innerHeight:800,
    sessionStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)},window:{addEventListener(){},RecipePlatform:{authHeader:()=> 'tma fixture'}},
    document:{visibilityState:'hidden',elementFromPoint:()=>element,addEventListener:(name,fn)=>{listeners[name]=fn;}},getComputedStyle:()=>({visibility:'visible',opacity:'1'}),
    requestAnimationFrame:fn=>fn(),setInterval(){},clearTimeout(){},setTimeout:fn=>{timer=fn;return 1;},fetch:async(_path,options)=>{const body=JSON.parse(options.body);sent.push(...body.events);if(!online)throw Error('offline');return{ok:true,json:async()=>accept(u.id,body)};}};
  vm.createContext(sandbox);vm.runInContext(fs.readFileSync('public/analytics.js','utf8'),sandbox);const api=sandbox.window.RecipeAnalytics;
  api.setUser(u.id);api.event('workspace_interaction','other',{kind:'groceries_preview',outcome:'started',flowId:flow});
  api.observe(element,'workspace_interaction','other',{kind:'groceries_preview',outcome:'visible',flowId:flow,_started:Date.now()-100});
  await timer();assert.equal(sent.some(event=>event.outcome==='visible'),false);
  sandbox.document.visibilityState='visible';listeners.visibilitychange();await timer();assert.equal(sent.some(event=>event.outcome==='visible'),false);
  hit=true;listeners.animationend();await timer();const first=sent.find(event=>event.outcome==='visible');assert.ok(first);
  online=true;await timer();assert.equal(new Set(sent.filter(event=>event.outcome==='visible').map(event=>event.id)).size,1);
  api.event('workspace_interaction','other',{kind:'groceries_share',outcome:'started',flowId:share});
  api.observe(element,'workspace_interaction','other',{kind:'groceries_share',outcome:'manual_copy_shown',flowId:share,_started:Date.now()-20});await timer();
  const actual=report([u]);assert.equal(actual.workspace.interactions.kinds.groceries_preview.matchedVisible,1);assert.equal(actual.workspace.interactions.kinds.groceries_share.manualCopyShown,1);assert.equal(actual.workspace.interactions.kinds.groceries_share.copied,0);
  assert.equal(actual.latency.started,0);assert.equal(actual.timing.visible.samples,0);assert.equal(sent.some(event=>JSON.stringify(event).includes('private')),false);
  // The shared queue remains unchanged; the test-only emitter constructs a
  // closed payload and the authenticated server schema rejects extra fields.
  // Public acceptance is covered by the strict endpoint contract above.
});
