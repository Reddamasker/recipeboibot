(() => {
  'use strict';
  // One presentation for Mini App, shared links and the public catalogue.
  // Recipe data is escaped here; slots contain only HTML built by our callers.
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const number = value => Number.isFinite(value) ? new Intl.NumberFormat('ru', { maximumFractionDigits: 1 }).format(value) : '—';
  const imageUrl = value => /^https:\/\//i.test(value || '') || /^\/(?:recipe|dinner|suggestion)-images\/[0-9a-f-]{36}$/i.test(value || '') || /^\/shared-recipe-images\/[A-Za-z0-9_-]{32}$/.test(value || '') || /^\/assets\/dinner\/[a-z0-9-]+\.jpg$/i.test(value || '') ? escape(value) : '';

  function ingredients(recipe, { servings = recipe.servings, checkable = false, checked = new Set() } = {}) {
    const ratio = Number.isFinite(servings) && servings > 0 && Number.isFinite(recipe.servings) && recipe.servings > 0 ? servings / recipe.servings : 1;
    return (recipe.ingredients || []).map((item, index) => {
      const quantity = Number.isFinite(item.quantity) ? number(item.quantity * ratio) : item.quantity;
      const amount = [quantity, item.unit].filter(value => value != null && value !== '').join(' ');
      const unspecified = /(?:^|\s)по\s+вкусу(?:\s|[.,;:]|$)/iu.test([item.raw, item.comment].filter(Boolean).join(' ')) ? 'по вкусу' : 'количество не указано';
      const name = `<span class="ingredient-name"><strong>${escape(item.name || item.raw)}</strong>${item.comment ? `<small>${escape(item.comment)}</small>` : ''}</span>`;
      return `<div class="ingredient-row">${checkable ? `<label class="ingredient-check"><input type="checkbox" value="${index}" ${checked.has(String(index)) ? 'checked' : ''}>${name}</label>` : name}${amount ? `<span class="ingredient-amount">${escape(amount)}</span>` : `<span class="amount-empty">${unspecified}</span>`}</div>`;
    }).join('') || '<p class="detail-empty">Ингредиенты не извлечены</p>';
  }

  function render(recipe, { slots = {}, imagePending = false, interactiveTags = false, checkable = false, photoNote = '', stepNote = '', warningLabel = 'Автоматическое извлечение' } = {}) {
    const r = recipe, image = imageUrl(r.thumbnailUrl), sourceUrl = /^https?:\/\//i.test(r.sourceUrl || '') ? escape(r.sourceUrl) : '';
    const sourceName = r.origin === 'generated' ? 'Создано в «Рецептах»' : r.sourceName || (sourceUrl ? 'Открыть источник' : 'Личный рецепт');
    const source = sourceUrl
      ? `<a class="source-chip" data-source-link href="${sourceUrl}" target="_blank" rel="noopener noreferrer" aria-label="Открыть источник: ${escape(sourceName)}"><span>${escape(sourceName)}</span><span class="source-chip-arrow" aria-hidden="true">↗</span></a>`
      : `<span class="source-chip source-chip-static"><span>${escape(sourceName)}</span></span>`;
    const n = r.nutrition;
    const nutrition = n ? `<div class="detail-stat detail-nutrition" aria-label="КБЖУ на порцию"><strong>${number(n.calories)} <small>ккал</small></strong><div class="detail-macros"><span>Б ${number(n.protein)}</span><span>Ж ${number(n.fat)}</span><span>У ${number(n.carbs)} <small>г</small></span></div></div>` : '<div class="detail-stat detail-nutrition"><span>Расчёт КБЖУ</span></div>';
    const minutes = Number.isFinite(r.totalMinutes) ? r.totalMinutes : [r.prepMinutes, r.cookMinutes].every(Number.isFinite) ? r.prepMinutes + r.cookMinutes : null;
    const stats = `${nutrition}<div class="detail-stat"><strong>${number(minutes)}</strong><span>${minutes === null ? 'полное время не указано' : 'минут'}</span></div><div class="detail-stat"><strong>${r.ingredients?.length || 0}</strong><span>ингредиентов</span></div>`;
    const nutritionNote = n ? `<details class="nutrition-note"><summary>${n.source === 'recipe' ? 'Из исходного рецепта' : 'Примерный расчёт'}</summary><p>Значения на одну порцию.${n.source === 'calculated' ? ' Рассчитано по ингредиентам, включая масло и соусы.' : ''}${n.assumptions?.length ? ' ' + n.assumptions.map(escape).join(' ') : ''}${n.servings && !r.servings ? ' Число порций для расчёта: ' + escape(n.servings) + '.' : ''}</p></details>` : '';
    const tags = (r.tags || []).map(tag => interactiveTags ? `<button class="recipe-tag" type="button" data-tag="${escape(tag)}">${escape(tag)}</button>` : `<span class="recipe-tag">${escape(tag)}</span>`).join('');
    const warnings = (r.warnings || []).map(item => `<li>${escape(item)}</li>`).join('');
    const steps = (r.steps || []).map((item, index) => `<div class="step-card"><span class="step-number">${index + 1}</span><p>${escape(typeof item === 'string' ? item : item.text)}</p></div>`).join('') || '<p class="detail-empty">Шаги не извлечены</p>';
    return `${slots.intro || ''}<div class="detail-media ${image ? 'has-preview' : imagePending ? 'pending-preview' : 'no-preview'}">${image ? `<img src="${image}" alt="${escape(r.title)}" referrerpolicy="no-referrer">` : imagePending ? '<div class="recipe-image-wait"><p>Готовлю изображение блюда…</p></div>' : ''}${slots.back || ''}<div class="detail-media-source">${source}</div></div>${photoNote ? `<p class="detail-photo-note">${escape(photoNote)}</p>` : ''}
      <div class="detail-content"><div class="detail-heading" data-recipe-section="header"><h1>${escape(r.title)}</h1><div class="detail-stats">${stats}</div>${nutritionNote}${r.description ? `<p class="detail-lead">${escape(r.description)}</p>` : ''}${tags ? `<div class="recipe-tags">${tags}</div>` : ''}${slots.headingEnd || ''}</div>
      ${slots.beforePanels || ''}${warnings ? `<details class="quality-card"><summary><span><b>Что стоит проверить</b><small>${escape(warningLabel)} · ${r.warnings.length}</small></span><span class="quality-toggle">＋</span></summary><ul>${warnings}</ul></details>` : ''}
      <section class="recipe-panel ingredients-panel" data-recipe-section="ingredients"><div class="recipe-panel-head"><div><span class="section-kicker">Список продуктов</span><h2>Ингредиенты</h2></div><span>${r.ingredients?.length || 0}</span></div>${slots.ingredientControls || ''}<div class="ingredient-list" data-recipe-ingredients>${ingredients(r, { checkable })}</div></section>
      <section class="recipe-panel steps-panel" data-recipe-section="steps"><div class="recipe-panel-head"><div><span class="section-kicker">По порядку</span><h2>Как готовить</h2></div><span>${r.steps?.length || 0}</span></div>${stepNote ? `<p class="detail-step-note">${escape(stepNote)}</p>` : ''}<div class="step-list">${steps}</div></section>
      ${r.notes ? `<section class="recipe-panel note-panel"><div class="recipe-panel-head"><div><span class="section-kicker">Личное</span><h2>Заметки</h2></div></div><p>${escape(r.notes)}</p></section>` : ''}${slots.contentEnd || ''}</div>${slots.actions || ''}`;
  }
  globalThis.RecipeDetail = Object.freeze({ render, ingredients, escape });
})();
