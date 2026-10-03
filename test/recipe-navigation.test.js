import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function fixture(search = '?view=collection') {
  const source = fs.readFileSync('public/app.js', 'utf8');
  const handler = source.slice(source.indexOf('let recipeOpenRevision ='), source.indexOf('async function waitForRecipeImage('));
  const entries = [{ search, state: {} }], requests = [], dialogs = [], errors = [];
  const location = { search, href: `https://example.test/${search}` };
  const navigate = entry => { location.search = entry.search; location.href = `https://example.test/${entry.search}`; };
  const history = {
    get state() { return entries.at(-1).state; },
    back() { entries.pop(); navigate(entries.at(-1)); },
    replaceState(state, unused, url) { entries[entries.length - 1] = { state, search: url.search }; navigate(entries.at(-1)); },
  };
  const sandbox = {
    location, history, URL, URLSearchParams, scrollY: 120, state: {}, modalStack: [], pendingRouteFocus: null,
    setRoute(params, options) { entries.push({ search: '?' + new URLSearchParams(params), state: options.historyState }); navigate(entries.at(-1)); },
    closeOverlay() { dialogs.length = 0; },
    api(path) { return new Promise((resolve, reject) => requests.push({ path, resolve, reject })); },
    recipeDetail(recipe) { dialogs.push(recipe.id); }, toast(message) { errors.push(message); },
  };
  vm.runInNewContext(handler, sandbox);
  return { sandbox, requests, dialogs, entries, location, errors };
}

test('repeated recipe taps create one history entry and one active dialog, so Back returns to the collection', async () => {
  const f = fixture();
  const first = f.sandbox.openRecipe('recipe-a', true);
  const second = f.sandbox.openRecipe('recipe-a', true);
  f.requests[1].resolve({ id: 'recipe-a' }); await second;
  f.requests[0].resolve({ id: 'recipe-a' }); await first;
  assert.equal(f.entries.length, 2);
  assert.deepEqual(f.dialogs, ['recipe-a']);
  f.sandbox.closeDetailRoute();
  assert.equal(f.location.search, '?view=collection');
  assert.deepEqual(f.dialogs, []);
});

test('Back during loading prevents a late recipe response from reopening the dialog', async () => {
  const f = fixture();
  const opened = f.sandbox.openRecipe('recipe-a', true);
  f.sandbox.closeDetailRoute();
  f.requests[0].resolve({ id: 'recipe-a' }); await opened;
  assert.equal(f.location.search, '?view=collection');
  assert.deepEqual(f.dialogs, []);
});

test('an older response cannot replace a newer recipe or show an obsolete error', async () => {
  const f = fixture();
  const old = f.sandbox.openRecipe('recipe-a', true);
  const current = f.sandbox.openRecipe('recipe-b', true);
  f.requests[1].resolve({ id: 'recipe-b' }); await current;
  f.requests[0].reject(new Error('old request failed')); await old;
  assert.deepEqual(f.dialogs, ['recipe-b']);
  assert.deepEqual(f.errors, []);
});

test('a direct recipe link opens without adding history and Back removes only the recipe parameter', async () => {
  const f = fixture('?view=collection&recipe=recipe-a');
  const opened = f.sandbox.openRecipe('recipe-a');
  f.requests[0].resolve({ id: 'recipe-a' }); await opened;
  assert.deepEqual(f.dialogs, ['recipe-a']);
  f.sandbox.closeDetailRoute();
  assert.equal(f.entries.length, 1);
  assert.equal(f.location.search, '?view=collection');
  assert.deepEqual(f.dialogs, []);
});
