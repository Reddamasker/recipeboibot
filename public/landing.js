// This demo uses three local examples, never the visitor's real collection.
(() => {
  const root = document.getElementById('landing');
  if (!root) return;
  const recipes = {
    dinner: {
      title: 'Паста с томатами и базиликом', meta: '25 минут · 2 порции',
      source: 'Сохранённое видео с рецептом пасты. Это учебный пример; у рецепта из доступной ссылки в боте будет переход к оригиналу.',
      ingredients: ['Паста — 200 г', 'Томаты — 400 г', 'Чеснок — 1 зубчик', 'Оливковое масло — 2 ст. л.', 'Базилик — несколько листьев', 'Соль — по вкусу'],
      steps: ['Нарежьте томаты и чеснок. Вымойте базилик.', 'Отварите пасту по инструкции на упаковке. В сковороде прогрейте масло с чесноком, добавьте томаты и тушите до мягкости.', 'Переложите пасту к томатам. Добавьте немного воды от варки, перемешайте и посолите по вкусу. Подавайте с базиликом.']
    },
    breakfast: {
      title: 'Бабушкины сырники', meta: '20 минут · 2 порции',
      source: 'Фото семейной записки: «Творог 300 г, 1 яйцо, 3 ложки муки, ложка сахара. Слепить сырники, обвалять в муке и обжарить». Учебный пример.',
      ingredients: ['Творог — 300 г', 'Яйцо — 1 шт.', 'Мука — 3 ст. л. и немного для обваливания', 'Сахар — 1 ст. л.', 'Растительное масло — для жарки'],
      steps: ['Разомните творог с яйцом и сахаром. Добавьте муку и перемешайте.', 'Сформируйте небольшие сырники и обваляйте в муке.', 'Разогрейте немного масла. Жарьте сырники на умеренном огне с обеих сторон до золотистой корочки и полной готовности внутри.']
    },
    quick: {
      title: 'Салат с фетой', meta: '15 минут · 2 порции',
      source: 'Голосовое сообщение: «Два томата, огурец, перец, сто граммов феты и горсть маслин. Крупно нарезать, добавить масло и орегано». Учебный пример.',
      ingredients: ['Томаты — 2 шт.', 'Огурец — 1 шт.', 'Сладкий перец — 1 шт.', 'Фета — 100 г', 'Маслины — горсть', 'Оливковое масло — 2 ст. л.', 'Орегано — по вкусу'],
      steps: ['Вымойте овощи. Крупно нарежьте томаты и огурец, удалите семена перца и нарежьте его.', 'Выложите овощи в миску. Добавьте маслины и фету.', 'Полейте оливковым маслом, посыпьте орегано и подавайте.']
    }
  };
  const inputs = {
    link: 'Перешлите доступную ссылку из соцсети или чата. Бот разберёт текст или речь и сохранит переход к оригиналу.',
    photo: 'Сфотографируйте записку, страницу книги или пришлите скриншот. Текст должен быть чётким, а количества — видны.',
    text: 'Перешлите сообщение с рецептом или напишите его в чат. Укажите продукты, количества и порядок приготовления.',
    voice: 'Надиктуйте свой рецепт голосовым: какие продукты нужны, сколько и в каком порядке готовить.'
  };
  const el = (id) => document.getElementById(id);
  const buttons = [...root.querySelectorAll('[data-lp-recipe]')];
  let selected = 'dinner';
  let step = 0;
  const drawStep = () => {
    const steps = recipes[selected].steps;
    el('lp-demo-progress').textContent = `Шаг ${step + 1} из ${steps.length}`;
    el('lp-demo-step-text').textContent = steps[step];
    el('lp-step-meter').max = steps.length;
    el('lp-step-meter').value = step + 1;
    el('lp-step-meter').textContent = `${step + 1} из ${steps.length}`;
    el('lp-demo-prev').disabled = step === 0;
    el('lp-demo-next').textContent = step === steps.length - 1 ? 'К началу ↺' : 'Дальше →';
  };
  const selectRecipe = (key) => {
    selected = key;
    const recipe = recipes[key];
    el('lp-demo-title').textContent = recipe.title;
    el('lp-demo-meta').textContent = recipe.meta;
    el('lp-demo-source').textContent = recipe.source;
    el('lp-source-detail').open = false;
    el('lp-demo-ingredients').replaceChildren(...recipe.ingredients.map((text) => {
      const item = document.createElement('li');
      item.textContent = text;
      return item;
    }));
    buttons.forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.lpRecipe === key)));
    step = 0;
    drawStep();
  };
  buttons.forEach((button) => button.addEventListener('click', () => selectRecipe(button.dataset.lpRecipe)));
  root.querySelector('[data-open-example]').addEventListener('click', () => {
    el('lp-search').value = '';
    buttons.forEach((button) => { button.hidden = false; });
    el('lp-search-empty').hidden = true;
    el('lp-search-status').textContent = 'Учебная коллекция. В боте будут ваши рецепты.';
    root.querySelector('.lp-recipe-view').hidden = false;
    selectRecipe('breakfast');
  });
  el('lp-demo-prev').addEventListener('click', () => { if (step > 0) step--; drawStep(); });
  el('lp-demo-next').addEventListener('click', () => { step = (step + 1) % recipes[selected].steps.length; drawStep(); });
  const normalize = (text) => text.toLocaleLowerCase('ru').replaceAll('ё', 'е').trim();
  el('lp-search').addEventListener('input', (event) => {
    const words = normalize(event.target.value).split(/\s+/).filter(Boolean);
    const matches = buttons.filter((button) => {
      const recipe = recipes[button.dataset.lpRecipe];
      const haystack = normalize([recipe.title, ...recipe.ingredients].join(' '));
      const match = words.every((word) => haystack.includes(word));
      button.hidden = !match;
      return match;
    });
    el('lp-search-empty').hidden = matches.length > 0;
    el('lp-search-status').textContent = words.length ? `Найдено в примере: ${matches.length} из 3.` : 'Учебная коллекция. В боте будут ваши рецепты.';
    root.querySelector('.lp-recipe-view').hidden = matches.length === 0;
    if (matches.length && !matches.some((button) => button.dataset.lpRecipe === selected)) selectRecipe(matches[0].dataset.lpRecipe);
  });
  root.querySelectorAll('[data-input]').forEach((button) => button.addEventListener('click', () => {
    root.querySelectorAll('[data-input]').forEach((item) => item.setAttribute('aria-pressed', String(item === button)));
    el('lp-input-description').textContent = inputs[button.dataset.input];
  }));

  const flow = el('lp-flow');
  const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
  const replay = el('lp-flow-replay');
  if (motionPreference.matches) replay.hidden = true;
  else {
    const sources = [...flow.querySelectorAll('.lp-flow-source')];
    const lastRow = flow.querySelector('.lp-flow-row:last-child');
    let hasPlayed = false;
    const playFlow = () => {
      flow.classList.remove('is-playing', 'is-complete');
      const target = el('lp-flow-bot').getBoundingClientRect();
      const centerX = target.left + target.width / 2;
      const centerY = target.top + target.height / 2;
      sources.forEach((source) => {
        const box = source.getBoundingClientRect();
        source.style.setProperty('--travel-x', `${centerX - box.left - box.width / 2}px`);
        source.style.setProperty('--travel-y', `${centerY - box.top - box.height / 2}px`);
      });
      void flow.offsetWidth;
      flow.classList.add('is-playing');
    };
    lastRow.addEventListener('animationend', (event) => {
      if (event.animationName !== 'lp-row-appear') return;
      flow.classList.remove('is-playing');
      flow.classList.add('is-complete');
    });
    replay.addEventListener('click', playFlow);
    const observer = new IntersectionObserver((entries) => {
      if (!hasPlayed && entries.some((entry) => entry.isIntersecting)) {
        hasPlayed = true;
        playFlow();
        observer.disconnect();
      }
    }, { threshold: .55 });
    observer.observe(flow);
  }
})();
