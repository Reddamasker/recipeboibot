(() => {
  const root = document.getElementById('landing');
  if (!root) return;
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
      if (!response.ok) { void import('/landing-metrika.js?v=4').then(module => module.start()).catch(() => {}); return; }
      const data = await response.json();
      if (!/^\/landing\/go\/[a-f0-9]{32}$/.test(data.href || '')) return;
      void import('/landing-metrika.js?v=4').then(module => module.start(visitId)).catch(() => {});
      void import('/landing-heatmap.js?v=1').then(module => module.start(visitId)).catch(() => {});
      for (const link of root.querySelectorAll('a[href]')) {
        const url = new URL(link.href, location.origin);
        if (link.dataset?.landingPlatform === 'max') link.href = `${data.href}?platform=max`;
        else if (window.__recipePlatform?.name !== 'max' && url.hostname === 't.me' && ['collection', 'save', 'dinner'].includes(url.searchParams.get('start'))) link.href = data.href;
      }
    } catch {
      // Keep the existing unlinked Metrika view if our own collection is down.
      void import('/landing-metrika.js?v=4').then(module => module.start()).catch(() => {});
    }
  };
  document.addEventListener('visibilitychange', track);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', track, { once: true });
  else void track();
})();
