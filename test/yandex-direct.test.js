import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const file = path.resolve('data', `direct-test-${randomUUID()}.sqlite`);
process.env.DATABASE_PATH = file;
process.env.TELEGRAM_POLLING = 'false';
process.env.YANDEX_DIRECT_TOKEN = '';
const { db } = await import('../src/db.js');
const { funnelReport, createCampaign, setCampaignStats } = await import('../src/funnel.js');
const { directReportRequest, parseDirectReport, syncDirectStats, directImportStatus, DIRECT_REPORT_URL } = await import('../src/yandex-direct.js');
test.after(() => { db.close(); for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(file + suffix); } catch {} } });
const settings = { token: 'private-test-token', login: 'test-advertiser', campaignId: '715053149', slug: 'direct-fixture' };
const tsv = 'CampaignId\tImpressions\tClicks\tCost\n715053149\t100\t3\t16.47\n';

test('report filters one campaign, includes VAT and has a stable name for offline polling', () => {
  const a = directReportRequest(settings.campaignId, new Date('2026-10-04T12:01:00Z'));
  const b = directReportRequest(settings.campaignId, new Date('2026-10-04T12:20:00Z'));
  assert.deepEqual(a, b);
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
