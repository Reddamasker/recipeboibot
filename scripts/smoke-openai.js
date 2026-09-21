import { normalizeRecipe } from '../src/openai.js';

const result = await normalizeRecipe({ userId: null, sourceName: 'smoke-test', text: 'Омлет. Ингредиенты: 2 яйца, щепотка соли. Взбить яйца с солью и обжарить на сковороде.' });
if (!result.title || result.ingredients.length < 1 || result.steps.length < 1) throw new Error('Smoke test returned an incomplete recipe');
console.log(JSON.stringify({ ok: true, title: result.title, ingredients: result.ingredients.length, steps: result.steps.length }));
