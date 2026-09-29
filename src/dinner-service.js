import { listRecipes } from './db.js';
import { config } from './config.js';
import { requireUnexpiredTrial } from './subscriptions.js';
import { bufferedDinner, dinnerContextKey, prefetchDinnerBuffer } from './dinner-buffer.js';
import { findReusableDinnerSession, getDinnerOption, markDinnerSessionOpened } from './dinner-store.js';
import { DINNER_CATEGORIES, DINNER_WEIGHTS, SEED_RECIPES, isDinnerCandidate, rankCandidates, recipeCategories, totalMinutes } from './dinner.js';
import { addDinnerEvent, addDinnerRejectionReason, decideDinnerRecommendation, getDinnerContext, getDinnerHistory, getDinnerRecommendation, getDinnerRequestCategories, getDinnerSession, getFoodProfile, markDinnerCooked, openDinnerSession, rejectDinnerRecommendations, rejectedInSession, retryCountInSession, saveFoodProfile, setDinnerContext } from './dinner-store.js';
import { normalizeDinnerIntake, parseDinnerIntakeFallback } from './dinner-intake.js';
import { getDinnerMealRequest } from './dinner-store.js';
import { normalizeMealRequest, parseMealRequest } from './meal-request.js';

const badRequest = (message) => Object.assign(new Error(message), { status: 400 });
const notFound = () => Object.assign(new Error('Сценарий ужина не найден'), { status: 404 });
const CATEGORIES = new Set(DINNER_CATEGORIES.map(([key]) => key));

export function updateDinnerProfile(userId, input) {
  const current = getFoodProfile(userId);
  const householdType = input.householdType ?? current.householdType;
  if (householdType !== null && !['self', 'couple', 'family'].includes(householdType)) throw badRequest('Неверный размер семьи');
  const householdSize = input.householdSize === undefined ? current.householdSize : input.householdSize;
  if (householdSize !== null && (!Number.isInteger(householdSize) || householdSize < 1 || householdSize > 10)) throw badRequest('Укажите число едоков от 1 до 10');
  const hasChildren = input.hasChildren === undefined ? current.hasChildren : input.hasChildren;
  if (hasChildren !== null && typeof hasChildren !== 'boolean') throw badRequest('Проверьте ответ о детях');
  const preferredMaxCookingTime = input.preferredMaxCookingTime === undefined ? current.preferredMaxCookingTime : input.preferredMaxCookingTime;
  if (preferredMaxCookingTime !== null && (!Number.isInteger(preferredMaxCookingTime) || preferredMaxCookingTime < 10 || preferredMaxCookingTime > 120)) throw badRequest('Укажите время от 10 до 120 минут');
  const excludedIngredients = input.excludedIngredients === undefined ? current.excludedIngredients : input.excludedIngredients;
  if (!Array.isArray(excludedIngredients) || excludedIngredients.length > 20 || excludedIngredients.some((item) => typeof item !== 'string' || item.length > 80)) throw badRequest('Проверьте исключённые продукты');
  const categories = input.preferredCategories === undefined ? current.preferredCategories : input.preferredCategories;
  const dishPreferences = input.dishPreferences ?? current.dishPreferences;
  if (!dishPreferences || typeof dishPreferences !== 'object' || Array.isArray(dishPreferences) || Object.entries(dishPreferences).length > 30 || Object.entries(dishPreferences).some(([key, value]) => key.length < 2 || key.length > 100 || ![-1, 1].includes(value))) throw badRequest('Проверьте любимые блюда');
  if (!categories || typeof categories !== 'object' || Array.isArray(categories) || Object.entries(categories).some(([key, value]) => !CATEGORIES.has(key) || !Number.isFinite(value) || value < -1 || value > 1)) throw badRequest('Проверьте предпочтения в блюдах');
  const tastePreferencesStatus = input.tastePreferencesStatus === undefined ? current.tastePreferencesStatus : input.tastePreferencesStatus;
  if (!['pending', 'completed', 'skipped'].includes(tastePreferencesStatus)) throw badRequest('Проверьте статус знакомства со вкусами');
  const firstCompletion = !current.onboardingCompleted && input.onboardingCompleted === true;
  const saved = saveFoodProfile(userId, { householdType, householdSize, hasChildren, preferredMaxCookingTime, excludedIngredients: [...new Set(excludedIngredients.map((item) => item.trim().toLocaleLowerCase('ru')).filter(Boolean))], preferredCategories: categories, dishPreferences, tastePreferencesStatus, onboardingCompleted: Boolean(input.onboardingCompleted ?? current.onboardingCompleted) });
  if (tastePreferencesStatus !== current.tastePreferencesStatus && tastePreferencesStatus !== 'pending') addDinnerEvent(userId, `taste_preferences_${tastePreferencesStatus}`);
  if (firstCompletion) addDinnerEvent(userId, 'onboarding_completed');
  return saved;
}

export function confirmDinnerIntake(userId, input) {
  const intake = normalizeDinnerIntake(input);
  if (!intake.availableIngredients.length && !intake.mealRequest) throw badRequest('Назовите продукты или пожелание к ужину');
  const current = getFoodProfile(userId);
  const hasTasteAnswers = Object.keys(intake.preferredCategories).length > 0 || Object.keys(intake.dishPreferences || {}).length > 0;
  const profile = updateDinnerProfile(userId, {
    householdType: intake.householdType || current.householdType,
    householdSize: intake.householdSize ?? current.householdSize,
    hasChildren: intake.hasChildren ?? current.hasChildren,
    preferredMaxCookingTime: intake.maxMinutes ?? current.preferredMaxCookingTime,
    excludedIngredients: [...new Set([...current.excludedIngredients, ...intake.excludedIngredients])],
    preferredCategories: { ...current.preferredCategories, ...intake.preferredCategories },
    dishPreferences: { ...current.dishPreferences, ...intake.dishPreferences },
    tastePreferencesStatus: current.tastePreferencesStatus === 'pending' && hasTasteAnswers ? 'completed' : current.tastePreferencesStatus,
    onboardingCompleted: true
  });
  setDinnerContext(userId, intake.availableIngredients, intake.requestedCategories, intake.mealRequest);
  addDinnerEvent(userId, 'dinner_intake_confirmed', { detail: { pantryCount: intake.availableIngredients.length, requestedCategories: intake.requestedCategories, householdSize: intake.householdSize, hasChildren: intake.hasChildren } });
  return { profile, pantry: getDinnerContext(userId), requestedCategories: getDinnerRequestCategories(userId), mealRequest: getDinnerMealRequest(userId) };
}

export function startDinner(userId, { prefetchOnly = false } = {}) {
  const profile = getFoodProfile(userId);
  const pantry = getDinnerContext(userId), requestedCategories = getDinnerRequestCategories(userId), mealRequest = getDinnerMealRequest(userId);
  const sessionId = findReusableDinnerSession(userId, (session) => {
    try { return session.buffer_context === dinnerContextKey(dinnerContext(userId, session.id)); }
    catch (error) { if (error.status === 409) return false; throw error; }
  }) || openDinnerSession(userId, { prefetchOnly });
  if (!prefetchOnly) markDinnerSessionOpened(userId, sessionId);
  const needsOnboarding = !profile.onboardingCompleted && listRecipes(userId).filter((recipe) => recipe.status === 'ready').length < 3;
  return { sessionId, profile, pantry, requestedCategories, mealRequest, needsOnboarding, needsTastePreferences: profile.tastePreferencesStatus === 'pending' };
}

export function changeDinnerRequest(userId, query) {
  if (typeof query !== 'string' || query.length > 500) throw badRequest('Пожелание должно быть не длиннее 500 символов');
  const intake = query.trim() ? parseDinnerIntakeFallback(`сегодня хочу ${query.trim()}`) : {};
  intake.mealRequest = parseMealRequest(query);
  setDinnerContext(userId, getDinnerContext(userId), intake.requestedCategories || [], intake.mealRequest || null);
  return startDinner(userId);
}

export function resumeDinner(userId, sessionId) {
  if (!getDinnerSession(userId, sessionId)) throw notFound();
  markDinnerSessionOpened(userId, sessionId);
  const profile = getFoodProfile(userId);
  return { sessionId, profile, pantry: getDinnerContext(userId), requestedCategories: getDinnerRequestCategories(userId), mealRequest: getDinnerMealRequest(userId), needsOnboarding: false, needsTastePreferences: profile.tastePreferencesStatus === 'pending' };
}

export function startDinnerOnboarding(userId, sessionId) {
  if (!getDinnerSession(userId, sessionId)) throw notFound();
  addDinnerEvent(userId, 'onboarding_started', { sessionId });
  return { started: true };
}

function categorySignals(recipes, history) {
  const signals = {};
  for (const recipe of recipes) for (const key of recipeCategories(recipe)) signals[key] = (signals[key] || 0) + DINNER_WEIGHTS.saveSignal;
  for (const event of history) {
    const weight = event.event === 'recommendation_accepted' ? DINNER_WEIGHTS.acceptSignal : event.event === 'recipe_cooked' ? DINNER_WEIGHTS.cookSignal : 0;
    if (weight) for (const key of event.detail.categories || []) signals[key] = (signals[key] || 0) + weight;
  }
  return signals;
}

function recommendationReasons(chosen, profile, signals, history) {
  const reasons = [];
  if (chosen.minutes !== null) reasons.push(`${chosen.minutes} минут`);
  if (chosen.recipe.userSaved) reasons.push('Ты сохранил этот рецепт');
  if (!chosen.categories.some((key) => profile.preferredCategories[key] < 0) && chosen.categories.some((key) => (signals[key] || 0) + (profile.preferredCategories[key] || 0) >= 0.5)) reasons.push('Подходит под твои предпочтения');
  if (profile.householdType === 'family' && chosen.recipe.servings >= 3) reasons.push('Подходит для семьи');
  if (history.some((event) => event.event === 'recipe_cooked') && !history.some((event) => event.recipeKey === chosen.recipe.id && event.event === 'recipe_cooked')) reasons.push('Ты ещё не готовил это блюдо');
  return reasons.slice(0, 3);
}

function recommendationPitch({ candidate, role }, choices) {
  if (role === 'familiar' && candidate.pantryMatch?.missing.length === 0) return { label: 'Из того, что есть', reason: 'Из продуктов, которые ты назвал' };
  if (role === 'familiar' && candidate.pantryMatch?.matchedMainIngredients?.length) return { label: 'Основа уже есть', reason: `${candidate.pantryMatch.matchedMainIngredients[0]} уже есть дома` };
  if (role === 'familiar') return candidate.recipe.userSaved
    ? { label: 'Сохранённое', reason: 'Ты сохранил этот рецепт' }
    : { label: 'На сегодня', reason: 'Из нашей подборки' };
  if (role === 'quick') return { label: 'Быстро', reason: `${candidate.minutes} мин` };
  if (role === 'variety') {
    if (candidate.recipe.discovery) return { label: 'Попробовать новое', reason: candidate.recipe.discovery };
    const otherCategories = new Set(choices.filter((choice) => choice.role !== 'variety').flatMap((choice) => choice.candidate.categories));
    const differentCategory = candidate.categories.find((key) => !otherCategories.has(key));
    const categoryName = DINNER_CATEGORIES.find(([key]) => key === differentCategory)?.[1];
    const categoryCopy = { pasta: 'Паста для разнообразия', rice: 'Блюдо с рисом для разнообразия', asian: 'Азиатское для разнообразия', chicken: 'Курица для разнообразия', meat: 'Мясное для разнообразия', fish: 'Рыба для разнообразия', soup: 'Суп для разнообразия', salad: 'Салат для разнообразия', home: 'Домашнее для разнообразия' };
    const steps = (candidate.recipe.steps || []).map((step) => step.text || step).join(' ');
    if (!differentCategory && /обжар|сковород/iu.test(steps)) return { label: 'Другой способ', reason: 'Можно приготовить на сковороде' };
    if (!differentCategory && /запек|духовк/iu.test(steps)) return { label: 'Другой способ', reason: 'Можно запечь в духовке' };
    return { label: candidate.recipe.userSaved ? 'Другой вкус' : 'Новое', reason: categoryCopy[differentCategory] || (categoryName ? `${categoryName} для разнообразия` : candidate.recipe.userSaved ? 'Другой вариант из твоих рецептов' : 'Новый вариант из нашей подборки') };
  }
  return { label: 'Ещё вариант', reason: candidate.recipe.userSaved ? 'Из твоих рецептов' : 'Из нашей подборки' };
}

export function dinnerContext(userId, sessionId) {
  const session = getDinnerSession(userId, sessionId);
  if (!session) throw notFound();
  const pantry = JSON.parse(session.pantry_json || '[]');
  const requestedCategories = JSON.parse(session.requested_categories_json || '[]');
  const mealRequest = normalizeMealRequest(JSON.parse(session.meal_request_json || 'null'));
  if (JSON.stringify(mealRequest) !== JSON.stringify(getDinnerMealRequest(userId))) throw Object.assign(new Error('Пожелание изменилось. Открой подбор заново.'), { status: 409 });
  if (JSON.stringify(pantry) !== JSON.stringify(getDinnerContext(userId)) || JSON.stringify(requestedCategories) !== JSON.stringify(getDinnerRequestCategories(userId))) throw Object.assign(new Error('Пожелания к ужину обновились. Открой подбор заново.'), { status: 409 });
  const profile = getFoodProfile(userId);
  const library = listRecipes(userId).filter((recipe) => recipe.status === 'ready').map((recipe) => ({ ...recipe, userSaved: true }));
  const saved = library.filter(isDinnerCandidate), history = getDinnerHistory(userId);
  const tooLong = history.filter((event) => event.sessionId === sessionId && event.event === 'dinner_rejection_reason' && event.detail.reason === 'too_long')
    .map((event) => recipeForDecision(userId, event.recipeKey)).filter(Boolean).map(totalMinutes).filter((m) => m !== null);
  const sessionMax = tooLong.length ? Math.max(5, Math.min(...tooLong) - 5) : null;
  const recentRecipes = history.filter((event) => ['recipe_cooked','recommendation_accepted'].includes(event.event) && Date.now() - Date.parse(event.createdAt) < 7 * 86400000)
    .slice(0, 20).map((event) => recipeForDecision(userId, event.recipeKey)?.title).filter(Boolean);
  const reasons = history.filter((event) => event.sessionId === sessionId && event.event === 'dinner_rejection_reason');
  const feedback = { simpleOnly: reasons.some((event) => event.detail.reason === 'too_hard'),
    unavailableIngredients: [...new Set(reasons.flatMap((event) => event.detail.missingIngredients || []))],
    avoidTitles: history.filter((event) => event.event === 'dinner_rejection_reason' && ((event.sessionId === sessionId && ['not_today', 'other'].includes(event.detail.reason)) || (event.detail.reason === 'recently_ate' && Date.now() - Date.parse(event.createdAt) < 7 * 86400000))).map((event) => recipeForDecision(userId, event.recipeKey)?.title).filter(Boolean) };
  return { profile: sessionMax ? { ...profile, preferredMaxCookingTime: Math.min(profile.preferredMaxCookingTime || Infinity, sessionMax) } : profile,
    pantry, requestedCategories, mealRequest, feedback, library, saved, history, recentRecipes, categorySignals: categorySignals(library, history), rejected: rejectedInSession(userId, sessionId) };
}

function bufferResponse(userId, sessionId, buffer) {
  const context = dinnerContext(userId, sessionId);
  const format = (options) => {
    const choices = options.map((option) => ({ candidate: rankCandidates([option.recipe], { ...context, rejected: [] })[0], role: option.role, option })).filter((c) => c.candidate);
    return choices.map((choice) => ({ id: choice.option.id, recipe: choice.option.recipe, role: choice.role,
      pitch: recommendationPitch(choice, choices), reasons: recommendationReasons(choice.candidate, context.profile, context.categorySignals, context.history),
      pantryMatch: choice.candidate.pantryMatch, method: choice.option.method,
      sourceNote: choice.option.recipe.dinnerGenerated ? 'Создано для тебя' : choice.option.recipe.userSaved ? null : 'Вариант из нашей подборки' }));
  };
  const recommendations = format(buffer.current), reserve = format(buffer.reserve);
  const fallback = recommendations.some((r) => r.method === 'deterministic');
  const preparingMessage = context.pantry.length ? 'Готовлю новые рецепты под твои продукты…' : 'Готовлю новые рецепты для тебя…';
  return { sessionId, pantry: context.pantry, mealRequest: context.mealRequest, requestedCategories: context.requestedCategories, recommendations, recommendation: recommendations[0] || null, reserve,
    preparing: buffer.preparing, imagesPending: Boolean(config.dinnerLlmEnabled && config.dinnerImagesEnabled && config.openaiKey && config.imageModel) && [...buffer.current,...buffer.reserve].some((o) => o.recipe.dinnerGenerated && !o.recipe.thumbnailUrl && o.imageState !== 'failed'),
    rejectedCount: context.rejected.length, retryCount: retryCountInSession(userId, sessionId),
    notice: fallback && getDinnerSession(userId, sessionId).buffer_retry_at > Date.now() && config.dinnerLlmEnabled ? 'Сейчас показываю подходящие готовые рецепты: новые варианты пока не удалось подготовить.' : null,
    message: recommendations.length ? null : buffer.preparing ? preparingMessage : context.mealRequest ? 'Не нашёл рецепт, который соответствует всем условиям. Уточни пожелание или попробуй позже.' : 'Пока не удалось подготовить новые рецепты, а подходящий готовый запас закончился. Можно повторить чуть позже или уточнить продукты.' };
}

export async function recommendDinner(userId, sessionId, options) {
  requireUnexpiredTrial(userId);
  const context = dinnerContext(userId, sessionId);
  const effectiveOptions = context.requestedCategories.length || context.mealRequest ? { ...options, catalogFirst: false } : options;
  const buffer = await bufferedDinner(userId, sessionId, () => dinnerContext(userId, sessionId), effectiveOptions);
  return bufferResponse(userId, sessionId, buffer);
}

export function prefetchDinner(userId, sessionId, options) {
  requireUnexpiredTrial(userId);
  const context = dinnerContext(userId, sessionId);
  const effectiveOptions = context.requestedCategories.length || context.mealRequest ? { ...options, catalogFirst: false } : options;
  return bufferResponse(userId, sessionId, prefetchDinnerBuffer(userId, sessionId, () => dinnerContext(userId, sessionId), effectiveOptions));
}

export async function nextDinner(userId, ids, options) {
  requireUnexpiredTrial(userId);
  const result = rejectDinnerBatch(userId, ids);
  return recommendDinner(userId, result.sessionId, options);
}

export function getDinnerRecipe(userId, key) { return recipeForDecision(userId, key); }

export function rejectDinnerBatch(userId, ids) {
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 3 || new Set(ids).size !== ids.length || ids.some((id) => typeof id !== 'string')) throw badRequest('Неверные варианты ужина');
  const rows = ids.map((id) => getDinnerRecommendation(userId, id));
  if (rows.some((row) => !row)) throw notFound();
  const categoriesByKey = Object.fromEntries(rows.map((row) => [row.recipe_key, recipeCategories(recipeForDecision(userId, row.recipe_key) || {})]));
  const result = rejectDinnerRecommendations(userId, ids, categoriesByKey);
  if (!result) throw badRequest('Эти варианты уже выбраны или относятся к разным сессиям');
  return result;
}

function recipeForDecision(userId, key) {
  if (key.startsWith('seed:')) return SEED_RECIPES.find((recipe) => recipe.id === key) || null;
  if (key.startsWith('dinner:')) return getDinnerOption(userId, key.slice(7))?.recipe || null;
  return listRecipes(userId).find((recipe) => recipe.id === key && recipe.status === 'ready') || null;
}

export function decideDinner(userId, recommendationId, decision) {
  const row = getDinnerRecommendation(userId, recommendationId);
  if (!row) throw notFound();
  const recipe = recipeForDecision(userId, row.recipe_key);
  if (decision === 'accepted' && row.status === 'shown' && (!recipe || !rankCandidates([recipe], dinnerContext(userId, row.session_id)).length)) throw badRequest('Ограничения изменились. Обновите варианты ужина.');
  const updated = decideDinnerRecommendation(userId, recommendationId, decision, recipe ? recipeCategories(recipe) : []);
  return { status: updated.status, sessionId: updated.session_id, recipeKey: updated.recipe_key, recipe, rejectedCount: rejectedInSession(userId, updated.session_id).length };
}

export function setDinnerRejectionReason(userId, recommendationId, reason, details = {}) {
  if (!['too_long', 'not_today', 'recently_ate', 'missing_ingredients', 'too_hard', 'other'].includes(reason)) throw badRequest('Неверная причина');
  const ids = details.ids || [recommendationId];
  if (!Array.isArray(ids) || !ids.includes(recommendationId) || ids.length > 3 || !ids.length || new Set(ids).size !== ids.length || ids.some((id) => typeof id !== 'string')) throw badRequest('Неверные варианты ужина');
  const rows = ids.map((id) => getDinnerRecommendation(userId, id));
  if (rows.some((row) => !row || row.status !== 'rejected' || row.session_id !== rows[0].session_id)) throw notFound();
  const missingIngredients = details.missingIngredients || [];
  if (!Array.isArray(missingIngredients) || missingIngredients.length > 20 || missingIngredients.some((v) => typeof v !== 'string' || !v.trim() || v.length > 80)) throw badRequest('Назовите недостающие продукты');
  if (reason === 'missing_ingredients' && !missingIngredients.length) return { saved: false, needsIngredients: true };
  for (const id of ids) addDinnerRejectionReason(userId, id, reason, { missingIngredients: reason === 'missing_ingredients' ? missingIngredients.map((v) => v.trim().toLocaleLowerCase('ru')) : [] });
  return { saved: true };
}

export function finishDinner(userId, recommendationId) {
  const row = getDinnerRecommendation(userId, recommendationId);
  if (!row) throw notFound();
  const recipe = recipeForDecision(userId, row.recipe_key);
  if (!markDinnerCooked(userId, recommendationId, recipe ? recipeCategories(recipe) : [])) throw badRequest('Сначала выберите «Готовим»');
  return { saved: true };
}
