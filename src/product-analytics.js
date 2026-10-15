import { productContext as context, markProductError } from './product-context.js';
import { randomUUID } from 'node:crypto';
import { db } from './db.js';
import { config } from './config.js';
import { trialReminderReport } from './trial-reminders.js';

// No message text, queries, URLs, credentials, or provider payloads belong here.
export const clientEvents = ['screen_view', 'step_submit', 'plan_selected', 'checkout_clicked', 'provider_opened', 'client_error', 'request_visible', 'request_preview_visible', 'telemetry_health', 'telemetry_receipt'];
const benefitsEvents = ['benefits_view', 'benefits_close', 'benefits_cta'];
export const publicEvents = ['catalog_list', 'catalog_search', 'catalog_empty', 'catalog_filter', 'catalog_open', 'catalog_favorite_add', 'catalog_favorite_remove', 'catalog_share', 'catalog_print', ...benefitsEvents, 'client_error', 'telemetry_health'];
export const steps = ['boot', 'home', 'request', 'onboarding', 'household', 'time', 'exclusions', 'taste', 'intake', 'confirmation', 'notifications', 'collection', 'benefits', 'trial', 'offer', 'checkout', 'payment_result', 'recipe', 'import', 'catalog', 'other'];
const idPattern = /^[a-zA-Z0-9_-]{16,80}$/;
const exists = name => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
db.exec(`CREATE TABLE IF NOT EXISTS product_events (
 id TEXT NOT NULL, subject TEXT NOT NULL, user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
 event TEXT NOT NULL, step TEXT NOT NULL, flow_id TEXT, duration_ms INTEGER,
 detail_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(subject,id));
 CREATE INDEX IF NOT EXISTS product_events_user_time ON product_events(user_id,created_at);
 CREATE TABLE IF NOT EXISTS product_analytics_metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
db.prepare("INSERT OR IGNORE INTO product_analytics_metadata VALUES('tracking_since',?)").run(new Date().toISOString());
db.prepare("INSERT OR IGNORE INTO product_analytics_metadata VALUES('catalog_benefits_since',?)").run(new Date().toISOString());
export const productTrackingSince = () => db.prepare("SELECT value FROM product_analytics_metadata WHERE key='tracking_since'").get().value;
let writeFailures = 0;
export function recordProduct(userId, event, { id = randomUUID(), visitor = null, step = 'other', flowId = null, durationMs = null, detail = {}, at = new Date().toISOString() } = {}) {
  try {
    return Boolean(db.prepare('INSERT OR IGNORE INTO product_events VALUES(?,?,?,?,?,?,?,?,?)')
      .run(id, userId ? 'u:' + userId : 'v:' + visitor, userId || null, event, step, flowId, durationMs, JSON.stringify(detail), at).changes);
  } catch { writeFailures++; return false; } // Analytics must not break the product.
}
export function acceptProductEvents(userId, input) {
  const invalid = () => { throw Object.assign(new Error('Неверное событие аналитики'), { status: 400 }); };
  if (!input || !Array.isArray(input.events) || input.events.length < 1 || input.events.length > 30) return invalid();
  if (!userId && !idPattern.test(input.visitor || '')) return invalid();
  // Validate the entire batch before writing; retries use the same event IDs.
  const rows = input.events.map(row => {
    if (!idPattern.test(row.id || '') || !(userId ? clientEvents : publicEvents).includes(row.event)
      || !steps.includes(row.step) || (row.flowId != null && !idPattern.test(row.flowId))) return invalid();
    if (benefitsEvents.includes(row.event) && (row.step !== 'catalog' || !idPattern.test(row.flowId || '')
      || row.event !== 'benefits_view' && row.durationMs == null)) return invalid();
    const detail = {};
    for (const k of ['attempts', 'recoveredAttempts', 'dropped', 'pending', 'ageMs', 'months', 'results', 'filters']) {
      if (row[k] !== undefined) {
        if (!Number.isSafeInteger(row[k]) || row[k] < 0 || row[k] > 86400000) return invalid();
        detail[k] = row[k];
      }
    }
    if (row.version !== undefined && !/^[a-zA-Z0-9.-]{1,40}$/.test(row.version)) return invalid();
    detail.version = row.version || 'unknown';
    if (row.session !== undefined && !idPattern.test(row.session)) return invalid();
    detail.session = row.session || 'legacy';
    if (row.code !== undefined) {
      if (!['script', 'promise', 'network', 'http', 'timeout', 'storage', 'queue', 'auth', 'expired'].includes(row.code)) return invalid();
      detail.code = row.code;
    }
    if (row.durationMs != null && (!Number.isSafeInteger(row.durationMs) || row.durationMs < 0 || row.durationMs > 86400000)) return invalid();
    return { event: row.event, options: { id: row.id, visitor: userId ? null : input.visitor, step: row.step,
      flowId: row.flowId || null, durationMs: row.durationMs ?? null, detail,
      at: new Date(Date.now() - Math.min(86400000, row.ageMs || 0)).toISOString() } };
  });
  const accepted = [];
  for (const row of rows) {
    const inserted = recordProduct(userId, row.event, row.options);
    if (inserted || db.prepare('SELECT 1 FROM product_events WHERE subject=? AND id=?').get(userId ? 'u:' + userId : 'v:' + input.visitor, row.options.id)) accepted.push(row.options.id);
  }
  return { accepted };
}
export function identifyProductUser(userId) { const c = context.getStore(); if (c) c.userId = userId; }
export function identifyProductStep(step) { const c = context.getStore(); if (c && steps.includes(step)) c.step = step; }
export function productMilestone(event) {
  const c = context.getStore();
  if (c?.userId) recordProduct(c.userId, event, { step: c.step, flowId: c.id, durationMs: Date.now() - c.started });
}
export const productError = markProductError;
export function productOperation(step, fn, { userId = null, flowId = null } = {}) {
  const c = { step, id: idPattern.test(flowId || '') ? flowId : randomUUID(), started: Date.now(), userId };
  return context.run(c, async () => {
    try { const result = await fn(c); return result; }
    catch (error) { c.error = Number(error.status) || 500; throw error; }
    finally { if (c.userId) recordProduct(c.userId, 'operation_finished', { step:c.step, flowId: c.id, durationMs: Date.now() - c.started, detail: { status: c.status >= 400 ? c.status : c.error || c.status || 200 } });
      else if ((c.error || c.status || 200)>=400) recordProduct(null,'auth_error',{visitor:c.id,step,detail:{status:c.error||c.status}}); }
  });
}
export function validProductReport(value, { legacy = false } = {}) {
  const numeric = x => x === null || Number.isFinite(x) && x >= 0;
  if (!value || value.platform !== 'max' || !Number.isFinite(Date.parse(value.trackingSince))) return false;
  if (legacy && (value.trialReminders != null || value.catalogBenefits != null)) return false;
  if (!legacy) {
  const r = value.trialReminders;
  if (!r || !Number.isFinite(Date.parse(r.trackingSince))
    || !['enrolled','deliveries','sent','sentUsers','clicked','optedOut','failed','unknown','waiting','eligible24h','added24h'].every(k=>Number.isSafeInteger(r[k])&&r[k]>=0)
    || r.sent+r.failed+r.unknown+r.waiting!==r.deliveries || r.sentUsers>r.sent || r.clicked>r.deliveries
    || r.optedOut>r.enrolled || r.eligible24h>r.sentUsers || r.added24h>r.eligible24h || r.rate24h!==p(r.added24h,r.eligible24h)) return false;
  for (const key of ['deliveryTiming','clickTiming']) {
    const t=r[key];
    if (!t || !Number.isSafeInteger(t.samples) || t.samples<0 || t.samples>r.sent || !numeric(t.p50) || !numeric(t.p95)
      || (t.samples===0 ? t.p50!==null || t.p95!==null : t.p50===null || t.p95===null || t.p50>t.p95)) return false;
  }
  }
  if (!Array.isArray(value.steps) || value.steps.length !== steps.length-1 || value.steps.some(r => !steps.includes(r.step) || !['viewed','submitted','operations','errors','errorUsers','p50','p95'].every(k => numeric(r[k])) || r.errors>r.operations)) return false;
  if (!Array.isArray(value.retention) || value.retention.length>60 || value.retention.some(r => !/^\d{4}-\d\d-\d\d$/.test(r.date) || !['users','d1Eligible','d1','d7Eligible','d7','d1Rate','d7Rate'].every(k=>numeric(r[k])) || r.d1>r.d1Eligible || r.d7>r.d7Eligible || r.d1Eligible>r.users || r.d7Eligible>r.users)) return false;
  if (!Array.isArray(value.checkout?.ordered) || value.checkout.ordered.length!==5 || value.checkout.ordered.some((n,i,a)=>!Number.isSafeInteger(n)||n<0||(i&&n>a[i-1]))) return false;
  const b = value.catalogBenefits;
  if (!legacy && b !== null) {
    if (!b || !Number.isFinite(Date.parse(b.trackingSince))
      || !['views','visits','closes','ctas','unmatchedActions'].every(k => Number.isSafeInteger(b[k]) && b[k] >= 0)
      || b.visits > b.views || b.closes > b.views || b.ctas > b.views || b.ctr !== p(b.ctas,b.views)) return false;
    for (const key of ['closeTiming','ctaTiming']) {
      const t = b[key], expected = key === 'closeTiming' ? b.closes : b.ctas;
      if (!t || t.samples !== expected || !numeric(t.p50) || !numeric(t.p95)
        || (expected === 0 ? t.p50 !== null || t.p95 !== null : t.p50 === null || t.p95 === null || t.p50 > t.p95 || t.p95 > 86400000)) return false;
    }
  }
  const safe = (v,k='') => {
    if (v===null) return true;
    if (typeof v==='number') return numeric(v);
    if (typeof v==='string') return ['platform','trackingSince','lastEvent','date','step','event','versions','code','version'].includes(k) && v.length<80;
    if (Array.isArray(v)) return v.length<=100 && v.every(x=>safe(x,k));
    if (v&&typeof v==='object') return Object.entries(v).every(([key,x])=> !/user_id|subject|detail_json|flow_id|token|secret/.test(key)&&safe(x,key));
    return false;
  };
  return ['quality','reasons','provider','imports','notifications','checkout','timing','health'].every(k=>value[k]&&typeof value[k]==='object') && safe(value);
}
export function apiStep(path) {
  if (/\/prefetch$|\/exposure$/.test(path)) return null;
  if (/^\/api\/(analytics|engagement|dashboard|internal|catalog|test|landing)/.test(path)) return null;
  if (path === '/api/me') return 'boot';
  if (/billing\/orders/.test(path)) return 'checkout';
  if (/billing\/trial/.test(path)) return 'trial';
  if (/billing/.test(path)) return 'offer';
  if (/transcribe|recipe-request|suggest/.test(path)) return 'request';
  if (/dinner\/(profile|onboarding)/.test(path)) return 'onboarding';
  if (/dinner/.test(path)) return 'request';
  if (/notifications/.test(path)) return 'notifications';
  if (/import/.test(path)) return 'import';
  return null;
}
const day = at => Math.floor((Date.parse(at) + 10800000) / 86400000);
const p = (n, d) => d ? Math.round(n / d * 1000) / 10 : null;
const percentile = (values, fraction) => values.length ? values.sort((a,b) => a-b)[Math.max(0, Math.ceil(values.length * fraction) - 1)] : null;
export function productReport(cohort, campaign = false, at = new Date().toISOString()) {
  const users = new Map(cohort.map(u => [u.id, u]));
  const eligible = row => users.has(row.user_id) && (!campaign || row.created_at >= users.get(row.user_id).started_at);
  const rows = db.prepare('SELECT * FROM product_events ORDER BY created_at,rowid').all();
  const events = rows.filter(r => r.user_id && eligible(r));
  const positions = new Map(events.map((r,i)=>[r,i]));
  const engagement = exists('recipe_engagement') ? db.prepare("SELECT user_id,created_at FROM recipe_engagement WHERE event='recipe_opened' ORDER BY created_at").all().filter(eligible) : [];
  const countUsers = (list, event) => new Set(list.filter(r => r.event === event).map(r => r.user_id || r.subject)).size;
  const stepRows = steps.filter(s => s !== 'catalog').map(step => {
    const list = events.filter(r => r.step === step), operations = list.filter(r => r.event === 'operation_finished');
    const errors = operations.filter(r => JSON.parse(r.detail_json).status >= 400);
    const lastViews = new Map(list.filter(r=>r.event==='screen_view').map(r=>[r.user_id,r]));
    const abandoned = new Set([...lastViews.values()].filter(r => Date.parse(at)-Date.parse(r.created_at)>=86400000
      && !events.some(s=>s.user_id===r.user_id && positions.get(s)>positions.get(r)
        && (s.event==='step_submit' || s.event==='screen_view' && s.step!==step))
      && !engagement.some(s=>s.user_id===r.user_id && Date.parse(s.created_at)>=Date.parse(r.created_at))).map(r=>r.user_id));
    return { step, viewed: countUsers(list, 'screen_view'), submitted: countUsers(list, 'step_submit'), prompts:countUsers(list,'chat_prompt_delivered'), inactive:abandoned.size, operations: operations.length,
      errors: errors.length, errorUsers: new Set(errors.map(r => r.user_id)).size,
      p50: percentile(operations.map(r => r.duration_ms), .5), p95: percentile(operations.map(r => r.duration_ms), .95) };
  });
  const visible = events.filter(r => r.event === 'request_visible'), delivered = events.filter(r => r.event === 'recipe_delivered');
  const timing = list => ({ samples: list.length, p50: percentile(list.map(r => r.duration_ms), .5), p95: percentile(list.map(r => r.duration_ms), .95) });
  const dinner = exists('dinner_events') ? db.prepare('SELECT user_id,event,created_at,detail_json FROM dinner_events').all().filter(eligible) : [];
  const quality = Object.fromEntries(['onboarding_started','onboarding_completed','taste_preferences_completed','taste_preferences_skipped','dinner_intake_confirmed','recommendation_accepted','recommendation_rejected','dinner_retry','recipe_cooked'].map(event => [event, countUsers(dinner, event)]));
  const reasons = {};
  for (const r of dinner.filter(r => r.event === 'dinner_rejection_reason')) {
    const reason = JSON.parse(r.detail_json).reason;
    const safe = ['dislike','ingredients','time','complexity','other'].includes(reason) ? reason : 'other';
    reasons[safe] = (reasons[safe] || 0) + 1;
  }
  const provider = exists('provider_requests') ? db.prepare('SELECT user_id,created_at,status,input_units,output_units,usage_complete FROM provider_requests').all().filter(eligible) : [];
  const imports = exists('import_jobs') ? db.prepare('SELECT user_id,created_at,status FROM import_jobs').all().filter(eligible) : [];
  const notifications = exists('notification_deliveries') ? db.prepare('SELECT user_id,created_at,status FROM notification_deliveries').all().filter(eligible) : [];
  const groupStatuses = list => Object.fromEntries([...new Set(list.map(r => r.status))].map(status => [status,list.filter(r => r.status === status).length]));
  const orders = exists('payment_orders') && db.prepare('PRAGMA table_info(payment_orders)').all().some(c => c.name === 'is_test')
    ? db.prepare('SELECT id,user_id,created_at,status,paid_at FROM payment_orders WHERE is_test=0 ORDER BY created_at').all().filter(eligible) : [];
  const checkout = Object.fromEntries(['plan_selected','checkout_clicked','provider_opened'].map(event => [event, countUsers(events,event)]));
  checkout.offer = countUsers(events.filter(r => r.step === 'offer'), 'screen_view');
  checkout.orders = new Set(orders.map(r => r.user_id)).size;
  checkout.paid = new Set(orders.filter(r => r.status === 'paid').map(r => r.user_id)).size;
  checkout.statuses = groupStatuses(orders);
  checkout.returnSuccess = countUsers(events.filter(r=>JSON.parse(r.detail_json).outcome==='success'),'provider_return');
  checkout.returnFail = countUsers(events.filter(r=>JSON.parse(r.detail_json).outcome==='fail'),'provider_return');
  // Ordered conversion only uses the new observation window. Never divide old payments by new impressions.
  checkout.ordered = [0,0,0,0,0];
  for (const user of cohort) {
    const list = events.filter(r => r.user_id === user.id);
    const offerIndex = list.findIndex(r => r.step === 'offer' && r.event === 'screen_view');
    const offer = list[offerIndex];
    const click = offer && list.find((r,i) => i>offerIndex && r.event === 'checkout_requested' && r.created_at >= offer.created_at);
    const ready = click && list.find(r => r.event === 'order_ready' && r.created_at >= click.created_at);
    const order = ready && orders.find(r => r.user_id === user.id && r.id === JSON.parse(ready.detail_json).orderId);
    const redirect = order && list.find(r => r.event === 'provider_handoff' && JSON.parse(r.detail_json).orderId === order.id && r.created_at >= ready.created_at);
    const paid = redirect && order.status === 'paid' && order.paid_at >= redirect.created_at;
    [offer,click,order,redirect,paid].forEach((v,i) => { if(v) checkout.ordered[i]++; });
  }
  const byUser = new Map();
  for (const r of engagement) { if (!byUser.has(r.user_id)) byUser.set(r.user_id,new Set()); byUser.get(r.user_id).add(day(r.created_at)); }
  const cohorts = new Map();
  for (const days of byUser.values()) {
    const first = Math.min(...days);
    if (!cohorts.has(first)) cohorts.set(first, { date: new Date(first*86400000).toISOString().slice(0,10), users: 0, d1Eligible:0,d1:0,d7Eligible:0,d7:0 });
    const row = cohorts.get(first); row.users++;
    for (const n of [1,7]) if (day(at) > first+n) { row[`d${n}Eligible`]++; if (days.has(first+n)) row[`d${n}`]++; }
  }
  const retention = [...cohorts.values()].sort((a,b) => b.date.localeCompare(a.date)).slice(0,60).map(r => ({...r,d1Rate:p(r.d1,r.d1Eligible),d7Rate:p(r.d7,r.d7Eligible)}));
  const publicRows = campaign ? [] : rows.filter(r => !r.user_id && r.step === 'catalog');
  const catalog = campaign ? null : publicEvents.filter(e => e.startsWith('catalog_')).map(event => ({ event, events: publicRows.filter(r => r.event===event).length, visits: countUsers(publicRows,event) }));
  // A public visit is a browser tab, not an account. Count each visible presentation once,
  // and match actions to its random flow within the same anonymous subject.
  const benefitFlows = new Map();
  for (const r of publicRows.filter(r => benefitsEvents.includes(r.event) && r.flow_id)) {
    const key = r.subject + ':' + r.flow_id;
    if (!benefitFlows.has(key)) benefitFlows.set(key, []);
    benefitFlows.get(key).push(r);
  }
  const benefitViews = [], benefitCloses = [], benefitCtas = [];
  let unmatchedActions = 0;
  for (const list of benefitFlows.values()) {
    const view = list.find(r => r.event === 'benefits_view');
    if (view) benefitViews.push(view);
    for (const [event, target] of [['benefits_close', benefitCloses], ['benefits_cta', benefitCtas]]) {
      const actions = list.filter(r => r.event === event);
      const action = view && actions.find(r => r.created_at >= view.created_at && Number.isSafeInteger(r.duration_ms));
      if (action) target.push(action);
      else if (actions.length) unmatchedActions++;
    }
  }
  const catalogBenefits = campaign ? null : {
    trackingSince: db.prepare("SELECT value FROM product_analytics_metadata WHERE key='catalog_benefits_since'").get().value,
    views: benefitViews.length, visits: new Set(benefitViews.map(r => r.subject)).size,
    closes: benefitCloses.length, ctas: benefitCtas.length, ctr: p(benefitCtas.length,benefitViews.length),
    closeTiming: timing(benefitCloses), ctaTiming: timing(benefitCtas), unmatchedActions
  };
  const health = list => {
    const reports = list.filter(r => r.event === 'telemetry_health');
    const last = new Map(); for (const r of reports) {const d=JSON.parse(r.detail_json);last.set(r.subject+':'+d.session,d);}
    const details = [...last.values()];
    return { reports: reports.length, dropped: details.reduce((n,d)=>n+(d.dropped||0),0), pending:details.reduce((n,d)=>n+(d.pending||0),0), retried: list.filter(r => {const d=JSON.parse(r.detail_json);return (d.attempts||0)>1||(d.recoveredAttempts||0)>1;}).length,
      clientErrors:list.filter(r=>r.event==='client_error').length, authErrors:list.filter(r=>r.event==='auth_error').length, lastEvent:list.at(-1)?.created_at || null,
      versions:[...new Set(list.map(r=>JSON.parse(r.detail_json).version).filter(Boolean))].slice(-10) };
  };
  const errorGroups = new Map();
  for (const r of events) {
    const d=JSON.parse(r.detail_json);
    if(r.event!=='client_error' && !(r.event==='operation_finished' && d.status>=400)) continue;
    const code=d.code || 'http_'+d.status, version=d.version || 'server-product-1', key=[r.step,code,version].join(':');
    if(!errorGroups.has(key))errorGroups.set(key,{step:r.step,code,version,count:0});errorGroups.get(key).count++;
  }
  return { platform: config.botPlatform, trackingSince: productTrackingSince(), steps:stepRows, errors:[...errorGroups.values()].sort((a,b)=>b.count-a.count).slice(0,50), timing:{visible:timing(visible),preview:timing(events.filter(r=>r.event==='request_preview_visible')),delivered:timing(delivered)}, quality, reasons,
    provider:{calls:provider.length,errors:provider.filter(r=>r.status!=='ok').length,input:provider.reduce((n,r)=>n+r.input_units,0),output:provider.reduce((n,r)=>n+r.output_units,0),complete:provider.filter(r=>r.usage_complete).length},
    imports:groupStatuses(imports),notifications:groupStatuses(notifications), trialReminders:trialReminderReport(cohort,campaign,at), checkout,retention,catalog,catalogBenefits,health:health(events),publicHealth:campaign?null:health(rows.filter(r=>!r.user_id)),writeFailures };
}
