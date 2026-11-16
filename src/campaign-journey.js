import { db } from './db.js';
import { config } from './config.js';
import { analyticsExcludedIds, analyticsUserCondition } from './analytics-exclusions.js';
import { taggedStartsSince } from './tagged-bot-starts.js';

const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const day = value => new Date(Date.parse(value) + 10800000).toISOString().slice(0, 10);
const fail = () => Object.assign(new Error('Неверные параметры воронки'), { status: 400 });
const validVisit = v => v && /^[A-Za-z0-9_-]{24}$/.test(v.token) && /^[a-z0-9][a-z0-9_-]{0,39}$/.test(v.campaign) && iso(v.at);
const exists = name => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);

// Only random transition tokens and aggregate outcomes cross the bridge.
// Every step must belong to the SAME account, in chronological order.
export function campaignJourneySnapshot(visits, now = new Date().toISOString()) {
  if (!Array.isArray(visits) || visits.length > 500 || visits.some(v => !validVisit(v)) || new Set(visits.map(v => v.token)).size !== visits.length || !iso(now)) throw fail();
  if (!exists('product_events') || !exists('payment_orders')) throw Error('Journey data unavailable');
  const starts = db.prepare(`SELECT s.user_id,s.started_at,CASE WHEN ${analyticsUserCondition} THEN 0 ELSE 1 END AS internal FROM (
    SELECT user_id,started_at FROM tagged_bot_starts WHERE click_token=? AND campaign=? AND started_at>=? AND started_at<=?
    UNION SELECT user_id,started_at FROM acquisition_starts WHERE click_token=? AND campaign=? AND started_at>=? AND started_at<=?
  ) s JOIN users u ON u.id=s.user_id ORDER BY s.started_at`);
  const saved = db.prepare("SELECT MIN(created_at) AS at FROM recipes WHERE user_id=? AND status IN ('ready','archived') AND created_at>=? AND created_at<=?");
  const views = db.prepare("SELECT created_at FROM product_events WHERE user_id=? AND event IN ('screen_view','workspace_view') AND created_at>? AND created_at<=? ORDER BY created_at");
  const payments = db.prepare("SELECT paid_at FROM payment_orders WHERE user_id=? AND status='paid' AND is_test=0 AND paid_at>=? AND paid_at<=? ORDER BY paid_at");
  const readers = exists('recipe_engagement') ? db.prepare("SELECT created_at FROM recipe_engagement WHERE user_id=? AND event='recipe_opened' AND created_at>? AND created_at<=? ORDER BY created_at") : null;
  return { version: 1, platform: config.botPlatform, trackingSince: taggedStartsSince(), generatedAt: now, rows: visits.map(v => {
    const facts = starts.all(...analyticsExcludedIds, v.token,v.campaign,v.at,now,v.token,v.campaign,v.at,now);
    const row = { token:v.token, stage:0, internal:false, paidAfterStart:false };
    const seen = new Set();
    for (const s of facts) {
      if (s.internal || seen.has(s.user_id)) continue;
      seen.add(s.user_id);
      let stage = 1;
      const paid = payments.all(s.user_id,s.started_at,now);
      row.paidAfterStart ||= paid.length > 0;
      const save = saved.get(s.user_id,s.started_at,now).at;
      if (save) {
        stage = 2;
        const visible = [...views.all(s.user_id,save,now), ...(readers?.all(s.user_id,save,now) || [])];
        const returned = visible.map(e => e.created_at).filter(at => day(at) > day(save)).sort()[0];
        if (returned) { stage = 3; if (paid.some(p => p.paid_at >= returned)) stage = 4; }
      }
      row.stage = Math.max(row.stage, stage);
    }
    row.internal = facts.length > 0 && seen.size === 0;
    return row;
  }) };
}

export function validateCampaignJourney(data, visits, platform, now) {
  if (data?.version !== 1 || data.platform !== platform || !iso(data.trackingSince) || data.generatedAt !== now || !Array.isArray(data.rows) || data.rows.length !== visits.length) throw Error('Invalid journey snapshot');
  const tokens = new Set(visits.map(v => v.token));
  for (const r of data.rows) {
    if (!tokens.delete(r.token) || !Number.isInteger(r.stage) || r.stage < 0 || r.stage > 4 || typeof r.internal !== 'boolean' || typeof r.paidAfterStart !== 'boolean' || (r.internal && (r.stage || r.paidAfterStart)) || (r.paidAfterStart && !r.stage) || (r.stage === 4 && !r.paidAfterStart)) throw Error('Invalid journey row');
  }
  return data;
}

export function campaignJourneyFilters(params) {
  const campaign = params.get('campaign') || 'ya-product-landing-202611';
  const from = params.get('from') || '2026-11-10', to = params.get('to') || day(new Date().toISOString());
  const validDay = v => /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0,10) === v;
  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(campaign) || !validDay(from) || !validDay(to) || from > to) throw fail();
  return { campaign, from, to };
}

export async function campaignJourneyReport(filters, { transport=fetch, origin=config.maxFunnelOrigin, token=config.maxFunnelToken, now=new Date().toISOString() }={}) {
  const {campaign,from,to}=filters;
  const scope = campaign==='all' ? '' : campaign==='site-landing' ? 'AND campaign IS NULL' : 'AND campaign=?';
  const visits=db.prepare(`SELECT * FROM landing_visits WHERE opened_at>=? AND opened_at<? ${scope}`).all(
    new Date(from+'T00:00:00+03:00').toISOString(), new Date(Date.parse(to+'T00:00:00+03:00')+86400000).toISOString(), ...(campaign==='all'||campaign==='site-landing'?[]:[campaign]));
  const platforms=await Promise.all(['telegram','max'].map(async platform=>{
    const clicks=visits.filter(v=>v[platform==='telegram'?'telegram_clicked_at':'max_clicked_at']).map(v=>({token:v[platform==='telegram'?'click_token':'max_click_token'],campaign:v.campaign||'site-landing',at:v[platform==='telegram'?'telegram_clicked_at':'max_clicked_at']}));
    const result={platform,status:'unavailable',counts:[visits.length,clicks.length,null,null,null,null],excludedInternal:null,historicalUnknown:null,missingToken:clicks.filter(v=>!v.token).length,paidAfterStart:null,paidOutsideChain:null,trackingSince:null};
    try {
      const tagged=clicks.filter(v=>v.token);
      if(tagged.length>10000)throw Error('Too many visits');
      const local=platform===config.botPlatform;
      if(!local && (config.testContour || config.botPlatform!=='telegram' || origin!=='https://recipeboibot-max.89-223-123-75.sslip.io' || !/^[A-Za-z0-9_-]{43,128}$/.test(token)))throw Error('Bridge unavailable');
      const snapshots=[], signal=AbortSignal.timeout(5000);
      // Sequential bounded batches prevent an unbounded burst on MAX.
      for(let i=0;i<tagged.length || i===0;i+=500) {
        const batch=tagged.slice(i,i+500);
        if(local) snapshots.push(campaignJourneySnapshot(batch,now));
        else {
          const response=await transport(origin+'/api/internal/campaign-journey',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({visits:batch,now}),signal,redirect:'error'});
          if(!response.ok)throw Error('Bridge unavailable');
          const text=await response.text();if(text.length>256000)throw Error('Bridge too large');
          snapshots.push(validateCampaignJourney(JSON.parse(text),batch,platform,now));
        }
      }
      if(snapshots.some(s=>s.trackingSince!==snapshots[0].trackingSince))throw Error('Inconsistent tracking boundary');
      const rows=snapshots.flatMap(s=>s.rows), byToken=new Map(rows.map(r=>[r.token,r]));
      result.status='ready';result.trackingSince=snapshots[0].trackingSince;
      result.excludedInternal=rows.filter(r=>r.internal).length;
      result.counts=[visits.length-result.excludedInternal,clicks.length-result.excludedInternal,...[1,2,3,4].map(stage=>rows.filter(r=>r.stage>=stage).length)];
      result.historicalUnknown=tagged.filter(v=>!byToken.get(v.token).stage && !byToken.get(v.token).internal && v.at<result.trackingSince).length;
      result.paidAfterStart=rows.filter(r=>r.paidAfterStart).length;
      result.paidOutsideChain=rows.filter(r=>r.paidAfterStart && r.stage<4).length;
    } catch { /* Missing or incompatible data must never become zero. */ }
    result.conversions=result.counts.map((n,i)=>i===0||n===null||result.counts[i-1]===null||!result.counts[i-1]?null:Number((100*n/result.counts[i-1]).toFixed(1)));
    result.fromSite=result.counts.map(n=>n===null||!result.counts[0]?null:Number((100*n/result.counts[0]).toFixed(1)));
    return result;
  }));
  return {version:1,...filters,generatedAt:now,platforms};
}
