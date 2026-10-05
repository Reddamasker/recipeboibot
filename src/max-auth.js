import { createHmac, timingSafeEqual } from 'node:crypto';

const unauthorized = (message) => Object.assign(new Error(message), { status: 401 });
export function maxIdentity(user) {
  const id = user?.id ?? user?.user_id;
  if (!/^[1-9][0-9]{0,18}$/.test(String(id)) || (typeof id === 'number' && !Number.isSafeInteger(id))) throw unauthorized('Неверный MAX ID');
  return { id: `max:${id}`, first_name: String(user.first_name || '').slice(0, 100), last_name: String(user.last_name || '').slice(0, 100), username: user.username ? String(user.username).slice(0, 64) : undefined, is_bot: Boolean(user.is_bot) };
}

export function validateMaxInitData(initData, botToken, maxAgeSeconds = 3600) {
  if (!initData || !botToken || initData.length > 16000) throw unauthorized('Нет данных MAX');
  const params = new URLSearchParams(initData);
  if (new Set(params.keys()).size !== [...params.keys()].length) throw unauthorized('Повторяющиеся поля MAX');
  const hash = params.get('hash');
  if (!/^[a-f0-9]{64}$/i.test(hash || '')) throw unauthorized('Неверная подпись MAX');
  params.delete('hash');
  const check = [...params].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => `${key}=${value}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(check).digest();
  if (!timingSafeEqual(Buffer.from(hash, 'hex'), expected)) throw unauthorized('Неверная подпись MAX');
  const date = Number(params.get('auth_date'));
  if (!params.get('auth_date') || !Number.isSafeInteger(date) || Math.abs(Date.now() / 1000 - date) > maxAgeSeconds) throw unauthorized('Сессия MAX устарела');
  let user;
  try { user = JSON.parse(params.get('user') || ''); } catch { throw unauthorized('Неверные данные пользователя MAX'); }
  const identity = maxIdentity(user);
  if (identity.is_bot) throw unauthorized('Неверный пользователь MAX');
  return identity;
}

export function verifyMaxWebhookSecret(header, expected) {
  if (typeof header !== 'string' || typeof expected !== 'string' || !expected || header.length > 256) return false;
  const supplied = Buffer.from(header), wanted = Buffer.from(expected);
  return supplied.length === wanted.length && timingSafeEqual(supplied, wanted);
}
