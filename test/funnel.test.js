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
const { createCampaign, setCampaignStats, advertisingRedirect, recordBotStart, funnelReport, funnelCommand, formatFunnel } = await import('../src/funnel.js');
const { createServer } = await import('../src/server.js');
const { makeTelegramInitData } = await import('../src/security.js');
const { handleMessage } = await import('../src/telegram.js');
let sequence = 93000;
const fixture = () => { const sender = { id: ++sequence, first_name: 'Воронка' }; return { sender, user: upsertTelegramUser(sender) }; };
const tokenFrom = url => new URL(url).searchParams.get('start');
const at = value => new Date(`2026-10-01T${value}:00.000Z`);
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
  startTrial(a.id, at('10:02')); startTrial(a.id, at('10:03'));
  startTrial(b.id, at('10:01'));
  const order = createPaymentOrder(a.id, {}, at('10:04'));
  const signature = createHash('md5').update(`${order.priceRub.toFixed(2)}:${order.invId}:funnel-pass2`).digest('hex');
  const params = { OutSum: order.priceRub.toFixed(2), InvId: order.invId, SignatureValue: signature };
  processRobokassaResult(params, at('10:05')); processRobokassaResult(params, at('10:06'));
  assert.equal(db.prepare('SELECT is_test FROM payment_orders WHERE id=?').get(order.id).is_test, 0);
  const report = funnelReport('chain');
  assert.deepEqual(report.ordered, { starts: 2, firstRecipe: 1, trial: 1, paid: 1 });
  assert.deepEqual(report.totals, { starts: 2, firstRecipe: 1, trial: 2, paid: 1 });
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
  assert.match(formatFunnel(funnelReport()), /Показы рекламы: нет данных/);
  assert.equal(funnelCommand('1', '/adlink denied'), 'Отчёт доступен только владельцу бота.');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM acquisition_campaigns WHERE slug=?').get('denied').n, 0);
  assert.match(funnelCommand('6971956699', '/adlink channel_1 Канал & тест'), /https:\/\/funnel.example.test\/go\/channel_1/);
  assert.match(funnelCommand('6971956699', '/adstats channel_1 0'), /Показы рекламы: 0/);
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

test('owner report is protected over signed HTTP auth; redirect counts only GET; chat responds only to requester', async () => {
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const original = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith('https://api.telegram.org/')) { calls.push(JSON.parse(options.body)); return new Response(JSON.stringify({ ok: true, result: { message_id: 42 } })); }
    return original(url, options);
  };
  try {
    assert.equal((await fetch(`${base}/api/admin/funnel`)).status, 401);
    const { sender, user } = fixture(); allowUser(user.id);
    const header = account => ({ authorization: `tma ${makeTelegramInitData(account, process.env.TELEGRAM_BOT_TOKEN)}` });
    assert.equal((await fetch(`${base}/api/admin/funnel`, { headers: header(sender) })).status, 403);
    const owner = { id: 6971956699, first_name: 'Владелец' };
    assert.equal((await fetch(`${base}/api/admin/funnel`, { headers: header(owner) })).status, 200);
    const before = funnelReport('redirect').clicks;
    assert.equal((await fetch(`${base}/go/redirect`, { method: 'HEAD', redirect: 'manual' })).status, 302);
    assert.equal(funnelReport('redirect').clicks, before);
    const redirect = await fetch(`${base}/go/redirect`, { redirect: 'manual', headers: { 'user-agent': 'Mozilla/5.0' } });
    assert.equal(redirect.status, 302); assert.match(redirect.headers.get('location'), /start=ad_/);
    assert.equal((await fetch(`${base}/go/does-not-exist`, { redirect: 'manual' })).status, 404);
    await handleMessage({ from: owner, chat: { id: owner.id, type: 'private' }, text: '/funnel chain' });
    assert.equal(calls.length, 1); assert.equal(calls[0].chat_id, owner.id); assert.match(calls[0].text, /Затем оплатили: 1/);
    await handleMessage({ from: sender, chat: { id: sender.id, type: 'private' }, text: '/funnel' });
    assert.equal(calls.length, 2); assert.match(calls[1].text, /только владельцу/);
  } finally { globalThis.fetch = original; await new Promise(resolve => server.close(resolve)); }
});
