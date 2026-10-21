import { SEED_RECIPES } from './dinner-seeds.js';
import { recipeMainIngredients } from './dinner.js';
import { normalize, primaryKeys, methodsOf } from './taste-features.js';
import { TasteFlow } from '../public/taste-model.js';

const familiar = ['borscht-beef','chicken-cutlets','mince-pasta','vegetable-omelette','fish-potato','egg-salad','buckwheat-mushroom','potato-draniki','lazy-cabbage-rolls','chicken-pilaf','vegetable-stew-family','ru-pelmeni','beef-goulash-mash','ru-vinegret','chicken-noodle-soup','pasta-tomato','fish-cutlets','pork-cabbage','pea-soup','mushroom-potato-bake','turkey-meatballs-rice','chicken-rice','tuna-salad','lentil-soup'].map(id => `seed:${id}`);
let catalog, engine, titleIds;
export function recipeTasteFeatures(recipe) {
  return { key: recipe.id, kind: 'recipe', ingredients: [...new Set((recipe.ingredients || []).map(i => normalize(i.name || i.raw || i)))],
    primary: primaryKeys(recipeMainIngredients(recipe)), methods: methodsOf({ ...recipe, steps: (recipe.steps || []).map((s,i) => typeof s === 'string' ? {text:s,position:i+1} : s) }).methods };
}
export function getTasteCatalog() {
  if (!catalog) {
    const items = SEED_RECIPES.map(recipe => ({ ...recipeTasteFeatures(recipe), label: recipe.title, photo: recipe.thumbnailUrl }));
    const order = [...familiar, ...items.map(i => i.key).filter(key => !familiar.includes(key))];
    catalog = { items, order };
    engine = TasteFlow.create(items, order);
    titleIds = new Map(items.map(i => [normalize(i.label), i.key]));
  }
  return catalog;
}
export function tasteEngine() { getTasteCatalog(); return engine; }
export function legacyDishRatings(dishes = {}) {
  getTasteCatalog();
  return Object.fromEntries(Object.entries(dishes).flatMap(([name,value]) => titleIds.has(normalize(name)) && [-1,1].includes(value) ? [[titleIds.get(normalize(name)),value]] : []));
}
export function withoutCatalogDishes(dishes = {}) {
  getTasteCatalog();
  return Object.fromEntries(Object.entries(dishes).filter(([name]) => !titleIds.has(normalize(name))));
}
export function namedDishRatings(ratings = {}) {
  const model = tasteEngine();
  return Object.fromEntries(Object.entries(ratings).filter(([id]) => model.byKey.has(id)).map(([id,value]) => [normalize(model.byKey.get(id).label),value]));
}
export function validateDishRatings(input) {
  const model = tasteEngine();
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length > model.byKey.size
    || Object.entries(input).some(([id,value]) => !model.byKey.has(id) || ![-1,1].includes(value))) {
    throw Object.assign(new Error('Не удалось сохранить выбор блюд. Обнови экран и попробуй снова.'), { status: 400 });
  }
  return { ...input };
}
// Recompute from authoritative recipes, never accept ingredient/method weights from a client.
export function dishTasteProfile(ratings = {}) { return tasteEngine().profile(ratings); }
export function dishTasteScore(recipe, profile = {}) {
  if (!Object.values(profile.dishRatings || {}).includes(1)) return 0;
  const model = tasteEngine(), features = model.byKey.get(recipe.id) || recipeTasteFeatures(recipe);
  return model.score(features, profile.tasteProfile || model.profile(profile.dishRatings));
}
export function isDislikedDish(recipe, profile = {}) {
  if (!Object.values(profile.dishRatings || {}).includes(-1)) return false;
  if (profile.dishRatings?.[recipe.id] === -1) return true;
  getTasteCatalog();
  return profile.dishRatings?.[titleIds.get(normalize(recipe.title || ''))] === -1;
}
