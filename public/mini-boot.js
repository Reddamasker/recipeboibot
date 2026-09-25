(() => {
  const report = (stage) => {
    fetch(`/healthz?mini=${encodeURIComponent(stage)}`, { cache: 'no-store', keepalive: true }).catch(() => {});
  };
  window.miniProbe = report;
  report('boot-script');
  document.addEventListener('DOMContentLoaded', () => report('dom-ready'));
  window.addEventListener('error', () => report('script-error'), true);
  window.addEventListener('unhandledrejection', () => report('promise-error'));

  // Telegram's iOS bridge accepts the same ready event used by its Web App SDK.
  // Send it before deferred styles and scripts can hold the native loading screen.
  try {
    if (window.TelegramWebviewProxy?.postEvent) {
      window.TelegramWebviewProxy.postEvent('web_app_ready', JSON.stringify(''));
      report('native-ready');
    }
  } catch { report('native-ready-error'); }

  let ready = false;
  const signalReady = () => {
    if (ready || !window.Telegram?.WebApp) return;
    try {
      window.Telegram.WebApp.ready();
      ready = true;
      report('telegram-ready');
    } catch { report('telegram-ready-error'); }
  };
  const readyPoll = setInterval(signalReady, 100);
  setTimeout(() => {
    clearInterval(readyPoll);
    if (!ready) report('telegram-missing');
  }, 10000);

  setTimeout(() => {
    if (!ready || window.__miniRendered) return;
    report('interface-timeout');
    const app = document.querySelector('#app');
    const landing = document.querySelector('#landing');
    if (!app || !landing) return;
    landing.hidden = true;
    app.hidden = false;
    app.innerHTML = '<main class="outside"><div class="brand-mark">!</div><h1>Не удалось открыть ужин</h1><p>Закройте это окно и нажмите кнопку в последнем сообщении бота ещё раз.</p></main>';
  }, 15000);
})();
