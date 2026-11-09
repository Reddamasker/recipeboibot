(() => {
  const root = document.getElementById('landing');
  if (!root) return;
  const el = (id) => document.getElementById(id);
  const menu = el('lp-menu-toggle');
  const navigation = el('lp-navigation');
  if (menu && navigation) {
    const closeMenu = () => { menu.setAttribute('aria-expanded', 'false'); navigation.classList.remove('is-open'); };
    menu.addEventListener('click', () => {
      const open = menu.getAttribute('aria-expanded') !== 'true';
      menu.setAttribute('aria-expanded', String(open));
      navigation.classList.toggle('is-open', open);
    });
    navigation.addEventListener('click', (event) => { if (event.target.closest('a')) closeMenu(); });
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && menu.getAttribute('aria-expanded') === 'true') { closeMenu(); menu.focus(); } });
  }
  const showcase = root.querySelector('.lp-showcase');
  const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
  const replay = el('lp-flow-replay');
  {
    const sources = [...showcase.querySelectorAll('.lp-artifacts > *')];
    const lastRow = showcase.querySelector('.lp-flow-row:last-child');
    let hasPlayed = false;
    let targetVisible = false;
    const finishFlow = () => {
      showcase.classList.remove('is-playing');
      showcase.classList.add('is-complete');
    };
    const playFlow = () => {
      if (motionPreference.matches || document.visibilityState !== 'visible' || root.hidden || !root.getClientRects().length) return;
      hasPlayed = true;
      showcase.classList.remove('is-playing', 'is-complete');
      const target = el('lp-flow-bot').getBoundingClientRect();
      const centerX = target.left + target.width / 2;
      const centerY = target.top + target.height / 2;
      sources.forEach((source, index) => {
        const box = source.getBoundingClientRect();
        source.style.setProperty('--delay', `${.7 + index * .22}s`);
        source.style.setProperty('--travel-x', `${centerX - box.left - box.width / 2}px`);
        source.style.setProperty('--travel-y', `${centerY - box.top - box.height / 2}px`);
      });
      void showcase.offsetWidth;
      showcase.classList.add('is-playing');
    };
    lastRow.addEventListener('animationend', (event) => {
      if (event.animationName !== 'lp-row-appear') return;
      finishFlow();
    });
    replay.addEventListener('click', playFlow);
    const playWhenVisible = () => { if (!hasPlayed && targetVisible) playFlow(); };
    const syncMotionPreference = () => {
      replay.hidden = motionPreference.matches;
      if (motionPreference.matches) finishFlow();
      else if (!hasPlayed) {
        showcase.classList.remove('is-complete');
        showcase.classList.add('is-ready');
        playWhenVisible();
      }
    };
    motionPreference.addEventListener('change', syncMotionPreference);
    document.addEventListener('visibilitychange', playWhenVisible);
    syncMotionPreference();
    const observer = new IntersectionObserver((entries) => {
      targetVisible = entries.some((entry) => entry.isIntersecting && entry.intersectionRatio >= 1);
      playWhenVisible();
    }, { threshold: 1, rootMargin: '-100px 0px -16px 0px' });
    observer.observe(el('lp-flow-bot'));
  }
})();
