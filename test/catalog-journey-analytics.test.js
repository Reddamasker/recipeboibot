import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const database = `data/catalog-journey-analytics-${randomUUID()}.sqlite`;
Object.assign(process.env, { DATABASE_PATH: database, TELEGRAM_BOT_TOKEN: 'journey-analytics-test', TELEGRAM_POLLING: 'false',
  TEST_CONTOUR: 'false', BOT_PLATFORM: 'telegram', DINNER_LLM_ENABLED: 'false', DINNER_IMAGES_ENABLED: 'false', OPENAI_API_KEY: 'disabled' });
const { db, upsertTelegramUser } = await import('../src/db.js');
const { createCampaign } = await import('../src/funnel.js');
const { acceptProductEvents, productReport, validProductReport } = await import('../src/product-analytics.js');
const { maxFunnelSnapshot } = await import('../src/max-funnel.js');
const { recordCatalogJourneyServer, registerCatalogJourneyHandoff, validCatalogJourneyReport } = await import('../src/catalog-journey-analytics.js');

test.after(() => { db.close(); for (const suffix of ['', '-wal', '-shm']) fs.rmSync(database + suffix, { force: true }); });

function journey({ campaign = null, platform = 'telegram', complete = true, direct = false } = {}) {
  const flowId = randomUUID(), sessionId = randomUUID();
  const names = [...(direct ? [] : ['catalog_list']), 'catalog_open', 'catalog_save_intent', 'catalog_platform_selected', 'catalog_handoff_ready'];
  const input = { visitor: sessionId, events: (complete ? names : [names[0]]).map((event, index) => ({
    id: randomUUID(), event, step: 'catalog', flowId, session: sessionId, journey: 'recipe-first-v1', campaign,
    version: 'journey-test', ageMs: 10000 - index * 1000,
    ...(['catalog_platform_selected','catalog_handoff_ready'].includes(event) ? { platform } : {}),
  })) };
  acceptProductEvents(null, input);
  return { flowId, sessionId, platform, campaign, input };
}
const report = campaign => productReport([], Boolean(campaign), new Date(Date.now() + 86400001).toISOString(), campaign).catalogJourney;
const outcome = (j, type, extra = {}) => recordCatalogJourneyServer(type, { ...j, ...extra });

test('full journey uses real server outcomes and stable retries, with direct recipe entry supported', () => {
  createCampaign('journey-complete', 'Journey complete');
  const j = journey({ campaign: 'journey-complete' });
  assert.equal(outcome(j, 'catalog_bot_started'), true);
  assert.equal(outcome(j, 'catalog_recipe_saved'), true);
  assert.equal(outcome(j, 'catalog_recipe_saved'), false);
  acceptProductEvents(null, j.input);
  let r = report('journey-complete');
  assert.equal(r.visible, 1); assert.equal(r.saved, 1); assert.equal(r.botStarted, 1); assert.equal(r.saveRate, 100);
  assert.equal(r.newStarts, 1); assert.equal(r.returningStarts, 0); assert.equal(r.unmatchedOutcomes, 0);
  assert.equal(r.handoffToSaved.samples, 1); assert.equal(r.withoutStart24h, 0);
  assert.equal(validCatalogJourneyReport(r), true);
  const direct = journey({ campaign: 'journey-complete', direct: true });
  outcome(direct, 'catalog_bot_started', { isReturning: true }); outcome(direct, 'catalog_recipe_saved');
  r = report('journey-complete');
  assert.equal(r.visible, 2); assert.equal(r.saved, 2); assert.equal(r.returningStarts, 1);
});

test('campaign metadata covers non-clickers, remains immutable and never stores arbitrary text', () => {
  createCampaign('journey-source-a'); createCampaign('journey-source-b');
  const a = journey({ campaign: 'journey-source-a', complete: false });
  journey({ campaign: 'journey-source-b', complete: false });
  const unknown = journey({ campaign: 'private message and URL https://example.com', complete: false });
  registerCatalogJourneyHandoff({ ...a, campaign: 'journey-source-b' });
  assert.equal(report('journey-source-a').visible, 1); assert.equal(report('journey-source-b').visible, 1);
  assert.equal(report('journey-source-a').eligible24h, 1); assert.equal(report('journey-source-a').withoutStart24h, 1);
  assert.equal(db.prepare('SELECT campaign FROM catalog_journey_visits WHERE flow_id=?').get(unknown.flowId).campaign, null);
  const details = db.prepare('SELECT detail_json FROM product_events WHERE flow_id=?').all(unknown.flowId);
  assert.ok(!JSON.stringify(details).includes('private message'));
  assert.ok(!JSON.stringify(details).includes('campaign'));
  assert.equal(productReport([], true).catalogJourney, null);
});

test('cross-platform confirmations join only the source website and matching target chain', () => {
  createCampaign('journey-cross-platform');
  const source = journey({ campaign: 'journey-cross-platform', platform: 'max' });
  outcome(source, 'catalog_bot_started', { platform: 'telegram' });
  outcome(source, 'catalog_recipe_saved', { platform: 'telegram' });
  let r = report('journey-cross-platform');
  assert.equal(r.botStarted, 0); assert.equal(r.saved, 0); assert.equal(r.unmatchedOutcomes, 1);
  outcome(source, 'catalog_bot_started'); outcome(source, 'catalog_recipe_saved');
  r = report('journey-cross-platform');
  assert.equal(r.saved, 1); assert.equal(r.platforms[1].saved, 1); assert.equal(r.platforms[0].saved, 0);
  const remoteOnly = { flowId: randomUUID(), sessionId: randomUUID(), platform: 'max', campaign: 'journey-cross-platform' };
  outcome(remoteOnly, 'catalog_bot_started'); outcome(remoteOnly, 'catalog_recipe_saved');
  r = report('journey-cross-platform');
  assert.equal(r.visible, 1); assert.equal(r.saved, 1); assert.equal(r.targetOnlyStarts, 1); assert.equal(r.targetOnlySaved, 1);
  assert.equal(r.unmatchedOutcomes, 0);
});

test('known internal flows are excluded, missing screens stay diagnostic and expired windows do not claim reasons', () => {
  createCampaign('journey-internal');
  const j = journey({ campaign: 'journey-internal' });
  const owner = upsertTelegramUser({ id: 6971956699 });
  outcome(j, 'catalog_bot_started', { userId: owner.id }); outcome(j, 'catalog_recipe_saved');
  assert.equal(report('journey-internal').visible, 0);
  const mirroredInternal = journey({ campaign: 'journey-internal' });
  outcome(mirroredInternal, 'catalog_bot_started', { isInternal: true });
  assert.equal(report('journey-internal').visible, 0);
  const missing = journey({ campaign: 'journey-internal', complete: false });
  outcome(missing, 'catalog_bot_started'); outcome(missing, 'catalog_recipe_saved');
  const r = report('journey-internal');
  assert.equal(r.saved, 0); assert.equal(r.unmatchedOutcomes, 1); assert.equal(r.withoutStart24h, 1);
  assert.equal(productReport([], false, new Date().toISOString(), 'journey-internal').catalogJourney.eligible24h, 0);
});

test('public registry cannot forge starts, rejects invalid enums atomically and preserves bounded errors', () => {
  const visitor = randomUUID();
  const base = { id: randomUUID(), flowId: randomUUID(), session: visitor, step: 'catalog', journey: 'recipe-first-v1' };
  assert.throws(() => acceptProductEvents(null, { visitor, events: [{ ...base, event: 'catalog_bot_started' }] }));
  assert.throws(() => acceptProductEvents(null, { visitor, events: [{ ...base, event: 'catalog_platform_selected', platform: 'private-data' }] }));
  assert.throws(() => acceptProductEvents(null, { visitor, events: [{ ...base, event: 'catalog_handoff_ready' }] }));
  const countBefore = db.prepare('SELECT COUNT(*) n FROM product_events').get().n;
  assert.throws(() => acceptProductEvents(null, { visitor, events: [{ ...base, event: 'catalog_open' }, { ...base, id: randomUUID(), event: 'catalog_recipe_saved' }] }));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM product_events').get().n, countBefore);
  createCampaign('journey-failure');
  const j = journey({ campaign: 'journey-failure' });
  outcome(j, 'catalog_bot_started');
  outcome(j, 'catalog_save_failed', { code: 'private raw exception', durationMs: -1 });
  const row = db.prepare("SELECT * FROM catalog_journey_outcomes WHERE flow_id=? AND event='catalog_save_failed'").get(j.flowId);
  assert.equal(row.code, null); assert.equal(row.duration_ms, null);
  assert.equal(report('journey-failure').failed, 1); assert.equal(report('journey-failure').saved, 0);
});

test('MAX optional aggregate is checked, unavailable stays unavailable and corrupt counts fail validation', () => {
  const product = maxFunnelSnapshot().all.productAnalytics.platforms[0];
  assert.equal(validProductReport(product), true);
  assert.equal(validProductReport({ ...product, catalogJourney: null }), true);
  const missing = { ...product }; delete missing.catalogJourney;
  assert.equal(validProductReport(missing), true);
  assert.equal(validProductReport({ ...product, catalogJourney: { ...product.catalogJourney, saved: product.catalogJourney.botStarted + 1 } }), false);
  assert.equal(validProductReport({ ...product, catalogJourney: { ...product.catalogJourney, secret: 'private' } }), false);
});

test('unreleased MAX reminder scenario remains unavailable with common code while Telegram keeps its report', () => {
  const telegram = productReport([]);
  assert.notEqual(telegram.trialReminders, null);
  assert.equal(telegram.catalogBenefits, null, 'production Telegram keeps the previous catalogue without the sales dialog');
  const file = `data/catalog-max-availability-${randomUUID()}.sqlite`;
  try {
    const source = `const {productReport,validProductReport}=await import('./src/product-analytics.js');
      const {db}=await import('./src/db.js');const r=productReport([]);
      process.stdout.write(JSON.stringify({platform:r.platform,reminders:r.trialReminders,benefits:r.catalogBenefits,valid:validProductReport(r)}));db.close();`;
    const r = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', source], {
      env: { ...process.env, DATABASE_PATH: file, BOT_PLATFORM: 'max' }, encoding: 'utf8', stdio: ['ignore','pipe','pipe']
    }));
    assert.deepEqual(r, { platform: 'max', reminders: null, benefits: null, valid: true });
    const max = maxFunnelSnapshot().all.productAnalytics.platforms[0];
    assert.equal(validProductReport({ ...max, trialReminders: null }), true);
    assert.equal(validProductReport({ ...max, trialReminders: { ...max.trialReminders, enrolled: -1 } }), false);
  } finally { for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true }); }
});

test('large unconverted cohort uses one pass over records without losing no-action visits', () => {
  createCampaign('journey-scale');
  const insert = db.prepare('INSERT INTO catalog_journey_visits(flow_id,session_id,campaign,local_origin,created_at) VALUES(?,?,?,1,?)');
  const event = db.prepare('INSERT INTO product_events(id,subject,user_id,event,step,flow_id,duration_ms,detail_json,created_at) VALUES(?,?,NULL,?,?,?,NULL,?,?)');
  const at = '2026-10-01T00:00:00.000Z';
  db.exec('BEGIN');
  for (let i = 0; i < 5000; i++) {
    const flow = randomUUID(), session = randomUUID(); insert.run(flow, session, 'journey-scale', at);
    event.run(randomUUID(), 'v:' + session, 'catalog_list', 'catalog', flow, JSON.stringify({ journey: 'recipe-first-v1' }), at);
  }
  db.exec('COMMIT');
  const started = performance.now(), r = report('journey-scale');
  assert.equal(r.visible, 5000); assert.equal(r.withoutStart24h, 5000); assert.equal(r.saved, 0);
  assert.ok(performance.now() - started < 3000, 'report must stay below MAX bridge request budget');
});
