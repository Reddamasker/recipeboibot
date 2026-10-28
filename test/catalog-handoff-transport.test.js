import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID, randomBytes, generateKeyPairSync, sign } from 'node:crypto';

const database = `data/catalog-handoff-transport-${randomUUID()}.sqlite`;
Object.assign(process.env, { DATABASE_PATH: database, TELEGRAM_BOT_TOKEN: 'handoff-transport-test', TELEGRAM_POLLING: 'false',
  TEST_CONTOUR: 'false', BOT_PLATFORM: 'telegram', DINNER_LLM_ENABLED: 'false', DINNER_IMAGES_ENABLED: 'false', OPENAI_API_KEY: 'disabled' });
const { db, upsertTelegramUser } = await import('../src/db.js');
const { createServer } = await import('../src/server.js');
const { createCampaign } = await import('../src/funnel.js');
const { catalogSearch } = await import('../src/web-catalog.js');
const {
  handoffOrigins, createCatalogHandoff, registerCatalogAcquisitionVisit, catalogHandoffPublicKey, signedCatalogEnvelope,
  verifyCatalogEnvelope, resolveCatalogHandoff, catalogHandoffResolveForTarget, recordCatalogBotStart,
  queueCatalogHandoffOutcome, flushCatalogHandoffOutcomes, acceptCatalogHandoffOutcome, stopCatalogHandoffScheduler,
} = await import('../src/catalog-handoff-transport.js');
const recipeId = catalogSearch().recipes[0].id;
const server = createServer(); let baseUrl;
test.before(async () => { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); baseUrl = `http://127.0.0.1:${server.address().port}`; });
test.after(async () => { stopCatalogHandoffScheduler(); await new Promise(resolve => server.close(resolve)); db.close(); for (const suffix of ['', '-wal', '-shm']) fs.rmSync(database + suffix, { force: true }); });
const input = (extra = {}) => ({ recipeId, flowId: randomUUID(), sessionId: randomUUID(), platform: 'telegram', ...extra });
const tokenOf = result => new URL(result.url).searchParams.get('start');
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const post = (path, body, headers = {}) => fetch(baseUrl + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('public endpoint requires same-origin intent and validates content without permitting arbitrary destinations', async () => {
  const request = input();
  assert.equal((await fetch(baseUrl + '/api/catalog-handoff')).status, 405);
  assert.equal((await post('/api/catalog-handoff', request)).status, 403);
  assert.equal((await post('/api/catalog-handoff', request, { 'x-catalog-request': '1', origin: 'https://unrelated.example' })).status, 403);
  for (const invalid of [{ ...request, platform: 'https://unrelated.example' }, { ...request, recipeId: '../private' }, { ...request, flowId: 'short' }]) {
    assert.equal((await post('/api/catalog-handoff', invalid, { 'x-catalog-request': '1' })).status, 400);
  }
  const response = await post('/api/catalog-handoff', request, { 'x-catalog-request': '1', origin: baseUrl });
  assert.equal(response.status, 200); const result = await response.json();
  assert.equal(new URL(result.url).hostname, 't.me'); assert.match(tokenOf(result), /^ch_m_[A-Za-z0-9_-]{24}$/);
  const repeated = await (await post('/api/catalog-handoff', request, { 'x-catalog-request': '1' })).json();
  assert.equal(repeated.url, result.url);
  assert.equal((await post('/api/catalog-handoff', { ...request, sessionId: randomUUID() }, { 'x-catalog-request': '1' })).status, 409);
});

test('local tokens retain recipe context, enforce target and expiry, and replace expired links without reusing them', async () => {
  const request = input(), first = createCatalogHandoff(request), token = tokenOf(first);
  const resolved = await resolveCatalogHandoff(token, { transport: () => { throw new Error('local tokens must not fetch'); } });
  assert.equal(resolved.catalogId, recipeId); assert.equal(resolved.flowId, request.flowId); assert.equal(resolved.target, 'm');
  assert.throws(() => catalogHandoffResolveForTarget(token, 'x'), { status: 403 });
  db.prepare('UPDATE catalog_transfers SET expires_at=? WHERE token=?').run('2020-01-01T00:00:00.000Z', token);
  await assert.rejects(resolveCatalogHandoff(token), { status: 410 });
  assert.notEqual(tokenOf(createCatalogHandoff(request)), token);
  await assert.rejects(resolveCatalogHandoff('ch_z_' + randomBytes(18).toString('base64url'), { transport: () => { throw new Error('untrusted host'); } }), { status: 400 });
});

test('signatures authenticate bounded fresh envelopes and cannot be changed or replayed outside the time window', async () => {
  const data = { token: 'ch_m_' + randomBytes(18).toString('base64url') }, timestamp = Date.now();
  const envelope = signedCatalogEnvelope(data, timestamp);
  assert.deepEqual(await verifyCatalogEnvelope(envelope, { now: timestamp }), { source: 'm', data });
  assert.deepEqual(catalogHandoffPublicKey(), catalogHandoffPublicKey());
  assert.ok(!JSON.stringify(catalogHandoffPublicKey()).includes('PRIVATE KEY'));
  await assert.rejects(verifyCatalogEnvelope({ ...envelope, data: { token: 'tampered' } }, { now: timestamp }), { status: 403 });
  await assert.rejects(verifyCatalogEnvelope(envelope, { now: timestamp + 300001 }), { status: 403 });
  await assert.rejects(verifyCatalogEnvelope({ ...envelope, source: 'https://unrelated.example' }, { now: timestamp }), { status: 403 });
  await assert.rejects(verifyCatalogEnvelope({ ...envelope, signature: 'bad' }, { now: timestamp }), { status: 403 });
  assert.equal((await post('/api/internal/catalog-handoff/resolve', { data })).status, 403);
});

test('remote key discovery and resolve use only fixed HTTPS origins and cached records need no network', async () => {
  const pair = generateKeyPairSync('ed25519'), source = 'x', timestamp = Date.now(), data = { type: 'test' };
  const message = { source, at: timestamp, data }, envelope = { ...message, signature: sign(null, Buffer.from(JSON.stringify(message)), pair.privateKey).toString('base64url') };
  let keyFetches = 0;
  const keyTransport = async (url, options) => {
    keyFetches++; assert.equal(url, handoffOrigins.x + '/api/internal/catalog-handoff/key'); assert.equal(options.redirect, 'error');
    return jsonResponse({ source, key: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url') });
  };
  assert.deepEqual(await verifyCatalogEnvelope(envelope, { transport: keyTransport, now: timestamp }), { source, data });
  await verifyCatalogEnvelope(envelope, { transport: keyTransport, now: timestamp }); assert.equal(keyFetches, 1);
  const payload = 'ch_x_' + randomBytes(18).toString('base64url');
  const remote = { payload, origin: 'x', target: 'm', catalogId: recipeId, flowId: randomUUID(), sessionId: randomUUID(), campaign: null, clickToken: null,
    createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString() };
  let calls = 0;
  const transport = async (url, options) => {
    calls++; assert.equal(url, handoffOrigins.x + '/api/internal/catalog-handoff/resolve'); assert.equal(options.redirect, 'error');
    const body = JSON.parse(options.body); assert.equal(body.source, 'm'); assert.equal(body.data.token, payload);
    assert.equal((await verifyCatalogEnvelope(body)).source, 'm'); return jsonResponse(remote);
  };
  assert.equal((await resolveCatalogHandoff(payload, { transport })).catalogId, recipeId);
  await resolveCatalogHandoff(payload, { transport }); assert.equal(calls, 1);
  const wrongPayload = 'ch_x_' + randomBytes(18).toString('base64url');
  await assert.rejects(resolveCatalogHandoff(wrongPayload, { transport: async () => jsonResponse({ ...remote, payload: wrongPayload, target: 't' }) }), { status: 502 });
  assert.equal(db.prepare('SELECT 1 FROM catalog_transfers WHERE token=?').get(wrongPayload), undefined);
});

test('durable outbox retries once per outcome, preserves original occurrence and contains no account identity', async () => {
  const r = { payload: 'ch_x_' + randomBytes(18).toString('base64url'), origin: 'x' };
  const user = upsertTelegramUser({ id: 87651234 });
  const outcome = { type: 'catalog_recipe_saved', userId: user.id, isReturning: false, durationMs: 250, code: null };
  queueCatalogHandoffOutcome(r, outcome, { flush: false }); queueCatalogHandoffOutcome(r, outcome, { flush: false });
  const before = db.prepare('SELECT * FROM catalog_transfer_outbox WHERE token=?').all(r.payload);
  assert.equal(before.length, 1); const original = JSON.parse(before[0].body);
  assert.ok(Number.isFinite(Date.parse(original.occurredAt))); assert.ok(!before[0].body.includes(user.id)); assert.ok(!before[0].body.includes('87651234'));
  await flushCatalogHandoffOutcomes({ transport: async () => jsonResponse({ error: 'unavailable' }, 503) });
  const failed = db.prepare('SELECT * FROM catalog_transfer_outbox WHERE token=?').get(r.payload);
  assert.equal(failed.attempts, 1); assert.equal(failed.delivered_at, null); assert.ok(failed.next_at > Date.now());
  db.prepare('UPDATE catalog_transfer_outbox SET next_at=0 WHERE token=?').run(r.payload);
  let calls = 0;
  await flushCatalogHandoffOutcomes({ transport: async (url, options) => {
    calls++; assert.equal(url, handoffOrigins.x + '/api/internal/catalog-handoff/outcome'); assert.equal(options.redirect, 'error');
    const envelope = JSON.parse(options.body); assert.deepEqual(envelope.data, original); assert.equal((await verifyCatalogEnvelope(envelope)).source, 'm');
    return jsonResponse({ ok: true });
  } });
  assert.equal(calls, 1); assert.ok(db.prepare('SELECT delivered_at FROM catalog_transfer_outbox WHERE token=?').get(r.payload).delivered_at);
  await flushCatalogHandoffOutcomes({ transport: async () => { throw new Error('already acknowledged'); } });
});

test('callback derives platform and context from stored token, checks target and preserves original time', () => {
  const request = input({ platform: 'max' }), token = tokenOf(createCatalogHandoff(request));
  const occurredAt = new Date().toISOString();
  const receipt = { token, type: 'catalog_bot_started', occurredAt, isReturning: false, isInternal: false, durationMs: 10, code: null, platform: 'telegram' };
  assert.throws(() => acceptCatalogHandoffOutcome(receipt, 't'), { status: 403 });
  assert.throws(() => acceptCatalogHandoffOutcome({ ...receipt, type: 'payment_confirmed' }, 'x'), { status: 400 });
  assert.throws(() => acceptCatalogHandoffOutcome({ ...receipt, occurredAt: new Date(Date.now() + 3600000).toISOString() }, 'x'), { status: 400 });
  assert.deepEqual(acceptCatalogHandoffOutcome(receipt, 'x'), { ok: true });
  assert.deepEqual(acceptCatalogHandoffOutcome(receipt, 'x'), { ok: true });
  const outcomes = db.prepare('SELECT * FROM catalog_journey_outcomes WHERE flow_id=?').all(request.flowId);
  assert.equal(outcomes.length, 1); assert.equal(outcomes[0].platform, 'max'); assert.equal(outcomes[0].created_at, occurredAt);
  acceptCatalogHandoffOutcome({ ...receipt, type: 'catalog_recipe_saved', isInternal: true }, 'x');
  assert.equal(db.prepare('SELECT internal FROM catalog_journey_visits WHERE flow_id=?').get(request.flowId).internal, 1);
});

test('late visible event upgrades a real visit once while preserving attribution and session ownership', async () => {
  createCampaign('handoff-late-view');
  const request = input({ campaign: 'handoff-late-view' }), token = tokenOf(createCatalogHandoff(request));
  assert.equal(db.prepare('SELECT click_token FROM catalog_transfers WHERE token=?').get(token).click_token, null);
  const event = { ...request, journey: 'recipe-first-v1', visible: true };
  registerCatalogAcquisitionVisit({ ...event, sessionId: randomUUID() });
  assert.equal(db.prepare('SELECT click_token FROM catalog_transfers WHERE token=?').get(token).click_token, null);
  const visit = registerCatalogAcquisitionVisit(event); registerCatalogAcquisitionVisit(event);
  assert.match(visit.click_token, /^[A-Za-z0-9_-]{24}$/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM acquisition_clicks WHERE campaign=?').get('handoff-late-view').n, 1);
  assert.equal(db.prepare('SELECT click_token FROM catalog_transfers WHERE token=?').get(token).click_token, visit.click_token);
  const user = upsertTelegramUser({ id: 87651235 }), context = await resolveCatalogHandoff(token);
  recordCatalogBotStart(user, context); recordCatalogBotStart(user, context);
  const attribution = db.prepare('SELECT * FROM acquisition_starts WHERE user_id=?').get(user.id);
  assert.equal(attribution.campaign, 'handoff-late-view'); assert.equal(attribution.click_token, visit.click_token);
});

test('acknowledged telemetry ID cannot register a substituted advertising flow on retry', async () => {
  createCampaign('handoff-telemetry-retry');
  const visitor = randomUUID(), flowId = randomUUID(), id = randomUUID();
  const event = { id, event: 'catalog_list', step: 'catalog', journey: 'recipe-first-v1', session: visitor, flowId, campaign: 'handoff-telemetry-retry' };
  const headers = { 'x-analytics-request': '1' };
  assert.equal((await post('/api/analytics/public', { visitor, events: [event] }, headers)).status, 200);
  const substituted = randomUUID();
  assert.equal((await post('/api/analytics/public', { visitor, events: [{ ...event, flowId: substituted }] }, headers)).status, 200);
  assert.equal(db.prepare('SELECT 1 FROM catalog_acquisition_visits WHERE flow_id=?').get(substituted), undefined);
  assert.equal(db.prepare('SELECT 1 FROM catalog_journey_visits WHERE flow_id=?').get(substituted), undefined);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM acquisition_clicks WHERE campaign=?').get('handoff-telemetry-retry').n, 1);
});
