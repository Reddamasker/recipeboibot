import { SEED_RECIPES, recipeCategories, hasExcludedIngredient } from './dinner.js';

export const cuisines = [['everyday','Домашняя'],['italian','Итальянская'],['georgian','Грузинская'],['russian','Русская'],['ukrainian','Украинская'],['belarusian','Белорусская'],['greek','Греческая'],['indian','Индийская'],['hungarian','Венгерская'],['japanese','Японская'],['chinese','Китайская'],['uzbek','Узбекская'],['eastern','Восточная'],['asian','Азиатская'],['european','Европейская'],['caucasian','Кавказская']];
export const categories = [['noodles','Лапша'],['rice','Рис'],['pasta','Паста'],['soup','Супы'],['salad','Салаты'],['baking','Выпечка'],['chicken','Курица'],['meat','Мясо'],['fish','Рыба'],['pizza','Пицца'],['home','Домашняя еда']];
// Browse by an identifiable cuisine rather than geographic umbrella tags.
// Keep the original taxonomy for saved links/history without rewriting seeds.
export const cuisineChoices = cuisines.filter(([id])=>!['asian','eastern','european','caucasian'].includes(id)).concat([['lebanese','Ливанская'],['turkish','Турецкая']]);
const sourceCuisine = {'ea-mujaddara':'lebanese','ea-hummus':'lebanese','ea-fattoush':'lebanese','ea-lentil-bulgur':'turkish'};
const normalize = value => String(value || '').toLocaleLowerCase('ru').replaceAll('ё','е').trim();
function hasCookingProduct(recipe,product) {
  const rice = normalize(product)==='рис';
  const ingredients=recipe.ingredients.filter(i=>!rice||!/рисов\p{L}*\s+(?:уксус|бумаг|лапш|мук)/iu.test(i.name));
  return hasExcludedIngredient({ingredients,title:'',steps:[]},[product]);
}
// Editorial styles for identifiable dishes; do not infer a national cuisine from a common ingredient.
const cuisineOverrides = {
  'pasta-tomato':['italian','european'], 'chicken-pasta':['italian','european'],
  'beef-pasta':['italian','european'], 'tuna-pasta-family':['italian','european'],
  'keftedes':['greek','european'], 'keema-potato':['indian','asian'],
  'beef-goulash-mash':['hungarian','european'], 'borscht-beef':['ukrainian'],
  'potato-draniki':['belarusian','european']
};
function catalogCategories(recipe) {
  const all = recipeCategories(recipe), override = cuisineOverrides[recipe.id.slice(5)];
  // Authored cuisine assignments take precedence over incidental words in food
  // names. Existing recipes retain their previous categories and overrides.
  if (recipe.cuisines?.length) return [...all.filter(id=>!cuisines.some(([c])=>c===id)),...recipe.cuisines];
  const result = override ? [...all.filter(id=>!cuisines.some(([c])=>c===id)),...override] : all;
  if(!result.some(id=>cuisines.some(([c])=>c===id))) result.push('everyday');
  return result;
}
const entries = SEED_RECIPES.map(recipe => {
  const assigned = catalogCategories(recipe);
  const cuisineId = sourceCuisine[recipe.id.slice(5)] || cuisineChoices.find(([id])=>assigned.includes(id))?.[0] || null;
  if (recipe.ingredients.some(i=>/лапш|удон|соба|сомен|рамен|фунчоз|макароны широкие/iu.test(i.name))) {
    const pastaIndex=assigned.indexOf('pasta'); if(pastaIndex!==-1)assigned.splice(pastaIndex,1);
    assigned.push('noodles');
  }
  if (/пирог|кулебяк|самса|мчади|пицц|хачап|леп[её]шк/iu.test(recipe.title)) assigned.push('baking');
  return {
  id: recipe.id.slice(5), title: recipe.title, description: recipe.description,
  minutes: recipe.prepMinutes + recipe.cookMinutes, servings: recipe.servings,
  categories: [...new Set(assigned)], cuisineId, cuisineLabel: cuisineChoices.find(([id])=>id===cuisineId)?.[1] || null,
  image: recipe.thumbnailUrl, imageGenerated: recipe.imageGenerated,
  ingredients: recipe.ingredients.map(({name,quantity,unit})=>({name,quantity,unit})),
  steps: recipe.steps.map(step=>step.text), nutrition: recipe.nutrition
}; });
export function catalogRecipe(id) { return entries.find(recipe=>recipe.id === id) || null; }
export function catalogSearch(params = new URLSearchParams()) {
  const words = normalize(params.get('q')).slice(0,160).split(/\s+/).filter(Boolean);
  const split = key => String(params.get(key)||'').slice(0,250).split(',').map(s=>s.trim()).filter(Boolean).slice(0,12);
  const include = split('include'), exclude = split('exclude');
  const cuisine = params.get('cuisine'), category = params.get('category');
  const exactCuisine = cuisineChoices.some(([id])=>id===cuisine);
  const max = Number(params.get('time')) || Infinity;
  const saved = params.has('saved') ? new Set(String(params.get('saved')).split(',').slice(0,250)) : null;
  let recipes = entries.filter(recipe => {
    const text = normalize([recipe.title,recipe.description,...recipe.ingredients.map(i=>i.name)].join(' '));
    return words.every(word=>text.includes(word)) && (!cuisine || (exactCuisine ? recipe.cuisineId===cuisine : recipe.categories.includes(cuisine))) &&
      (!category || recipe.categories.includes(category)) && recipe.minutes <= max &&
      include.every(ingredient=>hasCookingProduct(recipe,ingredient)) &&
      !hasExcludedIngredient(recipe,exclude) && (!saved || saved.has(recipe.id));
  });
  if (params.get('sort') === 'fast') recipes.sort((a,b)=>a.minutes-b.minutes);
  else if (params.get('sort') === 'name') recipes.sort((a,b)=>a.title.localeCompare(b.title,'ru'));
  else recipes.sort((a,b)=>Number(Boolean(b.image))-Number(Boolean(a.image)));
  const total = recipes.length, pages = Math.max(1,Math.ceil(total/24));
  const page = Math.min(pages,Math.max(1,Math.floor(Number(params.get('page')))||1));
  const facets = list => list.map(([id,label])=>({id,label,count:entries.filter(r=>r.categories.includes(id)).length})).filter(f=>f.count);
  return { total, page, pages, catalogTotal: entries.length, cuisines: facets(cuisines), categories: facets(categories),
    cuisineChoices: cuisineChoices.map(([id,label])=>({id,label,count:entries.filter(r=>r.cuisineId===id).length})).filter(c=>c.count),
    recipes: recipes.slice((page-1)*24,page*24).map(({ingredients,steps,nutrition,...recipe})=>({...recipe,ingredientCount:ingredients.length})) };
}
