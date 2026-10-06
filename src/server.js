import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { buildWebDocument, acceptsGzip } from './web-document.js';
import { config } from './config.js';
import { platformLegalDocument } from './platform-legal.js';
import { archiveRecipe, createDinnerRecipeShare, createRecipeShare, deleteUserData, getRecipe, getRecipeImage, getRecipeSuggestion, getSharedRecipe, getSharedRecipeImage, getSuggestionImage, listImportJobs, listRecipes, saveRecipeSuggestion, searchRecipes, updateRecipe, resolvePrivateTelegramUser } from './db.js';
import { importTextWithAccess as importText, importUrlWithAccess as importUrl, importYoutubePlaylist } from './importer.js';
import { resolveRecipeRequest, suggestForEmptySearch, assertSuggestionCurrent } from './suggestions.js';
import { validateTelegramInitData } from './security.js';
import { validateMaxInitData, verifyMaxWebhookSecret } from './max-auth.js';
import { callbackDestination, jwsRoutingParameters } from './payment-routing.js';
import { enqueueMaxUpdate } from './max-events.js';
import { log } from './log.js';
import { ensureRecipeImage, ensureSuggestionImage } from './recipe-images.js';
import { transcribeAudio } from './openai.js';
import { getDinnerContext, getFoodProfile, getDinnerOptionImage, addDinnerEvent } from './dinner-store.js';
import { pantryCoverage, SEED_RECIPES } from './dinner.js';
import { changeDinnerRequest, decideDinner, finishDinner, getDinnerRecipe, nextDinner, prefetchDinner, recommendDinner, rejectDinnerBatch, replaceDinner, setDinnerRejectionReason, startDinner, startDinnerOnboarding, updateDinnerProfile } from './dinner-service.js';
import { cancelMockAutoRenew, claimMockOffer, createMockOrder, finishMockOrder, mockPaymentStatus, resetTestUser } from './contour-sandbox.js';
import { getNotificationSchedule, markChoiceFailed, markChoiceSent, saveNotificationSchedule } from './notification-store.js';
import { openNotificationDinner, selectNotificationDinner } from './notifications.js';
import { sendNotificationRecipeLink, sendFeedbackNotification } from './telegram.js';
import { submitFeedback, restoreFeedbackConversation } from './feedback.js';
import { billingAvailable, cancelAutoRenew, createPaymentOrder, getBillingOffer, getPaymentOrder, paymentRedirectDocument, paymentReturnDocument, processRobokassaResult, processRobokassaResultJws, recordBillingExposure } from './billing.js';
import { promoQuote, redeemFreePromo } from './promos.js';
import { getSubscriptionAccess, startTrial, getTrialStatus, requireRecipeEntry } from './subscriptions.js';
import { youtubePlaylist } from './youtube.js';
import { ensureNutrition } from './nutrition-service.js';
import { advertisingRedirect, campaignLink, createCampaign, setCampaignStats } from './funnel.js';
import { recordCampaignPriceExposure } from './campaign-prices.js';
import { mergeMaxFunnelReport, maxFunnelSnapshot, maxFunnelAuthorized } from './max-funnel.js';
import { MAX_AD_PLACEMENT } from './max-acquisition.js';
import { openDashboardSession, closeDashboardSession, dashboardSessionValid } from './funnel-auth.js';
import { directImportStatus, syncDirectCampaigns, dashboardFunnelReport } from './yandex-direct.js';
import { recordLandingHtmlLoad, recordLandingView, landingRedirect, landingReport } from './landing-funnel.js';

const publicDir = path.resolve('public');
const mimeTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon' };
const rate = new Map();
let webDocument;

function securityHeaders(response, scriptHashes = '') {
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('referrer-policy', 'no-referrer');
  response.setHeader('permissions-policy', 'camera=(), microphone=(self), geolocation=()');
  const sdkOrigin = config.botPlatform === 'max' ? 'https://st.max.ru' : 'https://telegram.org';
  const frameOrigins = config.botPlatform === 'max' ? 'https://max.ru https://web.max.ru https://*.max.ru' : 'https://web.telegram.org https://*.telegram.org';
  response.setHeader('content-security-policy', `default-src 'self'; script-src 'self' ${sdkOrigin} ${scriptHashes}; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; frame-ancestors ${frameOrigins}`);
}
function json(response, status, value) {
  securityHeaders(response); response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(JSON.stringify(value));
}
async function bodyJson(request, maxBytes = Math.ceil(config.maxUploadBytes * 4 / 3) + 100_000) {
  const chunks = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > maxBytes) throw Object.assign(new Error('Запрос слишком большой'), { status: 413 }); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw Object.assign(new Error('Неверный JSON'), { status: 400 }); }
}
async function bodyText(request, maxBytes = 16_000) {
  const chunks = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > maxBytes) throw Object.assign(new Error('Запрос слишком большой'), { status: 413 }); chunks.push(chunk); }
  return Buffer.concat(chunks).toString('utf8');
}
async function relayRobokassaResult(destination, body, params, contentType = 'application/x-www-form-urlencoded; charset=utf-8') {
  const response = await fetch(destination, {
    method: 'POST',
    headers: { 'content-type': contentType },
    redirect: 'error',
    body,
    signal: AbortSignal.timeout(5000)
  });
  const acknowledgement = (await response.text()).trim();
  const invId = Number(params.InvId ?? params.invid ?? params.INVID);
  if (!response.ok || !Number.isSafeInteger(invId) || acknowledgement !== `OK${invId}`) throw Object.assign(new Error('Callback платежа не подтверждён'), { status: 502 });
  return acknowledgement;
}
function htmlResponse(response, status, document, { paymentForm = false } = {}) {
  securityHeaders(response);
  if (paymentForm) response.setHeader('content-security-policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; form-action https://auth.robokassa.ru; base-uri 'none'");
  else response.setHeader('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'");
  response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  response.end(document);
}
function rateLimit(key, limit = 90, windowMs = 60_000) {
  const current = rate.get(key), now = Date.now();
  if (!current || current.reset < now) { rate.set(key, { count: 1, reset: now + windowMs }); return; }
  current.count += 1;
  if (current.count > limit) throw Object.assign(new Error('Слишком много запросов'), { status: 429 });
}
export function clientIp(request, trustProxy = config.trustProxy) {
  const remote = String(request.socket?.remoteAddress || '').trim();
  if (!trustProxy) return remote || 'unknown';
  const realIp = String(request.headers?.['x-real-ip'] || '').trim();
  const forwarded = String(request.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  if (net.isIP(realIp)) return realIp;
  if (net.isIP(forwarded)) return forwarded;
  return remote || 'unknown';
}
function authenticate(request) {
  const header = request.headers.authorization || '';
  const scheme = config.botPlatform === 'max' ? 'mxa ' : 'tma ';
  if (!header.startsWith(scheme)) throw Object.assign(new Error(`Откройте приложение из ${config.botPlatform === 'max' ? 'MAX' : 'Telegram'}`), { status: 401 });
  const telegramUser = config.botPlatform === 'max' ? validateMaxInitData(header.slice(4), config.maxToken) : validateTelegramInitData(header.slice(4), config.telegramToken);
  request.telegramUser = telegramUser;
  const user = resolvePrivateTelegramUser(telegramUser);
  if (!user.is_allowed) throw Object.assign(new Error('Вернитесь в чат бота и нажмите Start'), { status: 403 });
  rateLimit(`user:${user.id}`);
  return user;
}
function cleanRecipeInput(input, existing = {}) {
  const title = String(input.title ?? existing.title ?? '').trim().slice(0, 180);
  if (!title) throw Object.assign(new Error('Нужно название'), { status: 400 });
  const strings = (value, max = 100) => Array.isArray(value) ? value.slice(0, max).map((x) => String(x).trim()).filter(Boolean) : [];
  const ingredients = Array.isArray(input.ingredients) ? input.ingredients.slice(0, 100).map((x) => typeof x === 'string' ? { raw: x.slice(0, 400), name: x.slice(0, 180), quantity: null, unit: null, comment: null, confidence: 1 } : { raw: String(x.raw || x.name || '').slice(0, 400), name: String(x.name || x.raw || '').slice(0, 180), quantity: Number.isFinite(Number(x.quantity)) ? Number(x.quantity) : null, unit: x.unit ? String(x.unit).slice(0, 40) : null, comment: x.comment ? String(x.comment).slice(0, 180) : null, confidence: Math.max(0, Math.min(1, Number(x.confidence ?? 1))) }) : existing.ingredients || [];
  const steps = Array.isArray(input.steps) ? input.steps.slice(0, 100).map((x, i) => ({ position: i + 1, text: String(typeof x === 'string' ? x : x.text || '').trim().slice(0, 1200), confidence: Math.max(0, Math.min(1, Number(x.confidence ?? 1))) })).filter((x) => x.text) : existing.steps || [];
  return { title, description: String(input.description ?? existing.description ?? '').slice(0, 2000), servings: input.servings === null || input.servings === '' ? null : Math.max(1, Math.min(100, Number(input.servings ?? existing.servings) || 1)), prepMinutes: input.prepMinutes === null || input.prepMinutes === '' ? null : Math.max(0, Math.min(2880, Number(input.prepMinutes ?? existing.prepMinutes) || 0)), cookMinutes: input.cookMinutes === null || input.cookMinutes === '' ? null : Math.max(0, Math.min(2880, Number(input.cookMinutes ?? existing.cookMinutes) || 0)), ingredients, steps, tags: input.tags ? strings(input.tags, 20).map((x) => x.slice(0, 50)) : existing.tags || [], warnings: input.warnings ? strings(input.warnings, 20).map((x) => x.slice(0, 300)) : existing.warnings || [], notes: String(input.notes ?? existing.notes ?? '').slice(0, 3000), sourceUrl: input.sourceUrl ?? existing.sourceUrl ?? null, sourceName: input.sourceName ?? existing.sourceName ?? null, status: ['draft','ready'].includes(input.status) ? input.status : existing.status || 'draft' };
}
function detectedImageMime(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))) return 'image/png';
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
}

async function api(request, response, url) {
  const user = authenticate(request);
  if (request.method === 'POST' && url.pathname === '/api/feedback') {
    const input = await bodyJson(request, 16000);
    const result = await submitFeedback(user.id, request.telegramUser, { ...input, source: 'app' }, sendFeedbackNotification);
    restoreFeedbackConversation(user.id);
    return json(response, 201, result);
  }
  if (request.method === 'POST' && url.pathname === '/api/billing/promo/quote') {
    const input = await bodyJson(request, 1000);
    return json(response, 200, promoQuote(user.id, input.code, input.periodMonths ?? 1));
  }
  if (request.method === 'POST' && url.pathname === '/api/billing/promo/redeem') {
    const input = await bodyJson(request, 1000);
    const redemption = redeemFreePromo(user.id, input.code, new Date(), input.periodMonths ?? 1);
    return json(response, 200, { ...redemption, payment: config.testContour && !billingAvailable() ? mockPaymentStatus(user.id) : getBillingOffer(user.id) });
  }
  if (request.method === 'POST' && url.pathname === '/api/billing/trial') {
    const used = getTrialStatus(user.id).used;
    const trial = startTrial(user.id);
    if (!used && trial.active) addDinnerEvent(user.id, 'trial_started', { detail: { source: 'app' } });
    return json(response, 200, config.testContour && !billingAvailable() ? mockPaymentStatus(user.id) : getBillingOffer(user.id));
  }
  if (request.method === 'GET' && url.pathname === '/api/billing/offer') {
    if (config.testContour && !billingAvailable()) return json(response, 200, mockPaymentStatus(user.id));
    return json(response, 200, getBillingOffer(user.id));
  }
  if (request.method === 'POST' && url.pathname === '/api/billing/exposure') {
    const input = await bodyJson(request, 1000);
    if (input.campaign === true) recordCampaignPriceExposure(user.id);
    if (config.testContour && !billingAvailable()) return json(response, 200, { recorded: claimMockOffer(user.id) });
    return json(response, 200, { recorded: recordBillingExposure(user.id) });
  }
  if (request.method === 'POST' && url.pathname === '/api/billing/orders') {
    const input = await bodyJson(request, 1000);
    if (config.testContour && !billingAvailable()) return json(response, 201, { ...createMockOrder(user.id, input.method || 'card', Boolean(input.autoRenew), input.promoCode, input.periodMonths), mode: 'mock' });
    return json(response, 201, { ...createPaymentOrder(user.id, { autoRenew: input.autoRenew === true, consentVersion: input.consentVersion, promoCode: input.promoCode, periodMonths: input.periodMonths }), mode: 'provider' });
  }
  const billingOrder = url.pathname.match(/^\/api\/billing\/orders\/([0-9a-f-]{36})$/i);
  if (request.method === 'GET' && billingOrder) return json(response, 200, getPaymentOrder(user.id, billingOrder[1]));
  const billingResult = url.pathname.match(/^\/api\/billing\/orders\/([0-9a-f-]{36})\/result$/i);
  if (request.method === 'POST' && billingResult && config.testContour && !billingAvailable()) {
    const input = await bodyJson(request, 1000);
    return json(response, 200, finishMockOrder(user.id, billingResult[1], input.result));
  }
  if (request.method === 'POST' && url.pathname === '/api/billing/auto-renew/cancel') {
    if (config.testContour && !billingAvailable()) return json(response, 200, cancelMockAutoRenew(user.id));
    return json(response, 200, cancelAutoRenew(user.id));
  }
  if (url.pathname.startsWith('/api/test/')) {
    if (!config.testContour) return json(response, 404, { error: 'Не найдено' });
    if (request.method === 'GET' && url.pathname === '/api/test/payment') return json(response, 200, mockPaymentStatus(user.id));
    if (request.method === 'POST' && url.pathname === '/api/test/orders') {
      const input = await bodyJson(request, 1000);
      return json(response, 201, createMockOrder(user.id, input.method));
    }
    const orderResult = url.pathname.match(/^\/api\/test\/orders\/([0-9a-f-]{36})\/result$/i);
    if (request.method === 'POST' && orderResult) {
      const input = await bodyJson(request, 1000);
      return json(response, 200, finishMockOrder(user.id, orderResult[1], input.result));
    }
    if (request.method === 'POST' && url.pathname === '/api/test/reset') {
      resetTestUser(user.telegram_id);
      return json(response, 200, { reset: true });
    }
    return json(response, 404, { error: 'Не найдено' });
  }
  if (request.method === 'GET' && url.pathname === '/api/me') {
    const botUsername = config.botPlatform === 'max' ? config.maxBotUsername : config.testContour ? config.testBotUsername : 'Recipeboibot';
    return json(response, 200, { id: user.id, displayName: user.display_name, username: user.username, testContour: config.testContour, platform: config.botPlatform, botUsername, botUrl: `${config.botPlatform === 'max' ? 'https://max.ru' : 'https://t.me'}/${botUsername}` });
  }
  if (request.method === 'GET' && url.pathname === '/api/notifications/schedule') return json(response, 200, getNotificationSchedule(user.id));
  if (request.method === 'PUT' && url.pathname === '/api/notifications/schedule') return json(response, 200, saveNotificationSchedule(user.id, await bodyJson(request, 2000)));
  const notificationAction = url.pathname.match(/^\/api\/notifications\/([0-9a-f-]{36})\/(open|select)$/i);
  if (request.method === 'POST' && notificationAction) {
    const [, id, action] = notificationAction;
    if (action === 'open') return json(response, 200, openNotificationDinner(user.id, id));
    const input = await bodyJson(request, 1000);
    const selected = selectNotificationDinner(user.id, id, String(input.recommendationId || ''));
    let telegramSent = Boolean(selected.delivery.choiceSentAt);
    if (!telegramSent) {
      try {
        await sendNotificationRecipeLink(selected.delivery, selected.recipe);
        markChoiceSent(id);
        telegramSent = true;
      } catch (error) {
        markChoiceFailed(id);
        log('warn', 'notification_choice_immediate_send_failed', { error, deliveryId: id });
      }
    }
    return json(response, 200, { status: selected.status, sessionId: selected.delivery.sessionId, recipe: selected.recipe, savedRecipe: selected.savedRecipe || null, telegramSent });
  }
  if (request.method === 'GET' && url.pathname === '/api/recipes') return json(response, 200, listRecipes(user.id));
  if (request.method === 'GET' && url.pathname === '/api/library') return json(response, 200, { recipes: listRecipes(user.id), jobs: listImportJobs(user.id) });
  if (request.method === 'GET' && url.pathname === '/api/dinner/profile') return json(response, 200, getFoodProfile(user.id));
  if (request.method === 'GET' && url.pathname.startsWith('/api/dinner/recipes/')) {
    const recipe = await ensureNutrition(user.id, getDinnerRecipe(user.id, decodeURIComponent(url.pathname.slice('/api/dinner/recipes/'.length))));
    return json(response, recipe ? 200 : 404, recipe ? { ...recipe, pantryMatch: pantryCoverage(recipe, getDinnerContext(user.id)) } : { error: 'Рецепт не найден' });
  }
  const dinnerShare = url.pathname.match(/^\/api\/dinner\/recipes\/([^/]+)\/share$/);
  if (request.method === 'POST' && dinnerShare) {
    const key = decodeURIComponent(dinnerShare[1]);
    const recipe = await ensureNutrition(user.id, getDinnerRecipe(user.id, key));
    const image = key.startsWith('dinner:') ? getDinnerOptionImage(key.slice(7)) : null;
    const token = recipe ? createDinnerRecipeShare(user.id, key, recipe, image) : null;
    return token ? json(response, 200, { token, path: `/share/${token}` }) : json(response, 404, { error: 'Рецепт не найден' });
  }
  if (request.method === 'PUT' && url.pathname === '/api/dinner/profile') return json(response, 200, updateDinnerProfile(user.id, await bodyJson(request, 4000)));
  if (request.method === 'POST' && url.pathname === '/api/dinner/open') return json(response, 200, startDinner(user.id));
  if (request.method === 'PUT' && url.pathname === '/api/dinner/request') return json(response, 200, await changeDinnerRequest(user.id, (await bodyJson(request, 4000)).query));
  if (request.method === 'POST' && url.pathname === '/api/dinner/onboarding/start') {
    const input = await bodyJson(request, 1000);
    return json(response, 200, startDinnerOnboarding(user.id, String(input.sessionId || '')));
  }
  if (request.method === 'POST' && url.pathname === '/api/dinner/recommend') {
    rateLimit(`dinner:${user.id}`, 12, 60_000);
    const input = await bodyJson(request, 1000);
    return json(response, 200, await recommendDinner(user.id, String(input.sessionId || '')));
  }
  if (request.method === 'POST' && url.pathname === '/api/dinner/reject-batch') {
    const input = await bodyJson(request, 2000);
    return json(response, 200, rejectDinnerBatch(user.id, input.ids));
  }
  if (request.method === 'POST' && url.pathname === '/api/dinner/next') {
    rateLimit(`dinner:${user.id}`, 12, 60_000);
    const input = await bodyJson(request, 2000);
    return json(response, 200, await nextDinner(user.id, input.ids));
  }
  if (request.method === 'POST' && url.pathname === '/api/dinner/prefetch') {
    const input = await bodyJson(request, 1000);
    return json(response, 200, prefetchDinner(user.id, String(input.sessionId || '')));
  }
  const dinnerAction = url.pathname.match(/^\/api\/dinner\/recommendations\/([0-9a-f-]{36})\/(accept|reject|reason|replace|cooked)$/i);
  if (request.method === 'POST' && dinnerAction) {
    const [, id, action] = dinnerAction;
    if (action === 'accept' || action === 'reject') return json(response, 200, decideDinner(user.id, id, action === 'accept' ? 'accepted' : 'rejected'));
    if (action === 'cooked') return json(response, 200, finishDinner(user.id, id));
    const input = await bodyJson(request, 1000);
    if (action === 'replace') {
      rateLimit(`dinner:${user.id}`, 12, 60_000);
      return json(response, 200, await replaceDinner(user.id, id, input.reason));
    }
    return json(response, 200, setDinnerRejectionReason(user.id, id, input.reason, input));
  }
  if (request.method === 'GET' && url.pathname === '/api/search') {
    const q = (url.searchParams.get('q') || '').slice(0,500);
    if (!q.trim()) return json(response, 200, listRecipes(user.id));
    return json(response, 200, searchRecipes(user.id, q).filter((recipe) => recipe.status === 'ready'));
  }
  if (request.method === 'POST' && url.pathname === '/api/recipe-request') {
    rateLimit(`ai:${user.id}`, 8, 60_000);
    const input = await bodyJson(request, 2000);
    return json(response, 200, await resolveRecipeRequest(user.id, input.query));
  }
  if (request.method === 'POST' && url.pathname === '/api/recipe-request/transcribe') {
    requireRecipeEntry(user.id);
    rateLimit(`ai:${user.id}`, 8, 60_000);
    const input = await bodyJson(request, 2_900_000);
    const mime = String(input.mime || '').split(';')[0].toLowerCase();
    if (!['audio/webm', 'audio/mp4', 'audio/ogg'].includes(mime)) throw Object.assign(new Error('Этот формат записи не поддерживается'), { status: 415 });
    if (typeof input.value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.value)) throw Object.assign(new Error('Запись не получена'), { status: 400 });
    const buffer = Buffer.from(input.value, 'base64');
    if (!buffer.length || buffer.length > 2 * 1024 * 1024) throw Object.assign(new Error('Запись должна быть короче или меньше 2 МБ'), { status: 413 });
    const filename = `request.${mime === 'audio/mp4' ? 'm4a' : mime === 'audio/ogg' ? 'ogg' : 'webm'}`;
    const text = String(await transcribeAudio({ userId: user.id, buffer, mime, filename }) || '').trim();
    if (!text) throw Object.assign(new Error('Не расслышал пожелание. Попробуйте ещё раз или напишите его.'), { status: 422 });
    return json(response, 200, { text: text.slice(0, 500) });
  }
  if (request.method === 'GET' && /^\/api\/suggestions\/[0-9a-f-]{36}$/i.test(url.pathname)) {
    const suggestion = getRecipeSuggestion(user.id, url.pathname.split('/').at(-1));
    if (suggestion) suggestion.recipe = await ensureNutrition(user.id, suggestion.recipe);
    return json(response, suggestion ? 200 : 404, suggestion || { error: 'Рецепт не найден' });
  }
  if (request.method === 'POST' && url.pathname === '/api/suggestions') {
    rateLimit(`ai:${user.id}`, 8, 60_000);
    const input = await bodyJson(request, 2000);
    return json(response, 200, await suggestForEmptySearch(user.id, input.query));
  }
  if (request.method === 'POST' && /^\/api\/suggestions\/[0-9a-f-]{36}\/save$/i.test(url.pathname)) {
    const suggestionId = url.pathname.split('/').at(-2);
    const suggestion = getRecipeSuggestion(user.id, suggestionId);
    if (!suggestion) return json(response, 404, { error: 'Предложение больше недоступно' });
    assertSuggestionCurrent(user.id, suggestion);
    const recipe = saveRecipeSuggestion(user.id, suggestionId);
    if (!recipe) return json(response, 404, { error: 'Предложение больше недоступно' });
    if (suggestion?.query.startsWith('request:')) void ensureSuggestionImage(user.id, suggestion).then(() => ensureRecipeImage(user.id, getRecipe(user.id, recipe.id)));
    else void ensureRecipeImage(user.id, recipe);
    return json(response, 200, recipe);
  }
  if (request.method === 'GET' && /^\/api\/recipes\/[^/]+$/.test(url.pathname)) {
    const recipe = await ensureNutrition(user.id, getRecipe(user.id, decodeURIComponent(url.pathname.split('/').at(-1))));
    return recipe ? json(response, 200, recipe) : json(response, 404, { error: 'Рецепт не найден' });
  }
  if (request.method === 'POST' && /^\/api\/recipes\/[^/]+\/share$/.test(url.pathname)) {
    const id = decodeURIComponent(url.pathname.split('/').at(-2));
    const recipe = getRecipe(user.id, id);
    if (!recipe) return json(response, 404, { error: 'Рецепт не найден' });
    await ensureNutrition(user.id, recipe);
    const token = createRecipeShare(user.id, id);
    return token ? json(response, 200, { token, path: `/share/${token}` }) : json(response, 404, { error: 'Рецепт не найден' });
  }
  if (request.method === 'POST' && url.pathname === '/api/import') {
    rateLimit(`ai:${user.id}`, 8, 60_000); const input = await bodyJson(request);
    let outcome;
    if (input.kind === 'url') {
      const value = String(input.value || '');
      const playlist = youtubePlaylist(value);
      if (playlist && !getSubscriptionAccess(user.id).active) return json(response, 402, { error: 'Импорт плейлистов доступен только с активной подпиской или премиум-доступом к боту', offerPath: '/?view=offer' });
      if (playlist) {
        void importYoutubePlaylist(user.id, playlist.url).catch(error => log('error', 'api_playlist_import_failed', { error, userId: user.id }));
        return json(response, 202, { state: 'playlist', accepted: true, limit: 30 });
      }
      outcome = await importUrl(user.id, value);
    }
    if (input.kind === 'image') {
      if (!/^image\/(jpeg|png|webp)$/.test(input.mime || '')) throw Object.assign(new Error('Разрешены JPEG, PNG и WEBP'), { status: 415 });
      const buffer = Buffer.from(String(input.value || ''), 'base64'); if (!buffer.length || buffer.length > config.maxUploadBytes) throw Object.assign(new Error('Изображение слишком большое'), { status: 413 });
      const detectedMime = detectedImageMime(buffer); if (!detectedMime || detectedMime !== input.mime) throw Object.assign(new Error('Содержимое файла не совпадает с форматом изображения'), { status: 415 });
      outcome = await importText(user.id, String(input.caption || ''), { sourceType: 'image', sourceName: 'Фото из Mini App', image: { buffer, mime: detectedMime } });
    }
    if (!outcome) outcome = await importText(user.id, String(input.value || ''), { sourceType: 'text', sourceName: 'Текст из Mini App' });
    return json(response, outcome.state === 'created' ? 201 : outcome.state === 'processing' ? 202 : 200, outcome);
  }
  if (request.method === 'PUT' && /^\/api\/recipes\/[^/]+$/.test(url.pathname)) {
    const id = decodeURIComponent(url.pathname.split('/').at(-1)), existing = getRecipe(user.id, id);
    if (!existing) return json(response, 404, { error: 'Рецепт не найден' });
    const input = cleanRecipeInput(await bodyJson(request), existing);
    const changed = input.servings !== existing.servings || JSON.stringify(input.ingredients) !== JSON.stringify(existing.ingredients) || JSON.stringify(input.steps) !== JSON.stringify(existing.steps);
    const enriched = await ensureNutrition(user.id, { ...existing, ...input, nutrition: changed ? null : existing.nutrition });
    return json(response, 200, updateRecipe(user.id, id, { ...input, nutrition: enriched.nutrition }));
  }
  if (request.method === 'DELETE' && /^\/api\/recipes\/[^/]+$/.test(url.pathname)) return json(response, archiveRecipe(user.id, decodeURIComponent(url.pathname.split('/').at(-1))) ? 204 : 404, {});
  if (request.method === 'DELETE' && url.pathname === '/api/account') { deleteUserData(user.id); return json(response, 204, {}); }
  return json(response, 404, { error: 'Не найдено' });
}

function serveStatic(request, response, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  if (requested === '/index.html') {
    webDocument ??= buildWebDocument(publicDir, { botPlatform: config.botPlatform, botUsername: config.botPlatform === 'max' ? config.maxBotUsername : config.testContour ? config.testBotUsername : undefined });
    const compressed = acceptsGzip(request.headers['accept-encoding']);
    const bytes = compressed ? webDocument.gzip : webDocument.bytes;
    recordLandingHtmlLoad({ method: request.method, userAgent: request.headers['user-agent'] || '', purpose: `${request.headers.purpose || ''} ${request.headers['sec-purpose'] || ''}` });
    securityHeaders(response, webDocument.scriptHashes);
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'vary': 'Accept-Encoding', 'content-length': bytes.length, ...(compressed ? { 'content-encoding': 'gzip' } : {}) });
    response.end(request.method === 'HEAD' ? undefined : bytes);
    return true;
  }
  const file = path.resolve(publicDir, `.${requested}`);
  if (!file.startsWith(publicDir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  if (config.botPlatform === 'max' && ['/privacy.html', '/terms.html', '/offer.html'].includes(requested)) {
    const document = platformLegalDocument(fs.readFileSync(file, 'utf8'), config);
    securityHeaders(response); response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); response.end(request.method === 'HEAD' ? undefined : document); return true;
  }
  securityHeaders(response); response.writeHead(200, { 'content-type': mimeTypes[path.extname(file)] || 'application/octet-stream', 'cache-control': requested === '/dashboard.html' ? 'no-store' : requested === '/index.html' ? 'no-cache' : 'public, max-age=3600' }); fs.createReadStream(file).pipe(response); return true;
}

export function createServer() {
  return http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    try {
      const robokassaResult = url.pathname === '/api/payments/robokassa/result' && ['GET', 'POST'].includes(request.method);
      if (url.pathname === '/api/max/webhook') {
        if (config.botPlatform !== 'max') return json(response, 404, { error: 'Не найдено' });
        if (request.method !== 'POST') return json(response, 405, { error: 'Метод не поддерживается' });
        if (!verifyMaxWebhookSecret(request.headers['x-max-bot-api-secret'], config.maxWebhookSecret)) return json(response, 401, { error: 'Неверная подпись webhook' });
        const update = await bodyJson(request, 256000);
        enqueueMaxUpdate(update);
        return json(response, 200, { ok: true });
      }
      rateLimit(`${robokassaResult ? 'payment' : 'ip'}:${clientIp(request)}`, robokassaResult ? 600 : 90);
      if (url.pathname === '/api/internal/max-funnel') {
        if (request.method !== 'GET' || config.botPlatform !== 'max' || !maxFunnelAuthorized(request.headers.authorization)) return json(response, 404, { error: 'Не найдено' });
        return json(response, 200, maxFunnelSnapshot());
      }
      if (url.pathname === '/healthz') return json(response, 200, { ok: true, service: 'recipeboibot', platform: config.botPlatform });
      if (url.pathname === '/dashboard' || url.pathname === '/dashboard/') return serveStatic(request, response, '/dashboard.html');
      if (url.pathname.startsWith('/api/dashboard/')) {
        const cookie = String(request.headers.cookie || '').split(';').map(value => value.trim()).find(value => value.startsWith('funnel_session='))?.slice(15);
        if (request.method !== 'GET') {
          if (request.headers['x-funnel-request'] !== '1' || (request.headers.origin && new URL(request.headers.origin).host !== request.headers.host)) return json(response, 403, { error: 'Запрос отклонён' });
        }
        const sessionCookie = token => `funnel_session=${token}; HttpOnly; SameSite=Strict; Path=/api/dashboard; Max-Age=${token ? 604800 : 0}${config.production ? '; Secure' : ''}`;
        if (request.method === 'POST' && url.pathname === '/api/dashboard/login') {
          rateLimit(`dashboard-login:${clientIp(request)}`, 5, 15 * 60000);
          const input = await bodyJson(request, 1000);
          const token = openDashboardSession(input.password);
          response.setHeader('set-cookie', sessionCookie(token));
          return json(response, 200, { ok: true });
        }
        if (!dashboardSessionValid(cookie)) return json(response, 401, { error: 'Войдите в дашборд' });
        if (request.method === 'POST' && url.pathname === '/api/dashboard/logout') {
          closeDashboardSession(cookie); response.setHeader('set-cookie', sessionCookie(''));
          return json(response, 200, { ok: true });
        }
        if (request.method === 'GET' && url.pathname === '/api/dashboard/funnel') {
          const report = await mergeMaxFunnelReport(dashboardFunnelReport(url.searchParams.get('campaign') || 'all'));
          report.landingStats = report.campaign?.slug === MAX_AD_PLACEMENT ? null : landingReport(report.campaign?.slug || 'all');
          return json(response, 200, report);
        }
        if (request.method === 'POST' && url.pathname === '/api/dashboard/direct-sync') {
          if (config.testContour || config.dashboardPreview) return json(response, 403, { error: 'Импорт Директа доступен в основном дашборде' });
          rateLimit('direct-sync', 2, 60000);
          const input = await bodyJson(request, 2000);
          return json(response, 200, await syncDirectCampaigns(input.campaign || config.yandexDirectPlacement));
        }
        if (request.method === 'POST' && url.pathname === '/api/dashboard/campaigns') {
          const input = await bodyJson(request, 2000), campaign = createCampaign(input.slug, input.name);
          return json(response, 201, { ...campaign, link: campaignLink(campaign.slug) });
        }
        if (request.method === 'PUT' && url.pathname === '/api/dashboard/stats') {
          const input = await bodyJson(request, 2000);
          if (directImportStatus(input.slug)) return json(response, 409, { error: 'Это размещение обновляется автоматически из Директа' });
          setCampaignStats(input.slug, input.impressions, input.reach ?? null);
          return json(response, 200, { ok: true });
        }
        return json(response, 404, { error: 'Не найдено' });
      }
      if (url.pathname === '/api/landing/view') {
        if (request.method !== 'POST') return json(response, 405, { error: 'Метод не поддерживается' });
        if (request.headers['x-landing-request'] !== '1' || (request.headers.origin && new URL(request.headers.origin).host !== request.headers.host)) return json(response, 403, { error: 'Запрос отклонён' });
        const input = await bodyJson(request, 6000);
        return json(response, 200, recordLandingView(input, { userAgent: request.headers['user-agent'] || '', purpose: `${request.headers.purpose || ''} ${request.headers['sec-purpose'] || ''}` }));
      }
      if (url.pathname.startsWith('/landing/go/')) {
        const location = landingRedirect(url.pathname.slice(12), { method: request.method, userAgent: request.headers['user-agent'] || '', purpose: `${request.headers.purpose || ''} ${request.headers['sec-purpose'] || ''}` });
        securityHeaders(response); response.writeHead(302, { location, 'cache-control': 'no-store' });
        return response.end();
      }
      if (url.pathname.startsWith('/go/')) {
        const location = advertisingRedirect(url.pathname.slice(4), { method: request.method, userAgent: request.headers['user-agent'] || '', purpose: `${request.headers.purpose || ''} ${request.headers['sec-purpose'] || ''}`, searchParams: url.searchParams });
        securityHeaders(response);
        response.writeHead(302, { location, 'cache-control': 'no-store' });
        return response.end();
      }
      if (url.pathname === '/readyz') {
        const billingReady = !config.billingRequired || billingAvailable();
        return json(response, billingReady ? 200 : 503, {
          ok: billingReady,
          service: 'recipeboibot',
          platform: config.botPlatform,
          billing: { required: config.billingRequired, configured: billingAvailable() }
        });
      }
      if (robokassaResult) {
        let acknowledgement;
        if (request.method === 'POST') {
          const body = await bodyText(request);
          if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(body.trim())) {
            const params = jwsRoutingParameters(body);
            const destination = callbackDestination(params, config, { jws: true });
            acknowledgement = destination ? await relayRobokassaResult(destination, body, params, 'application/jose') : processRobokassaResultJws(body);
          }
          else {
            const params = Object.fromEntries(new URLSearchParams(body));
            const destination = callbackDestination(params, config);
            acknowledgement = destination ? await relayRobokassaResult(destination, body, params) : processRobokassaResult(params);
          }
        } else {
          const params = Object.fromEntries(url.searchParams);
          const destination = callbackDestination(params, config);
          acknowledgement = destination ? await relayRobokassaResult(destination, url.searchParams.toString(), params) : processRobokassaResult(params);
        }
        securityHeaders(response);
        response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        return response.end(acknowledgement);
      }
      const paymentStart = url.pathname.match(/^\/payment\/start\/([0-9a-f-]{36})$/i);
      if (request.method === 'GET' && paymentStart) return htmlResponse(response, 200, paymentRedirectDocument(paymentStart[1]), { paymentForm: true });
      if (request.method === 'GET' && url.pathname === '/payment/success') return htmlResponse(response, 200, paymentReturnDocument('success', url.searchParams.get('order')));
      if (request.method === 'GET' && url.pathname === '/payment/fail') return htmlResponse(response, 200, paymentReturnDocument('fail', url.searchParams.get('order')));
      if (request.method === 'GET' && /^\/dinner-images\/[0-9a-f-]{36}$/i.test(url.pathname)) {
        const image = getDinnerOptionImage(url.pathname.split('/').at(-1));
        if (!image) return json(response, 404, { error: 'Изображение недоступно' });
        securityHeaders(response);
        response.writeHead(200, { 'content-type': image.mime, 'content-length': image.bytes.length, 'cache-control': 'public, max-age=86400' });
        return response.end(image.bytes);
      }
      if (request.method === 'GET' && /^\/recipe-images\/[0-9a-f-]{36}$/i.test(url.pathname)) {
        const image = getRecipeImage(url.pathname.split('/').at(-1));
        if (!image) return json(response, 404, { error: 'Изображение недоступно' });
        securityHeaders(response);
        response.writeHead(200, { 'content-type': image.mime, 'content-length': image.bytes.length, 'cache-control': 'public, max-age=86400' });
        return response.end(image.bytes);
      }
      if (request.method === 'GET' && /^\/shared-recipe-images\/[A-Za-z0-9_-]{32}$/.test(url.pathname)) {
        const image = getSharedRecipeImage(url.pathname.split('/').at(-1));
        if (!image) return json(response, 404, { error: 'Изображение недоступно' });
        securityHeaders(response);
        response.writeHead(200, { 'content-type': image.mime, 'content-length': image.bytes.length, 'cache-control': 'public, max-age=86400' });
        return response.end(image.bytes);
      }
      if (request.method === 'GET' && /^\/suggestion-images\/[0-9a-f-]{36}$/i.test(url.pathname)) {
        const image = getSuggestionImage(url.pathname.split('/').at(-1));
        if (!image) return json(response, 404, { error: 'Изображение недоступно' });
        securityHeaders(response);
        response.writeHead(200, { 'content-type': image.mime, 'content-length': image.bytes.length, 'cache-control': 'public, max-age=3600' });
        return response.end(image.bytes);
      }
      if (request.method === 'GET' && /^\/api\/shares\/[A-Za-z0-9_-]{32}$/.test(url.pathname)) {
        const recipe = await ensureNutrition(null, getSharedRecipe(url.pathname.split('/').at(-1)));
        return recipe ? json(response, 200, recipe) : json(response, 404, { error: 'Ссылка на рецепт недоступна' });
      }
      if (url.pathname.startsWith('/api/')) return await api(request, response, url);
      if (serveStatic(request, response, url.pathname)) return;
      if (!path.extname(url.pathname)) return serveStatic(request, response, '/index.html');
      json(response, 404, { error: 'Не найдено' });
    } catch (error) { log('error', 'http_error', { error, method: request.method, path: url.pathname }); json(response, error.status || 500, { error: error.status && error.status < 500 ? error.message : 'Сервис временно недоступен', ...(error.status === 402 ? { offerPath: '/?view=offer' } : {}) }); }
  });
}
