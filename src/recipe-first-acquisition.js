import { config } from './config.js';

export const RECIPE_FIRST_PLACEMENT = 'ya-recipe-first-202610';
export const RECIPE_FIRST_NAME = 'Яндекс — сначала рецепт на сайте, октябрь 2026';

export function recipeFirstAdvertisingLink() {
  const url = new URL('/dinner', config.appUrl);
  url.searchParams.set('campaign', RECIPE_FIRST_PLACEMENT);
  return url.href;
}
