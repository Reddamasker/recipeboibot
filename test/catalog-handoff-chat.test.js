import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-handoff-chat-'));
Object.assign(process.env, {
  DATABASE_PATH: path.join(directory, 'recipes.sqlite'), BOT_PLATFORM: 'telegram',
  TELEGRAM_BOT_TOKEN: '123456:catalog-chat-fixture', TELEGRAM_POLLING: 'false',
  TEST_CONTOUR: 'false', BILLING_REQUIRED: 'false', APP_URL: 'https://recipes.example.test',
  DINNER_LLM_ENABLED: 'false', DINNER_IMAGES_ENABLED: 'false', OPENAI_API_KEY: 'unused-test-key'
});
const { db, upsertTelegramUser, createRecipe, getUserById, listRecipes, getPendingIntent, setPendingIntent } = await import('../src/db.js');
const { getFoodProfile } = await import('../src/dinner-store.js');
const { getTrialStatus, requireDinnerEntry, stageFirstRecipe, getPendingFirstRecipe, assertFirstRecipeReadable } = await import('../src/subscriptions.js');
const { createCatalogHandoff } = await import('../src/catalog-handoff-transport.js');
const { handleMessage } = await import('../src/telegram.js');
const { createCampaign } = await import('../src/funnel.js');
let serial = 628320000;
function fresh() {
  const from = { id: serial++, first_name: 'Catalog chat fixture' };
  return { from, chat: { id: from.id, type: 'private' }, user: upsertTelegramUser(from) };
}
function handoff(recipeId = 'pasta-tomato', extra = {}) {
  const flowId = randomUUID();
  const transfer = createCatalogHandoff({ platform: 'telegram', flowId, sessionId: randomUUID(), recipeId, ...extra });
  return { flowId, payload: new URL(transfer.url).searchParams.get('start') };
}
const sendStart = (account, payload = '') => handleMessage({ from: account.from, chat: account.chat, message_id: 1, text: `/start${payload ? ' ' + payload : ''}` });
async function capture(run) {
  const previous = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, options) => {
    assert.equal(new URL(url).origin, 'https://api.telegram.org', 'No AI, real bot, or external handoff request is allowed');
    calls.push({ method: String(url).split('/').at(-1), ...JSON.parse(options.body) });
    return Response.json({ ok: true, result: { message_id: calls.length } });
  };
  try { await run(calls); } finally { globalThis.fetch = previous; }
}
const buttons = calls => calls.flatMap(call => call.reply_markup?.inline_keyboard?.flat() || []);
test.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });

test('a catalog start saves the exact recipe before offering optional onboarding and keeps campaign attribution', async () => {
  const account = fresh(), profile = getFoodProfile(account.user.id);
  createCampaign('catalog-chat-test', 'Catalog chat fixture');
  const route = handoff('pasta-tomato', { campaign: 'catalog-chat-test' });
  await capture(async calls => {
    await sendStart(account, route.payload);
    assert.equal(calls.length, 1);
    assert.match(calls[0].text, /Рецепт сохранён/);
    assert.ok(!/главных продукта|на скольких|Запишите голосовое/.test(calls[0].text));
    assert.ok(!/\p{Extended_Pictographic}/u.test(calls[0].text));
    const recipes = listRecipes(account.user.id);
    assert.equal(recipes.length, 1);
    const link = buttons(calls).find(button => button.text === 'Открыть рецепт').web_app.url;
    assert.equal(new URL(link).searchParams.get('recipe'), recipes[0].id);
    assert.equal(new URL(link).searchParams.get('view'), 'collection');
    assert.ok(buttons(calls).some(button => button.callback_data === 'trial:start'));
    assert.deepEqual(getFoodProfile(account.user.id), profile);
    assert.equal(getPendingIntent(account.user.id), null);
    assert.equal(getTrialStatus(account.user.id).used, false);
    assert.equal(getUserById(account.user.id).is_allowed, 1);
    assert.equal(db.prepare('SELECT campaign FROM acquisition_starts WHERE user_id=?').get(account.user.id).campaign, 'catalog-chat-test');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM catalog_journey_outcomes WHERE flow_id=?').get(route.flowId).n, 2);
    await sendStart(account, route.payload);
    await sendStart(account);
    assert.equal(listRecipes(account.user.id).length, 1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM catalog_journey_outcomes WHERE flow_id=?').get(route.flowId).n, 2);
    assert.equal(getPendingIntent(account.user.id), null);
    assert.ok(!calls.some(call => /главных продукта|Запишите голосовое/.test(call.text)));
  });
});

test('a catalog start bypasses a different pending trial recipe and retires its questionnaire without unlocking it', async () => {
  const account = fresh();
  requireDinnerEntry(account.user.id);
  const locked = createRecipe(account.user.id, { title: 'Other first recipe', status: 'ready', ingredients: [{ name: 'private' }], steps: [{ text: 'private' }] });
  stageFirstRecipe(account.user.id, { recipe: locked, recipeId: locked.id, source: 'request' });
  setPendingIntent(account.user.id, { kind: 'dinner-confirm', intake: { householdSize: 2 } });
  const before = getPendingFirstRecipe(account.user.id), route = handoff();
  await capture(async calls => {
    await sendStart(account, route.payload);
    const openedId = new URL(buttons(calls)[0].web_app.url).searchParams.get('recipe');
    assert.notEqual(openedId, locked.id);
    assert.doesNotThrow(() => assertFirstRecipeReadable(account.user.id, { recipeId: openedId }));
    assert.throws(() => assertFirstRecipeReadable(account.user.id, { recipeId: locked.id }), { status: 402 });
    assert.deepEqual(getPendingFirstRecipe(account.user.id), before);
    assert.equal(getPendingIntent(account.user.id), null);
    assert.equal(getTrialStatus(account.user.id).used, false);
    await handleMessage({ from: account.from, chat: account.chat, text: '/collection' });
    assert.match(calls.at(-1).text, /сохранённые рецепты/);
  });
});

test('an expired trial still saves a public recipe and is never offered another trial', async () => {
  const account = fresh(), route = handoff();
  db.prepare('INSERT INTO user_trials VALUES(?,?,?)').run(account.user.id, '2020-01-01T00:00:00Z', '2020-01-08T00:00:00Z');
  await capture(async calls => {
    await sendStart(account, route.payload);
    assert.equal(listRecipes(account.user.id).length, 1);
    assert.ok(!buttons(calls).some(button => button.callback_data === 'trial:start'));
    assert.equal(getTrialStatus(account.user.id).expiresAt, '2020-01-08T00:00:00Z');
  });
});

test('invalid and expired catalog links explain recovery and do not begin an unrelated questionnaire', async () => {
  for (const expired of [false, true]) {
    const account = fresh(), route = handoff();
    if (expired) db.prepare('UPDATE catalog_transfers SET expires_at=? WHERE token=?').run('2020-01-01T00:00:00Z', route.payload);
    await capture(async calls => {
      await sendStart(account, expired ? route.payload : 'ch_bad!payload');
      assert.equal(calls.length, 1);
      assert.match(calls[0].text, /ссылка на рецепт недоступна/);
      assert.equal(listRecipes(account.user.id).length, 0);
      assert.equal(getPendingIntent(account.user.id), null);
      assert.equal(getTrialStatus(account.user.id).used, false);
    });
  }
});

test('a failed acknowledgement keeps the saved recipe and retry does not duplicate the save event', async () => {
  const account = fresh(), route = handoff();
  const previous = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Fixture send failure'); };
  try { await assert.rejects(sendStart(account, route.payload), /Fixture send failure/); }
  finally { globalThis.fetch = previous; }
  assert.equal(listRecipes(account.user.id).length, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM catalog_journey_outcomes WHERE flow_id=? AND event='catalog_save_failed'").get(route.flowId).n, 0);
  await capture(async calls => {
    await sendStart(account, route.payload);
    assert.match(calls[0].text, /уже есть в вашей коллекции/);
  });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM catalog_journey_outcomes WHERE flow_id=? AND event='catalog_recipe_saved'").get(route.flowId).n, 1);
});

test('MAX carries the saved recipe id in its app button and skips repeated first-recipe questions', () => {
  const code = `
    import assert from 'node:assert/strict';
    const {db,upsertTelegramUser,listRecipes,getPendingIntent}=await import('./src/db.js');
    const {createCatalogHandoff}=await import('./src/catalog-handoff-transport.js');
    const {handleMessage,handleTrialCallback}=await import('./src/telegram.js');
    const {getTrialStatus}=await import('./src/subscriptions.js');
    const {initializeTrialDigest,digestMember}=await import('./src/trial-digest-store.js');
    const {maxStore}=await import('./src/max-store.js');
    const from={id:'max:628329991',first_name:'MAX catalog'},chat={id:from.id,type:'private'};
    const user=upsertTelegramUser(from);
    const route=createCatalogHandoff({platform:'max',flowId:'max_catalog_flow_001',sessionId:'max_catalog_session_001',recipeId:'pasta-tomato'});
    const payload=new URL(route.url).searchParams.get('start');
    const calls=[];let serial=0;
    globalThis.fetch=async(url,options)=>{
      assert.equal(new URL(url).origin,'https://platform-api2.max.ru');
      const body=JSON.parse(options.body);calls.push(body);
      return Response.json({message:{body:{mid:'mid.'+(++serial),text:body.text},recipient:{chat_id:900,chat_type:'dialog'}}});
    };
    await handleMessage({from,chat,text:'/start '+payload});
    const recipes=listRecipes(user.id);assert.equal(recipes.length,1);
    const open=calls.flatMap(c=>c.attachments||[]).flatMap(a=>a.payload?.buttons||[]).flat().find(b=>b.type==='open_app');
    assert.equal(JSON.parse(Buffer.from(open.payload,'base64url')).recipe,recipes[0].id);
    await handleMessage({from,chat,text:'/start'});
    assert.equal(getPendingIntent(user.id),null);assert.equal(getTrialStatus(user.id).used,false);
    assert.ok(!calls.some(c=>/главных продукта|Запишите голосовое/.test(c.text)));
    assert.equal(initializeTrialDigest(),null);
    maxStore.rememberCallback('catalog-max-trial',628329991);
    await handleTrialCallback({id:'catalog-max-trial',data:'trial:start',from,message:{chat,message_id:'mid.1'}});
    assert.equal(getTrialStatus(user.id).active,true);
    assert.equal(digestMember(user.id),null);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM trial_digest_members').get().n,0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM notification_schedules WHERE user_id=?').get(user.id).n,0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM trial_reminder_members').get().n,0);
    assert.ok(calls.some(c=>String(c.text).includes('Спасибо, что запустил пробный период!')));
    db.close();
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', env: { ...process.env, DATABASE_PATH: path.join(directory, 'max.sqlite'), BOT_PLATFORM: 'max', TELEGRAM_BOT_TOKEN: '', MAX_BOT_TOKEN: 'fixture-max-token', MAX_BOT_USERNAME: 'fixture_max_bot', MAX_WEBHOOK_SECRET: 'fixture-max-secret-'.repeat(3), TELEGRAM_POLLING: 'false' } });
  assert.equal(result.status, 0, result.stderr);
});
