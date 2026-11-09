// Workspace telemetry contains only closed enums, random operation IDs and time.
// Recipe names, ingredient text and planned dates belong to operational storage.
export const workspaceFeatures = Object.freeze(['collections', 'meal_plan', 'groceries']);
export const workspaceClientEvents = Object.freeze(['workspace_view', 'workspace_action']);
export const workspaceActions = Object.freeze({
  collections: Object.freeze(['collections.create', 'collections.rename', 'collections.delete', 'collections.setRecipes']),
  meal_plan: Object.freeze(['plan.add', 'plan.update', 'plan.delete', 'plan.apply']),
  groceries: Object.freeze(['groceries.addManual', 'groceries.updateManual', 'groceries.fromRecipe', 'groceries.fromPlan',
    'groceries.setChecked', 'groceries.removeItem', 'groceries.removeSource', 'groceries.clearChecked'])
});
const outcomes = ['started', 'cancelled', 'error', 'success'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const count = n => Number.isSafeInteger(n) && n >= 0;
const duration = n => count(n) && n <= 86400000;
const stepFor = feature => feature === 'collections' ? 'collection' : 'other';
const invalid = () => { throw Object.assign(new Error('Неверное событие рабочего пространства'), { status: 400 }); };
const clientFields = new Set(['id', 'event', 'step', 'flowId', 'durationMs', 'feature', 'action', 'outcome',
  'version', 'session', 'ageMs', 'attempts', 'code']);

export function workspaceFeature(action) {
  return workspaceFeatures.find(feature => workspaceActions[feature].includes(action)) || null;
}

export function workspaceEventFields(row) {
  if (!workspaceClientEvents.includes(row.event)) {
    if (row.feature !== undefined || row.outcome !== undefined) return invalid();
    return {};
  }
  if (Object.keys(row).some(key => !clientFields.has(key)) || !workspaceFeatures.includes(row.feature)
    || row.step !== stepFor(row.feature) || typeof row.flowId !== 'string' || !uuid.test(row.flowId)) return invalid();
  if (row.event === 'workspace_view') {
    if (row.action !== undefined || row.outcome !== undefined || row.code !== undefined) return invalid();
    return { feature: row.feature };
  }
  if (workspaceFeature(row.action) !== row.feature || !outcomes.includes(row.outcome)
    || (row.outcome === 'started' ? row.durationMs != null && !duration(row.durationMs) : !duration(row.durationMs))
    || row.code !== undefined && row.outcome !== 'error') return invalid();
  return { feature: row.feature, action: row.action, outcome: row.outcome };
}

export function workspaceSavedFields({ step, flowId, durationMs, detail }) {
  if (!detail || !workspaceFeatures.includes(detail.feature) || workspaceFeature(detail.action) !== detail.feature || step !== stepFor(detail.feature)
    || typeof flowId !== 'string' || !uuid.test(flowId) || !duration(durationMs)) return invalid();
  // Never copy arbitrary detail fields into analytics, even from a server caller.
  return { feature: detail.feature, action: detail.action };
}

const actionCounters = ['started', 'cancelled', 'errors', 'clientSucceeded', 'serverConfirmed', 'visibleConfirmed'];
const counters = ['views', 'viewers', 'actors', ...actionCounters, 'unobserved', 'unmatchedOutcomes'];
const blankAction = () => Object.fromEntries(actionCounters.map(key => [key, 0]));
function timing(values) {
  values.sort((a, b) => a - b);
  const quantile = q => values.length ? values[Math.max(0, Math.ceil(values.length * q) - 1)] : null;
  return { samples: values.length, p50: quantile(.5), p95: quantile(.95) };
}

// events are already filtered by the parent product report's account/source cohort.
export function workspaceReport(events, trackingSince) {
  const features = Object.fromEntries(workspaceFeatures.map(feature => [feature, {
    ...Object.fromEntries(counters.map(key => [key, 0])),
    visibleTiming: timing([]),
    actions: Object.fromEntries(workspaceActions[feature].map(action => [action, blankAction()]))
  }]));
  const views = new Map(), flows = new Map();
  for (const row of events) {
    if (!row.user_id || row.created_at < trackingSince || !uuid.test(row.flow_id || '')
      || ![...workspaceClientEvents, 'workspace_saved'].includes(row.event)) continue;
    let detail;
    try { detail = JSON.parse(row.detail_json); } catch { continue; }
    if (!detail || typeof detail !== 'object' || Array.isArray(detail)) continue;
    const feature = detail.feature;
    if (!workspaceFeatures.includes(feature) || row.step !== stepFor(feature)) continue;
    const key = JSON.stringify([row.user_id, row.flow_id, feature]);
    if (row.event === 'workspace_view') {
      if (!views.has(key)) views.set(key, { userId: row.user_id, feature });
      continue;
    }
    if (workspaceFeature(detail.action) !== feature) continue;
    const flowKey = JSON.stringify([row.user_id, row.flow_id, feature, detail.action]);
    if (!flows.has(flowKey)) flows.set(flowKey, { userId: row.user_id, feature, action: detail.action });
    const flow = flows.get(flowKey);
    const kind = row.event === 'workspace_saved' ? 'saved' : detail.outcome;
    if (kind !== 'saved' && !outcomes.includes(kind)) continue;
    if (kind !== 'started' && !duration(row.duration_ms)) continue;
    // Retransmissions and accidental duplicate client IDs do not add outcomes.
    if (!flow[kind]) flow[kind] = row;
  }
  const viewers = new Map(workspaceFeatures.map(feature => [feature, new Set()]));
  const actors = new Map(workspaceFeatures.map(feature => [feature, new Set()]));
  const visibleDurations = new Map(workspaceFeatures.map(feature => [feature, []]));
  for (const view of views.values()) {
    features[view.feature].views++;
    viewers.get(view.feature).add(view.userId);
  }
  for (const flow of flows.values()) {
    const report = features[flow.feature], action = report.actions[flow.action];
    const increment = key => { report[key]++; action[key]++; };
    if (flow.started) { increment('started'); actors.get(flow.feature).add(flow.userId); }
    if (flow.cancelled) increment('cancelled');
    if (flow.error) increment('errors');
    if (flow.success) increment('clientSucceeded');
    if (flow.saved) increment('serverConfirmed');
    // Transport/queue timing can reorder arrivals. The random operation ID and
    // same account/action, rather than receipt order, connect these observations.
    if (flow.started && flow.success && flow.saved) {
      increment('visibleConfirmed');
      visibleDurations.get(flow.feature).push(flow.success.duration_ms);
    }
    for (const outcome of ['cancelled', 'error', 'success']) {
      if (flow[outcome] && (!flow.started || outcome === 'success' && !flow.saved)) report.unmatchedOutcomes++;
    }
  }
  for (const feature of workspaceFeatures) {
    const report = features[feature];
    report.viewers = viewers.get(feature).size;
    report.actors = actors.get(feature).size;
    report.unobserved = report.serverConfirmed - report.visibleConfirmed;
    report.visibleTiming = timing(visibleDurations.get(feature));
  }
  return { trackingSince, features };
}

const exact = (object, keys) => object && typeof object === 'object' && !Array.isArray(object)
  && Object.keys(object).length === keys.length && keys.every(key => Object.hasOwn(object, key));
export function validWorkspaceReport(value) {
  if (!exact(value, ['trackingSince', 'features']) || typeof value.trackingSince !== 'string'
    || !Number.isFinite(Date.parse(value.trackingSince)) || value.trackingSince.length > 40
    || !exact(value.features, workspaceFeatures)) return false;
  for (const feature of workspaceFeatures) {
    const r = value.features[feature];
    if (!exact(r, [...counters, 'visibleTiming', 'actions']) || !counters.every(key => count(r[key]))
      || r.viewers > r.views || r.actors > r.started
      || r.visibleConfirmed > Math.min(r.started, r.clientSucceeded, r.serverConfirmed)
      || r.unobserved !== r.serverConfirmed - r.visibleConfirmed
      || r.unmatchedOutcomes > r.cancelled + r.errors + r.clientSucceeded
      || !exact(r.actions, workspaceActions[feature])) return false;
    for (const action of Object.values(r.actions)) {
      if (!exact(action, actionCounters) || !actionCounters.every(key => count(action[key]))
        || action.visibleConfirmed > Math.min(action.started, action.clientSucceeded, action.serverConfirmed)) return false;
    }
    if (!actionCounters.every(key => Object.values(r.actions).reduce((n, action) => n + action[key], 0) === r[key])) return false;
    const t = r.visibleTiming;
    if (!exact(t, ['samples', 'p50', 'p95']) || t.samples !== r.visibleConfirmed
      || (t.samples === 0 ? t.p50 !== null || t.p95 !== null : !duration(t.p50) || !duration(t.p95) || t.p50 > t.p95)) return false;
  }
  return true;
}
