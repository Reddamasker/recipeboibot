// A request survives extraction, storage, generation and cache reuse unchanged.
// Categories help ranking; they are not a substitute for the name of a dish.
const clean = (value, limit = 500) => String(value || '').normalize('NFKC').toLocaleLowerCase('ru').replaceAll('ё', 'е').trim().slice(0, limit);
const list = (value) => [...new Set((Array.isArray(value) ? value : []).filter((v) => typeof v === 'string').map((v) => clean(v, 100)).filter(Boolean))].slice(0, 12);
const words = (value) => clean(value).match(/[\p{L}\p{N}]+/gu) || [];
export const mealRequestSchema = { type: ['object', 'null'], additionalProperties: false, properties: {
  text: { type: 'string' }, dish: { type: 'string' }, requiredIngredients: { type: 'array', items: { type: 'string' } },
  excludedIngredients: { type: 'array', items: { type: 'string' } }, methods: { type: 'array', items: { type: 'string', enum: ['гриль', 'духовка', 'пар', 'сковорода'] } },
  maxMinutes: { type: ['integer', 'null'] }, servings: { type: ['integer', 'null'] }
}, required: ['text', 'dish', 'requiredIngredients', 'excludedIngredients', 'methods', 'maxMinutes', 'servings'] };
const ignored = new Set(['с', 'со', 'из', 'и', 'по', 'на', 'в', 'для']);
const forms = [
  /^(?:стейк|рибай|стриплойн|тибон|ribeye|steak)/u,
  /^(?:говяд|говяж|телят|beef)/u, /^(?:куриц|курин|chicken)/u,
  /^(?:свин|pork)/u, /^(?:помидор|томат)/u, /^(?:картоф|картош)/u,
  /^(?:макарон|спагетт|паст[ауыойе])/u, /^(?:рыб|лосос|треск|форел|минта|хек|скумбр|сельд)/u,
  /^(?:гриб|шампиньон|вешенк)/u, /^(?:яйц|яиц)/u
];
function sameWord(a, b) {
  if (a === b) return true;
  if (forms.some((pattern) => pattern.test(a) && pattern.test(b))) return true;
  const stem = (w) => w.replace(/(?:ыми|ими|ого|ему|ому|ами|ями|ией|ий|ый|ая|ое|ые|ой|ую|ом|ем|ов|ев|ей|ам|ям|ах|ях|а|я|ы|и|у|ю|е|о)$/u, '').replace(/ь$/u, '');
  return Boolean(stem(a)) && stem(a) === stem(b);
}
export function containsFoodPhrase(text, phrase) {
  const required = words(phrase).filter((w) => !ignored.has(w));
  const actual = words(text);
  return required.length > 0 && required.every((w) => actual.some((a) => sameWord(w, a) || (/^овощ/u.test(w) && /^(?:морков|капуст|помидор|томат|кабач|баклаж|огур|броккол|перец)/u.test(a))));
}

export function normalizeMealRequest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const result = { text: clean(raw.text), dish: clean(raw.dish, 150), requiredIngredients: list(raw.requiredIngredients),
    excludedIngredients: list(raw.excludedIngredients), methods: list(raw.methods),
    maxMinutes: Number.isInteger(raw.maxMinutes) && raw.maxMinutes >= 5 && raw.maxMinutes <= 180 ? raw.maxMinutes : null,
    servings: Number.isInteger(raw.servings) && raw.servings >= 1 && raw.servings <= 10 ? raw.servings : null };
  return result.text || result.dish || result.requiredIngredients.length || result.excludedIngredients.length || result.methods.length || result.maxMinutes ? result : null;
}

export function parseMealRequest(text) {
  const source = clean(text);
  if (!source) return null;
  let rest = source;
  const people = source.match(/(?:на|для)\s*(\d+|одного|двоих|троих|четверых|пятерых|шестерых)/u);
  const servings = people ? Number(people[1]) || ({ одного: 1, двоих: 2, троих: 3, четверых: 4, пятерых: 5, шестерых: 6 })[people[1]] : null;
  const excludedIngredients = [], requiredIngredients = [], methods = [];
  const max = rest.match(/(?:за|до|максимум|не больше)\s*(\d{1,3})\s*мин/u);
  const maxMinutes = max ? Number(max[1]) : /быстр|полчаса/u.test(rest) ? 30 : null;
  rest = rest.replace(/(?:за|до|максимум|не больше)\s*\d{1,3}\s*мин[\p{L}.]*/gu, ' ')
    .replace(/(?:на|для)\s*(?:\d+|одного|двоих|троих|четверых|пятерых|шестерых)(?:\s*(?:человек|порц[\p{L}]*))?/gu, ' ');
  rest = rest.replace(/(?:^|\s)без\s+(.+?)(?=\s+(?:за|до|на|с|со|из|в)\s|[,.;]|$)/gu, (_, value) => { excludedIngredients.push(...value.split(/\s+и\s+/u)); return ' '; });
  for (const [pattern, name] of [[/на\s+гриле/gu, 'гриль'], [/в\s+духовке/gu, 'духовка'], [/на\s+пару/gu, 'пар'], [/на\s+сковороде/gu, 'сковорода']]) {
    if (pattern.test(rest)) { methods.push(name); pattern.lastIndex = 0; rest = rest.replace(pattern, ' '); }
  }
  // Keep ingredient requirements separate from the identity of the dish.
  rest = rest.replace(/(?:^|\s)(?:с|со|из)\s+(.+)$/u, (_, value) => { requiredIngredients.push(...value.split(/\s+и\s+|,/u)); return ' '; });
  rest = rest.replace(/(?:^|\s)(?:сегодня|на\s+сегодня|на\s+ужин|хочу|хочется|хотим|давай|давайте|приготовим|приготовить|найди|найти|подбери|рецепт|пожалуйста|мне|я|что[ -]нибудь|быстрое|быстро|легкий|легкое|ужин|блюдо|блюда|кухня|кухню)(?=\s|$)/gu, ' ')
    .replace(/(?:азиатск|итальянск|грузинск|японск|китайск|русск|восточн|кавказск|узбекск|европейск|домашн|мясн|рыбн)[\p{L}]*/gu, ' ')
    .replace(/[,.!?;:]+/gu, ' ').replace(/\s+/gu, ' ').trim();
  if (/^(?:говядина|говядину|курица|курицу|свинина|свинину|рыба|рыбу|рис|фарш|индейка|индейку)$/u.test(rest)) { requiredIngredients.push(rest); rest = ''; }
  if (/^(?:мясо|азиатское|домашнее)$/u.test(rest)) rest = '';
  return normalizeMealRequest({ text: source, dish: rest, requiredIngredients, excludedIngredients, methods, maxMinutes, servings });
}

export function mergeMealRequests(before, patch, replace = false) {
  const a = normalizeMealRequest(before), b = normalizeMealRequest(patch);
  if (replace) return b;
  if (!b) return a;
  if (!a) return b;
  return normalizeMealRequest({ text: `${a.text}; ${b.text}`, dish: b.dish || a.dish,
    requiredIngredients: [...a.requiredIngredients, ...b.requiredIngredients], excludedIngredients: [...a.excludedIngredients, ...b.excludedIngredients],
    methods: [...a.methods, ...b.methods], maxMinutes: b.maxMinutes ?? a.maxMinutes, servings: b.servings ?? a.servings });
}

export function matchesMealRequest(recipe, raw) {
  const request = normalizeMealRequest(raw);
  if (!request) return true;
  if (request.servings && (!Number.isInteger(recipe.servings) || recipe.servings < request.servings)) return false;
  // Dish identity is checked in the title, never in a tag or a passing mention.
  if (request.dish && !containsFoodPhrase(recipe.title, request.dish)) return false;
  const ingredients = (recipe.ingredients || []).map((i) => i.name || i.raw || i);
  if (request.requiredIngredients.some((item) => !ingredients.some((name) => containsFoodPhrase(name, item)))) return false;
  const steps = (recipe.steps || []).map((s) => s.text || s).join(' ');
  const methods = { гриль: /грил/iu, духовка: /духов|запек/iu, пар: /на пару|паровар/iu, сковорода: /сковород/iu };
  if (request.methods.some((method) => !methods[method]?.test(steps))) return false;
  if (request.maxMinutes && (!Number.isFinite(recipe.prepMinutes) || !Number.isFinite(recipe.cookMinutes) || recipe.prepMinutes + recipe.cookMinutes > request.maxMinutes)) return false;
  return true;
}

export function recipeTextIngredients(recipe) {
  return { ingredients: [...(recipe.ingredients || []), { name: recipe.title }, ...(recipe.ingredients || []).filter((i) => i.comment).map((i) => ({ name: i.comment })), ...(recipe.steps || []).map((s) => ({ name: s.text || s }))] };
}
export function isSpicy(recipe) {
  return /чили|халапеньо|остр[\p{L}]*\s+перец|кайен|табаско/iu.test(recipeTextIngredients(recipe).ingredients.map((i) => i.name || i.raw || i).join(' '));
}
