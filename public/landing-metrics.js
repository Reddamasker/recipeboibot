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
      if (!response.ok) return;
      const data = await response.json();
      if (!/^\/landing\/go\/[a-f0-9]{32}$/.test(data.href || '')) return;
      for (const link of root.querySelectorAll('a[href]')) {
        const url = new URL(link.href, location.origin);
        if (url.hostname === 't.me' && url.searchParams.get('start') === 'save') link.href = data.href;
      }
    } catch { /* Analytics must never block the existing Telegram link. */ }
  };
  document.addEventListener('visibilitychange', track);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', track, { once: true });
  else void track();
})();
