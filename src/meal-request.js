// A request survives extraction, storage, generation and cache reuse unchanged.
// Categories help ranking; they are not a substitute for the name of a dish.
const clean = (value, limit = 500) => String(value || '').normalize('NFKC').toLocaleLowerCase('ru').replaceAll('ё', 'е').trim().slice(0, limit);
const list = (value) => [...new Set((Array.isArray(value) ? value : []).filter((v) => typeof v === 'string').map((v) => clean(v, 100)).filter(Boolean))].slice(0, 12);
const semanticCriteria = (value, legacyNovelty = null) => {
  const normalized = (Array.isArray(value) ? value : []).filter((item) => item && typeof item === 'object' && !Array.isArray(item))
    .map((item) => ({ description: clean(item.description, 240), importance: item.importance === 'preferred' ? 'preferred' : 'required' }))
    .filter((item) => item.description);
  // Sessions created before semantic validation stored only this coarse flag.
  // Convert it once at the boundary; new requests never depend on the flag.
  if (!normalized.length && legacyNovelty === 'unusual') normalized.push({ description: 'Блюдо должно быть необычным и незаезженным для повседневного ужина', importance: 'required' });
  if (!normalized.length && legacyNovelty === 'familiar') normalized.push({ description: 'Блюдо должно быть привычным, понятным и без нарочитой экзотики', importance: 'required' });
  return [...new Map(normalized.map((item) => [`${item.importance}:${item.description}`, item])).values()].slice(0, 8);
};
const words = (value) => clean(value).match(/[\p{L}\p{N}]+/gu) || [];
export const mealRequestSchema = { type: ['object', 'null'], additionalProperties: false, properties: {
  text: { type: 'string' }, kind: { type: 'string', enum: ['exact', 'open'] }, confidence: { type: 'string', enum: ['high', 'medium', 'low'] }, dish: { type: 'string' }, requiredIngredients: { type: 'array', items: { type: 'string' } },
  semanticCriteria: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
    description: { type: 'string' }, importance: { type: 'string', enum: ['required', 'preferred'] }
  }, required: ['description', 'importance'] } },
  excludedIngredients: { type: 'array', items: { type: 'string' } }, methods: { type: 'array', items: { type: 'string', enum: ['гриль', 'духовка', 'пар', 'сковорода'] } },
  maxMinutes: { type: ['integer', 'null'] }, servings: { type: ['integer', 'null'] }
}, required: ['text', 'kind', 'confidence', 'dish', 'requiredIngredients', 'semanticCriteria', 'excludedIngredients', 'methods', 'maxMinutes', 'servings'] };
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
  const normalizedDish = clean(raw.dish, 150);
  // New requests carry semantic intent from the classifier. The small legacy
  // fallback keeps pre-release sessions readable without making word lists the
  // primary routing mechanism.
  const legacyOpen = !raw.kind && /^(?:что|чего)[ -](?:то|нибудь|либо)$/u.test(normalizedDish);
  const kind = raw.kind === 'open' || legacyOpen ? 'open' : raw.kind === 'exact' || normalizedDish ? 'exact' : 'open';
  const confidence = ['high', 'medium', 'low'].includes(raw.confidence) ? raw.confidence : null;
  const dish = kind === 'open' ? '' : normalizedDish;
  const result = { text: clean(raw.text), kind, confidence, dish, requiredIngredients: list(raw.requiredIngredients),
    semanticCriteria: semanticCriteria(raw.semanticCriteria, raw.novelty),
    excludedIngredients: list(raw.excludedIngredients), methods: list(raw.methods),
    maxMinutes: Number.isInteger(raw.maxMinutes) && raw.maxMinutes >= 5 && raw.maxMinutes <= 180 ? raw.maxMinutes : null,
    servings: Number.isInteger(raw.servings) && raw.servings >= 1 && raw.servings <= 10 ? raw.servings : null };
  return result.text || result.dish || result.requiredIngredients.length || result.excludedIngredients.length || result.methods.length || result.maxMinutes ? result : null;
}

// Strip conversational framing before extracting ingredients: otherwise a word
// such as "дай" becomes part of the dish, or "пожалуйста" part of the garnish.
// Only leading request phrases are removed. Negations and dish words stay intact.
function stripRequestFraming(text) {
  let rest = text.replace(/(?<![\p{L}\p{N}])пожалуйста(?![\p{L}\p{N}])/gu, ' ');
  const trimEdges = (value) => value.replace(/^[\s,.!?;:«»"“”]+|[\s,.!?;:«»"“”]+$/gu, '').replace(/\s+/gu, ' ');
  const prefix = /^(?:привет|здравствуй(?:те)?|добрый\s+(?:день|вечер)|доброе\s+утро|дай(?:те)?|покажи(?:те)?|посоветуй(?:те)?|предложи(?:те)?|подскажи(?:те)?|найди(?:те)?|подбери(?:те)?|пришли(?:те)?|расскажи(?:те)?|можешь|можете|можно|не\s+мог(?:ли)?\s+бы|хотел(?:а|и)?\s+бы|хочу|хотим|хочется|давай(?:те)?|как|приготовить|приготовим|готовить|сделать|найти|показать|посоветовать|предложить|подсказать|подобрать|дать|рецепт(?:ик)?(?:\s+приготовления)?|сегодня|на\s+сегодня|на\s+ужин|мне|нам|ты|вы|я|ли)(?=$|[\s,.!?;:«»"“”])/u;
  rest = trimEdges(rest);
  while (prefix.test(rest)) rest = trimEdges(rest.replace(prefix, ''));
  return rest;
}

export function parseMealRequest(text) {
  const source = clean(text);
  if (!source) return null;
  let rest = stripRequestFraming(source);
  const people = source.match(/(?:на|для)\s*(\d+|одного|двоих|троих|четверых|пятерых|шестерых)/u);
  const servings = people ? Number(people[1]) || ({ одного: 1, двоих: 2, троих: 3, четверых: 4, пятерых: 5, шестерых: 6 })[people[1]] : null;
  const excludedIngredients = [], requiredIngredients = [], methods = [];
  rest = rest.replace(/(?:^|\s)(?:что|че|чё)(?:\s*[- ]?\s*)(?:то|нибудь|нить|либо)(?=\s|$)/gu, ' ')
    .replace(/(?:^|\s)на\s+(?:ужин|обед|завтрак)(?=\s|$)/gu, ' ')
    .replace(/\s+/gu, ' ').trim();
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
  rest = rest.replace(/(?:^|\s)(?:сегодня|на\s+сегодня|на\s+ужин|хочу|хочется|хотим|давай|давайте|приготовим|приготовить|найди|найти|подбери|рецепт|пожалуйста|мне|я|что[ -](?:то|нибудь|либо)|чего[ -](?:то|нибудь|либо)|быстрое|быстро|легкий|легкое|ужин|блюдо|блюда|кухня|кухню)(?=\s|$)/gu, ' ')
    .replace(/(?:азиатск|итальянск|грузинск|японск|китайск|русск|восточн|кавказск|узбекск|европейск|домашн|мясн|рыбн)[\p{L}]*/gu, ' ')
    .replace(/[,.!?;:]+/gu, ' ').replace(/\s+/gu, ' ').trim();
  if (/^(?:говядина|говядину|курица|курицу|свинина|свинину|рыба|рыбу|рис|фарш|индейка|индейку)$/u.test(rest)) { requiredIngredients.push(rest); rest = ''; }
  if (/^(?:мясо|азиатское|домашнее)$/u.test(rest)) rest = '';
  return normalizeMealRequest({ text: source, kind: rest ? 'exact' : 'open', confidence: null, dish: rest, requiredIngredients, semanticCriteria: [], excludedIngredients, methods, maxMinutes, servings });
}

export function mergeMealRequests(before, patch, replace = false) {
  const a = normalizeMealRequest(before), b = normalizeMealRequest(patch);
  if (replace) return b;
  if (!b) return a;
  if (!a) return b;
  return normalizeMealRequest({ text: `${a.text}; ${b.text}`, kind: b.dish ? b.kind : a.kind, confidence: b.dish ? b.confidence : a.confidence, dish: b.dish || a.dish, semanticCriteria: [...a.semanticCriteria, ...b.semanticCriteria],
    requiredIngredients: [...a.requiredIngredients, ...b.requiredIngredients], excludedIngredients: [...a.excludedIngredients, ...b.excludedIngredients],
    methods: [...a.methods, ...b.methods], maxMinutes: b.maxMinutes ?? a.maxMinutes, servings: b.servings ?? a.servings });
}

export function matchesMealRequest(recipe, raw) {
  const request = normalizeMealRequest(raw);
  if (!request) return true;
  if (request.servings && (!Number.isInteger(recipe.servings) || recipe.servings < request.servings)) return false;
  // Dish identity is checked in the title, never in a tag or a passing mention.
  // Low-confidence classification is a soft hint: hard filters must not turn
  // an ambiguous phrase into a literal dish name and reject every result.
  if (request.dish && request.kind === 'exact' && request.confidence !== 'low' && !containsFoodPhrase(recipe.title, request.dish)) return false;
  const ingredients = (recipe.ingredients || []).map((i) => i.name || i.raw || i);
  if (request.requiredIngredients.some((item) => !ingredients.some((name) => containsFoodPhrase(name, item)))) return false;
  const steps = (recipe.steps || []).map((s) => s.text || s).join(' ');
  const methods = { гриль: /грил/iu, духовка: /духов|запек/iu, пар: /на пару|паровар/iu, сковорода: /сковород/iu };
  if (request.methods.some((method) => !methods[method]?.test(steps))) return false;
  if (request.maxMinutes && (!Number.isFinite(recipe.prepMinutes) || !Number.isFinite(recipe.cookMinutes) || recipe.prepMinutes + recipe.cookMinutes > request.maxMinutes)) return false;
  return true;
}

export function needsSemanticValidation(raw) {
  const request = normalizeMealRequest(raw);
  return Boolean(request && (request.semanticCriteria.length || request.kind === 'open'));
}

export function recipeTextIngredients(recipe) {
  return { ingredients: [...(recipe.ingredients || []), { name: recipe.title }, ...(recipe.ingredients || []).filter((i) => i.comment).map((i) => ({ name: i.comment })), ...(recipe.steps || []).map((s) => ({ name: s.text || s }))] };
}
export function isSpicy(recipe) {
  return /чили|халапеньо|остр[\p{L}]*\s+перец|кайен|табаско/iu.test(recipeTextIngredients(recipe).ingredients.map((i) => i.name || i.raw || i).join(' '));
}
