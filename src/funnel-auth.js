import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { db } from './db.js';

db.exec(`CREATE TABLE IF NOT EXISTS funnel_credentials (id INTEGER PRIMARY KEY CHECK(id=1), salt TEXT NOT NULL, password_hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS funnel_sessions (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);`);
const digest = value => createHash('sha256').update(value).digest('hex');
const denied = () => Object.assign(new Error('Неверный пароль'), { status: 401 });

// Only a trusted server CLI can create/rotate the dashboard password.
export function createDashboardPassword() {
  const password = randomBytes(24).toString('base64url'), salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('INSERT INTO funnel_credentials(id,salt,password_hash) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET salt=excluded.salt,password_hash=excluded.password_hash').run(salt, hash);
    db.exec('DELETE FROM funnel_sessions');
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return password;
}
export function openDashboardSession(password, at = Date.now()) {
  if (typeof password !== 'string' || !password || password.length > 200) throw denied();
  const credential = db.prepare('SELECT * FROM funnel_credentials WHERE id=1').get();
  if (!credential) throw denied();
  const computed = scryptSync(password, credential.salt, 64);
  if (!timingSafeEqual(computed, Buffer.from(credential.password_hash, 'hex'))) throw denied();
  const token = randomBytes(32).toString('base64url');
  db.prepare('DELETE FROM funnel_sessions WHERE expires_at<=?').run(at);
  db.prepare('INSERT INTO funnel_sessions(token_hash,expires_at) VALUES(?,?)').run(digest(token), at + 7 * 86400000);
  return token;
}
export function dashboardSessionValid(token, at = Date.now()) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
  return Boolean(db.prepare('SELECT 1 FROM funnel_sessions WHERE token_hash=? AND expires_at>?').get(digest(token), at));
}
export function closeDashboardSession(token) {
  if (typeof token === 'string') db.prepare('DELETE FROM funnel_sessions WHERE token_hash=?').run(digest(token));
}
