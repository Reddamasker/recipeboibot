import { createHash, randomUUID } from 'node:crypto';
import { config } from './config.js';
import { log } from './log.js';
import { generateDinnerRecipes } from './openai.js';
import { generateRecipeImage } from './recipe-images.js';
import { SEED_RECIPES, hasExcludedIngredient, isDinnerCandidate, rankCandidates, recipeCategories, recipeMainIngredients, selectDinnerChoices, shortlistDinnerCandidates, totalMinutes } from './dinner.js';
import { acceptedDinnerOptionId, addDinnerEvent, currentDinnerOptions, getDinnerOption, getDinnerRecommendation, getDinnerSession, insertDinnerOption, invalidateDinnerBuffer, listDinnerOptions, promoteDinnerOptions, retireDinnerOptions, setDinnerBufferRetry, setDinnerOptionImage } from './dinner-store.js';

export const DINNER_BUFFER = Object.freeze({ version: 5, visible: 3, total: 6, retryMs: 60000, imageConcurrency: 3 });
const MAX_GENERATION_ATTEMPTS = 3;
const fills = new Map(), imageTasks = new Map();
let activeImages = 0;
const imageQueue = [];
export const dinnerContextKey = ({ profile, pantry, requestedCategories = [] }) => createHash('sha256').update(JSON.stringify({ version: DINNER_BUFFER.version, profile, pantry, requestedCategories })).digest('hex');
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
  if (item.role === 'variety' && (typeof item.discovery !== 'string' || item.discovery.trim().length < 8 || item.discovery.length > 200)) return null;
  // Ignore provider IDs, sources and main-ingredient claims; derive the base from actual ingredients.
  const recipe = { title: raw.title.trim(), description: raw.description, servings: raw.servings, prepMinutes: raw.prepMinutes, cookMinutes: raw.cookMinutes,
    ingredients: raw.ingredients.map((i) => ({ name: i.name.trim(), raw: i.name.trim(), quantity: i.quantity, unit: i.unit, comment: typeof i.comment === 'string' ? i.comment.slice(0, 300) : null })),
    steps: raw.steps.map((s, i) => ({ position: i + 1, text: s.text })), tags: raw.tags, warnings: [],
    discovery: item.role === 'variety' ? item.discovery.trim() : null, origin: 'generated', dinnerGenerated: true, userSaved: false,
    sourceName: 'Создано для тебя', sourceUrl: null, thumbnailUrl: null };
  recipe.mainIngredients = recipeMainIngredients(recipe);
  if (context.pantry.length && !recipe.mainIngredients.length) return null;
  if (!isDinnerCandidate(recipe) || !rankCandidates([recipe], context).length) return null;
  // Also reject forbidden ingredients mentioned only in preparation text.
  if (hasExcludedIngredient({ ingredients: [...recipe.ingredients, ...recipe.ingredients.filter((i) => i.comment).map((i) => ({ name: i.comment })), ...recipe.steps.map((s) => ({ name: s.text }))] }, context.profile.excludedIngredients)) return null;
  return { recipe, role: item.role, categories: recipeCategories(recipe), method: 'generated' };
}

const ready = (userId, sessionId) => listDinnerOptions(userId, sessionId).filter((o) => o.state === 'ready');
const activeCount = (userId, sessionId) => ready(userId, sessionId).length + currentDinnerOptions(userId, sessionId).length;
function nextBatch(options) {
  const selected = [];
  for (const role of ['familiar','quick','variety']) {
    const option = options.find((o) => o.role === role && !selected.includes(o));
    if (option) selected.push(option);
  }
  for (const option of options) if (selected.length < DINNER_BUFFER.visible && !selected.includes(option)) selected.push(option);
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
  const previous = listDinnerOptions(userId, sessionId), excluded = [...context.rejected, ...previous.map((o) => o.recipe.id)];
  const candidates = [...context.saved, ...SEED_RECIPES].filter((r) => !duplicateDinner(r, previous.map((o) => o.recipe)));
  let ranked = rankCandidates(candidates, { ...context, rejected: excluded });
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

function fill(userId, sessionId, getContext, { generate = generateDinnerRecipes, images = true, catalogFirst = true } = {}) {
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
      const maxAttempts = context.requestedCategories.length ? MAX_GENERATION_ATTEMPTS : 1;
      let added = 0, attempts = 0;
      while (added < count && attempts < maxAttempts) {
        attempts++;
        const needed = count - added;
        const result = await generate({ userId, count: needed, profile: context.profile, pantry: context.pantry, signals: context.categorySignals,
          requestedCategories: context.requestedCategories, recentRecipes: [...context.recentRecipes, ...context.library.slice(0, 8).map((r) => r.title)].slice(0, 20),
          rejectedTitles: [...prior.map((o) => o.recipe.title), ...attemptedTitles].slice(-40) });
        if (!getDinnerSession(userId, sessionId) || acceptedDinnerOptionId(userId, sessionId) || dinnerContextKey(getContext()) !== key) return;
        const generated = Array.isArray(result?.recipes) ? result.recipes : [];
        attemptedTitles.push(...generated.map((item) => item?.recipe?.title).filter(Boolean));
        for (const item of generated.slice(0, needed)) {
          if (activeCount(userId, sessionId) >= DINNER_BUFFER.total) break;
          const valid = validateGeneratedDinner(item, context);
          if (!valid || duplicateDinner(valid.recipe, existing)) continue;
          if ([...currentDinnerOptions(userId, sessionId), ...ready(userId, sessionId)].filter((o) => o.role === valid.role).length >= DINNER_BUFFER.total / DINNER_BUFFER.visible) continue;
          const id = randomUUID(); valid.recipe.id = `dinner:${id}`;
          if (insertDinnerOption(userId, sessionId, { ...valid, id }, titleKey(valid.recipe))) { existing.push(valid.recipe); added++; }
        }
      }
      if (added < count) setDinnerBufferRetry(userId, sessionId, Date.now() + DINNER_BUFFER.retryMs);
      fallbackFill(userId, sessionId, context, active + count);
      addDinnerEvent(userId, 'dinner_buffer_filled', { sessionId, detail: { requested: count, generated: added, attempts } });
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
  return { current: currentDinnerOptions(userId, sessionId), reserve: nextBatch(ready(userId, sessionId)), preparing: fills.has(sessionId) };
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
