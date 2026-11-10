import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'max-app-entry-'));
Object.assign(process.env, {
  BOT_PLATFORM: 'max', MAX_BOT_TOKEN: 'app-entry-fixture', MAX_BOT_USERNAME: 'recipe_test_bot',
  MAX_WEBHOOK_SECRET: 's'.repeat(64), TELEGRAM_POLLING: 'false', TEST_CONTOUR: 'false',
  DATABASE_PATH: path.join(directory, 'test.sqlite'), APP_URL: 'https://recipes.example.test',
  OPENAI_API_KEY: 'never-used', DINNER_LLM_ENABLED: 'false', DINNER_IMAGES_ENABLED: 'false'
});
const { db, resolvePrivateTelegramUser, createRecipe } = await import('../src/db.js');
const { createServer } = await import('../src/server.js');
const { normalizeMaxUpdate } = await import('../src/max-events.js');
const { handleChatUpdate } = await import('../src/telegram.js');
let server, base, chatRequests = [], permitChat = false;
const originalFetch = global.fetch;

test.before(async () => {
  server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  global.fetch = async (url, options) => {
    const target = new URL(url);
    if (target.origin === base) return originalFetch(url, options);
    assert.equal(permitChat, true, 'app entry must not make an external request');
    assert.equal(target.hostname, 'platform-api2.max.ru');
    assert.equal(target.pathname, '/messages');
    assert.equal(options.method, 'POST');
    chatRequests.push(JSON.parse(options.body));
    return Response.json({ message: { recipient: { chat_id: 97004, chat_type: 'dialog' }, body: { mid: `entry-message-${chatRequests.length}` } } });
  };
});
test.after(async () => {
  global.fetch = originalFetch;
  await new Promise(resolve => server.close(resolve));
  db.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(path.join(directory, 'test.sqlite') + suffix, { force: true });
  fs.rmdirSync(directory);
});
function authorization(id, { token = process.env.MAX_BOT_TOKEN, scheme = 'mxa', ageSeconds = 0, bot = false } = {}) {
  const params = new URLSearchParams({ user: JSON.stringify({ id, first_name: 'Entry fixture', is_bot: bot }), auth_date: String(Math.floor(Date.now() / 1000) - ageSeconds) });
  const check = [...params].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  params.set('hash', createHmac('sha256', secret).update(check).digest('hex'));
  return { authorization: `${scheme} ${params}` };
}
const user = id => db.prepare('SELECT * FROM users WHERE telegram_id=?').get(`max:${id}`);
const get = (route, id, options) => fetch(base + route, { headers: authorization(id, options) });
const post = (route, id, body) => fetch(base + route, { method: 'POST', headers: { ...authorization(id), 'content-type': 'application/json' }, body: JSON.stringify(body) });
function assertAppOnly(id) {
  const account = user(id);
  assert.equal(account.is_allowed, 0, 'app authentication must not synthesize a chat start');
  for (const table of ['acquisition_starts', 'user_trials', 'user_subscriptions', 'pending_intents']) {
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE user_id=?`).get(account.id).n, 0, table);
  }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM max_chat_bindings WHERE user_id=?').get(String(id)).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM provider_requests WHERE user_id=?').get(account.id).n, 0);
}

test('fresh MAX user enters collection and workspace without a chat start or entitlement', async () => {
  assert.equal(user(97001), undefined);
  const response = await get('/api/me', 97001);
  assert.equal(response.status, 200);
  const me = await response.json();
  assert.equal(me.id, user(97001).id);
  assert.equal(me.chatStarted, false);
  assert.equal(me.platform, 'max');
  const library = await get('/api/library', 97001);
  assert.equal(library.status, 200);
  assert.deepEqual(await library.json(), { recipes: [], jobs: [] });
  const workspace = await get('/api/workspace', 97001);
  assert.equal(workspace.status, 200);
  assert.deepEqual((await workspace.json()).collections, []);
  assert.equal((await get('/api/billing/offer', 97001)).status, 200);
  assertAppOnly(97001);
  const boots = db.prepare("SELECT detail_json,duration_ms FROM product_events WHERE user_id=? AND event='operation_finished' AND step='boot'").all(me.id);
  assert.ok(boots.some(row => JSON.parse(row.detail_json).status === 200 && row.duration_ms >= 0));
});

test('existing account previously denied before Start recovers without resetting data', async () => {
  const account = resolvePrivateTelegramUser({ id: 'max:97002', first_name: 'Previously denied' });
  const recipe = createRecipe(account.id, { title: 'Existing private recipe', status: 'ready', ingredients: [], steps: [] });
  const creation = account.created_at;
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await get('/api/me', 97002);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).chatStarted, false);
    assert.equal(user(97002).id, account.id);
    assert.equal(user(97002).created_at, creation);
  }
  const library = await (await get('/api/library', 97002)).json();
  assert.equal(library.recipes.length, 1);
  assert.equal(library.recipes[0].id, recipe.id);
  assertAppOnly(97002);
});

test('app-first users can save catalog recipes idempotently while private collections remain isolated', async () => {
  await get('/api/me', 97003);
  const command = { operationId: randomUUID(), expectedVersion: 0, action: 'collections.saveCatalog', catalogId: 'pasta-tomato' };
  const saved = await post('/api/workspace', 97003, command);
  assert.equal(saved.status, 200);
  const repeat = await post('/api/workspace', 97003, command);
  assert.equal(repeat.status, 200);
  assert.equal((await repeat.json()).operation.replayed, true);
  const library = await (await get('/api/library', 97003)).json();
  assert.equal(library.recipes.length, 1);
  const foreignLibrary = await (await get('/api/library', 97001)).json();
  assert.equal(foreignLibrary.recipes.length, 0);
  const foreign = await post('/api/workspace', 97001, { operationId: randomUUID(), expectedVersion: 0, action: 'collections.create', name: 'Foreign', recipeIds: [library.recipes[0].id] });
  assert.equal(foreign.status, 404);
  assertAppOnly(97003);
});

test('app-first entry does not bypass expired first-recipe access or invoke AI', async () => {
  await get('/api/me', 97005);
  const account = user(97005);
  db.prepare('INSERT INTO first_recipe_results(user_id,request_key,owner,started_at,result_json) VALUES(?,?,?,?,?)').run(account.id, 'used-first', 'fixture', new Date().toISOString(), '{}');
  const response = await post('/api/import', 97005, { kind: 'text', value: 'A recipe needing interpretation' });
  assert.equal(response.status, 402);
  assertAppOnly(97005);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM import_jobs WHERE user_id=?').get(account.id).n, 0);
});

test('forged, expired, cross-platform and bot identities never create app accounts', async () => {
  const cases = [{ token: 'wrong-secret' }, { ageSeconds: 7200 }, { scheme: 'tma' }, { bot: true }];
  for (const [index, options] of cases.entries()) {
    const id = 97100 + index;
    assert.equal((await get('/api/me', id, options)).status, 401);
    assert.equal(user(id), undefined);
  }
});

test('Telegram still requires a real chat start after validating its own signature', () => {
  const databasePath = path.join(directory, 'telegram.sqlite');
  const script = `
    import assert from 'node:assert/strict';
    import { createHmac } from 'node:crypto';
    const { db, allowUser } = await import('./src/db.js');
    const { createServer } = await import('./src/server.js');
    const server = createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const params = new URLSearchParams({user:JSON.stringify({id:97200,first_name:'Fixture'}),auth_date:String(Math.floor(Date.now()/1000))});
    const check = [...params].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>k+'='+v).join('\\n');
    const secret = createHmac('sha256','WebAppData').update(process.env.TELEGRAM_BOT_TOKEN).digest();
    params.set('hash',createHmac('sha256',secret).update(check).digest('hex'));
    const request = () => fetch('http://127.0.0.1:'+server.address().port+'/api/me',{headers:{authorization:'tma '+params}});
    try {
      assert.equal((await request()).status,403);
      const user = db.prepare('SELECT * FROM users WHERE telegram_id=?').get('97200');
      assert.equal(user.is_allowed,0);
      allowUser(user.id);
      assert.equal((await request()).status,200);
    } finally {await new Promise(resolve=>server.close(resolve)); db.close();}
  `;
  try {
    const child = spawnSync(process.execPath, ['--input-type=module', '-'], {
      input: script, encoding: 'utf8', timeout: 20000,
      env: { ...process.env, BOT_PLATFORM: 'telegram', TELEGRAM_BOT_TOKEN: 'telegram-entry-fixture', DATABASE_PATH: databasePath }
    });
    assert.equal(child.status, 0, child.stderr + child.stdout);
  } finally {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(databasePath + suffix, { force: true });
  }
});

test('actual later Start remains a first chat start and duplicate deliveries preserve attribution', async () => {
  await get('/api/me', 97004);
  assertAppOnly(97004);
  const id = user(97004).id;
  permitChat = true;
  try {
    const event = { update_type: 'bot_started', timestamp: Date.now(), chat_id: 97004, user: { user_id: 97004, first_name: 'Entry fixture' }, payload: 'collection' };
    await handleChatUpdate(normalizeMaxUpdate(event));
    const first = db.prepare('SELECT * FROM acquisition_starts WHERE user_id=?').get(id);
    assert.equal(first.is_returning, 0);
    assert.equal(user(97004).is_allowed, 1);
    assert.equal((await (await get('/api/me', 97004)).json()).chatStarted, true);
    await handleChatUpdate(normalizeMaxUpdate({ ...event, timestamp: event.timestamp + 1 }));
    assert.deepEqual(db.prepare('SELECT * FROM acquisition_starts WHERE user_id=?').get(id), first);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM acquisition_starts WHERE user_id=?').get(id).n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM user_trials WHERE user_id=?').get(id).n, 0);
    assert.ok(chatRequests.length >= 1);
  } finally { permitChat = false; }
});
