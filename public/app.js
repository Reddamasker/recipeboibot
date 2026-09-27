const tg = window.Telegram?.WebApp;
const root = document.querySelector('#app');
const toastEl = document.querySelector('#toast');
const state = { me: null, recipes: [], jobs: [], query: '', tab: 'text', cookStep: 0, scrollY: 0, dinner: null, onboarding: null, payment: null, checkoutOrder: null, paymentResult: null, paymentMethod: 'card' };
window.miniProbe?.('app-script');

tg?.ready(); tg?.expand();
if (tg) { tg.setHeaderColor?.('#f3f0f7'); tg.setBackgroundColor?.('#f3f0f7'); }

const esc = (value = '') => String(value).replace(/[&<>"']/g, (x) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[x]);
const toast = (message) => { toastEl.textContent = message; toastEl.classList.add('show'); clearTimeout(toast.timer); toast.timer = setTimeout(() => toastEl.classList.remove('show'), 3500); };
async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { authorization: `tma ${tg?.initData || ''}`, 'content-type': 'application/json', ...(options.headers || {}) } });
  const value = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(value?.error || 'Не получилось выполнить запрос'), { status: response.status });
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
const safeImage = (value) => /^https:\/\//i.test(value || '') || (/^\/(?:recipe|dinner|suggestion)-images\/[0-9a-f-]{36}$/i.test(value || '') || /^\/assets\/dinner\/[a-z0-9-]+\.jpg$/i.test(value || '')) ? esc(value) : '';
let requestRecorder = null;

function setRoute(values, { replace = false, historyState = {} } = {}) {
  if (values.view && requestRecorder?.state === 'recording') requestRecorder.stop();
  const url = new URL(location.href);
  for (const key of ['view', 'q', 'recipe']) url.searchParams.delete(key);
  for (const [key, value] of Object.entries(values)) if (value) url.searchParams.set(key, value);
  history[replace ? 'replaceState' : 'pushState'](historyState, '', url);
}

function header() {
  return `<header><button class="brand plain" data-home aria-label="На главную"><span class="brand-dot">Р</span><span>Рецепты</span></button><button class="avatar" id="settings">${esc(initial())}</button></header>`;
}

function card(recipe) {
  const image = safeImage(recipe.thumbnailUrl);
  return `<article class="card"><button class="card-open" data-recipe="${esc(recipe.id)}" aria-label="Открыть рецепт: ${esc(recipe.title)}"><div class="card-art ${image ? 'has-image' : 'fallback'}">${image ? `<img src="${image}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<span>${recipe.origin === 'generated' ? 'Фото пока нет' : 'Превью<br>недоступно'}</span>`}<span class="badge">${esc(recipe.origin === 'generated' ? 'Создано в «Рецептах»' : recipe.sourceName || 'Личный рецепт')}</span></div><div class="card-body"><h3>${esc(recipe.title)}</h3><div class="meta">${totalTime(recipe) ? `<span>⏱ ${totalTime(recipe)} мин</span>` : '<span>Время не указано</span>'}${recipe.ingredients?.length ? `<span>${recipe.ingredients.length} ингредиентов</span>` : ''}</div></div></button><button class="card-remove" type="button" data-remove-recipe="${esc(recipe.id)}" aria-label="Удалить рецепт: ${esc(recipe.title)}">×</button></article>`;
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
  document.querySelectorAll('[data-open-offer]').forEach((el) => el.addEventListener('click', openOffer));
}

function offerBanner() {
  const payment = state.payment;
  if (!payment?.hasFirstRecipe || payment.active) return '';
  return `<section class="offer-banner"><div><span class="offer-kicker">${payment.firstValue === 'cooked' ? 'Первый ужин приготовлен' : 'Первый рецепт сохранён'}</span><h2>Сохраняйте следующие рецепты</h2><p>Тестовый доступ к автоматическому импорту за <strong>${payment.offer.priceRub} ₽/мес.</strong> ${payment.firstValue === 'cooked' ? 'Добавляйте свои рецепты из текста, фото и ссылок.' : 'Ваш рецепт остаётся в коллекции.'}</p></div><button class="primary accent" type="button" data-open-offer>Посмотреть предложение →</button><small>Тестовый сценарий · деньги не списываются</small></section>`;
}

function openOffer() { closeOverlay(); setRoute({ view: 'offer' }); void render(); }

function home() {
  const recent = state.recipes.slice(0, 4);
  root.innerHTML = `${header()}<main class="home-page">
    <section class="home-choice" aria-label="Выбор блюда">
      <h1><button id="choose" class="choose-link"><span>Что приготовить<br><em>сегодня?</em></span><span class="choose-arrow" aria-hidden="true">↗</span></button></h1>
      <p>Три идеи для ужина — из твоих рецептов или нашей подборки.</p>
    </section>
    <section class="home-search" aria-labelledby="home-search-title">
      <h2 id="home-search-title">Что тебе хочется?</h2>
      <form class="search-wrap" id="home-search-form"><input class="search" id="home-search-input" aria-label="Что хочется приготовить" placeholder="Например, суп или курица с рисом" required><button class="voice-request" id="voice-request" type="button" aria-label="Надиктовать пожелание" aria-pressed="false"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><rect x="9" y="2.5" width="6" height="12" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3.5m-3.5 0h7"/></svg></button><button class="primary accent" type="submit">Подобрать рецепт</button></form>
      <p class="request-voice-status" id="request-voice-status" aria-live="polite"></p>
      <div class="request-examples" aria-label="Примеры коротких запросов"><span>Можно коротко:</span><button type="button" data-request-example="Суп">Суп</button><button type="button" data-request-example="Курица">Курица</button><button type="button" data-request-example="Что-нибудь быстрое">Что-нибудь быстрое</button></div>
      <p>Сначала поищу готовый рецепт. Если подходящего нет — составлю новый.</p>
    </section>
    ${offerBanner()}
    <section class="home-library" aria-labelledby="collection-title">
      <h2 id="collection-title"><button class="collection-link" id="collection"><span>Мои рецепты <small>${state.recipes.length}</small></span><span aria-hidden="true">→</span></button></h2>
      ${recent.length ? `<div class="grid">${recent.map(card).join('')}</div>` : '<div class="empty home-empty"><p>Перешли рецепт в чат бота — так я лучше пойму, что предложить тебе на ужин.</p></div>'}
    </section>
    ${state.jobs.length ? `<section class="home-status"><h2>Обработка источников</h2><div class="grid jobs-grid">${state.jobs.map(jobCard).join('')}</div></section>` : ''}
    <footer class="home-footer"><button class="manual-save" id="add">Добавить рецепт вручную</button></footer>
  </main>`;
  bindCommon();
  document.querySelector('#choose').onclick = () => { setRoute({ view: 'dinner' }); beginDinner(); };
  document.querySelector('#home-search-form').onsubmit = showRequestedRecipe;
  document.querySelector('#voice-request').onclick = toggleRequestRecording;
  document.querySelectorAll('[data-request-example]').forEach((button) => button.onclick = () => { document.querySelector('#home-search-input').value = button.textContent.trim(); return showRequestedRecipe({ preventDefault() {}, currentTarget: document.querySelector('#home-search-form') }); });
  document.querySelector('#collection').onclick = () => { setRoute({ view: 'collection' }); render(); };
  document.querySelector('#add').onclick = importSheet;
}

async function showRequestedRecipe(event) {
  event.preventDefault();
  const query = document.querySelector('#home-search-input')?.value.trim();
  const button = event.currentTarget.querySelector('button[type=submit]');
  if (!query || !button || button.disabled) return;
  button.disabled = true;
  button.innerHTML = '<span class="loader"></span> Подбираю…';
  try {
    const result = await api('/api/recipe-request', { method: 'POST', body: JSON.stringify({ query }) });
    if (new URLSearchParams(location.search).get('view')) return;
    if (result.kind === 'existing') await openRecipe(result.recipe.id, true);
    else if (result.kind === 'generated') recipeDetail({ ...result.suggestion.recipe, origin: 'generated', sourceName: 'Создано в «Рецептах»' }, { suggestion: result.suggestion });
    else throw new Error('Не получилось подобрать рецепт');
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; button.textContent = 'Подобрать рецепт'; }
}

async function toggleRequestRecording(event) {
  if (requestRecorder) { if (requestRecorder.state === 'recording') requestRecorder.stop(); return; }
  const button = event.currentTarget;
  const status = document.querySelector('#request-voice-status');
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') { toast('Диктовка недоступна здесь. Можно написать запрос или отправить голосовое боту.'); return; }
  let stream;
  button.disabled = true;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const format = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'].find((type) => MediaRecorder.isTypeSupported?.(type));
    const recorder = new MediaRecorder(stream, format ? { mimeType: format } : undefined);
    requestRecorder = recorder;
    const chunks = [];
    let limitTimer;
    recorder.ondataavailable = (part) => { if (part.data?.size) chunks.push(part.data); };
    recorder.onerror = () => { toast('Не удалось записать голос. Попробуйте ещё раз.'); if (recorder.state === 'recording') recorder.stop(); };
    recorder.onstop = async () => {
      clearTimeout(limitTimer);
      stream.getTracks().forEach((track) => track.stop());
      requestRecorder = null;
      button.classList.remove('recording'); button.setAttribute('aria-pressed', 'false'); button.setAttribute('aria-label', 'Надиктовать пожелание');
      if (!document.querySelector('#home-search-form')) return;
      const mime = (recorder.mimeType || format || '').split(';')[0];
      const blob = new Blob(chunks, { type: mime });
      if (!blob.size || blob.size > 2 * 1024 * 1024 || !['audio/mp4', 'audio/webm', 'audio/ogg'].includes(mime)) { status.textContent = 'Запись не получилась или слишком длинная. Попробуйте ещё раз.'; return; }
      status.textContent = 'Расшифровываю пожелание…'; button.disabled = true;
      try {
        const value = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = reject; reader.readAsDataURL(blob); });
        const result = await api('/api/recipe-request/transcribe', { method: 'POST', body: JSON.stringify({ mime, value }) });
        const input = document.querySelector('#home-search-input');
        const form = document.querySelector('#home-search-form');
        if (input && form) { input.value = result.text; status.textContent = 'Пожелание записано. Подбираю рецепт…'; await showRequestedRecipe({ preventDefault() {}, currentTarget: form }); }
      } catch (error) { status.textContent = ''; toast(error.message); }
      finally { button.disabled = false; }
    };
    recorder.start();
    button.disabled = false;
    button.classList.add('recording'); button.setAttribute('aria-pressed', 'true'); button.setAttribute('aria-label', 'Завершить запись');
    status.textContent = 'Записываю… Нажми на микрофон ещё раз, когда закончишь.';
    limitTimer = setTimeout(() => { if (recorder.state === 'recording') recorder.stop(); }, 45_000);
  } catch (error) { stream?.getTracks().forEach((track) => track.stop()); requestRecorder = null; button.disabled = false; status.textContent = ''; toast(error.name === 'NotAllowedError' ? 'Разрешите доступ к микрофону или напишите запрос.' : 'Не удалось включить микрофон. Можно написать запрос.'); }
}

async function beginDinner(forceOnboarding = false, startTrialTastePreferences = false) {
  clearTimeout(dinnerPollTimer);
  try {
    const session = await api('/api/dinner/open', { method: 'POST', body: '{}', signal: AbortSignal.timeout(12000) });
    state.dinner = { sessionId: session.sessionId, profile: session.profile, pantry: session.pantry || [], needsOnboarding: session.needsOnboarding, recommendations: [], reserve: [], recommendation: null, accepted: false, retryCount: 0, askingReason: false, loading: false };
    if (startTrialTastePreferences && session.needsTastePreferences) showDinnerTastePreferences();
    else if (forceOnboarding) await showDinnerOnboarding();
    else await loadDinnerRecommendation();
  } catch (error) { toast(error.message); setRoute({}, { replace: true }); home(); }
}

async function resumePendingTrialTastePreferences() {
  if (!state.me?.testContour || !state.payment?.active) return false;
  const profile = await api('/api/dinner/profile', { signal: AbortSignal.timeout(12000) });
  if (profile.tastePreferencesStatus !== 'pending') return false;
  setRoute({ view: 'dinner' }, { replace: true });
  await beginDinner(false, true);
  return true;
}

async function showDinnerOnboarding() {
  const dinner = state.dinner;
  if (!dinner) return;
  try {
    await api('/api/dinner/onboarding/start', { method: 'POST', body: JSON.stringify({ sessionId: dinner.sessionId }) });
    state.onboarding = { step: 0, householdType: dinner.profile.householdType, householdSize: dinner.profile.householdSize, hasChildren: dinner.profile.hasChildren, preferredMaxCookingTime: dinner.profile.preferredMaxCookingTime, excludedIngredients: dinner.profile.excludedIngredients.join(', '), preferredCategories: { ...dinner.profile.preferredCategories } };
    dinnerView();
  } catch (error) { toast(error.message); }
}

function tasteChoices(categories) {
  const tags = [['pasta','Паста'],['asian','Азиатское'],['chicken','Курица'],['meat','Мясо'],['fish','Рыба'],['soup','Супы'],['salad','Салаты'],['home','Домашняя еда']];
  return `<h1>Что ты любишь есть?</h1><p>Отметь любимые блюда и те, которые не по вкусу. Так подбор станет точнее.</p>${[[1, 'Нравится'], [-1, 'Не нравится']].map(([value, title]) => `<fieldset class="taste-group"><legend>${title}</legend><div class="dinner-options">${tags.map(([key, label]) => `<button type="button" class="dinner-option ${Math.sign(categories[key] || 0) === value ? 'selected' : ''}" data-taste="${key}" data-value="${value}" aria-pressed="${Math.sign(categories[key] || 0) === value}">${label}</button>`).join('')}</div></fieldset>`).join('')}<p class="dinner-help">Можно выбрать несколько тегов. Повторное нажатие снимает выбор. Нелюбимые блюда будем предлагать реже. Аллергию и продукты, которые нельзя, укажи отдельно в настройках.</p>`;
}

function bindTasteChoices(data, redraw) {
  document.querySelectorAll('[data-taste]').forEach((button) => button.onclick = () => {
    if (data.saving) return;
    const key = button.dataset.taste, value = Number(button.dataset.value);
    if (Math.sign(data.preferredCategories[key] || 0) === value) delete data.preferredCategories[key];
    else data.preferredCategories[key] = value;
    redraw();
    document.querySelector(`[data-taste="${key}"][data-value="${value}"]`)?.focus();
  });
}

function showDinnerTastePreferences() {
  clearTimeout(dinnerPollTimer);
  state.onboarding = { tasteOnly: true, preferredCategories: { ...state.dinner.profile.preferredCategories }, saving: false };
  dinnerView();
}

function tastePreferencesView() {
  const data = state.onboarding;
  root.innerHTML = `${header()}<main class="dinner-page"><div class="eyebrow">ТВОИ ВКУСЫ</div><section class="dinner-onboarding">${tasteChoices(data.preferredCategories)}<div class="dinner-actions"><button class="primary accent" id="taste-save" ${data.saving ? 'disabled' : ''}>${data.saving ? 'Сохраняю…' : 'Сохранить и подобрать ужин'}</button><button class="secondary" id="taste-skip" ${data.saving ? 'disabled' : ''}>Пока пропустить</button></div><p class="dinner-help">Ответы можно изменить в настройках в любой момент.</p></section></main>`;
  bindCommon();
  bindTasteChoices(data, tastePreferencesView);
  const finish = async (skip) => {
    if (data.saving) return;
    data.saving = true; tastePreferencesView();
    try {
      const input = skip ? { tastePreferencesStatus: 'skipped' } : { preferredCategories: data.preferredCategories, tastePreferencesStatus: 'completed' };
      await api('/api/dinner/profile', { method: 'PUT', body: JSON.stringify(input) });
      state.onboarding = null;
      await beginDinner();
    } catch (error) { data.saving = false; tastePreferencesView(); toast(error.message); }
  };
  document.querySelector('#taste-save').onclick = () => finish(false);
  document.querySelector('#taste-skip').onclick = () => finish(true);
}

async function loadDinnerRecommendation() {
  if (!state.dinner) return;
  const dinner = state.dinner;
  state.dinner.loading = true;
  state.dinner.recommendations = [];
  state.dinner.recommendation = null;
  state.dinner.message = dinner.pantry?.length
    ? 'Составляю рецепты под твои продукты — сразу с запасом для следующего выбора…'
    : 'Составляю три варианта ужина…';
  dinnerView();
  try {
    const result = await api('/api/dinner/recommend', { method: 'POST', body: JSON.stringify({ sessionId: dinner.sessionId }) });
    if (state.dinner !== dinner) return;
    state.dinner.loading = false;
    state.dinner.recommendations = result.recommendations || (result.recommendation ? [result.recommendation] : []);
    state.dinner.recommendation = result.recommendation;
    state.dinner.pantry = result.pantry || [];
    state.dinner.message = result.message;
    state.dinner.accepted = false;
    state.dinner.askingReason = false;
    state.dinner.rejectedCount = result.rejectedCount || 0;
    state.dinner.retryCount = result.retryCount || 0;
    state.dinner.reserve = result.reserve || [];
    state.dinner.preparing = result.preparing;
    state.dinner.imagesPending = result.imagesPending;
    state.dinner.notice = result.notice;
    dinnerView();
    scheduleDinnerPrefetch(dinner);
  } catch (error) { state.dinner.loading = false; state.dinner.message = error.message; dinnerView(); toast(error.message); }
}

let dinnerPollTimer;
function scheduleDinnerPrefetch(dinner) {
  clearTimeout(dinnerPollTimer);
  if (dinner !== state.dinner || dinner.accepted || (!dinner.preparing && !dinner.imagesPending && dinner.reserve?.length >= 3)) return;
  dinnerPollTimer = setTimeout(async () => {
    if (dinner !== state.dinner || dinner.accepted || new URLSearchParams(location.search).get('view') !== 'dinner') return;
    try {
      const result = await api('/api/dinner/prefetch', { method: 'POST', body: JSON.stringify({ sessionId: dinner.sessionId }), signal: AbortSignal.timeout(12000) });
      if (dinner !== state.dinner || dinner.switching || dinner.accepted) return;
      if (!result.recommendations.length && result.reserve?.length) return loadDinnerRecommendation();
      const imagesChanged = JSON.stringify(dinner.recommendations.map((o) => [o.id,o.recipe.thumbnailUrl])) !== JSON.stringify(result.recommendations.map((o) => [o.id,o.recipe.thumbnailUrl]));
      Object.assign(dinner, { reserve: result.reserve || [], preparing: result.preparing, imagesPending: result.imagesPending, notice: result.notice });
      if (imagesChanged) { dinner.recommendations = result.recommendations; dinner.recommendation = result.recommendation; dinner.message = result.message; if (!dinner.askingReason) dinnerView(); }
      // Stop polling an exhausted offline fallback; an explicit retry can restart generation.
      if (result.preparing || result.imagesPending || result.reserve?.length >= 3) scheduleDinnerPrefetch(dinner);
    } catch {
      // A transient network failure must not permanently stop image updates.
      if (dinner === state.dinner) scheduleDinnerPrefetch(dinner);
    }
  }, 3000);
}

async function showNextDinner() {
  const dinner = state.dinner;
  if (!dinner || dinner.switching) return;
  const previous = dinner.recommendations;
  const previousReserve = dinner.reserve;
  dinner.lastRejectedId = previous[0]?.id;
  dinner.switching = true;
  clearTimeout(dinnerPollTimer);
  // The full reserve is already in memory: change the screen before sending the request.
  if (dinner.reserve?.length) {
    dinner.recommendations = dinner.reserve; dinner.recommendation = dinner.reserve[0]; dinner.reserve = [];
  }
  dinnerView();
  try {
    const result = await api('/api/dinner/next', { method: 'POST', body: JSON.stringify({ ids: previous.map((o) => o.id) }) });
    if (state.dinner !== dinner) return;
    Object.assign(dinner, result, { switching: false, askingReason: false, accepted: false });
    dinnerView(); scheduleDinnerPrefetch(dinner);
  } catch (error) {
    if (state.dinner !== dinner) return;
    dinner.recommendations = previous; dinner.recommendation = previous[0]; dinner.reserve = previousReserve; dinner.switching = false;
    dinnerView(); toast(error.message);
  }
}

function onboardingView() {
  if (state.onboarding.tasteOnly) return tastePreferencesView();
  const data = state.onboarding, step = data.step;
  const choices = (items, selected, field) => `<div class="dinner-options">${items.map(([value, label]) => `<button type="button" class="dinner-option ${selected === value ? 'selected' : ''}" data-${field}="${value}">${label}</button>`).join('')}</div>`;
  const content = [
    `<h1>Для кого обычно готовишь?</h1>${choices([['self', 'Для себя'], ['couple', 'Для двоих'], ['family', 'Для семьи']], data.householdType, 'household')}<label class="dinner-help" for="dinner-household-size">Сколько человек за столом?</label><input class="field" id="dinner-household-size" type="number" min="1" max="10" inputmode="numeric" value="${data.householdSize || ''}" placeholder="Например, 3"><p class="dinner-help">Есть дети?</p>${choices([['yes','Да'],['no','Нет']], data.hasChildren === null ? null : data.hasChildren ? 'yes' : 'no', 'children')}`,
    `<h1>Сколько времени есть на ужин?</h1>${choices([['15', 'До 15 минут'], ['30', 'До 30 минут'], ['60', 'До 60 минут'], ['any', 'Неважно']], data.preferredMaxCookingTime === null ? 'any' : String(data.preferredMaxCookingTime), 'time')}`,
    `<h1>Есть ли аллергия?</h1><p>Назови аллергены и другие продукты, которые нужно исключить.</p><input class="field" id="dinner-excluded" value="${esc(data.excludedIngredients)}" placeholder="Например: грибы, арахис"><p class="dinner-help">Разделяй продукты запятыми. Если аллергии и исключений нет, оставь поле пустым.</p>`,
    tasteChoices(data.preferredCategories)
  ][step];
  root.innerHTML = `${header()}<main class="dinner-page"><button class="back-link" id="dinner-home">← На главную</button><div class="eyebrow">БЫСТРАЯ НАСТРОЙКА · ${step + 1} ИЗ 4</div><section class="dinner-onboarding">${content}<div class="dinner-actions"><button class="primary accent" id="onboarding-next">${step === 3 ? 'Показать ужин' : 'Дальше'}</button>${step !== 2 ? '<button class="secondary" id="onboarding-skip">Пропустить</button>' : ''}</div></section></main>`;
  bindCommon();
  document.querySelector('#dinner-home').onclick = () => { state.onboarding = null; setRoute({}); render(); };
  document.querySelectorAll('[data-household]').forEach((button) => button.onclick = () => { data.householdType = button.dataset.household; data.householdSize = button.dataset.household === 'self' ? 1 : button.dataset.household === 'couple' ? 2 : data.householdSize > 2 ? data.householdSize : null; onboardingView(); });
  document.querySelector('#dinner-household-size')?.addEventListener('input', (event) => { const value = Number(event.target.value); data.householdSize = Number.isInteger(value) && value >= 1 && value <= 10 ? value : null; });
  document.querySelectorAll('[data-children]').forEach((button) => button.onclick = () => { data.hasChildren = button.dataset.children === 'yes'; onboardingView(); });
  document.querySelectorAll('[data-time]').forEach((button) => button.onclick = () => { data.preferredMaxCookingTime = button.dataset.time === 'any' ? null : Number(button.dataset.time); onboardingView(); });
  bindTasteChoices(data, onboardingView);
  const advance = async (skip = false) => {
    if (data.saving) return;
    if (step === 2) data.excludedIngredients = document.querySelector('#dinner-excluded').value;
    if (step < 3) { data.step += 1; onboardingView(); return; }
    data.saving = true;
    document.querySelector('#onboarding-next').disabled = true;
    document.querySelector('#onboarding-skip').disabled = true;
    try {
      const profile = await api('/api/dinner/profile', { method: 'PUT', body: JSON.stringify({ householdType: data.householdType, householdSize: data.householdSize, hasChildren: data.hasChildren, preferredMaxCookingTime: data.preferredMaxCookingTime, excludedIngredients: data.excludedIngredients.split(',').map((item) => item.trim()).filter(Boolean), ...(!skip ? { preferredCategories: data.preferredCategories } : {}), tastePreferencesStatus: skip ? 'skipped' : 'completed', onboardingCompleted: true }) });
      state.dinner.profile = profile; state.onboarding = null; await beginDinner();
    } catch (error) { data.saving = false; onboardingView(); toast(error.message); }
  };
  document.querySelector('#onboarding-next').onclick = () => advance();
  document.querySelector('#onboarding-skip')?.addEventListener('click', () => advance(true));
}

function dinnerChoiceCard(option, index) {
  const recipe = option.recipe;
  const image = safeImage(recipe.thumbnailUrl);
  const minutes = totalTime(recipe);
  const pitch = option.pitch || { label: index === 0 ? 'На сегодня' : 'Ещё вариант', reason: option.reasons?.[0] || '' };
  const discovery = option.role === 'variety' && recipe.discovery;
  const reason = [discovery || option.role === 'familiar' || option.role === 'quick' ? pitch.label : pitch.reason, minutes ? `${minutes} мин` : null].filter(Boolean).join(' · ');
  const missing = option.pantryMatch?.missing?.length ? `<p class="dinner-menu-missing">Докупить: ${esc(option.pantryMatch.missing.join(', '))}</p>` : '';
  const servingNote = state.dinner?.profile?.householdSize && recipe.servings && recipe.servings < state.dinner.profile.householdSize ? `<p class="dinner-menu-ingredients">Рецепт на ${recipe.servings} чел. — увеличь количество продуктов</p>` : '';
  return `<li class="dinner-menu-item"><span class="dinner-menu-index" aria-hidden="true">${String(index + 1).padStart(2, '0')}</span><div class="dinner-menu-body"><p class="dinner-menu-reason">${esc(reason)}</p><div class="dinner-menu-title"><h2>${esc(recipe.title)}</h2>${image ? `<img src="${image}" alt="" referrerpolicy="no-referrer">` : ''}</div>${discovery ? `<p class="dinner-menu-ingredients">${esc(pitch.reason)}</p>` : ''}${missing}${servingNote}<div class="dinner-menu-actions"><button class="dinner-pick-button" ${state.dinner?.switching ? 'disabled' : ''} data-dinner-accept="${esc(option.id)}">Готовим <span aria-hidden="true">→</span></button><button class="dinner-recipe-link" data-dinner-full="${esc(option.id)}">Рецепт</button></div></div></li>`;
}

function updateDinnerIngredients() {
  const url = 'https://t.me/Recipeboibot?start=ingredients';
  if (window.Telegram?.WebApp?.openTelegramLink) window.Telegram.WebApp.openTelegramLink(url);
  else window.location.href = url;
}

function dinnerView() {
  if (state.onboarding) return onboardingView();
  const dinner = state.dinner, items = dinner?.recommendations || [];
  const item = dinner?.accepted ? dinner.recommendation : items[0], recipe = item?.recipe;
  const content = dinner?.askingReason ? `<section class="dinner-decision"><div class="eyebrow">ПОМОГИ УТОЧНИТЬ ВЫБОР</div><h1>Почему не подходит?</h1><div class="dinner-options">${[['too_long','Долго'],['not_today','Не хочется'],['recently_ate','Недавно ел'],['missing_ingredients','Нет ингредиентов'],['too_hard','Слишком сложно'],['other','Другое']].map(([key, label]) => `<button class="dinner-option" data-reason="${key}">${label}</button>`).join('')}</div><button class="manual-save" id="reason-skip">Пропустить</button></section>`
    : !recipe ? `<section class="dinner-decision"><h1>Сегодня на ужин</h1><p>${esc(dinner?.message || 'Подбираю подходящий вариант…')}</p>${dinner.loading ? '' : '<div class="dinner-actions"><button class="secondary" id="dinner-retry">Попробовать снова</button><button class="manual-save" id="dinner-pantry-update">Назвать другие продукты</button><button class="manual-save" id="dinner-settings">Изменить предпочтения</button></div>'}</section>`
    : dinner.accepted ? `<section class="dinner-decision"><div class="eyebrow">РЕШЕНО · СЕГОДНЯ НА УЖИН</div><h1>${esc(recipe.title)}</h1><p>Отличный выбор. Рецепт под рукой, когда будешь готовить.</p><div class="dinner-actions"><button class="primary accent" id="dinner-start-cooking">Начать готовить</button><button class="secondary" id="dinner-full-recipe">Открыть рецепт</button><button class="manual-save" id="dinner-mark-cooked" ${dinner.cooked ? 'disabled' : ''}>${dinner.cooked ? 'Приготовлено ✓' : 'Уже приготовил ✓'}</button></div></section>`
    : `<section class="dinner-decision dinner-picks"><h1>Что на ужин?</h1>${dinner.notice ? `<p class="dinner-help">${esc(dinner.notice)}</p>` : ''}<ol class="dinner-menu">${items.map(dinnerChoiceCard).join('')}</ol><div class="dinner-actions"><button class="secondary" id="dinner-reject-batch" ${dinner.switching ? 'disabled' : ''}>${dinner.switching ? 'Обновляю варианты…' : 'Показать другие варианты'}</button>${dinner.retryCount >= 2 && dinner.lastRejectedId ? '<button class="manual-save" id="dinner-reason-open">Почему предыдущие не подошли?</button>' : ''}${dinner.pantry?.length ? '<button class="manual-save" id="dinner-pantry-update">Продукты изменились</button>' : ''}<button class="manual-save" id="dinner-tastes">Мои вкусы</button>${dinner.needsOnboarding ? '<button class="manual-save" id="dinner-onboarding">Уточнить вкусы и ограничения</button>' : ''}</div></section>`;
  root.innerHTML = `${header()}<main class="dinner-page"><button class="back-link" id="dinner-home">← На главную</button>${content}${dinner?.cooked ? offerBanner() : ''}</main>`;
  bindCommon();
  document.querySelector('#dinner-home').onclick = () => { setRoute({}); render(); };
  document.querySelector('#dinner-settings')?.addEventListener('click', () => beginDinner(true));
  document.querySelector('#dinner-pantry-update')?.addEventListener('click', updateDinnerIngredients);
  document.querySelector('#dinner-retry')?.addEventListener('click', () => beginDinner());
  document.querySelector('#dinner-tastes')?.addEventListener('click', showDinnerTastePreferences);
  document.querySelector('#dinner-onboarding')?.addEventListener('click', showDinnerOnboarding);
  document.querySelectorAll('[data-dinner-accept]').forEach((button) => button.onclick = async () => { const selected = items.find((option) => option.id === button.dataset.dinnerAccept); button.disabled = true; if (!await acceptDinnerItem(selected)) button.disabled = false; });
  document.querySelector('#dinner-reject-batch')?.addEventListener('click', showNextDinner);
  document.querySelector('#dinner-reason-open')?.addEventListener('click', () => { dinner.askingReason = true; dinnerView(); });
  document.querySelectorAll('[data-reason]').forEach((button) => button.onclick = async () => { try { await api(`/api/dinner/recommendations/${dinner.lastRejectedId}/reason`, { method: 'POST', body: JSON.stringify({ reason: button.dataset.reason }) }); await loadDinnerRecommendation(); } catch (error) { toast(error.message); } });
  document.querySelector('#reason-skip')?.addEventListener('click', () => { dinner.askingReason = false; dinnerView(); });
  document.querySelectorAll('[data-dinner-full]').forEach((button) => button.onclick = () => { const selected = items.find((option) => option.id === button.dataset.dinnerFull); openRecipe(selected.recipe.id, true); });
  document.querySelector('#dinner-full-recipe')?.addEventListener('click', () => { openRecipe(recipe.id, true); });
  document.querySelector('#dinner-start-cooking')?.addEventListener('click', () => { if (recipe.steps?.length) cookMode(recipe, () => markDinnerCooked(item.id)); else openRecipe(recipe.id, true); });
  document.querySelector('#dinner-mark-cooked')?.addEventListener('click', () => markDinnerCooked(item.id));
}

async function acceptDinnerItem(option) {
  if (!option || !state.dinner) return false;
  try {
    const result = await api(`/api/dinner/recommendations/${option.id}/accept`, { method: 'POST', body: '{}' });
    if (result.status !== 'accepted') throw new Error('Этот вариант уже недоступен');
    state.dinner.recommendation = option;
    state.dinner.accepted = true;
    dinnerView();
    return true;
  } catch (error) { toast(error.message); return false; }
}

async function cookFromDinnerDetail(recipe) {
  const inDinner = new URLSearchParams(location.search).get('view') === 'dinner';
  const option = inDinner ? state.dinner?.recommendations.find((item) => item.recipe.id === recipe.id) : null;
  if (option && !state.dinner.accepted && !await acceptDinnerItem(option)) return;
  if (option) closeOverlay();
  cookMode(recipe, option && state.dinner?.recommendation?.id === option.id ? () => markDinnerCooked(option.id) : null);
}

async function markDinnerCooked(id) {
  try { await api(`/api/dinner/recommendations/${id}/cooked`, { method: 'POST', body: '{}' }); await refresh(); if (state.dinner?.recommendation?.id === id) { state.dinner.cooked = true; dinnerView(); } toast('Готово! Учту этот выбор в следующих рекомендациях.'); }
  catch (error) { toast(error.message); }
}


function searchView() {
  root.innerHTML = `${header()}<main><button class="back-link" id="back-home">← На главную</button><section class="search-page"><div class="eyebrow">Что приготовить?</div><h1>Найдём в вашей коллекции</h1><p>Напишите продукты, блюдо или ограничение по времени.</p><form class="search-wrap" id="search-form"><input class="search" id="search" value="${esc(state.query)}" placeholder="Курица, крылышки с мёдом…" autofocus><button class="primary accent" aria-label="Найти">Найти</button></form></section>${!state.recipes.length ? '<div class="empty"><h2>Коллекция пока пуста</h2><p>Попробуйте поиск. Если совпадений нет, вы сами решите, создавать ли новый рецепт.</p></div>' : ''}</main>`;
  bindCommon(); document.querySelector('#back-home').onclick = () => { setRoute({}); render(); };
  document.querySelector('#search-form').onsubmit = (event) => { event.preventDefault(); const query = document.querySelector('#search').value.trim(); if (!query) return; state.query = query; setRoute({ view: 'results', q: query }); loadAndRender(); };
}

function suggestionSection(suggestion) {
  const r = suggestion.recipe;
  return `<section class="suggestion"><div class="eyebrow">Создано в «Рецептах»</div><h2>${esc(r.title)}</h2>${r.description ? `<p>${esc(r.description)}</p>` : ''}<div class="meta">${totalTime(r) ? `<span>⏱ ${totalTime(r)} мин</span>` : ''}${r.servings ? `<span>${esc(r.servings)} порции</span>` : ''}</div><h3>Ингредиенты</h3><ul>${r.ingredients.map((item) => `<li>${esc(ingredientText(item))}</li>`).join('')}</ul><h3>Приготовление</h3><ol>${r.steps.map((step) => `<li>${esc(step.text)}</li>`).join('')}</ol>${r.warnings?.length ? `<p class="suggestion-warning">${r.warnings.map(esc).join('<br>')}</p>` : ''}<p>Добавить этот рецепт в «Мои рецепты»?</p><button class="primary accent" id="save-suggestion" type="button">Добавить рецепт</button><button class="secondary" id="dismiss-suggestion" type="button">Не добавлять</button></section>`;
}

function collection(recipes = state.recipes, title = 'Мои рецепты', suggestion = null) {
  const emptyState = state.query
    ? suggestion ? suggestionSection(suggestion) : '<div class="empty"><h2>Совпадений нет</h2><p>Мы не нашли в вашей коллекции рецепт по такому запросу. Хотите, чтобы мы предложили вам наш вариант рецепта?</p><div class="empty-search-actions"><button class="primary accent" id="generate-suggestion" type="button">Создать новый рецепт</button><button class="secondary" id="change-query" type="button">Изменить запрос</button><button class="secondary" id="show-all" type="button">Открыть всю коллекцию</button></div></div>'
    : '<div class="empty collection-empty"><div class="eyebrow">Ваша коллекция начинается здесь</div><h2>Добавьте первый рецепт</h2><p>Вставьте ссылку, напишите рецепт или загрузите фото. После обработки он появится здесь.</p><button class="primary accent" id="add" type="button">Добавить первый рецепт</button><p class="empty-hint">Голосовое можно отправить боту в чате.</p></div>';
  root.innerHTML = `${header()}<main><button class="back-link" id="back-home">← На главную</button><div class="section-head page-title"><h1>${esc(title)}</h1><span>${recipes.length}</span></div>${offerBanner()}${state.jobs.length ? `<div class="grid jobs-grid">${state.jobs.map(jobCard).join('')}</div>` : ''}${recipes.length ? `<div class="grid">${recipes.map(card).join('')}</div>` : emptyState}${recipes.length || state.query ? '<button class="manual-save" id="add">Сохранить рецепт вручную</button>' : ''}</main>`;
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
    try { const recipe = await api(`/api/suggestions/${encodeURIComponent(suggestion.id)}/save`, { method: 'POST' }); await refresh(); toast('Рецепт добавлен в коллекцию'); await openRecipe(recipe.id, true); if (recipe.origin === 'generated' && !recipe.thumbnailUrl) void waitForRecipeImage(recipe.id); }
    catch (error) { toast(error.message); button.disabled = false; button.textContent = 'Добавить рецепт'; }
  });
}

async function render() {
  const params = new URLSearchParams(location.search); const view = params.get('view'); state.query = params.get('q') || '';
  if (view === 'offer' && state.me?.testContour) offerPage();
  else if (view === 'checkout' && state.me?.testContour) checkoutPage();
  else if (view === 'payment-result' && state.me?.testContour) paymentResultPage();
  else if (view === 'results') {
    let results = [];
    try { results = state.query ? await api(`/api/search?q=${encodeURIComponent(state.query)}`) : state.recipes; } catch (error) { toast(error.message); }
    collection(results, state.query ? `Результаты: ${state.query}` : 'Результаты');
  } else if (view === 'dinner') { if (!state.dinner) await beginDinner(); else dinnerView(); }
  else if (view === 'collection') collection();
  else if (view === 'search') searchView();
  else if (view === 'add') { home(); setRoute({}, { replace: true }); importSheet(); }
  else home();
  const recipeId = params.get('recipe'); if (recipeId) await openRecipe(recipeId, false);
}

async function refresh() {
  const library = await api('/api/library', { signal: AbortSignal.timeout(12000) });
  state.recipes = library.recipes; state.jobs = library.jobs;
  if (state.me?.testContour) state.payment = await api('/api/test/payment', { signal: AbortSignal.timeout(12000) });
}
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
  } catch (error) {
    if (error.status === 402) { closeOverlay(); await refresh(); openOffer(); return; }
    toast(error.message); button.disabled = false; button.textContent = 'Сохранить';
  }
}

function closeDetailRoute() {
  closeOverlay();
  if (history.state?.recipeOverlay) history.back();
  else { const url = new URL(location.href); url.searchParams.delete('recipe'); history.replaceState({}, '', url); }
}

async function openRecipe(id, pushRoute = false) {
  try {
    if (pushRoute) { state.scrollY = scrollY; const params = Object.fromEntries(new URLSearchParams(location.search)); params.recipe = id; setRoute(params, { historyState: { recipeOverlay: true, scrollY: state.scrollY } }); }
    closeOverlay(); const recipe = await api(`${/^(seed|dinner):/.test(id) ? '/api/dinner/recipes' : '/api/recipes'}/${encodeURIComponent(id)}`); recipeDetail(recipe); if (recipe.dinnerGenerated && !recipe.thumbnailUrl) void waitForRecipeImage(recipe.id);
  } catch (error) { toast(error.message); }
}

async function waitForRecipeImage(id) {
  for (let attempt = 0; attempt < 36; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    if (new URLSearchParams(location.search).get('recipe') !== id || !document.querySelector('.recipe-detail-sheet')) return;
    try {
      const recipe = await api(`${id.startsWith('dinner:') ? '/api/dinner/recipes' : '/api/recipes'}/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(12000) });
      if (new URLSearchParams(location.search).get('recipe') !== id || !document.querySelector('.recipe-detail-sheet')) return;
      if (!recipe.thumbnailUrl) continue;
      state.recipes = state.recipes.map((item) => item.id === id ? recipe : item);
      closeOverlay(); recipeDetail(recipe);
      return;
    } catch { /* Retry while this recipe remains open. */ }
  }
}

function recipeDetail(r, { shared = false, suggestion = null } = {}) {
  const catalog = r.origin === 'seed' || r.dinnerGenerated || Boolean(suggestion);
  const dinnerOption = state.dinner?.recommendations.find((option) => option.recipe.id === r.id);
  const missing = dinnerOption?.pantryMatch?.missing || r.pantryMatch?.missing || [];
  const shopping = missing.length ? `<aside class="detail-shopping"><strong>Докупить</strong><p>${esc(missing.join(', '))}</p></aside>` : '';
  const image = safeImage(r.thumbnailUrl);
  const imagePending = Boolean(suggestion && !image);
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
  const tags = (r.tags || []).map((tag) => shared || catalog ? `<span class="recipe-tag">${esc(tag)}</span>` : `<button class="recipe-tag" type="button" data-tag="${esc(tag)}">${esc(tag)}</button>`).join('');
  const warnings = (r.warnings || []).map((item) => `<li>${esc(item)}</li>`).join('');
  const warningCount = (r.warnings || []).length;
  const ingredients = (r.ingredients || []).map((item) => {
    const amount = [item.quantity, item.unit].filter((value) => value !== null && value !== '').join(' ');
    return `<div class="ingredient-row"><div><strong>${esc(item.name || item.raw)}</strong>${item.comment ? `<small>${esc(item.comment)}</small>` : ''}</div>${amount ? `<span>${esc(amount)}</span>` : '<span class="amount-empty">по вкусу</span>'}</div>`;
  }).join('') || '<p class="detail-empty">Ингредиенты не извлечены</p>';
  const steps = (r.steps || []).map((item, index) => `<div class="step-card"><span class="step-number">${index + 1}</span><p>${esc(item.text)}</p></div>`).join('') || '<p class="detail-empty">Шаги не извлечены</p>';
  const sharedIntro = shared ? `<section class="shared-intro"><div class="shared-avatar">${esc((r.sharedBy || 'П').trim()[0]?.toLocaleUpperCase('ru') || 'П')}</div><div><strong>${esc(r.sharedBy || 'Пользователь')} делится рецептом</strong><p>Рецепт сохранён в сервисе «Рецепты» — он собирает рецепты из ссылок, фото, текста и голосовых.</p><a href="https://t.me/Recipeboibot?start=dinner" target="_blank" rel="noopener noreferrer">Подробнее о сервисе →</a></div></section>` : '';
  const backButton = shared ? '' : '<button class="detail-back" type="button" data-close aria-label="Назад"><span aria-hidden="true">←</span> Назад</button>';
  const editButton = shared || catalog ? '' : '<button class="detail-edit" id="edit" type="button">Изменить</button>';
  const actions = suggestion
    ? '<div class="detail-actions"><button class="primary accent" id="save-suggestion" type="button">Добавить в мои рецепты</button><button class="secondary" id="cook" type="button">Начать готовить</button></div>'
    : shared || catalog
    ? `<div class="detail-actions shared-actions"><button class="primary accent" id="cook" ${r.steps?.length ? '' : 'disabled'}>Начать готовить</button></div>`
    : `<div class="detail-actions"><button class="secondary share-button" id="share">Поделиться</button><button class="primary accent" id="cook" ${r.steps?.length ? '' : 'disabled'}>Начать готовить</button></div>`;
  const el = overlay(`${sharedIntro}<div class="detail-media ${image ? 'has-preview' : imagePending ? 'pending-preview' : 'no-preview'}">${image ? `<img src="${image}" alt="" referrerpolicy="no-referrer">` : imagePending ? '<div class="recipe-image-wait"><span aria-hidden="true">✦</span><p>Готовлю изображение блюда…</p></div>' : ''}${backButton}<div class="detail-media-source">${sourceChip}</div></div><div class="detail-content"><div class="detail-heading"><div class="detail-heading-tools"><div class="eyebrow">${shared ? 'Рецепт по ссылке' : suggestion || r.dinnerGenerated ? 'Создано для тебя' : catalog ? 'Из нашей подборки' : 'Сохранённый рецепт'}</div>${editButton}</div><h1>${esc(r.title)}</h1>${stats ? `<div class="detail-stats">${stats}</div>` : ''}${r.description ? `<p class="detail-lead">${esc(r.description)}</p>` : ''}${tags ? `<div class="recipe-tags">${tags}</div>` : ''}</div>${shopping}${warnings ? `<details class="quality-card"><summary><span><b>Что стоит проверить</b><small>${suggestion || r.origin === 'generated' ? 'Автоматический рецепт' : 'Автоматическое извлечение'} · ${warningCount}</small></span><span class="quality-toggle">＋</span></summary><ul>${warnings}</ul></details>` : ''}<section class="recipe-panel ingredients-panel"><div class="recipe-panel-head"><div><span class="section-kicker">Список продуктов</span><h2>Ингредиенты</h2></div><span>${r.ingredients?.length || 0}</span></div><div class="ingredient-list">${ingredients}</div></section><section class="recipe-panel steps-panel"><div class="recipe-panel-head"><div><span class="section-kicker">По порядку</span><h2>Как готовить</h2></div><span>${r.steps?.length || 0}</span></div><div class="step-list">${steps}</div></section>${r.notes ? `<section class="recipe-panel note-panel"><div class="recipe-panel-head"><div><span class="section-kicker">Личное</span><h2>Заметки</h2></div></div><p>${esc(r.notes)}</p></section>` : ''}</div>${actions}`, `recipe-detail-sheet${shared ? ' shared-recipe-sheet' : ''}`, !shared);
  if (suggestion) el.querySelector('.recipe-detail-sheet').dataset.suggestionId = suggestion.id;
  if (imagePending) void waitForSuggestionImage(suggestion.id, el);
  if (shared) el.classList.add('shared-overlay');
  if (!shared && offerBanner()) {
    const banner = document.createElement('div');
    banner.innerHTML = offerBanner();
    el.querySelector('.detail-content')?.append(banner);
    banner.querySelector('[data-open-offer]')?.addEventListener('click', openOffer);
  }
  el.querySelector('[data-close]')?.addEventListener('click', closeDetailRoute);
  el.querySelector('#edit')?.addEventListener('click', () => { closeOverlay(); editRecipe(r); });
  el.querySelector('#save-suggestion')?.addEventListener('click', async (event) => {
    const button = event.currentTarget; button.disabled = true; button.textContent = 'Сохраняю…';
    try { const saved = await api(`/api/suggestions/${encodeURIComponent(suggestion.id)}/save`, { method: 'POST', body: '{}' }); await refresh(); closeOverlay(); await openRecipe(saved.id, true); toast('Рецепт добавлен в коллекцию'); }
    catch (error) { toast(error.message); button.disabled = false; button.textContent = 'Добавить в мои рецепты'; }
  });
  el.querySelector('#share')?.addEventListener('click', (event) => shareRecipe(r, event.currentTarget));
  el.querySelector('#cook').onclick = () => { void cookFromDinnerDetail(r); };
  el.querySelector('[data-source-link]')?.addEventListener('click', (event) => {
    if (!tg?.openLink) return;
    event.preventDefault();
    try { tg.openLink(r.sourceUrl); }
    catch { window.open(r.sourceUrl, '_blank', 'noopener,noreferrer'); }
  });
  el.querySelectorAll('[data-tag]').forEach((button) => button.onclick = () => { closeOverlay(); state.query = button.dataset.tag; setRoute({ view: 'results', q: state.query }, { replace: true }); loadAndRender(); });
}

async function waitForSuggestionImage(id, overlayElement) {
  for (let attempt = 0; attempt < 72; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    if (!overlayElement.isConnected) return;
    try {
      const result = await api(`/api/suggestions/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(12000) });
      const url = safeImage(result.recipe?.thumbnailUrl);
      if (!url) continue;
      const media = overlayElement.querySelector('.detail-media');
      if (!media || !overlayElement.isConnected) return;
      media.querySelector('.recipe-image-wait')?.remove();
      const img = document.createElement('img'); img.src = url; img.alt = ''; img.referrerPolicy = 'no-referrer';
      media.prepend(img); media.classList.remove('pending-preview'); media.classList.add('has-preview');
      return;
    } catch { /* The card remains usable if a poll fails. */ }
  }
  overlayElement.querySelector('.recipe-image-wait p')?.replaceChildren('Фото пока не получилось. Рецепт уже готов.');
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
    root.innerHTML = `<main class="outside"><div class="brand-mark">!</div><h1>Рецепт недоступен</h1><p>${esc(error.message)}</p><a class="primary accent" href="https://t.me/Recipeboibot?start=dinner" style="text-decoration:none">Открыть сервис ↗</a></main>`;
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
function cookMode(r, onComplete = null) { state.cookStep = 0; const el = document.createElement('div'); el.className = 'cook'; const draw = () => { el.innerHTML = `<div class="cook-top"><span>${state.cookStep + 1} из ${r.steps.length}</span><button class="icon-btn" id="cook-close">✕</button></div><div class="cook-step">${esc(r.steps[state.cookStep].text)}</div><div class="cook-nav"><button class="secondary" id="prev" ${state.cookStep === 0 ? 'disabled' : ''}>← Назад</button><button class="primary accent" id="next">${state.cookStep === r.steps.length - 1 ? 'Готово ✓' : 'Дальше →'}</button></div>`; el.querySelector('#cook-close').onclick = () => el.remove(); el.querySelector('#prev').onclick = () => { state.cookStep--; draw(); }; el.querySelector('#next').onclick = () => { if (state.cookStep === r.steps.length - 1) { el.remove(); onComplete?.(); } else { state.cookStep++; draw(); } }; }; draw(); document.body.append(el); }
function settingsSheet() {
  const el = overlay(`<div class="sheet-head"><div><div class="eyebrow">ПРОФИЛЬ</div><h2>${esc(state.me.displayName)}</h2></div><button class="icon-btn" data-close>✕</button></div><p class="help">Коллекция привязана к вашему Telegram и недоступна другим пользователям. Закрытые источники могут не обработаться; отсутствующие сведения не додумываются.</p><button class="secondary" id="dinner-preferences">Предпочтения для ужина</button>${state.me.testContour ? '<button class="secondary" id="test-payment">Тестовая оплата</button><button class="ghost" id="test-reset">Сбросить тестовый профиль</button>' : ''}<button class="ghost" id="delete-account">Удалить мои данные</button>`);
  el.querySelector('[data-close]').onclick = closeOverlay;
  el.querySelector('#dinner-preferences').onclick = () => { closeOverlay(); setRoute({ view: 'dinner' }); beginDinner(true); };
  el.querySelector('#test-payment')?.addEventListener('click', openOffer);
  el.querySelector('#test-reset')?.addEventListener('click', async () => {
    if (!confirm('Сбросить тестовый профиль, рецепты, историю ужинов и результат имитации оплаты?')) return;
    try {
      await api('/api/test/reset', { method: 'POST', body: '{}' });
      closeOverlay();
      root.innerHTML = '<main class="outside"><div class="brand-mark">Р</div><h1>Тестовый профиль сброшен</h1><p>Вернитесь в чат бота и нажмите /start, чтобы пройти путь нового пользователя.</p></main>';
    } catch (error) { toast(error.message); }
  });
  el.querySelector('#delete-account').onclick = async () => { if (!confirm('Безвозвратно удалить профиль и все рецепты?')) return; await api('/api/account', { method: 'DELETE' }); location.reload(); };
}

function offerPage() {
  const payment = state.payment;
  const price = payment?.offer?.priceRub;
  root.innerHTML = `${header()}<main class="offer-page"><button class="back-link" id="offer-back">← На главную</button><div class="offer-hero"><span class="offer-kicker">Рецепты Плюс · тестовое предложение</span><h1>${payment?.active ? 'Доступ открыт' : payment?.hasFirstRecipe ? 'Первый рецепт готов. Продолжим?' : 'Сначала попробуйте первый рецепт'}</h1><p>${payment?.active ? 'Автоматический импорт доступен в тестовом контуре.' : payment?.hasFirstRecipe ? `Сохраняйте следующие рецепты из ссылок, фото и текста.${payment.firstValue === 'saved' ? ' Первый сохранённый рецепт остаётся в коллекции.' : ' Первый ужин уже позади.'}` : 'После первого сохранённого или приготовленного рецепта здесь появится предложение.'}</p></div>${payment?.hasFirstRecipe ? `<section class="offer-plan"><div class="offer-plan-top"><span>Месячный доступ</span><span class="offer-test-pill">ТЕСТ</span></div><div class="offer-price">${price} ₽ <small>/ месяц</small></div><ul><li>Автоматическое сохранение следующих рецептов</li><li>Вся коллекция и уже сохранённые рецепты под рукой</li><li>Выбор оплаты картой или через СБП в макете</li></ul>${payment.active ? '<div class="offer-active">✓ Тестовый доступ активен</div>' : '<button class="primary accent" id="go-checkout">Перейти к оплате →</button>'}<p class="offer-fineprint">Демонстрационный сценарий. Реального платежа и автоматического списания нет.</p></section>` : ''}<p class="offer-support">В тестовом контуре можно проверить успех, ошибку и отмену платежа. Для нового прохождения используйте сброс профиля в настройках.</p></main>`;
  bindCommon();
  document.querySelector('#offer-back').onclick = () => { setRoute({}); void render(); };
  document.querySelector('#go-checkout')?.addEventListener('click', () => { setRoute({ view: 'checkout' }); checkoutPage(); });
}

function checkoutPage() {
  const payment = state.payment;
  if (!payment?.hasFirstRecipe || payment.active) { setRoute({ view: 'offer' }, { replace: true }); offerPage(); return; }
  const order = state.checkoutOrder || payment.pendingOrder;
  const price = order?.priceRub || payment.offer.priceRub;
  const confirmStep = Boolean(order);
  root.innerHTML = `<main class="checkout-page"><div class="checkout-shell"><div class="checkout-test-strip">ТЕСТОВЫЙ РЕЖИМ · ДЕНЬГИ НЕ СПИСЫВАЮТСЯ</div><header class="checkout-header"><button type="button" id="checkout-back" aria-label="Вернуться">←</button><span class="checkout-provider">● pay<span>demo</span></span><span class="checkout-safe">⌁ Защищённая форма</span></header><div class="checkout-body"><div class="checkout-merchant"><span class="checkout-merchant-logo">Р</span><div><small>Оплата заказа для</small><strong>Рецепты</strong></div></div><div class="checkout-total"><span>К оплате</span><strong>${price} ₽</strong></div><div class="checkout-order-lines"><span>Рецепты Плюс · 1 месяц</span><b>${price} ₽</b></div><div class="checkout-order-lines muted"><span>Комиссия</span><b>0 ₽</b></div>${confirmStep ? `<div class="checkout-bank-step"><span class="checkout-step-icon">${order.method === 'sbp' ? '↗' : '▣'}</span><h1>${order.method === 'sbp' ? 'Подтвердите платёж в банке' : 'Подтвердите оплату'}</h1><p>${order.method === 'sbp' ? 'В реальном сценарии здесь открылось бы приложение выбранного банка для подтверждения через СБП.' : 'В реальном сценарии здесь появилось бы подтверждение банка по карте.'}</p><div class="checkout-order-id">Заказ № ${esc(order.id.slice(0, 8).toUpperCase())}</div><div class="checkout-scenarios"><span>Выберите исход тестового платежа</span><button class="checkout-pay" data-payment-result="success">Подтвердить · ${price} ₽</button><button class="checkout-alt" data-payment-result="failure">Показать ошибку оплаты</button><button class="checkout-alt" data-payment-result="cancel">Отменить платёж</button></div></div>` : `<h1 class="checkout-title">Выберите способ оплаты</h1><div class="checkout-methods"><button type="button" class="checkout-method ${state.paymentMethod === 'card' ? 'selected' : ''}" data-method="card"><span class="checkout-method-icon">▣</span><span><strong>Банковская карта</strong><small>Мир · Visa · Mastercard</small></span><span class="checkout-radio"></span></button><button type="button" class="checkout-method ${state.paymentMethod === 'sbp' ? 'selected' : ''}" data-method="sbp"><span class="checkout-method-icon sbp">СБП</span><span><strong>Система быстрых платежей</strong><small>Подтверждение в приложении банка</small></span><span class="checkout-radio"></span></button></div>${state.paymentMethod === 'card' ? '<div class="checkout-demo-form"><div class="checkout-field"><span>Номер карты</span><strong>•••• •••• •••• 4242</strong></div><div class="checkout-field-row"><div class="checkout-field"><span>Срок действия</span><strong>•• / ••</strong></div><div class="checkout-field"><span>CVC / CVV</span><strong>•••</strong></div></div><small>Демо-поля. Номер карты и CVC вводить не нужно.</small></div>' : '<div class="checkout-demo-form"><span class="checkout-field-label">Банк для подтверждения</span><div class="checkout-bank-list"><span>Сбербанк</span><span>Т-Банк</span><span>ВТБ</span><span>Другой банк</span></div><small>В тесте приложение банка не откроется.</small></div>'}<button class="checkout-pay" id="checkout-continue">${state.paymentMethod === 'sbp' ? 'Перейти к подтверждению' : 'Оплатить'} · ${price} ₽</button>`}<p class="checkout-notice">Это макет платёжной страницы. Платёжный сервис не подключён; реквизиты карты не запрашиваются и деньги не списываются.</p></div></div></main>`;
  document.querySelector('#checkout-back').onclick = () => { setRoute({ view: 'offer' }); offerPage(); };
  document.querySelectorAll('[data-method]').forEach((button) => button.onclick = () => { state.paymentMethod = button.dataset.method; checkoutPage(); });
  document.querySelector('#checkout-continue')?.addEventListener('click', async (event) => {
    const button = event.currentTarget; button.disabled = true;
    try {
      state.checkoutOrder = await api('/api/test/orders', { method: 'POST', body: JSON.stringify({ method: state.paymentMethod }) });
      checkoutPage();
    } catch (error) { toast(error.message); button.disabled = false; }
  });
  document.querySelectorAll('[data-payment-result]').forEach((button) => button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const result = await api(`/api/test/orders/${encodeURIComponent(order.id)}/result`, { method: 'POST', body: JSON.stringify({ result: button.dataset.paymentResult }) });
      state.paymentResult = result.order.status;
      state.checkoutOrder = null;
      await refresh();
      if (result.order.status === 'success') {
        setRoute({ view: 'dinner' });
        await beginDinner(false, true);
        return;
      }
      setRoute({ view: 'payment-result' }); paymentResultPage();
    } catch (error) { toast(error.message); button.disabled = false; }
  }));
}

function paymentResultPage() {
  const result = state.paymentResult || state.payment?.lastResult;
  const success = result === 'success';
  root.innerHTML = `${header()}<main class="payment-result"><div class="checkout-test-strip">ТЕСТОВЫЙ РЕЖИМ · ДЕНЬГИ НЕ СПИСЫВАЮТСЯ</div><span class="payment-result-icon ${success ? 'success' : ''}">${success ? '✓' : result === 'cancel' ? '↶' : '!'}</span><h1>${success ? 'Оплата прошла' : result === 'cancel' ? 'Платёж отменён' : 'Не удалось оплатить'}</h1><p>${success ? 'Тестовый доступ открыт. Теперь можно сохранять следующие рецепты автоматически.' : 'Тестовый доступ пока не открыт. Уже пройденный рецепт остаётся доступен.'}</p><div class="payment-result-price">Рецепты Плюс · ${state.payment?.offer?.priceRub || '—'} ₽ / месяц</div><button class="primary accent" id="result-next">${success ? 'Вернуться к рецептам' : 'Повторить оплату'}</button><small>Реального списания не было.</small></main>`;
  bindCommon();
  document.querySelector('#result-next').onclick = () => { setRoute(success ? {} : { view: 'offer' }); void render(); };
}

window.addEventListener('popstate', async (event) => { if (!tg?.initData) return; closeOverlay(); await render(); requestAnimationFrame(() => scrollTo(0, event.state?.scrollY || 0)); });
async function boot() {
  const sharedMatch = location.pathname.match(/^\/share\/([A-Za-z0-9_-]{32})\/?$/);
  if (!sharedMatch && !tg?.initData) {
    window.miniProbe?.('missing-init-data');
    if (window.__miniLaunch) {
      document.querySelector('#landing')?.setAttribute('hidden', '');
      root.hidden = false;
      window.__miniRendered = true;
      root.innerHTML = '<main class="outside"><div class="brand-mark">!</div><h1>Не получилось войти</h1><p>Telegram не передал данные входа. Закройте окно и откройте приложение кнопкой в чате бота.</p></main>';
    }
    return;
  }
  window.miniProbe?.('app-boot');
  const landing = document.querySelector('#landing');
  if (landing) landing.hidden = true;
  root.hidden = false;
  if (sharedMatch) { await openSharedRecipe(sharedMatch[1]); return; }
  try {
    state.me = await api('/api/me', { signal: AbortSignal.timeout(12000) });
    window.miniProbe?.('profile-loaded');
    await refresh();
    window.miniProbe?.('library-loaded');
    window.__miniRendered = true;
    if (!await resumePendingTrialTastePreferences()) await render();
    window.miniProbe?.('view-rendered');
  } catch (error) {
    window.__miniRendered = true;
    window.miniProbe?.('app-error');
    root.innerHTML = `<main class="outside"><div class="brand-mark">!</div><h1>Не получилось войти</h1><p>${esc(error.message)}</p><p>Вернитесь в чат бота и нажмите Start.</p></main>`;
  }
}
boot();
