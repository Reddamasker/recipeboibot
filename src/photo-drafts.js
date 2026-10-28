import { randomBytes } from 'node:crypto';
import { db } from './db.js';
import { recordProduct } from './product-analytics.js';
import { MAX_RECIPE_PHOTOS } from './photo-sources.js';

// Operational references only: no downloaded images or transcripts are stored.
db.exec(`CREATE TABLE IF NOT EXISTS photo_import_drafts (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 chat_id TEXT NOT NULL, actor_id TEXT NOT NULL, parts_json TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1, busy INTEGER NOT NULL DEFAULT 0,
 updated_at TEXT NOT NULL, UNIQUE(user_id,chat_id,actor_id));`);
const parse = row => row ? { ...row, parts: JSON.parse(row.parts_json) } : null;
const cleanup = () => db.prepare('DELETE FROM photo_import_drafts WHERE busy=0 AND updated_at<?').run(new Date(Date.now() - 86400000).toISOString());
cleanup();
setInterval(cleanup, 10 * 60 * 1000).unref();
export function recoverPhotoDrafts() {
  return db.prepare('UPDATE photo_import_drafts SET busy=0 WHERE busy=1').run().changes;
}
export function getPhotoDraft(userId, chatId, actorId) {
  cleanup();
  return parse(db.prepare('SELECT * FROM photo_import_drafts WHERE user_id=? AND chat_id=? AND actor_id=?').get(userId, String(chatId), String(actorId)));
}
export function addPhotoDraft(userId, message) {
  const chatId = String(message.chat.id), actorId = String(message.from.id);
  const old = getPhotoDraft(userId, chatId, actorId);
  if (old?.busy) throw Object.assign(new Error('Предыдущие фото ещё обрабатываются. Дождитесь результата и отправьте новые фото ещё раз.'), { status: 409 });
  const sources = message.recipePhotos || (message.photo?.length ? [message.photo.at(-1)] : []);
  const parts = [...(old?.parts || [])];
  let changed = !old;
  for (const [index, photo] of sources.entries()) {
    const key = String(photo.file_unique_id || photo.file_id);
    const previous = parts.find(p => p.key === key);
    if (previous) {
      // A fresh platform download URL can replace an expired reference without
      // adding a second page. An identical redelivery changes nothing.
      if (previous.fileId !== photo.file_id) { previous.fileId = photo.file_id; changed = true; }
      continue;
    }
    changed = true;
    parts.push({ key, fileId: photo.file_id, order: message.platform === 'max' ? parts.length : Number(message.message_id) * 100 + index,
      caption: String(message.caption || '').slice(0, 2000) });
  }
  if (parts.length > MAX_RECIPE_PHOTOS) throw Object.assign(new Error('В одном рецепте можно собрать до 10 фото. Удалите лишнее фото или завершите текущий рецепт.'), { status: 413 });
  parts.sort((a, b) => a.order - b.order);
  if (!changed) return old;
  const id = old?.id || randomBytes(10).toString('hex');
  db.prepare(`INSERT INTO photo_import_drafts(id,user_id,chat_id,actor_id,parts_json,updated_at) VALUES(?,?,?,?,?,?)
    ON CONFLICT(user_id,chat_id,actor_id) DO UPDATE SET parts_json=excluded.parts_json,revision=revision+1,updated_at=excluded.updated_at`)
    .run(id, userId, chatId, actorId, JSON.stringify(parts), new Date().toISOString());
  if (!old) recordProduct(userId, 'photo_draft_started', { id: `photo-start-${id}`, step: 'import', flowId: id });
  return getPhotoDraft(userId, chatId, actorId);
}
export function changePhotoDraft(draft, action) {
  if (draft.busy) return false;
  if (action === 'cancel' || action === 'remove' && draft.parts.length <= 1) {
    const removed = db.prepare('DELETE FROM photo_import_drafts WHERE id=? AND revision=? AND busy=0').run(draft.id, draft.revision).changes;
    if (removed) recordProduct(draft.user_id, 'photo_draft_cancelled', { id: `photo-cancel-${draft.id}`, step: 'import', flowId: draft.id });
    return Boolean(removed);
  }
  if (action === 'remove') return Boolean(db.prepare('UPDATE photo_import_drafts SET parts_json=?,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND busy=0')
    .run(JSON.stringify(draft.parts.slice(0, -1)), new Date().toISOString(), draft.id, draft.revision).changes);
  return false;
}
export function claimPhotoDraft(draft) {
  return Boolean(db.prepare('UPDATE photo_import_drafts SET busy=1 WHERE id=? AND revision=? AND busy=0').run(draft.id, draft.revision).changes);
}
export function finishPhotoDraft(draft, success) {
  if (success) db.prepare('DELETE FROM photo_import_drafts WHERE id=? AND revision=?').run(draft.id, draft.revision);
  else db.prepare('UPDATE photo_import_drafts SET busy=0 WHERE id=?').run(draft.id);
}
