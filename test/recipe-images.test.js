import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const testDb = path.resolve('data', `recipe-images-${process.pid}.sqlite`);
process.env.DATABASE_PATH = testDb;
process.env.APP_URL = 'https://recipes.example.test';
process.env.OPENAI_API_KEY = 'test-key';
process.env.OPENAI_IMAGE_MODEL = 'test-image-model';

const database = await import('../src/db.js');
const images = await import('../src/recipe-images.js');
const { createServer } = await import('../src/server.js');

test.after(() => {
  database.db.close();
  for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(testDb + suffix); } catch {} }
});

test('each generated recipe gets its own image and archived images stop serving', async () => {
  const owner = database.upsertTelegramUser({ id: 7401, first_name: 'Автор' });
  const other = database.upsertTelegramUser({ id: 7402, first_name: 'Друг' });
  const first = database.createRecipe(owner.id, { title: 'Тыквенный суп', origin: 'generated', status: 'ready', ingredients: [{ name: 'тыква' }] });
  const second = database.createRecipe(owner.id, { title: 'Яблочный пирог', origin: 'generated', status: 'ready', ingredients: [{ name: 'яблоки' }] });
  const makeImage = async (_userId, recipe) => ({ mime: 'image/jpeg', bytes: Buffer.from(`image for ${recipe.title}`) });
  const [withFirstImage, withSecondImage] = await Promise.all([
    images.ensureRecipeImage(owner.id, first, { generate: makeImage }),
    images.ensureRecipeImage(owner.id, second, { generate: makeImage })
  ]);
  assert.notEqual(withFirstImage.thumbnailUrl, withSecondImage.thumbnailUrl);
  assert.match(withFirstImage.thumbnailUrl, new RegExp(`${first.id}$`));
  assert.deepEqual(Buffer.from(database.getRecipeImage(first.id).bytes), Buffer.from('image for Тыквенный суп'));
  assert.equal(database.saveRecipeImage(other.id, first.id, 'image/jpeg', Buffer.from('wrong owner')), null);

  const server = createServer().listen(0, '127.0.0.1');
  try {
    await new Promise((resolve) => server.once('listening', resolve));
    const url = `http://127.0.0.1:${server.address().port}/recipe-images/${first.id}`;
    const served = await fetch(url);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get('content-type'), 'image/jpeg');
    assert.equal(await served.text(), 'image for Тыквенный суп');
    database.archiveRecipe(owner.id, first.id);
    assert.equal((await fetch(url)).status, 404);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('image generation prompt describes the specific dish and records provider usage', async () => {
  const owner = database.upsertTelegramUser({ id: 7403, first_name: 'Повар' });
  const recipe = database.createRecipe(owner.id, { title: 'Грибной суп', origin: 'generated', status: 'ready', ingredients: [{ name: 'грибы' }, { name: 'лук' }] });
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (_url, options) => {
    request = JSON.parse(options.body);
    return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64') }], usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 } }), { status: 200, headers: { 'x-request-id': 'image-test' } });
  };
  try {
    const generated = await images.ensureRecipeImage(owner.id, recipe);
    assert.match(request.prompt, /Грибной суп/);
    assert.match(request.prompt, /грибы/);
    assert.equal(request.model, 'test-image-model');
    assert.equal(request.output_format, 'jpeg');
    assert.equal(generated.thumbnailUrl, `https://recipes.example.test/recipe-images/${recipe.id}`);
    assert.equal(database.db.prepare("SELECT total_units FROM provider_requests WHERE operation='recipe_image' ORDER BY created_at DESC LIMIT 1").get().total_units, 30);
  } finally { globalThis.fetch = originalFetch; }
});
