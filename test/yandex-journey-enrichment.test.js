import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'recipe-ad-enrichment-'));
process.env.DATABASE_PATH = path.join(directory, 'test.sqlite');
process.env.TELEGRAM_POLLING = 'false';
process.env.TEST_CONTOUR = 'false';
process.env.DASHBOARD_PREVIEW = 'false';
process.env.BOT_PLATFORM = 'telegram';
const { db } = await import('../src/db.js');
const { createCampaign } = await import('../src/funnel.js');
const { recordLandingView, landingRedirect } = await import('../src/landing-funnel.js');
const { parseYandexJson, safeSearchQuery, metrikaJourneyRequest, interpretMetrikaJourney,
  syncJourneyEnrichment, enrichUserAdJourneyReport } = await import('../src/yandex-journey-enrichment.js');

const campaign = 'ya-product-landing-202611';
const adId = '1926569031941060981';
const now = new Date('2026-11-10T17:00:00.000Z');
const settings = { testContour: false, dashboardPreview: false, botPlatform: 'telegram',
  yandexDirectProductCampaignId: '716018649', yandexDirectToken: '', yandexDirectLogin: 'test-account',
  yandexMetrikaToken: 'not-a-real-metrika-token', yandexMetrikaCounterId: 114158743 };
const json = data => new Response(JSON.stringify(data));
function visit({ client = '1700000000000123456', clicked = true } = {}) {
  const id = randomUUID().replaceAll('-', '');
  createCampaign(campaign);
  recordLandingView({ visitId: id, query: new URLSearchParams({ campaign,
    utm_source: 'ya', utm_medium: 'cpc', utm_content: adId, campaign_id: '716018649',
    adgroup_id: '5822301389', utm_term: 'Рекламная ключевая фраза' }).toString() });
  if (clicked) landingRedirect(id, { platform: 'max' });
  db.prepare('UPDATE landing_visits SET metrika_client_id=?,opened_at=? WHERE id=?').run(client, now.toISOString(), id);
  return db.prepare('SELECT * FROM landing_visits WHERE id=?').get(id);
}
function metrika(row, query = 'блины на молоке', overrides = {}) {
  return { sampled: false, sample_share: 1, total_rows: 1, data: [{ dimensions: [
    { id: row.metrika_client_id }, { id: '716018649', name: 'Campaign' },
    { id: adId, name: 'Ad' }, { name: query } ], metrics: [1] }], ...overrides };
}
function report(row, extra = {}) {
  return { users: [{ id: 'test-user', platform: 'max', campaign, clickToken: row.max_click_token,
    ad: { id: null, campaignId: null, groupId: null }, search: { query: null, keyword: null }, ...extra }] };
}
test.beforeEach(() => db.exec('DELETE FROM landing_ad_enrichment; DELETE FROM direct_creative_cache; DELETE FROM user_ad_enrichment_state; DELETE FROM landing_visits;'));
test.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });

test('unsafe Direct numeric IDs retain all digits and search values redact sensitive content', () => {
  const parsed = parseYandexJson('{"Id":1926569031941060981,"CampaignId":716018649}');
  assert.equal(parsed.Id, adId); assert.equal(parsed.CampaignId, 716018649);
  assert.equal(safeSearchQuery('  блины\nна молоке  '), 'блины на молоке');
  for (const value of ['', '(not set)', 'Не определено', '<не определено>']) assert.equal(safeSearchQuery(value), null);
  for (const value of ['token=secret-test', 'https://private.example/abc', 'mail@example.com', '+7 999 123 45 67']) assert.equal(safeSearchQuery(value), '[скрыто]');
  assert.equal(safeSearchQuery('я'.repeat(300)).length, 256);
});

test('query lookup pins both browser and unique landing marker and excludes multi-marker sessions', () => {
  const row = visit(); const url = metrikaJourneyRequest(row, settings, now);
  assert.equal(url.origin, 'https://api-metrika.yandex.net');
  assert.equal(url.searchParams.get('accuracy'), 'full');
  assert.equal(url.searchParams.get('date1'), '2026-11-09');
  assert.equal(url.searchParams.get('date2'), '2026-11-10');
  const afterMidnight = metrikaJourneyRequest({ ...row, opened_at: '2026-11-10T21:01:00.000Z' }, settings, new Date('2026-11-10T21:02:00.000Z'));
  assert.equal(afterMidnight.searchParams.get('date1'), '2026-11-10');
  assert.equal(afterMidnight.searchParams.get('date2'), '2026-11-11');
  const olderVisit = metrikaJourneyRequest(row, settings, new Date('2026-11-20T00:00:00.000Z'));
  assert.equal(olderVisit.searchParams.get('date2'), '2026-11-11');
  assert.match(url.searchParams.get('filters'), new RegExp(`clientID=='${row.metrika_client_id}'`));
  assert.ok(url.searchParams.get('filters').includes(`EXISTS(ym:s:paramsLevel1=='recipe_visit_id' AND ym:s:paramsLevel2=='${row.id}')`));
  assert.ok(url.searchParams.get('filters').includes(`NONE(ym:s:paramsLevel1=='recipe_visit_id' AND ym:s:paramsLevel2!='${row.id}')`));
  assert.throws(() => metrikaJourneyRequest({ ...row, id: "bad' OR 1" }, settings));
  assert.throws(() => metrikaJourneyRequest({ ...row, metrika_client_id: 'NaN' }, settings));
});

test('actual query requires one unsampled visit and exact campaign, ad and client match', () => {
  const row = visit(); const ready = metrika(row);
  assert.deepEqual(interpretMetrikaJourney(ready, row), { status: 'ready', query: 'блины на молоке' });
  for (const data of [metrika(row, '', { data: [] }), metrika(row, '(not set)')]) assert.deepEqual(interpretMetrikaJourney(data, row), { status: 'not_available', query: null });
  for (const patch of [{ sampled: true }, { sample_share: .5 }, { total_rows: 2 }, { data: [ready.data[0], ready.data[0]] }]) {
    assert.deepEqual(interpretMetrikaJourney(metrika(row, 'query', patch), row), { status: 'ambiguous', query: null });
  }
  const many = metrika(row); many.data[0].metrics = [2];
  assert.equal(interpretMetrikaJourney(many, row).status, 'ambiguous');
  for (const index of [0, 1, 2]) {
    const mismatched = metrika(row); mismatched.data[0].dimensions[index].id = '123';
    assert.deepEqual(interpretMetrikaJourney(mismatched, row), { status: 'ambiguous', query: null });
  }
});

test('no-access status is explicit, throttled and never includes server credentials', async () => {
  const row = visit(); let calls = 0;
  const transport = async (_url, options) => { calls++; assert.equal(options.headers.Authorization, 'OAuth not-a-real-metrika-token'); return json({ errors: [{ message: 'denied' }] }, 403); };
  const denied = async (url, options) => { await transport(url, options); return new Response('not-a-real-metrika-token', { status: 403 }); };
  const result = await syncJourneyEnrichment({ settings, at: now, transport: denied });
  assert.equal(result.queries.status, 'no_access');
  const displayed = enrichUserAdJourneyReport(report(row));
  assert.equal(displayed.users[0].search.status, 'no_access');
  assert.equal(displayed.users[0].search.query, null);
  assert.ok(!JSON.stringify(displayed).includes(settings.yandexMetrikaToken));
  await syncJourneyEnrichment({ settings, at: new Date(now.getTime() + 1000), transport: denied });
  assert.equal(calls, 1);
});

test('MAX marker joins main landing details and caches only an exactly matched actual query', async () => {
  const row = visit();
  await syncJourneyEnrichment({ settings, at: now, transport: async () => json(metrika(row)) });
  const displayed = enrichUserAdJourneyReport(report(row)).users[0];
  assert.equal(displayed.ad.id, adId);
  assert.equal(displayed.ad.campaignId, '716018649');
  assert.equal(displayed.search.query, 'блины на молоке');
  assert.equal(displayed.search.status, 'ready');
  assert.equal(displayed.search.keyword, 'Рекламная ключевая фраза');
  assert.equal(displayed.clickToken, undefined);
  const foreign = enrichUserAdJourneyReport(report(row, { campaign: 'other-campaign' })).users[0];
  assert.equal(foreign.search.query, null);
  assert.equal(foreign.ad.id, null);
});

test('unknown query never falls back to targeting keyword, and missing browser identity stays explicit', () => {
  const row = visit({ client: null });
  const displayed = enrichUserAdJourneyReport(report(row)).users[0];
  assert.equal(displayed.search.keyword, 'Рекламная ключевая фраза');
  assert.equal(displayed.search.query, null);
  assert.equal(displayed.search.status, 'no_client_id');
  assert.equal(enrichUserAdJourneyReport(report(row, { clickToken: 'unlinked-token' })).users[0].search.status, 'unlinked');
});

test('responsive ad variants preserve large ID, remain labelled current and oversized responses fail closed', async () => {
  const row = visit();
  const adBody = '{"result":{"Ads":[{"Id":1926569031941060981,"CampaignId":716018649,"AdGroupId":5822301389,"Type":"RESPONSIVE_AD","ResponsiveAd":{"Titles":[{"Title":"Первый заголовок"},{"Title":"Второй заголовок"}],"Texts":[{"Text":"Текст объявления"}]}}]}}';
  const withDirect = { ...settings, yandexDirectToken: 'not-a-real-direct-token' };
  await syncJourneyEnrichment({ settings: withDirect, at: now, transport: async url => String(url).includes('api.direct.') ? new Response(adBody) : json(metrika(row)) });
  const ad = enrichUserAdJourneyReport(report(row)).users[0].ad;
  assert.equal(ad.id, adId); assert.equal(ad.title, 'Первый заголовок / Второй заголовок');
  assert.equal(ad.text, 'Текст объявления'); assert.equal(ad.kind, 'responsive'); assert.equal(ad.creativeStatus, 'current');
  const failed = await syncJourneyEnrichment({ settings: withDirect, at: new Date(now.getTime() + 3600001), transport: async url => String(url).includes('api.direct.') ? new Response('x'.repeat(1024 * 1024 + 1)) : json({ data: [] }) });
  assert.equal(failed.ads.status, 'error');
  assert.equal(enrichUserAdJourneyReport(report(row)).users[0].ad.title, ad.title);
});

test('no linked visits still checks access, but preview/test/MAX never contact advertising APIs', async () => {
  let calls = 0;
  const transport = async () => { calls++; return new Response('', { status: 403 }); };
  const state = await syncJourneyEnrichment({ settings, at: now, transport });
  assert.equal(state.queries.status, 'no_access'); assert.equal(calls, 1);
  for (const patch of [{ testContour: true }, { dashboardPreview: true }, { botPlatform: 'max' }]) {
    assert.deepEqual(await syncJourneyEnrichment({ settings: { ...settings, ...patch }, at: now, transport }), { skipped: true });
  }
  assert.equal(calls, 1);
});
