const tg = window.Telegram?.WebApp;
const root = document.querySelector('#app');
const toastEl = document.querySelector('#toast');
const state = { me: null, recipes: [], jobs: [], query: '', tab: 'text', cookStep: 0, scrollY: 0 };

tg?.ready(); tg?.expand();
if (tg) { tg.setHeaderColor?.('#f3f0f7'); tg.setBackgroundColor?.('#f3f0f7'); }

const esc = (value = '') => String(value).replace(/[&<>"']/g, (x) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[x]);
const toast = (message) => { toastEl.textContent = message; toastEl.classList.add('show'); clearTimeout(toast.timer); toast.timer = setTimeout(() => toastEl.classList.remove('show'), 3500); };
async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { authorization: `tma ${tg?.initData || ''}`, 'content-type': 'application/json', ...(options.headers || {}) } });
  const value = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value?.error || 'Не получилось выполнить запрос');
  return value;
}
async function publicApi(path) {
  const response = await fetch(path);
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value?.error || 'Не получилось открыть рецепт');
  return value;
}
const totalTime = (recipe) => (recipe.prepMinutes || 0) + (recipe.cookMinutes || 0);
const initial = () => (state.me?.displayName || 'Я').trim()[0]?.toLocaleUpperCase('ru') || 'Я';
const ingredientText = (item) => [item.quantity, item.unit, item.name || item.raw].filter((x) => x !== null && x !== '').join(' ');
const safeImage = (value) => /^https:\/\//i.test(value || '') ? esc(value) : '';
const generatedImage = '/assets/recipe-idea-illustration-v1.jpg';
const generatedImageCredit = 'https://unsplash.com/photos/green-vegetable-on-brown-wooden-table-qPcSUERqBAc';

function setRoute(values, { replace = false, historyState = {} } = {}) {
  const url = new URL(location.href);
  for (const key of ['view', 'q', 'recipe']) url.searchParams.delete(key);
  for (const [key, value] of Object.entries(values)) if (value) url.searchParams.set(key, value);
  history[replace ? 'replaceState' : 'pushState'](historyState, '', url);
}

function header() {
  return `<header><button class="brand plain" data-home aria-label="На главную"><span class="brand-dot">Р</span><span>Рецепты</span></button><button class="avatar" id="settings">${esc(initial())}</button></header>`;
}

function card(recipe) {
  const image = recipe.origin === 'generated' ? generatedImage : safeImage(recipe.thumbnailUrl);
  return `<article class="card"><button class="card-open" data-recipe="${esc(recipe.id)}" aria-label="Открыть рецепт: ${esc(recipe.title)}"><div class="card-art ${image ? 'has-image' : 'fallback'}">${image ? `<img src="${image}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<span>Превью<br>недоступно</span>`}<span class="badge">${esc(recipe.origin === 'generated' ? 'Создано в «Рецептах»' : recipe.sourceName || 'Личный рецепт')}</span></div><div class="card-body"><h3>${esc(recipe.title)}</h3><div class="meta">${totalTime(recipe) ? `<span>⏱ ${totalTime(recipe)} мин</span>` : '<span>Время не указано</span>'}${recipe.ingredients?.length ? `<span>${recipe.ingredients.length} ингредиентов</span>` : ''}</div></div></button><button class="card-remove" type="button" data-remove-recipe="${esc(recipe.id)}" aria-label="Удалить рецепт: ${esc(recipe.title)}">×</button></article>`;
}

function jobCard(job) {
  const image = safeImage(job.thumbnailUrl);
  const failed = ['failed', 'interrupted'].includes(job.status);
  return `<article class="card status-card"><div class="card-art ${image ? 'has-image' : 'fallback'}">${image ? `<img src="${image}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<span>Источник<br>получен</span>'}<span class="badge ${failed ? 'failed' : ''}">${failed ? 'Ошибка' : 'Обрабатывается'}</span></div><div class="card-body"><h3>${esc(job.label || 'Новый рецепт')}</h3><p class="status-copy">${failed ? esc(job.errorMessage || 'Не удалось обработать источник. Отправьте его ещё раз или добавьте текст.') : 'Можно закрыть приложение — статус сохранён.'}</p>${job.sourceUrl ? `<a class="source-inline" href="${esc(job.sourceUrl)}" target="_blank" rel="noopener noreferrer">Открыть источник ↗</a>` : ''}</div></article>`;
}

function bindCommon() {
  document.querySelector('[data-home]')?.addEventListener('click', () => { setRoute({}, {}); render(); });
  document.querySelector('#settings')?.addEventListener('click', settingsSheet);
  document.querySelectorAll('[data-recipe]').forEach((el) => el.addEventListener('click', () => openRecipe(el.dataset.recipe, true)));
  document.querySelectorAll('[data-remove-recipe]').forEach((el) => el.addEventListener('click', () => removeRecipeFromList(el.dataset.removeRecipe, el)));
}

function home() {
  const recent = state.recipes.slice(0, 4);
  root.innerHTML = `${header()}<main class="home-page">
    <section class="home-choice" aria-label="Выбор блюда">
      <h1><button id="choose" class="choose-link"><span>Что<br><em>приготовить?</em></span><span class="choose-arrow" aria-hidden="true">↗</span></button></h1>
      <p>Из того, что вы сохранили.</p>
    </section>
    <section class="home-library" aria-labelledby="collection-title">
      <h2 id="collection-title"><button class="collection-link" id="collection"><span>Мои рецепты <small>${state.recipes.length}</small></span><span aria-hidden="true">→</span></button></h2>
      ${recent.length ? `<div class="grid">${recent.map(card).join('')}</div>` : '<div class="empty home-empty"><p>Здесь будут ваши рецепты.<br>Перешлите ссылку или рецепт в чат бота.</p></div>'}
    </section>
    ${state.jobs.length ? `<section class="home-status"><h2>Обработка источников</h2><div class="grid jobs-grid">${state.jobs.map(jobCard).join('')}</div></section>` : ''}
    <footer class="home-footer"><button class="manual-save" id="add">Добавить рецепт вручную</button></footer>
  </main>`;
  bindCommon();
  document.querySelector('#choose').onclick = () => { setRoute({ view: 'search' }); render(); };
  document.querySelector('#collection').onclick = () => { setRoute({ view: 'collection' }); render(); };
  document.querySelector('#add').onclick = importSheet;
}

function searchView() {
  root.innerHTML = `${header()}<main><button class="back-link" id="back-home">← На главную</button><section class="search-page"><div class="eyebrow">Что приготовить?</div><h1>Найдём в вашей коллекции</h1><p>Напишите продукты, блюдо или ограничение по времени.</p><form class="search-wrap" id="search-form"><input class="search" id="search" value="${esc(state.query)}" placeholder="Курица, крылышки с мёдом…" autofocus><button class="primary accent" aria-label="Найти">Найти</button></form></section>${!state.recipes.length ? '<div class="empty"><h2>Коллекция пока пуста</h2><p>Попробуйте поиск. Если совпадений нет, вы сами решите, создавать ли новый рецепт.</p></div>' : ''}</main>`;
  bindCommon(); document.querySelector('#back-home').onclick = () => { setRoute({}); render(); };
  document.querySelector('#search-form').onsubmit = (event) => { event.preventDefault(); const query = document.querySelector('#search').value.trim(); if (!query) return; state.query = query; setRoute({ view: 'results', q: query }); loadAndRender(); };
}

function suggestionSection(suggestion) {
  const r = suggestion.recipe;
  return `<section class="suggestion"><div class="eyebrow">Создано в «Рецептах»</div><img class="suggestion-image" src="${generatedImage}" alt="Иллюстрация: ингредиенты на кухонном столе"><p class="image-note">Иллюстрация: готовое блюдо может выглядеть иначе. <a href="${generatedImageCredit}" target="_blank" rel="noopener noreferrer">Фото: Gareth Hubbard / Unsplash</a></p><h2>${esc(r.title)}</h2>${r.description ? `<p>${esc(r.description)}</p>` : ''}<div class="meta">${totalTime(r) ? `<span>⏱ ${totalTime(r)} мин</span>` : ''}${r.servings ? `<span>${esc(r.servings)} порции</span>` : ''}</div><h3>Ингредиенты</h3><ul>${r.ingredients.map((item) => `<li>${esc(ingredientText(item))}</li>`).join('')}</ul><h3>Приготовление</h3><ol>${r.steps.map((step) => `<li>${esc(step.text)}</li>`).join('')}</ol>${r.warnings?.length ? `<p class="suggestion-warning">${r.warnings.map(esc).join('<br>')}</p>` : ''}<p>Добавить этот рецепт в «Мои рецепты»?</p><button class="primary accent" id="save-suggestion" type="button">Добавить рецепт</button><button class="secondary" id="dismiss-suggestion" type="button">Не добавлять</button></section>`;
}

function collection(recipes = state.recipes, title = 'Мои рецепты', suggestion = null) {
  const emptyState = state.query
    ? suggestion ? suggestionSection(suggestion) : '<div class="empty"><h2>Совпадений нет</h2><p>Мы не нашли в вашей коллекции рецепт по таком запросу. Хотите, чтобы мы предложили вам наш вариант рецепта?</p><div class="empty-search-actions"><button class="primary accent" id="generate-suggestion" type="button">Создать новый рецепт</button><button class="secondary" id="change-query" type="button">Изменить запрос</button><button class="secondary" id="show-all" type="button">Открыть всю коллекцию</button></div></div>'
    : '<div class="empty collection-empty"><div class="eyebrow">Ваша коллекция начинается здесь</div><h2>Добавьте первый рецепт</h2><p>Вставьте ссылку, напишите рецепт или загрузите фото. После обработки он появится здесь.</p><button class="primary accent" id="add" type="button">Добавить первый рецепт</button><p class="empty-hint">Голосовое можно отправить боту в чате.</p></div>';
  root.innerHTML = `${header()}<main><button class="back-link" id="back-home">← На главную</button><div class="section-head page-title"><h1>${esc(title)}</h1><span>${recipes.length}</span></div>${state.jobs.length ? `<div class="grid jobs-grid">${state.jobs.map(jobCard).join('')}</div>` : ''}${recipes.length ? `<div class="grid">${recipes.map(card).join('')}</div>` : emptyState}${recipes.length || state.query ? '<button class="manual-save" id="add">Сохранить рецепт вручную</button>' : ''}</main>`;
  bindCommon(); document.querySelector('#back-home').onclick = () => { setRoute({}); render(); }; document.querySelector('#add').onclick = importSheet;
  document.querySelector('#show-all')?.addEventListener('click', () => { state.query = ''; setRoute({ view: 'collection' }); render(); });
  document.querySelector('#change-query')?.addEventListener('click', () => { setRoute({ view: 'search', q: state.query }); render(); });
  document.querySelector('#generate-suggestion')?.addEventListener('click', async (event) => {
    const button = event.currentTarget; const query = state.query;
    button.disabled = true; button.textContent = 'Составляю рецепт…';
    try {
      const proposal = await api('/api/suggestions', { method: 'POST', body: JSON.stringify({ query }) });
      if (new URLSearchParams(location.search).get('q') === query) collection([], `Результаты: ${query}`, proposal);
    } catch (error) { toast(error.message); button.disabled = false; button.textContent = 'Создать новый рецепт'; }
  });
  document.querySelector('#dismiss-suggestion')?.addEventListener('click', () => collection([], title));
  document.querySelector('#save-suggestion')?.addEventListener('click', async (event) => {
    const button = event.currentTarget; button.disabled = true; button.textContent = 'Сохраняю…';
    try { const recipe = await api(`/api/suggestions/${encodeURIComponent(suggestion.id)}/save`, { method: 'POST' }); await refresh(); toast('Рецепт добавлен в коллекцию'); await openRecipe(recipe.id, true); }
    catch (error) { toast(error.message); button.disabled = false; button.textContent = 'Добавить рецепт'; }
  });
}

async function render() {
  const params = new URLSearchParams(location.search); const view = params.get('view'); state.query = params.get('q') || '';
  if (view === 'results') {
    let results = [];
    try { results = state.query ? await api(`/api/search?q=${encodeURIComponent(state.query)}`) : state.recipes; } catch (error) { toast(error.message); }
    collection(results, state.query ? `Результаты: ${state.query}` : 'Результаты');
  } else if (view === 'collection') collection();
  else if (view === 'search') searchView();
  else if (view === 'add') { home(); setRoute({}, { replace: true }); importSheet(); }
  else home();
  const recipeId = params.get('recipe'); if (recipeId) await openRecipe(recipeId, false);
}

async function refresh() { const library = await api('/api/library'); state.recipes = library.recipes; state.jobs = library.jobs; }
async function loadAndRender() { await refresh(); await render(); }
function closeOverlay() { document.querySelector('.overlay')?.remove(); }
function overlay(content, sheetClass = '', dismissible = true) { const el = document.createElement('div'); el.className = 'overlay'; el.innerHTML = `<section class="sheet ${esc(sheetClass)}"><div class="sheet-handle"></div>${content}</section>`; root.append(el); if (dismissible) el.addEventListener('click', (e) => { if (e.target === el) closeDetailRoute(); }); return el; }

function importSheet() {
  state.tab = 'text';
  const firstRecipe = state.recipes.length === 0;
  const el = overlay(`<div class="sheet-head"><div><div class="eyebrow">${firstRecipe ? 'Первый рецепт' : 'Дополнительный способ'}</div><h2>${firstRecipe ? 'Добавить первый рецепт' : 'Сохранить вручную'}</h2></div><button class="icon-btn" data-close>✕</button></div><p class="help">${firstRecipe ? 'Вставьте текст или ссылку на рецепт либо выберите фото. Голосовое можно отправить боту в чате.' : 'Обычно проще поделиться источником в чат бота. Здесь можно вставить текст, ссылку или выбрать фото.'}</p><div class="source-tabs"><button data-tab="text" class="active">Текст</button><button data-tab="url">Ссылка</button><button data-tab="image">Фото</button></div><form id="import-form" class="form-stack"><div id="import-field"><textarea class="field" id="source-value" placeholder="Вставьте ингредиенты и шаги…"></textarea></div><p class="help">После обработки рецепт сразу появится в коллекции. Проверяйте неизвестные количества и температуры.</p><button class="primary accent" type="submit">Сохранить</button></form>`);
  el.querySelector('[data-close]').onclick = closeOverlay;
  el.querySelectorAll('[data-tab]').forEach((button) => button.onclick = () => { state.tab = button.dataset.tab; el.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('active', x === button)); const field = el.querySelector('#import-field'); field.innerHTML = state.tab === 'image' ? '<input class="field" id="source-file" type="file" accept="image/jpeg,image/png,image/webp"><input class="field" id="source-caption" placeholder="Подпись к фото (необязательно)">' : `<textarea class="field" id="source-value" placeholder="${state.tab === 'url' ? 'https://сайт/рецепт' : 'Вставьте ингредиенты и шаги…'}"></textarea>`; });
  el.querySelector('#import-form').onsubmit = submitImport;
}

async function submitImport(event) {
  event.preventDefault(); const button = event.currentTarget.querySelector('button[type=submit]'); button.disabled = true; button.innerHTML = '<span class="loader"></span>Обрабатываю…';
  try {
    let body;
    if (state.tab === 'image') { const file = document.querySelector('#source-file').files[0]; if (!file) throw new Error('Выберите фото'); if (file.size > 6 * 1024 * 1024) throw new Error('Файл больше 6 МБ'); const value = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = reject; reader.readAsDataURL(file); }); body = { kind: 'image', value, mime: file.type, caption: document.querySelector('#source-caption').value }; }
    else { const value = document.querySelector('#source-value').value.trim(); if (!value) throw new Error('Добавьте источник'); body = { kind: state.tab, value }; }
    const outcome = await api('/api/import', { method: 'POST', body: JSON.stringify(body) }); closeOverlay(); await refresh();
    if (outcome.recipe) { toast(outcome.state === 'existing' ? 'Этот рецепт уже есть' : 'Рецепт сохранён'); await openRecipe(outcome.recipe.id, true); }
    else { toast('Источник уже обрабатывается'); await render(); }
  } catch (error) { toast(error.message); button.disabled = false; button.textContent = 'Сохранить'; }
}

function closeDetailRoute() {
  closeOverlay();
  if (history.state?.recipeOverlay) history.back();
  else { const url = new URL(location.href); url.searchParams.delete('recipe'); history.replaceState({}, '', url); }
}

async function openRecipe(id, pushRoute = false) {
  try {
    if (pushRoute) { state.scrollY = scrollY; const params = Object.fromEntries(new URLSearchParams(location.search)); params.recipe = id; setRoute(params, { historyState: { recipeOverlay: true, scrollY: state.scrollY } }); }
    closeOverlay(); const recipe = await api(`/api/recipes/${encodeURIComponent(id)}`); recipeDetail(recipe);
  } catch (error) { toast(error.message); }
}

function recipeDetail(r, { shared = false } = {}) {
  const image = r.origin === 'generated' ? generatedImage : safeImage(r.thumbnailUrl);
  const hasSource = /^https?:\/\//i.test(r.sourceUrl || '');
  const sourceName = r.origin === 'generated' ? 'Создано в «Рецептах»' : r.sourceName || (hasSource ? 'Открыть источник' : 'Личный рецепт');
  const sourceChip = hasSource
    ? `<a class="source-chip" data-source-link href="${esc(r.sourceUrl)}" target="_blank" rel="noopener noreferrer" aria-label="Открыть источник: ${esc(sourceName)}"><span class="source-chip-icon">▶</span><span>${esc(sourceName)}</span><span class="source-chip-arrow">↗</span></a>`
    : `<span class="source-chip source-chip-static"><span class="source-chip-icon">•</span><span>${esc(sourceName)}</span></span>`;
  const stats = [
    totalTime(r) ? `<div class="detail-stat"><strong>${totalTime(r)}</strong><span>минут</span></div>` : `<div class="detail-stat"><strong>—</strong><span>время</span></div>`,
    r.servings ? `<div class="detail-stat"><strong>${esc(r.servings)}</strong><span>порции</span></div>` : '',
    r.ingredients?.length ? `<div class="detail-stat"><strong>${r.ingredients.length}</strong><span>ингредиентов</span></div>` : ''
  ].filter(Boolean).join('');
  const tags = (r.tags || []).map((tag) => shared ? `<span class="recipe-tag">${esc(tag)}</span>` : `<button class="recipe-tag" type="button" data-tag="${esc(tag)}">${esc(tag)}</button>`).join('');
  const warnings = (r.warnings || []).map((item) => `<li>${esc(item)}</li>`).join('');
  const warningCount = (r.warnings || []).length;
  const ingredients = (r.ingredients || []).map((item) => {
    const amount = [item.quantity, item.unit].filter((value) => value !== null && value !== '').join(' ');
    return `<div class="ingredient-row"><div><strong>${esc(item.name || item.raw)}</strong>${item.comment ? `<small>${esc(item.comment)}</small>` : ''}</div>${amount ? `<span>${esc(amount)}</span>` : '<span class="amount-empty">по вкусу</span>'}</div>`;
  }).join('') || '<p class="detail-empty">Ингредиенты не извлечены</p>';
  const steps = (r.steps || []).map((item, index) => `<div class="step-card"><span class="step-number">${index + 1}</span><p>${esc(item.text)}</p></div>`).join('') || '<p class="detail-empty">Шаги не извлечены</p>';
  const sharedIntro = shared ? `<section class="shared-intro"><div class="shared-avatar">${esc((r.sharedBy || 'П').trim()[0]?.toLocaleUpperCase('ru') || 'П')}</div><div><strong>${esc(r.sharedBy || 'Пользователь')} делится рецептом</strong><p>Рецепт сохранён в сервисе «Рецепты» — он собирает рецепты из ссылок, фото, текста и голосовых.</p><a href="https://t.me/Recipeboibot" target="_blank" rel="noopener noreferrer">Подробнее о сервисе →</a></div></section>` : '';
  const toolbarActions = shared ? '' : '<div class="detail-toolbar-actions"><button class="detail-edit" id="edit">Изменить</button><button class="detail-close" data-close aria-label="Закрыть">✕</button></div>';
  const actions = shared
    ? `<div class="detail-actions shared-actions"><button class="primary accent" id="cook" ${r.steps?.length ? '' : 'disabled'}>Начать готовить</button></div>`
    : `<div class="detail-actions"><button class="secondary share-button" id="share">Поделиться</button><button class="primary accent" id="cook" ${r.steps?.length ? '' : 'disabled'}>Начать готовить</button></div>`;
  const el = overlay(`${sharedIntro}<div class="detail-toolbar">${sourceChip}${toolbarActions}</div><div class="detail-media ${image ? 'has-preview' : 'no-preview'}">${image ? `<img src="${image}" alt="" referrerpolicy="no-referrer">` : '<div class="detail-media-fallback"><span>Р</span><small>Превью источника недоступно</small></div>'}</div>${r.origin === 'generated' ? `<p class="generated-image-note">Иллюстрация: готовое блюдо может выглядеть иначе. <a href="${generatedImageCredit}" target="_blank" rel="noopener noreferrer">Фото: Gareth Hubbard / Unsplash</a></p>` : ''}<div class="detail-content"><div class="detail-heading"><div class="eyebrow">${shared ? 'Рецепт по ссылке' : 'Сохранённый рецепт'}</div><h1>${esc(r.title)}</h1>${stats ? `<div class="detail-stats">${stats}</div>` : ''}${r.description ? `<p class="detail-lead">${esc(r.description)}</p>` : ''}${tags ? `<div class="recipe-tags">${tags}</div>` : ''}</div>${warnings ? `<details class="quality-card"><summary><span><b>Что стоит проверить</b><small>Автоматическое извлечение · ${warningCount}</small></span><span class="quality-toggle">＋</span></summary><ul>${warnings}</ul></details>` : ''}<section class="recipe-panel ingredients-panel"><div class="recipe-panel-head"><div><span class="section-kicker">Список продуктов</span><h2>Ингредиенты</h2></div><span>${r.ingredients?.length || 0}</span></div><div class="ingredient-list">${ingredients}</div></section><section class="recipe-panel steps-panel"><div class="recipe-panel-head"><div><span class="section-kicker">По порядку</span><h2>Как готовить</h2></div><span>${r.steps?.length || 0}</span></div><div class="step-list">${steps}</div></section>${r.notes ? `<section class="recipe-panel note-panel"><div class="recipe-panel-head"><div><span class="section-kicker">Личное</span><h2>Заметки</h2></div></div><p>${esc(r.notes)}</p></section>` : ''}</div>${actions}`, `recipe-detail-sheet${shared ? ' shared-recipe-sheet' : ''}`, !shared);
  if (shared) el.classList.add('shared-overlay');
  el.querySelector('[data-close]')?.addEventListener('click', closeDetailRoute);
  el.querySelector('#edit')?.addEventListener('click', () => { closeOverlay(); editRecipe(r); });
  el.querySelector('#share')?.addEventListener('click', (event) => shareRecipe(r, event.currentTarget));
  el.querySelector('#cook').onclick = () => cookMode(r);
  el.querySelector('[data-source-link]')?.addEventListener('click', (event) => {
    if (!tg?.openLink) return;
    event.preventDefault();
    try { tg.openLink(r.sourceUrl); }
    catch { window.open(r.sourceUrl, '_blank', 'noopener,noreferrer'); }
  });
  el.querySelectorAll('[data-tag]').forEach((button) => button.onclick = () => { closeOverlay(); state.query = button.dataset.tag; setRoute({ view: 'results', q: state.query }, { replace: true }); loadAndRender(); });
}

async function shareRecipe(recipe, button) {
  const label = button.textContent; button.disabled = true; button.textContent = 'Готовлю ссылку…';
  try {
    const share = await api(`/api/recipes/${encodeURIComponent(recipe.id)}/share`, { method: 'POST', body: '{}' });
    const url = new URL(share.path, location.origin).toString();
    const text = `Смотри рецепт «${recipe.title}»`;
    const telegramShareUrl = `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`;
    if (tg?.openTelegramLink) tg.openTelegramLink(telegramShareUrl);
    else if (tg?.openLink) tg.openLink(telegramShareUrl);
    else if (navigator.share) await navigator.share({ title: recipe.title, text, url });
    else { await navigator.clipboard.writeText(url); toast('Ссылка скопирована'); }
  } catch (error) { if (error?.name !== 'AbortError') toast(error.message); }
  finally { button.disabled = false; button.textContent = label; }
}

async function openSharedRecipe(token) {
  try {
    const recipe = await publicApi(`/api/shares/${encodeURIComponent(token)}`);
    closeOverlay(); root.innerHTML = ''; recipeDetail(recipe, { shared: true });
    document.title = `${recipe.title} — Рецепты`;
  } catch (error) {
    root.innerHTML = `<main class="outside"><div class="brand-mark">!</div><h1>Рецепт недоступен</h1><p>${esc(error.message)}</p><a class="primary accent" href="https://t.me/Recipeboibot" style="text-decoration:none">Открыть сервис ↗</a></main>`;
  }
}

function editRecipe(r) {
  const el = overlay(`<div class="sheet-head"><div><div class="eyebrow">РЕДАКТОР</div><h2>Проверьте рецепт</h2></div><button class="icon-btn" data-close>✕</button></div>${r.warnings.map((x) => `<div class="warning">⚠ ${esc(x)}</div>`).join('')}<form id="edit-form" class="form-stack"><label><span class="label">Название</span><input class="field" name="title" value="${esc(r.title)}" required></label><label><span class="label">Описание</span><textarea class="field" name="description">${esc(r.description)}</textarea></label><div class="form-row"><label><span class="label">Порций</span><input class="field" name="servings" type="number" value="${r.servings ?? ''}"></label><label><span class="label">Подготовка</span><input class="field" name="prepMinutes" type="number" value="${r.prepMinutes ?? ''}"></label><label><span class="label">Готовка</span><input class="field" name="cookMinutes" type="number" value="${r.cookMinutes ?? ''}"></label></div><label><span class="label">Ингредиенты — по одному на строке</span><textarea class="field" name="ingredients">${esc(r.ingredients.map(ingredientText).join('\n'))}</textarea></label><label><span class="label">Шаги — по одному на строке</span><textarea class="field" name="steps">${esc(r.steps.map((x) => x.text).join('\n'))}</textarea></label><label><span class="label">Теги через запятую</span><input class="field" name="tags" value="${esc(r.tags.join(', '))}"></label><label><span class="label">Мои заметки</span><textarea class="field" name="notes">${esc(r.notes)}</textarea></label><div class="actions"><button class="primary accent" type="submit">Сохранить</button></div></form>`, '', false);
  el.querySelector('[data-close]').onclick = () => { closeOverlay(); recipeDetail(r); }; el.querySelector('#edit-form').onsubmit = (e) => saveRecipe(e, r.id);
}

async function saveRecipe(event, id) {
  event.preventDefault(); const form = new FormData(event.currentTarget), button = event.currentTarget.querySelector('[type=submit]'); button.disabled = true;
  const data = Object.fromEntries(form); data.ingredients = data.ingredients.split('\n').map((x) => x.trim()).filter(Boolean); data.steps = data.steps.split('\n').map((x) => x.trim()).filter(Boolean); data.tags = data.tags.split(',').map((x) => x.trim()).filter(Boolean); data.status = 'ready';
  try { const recipe = await api(`/api/recipes/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(data) }); closeOverlay(); await refresh(); recipeDetail(recipe); toast('Изменения сохранены'); } catch (error) { toast(error.message); button.disabled = false; }
}
async function removeRecipeFromList(id, button) {
  if (!confirm('Убрать рецепт из библиотеки?')) return;
  button.disabled = true;
  try { await api(`/api/recipes/${encodeURIComponent(id)}`, { method: 'DELETE' }); await refresh(); await render(); toast('Рецепт удалён'); }
  catch (error) { toast(error.message); button.disabled = false; }
}
function cookMode(r) { state.cookStep = 0; const el = document.createElement('div'); el.className = 'cook'; const draw = () => { el.innerHTML = `<div class="cook-top"><span>${state.cookStep + 1} из ${r.steps.length}</span><button class="icon-btn" id="cook-close">✕</button></div><div class="cook-step">${esc(r.steps[state.cookStep].text)}</div><div class="cook-nav"><button class="secondary" id="prev" ${state.cookStep === 0 ? 'disabled' : ''}>← Назад</button><button class="primary accent" id="next">${state.cookStep === r.steps.length - 1 ? 'Готово ✓' : 'Дальше →'}</button></div>`; el.querySelector('#cook-close').onclick = () => el.remove(); el.querySelector('#prev').onclick = () => { state.cookStep--; draw(); }; el.querySelector('#next').onclick = () => { if (state.cookStep === r.steps.length - 1) el.remove(); else { state.cookStep++; draw(); } }; }; draw(); document.body.append(el); }
function settingsSheet() { const el = overlay(`<div class="sheet-head"><div><div class="eyebrow">ПРОФИЛЬ</div><h2>${esc(state.me.displayName)}</h2></div><button class="icon-btn" data-close>✕</button></div><p class="help">Коллекция привязана к вашему Telegram и недоступна другим пользователям. Закрытые источники могут не обработаться; отсутствующие сведения не додумываются.</p><button class="ghost" id="delete-account">Удалить мои данные</button>`); el.querySelector('[data-close]').onclick = closeOverlay; el.querySelector('#delete-account').onclick = async () => { if (!confirm('Безвозвратно удалить профиль и все рецепты?')) return; await api('/api/account', { method: 'DELETE' }); location.reload(); }; }

window.addEventListener('popstate', async (event) => { if (!tg?.initData) return; closeOverlay(); await render(); requestAnimationFrame(() => scrollTo(0, event.state?.scrollY || 0)); });
async function boot() {
  const sharedMatch = location.pathname.match(/^\/share\/([A-Za-z0-9_-]{32})\/?$/);
  if (!sharedMatch && !tg?.initData) return;
  const landing = document.querySelector('#landing');
  if (landing) landing.hidden = true;
  root.hidden = false;
  if (sharedMatch) { await openSharedRecipe(sharedMatch[1]); return; }
  try { [state.me] = await Promise.all([api('/api/me')]); await refresh(); await render(); } catch (error) { root.innerHTML = `<main class="outside"><div class="brand-mark">!</div><h1>Не получилось войти</h1><p>${esc(error.message)}</p><p>Вернитесь в чат бота и нажмите Start.</p></main>`; }
}
boot();
