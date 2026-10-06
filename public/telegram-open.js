(() => {
  const link = document.getElementById('telegram-fallback');
  const status = document.getElementById('telegram-status');
  if (!link || !status) return;
  const webUrl = link.href;
  const appUrl = link.dataset.appUrl;
  const button = document.getElementById('telegram-launch');
  if (button) {
    let timer;
    let leftPage = false;
    const stop = () => { leftPage = true; clearTimeout(timer); };
    const fallback = () => {
      if (!leftPage && document.visibilityState === 'visible') location.replace(webUrl);
    };
    button.addEventListener('click', event => {
      // Keep the app launch synchronous with the user's tap.
      if (event.button !== undefined && event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      clearTimeout(timer);
      leftPage = false;
      status.textContent = 'Открываю Telegram. Затем нажмите «Начать».';
      timer = setTimeout(fallback, 1800);
      try { location.assign(appUrl); } catch { clearTimeout(timer); fallback(); }
    });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') stop(); });
    window.addEventListener('pagehide', stop);
    link.addEventListener('click', stop);
    return;
  }
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
