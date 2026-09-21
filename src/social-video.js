import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from './config.js';
import { transcribeMedia } from './openai.js';

const MAX_MEDIA_BYTES = 24 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 90000;
const hosts = new Map([
  ['instagram.com', 'instagram'], ['www.instagram.com', 'instagram'],
  ['tiktok.com', 'tiktok'], ['www.tiktok.com', 'tiktok'], ['m.tiktok.com', 'tiktok'], ['vm.tiktok.com', 'tiktok'], ['vt.tiktok.com', 'tiktok'],
  ['vk.com', 'vk'], ['www.vk.com', 'vk'], ['m.vk.com', 'vk'], ['vk.ru', 'vk'], ['www.vk.ru', 'vk'],
  ['vkvideo.ru', 'vk'], ['www.vkvideo.ru', 'vk']
]);

const labels = { instagram: 'Instagram', tiktok: 'TikTok', vk: 'VK Video' };
const sourceError = (message, code = 'SOCIAL_VIDEO_UNAVAILABLE', status = 422) => Object.assign(new Error(message), { status, code });

function cleanUrl(url) {
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_.+|igsh|igshid|stkn|share_.+|_r|_t|is_from_webapp|sender_device|sender_web_id)$/i.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url;
}

export function socialVideo(input) {
  let url;
  try { url = new URL(String(input).trim()); } catch { return null; }
  const platform = hosts.get(url.hostname.toLowerCase());
  if (!platform) return null;
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (url.port && !['80', '443'].includes(url.port))) {
    throw sourceError('Нужна обычная публичная ссылка на ролик без логина и нестандартного порта.', 'INVALID_SOCIAL_VIDEO_URL');
  }
  url.protocol = 'https:';
  cleanUrl(url);
  let id = null;
  const instagramMatch = platform === 'instagram' ? url.pathname.match(/^\/(reel|reels|p|tv)\/([A-Za-z0-9_-]+)/i) : null;
  if (instagramMatch) id = instagramMatch[2];
  if (platform === 'tiktok') id = url.pathname.match(/^\/@[^/]+\/video\/(\d+)/i)?.[1] || null;
  if (platform === 'vk') id = (url.pathname.match(/^\/(?:video|clip)(-?\d+_\d+)/i)?.[1] || url.searchParams.get('z')?.match(/(?:video|clip)(-?\d+_\d+)/i)?.[1]) ?? null;
  if (platform === 'instagram' && !id) throw sourceError('Пришлите ссылку на отдельный пост или Reel Instagram.', 'INVALID_SOCIAL_VIDEO_URL');
  const tiktokShort = ['vm.tiktok.com', 'vt.tiktok.com'].includes(url.hostname.toLowerCase()) || /^\/t\/[A-Za-z0-9_-]+/i.test(url.pathname);
  if (platform === 'tiktok' && !id && !tiktokShort) throw sourceError('Пришлите ссылку на отдельный ролик TikTok.', 'INVALID_SOCIAL_VIDEO_URL');
  if (platform === 'vk' && !id) throw sourceError('Пришлите ссылку на отдельный ролик VK Video.', 'INVALID_SOCIAL_VIDEO_URL');
  const instagramKind = instagramMatch?.[1]?.toLowerCase() === 'reels' ? 'reel' : instagramMatch?.[1]?.toLowerCase();
  const canonicalUrl = platform === 'instagram' ? `https://www.instagram.com/${instagramKind}/${id}/` : url.toString();
  return { platform, id, url: canonicalUrl, sourceKey: id ? `${platform}:${id}` : `url:${url}`, label: labels[platform] };
}

function extensionMime(extension) {
  return ({ mp4: 'video/mp4', m4a: 'audio/mp4', mp3: 'audio/mpeg', webm: 'video/webm', ogg: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac', mpeg: 'video/mpeg', mpga: 'audio/mpeg' })[extension.toLowerCase()] || 'application/octet-stream';
}

async function directoryBytes(directory) {
  let total = 0;
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.isFile()) total += (await fs.stat(path.join(directory, entry.name))).size;
  }
  return total;
}

async function runDownloader(url, directory) {
  const args = [
    '--no-playlist', '--max-filesize', String(MAX_MEDIA_BYTES),
    // Some social extractors mark progressive MP4 codecs as "unknown" even
    // though the file contains both video and audio. Prefer their smallest MP4.
    '--format', 'worst[ext=mp4]/worst[ext=webm]/worst',
    '--output', path.join(directory, 'media.%(ext)s'),
    '--print-json', '--no-progress', '--no-warnings', '--no-cache-dir', '--no-part',
    '--socket-timeout', '15', '--retries', '1', '--fragment-retries', '1', '--extractor-retries', '1', url
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(config.ytDlpPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = '', settled = false, tooLarge = false, timeout, sizeGuard;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timeout); clearInterval(sizeGuard);
      error ? reject(error) : resolve(value);
    };
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-1024 * 1024); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
    child.on('error', error => finish(error.code === 'ENOENT'
      ? sourceError('Загрузчик видео не установлен на сервере.', 'VIDEO_DOWNLOADER_MISSING', 503)
      : sourceError('Не удалось запустить загрузчик видео.', 'VIDEO_DOWNLOADER_FAILED', 502)));
    timeout = setTimeout(() => { child.kill('SIGKILL'); finish(sourceError('Загрузка ролика заняла слишком много времени.', 'SOCIAL_VIDEO_TIMEOUT', 504)); }, DOWNLOAD_TIMEOUT_MS);
    sizeGuard = setInterval(async () => {
      try {
        if (await directoryBytes(directory) > MAX_MEDIA_BYTES) {
          tooLarge = true; child.kill('SIGKILL');
        }
      } catch { /* The temporary directory may be removed after process exit. */ }
    }, 250);
    child.on('close', code => {
      if (tooLarge || /larger than max-filesize|File is larger/i.test(stderr)) return finish(sourceError('Ролик слишком большой для обработки: максимум 24 МБ.', 'SOCIAL_VIDEO_TOO_LARGE', 413));
      if (code !== 0) return finish(sourceError(/login|private|cookies|members-only|authentication/i.test(stderr)
        ? 'Ролик недоступен без входа в соцсеть. Поддерживаются только публичные видео.'
        : 'Соцсеть не отдала публичный файл ролика. Попробуйте ещё раз позже.', 'SOCIAL_VIDEO_UNAVAILABLE'));
      const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
      try { finish(null, JSON.parse(line)); }
      catch { finish(sourceError('Загрузчик не вернул данные ролика.', 'SOCIAL_VIDEO_METADATA_INVALID', 502)); }
    });
  });
}

export async function downloadPublicVideo(input) {
  const video = socialVideo(input);
  if (!video) throw sourceError('Это не ссылка Instagram, TikTok или VK Video.', 'UNSUPPORTED_SOCIAL_VIDEO');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'recipe-video-'));
  try {
    const info = await runDownloader(video.url, directory);
    const entries = await fs.readdir(directory);
    const mediaName = entries.find(name => name.startsWith('media.') && !name.endsWith('.json') && !name.endsWith('.part'));
    if (!mediaName) throw sourceError('Соцсеть не отдала файл ролика.', 'SOCIAL_VIDEO_MEDIA_MISSING');
    const mediaPath = path.join(directory, mediaName);
    const stat = await fs.stat(mediaPath);
    if (!stat.size || stat.size > MAX_MEDIA_BYTES) throw sourceError('Ролик слишком большой для обработки: максимум 24 МБ.', 'SOCIAL_VIDEO_TOO_LARGE', 413);
    const extension = path.extname(mediaName).slice(1).toLowerCase();
    let webpageUrl = video.url;
    try { if (info.webpage_url && socialVideo(info.webpage_url)) webpageUrl = info.webpage_url; } catch { /* Keep the validated input URL. */ }
    return {
      buffer: await fs.readFile(mediaPath), mime: extensionMime(extension), filename: mediaName,
      info: {
        title: String(info.title || '').slice(0, 500), description: String(info.description || '').slice(0, 12000),
        uploader: String(info.uploader || info.channel || '').slice(0, 200), thumbnailUrl: /^https?:\/\//.test(info.thumbnail || '') ? info.thumbnail : null,
        webpageUrl,
        duration: Number.isFinite(info.duration) ? info.duration : null
      }
    };
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

export async function extractSocialVideoSource(input, adapters = {}) {
  const video = socialVideo(input);
  if (!video) throw sourceError('Это не ссылка Instagram, TikTok или VK Video.', 'UNSUPPORTED_SOCIAL_VIDEO');
  const download = adapters.download || downloadPublicVideo;
  const transcribe = adapters.transcribe || transcribeMedia;
  const media = await download(video.url);
  const transcript = String(await transcribe({ userId: adapters.userId || null, buffer: media.buffer, mime: media.mime, filename: media.filename })).trim();
  const description = String(media.info?.description || '').trim();
  if (transcript.length < 20 && description.length < 40) throw sourceError('В ролике не удалось получить речь или текст рецепта.', 'SOCIAL_VIDEO_TEXT_UNAVAILABLE');
  const author = media.info?.uploader ? ` · ${media.info.uploader}` : '';
  return {
    url: media.info?.webpageUrl || video.url,
    sourceName: `${video.label}${author}`.slice(0, 250),
    thumbnailUrl: media.info?.thumbnailUrl || null,
    warnings: ['Использованы описание и автоматическая расшифровка звука ролика. Видеокадры не анализировались; проверьте количества и последовательность.'],
    text: `Название ролика: ${media.info?.title || '[не указано]'}\nОписание автора:\n${description || '[отсутствует]'}\n\nРасшифровка звука:\n${transcript || '[речь не распознана]'}\n\nИзвлекай только явно указанный рецепт. Не додумывай ингредиенты, количества и шаги. Если описание и речь расходятся, укажи неоднозначность в предупреждении.`
  };
}
