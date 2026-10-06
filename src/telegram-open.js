// Only server-selected Telegram destinations can reach the app-opening page.
export function telegramOpenDocument(destination) {
  const url = new URL(destination);
  const username = url.pathname.slice(1);
  const payload = url.searchParams.get('start') || '';
  if (url.origin !== 'https://t.me' || !/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(username) ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(payload) || url.username || url.password || url.hash ||
      [...url.searchParams.keys()].some(key => key !== 'start')) {
    throw Object.assign(new Error('Неверная ссылка Telegram'), { status: 400 });
  }
  const web = `https://t.me/${username}?start=${payload}`;
  const app = `tg://resolve?domain=${username}&amp;start=${payload}`;
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Открываю Telegram</title>
<noscript><meta http-equiv="refresh" content="0;url=${web}"></noscript>
<style>body{margin:0;min-height:100svh;display:grid;place-items:center;background:#f7f5f0;color:#29352d;font:18px system-ui,sans-serif}main{text-align:center;padding:24px}a{color:#365e45}p{margin:0 0 20px}</style>
<script src="/telegram-open.js" defer></script></head>
<body><main><p id="telegram-status" role="status">Открываю Telegram…</p>
<a id="telegram-fallback" href="${web}" data-app-url="${app}">Открыть Telegram</a>
</main></body></html>`;
}
