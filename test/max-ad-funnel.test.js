import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const file=path.resolve('data', 'max-funnel-'+randomUUID()+'.sqlite');
Object.assign(process.env,{DATABASE_PATH:file,BOT_PLATFORM:'max',MAX_BOT_USERNAME:'id500912857935_bot',MAX_TEST_RESET_USER_ID:'500',MAX_FUNNEL_TOKEN:'a'.repeat(43),MAX_BOT_TOKEN:'fixture',MAX_WEBHOOK_SECRET:'s'.repeat(64),TELEGRAM_BOT_TOKEN:'',TELEGRAM_POLLING:'false',TEST_CONTOUR:'false',ROBOKASSA_TEST:'false',APP_URL:'https://max.example.test'});
const {db,upsertTelegramUser,allowUser}=await import('../src/db.js');
const {recordBotStart,funnelReport,createCampaign,campaignLink}=await import('../src/funnel.js');
const {MAX_AD_PLACEMENT,MAX_AD_PAYLOAD}=await import('../src/max-acquisition.js');
const {maxFunnelSnapshot,maxFunnelAuthorized,mergeMaxFunnelReport}=await import('../src/max-funnel.js');
const {emptyRecipeActivity}=await import('../src/recipe-activity.js');
const {normalizeMaxUpdate}=await import('../src/max-events.js');
const {campaignPriceAssignment}=await import('../src/campaign-prices.js');
const {createServer}=await import('../src/server.js');
test.after(()=>{db.close();for(const suffix of ['','-wal','-shm'])fs.rmSync(file+suffix,{force:true});});
const user=id=>upsertTelegramUser({id:'max:'+id,first_name:'Проверка'});
const start=(u,payload=MAX_AD_PAYLOAD)=>recordBotStart(u,'/start '+payload);
test('MAX payload survives webhook normalization, first attribution is immutable and service/returning accounts excluded',()=>{
 const event=normalizeMaxUpdate({update_type:'bot_started',timestamp:123,user:{user_id:501,first_name:'Проверка'},chat_id:123,payload:MAX_AD_PAYLOAD},{store:{bind:()=>true}});
 assert.equal(event.message.text,'/start '+MAX_AD_PAYLOAD);
 const newcomer=user(501);recordBotStart(newcomer,event.message.text);start(newcomer);recordBotStart(newcomer,'/start unknown');
 assert.equal(campaignPriceAssignment(newcomer.id)?.campaign,MAX_AD_PLACEMENT);
 start(user(500));const returning=user(502);allowUser(returning.telegram_id);start({...returning,is_allowed:1});
 start(user(503),'campaign_unknown');
 db.prepare('INSERT INTO dinner_events(id,user_id,event,created_at) VALUES(?,?,?,?)').run(randomUUID(),newcomer.id,'recommendation_shown',new Date().toISOString());
 db.prepare('INSERT INTO dinner_events(id,user_id,event,created_at) VALUES(?,?,?,?)').run(randomUUID(),newcomer.id,'recommendation_accepted',new Date().toISOString());
 const report=funnelReport(MAX_AD_PLACEMENT);
 assert.equal(report.totals.starts,1);assert.equal(report.returningStarts,1);assert.equal(report.convertedClicks,1);
 assert.equal(report.clicks,0);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM acquisition_clicks').get().n,0);
 assert.equal(new URL(campaignLink(MAX_AD_PLACEMENT)).searchParams.get('start'),MAX_AD_PAYLOAD);
 assert.equal(funnelReport('all').totals.starts,3);
});
test('aggregate endpoint requires its own token, returns no identities and is read only',async()=>{
 assert.equal(maxFunnelAuthorized(undefined),false);assert.equal(maxFunnelAuthorized('Bearer '+process.env.MAX_FUNNEL_TOKEN),true);
 assert.equal(maxFunnelAuthorized('Bearer '+process.env.MAX_FUNNEL_TOKEN,'weak'),false);
 const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 try {
  assert.equal((await fetch(base+'/api/internal/max-funnel')).status,404);
  const before=db.prepare('SELECT COUNT(*) AS n FROM acquisition_starts').get().n;
  const response=await fetch(base+'/api/internal/max-funnel',{headers:{authorization:'Bearer '+process.env.MAX_FUNNEL_TOKEN}});assert.equal(response.status,200);
  const result=await response.json();assert.equal(result.campaign.totals.starts,1);assert.equal(result.all.totals.starts,3);
  assert.ok(!JSON.stringify(result).includes('max:501'));assert.ok(!JSON.stringify(result).includes(process.env.MAX_FUNNEL_TOKEN));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM acquisition_starts').get().n,before);
 } finally {await new Promise(r=>server.close(r));}
});
const counters={starts:4,firstRecipe:2,selectedRecipe:1,trial:1,paid:0};
const report=(slug=MAX_AD_PLACEMENT)=>({campaign:slug?{slug}:null,totals:{...counters},ordered:{...counters},recipeActivity:{...emptyRecipeActivity(),returnRate:null},convertedClicks:4,clicks:20,impressions:100,campaigns:[],conversions:{startFromClick:20,firstRecipeFromStart:50,trialAfterRecipe:50,paidAfterTrial:0},priceExperiment:null,testPaidUsers:0,unclassifiedPaidUsers:0,historicalStartsWithoutDate:0,linkRequests:9});
const options={enabled:true,origin:'https://recipeboibot-max.89-223-123-75.sslip.io',token:'a'.repeat(43)};
test('specific MAX funnel uses MAX stages and Direct clicks, all-users adds MAX accounts exactly once',async()=>{
 const snapshot=maxFunnelSnapshot();
 const transport=async(url,init)=>{assert.equal(url,options.origin+'/api/internal/max-funnel');assert.equal(init.headers.authorization,'Bearer '+options.token);return Response.json(snapshot);};
 const specific=await mergeMaxFunnelReport(report(),{...options,transport});
 assert.equal(specific.totals.selectedRecipe,1);assert.equal(specific.ordered.selectedRecipe,1);assert.equal(specific.totals.starts,1);assert.equal(specific.clicks,20);assert.equal(specific.conversions.startFromClick,5);assert.equal(specific.linkRequests,null);
 const combined=await mergeMaxFunnelReport(report(null),{...options,transport});
 assert.equal(combined.totals.selectedRecipe,2);assert.equal(combined.ordered.selectedRecipe,2);assert.equal(combined.totals.starts,7);assert.equal(combined.convertedClicks,5);assert.equal(combined.conversions.startFromClick,25);
 const original=report('ya-dinner-202610');assert.equal(await mergeMaxFunnelReport(original,{...options,transport:()=>{throw new Error('should not fetch');}}),original);
});
test('MAX outage preserves advertising stats and marks stages unknown without false zeroes or credential errors',async()=>{
 const transport=async()=>{throw new Error('private '+options.token);};
 const failed=await mergeMaxFunnelReport(report(),{...options,transport});assert.equal(failed.clicks,20);assert.equal(failed.totals.starts,null);assert.equal(failed.totals.selectedRecipe,null);assert.equal(failed.conversions.trialAfterSelection,null);assert.equal(failed.conversions.startFromClick,null);
 assert.ok(!JSON.stringify(failed).includes(options.token));
 const all=await mergeMaxFunnelReport(report(null),{...options,transport});assert.equal(all.totals.starts,4);assert.equal(all.conversions.startFromClick,null);assert.equal(all.remoteFunnel.status,'error');
});
test('bridge rejects unexpected destinations and invalid aggregate sources before trusting counts',async()=>{
 let calls=0;const transport=async()=>{calls++;return Response.json({...maxFunnelSnapshot(),placement:'wrong'});};
 const wrong=await mergeMaxFunnelReport(report(),{...options,origin:'https://other.example',transport});assert.equal(calls,0);assert.equal(wrong.totals.starts,null);
 const invalid=await mergeMaxFunnelReport(report(),{...options,transport});assert.equal(calls,1);assert.equal(invalid.totals.starts,null);
});

test('old MAX aggregates and impossible selection order remain unknown rather than inventing zeroes',async()=>{
 for(const snapshot of [{...maxFunnelSnapshot(),version:1},(()=>{const s=maxFunnelSnapshot();s.campaign.ordered.selectedRecipe=s.campaign.ordered.firstRecipe+1;return s;})()]){
  const result=await mergeMaxFunnelReport(report(),{...options,transport:async()=>Response.json(snapshot)});
  assert.equal(result.remoteFunnel.status,'error');assert.equal(result.totals.selectedRecipe,null);assert.equal(result.clicks,20);
 }
});
