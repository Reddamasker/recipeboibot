(() => {
  'use strict';
  const $ = selector => document.querySelector(selector);
  const el = (tag, className = '', text = '') => { const n = document.createElement(tag); n.className = className; n.textContent = text; return n; };
  const sectionNames = { intro:'Начало страницы', products:'Продукты', cuisines:'Кухни', filters:'Фильтры', results:'Список рецептов', recipe_header:'Заголовок рецепта', ingredients:'Ингредиенты', steps:'Шаги приготовления', save_cta:'Предложение сохранить в боте', footer:'Низ страницы' };
  const actionNames = { filter_change:'Изменил фильтр', filter_reset:'Сбросил фильтры', search_submit:'Применил поиск', card_open:'Нажал карточку рецепта', back_to_list:'Вернулся к списку', pagination:'Перешёл на другую страницу списка', sort_change:'Изменил сортировку', favorite_add:'Добавил в избранное браузера', favorite_remove:'Убрал из избранного браузера', share:'Нажал копирование ссылки', print:'Нажал печать', servings_change:'Изменил число порций', results_jump:'Перешёл к результатам', more_cuisines:'Раскрыл кухни', filters_expand:'Раскрыл фильтры', save_open:'Нажал «Сохранить в боте»', platform_telegram:'Выбрал Telegram', platform_max:'Выбрал MAX', cancel_save:'Продолжил читать', open_bot:'Попытка открыть бота', retry:'Повторил загрузку' };
  const controlNames = { cuisine:'кухня', category:'тип блюда', time:'время готовки', include:'продукты', exclude:'исключения' };
  const eventNames = {catalog_list:'Список рецептов стал видимым',catalog_open:'Полный рецепт стал видимым',catalog_filter:'Список с активными фильтрами',catalog_search:'Получил результаты поиска',catalog_empty:'Пустая выдача',catalog_save_intent:'Открыл выбор бота',catalog_platform_selected:'Выбрал платформу',catalog_handoff_ready:'Ссылка в бот готова',catalog_handoff_error:'Ошибка передачи в бот',catalog_bot_started:'Бот подтвердил запуск',catalog_recipe_saved:'Рецепт сохранён в боте',catalog_save_failed:'Не удалось сохранить рецепт',catalog_share:'Ссылка скопирована',catalog_print:'Вызвана печать',catalog_favorite_add:'Рецепт добавлен в избранное браузера',catalog_favorite_remove:'Рецепт убран из избранного браузера',client_error:'Ошибка страницы'};
  let page = 1, revision = 0, campaign = null, active = false, busy = false;
  const time = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('ru-RU',{timeZone:'Europe/Moscow',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'}) : 'Неизвестно';
  const duration = value => value == null ? 'Не измерялось' : value < 1000 ? '< 1 с' : value < 60000 ? `${Math.floor(value / 1000)} с` : `${Math.floor(value / 60000)} мин ${Math.floor(value % 60000 / 1000)} с`;
  const number = value => value == null ? 'Неизвестно' : Number(value).toLocaleString('ru-RU');
  const screenName = screen => screen === 'recipe' ? 'Полный рецепт' : screen === 'list' ? 'Список рецептов' : 'Страница';
  function eventLabel(row) {
    if (row.event === 'catalog_page_started') return `Открыл экран: ${screenName(row.screen).toLowerCase()}`;
    if (row.event === 'catalog_section_visible') return `Увидел блок «${sectionNames[row.section] || 'Страница'}»`;
    if (row.event === 'catalog_action') return (actionNames[row.action] || 'Действие на странице') + (row.control ? `: ${controlNames[row.control] || 'фильтр'}` : '') + (row.position ? ` (карточка ${row.position})` : '');
    return (eventNames[row.event] || 'Событие страницы') + (row.platform ? ` · ${row.platform === 'max' ? 'MAX' : 'Telegram'}` : '') + (row.event === 'catalog_filter' ? `: ${row.filters ?? '—'}` : '');
  }
  function metric(label, value) { const item=el('div','visit-metric');item.append(el('span','',label),el('strong','',value));return item; }
  function renderVisit(visit) {
    const item=el('details','visit-card'), summary=el('summary'), title=el('div','visit-title');
    item.dataset.visit = visit.startedAt;
    title.append(el('strong','',`Посещение ${visit.number} · ${time(visit.startedAt)} МСК`));
    const pages=visit.pages || [], events=visit.events || [], outcomes=visit.outcomes || [];
    const opens=events.filter(e=>e.event==='catalog_open').length;
    title.append(el('span','',`${opens ? `Открытий рецепта: ${opens}${visit.eventsTruncated ? '+' : ''}` : visit.eventsTruncated ? 'Показана часть событий' : 'Нет открытий рецепта'} · В видимой вкладке: ${duration(visit.visibleMs)}`));
    summary.append(title,el('span','visit-expand','Подробнее'));item.append(summary);
    if (visit.legacy) item.append(el('p','panel-note','До начала подробного сбора. Видимые блоки и время неизвестны.'));
    item.append(el('p','panel-note',`Последнее полученное событие: ${time(visit.lastEventAt)} МСК. ${visit.observedSpanMs > 0 ? `Интервал между событиями: ${duration(visit.observedSpanMs)}; это не время чтения.` : 'Интервал пребывания по событиям неизвестен.'}`));
    if (pages.length) {
      const list=el('div','visit-pages');
      for (const p of pages) {
        const card=el('article','visit-page');card.append(el('h3','',`Экран ${p.number}: ${screenName(p.screen)}`));
        card.append(el('p','',`В видимой вкладке: ${duration(p.visibleMs)} · До появления содержимого: ${duration(p.loadMs)}`));
        card.append(el('p','',`Прокрутка: ${p.scrollDepth == null ? 'не измерялась' : p.scrollDepth + '%'}${p.screen === 'list' ? ` · Карточек попало на экран: ${p.cardsSeen == null ? 'не измерялось' : p.cardsSeen}` : ''}`));
        card.append(el('p','',`Видимые блоки: ${(p.sections || []).length ? p.sections.map(s=>sectionNames[s] || 'Страница').join(', ') : 'не зафиксированы'}`));
        const reason = {hidden:'Вкладка скрылась',pagehide:'Страница скрылась или закрылась',navigation:'Перешёл на другой экран',heartbeat:'Последний периодический замер; окончание неизвестно'}[p.lastReason];
        if(reason)card.append(el('p','visit-page-status',reason));list.append(card);
      }
      item.append(list);
      if(visit.pagesTruncated)item.append(el('p','panel-note','Показаны первые 20 экранов; остальные доступны в сохранённой аналитике.'));
    }
    const timeline=el('ol','visit-timeline');
    for (const row of [...events,...outcomes].sort((a,b)=>String(a.at).localeCompare(String(b.at)))) {
      const line=el('li');line.append(el('time','',`${time(row.at)} МСК`),el('span','',eventLabel(row)));timeline.append(line);
    }
    if(timeline.children.length)item.append(timeline);else item.append(el('p','panel-note','Наблюдаемых действий нет.'));
    if(visit.eventsTruncated)item.append(el('p','panel-note','Показаны первые 80 действий. Сводные показатели учитывают всю сохранённую историю посещения.'));
    return item;
  }
  function draw(data) {
    if(data.status!=='ready')throw new Error('unavailable');
    const s=data.summary;
    $('#catalog-visits-summary').replaceChildren(...[
      ['Посещения',number(s.visits)],['С замером времени',number(s.measuredVisits)],['Открыли рецепт',number(s.recipeVisits)],['Нажали сохранить',number(s.saveIntentVisits)],['Запуск бота',number(s.starts)],['Сохранено в боте',number(s.saved)]
    ].map(([label,value])=>metric(label,value)));
    const expanded=new Set([...document.querySelectorAll('.visit-card[open]')].map(v=>v.dataset.visit));
    $('#catalog-visits-list').replaceChildren(...data.visits.map(v=>{const card=renderVisit(v);card.open=expanded.has(v.startedAt);return card;}));
    if(!data.visits.length)$('#catalog-visits-list').append(el('p','panel-note','Посещений за выбранный период нет.'));
    const since=data.trackingSince ? `${time(data.trackingSince)} МСК` : 'ещё не начат';
    $('#catalog-visits-status').textContent=`Подробный сбор: ${since}. Всего экранов: ${number(s.pageViews)}. Посещений с ошибками: ${number(s.errors)}. Время и видимость старых посещений не восстановлены.`;
    $('#catalog-visits-page').textContent=`Страница ${data.page} из ${Math.max(1,Math.ceil(data.totalVisits/data.pageSize))}`;
    $('#catalog-visits-prev').disabled=data.page<=1;
    $('#catalog-visits-next').disabled=data.page*data.pageSize>=data.totalVisits;
  }
  async function load() {
    if(!active)return;
    const current=++revision;busy=true;
    const q=new URLSearchParams({campaign:campaign || 'all',platform:$('#catalog-visits-platform').value,page:String(page)});
    for(const key of ['from','to'])if($('#catalog-visits-'+key).value)q.set(key,$('#catalog-visits-'+key).value);
    $('#catalog-visits-status').textContent='Загружаем посещения…';
    $('#catalog-visits-prev').disabled=true;$('#catalog-visits-next').disabled=true;
    try {
      const response=await fetch('/api/dashboard/catalog-visits?'+q,{credentials:'same-origin',headers:{'x-funnel-request':'1'}});
      if(!response.ok)throw new Error(response.status===401?'Войдите в дашборд':response.status===400?'Проверьте выбранные даты':'Данные сейчас недоступны');
      const data=await response.json();if(current!==revision)return;draw(data);
    } catch(error) {
      if(current!==revision)return;
      $('#catalog-visits-list').replaceChildren();$('#catalog-visits-summary').replaceChildren();$('#catalog-visits-page').textContent='';
      $('#catalog-visits-status').textContent=(error.message==='unavailable'?'Данные выбранного сайта сейчас недоступны':error.message)+'. Отсутствующие данные не заменяются нулями.';
    } finally {if(current===revision)busy=false;}
  }
  $('#catalog-visits-filters').addEventListener('submit',event=>{event.preventDefault();page=1;void load();});
  $('#catalog-visits-platform').addEventListener('change',()=>{page=1;void load();});
  $('#catalog-visits-prev').addEventListener('click',()=>{if(!busy&&page>1){page--;void load();}});
  $('#catalog-visits-next').addEventListener('click',()=>{if(!busy){page++;void load();}});
  window.CatalogVisitsDashboard = {
    refresh(report) {
      const next=report.campaign?.slug || 'all';
      if(!active && (report.platform==='max' || report.productAnalytics?.platforms?.length===1 && report.productAnalytics.platforms[0].platform==='max'))$('#catalog-visits-platform').value='max';
      if(campaign!==next){page=1;campaign=next;}
      active=true;void load();
    },
    clear(){active=false;revision++;$('#catalog-visits-list').replaceChildren();$('#catalog-visits-summary').replaceChildren();}
  };
})();
