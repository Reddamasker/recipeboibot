import { createHash } from 'node:crypto';
import { db } from './db.js';

const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
export const maxEventId = (event) => createHash('sha256').update(JSON.stringify(canonical(event))).digest('hex');

export function createMaxStore(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS max_chat_bindings (chat_id TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS max_messages (mid TEXT PRIMARY KEY, user_id TEXT NOT NULL, chat_id TEXT NOT NULL, created_at INTEGER NOT NULL, attachments_json TEXT NOT NULL DEFAULT '[]');
    CREATE TABLE IF NOT EXISTS max_callbacks (callback_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS max_inbox (event_id TEXT PRIMARY KEY, event_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS max_inbox_pending ON max_inbox(status, available_at);
  `);
  if (!database.prepare('PRAGMA table_info(max_messages)').all().some((column) => column.name === 'attachments_json')) database.exec("ALTER TABLE max_messages ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]'");
  const id = (value) => String(value);
  return {
    bind(chatId, userId) {
      const existing = database.prepare('SELECT user_id FROM max_chat_bindings WHERE chat_id=?').get(id(chatId));
      if (existing && existing.user_id !== id(userId)) return false;
      database.prepare('INSERT INTO max_chat_bindings(chat_id,user_id,updated_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET chat_id=excluded.chat_id,updated_at=excluded.updated_at').run(id(chatId), id(userId), Date.now());
      return true;
    },
    userForChat(chatId) { return database.prepare('SELECT user_id FROM max_chat_bindings WHERE chat_id=?').get(id(chatId))?.user_id || null; },
    chatForUser(userId) { return database.prepare('SELECT chat_id FROM max_chat_bindings WHERE user_id=?').get(id(userId))?.chat_id || null; },
    rememberMessage(mid, userId, chatId, attachments = []) {
      if (!this.bind(chatId, userId)) throw new Error('MAX chat ownership conflict');
      database.prepare('INSERT OR IGNORE INTO max_messages(mid,user_id,chat_id,created_at,attachments_json) VALUES(?,?,?,?,?)').run(id(mid), id(userId), id(chatId), Date.now(), JSON.stringify(attachments));
    },
    messageMedia(mid) { return JSON.parse(database.prepare('SELECT attachments_json FROM max_messages WHERE mid=?').get(id(mid))?.attachments_json || '[]').filter((attachment) => attachment.type !== 'inline_keyboard'); },
    ownsMessage(mid, userId, chatId) {
      return Boolean(database.prepare('SELECT 1 FROM max_messages WHERE mid=? AND user_id=? AND chat_id=?').get(id(mid), id(userId), id(chatId)));
    },
    rememberCallback(callbackId, userId) {
      database.prepare('INSERT OR IGNORE INTO max_callbacks(callback_id,user_id,created_at) VALUES(?,?,?)').run(id(callbackId), id(userId), Date.now());
    },
    userForCallback(callbackId) { return database.prepare('SELECT user_id FROM max_callbacks WHERE callback_id=?').get(id(callbackId))?.user_id || null; },
    enqueue(event, { eventId = maxEventId(event) } = {}) {
      const json = JSON.stringify(event);
      const inserted = database.prepare('INSERT OR IGNORE INTO max_inbox(event_id,event_json,available_at,created_at) VALUES(?,?,?,?)').run(eventId, json, Date.now(), Date.now()).changes > 0;
      return { eventId, inserted };
    },
    recover() { database.prepare("UPDATE max_inbox SET status='pending' WHERE status='processing'").run(); },
    claim() {
      const row = database.prepare("SELECT * FROM max_inbox WHERE status='pending' AND available_at<=? ORDER BY created_at,rowid LIMIT 1").get(Date.now());
      if (!row) return null;
      database.prepare("UPDATE max_inbox SET status='processing',attempts=attempts+1 WHERE event_id=?").run(row.event_id);
      return { eventId: row.event_id, event: JSON.parse(row.event_json), attempts: row.attempts + 1 };
    },
    complete(eventId) { database.prepare("UPDATE max_inbox SET status='done',event_json='{}' WHERE event_id=?").run(eventId); },
    fail(eventId) { database.prepare("UPDATE max_inbox SET status='failed' WHERE event_id=? AND status='processing'").run(eventId); },
    retry(eventId, attempts, { maxAttempts = 8, delayMs = Math.min(300000, 1000 * 2 ** attempts) } = {}) {
      database.prepare('UPDATE max_inbox SET status=?,available_at=? WHERE event_id=?').run(attempts >= maxAttempts ? 'failed' : 'pending', Date.now() + delayMs, eventId);
    },
    status(eventId) { return database.prepare('SELECT status,attempts FROM max_inbox WHERE event_id=?').get(eventId); }
  };
}

export const maxStore = createMaxStore(db);
export const getMaxChatBinding = (userId) => maxStore.chatForUser(String(userId).replace(/^max:/, ''));
