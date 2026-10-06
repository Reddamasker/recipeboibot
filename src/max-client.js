import { config } from './config.js';
import { maxStore } from './max-store.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const htmlEntity = (match, entity) => {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  if (named[entity]) return named[entity];
  const code = /^#x[0-9a-f]+$/i.test(entity) ? Number.parseInt(entity.slice(2), 16) : /^#\d+$/.test(entity) ? Number(entity.slice(1)) : NaN;
  return Number.isSafeInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : match;
};
export function splitMaxText(input, limit = 3900) {
  const original = String(input || '');
  if (original.length <= limit) return { texts: [original], format: 'html' };
  let text = original.replace(/<br\s*\/?\s*>/gi, '\n').replace(/<\/p>/gi, '\n\n').replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gis, '$2 ($1)').replace(/<[^>]*>/g, '').replace(/&([a-z]+|#\d+|#x[0-9a-f]+);/gi, htmlEntity);
  const texts = [];
  while (text.length > limit) {
    let boundary = text.lastIndexOf('\n\n', limit);
    if (boundary < limit / 2) boundary = text.lastIndexOf('\n', limit);
    if (boundary < limit / 2) boundary = text.lastIndexOf(' ', limit);
    if (boundary < limit / 2) boundary = limit;
    if (/^[\uD800-\uDBFF]$/.test(text[boundary - 1])) boundary--;
    texts.push(text.slice(0, boundary).trimEnd());
    text = text.slice(boundary).trimStart();
  }
  if (text || !texts.length) texts.push(text);
  return { texts, format: undefined };
}
export function maxUserId(value) {
  const match = String(value ?? '').match(/^max:([1-9]\d*)$/);
  if (!match) throw new Error('MAX private target must be max:<user_id>');
  return match[1];
}

export function maxKeyboard(markup, username) {
  if (!markup?.inline_keyboard) return [];
  const buttons = markup.inline_keyboard.map((row) => row.map((button) => {
    const text = String(button.text || '').slice(0, 128);
    if (button.callback_data != null) return { type: 'callback', text, payload: String(button.callback_data) };
    if (button.web_app?.url) {
      if (!username) throw new Error('MAX bot username required for mini app button');
      const url = new URL(button.web_app.url);
      const payload = Buffer.from(JSON.stringify(Object.fromEntries(url.searchParams)), 'utf8').toString('base64url');
      if (payload.length > 512) throw new Error('MAX mini app route is too long');
      return { type: 'open_app', text, web_app: username, payload };
    }
    if (button.url) return { type: 'link', text, url: button.url };
    return { type: 'message', text };
  }));
  return buttons.length ? [{ type: 'inline_keyboard', payload: { buttons } }] : [];
}

export function createMaxClient(settings, { fetchImpl = fetch, store = maxStore, sleep = wait, now = Date.now } = {}) {
  const origin = new URL(settings.maxApiOrigin || 'https://platform-api2.max.ru');
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/' || origin.hostname !== 'platform-api2.max.ru' || origin.port) throw new Error('Invalid MAX API origin');
  const limiter = new Map();
  async function limited(key, action) {
    const state = limiter.get(key) || { tail: Promise.resolve(), next: 0 };
    limiter.set(key, state);
    const result = state.tail.catch(() => {}).then(async () => {
      const delay = Math.max(0, state.next - now());
      if (delay) await sleep(delay);
      state.next = now() + 550;
      return action();
    });
    state.tail = result;
    return result;
  }
  async function api(path, { method = 'GET', query = {}, body } = {}) {
    if (!settings.maxToken) throw new Error('MAX bot token is not configured');
    if (!/^\/[a-zA-Z0-9/_-]+$/.test(path)) throw new Error('Invalid MAX API path');
    const url = new URL(path, origin);
    for (const [key, value] of Object.entries(query)) if (value != null) url.searchParams.set(key, String(value));
    let response;
    try {
      response = await fetchImpl(url, { method, redirect: 'error', signal: AbortSignal.timeout(15000), headers: { Authorization: settings.maxToken, 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    } catch { throw new Error('MAX API network request failed'); }
    let result;
    try { result = await response.json(); } catch { throw new Error(`MAX API invalid response (${response.status})`); }
    if (!response.ok || result.success === false || result.error || result.code) throw new Error(`MAX API request failed (${response.status})`);
    return result;
  }
  async function chatCall(method, body = {}) {
    if (method === 'answerCallbackQuery') {
      const userId = store.userForCallback(body.callback_query_id);
      if (!userId) throw new Error('Unknown MAX callback');
      // Unlike Telegram, MAX rejects an empty answer: it requires a message
      // or a notification. Acknowledge receipt before the shared action runs.
      return limited(userId, () => api('/answers', { method: 'POST', query: { callback_id: body.callback_query_id }, body: { notification: body.text?.trim() || 'Принято' } }));
    }
    const userId = maxUserId(body.chat_id);
    const chatId = store.chatForUser(userId);
    if (method === 'sendChatAction') {
      // MAX only documents this endpoint for group chats. Private dialogues
      // still process voice requests without a transport-specific typing hint.
      return true;
    }
    const attachments = body.max_ephemeral ? [] : maxKeyboard(body.reply_markup, settings.maxBotUsername);
    if (['editMessageText', 'editMessageReplyMarkup'].includes(method)) {
      if (!chatId || !store.ownsMessage(body.message_id, userId, chatId)) throw new Error('MAX message ownership denied');
      if (method === 'editMessageText' && String(body.text || '').length > 4000) return chatCall('sendMessage', body);
      const update = { ...(method === 'editMessageReplyMarkup' || body.reply_markup ? { attachments: [...store.messageMedia(body.message_id), ...attachments] } : {}), ...(method === 'editMessageText' ? { text: body.text, format: 'html' } : {}) };
      return limited(userId, () => api('/messages', { method: 'PUT', query: { message_id: body.message_id }, body: update }));
    }
    if (!['sendMessage', 'sendPhoto'].includes(method)) throw new Error('Unsupported MAX chat operation');
    const split = splitMaxText(method === 'sendPhoto' ? body.caption || '' : body.text || '');
    const messageBody = { text: split.texts.at(-1), attachments, ...(split.format ? { format: split.format } : {}), ...(body.disable_notification ? { notify: false } : {}) };
    if (method === 'sendPhoto' && typeof body.photo === 'string') {
      try { const image = new URL(body.photo); if (image.protocol === 'https:' && !image.username && !image.password) messageBody.attachments = [{ type: 'image', payload: { url: image.href } }, ...attachments]; } catch {}
    }
    if (!messageBody.text && !messageBody.attachments.length) messageBody.text = 'Рецепт';
    for (const text of split.texts.slice(0, -1)) await sendBody({ text, ...(body.disable_notification ? { notify: false } : {}) });
    return sendBody(messageBody);
    async function sendBody(outbound) {
    const result = await limited(userId, () => api('/messages', { method: 'POST', query: { user_id: userId }, body: outbound }));
    const message = result.message;
    if (!message?.body?.mid || message.recipient?.chat_id == null || message.recipient.chat_type !== 'dialog') throw new Error('MAX send response has no private message');
    // Persist reusable attachment requests: editing a MAX keyboard replaces the
    // entire attachments array, so image media must accompany the new keyboard.
    const media = (outbound.attachments || []).filter((attachment) => attachment.type !== 'inline_keyboard').map((attachment) => {
      const returned = message.body.attachments?.find((item) => item.type === attachment.type && item.payload?.token);
      return returned ? { type: attachment.type, payload: { token: returned.payload.token } } : attachment;
    });
    if (!body.max_ephemeral) store.rememberMessage(message.body.mid, userId, message.recipient.chat_id, media);
    return { message_id: message.body.mid, chat: { id: `max:${userId}`, type: 'private' }, text: message.body.text };
    }
  }
  return { api, chatCall };
}

let activeClient;
const client = () => activeClient ||= createMaxClient(config);
export const maxApiCall = (path, options) => client().api(path, options);
export const maxChatCall = (method, body) => client().chatCall(method, body);
