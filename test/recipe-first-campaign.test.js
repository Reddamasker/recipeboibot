import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';

const file = `data/recipe-first-campaign-${randomUUID()}.sqlite`;
Object.assign(process.env, { DATABASE_PATH: file, BOT_PLATFORM: 'telegram', TEST_CONTOUR: 'false', TELEGRAM_POLLING: 'false',
  TELEGRAM_BOT_TOKEN: 'fixture', OPENAI_API_KEY: 'disabled', DINNER_LLM_ENABLED: 'false', APP_URL: 'https://recipes.example.test',
  YANDEX_DIRECT_TOKEN: 'fixture-token', YANDEX_DIRECT_LOGIN: 'fixture-login', YANDEX_DIRECT_PLACEMENT: 'ya-dinner-202610',
  YANDEX_DIRECT_CAMPAIGN_ID: '710000001', YANDEX_DIRECT_LANDING_CAMPAIGN_ID: '710000002', YANDEX_DIRECT_OUTSIDE_CAMPAIGN_ID: '710000003',
  YANDEX_DIRECT_MAX_CAMPAIGN_ID: '710000004', YANDEX_DIRECT_RECIPE_FIRST_CAMPAIGN_ID: '710000005' });
const { db, upsertTelegramUser, allowUser } = await import('../src/db.js');
const { createCampaign, campaignLink, advertisingRedirect, recordBotStart, funnelReport } = await import('../src/funnel.js');
const { RECIPE_FIRST_PLACEMENT: slug, RECIPE_FIRST_NAME } = await import('../src/recipe-first-acquisition.js');
const { directImportSettings, syncDirectStats, syncDirectCampaigns, directImportStatus, dashboardFunnelReport } = await import('../src/yandex-direct.js');
const { campaignPriceAssignment, DINNER_PRICE_EXPERIMENT } = await import('../src/campaign-prices.js');
const { registerCatalogAcquisitionVisit, createCatalogHandoff, resolveCatalogHandoff, recordCatalogBotStart } = await import('../src/catalog-handoff-transport.js');
const { catalogSearch } = await import('../src/web-catalog.js');
const oldSlugs = ['ya-dinner-202610','ya-dinner-landing-202610','ya-dinner-outside-202610','ya-max-dinner-202610'];
const newId = '710000005';
const report = (id, impressions = 100, clicks = 10, cost = '12.20') => new Response(`CampaignId\tImpressions\tClicks\tCost\n${id}\t${impressions}\t${clicks}\t${cost}\n`);
const idOf = request => JSON.parse(request.body).params.SelectionCriteria.Filter[0].Values[0];
function removeTestDatabase(database) {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(database + suffix); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
test.after(() => { db.close(); removeTestDatabase(file); });

test('new source is registered by its own import; five campaign histories and ad totals remain separate', async () => {
  assert.equal(db.prepare('SELECT 1 FROM acquisition_campaigns WHERE slug=?').get(slug), undefined);
  assert.equal(directImportSettings(slug).campaignId, newId);
  assert.throws(() => directImportSettings('unknown-site-campaign'), /не подключена/);
  const requested = [];
  await syncDirectCampaigns('all', { transport: async (_url, request) => { const id = idOf(request); requested.push(id); return report(id); } });
  assert.deepEqual(requested.sort(), ['710000001','710000002','710000003','710000004',newId]);
  assert.equal(db.prepare('SELECT name FROM acquisition_campaigns WHERE slug=?').get(slug).name, RECIPE_FIRST_NAME);
  for (const [index, old] of oldSlugs.entries()) assert.equal(directImportStatus(old).campaignId, `71000000${index + 1}`);
  const all = dashboardFunnelReport('all'), selected = dashboardFunnelReport(slug);
  assert.equal(all.impressions, 500); assert.equal(all.clicks, 50); assert.equal(all.directStats.costRub, 61);
  assert.deepEqual(all.advertisingCoverage, { campaignCount: 5, includedCampaignCount: 5 });
  assert.equal(selected.clicks, 10); assert.equal(selected.directStats.campaignId, newId);
  assert.equal(selected.directStats.includesVat, true); assert.equal(selected.defaultCampaign, slug);
  assert.equal(selected.campaigns.find(c => c.slug === slug).link, 'https://recipes.example.test/dinner?campaign=' + slug);
  assert.equal(campaignLink(slug), 'https://recipes.example.test/dinner?campaign=' + slug);
  assert.equal(campaignLink(oldSlugs[0]), 'https://recipes.example.test/go/' + oldSlugs[0]);
});

test('selected refresh changes only the new campaign and an alias cannot double count its spend or clicks', async () => {
  const previous = oldSlugs.map(directImportStatus), requested = [];
  await syncDirectCampaigns(slug, { transport: async (_url, request) => { const id = idOf(request); requested.push(id); return report(id, 200, 20, '24.40'); } });
  assert.deepEqual(requested, [newId]); assert.deepEqual(oldSlugs.map(directImportStatus), previous);
  const before = dashboardFunnelReport('all');
  await syncDirectStats({ settings: { ...directImportSettings(slug), slug: 'same-external-campaign-alias' }, transport: async () => report(newId, 200, 20, '24.40') });
  const all = dashboardFunnelReport('all');
  assert.equal(all.clicks, 60); assert.equal(all.directStats.costRub, 73.2); assert.equal(all.directStats.campaignCount, 5);
  assert.equal(all.clicks, before.clicks); assert.equal(all.directStats.costRub, before.directStats.costRub);
});

test('without a configured new campaign ID scheduler keeps old imports and historical data; invalid new ID fails before mutation', () => {
  const directory = path.resolve('data', `recipe-first-unconfigured-${randomUUID()}`);
  fs.mkdirSync(directory);
  const source = String.raw`
    import assert from 'node:assert/strict';
    const sourceRoot = ${JSON.stringify(pathToFileURL(path.resolve('src') + path.sep).href)};
    const {db}=await import(new URL('./db.js',sourceRoot));
    const {syncDirectStats,syncDirectCampaigns,directImportSettings,directImportStatus,dashboardFunnelReport}=await import(new URL('./yandex-direct.js',sourceRoot));
    const slug='ya-recipe-first-202610', requested=[];
    const transport=async(_url,request)=>{const id=JSON.parse(request.body).params.SelectionCriteria.Filter[0].Values[0];requested.push(id);return new Response('CampaignId\tImpressions\tClicks\tCost\n'+id+'\t100\t10\t12.20\n');};
    try {
      await syncDirectStats({settings:{...directImportSettings(slug),campaignId:'710000005'},transport});
      const previous=directImportStatus(slug); requested.length=0;
      await syncDirectCampaigns('all',{transport});
      assert.equal(requested.length,4);assert.ok(!requested.includes('710000005'));
      assert.deepEqual(directImportStatus(slug),previous);
      assert.equal(dashboardFunnelReport('all').defaultCampaign,'ya-dinner-202610');
      await assert.rejects(syncDirectCampaigns(slug,{transport:async()=>{throw new Error('must not call Yandex');}}),/Неверный ID/);
      assert.deepEqual(directImportStatus(slug),previous);
      console.log(JSON.stringify({passed:true}));
    } finally {db.close();}
  `;
  try {
    const result=execFileSync(process.execPath,['--input-type=module','-e',source],{cwd:directory,encoding:'utf8',env:{...process.env,DATABASE_PATH:path.join(directory,'fixture.sqlite'),YANDEX_DIRECT_RECIPE_FIRST_CAMPAIGN_ID:''}});
    assert.equal(JSON.parse(result).passed,true);
  } finally {
    removeTestDatabase(path.join(directory,'fixture.sqlite'));
    fs.rmdirSync(directory);
  }
});

async function siteContext() {
  const visit = { recipeId: catalogSearch().recipes[0].id, flowId: randomUUID(), sessionId: randomUUID(), campaign: slug, platform: 'telegram' };
  registerCatalogAcquisitionVisit({ ...visit, journey: 'recipe-first-v1', visible: true });
  return resolveCatalogHandoff(new URL(createCatalogHandoff(visit).url).searchParams.get('start'));
}

test('catalog start from the new registered source uses the existing price experiment for new platform identities', async () => {
  for (const identity of [988610001, 'max:988610002']) {
    const user = upsertTelegramUser({ id: identity }), context = await siteContext();
    recordCatalogBotStart(user, context); recordCatalogBotStart(user, context);
    const assignment = campaignPriceAssignment(user.id);
    assert.equal(assignment.campaign, slug); assert.equal(assignment.experiment_key, 'ya-dinner-promo-199-159-v1');
    assert.equal(assignment.variant, createHash('sha256').update(`${DINNER_PRICE_EXPERIMENT.key}:${user.id}`).digest()[0] < 128 ? 'A' : 'B');
    assert.equal(db.prepare('SELECT campaign FROM acquisition_starts WHERE user_id=?').get(user.id).campaign, slug);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM campaign_price_assignments WHERE user_id=?').get(user.id).n, 1);
    assert.deepEqual(campaignPriceAssignment(user.id), assignment);
  }
  assert.equal(funnelReport(slug).totals.starts, 2); assert.ok(funnelReport(slug).priceExperiment);
});

test('new landing never rewrites existing source or price assignment and returning or unrelated users remain ineligible', async () => {
  const oldUser = upsertTelegramUser({ id: 988610003 });
  recordBotStart(oldUser, '/start ' + new URL(advertisingRedirect(oldSlugs[0])).searchParams.get('start')); allowUser(oldUser.id);
  const previous = campaignPriceAssignment(oldUser.id), attribution = db.prepare('SELECT * FROM acquisition_starts WHERE user_id=?').get(oldUser.id);
  recordCatalogBotStart({ ...oldUser, is_allowed: 1 }, await siteContext());
  assert.deepEqual(campaignPriceAssignment(oldUser.id), previous);
  assert.deepEqual(db.prepare('SELECT * FROM acquisition_starts WHERE user_id=?').get(oldUser.id), attribution);
  const returning = upsertTelegramUser({ id: 988610004 }); allowUser(returning.id);
  recordCatalogBotStart({ ...returning, is_allowed: 1 }, await siteContext());
  assert.equal(campaignPriceAssignment(returning.id), null);
  createCampaign('unrelated-site-source');
  const unrelated = upsertTelegramUser({ id: 988610005 });
  recordBotStart(unrelated, '/start ' + new URL(advertisingRedirect('unrelated-site-source')).searchParams.get('start'));
  assert.equal(campaignPriceAssignment(unrelated.id), null);
  assert.equal(funnelReport(slug).totals.starts, 2); assert.equal(funnelReport(slug).returningStarts, 1);
});
