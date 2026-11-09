(() => {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const meals = {breakfast:'Завтрак',lunch:'Обед',dinner:'Ужин',snack:'Перекус'};
  const paths = {
    left:'<path d="m15 4-8 8 8 8"/>',right:'<path d="m9 4 8 8-8 8"/>',plus:'<path d="M12 3v18M3 12h18"/>',
    settings:'<path d="M4 5h8m5 0h3M4 12h3m5 0h8M4 19h8m5 0h3"/><rect x="12" y="3" width="5" height="4" rx="1"/><rect x="7" y="10" width="5" height="4" rx="1"/><rect x="12" y="17" width="5" height="4" rx="1"/>',
    calendar:'<path d="M4 4h16v11M4 4v17h10M3 9h18M8 2v5m8-5v5m2 7 1.4 2.6L22 18l-2.6 1.4L18 22l-1.4-2.6L14 18l2.6-1.4Z"/>',
    basket:'<path d="m7 8 3-5m7 5-3-5M2 9h20M4 10l2 10h9M9 12v5m5-5v5m6-3v8m-4-4h8"/>',
    tag:'<path d="m3 12 10-10h8v8L11 20Z"/><circle cx="17" cy="6" r="1.2"/>',
    check:'<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
    trash:'<path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7"/>',
    close:'<path d="m6 6 12 12M18 6 6 18"/>',
    note:'<path d="M5 3h10l4 4v14H5ZM15 3v5h4M8 12h8m-8 4h6"/>',
    recipe:'<path d="M5 3h14v18H5ZM8 7h8m-8 5h8m-8 5h5"/>',
    more:'<circle cx="4" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="20" cy="12" r="1"/>'
  };
  const icon = name => `<svg class="mp-icon" viewBox="0 0 24 24" aria-hidden="true">${paths[name] || ''}</svg>`;
  const safeImage = value => {
    if (typeof value !== 'string' || !value) return '';
    try { const url = new URL(value, location.origin); return ['https:','http:'].includes(url.protocol) ? value : ''; } catch { return ''; }
  };
  let rendering = 0;
  function actionButton(action, label, name, entry, extra = '') {
    return `<button type="button" class="mp-swipe-action" data-review="${action}" data-entry-id="${esc(entry.id)}" tabindex="-1" ${extra}><span class="mp-action-circle">${icon(name)}</span><span>${label}</span></button>`;
  }
  function entryMarkup(entry, index, renderId) {
    const note = entry.kind === 'note', available = entry.recipeAvailable !== false && Boolean(entry.recipe);
    const title = note ? entry.note || '' : entry.recipe?.title || 'Рецепт недоступен';
    const image = note ? '' : safeImage(entry.recipe?.thumbnailUrl);
    const badge = Object.hasOwn(meals,entry.meal) ? meals[entry.meal] : null, cooked = !note && entry.cooked === true;
    const actionsId = `mp-actions-${renderId}-${index}`;
    return `<article class="mp-entry${note?' mp-entry--note':''}${cooked?' is-cooked':''}" data-entry-id="${esc(entry.id)}">
      <div class="mp-actions mp-actions--before" aria-hidden="true" inert>${actionButton('plan-type','Приём пищи','tag',entry)}</div>
      <div class="mp-actions mp-actions--after" id="${actionsId}" aria-hidden="true" inert>${note?'':actionButton('plan-cooked','Готово','check',entry,`aria-pressed="${cooked}"`)+actionButton('plan-grocery','Покупки','basket',entry,available?'':'disabled')}${actionButton('remove-plan','Убрать','trash',entry)}</div>
      <div class="mp-surface">
        <button type="button" class="mp-entry-open" data-review="${note?'edit-plan':'plan-open'}" data-entry-id="${esc(entry.id)}" ${!note&&!available?'disabled':''}>
          ${image?`<img class="mp-thumbnail" src="${esc(image)}" alt="" loading="lazy" draggable="false">`:`<span class="mp-thumbnail mp-thumbnail--placeholder">${icon(note?'note':'recipe')}</span>`}
          <span class="mp-entry-text"><span class="mp-entry-title">${esc(title)}</span>${badge?`<span class="mp-meal mp-meal--${entry.meal}">${esc(badge)}</span>`:''}${cooked?`<span class="mp-cooked">${icon('check')}<span>Готово</span></span>`:''}</span>
        </button>
        <button type="button" class="mp-more" data-mp-more aria-label="Действия записи: ${esc(title)}" aria-expanded="false" aria-controls="${actionsId}" aria-describedby="mp-swipe-help-${renderId}">${icon('more')}</button>
      </div>
    </article>`;
  }
  function render({days = [], entries = [], weekLabel = '', loading = false, tipDismissed = false} = {}) {
    const renderId = ++rendering, rows = Array.isArray(entries) ? entries : [], calendar = Array.isArray(days) ? days : [];
    let index = 0;
    const populated = rows.length > 0;
    const tip = populated && !tipDismissed ? `<aside class="mp-tip"><button type="button" class="mp-tip-close" data-review="plan-tip-dismiss" aria-label="Скрыть подсказку">${icon('close')}</button><h2>Действия с блюдами</h2><p>Смахни блюдо влево или вправо, чтобы открыть действия.</p></aside>` : '';
    const body = populated ? tip + `<div class="mp-days">${calendar.map(day => {
      const items = rows.filter(entry => entry.date === day.key);
      return `<section class="mp-day${day.isToday?' is-today':''}" aria-label="${esc(day.weekday)} ${esc(day.dateLabel)}"><header class="mp-day-heading"><h2><span>${esc(day.weekday)}</span><small>${esc(day.dateLabel)}</small></h2><button type="button" class="mp-day-add" data-review="plan-add" data-date="${esc(day.key)}" aria-label="Добавить на ${esc(day.dateLabel)}">${icon('plus')}</button></header>${items.length?items.map(entry => entryMarkup(entry,index++,renderId)).join(''):'<p class="mp-day-empty">Ничего не запланировано</p>'}</section>`;
    }).join('')}</div>` : loading ? '<div class="mp-loading" role="status">Загружаем меню…</div>' : `<div class="mp-empty"><img class="mp-calendar-art" src="/review/recime-20261109/calendar.svg?v=original-1" alt=""><h2>Пока ничего не запланировано…</h2></div><div class="mp-empty-actions"><button type="button" class="mp-add-recipe" data-review="plan-add">${icon('plus')}<span>Добавить из моих рецептов</span>${icon('right')}</button><button type="button" class="mp-magic" data-review="plan-magic">${icon('calendar')}<span>Составить меню</span>${icon('right')}</button></div>`;
    return `<section class="mp-view"><header class="mp-header"><h1>Моё меню</h1><button type="button" class="mp-settings" data-review="plan-settings" aria-label="Настройки меню">${icon('settings')}</button></header><main class="mp-panel" aria-busy="${Boolean(loading)}"><div class="mp-week"><button type="button" data-review="previous-week" aria-label="Предыдущая неделя">${icon('left')}</button><strong>${esc(weekLabel)}</strong><button type="button" data-review="next-week" aria-label="Следующая неделя">${icon('right')}</button></div><p class="mp-sr-only" id="mp-swipe-help-${renderId}">Стрелка вправо открывает выбор приёма пищи, влево — остальные действия. Escape закрывает действия.</p>${body}</main>${populated?`<button type="button" class="mp-groceries" data-review="plan-groceries" aria-label="Добавить продукты из меню в покупки">${icon('basket')}</button>`:''}</section>`;
  }

  const mounts = new WeakMap();
  function mount(root) {
    mounts.get(root)?.();
    const view = root.matches?.('.mp-view') ? root : root.querySelector('.mp-view');
    if (!view) return () => {};
    let open = null, pointer = null, suppressed = null, suppressUntil = 0, disposed = false;
    const lane = (row, side) => row.querySelector(side > 0 ? '.mp-actions--before' : '.mp-actions--after');
    const offset = row => Number(row.dataset.mpOffset || 0);
    function setPosition(row, value, dragging = false) {
      row.dataset.mpOffset = String(value);
      row.style.setProperty('--mp-offset', value + 'px');
      row.classList.toggle('is-dragging', dragging);
    }
    function access(row, side) {
      for (const [part, sign] of [['before',1],['after',-1]]) {
        const actions = row.querySelector('.mp-actions--' + part), shown = sign === side;
        actions.inert = !shown; actions.setAttribute('aria-hidden', String(!shown));
        actions.querySelectorAll('button').forEach(button => { button.tabIndex = shown && !button.disabled ? 0 : -1; });
      }
      row.querySelector('[data-mp-more]').setAttribute('aria-expanded', String(Boolean(side)));
    }
    function close() {
      if (open) {setPosition(open,0);access(open,0);open.classList.remove('is-open');}
      open = null;
    }
    function reveal(row, side, focus = false) {
      if (open && open !== row) close();
      if (!side) {setPosition(row,0);access(row,0);row.classList.remove('is-open');if(open === row)open = null;return;}
      const width = lane(row,side).getBoundingClientRect().width;
      setPosition(row,side * width);access(row,side);row.classList.add('is-open');open = row;
      if (focus) lane(row,side).querySelector('button:not(:disabled)')?.focus({preventScroll:true});
    }
    function release(cancel = false) {
      const active = pointer; pointer = null;
      if (!active) return;
      if (active.horizontal) {
        suppressed = active.row; suppressUntil = performance.now() + 500;
        if (cancel) reveal(active.row,0);
        else {
          const value = offset(active.row), side = Math.sign(value), width = side ? lane(active.row,side).getBoundingClientRect().width : 0;
          const fast = Math.abs(active.lastX-active.x) > 18 && Math.abs(active.lastX-active.x) / Math.max(1,performance.now()-active.at) > .45;
          reveal(active.row,side && (Math.abs(value) > width*.35 || fast) ? side : 0);
        }
      }
      if (active.surface.hasPointerCapture?.(active.id)) active.surface.releasePointerCapture(active.id);
    }
    function down(event) {
      if (event.isPrimary === false || event.button !== 0 || event.target.closest('[data-mp-more]')) return;
      const surface = event.target.closest('.mp-surface'), row = surface?.closest('.mp-entry');
      if (!row || !view.contains(row)) return;
      release(true);if(open && open !== row)close();
      pointer = {id:event.pointerId,surface,row,x:event.clientX,y:event.clientY,lastX:event.clientX,start:offset(row),at:performance.now(),horizontal:false};
    }
    function move(event) {
      if (!pointer || event.pointerId !== pointer.id) return;
      const dx = event.clientX-pointer.x, dy = event.clientY-pointer.y;
      if (!pointer.horizontal) {
        if (Math.abs(dy) > 8 && Math.abs(dy) > Math.abs(dx)) {release(true);close();return;}
        if (Math.abs(dx) < 9 || Math.abs(dx) < Math.abs(dy)*1.2) return;
        pointer.horizontal = true;pointer.surface.setPointerCapture?.(event.pointerId);
      }
      if (event.cancelable) event.preventDefault();
      pointer.lastX = event.clientX;
      const min = -lane(pointer.row,-1).getBoundingClientRect().width, max = lane(pointer.row,1).getBoundingClientRect().width;
      setPosition(pointer.row,Math.max(min,Math.min(max,pointer.start+dx)),true);
    }
    function up(event) {if(pointer?.id === event.pointerId)release(false);}
    function cancel(event) {if(pointer?.id === event.pointerId)release(true);}
    // Touch initially captures the hit element. Moving that capture to the
    // sliding surface emits a loss on the old child, which is not cancellation.
    function lostCapture(event) {if(pointer?.id === event.pointerId && event.target === pointer.surface)release(true);}
    function click(event) {
      const row = event.target.closest('.mp-entry');
      if (!row || !view.contains(row)) return;
      if (event.target.closest('[data-mp-more]')) {
        event.preventDefault();event.stopImmediatePropagation();reveal(row,open === row ? 0 : -1,true);return;
      }
      if (event.target.closest('.mp-surface') && (row === suppressed && performance.now() < suppressUntil && event.detail !== 0 || open === row)) {
        event.preventDefault();event.stopImmediatePropagation();
        if (!(row === suppressed && performance.now() < suppressUntil)) close();
        suppressed = null;return;
      }
      if (event.target.closest('.mp-swipe-action')) close();
    }
    function keyboard(event) {
      const row = event.target.closest('.mp-entry');if(!row || !view.contains(row))return;
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {event.preventDefault();reveal(row,event.key === 'ArrowRight' ? 1 : -1,true);}
      else if (event.key === 'Escape' && open) {event.preventDefault();close();row.querySelector('[data-mp-more]').focus({preventScroll:true});}
    }
    const outside = event => {if(open && !open.contains(event.target))close();};
    const reset = () => {release(true);close();};
    const hidden = () => {if(document.hidden)reset();};
    const listeners = [[view,'pointerdown',down],[view,'pointermove',move,{passive:false}],[view,'pointerup',up],[view,'pointercancel',cancel],
      [view,'lostpointercapture',lostCapture],[view,'click',click,true],[view,'keydown',keyboard],[document,'pointerdown',outside,true],[window,'resize',reset],[document,'visibilitychange',hidden]];
    listeners.forEach(([target,type,fn,options]) => target.addEventListener(type,fn,options));
    const dispose = () => {if(disposed)return;disposed = true;reset();listeners.forEach(([target,type,fn,options]) => target.removeEventListener(type,fn,options));if(mounts.get(root) === dispose)mounts.delete(root);};
    mounts.set(root,dispose);return dispose;
  }
  window.MealPlanReference = Object.freeze({render,mount});
})();
