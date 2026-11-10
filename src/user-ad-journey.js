import { db } from './db.js';
import { config } from './config.js';
import { analyticsExcludedIds, analyticsUserCondition } from './analytics-exclusions.js';

const ownPlatform = config.botPlatform === 'max' ? 'max' : 'telegram';
const pageSize = 10, timelineLimit = 30, bridgeLimit = 256000;
const exists = name => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const integer = n => Number.isSafeInteger(n) && n >= 0;
const safeCode = value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,80}$/.test(value) ? value : null;
const bounded = (value, max) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max) : null;
const json = text => { try { return JSON.parse(text) || {}; } catch { return {}; } };
const events = ['screen_view','workspace_view','workspace_action','workspace_interaction','workspace_saved','step_submit','client_error','operation_finished',
  'chat_prompt_delivered','recipe_delivered','trial_activated','checkout_requested','order_ready','provider_handoff','request_visible',
  'request_preview_visible','request_started','plan_selected','checkout_clicked','provider_opened','provider_return'];
const eventSql = events.map(e => "'" + e + "'").join(',');
db.exec('CREATE TABLE IF NOT EXISTS user_ad_journey_metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL)');
db.prepare("INSERT OR IGNORE INTO user_ad_journey_metadata VALUES('tracking_since',?)").run(new Date().toISOString());

export function userAdJourneyFilters(input = {}, platform = ownPlatform) {
  const get = key => input instanceof URLSearchParams ? input.get(key) : input[key];
  const result = { platform: get('platform') || platform, campaign: get('campaign') || 'all', from: get('from') || '', to: get('to') || '', page: Number(get('page') || 1), q: get('q') || '' };
  const fail = () => { throw Object.assign(new Error('Неверные параметры истории пользователей'), { status: 400 }); };
  if (!['telegram','max'].includes(result.platform) || !/^[a-z0-9][a-z0-9_-]{0,39}$/.test(result.campaign)
    || !integer(result.page) || result.page < 1 || result.page > 1000000 || typeof result.q !== 'string' || result.q.length > 100 || /[\u0000-\u001f]/.test(result.q)) fail();
  for (const date of [result.from, result.to]) if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !validTime(date) || new Date(date).toISOString().slice(0,10) !== date)) fail();
  if (result.from && result.to && result.from > result.to) fail();
  return result;
}

function unavailable(filters) {
  return { version: 1, ...filters, status: 'unavailable', generatedAt: new Date().toISOString(), trackingSince: null, pageSize, total: null, pages: null, users: [], error: 'История этой платформы временно недоступна. Это не отсутствие пользователей.' };
}

function observed(row) {
  const detail = json(row.detail_json);
  return { event: safeCode(row.event), step: safeCode(row.step), at: row.created_at,
    status: integer(detail.status) && detail.status <= 599 ? detail.status : null,
    code: safeCode(detail.code), durationMs: integer(row.duration_ms) ? row.duration_ms : null,
    feature: safeCode(detail.feature), action: safeCode(detail.action), kind: safeCode(detail.kind), outcome: safeCode(detail.outcome) };
}
const errorStep = row => row.event === 'client_error' || row.status >= 400 || ['error','fail'].includes(row.outcome) || row.event === 'import_failed';

function history(userId, at) {
  const rawRows = exists('product_events') ? db.prepare(`SELECT event,step,created_at,duration_ms,detail_json,flow_id FROM product_events
    WHERE user_id=? AND created_at<=? AND event IN (${eventSql}) ORDER BY created_at DESC,rowid DESC LIMIT ?`).all(userId, at, timelineLimit) : [];
  const rows = rawRows.map(row => {
    const result=observed(row);
    // A server operation and its existing workspace event share an operation ID.
    // Carry only their bounded action codes, never message/request contents.
    if(row.event==='operation_finished' && row.flow_id){
      const peer=rawRows.find(other=>other.flow_id===row.flow_id && ['workspace_action','workspace_saved'].includes(other.event));
      if(peer){const detail=json(peer.detail_json);result.action=safeCode(detail.action);result.feature=safeCode(detail.feature);}
    }
    return result;
  });
  const errors = exists('product_events') ? db.prepare(`SELECT event,step,created_at,duration_ms,detail_json FROM product_events
    WHERE user_id=? AND created_at<=? AND event IN (${eventSql}) AND (event='client_error'
      OR CASE WHEN json_valid(detail_json) THEN json_extract(detail_json,'$.status')>=400 OR json_extract(detail_json,'$.outcome') IN ('error','fail') ELSE 0 END)
    ORDER BY created_at DESC,rowid DESC LIMIT 1`).all(userId, at).map(observed) : [];
  return { rows, errors };
}

export function userAdJourneyReport(input = {}, { at = new Date().toISOString() } = {}) {
  const filters = userAdJourneyFilters(input);
  if (!validTime(at)) throw Object.assign(new Error('Неверное время отчёта'), { status: 400 });
  if (filters.platform !== ownPlatform) return unavailable(filters);
  const attr = exists('user_ad_attributions'), starts = exists('acquisition_starts');
  const joins = `${attr ? 'LEFT JOIN user_ad_attributions a ON a.user_id=u.id' : ''} ${starts ? 'LEFT JOIN acquisition_starts s ON s.user_id=u.id' : ''}`;
  const coalesce = field => attr && starts ? `COALESCE(a.${field},s.${field})` : attr ? `a.${field}` : starts ? `s.${field}` : 'NULL';
  const campaign = coalesce('campaign'), clickToken = coalesce('click_token');
  const conditions = [analyticsUserCondition, 'u.created_at<=?', filters.platform === 'max' ? "u.telegram_id LIKE 'max:%'" : "u.telegram_id NOT LIKE 'max:%'"];
  const values = [...analyticsExcludedIds, at];
  if (filters.campaign !== 'all') { conditions.push(`${campaign}=?`); values.push(filters.campaign); }
  if (filters.from) { conditions.push('u.created_at>=?'); values.push(new Date(filters.from + 'T00:00:00+03:00').toISOString()); }
  if (filters.to) { conditions.push('u.created_at<?'); values.push(new Date(Date.parse(filters.to + 'T00:00:00+03:00') + 86400000).toISOString()); }
  if (filters.q) {
    conditions.push("(u.telegram_id LIKE ? ESCAPE '\\' OR u.display_name LIKE ? ESCAPE '\\' OR u.username LIKE ? ESCAPE '\\' OR u.id=?)");
    const pattern = '%' + filters.q.replace(/[\\%_]/g, '\\$&') + '%'; values.push(pattern,pattern,pattern,filters.q);
  }
  const where = conditions.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) AS n FROM users u ${joins} WHERE ${where}`).get(...values).n;
  const linkedAt = attr && starts ? 'COALESCE(a.bound_at,s.started_at)' : attr ? 'a.bound_at' : starts ? 's.started_at' : 'NULL';
  const accounts = db.prepare(`SELECT u.*,${campaign} AS source_campaign,${clickToken} AS click_token,${linkedAt} AS linked_at,
    ${starts ? 's.started_at' : 'NULL'} AS chat_started_at FROM users u ${joins} WHERE ${where}
    ORDER BY u.created_at DESC,u.id DESC LIMIT ? OFFSET ?`).all(...values,pageSize,(filters.page-1)*pageSize);
  const users = accounts.map(user => {
    const click = user.click_token && exists('acquisition_clicks') ? db.prepare('SELECT tags_json FROM acquisition_clicks WHERE token=?').get(user.click_token) : null;
    const tags = json(click?.tags_json);
    const h = history(user.id,at);
    const recipes = db.prepare("SELECT COUNT(*) AS total,MIN(created_at) AS first_at,MAX(created_at) AS last_at FROM recipes WHERE user_id=? AND status='ready' AND created_at<=?").get(user.id,at);
    const imports = db.prepare("SELECT COUNT(*) AS total,SUM(CASE WHEN status IN ('failed','interrupted') THEN 1 ELSE 0 END) AS failed FROM import_jobs WHERE user_id=? AND created_at<=?").get(user.id,at);
    const lastImport = db.prepare('SELECT status,error_code,updated_at FROM import_jobs WHERE user_id=? AND updated_at<=? ORDER BY updated_at DESC LIMIT 1').get(user.id,at);
    const failedImport = db.prepare("SELECT error_code,updated_at FROM import_jobs WHERE user_id=? AND updated_at<=? AND status IN ('failed','interrupted') ORDER BY updated_at DESC LIMIT 1").get(user.id,at);
    const savedTimes = db.prepare(`SELECT MIN(at) AS first_at,MAX(at) AS last_at FROM (
      SELECT updated_at AS at FROM import_jobs WHERE user_id=? AND status='ready' AND recipe_id IS NOT NULL AND updated_at<=?
      ${exists('product_events') ? "UNION ALL SELECT created_at AS at FROM product_events WHERE user_id=? AND created_at<=? AND event='workspace_saved' AND CASE WHEN json_valid(detail_json) THEN json_extract(detail_json,'$.action')='collections.saveCatalog' ELSE 0 END" : ''}
    )`).get(...(exists('product_events') ? [user.id,at,user.id,at] : [user.id,at]));
    const trialAt = exists('user_trials') ? db.prepare('SELECT starts_at FROM user_trials WHERE user_id=? AND starts_at<=?').get(user.id,at)?.starts_at || null : null;
    const payment = exists('payment_orders') && db.prepare('PRAGMA table_info(payment_orders)').all().some(c => c.name === 'is_test')
      ? db.prepare("SELECT MAX(paid_at) AS at FROM payment_orders WHERE user_id=? AND status='paid' AND is_test=0 AND paid_at<=?").get(user.id,at)?.at || null : null;
    const extra = (event, step, when, code = null) => when ? { event,step,at:when,status:null,code,durationMs:null,feature:null,action:null,kind:null,outcome:null } : null;
    const milestones = [extra('account_created','boot',user.created_at),extra('chat_started','home',user.chat_started_at),
      extra('recipe_record_created','collection',recipes.last_at),extra('recipe_saved','collection',savedTimes.last_at),extra('trial_activated','trial',trialAt),extra('payment_confirmed','payment_result',payment),
      lastImport && extra(['failed','interrupted'].includes(lastImport.status) ? 'import_failed' : lastImport.status === 'ready' ? 'import_ready' : 'import_processing','import',lastImport.updated_at,safeCode(lastImport.error_code))].filter(Boolean);
    const timeline = [...h.rows,...milestones].sort((a,b) => b.at.localeCompare(a.at)).slice(0,timelineLimit);
    const importError = failedImport ? extra('import_failed','import',failedImport.updated_at,safeCode(failedImport.error_code)) : null;
    const lastError = [...h.errors,...milestones.filter(errorStep),...(importError?[importError]:[])].sort((a,b) => b.at.localeCompare(a.at))[0] || null;
    const campaignName = user.source_campaign && exists('acquisition_campaigns') ? db.prepare('SELECT name FROM acquisition_campaigns WHERE slug=?').get(user.source_campaign)?.name || null : null;
    return { userId:user.id,platform:ownPlatform,displayName:bounded(user.display_name,120),username:bounded(user.username,80),accountId:bounded(user.telegram_id,100),
      createdAt:user.created_at,chatStartedAt:user.chat_started_at,campaign:user.source_campaign,campaignName,clickToken:user.click_token,linkedAt:user.linked_at,
      ad:{id:bounded(tags.utm_content,160),groupId:bounded(tags.adgroup_id,64),campaignId:bounded(tags.campaign_id,64),title:null,text:null},
      search:{query:null,status:user.click_token?'pending':'unlinked',keyword:bounded(tags.utm_term,256)},lastStep:timeline[0]||null,lastError,
      outcomes:{savedRecipes:recipes.total,firstSavedAt:savedTimes.first_at,lastSavedAt:savedTimes.last_at,imports:imports.total,failedImports:imports.failed||0,trialAt,paidAt:payment},timeline };
  });
  return { version:1,...filters,status:'ready',generatedAt:at,trackingSince:(exists('acquisition_metadata')?db.prepare("SELECT value FROM acquisition_metadata WHERE key='user_ad_attribution_since'").get()?.value:null) || db.prepare("SELECT value FROM user_ad_journey_metadata WHERE key='tracking_since'").get().value,
    pageSize,total,pages:Math.ceil(total/pageSize),users,error:null };
}

export function validUserAdJourneyReport(report, expected = null) {
  if (!report || report.version !== 1 || report.status !== 'ready' || !['telegram','max'].includes(report.platform)
    || !validTime(report.generatedAt) || !validTime(report.trackingSince) || report.pageSize !== pageSize || !integer(report.total)
    || report.pages !== Math.ceil(report.total/pageSize) || !integer(report.page) || report.page < 1 || !Array.isArray(report.users)
    || report.users.length > pageSize || report.users.length > report.total || new Set(report.users.map(u=>u?.userId)).size !== report.users.length) return false;
  if (expected && ['campaign','platform','from','to','page','q'].some(key => report[key] !== expected[key])) return false;
  const str = (value,max,nullable=true) => nullable && value===null || typeof value==='string' && value.length<=max;
  const time = value => value===null || validTime(value);
  const step = value => value===null || value && safeCode(value.event) && safeCode(value.step) && validTime(value.at)
    && (value.status===null || integer(value.status) && value.status<=599) && (value.durationMs===null || integer(value.durationMs))
    && value.at<=report.generatedAt && ['code','feature','action','kind','outcome'].every(key => value[key]===null || safeCode(value[key]));
  for (const u of report.users) {
    if (!u || u.platform!==report.platform || !str(u.userId,80,false) || !str(u.displayName,120,false) || !str(u.username,80) || !str(u.accountId,100,false)
      || u.platform==='max'!==u.accountId.startsWith('max:') || u.createdAt>report.generatedAt
      || !validTime(u.createdAt) || !time(u.chatStartedAt) || !time(u.linkedAt) || !str(u.campaign,40) || !str(u.campaignName,160)
      || !(u.clickToken===null || typeof u.clickToken==='string' && /^[a-zA-Z0-9_-]{8,128}$/.test(u.clickToken))
      || !u.ad || !['id','groupId','campaignId'].every(k=>str(u.ad[k],160)) || !str(u.ad.title,300) || !str(u.ad.text,1000)
      || !u.search || !str(u.search.query,500) || !str(u.search.keyword,256) || !['unknown','not_available','pending','ready','unconfigured','error','ambiguous','no_access','no_client_id','unlinked','not_search'].includes(u.search.status)
      || !step(u.lastStep) || !step(u.lastError) || !Array.isArray(u.timeline) || u.timeline.length>timelineLimit || !u.timeline.every(step)
      || !u.outcomes || !['savedRecipes','imports','failedImports'].every(k=>integer(u.outcomes[k])) || u.outcomes.failedImports>u.outcomes.imports
      || !['firstSavedAt','lastSavedAt','trialAt','paidAt'].every(k=>time(u.outcomes[k]))) return false;
  }
  return true;
}

export async function dashboardUserAdJourneys(input = {}, { transport=fetch, origin=config.maxFunnelOrigin, token=config.maxFunnelToken,
  remoteEnabled=!config.testContour && ownPlatform==='telegram' } = {}) {
  const filters=userAdJourneyFilters(input);
  if (filters.platform===ownPlatform) return userAdJourneyReport(filters);
  if (!remoteEnabled || filters.platform!=='max') return unavailable(filters);
  try {
    if (origin!=='https://recipeboibot-max.89-223-123-75.sslip.io' || !/^[A-Za-z0-9_-]{43,128}$/.test(token)) throw new Error('configuration');
    const response=await transport(origin+'/api/internal/user-ad-journeys?'+new URLSearchParams(Object.entries(filters).map(([k,v])=>[k,String(v)])),
      {headers:{authorization:'Bearer '+token},signal:AbortSignal.timeout(5000),redirect:'error'});
    if (!response.ok || !response.body?.getReader) throw new Error('unavailable');
    const reader=response.body.getReader(),decoder=new TextDecoder();let text='',size=0;
    try { for (;;) {const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>bridgeLimit)throw new Error('size');text+=decoder.decode(value,{stream:true});}text+=decoder.decode(); }
    finally { reader.releaseLock();if(size>bridgeLimit)await response.body.cancel(); }
    const result=JSON.parse(text);if(!validUserAdJourneyReport(result,filters))throw new Error('schema');return result;
  } catch { return unavailable(filters); }
}
