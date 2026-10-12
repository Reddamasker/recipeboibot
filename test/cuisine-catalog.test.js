import test from 'node:test';
import assert from 'node:assert/strict';
import catalog from '../src/cuisine-catalog.json' with { type: 'json' };
import { SEED_RECIPES } from '../src/dinner-seeds.js';
import { recipeNutrition } from '../src/nutrition.js';
import { catalogSearch, catalogRecipe, cuisines } from '../src/web-catalog.js';
import { hasExcludedIngredient } from '../src/dinner.js';

test('each regional filter offers a varied collection with accurate global counters',()=>{
  const counts = {everyday:208,italian:10,georgian:8,russian:8,ukrainian:8,belarusian:8,greek:8,indian:8,hungarian:8,japanese:12,chinese:12,uzbek:8,eastern:8,asian:62,european:38,caucasian:8};
  const facets=catalogSearch().cuisines;
  for(const [id] of cuisines) {
    const result=catalogSearch(new URLSearchParams({cuisine:id}));
    assert.equal(result.total,counts[id],id);
    assert.equal(facets.find(f=>f.id===id).count,result.total,id);
    assert.ok(result.recipes.every(r=>r.categories.includes(id)),id);
    const additions=catalog.filter(r=>r.cuisines.includes(id));
    if(additions.length) {
      assert.ok(new Set(additions.map(r=>r.method)).size>=2, id);
      assert.ok(new Set(additions.map(r=>r.mainIngredients.join(','))).size>=3,id);
    }
  }
});

test('new dishes are distinct, explicitly sourced and have complete measurable recipes',()=>{
  assert.equal(catalog.length,90);
  const known=new Set(cuisines.map(([id])=>id));
  const signatures=new Set();
  for(const recipe of SEED_RECIPES) {
    const signature=JSON.stringify(recipe.ingredients.map(({name,quantity,unit})=>[name,quantity,unit]).sort((a,b)=>a[0].localeCompare(b[0])));
    assert.ok(!signatures.has(signature),recipe.id); signatures.add(signature);
  }
  for(const raw of catalog) {
    const recipe=SEED_RECIPES.find(r=>r.id==='seed:'+raw.id);
    assert.ok(raw.cuisines.every(c=>known.has(c)),raw.id);
    assert.ok(raw.cuisines.length && !raw.cuisines.includes('everyday'),raw.id);
    assert.match(raw.sourceUrl,/^https:\/\//,raw.id);
    assert.ok(raw.description.length<=100 && raw.description.length>20,raw.id);
    assert.ok(!/\p{Extended_Pictographic}/u.test(JSON.stringify(raw)),raw.id);
    assert.ok(raw.timing.every(t=>Number.isInteger(t)&&t>0),raw.id);
    assert.ok(raw.steps.length>=4,raw.id);
    assert.equal(new Set(raw.ingredients.map(([name])=>name)).size,raw.ingredients.length,raw.id);
    assert.ok(raw.ingredients.every(([name,q,u])=>name && q>0 && ['г','мл','шт.'].includes(u)),raw.id);
    assert.ok(raw.mainIngredients.every(main=>raw.ingredients.some(([name])=>name.includes(main))),raw.id);
    assert.equal(recipe.thumbnailUrl,`/assets/dinner/${raw.id}.jpg`,raw.id);
    assert.equal(recipe.imageGenerated,true,raw.id);
    assert.deepEqual(recipeNutrition(recipe),recipe.nutrition,raw.id);
    assert.equal(recipe.nutrition.source,'calculated',raw.id);
    assert.equal(recipe.nutrition.basis,'serving',raw.id);
    assert.equal(recipe.nutrition.servings,recipe.servings,raw.id);
    const {calories,protein,fat,carbs}=recipe.nutrition;
    assert.ok(calories>20 && calories<1400,raw.id);
    const energy=protein*4+fat*9+carbs*4;
    assert.ok(Math.abs(energy-calories)/calories<.2,raw.id);
    const web=catalogRecipe(raw.id);
    assert.deepEqual(web.ingredients,recipe.ingredients.map(({name,quantity,unit})=>({name,quantity,unit})),raw.id);
    assert.deepEqual(web.categories.filter(c=>known.has(c)),raw.cuisines,raw.id);
  }
});

test('regional meat, poultry, fish and dough recipes specify safe doneness',()=>{
  for(const raw of catalog) {
    const names=raw.ingredients.map(([name])=>name).join(' '), text=raw.steps.join(' ');
    if(/курин/u.test(names)) assert.match(text,/74 °C/,raw.id);
    else if(/фарш/u.test(names)) assert.match(text,/71 °C/,raw.id);
    else if(/для тушения|свиная лопатка/u.test(names)) assert.match(text,/легко разделяться вилкой/,raw.id);
    else if(/говядина|свиная вырезка/u.test(names)) assert.match(text,/63 °C.*3 минуты/,raw.id);
    if(/треск|лосос/u.test(names)) assert.match(text,/63 °C/,raw.id);
  }
});

test('regional filters compose with products, exclusions, time and later-page details',()=>{
  for(const [id] of cuisines) for(const recipe of catalogSearch(new URLSearchParams({cuisine:id,exclude:'молоко,глютен',time:'45'})).recipes) {
    assert.ok(recipe.minutes<=45);
    assert.ok(!hasExcludedIngredient(catalogRecipe(recipe.id),['молоко','глютен']),recipe.id);
  }
  const fish=catalogSearch(new URLSearchParams({cuisine:'chinese',include:'рыба',exclude:'курица'}));
  assert.ok(fish.recipes.some(r=>r.id==='cn-steamed-fish'));
  assert.equal(catalogRecipe('cn-steamed-fish').servings,3);
  assert.equal(catalogSearch(new URLSearchParams({page:'14'})).recipes.length,24);
  assert.ok(catalogSearch(new URLSearchParams({q:'райта'})).recipes.some(r=>r.id==='in-cucumber-raita'));
  const soups=catalogSearch(new URLSearchParams({cuisine:'greek',category:'soup'}));
  assert.deepEqual(new Set(soups.recipes.map(r=>r.id)),new Set(['gr-fasolada','gr-fakes']));
  assert.ok(catalogSearch(new URLSearchParams({cuisine:'russian',category:'salad'})).recipes.some(r=>r.id==='ru-vinegret'));
});
