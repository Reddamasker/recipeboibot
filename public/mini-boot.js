(() => {
  const report = (stage) => {
    fetch(`/healthz?mini=${encodeURIComponent(stage)}`, { cache: 'no-store', keepalive: true }).catch(() => {});
  };
  window.miniProbe = report;
  report('boot-script');
  document.addEventListener('DOMContentLoaded', () => report('dom-ready'));
  window.addEventListener('error', () => report('script-error'), true);
  window.addEventListener('unhandledrejection', () => report('promise-error'));

  let nativeReady = false;
  let ready = false;
  const isMiniLaunch = () => Boolean(window.Telegram?.WebApp?.initData || window.TelegramWebviewProxy?.postEvent || /(?:^#|[&?])tgWebAppData=/.test(location.hash));
  const showAppShell = () => {
    if (!isMiniLaunch()) return false;
    window.__miniLaunch = true;
    const landing = document.querySelector('#landing');
    if (landing) landing.hidden = true;
    const app = document.querySelector('#app');
    if (!app) return false;
    app.hidden = false;
    // Reveal the existing app shell before removing Telegram's native cover.
    try {
      if (!nativeReady && window.TelegramWebviewProxy?.postEvent) {
        window.TelegramWebviewProxy.postEvent('web_app_ready', JSON.stringify(''));
        nativeReady = true;
        report('native-ready');
      }
    } catch { report('native-ready-error'); }
    return true;
  };
  const signalReady = () => {
    if (!showAppShell() || ready || !window.Telegram?.WebApp) return;
    try {
      window.Telegram.WebApp.ready();
      ready = true;
      report('telegram-ready');
    } catch { report('telegram-ready-error'); }
  };
  const shellObserver = new MutationObserver(() => {
    if (showAppShell()) shellObserver.disconnect();
  });
  shellObserver.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('DOMContentLoaded', () => { signalReady(); shellObserver.disconnect(); });
  signalReady();
  const readyPoll = setInterval(signalReady, 100);
  setTimeout(() => {
    clearInterval(readyPoll);
    shellObserver.disconnect();
    if (!ready && window.__miniLaunch) report('telegram-missing');
  }, 10000);

  setTimeout(() => {
    if (!window.__miniLaunch || window.__miniRendered) return;
    report('interface-timeout');
    const app = document.querySelector('#app');
    const landing = document.querySelector('#landing');
    if (!app || !landing) return;
    landing.hidden = true;
    app.hidden = false;
    app.innerHTML = '<main class="outside"><div class="brand-mark">!</div><h1>Не удалось открыть ужин</h1><p>Закройте это окно и нажмите кнопку в последнем сообщении бота ещё раз.</p></main>';
  }, 15000);
})();
