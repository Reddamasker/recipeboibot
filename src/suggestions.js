import { createHash } from 'node:crypto';
import { createRecipeSuggestion, findRecipeSuggestion, listRecipes, searchRecipes, withNutrition } from './db.js';
import { getFoodProfile, getDinnerHistory, getDinnerOption } from './dinner-store.js';
import { hasExcludedIngredient, SEED_RECIPES, totalMinutes, recipeCategories } from './dinner.js';
import { generateRecipe, generateRequestedRecipe, interpretMealRequest, validateRecipeCriteria } from './openai.js';
import { ensureSuggestionImage } from './recipe-images.js';
import { requireRecipeEntry, withFirstRecipe } from './subscriptions.js';
import { normalizeMealRequest, parseMealRequest, matchesMealRequest, matchesObjectiveMealRequest, needsSemanticValidation, recipeTextIngredients, isSpicy } from './meal-request.js';
import { parseDinnerIntakeFallback } from './dinner-intake.js';
import { log } from './log.js';
import { ensureNutrition } from './nutrition-service.js';
import { excludedDialogueRecipe } from './recipe-dialogue.js';

const inFlight = new Map();
const acceptRecipeCriteria = async ({ recipes }) => recipes.map((recipe) => ({ recipe, accepted: true, preferredScore: 100, failedCriteria: [], evidence: [] }));
const REQUEST_CACHE_VERSION = 5;
function requestSuggestionKey(userId, query, context = null) {
  const profile = getFoodProfile(userId);
  const recentTitles = listRecipes(userId).filter((recipe) => recipe.status === 'ready').slice(0, 20).map((recipe) => recipe.title);
  const version = createHash('sha256').update(JSON.stringify({
    householdSize: profile.householdSize, hasChildren: profile.hasChildren, preferredMaxCookingTime: profile.preferredMaxCookingTime,
    excludedIngredients: profile.excludedIngredients, preferredCategories: profile.preferredCategories, dishPreferences: profile.dishPreferences, recentTitles,
    cookingHistory: getDinnerHistory(userId).filter(item => item.event === 'recipe_cooked').slice(0, 20).map(item => [item.recipeKey, item.createdAt]),
    ...(context ? { mealRequest: context.mealRequest, rejectedRecipes: context.rejectedRecipes || [] } : {})
  })).digest('hex').slice(0, 16);
  return `request:${REQUEST_CACHE_VERSION}:${version}:${query}`;
}
const requestFromSuggestionKey = (key) => String(key || '').replace(/^request:(?:\d+:)?(?:[a-f0-9]{16}:)?/u, '');
function requestContext(userId, query, mealRequestOverride = null, rejectedRecipes = []) {
  const normalized = String(query || '').trim().slice(0, 500);
  if (!normalized) throw Object.assign(new Error('Напишите, что хотите приготовить'), { status: 400 });
  const profile = getFoodProfile(userId), mealRequest = normalizeMealRequest(mealRequestOverride) || parseMealRequest(normalized);
  const understood = normalized;
  const excluded = [...profile.excludedIngredients, ...mealRequest.excludedIngredients];
  const maxMinutes = Math.min(profile.preferredMaxCookingTime || Infinity, mealRequest.maxMinutes || Infinity);
  const requestedCategories = parseDinnerIntakeFallback(`сегодня хочу ${understood}`).requestedCategories;
  const knownRecipes = [...SEED_RECIPES, ...listRecipes(userId)];
  const cookingHistory = getDinnerHistory(userId).filter(item => item.event === 'recipe_cooked' && typeof item.recipeKey === 'string').slice(0, 20)
    .map(item => ({ recipeKey: item.recipeKey, title: (knownRecipes.find(recipe => recipe.id === item.recipeKey)
      || (item.recipeKey.startsWith('dinner:') ? getDinnerOption(userId, item.recipeKey.slice(7))?.recipe : null))?.title || null, cookedAt: item.createdAt }));
  return { normalized, understood, profile, mealRequest, excluded, maxMinutes, requestedCategories, rejectedRecipes, cookingHistory };
}
function validRecipe(recipe, context, generated = false) {
  const { profile, mealRequest, excluded, maxMinutes } = context;
  const minutes = totalMinutes(recipe);
  return Boolean(recipe.title?.trim() && recipe.ingredients?.length && recipe.steps?.length &&
    !excludedDialogueRecipe(recipe, context.rejectedRecipes) &&
    matchesObjectiveMealRequest(recipe, mealRequest) && !hasExcludedIngredient(recipeTextIngredients(recipe), excluded) &&
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

async function requestedRecipes(userId, query, contextOverride = null) {
  const context = contextOverride || requestContext(userId, query);
  const candidates = [...listRecipes(userId).filter((recipe) => recipe.status === 'ready'), ...SEED_RECIPES.map(withNutrition)];
  if (context.mealRequest?.nutritionLimits) {
    const withoutLimits = { ...context, mealRequest: { ...context.mealRequest, nutritionLimits: null } };
    const missing = candidates.filter(recipe => !recipe.nutrition && validRecipe(recipe, withoutLimits) && matchesMealRequest(recipe, withoutLimits.mealRequest)).slice(0, 8);
    await Promise.all(missing.map(async recipe => {
      try { recipe.nutrition = (await ensureNutrition(userId, recipe)).nutrition; }
      catch (error) { log('warn', 'nutrition_candidate_failed', { recipeId: recipe.id, error }); }
    }));
  }
  return candidates.filter((recipe) => validRecipe(recipe, context))
    .map((recipe, order) => {
      const categories = recipeCategories(recipe);
      const retrievalHint = (matchesMealRequest(recipe, context.mealRequest) ? 40 : 0)
        + context.requestedCategories.filter((category) => categories.includes(category)).length * 10;
      return { recipe, order, score: retrievalHint
        + (recipe.title.toLocaleLowerCase('ru').replaceAll('ё', 'е') === context.normalized.toLocaleLowerCase('ru').replaceAll('ё', 'е') ? 100 : 0)
        + categories.reduce((score, category) => score + (context.profile.preferredCategories[category] || 0), 0)
        + Object.entries(context.profile.dishPreferences || {}).reduce((score, [dish, weight]) => score + (matchesMealRequest(recipe, { dish }) ? weight * 4 : 0), 0) };
    })
    .sort((a, b) => b.score - a.score || a.order - b.order);
}

async function generateSuggestion(userId, query, generate, validate, requested, contextOverride = null) {
  requireRecipeEntry(userId);
  const context = contextOverride || requestContext(userId, query), { normalized, understood, profile, excluded, maxMinutes, mealRequest } = context;
  const suggestionKey = requested ? requestSuggestionKey(userId, normalized, context.rejectedRecipes?.length || context.dialogue ? context : null) : normalized;
  const cached = findRecipeSuggestion(userId, suggestionKey);
  if (cached && validRecipe(cached.recipe, context, true)) {
    cached.recipe = await ensureNutrition(userId, cached.recipe);
    if (requested && !cached.recipe.thumbnailUrl) void ensureSuggestionImage(userId, cached);
    return cached;
  }
  const key = JSON.stringify([userId, suggestionKey, profile]);
  if (inFlight.has(key)) return inFlight.get(key);
  const task = (async () => {
    const recentTitles = [...(context.rejectedRecipes || []).map(item => item.title), ...listRecipes(userId).filter((recipe) => recipe.status === 'ready').slice(0, 20).map((recipe) => recipe.title)];
    const generationProfile = { ...profile, excludedIngredients: excluded, preferredMaxCookingTime: Number.isFinite(maxMinutes) ? maxMinutes : null };
    const attempts = context.rejectedRecipes?.length || mealRequest?.nutritionLimits || needsSemanticValidation(mealRequest, context.requestedCategories) ? 2 : 1;
    let recipe = null, validationFeedback = [];
    for (let attempt = 0; attempt < attempts; attempt++) {
      const candidate = await ensureNutrition(userId, await generate({ userId, query: understood, mealRequest, profile: generationProfile, recentTitles, validationFeedback }));
      // A profile may change while the provider is responding.
      if (!validRecipe(candidate, requestContext(userId, normalized, mealRequest, context.rejectedRecipes), true)) {
        if (excludedDialogueRecipe(candidate, context.rejectedRecipes)) {
          validationFeedback = ['Пользователь уже отклонил это блюдо. Предложи другое блюдо, сохранив все условия запроса.'];
          continue;
        }
        if (!mealRequest?.nutritionLimits) throw invalidRequest();
        validationFeedback = ['Рецепт нарушает числовые ограничения времени, порций или КБЖУ. Исправь состав и пересчитай значения.'];
        continue;
      }
      const [verdict] = await validate({ userId, query: understood, mealRequest, requestedCategories: context.requestedCategories, recipes: [candidate], profile: generationProfile, recentTitles, rejectedRecipes: context.rejectedRecipes, cookingHistory: context.cookingHistory });
      if (verdict?.accepted) { recipe = candidate; break; }
      validationFeedback = verdict?.failedCriteria || ['Рецепт не прошёл независимую смысловую проверку'];
    }
    if (!recipe) throw invalidRequest();
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
    const interpreted = requestContext(userId, query, mealRequest);
    const understood = String(interpreted.mealRequest?.text || interpreted.normalized).trim().slice(0, 500);
    const requestedCategories = parseDinnerIntakeFallback(`сегодня хочу ${understood}`).requestedCategories;
    return { ...interpreted, understood, requestedCategories };
  } catch (error) {
    log('warn', 'meal_request_interpretation_fallback', { userId, status: error?.status, code: error?.code });
    return fallback;
  }
}

export async function suggestForEmptySearch(userId, query, { generate = generateRecipe, interpret = generate === generateRecipe ? interpretMealRequest : null, validate = generate === generateRecipe ? validateRecipeCriteria : acceptRecipeCriteria } = {}) {
  return withFirstRecipe(userId, `search:${String(query).trim()}`, async () => {
  const context = await interpretedContext(userId, query, interpret);
  const existing = searchRecipes(userId, context.normalized).filter((recipe) => recipe.status === 'ready' && validRecipe(recipe, context)).slice(0, 8);
  if (existing.length) {
    const verdicts = await validate({ userId, query: context.normalized, mealRequest: context.mealRequest, requestedCategories: context.requestedCategories,
      recipes: existing, profile: context.profile, recentTitles: listRecipes(userId).filter((recipe) => recipe.status === 'ready').slice(0, 20).map((recipe) => recipe.title) });
    if (verdicts.some((verdict) => verdict.accepted)) throw Object.assign(new Error('В коллекции уже есть подходящие рецепты'), { status: 409 });
  }
  return generateSuggestion(userId, query, generate, validate, false, context);
  });
}

export async function resolveRecipeRequest(userId, query, { generate = generateRequestedRecipe, interpret = generate === generateRequestedRecipe ? interpretMealRequest : null, validate = generate === generateRequestedRecipe ? validateRecipeCriteria : acceptRecipeCriteria, mealRequest: override = null, rejectedRecipes = [] } = {}) {
  return withFirstRecipe(userId, `request:${JSON.stringify([String(query).trim(), override, rejectedRecipes])}`, async () => {
  const normalized = String(query || '').trim().slice(0, 500);
  const dialogueContext = override || rejectedRecipes.length ? { ...requestContext(userId, normalized, override, rejectedRecipes), dialogue: true } : null;
  const cached = findRecipeSuggestion(userId, requestSuggestionKey(userId, normalized, dialogueContext));
  if (cached && validRecipe(cached.recipe, requestContext(userId, normalized, override || cached.mealRequest, rejectedRecipes), true)) {
    cached.recipe = await ensureNutrition(userId, cached.recipe);
    if (!cached.recipe.thumbnailUrl) void ensureSuggestionImage(userId, cached);
    return { kind: 'generated', query: cached.mealRequest?.text || normalized, mealRequest: override || cached.mealRequest, suggestion: cached };
  }
  const context = dialogueContext || await interpretedContext(userId, query, interpret);
  const ranked = (await requestedRecipes(userId, query, context)).slice(0, 8);
  if (ranked.length) {
    const recentTitles = [...rejectedRecipes.map(item => item.title), ...listRecipes(userId).filter((recipe) => recipe.status === 'ready').slice(0, 20).map((recipe) => recipe.title)];
    const verdicts = await validate({ userId, query: context.understood, mealRequest: context.mealRequest, requestedCategories: context.requestedCategories, recipes: ranked.map((item) => item.recipe), profile: context.profile, recentTitles, rejectedRecipes, cookingHistory: context.cookingHistory });
    const accepted = verdicts.map((verdict, index) => ({ ...verdict, order: index })).filter((verdict) => verdict.accepted)
      .sort((a, b) => b.preferredScore - a.preferredScore || a.order - b.order)[0];
    if (accepted) return { kind: 'existing', query: context.understood, mealRequest: context.mealRequest, recipe: await ensureNutrition(userId, accepted.recipe) };
  }
  return { kind: 'generated', query: context.understood, mealRequest: context.mealRequest, suggestion: await generateSuggestion(userId, query, generate, validate, true, context) };
  });
}
