import { config } from './config.js';
import { aiUsageSummary, allowUser, archiveRecipe, claimUpdate, clearPendingIntent, completeUpdate, deleteUserData, failUpdate, getPendingIntent, listRecipes, searchRecipes, setPendingIntent, upsertTelegramUser } from './db.js';
import { importText, importUrl } from './importer.js';
import { transcribeAudio } from './openai.js';
import { log } from './log.js';

const apiBase = () => `https://api.telegram.org/bot${config.telegramToken}`;
const fileBase = () => `https://api.telegram.org/file/bot${config.telegramToken}`;

async function telegram(method, body = {}) {
  const response = await fetch(`${apiBase()}/${method}`, { method: 'POST', signal: AbortSignal.timeout(method === 'getUpdates' ? 40000 : 15000), headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const payload = await response.json();
  if (!payload.ok) throw new Error(`Telegram ${method}: ${payload.description || response.status}`);
  return payload.result;
}

const send = (chatId, text, extra = {}) => telegram('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...extra });
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (x) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[x]);
const number = (value) => new Intl.NumberFormat('ru-RU').format(Number(value) || 0);

function usageMessage(userId) {
  const usage = aiUsageSummary(userId);
  const { reservations, totals, recent } = usage;
  const lines = [
    '<b>Использование AI</b>',
    `Запросы сегодня: <b>${number(reservations.today)} / ${number(reservations.dailyLimit)}</b>`,
    `Запросы всего: <b>${number(reservations.total)} / ${number(reservations.totalLimit)}</b>`,
    '',
    '<b>Точные токены с момента включения мониторинга</b>',
    `Вход: ${number(totals.input_units)}`,
    `Выход: ${number(totals.output_units)} · reasoning: ${number(totals.reasoning_units)}`,
    `Всего: <b>${number(totals.total_units)}</b> · кэшировано на входе: ${number(totals.cached_input_units)}`,
    `Успешно: ${number(totals.successful)} · ошибок: ${number(totals.failed)}`
  ];
  if (recent.length) {
    lines.push('', '<b>Последние запросы</b>');
    for (const row of recent) lines.push(`• ${escapeHtml(row.operation)} · ${escapeHtml(row.status)} · ${number(row.input_units)} + ${number(row.output_units)} = ${number(row.total_units)}${row.error_code ? ` · ${escapeHtml(row.error_code)}` : ''}`);
  }
  return lines.join('\n');
}

export function webAppUrl(params = {}) {
  if (!config.appUrl?.startsWith('https://')) return null;
  const url = new URL(config.appUrl);
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
  return url.toString();
}

export function detectIntent(text, { hasPhoto = false, hasUrl = false } = {}) {
  const value = String(text || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('ru');
  if (hasPhoto || hasUrl) return 'save';
  const save = /(?:^|\s)(?:сохрани|сохранить|добавь|добавить|запиши|записать)(?:\s|$)/iu.test(value);
  const search = /(?:^|\s)(?:\/?(?:find|search)|найди|найти|покажи|подбери|подобрать|посоветуй|что\s+(?:мне\s+)?приготовить|что\s+сделать|хочу\s+приготовить)(?:\s|$|[?.!,])/iu.test(value);
  if (save && !search) return 'save';
  if (search && !save) return 'search';
  if (save && search) return 'ambiguous';
  if (value.length >= 80 && /(?:ингредиент|приготовлен|нареж|добав|смеш|ложк|\b\d+\s*(?:г|гр|мл|мин))/iu.test(value)) return 'save';
  return 'ambiguous';
}

export function extractSharedUrl(text) {
  const match = String(text || '').match(/https?:\/\/[^\s<>]+/i);
  return match ? match[0].replace(/[),.;!?]+$/, '') : null;
}

async function downloadTelegramFile(fileId, maxBytes) {
  const info = await telegram('getFile', { file_id: fileId });
  if (info.file_size && info.file_size > maxBytes) throw Object.assign(new Error('Файл слишком большой'), { status: 413 });
  const response = await fetch(`${fileBase()}/${info.file_path}`, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error('Не удалось скачать Telegram-файл');
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxBytes) throw Object.assign(new Error('Файл слишком большой'), { status: 413 });
  return { buffer, path: info.file_path };
}

export async function interpretVoice(message, user, adapters = {}) {
  const media = message.voice || message.audio;
  if (!media || !Number.isFinite(media.duration) || media.duration > 120) throw new Error('Пришлите голосовое длительностью до 2 минут.');
  const download = adapters.download || downloadTelegramFile;
  const transcribe = adapters.transcribe || transcribeAudio;
  const { buffer, path = 'voice.ogg' } = await download(media.file_id, config.maxUploadBytes);
  const mime = media.mime_type || 'audio/ogg';
  const extension = mime.includes('ogg') ? 'ogg' : mime.includes('mpeg') ? 'mp3' : mime.includes('mp4') ? 'm4a' : mime.includes('wav') ? 'wav' : 'ogg';
  const originalName = path.split('/').at(-1) || `voice.${extension}`;
  const filename = originalName.replace(/\.[^.]+$/, '') + `.${extension}`;
  const text = String(await transcribe({ userId: user.id, buffer, mime, filename })).trim();
  if (text.length < 3) throw new Error('Не удалось уверенно расслышать запрос. Скажите ещё раз или напишите текстом.');
  return { text, sourceKey: `telegram-voice:${media.file_unique_id || media.file_id}` };
}

function recipeButton(recipe) {
  const url = webAppUrl({ recipe: recipe.id });
  return url ? { inline_keyboard: [[{ text: 'Открыть рецепт', web_app: { url } }]] } : undefined;
}

async function sendRecipeCard(chatId, recipe) {
  const caption = `<b>${escapeHtml(recipe.title)}</b>${recipe.sourceName ? `\n${escapeHtml(recipe.sourceName)}` : ''}`;
  const reply_markup = recipeButton(recipe);
  if (recipe.thumbnailUrl) {
    try { await telegram('sendPhoto', { chat_id: chatId, photo: recipe.thumbnailUrl, caption, parse_mode: 'HTML', reply_markup }); return; }
    catch (error) { log('warn', 'telegram_preview_failed', { error, recipeId: recipe.id }); }
  }
  await send(chatId, `${caption}\n<i>У источника нет доступного превью.</i>`, { reply_markup });
}

async function sendSearchResults(chatId, user, query) {
  const normalizedQuery = String(query).replace(/^\/?(?:find|search)\s+/i, '').trim();
  const results = searchRecipes(user.id, normalizedQuery).filter((recipe) => recipe.status === 'ready').slice(0, 8);
  if (!results.length) {
    await send(chatId, `Как понял: ищу в вашей коллекции «<b>${escapeHtml(normalizedQuery)}</b>».\n\nНичего подходящего не нашёл. Попробуйте изменить запрос или сначала поделитесь рецептом в этот чат.`);
    return [];
  }
  const allUrl = webAppUrl({ view: 'results', q: normalizedQuery });
  await send(chatId, `Как понял: ищу в вашей коллекции «<b>${escapeHtml(normalizedQuery)}</b>».\nНашёл: ${results.length}.`, allUrl ? { reply_markup: { inline_keyboard: [[{ text: 'Все результаты', web_app: { url: allUrl } }]] } } : {});
  for (const recipe of results.slice(0, 3)) await sendRecipeCard(chatId, recipe);
  return results;
}

async function finishImport(chatId, outcome) {
  if (outcome.state === 'processing') { await send(chatId, 'Этот источник уже обрабатывается. Новую задачу и лишний AI-вызов не создаю.'); return; }
  const recipe = outcome.recipe;
  if (outcome.state === 'existing') { await send(chatId, `Этот рецепт уже есть: <b>${escapeHtml(recipe.title)}</b>.`, { reply_markup: recipeButton(recipe) }); return; }
  await send(chatId, `Сохранено: <b>${escapeHtml(recipe.title)}</b>. Рецепт уже появился в вашей коллекции.`, { reply_markup: recipeButton(recipe) });
}

async function saveContent(message, user, content) {
  const chatId = message.chat.id;
  await send(chatId, 'Получено. Извлекаю рецепт — статус уже сохранён, можно закрыть чат.');
  let outcome;
  if (message.photo?.length) {
    const photo = message.photo.at(-1);
    const { buffer } = await downloadTelegramFile(photo.file_id, config.maxUploadBytes);
    outcome = await importText(user.id, message.caption || '', { sourceType: 'image', sourceName: 'Фото из Telegram', label: 'Фото из Telegram', sourceKey: `telegram-photo:${photo.file_unique_id || photo.file_id}`, image: { buffer, mime: 'image/jpeg' } });
  } else if (content.url) outcome = await importUrl(user.id, content.url);
  else outcome = await importText(user.id, content.text, { sourceType: content.sourceType || 'text', sourceName: content.sourceType === 'audio' ? 'Ваше голосовое' : 'Сообщение в Telegram', label: content.sourceType === 'audio' ? 'Ваше голосовое' : 'Текстовый рецепт', sourceKey: content.sourceKey });
  await finishImport(chatId, outcome);
}

async function handlePendingChoice(message, user, pending) {
  const answer = String(message.text || '').trim();
  if (/^(?:найти|ищи|поиск|в коллекции)/iu.test(answer)) {
    clearPendingIntent(user.id); await sendSearchResults(message.chat.id, user, pending.text); return true;
  }
  if (/^(?:сохранить|сохрани|добавить|добавь)/iu.test(answer)) {
    clearPendingIntent(user.id); await saveContent(message, user, pending); return true;
  }
  return false;
}

export async function handleMessage(message) {
  if (message.chat?.type !== 'private' || !message.from) return;
  const chatId = message.chat.id;
  const user = upsertTelegramUser(message.from);
  const text = message.text?.trim() || message.caption?.trim() || '';
  if (text === '/privacy' || text === '/terms') { await send(chatId, `${text === '/privacy' ? 'Как обрабатываются ваши данные' : 'Условия закрытого теста'}: ${config.appUrl}/${text.slice(1)}.html`); return; }
  if (text.startsWith('/start')) {
    if (!user.is_allowed) allowUser(user.id);
    const appUrl = webAppUrl();
    await send(chatId, 'Привет! Я сохраняю рецепты из ссылок, текста, фото и голосовых, а ещё ищу по вашей личной коллекции.\n\nПросто поделитесь рецептом сюда или спросите: «Есть курица, что приготовить?»', appUrl ? { reply_markup: { inline_keyboard: [[{ text: 'Открыть приложение', web_app: { url: appUrl } }]] } } : {});
    return;
  }
  if (!user.is_allowed) { await send(chatId, 'Нажмите Start — код или пароль не нужен.'); return; }
  if (text === '/help') { await send(chatId, 'Поделитесь ссылкой, текстом или фото — рецепт сохранится автоматически. Можно отправить голосовой запрос: «Найди крылышки с мёдом». Если цель неясна, я спрошу: найти или сохранить.'); return; }
  if (text === '/usage') { await send(chatId, usageMessage(user.id)); return; }
  if (text === '/delete_data CONFIRM') { deleteUserData(user.id); await send(chatId, 'Ваши рецепты и профиль удалены.'); return; }
  if (text.startsWith('/delete_recipe ')) { archiveRecipe(user.id, text.slice(15)); await send(chatId, 'Рецепт убран из библиотеки.'); return; }

  const pending = getPendingIntent(user.id);
  if (pending && await handlePendingChoice(message, user, pending)) return;

  let content = { text, sourceType: 'text', sourceKey: undefined, url: extractSharedUrl(text) };
  if (message.voice || message.audio) {
    try {
      await telegram('sendChatAction', { chat_id: chatId, action: 'typing' });
      content = { ...(await interpretVoice(message, user)), sourceType: 'audio', url: null };
    } catch (error) {
      log('error', 'telegram_voice_failed', { error, userId: user.id });
      await send(chatId, escapeHtml(error.message || 'Не удалось обработать голосовое. Пришлите его ещё раз или напишите текстом.'));
      return;
    }
  }
  const intent = detectIntent(content.text, { hasPhoto: Boolean(message.photo?.length), hasUrl: Boolean(content.url) });
  if (intent === 'search') { await sendSearchResults(chatId, user, content.text); return; }
  if (intent === 'save') {
    try { await saveContent(message, user, content); }
    catch (error) { log('error', 'telegram_import_failed', { error, userId: user.id }); await send(chatId, `Не получилось сохранить: ${escapeHtml(error.message)}\n\nМожно прислать текст или скриншот рецепта.`); }
    return;
  }
  setPendingIntent(user.id, content);
  await send(chatId, 'Найти в вашей коллекции или сохранить ваш рецепт? Ответьте «найти» или «сохранить».');
}

let running = false;
export async function startTelegramPolling() {
  if (running || !config.telegramToken) return;
  running = true; let offset = 0;
  log('info', 'telegram_polling_started');
  while (running) {
    try {
      const updates = await telegram('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] });
      for (const update of updates) {
        offset = Math.max(offset, update.update_id + 1);
        if (!update.message || !claimUpdate(update.update_id)) continue;
        try { await handleMessage(update.message); completeUpdate(update.update_id); }
        catch (error) { failUpdate(update.update_id); log('error', 'telegram_update_failed', { error, updateId: update.update_id }); }
      }
    } catch (error) { log('error', 'telegram_polling_error', { error }); await new Promise((resolve) => setTimeout(resolve, 3000)); }
  }
}
export function stopTelegramPolling() { running = false; }
