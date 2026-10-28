import { db, getRecipe, saveDinnerRecipe } from './db.js';
import { catalogRecipe } from './web-catalog.js';
import { SEED_RECIPES } from './dinner.js';
import { randomUUID } from 'node:crypto';

// These grants are issued only after a trusted public catalog lookup. Editable
// recipe fields (sourceType, sourceKey, etc.) never grant access by themselves.
db.exec(`CREATE TABLE IF NOT EXISTS catalog_recipe_grants (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
 catalog_id TEXT NOT NULL, flow_id TEXT, created_at TEXT NOT NULL,
 PRIMARY KEY(user_id,recipe_id)
);
CREATE INDEX IF NOT EXISTS catalog_recipe_grants_catalog ON catalog_recipe_grants(user_id,catalog_id);
CREATE TABLE IF NOT EXISTS catalog_onboarding (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 first_catalog_id TEXT NOT NULL, obtained_at TEXT NOT NULL
);`);

const invalid = (message, status = 400) => Object.assign(new Error(message), { status });
const contents = recipe => JSON.stringify([
  recipe.title, recipe.description || '', recipe.servings, recipe.prepMinutes, recipe.cookMinutes,
  recipe.ingredients.map(item => [item.name, item.quantity ?? null, item.unit || '']),
  recipe.steps.map(step => step.text || step)
]);

export function isPublicCatalogRecipe(userId, recipeId) {
  if (!userId || typeof recipeId !== 'string') return false;
  return Boolean(db.prepare(`SELECT 1 FROM catalog_recipe_grants g
    JOIN recipes r ON r.id=g.recipe_id AND r.user_id=g.user_id
    WHERE g.user_id=? AND g.recipe_id=?`).get(userId, recipeId));
}

export function publicCatalogRecipeIds(userId) {
  return db.prepare(`SELECT g.recipe_id FROM catalog_recipe_grants g
    JOIN recipes r ON r.id=g.recipe_id AND r.user_id=g.user_id
    WHERE g.user_id=? ORDER BY g.created_at,g.recipe_id`).all(userId).map(row => row.recipe_id);
}

export function hasCatalogFirstRecipe(userId) {
  return Boolean(db.prepare('SELECT 1 FROM catalog_onboarding WHERE user_id=?').get(userId));
}

export function latestPublicCatalogRecipe(userId) {
  const row = db.prepare(`SELECT g.recipe_id FROM catalog_recipe_grants g
    JOIN recipes r ON r.id=g.recipe_id AND r.user_id=g.user_id
    WHERE g.user_id=? AND r.status!='archived' ORDER BY g.created_at DESC,g.recipe_id LIMIT 1`).get(userId);
  return row ? getRecipe(userId, row.recipe_id) : null;
}

export function saveCatalogRecipeForUser(userId, catalogId, { flowId = null } = {}) {
  if (typeof catalogId !== 'string' || !catalogRecipe(catalogId)) throw invalid('Рецепт больше не доступен в каталоге', 404);
  if (!db.prepare('SELECT 1 FROM users WHERE id=?').get(userId)) throw invalid('Пользователь не найден', 404);
  // Reuse the original authored recipe and its stable key, also used by dinner
  // saving. A public catalog projection must never become an AI import input.
  const trusted = SEED_RECIPES.find(recipe => recipe.id === `seed:${catalogId}`);
  if (!trusted) throw invalid('Рецепт больше не доступен в каталоге', 404);
  const safeFlow = typeof flowId === 'string' && /^[A-Za-z0-9_-]{16,80}$/.test(flowId) ? flowId : null;
  db.exec('SAVEPOINT save_public_catalog_recipe');
  try {
    const canonical = contents(trusted);
    const previous = db.prepare('SELECT recipe_id FROM catalog_recipe_grants WHERE user_id=? AND catalog_id=? ORDER BY created_at DESC').all(userId, catalogId)
      .map(row => getRecipe(userId, row.recipe_id)).find(recipe => recipe && contents(recipe) === canonical);
    const legacy = previous || getRecipe(userId, db.prepare('SELECT id FROM recipes WHERE user_id=? AND source_key=?').get(userId, `dinner-choice:${trusted.id}`)?.id || '');
    // A user may have edited a previously saved copy. Keep their edits and its
    // durable grant; store the exact authored recipe as a separate snapshot.
    const key = legacy && contents(legacy) !== canonical ? `public-catalog:${catalogId}:${randomUUID()}` : previous?.sourceKey?.slice('dinner-choice:'.length) || trusted.id;
    const recipe = saveDinnerRecipe(userId, key, { ...trusted, id: key });
    if (!recipe) throw invalid('Не удалось сохранить рецепт', 500);
    const existed = isPublicCatalogRecipe(userId, recipe.id);
    const at = new Date().toISOString();
    db.prepare('INSERT OR IGNORE INTO catalog_recipe_grants(user_id,recipe_id,catalog_id,flow_id,created_at) VALUES(?,?,?,?,?)')
      .run(userId, recipe.id, catalogId, safeFlow, at);
    db.prepare('INSERT OR IGNORE INTO catalog_onboarding(user_id,first_catalog_id,obtained_at) VALUES(?,?,?)').run(userId, catalogId, at);
    db.exec('RELEASE save_public_catalog_recipe');
    return { recipe: { ...recipe, publicCatalogSaved: true }, created: !existed, catalogId };
  } catch (error) {
    db.exec('ROLLBACK TO save_public_catalog_recipe');
    db.exec('RELEASE save_public_catalog_recipe');
    throw error;
  }
}
