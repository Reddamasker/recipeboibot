import { createHash } from 'node:crypto';

export const normalizedRecipeTitle = value => String(value || '').normalize('NFKC').toLocaleLowerCase('ru').replaceAll('ё', 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
export const exactDishRequest = request => Boolean(request?.dish && request.kind === 'exact' && request.confidence !== 'low');
export const rejectionScope = (item, request) => item.scope || (exactDishRequest(request) ? 'recipe' : 'dish');

// Keep actual proportions and technique; titles and descriptions cannot identify a recipe.
export function recipeSnapshot(recipe) {
  return { title: recipe.title, servings: recipe.servings, prepMinutes: recipe.prepMinutes, cookMinutes: recipe.cookMinutes,
    ingredients: recipe.ingredients || [], steps: recipe.steps || [] };
}

function recipeFingerprint(recipe, normalizeServings = true) {
  if (!recipe?.ingredients?.length || !recipe?.steps?.length) return null;
  const servings = normalizeServings && recipe.servings > 0 ? recipe.servings : 1;
  const ingredients = recipe.ingredients.map(item => [normalizedRecipeTitle(item.name || item.raw || item),
    Number.isFinite(item.quantity) ? Number((item.quantity / servings).toFixed(6)) : null,
    normalizedRecipeTitle(item.unit), normalizedRecipeTitle(item.comment)]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const steps = recipe.steps.map(item => normalizedRecipeTitle(item.text || item));
  return createHash('sha256').update(JSON.stringify({ ingredients, steps, ...(!normalizeServings ? { servings: recipe.servings } : {}) })).digest('hex');
}

export function excludedDialogueRecipe(recipe, rejected = [], request = null) {
  const fingerprint = recipeFingerprint(recipe);
  return rejected.some(item => (recipe.id && item.id === recipe.id) || (rejectionScope(item, request) === 'dish'
    ? normalizedRecipeTitle(item.title) === normalizedRecipeTitle(recipe.title)
    : item.refinement ? recipeFingerprint(recipe, false) && recipeFingerprint(recipe, false) === recipeFingerprint(item.recipe, false)
      : fingerprint && fingerprint === recipeFingerprint(item.recipe)));
}

export function rejectionCriteria(rejected, request) {
  const dishes = rejected.filter(item => rejectionScope(item, request) === 'dish');
  const variants = rejected.filter(item => !item.refinement && rejectionScope(item, request) === 'recipe' && item.recipe?.ingredients?.length && item.recipe?.steps?.length);
  return [
    ...(dishes.length ? [{ description: `Пользователь отклонил блюда: ${dishes.map(item => item.title).join('; ').slice(0, 1200)}. Предложение должно быть другим блюдом, а не отклонённым блюдом с новым названием или небольшим изменением состава.`, importance: 'required', source: 'rejection' }] : []),
    ...(variants.length ? [{ description: 'Пользователь отклонил конкретные рецепты в rejectedRecipes со scope=recipe. Предложи существенно другой рецепт по составу, пропорциям или способу приготовления. То же блюдо и то же название разрешены. Простое переименование, перефразирование шагов, масштабирование порций или декоративная добавка не считаются новым рецептом. При уточнении условий допустима содержательная адаптация того же блюда под новые условия.', importance: 'required', source: 'recipeRejection' }] : [])
  ];
}
