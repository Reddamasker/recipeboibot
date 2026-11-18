import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export const IMPORT_FAILURE_TTL = 7 * 86400000;
const MAX_TEXT = 12000, MAX_ROWS = 500, PER_USER = 20;
const keyFor = (userId, text) => createHash('sha256').update(JSON.stringify([userId, String(text)])).digest('hex');
function safeText(text) {
  return String(text).replace(/https?:\/\/[^\s<>]+/gi, '[ссылка скрыта]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|\d{6,}:[A-Za-z0-9_-]{25,})\b/g, '[ключ скрыт]')
    .replace(/\b(?:authorization|password|token|secret|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, '[секрет скрыт]');
}

// A separate database: the normal recipes.sqlite backups never contain source text.
export function createImportFailureStore(file, { now = Date.now } = {}) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const db = new DatabaseSync(file);
  fs.chmodSync(file, 0o600);
  db.exec(`PRAGMA secure_delete=ON; PRAGMA journal_mode=DELETE; PRAGMA busy_timeout=100;
    CREATE TABLE IF NOT EXISTS failures (
      id TEXT PRIMARY KEY, source_key TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL,
      source TEXT NOT NULL, input_text TEXT NOT NULL, truncated INTEGER NOT NULL,
      code TEXT NOT NULL, status INTEGER NOT NULL, attempts INTEGER NOT NULL,
      created_at INTEGER NOT NULL, last_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS failures_expiry ON failures(expires_at);
    CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY,value INTEGER NOT NULL);`);
  db.prepare("INSERT OR IGNORE INTO metadata VALUES('since',?)").run(now());
  const count = (key, n = 1) => db.prepare('INSERT INTO metadata VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=value+excluded.value').run(key, n);
  function purge() { const n = db.prepare('DELETE FROM failures WHERE expires_at<=?').run(now()).changes; if (n) count('expired', n); return n; }
  purge();
  return {
    purge,
    capture({ userId, text, source = 'chat', error = {} }) {
      if (!userId || !String(text || '').trim()) return false;
      purge();
      const at = now(), cleaned = safeText(text);
      const code = /^[A-Z][A-Z0-9_]{0,59}$/.test(error.code || '') ? error.code : 'IMPORT_FAILED';
      const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 500;
      db.prepare(`INSERT INTO failures VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source_key) DO UPDATE SET
        code=excluded.code,status=excluded.status,attempts=attempts+1,last_at=excluded.last_at`).run(
        randomUUID(), keyFor(userId, text), userId, source === 'miniapp' ? 'miniapp' : 'chat',
        cleaned.slice(0, MAX_TEXT), Number(cleaned.length > MAX_TEXT), code, status, 1, at, at, at + IMPORT_FAILURE_TTL);
      count('captured');
      const own = db.prepare('DELETE FROM failures WHERE id IN (SELECT id FROM failures WHERE user_id=? ORDER BY created_at DESC,rowid DESC LIMIT -1 OFFSET ?)').run(userId, PER_USER).changes;
      const total = db.prepare('DELETE FROM failures WHERE id IN (SELECT id FROM failures ORDER BY created_at DESC,rowid DESC LIMIT -1 OFFSET ?)').run(MAX_ROWS).changes;
      if (own + total) count('evicted', own + total);
      return true;
    },
    resolved(userId, text) { const n = db.prepare('DELETE FROM failures WHERE source_key=?').run(keyFor(userId, text)).changes; if (n) count('resolved', n); },
    forget(userId) { return db.prepare('DELETE FROM failures WHERE user_id=?').run(userId).changes; },
    remove(id) { purge(); const n = db.prepare('DELETE FROM failures WHERE id=?').run(id).changes; if (n) count('deleted', n); return n; },
    report() {
      purge(); count('owner_reads');
      return { version: 1, retentionDays: 7, maxTextChars: MAX_TEXT, maxRecords: MAX_ROWS,
        counters: Object.fromEntries(db.prepare('SELECT key,value FROM metadata').all().map(r => [r.key,r.value])),
        rows: db.prepare('SELECT id,source,input_text AS text,truncated,code,status,attempts,created_at AS createdAt,last_at AS lastAt,expires_at AS expiresAt FROM failures ORDER BY created_at DESC,rowid DESC').all() };
    },
    close() { db.close(); }
  };
}
