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
  renderAttribution(data.attribution || []);
  $('#login').hidden = true; $('#dashboard').hidden = false;
  $('#contour').textContent = data.preview ? 'Демо данные' : data.contour === 'main' ? 'Основной бот' : 'Тестовый бот';
  $('#updated').textContent = `Обновлено ${new Date(data.generatedAt).toLocaleTimeString('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' })} МСК`;
  const selected = data.campaign?.slug || 'all', select = $('#campaign');
  select.replaceChildren(new Option('Все пользователи', 'all'), ...data.campaigns.map(c => new Option(c.name, c.slug))); select.value = selected;
  const metrics = [ ['Показы рекламы', data.impressions, 'По статистике площадки'], ['Переходы', data.clicks, 'По рекламным ссылкам'], ['Запустили бота', data.totals.starts, 'Уникальные пользователи'], ['Первый рецепт', data.totals.firstRecipe, 'Получили готовый результат'], ['Начали триал', data.totals.trial, 'Активировали 7 дней'], ['Оплатили', data.totals.paid, 'Подтверждённые оплаты'] ];
  $('#metrics').replaceChildren(...metrics.map(([label, value, note]) => { const card = node('article', 'metric'), title = node('p', 'metric-label'); title.append(node('span', 'stage-dot'), document.createTextNode(label)); card.append(title, node('p', `metric-number${value === null ? ' unknown' : ''}`, number(value)), node('p', 'metric-note', note)); return card; }));
  const ordered = [['Запустили бота', data.ordered.starts], ['Первый рецепт', data.ordered.firstRecipe], ['Начали триал', data.ordered.trial], ['Оплатили', data.ordered.paid]];
  $('#funnel').replaceChildren(...ordered.map(([label, value]) => { const row = node('div', 'funnel-row'), track = node('div', 'bar-track'), bar = node('div', 'bar'); bar.style.width = `${data.ordered.starts ? value / data.ordered.starts * 100 : 0}%`; track.append(bar); row.append(node('span', 'funnel-label', label), track, node('span', 'funnel-count', number(value))); return row; }));
  $('#funnel-note').textContent = selected === 'all' ? 'Общий запуск включает органику. Для оценки рекламы выберите отдельное размещение.' : `Новые пользователи этого размещения.${data.returningStarts ? ` Повторных пользователей: ${number(data.returningStarts)}.` : ''}`;
  const c = data.conversions;
  const conversions = [['Показ → переход', c.clickFromImpression], ['Переход → запуск', c.startFromClick], ['Запуск → рецепт', c.firstRecipeFromStart], ['Рецепт → триал', c.trialAfterRecipe], ['Триал → оплата', c.paidAfterTrial]];
  $('#conversions').replaceChildren(...conversions.map(([label, value]) => { const row = node('div', 'conversion'); row.append(node('span', 'conversion-label', label), node('span', `conversion-value${value === null ? ' empty' : ''}`, percent(value))); return row; }));
  $('#placement-count').textContent = `${data.campaigns.length} размещений`;
  $('#empty-placements').hidden = Boolean(data.campaigns.length); $('#placements').closest('.table-scroll').hidden = !data.campaigns.length;
  $('#placements').replaceChildren(...data.campaigns.map(campaign => { const row = node('tr'), title = node('td', '', campaign.name); title.append(node('small', '', campaign.slug)); const actions = node('td');
    for (const [label, action] of [['Открыть воронку', () => load(campaign.slug)], ['Скопировать ссылку', () => copyLink(campaign.slug)], ['Внести статистику', () => editStats(campaign)]]) { const button = node('button', 'secondary', label); button.addEventListener('click', action); actions.append(button); }
    row.append(title, node('td', '', number(campaign.impressions)), node('td', '', number(campaign.reach)), actions); return row;
  }));
  $('#tracking-note').textContent = `Учёт рекламных переходов начат ${new Date(data.trackingSince).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' })}. Старые клики не восстановлены.${data.historicalStartsWithoutDate ? ` Старых запусков без точной даты: ${number(data.historicalStartsWithoutDate)}.` : ''}`;
  $('#payment-note').textContent = data.testPaidUsers || data.unclassifiedPaidUsers ? `Не включены в оплаты: тестовые пользователи — ${data.testPaidUsers}; старые платежи без подтверждённого режима — ${data.unclassifiedPaidUsers}.` : '';
}
function renderAttribution(groups) {
  $('#empty-attribution').hidden = Boolean(groups.length);
  $('#attribution').closest('.table-scroll').hidden = !groups.length;
  $('#attribution').replaceChildren(...groups.map(group => {
    const row = node('tr'), campaign = node('td', '', group.campaign || 'Без UTM-кампании');
    campaign.append(node('small', '', [group.placement, group.source, group.medium].filter(Boolean).join(' / ')));
    row.append(campaign, node('td', '', group.ad || 'Без метки'), node('td', '', group.keyword || 'Без метки'), ...['clicks', 'starts', 'firstRecipe', 'trial', 'paid'].map(key => node('td', '', number(group[key]))));
    return row;
  }));
}
async function load(slug = $('#campaign').value || 'all') {
  if (busy) return; busy = true; $('#refresh').disabled = true; $('#page-error').hidden = true;
  try { render(await api(`funnel?campaign=${encodeURIComponent(slug)}`)); }
  catch (error) { if (error.status === 401) showLogin(); else if (!report) { showLogin(); $('#login-error').textContent = error.message; } else { $('#page-error').textContent = error.message; $('#page-error').hidden = false; } }
  finally { busy = false; $('#refresh').disabled = false; }
}
async function copyLink(slug) {
  const link = new URL(`/go/${slug}`, location.origin).href;
  try { await navigator.clipboard.writeText(link); toast('Рекламная ссылка скопирована'); }
  catch { toast(link); }
}
function addCampaign() { $('#campaign-form').reset(); $('#campaign-form .error').textContent = ''; $('#campaign-dialog').showModal(); }
function editStats(campaign) { const form = $('#stats-form'); form.elements.slug.value = campaign.slug; form.elements.impressions.value = campaign.impressions ?? ''; form.elements.reach.value = campaign.reach ?? ''; $('#stats-name').textContent = campaign.name; form.querySelector('.error').textContent = ''; $('#stats-dialog').showModal(); }
$('#login-form').addEventListener('submit', async event => { event.preventDefault(); const button = event.currentTarget.querySelector('button'); button.disabled = true; $('#login-error').textContent = ''; try { await api('login', 'POST', { password: $('#password').value }); $('#password').value = ''; await load(); } catch (error) { $('#login-error').textContent = error.message; } finally { button.disabled = false; } });
$('#logout').addEventListener('click', async () => { try { await api('logout', 'POST', {}); showLogin(); } catch (error) { toast(error.message); } });
$('#campaign').addEventListener('change', () => load()); $('#refresh').addEventListener('click', () => load());
$('#add-campaign').addEventListener('click', addCampaign); $('#empty-add').addEventListener('click', addCampaign);
document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
for (const [selector, endpoint, method, body] of [ ['#campaign-form', 'campaigns', 'POST', form => ({ slug: form.elements.slug.value.trim(), name: form.elements.name.value.trim() })], ['#stats-form', 'stats', 'PUT', form => ({ slug: form.elements.slug.value, impressions: Number(form.elements.impressions.value), reach: form.elements.reach.value === '' ? null : Number(form.elements.reach.value) })] ]) {
  $(selector).addEventListener('submit', async event => { event.preventDefault(); const form = event.currentTarget, button = form.querySelector('button[type="submit"]'); button.disabled = true; form.querySelector('.error').textContent = ''; try { const input = body(form), result = await api(endpoint, method, input); form.closest('dialog').close(); await load(input.slug); toast(endpoint === 'campaigns' ? 'Ссылка создана — скопируйте её в таблице размещений' : 'Статистика сохранена'); } catch (error) { if (error.status === 401) { form.closest('dialog').close(); showLogin(); } else form.querySelector('.error').textContent = error.message; } finally { button.disabled = false; } });
}
load();
