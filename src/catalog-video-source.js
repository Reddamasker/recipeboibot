export function catalogVideoUrl(input) {
  let url;
  try { url = new URL(input); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  const host = url.hostname.replace(/^(www|m)\./, '');
  const path = url.pathname;
  if (host === 'youtube.com' && path === '/watch' && /^[\w-]{11}$/.test(url.searchParams.get('v') || '')) {
    return 'https://www.youtube.com/watch?v=' + url.searchParams.get('v');
  }
  if (host === 'ok.ru' && path === '/clip') {
    const owner = url.searchParams.get('owner_id'), clip = url.searchParams.get('clip_id');
    if (/^-?[1-9]\d{0,19}$/.test(owner || '') && /^[1-9]\d{0,19}$/.test(clip || '')) return 'https://ok.ru/clip?owner_id=' + owner + '&clip_id=' + clip;
  }
  if (host === 'instagram.com' && /^\/(reel|p|tv)\/[\w-]+\/?$/.test(path)) return 'https://www.instagram.com' + path.replace(/\/?$/, '/');
  if (host === 'tiktok.com' && /^\/@[\w.-]+\/video\/\d+\/?$/.test(path)) return 'https://www.tiktok.com' + path.replace(/\/$/, '');
  if (['vk.com','vk.ru','vkvideo.ru'].includes(host) && /^\/(video|clip)-?\d+_\d+$/.test(path)) return 'https://' + host + path;
  return null;
}

export function catalogVideoSource(source) {
  const url = catalogVideoUrl(source?.sourceUrl);
  const name = source?.sourceName;
  if (!url || url !== source.sourceUrl || typeof name !== 'string' || !name.trim() ||
      name.length > 250 || /[\x00-\x1f<>]|https?:\/\//i.test(name)) return null;
  return { sourceUrl: url, sourceName: name.trim() };
}
