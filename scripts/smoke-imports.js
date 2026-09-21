// Isolated database, real provider calls. No production user data.
import fs from 'node:fs';
process.env.DATABASE_PATH = './data/import-smoke.sqlite';
const { upsertTelegramUser } = await import('../src/db.js');
const { importText, importUrl } = await import('../src/importer.js');
const user = upsertTelegramUser({ id: 999000002, first_name: 'Import smoke test' });
const image = await importText(user.id, '', { image: { buffer: fs.readFileSync('data/test-recipe.png'), mime: 'image/png' }, sourceType: 'image' });
if (!image.ingredients.length || !image.steps.length) throw new Error('Image extraction incomplete');
console.log(JSON.stringify({ operation: 'real_image_import', title: image.title, ingredients: image.ingredients.length, steps: image.steps.length }));
const recipe = await importUrl(user.id, 'https://www.bbcgoodfood.com/recipes/easy-pancakes');
if (!recipe.ingredients.length || !recipe.steps.length) throw new Error('URL extraction incomplete');
console.log(JSON.stringify({ operation: 'real_url_import', title: recipe.title, ingredients: recipe.ingredients.length, steps: recipe.steps.length, source: recipe.sourceUrl }));
