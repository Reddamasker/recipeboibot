import { maxEventId, maxStore } from './max-store.js';
import { sanitizeWebLoginEvent } from './web-login-prototype.js';
import { MaxApiError, isPermanentMaxError, withMaxDelivery } from './max-api-error.js';

const validId = (value) => typeof value === 'number' ? Number.isSafeInteger(value) && value > 0 : /^[1-9]\d*$/.test(String(value ?? ''));
const user = (from) => ({ id: `max:${from.user_id}`, first_name: from.first_name || from.name || 'Пользователь', ...(from.last_name ? { last_name: from.last_name } : {}), ...(from.username ? { username: from.username } : {}), is_bot: false });
const privateMessage = (from, mid) => ({ from: user(from), chat: { id: `max:${from.user_id}`, type: 'private' }, message_id: String(mid || ''), platform: 'max' });

export function normalizeMaxUpdate(event, { store = maxStore, botId, eventId } = {}) {
  if (!event || typeof event !== 'object') return null;
  if (event.update_type === 'bot_started') {
    if (!validId(event.user?.user_id) || event.user.is_bot || event.chat_id == null || !store.bind(event.chat_id, event.user.user_id)) return null;
    return { message: { ...privateMessage(event.user, `start:${event.timestamp}`), ...(event._webLoginRequest ? { webLoginRequest:event._webLoginRequest } : {}), text: `/start${event.payload ? ` ${String(event.payload).replace(/[\r\n]/g, '')}` : ''}` } };
  }
  if (event.update_type === 'message_created') {
    const source = event.message;
    if (!validId(source?.sender?.user_id) || source.sender.is_bot || source.recipient?.chat_type !== 'dialog' || source.recipient.chat_id == null || !store.bind(source.recipient.chat_id, source.sender.user_id)) return null;
    // A forward can contain only LinkedMessage: body=null is explicitly valid.
    // Use this new event's identity rather than the old forwarded message mid.
    const forwarded = source.link?.type === 'forward' ? source.link.message : null;
    const mid = source.body?.mid || `event:${eventId || maxEventId(event)}`;
    const message = { ...privateMessage(source.sender, mid), date: Math.floor(Number(source.timestamp || event.timestamp) / 1000), text: [source.body?.text, forwarded?.text].filter(Boolean).join('\n\n') };
    for (const attachment of [...(source.body?.attachments || []), ...(forwarded?.attachments || [])]) {
      if (['file', 'video'].includes(attachment.type)) {
        message.maxUnsupportedMedia ||= [];
        message.maxUnsupportedMedia.push(attachment.type);
        continue;
      }
      if (attachment.type === 'share' && attachment.payload?.url) { message.text += `${message.text ? '\n\n' : ''}${attachment.payload.url}`; continue; }
      if (!attachment.payload?.url) continue;
      if (attachment.type === 'image') {
        message.photo ||= [];
        message.photo.push({ file_id: attachment.payload.url, file_unique_id: attachment.payload.token || attachment.payload.photo_id || mid });
      }
      if (attachment.type === 'audio') {
        if (attachment.transcription && !message.text) { message.text = attachment.transcription; continue; }
        message.audio = { file_id: attachment.payload.url, file_unique_id: attachment.payload.token || mid, ...(Number.isFinite(attachment.duration) ? { duration: attachment.duration } : {}), ...(attachment.mime_type ? { mime_type: attachment.mime_type } : {}) };
      }
    }
    if (message.photo?.length) message.caption = message.text;
    return { message };
  }
  if (event.update_type === 'message_callback') {
    const source = event.message, actor = event.callback?.user;
    if (!validId(actor?.user_id) || actor.is_bot || !event.callback.callback_id || typeof event.callback.payload !== 'string' || !source?.sender?.is_bot || (botId != null && String(source.sender.user_id) !== String(botId)) || source.recipient?.chat_type !== 'dialog' || !source.body?.mid) return null;
    const owner = store.userForChat(source.recipient.chat_id);
    if (owner !== String(actor.user_id) || !store.ownsMessage(source.body.mid, owner, source.recipient.chat_id)) return null;
    store.rememberCallback(event.callback.callback_id, owner);
    return { callback_query: { id: event.callback.callback_id, data: event.callback.payload, from: user(actor), message: { ...privateMessage(actor, source.body.mid), text: source.body.text || '' } } };
  }
  return null;
}

export function enqueueMaxUpdate(event, { store = maxStore } = {}) {
  if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.update_type !== 'string') throw new Error('Invalid MAX webhook event');
  // Hash the original delivery for stable deduplication even after its login
  // request changes state; only the sanitized event is persisted.
  return store.enqueue(sanitizeWebLoginEvent(event), { eventId:maxEventId(event) });
}

export function startMaxWorker(handleUpdate, { store = maxStore, botId, pollMs = 500, retryDelayMs, onError = () => {} } = {}) {
  if (typeof handleUpdate !== 'function') throw new Error('MAX worker requires an update handler');
  let stopping = false, timer, running = null;
  store.recover();
  async function drain() {
    while (!stopping) {
      const item = store.claim();
      if (!item) break;
      try {
        const update = normalizeMaxUpdate(item.event, { store, botId, eventId: item.eventId });
        if (update) await withMaxDelivery(() => handleUpdate({ ...update, update_id: `max:${item.eventId}` }));
        store.complete(item.eventId);
      } catch (error) {
        const terminal = isPermanentMaxError(error);
        if (terminal) store.fail(item.eventId);
        else store.retry(item.eventId, item.attempts, retryDelayMs === undefined ? {} : { delayMs: retryDelayMs });
        const diagnostic = error instanceof MaxApiError ? { status: error.status, reason: error.reason, providerCode: error.providerCode, apiMethod: error.apiMethod, apiResource: error.apiResource } : {};
        try { onError({ eventId: item.eventId, attempts: item.attempts, terminal, ...diagnostic }); } catch {}
      }
    }
  }
  function wake() {
    if (stopping || running) return running;
    clearTimeout(timer);
    running = drain().finally(() => { running = null; if (!stopping) { timer = setTimeout(wake, pollMs); timer.unref(); } });
    return running;
  }
  wake();
  return { wake, async stop() { stopping = true; clearTimeout(timer); await running; } };
}
