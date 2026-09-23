import { createRecipeSuggestion, findRecipeSuggestion, searchRecipes } from './db.js';
import { generateRecipe } from './openai.js';

const inFlight = new Map();

export async function suggestForEmptySearch(userId, query, { generate = generateRecipe } = {}) {
  const normalized = String(query || '').trim().slice(0, 500);
  if (!normalized) throw Object.assign(new Error('Укажите, что хотите приготовить'), { status: 400 });
  if (searchRecipes(userId, normalized).some((recipe) => recipe.status === 'ready')) {
    throw Object.assign(new Error('В коллекции уже есть подходящие рецепты'), { status: 409 });
  }
  const existing = findRecipeSuggestion(userId, normalized);
  if (existing) return existing;
  const key = JSON.stringify([userId, normalized]);
  if (inFlight.has(key)) return inFlight.get(key);
  const task = (async () => {
    const recipe = await generate({ userId, query: normalized });
    return createRecipeSuggestion(userId, normalized, recipe);
  })();
  inFlight.set(key, task);
  try { return await task; } finally { inFlight.delete(key); }
}
