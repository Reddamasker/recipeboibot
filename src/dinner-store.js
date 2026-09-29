import { randomUUID } from 'node:crypto';
import { db } from './db.js';
import { normalizeMealRequest } from './meal-request.js';

db.exec(`
CREATE TABLE IF NOT EXISTS food_profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  household_type TEXT,
  household_size INTEGER,
  has_children INTEGER,
  preferred_max_cooking_time INTEGER,
  excluded_ingredients_json TEXT NOT NULL DEFAULT '[]',
  preferred_categories_json TEXT NOT NULL DEFAULT '{}',
  onboarding_completed INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS dinner_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pantry_json TEXT NOT NULL DEFAULT '[]',
  requested_categories_json TEXT NOT NULL DEFAULT '[]',
  opened_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS dinner_sessions_user ON dinner_sessions(user_id, opened_at DESC);
CREATE TABLE IF NOT EXISTS dinner_recommendations (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES dinner_sessions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipe_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'shown' CHECK(status IN ('shown','accepted','rejected')),
  shown_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS dinner_recommendations_session ON dinner_recommendations(session_id, shown_at DESC);
CREATE TABLE IF NOT EXISTS dinner_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES dinner_sessions(id) ON DELETE CASCADE,
  recommendation_id TEXT REFERENCES dinner_recommendations(id) ON DELETE CASCADE,
  recipe_key TEXT,
  event TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS dinner_events_user_time ON dinner_events(user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS dinner_contexts (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  pantry_json TEXT NOT NULL,
  requested_categories_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS dinner_options (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES dinner_sessions(id) ON DELETE CASCADE,
  recipe_key TEXT NOT NULL,
  signature TEXT NOT NULL,
  option_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'ready' CHECK(state IN ('ready','current','used','discarded')),
  image_state TEXT NOT NULL DEFAULT 'none',
  image_mime TEXT,
  image_bytes BLOB,
  created_at TEXT NOT NULL,
  UNIQUE(session_id, recipe_key),
  UNIQUE(session_id, signature)
);
CREATE INDEX IF NOT EXISTS dinner_options_session ON dinner_options(session_id, state, created_at);
`);

const ensureColumn = (table, name, definition) => {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some((column) => column.name === name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
};
ensureColumn('food_profiles', 'household_size', 'INTEGER');
ensureColumn('food_profiles', 'has_children', 'INTEGER');
ensureColumn('food_profiles', 'taste_preferences_status', "TEXT NOT NULL DEFAULT 'pending'");
ensureColumn('dinner_sessions', 'pantry_json', "TEXT NOT NULL DEFAULT '[]'");
ensureColumn('dinner_sessions', 'requested_categories_json', "TEXT NOT NULL DEFAULT '[]'");
ensureColumn('dinner_contexts', 'requested_categories_json', "TEXT NOT NULL DEFAULT '[]'");
ensureColumn('dinner_sessions', 'buffer_context', "TEXT NOT NULL DEFAULT ''");
ensureColumn('dinner_sessions', 'buffer_retry_at', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('dinner_sessions', 'viewed_at', 'TEXT');
ensureColumn('food_profiles', 'dish_preferences_json', "TEXT NOT NULL DEFAULT '{}'");
ensureColumn('dinner_sessions', 'meal_request_json', "TEXT NOT NULL DEFAULT 'null'");
ensureColumn('dinner_contexts', 'meal_request_json', "TEXT NOT NULL DEFAULT 'null'");

const now = () => new Date().toISOString();
const parseJson = (value, fallback) => { try { return JSON.parse(value); } catch { return fallback; } };

export function getFoodProfile(userId) {
  const row = db.prepare('SELECT * FROM food_profiles WHERE user_id=?').get(userId);
  return row ? {
    householdType: row.household_type,
    householdSize: row.household_size,
    hasChildren: row.has_children === null ? null : Boolean(row.has_children),
    preferredMaxCookingTime: row.preferred_max_cooking_time,
    excludedIngredients: parseJson(row.excluded_ingredients_json, []),
    preferredCategories: parseJson(row.preferred_categories_json, {}),
    dishPreferences: parseJson(row.dish_preferences_json, {}),
    tastePreferencesStatus: row.taste_preferences_status,
    onboardingCompleted: Boolean(row.onboarding_completed)
  } : { householdType: null, householdSize: null, hasChildren: null, preferredMaxCookingTime: null, excludedIngredients: [], preferredCategories: {}, dishPreferences: {}, tastePreferencesStatus: 'pending', onboardingCompleted: false };
}

export function saveFoodProfile(userId, profile) {
  db.prepare(`INSERT INTO food_profiles(user_id,household_type,household_size,has_children,preferred_max_cooking_time,excluded_ingredients_json,preferred_categories_json,onboarding_completed,updated_at,taste_preferences_status)
    VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET household_type=excluded.household_type,household_size=excluded.household_size,has_children=excluded.has_children,
    preferred_max_cooking_time=excluded.preferred_max_cooking_time,excluded_ingredients_json=excluded.excluded_ingredients_json,
    preferred_categories_json=excluded.preferred_categories_json,onboarding_completed=excluded.onboarding_completed,updated_at=excluded.updated_at,taste_preferences_status=excluded.taste_preferences_status`)
    .run(userId, profile.householdType, profile.householdSize, profile.hasChildren === null ? null : profile.hasChildren ? 1 : 0, profile.preferredMaxCookingTime, JSON.stringify(profile.excludedIngredients), JSON.stringify(profile.preferredCategories), profile.onboardingCompleted ? 1 : 0, now(), profile.tastePreferencesStatus ?? getFoodProfile(userId).tastePreferencesStatus);
  db.prepare('UPDATE food_profiles SET dish_preferences_json=? WHERE user_id=?').run(JSON.stringify(profile.dishPreferences ?? getFoodProfile(userId).dishPreferences), userId);
  return getFoodProfile(userId);
}

export function setDinnerContext(userId, availableIngredients, requestedCategories = [], mealRequest = null) {
  db.prepare(`INSERT INTO dinner_contexts(user_id,pantry_json,requested_categories_json,meal_request_json,updated_at) VALUES(?,?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET pantry_json=excluded.pantry_json,requested_categories_json=excluded.requested_categories_json,meal_request_json=excluded.meal_request_json,updated_at=excluded.updated_at`)
    .run(userId, JSON.stringify(availableIngredients), JSON.stringify(requestedCategories), JSON.stringify(normalizeMealRequest(mealRequest)), now());
}

function activeDinnerContext(userId) {
  const row = db.prepare('SELECT pantry_json,requested_categories_json,meal_request_json,updated_at FROM dinner_contexts WHERE user_id=?').get(userId);
  if (!row) return null;
  if (Date.now() - Date.parse(row.updated_at) < 6 * 60 * 60 * 1000) return row;
  clearDinnerContext(userId);
  return null;
}
export function getDinnerContext(userId) { const row = activeDinnerContext(userId); return row ? parseJson(row.pantry_json, []) : []; }
export function getDinnerRequestCategories(userId) { const row = activeDinnerContext(userId); return row ? parseJson(row.requested_categories_json, []) : []; }
export function getDinnerMealRequest(userId) { const row = activeDinnerContext(userId); return row ? normalizeMealRequest(parseJson(row.meal_request_json, null)) : null; }

export function clearDinnerContext(userId) { db.prepare('DELETE FROM dinner_contexts WHERE user_id=?').run(userId); }

export function addDinnerEvent(userId, event, { sessionId = null, recommendationId = null, recipeKey = null, detail = {} } = {}) {
  db.prepare('INSERT INTO dinner_events(id,user_id,session_id,recommendation_id,recipe_key,event,detail_json,created_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(randomUUID(), userId, sessionId, recommendationId, recipeKey, event, JSON.stringify(detail), now());
}

export function openDinnerSession(userId, { prefetchOnly = false } = {}) {
  const id = randomUUID();
  db.prepare('INSERT INTO dinner_sessions(id,user_id,pantry_json,requested_categories_json,meal_request_json,opened_at) VALUES(?,?,?,?,?,?)')
    .run(id, userId, JSON.stringify(getDinnerContext(userId)), JSON.stringify(getDinnerRequestCategories(userId)), JSON.stringify(getDinnerMealRequest(userId)), now());
  if (!prefetchOnly) markDinnerSessionOpened(userId, id);
  return id;
}

export function markDinnerSessionOpened(userId, sessionId) {
  if (db.prepare('UPDATE dinner_sessions SET viewed_at=? WHERE id=? AND user_id=? AND viewed_at IS NULL').run(now(), sessionId, userId).changes) addDinnerEvent(userId, 'dinner_recommendation_opened', { sessionId });
}

export function getDinnerSession(userId, sessionId) {
  return db.prepare('SELECT * FROM dinner_sessions WHERE id=? AND user_id=?').get(sessionId, userId) || null;
}

export function getDinnerHistory(userId) {
  return db.prepare(`SELECT session_id,recipe_key,event,detail_json,created_at FROM dinner_events
    WHERE user_id=? AND created_at>=? ORDER BY created_at DESC LIMIT 500`)
    .all(userId, new Date(Date.now() - 90 * 86400000).toISOString())
    .map((row) => ({ sessionId: row.session_id, recipeKey: row.recipe_key, event: row.event, detail: parseJson(row.detail_json, {}), createdAt: row.created_at }));
}

export function rejectedInSession(userId, sessionId) {
  return db.prepare("SELECT recipe_key FROM dinner_recommendations WHERE user_id=? AND session_id=? AND status='rejected'")
    .all(userId, sessionId).map((row) => row.recipe_key);
}

export function shownCountInSession(userId, sessionId) {
  return db.prepare('SELECT COUNT(*) AS count FROM dinner_recommendations WHERE user_id=? AND session_id=?').get(userId, sessionId).count;
}

export function retryCountInSession(userId, sessionId) {
  return db.prepare("SELECT COUNT(*) AS count FROM dinner_events WHERE user_id=? AND session_id=? AND event='dinner_retry'").get(userId, sessionId).count;
}

export function createDinnerRecommendations(userId, sessionId, candidates) {
  const at = now(), rows = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const { recipeKey, categories } of candidates) {
      const id = randomUUID();
      db.prepare('INSERT INTO dinner_recommendations(id,session_id,user_id,recipe_key,shown_at) VALUES(?,?,?,?,?)').run(id, sessionId, userId, recipeKey, at);
      addDinnerEvent(userId, 'recommendation_shown', { sessionId, recommendationId: id, recipeKey, detail: { categories } });
      addDinnerEvent(userId, 'dinner_recommendation_shown', { sessionId, recommendationId: id, recipeKey });
      rows.push({ id, sessionId, recipeKey, status: 'shown', shownAt: at });
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return rows;
}

export function getDinnerRecommendation(userId, id) {
  return db.prepare('SELECT * FROM dinner_recommendations WHERE id=? AND user_id=?').get(id, userId) || null;
}

export function decideDinnerRecommendation(userId, id, decision, categories) {
  if (!['accepted', 'rejected'].includes(decision)) return null;
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = getDinnerRecommendation(userId, id);
    if (!row) { db.exec('COMMIT'); return null; }
    if (row.status === 'shown') {
      db.prepare('UPDATE dinner_recommendations SET status=?,decided_at=? WHERE id=?').run(decision, now(), id);
      const event = decision === 'accepted' ? 'recommendation_accepted' : 'recommendation_rejected';
      const context = { sessionId: row.session_id, recommendationId: id, recipeKey: row.recipe_key };
      addDinnerEvent(userId, event, { ...context, detail: { categories } });
      addDinnerEvent(userId, `dinner_${event}`, context);
    }
    db.exec('COMMIT');
    return getDinnerRecommendation(userId, id);
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function rejectDinnerRecommendations(userId, ids, categoriesByKey) {
  const rows = ids.map((id) => getDinnerRecommendation(userId, id));
  if (rows.some((row) => !row) || new Set(rows.map((row) => row.session_id)).size !== 1 || rows.some((row) => !['shown', 'rejected'].includes(row.status))) return null;
  const sessionId = rows[0].session_id;
  const fresh = rows.some((row) => row.status === 'shown');
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const row of rows) {
      if (row.status !== 'shown') continue;
      db.prepare("UPDATE dinner_recommendations SET status='rejected',decided_at=? WHERE id=?").run(now(), row.id);
      const context = { sessionId, recommendationId: row.id, recipeKey: row.recipe_key };
      addDinnerEvent(userId, 'recommendation_rejected', { ...context, detail: { categories: categoriesByKey[row.recipe_key] || [] } });
      addDinnerEvent(userId, 'dinner_recommendation_rejected', context);
    }
    if (fresh) addDinnerEvent(userId, 'dinner_retry', { sessionId, detail: { recipeKeys: rows.map((row) => row.recipe_key) } });
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return { sessionId, rejectedCount: rejectedInSession(userId, sessionId).length, retryCount: retryCountInSession(userId, sessionId) };
}

export function addDinnerRejectionReason(userId, id, reason, details = {}) {
  const row = getDinnerRecommendation(userId, id);
  if (!row || row.status !== 'rejected') return false;
  const previous = db.prepare("SELECT id FROM dinner_events WHERE recommendation_id=? AND event='dinner_rejection_reason'").get(id);
  if (previous) {
    db.prepare('UPDATE dinner_events SET detail_json=?,created_at=? WHERE id=?').run(JSON.stringify({ ...details, reason }), now(), previous.id);
    return true;
  }
  addDinnerEvent(userId, 'dinner_rejection_reason', { sessionId: row.session_id, recommendationId: id, recipeKey: row.recipe_key, detail: { ...details, reason } });
  return true;
}

export function markDinnerCooked(userId, id, categories) {
  const row = getDinnerRecommendation(userId, id);
  if (!row || row.status !== 'accepted') return false;
  if (db.prepare("SELECT id FROM dinner_events WHERE recommendation_id=? AND event='recipe_cooked'").get(id)) return true;
  const context = { sessionId: row.session_id, recommendationId: id, recipeKey: row.recipe_key };
  addDinnerEvent(userId, 'recipe_cooked', { ...context, detail: { categories } });
  addDinnerEvent(userId, 'recipe_marked_cooked', context);
  return true;
}

const optionColumns = 'o.id,o.option_json,o.state,o.image_state,(o.image_bytes IS NOT NULL) AS has_image';
const parseOption = (row) => {
  if (!row) return null;
  const option = JSON.parse(row.option_json);
  return { ...option, id: row.id, state: row.state, imageState: row.image_state,
    recipe: { ...option.recipe, ...(row.has_image ? { thumbnailUrl: `/dinner-images/${row.id}`, imageGenerated: true } : {}) } };
};
export function listDinnerOptions(userId, sessionId) {
  return db.prepare(`SELECT ${optionColumns} FROM dinner_options o WHERE user_id=? AND session_id=? ORDER BY rowid`).all(userId, sessionId).map(parseOption);
}
export function currentDinnerOptions(userId, sessionId) {
  return db.prepare(`SELECT ${optionColumns} FROM dinner_options o JOIN dinner_recommendations r ON r.id=o.id
    WHERE o.user_id=? AND o.session_id=? AND o.state='current' AND r.status='shown' ORDER BY o.rowid`).all(userId, sessionId).map(parseOption);
}
export function getDinnerOption(userId, id) {
  return parseOption(db.prepare(`SELECT ${optionColumns} FROM dinner_options o WHERE id=? AND user_id=?`).get(id, userId));
}
export function insertDinnerOption(userId, sessionId, option, signature) {
  return db.prepare('INSERT OR IGNORE INTO dinner_options(id,user_id,session_id,recipe_key,signature,option_json,created_at) VALUES(?,?,?,?,?,?,?)')
    .run(option.id, userId, sessionId, option.recipe.id, signature, JSON.stringify(option), now()).changes > 0;
}
export function invalidateDinnerBuffer(userId, sessionId, context) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare("UPDATE dinner_options SET state='discarded' WHERE user_id=? AND session_id=? AND state IN ('ready','current')").run(userId, sessionId);
    db.prepare('UPDATE dinner_sessions SET buffer_context=?,buffer_retry_at=0 WHERE id=? AND user_id=?').run(context, sessionId, userId);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
export function setDinnerBufferRetry(userId, sessionId, at) {
  db.prepare('UPDATE dinner_sessions SET buffer_retry_at=? WHERE id=? AND user_id=?').run(at, sessionId, userId);
}
export function retireDinnerOptions(userId, sessionId) {
  db.prepare("UPDATE dinner_options SET state='used' WHERE user_id=? AND session_id=? AND state='current' AND id IN (SELECT id FROM dinner_recommendations WHERE status!='shown')").run(userId, sessionId);
}
export function promoteDinnerOptions(userId, sessionId, ids) {
  db.exec('BEGIN IMMEDIATE');
  try {
    // Idempotent across concurrent requests: never promote a second batch over the current one.
    if (!currentDinnerOptions(userId, sessionId).length) {
      for (const id of ids) {
        const option = getDinnerOption(userId, id);
        const row = db.prepare("SELECT id FROM dinner_options WHERE id=? AND session_id=? AND user_id=? AND state='ready'").get(id, sessionId, userId);
        if (!row || !option) continue;
        const at = now();
        db.prepare('INSERT INTO dinner_recommendations(id,session_id,user_id,recipe_key,shown_at) VALUES(?,?,?,?,?)').run(id, sessionId, userId, option.recipe.id, at);
        db.prepare("UPDATE dinner_options SET state='current' WHERE id=?").run(id);
        const event = { sessionId, recommendationId: id, recipeKey: option.recipe.id };
        addDinnerEvent(userId, 'recommendation_shown', { ...event, detail: { categories: option.categories, method: option.method } });
        addDinnerEvent(userId, 'dinner_recommendation_shown', event);
      }
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return currentDinnerOptions(userId, sessionId);
}
export function findReusableDinnerSession(userId, context) {
  if (typeof context === 'function') return db.prepare(`SELECT s.* FROM dinner_sessions s WHERE s.user_id=? AND s.opened_at>=?
    AND NOT EXISTS(SELECT 1 FROM dinner_recommendations r WHERE r.session_id=s.id AND r.status='accepted')
    ORDER BY s.opened_at DESC LIMIT 50`).all(userId, new Date(Date.now() - 6 * 3600000).toISOString()).find(context)?.id;
  return db.prepare(`SELECT s.id FROM dinner_sessions s WHERE s.user_id=? AND s.buffer_context=? AND s.opened_at>=?
    AND NOT EXISTS(SELECT 1 FROM dinner_recommendations r WHERE r.session_id=s.id AND r.status='accepted')
    ORDER BY s.opened_at DESC LIMIT 1`).get(userId, context, new Date(Date.now() - 6 * 3600000).toISOString())?.id;
}
export function acceptedDinnerOptionId(userId, sessionId) {
  return db.prepare("SELECT id FROM dinner_recommendations WHERE user_id=? AND session_id=? AND status='accepted' LIMIT 1").get(userId, sessionId)?.id;
}
export function setDinnerOptionImage(id, state, image = null) {
  db.prepare('UPDATE dinner_options SET image_state=?,image_mime=COALESCE(?,image_mime),image_bytes=COALESCE(?,image_bytes) WHERE id=?')
    .run(state, image?.mime || null, image?.bytes || null, id);
}
export function getDinnerOptionImage(id) {
  return db.prepare("SELECT image_mime AS mime,image_bytes AS bytes FROM dinner_options WHERE id=? AND image_state='ready'").get(id);
}
