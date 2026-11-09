import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogDaily, catalogRecipe, catalogSearch } from '../src/web-catalog.js';

test('daily recipe changes exactly at Moscow midnight, independent of input timezone', () => {
  const before = catalogDaily(new Date('2026-11-09T20:59:59.999Z'));
  const after = catalogDaily(new Date('2026-11-09T21:00:00.000Z'));
  assert.equal(before.date, '2026-11-09');
  assert.equal(before.nextChangeAt, '2026-11-09T21:00:00.000Z');
  assert.equal(after.date, '2026-11-10');
  assert.equal(after.timeZone, 'Europe/Moscow');
  assert.notEqual(before.recipe.id, after.recipe.id);
  for (const date of ['2026-11-09T00:00:00+03:00', '2026-11-09T06:00:00+09:00', '2026-11-09T23:59:59+03:00']) {
    assert.equal(catalogDaily(new Date(date)).recipe.id, before.recipe.id);
  }
  assert.throws(() => catalogDaily(new Date('invalid')), RangeError);
});

test('a complete daily cycle visits every catalog recipe once, including later pages', () => {
  const total = catalogSearch().catalogTotal, ids = new Set(), start = Date.parse('2026-01-01T00:00:00+03:00');
  for (let day = 0; day < total; day++) {
    const { recipe } = catalogDaily(new Date(start + day * 86400000));
    assert.ok(catalogRecipe(recipe.id));
    assert.equal(recipe.title, catalogRecipe(recipe.id).title);
    assert.ok(recipe.ingredientCount > 0);
    assert.equal(recipe.ingredients, undefined);
    assert.equal(recipe.steps, undefined);
    assert.ok(!ids.has(recipe.id), 'No repeat before completing the cycle');
    ids.add(recipe.id);
  }
  assert.equal(ids.size, total);
  assert.equal(catalogDaily(new Date(start)).recipe.id, catalogDaily(new Date(start + total * 86400000)).recipe.id);
  for (let page = 1; page <= catalogSearch().pages; page++) {
    for (const recipe of catalogSearch(new URLSearchParams({page})).recipes) assert.ok(ids.has(recipe.id));
  }
});

test('daily dates and expiry stay correct across month, year and leap-day boundaries', () => {
  for (const [date, next] of [['2026-12-31','2027-01-01'], ['2028-02-28','2028-02-29'], ['2028-02-29','2028-03-01']]) {
    const a = catalogDaily(new Date(date + 'T23:59:59+03:00'));
    const b = catalogDaily(new Date(a.nextChangeAt));
    assert.equal(a.date, date); assert.equal(b.date, next);
    assert.notEqual(a.recipe.id, b.recipe.id);
  }
});
