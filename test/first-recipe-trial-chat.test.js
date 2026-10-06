import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'first-recipe-chat-gate-'));
process.env.DATABASE_PATH = path.join(directory, 'recipes.sqlite');
process.env.BOT_PLATFORM = 'telegram';
process.env.TELEGRAM_BOT_TOKEN = 'fixture-chat-token';
process.env.TELEGRAM_POLLING = 'false';
process.env.APP_URL = 'https://recipes.example';
process.env.TEST_CONTOUR = 'false';
process.env.BILLING_REQUIRED = 'false';
process.env.DINNER_LLM_ENABLED = 'false';
process.env.DINNER_IMAGES_ENABLED = 'false';
const { db, upsertTelegramUser, allowUser, createRecipe, createRecipeSuggestion, getRecipe } = await import('../src/db.js');
const { stageFirstRecipe, requireDinnerEntry, getPendingFirstRecipe, isFirstRecipeAwaitingTrial, getTrialStatus, grantSubscription } = await import('../src/subscriptions.js');
const { handleMessage, handleTrialCallback, handleRecipeDialogueCallback, handleSuggestionCallback, sendFirstFreeRecipe, sendSuggestion, revealDinnerButton } = await import('../src/telegram.js');
const { createRecipeDialogue } = await import('../src/recipe-dialogue.js');
test.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
let serial = 7351000;
function fresh({ legacy = false } = {}) {
  const from = { id: serial++, first_name: 'Первый рецепт' };
  const user = upsertTelegramUser(from); allowUser(user.id);
  if (!legacy) requireDinnerEntry(user.id);
  const recipe = createRecipe(user.id, { status: 'ready', title: 'Выбранная паста', ingredients: [{ name: 'скрытый ингредиент', quantity: 123, unit: 'г' }], steps: [{ text: 'Скрытый шаг приготовления.' }] });
  return { from, user, recipe, chat: { id: from.id, type: 'private' } };
}
async function capture(run) {
  const original = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, options = {}) => {
    assert.ok(String(url).startsWith('https://api.telegram.org/'), 'No AI, media download or live request is allowed');
    calls.push({ method: String(url).split('/').at(-1), ...JSON.parse(options.body) });
    return Response.json({ ok: true, result: { message_id: calls.length } });
  };
  try { await run(calls); } finally { globalThis.fetch = original; }
}
const textOf = calls => calls.map(call => call.text || call.caption || '').join('\n');
const stage = value => stageFirstRecipe(value.user.id, { recipe: value.recipe, recipeId: value.recipe.id, source: 'chat-test' });
function assertLocked(calls, title) {
  const text = textOf(calls);
  assert.ok(text.includes(title));
  assert.ok(!text.includes('скрытый ингредиент'));
  assert.ok(!text.includes('Скрытый шаг приготовления.'));
  assert.ok(!text.includes('Ингредиенты\n'));
  assert.ok(calls.some(call => call.reply_markup?.inline_keyboard?.flat().some(button => button.web_app?.url.includes('view=benefits'))));
}

test('a staged chat recipe shows benefits without ingredients, steps or a readable recipe link', async () => {
  const value = fresh(); stage(value);
  await capture(async calls => {
    await sendFirstFreeRecipe(value.chat.id, value.recipe, { userId: value.user.id });
    assertLocked(calls, value.recipe.title);
    assert.equal(getTrialStatus(value.user.id).used, false);
    assert.equal(isFirstRecipeAwaitingTrial(value.user.id), true);
    assert.ok(!calls.some(call => call.reply_markup?.inline_keyboard?.flat().some(button => button.web_app?.url.includes(`recipe=${value.recipe.id}`))));
  });
});

test('reopening the chat, asking another dish and using old dialogue buttons keep the same pending recipe', async () => {
  const value = fresh(); stage(value);
  const dialogue = createRecipeDialogue(value.user.id, { query: 'Паста', recipe: value.recipe });
  await capture(async calls => {
    for (const text of ['/start', '/find', '/start save', '/save', '/collection', '/offer', '/cancel', 'Подбери другой рецепт']) {
      const before = calls.length;
      await handleMessage({ from: value.from, chat: value.chat, text });
      assertLocked(calls.slice(before), value.recipe.title);
    }
    const before = calls.length;
    await handleRecipeDialogueCallback({ id: 'old-open', data: `dialog:open:${dialogue.id}`, from: value.from, message: { chat: value.chat, message_id: 8 } });
    assertLocked(calls.slice(before), value.recipe.title);
    assert.equal(getPendingFirstRecipe(value.user.id).recipeId, value.recipe.id);
    assert.equal(getTrialStatus(value.user.id).used, false);
  });
});

test('a confirmed trial opens the exact selected recipe and retries do not extend trial or regenerate it', async () => {
  const value = fresh(); stage(value);
  createRecipe(value.user.id, { title: 'Другой рецепт', status: 'ready', ingredients: [{ name: 'не выбранный продукт' }], steps: [{ text: 'Не выбранные шаги.' }] });
  await capture(async calls => {
    const callback = { id: 'trial-confirm', data: 'trial:start', from: value.from, message: { chat: value.chat, message_id: 1 } };
    assert.equal(await handleTrialCallback(callback), true);
    const first = getTrialStatus(value.user.id);
    assert.equal(first.active, true);
    assert.equal(getPendingFirstRecipe(value.user.id).unlocked, true);
    assert.ok(textOf(calls).includes('скрытый ингредиент'));
    assert.ok(textOf(calls).includes('Скрытый шаг приготовления.'));
    assert.ok(!textOf(calls).includes('Не выбранные шаги.'));
    calls.length = 0;
    await handleTrialCallback(callback);
    assert.equal(getTrialStatus(value.user.id).expiresAt, first.expiresAt);
    assert.ok(textOf(calls).includes(value.recipe.title));
    assert.ok(textOf(calls).includes('Скрытый шаг приготовления.'));
    assert.equal(getRecipe(value.user.id, value.recipe.id).title, value.recipe.title);
  });
});

test('inactive spent trials never unlock pending details through the old callback', async () => {
  const value = fresh(); stage(value);
  db.prepare('INSERT INTO user_trials(user_id,starts_at,expires_at) VALUES(?,?,?)').run(value.user.id, '2020-01-01T00:00:00Z', '2020-01-08T00:00:00Z');
  await capture(async calls => {
    await handleTrialCallback({ id: 'expired', data: 'trial:start', from: value.from, message: { chat: value.chat, message_id: 1 } });
    assert.equal(getTrialStatus(value.user.id).active, false);
    assert.ok(!textOf(calls).includes('Скрытый шаг приготовления.'));
    assert.equal(getPendingFirstRecipe(value.user.id).unlocked, false);
  });
});

test('an obsolete dinner background response sends one benefits card and clears its old keyboard', async () => {
  const value = fresh(); stage(value);
  await capture(async calls => {
    await revealDinnerButton(value.chat.id, 8, value.user.id, 'obsolete-session');
    const sent = calls.filter(call => call.method === 'sendMessage');
    assert.equal(sent.length, 1);
    assertLocked(sent, value.recipe.title);
    assert.ok(!textOf(calls).includes('Первый бесплатный рецепт'));
    assert.ok(!textOf(calls).includes('Показываю его ещё раз'));
    assert.ok(calls.some(call => call.method === 'editMessageReplyMarkup' && call.message_id === 8 && call.reply_markup.inline_keyboard.length === 0));
  });
});

test('missing selected data after activation does not substitute another recipe or invent an invalid direct link', async () => {
  const value = fresh(); stage(value);
  db.prepare('DELETE FROM recipes WHERE id=?').run(value.recipe.id);
  createRecipe(value.user.id, { title: 'Другой рецепт', status: 'ready', ingredients: [{ name: 'посторонний продукт' }], steps: [{ text: 'Посторонние шаги.' }] });
  await capture(async calls => {
    await handleTrialCallback({ id: 'missing', data: 'trial:start', from: value.from, message: { chat: value.chat, message_id: 1 } });
    assert.equal(getTrialStatus(value.user.id).active, true);
    assert.ok(textOf(calls).includes('Не удалось открыть выбранный рецепт в чате'));
    assert.ok(!textOf(calls).includes('Посторонние шаги.'));
    assert.ok(!textOf(calls).includes('Ваш выбранный рецепт сохранён'));
    assert.ok(!calls.some(call => call.reply_markup?.inline_keyboard?.flat().some(button => button.web_app?.url.includes(`recipe=${value.recipe.id}`))));
    assert.equal(getPendingFirstRecipe(value.user.id).recipeId, value.recipe.id);
  });
});

test('a generated staged suggestion with an old save button also waits for confirmed access', async () => {
  const value = fresh();
  const suggestion = createRecipeSuggestion(value.user.id, 'Паста', value.recipe);
  const proposal = typeof suggestion === 'string' ? { id: suggestion, recipe: value.recipe } : suggestion;
  stageFirstRecipe(value.user.id, { recipe: value.recipe, recipeId: `suggestion:${proposal.id}`, source: 'chat-test' });
  await capture(async calls => {
    await sendSuggestion(value.chat.id, proposal, { userId: value.user.id });
    assertLocked(calls, value.recipe.title);
    calls.length = 0;
    await handleSuggestionCallback({ id: 'old-save', data: `suggest:save:${proposal.id}`, from: value.from, message: { chat: value.chat, message_id: 1 } });
    assertLocked(calls, value.recipe.title);
    assert.equal(getTrialStatus(value.user.id).used, false);
  });
});

test('legacy saved recipes and active access retain full details; long recipes retain the final step', async () => {
  const legacy = fresh({ legacy: true });
  const paid = fresh(); grantSubscription(paid.user.id, 'subscription', new Date(Date.now() + 86400000).toISOString());
  paid.recipe.steps = [{ text: 'Готовим. '.repeat(900) + 'Последний сохранённый шаг.' }];
  await capture(async calls => {
    await sendFirstFreeRecipe(legacy.chat.id, legacy.recipe, { userId: legacy.user.id });
    assert.ok(textOf(calls).includes('Скрытый шаг приготовления.'));
    calls.length = 0;
    await sendFirstFreeRecipe(paid.chat.id, paid.recipe, { userId: paid.user.id });
    assert.ok(textOf(calls).includes('Последний сохранённый шаг.'));
    assert.ok(calls.filter(call => call.method === 'sendMessage').every(call => call.text.length <= 3500));
  });
});

test('the MAX chat transport shows benefits before trial and the same full recipe after confirmation', () => {
  const code = `
    import assert from 'node:assert/strict';
    const {db,upsertTelegramUser,allowUser,createRecipe}=await import('./src/db.js');
    const {stageFirstRecipe,requireDinnerEntry,getPendingFirstRecipe,getTrialStatus}=await import('./src/subscriptions.js');
    const {sendFirstFreeRecipe,handleTrialCallback}=await import('./src/telegram.js');
    const {maxStore}=await import('./src/max-store.js');
    const from={id:'max:17',first_name:'MAX'};const chat={id:from.id,type:'private'};
    const user=upsertTelegramUser(from);allowUser(user.id);
    requireDinnerEntry(user.id);
    const recipe=createRecipe(user.id,{status:'ready',title:'Выбранное блюдо MAX',ingredients:[{name:'скрытый ингредиент MAX'}],steps:[{text:'Скрытый шаг MAX.'}]});
    stageFirstRecipe(user.id,{recipe,recipeId:recipe.id,source:'chat-test'});
    const calls=[];let serial=0;
    globalThis.fetch=async(url,options)=>{
      assert.equal(new URL(url).origin,'https://platform-api2.max.ru');
      const body=JSON.parse(options.body);calls.push(body);
      return Response.json(new URL(url).pathname==='/messages'&&options.method==='POST'?{message:{body:{mid:'mid.'+(++serial),text:body.text},recipient:{chat_id:900,chat_type:'dialog'}}}:{success:true});
    };
    await sendFirstFreeRecipe(chat.id,recipe,{userId:user.id});
    assert.ok(!calls.some(c=>String(c.text).includes('Скрытый шаг MAX.')));
    const open=calls.flatMap(c=>c.attachments||[]).flatMap(a=>a.payload?.buttons||[]).flat().find(b=>b.type==='open_app');
    assert.equal(JSON.parse(Buffer.from(open.payload,'base64url')).view,'benefits');
    assert.equal(getTrialStatus(user.id).used,false);
    maxStore.rememberCallback('trial-confirm',17);
    await handleTrialCallback({id:'trial-confirm',data:'trial:start',from,message:{chat,message_id:'mid.1'}});
    assert.equal(getTrialStatus(user.id).active,true);
    assert.equal(getPendingFirstRecipe(user.id).recipeId,recipe.id);
    assert.equal(getPendingFirstRecipe(user.id).unlocked,true);
    assert.ok(calls.some(c=>String(c.text).includes('Скрытый шаг MAX.')));
    db.close();
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', env: { ...process.env, DATABASE_PATH: path.join(directory, 'max.sqlite'), BOT_PLATFORM: 'max', TELEGRAM_BOT_TOKEN: '', MAX_BOT_TOKEN: 'fixture-max-token', MAX_BOT_USERNAME: 'fixture_max_bot', MAX_WEBHOOK_SECRET: 'fixture-max-secret-'.repeat(3), TELEGRAM_POLLING: 'false' } });
  assert.equal(result.status, 0, result.stderr);
});
