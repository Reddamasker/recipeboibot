const itemText = (value) => String(value || '').normalize('NFKC').trim().toLocaleLowerCase('ru').replaceAll('ё', 'е')
  .replace(/^\d+(?:[.,]\d+)?\s*(?:кг|г|гр|мл|л|шт\.?|штуки?)\s*/iu, '')
  .replace(/^[\s,.;:–-]+|[\s,.;:–-]+$/gu, '').replace(/\s+/g, ' ');

const uniqueItems = (items) => [...new Set((Array.isArray(items) ? items : []).map(itemText).filter((item) => item.length >= 2 && item.length <= 70))].slice(0, 30);

const TASTE_CATEGORIES = Object.freeze([
  ['pasta', /паст|макарон|спагетт|лапш|итал/iu],
  ['asian', /азиат|китай|япон|коре|тайск|вок|карри|суш|ролл/iu],
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
    preferredCategories: { ...before.preferredCategories, ...next.preferredCategories }
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
  return { availableIngredients, excludedIngredients, householdSize, householdType, hasChildren, maxMinutes, preferredCategories: normalizedPreferences(raw) };
}

const sizeWords = { одного: 1, двоих: 2, троих: 3, трое: 3, трех: 3, четырех: 4, четверых: 4, пятерых: 5, шестерых: 6 };

export function parseDinnerIntakeFallback(text) {
  const source = String(text || '').normalize('NFKC').toLocaleLowerCase('ru').replaceAll('ё', 'е').slice(0, 3000);
  const parts = source.split(/[,.!?;\n]+/u).map((part) => part.trim()).filter(Boolean);
  const availableIngredients = [], excludedIngredients = [], removedIngredients = [], preferredCategories = {};
  let householdSize = null, hasChildren = null, maxMinutes = null, family = false, excluding = false;
  for (const part of parts) {
    if (/^(?:кстати|нет|да|забыл(?:а)?(?:\s+сказать)?|добавлю|уточнение)$/u.test(part)) continue;
    const removal = part.match(/^(?:убери|убрать|закончились|закончилась|закончился|нет больше|больше нет)\s+(.+)$/u) || part.match(/^(.+?)\s+(?:закончились|закончилась|закончился|больше нет)$/u);
    if (removal) { removedIngredients.push(...removal[1].split(/\s+и\s+/u)); continue; }
    if (/^(?:аллерги[ияй]\s+нет|нет\s+аллерги[ий]|без\s+аллерги[ий])$/u.test(part)) { excluding = false; continue; }
    const taste = /(?:не\s+люб(?:лю|им|ит|ят)|не\s+нрав|ненавиж|не\s+хочу|не\s+предпочита)/u.test(part) ? -1
      : /(?:люб(?:лю|им|ит|ят)|нрав|обож|предпочита|хочу\s+есть)/u.test(part) ? 1 : 0;
    if (taste) {
      for (const [key, pattern] of TASTE_CATEGORIES) if (pattern.test(part)) preferredCategories[key] = taste;
      if (Object.keys(preferredCategories).length) { excluding = false; continue; }
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
    const cleaned = part.replace(/^(?:(?:а\s+)?еще\s+|добавь\s+|добавить\s+)?(?:у\s+меня\s+есть\s+|есть\s+|в\s+холодильнике\s+|дома\s+|из\s+продуктов\s+|остались?\s+|имеются?\s+|теперь\s+только\s+|только\s+)?/u, '');
    availableIngredients.push(...cleaned.split(/\s+и\s+/u));
  }
  const parsed = normalizeDinnerIntake({ availableIngredients, excludedIngredients, householdSize, hasChildren, maxMinutes, preferredCategories });
  if (family && !parsed.householdType) parsed.householdType = 'family';
  if (removedIngredients.length) parsed.removedIngredients = uniqueItems(removedIngredients);
  if (/теперь\s+(?:есть\s+)?только|замени\s+(?:весь\s+)?список/u.test(source)) parsed.replaceIngredients = true;
  return parsed;
}
