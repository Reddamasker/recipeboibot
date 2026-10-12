import { createHash } from 'node:crypto';
export const nutritionKey = recipe => createHash('sha256').update(JSON.stringify([1, recipe.title, recipe.servings ?? null, recipe.ingredients || [], recipe.steps || []])).digest('hex');
// All public values are per serving. Source totals / per-100g values must carry
// enough information to convert; never silently relabel them as a serving.
export const nutritionSchema = { type: 'object', additionalProperties: false, properties: {
  calories: { type: 'number' }, protein: { type: 'number' }, fat: { type: 'number' }, carbs: { type: 'number' },
  basis: { type: 'string', enum: ['serving', 'total', '100g'] }, source: { type: 'string', enum: ['recipe', 'calculated'] },
  servings: { type: 'integer' }, weightGrams: { type: ['number', 'null'] }, assumptions: { type: 'array', items: { type: 'string' } }
}, required: ['calories', 'protein', 'fat', 'carbs', 'basis', 'source', 'servings', 'weightGrams', 'assumptions'] };
export const nutritionInstructions = `КБЖУ обязательно: nutrition содержит calories (ккал), protein, fat, carbs (г). Если все четыре значения есть в источнике, сохрани их с source=recipe и исходной basis=serving|total|100g. Не смешивай разные базы. Иначе рассчитай все четыре по фактическим количествам ингредиентов, включая масло, соусы и гарнир; source=calculated, basis=serving. Никогда не подставляй нули вместо неизвестного. servings — число порций (совпадает с servings рецепта, когда оно известно), weightGrams — масса всего готового блюда, если необходима для пересчёта с 100 г. Если количества или число порций не указаны, оцени их по составу и шагам и перечисли допущения в assumptions; исходные ингредиенты не меняй. Для создания новых рецептов числа nutrition должны соответствовать составу; числовые mealRequest.nutritionLimits обязательны и относятся к одной порции. Оценка не является точным лабораторным измерением.`;
const keys = ['calories', 'protein', 'fat', 'carbs'];
const clean = value => String(value || '').toLocaleLowerCase('ru').replaceAll('ё', 'е');
export function normalizeNutrition(value, recipe = {}) {
  if (!value || typeof value !== 'object' || keys.some(k => !Number.isFinite(value[k]) || value[k] < 0)) return null;
  const servings = Number.isInteger(recipe.servings) && recipe.servings > 0 ? recipe.servings : value.servings;
  if (!Number.isInteger(servings) || servings < 1 || servings > 100) return null;
  const basis = value.basis || 'serving';
  let divisor = 1;
  if (basis === 'total') divisor = servings;
  else if (basis === '100g') {
    if (!Number.isFinite(value.weightGrams) || value.weightGrams <= 0) return null;
    divisor = 100 * servings / value.weightGrams;
  } else if (basis !== 'serving') return null;
  // A supplied per-serving calculation with a different serving count is stale.
  if (basis === 'serving' && Number.isInteger(value.servings) && value.servings !== servings) return null;
  const numbers = Object.fromEntries(keys.map(k => [k, Math.round(value[k] / divisor * 10) / 10]));
  if (numbers.calories > 10000 || keys.slice(1).some(k => numbers[k] > 1000)) return null;
  return { ...numbers, basis: 'serving', source: value.source === 'recipe' ? 'recipe' : 'calculated', servings,
    weightGrams: Number.isFinite(value.weightGrams) && value.weightGrams > 0 ? value.weightGrams : null,
    assumptions: (Array.isArray(value.assumptions) ? value.assumptions : []).filter(x => typeof x === 'string').map(x => x.slice(0, 300)).slice(0, 20) };
}

// Approximate reference composition of common ingredients per 100 g. This is a
// local estimate for existing recipes, not a claim about a particular brand.
// Unsupported foods/units trigger model estimation rather than zero-filling.
const foods = [
  // Additional pantry foods used by the regional catalog, per 100 g. Specific
  // dairy, cooked meat and vegetable entries precede broad legacy patterns.
  [/сыр.*фета|сыр.*брынз/u, [264, 14.2, 21.3, 4.1], 30, 10],
  [/сыр.*сулугуни/u, [286, 20, 22, 0.4], 30, 10],
  [/колбаса.*готов/u, [320, 16, 28, 1], 50, 15],
  [/бекон/u, [417, 13, 40, 1], 30, 15],
  [/квашен.*капуст/u, [19, .9, .1, 4.3], 100, 15],
  [/кукурузн.*крахмал/u, [381, .3, .1, 91.3], 10, 10],
  [/кукурузн.*(?:крупа|мука)/u, [370, 7.1, 1.8, 79.5], 80, 10],
  [/булгур/u, [342, 12.3, 1.3, 75.9], 80, 15],
  [/пшено/u, [378, 11, 4.2, 72.9], 80, 15],
  [/маш.*сух/u, [347, 23.9, 1.2, 62.6], 80, 15],
  [/грецк.*орех/u, [654, 15.2, 65.2, 13.7], 5, 10],
  [/тахини/u, [595, 17, 54, 21.2], 15, 15],
  [/кунжут(?!ное масло)/u, [573, 17.7, 49.7, 23.4], 5, 9],
  [/баклажан/u, [25, 1, .2, 5.9], 250, 15],
  [/сельдерей/u, [16, .7, .2, 3], 40, 15],
  [/оливк.*без кост/u, [145, 1, 15.3, 3.8], 4, 15],
  [/каперс/u, [23, 2.4, .9, 4.9], 2, 10],
  [/редис/u, [16, .7, .1, 3.4], 15, 15],
  [/лук-порей/u, [61, 1.5, .3, 14.2], 100, 15],
  [/уксус/u, [18, 0, 0, .1], 15, 15],
  [/куркума/u, [312, 9.7, 3.3, 67.1], 1, 3],
  [/сумах/u, [200, 4, 10, 24], 1, 3],
  [/масло.*сливоч|сливоч.*масло/u, [717, .9, 81, .1], 10, 14],
  [/масло/u, [884, 0, 100, 0], 10, 14],
  [/сливк/u, [206, 2.5, 20, 3.4], 100, 15],
  [/сметан/u, [206, 2.8, 20, 3.2], 100, 20],
  [/молок/u, [61, 3.2, 3.3, 4.8], 200, 15],
  [/йогурт|кефир/u, [60, 3.5, 3.2, 4.7], 150, 15],
  [/пармезан/u, [392, 36, 26, 3.2], 30, 5],
  [/моцарелл/u, [280, 28, 17, 3.1], 125, 10],
  [/сыр/u, [350, 25, 27, 2], 30, 10],
  [/творог/u, [121, 17, 5, 1.8], 200, 20],
  [/яйц|яиц/u, [143, 12.6, 9.5, .7], 50, 15],
  [/курин.*(?:бедр|б[её]др)|(?:бедр|б[её]др).*кур/u, [144, 19, 7, 0], 120, 15],
  [/куриц|курин/u, [120, 22.5, 2.6, 0], 150, 15],
  [/индейк|индюш/u, [114, 23.7, 1.5, 0], 150, 15],
  [/говяд|говяж|телят/u, [215, 19, 15, 0], 150, 15],
  [/свин/u, [242, 19, 18, 0], 150, 15],
  [/фарш|мяс/u, [215, 19, 15, 0], 150, 15],
  [/тун[её]ц|тунц/u, [116, 26, 1, 0], 150, 15],
  [/лосос|форел|семг/u, [208, 20, 13, 0], 150, 15],
  [/рыб|минта|треск|хек/u, [82, 18, .7, 0], 150, 15],
  [/рис.*(?:варен|готов)|(?:варен|готов).*рис/u, [130, 2.7, .3, 28], 150, 15],
  [/рис/u, [365, 7, .7, 80], 80, 15],
  [/греч/u, [343, 13, 3.4, 71.5], 80, 15],
  [/овсян/u, [379, 13, 6.5, 68], 40, 10],
  [/перлов/u, [352, 9.9, 1.2, 77.7], 80, 15],
  [/кускус|кус-кус/u, [376, 12.8, .6, 77.4], 80, 15],
  [/макарон|паста|спагет|лапш/u, [371, 13, 1.5, 75], 80, 15],
  [/мука|мук[иу]/u, [364, 10.3, 1, 76], 100, 10],
  [/хлеб|сухар|лаваш/u, [265, 9, 3.2, 49], 30, 10],
  [/(?:нут|фасол).*консерв|консерв.*(?:нут|фасол)|готов.*(?:нут|фасол)/u, [120, 7, 1, 20], 150, 15],
  [/чечевиц/u, [352, 25, 1.1, 60], 80, 15],
  [/горошек|зелен.*горох/u, [81, 5.4, .4, 14.5], 80, 15],
  [/горох/u, [341, 24.6, 1.2, 60], 80, 15],
  [/нут/u, [378, 20.5, 6, 63], 80, 15],
  [/фасол/u, [333, 23, 1, 60], 80, 15],
  [/картоф/u, [77, 2, .1, 17], 150, 15],
  [/свекл/u, [43, 1.6, .2, 10], 150, 15],
  [/имбир/u, [80, 1.8, .8, 18], 10, 5],
  [/морков/u, [41, .9, .2, 10], 80, 15],
  [/лук/u, [40, 1.1, .1, 9.3], 100, 15],
  [/чеснок/u, [149, 6.4, .5, 33], 5, 5],
  [/паст.*томат|томат.*паст/u, [82, 4.3, .5, 19], 30, 15],
  [/томат|помидор/u, [18, .9, .2, 3.9], 120, 15],
  [/яблок/u, [52, .3, .2, 14], 150, 15],
  [/тыкв/u, [26, 1, .1, 6.5], 200, 15],
  [/кабач|цуккин/u, [17, 1.2, .3, 3.1], 250, 15],
  [/капуст|броккол/u, [25, 1.3, .1, 5.8], 500, 15],
  [/огур/u, [15, .7, .1, 3.6], 120, 15],
  [/перец/u, [31, 1, .3, 6], 150, 15],
  [/гриб|шампиньон/u, [22, 3.1, .3, 3.3], 30, 15],
  [/овощ/u, [35, 1.5, .3, 7], 150, 15],
  [/шпинат|салат.*лист|лист.*салат/u, [23, 2.9, .4, 3.6], 50, 5],
  [/сахар/u, [387, 0, 0, 100], 5, 12],
  [/мед/u, [304, .3, 0, 82], 10, 21],
  [/соев.*соус/u, [53, 8, .6, 5], 15, 15],
  [/лимон/u, [29, 1.1, .3, 9.3], 60, 15],
  [/вода|соль/u, [0, 0, 0, 0], 1, 15],
  [/разрыхлител/u, [53, 0, 0, 28], 5, 10],
  [/укроп|петруш|базилик|мят|кориандр|паприк|зира|орегано|тимьян|розмарин|специ|приправ|зелень|кинза|карри/u, [30, 2, .5, 4], 2, 3],
  [/тмин/u, [333, 19.8, 14.6, 49.9], 1, 6],
  [/корица/u, [247, 4, 1.2, 80.6], 1, 8]
];
export function estimateNutrition(recipe) {
  if (!recipe.ingredients?.length) return null;
  const totals = [0, 0, 0, 0], assumptions = ['Средние значения состава продуктов; конкретные марки и жирность могут отличаться.'];
  let totalWeight = 0;
  for (const item of recipe.ingredients) {
    const name = clean(`${item.name || item.raw || item} ${item.comment || ''}`);
    const food = foods.find(([pattern]) => pattern.test(name));
    if (!food) return null;
    const [, nutrients, pieceWeight, spoonWeight] = food;
    let quantity = item.quantity, unit = clean(item.unit).replace(/\s|\./g, '');
    if (!Number.isFinite(quantity)) {
      const text = String(item.raw || item.name || item);
      const parsed = text.match(/(\d+(?:[.,]\d+)?)\s*(кг|г|гр|мл|л|шт\.?|ст\.?\s*л\.?|ч\.?\s*л\.?)/iu);
      if (parsed) { quantity = Number(parsed[1].replace(',', '.')); unit = clean(parsed[2]).replace(/\s|\./g, ''); }
      else if (/соль|специ|укроп|петруш|базилик|мят|орегано|кориандр|паприк|зира/u.test(name)) { quantity = 1; unit = 'шт'; assumptions.push(`${item.name || item.raw}: небольшое количество по вкусу.`); }
      else {
        quantity = /куриц|курин|индейк|говяд|говяж|свин|фарш|рыб|минта/u.test(name) ? Math.max(1, recipe.servings || 1) : 1;
        unit = 'шт';
        assumptions.push(`${item.name || item.raw}: количество не указано, принято около ${quantity * pieceWeight} г.`);
      }
    }
    if (quantity < 0 || quantity > 100000) return null;
    let grams;
    if (['г', 'гр', 'грамм', 'граммов', 'мл'].includes(unit)) grams = quantity;
    else if (['кг', 'л'].includes(unit)) grams = quantity * 1000;
    else if (/^(шт|штук|штуки|зубчик|зубчика|зубчиков)$/u.test(unit)) grams = quantity * pieceWeight;
    else if (['стл', 'столоваяложка', 'столовыеложки'].includes(unit)) grams = quantity * spoonWeight;
    else if (['чл', 'чайнаяложка'].includes(unit)) grams = quantity * spoonWeight / 3;
    else return null;
    if (!['г', 'гр', 'грамм', 'граммов', 'кг'].includes(unit)) assumptions.push(`${item.name || item.raw}: масса оценена по единице «${item.unit || unit}».`);
    // Explicit cooked / canned starches must not use the dry-food composition.
    if (/варен|готов|консерв/u.test(name) && /греч|макарон|паста|чечевиц|горох|перлов|нут|фасол/u.test(name) && !/консерв|готов/u.test(food[0].source)) return null;
    totalWeight += grams;
    nutrients.forEach((value, index) => { totals[index] += value * grams / 100; });
  }
  if (!totalWeight) return null;
  const servings = Number.isInteger(recipe.servings) && recipe.servings > 0 ? recipe.servings : Math.max(1, Math.round(totalWeight / 350));
  if (!recipe.servings) assumptions.push(`Число порций оценено: ${servings}, по массе ингредиентов.`);
  return normalizeNutrition({ ...Object.fromEntries(keys.map((k, i) => [k, totals[i] / servings])), basis: 'serving', source: 'calculated', servings, weightGrams: null, assumptions }, recipe);
}
export const recipeNutrition = recipe => normalizeNutrition(recipe?.nutrition, recipe) || estimateNutrition(recipe || {});
export function normalizeNutritionLimits(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const limits = {};
  for (const key of keys) {
    const value = raw[key];
    const maxValue = key === 'calories' ? 10000 : 1000;
    const min = Number.isFinite(value?.min) && value.min >= 0 && value.min <= maxValue ? value.min : null;
    const max = Number.isFinite(value?.max) && value.max >= 0 && value.max <= maxValue ? value.max : null;
    if (min !== null || max !== null) limits[key] = { min, max };
  }
  return Object.keys(limits).length ? limits : null;
}
export const nutritionLimitsSchema = { type: ['object', 'null'], additionalProperties: false, properties: Object.fromEntries(keys.map(k => [k, { type: ['object', 'null'], additionalProperties: false, properties: { min: { type: ['number', 'null'] }, max: { type: ['number', 'null'] } }, required: ['min', 'max'] }])), required: keys };
export function parseNutritionLimits(text) {
  let stripped = clean(text);
  const limits = {};
  const comparator = '(?:не\\s+(?:больше|более|меньше|менее)|не\\s+выше|не\\s+ниже|до|от|максимум|минимум|больше|более|меньше|менее)';
  const nutrient = '(?:ккал|калори[а-я]*|белк[а-я]*|жир[а-я]*|углевод[а-я]*)';
  const apply = (comparison, number, name) => {
    const key = /ккал|калори/u.test(name) ? 'calories' : /белк/u.test(name) ? 'protein' : /жир/u.test(name) ? 'fat' : 'carbs';
    const direction = /не\s+(?:меньше|менее|ниже)|от|минимум/u.test(comparison) || /^(?:больше|более)$/u.test(comparison) ? 'min' : 'max';
    const value = Number(number.replace(',', '.'));
    limits[key] ||= { min: null, max: null };
    limits[key][direction] = value;
  };
  stripped = stripped.replace(new RegExp(`(${comparator})\\s*(\\d+(?:[.,]\\d+)?)\\s*(?:г(?:рамм(?:а|ов)?)?\\s*)?(${nutrient})(?:\\s*(?:на|в)\\s*(?:одну\\s*)?порци[а-я]*)?`, 'gu'), (_, comparison, number, name) => { apply(comparison, number, name); return ' '; });
  stripped = stripped.replace(new RegExp(`(${nutrient})\\s*(${comparator})\\s*(\\d+(?:[.,]\\d+)?)(?:\\s*г(?:рамм(?:а|ов)?)?)?`, 'gu'), (_, name, comparison, number) => { apply(comparison, number, name); return ' '; });
  stripped = stripped.replace(/(?:на|в)\s*(?:одну|1)\s*порци[а-я]*/gu, ' ');
  if (Object.keys(limits).length && /(?:на|в)\s*100\s*г|на\s*(?:все|всё|весь)\s*блюдо/u.test(clean(text))) {
    throw Object.assign(new Error('Укажите ограничения КБЖУ на одну порцию. Например: до 500 ккал на порцию.'), { status: 400 });
  }
  return { limits: normalizeNutritionLimits(limits), stripped: stripped.replace(/\s+/g, ' ').trim() };
}
export function matchesNutritionLimits(recipe, raw) {
  const limits = normalizeNutritionLimits(raw);
  if (!limits) return true;
  const nutrition = recipeNutrition(recipe);
  return Boolean(nutrition && Object.entries(limits).every(([key, { min, max }]) => (min === null || nutrition[key] >= min) && (max === null || nutrition[key] <= max)));
}
