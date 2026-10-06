(() => {
  const link = document.getElementById('telegram-fallback');
  const status = document.getElementById('telegram-status');
  if (!link || !status) return;
  const webUrl = link.href;
  const appUrl = link.dataset.appUrl;
  let started = false;
  let leftPage = false;
  let timer;
  const stop = () => {
    leftPage = true;
    clearTimeout(timer);
    status.textContent = 'Если Telegram не открылся, воспользуйтесь ссылкой.';
  };
  const fallback = () => {
    if (leftPage || document.visibilityState !== 'visible') return;
    status.textContent = 'Перехожу в Telegram…';
    location.replace(webUrl);
  };
  const start = () => {
    if (started || leftPage || document.visibilityState !== 'visible') return;
    started = true;
    // Create the fallback before the app launch; some browsers reject the scheme.
    timer = setTimeout(fallback, 1800);
    try { location.assign(appUrl); } catch { clearTimeout(timer); fallback(); }
  };
  document.addEventListener('visibilitychange', () => {
    if (started && document.visibilityState === 'hidden') stop();
    else start();
  });
  window.addEventListener('pagehide', stop);
  link.addEventListener('click', stop);
  start();
})();
