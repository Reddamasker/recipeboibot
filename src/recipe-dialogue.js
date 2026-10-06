import { randomUUID } from 'node:crypto';
import { db } from './db.js';
import { normalizeMealRequest, parseMealRequest, mergeMealRequests } from './meal-request.js';
import { normalizedRecipeTitle, exactDishRequest, recipeSnapshot, excludedDialogueRecipe } from './recipe-rejection.js';
export { normalizedRecipeTitle, excludedDialogueRecipe } from './recipe-rejection.js';

// Separate from pending_intents: saving a recipe or editing the profile must
// not erase the cooking task. Each card keeps its own, owner-scoped snapshot.
db.exec(`CREATE TABLE IF NOT EXISTS telegram_recipe_dialogues (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS telegram_dialogues_owner ON telegram_recipe_dialogues(user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS telegram_active_dialogue (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  dialogue_id TEXT REFERENCES telegram_recipe_dialogues(id) ON DELETE SET NULL
);`);

export function getRecipeDialogue(userId, id = null) {
  const row = id
    ? db.prepare('SELECT * FROM telegram_recipe_dialogues WHERE user_id=? AND id=?').get(userId, id)
    : db.prepare('SELECT d.* FROM telegram_active_dialogue a JOIN telegram_recipe_dialogues d ON d.id=a.dialogue_id WHERE a.user_id=?').get(userId);
  if (!row) return null;
  try { return { ...JSON.parse(row.payload_json), id: row.id }; } catch { return null; }
}

export function activateRecipeDialogue(userId, id) {
  if (!getRecipeDialogue(userId, id)) return false;
  db.prepare('INSERT INTO telegram_active_dialogue(user_id,dialogue_id) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET dialogue_id=excluded.dialogue_id').run(userId, id);
  return true;
}

export function getSuggestionDialogue(userId, suggestionId) {
  const row = db.prepare("SELECT id FROM telegram_recipe_dialogues WHERE user_id=? AND json_extract(payload_json,'$.suggestionId')=? ORDER BY created_at DESC LIMIT 1").get(userId, suggestionId);
  return row ? getRecipeDialogue(userId, row.id) : null;
}

export function clearRecipeDialogue(userId) {
  db.prepare('DELETE FROM telegram_active_dialogue WHERE user_id=?').run(userId);
}

export function createRecipeDialogue(userId, payload) {
  const id = randomUUID();
  // Card snapshots are useful for old buttons, but are not an unlimited chat log.
  db.prepare('DELETE FROM telegram_recipe_dialogues WHERE created_at<?').run(new Date(Date.now() - 30 * 86400000).toISOString());
  db.prepare('INSERT INTO telegram_recipe_dialogues(id,user_id,payload_json,created_at) VALUES(?,?,?,?)').run(id, userId, JSON.stringify({ ...payload, taskId: payload.taskId || id }), new Date().toISOString());
  activateRecipeDialogue(userId, id);
  return getRecipeDialogue(userId, id);
}

export function updateRecipeDialogue(userId, id, patch) {
  const current = getRecipeDialogue(userId, id);
  if (!current) return null;
  const { id: ignored, ...payload } = { ...current, ...patch };
  db.prepare('UPDATE telegram_recipe_dialogues SET payload_json=? WHERE id=? AND user_id=?').run(JSON.stringify(payload), id, userId);
  return { ...payload, id };
}

export function rejectDialogueRecipe(dialogue, { mealRequest = dialogue.mealRequest || parseMealRequest(dialogue.query), action = 'replace' } = {}) {
  const scope = action === 'refine' || exactDishRequest(mealRequest) ? 'recipe' : 'dish';
  // Hydrate legacy title-only rejections from the persisted card, including failed retries.
  const rejected = (dialogue.rejectedRecipes || []).map(item => {
    if (!item.recipe && normalizedRecipeTitle(item.title) === normalizedRecipeTitle(dialogue.recipe?.title)) {
      return { ...item, scope, refinement: action === 'refine', recipe: recipeSnapshot(dialogue.recipe) };
    }
    return item;
  });
  if (dialogue.recipe && !excludedDialogueRecipe(dialogue.recipe, rejected, mealRequest)) {
    rejected.push({ id: dialogue.recipe.id || null, title: dialogue.recipe.title, scope, refinement: action === 'refine', recipe: recipeSnapshot(dialogue.recipe) });
  }
  return rejected;
}

// Fast paths have unambiguous semantics and require no classification call.
// Other phrases go to the contextual interpreter, never to a blind search.
export function localDialogueAction(text) {
  const value = String(text || '').toLocaleLowerCase('ru').replaceAll('ё', 'е').replace(/[.!?]+$/u, '').trim();
  if (/^(?:не хочу(?:\s+(?:его|это|этот|такое|ее))?|нет|не надо|не подходит|другой(?:\s+(?:вариант|рецепт))?|другое|еще(?:\s+(?:вариант|один))?|давай (?:другой|другое)|не нравится|недавно ели|долго готовить)$/u.test(value)) return { action: 'replace' };
  if (/^(?:не сохраняй|не сохранять|не добавляй|не добавлять)$/u.test(value)) return { action: 'skip-save' };
  if (/^(?:сохрани|сохранить|сохранить рецепт|добавь|добавить|да,? (?:сохрани|добавь))$/u.test(value)) return { action: 'save' };
  if (/^(?:отмена|отменить|новый подбор|новый запрос)$/u.test(value)) return { action: 'reset' };
  if (/^(?:без\s+|(?:на|для)\s+(?:\d+|двоих|троих|четверых)|(?:до|за|максимум)\s+\d+\s*мин|быстрее$|полегче$)/u.test(value)) {
    const parsed = parseMealRequest(value);
    const patch = normalizeMealRequest({ ...parsed, text: value, kind: 'open', dish: '',
      semanticCriteria: value === 'полегче' ? [{ description: 'Блюдо должно быть более лёгким', importance: 'required' }] : parsed?.semanticCriteria });
    return { action: 'refine', patch };
  }
  return null;
}

export function refineDialogueRequest(dialogue, patch) {
  return mergeMealRequests(dialogue.mealRequest || parseMealRequest(dialogue.query), patch);
}
