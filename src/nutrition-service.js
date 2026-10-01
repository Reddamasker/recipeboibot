import { cacheNutrition, withNutrition } from './db.js';
import { estimateRecipeNutrition } from './openai.js';
import { normalizeNutrition, nutritionKey } from './nutrition.js';
const inFlight = new Map();
export async function ensureNutrition(userId, recipe, { estimate = estimateRecipeNutrition } = {}) {
  if (!recipe) return recipe;
  const ready = withNutrition(recipe);
  if (ready.nutrition) return ready;
  const key = nutritionKey(recipe);
  if (!inFlight.has(key)) {
    const task = (async () => {
      const result = normalizeNutrition(await estimate({ userId, recipe }), recipe);
      if (!result) throw Object.assign(new Error('Не удалось рассчитать КБЖУ рецепта. Повторите попытку позже.'), { status: 502 });
      return cacheNutrition(recipe, result);
    })().finally(() => inFlight.delete(key));
    inFlight.set(key, task);
  }
  return { ...recipe, nutrition: await inFlight.get(key) };
}
