import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
const file = `data/photo-extraction-${randomUUID()}.sqlite`;
Object.assign(process.env, { DATABASE_PATH: file, OPENAI_API_KEY: 'test', OPENAI_TEXT_MODEL: 'test-model', OPENAI_HTTPS_PROXY: '', TELEGRAM_POLLING: 'false', BOT_PLATFORM: 'telegram', TEST_CONTOUR: 'false', DINNER_IMAGES_ENABLED: 'false' });
const { db, upsertTelegramUser, createRecipe, updateRecipe, createRecipeShare, getSharedRecipe } = await import('../src/db.js');
const { normalizeRecipe } = await import('../src/openai.js');
const { importText } = await import('../src/importer.js');
const { productOperation, productReport } = await import('../src/product-analytics.js');
const { hasCompleteCookingTime, totalMinutes } = await import('../src/recipe-time.js');
const { matchesObjectiveMealRequest, parseMealRequest } = await import('../src/meal-request.js');
const { photoDetailImages } = await import('../src/photo-detail.js');
let serial = 957000;
const user = () => upsertTelegramUser({ id: serial++, first_name: 'Photo test' });
const image = { buffer: Buffer.from('image-fixture'), mime: 'image/jpeg' };
const complete = () => ({ sourceText: '6 порций, 50 минут. Кабачок — 1 шт. Нарезать и запечь.', title: 'Овощи', description: '', servings: 6, prepMinutes: null, cookMinutes: null, totalMinutes: 50,
  ingredients: [{ raw: 'Кабачок — 1 шт.', name: 'Кабачок', quantity: 1, unit: 'шт.', comment: null, confidence: 0.99 }],
  steps: [{ position: 1, text: 'Нарезать и запечь.', confidence: 0.99 }], warnings: [], tags: [], sourceName: null,
  nutrition: { calories: 100, protein: 3, fat: 5, carbs: 10, basis: 'serving', source: 'calculated', servings: 6, weightGrams: null, assumptions: [] } });
const incomplete = () => ({ ...complete(), ingredients: complete().ingredients.map(i => ({ ...i, quantity: null, unit: null, confidence: 0.4 })), steps: [] });
async function provider(results, fn) {
  const original = globalThis.fetch, calls = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body); calls.push(body);
    const result = results[Math.min(calls.length - 1, results.length - 1)];
    if (result instanceof Error) throw result;
    return Response.json({ status: 'completed', model: 'test-model', output_text: JSON.stringify(result), usage: { input_tokens: 10, output_tokens: 20 } });
  };
  try { return await fn(calls); } finally { globalThis.fetch = original; }
}
test.after(() => { db.close(); for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true }); });

test('photo reads original bytes at high detail and preserves a total without invented breakdown', async () => {
  await provider([complete()], async calls => {
    const recipe = await normalizeRecipe({ image });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].input[0].content[1], { type: 'input_image', detail: 'high', image_url: 'data:image/jpeg;base64,' + image.buffer.toString('base64') });
    assert.equal(recipe.servings, 6); assert.equal(recipe.totalMinutes, 50); assert.equal(recipe.prepMinutes, null); assert.equal(recipe.cookMinutes, null);
    assert.equal(recipe.sourceText, undefined);
    assert.ok(calls[0].text.format.schema.required.includes('totalMinutes'));
  });
});

test('overlapping photo details cover every edge; failed rendering falls back without partial tiles', async () => {
  const source = { buffer: Buffer.alloc(4096), mime: 'image/jpeg' }, areas = [];
  const parts = await photoDetailImages(source, async (buffer, x, y) => { assert.equal(buffer, source.buffer); areas.push([x, y]); return image; });
  assert.equal(parts.length, 4);
  for (const [x, y] of [[0, 0], [0.99, 0], [0, 0.99], [0.99, 0.99], [0.5, 0.5]]) assert.ok(areas.some(([left, top]) => x >= left && x <= left + 0.6 && y >= top && y <= top + 0.6));
  let calls = 0;
  assert.deepEqual(await photoDetailImages(source, async () => { if (++calls === 2) throw Error('decoder unavailable'); return image; }), []);
  assert.equal(calls, 2);
  assert.deepEqual(await photoDetailImages(image, assert.fail), []);
});

test('incomplete photo retries once within one import and deduplicates later submission', async () => {
  const u = user();
  await provider([incomplete(), complete()], async calls => {
    const result = await importText(u.id, '', { image, sourceType: 'image' });
    assert.equal(result.state, 'created'); assert.equal(calls.length, 2);
    assert.match(calls[1].instructions, /Повторная проверка/);
    assert.equal(calls[1].input[0].content[1].detail, 'high');
    assert.equal((await importText(u.id, '', { image, sourceType: 'image' })).state, 'existing');
    assert.equal(calls.length, 2);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM import_jobs WHERE user_id=?').get(u.id).n, 1);
    assert.deepEqual(productReport([u]).imports, { ready: 1 });
  });
});

test('unreadable photo never becomes ready; failure, wait and explicit retry keep one job', async () => {
  const u = user();
  await provider([incomplete()], async calls => {
    await assert.rejects(productOperation('import', () => importText(u.id, '', { image, sourceType: 'image' }), { userId: u.id }), error => error.status === 422 && error.code === 'RECIPE_EXTRACTION_INCOMPLETE');
    assert.equal(calls.length, 2); assert.equal(db.prepare('SELECT COUNT(*) n FROM recipes WHERE user_id=?').get(u.id).n, 0);
    const report = productReport([u]); assert.deepEqual(report.imports, { failed: 1 });
    const step = report.steps.find(s => s.step === 'import'); assert.equal(step.operations, 1); assert.equal(step.errors, 1);
    const event = db.prepare("SELECT duration_ms,detail_json FROM product_events WHERE user_id=? AND event='operation_finished'").get(u.id);
    assert.ok(event.duration_ms >= 0); assert.equal(JSON.parse(event.detail_json).status, 422);
    assert.ok(!JSON.stringify(report).includes('Кабачок'));
    assert.deepEqual(productReport([]).imports, {});
  });
  await provider([complete()], async () => { await importText(u.id, '', { image, sourceType: 'image' }); });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM import_jobs WHERE user_id=?').get(u.id).n, 1);
  assert.deepEqual(productReport([u]).imports, { ready: 1 });
});

test('low confidence in a step retries, but a genuinely unspecified quantity does not', async () => {
  const poor = complete(); poor.steps[0].confidence = 0.4;
  await provider([poor, complete()], async calls => { await normalizeRecipe({ image }); assert.equal(calls.length, 2); });
  const qualitative = complete(); qualitative.ingredients[0] = { raw: 'Соль по вкусу', name: 'Соль', quantity: null, unit: null, confidence: 1 };
  await provider([qualitative], async calls => { const result = await normalizeRecipe({ image }); assert.equal(calls.length, 1); assert.equal(result.ingredients[0].quantity, null); });
});

test('provider failures are not multiplied and text-only partial imports keep their existing contract', async () => {
  await provider([new TypeError('offline')], async calls => { await assert.rejects(normalizeRecipe({ image }), e => e.status === 502); assert.equal(calls.length, 1); });
  await provider([incomplete()], async calls => { await normalizeRecipe({ text: 'Исходный список продуктов' }); assert.equal(calls.length, 1); });
});

test('stated total survives saving, sharing and note editing and participates in time limits', () => {
  const u = user(), recipe = createRecipe(u.id, { ...complete(), status: 'ready' });
  assert.equal(recipe.totalMinutes, 50); assert.equal(hasCompleteCookingTime(recipe), true); assert.equal(totalMinutes(recipe), 50);
  assert.equal(getSharedRecipe(createRecipeShare(u.id, recipe.id)).totalMinutes, 50);
  assert.equal(updateRecipe(u.id, recipe.id, { notes: 'Заметка' }).totalMinutes, 50);
  assert.equal(matchesObjectiveMealRequest(recipe, parseMealRequest('до 40 минут')), false);
  assert.equal(matchesObjectiveMealRequest(recipe, parseMealRequest('до 60 минут')), true);
  assert.equal(updateRecipe(u.id, recipe.id, { prepMinutes: 5, cookMinutes: 20 }).totalMinutes, null);
});

test('ingredient UI distinguishes missing amounts, literal to taste, numeric zero and known quantity', () => {
  const source = fs.readFileSync('public/app.js', 'utf8');
  const start = source.indexOf('  const ingredients = (r.ingredients || []).map');
  const code = source.slice(start, source.indexOf('\n  const steps =', start));
  const render = item => vm.runInNewContext(code + '\ningredients', { r: { ingredients: [item] }, esc: String });
  assert.match(render({ name: 'Баклажан', quantity: null, unit: null }), /количество не указано/);
  assert.doesNotMatch(render({ name: 'Баклажан' }), /undefined|по вкусу/);
  assert.match(render({ name: 'Соль', raw: 'Соль — по вкусу' }), /amount-empty">по вкусу/);
  assert.match(render({ name: 'Масло', quantity: 0, unit: 'г' }), />0 г</);
  assert.match(render({ name: 'Чеснок', quantity: 3, unit: 'зубчика' }), />3 зубчика</);
});
