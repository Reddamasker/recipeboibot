import { createHash } from 'node:crypto';

const fail = (message, status = 400, code = 'INVALID_CARD_INPUT', extra = {}) => Object.assign(new Error(message), { status, code, ...extra });
const own = (value, key) => Object.hasOwn(value, key);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hash = value => createHash('sha256').update(value).digest('hex');
const metadataFields = ['pinned', 'cooked', 'rating', 'notes', 'tags'];
const defaults = () => ({ pinned: false, cooked: false, cookedAt: null, rating: 0, updatedAt: null });
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const json = value => JSON.stringify(value);
function text(value, max, multiline = false) {
  if (typeof value !== 'string' || value.length > max || (multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/).test(value)) throw fail('Проверьте текст поля.');
  return value;
}
function image(input) {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(input.mime) || typeof input.value !== 'string'
    || !input.value.length || input.value.length > 1_398_104 || input.value.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.value)) throw fail('Выберите фото JPEG, PNG или WEBP размером до 1 МБ.', 415, 'INVALID_CARD_PHOTO');
  const bytes = Buffer.from(input.value, 'base64');
  if (bytes.length > 1024 * 1024) throw fail('Фото должно быть меньше 1 МБ.', 413, 'CARD_PHOTO_TOO_LARGE');
  if (bytes.toString('base64') !== input.value) throw fail('Не удалось прочитать фото.', 415, 'INVALID_CARD_PHOTO');
  const detected = bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg'
    : bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png'
    : bytes.length >= 12 && bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP' ? 'image/webp' : null;
  if (detected !== input.mime) throw fail('Содержимое фото не совпадает с форматом.', 415, 'INVALID_CARD_PHOTO');
  return { mime: input.mime, bytes, version: hash(Buffer.concat([Buffer.from(input.mime), bytes])) };
}

// This store imports no application singleton. Synchronous metadata/photo writes
// join the workspace transaction. Questions use their own durable attempt ledger.
export function createRecipeCardStore(db, { getRecipe = null, authorizeAsk = () => {}, answer = null, now = () => new Date().toISOString() } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS recipe_card_metadata (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
    pinned INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN (0,1)), cooked INTEGER NOT NULL DEFAULT 0 CHECK(cooked IN (0,1)),
    cooked_at TEXT, rating INTEGER NOT NULL DEFAULT 0 CHECK(rating BETWEEN 0 AND 5), updated_at TEXT NOT NULL,
    PRIMARY KEY(user_id,recipe_id)
  );
  CREATE TABLE IF NOT EXISTS recipe_card_photos (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
    mime TEXT NOT NULL CHECK(mime IN ('image/jpeg','image/png','image/webp')),
    bytes BLOB NOT NULL, version TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(user_id,recipe_id)
  );
  CREATE TABLE IF NOT EXISTS recipe_card_questions (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, operation_id TEXT NOT NULL,
    recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE, request_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','completed','failed')), answer TEXT,
    error_status INTEGER, error_code TEXT, error_message TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY(user_id,operation_id)
  );`);
  const clock = () => new Date(now()).toISOString();
  function recipe(userId, recipeId) {
    const row = typeof userId === 'string' && typeof recipeId === 'string'
      && db.prepare("SELECT * FROM recipes WHERE user_id=? AND id=? AND status='ready'").get(userId, recipeId);
    if (!row) throw fail('Рецепт не найден в вашей коллекции.', 404, 'RECIPE_NOT_FOUND');
    const supplied = getRecipe?.(userId, recipeId);
    if (supplied && typeof supplied.then === 'function') throw new Error('Card getRecipe must be synchronous');
    if (getRecipe && !supplied) throw fail('Рецепт недоступен.', 404, 'RECIPE_NOT_FOUND');
    return supplied || { ...row, ingredients: JSON.parse(row.ingredients_json), steps: JSON.parse(row.steps_json || '[]'), tags: JSON.parse(row.tags_json || '[]') };
  }
  function metadata(userId, recipeId) {
    const row = db.prepare('SELECT * FROM recipe_card_metadata WHERE user_id=? AND recipe_id=?').get(userId, recipeId);
    return row ? { pinned: Boolean(row.pinned), cooked: Boolean(row.cooked), cookedAt: row.cooked_at, rating: row.rating, updatedAt: row.updated_at } : defaults();
  }
  function persistMetadata(userId, recipeId, value, at) {
    db.prepare(`INSERT INTO recipe_card_metadata(user_id,recipe_id,pinned,cooked,cooked_at,rating,updated_at) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(user_id,recipe_id) DO UPDATE SET pinned=excluded.pinned,cooked=excluded.cooked,cooked_at=excluded.cooked_at,rating=excluded.rating,updated_at=excluded.updated_at`)
      .run(userId, recipeId, Number(value.pinned), Number(value.cooked), value.cookedAt, value.rating, at);
  }
  function read(userId, recipeId) {
    const saved = recipe(userId, recipeId), photo = db.prepare('SELECT mime,bytes,version FROM recipe_card_photos WHERE user_id=? AND recipe_id=?').get(userId, recipeId);
    return { recipeId, ...metadata(userId, recipeId), notes: saved.notes || '', tags: saved.tags || [],
      photo: photo ? { version: photo.version, mime: photo.mime, dataUrl: `data:${photo.mime};base64,${Buffer.from(photo.bytes).toString('base64')}` } : null };
  }
  function list(userId) {
    const rows = db.prepare(`SELECT m.*,p.version AS photo_version FROM recipe_card_metadata m
      JOIN recipes r ON r.id=m.recipe_id AND r.user_id=m.user_id
      LEFT JOIN recipe_card_photos p ON p.recipe_id=m.recipe_id AND p.user_id=m.user_id
      WHERE m.user_id=? AND r.status='ready'`).all(userId);
    return Object.fromEntries(rows.map(row => [row.recipe_id, { pinned: Boolean(row.pinned), cooked: Boolean(row.cooked), cookedAt: row.cooked_at,
      rating: row.rating, hasPhoto: Boolean(row.photo_version), photoVersion: row.photo_version || null, updatedAt: row.updated_at }]));
  }
  function update(userId, recipeId, fields) {
    if (!plain(fields) || !Object.keys(fields).length || Object.keys(fields).some(key => !metadataFields.includes(key))) throw fail('Выберите поля карточки для сохранения.');
    const saved = recipe(userId, recipeId), old = metadata(userId, recipeId), next = { ...old };
    for (const key of ['pinned', 'cooked']) if (own(fields, key)) {
      if (typeof fields[key] !== 'boolean') throw fail('Проверьте отметку рецепта.');
      next[key] = fields[key];
    }
    if (own(fields, 'rating')) {
      if (!Number.isInteger(fields.rating) || fields.rating < 0 || fields.rating > 5) throw fail('Оценка должна быть целым числом от 0 до 5.');
      next.rating = fields.rating;
    }
    const notes = own(fields, 'notes') ? text(fields.notes, 3000, true) : saved.notes || '';
    let tags = saved.tags || [];
    if (own(fields, 'tags')) {
      if (!Array.isArray(fields.tags) || fields.tags.length > 20) throw fail('Можно добавить до 20 тегов.');
      tags = [...new Set(fields.tags.map(value => text(value, 50).trim()))];
      if (tags.some(value => !value)) throw fail('Тег не должен быть пустым.');
    }
    const changed = json(next) !== json(old) || notes !== (saved.notes || '') || json(tags) !== json(saved.tags || []);
    if (changed) {
      const at = clock();
      if (next.cooked !== old.cooked) next.cookedAt = next.cooked ? at : null;
      // No general recipe normalizer or nutrition/model call belongs in a
      // personal note/tag edit. Unknown servings and source contents stay intact.
      if (notes !== (saved.notes || '') || json(tags) !== json(saved.tags || []))
        db.prepare('UPDATE recipes SET notes=?,tags_json=? WHERE id=? AND user_id=?').run(notes, json(tags), recipeId, userId);
      persistMetadata(userId, recipeId, next, at);
    }
    return { changed, count: 1, recipeId };
  }
  function setPhoto(userId, recipeId, input) {
    recipe(userId, recipeId);
    const photo = image(input), old = db.prepare('SELECT version FROM recipe_card_photos WHERE user_id=? AND recipe_id=?').get(userId, recipeId);
    const changed = old?.version !== photo.version;
    if (changed) {
      const at = clock();
      db.prepare(`INSERT INTO recipe_card_photos(user_id,recipe_id,mime,bytes,version,updated_at) VALUES(?,?,?,?,?,?)
        ON CONFLICT(user_id,recipe_id) DO UPDATE SET mime=excluded.mime,bytes=excluded.bytes,version=excluded.version,updated_at=excluded.updated_at`)
        .run(userId, recipeId, photo.mime, photo.bytes, photo.version, at);
      persistMetadata(userId, recipeId, metadata(userId, recipeId), at);
    }
    return { changed, count: 1, recipeId };
  }
  function removePhoto(userId, recipeId) {
    recipe(userId, recipeId);
    const changed = db.prepare('DELETE FROM recipe_card_photos WHERE user_id=? AND recipe_id=?').run(userId, recipeId).changes > 0;
    if (changed) persistMetadata(userId, recipeId, metadata(userId, recipeId), clock());
    return { changed, count: 1, recipeId };
  }
  function questionResult(row, replayed) {
    const common = { operationId: row.operation_id, recipeId: row.recipe_id, replayed };
    if (row.status === 'completed') return { ...common, status: 'completed', answer: row.answer };
    if (row.status === 'failed') throw fail(row.error_message, row.error_status, row.error_code, { operationId: row.operation_id, replayed });
    return { ...common, status: 'pending', retryAfterMs: 1000 };
  }
  const hasQuestionOperation = (userId, operationId) => Boolean(db.prepare('SELECT 1 FROM recipe_card_questions WHERE user_id=? AND operation_id=?').get(userId, operationId));
  async function ask(userId, recipeId, input) {
    if (!plain(input) || Object.keys(input).some(key => !['operationId', 'question'].includes(key)) || !uuid.test(input.operationId || '')) throw fail('Нужен UUID вопроса и текст.');
    const question = text(input.question, 1500, true).trim();
    if (!question) throw fail('Напишите вопрос о рецепте.');
    const saved = recipe(userId, recipeId), requestHash = hash(json([recipeId, input.question]));
    let prior;
    db.exec('BEGIN IMMEDIATE');
    try {
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='recipe_workspace_operations'").get()
        && db.prepare('SELECT 1 FROM recipe_workspace_operations WHERE user_id=? AND operation_id=?').get(userId, input.operationId)) throw fail('Этот ID уже использован для другого действия.', 409, 'OPERATION_MISMATCH');
      prior = db.prepare('SELECT * FROM recipe_card_questions WHERE user_id=? AND operation_id=?').get(userId, input.operationId);
      if (prior && prior.request_hash !== requestHash) throw fail('Этот ID уже использован для другого вопроса.', 409, 'OPERATION_MISMATCH');
      if (prior?.status === 'pending' && Date.parse(clock()) - Date.parse(prior.created_at) > 45000) {
        db.prepare("UPDATE recipe_card_questions SET status='failed',error_status=409,error_code='ASK_INTERRUPTED',error_message=?,updated_at=? WHERE user_id=? AND operation_id=?")
          .run('Ответ не подтверждён после перезапуска. Можно задать вопрос снова.', clock(), userId, input.operationId);
        prior = db.prepare('SELECT * FROM recipe_card_questions WHERE user_id=? AND operation_id=?').get(userId, input.operationId);
      }
      if (!prior) {
        const authorization = authorizeAsk(userId);
        if (authorization && typeof authorization.then === 'function') throw new Error('Card authorizeAsk must be synchronous');
        if (typeof answer !== 'function') throw fail('Ответы на вопросы пока недоступны.', 503, 'ASK_UNAVAILABLE');
        const at = clock();
        db.prepare("INSERT INTO recipe_card_questions(user_id,operation_id,recipe_id,request_hash,status,created_at,updated_at) VALUES(?,?,?,?,'pending',?,?)")
          .run(userId, input.operationId, recipeId, requestHash, at, at);
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    if (prior) return questionResult(prior, true);
    try {
      const result = await answer({ userId, recipe: saved, question });
      if (typeof result?.answer !== 'string' || !result.answer.trim() || result.answer.length > 12000) throw fail('Не удалось получить ответ. Задайте вопрос снова.', 502, 'ASK_INVALID_RESPONSE');
      db.prepare("UPDATE recipe_card_questions SET status='completed',answer=?,updated_at=? WHERE user_id=? AND operation_id=? AND status='pending'")
        .run(result.answer.trim(), clock(), userId, input.operationId);
    } catch (error) {
      const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 502;
      const code = /^[A-Z_]{1,50}$/.test(error.code || '') ? error.code : 'ASK_FAILED';
      db.prepare("UPDATE recipe_card_questions SET status='failed',error_status=?,error_code=?,error_message=?,updated_at=? WHERE user_id=? AND operation_id=? AND status='pending'")
        .run(status, code, String(error.message || 'Не удалось получить ответ. Задайте вопрос снова.').slice(0, 1500), clock(), userId, input.operationId);
    }
    const row = db.prepare('SELECT * FROM recipe_card_questions WHERE user_id=? AND operation_id=?').get(userId, input.operationId);
    if (!row) throw fail('Рецепт или профиль больше недоступен.', 404, 'RECIPE_NOT_FOUND');
    return questionResult(row, false);
  }
  return Object.freeze({ read, list, update, setPhoto, removePhoto, ask, hasQuestionOperation });
}
