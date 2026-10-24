// Platform choice comes from the served document, never from user input.
(() => {
  const settings = window.__recipePlatform || {};
  const name = settings.name === 'max' ? 'max' : 'telegram';
  const sdk = () => name === 'max' ? window.WebApp : window.Telegram?.WebApp;
  let profile = {};
  const botUrl = (route = '') => {
    const username = profile.botUsername || settings.botUsername || (name === 'telegram' ? 'Recipeboibot' : '');
    const base = profile.botUrl || settings.botUrl || `https://${name === 'max' ? 'max.ru' : 't.me'}/${encodeURIComponent(username)}`;
    const url = new URL(base);
    if (route) url.searchParams.set('start', route);
    return url.toString();
  };
  const openBot = (route = '') => {
    const app = sdk(), url = botUrl(route);
    const open = name === 'max' ? app?.openMaxLink : app?.openTelegramLink;
    if (typeof open === 'function') { open.call(app, url); return true; }
    return false;
  };
  const initialRoute = () => {
    if (name !== 'max') return null;
    // Called only after /api/me validates SDK initData. All sources below provide
    // navigation hints, never identity, permissions, or arbitrary destination URLs.
    const app = sdk();
    const parameter = (source, key) => {
      const values = new URLSearchParams(source || '').getAll(key);
      return values.length === 1 ? values[0] : null;
    };
    const launchLocation = typeof location === 'undefined' ? {} : location;
    // Older MAX launches append ?WebAppStartParam even if the registered URL
    // already has a query. Accept that separator for this one bounded hint.
    const launchParameter = source => parameter(String(source || '').replace(/[?#]/g, '&'), 'WebAppStartParam');
    const payloads = [parameter(app?.initData, 'start_param'), app?.initDataUnsafe?.start_param,
      launchParameter(launchLocation.search), launchParameter(launchLocation.hash)];
    for (const payload of payloads) {
      if (typeof payload !== 'string' || payload.length > 512 || !/^[A-Za-z0-9_-]+$/.test(payload)) continue;
      try {
        const bytes = Uint8Array.from(atob(payload.replace(/-/g, '+').replace(/_/g, '/')), character => character.charCodeAt(0));
        const input = JSON.parse(new TextDecoder().decode(bytes));
        if (!input || typeof input !== 'object' || Array.isArray(input)) continue;
        const route = {};
        if (['menu', 'dinner', 'collection', 'offer', 'benefits', 'pricing', 'feedback', 'notifications', 'results', 'request', 'search', 'add', 'promo', 'checkout', 'payment-result', 'trial-onboarding', 'trial-guide', 'tastes'].includes(input.view)) route.view = input.view;
        if (['results', 'request', 'search'].includes(route.view) && typeof input.q === 'string' && input.q.length <= 500 && !/[\u0000-\u001f\u007f]/.test(input.q)) route.q = input.q;
        if (typeof input.recipe === 'string' && /^(?:(?:seed|dinner):)?[A-Za-z0-9_-]{1,100}$/.test(input.recipe)) route.recipe = input.recipe;
        if (route.view === 'payment-result' && typeof input.order === 'string' && /^[0-9a-f-]{36}$/i.test(input.order)) route.order = input.order;
        if (typeof input.notification === 'string' && /^[0-9a-f-]{36}$/i.test(input.notification)) route.notification = input.notification;
        if (Object.keys(route).length) return route;
      } catch { /* Try the next supported source; malformed navigation is ignored. */ }
    }
    return null;
  };
  window.RecipePlatform = Object.freeze({
    name, label: name === 'max' ? 'MAX' : 'Telegram',
    get sdk() { return sdk(); },
    authHeader: () => `${name === 'max' ? 'mxa' : 'tma'} ${sdk()?.initData || ''}`,
    botUrl, openBot, initialRoute,
    setProfile(value) { profile = value || {}; },
    async share({ title, text, url }) {
      const app = sdk();
      if (name === 'max' && typeof app?.shareMaxContent === 'function') { await app.shareMaxContent({ text, link: url }); return; }
      if (name === 'telegram') {
        const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`;
        if (typeof app?.openTelegramLink === 'function') { app.openTelegramLink(shareUrl); return; }
        if (typeof app?.openLink === 'function') { app.openLink(shareUrl); return; }
      }
      if (navigator.share) { await navigator.share({ title, text, url }); return; }
      await navigator.clipboard.writeText(url);
      return 'copied';
    }
  });
})();
