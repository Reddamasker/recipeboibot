(() => {
  'use strict';
  const markup = () => `
    <div class="ci-showcase" aria-label="Пример: рецепты из записок, голосовых и видео собираются в общий список">
      <div class="ci-artifacts" aria-hidden="true">
        <div class="ci-paper"><div class="ci-paper-writing"><span>Из семейной тетради</span><p class="ci-paper-title">Огурцы на зиму</p><p>На 1 литр воды:<br>соль — 2 ст. ложки<br>укроп, чеснок,<br>лист смородины</p><small>Мамин рецепт</small></div></div>
        <div class="ci-chat-scrap"><div class="ci-chat-bar"><span class="ci-chat-back">‹</span><span class="ci-chat-avatar">М</span><span class="ci-chat-name">Миша<small>был(а) недавно</small></span><span class="ci-chat-menu">⋮</span></div><div class="ci-chat-day">14 июня</div><div class="ci-chat-text">Вот тот рецепт чизкейка, про который говорили.<small>18:41</small></div><div class="ci-chat-bubble"><img src="/assets/telegram-voice-message-v1.webp" width="600" height="200" alt=""></div></div>
        <div class="ci-video-scrap"><div class="ci-video-top"><strong>Домашняя кухня</strong><span class="ci-video-dots">⋮</span></div><div class="ci-video-still"><img src="/assets/recipe-video-still-v2.webp" width="640" height="360" alt=""><span class="ci-video-title">Паста с томатами за 20 минут</span><span class="ci-video-play">▶</span><span class="ci-video-progress"><i></i></span><div class="ci-video-controls"><span>▶</span><small>0:38 / 2:14</small></div></div><div class="ci-video-caption"><p>Паста с томатами</p><small>Сохранённое видео</small></div></div>
        <div class="ci-note-scrap"><div class="ci-note-toolbar"><span>‹ Заметки</span><span>•••</span></div><strong>Греческий салат</strong><p>фета, огурцы, томаты<br>маслины, масло<br>щепотка орегано</p></div>
      </div>
      <div class="ci-conversion">
        <div class="ci-flow-source"><div class="ci-flow-bot" aria-hidden="true"><img src="/assets/recipe-bot-avatar-v3.webp" width="52" height="52" alt=""><strong>Твои рецепты</strong></div><button class="ci-flow-replay" type="button" aria-label="Повторить анимацию сохранения рецептов">Повторить</button></div>
        <svg class="ci-flow-arrow" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true"><path d="M1 8h13M9 3l5 5-5 5"/></svg>
        <div class="ci-flow-list" aria-hidden="true"><div class="ci-flow-list-heading">Общий список <span>Пример</span></div><div class="ci-flow-row" style="--delay:1.7s"><span>Огурцы на зиму</span><small>Записка</small></div><div class="ci-flow-row" style="--delay:1.9s"><span>Чизкейк</span><small>Голосовое</small></div><div class="ci-flow-row" style="--delay:2.1s"><span>Паста с томатами</span><small>Видео</small></div><div class="ci-flow-row" style="--delay:2.3s"><span>Греческий салат</span><small>Заметка</small></div></div>
      </div>
    </div>`;

  function mount(container, { played = false, onPlay = () => {} } = {}) {
    const showcase = container.querySelector('.ci-showcase');
    if (!showcase) return () => {};
    const sources = [...showcase.querySelectorAll('.ci-artifacts > *')];
    const target = showcase.querySelector('.ci-flow-bot');
    const replay = showcase.querySelector('.ci-flow-replay');
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    let disposed = false, visible = false, timer;
    const finish = () => { clearTimeout(timer); showcase.classList.remove('is-playing'); showcase.classList.add('is-complete'); };
    const play = () => {
      if (disposed || preference.matches || document.visibilityState !== 'visible' || !visible || !showcase.isConnected) return;
      clearTimeout(timer); showcase.classList.remove('is-playing', 'is-complete');
      const destination = target.getBoundingClientRect();
      for (const [index, source] of sources.entries()) {
        const box = source.getBoundingClientRect();
        source.style.setProperty('--delay', `${index * .22}s`);
        source.style.setProperty('--travel-x', `${destination.left + destination.width / 2 - box.left - box.width / 2}px`);
        source.style.setProperty('--travel-y', `${destination.top + destination.height / 2 - box.top - box.height / 2}px`);
      }
      void showcase.offsetWidth;
      showcase.classList.add('is-playing'); played = true; onPlay();
      timer = setTimeout(finish, 2900);
    };
    const maybePlay = () => { if (!played && visible) play(); };
    const visibilityChanged = () => { if (document.visibilityState !== 'visible') finish(); else maybePlay(); };
    const syncMotion = () => { replay.hidden = preference.matches; if (preference.matches || played) finish(); else maybePlay(); };
    const observer = new IntersectionObserver(entries => {
      visible = entries.some(entry => entry.isIntersecting && entry.intersectionRatio >= 1);
      if (!visible && played) finish(); else maybePlay();
    }, { threshold: 1, rootMargin: '0px 0px -96px 0px' });
    replay.addEventListener('click', play);
    preference.addEventListener('change', syncMotion);
    document.addEventListener('visibilitychange', visibilityChanged);
    syncMotion(); observer.observe(target);
    return () => {
      disposed = true; clearTimeout(timer); observer.disconnect();
      replay.removeEventListener('click', play);
      preference.removeEventListener('change', syncMotion);
      document.removeEventListener('visibilitychange', visibilityChanged);
    };
  }
  window.RecipeCollectionIntro = Object.freeze({ markup, mount });
})();
