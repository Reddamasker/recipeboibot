import { safeFetchText, safePostJson } from './security.js';
import { spawn } from 'node:child_process';
import { config } from './config.js';

const hosts = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be']);
const sourceError = (message, code = 'YOUTUBE_SOURCE_UNAVAILABLE', status = 422) => Object.assign(new Error(message), { status, code });
export const YOUTUBE_PLAYLIST_LIMIT = 30;

export function youtubePlaylist(input) {
  let url;
  try { url = new URL(String(input).trim()); } catch { return null; }
  if (!hosts.has(url.hostname) || url.hostname === 'youtu.be') return null;
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || (url.port && !['80', '443'].includes(url.port))) {
    throw sourceError('Нужна обычная ссылка на плейлист YouTube без логина и нестандартного порта.', 'INVALID_YOUTUBE_PLAYLIST_URL');
  }
  if (url.pathname !== '/playlist') return null;
  const id = url.searchParams.get('list');
  if (!/^[A-Za-z0-9_-]{2,100}$/.test(id || '')) throw sourceError('Не удалось определить плейлист YouTube по этой ссылке.', 'INVALID_YOUTUBE_PLAYLIST_URL');
  return { id, url: `https://www.youtube.com/playlist?list=${encodeURIComponent(id)}` };
}

export function youtubeVideo(input) {
  let url;
  try { url = new URL(input); } catch { return null; }
  if (!hosts.has(url.hostname)) return null;
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || (url.port && !['80', '443'].includes(url.port))) {
    throw sourceError('Нужна обычная ссылка на видео YouTube без логина и нестандартного порта.');
  }
  const parts = url.pathname.split('/').filter(Boolean);
  const id = url.hostname === 'youtu.be' && parts.length === 1 ? parts[0]
    : url.pathname === '/watch' ? url.searchParams.get('v')
    : ['shorts', 'embed', 'live'].includes(parts[0]) && parts.length === 2 ? parts[1] : null;
  if (!/^[A-Za-z0-9_-]{11}$/.test(id || '')) throw sourceError('Пришлите ссылку на отдельный ролик YouTube, а не на канал или плейлист.');
  return { id, url: `https://www.youtube.com/watch?v=${id}` };
}

// Read the embedded JSON as data; never evaluate scripts from a publisher.
export function parseYoutubePlayer(html) {
  const marker = /(?:\bvar\s+)?\bytInitialPlayerResponse\s*=\s*/g;
  for (const match of html.matchAll(marker)) {
    const start = match.index + match[0].length;
    if (html[start] !== '{') continue;
    let depth = 0, quoted = false, escaped = false;
    for (let i = start; i < html.length; i++) {
      const char = html[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === '{') depth++;
      else if (char === '}' && --depth === 0) {
        try { return JSON.parse(html.slice(start, i + 1)); } catch { break; }
      }
    }
  }
  throw sourceError('YouTube не отдал данные ролика. Вход в аккаунт и защищённые страницы автоматически не обрабатываются.');
}

function parseAssignedObject(html, marker) {
  for (const match of html.matchAll(marker)) {
    const start = match.index + match[0].length;
    if (html[start] !== '{') continue;
    let depth = 0, quoted = false, escaped = false;
    for (let i = start; i < html.length; i++) {
      const char = html[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === '{') depth++;
      else if (char === '}' && --depth === 0) {
        try { return JSON.parse(html.slice(start, i + 1)); } catch { break; }
      }
    }
  }
  return null;
}

const rendererText = value => String(value?.simpleText || value?.runs?.map(run => run.text || '').join('') || '').trim();

export function parseYoutubePlaylist(html, limit = YOUTUBE_PLAYLIST_LIMIT) {
  const data = parseAssignedObject(html, /(?:\bvar\s+)?\bytInitialData\s*=\s*/g);
  if (!data) throw sourceError('YouTube не отдал список роликов плейлиста.', 'YOUTUBE_PLAYLIST_UNAVAILABLE');
  const videos = [], seen = new Set();
  let title = '';
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    const renderer = value.playlistVideoRenderer || value.playlistPanelVideoRenderer;
    const id = renderer?.videoId;
    if (/^[A-Za-z0-9_-]{11}$/.test(id || '') && !seen.has(id)) {
      seen.add(id);
      videos.push({ id, title: rendererText(renderer.title) || `Видео ${videos.length + 1}`, url: `https://www.youtube.com/watch?v=${id}` });
    }
    if (!title && value.playlistMetadataRenderer?.title) title = String(value.playlistMetadataRenderer.title).trim();
    if (!title && value.playlistHeaderRenderer?.title) title = rendererText(value.playlistHeaderRenderer.title);
    for (const child of Array.isArray(value) ? value : Object.values(value)) visit(child);
  };
  visit(data);
  if (!videos.length) throw sourceError('В плейлисте не найдено доступных публичных роликов.', 'YOUTUBE_PLAYLIST_EMPTY');
  const boundedLimit = Math.max(1, Math.min(YOUTUBE_PLAYLIST_LIMIT, Number(limit) || YOUTUBE_PLAYLIST_LIMIT));
  return { title: title.slice(0, 300) || 'Плейлист YouTube', videos: videos.slice(0, boundedLimit), discovered: videos.length, truncated: videos.length > boundedLimit };
}

export function parseYoutubePlaylistInfo(info, limit = YOUTUBE_PLAYLIST_LIMIT) {
  const boundedLimit = Math.max(1, Math.min(YOUTUBE_PLAYLIST_LIMIT, Number(limit) || YOUTUBE_PLAYLIST_LIMIT));
  const videos = [], seen = new Set();
  for (const entry of Array.isArray(info?.entries) ? info.entries : []) {
    const id = String(entry?.id || entry?.url || '');
    if (!/^[A-Za-z0-9_-]{11}$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    videos.push({ id, title: String(entry.title || `Видео ${videos.length + 1}`).slice(0, 300), url: `https://www.youtube.com/watch?v=${id}` });
    if (videos.length >= boundedLimit) break;
  }
  if (!videos.length) throw sourceError('В плейлисте не найдено доступных публичных роликов.', 'YOUTUBE_PLAYLIST_EMPTY');
  const reported = Number(info.playlist_count || info.n_entries || info.entries?.length);
  const discovered = Number.isFinite(reported) && reported >= videos.length ? reported : videos.length;
  return { title: String(info.title || 'Плейлист YouTube').slice(0, 300), videos, discovered, truncated: discovered > videos.length || videos.length === boundedLimit };
}

async function extractYoutubePlaylistWithDownloader(playlist, limit) {
  const args = [
    '--flat-playlist', '--skip-download', '--playlist-end', String(limit), '--dump-single-json',
    '--no-warnings', '--no-cache-dir', '--socket-timeout', '15', '--retries', '1', '--extractor-retries', '1', playlist.url
  ];
  const info = await new Promise((resolve, reject) => {
    const child = spawn(config.ytDlpPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = '', settled = false, timeout;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timeout); error ? reject(error) : resolve(value); };
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (stdout.length > 2 * 1024 * 1024) { child.kill('SIGKILL'); finish(sourceError('Список роликов плейлиста слишком большой.', 'YOUTUBE_PLAYLIST_TOO_LARGE', 413)); }
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
    child.on('error', error => finish(error.code === 'ENOENT'
      ? sourceError('Сервис чтения плейлистов временно недоступен.', 'VIDEO_DOWNLOADER_MISSING', 503)
      : sourceError('Не удалось запустить чтение плейлиста.', 'VIDEO_DOWNLOADER_FAILED', 502)));
    timeout = setTimeout(() => { child.kill('SIGKILL'); finish(sourceError('YouTube слишком долго отдавал плейлист.', 'YOUTUBE_PLAYLIST_TIMEOUT', 504)); }, 45000);
    child.on('close', code => {
      if (settled) return;
      if (code !== 0) return finish(sourceError(/private|sign in|login|unavailable|does not exist/i.test(stderr)
        ? 'Плейлист недоступен без входа в YouTube. Откройте для него доступ по ссылке и отправьте ссылку ещё раз.'
        : 'YouTube не отдал список роликов плейлиста. Попробуйте ещё раз позже.', 'YOUTUBE_PLAYLIST_UNAVAILABLE'));
      try { finish(null, JSON.parse(stdout)); }
      catch { finish(sourceError('YouTube вернул некорректный список роликов.', 'YOUTUBE_PLAYLIST_INVALID', 502)); }
    });
  });
  return { ...playlist, ...parseYoutubePlaylistInfo(info, limit) };
}

export async function extractYoutubePlaylist(input, fetchText = safeFetchText, limit = YOUTUBE_PLAYLIST_LIMIT, download = extractYoutubePlaylistWithDownloader) {
  const playlist = youtubePlaylist(input);
  if (!playlist) throw sourceError('Это не ссылка на плейлист YouTube.', 'INVALID_YOUTUBE_PLAYLIST_URL');
  try {
    const page = await fetchText(`${playlist.url}&hl=ru`, 4 * 1024 * 1024);
    return { ...playlist, ...parseYoutubePlaylist(page.text, limit) };
  } catch (error) {
    if (error.code === 'INVALID_YOUTUBE_PLAYLIST_URL') throw error;
  }
  return download(playlist, limit);
}

function unescapeText(text) {
  return text.replace(/<[^>]*>/g, '').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (entity, name) => {
    if (name.startsWith('#')) {
      const value = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return value >= 0 && value <= 0x10ffff ? String.fromCodePoint(value) : entity;
    }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }[name.toLowerCase()] || entity;
  });
}

export function parseYoutubeCaptions(body) {
  if (!body.trim()) return '';
  let lines;
  if (body.trimStart().startsWith('{')) {
    const json = JSON.parse(body);
    lines = (json.events || []).map(event => (event.segs || []).map(seg => seg.utf8 || '').join(''));
  } else {
    // Both the original timedtext XML and srv3 paragraphs; no XML entities/DTDs are executed.
    if (!/<(?:transcript|timedtext)\b/i.test(body)) return '';
    lines = [...body.matchAll(/<(text|p)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map(match => unescapeText(match[2]));
  }
  return lines.map(line => line.replace(/\s+/g, ' ').trim()).filter((line, i, all) => line && line !== all[i - 1]).join('\n').slice(0, 14000);
}

function captionUrl(track) {
  try {
    const url = new URL(track.baseUrl);
    if (url.protocol !== 'https:' || !['www.youtube.com', 'youtube.com'].includes(url.hostname) || url.pathname !== '/api/timedtext' || url.username || url.password || url.port) return null;
    return url.toString();
  } catch { return null; }
}

export async function extractYoutubeSource(input, fetchText = safeFetchText, postJson = safePostJson) {
  const video = youtubeVideo(input);
  if (!video) throw sourceError('Это не ссылка YouTube.');
  const page = await fetchText(`${video.url}&hl=ru`, 3 * 1024 * 1024);
  let player = parseYoutubePlayer(page.text);
  if (player.playabilityStatus?.status && player.playabilityStatus.status !== 'OK') {
    throw sourceError('YouTube сообщил, что ролик недоступен без дополнительных условий доступа.', 'YOUTUBE_ACCESS_REQUIRED');
  }
  if (player.videoDetails?.videoId !== video.id) throw sourceError('Не удалось подтвердить данные выбранного ролика.');
  // Refresh subtitle URLs through the same public player interface used by
  // youtube-transcript-api. The key comes from this public page, not user credentials.
  // No login cookies, media streams, external proxy, or protected-content bypass.
  const publicPageKey = page.text.match(/"INNERTUBE_API_KEY":\s*"([a-zA-Z0-9_-]+)"/)?.[1];
  if (publicPageKey) {
    let refreshed;
    try {
      refreshed = await postJson(`https://www.youtube.com/youtubei/v1/player?key=${publicPageKey}`, {
        context: { client: { clientName: 'ANDROID', clientVersion: '20.10.38' } }, videoId: video.id
      }, 2 * 1024 * 1024);
    } catch { /* Retain the page's original public data if metadata refresh fails. */ }
    if (refreshed?.playabilityStatus?.status && refreshed.playabilityStatus.status !== 'OK') {
      throw sourceError('YouTube запросил дополнительные условия доступа к ролику. Автоматический вход и обход ограничений не выполняются.', 'YOUTUBE_ACCESS_REQUIRED');
    }
    if (refreshed?.videoDetails?.videoId === video.id) player = refreshed;
  }
  const details = player.videoDetails;
  const description = String(details.shortDescription || '').slice(0, 8000);
  const tracks = (player.captions?.playerCaptionsTracklistRenderer?.captionTracks || [])
    .filter(track => captionUrl(track))
    .sort((a, b) => trackPriority(a) - trackPriority(b));
  let transcript = '';
  if (tracks.length) {
    try {
      const captions = await fetchText(captionUrl(tracks[0]), 512 * 1024);
      transcript = parseYoutubeCaptions(captions.text);
    } catch { /* An accessible description can still be useful; no retries or bypasses. */ }
  }
  const meaningfulDescription = description.replace(/https?:\/\/\S+|#[\p{L}\p{N}_]+/gu, '').trim();
  if (transcript.length < 40 && meaningfulDescription.length < 40) {
    throw sourceError(tracks.length
      ? 'YouTube не отдал текст субтитров, а в описании недостаточно текста рецепта.'
      : 'В описании YouTube недостаточно текста рецепта, доступных субтитров нет.', 'YOUTUBE_TEXT_UNAVAILABLE');
  }
  const warnings = [];
  if (!transcript) warnings.push('Рецепт извлечён только из описания YouTube. Субтитры недоступны; содержимое видео не анализировалось.');
  else warnings.push(`Использованы ${tracks[0].kind === 'asr' ? 'автоматические ' : ''}субтитры YouTube (${tracks[0].languageCode || 'язык не указан'}). Видеокадры не анализировались; проверьте количества.`);
  return {
    url: video.url, sourceName: `YouTube · ${String(details.author || 'автор').slice(0, 150)}`, warnings,
    text: `Название: ${String(details.title || '').slice(0, 300)}\nОписание автора:\n${description}\n\nСубтитры:\n${transcript || '[недоступны]'}\n\nИзвлекай только явно указанный рецепт. Название переведи на русский. Название и хештеги сами по себе не являются рецептом. Недостающие шаги не придумывай. Не склеивай разные варианты приготовления в последовательные обязательные шаги. Если варианты или порядок нельзя уверенно различить, явно укажи неоднозначность в шаге и предупреждении. Температуры без указанной шкалы не включай как инструкцию по нагреву: вынеси исходные числа в предупреждение и попроси проверить шкалу в ролике.`
  };
}

function trackPriority(track) {
  const language = String(track.languageCode || '').split('-')[0];
  return (language === 'ru' ? 0 : language === 'en' ? 2 : 4) + (track.kind === 'asr' ? 1 : 0);
}
