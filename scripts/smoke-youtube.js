// One real AI request, counted in database usage.
// Does not add test recipes to any user's library.
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const { extractYoutubeSource } = await import(pathToFileURL(path.resolve('src/youtube.js')));
const { normalizeRecipe } = await import(pathToFileURL(path.resolve('src/openai.js')));
const { db } = await import(pathToFileURL(path.resolve('src/db.js')));
try {
  const source = await extractYoutubeSource('https://youtu.be/79aqvX4RnEU');
  const recipe = await normalizeRecipe({ userId: null, text: source.text, sourceName: source.sourceName });
  if (!recipe.ingredients.length || !recipe.steps.length) throw new Error('Incomplete recipe extraction');
  console.log(JSON.stringify({ ok: true, url: source.url, title: recipe.title, ingredients: recipe.ingredients, steps: recipe.steps, warnings: [...recipe.warnings, ...source.warnings] }, null, 2));
} finally { db.close(); }
