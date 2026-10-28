import { db } from './db.js';
import { analyticsExcludedIds } from './analytics-exclusions.js';

export const catalogJourney = 'recipe-first-v1';
export const catalogJourneyPublicEvents = ['catalog_save_intent', 'catalog_platform_selected', 'catalog_handoff_ready', 'catalog_handoff_error'];
const publicStages = new Set(['catalog_list', 'catalog_open', ...catalogJourneyPublicEvents]);
const serverEvents = new Set(['catalog_bot_started', 'catalog_recipe_saved', 'catalog_save_failed']);
const platforms = ['telegram', 'max'];
const idPattern = /^[a-zA-Z0-9_-]{16,80}$/;
const serverCodes = new Set(['invalid', 'expired', 'network', 'not_found', 'failed']);
const now = () => new Date().toISOString();
const ratio = (n, d) => d ? Number((100 * n / d).toFixed(1)) : null;
const count = n => Number.isSafeInteger(n) && n >= 0;

// This is the relationship between a public visit and a server-confirmed
// handoff, not a second copy of the catalogue's client event log.
db.exec(`CREATE TABLE IF NOT EXISTS catalog_journey_visits (
 flow_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, campaign TEXT,
 local_origin INTEGER NOT NULL DEFAULT 0, internal INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS catalog_journey_outcomes (
 flow_id TEXT NOT NULL REFERENCES catalog_journey_visits(flow_id),
 platform TEXT NOT NULL, event TEXT NOT NULL, created_at TEXT NOT NULL,
 duration_ms INTEGER, code TEXT, is_returning INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(flow_id,platform,event)
);
CREATE TABLE IF NOT EXISTS catalog_journey_metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
db.prepare("INSERT OR IGNORE INTO catalog_journey_metadata VALUES('tracking_since',?)").run(now());

function knownCampaign(value) {
  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(value || '')) return null;
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='acquisition_campaigns'").get()) return null;
  return db.prepare('SELECT slug FROM acquisition_campaigns WHERE slug=?').get(value)?.slug || null;
}
function register({ flowId, sessionId, campaign = null }, local, at = now()) {
  if (!idPattern.test(flowId || '') || !idPattern.test(sessionId || '')) return false;
  const previous = db.prepare('SELECT session_id FROM catalog_journey_visits WHERE flow_id=?').get(flowId);
  if (previous && previous.session_id !== sessionId) return false;
  db.prepare(`INSERT OR IGNORE INTO catalog_journey_visits(flow_id,session_id,campaign,local_origin,created_at)
    VALUES(?,?,?,?,?)`).run(flowId, sessionId, knownCampaign(campaign), local ? 1 : 0, at);
  if (local) db.prepare('UPDATE catalog_journey_visits SET local_origin=1 WHERE flow_id=?').run(flowId);
  return true;
}

export function registerCatalogJourneyHandoff(value) {
  try { return register(value, true); } catch { return false; }
}

export function recordCatalogJourneyPublic(row, visitor, at) {
  if (row.journey !== catalogJourney || row.step !== 'catalog' || !publicStages.has(row.event)) return;
  try { register({ flowId: row.flowId, sessionId: visitor, campaign: row.campaign }, true, at); } catch { /* Access never depends on analytics. */ }
}

// Called only by bot handlers and the authenticated, fixed-origin receipt
// bridge. No public event is allowed to assert a start or a saved recipe.
export function recordCatalogJourneyServer(type, {
  userId = null, flowId, sessionId, campaign = null, platform,
  durationMs = null, code = null, isReturning = false, isInternal = false, occurredAt = null
} = {}) {
  try {
    if (!serverEvents.has(type) || !platforms.includes(platform) || !register({ flowId, sessionId, campaign }, false)) return false;
    const user = userId == null ? null : db.prepare('SELECT telegram_id FROM users WHERE id=?').get(userId);
    if (userId != null && !user) return false;
    const internal = isInternal === true || Boolean(user && (analyticsExcludedIds.includes(user.telegram_id) || user.telegram_id.startsWith('private-test:')));
    if (internal) db.prepare('UPDATE catalog_journey_visits SET internal=1 WHERE flow_id=?').run(flowId);
    const duration = Number.isSafeInteger(durationMs) && durationMs >= 0 && durationMs <= 604800000 ? durationMs : null;
    const timestamp = typeof occurredAt === 'string' && Number.isFinite(Date.parse(occurredAt)) && Date.parse(occurredAt) <= Date.now() + 300000
      ? new Date(occurredAt).toISOString() : now();
    return Boolean(db.prepare(`INSERT OR IGNORE INTO catalog_journey_outcomes
      (flow_id,platform,event,created_at,duration_ms,code,is_returning) VALUES(?,?,?,?,?,?,?)`)
      .run(flowId, platform, type, timestamp, duration, serverCodes.has(code) ? code : null, isReturning === true ? 1 : 0).changes);
  } catch { return false; }
}

function timing(values) {
  const sorted = values.filter(v => Number.isFinite(v) && v >= 0 && v <= 604800000).sort((a, b) => a - b);
  const q = p => sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] : null;
  return { samples: sorted.length, p50: q(.5), p95: q(.95) };
}
const elapsed = (a, b) => a && b ? Date.parse(b.created_at) - Date.parse(a.created_at) : null;
const first = (rows, event, after = null) => rows.find(r => r.event === event && (!after || r.created_at >= after.created_at));

export function catalogJourneyReport(productRows, { campaign = null, at = now() } = {}) {
  const visits = db.prepare('SELECT * FROM catalog_journey_visits WHERE internal=0 ORDER BY created_at').all()
    .filter(v => !campaign || v.campaign === campaign);
  const local = new Map(visits.filter(v => v.local_origin).map(v => [v.flow_id, v]));
  const allIds = new Set(visits.map(v => v.flow_id));
  const publicByFlow = new Map(), outcomesByFlow = new Map();
  for (const row of productRows) {
    const visit = local.get(row.flow_id);
    if (!visit || row.user_id || row.subject !== 'v:' + visit.session_id || row.step !== 'catalog' || !publicStages.has(row.event)) continue;
    let detail; try { detail = JSON.parse(row.detail_json); } catch { continue; }
    if (detail.journey !== catalogJourney) continue;
    if (!publicByFlow.has(row.flow_id)) publicByFlow.set(row.flow_id, []);
    publicByFlow.get(row.flow_id).push({ ...row, platform: detail.platform });
  }
  const allOutcomes = db.prepare('SELECT * FROM catalog_journey_outcomes ORDER BY created_at,rowid').all().filter(r => allIds.has(r.flow_id));
  for (const row of allOutcomes) {
    if (!outcomesByFlow.has(row.flow_id)) outcomesByFlow.set(row.flow_id, []);
    outcomesByFlow.get(row.flow_id).push(row);
  }
  const result = {
    version: 1, trackingSince: db.prepare("SELECT value FROM catalog_journey_metadata WHERE key='tracking_since'").get().value,
    flows: local.size, visible: 0, fullRecipe: 0, saveIntent: 0, platformSelected: 0, handoffReady: 0,
    botStarted: 0, saved: 0, failed: 0, newStarts: 0, returningStarts: 0,
    eligible24h: 0, withoutStart24h: 0, unmatchedOutcomes: 0,
    targetOnlyStarts: new Set(allOutcomes.filter(r => !local.has(r.flow_id) && r.event === 'catalog_bot_started').map(r => r.flow_id)).size,
    targetOnlySaved: new Set(allOutcomes.filter(r => !local.has(r.flow_id) && r.event === 'catalog_recipe_saved').map(r => r.flow_id)).size,
    platforms: platforms.map(platform => ({ platform, selected: 0, ready: 0, started: 0, saved: 0, failed: 0 })),
  };
  const entryTimes = [], startTimes = [], saveTimes = [];
  for (const [flowId] of local) {
    const rows = (publicByFlow.get(flowId) || []).sort((a, b) => a.created_at.localeCompare(b.created_at));
    const outcomes = outcomesByFlow.get(flowId) || [];
    // Direct recipe URLs are valid entries; choosing from the list is optional.
    const entry = rows.find(r => ['catalog_list', 'catalog_open'].includes(r.event));
    const recipe = entry && first(rows, 'catalog_open', entry);
    const intent = recipe && first(rows, 'catalog_save_intent', recipe);
    const selected = intent && first(rows, 'catalog_platform_selected', intent);
    const ready = selected && first(rows, 'catalog_handoff_ready', selected);
    const chains = result.platforms.map(row => {
      const selectedPlatform = intent && rows.find(r => r.event === 'catalog_platform_selected' && r.platform === row.platform && r.created_at >= intent.created_at);
      const readyPlatform = selectedPlatform && rows.find(r => r.event === 'catalog_handoff_ready' && r.platform === row.platform && r.created_at >= selectedPlatform.created_at);
      const subset = outcomes.filter(r => r.platform === row.platform);
      const started = readyPlatform && first(subset, 'catalog_bot_started', readyPlatform);
      const saved = started && first(subset, 'catalog_recipe_saved', started);
      if (selectedPlatform) row.selected++;
      if (readyPlatform) row.ready++;
      if (started) row.started++;
      if (saved) row.saved++;
      if (subset.some(r => r.event === 'catalog_save_failed') || rows.some(r => r.event === 'catalog_handoff_error' && r.platform === row.platform)) row.failed++;
      return { ready: readyPlatform, started, saved };
    });
    const startChain = chains.filter(c => c.started).sort((a,b) => a.started.created_at.localeCompare(b.started.created_at))[0];
    const saveChain = chains.filter(c => c.saved).sort((a,b) => a.saved.created_at.localeCompare(b.saved.created_at))[0];
    const started = startChain?.started, saved = saveChain?.saved;
    if (entry) result.visible++;
    if (recipe) { result.fullRecipe++; entryTimes.push(elapsed(entry, recipe)); }
    if (intent) result.saveIntent++;
    if (selected) result.platformSelected++;
    if (ready) result.handoffReady++;
    if (started) { result.botStarted++; result[started.is_returning ? 'returningStarts' : 'newStarts']++; startTimes.push(elapsed(startChain.ready, started)); }
    if (saved) { result.saved++; saveTimes.push(elapsed(saveChain.ready, saved)); }
    if (rows.some(r => r.event === 'catalog_handoff_error') || outcomes.some(r => r.event === 'catalog_save_failed')) result.failed++;
    if (entry && Date.parse(at) - Date.parse(entry.created_at) >= 86400000) {
      result.eligible24h++;
      if (!started || elapsed(entry, started) > 86400000) result.withoutStart24h++;
    }
    if (outcomes.some(r => r.event === 'catalog_bot_started') && !started
      || outcomes.some(r => r.event === 'catalog_recipe_saved') && !saved) result.unmatchedOutcomes++;
  }
  result.recipeRate = ratio(result.fullRecipe, result.visible);
  result.startRate = ratio(result.botStarted, result.visible);
  result.saveRate = ratio(result.saved, result.visible);
  result.entryToRecipe = timing(entryTimes);
  result.handoffToStart = timing(startTimes);
  result.handoffToSaved = timing(saveTimes);
  return result;
}

export function validCatalogJourneyReport(r) {
  if (!r || r.version !== 1 || !Number.isFinite(Date.parse(r.trackingSince))) return false;
  const keys = ['flows','visible','fullRecipe','saveIntent','platformSelected','handoffReady','botStarted','saved','failed','newStarts','returningStarts','eligible24h','withoutStart24h','unmatchedOutcomes','targetOnlyStarts','targetOnlySaved'];
  if (!keys.every(k => count(r[k]))) return false;
  if (r.visible > r.flows || r.fullRecipe > r.visible || r.saveIntent > r.fullRecipe || r.platformSelected > r.saveIntent
    || r.handoffReady > r.platformSelected || r.botStarted > r.handoffReady || r.saved > r.botStarted
    || r.newStarts + r.returningStarts !== r.botStarted || r.eligible24h > r.visible || r.withoutStart24h > r.eligible24h
    || r.failed > r.flows || r.unmatchedOutcomes > r.flows) return false;
  if (r.recipeRate !== ratio(r.fullRecipe, r.visible) || r.startRate !== ratio(r.botStarted, r.visible) || r.saveRate !== ratio(r.saved, r.visible)) return false;
  if (!Array.isArray(r.platforms) || r.platforms.length !== 2 || r.platforms.some((p, i) => p.platform !== platforms[i]
    || !['selected','ready','started','saved','failed'].every(k => count(p[k]))
    || p.selected > r.platformSelected || p.ready > p.selected || p.started > p.ready || p.saved > p.started || p.failed > r.failed)) return false;
  for (const [key, bound] of [['entryToRecipe', r.fullRecipe], ['handoffToStart', r.botStarted], ['handoffToSaved', r.saved]]) {
    const t = r[key];
    if (!t || !count(t.samples) || t.samples > bound || (t.samples === 0 ? t.p50 !== null || t.p95 !== null
      : !Number.isFinite(t.p50) || !Number.isFinite(t.p95) || t.p50 < 0 || t.p95 < t.p50 || t.p95 > 604800000)) return false;
  }
  return true;
}
