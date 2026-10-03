const tg = window.Telegram?.WebApp;
const root = document.querySelector('#app');
const toastEl = document.querySelector('#toast');
const state = { me: null, recipes: [], jobs: [], query: '', tab: 'text', cookStep: 0, scrollY: 0, dinner: null, onboarding: null, notificationSchedule: null, payment: null, checkoutOrder: null, paymentResult: null, paymentMethod: 'card', paymentPeriodMonths: 1, paymentPromoQuote: null, paymentPromoMessage: '', trialOnboarding: null };
let paymentPollTimer = null;
window.miniProbe?.('app-script');

tg?.ready(); tg?.expand();
// Keep drags inside the page from competing with Telegram's sheet gesture.
tg?.disableVerticalSwipes?.();
if (tg) { tg.setHeaderColor?.('#f3f0f7'); tg.setBackgroundColor?.('#f3f0f7'); }

const esc = (value = '') => String(value).replace(/[&<>"']/g, (x) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[x]);
const toast = (message) => { toastEl.textContent = message; toastEl.classList.add('show'); clearTimeout(toast.timer); toast.timer = setTimeout(() => toastEl.classList.remove('show'), 3500); };
const resetPageScroll = () => globalThis.requestAnimationFrame?.(() => globalThis.scrollTo?.(0, 0));
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
const cookingTimeLabel = (recipe) => {
  const prep = Number.isFinite(recipe.prepMinutes), cook = Number.isFinite(recipe.cookMinutes);
  if (prep && cook) return `${totalTime(recipe)} мин`;
  if (cook) return `${recipe.cookMinutes} мин готовки · подготовка не указана`;
  if (prep) return `${recipe.prepMinutes} мин подготовки · готовка не указана`;
  return 'Время не указано';
};
const initial = () => (state.me?.displayName || 'Я').trim()[0]?.toLocaleUpperCase('ru') || 'Я';
const ingredientText = (item) => [item.quantity, item.unit, item.name || item.raw].filter((x) => x !== null && x !== '').join(' ');
const safeImage = (value) => /^https:\/\//i.test(value || '') || (/^\/(?:recipe|dinner|suggestion)-images\/[0-9a-f-]{36}$/i.test(value || '') || /^\/shared-recipe-images\/[A-Za-z0-9_-]{32}$/.test(value || '') || /^\/assets\/dinner\/[a-z0-9-]+\.jpg$/i.test(value || '')) ? esc(value) : '';
let requestRecorder = null;

function setRoute(values, { replace = false, historyState = {} } = {}) {
  if (values.view && requestRecorder?.state === 'recording') requestRecorder.stop();
  const url = new URL(location.href);
  for (const key of ['view', 'q', 'recipe', 'notification']) url.searchParams.delete(key);
  for (const [key, value] of Object.entries(values)) if (value) url.searchParams.set(key, value);
  history[replace ? 'replaceState' : 'pushState'](historyState, '', url);
}

const trialOnboardingKey = () => `recipeboibot-trial-onboarding-v1:${state.me?.id || 'unknown'}`;
function savedTrialOnboardingStep() {
  try {
    const value = window.localStorage?.getItem(trialOnboardingKey());
    return ['taste', 'notifications', 'notifications-settings', 'collection'].includes(value) ? value : null;
  } catch { return null; }
}
function setTrialOnboardingStep(step) {
  state.trialOnboarding = step;
  try {
    if (step) window.localStorage?.setItem(trialOnboardingKey(), step);
    else window.localStorage?.removeItem(trialOnboardingKey());
  } catch {}
}

function header() {
  return `<header><button class="brand plain" data-home aria-label="На главную"><span class="brand-dot">Р</span><span>Твои рецепты</span></button><button class="avatar" id="settings" aria-label="Настройки профиля">${esc(initial())}</button></header>`;
}

function card(recipe) {
  const image = safeImage(recipe.thumbnailUrl);
  return `<article class="card"><button class="card-open" data-recipe="${esc(recipe.id)}" aria-label="Открыть рецепт: ${esc(recipe.title)}"><div class="card-art ${image ? 'has-image' : 'fallback'}">${image ? `<img src="${image}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<span>${recipe.origin === 'generated' ? 'Фото пока нет' : 'Превью<br>недоступно'}</span>`}<span class="badge">${esc(recipe.origin === 'generated' ? 'Создано в «Рецептах»' : recipe.sourceName || 'Личный рецепт')}</span></div><div class="card-body"><h3>${esc(recipe.title)}</h3><div class="meta"><span>${esc(cookingTimeLabel(recipe))}</span>${recipe.ingredients?.length ? `<span>${recipe.ingredients.length} ингредиентов</span>` : ''}</div></div></button><button class="card-remove" type="button" data-remove-recipe="${esc(recipe.id)}" aria-label="Удалить рецепт: ${esc(recipe.title)}">×</button></article>`;
}

function jobCard(job) {
  const image = safeImage(job.thumbnailUrl);
  const failed = ['failed', 'interrupted'].includes(job.status);
  return `<article class="card status-card"><div class="card-art ${image ? 'has-image' : 'fallback'}">${image ? `<img src="${image}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<span>Источник<br>получен</span>'}<span class="badge ${failed ? 'failed' : ''}">${failed ? 'Ошибка' : 'Обрабатывается'}</span></div><div class="card-body"><h3>${esc(job.label || 'Новый рецепт')}</h3><p class="status-copy">${failed ? esc(job.errorMessage || 'Не удалось обработать источник. Отправьте его ещё раз или добавьте текст.') : 'Можно закрыть приложение — статус сохранён.'}</p>${job.sourceUrl ? `<a class="source-inline" href="${esc(job.sourceUrl)}" target="_blank" rel="noopener noreferrer">Открыть источник ↗</a>` : ''}</div></article>`;
}

function bindCommon() {
  const main = root.querySelector('main');
  if (main && !document.querySelector('#feedback-form') && !main.querySelector('[data-feedback-link]')) main.insertAdjacentHTML('beforeend', '<p class="feedback-footer"><a href="/?view=feedback" data-feedback-link>Обратная связь</a></p>');
  document.querySelectorAll('[data-feedback-link]').forEach(el => el.addEventListener('click', event => { event.preventDefault(); closeOverlay(); setRoute({ view: 'feedback' }); feedbackPage(); }));
  document.querySelectorAll('a[href="/?view=promo"]').forEach(el => el.addEventListener('click', event => { event.preventDefault(); setRoute({ view: 'promo' }); promoPage(); }));
  document.querySelector('[data-home]')?.addEventListener('click', () => { setRoute({ view: 'menu' }); render(); });
  document.querySelector('#settings')?.addEventListener('click', settingsSheet);
  document.querySelectorAll('[data-open-notifications]').forEach((el) => el.addEventListener('click', () => {
    clearTimeout(dinnerPollTimer);
    setRoute({ view: 'notifications' });
    void render().catch((error) => toast(error.message));
  }));
  document.querySelectorAll('[data-recipe]').forEach((el) => el.addEventListener('click', () => openRecipe(el.dataset.recipe, true)));
  document.querySelectorAll('[data-remove-recipe]').forEach((el) => el.addEventListener('click', () => removeRecipeFromList(el.dataset.removeRecipe, el)));
  document.querySelectorAll('[data-open-offer]').forEach((el) => el.addEventListener('click', openOffer));
  if (document.querySelector('[data-open-offer]')) void api('/api/billing/exposure', { method: 'POST', body: '{}' }).catch(() => {});
}

function notificationEntry() {
  return state.payment?.active ? '<button class="notification-entry" type="button" data-open-notifications><span>Напоминания об ужине</span><span aria-hidden="true">→</span></button>' : '';
}

function offerBanner() {
  const payment = state.payment;
  if (payment?.firstRecipe?.available || payment?.firstRecipe?.pending) return '';
  if (payment?.trial?.eligible || payment?.trial?.used) {
    if (payment.active && payment.accessSource !== 'trial') return '';
    const active = payment.active;
    return `<section class="offer-banner"><h2>${active ? 'Пробный период активен' : payment.trial.used ? 'Пробный период закончился' : '7 дней бесплатно'}</h2><p>${active ? `Полный доступ до ${esc(new Date(payment.trial.expiresAt).toLocaleString('ru-RU'))}.` : payment.trial.used ? 'Сохранённые рецепты остаются в коллекции. Для продолжения оформите подписку.' : 'Сохраняйте рецепты, подбирайте ужин и настройте напоминания. Карта не нужна, списаний нет.'}</p><button class="primary accent" type="button" data-open-offer>${active ? 'Условия пробного периода' : payment.trial.used ? 'Продолжить с подпиской' : 'Попробовать 7 дней бесплатно'}</button></section>`;
  }
  if (!payment?.available || !payment?.hasFirstRecipe || payment.active) return '';
  const mock = payment.mode === 'mock';
  return `<section class="offer-banner">
    <div class="offer-banner-lead">
      <span class="offer-kicker">${payment.firstValue === 'cooked' ? 'Первый ужин готов' : 'Первый рецепт сохранён'}</span>
      <h2>Мы умеем ещё много полезного</h2>
      <p>${mock ? 'Попробуй бесплатно — бот поможет сохранять рецепты, выбирать ужин и не забывать о нём.' : 'Оформи месячный доступ, чтобы сохранять рецепты, выбирать ужин и получать напоминания.'}</p>
      <small class="offer-trial-price">Месячный доступ · ${payment.offer.priceRub} ₽</small>
    </div>
    <div class="offer-feature-grid" aria-label="Возможности подписки">
      <article class="offer-feature"><span class="offer-feature-icon offer-feature-icon-save" aria-hidden="true">1</span><div><h3>Сохраняем за тебя</h3><p>Пришли ссылку, фото, текст или голосовое — получишь готовую карточку.</p></div></article>
      <article class="offer-feature"><span class="offer-feature-icon offer-feature-icon-dinner" aria-hidden="true">2</span><div><h3>Подбираем на вечер</h3><p>Три идеи с учётом твоих вкусов, ограничений и любимых рецептов.</p></div></article>
      <article class="offer-feature"><span class="offer-feature-icon offer-feature-icon-reminder" aria-hidden="true">3</span><div><h3>Напоминаем вовремя</h3><p>Бот напомнит об ужине и сразу предложит, что приготовить.</p></div></article>
    </div>
    <button class="primary accent" type="button" data-open-offer>${mock ? 'Попробовать бесплатно' : 'Оформить доступ'}</button>
    <small class="offer-disclaimer">${mock ? 'Тестовый сценарий · деньги не списываются' : 'Оплата на защищённой странице Robokassa'}</small>
  </section>`;
}

function openOffer() { closeOverlay(); setRoute({ view: 'offer' }); void render(); }

function mainMenuPage() {
  const chatUrl = `https://t.me/${state.me?.botUsername || 'Recipeboibot'}?start=dish`;
  root.innerHTML = `${header()}<main class="main-menu-page"><section class="home-choice" aria-labelledby="main-menu-title">
    <h1 id="main-menu-title">Что приготовим?</h1><p>Выберите, с чего начать.</p>
    <div class="home-choice-actions">
      <button id="menu-today" class="home-choice-button primary accent" type="button"><span><strong>Что на сегодня</strong><small>Подборка с учётом ваших вкусов</small></span><span aria-hidden="true">🍽️</span></button>
      <a id="menu-dish" class="home-choice-button secondary" href="${esc(chatUrl)}"><span><strong>Хочу конкретное блюдо</strong><small>Надиктуйте пожелание в чате</small></span><span aria-hidden="true">🎤</span></a>
      <button id="menu-recipes" class="home-choice-button secondary" type="button"><span><strong>Мои рецепты</strong><small>Ваша сохранённая коллекция</small></span><span aria-hidden="true">📖</span></button>
    </div></section></main>`;
  bindCommon();
  document.querySelector('#menu-today').onclick = () => { setRoute({ view: 'dinner' }); void render().catch(error => toast(error.message)); };
  document.querySelector('#menu-recipes').onclick = () => { setRoute({ view: 'collection' }); void render().catch(error => toast(error.message)); };
  document.querySelector('#menu-dish').onclick = event => {
    if (!tg?.openTelegramLink) return;
    event.preventDefault();
    tg.openTelegramLink(chatUrl);
    tg.close();
  };
}

function home() {
  const recent = state.recipes.slice(0, 4);
  const firstRecipe = state.payment?.firstRecipe?.available;
  root.innerHTML = `${header()}<main class="home-page">
    <section class="home-choice" aria-label="Выбор блюда">
      <h1>Что приготовить <em>сегодня?</em></h1>
      <p>${firstRecipe ? 'Начни с одного рецепта: подберу ужин или блюдо под конкретное пожелание.' : 'Выбери, нужна подборка из трёх идей или один рецепт под конкретное пожелание.'}</p>
      <div class="home-choice-actions">
        <button id="choose" class="home-choice-button primary accent" type="button"><span><strong>${firstRecipe ? 'Подобрать первый рецепт' : 'Подборка рецептов'}</strong><small>${firstRecipe ? 'Один подходящий вариант на сегодня' : 'Три разных варианта на сегодня'}</small></span><span aria-hidden="true">→</span></button>
        <button id="specific-recipe" class="home-choice-button secondary" type="button"><span><strong>Хочу конкретный рецепт</strong><small>Напиши или надиктуй, что приготовить</small></span><span aria-hidden="true">→</span></button>
      </div>
    </section>
    ${notificationEntry()}
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
  document.querySelector('#specific-recipe').onclick = () => { state.query = ''; setRoute({ view: 'request' }); recipeRequestView(); };
  document.querySelector('#collection').onclick = () => { setRoute({ view: 'collection' }); render(); };
  document.querySelector('#add').onclick = importSheet;
}

function recipeRequestView({ focus = false } = {}) {
  root.innerHTML = `${header()}<main class="recipe-request-page"><button class="back-link" id="request-back">← На главную</button><section class="home-search" aria-labelledby="home-search-title"><div class="eyebrow">РЕЦЕПТ ПО ПОЖЕЛАНИЮ</div><h1 id="home-search-title">Что хочешь приготовить?</h1><p>Напиши блюдо или условие своими словами. Можно начать коротко, а предложенный рецепт потом уточнить.</p><form class="search-wrap" id="home-search-form"><input class="search" id="home-search-input" aria-label="Что хочется приготовить" placeholder="Например, лазанья полегче или суп без сливок" value="${esc(state.query)}" required><button class="voice-request" id="voice-request" type="button" aria-label="Надиктовать пожелание" aria-pressed="false"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><rect x="9" y="2.5" width="6" height="12" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3.5m-3.5 0h7"/></svg></button><button class="primary accent" type="submit">Подобрать рецепт</button></form><p class="request-voice-status" id="request-voice-status" aria-live="polite"></p><div class="request-examples" aria-label="Примеры коротких запросов"><span>Можно коротко:</span><button type="button" data-request-example="Суп">Суп</button><button type="button" data-request-example="Курица">Курица</button><button type="button" data-request-example="Что-нибудь быстрое">Что-нибудь быстрое</button></div><p class="request-note">Сначала поищу готовый рецепт. Если подходящего нет — составлю новый. После этого можно уточнить: «полегче», «без духовки» или «на двоих».</p></section></main>`;
  bindCommon();
  document.querySelector('#request-back').onclick = () => { state.query = ''; setRoute({}); home(); };
  document.querySelector('#home-search-form').onsubmit = showRequestedRecipe;
  document.querySelector('#voice-request').onclick = toggleRequestRecording;
  document.querySelectorAll('[data-request-example]').forEach((button) => button.onclick = () => { document.querySelector('#home-search-input').value = button.textContent.trim(); return showRequestedRecipe({ preventDefault() {}, currentTarget: document.querySelector('#home-search-form') }); });
  if (focus) globalThis.requestAnimationFrame?.(() => { const input = document.querySelector('#home-search-input'); input?.focus(); input?.select(); });
}

async function showRequestedRecipe(event, { query: suppliedQuery = '', hideRawQuery = false } = {}) {
  event.preventDefault();
  const query = suppliedQuery.trim() || document.querySelector('#home-search-input')?.value.trim();
  const button = event.currentTarget.querySelector('button[type=submit]');
  if (!query || !button || button.disabled) return;
  state.query = hideRawQuery ? '' : query;
  setRoute(hideRawQuery ? { view: 'request' } : { view: 'request', q: query }, { replace: true });
  button.disabled = true;
  button.innerHTML = '<span class="loader"></span> Подбираю…';
  try {
    const result = await api('/api/recipe-request', { method: 'POST', body: JSON.stringify({ query }) });
    await refresh();
    const params = new URLSearchParams(location.search);
    if (params.get('view') !== 'request' || (!hideRawQuery && params.get('q') !== query)) return;
    state.query = String(result.query || '').trim();
    if (result.kind === 'existing') await openRecipe(result.recipe.id, true);
    else if (result.kind === 'generated') recipeDetail({ ...result.suggestion.recipe, origin: 'generated', sourceName: 'Создано в «Рецептах»' }, { suggestion: result.suggestion });
    else throw new Error('Не получилось подобрать рецепт');
  } catch (error) { if (error.status === 402) { await refresh(); openOffer(); } else toast(error.message); }
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
        const form = document.querySelector('#home-search-form');
        if (form) { status.textContent = 'Пожелание записано. Подбираю рецепт…'; await showRequestedRecipe({ preventDefault() {}, currentTarget: form }, { query: result.text, hideRawQuery: true }); }
      } catch (error) { status.textContent = ''; if (error.status === 402) { await refresh(); openOffer(); } else toast(error.message); }
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
    const notificationId = !forceOnboarding ? new URLSearchParams(location.search).get('notification') : null;
    const session = await api(notificationId ? `/api/notifications/${encodeURIComponent(notificationId)}/open` : '/api/dinner/open', { method: 'POST', body: '{}', signal: AbortSignal.timeout(12000) });
    state.dinner = { sessionId: session.sessionId, notificationId, profile: session.profile, pantry: session.pantry || [], mealRequest: session.mealRequest || null, needsOnboarding: session.needsOnboarding, recommendations: session.acceptedOption ? [session.acceptedOption] : [], reserve: [], recommendation: session.acceptedOption || null, accepted: Boolean(session.acceptedOption), retryCount: 0, dislikeId: null, loading: false };
    if (session.acceptedOption) { dinnerView(); return; }
    if (forceOnboarding) await showDinnerOnboarding();
    else if (session.needsTastePreferences) showDinnerTastePreferences();
    else if (startTrialTastePreferences) {
      setTrialOnboardingStep('notifications');
      setRoute({ view: 'trial-onboarding' });
      trialOnboardingPage();
    } else await loadDinnerRecommendation();
  } catch (error) { toast(error.message); setRoute({}, { replace: true }); home(); }
}

async function resumePendingTrialTastePreferences() {
  if (!state.payment?.active) return false;
  const savedStep = savedTrialOnboardingStep();
  if (savedStep && savedStep !== 'taste') {
    state.trialOnboarding = savedStep;
    setRoute({ view: savedStep === 'notifications-settings' ? 'notifications' : 'trial-onboarding' }, { replace: true });
    await render();
    return true;
  }
  const profile = await api('/api/dinner/profile', { signal: AbortSignal.timeout(12000) });
  if (profile.tastePreferencesStatus !== 'pending') return false;
  setTrialOnboardingStep('taste');
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

function tasteChoices(categories, { title = 'Что ты любишь есть?', copy = 'Отметь любимые блюда и те, которые не по вкусу. Так подбор станет точнее.' } = {}) {
  const groups = [
    ['Блюда', [['burger','Бургеры'],['pizza','Пицца'],['sushi','Суши'],['shawarma','Шаурма'],['wok','Вок'],['pasta','Паста'],['barbecue','Шашлык'],['dessert','Десерты'],['fastfood','Фастфуд'],['breakfast','Завтраки'],['lunch','Обеды'],['coffee','Кофе']]],
    ['Кухни', [['georgian','Грузия'],['russian','Русская'],['eastern','Восток'],['chinese','Китай'],['japanese','Япония'],['caucasian','Кавказ'],['uzbek','Узбекская'],['italian','Италия'],['european','Европа'],['asian','Азия']]],
    ['Другие предпочтения', [['rice','Рис'],['chicken','Курица'],['meat','Мясо'],['fish','Рыба'],['soup','Супы'],['salad','Салаты'],['home','Домашняя еда']]]
  ];
  const tagButtons = (tags, value) => tags.map(([key, label]) => `<button type="button" class="dinner-option ${Math.sign(categories[key] || 0) === value ? 'selected' : ''}" data-taste="${key}" data-value="${value}" aria-pressed="${Math.sign(categories[key] || 0) === value}">${label}</button>`).join('');
  return `<h1>${esc(title)}</h1><p>${esc(copy)}</p>${[[1, 'Нравится'], [-1, 'Не нравится']].map(([value, groupTitle]) => `<fieldset class="taste-group"><legend>${groupTitle}</legend>${groups.map(([sectionTitle, tags]) => `<h3 class="taste-subtitle">${sectionTitle}</h3><div class="dinner-options">${tagButtons(tags, value)}</div>`).join('')}</fieldset>`).join('')}<p class="dinner-help">Можно выбрать несколько тегов. Повторное нажатие снимает выбор. Нелюбимые блюда будем предлагать реже. Аллергию и продукты, которые нельзя, укажи отдельно в настройках.</p>`;
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
  state.onboarding = { tasteOnly: true, preferredCategories: { ...state.dinner.profile.preferredCategories }, dishPreferences: { ...state.dinner.profile.dishPreferences }, saving: false };
  dinnerView();
  if (state.trialOnboarding === 'taste') resetPageScroll();
}

function tastePreferencesView() {
  const data = state.onboarding;
  const trial = state.trialOnboarding === 'taste';
  root.innerHTML = `${header()}<main class="dinner-page ${trial ? 'trial-onboarding' : ''}">${trial ? '<div class="trial-progress" aria-label="Шаг 1 из 3"><span class="active"></span><span></span><span></span></div><section class="trial-welcome"><div class="trial-icon" aria-hidden="true">✓</div><div><div class="eyebrow">ПРОБНЫЙ ПЕРИОД НАЧАЛСЯ</div><h2>Спасибо, что пробуешь «Твои рецепты»</h2><p>Настроим всё за пару минут, чтобы бот лучше понимал твои вкусы и помогал каждый день.</p></div></section>' : '<div class="eyebrow">ТВОИ ВКУСЫ</div>'}<section class="dinner-onboarding">${tasteChoices(data.preferredCategories, trial ? { title: 'Что ты любишь есть?', copy: 'Выбери любимые направления и то, что тебе не по вкусу. Это улучшит качество определения и подбора рецептов.' } : {})}<label for="liked-dishes">Любимые блюда (через запятую)</label><input class="field" id="liked-dishes" maxlength="1000" value="${esc(Object.entries(data.dishPreferences).filter(([, v]) => v > 0).map(([k]) => k).join(', '))}" placeholder="Стейк, лазанья"><label for="disliked-dishes">Нелюбимые блюда (через запятую)</label><input class="field" id="disliked-dishes" maxlength="1000" value="${esc(Object.entries(data.dishPreferences).filter(([, v]) => v < 0).map(([k]) => k).join(', '))}"><div class="dinner-actions"><button class="primary accent" id="taste-save" ${data.saving ? 'disabled' : ''}>${data.saving ? 'Сохраняю…' : trial ? 'Сохранить и продолжить' : 'Сохранить и подобрать ужин'}</button><button class="secondary" id="taste-skip" ${data.saving ? 'disabled' : ''}>${trial ? 'Пропустить этот шаг' : 'Пока пропустить'}</button></div><p class="dinner-help">Ответы можно изменить в настройках в любой момент.</p></section></main>`;
  bindCommon();
  bindTasteChoices(data, tastePreferencesView);
  const captureDishes = () => { data.dishPreferences = Object.fromEntries([[1, '#liked-dishes'], [-1, '#disliked-dishes']].flatMap(([weight, selector]) => document.querySelector(selector).value.split(',').map((v) => v.trim().toLocaleLowerCase('ru')).filter(Boolean).map((name) => [name, weight]))); };
  document.querySelector('#liked-dishes').oninput = captureDishes;
  document.querySelector('#disliked-dishes').oninput = captureDishes;
  const finish = async (skip) => {
    if (data.saving) return;
    data.saving = true; tastePreferencesView();
    try {
      const input = skip ? { tastePreferencesStatus: 'skipped' } : { preferredCategories: data.preferredCategories, dishPreferences: data.dishPreferences, tastePreferencesStatus: 'completed' };
      await api('/api/dinner/profile', { method: 'PUT', body: JSON.stringify(input) });
      state.onboarding = null;
      if (trial) {
        setTrialOnboardingStep('notifications');
        setRoute({ view: 'trial-onboarding' });
        trialOnboardingPage();
      } else await beginDinner();
    } catch (error) { data.saving = false; tastePreferencesView(); toast(error.message); }
  };
  document.querySelector('#taste-save').onclick = () => finish(false);
  document.querySelector('#taste-skip').onclick = () => finish(true);
}

function trialOnboardingPage() {
  const step = state.trialOnboarding === 'collection' ? 'collection' : 'notifications';
  resetPageScroll();
  if (step === 'notifications') {
    root.innerHTML = `${header()}<main class="trial-onboarding"><div class="trial-progress" aria-label="Шаг 2 из 3"><span></span><span class="active"></span><span></span></div><section class="trial-feature"><div class="trial-feature-art trial-bell" aria-hidden="true"><span></span></div><div class="eyebrow">ШАГ 2 · НАПОМИНАНИЯ</div><h1>Не думай об ужине заранее</h1><p>Выбери удобные дни и время. Бот сам пришлёт три варианта — останется только выбрать.</p><ul class="trial-benefits"><li><span>1</span> Подборка приходит прямо в Telegram</li><li><span>2</span> Расписание можно изменить в любой момент</li></ul><div class="trial-actions"><button class="primary accent" id="trial-notifications">Настроить напоминания</button><button class="secondary" id="trial-notifications-skip">Не сейчас</button></div></section></main>`;
    bindCommon();
    document.querySelector('#trial-notifications').onclick = () => { setTrialOnboardingStep('notifications-settings'); setRoute({ view: 'notifications' }); void render(); };
    document.querySelector('#trial-notifications-skip').onclick = () => { setTrialOnboardingStep('collection'); trialOnboardingPage(); };
    return;
  }
  root.innerHTML = `${header()}<main class="trial-onboarding"><div class="trial-progress" aria-label="Шаг 3 из 3"><span></span><span></span><span class="active"></span></div><section class="trial-feature"><div class="trial-feature-art trial-stack" aria-hidden="true"><span>▤</span><i>+</i></div><div class="eyebrow">ШАГ 3 · ТВОЯ КОЛЛЕКЦИЯ</div><h1>Собери рецепты, которые хочется повторить</h1><p>Накидай боту любимые рецепты — так личная коллекция быстро станет твоей, а подборы будут точнее.</p><ol class="trial-instructions"><li><span>1</span><div><strong>Вернись в чат с ботом</strong><small>Можно отправлять рецепты по одному.</small></div></li><li><span>2</span><div><strong>Пришли ссылку, фото, текст или голосовое</strong><small>Бот сам разберёт ингредиенты и шаги.</small></div></li><li><span>3</span><div><strong>Рецепт появится в «Моих рецептах»</strong><small>Сохранённое можно искать и использовать в подборках.</small></div></li></ol><div class="trial-actions"><button class="primary accent" id="trial-open-chat">Открыть чат и добавить рецепт</button><button class="secondary" id="trial-finish">Перейти к приложению</button></div></section></main>`;
  bindCommon();
  const finish = (closeChat = false) => {
    setTrialOnboardingStep(null);
    if (closeChat && typeof tg?.close === 'function') tg.close();
    else { setRoute({}, { replace: true }); void render(); }
  };
  document.querySelector('#trial-open-chat').onclick = () => finish(true);
  document.querySelector('#trial-finish').onclick = () => finish(false);
}

async function loadDinnerRecommendation() {
  if (!state.dinner) return;
  const dinner = state.dinner;
  state.dinner.loading = true;
  state.dinner.recommendations = [];
  state.dinner.recommendation = null;
  state.dinner.message = dinner.pantry?.length
    ? 'Составляю рецепты под твои продукты — сразу с запасом для следующего выбора…'
    : 'Подбираю подходящие варианты ужина…';
  dinnerView();
  try {
    const result = await api('/api/dinner/recommend', { method: 'POST', body: JSON.stringify({ sessionId: dinner.sessionId }) });
    if (state.dinner !== dinner) return;
    state.dinner.loading = false;
    state.dinner.recommendations = result.recommendations || (result.recommendation ? [result.recommendation] : []);
    state.dinner.recommendation = result.recommendation;
    state.dinner.pantry = result.pantry || [];
    state.dinner.mealRequest = result.mealRequest || null;
    state.dinner.message = result.message;
    state.dinner.accepted = false;
    state.dinner.dislikeId = null;
    state.dinner.rejectedCount = result.rejectedCount || 0;
    state.dinner.retryCount = result.retryCount || 0;
    state.dinner.reserve = result.reserve || [];
    state.dinner.preparing = result.preparing;
    state.dinner.imagesPending = result.imagesPending;
    state.dinner.notice = result.notice;
    state.dinner.firstFreeRecipe = Boolean(result.firstFreeRecipe);
    if (result.firstFreeRecipe) await refresh();
    dinnerView();
    scheduleDinnerPrefetch(dinner);
  } catch (error) { if (state.dinner !== dinner) return; dinner.loading = false; if (error.status === 402) { await refresh(); openOffer(); return; } dinner.message = error.message; dinnerView(); toast(error.message); }
}

let dinnerPollTimer;
function scheduleDinnerPrefetch(dinner) {
  clearTimeout(dinnerPollTimer);
  if (dinner?.firstFreeRecipe) return;
  if (dinner !== state.dinner || dinner.accepted || (!dinner.preparing && !dinner.imagesPending && dinner.reserve?.length >= 3)) return;
  dinnerPollTimer = setTimeout(async () => {
    if (dinner !== state.dinner || dinner.accepted || new URLSearchParams(location.search).get('view') !== 'dinner') return;
    const revision = dinner.revision || 0;
    try {
      const result = await api('/api/dinner/prefetch', { method: 'POST', body: JSON.stringify({ sessionId: dinner.sessionId }), signal: AbortSignal.timeout(12000) });
      if (dinner !== state.dinner || dinner.switching || dinner.accepted || revision !== (dinner.revision || 0)) return;
      if (dinner.gestureActive) { scheduleDinnerPrefetch(dinner); return; }
      if (!result.recommendations.length && result.reserve?.length) return loadDinnerRecommendation();
      const imagesChanged = JSON.stringify(dinner.recommendations.map((o) => [o.id,o.recipe.thumbnailUrl])) !== JSON.stringify(result.recommendations.map((o) => [o.id,o.recipe.thumbnailUrl]));
      Object.assign(dinner, { reserve: result.reserve || [], preparing: result.preparing, imagesPending: result.imagesPending, notice: result.notice });
      if (imagesChanged) { dinner.recommendations = result.recommendations; dinner.recommendation = result.recommendation; dinner.message = result.message; dinnerView(); }
      // Stop polling an exhausted offline fallback; an explicit retry can restart generation.
      if (result.preparing || result.imagesPending || result.reserve?.length >= 3) scheduleDinnerPrefetch(dinner);
    } catch {
      // A transient network failure must not permanently stop image updates.
      if (dinner === state.dinner) scheduleDinnerPrefetch(dinner);
    }
  }, 3000);
}

function dinnerDislikeSheetContent(option) {
  return `<div class="dislike-sheet-head"><h2>Почему не подходит?</h2><button type="button" class="dislike-sheet-close" data-close aria-label="Закрыть"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button></div><p class="dislike-sheet-recipe">${esc(option.recipe.title)}</p><div class="dislike-sheet-reasons">${[['not_today','Не хочу сегодня'],['dislike','Такое не люблю'],['missing_ingredients','Нет ингредиентов']].map(([key, label]) => `<button type="button" class="dislike-sheet-reason" data-dinner-reason="${key}"><span>${label}</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg></button>`).join('')}</div><p class="dislike-sheet-status" role="status" aria-live="polite" hidden></p>`;
}

function openDinnerDislikeSheet(option) {
  const dinner = state.dinner;
  const panel = overlay(dinnerDislikeSheetContent(option), 'dinner-dislike-sheet');
  panel.classList.add('dinner-dislike-overlay');
  panel.querySelector('[data-close]').onclick = () => {
    if (dinner.switching) return;
    dinner.dislikeId = null;
    document.querySelector(`[data-dinner-dislike="${option.id}"]`)?.setAttribute('aria-expanded', 'false');
    unmountModal(panel);
  };
  panel.querySelectorAll('[data-dinner-reason]').forEach(button => button.onclick = () => {
    if (dinner.switching) return;
    button.classList.add('is-selected');
    void replaceDinnerCard(button.dataset.dinnerReason, panel);
  });
}

function setDinnerDislikeBusy(panel, busy, message) {
  panel.querySelectorAll('button').forEach(button => { button.disabled = busy; });
  panel.querySelector('.sheet').setAttribute('aria-busy', String(busy));
  const status = panel.querySelector('.dislike-sheet-status');
  status.textContent = message;
  status.hidden = !message;
  status.setAttribute('role', busy ? 'status' : 'alert');
  if (!busy) panel.querySelector('.is-selected')?.classList.remove('is-selected');
}

async function replaceDinnerCard(reason, panel = null) {
  const dinner = state.dinner, id = dinner?.dislikeId;
  if (!id || dinner.switching || dinner.requestSaving) return;
  dinner.switching = true;
  dinner.revision = (dinner.revision || 0) + 1;
  clearTimeout(dinnerPollTimer);
  dinnerView();
  if (panel) setDinnerDislikeBusy(panel, true, 'Заменяю рецепт…');
  try {
    const result = await api(`/api/dinner/recommendations/${id}/replace`, { method: 'POST', body: JSON.stringify({ reason }) });
    if (state.dinner !== dinner) return;
    Object.assign(dinner, result, { switching: false, dislikeId: null });
    dinnerView();
    if (panel) unmountModal(panel);
    scheduleDinnerPrefetch(dinner);
  } catch (error) {
    if (state.dinner !== dinner) return;
    dinner.switching = false;
    dinnerView();
    scheduleDinnerPrefetch(dinner);
    if (error.status === 402) { await refresh(); openOffer(); return; }
    if (panel) setDinnerDislikeBusy(panel, false, error.message);
    else toast(error.message);
  }
}

function onboardingView() {
  if (state.onboarding.tasteOnly) return tastePreferencesView();
  const data = state.onboarding, step = data.step;
  const choices = (items, selected, field) => `<div class="dinner-options">${items.map(([value, label]) => `<button type="button" class="dinner-option ${selected === value ? 'selected' : ''}" data-${field}="${value}" aria-pressed="${selected === value}">${label}</button>`).join('')}</div>`;
  const content = [
    `<h1>Для кого обычно готовишь?</h1>${choices([['self', 'Для себя'], ['couple', 'Для двоих'], ['family', 'Для семьи']], data.householdType, 'household')}<label class="dinner-help" for="dinner-household-size">Сколько человек за столом?</label><input class="field" id="dinner-household-size" type="number" min="1" max="10" inputmode="numeric" value="${data.householdSize || ''}" placeholder="Например, 3"><p class="dinner-help">Есть дети?</p>${choices([['yes','Да'],['no','Нет']], data.hasChildren === null ? null : data.hasChildren ? 'yes' : 'no', 'children')}`,
    `<h1>Сколько времени есть на ужин?</h1>${choices([['15', 'До 15 минут'], ['30', 'До 30 минут'], ['60', 'До 60 минут'], ['any', 'Неважно']], data.preferredMaxCookingTime === null ? 'any' : String(data.preferredMaxCookingTime), 'time')}`,
    `<h1>Есть ли аллергия?</h1><p>Назови аллергены и другие продукты, которые нужно исключить.</p><label class="label" for="dinner-excluded">Аллергены и исключённые продукты</label><input class="field" id="dinner-excluded" value="${esc(data.excludedIngredients)}" placeholder="Например: грибы, арахис" aria-describedby="dinner-excluded-help"><p class="dinner-help" id="dinner-excluded-help">Разделяй продукты запятыми. Если аллергии и исключений нет, оставь поле пустым.</p>`,
    tasteChoices(data.preferredCategories)
  ][step];
  root.innerHTML = `${header()}<main class="dinner-page"><button class="back-link" id="dinner-home">← На главную</button><div class="eyebrow">БЫСТРАЯ НАСТРОЙКА · ${step + 1} ИЗ 4</div><section class="dinner-onboarding">${content}<div class="dinner-actions"><button class="primary accent" id="onboarding-next">${step === 3 ? 'Показать ужин' : 'Дальше'}</button>${step !== 2 ? '<button class="secondary" id="onboarding-skip">Пропустить</button>' : ''}</div></section></main>`;
  bindCommon();
  document.querySelector('#dinner-home').onclick = () => { state.onboarding = null; setRoute({}); render(); };
  const redrawChoice = (field, value) => { onboardingView(); document.querySelector(`[data-${field}="${value}"]`)?.focus(); };
  document.querySelectorAll('[data-household]').forEach((button) => button.onclick = () => { data.householdType = button.dataset.household; data.householdSize = button.dataset.household === 'self' ? 1 : button.dataset.household === 'couple' ? 2 : data.householdSize > 2 ? data.householdSize : null; redrawChoice('household', button.dataset.household); });
  document.querySelector('#dinner-household-size')?.addEventListener('input', (event) => { const value = Number(event.target.value); data.householdSize = Number.isInteger(value) && value >= 1 && value <= 10 ? value : null; });
  document.querySelectorAll('[data-children]').forEach((button) => button.onclick = () => { data.hasChildren = button.dataset.children === 'yes'; redrawChoice('children', button.dataset.children); });
  document.querySelectorAll('[data-time]').forEach((button) => button.onclick = () => { data.preferredMaxCookingTime = button.dataset.time === 'any' ? null : Number(button.dataset.time); redrawChoice('time', button.dataset.time); });
  bindTasteChoices(data, onboardingView);
  const advance = async (skip = false) => {
    if (data.saving) return;
    if (step === 2) data.excludedIngredients = document.querySelector('#dinner-excluded').value;
    if (step < 3) { data.step += 1; onboardingView(); const heading = root.querySelector('h1'); heading.tabIndex = -1; heading.focus(); return; }
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
  const pitch = option.pitch || { label: index === 0 ? 'На сегодня' : 'Ещё вариант', reason: option.reasons?.[0] || '' };
  const discovery = option.role === 'variety' && recipe.discovery;
  const reason = [discovery || option.role === 'familiar' || option.role === 'quick' ? pitch.label : pitch.reason, cookingTimeLabel(recipe)].filter(Boolean).join(' · ');
  const missing = option.pantryMatch?.missing?.length ? `<p class="dinner-menu-missing">Докупить: ${esc(option.pantryMatch.missing.join(', '))}</p>` : '';
  const servingNote = state.dinner?.profile?.householdSize && !Number.isInteger(recipe.servings)
    ? '<p class="dinner-menu-ingredients">Порции не указаны — проверь количество продуктов</p>'
    : state.dinner?.profile?.householdSize && recipe.servings && recipe.servings < state.dinner.profile.householdSize ? `<p class="dinner-menu-ingredients">Рецепт на ${recipe.servings} чел. — увеличь количество продуктов</p>` : '';
  const disabled = state.dinner?.switching || state.dinner?.requestSaving ? 'disabled' : '';
  const askingReason = state.dinner?.dislikeId === option.id;
  return `<li class="dinner-menu-item" data-dinner-swipe="${esc(option.id)}"><button type="button" class="dinner-menu-card" ${disabled} data-dinner-full="${esc(option.id)}" aria-label="Открыть рецепт: ${esc(recipe.title)}"></button><span class="dinner-swipe-label" data-dinner-swipe-label aria-hidden="true"></span><div class="dinner-menu-heading"><p class="dinner-menu-reason">${esc(reason)}</p><div class="dinner-card-actions"><button type="button" class="dinner-card-dislike" data-dinner-dislike="${esc(option.id)}" aria-label="Дизлайк: ${esc(recipe.title)}" title="Не подходит" aria-haspopup="dialog" aria-expanded="${askingReason}" ${disabled}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 14V3H4v11h3Zm0-10h10a2 2 0 0 1 2 1.6l1 6A2 2 0 0 1 18 14h-5l1 4a2 2 0 0 1-2 3l-5-7" /></svg></button><button type="button" class="dinner-card-like" data-dinner-like="${esc(option.id)}" aria-label="Выбрать на ужин: ${esc(recipe.title)}" title="Выбрать на ужин" ${disabled}><svg viewBox="0 0 24 24" aria-hidden="true"><path transform="rotate(180 12 12)" d="M7 14V3H4v11h3Zm0-10h10a2 2 0 0 1 2 1.6l1 6A2 2 0 0 1 18 14h-5l1 4a2 2 0 0 1-2 3l-5-7" /></svg></button></div></div><div class="dinner-menu-body"><div class="dinner-menu-title"><h2>${esc(recipe.title)}</h2>${image ? `<img src="${image}" alt="" referrerpolicy="no-referrer">` : ''}</div>${discovery ? `<p class="dinner-menu-ingredients">${esc(pitch.reason)}</p>` : ''}${missing}${servingNote}</div></li>`;
}

function bindDinnerSwipe(card, { canStart, onAccept, onReject, onActive }) {
  let gesture = null, suppressClickUntil = 0, frame = null;
  const label = card.querySelector('[data-dinner-swipe-label]');
  const paint = () => {
    frame = null;
    if (!gesture?.horizontal) return;
    const { dx, width } = gesture;
    const direction = dx > 0 ? 1 : dx < 0 ? -1 : 0;
    if (direction !== gesture.direction) {
      card.classList.toggle('swipe-right', direction > 0);
      card.classList.toggle('swipe-left', direction < 0);
      label.textContent = direction > 0 ? 'Готовим' : 'Не подходит';
      gesture.direction = direction;
    }
    card.style.setProperty('--dinner-swipe-x', `${Math.max(-width * .55, Math.min(width * .55, dx))}px`);
    card.style.setProperty('--dinner-swipe-strength', String(Math.min(1, Math.abs(dx) / Math.min(90, width * .27))));
    card.classList.add('is-swiping');
  };
  const recordMotion = event => {
    for (const point of [...(event.getCoalescedEvents?.() || []), event]) {
      const time = Number.isFinite(point.timeStamp) ? point.timeStamp : 0;
      const last = gesture.samples.at(-1);
      if (last && time < last.time) continue;
      if (last && time === last.time) last.x = point.clientX;
      else gesture.samples.push({ x: point.clientX, time });
    }
    const cutoff = gesture.samples.at(-1).time - 120;
    gesture.samples = gesture.samples.filter(point => point.time >= cutoff).slice(-48);
  };
  const reset = () => {
    const previous = gesture; gesture = null;
    if (frame !== null) { cancelAnimationFrame(frame); frame = null; }
    card.classList.remove('is-swiping', 'swipe-left', 'swipe-right');
    card.style.removeProperty('--dinner-swipe-x');
    card.style.removeProperty('--dinner-swipe-strength');
    if (previous) {
      onActive(false);
      if (card.hasPointerCapture?.(previous.id)) card.releasePointerCapture(previous.id);
    }
  };
  card.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0) return;
    suppressClickUntil = 0;
    const control = event.target.closest('button, a, input, textarea, select');
    if (!canStart() || (control && !control.matches('[data-dinner-full]'))) return;
    gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, dx: 0, dy: 0, horizontal: false, direction: 0, width: card.getBoundingClientRect().width, samples: [] };
    recordMotion(event);
    onActive(true);
  });
  card.addEventListener('pointermove', event => {
    if (!gesture || gesture.id !== event.pointerId) return;
    recordMotion(event);
    gesture.dx = event.clientX - gesture.x; gesture.dy = event.clientY - gesture.y;
    const x = Math.abs(gesture.dx), y = Math.abs(gesture.dy);
    // A sideways wobble must not lock a subsequent vertical scroll into a swipe.
    if (y > 10 && y > x * .85) { suppressClickUntil = Date.now() + 500; reset(); return; }
    if (!gesture.horizontal) {
      if (x < 12 || x < y * 1.7) return;
      gesture.horizontal = true;
      card.setPointerCapture(event.pointerId);
    }
    // touch-action leaves vertical scrolling to the browser; never cancel it.
    if (frame === null) frame = requestAnimationFrame(paint);
  }, { passive: true });
  card.addEventListener('pointerup', event => {
    if (!gesture || gesture.id !== event.pointerId) return;
    recordMotion(event);
    const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y;
    const directional = Math.abs(dx) > Math.abs(dy) * 1.4;
    const horizontal = gesture.horizontal || (Math.abs(dx) >= 12 && directional);
    const first = gesture.samples[0], last = gesture.samples.at(-1);
    const elapsed = last.time - first.time;
    const velocity = elapsed > 0 ? (last.x - first.x) / elapsed : 0;
    const tail = gesture.samples.slice(0, -1).reverse().find(point => Math.abs(last.x - point.x) >= 4);
    // A short flick uses recent speed; pauses and movement back toward the
    // starting point cannot turn an unfinished drag into a selection.
    const flick = Math.abs(dx) >= 32 && Math.abs(velocity) >= .45 && velocity * dx > 0 && tail && (last.x - tail.x) * dx > 0;
    if (horizontal) suppressClickUntil = Date.now() + 500;
    const commit = horizontal && directional && (Math.abs(dx) >= Math.min(90, gesture.width * .27) || flick);
    reset();
    if (commit && canStart()) { if (dx > 0) onAccept(); else onReject(); }
  });
  const cancel = () => { if (gesture?.horizontal) suppressClickUntil = Date.now() + 500; reset(); };
  card.addEventListener('pointercancel', event => { if (gesture?.id === event.pointerId) cancel(); });
  card.addEventListener('lostpointercapture', event => {
    // Touch implicitly captures the child recipe button. Transferring capture
    // to the card makes the child's loss bubble here without ending the swipe.
    if (event.target === card && gesture?.id === event.pointerId) cancel();
  });
  card.addEventListener('click', event => {
    if (Date.now() < suppressClickUntil) { suppressClickUntil = 0; event.preventDefault(); event.stopPropagation(); }
  }, true);
}

function updateDinnerIngredients() {
  const url = `https://t.me/${state.me?.botUsername || 'Recipeboibot'}?start=ingredients`;
  if (window.Telegram?.WebApp?.openTelegramLink) window.Telegram.WebApp.openTelegramLink(url);
  else window.location.href = url;
}

function firstDinnerRecipeDetails(recipe) {
  const ingredients = (recipe.ingredients || []).map(item => '<li>' + esc([item.quantity, item.unit, item.name || item.raw].filter(value => value !== null && value !== undefined && value !== '').join(' ')) + '</li>').join('');
  const steps = (recipe.steps || []).map(step => '<li>' + esc(step.text || step) + '</li>').join('');
  return '<section class="dinner-decision"><h1>' + esc(recipe.title) + '</h1>' + (recipe.description ? '<p>' + esc(recipe.description) + '</p>' : '') + '<h2>Ингредиенты</h2><ul>' + ingredients + '</ul><h2>Приготовление</h2><ol>' + steps + '</ol><button class="secondary" id="dinner-full-recipe">Открыть рецепт</button></section>';
}

function dinnerView() {
  if (state.onboarding) return onboardingView();
  const dinner = state.dinner, items = dinner?.recommendations || [];
  const item = dinner?.accepted ? dinner.recommendation : items[0], recipe = item?.recipe;
  const content = !recipe ? `<section class="dinner-decision"><h1>Сегодня на ужин</h1><p>${esc(dinner?.message || 'Подбираю подходящий вариант…')}</p>${dinner.loading ? '' : '<div class="dinner-actions"><button class="secondary" id="dinner-retry">Попробовать снова</button><button class="manual-save" id="dinner-pantry-update">Назвать другие продукты</button><button class="manual-save" id="dinner-settings">Изменить предпочтения</button></div>'}</section>`
    : dinner.firstFreeRecipe ? firstDinnerRecipeDetails(recipe)
    : dinner.accepted ? `<section class="dinner-decision"><div class="eyebrow">РЕШЕНО · СЕГОДНЯ НА УЖИН</div><h1>${esc(recipe.title)}</h1><p>Рецепт сохранён в «Мои рецепты» и останется под рукой.</p><div class="dinner-actions"><button class="primary accent" id="dinner-start-cooking">Начать готовить</button><button class="secondary" id="dinner-full-recipe">Открыть рецепт</button><button class="manual-save" id="dinner-mark-cooked" ${dinner.cooked ? 'disabled' : ''}>${dinner.cooked ? 'Приготовлено ✓' : 'Уже приготовил ✓'}</button></div></section>`
    : `<section class="dinner-decision dinner-picks"><h1>Что на ужин?</h1><p class="dinner-swipe-hint" role="status">${dinner.acceptingId ? 'Выбираю рецепт…' : 'Вправо — готовим, влево — не подходит'}</p>${dinner.notice ? `<p class="dinner-help">${esc(dinner.notice)}</p>` : ''}<ol class="dinner-menu">${items.map(dinnerChoiceCard).join('')}</ol><div class="dinner-actions">${dinner.pantry?.length ? '<button class="manual-save" id="dinner-pantry-update">Продукты изменились</button>' : ''}<button class="manual-save" id="dinner-tastes">Мои вкусы</button>${dinner.needsOnboarding ? '<button class="manual-save" id="dinner-onboarding">Уточнить вкусы и ограничения</button>' : ''}</div></section>`;
  root.innerHTML = `${header()}<main class="dinner-page"><button class="back-link" id="dinner-home">← На главную</button>${notificationEntry()}${!dinner?.accepted ? `<section class="dinner-request">${dinner?.mealRequest ? '' : '<p class="dinner-help">Конкретного пожелания на сегодня нет</p>'}<form id="dinner-request-form"><label for="dinner-request-text">Сегодня хочется</label><input class="field" id="dinner-request-text" maxlength="500" value="${esc(dinner?.requestDraft ?? dinner?.mealRequest?.text ?? '')}" placeholder="Например: стейк с картофелем" ${(dinner?.requestSaving || dinner?.switching) ? 'disabled' : ''}><button class="secondary" type="submit" ${(dinner?.requestSaving || dinner?.switching) ? 'disabled' : ''}>${dinner?.requestSaving ? 'Подбираю…' : 'Подобрать по запросу'}</button>${dinner?.mealRequest ? `<button class="manual-save" id="dinner-request-clear" type="button" ${(dinner?.requestSaving || dinner?.switching) ? 'disabled' : ''}>Убрать пожелание</button>` : ''}</form></section>` : ''}${content}${(dinner?.cooked || dinner?.firstFreeRecipe) ? offerBanner() : ''}</main>`;
  bindCommon();
  document.querySelector('#dinner-home').onclick = () => { setRoute({}); render(); };
  document.querySelector('#dinner-settings')?.addEventListener('click', () => beginDinner(true));
  document.querySelector('#dinner-pantry-update')?.addEventListener('click', updateDinnerIngredients);
  document.querySelector('#dinner-retry')?.addEventListener('click', () => beginDinner());
  document.querySelector('#dinner-tastes')?.addEventListener('click', showDinnerTastePreferences);
  document.querySelector('#dinner-onboarding')?.addEventListener('click', showDinnerOnboarding);
  const dislike = selected => {
    if (dinner.switching || dinner.requestSaving) return;
    if (!selected) return;
    dinner.dislikeId = selected.id;
    document.querySelector(`[data-dinner-dislike="${selected.id}"]`)?.setAttribute('aria-expanded', 'true');
    openDinnerDislikeSheet(selected);
  };
  document.querySelectorAll('[data-dinner-dislike]').forEach(button => button.onclick = () => dislike(items.find(option => option.id === button.dataset.dinnerDislike)));
  document.querySelectorAll('[data-dinner-like]').forEach(button => button.onclick = () => void acceptDinnerItem(items.find(option => option.id === button.dataset.dinnerLike)));
  document.querySelectorAll('[data-dinner-swipe]').forEach(card => {
    const selected = items.find(option => option.id === card.dataset.dinnerSwipe);
    bindDinnerSwipe(card, {
      canStart: () => state.dinner === dinner && !dinner.switching && !dinner.requestSaving && !dinner.accepted && !modalStack.length,
      onAccept: () => void acceptDinnerItem(selected), onReject: () => dislike(selected),
      onActive: active => { dinner.gestureActive = active; },
    });
  });
  document.querySelector('#dinner-request-text')?.addEventListener('input', (event) => { dinner.requestDraft = event.target.value; });
  const changeRequest = async (query) => {
    if (dinner.requestSaving || dinner.switching) return;
    dinner.requestSaving = true; dinnerView();
    try { await api('/api/dinner/request', { method: 'PUT', body: JSON.stringify({ query }) }); await beginDinner(); }
    catch (error) { dinner.requestSaving = false; dinnerView(); toast(error.message); }
  };
  document.querySelector('#dinner-request-form')?.addEventListener('submit', (event) => { event.preventDefault(); void changeRequest(document.querySelector('#dinner-request-text').value); });
  document.querySelector('#dinner-request-clear')?.addEventListener('click', () => changeRequest(''));
  document.querySelectorAll('[data-dinner-full]').forEach((button) => button.onclick = () => { const selected = items.find((option) => option.id === button.dataset.dinnerFull); openRecipe(selected.recipe.id, true); });
  document.querySelector('#dinner-full-recipe')?.addEventListener('click', () => { openRecipe(recipe.id, true); });
  document.querySelector('#dinner-start-cooking')?.addEventListener('click', () => { if (recipe.steps?.length) cookMode(recipe, () => markDinnerCooked(item.id)); else openRecipe(recipe.id, true); });
  document.querySelector('#dinner-mark-cooked')?.addEventListener('click', () => markDinnerCooked(item.id));
}

async function acceptDinnerItem(option) {
  const dinner = state.dinner;
  if (!option || !dinner || dinner.switching || dinner.requestSaving || dinner.accepted) return false;
  dinner.switching = true;
  dinner.acceptingId = option.id;
  dinner.revision = (dinner.revision || 0) + 1;
  clearTimeout(dinnerPollTimer);
  dinnerView();
  try {
    const result = await api(dinner.notificationId ? `/api/notifications/${encodeURIComponent(dinner.notificationId)}/select` : `/api/dinner/recommendations/${option.id}/accept`, { method: 'POST', body: dinner.notificationId ? JSON.stringify({ recommendationId: option.id }) : '{}' });
    if (state.dinner !== dinner) return false;
    if (result.status !== 'accepted') throw new Error('Этот вариант уже недоступен');
    if (result.savedRecipe) state.recipes = [result.savedRecipe, ...state.recipes.filter((recipe) => recipe.id !== result.savedRecipe.id)];
    Object.assign(dinner, { recommendation: option, accepted: true, switching: false, acceptingId: null });
    dinnerView();
    if (dinner.notificationId) toast(result.telegramSent ? 'Ссылка на рецепт отправлена в Telegram' : 'Выбор сохранён. Ссылка скоро придёт в Telegram.');
    return true;
  } catch (error) {
    if (state.dinner === dinner) { dinner.switching = false; dinner.acceptingId = null; dinnerView(); scheduleDinnerPrefetch(dinner); toast(error.message); }
    return false;
  }
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
  root.innerHTML = `${header()}<main><button class="back-link" id="back-home">← На главную</button><section class="search-page"><div class="eyebrow">Что приготовить?</div><h1>Найдём в вашей коллекции</h1><p>Напишите продукты, блюдо или ограничение по времени.</p><form class="search-wrap" id="search-form"><input class="search" id="search" aria-label="Поиск по коллекции рецептов" value="${esc(state.query)}" placeholder="Курица, крылышки с мёдом…" autofocus><button class="primary accent" aria-label="Найти">Найти</button></form></section>${!state.recipes.length ? '<div class="empty"><h2>Коллекция пока пуста</h2><p>Попробуйте поиск. Если совпадений нет, вы сами решите, создавать ли новый рецепт.</p></div>' : ''}</main>`;
  bindCommon(); document.querySelector('#back-home').onclick = () => { setRoute({}); render(); };
  document.querySelector('#search-form').onsubmit = (event) => { event.preventDefault(); const query = document.querySelector('#search').value.trim(); if (!query) return; state.query = query; setRoute({ view: 'results', q: query }); loadAndRender(); };
}

function suggestionSection(suggestion) {
  const r = suggestion.recipe;
  return `<section class="suggestion"><div class="eyebrow">Создано в «Рецептах»</div><h2>${esc(r.title)}</h2>${r.description ? `<p>${esc(r.description)}</p>` : ''}<div class="meta">${totalTime(r) ? `<span>${totalTime(r)} мин</span>` : ''}${r.servings ? `<span>${esc(r.servings)} порции</span>` : ''}</div><h3>Ингредиенты</h3><ul>${r.ingredients.map((item) => `<li>${esc(ingredientText(item))}</li>`).join('')}</ul><h3>Приготовление</h3><ol>${r.steps.map((step) => `<li>${esc(step.text)}</li>`).join('')}</ol>${r.warnings?.length ? `<p class="suggestion-warning">${r.warnings.map(esc).join('<br>')}</p>` : ''}<p>Добавить этот рецепт в «Мои рецепты»?</p><button class="primary accent" id="save-suggestion" type="button">Добавить рецепт</button><button class="secondary" id="dismiss-suggestion" type="button">Не добавлять</button></section>`;
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

async function notificationSettingsPage() {
  const trial = state.trialOnboarding === 'notifications-settings';
  const deviceTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Moscow';
  state.notificationSchedule = await api('/api/notifications/schedule', { signal: AbortSignal.timeout(12000) });
  const schedule = state.notificationSchedule;
  const hasAccess = schedule.access?.active === true;
  const timezone = schedule.timezone || deviceTimezone;
  const days = [[1, 'Пн'], [2, 'Вт'], [3, 'Ср'], [4, 'Чт'], [5, 'Пт'], [6, 'Сб'], [0, 'Вс']];
  let next = '';
  if (hasAccess && schedule.enabled && schedule.nextDueAt) {
    try { next = new Intl.DateTimeFormat('ru-RU', { timeZone: timezone, weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).format(new Date(schedule.nextDueAt)); } catch {}
  }
  root.innerHTML = `${header()}<main class="notification-page ${trial ? 'trial-notification-settings' : ''}">${trial ? '<div class="trial-progress" aria-label="Настройка шага 2 из 3"><span></span><span class="active"></span><span></span></div>' : ''}<button class="back-link" id="notifications-back">← ${trial ? 'Назад' : 'На главную'}</button><div class="eyebrow">УВЕДОМЛЕНИЯ В TELEGRAM</div><h1>Когда напомнить об ужине?</h1><p class="notification-intro">В выбранные дни бот пришлёт кнопку с тремя вариантами. После выбора отдельное сообщение со ссылкой на рецепт останется в чате.</p><form id="notification-form" class="notification-form"><label class="notification-switch"><input id="notification-enabled" type="checkbox" ${schedule.enabled ? 'checked' : ''}><span><strong>Присылать подборку</strong><small>Можно отключить в любой момент</small></span></label><fieldset id="notification-fields" ${schedule.enabled ? '' : 'disabled'}><legend>Дни недели</legend><div class="notification-days">${days.map(([value, label]) => `<label><input type="checkbox" name="weekday" value="${value}" ${schedule.weekdays.includes(value) ? 'checked' : ''}><span>${label}</span></label>`).join('')}</div><label class="notification-time"><span>Время</span><input class="field" id="notification-time" type="time" value="${esc(schedule.time || '18:00')}" required></label><p class="help">Часовой пояс этого устройства: <strong>${esc(deviceTimezone)}</strong>. Он сохранится вместе с расписанием.</p></fieldset><p class="form-error" id="notification-error" role="alert" hidden tabindex="-1"></p><button class="primary accent" type="submit">${trial ? 'Сохранить и продолжить' : 'Сохранить расписание'}</button>${next ? `<p class="notification-next">Следующая подборка: ${esc(next)}</p>` : ''}</form></main>`;
  if (trial) resetPageScroll();
  bindCommon();
  document.querySelector('#notifications-back').onclick = () => {
    if (trial) { setTrialOnboardingStep('notifications'); setRoute({ view: 'trial-onboarding' }); }
    else setRoute({});
    void render();
  };
  const enabled = document.querySelector('#notification-enabled');
  const fields = document.querySelector('#notification-fields');
  const submit = document.querySelector('#notification-form [type=submit]');
  const syncAccess = () => {
    fields.disabled = !hasAccess || !enabled.checked;
    enabled.disabled = !hasAccess && !enabled.checked;
    submit.disabled = !hasAccess && (!schedule.enabled || enabled.checked);
    submit.textContent = hasAccess ? (trial ? 'Сохранить и продолжить' : 'Сохранить расписание') : 'Отключить напоминания';
  };
  if (!hasAccess) {
    const notice = document.createElement('div');
    notice.className = 'notification-intro';
    notice.setAttribute('role', 'status');
    notice.innerHTML = `<p>${schedule.paused ? 'Напоминания приостановлены: подписка закончилась или доступ отключён. Дни и время сохранены. После продления отправка возобновится по расписанию.' : 'Подборки по расписанию доступны с активной подпиской или премиум-доступом к боту.'}</p>${state.payment?.available ? '<button type="button" class="secondary" data-open-offer>Оформить доступ</button>' : '<p class="help">Оформление подписки пока недоступно.</p>'}`;
    document.querySelector('#notification-form').before(notice);
    notice.querySelector('[data-open-offer]')?.addEventListener('click', openOffer);
  }
  syncAccess();
  enabled.onchange = syncAccess;
  document.querySelector('#notification-form').onsubmit = async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('[type=submit]');
    const error = document.querySelector('#notification-error');
    if (!hasAccess && enabled.checked) return;
    const weekdays = [...document.querySelectorAll('[name=weekday]:checked')].map((input) => Number(input.value));
    error.hidden = true;
    if (enabled.checked && !weekdays.length) { error.textContent = 'Выбери хотя бы один день.'; error.hidden = false; error.focus(); return; }
    button.disabled = true; button.textContent = 'Сохраняю…';
    try {
      state.notificationSchedule = await api('/api/notifications/schedule', { method: 'PUT', body: JSON.stringify({ enabled: enabled.checked, weekdays, time: document.querySelector('#notification-time').value, timezone: deviceTimezone }) });
      if (trial) {
        setTrialOnboardingStep('collection');
        setRoute({ view: 'trial-onboarding' }, { replace: true });
        trialOnboardingPage();
      } else await notificationSettingsPage();
      toast(enabled.checked ? 'Расписание сохранено' : 'Уведомления выключены');
    } catch (failure) { error.textContent = failure.message; error.hidden = false; error.focus(); syncAccess(); }
  };
}

async function render() {
  const params = new URLSearchParams(location.search); const view = params.get('view'); state.query = params.get('q') || '';
  if (view === 'menu') mainMenuPage();
  else if (view === 'feedback') feedbackPage();
  else if (view === 'promo') promoPage();
  else if (view === 'offer' && (state.payment?.available || state.payment?.trial)) offerPage();
  else if (view === 'checkout' && state.payment?.available) checkoutPage();
  else if (view === 'payment-result' && state.payment?.available) paymentResultPage();
  else if (view === 'trial-onboarding' && state.trialOnboarding) trialOnboardingPage();
  else if (view === 'results') {
    let results = [];
    try { results = state.query ? await api(`/api/search?q=${encodeURIComponent(state.query)}`) : state.recipes; } catch (error) { toast(error.message); }
    collection(results, state.query ? `Результаты: ${state.query}` : 'Результаты');
  } else if (view === 'dinner') { if (!state.dinner) await beginDinner(); else dinnerView(); }
  else if (view === 'notifications') await notificationSettingsPage();
  else if (view === 'collection') collection();
  else if (view === 'request') recipeRequestView();
  else if (view === 'search') searchView();
  else if (view === 'add') { home(); setRoute({}, { replace: true }); importSheet(); }
  else home();
  const recipeId = params.get('recipe'); if (recipeId) await openRecipe(recipeId, false);
}

async function refresh() {
  const library = await api('/api/library', { signal: AbortSignal.timeout(12000) });
  state.recipes = library.recipes; state.jobs = library.jobs;
  state.payment = await api('/api/billing/offer', { signal: AbortSignal.timeout(12000) });
  if (!state.checkoutOrder && state.payment?.mode === 'provider' && state.payment.pendingOrder) state.checkoutOrder = state.payment.pendingOrder;
}
async function loadAndRender() { await refresh(); await render(); }
const modalStack = [];
let modalTitleId = 0;
let pendingRouteFocus = null;
const modalFocusable = 'button, a[href], input, textarea, select, summary, [tabindex]';
function modalTabStops(dialog) {
  return [...dialog.querySelectorAll(modalFocusable)].filter((el) => !el.disabled && el.tabIndex >= 0 && !el.closest('[inert], [hidden]') && el.getClientRects().length);
}
function mountModal(element, dialog, onDismiss, initialFocus = null) {
  const opener = document.activeElement;
  // Remember an equivalent control too: dinner polling can repaint the page behind a dialog.
  const openerKey = ['id', 'data-recipe', 'data-dinner-full', 'data-dinner-dislike', 'data-home'].find((key) => opener?.hasAttribute(key));
  const openerValue = openerKey ? opener.getAttribute(openerKey) : null;
  const record = { element, dialog, opener, openerKey, openerValue, background: [] };
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.tabIndex = -1;
  const heading = dialog.querySelector('h1, h2');
  if (heading) {
    if (!heading.id) heading.id = `modal-title-${++modalTitleId}`;
    heading.tabIndex = -1;
    heading.setAttribute('data-modal-heading', '');
    dialog.setAttribute('aria-labelledby', heading.id);
  }
  document.body.append(element);
  modalStack.push(record);
  const focusInitial = () => (initialFocus || heading || dialog).focus({ preventScroll: true });
  record.keydown = (event) => {
    if (modalStack.at(-1) !== record) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onDismiss(); return; }
    if (event.key !== 'Tab') return;
    const stops = modalTabStops(dialog), first = stops[0], last = stops.at(-1);
    const current = document.activeElement;
    if (!first) { event.preventDefault(); dialog.focus(); }
    else if (!stops.includes(current) || (event.shiftKey && current === first) || (!event.shiftKey && current === last)) {
      event.preventDefault(); (event.shiftKey ? last : first).focus();
    }
  };
  record.focusin = (event) => { if (modalStack.at(-1) === record && !dialog.contains(event.target)) focusInitial(); };
  document.addEventListener('keydown', record.keydown, true);
  document.addEventListener('focusin', record.focusin, true);
  focusInitial();
  for (const sibling of document.body.children) {
    // Keep the live error/status region available to assistive technology.
    if (sibling === element || sibling === toastEl || ['SCRIPT', 'STYLE', 'LINK'].includes(sibling.tagName)) continue;
    record.background.push([sibling, sibling.inert]);
    sibling.inert = true;
  }
}
function unmountModal(element) {
  const index = modalStack.findIndex((record) => record.element === element);
  if (index < 0) { element?.remove(); return; }
  while (modalStack.length > index) {
    const record = modalStack.pop();
    document.removeEventListener('keydown', record.keydown, true);
    document.removeEventListener('focusin', record.focusin, true);
    record.element.remove();
    for (const [sibling, wasInert] of record.background) sibling.inert = wasInert;
    restoreModalFocus(record);
  }
}
function restoreModalFocus(record) {
  const equivalent = record.openerKey ? [...document.querySelectorAll(`[${record.openerKey}]`)].find((el) => el.getAttribute(record.openerKey) === record.openerValue) : null;
  const target = record.opener?.isConnected ? record.opener : equivalent;
  if (target && !target.disabled && !target.closest('[inert], [hidden]')) target.focus({ preventScroll: true });
  else if (modalStack.length) modalStack.at(-1).dialog.focus({ preventScroll: true });
  else {
    const fallback = root.querySelector('h1, [data-home]');
    if (fallback) { if (fallback.tagName === 'H1') fallback.tabIndex = -1; fallback.focus({ preventScroll: true }); }
  }
}
function closeOverlay() {
  // A route change also dismisses cooking mode when it is the only active dialog.
  const element = document.querySelector('.overlay') || modalStack[0]?.element;
  if (element) unmountModal(element);
}
function overlay(content, sheetClass = '', dismissible = true) {
  const el = document.createElement('div'); el.className = 'overlay';
  el.innerHTML = `<section class="sheet ${esc(sheetClass)}"><div class="sheet-handle" aria-hidden="true"></div>${content}</section>`;
  const closeButton = el.querySelector('[data-close]');
  if (closeButton && !closeButton.hasAttribute('aria-label')) closeButton.setAttribute('aria-label', 'Закрыть');
  const dismiss = () => closeButton ? closeButton.click() : closeDetailRoute();
  // Public shared recipes are a standalone page, not a dismissible dialog.
  if (dismissible || closeButton) mountModal(el, el.querySelector('.sheet'), dismiss);
  else root.append(el);
  if (dismissible) el.addEventListener('click', (event) => { if (event.target === el) dismiss(); });
  return el;
}

function importSheet() {
  state.tab = 'text';
  const firstRecipe = state.recipes.length === 0;
  const el = overlay(`<div class="sheet-head"><div><div class="eyebrow">${firstRecipe ? 'Первый рецепт' : 'Дополнительный способ'}</div><h2>${firstRecipe ? 'Добавить первый рецепт' : 'Сохранить вручную'}</h2></div><button class="icon-btn" data-close>✕</button></div><p class="help">${firstRecipe ? 'Вставьте текст или ссылку на рецепт либо выберите фото. Голосовое можно отправить боту в чате.' : 'Обычно проще поделиться источником в чат бота. Здесь можно вставить текст, ссылку или выбрать фото.'}</p><div class="source-tabs" role="group" aria-label="Источник рецепта"><button data-tab="text" class="active" aria-pressed="true">Текст</button><button data-tab="url" aria-pressed="false">Ссылка</button><button data-tab="image" aria-pressed="false">Фото</button></div><form id="import-form" class="form-stack"><div id="import-field"><label class="label" for="source-value">Текст рецепта</label><textarea class="field" id="source-value" placeholder="Вставьте ингредиенты и шаги…"></textarea></div><p class="help">После обработки рецепт сразу появится в коллекции. Проверяйте неизвестные количества и температуры.</p><button class="primary accent" type="submit">Сохранить</button></form>`);
  el.querySelector('[data-close]').onclick = closeOverlay;
  const form = el.querySelector('#import-form');
  el.querySelector('#import-field').insertAdjacentHTML('afterend', '<p class="form-error" id="import-error" role="alert" tabindex="-1" hidden></p>');
  form.addEventListener('input', () => {
    // A field correction clears validation, but a server error stays until retry.
    if (form.querySelector('[aria-invalid="true"]')) clearImportError(form);
  });
  el.querySelectorAll('[data-tab]').forEach((button) => button.onclick = () => {
    clearImportError(form);
    state.tab = button.dataset.tab;
    el.querySelectorAll('[data-tab]').forEach((tab) => { tab.classList.toggle('active', tab === button); tab.setAttribute('aria-pressed', String(tab === button)); });
    el.querySelector('#import-field').innerHTML = state.tab === 'image'
      ? '<label class="label" for="source-file">Фото рецепта</label><input class="field" id="source-file" type="file" accept="image/jpeg,image/png,image/webp"><label class="label" for="source-caption">Подпись к фото (необязательно)</label><input class="field" id="source-caption" placeholder="Например, название блюда">'
      : `<label class="label" for="source-value">${state.tab === 'url' ? 'Ссылка на рецепт' : 'Текст рецепта'}</label><textarea class="field" id="source-value" placeholder="${state.tab === 'url' ? 'https://сайт/рецепт' : 'Вставьте ингредиенты и шаги…'}"></textarea>`;
  });
  el.querySelector('#import-form').onsubmit = submitImport;
}

function clearImportError(form) {
  const message = form.querySelector('#import-error');
  message.hidden = true; message.textContent = '';
  form.querySelector('button[type=submit]').textContent = 'Сохранить';
  form.querySelectorAll('[aria-invalid="true"]').forEach((field) => {
    field.removeAttribute('aria-invalid'); field.removeAttribute('aria-describedby');
  });
}

async function submitImport(event) {
  event.preventDefault();
  const form = event.currentTarget, button = form.querySelector('button[type=submit]');
  if (button.disabled) return;
  const tab = state.tab, field = form.querySelector(tab === 'image' ? '#source-file' : '#source-value');
  const tabs = form.closest('.sheet').querySelectorAll('[data-tab]');
  clearImportError(form);
  button.disabled = true; button.innerHTML = '<span class="loader"></span>Обрабатываю…';
  form.setAttribute('aria-busy', 'true');
  tabs.forEach((control) => { control.disabled = true; });
  try {
    let body;
    if (tab === 'image') {
      const file = field.files[0];
      if (!file) throw Object.assign(new Error('Выберите фото рецепта.'), { invalidField: true });
      if (file.size > 6 * 1024 * 1024) throw Object.assign(new Error('Фото больше 6 МБ. Выберите файл поменьше.'), { invalidField: true });
      const value = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(new Error('Не удалось прочитать фото. Выберите его ещё раз.')); reader.readAsDataURL(file); });
      body = { kind: 'image', value, mime: file.type, caption: form.querySelector('#source-caption').value };
    } else {
      const value = field.value.trim();
      if (!value) throw Object.assign(new Error(tab === 'url' ? 'Вставьте ссылку на рецепт.' : 'Вставьте текст рецепта.'), { invalidField: true });
      if (tab === 'url') {
        let url; try { url = new URL(value); } catch { /* Report an inline validation error below. */ }
        if (!url || !['http:', 'https:'].includes(url.protocol)) throw Object.assign(new Error('Проверьте ссылку: она должна начинаться с https:// или http://.'), { invalidField: true });
      }
      body = { kind: tab, value };
    }
    const outcome = await api('/api/import', { method: 'POST', body: JSON.stringify(body) });
    // A dismissed request must not close a newer modal when it completes.
    if (!form.isConnected) return;
    closeOverlay();
    try {
      await refresh();
      if (outcome.state === 'playlist') { toast('Плейлист принят. Рецепты будут появляться в коллекции по мере обработки.'); await render(); }
      else if (outcome.recipe) { toast(outcome.state === 'existing' ? 'Этот рецепт уже есть' : 'Рецепт сохранён'); await openRecipe(outcome.recipe.id, true); }
      else { toast('Источник уже обрабатывается'); await render(); }
    } catch { toast('Источник получен, но обновить коллекцию не удалось. Откройте её снова.'); }
  } catch (error) {
    if (!form.isConnected) return;
    if (error.status === 402) { closeOverlay(); await refresh(); openOffer(); return; }
    const message = form.querySelector('#import-error');
    message.textContent = error.invalidField ? error.message : `Не удалось сохранить рецепт. ${error instanceof TypeError ? 'Проверьте соединение.' : error.message} Данные остались в форме. Нажмите «Повторить сохранение».`;
    message.hidden = false;
    if (error.invalidField) {
      field.setAttribute('aria-invalid', 'true'); field.setAttribute('aria-describedby', message.id); field.focus();
    } else { message.focus(); }
    button.textContent = error.invalidField ? 'Сохранить' : 'Повторить сохранение';
  } finally {
    form.removeAttribute('aria-busy');
    button.disabled = false;
    tabs.forEach((control) => { control.disabled = false; });
  }
}

function closeDetailRoute() {
  if (history.state?.recipeOverlay) pendingRouteFocus = modalStack[0] || null;
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
  const requestMode = !shared && new URLSearchParams(location.search).get('view') === 'request';
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
  const n = r.nutrition;
  const nutritionNumber = value => Number.isFinite(value) ? new Intl.NumberFormat('ru', { maximumFractionDigits: 1 }).format(value) : '—';
  const nutritionStat = n ? `<div class="detail-stat detail-nutrition" aria-label="КБЖУ на порцию"><strong>${nutritionNumber(n.calories)} <small>ккал</small></strong><div class="detail-macros"><span>Б ${nutritionNumber(n.protein)}</span><span>Ж ${nutritionNumber(n.fat)}</span><span>У ${nutritionNumber(n.carbs)} <small>г</small></span></div></div>` : '<div class="detail-stat detail-nutrition"><span>Расчёт КБЖУ</span></div>';
  const stats = [nutritionStat,
    `<div class="detail-stat"><strong>${[r.prepMinutes, r.cookMinutes].every(Number.isFinite) ? totalTime(r) : '—'}</strong><span>${[r.prepMinutes, r.cookMinutes].every(Number.isFinite) ? 'минут' : 'полное время не указано'}</span></div>`,
    `<div class="detail-stat"><strong>${r.ingredients?.length || 0}</strong><span>ингредиентов</span></div>`
  ].join('');
  const nutritionNote = n ? `<details class="nutrition-note"><summary>${n.source === 'recipe' ? 'Из исходного рецепта' : 'Примерный расчёт'}</summary><p>Значения на одну порцию.${n.source === 'calculated' ? ' Рассчитано по ингредиентам, включая масло и соусы.' : ''}${n.assumptions?.length ? ' ' + n.assumptions.map(esc).join(' ') : ''}${n.servings && !r.servings ? ' Число порций для расчёта: ' + esc(n.servings) + '.' : ''}</p></details>` : '';
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
  const editButton = requestMode
    ? '<button class="detail-edit" id="request-refine" type="button">Уточнить пожелание</button>'
    : shared || catalog ? '' : '<button class="detail-edit" id="edit" type="button">Изменить</button>';
  const actions = suggestion
    ? '<div class="detail-actions"><button class="primary accent" id="save-suggestion" type="button">Добавить в мои рецепты</button><button class="secondary" id="cook" type="button">Начать готовить</button></div>'
    : shared
    ? `<div class="detail-actions shared-actions"><button class="primary accent" id="cook" ${r.steps?.length ? '' : 'disabled'}>Начать готовить</button></div>`
    : `<div class="detail-actions"><button class="secondary share-button" id="share">Поделиться</button><button class="primary accent" id="cook" ${r.steps?.length ? '' : 'disabled'}>Начать готовить</button></div>`;
  const el = overlay(`${sharedIntro}<div class="detail-media ${image ? 'has-preview' : imagePending ? 'pending-preview' : 'no-preview'}">${image ? `<img src="${image}" alt="" referrerpolicy="no-referrer">` : imagePending ? '<div class="recipe-image-wait"><span aria-hidden="true">✦</span><p>Готовлю изображение блюда…</p></div>' : ''}${backButton}<div class="detail-media-source">${sourceChip}</div></div><div class="detail-content"><div class="detail-heading"><h1>${esc(r.title)}</h1>${stats ? `<div class="detail-stats">${stats}</div>${nutritionNote}` : ''}${r.description ? `<p class="detail-lead">${esc(r.description)}</p>` : ''}${tags ? `<div class="recipe-tags">${tags}</div>` : ''}</div>${shopping}${warnings ? `<details class="quality-card"><summary><span><b>Что стоит проверить</b><small>${suggestion || r.origin === 'generated' ? 'Автоматический рецепт' : 'Автоматическое извлечение'} · ${warningCount}</small></span><span class="quality-toggle">＋</span></summary><ul>${warnings}</ul></details>` : ''}<section class="recipe-panel ingredients-panel"><div class="recipe-panel-head"><div><span class="section-kicker">Список продуктов</span><h2>Ингредиенты</h2></div><span>${r.ingredients?.length || 0}</span></div><div class="ingredient-list">${ingredients}</div></section><section class="recipe-panel steps-panel"><div class="recipe-panel-head"><div><span class="section-kicker">По порядку</span><h2>Как готовить</h2></div><span>${r.steps?.length || 0}</span></div><div class="step-list">${steps}</div></section>${r.notes ? `<section class="recipe-panel note-panel"><div class="recipe-panel-head"><div><span class="section-kicker">Личное</span><h2>Заметки</h2></div></div><p>${esc(r.notes)}</p></section>` : ''}${editButton ? `<div class="detail-management">${editButton}</div>` : ''}</div>${actions}`, `recipe-detail-sheet${shared ? ' shared-recipe-sheet' : ''}`, !shared);
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
  el.querySelector('#request-refine')?.addEventListener('click', () => { closeOverlay(); setRoute({ view: 'request', q: state.query }, { replace: true }); recipeRequestView({ focus: true }); });
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
    const route = /^(seed|dinner):/.test(recipe.id) ? '/api/dinner/recipes' : '/api/recipes';
    const share = await api(`${route}/${encodeURIComponent(recipe.id)}/share`, { method: 'POST', body: '{}' });
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
  } finally {
    // Telegram's in-app browser exposes its WebView bridge even for public links.
    // Mark this route as rendered so the Mini App startup watchdog does not
    // replace a successfully opened shared recipe with its timeout screen.
    window.__miniRendered = true;
  }
}

function editRecipe(r) {
  const el = overlay(`<div class="sheet-head"><div><div class="eyebrow">РЕДАКТОР</div><h2>Проверьте рецепт</h2></div><button class="icon-btn" data-close>✕</button></div>${r.warnings.map((x) => `<div class="warning"><strong>Важно:</strong> ${esc(x)}</div>`).join('')}<form id="edit-form" class="form-stack"><label><span class="label">Название</span><input class="field" name="title" value="${esc(r.title)}" required></label><label><span class="label">Описание</span><textarea class="field" name="description">${esc(r.description)}</textarea></label><div class="form-row"><label><span class="label">Порций</span><input class="field" name="servings" type="number" value="${r.servings ?? ''}"></label><label><span class="label">Подготовка</span><input class="field" name="prepMinutes" type="number" value="${r.prepMinutes ?? ''}"></label><label><span class="label">Готовка</span><input class="field" name="cookMinutes" type="number" value="${r.cookMinutes ?? ''}"></label></div><label><span class="label">Ингредиенты — по одному на строке</span><textarea class="field" name="ingredients">${esc(r.ingredients.map(ingredientText).join('\n'))}</textarea></label><label><span class="label">Шаги — по одному на строке</span><textarea class="field" name="steps">${esc(r.steps.map((x) => x.text).join('\n'))}</textarea></label><label><span class="label">Теги через запятую</span><input class="field" name="tags" value="${esc(r.tags.join(', '))}"></label><label><span class="label">Мои заметки</span><textarea class="field" name="notes">${esc(r.notes)}</textarea></label><div class="actions"><button class="primary accent" type="submit">Сохранить</button></div></form>`, '', false);
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
function cookMode(r, onComplete = null) {
  if (!r.steps?.length) return;
  state.cookStep = 0;
  const el = document.createElement('div'); el.className = 'cook';
  el.setAttribute('aria-label', `Готовим: ${r.title}`);
  el.innerHTML = '<div class="cook-top"><span id="cook-progress"></span><button class="icon-btn" id="cook-close" aria-label="Закрыть режим готовки">✕</button></div><div class="cook-step" tabindex="-1" aria-live="polite" aria-atomic="true" aria-describedby="cook-progress"></div><div class="cook-nav"><button class="secondary" id="prev">← Назад</button><button class="primary accent" id="next"></button></div>';
  const step = el.querySelector('.cook-step'), previous = el.querySelector('#prev'), next = el.querySelector('#next');
  const draw = () => {
    el.querySelector('#cook-progress').textContent = `Шаг ${state.cookStep + 1} из ${r.steps.length}`;
    step.textContent = r.steps[state.cookStep].text;
    previous.disabled = state.cookStep === 0;
    next.textContent = state.cookStep === r.steps.length - 1 ? 'Готово ✓' : 'Дальше →';
    // Keep focus on a usable control when Back becomes disabled at the first step.
    if (previous.disabled && document.activeElement === previous) next.focus();
  };
  const close = () => unmountModal(el);
  el.querySelector('#cook-close').onclick = close;
  previous.onclick = () => { state.cookStep--; draw(); };
  next.onclick = () => { if (state.cookStep === r.steps.length - 1) { close(); onComplete?.(); } else { state.cookStep++; draw(); } };
  draw();
  mountModal(el, el, close, step);
}
function settingsSheet() {
  const el = overlay(`<div class="sheet-head"><div><div class="eyebrow">ПРОФИЛЬ</div><h2>${esc(state.me.displayName)}</h2></div><button class="icon-btn" data-close>✕</button></div><p class="help">Коллекция привязана к вашему Telegram и недоступна другим пользователям. Закрытые источники могут не обработаться; отсутствующие сведения не додумываются.</p><button class="secondary" id="notification-settings">Напоминания об ужине</button><button class="secondary" id="dinner-preferences">Предпочтения для ужина</button>${(state.payment?.available || state.payment?.trial) ? '<button class="secondary" id="subscription-settings">Подписка и оплата</button>' : ''}${state.me.testContour ? '<button class="ghost" id="test-reset">Сбросить тестовый профиль</button>' : ''}<button class="secondary" id="promo-settings">Ввести промокод</button><button class="ghost" id="delete-account">Удалить мои данные</button>`);
  el.querySelector('[data-close]').onclick = closeOverlay;
  el.querySelector('#notification-settings').onclick = () => { closeOverlay(); state.notificationSchedule = null; setRoute({ view: 'notifications' }); void render(); };
  const feedbackLink = document.createElement('button');
  feedbackLink.className = 'secondary'; feedbackLink.textContent = 'Обратная связь';
  el.querySelector('#delete-account').before(feedbackLink);
  feedbackLink.onclick = () => { closeOverlay(); setRoute({ view: 'feedback' }); feedbackPage(); };
  el.querySelector('#dinner-preferences').onclick = () => { closeOverlay(); setRoute({ view: 'dinner' }); beginDinner(true); };
  el.querySelector('#subscription-settings')?.addEventListener('click', openOffer);
  el.querySelector('#promo-settings').onclick = () => { closeOverlay(); setRoute({ view: 'promo' }); promoPage(); };
  el.querySelector('#test-reset')?.addEventListener('click', async () => {
    if (!confirm('Сбросить тестовый профиль, рецепты, историю ужинов и результат имитации оплаты?')) return;
    try {
      setTrialOnboardingStep(null);
      await api('/api/test/reset', { method: 'POST', body: '{}' });
      closeOverlay();
      root.innerHTML = '<main class="outside"><div class="brand-mark">Р</div><h1>Тестовый профиль сброшен</h1><p>Вернитесь в чат бота и нажмите /start, чтобы пройти путь нового пользователя.</p></main>';
    } catch (error) { toast(error.message); }
  });
  el.querySelector('#delete-account').onclick = async () => { if (!confirm('Безвозвратно удалить профиль и все рецепты?')) return; await api('/api/account', { method: 'DELETE' }); location.reload(); };
}

function feedbackPage() {
  clearTimeout(dinnerPollTimer); clearTimeout(paymentPollTimer);
  state.feedbackRequestKey ||= crypto.randomUUID();
  root.innerHTML = `${header()}<main class="offer-page feedback-page"><button class="back-link" id="feedback-back">К рецептам</button><div class="offer-hero"><h1>Обратная связь</h1><p>Есть вопрос, предложение или жалоба? Напишите здесь — сообщение получит владелец сервиса.</p></div><section class="offer-plan"><form id="feedback-form"><label for="feedback-message">Ваше сообщение</label><textarea id="feedback-message" rows="7" maxlength="3000" required placeholder="Расскажите, что случилось или что можно улучшить" aria-describedby="feedback-help">${esc(state.feedbackDraft || '')}</textarea><p class="help" id="feedback-help">До 3000 символов. Вместе с сообщением отправим ваше имя и Telegram-профиль, чтобы с вами могли связаться.</p><p id="feedback-error" class="feedback-error" role="alert" hidden></p><button class="primary accent" type="submit">Отправить</button></form></section></main>`;
  bindCommon(); resetPageScroll();
  document.querySelector('#feedback-back').onclick = () => { setRoute({}); void render(); };
  const form = document.querySelector('#feedback-form'), textarea = document.querySelector('#feedback-message');
  textarea.oninput = () => { state.feedbackDraft = textarea.value; };
  form.onsubmit = async event => {
    event.preventDefault();
    const button = form.querySelector('[type=submit]'), error = form.querySelector('#feedback-error');
    if (button.disabled) return;
    const message = textarea.value.trim();
    if (!message) { error.textContent = 'Напишите сообщение.'; error.hidden = false; textarea.focus(); return; }
    button.disabled = true; button.textContent = 'Отправляю…'; error.hidden = true;
    try {
      const result = await api('/api/feedback', { method: 'POST', body: JSON.stringify({ message, requestKey: state.feedbackRequestKey }), signal: AbortSignal.timeout(20000) });
      state.feedbackDraft = ''; state.feedbackRequestKey = null;
      if (!form.isConnected) return;
      form.innerHTML = `<h2>Спасибо за обратную связь</h2><p role="status">${result.delivered ? 'Сообщение отправлено владельцу.' : 'Сообщение сохранено и будет доставлено владельцу, когда связь восстановится.'}</p><button class="secondary" type="button" id="feedback-new">Написать ещё</button>`;
      document.querySelector('#feedback-new').onclick = feedbackPage;
    } catch (failure) {
      if (!form.isConnected) return;
      error.textContent = failure.name === 'TimeoutError' ? 'Не удалось получить подтверждение. Нажмите «Отправить» ещё раз.' : failure.message;
      error.hidden = false; button.disabled = false; button.textContent = 'Отправить';
    }
  };
}

const paymentMoney = (value) => Number(value).toLocaleString('ru-RU', { minimumFractionDigits: Number(value) % 1 ? 2 : 0, maximumFractionDigits: 2 });
const paymentPeriodLabel = (months) => Number(months) === 12 ? '1 год' : Number(months) === 3 ? '3 месяца' : '1 месяц';
const paymentPromoLabel = (quote) => quote.discountRub !== undefined ? `Скидка ${paymentMoney(quote.discountRub)} ₽` : `Скидка ${quote.discountPercent}%`;
const campaignPromotionCopy = promotion => (promotion.plans || [{ months: 1, priceRub: promotion.priceRub }]).map(plan => `${paymentPeriodLabel(plan.months)} — ${paymentMoney(plan.priceRub)} ₽`).join(', ');
function availablePaymentPlans() {
  return state.payment?.plans?.length ? state.payment.plans : [{ months: 1, priceRub: state.payment?.offer?.priceRub || 199, fullPriceRub: state.payment?.offer?.priceRub || 199, discountPercent: 0, savingRub: 0, pricePerMonthRub: state.payment?.offer?.priceRub || 199 }];
}
function selectedPaymentPlan() {
  const plans = availablePaymentPlans();
  return plans.find((plan) => plan.months === state.paymentPeriodMonths) || plans[0];
}
function paymentPlanChoices() {
  return `<div class="offer-periods" role="group" aria-label="Срок подписки">${availablePaymentPlans().map((catalogPlan) => { const quote = state.paymentPromoQuote; const discount = quote?.plans?.find(p => p.months === catalogPlan.months) || (quote && (quote.periodMonths || 1) === catalogPlan.months ? quote : null); const plan = discount ? { ...catalogPlan, priceRub: discount.priceRub, fullPriceRub: discount.basePriceRub, savingRub: discount.discountRub, discountPercent: Math.round(discount.discountRub / discount.basePriceRub * 100) } : catalogPlan; return `<button class="offer-period${plan.months === state.paymentPeriodMonths ? ' selected' : ''}" type="button" data-period-months="${plan.months}" aria-pressed="${plan.months === state.paymentPeriodMonths}"><span><strong>${paymentPeriodLabel(plan.months)}${plan.discountPercent ? `<span class="offer-discount">−${plan.discountPercent}%</span>` : ''}</strong>${plan.savingRub ? `<small>Экономия ${paymentMoney(plan.savingRub)} ₽</small>` : ''}</span><span class="offer-period-price">${paymentMoney(plan.priceRub)} ₽${plan.months > 1 ? `<small><s>${paymentMoney(plan.fullPriceRub)} ₽</s></small>` : ''}</span></button>`; }).join('')}</div>`;
}
function paymentPromoControls() {
  const quote = state.paymentPromoQuote;
  const promotion = state.payment?.campaignPromotion || (quote?.plans ? quote : null);
  return `<div class="offer-promo"><form id="offer-promo-form"><label for="offer-promo-code">Промокод</label><div class="offer-promo-row"><input id="offer-promo-code" name="code" maxlength="64" autocomplete="off" autocapitalize="characters" placeholder="Введите код" value="${esc(quote?.code || promotion?.code || '')}"><button class="secondary" type="submit">Применить</button></div></form>${quote ? `<div class="offer-promo-result"><strong>Промокод применён</strong><button class="text-button" id="offer-promo-remove" type="button">Убрать</button></div>` : ''}<p class="offer-promo-message" id="offer-promo-message" role="status" aria-live="polite">${esc(state.paymentPromoMessage)}</p><small>${!quote && promotion ? `По промокоду: ${campaignPromotionCopy(promotion)}. ` : ''}${!quote && !promotion ? 'Условия скидки появятся после применения кода. ' : ''}Каждый код используется один раз. Автопродление по промокоду не подключается.</small></div>`;
}
function bindPaymentOfferControls() {
  document.querySelectorAll('[data-period-months]').forEach((button) => button.addEventListener('click', async () => {
    const code = state.paymentPromoQuote?.code;
    state.paymentPeriodMonths = Number(button.dataset.periodMonths);
    state.paymentPromoQuote = null;
    state.paymentPromoMessage = '';
    state.paymentPromoPending = Boolean(code);
    providerOfferPage();
    if (code) {
      const requestedPeriod = state.paymentPeriodMonths;
      try {
        const quote = await api('/api/billing/promo/quote', { method: 'POST', body: JSON.stringify({ code, periodMonths: requestedPeriod }) });
        if (state.paymentPeriodMonths !== requestedPeriod) return;
        state.paymentPromoQuote = quote;
      } catch (failure) { if (state.paymentPeriodMonths !== requestedPeriod) return; state.paymentPromoMessage = failure.message; }
      state.paymentPromoPending = false;
      providerOfferPage();
    }
  }));
  document.querySelector('#offer-promo-remove')?.addEventListener('click', () => {
    state.paymentPromoQuote = null;
    state.paymentPromoMessage = '';
    providerOfferPage();
  });
  document.querySelector('#offer-promo-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const requestedPeriod = state.paymentPeriodMonths;
    const code = document.querySelector('#offer-promo-code').value;
    state.paymentPromoPending = true;
    providerOfferPage();
    try {
      const quote = await api('/api/billing/promo/quote', { method: 'POST', body: JSON.stringify({ code, periodMonths: requestedPeriod }) });
      if (state.paymentPeriodMonths !== requestedPeriod) return;
      state.paymentPromoQuote = quote;
      state.paymentPromoPending = false;
      state.paymentPromoMessage = '';
      providerOfferPage();
    } catch (failure) {
      if (state.paymentPeriodMonths !== requestedPeriod) return;
      state.paymentPromoPending = false;
      state.paymentPromoQuote = null;
      state.paymentPromoMessage = failure.message;
      providerOfferPage();
    }
  });
}

function promoPage(quote = null, promotion = state.payment?.campaignPromotion) {
  const money = value => Number(value).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const payable = quote && quote.priceRub > 0;
  promotion ||= quote?.plans ? quote : null;
  root.innerHTML = `${header()}<main class="offer-page"><button class="back-link" id="promo-back">К рецептам</button><div class="offer-hero"><h1>Промокод</h1>${promotion ? `<p>По промокоду ${esc(promotion.code)}: ${campaignPromotionCopy(promotion)}.</p>` : ''}<p>Скидка на выбранный срок доступа. Каждый код можно использовать один раз для текущего аккаунта. Скидки не суммируются.</p></div><section class="offer-plan">${promotion ? `<label for="promo-period">Срок доступа</label><select id="promo-period">${(promotion.plans || [{ months: 1, priceRub: promotion.priceRub }]).map(plan => `<option value="${plan.months}"${Number(quote?.periodMonths || state.paymentPeriodMonths || 1) === plan.months ? ' selected' : ''}>${paymentPeriodLabel(plan.months)} — ${paymentMoney(plan.priceRub)} ₽</option>`).join('')}</select>` : ''}<form id="promo-form"><label for="promo-code">Введите промокод</label><input id="promo-code" name="code" maxlength="64" autocomplete="off" autocapitalize="characters" required value="${esc(quote?.code || promotion?.code || '')}"><button class="secondary" type="submit">Проверить код</button></form>${quote ? `<p>${paymentPromoLabel(quote)} на ${paymentPeriodLabel(quote.periodMonths || 1)}: <s>${money(quote.basePriceRub)} ₽</s></p><div class="offer-price">${money(quote.priceRub)} ₽</div><p>Выбранный срок добавится к оставшемуся trial или активной подписке. Новое автопродление не подключается. Если оно уже включено, его можно отключить в разделе подписки.</p>${payable && !state.payment?.available ? '<p role="status">Код действителен, но оплата пока не подключена. Промокод не потрачен.</p>' : `<button class="primary accent" id="promo-apply">${payable ? `${state.payment?.mode === 'mock' ? 'Тестовая оплата' : 'Оплатить'} ${money(quote.priceRub)} ₽` : 'Получить месяц бесплатно'}</button>`}` : ''}<p id="promo-message" role="status" aria-live="polite"></p></section></main>`;
  bindCommon();
  document.querySelector('#promo-back').onclick = () => { setRoute({}); void render(); };
  document.querySelector('#promo-period')?.addEventListener('change', event => { state.paymentPeriodMonths = Number(event.target.value); promoPage(null, promotion); });
  document.querySelector('#promo-form').onsubmit = async event => {
    event.preventDefault();
    const message = document.querySelector('#promo-message');
    // Clear the previous confirmation before checking a different code.
    const apply = document.querySelector('#promo-apply');
    if (apply) apply.disabled = true;
    try {
      const result = await api('/api/billing/promo/quote', { method: 'POST', body: JSON.stringify({ code: document.querySelector('#promo-code').value, periodMonths: state.paymentPeriodMonths || 1 }) });
      promoPage(result);
    } catch (failure) { message.textContent = failure.message; }
  };
  document.querySelector('#promo-code').oninput = () => { const apply = document.querySelector('#promo-apply'); if (apply) apply.disabled = true; };
  document.querySelector('#promo-apply')?.addEventListener('click', async event => {
    const button = event.currentTarget; button.disabled = true;
    try {
      if (!payable) {
        const result = await api('/api/billing/promo/redeem', { method: 'POST', body: JSON.stringify({ code: quote.code }) });
        state.payment = result.payment;
        document.querySelector('#promo-message').textContent = `${result.alreadyRedeemed ? 'Код уже был применён.' : 'Месяц бесплатно активирован.'} Срок доступа: ${new Date(result.expiresAt).toLocaleString('ru-RU')}.`;
        button.textContent = 'Промокод применён';
        return;
      }
      const order = await api('/api/billing/orders', { method: 'POST', body: JSON.stringify({ promoCode: quote.code, autoRenew: false, method: 'card', periodMonths: quote.periodMonths || 1 }) });
      state.checkoutOrder = order;
      if (order.mode === 'mock') { setRoute({ view: 'checkout' }); checkoutPage(); }
      else {
        state.paymentResult = 'pending';
        if (tg?.openLink) tg.openLink(order.paymentUrl);
        else window.open(order.paymentUrl, '_blank', 'noopener,noreferrer');
        setRoute({ view: 'payment-result' }); providerPaymentResultPage();
      }
    } catch (failure) { document.querySelector('#promo-message').textContent = failure.message; button.disabled = false; }
  });
}

function trialOfferPage() {
  const payment = state.payment;
  const trial = payment.trial;
  if (trial.used && !payment.active) { providerOfferPage(); return; }
  const active = payment.active && payment.accessSource === 'trial';
  const price = payment.offer?.priceRub || 199;
  const action = trial.eligible
    ? '<button class="primary accent" id="start-trial">Попробовать 7 дней бесплатно</button>'
    : active
      ? `${payment.available ? `<button class="primary accent" id="trial-buy-month">Выбрать тариф</button><p class="offer-fineprint">Оплаченный период начнётся после окончания пробного периода.</p>` : '<button class="primary accent" type="button" disabled>Оплата пока подключается</button>'}<button class="secondary trial-return" id="trial-return">Продолжить пробный период</button>`
      : '<p role="status">Оплата пока подключается. Уже сохранённые рецепты доступны; новых списаний нет.</p>';
  root.innerHTML = `${header()}<main class="offer-page paywall"><button class="back-link paywall-close" id="offer-back" aria-label="Вернуться к рецептам">Закрыть</button><div class="offer-hero"><span class="offer-kicker">Твои рецепты Плюс</span><h1>${active ? 'Ваши семь дней уже идут' : trial.used ? 'Пробный период закончился' : 'Ваши рецепты. Каждый день.'}</h1><p>${active ? `Полный доступ действует до ${esc(new Date(trial.expiresAt).toLocaleString('ru-RU'))}.` : trial.used ? 'Ваши рецепты сохранены. Для новых подборок, автоматического импорта и напоминаний нужна подписка.' : 'Семь суток полного доступа с момента нажатия кнопки. Без карты и автоматического списания.'}</p></div><ul class="paywall-benefits"><li>Рецепты из ссылок, фото и голосовых</li><li>Идеи ужина с учётом ваших вкусов</li><li>Напоминания, когда пора готовить</li></ul><section class="offer-plan"><div class="paywall-trial-card"><strong>${trial.eligible ? '7 дней бесплатно' : active ? 'Пробный доступ активен' : '1 месяц доступа'}</strong><span>${trial.eligible || active ? 'Без карты и списаний' : `${price} ₽`}</span></div><p class="paywall-after">Затем ${price} ₽ в месяц, если решите продолжить. Подписка оформляется отдельно.</p>${action}</section><p class="offer-support"><a href="/?view=promo">У меня есть промокод</a></p><p class="offer-support"><a href="/offer.html" target="_blank" rel="noopener">Условия использования и оплаты</a></p></main>`;
  bindCommon();
  document.querySelector('#offer-back').onclick = () => { setRoute({}); void render(); };
  document.querySelector('#trial-return')?.addEventListener('click', () => { setRoute({}); void render(); });
  document.querySelector('#trial-buy-month')?.addEventListener('click', () => {
    state.paymentPeriodMonths = 1;
    state.paymentPromoQuote = null;
    providerOfferPage();
  });
  document.querySelector('#start-trial')?.addEventListener('click', async (event) => {
    event.currentTarget.disabled = true;
    try {
      state.payment = await api('/api/billing/trial', { method: 'POST', body: '{}' });
      if (state.payment.accessSource !== 'trial' || !state.payment.active) { trialOfferPage(); return; }
      setTrialOnboardingStep('taste');
      setRoute({ view: 'dinner' });
      await beginDinner(false, true);
    } catch (error) { toast(error.message); event.currentTarget.disabled = false; }
  });
}

function offerPage() {
  if (state.payment?.trial && (state.payment.trial.eligible || state.payment.accessSource === 'trial' || (state.payment.trial.used && !state.payment.active))) { trialOfferPage(); return; }
  const payment = state.payment;
  if (['provider', 'unavailable', 'mock'].includes(payment?.mode)) { providerOfferPage(); return; }
  const price = payment?.offer?.priceRub;
  root.innerHTML = `${header()}<main class="offer-page"><button class="back-link" id="offer-back">← На главную</button><div class="offer-hero"><span class="offer-kicker">Рецепты Плюс · тестовое предложение</span><h1>${payment?.active ? 'Доступ открыт' : payment?.hasFirstRecipe ? 'Первый рецепт готов. Продолжим?' : 'Сначала попробуйте первый рецепт'}</h1><p>${payment?.active ? `Автоматический импорт доступен в тестовом контуре. Автопродление ${payment.recurring?.enabled ? 'включено' : 'выключено'}.` : payment?.hasFirstRecipe ? `Сохраняйте следующие рецепты из ссылок, фото и текста.${payment.firstValue === 'saved' ? ' Первый сохранённый рецепт остаётся в коллекции.' : ' Первый ужин уже позади.'}` : 'После первого сохранённого или приготовленного рецепта здесь появится предложение.'}</p></div>${payment?.hasFirstRecipe ? `<section class="offer-plan"><div class="offer-plan-top"><span>Месячный доступ</span><span class="offer-test-pill">ТЕСТ</span></div><div class="offer-price">${price} ₽ <small>/ месяц</small></div><ul><li>Автоматическое сохранение следующих рецептов</li><li>Вся коллекция и уже сохранённые рецепты под рукой</li><li>Выбор оплаты картой или через СБП в макете</li></ul>${payment.active ? `<div class="offer-active">✓ Тестовый доступ активен</div>${payment.recurring?.enabled ? '<button class="secondary" id="cancel-auto-renew">Отключить автопродление</button>' : ''}` : '<button class="primary accent" id="go-checkout">Перейти к оплате →</button>'}<p class="offer-fineprint">Демонстрационный сценарий. Реального платежа и автоматического списания нет.</p></section>` : ''}<p class="offer-support"><a href="/?view=promo">У меня есть промокод</a></p><p class="offer-support">В тестовом контуре можно проверить успех, ошибку и отмену платежа. Для нового прохождения используйте сброс профиля в настройках.</p></main>`;
  bindCommon();
  document.querySelector('#offer-back').onclick = () => { setRoute({}); void render(); };
  document.querySelector('#go-checkout')?.addEventListener('click', () => { setRoute({ view: 'checkout' }); checkoutPage(); });
  document.querySelector('#cancel-auto-renew')?.addEventListener('click', async (event) => {
    event.currentTarget.disabled = true;
    try { await api('/api/billing/auto-renew/cancel', { method: 'POST', body: '{}' }); await refresh(); offerPage(); toast('Автопродление отключено'); }
    catch (failure) { toast(failure.message); event.currentTarget.disabled = false; }
  });
}

function checkoutPage() {
  const payment = state.payment;
  if (payment?.mode === 'provider') { providerCheckoutPage(); return; }
  if (!(state.checkoutOrder?.promoCode || payment?.pendingOrder?.promoCode) && ((!payment?.hasFirstRecipe && !payment?.trial?.used) || payment.active)) { setRoute({ view: 'offer' }, { replace: true }); offerPage(); return; }
  const order = state.checkoutOrder || payment.pendingOrder;
  const periodMonths = Number(order?.periodMonths || state.paymentPeriodMonths || 1);
  const periodText = periodMonths === 12 ? '1 год' : periodMonths === 3 ? '3 месяца' : '1 месяц';
  const price = order?.priceRub || selectedPaymentPlan().priceRub;
  const confirmStep = Boolean(order);
  root.innerHTML = `<main class="checkout-page"><div class="checkout-shell"><div class="checkout-test-strip">ТЕСТОВЫЙ РЕЖИМ · ДЕНЬГИ НЕ СПИСЫВАЮТСЯ</div><header class="checkout-header"><button type="button" id="checkout-back" aria-label="Вернуться">←</button><span class="checkout-provider">● pay<span>demo</span></span><span class="checkout-safe">⌁ Защищённая форма</span></header><div class="checkout-body"><div class="checkout-merchant"><span class="checkout-merchant-logo">Р</span><div><small>Оплата заказа для</small><strong>Рецепты</strong></div></div><div class="checkout-total"><span>К оплате</span><strong>${price} ₽</strong></div><div class="checkout-order-lines"><span>Рецепты Плюс · ${periodText}</span><b>${price} ₽</b></div><div class="checkout-order-lines muted"><span>Комиссия</span><b>0 ₽</b></div>${confirmStep ? `<div class="checkout-bank-step"><span class="checkout-step-icon">${order.method === 'sbp' ? '↗' : '▣'}</span><h1>${order.method === 'sbp' ? 'Подтвердите платёж в банке' : 'Подтвердите оплату'}</h1><p>${order.method === 'sbp' ? 'В реальном сценарии здесь открылось бы приложение выбранного банка для подтверждения через СБП.' : 'В реальном сценарии здесь появилось бы подтверждение банка по карте.'}</p><div class="checkout-order-id">Заказ № ${esc(order.id.slice(0, 8).toUpperCase())}</div><div class="checkout-scenarios"><span>Выберите исход тестового платежа</span><button class="checkout-pay" data-payment-result="success">Подтвердить · ${price} ₽</button><button class="checkout-alt" data-payment-result="failure">Показать ошибку оплаты</button><button class="checkout-alt" data-payment-result="cancel">Отменить платёж</button></div></div>` : `<h1 class="checkout-title">Выберите способ оплаты</h1><div class="checkout-methods"><button type="button" class="checkout-method ${state.paymentMethod === 'card' ? 'selected' : ''}" data-method="card"><span class="checkout-method-icon">▣</span><span><strong>Банковская карта</strong><small>Мир · Visa · Mastercard</small></span><span class="checkout-radio"></span></button><button type="button" class="checkout-method ${state.paymentMethod === 'sbp' ? 'selected' : ''}" data-method="sbp"><span class="checkout-method-icon sbp">СБП</span><span><strong>Система быстрых платежей</strong><small>Подтверждение в приложении банка</small></span><span class="checkout-radio"></span></button></div>${state.paymentMethod === 'card' ? '<div class="checkout-demo-form"><div class="checkout-field"><span>Номер карты</span><strong>•••• •••• •••• 4242</strong></div><div class="checkout-field-row"><div class="checkout-field"><span>Срок действия</span><strong>•• / ••</strong></div><div class="checkout-field"><span>CVC / CVV</span><strong>•••</strong></div></div><small>Демо-поля. Номер карты и CVC вводить не нужно.</small></div><label class="notification-switch checkout-renew"><input id="auto-renew" type="checkbox"><span><strong>Автопродление выбранного тарифа</strong><small>Тест согласия без реального списания. Отключается в профиле.</small></span></label>' : '<div class="checkout-demo-form"><span class="checkout-field-label">Банк для подтверждения</span><div class="checkout-bank-list"><span>Сбербанк</span><span>Т-Банк</span><span>ВТБ</span><span>Другой банк</span></div><small>В тесте приложение банка не откроется.</small></div>'}<button class="checkout-pay" id="checkout-continue">${state.paymentMethod === 'sbp' ? 'Перейти к подтверждению' : 'Оплатить'} · ${price} ₽</button>`}<p class="checkout-notice">Это макет платёжной страницы. Платёжный сервис не подключён; реквизиты карты не запрашиваются и деньги не списываются.</p></div></div></main>`;
  document.querySelector('#checkout-back').onclick = () => { setRoute({ view: 'offer' }); offerPage(); };
  document.querySelectorAll('[data-method]').forEach((button) => button.onclick = () => { state.paymentMethod = button.dataset.method; checkoutPage(); });
  document.querySelector('#checkout-continue')?.addEventListener('click', async (event) => {
    const button = event.currentTarget; button.disabled = true;
    try {
      state.checkoutOrder = await api('/api/billing/orders', { method: 'POST', body: JSON.stringify({ method: state.paymentMethod, autoRenew: Boolean(document.querySelector('#auto-renew')?.checked), periodMonths }) });
      checkoutPage();
    } catch (error) { toast(error.message); button.disabled = false; }
  });
  document.querySelectorAll('[data-payment-result]').forEach((button) => button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const result = await api(`/api/billing/orders/${encodeURIComponent(order.id)}/result`, { method: 'POST', body: JSON.stringify({ result: button.dataset.paymentResult }) });
      state.paymentResult = result.order.status;
      state.checkoutOrder = null;
      await refresh();
      if (result.order.status === 'success') {
        setTrialOnboardingStep('taste');
        setRoute({ view: 'dinner' });
        await beginDinner(false, true);
        return;
      }
      setRoute({ view: 'payment-result' }); paymentResultPage();
    } catch (error) { toast(error.message); button.disabled = false; }
  }));
}

function paymentResultPage() {
  if (state.payment?.mode === 'provider') { providerPaymentResultPage(); return; }
  const result = state.paymentResult || state.payment?.lastResult;
  const success = result === 'success';
  root.innerHTML = `${header()}<main class="payment-result"><div class="checkout-test-strip">ТЕСТОВЫЙ РЕЖИМ · ДЕНЬГИ НЕ СПИСЫВАЮТСЯ</div><span class="payment-result-icon ${success ? 'success' : ''}">${success ? '✓' : result === 'cancel' ? '↶' : '!'}</span><h1>${success ? 'Оплата прошла' : result === 'cancel' ? 'Платёж отменён' : 'Не удалось оплатить'}</h1><p>${success ? 'Тестовый доступ открыт. Теперь можно сохранять следующие рецепты автоматически.' : 'Тестовый доступ пока не открыт. Уже пройденный рецепт остаётся доступен.'}</p><div class="payment-result-price">Рецепты Плюс · ${state.checkoutOrder?.priceRub || state.payment?.offer?.priceRub || '—'} ₽ / ${paymentPeriodLabel(state.checkoutOrder?.periodMonths || 1)}</div><button class="primary accent" id="result-next">${success ? 'Вернуться к рецептам' : 'Повторить оплату'}</button><small>Реального списания не было.</small></main>`;
  bindCommon();
  document.querySelector('#result-next').onclick = () => { setRoute(success ? {} : { view: 'offer' }); void render(); };
}

function legacyProviderOfferPage() {
  const payment = state.payment;
  const price = payment?.offer?.priceRub;
  const recurring = payment?.recurring;
  const activeCopy = recurring?.enabled ? `Автопродление включено. Следующее списание — ${recurring.nextChargeAt ? new Date(recurring.nextChargeAt).toLocaleDateString('ru-RU') : 'перед окончанием периода'}.` : 'Автопродление выключено.';
  root.innerHTML = `${header()}<main class="offer-page"><button class="back-link" id="offer-back">← На главную</button><div class="offer-hero"><span class="offer-kicker">Твои рецепты Плюс</span><h1>${payment.active ? 'Доступ открыт' : payment.hasFirstRecipe ? 'Первый рецепт готов. Продолжим?' : 'Сначала попробуйте первый рецепт'}</h1><p>${payment.active ? `Доступ действует до ${payment.expiresAt ? new Date(payment.expiresAt).toLocaleDateString('ru-RU') : 'окончания оплаченного периода'}. ${activeCopy}` : payment.hasFirstRecipe ? 'Сохраняйте следующие рецепты из ссылок, фото, текста и голосовых. Настройте напоминания об ужине и получайте готовые подборки.' : 'После первого сохранённого или приготовленного рецепта здесь появится предложение.'}</p></div>${payment.hasFirstRecipe ? `<section class="offer-plan"><div class="offer-plan-top"><span>Месячный доступ</span><span class="offer-test-pill">ПЛЮС</span></div><div class="offer-price">${price} ₽ <small>/ месяц</small></div><ul><li>Автоматическое сохранение рецептов</li><li>Вся коллекция и уже сохранённые рецепты под рукой</li><li>Напоминания об ужине по вашему расписанию</li></ul>${payment.active ? `<div class="offer-active">✓ Доступ активен</div>${recurring?.enabled ? '<button class="secondary" id="cancel-auto-renew">Отключить автопродление</button>' : '<button class="primary accent" id="go-checkout">Продлить доступ</button>'}` : '<button class="primary accent" id="go-checkout">Перейти к оплате →</button>'}<p class="offer-fineprint">Оплата проходит на защищённой странице Robokassa. Автопродление подключается только с отдельного согласия и отключается здесь в любой момент.</p></section>` : ''}<p class="offer-support"><a href="/?view=promo">У меня есть промокод</a></p><p class="offer-support"><a href="/offer.html" target="_blank" rel="noopener">Публичная оферта</a> · <a href="/privacy.html" target="_blank" rel="noopener">Обработка данных</a></p></main>`;
  bindCommon();
  document.querySelector('#offer-back').onclick = () => { setRoute({}); void render(); };
  document.querySelector('#go-checkout')?.addEventListener('click', () => { setRoute({ view: 'checkout' }); providerCheckoutPage(); });
  if (!payment.available && document.querySelector('#go-checkout')) {
    document.querySelector('#go-checkout').disabled = true;
    document.querySelector('#go-checkout').textContent = 'Оплата пока подключается';
  }
  document.querySelector('#cancel-auto-renew')?.addEventListener('click', async (event) => {
    if (!confirm('Отключить автопродление? Уже оплаченный доступ сохранится до конца периода.')) return;
    event.currentTarget.disabled = true;
    try { await api('/api/billing/auto-renew/cancel', { method: 'POST', body: '{}' }); await refresh(); providerOfferPage(); toast('Автопродление отключено'); }
    catch (failure) { toast(failure.message); event.currentTarget.disabled = false; }
  });
}

function providerOfferPage() {
  const payment = state.payment;
  const plan = selectedPaymentPlan();
  const quote = state.paymentPromoQuote;
  const price = quote ? quote.priceRub : plan.priceRub;
  const canProceed = (payment.available || quote?.discountPercent === 100) && !state.paymentPromoPending;
  const expiredTrial = payment.trial?.used && !payment.active;
  const title = expiredTrial ? 'Пробный период закончился' : payment.active ? 'Продлить доступ' : 'Ваши рецепты. Каждый день.';
  const activeCopy = expiredTrial ? 'Ваши рецепты сохранены. Выберите срок подписки, чтобы продолжить.' : payment.active ? `Доступ действует до ${payment.expiresAt ? new Date(payment.expiresAt).toLocaleDateString('ru-RU') : 'окончания оплаченного периода'}.` : payment.hasFirstRecipe ? 'Выберите срок доступа.' : 'Сначала попробуйте бесплатный период.';
  root.innerHTML = `${header()}<main class="offer-page paywall"><button class="back-link paywall-close" id="offer-back" aria-label="Вернуться к рецептам">Закрыть</button><div class="offer-hero"><span class="offer-kicker">Твои рецепты Плюс</span><h1>${title}</h1><p>${activeCopy}</p></div><ul class="paywall-benefits"><li>Рецепты из ссылок, фото и голосовых</li><li>Идеи ужина с учётом ваших вкусов</li><li>Напоминания, когда пора готовить</li></ul><section class="offer-plan">${paymentPlanChoices()}<button class="primary accent" id="offer-pay"${canProceed ? '' : ' disabled'}>${canProceed ? quote?.discountPercent === 100 ? 'Получить месяц бесплатно' : `Оплатить ${paymentMoney(price)} ₽` : 'Оплата пока подключается'}</button><p class="offer-fineprint">Оплата проходит на защищённой странице Robokassa.</p><details class="paywall-promo"${quote || state.paymentPromoMessage || payment.campaignPromotion ? ' open' : ''}><summary>У меня есть промокод</summary>${paymentPromoControls()}</details></section><p class="offer-support"><a href="/offer.html" target="_blank" rel="noopener">Публичная оферта</a> · <a href="/privacy.html" target="_blank" rel="noopener">Обработка данных</a></p></main>`;
  bindCommon();
  bindPaymentOfferControls();
  void api('/api/billing/exposure', { method: 'POST', body: JSON.stringify({ campaign: true }) }).catch(() => {});
  document.querySelector('#offer-back').onclick = () => { setRoute({}); void render(); };
  document.querySelector('#offer-pay')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      if (quote?.discountPercent === 100) {
        const result = await api('/api/billing/promo/redeem', { method: 'POST', body: JSON.stringify({ code: quote.code }) });
        state.payment = result.payment;
        state.paymentPromoQuote = null;
        state.paymentPromoMessage = 'Месяц бесплатно активирован.';
        providerOfferPage();
        return;
      }
      if (quote) {
        const order = await api('/api/billing/orders', { method: 'POST', body: JSON.stringify({ promoCode: quote.code, autoRenew: false, method: 'card', periodMonths: quote.periodMonths || 1 }) });
        state.checkoutOrder = order;
        if (order.mode === 'mock') { setRoute({ view: 'checkout' }); checkoutPage(); }
        else {
          state.paymentResult = 'pending';
          if (tg?.openLink) tg.openLink(order.paymentUrl);
          else window.open(order.paymentUrl, '_blank', 'noopener,noreferrer');
          setRoute({ view: 'payment-result' }); providerPaymentResultPage();
        }
        return;
      }
      setRoute({ view: 'checkout' });
      if (payment.mode === 'mock') checkoutPage(); else providerCheckoutPage();
    } catch (failure) {
      state.paymentPromoMessage = failure.message;
      providerOfferPage();
    }
  });
}

function providerCheckoutPage() {
  const payment = state.payment;
  if (!payment?.hasFirstRecipe && !payment?.trial?.used) { setRoute({ view: 'offer' }, { replace: true }); providerOfferPage(); return; }
  const plan = selectedPaymentPlan();
  const price = plan.priceRub;
  const period = paymentPeriodLabel(plan.months);
  const renewal = plan.months === 12 ? 'каждый год' : plan.months === 3 ? 'каждые 3 месяца' : 'каждый месяц';
  root.innerHTML = `<main class="checkout-page"><div class="checkout-shell"><header class="checkout-header"><button type="button" id="checkout-back" aria-label="Вернуться">←</button><span class="checkout-provider">Robokassa</span><span class="checkout-safe">Защищённая оплата</span></header><div class="checkout-body"><div class="checkout-merchant"><span class="checkout-merchant-logo">Р</span><div><small>Оплата для</small><strong>Твои рецепты</strong></div></div><div class="checkout-total"><span>К оплате сейчас</span><strong>${price} ₽</strong></div><div class="checkout-order-lines"><span>Твои рецепты Плюс · ${period}</span><b>${price} ₽</b></div><div class="checkout-order-lines muted"><span>Комиссия</span><b>0 ₽</b></div>${payment.recurringSupported ? `<label class="notification-switch checkout-renew"><input id="auto-renew" type="checkbox"><span><strong>Согласен на автопродление ${renewal}</strong><small>${price} ₽ за ${period}. Списание за следующий период — за 24 часа до окончания текущего. Отключить можно в профиле до даты списания.</small></span></label>` : `<p class="checkout-notice">Сейчас оформляется доступ на ${period} без автоматического продления.</p>`}<button class="checkout-pay" id="checkout-continue">Оплатить ${price} ₽</button><p class="checkout-notice">Нажимая кнопку, вы принимаете <a href="/offer.html" target="_blank" rel="noopener">условия оферты</a>. Реквизиты карты вводятся только на стороне Robokassa.</p></div></div></main>`;
  document.querySelector('#checkout-back').onclick = () => { setRoute({ view: 'offer' }); providerOfferPage(); };
  document.querySelector('#checkout-continue').onclick = async (event) => {
    const button = event.currentTarget;
    button.disabled = true; button.textContent = 'Создаём заказ…';
    try {
      const autoRenew = Boolean(document.querySelector('#auto-renew')?.checked);
      const order = await api('/api/billing/orders', { method: 'POST', body: JSON.stringify({ autoRenew, periodMonths: plan.months }) });
      state.checkoutOrder = order;
      state.paymentResult = 'pending';
      if (tg?.openLink) tg.openLink(order.paymentUrl);
      else window.open(order.paymentUrl, '_blank', 'noopener,noreferrer');
      setRoute({ view: 'payment-result' });
      providerPaymentResultPage();
    } catch (failure) { toast(failure.message); button.disabled = false; button.textContent = `Оплатить ${price} ₽`; }
  };
}

async function completeProviderPayment(order) {
  clearTimeout(paymentPollTimer);
  state.paymentResult = 'paid';
  state.checkoutOrder = null;
  await refresh();
  setTrialOnboardingStep('taste');
  setRoute({ view: 'dinner' });
  await beginDinner(false, true);
}

function pollProviderPayment() {
  clearTimeout(paymentPollTimer);
  const id = state.checkoutOrder?.id;
  if (!id) return;
  paymentPollTimer = setTimeout(async () => {
    try {
      const order = await api(`/api/billing/orders/${encodeURIComponent(id)}`);
      state.checkoutOrder = order;
      if (order.status === 'paid') { await completeProviderPayment(order); return; }
      if (new URLSearchParams(location.search).get('view') === 'payment-result') { providerPaymentResultPage(); pollProviderPayment(); }
    } catch { pollProviderPayment(); }
  }, 3000);
}

function providerPaymentResultPage() {
  const order = state.checkoutOrder || state.payment?.pendingOrder;
  const status = order?.status || state.paymentResult || 'pending';
  const success = status === 'paid';
  root.innerHTML = `${header()}<main class="payment-result"><span class="payment-result-icon ${success ? 'success' : ''}">${success ? '✓' : '…'}</span><h1>${success ? 'Оплата подтверждена' : 'Ожидаем подтверждение'}</h1><p>${success ? 'Доступ открыт. Теперь можно сохранять следующие рецепты и включить напоминания.' : 'Завершите оплату в открывшемся окне и вернитесь сюда. Доступ появится только после серверного подтверждения Robokassa.'}</p><div class="payment-result-price">Твои рецепты Плюс · ${order?.priceRub || state.payment?.offer?.priceRub || '—'} ₽ / ${paymentPeriodLabel(order?.periodMonths || 1)}</div><button class="primary accent" id="result-next">${success ? 'Вернуться к рецептам' : 'Проверить оплату'}</button><small>${order?.autoRenew ? 'Автопродление включится после успешной оплаты.' : 'Автопродление не подключено.'}</small></main>`;
  bindCommon();
  document.querySelector('#result-next').onclick = async (event) => {
    if (success) { setRoute({}); await render(); return; }
    if (!order?.id) { setRoute({ view: 'checkout' }); providerCheckoutPage(); return; }
    event.currentTarget.disabled = true;
    try {
      const fresh = await api(`/api/billing/orders/${encodeURIComponent(order.id)}`);
      state.checkoutOrder = fresh;
      if (fresh.status === 'paid') await completeProviderPayment(fresh);
      else { toast('Подтверждение пока не пришло'); providerPaymentResultPage(); }
    } catch (failure) { toast(failure.message); event.currentTarget.disabled = false; }
  };
  if (!success) pollProviderPayment();
}

window.addEventListener('popstate', async (event) => {
  if (!tg?.initData) return;
  const returnFocus = pendingRouteFocus || modalStack[0]; pendingRouteFocus = null;
  closeOverlay(); await render();
  requestAnimationFrame(() => { scrollTo(0, event.state?.scrollY || 0); if (returnFocus && !modalStack.length) restoreModalFocus(returnFocus); });
});
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
    if (new URLSearchParams(location.search).get('view') === 'menu' || !await resumePendingTrialTastePreferences()) await render();
    window.miniProbe?.('view-rendered');
  } catch (error) {
    window.__miniRendered = true;
    window.miniProbe?.('app-error');
    root.innerHTML = `<main class="outside"><div class="brand-mark">!</div><h1>Не получилось войти</h1><p>${esc(error.message)}</p><p>Вернитесь в чат бота и нажмите Start.</p></main>`;
  }
}
boot();
