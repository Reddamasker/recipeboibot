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
  const quizQuestions = [
    'Пролистывали ли вы десятки видео в поисках того самого рецепта, который запомнился, но вы забыли сохранить?',
    'Тратите ли вы более 7 минут на решение вопроса, что сегодня на ужин?',
    'Терялись ли у вас рецепты из-за случайно удалённого скриншота или потерянной бумажки?'
  ];
  const quizCard = el('lp-quiz-card');
  const quizAnswers = [];
  let quizStep = 0;
  const renderQuiz = () => {
    quizCard.classList.remove('lp-quiz-result');
    el('lp-quiz-count').textContent = `${quizStep + 1} из ${quizQuestions.length}`;
    el('lp-quiz-number').textContent = `0${quizStep + 1}`;
    el('lp-quiz-question').textContent = quizQuestions[quizStep];
    quizCard.querySelectorAll('.lp-quiz-progress i').forEach((item, index) => item.classList.toggle('is-active', index <= quizStep));
    quizCard.querySelector('.lp-quiz-actions').innerHTML = '<button type="button" data-quiz-answer="yes">Да, бывало</button><button type="button" data-quiz-answer="no">Нет</button>';
    el('lp-quiz-back').hidden = quizStep === 0;
  };
  const renderQuizResult = () => {
    const fits = quizAnswers.includes('yes');
    const statistic = '<p class="lp-quiz-result-stat">Вы не одни: 45% опрошенных австралийцев тратили больше 10 минут в день, решая, что приготовить на ужин. <a href="https://mccrindle.com.au/app/uploads/images/HelloFresh_Australia27s-Cooking-Landscape_Report_FINAL_1Feb2017.pdf" target="_blank" rel="noreferrer">Источник — McCrindle Research</a></p>';
    quizCard.classList.add('lp-quiz-result');
    el('lp-quiz-number').textContent = fits ? 'Похоже, совпало' : 'Вот это порядок';
    el('lp-quiz-question').innerHTML = fits
      ? `«Рецепты» вам подойдут.<p class="lp-quiz-result-copy">Перешлите ссылку, фото, текст или голосовое один раз — и в следующий раз рецепт уже будет ждать в вашей коллекции.</p>${statistic}`
      : `У вас с рецептами всё отлично.<p class="lp-quiz-result-copy">Серьёзно: сохранить, найти и не забыть — уже половина дела. Если источников станет больше, «Рецепты» помогут удержать этот порядок.</p>${statistic}`;
    quizCard.querySelector('.lp-quiz-actions').innerHTML = '<a href="https://t.me/Recipeboibot?start=dinner">Открыть в Telegram ↗</a>';
    el('lp-quiz-back').hidden = false;
  };
  quizCard.addEventListener('click', (event) => {
    const answer = event.target.closest('[data-quiz-answer]');
    if (answer) {
      quizAnswers[quizStep] = answer.dataset.quizAnswer;
      if (quizStep === quizQuestions.length - 1) renderQuizResult();
      else { quizStep += 1; renderQuiz(); }
      return;
    }
    if (event.target === el('lp-quiz-back')) {
      if (quizCard.classList.contains('lp-quiz-result')) quizStep = quizQuestions.length - 1;
      else quizStep = Math.max(0, quizStep - 1);
      quizAnswers.length = quizStep;
      renderQuiz();
    }
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
