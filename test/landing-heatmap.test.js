import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const file=path.resolve('data',`heatmap-${randomUUID()}.sqlite`);
process.env.DATABASE_PATH=file;process.env.TELEGRAM_POLLING='false';process.env.TELEGRAM_BOT_TOKEN='test-only';
const {db,upsertTelegramUser}=await import('../src/db.js');
const {createCampaign,recordBotStart}=await import('../src/funnel.js');
const {recordLandingView,landingRedirect}=await import('../src/landing-funnel.js');
const {recordLandingHeatmap,landingHeatmapReport,landingHeatmapPreview,HEATMAP_VERSION}=await import('../src/landing-heatmap.js');
const {createServer}=await import('../src/server.js');
const {createDashboardPassword,openDashboardSession}=await import('../src/funnel-auth.js');
test.after(()=>{db.close();for(const s of ['','-wal','-shm'])try{fs.unlinkSync(file+s);}catch{}});
function visit(campaign){const id=randomUUID().replaceAll('-','');recordLandingView({visitId:id,query:campaign?'campaign='+campaign:''});db.prepare('UPDATE landing_visits SET opened_at=? WHERE id=?').run('2030-01-01T21:05:00.000Z',id);return id;}
const event=(id,extra={})=>({id:randomUUID(),visitId:id,version:HEATMAP_VERSION,layout:'mobile',kind:'progress',depth:40,visibleMs:1200,dropped:0,pending:0,...extra});
const click=id=>({id:randomUUID(),visitId:id,version:HEATMAP_VERSION,layout:'mobile',kind:'click',section:'hero',target:'telegram',x:10,y:12});
const filters=campaign=>new URLSearchParams({campaign,from:'2030-01-02',to:'2030-01-02'});
test('heatmap preserves idempotency, separates campaign/layout and does not fabricate historical observations',()=>{
 createCampaign('heat-a');createCampaign('heat-b');const a=visit('heat-a'),b=visit('heat-b');visit('heat-a');
 const progress=event(a),point=click(a);recordLandingHeatmap({events:[progress,point]});recordLandingHeatmap({events:[progress,point]});
 recordLandingHeatmap({events:[event(a,{depth:90,visibleMs:1000,storageError:1}),event(b),event(a,{layout:'desktop',depth:20})]});
 const r=landingHeatmapReport(filters('heat-a'));assert.equal(r.visits,1);assert.equal(r.clicks,1);assert.equal(r.visibleMs,1200);assert.equal(r.storageErrors,1);assert.equal(r.scroll.find(s=>s.depth===90).visits,1);assert.equal(r.scroll.at(-1).visits,0);
 assert.equal(landingHeatmapReport(filters('heat-b')).clicks,0);
 const desktop=filters('heat-a');desktop.set('layout','desktop');assert.equal(landingHeatmapReport(desktop).visits,1);assert.equal(landingHeatmapReport(desktop).clicks,0);
 const previous=filters('heat-a');previous.set('from','2030-01-01');previous.set('to','2030-01-01');assert.equal(landingHeatmapReport(previous).visibleMs,null);
 assert.throws(()=>landingHeatmapReport(new URLSearchParams({from:'2030-02-30'})),{status:400});assert.throws(()=>landingHeatmapReport(filters('unknown')),{status:400});
});
test('strict event schema, atomic batches, probes and internal identities',()=>{
 const id=visit('heat-a'),before=landingHeatmapReport(filters('heat-a')).visits;
 for(const bad of [event(id,{text:'private'}),event(id,{depth:101}),event(id,{visibleMs:-1}),click(id)&&{...click(id),section:'private'},event(id,{layout:'unknown'})])assert.throws(()=>recordLandingHeatmap({events:[bad]}),{status:400});
 const clean=event(id);assert.throws(()=>recordLandingHeatmap({events:[clean,event('f'.repeat(32))]}),{status:400});assert.equal(db.prepare('SELECT 1 FROM landing_heatmap_events WHERE id=?').get(clean.id),undefined);
 recordLandingHeatmap({events:[clean]},{userAgent:'YandexBot'});recordLandingHeatmap({events:[clean]},{internal:true});assert.equal(landingHeatmapReport(filters('heat-a')).visits,before);
 recordLandingHeatmap({events:[clean]});const owner=upsertTelegramUser({id:6971956699});const url=landingRedirect(id);recordBotStart(owner,'/start '+new URL(url).searchParams.get('start'));assert.equal(landingHeatmapReport(filters('heat-a')).visits,before);
});
test('public ingestion is origin checked; report and inert preview require dashboard authentication',async()=>{
 const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 const cookie='funnel_session='+openDashboardSession(createDashboardPassword()),id=visit('heat-b'),body=JSON.stringify({events:[event(id)]});
 try{
  for(const route of ['landing-heatmap','landing-preview'])assert.equal((await fetch(base+'/api/dashboard/'+route)).status,401);
  assert.equal((await fetch(base+'/api/landing/heatmap',{method:'POST',headers:{'content-type':'application/json','x-landing-request':'1',origin:'https://other.example'},body})).status,403);
  assert.equal((await fetch(base+'/api/landing/heatmap',{method:'POST',headers:{'content-type':'application/json','x-landing-request':'1'},body})).status,200);
  assert.equal((await fetch(base+'/api/dashboard/landing-heatmap?'+filters('heat-b'),{headers:{cookie}})).status,200);
  const r=await fetch(base+'/api/dashboard/landing-preview',{headers:{cookie}});assert.equal(r.status,200);assert.match(r.headers.get('content-security-policy'),/script-src 'none'/);assert.doesNotMatch(await r.text(),/<script\b/i);
  assert.doesNotMatch(landingHeatmapPreview(path.resolve('public')),/href="https:/);
 }finally{await new Promise(r=>server.close(r));}
});
