import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

test('MAX detail endpoint requires its own token, preserves missing data and excludes private identifiers', () => {
  const file = path.resolve('data', 'catalog-detail-max-' + randomUUID() + '.sqlite');
  const code = `
    import assert from 'node:assert/strict';
    import { randomUUID } from 'node:crypto';
    const { createServer } = await import('./src/server.js');
    const { db } = await import('./src/db.js');
    const { createCampaign } = await import('./src/funnel.js');
    const { acceptProductEvents } = await import('./src/product-analytics.js');
    const { validCatalogDetailReport } = await import('./src/catalog-detail-analytics.js');
    const campaign = 'catalog-detail-max-fixture';
    createCampaign(campaign, 'MAX detail fixture');
    const visitor = randomUUID(), flowId = randomUUID(), pageId = randomUUID(), eventId = randomUUID();
    const accepted = acceptProductEvents(null, { visitor, events: [{
      id: eventId, event: 'catalog_page_started', step: 'catalog',
      flowId, journey: 'recipe-first-v1', campaign, pageId, screen: 'list',
      navigation: 'initial', viewport: 'compact', pageNumber: 1,
      selection:{version:1,products:['курица'],cuisine:'georgian',query:'чахохбили',minutes:null,category:null,excludedCount:0}
    }] });
    assert.deepEqual(accepted.accepted, [eventId]);
    function anotherVisit(active) {
      const session = randomUUID(), flow = randomUUID(), page = randomUUID();
      const shared = { step: 'catalog', flowId: flow, journey: 'recipe-first-v1', campaign, pageId: page, screen: 'list' };
      const events = [
        { id: randomUUID(), ...shared, event: 'catalog_page_started', navigation: 'initial', viewport: 'compact', pageNumber: 1 },
        { id: randomUUID(), ...shared, event: 'catalog_list', durationMs: 230, results: 12 },
        active
          ? { id: randomUUID(), ...shared, event: 'catalog_action', action: 'filter_change', control: 'time' }
          : { id: randomUUID(), ...shared, event: 'catalog_page_progress', visibleMs: 1000, elapsedMs: 1000, scrollDepth: 20, cardsSeen: 3, reason: 'heartbeat' }
      ];
      assert.equal(acceptProductEvents(null, { visitor: session, events }).accepted.length, events.length);
    }
    anotherVisit(false);
    anotherVisit(true);
    const server = createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + server.address().port;
    const endpoint = base + '/api/internal/catalog-visits';
    const headers = { authorization: 'Bearer ' + process.env.MAX_FUNNEL_TOKEN };
    const before = db.prepare('SELECT COUNT(*) AS n FROM product_events').get().n;
    try {
      assert.equal((await fetch(endpoint)).status, 404);
      assert.equal((await fetch(endpoint, { headers: { authorization: 'Bearer invalid' } })).status, 404);
      assert.equal((await fetch(endpoint, { headers, method: 'POST' })).status, 404);
      assert.equal((await fetch(base + '/api/dashboard/catalog-visits', { headers })).status, 401,
        'the internal token does not grant a dashboard session');

      const response = await fetch(endpoint + '?campaign=' + campaign, { headers });
      assert.equal(response.status, 200);
      const body = await response.text(), report = JSON.parse(body);
      const filters = { campaign, platform: 'max', from: '', to: '', page: 1 };
      assert.equal(validCatalogDetailReport(report, filters), true);
      assert.equal(report.version, 3);
      assert.equal(report.status, 'ready');
      assert.equal(report.group, 'all');
      assert.equal(report.totalVisits, 3);
      assert.equal(report.summary.visits, 3);
      assert.equal(report.summary.pageViews, 3);
      assert.equal(report.summary.measuredVisits, 1);
      assert.equal(report.summary.visibleMsTotal, 1000);
      assert.equal(report.groups.length, 12);
      assert.equal(report.groups.reduce((sum, group) => sum + group.count, 0), 3);
      assert.deepEqual(report.groups.filter(group => group.count).map(group => [group.id, group.count]).sort(),
        [['active_catalog', 1], ['brief_catalog', 1], ['unconfirmed', 1]]);
      const original = report.visits.find(visit => visit.number === 1);
      assert.equal(original.group, 'unconfirmed');
      assert.equal(original.visibleMs, null, 'a started page is not a zero-duration sample');
      assert.equal(original.pages[0].loadMs, null, 'page start does not assert visible content');
      assert.equal(report.summary.selectionVisits,1);assert.equal(report.summary.emptySelectionVisits,0);
      assert.equal(original.pages[0].selection.query,'чахохбили');assert.deepEqual(original.pages[0].selection.products,['курица']);
      assert.ok(report.selectionTrackingSince);assert.equal(original.pages[0].resultsTotal,null);
      assert.equal(original.events[0].event, 'catalog_page_started');
      assert.equal(validCatalogDetailReport({ ...report, version: 1 }, filters), false,
        'the group contract must reject an older response schema');
      for (const secret of [visitor, flowId, pageId, eventId, process.env.MAX_FUNNEL_TOKEN])
        assert.ok(!body.includes(secret), 'report must omit session, event and credential identifiers');

      const groupedResponse = await fetch(endpoint + '?campaign=' + campaign + '&group=brief_catalog', { headers });
      assert.equal(groupedResponse.status, 200);
      const grouped = await groupedResponse.json();
      assert.equal(validCatalogDetailReport(grouped, { ...filters, group: 'brief_catalog' }), true);
      assert.equal(grouped.group, 'brief_catalog');
      assert.equal(grouped.totalVisits, 1);
      assert.deepEqual(grouped.summary, report.summary, 'group selection preserves the complete campaign summary');
      assert.deepEqual(grouped.groups, report.groups, 'group counts do not shrink to the selected path');
      assert.equal(grouped.visits.length, 1);
      assert.equal(grouped.visits[0].number, 2, 'the visit keeps its number in the entire campaign cohort');
      assert.equal(grouped.visits[0].group, 'brief_catalog');
      assert.equal(validCatalogDetailReport(grouped, { ...filters, group: 'active_catalog' }), false,
        'a response for a different path is unavailable, not a substitute list');
      const later = await (await fetch(endpoint + '?campaign=' + campaign + '&group=brief_catalog&page=2', { headers })).json();
      assert.equal(validCatalogDetailReport(later, { ...filters, group: 'brief_catalog', page: 2 }), true);
      assert.equal(later.totalVisits, 1);
      assert.deepEqual(later.visits, []);
      assert.deepEqual(later.summary, report.summary);
      assert.equal((await fetch(endpoint + '?group=invalid-path', { headers })).status, 400);

      const unavailableResponse = await fetch(endpoint + '?campaign=' + campaign + '&platform=telegram', { headers });
      assert.equal(unavailableResponse.status, 200);
      const unavailable = await unavailableResponse.json();
      assert.equal(validCatalogDetailReport(unavailable), true);
      assert.equal(unavailable.status, 'unavailable');
      assert.equal(unavailable.summary, null);
      assert.equal(unavailable.groups, null);
      assert.equal(unavailable.totalVisits, null);
      assert.deepEqual(unavailable.visits, []);

      const emptyResponse = await fetch(endpoint + '?campaign=unknown-detail-campaign', { headers });
      assert.equal(emptyResponse.status, 200);
      const empty = await emptyResponse.json();
      assert.equal(validCatalogDetailReport(empty, { campaign: 'unknown-detail-campaign', platform: 'max' }), true);
      assert.equal(empty.status, 'ready', 'a source campaign may exist only on the main site');
      assert.equal(empty.totalVisits, 0);
      assert.equal(empty.summary.visibleMsTotal, null);
      assert.equal(empty.groups.length, 12);
      assert.ok(empty.groups.every(group => group.count === 0));
      assert.deepEqual(empty.visits, []);
      assert.equal((await fetch(endpoint + '?campaign=invalid%2Fslug', { headers })).status, 400);
      assert.equal((await fetch(endpoint + '?page=0', { headers })).status, 400);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM product_events').get().n, before,
        'report reads do not generate product events');
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM acquisition_campaigns WHERE slug='unknown-detail-campaign'").get().n, 0,
        'report reads do not create missing campaigns');
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      db.close();
    }
  `;
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 30000,
      env: { ...process.env, DATABASE_PATH: file, BOT_PLATFORM: 'max', TEST_CONTOUR: 'false',
        MAX_BOT_TOKEN: 'fixture-disabled', MAX_BOT_USERNAME: 'fixture_max_bot', MAX_WEBHOOK_SECRET: 's'.repeat(64),
        MAX_FUNNEL_TOKEN: 'a'.repeat(43), TELEGRAM_BOT_TOKEN: 'fixture-disabled', TELEGRAM_POLLING: 'false',
        OPENAI_API_KEY: 'disabled', DINNER_LLM_ENABLED: 'false', DINNER_IMAGES_ENABLED: 'false',
        APP_URL: 'https://max.example.test', DASHBOARD_PREVIEW: 'false' }
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
  }
});
