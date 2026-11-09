// Static marketing examples; no meal plans, shopping records or analytics are created.
const root = document.getElementById('landing');
if (root && !root.hidden && !window.__miniLaunch && !window.Telegram?.WebApp?.initData) {
  const template = document.createElement('template');
  template.innerHTML = "    <section class=\"lp-next lp-wrap\" id=\"week-planning\" aria-labelledby=\"lp-next-title\">\r\n      <div class=\"lp-next-heading\"><span class=\"lp-next-status\">Скоро в приложении</span><h2 id=\"lp-next-title\">От любимых рецептов —<br> <em>к плану на неделю.</em></h2><p>Готовим меню по дням и список покупок. Чтобы от сохранённого рецепта было проще перейти к тому, что вы приготовите.</p></div>\r\n      <div class=\"lp-next-grid\">\r\n        <article class=\"lp-next-card lp-next-menu\" aria-labelledby=\"lp-menu-title\">\r\n          <div class=\"lp-next-copy\"><span class=\"lp-next-kicker\">01 / Меню на неделю</span><h3 id=\"lp-menu-title\">Решите заранее,<br>что будете готовить.</h3><p>Выбирайте рецепты из коллекции, распределяйте по дням и приёмам пищи. Меняйте блюда и число порций под свои планы.</p></div>\r\n          <figure class=\"lp-next-example\"><img src=\"/assets/landing-week-plan.svg\" width=\"400\" height=\"338\" loading=\"lazy\" alt=\"Пример меню на две порции: паста в понедельник, курица с рисом во вторник и говядина с перцем в среду.\"><figcaption>Пример меню на неделю</figcaption></figure>\r\n          <p class=\"lp-next-detail\">Планы изменились — замените блюдо или перенесите его на другой день.</p>\r\n        </article>\r\n        <article class=\"lp-next-card lp-next-shopping\" aria-labelledby=\"lp-shopping-title\">\r\n          <div class=\"lp-next-copy\"><span class=\"lp-next-kicker\">02 / Список покупок</span><h3 id=\"lp-shopping-title\">Всё для выбранных блюд.<br>В одном списке.</h3><p>Добавляйте ингредиенты из рецептов с учётом порций. Дописывайте нужные продукты вручную и отмечайте купленное.</p></div>\r\n          <figure class=\"lp-next-example\"><img src=\"/assets/landing-shopping-list.svg\" width=\"400\" height=\"338\" loading=\"lazy\" alt=\"Пример списка: томаты 300 г, куриное филе 350 г, рис 150 г. Молоко добавлено вручную и отмечено купленным.\"><figcaption>Пример покупок из рецептов и вручную</figcaption></figure>\r\n          <p class=\"lp-next-detail\">Меню и порции меняются — список обновляется. Ручные покупки остаются.</p>\r\n        </article>\r\n      </div>\r\n      <p class=\"lp-next-note\">Меню и покупки ещё готовятся к выпуску. Пока можно сохранять рецепты, собирать коллекцию и готовить по шагам.</p>\r\n    </section>";
  const question = document.createElement('template');
  question.innerHTML = "      <details><summary>Когда появятся меню на неделю и список покупок?<span aria-hidden=\"true\">+</span></summary><p>Эти функции готовятся к выпуску. Можно будет назначать рецепты на дни, задавать порции и собирать покупки из ингредиентов. Список также будет работать отдельно от меню: продукты можно будет добавлять вручную. Точную дату пока не объявляем.</p></details>";
  const mount = () => {
    if (root.querySelector('#week-planning')) return;
    root.querySelector('.lp-product')?.before(template.content);
    root.querySelector('.lp-questions')?.append(question.content);
  };
  const style = document.createElement('link');
  style.rel = 'stylesheet';
  style.href = '/landing-features.css?v=1';
  style.onload = mount;
  style.onerror = () => style.remove();
  document.head.append(style);
}
