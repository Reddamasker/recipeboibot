const $ = selector => document.querySelector(selector);
let report, busy = false, toastTimer;
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
function showLogin() { $('#dashboard').hidden = true; $('#login').hidden = false; }
function render(data) {
  report = data;
  $('#page-error').textContent = data.remoteFunnel?.error || '';
  $('#page-error').hidden = !data.remoteFunnel?.error;
  renderLandingStats(data);
  renderDirectStats(data.directStats);
  renderAttribution(data.attribution || []);
  $('#attribution').closest('section').hidden = data.platform === 'max';
  renderPriceExperiment(data.priceExperiment);
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
  $('#metrics').replaceChildren(...metrics.map(([label, value, note]) => { const card = node('article', 'metric'), title = node('p', 'metric-label'); title.append(node('span', 'stage-dot'), document.createTextNode(label)); card.append(title, node('p', `metric-number${value === null ? ' unknown' : ''}`, number(value)), node('p', 'metric-note', note)); return card; }));
  const ordered = [['Запустили бота', data.ordered.starts], ['Результат подбора', data.ordered.firstRecipe], ['Выбрали рецепт', data.ordered.selectedRecipe], ['Начали триал', data.ordered.trial], ['Оплатили', data.ordered.paid]];
  $('#funnel').replaceChildren(...ordered.map(([label, value]) => { const row = node('div', 'funnel-row'), track = node('div', 'bar-track'), bar = node('div', 'bar'); bar.style.width = `${data.ordered.starts ? value / data.ordered.starts * 100 : 0}%`; track.append(bar); row.append(node('span', 'funnel-label', label), track, node('span', 'funnel-count', number(value))); return row; }));
  $('#funnel-note').textContent = selected === 'all' ? data.directStats?.aggregate ? 'Показы и клики — по кампаниям Директа. Запуски и следующие этапы включают всех пользователей, в том числе органику. Конверсия из клика учитывает только рекламные запуски.' : 'Общий запуск включает органику. Для оценки рекламы выберите отдельное размещение.' : `Новые пользователи этого размещения.${data.returningStarts ? ` Повторных пользователей: ${number(data.returningStarts)}.` : ''}`;
  if (data.remoteFunnel?.error) $('#funnel-note').textContent += ' ' + data.remoteFunnel.error;
  if (data.platform === 'max') $('#funnel-note').textContent += ' Источник определяется по метке запуска MAX. Отдельное открытие чата неизвестно.';
  const c = data.conversions;
  const conversions = [['Показ → клик', c.clickFromImpression], [data.clickSource === 'direct' ? 'Клик → запуск' : 'Обращение → запуск', c.startFromClick], ['Запуск → подбор', c.firstRecipeFromStart], ['Подбор → выбор', c.selectionFromRecipe], ['Выбор → триал', c.trialAfterSelection], ['Триал → оплата', c.paidAfterTrial]];
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
function renderLandingStats(data) {
  const stats = data.landingStats;
  $('#landing-panel').hidden = !stats;
  if (!stats) return;
  const metrics = [['Открытия лендинга', stats.totalViews, 'Видимая страница в браузере'], [data.campaign ? 'Из этого размещения' : 'С рекламными метками', data.campaign ? stats.views : stats.taggedViews, 'По меткам страницы'], ['Переходы в Telegram', stats.telegramClicks, 'С лендинга, по выбранному фильтру'], ['Запустили бота', stats.starts, 'После перехода с лендинга']];
  $('#landing-metrics').replaceChildren(...metrics.map(([label, value, note]) => { const card = node('article', 'metric'); card.append(node('p', 'metric-label', label), node('p', 'metric-number', number(value)), node('p', 'metric-note', note)); return card; }));
  $('#landing-status').textContent = `Учёт начат ${new Date(stats.trackingSince).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })} МСК. Предыдущие открытия неизвестны. Повторное открытие страницы считается отдельно. Mini App не считается открытием лендинга.`;
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
  }
  catch (error) { if (error.status === 401) showLogin(); else if (!report) { showLogin(); $('#login-error').textContent = error.message; } else { $('#page-error').textContent = error.message; $('#page-error').hidden = false; } }
  finally { busy = false; $('#refresh').disabled = false; $('#direct-sync').disabled = !report || report.preview || report.contour !== 'main'; }
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
