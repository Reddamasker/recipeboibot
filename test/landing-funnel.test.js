import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
const file = path.resolve('data', `landing-test-${randomUUID()}.sqlite`);
process.env.DATABASE_PATH = file;
process.env.TELEGRAM_BOT_TOKEN = 'landing-test-only';
process.env.TELEGRAM_API_ORIGIN = 'https://api.telegram.org';
process.env.TELEGRAM_POLLING = 'false';
process.env.TEST_CONTOUR = 'false';
process.env.ROBOKASSA_TEST = 'false';
process.env.OPENAI_API_KEY = 'test-disabled';
const { db, upsertTelegramUser, allowUser, getPendingIntent } = await import('../src/db.js');
const { createCampaign, funnelReport, recordBotStart } = await import('../src/funnel.js');
const { recordLandingView, landingRedirect, landingReport, landingStartIntent } = await import('../src/landing-funnel.js');
const { createServer } = await import('../src/server.js');
const { handleMessage } = await import('../src/telegram.js');
test.after(() => { db.close(); for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(file + suffix); } catch {} } });
const visitId = () => randomUUID().replaceAll('-', '');
const startFrom = url => new URL(url).searchParams.get('start');

test('HTML loads, visible landing events and advertising redirects remain separate; public events reject cross-origin writes', async () => {
  createCampaign('ya-dinner-202610');
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const before = landingReport();
  const input = { visitId: visitId(), query: 'utm_campaign=ya_dinner_search_202610&yclid=test-click&token=private&redirect=https://evil.example' };
  const post = { method: 'POST', headers: { 'content-type': 'application/json', 'x-landing-request': '1' }, body: JSON.stringify(input) };
  try {
    await fetch(base, { method: 'HEAD' });
    await (await fetch(base, { headers: { 'user-agent': 'YandexBot' } })).text();
    await fetch(`${base}/go/ya-dinner-202610`, { redirect: 'manual', headers: { 'user-agent': 'Mozilla/5.0' } });
    assert.equal(landingReport().htmlLoads, before.htmlLoads);
    await (await fetch(base, { headers: { 'user-agent': 'Mozilla/5.0' } })).text();
    assert.equal(landingReport().htmlLoads, before.htmlLoads + 1);
    assert.equal(landingReport().totalViews, before.totalViews);
    assert.equal((await fetch(`${base}/api/landing/view`, { ...post, headers: { ...post.headers, origin: 'https://evil.example' } })).status, 403);
    assert.equal((await fetch(`${base}/api/landing/view`, { ...post, headers: { 'content-type': 'application/json' } })).status, 403);
    const response = await fetch(`${base}/api/landing/view`, post);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).href, `/landing/go/${input.visitId}`);
    await fetch(`${base}/api/landing/view`, post);
    assert.equal(landingReport('ya-dinner-202610').views, 1);
    const tags = JSON.parse(db.prepare('SELECT tags_json FROM landing_visits WHERE id=?').get(input.visitId).tags_json);
    assert.equal(tags.yclid, 'test-click'); assert.equal(tags.token, undefined); assert.equal(tags.redirect, undefined);
    const url = `${base}/landing/go/${input.visitId}`;
    await fetch(url, { method: 'HEAD', redirect: 'manual' });
    await fetch(url, { redirect: 'manual', headers: { 'user-agent': 'TelegramBot' } });
    assert.equal(landingReport('ya-dinner-202610').telegramClicks, 0);
    const a = await fetch(url, { redirect: 'manual', headers: { 'user-agent': 'Mozilla/5.0' } });
    const b = await fetch(url, { redirect: 'manual', headers: { 'user-agent': 'Mozilla/5.0' } });
    assert.equal(a.status, 302); assert.equal(a.headers.get('location'), b.headers.get('location'));
    assert.match(a.headers.get('location'), /^https:\/\/t.me\/Recipeboibot\?start=lp_[A-Za-z0-9_-]{24}$/);
    assert.equal(landingReport('ya-dinner-202610').telegramClicks, 1);
    assert.equal((await fetch(`${base}/landing/go/missing`, { redirect: 'manual' })).status, 404);
    assert.equal((await fetch(`${base}/api/landing/view`)).status, 405);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('landing start preserves the save-recipe action and campaign attribution without AI or real Telegram messages', async () => {
  const id = visitId();
  recordLandingView({ visitId: id, query: 'campaign=ya-dinner-202610&utm_content=ad-123' });
  const payload = startFrom(landingRedirect(id));
  assert.equal(landingStartIntent(`/start ${payload}`), 'save');
  const sender = { id: 890000001, first_name: 'Лендинг' };
  const original = globalThis.fetch, messages = [];
  globalThis.fetch = async (url, options) => {
    assert.ok(String(url).startsWith('https://api.telegram.org/'), 'No AI or other network calls');
    messages.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }));
  };
  try { await handleMessage({ from: sender, chat: { id: sender.id, type: 'private' }, text: `/start ${payload}` }); }
  finally { globalThis.fetch = original; }
  const user = upsertTelegramUser(sender);
  assert.equal(getPendingIntent(user.id).kind, 'recipe-save');
  assert.equal(db.prepare('SELECT campaign FROM acquisition_starts WHERE user_id=?').get(user.id).campaign, 'ya-dinner-202610');
  assert.equal(landingReport('ya-dinner-202610').starts, 1);
  assert.equal(funnelReport('ya-dinner-202610').totals.starts, 1);
  assert.ok(messages.some(message => message.text?.includes('Сохранить рецепт')));
  assert.equal(landingStartIntent('/start lp_not_a_real_token'), null);
});

test('untagged visits stay separate; returning users and owner do not inflate new landing starts', () => {
  const id = visitId(); recordLandingView({ visitId: id, query: 'campaign=unknown&email=private' });
  assert.equal(db.prepare('SELECT campaign FROM landing_visits WHERE id=?').get(id).campaign, null);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM acquisition_campaigns WHERE slug='unknown'").get().n, 0);
  const payload = startFrom(landingRedirect(id));
  const returning = upsertTelegramUser({ id: 890000002 }); allowUser(returning.id);
  recordBotStart({ ...returning, is_allowed: 1 }, `/start ${payload}`);
  const owner = upsertTelegramUser({ id: 6971956699 }); recordBotStart(owner, `/start ${payload}`);
  assert.equal(landingReport('site-landing').views, 1);
  assert.equal(landingReport('site-landing').telegramClicks, 1);
  assert.equal(landingReport('site-landing').starts, 0);
  assert.equal(landingReport('ya-dinner-202610').starts, 1);
  const before = landingReport().totalViews;
  recordLandingView({ visitId: visitId(), query: '' }, { userAgent: 'YandexBot' });
  assert.equal(landingReport().totalViews, before);
  assert.throws(() => recordLandingView({ visitId: 'bad', query: '' }), { status: 400 });
});

async function browserFixture({ hidden = false, mini = false, background = false, fails = false, dinner = false } = {}) {
  const link = { href: 'https://t.me/Recipeboibot?start=save' }, calls = [], events = {};
  const title = {};
  const root = { hidden, getClientRects: () => [{}], querySelector: selector => selector === '#lp-title' ? title : null, querySelectorAll: () => [link] };
  const document = { visibilityState: background ? 'hidden' : 'visible', readyState: 'complete', getElementById: () => root, addEventListener: (name, fn) => { events[name] = fn; } };
  vm.runInNewContext(fs.readFileSync('public/landing-metrics.js', 'utf8'), {
    document, window: { __miniLaunch: mini }, location: { origin: 'https://site.example', search: dinner ? '?campaign=ya-dinner-landing-202610&secret=private' : '?utm_campaign=ya_dinner_search_202610&secret=private' },
    crypto: { getRandomValues: bytes => bytes.fill(1) }, Uint8Array, Set, URL, URLSearchParams,
    fetch: async (url, options) => { calls.push({ url, options }); if (fails) throw new Error('offline'); return { ok: true, json: async () => ({ href: '/landing/go/' + '01'.repeat(16) }) }; }
  });
  await new Promise(resolve => setImmediate(resolve));
  return { link, calls, events, document, title };
}
test('client records only a visible landing, skips Mini App, and sends one event per page without private query values', async () => {
  for (const mode of [{ hidden: true }, { mini: true }]) assert.equal((await browserFixture(mode)).calls.length, 0);
  const background = await browserFixture({ background: true }); assert.equal(background.calls.length, 0);
  background.document.visibilityState = 'visible'; await background.events.visibilitychange(); assert.equal(background.calls.length, 1);
  const page = await browserFixture(); assert.equal(page.calls.length, 1);
  await page.events.visibilitychange(); assert.equal(page.calls.length, 1);
  assert.equal(JSON.parse(page.calls[0].options.body).query, 'utm_campaign=ya_dinner_search_202610');
  assert.match(page.link.href, /^\/landing\/go\/[a-f0-9]{32}$/);
});
test('analytics failure leaves the original Telegram link available', async () => {
  const page = await browserFixture({ fails: true });
  assert.equal(page.link.href, 'https://t.me/Recipeboibot?start=save');
});

test('paid landing opens the dinner onboarding with its own attribution and stable price experiment', async () => {
  const slug = 'ya-dinner-landing-202610'; createCampaign(slug);
  const id = visitId(); recordLandingView({ visitId: id, query: 'utm_campaign=ya_dinner_landing_search_202610&yclid=landing-ad' });
  assert.equal(db.prepare('SELECT campaign FROM landing_visits WHERE id=?').get(id).campaign, slug);
  assert.equal(startFrom(landingRedirect(id, { method: 'HEAD' })), 'dinner');
  const payload = startFrom(landingRedirect(id));
  assert.equal(landingStartIntent(`/start ${payload}`), 'dinner');
  const sender = { id: 890000003, first_name: 'Ужин' };
  const original = globalThis.fetch, messages = [];
  globalThis.fetch = async (url, options) => {
    assert.ok(String(url).startsWith('https://api.telegram.org/'));
    messages.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 43 } }));
  };
  try { await handleMessage({ from: sender, chat: { id: sender.id, type: 'private' }, text: `/start ${payload}` }); }
  finally { globalThis.fetch = original; }
  const user = upsertTelegramUser(sender);
  assert.notEqual(getPendingIntent(user.id)?.kind, 'recipe-save');
  assert.equal(db.prepare('SELECT campaign FROM acquisition_starts WHERE user_id=?').get(user.id).campaign, slug);
  assert.equal(landingReport(slug).starts, 1);
  const { campaignPriceAssignment } = await import('../src/campaign-prices.js');
  assert.equal(campaignPriceAssignment(user.id).campaign, slug);
  assert.ok(funnelReport(slug).priceExperiment);
  assert.ok(!messages.some(message => message.text?.startsWith('<b>Сохранить рецепт</b>')));
  const page = await browserFixture({ dinner: true });
  assert.equal(page.title.textContent, 'Что приготовить на ужин?');
  assert.match(page.link.href, /^\/landing\/go\//);
  const offline = await browserFixture({ dinner: true, fails: true });
  assert.equal(startFrom(offline.link.href), 'dinner');
});
