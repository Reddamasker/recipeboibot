const allowed = new Set(['campaign','utm_source','utm_medium','utm_campaign','utm_content','utm_term','campaign_id','adgroup_id','phrase_id','device','yclid']);
let waitingForVisible = false;
export function start(visitId = null) {
  if (document.visibilityState !== 'visible') {
    if (!waitingForVisible) {
      waitingForVisible = true;
      const resume = () => { if (document.visibilityState === 'visible') { document.removeEventListener('visibilitychange', resume); waitingForVisible = false; start(visitId); } };
      document.addEventListener('visibilitychange', resume);
    }
    return;
  }
  const root = document.getElementById('landing');
  const id = Number(document.querySelector('meta[name="yandex-metrika-counter"]')?.content);
  const visible = () => document.visibilityState === 'visible' && root && !root.hidden && root.getClientRects().length && !window.__miniLaunch && !window.Telegram?.WebApp?.initData;
  if (!Number.isSafeInteger(id) || id <= 0 || window.__landingMetrikaStarted || !visible() || !['/','/index.html'].includes(location.pathname) || window.top !== window.self || location.hash || /bot\b|crawler|spider|preview/i.test(navigator.userAgent)) return;
  const query = new URLSearchParams(location.search);
  const diagnostic = query.get('_ym_status-check') === String(id) || ['1','2'].includes(query.get('_ym_debug'));
  try { if (!diagnostic && Number(localStorage.getItem('recipe-landing-internal-until')) > Date.now()) return; } catch {}
  // Do not load a third-party recorder on app/auth links or unrecognized query data.
  const valid = (key,value) => allowed.has(key) ? value.length <= 200 : key === '_ym_status-check' ? value === String(id) : key === '_ym_debug' ? ['0','1','2'].includes(value) : key === '_ym_lang' && /^[a-z]{2}$/.test(value);
  if ([...query].some(([key,value]) => !valid(key,value))) return;
  window.__landingMetrikaStarted = true;
  document.querySelectorAll('#app, input, textarea, select, [contenteditable]').forEach(node => node.classList.add('ym-hide-content','ym-disable-keys'));
  document.querySelectorAll('form').forEach(node => node.classList.add('ym-disable-submit'));
  let disabled = false;
  window.ym ||= function(...args) { if (!disabled) { window.ym.a ||= []; if (window.ym.a.length < 40) window.ym.a.push(args); } };
  window.ym.l ||= Date.now();
  const script = document.createElement('script'); script.async = true; script.src = `https://mc.yandex.ru/metrika/tag.js?id=${id}`;
  script.onerror = () => { disabled = true; if (Array.isArray(window.ym.a)) window.ym.a.length = 0; };
  document.head.append(script);
  window.ym(id, 'init', { ssr:true, defer:true, webvisor:true, clickmap:true, trackLinks:false, accurateTrackBounce:true, disableYtm:true, sendTitle:false });
  const url = new URL(location.pathname, location.origin); url.search = new URLSearchParams([...query].filter(([key]) => allowed.has(key))).toString();
  let referer = ''; try { referer = new URL(document.referrer).origin + '/'; } catch {}
  const linkedVisit = /^[a-f0-9]{32}$/.test(visitId || '') ? visitId : null;
  window.ym(id, 'hit', url.href, { title:'Твои рецепты — лендинг', referer,
    ...(linkedVisit ? { params: { recipe_visit_id: linkedVisit } } : {}) });
  if (linkedVisit) {
    let identityStarted = false;
    window.ym(id, 'getClientID', clientId => {
      if (identityStarted || disabled || !visible() || typeof clientId !== 'string' || !/^[0-9]{1,32}$/.test(clientId)) return;
      identityStarted = true;
      // Never await SDK/analytics from a navigation handler. Retry one immutable
      // association only; failures do not replace or disable the messenger link.
      void (async () => {
        for (let attempt = 0; attempt < 2; attempt++) {
          if (disabled || !visible()) return;
          try {
            const response = await fetch('/api/landing/identity', { method: 'POST', credentials: 'omit',
              headers: { 'content-type': 'application/json', 'x-landing-request': '1' },
              body: JSON.stringify({ visitId: linkedVisit, clientId }), keepalive: true,
              signal: AbortSignal.timeout(4000) });
            if (response.ok || (response.status >= 400 && response.status < 500)) return;
          } catch {}
          if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 500));
        }
      })();
    });
  }
  const goals = new Set();
  root.addEventListener('click', event => {
    if (disabled || !event.isTrusted || !visible() || !(event.target instanceof Element)) return;
    const link = event.target.closest('a[data-landing-platform]'), platform = link?.dataset.landingPlatform;
    if (!['telegram','max'].includes(platform) || goals.has(platform)) return;
    goals.add(platform);
    try { window.ym(id, 'reachGoal', `landing_${platform}_click`); } catch {}
  }, {capture:true});
  // A late Mini App launch must terminate recording before rendering private views.
  const observer = new MutationObserver(() => {
    if (root.hidden || window.__miniLaunch || window.Telegram?.WebApp?.initData) {
      disabled = true; if (Array.isArray(window.ym.a)) window.ym.a.length = 0;
      try { window.ym(id,'destruct'); } catch {} observer.disconnect();
    }
  });
  observer.observe(root,{attributes:true,attributeFilter:['hidden','style','class']});
}
