import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
export const db = new DatabaseSync(config.databasePath);
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  telegram_id TEXT NOT NULL UNIQUE,
  username TEXT,
  display_name TEXT NOT NULL,
  is_allowed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS private_test_profiles (
  owner_user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  test_user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  CHECK(owner_user_id <> test_user_id)
);
CREATE TABLE IF NOT EXISTS recipes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('draft','ready','archived')),
  origin TEXT NOT NULL DEFAULT 'imported' CHECK(origin IN ('imported','generated')),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  servings INTEGER,
  prep_minutes INTEGER,
  cook_minutes INTEGER,
  ingredients_json TEXT NOT NULL DEFAULT '[]',
  steps_json TEXT NOT NULL DEFAULT '[]',
  tags_json TEXT NOT NULL DEFAULT '[]',
  warnings_json TEXT NOT NULL DEFAULT '[]',
  source_url TEXT,
  source_type TEXT NOT NULL DEFAULT 'text',
  source_name TEXT,
  notes TEXT NOT NULL DEFAULT '',
  extraction_version TEXT NOT NULL DEFAULT '1',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS recipes_owner_updated ON recipes(user_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS recipe_images (
  recipe_id TEXT PRIMARY KEY REFERENCES recipes(id) ON DELETE CASCADE,
  mime TEXT NOT NULL CHECK(mime IN ('image/jpeg','image/png','image/webp')),
  bytes BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS recipe_shares (
  token TEXT PRIMARY KEY,
  recipe_id TEXT NOT NULL UNIQUE REFERENCES recipes(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS recipe_shares_recipe ON recipe_shares(recipe_id);
CREATE TABLE IF NOT EXISTS import_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipe_id TEXT REFERENCES recipes(id) ON DELETE SET NULL,
  source_type TEXT NOT NULL,
  status TEXT NOT NULL,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS provider_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  operation TEXT NOT NULL,
  model TEXT NOT NULL,
  input_units INTEGER NOT NULL DEFAULT 0,
  output_units INTEGER NOT NULL DEFAULT 0,
  reasoning_units INTEGER NOT NULL DEFAULT 0,
  cached_input_units INTEGER NOT NULL DEFAULT 0,
  total_units INTEGER NOT NULL DEFAULT 0,
  usage_complete INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  provider_status INTEGER,
  error_code TEXT,
  error_type TEXT,
  error_message TEXT,
  request_id TEXT,
  client_request_id TEXT,
  incomplete_reason TEXT,
  retry_after TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS processed_updates (
  update_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'done',
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS ai_reservations (id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS pending_intents (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS recipe_suggestions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  query TEXT NOT NULL,
  recipe_json TEXT NOT NULL,
  recipe_id TEXT REFERENCES recipes(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS suggestions_owner_query ON recipe_suggestions(user_id, query, created_at DESC);
CREATE TABLE IF NOT EXISTS search_offers (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  query TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS telegram_groups (
  chat_id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK(type IN ('group','supergroup')),
  title TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`);

function ensureColumn(table, name, definition) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some((column) => column.name === name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
}

ensureColumn('users', 'group_access', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('recipes', 'source_key', 'TEXT');
ensureColumn('recipes', 'thumbnail_url', 'TEXT');
ensureColumn('import_jobs', 'source_key', 'TEXT');
ensureColumn('import_jobs', 'source_url', 'TEXT');
ensureColumn('import_jobs', 'label', "TEXT NOT NULL DEFAULT 'Источник'");
ensureColumn('import_jobs', 'thumbnail_url', 'TEXT');
ensureColumn('import_jobs', 'error_message', 'TEXT');
ensureColumn('processed_updates', 'status', "TEXT NOT NULL DEFAULT 'done'");
ensureColumn('processed_updates', 'updated_at', 'TEXT');
ensureColumn('provider_requests', 'provider_status', 'INTEGER');
ensureColumn('provider_requests', 'reasoning_units', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('provider_requests', 'cached_input_units', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('provider_requests', 'total_units', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('provider_requests', 'usage_complete', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('provider_requests', 'error_code', 'TEXT');
ensureColumn('provider_requests', 'error_type', 'TEXT');
ensureColumn('provider_requests', 'error_message', 'TEXT');
ensureColumn('provider_requests', 'request_id', 'TEXT');
ensureColumn('provider_requests', 'client_request_id', 'TEXT');
ensureColumn('provider_requests', 'incomplete_reason', 'TEXT');
ensureColumn('provider_requests', 'retry_after', 'TEXT');
db.exec(`
CREATE UNIQUE INDEX IF NOT EXISTS recipes_owner_source_key ON recipes(user_id, source_key) WHERE source_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS jobs_owner_source_key ON import_jobs(user_id, source_key) WHERE source_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS jobs_owner_updated ON import_jobs(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS telegram_groups_owner_status ON telegram_groups(owner_user_id, status);
UPDATE processed_updates SET updated_at=created_at WHERE updated_at IS NULL;
UPDATE recipes SET status='ready' WHERE status='draft' AND id IN (SELECT recipe_id FROM import_jobs WHERE status='awaiting_review' AND recipe_id IS NOT NULL);
UPDATE import_jobs SET status='ready' WHERE status='awaiting_review' AND recipe_id IS NOT NULL;
`);

for (const row of db.prepare('SELECT id,source_url,thumbnail_url FROM recipes WHERE source_key IS NULL AND source_url IS NOT NULL').all()) {
  try {
    const url = new URL(row.source_url); let sourceKey; let thumbnailUrl = row.thumbnail_url;
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    let videoId = null;
    if (host === 'youtu.be') videoId = url.pathname.split('/').filter(Boolean)[0];
    else if (['youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(host)) videoId = url.pathname === '/watch' ? url.searchParams.get('v') : url.pathname.match(/^\/(?:shorts|embed)\/([A-Za-z0-9_-]{11})/)?.[1];
    if (/^[A-Za-z0-9_-]{11}$/.test(videoId || '')) { sourceKey = `youtube:${videoId}`; thumbnailUrl ||= `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`; }
    else {
      url.hash = '';
      for (const key of [...url.searchParams.keys()]) if (/^(utm_.+|si|fbclid|gclid|yclid|mc_.+)$/i.test(key)) url.searchParams.delete(key);
      url.searchParams.sort(); if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/+$/, '') || '/';
      sourceKey = `url:${url.toString()}`;
    }
    db.prepare('UPDATE recipes SET source_key=?,thumbnail_url=? WHERE id=?').run(sourceKey, thumbnailUrl || null, row.id);
  } catch { /* keep legacy source without an unsafe guess */ }
}

const now = () => new Date().toISOString();
const parseRecipe = (row) => row ? ({
  ...row,
  servings: row.servings ?? null,
  prepMinutes: row.prep_minutes ?? null,
  cookMinutes: row.cook_minutes ?? null,
  ingredients: JSON.parse(row.ingredients_json),
  steps: JSON.parse(row.steps_json),
  tags: JSON.parse(row.tags_json),
  warnings: JSON.parse(row.warnings_json),
  sourceUrl: row.source_url,
  sourceKey: row.source_key,
  sourceType: row.source_type,
  sourceName: row.source_name,
  thumbnailUrl: row.thumbnail_url,
  createdAt: row.created_at,
  updatedAt: row.updated_at
}) : null;

export function upsertTelegramUser(telegramUser) {
  const telegramId = String(telegramUser.id);
  const existing = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId);
  const displayName = [telegramUser.first_name, telegramUser.last_name].filter(Boolean).join(' ') || telegramUser.username || 'Гость';
  if (existing) {
    db.prepare('UPDATE users SET username=?, display_name=?, updated_at=? WHERE id=?').run(telegramUser.username || null, displayName, now(), existing.id);
    return db.prepare('SELECT * FROM users WHERE id=?').get(existing.id);
  }
  const user = { id: randomUUID(), telegramId, username: telegramUser.username || null, displayName, at: now() };
  db.prepare('INSERT INTO users(id,telegram_id,username,display_name,is_allowed,created_at,updated_at) VALUES(?,?,?,?,0,?,?)')
    .run(user.id, user.telegramId, user.username, user.displayName, user.at, user.at);
  return db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
}

export function allowUser(userId) { db.prepare('UPDATE users SET is_allowed=1,updated_at=? WHERE id=?').run(now(), userId); }

// Only the server-side admin CLI can activate this mapping. Telegram identity
// is validated normally; no query parameter/header can select another profile.
// Group bindings deliberately continue to use the original account.
export function resolvePrivateTelegramUser(telegramUser) {
  const owner = upsertTelegramUser(telegramUser);
  return db.prepare(`SELECT u.* FROM private_test_profiles p JOIN users u ON u.id=p.test_user_id
    WHERE p.owner_user_id=?`).get(owner.id) || owner;
}

export function privateTestProfileStatus(telegramId) {
  const owner = getUserByTelegramId(telegramId);
  if (!owner) throw new Error('Telegram account not found');
  const mapping = db.prepare('SELECT * FROM private_test_profiles WHERE owner_user_id=?').get(owner.id);
  return { ownerUserId: owner.id, active: Boolean(mapping), testUserId: mapping?.test_user_id || null };
}

export function activatePrivateTestProfile(telegramId) {
  if (!/^[1-9][0-9]*$/.test(String(telegramId))) throw new Error('Expected a real Telegram account ID');
  db.exec('BEGIN IMMEDIATE');
  try {
    const status = privateTestProfileStatus(telegramId);
    if (!status.active) {
      const owner = getUserById(status.ownerUserId), id = randomUUID(), at = now();
      db.prepare(`INSERT INTO users(id,telegram_id,username,display_name,is_allowed,created_at,updated_at)
        VALUES(?,?,?,?,0,?,?)`).run(id, `private-test:${id}`, owner.username, owner.display_name, at, at);
      db.prepare('INSERT INTO private_test_profiles(owner_user_id,test_user_id,created_at) VALUES(?,?,?)')
        .run(owner.id, id, at);
    }
    const result = privateTestProfileStatus(telegramId);
    db.exec('COMMIT');
    return result;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function deactivatePrivateTestProfile(telegramId) {
  const status = privateTestProfileStatus(telegramId);
  // Keep test history and AI accounting; only remove the routing override.
  db.prepare('DELETE FROM private_test_profiles WHERE owner_user_id=?').run(status.ownerUserId);
  return privateTestProfileStatus(telegramId);
}

export function getUserByTelegramId(id) { return db.prepare('SELECT * FROM users WHERE telegram_id=?').get(String(id)); }
export function getUserById(id) { return db.prepare('SELECT * FROM users WHERE id=?').get(id); }

export const GROUP_LIMIT = 3;

export function setGroupAccessByTelegramId(telegramId, enabled) {
  const result = db.prepare('UPDATE users SET group_access=?,updated_at=? WHERE telegram_id=?').run(enabled ? 1 : 0, now(), String(telegramId));
  return result.changes ? getUserByTelegramId(telegramId) : null;
}

export function activateTelegramGroup(ownerUserId, chat) {
  const chatId = String(chat.id);
  db.exec('BEGIN IMMEDIATE');
  try {
    const owner = db.prepare('SELECT * FROM users WHERE id=?').get(ownerUserId);
    if (!owner?.group_access) { db.exec('COMMIT'); return { state: 'forbidden' }; }
    const existing = db.prepare('SELECT * FROM telegram_groups WHERE chat_id=?').get(chatId);
    if (existing?.status === 'active' && existing.owner_user_id === ownerUserId) {
      db.prepare('UPDATE telegram_groups SET type=?,title=?,updated_at=? WHERE chat_id=?').run(chat.type, chat.title || '', now(), chatId);
      const count = db.prepare("SELECT COUNT(*) AS count FROM telegram_groups WHERE owner_user_id=? AND status='active'").get(ownerUserId).count;
      db.exec('COMMIT');
      return { state: 'active', group: getActiveTelegramGroup(chatId), count, limit: GROUP_LIMIT };
    }
    const count = db.prepare("SELECT COUNT(*) AS count FROM telegram_groups WHERE owner_user_id=? AND status='active' AND chat_id<>?").get(ownerUserId, chatId).count;
    if (count >= GROUP_LIMIT) { db.exec('COMMIT'); return { state: 'limit', count, limit: GROUP_LIMIT }; }
    const at = now();
    db.prepare(`INSERT INTO telegram_groups(chat_id,owner_user_id,type,title,status,created_at,updated_at)
      VALUES(?,?,?,?, 'active',?,?)
      ON CONFLICT(chat_id) DO UPDATE SET owner_user_id=excluded.owner_user_id,type=excluded.type,title=excluded.title,status='active',updated_at=excluded.updated_at`)
      .run(chatId, ownerUserId, chat.type, chat.title || '', at, at);
    db.exec('COMMIT');
    return { state: 'activated', group: getActiveTelegramGroup(chatId), count: count + 1, limit: GROUP_LIMIT };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function getActiveTelegramGroup(chatId) {
  return db.prepare(`SELECT g.*,u.telegram_id,u.username,u.display_name,u.group_access
    FROM telegram_groups g JOIN users u ON u.id=g.owner_user_id
    WHERE g.chat_id=? AND g.status='active'`).get(String(chatId)) || null;
}

export function deactivateTelegramGroup(chatId) {
  return db.prepare("UPDATE telegram_groups SET status='inactive',updated_at=? WHERE chat_id=? AND status='active'").run(now(), String(chatId)).changes > 0;
}

export function listActiveTelegramGroups(ownerUserId) {
  return db.prepare("SELECT * FROM telegram_groups WHERE owner_user_id=? AND status='active' ORDER BY created_at").all(ownerUserId);
}

const parseJob = (row) => row ? ({ ...row, userId: row.user_id, recipeId: row.recipe_id, sourceType: row.source_type, sourceKey: row.source_key, sourceUrl: row.source_url, thumbnailUrl: row.thumbnail_url, errorCode: row.error_code, errorMessage: row.error_message, createdAt: row.created_at, updatedAt: row.updated_at }) : null;

export function claimImport(userId, { sourceType, sourceKey = null, sourceUrl = null, label = 'Источник', thumbnailUrl = null }) {
  db.exec('BEGIN IMMEDIATE');
  try {
    if (sourceKey) {
      const recipe = db.prepare('SELECT * FROM recipes WHERE user_id=? AND source_key=?').get(userId, sourceKey);
      if (recipe) {
        if (recipe.status === 'archived') db.prepare("UPDATE recipes SET status='ready',updated_at=? WHERE id=?").run(now(), recipe.id);
        const restored = db.prepare('SELECT * FROM recipes WHERE id=?').get(recipe.id);
        db.exec('COMMIT'); return { state: 'existing', recipe: parseRecipe(restored) };
      }
      const current = db.prepare('SELECT * FROM import_jobs WHERE user_id=? AND source_key=?').get(userId, sourceKey);
      if (current) {
        if (current.recipe_id) {
          const linked = db.prepare('SELECT * FROM recipes WHERE id=? AND user_id=?').get(current.recipe_id, userId);
          if (linked) { db.exec('COMMIT'); return { state: 'existing', recipe: parseRecipe(linked) }; }
        }
        if (!['failed', 'interrupted'].includes(current.status)) { db.exec('COMMIT'); return { state: 'processing', job: parseJob(current) }; }
        const at = now();
        db.prepare("UPDATE import_jobs SET status='received',source_type=?,source_url=?,label=?,thumbnail_url=?,error_code=NULL,error_message=NULL,updated_at=? WHERE id=?")
          .run(sourceType, sourceUrl, label, thumbnailUrl, at, current.id);
        db.exec('COMMIT');
        return { state: 'claimed', job: parseJob(db.prepare('SELECT * FROM import_jobs WHERE id=?').get(current.id)) };
      }
    }
    const job = { id: randomUUID(), userId, sourceType, sourceKey, sourceUrl, label, thumbnailUrl, at: now() };
    db.prepare('INSERT INTO import_jobs(id,user_id,source_type,status,source_key,source_url,label,thumbnail_url,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(job.id, userId, sourceType, 'received', sourceKey, sourceUrl, label, thumbnailUrl, job.at, job.at);
    db.exec('COMMIT');
    return { state: 'claimed', job: parseJob(db.prepare('SELECT * FROM import_jobs WHERE id=?').get(job.id)) };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
export function updateJob(id, status, fields = {}) {
  db.prepare('UPDATE import_jobs SET status=?,recipe_id=COALESCE(?,recipe_id),error_code=?,error_message=?,thumbnail_url=COALESCE(?,thumbnail_url),updated_at=? WHERE id=?')
    .run(status, fields.recipeId || null, fields.errorCode || null, fields.errorMessage ? String(fields.errorMessage).slice(0, 300) : null, fields.thumbnailUrl || null, now(), id);
}
export function listImportJobs(userId) { return db.prepare("SELECT * FROM import_jobs WHERE user_id=? AND status IN ('received','fetching','extracting','normalizing') ORDER BY updated_at DESC LIMIT 20").all(userId).map(parseJob); }
export function interruptActiveJobs() { return db.prepare("UPDATE import_jobs SET status='interrupted',error_code='PROCESS_INTERRUPTED',error_message='Обработка была прервана. Отправьте тот же источник ещё раз — дубль не создастся.',updated_at=? WHERE status IN ('received','fetching','extracting','normalizing')").run(now()).changes; }
export function setPendingIntent(userId, payload) {
  const at = now();
  db.prepare('INSERT INTO pending_intents(user_id,payload_json,created_at,updated_at) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET payload_json=excluded.payload_json,updated_at=excluded.updated_at')
    .run(userId, JSON.stringify(payload), at, at);
}
export function getPendingIntent(userId) {
  const row = db.prepare('SELECT payload_json,updated_at FROM pending_intents WHERE user_id=?').get(userId);
  if (!row || Date.now() - Date.parse(row.updated_at) > 24 * 60 * 60 * 1000) { if (row) clearPendingIntent(userId); return null; }
  try { return JSON.parse(row.payload_json); } catch { clearPendingIntent(userId); return null; }
}
export function clearPendingIntent(userId) { db.prepare('DELETE FROM pending_intents WHERE user_id=?').run(userId); }

export function createSearchOffer(userId, query) {
  const id = randomUUID();
  db.prepare('DELETE FROM search_offers WHERE created_at<?').run(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());
  db.prepare('INSERT INTO search_offers(id,user_id,query,created_at) VALUES(?,?,?,?)').run(id, userId, query, now());
  return id;
}
export function getSearchOffer(userId, id) {
  const row = db.prepare('SELECT query,created_at FROM search_offers WHERE id=? AND user_id=?').get(id, userId);
  return row && Date.now() - Date.parse(row.created_at) < 24 * 60 * 60 * 1000 ? row : null;
}

const parseSuggestion = (row) => row ? { id: row.id, query: row.query, recipe: JSON.parse(row.recipe_json), recipeId: row.recipe_id, createdAt: row.created_at } : null;
export function getRecipeSuggestion(userId, id) {
  const row = db.prepare('SELECT * FROM recipe_suggestions WHERE id=? AND user_id=?').get(id, userId);
  return row && Date.now() - Date.parse(row.created_at) < 24 * 60 * 60 * 1000 ? parseSuggestion(row) : null;
}
export function findRecipeSuggestion(userId, query) {
  const row = db.prepare('SELECT * FROM recipe_suggestions WHERE user_id=? AND query=? AND recipe_id IS NULL ORDER BY created_at DESC LIMIT 1').get(userId, query);
  return row && Date.now() - Date.parse(row.created_at) < 24 * 60 * 60 * 1000 ? parseSuggestion(row) : null;
}
export function createRecipeSuggestion(userId, query, recipe) {
  const id = randomUUID();
  db.prepare('DELETE FROM recipe_suggestions WHERE created_at<?').run(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());
  db.prepare('INSERT INTO recipe_suggestions(id,user_id,query,recipe_json,created_at) VALUES(?,?,?,?,?)').run(id, userId, query, JSON.stringify(recipe), now());
  return getRecipeSuggestion(userId, id);
}
export function saveRecipeSuggestion(userId, id) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const suggestion = getRecipeSuggestion(userId, id);
    if (!suggestion) { db.exec('COMMIT'); return null; }
    if (suggestion.recipeId) { const recipe = getRecipe(userId, suggestion.recipeId); db.exec('COMMIT'); return recipe; }
    const recipe = createRecipe(userId, { ...suggestion.recipe, origin: 'generated', status: 'ready', sourceType: 'generated', sourceName: 'Создано в «Рецептах»' });
    db.prepare('UPDATE recipe_suggestions SET recipe_id=? WHERE id=?').run(recipe.id, id);
    db.exec('COMMIT');
    return recipe;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function createRecipe(userId, input) {
  const id = randomUUID(), at = now();
  db.prepare(`INSERT INTO recipes(id,user_id,status,origin,title,description,servings,prep_minutes,cook_minutes,ingredients_json,steps_json,tags_json,warnings_json,source_url,source_key,source_type,source_name,thumbnail_url,notes,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, userId, input.status || 'draft', input.origin || 'imported', input.title, input.description || '', input.servings ?? null,
      input.prepMinutes ?? null, input.cookMinutes ?? null, JSON.stringify(input.ingredients || []), JSON.stringify(input.steps || []),
      JSON.stringify(input.tags || []), JSON.stringify(input.warnings || []), input.sourceUrl || null, input.sourceKey || null, input.sourceType || 'text', input.sourceName || null,
      input.thumbnailUrl || null, input.notes || '', at, at
    );
  return getRecipe(userId, id);
}

export function getRecipe(userId, id) { return parseRecipe(db.prepare('SELECT * FROM recipes WHERE id=? AND user_id=?').get(id, userId)); }
export function getRecipeImage(id) {
  return db.prepare("SELECT i.mime,i.bytes FROM recipe_images i JOIN recipes r ON r.id=i.recipe_id WHERE r.id=? AND r.status!='archived'").get(id);
}
export function saveRecipeImage(userId, id, mime, bytes) {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime) || !Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 5 * 1024 * 1024) throw new Error('Некорректное изображение рецепта');
  const recipe = getRecipe(userId, id);
  if (!recipe || recipe.origin !== 'generated' || recipe.status === 'archived') return null;
  const thumbnailUrl = `${config.appUrl}/recipe-images/${id}`;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('INSERT INTO recipe_images(recipe_id,mime,bytes) VALUES(?,?,?) ON CONFLICT(recipe_id) DO UPDATE SET mime=excluded.mime,bytes=excluded.bytes').run(id, mime, bytes);
    db.prepare('UPDATE recipes SET thumbnail_url=?,updated_at=? WHERE id=? AND user_id=?').run(thumbnailUrl, now(), id, userId);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return getRecipe(userId, id);
}
export function listGeneratedRecipesWithoutImages() {
  return db.prepare("SELECT r.user_id AS userId,r.id FROM recipes r LEFT JOIN recipe_images i ON i.recipe_id=r.id WHERE r.origin='generated' AND r.status!='archived' AND i.recipe_id IS NULL ORDER BY r.created_at").all();
}
export function listRecipes(userId) { return db.prepare("SELECT * FROM recipes WHERE user_id=? AND status!='archived' ORDER BY updated_at DESC").all(userId).map(parseRecipe); }
export function createRecipeShare(userId, recipeId) {
  const recipe = db.prepare("SELECT id FROM recipes WHERE id=? AND user_id=? AND status!='archived'").get(recipeId, userId);
  if (!recipe) return null;
  const current = db.prepare('SELECT token FROM recipe_shares WHERE recipe_id=?').get(recipeId);
  if (current) return current.token;
  const token = randomBytes(24).toString('base64url');
  db.prepare('INSERT INTO recipe_shares(token,recipe_id,created_at) VALUES(?,?,?)').run(token, recipeId, now());
  return token;
}
export function getSharedRecipe(token) {
  const row = db.prepare(`SELECT r.*, u.display_name AS shared_by
    FROM recipe_shares s
    JOIN recipes r ON r.id=s.recipe_id
    JOIN users u ON u.id=r.user_id
    WHERE s.token=? AND r.status!='archived'`).get(String(token));
  if (!row) return null;
  const recipe = parseRecipe(row);
  return {
    id: recipe.id,
    origin: recipe.origin,
    title: recipe.title,
    description: recipe.description,
    servings: recipe.servings,
    prepMinutes: recipe.prepMinutes,
    cookMinutes: recipe.cookMinutes,
    ingredients: recipe.ingredients,
    steps: recipe.steps,
    tags: recipe.tags,
    warnings: recipe.warnings,
    sourceUrl: recipe.sourceUrl,
    sourceName: recipe.sourceName,
    thumbnailUrl: recipe.thumbnailUrl,
    sharedBy: row.shared_by
  };
}
export function updateRecipe(userId, id, input) {
  const current = getRecipe(userId, id);
  if (!current) return null;
  const next = { ...current, ...input };
  db.prepare(`UPDATE recipes SET status=?,title=?,description=?,servings=?,prep_minutes=?,cook_minutes=?,ingredients_json=?,steps_json=?,tags_json=?,warnings_json=?,source_url=?,source_name=?,notes=?,updated_at=? WHERE id=? AND user_id=?`).run(
    next.status, next.title, next.description || '', next.servings ?? null, next.prepMinutes ?? null, next.cookMinutes ?? null,
    JSON.stringify(next.ingredients || []), JSON.stringify(next.steps || []), JSON.stringify(next.tags || []), JSON.stringify(next.warnings || []),
    next.sourceUrl || null, next.sourceName || null, next.notes || '', now(), id, userId
  );
  return getRecipe(userId, id);
}
export function archiveRecipe(userId, id) { return db.prepare("UPDATE recipes SET status='archived',updated_at=? WHERE id=? AND user_id=?").run(now(), id, userId).changes > 0; }

const searchStopWords = new Set(['рецепт', 'рецепта', 'рецепты', 'рецептов', 'рецепте', 'рецептом', 'с', 'со', 'из', 'на', 'для', 'и', 'в', 'во', 'по', 'как', 'приготовить', 'найти', 'найди', 'покажи', 'блюдо', 'блюда', 'ужин', 'ужина', 'за', 'минут', 'минуты', 'минуту', 'не', 'слишком']);
const searchTokens = (value) => String(value).toLocaleLowerCase('ru').replaceAll('ё', 'е').match(/[\p{L}\p{N}]+/gu) || [];
function sameSearchWord(left, right) {
  if (left === right) return true;
  const shorter = Math.min(left.length, right.length);
  if (shorter < 5 || Math.abs(left.length - right.length) > 3) return false;
  return left.slice(0, Math.max(4, shorter - 2)) === right.slice(0, Math.max(4, shorter - 2));
}

export function searchRecipes(userId, query) {
  const quick = /(быстр|скор)/iu.test(query);
  const light = /(низкокалор|не\s+слишком\s+калор|легк)/iu.test(query);
  const words = searchTokens(query).filter((word) => word.length > 2 && !/^\d+$/u.test(word) && !searchStopWords.has(word) && !/^(быстр|скор|низкокалор|калор|легк)/u.test(word));
  const maxMinutes = Number.parseInt(String(query).match(/(?:за|<|max|maximum|максимум)\s*(\d{1,3})/i)?.[1] || '', 10);
  return listRecipes(userId).map((recipe) => {
    const fields = [recipe.title, recipe.description, recipe.notes, ...recipe.tags, ...recipe.ingredients.map((x) => x.name || x.raw || x)];
    const tokens = fields.map(searchTokens);
    const matches = words.map((word) => tokens.findIndex((field) => field.some((token) => sameSearchWord(word, token))));
    if (matches.includes(-1)) return { recipe, score: 0 };
    let score = matches.reduce((sum, field) => sum + ([5, 2, 1, 3][field] ?? 2), 0);
    const totalMinutes = recipe.prepMinutes != null || recipe.cookMinutes != null ? (recipe.prepMinutes || 0) + (recipe.cookMinutes || 0) : null;
    if (quick && totalMinutes !== null && totalMinutes <= 30) score += 2;
    if (maxMinutes && totalMinutes !== null && totalMinutes <= maxMinutes) score += 3;
    if (light && recipe.tags.some((t) => /(легк|низкокалор)/i.test(t))) score += 3;
    return { recipe, score };
  }).filter((x) => x.score > 0 || (words.length === 0 && !quick && !light && !maxMinutes)).sort((a, b) => b.score - a.score).map((x) => x.recipe);
}

export function recordProviderRequest({ userId, operation, model, inputUnits = 0, outputUnits = 0, reasoningUnits = 0, cachedInputUnits = 0, totalUnits = inputUnits + outputUnits, usageComplete = false, status, providerStatus = null, errorCode = null, errorType = null, errorMessage = null, requestId = null, clientRequestId = null, incompleteReason = null, retryAfter = null }) {
  db.prepare('INSERT INTO provider_requests(id,user_id,operation,model,input_units,output_units,reasoning_units,cached_input_units,total_units,usage_complete,status,provider_status,error_code,error_type,error_message,request_id,client_request_id,incomplete_reason,retry_after,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(randomUUID(), userId || null, operation, model, inputUnits, outputUnits, reasoningUnits, cachedInputUnits, totalUnits, usageComplete ? 1 : 0, status, providerStatus, errorCode, errorType, errorMessage, requestId, clientRequestId, incompleteReason, retryAfter, now());
}
export function providerRequestsToday() { return db.prepare("SELECT COUNT(*) AS count FROM provider_requests WHERE status='ok' AND created_at>=?").get(new Date().toISOString().slice(0, 10)).count; }
export function aiUsageSummary(userId) {
  const today = new Date().toISOString().slice(0, 10);
  const reservations = db.prepare('SELECT COUNT(*) AS total, SUM(CASE WHEN created_at>=? THEN 1 ELSE 0 END) AS today FROM ai_reservations').get(today);
  const totals = db.prepare(`SELECT COUNT(*) AS requests,
    COALESCE(SUM(CASE WHEN status='ok' THEN 1 ELSE 0 END),0) AS successful,
    COALESCE(SUM(CASE WHEN status='error' THEN 1 ELSE 0 END),0) AS failed,
    COALESCE(SUM(input_units),0) AS input_units,
    COALESCE(SUM(output_units),0) AS output_units,
    COALESCE(SUM(reasoning_units),0) AS reasoning_units,
    COALESCE(SUM(cached_input_units),0) AS cached_input_units,
    COALESCE(SUM(total_units),0) AS total_units
    FROM provider_requests WHERE user_id=? AND usage_complete=1`).get(userId);
  const recent = db.prepare(`SELECT operation,model,status,input_units,output_units,reasoning_units,total_units,error_code,created_at
    FROM provider_requests WHERE user_id=? AND usage_complete=1 ORDER BY created_at DESC LIMIT 5`).all(userId);
  return {
    reservations: { today: reservations.today || 0, total: reservations.total || 0 },
    totals: { ...totals, monitoringSince: recent.at(-1)?.created_at || null },
    recent
  };
}
export function recordAiAttempt() {
  db.prepare('INSERT INTO ai_reservations VALUES(?,?)').run(randomUUID(), now());
}
export function claimUpdate(updateId) {
  const id = String(updateId), at = now();
  db.exec('BEGIN IMMEDIATE');
  try {
    const current = db.prepare('SELECT status FROM processed_updates WHERE update_id=?').get(id);
    if (current?.status === 'done') { db.exec('COMMIT'); return false; }
    if (current) db.prepare("UPDATE processed_updates SET status='processing',updated_at=? WHERE update_id=?").run(at, id);
    else db.prepare("INSERT INTO processed_updates(update_id,created_at,status,updated_at) VALUES(?,?,'processing',?)").run(id, at, at);
    db.exec('COMMIT'); return true;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
export function completeUpdate(updateId) { db.prepare("UPDATE processed_updates SET status='done',updated_at=? WHERE update_id=?").run(now(), String(updateId)); }
export function failUpdate(updateId) { db.prepare("UPDATE processed_updates SET status='failed',updated_at=? WHERE update_id=?").run(now(), String(updateId)); }
export function markUpdate(updateId) { if (!claimUpdate(updateId)) return false; completeUpdate(updateId); return true; }

export function deleteUserData(userId) { return db.prepare('DELETE FROM users WHERE id=?').run(userId).changes > 0; }
