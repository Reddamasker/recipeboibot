const $ = selector => document.querySelector(selector);
let report, busy = false, toastTimer, webLoginDiagnosticsRevision = 0;
const number = value => value === null ? 'Нет данных' : Number(value).toLocaleString('ru-RU');
const percent = value => value === null ? 'Нет данных' : `${value.toLocaleString('ru-RU')}%`;
function node(tag, className, text) { const element = document.createElement(tag); if (className) element.className = className; if (text !== undefined) element.textContent = text; return element; }
async function api(path, method = 'GET', body) {
  const response = await fetch(`/api/dashboard/${path}`, { method, credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-funnel-request': '1' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json();
  if (!response.ok) { const error = new Error(data.error || 'Не удалось загрузить данные'); error.status = response.status; throw error; }
  return data;
}
function toast(text) { clearTimeout(toastTimer); $('#toast').textContent = text; $('#toast').hidden = false; toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 3500); }
function showLogin() { webLoginDiagnosticsRevision++; window.UserAdJourneysDashboard?.clear(); window.CatalogVisitsDashboard?.clear(); window.LandingHeatmapDashboard?.clear(); $('#web-login-diagnostics').hidden = true; $('#dashboard').hidden = true; $('#login').hidden = false; }
function render(data) {
  report = data;
  window.UserAdJourneysDashboard?.refresh(data);
  window.CatalogVisitsDashboard?.refresh(data);
  window.LandingHeatmapDashboard?.refresh(data);
  renderProductAnalytics(data);
  $('#page-error').textContent = data.remoteFunnel?.error || '';
  $('#page-error').hidden = !data.remoteFunnel?.error;
  renderLandingStats(data);
  renderDirectStats(data.directStats);
  renderAttribution(data.attribution || []);
  $('#attribution').closest('section').hidden = data.platform === 'max';
  renderPriceExperiment(data.priceExperiment);
  renderRecipeActivity(data);
  $('#login').hidden = true; $('#dashboard').hidden = false;
  $('#contour').textContent = data.preview ? 'Демо данные' : data.platform === 'max' ? 'MAX-бот' : data.platform === 'combined' ? 'Telegram и MAX' : data.contour === 'main' ? 'Основной бот' : 'Тестовый бот';
  const time = value => new Date(value).toLocaleTimeString('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' });
  $('#updated').textContent = `Бот: ${time(data.generatedAt)} МСК${data.directStats ? ` · Директ: ${data.directStats.syncedAt ? `${time(data.directStats.syncedAt)} МСК` : 'ожидаем данные'}` : ''}`;
  if (data.remoteFunnel) $('#updated').textContent += data.remoteFunnel.generatedAt ? ` · MAX: ${time(data.remoteFunnel.generatedAt)} МСК` : ' · MAX: недоступен';
  const selected = data.campaign?.slug || 'all', select = $('#campaign');
  select.replaceChildren(new Option('Все пользователи', 'all'), ...data.campaigns.map(c => new Option(c.name, c.slug))); select.value = selected;
  const coverage = data.advertisingCoverage;
  const advertisingNote = data.directStats?.aggregate
    ? coverage.includedCampaignCount < coverage.campaignCount ? `Есть данные по ${coverage.includedCampaignCount} из ${coverage.campaignCount} кампаний Директа` : `По всем кампаниям Директа: ${coverage.campaignCount}`
    : data.clickSource === 'direct' ? 'По статистике Директа' : 'По статистике площадки';
  const metrics = [ ['Показы рекламы', data.impressions, advertisingNote], [data.clickSource === 'direct' ? 'Клики рекламы' : 'Обращения к ссылке', data.clicks, data.clickSource === 'direct' ? advertisingNote : 'Включая повторные открытия'], ['Запустили бота', data.totals.starts, data.platform === 'combined' ? data.remoteFunnel?.status === 'error' ? 'Учтён только Telegram' : 'Аккаунты Telegram и MAX' : 'Уникальные пользователи'], ['Результат подбора', data.totals.firstRecipe, 'Рецепт или предложенные варианты'], ['Выбрали рецепт', data.totals.selectedRecipe, 'Выбрали блюдо из предложенных'], ['Начали триал', data.totals.trial, 'Активировали 7 дней'], ['Оплатили', data.totals.paid, 'Подтверждённые оплаты'] ];
  if(data.campaignPlatformOutcomes)for(const metric of metrics.slice(2))metric[0]='Telegram: '+metric[0];
  $('#metrics').replaceChildren(...metrics.map(([label, value, note]) => { const card = node('article', 'metric'), title = node('p', 'metric-label'); title.append(node('span', 'stage-dot'), document.createTextNode(label)); card.append(title, node('p', `metric-number${value === null ? ' unknown' : ''}`, number(value)), node('p', 'metric-note', note)); return card; }));
  const ordered = [['Запустили бота', data.ordered.starts], ['Результат подбора', data.ordered.firstRecipe], ['Начали триал', data.ordered.trial], ['Оплатили', data.ordered.paid]];
  $('#funnel').replaceChildren(...ordered.map(([label, value]) => { const row = node('div', 'funnel-row'), track = node('div', 'bar-track'), bar = node('div', 'bar'); bar.style.width = `${data.ordered.starts ? value / data.ordered.starts * 100 : 0}%`; track.append(bar); row.append(node('span', 'funnel-label', label), track, node('span', 'funnel-count', number(value))); return row; }));
  $('#funnel-note').textContent = selected === 'all' ? data.directStats?.aggregate ? 'Показы и клики — по кампаниям Директа. Запуски и следующие этапы включают всех пользователей, в том числе органику. Конверсия из клика учитывает только рекламные запуски.' : 'Общий запуск включает органику. Для оценки рекламы выберите отдельное размещение.' : `Новые пользователи этого размещения.${data.returningStarts ? ` Повторных пользователей: ${number(data.returningStarts)}.` : ''}`;
  if (data.remoteFunnel?.error) $('#funnel-note').textContent += ' ' + data.remoteFunnel.error;
  if (data.platform === 'max') $('#funnel-note').textContent += ' Источник определяется по метке запуска MAX. Отдельное открытие чата неизвестно.';
  if(data.campaignPlatformOutcomes)$('#funnel-note').textContent+=' Карточки, основная воронка и её конверсии относятся к Telegram. Trial и оплаты обоих ботов показаны отдельно в разделе «Результаты размещения по платформам». Клики между платформами не складываются.';
  const c = data.conversions;
  const conversions = [['Показ → клик', c.clickFromImpression], [data.clickSource === 'direct' ? 'Клик → запуск' : 'Обращение → запуск', c.startFromClick], ['Запуск → подбор', c.firstRecipeFromStart], ['Подбор → триал', c.trialAfterRecipe], ['Триал → оплата', c.paidAfterTrial], ['Подбор → выбор блюда', c.selectionFromRecipe]];
  if(data.campaignPlatformOutcomes)for(const conversion of conversions.slice(1))conversion[0]='Telegram: '+conversion[0];
  $('#conversions').replaceChildren(...conversions.map(([label, value]) => { const row = node('div', 'conversion'); row.append(node('span', 'conversion-label', label), node('span', `conversion-value${value === null ? ' empty' : ''}`, percent(value))); return row; }));
  $('#placement-count').textContent = `${data.campaigns.length} размещений`;
  $('#empty-placements').hidden = Boolean(data.campaigns.length); $('#placements').closest('.table-scroll').hidden = !data.campaigns.length;
  $('#placements').replaceChildren(...data.campaigns.map(campaign => { const row = node('tr'), title = node('td', '', campaign.name); title.append(node('small', '', campaign.slug)); const actions = node('td');
    const choices = [['Открыть воронку', () => load(campaign.slug)], ['Скопировать ссылку', () => copyLink(campaign.slug)]];
    if (campaign.statsSource !== 'direct') choices.push(['Внести статистику', () => editStats(campaign)]);
    for (const [label, action] of choices) { const button = node('button', 'secondary', label); button.addEventListener('click', action); actions.append(button); }
    row.append(title, node('td', '', number(campaign.impressions)), node('td', '', number(campaign.reach)), actions); return row;
  }));
  $('#tracking-note').textContent = `Учёт рекламных переходов начат ${new Date(data.trackingSince).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' })}. Старые клики не восстановлены.${data.historicalStartsWithoutDate ? ` Старых запусков без точной даты: ${number(data.historicalStartsWithoutDate)}.` : ''}`;
  $('#payment-note').textContent = data.testPaidUsers || data.unclassifiedPaidUsers ? `Не включены в оплаты: тестовые пользователи — ${data.testPaidUsers}; старые платежи без подтверждённого режима — ${data.unclassifiedPaidUsers}.` : '';
  const url = new URL(location.href); url.searchParams.set('campaign', selected); history.replaceState(null, '', url);
}
function renderRecipeActivity(data) {
  const a = data.recipeActivity || {};
  const metrics = [
    ['Вернулись за рецептом', a.returnedAnyRecipeUsers, `Без двойного счёта: ${percent(a.anyReturnRate ?? null)} от ${number(a.engagedRecipeUsers ?? null)} аккаунтов с результатом или открытием`, true],
    ['За новым результатом', a.returnedRecipeUsers, `В другой день: ${percent(a.returnRate ?? null)} получивших результат`],
    ['К прежнему рецепту', a.rereadRecipeUsers, 'Открыли в другой день ранее открытый, доставленный целиком или сохранённый рецепт'],
    ['Открыли полный рецепт', a.fullRecipeUsers, `Аккаунты; открытий: ${number(a.fullRecipeOpens ?? null)}`],
    ['Получили результат', a.recipeUsers, 'Аккаунты; отдельный запрос или открытая подборка'],
    ['Подготовлено рецептов', a.preparedRecipes, 'Варианты подбора и отдельные запросы'],
    ['Повторный подбор', a.repeatRecipeUsers, 'Два и более, включая тот же день'],
    ['Добавлено в коллекцию', a.savedRecipes, `Добавили пользователи: ${number(a.savedRecipeUsers ?? null)}`],
    ['Старые напоминания настраивали', a.notificationUsers, `Рассылка отключена. Сохранённых включённых расписаний: ${number(a.notificationsEnabledUsers ?? null)}`]
  ];
  $('#recipe-activity').replaceChildren(...metrics.map(([label, value, note, key]) => {
    const card = node('article', `metric${key ? ' key-metric' : ''}`);
    card.append(node('p', 'metric-label', label), node('p', `metric-number${value == null ? ' unknown' : ''}`, number(value ?? null)), node('p', 'metric-note', note));
    return card;
  }));
  const since = value => value ? new Date(value).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }) + ' МСК' : 'нет данных';
  $('#activity-note').textContent = 'Возврат — новый результат или открытие прежнего рецепта в другой календарный день по Москве. Общий итог объединяет аккаунты внутри платформы. Все числа за всё время с выбранным источником; это не D1/D7 retention и не факт приготовления.'
    + (data.platform === 'combined' ? data.remoteFunnel?.status === 'error' ? ' Сейчас учтён только Telegram.' : ' Учтены аккаунты Telegram и MAX.' : '')
    + ` Начало учёта открытий: ${since(a.trackingSince)}.${a.trackingSinceMax ? ` MAX: ${since(a.trackingSinceMax)}.` : ''}`
    + ' Старые открытия неизвестны; первый наблюдаемый просмотр сохранённого в прошлый день рецепта уже подтверждает возвращение к нему. Часть старых запросов очищена. Сумма платформ — аккаунты, без сопоставления людей.';
  const j = data.trialJourney || {};
  $('#trial-journey').replaceChildren(...[
    ['Увидели предложение', j.offered], ['Затем нажали начать', j.clicked],
    ['Затем активировали триал', j.activated], ['Затем открыли рецепт', j.opened],
    ['Нажали начать, все пути', j.clickUsers], ['Активировали, все пути', j.activationUsers],
    ['Оплатили без триала', j.paidWithoutTrialUsers]
  ].map(([label, value]) => {
    const card = node('article', 'metric');
    card.append(node('p', 'metric-label', label), node('p', 'metric-number', number(value ?? null)), node('p', 'metric-note', 'Аккаунты'));
    return card;
  }));
}
function renderLandingStats(data) {
  const stats = data.landingStats;
  $('#landing-panel').hidden = !stats;
  if (!stats) return;
  const metrics = [['Открытия лендинга', stats.totalViews, 'Видимая страница в браузере'], [data.campaign ? 'Из этого размещения' : 'С рекламными метками', data.campaign ? stats.views : stats.taggedViews, 'По меткам страницы'], ['Переходы в Telegram', stats.telegramClicks, 'С лендинга, по выбранному фильтру'], ['Переходы в MAX', stats.maxClicks ?? null, 'Нажатия, не старты. Подтверждённые старты, trial и оплаты — в результатах размещения по платформам. Привязка новых переходов с ' + (stats.maxAttributionSince ? new Date(stats.maxAttributionSince).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }) + ' МСК' : 'недоступной даты')], ['Запустили Telegram-бота', stats.starts, 'Подтверждённый новый запуск после перехода']];
  for (const item of stats.startOutcomes || []) {
    const label=item.platform==='max'?'MAX':'Telegram';
    const since=item.trackingSince ? new Date(item.trackingSince).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'})+' МСК' : 'нет данных';
    const platformMetrics = [
      [`${label}: к новым пользователям`,item.newUsers,'Переходы с первым запуском чата. Считаются метки, а не аккаунты.'],
      [`${label}: к прежним пользователям`,item.existingUsers,'Переходы только с повторными запусками; первый рекламный источник аккаунта сохранён.'],
      [`${label}: без запуска`,item.withoutStart,`Пока нет подтверждения. Полный учёт с ${since}. Из них моложе суток: ${number(item.pending24h)}. Это не доказанный отказ.`],
      [`${label}: старая история без подтверждения`,item.historicalUnknown,'Переходы до полного учёта повторов. Причина неизвестна.'],
      [`${label}: все запуски по меткам лендинга`,item.launches,`Включая повторные, с ${since}. Повторная доставка того же события не увеличивает счётчик.`],
      [`${label}: исключения и неполные данные`,item.status==='ready'?item.excludedInternal+item.missingToken:null,`Внутренние проверки: ${number(item.excludedInternal)}. Без метки: ${number(item.missingToken)}. Метки с новым и повторным запуском: ${number(item.bothKinds)} — включены в новые.`]
    ];
    metrics.push(...platformMetrics.map(([title,value,note])=>[title,value,item.status==='ready'?note:'Подтверждения запусков сейчас недоступны. Отсутствие данных не означает ноль запусков.']));
  }
  $('#landing-metrics').replaceChildren(...metrics.map(([label, value, note]) => { const card = node('article', 'metric'); card.append(node('p', 'metric-label', label), node('p', 'metric-number', number(value)), node('p', 'metric-note', note)); return card; }));
  $('#landing-status').textContent = `Учёт начат ${new Date(stats.trackingSince).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })} МСК. Предыдущие открытия неизвестны. Повторное открытие страницы считается отдельно. Mini App не считается открытием лендинга.`;
  if (stats.maxTrackingSince) $('#landing-status').textContent += ` Переходы в MAX считаются с ${new Date(stats.maxTrackingSince).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })} МСК, прежние переходы неизвестны. Одно посещение может перейти в обе платформы; их счётчики не складываются в уникальных посетителей.`;
  $('#landing-html-loads').textContent = `Серверных загрузок HTML: ${number(stats.htmlLoads)}. Они могут включать Mini App и не подтверждают просмотр лендинга. Просмотр засчитывается, когда видимая страница отправила событие из браузера; при выключенном JavaScript событие не поступит. Известные проверки ссылок исключены.`;
}
function renderDirectStats(stats) {
  $('#direct-panel').hidden = !stats;
  if (!stats) return;
  $('#direct-panel h2').textContent = stats.aggregate ? 'Яндекс Директ — общий итог' : 'Яндекс Директ';
  const money = value => value === null ? 'Нет данных' : `${Number(value).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₽`;
  $('#direct-values').textContent = `Показы: ${number(stats.impressions)} · Клики в Директе: ${number(stats.clicks)} · Расход с НДС: ${money(stats.costRub)} · Средний клик с НДС: ${money(stats.cpcRub)}`;
  const updated = stats.syncedAt ? `${stats.aggregate ? 'Данные всех учтённых кампаний не старше' : 'Последний импорт'}: ${new Date(stats.syncedAt).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })} МСК.` : 'Первый импорт ещё не завершён.';
  $('#direct-status').textContent = `${updated} ${stats.status === 'error' ? stats.error : stats.status === 'waiting' ? 'Отчёт готовится.' : 'Автоматическое обновление каждые 5 минут.'} Статистика площадки может поступать с задержкой. Уникальный охват на поиске недоступен.`;
  if (stats.aggregate) $('#direct-status').textContent += ` Учтено кампаний: ${stats.includedCampaignCount} из ${stats.campaignCount}.`;
  $('#link-requests').textContent = report.platform === 'max'
    ? 'Прямая ссылка в MAX: обращения к промежуточной странице не собираются. Клики берутся из Директа, запуск — из события MAX.' : `Обращения к рекламной ссылке: ${number(report.linkRequests)}. Включают повторные открытия и проверки ссылки; это не число оплаченных кликов.`;
  $('#direct-sync').disabled = report.preview || report.contour !== 'main';
}
$('#direct-sync').addEventListener('click', () => load(undefined, { sync: true }));
function renderPriceExperiment(experiment) {
  $('#price-experiment').hidden = !experiment;
  if (!experiment) return;
  const money = value => value === null ? 'Нет данных' : `${Number(value).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₽`;
  $('#price-variants').replaceChildren(...experiment.rows.map(variant => {
    const row = node('tr'), title = node('td', '', `${variant.variant} · ${variant.variant === 'B' ? 'Код выдан' : 'Код не выдан'}`);
    title.append(node('small', '', variant.variant === 'B' ? experiment.promoCode : 'Ввод кода разрешён'));
    const matured = node('td', '', percent(variant.maturedPaidFromTrial));
    matured.append(node('small', '', `${number(variant.maturedPaid)} из ${number(variant.maturedTrials)}`));
    row.append(title, ...['starts', 'firstRecipe', 'trial', 'exposed', 'paid', 'monthlyPaid', 'threeMonthsPaid', 'promoPaid'].map(key => node('td', '', number(variant[key]))), node('td', '', money(variant.revenueRub)), node('td', '', money(variant.revenuePerUserRub)), matured);
    return row;
  }));
}
function renderAttribution(groups) {
  $('#empty-attribution').hidden = Boolean(groups.length);
  $('#attribution').closest('.table-scroll').hidden = !groups.length;
  $('#attribution').replaceChildren(...groups.map(group => {
    const row = node('tr'), campaign = node('td', '', group.campaign || 'Без UTM-кампании');
    campaign.append(node('small', '', [group.placement, group.source, group.medium].filter(Boolean).join(' / ')));
    row.append(campaign, node('td', '', group.ad || 'Без метки'), node('td', '', group.keyword || 'Без метки'), ...['clicks', 'starts', 'firstRecipe', 'selectedRecipe', 'trial', 'paid'].map(key => node('td', '', number(group[key]))));
    return row;
  }));
}
async function load(slug, { sync = false } = {}) {
  if (busy) return; busy = true; $('#refresh').disabled = true; $('#page-error').hidden = true;
  $('#direct-sync').disabled = true;
  try {
    const requested = new URL(location.href).searchParams.get('campaign');
    const initial = !report && slug === undefined && !requested;
    slug ??= $('#campaign').value || requested || 'all';
    if (sync && report?.directStats && !report.preview && report.contour === 'main') {
      try { await api('direct-sync', 'POST', { campaign: slug }); } catch (error) { if (error.status === 401) throw error; toast(error.message); }
    }
    let data = await api(`funnel?campaign=${encodeURIComponent(slug)}`);
    if (initial && data.defaultCampaign) data = await api(`funnel?campaign=${encodeURIComponent(data.defaultCampaign)}`);
    render(data);
    void loadWebLoginDiagnostics();
  }
  catch (error) { if (error.status === 401) showLogin(); else if (!report) { showLogin(); $('#login-error').textContent = error.message; } else { $('#page-error').textContent = error.message; $('#page-error').hidden = false; } }
  finally { busy = false; $('#refresh').disabled = false; $('#direct-sync').disabled = !report || report.preview || report.contour !== 'main'; }
}
async function loadWebLoginDiagnostics() {
  const revision=++webLoginDiagnosticsRevision,panel=$('#web-login-diagnostics'),content=$('#web-login-diagnostics-content'),status=$('#web-login-diagnostics-status');
  try {
    const data=await api('web-login-prototype');
    if(revision!==webLoginDiagnosticsRevision)return;
    if(data===null){panel.hidden=true;content.replaceChildren();status.textContent='';return;}
    if(!data||data.internalOnly!==true||data.platform!=='max'||!data.counts||!Array.isArray(data.client)||!data.timing||!Number.isFinite(Date.parse(data.trackingSince)))throw Error('Invalid prototype report');
    panel.hidden=false;content.replaceChildren();
    status.textContent='Отдельная диагностика технического стенда за последние '+number(data.windowDays)+' дней. Сбор с '+new Date(data.trackingSince).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'})+' МСК. В основную воронку не входит; фильтр рекламного размещения не применяется.';
    const known=value=>Number.isSafeInteger(value)&&value>=0?value:null;
    const events=event=>data.client.filter(row=>row.event===event).reduce((total,row)=>total+row.count,0);
    const seconds=value=>value===null||!Number.isFinite(value)?'Нет данных':(value/1000).toLocaleString('ru-RU',{maximumFractionDigits:1})+' с';
    function table(headers,rows){const wrap=node('div','table-scroll'),table=node('table'),head=node('thead'),headRow=node('tr'),body=node('tbody');headers.forEach(label=>headRow.append(node('th','',label)));head.append(headRow);table.append(head);for(const values of rows){const row=node('tr');values.forEach(value=>row.append(node('td','',value)));body.append(row);}table.append(body);wrap.append(table);content.append(wrap);}
    table(['Наблюдение','Количество'],[
      ['Видимые экраны',events('screen_view')],['Нажатия «Войти»',events('login_clicked')],['Созданные запросы',known(data.created)],['Приглашения отправлены в MAX',known(data.delivered)],['Подтверждения владельца',known(data.approvedTotal)],['Входы завершены браузером',known(data.counts.consumed)],['Явные отказы',known(data.counts.denied)],['Истёкшие запросы',known(data.counts.expired)],['Отменённые запросы',known(data.counts.cancelled)],['Ошибки клиента',events('client_error')],['Сообщения о потерях очереди',events('queue_loss')]
    ].map(([label,value])=>[label,number(value)]));
    const mature=known(data.mature),completed=known(data.completedMature),rate=mature&&completed!==null?Math.round(completed/mature*1000)/10:null;
    content.append(node('p','panel-note','Завершено среди запросов с полностью закончившимся сроком наблюдения: '+number(completed)+' из '+number(mature)+' ('+percent(rate)+'). Знаменатель — запросы, у которых уже наступил исходный срок истечения, независимо от раннего успеха или отказа. Незавершённые запросы с действующим сроком сюда не входят.'));
    table(['Время между этапами','Замеры','Медиана','p95'],[['Создание → отправка','delivery'],['Отправка → решение','decision'],['Решение → завершение','completion']].map(([label,key])=>[label,number(known(data.timing[key]?.samples)),seconds(data.timing[key]?.p50),seconds(data.timing[key]?.p95)]));
    content.append(node('p','panel-note','Один запрос — одна попытка входа, не отдельный человек. Отправка в MAX не подтверждает прочтение. Подтверждения учитываются и после истечения либо отмены запроса. Время измеряется только для завершённых переходов. Ошибки клиента и сообщения о потерях — нижняя оценка; отказавший клиент может не прислать диагностику. Прототип не выдаёт доступ к рецептам, триалу или платежам.'));
  } catch(error) {
    if(revision!==webLoginDiagnosticsRevision)return;
    if(error.status===401){showLogin();return;}
    if(error.status===404){panel.hidden=true;content.replaceChildren();return;}
    panel.hidden=false;content.replaceChildren();status.textContent='Диагностика входа сейчас недоступна. Отсутствующие данные не заменены нулями.';
  }
}
async function copyLink(slug) {
  const link = report.campaigns.find(c => c.slug === slug)?.link || new URL(`/go/${slug}`, location.origin).href;
  try { await navigator.clipboard.writeText(link); toast('Рекламная ссылка скопирована'); }
  catch { toast(link); }
}
function addCampaign() { $('#campaign-form').reset(); $('#campaign-form .error').textContent = ''; $('#campaign-dialog').showModal(); }
function editStats(campaign) { const form = $('#stats-form'); form.elements.slug.value = campaign.slug; form.elements.impressions.value = campaign.impressions ?? ''; form.elements.reach.value = campaign.reach ?? ''; $('#stats-name').textContent = campaign.name; form.querySelector('.error').textContent = ''; $('#stats-dialog').showModal(); }
$('#login-form').addEventListener('submit', async event => { event.preventDefault(); const button = event.currentTarget.querySelector('button'); button.disabled = true; $('#login-error').textContent = ''; try { await api('login', 'POST', { password: $('#password').value }); $('#password').value = ''; await load(); } catch (error) { $('#login-error').textContent = error.message; } finally { button.disabled = false; } });
$('#logout').addEventListener('click', async () => { try { await api('logout', 'POST', {}); showLogin(); } catch (error) { toast(error.message); } });
$('#campaign').addEventListener('change', () => load()); $('#refresh').addEventListener('click', () => load(undefined, { sync: true }));
$('#add-campaign').addEventListener('click', addCampaign); $('#empty-add').addEventListener('click', addCampaign);
document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
for (const [selector, endpoint, method, body] of [ ['#campaign-form', 'campaigns', 'POST', form => ({ slug: form.elements.slug.value.trim(), name: form.elements.name.value.trim() })], ['#stats-form', 'stats', 'PUT', form => ({ slug: form.elements.slug.value, impressions: Number(form.elements.impressions.value), reach: form.elements.reach.value === '' ? null : Number(form.elements.reach.value) })] ]) {
  $(selector).addEventListener('submit', async event => { event.preventDefault(); const form = event.currentTarget, button = form.querySelector('button[type="submit"]'); button.disabled = true; form.querySelector('.error').textContent = ''; try { const input = body(form), result = await api(endpoint, method, input); form.closest('dialog').close(); await load(input.slug); toast(endpoint === 'campaigns' ? 'Ссылка создана — скопируйте её в таблице размещений' : 'Статистика сохранена'); } catch (error) { if (error.status === 401) { form.closest('dialog').close(); showLogin(); } else form.querySelector('.error').textContent = error.message; } finally { button.disabled = false; } });
}
load(new URL(location.href).searchParams.get('campaign') || undefined);
setInterval(() => { if (report && !document.hidden && !$('#dashboard').hidden) void load(); }, 60000);

function renderProductAnalytics(data) {
  const select = $('#product-platform'), container = $('#product-metrics');
  const platforms = data.productAnalytics?.platforms || [];
  const previous = select.value;
  select.replaceChildren(...platforms.map(p => { const option=node('option','',p.platform==='max'?'MAX':'Telegram');option.value=p.platform;return option; }));
  if(platforms.some(p=>p.platform===previous))select.value=previous;
  const draw=()=>{
    container.replaceChildren();const a=platforms.find(p=>p.platform===select.value);
    if(!a){$('#product-status').textContent='Данные этой платформы недоступны.';return;}
    $('#product-status').textContent='Новый сбор с '+new Date(a.trackingSince).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'})+' МСК. Аккаунты — по выбранному размещению. Исторические данные отмечены отдельно. '+(data.remoteFunnel?.error||'');
    const labels={boot:'Вход в приложение',home:'Главная',request:'Запрос / подбор',onboarding:'Сохранение анкеты',household:'Для кого готовим',time:'Время приготовления',exclusions:'Исключения продуктов',taste:'Вкусы: выбор и сохранение блюд',intake:'Пожелания в чате',confirmation:'Подтверждение в чате',notifications:'Напоминания',collection:'Коллекция',benefits:'Возможности',trial:'Пробный доступ',offer:'Тарифы',checkout:'Оформление оплаты',payment_result:'Возврат с оплаты',recipe:'Рецепт',import:'Импорт',other:'Прочее'};
    const seconds=n=>n===null?'Нет данных':(n/1000).toLocaleString('ru-RU',{maximumFractionDigits:1})+' с';
    function table(title, headers, rows, note, open=false) {
      const box=node('details','methodology');box.open=open;box.append(node('summary','',title));
      const scroll=node('div','table-scroll'),t=node('table'),head=node('thead'),tr=node('tr');headers.forEach(h=>tr.append(node('th','',h)));head.append(tr);t.append(head);
      const body=node('tbody');for(const row of rows){const tr=node('tr');row.forEach(v=>tr.append(node('td','',v)));body.append(tr);}t.append(body);scroll.append(t);box.append(scroll,node('p','panel-note',note));container.append(box);
    }
    if(data.campaignPlatformOutcomes) {
      const quality=data.campaignPlatformOutcomes.platforms;
      table('Результаты размещения по платформам',['Показатель','Telegram','MAX'],[
        ['Состояние',...quality.map(p=>p.status==='ready'?'Данные получены':'Недоступно')],
        ['Новые запуски',...quality.map(p=>number(p.starts))],
        ['Начали trial',...quality.map(p=>number(p.trial))],
        ['Подтверждённая оплата',...quality.map(p=>number(p.paid))],
        ['Запуск → trial',...quality.map(p=>percent(p.trialFromStart))],
        ['Запуск → оплата',...quality.map(p=>percent(p.paidFromStart))],
        ['Возвращающиеся аккаунты, отдельно',...quality.map(p=>number(p.returningStarts))]
      ],'Новые аккаунты выбранного размещения за всю доступную историю; первое размещение аккаунта не меняется. Trial и настоящая оплата подтверждены сервером после первого запуска, внутренние аккаунты и тестовые оплаты исключены. Это вся когорта источника, а не только пользователи, сохранившие рецепт с нового сайта. Одинаковый человек в Telegram и MAX считается двумя аккаунтами; строки платформ и конверсии из клика не складываются. Для сравнения качества нужны одинаковые завершённые сроки наблюдения. Ноль означает проверенное отсутствие результата; «Недоступно» — отсутствие проверенных данных MAX. Основные карточки и воронка выше показывают Telegram; селектор платформы меняет подробные продуктовые показатели ниже.',true);
      container.lastElementChild.classList.add('campaign-quality-report');
    }
    const entry=a.appEntry;
    table('Вход в приложение',['Показатель','Значение'],entry?[
      ['Попытки входа, запросов',entry.attempts],['Успешные ответы входа',entry.successes],['Успешно вошли, аккаунтов',entry.users],
      ['После входа увидели экран, аккаунтов',entry.visibleUsers],['Ошибки входа, запросов',entry.errors],['Из них до определения аккаунта',entry.unidentifiedErrors],
      ['Время ответа входа: медиана / 95% быстрее',seconds(entry.timing.p50)+' / '+seconds(entry.timing.p95)]
    ]:[],entry?'Сбор с '+new Date(entry.trackingSince).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'})+' МСК. Вход в приложение не означает запуск чата бота. Повторное открытие увеличивает запросы, но не число аккаунтов. Успешный ответ сервера не подтверждает видимый экран; учитывается отдельное событие его показа. Время измеряется до ответа сервера. При фильтре размещения показаны только подтверждённые аккаунты этого размещения; ошибки неизвестных аккаунтов доступны только без фильтра. Внутренние определённые аккаунты исключены; до определения аккаунта отделить внутреннюю попытку невозможно.':'Данные входа этой версии недоступны.',true);
    table('Шаги и ошибки',['Шаг','Видели, аккаунтов','Отправлено в чат, аккаунтов','Действовали, аккаунтов','Без действия 24 ч','Операции','Ошибки','Медиана','95% быстрее'],a.steps.map(r=>[labels[r.step],r.viewed,r.prompts,r.submitted,r.inactive,r.operations,r.errors,seconds(r.p50),seconds(r.p95)]),
      'Единый вход с сайта: приглашение — шаг «Главная», открытие приложения — «Коллекция», переход к отправке рецепта и обработка — «Импорт». Переход в чат не подтверждает отправку рецепта. Показ — видимый экран Mini App; отправка в чат не означает прочтение. Действие — отправка формы, переход шага или запрос. Строки отражают разные маршруты, не одну линейную воронку. «Без действия 24 ч» — после последнего показа минимум сутки не зарегистрировано действие или переход на другой экран; это сигнал для разбора, а не доказанный уход. Ошибки включают отказы доступа. Время операций измеряется на сервере.',true);
    const workspace=a.workspace;
    const workspaceLabels={collections:'Подборки',meal_plan:'Меню питания',groceries:'Покупки'};
    const workspaceActionLabels={
      'collections.saveCatalog':'Сохранить из каталога','collections.create':'Создать подборку','collections.rename':'Переименовать подборку','collections.delete':'Удалить подборку','collections.setRecipes':'Изменить состав подборки',
      'collections.updateCard':'Изменить личную карточку','collections.setPhoto':'Добавить личное фото','collections.removePhoto':'Убрать личное фото','collections.askRecipe':'Получить ответ о рецепте',
      'plan.add':'Добавить запись в меню','plan.update':'Изменить запись в меню','plan.delete':'Удалить запись из меню','plan.apply':'Применить план',
      'groceries.addManual':'Добавить свой продукт','groceries.updateManual':'Изменить свой продукт','groceries.fromRecipe':'Добавить покупки из рецепта','groceries.fromPlan':'Добавить покупки из меню',
      'groceries.setChecked':'Изменить отметку покупки','groceries.removeItem':'Удалить позицию','groceries.removeSource':'Убрать источник покупок','groceries.clearChecked':'Убрать отмеченное'
    };
    table('Подборки, меню и покупки',
      ['Раздел','Показы / аккаунты','Начато / аккаунты','Сохранено сервером','Видимый успех','Отмены / ошибки','Без видимого подтверждения','Медиана / p95'],
      workspace?Object.entries(workspace.features).map(([feature,r])=>[workspaceLabels[feature],r.views+' / '+r.viewers,r.started+' / '+r.actors,r.serverConfirmed,r.visibleConfirmed,r.cancelled+' / '+r.errors,r.unobserved,seconds(r.visibleTiming.p50)+' / '+seconds(r.visibleTiming.p95)]):[],
      workspace?'Сбор с '+new Date(workspace.trackingSince).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'})+' МСК. Один показ — одна видимая навигация, повторный рендер не добавляет показ. Сохранение — подтверждённая сервером команда, включая успешную команду без изменения данных; повтор того же ID не добавляет результат. Видимый успех требует начала действия, ответа сервера и фактически видимого подтверждения с одним ID. Время — от действия до такого показа; скрытые вкладки его не создают. Чтение, созданный план и отметка позиции не означают приготовление или фактическую покупку. Фильтры источника и внутренних аккаунтов сохранены; аккаунты разных платформ не складываются.':'Данные подборок, меню и покупок недоступны для этой версии платформы; это не нулевое использование.');
    container.lastElementChild.classList.add('workspace-report');
    if(workspace){
      table('Действия с подборками, меню и покупками',['Действие','Начали','Сохранено','Увидели успех','Отменили','Ошибки'],
        Object.values(workspace.features).flatMap(r=>Object.entries(r.actions).map(([action,c])=>[workspaceActionLabels[action],c.started,c.serverConfirmed,c.visibleConfirmed,c.cancelled,c.errors])),
        'Одна команда учитывается один раз для каждого исхода. После ошибки повтор может завершиться успешно, поэтому исходы не являются взаимоисключающими и не складываются в число действий. Отмена формы может произойти до отправки запроса. Тексты подборок, блюд и продуктов, даты меню и количества в отчёт не передаются.');
      table('Полнота наблюдений рабочего пространства',['Раздел','Сообщённый видимый успех','Исходы без начала / подтверждения'],
        Object.entries(workspace.features).map(([feature,r])=>[workspaceLabels[feature],r.clientSucceeded,r.unmatchedOutcomes]),
        'Сообщение клиента об успехе отдельно не подтверждает запись. Во второй колонке исходов — отмена или ошибка без наблюдаемого начала, либо успех без начала или серверной записи. Потеря телеметрии и отмена до отправки могут давать такие наблюдения; они не объявляются ошибками сохранения. Очередь не блокирует действия.');
    }
    const interactions=workspace?.interactions,preview=interactions?.kinds.groceries_preview,share=interactions?.kinds.groceries_share;
    table('Предпросмотр продуктов',['Начали','Видимые показы / с началом','Отменили','Ошибки','Исходы без начала','Замеры','Медиана / 95% быстрее'],
      preview?[[preview.started,preview.visible+' / '+preview.matchedVisible,preview.cancelled,preview.errors,preview.unmatchedOutcomes,preview.visibleTiming.samples,seconds(preview.visibleTiming.p50)+' / '+seconds(preview.visibleTiming.p95)]]:[],
      interactions?'Отдельный сбор с '+new Date(interactions.trackingSince).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'})+' МСК. Один запрос предпросмотра — один случайный ID. Время считается только при начале и реально видимом результате с тем же ID и аккаунтом; повторы исхода не добавляют замер. Скрытый список не является показом. Предпросмотр ничего не сохраняет и не входит в ожидание полного рецепта. Старые данные не восстановлены; фильтры аккаунтов и размещения сохранены.':'Эта версия платформы ещё не передаёт отдельные данные предпросмотра; отсутствие данных не означает ноль.');
    table('Поделиться покупками',['Начали','Скопировано','Передано интерфейсу отправки','Показано для ручного копирования','Отменили','Ошибки','Исходы без начала'],
      share?[[share.started,share.copied,share.handedOff,share.manualCopyShown,share.cancelled,share.errors,share.unmatchedOutcomes]]:[],
      share?'Скопировано — успешный Clipboard API и реально видимое подтверждение «Список скопирован»; скрытая вкладка не даёт подтверждения. Передано интерфейсу отправки — успешное завершение Promise системного интерфейса, без подтверждения доставки получателю. Ручное копирование — реально видимый текст, без утверждения, что он скопирован. Каждый исход учитывается один раз для аккаунта и ID; разные исходы одной попытки могут сочетаться. Нет серверного сохранения, содержимое списка и адресат не собираются.':'Отдельные данные отправки покупок недоступны для этой версии платформы.');
    table('Ошибки по шагам и версиям',['Шаг','Код','Версия','События'],(a.errors||[]).map(r=>[labels[r.step],r.code,r.version,r.count]),'Тексты сообщений и содержимое запросов не собираются. Коды относятся к операциям приложения и чата. 401/403 — вход, доступ, отключённая функция чата или отказ платформы доставить ответ; 402 — ограничение доступа. Отказ ИИ-генерации в чате учитывается как 403 шага «Запрос», без готового рецепта и AI-вызова; отдельно от других 403 не выделяется. 5xx требуют проверки журнала: исторические записи могут включать восстановленные ошибки. С 21.10.2026 отказ MAX 403 завершает текущую задачу без повторов; новые сообщения пользователя обрабатываются отдельно.');
    table('Ожидание результата',['Измерение','Замеры','Медиана','95% быстрее'],[['Запрос → подборка или полный рецепт',a.timing.visible.samples,seconds(a.timing.visible.p50),seconds(a.timing.visible.p95)],['Запрос → превью первого рецепта перед триалом',a.timing.preview.samples,seconds(a.timing.preview.p50),seconds(a.timing.preview.p95)],['Обработка сообщения → полная доставка рецепта',a.timing.delivered.samples,seconds(a.timing.delivered.p50),seconds(a.timing.delivered.p95)]],
      'Только завершённые наблюдаемые пути. Превью не является полным рецептом; доставка в чат не является просмотром. Фоновая подготовка и неоткрытые результаты не дают замер видимого результата.');
    if (a.latency) {
      const l=a.latency, metric=(label,t)=>[label,t.samples,t.within4s,percent(t.samples?t.within4s/t.samples*100:null),seconds(t.p50),seconds(t.p95)];
      const modeNames={catalog:'Готовый рецепт',generated:'Генерация',cache:'Повтор готового ответа',mixed:'Смешанная подборка',empty:'Нет подходящего результата',unknown:'Другой / прежний путь'};
      table('Цель: результат за 4 секунды',['Серверный путь','Замеры','≤4 с','Доля','Медиана','95% быстрее'],Object.entries(l.server).map(([k,t])=>metric(modeNames[k],t)),
        `Сбор с ${new Date(l.trackingSince).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'})} МСК. Начато в Mini App: ${l.started}; завершено на сервере: ${l.completed}; с ошибкой: ${l.failed}; без наблюдаемого показа: ${l.unobserved}. Время сервера не равно полному открытию; ошибки и отсутствие результата не считаются успехом. Фоновые запросы не входят в знаменатель.`);
      table('Что пользователь увидел за 4 секунды',['Видимый результат','Замеры','≤4 с','Доля','Медиана','95% быстрее'],Object.entries(l.visible).map(([k,t])=>metric({selection:'Карточки выбора',full:'Полный рецепт',preview:'Превью перед триалом'}[k],t)),
        'Доли — среди наблюдаемых показов соответствующего типа. Карточки выбора и превью не засчитываются как полный рецепт. Не включает время дальнейшего решения пользователя об активации триала.');
      table('Время этапов обработки',['Этап','Замеры','≤4 с','Доля','Медиана','95% быстрее'],Object.entries(l.stages).map(([k,t])=>metric({interpretation:'Разбор пожелания',generation:'Генерация текста',validation:'Проверка соответствия',nutrition:'Расчёт КБЖУ',catalog:'Подбор из каталога с проверкой'}[k],t)),
        'Завершённые этапы до ответа сервера, включая повторные попытки и ошибки, отдельно для выбранной платформы и источника. Проверка входит во время каталога: строки нельзя суммировать. Фоновая подготовка после ответа исключена.');
    } else table('Цель: результат за 4 секунды',['Состояние'],[['Данные этой версии недоступны']],'Отсутствие нового сбора не означает нулевое время.');
    const names={onboarding_started:'Начали знакомство',onboarding_completed:'Завершили знакомство',taste_preferences_completed:'Сохранили вкусы',taste_preferences_skipped:'Пропустили вкусы',dinner_intake_confirmed:'Подтвердили пожелания',recommendation_accepted:'Выбрали рекомендацию',recommendation_rejected:'Отклонили рекомендацию',dinner_retry:'Запросили замену',recipe_cooked:'Отметили «приготовил»'};
    table('Полезность и отказы — доступная история',['Действие','Аккаунты'],Object.entries(a.quality).map(([k,v])=>[names[k]||k,v]),'Каждый аккаунт учитывается один раз в строке. «Приготовил» — отметка пользователя. История ограничена сохранившимися событиями. «Сохранили вкусы» включает прежние списки и новый выбор блюд; это аккаунты, не число лайков.');
    const reasons={dislike:'Не понравилось',recently_ate:'Было недавно',ingredients:'Ингредиенты',time:'Время',complexity:'Сложность',other:'Другая причина'};
    table('Причины отказа — доступная история',['Причина','События'],Object.entries(a.reasons).map(([k,v])=>[reasons[k]||k,v]),'Повторные отказы учитываются отдельно. «Было недавно» — отметка пользователя, не факт приготовления; кнопка доступна с 16.10.2026, сохранённые события прежнего сценария также учитываются. Свободный текст в отчёт не попадает.');
    table('Оплата после видимого предложения',['Последовательный этап','Аккаунты'],['Увидели тарифы','Нажали оплатить','Получен настоящий заказ','Сервер выдал переход к провайдеру','Подтверждена оплата'].map((label,i)=>[label,a.checkout.ordered[i]]),
      'Этапы по времени внутри аккаунта после начала нового сбора. Выдача страницы перехода не подтверждает загрузку провайдера. Заказ может быть ранее созданным и повторно открытым. Тестовые заказы исключены. Выбор тарифа: '+a.checkout.plan_selected+' аккаунтов. Все пути за доступную историю: создали заказ '+a.checkout.orders+', оплатили '+a.checkout.paid+'. Статусы заказов: '+JSON.stringify(a.checkout.statuses)+'. Возвраты по ссылкам успеха/ошибки: '+a.checkout.returnSuccess+' / '+a.checkout.returnFail+' аккаунтов; это не подтверждение платежа или отказа банка.');
    table('Возвращение к полному рецепту: D1 и D7',['Первое наблюдаемое открытие','Аккаунты','Созрели D1','Вернулись D1','D1','Созрели D7','Вернулись D7','D7'],a.retention.map(r=>[r.date,r.users,r.d1Eligible,r.d1,percent(r.d1Rate),r.d7Eligible,r.d7,percent(r.d7Rate)]),
      'Возврат — открытие любого полного рецепта точно на следующий или седьмой московский календарный день после первого наблюдаемого открытия. Знаменатель включает только аккаунты, для которых целевой день полностью завершился. Это когорты первого наблюдаемого использования Mini App, не регистрации; старые чтения чата неизвестны. Последние 60 когорт.');
    const catalogNames={catalog_list:'Видели выдачу',catalog_search:'Поиск',catalog_empty:'Пустая выдача',catalog_filter:'Выдача с фильтрами',catalog_open:'Открыли полный рецепт',catalog_favorite_add:'Добавили в избранное',catalog_favorite_remove:'Убрали из избранного',catalog_share:'Скопировали ссылку',catalog_print:'Запросили печать'};
    const journey=a.catalogJourney;
    table('Рецепт на сайте → сохранение в боте',['Этап','Переходы'],journey?[
      ['Увидели подборку или сразу рецепт',journey.visible],['Увидели полный рецепт',journey.fullRecipe],
      ['Нажали «Сохранить в боте»',journey.saveIntent],['Выбрали Telegram или MAX',journey.platformSelected],
      ['Получили ссылку перехода',journey.handoffReady],['Подтверждён запуск бота',journey.botStarted],['Рецепт сохранён в коллекцию',journey.saved],
      ['Запуски новых / возвращающихся аккаунтов',journey.newStarts+' / '+journey.returningStarts],
      ['Видимый вход → рецепт / запуск / сохранение',percent(journey.recipeRate)+' / '+percent(journey.startRate)+' / '+percent(journey.saveRate)],
      ['Завершили 24 ч / без запуска за 24 ч',journey.eligible24h+' / '+journey.withoutStart24h],
      ['Переходы с ошибкой',journey.failed],['Серверные результаты без полной наблюдаемой цепочки',journey.unmatchedOutcomes],
      ['До рецепта: медиана / 95% быстрее',seconds(journey.entryToRecipe.p50)+' / '+seconds(journey.entryToRecipe.p95)],
      ['От выдачи ссылки до запуска: медиана / 95% быстрее',seconds(journey.handoffToStart.p50)+' / '+seconds(journey.handoffToStart.p95)],
      ['От выдачи ссылки до сохранения: медиана / 95% быстрее',seconds(journey.handoffToSaved.p50)+' / '+seconds(journey.handoffToSaved.p95)],
    ]:[],journey?'Сбор с '+new Date(journey.trackingSince).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'})+' МСК. Единица — случайный переход внутри сессии вкладки, не уникальный человек. Прямой вход в полный рецепт допускается. Считается последовательная цепочка для одной платформы; повторы не удваивают этап. Полученная ссылка не доказывает открытие мессенджера. Запуск и сохранение подтверждаются сервером; сохранение не означает прочтение. Фильтр размещения относится к метке входа на сайт. Связанные внутренние аккаунты исключены; анонимные внутренние посещения распознать нельзя. «Без запуска» не устанавливает причину ухода. Старые визиты не восстановлены. Подтверждения с другого сайта, без местного входа: запусков '+journey.targetOnlyStarts+', сохранений '+journey.targetOnlySaved+'; в эту воронку они не добавляются.':'Для этой версии или выбранного источника сквозные данные недоступны. Отсутствие данных не означает ноль.',true);
    if(journey)table('Куда сохраняют рецепт с этого сайта',['Платформа','Выбрали','Ссылка готова','Запуск','Сохранён','С ошибкой'],journey.platforms.map(r=>[r.platform==='max'?'MAX':'Telegram',r.selected,r.ready,r.started,r.saved,r.failed]),'Платформа в селекторе выше означает сайт, где начался путь; строки — выбранный бот. Подтверждения MAX возвращаются в исходный контур. Один переход с выбором обеих платформ присутствует в обеих строках; строки не суммировать. Задержки считаются только для наблюдаемых завершённых цепочек. Это диагностическая конверсия сайта, а не конверсия из рекламного клика.');
    table('Публичный каталог — отдельно от ботов',['Действие','События','Сессии браузера'],(a.catalog||[]).map(r=>[catalogNames[r.event],r.events,r.visits]),a.catalog?'Анонимные сессии вкладки, не люди и не аккаунты. Без поисковых фраз и содержимого рецептов. Избранное остаётся в браузере. Автоматические обращения отсекаются частично; анонимные внутренние посещения отличить нельзя.':'Для каталога нет привязки к аккаунту или рекламному запуску. Выберите «Все пользователи», чтобы увидеть отдельную статистику каталога.');
    const b=a.catalogBenefits;
    table('Экран преимуществ в каталоге',['Показатель','Значение'],b?[
      ['Видимые показы',b.views],['Сессии вкладки с показом',b.visits],['Показы с закрытием',b.closes],['Показы с нажатием кнопки перехода',b.ctas],['CTR: нажатия / видимые показы',percent(b.ctr)],
      ['До закрытия: медиана / 95% быстрее',seconds(b.closeTiming.p50)+' / '+seconds(b.closeTiming.p95)],
      ['До нажатия: медиана / 95% быстрее',seconds(b.ctaTiming.p50)+' / '+seconds(b.ctaTiming.p95)],['Действия без соответствующего показа',b.unmatchedActions]
    ]:[],b?'Сбор с '+new Date(b.trackingSince).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'})+' МСК, за всю доступную историю. Каждый видимый показ имеет отдельный случайный ID; повторная отправка не удваивает счётчик. Закрытие и нажатие связываются с тем же показом. Нажатие не подтверждает открытие бота, запуск, пробный доступ или оплату. При отсутствии показов CTR недоступен. Время — от видимого показа до действия, включая время в фоновой вкладке. Анонимные внутренние посещения неотличимы; рекламные фильтры и исключения аккаунтов к ним неприменимы. Действия без показа исключены из CTR и могут указывать на потерю событий.':a.catalog?'Данные экрана преимуществ недоступны для этой версии платформы.':'Показатели анонимного каталога доступны только в режиме «Все пользователи».');
    container.lastElementChild.classList.add('benefits-report');
    table('Работа сервиса — доступная история',['Показатель','Значение'],[['AI-вызовы',a.provider.calls],['Ошибки AI',a.provider.errors],['Входные токены',a.provider.input],['Выходные токены',a.provider.output],['Вызовы с полным учётом расхода',a.provider.complete],...Object.entries(a.imports).map(([k,v])=>['Импорт: '+k,v]),...Object.entries(a.notifications).map(([k,v])=>['Старое напоминание: '+k,v])],
      'Расход токенов не равен стоимости в рублях. Импорт — одна задача на источник; повторное распознавание фото увеличивает AI-вызовы, но не число импортов. Непрочитанный рецепт учитывается как failed, а не ready. Ошибки, очереди и успешные действия показаны отдельно; отправленное напоминание не считается прочитанным.');
    const photos=a.photoImports;
    table('Рецепты из фото',['Показатель','Значение'],photos?[
      ['Импорты из одного / нескольких фото',photos.single+' / '+photos.multiple],
      ['Изображений в этих импортах',photos.images],['Готово / ошибка / обработка',photos.ready+' / '+photos.failed+' / '+photos.pending],
      ['Наборы в чате: начаты / отменены',photos.drafts+' / '+photos.cancelled],
      ['Сборка: попытки / медиана / p95, мс',photos.assemblyTiming.samples+' / '+(photos.assemblyTiming.p50??'нет данных')+' / '+(photos.assemblyTiming.p95??'нет данных')]
    ]:[],photos?'Сбор с '+new Date(photos.trackingSince).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'})+' МСК. Один набор источников — одна задача, повторная отправка не создаёт импорт. Изменение состава или порядка фото — новый источник. Старые импорты без числа фото исключены. Начало и отмена набора — действия в чате, не просмотры; истечение 24 часов не считается явной отменой. Ошибки и время обработки — в шаге «Импорт», видимый результат — отдельно.':'Данные импорта нескольких фото недоступны для этой версии платформы.');
    container.lastElementChild.classList.add('photo-import-report');
    const reminders=a.trialReminders;
    const digest=a.trialDigest;
    table('История ежедневных подборок — рассылка отключена',['Показатель','Значение'],digest?[
      ['Аккаунты / расписание включено автоматически',digest.enrolled+' / '+digest.autoEnabled],
      ['Доставлено приветствий / приглашений настроить вкусы',digest.welcomeSent+' / '+digest.personalizationSent],
      ['Подборки: созданы / полностью доставлены / остановлены',digest.batches+' / '+digest.batchesSent+' / '+digest.batchesFailed],
      ['Доставлено карточек рецептов',digest.cardsSent],['Отключали подборки, аккаунтов',digest.optedOut],
      ['Сообщения: ошибка / неизвестный результат / ожидают / отменены',digest.failed+' / '+digest.unknown+' / '+digest.waiting+' / '+digest.cancelled],
      ['Задержка доставки: медиана / 95% быстрее',seconds(digest.deliveryTiming.p50)+' / '+seconds(digest.deliveryTiming.p95)]
    ]:[],digest?'Сценарий отключён 10 ноября 2026. Сохранена история; новые подборки не отправляются. Сбор с '+new Date(digest.trackingSince).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'})+' МСК. Только аккаунты, созданные после включения сценария. Одна подборка содержит до трёх отдельных карточек; звук только у первой. Доставка не означает чтение. Неопределённый сетевой результат не повторяется. Отключение — хотя бы один отказ в чате или настройках. Время — от запланированной отправки до подтверждения каждого сообщения. Действуют фильтры аккаунтов и размещения. Видимость редактора и сохранение вкусов — в прежнем шаге «Вкусы»; переход из конкретной рассылки отдельно не измеряется.':'Сценарий отключён. История на платформе не собиралась или данные её версии недоступны.');
    table('Триал: приглашение добавить свой рецепт',['Показатель','Значение'],reminders?[
      ['Аккаунты в цепочке',reminders.enrolled],['Доставлено сообщений / аккаунтов',reminders.sent+' / '+reminders.sentUsers],
      ['Сообщения с нажатием «Добавить»',reminders.clicked],['Отключили цепочку, аккаунтов',reminders.optedOut],
      ['Ошибки / неизвестный результат / отправляется',reminders.failed+' / '+reminders.unknown+' / '+reminders.waiting],
      ['Завершили 24 ч после первой доставки',reminders.eligible24h],['Добавили свой рецепт за эти 24 ч',reminders.added24h],
      ['Доля добавивших среди завершивших 24 ч',percent(reminders.rate24h)],
      ['Задержка доставки: медиана / 95% быстрее',seconds(reminders.deliveryTiming.p50)+' / '+seconds(reminders.deliveryTiming.p95)],
      ['До нажатия: медиана / 95% быстрее',seconds(reminders.clickTiming.p50)+' / '+seconds(reminders.clickTiming.p95)]
    ]:[],reminders?'Сбор с '+new Date(reminders.trackingSince).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'})+' МСК. MAX: только новые триалы с этой даты; отправка ждёт подключения чата. Через 24 часа после начала триала, затем раз в 48 часов, до трёх сообщений; после своего рецепта или отказа цепочка останавливается. Доставка не означает прочтение. Нажатие учитывается один раз на сообщение. Результат — свой рецепт, добавленный в течение 24 часов после первой подтверждённой доставки; учитываются только завершённые окна. Это последовательность действий, не доказанный эффект рассылки. Готовые рецепты каталога и сгенерированные рецепты исключены. Действуют фильтры аккаунтов и размещения.':'Данные этой версии платформы недоступны.');
    const healthRows=(h,label)=>[[label+' — ошибки клиента',h.clientErrors],[label+' — ошибки входа до определения аккаунта',h.authErrors],[label+' — приняты после повторной отправки',h.retried],[label+' — отброшено по отчётам клиентов',h.dropped],[label+' — ожидало отправки в последних отчётах',h.pending],[label+' — последнее принятое событие',h.lastEvent?new Date(h.lastEvent).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'}):'Нет событий']];
    table('Качество сбора',['Показатель','Значение'],[...healthRows(a.health,'Аккаунты'),...(a.publicHealth?healthRows(a.publicHealth,'Анонимные сессии'):[]),['Ошибки записи после запуска сервера',a.writeFailures]],
      'Очередь ограничена 80 событиями и 24 часами, повторная отправка не удваивает события. Показатели потерь — нижняя оценка: полностью закрытая вкладка или клиент без связи может не прислать диагностику. «Ожидают» — последняя известная очередь, не её текущее состояние. Версии клиента: '+(a.health.versions.join(', ')||'пока нет')+'.');
  };
  select.onchange=draw;draw();
}
