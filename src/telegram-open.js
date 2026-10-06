// Only server-selected Telegram destinations can reach the app-opening page.
export function telegramOpenDocument(destination, { button = false } = {}) {
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
  if (button) return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Подобрать ужин — Твои рецепты</title>
<link rel="icon" href="/assets/recipe-bot-avatar-v3.webp" type="image/webp">
<link rel="stylesheet" href="/telegram-open.css?v=button-1">
<script src="/telegram-open.js?v=button-1" defer></script></head>
<body class="telegram-entry"><div class="entry-wrap">
<header class="entry-brand"><img src="/assets/recipe-bot-avatar-v3.webp" width="38" height="38" alt=""><span>Твои рецепты</span><small>Бот в Telegram</small></header>
<main class="entry-card"><figure class="entry-photo"><img src="/assets/dinner/chicken-rice.jpg" width="1254" height="1254" alt="Домашний ужин: курица с рисом и овощами" fetchpriority="high"><figcaption>Из того, что есть дома.</figcaption></figure>
<section class="entry-content" aria-labelledby="entry-title">
<p class="entry-eyebrow">Один вопрос — и идея ужина</p>
<h1 id="entry-title">Что приготовить <em>сегодня?</em></h1>
<p class="entry-lead">Напишите или надиктуйте продукты — бот подберёт ужин по вашим вкусам.</p>
<a class="entry-button" id="telegram-launch" href="${app}">Подобрать ужин в Telegram</a>
<p class="entry-hint" id="telegram-status" role="status">В Telegram нажмите «Начать» и расскажите, что есть дома.</p>
<a class="entry-fallback" id="telegram-fallback" href="${web}" data-app-url="${app}">Другой способ открыть Telegram</a>
</section></main>
<footer class="entry-footer"><a href="/privacy.html">Конфиденциальность</a><a href="/terms.html">Условия использования</a></footer>
</div></body></html>`;
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
