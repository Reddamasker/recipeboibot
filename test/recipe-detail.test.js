import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { catalogRecipe } from '../src/web-catalog.js';
import { SEED_RECIPES } from '../src/dinner.js';

function component() {
  const context = {};
  vm.runInNewContext(fs.readFileSync('public/recipe-detail.js', 'utf8'), context);
  return context.RecipeDetail;
}

test('catalogue and Mini App preserve the same ingredient details, steps and nutrition in the shared view', () => {
  const view = component();
  for (const seed of SEED_RECIPES) {
    const recipe = catalogRecipe(seed.id.slice(5));
    assert.ok(recipe, seed.id);
    assert.equal(view.ingredients(recipe), view.ingredients(seed), seed.id);
    const mini = view.render(seed), web = view.render({ ...recipe, thumbnailUrl: recipe.image, totalMinutes: recipe.minutes });
    const steps = html => html.match(/<div class="step-list">[\s\S]*?<\/section>/)[0];
    assert.equal(steps(web), steps(mini), seed.id);
    assert.deepEqual(recipe.nutrition, seed.nutrition);
    assert.deepEqual(recipe.tags, seed.tags);
    assert.ok(web.includes(`>${recipe.ingredients.length}</strong><span>ингредиентов`));
  }
});

test('portion scaling keeps unknown quantities unknown, retains zero and checkbox selection without changing recipe data', () => {
  const view = component();
  const recipe = { servings: 2, ingredients: [{ name: 'Мука', quantity: 125, unit: 'г' }, { name: 'Масло', quantity: 0, unit: 'г' }, { name: 'Соль', comment: 'по вкусу' }, { name: 'Вода' }] };
  const before = JSON.stringify(recipe);
  const html = view.ingredients(recipe, { servings: 3, checkable: true, checked: new Set(['0']) });
  assert.match(html, /187,5 г/);
  assert.match(html, />0 г</);
  assert.match(html, /amount-empty">по вкусу/);
  assert.match(html, /количество не указано/);
  assert.match(html, /value="0" checked/);
  assert.doesNotMatch(html, /NaN|undefined|null/);
  assert.equal(JSON.stringify(recipe), before);
});

test('shared recipe escapes content, excludes unsafe URLs and distinguishes unknown time from zero', () => {
  const view = component();
  const recipe = { title: '<img onerror=alert(1)>', description: '<script>x</script>', thumbnailUrl: 'javascript:alert(1)', sourceUrl: 'javascript:alert(1)', notes: '<b>note</b>', tags: ['" onclick="alert(1)'], ingredients: [{ name: '<svg onload=x>', comment: '<iframe>' }], steps: ['<script>step</script>'], warnings: ['<script>warning</script>'] };
  const html = view.render(recipe, { interactiveTags: true });
  assert.doesNotMatch(html, /<script|<svg|<iframe|javascript:|" onclick="/);
  assert.match(html, /&lt;script&gt;step/);
  assert.match(html, /полное время не указано/);
  assert.match(view.render({ ...recipe, totalMinutes: 0 }), />0<\/strong><span>минут/);
});

test('all three entry documents load the shared renderer before their host and use one stylesheet', () => {
  for (const [name, host] of [['index','app'],['catalog','catalog'],['catalog-legacy','catalog-legacy']]) {
    const html = fs.readFileSync(`public/${name}.html`, 'utf8');
    assert.ok(html.indexOf('/recipe-detail.js?') < html.indexOf(`/${host}.js?`));
    assert.match(html, /href="\/recipe-detail\.css\?/);
  }
});
