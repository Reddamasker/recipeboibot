import { createRecipeSuggestion, findRecipeSuggestion, listRecipes, searchRecipes } from './db.js';
import { getFoodProfile } from './dinner-store.js';
import { hasExcludedIngredient, SEED_RECIPES, totalMinutes, recipeCategories } from './dinner.js';
import { generateRecipe, generateRequestedRecipe, interpretMealRequest } from './openai.js';
import { ensureSuggestionImage } from './recipe-images.js';
import { requireUnexpiredTrial } from './subscriptions.js';
import { normalizeMealRequest, parseMealRequest, matchesMealRequest, recipeTextIngredients, isSpicy } from './meal-request.js';
import { parseDinnerIntakeFallback } from './dinner-intake.js';
import { log } from './log.js';

const inFlight = new Map();
const REQUEST_CACHE_VERSION = 2;
const requestSuggestionKey = (query) => `request:${REQUEST_CACHE_VERSION}:${query}`;
const requestFromSuggestionKey = (key) => String(key || '').replace(/^request:(?:\d+:)?/u, '');
function requestContext(userId, query, mealRequestOverride = null) {
  const normalized = String(query || '').trim().slice(0, 500);
  if (!normalized) throw Object.assign(new Error('Напишите, что хотите приготовить'), { status: 400 });
  const profile = getFoodProfile(userId), mealRequest = normalizeMealRequest(mealRequestOverride) || parseMealRequest(normalized);
  const excluded = [...profile.excludedIngredients, ...mealRequest.excludedIngredients];
  const maxMinutes = Math.min(profile.preferredMaxCookingTime || Infinity, mealRequest.maxMinutes || Infinity);
  const requestedCategories = parseDinnerIntakeFallback(`сегодня хочу ${normalized}`).requestedCategories;
  return { normalized, profile, mealRequest, excluded, maxMinutes, requestedCategories };
}
function validRecipe(recipe, context, generated = false) {
  const { profile, mealRequest, excluded, maxMinutes } = context;
  const minutes = totalMinutes(recipe);
  return Boolean(recipe.title?.trim() && recipe.ingredients?.length && recipe.steps?.length &&
    matchesMealRequest(recipe, mealRequest) && !hasExcludedIngredient(recipeTextIngredients(recipe), excluded) &&
    context.requestedCategories.every((category) => recipeCategories(recipe).includes(category)) &&
    (maxMinutes === Infinity || ([recipe.prepMinutes, recipe.cookMinutes].every(Number.isFinite) && minutes <= maxMinutes)) &&
    (!profile.householdSize || (Number.isInteger(recipe.servings) && recipe.servings >= profile.householdSize)) &&
    (!profile.hasChildren || !isSpicy(recipe)) &&
    (!generated || (Number.isInteger(recipe.prepMinutes) && recipe.prepMinutes >= 0 && Number.isInteger(recipe.cookMinutes) && recipe.cookMinutes >= 0 && minutes >= 5 && Number.isInteger(recipe.servings) && recipe.servings >= 1)));
}
const invalidRequest = () => Object.assign(new Error('Рецепт не соответствует запросу или текущим ограничениям. Уточните пожелание и попробуйте ещё раз.'), { status: 422 });

export function assertSuggestionCurrent(userId, suggestion) {
  if (!suggestion) throw invalidRequest();
  const query = requestFromSuggestionKey(suggestion.query);
  if (!validRecipe(suggestion.recipe, requestContext(userId, query, suggestion.mealRequest))) throw invalidRequest();
}

export function findRequestedRecipe(userId, query, contextOverride = null) {
  const context = contextOverride || requestContext(userId, query);
  const candidates = [...listRecipes(userId).filter((recipe) => recipe.status === 'ready'), ...SEED_RECIPES];
  const light = /легк|лёгк|низкокалор/u.test(context.normalized);
  return candidates.filter((recipe) => validRecipe(recipe, context) && (!light || recipe.tags?.some((t) => /л[её]гк|низкокалор/iu.test(t))))
    .map((recipe, order) => ({ recipe, order, score: (recipe.title.toLocaleLowerCase('ru').replaceAll('ё', 'е') === context.normalized.toLocaleLowerCase('ru').replaceAll('ё', 'е') ? 100 : 0) + recipeCategories(recipe).reduce((score, category) => score + (context.profile.preferredCategories[category] || 0), 0) +
      Object.entries(context.profile.dishPreferences || {}).reduce((score, [dish, weight]) => score + (matchesMealRequest(recipe, { dish }) ? weight * 4 : 0), 0) }))
    .sort((a, b) => b.score - a.score || a.order - b.order)[0]?.recipe || null;
}

async function generateSuggestion(userId, query, generate, requested, contextOverride = null) {
  requireUnexpiredTrial(userId);
  const context = contextOverride || requestContext(userId, query), { normalized, profile, excluded, maxMinutes, mealRequest } = context;
  const suggestionKey = requested ? requestSuggestionKey(normalized) : normalized;
  const cached = findRecipeSuggestion(userId, suggestionKey);
  if (cached && validRecipe(cached.recipe, context, true)) {
    if (requested && !cached.recipe.thumbnailUrl) void ensureSuggestionImage(userId, cached);
    return cached;
  }
  const key = JSON.stringify([userId, suggestionKey, profile]);
  if (inFlight.has(key)) return inFlight.get(key);
  const task = (async () => {
    const recentTitles = listRecipes(userId).filter((recipe) => recipe.status === 'ready').slice(0, 12).map((recipe) => recipe.title);
    const recipe = await generate({ userId, query: normalized, mealRequest, profile: { ...profile, excludedIngredients: excluded, preferredMaxCookingTime: Number.isFinite(maxMinutes) ? maxMinutes : null }, recentTitles });
    // A profile may change while the provider is responding.
    if (!validRecipe(recipe, requestContext(userId, normalized, mealRequest), true)) throw invalidRequest();
    const suggestion = createRecipeSuggestion(userId, suggestionKey, recipe, mealRequest);
    if (requested) void ensureSuggestionImage(userId, suggestion);
    return suggestion;
  })();
  inFlight.set(key, task);
  try { return await task; } finally { inFlight.delete(key); }
}

async function interpretedContext(userId, query, interpret) {
  const fallback = requestContext(userId, query);
  if (!interpret) return fallback;
  try {
    const mealRequest = await interpret({ userId, query: fallback.normalized });
    return requestContext(userId, query, mealRequest);
  } catch (error) {
    log('warn', 'meal_request_interpretation_fallback', { userId, status: error?.status, code: error?.code });
    return fallback;
  }
}

export async function suggestForEmptySearch(userId, query, { generate = generateRecipe, interpret = generate === generateRecipe ? interpretMealRequest : null } = {}) {
  const context = await interpretedContext(userId, query, interpret);
  if (searchRecipes(userId, context.normalized).some((recipe) => recipe.status === 'ready' && validRecipe(recipe, context))) throw Object.assign(new Error('В коллекции уже есть подходящие рецепты'), { status: 409 });
  return generateSuggestion(userId, query, generate, false, context);
}

export async function resolveRecipeRequest(userId, query, { generate = generateRequestedRecipe, interpret = generate === generateRequestedRecipe ? interpretMealRequest : null } = {}) {
  const normalized = String(query || '').trim().slice(0, 500);
  const cached = normalized && findRecipeSuggestion(userId, requestSuggestionKey(normalized));
  if (cached && validRecipe(cached.recipe, requestContext(userId, normalized, cached.mealRequest), true)) {
    if (!cached.recipe.thumbnailUrl) void ensureSuggestionImage(userId, cached);
    return { kind: 'generated', suggestion: cached };
  }
  const context = await interpretedContext(userId, query, interpret);
  const existing = findRequestedRecipe(userId, query, context);
  if (existing) return { kind: 'existing', recipe: existing };
  return { kind: 'generated', suggestion: await generateSuggestion(userId, query, generate, true, context) };
}
