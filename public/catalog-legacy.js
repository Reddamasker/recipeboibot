(() => {
  'use strict';
  const $ = selector => document.querySelector(selector);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const key = 'recipe-catalog-favorites-v1';
  let favorites = new Set(), controller, currentRecipe, noticeTimer;
  try { const stored = JSON.parse(localStorage.getItem(key)||'[]'); if(Array.isArray(stored)) favorites = new Set(stored.filter(id=>typeof id==='string' && /^[a-z0-9-]+$/.test(id)).slice(0,250)); } catch {}
  const filterNames = ['cuisine','category','time','include','exclude'];
  const params = () => new URLSearchParams(location.search);
  const previousFilters=params();
  if(['asian','eastern','european','caucasian'].includes(previousFilters.get('cuisine'))) {
    previousFilters.delete('cuisine');
    history.replaceState({},'',location.pathname+(previousFilters.size?'?'+previousFilters.toString():''));
  }
  const visualMode = params().get('filters') === 'visual';
  const mainCuisines = ['everyday','russian','italian','georgian','japanese','chinese'];
  const mainCuisineValues = values => mainCuisines.map(id=>values.find(value=>value.id===id)).filter(Boolean);
  const dishTypes=['noodles','rice','pasta','soup','salad','baking','pizza'];
  let expandedCuisines=false, visualResult;
  const cuisineIllustrations = new Set(['everyday','italian','georgian','asian','japanese','russian',
    'ukrainian','belarusian','greek','indian','hungarian','uzbek','eastern','european','caucasian']);
  const productButtons = [
    ['курица','Курица','chicken'],['говядина','Говядина','beef'],
    ['свинина','Свинина','pork'],['рыба','Рыба','fish'],['рис','Рис','rice'],
    ['картофель','Картофель','potato'],['грибы','Грибы','mushroom'],
    ['яйца','Яйца','egg'],['томаты','Томаты','tomato'],['сыр','Сыр','cheese']
  ];
  const selectedProducts = p => (p.get('include')||'').split(',').map(s=>s.trim()).filter(Boolean);
  function visualButton(name,value,label,extra='') {
    const selected=name==='include'?selectedProducts(params()).includes(value):(params().get(name)||'')===value;
    return `<button type="button" data-visual-filter="${name}" data-value="${escape(value)}" aria-pressed="${selected}" ${extra}>${label}</button>`;
  }
  function renderVisualFilters(p,result) {
    if(!visualMode)return;
    visualResult=result;
    const focused=document.activeElement?.dataset.visualFilter ? {name:document.activeElement.dataset.visualFilter,value:document.activeElement.dataset.value}:null;
    const choices=result.cuisineChoices||result.cuisines;
    const primary=mainCuisineValues(choices), other=choices.filter(c=>!mainCuisines.includes(c.id));
    const visible=[...primary,...other.filter(c=>expandedCuisines||c.id===p.get('cuisine'))];
    const illustration=id=>cuisineIllustrations.has(id)?id:id==='chinese'?'asian':['lebanese','turkish'].includes(id)?'eastern':'everyday';
    $('#cuisine-tiles').innerHTML=visible.map(c=>visualButton('cuisine',c.id,`<img src="/assets/filters/cuisine-${illustration(c.id)}.webp" alt="" width="190" height="96"><span class="tile-label">${escape(c.label)}<small>${c.count}</small></span>`,'class="cuisine-tile"')).join('');
    $('#cuisine-tiles').dataset.expanded='true';
    $('#all-cuisines').hidden=!other.length;
    $('#all-cuisines').textContent=expandedCuisines?'Свернуть':'Другие кухни';
    $('#all-cuisines').setAttribute('aria-expanded',String(expandedCuisines));
    $('#ingredient-chips').innerHTML=productButtons.map(([value,label,illustration])=>visualButton('include',value,`<img src="/assets/filters/ingredient-${illustration}.webp" alt="" width="36" height="36"><span>${label}</span>`,'class="ingredient-chip"')).join('');
    $('#time-chips').innerHTML='<span>Время</span>'+[['','Любое'],['20','До 20 мин'],['30','До 30 мин'],['45','До 45 мин'],['60','До часа']].map(([value,label])=>visualButton('time',value,label)).join('');
    $('#category-chips').innerHTML=visualButton('category','','Все блюда')+result.categories.filter(c=>dishTypes.includes(c.id)).map(c=>visualButton('category',c.id,escape(c.label))).join('');
    $('#visual-include').value=p.get('include')||'';
    $('#visual-exclude').value=p.get('exclude')||'';
    $('#visual-reset').hidden=!['q',...filterNames,'favorites'].some(name=>p.get(name));
    if(focused) [...document.querySelectorAll('[data-visual-filter]')].find(b=>b.dataset.visualFilter===focused.name&&b.dataset.value===focused.value)?.focus({preventScroll:true});
  }
  if(visualMode) {
    document.body.dataset.filterLayout='visual';$('#visual-discovery').hidden=false;
    $('.intro .lead').textContent='Выберите кухню, блюдо и продукты — найдём, что приготовить.';
    $('.search-label').textContent='Или найдите по названию';
    $('#search').placeholder='Например, паста с томатами';
    $('#search-form button').textContent='Найти';
    $('.header a[aria-current]').href='/recipes?filters=visual';
    $('#all-cuisines').addEventListener('click',()=>{expandedCuisines=!expandedCuisines;if(visualResult)renderVisualFilters(params(),visualResult);});
    $('#show-results').addEventListener('click',()=>$('.results').scrollIntoView({behavior:'smooth',block:'start'}));
    $('#more-filters').addEventListener('click',()=>{const panel=$('#visual-refinements');panel.hidden=!panel.hidden;$('#more-filters').setAttribute('aria-expanded',String(!panel.hidden));});
    $('#visual-reset').addEventListener('click',()=>navigate('/recipes'));
    $('#visual-products').addEventListener('submit',event=>{event.preventDefault();const p=params();for(const name of ['include','exclude']){const value=$('#visual-'+name).value.trim();if(value)p.set(name,value);else p.delete(name);}p.delete('page');navigate(searchUrl(p));});
  }
  const favoriteText = id => favorites.has(id) ? 'Сохранено' : 'В избранное';
  function notice(text) { $('#notice').textContent=text; $('#notice').hidden=false; clearTimeout(noticeTimer); noticeTimer=setTimeout(()=>$('#notice').hidden=true,3500); }
  function saveFavorite(id) {
    if(favorites.has(id)) favorites.delete(id); else favorites.add(id);
    try { localStorage.setItem(key,JSON.stringify([...favorites])); window.RecipeAnalytics?.event(favorites.has(id)?'catalog_favorite_add':'catalog_favorite_remove','catalog'); notice(favorites.has(id)?'Рецепт сохранён в этом браузере':'Рецепт убран из избранного'); }
    catch { notice('Хранилище браузера недоступно. Избранное сохранится только до закрытия страницы.'); }
    updateFavorites();
    if(!currentRecipe && params().get('favorites')==='1') load();
  }
  function updateFavorites() {
    $('#saved-count').textContent=favorites.size;
    document.querySelectorAll('[data-save]').forEach(button=>{button.textContent=favoriteText(button.dataset.save);button.setAttribute('aria-pressed',String(favorites.has(button.dataset.save)));});
  }
  function navigate(url, {scroll=false}={}) { const target=new URL(url,location.origin);if(visualMode)target.searchParams.set('filters','visual');history.pushState({},'',target.pathname+target.search); load(); if(scroll) window.scrollTo({top:0}); }
  function searchUrl(p) { if(visualMode)p.set('filters','visual');return '/recipes'+(p.size?'?'+p.toString():''); }
  async function request(url, signal) {
    const response=await fetch(url,{signal});
    if(!response.ok) throw new Error(response.status===404?'Рецепт не найден':response.status===429?'Слишком много запросов. Попробуйте через минуту.':'Не удалось загрузить рецепты. Проверьте соединение и повторите.');
    return response.json();
  }
  function options(name, values, selected) {
    const select=$(`#filters [name="${name}"]`);
    const visible=name==='category'?values.filter(v=>dishTypes.includes(v.id)):values;
    const option=v=>`<option value="${escape(v.id)}">${escape(v.label)} (${v.count})</option>`;
    const items=name==='cuisine'
      ? mainCuisineValues(visible).map(option).join('')+`<optgroup label="Другие кухни">${visible.filter(v=>!mainCuisines.includes(v.id)).map(option).join('')}</optgroup>`
      : visible.map(option).join('');
    select.innerHTML=`<option value="">${name==='cuisine'?'Все кухни':'Все блюда'}</option>`+items;
    if(selected && !visible.some(v=>v.id===selected)) {
      const known=values.find(v=>v.id===selected), option=new Option(known?.label||'Неизвестный фильтр',selected);
      option.hidden=Boolean(known); select.add(option);
    }
    select.value=selected||'';
  }
  function card(recipe) {
    const media=recipe.image?`<img src="${escape(recipe.image)}" alt="${escape(recipe.title)}" loading="lazy" width="400" height="308">`:`<img src="/assets/catalog-photo-pending.svg" alt="Фотография блюда пока не добавлена" loading="lazy" width="400" height="308">`;
    return `<article class="card"><button class="card-save" data-save="${escape(recipe.id)}" aria-pressed="${favorites.has(recipe.id)}" aria-label="Избранное: ${escape(recipe.title)}">${favoriteText(recipe.id)}</button><a class="card-link" data-route href="/recipes/${escape(recipe.id)}${location.search}"><div class="card-media">${media}</div><h3>${escape(recipe.title)}</h3><div class="card-meta">${recipe.cuisineLabel?`<span class="card-cuisine">${escape(recipe.cuisineLabel)}</span>`:""}<span>${recipe.minutes} мин</span><span>${recipe.ingredientCount} ингредиентов</span></div><p class="card-description">${escape(recipe.description)}</p></a></article>`;
  }
  function activeFilters(p, result) {
    const labels={q:'Поиск',cuisine:'Кухня',category:'Блюдо',time:'До, минут',include:'С продуктами',exclude:'Без продуктов',favorites:'Избранное'};
    $('#active-filters').innerHTML=Object.entries(labels).filter(([name])=>p.get(name)).map(([name,label])=>{
      const value=name==='favorites'?'в этом браузере':name==='cuisine'?(result.cuisineChoices||result.cuisines).find(c=>c.id===p.get(name))?.label||p.get(name):name==='category'?result.categories.find(c=>c.id===p.get(name))?.label||p.get(name):p.get(name);
      return `<button data-remove="${name}" aria-label="Убрать фильтр ${escape(label)}">${escape(label)}: ${escape(value)} ×</button>`;
    }).join('');
  }
  async function load() {
    controller?.abort(); controller=new AbortController(); const signal=controller.signal;
    const p=params(), id=location.pathname.match(/^\/recipes\/([a-z0-9-]+)$/)?.[1];
    currentRecipe=null;
    $('#catalog-view').hidden=Boolean(id); $('#recipe-view').hidden=!id;
    $('#saved-toggle').setAttribute('aria-pressed',String(p.get('favorites')==='1'));
    if(id) {
      $('#recipe-view').innerHTML='<p role="status">Загружаем рецепт…</p>';
      try { const recipe=await request('/api/catalog/'+id,signal); currentRecipe=recipe; renderRecipe(recipe,p); window.RecipeAnalytics?.observe($('#recipe-view'),'catalog_open','catalog'); }
      catch(error) { if(error.name!=='AbortError') $('#recipe-view').innerHTML=`<a class="back" data-route href="${escape(searchUrl(p))}">← В каталог</a><div class="empty"><h1>${escape(error.message)}</h1><button data-retry>Повторить</button></div>`; }
      return;
    }
    document.title='Выбрать рецепт — Твои рецепты';
    $('#search').value=p.get('q')||'';
    for(const name of filterNames) $(`#filters [name="${name}"]`).value=p.get(name)||'';
    $('#sort').value=p.get('sort')||'recommended';
    $('#cards').setAttribute('aria-busy','true'); $('#result-count').textContent='Загружаем каталог…';
    const apiParams=new URLSearchParams(p);
    if(p.get('favorites')==='1') apiParams.set('saved',[...favorites].join(',')); else apiParams.delete('saved');
    try {
      const result=await request('/api/catalog?'+apiParams.toString(),signal);
      options('cuisine',result.cuisineChoices||result.cuisines,p.get('cuisine')); options('category',result.categories,p.get('category'));
      renderVisualFilters(p,result);
      $('#catalog-total').textContent=result.catalogTotal;
      $('#show-results').textContent=`Показать рецепты (${result.total})`;
      $('#results-title').textContent=p.get('favorites')==='1'?'Избранное':'Рецепты для вас';
      $('#result-count').textContent=`Найдено: ${result.total}${p.get('favorites')==='1'?' · Сохранено в этом браузере':''}`;
      activeFilters(p,result);
      window.RecipeAnalytics?.observe($('#cards'),'catalog_list','catalog',{results:result.recipes.length});
      if(p.get('q'))window.RecipeAnalytics?.event('catalog_search','catalog',{results:result.recipes.length});
      if(!result.recipes.length)window.RecipeAnalytics?.event('catalog_empty','catalog');
      const filters=filterNames.filter(k=>p.get(k)).length;
      if(filters)window.RecipeAnalytics?.event('catalog_filter','catalog',{filters});
      $('#cards').innerHTML=result.recipes.length?result.recipes.map(card).join(''):`<div class="empty"><h3>${p.get('favorites')==='1'&&!favorites.size?'Здесь будут любимые рецепты':'Подходящих рецептов пока нет'}</h3><p>${p.get('favorites')==='1'&&!favorites.size?'Нажмите «В избранное» на понравившейся карточке.':'Попробуйте убрать часть фильтров или увеличить время приготовления.'}</p><button data-reset>Показать все рецепты</button></div>`;
      $('#pagination').innerHTML=result.pages>1?`<button data-page="${result.page-1}" ${result.page===1?'disabled':''}>Назад</button><span>${result.page} из ${result.pages}</span><button data-page="${result.page+1}" ${result.page===result.pages?'disabled':''}>Далее</button>`:'';
    } catch(error) { if(error.name!=='AbortError') { $('#result-count').textContent='Каталог недоступен'; $('#pagination').innerHTML=''; $('#cards').innerHTML=`<div class="empty"><p>${escape(error.message)}</p><button data-retry>Повторить</button></div>`; } }
    finally { if(!signal.aborted) $('#cards').setAttribute('aria-busy','false'); }
  }
  function renderRecipe(recipe,p) {
    const extras = window.CatalogRecipe.render($('#recipe-view'),recipe,{
      backUrl:searchUrl(p),favoriteText:favoriteText(recipe.id),favorite:favorites.has(recipe.id),notify:notice
    });
  }
  function applyFilters(event) {
    event.preventDefault();const p=params();p.delete('page');
    const values={q:$('#search').value.trim(),sort:$('#sort').value,...Object.fromEntries(new FormData($('#filters')))};
    for(const [name,value] of Object.entries(values)) { if(value && value!=='recommended') p.set(name,value); else p.delete(name); }
    navigate(searchUrl(p));
  }
  $('#search-form').addEventListener('submit',applyFilters); $('#filters').addEventListener('submit',applyFilters);
  $('#filters').addEventListener('change',event=>{if(event.target.tagName==='SELECT')applyFilters(event);});
  $('#sort').addEventListener('change',applyFilters);
  $('#reset').addEventListener('click',()=>navigate('/recipes'));
  $('#saved-toggle').addEventListener('click',()=>{const p=new URLSearchParams();if(params().get('favorites')!=='1')p.set('favorites','1');navigate(searchUrl(p),{scroll:true});});
  document.addEventListener('click',event=>{
    const target=event.target.closest('button,a'); if(!target)return;
    if(target.matches('[data-route]')&&!event.ctrlKey&&!event.metaKey&&!event.shiftKey&&!event.altKey&&event.button===0){event.preventDefault();navigate(target.getAttribute('href'),{scroll:true});}
    else if(target.dataset.save) saveFavorite(target.dataset.save);
    else if(target.hasAttribute('data-reset')) navigate('/recipes');
    else if(target.hasAttribute('data-retry')) load();
    else if(target.dataset.visualFilter) {
      const p=params(),name=target.dataset.visualFilter,value=target.dataset.value;
      if(name==='include') {const chosen=selectedProducts(p);const next=chosen.includes(value)?chosen.filter(v=>v!==value):[...chosen,value];if(next.length)p.set(name,next.join(','));else p.delete(name);}
      else if(p.get(name)===value||!value)p.delete(name);else p.set(name,value);
      p.delete('page');navigate(searchUrl(p));
    }
    else if(target.dataset.quick) {const p=params(),[name,value]=target.dataset.quick.split(':');p.set(name,value);p.delete('page');navigate(searchUrl(p));}
    else if(target.dataset.remove){const p=params();p.delete(target.dataset.remove);p.delete('page');navigate(searchUrl(p));}
    else if(target.dataset.page){const p=params();p.set('page',target.dataset.page);navigate(searchUrl(p));$('.results').scrollIntoView({block:'start'});}
  });
  const mobile = matchMedia('(max-width:760px)');
  if(mobile.matches) $('#filter-panel').open=false;
  mobile.addEventListener('change',event=>{if(!event.matches)$('#filter-panel').open=true;});
  window.addEventListener('popstate',load);
  updateFavorites(); load();
})();
