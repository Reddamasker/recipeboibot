import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

// Keep the same document and routes. Ship its existing startup resources in
// one response so a stalled secondary connection cannot prevent app.js running.
export function buildWebDocument(publicDir, { telegramSdk, botUsername, botPlatform = 'telegram' } = {}) {
  const isMax = botPlatform === 'max';
  const hashes = [];
  const deferred = [];
  const read = (url) => {
    const source = fs.readFileSync(path.join(publicDir, url.split('?')[0]), 'utf8').replace(/\r\n?/g, '\n');
    if (isMax && url.split('?')[0] === 'index.html') return source.split(/(<div class="lp-platforms"[\s\S]*?<\/div>)/g).map((part, index) => index % 2 ? part : part.replaceAll('https://t.me/Recipeboibot', `https://max.ru/${encodeURIComponent(botUsername || '')}`).replaceAll('Telegram', 'MAX').replaceAll('нажмите Start', 'нажмите «Начать»')).join('');
    return !isMax && botUsername ? source.replaceAll('https://t.me/Recipeboibot', `https://t.me/${botUsername}`) : source;
  };
  const script = (source) => {
    const text = source.replace(/<\/script/gi, '<\\/script');
    hashes.push(`'sha256-${createHash('sha256').update(text).digest('base64')}'`);
    return `<script>${text}</script>`;
  };
  let html = read('index.html');
  html = html.replace(/<script src="\/platform-bridge\.js[^"<>]*"><\/script>\s*/, '');
  html = html.replace(/<link rel="stylesheet" href="(\/[^"<>]+)">/g, (_, url) => `<style>${read(url).replace(/<\/style/gi, '<\\/style')}</style>`);
  html = html.replace(/<script( defer)? src="(\/[^"<>]+)"><\/script>/g, (_, defer, url) => {
    if (isMax && url.startsWith('/vendor/telegram-web-app.js')) {
      deferred.push('<script src="https://st.max.ru/js/max-web-app.js"></script>');
      return '';
    }
    let source = url.startsWith('/vendor/telegram-web-app.js') && telegramSdk !== undefined ? telegramSdk : read(url);
    if (url.startsWith('/mini-boot.js')) source = `window.__recipePlatform=${JSON.stringify({ name: isMax ? 'max' : 'telegram', botUsername: botUsername || (isMax ? '' : 'Recipeboibot') })};\n${read('/platform-bridge.js')}\n${source}`;
    const tag = script(source);
    if (defer) { deferred.push(tag); return ''; }
    return tag;
  });
  html = html.replace('</body>', `${deferred.join('\n')}\n</body>`);
  const bytes = Buffer.from(html);
  return { bytes, gzip: gzipSync(bytes, { level: 9 }), scriptHashes: hashes.join(' ') };
}

export function acceptsGzip(header = '') {
  return header.split(',').some((part) => {
    const [encoding, ...parameters] = part.trim().split(';');
    return encoding.toLowerCase() === 'gzip' && !parameters.some((parameter) => /^\s*q\s*=\s*0(?:\.0*)?\s*$/i.test(parameter));
  });
}

// One shared application, with identity supplied by the serving contour.
export function buildMiniAppDocument(publicDir, { botPlatform = 'telegram', botUsername } = {}) {
  const name = botPlatform === 'max' ? 'max' : 'telegram';
  const settings = JSON.stringify({ name, botUsername: botUsername || (name === 'telegram' ? 'Recipeboibot' : '') }).replaceAll('<', '\\u003c');
  const source = `window.__recipePlatform=${settings};`;
  const scriptHashes = `'sha256-${createHash('sha256').update(source).digest('base64')}'`;
  const sdk = name === 'max' ? '<script defer src="https://st.max.ru/js/max-web-app.js"></script>' : '';
  const html = fs.readFileSync(path.join(publicDir, 'review/recime-20261109/index.html'), 'utf8')
    .replace('</title>', `</title><script>${source}</script>${sdk}`);
  return { bytes: Buffer.from(html), scriptHashes };
}
