import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import catalog from '../src/dinner-catalog.json' with { type: 'json' };
import { SEED_RECIPES } from '../src/dinner-seeds.js';
import { rankCandidates, hasExcludedIngredient } from '../src/dinner.js';

test('the 250-recipe catalog has unique identities, complete instructions and usable media references', () => {
  assert.equal(SEED_RECIPES.length, 250);
  assert.equal(new Set(SEED_RECIPES.map(r=>r.id)).size, 250);
  assert.equal(new Set(SEED_RECIPES.map(r=>r.title.toLocaleLowerCase('ru'))).size, 250);
  for (const recipe of SEED_RECIPES) {
    assert.ok(recipe.servings > 0 && Number.isInteger(recipe.servings), recipe.id);
    assert.ok(recipe.prepMinutes > 0 && recipe.cookMinutes > 0, recipe.id);
    assert.ok(recipe.ingredients.length >= 3, recipe.id);
    for (const ingredient of recipe.ingredients) {
      assert.ok(ingredient.name && ingredient.unit && ingredient.quantity > 0, recipe.id);
    }
    assert.ok(recipe.steps.length >= 4 && recipe.steps.every((s,i)=>s.position===i+1 && s.text.trim().length>0), recipe.id);
    assert.ok(recipe.nutrition && recipe.nutrition.calories > 0, recipe.id);
    assert.equal(recipe.thumbnailUrl, `/assets/dinner/${recipe.id.slice(5)}.jpg`, recipe.id);
    assert.equal(recipe.imageGenerated, true, recipe.id);
    assert.ok(fs.existsSync(path.join('public', recipe.thumbnailUrl)), recipe.id);
  }
});

test('every catalog dish has its own valid JPEG and new card images are compact', () => {
  const hashes = new Set();
  const newIds = new Set(catalog.map(recipe => `seed:${recipe.id}`));
  for (const recipe of SEED_RECIPES) {
    const bytes = fs.readFileSync(path.join('public', recipe.thumbnailUrl));
    assert.equal(bytes.readUInt16BE(0), 0xffd8, recipe.id);
    assert.equal(bytes.readUInt16BE(bytes.length - 2), 0xffd9, recipe.id);
    const hash = createHash('sha256').update(bytes).digest('hex');
    assert.ok(!hashes.has(hash), `reused photo: ${recipe.id}`);
    hashes.add(hash);
    if (newIds.has(recipe.id)) assert.ok(bytes.length < 250_000, `oversized card image: ${recipe.id}`);
  }
});

test('the expansion contains explicit recipes rather than duplicate ingredient lists or renamed dishes', () => {
  const signatures = new Set();
  for (const recipe of catalog) {
    assert.ok(recipe.discovery && recipe.discovery.length <= 100, recipe.id);
    assert.ok(!/\p{Extended_Pictographic}/u.test(JSON.stringify(recipe)), recipe.id);
    assert.equal(new Set(recipe.ingredients.map(([name])=>name)).size, recipe.ingredients.length, recipe.id);
    assert.ok(recipe.mainIngredients.every(main=>recipe.ingredients.some(([name])=>name.includes(main))), recipe.id);
    const signature = JSON.stringify(recipe.ingredients.slice().sort((a,b)=>a[0].localeCompare(b[0])));
    assert.ok(!signatures.has(signature), `duplicate composition: ${recipe.id}`);
    signatures.add(signature);
  }
});

test('every everyday pantry base gains multiple usable choices without weakening exclusions', () => {
  const newIds = new Set(catalog.map(r=>'seed:'+r.id));
  const additions = SEED_RECIPES.filter(r=>newIds.has(r.id));
  for (const pantry of ['курица','говядина','свинина','картошка','рис','гречка']) {
    const candidates = rankCandidates(additions, { pantry:[pantry], profile:{preferredMaxCookingTime:90,excludedIngredients:['молоко','яйца','глютен']} });
    assert.ok(candidates.length >= 3, `${pantry}: only ${candidates.length} candidates`);
    assert.ok(candidates.every(c=>c.pantryMatch.missing.length<=5 && c.pantryMatch.missingMainIngredients.length===0), pantry);
    assert.ok(candidates.every(c=>!hasExcludedIngredient(c.recipe,['молоко','яйца','глютен'])), pantry);
  }
});

test('new meat recipes distinguish poultry, ground meat and whole cuts in doneness instructions', () => {
  for (const recipe of catalog) {
    const names=recipe.ingredients.map(([name])=>name).join(' ');
    const text=recipe.steps.join(' ');
    if (/курин|индейк/u.test(names)) assert.match(text,/74 °C/,recipe.id);
    else if (/фарш/u.test(names)) assert.match(text,/71 °C/,recipe.id);
    else if (/говядина для тушения|свиная лопатка/u.test(names)) assert.match(text,/легко разделяться вилкой/,recipe.id);
    else if (/говядина|свиная вырезка/u.test(names)) assert.match(text,/63 °C.*3 минуты/,recipe.id);
  }
});
