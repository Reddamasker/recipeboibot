import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID, randomBytes } from 'node:crypto';

const file = `data/max-quality-${randomUUID()}.sqlite`;
Object.assign(process.env, { DATABASE_PATH: file, BOT_PLATFORM: 'max', TEST_CONTOUR: 'false', MAX_BOT_TOKEN: 'fixture', MAX_BOT_USERNAME: 'id500912857935_bot',
  MAX_WEBHOOK_SECRET: 's'.repeat(64), MAX_FUNNEL_TOKEN: 'a'.repeat(43), TELEGRAM_BOT_TOKEN: '', TELEGRAM_POLLING: 'false', ROBOKASSA_TEST: 'false', DINNER_LLM_ENABLED: 'false', OPENAI_API_KEY: 'disabled' });
const { db, upsertTelegramUser } = await import('../src/db.js');
const { createServer } = await import('../src/server.js');
const { createCampaign, recordBotStart } = await import('../src/funnel.js');
const { dashboardFunnelReport } = await import('../src/yandex-direct.js');
const { maxFunnelSnapshot, mergeMaxFunnelReport } = await import('../src/max-funnel.js');
const slug = 'quality-recipe-first';
const options = { enabled: true, origin: 'https://recipeboibot-max.89-223-123-75.sslip.io', token: 'a'.repeat(43) };
const startAt = Date.now() - 86400000, date = offset => new Date(startAt + offset).toISOString();
let userId = 877000;
function account(campaign, { trial = false, paid = false, testPayment = false, returning = false, early = false, identity = null } = {}) {
  const user = upsertTelegramUser({ id: identity || 'max:' + ++userId });
  const token = randomBytes(18).toString('base64url');
  db.prepare('INSERT INTO acquisition_clicks(token,campaign,created_at,tags_json) VALUES(?,?,?,?)').run(token, campaign, date(-1000), '{}');
  recordBotStart({ ...user, is_allowed: returning ? 1 : 0 }, '/start ad_' + token, new Date(startAt));
  db.prepare('INSERT INTO dinner_events(id,user_id,event,created_at) VALUES(?,?,?,?)').run(randomUUID(), user.id, 'recommendation_shown', date(1000));
  if (trial) db.prepare('INSERT INTO user_trials(user_id,starts_at,expires_at) VALUES(?,?,?)').run(user.id, date(early ? -5000 : 2000), date(7 * 86400000));
  if (paid) db.prepare(`INSERT INTO payment_orders(id,user_id,experiment_key,variant,amount_kopeks,kind,status,created_at,updated_at,paid_at,is_test)
    VALUES(?,?,'quality','A',19900,'initial','paid',?,?,?,?)`).run(randomUUID(), user.id, date(early ? -5000 : 2500), date(early ? -5000 : 3000), date(early ? -5000 : 3000), testPayment ? 1 : 0);
  return user;
}
createCampaign(slug); createCampaign('quality-unrelated');
account(slug, { trial: true, paid: true });
account(slug, { trial: true, paid: true, testPayment: true });
account(slug, { trial: true, paid: true, early: true });
account(slug, { trial: true, paid: true, returning: true });
account(slug, { trial: true, paid: true, identity: 'max:464796559' });
account('quality-unrelated', { trial: true, paid: true });
const local = () => {
  const r = dashboardFunnelReport(slug);
  r.preview = true;
  r.productAnalytics.platforms.forEach(p => { p.platform = 'telegram'; });
  return r;
};
test.after(() => { db.close(); for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true }); });

test('scoped MAX aggregate uses first-source new-account cohort and existing verified trial/payment records', () => {
  const snapshot = maxFunnelSnapshot(slug);
  assert.equal(snapshot.version, 9); assert.equal(snapshot.placement, slug);
  assert.equal(snapshot.campaign.totals.starts, 3);
  assert.equal(snapshot.campaign.totals.trial, 2); assert.equal(snapshot.campaign.totals.paid, 1);
  assert.equal(snapshot.campaign.returningStarts, 1); assert.equal(snapshot.campaign.testPaidUsers, 1);
  assert.ok(!JSON.stringify(snapshot).includes('max:877')); assert.ok(!JSON.stringify(snapshot).includes(options.token));
});

test('protected scoped endpoint rejects unauthenticated and invalid sources and returns read-only zero for absent source', async () => {
  const server = createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/api/internal/max-funnel`;
  const headers = { authorization: 'Bearer ' + options.token };
  try {
    assert.equal((await fetch(base + '?campaign=' + slug)).status, 404);
    assert.equal((await fetch(base + '?campaign=all', { headers })).status, 400);
    assert.equal((await fetch(base + '?campaign=' + encodeURIComponent('https://other.example'), { headers })).status, 400);
    const before = db.prepare('SELECT COUNT(*) n FROM acquisition_campaigns').get().n;
    const response = await fetch(base + '?campaign=quality-absent', { headers });
    assert.equal(response.status, 200); const report = await response.json();
    assert.equal(report.placement, 'quality-absent'); assert.equal(report.campaign.totals.starts, 0);
    assert.equal(report.campaign.totals.trial, 0); assert.equal(report.campaign.totals.paid, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM acquisition_campaigns').get().n, before);
  } finally { await new Promise(r => server.close(r)); }
});

test('selected-source quality keeps Telegram counts and click conversion separate from MAX account outcomes', async () => {
  const original = local(), snapshot = maxFunnelSnapshot(slug);
  const result = await mergeMaxFunnelReport(original, { ...options, transport: async (url, init) => {
    assert.equal(url, options.origin + '/api/internal/max-funnel?campaign=' + slug);
    assert.equal(init.redirect, 'error'); assert.equal(init.headers.authorization, 'Bearer ' + options.token);
    return Response.json(snapshot);
  } });
  assert.equal(result.remoteFunnel.status, 'ready');
  assert.deepEqual(result.totals, original.totals); assert.deepEqual(result.ordered, original.ordered);
  assert.equal(result.convertedClicks, original.convertedClicks); assert.deepEqual(result.conversions, original.conversions);
  const [telegram, max] = result.campaignPlatformOutcomes.platforms;
  assert.equal(telegram.platform, 'telegram'); assert.equal(telegram.trial, original.totals.trial);
  assert.equal(max.platform, 'max'); assert.equal(max.starts, 3); assert.equal(max.trial, 2); assert.equal(max.paid, 1);
  assert.equal(max.trialFromStart, 66.7); assert.equal(max.paidFromStart, 33.3);
  assert.deepEqual(result.productAnalytics.platforms.map(p => p.platform), ['telegram','max']);
  assert.equal(original.campaignPlatformOutcomes, undefined, 'source report is not mutated');
  if (process.env.WRITE_QUALITY_FIXTURES === 'true') {
    fs.mkdirSync('outputs/landing-20261028', { recursive: true });
    fs.writeFileSync('outputs/landing-20261028/quality-ready.json', JSON.stringify(result));
  }
});

test('mismatched source, previous schema, corrupt counts and outage never masquerade as zero MAX outcomes', async () => {
  const invalid = maxFunnelSnapshot(slug); invalid.campaign.totals.trial = invalid.campaign.totals.starts + 1;
  const negative = maxFunnelSnapshot(slug); negative.campaign.returningStarts = -1;
  for (const response of [maxFunnelSnapshot(), maxFunnelSnapshot('quality-unrelated'), invalid, negative, null]) {
    const original = local();
    const result = await mergeMaxFunnelReport(original, { ...options, transport: async () => {
      if (response === null) throw new Error('private network error'); return Response.json(response);
    } });
    assert.equal(result.remoteFunnel.status, 'error');
    assert.equal(result.campaignPlatformOutcomes.platforms[1].status, 'unavailable');
    assert.equal(result.campaignPlatformOutcomes.platforms[1].trial, null); assert.equal(result.campaignPlatformOutcomes.platforms[1].paid, null);
    assert.deepEqual(result.totals, original.totals); assert.deepEqual(result.conversions, original.conversions);
    assert.ok(!JSON.stringify(result).includes('private network error'));
    if (process.env.WRITE_QUALITY_FIXTURES === 'true') fs.writeFileSync('outputs/landing-20261028/quality-unavailable.json', JSON.stringify(result));
  }
});

test('valid absent remote campaign remains distinguishable from unavailable bridge', async () => {
  const original = local(); original.campaign = { ...original.campaign, slug: 'quality-absent', name: 'Quality — absent in MAX' };
  original.campaigns.push({ ...original.campaign });
  const result = await mergeMaxFunnelReport(original, { ...options, transport: async () => Response.json(maxFunnelSnapshot('quality-absent')) });
  const max = result.campaignPlatformOutcomes.platforms[1];
  assert.equal(max.status, 'ready'); assert.equal(max.starts, 0); assert.equal(max.trial, 0); assert.equal(max.paid, 0);
  assert.equal(max.trialFromStart, null); assert.equal(max.paidFromStart, null);
  if (process.env.WRITE_QUALITY_FIXTURES === 'true') fs.writeFileSync('outputs/landing-20261028/quality-empty.json', JSON.stringify(result));
});
