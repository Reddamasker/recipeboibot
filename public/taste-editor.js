import { TasteFlow } from './taste-model.js?v=1';

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const normalize = value => String(value).toLocaleLowerCase('ru').replaceAll('ё','е').trim();
const track = () => globalThis.window?.RecipeAnalytics?.event('step_submit','taste');

// The account API is the only source of saved choices; no device-local profile.
export async function mountTasteEditor({ element, api, complete, skip, settings = {} }) {
  const catalog = await api('/api/dinner/tastes', { signal: AbortSignal.timeout(12000) });
  if (!element.isConnected) return;
  let profile = catalog.profile, choices = { ...profile.dishRatings }, busy = false, query = '', page = 24;
  const dirty = new Map(), model = TasteFlow.create(catalog.items, catalog.order);
  let shown = [...new Set([...Object.keys(choices), ...catalog.order.slice(0,24)])], branches = {};
  element.innerHTML = `<div class="taste-top"><div class="taste-brand"><img src="/assets/recipe-bot-avatar-v3.webp" alt="">Твои рецепты</div><button type="button" id="taste-skip" class="taste-later">Позже</button></div>
    <h1>Что тебе <em>по вкусу?</em></h1><p class="taste-instruction">Нажимай: <strong class="taste-green">Нравится</strong> → <strong class="taste-red">Не нравится</strong> → снять</p>
    <label class="taste-search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10" cy="10" r="6.5"/><path d="m15 15 5 5"/></svg><input type="search" placeholder="Найти своё" aria-label="Найти блюдо" autocomplete="off" maxlength="100"></label>
    <div class="taste-cloud" aria-label="Блюда"></div><div class="taste-browse"><button type="button" id="taste-more">Показать ещё</button><button type="button" id="taste-other">Другие варианты</button></div>
    <p class="taste-status" role="status" aria-live="polite"></p>
    <footer class="taste-footer"><button type="button" class="primary accent" id="taste-save" disabled>Готово <span class="taste-count">0/3</span></button><p class="taste-save-hint">Отметь хотя бы 3 блюда</p></footer>`;
  const find = selector => element.querySelector(selector), cloud = find('.taste-cloud'), done = find('#taste-save'), later = find('#taste-skip');
  const status = find('.taste-status'), more = find('#taste-more'), other = find('#taste-other');
  function paint(focusKey) {
    const results = query ? catalog.order.filter(key => normalize(model.byKey.get(key).label).includes(query)) : shown;
    const keys = query ? results.slice(0,page) : results;
    cloud.innerHTML = keys.map(key => {
      const item = model.byKey.get(key), vote = choices[key] || 0;
      return `<button type="button" class="taste-chip ${vote === 1 ? 'is-liked' : vote === -1 ? 'is-disliked' : ''}" data-dish="${escape(key)}" aria-label="${escape(item.label)}: ${vote === 1 ? 'нравится' : vote === -1 ? 'не нравится' : 'не выбрано'}" aria-pressed="${Boolean(vote)}" ${busy ? 'disabled' : ''}><img src="${escape(item.photo)}" alt="" loading="lazy"><span>${escape(item.label)}</span>${vote ? `<i aria-hidden="true">${vote === 1 ? '✓' : '×'}</i>` : ''}</button>`;
    }).join('') || '<p class="taste-empty">Такого блюда пока нет. Попробуй другое название.</p>';
    const count = Object.keys(choices).length;
    done.disabled = busy || count < 3;
    done.innerHTML = `${busy ? 'Сохраняю…' : 'Готово'} <span class="taste-count">${count < 3 ? count+'/3' : count}</span>`;
    find('.taste-save-hint').textContent = count < 3 ? `Отметь ещё ${3-count} ${3-count === 1 ? 'блюдо' : 'блюда'}` : 'Сохраним выбор и учтём его в подборках';
    later.disabled = busy;
    const candidates = model.recommend(choices);
    more.hidden = query ? results.length <= page : !candidates.some(key => !shown.includes(key));
    other.hidden = Boolean(query) || !candidates.some(key => !shown.includes(key));
    more.disabled = other.disabled = busy;
    if (focusKey) [...cloud.querySelectorAll('[data-dish]')].find(button => button.dataset.dish === focusKey)?.focus({preventScroll:true});
  }
  cloud.onclick = event => {
    const button = event.target.closest('[data-dish]');
    if (busy || !button || !cloud.contains(button)) return;
    const key = button.dataset.dish, value = choices[key] === 1 ? -1 : choices[key] === -1 ? 0 : 1;
    if (value) choices[key] = value; else delete choices[key];
    dirty.set(key, value);
    ({shown,branches} = model.expand(shown,key,value,choices,branches));
    status.textContent = ''; track(); paint(key);
  };
  find('input').oninput = event => { query = normalize(event.target.value); page = 24; paint(); };
  more.onclick = () => {
    if (busy) return;
    if (query) page += 24;
    else shown.push(...model.recommend(choices).filter(key => !shown.includes(key)).slice(0,24));
    paint();
  };
  other.onclick = () => {
    if (busy) return;
    const next = model.recommend(choices).filter(key => !shown.includes(key)).slice(0,24);
    if (next.length) { shown = [...Object.keys(choices), ...next]; branches = {}; }
    paint();
  };
  async function save(retry = true) {
    try {
      return await api('/api/dinner/tastes', { method:'PUT', body:JSON.stringify({ ...settings, dishRatings:choices, tasteRevision:profile.tasteRevision, tastePreferencesStatus:'completed' }), signal:AbortSignal.timeout(15000) });
    } catch (error) {
      if (error.status !== 409 || !retry) throw error;
      // Rebase only this editor's deliberate changes. Other-device ratings survive.
      profile = await api('/api/dinner/profile', {signal:AbortSignal.timeout(12000)});
      choices = { ...profile.dishRatings };
      for (const [key,value] of dirty) { if(value) choices[key]=value; else delete choices[key]; }
      shown = [...new Set([...Object.keys(choices), ...shown])];
      if(Object.keys(choices).length < 3) throw new Error('Выбор обновился с другого устройства. Отметь хотя бы 3 блюда.');
      return save(false);
    }
  }
  done.onclick = async () => {
    if (busy || Object.keys(choices).length < 3) return;
    busy = true; status.textContent = ''; paint();
    try {
      const saved = await save();
      if (element.isConnected) await complete(saved);
    } catch(error) { if(element.isConnected) { busy=false; status.textContent=error.message; paint(); } }
  };
  later.onclick = async () => {
    if (busy) return;
    busy=true; paint();
    try {
      const input = { ...settings, ...(profile.tastePreferencesStatus === 'pending' ? {tastePreferencesStatus:'skipped'} : {}) };
      const saved = Object.keys(input).length ? await api('/api/dinner/tastes',{method:'PUT',body:JSON.stringify(input),signal:AbortSignal.timeout(15000)}) : profile;
      if (!Object.keys(input).length) track();
      if(element.isConnected) await skip(saved);
    } catch(error) { if(element.isConnected) { busy=false; status.textContent=error.message; paint(); } }
  };
  paint();
}
