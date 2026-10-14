import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'web-login-prototype-'));
const owner = '987654321', chat = 'prototype-private-chat', botId = '123456789';
const origin = 'http://127.0.0.1:19713';
const webhookSecret = 'prototype-test-webhook-secret-123456789';
Object.assign(process.env, {
  DATABASE_PATH: path.join(directory, 'recipes.sqlite'), BOT_PLATFORM: 'max',
  MAX_BOT_TOKEN: 'prototype-test-token', MAX_BOT_USERNAME: 'prototype_test_bot',
  MAX_WEBHOOK_SECRET: webhookSecret, TELEGRAM_POLLING: 'false',
  DINNER_LLM_ENABLED: 'false', DINNER_IMAGES_ENABLED: 'false', OPENAI_API_KEY: 'unused',
  WEB_LOGIN_PROTOTYPE_ENABLED: 'true', WEB_LOGIN_OWNER_MAX_ID: owner,
  WEB_LOGIN_ORIGIN: origin, NODE_ENV: 'test', TRUST_PROXY: 'false',
});
const { createServer } = await import('../src/server.js');
const { db } = await import('../src/db.js');
const { maxStore } = await import('../src/max-store.js');
const { normalizeMaxUpdate } = await import('../src/max-events.js');
const { prototypeSettings, webLoginStore, handleWebLoginUpdate, sanitizeWebLoginEvent } = await import('../src/web-login-prototype.js');
test('phone preview has inline styling, no scripts or live authentication actions',async()=>{
  const {webLoginPreviewDocument}=await import('../src/web-login-prototype.js');
  const html=webLoginPreviewDocument();
  assert.match(html,/<style>/);assert.doesNotMatch(html,/<script|<link rel="stylesheet"/);
  assert.match(html,/Подтверждение через MAX ещё не подключено/);
  assert.match(html,/<button[^>]*id="login-start"[^>]*disabled>Вход пока не подключён<\/button>/);
});
let server, port;
test.before(async () => {
  server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});
test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  db.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

function request(route, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method,
      headers: { host: new URL(origin).host, ...headers } }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => {
        let json;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: response.statusCode, headers: response.headers, text, json });
      });
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
const post = (route, { cookie, headers = {}, body = {} } = {}) => request(route, {
  method: 'POST', body,
  headers: { origin, 'x-web-login': '1', 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers },
});
const api = '/api/web-login/prototype';
const cookiePart = (response, name) => response.headers['set-cookie']?.find(value => value.startsWith(name + '='))?.split(';')[0];
const tokenPart = cookie => cookie.slice(cookie.indexOf('=') + 1);
const started = (token, actor = owner) => ({ update_type: 'bot_started', timestamp: 123456,
  user: { user_id: actor, first_name: 'Owner', is_bot: false }, chat_id: chat, payload: 'wl_' + token });
function callback(payload, mid, actor = owner) {
  return { update_type: 'message_callback', callback: { callback_id: 'callback-' + payload + '-' + mid,
    user: { user_id: actor, is_bot: false }, payload }, message: {
    sender: { user_id: botId, is_bot: true }, recipient: { chat_id: chat, chat_type: 'dialog' }, body: { mid },
  } };
}

test('prototype configuration fails closed and never inherits another owner', () => {
  assert.equal(prototypeSettings({ webLoginPrototypeEnabled: false }), null);
  const valid = { webLoginPrototypeEnabled: true, botPlatform: 'max', webLoginOwnerId: owner,
    maxBotUsername: 'prototype_test_bot', webLoginOrigin: origin, production: false };
  assert.equal(prototypeSettings(valid).ownerId, owner);
  assert.equal(prototypeSettings({ ...valid, webLoginOrigin: 'https://login.example.test', production: true }).secure, true);
  for (const change of [ { webLoginOwnerId: '' }, { botPlatform: 'telegram' },
    { production: true }, { webLoginOrigin: 'http://example.test' },
    { webLoginOrigin: origin + '/' }, { webLoginOrigin: 'https://user:pass@example.test' } ]) {
    assert.throws(() => prototypeSettings({ ...valid, ...change }));
  }
});

test('HTTP mutations require the configured Host, Origin, header and JSON', async () => {
  const route = api + '/start';
  assert.equal((await post(route, { headers: { host: 'attacker.example' } })).status, 403);
  for (const headers of [ { origin: '' }, { origin: 'null' }, { origin: origin + '.attacker.example' },
    { origin: 'https://127.0.0.1:19713' }, { 'x-web-login': '' }, { 'content-type': 'text/plain' } ]) {
    assert.equal((await post(route, { headers })).status, 403);
  }
  assert.equal((await request(route)).status, 405);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM web_login_prototype_requests').get().count, 0);
  const result = await request(api + '/me');
  assert.deepEqual(result.json, { authenticated: false });
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.equal(result.headers['referrer-policy'], 'no-referrer');
  assert.equal(result.headers['x-frame-options'], 'DENY');
  assert.match(result.headers['content-security-policy'], /frame-ancestors 'none'/);
});

test('MAX proof remains bound to the initiating browser, owner and exact message; session is isolated', async () => {
  const start = await post(api + '/start');
  assert.equal(start.status, 200);
  const pendingCookie = cookiePart(start, 'recipe_login_pending');
  assert.ok(pendingCookie);
  assert.match(start.headers['set-cookie'][0], /HttpOnly; SameSite=Strict/);
  assert.doesNotMatch(start.headers['set-cookie'][0], /Domain=/);
  const browser = tokenPart(pendingCookie);
  const botToken = new URL(start.json.botUrl).searchParams.get('start').slice(3);
  assert.equal((await post(api + '/finish', { cookie: pendingCookie })).status, 409);
  assert.equal((await request(api + '/status', { headers: { cookie: 'recipe_login_pending=wrong' } })).json.state, 'none');

  const forged = sanitizeWebLoginEvent({ ...started('wrong'), _webLoginRequest: 'forged-request-id' });
  assert.equal(forged._webLoginRequest, 'invalid');
  assert.equal(sanitizeWebLoginEvent({ update_type: 'bot_started', _webLoginRequest: 'forged' })._webLoginRequest, undefined);
  const foreign = sanitizeWebLoginEvent(started(botToken, '987654322'));
  assert.equal(foreign._webLoginRequest, 'invalid');
  assert.equal(webLoginStore.state(browser).state, 'pending');
  const pasted = sanitizeWebLoginEvent({ update_type: 'message_created', message: { body: { text: '/start wl_' + botToken } } });
  assert.equal(pasted.message.body.text, '/start wl_redacted');

  const webhook = await request('/api/max/webhook', { method: 'POST', body: started(botToken),
    headers: { 'content-type': 'application/json', 'x-max-bot-api-secret': webhookSecret } });
  assert.equal(webhook.status, 200);
  const queued = db.prepare('SELECT event_json FROM max_inbox').all();
  assert.equal(queued.length, 1);
  assert.ok(!JSON.stringify(queued).includes(botToken));
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM web_login_prototype_requests').all()).includes(browser));
  const event = JSON.parse(queued[0].event_json);
  assert.equal(event.payload, 'wl_redacted');
  assert.match(event._webLoginRequest, /^[a-f0-9-]{36}$/);
  const calls = [];
  const call = async (method, body) => {
    calls.push({ method, body });
    if (method === 'sendMessage') {
      maxStore.rememberMessage('confirmation-message', owner, chat);
      return { message_id: 'confirmation-message' };
    }
    return {};
  };
  assert.equal(await handleWebLoginUpdate(normalizeMaxUpdate(event, { botId }), call), true);
  assert.equal(calls[0].method, 'sendMessage');
  assert.ok(calls[0].body.text.includes(start.json.code));
  assert.ok(!JSON.stringify(calls).includes(botToken));
  const approve = calls[0].body.reply_markup.inline_keyboard[0][0].callback_data;
  assert.equal(webLoginStore.state(browser).state, 'offered');
  const duplicate = await request('/api/max/webhook', { method: 'POST', body: started(botToken),
    headers: { 'content-type': 'application/json', 'x-max-bot-api-secret': webhookSecret } });
  assert.equal(duplicate.status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM max_inbox').get().count, 1);
  assert.equal(normalizeMaxUpdate(callback(approve, 'confirmation-message', '987654322'), { botId }), null);
  assert.equal(normalizeMaxUpdate(callback(approve, 'unowned-message'), { botId }), null);
  maxStore.rememberMessage('different-owned-message', owner, chat);
  await handleWebLoginUpdate(normalizeMaxUpdate(callback(approve, 'different-owned-message'), { botId }), call);
  assert.equal(webLoginStore.state(browser).state, 'offered');
  const confirmation = normalizeMaxUpdate(callback(approve, 'confirmation-message'), { botId });
  await handleWebLoginUpdate(confirmation, call);
  assert.equal(webLoginStore.state(browser).state, 'approved');
  await handleWebLoginUpdate(confirmation, call);
  assert.equal(webLoginStore.state(browser).state, 'approved');
  assert.equal((await post(api + '/finish')).status, 409);
  const finish = await post(api + '/finish', { cookie: pendingCookie });
  assert.equal(finish.status, 200);
  const sessionCookie = cookiePart(finish, 'recipe_login_session');
  assert.ok(sessionCookie);
  assert.notEqual(tokenPart(sessionCookie), browser);
  assert.ok(finish.headers['set-cookie'].some(value => value.startsWith('recipe_login_pending=;') && value.includes('Max-Age=0')));
  assert.equal((await post(api + '/finish', { cookie: pendingCookie })).status, 409);
  assert.equal((await request(api + '/me', { headers: { cookie: sessionCookie } })).json.scope, 'prototype-only');
  for (const route of ['/api/me', '/api/library', '/api/billing/offer', '/api/dashboard/web-login-prototype']) {
    assert.equal((await request(route, { headers: { cookie: sessionCookie } })).status, 401, route);
  }
  assert.equal(db.prepare('SELECT COUNT(*) count FROM web_login_prototype_sessions').get().count, 1);
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM web_login_prototype_sessions').all()).includes(tokenPart(sessionCookie)));
  assert.equal((await post(api + '/logout', { cookie: sessionCookie })).status, 200);
  assert.deepEqual((await request(api + '/me', { headers: { cookie: sessionCookie } })).json, { authenticated: false });
});

test('denying a request is terminal even when an old approve callback arrives', async () => {
  const flow = webLoginStore.begin();
  const event = sanitizeWebLoginEvent(started(flow.bot));
  let payloads;
  const call = async (method, body) => {
    if (method === 'sendMessage') {
      payloads = body.reply_markup.inline_keyboard.map(row => row[0].callback_data);
      maxStore.rememberMessage('denial-message', owner, chat);
      return { message_id: 'denial-message' };
    }
    return {};
  };
  await handleWebLoginUpdate(normalizeMaxUpdate(event, { botId }), call);
  await handleWebLoginUpdate(normalizeMaxUpdate(callback(payloads[1], 'denial-message'), { botId }), call);
  await handleWebLoginUpdate(normalizeMaxUpdate(callback(payloads[0], 'denial-message'), { botId }), call);
  assert.equal(webLoginStore.state(flow.browser).state, 'denied');
  assert.throws(() => webLoginStore.finish(flow.browser));
});
