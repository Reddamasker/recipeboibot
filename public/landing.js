// This landing uses a fictional recipe to demonstrate the product.
(() => {
  const root = document.getElementById('landing');
  if (!root) return;
  const el = (id) => document.getElementById(id);
  el('lp-demo-share').addEventListener('click', async (event) => {
    try {
      await navigator.clipboard.writeText(`${location.origin}${location.pathname}#lp-recipe-preview`);
      const button = event.currentTarget;
      button.textContent = 'Ссылка на пример скопирована';
      window.setTimeout(() => { button.textContent = 'Поделиться'; }, 2500);
    } catch { event.currentTarget.textContent = 'Не удалось скопировать'; }
  });
  const showcase = root.querySelector('.lp-showcase');
  const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
  const replay = el('lp-flow-replay');
  if (motionPreference.matches) replay.hidden = true;
  else {
    const sources = [...showcase.querySelectorAll('.lp-artifacts > *')];
    const lastRow = showcase.querySelector('.lp-flow-row:last-child');
    showcase.classList.add('is-ready');
    let hasPlayed = false;
    const playFlow = () => {
      showcase.classList.remove('is-playing', 'is-complete');
      const target = el('lp-flow-bot').getBoundingClientRect();
      const centerX = target.left + target.width / 2;
      const centerY = target.top + target.height / 2;
      sources.forEach((source, index) => {
        const box = source.getBoundingClientRect();
        source.style.setProperty('--delay', `${index * .22}s`);
        source.style.setProperty('--travel-x', `${centerX - box.left - box.width / 2}px`);
        source.style.setProperty('--travel-y', `${centerY - box.top - box.height / 2}px`);
      });
      void showcase.offsetWidth;
      showcase.classList.add('is-playing');
    };
    lastRow.addEventListener('animationend', (event) => {
      if (event.animationName !== 'lp-row-appear') return;
      showcase.classList.remove('is-playing');
      showcase.classList.add('is-complete');
    });
    replay.addEventListener('click', playFlow);
    const observer = new IntersectionObserver((entries) => {
      if (!hasPlayed && entries.some((entry) => entry.isIntersecting)) {
        hasPlayed = true;
        playFlow();
        observer.disconnect();
      }
    }, { threshold: .55 });
    observer.observe(showcase);
  }
})();
