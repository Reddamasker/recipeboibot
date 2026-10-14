(() => {
  'use strict';
  const dialog = document.getElementById('catalog-benefits');
  if (!dialog || typeof dialog.showModal !== 'function') return;
  const seenKey = 'recipe-catalog-benefits-seen-v1';
  let seen = false, flowId, visibleAt = 0, returnFocus, scrollY = 0, onClose, ctaRecorded = false;
  try { seen = sessionStorage.getItem(seenKey) === '1'; } catch {}
  function record(name) {
    if (!visibleAt) return;
    try { window.RecipeAnalytics?.event(name, 'catalog', {flowId, durationMs:Math.min(86400000, Math.max(0, Date.now() - visibleAt))}); } catch {}
  }
  function checkVisible() {
    if (!dialog.open || visibleAt || document.visibilityState !== 'visible') return;
    const box = dialog.getBoundingClientRect();
    if (!box.width || !box.height || getComputedStyle(dialog).visibility !== 'visible') return;
    const point = document.elementFromPoint(Math.max(0, Math.min(innerWidth - 1, box.left + box.width / 2)), Math.max(0, Math.min(innerHeight - 1, box.top + box.height / 2)));
    if (!point || !dialog.contains(point)) return;
    visibleAt = Date.now(); seen = true;
    try { sessionStorage.setItem(seenKey, '1'); } catch {}
    record('benefits_view');
  }
  function close({restoreFocus = true, observeRecipe = true} = {}) {
    if (!dialog.open) return;
    checkVisible(); record('benefits_close');
    dialog.close();
    document.body.classList.remove('benefits-open');
    document.body.style.top = '';
    window.scrollTo({top:scrollY, behavior:'instant'});
    if (restoreFocus && returnFocus?.isConnected) returnFocus.focus({preventScroll:true});
    const callback = onClose; onClose = null;
    if (observeRecipe) callback?.();
  }
  function open(recipe, {automatic = false, afterClose} = {}) {
    if (dialog.open || (automatic && seen)) return false;
    returnFocus = document.activeElement;
    if (!returnFocus || returnFocus === document.body || returnFocus.closest('#catalog-view')) returnFocus = document.querySelector('#recipe-view h1');
    if (returnFocus?.tagName === 'H1') returnFocus.setAttribute('tabindex', '-1');
    flowId = crypto.randomUUID(); visibleAt = 0; ctaRecorded = false; onClose = afterClose;
    scrollY = window.scrollY;
    document.body.style.top = `-${scrollY}px`;
    document.body.classList.add('benefits-open');
    dialog.showModal();
    dialog.querySelector('.benefits-scroll').scrollTop = 0;
    requestAnimationFrame(checkVisible);
    return true;
  }
  document.getElementById('benefits-close').addEventListener('click', () => close());
  for (const id of ['benefits-cta','benefits-cta-max']) document.getElementById(id)?.addEventListener('click', () => {
    if (!dialog.open || document.visibilityState !== 'visible') return;
    checkVisible(); if (!ctaRecorded && visibleAt) { record('benefits_cta'); ctaRecorded = true; }
  });
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    const controls = [...dialog.querySelectorAll('button,a[href]')].filter(element => !element.disabled && element.getClientRects().length);
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  });
  document.addEventListener('visibilitychange', checkVisible);
  window.addEventListener('resize', checkVisible);
  window.CatalogBenefits = {open, close};
})();
