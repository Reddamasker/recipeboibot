import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const file = path.resolve('data', `direct-test-${randomUUID()}.sqlite`);
process.env.DATABASE_PATH = file;
process.env.TELEGRAM_POLLING = 'false';
process.env.YANDEX_DIRECT_TOKEN = 'private-test-token';
process.env.TEST_CONTOUR = 'false';
process.env.DASHBOARD_PREVIEW = 'false';
process.env.YANDEX_DIRECT_LANDING_CAMPAIGN_ID = '715100001';
process.env.YANDEX_DIRECT_OUTSIDE_CAMPAIGN_ID = '715100002';
const { db, upsertTelegramUser, allowUser } = await import('../src/db.js');
const { funnelReport, createCampaign, setCampaignStats, advertisingRedirect, recordBotStart } = await import('../src/funnel.js');
const { directImportSettings, directReportRequest, parseDirectReport, syncDirectStats, syncDirectCampaigns, directImportStatus, dashboardFunnelReport, DIRECT_REPORT_URL, DIRECT_SYNC_INTERVAL_MS } = await import('../src/yandex-direct.js');
test.after(() => { db.close(); for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(file + suffix); } catch {} } });
const settings = { token: 'private-test-token', login: 'test-advertiser', campaignId: '715053149', slug: 'direct-fixture' };
const tsv = 'CampaignId\tImpressions\tClicks\tCost\n715053149\t100\t3\t16.47\n';

test('each new import requests fresh statistics while offline retries keep the original name', () => {
  const a = directReportRequest(settings.campaignId, new Date('2026-10-04T12:01:00Z'));
  assert.deepEqual(a, directReportRequest(settings.campaignId, new Date('2026-10-04T12:01:00Z')));
  const b = directReportRequest(settings.campaignId, new Date('2026-10-04T12:01:01Z'));
  assert.notEqual(a.params.ReportName, b.params.ReportName);
  assert.equal(DIRECT_SYNC_INTERVAL_MS, 300000);
  assert.equal(a.params.IncludeVAT, 'YES');
  assert.equal(a.params.DateRangeType, 'ALL_TIME');
  assert.deepEqual(a.params.SelectionCriteria.Filter[0].Values, ['715053149']);
  assert.throws(() => directReportRequest('bad'));
});
test('parser rejects other campaigns, duplicates, incomplete reports and malformed money; legitimate empty report is zero', () => {
  assert.deepEqual(parseDirectReport(tsv, settings.campaignId), { impressions: 100, clicks: 3, costKopeks: 1647 });
  assert.deepEqual(parseDirectReport('CampaignId\tImpressions\tClicks\tCost\n', settings.campaignId), { impressions: 0, clicks: 0, costKopeks: 0 });
  for (const invalid of ['', tsv.replace('715053149', '999'), tsv + tsv.split('\n')[1], tsv.replace('16.47', '-1'), tsv.replace('100\t', 'oops\t'), tsv.replace('16.47', '1.234')]) assert.throws(() => parseDirectReport(invalid, settings.campaignId));
});
test('queued report is retried unchanged and import replaces totals without touching tracked clicks or unrelated placements', async () => {
  createCampaign('other-placement'); setCampaignStats('other-placement', 777, 444);
  const requests = [];
  const transport = async (url, options) => {
    assert.equal(url, DIRECT_REPORT_URL); assert.equal(options.headers.returnMoneyInMicros, 'false');
    requests.push(options.body);
    return requests.length === 1 ? new Response('', { status: 201, headers: { retryIn: '1' } }) : new Response(tsv, { status: 200 });
  };
  await syncDirectStats({ settings, transport, wait: async () => {} });
  assert.equal(requests.length, 2); assert.equal(requests[0], requests[1]);
  assert.equal(directImportStatus(settings.slug).costRub, 16.47);
  assert.equal(directImportStatus(settings.slug).cpcRub, 5.49);
  assert.equal(funnelReport(settings.slug).impressions, 100);
  assert.equal(funnelReport(settings.slug).clicks, 0);
  assert.equal(funnelReport('other-placement').impressions, 777);
  await syncDirectStats({ settings, transport: async () => new Response(tsv) });
  assert.equal(funnelReport(settings.slug).impressions, 100);
});
test('failures preserve last successful figures and never persist credentials or response bodies', async () => {
  await assert.rejects(syncDirectStats({ settings, transport: async () => new Response(settings.token, { status: 403 }) }), /HTTP 403/);
  assert.equal(funnelReport(settings.slug).impressions, 100);
  assert.equal(directImportStatus(settings.slug).status, 'error');
  assert.ok(!JSON.stringify(directImportStatus(settings.slug)).includes(settings.token));
  await assert.rejects(syncDirectStats({ settings, transport: async () => { throw new Error(settings.token); } }), /Последние данные сохранены/);
  assert.ok(!JSON.stringify(directImportStatus(settings.slug)).includes(settings.token));
  await assert.rejects(syncDirectStats({ settings, transport: async () => new Response('bad report') }), /заголовок/);
  assert.equal(directImportStatus(settings.slug).clicks, 3);
  await assert.rejects(syncDirectStats({ settings, transport: async () => new Response(JSON.stringify({ error: { error_code: '58' } }), { status: 400 }) }), /ожидает одобрения/);
  assert.equal(funnelReport(settings.slug).impressions, 100);
});

test('dashboard uses two Direct clicks instead of 100 redirect requests and excludes organic starts from the campaign', async () => {
  const slug = 'ya-dinner-202610';
  createCampaign(slug);
  let payload;
  for (let i = 0; i < 100; i++) payload = new URL(advertisingRedirect(slug)).searchParams.get('start');
  const paidVisit = upsertTelegramUser({ id: 800000001, first_name: 'Реклама' });
  const organicVisit = upsertTelegramUser({ id: 800000002, first_name: 'Органика' });
  recordBotStart(paidVisit, `/start ${payload}`); allowUser(paidVisit.id);
  recordBotStart(organicVisit, '/start'); allowUser(organicVisit.id);
  await syncDirectStats({ settings: { ...settings, slug }, transport: async () => new Response(tsv.replace('100\t3\t16.47', '34\t2\t5.45')) });
  const report = dashboardFunnelReport(slug);
  assert.equal(report.clicks, 2);
  assert.equal(report.linkRequests, 100);
  assert.equal(report.impressions, 34);
  assert.equal(report.directStats.costRub, 5.45);
  assert.equal(report.totals.starts, 1);
  assert.equal(report.conversions.clickFromImpression, 5.9);
  assert.equal(report.conversions.startFromClick, 50);
  assert.equal(report.clickSource, 'direct');
  assert.equal(report.defaultCampaign, slug);
  assert.equal(report.campaigns.find(c => c.slug === slug).statsSource, 'direct');
  assert.equal(dashboardFunnelReport().totals.starts, 2);
  assert.equal(dashboardFunnelReport().conversions.startFromClick, 50);
  // Organic and manual URL requests must not erase or inflate Direct totals.
  assert.equal(dashboardFunnelReport().clicks, 2);
  assert.equal(dashboardFunnelReport().impressions, 34);
  assert.equal(dashboardFunnelReport().directStats.costRub, 5.45);
  assert.equal(dashboardFunnelReport('other-placement').clickSource, 'link');
  assert.equal(dashboardFunnelReport('other-placement').conversions.clickFromImpression, null);

  const { createServer } = await import('../src/server.js');
  const { createDashboardPassword, openDashboardSession } = await import('../src/funnel-auth.js');
  const cookie = `funnel_session=${openDashboardSession(createDashboardPassword())}`;
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/dashboard/funnel?campaign=${slug}`, { headers: { cookie } });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.clicks, 2); assert.equal(result.linkRequests, 100);
    assert.equal(result.conversions.startFromClick, 50);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('an uncompleted Direct import leaves clicks and advertising conversion unknown', () => {
  createCampaign('pending-direct');
  advertisingRedirect('pending-direct');
  db.prepare("INSERT INTO acquisition_direct_stats(slug,campaign_id,status) VALUES('pending-direct','715053149','error')").run();
  const report = dashboardFunnelReport('pending-direct');
  assert.equal(report.clicks, null); assert.equal(report.linkRequests, 1);
  assert.equal(report.conversions.clickFromImpression, null);
  assert.equal(report.conversions.startFromClick, null);
});

test('simultaneous imports keep three campaigns separate and coalesce only the same target', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const transport = async (_url, options) => {
    calls++; await gate;
    const id = JSON.parse(options.body).params.SelectionCriteria.Filter[0].Values[0];
    return new Response(`CampaignId\tImpressions\tClicks\tCost\n${id}\t${id === '715053149' ? 10 : 20}\t1\t2.00\n`);
  };
  const first = { ...settings, slug: 'route-direct' }, second = { ...settings, slug: 'ya-dinner-landing-202610', campaignId: '715100001' };
  const third = { ...settings, slug: 'ya-dinner-outside-202610', campaignId: '715100002' };
  const a = syncDirectStats({ settings: first, transport });
  const duplicate = syncDirectStats({ settings: first, transport });
  const b = syncDirectStats({ settings: second, transport });
  const c = syncDirectStats({ settings: third, transport });
  assert.equal(a, duplicate); assert.notEqual(a, b); release();
  await Promise.all([a, b, c]);
  assert.equal(calls, 3);
  assert.equal(dashboardFunnelReport(first.slug).impressions, 10);
  assert.equal(dashboardFunnelReport(second.slug).impressions, 20);
  assert.equal(directImportStatus(second.slug).campaignId, second.campaignId);
  assert.equal(directImportStatus(third.slug).campaignId, third.campaignId);
  assert.equal(dashboardFunnelReport(third.slug).clicks, 1);
  assert.ok(dashboardFunnelReport(third.slug).priceExperiment);
});

test('manual refresh resolves each registered placement to its own Direct campaign ID', () => {
  assert.equal(directImportSettings().campaignId, '715053149');
  assert.equal(directImportSettings('ya-dinner-landing-202610').campaignId, '715100001');
  assert.equal(directImportSettings('ya-dinner-outside-202610').campaignId, '715100002');
  assert.throws(() => directImportSettings('unknown-campaign'), /не подключена/);
});

test('all-users view sums three advertising campaigns, preserves organic users, and reports incomplete imports explicitly', async () => {
  createCampaign('site-landing', 'Лендинг — прямые посещения');
  for (let i = 0; i < 12; i++) advertisingRedirect('site-landing');
  const organic = upsertTelegramUser({ id: 800000004 });
  recordBotStart(organic, '/start'); allowUser(organic.id);
  const values = { '715053149': [200, 10, '10.10'], '715100001': [50, 2, '5.05'], '715100002': [0, 0, '0.00'] };
  const options = { at: new Date('2030-01-01T00:00:00Z'), transport: async (_url, request) => {
    const id = JSON.parse(request.body).params.SelectionCriteria.Filter[0].Values[0];
    return new Response(`CampaignId\tImpressions\tClicks\tCost\n${id}\t${values[id].join('\t')}\n`);
  } };
  await syncDirectCampaigns('all', options);
  const report = dashboardFunnelReport();
  assert.equal(report.impressions, 250); assert.equal(report.clicks, 12);
  assert.equal(report.directStats.costRub, 15.15); assert.equal(report.directStats.cpcRub, 1.26);
  assert.equal(report.directStats.aggregate, true);
  assert.deepEqual(report.advertisingCoverage, { campaignCount: 3, includedCampaignCount: 3 });
  assert.equal(report.totals.starts, 3);
  assert.equal(report.convertedClicks, 1);
  assert.equal(report.conversions.startFromClick, 8.3);
  assert.equal(report.conversions.clickFromImpression, 4.8);
  const selected = dashboardFunnelReport('ya-dinner-landing-202610');
  assert.equal(selected.clicks, 2); assert.equal(selected.directStats.costRub, 5.05);
  assert.equal(selected.directStats.aggregate, undefined);
  const { createServer } = await import('../src/server.js');
  const { createDashboardPassword, openDashboardSession } = await import('../src/funnel-auth.js');
  const cookie = `funnel_session=${openDashboardSession(createDashboardPassword())}`;
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const originalFetch = globalThis.fetch, requested = [];
  globalThis.fetch = async (url, input) => {
    if (String(url) !== DIRECT_REPORT_URL) return originalFetch(url, input);
    requested.push(JSON.parse(input.body).params.SelectionCriteria.Filter[0].Values[0]);
    return options.transport(url, input);
  };
  try {
    const page = await fetch(`http://127.0.0.1:${server.address().port}/dashboard?campaign=all`);
    assert.equal(page.headers.get('cache-control'), 'no-store', 'Dashboard must pick up the current client after a release');
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/dashboard/direct-sync`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-funnel-request': '1' }, body: JSON.stringify({ campaign: 'all' }) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).campaigns.length, 3);
    assert.deepEqual(requested.sort(), ['715053149', '715100001', '715100002']);
  } finally { globalThis.fetch = originalFetch; await new Promise(resolve => server.close(resolve)); }
  // Restore the unknown-import scenario without throwing away known campaigns.
  db.prepare("UPDATE acquisition_direct_stats SET impressions=NULL,clicks=NULL,cost_kopeks=NULL,synced_at=NULL,status='waiting' WHERE slug='ya-dinner-outside-202610'").run();
  const partial = dashboardFunnelReport();
  assert.equal(partial.clicks, 12); assert.equal(partial.impressions, 250);
  assert.equal(partial.advertisingCoverage.includedCampaignCount, 2);
  assert.equal(partial.advertisingCoverage.campaignCount, 3);
  assert.equal(partial.directStats.status, 'error'); // existing fixture failure remains visible
  assert.equal(dashboardFunnelReport('ya-dinner-outside-202610').clicks, null);
});

test('all-users refresh updates every configured campaign even when one import fails', async () => {
  const seen = [], options = { at: new Date('2030-01-02T00:00:00Z'), transport: async (_url, request) => {
    const id = JSON.parse(request.body).params.SelectionCriteria.Filter[0].Values[0]; seen.push(id);
    if (id === '715100002') return new Response('{}', { status: 403 });
    return new Response(`CampaignId\tImpressions\tClicks\tCost\n${id}\t10\t1\t1.00\n`);
  } };
  await assert.rejects(syncDirectCampaigns('all', options), /HTTP 403/);
  assert.deepEqual(seen.sort(), ['715053149', '715100001', '715100002']);
  assert.equal(directImportStatus('ya-dinner-202610').clicks, 1);
  assert.equal(directImportStatus('ya-dinner-landing-202610').clicks, 1);
  assert.equal(directImportStatus('ya-dinner-outside-202610').status, 'error');
  await syncDirectCampaigns('all', { at: new Date('2030-01-03T00:00:00Z'), transport: async () => new Response('CampaignId\tImpressions\tClicks\tCost\n') });
  const empty = dashboardFunnelReport();
  assert.equal(empty.impressions, 0); assert.equal(empty.clicks, 0);
  assert.equal(empty.directStats.costRub, 0);
  assert.equal(empty.directStats.includedCampaignCount, 3);
  assert.equal(empty.conversions.clickFromImpression, null);
});
