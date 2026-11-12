const hash = 'f7b60bf68b13d4e147d33e409a82c004';
const allowed = new Set(['campaign', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'campaign_id', 'adgroup_id', 'phrase_id', 'device', 'yclid', 'etext', 'ybaip']);
export function start() {
  const root = document.getElementById('landing');
  const visible = () => document.visibilityState === 'visible' && root && !root.hidden && root.getClientRects().length && !window.__miniLaunch && !window.Telegram?.WebApp?.initData;
  if (!document.querySelector('meta[name="yandex-metrika-counter"]') || window.__landingMetricoolStarted || !visible() || window.top !== window.self || !['/', '/index.html'].includes(location.pathname) || location.hash || /bot\b|crawler|spider|preview/i.test(navigator.userAgent)) return;
  // The vendor sends the current URL: never load it on personal or unknown links.
  if ([...new URLSearchParams(location.search)].some(([key, value]) => !allowed.has(key) || value.length > (key === 'etext' ? 2048 : 200))) return;
  try { if (Number(localStorage.getItem('recipe-landing-internal-until')) > Date.now()) return; } catch {}
  window.__landingMetricoolStarted = true;
  const script = document.createElement('script');
  script.async = true;
  script.src = 'https://tracker.metricool.com/resources/be.js';
  let sent = false;
  script.onload = () => {
    if (sent || !visible() || location.hash) return;
    if ([...new URLSearchParams(location.search)].some(([key, value]) => !allowed.has(key) || value.length > (key === 'etext' ? 2048 : 200))) return;
    sent = true;
    try { window.beTracker?.t({ hash }); } catch {}
  };
  script.onerror = () => {};
  document.head.append(script);
}
