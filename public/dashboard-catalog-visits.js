(() => {
  'use strict';
  const $ = selector => document.querySelector(selector);
  const el = (tag, className = '', text = '') => { const n = document.createElement(tag); n.className = className; n.textContent = text; return n; };
  const sectionNames = { intro:'Начало страницы', products:'Продукты', cuisines:'Кухни', filters:'Фильтры', results:'Список рецептов', recipe_header:'Заголовок рецепта', ingredients:'Ингредиенты', steps:'Шаги приготовления', save_cta:'Предложение сохранить в боте', footer:'Низ страницы' };
  const actionNames = { filter_change:'Изменил фильтр', filter_reset:'Сбросил фильтры', search_submit:'Применил поиск', card_open:'Нажал карточку рецепта', back_to_list:'Вернулся к списку', pagination:'Перешёл на другую страницу списка', sort_change:'Изменил сортировку', favorite_add:'Добавил в избранное браузера', favorite_remove:'Убрал из избранного браузера', share:'Нажал копирование ссылки', print:'Нажал печать', servings_change:'Изменил число порций', results_jump:'Перешёл к результатам', more_cuisines:'Раскрыл кухни', filters_expand:'Раскрыл фильтры', save_open:'Нажал «Сохранить в боте»', platform_telegram:'Выбрал Telegram', platform_max:'Выбрал MAX', cancel_save:'Продолжил читать', open_bot:'Попытка открыть бота', retry:'Повторил загрузку' };
  const controlNames = { cuisine:'кухня', category:'тип блюда', time:'время готовки', include:'продукты', exclude:'исключения' };
  const eventNames = {catalog_list:'Список рецептов стал видимым',catalog_open:'Полный рецепт стал видимым',catalog_filter:'Список с активными фильтрами',catalog_search:'Получил результаты поиска',catalog_empty:'Пустая выдача',catalog_save_intent:'Открыл выбор бота',catalog_platform_selected:'Выбрал платформу',catalog_handoff_ready:'Ссылка в бот готова',catalog_handoff_error:'Ошибка передачи в бот',catalog_bot_started:'Бот подтвердил запуск',catalog_recipe_saved:'Рецепт сохранён в боте',catalog_save_failed:'Не удалось сохранить рецепт',catalog_share:'Ссылка скопирована',catalog_print:'Вызвана печать',catalog_favorite_add:'Рецепт добавлен в избранное браузера',catalog_favorite_remove:'Рецепт убран из избранного браузера',client_error:'Ошибка страницы'};
  const groupDefinitions = [
    ['unconfirmed','Просмотр не подтверждён','Нет события видимого списка или полного рецепта. Это не доказывает, что страница не открылась.'],
    ['brief_catalog','Увидели до 8 карточек','На одном из экранов списка попало в видимую область от 1 до 8 карточек. Нажатий и открытий рецепта нет.'],
    ['deep_catalog','Увидели больше 8 карточек','На одном из экранов списка попало в видимую область больше 8 карточек. Нажатий и открытий рецепта нет.'],
    ['active_catalog','Действовали в каталоге','Есть явное действие в каталоге, но нет открытого рецепта или пустой выдачи.'],
    ['empty_results','Получили пустую выдачу','Зафиксирован список без результатов; открытий рецепта нет.'],
    ['one_recipe','Открыли один рецепт','Одно наблюдаемое открытие полного рецепта. Чтение всех шагов не подтверждается.'],
    ['multiple_recipes','Несколько открытий рецепта','Два или больше открытий полного рецепта; это могут быть повторные открытия одного блюда.'],
    ['legacy_catalog','Каталог до подробного сбора','Старое событие видимого списка. Число показанных карточек и время неизвестны.'],
    ['unknown_catalog','Глубина просмотра неизвестна','Список стал видимым, но положительного замера числа карточек и явных действий нет.'],
    ['save_intent','Начали сохранять в боте','Есть намерение сохранить рецепт; подтверждённого запуска бота и сохранения пока нет.'],
    ['bot_started','Запустили бота','Бот подтвердил запуск, но сохранение рецепта ещё не подтверждено.'],
    ['saved','Сохранили рецепт в боте','Сервер подтвердил сохранение выбранного рецепта.']
  ];
  const groupIds = groupDefinitions.map(([id])=>id), groupViews = new Map(), groupStates = new Map();
  let revision = 0, campaign = null, active = false, busy = false, activeGroup = null, cohort = null;
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
    item.dataset.visit = `${visit.number}:${visit.startedAt}`;
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
  function state(id) {
    if(!groupStates.has(id))groupStates.set(id,{page:1,expanded:new Set()});
    return groupStates.get(id);
  }
  function rememberExpanded(id) {
    const view=groupViews.get(id);if(!view)return;
    const expanded=state(id).expanded;
    for(const card of view.list.querySelectorAll('.visit-card')){
      if(card.open)expanded.add(card.dataset.visit);else expanded.delete(card.dataset.visit);
    }
  }
  function changePage(id,delta) {
    if(busy || activeGroup!==id)return;
    rememberExpanded(id);state(id).page+=delta;void load();
  }
  function groupView(id,label,description) {
    const item=el('details','visit-group'),heading=el('summary'),title=el('div','visit-group-title');
    item.dataset.group=id;item.id='catalog-group-'+id;
    const name=el('strong','',label),count=el('span','visit-group-count'),share=el('span','visit-group-share');
    title.append(name,el('span','visit-group-description',description));
    const totals=el('div','visit-group-totals');totals.append(count,share,el('span','visit-group-expand','Показать посещения'));
    heading.append(title,totals);item.append(heading);
    const body=el('div','visit-group-body'),status=el('p','panel-note'),list=el('div','visit-list'),pager=el('div','visit-pagination');
    status.setAttribute('role','status');list.id='catalog-group-list-'+id;
    const prev=el('button','secondary','Назад'),pageLabel=el('span'),next=el('button','secondary','Далее');
    prev.type=next.type='button';prev.setAttribute('aria-label',`Предыдущая страница: ${label}`);next.setAttribute('aria-label',`Следующая страница: ${label}`);
    prev.disabled=next.disabled=true;prev.addEventListener('click',()=>changePage(id,-1));next.addEventListener('click',()=>changePage(id,1));
    pager.append(prev,pageLabel,next);pager.hidden=true;body.append(status,list,pager);item.append(body);
    const view={item,count,share,list,status,pager,prev,next,pageLabel};groupViews.set(id,view);
    item.open=activeGroup===id;
    item.addEventListener('toggle',()=>{
      if(!item.isConnected || item.open===(activeGroup===id))return;
      if(item.open){
        if(activeGroup){rememberExpanded(activeGroup);const previous=groupViews.get(activeGroup);if(previous)previous.item.open=false;}
        activeGroup=id;void load();
      }else if(activeGroup===id){rememberExpanded(id);activeGroup=null;}
    });
    return view;
  }
  function validReport(data,requested) {
    if(data.status!=='ready')throw new Error('unavailable');
    const integer=value=>Number.isSafeInteger(value)&&value>=0;
    const s=data.summary;
    if(data.version!==2 || !s || !integer(s.visits) || !Array.isArray(data.groups) || data.groups.length!==groupIds.length
      || !data.groups.every(g=>groupIds.includes(g.id)&&integer(g.count)) || new Set(data.groups.map(g=>g.id)).size!==groupIds.length
      || data.groups.reduce((sum,g)=>sum+g.count,0)!==s.visits || !Array.isArray(data.visits)
      || data.group!==requested.group || data.page!==requested.page || data.pageSize!==10)throw new Error('unavailable');
    const count=requested.group==='all'?s.visits:data.groups.find(g=>g.id===requested.group)?.count;
    if(data.totalVisits!==count || data.visits.length!==Math.min(10,Math.max(0,count-(data.page-1)*10))
      || data.visits.some(v=>!groupIds.includes(v.group) || requested.group!=='all'&&v.group!==requested.group
        || !integer(v.number) || v.number<1 || v.number>s.visits))throw new Error('unavailable');
  }
  function draw(data) {
    const s=data.summary;
    $('#catalog-visits-summary').replaceChildren(...[
      ['Посещения',number(s.visits)],['С замером времени',number(s.measuredVisits)],['Открыли рецепт',number(s.recipeVisits)],['Нажали сохранить',number(s.saveIntentVisits)],['Запуск бота',number(s.starts)],['Сохранено в боте',number(s.saved)]
    ].map(([label,value])=>metric(label,value)));
    const definitions=[...groupDefinitions,['all','Все посещения','Общий список для выбранного размещения, сайта и дат.']];
    for(const [index,[id,label,description]] of definitions.entries()){
      const count=id==='all'?s.visits:data.groups.find(g=>g.id===id).count;
      let view=groupViews.get(id);
      if(!view){view=groupView(id,label,description);$('#catalog-visits-list').append(view.item);}
      view.item.hidden=index>=8&&id!=='all'&&count===0;
      // A group that becomes empty during a refresh remains open until the owner closes it.
      if(activeGroup===id)view.item.hidden=false;
      view.count.textContent=number(count);
      view.share.textContent=s.visits ? `${(count/s.visits*100).toLocaleString('ru-RU',{maximumFractionDigits:1})}% всех посещений` : 'Доля не рассчитана';
    }
    if(activeGroup===data.group){
      const view=groupViews.get(data.group);rememberExpanded(data.group);
      view.list.replaceChildren(...data.visits.map(v=>{const card=renderVisit(v);card.open=state(data.group).expanded.has(card.dataset.visit);return card;}));
      view.status.textContent=data.visits.length?'':data.totalVisits ? 'На этой странице посещений нет. Вернитесь на предыдущую страницу.' : 'Посещений в этой группе за выбранный период нет.';
      view.list.setAttribute('aria-busy','false');
      view.pageLabel.textContent=`Страница ${data.page} из ${Math.max(1,Math.ceil(data.totalVisits/data.pageSize))}`;
      view.prev.disabled=data.page<=1;view.next.disabled=data.page*data.pageSize>=data.totalVisits;
      view.pager.hidden=data.totalVisits===0;
    }
    const since=data.trackingSince ? `${time(data.trackingSince)} МСК` : 'ещё не начат';
    $('#catalog-visits-status').textContent=`Подробный сбор: ${since}. Всего экранов: ${number(s.pageViews)}. Посещений с ошибками: ${number(s.errors)}. Время и видимость старых посещений не восстановлены.`;
  }
  function clearData() {
    if(activeGroup)rememberExpanded(activeGroup);
    groupViews.clear();$('#catalog-visits-list').replaceChildren();$('#catalog-visits-summary').replaceChildren();
  }
  async function load() {
    if(!active)return;
    const filters={campaign:campaign || 'all',platform:$('#catalog-visits-platform').value};
    for(const key of ['from','to'])if($('#catalog-visits-'+key).value)filters[key]=$('#catalog-visits-'+key).value;
    const nextCohort=JSON.stringify(filters);
    if(cohort!==nextCohort){clearData();groupStates.clear();cohort=nextCohort;}
    const current=++revision;busy=true;
    const group=activeGroup || 'all',requested={group,page:activeGroup?state(group).page:1};
    const q=new URLSearchParams({...filters,group,page:String(requested.page)});
    $('#catalog-visits-status').textContent='Загружаем посещения…';
    const view=groupViews.get(group);
    if(view){view.prev.disabled=view.next.disabled=true;view.status.textContent='Загружаем посещения…';view.list.setAttribute('aria-busy','true');}
    try {
      const response=await fetch('/api/dashboard/catalog-visits?'+q,{credentials:'same-origin',headers:{'x-funnel-request':'1'}});
      if(!response.ok)throw new Error(response.status===401?'Войдите в дашборд':response.status===400?'Проверьте выбранные даты':'Данные сейчас недоступны');
      const data=await response.json();if(current!==revision)return;validReport(data,requested);draw(data);
    } catch(error) {
      if(current!==revision)return;
      clearData();
      $('#catalog-visits-status').textContent=(error.message==='unavailable'?'Данные выбранного сайта сейчас недоступны':error.message)+'. Отсутствующие данные не заменяются нулями.';
    } finally {if(current===revision)busy=false;}
  }
  $('#catalog-visits-filters').addEventListener('submit',event=>{event.preventDefault();void load();});
  $('#catalog-visits-platform').addEventListener('change',()=>{void load();});
  window.CatalogVisitsDashboard = {
    refresh(report) {
      const next=report.campaign?.slug || 'all';
      if(!active && (report.platform==='max' || report.productAnalytics?.platforms?.length===1 && report.productAnalytics.platforms[0].platform==='max'))$('#catalog-visits-platform').value='max';
      campaign=next;
      active=true;void load();
    },
    clear(){active=false;revision++;busy=false;clearData();groupStates.clear();activeGroup=null;cohort=null;$('#catalog-visits-status').textContent='';}
  };
})();
