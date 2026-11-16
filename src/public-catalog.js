import { SEED_RECIPES } from './dinner-seeds.js';

// The authored catalog remains immutable. Reviewed additions are read from the
// local database replica; callers never read another user's collection.
let provider = () => [];
export function setPublicCatalogProvider(read) { provider = read; }
export function publicCatalogRecipes() { return [...SEED_RECIPES, ...provider()]; }
