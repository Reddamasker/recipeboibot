import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';

// Global unicast is not synonymous with the entire 2001::/16 being special-use.
// In particular, Google's public 2001:4860:: addresses must remain reachable.
const globalV6 = new net.BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
const specialV6 = new net.BlockList();
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]]) {
  specialV6.addSubnet(address, prefix, 'ipv6');
}

export function validateTelegramInitData(initData, botToken, maxAgeSeconds = 3600) {
  if (!initData || !botToken) throw Object.assign(new Error('Нет данных Telegram'), { status: 401 });
  const params = new URLSearchParams(initData);
  if (new Set(params.keys()).size !== [...params.keys()].length) throw Object.assign(new Error('Повторяющиеся поля Telegram'), { status: 401 });
  const hash = params.get('hash');
  if (!hash || !/^[a-f0-9]{64}$/i.test(hash)) throw Object.assign(new Error('Неверная подпись Telegram'), { status: 401 });
  params.delete('hash');
  const dataCheckString = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(expected, 'hex'))) throw Object.assign(new Error('Неверная подпись Telegram'), { status: 401 });
  const authDate = Number(params.get('auth_date'));
  if (!Number.isFinite(authDate) || Math.abs(Date.now() / 1000 - authDate) > maxAgeSeconds) throw Object.assign(new Error('Сессия Telegram устарела'), { status: 401 });
  let user;
  try { user = JSON.parse(params.get('user') || ''); } catch { throw Object.assign(new Error('Неверные данные пользователя'), { status: 401 }); }
  if (!user?.id) throw Object.assign(new Error('Нет Telegram ID'), { status: 401 });
  return user;
}

export function makeTelegramInitData(user, botToken, authDate = Math.floor(Date.now() / 1000)) {
  const params = new URLSearchParams({ auth_date: String(authDate), query_id: 'test-query', user: JSON.stringify(user) });
  const dataCheckString = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  params.set('hash', crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex'));
  return params.toString();
}

export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0)) || (a === 198 && (b === 18 || b === 19 || b === 51)) || (a === 203 && b === 0) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    return !globalV6.check(ip, 'ipv6') || specialV6.check(ip, 'ipv6');
  }
  return true;
}

export async function assertSafeRemoteUrl(input) {
  let url;
  try { url = new URL(input); } catch { throw Object.assign(new Error('Неверная ссылка'), { status: 400 }); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Object.assign(new Error('Разрешены только обычные http/https-ссылки'), { status: 400 });
  if (url.port && !['80', '443'].includes(url.port)) throw Object.assign(new Error('Нестандартный порт источника запрещён'), { status: 400 });
  if (url.hostname === 'localhost' || url.hostname.endsWith('.local')) throw Object.assign(new Error('Локальные адреса запрещены'), { status: 400 });
  const addresses = await dns.lookup(url.hostname.replace(/^\[|\]$/g, ''), { all: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateIp(address))) throw Object.assign(new Error('Этот сетевой адрес запрещён'), { status: 400 });
  return url;
}

async function pinnedRequest(url, maxBytes, body = null) {
  const addresses = await dns.lookup(url.hostname.replace(/^\[|\]$/g, ''), { all: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateIp(address))) throw Object.assign(new Error('Сетевой адрес запрещён'), { status: 400 });
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).request(url, {
      agent: false, signal: AbortSignal.timeout(12000),
      method: body === null ? 'GET' : 'POST',
      lookup: (_hostname, options, callback) => options.all ? callback(null, addresses) : callback(null, addresses[0].address, addresses[0].family),
      headers: { 'user-agent': 'Recipeboibot/0.1', accept: 'text/html,text/plain,application/json', 'accept-encoding': 'identity', ...(body === null ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }) }
    }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.destroy(); resolve({ redirect: response.headers.location }); return;
      }
      const contentType = response.headers['content-type'] || '';
      if (response.statusCode !== 200 || !/(text\/|html|json|xml)/i.test(contentType)) {
        response.destroy(); reject(Object.assign(new Error('Источник недоступен. Пришлите текст или скриншот рецепта.'), { code: 'SOURCE_UNAVAILABLE', status: 422 })); return;
      }
      const chunks = []; let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) { request.destroy(); reject(Object.assign(new Error('Страница слишком большая'), { status: 413 })); return; }
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => resolve({ url: url.toString(), contentType, text: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    request.end(body);
  });
}

export async function safePostJson(input, payload, maxBytes) {
  const url = await assertSafeRemoteUrl(input);
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body) > 32768) throw new Error('JSON request too large');
  const result = await pinnedRequest(url, maxBytes, body);
  // Never forward a POST body or a publisher's key to a redirect destination.
  if (result.redirect) throw Object.assign(new Error('Переадресация API источника не поддерживается'), { status: 422 });
  return JSON.parse(result.text);
}

export async function safeFetchText(input, maxBytes) {
  let url = await assertSafeRemoteUrl(input);
  for (let i = 0; i <= 3; i++) {
    const result = await pinnedRequest(url, maxBytes);
    if (!result.redirect) return result;
    url = await assertSafeRemoteUrl(new URL(result.redirect, url).toString());
  }
  throw Object.assign(new Error('Слишком много переадресаций'), { status: 422 });
}
