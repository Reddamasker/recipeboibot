import { config } from './config.js';
import { activateTelegramGroup, aiUsageSummary, allowUser, archiveRecipe, claimUpdate, clearPendingIntent, completeUpdate, createSearchOffer, deactivateTelegramGroup, deleteUserData, failUpdate, getActiveTelegramGroup, getPendingIntent, getRecipeSuggestion, getSearchOffer, getUserById, GROUP_LIMIT, listRecipes, saveRecipeSuggestion, searchRecipes, setPendingIntent, resolvePrivateTelegramUser, upsertTelegramUser } from './db.js';
import { importText, importUrl, importYoutubePlaylist } from './importer.js';
import { extractDinnerIntake, transcribeAudio } from './openai.js';
import { resolveRecipeRequest, suggestForEmptySearch, assertSuggestionCurrent } from './suggestions.js';
import { log } from './log.js';
import { ensureRecipeImage } from './recipe-images.js';
import { combineDinnerIntakeExtraction, mergeDinnerIntake, normalizeDinnerIntake, parseDinnerIntakeFallback } from './dinner-intake.js';
import { confirmDinnerIntake, prefetchDinner, recommendDinner, startDinner, updateDinnerProfile } from './dinner-service.js';
import { addDinnerEvent, clearDinnerContext, getDinnerContext, getDinnerRequestCategories, getFoodProfile, setDinnerContext } from './dinner-store.js';
import { DINNER_CATEGORIES } from './dinner.js';
import { getDinnerMealRequest } from './dinner-store.js';
import { canUseTestImport, claimMockOffer, mockPaymentStatus, resetTestUser } from './contour-sandbox.js';
import { billingAvailable, canUseAutomaticImport, getBillingOffer, recordBillingExposure } from './billing.js';
import { getSubscriptionAccess } from './subscriptions.js';
import { youtubePlaylist } from './youtube.js';

const apiOrigin = (process.env.TELEGRAM_API_ORIGIN || 'https://api.telegram.org').replace(/\/+$/, '');
const apiBase = () => `${apiOrigin}/bot${config.telegramToken}`;
const fileBase = () => `${apiOrigin}/file/bot${config.telegramToken}`;

async function telegram(method, body = {}) {
  const response = await fetch(`${apiBase()}/${method}`, { method: 'POST', signal: AbortSignal.timeout(method === 'getUpdates' ? 40000 : 15000), headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const payload = await response.json();
  if (!payload.ok) throw new Error(`Telegram ${method}: ${payload.description || response.status}`);
  return payload.result;
}

const send = (chatId, text, extra = {}) => telegram('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...extra });
async function sendTestOffer(chatId, userId, force = false) {
  const mock = config.testContour && !billingAvailable();
  const status = mock ? mockPaymentStatus(userId) : getBillingOffer(userId);
  if (status.trial?.eligible && (force || status.hasFirstRecipe)) {
    if (!force && !(mock ? claimMockOffer(userId) : recordBillingExposure(userId))) return;
    await send(chatId, '<b>Попробуйте 7 дней бесплатно</b>\n\nСохранение рецептов, подбор ужина и напоминания. Без карты и списаний. Затем 199 рублей в месяц; подписка оформляется отдельно.', { reply_markup: { inline_keyboard: [[{ text: 'Попробовать 7 дней бесплатно', web_app: { url: webAppUrl({ view: 'offer' }) } }]] } });
    return;
  }
  if (status.trial?.used && !status.active) {
    await send(chatId, 'Пробный период закончился. Сохранённые рецепты остаются в коллекции. ' + (status.available ? 'Оформите подписку, чтобы продолжить.' : 'Оплата пока подключается.'), { reply_markup: { inline_keyboard: [[{ text: 'Подписка и доступ', web_app: { url: webAppUrl({ view: 'offer' }) } }]] } });
    return;
  }
  if (!status.available) return;
  if (!status.hasFirstRecipe) {
    if (force) await send(chatId, `Сначала сохраните первый рецепт или приготовьте предложенный ужин. После этого откроется ${mock ? 'тестовое ' : ''}предложение.`);
    return;
  }
  if (status.active) {
    if (force) await send(chatId, `${mock ? 'Тестовый д' : 'Д'}оступ уже активен. Следующий рецепт можно сохранить без оплаты.`);
    return;
  }
  if (!force && !(mock ? claimMockOffer(userId) : recordBillingExposure(userId))) return;
  if (force) mock ? claimMockOffer(userId) : recordBillingExposure(userId);
  const lead = status.firstValue === 'cooked' ? 'Первый ужин приготовлен — теперь можно пополнить свою коллекцию.' : 'Первый рецепт готов — он останется в вашей коллекции.';
  const details = mock ? 'Это тестовый сценарий: деньги не списываются.' : `Оплата проходит на защищённой странице Robokassa.${status.recurringSupported ? ' Автопродление подключается только с отдельного согласия.' : ''}`;
  await send(chatId, `<b>${lead}</b>\n\nЧтобы сохранять следующие рецепты автоматически и пользоваться напоминаниями, оформите доступ за <b>${status.offer.priceRub} ₽ в месяц</b>. ${details}`, { reply_markup: { inline_keyboard: [[{ text: `Посмотреть предложение · ${status.offer.priceRub} ₽`, web_app: { url: webAppUrl({ view: 'offer' }) } }]] } });
}
function canUsePaidImport(userId) {
  if (config.testContour && !billingAvailable()) return canUseTestImport(userId);
  return canUseAutomaticImport(userId);
}
export function canUsePlaylistImport(userId) { return getSubscriptionAccess(userId).active; }
function currentDinnerIntake(userId) {
  const profile = getFoodProfile(userId);
  return normalizeDinnerIntake({ ...profile, maxMinutes: profile.preferredMaxCookingTime, availableIngredients: getDinnerContext(userId), requestedCategories: getDinnerRequestCategories(userId), mealRequest: getDinnerMealRequest(userId) });
}
function prepareDinner(userId) {
  try {
    const session = startDinner(userId, { prefetchOnly: true });
    if (!session.needsOnboarding) prefetchDinner(userId, session.sessionId);
    return session;
  } catch (error) {
    log('warn', 'telegram_dinner_prefetch_failed', { error: error.message });
    return null;
  }
}
async function sendDinnerEntry(chatId, userId, { skipOnboarding = false } = {}) {
  if (userId && !skipOnboarding && !getFoodProfile(userId).onboardingCompleted) {
    const pending = getPendingIntent(userId);
    if (['dinner-intake', 'dinner-confirm'].includes(pending?.kind)) await resumeDinnerIntake(chatId, userId, pending);
    else await sendDinnerProfilePrompt(chatId, userId);
    return;
  }
  if (userId) prepareDinner(userId);
}
let dinnerLaunchId = 0;
function dinnerWebAppMarkup() {
  const url = webAppUrl({ view: 'dinner', launch: `${Date.now().toString(36)}-${++dinnerLaunchId}` });
  return url ? { inline_keyboard: [[{ text: 'Открыть варианты ужина', web_app: { url } }]] } : { inline_keyboard: [] };
}
function dinnerPreparingMarkup() {
  return { inline_keyboard: [[{ text: 'Готовим рецепты', callback_data: 'dinner:preparing' }]] };
}
function dinnerUnavailableMarkup() {
  return { inline_keyboard: [[{ text: 'Рецепты пока не готовы', callback_data: 'dinner:unavailable' }]] };
}
async function revealDinnerButton(chatId, messageId, userId, sessionId) {
  if (!messageId || !sessionId) return;
  try {
    const dinner = await recommendDinner(userId, sessionId);
    await telegram('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: dinner.recommendations.length ? dinnerWebAppMarkup() : dinnerUnavailableMarkup() });
  } catch (error) {
    log('warn', 'telegram_dinner_open_button_reveal_failed', { error: error.message, userId });
    try { await telegram('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: dinnerUnavailableMarkup() }); }
    catch {}
  }
}
export async function sendDinnerProfilePrompt(chatId, userId) {
  await sendDinnerIntakePrompt(chatId, userId, { profileOnly: true });
}
async function sendDinnerIntakePrompt(chatId, userId, { profileOnly = false } = {}) {
  const pending = getPendingIntent(userId);
  const intake = pending?.intake || currentDinnerIntake(userId);
  setPendingIntent(userId, { kind: 'dinner-intake', intake, profileOnly });
  addDinnerEvent(userId, 'onboarding_started');
  if (profileOnly) {
    await send(chatId, '<b>Давай подберём ужин специально для тебя.</b>\n\n<b>Запишите голосовое сообщение</b>\nНажмите микрофон справа от поля ввода и за 30–60 секунд расскажите, на сколько человек готовим, есть ли дети, аллергия, сколько времени есть, какие блюда вы обычно любите и что хотите именно сегодня. Продукты дома можно назвать, если хотите.\n\nНапример: «На троих, с ребёнком, аллергия на орехи, до 30 минут. Любим пасту, не любим рыбу. Сегодня хотим азиатское с рисом».\n\nМожно ответить и текстом.');
    return;
  }
  await send(chatId, '<b>Подберём ужин из того, что есть дома.</b>\n\n<b>Запишите голосовое сообщение</b>\nНажмите микрофон справа от поля ввода и за 30–60 секунд назовите продукты. Добавьте, на сколько человек готовите, есть ли дети, аллергия, сколько времени есть, какие блюда обычно любите и что хотите именно сегодня.\n\nНапример: «Есть курица, рис, лук и морковь. На троих, с ребёнком, аллергия на орехи, до 30 минут. Сегодня хотим азиатское с рисом».\n\nМожно дополнять по частям — я запомню сказанное раньше.');
}

// Telegram may deliver both an unblock event and /start for the same tap.
const ENTRY_DEDUP_MS = 5000;
const recentDinnerEntries = new Map();
async function sendFirstDinnerEntry(chatId, userId, source) {
  const recent = recentDinnerEntries.get(userId);
  if (recent && recent.source !== source && Date.now() - recent.at < ENTRY_DEDUP_MS) return;
  await sendDinnerEntry(chatId, userId);
  const entry = { source, at: Date.now() };
  recentDinnerEntries.set(userId, entry);
  const pending = getPendingIntent(userId);
  if (['dinner-intake', 'dinner-confirm'].includes(pending?.kind)) setPendingIntent(userId, { ...pending, entrySentAt: entry.at, ...(source === 'unblocked' ? { unblockedAt: entry.at } : {}) });
  setTimeout(() => { if (recentDinnerEntries.get(userId) === entry) recentDinnerEntries.delete(userId); }, ENTRY_DEDUP_MS).unref();
}
async function resumeDinnerIntake(chatId, userId, pending, { unblocked = false } = {}) {
  if (!unblocked && pending?.unblockedAt && Date.now() - pending.unblockedAt < ENTRY_DEDUP_MS) return;
  if (unblocked && pending?.entrySentAt && Date.now() - pending.entrySentAt < ENTRY_DEDUP_MS) return;
  if (pending?.kind === 'dinner-confirm') await sendDinnerIntakeSummary(chatId, userId, pending.intake, pending);
  else await sendDinnerIntakePrompt(chatId, userId, { profileOnly: pending?.profileOnly || pending?.kind === 'dinner-onboarding-restart' });
  setPendingIntent(userId, { ...getPendingIntent(userId), entrySentAt: Date.now(), ...(unblocked ? { unblockedAt: Date.now() } : {}) });
}

async function sendDinnerIntakeSummary(chatId, userId, intake, { profileOnly = false } = {}) {
  if (!profileOnly && !intake.availableIngredients.length && !intake.mealRequest) { await send(chatId, 'Остальные ответы сохранил. Какие продукты есть дома? Можно написать или сказать голосом.'); return; }
  if (!intake.householdSize) {
    await send(chatId, `${intake.availableIngredients.length ? `Записал продукты: <b>${escapeHtml(intake.availableIngredients.join(', '))}</b>.\n` : ''}На сколько человек готовим?`, { reply_markup: { inline_keyboard: [[1, 2, 3, 4, 5].map((size) => ({ text: String(size), callback_data: `dinner:size:${size}` }))] } });
    return;
  }
  const categoryNames = Object.fromEntries(DINNER_CATEGORIES.map(([key, label]) => [key, label.toLocaleLowerCase('ru')]));
  const liked = Object.entries(intake.preferredCategories || {}).filter(([, value]) => value > 0).map(([key]) => categoryNames[key]).filter(Boolean);
  const disliked = Object.entries(intake.preferredCategories || {}).filter(([, value]) => value < 0).map(([key]) => categoryNames[key]).filter(Boolean);
  const requested = (intake.requestedCategories || []).map((key) => categoryNames[key]).filter(Boolean);
  for (const [dish, weight] of Object.entries(intake.dishPreferences || {})) (weight > 0 ? liked : disliked).push(dish);
  const lines = [
    '<b>Проверьте, правильно ли я понял</b>',
    ...(intake.availableIngredients.length ? [`Есть дома: ${escapeHtml(intake.availableIngredients.join(', '))}`] : []),
    `Готовим на: ${intake.householdSize}`,
    `Дети: ${intake.hasChildren === null ? 'не указано' : intake.hasChildren ? 'да' : 'нет'}`,
    `Аллергия и исключения: ${intake.excludedIngredients.length ? escapeHtml(intake.excludedIngredients.join(', ')) : 'не указаны'}`,
    `Время: ${intake.maxMinutes ? `до ${intake.maxMinutes} минут` : 'не указано'}`,
    `Сегодня обязательно: ${intake.mealRequest?.text ? escapeHtml(intake.mealRequest.text) : requested.length ? escapeHtml(requested.join(', ')) : 'не указано'}`,
    `Любим: ${liked.length ? escapeHtml(liked.join(', ')) : 'не указано'}`,
    `Не любим: ${disliked.length ? escapeHtml(disliked.join(', ')) : 'не указано'}`
  ];
  await send(chatId, lines.join('\n'), { reply_markup: { inline_keyboard: [[{ text: 'Верно · подобрать ужин', callback_data: 'dinner:confirm' }], [{ text: 'Дополнить или исправить', callback_data: 'dinner:redo' }]] } });
}

async function handleDinnerIntakeMessage(message, user, pending) {
  const text = message.text?.trim() || '';
  if (message.photo?.length || extractSharedUrl(text) || /^\/(?:save|find|search|help)(?:\s|$)/i.test(text)) { clearPendingIntent(user.id); return false; }
  if (text === '/skip') { await skipDinnerIntake(message.chat.id, user.id, pending); return true; }
  let transcript = text;
  if (message.voice || message.audio) {
    try { await telegram('sendChatAction', { chat_id: message.chat.id, action: 'typing' }); transcript = (await interpretVoice(message, user)).text; }
    catch (error) { await send(message.chat.id, `Не расслышал голосовое: ${escapeHtml(error.message)} Можно сказать ещё раз или написать текстом.`); return true; }
  }
  if (!transcript) return true;
  let extracted = null;
  try { extracted = await extractDinnerIntake({ userId: user.id, transcript, profileOnly: Boolean(pending.profileOnly) }); }
  catch (error) { log('warn', 'dinner_intake_fallback', { error: error.message, userId: user.id }); }
  const fallback = parseDinnerIntakeFallback(transcript, { bareCategoriesAsLikes: Boolean(pending.profileOnly) });
  const patch = combineDinnerIntakeExtraction(extracted, fallback);
  // In the profile conversation unknown words are not a list of food at home.
  if (pending.profileOnly && !extracted && !/(?:есть|дома|холодильник|продукт|остал)[^.!?\n]*\s/iu.test(transcript)) patch.availableIngredients = [];
  const intake = mergeDinnerIntake(pending.intake, patch);
  setPendingIntent(user.id, { kind: 'dinner-confirm', intake, profileOnly: Boolean(pending.profileOnly) });
  await sendDinnerIntakeSummary(message.chat.id, user.id, intake, pending);
  return true;
}

async function skipDinnerIntake(chatId, userId, pending) {
  if (pending.profileOnly) updateDinnerProfile(userId, { onboardingCompleted: true, tastePreferencesStatus: 'skipped' });
  else clearDinnerContext(userId);
  clearPendingIntent(userId);
  prepareDinner(userId);
}

export async function handleDinnerIntakeCallback(callback) {
  const data = String(callback.data || '');
  if (!/^dinner:(?:skip|redo|confirm|preparing|unavailable|size:[1-9])$/.test(data) || callback.message?.chat?.type !== 'private' || !callback.from || String(callback.from.id) !== String(callback.message.chat.id)) return false;
  const user = resolvePrivateTelegramUser(callback.from), chatId = callback.message.chat.id;
  if (['dinner:preparing', 'dinner:unavailable'].includes(data)) {
    await telegram('answerCallbackQuery', { callback_query_id: callback.id, text: data === 'dinner:preparing' ? 'Рецепты ещё готовятся' : 'Не удалось подготовить рецепты. Попробуйте ещё раз позже.' });
    return true;
  }
  const pending = getPendingIntent(user.id);
  if (!pending || !['dinner-intake', 'dinner-confirm'].includes(pending.kind)) {
    await telegram('answerCallbackQuery', { callback_query_id: callback.id, text: 'Этот список уже неактуален', show_alert: true });
    return true;
  }
  if (data === 'dinner:skip') {
    await telegram('answerCallbackQuery', { callback_query_id: callback.id });
    await skipDinnerIntake(chatId, user.id, pending);
    return true;
  }
  if (data === 'dinner:redo') {
    await telegram('answerCallbackQuery', { callback_query_id: callback.id });
    if (pending?.intake) await send(chatId, `Что добавить или исправить? Напишите или скажите голосом только изменения. ${pending.profileOnly ? 'Семью' : 'Продукты, семью'}, аллергию, время и вкусы, о которых вы уже сказали, сохраню.`);
    else await sendDinnerIntakePrompt(chatId, user.id);
    return true;
  }
  if (!pending || pending.kind !== 'dinner-confirm') {
    await telegram('answerCallbackQuery', { callback_query_id: callback.id, text: 'Этот список уже неактуален', show_alert: true });
    return true;
  }
  if (data.startsWith('dinner:size:')) {
    const intake = normalizeDinnerIntake({ ...pending.intake, householdSize: Number(data.at(-1)) });
    setPendingIntent(user.id, { ...pending, kind: 'dinner-confirm', intake });
    await telegram('answerCallbackQuery', { callback_query_id: callback.id });
    await sendDinnerIntakeSummary(chatId, user.id, intake, pending);
    return true;
  }
  if (!pending.profileOnly && !pending.intake.availableIngredients.length && !pending.intake.mealRequest) { await telegram('answerCallbackQuery', { callback_query_id: callback.id, text: 'Сначала назовите продукты или пожелание', show_alert: true }); return true; }
  if (!pending.intake.householdSize) { await telegram('answerCallbackQuery', { callback_query_id: callback.id, text: 'Сначала укажите число едоков', show_alert: true }); return true; }
  if (pending.profileOnly && !pending.intake.availableIngredients.length) {
    const intake = pending.intake;
    const current = getFoodProfile(user.id), hasTasteAnswers = Object.keys(intake.preferredCategories || {}).length > 0 || Object.keys(intake.dishPreferences || {}).length > 0;
    updateDinnerProfile(user.id, { householdType: intake.householdType, householdSize: intake.householdSize, hasChildren: intake.hasChildren, preferredMaxCookingTime: intake.maxMinutes, excludedIngredients: intake.excludedIngredients, preferredCategories: { ...current.preferredCategories, ...(intake.preferredCategories || {}) }, tastePreferencesStatus: current.tastePreferencesStatus === 'pending' ? hasTasteAnswers ? 'completed' : 'skipped' : current.tastePreferencesStatus, onboardingCompleted: true });
    updateDinnerProfile(user.id, { dishPreferences: { ...current.dishPreferences, ...intake.dishPreferences } });
    setDinnerContext(user.id, [], intake.requestedCategories || [], intake.mealRequest);
  } else confirmDinnerIntake(user.id, pending.intake);
  const dinnerSession = prepareDinner(user.id);
  clearPendingIntent(user.id);
  await telegram('answerCallbackQuery', { callback_query_id: callback.id, text: 'Ответы сохранены' });
  const replyMarkup = dinnerPreparingMarkup();
  let messageId = callback.message.message_id;
  try {
    await telegram('editMessageReplyMarkup', { chat_id: chatId, message_id: callback.message.message_id, reply_markup: replyMarkup });
  } catch (error) {
    log('warn', 'telegram_dinner_open_button_edit_failed', { error: error.message, userId: user.id });
    const message = await send(chatId, 'Ответы сохранены. Готовим рецепты.', { reply_markup: replyMarkup });
    messageId = message?.message_id;
  }
  const revealTask = revealDinnerButton(chatId, messageId, user.id, dinnerSession?.sessionId);
  if (config.dinnerLlmEnabled) void revealTask;
  else await revealTask;
  return true;
}
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (x) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[x]);
const number = (value) => new Intl.NumberFormat('ru-RU').format(Number(value) || 0);

function usageMessage(userId) {
  const usage = aiUsageSummary(userId);
  const { reservations, totals, recent } = usage;
  const lines = [
    '<b>Использование сервиса</b>',
    `Запросы сегодня: <b>${number(reservations.today)}</b>`,
    `Запросы всего: <b>${number(reservations.total)}</b>`,
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

export async function configureTelegramMenuButton() {
  const url = webAppUrl();
  if (!url) throw new Error('APP_URL is not configured for the Telegram menu button');
  await telegram('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Открыть приложение', web_app: { url } } });
}

export async function sendNotificationReminder(delivery) {
  const url = webAppUrl({ view: 'dinner', notification: delivery.id });
  if (!url) throw new Error('APP_URL is not configured for notifications');
  await send(delivery.telegramId, '<b>Пора выбрать, что приготовить</b>\n\nЯ подготовил три варианта с учётом твоих вкусов и ограничений.', {
    reply_markup: { inline_keyboard: [[{ text: 'Посмотреть подборку', web_app: { url } }]] }
  });
}

export async function sendNotificationRecipeLink(delivery, recipe) {
  const url = webAppUrl({ recipe: recipe.id });
  if (!url) throw new Error('APP_URL is not configured for notifications');
  await send(delivery.telegramId, `<b>Выбрано: ${escapeHtml(recipe.title)}</b>\n\nСсылка на рецепт — в кнопке ниже.`, {
    reply_markup: { inline_keyboard: [[{ text: 'Открыть рецепт', web_app: { url } }]] }
  });
}

export function detectIntent(text, { hasPhoto = false, hasUrl = false } = {}) {
  const value = String(text || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('ru');
  if (hasPhoto || hasUrl) return 'save';
  const save = /(?:^|\s)(?:\/?save|сохрани|сохранить|добавь|добавить|запиши|записать)(?:\s|$)/iu.test(value);
  const search = /(?:^|\s)(?:\/?(?:find|search)|найди|найти|покажи|подбери|подобрать|посоветуй|что\s+(?:мне\s+)?приготовить|что\s+сделать|хочу\s+приготовить)(?:\s|$|[?.!,])/iu.test(value);
  if (save && !search) return 'save';
  if (search && !save) return 'search';
  if (save && search) return 'ambiguous';
  if (value.length >= 80 && /(?:ингредиент|приготовлен|нареж|добав|смеш|ложк|\b\d+\s*(?:г|гр|мл|мин))/iu.test(value)) return 'save';
  return value.length < 80 ? 'search' : 'ambiguous';
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

function recipeButton(recipe, { groupMode = false } = {}) {
  if (groupMode) return undefined;
  const url = webAppUrl({ recipe: recipe.id });
  return url ? { inline_keyboard: [[{ text: 'Открыть рецепт', web_app: { url } }]] } : undefined;
}

async function sendRecipeCard(chatId, recipe, options = {}) {
  const caption = `<b>${escapeHtml(recipe.title)}</b>${recipe.sourceName ? `\n${escapeHtml(recipe.sourceName)}` : ''}`;
  const reply_markup = recipeButton(recipe, options);
  const photo = recipe.thumbnailUrl?.startsWith('/assets/dinner/') && config.appUrl ? new URL(recipe.thumbnailUrl, config.appUrl).toString() : recipe.thumbnailUrl;
  if (photo) {
    try { await telegram('sendPhoto', { chat_id: chatId, photo, caption, parse_mode: 'HTML', reply_markup }); return; }
    catch (error) { log('warn', 'telegram_preview_failed', { error, recipeId: recipe.id }); }
  }
  await send(chatId, `${caption}\n<i>У источника нет доступного превью.</i>`, { reply_markup });
}

async function sendSearchResults(chatId, user, query, { groupMode = false } = {}) {
  const normalizedQuery = String(query).replace(/^\/?(?:find|search|найди|найти|покажи|подбери|подобрать|посоветуй)(?:\s+|$)/iu, '').trim();
  if (!normalizedQuery) { await send(chatId, 'Напишите, что хотите приготовить. Например: «Найди ужин с курицей».'); return []; }
  if (!groupMode) {
    await send(chatId, `Подбираю рецепт по запросу «<b>${escapeHtml(normalizedQuery)}</b>»…`);
    try {
      const result = await resolveRecipeRequest(user.id, normalizedQuery);
      if (result.kind === 'existing') {
        await send(chatId, 'Нашёл подходящий готовый рецепт.');
        await sendRecipeCard(chatId, result.recipe);
        return [result.recipe];
      }
      await sendSuggestion(chatId, result.suggestion, { userId: user.id });
    } catch (error) {
      log('error', 'telegram_requested_recipe_failed', { error, userId: user.id });
      await send(chatId, `Не получилось составить рецепт: ${escapeHtml(error.message)}`);
    }
    return [];
  }
  const results = searchRecipes(user.id, normalizedQuery).filter((recipe) => recipe.status === 'ready').slice(0, 8);
  if (!results.length) {
    const offerId = createSearchOffer(user.id, normalizedQuery);
    await send(chatId, `В ${groupMode ? 'коллекции владельца группы' : 'вашей коллекции'} ничего подходящего для «<b>${escapeHtml(normalizedQuery)}</b>» нет. Создать новый рецепт по этому запросу или поискать ещё?${groupMode ? '\nВыбрать может только владелец коллекции.' : ''}`, { reply_markup: { inline_keyboard: [[{ text: 'Создать новый рецепт', callback_data: `offer:create:${offerId}` }], [{ text: 'Поищу ещё', callback_data: `offer:skip:${offerId}` }]] } });
    return [];
  }
  const allUrl = groupMode ? null : webAppUrl({ view: 'results', q: normalizedQuery });
  await send(chatId, `Как понял: ищу ${groupMode ? 'в коллекции владельца группы' : 'в вашей коллекции'} «<b>${escapeHtml(normalizedQuery)}</b>».\nНашёл: ${results.length}.`, allUrl ? { reply_markup: { inline_keyboard: [[{ text: 'Все результаты', web_app: { url: allUrl } }]] } } : {});
  for (const recipe of results.slice(0, 3)) await sendRecipeCard(chatId, recipe, { groupMode });
  return results;
}

async function sendSuggestion(chatId, suggestion, { groupMode = false, userId = null } = {}) {
  const recipe = suggestion.recipe;
  const ingredients = recipe.ingredients.map((item) => `• ${[item.quantity, item.unit, item.name || item.raw].filter((x) => x !== null && x !== '' && x !== undefined).join(' ')}`).join('\n');
  const steps = recipe.steps.map((item, index) => `${index + 1}. ${item.text}`).join('\n');
  const detail = `${recipe.title}\nСоздано в «Рецептах»${recipe.description ? `\n${recipe.description}` : ''}\n\nИнгредиенты\n${ingredients}\n\nПриготовление\n${steps}${recipe.warnings?.length ? `\n\nОбратите внимание\n${recipe.warnings.join('\n')}` : ''}`;
  const buttons = { inline_keyboard: [[{ text: 'Добавить в мои рецепты', callback_data: `suggest:save:${suggestion.id}` }], [{ text: 'Не добавлять', callback_data: `suggest:skip:${suggestion.id}` }]] };
  const sent = await send(chatId, `${escapeHtml(detail.slice(0, 3300))}\n\nДобавить этот рецепт в коллекцию?${groupMode ? ' Подтвердить может только владелец коллекции.' : ''}`, { reply_markup: buttons });
  if (!groupMode && userId) setPendingIntent(userId, { kind: 'recipe-suggestion', suggestionId: suggestion.id, messageId: sent?.message_id || null });
}

function clearMatchingSuggestionIntent(userId, suggestionId) {
  const pending = getPendingIntent(userId);
  if (pending?.kind === 'recipe-suggestion' && pending.suggestionId === suggestionId) clearPendingIntent(userId);
}

async function removeSuggestionButtons(chatId, messageId, userId) {
  if (!messageId) return;
  try {
    await telegram('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } });
  } catch (error) {
    log('warn', 'telegram_suggestion_buttons_remove_failed', { error: error.message, userId, chatId, messageId });
  }
}

export async function handleSuggestionCallback(callback) {
  const match = String(callback.data || '').match(/^(suggest|offer):(save|skip|create):([0-9a-f-]{36})$/i);
  if (!match || !callback.message?.chat || !callback.from) return;
  const chat = callback.message.chat;
  const groupMode = ['group', 'supergroup'].includes(chat.type);
  const owner = groupMode ? getActiveTelegramGroup(chat.id) : resolvePrivateTelegramUser(callback.from);
  if (!owner || (groupMode && String(owner.telegram_id) !== String(callback.from.id))) {
    await telegram('answerCallbackQuery', { callback_query_id: callback.id, text: 'Выбрать может только владелец коллекции', show_alert: true });
    return;
  }
  const userId = groupMode ? owner.owner_user_id : owner.id;
  const proposal = match[1] === 'offer' ? getSearchOffer(userId, match[3]) : getRecipeSuggestion(userId, match[3]);
  if (!proposal) {
    await telegram('answerCallbackQuery', { callback_query_id: callback.id, text: 'Предложение больше недоступно', show_alert: true });
    return;
  }
  if (match[2] === 'skip') {
    clearMatchingSuggestionIntent(userId, match[3]);
    await telegram('answerCallbackQuery', { callback_query_id: callback.id, text: 'Рецепт не добавлен' });
    await telegram('editMessageReplyMarkup', { chat_id: chat.id, message_id: callback.message.message_id, reply_markup: { inline_keyboard: [] } });
    if (match[1] === 'offer') await send(chat.id, 'Напишите другой запрос — поищу ещё в коллекции.');
    return;
  }
  if (match[1] === 'offer' && match[2] === 'create') {
    await telegram('answerCallbackQuery', { callback_query_id: callback.id, text: 'Составляю рецепт' });
    await telegram('editMessageReplyMarkup', { chat_id: chat.id, message_id: callback.message.message_id, reply_markup: { inline_keyboard: [] } });
    await send(chat.id, 'Составляю рецепт по вашему запросу…');
    try {
      const suggestion = await suggestForEmptySearch(userId, proposal.query);
      await sendSuggestion(chat.id, suggestion, { groupMode, userId });
    } catch (error) {
      log('error', 'telegram_suggestion_failed', { error, userId });
      await send(chat.id, `Не получилось составить рецепт: ${escapeHtml(error.message)}`);
    }
    return;
  }
  try { assertSuggestionCurrent(userId, getRecipeSuggestion(userId, match[3])); }
  catch (error) { await telegram('answerCallbackQuery', { callback_query_id: callback.id, text: error.message, show_alert: true }); return; }
  const savedRecipe = saveRecipeSuggestion(userId, match[3]);
  if (!savedRecipe) { await telegram('answerCallbackQuery', { callback_query_id: callback.id, text: 'Предложение больше недоступно', show_alert: true }); return; }
  clearMatchingSuggestionIntent(userId, match[3]);
  await telegram('answerCallbackQuery', { callback_query_id: callback.id, text: 'Рецепт добавлен' });
  void ensureRecipeImage(userId, savedRecipe);
  const recipe = savedRecipe;
  await telegram('editMessageReplyMarkup', { chat_id: chat.id, message_id: callback.message.message_id, reply_markup: { inline_keyboard: [] } });
  await send(chat.id, `Сохранено: <b>${escapeHtml(recipe.title)}</b>. Рецепт теперь в ${groupMode ? 'коллекции владельца группы' : 'вашей коллекции'}.`, { reply_markup: recipeButton(recipe, { groupMode }) });
  if (!groupMode) await sendTestOffer(chat.id, userId);
}

async function finishImport(chatId, outcome, options = {}) {
  if (outcome.state === 'processing') { await send(chatId, 'Этот источник уже обрабатывается. Новую задачу не создаю.'); return; }
  const recipe = outcome.recipe;
  if (outcome.state === 'existing') { await send(chatId, `Этот рецепт уже есть: <b>${escapeHtml(recipe.title)}</b>.`, { reply_markup: recipeButton(recipe, options) }); return; }
  await send(chatId, `Сохранено: <b>${escapeHtml(recipe.title)}</b>. Рецепт уже появился ${options.groupMode ? 'в коллекции владельца группы' : 'в вашей коллекции'}.`, { reply_markup: recipeButton(recipe, options) });
}

async function saveContent(message, user, content, options = {}) {
  const chatId = message.chat.id;
  const playlist = content.url ? youtubePlaylist(content.url) : null;
  if (playlist && !canUsePlaylistImport(user.id)) {
    await send(chatId, 'Импорт плейлистов доступен только с активной подпиской или премиум-доступом к боту.');
    await sendTestOffer(chatId, user.id, true);
    return;
  }
  if (!canUsePaidImport(user.id)) { await sendTestOffer(chatId, user.id, true); return; }
  if (playlist) {
    await send(chatId, 'Получено. Обрабатываю до 30 роликов из плейлиста. Результат отправлю сюда; чат можно закрыть.');
    void (async () => {
      try {
        const outcome = await importYoutubePlaylist(user.id, playlist.url);
        const failed = outcome.failed.length;
        const lines = [
          '<b>Плейлист обработан.</b>', '',
          `Роликов: <b>${outcome.total}</b>. Сохранено: <b>${outcome.created}</b>. Уже было в коллекции: <b>${outcome.existing}</b>.`,
          ...(outcome.processing ? [`Уже обрабатывалось: <b>${outcome.processing}</b>.`] : []),
          ...(failed ? [`Не удалось распознать: <b>${failed}</b>.`] : []),
          ...(outcome.truncated ? ['Обработаны первые 30 роликов из плейлиста.'] : []),
          ...outcome.failed.slice(0, 5).map(item => `Не обработано: ${escapeHtml(item.title)} — ${escapeHtml(item.message)}`)
        ];
        const url = !options.groupMode && webAppUrl({ view: 'collection' });
        await send(chatId, lines.join('\n'), url ? { reply_markup: { inline_keyboard: [[{ text: 'Открыть коллекцию', web_app: { url } }]] } } : {});
      } catch (error) {
        log('error', 'telegram_playlist_import_failed', { error, userId: user.id });
        try { await send(chatId, `Не получилось обработать плейлист: ${escapeHtml(error.message || 'источник временно недоступен')}`); }
        catch (sendError) { log('error', 'telegram_playlist_error_message_failed', { error: sendError, userId: user.id }); }
      }
    })();
    return true;
  }
  await send(chatId, 'Получено. Извлекаю рецепт — статус уже сохранён, можно закрыть чат.');
  let outcome;
  if (message.photo?.length) {
    const photo = message.photo.at(-1);
    const { buffer } = await downloadTelegramFile(photo.file_id, config.maxUploadBytes);
    outcome = await importText(user.id, message.caption || '', { sourceType: 'image', sourceName: 'Фото из Telegram', label: 'Фото из Telegram', sourceKey: `telegram-photo:${photo.file_unique_id || photo.file_id}`, image: { buffer, mime: 'image/jpeg' } });
  } else if (content.url) outcome = await importUrl(user.id, content.url);
  else outcome = await importText(user.id, content.text, { sourceType: content.sourceType || 'text', sourceName: content.sourceType === 'audio' ? 'Ваше голосовое' : 'Сообщение в Telegram', label: content.sourceType === 'audio' ? 'Ваше голосовое' : 'Текстовый рецепт', sourceKey: content.sourceKey });
  await finishImport(chatId, outcome, options);
  if (!options.groupMode && outcome.state === 'created') await sendTestOffer(chatId, user.id);
  return true;
}

function restoreAfterRecipeSave(userId, pending) {
  if (pending.resumeIntent) setPendingIntent(userId, pending.resumeIntent);
  else clearPendingIntent(userId);
}

function suggestionTextDecision(text) {
  const answer = String(text || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('ru').replace(/[.!?]+$/, '');
  if (/^(?:да|ага|угу|давай|добавь|добавить|сохрани|сохранить|да,? (?:добавь|добавить|сохрани|сохранить))$/iu.test(answer)) return 'save';
  if (/^(?:нет|не надо|не нужно|не хочу|не добавляй|не добавлять|не сохраняй|не сохранять|нет,? (?:не надо|не добавляй|не добавлять|не сохраняй|не сохранять)|отмена|отменить|пропусти)$/iu.test(answer)) return 'skip';
  return null;
}

async function handleSuggestionTextChoice(message, user, pending) {
  const decision = suggestionTextDecision(message.text);
  if (!decision) return false;
  const suggestion = getRecipeSuggestion(user.id, pending.suggestionId);
  clearPendingIntent(user.id);
  await removeSuggestionButtons(message.chat.id, pending.messageId, user.id);
  if (!suggestion) {
    await send(message.chat.id, 'Предложение больше недоступно. Напишите, какой рецепт хотите найти.');
    return true;
  }
  if (decision === 'skip') {
    await send(message.chat.id, 'Рецепт не добавлен.');
    return true;
  }
  try { assertSuggestionCurrent(user.id, getRecipeSuggestion(user.id, pending.suggestionId)); }
  catch (error) { await send(message.chat.id, error.message); return true; }
  const savedRecipe = saveRecipeSuggestion(user.id, pending.suggestionId);
  if (!savedRecipe) {
    await send(message.chat.id, 'Предложение больше недоступно. Напишите, какой рецепт хотите найти.');
    return true;
  }
  void ensureRecipeImage(user.id, savedRecipe);
  await send(message.chat.id, `Сохранено: <b>${escapeHtml(savedRecipe.title)}</b>. Рецепт теперь в вашей коллекции.`, { reply_markup: recipeButton(savedRecipe) });
  await sendTestOffer(message.chat.id, user.id);
  return true;
}

async function handlePendingChoice(message, user, pending) {
  if (pending.kind === 'recipe-suggestion') return handleSuggestionTextChoice(message, user, pending);
  const answer = String(message.text || '').trim();
  if (/^(?:найти|ищи|поиск|в коллекции)[.!]?$/iu.test(answer)) {
    clearPendingIntent(user.id); await sendSearchResults(message.chat.id, user, pending.text); return true;
  }
  if (/^(?:сохранить|сохрани|добавить|добавь)[.!]?$/iu.test(answer)) {
    clearPendingIntent(user.id); await saveContent(message, user, pending); return true;
  }
  return false;
}

export async function handleMessage(message) {
  if (!message.from || message.from.is_bot) return;
  if (['group', 'supergroup'].includes(message.chat?.type)) { await handleGroupMessage(message); return; }
  if (message.chat?.type !== 'private') return;
  const chatId = message.chat.id;
  const user = resolvePrivateTelegramUser(message.from);
  const text = message.text?.trim() || message.caption?.trim() || '';
  if (config.testContour && text === '/test_reset') {
    await send(chatId, '<b>Сбросить тестового пользователя?</b>\n\nУдалятся рецепты, анкета, история ужинов и результат имитации оплаты в этом тестовом боте. Учёт AI-запросов сохранится.', { reply_markup: { inline_keyboard: [[{ text: 'Да, сбросить', callback_data: 'test:reset:confirm' }], [{ text: 'Отмена', callback_data: 'test:reset:cancel' }]] } });
    return;
  }
  if (text === '/offer') { await sendTestOffer(chatId, user.id, true); return; }
  if (text === '/privacy' || text === '/terms') { await send(chatId, `${text === '/privacy' ? 'Как обрабатываются ваши данные' : 'Условия закрытого теста'}: ${config.appUrl}/${text.slice(1)}.html`); return; }
  if (text.startsWith('/start')) {
    const isFirstStart = !user.is_allowed;
    let pending = getPendingIntent(user.id);
    if (/^\/start(?:@[A-Za-z0-9_]+)?\s+save(?:\s|$)/i.test(text)) {
      if (isFirstStart) allowUser(user.id);
      if (pending?.kind !== 'recipe-save') setPendingIntent(user.id, { kind: 'recipe-save', resumeIntent: pending });
      await send(chatId, '<b>Сохранить рецепт</b>\n\nПришлите ссылку, фото, текст рецепта или продиктуйте его голосом. Я добавлю его в вашу коллекцию.\n\n/cancel — отменить и вернуться к предыдущему действию.');
      return;
    }
    if (pending?.kind === 'recipe-save') {
      restoreAfterRecipeSave(user.id, pending);
      pending = getPendingIntent(user.id);
    }
    const resumeOnboarding = ['dinner-onboarding-restart', 'dinner-intake', 'dinner-confirm'].includes(pending?.kind);
    if (isFirstStart) allowUser(user.id);
    if (/^\/start(?:@[A-Za-z0-9_]+)?\s+group_access(?:\s|$)/i.test(text)) {
      await send(chatId, '<b>Групповой доступ</b>\n\nДобавьте «Твои рецепты» максимум в три группы, чтобы вместе искать блюда, сохранять рецепты из ссылок, фото и сообщений и быстрее решать, что приготовить.\n\nСейчас доступ подключается вручную. Если вы участвуете в тесте, попросите владельца сервиса включить его для вашего Telegram-аккаунта.');
      return;
    }
    if (/^\/start(?:@[A-Za-z0-9_]+)?\s+ingredients(?:\s|$)/i.test(text)) { await sendDinnerIntakePrompt(chatId, user.id); return; }
    if (resumeOnboarding) {
      await resumeDinnerIntake(chatId, user.id, pending);
      return;
    }
    if (isFirstStart) { await sendFirstDinnerEntry(chatId, user.id, 'start'); return; }
    const recentEntry = recentDinnerEntries.get(user.id);
    if (recentEntry?.source === 'unblocked' && Date.now() - recentEntry.at < ENTRY_DEDUP_MS) return;
    await sendDinnerEntry(chatId, user.id);
    await sendTestOffer(chatId, user.id);
    return;
  }
  if (!user.is_allowed) { await send(chatId, 'Нажмите Start — код или пароль не нужен.'); return; }
  const saveEntry = getPendingIntent(user.id);
  if (saveEntry?.kind === 'recipe-save' && text === '/cancel') {
    restoreAfterRecipeSave(user.id, saveEntry);
    await send(chatId, 'Сохранение отменено. Предыдущие ответы сохранены.');
    return;
  }
  if (saveEntry?.kind === 'recipe-save' && (text === '/dinner' || text === '/ingredients')) restoreAfterRecipeSave(user.id, saveEntry);
  if (text === '/ingredients') { await sendDinnerIntakePrompt(chatId, user.id); return; }
  if (text === '/dinner') { await sendDinnerEntry(chatId, user.id); return; }
  if (text === '/help') { await send(chatId, 'Короткий текст ищу в вашей коллекции. Подробный текст с ингредиентами и шагами, ссылку или фото сохраняю как рецепт. С активным доступом можно отправить публичный плейлист YouTube — обработаю до 30 роликов. Можно явно написать «Сохрани рецепт: …» или «Найди …». Если в сообщении есть и просьба найти, и просьба сохранить, я уточню цель.'); return; }
  if (text === '/usage') { await send(chatId, usageMessage(user.id)); return; }
  if (text === '/delete_data CONFIRM') { deleteUserData(user.id); await send(chatId, 'Ваши рецепты и профиль удалены.'); return; }
  if (text.startsWith('/delete_recipe ')) { archiveRecipe(user.id, text.slice(15)); await send(chatId, 'Рецепт убран из библиотеки.'); return; }

  const pending = getPendingIntent(user.id);
  const savingRecipe = pending?.kind === 'recipe-save';
  if (pending && ['dinner-intake', 'dinner-confirm'].includes(pending.kind) && await handleDinnerIntakeMessage(message, user, pending)) return;
  if (pending && !savingRecipe && await handlePendingChoice(message, user, pending)) return;
  if (pending && !savingRecipe) clearPendingIntent(user.id);

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
  const isDinnerFollowup = /^(?:кстати(?=\s|[,.!]|$)|забыл(?:а)?\s+(?:сказать|упомянуть)|ещ[её]\s+есть|у\s+нас\s+(?:есть\s+)?(?:дети|реб[её]нок)|есть\s+реб[её]нок|детей\s+нет|аллерги[яи]\s|на\s+(?:двоих|троих|четверых|\d+)\s*(?:человек)?[,.! ]*$|(?:сегодня|на\s+сегодня|на\s+ужин)(?=\s|[,.!]|$)|хоч(?:у|ем|ется)(?=\s|[,.!]|$)|давай(?:те)?\s+приготов)/iu.test(content.text.trim());
  if (!savingRecipe && !message.photo?.length && !content.url && isDinnerFollowup && (getDinnerContext(user.id).length || getFoodProfile(user.id).onboardingCompleted)) {
    await handleDinnerIntakeMessage({ chat: message.chat, from: message.from, text: content.text }, user, { kind: 'dinner-intake', intake: currentDinnerIntake(user.id), profileOnly: !getDinnerContext(user.id).length });
    return;
  }
  if (savingRecipe && !content.text && !message.photo?.length) { await send(chatId, 'Пришлите ссылку, фото, текст или голосовое с рецептом. Для отмены — /cancel.'); return; }
  const intent = savingRecipe ? 'save' : detectIntent(content.text, { hasPhoto: Boolean(message.photo?.length), hasUrl: Boolean(content.url) });
  if (intent === 'search') { await sendSearchResults(chatId, user, content.text); return; }
  if (intent === 'save') {
    try { if (await saveContent(message, user, content) && savingRecipe) restoreAfterRecipeSave(user.id, pending); }
    catch (error) { log('error', 'telegram_import_failed', { error, userId: user.id }); await send(chatId, `Не получилось сохранить: ${escapeHtml(error.message)}\n\nМожно прислать текст или скриншот рецепта.`); }
    return;
  }
  setPendingIntent(user.id, content);
  await send(chatId, 'Найти в вашей коллекции или сохранить ваш рецепт? Ответьте «найти» или «сохранить».');
}

function normalizeGroupCommand(text) {
  return String(text || '').replace(/^\/(start|help|find|search|save)(?:@[A-Za-z0-9_]+)?(?=\s|$)/i, '/$1').trim();
}

async function leaveRejectedGroup(chatId, text, extra = {}) {
  try { await send(chatId, text, extra); }
  catch (error) { log('warn', 'telegram_group_rejection_message_failed', { error, chatId }); }
  try { await telegram('leaveChat', { chat_id: chatId }); }
  catch (error) { log('error', 'telegram_group_leave_failed', { error, chatId }); }
}

export async function handleMyChatMember(change) {
  const chat = change?.chat;
  if (chat?.type === 'private') {
    // Opening a chat is not a Bot API event. Unblocking is, and can resume intake.
    if (change.old_chat_member?.status !== 'kicked' || change.new_chat_member?.status !== 'member' || !change.from || change.from.is_bot || String(change.from.id) !== String(chat.id)) return;
    const user = resolvePrivateTelegramUser(change.from);
    if (!user.is_allowed) allowUser(user.id);
    const pending = getPendingIntent(user.id);
    if (['dinner-onboarding-restart', 'dinner-intake', 'dinner-confirm'].includes(pending?.kind)) {
      await resumeDinnerIntake(chat.id, user.id, pending, { unblocked: true });
    } else await sendFirstDinnerEntry(chat.id, user.id, 'unblocked');
    return;
  }
  if (!chat || !['group', 'supergroup'].includes(chat.type)) return;
  const oldStatus = change.old_chat_member?.status;
  const newStatus = change.new_chat_member?.status;
  const wasActive = ['member', 'administrator'].includes(oldStatus);
  const isActive = ['member', 'administrator'].includes(newStatus);
  if (wasActive && !isActive) { deactivateTelegramGroup(chat.id); return; }
  if (!isActive || wasActive || !change.from) return;

  const inviter = upsertTelegramUser(change.from);
  const activation = activateTelegramGroup(inviter.id, chat);
  if (activation.state === 'forbidden') {
    await leaveRejectedGroup(chat.id, '<b>Групповой доступ пока не подключён</b>\n\nС ним можно добавить «Твои рецепты» в три группы и вместе:\n• искать блюда в коллекции;\n• сохранять рецепты из ссылок, фото и сообщений;\n• быстро решать, что приготовить.\n\n<a href="https://recipes.spas-sky.ru/groups.html">Посмотрите, как работает групповой доступ</a>. А из этой группы я пока выйду.', {
      reply_markup: { inline_keyboard: [[{ text: 'Посмотреть возможности', url: 'https://recipes.spas-sky.ru/groups.html' }]] }
    });
    return;
  }
  if (activation.state === 'limit') {
    await leaveRejectedGroup(chat.id, `<b>Все ${GROUP_LIMIT} места уже заняты</b>\n\nЧтобы подключить эту группу, удалите бота из одной из действующих групп — место освободится автоматически. А отсюда я пока выйду.`);
    return;
  }
  await send(chat.id, `Готово! Группа подключена (${activation.count || GROUP_LIMIT - 2}/${GROUP_LIMIT}). Я работаю с коллекцией <b>${escapeHtml(inviter.display_name)}</b>.\n\nИскать: <code>/find курица</code>\nСохранить: <code>/save текст рецепта</code>\nТакже можно ответить на моё сообщение обычной фразой.`);
}

async function handleGroupMessage(message) {
  const chatId = message.chat.id;
  const binding = getActiveTelegramGroup(chatId);
  if (!binding) return;
  if (!binding.group_access) {
    deactivateTelegramGroup(chatId);
    await leaveRejectedGroup(chatId, 'Право владельца на использование бота в группах отключено. Бот сейчас выйдет из группы.');
    return;
  }
  const owner = getUserById(binding.owner_user_id);
  if (!owner) { deactivateTelegramGroup(chatId); await leaveRejectedGroup(chatId, 'Подключение группы больше не действует. Бот сейчас выйдет из группы.'); return; }
  const rawText = message.text?.trim() || message.caption?.trim() || '';
  if (!rawText && !message.photo?.length && !message.voice && !message.audio) return;
  const text = normalizeGroupCommand(rawText);
  if (text === '/start' || text === '/help') {
    await send(chatId, 'Я ищу рецепты в коллекции владельца группы и сохраняю туда новые. Используйте <code>/find запрос</code> или <code>/save рецепт</code>. Можно также ответить на моё сообщение обычной фразой.');
    return;
  }
  if (/^\/(?:usage|delete)/i.test(text)) { await send(chatId, 'Эта команда доступна только в личном чате с ботом.'); return; }

  let content = { text, sourceType: 'text', sourceKey: undefined, url: extractSharedUrl(text) };
  if (message.voice || message.audio) {
    try {
      await telegram('sendChatAction', { chat_id: chatId, action: 'typing' });
      content = { ...(await interpretVoice(message, owner)), sourceType: 'audio', url: null };
    } catch (error) {
      log('error', 'telegram_group_voice_failed', { error, userId: owner.id, chatId });
      await send(chatId, escapeHtml(error.message || 'Не удалось обработать голосовое. Пришлите его ещё раз или напишите текстом.'));
      return;
    }
  }
  const intent = detectIntent(content.text, { hasPhoto: Boolean(message.photo?.length), hasUrl: Boolean(content.url) });
  if (intent === 'search') { await sendSearchResults(chatId, owner, content.text, { groupMode: true }); return; }
  if (intent === 'save') {
    try { await saveContent(message, owner, content, { groupMode: true }); }
    catch (error) { log('error', 'telegram_group_import_failed', { error, userId: owner.id, chatId }); await send(chatId, `Не получилось сохранить: ${escapeHtml(error.message)}\n\nМожно прислать текст или скриншот рецепта.`); }
    return;
  }
  await send(chatId, 'Не понял цель. Для поиска напишите <code>/find запрос</code>, для сохранения — <code>/save рецепт</code>.');
}

let running = false;
export async function startTelegramPolling() {
  if (running || !config.telegramToken) return;
  if (config.testContour) {
    const bot = await telegram('getMe');
    if (bot.username?.toLowerCase() !== config.testBotUsername.toLowerCase()) throw new Error('Unexpected bot token for test contour');
  }
  await configureTelegramMenuButton();
  running = true; let offset = 0;
  log('info', 'telegram_polling_started');
  while (running) {
    try {
      const updates = await telegram('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'my_chat_member', 'callback_query'] });
      for (const update of updates) {
        offset = Math.max(offset, update.update_id + 1);
        if ((!update.message && !update.my_chat_member && !update.callback_query) || !claimUpdate(update.update_id)) continue;
        try {
          if (update.my_chat_member) await handleMyChatMember(update.my_chat_member);
          else if (update.callback_query) {
            if (!await handleTestResetCallback(update.callback_query) && !await handleDinnerIntakeCallback(update.callback_query)) await handleSuggestionCallback(update.callback_query);
          }
          else await handleMessage(update.message);
          completeUpdate(update.update_id);
        }
        catch (error) { failUpdate(update.update_id); log('error', 'telegram_update_failed', { error, updateId: update.update_id }); }
      }
    } catch (error) { log('error', 'telegram_polling_error', { error }); await new Promise((resolve) => setTimeout(resolve, 3000)); }
  }
}
export function stopTelegramPolling() { running = false; }

export async function handleTestResetCallback(callback) {
  if (!config.testContour || !callback.data?.startsWith('test:reset:')) return false;
  if (callback.message?.chat?.type !== 'private' || String(callback.message.chat.id) !== String(callback.from.id)) return false;
  await telegram('answerCallbackQuery', { callback_query_id: callback.id });
  if (callback.data === 'test:reset:confirm') {
    resetTestUser(callback.from.id);
    await send(callback.message.chat.id, 'Тестовый профиль сброшен. Нажмите /start, чтобы пройти путь нового пользователя.');
  } else if (callback.data === 'test:reset:cancel') await send(callback.message.chat.id, 'Сброс отменён.');
  return true;
}
