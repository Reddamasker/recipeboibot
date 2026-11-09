import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-policy-'));
const platform = process.env.BOT_PLATFORM || 'telegram';
Object.assign(process.env, {
  DATABASE_PATH: path.join(directory, 'test.sqlite'), TELEGRAM_POLLING: 'false', BOT_PLATFORM: platform,
  TEST_CONTOUR: platform === 'telegram' ? 'true' : 'false', TEST_BOT_USERNAME: 'recipeboi_test_bot',
  CHAT_RECIPE_GENERATION_ENABLED: 'false', TELEGRAM_BOT_TOKEN: 'policy-test', MAX_BOT_TOKEN: 'policy-test',
  MAX_BOT_USERNAME: 'recipe_policy_bot', APP_URL: 'https://recipes.example.test',
  OPENAI_API_KEY: 'test-key', OPENAI_TEXT_MODEL: 'test-model', OPENAI_TRANSCRIBE_MODEL: 'test-model',
  DINNER_LLM_ENABLED: 'true', DINNER_IMAGES_ENABLED: 'false', OPENAI_IMAGE_MODEL: ''
});
// Install before importing the MAX client, which captures the transport adapter.
const sent = []; let unexpected = 0;
globalThis.fetch = async (url, options = {}) => {
  const address = new URL(url), body = JSON.parse(options.body || '{}');
  if (!['api.telegram.org', 'platform-api2.max.ru'].includes(address.hostname)) {
    unexpected++; throw new Error('Unexpected AI/network request: ' + address.hostname);
  }
  sent.push({ path: address.pathname, ...body });
  if (platform === 'telegram') return Response.json({ ok: true, result: { message_id: sent.length } });
  return Response.json({ success: true, message: { body: { mid: 'out-' + sent.length, text: body.text || '' }, recipient: { chat_id: 900, chat_type: 'dialog' } } });
};
const dbModule = await import('../src/db.js');
const { db, resolvePrivateTelegramUser, allowUser, setPendingIntent, clearPendingIntent, getPendingIntent, createSearchOffer, claimUpdate, completeUpdate } = dbModule;
const { handleChatUpdate, revealDinnerButton } = await import('../src/telegram.js');
const { createRecipeDialogue, clearRecipeDialogue } = await import('../src/recipe-dialogue.js');
const { normalizeMaxUpdate } = await import('../src/max-events.js');
const { maxStore } = await import('../src/max-store.js');
const { startTrial } = await import('../src/subscriptions.js');
const { productReport } = await import('../src/product-analytics.js');
const { SEED_RECIPES } = await import('../src/dinner.js');
const from = { id: platform === 'max' ? 'max:91002001' : 91002001, first_name: 'Policy' };
const chat = { id: from.id, type: 'private' };
const user = resolvePrivateTelegramUser(from); allowUser(user.id); startTrial(user.id);
let serial = 1;
async function message(text, extra = {}) {
  const update = platform === 'max' && !Object.keys(extra).length
    ? normalizeMaxUpdate({ update_type: 'message_created', timestamp: Date.now(), message: {
      sender: { user_id: 91002001, first_name: 'Policy' }, recipient: { chat_id: 900, chat_type: 'dialog' }, body: { mid: 'in-' + serial++, text }
    } }) : { message: { from, chat, message_id: serial++, text, ...extra } };
  await handleChatUpdate(update);
}
async function callback(data, id = serial++) {
  const callbackId = 'callback-' + id;
  if (platform === 'max') maxStore.rememberCallback(callbackId, 91002001);
  await handleChatUpdate({ callback_query: { id: callbackId, data, from, message: { chat, message_id: 1 } } });
}
const refused = () => assert.match(sent.at(-1).text, /ИИ-генерация.*отключена/);
try {
  for (const text of ['Подбери необычный ужин из говядины', '/find', '/find суп', '/search суп', '/dinner', '/ingredients', 'Хочу конкретное блюдо']) {
    await message(text); refused();
  }
  await message('', { voice: { file_id: 'voice', duration: 2 } }); refused();
  const dialogue = createRecipeDialogue(user.id, { query: 'ужин', mealRequest: { text: 'ужин', kind: 'open' }, recipe: SEED_RECIPES[0] });
  for (const text of ['другой вариант', 'без риса', 'а что приготовить завтра?']) { await message(text); refused(); }
  for (const action of ['other', 'edit', 'refuse', 'slow', 'missing', 'recent', 'dislike']) { await callback(`dialog:${action}:${dialogue.id}`); refused(); }
  const offer = createSearchOffer(user.id, 'новый суп');
  await callback(`offer:create:${offer}`); refused();
  clearRecipeDialogue(user.id);
  setPendingIntent(user.id, { kind: 'dinner-confirm', profileOnly: false, intake: { availableIngredients: ['рис'], householdSize: 2 } });
  await callback('dinner:confirm'); refused();
  setPendingIntent(user.id, { kind: 'dinner-intake', profileOnly: true, intake: {} });
  await callback('dinner:skip'); refused();
  await revealDinnerButton(from.id, 1, user.id, 'stale-session');
  clearPendingIntent(user.id);
  await message('/start'); refused();
  await message('/collection'); assert.match(sent.at(-1).text, /сохранённые рецепты/);
  await message('/save'); assert.equal(getPendingIntent(user.id).kind, 'recipe-save');
  assert.match(sent.at(-1).text, /Пришлите ссылку, фото/);
  await message('/cancel');
  const before = db.prepare("SELECT COUNT(*) n FROM product_events WHERE event='operation_finished'").get().n;
  for (let i = 0; i < 2; i++) if (claimUpdate('policy-duplicate')) {
    await message('/find повтор'); completeUpdate('policy-duplicate');
  }
  assert.equal(db.prepare("SELECT COUNT(*) n FROM product_events WHERE event='operation_finished'").get().n, before + 1);
  const rows = db.prepare("SELECT * FROM product_events WHERE event='operation_finished' AND user_id=?").all(user.id);
  const blocked = rows.filter(row => JSON.parse(row.detail_json).status === 403);
  assert.ok(blocked.length >= 20);
  assert.ok(blocked.every(row => row.step === 'request' && row.duration_ms >= 0 && !JSON.parse(row.detail_json).resultMode));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM product_events WHERE event IN ('request_visible','request_preview_visible','request_stage')").get().n, 0);
  assert.equal(productReport([{ id: user.id }]).errors.find(row => row.code === 'http_403').count, blocked.length);
  assert.equal(productReport([]).errors.length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ai_reservations').get().n, 0);
  assert.equal(unexpected, 0, 'No request interpretation, transcription, generation or prefetch');
  console.log(platform + ': chat policy verified');
} finally {
  db.close(); fs.rmSync(directory, { recursive: true, force: true });
}
