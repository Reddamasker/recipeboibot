import { normalizeMealRequest, normalizeMealText, parseMealRequest, mergeMealRequests } from './meal-request.js';

const itemText = (value) => String(value || '').normalize('NFKC').trim().toLocaleLowerCase('ru').replaceAll('ё', 'е')
  .replace(/^\d+(?:[.,]\d+)?\s*(?:кг|г|гр|мл|л|шт\.?|штуки?)\s*/iu, '')
  .replace(/^[\s,.;:–-]+|[\s,.;:–-]+$/gu, '').replace(/\s+/g, ' ');

const uniqueItems = (items) => [...new Set((Array.isArray(items) ? items : []).map(itemText).filter((item) => item.length >= 2 && item.length <= 70))].slice(0, 30);

const TASTE_CATEGORIES = Object.freeze([
  ['burger', /бургер|гамбургер|чизбургер/iu],
  ['pizza', /пицц/iu],
  ['sushi', /суши|ролл/iu],
  ['shawarma', /шаурм|шаверм|донер/iu],
  ['wok', /вок/iu],
  ['pasta', /паст|макарон|спагетт|лапш/iu],
  ['barbecue', /шашлык|люля|кебаб/iu],
  ['dessert', /десерт|торт|пирожн|чизкейк|морожен|печень|кекс/iu],
  ['fastfood', /фастфуд|быстр[а-яё]* ед/iu],
  ['breakfast', /завтрак/iu],
  ['lunch', /обед/iu],
  ['coffee', /кофе|капучин|латте|эспресс/iu],
  ['georgian', /грузи|грузин|хачап|хинкал|лобио|чахох/iu],
  ['russian', /русск[а-яё]* кухн|русск[а-яё]* блюд/iu],
  ['eastern', /восточн[а-яё]* кухн|восточн[а-яё]* блюд/iu],
  ['chinese', /китай/iu],
  ['japanese', /япон/iu],
  ['caucasian', /кавказ/iu],
  ['uzbek', /узбек/iu],
  ['italian', /итал/iu],
  ['european', /европ/iu],
  ['rice', /рис/iu],
  ['asian', /азиат|китай|япон|коре|тайск|вок|карри|суши|ролл/iu],
  ['chicken', /куриц|курин|бедр|филе птиц/iu],
  ['meat', /мяс|говяд|свинин|фарш|индейк/iu],
  ['fish', /рыб|лосос|треск|тунц|форел|минта|хек|скумбр|сельд/iu],
  ['soup', /суп|борщ|похлеб|щи\b/iu],
  ['salad', /салат/iu],
  ['home', /домашн|запеканк|котлет|картоф|гречк/iu]
]);
const TASTE_KEYS = new Set(TASTE_CATEGORIES.map(([key]) => key));

function normalizedPreferences(raw = {}) {
  const result = {};
  if (raw.preferredCategories && typeof raw.preferredCategories === 'object' && !Array.isArray(raw.preferredCategories)) {
    for (const [key, value] of Object.entries(raw.preferredCategories)) if (TASTE_KEYS.has(key) && Number.isFinite(value) && value >= -1 && value <= 1 && value !== 0) result[key] = value;
  }
  for (const key of Array.isArray(raw.likedCategories) ? raw.likedCategories : []) if (TASTE_KEYS.has(key)) result[key] = 1;
  for (const key of Array.isArray(raw.dislikedCategories) ? raw.dislikedCategories : []) if (TASTE_KEYS.has(key)) result[key] = -1;
  return result;
}

// An utterance is a patch: silence means keep the previous answer, not clear it.
export function mergeDinnerIntake(previous = {}, patch = {}) {
  const before = normalizeDinnerIntake(previous), next = normalizeDinnerIntake(patch);
  const removed = uniqueItems(patch.removedIngredients);
  const matches = (a, b) => a === b || a.startsWith(b + ' ') || b.startsWith(a + ' ') || (a.length >= 4 && b.length >= 4 && a.slice(0, 4) === b.slice(0, 4));
  const availableIngredients = [...(patch.replaceIngredients === true ? [] : before.availableIngredients), ...next.availableIngredients]
    .filter((item) => !removed.some((name) => matches(item, name)));
  return normalizeDinnerIntake({
    availableIngredients, excludedIngredients: [...before.excludedIngredients, ...next.excludedIngredients],
    householdSize: next.householdSize ?? before.householdSize,
    hasChildren: next.hasChildren ?? before.hasChildren,
    maxMinutes: next.maxMinutes ?? before.maxMinutes,
    householdType: next.householdType ?? before.householdType,
    preferredCategories: { ...before.preferredCategories, ...next.preferredCategories },
    requestedCategories: [...(patch.replaceRequestedCategories === true ? [] : before.requestedCategories), ...next.requestedCategories],
    mealRequest: mergeMealRequests(before.mealRequest, next.mealRequest, patch.replaceRequestedCategories === true),
    dishPreferences: { ...before.dishPreferences, ...next.dishPreferences }
  });
}

export function normalizeDinnerIntake(raw = {}) {
  const excludedIngredients = uniqueItems(raw.excludedIngredients);
  const excluded = new Set(excludedIngredients);
  const availableIngredients = uniqueItems(raw.availableIngredients).filter((item) => !excluded.has(item));
  const size = Number(raw.householdSize);
  const householdSize = Number.isInteger(size) && size >= 1 && size <= 10 ? size : null;
  const minutes = Number(raw.maxMinutes);
  const maxMinutes = Number.isInteger(minutes) && minutes >= 10 && minutes <= 120 ? minutes : null;
  const hasChildren = typeof raw.hasChildren === 'boolean' ? raw.hasChildren : null;
  const householdType = hasChildren ? 'family' : householdSize === 1 ? 'self' : householdSize === 2 ? 'couple' : householdSize >= 3 ? 'family' : ['self', 'couple', 'family'].includes(raw.householdType) ? raw.householdType : null;
  const requestedCategories = [...new Set((Array.isArray(raw.requestedCategories) ? raw.requestedCategories : []).filter((key) => TASTE_KEYS.has(key)))];
  const mealRequest = normalizeMealRequest(raw.mealRequest);
  const dishPreferences = Object.fromEntries(Object.entries(raw.dishPreferences || {}).filter(([key, value]) => key.length >= 2 && key.length <= 100 && [-1, 1].includes(value)).slice(0, 30));
  for (const dish of uniqueItems(raw.likedDishes)) dishPreferences[dish] = 1;
  for (const dish of uniqueItems(raw.dislikedDishes)) dishPreferences[dish] = -1;
  return { availableIngredients, excludedIngredients, householdSize, householdType, hasChildren, maxMinutes, preferredCategories: normalizedPreferences(raw), requestedCategories,
    ...(mealRequest ? { mealRequest } : {}), ...(Object.keys(dishPreferences).length ? { dishPreferences } : {}) };
}

export function combineDinnerIntakeExtraction(primary, fallback = {}) {
  if (!primary) return fallback;
  const extracted = normalizeDinnerIntake(primary), local = normalizeDinnerIntake(fallback);
  const classifiedKind = primary.mealRequest?.kind;
  const classifiedConfidence = primary.mealRequest?.confidence;
  let mealRequest = local.mealRequest || extracted.mealRequest;
  if (local.mealRequest && extracted.mealRequest && ['exact', 'open'].includes(classifiedKind)) {
    const unique = (values) => [...new Set(values.filter(Boolean))];
    mealRequest = normalizeMealRequest({
      text: local.mealRequest.text || extracted.mealRequest.text,
      kind: classifiedKind,
      confidence: classifiedConfidence,
      dish: classifiedKind === 'exact' ? (extracted.mealRequest.dish || local.mealRequest.dish) : '',
      requiredIngredients: extracted.mealRequest.requiredIngredients.length ? extracted.mealRequest.requiredIngredients : local.mealRequest.requiredIngredients,
      semanticCriteria: extracted.mealRequest.semanticCriteria.length ? extracted.mealRequest.semanticCriteria : local.mealRequest.semanticCriteria,
      excludedIngredients: unique([...local.mealRequest.excludedIngredients, ...extracted.mealRequest.excludedIngredients]),
      methods: extracted.mealRequest.methods.length ? extracted.mealRequest.methods : local.mealRequest.methods,
      maxMinutes: local.mealRequest.maxMinutes ?? extracted.mealRequest.maxMinutes,
      servings: local.mealRequest.servings ?? extracted.mealRequest.servings
    });
  }
  return {
    ...primary,
    preferredCategories: { ...local.preferredCategories, ...extracted.preferredCategories },
    requestedCategories: [...new Set([...extracted.requestedCategories, ...local.requestedCategories])],
    replaceRequestedCategories: Boolean(primary.replaceRequestedCategories || fallback.replaceRequestedCategories),
    // Local text is preserved even when the model only extracted a broad category.
    mealRequest,
    dishPreferences: { ...extracted.dishPreferences, ...local.dishPreferences },
    ...(local.mealRequest ? { availableIngredients: extracted.availableIngredients.filter((item) => !local.mealRequest.text.includes(item) || local.availableIngredients.includes(item)) } : {})
  };
}

const sizeWords = { одного: 1, двоих: 2, троих: 3, трое: 3, трех: 3, четырех: 4, четверых: 4, пятерых: 5, шестерых: 6 };

export function parseDinnerIntakeFallback(text, { bareCategoriesAsLikes = false } = {}) {
  const source = normalizeMealText(text, 3000);
  const parts = source.split(/[,.!?;\n]+/u).map((part) => part.trim()).filter(Boolean);
  if (bareCategoriesAsLikes && source.length <= 160 && parts.length && !/\d|(?:^|\s)(?:аллерг|без|нельзя|не\s+ем|есть|дома|холодильник|продукт|остал|сегодня|хоч|приготов|давай|люб|нрав|ненавиж|дет|ребен|минут|час)\w*/u.test(source)) {
    const bareKeys = [...new Set(parts.flatMap((part) => TASTE_CATEGORIES.filter(([, pattern]) => pattern.test(part)).map(([key]) => key)))];
    if (bareKeys.length && parts.every((part) => TASTE_CATEGORIES.some(([, pattern]) => pattern.test(part)))) {
      return normalizeDinnerIntake({ preferredCategories: Object.fromEntries(bareKeys.map((key) => [key, 1])) });
    }
  }
  const availableIngredients = [], excludedIngredients = [], removedIngredients = [], preferredCategories = {}, requestedCategories = [], dishPreferences = {};
  let mealRequest = null;
  let householdSize = null, hasChildren = null, maxMinutes = null, family = false, excluding = false;
  for (const part of parts) {
    if (/^(?:кстати|нет|да|забыл(?:а)?(?:\s+сказать)?|добавлю|уточнение)$/u.test(part)) continue;
    const removal = part.match(/^(?:убери|убрать|закончились|закончилась|закончился|нет больше|больше нет)\s+(.+)$/u) || part.match(/^(.+?)\s+(?:закончились|закончилась|закончился|больше нет)$/u);
    if (removal) { removedIngredients.push(...removal[1].split(/\s+и\s+/u)); continue; }
    if (/^(?:аллерги[ияй]\s+нет|нет\s+аллерги[ий]|без\s+аллерги[ий])$/u.test(part)) { excluding = false; continue; }
    const taste = /(?:не\s+люб(?:лю|им|ит|ят)|не\s+нрав|ненавиж|не\s+хочу|не\s+предпочита)/u.test(part) ? -1
      : /(?:люб(?:лю|им|ит|ят)|нрав|обож|предпочита)/u.test(part) ? 1 : 0;
    if (taste) {
      for (const [key, pattern] of TASTE_CATEGORIES) if (pattern.test(part)) preferredCategories[key] = taste;
      const tasteText = part.replace(/^(?:я\s+)?(?:не\s+)?(?:люблю|любим|нравится|нравятся|обожаю|предпочитаю|ненавижу)\s+/u, '');
      for (const item of tasteText.split(/\s+и\s+/u)) {
        const dish = parseMealRequest(item)?.dish;
        // Broad categories already have their own editable preferences.
        if (dish && !/^(?:паст[ауы]|макарон[ыи]|суп[ыа]?|салат[ыа]?|рис|рыб[ауы]|куриц[ауы]|мясо|домашнее|азиатское)$/u.test(dish)) dishPreferences[dish] = taste;
      }
      excluding = false; continue;
    }
    const todayRequest = /(?:сегодня|на\s+сегодня|на\s+ужин|хоч(?:у|ем|ется)|приготов(?:ить|им)|давай(?:те)?)/u.test(part);
    if (todayRequest) {
      const people = part.match(/(?:на|для|нас)\s+(\d{1,2}|одного|двоих|троих|трое|трех|четырех|четверых|пятерых|шестерых)/u);
      if (people) householdSize = Number(people[1]) || sizeWords[people[1]] || householdSize;
      for (const [key, pattern] of TASTE_CATEGORIES) {
        const match = pattern.exec(part); pattern.lastIndex = 0;
        if (!match) continue;
        const prefix = part.slice(0, match.index);
        const negated = /(?:^|\s)(?:не|без)\s*(?:хочу\s+|хотим\s+|нужен\s+|нужна\s+|нужно\s+|надо\s+)?$/u.test(prefix);
        if (!negated) requestedCategories.push(key);
      }
      mealRequest = mergeMealRequests(mealRequest, parseMealRequest(part));
      excluding = false; continue;
    }
    const sizeMatch = part.match(/(?:на|для|нас)\s+(\d{1,2}|одного|двоих|троих|трое|трех|четырех|четверых|пятерых|шестерых)(?:\s+(?:человек|людей|персон|порции?))?/u);
    if (sizeMatch) householdSize = Number(sizeMatch[1]) || sizeWords[sizeMatch[1]] || householdSize;
    if (/семь|семьи|семью/u.test(part)) family = true;
    if (/без\s+детей|детей\s+нет|нет\s+детей/u.test(part)) hasChildren = false;
    else if (/дети|детей|ребен|ребят/u.test(part)) hasChildren = true;
    const minutes = part.match(/(?:до|за|максимум|не\s+больше)\s*(\d{2,3})\s*мин/u);
    if (minutes) maxMinutes = Number(minutes[1]);
    else if (/полчаса/u.test(part)) maxMinutes = 30;
    else if (/(?:не\s+больше|до)\s+часа/u.test(part)) maxMinutes = 60;
    if (/^без\s+детей$/u.test(part)) { excluding = false; continue; }
    const forbidden = part.match(/^(?:без|не\s+ем|нельзя|исключи|аллергия\s+на)[:\s]+(.+)$/u);
    if (forbidden) { excluding = true; excludedIngredients.push(...forbidden[1].split(/\s+и\s+|\s+а\s+также\s+/u)); continue; }
    if (sizeMatch || minutes || /семь|семьи|семью|дети|детей|ребен|ребят|полчаса|минут|часа/u.test(part)) { excluding = false; continue; }
    if (excluding && !/^(?:у\s+меня\s+есть|есть|в\s+холодильнике|дома|из\s+продуктов|остались?|имеются?)\s+/u.test(part)) { excludedIngredients.push(...part.split(/\s+и\s+/u)); continue; }
    excluding = false;
    if (bareCategoriesAsLikes && !/^(?:(?:а\s+)?еще\s+|добавь\s+)?(?:у\s+меня\s+есть|есть|дома|в\s+холодильнике|из\s+продуктов|остались?|имеются?)\s/u.test(part)) {
      const dish = parseMealRequest(part)?.dish;
      if (dish) dishPreferences[dish] = 1;
      continue;
    }
    const cleaned = part.replace(/^(?:(?:а\s+)?еще\s+|добавь\s+|добавить\s+)?(?:у\s+меня\s+есть\s+|есть\s+|в\s+холодильнике\s+|дома\s+|из\s+продуктов\s+|остались?\s+|имеются?\s+|теперь\s+только\s+|только\s+)?/u, '');
    availableIngredients.push(...cleaned.split(/\s+и\s+/u));
  }
  const parsed = normalizeDinnerIntake({ availableIngredients, excludedIngredients, householdSize, hasChildren, maxMinutes, preferredCategories, requestedCategories, mealRequest, dishPreferences });
  if (family && !parsed.householdType) parsed.householdType = 'family';
  if (removedIngredients.length) parsed.removedIngredients = uniqueItems(removedIngredients);
  if (/теперь\s+(?:есть\s+)?только|замени\s+(?:весь\s+)?список/u.test(source)) parsed.replaceIngredients = true;
  if ((requestedCategories.length || mealRequest) && !/^(?:и\s+)?(?:еще|добавь|также)/u.test(source)) parsed.replaceRequestedCategories = true;
  return parsed;
}
