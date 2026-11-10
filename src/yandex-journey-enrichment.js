import { db } from './db.js';
import { config } from './config.js';
import './landing-funnel.js';
import { log } from './log.js';

db.exec(`CREATE TABLE IF NOT EXISTS direct_creative_cache (
  ad_id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL, group_id TEXT NOT NULL,
  title TEXT, text TEXT, kind TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS landing_ad_enrichment (
  visit_id TEXT PRIMARY KEY REFERENCES landing_visits(id), search_query TEXT,
  query_status TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS user_ad_enrichment_state (key TEXT PRIMARY KEY,status TEXT NOT NULL,updated_at TEXT NOT NULL);`);
db.prepare("INSERT OR IGNORE INTO acquisition_metadata(key,value) VALUES('user_ad_enrichment_since',?)").run(new Date().toISOString());

const numericId = value => /^\d{1,20}$/.test(String(value || '')) ? String(value) : null;
const safeText = (value, limit) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, limit) : null;
export function safeSearchQuery(value) {
  const text = safeText(value, 256);
  if (!text || ['(not set)', 'Не определено', '<не определено>'].includes(text)) return null;
  // Do not retain accidentally disclosed credentials, URLs, email or phone numbers.
  if (/https?:\/\/|www\.|[\w.+-]+@[\w.-]+\.[a-z]{2,}|(?:token|password|secret|api[_-]?key)\s*[:=]|\+?\d[\d ()-]{8,}\d/i.test(text)) return '[скрыто]';
  return text;
}
export const parseYandexJson = text => JSON.parse(text, (key, value, context) =>
  typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value) ? context.source : value);
function setState(key, status, at) {
  db.prepare('INSERT INTO user_ad_enrichment_state VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at').run(key,status,at);
}
function state(key) { return db.prepare('SELECT status,updated_at FROM user_ad_enrichment_state WHERE key=?').get(key); }
async function boundedJson(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('empty_response');
  let bytes = 0; const chunks = [];
  try {
    for (;;) { const {done,value} = await reader.read(); if (done) break;
      bytes += value.length; if (bytes > 1024 * 1024) { await reader.cancel(); throw new Error('response_too_large'); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return parseYandexJson(Buffer.concat(chunks).toString('utf8'));
}
function landingFor(user) {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(user.clickToken || '')) return null;
  const column = user.platform === 'max' ? 'max_click_token' : 'click_token';
  return db.prepare(`SELECT * FROM landing_visits WHERE ${column}=?`).get(user.clickToken) || null;
}
export function enrichUserAdJourneyReport(report) {
  const ads = state('ads'), queries = state('queries');
  const result = {...report, enrichment:{adsStatus:ads?.status || 'pending',queriesStatus:queries?.status || 'pending',
    updatedAt:queries?.updated_at || ads?.updated_at || null,
    trackingSince:db.prepare("SELECT value FROM acquisition_metadata WHERE key='user_ad_enrichment_since'").get()?.value || null}};
  result.users = (report.users || []).map(user => {
    const row = {...user,ad:{...user.ad},search:{...user.search}};
    const visit = landingFor(user);
    let tags = {}; try { tags = JSON.parse(visit?.tags_json || '{}'); } catch {}
    // Main joins MAX's opaque click marker to its own landing data; no remote DB copy.
    if (visit && visit.campaign === user.campaign) {
      row.ad.id = numericId(tags.utm_content) || row.ad.id;
      row.ad.campaignId = numericId(tags.campaign_id) || row.ad.campaignId;
      row.ad.groupId = numericId(tags.adgroup_id) || row.ad.groupId;
      row.search.keyword = safeText(tags.utm_term,256) || row.search.keyword;
    }
    const creative = row.ad.id && db.prepare('SELECT * FROM direct_creative_cache WHERE ad_id=?').get(String(row.ad.id));
    if (creative && (!row.ad.campaignId || creative.campaign_id === row.ad.campaignId) && (!row.ad.groupId || creative.group_id === row.ad.groupId)) {
      Object.assign(row.ad,{title:creative.title,text:creative.text,kind:creative.kind,creativeStatus:'current',updatedAt:creative.updated_at});
    }
    const cached = visit && visit.campaign === user.campaign && db.prepare('SELECT * FROM landing_ad_enrichment WHERE visit_id=?').get(visit.id);
    let status = !visit ? 'unlinked' : !visit.metrika_client_id ? 'no_client_id' : queries?.status === 'no_access' ? 'no_access' : queries?.status === 'unconfigured' ? 'unconfigured' : 'pending';
    if (user.campaign?.includes('rsya')) status = 'not_search';
    if (cached?.query_status === 'ready' || (!['no_access','unconfigured','not_search'].includes(status) && cached)) status = cached.query_status;
    row.search = {...row.search,query:status === 'ready' ? cached?.search_query || null : null,status};
    delete row.clickToken;
    return row;
  });
  return result;
}

export function metrikaJourneyRequest(visit, settings = config, at = new Date()) {
  const id = visit.id, client = visit.metrika_client_id;
  if (!/^[a-f0-9]{32}$/.test(id) || !/^\d{1,32}$/.test(client || '') || !settings.yandexMetrikaCounterId) throw new Error('invalid_visit');
  const timestamp = Date.parse(visit.opened_at); if (!Number.isFinite(timestamp)) throw new Error('invalid_date');
  const date = delta => new Date(timestamp + 3*3600000 + delta * 86400000).toISOString().slice(0,10);
  const today = new Date(at.getTime()+3*3600000).toISOString().slice(0,10);
  const url = new URL('https://api-metrika.yandex.net/stat/v1/data');
  url.search = new URLSearchParams({ids:String(settings.yandexMetrikaCounterId),metrics:'ym:s:visits',
    dimensions:'ym:s:clientID,ym:s:lastDirectClickOrder,ym:s:lastDirectClickBanner,ym:s:lastDirectSearchPhrase',
    filters:`ym:s:clientID=='${client}' AND EXISTS(ym:s:paramsLevel1=='recipe_visit_id' AND ym:s:paramsLevel2=='${id}') AND NONE(ym:s:paramsLevel1=='recipe_visit_id' AND ym:s:paramsLevel2!='${id}')`,
    date1:date(-1),date2:date(1)>today?today:date(1),accuracy:'full',limit:'10'}).toString();
  return url;
}
export function interpretMetrikaJourney(data, visit) {
  if (!Array.isArray(data?.data) || data.sampled === true || Number(data.sample_share ?? 1) < 1 || data.total_rows > 1) return {status:'ambiguous',query:null};
  if (data.data.length === 0) return {status:'not_available',query:null};
  if (data.data.length !== 1 || Number(data.data[0].metrics?.[0]) !== 1) return {status:'ambiguous',query:null};
  const dimensions = data.data[0].dimensions;
  if (!Array.isArray(dimensions) || dimensions.length !== 4) return {status:'ambiguous',query:null};
  const value = dimension => String(dimension?.id ?? dimension?.name ?? '');
  let tags = {}; try { tags = JSON.parse(visit.tags_json); } catch {}
  if (value(dimensions[0]) !== visit.metrika_client_id || !numericId(tags.campaign_id) || !numericId(tags.utm_content) ||
      value(dimensions[1]) !== tags.campaign_id || value(dimensions[2]) !== tags.utm_content) return {status:'ambiguous',query:null};
  const query = safeSearchQuery(dimensions[3]?.name);
  return {status:query ? 'ready' : 'not_available',query};
}

export async function syncJourneyEnrichment({transport = fetch, settings = config, at = new Date()} = {}) {
  if (settings.testContour || settings.dashboardPreview || settings.botPlatform === 'max') return {skipped:true};
  const now = at.toISOString();
  if (!settings.yandexDirectToken) setState('ads','unconfigured',now);
  else if (!state('ads') || Date.parse(state('ads').updated_at) < at.getTime() - 3600000) {
    try {
      const campaigns = [...new Set([settings.yandexDirectCampaignId,settings.yandexDirectLandingCampaignId,settings.yandexDirectOutsideCampaignId,
        settings.yandexDirectMaxCampaignId,settings.yandexDirectRecipeFirstCampaignId,settings.yandexDirectProductCampaignId,settings.yandexDirectRsyaCampaignId]
        .filter(x => /^\d{1,15}$/.test(x || '')))].map(Number);
      if (!campaigns.length) setState('ads','unconfigured',now);
      else {
        const response = await transport('https://api.direct.yandex.com/json/v501/ads',{method:'POST',signal:AbortSignal.timeout(15000),
          headers:{Authorization:`Bearer ${settings.yandexDirectToken}`,...(settings.yandexDirectLogin ? {'Client-Login':settings.yandexDirectLogin} : {}),'Content-Type':'application/json','Accept-Language':'ru'},
          body:JSON.stringify({method:'get',params:{SelectionCriteria:{CampaignIds:campaigns},FieldNames:['Id','CampaignId','AdGroupId','Type'],TextAdFieldNames:['Title','Title2','Text'],ResponsiveAdFieldNames:['Titles','Texts'],Page:{Limit:1000}}})});
        if (!response.ok) throw new Error('direct_http');
        const data = await boundedJson(response);
        if (!Array.isArray(data.result?.Ads) || data.result.Ads.length > 1000 || data.result.LimitedBy) throw new Error('direct_incomplete');
        const save = db.prepare('INSERT INTO direct_creative_cache VALUES(?,?,?,?,?,?,?) ON CONFLICT(ad_id) DO UPDATE SET campaign_id=excluded.campaign_id,group_id=excluded.group_id,title=excluded.title,text=excluded.text,kind=excluded.kind,updated_at=excluded.updated_at');
        for (const ad of data.result.Ads) {
          if (![ad.Id,ad.CampaignId,ad.AdGroupId].every(numericId)) continue;
          const responsive = ad.Type === 'RESPONSIVE_AD';
          const title = responsive ? (ad.ResponsiveAd?.Titles || []).map(x=>x.Title).filter(x=>typeof x==='string').slice(0,8).join(' / ') : [ad.TextAd?.Title,ad.TextAd?.Title2].filter(Boolean).join(' / ');
          const text = responsive ? (ad.ResponsiveAd?.Texts || []).map(x=>x.Text).filter(x=>typeof x==='string').slice(0,8).join(' / ') : ad.TextAd?.Text;
          save.run(String(ad.Id),String(ad.CampaignId),String(ad.AdGroupId),safeText(title,600),safeText(text,1000),responsive?'responsive':'text',now);
        }
        setState('ads','ready',now);
      }
    } catch { setState('ads','error',now); }
  }
  const token = settings.yandexMetrikaToken || settings.yandexDirectToken;
  if (!token || !settings.yandexMetrikaCounterId) { setState('queries','unconfigured',now); return {ads:state('ads'),queries:state('queries')}; }
  const previous = state('queries');
  if (previous?.status === 'no_access' && Date.parse(previous.updated_at) > at.getTime()-3600000) return {ads:state('ads'),queries:previous};
  const hasClient = db.prepare('PRAGMA table_info(landing_visits)').all().some(x=>x.name==='metrika_client_id');
  const visits = hasClient ? db.prepare(`SELECT v.* FROM landing_visits v LEFT JOIN landing_ad_enrichment e ON e.visit_id=v.id
    WHERE v.metrika_client_id IS NOT NULL AND (v.telegram_clicked_at IS NOT NULL OR v.max_clicked_at IS NOT NULL)
    AND v.opened_at>=? AND (e.visit_id IS NULL OR (e.query_status!='ready' AND e.updated_at<?))
    ORDER BY COALESCE(e.updated_at,'') ASC,v.opened_at DESC LIMIT 20`).all(new Date(at.getTime()-30*86400000).toISOString(),new Date(at.getTime()-3600000).toISOString()) : [];
  // Verify access even before the first linked visit; empty history is not proof of access.
  if (!visits.length) {
    if (previous && Date.parse(previous.updated_at)>at.getTime()-3600000) return {ads:state('ads'),queries:previous};
    try {
      const url = new URL('https://api-metrika.yandex.net/stat/v1/data');
      url.search = new URLSearchParams({ids:String(settings.yandexMetrikaCounterId),metrics:'ym:s:visits',date1:'today',date2:'today',limit:'1'}).toString();
      const r = await transport(url,{headers:{Authorization:`OAuth ${token}`},signal:AbortSignal.timeout(10000)});
      const okay = r.ok && !(await boundedJson(r)).errors;
      setState('queries',[401,403].includes(r.status)?'no_access':okay?'ready':'error',now);
    } catch { setState('queries','error',now); }
    return {ads:state('ads'),queries:state('queries')};
  }
  let status = 'ready';
  for (const visit of visits) {
    let result;
    try {
      const r = await transport(metrikaJourneyRequest(visit,settings,at),{headers:{Authorization:`OAuth ${token}`},signal:AbortSignal.timeout(10000)});
      if ([401,403].includes(r.status)) { status='no_access'; break; }
      if (!r.ok) {status='error';break;}
      result=interpretMetrikaJourney(await boundedJson(r),visit);
    } catch {status='error';break;}
    db.prepare('INSERT INTO landing_ad_enrichment VALUES(?,?,?,?) ON CONFLICT(visit_id) DO UPDATE SET search_query=excluded.search_query,query_status=excluded.query_status,updated_at=excluded.updated_at').run(visit.id,result.query,result.status,now);
  }
  setState('queries',status,now);
  return {ads:state('ads'),queries:state('queries')};
}
let timer, running;
export function startJourneyEnrichmentScheduler() {
  if (timer || config.testContour || config.dashboardPreview || config.botPlatform==='max') return;
  const tick=()=>{if (!running) running=syncJourneyEnrichment().catch(()=>log('warn','journey_enrichment_failed')).finally(()=>{running=null;});};
  timer=setInterval(tick,5*60000);timer.unref();tick();
}
export function stopJourneyEnrichmentScheduler() {clearInterval(timer);timer=null;}
