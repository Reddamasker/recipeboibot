import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

const file = path.resolve('data', `funnel-${randomUUID()}.sqlite`);
process.env.DATABASE_PATH = file;
process.env.TELEGRAM_BOT_TOKEN = 'funnel-test';
process.env.TELEGRAM_POLLING = 'false';
process.env.APP_URL = 'https://funnel.example.test';
process.env.TEST_CONTOUR = 'false';
process.env.ROBOKASSA_TEST = 'false';
process.env.ROBOKASSA_MERCHANT_LOGIN = 'funnel-shop';
process.env.ROBOKASSA_PASSWORD1 = 'funnel-pass1';
process.env.ROBOKASSA_PASSWORD2 = 'funnel-pass2';
process.env.ROBOKASSA_HASH_ALGORITHM = 'md5';
process.env.PAYMENT_TAX = 'none';
process.env.ANALYTICS_OWNER_ID = '6971956699';
const { db, upsertTelegramUser, allowUser, createRecipe, deleteUserData } = await import('../src/db.js');
const { startTrial, withFirstRecipe } = await import('../src/subscriptions.js');
const { createPaymentOrder, processRobokassaResult } = await import('../src/billing.js');
const { createCampaign, setCampaignStats, advertisingRedirect, recordBotStart, funnelReport } = await import('../src/funnel.js');
const { createDashboardPassword, openDashboardSession, closeDashboardSession, dashboardSessionValid } = await import('../src/funnel-auth.js');
const { createServer } = await import('../src/server.js');
const { handleMessage } = await import('../src/telegram.js');
let sequence = 93000;
const fixture = () => { const sender = { id: ++sequence, first_name: 'Воронка' }; return { sender, user: upsertTelegramUser(sender) }; };
const tokenFrom = url => new URL(url).searchParams.get('start');
const at = value => new Date(`2026-10-01T${value}:00.000Z`);

test('owner and Albina identities on both platforms are excluded retroactively and after recreation', async () => {
  const { landingReport } = await import('../src/landing-funnel.js');
  const { dashboardFunnelReport } = await import('../src/yandex-direct.js');
  const { maxFunnelSnapshot } = await import('../src/max-funnel.js');
  const slug = 'ya-dinner-202610';
  createCampaign(slug);
  const before = funnelReport('all');
  for (const identity of ['6971956699', '193553580', 'max:464796559', 'max:115437425']) {
    const user = upsertTelegramUser({ id: identity, first_name: 'Internal account' });
    const payload = tokenFrom(advertisingRedirect(slug));
    recordBotStart(user, `/start ${payload}`, at('09:00')); allowUser(user.id);
    createRecipe(user.id, { status: 'ready', title: 'Internal recipe' });
    startTrial(user.id);
    const order = createPaymentOrder(user.id);
    db.prepare("UPDATE payment_orders SET status='paid',is_test=0,paid_at=? WHERE id=?").run(new Date().toISOString(), order.id);
    // Existing assignments/payments must be filtered, not deleted.
    db.prepare("INSERT OR REPLACE INTO campaign_price_assignments(user_id,experiment_key,campaign,variant,assigned_at) VALUES(?, 'ya-dinner-promo-199-159-v1', ?, 'A', ?)").run(user.id, slug, at('09:00').toISOString());
    db.prepare('INSERT INTO landing_visits(id,campaign,tags_json,opened_at,click_token) VALUES(?,?,?,?,?)').run(randomUUID(), slug, '{}', at('09:00').toISOString(), payload.slice(3));
  }
  assert.deepEqual(funnelReport('all').totals, before.totals);
  assert.deepEqual(maxFunnelSnapshot().all.totals, before.totals);
  const campaign = funnelReport(slug);
  assert.deepEqual(campaign.totals, { starts: 0, firstRecipe: 0, selectedRecipe: 0, trial: 0, paid: 0 });
  assert.equal(campaign.convertedClicks, 0);
  assert.equal(campaign.returningStarts, 0);
  assert.equal(campaign.priceExperiment.rows.reduce((sum, row) => sum + row.revenueRub, 0), 0);
  assert.equal(landingReport(slug).starts, 0);
  db.prepare("INSERT INTO acquisition_direct_stats(slug,campaign_id,impressions,clicks,cost_kopeks,status) VALUES(?, 'internal-check', 100, 10, 500, 'ready')").run(slug);
  const dashboard = dashboardFunnelReport('all');
  assert.equal(dashboard.convertedClicks, 0);
  assert.equal(dashboard.directStats.clicks, 10);
  assert.equal(dashboard.directStats.costRub, 5);
  const albina = db.prepare('SELECT id FROM users WHERE telegram_id=?').get('max:115437425');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM recipes WHERE user_id=?').get(albina.id).n, 1);
  assert.ok(db.prepare('SELECT * FROM user_trials WHERE user_id=?').get(albina.id));
  deleteUserData(albina.id);
  const recreated = upsertTelegramUser({ id: 'max:115437425', first_name: 'Internal account' });
  allowUser(recreated.id); recordBotStart({ ...recreated, is_allowed: 1 }, `/start ${tokenFrom(advertisingRedirect(slug))}`);
  assert.equal(funnelReport(slug).returningStarts, 0);
  assert.deepEqual(funnelReport('all').totals, before.totals);
});
test.after(() => { db.close(); for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(file + suffix); } catch {} } });

test('tracked redirects skip link previews and HEAD, never redirect to arbitrary hosts, and unknown links do not count', () => {
  createCampaign('redirect', 'Размещение');
  for (const input of [{ method: 'HEAD' }, { userAgent: 'TelegramBot' }, { userAgent: 'facebookexternalhit' }, { purpose: 'prefetch' }]) {
    assert.equal(advertisingRedirect('redirect', input), 'https://t.me/Recipeboibot?start=dinner');
  }
  assert.equal(funnelReport('redirect').clicks, 0);
  const location = advertisingRedirect('redirect', { userAgent: 'Mozilla/5.0' });
  assert.match(location, /^https:\/\/t.me\/Recipeboibot\?start=ad_[A-Za-z0-9_-]{24}$/);
  assert.equal(funnelReport('redirect').clicks, 1);
  assert.throws(() => advertisingRedirect('missing'), { status: 404 });
  assert.throws(() => advertisingRedirect('redirect', { method: 'POST' }), { status: 405 });
  assert.throws(() => createCampaign('../evil'), { status: 400 });
  assert.throws(() => createCampaign('all'), { status: 400 });
});

test('first start attribution is immutable, returning users and owner are excluded from new campaign cohorts', () => {
  createCampaign('first'); createCampaign('second');
  const { user } = fixture(), returning = fixture().user;
  allowUser(returning.id);
  const first = tokenFrom(advertisingRedirect('first')), second = tokenFrom(advertisingRedirect('second'));
  recordBotStart(user, `/start ${first}`, at('10:00')); allowUser(user.id);
  recordBotStart({ ...user, is_allowed: 1 }, `/start ${second}`, at('10:01'));
  recordBotStart({ ...returning, is_allowed: 1 }, `/start ${second}`, at('10:02'));
  const owner = upsertTelegramUser({ id: 6971956699, first_name: 'Владелец' });
  recordBotStart(owner, `/start ${second}`); allowUser(owner.id);
  assert.equal(funnelReport('first').totals.starts, 1);
  assert.equal(funnelReport('second').totals.starts, 0);
  assert.equal(funnelReport('second').returningStarts, 1);
  assert.equal(funnelReport('first').conversions.startFromClick, 100);
  const organic = fixture().user;
  recordBotStart(organic, '/start'); allowUser(organic.id);
  recordBotStart({ ...organic, is_allowed: 1 }, `/start ${second}`);
  assert.equal(funnelReport('second').totals.starts, 0);
  recordBotStart(fixture().user, '/start ad_unknown');
  assert.equal(funnelReport('second').totals.starts, 0);
});

test('ordered funnel counts unique users while direct trial and payment remain visible in milestone totals', () => {
  createCampaign('chain'); setCampaignStats('chain', 1000, 700); setCampaignStats('chain', 1000, 700);
  const a = fixture().user, b = fixture().user;
  for (const user of [a, b]) { recordBotStart(user, `/start ${tokenFrom(advertisingRedirect('chain'))}`, at('10:00')); allowUser(user.id); }
  const recipe = createRecipe(a.id, { status: 'ready', title: 'Готовый рецепт' });
  db.prepare('UPDATE recipes SET created_at=? WHERE id=?').run(at('10:01').toISOString(), recipe.id);
  createRecipe(a.id, { status: 'ready', title: 'Второй рецепт' });
  db.prepare('INSERT INTO dinner_events(id,user_id,event,created_at) VALUES(?,?,?,?)').run(randomUUID(), a.id, 'recommendation_accepted', at('10:01').toISOString());
  startTrial(a.id, at('10:02')); startTrial(a.id, at('10:03'));
  startTrial(b.id, at('10:01'));
  const order = createPaymentOrder(a.id, {}, at('10:04'));
  const signature = createHash('md5').update(`${order.priceRub.toFixed(2)}:${order.invId}:funnel-pass2`).digest('hex');
  const params = { OutSum: order.priceRub.toFixed(2), InvId: order.invId, SignatureValue: signature };
  processRobokassaResult(params, at('10:05')); processRobokassaResult(params, at('10:06'));
  assert.equal(db.prepare('SELECT is_test FROM payment_orders WHERE id=?').get(order.id).is_test, 0);
  const report = funnelReport('chain');
  assert.deepEqual(report.ordered, { starts: 2, firstRecipe: 1, selectedRecipe: 1, trial: 1, paid: 1 });
  assert.deepEqual(report.totals, { starts: 2, firstRecipe: 1, selectedRecipe: 1, trial: 2, paid: 1 });
  assert.equal(report.impressions, 1000); assert.equal(report.reach, 700);
  assert.equal(report.conversions.firstRecipeFromStart, 50);
  assert.equal(report.conversions.clickFromImpression, 0.2);
  assert.throws(() => setCampaignStats('chain', -1), { status: 400 });
  assert.throws(() => setCampaignStats('chain', 1, 2), { status: 400 });
});

test('failed first recipe and unfinished payment are excluded; deleted account cascades attribution', async () => {
  createCampaign('failures');
  const { user } = fixture();
  recordBotStart(user, `/start ${tokenFrom(advertisingRedirect('failures'))}`); allowUser(user.id);
  await assert.rejects(withFirstRecipe(user.id, 'failed', async () => { throw new Error('generation failed'); }));
  assert.equal(funnelReport('failures').totals.firstRecipe, 0);
  assert.equal(funnelReport('failures').totals.paid, 0);
  deleteUserData(user.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM acquisition_starts WHERE user_id=?').get(user.id).n, 0);
  assert.equal(funnelReport('failures').clicks, 1);
});

test('unknown ad statistics stay null; reach is never summed across placements; private profiles excluded', () => {
  assert.equal(funnelReport('redirect').impressions, null);
  const user = upsertTelegramUser({ id: `private-test:${randomUUID()}`, first_name: 'Проба' });
  recordBotStart(user, '/start'); allowUser(user.id);
  assert.equal(funnelReport().reach, null);
  assert.equal(funnelReport().impressions, null);
  assert.ok(funnelReport().trackingSince);
});

test('trial and manual access are not payments; test and legacy orders cannot inflate paid users', () => {
  createCampaign('payments');
  const user = fixture().user;
  recordBotStart(user, `/start ${tokenFrom(advertisingRedirect('payments'))}`, at('10:00')); allowUser(user.id);
  startTrial(user.id, at('10:01'));
  const order = createPaymentOrder(user.id, {}, at('10:02'));
  assert.equal(funnelReport('payments').totals.paid, 0);
  db.prepare("UPDATE payment_orders SET status='paid',paid_at=?,is_test=1 WHERE id=?").run(at('10:03').toISOString(), order.id);
  assert.equal(funnelReport('payments').totals.paid, 0);
  assert.equal(funnelReport('payments').testPaidUsers, 1);
  db.prepare('UPDATE payment_orders SET is_test=NULL WHERE id=?').run(order.id);
  assert.equal(funnelReport('payments').totals.paid, 0);
  assert.equal(funnelReport('payments').unclassifiedPaidUsers, 1);
  db.prepare('UPDATE payment_orders SET is_test=0 WHERE id=?').run(order.id);
  assert.equal(funnelReport('payments').totals.paid, 1);
  assert.equal(funnelReport('payments').ordered.paid, 0);
});

test('Yandex tags survive Telegram start and identify the ordered recipe, trial and payment cohort', () => {
  createCampaign('yandex');
  const tags = new URLSearchParams({ utm_source: 'ya', utm_medium: 'cpc', utm_campaign: 'dinner_search', utm_content: '123', utm_term: 'что приготовить на ужин', campaign_id: '456', adgroup_id: '789', phrase_id: '321', device: 'mobile', yclid: 'click-1', redirect: 'https://evil.example' });
  const payload = tokenFrom(advertisingRedirect('yandex', { searchParams: tags }));
  const stored = JSON.parse(db.prepare('SELECT tags_json FROM acquisition_clicks WHERE token=?').get(payload.slice(3)).tags_json);
  assert.equal(stored.utm_term, 'что приготовить на ужин'); assert.equal(stored.yclid, 'click-1'); assert.equal(stored.redirect, undefined);
  const user = fixture().user;
  recordBotStart(user, `/start ${payload}`, at('10:00')); allowUser(user.id);
  const recipe = createRecipe(user.id, { status: 'ready', title: 'Ужин' });
  db.prepare('UPDATE recipes SET created_at=? WHERE id=?').run(at('10:01').toISOString(), recipe.id);
  db.prepare('INSERT INTO dinner_events(id,user_id,event,created_at) VALUES(?,?,?,?)').run(randomUUID(), user.id, 'recommendation_accepted', at('10:01').toISOString());
  startTrial(user.id, at('10:02'));
  const order = createPaymentOrder(user.id, {}, at('10:03'));
  db.prepare("UPDATE payment_orders SET status='paid',paid_at=?,is_test=0 WHERE id=?").run(at('10:04').toISOString(), order.id);
  const returning = fixture().user; allowUser(returning.id);
  recordBotStart({ ...returning, is_allowed: 1 }, `/start ${payload}`, at('10:05'));
  advertisingRedirect('yandex', { searchParams: tags });
  const group = funnelReport('yandex').attribution[0];
  assert.deepEqual(group, { placement: 'yandex', source: 'ya', medium: 'cpc', campaign: 'dinner_search', ad: '123', keyword: 'что приготовить на ужин', clicks: 2, starts: 1, firstRecipe: 1, selectedRecipe: 1, trial: 1, paid: 1 });
  assert.deepEqual(funnelReport().attribution.find(row => row.placement === 'yandex'), group);
  const long = new URLSearchParams({ utm_term: 'a'.repeat(600) + '\n', utm_content: '<script>alert(1)</script>' });
  const next = tokenFrom(advertisingRedirect('yandex', { searchParams: long }));
  const bounded = JSON.parse(db.prepare('SELECT tags_json FROM acquisition_clicks WHERE token=?').get(next.slice(3)).tags_json);
  assert.equal(bounded.utm_term.length, 256);
  assert.equal(funnelReport('yandex').attribution.length, 2);
});

test('dashboard sessions use hashes, expire and revoke; password rotation ends all sessions', () => {
  const password = createDashboardPassword();
  assert.throws(() => openDashboardSession('incorrect'), { status: 401 });
  const session = openDashboardSession(password, 1000);
  assert.equal(dashboardSessionValid(session, 1001), true);
  assert.equal(dashboardSessionValid(session, 1000 + 7 * 86400000), false);
  assert.equal(db.prepare('SELECT token_hash FROM funnel_sessions').get().token_hash.includes(session), false);
  closeDashboardSession(session); assert.equal(dashboardSessionValid(session, 1001), false);
  const active = openDashboardSession(password); createDashboardPassword();
  assert.equal(dashboardSessionValid(active), false);
  assert.throws(() => openDashboardSession(password), { status: 401 });
});

test('dashboard requires password and cookie, rejects cross-origin writes, and supports placement management', async () => {
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const original = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith('https://api.telegram.org/')) { calls.push(JSON.parse(options.body)); return new Response(JSON.stringify({ ok: true, result: { message_id: 42 } })); }
    return original(url, options);
  };
  try {
    const password = createDashboardPassword();
    assert.equal((await fetch(`${base}/dashboard`)).status, 200);
    assert.equal((await fetch(`${base}/api/dashboard/funnel`)).status, 401);
    const post = { method: 'POST', headers: { 'content-type': 'application/json', 'x-funnel-request': '1' }, body: JSON.stringify({ password }) };
    assert.equal((await fetch(`${base}/api/dashboard/login`, { ...post, body: JSON.stringify({ password: 'bad' }) })).status, 401);
    assert.equal((await fetch(`${base}/api/dashboard/login`, { ...post, headers: { ...post.headers, origin: 'https://evil.example' } })).status, 403);
    const login = await fetch(`${base}/api/dashboard/login`, post);
    assert.equal(login.status, 200);
    assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
    const cookie = login.headers.get('set-cookie').split(';')[0], headers = { ...post.headers, cookie };
    const response = await fetch(`${base}/api/dashboard/funnel?campaign=chain`, { headers });
    assert.equal(response.status, 200); assert.equal((await response.json()).totals.paid, 1);
    assert.equal((await fetch(`${base}/api/dashboard/campaigns`, { method: 'POST', headers: { cookie }, body: JSON.stringify({ slug: 'denied' }) })).status, 403);
    const create = await fetch(`${base}/api/dashboard/campaigns`, { method: 'POST', headers, body: JSON.stringify({ slug: 'channel_1', name: 'Канал & тест' }) });
    assert.equal(create.status, 201); assert.match((await create.json()).link, /\/go\/channel_1$/);
    assert.equal((await fetch(`${base}/api/dashboard/stats`, { method: 'PUT', headers, body: JSON.stringify({ slug: 'channel_1', impressions: 100, reach: 50 }) })).status, 200);
    assert.equal(funnelReport('channel_1').impressions, 100);
    const before = funnelReport('redirect').clicks;
    assert.equal((await fetch(`${base}/go/redirect`, { method: 'HEAD', redirect: 'manual' })).status, 302);
    assert.equal(funnelReport('redirect').clicks, before);
    const redirect = await fetch(`${base}/go/redirect?utm_source=ya&utm_campaign=http-test&utm_term=${encodeURIComponent('что приготовить на ужин')}`, { redirect: 'manual', headers: { 'user-agent': 'Mozilla/5.0' } });
    assert.equal(redirect.status, 302); assert.match(redirect.headers.get('location'), /start=ad_/);
    const captured = JSON.parse(db.prepare('SELECT tags_json FROM acquisition_clicks WHERE token=?').get(tokenFrom(redirect.headers.get('location')).slice(3)).tags_json);
    assert.equal(captured.utm_source, 'ya'); assert.equal(captured.utm_term, 'что приготовить на ужин');
    assert.equal((await fetch(`${base}/go/does-not-exist`, { redirect: 'manual' })).status, 404);
    const { sender } = fixture(), payload = tokenFrom(advertisingRedirect('channel_1'));
    await handleMessage({ from: sender, chat: { id: sender.id, type: 'private' }, text: `/start ${payload}` });
    assert.equal(funnelReport('channel_1').totals.starts, 1);
    assert.equal((await fetch(`${base}/api/dashboard/logout`, { method: 'POST', headers, body: '{}' })).status, 200);
    assert.equal((await fetch(`${base}/api/dashboard/funnel`, { headers })).status, 401);
  } finally { globalThis.fetch = original; await new Promise(resolve => server.close(resolve)); }
});

test('automatic Telegram route preserves attribution, skips probes and leaves existing redirects intact', async () => {
  createCampaign('auto-open');
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const before = db.prepare('SELECT COUNT(*) AS n FROM acquisition_clicks').get().n;
    const organic = await fetch(base + '/open/telegram');
    assert.equal(organic.status, 200);
    assert.equal(organic.headers.get('cache-control'), 'no-store');
    assert.ok(organic.headers.get('content-security-policy').includes("script-src 'self'"));
    assert.ok((await organic.text()).includes('https://t.me/Recipeboibot?start=dinner'));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM acquisition_clicks').get().n, before);
    const head = await fetch(base + '/open/telegram?campaign=auto-open', { method: 'HEAD' });
    assert.equal(head.status, 200); assert.equal(await head.text(), '');
    const probe = await fetch(base + '/open/telegram?campaign=auto-open', { headers: { 'user-agent': 'TelegramBot' } });
    assert.equal(probe.status, 200); assert.equal(funnelReport('auto-open').clicks, 0);
    const opened = await fetch(base + '/open/telegram?campaign=auto-open&utm_source=qa&yclid=test-only',
      { headers: { 'user-agent': 'Mozilla/5.0' } });
    const html = await opened.text();
    const payload = html.match(/start=(ad_[A-Za-z0-9_-]{24})/)[1];
    assert.ok(html.includes(`data-app-url="tg://resolve?domain=Recipeboibot&amp;start=${payload}"`));
    const click = db.prepare('SELECT * FROM acquisition_clicks WHERE token=?').get(payload.slice(3));
    assert.equal(click.campaign, 'auto-open');
    assert.deepEqual(JSON.parse(click.tags_json), { utm_source: 'qa', yclid: 'test-only' });
    assert.equal(funnelReport('auto-open').clicks, 1);
    assert.equal((await fetch(base + '/open/telegram', { method: 'POST' })).status, 405);
    assert.equal((await fetch(base + '/open/telegram?campaign=missing')).status, 404);
    const old = await fetch(base + '/go/auto-open', { method: 'HEAD', redirect: 'manual' });
    assert.equal(old.status, 302); assert.equal(old.headers.get('location'), 'https://t.me/Recipeboibot?start=dinner');
    const js = await fetch(base + '/telegram-open.js');
    assert.equal(js.status, 200); assert.ok((await js.text()).includes('location.assign(appUrl)'));
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('recipe choice is distinct from viewing, deduplicated across stored sources and excludes pre-start and internal actions', () => {
  createCampaign('selection');
  const shown = fixture().user, chosen = fixture().user, early = fixture().user;
  for (const user of [shown, chosen, early]) { recordBotStart(user, '/start ' + tokenFrom(advertisingRedirect('selection')), at('10:00')); allowUser(user.id); }
  const event = (user, name, time) => db.prepare('INSERT INTO dinner_events(id,user_id,event,created_at) VALUES(?,?,?,?)').run(randomUUID(), user.id, name, at(time).toISOString());
  for (const user of [shown, chosen, early]) { event(user, 'recommendation_shown', '10:01'); event(user, 'dinner_recommendation_opened', '10:01'); }
  event(chosen, 'recommendation_accepted', '10:02'); event(chosen, 'dinner_recommendation_accepted', '10:02'); event(chosen, 'recommendation_accepted', '10:03');
  event(early, 'recommendation_accepted', '09:59');
  db.prepare('INSERT INTO first_recipe_selections(user_id,recipe_id,title,source,recipe_json,selected_at) VALUES(?,?,?,?,?,?)').run(chosen.id, 'selected', 'Choice', 'dinner', '{}', at('10:02').toISOString());
  startTrial(chosen.id, at('10:04')); startTrial(shown.id, at('10:04'));
  const report = funnelReport('selection');
  assert.equal(report.totals.selectedRecipe, 1); assert.equal(report.ordered.selectedRecipe, 1);
  assert.equal(report.totals.trial, 2); assert.equal(report.ordered.trial, 1);
  assert.equal(report.conversions.selectionFromRecipe, 33.3); assert.equal(report.conversions.trialAfterSelection, 100);
  assert.equal(report.attribution.reduce((sum,row) => sum + row.selectedRecipe, 0), 1);
  const internal = upsertTelegramUser({ id: '193553580' }); event(internal, 'recommendation_accepted', '10:02');
  assert.equal(funnelReport('selection').totals.selectedRecipe, 1);
});
