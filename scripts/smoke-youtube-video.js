// Live diagnostic: provider usage is recorded without a user. No recipe is saved.
import { extractYoutubeRecipe } from '../src/youtube-recipe.js';

const url = process.argv[2] || 'https://youtube.com/shorts/wVHNa9EWDCU';
const started = Date.now();
const { source, recipe } = await extractYoutubeRecipe(url, { onPhase: phase => console.log(JSON.stringify({ phase })) });
if (!source.images?.length || !recipe.ingredients.length || !recipe.steps.length) throw new Error('Video recipe extraction incomplete');
console.log(JSON.stringify({ ok: true, elapsedMs: Date.now() - started, frames: source.images.length, sourceName: source.sourceName,
  recipe: { title: recipe.title, servings: recipe.servings, ingredients: recipe.ingredients, steps: recipe.steps, nutrition: recipe.nutrition, warnings: [...recipe.warnings, ...source.warnings] } }, null, 2));
