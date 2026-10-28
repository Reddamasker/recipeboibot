(() => {
  'use strict';
  const campaignValue = new URLSearchParams(location.search).get('campaign') || '';
  const campaign = /^[a-z0-9][a-z0-9_-]{0,39}$/.test(campaignValue) ? campaignValue : null;
  const entry = /^\/dinner(?:\/|$)/.test(location.pathname) ? 'dinner' : 'catalog';
  const storageKey = `recipe-catalog-journey-v1:${entry}:${campaign || 'organic'}`;
  let flowId;
  try { flowId = sessionStorage.getItem(storageKey); } catch {}
  if (!/^[a-f0-9-]{36}$/i.test(flowId || '')) {
    flowId = crypto.randomUUID();
    try { sessionStorage.setItem(storageKey, flowId); } catch {}
  }
  const sessionId = window.RecipeAnalytics?.sessionId || crypto.randomUUID();
  const context = { flowId, sessionId, ...(campaign ? { campaign } : {}) };
  const detail = () => ({ flowId, journey: 'recipe-first-v1', ...(campaign ? { campaign } : {}) });
  function record(name, extra = {}) {
    try { window.RecipeAnalytics?.event(name, 'catalog', { ...detail(), ...extra }); } catch {}
  }
  function safeDestination(value, platform) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && url.hostname === (platform === 'max' ? 'max.ru' : 't.me') && !url.username && !url.password && !url.port ? url.href : null;
    } catch { return null; }
  }
  function mount(element, recipe) {
    element.className = 'catalog-save-bot';
    element.setAttribute('aria-labelledby', 'save-bot-title');
    element.innerHTML = '<div><h2 id="save-bot-title">Оставить рецепт под рукой?</h2><p>Сохраните его в личной коллекции бота. Читать и готовить на сайте можно без регистрации.</p></div><button class="primary" type="button" data-handoff-open aria-expanded="false" aria-controls="save-bot-platforms">Сохранить в боте</button><div id="save-bot-platforms" class="handoff-platforms" hidden><p>Где сохранить рецепт?</p><div class="handoff-platform-buttons"><button type="button" data-handoff-platform="telegram"><img src="/brand/telegram.svg" width="24" height="24" alt="">Telegram</button><button type="button" data-handoff-platform="max"><img src="/brand/max-white.svg" width="24" height="24" alt="">MAX</button></div><p class="handoff-status" role="status" aria-live="polite"></p><a class="handoff-continue" hidden rel="noopener">Открыть бота</a><button type="button" class="handoff-cancel">Продолжить читать</button></div>';
    const trigger = element.querySelector('[data-handoff-open]');
    const choices = element.querySelector('#save-bot-platforms');
    const status = element.querySelector('.handoff-status');
    const continuation = element.querySelector('.handoff-continue');
    const buttons = [...element.querySelectorAll('[data-handoff-platform]')];
    let busy = false, opened = false, requestController = null;
    trigger.addEventListener('click', () => {
      if (!element.isConnected || document.visibilityState !== 'visible') return;
      choices.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
      if (!opened) { record('catalog_save_intent'); opened = true; }
      buttons[0].focus({ preventScroll: true });
    });
    element.querySelector('.handoff-cancel').addEventListener('click', () => {
      requestController?.abort();
      choices.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      trigger.focus({ preventScroll: true });
    });
    for (const button of buttons) button.addEventListener('click', async () => {
      if (busy || choices.hidden || document.visibilityState !== 'visible') return;
      const platform = button.dataset.handoffPlatform;
      record('catalog_platform_selected', { platform });
      status.textContent = 'Готовим переход к выбранному рецепту…';
      continuation.hidden = true;
      busy = true;
      buttons.forEach(item => { item.disabled = true; });
      const startedAt = Date.now();
      requestController = new AbortController();
      const timeout = setTimeout(() => requestController?.abort('timeout'), 12000);
      try {
        const response = await fetch('/api/catalog-handoff', {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-catalog-request': '1' },
          body: JSON.stringify({ recipeId: recipe.id, platform, ...context }), signal: requestController.signal
        });
        if (!response.ok) throw Object.assign(new Error('http'), { code: response.status === 410 ? 'expired' : 'http', status: response.status });
        const result = await response.json();
        const url = safeDestination(result.url, platform);
        if (!url) throw Object.assign(new Error('http'), { code: 'http' });
        if (!element.isConnected || choices.hidden || requestController.signal.aborted) return;
        record('catalog_handoff_ready', { platform, durationMs: Math.max(0, Date.now() - startedAt) });
        continuation.href = url;
        continuation.textContent = platform === 'max' ? 'Открыть MAX' : 'Открыть Telegram';
        continuation.hidden = false;
        status.textContent = 'В боте нажмите «Начать», чтобы сохранить этот рецепт. Если приложение не открылось, нажмите на ссылку ниже.';
        try { window.RecipeAnalytics?.flushBeforeNavigate?.(); } catch {}
        // The same tab avoids popup blocking after the asynchronous preparation.
        location.assign(url);
      } catch (error) {
        if (!element.isConnected || choices.hidden) return;
        const code = requestController.signal.aborted ? 'timeout' : error.code || 'network';
        record('catalog_handoff_error', { platform, code, durationMs: Math.max(0, Date.now() - startedAt) });
        status.textContent = error.status === 404 || error.status === 410
          ? 'Этот рецепт пока не удалось передать. Вернитесь к подборке или попробуйте ещё раз.'
          : 'Не удалось открыть бота. Проверьте соединение и нажмите Telegram или MAX ещё раз. Рецепт остаётся на этой странице.';
      } finally {
        clearTimeout(timeout);
        busy = false;
        buttons.forEach(item => { item.disabled = false; });
      }
    });
  }
  window.CatalogHandoff = { context, detail, mount };
})();
