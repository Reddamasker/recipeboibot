import { createRecipeSuggestion, findRecipeSuggestion, listRecipes, matchRecipes, searchRecipes } from './db.js';
import { getFoodProfile } from './dinner-store.js';
import { hasExcludedIngredient, SEED_RECIPES, totalMinutes } from './dinner.js';
import { generateRecipe, generateRequestedRecipe } from './openai.js';

const inFlight = new Map();

function requestContext(userId, query) {
  const normalized = String(query || '').trim().slice(0, 500);
  if (!normalized) throw Object.assign(new Error('Напишите, что хотите приготовить'), { status: 400 });
  const profile = getFoodProfile(userId);
  const explicitExclusions = [...normalized.matchAll(/(?:^|\s)без\s+([\p{L}-]+)/giu)].map((match) => match[1]);
  const searchQuery = normalized.replace(/(?:^|\s)без\s+[\p{L}-]+/giu, ' ').trim();
  const explicitMax = Number.parseInt(normalized.match(/(?:за|до|максимум)\s*(\d{1,3})\s*(?:минут|мин\b)/iu)?.[1] || '', 10);
  const maxMinutes = Math.min(profile.preferredMaxCookingTime || Infinity, explicitMax || Infinity);
  return { normalized, searchQuery, profile, excluded: [...(profile.excludedIngredients || []), ...explicitExclusions], maxMinutes };
}

export function findRequestedRecipe(userId, query) {
  const { searchQuery, profile, excluded, maxMinutes } = requestContext(userId, query);
  const saved = listRecipes(userId).filter((recipe) => recipe.status === 'ready');
  return matchRecipes([...saved, ...SEED_RECIPES], searchQuery, { allowAll: false }).find((recipe) => {
    const minutes = totalMinutes(recipe);
    return recipe.ingredients?.length && recipe.steps?.length && !hasExcludedIngredient(recipe, excluded) &&
      (maxMinutes === Infinity || (minutes !== null && minutes <= maxMinutes)) &&
      (!profile.householdSize || !recipe.servings || recipe.servings >= profile.householdSize) &&
      (!profile.hasChildren || !/остр\w*\s+перец|чили|халапеньо/iu.test([recipe.title, ...(recipe.ingredients || []).map((item) => item.name || item.raw)].join(' ')));
  }) || null;
}

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

export async function resolveRecipeRequest(userId, query, { generate = generateRequestedRecipe } = {}) {
  const existing = findRequestedRecipe(userId, query);
  if (existing) return { kind: 'existing', recipe: existing };
  const { normalized, profile, excluded, maxMinutes } = requestContext(userId, query);
  const suggestionKey = `request:${normalized}`;
  const cached = findRecipeSuggestion(userId, suggestionKey);
  if (cached) return { kind: 'generated', suggestion: cached };
  const key = JSON.stringify(['request', userId, normalized]);
  if (inFlight.has(key)) return inFlight.get(key);
  const task = (async () => {
    const recentTitles = listRecipes(userId).filter((recipe) => recipe.status === 'ready').slice(0, 12).map((recipe) => recipe.title);
    const recipe = await generate({ userId, query: normalized, profile: { ...profile, excludedIngredients: excluded, preferredMaxCookingTime: Number.isFinite(maxMinutes) ? maxMinutes : null }, recentTitles });
    const ingredientsAndSteps = { ingredients: [
      { name: recipe.title },
      ...(recipe.ingredients || []),
      ...(recipe.ingredients || []).filter((item) => item.comment).map((item) => ({ name: item.comment })),
      ...(recipe.steps || []).map((step) => ({ name: step.text }))
    ] };
    const minutes = (recipe.prepMinutes ?? 0) + (recipe.cookMinutes ?? 0);
    if (!recipe.title?.trim() || !recipe.ingredients?.length || !recipe.steps?.length ||
      hasExcludedIngredient(ingredientsAndSteps, excluded) ||
      !Number.isInteger(recipe.prepMinutes) || recipe.prepMinutes < 0 || !Number.isInteger(recipe.cookMinutes) || recipe.cookMinutes < 0 || minutes < 5 ||
      !Number.isInteger(recipe.servings) || recipe.servings < (profile.householdSize || 1) ||
      (maxMinutes < Infinity && minutes > maxMinutes) ||
      recentTitles.some((title) => title.toLocaleLowerCase('ru') === recipe.title.trim().toLocaleLowerCase('ru'))) {
      throw Object.assign(new Error('Рецепт не прошёл проверку предпочтений. Уточните запрос и попробуйте ещё раз.'), { status: 422 });
    }
    return { kind: 'generated', suggestion: createRecipeSuggestion(userId, suggestionKey, recipe) };
  })();
  inFlight.set(key, task);
  try { return await task; } finally { inFlight.delete(key); }
}
