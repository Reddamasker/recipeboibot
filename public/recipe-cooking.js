(() => {
  'use strict';
  const dialogs = new WeakMap();
  function mountCooking(element, dialog, dismiss, focus) {
    const opener = document.activeElement, background = [], overflow = document.documentElement.style.overflow;
    dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.tabIndex = -1;
    document.body.append(element); focus.focus({ preventScroll: true });
    for (const sibling of document.body.children) if (sibling !== element && !['SCRIPT','STYLE','LINK'].includes(sibling.tagName) && sibling.id !== 'notice') { background.push([sibling,sibling.inert]); sibling.inert = true; }
    document.documentElement.style.overflow = 'hidden';
    const keydown = event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss(); }
      if (event.key === 'Tab') {
        const stops = [...dialog.querySelectorAll('button')].filter(e => !e.disabled), current = document.activeElement;
        if (!stops.includes(current) || event.shiftKey && current === stops[0] || !event.shiftKey && current === stops.at(-1)) { event.preventDefault(); (event.shiftKey ? stops.at(-1) : stops[0]).focus(); }
      }
    };
    const focusin = event => { if (!dialog.contains(event.target)) focus.focus({ preventScroll: true }); };
    document.addEventListener('keydown',keydown,true); document.addEventListener('focusin',focusin,true); window.addEventListener('popstate',dismiss);
    dialogs.set(element, () => {
      document.removeEventListener('keydown',keydown,true); document.removeEventListener('focusin',focusin,true); window.removeEventListener('popstate',dismiss);
      element.remove(); for (const [sibling,inert] of background) sibling.inert = inert;
      document.documentElement.style.overflow = overflow; if (opener?.isConnected && !opener.closest('[inert],[hidden]')) opener.focus({ preventScroll: true });
    });
  }
  function unmountCooking(element) { dialogs.get(element)?.(); dialogs.delete(element); }
  function open(recipe, { mount = mountCooking, unmount = unmountCooking, onComplete = null, onStep = () => {}, onAction = () => {} } = {}) {
    if (!recipe.steps?.length) return null;
    let index = 0, closed = false;
    const emit = name => { try { onAction(name); } catch {} };
    const el = document.createElement('div'); el.className = 'recipe-detail cook';
    el.setAttribute('aria-label', `Готовим: ${recipe.title}`);
    el.innerHTML = '<div class="cook-top"><span id="cook-progress"></span><button class="icon-btn" type="button" id="cook-close" aria-label="Закрыть режим готовки">✕</button></div><div class="cook-step" tabindex="-1" aria-live="polite" aria-atomic="true" aria-describedby="cook-progress"></div><div class="cook-nav"><button class="secondary" type="button" id="prev">← Назад</button><button class="primary accent" type="button" id="next"></button></div>';
    const step = el.querySelector('.cook-step'), previous = el.querySelector('#prev'), next = el.querySelector('#next');
    const draw = () => {
      el.querySelector('#cook-progress').textContent = `Шаг ${index + 1} из ${recipe.steps.length}`;
      step.textContent = typeof recipe.steps[index] === 'string' ? recipe.steps[index] : recipe.steps[index].text;
      previous.disabled = index === 0; next.textContent = index === recipe.steps.length - 1 ? 'Готово' : 'Дальше →';
      if (previous.disabled && document.activeElement === previous) next.focus(); onStep(index);
    };
    const close = (completed = false) => { if (closed) return; closed = true; unmount(el); emit(completed === true ? 'cook_complete' : 'cook_close'); if (completed === true) onComplete?.(); };
    el.onDispose = () => { if (!closed) { closed = true; emit('cook_close'); } };
    el.querySelector('#cook-close').onclick = () => close();
    previous.onclick = () => { if (!closed && index > 0) { index--; draw(); emit('cook_previous'); } };
    next.onclick = () => { if (closed) return; if (index === recipe.steps.length - 1) close(true); else { index++; draw(); emit('cook_next'); } };
    draw(); mount(el,el,close,step); emit('cook_start'); return { close, element: el };
  }
  globalThis.RecipeCooking = Object.freeze({ open });
})();
