import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
const file = `data/product-test-${randomUUID()}.sqlite`;
Object.assign(process.env,{DATABASE_PATH:file,TELEGRAM_BOT_TOKEN:'analytics-test',TELEGRAM_POLLING:'false',TEST_CONTOUR:'false',BOT_PLATFORM:'telegram',DINNER_LLM_ENABLED:'false',DINNER_IMAGES_ENABLED:'false',OPENAI_API_KEY:'disabled'});
const {db,upsertTelegramUser,allowUser,deleteUserData}=await import('../src/db.js');
const {createServer}=await import('../src/server.js');
const {recordProduct:record,acceptProductEvents:accept,productReport:report,productOperation,identifyProductUser,productMilestone,apiStep,validProductReport}=await import('../src/product-analytics.js');
const {recordEngagement}=await import('../src/recipe-engagement.js');
const {makeTelegramInitData}=await import('../src/security.js');
const {maxFunnelSnapshot}=await import('../src/max-funnel.js');
const {addDinnerEvent}=await import('../src/dinner-store.js');
let next=810000;
const user=()=>{const u=upsertTelegramUser({id:++next});allowUser(u.id);return u;};
const batch=(event='screen_view',step='home')=>({visitor:randomUUID(),events:[{id:randomUUID(),event,step,version:'product-1',session:randomUUID()}]});
test.after(()=>{db.close();for(const suffix of ['','-wal','-shm'])fs.rmSync(file+suffix,{force:true});});

test('bounded batches are atomic, idempotent, private and have no payload text',()=>{
 const u=user(),input=batch(); input.events[0].query='private dinner query';input.events[0].token='secret';
 assert.equal(accept(u.id,input).accepted.length,1);assert.equal(accept(u.id,input).accepted.length,1);
 assert.equal(report([u]).steps.find(r=>r.step==='home').viewed,1);
 const rows=db.prepare('SELECT * FROM product_events WHERE user_id=?').all(u.id);
 assert.equal(rows.length,1);assert.ok(!JSON.stringify(rows).includes('private dinner query'));assert.ok(!JSON.stringify(rows).includes('secret'));
 const invalid=batch();invalid.events.push({...invalid.events[0],id:randomUUID(),event:'payment_confirmed'});
 assert.throws(()=>accept(u.id,invalid));assert.equal(db.prepare('SELECT COUNT(*) n FROM product_events WHERE user_id=?').get(u.id).n,1);
 assert.throws(()=>accept(u.id,{events:Array(31).fill(input.events[0])}));
 assert.throws(()=>accept(null,input));
 deleteUserData(u.id);assert.equal(db.prepare('SELECT COUNT(*) n FROM product_events WHERE user_id=?').get(u.id).n,0);
});
test('public catalogue sessions never become bot use, and source filters do not claim anonymous visits',()=>{
 const u=user(),input=batch('catalog_open','catalog');accept(null,input);accept(null,input);
 assert.equal(report([u]).catalog.find(r=>r.event==='catalog_open').events,1);
 assert.equal(report([u]).catalog.find(r=>r.event==='catalog_open').visits,1);
 assert.equal(report([u],true).catalog,null);assert.equal(report([u]).steps.find(r=>r.step==='recipe').viewed,0);
 assert.throws(()=>accept(u.id,input));
});
test('source cohort and first acquisition date apply to new and legacy metrics',()=>{
 const u=user(),outside=user(),early='2026-10-01T10:00:00.000Z',late='2026-10-03T10:00:00.000Z';
 record(u.id,'screen_view',{step:'home',at:early});record(outside.id,'screen_view',{step:'home',at:late});
 record(u.id,'screen_view',{step:'offer',at:late});
 const result=report([{id:u.id,started_at:'2026-10-02T00:00:00.000Z'}],true);
 assert.equal(result.steps.find(r=>r.step==='home').viewed,0);assert.equal(result.steps.find(r=>r.step==='offer').viewed,1);
});

test('recently eaten remains a distinct private reason through cohort filters and the MAX bridge',()=>{
 const u=user(),outside=user(),early='2026-10-01T10:00:00.000Z',late='2026-10-03T10:00:00.000Z';
 for(const [account,at,reason] of [[u,early,'recently_ate'],[u,late,'recently_ate'],[outside,late,'recently_ate'],[u,late,'private-unregistered-reason']]){
  addDinnerEvent(account.id,'dinner_rejection_reason',{detail:{reason,title:'private dish title'}});
  db.prepare('UPDATE dinner_events SET created_at=? WHERE rowid=(SELECT MAX(rowid) FROM dinner_events WHERE user_id=?)').run(at,account.id);
 }
 const all=report([u]);
 assert.equal(all.reasons.recently_ate,2);assert.equal(all.reasons.other,1);
 assert.equal(report([{...u,started_at:'2026-10-02T00:00:00.000Z'}],true).reasons.recently_ate,1);
 assert.deepEqual(report([]).reasons,{});
 assert.ok(!JSON.stringify(all).includes('private dish title'));
 assert.ok(!JSON.stringify(all).includes('private-unregistered-reason'));
 const snapshot=maxFunnelSnapshot(),platform=snapshot.all.productAnalytics.platforms[0];
 assert.ok(platform.reasons.recently_ate>=2);
 assert.equal(validProductReport(platform,{legacy:snapshot.version===6}),true);
});
test('D1 and D7 use completed Moscow target days and count each account once',()=>{
 const u=user(),fresh=user();
 for(const at of ['2026-10-01T20:59:00Z','2026-10-01T21:01:00Z','2026-10-02T09:00:00Z','2026-10-07T21:01:00Z'])recordEngagement(u.id,'recipe_opened',{at});
 recordEngagement(fresh.id,'recipe_opened',{at:'2026-10-08T09:00:00Z'});
 let rows=report([u,fresh],false,'2026-10-08T20:59:00Z').retention;
 const first=rows.find(r=>r.date==='2026-10-01');assert.equal(first.d1Eligible,1);assert.equal(first.d1,1);assert.equal(first.d7Eligible,0);assert.equal(first.d7Rate,null);
 rows=report([u,fresh],false,'2026-10-08T21:00:00Z').retention;
 assert.equal(rows.find(r=>r.date==='2026-10-01').d7Rate,100);assert.equal(rows.find(r=>r.date==='2026-10-08').d1Eligible,0);
});
test('abandonment requires a day and a missing subsequent action on the same step',()=>{
 const u=user(),v=user();record(u.id,'screen_view',{step:'household',at:'2026-10-01T00:00:00Z'});record(v.id,'screen_view',{step:'household',at:'2026-10-01T00:00:00Z'});
 record(v.id,'step_submit',{step:'household',at:'2026-10-01T00:01:00Z'});
 assert.equal(report([u,v],false,'2026-10-01T23:59:00Z').steps.find(r=>r.step==='household').inactive,0);
 assert.equal(report([u,v],false,'2026-10-02T00:01:00Z').steps.find(r=>r.step==='household').inactive,1);
 record(u.id,'screen_view',{step:'time',at:'2026-10-01T00:02:00Z'});
 assert.equal(report([u,v],false,'2026-10-02T00:01:00Z').steps.find(r=>r.step==='household').inactive,0,'moving to another step is progress');
 record(u.id,'screen_view',{step:'collection',at:'2026-10-01T00:03:00Z'});
 recordEngagement(u.id,'recipe_opened',{at:'2026-10-01T00:04:00Z'});
 assert.equal(report([u],false,'2026-10-02T00:05:00Z').steps.find(r=>r.step==='collection').inactive,0,'reading a saved recipe is progress without posting a form');
});
test('operation context isolates concurrent users and links delivery without exposing messages',async()=>{
 const a=user(),b=user();
 await Promise.all([a,b].map(u=>productOperation('request',async c=>{identifyProductUser(u.id);await new Promise(r=>setTimeout(r,5));productMilestone('recipe_delivered');if(u===b)c.status=402;})));
 const ra=report([a]),rb=report([b]);assert.equal(ra.steps.find(r=>r.step==='request').errors,0);assert.equal(rb.steps.find(r=>r.step==='request').errors,1);
 assert.equal(ra.timing.delivered.samples,1);assert.equal(rb.timing.delivered.samples,1);
 const rows=db.prepare('SELECT flow_id FROM product_events WHERE user_id=?').all(a.id);assert.equal(new Set(rows.map(r=>r.flow_id)).size,1);
 assert.equal(apiStep('/api/engagement'),null);assert.equal(apiStep('/api/billing/orders'),'checkout');
});
test('health snapshots retain retry and loss diagnostics without summing cumulative snapshots twice',()=>{
 const u=user(),session=randomUUID();for(const dropped of [2,3]){const input=batch('telemetry_health');Object.assign(input.events[0],{dropped,pending:4,session});accept(u.id,input);}
 const input=batch('client_error');Object.assign(input.events[0],{attempts:3,code:'network'});accept(u.id,input);
 const result=report([u]).health;assert.equal(result.dropped,3);assert.equal(result.pending,4);assert.equal(result.retried,1);assert.equal(result.clientErrors,1);
});
test('MAX aggregate validates extended analytics and never exports identities',()=>{
 const snapshot=maxFunnelSnapshot();assert.equal(snapshot.version,8);
 const result=snapshot.all.productAnalytics.platforms[0];assert.equal(validProductReport(result),true);
 assert.equal(validProductReport({...result,retention:[{date:'2026-10-01',users:1,d1Eligible:0,d1:1,d7Eligible:0,d7:0,d1Rate:100,d7Rate:null}]}),false);
 assert.equal(validProductReport({...result,user_id:'private'}),false);
 assert.equal(validProductReport({...result,catalogBenefits:undefined}),false);
 assert.equal(validProductReport({...result,catalogBenefits:{...result.catalogBenefits,ctas:result.catalogBenefits.views+1}}),false);
 assert.equal(validProductReport({...result,catalogBenefits:{...result.catalogBenefits,ctr:101}}),false);
 assert.ok(!JSON.stringify(snapshot).includes('detail_json'));
});

test('benefits telemetry requires a public catalog flow and bounded action duration',()=>{
 const u=user(),input=batch('benefits_view','catalog');input.events[0].flowId=randomUUID();
 assert.equal(accept(null,input).accepted.length,1);assert.equal(accept(null,input).accepted.length,1);
 assert.throws(()=>accept(u.id,input));
 for(const changes of [{flowId:null},{step:'benefits'},{event:'benefits_cta'},{event:'benefits_close',durationMs:-1},{event:'benefits_close',durationMs:86400001}]){
  assert.throws(()=>accept(null,{...input,events:[{...input.events[0],id:randomUUID(),...changes}]}));
 }
 const action={...input.events[0],id:randomUUID(),event:'benefits_cta',durationMs:20,url:'https://private.example',query:'private search'};
 accept(null,{...input,events:[action]});
 const saved=db.prepare('SELECT * FROM product_events WHERE subject=?').all('v:'+input.visitor);
 assert.equal(saved.length,2);assert.ok(!JSON.stringify(saved).includes('private'));
 db.prepare('DELETE FROM product_events WHERE subject=?').run('v:'+input.visitor);
});

test('benefits CTR counts visible flows, matches subjects and excludes missing or earlier views',()=>{
 const a=randomUUID(),b=randomUUID(),one=randomUUID(),two=randomUUID(),orphan=randomUUID();
 const add=(visitor,event,flowId,at,durationMs=null)=>record(null,event,{visitor,flowId,step:'catalog',at:'2026-10-13T10:00:'+at+'.000Z',durationMs});
 add(a,'benefits_view',one,'00');add(a,'benefits_view',one,'01');
 add(a,'benefits_cta',one,'02',2000);add(a,'benefits_cta',one,'03',3000);
 add(a,'benefits_view',two,'04');add(a,'benefits_close',two,'05',1000);
 add(a,'benefits_cta',orphan,'06',1000);add(b,'benefits_cta',one,'06',1000);
 const before=report([]).catalogBenefits;
 assert.equal(before.views,2);assert.equal(before.visits,1);assert.equal(before.closes,1);assert.equal(before.ctas,1);assert.equal(before.ctr,50);
 assert.equal(before.ctaTiming.samples,1);assert.equal(before.ctaTiming.p50,2000);assert.equal(before.unmatchedActions,2);
 add(a,'benefits_view',orphan,'07');
 assert.equal(report([]).catalogBenefits.ctas,1,'an earlier action is not a conversion of a later view');
 assert.equal(report([],true).catalogBenefits,null);assert.deepEqual(report([user()]).catalogBenefits,report([]).catalogBenefits,'anonymous internal traffic cannot be filtered using account cohort');
 db.prepare('DELETE FROM product_events WHERE subject IN (?,?)').run('v:'+a,'v:'+b);
 assert.equal(report([]).catalogBenefits.ctr,null);
});
test('payment journey binds the actual reused order and excludes unrelated and test payments',()=>{
 const u=user(),id=randomUUID();
 const insert=(key,status,test,paid)=>db.prepare(`INSERT INTO payment_orders(id,user_id,experiment_key,variant,amount_kopeks,kind,status,created_at,updated_at,paid_at,is_test)
 VALUES(?,?,'analytics','A',19900,'initial',?,'2026-10-01T00:00:00Z','2026-10-02T00:00:00Z',?,?)`).run(key,u.id,status,paid,test);
 insert(id,'pending',0,null);insert(randomUUID(),'paid',0,'2026-10-03T00:00:00Z');
 record(u.id,'checkout_requested',{step:'checkout',at:'2026-10-01T00:00:00Z'});
 record(u.id,'screen_view',{step:'offer',at:'2026-10-02T00:00:00Z'});
 assert.deepEqual(report([u]).checkout.ordered,[1,0,0,0,0]);
 record(u.id,'checkout_requested',{step:'checkout',at:'2026-10-02T00:01:00Z'});
 record(u.id,'order_ready',{step:'checkout',at:'2026-10-02T00:02:00Z',detail:{orderId:id}});
 record(u.id,'provider_handoff',{step:'checkout',at:'2026-10-02T00:03:00Z',detail:{orderId:id}});
 assert.deepEqual(report([u]).checkout.ordered,[1,1,1,1,0]);
 db.prepare("UPDATE payment_orders SET status='paid',paid_at='2026-10-03T00:00:00Z' WHERE id=?").run(id);
 assert.deepEqual(report([u]).checkout.ordered,[1,1,1,1,1]);
 db.prepare('UPDATE payment_orders SET is_test=1 WHERE id=?').run(id);
 assert.deepEqual(report([u]).checkout.ordered,[1,1,0,0,0]);
});
test('queued client event age preserves occurrence before a later server action',()=>{
 const u=user(),input=batch('screen_view','offer');input.events[0].ageMs=60000;
 const now=Date.now();accept(u.id,input);const row=db.prepare('SELECT created_at FROM product_events WHERE user_id=?').get(u.id);
 assert.ok(Date.parse(row.created_at)<=now-59000);assert.ok(Date.parse(row.created_at)>=now-61000);
});
test('HTTP telemetry authenticates private batches and limits public input and cross-origin requests',async()=>{
 const u=user(),server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}`;
 const auth='tma '+makeTelegramInitData({id:Number(u.telegram_id)},'analytics-test');
 try{
  const post=(path,input,headers={})=>fetch(url+path,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(input)});
  assert.equal((await post('/api/analytics',batch())).status,401);
  const input=batch();assert.equal((await post('/api/analytics',input,{authorization:auth})).status,200);
  const pub=batch('catalog_open','catalog');assert.equal((await post('/api/analytics/public',pub)).status,403);
  assert.equal((await post('/api/analytics/public',pub,{'x-analytics-request':'1',origin:'https://attacker.example'})).status,403);
  assert.equal((await post('/api/analytics/public',pub,{'x-analytics-request':'1'})).status,200);
  assert.equal((await post('/api/analytics/public',{...pub,events:[{...pub.events[0],durationMs:-1}]},{'x-analytics-request':'1'})).status,400);
 }finally{await new Promise(r=>server.close(r));}
});
test('browser timing waits for animation visibility and signed receipt retries preserve their ID',async()=>{
 let visible=false,timer,receiptAttempts=0;const listeners={},storage=new Map(),events=[],receiptIds=[];
 const element={isConnected:true,getBoundingClientRect:()=>({left:0,top:0,right:100,bottom:100}),contains:()=>true};
 const sandbox={location:{pathname:'/'},crypto:{randomUUID},Date,Promise,AbortSignal,navigator:{onLine:true},innerWidth:400,innerHeight:800,
   sessionStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)},
   window:{addEventListener(){},RecipePlatform:{authHeader:()=> 'tma test'}},
   document:{visibilityState:'visible',elementFromPoint:()=>element,addEventListener:(name,fn)=>{listeners[name]=fn;}},
   getComputedStyle:()=>({visibility:'visible',opacity:visible?'1':'0'}),
   requestAnimationFrame:fn=>fn(),setInterval(){},clearTimeout(){},setTimeout:fn=>{timer=fn;return 1;},
   fetch:async(path,options)=>{const body=JSON.parse(options.body);if(path==='/api/engagement'){receiptIds.push(body.eventId);if(++receiptAttempts<3)throw Error('offline');return {ok:true};}
     events.push(...body.events);return {ok:true,json:async()=>({accepted:body.events.map(r=>r.id)})};}
 };
 vm.createContext(sandbox);vm.runInContext(fs.readFileSync('public/analytics.js','utf8'),sandbox);
 const api=sandbox.window.RecipeAnalytics;api.setUser('test-user');api.requestStarted('flow_identifier_123','request');api.requestVisible(element,'flow_identifier_123');
 await timer();assert.equal(events.some(r=>r.event==='request_visible'),false);
 visible=true;listeners.animationend();await timer();assert.equal(events.filter(r=>r.event==='request_visible').length,1);
 listeners.transitionend();await timer();assert.equal(events.filter(r=>r.event==='request_visible').length,1);
 api.receipt({eventId:randomUUID(),token:'signed-test-receipt'});await timer();await timer();await timer();await timer();
 assert.equal(receiptIds.length,3);assert.equal(new Set(receiptIds).size,1);assert.ok(events.some(r=>r.event==='telemetry_receipt'&&r.recoveredAttempts===3));
});

test('public benefits queue retries original event and flow IDs without storage or network',async()=>{
 let timer,online=false;const sent=[];
 const sandbox={location:{pathname:'/recipes'},crypto:{randomUUID},Date,Promise,AbortSignal,navigator:{onLine:true},innerWidth:390,innerHeight:844,
  sessionStorage:{getItem(){throw Error('disabled');},setItem(){throw Error('disabled');}},window:{addEventListener(){}},
  document:{visibilityState:'visible',addEventListener(){}},requestAnimationFrame:fn=>fn(),setInterval(){},clearTimeout(){},setTimeout:fn=>{timer=fn;return 1;},
  fetch:async(path,options)=>{assert.equal(path,'/api/analytics/public');const body=JSON.parse(options.body);sent.push(body);if(!online)throw Error('offline');return {ok:true,json:async()=>({accepted:body.events.map(r=>r.id)})};}
 };
 vm.createContext(sandbox);vm.runInContext(fs.readFileSync('public/analytics.js','utf8'),sandbox);
 const api=sandbox.window.RecipeAnalytics,flowId=randomUUID();
 api.event('benefits_view','catalog',{flowId});api.event('benefits_cta','catalog',{flowId,durationMs:500});
 await timer();online=true;await timer();
 const first=sent[0].events.filter(r=>r.event.startsWith('benefits_')),retry=sent[1].events.filter(r=>r.event.startsWith('benefits_'));
 assert.equal(first.length,2);assert.deepEqual(first.map(r=>r.id),retry.map(r=>r.id));assert.ok(retry.every(r=>r.flowId===flowId&&r.attempts===2));
 assert.ok(sent[0].events.some(r=>r.event==='telemetry_health'&&r.code==='storage'));
 api.health();await timer();assert.equal(sent.at(-1).events.some(r=>r.event.startsWith('benefits_')),false,'accepted events leave the in-memory queue');
 for(let i=0;i<85;i++)api.event('benefits_view','catalog',{flowId:randomUUID()});
 api.health();
 for(let i=0;i<4;i++)await timer();
 assert.ok(sent.at(-1).events.some(r=>r.event==='telemetry_health'&&r.dropped>=5),'bounded queue exposes lost events');
});
