import { getRecipe, listGeneratedRecipesWithoutImages } from '../src/db.js';
import { ensureRecipeImage } from '../src/recipe-images.js';

for (const item of listGeneratedRecipesWithoutImages()) {
  const recipe = getRecipe(item.userId, item.id);
  const result = await ensureRecipeImage(item.userId, recipe);
  process.stdout.write(`${JSON.stringify({ id: item.id, title: recipe.title, generated: Boolean(result.thumbnailUrl) })}\n`);
}
