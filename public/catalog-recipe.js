(() => {
  'use strict';
  const { escape } = window.RecipeDetail;
  function render(element, recipe, { backUrl, notify, action = () => {}, detail = () => ({}) }) {
    document.title = recipe.title + ' — Твои рецепты';
    const normalized = { ...recipe, thumbnailUrl: recipe.image, totalMinutes: recipe.minutes, sourceName: 'Твои рецепты', tags: recipe.tags || [recipe.cuisineLabel].filter(Boolean) };
    const record = name => { try { window.RecipeAnalytics?.event(name, 'catalog', detail()); } catch {} };
    const canScale = Number.isFinite(recipe.servings) && recipe.servings > 0;
    element.innerHTML = `<article class="recipe-detail catalog-recipe">${window.RecipeDetail.render(normalized, {
      photoNote: recipe.imageGenerated ? 'Изображение создано с помощью ИИ. Подача готового блюда может отличаться.' : '',
      stepNote: canScale ? `Количества в шагах указаны для базовых ${recipe.servings} порций. При пересчёте ориентируйтесь на список ингредиентов; время приготовления может измениться.` : '',
      slots: {
        back: `<a class="detail-back" data-route href="${escape(backUrl)}"><span aria-hidden="true">←</span> Назад</a>`,
        headingEnd: '<div class="catalog-recipe-tools"><button class="secondary" type="button" id="print-recipe">Распечатать</button></div>',
        ingredientControls: canScale ? `<label class="detail-servings">Количество порций<input id="servings" type="number" min="1" max="20" step="1" value="${recipe.servings}"></label>` : '',
        contentEnd: '<div data-catalog-extras></div>',
        actions: '<div class="detail-actions shared-actions"><button class="secondary share-button" type="button" id="share-recipe">Скопировать ссылку</button></div>'
      }
    })}</article>`;
    const list = element.querySelector('[data-recipe-ingredients]');
    const update = servings => {
      list.innerHTML = window.RecipeDetail.ingredients(normalized, { servings });
    };
    const servings = element.querySelector('#servings');
    servings?.addEventListener('input', event => { const value = Number(event.target.value); if (Number.isInteger(value) && value >= 1 && value <= 20) update(value); });
    servings?.addEventListener('change', event => { action('servings_change'); const value = Math.max(1, Math.min(20, Math.round(Number(event.target.value) || recipe.servings))); event.target.value = value; update(value); });
    element.querySelector('#share-recipe').addEventListener('click', async () => {
      action('share');
      try { await navigator.clipboard.writeText(location.origin + location.pathname); notify('Ссылка на рецепт скопирована'); record('catalog_share'); }
      catch { notify('Скопируйте адрес рецепта из строки браузера'); }
    });
    element.querySelector('#print-recipe').addEventListener('click', () => { action('print'); record('catalog_print'); window.print(); });
    return element.querySelector('[data-catalog-extras]');
  }
  window.CatalogRecipe = Object.freeze({ render });
})();
