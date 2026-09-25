import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

// Keep the same document and routes. Ship its existing startup resources in
// one response so a stalled secondary connection cannot prevent app.js running.
export function buildWebDocument(publicDir, { telegramSdk } = {}) {
  const hashes = [];
  const deferred = [];
  const read = (url) => fs.readFileSync(path.join(publicDir, url.split('?')[0]), 'utf8').replace(/\r\n?/g, '\n');
  const script = (source) => {
    const text = source.replace(/<\/script/gi, '<\\/script');
    hashes.push(`'sha256-${createHash('sha256').update(text).digest('base64')}'`);
    return `<script>${text}</script>`;
  };
  let html = read('index.html');
  html = html.replace(/<link rel="stylesheet" href="(\/[^"<>]+)">/g, (_, url) => `<style>${read(url).replace(/<\/style/gi, '<\\/style')}</style>`);
  html = html.replace(/<script( defer)? src="(\/[^"<>]+)"><\/script>/g, (_, defer, url) => {
    const source = url.startsWith('/vendor/telegram-web-app.js') && telegramSdk !== undefined ? telegramSdk : read(url);
    const tag = script(source);
    if (defer) { deferred.push(tag); return ''; }
    return tag;
  });
  html = html.replace('</body>', `${deferred.join('\n')}\n</body>`);
  const bytes = Buffer.from(html);
  return { bytes, gzip: gzipSync(bytes), scriptHashes: hashes.join(' ') };
}

export function acceptsGzip(header = '') {
  return header.split(',').some((part) => {
    const [encoding, ...parameters] = part.trim().split(';');
    return encoding.toLowerCase() === 'gzip' && !parameters.some((parameter) => /^\s*q\s*=\s*0(?:\.0*)?\s*$/i.test(parameter));
  });
}
