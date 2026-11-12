import { db } from './db.js';
import { config } from './config.js';
import { taggedStartSnapshot } from './tagged-bot-starts.js';

const originMax = 'https://recipeboibot-max.89-223-123-75.sslip.io';
const validTime = x => typeof x === 'string' && new Date(x).toISOString() === x;
export function validateTaggedSnapshot(data,tokens,platform) {
  if (data?.version !== 1 || data.platform !== platform || !validTime(data.trackingSince) || !Array.isArray(data.rows) || data.rows.length !== tokens.length) throw Error('Invalid start snapshot');
  const seen=new Set();
  for (const row of data.rows) {
    if (!tokens.includes(row.token) || seen.has(row.token) || !(row.campaign === null || /^[a-z0-9][a-z0-9_-]{0,39}$/.test(row.campaign)) ||
      !Number.isSafeInteger(row.launches) || row.launches < 0 || ['newAt','returningAt','internalAt'].some(k=>row[k] !== null && !validTime(row[k])) ||
      (!row.campaign && (row.newAt || row.returningAt || row.internalAt || row.launches)) || (row.launches && !row.newAt && !row.returningAt)) throw Error('Invalid start row');
    seen.add(row.token);
  }
  return data;
}

export function reconcileLandingStarts(visits,snapshot,platform,now=new Date().toISOString()) {
  const byToken=new Map(snapshot.rows.map(r=>[r.token,r]));
  const out={platform,status:'ready',trackingSince:snapshot.trackingSince,generatedAt:now,
    clicks:visits.length,newUsers:0,existingUsers:0,withoutStart:0,historicalUnknown:0,excludedInternal:0,
    missingToken:0,launches:0,bothKinds:0,pending24h:0};
  for (const visit of visits) {
    const fact=byToken.get(visit.token);
    const matched=fact?.campaign === visit.campaign;
    const isNew=matched && fact.newAt >= visit.at, isOld=matched && fact.returningAt >= visit.at;
    if (isNew || isOld) {
      if (isNew) out.newUsers++; else out.existingUsers++;
      if (isNew && isOld) out.bothKinds++;
      out.launches+=fact.launches;
    } else if (matched && fact.internalAt >= visit.at) out.excludedInternal++;
    else if (!visit.token) out.missingToken++;
    else if (visit.at < snapshot.trackingSince) out.historicalUnknown++;
    else { out.withoutStart++; if (Date.parse(now)-Date.parse(visit.at)<86400000) out.pending24h++; }
  }
  return out;
}

// Only anonymous click tokens cross this authenticated bridge. No account IDs,
// messages, URLs, browser identity or full payloads leave their contour.
export async function landingStartOutcomes(slug='all', {transport=fetch,origin=config.maxFunnelOrigin,token=config.maxFunnelToken}={}) {
  const where=slug==='all'?'':slug==='site-landing'?'WHERE campaign IS NULL':'WHERE campaign=?';
  const rows=db.prepare(`SELECT campaign,click_token,telegram_clicked_at,max_click_token,max_clicked_at FROM landing_visits ${where}`).all(...(slug==='all'||slug==='site-landing'?[]:[slug]));
  return Promise.all(['telegram','max'].map(async platform=>{
    const visits=rows.filter(r=>r[platform==='max'?'max_clicked_at':'telegram_clicked_at']).map(r=>({campaign:r.campaign||'site-landing',token:r[platform==='max'?'max_click_token':'click_token'],at:r[platform==='max'?'max_clicked_at':'telegram_clicked_at']}));
    const unavailable={platform,status:'unavailable',clicks:visits.length,trackingSince:null,newUsers:null,existingUsers:null,withoutStart:null,historicalUnknown:null,excludedInternal:null,missingToken:null,launches:null,bothKinds:null,pending24h:null};
    try {
      const tokens=[...new Set(visits.map(v=>v.token).filter(Boolean))];
      // Bound work and network time. A partial result is never presented as complete.
      if (tokens.length>10000) return unavailable;
      const batches=[]; for(let i=0;i<tokens.length || i===0;i+=500)batches.push(tokens.slice(i,i+500));
      const local=platform===config.botPlatform;
      if (!local && (config.testContour || config.botPlatform!=='telegram' || origin!==originMax || !/^[A-Za-z0-9_-]{43,128}$/.test(token))) return unavailable;
      const signal=AbortSignal.timeout(5000);
      const snapshots=await Promise.all(batches.map(async batch=>{
        if(local)return taggedStartSnapshot(batch);
        const response=await transport(origin+'/api/internal/tagged-starts',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({tokens:batch}),signal,redirect:'error'});
        if(!response.ok)throw Error('Start bridge unavailable');
        const text=await response.text();if(text.length>256000)throw Error('Start bridge too large');
        return validateTaggedSnapshot(JSON.parse(text),batch,platform);
      }));
      if(snapshots.some(s=>s.trackingSince!==snapshots[0].trackingSince))throw Error('Inconsistent tracking boundary');
      return reconcileLandingStarts(visits,{trackingSince:snapshots[0].trackingSince,rows:snapshots.flatMap(s=>s.rows)},platform);
    } catch { return unavailable; }
  }));
}
