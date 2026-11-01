import { db } from './db.js';
import { config } from './config.js';
import { catalogSelection, validCatalogSelection } from './catalog-selection.js';

export const catalogDetailPublicEvents = ['catalog_page_started', 'catalog_section_visible', 'catalog_page_progress', 'catalog_action'];
export const catalogPathGroups = Object.freeze(['unconfirmed','brief_catalog','deep_catalog','active_catalog','empty_results','one_recipe','multiple_recipes','legacy_catalog','unknown_catalog','save_intent','bot_started','saved']);
const screens = ['list', 'recipe'];
const navigations = ['initial','link','back','filter','search','pagination','reset','sort','favorites','retry'];
const viewports = ['compact','medium','wide'];
const sections = ['intro','products','cuisines','filters','results','recipe_header','ingredients','steps','save_cta','footer'];
const reasons = ['heartbeat','hidden','pagehide','navigation'];
const actions = ['filter_change','filter_reset','search_submit','card_open','back_to_list','pagination','sort_change','favorite_add','favorite_remove','share','print','servings_change','results_jump','more_cuisines','filters_expand','save_open','platform_telegram','platform_max','cancel_save','open_bot','retry'];
const controls = ['cuisine','category','time','include','exclude'];
const codes = ['script','promise','network','http','timeout','storage','queue','auth','expired'];
const legacyEvents = ['catalog_list','catalog_open','catalog_search','catalog_empty','catalog_filter','catalog_favorite_add','catalog_favorite_remove','catalog_share','catalog_print','catalog_save_intent','catalog_platform_selected','catalog_handoff_ready','catalog_handoff_error','client_error'];
const events = [...legacyEvents, ...catalogDetailPublicEvents];
const outcomeEvents = ['catalog_bot_started','catalog_recipe_saved','catalog_save_failed'];
const pageIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const slugPattern = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const integer = (n, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(n) && n >= min && n <= max;
const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const fail = () => { throw Object.assign(new Error('Неверные параметры подробной аналитики'), { status: 400 }); };
const ownPlatform = config.botPlatform === 'max' ? 'max' : 'telegram';
const pageSize = 10, maxPages = 20, maxEvents = 80;

db.exec('CREATE TABLE IF NOT EXISTS catalog_detail_metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL)');
db.prepare("INSERT OR IGNORE INTO catalog_detail_metadata VALUES('tracking_since',?)").run(new Date().toISOString());
db.prepare("INSERT OR IGNORE INTO catalog_detail_metadata VALUES('selection_tracking_since',?)").run(new Date().toISOString());

export function catalogDetailEventFields(row) {
  const detailed = catalogDetailPublicEvents.includes(row.event);
  if (!detailed && row.pageId === undefined && row.screen === undefined) { if(row.selection!==undefined||row.resultsTotal!==undefined)return fail();return {}; }
  if (row.journey !== 'recipe-first-v1' || row.step !== 'catalog' || !pageIdPattern.test(row.pageId || '') || !screens.includes(row.screen)) return fail();
  const detail = { pageId: row.pageId, screen: row.screen };
  if(row.selection!==undefined){if(row.event!=='catalog_page_started'||row.screen!=='list')return fail();detail.selection=catalogSelection(row.selection);}
  if(row.resultsTotal!==undefined){
    if(!['catalog_list','catalog_search','catalog_filter','catalog_empty'].includes(row.event)||row.screen!=='list'||!integer(row.resultsTotal,0,1000000)||row.event==='catalog_empty'&&row.resultsTotal!==0)return fail();
    detail.resultsTotal=row.resultsTotal;
  }
  if (row.event === 'catalog_page_started') {
    if (!navigations.includes(row.navigation) || !viewports.includes(row.viewport) || !integer(row.pageNumber, 1, 1000)) return fail();
    Object.assign(detail, { navigation: row.navigation, viewport: row.viewport, pageNumber: row.pageNumber });
  } else if (row.event === 'catalog_section_visible') {
    const allowed = row.screen === 'list' ? ['intro','products','cuisines','filters','results','footer'] : ['recipe_header','ingredients','steps','save_cta','footer'];
    if (!allowed.includes(row.section)) return fail();
    detail.section = row.section;
  } else if (row.event === 'catalog_page_progress') {
    if (!integer(row.visibleMs, 0, 86400000) || !integer(row.elapsedMs, 0, 86400000) || row.visibleMs > row.elapsedMs
      || !integer(row.scrollDepth, 0, 100) || !integer(row.cardsSeen, 0, 24) || row.screen === 'recipe' && row.cardsSeen !== 0 || !reasons.includes(row.reason)) return fail();
    Object.assign(detail, { visibleMs: row.visibleMs, elapsedMs: row.elapsedMs, scrollDepth: row.scrollDepth, cardsSeen: row.cardsSeen, reason: row.reason });
  } else if (row.event === 'catalog_action') {
    if (!actions.includes(row.action)) return fail();
    if (row.control !== undefined && (!controls.includes(row.control) || row.action !== 'filter_change')) return fail();
    if (row.position !== undefined && (!integer(row.position, 1, 24) || !['card_open','favorite_add','favorite_remove'].includes(row.action))) return fail();
    const listOnly = ['filter_change','filter_reset','search_submit','card_open','pagination','sort_change','results_jump','more_cuisines','filters_expand'];
    const recipeOnly = ['back_to_list','share','print','servings_change','save_open','platform_telegram','platform_max','cancel_save','open_bot'];
    if (row.screen !== 'list' && listOnly.includes(row.action) || row.screen !== 'recipe' && recipeOnly.includes(row.action)) return fail();
    detail.action = row.action;
    if (row.control !== undefined) detail.control = row.control;
    if (row.position !== undefined) detail.position = row.position;
  }
  return detail;
}

export function catalogDetailFilters(input = {}, defaultPlatform = ownPlatform) {
  const get = name => input instanceof URLSearchParams ? input.get(name) : input[name];
  const campaign = get('campaign') || 'all', platform = get('platform') || defaultPlatform, group = get('group') || 'all';
  const from = get('from') || '', to = get('to') || '', rawPage = get('page') ?? '1';
  if (!slugPattern.test(campaign) || !['telegram','max'].includes(platform) || !['all',...catalogPathGroups].includes(group) || !/^\d{1,8}$/.test(String(rawPage))) return fail();
  const page = Number(rawPage);
  if (!integer(page, 1, 10000000)) return fail();
  for (const date of [from,to]) if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0,10) !== date)) return fail();
  if (from && to && from > to) return fail();
  return { campaign, platform, from, to, page, group };
}

function baseQuery(filters, at, flowIds = null) {
  const conditions = ['v.local_origin=1','v.internal=0','v.created_at<=?'], values = [at];
  if (filters.campaign !== 'all') { conditions.push('v.campaign=?'); values.push(filters.campaign); }
  if (filters.from) { conditions.push('v.created_at>=?'); values.push(new Date(filters.from + 'T00:00:00+03:00').toISOString()); }
  if (filters.to) { conditions.push('v.created_at<?'); values.push(new Date(Date.parse(filters.to + 'T00:00:00+03:00') + 86400000).toISOString()); }
  if (flowIds) { conditions.push(`v.flow_id IN (${flowIds.map(() => '?').join(',')})`); values.push(...flowIds); }
  return { where: conditions.join(' AND '), values };
}
const literals = values => values.map(value => "'" + value + "'").join(',');
const safeJson = "CASE WHEN json_valid(p.detail_json) THEN p.detail_json ELSE '{}' END";
const numeric = (field, max) => `CASE WHEN json_type(d,'$.${field}')='integer' AND json_extract(d,'$.${field}') BETWEEN 0 AND ${max} THEN json_extract(d,'$.${field}') END`;
function ctes(where) {
  return `WITH cutoff AS (SELECT ? AS at),selected AS MATERIALIZED (SELECT v.*,v.rowid AS visit_order FROM catalog_journey_visits v WHERE ${where}),
    event_rows AS MATERIALIZED (SELECT p.rowid AS eid,p.id,p.flow_id,p.event,p.duration_ms,p.created_at,${safeJson} AS d
      FROM selected v JOIN product_events p ON p.flow_id=v.flow_id AND p.subject='v:'||v.session_id
      WHERE p.created_at<=(SELECT at FROM cutoff) AND p.user_id IS NULL AND p.step='catalog' AND p.event IN (${literals(events)})
        AND json_extract(${safeJson},'$.journey')='recipe-first-v1'),
    normalized AS MATERIALIZED (SELECT *,CASE WHEN length(json_extract(d,'$.pageId'))=36 THEN json_extract(d,'$.pageId')
      WHEN event IN ('catalog_list','catalog_open') THEN 'legacy:'||id END AS page_key,
      CASE WHEN json_extract(d,'$.screen') IN ('list','recipe') THEN json_extract(d,'$.screen')
      WHEN event='catalog_list' THEN 'list' WHEN event='catalog_open' THEN 'recipe' END AS screen FROM event_rows),
    pages AS MATERIALIZED (SELECT flow_id,page_key,MIN(created_at) AS started_at,MAX(created_at) AS last_at,MIN(eid) AS first_id,
      MAX(screen) AS screen,MAX(CASE WHEN event='catalog_page_progress' THEN ${numeric('visibleMs',86400000)} END) AS visible_ms,
      MAX(CASE WHEN event='catalog_page_progress' THEN ${numeric('scrollDepth',100)} END) AS scroll_depth,
      MAX(CASE WHEN event='catalog_page_progress' THEN ${numeric('cardsSeen',24)} END) AS cards_seen,
      MIN(CASE WHEN event IN ('catalog_list','catalog_open') AND duration_ms BETWEEN 0 AND 86400000 THEN duration_ms END) AS load_ms,
      MAX(CASE WHEN event='catalog_page_started' THEN json_extract(d,'$.navigation') END) AS navigation,
      MAX(CASE WHEN event='catalog_page_started' THEN json_extract(d,'$.viewport') END) AS viewport,
      MAX(CASE WHEN event='catalog_page_started' THEN ${numeric('pageNumber',1000)} END) AS route_page,
      MAX(${numeric('resultsTotal',1000000)}) AS results_total,
      json_group_array(DISTINCT CASE WHEN event='catalog_section_visible' THEN json_extract(d,'$.section') END) AS sections
      FROM normalized WHERE page_key IS NOT NULL GROUP BY flow_id,page_key),
    selection_pages AS MATERIALIZED (SELECT DISTINCT flow_id,page_key FROM normalized WHERE event='catalog_page_started' AND screen='list' AND json_extract(d,'$.selection.version')=1),
    event_flags AS (SELECT n.flow_id,
      MAX(event='catalog_list' OR event='catalog_page_started' AND screen='list') AS saw_list,
      MAX(s.page_key IS NOT NULL) AS has_selection,
      MAX(event='catalog_empty' AND s.page_key IS NOT NULL) AS empty_selection,
      MAX(event='catalog_list') AS visible_list,SUM(event='catalog_open') AS recipe_opens,
      MAX(event='catalog_empty') AS empty_result,MAX(event='catalog_action') AS explicit_action,
      MAX(event='catalog_open') AS saw_recipe,
      MAX(event='catalog_save_intent' OR event='catalog_action' AND json_extract(d,'$.action')='save_open') AS save_intent,
      MAX(event IN ('client_error','catalog_handoff_error')) AS error,
      MAX(length(json_extract(d,'$.pageId'))=36) AS detailed,MIN(created_at) AS first_at,MAX(created_at) AS last_at
      FROM normalized n LEFT JOIN selection_pages s ON s.flow_id=n.flow_id AND s.page_key=n.page_key GROUP BY n.flow_id),
    outcomes AS (SELECT o.* FROM selected v JOIN catalog_journey_outcomes o ON o.flow_id=v.flow_id WHERE o.created_at<=(SELECT at FROM cutoff)),
    outcome_flags AS (SELECT flow_id,MAX(event='catalog_bot_started') AS started,MAX(event='catalog_recipe_saved') AS saved,
      MAX(event='catalog_save_failed') AS error,MAX(created_at) AS last_at FROM outcomes GROUP BY flow_id),
    page_flags AS (SELECT flow_id,MAX(CASE WHEN screen='list' THEN cards_seen END) AS max_cards FROM pages GROUP BY flow_id),
    classified AS MATERIALIZED (SELECT v.*,ROW_NUMBER() OVER(ORDER BY v.created_at,v.visit_order) AS visit_number,
      CASE WHEN o.saved=1 THEN 'saved' WHEN o.started=1 THEN 'bot_started' WHEN e.save_intent=1 THEN 'save_intent'
        WHEN e.recipe_opens>=2 THEN 'multiple_recipes' WHEN e.recipe_opens=1 THEN 'one_recipe'
        WHEN e.empty_result=1 THEN 'empty_results' WHEN COALESCE(e.visible_list,0)=0 THEN 'unconfirmed'
        WHEN COALESCE(e.detailed,0)=0 THEN 'legacy_catalog' WHEN e.explicit_action=1 THEN 'active_catalog'
        WHEN p.max_cards>8 THEN 'deep_catalog' WHEN p.max_cards>=1 THEN 'brief_catalog' ELSE 'unknown_catalog' END AS path_group
      FROM selected v LEFT JOIN event_flags e USING(flow_id) LEFT JOIN outcome_flags o USING(flow_id) LEFT JOIN page_flags p USING(flow_id))`;
}

function unavailable(filters) {
  return { version: 3, ...filters, status: 'unavailable', trackingSince: null, selectionTrackingSince:null, generatedAt: new Date().toISOString(), pageSize,
    totalVisits: null, summary: null, groups: null, visits: [] };
}

export function catalogDetailReport(input = {}, { at = new Date().toISOString() } = {}) {
  const filters = catalogDetailFilters(input);
  if (filters.platform !== ownPlatform || !validTime(at)) return unavailable(filters);
  db.exec(`CREATE INDEX IF NOT EXISTS product_events_catalog_flow_time ON product_events(flow_id,created_at) WHERE user_id IS NULL;
    CREATE INDEX IF NOT EXISTS catalog_visits_detail_scope ON catalog_journey_visits(local_origin,internal,campaign,created_at);`);
  const base = baseQuery(filters, at), cte = ctes(base.where);
  const {groupCounts,...summary} = db.prepare(`${cte} SELECT
    (SELECT COUNT(*) FROM selected) AS visits,
    (SELECT COUNT(DISTINCT flow_id) FROM pages WHERE visible_ms IS NOT NULL) AS measuredVisits,
    (SELECT SUM(visible_ms) FROM pages) AS visibleMsTotal,
    (SELECT COUNT(*) FROM pages) AS pageViews,
    (SELECT COUNT(*) FROM event_flags WHERE saw_list=1 AND saw_recipe=0) AS onlyListVisits,
    (SELECT COUNT(*) FROM event_flags WHERE saw_recipe=1) AS recipeVisits,
    (SELECT COUNT(*) FROM event_flags WHERE has_selection=1) AS selectionVisits,
    (SELECT COUNT(*) FROM event_flags WHERE empty_selection=1) AS emptySelectionVisits,
    (SELECT COUNT(*) FROM event_flags WHERE save_intent=1) AS saveIntentVisits,
    (SELECT COUNT(*) FROM outcome_flags WHERE started=1) AS starts,
    (SELECT COUNT(*) FROM outcome_flags WHERE saved=1) AS saved,
    (SELECT COUNT(*) FROM selected v LEFT JOIN event_flags e USING(flow_id) LEFT JOIN outcome_flags o USING(flow_id) WHERE e.error=1 OR o.error=1) AS errors,
    (SELECT json_group_object(path_group,n) FROM (SELECT path_group,COUNT(*) AS n FROM classified GROUP BY path_group)) AS groupCounts`).get(at,...base.values);
  const counts=JSON.parse(groupCounts),groups=catalogPathGroups.map(id=>({id,count:counts[id]||0}));
  const totalVisits=filters.group==='all'?summary.visits:counts[filters.group]||0;
  const offset = (filters.page - 1) * pageSize;
  // Group membership and visit ordinals use the whole cohort, before any
  // display limits. A late recipe event beyond event 80 still wins its group.
  const selected = db.prepare(`${cte} SELECT * FROM classified WHERE (?='all' OR path_group=?)
    ORDER BY created_at DESC,visit_order DESC LIMIT ? OFFSET ?`).all(at,...base.values,filters.group,filters.group,pageSize,offset);
  const visits = [];
  if (selected.length) {
    const subset = baseQuery(filters,at,selected.map(v => v.flow_id)), pageCte = ctes(subset.where);
    const pageRows = db.prepare(`${pageCte}, ranked AS (SELECT *,ROW_NUMBER() OVER(PARTITION BY flow_id ORDER BY started_at,first_id) AS number,
      COUNT(*) OVER(PARTITION BY flow_id) AS total FROM pages)
      SELECT r.*,(SELECT json_extract(n.d,'$.selection') FROM normalized n WHERE n.flow_id=r.flow_id AND n.page_key=r.page_key AND n.event='catalog_page_started'
        AND json_extract(n.d,'$.selection.version')=1 ORDER BY n.created_at,n.eid LIMIT 1) AS selection_json,
      (SELECT json_extract(n.d,'$.reason') FROM normalized n WHERE n.flow_id=r.flow_id AND n.page_key=r.page_key AND n.event='catalog_page_progress'
        ORDER BY n.created_at DESC,n.eid DESC LIMIT 1) AS last_reason FROM ranked r WHERE number<=? ORDER BY flow_id,number`).all(at,...subset.values,maxPages+1);
    const flags = new Map(db.prepare(`${pageCte} SELECT v.flow_id,e.detailed,e.first_at,e.last_at,o.last_at AS outcome_last,
      (SELECT SUM(visible_ms) FROM pages p WHERE p.flow_id=v.flow_id) AS visible_ms
      FROM selected v LEFT JOIN event_flags e USING(flow_id) LEFT JOIN outcome_flags o USING(flow_id)`).all(at,...subset.values).map(row => [row.flow_id,row]));
    const timeline = db.prepare(`SELECT p.event,p.duration_ms,p.created_at,${safeJson} AS d,p.id FROM product_events p
      WHERE p.flow_id=? AND p.subject=? AND p.created_at<=? AND p.user_id IS NULL AND p.step='catalog' AND p.event IN (${literals(events.filter(e => e !== 'catalog_page_progress'))})
        AND json_extract(${safeJson},'$.journey')='recipe-first-v1' ORDER BY p.created_at,p.rowid LIMIT ?`);
    const outcomes = db.prepare('SELECT event,platform,created_at FROM catalog_journey_outcomes WHERE flow_id=? AND created_at<=? ORDER BY created_at,platform,event');
    for (const visit of selected) {
      const pageList = pageRows.filter(p => p.flow_id === visit.flow_id), numbers = new Map(pageList.map(p => [p.page_key,p.number]));
      const rows = timeline.all(visit.flow_id,'v:'+visit.session_id,at,maxEvents+1);
      const details = flags.get(visit.flow_id);
      const startedAt = [visit.created_at,details.first_at].filter(Boolean).sort()[0];
      const lastEventAt = [startedAt,details.last_at,details.outcome_last].filter(Boolean).sort().at(-1);
      visits.push({ number: visit.visit_number, group:visit.path_group, startedAt,lastEventAt,legacy: !details.detailed,visibleMs: details.visible_ms,
        observedSpanMs: Math.max(0,Date.parse(lastEventAt)-Date.parse(startedAt)), pagesTruncated: pageList.length>maxPages,
        pages: pageList.slice(0,maxPages).map(p => ({ number:p.number,screen:screens.includes(p.screen)?p.screen:'list',startedAt:p.started_at,
          visibleMs:p.visible_ms,scrollDepth:p.scroll_depth,cardsSeen:p.cards_seen,sections:JSON.parse(p.sections).filter(s => sections.includes(s)),
          lastReason:reasons.includes(p.last_reason)?p.last_reason:null,loadMs:p.load_ms,legacy:p.page_key.startsWith('legacy:'),
          incomplete:!['navigation','pagehide'].includes(p.last_reason),
          ...(navigations.includes(p.navigation)?{navigation:p.navigation}:{}),...(viewports.includes(p.viewport)?{viewport:p.viewport}:{}),
          ...(integer(p.route_page,1,1000)?{routePageNumber:p.route_page}:{}),
          selection:p.selection_json&&validCatalogSelection(JSON.parse(p.selection_json))?JSON.parse(p.selection_json):null,resultsTotal:p.results_total })),
        events: rows.slice(0,maxEvents).map(row => {
          const d=JSON.parse(row.d), entry={at:row.created_at,event:row.event};
          const pageNumber=numbers.get(d.pageId || (['catalog_list','catalog_open'].includes(row.event)?'legacy:'+row.id:null));
          if(integer(pageNumber,1))entry.pageNumber=pageNumber;
          if(screens.includes(d.screen))entry.screen=d.screen;
          else if(['catalog_list','catalog_open'].includes(row.event))entry.screen=row.event==='catalog_list'?'list':'recipe';
          if(['telegram','max'].includes(d.platform))entry.platform=d.platform;
          for(const [key,list] of [['action',actions],['section',sections],['control',controls],['code',codes]])if(list.includes(d[key]))entry[key]=d[key];
          for(const [key,max] of [['position',24],['results',86400000],['filters',5]])if(integer(d[key],key==='position'?1:0,max))entry[key]=d[key];
          return entry;
        }),outcomes:outcomes.all(visit.flow_id,at).filter(o=>outcomeEvents.includes(o.event)&&['telegram','max'].includes(o.platform)).map(o=>({event:o.event,platform:o.platform,at:o.created_at})),
        eventsTruncated:rows.length>maxEvents });
    }
  }
  return { version:3,...filters,status:'ready',trackingSince:db.prepare("SELECT value FROM catalog_detail_metadata WHERE key='tracking_since'").get().value,
    selectionTrackingSince:db.prepare("SELECT value FROM catalog_detail_metadata WHERE key='selection_tracking_since'").get().value,
    generatedAt:at,pageSize,totalVisits,summary,groups,visits };
}

const exactKeys=(object,keys)=>object&&typeof object==='object'&&!Array.isArray(object)&&Object.keys(object).every(k=>keys.includes(k));
const nullableNumber=(n,max=Number.MAX_SAFE_INTEGER)=>n===null||integer(n,0,max);
export function validCatalogDetailReport(report, expected = null) {
  if(!exactKeys(report,['version','platform','status','trackingSince','selectionTrackingSince','generatedAt','campaign','from','to','page','group','pageSize','totalVisits','summary','groups','visits'])
    ||report.version!==3||report.pageSize!==pageSize||!validTime(report.generatedAt)||!Array.isArray(report.visits)||report.visits.length>pageSize)return false;
  let filters;try{filters=catalogDetailFilters(report);}catch{return false;}
  if(expected&&Object.entries(catalogDetailFilters(expected)).some(([key,value])=>report[key]!==value))return false;
  if(Object.entries(filters).some(([key,value])=>report[key]!==value))return false;
  if(report.status==='unavailable')return report.trackingSince===null&&report.selectionTrackingSince===null&&report.totalVisits===null&&report.summary===null&&report.groups===null&&report.visits.length===0;
  if(report.status!=='ready'||!validTime(report.trackingSince)||!validTime(report.selectionTrackingSince)||!integer(report.totalVisits))return false;
  const s=report.summary,counts=['visits','measuredVisits','pageViews','onlyListVisits','recipeVisits','selectionVisits','emptySelectionVisits','saveIntentVisits','starts','saved','errors'];
  if(!exactKeys(s,[...counts,'visibleMsTotal'])||!counts.every(k=>integer(s[k]))
    ||!nullableNumber(s.visibleMsTotal)||(s.measuredVisits===0?s.visibleMsTotal!==null:s.visibleMsTotal===null)
    ||s.onlyListVisits+s.recipeVisits>s.visits||s.measuredVisits>s.pageViews
    ||s.emptySelectionVisits>s.selectionVisits
    ||['measuredVisits','onlyListVisits','recipeVisits','selectionVisits','saveIntentVisits','starts','saved','errors'].some(k=>s[k]>s.visits))return false;
  if(!Array.isArray(report.groups)||report.groups.length!==catalogPathGroups.length
    ||report.groups.some((g,index)=>!exactKeys(g,['id','count'])||g.id!==catalogPathGroups[index]||!integer(g.count))
    ||report.groups.reduce((sum,g)=>sum+g.count,0)!==s.visits)return false;
  const groupCounts=Object.fromEntries(report.groups.map(g=>[g.id,g.count]));
  if(report.totalVisits!==(report.group==='all'?s.visits:groupCounts[report.group])
    ||groupCounts.saved!==s.saved||groupCounts.bot_started>s.starts||groupCounts.save_intent>s.saveIntentVisits
    ||groupCounts.one_recipe+groupCounts.multiple_recipes>s.recipeVisits)return false;
  const offset=(report.page-1)*pageSize;
  if(report.visits.length!==Math.min(pageSize,Math.max(0,report.totalVisits-offset)))return false;
  for(const [index,v] of report.visits.entries()){
    if(!exactKeys(v,['number','group','startedAt','lastEventAt','legacy','visibleMs','observedSpanMs','pages','events','outcomes','eventsTruncated','pagesTruncated'])
      ||!integer(v.number,1,s.visits)||(report.group==='all'?v.number!==s.visits-offset-index:index>0&&v.number>=report.visits[index-1].number)
      ||!catalogPathGroups.includes(v.group)||!groupCounts[v.group]||report.group!=='all'&&v.group!==report.group
      ||!validTime(v.startedAt)||!validTime(v.lastEventAt)||v.lastEventAt<v.startedAt||v.lastEventAt>report.generatedAt
      ||typeof v.legacy!=='boolean'||!nullableNumber(v.visibleMs)||!integer(v.observedSpanMs)||typeof v.eventsTruncated!=='boolean'||typeof v.pagesTruncated!=='boolean'
      ||v.observedSpanMs!==Date.parse(v.lastEventAt)-Date.parse(v.startedAt)
      ||!Array.isArray(v.pages)||v.pages.length>maxPages||!Array.isArray(v.events)||v.events.length>maxEvents||!Array.isArray(v.outcomes)||v.outcomes.length>6)return false;
    for(const [pageIndex,p] of v.pages.entries()){
      if(!exactKeys(p,['number','screen','startedAt','visibleMs','scrollDepth','cardsSeen','sections','lastReason','loadMs','legacy','incomplete','navigation','viewport','routePageNumber','selection','resultsTotal'])
        ||p.number!==pageIndex+1||!screens.includes(p.screen)||!validTime(p.startedAt)||p.startedAt<v.startedAt||p.startedAt>v.lastEventAt||!nullableNumber(p.visibleMs,86400000)||!nullableNumber(p.scrollDepth,100)
        ||!nullableNumber(p.cardsSeen,24)||!nullableNumber(p.loadMs,86400000)||!Array.isArray(p.sections)||p.sections.length>sections.length||!p.sections.every(s=>sections.includes(s))
        ||p.lastReason!==null&&!reasons.includes(p.lastReason)||typeof p.legacy!=='boolean'||typeof p.incomplete!=='boolean'
        ||p.navigation!==undefined&&!navigations.includes(p.navigation)||p.viewport!==undefined&&!viewports.includes(p.viewport)||p.routePageNumber!==undefined&&!integer(p.routePageNumber,1,1000)
        ||p.selection!==null&&(!validCatalogSelection(p.selection)||p.screen!=='list')||!nullableNumber(p.resultsTotal,1000000))return false;
    }
    for(const e of v.events){
      if(!exactKeys(e,['at','event','screen','pageNumber','platform','action','section','control','position','results','filters','code'])||!validTime(e.at)||e.at<v.startedAt||e.at>v.lastEventAt||!events.includes(e.event)||e.event==='catalog_page_progress'
        ||e.screen!==undefined&&!screens.includes(e.screen)||e.pageNumber!==undefined&&!integer(e.pageNumber,1)||e.platform!==undefined&&!['telegram','max'].includes(e.platform))return false;
      for(const [key,list] of [['action',actions],['section',sections],['control',controls],['code',codes]])if(e[key]!==undefined&&!list.includes(e[key]))return false;
      for(const [key,max] of [['position',24],['results',86400000],['filters',5]])if(e[key]!==undefined&&!integer(e[key],key==='position'?1:0,max))return false;
    }
    // A remote bot clock can precede the browser's reconstructed timestamp;
    // outcomes must not rewrite the website visit-start cohort.
    if(v.outcomes.some(o=>!exactKeys(o,['event','platform','at'])||!outcomeEvents.includes(o.event)||!['telegram','max'].includes(o.platform)||!validTime(o.at)||o.at>v.lastEventAt))return false;
  }
  if(report.groups.some(g=>report.visits.filter(v=>v.group===g.id).length>g.count))return false;
  return true;
}

export async function dashboardCatalogDetails(input = {}, { transport=fetch, origin=config.maxFunnelOrigin, token=config.maxFunnelToken,
  remoteEnabled=!config.testContour&&ownPlatform==='telegram' } = {}) {
  const filters=catalogDetailFilters(input);
  if(filters.platform===ownPlatform)return catalogDetailReport(filters);
  if(!remoteEnabled||filters.platform!=='max')return unavailable(filters);
  try{
    if(origin!=='https://recipeboibot-max.89-223-123-75.sslip.io'||!/^[A-Za-z0-9_-]{43,128}$/.test(token))throw new Error('configuration');
    const response=await transport(origin+'/api/internal/catalog-visits?'+new URLSearchParams(Object.entries(filters).map(([k,v])=>[k,String(v)])),{
      headers:{authorization:'Bearer '+token},signal:AbortSignal.timeout(5000),redirect:'error'});
    if(!response.ok)throw new Error('unavailable');
    const limit=512000, reader=response.body?.getReader();let size=0,text='';
    if(!reader)throw new Error('empty');
    const decoder=new TextDecoder();
    try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit)throw new Error('size');text+=decoder.decode(value,{stream:true});}text+=decoder.decode();}
    finally{reader.releaseLock();if(size>limit)await response.body.cancel();}
    const result=JSON.parse(text);
    if(!validCatalogDetailReport(result,filters))throw new Error('schema');
    return result;
  }catch{return unavailable(filters);}
}
