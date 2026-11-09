import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';

const file = `data/workspace-analytics-${randomUUID()}.sqlite`;
Object.assign(process.env, { DATABASE_PATH:file, TELEGRAM_BOT_TOKEN:'workspace-analytics-test', TELEGRAM_POLLING:'false',
  TEST_CONTOUR:'true', BOT_PLATFORM:'telegram', DINNER_LLM_ENABLED:'false', DINNER_IMAGES_ENABLED:'false', OPENAI_API_KEY:'disabled' });
const { db, upsertTelegramUser, allowUser } = await import('../src/db.js');
const collectionStart = new Date(Date.now() - 86400000).toISOString();
db.exec('CREATE TABLE IF NOT EXISTS product_analytics_metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL)');
db.prepare("INSERT INTO product_analytics_metadata VALUES('workspace_since',?)").run(collectionStart);
const { recordProduct:record, acceptProductEvents:accept, productReport:report, workspaceTrackingSince, validProductReport, steps } = await import('../src/product-analytics.js');
const { workspaceFeature, workspaceReport, validWorkspaceReport } = await import('../src/workspace-analytics.js');
const { funnelReport, recordBotStart, createCampaign } = await import('../src/funnel.js');
const { maxFunnelSnapshot, mergeMaxFunnelReport } = await import('../src/max-funnel.js');
const { analyticsExcludedIds } = await import('../src/analytics-exclusions.js');
let nextUser = 940000;
const user = id => { const u = upsertTelegramUser({ id:id || ++nextUser }); allowUser(u.id); return u; };
const at = offset => new Date(Date.parse(collectionStart) + offset).toISOString();
const event = (changes = {}) => ({ id:randomUUID(), event:'workspace_action', step:'collection', feature:'collections',
  action:'collections.create', outcome:'started', flowId:randomUUID(), version:'product-1', session:randomUUID(), ...changes });
const batch = (...events) => ({ visitor:randomUUID(), events });
const save = (u, action, flowId = randomUUID(), options = {}) => record(u.id, 'workspace_saved', {
  id:`workspace-${flowId}`, step:action.startsWith('collections.') ? 'collection' : 'other', flowId, durationMs:25,
  detail:{ feature:workspaceFeature(action), action }, at:at(1000), ...options
});
const action = (u, action, outcome, flowId, options = {}) => record(u.id, 'workspace_action', {
  step:action.startsWith('collections.') ? 'collection' : 'other', flowId, durationMs:outcome === 'started' ? null : 50,
  detail:{ feature:workspaceFeature(action), action, outcome }, at:at(2000), ...options
});
const view = (u, feature, flowId = randomUUID(), options = {}) => record(u.id, 'workspace_view', {
  step:feature === 'collections' ? 'collection' : 'other', flowId, detail:{feature}, at:at(2000), ...options
});
test.after(() => { db.close(); for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force:true }); });

test('workspace intake accepts closed enums only, validates the whole batch and cannot forge a server save', () => {
  const u = user(), input = batch(event());
  assert.equal(accept(u.id, input).accepted.length, 1);
  assert.equal(accept(u.id, input).accepted.length, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM product_events WHERE user_id=?').get(u.id).n, 1);
  for (const changes of [
    {feature:'unknown'}, {feature:'meal_plan'}, {action:'collections.share'}, {flowId:'not_a_random_uuid'}, {flowId:[randomUUID()]},
    {step:'other'}, {outcome:'conflict'}, {outcome:'success'}, {outcome:'success',durationMs:-1},
    {outcome:'error',durationMs:86400001}, {durationMs:1.5}, {name:'private name'}, {query:'private query'},
    {code:'network'}, {event:'workspace_saved'}, {event:'workspace_view'}, {action:'plan.add',feature:'collections'}
  ]) {
    const rows = batch(event(), event(changes));
    assert.throws(() => accept(u.id, rows), {status:400});
  }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM product_events WHERE user_id=?').get(u.id).n, 1, 'invalid batch writes no prefix');
  assert.throws(() => accept(null, input), {status:400});
  const valid = [event({event:'workspace_view',action:undefined,outcome:undefined}),
    event({outcome:'cancelled',durationMs:0}), event({outcome:'error',durationMs:50,code:'http'}),
    event({step:'other',feature:'meal_plan',action:'plan.apply',outcome:'success',durationMs:86400000}),
    event({step:'other',feature:'groceries',action:'groceries.setChecked'})];
  assert.equal(accept(u.id, batch(...valid)).accepted.length, valid.length);
  const rows = db.prepare('SELECT detail_json FROM product_events WHERE user_id=?').all(u.id);
  assert.ok(rows.every(r => !/private|name|query/.test(r.detail_json)));
});

test('server saves sanitize arbitrary detail, reject unknown actions and deduplicate operation IDs', () => {
  const u = user(), flowId = randomUUID();
  assert.equal(save(u, 'plan.apply', flowId, {detail:{feature:'meal_plan',action:'plan.apply',title:'private dish',date:'private date'}}), true);
  assert.equal(save(u, 'plan.apply', flowId), false);
  const row = db.prepare('SELECT detail_json FROM product_events WHERE user_id=?').get(u.id);
  assert.deepEqual(JSON.parse(row.detail_json), {feature:'meal_plan',action:'plan.apply'});
  assert.equal(save(u, 'plan.unknown'), false);
  assert.equal(save(u, 'plan.add', randomUUID(), {durationMs:-1}), false);
  assert.equal(save(u, 'plan.add', randomUUID(), {step:'collection'}), false);
  assert.equal(record(null, 'workspace_saved', {step:'other',flowId:randomUUID(),durationMs:0,detail:{feature:'meal_plan',action:'plan.add'}}), false);
  assert.equal(workspaceFeature('collection.create'), null, 'backend action spellings are exact');
  assert.equal(workspaceFeature('groceries.fromPlan'), 'groceries');
});

test('workspace aggregates match the same account and operation, deduplicate retries and keep reads out of mutations', () => {
  const u = user(), other = user(), flow = randomUUID(), visible = randomUUID(), orphan = randomUUID();
  view(u, 'collections', visible); view(u, 'collections', visible); view(other, 'collections', visible);
  save(u, 'collections.create', flow); // Server arrival may precede the client's queued start.
  action(u, 'collections.create', 'started', flow); action(u, 'collections.create', 'started', flow);
  action(u, 'collections.create', 'error', flow);
  action(u, 'collections.create', 'success', flow, {durationMs:250});
  action(u, 'collections.create', 'success', flow, {durationMs:900});
  save(other, 'collections.create', orphan);
  action(u, 'collections.create', 'success', orphan); // Never join across accounts.
  const cancelled = randomUUID(); action(u, 'collections.rename', 'cancelled', cancelled);
  record(u.id, 'operation_finished', {step:'collection',flowId:randomUUID(),durationMs:1,detail:{status:200},at:at(2000)});
  record(u.id, 'operation_finished', {step:'other',flowId:randomUUID(),durationMs:1,detail:{status:200},at:at(2000)});
  const r = report([u,other]);
  assert.deepEqual(r.workspace.features.collections, {
    views:2,viewers:2,actors:1,started:1,cancelled:1,errors:1,clientSucceeded:2,serverConfirmed:2,visibleConfirmed:1,
    unobserved:1,unmatchedOutcomes:2,visibleTiming:{samples:1,p50:250,p95:250},actions:{
      'collections.create':{started:1,cancelled:0,errors:1,clientSucceeded:2,serverConfirmed:2,visibleConfirmed:1},
      'collections.rename':{started:0,cancelled:1,errors:0,clientSucceeded:0,serverConfirmed:0,visibleConfirmed:0},
      'collections.delete':{started:0,cancelled:0,errors:0,clientSucceeded:0,serverConfirmed:0,visibleConfirmed:0},
      'collections.setRecipes':{started:0,cancelled:0,errors:0,clientSucceeded:0,serverConfirmed:0,visibleConfirmed:0},
      'collections.saveCatalog':{started:0,cancelled:0,errors:0,clientSucceeded:0,serverConfirmed:0,visibleConfirmed:0},
      'collections.updateCard':{started:0,cancelled:0,errors:0,clientSucceeded:0,serverConfirmed:0,visibleConfirmed:0},
      'collections.setPhoto':{started:0,cancelled:0,errors:0,clientSucceeded:0,serverConfirmed:0,visibleConfirmed:0},
      'collections.removePhoto':{started:0,cancelled:0,errors:0,clientSucceeded:0,serverConfirmed:0,visibleConfirmed:0},
      'collections.askRecipe':{started:0,cancelled:0,errors:0,clientSucceeded:0,serverConfirmed:0,visibleConfirmed:0}
    }
  });
  assert.equal(r.workspace.features.meal_plan.serverConfirmed, 0);
  assert.equal(r.latency.started, 0, 'workspace must not pollute recipe latency');
  assert.equal(validWorkspaceReport(r.workspace), true);
  assert.equal(steps.length, 21, 'legacy MAX step registry remains unchanged');
});

test('collection start persists and source/account filters precede workspace aggregation', () => {
  assert.equal(workspaceTrackingSince(), collectionStart, 'module load preserves an existing collection start');
  const u = user(), outside = user();
  view(u, 'meal_plan', randomUUID(), {at:at(-1)});
  view(u, 'meal_plan', randomUUID(), {at:at(100)});
  view(u, 'meal_plan', randomUUID(), {at:at(300)});
  view(outside, 'meal_plan', randomUUID(), {at:at(300)});
  assert.equal(report([u]).workspace.features.meal_plan.views, 2);
  assert.equal(report([{...u,started_at:at(200)}], true).workspace.features.meal_plan.views, 1);
  assert.equal(workspaceTrackingSince(), collectionStart);

  const campaign = createCampaign('workspace-source-test').slug;
  const included = user(), excluded = [...analyticsExcludedIds, 'private-test:workspace'].map(user);
  for (const account of [included, ...excluded]) {
    const token = randomUUID();
    db.prepare('INSERT INTO acquisition_clicks(token,campaign,created_at) VALUES(?,?,?)').run(token,campaign,at(100));
    recordBotStart(account, '/start ad_' + token, new Date(at(200)));
    view(account, 'groceries', randomUUID(), {at:at(300)});
    view(account, 'groceries', randomUUID(), {at:at(100)});
  }
  const result = funnelReport(campaign).productAnalytics.platforms[0].workspace;
  assert.equal(result.features.groceries.views, 1);
  assert.equal(result.features.groceries.viewers, 1);
  assert.ok(!JSON.stringify(result).includes('private-test'));
});

test('bounded exact workspace schema rejects unexpected data and impossible counters', () => {
  const empty = workspaceReport([], collectionStart);
  assert.equal(validWorkspaceReport(empty), true);
  const changes = [
    r => { r.name = 'private'; }, r => { r.features.collections.query = 'private'; },
    r => { delete r.features.groceries; }, r => { r.features.collections.views = -1; },
    r => { r.features.collections.views = 1.5; }, r => { r.features.collections.views = Number.MAX_SAFE_INTEGER + 1; },
    r => { r.features.collections.viewers = 1; }, r => { r.features.collections.actors = 1; },
    r => { r.features.collections.started = 1; }, r => { r.features.collections.actions['collections.share'] = {}; },
    r => { r.features.collections.unobserved = 1; }, r => { r.features.collections.unmatchedOutcomes = 1; },
    r => { r.features.collections.visibleTiming = {samples:0,p50:0,p95:null}; },
    r => { r.features.collections.actions['collections.create'].started = '1'; }, r => { r.trackingSince = 'not-a-date'; }
  ];
  for (const change of changes) { const value = structuredClone(empty); change(value); assert.equal(validWorkspaceReport(value), false); }
  const platform = maxFunnelSnapshot().all.productAnalytics.platforms[0];
  assert.equal(validProductReport(platform), true);
  assert.equal(validProductReport({...platform,workspace:{...empty,query:'private'}}), false);
  delete platform.workspace;
  assert.equal(validProductReport(platform), true, 'older bridge remains compatible');
  assert.equal(validProductReport({...platform,workspace:null}), true);
});

test('MAX bridge retains verified workspace metrics and represents old versions as unavailable', async () => {
  const options = {enabled:true,origin:'https://recipeboibot-max.89-223-123-75.sslip.io',token:'a'.repeat(43)};
  const snapshot = maxFunnelSnapshot();
  const merge = value => mergeMaxFunnelReport(funnelReport('all'), {...options,transport:async () => Response.json(value)});
  let result = await merge(snapshot);
  assert.equal(result.remoteFunnel.status, 'ready');
  assert.deepEqual(result.productAnalytics.platforms.find(p => p.platform === 'max').workspace, snapshot.all.productAnalytics.platforms[0].workspace);
  const old = structuredClone(snapshot);
  for (const scope of ['campaign','all']) delete old[scope].productAnalytics.platforms[0].workspace;
  result = await merge(old);
  assert.equal(result.remoteFunnel.status, 'ready');
  assert.equal(result.productAnalytics.platforms.find(p => p.platform === 'max').workspace, null);
  const olderWorkspace = structuredClone(snapshot);
  for (const scope of ['campaign', 'all']) for (const action of ['collections.saveCatalog','collections.updateCard','collections.setPhoto','collections.removePhoto','collections.askRecipe'])
    delete olderWorkspace[scope].productAnalytics.platforms[0].workspace.features.collections.actions[action];
  result = await merge(olderWorkspace);
  assert.equal(result.remoteFunnel.status, 'ready');
  assert.equal(Object.hasOwn(result.productAnalytics.platforms.find(p => p.platform === 'max').workspace.features.collections.actions, 'collections.saveCatalog'), false,
    'older workspace keeps unavailable catalog action absent rather than inventing zeros');
  const catalogWorkspace = structuredClone(snapshot);
  for (const scope of ['campaign', 'all']) for (const action of ['collections.updateCard','collections.setPhoto','collections.removePhoto','collections.askRecipe'])
    delete catalogWorkspace[scope].productAnalytics.platforms[0].workspace.features.collections.actions[action];
  assert.equal((await merge(catalogWorkspace)).remoteFunnel.status, 'ready');
  const invalid = structuredClone(snapshot);
  invalid.all.productAnalytics.platforms[0].workspace.features.groceries.actions['groceries.addManual'].started = 1;
  assert.equal((await merge(invalid)).remoteFunnel.status, 'error');
});

test('catalog saving has closed private analytics and matched visible confirmations', () => {
  const u = user(), flowId = randomUUID();
  assert.equal(accept(u.id, batch(event({ action: 'collections.saveCatalog', flowId }))).accepted.length, 1);
  assert.equal(save(u, 'collections.saveCatalog', flowId), true);
  assert.equal(save(u, 'collections.saveCatalog', flowId), false);
  action(u, 'collections.saveCatalog', 'success', flowId);
  const summary = report([u]).workspace;
  assert.equal(summary.features.collections.actions['collections.saveCatalog'].visibleConfirmed, 1);
  assert.equal(validWorkspaceReport(summary), true);
  assert.throws(() => accept(u.id, batch(event({ action: 'collections.saveCatalog', catalogId: 'pasta-tomato' }))), { status: 400 });
});

test('personal card actions reuse private workspace events without notes, ratings, photos or question contents', () => {
  const u = user();
  for (const name of ['collections.updateCard', 'collections.setPhoto', 'collections.removePhoto', 'collections.askRecipe']) {
    const flowId = randomUUID();
    assert.equal(accept(u.id, batch(event({ action: name, flowId }))).accepted.length, 1);
    assert.equal(save(u, name, flowId, { detail: { feature: 'collections', action: name, notes: 'private', question: 'private', value: 'private', rating: 5 } }), true);
    action(u, name, 'success', flowId);
    for (const field of ['notes', 'question', 'answer', 'value', 'rating', 'recipeId'])
      assert.throws(() => accept(u.id, batch(event({ action: name, [field]: 'private' }))), { status: 400 });
  }
  const summary = report([u]).workspace;
  assert.equal(summary.features.collections.visibleConfirmed, 4); assert.equal(validWorkspaceReport(summary), true);
  assert.ok(db.prepare('SELECT detail_json FROM product_events WHERE user_id=?').all(u.id).every(row => !row.detail_json.includes('private')));
});

test('actual client observer waits for visible content and retries the same event and navigation ID', async () => {
  let timer, hit = false, online = false;
  const listeners = {}, storage = new Map(), sent = [], accepted = [], u = user(), flowId = randomUUID();
  const element = {isConnected:true,getBoundingClientRect:() => ({left:0,top:0,right:100,bottom:100}),contains:() => hit};
  const sandbox = {location:{pathname:'/'},crypto:{randomUUID},Date,Promise,AbortSignal,navigator:{onLine:true},innerWidth:400,innerHeight:800,
    sessionStorage:{getItem:k => storage.get(k),setItem:(k,v) => storage.set(k,v)},
    window:{addEventListener(){},RecipePlatform:{authHeader:() => 'tma fixture'}},
    document:{visibilityState:'hidden',elementFromPoint:() => element,addEventListener:(name,fn) => {listeners[name] = fn;}},
    getComputedStyle:() => ({visibility:'visible',opacity:'1'}),requestAnimationFrame:fn => fn(),setInterval(){},clearTimeout(){},
    setTimeout:fn => {timer = fn; return 1;},fetch:async (_path,options) => {
      const body = JSON.parse(options.body); sent.push(...body.events);
      if (!online) throw Error('offline');
      accepted.push(...body.events); return {ok:true,json:async () => accept(u.id,body)};
    }
  };
  vm.createContext(sandbox); vm.runInContext(fs.readFileSync('public/analytics.js','utf8'),sandbox);
  const api = sandbox.window.RecipeAnalytics;
  api.setUser(u.id); api.observe(element,'workspace_view','other',{feature:'groceries',flowId});
  await timer(); assert.equal(sent.some(r => r.event === 'workspace_view'), false);
  sandbox.document.visibilityState = 'visible'; listeners.visibilitychange(); await timer();
  assert.equal(sent.some(r => r.event === 'workspace_view'), false, 'covered content is not visible');
  hit = true; listeners.animationend(); await timer();
  const first = sent.find(r => r.event === 'workspace_view'); assert.equal(first.flowId, flowId);
  online = true; await timer(); listeners.transitionend(); await timer();
  const retries = sent.filter(r => r.event === 'workspace_view');
  assert.equal(new Set(retries.map(r => r.id)).size, 1);
  assert.equal(accepted.filter(r => r.event === 'workspace_view').length, 1);
  assert.equal(report([u]).workspace.features.groceries.views, 1);
});
