import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'trial-welcome-chat-'));
process.env.DATABASE_PATH = path.join(directory, 'recipes.sqlite');
process.env.BOT_PLATFORM = 'telegram';
process.env.TELEGRAM_BOT_TOKEN = 'fixture-welcome-token';
process.env.TELEGRAM_POLLING = 'false';
process.env.APP_URL = 'https://recipes.example';
process.env.TEST_CONTOUR = 'false';
process.env.BILLING_REQUIRED = 'false';
process.env.DINNER_LLM_ENABLED = 'false';
process.env.DINNER_IMAGES_ENABLED = 'false';
const { db, upsertTelegramUser, allowUser, createRecipe } = await import('../src/db.js');
const { requireDinnerEntry, stageFirstRecipe, getTrialStatus, grantSubscription } = await import('../src/subscriptions.js');
const { handleTrialCallback, sendTrialWelcomeMessage } = await import('../src/telegram.js');
const { deliverTrialWelcome } = await import('../src/trial-welcome.js');
test.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
let serial = 7375000;
function fresh({ selected = true } = {}) {
  const from = { id: serial++, first_name: 'Знакомство' };
  const user = upsertTelegramUser(from); allowUser(user.id);
  let recipe;
  if (selected) {
    requireDinnerEntry(user.id);
    recipe = createRecipe(user.id, { title: 'Мой выбранный ужин', status: 'ready', ingredients: [{ name: 'продукт выбранного ужина' }], steps: [{ text: 'Последний шаг выбранного ужина.' }] });
    stageFirstRecipe(user.id, { recipe, recipeId: recipe.id, source: 'chat-welcome-test' });
  }
  const chat = { id: from.id, type: 'private' };
  return { from, chat, user, recipe, callback: { id: `trial-${from.id}`, data: 'trial:start', from, message: { chat, message_id: 1 } } };
}
async function capture(run) {
  const original = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, options) => {
    assert.ok(String(url).startsWith('https://api.telegram.org/'), 'Real provider or media calls are forbidden');
    calls.push({ method: String(url).split('/').at(-1), ...JSON.parse(options.body) });
    return Response.json({ ok: true, result: { message_id: calls.length } });
  };
  try { await run(calls); } finally { globalThis.fetch = original; }
}
const isWelcome = call => String(call.text || '').includes('Спасибо, что запустил пробный период!');

test('Telegram welcomes a new trial only after its complete chosen recipe and offers an optional guide', async () => {
  const value = fresh();
  await capture(async calls => {
    await handleTrialCallback(value.callback);
    const recipeIndex = calls.findIndex(call => String(call.text).includes('Последний шаг выбранного ужина.'));
    const welcomeIndex = calls.findIndex(isWelcome);
    assert.ok(recipeIndex >= 0 && welcomeIndex > recipeIndex);
    const welcome = calls[welcomeIndex];
    assert.equal(welcome.method, 'sendMessage');
    assert.equal(welcome.chat_id, value.from.id);
    assert.match(welcome.text, /Вкусы и предпочтения/);
    assert.match(welcome.text, /Напоминания/);
    assert.match(welcome.text, /Коллекция/);
    assert.match(welcome.text, /открыть позже/);
    assert.ok(!/\p{Extended_Pictographic}/u.test(welcome.text));
    assert.equal(new URL(welcome.reply_markup.inline_keyboard[0][0].web_app.url).searchParams.get('view'), 'trial-guide');
    const expiry = getTrialStatus(value.user.id).expiresAt;
    await handleTrialCallback(value.callback);
    await deliverTrialWelcome(value.user.id, sendTrialWelcomeMessage);
    assert.equal(calls.filter(isWelcome).length, 1);
    assert.equal(getTrialStatus(value.user.id).expiresAt, expiry);
  });
});

test('the guide stays queued when the selected recipe cannot be delivered', async () => {
  const value = fresh();
  db.prepare('DELETE FROM recipes WHERE id=?').run(value.recipe.id);
  await capture(async calls => {
    await handleTrialCallback(value.callback);
    assert.equal(getTrialStatus(value.user.id).active, true);
    assert.ok(calls.some(call => String(call.text).includes('Не удалось открыть выбранный рецепт')));
    await deliverTrialWelcome(value.user.id, sendTrialWelcomeMessage);
    assert.equal(calls.filter(isWelcome).length, 0);
  });
});

test('a failed recipe send keeps welcome pending until a successful callback retry', async () => {
  const value = fresh();
  await capture(async calls => {
    const sendFixture = globalThis.fetch;
    let failRecipe = true;
    globalThis.fetch = async (url, options) => {
      const body = JSON.parse(options.body);
      if (failRecipe && String(body.text).includes('Последний шаг выбранного ужина.')) throw new Error('Fixture recipe delivery failed');
      return sendFixture(url, options);
    };
    await assert.rejects(handleTrialCallback(value.callback), /Fixture recipe delivery failed/);
    assert.equal(getTrialStatus(value.user.id).active, true);
    await deliverTrialWelcome(value.user.id, sendTrialWelcomeMessage);
    assert.equal(calls.filter(isWelcome).length, 0);
    failRecipe = false;
    await handleTrialCallback(value.callback);
    const recipeIndex = calls.findIndex(call => String(call.text).includes('Последний шаг выбранного ужина.'));
    assert.ok(recipeIndex >= 0 && calls.findIndex(isWelcome) > recipeIndex);
    assert.equal(calls.filter(isWelcome).length, 1);
  });
});

test('a legacy trial without a staged choice welcomes after its activation acknowledgement', async () => {
  const value = fresh({ selected: false });
  await capture(async calls => {
    await handleTrialCallback(value.callback);
    const ack = calls.findIndex(call => call.method === 'editMessageText' && String(call.text).includes('Пробный период начался'));
    assert.ok(ack >= 0 && calls.findIndex(isWelcome) > ack);
    assert.equal(calls.filter(isWelcome).length, 1);
  });
});

test('foreign, paid and expired trial buttons cannot enqueue a new welcome', async () => {
  const foreign = fresh(), paid = fresh(), expired = fresh();
  grantSubscription(paid.user.id, 'subscription', new Date(Date.now() + 86400000).toISOString());
  db.prepare('INSERT INTO user_trials(user_id,starts_at,expires_at) VALUES(?,?,?)').run(expired.user.id, '2020-01-01T00:00:00Z', '2020-01-08T00:00:00Z');
  await capture(async calls => {
    assert.equal(await handleTrialCallback({ ...foreign.callback, message: { chat: paid.chat, message_id: 1 } }), false);
    assert.equal(getTrialStatus(foreign.user.id).used, false);
    await handleTrialCallback(paid.callback);
    await handleTrialCallback(expired.callback);
    assert.equal(calls.filter(isWelcome).length, 0);
    await assert.rejects(sendTrialWelcomeMessage(expired.user.id, expired.chat.id, getTrialStatus(expired.user.id)), /не активен/);
  });
});

test('MAX sends the optional trial-guide button after the recipe with the same queue deduplication', () => {
  const code = `
    import assert from 'node:assert/strict';
    const {db,upsertTelegramUser,allowUser,createRecipe}=await import('./src/db.js');
    const {requireDinnerEntry,stageFirstRecipe,getTrialStatus}=await import('./src/subscriptions.js');
    const {handleTrialCallback,sendTrialWelcomeMessage}=await import('./src/telegram.js');
    const {deliverTrialWelcome}=await import('./src/trial-welcome.js');
    const {maxStore}=await import('./src/max-store.js');
    const from={id:'max:18',first_name:'MAX'};const chat={id:from.id,type:'private'};
    const user=upsertTelegramUser(from);allowUser(user.id);requireDinnerEntry(user.id);
    const recipe=createRecipe(user.id,{title:'Ужин MAX',status:'ready',ingredients:[{name:'продукт MAX'}],steps:[{text:'Полный выбранный шаг MAX.'}]});
    stageFirstRecipe(user.id,{recipe,recipeId:recipe.id,source:'chat-welcome-test'});
    const calls=[];let serial=0;
    globalThis.fetch=async(url,options)=>{assert.equal(new URL(url).origin,'https://platform-api2.max.ru');const body=JSON.parse(options.body);calls.push(body);return Response.json(new URL(url).pathname==='/messages'&&options.method==='POST'?{message:{body:{mid:'mid.'+(++serial),text:body.text},recipient:{chat_id:901,chat_type:'dialog'}}}:{success:true});};
    maxStore.rememberCallback('confirm-max',18);
    const callback={id:'confirm-max',data:'trial:start',from,message:{chat,message_id:'mid.original'}};
    await handleTrialCallback(callback);
    const full=calls.findIndex(c=>String(c.text).includes('Полный выбранный шаг MAX.'));
    const index=calls.findIndex(c=>String(c.text).includes('Спасибо, что запустил пробный период!'));
    assert.ok(full>=0&&index>full);
    const open=calls[index].attachments.flatMap(a=>a.payload?.buttons||[]).flat().find(b=>b.type==='open_app');
    assert.equal(JSON.parse(Buffer.from(open.payload,'base64url')).view,'trial-guide');
    const expiry=getTrialStatus(user.id).expiresAt;
    await handleTrialCallback(callback);await deliverTrialWelcome(user.id,sendTrialWelcomeMessage);
    assert.equal(calls.filter(c=>String(c.text).includes('Спасибо, что запустил пробный период!')).length,1);
    assert.equal(getTrialStatus(user.id).expiresAt,expiry);db.close();
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', env: { ...process.env, DATABASE_PATH: path.join(directory, 'max.sqlite'), BOT_PLATFORM: 'max', TELEGRAM_BOT_TOKEN: '', MAX_BOT_TOKEN: 'fixture-welcome-max', MAX_BOT_USERNAME: 'fixture_max_bot', MAX_WEBHOOK_SECRET: 'fixture-max-secret-'.repeat(3), TELEGRAM_POLLING: 'false' } });
  assert.equal(result.status, 0, result.stderr);
});
