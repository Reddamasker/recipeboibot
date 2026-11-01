(() => {
  'use strict';
  const $ = selector => document.querySelector(selector);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const key = 'recipe-catalog-favorites-v1';
  let favorites = new Set(), controller, currentRecipe, noticeTimer, pendingBenefitsPreview = null;
  try { const stored = JSON.parse(localStorage.getItem(key)||'[]'); if(Array.isArray(stored)) favorites = new Set(stored.filter(id=>typeof id==='string' && /^[a-z0-9-]+$/.test(id)).slice(0,250)); } catch {}
  const filterNames = ['cuisine','category','time','include','exclude'];
  const params = () => new URLSearchParams(location.search);
  const adEntry = /^\/dinner(?:\/|$)/.test(location.pathname);
  const routeBase = adEntry ? '/dinner' : '/recipes';
  const journey = (method,...args) => {try{return window.CatalogDetail?.[method]?.(...args);}catch{}};
  const analyticsDetail = () => ({...window.CatalogHandoff?.detail(),...journey('detail')});
  const resetUrl = () => { const p=params(); for(const name of ['q',...filterNames,'favorites','page','sort'])p.delete(name);return searchUrl(p); };
  const previousFilters=params();
  if(['asian','eastern','european','caucasian'].includes(previousFilters.get('cuisine'))) {
    previousFilters.delete('cuisine');
    history.replaceState({},'',location.pathname+(previousFilters.size?'?'+previousFilters.toString():''));
  }
  const visualMode = params().get('filters') !== 'classic';
  const dinnerVariant = adEntry && visualMode;
  const mainCuisines = ['everyday','russian','italian','georgian','japanese','chinese'];
  const mainCuisineValues = values => mainCuisines.map(id=>values.find(value=>value.id===id)).filter(Boolean);
  const dishTypes=['noodles','rice','pasta','soup','salad','baking','pizza'];
  let expandedCuisines=false, visualResult;
  const productGroups = [
    ['Основа', [['лапша','Лапша','noodles'],['картофель','Картофель','potato'],['рис','Рис','rice'],['макароны','Макароны','pasta']]],
    ['Мясо и рыба', [['курица','Курица','chicken'],['говядина','Говядина','beef'],['свинина','Свинина','pork'],['рыба','Рыба','fish']]],
    ['Другие продукты', [['овощи','Овощи','vegetables'],['грибы','Грибы','mushroom'],['яйца','Яйца','egg'],['сыр','Сыр','cheese']]]
  ];
  const newProductImages = new Set(['noodles','pasta','vegetables']);
  const dinnerProducts = [
    ['картофель','Картофель','potato'],['курица','Курица','chicken'],['макароны','Макароны','pasta'],['сыр','Сыр','cheese'],
    ['фарш','Фарш','mince'],['лук','Лук','onion'],['морковь','Морковь','carrot'],['яйца','Яйца','egg'],
    ['свинина','Свинина','pork'],['говядина','Говядина','beef'],['рис','Рис','rice'],['лапша','Лапша','noodles']
  ];
  const dinnerPhotos = new Set(['mince','onion','carrot','egg']);
  const cuisinePhotos = new Set(['everyday','russian','italian','georgian','japanese','chinese']);
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
    $('#cuisine-tiles').innerHTML=visible.map(c=>visualButton('cuisine',c.id,`${dinnerVariant&&cuisinePhotos.has(c.id)?`<img src="/assets/filters/variant2/cuisine-${c.id}.webp" width="40" height="40" alt="">`:''}<span class="tile-label">${escape(c.label)}<small>${c.count}</small></span>`,'class="cuisine-tile"')).join('');
    $('#cuisine-tiles').dataset.expanded='true';
    $('#all-cuisines').hidden=!other.length;
    $('#all-cuisines').textContent=expandedCuisines?'Свернуть':'Другие кухни';
    $('#all-cuisines').setAttribute('aria-expanded',String(expandedCuisines));
    $('#ingredient-chips').innerHTML=productGroups.map(([heading,products])=>`<section class="ingredient-group" aria-label="${escape(heading)}"><h3>${escape(heading)}</h3><div class="ingredient-grid">${products.map(([value,label,illustration])=>visualButton('include',value,`<img src="/assets/filters/ingredients-${newProductImages.has(illustration)?'v3':'v2'}/${illustration}.webp" alt="" width="160" height="128"><span>${label}</span>`,'class="ingredient-chip"')).join('')}</div></section>`).join('');
    if(dinnerVariant) $('#ingredient-chips').innerHTML=dinnerProducts.map(([value,label,illustration])=>visualButton('include',value,`<img src="/assets/filters/${dinnerPhotos.has(illustration)?'variant2':`ingredients-${newProductImages.has(illustration)?'v3':'v2'}`}/${illustration}.webp" alt="" width="160" height="160"><span>${label}</span>`,'class="ingredient-chip"')).join('');
    $('#time-chips').innerHTML='<span>Время</span>'+[['','Любое'],['20','До 20 мин'],['30','До 30 мин'],['45','До 45 мин'],['60','До часа']].map(([value,label])=>visualButton('time',value,label)).join('');
    $('#category-chips').innerHTML=visualButton('category','','Все блюда')+result.categories.filter(c=>dishTypes.includes(c.id)).map(c=>visualButton('category',c.id,escape(c.label))).join('');
    $('#visual-include').value=p.get('include')||'';
    $('#visual-exclude').value=p.get('exclude')||'';
    $('#visual-reset').hidden=!['q',...filterNames,'favorites'].some(name=>p.get(name));
    if(focused) [...document.querySelectorAll('[data-visual-filter]')].find(b=>b.dataset.visualFilter===focused.name&&b.dataset.value===focused.value)?.focus({preventScroll:true});
  }
  if(visualMode) {
    document.body.dataset.filterLayout='visual';$('#visual-discovery').hidden=false;
    $('.search-label').textContent='Или найдите по названию';
    $('#search').placeholder='Например, паста с томатами';
    $('#search-form button').textContent='Найти';
    $('.header a[aria-current]').href=searchUrl(new URLSearchParams());
    $('#all-cuisines').addEventListener('click',()=>{expandedCuisines=!expandedCuisines;if(expandedCuisines)journey('action','more_cuisines');if(visualResult)renderVisualFilters(params(),visualResult);journey('mount');});
    $('#show-results').addEventListener('click',()=>{journey('action','results_jump');if(adEntry)$('#dinner-filters').open=false;$('.results').scrollIntoView({behavior:'smooth',block:'start'});});
    $('#more-filters').addEventListener('click',()=>{const panel=$('#visual-refinements');panel.hidden=!panel.hidden;if(!panel.hidden)journey('action','filters_expand');$('#more-filters').setAttribute('aria-expanded',String(!panel.hidden));journey('recheck');});
    $('#visual-reset').addEventListener('click',()=>{journey('action','filter_reset');navigate(resetUrl(),{navigation:'reset'});});
    $('#visual-products').addEventListener('submit',event=>{event.preventDefault();journey('action','filter_change');const p=params();for(const name of ['include','exclude']){const value=$('#visual-'+name).value.trim();if(value)p.set(name,value);else p.delete(name);}p.delete('page');navigate(searchUrl(p),{navigation:'filter'});});
  }
  if(adEntry) {
    document.body.dataset.catalogEntry='dinner';
    $('.intro h1').innerHTML='Что приготовить <em>на ужин?</em>';
    if(!dinnerVariant) {const copy=document.createElement('p');copy.className='catalog-entry-copy';copy.textContent='Выберите блюдо и откройте полный рецепт. Все ингредиенты и шаги — сразу на сайте.';$('.intro h1').after(copy);}
    $('.header a[aria-current]').href=searchUrl(params());
    $('.header .brand').href=searchUrl(params());
    if(visualMode) {
      document.body.dataset.dinnerVariant='2';
      $('.ingredients-heading h2').textContent='Ингредиенты';
      $('.ingredient-help').innerHTML='Выберите продукты, которые есть дома.<br>Покажем блюда со всеми выбранными ингредиентами.';
      $('.search-label').textContent='Или найдите рецепт по названию';
      $('#selection-tags').append($('#active-filters'));
      $('#selection-head').append($('#visual-reset'));
      $('#selection-state').hidden=true;
    }
  }
  const favoriteText = id => favorites.has(id) ? 'Сохранено' : 'В избранное';
  function notice(text) { $('#notice').textContent=text; $('#notice').hidden=false; clearTimeout(noticeTimer); noticeTimer=setTimeout(()=>$('#notice').hidden=true,3500); }
  function saveFavorite(id) {
    journey('action',favorites.has(id)?'favorite_remove':'favorite_add');
    if(favorites.has(id)) favorites.delete(id); else favorites.add(id);
    try { localStorage.setItem(key,JSON.stringify([...favorites])); window.RecipeAnalytics?.event(favorites.has(id)?'catalog_favorite_add':'catalog_favorite_remove','catalog',analyticsDetail()); notice(favorites.has(id)?'Рецепт сохранён в этом браузере':'Рецепт убран из избранного'); }
    catch { notice('Хранилище браузера недоступно. Избранное сохранится только до закрытия страницы.'); }
    updateFavorites();
    if(!currentRecipe && params().get('favorites')==='1') load({navigation:'favorites'});
  }
  function updateFavorites() {
    $('#saved-count').textContent=favorites.size;
    document.querySelectorAll('[data-save]').forEach(button=>{button.textContent=favoriteText(button.dataset.save);button.setAttribute('aria-pressed',String(favorites.has(button.dataset.save)));});
  }
  function navigate(url, {scroll=false, benefits=false, navigation='link'}={}) { const target=new URL(url,location.origin);if(visualMode)target.searchParams.set('filters','visual');history.pushState({},'',target.pathname+target.search); load({benefits,navigation}); if(scroll) window.scrollTo({top:0}); }
  function searchUrl(p) { if(visualMode)p.set('filters','visual');if(window.CatalogHandoff?.context.campaign)p.set('campaign',window.CatalogHandoff.context.campaign);return routeBase+(p.size?'?'+p.toString():''); }
  async function request(url, signal) {
    const response=await fetch(url,{signal});
    if(!response.ok) throw Object.assign(new Error(response.status===404?'Рецепт не найден':response.status===429?'Слишком много запросов. Попробуйте через минуту.':'Не удалось загрузить рецепты. Проверьте соединение и повторите.'),{code:'http'});
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
    return `<article class="card"><button class="card-save" data-save="${escape(recipe.id)}" aria-pressed="${favorites.has(recipe.id)}" aria-label="Избранное: ${escape(recipe.title)}">${favoriteText(recipe.id)}</button><a class="card-link" data-route href="${routeBase}/${escape(recipe.id)}${location.search}"><div class="card-media">${media}</div><h3>${escape(recipe.title)}</h3><div class="card-meta">${recipe.cuisineLabel?`<span class="card-cuisine">${escape(recipe.cuisineLabel)}</span>`:""}<span>${recipe.minutes} мин</span><span>${recipe.ingredientCount} ингредиентов</span></div><p class="card-description">${escape(recipe.description)}</p></a></article>`;
  }
  function activeFilters(p, result) {
    const labels={q:'Поиск',cuisine:'Кухня',category:'Блюдо',time:'До, минут',include:'С продуктами',exclude:'Без продуктов',favorites:'Избранное'};
    const products=selectedProducts(p);
    const productChips=dinnerVariant?products.map(value=>`<button data-remove="include" data-product="${escape(value)}" aria-label="Убрать продукт ${escape(value)}">${escape(dinnerProducts.find(([key])=>key===value)?.[1]||value)} <span aria-hidden="true">×</span></button>`).join(''):'';
    $('#active-filters').innerHTML=productChips+Object.entries(labels).filter(([name])=>p.get(name)&&!(dinnerVariant&&name==='include')).map(([name,label])=>{
      const value=name==='favorites'?'в этом браузере':name==='cuisine'?(result.cuisineChoices||result.cuisines).find(c=>c.id===p.get(name))?.label||p.get(name):name==='category'?result.categories.find(c=>c.id===p.get(name))?.label||p.get(name):p.get(name);
      return `<button data-remove="${name}" aria-label="Убрать фильтр ${escape(label)}">${dinnerVariant&&name==='cuisine'?'':escape(label)+': '}${escape(value)} <span aria-hidden="true">×</span></button>`;
    }).join('');
    if(dinnerVariant) {
      const count=products.length+Object.keys(labels).filter(name=>name!=='include'&&p.get(name)).length;
      $('#selection-state').hidden=!count;
      $('#selection-label').textContent=count===products.length?`Выбрано ${count} ${count===1?'продукт':count<5?'продукта':'продуктов'}`:`Выбрано фильтров: ${count}`;
    }
  }
  async function load({benefits=false,navigation='initial'}={}) {
    window.CatalogRecipe?.dispose();
    const startedAt=Date.now();
    window.CatalogBenefits?.close({restoreFocus:false, observeRecipe:false});
    controller?.abort(); controller=new AbortController(); const signal=controller.signal;
    const p=params(), id=location.pathname.match(/^\/(?:recipes|dinner)\/([a-z0-9-]+)$/)?.[1];
    journey('begin',id?'recipe':'list',navigation);
    if (p.get('benefits') === 'preview') pendingBenefitsPreview = id || null;
    else if (pendingBenefitsPreview !== id) pendingBenefitsPreview = null;
    const previewBenefits = Boolean(id && pendingBenefitsPreview === id);
    if (p.get('benefits') === 'preview') {
      p.delete('benefits');
      history.replaceState(history.state, '', location.pathname + (p.size ? '?' + p.toString() : '') + location.hash);
    }
    currentRecipe=null;
    $('#catalog-view').hidden=Boolean(id); $('#recipe-view').hidden=!id;
    $('#saved-toggle').setAttribute('aria-pressed',String(p.get('favorites')==='1'));
    if(id) {
      $('#recipe-view').innerHTML='<p role="status">Загружаем рецепт…</p>';
      try {
        const recipe=await request('/api/catalog/'+id,signal);
        if(signal.aborted) return;
        currentRecipe=recipe; renderRecipe(recipe,p);journey('mount');
        let observed=false;
        const observeRecipe=()=>{if(observed || signal.aborted || currentRecipe!==recipe)return;observed=true;try{window.RecipeAnalytics?.observe($('#recipe-view'),'catalog_open','catalog',{...analyticsDetail(),_started:startedAt});}catch{}};
        const opened=!adEntry && (benefits || previewBenefits) && window.CatalogBenefits?.open(recipe,{automatic:!previewBenefits,afterClose:observeRecipe});
        if (previewBenefits) pendingBenefitsPreview = null;
        if(!opened)observeRecipe();
      }
      catch(error) { if(error.name!=='AbortError') {try{window.RecipeAnalytics?.event('client_error','catalog',{...analyticsDetail(),code:error.code==='http'?'http':'network'});}catch{}$('#recipe-view').innerHTML=`<a class="back" data-route href="${escape(searchUrl(p))}">← В каталог</a><div class="empty"><h1>${escape(error.message)}</h1><button data-retry>Повторить</button></div>`;journey('mount');} }
      return;
    }
    document.title=adEntry?'Что приготовить на ужин — Твои рецепты':'Выбрать рецепт — Твои рецепты';
    $('#search').value=p.get('q')||'';
    for(const name of filterNames) $(`#filters [name="${name}"]`).value=p.get(name)||'';
    $('#sort').value=p.get('sort')||'recommended';
    $('#cards').setAttribute('aria-busy','true'); $('#result-count').textContent='Загружаем каталог…';
    if(dinnerVariant) {
      if(visualResult) {renderVisualFilters(p,visualResult);activeFilters(p,visualResult);}
      $('#cards').innerHTML=Array.from({length:2},()=>'<div class="catalog-skeleton" aria-hidden="true"><div></div><span></span><span></span></div>').join('');
      $('#pagination').innerHTML='';
      $('#results-title').textContent=p.get('favorites')==='1'?'Избранное':['q',...filterNames].some(name=>p.get(name))?'Подходящие рецепты':'Все рецепты';
    }
    const apiParams=new URLSearchParams(p);
    if(p.get('favorites')==='1') apiParams.set('saved',[...favorites].join(',')); else apiParams.delete('saved');
    try {
      const result=await request('/api/catalog?'+apiParams.toString(),signal);
      if(signal.aborted)return;
      options('cuisine',result.cuisineChoices||result.cuisines,p.get('cuisine')); options('category',result.categories,p.get('category'));
      renderVisualFilters(p,result);
      $('#catalog-total').textContent=result.catalogTotal;
      $('#show-results').textContent=`Показать рецепты (${result.total})`;
      $('#results-title').textContent=p.get('favorites')==='1'?'Избранное':['q',...filterNames].some(name=>p.get(name))?'Подходящие рецепты':'Все рецепты';
      $('#result-count').textContent=`Найдено: ${result.total}${p.get('favorites')==='1'?' · Сохранено в этом браузере':''}`;
      activeFilters(p,result);
      if(p.get('q'))window.RecipeAnalytics?.event('catalog_search','catalog',{...analyticsDetail(),results:result.recipes.length,resultsTotal:result.total});
      if(!result.recipes.length)window.RecipeAnalytics?.event('catalog_empty','catalog',{...analyticsDetail(),resultsTotal:result.total});
      const filters=filterNames.filter(k=>p.get(k)).length;
      if(filters)window.RecipeAnalytics?.event('catalog_filter','catalog',{...analyticsDetail(),filters,resultsTotal:result.total});
      $('#cards').innerHTML=result.recipes.length?result.recipes.map(card).join(''):`<div class="empty"><h3>${p.get('favorites')==='1'&&!favorites.size?'Здесь будут любимые рецепты':'Подходящих рецептов пока нет'}</h3><p>${p.get('favorites')==='1'&&!favorites.size?'Нажмите «В избранное» на понравившейся карточке.':'Попробуйте убрать часть фильтров или увеличить время приготовления.'}</p><button data-reset>Показать все рецепты</button></div>`;
      if(dinnerVariant&&!result.recipes.length&&p.get('favorites')!=='1') {
        const cuisine=(result.cuisineChoices||result.cuisines).find(c=>c.id===p.get('cuisine'));
        $('#cards').innerHTML=`<div class="empty"><h3>Ничего не нашли</h3><p>${cuisine?'С такой кухней и набором продуктов пока нет блюд.<br>Уберите кухню или один из продуктов.':'Попробуйте убрать один из фильтров или изменить запрос.'}</p>${cuisine?'<button class="primary" data-remove="cuisine">Убрать выбранную кухню</button>':''}<button class="empty-reset" data-reset>Сбросить все фильтры</button></div>`;
      }
      window.RecipeAnalytics?.observe($('#cards'),'catalog_list','catalog',{...analyticsDetail(),results:result.recipes.length,resultsTotal:result.total,_started:startedAt});
      $('#pagination').innerHTML=result.pages>1?`<button data-page="${result.page-1}" ${result.page===1?'disabled':''}>Назад</button><span>${result.page} из ${result.pages}</span><button data-page="${result.page+1}" ${result.page===result.pages?'disabled':''}>Далее</button>`:'';
      journey('mount');
    } catch(error) { if(error.name!=='AbortError') { try{window.RecipeAnalytics?.event('client_error','catalog',{...analyticsDetail(),code:error.code==='http'?'http':'network'});}catch{}$('#result-count').textContent='Каталог недоступен'; $('#pagination').innerHTML=''; $('#cards').innerHTML=`<div class="empty"><p>${escape(error.message)}</p><button data-retry>Повторить</button></div>`;journey('mount'); } }
    finally { if(!signal.aborted) $('#cards').setAttribute('aria-busy','false'); }
  }
  function renderRecipe(recipe,p) {
    const extras = window.CatalogRecipe.render($('#recipe-view'),recipe,{
      backUrl:searchUrl(p),notify:notice,
      action:name=>journey('action',name),detail:analyticsDetail
    });
    const saveSection=document.createElement('section');
    extras.append(saveSection);
    window.CatalogHandoff?.mount(saveSection,recipe);

  }
  function applyFilters(event) {
    event.preventDefault();const p=params();p.delete('page');
    const navigation=event.target.id==='sort'?'sort':event.target.id==='search-form'?'search':'filter';
    journey('action',navigation==='sort'?'sort_change':navigation==='search'?'search_submit':'filter_change',{control:event.target.name});
    const values={q:$('#search').value.trim(),sort:$('#sort').value,...Object.fromEntries(new FormData($('#filters')))};
    for(const [name,value] of Object.entries(values)) { if(value && value!=='recommended') p.set(name,value); else p.delete(name); }
    navigate(searchUrl(p),{navigation});
  }
  $('#search-form').addEventListener('submit',applyFilters); $('#filters').addEventListener('submit',applyFilters);
  $('#filters').addEventListener('change',event=>{if(event.target.tagName==='SELECT')applyFilters(event);});
  $('#sort').addEventListener('change',applyFilters);
  $('#reset').addEventListener('click',()=>{journey('action','filter_reset');navigate(resetUrl(),{navigation:'reset'});});
  $('#saved-toggle').addEventListener('click',()=>{const p=new URLSearchParams();if(params().get('favorites')!=='1')p.set('favorites','1');navigate(searchUrl(p),{scroll:true,navigation:'favorites'});});
  document.addEventListener('click',event=>{
    const target=event.target.closest('button,a'); if(!target)return;
    if(target.matches('[data-route]')&&!event.ctrlKey&&!event.metaKey&&!event.shiftKey&&!event.altKey&&event.button===0){event.preventDefault();const isCard=target.classList.contains('card-link'),isBack=target.matches('.back,.detail-back');if(isCard)journey('action','card_open',{position:[...document.querySelectorAll('#cards .card-link')].indexOf(target)+1});else if(isBack)journey('action','back_to_list');navigate(target.dataset.backUrl || target.getAttribute('href'),{scroll:true,benefits:isCard,navigation:isBack?'back':'link'});}
    else if(target.dataset.save) saveFavorite(target.dataset.save);
    else if(target.hasAttribute('data-reset')) {journey('action','filter_reset');navigate(resetUrl(),{navigation:'reset'});}
    else if(target.hasAttribute('data-retry')) {journey('action','retry');load({navigation:'retry'});}
    else if(target.dataset.visualFilter) {
      const p=params(),name=target.dataset.visualFilter,value=target.dataset.value;
      journey('action','filter_change',{control:name});
      if(name==='include') {const chosen=selectedProducts(p);const next=chosen.includes(value)?chosen.filter(v=>v!==value):[...chosen,value];if(next.length)p.set(name,next.join(','));else p.delete(name);}
      else if(p.get(name)===value||!value)p.delete(name);else p.set(name,value);
      p.delete('page');navigate(searchUrl(p),{navigation:'filter'});
    }
    else if(target.dataset.quick) {const p=params(),[name,value]=target.dataset.quick.split(':');journey('action','filter_change',{control:name});p.set(name,value);p.delete('page');navigate(searchUrl(p),{navigation:'filter'});}
    else if(target.dataset.remove){journey('action','filter_change',{control:target.dataset.remove});const p=params();if(target.dataset.remove==='include'&&target.dataset.product){const next=selectedProducts(p).filter(value=>value!==target.dataset.product);if(next.length)p.set('include',next.join(','));else p.delete('include');}else p.delete(target.dataset.remove);p.delete('page');navigate(searchUrl(p),{navigation:'filter'});}
    else if(target.dataset.page){journey('action','pagination');const p=params();p.set('page',target.dataset.page);navigate(searchUrl(p),{navigation:'pagination'});$('.results').scrollIntoView({block:'start'});}
  });
  const mobile = matchMedia('(max-width:760px)');
  if(mobile.matches) $('#filter-panel').open=false;
  mobile.addEventListener('change',event=>{if(!event.matches)$('#filter-panel').open=true;});
  window.addEventListener('popstate',()=>load({navigation:'back'}));
  updateFavorites(); load();
})();
