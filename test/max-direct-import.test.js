import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
const file=path.resolve('data','max-direct-'+randomUUID()+'.sqlite');
Object.assign(process.env,{DATABASE_PATH:file,BOT_PLATFORM:'telegram',TEST_CONTOUR:'false',TELEGRAM_POLLING:'false',YANDEX_DIRECT_TOKEN:'private-fixture',YANDEX_DIRECT_MAX_CAMPAIGN_ID:'715109276',YANDEX_DIRECT_LANDING_CAMPAIGN_ID:'',YANDEX_DIRECT_OUTSIDE_CAMPAIGN_ID:''});
const {db}=await import('../src/db.js');
const {syncDirectCampaigns,directImportSettings,dashboardFunnelReport}=await import('../src/yandex-direct.js');
test.after(()=>{db.close();for(const s of ['','-wal','-shm'])fs.rmSync(file+s,{force:true});});
test('normal scheduler import includes MAX independently, keeps VAT and exports the correct native link',async()=>{
 assert.equal(directImportSettings('ya-max-dinner-202610').campaignId,'715109276');
 const seen=[];await syncDirectCampaigns('all',{transport:async(url,init)=>{
  const id=JSON.parse(init.body).params.SelectionCriteria.Filter[0].Values[0];seen.push(id);
  return new Response('CampaignId\tImpressions\tClicks\tCost\n'+id+'\t0\t0\t0.00\n');
 }});
 assert.deepEqual(seen.sort(),['715053149','715109276']);
 const report=dashboardFunnelReport('ya-max-dinner-202610');
 assert.equal(report.directStats.campaignId,'715109276');assert.equal(report.clicks,0);assert.equal(report.directStats.includesVat,true);
 assert.equal(report.linkRequests,null);assert.match(report.campaigns.find(c=>c.slug==='ya-max-dinner-202610').link,/^https:\/\/max.ru\/id500912857935_bot\?start=campaign_ya-max-dinner-202610$/);
 assert.equal(dashboardFunnelReport('all').directStats.campaignCount,2);
});
