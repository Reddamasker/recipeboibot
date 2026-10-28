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
      navigation: 'initial', viewport: 'compact', pageNumber: 1
    }] });
    assert.deepEqual(accepted.accepted, [eventId]);
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
      assert.equal(report.status, 'ready');
      assert.equal(report.totalVisits, 1);
      assert.equal(report.summary.pageViews, 1);
      assert.equal(report.summary.measuredVisits, 0);
      assert.equal(report.summary.visibleMsTotal, null);
      assert.equal(report.visits[0].visibleMs, null, 'a started page is not a zero-duration sample');
      assert.equal(report.visits[0].pages[0].loadMs, null, 'page start does not assert visible content');
      assert.equal(report.visits[0].events[0].event, 'catalog_page_started');
      for (const secret of [visitor, flowId, pageId, eventId, process.env.MAX_FUNNEL_TOKEN])
        assert.ok(!body.includes(secret), 'report must omit session, event and credential identifiers');

      const unavailableResponse = await fetch(endpoint + '?campaign=' + campaign + '&platform=telegram', { headers });
      assert.equal(unavailableResponse.status, 200);
      const unavailable = await unavailableResponse.json();
      assert.equal(validCatalogDetailReport(unavailable), true);
      assert.equal(unavailable.status, 'unavailable');
      assert.equal(unavailable.summary, null);
      assert.equal(unavailable.totalVisits, null);
      assert.deepEqual(unavailable.visits, []);

      const emptyResponse = await fetch(endpoint + '?campaign=unknown-detail-campaign', { headers });
      assert.equal(emptyResponse.status, 200);
      const empty = await emptyResponse.json();
      assert.equal(validCatalogDetailReport(empty, { campaign: 'unknown-detail-campaign', platform: 'max' }), true);
      assert.equal(empty.status, 'ready', 'a source campaign may exist only on the main site');
      assert.equal(empty.totalVisits, 0);
      assert.equal(empty.summary.visibleMsTotal, null);
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
