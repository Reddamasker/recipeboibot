import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {createWebLoginStore} from '../src/web-login-store.js';

const owner='1234567',foreign='7654321',hash=s=>createHash('sha256').update(s).digest('hex');
function fixture(t,options={}) {
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  let clock=Date.parse('2026-10-14T12:00:00Z');
  const config={ownerId:owner,now:()=>clock,requestTtl:1000,sessionTtl:5000,...options};
  const store=createWebLoginStore(db,config);
  return {db,store,config,advance(ms){clock+=ms;},request(){const request=store.begin();return {...request,id:store.resolveBotToken(request.bot,owner)};}};
}
function approve(store,request) {
  assert.equal(store.delivered(request.id,owner,'message-1'),true);
  assert.equal(store.decide(request.id,owner,'message-1',true),true);
}

test('credentials are random and hashed, diagnostics expose no request, actor or browser identifiers',t=>{
  const {db,store,request}=fixture(t),r=request();
  assert.match(r.browser,/^[\w-]{43}$/);assert.match(r.bot,/^[\w-]{43}$/);assert.notEqual(r.browser,r.bot);
  let row=db.prepare('SELECT * FROM web_login_prototype_requests').get();
  assert.equal(row.owner_id,owner);assert.equal(row.browser_hash,hash(r.browser));assert.equal(row.bot_hash,hash(r.bot));assert.notEqual(row.id,row.diagnostic_id);
  assert.equal(store.prompt(r.id,owner).code,r.code);approve(store,r);const result=store.finish(r.browser);
  assert.equal(db.prepare('SELECT secret_hash FROM web_login_prototype_sessions').get().secret_hash,hash(result.session));
  const snapshot=JSON.stringify({requests:db.prepare('SELECT * FROM web_login_prototype_requests').all(),sessions:db.prepare('SELECT * FROM web_login_prototype_sessions').all()});
  for(const value of [r.browser,r.bot,result.session])assert.ok(!snapshot.includes(value));
  const report=JSON.stringify(store.report());
  for(const value of [owner,r.id,row.diagnostic_id,r.browser,r.bot,result.session,r.code,'message-1'])assert.ok(!report.includes(value));
  assert.deepEqual(store.session(result.session),{authenticated:true,scope:'prototype-only',expiresAt:result.expiresAt});
});

test('foreign actor, wrong message, wrong browser and nonboolean decisions cannot authorize a session',t=>{
  const {store,request}=fixture(t),r=request(),other=store.begin();
  assert.equal(store.resolveBotToken(r.bot,foreign),null);assert.equal(store.prompt(r.id,foreign),null);
  assert.equal(store.delivered(r.id,foreign,'message-1'),false);
  assert.equal(store.decide(r.id,owner,'message-1',true),false,'undelivered prompt cannot be approved');
  assert.equal(store.delivered(r.id,owner,'message-1'),true);
  assert.equal(store.decide(r.id,foreign,'message-1',true),false);
  assert.equal(store.decide(r.id,owner,'other-message',true),false);
  assert.equal(store.decide(r.id,owner,'message-1','false'),false);
  assert.throws(()=>store.finish(other.browser),{status:409});assert.throws(()=>store.finish('invalid'),{status:409});
  assert.equal(store.decide(r.id,owner,'message-1',true),true);assert.throws(()=>store.finish(other.browser),{status:409});
  assert.ok(store.finish(r.browser).session);
});

test('delivered token, repeated callbacks and consumed browser cannot be replayed',t=>{
  const {store,request,db}=fixture(t),r=request();
  assert.equal(store.resolveBotToken(r.bot,owner),r.id);
  approve(store,r);
  assert.equal(store.resolveBotToken(r.bot,owner),null);assert.equal(store.prompt(r.id,owner),null);
  assert.equal(store.delivered(r.id,owner,'other-message'),false);
  assert.equal(store.decide(r.id,owner,'message-1',true),false);assert.equal(store.decide(r.id,owner,'message-1',false),false);
  store.finish(r.browser);assert.throws(()=>store.finish(r.browser),{status:409});
  assert.equal(db.prepare('SELECT COUNT(*) n FROM web_login_prototype_sessions').get().n,1);
  const report=store.report();assert.equal(report.delivered,1);assert.equal(report.approvedTotal,1);assert.equal(report.counts.consumed,1);
});

test('denial is final and never creates a session or counts as approval',t=>{
  const {store,request,advance}=fixture(t),r=request();
  store.delivered(r.id,owner,'message-1');assert.equal(store.decide(r.id,owner,'message-1',false),true);
  assert.equal(store.decide(r.id,owner,'message-1',true),false);assert.throws(()=>store.finish(r.browser),{status:409});
  advance(1001);assert.equal(store.state(r.browser).state,'denied');assert.equal(store.report().approvedTotal,0);
});

for(const phase of ['pending','offered','approved'])test(`${phase} request expires at absolute deadline without polling extending it`,t=>{
  const {store,request,advance}=fixture(t),r=request();
  if(phase!=='pending')store.delivered(r.id,owner,'message-1');
  if(phase==='approved')store.decide(r.id,owner,'message-1',true);
  advance(999);assert.equal(store.state(r.browser).state,phase);assert.equal(store.state(r.browser).expiresAt,r.expiresAt);
  advance(1);assert.equal(store.state(r.browser).state,'expired');assert.equal(store.resolveBotToken(r.bot,owner),null);
  assert.equal(store.decide(r.id,owner,'message-1',true),false);assert.throws(()=>store.finish(r.browser),{status:409});
  assert.equal(store.report().approvedTotal,phase==='approved'?1:0,'approval history survives expiration');
});

test('session has absolute lifetime, logout revokes it and cancels the pending browser request',t=>{
  const {store,request,advance}=fixture(t),r=request();approve(store,r);const auth=store.finish(r.browser);
  advance(4999);assert.equal(store.session(auth.session).expiresAt,auth.expiresAt);
  advance(1);assert.equal(store.session(auth.session),null);
  const next=request();approve(store,next);const auth2=store.finish(next.browser),pending=request();
  store.logout(auth2.session,pending.browser);store.logout(auth2.session,pending.browser);
  assert.equal(store.session(auth2.session),null);assert.equal(store.state(pending.browser).state,'cancelled');
  assert.equal(store.resolveBotToken(pending.bot,owner),null);assert.throws(()=>store.finish(pending.browser),{status:409});
});

test('begin atomically replaces a browser request and restores it when insertion fails',t=>{
  const {db,store,request}=fixture(t),r=request();
  db.exec("CREATE TRIGGER block_login_insert BEFORE INSERT ON web_login_prototype_requests BEGIN SELECT RAISE(ABORT,'test insert failure'); END;");
  assert.throws(()=>store.begin(r.browser),/test insert failure/);
  assert.equal(store.state(r.browser).state,'pending');assert.equal(store.resolveBotToken(r.bot,owner),r.id);
  db.exec('DROP TRIGGER block_login_insert');
  const next=store.begin(r.browser);assert.equal(store.state(r.browser).state,'cancelled');assert.equal(store.state(next.browser).state,'pending');
  assert.notEqual(next.browser,r.browser);assert.equal(store.resolveBotToken(r.bot,owner),null);
});

test('session insertion failure rolls back request consumption and allows a later valid finish',t=>{
  const {db,store,request}=fixture(t),r=request();approve(store,r);
  db.exec("CREATE TRIGGER block_session_insert BEFORE INSERT ON web_login_prototype_sessions BEGIN SELECT RAISE(ABORT,'test session failure'); END;");
  assert.throws(()=>store.finish(r.browser),/test session failure/);assert.equal(store.state(r.browser).state,'approved');
  db.exec('DROP TRIGGER block_session_insert');assert.ok(store.finish(r.browser).session);
  assert.equal(store.report().counts.consumed,1);
});

test('owner rotation revokes old sessions/requests, isolates diagnostics and disables stale store objects',t=>{
  const {db,store,request,config}=fixture(t),active=request(),r=request();approve(store,r);const auth=store.finish(r.browser);
  store.event({id:randomUUID(),event:'screen_view'});
  const replacement=createWebLoginStore(db,{...config,ownerId:foreign});
  assert.equal(replacement.state(active.browser).state,'none');assert.equal(replacement.session(auth.session),null);
  assert.equal(replacement.resolveBotToken(active.bot,foreign),null);assert.equal(replacement.prompt(active.id,foreign),null);
  assert.equal(replacement.delivered(active.id,foreign,'new-message'),false);assert.equal(replacement.decide(active.id,foreign,'new-message',true),false);
  assert.throws(()=>replacement.finish(active.browser),{status:409});assert.equal(replacement.report().created,0);assert.equal(replacement.report().client.length,0);
  assert.equal(db.prepare('SELECT state FROM web_login_prototype_requests WHERE id=?').get(active.id).state,'cancelled');
  const fresh=replacement.begin();
  for(const action of [()=>store.begin(),()=>store.state(fresh.browser),()=>store.resolveBotToken(fresh.bot,owner),()=>store.prompt(active.id,owner),()=>store.delivered(active.id,owner,'mid'),()=>store.decide(active.id,owner,'mid',true),()=>store.finish(fresh.browser),()=>store.session(auth.session),()=>store.logout(null,fresh.browser),()=>store.event({id:randomUUID(),event:'screen_view'}),()=>store.report()])assert.throws(action,{status:403});
  assert.equal(replacement.state(fresh.browser).state,'pending');
  const restored=createWebLoginStore(db,config);assert.equal(restored.state(active.browser).state,'cancelled');assert.equal(restored.session(auth.session),null);
});

test('every request operation checks stored owner even for known live foreign credentials',t=>{
  const {db,store,request}=fixture(t),r=request();
  db.prepare('UPDATE web_login_prototype_requests SET owner_id=? WHERE id=?').run(foreign,r.id);
  assert.equal(store.state(r.browser).state,'none');assert.equal(store.resolveBotToken(r.bot,owner),null);assert.equal(store.prompt(r.id,owner),null);
  assert.equal(store.delivered(r.id,owner,'foreign-message'),false);
  db.prepare("UPDATE web_login_prototype_requests SET state='offered',message_id='foreign-message' WHERE id=?").run(r.id);
  assert.equal(store.decide(r.id,owner,'foreign-message',true),false);
  db.prepare("UPDATE web_login_prototype_requests SET state='approved' WHERE id=?").run(r.id);
  assert.throws(()=>store.finish(r.browser),{status:409});store.logout(null,r.browser);store.begin(r.browser);
  assert.equal(db.prepare('SELECT state FROM web_login_prototype_requests WHERE id=?').get(r.id).state,'approved');
  assert.equal(store.report().created,1,'only the new local-owner request appears');
});

test('diagnostic events are idempotent and allowlisted; storage failure does not break login',t=>{
  const {db,store}=fixture(t),id=randomUUID();
  store.event({id,event:'screen_view',token:'secret',url:'https://private.example',text:'private'});
  store.event({id,event:'screen_view'});assert.deepEqual(store.report().client.map(r=>({...r})),[{event:'screen_view',code:null,count:1}]);
  assert.throws(()=>store.event({id:randomUUID(),event:'paid'}),{status:400});assert.throws(()=>store.event({id:randomUUID(),event:'client_error',code:'free text'}),{status:400});
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM web_login_prototype_events').all()).includes('private'));
  db.exec("CREATE TRIGGER block_diag_insert BEFORE INSERT ON web_login_prototype_events BEGIN SELECT RAISE(ABORT,'diagnostics unavailable'); END;");
  assert.doesNotThrow(()=>store.event({id:randomUUID(),event:'screen_view'}));assert.ok(store.begin().browser);
});

test('mature conversion uses equal complete request lifetime; timing counts one sample per successful transition',t=>{
  const {store,request,advance}=fixture(t),r=request();advance(100);store.delivered(r.id,owner,'message-1');advance(200);store.decide(r.id,owner,'message-1',true);advance(100);store.finish(r.browser);
  let report=store.report();assert.equal(report.mature,0);assert.equal(report.completedMature,0);
  assert.deepEqual(report.timing,{delivery:{samples:1,p50:100,p95:100},decision:{samples:1,p50:200,p95:200},completion:{samples:1,p50:100,p95:100}});
  const pending=request();advance(600);report=store.report();assert.equal(report.mature,1);assert.equal(report.completedMature,1);assert.equal(report.counts.pending,1);
  advance(400);report=store.report();assert.equal(report.mature,2);assert.equal(report.completedMature,1);assert.equal(store.state(pending.browser).state,'expired');
  const approved=request();approve(store,approved);advance(1000);report=store.report();
  assert.equal(report.approvedTotal,2);assert.equal(report.counts.expired,2);assert.equal(report.mature,3);assert.equal(report.completedMature,1);
});

test('legacy unbound active requests are cancelled rather than assigned to a new owner',t=>{
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  db.exec(`CREATE TABLE web_login_prototype_requests(id TEXT PRIMARY KEY,diagnostic_id TEXT NOT NULL UNIQUE,browser_hash TEXT NOT NULL,bot_hash TEXT UNIQUE,compare_code TEXT NOT NULL,state TEXT NOT NULL,message_id TEXT,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,delivered_at INTEGER,decided_at INTEGER,completed_at INTEGER);
    CREATE TABLE web_login_prototype_events(id TEXT PRIMARY KEY,event TEXT NOT NULL,code TEXT,created_at INTEGER NOT NULL);
    INSERT INTO web_login_prototype_requests VALUES('old','diag','hash','bothash','123456','approved','mid',100,10000,200,300,NULL);`);
  const store=createWebLoginStore(db,{ownerId:owner,now:()=>500});
  const legacy=db.prepare('SELECT owner_id,state,decision,bot_hash FROM web_login_prototype_requests').get();
  assert.deepEqual({...legacy},{owner_id:null,state:'cancelled',decision:'approved',bot_hash:null});assert.equal(store.report().created,0);
  assert.doesNotThrow(()=>createWebLoginStore(db,{ownerId:owner,now:()=>600}));assert.ok(store.begin().browser);
});

test('invalid owner and unbounded lifetimes are rejected before schema creation',t=>{
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  for(const config of [{ownerId:''},{ownerId:'max:123'},{ownerId:owner,requestTtl:0},{ownerId:owner,sessionTtl:Infinity},{ownerId:owner,requestTtl:604800001}])assert.throws(()=>createWebLoginStore(db,config));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table'").get().n,0);
});
