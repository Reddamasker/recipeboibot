(() => {
  'use strict';
  let cooking = null;
  const dispose = () => { cooking?.close(); cooking = null; };
  function normalize(recipe) { return { ...recipe, thumbnailUrl: recipe.image, totalMinutes: recipe.minutes }; }
  function render(element, recipe, { backUrl, notify, action = () => {}, detail = () => ({}) }) {
    dispose(); document.title = recipe.title + ' — Твои рецепты';
    const normalized = normalize(recipe);
    const emit = (name, extra = {}) => { try { window.RecipeAnalytics?.event(name, 'catalog', { ...detail(), ...extra }); } catch {} };
    element.innerHTML = `<section class="recipe-detail catalog-recipe">${window.RecipeDetail.render(normalized)}</section><div class="catalog-page-actions" data-catalog-extras></div>`;
    const back = element.querySelector('.detail-back'); back.dataset.route = ''; back.dataset.backUrl = backUrl;
    element.querySelector('#recipe-title').focus({ preventScroll: true });
    element.querySelector('#share').addEventListener('click', async event => {
      const button = event.currentTarget; if (button.disabled) return;
      const page = detail().pageId, started = Date.now(), current = () => element.contains(button) && page === detail().pageId;
      action('share'); button.disabled = true; button.textContent = 'Готовлю ссылку…';
      try {
        const url = location.origin + location.pathname, text = `Смотри рецепт «${recipe.title}»`;
        if (navigator.share) await navigator.share({ title: recipe.title, text, url });
        else { await navigator.clipboard.writeText(url); if (current()) notify('Ссылка скопирована'); }
        if (current()) emit('catalog_share', { durationMs: Math.min(86400000,Date.now() - started) });
      } catch (error) {
        if (current()) { action(error?.name === 'AbortError' ? 'share_cancel' : 'share_error'); if (error?.name !== 'AbortError') notify('Не удалось поделиться рецептом. Попробуйте ещё раз.'); }
      } finally { button.disabled = false; button.textContent = 'Поделиться'; }
    });
    element.querySelector('#cook').addEventListener('click', () => {
      if (cooking?.element.isConnected) return;
      cooking = window.RecipeCooking.open(normalized, { onAction: action });
    });
    return element.querySelector('[data-catalog-extras]');
  }
  window.CatalogRecipe = Object.freeze({ render, normalize, dispose });
})();
