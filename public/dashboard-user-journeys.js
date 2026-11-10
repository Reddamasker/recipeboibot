(() => {
  const $ = selector => document.querySelector(selector);
  const root = $('#user-ad-journeys');
  if (!root) return;
  const node = (tag, className, text) => { const el=document.createElement(tag);if(className)el.className=className;if(text!==undefined)el.textContent=text;return el; };
  const time = value => value ? new Date(value).toLocaleString('ru-RU',{timeZone:'Europe/Moscow',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit'}) : 'Нет данных';
  const steps = {boot:'вход в приложение',home:'главный экран',request:'запрос рецепта',onboarding:'знакомство',household:'состав семьи',time:'время готовки',exclusions:'предпочтения',taste:'вкусы',intake:'настройка подбора',confirmation:'подтверждение',notifications:'уведомления',collection:'коллекция',benefits:'возможности',trial:'пробный период',offer:'тарифы',checkout:'оплата',payment_result:'результат оплаты',recipe:'рецепт',import:'сохранение рецепта',catalog:'каталог',other:'действие в приложении'};
  const features = {collections:'коллекция',meal_plan:'меню',groceries:'покупки'};
  const actions = {'collections.create':'Создание коллекции','collections.rename':'Переименование коллекции','collections.delete':'Удаление коллекции','collections.setRecipes':'Изменение состава коллекции','collections.saveCatalog':'Сохранение рецепта из каталога','collections.updateCard':'Изменение карточки рецепта','collections.setPhoto':'Добавление фото','collections.removePhoto':'Удаление фото','collections.askRecipe':'Запрос рецепта','plan.add':'Добавление блюда в меню','plan.update':'Изменение блюда в меню','plan.delete':'Удаление блюда из меню','plan.apply':'Применение меню','groceries.addManual':'Добавление продукта','groceries.updateManual':'Изменение продукта','groceries.fromRecipe':'Покупки из рецепта','groceries.fromPlan':'Покупки из меню','groceries.setChecked':'Отметка купленного продукта','groceries.removeItem':'Удаление продукта','groceries.removeSource':'Удаление источника покупок','groceries.clearChecked':'Удаление отмеченных покупок',groceries_preview:'Просмотр списка покупок',groceries_share:'Передача списка покупок'};
  const events = {account_created:'Первое появление аккаунта',chat_started:'Запустил чат бота',screen_view:'Увидел экран',workspace_view:'Увидел раздел',workspace_action:'Действие в разделе',workspace_interaction:'Действие в приложении',workspace_saved:'Изменение сохранено сервером',step_submit:'Нажал кнопку продолжения',client_error:'Ошибка интерфейса',operation_finished:'Сервер обработал действие',chat_prompt_delivered:'Подсказка доставлена в чат',recipe_delivered:'Рецепт доставлен в чат',trial_activated:'Активировал пробный период',checkout_requested:'Запросил оплату',order_ready:'Заказ готов',provider_handoff:'Открыл платёжную страницу',request_visible:'Увидел результат подбора',request_preview_visible:'Увидел предварительный результат',request_started:'Начал подбор',plan_selected:'Выбрал тариф',checkout_clicked:'Нажал оплатить',provider_opened:'Открыл платёжную страницу',recipe_record_created:'Создана запись рецепта (сейчас готов)',recipe_saved:'Сохранение рецепта подтверждено',provider_return:'Вернулся с платёжной страницы',import_failed:'Ошибка обработки рецепта',import_ready:'Обработка рецепта завершена',import_processing:'Рецепт в обработке',payment_confirmed:'Оплата подтверждена'};
  const queryStatuses = {unknown:'Запрос неизвестен',not_available:'Яндекс не предоставил запрос',pending:'Ожидаем данные Яндекса',ready:'Запрос получен',unconfigured:'Импорт запросов не подключён',no_access:'Нет доступа к запросам Метрики',no_client_id:'Визит не связан с Метрикой',unlinked:'Рекламный визит не связан с аккаунтом',ambiguous:'Есть несколько вариантов, точный запрос не установлен',error:'Не удалось обновить запрос',not_search:'Переход не из поисковой рекламы'};
  let campaign='all',page=1,revision=0,active=false,busy=false;
  function label(step) {
    if (!step) return 'Действия пока не зафиксированы';
    const suffix=features[step.feature] || steps[step.step] || 'действие';
    let text=step.event==='step_submit' && step.step==='import'?'Нажал «Отправить рецепт боту»':step.event==='chat_prompt_delivered' && step.step==='import'?'В чат доставлена просьба прислать ссылку, фото или текст рецепта':`${events[step.event] || 'Зафиксировано действие'} · ${suffix}`;
    if(step.action || step.kind)text+=` · ${actions[step.action || step.kind] || step.action || step.kind}`;
    if(step.status>=400)text+=` · ошибка ${step.status}`;
    else if(step.event==='operation_finished' && step.status)text+=` · ответ ${step.status}`;
    if(step.outcome==='cancelled')text+=' · отменено';
    else if(step.outcome==='error')text+=' · ошибка';
    else if(step.outcome==='fail')text+=' · неуспешный возврат; оплату определяет подтверждение сервера';
    else if(step.outcome==='success')text+=' · успешно';
    else if(step.outcome==='started')text+=' · начал';
    else if(step.outcome==='visible')text+=' · показано';
    else if(step.outcome==='copied')text+=' · скопировано';
    else if(step.outcome==='handed_off')text+=' · передано устройству';
    else if(step.outcome==='manual_copy_shown')text+=' · показано для копирования';
    if(step.code)text+=` · ${step.code}`;
    if(step.durationMs!==null)text+=` · ${(step.durationMs/1000).toLocaleString('ru-RU',{maximumFractionDigits:1})} с`;
    return text;
  }
  function line(title, value) {const row=node('p','user-journey-line');row.append(node('strong','',title+': '),document.createTextNode(value));return row;}
  function card(user) {
    const el=node('article','user-journey-card'), heading=node('div','user-journey-heading'),title=node('h3','',user.displayName || 'Без имени');
    heading.append(title,node('span','badge neutral',user.platform==='max'?'MAX':'Telegram'));el.append(heading);
    el.append(node('p','panel-note',`${user.username?'@'+user.username+' · ':''}${user.accountId} · Первый вход ${time(user.createdAt)}`));
    const source=user.campaignName || user.campaign || 'Источник не установлен';
    el.append(line('Источник',source));
    if(user.ad.title)el.append(line(user.ad.kind==='responsive'?'Варианты заголовка объявления':'Заголовок объявления',user.ad.title));
    else el.append(line('Объявление',user.ad.id?`№ ${user.ad.id}; текст пока недоступен`:'Нет привязанного объявления'));
    if(user.ad.text)el.append(line('Текст объявления',user.ad.text));
    if(user.ad.title && user.ad.id)el.append(node('p','panel-note',`Объявление № ${user.ad.id}${user.ad.creativeStatus==='current'?' · Текст из текущей версии объявления; точный вариант при показе неизвестен.':''}`));
    el.append(line('Что искал',user.search.query || queryStatuses[user.search.status] || 'Запрос недоступен'));
    if(user.search.keyword)el.append(line('Условие показа',user.search.keyword+' (рекламная ключевая фраза, не запрос человека)'));
    el.append(line('Последний наблюдаемый шаг',label(user.lastStep)),node('p','panel-note',time(user.lastStep?.at)));
    if(user.lastError)el.append(line('Последняя зафиксированная ошибка',`${label(user.lastError)} · ${time(user.lastError.at)}${user.lastStep && user.lastError.at<user.lastStep.at?' · После неё есть более поздние действия; она не обязательно причина остановки.':''}`));
    const outcomes=user.outcomes;
    el.append(line('Результат',`Сейчас сохранено рецептов: ${outcomes.savedRecipes}; попыток импорта: ${outcomes.imports}; неудачных: ${outcomes.failedImports}. Пробный период: ${outcomes.trialAt?time(outcomes.trialAt):'не активирован'}. Оплата: ${outcomes.paidAt?time(outcomes.paidAt):'не подтверждена'}.`));
    const detail=node('details','user-journey-timeline'),summary=node('summary','',`Хронология · последние ${user.timeline.length} записей`),list=node('ol');
    for(const step of [...user.timeline].reverse()){const item=node('li');item.append(node('time','',time(step.at)),node('span','',label(step)));list.append(item);}
    detail.append(summary,list);el.append(detail);return el;
  }
  async function load() {
    if(!active)return;
    const current=++revision;busy=true;
    $('#user-journeys-status').textContent='Загружаем историю пользователей…';
    $('#user-journeys-prev').disabled=true;$('#user-journeys-next').disabled=true;
    const filters=new URLSearchParams({campaign,platform:$('#user-journeys-platform').value,from:$('#user-journeys-from').value,to:$('#user-journeys-to').value,q:$('#user-journeys-query').value,page:String(page)});
    try {
      const response=await fetch('/api/dashboard/user-ad-journeys?'+filters,{credentials:'same-origin',headers:{'x-funnel-request':'1'}});
      const data=await response.json();if(current!==revision||!active)return;
      if(!response.ok)throw new Error(data.error || 'Не удалось получить историю');
      if(data.status!=='ready'){$('#user-journeys-rows').replaceChildren();$('#user-journeys-status').textContent=data.error || 'Данные платформы недоступны';$('#user-journeys-page').textContent='';return;}
      $('#user-journeys-rows').replaceChildren(...data.users.map(card));
      const extra=data.enrichment?.queriesStatus;
      $('#user-journeys-status').textContent=`Найдено аккаунтов: ${data.total}. Новая связка собирается с ${time(data.trackingSince)}. Существующие действия показаны из сохранённой истории.${extra && extra!=='ready'?' Запросы: '+(queryStatuses[extra]||extra)+'.':''}`;
      if(!data.users.length)$('#user-journeys-rows').append(node('p','panel-note','По выбранным условиям пользователей нет.'));
      $('#user-journeys-page').textContent=`Страница ${page} из ${Math.max(1,data.pages)}`;
      $('#user-journeys-prev').disabled=page<=1;$('#user-journeys-next').disabled=page>=data.pages;
    } catch(error) {if(current===revision&&active){$('#user-journeys-rows').replaceChildren();$('#user-journeys-status').textContent=error.message;$('#user-journeys-page').textContent='';}}
    finally {if(current===revision)busy=false;}
  }
  $('#user-journeys-filters').addEventListener('submit',event=>{event.preventDefault();page=1;void load();});
  $('#user-journeys-platform').addEventListener('change',()=>{page=1;void load();});
  $('#user-journeys-prev').addEventListener('click',()=>{if(!busy&&page>1){page--;void load();}});
  $('#user-journeys-next').addEventListener('click',()=>{if(!busy){page++;void load();}});
  window.UserAdJourneysDashboard={refresh(report){const next=report.campaign?.slug || 'all';if(next!==campaign){campaign=next;page=1;}if(!active)$('#user-journeys-platform').value=report.platform==='max'?'max':'telegram';active=true;void load();},clear(){revision++;active=false;busy=false;$('#user-journeys-rows').replaceChildren();$('#user-journeys-status').textContent='';}};
})();
