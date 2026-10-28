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
  const analyticsDetail = () => window.CatalogHandoff?.detail() || {};
  const resetUrl = () => { const p=params(); for(const name of ['q',...filterNames,'favorites','page','sort'])p.delete(name);return searchUrl(p); };
  const previousFilters=params();
  if(['asian','eastern','european','caucasian'].includes(previousFilters.get('cuisine'))) {
    previousFilters.delete('cuisine');
    history.replaceState({},'',location.pathname+(previousFilters.size?'?'+previousFilters.toString():''));
  }
  const visualMode = params().get('filters') !== 'classic';
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
    $('#cuisine-tiles').innerHTML=visible.map(c=>visualButton('cuisine',c.id,`<span class="tile-label">${escape(c.label)}<small>${c.count}</small></span>`,'class="cuisine-tile"')).join('');
    $('#cuisine-tiles').dataset.expanded='true';
    $('#all-cuisines').hidden=!other.length;
    $('#all-cuisines').textContent=expandedCuisines?'Свернуть':'Другие кухни';
    $('#all-cuisines').setAttribute('aria-expanded',String(expandedCuisines));
    $('#ingredient-chips').innerHTML=productGroups.map(([heading,products])=>`<section class="ingredient-group" aria-label="${escape(heading)}"><h3>${escape(heading)}</h3><div class="ingredient-grid">${products.map(([value,label,illustration])=>visualButton('include',value,`<img src="/assets/filters/ingredients-${newProductImages.has(illustration)?'v3':'v2'}/${illustration}.webp" alt="" width="160" height="128"><span>${label}</span>`,'class="ingredient-chip"')).join('')}</div></section>`).join('');
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
    $('#all-cuisines').addEventListener('click',()=>{expandedCuisines=!expandedCuisines;if(visualResult)renderVisualFilters(params(),visualResult);});
    $('#show-results').addEventListener('click',()=>{if(adEntry)$('#dinner-filters').open=false;$('.results').scrollIntoView({behavior:'smooth',block:'start'});});
    $('#more-filters').addEventListener('click',()=>{const panel=$('#visual-refinements');panel.hidden=!panel.hidden;$('#more-filters').setAttribute('aria-expanded',String(!panel.hidden));});
    $('#visual-reset').addEventListener('click',()=>navigate(resetUrl()));
    $('#visual-products').addEventListener('submit',event=>{event.preventDefault();const p=params();for(const name of ['include','exclude']){const value=$('#visual-'+name).value.trim();if(value)p.set(name,value);else p.delete(name);}p.delete('page');navigate(searchUrl(p));});
  }
  if(adEntry) {
    document.body.dataset.catalogEntry='dinner';
    $('.intro h1').innerHTML='Что приготовить <em>на ужин?</em>';
    const copy=document.createElement('p');copy.className='catalog-entry-copy';copy.textContent='Выберите блюдо и откройте полный рецепт. Все ингредиенты и шаги — сразу на сайте.';
    $('.intro h1').after(copy);
    $('.header a[aria-current]').href=searchUrl(params());
    $('.header .brand').href=searchUrl(params());
    if(visualMode) {
      const filters=document.createElement('details');filters.id='dinner-filters';filters.className='dinner-filters';
      filters.innerHTML='<summary>Кухни, продукты и время</summary>';
      $('#visual-discovery').before(filters);filters.append($('#visual-discovery'));
      $('.quick').innerHTML='<span>Быстрый выбор:</span><button data-quick="time:30">До 30 минут</button><button data-quick="cuisine:italian">Итальянская кухня</button><button data-quick="cuisine:georgian">Грузинская кухня</button><button data-quick="category:chicken">С курицей</button>';
      filters.before($('.quick'));
    }
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
  function navigate(url, {scroll=false, benefits=false}={}) { const target=new URL(url,location.origin);if(visualMode)target.searchParams.set('filters','visual');history.pushState({},'',target.pathname+target.search); load({benefits}); if(scroll) window.scrollTo({top:0}); }
  function searchUrl(p) { if(visualMode)p.set('filters','visual');if(window.CatalogHandoff?.context.campaign)p.set('campaign',window.CatalogHandoff.context.campaign);return routeBase+(p.size?'?'+p.toString():''); }
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
    return `<article class="card"><button class="card-save" data-save="${escape(recipe.id)}" aria-pressed="${favorites.has(recipe.id)}" aria-label="Избранное: ${escape(recipe.title)}">${favoriteText(recipe.id)}</button><a class="card-link" data-route href="${routeBase}/${escape(recipe.id)}${location.search}"><div class="card-media">${media}</div><h3>${escape(recipe.title)}</h3><div class="card-meta">${recipe.cuisineLabel?`<span class="card-cuisine">${escape(recipe.cuisineLabel)}</span>`:""}<span>${recipe.minutes} мин</span><span>${recipe.ingredientCount} ингредиентов</span></div><p class="card-description">${escape(recipe.description)}</p></a></article>`;
  }
  function activeFilters(p, result) {
    const labels={q:'Поиск',cuisine:'Кухня',category:'Блюдо',time:'До, минут',include:'С продуктами',exclude:'Без продуктов',favorites:'Избранное'};
    $('#active-filters').innerHTML=Object.entries(labels).filter(([name])=>p.get(name)).map(([name,label])=>{
      const value=name==='favorites'?'в этом браузере':name==='cuisine'?(result.cuisineChoices||result.cuisines).find(c=>c.id===p.get(name))?.label||p.get(name):name==='category'?result.categories.find(c=>c.id===p.get(name))?.label||p.get(name):p.get(name);
      return `<button data-remove="${name}" aria-label="Убрать фильтр ${escape(label)}">${escape(label)}: ${escape(value)} ×</button>`;
    }).join('');
  }
  async function load({benefits=false}={}) {
    const startedAt=Date.now();
    window.CatalogBenefits?.close({restoreFocus:false, observeRecipe:false});
    controller?.abort(); controller=new AbortController(); const signal=controller.signal;
    const p=params(), id=location.pathname.match(/^\/(?:recipes|dinner)\/([a-z0-9-]+)$/)?.[1];
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
        currentRecipe=recipe; renderRecipe(recipe,p);
        let observed=false;
        const observeRecipe=()=>{if(observed || signal.aborted || currentRecipe!==recipe)return;observed=true;try{window.RecipeAnalytics?.observe($('#recipe-view'),'catalog_open','catalog',{...analyticsDetail(),_started:startedAt});}catch{}};
        const opened=!adEntry && (benefits || previewBenefits) && window.CatalogBenefits?.open(recipe,{automatic:!previewBenefits,afterClose:observeRecipe});
        if (previewBenefits) pendingBenefitsPreview = null;
        if(!opened)observeRecipe();
      }
      catch(error) { if(error.name!=='AbortError') $('#recipe-view').innerHTML=`<a class="back" data-route href="${escape(searchUrl(p))}">← В каталог</a><div class="empty"><h1>${escape(error.message)}</h1><button data-retry>Повторить</button></div>`; }
      return;
    }
    document.title=adEntry?'Что приготовить на ужин — Твои рецепты':'Выбрать рецепт — Твои рецепты';
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
      window.RecipeAnalytics?.observe($('#cards'),'catalog_list','catalog',{...analyticsDetail(),results:result.recipes.length,_started:startedAt});
      if(p.get('q'))window.RecipeAnalytics?.event('catalog_search','catalog',{...analyticsDetail(),results:result.recipes.length});
      if(!result.recipes.length)window.RecipeAnalytics?.event('catalog_empty','catalog',analyticsDetail());
      const filters=filterNames.filter(k=>p.get(k)).length;
      if(filters)window.RecipeAnalytics?.event('catalog_filter','catalog',{...analyticsDetail(),filters});
      $('#cards').innerHTML=result.recipes.length?result.recipes.map(card).join(''):`<div class="empty"><h3>${p.get('favorites')==='1'&&!favorites.size?'Здесь будут любимые рецепты':'Подходящих рецептов пока нет'}</h3><p>${p.get('favorites')==='1'&&!favorites.size?'Нажмите «В избранное» на понравившейся карточке.':'Попробуйте убрать часть фильтров или увеличить время приготовления.'}</p><button data-reset>Показать все рецепты</button></div>`;
      $('#pagination').innerHTML=result.pages>1?`<button data-page="${result.page-1}" ${result.page===1?'disabled':''}>Назад</button><span>${result.page} из ${result.pages}</span><button data-page="${result.page+1}" ${result.page===result.pages?'disabled':''}>Далее</button>`:'';
    } catch(error) { if(error.name!=='AbortError') { $('#result-count').textContent='Каталог недоступен'; $('#pagination').innerHTML=''; $('#cards').innerHTML=`<div class="empty"><p>${escape(error.message)}</p><button data-retry>Повторить</button></div>`; } }
    finally { if(!signal.aborted) $('#cards').setAttribute('aria-busy','false'); }
  }
  function renderRecipe(recipe,p) {
    document.title=recipe.title+' — Твои рецепты';
    $('#recipe-view').innerHTML=`<a class="back" data-route href="${escape(searchUrl(p))}">← К подборке рецептов</a><div class="recipe-heading"><div><p class="eyebrow">ИЗ КОЛЛЕКЦИИ «ТВОИ РЕЦЕПТЫ»</p><h1>${escape(recipe.title)}</h1><p class="lead">${escape(recipe.description)}</p><div class="recipe-meta">${recipe.cuisineLabel?`<span>${escape(recipe.cuisineLabel)}</span>`:""}<span>${recipe.minutes} минут</span><span>${recipe.ingredients.length} ингредиентов</span><span>Базовый рецепт: ${recipe.servings} порц.</span></div><div class="recipe-actions"><button class="primary" data-save="${escape(recipe.id)}" aria-pressed="${favorites.has(recipe.id)}">${favoriteText(recipe.id)}</button><button id="share-recipe">Скопировать ссылку</button><button id="print-recipe">Распечатать</button></div></div>${recipe.image?`<div><img class="recipe-photo" src="${escape(recipe.image)}" alt="${escape(recipe.title)}"><p class="photo-note">${recipe.imageGenerated?'Изображение создано с помощью ИИ. Подача готового блюда может отличаться.':''}</p></div>`:'<div><img class="recipe-photo" src="/assets/catalog-photo-pending.svg" alt="Фотография блюда пока не добавлена"><p class="photo-note">Фотография блюда пока не добавлена.</p></div>'}</div><div class="recipe-body"><section><h2>Ингредиенты</h2><label class="servings-control">Количество порций<input id="servings" type="number" min="1" max="20" step="1" value="${recipe.servings}"></label><ul id="ingredients" class="ingredients"></ul><div id="nutrition" class="nutrition"></div></section><section><h2>Как приготовить</h2><p class="step-note">Количества в шагах указаны для базовых ${recipe.servings} порций. При пересчёте ориентируйтесь на список ингредиентов; время приготовления может измениться.</p><ol class="steps">${recipe.steps.map(step=>`<li><p>${escape(step)}</p></li>`).join('')}</ol></section></div>`;
    renderIngredients(recipe.servings);
    const saveSection=document.createElement('section');
    $('#recipe-view .recipe-body').after(saveSection);
    window.CatalogHandoff?.mount(saveSection,recipe);
    if(!adEntry) {
      const invitation=document.createElement('div');
      invitation.className='benefits-reopen';
      invitation.innerHTML='<p>Каждый день — по вашему вкусу.</p><button type="button" id="show-benefits">Возможности бота</button>';
      $('#recipe-view .recipe-body').before(invitation);
      $('#show-benefits').addEventListener('click',()=>window.CatalogBenefits?.open(recipe));
    }
    const n=recipe.nutrition;
    $('#nutrition').innerHTML=n?`<strong>Пищевая ценность на порцию</strong>${Math.round(n.calories)} ккал · Белки ${escape(n.protein)} г<br>Жиры ${escape(n.fat)} г · Углеводы ${escape(n.carbs)} г<br><span>Расчётные значения, зависят от продуктов.</span>`:'Пищевая ценность пока не рассчитана.';
    $('#servings').addEventListener('input',event=>{ const value=Number(event.target.value); if(Number.isInteger(value)&&value>=1&&value<=20) renderIngredients(value); });
    $('#servings').addEventListener('change',event=>{const value=Math.max(1,Math.min(20,Math.round(Number(event.target.value)||currentRecipe.servings)));event.target.value=value;renderIngredients(value);});
    $('#share-recipe').addEventListener('click',async()=>{const url=location.origin+routeBase+'/'+recipe.id;try{await navigator.clipboard.writeText(url);notice('Ссылка на рецепт скопирована');window.RecipeAnalytics?.event('catalog_share','catalog');}catch{notice('Скопируйте адрес рецепта из строки браузера');}});
    $('#print-recipe').addEventListener('click',()=>{window.RecipeAnalytics?.event('catalog_print','catalog');window.print();});
  }
  function renderIngredients(servings) {
    const checked=new Set([...document.querySelectorAll('#ingredients input:checked')].map(input=>input.value));
    $('#ingredients').innerHTML=currentRecipe.ingredients.map((item,i)=>`<li><label><input type="checkbox" value="${i}" ${checked.has(String(i))?'checked':''}><span>${escape(item.name)}</span></label><span class="amount">${new Intl.NumberFormat('ru',{maximumFractionDigits:1}).format(item.quantity*servings/currentRecipe.servings)} ${escape(item.unit)}</span></li>`).join('');
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
  $('#reset').addEventListener('click',()=>navigate(resetUrl()));
  $('#saved-toggle').addEventListener('click',()=>{const p=new URLSearchParams();if(params().get('favorites')!=='1')p.set('favorites','1');navigate(searchUrl(p),{scroll:true});});
  document.addEventListener('click',event=>{
    const target=event.target.closest('button,a'); if(!target)return;
    if(target.matches('[data-route]')&&!event.ctrlKey&&!event.metaKey&&!event.shiftKey&&!event.altKey&&event.button===0){event.preventDefault();navigate(target.getAttribute('href'),{scroll:true,benefits:target.classList.contains('card-link')});}
    else if(target.dataset.save) saveFavorite(target.dataset.save);
    else if(target.hasAttribute('data-reset')) navigate(resetUrl());
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
