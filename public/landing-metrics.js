(() => {
  const root = document.getElementById('landing');
  if (!root) return;
  const params = new URLSearchParams(location.search);
  const dinner = params.get('campaign') === 'ya-dinner-landing-202610' || params.get('utm_campaign') === 'ya_dinner_landing_search_202610';
  if (dinner && !window.__miniLaunch && !window.Telegram?.WebApp?.initData) {
    const replace = (selector, text) => { const element = root.querySelector(selector); if (element) element.textContent = text; };
    replace('#lp-title', 'Что приготовить на ужин?');
    replace('.lp-lead', 'Telegram-бот «Твои рецепты» подберёт ужин по вашим вкусам, ограничениям и продуктам. Ответьте на несколько вопросов и получите первый рецепт бесплатно.');
    replace('.lp-caption', 'Откройте Telegram, нажмите Start и расскажите о своих предпочтениях.');
    replace('.lp-end h2', 'Подберите ужин на сегодня');
    replace('.lp-end p', 'Ваши вкусы и ограничения сохранятся — в следующий раз подбирать будет проще.');
    for (const link of root.querySelectorAll('a[href]')) {
      const url = new URL(link.href, location.origin);
      if (url.hostname === 't.me' && url.searchParams.get('start') === 'save') {
        url.searchParams.set('start', 'dinner'); link.href = url.href; link.textContent = 'Подобрать ужин в Telegram';
      }
    }
  }
  let sent = false;
  const track = async () => {
    if (sent || document.visibilityState !== 'visible' || root.hidden || !root.getClientRects().length || window.__miniLaunch || window.Telegram?.WebApp?.initData) return;
    sent = true;
    try {
      const visitId = [...crypto.getRandomValues(new Uint8Array(16))].map(value => value.toString(16).padStart(2, '0')).join('');
      const query = new URLSearchParams(location.search);
      const allowed = new Set(['campaign', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'campaign_id', 'adgroup_id', 'phrase_id', 'device', 'yclid']);
      for (const key of [...query.keys()]) if (!allowed.has(key)) query.delete(key);
      const response = await fetch('/api/landing/view', { method: 'POST', credentials: 'omit', headers: { 'content-type': 'application/json', 'x-landing-request': '1' }, body: JSON.stringify({ visitId, query: query.toString() }), keepalive: true });
      if (!response.ok) return;
      const data = await response.json();
      if (!/^\/landing\/go\/[a-f0-9]{32}$/.test(data.href || '')) return;
      for (const link of root.querySelectorAll('a[href]')) {
        const url = new URL(link.href, location.origin);
        if (url.hostname === 't.me' && ['save', 'dinner'].includes(url.searchParams.get('start'))) link.href = data.href;
      }
    } catch { /* Analytics must never block the existing Telegram link. */ }
  };
  document.addEventListener('visibilitychange', track);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', track, { once: true });
  else void track();
})();
