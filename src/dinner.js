import { matchesMealRequest, matchesObjectiveMealRequest, containsFoodPhrase, matchesIngredientConstraint, isSpicy } from './meal-request.js';

export const DINNER_WEIGHTS = Object.freeze({
  saved: 4, category: 2, timeFit: 1, servingsFit: 1, accepted: 0.7, cooked: 1.5,
  recentCookPenalty: 5, recentShownPenalty: 0.5, saveSignal: 0.15,
  acceptSignal: 0.35, cookSignal: 0.7, repeatSignal: 1,
  pantryFit: 6, pantryMissingPenalty: 1.5, childrenSpicyPenalty: 2, mainIngredientFit: 3, newSideVariety: 2
});

export const DINNER_LIMITS = Object.freeze({ maxShoppingIngredients: 5 });

export const DINNER_CATEGORIES = Object.freeze([
  ['burger', 'Бургеры', /бургер|гамбургер|чизбургер/iu],
  ['pizza', 'Пицца', /пицц/iu],
  ['sushi', 'Суши', /суши|ролл/iu],
  ['shawarma', 'Шаурма', /шаурм|шаверм|донер/iu],
  ['wok', 'Вок', /вок/iu],
  ['pasta', 'Паста', /паст|макарон|спагетт|лапш/iu],
  ['barbecue', 'Шашлык', /шашлык|люля|кебаб/iu],
  ['dessert', 'Десерты', /десерт|торт|пирожн|чизкейк|морожен|печень|кекс/iu],
  ['fastfood', 'Фастфуд', /фастфуд|бургер|гамбургер|чизбургер|пицц|шаурм|шаверм|донер|хот[ -]?дог|картоф[а-яё]* фри/iu],
  ['breakfast', 'Завтраки', /завтрак|омлет|каша|сырник|блин|яичниц/iu],
  ['lunch', 'Обеды', /обед/iu],
  ['coffee', 'Кофе', /кофе|капучин|латте|эспресс/iu],
  ['georgian', 'Грузия', /грузин|хачап|хинкал|лобио|чахох|сацив|оджах|чкмер/iu],
  ['russian', 'Русская', /русск|борщ|щи(?:\s|$)|рассольник|драник|окрошк|солянк|пельмен/iu],
  ['eastern', 'Восток', /восточ|шакшук|хумус|фалаф|кускус/iu],
  ['chinese', 'Китай', /китай|гунбао|димсам|по-пекин/iu],
  ['japanese', 'Япония', /япон|суши|ролл|рамен|соборо|донбур|терияки/iu],
  ['caucasian', 'Кавказ', /кавказ|грузин|хачап|хинкал|лобио|чахох|сацив|шашлык|люля/iu],
  ['uzbek', 'Узбекская', /узбек|плов|лагман|мант/iu],
  ['italian', 'Италия', /итал|пицц|лазан|ризотт|равиол|фокач|ньокк|карбонар|болоньез/iu],
  ['european', 'Европа', /европ|итал|пицц|лазан|ризотт|равиол|фокач|ньокк|карбонар|болоньез|греческ|кефтедес|гуляш/iu],
  ['rice', 'Рис', /рис/iu],
  ['asian', 'Азия', /азиат|терияки|вок|карри|соев|фунчоз|япон|китай|коре|тайск|суши|ролл|рамен|соборо|узбек|плов|лагман/iu],
  ['chicken', 'Курица', /куриц|курин|бедр|филе птиц/iu],
  // Keep the UI facet separate from poultry: users can prefer chicken and the
  // broader meat section independently. Hard food constraints use the wider
  // ingredient family from meal-request.js.
  ['meat', 'Мясо', /говяд|говяж|телят|свин|баранин|ягнят|мяс|фарш|индейк|крол|оленин|конин/iu],
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

const MAIN_INGREDIENT_GROUPS = [['chicken', 'pork', 'beef', 'mince', 'turkey', 'fish', 'tuna'], ['lentil', 'bean', 'chickpea', 'peas'], ['egg'], ['pasta', 'buckwheat', 'rice', 'barley', 'couscous', 'potato'], ['zucchini', 'cabbage', 'mushroom']];
const PANTRY_FREE_INGREDIENTS = ['вода', 'соль', 'перец черный', 'черный перец', 'специи'];
export function dinnerPantryConstraints(pantry = []) {
  return { required: pantry.length > 0, available: pantry, availableKeys: [...new Set(pantry.map(pantryKey))],
    mainIngredientGroups: MAIN_INGREDIENT_GROUPS, allMainIngredientsMustBeAvailable: true,
    maxShoppingIngredients: DINNER_LIMITS.maxShoppingIngredients, freeIngredientNames: PANTRY_FREE_INGREDIENTS };
}
export function recipeMainIngredients(recipe) {
  if (recipe.mainIngredients?.length) return recipe.mainIngredients;
  const names = (recipe.ingredients || []).map((item) => item.name || item.raw || item);
  // Infer the dish's base from its composition, including generic titles such as cutlets.
  for (const keys of MAIN_INGREDIENT_GROUPS) { const base = names.filter((name) => keys.includes(pantryKey(name))); if (base.length) return base; }
  return [];
}

export function pantryCoverage(recipe, available = []) {
  if (!available.length) return null;
  const required = (recipe.ingredients || []).map((item) => item.name || item.raw || item)
    .filter((name) => !PANTRY_FREE_INGREDIENTS.includes(ingredient(name)));
  const missing = required.filter((name) => !pantryMatches(name, available));
  const mainIngredients = recipeMainIngredients(recipe);
  const missingMainIngredients = mainIngredients.filter((name) => !pantryMatches(name, available));
  const matchedMainIngredients = mainIngredients.filter((name) => pantryMatches(name, available));
  return { matched: required.length - missing.length, missing, mainIngredients, missingMainIngredients, matchedMainIngredients, coverage: required.length ? (required.length - missing.length) / required.length : 0 };
}

export function recipeCategories(recipe) {
  const text = [recipe.title, ...(recipe.tags || []), ...(recipe.ingredients || []).map((item) => item.name || item.raw || item)].join(' ');
  const categoryText = (key) => key === 'pasta' ? text.replace(/томатн\p{L}*\s+паст\p{L}*/giu, '')
    : key === 'rice' ? text.replace(/рисов\p{L}*\s+(?:уксус|бумаг|лапш|мук)\p{L}*/giu, '')
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
    const matches = (name) => matchesIngredientConstraint(name, forbidden)
      || name.includes(forbidden)
      || (forbidden.length >= 4 && name.split(' ').some((word) => word.startsWith(forbidden.slice(0, Math.min(5, forbidden.length - 1)))))
      || Boolean(alias && alias.test(name));
    // Ingredient entries remain authoritative even if the title claims absence.
    if (names.some(matches)) return true;
    const foodWord = (word) => forbidden.split(' ').some(part => containsFoodPhrase(word, part)) || Boolean(alias && alias.test(word));
    const references = [recipe.title, ...(recipe.ingredients || []).map(item => item.comment), ...(recipe.steps || []).map(step => step.text || step)].filter(Boolean);
    return references.some((reference) => {
      let text = String(reference).toLocaleLowerCase('ru').replaceAll('ё', 'е');
      // Remove only the food words immediately governed by an explicit absence
      // or prohibition. Later positive mentions must remain visible to the check.
      text = text.replace(/(?<![\p{L}\p{N}])(?:без|не\s+(?:добавля(?:йте|й|ть)|использу(?:йте|й)|использовать|кладите))\s+([\p{L}]+(?:\s+[\p{L}]+){0,5})/gu, (whole, phrase) => {
        const words = phrase.split(' ');
        let count = 0;
        while (count < words.length && foodWord(words[count])) count++;
        return count ? ` ${words.slice(count).join(' ')}` : whole;
      });
      text = text.replace(/([\p{L}]+(?:\s+[\p{L}]+){0,5})\s+не\s+(?:добавля(?:йте|й|ть)|использу(?:йте|й)|использовать|кладите)(?!\p{L})/gu, (whole, phrase) => {
        const words = phrase.split(' ');
        let count = words.length;
        while (count > 0 && foodWord(words[count - 1])) count--;
        return count < words.length ? ` ${words.slice(0, count).join(' ')}` : whole;
      });
      return matches(ingredient(text));
    });
  });
}

export const totalMinutes = (recipe) => {
  const values = [recipe.prepMinutes, recipe.cookMinutes].filter((value) => Number.isFinite(value));
  return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
};
export const hasCompleteCookingTime = (recipe) => [recipe.prepMinutes, recipe.cookMinutes].every(Number.isFinite);

export function scoreCandidate(recipe, { profile = {}, categorySignals = {}, history = [], rejected = [], pantry = [], requestedCategories = [], mealRequest = null, feedback = {}, now = Date.now() } = {}) {
  if (rejected.includes(recipe.id) || hasExcludedIngredient(recipe, [...(profile.excludedIngredients || []), ...(mealRequest?.excludedIngredients || []), ...(feedback.unavailableIngredients || [])])) return null;
  if (!matchesObjectiveMealRequest(recipe, mealRequest)) return null;
  // Relax timing metadata only for usable recipes, not incomplete imports
  // containing a generic ingredient list and a single placeholder instruction.
  if (recipe.userSaved && !hasCompleteCookingTime(recipe) && ((recipe.ingredients?.length || 0) < 2 || (recipe.steps?.length || 0) < 2)) return null;
  // Imported favourites often omit portions and preparation time. Missing
  // metadata is not evidence that a saved recipe cannot suit this household.
  // Today's explicit limits are still checked by matchesObjectiveMealRequest.
  if (profile.householdSize && (Number.isInteger(recipe.servings) ? recipe.servings < profile.householdSize : !recipe.userSaved)) return null;
  if (profile.hasChildren && isSpicy(recipe)) return null;
  if ((feedback.avoidTitles || []).some((title) => containsFoodPhrase(recipe.title, title))) return null;
  if (feedback.simpleOnly && ((recipe.ingredients?.length || 0) > 8 || (recipe.steps?.length || 0) > 6 || /лепите|слепите|фарширу|фритюр/iu.test((recipe.steps || []).map((s) => s.text || s).join(' ')))) return null;
  const knownMinutes = totalMinutes(recipe);
  const minutes = hasCompleteCookingTime(recipe) ? knownMinutes : null;
  if (profile.preferredMaxCookingTime && ((knownMinutes !== null && knownMinutes > profile.preferredMaxCookingTime) || (minutes === null && !recipe.userSaved))) return null;
  const categories = recipeCategories(recipe);
  const ingredientNames = (recipe.ingredients || []).map((item) => item.name || item.raw || item);
  const matchesRequestedCategory = (key) => categories.includes(key)
    || (key === 'meat' && ingredientNames.some((name) => matchesIngredientConstraint(name, 'мясо')));
  // Lexical/category matches help retrieval only. They never reject a recipe:
  // the semantic validator is the single authority for meaning.
  const requestHint = requestedCategories.filter(matchesRequestedCategory).length * 6
    + (mealRequest && matchesMealRequest(recipe, mealRequest) ? 8 : 0);
  let score = (recipe.userSaved ? DINNER_WEIGHTS.saved : 0) + requestHint;
  const namedTaste = Object.entries(profile.dishPreferences || {}).reduce((sum, [dish, weight]) => sum + (matchesMealRequest(recipe, { dish }) ? weight : 0), 0);
  score += namedTaste * 8;
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
  return { recipe, score, categories, minutes, pantryMatch, namedTaste };
}

export function rankCandidates(recipes, context = {}) {
  return recipes.map((recipe) => scoreCandidate(recipe, context)).filter(Boolean)
    .sort((a, b) => b.score - a.score || a.recipe.id.localeCompare(b.recipe.id));
}

const uncooked = (candidate, history) => !history.some((event) => event.recipeKey === candidate.recipe.id && event.event === 'recipe_cooked');
const sideKeys = (candidate) => (candidate.recipe.ingredients || []).map((item) => pantryKey(item.name || item.raw || item)).filter((key) => ['rice', 'pasta', 'buckwheat', 'potato', 'couscous', 'cabbage'].includes(key));
const categoryDistance = (candidate, selected) => candidate.categories.filter((key) => !selected.some((item) => item.categories.includes(key))).length
  + sideKeys(candidate).filter((key) => !selected.some((item) => sideKeys(item).includes(key))).length * DINNER_WEIGHTS.newSideVariety;
const preferenceFit = (candidate, preferredCategories = {}) => (candidate.namedTaste || 0) * 2 + candidate.categories.reduce((sum, key) => sum + (preferredCategories[key] || 0), 0);
const preferenceChoice = (candidates, preferredCategories = {}) => candidates
  .filter((candidate) => preferenceFit(candidate, preferredCategories) > 0)
  .sort((a, b) => preferenceFit(b, preferredCategories) - preferenceFit(a, preferredCategories) || b.score - a.score)[0];
const positivePreferenceKeys = (preferredCategories = {}) => Object.entries(preferredCategories)
  .filter(([, value]) => value > 0).map(([key]) => key);
const uncoveredPreferenceFit = (candidate, preferredCategories = {}, selected = []) => {
  const covered = new Set(selected.flatMap((item) => item.categories));
  return positivePreferenceKeys(preferredCategories)
    .filter((key) => !covered.has(key) && candidate.categories.includes(key))
    .reduce((sum, key) => sum + preferredCategories[key], 0);
};
const preferenceRepresentatives = (candidates, preferredCategories = {}) => positivePreferenceKeys(preferredCategories)
  .map((key) => candidates.filter((candidate) => candidate.categories.includes(key))
    .sort((a, b) => preferenceFit(b, preferredCategories) - preferenceFit(a, preferredCategories) || b.score - a.score)[0])
  .filter(Boolean);

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
  const representatives = preferenceRepresentatives(ranked.filter((item) => item !== discovery), preferredCategories);
  return [preferred, ...representatives, ranked[0], fastest, discovery, variety, ...ranked].filter((item) => item && !seen.has(item.recipe.id) && seen.add(item.recipe.id)).slice(0, limit);
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
  const remainingQuick = remaining().filter((item) => item !== discovery);
  const timedQuick = remainingQuick.filter((item) => item.minutes !== null);
  const quick = timedQuick.length ? timedQuick : remainingQuick;
  add(quick.sort((a, b) => uncoveredPreferenceFit(b, preferredCategories, chosen.map((item) => item.candidate)) - uncoveredPreferenceFit(a, preferredCategories, chosen.map((item) => item.candidate))
    || (a.minutes ?? Infinity) - (b.minutes ?? Infinity) || b.score - a.score)[0], 'quick');
  const variety = remaining().filter((item) => !item.recipe.userSaved && uncooked(item, history))
    .sort((a, b) => uncoveredPreferenceFit(b, preferredCategories, chosen.map((item) => item.candidate)) - uncoveredPreferenceFit(a, preferredCategories, chosen.map((item) => item.candidate))
      || categoryDistance(b, chosen.map((item) => item.candidate)) - categoryDistance(a, chosen.map((item) => item.candidate)) || b.score - a.score)[0];
  const uncovered = remaining().sort((a, b) => uncoveredPreferenceFit(b, preferredCategories, chosen.map((item) => item.candidate)) - uncoveredPreferenceFit(a, preferredCategories, chosen.map((item) => item.candidate)) || b.score - a.score)[0];
  add(uncoveredPreferenceFit(uncovered || { categories: [] }, preferredCategories, chosen.map((item) => item.candidate)) > 0 ? uncovered : discovery || variety || remaining()[0], 'variety');
  for (const candidate of remaining()) { if (chosen.length >= 3) break; add(candidate, 'other'); }
  return chosen;
}

export { SEED_RECIPES } from './dinner-seeds.js';
