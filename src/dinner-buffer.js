import { createHash, randomUUID } from 'node:crypto';
import { config } from './config.js';
import { log } from './log.js';
import { generateDinnerRecipes, validateRecipeCriteria } from './openai.js';
import { generateRecipeImage } from './recipe-images.js';
import { SEED_RECIPES, hasExcludedIngredient, isDinnerCandidate, rankCandidates, recipeCategories, recipeMainIngredients, selectDinnerChoices, shortlistDinnerCandidates, totalMinutes } from './dinner.js';
import { acceptedDinnerOptionId, addDinnerEvent, currentDinnerOptions, getDinnerOption, getDinnerRecommendation, getDinnerSession, insertDinnerOption, invalidateDinnerBuffer, listDinnerOptions, promoteDinnerOptions, retireDinnerOptions, setDinnerBufferRetry, setDinnerOptionImage } from './dinner-store.js';
import { needsSemanticValidation } from './meal-request.js';
import { recipeNutrition } from './nutrition.js';

export const DINNER_BUFFER = Object.freeze({ version: 11, visible: 3, total: 6, retryMs: 60000, imageConcurrency: 3 });
const MAX_GENERATION_ATTEMPTS = 1;
const fills = new Map(), imageTasks = new Map();
const acceptRecipeCriteria = async ({ recipes }) => recipes.map((recipe) => ({ recipe, accepted: true, preferredScore: 100, failedCriteria: [], evidence: [] }));
let activeImages = 0;
const imageQueue = [];
export const dinnerContextKey = ({ profile, pantry, requestedCategories = [], mealRequest = null, saved = [], feedback = { simpleOnly: false, unavailableIngredients: [], avoidTitles: [] } }) => createHash('sha256').update(JSON.stringify({ version: DINNER_BUFFER.version, profile, pantry, requestedCategories, mealRequest, feedback, saved: saved.map(r => [r.id, r.title, r.ingredients, r.steps, r.servings, r.prepMinutes, r.cookMinutes]) })).digest('hex');
const titleKey = (recipe) => String(recipe.title || '').toLocaleLowerCase('ru').replaceAll('ё', 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
export function duplicateDinner(recipe, existing) {
  const title = titleKey(recipe), words = new Set(title.split(' ').filter((w) => w.length > 3));
  return existing.some((r) => {
    if (titleKey(r) === title) return true;
    const other = new Set(titleKey(r).split(' ').filter((w) => w.length > 3));
    const overlap = [...words].filter((w) => other.has(w)).length;
    return Math.min(words.size, other.size) >= 3 && overlap / new Set([...words, ...other]).size >= 0.8;
  });
}

// Rotate across sessions and IDs, including saved copies of catalog dishes.
export function rotateDinnerCandidates(ranked, recentShownRecipes = [], now = Date.now()) {
  const unique = [];
  for (const candidate of ranked) {
    if (!duplicateDinner(candidate.recipe, unique.map(item => item.recipe))) unique.push(candidate);
  }
  ranked = unique;
  const lastShown = recipe => recentShownRecipes.reduce((last, shown) =>
    duplicateDinner(recipe, [shown.recipe]) ? Math.max(last, Date.parse(shown.createdAt) || 0) : last, 0);
  const fresh = ranked.filter(item => now - lastShown(item.recipe) >= 7 * 86400000);
  if (fresh.length >= DINNER_BUFFER.visible) return fresh;
  const repeated = ranked.filter(item => !fresh.includes(item))
    .sort((a, b) => lastShown(a.recipe) - lastShown(b.recipe) || b.score - a.score);
  return [...fresh, ...repeated.slice(0, DINNER_BUFFER.visible - fresh.length)];
}

export function validateGeneratedDinner(item, context) {
  const raw = item?.recipe;
  if (!raw || !['familiar','quick','variety'].includes(item.role)) return null;
  if (typeof raw.title !== 'string' || raw.title.trim().length < 3 || raw.title.length > 180 || typeof raw.description !== 'string' || raw.description.length > 1500) return null;
  if (!Number.isInteger(raw.servings) || raw.servings < (context.profile.householdSize || 1) || raw.servings > 10) return null;
  if (![raw.prepMinutes, raw.cookMinutes].every((n) => Number.isInteger(n) && n >= 0 && n <= 180) || totalMinutes(raw) < 5) return null;
  if (!Array.isArray(raw.ingredients) || raw.ingredients.length < 2 || raw.ingredients.length > 20 || raw.ingredients.some((i) => typeof i?.name !== 'string' || !i.name.trim() || i.name.length > 100 || !Number.isFinite(i.quantity) || i.quantity <= 0 || typeof i.unit !== 'string' || !i.unit.trim())) return null;
  if (!Array.isArray(raw.steps) || raw.steps.length < 4 || raw.steps.length > 10 || raw.steps.some((s) => typeof s?.text !== 'string' || s.text.trim().length < 12 || s.text.length > 1600)) return null;
  if (!Array.isArray(raw.tags) || raw.tags.some((t) => typeof t !== 'string' || t.length > 80)) return null;
  const rawRice = raw.ingredients.some((i) => /рис/iu.test(i.name) && !/варен|отвар|готов|быстр/iu.test(i.name));
  if (rawRice && !raw.steps.some((s) => /упаковк/iu.test(s.text)) && raw.steps.some((s) => {
    if (!/рис/iu.test(s.text)) return false;
    const time = s.text.match(/(?:варите|тушите)[^\d.!?]{0,80}(\d{1,2})(?:\s*[–—-]\s*(\d{1,2}))?\s*мин/iu);
    return time && Number(time[2] || time[1]) < 15;
  })) return null;
  const needsDiscovery = item.role === 'variety';
  if (needsDiscovery && (typeof item.discovery !== 'string' || item.discovery.trim().length < 8 || item.discovery.length > 200)) return null;
  // Ignore provider IDs, sources and main-ingredient claims; derive the base from actual ingredients.
  const recipe = { title: raw.title.trim(), description: raw.description, servings: raw.servings, prepMinutes: raw.prepMinutes, cookMinutes: raw.cookMinutes,
    ingredients: raw.ingredients.map((i) => ({ name: i.name.trim(), raw: i.name.trim(), quantity: i.quantity, unit: i.unit, comment: typeof i.comment === 'string' ? i.comment.slice(0, 300) : null })),
    steps: raw.steps.map((s, i) => ({ position: i + 1, text: s.text })), tags: raw.tags, warnings: [],
    discovery: typeof item.discovery === 'string' && item.discovery.trim() ? item.discovery.trim() : null, origin: 'generated', dinnerGenerated: true, userSaved: false,
    sourceName: 'Создано для тебя', sourceUrl: null, thumbnailUrl: null };
  recipe.mainIngredients = recipeMainIngredients(recipe);
  recipe.nutrition = recipeNutrition({ ...recipe, nutrition: raw.nutrition });
  if (!recipe.nutrition) return null;
  if (context.pantry.length && !recipe.mainIngredients.length) return null;
  if (!isDinnerCandidate(recipe) || !rankCandidates([recipe], context).length) return null;
  // Also reject forbidden ingredients mentioned only in preparation text.
  if (hasExcludedIngredient(recipe, context.profile.excludedIngredients)) return null;
  return { recipe, role: item.role, categories: recipeCategories(recipe), method: 'generated' };
}

const ready = (userId, sessionId) => listDinnerOptions(userId, sessionId).filter((o) => o.state === 'ready');
const activeCount = (userId, sessionId) => ready(userId, sessionId).length + currentDinnerOptions(userId, sessionId).length;
function missingRoles(userId, sessionId, count) {
  const active = [...currentDinnerOptions(userId, sessionId), ...ready(userId, sessionId)];
  const counts = Object.fromEntries(['familiar','quick','variety'].map((role) => [role, active.filter((option) => option.role === role).length]));
  const roles = [];
  while (roles.length < count) {
    const role = ['familiar','quick','variety'].sort((left, right) => counts[left] - counts[right])[0];
    roles.push(role); counts[role]++;
  }
  return roles;
}
function nextBatch(options, current = []) {
  const selected = [];
  const vacancies = DINNER_BUFFER.visible - current.length;
  for (const role of ['familiar','quick','variety']) {
    if (current.some(option => option.role === role) || selected.length >= vacancies) continue;
    const option = options.find((o) => o.role === role && !selected.includes(o));
    if (option) selected.push(option);
  }
  for (const option of options) if (selected.length < vacancies && !selected.includes(option)) selected.push(option);
  return selected;
}
function synchronize(userId, sessionId, context) {
  const key = dinnerContextKey(context), session = getDinnerSession(userId, sessionId);
  if (!session) throw Object.assign(new Error('Сценарий ужина не найден'), { status: 404 });
  if (session.buffer_context !== key) invalidateDinnerBuffer(userId, sessionId, key);
  retireDinnerOptions(userId, sessionId);
  return key;
}

function fallbackFill(userId, sessionId, context, target = DINNER_BUFFER.total) {
  // An unjudged catalog recipe must never silently satisfy an open-ended
  // semantic request when the validator or generator is unavailable.
  if (needsSemanticValidation(context.mealRequest, context.requestedCategories)) return;
  const previous = listDinnerOptions(userId, sessionId), excluded = [...context.rejected, ...previous.map((o) => o.recipe.id)];
  const candidates = [...context.saved, ...SEED_RECIPES].filter((r) => !duplicateDinner(r, previous.map((o) => o.recipe)));
  let ranked = rotateDinnerCandidates(rankCandidates(candidates, { ...context, rejected: excluded }), context.recentShownRecipes);
  if (!context.pantry.length) ranked.sort((a, b) => Number(b.recipe.userSaved) - Number(a.recipe.userSaved) || b.score - a.score);
  while (ranked.length && activeCount(userId, sessionId) < target) {
    const preferredCategories = context.profile.preferredCategories || {};
    const choices = selectDinnerChoices(shortlistDinnerCandidates(ranked, context.history, 8, preferredCategories), context.history, { preferTop: context.pantry.length > 0, preferredCategories });
    for (const { candidate, role } of choices) {
      if (activeCount(userId, sessionId) >= target) break;
      const roleCount = [...currentDinnerOptions(userId, sessionId), ...ready(userId, sessionId)].filter((o) => o.role === role).length;
      if (roleCount >= Math.ceil(target / DINNER_BUFFER.visible)) continue;
      insertDinnerOption(userId, sessionId, { id: randomUUID(), recipe: candidate.recipe, categories: candidate.categories, role, method: 'deterministic' }, titleKey(candidate.recipe));
    }
    ranked = ranked.filter((c) => !choices.some((choice) => choice.candidate.recipe.id === c.recipe.id));
  }
}

function warmImages(userId, sessionId) {
  if (!config.dinnerLlmEnabled || !config.dinnerImagesEnabled || !config.openaiKey || !config.imageModel) return;
  const acceptedId = acceptedDinnerOptionId(userId, sessionId);
  const options = acceptedId ? [getDinnerOption(userId, acceptedId)].filter(Boolean) : [...currentDinnerOptions(userId, sessionId), ...ready(userId, sessionId)];
  for (const option of options) {
    if (!option.recipe.dinnerGenerated || ['ready','failed'].includes(option.imageState) || imageTasks.has(option.id)) continue;
    imageTasks.set(option.id, true);
    imageQueue.push({ userId, sessionId, option });
  }
  drainImages();
}
function drainImages() {
  while (activeImages < DINNER_BUFFER.imageConcurrency && imageQueue.length) {
    const { userId, sessionId, option } = imageQueue.shift();
    const current = getDinnerOption(userId, option.id);
    const acceptedId = acceptedDinnerOptionId(userId, sessionId);
    if (!current || current.state === 'discarded' || (acceptedId && acceptedId !== option.id) || getDinnerRecommendation(userId, option.id)?.status === 'rejected') { imageTasks.delete(option.id); continue; }
    activeImages++;
    setDinnerOptionImage(option.id, 'pending');
    void generateRecipeImage(userId, option.recipe).then((image) => setDinnerOptionImage(option.id, image ? 'ready' : 'failed', image))
      .catch((error) => { setDinnerOptionImage(option.id, 'failed'); log('warn', 'dinner_image_failed', { error: error.message }); })
      .finally(() => { activeImages--; imageTasks.delete(option.id); drainImages(); });
  }
}

function fill(userId, sessionId, getContext, { generate = generateDinnerRecipes, validate = generate === generateDinnerRecipes ? validateRecipeCriteria : acceptRecipeCriteria, images = true, catalogFirst = true } = {}) {
  if (acceptedDinnerOptionId(userId, sessionId)) return Promise.resolve();
  if (fills.has(sessionId)) return fills.get(sessionId);
  const context = getContext(), key = synchronize(userId, sessionId, context);
  // House recipes and their stored photos are shared by every user. Creating
  // another image for the same dish is unnecessary. Only fill real catalog gaps
  // with generation, without blocking a usable ready selection.
  if (catalogFirst) fallbackFill(userId, sessionId, context);
  const active = activeCount(userId, sessionId);
  // Return the visible trio first; the reserve is generated in the background.
  const count = active === 0 ? DINNER_BUFFER.visible : DINNER_BUFFER.total - active;
  if (count <= 0) { if (images) warmImages(userId, sessionId); return Promise.resolve(); }
  const session = getDinnerSession(userId, sessionId);
  if (!config.dinnerLlmEnabled || session.buffer_retry_at > Date.now()) {
    fallbackFill(userId, sessionId, context);
    return Promise.resolve();
  }
  const task = (async () => {
    try {
      const prior = listDinnerOptions(userId, sessionId);
      const existing = listDinnerOptions(userId, sessionId).map((o) => o.recipe);
      const attemptedTitles = [];
      const semanticFailures = [];
      let structurallyRejected = 0;
      const maxAttempts = context.requestedCategories.length || context.mealRequest ? MAX_GENERATION_ATTEMPTS : 1;
      let added = 0, attempts = 0;
      while (added < count && attempts < maxAttempts) {
        attempts++;
        const needed = count - added;
        const result = await generate({ userId, count: needed, roles: missingRoles(userId, sessionId, needed), profile: context.profile, pantry: context.pantry, signals: context.categorySignals,
          requestedCategories: context.requestedCategories, mealRequest: context.mealRequest, feedback: context.feedback, recentRecipes: [...context.recentRecipes, ...(context.recentShownRecipes || []).map(r => r.recipe.title)].slice(0, 20),
          rejectedTitles: [...prior.map((o) => o.recipe.title), ...attemptedTitles].slice(-40) });
        if (!getDinnerSession(userId, sessionId) || acceptedDinnerOptionId(userId, sessionId) || dinnerContextKey(getContext()) !== key) return;
        const generated = Array.isArray(result?.recipes) ? result.recipes : [];
        attemptedTitles.push(...generated.map((item) => item?.recipe?.title).filter(Boolean));
        const structurallyValid = generated.slice(0, needed).map((item) => validateGeneratedDinner(item, context)).filter(Boolean);
        structurallyRejected += Math.max(0, Math.min(generated.length, needed) - structurallyValid.length);
        const verdicts = await validate({ userId, query: context.mealRequest?.text || '', mealRequest: context.mealRequest, requestedCategories: context.requestedCategories,
          recipes: structurallyValid.map((item) => item.recipe), profile: context.profile, recentTitles: context.recentRecipes });
        if (!getDinnerSession(userId, sessionId) || acceptedDinnerOptionId(userId, sessionId) || dinnerContextKey(getContext()) !== key) return;
        for (let index = 0; index < structurallyValid.length; index++) {
          if (activeCount(userId, sessionId) >= DINNER_BUFFER.total) break;
          const valid = structurallyValid[index];
          if (!verdicts[index]?.accepted) {
            semanticFailures.push({ title: valid.recipe.title, criteria: verdicts[index]?.failedCriteria || [] });
            continue;
          }
          if (!valid || duplicateDinner(valid.recipe, [...existing, ...(context.recentShownRecipes || []).filter(r => Date.now() - Date.parse(r.createdAt) < 7 * 86400000).map(r => r.recipe)])) continue;
          if ([...currentDinnerOptions(userId, sessionId), ...ready(userId, sessionId)].filter((o) => o.role === valid.role).length >= DINNER_BUFFER.total / DINNER_BUFFER.visible) continue;
          const id = randomUUID(); valid.recipe.id = `dinner:${id}`;
          if (insertDinnerOption(userId, sessionId, { ...valid, id }, titleKey(valid.recipe))) { existing.push(valid.recipe); added++; }
        }
      }
      if (added < count) setDinnerBufferRetry(userId, sessionId, Date.now() + DINNER_BUFFER.retryMs);
      fallbackFill(userId, sessionId, context, active + count);
      addDinnerEvent(userId, 'dinner_buffer_filled', { sessionId, detail: { requested: count, generated: added, attempts, structurallyRejected,
        semanticallyRejected: semanticFailures.length, semanticFailures: semanticFailures.slice(0, 8) } });
    } catch (error) {
      if (getDinnerSession(userId, sessionId) && dinnerContextKey(getContext()) === key) {
        setDinnerBufferRetry(userId, sessionId, Date.now() + DINNER_BUFFER.retryMs);
        fallbackFill(userId, sessionId, context);
        addDinnerEvent(userId, 'dinner_generation_fallback', { sessionId });
      }
      log('warn', 'dinner_generation_fallback', { error: error.message, userId });
    }
    if (images && getDinnerSession(userId, sessionId)) warmImages(userId, sessionId);
  })().finally(() => fills.delete(sessionId));
  fills.set(sessionId, task);
  return task;
}

export function dinnerBufferSnapshot(userId, sessionId, getContext) {
  const context = getContext(); synchronize(userId, sessionId, context);
  let current = currentDinnerOptions(userId, sessionId);
  if (current.length && current.length < DINNER_BUFFER.visible && !current.some(option => option.method === 'first_recipe') && !acceptedDinnerOptionId(userId, sessionId)) {
    current = promoteDinnerOptions(userId, sessionId, nextBatch(ready(userId, sessionId), current).map(option => option.id), { complete: true });
  }
  return { current, reserve: nextBatch(ready(userId, sessionId)), preparing: fills.has(sessionId) };
}
export function prefetchDinnerBuffer(userId, sessionId, getContext, options) {
  void fill(userId, sessionId, getContext, options).catch((error) => log('warn', 'dinner_prefetch_failed', { error: error.message }));
  return dinnerBufferSnapshot(userId, sessionId, getContext);
}
export async function bufferedDinner(userId, sessionId, getContext, options = {}) {
  synchronize(userId, sessionId, getContext());
  const prior = listDinnerOptions(userId, sessionId);
  if (!currentDinnerOptions(userId, sessionId).length) {
    if (!prior.length) {
      if (options.catalogFirst === false) await fill(userId, sessionId, getContext, options);
      else prefetchDinnerBuffer(userId, sessionId, getContext, options);
    }
    else if (!ready(userId, sessionId).length) fallbackFill(userId, sessionId, getContext(), DINNER_BUFFER.visible);
    // Constraints may have changed while the provider was running.
    synchronize(userId, sessionId, getContext());
    promoteDinnerOptions(userId, sessionId, nextBatch(ready(userId, sessionId)).map((o) => o.id));
  }
  prefetchDinnerBuffer(userId, sessionId, getContext, options);
  return dinnerBufferSnapshot(userId, sessionId, getContext);
}
