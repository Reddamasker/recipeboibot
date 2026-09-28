export const DINNER_WEIGHTS = Object.freeze({
  saved: 4, category: 2, timeFit: 1, servingsFit: 1, accepted: 0.7, cooked: 1.5,
  recentCookPenalty: 5, recentShownPenalty: 0.5, saveSignal: 0.15,
  acceptSignal: 0.35, cookSignal: 0.7, repeatSignal: 1,
  pantryFit: 6, pantryMissingPenalty: 1.5, childrenSpicyPenalty: 2, mainIngredientFit: 3, newSideVariety: 2
});

export const DINNER_LIMITS = Object.freeze({ maxShoppingIngredients: 5 });

export const DINNER_CATEGORIES = Object.freeze([
  ['pasta', 'Паста', /паст|макарон|спагетт|лапш/iu],
  ['asian', 'Азиатское', /азиат|терияки|вок|карри|соев|рисов|фунчоз/iu],
  ['chicken', 'Курица', /куриц|курин|бедр|филе птиц/iu],
  ['meat', 'Мясо', /говяд|говяж|свинин|мяс|фарш|индейк/iu],
  ['fish', 'Рыба', /рыб|лосос|треск|тунц|форел|минта|хек|скумбр|сельд/iu],
  ['soup', 'Супы', /суп|борщ|похлеб|щи\b/iu],
  ['salad', 'Салаты', /салат/iu],
  ['home', 'Домашняя еда', /запеканк|котлет|картоф|гречк|домашн/iu]
]);

const ingredient = (name) => String(name || '').toLocaleLowerCase('ru').replaceAll('ё', 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const aliases = {
  гриб: /гриб|шампиньон|вешенк|mushroom/iu,
  орех: /орех|арахис|миндал|фундук|nut|peanut/iu,
  молок: /молок|сливк|сливочн|сыр|творог|сметан|йогурт|кефир|milk|cream|cheese|dairy/iu,
  куриц: /куриц|курин|chicken/iu,
  свинин: /свин|pork/iu,
  говяд: /говяд|говяж|телят|beef/iu,
  рыба: /рыб|лосос|треск|форел|тунц|минта|хек|скумбр|сельд|fish|salmon/iu,
  яйц: /яйц|яиц|egg/iu,
  глютен: /глютен|пшениц|паст|макарон|спагетт|лапш|мук|хлеб|сухар|wheat|gluten|pasta|flour/iu,
  соя: /соев|соя|soy/iu,
  морепродукт: /морепродукт|кревет|миди|кальмар|устриц|shrimp|seafood/iu
};

const pantryAliases = [
  ['tomato_paste', /томатн\p{L}* паст/iu], ['butter', /сливочн\p{L}* масл/iu],
  ['mince', /фарш/iu], ['pork', /свинин|свин/iu], ['beef', /говяд|говяж|телят/iu],
  ['chicken', /куриц|курин/iu], ['tomato', /помидор|томат/iu], ['rice', /рис/iu],
  ['onion', /лук|луков/iu], ['carrot', /морков/iu], ['potato', /картоф|картош/iu],
  ['egg', /яйц|яиц/iu], ['cheese', /сыр/iu], ['oil', /масл/iu], ['cabbage', /капуст/iu],
  ['pasta', /паст|макарон|спагетт/iu], ['buckwheat', /греч/iu], ['mushroom', /гриб|шампиньон|вешенк/iu],
  ['fish', /рыб|лосос|треск|форел|минта|хек|скумбр|сельд/iu], ['tuna', /тунц/iu], ['bean', /фасол/iu],
  ['cucumber', /огур/iu], ['pepper', /перец|паприк/iu], ['zucchini', /кабач/iu],
  ['lentil', /чечевиц|чечевич/iu], ['chickpea', /нут|турецк\p{L}* горох/iu], ['peas', /горох|горош/iu],
  ['barley', /перлов|ячмен/iu], ['couscous', /кускус/iu], ['turkey', /индейк/iu]
];
export const pantryKey = (value) => {
  const normalized = ingredient(value);
  return pantryAliases.find(([, pattern]) => pattern.test(normalized))?.[0] || normalized.split(' ').filter((word) => word.length >= 4).map((word) => word.slice(0, 5)).join(' ');
};

const minceTypes = (name) => ['beef', 'pork', 'chicken', 'turkey'].filter((key) => pantryAliases.find(([alias]) => alias === key)[1].test(name));
const pantryMatches = (required, available) => {
  const key = pantryKey(required);
  return available.some((name) => {
    if (!key || pantryKey(name) !== key) return false;
    if (key !== 'mince') return true;
    const needed = minceTypes(required), present = minceTypes(name);
    // Generic mince can be clarified later; explicitly different meats are not interchangeable.
    return !needed.length || !present.length || (needed.length === present.length && needed.every((type) => present.includes(type)));
  });
};

export function recipeMainIngredients(recipe) {
  if (recipe.mainIngredients?.length) return recipe.mainIngredients;
  const names = (recipe.ingredients || []).map((item) => item.name || item.raw || item);
  // Infer the dish's base from its composition, including generic titles such as cutlets.
  const groups = [['chicken', 'pork', 'beef', 'mince', 'turkey', 'fish', 'tuna'], ['lentil', 'bean', 'chickpea', 'peas'], ['egg'], ['pasta', 'buckwheat', 'rice', 'barley', 'couscous', 'potato'], ['zucchini', 'cabbage', 'mushroom']];
  for (const keys of groups) { const base = names.filter((name) => keys.includes(pantryKey(name))); if (base.length) return base; }
  return [];
}

export function pantryCoverage(recipe, available = []) {
  if (!available.length) return null;
  const required = (recipe.ingredients || []).map((item) => item.name || item.raw || item)
    .filter((name) => !/^(?:вода|соль|перец\s+черный|специи)$/iu.test(ingredient(name)));
  const missing = required.filter((name) => !pantryMatches(name, available));
  const mainIngredients = recipeMainIngredients(recipe);
  const missingMainIngredients = mainIngredients.filter((name) => !pantryMatches(name, available));
  const matchedMainIngredients = mainIngredients.filter((name) => pantryMatches(name, available));
  return { matched: required.length - missing.length, missing, mainIngredients, missingMainIngredients, matchedMainIngredients, coverage: required.length ? (required.length - missing.length) / required.length : 0 };
}

export function recipeCategories(recipe) {
  const text = [recipe.title, ...(recipe.tags || []), ...(recipe.ingredients || []).map((item) => item.name || item.raw || item)].join(' ');
  const categoryText = (key) => key === 'pasta' ? text.replace(/томатн\p{L}*\s+паст\p{L}*/giu, '')
    : key === 'meat' ? text.replace(/без\s+мяс\p{L}*/giu, '') : text;
  return DINNER_CATEGORIES.filter(([key, , pattern]) => pattern.test(categoryText(key))).map(([key]) => key);
}

export function isDinnerCandidate(recipe) {
  const text = [recipe.title, ...(recipe.tags || [])].join(' ').toLocaleLowerCase('ru');
  if (/десерт|торт|чизкейк|печень[ея]|сырник|блин|завтрак|кекс|морожен|пирожн/iu.test(text)) return false;
  return Boolean(recipe.ingredients?.length && recipe.steps?.length);
}

export function hasExcludedIngredient(recipe, excluded = []) {
  const names = (recipe.ingredients || []).map((item) => ingredient(item.name || item.raw || item));
  // Missing ingredient data cannot establish that a hard food constraint is met.
  if (excluded.length && !names.length) return true;
  return excluded.some((raw) => {
    const forbidden = ingredient(raw);
    if (!forbidden) return false;
    const alias = Object.entries(aliases).find(([key, pattern]) => pattern.test(forbidden) || forbidden.includes(key))?.[1];
    return names.some((name) => name.includes(forbidden) || (forbidden.length >= 4 && name.split(' ').some((word) => word.startsWith(forbidden.slice(0, Math.min(5, forbidden.length - 1))))) || (alias && alias.test(name)));
  });
}

export const totalMinutes = (recipe) => {
  const values = [recipe.prepMinutes, recipe.cookMinutes].filter((value) => Number.isFinite(value));
  return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
};

export function scoreCandidate(recipe, { profile = {}, categorySignals = {}, history = [], rejected = [], pantry = [], now = Date.now() } = {}) {
  if (rejected.includes(recipe.id) || hasExcludedIngredient(recipe, profile.excludedIngredients || [])) return null;
  const minutes = totalMinutes(recipe);
  if (profile.preferredMaxCookingTime && minutes !== null && minutes > profile.preferredMaxCookingTime) return null;
  const categories = recipeCategories(recipe);
  let score = recipe.userSaved ? DINNER_WEIGHTS.saved : 0;
  const pantryMatch = pantryCoverage(recipe, pantry);
  if (pantryMatch) {
    const hasBase = pantryMatch.mainIngredients.length && !pantryMatch.missingMainIngredients.length;
    if (!pantryMatch.matched || pantryMatch.missing.length > DINNER_LIMITS.maxShoppingIngredients || (!hasBase && (pantryMatch.mainIngredients.length || pantryMatch.missing.length))) return null;
    score += pantryMatch.coverage * DINNER_WEIGHTS.pantryFit - pantryMatch.missing.length * DINNER_WEIGHTS.pantryMissingPenalty;
    if (hasBase) score += DINNER_WEIGHTS.mainIngredientFit;
  }
  // Explicit tastes keep their effect even when accumulated history reaches its cap.
  score += categories.reduce((sum, key) => sum + (Math.min(2, categorySignals[key] || 0) + (profile.preferredCategories?.[key] || 0)) * DINNER_WEIGHTS.category, 0);
  if (minutes !== null && (!profile.preferredMaxCookingTime || minutes <= profile.preferredMaxCookingTime)) score += DINNER_WEIGHTS.timeFit;
  const desiredServings = profile.householdSize || (profile.householdType === 'family' ? 3 : profile.householdType === 'couple' ? 2 : 1);
  if (recipe.servings) score += recipe.servings >= desiredServings ? DINNER_WEIGHTS.servingsFit : -DINNER_WEIGHTS.servingsFit;
  if (profile.hasChildren && /остр\w*\s+перец|чили|халапеньо/iu.test([recipe.title, ...(recipe.tags || []), ...(recipe.ingredients || []).map((item) => item.name || item.raw || item)].join(' '))) score -= DINNER_WEIGHTS.childrenSpicyPenalty;
  const events = history.filter((event) => event.recipeKey === recipe.id);
  score += events.filter((event) => event.event === 'recommendation_accepted').length * DINNER_WEIGHTS.accepted;
  score += events.filter((event) => event.event === 'recipe_cooked').length * DINNER_WEIGHTS.cooked;
  if (events.filter((event) => event.event === 'recipe_cooked').length >= 2) score += DINNER_WEIGHTS.repeatSignal;
  const recentCook = events.some((event) => event.event === 'recipe_cooked' && now - Date.parse(event.createdAt) < 7 * 86400000);
  const recentShown = events.some((event) => event.event === 'recommendation_shown' && now - Date.parse(event.createdAt) < 86400000);
  if (recentCook) score -= DINNER_WEIGHTS.recentCookPenalty;
  if (recentShown) score -= DINNER_WEIGHTS.recentShownPenalty;
  return { recipe, score, categories, minutes, pantryMatch };
}

export function rankCandidates(recipes, context = {}) {
  return recipes.map((recipe) => scoreCandidate(recipe, context)).filter(Boolean)
    .sort((a, b) => b.score - a.score || a.recipe.id.localeCompare(b.recipe.id));
}

const uncooked = (candidate, history) => !history.some((event) => event.recipeKey === candidate.recipe.id && event.event === 'recipe_cooked');
const sideKeys = (candidate) => (candidate.recipe.ingredients || []).map((item) => pantryKey(item.name || item.raw || item)).filter((key) => ['rice', 'pasta', 'buckwheat', 'potato', 'couscous', 'cabbage'].includes(key));
const categoryDistance = (candidate, selected) => candidate.categories.filter((key) => !selected.some((item) => item.categories.includes(key))).length
  + sideKeys(candidate).filter((key) => !selected.some((item) => sideKeys(item).includes(key))).length * DINNER_WEIGHTS.newSideVariety;
const preferenceFit = (candidate, preferredCategories = {}) => candidate.categories.reduce((sum, key) => sum + (preferredCategories[key] || 0), 0);
const preferenceChoice = (candidates, preferredCategories = {}) => candidates
  .filter((candidate) => preferenceFit(candidate, preferredCategories) > 0)
  .sort((a, b) => preferenceFit(b, preferredCategories) - preferenceFit(a, preferredCategories) || b.score - a.score)[0];

// An editorial discovery is a real recipe with a plain-language explanation.
// Reserve it for slot three; every candidate has already passed hard filters.
const discoveryChoice = (candidates, history, selected = []) => candidates.filter((item) => item.recipe.discovery)
  .sort((a, b) => Number(uncooked(b, history)) - Number(uncooked(a, history))
    || categoryDistance(b, selected) - categoryDistance(a, selected) || b.score - a.score)[0];

export function shortlistDinnerCandidates(ranked, history = [], limit = 8, preferredCategories = {}) {
  if (!ranked.length) return [];
  const fastest = ranked.filter((item) => item.minutes !== null)
    .sort((a, b) => a.minutes - b.minutes || b.score - a.score)[0];
  const variety = ranked.filter((item) => !item.recipe.userSaved && uncooked(item, history))
    .sort((a, b) => categoryDistance(b, [ranked[0], fastest].filter(Boolean)) - categoryDistance(a, [ranked[0], fastest].filter(Boolean)) || b.score - a.score)[0];
  const seen = new Set();
  const discovery = discoveryChoice(ranked, history, [ranked[0], fastest].filter(Boolean));
  const preferred = preferenceChoice(ranked.filter((item) => item !== discovery), preferredCategories);
  return [preferred, ranked[0], fastest, discovery, variety, ...ranked].filter((item) => item && !seen.has(item.recipe.id) && seen.add(item.recipe.id)).slice(0, limit);
}

export function selectDinnerChoices(candidates, history = [], { preferTop = false, preferredCategories = {} } = {}) {
  if (!candidates.length) return [];
  const chosen = [];
  const add = (candidate, role) => { if (candidate && !chosen.some((item) => item.candidate.recipe.id === candidate.recipe.id)) chosen.push({ candidate, role }); };
  const discovery = candidates.length >= 3 ? discoveryChoice(candidates, history) : null;
  const everyday = candidates.filter((item) => item !== discovery);
  const preferred = preferenceChoice(everyday, preferredCategories);
  add(preferred || (preferTop ? everyday.find((item) => item.pantryMatch?.missing.length === 0) || everyday[0] : everyday.find((item) => item.recipe.userSaved) || everyday[0]), 'familiar');
  const remaining = () => candidates.filter((item) => !chosen.some((choice) => choice.candidate.recipe.id === item.recipe.id));
  const quick = remaining().filter((item) => item !== discovery);
  add(quick.filter((item) => item.minutes !== null).sort((a, b) => a.minutes - b.minutes || b.score - a.score)[0] || quick[0], 'quick');
  const variety = remaining().filter((item) => !item.recipe.userSaved && uncooked(item, history))
    .sort((a, b) => categoryDistance(b, chosen.map((item) => item.candidate)) - categoryDistance(a, chosen.map((item) => item.candidate)) || b.score - a.score)[0];
  add(discovery || variety || remaining()[0], 'variety');
  for (const candidate of remaining()) { if (chosen.length >= 3) break; add(candidate, 'other'); }
  return chosen;
}

export { SEED_RECIPES } from './dinner-seeds.js';
