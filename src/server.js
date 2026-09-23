import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { config } from './config.js';
import { archiveRecipe, createRecipeShare, deleteUserData, getRecipe, getSharedRecipe, listImportJobs, listRecipes, saveRecipeSuggestion, searchRecipes, updateRecipe, upsertTelegramUser } from './db.js';
import { importText, importUrl } from './importer.js';
import { suggestForEmptySearch } from './suggestions.js';
import { validateTelegramInitData } from './security.js';
import { log } from './log.js';

const publicDir = path.resolve('public');
const mimeTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const rate = new Map();

function securityHeaders(response) {
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('referrer-policy', 'no-referrer');
  response.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  response.setHeader('content-security-policy', "default-src 'self'; script-src 'self' https://telegram.org; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; frame-ancestors https://web.telegram.org https://*.telegram.org");
}
function json(response, status, value) {
  securityHeaders(response); response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(JSON.stringify(value));
}
async function bodyJson(request, maxBytes = Math.ceil(config.maxUploadBytes * 4 / 3) + 100_000) {
  const chunks = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > maxBytes) throw Object.assign(new Error('Запрос слишком большой'), { status: 413 }); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw Object.assign(new Error('Неверный JSON'), { status: 400 }); }
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
  if (!header.startsWith('tma ')) throw Object.assign(new Error('Откройте приложение из Telegram'), { status: 401 });
  const telegramUser = validateTelegramInitData(header.slice(4), config.telegramToken);
  const user = upsertTelegramUser(telegramUser);
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
  if (request.method === 'GET' && url.pathname === '/api/me') return json(response, 200, { id: user.id, displayName: user.display_name, username: user.username });
  if (request.method === 'GET' && url.pathname === '/api/recipes') return json(response, 200, listRecipes(user.id));
  if (request.method === 'GET' && url.pathname === '/api/library') return json(response, 200, { recipes: listRecipes(user.id), jobs: listImportJobs(user.id) });
  if (request.method === 'GET' && url.pathname === '/api/search') {
    const q = (url.searchParams.get('q') || '').slice(0,500);
    if (!q.trim()) return json(response, 200, listRecipes(user.id));
    return json(response, 200, searchRecipes(user.id, q).filter((recipe) => recipe.status === 'ready'));
  }
  if (request.method === 'POST' && url.pathname === '/api/suggestions') {
    rateLimit(`ai:${user.id}`, 8, 60_000);
    const input = await bodyJson(request, 2000);
    return json(response, 200, await suggestForEmptySearch(user.id, input.query));
  }
  if (request.method === 'POST' && /^\/api\/suggestions\/[0-9a-f-]{36}\/save$/i.test(url.pathname)) {
    const recipe = saveRecipeSuggestion(user.id, url.pathname.split('/').at(-2));
    return recipe ? json(response, 200, recipe) : json(response, 404, { error: 'Предложение больше недоступно' });
  }
  if (request.method === 'GET' && /^\/api\/recipes\/[^/]+$/.test(url.pathname)) {
    const recipe = getRecipe(user.id, decodeURIComponent(url.pathname.split('/').at(-1)));
    return recipe ? json(response, 200, recipe) : json(response, 404, { error: 'Рецепт не найден' });
  }
  if (request.method === 'POST' && /^\/api\/recipes\/[^/]+\/share$/.test(url.pathname)) {
    const id = decodeURIComponent(url.pathname.split('/').at(-2));
    const token = createRecipeShare(user.id, id);
    return token ? json(response, 200, { token, path: `/share/${token}` }) : json(response, 404, { error: 'Рецепт не найден' });
  }
  if (request.method === 'POST' && url.pathname === '/api/import') {
    rateLimit(`ai:${user.id}`, 8, 60_000); const input = await bodyJson(request);
    let outcome;
    if (input.kind === 'url') outcome = await importUrl(user.id, String(input.value || ''));
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
    return json(response, 200, updateRecipe(user.id, id, cleanRecipeInput(await bodyJson(request), existing)));
  }
  if (request.method === 'DELETE' && /^\/api\/recipes\/[^/]+$/.test(url.pathname)) return json(response, archiveRecipe(user.id, decodeURIComponent(url.pathname.split('/').at(-1))) ? 204 : 404, {});
  if (request.method === 'DELETE' && url.pathname === '/api/account') { deleteUserData(user.id); return json(response, 204, {}); }
  return json(response, 404, { error: 'Не найдено' });
}

function serveStatic(response, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const file = path.resolve(publicDir, `.${requested}`);
  if (!file.startsWith(publicDir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  securityHeaders(response); response.writeHead(200, { 'content-type': mimeTypes[path.extname(file)] || 'application/octet-stream', 'cache-control': requested === '/index.html' ? 'no-cache' : 'public, max-age=3600' }); fs.createReadStream(file).pipe(response); return true;
}

export function createServer() {
  return http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    try {
      rateLimit(`ip:${clientIp(request)}`);
      if (url.pathname === '/healthz') return json(response, 200, { ok: true, service: 'recipeboibot' });
      if (request.method === 'GET' && /^\/api\/shares\/[A-Za-z0-9_-]{32}$/.test(url.pathname)) {
        const recipe = getSharedRecipe(url.pathname.split('/').at(-1));
        return recipe ? json(response, 200, recipe) : json(response, 404, { error: 'Ссылка на рецепт недоступна' });
      }
      if (url.pathname.startsWith('/api/')) return await api(request, response, url);
      if (serveStatic(response, url.pathname)) return;
      if (!path.extname(url.pathname)) return serveStatic(response, '/index.html');
      json(response, 404, { error: 'Не найдено' });
    } catch (error) { log('error', 'http_error', { error, method: request.method, path: url.pathname }); json(response, error.status || 500, { error: error.status && error.status < 500 ? error.message : 'Сервис временно недоступен' }); }
  });
}
