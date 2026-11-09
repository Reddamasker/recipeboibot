(() => {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const meals = {breakfast:'Завтрак',lunch:'Обед',dinner:'Ужин',snack:'Перекус'};
  const paths = {
    close:'<path d="m6 6 12 12M18 6 6 18"/>', back:'<path d="m15 5-7 7 7 7"/>',
    convert:'<path d="M4 7h16M8 3 4 7l4 4m12 6H4m12-4 4 4-4 4"/>',
    photo:'<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="2"/><path d="m3 17 5-5 4 4 3-3 6 6"/>'
  };
  const icon = name => `<svg class="gwe-icon" viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.photo}</svg>`;
  const idOf = entry => Object.hasOwn(entry, 'entryId') ? entry.entryId : entry.id ?? null;
  const keyOf = id => id === null ? '@recipe' : String(id);
  const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
  const portion = value => {
    if (value === '' || value == null) return null;
    const number = Number(String(value).replace(',', '.'));
    return Number.isFinite(number) && number >= .25 && number <= 100 ? number : null;
  };
  const safeImage = value => {
    if (typeof value !== 'string' || !value.trim()) return '';
    try {const url = new URL(value, location.origin); return ['https:', 'http:'].includes(url.protocol) ? url.href : '';} catch {return '';}
  };
  const number = value => new Intl.NumberFormat('ru-RU', {maximumSignificantDigits: 6}).format(value);
  function formatAmount(ingredient, ratio = 1, mode = 'original') {
    let unit = String(ingredient.unit || '');
    if (typeof ingredient.quantity !== 'number' || !Number.isFinite(ingredient.quantity)) return [ingredient.amountText, unit].filter(Boolean).join(' ');
    let quantity = ingredient.quantity * ratio;
    const key = unit.trim().toLocaleLowerCase('ru').replace(/\.$/, '');
    if (mode === 'small' && ['кг','kg','килограмм','килограмма','килограммов'].includes(key)) {quantity *= 1000; unit = 'г';}
    if (mode === 'small' && ['л','l','литр','литра','литров'].includes(key)) {quantity *= 1000; unit = 'мл';}
    if (mode === 'large' && ['г','гр','g','грамм','грамма','граммов'].includes(key)) {quantity /= 1000; unit = 'кг';}
    if (mode === 'large' && ['мл','ml','миллилитр','миллилитра','миллилитров'].includes(key)) {quantity /= 1000; unit = 'л';}
    return [number(quantity), unit].filter(Boolean).join(' ');
  }
  function previewState(entry, previous) {
    if (!entry || typeof entry.recipeRevision !== 'string' || !entry.recipeRevision || !Array.isArray(entry.ingredients)) throw new Error('Состав рецепта не подтверждён. Повтори загрузку.');
    const keys = entry.ingredients.map(item => item?.key);
    if (keys.some(key => typeof key !== 'string' || !key) || new Set(keys).size !== keys.length) throw new Error('Не удалось прочитать ингредиенты. Повтори загрузку.');
    const scalable = positive(entry.baseServings) && positive(entry.servings);
    const preserve = previous && previous.preview.recipeRevision === entry.recipeRevision;
    const selected = preserve ? [...previous.selected] : Array.isArray(entry.selectedIngredientKeys) ? entry.selectedIngredientKeys : keys;
    return {preview: entry, scalable, servings: scalable ? String(preserve && previous.scalable ? previous.servings : entry.servings) : '', selected: new Set(selected.filter(key => keys.includes(key)))};
  }
  function buildPayload(groups) {
    const selections = groups.filter(group => group.selected.size).map(group => {
      const servings = group.scalable ? portion(group.servings) : null;
      if (group.scalable && servings === null) throw new Error('Укажи число порций от 0,25 до 100.');
      return {entryId: group.preview.entryId ?? null, servings,
        ingredientKeys: group.preview.ingredients.filter(item => group.selected.has(item.key)).map(item => item.key), recipeRevision: group.preview.recipeRevision};
    });
    if (!selections.length) throw new Error('Выбери хотя бы один ингредиент.');
    return {entryIds: selections.map(item => item.entryId).filter(id => id !== null), selections};
  }
  function open(options) {
    const entries = (options.entries || []).filter(entry => entry.kind !== 'note');
    const available = entry => entry.recipeAvailable !== false;
    const selectedEntries = new Set(entries.filter(available).map(entry => keyOf(idOf(entry))));
    const cache = new Map(), opener = document.activeElement;
    const dialog = document.createElement('dialog'); dialog.className = 'groceries-editor'; dialog.dataset.wsDialog = 'groceries.editor';
    const titleId = 'gwe-title-' + crypto.randomUUID(); dialog.setAttribute('aria-labelledby', titleId);
    let stage = options.skipChoose ? 2 : 1, groups = [], loadedIds = null, loading = false, loadFailed = false;
    let busy = false, uncertain = false, locked = false, retryPayload = null, revision = 0, previewEpoch = 0, visibleEpoch = -1;
    let status = '', unitMode = 'original', unitsOpen = false;
    const selectionIds = () => entries.filter(entry => selectedEntries.has(keyOf(idOf(entry)))).map(idOf);
    const selectionStamp = () => JSON.stringify(selectionIds());
    const blocked = () => busy || uncertain || locked;
    const photo = (url, title) => {const src = safeImage(url); return src ? `<img class="gwe-photo" src="${esc(src)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<span class="gwe-photo gwe-photo--empty" aria-hidden="true">${icon('photo')}</span>`;};
    const titleOf = entry => entry.recipe?.title || entry.title || 'Рецепт недоступен';
    const today = (() => {const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;})();
    function dayHeading(date) {
      if (!date) return '';
      const parsed = new Date(date + 'T12:00:00Z');
      const label = Number.isNaN(parsed.getTime()) ? date : parsed.toLocaleDateString('ru-RU', {weekday:'long', day:'numeric', month:'short', timeZone:'UTC'});
      return `<h3 class="gwe-day-heading"><span>${esc(label)}</span>${date === today ? '<strong>Сегодня</strong>' : ''}</h3>`;
    }
    function recipeList() {
      const dates = [...new Set(entries.map(entry => entry.date || ''))].sort();
      return dates.map(date => `<section class="gwe-day">${dayHeading(date)}${entries.map((entry,index) => ({entry,index})).filter(item => (item.entry.date || '') === date).map(({entry,index}) =>
        `<label class="gwe-recipe-row">${photo(entry.recipe?.thumbnailUrl || entry.thumbnailUrl, titleOf(entry))}<span class="gwe-recipe-info"><strong>${esc(titleOf(entry))}</strong>${meals[entry.meal] ? `<span class="gwe-meal">${esc(meals[entry.meal])}</span>` : ''}${!available(entry) ? '<small>Рецепт недоступен</small>' : ''}</span><input type="checkbox" data-gwe-entry="${index}" aria-label="Добавить ингредиенты: ${esc(titleOf(entry))}" ${selectedEntries.has(keyOf(idOf(entry))) ? 'checked' : ''} ${available(entry) ? '' : 'disabled'}></label>`).join('')}</section>`).join('') || '<p class="gwe-empty">В меню пока нет рецептов для списка покупок.</p>';
    }
    const ratioFor = group => group.scalable && portion(group.servings) !== null ? portion(group.servings) / group.preview.servings : 1;
    function ingredientsList() {
      return groups.map((group, index) => {
        const entry = group.preview, fieldId = titleId + '-servings-' + index;
        return `<section class="gwe-recipe-section" data-gwe-section="${index}"><header class="gwe-section-head">${photo(entry.thumbnailUrl, entry.title)}<div><h3>${esc(entry.title)}</h3><div class="gwe-portions"><input id="${fieldId}" type="number" inputmode="decimal" min="0.25" max="100" step="any" value="${esc(group.servings)}" placeholder="—" data-gwe-servings="${index}" ${group.scalable ? '' : 'disabled'} aria-describedby="${fieldId}-hint"><label for="${fieldId}">порции</label></div><p class="gwe-portions-hint" id="${fieldId}-hint" ${group.scalable ? 'hidden' : ''}>Порции не указаны. Исходные количества без пересчёта.</p><p class="gwe-portions-error" data-gwe-portions-error="${index}" hidden>Укажи от 0,25 до 100 порций.</p></div></header><div class="gwe-ingredients">${entry.ingredients.map((ingredient, itemIndex) => {
          const amount = formatAmount(ingredient, ratioFor(group), unitMode);
          return `<label class="gwe-ingredient-row"><span class="gwe-ingredient-text"><strong data-gwe-amount="${index}:${itemIndex}">${esc(amount ? amount + ' ' : '')}</strong><span>${esc(ingredient.name || 'Ингредиент')}</span>${ingredient.comment ? `<small>${esc(ingredient.comment)}</small>` : ''}</span><input type="checkbox" data-gwe-ingredient="${index}:${itemIndex}" aria-label="Добавить: ${esc(ingredient.name || 'ингредиент')}" ${group.selected.has(ingredient.key) ? 'checked' : ''}></label>`;
        }).join('') || '<p class="gwe-empty">В рецепте не указаны ингредиенты.</p>'}</div></section>`;
      }).join('');
    }
    function notifyVisible() {
      requestAnimationFrame(() => {
        if (!dialog.open || stage !== 2 || loading || loadFailed || !groups.length || document.visibilityState !== 'visible' || visibleEpoch === previewEpoch) return;
        const element = dialog.querySelector('.gwe-sections');
        if (!element) return;
        visibleEpoch = previewEpoch; options.onIngredientsVisible?.(element);
      });
    }
    function render({focus = null, scroll = null} = {}) {
      if (!dialog.isConnected) return;
      const title = stage === 1 ? 'Выбрать рецепты' : 'Добавить ингредиенты';
      dialog.innerHTML = `<span class="gwe-handle" aria-hidden="true"></span><header class="gwe-head">${stage === 2 && !options.skipChoose ? `<button type="button" class="gwe-round" data-gwe="back" aria-label="Назад">${icon('back')}</button>` : '<span></span>'}<h2 id="${titleId}" tabindex="-1">${title}</h2><button type="button" class="gwe-round" data-gwe="close" aria-label="Закрыть">${icon('close')}</button></header>${stage === 2 && !loading && !loadFailed ? `<div class="gwe-toolbar"><button type="button" class="gwe-units" data-gwe="units" aria-expanded="${unitsOpen}">${icon('convert')}<span>Единицы</span></button><button type="button" class="gwe-select-all" data-gwe="toggle-all">Снять выбор</button></div>${unitsOpen ? `<div class="gwe-unit-options" role="group" aria-label="Единицы измерения">${[['original','Как в рецепте'],['small','Граммы и миллилитры'],['large','Килограммы и литры']].map(([mode,label]) => `<button type="button" data-gwe-unit="${mode}" aria-pressed="${mode === unitMode}">${label}</button>`).join('')}</div>` : ''}` : ''}<div class="gwe-scroll">${stage === 1 ? recipeList() : loading ? '<p class="gwe-empty" role="status">Загружаем ингредиенты…</p>' : loadFailed ? '<p class="gwe-empty">Не удалось загрузить ингредиенты.</p>' : `<div class="gwe-sections">${ingredientsList()}</div>`}</div><p class="gwe-status" data-gwe-status role="alert" tabindex="-1" ${status ? '' : 'hidden'}>${esc(status)}</p><footer class="gwe-footer"><button type="button" data-gwe="submit">${busy ? 'Добавляем…' : uncertain ? 'Повторить добавление' : locked ? 'Открой заново' : stage === 1 ? 'Далее' : loadFailed ? 'Повторить загрузку' : 'Добавить'}</button></footer>`;
      updateControls();
      if (scroll !== null) dialog.querySelector('.gwe-scroll').scrollTop = scroll;
      if (focus) dialog.querySelector(focus)?.focus({preventScroll:true});
      notifyVisible();
    }
    function updateControls() {
      const selectedCount = groups.reduce((count, group) => count + group.selected.size, 0);
      const invalid = groups.some(group => group.selected.size && group.scalable && portion(group.servings) === null);
      dialog.setAttribute('aria-busy', String(busy || loading));
      for (const control of dialog.querySelectorAll('button,input')) {
        const action = control.dataset.gwe;
        if (action === 'close') control.disabled = busy;
        else if (action === 'back') control.disabled = blocked();
        else if (action === 'submit') control.disabled = busy || locked || loading || (!uncertain && !loadFailed && (stage === 1 ? !selectedEntries.size : !selectedCount || invalid));
        else if (Object.hasOwn(control.dataset, 'gweEntry')) control.disabled = blocked() || loading || !available(entries[Number(control.dataset.gweEntry)]);
        else if (Object.hasOwn(control.dataset, 'gweServings')) control.disabled = blocked() || !groups[Number(control.dataset.gweServings)]?.scalable;
        else control.disabled = blocked() || loading;
      }
      const all = dialog.querySelector('[data-gwe="toggle-all"]');
      if (all) all.textContent = selectedCount ? 'Снять выбор' : 'Выбрать всё';
      groups.forEach((group,index) => {
        const invalidPortions = group.scalable && portion(group.servings) === null;
        dialog.querySelector(`[data-gwe-servings="${index}"]`)?.setAttribute('aria-invalid', String(invalidPortions));
        const error = dialog.querySelector(`[data-gwe-portions-error="${index}"]`); if (error) error.hidden = !invalidPortions;
      });
    }
    async function load(force = false) {
      if (blocked() || loading) return;
      const ids = selectionIds(), stamp = selectionStamp();
      if (!ids.length) return;
      if (!force && loadedIds === stamp) {stage = 2; status = ''; render({focus:'#' + titleId}); return;}
      const own = ++revision; stage = 2; loading = true; loadFailed = false; status = ''; render({focus:'#' + titleId});
      try {
        const response = await options.loadIngredients(ids.filter(id => id !== null));
        if (own !== revision || !dialog.open) return;
        if (!response || !Number.isSafeInteger(response.version) || !Array.isArray(response.entries)) throw new Error('Сервер вернул неполный состав. Повтори загрузку.');
        const returned = new Map(response.entries.map(entry => [keyOf(entry.entryId ?? null), entry]));
        if (returned.size !== response.entries.length || ids.some(id => !returned.has(keyOf(id)))) throw new Error('Состав меню изменился. Закрой окно и выбери рецепты заново.');
        let changed = false;
        const next = ids.map(id => {
          const key = keyOf(id), entry = returned.get(key), prior = cache.get(key);
          if (prior && prior.preview.recipeRevision !== entry.recipeRevision) changed = true;
          return [key, previewState(entry, prior)];
        });
        for (const [key, value] of next) cache.set(key, value);
        groups = next.map(([,value]) => value); loadedIds = stamp; loading = false; previewEpoch++;
        if (changed) status = 'Состав рецепта обновился. Проверь выбор ингредиентов.';
        render({focus:'#' + titleId});
      } catch (error) {
        if (own !== revision || !dialog.open) return;
        loading = false; loadFailed = true; status = error.message || 'Проверь подключение и повтори загрузку.';
        render({focus:'[data-gwe-status]'});
      }
    }
    async function save() {
      if (busy || locked || loading) return;
      let payload;
      try {payload = retryPayload || buildPayload(groups);} catch (error) {status = error.message; render({focus:'[data-gwe-status]'}); return;}
      busy = true; status = ''; render();
      try {
        await options.onSave(payload, dialog);
        retryPayload = null; uncertain = false;
        if (dialog.open) dialog.close('saved');
      } catch (error) {
        if (!dialog.open) return;
        locked = Boolean(error.locked || error.status === 409); uncertain = !locked && Boolean(error.uncertain);
        retryPayload = uncertain ? payload : null;
        status = error.message || 'Не удалось добавить ингредиенты. Повтори попытку.';
      } finally {
        busy = false;
        if (dialog.open) render({focus:status ? '[data-gwe-status]' : null});
      }
    }
    dialog.addEventListener('click', event => {
      const button = event.target.closest('button'); if (!button || !dialog.contains(button) || button.disabled) return;
      const action = button.dataset.gwe;
      if (action === 'close') {if (!busy) dialog.close(); return;}
      if (action === 'submit') {if (stage === 1 || loadFailed) void load(loadFailed); else void save(); return;}
      if (blocked()) return;
      if (action === 'back') {revision++; loading = false; loadFailed = false; stage = 1; status = ''; render({focus:'#' + titleId}); return;}
      if (action === 'units') {const scroll = dialog.querySelector('.gwe-scroll').scrollTop; unitsOpen = !unitsOpen; render({focus:'[data-gwe="units"]',scroll}); return;}
      if (Object.hasOwn(button.dataset, 'gweUnit')) {const scroll = dialog.querySelector('.gwe-scroll').scrollTop; unitMode = button.dataset.gweUnit; unitsOpen = false; render({focus:'[data-gwe="units"]',scroll}); return;}
      if (action === 'toggle-all') {
        const deselect = groups.some(group => group.selected.size);
        groups.forEach(group => {group.selected = new Set(deselect ? [] : group.preview.ingredients.map(item => item.key));});
        for (const input of dialog.querySelectorAll('[data-gwe-ingredient]')) input.checked = !deselect;
        updateControls();
      }
    });
    dialog.addEventListener('change', event => {
      const input = event.target; if (blocked() || input.disabled) return;
      if (Object.hasOwn(input.dataset, 'gweEntry')) {
        const entry = entries[Number(input.dataset.gweEntry)]; if (!entry || !available(entry)) return;
        const key = keyOf(idOf(entry)); if (input.checked) selectedEntries.add(key); else selectedEntries.delete(key);
      } else if (Object.hasOwn(input.dataset, 'gweIngredient')) {
        const [groupIndex,itemIndex] = input.dataset.gweIngredient.split(':').map(Number), group = groups[groupIndex], ingredient = group?.preview.ingredients[itemIndex];
        if (!ingredient) return;
        if (input.checked) group.selected.add(ingredient.key); else group.selected.delete(ingredient.key);
      }
      updateControls();
    });
    dialog.addEventListener('input', event => {
      const input = event.target;
      if (blocked() || input.disabled || !Object.hasOwn(input.dataset, 'gweServings')) return;
      const index = Number(input.dataset.gweServings), group = groups[index]; if (!group?.scalable) return;
      group.servings = input.value;
      group.preview.ingredients.forEach((ingredient,itemIndex) => {const element = dialog.querySelector(`[data-gwe-amount="${index}:${itemIndex}"]`); if (element) {const amount = formatAmount(ingredient, ratioFor(group), unitMode); element.textContent = amount ? amount + ' ' : '';}});
      updateControls();
    });
    dialog.addEventListener('cancel', event => {if (busy) event.preventDefault();});
    document.addEventListener('visibilitychange', notifyVisible);
    dialog.addEventListener('close', () => {
      revision++; document.removeEventListener('visibilitychange', notifyVisible); dialog.remove(); options.onClose?.();
      if (opener?.isConnected && !opener.disabled && !opener.closest('[inert], [hidden]')) opener.focus({preventScroll:true});
    }, {once:true});
    document.body.append(dialog); render(); dialog.showModal(); dialog.querySelector('#' + titleId)?.focus({preventScroll:true});
    if (options.skipChoose) void load();
    return dialog;
  }
  window.GroceriesEditor = Object.freeze({open, formatAmount});
})();
