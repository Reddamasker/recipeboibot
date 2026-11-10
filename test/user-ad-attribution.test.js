import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'user-ad-attribution-'));
Object.assign(process.env, { BOT_PLATFORM: 'max', MAX_BOT_TOKEN: 'ad-entry-fixture', TELEGRAM_POLLING: 'false',
  TEST_CONTOUR: 'false', DATABASE_PATH: path.join(directory, 'test.sqlite'), APP_URL: 'https://recipes.example.test',
  OPENAI_API_KEY: 'never-used', DINNER_LLM_ENABLED: 'false', DINNER_IMAGES_ENABLED: 'false' });
const { db, resolvePrivateTelegramUser } = await import('../src/db.js');
const { createServer } = await import('../src/server.js');
const { recordBotStart } = await import('../src/funnel.js');
const { attributionForUser } = await import('../src/user-ad-attribution.js');
let server, base;
const token = () => randomBytes(18).toString('base64url');
const campaign = 'ya-product-landing-202611';
const account = id => db.prepare('SELECT * FROM users WHERE telegram_id=?').get(`max:${id}`);
function headers(id, payload, valid = true) {
  const params = new URLSearchParams({ user: JSON.stringify({ id, first_name: 'Fixture' }), auth_date: String(Math.floor(Date.now() / 1000)) });
  if (payload != null) params.set('start_param', payload);
  const check = [...params].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(valid ? process.env.MAX_BOT_TOKEN : 'wrong').digest();
  params.set('hash', createHmac('sha256', secret).update(check).digest('hex'));
  return { authorization: `mxa ${params}` };
}
test.before(async () => { server = createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(async () => { await new Promise(r => server.close(r)); db.close(); fs.rmSync(directory, { recursive: true, force: true }); });

test('signed MAX app-only entry binds source without creating chat starts; repeats and new source do not replace it', async () => {
  const firstToken = token(), payload = `lc_${campaign}_${firstToken}`;
  assert.equal((await fetch(base + '/api/me', { headers: headers(98001, payload) })).status, 200);
  const user = account(98001), first = attributionForUser(user.id);
  assert.equal(first.click_token, firstToken); assert.equal(first.campaign, campaign); assert.equal(first.entry_kind, 'app_entry');
  assert.equal(user.is_allowed, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM acquisition_starts WHERE user_id=?').get(user.id).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM acquisition_clicks WHERE token=?').get(firstToken).n, 0);
  for (const value of [payload, `lc_ya-product-rsya-202611_${token()}`]) await fetch(base + '/api/me', { headers: headers(98001, value) });
  assert.deepEqual(attributionForUser(user.id), first);
  recordBotStart(user, `/start ${payload}`);
  const start = db.prepare('SELECT * FROM acquisition_starts WHERE user_id=?').get(user.id);
  assert.equal(start.is_returning, 0); assert.equal(start.click_token, firstToken);
  assert.deepEqual(attributionForUser(user.id), first);
});

test('unsigned URL values, invalid signatures and unknown campaigns cannot establish attribution', async () => {
  const payload = `lc_${campaign}_${token()}`;
  assert.equal((await fetch(base + '/api/me?start_param=' + payload, { headers: headers(98002, null) })).status, 200);
  assert.equal(attributionForUser(account(98002).id), null);
  assert.equal((await fetch(base + '/api/me', { headers: headers(98003, payload, false) })).status, 401);
  assert.equal(account(98003), undefined);
  assert.equal((await fetch(base + '/api/me', { headers: headers(98004, `lc_unregistered_${token()}`) })).status, 200);
  assert.equal(attributionForUser(account(98004).id), null);
});

test('organic first chat acquisition and older known sources stay immutable', async () => {
  const organic = resolvePrivateTelegramUser({ id: 'max:98005', first_name: 'Organic' });
  recordBotStart(organic, '/start collection');
  await fetch(base + '/api/me', { headers: headers(98005, `lc_${campaign}_${token()}`) });
  assert.equal(attributionForUser(organic.id), null);
  const known = resolvePrivateTelegramUser({ id: 'max:98006', first_name: 'Known' }), knownToken = token();
  recordBotStart(known, `/start lc_${campaign}_${knownToken}`);
  const initial = attributionForUser(known.id);
  await fetch(base + '/api/me', { headers: headers(98006, `lc_ya-product-rsya-202611_${token()}`) });
  assert.deepEqual(attributionForUser(known.id), initial);
  assert.equal(initial.entry_kind, 'chat_start');
});

test('token copied to another account never replaces either first association and is not a new advertising click', async () => {
  const shared = token(), payload = `lc_${campaign}_${shared}`;
  for (const id of [98007, 98008]) await fetch(base + '/api/me', { headers: headers(id, payload) });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM user_ad_attributions WHERE click_token=?').get(shared).n, 2);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM acquisition_clicks WHERE token=?').get(shared).n, 0);
});

test('unavailable attribution storage cannot break authenticated entry', async () => {
  db.exec("CREATE TRIGGER deny_ad_binding BEFORE INSERT ON user_ad_attributions BEGIN SELECT RAISE(FAIL,'fixture'); END");
  try { assert.equal((await fetch(base + '/api/me', { headers: headers(98009, `lc_${campaign}_${token()}`) })).status, 200); }
  finally { db.exec('DROP TRIGGER deny_ad_binding'); }
});

test('Telegram binds only existing click tokens and landing identity endpoint is bounded, same-origin and immutable', () => {
  const script = String.raw`
    import assert from 'node:assert/strict';
    import {db,upsertTelegramUser} from './src/db.js';
    import {createCampaign,advertisingRedirect,recordBotStart} from './src/funnel.js';
    import {bindAppAdvertising,attributionForUser} from './src/user-ad-attribution.js';
    import {recordLandingView} from './src/landing-funnel.js';
    import {createServer} from './src/server.js';
    createCampaign('ya-product-landing-202611');
    const u=upsertTelegramUser({id:98100}), payload=new URL(advertisingRedirect('ya-product-landing-202611')).searchParams.get('start');
    assert.equal(bindAppAdvertising(u,'ad_'+'x'.repeat(24)),null);
    assert.equal(bindAppAdvertising(u,payload).click_token,payload.slice(3));
    assert.equal(db.prepare('SELECT COUNT(*) n FROM acquisition_starts WHERE user_id=?').get(u.id).n,0);
    recordBotStart(u,'/start '+payload); assert.equal(attributionForUser(u.id).entry_kind,'app_entry');
    const id='a'.repeat(32); recordLandingView({visitId:id,query:'campaign=ya-product-landing-202611'});
    const server=createServer(); await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
    const post=(body,origin)=>fetch(base+'/api/landing/identity',{method:'POST',headers:{'content-type':'application/json','x-landing-request':'1',...(origin?{origin}:{})},body:JSON.stringify(body)});
    try {
      assert.equal((await post({visitId:id,clientId:'123456'},'https://evil.example')).status,403);
      assert.equal((await post({visitId:id,clientId:123456})).status,400);
      assert.equal((await post({visitId:id,clientId:'123456'})).status,200);
      assert.equal((await post({visitId:id,clientId:'123456'})).status,200);
      assert.equal((await post({visitId:id,clientId:'999999'})).status,409);
      assert.equal(db.prepare('SELECT metrika_client_id FROM landing_visits WHERE id=?').get(id).metrika_client_id,'123456');
      assert.equal((await post({visitId:'b'.repeat(32),clientId:'123456'})).status,404);
      assert.equal((await fetch(base+'/api/landing/identity')).status,405);
    } finally {await new Promise(r=>server.close(r)); db.close();}
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-'], { input: script, encoding: 'utf8', timeout: 20000,
    env: { ...process.env, BOT_PLATFORM: 'telegram', TELEGRAM_BOT_TOKEN: 'tg-attribution-fixture', DATABASE_PATH: path.join(directory, 'telegram.sqlite') } });
  assert.equal(child.status, 0, child.stderr + child.stdout);
});
