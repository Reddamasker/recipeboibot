import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const shell = fs.readFileSync(new URL('../public/review/recime-20261109/shell.js', import.meta.url), 'utf8');
const core = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
function section(source, start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `Executable source section missing: ${start}`);
  return source.slice(from, to);
}
const plain = value => JSON.parse(JSON.stringify(value));
const esc = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');

test('workspace selectors exclude locked previews and drafts while retaining saved public recipes', () => {
  const state = { recipes: [
    { id: 'preview', status: 'ready', previewOnly: true },
    { id: 'public', status: 'ready', publicCatalogSaved: true },
    { id: 'personal', status: 'ready' },
    { id: 'draft', status: 'draft' },
  ] };
  const ids = vm.runInNewContext(section(shell, '  const readyRecipes=', '  const validServings=') + 'readyRecipes().map(recipe => recipe.id)', { state });
  assert.deepEqual(plain(ids), ['public', 'personal']);
});

function contentHarness() {
  const state = { recipes: [
    { id: 'pasta', title: 'Паста с томатами', status: 'ready', tags: ['Быстро'], ingredients: [{ name: 'Базилик' }] },
    { id: 'soup', title: 'Овощной суп', status: 'ready', tags: ['Обед'], ingredients: [{ name: 'Морковь' }] },
    { id: 'draft', title: 'Черновик', status: 'draft', tags: [], ingredients: [] },
  ] };
  const ui = { tab: 'books', book: null, query: '', sort: false,
    workspace: { collections: [], groceries: { items: [], sources: [] } } };
  const forms = [], choices = [], notices = [], markup = [];
  const sandbox = { state, ui, esc, base: '/review/recime-20261109/',
    readyRecipes: () => state.recipes.filter(recipe => recipe.status === 'ready'),
    safeImage: () => '', ico: () => '', cookingTimeLabel: () => '20 мин',
    num: (n, forms) => `${n} ${forms[0]}`, title: text => `<h1>${text}</h1>`,
    recipesPage() {}, workspaceStarted() {}, workspaceNotice: () => '',
    setMarkup: html => markup.push(html),
    note: (...args) => notices.push(args),
    formDialog: form => { forms.push(form); return form; },
    choiceDialog: (title, items) => choices.push({ title, items }),
  };
  vm.createContext(sandbox);
  for (const code of [
    section(shell, '  function recipeChecklist(', '  function planForm('),
    section(shell, '  function sourceChoices(', '  function itemChoices('),
    section(shell, '  function books(', '  function recipesPage('),
    section(shell, '  function groceries(){', '  const chips='),
  ]) vm.runInContext(code, sandbox);
  return { ...sandbox, forms, choices, notices, markup, state, ui };
}

test('search from the books tab finds personal recipe titles, ingredients and tags, with a real empty result', () => {
  const h = contentHarness();
  for (const query of ['ПАСТА', 'базилик', 'быстро']) {
    h.ui.query = query;
    const html = h.libraryItems();
    assert.match(html, /data-recipe-id="pasta"/);
    assert.doesNotMatch(html, /data-recipe-id="soup"/);
    assert.doesNotMatch(html, /data-review="book"/);
  }
  h.ui.query = 'несуществующее блюдо';
  assert.match(h.libraryItems(), /Ничего не найдено/);
  h.ui.query = '';
  assert.match(h.libraryItems(), /Без подборки/);
  assert.match(h.libraryItems(), /data-review="new-book"/);
});

test('search inside one selected collection does not return recipes from other collections', () => {
  const h = contentHarness();
  h.ui.workspace.collections = [{ id: 'lunch', name: 'Обеды', recipeIds: ['soup'] }];
  h.ui.book = 'lunch'; h.ui.query = 'паста';
  assert.match(h.libraryItems(), /Ничего не найдено/);
  h.ui.query = 'морковь';
  assert.match(h.libraryItems(), /data-recipe-id="soup"/);
  assert.doesNotMatch(h.libraryItems(), /data-recipe-id="pasta"/);
});

test('creating the first collection from a recipe preselects that recipe and submits actual checkbox choices', () => {
  const h = contentHarness();
  h.recipeMemberships(h.state.recipes[0]);
  const form = h.forms.at(-1);
  assert.equal(form.action, 'collections.create');
  const tags = [...form.body.matchAll(/<input\b[^>]*name="recipeIds"[^>]*>/g)].map(match => match[0]);
  const selected = tags.filter(tag => /\schecked(?:\s|>)/.test(tag)).map(tag => tag.match(/value="([^"]+)"/)[1]);
  assert.deepEqual(selected, ['pasta']);
  assert.equal(tags.length, 2, 'drafts are not selectable membership records');
  const fields = form.read({
    querySelector: selector => { assert.equal(selector, '[name=name]'); return { value: '  Ужины  ' }; },
    querySelectorAll: selector => { assert.equal(selector, '[name=recipeIds]:checked'); return selected.map(value => ({ value })); },
  });
  assert.deepEqual(plain(fields), { name: 'Ужины', recipeIds: ['pasta'] });
});

test('membership changes preserve other recipes, and renaming never submits replacement memberships', () => {
  const h = contentHarness(), book = { id: 'lunch', name: 'Обеды', recipeIds: ['soup'] };
  h.ui.workspace.collections = [book];
  h.recipeMemberships(h.state.recipes[0]); h.choices.at(-1).items[0].run();
  assert.equal(h.forms.at(-1).action, 'collections.setRecipes');
  assert.deepEqual(plain(h.forms.at(-1).read()), { collectionId: 'lunch', recipeIds: ['soup', 'pasta'] });
  h.collectionForm(book);
  assert.equal(h.forms.at(-1).action, 'collections.rename');
  assert.deepEqual(plain(h.forms.at(-1).read({ querySelector: () => ({ value: 'Новое имя' }) })), { collectionId: 'lunch', name: 'Новое имя' });
});

test('empty groceries retain accessible source management, while an entirely new list has no orphan controls', () => {
  const h = contentHarness();
  h.ui.workspace.groceries.sources = [{ id: 'recipe:pasta', title: 'Паста', excludedCount: 3 }];
  h.groceries();
  assert.match(h.markup.at(-1), /Пока нет продуктов/);
  assert.match(h.markup.at(-1), /data-review="shopping-sources"/);
  assert.doesNotMatch(h.markup.at(-1), /data-review="clear-checked"/);
  h.ui.workspace.groceries.sources = []; h.groceries();
  assert.doesNotMatch(h.markup.at(-1), /data-review="shopping-sources"/);
  assert.match(h.markup.at(-1), /data-review="shopping-add"/);
});

test('source restore submits an explicit scoped flag, ordinary refresh keeps exclusions, and unavailable recipes cannot restore', () => {
  for (const kind of ['recipe', 'plan']) {
    const h = contentHarness(), source = { id: `${kind}:source`, kind, title: 'Паста', recipeId: 'pasta', planEntryId: 'entry',
      servings: null, excludedCount: 2, recipeAvailable: true };
    h.ui.workspace.groceries.sources = [source];
    h.sourceChoices(); h.choices.at(-1).items[0].run();
    let menu = h.choices.at(-1);
    menu.items.find(item => item.label === 'Вернуть убранные продукты').run();
    const form = h.forms.at(-1), fields = kind === 'plan' ? { entryIds: ['entry'] } : { recipeId: 'pasta', servings: null };
    assert.equal(form.action, kind === 'plan' ? 'groceries.fromPlan' : 'groceries.fromRecipe');
    assert.deepEqual(plain(form.read()), { ...fields, restoreExcluded: true });
    menu.items.find(item => item.label === 'Обновить продукты').run();
    assert.deepEqual(plain(h.forms.at(-1).read()), fields);
    source.recipeAvailable = false;
    h.sourceChoices(); h.choices.at(-1).items[0].run(); menu = h.choices.at(-1);
    assert.equal(menu.items.some(item => item.label === 'Вернуть убранные продукты'), false);
    assert.equal(menu.items.find(item => item.label === 'Обновить продукты').disabled, true);
    menu.items.find(item => item.label === 'Убрать продукты этого блюда').run();
    assert.deepEqual(plain(h.forms.at(-1).read()), { sourceId: source.id });
  }
});

function routeHarness(view, directRecipe = false) {
  let address = new URL(`https://fixture.test/review/recime-20261109/index.html?view=${view}&v=workspace-3${directRecipe ? '&recipe=pasta' : ''}`);
  const entries = [{ url: address.href, state: {} }], screens = [], details = [], listeners = {};
  let index = 0, pendingNavigation = Promise.resolve(), overlay = false;
  const location = { get href() { return address.href; }, get search() { return address.search; } };
  const navigate = delta => {
    index += delta; address = new URL(entries[index].url);
    pendingNavigation = Promise.resolve(listeners.popstate({ state: entries[index].state }));
  };
  const history = { get state() { return entries[index].state; },
    pushState(state, unused, url) { entries.splice(index + 1); entries.push({ state, url: String(url) }); index++; address = new URL(url); },
    replaceState(state, unused, url) { entries[index] = { state, url: String(url) }; address = new URL(url); },
    back: () => navigate(-1), forward: () => navigate(1),
  };
  const sandbox = { URL, URLSearchParams, location, history, requestRecorder: null, scrollY: 120,
    state: { payment: null }, ui: { detailRevision: 0 }, modalStack: [], pendingRouteFocus: null,
    planner: () => screens.push('meal-plan'), groceries: () => screens.push('groceries'), discover: () => screens.push('discover'),
    oldRender: () => screens.push('core'), root: { classList: { remove() {} } },
    closeOverlay: () => { overlay = false; }, api: async () => ({ id: 'pasta' }),
    recipeDetail: recipe => { overlay = true; details.push(recipe.id); },
    tg: { initData: 'fixture' }, window: { addEventListener: (name, handler) => { listeners[name] = handler; } },
    requestAnimationFrame: callback => callback(), scrollTo() {}, restoreModalFocus() {},
    toast: message => assert.fail(`Unexpected route error: ${message}`),
  };
  vm.createContext(sandbox);
  for (const code of [
    section(core, 'function setRoute(', 'const trialGuideKey'),
    section(core, 'let recipeOpenRevision = 0;', 'async function waitForRecipeImage('),
    section(shell, '  render=async function(){', "  root.addEventListener('click'"),
    section(core, "window.addEventListener('popstate'", 'if (globalThis.window?.RecipeAnalytics'),
  ]) vm.runInContext(code, sandbox);
  return { ...sandbox, screens, details, entries, flush: () => pendingNavigation, hasOverlay: () => overlay };
}

test('custom-tab recipe navigation reopens on history forward without pushing another route and closes back cleanly', async () => {
  for (const view of ['meal-plan', 'groceries', 'discover']) {
    const h = routeHarness(view);
    await h.render(); await h.openRecipe('pasta', true);
    assert.equal(h.entries.length, 2); assert.equal(h.hasOverlay(), true);
    h.closeDetailRoute(); await h.flush();
    assert.equal(h.hasOverlay(), false); assert.equal(new URL(h.location.href).searchParams.get('recipe'), null);
    assert.equal(h.screens.at(-1), view);
    h.history.forward(); await h.flush();
    assert.equal(h.hasOverlay(), true); assert.equal(h.details.length, 2);
    assert.equal(h.entries.length, 2, 'restoring a route must open with pushRoute=false');
    h.closeDetailRoute(); await h.flush();
    assert.equal(h.hasOverlay(), false); assert.equal(h.screens.at(-1), view);
    assert.equal(new URL(h.location.href).searchParams.get('recipe'), null);
  }
});

test('direct custom-tab recipe links restore on reload and close without leaving a recipe query or losing the current section', async () => {
  for (const view of ['meal-plan', 'groceries', 'discover']) {
    const h = routeHarness(view, true);
    await h.render(); assert.equal(h.hasOverlay(), true); assert.equal(h.entries.length, 1);
    h.closeDetailRoute(); await h.flush();
    const params = new URL(h.location.href).searchParams;
    assert.equal(h.hasOverlay(), false); assert.equal(params.get('recipe'), null);
    assert.equal(params.get('view'), view); assert.equal(params.get('v'), 'workspace-3');
    await h.render(); assert.equal(h.details.length, 1, 'closed detail must not reappear on render');
  }
});
