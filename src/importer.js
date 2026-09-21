import crypto from 'node:crypto';
import { config } from './config.js';
import { claimImport, createRecipe, updateJob } from './db.js';
import { normalizeRecipe } from './openai.js';
import { safeFetchText } from './security.js';
import { youtubeVideo, extractYoutubeSource } from './youtube.js';
import { socialVideo, extractSocialVideoSource } from './social-video.js';

const decodeHtml = (text) => text.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');

function htmlToText(html) {
  return decodeHtml(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, config.aiMaxInputChars);
}

function schemaRecipe(html) {
  for (const match of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const value = JSON.parse(match[1]);
      const candidates = Array.isArray(value) ? value : value['@graph'] || [value];
      const recipe = candidates.find((x) => String(x?.['@type']).toLowerCase() === 'recipe' || (Array.isArray(x?.['@type']) && x['@type'].includes('Recipe')));
      if (recipe) return JSON.stringify(recipe);
    } catch { /* malformed publisher JSON-LD */ }
  }
  return '';
}

function metaContent(html, names) {
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const key = tag.match(/(?:property|name)\s*=\s*["']([^"']+)["']/i)?.[1]?.toLowerCase();
    if (!names.includes(key)) continue;
    const value = tag.match(/content\s*=\s*["']([^"']+)["']/i)?.[1];
    if (value) return decodeHtml(value.trim());
  }
  return null;
}

export function normalizeSourceUrl(input) {
  const youtube = youtubeVideo(input);
  if (youtube) return { sourceKey: `youtube:${youtube.id}`, url: youtube.url, thumbnailUrl: `https://i.ytimg.com/vi/${youtube.id}/hqdefault.jpg`, label: 'YouTube' };
  const social = socialVideo(input);
  if (social) return { sourceKey: social.sourceKey, url: social.url, thumbnailUrl: null, label: social.label };
  const url = new URL(String(input).trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Object.assign(new Error('Нужна обычная публичная http/https-ссылка.'), { status: 422, code: 'INVALID_SOURCE_URL' });
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) if (/^(utm_.+|si|fbclid|gclid|yclid|mc_.+)$/i.test(key)) url.searchParams.delete(key);
  url.searchParams.sort();
  if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return { sourceKey: `url:${url.toString()}`, url: url.toString(), thumbnailUrl: null, label: url.hostname.replace(/^www\./, '') };
}

export function sourceKeyForText(text, prefix = 'text') {
  const normalized = String(text).normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('ru');
  return `${prefix}:${digest(normalized)}`;
}

function outcomeFromClaim(claim) {
  if (claim.state === 'existing') return { state: 'existing', recipe: claim.recipe };
  if (claim.state === 'processing') return { state: 'processing', job: claim.job };
  return null;
}

export async function importText(userId, text, options = {}) {
  if (!options.image?.buffer && String(text).trim().length < 10) throw Object.assign(new Error('Добавьте сам рецепт: ингредиенты или шаги.'), { status: 400, code: 'SOURCE_TOO_SHORT' });
  const sourceType = options.sourceType || 'text';
  const contentKey = options.image?.buffer ? `image:${digest(options.image.buffer)}` : sourceKeyForText(text, sourceType);
  const sourceKey = options.sourceKey || contentKey;
  const label = options.label || options.sourceName || (sourceType === 'audio' ? 'Ваше голосовое' : sourceType === 'image' ? 'Фото' : 'Текстовый рецепт');
  const claim = claimImport(userId, { sourceType, sourceKey, sourceUrl: options.sourceUrl || null, label, thumbnailUrl: options.thumbnailUrl || null });
  const existing = outcomeFromClaim(claim); if (existing) return existing;
  const job = claim.job;
  try {
    updateJob(job.id, 'normalizing');
    const normalize = options.normalize || normalizeRecipe;
    const normalized = await normalize({ userId, text, image: options.image, sourceName: options.sourceName || label });
    const recipe = createRecipe(userId, { ...normalized, status: options.status || 'ready', origin: 'imported', sourceType, sourceUrl: options.sourceUrl || null, sourceKey, sourceName: normalized.sourceName || options.sourceName || label, thumbnailUrl: options.thumbnailUrl || null });
    updateJob(job.id, 'ready', { recipeId: recipe.id });
    return { state: 'created', recipe, job: { ...job, status: 'ready', recipeId: recipe.id } };
  } catch (error) {
    updateJob(job.id, 'failed', { errorCode: error.code || 'IMPORT_FAILED', errorMessage: error.message });
    throw error;
  }
}

export async function importUrl(userId, input) {
  const normalizedSource = normalizeSourceUrl(input);
  const claim = claimImport(userId, { sourceType: 'url', ...normalizedSource, sourceUrl: normalizedSource.url });
  const existing = outcomeFromClaim(claim); if (existing) return existing;
  const job = claim.job;
  try {
    updateJob(job.id, 'fetching');
    const youtube = youtubeVideo(normalizedSource.url);
    const social = socialVideo(normalizedSource.url);
    const source = youtube ? await extractYoutubeSource(normalizedSource.url)
      : social ? await extractSocialVideoSource(normalizedSource.url, { userId }) : null;
    const page = source ? { url: source.url, text: '' } : await safeFetchText(normalizedSource.url, config.maxRemoteBytes);
    updateJob(job.id, 'extracting');
    const host = new URL(page.url).hostname.replace(/^www\./, '');
    const structured = schemaRecipe(page.text);
    const text = source?.text || (structured ? `Schema.org Recipe:\n${structured}\n\nТекст страницы:\n${htmlToText(page.text)}` : htmlToText(page.text));
    if (text.length < 80) throw Object.assign(new Error('Источник не отдал достаточно текста рецепта. Пришлите скриншот или текст.'), { status: 422, code: 'SOURCE_UNAVAILABLE' });
    let thumbnailUrl = source?.thumbnailUrl || normalizedSource.thumbnailUrl;
    if (!thumbnailUrl && page.text) {
      const rawPreview = metaContent(page.text, ['og:image', 'twitter:image', 'twitter:image:src']);
      try { if (rawPreview) { const candidate = new URL(rawPreview, page.url); if (['http:', 'https:'].includes(candidate.protocol)) thumbnailUrl = candidate.toString(); } } catch { /* honest fallback */ }
    }
    updateJob(job.id, 'normalizing', { thumbnailUrl });
    const normalized = await normalizeRecipe({ userId, text: text.slice(0, 24000), sourceName: source?.sourceName || host });
    if (source) normalized.warnings = [...new Set([...(normalized.warnings || []), ...source.warnings])];
    const recipe = createRecipe(userId, { ...normalized, status: 'ready', origin: 'imported', sourceType: 'url', sourceUrl: page.url, sourceKey: normalizedSource.sourceKey, sourceName: normalized.sourceName || source?.sourceName || host, thumbnailUrl });
    updateJob(job.id, 'ready', { recipeId: recipe.id, thumbnailUrl });
    return { state: 'created', recipe, job: { ...job, status: 'ready', recipeId: recipe.id, thumbnailUrl } };
  } catch (error) {
    updateJob(job.id, 'failed', { errorCode: error.code || 'IMPORT_FAILED', errorMessage: error.message });
    if (/youtube|instagram|tiktok|vk\.com/i.test(normalizedSource.url) && error.code === 'SOURCE_UNAVAILABLE') error.message += ' Соцсеть может скрывать содержимое; загрузите изображение или вставьте текст.';
    throw error;
  }
}
