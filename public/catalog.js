(() => {
  'use strict';
  const $ = selector => document.querySelector(selector);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const key = 'recipe-catalog-favorites-v1';
  let favorites = new Set(), controller, currentRecipe, noticeTimer;
  try { const stored = JSON.parse(localStorage.getItem(key)||'[]'); if(Array.isArray(stored)) favorites = new Set(stored.filter(id=>typeof id==='string' && /^[a-z0-9-]+$/.test(id)).slice(0,250)); } catch {}
  const filterNames = ['cuisine','category','time','include','exclude'];
  const params = () => new URLSearchParams(location.search);
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
  function navigate(url, {scroll=false}={}) { history.pushState({},'',url); load(); if(scroll) window.scrollTo({top:0}); }
  function searchUrl(p) { return '/recipes'+(p.size?'?'+p.toString():''); }
  async function request(url, signal) {
    const response=await fetch(url,{signal});
    if(!response.ok) throw new Error(response.status===404?'Рецепт не найден':response.status===429?'Слишком много запросов. Попробуйте через минуту.':'Не удалось загрузить рецепты. Проверьте соединение и повторите.');
    return response.json();
  }
  function options(name, values, selected) {
    const select=$(`#filters [name="${name}"]`);
    select.innerHTML=`<option value="">${name==='cuisine'?'Все кухни':'Все блюда'}</option>`+values.map(v=>`<option value="${escape(v.id)}">${escape(v.label)} (${v.count})</option>`).join('');
    if(selected && !values.some(v=>v.id===selected)) select.add(new Option('Неизвестный фильтр',selected));
    select.value=selected||'';
  }
  function card(recipe) {
    const media=recipe.image?`<img src="${escape(recipe.image)}" alt="${escape(recipe.title)}" loading="lazy" width="400" height="308">`:`<img src="/assets/catalog-photo-pending.svg" alt="Фотография блюда пока не добавлена" loading="lazy" width="400" height="308">`;
    return `<article class="card"><button class="card-save" data-save="${escape(recipe.id)}" aria-pressed="${favorites.has(recipe.id)}" aria-label="Избранное: ${escape(recipe.title)}">${favoriteText(recipe.id)}</button><a class="card-link" data-route href="/recipes/${escape(recipe.id)}${location.search}"><div class="card-media">${media}</div><h3>${escape(recipe.title)}</h3><div class="card-meta"><span>${recipe.minutes} мин</span><span>${recipe.ingredientCount} ингредиентов</span></div><p class="card-description">${escape(recipe.description)}</p></a></article>`;
  }
  function activeFilters(p, result) {
    const labels={q:'Поиск',cuisine:'Кухня',category:'Блюдо',time:'До, минут',include:'С продуктами',exclude:'Без продуктов',favorites:'Избранное'};
    $('#active-filters').innerHTML=Object.entries(labels).filter(([name])=>p.get(name)).map(([name,label])=>{
      const value=name==='favorites'?'в этом браузере':name==='cuisine'?result.cuisines.find(c=>c.id===p.get(name))?.label||p.get(name):name==='category'?result.categories.find(c=>c.id===p.get(name))?.label||p.get(name):p.get(name);
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
      options('cuisine',result.cuisines,p.get('cuisine')); options('category',result.categories,p.get('category'));
      $('#catalog-total').textContent=result.catalogTotal;
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
    document.title=recipe.title+' — Твои рецепты';
    $('#recipe-view').innerHTML=`<a class="back" data-route href="${escape(searchUrl(p))}">← К подборке рецептов</a><div class="recipe-heading"><div><p class="eyebrow">ИЗ КОЛЛЕКЦИИ «ТВОИ РЕЦЕПТЫ»</p><h1>${escape(recipe.title)}</h1><p class="lead">${escape(recipe.description)}</p><div class="recipe-meta"><span>${recipe.minutes} минут</span><span>${recipe.ingredients.length} ингредиентов</span><span>Базовый рецепт: ${recipe.servings} порц.</span></div><div class="recipe-actions"><button class="primary" data-save="${escape(recipe.id)}" aria-pressed="${favorites.has(recipe.id)}">${favoriteText(recipe.id)}</button><button id="share-recipe">Скопировать ссылку</button><button id="print-recipe">Распечатать</button></div></div>${recipe.image?`<div><img class="recipe-photo" src="${escape(recipe.image)}" alt="${escape(recipe.title)}"><p class="photo-note">${recipe.imageGenerated?'Изображение создано с помощью ИИ. Подача готового блюда может отличаться.':''}</p></div>`:'<div><img class="recipe-photo" src="/assets/catalog-photo-pending.svg" alt="Фотография блюда пока не добавлена"><p class="photo-note">Фотография блюда пока не добавлена.</p></div>'}</div><div class="recipe-body"><section><h2>Ингредиенты</h2><label class="servings-control">Количество порций<input id="servings" type="number" min="1" max="20" step="1" value="${recipe.servings}"></label><ul id="ingredients" class="ingredients"></ul><div id="nutrition" class="nutrition"></div></section><section><h2>Как приготовить</h2><p class="step-note">Количества в шагах указаны для базовых ${recipe.servings} порций. При пересчёте ориентируйтесь на список ингредиентов; время приготовления может измениться.</p><ol class="steps">${recipe.steps.map(step=>`<li><p>${escape(step)}</p></li>`).join('')}</ol></section></div>`;
    renderIngredients(recipe.servings);
    const n=recipe.nutrition;
    $('#nutrition').innerHTML=n?`<strong>Пищевая ценность на порцию</strong>${Math.round(n.calories)} ккал · Белки ${escape(n.protein)} г<br>Жиры ${escape(n.fat)} г · Углеводы ${escape(n.carbs)} г<br><span>Расчётные значения, зависят от продуктов.</span>`:'Пищевая ценность пока не рассчитана.';
    $('#servings').addEventListener('input',event=>{ const value=Number(event.target.value); if(Number.isInteger(value)&&value>=1&&value<=20) renderIngredients(value); });
    $('#servings').addEventListener('change',event=>{const value=Math.max(1,Math.min(20,Math.round(Number(event.target.value)||currentRecipe.servings)));event.target.value=value;renderIngredients(value);});
    $('#share-recipe').addEventListener('click',async()=>{const url=location.origin+'/recipes/'+recipe.id;try{await navigator.clipboard.writeText(url);notice('Ссылка на рецепт скопирована');window.RecipeAnalytics?.event('catalog_share','catalog');}catch{notice('Скопируйте адрес рецепта из строки браузера');}});
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
  $('#reset').addEventListener('click',()=>navigate('/recipes'));
  $('#saved-toggle').addEventListener('click',()=>{const p=new URLSearchParams();if(params().get('favorites')!=='1')p.set('favorites','1');navigate(searchUrl(p),{scroll:true});});
  document.addEventListener('click',event=>{
    const target=event.target.closest('button,a'); if(!target)return;
    if(target.matches('[data-route]')&&!event.ctrlKey&&!event.metaKey&&!event.shiftKey&&!event.altKey&&event.button===0){event.preventDefault();navigate(target.getAttribute('href'),{scroll:true});}
    else if(target.dataset.save) saveFavorite(target.dataset.save);
    else if(target.hasAttribute('data-reset')) navigate('/recipes');
    else if(target.hasAttribute('data-retry')) load();
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
