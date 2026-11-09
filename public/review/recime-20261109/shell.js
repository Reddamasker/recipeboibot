/* Test-only workspace. Recipe auth, access and existing recipe flows stay in core.js. */
(() => {
  'use strict';
  const base='/review/recime-20261109/';
  const oldRender=render, oldCollection=collection, oldHome=home;
  const ui={section:'collection',tab:'books',folded:false,book:null,query:'',list:false,sort:false,week:0,catalog:null,catalogQuery:'',catalogFilter:null,catalogBusy:false,catalogError:'',catalogRevision:0,detailRevision:0};
  Object.assign(ui,{workspace:null,workspaceError:'',workspaceLoading:null,saving:false,uncertain:null,navigation:null,visibleOutcomes:[],toastObservation:null,dialog:null});
  const meals={breakfast:'Завтрак',lunch:'Обед',dinner:'Ужин',snack:'Перекус'};
  const featureFor=action=>action.startsWith('collections.')?'collections':action.startsWith('plan.')?'meal_plan':'groceries';
  const currentFeature=()=>({collection:'collections','meal-plan':'meal_plan',groceries:'groceries'})[ui.section];
  const analyticsStep=feature=>feature==='collections'?'collection':'other';
  const localDate=(date=new Date())=>`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
  const dateKey=date=>date.toISOString().slice(0,10);
  const recipeById=id=>state.recipes.find(recipe=>recipe.id===id);
  const readyRecipes=()=>state.recipes.filter(recipe=>recipe.status==='ready'&&!recipe.previewOnly);
  const validServings=value=>Number.isFinite(Number(value))&&Number(value)>0?Number(value):null;
  function flowFor(action){return {id:crypto.randomUUID(),action,feature:featureFor(action),opened:performance.now(),started:null,startedWall:null,done:false,payload:null};}
  function stopWorkspaceConfirmation(observation=ui.toastObservation){
    if(!observation)return;
    cancelAnimationFrame(observation.frame);clearTimeout(observation.timer);
    if(ui.toastObservation===observation)ui.toastObservation=null;
  }
  function workspaceToastVisible(message){
    if(document.visibilityState!=='visible'||!toastEl?.isConnected||!toastEl.classList.contains('show')||toastEl.textContent!==message||document.querySelector('dialog[open], .overlay'))return false;
    const rect=toastEl.getBoundingClientRect(),style=getComputedStyle(toastEl);
    return style.display!=='none'&&style.visibility==='visible'&&Number(style.opacity)>=.95&&rect.width>0&&rect.height>0&&Math.min(innerWidth,rect.right)>Math.max(0,rect.left)&&Math.min(innerHeight,rect.bottom)>Math.max(0,rect.top);
  }
  function showWorkspaceConfirmation(flow){
    if(flow.successObserved||flow.inlineConfirmation)return;
    stopWorkspaceConfirmation();ui.visibleOutcomes=[];
    if(document.visibilityState!=='visible'){ui.visibleOutcomes=[flow];return;}
    const message='Изменения сохранены';toast(message);
    const observation={flow,shownAt:Date.now(),frame:null,timer:null};ui.toastObservation=observation;
    const check=()=>{
      if(ui.toastObservation!==observation)return;
      if(document.visibilityState!=='visible'){ui.visibleOutcomes=[flow];stopWorkspaceConfirmation(observation);return;}
      if(Date.now()-observation.shownAt>=3500||!toastEl.classList.contains('show')||toastEl.textContent!==message){stopWorkspaceConfirmation(observation);return;}
      if(workspaceToastVisible(message)){
        flow.successObserved=true;stopWorkspaceConfirmation(observation);
        window.RecipeAnalytics?.event('workspace_action',analyticsStep(flow.feature),{feature:flow.feature,action:flow.action,outcome:'success',flowId:flow.id,durationMs:Math.min(86400000,Math.max(0,Math.round(Date.now()-(flow.startedWall??observation.shownAt))))});return;
      }
      observation.timer=setTimeout(()=>{observation.frame=requestAnimationFrame(check);},50);
    };
    observation.frame=requestAnimationFrame(check);
  }
  function actionEvent(flow,outcome){
    const detail={feature:flow.feature,action:flow.action,outcome,flowId:flow.id,durationMs:Math.min(86400000,Math.max(0,Math.round(performance.now()-(flow.started??flow.opened))))};
    if(outcome==='success'){
      showWorkspaceConfirmation(flow);return;
    }
    window.RecipeAnalytics?.event('workspace_action',analyticsStep(flow.feature),detail);
  }
  function observeWorkspace(){
    const feature=currentFeature();
    if(!feature||!ui.workspace||!root.classList.contains('review-shell'))return;
    if(!ui.navigation||ui.navigation.feature!==feature)ui.navigation={feature,id:crypto.randomUUID(),seen:false};
    const visit=ui.navigation;
    requestAnimationFrame(()=>{
      if(visit!==ui.navigation||visit.seen||document.hidden||!root.classList.contains('review-shell')||currentFeature()!==feature)return;
      const main=root.querySelector('main');
      if(!main||!window.RecipeAnalytics?.visible(main)||document.querySelector('dialog[open]'))return;
      visit.seen=true;
      window.RecipeAnalytics?.event('workspace_view',analyticsStep(feature),{feature,flowId:visit.id});
    });
  }
  document.addEventListener('visibilitychange',()=>{
    if(document.visibilityState!=='visible'){
      if(ui.toastObservation){ui.visibleOutcomes=[ui.toastObservation.flow];stopWorkspaceConfirmation();}
      return;
    }
    observeWorkspace();const pending=ui.visibleOutcomes.pop();ui.visibleOutcomes=[];if(pending)actionEvent(pending,'success');
  });
  async function workspaceRequest(body){
    let response;
    try{response=await fetch('/api/workspace',{method:body?'POST':'GET',headers:{authorization:window.RecipePlatform?.authHeader()||`tma ${tg?.initData||''}`,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000),cache:'no-store'});}
    catch(error){throw Object.assign(new Error('Не удалось связаться с сервером. Проверь подключение и повтори.'),{uncertain:Boolean(body),cause:error});}
    const value=await response.json().catch(()=>null);
    if(!response.ok)throw Object.assign(new Error(value?.error||'Не удалось выполнить действие'),{status:response.status,code:value?.code,currentVersion:value?.currentVersion,uncertain:Boolean(body)&&response.status>=500});
    if(!value||!Number.isInteger(value.version)||!Array.isArray(value.collections)||!Array.isArray(value.plan)||!Array.isArray(value.groceries?.items))throw Object.assign(new Error('Сервер вернул неполный ответ. Повтори запрос.'),{uncertain:Boolean(body)});
    return value;
  }
  function applyWorkspace(value){if(!ui.workspace||value.version>=ui.workspace.version)ui.workspace=value;ui.workspaceError='';}
  function redrawWorkspace(){if(!root.classList.contains('review-shell'))return;({collection:recipesPage,'meal-plan':planner,groceries,discover})[ui.section]?.();}
  async function ensureWorkspace(force=false){
    if(ui.workspaceLoading){if(!force)return ui.workspaceLoading;await ui.workspaceLoading.catch(()=>{});return ensureWorkspace(true);}
    if(ui.workspace&&!force)return ui.workspace;
    ui.workspaceLoading=(async()=>{try{const value=await workspaceRequest();applyWorkspace(value);return value;}catch(error){ui.workspaceError=error.message;throw error;}finally{ui.workspaceLoading=null;redrawWorkspace();}})();
    return ui.workspaceLoading;
  }
  function workspaceNotice(){
    if(ui.uncertain)return `<div class="r-workspace-notice" role="status">Сохранение пока не подтверждено. Повтори запрос: действие не добавится дважды.<button type="button" data-review="retry-workspace-operation" ${ui.saving?'disabled':''}>Повторить сохранение</button></div>`;
    if(ui.workspaceError)return `<div class="r-workspace-notice" role="alert">${esc(ui.workspaceError)}${ui.workspace?' Показаны последние загруженные данные.':''}<button type="button" data-review="reload-workspace">Попробовать ещё раз</button></div>`;
    return '';
  }
  function workspaceStarted(){if(!ui.workspace&&!ui.workspaceLoading&&!ui.workspaceError)void ensureWorkspace().catch(()=>{});observeWorkspace();}
  async function mutate(flow,fields){
    if(ui.saving)throw new Error('Дождись завершения предыдущего действия.');
    if(ui.uncertain&&ui.uncertain.id!==flow.id)throw new Error('Сначала повтори неподтверждённое сохранение.');
    if(!ui.workspace)await ensureWorkspace();
    if(!flow.payload)flow.payload={operationId:flow.id,expectedVersion:ui.workspace.version,action:flow.action,...fields};
    if(flow.started===null){flow.started=performance.now();flow.startedWall=Date.now();actionEvent(flow,'started');}
    ui.saving=true;root.setAttribute('aria-busy','true');
    try{
      const result=await workspaceRequest(flow.payload);applyWorkspace(result);ui.uncertain=null;flow.done=true;
      redrawWorkspace();requestAnimationFrame(()=>actionEvent(flow,'success'));return result;
    }catch(error){
      actionEvent(flow,'error');
      if(error.uncertain){ui.uncertain=flow;error.message='Связь прервалась. Сохранение могло пройти. Нажми «Повторить сохранение», чтобы получить результат без дубля.';}
      else {flow.payload=null;flow.failed=true;if(error.status===409){flow.conflict=true;await ensureWorkspace(true).catch(()=>{});error.message=error.code==='PLAN_SLOT_OCCUPIED'?'В одном из выбранных дней уже появилось блюдо. Закрой форму и составь план заново по обновлённым данным.':'Данные изменились на другом устройстве. Мы загрузили свежую версию. Закрой форму и открой её заново, чтобы проверить изменения.';}}
      redrawWorkspace();throw error;
    }finally{ui.saving=false;root.setAttribute('aria-busy','false');redrawWorkspace();}
  }
  async function canEdit(){
    if(ui.saving){toast('Сохраняем изменения…');return false;}
    if(ui.uncertain){toast('Сначала нажми «Повторить сохранение».');return false;}
    try{await ensureWorkspace();return true;}catch(error){toast(error.message);return false;}
  }
  function formDialog({title:heading,body,action,submit='Сохранить',read,after}){
    ui.dialog?.close();
    const dialog=document.createElement('dialog');dialog.className='r-review-dialog r-workspace-dialog';dialog.dataset.wsDialog=action;
    const id='ws-title-'+crypto.randomUUID();dialog.setAttribute('aria-labelledby',id);
    dialog.innerHTML=`<form data-ws-form><div class="r-dialog-head"><h2 id="${id}">${esc(heading)}</h2><button type="button" class="r-dialog-close" data-ws-close aria-label="Закрыть">${ico('plus')}</button></div><div class="r-dialog-body">${body}</div><p class="r-form-error" data-ws-error role="alert" tabindex="-1" hidden></p><div class="r-dialog-footer"><button type="button" class="r-secondary" data-ws-close>Отмена</button><button type="submit" data-ws-submit>${esc(submit)}</button></div></form>`;
    let flow=flowFor(action),busy=false;const opener=document.activeElement,cardReturn=ui.cardReturn;ui.dialog=dialog;document.body.append(dialog);
    const form=dialog.querySelector('form'),errorBox=dialog.querySelector('[data-ws-error]'),submitButton=dialog.querySelector('[data-ws-submit]');
    const lock=locked=>{for(const input of form.querySelectorAll('input,select,textarea'))input.disabled=locked||input.dataset.wsFixed==='true';};
    dialog.querySelectorAll('[data-ws-close]').forEach(button=>button.onclick=()=>{if(!busy)dialog.close();});
    dialog.addEventListener('cancel',event=>{if(busy)event.preventDefault();});
    dialog.addEventListener('close',()=>{if(!flow.done&&ui.uncertain?.id!==flow.id)actionEvent(flow,'cancelled');dialog.remove();if(ui.dialog===dialog)ui.dialog=null;if(opener?.isConnected)opener.focus({preventScroll:true});observeWorkspace();},{once:true});
    form.onsubmit=async event=>{
      event.preventDefault();if(busy||flow.conflict)return;
      if(flow.failed){flow=flowFor(action);flow.failed=false;}
      let fields;try{fields=flow.payload?null:read(form);}catch(error){errorBox.textContent=error.message;errorBox.hidden=false;errorBox.focus();return;}
      busy=true;form.setAttribute('aria-busy','true');submitButton.disabled=true;submitButton.textContent=flow.payload?'Повторяем…':'Сохраняем…';errorBox.hidden=true;lock(true);
      try{flow.inlineConfirmation=Boolean(cardReturn);await mutate(flow,fields);if(cardReturn)cardReturn.savedFlow=flow;dialog.close();after?.();}
      catch(error){errorBox.textContent=error.message;errorBox.hidden=false;errorBox.focus();}
      finally{busy=false;form.setAttribute('aria-busy','false');submitButton.disabled=Boolean(flow.conflict);submitButton.textContent=flow.conflict?'Открой форму заново':ui.uncertain?.id===flow.id?'Повторить сохранение':submit;lock(Boolean(flow.conflict)||ui.uncertain?.id===flow.id);}
    };
    dialog.showModal();dialog.querySelector('input:not(:disabled),select:not(:disabled),[data-ws-submit]')?.focus();
    return dialog;
  }
  function choiceDialog(heading,items){
    ui.dialog?.close();const dialog=document.createElement('dialog');dialog.className='r-review-dialog r-workspace-dialog';dialog.dataset.wsDialog='choices';const titleId='ws-choice-'+crypto.randomUUID();dialog.setAttribute('aria-labelledby',titleId);
    dialog.innerHTML=`<div class="r-dialog-head"><h2 id="${titleId}">${esc(heading)}</h2><button type="button" class="r-dialog-close" data-ws-close aria-label="Закрыть">${ico('plus')}</button></div><div class="r-choice-list">${items.map((item,index)=>`<button type="button" data-ws-choice="${index}" ${item.disabled?'disabled':''}>${esc(item.label)}</button>`).join('')}</div>`;
    const opener=document.activeElement;ui.dialog=dialog;document.body.append(dialog);
    dialog.querySelector('[data-ws-close]').onclick=()=>dialog.close();
    dialog.addEventListener('close',()=>{dialog.remove();if(ui.dialog===dialog)ui.dialog=null;if(opener?.isConnected)opener.focus({preventScroll:true});observeWorkspace();},{once:true});
    dialog.querySelectorAll('[data-ws-choice]').forEach(button=>button.onclick=()=>{const item=items[Number(button.dataset.wsChoice)];dialog.close();item.run();});
    dialog.showModal();return dialog;
  }
  function recipeOptions(selected){return readyRecipes().map(recipe=>`<option value="${esc(recipe.id)}" ${recipe.id===selected?'selected':''}>${esc(recipe.title)}</option>`).join('');}
  function choosePlanRecipe(){
    if(!readyRecipes().length)return catalogPicker('plan');
    return choiceDialog('Добавить блюдо',[{label:'Из моих рецептов',run:()=>planForm()},{label:'Из каталога',run:()=>catalogPicker('plan')}]);
  }
  function catalogPicker(destination='plan'){
    ui.dialog?.close();
    const multiple=destination==='auto',dialog=document.createElement('dialog');
    dialog.className='r-review-dialog r-workspace-dialog r-catalog-picker';dialog.dataset.wsDialog='catalog-picker';
    dialog.setAttribute('aria-label',multiple?'Выбрать рецепты для меню':'Выбрать рецепт');
    dialog.innerHTML=`<div class="r-dialog-head"><h2>${multiple?'Рецепты для меню':'Выбери рецепт'}</h2><button type="button" class="r-dialog-close" data-picker-close aria-label="Закрыть">${ico('plus')}</button></div><p class="r-field-hint">${multiple?'Выбери несколько блюд. Затем проверь дни и порции в меню.':'Сохрани блюдо из каталога, затем выбери дату или количество порций.'}</p><form data-picker-search><label class="r-field-label" for="ws-catalog-query">Поиск по каталогу</label><div class="r-picker-search"><input id="ws-catalog-query" type="search" maxlength="160" placeholder="Блюдо или продукт"><button type="submit">Найти</button></div></form><div data-picker-results aria-live="polite"></div><div class="r-picker-pages"><button type="button" data-picker-prev>Назад</button><span data-picker-page></span><button type="button" data-picker-next>Далее</button></div><div data-picker-saved aria-live="polite"></div><p class="r-form-error" data-picker-error role="alert" hidden></p><div class="r-dialog-footer"><button type="button" data-picker-save disabled>Сохранить рецепт</button></div>`;
    const selected=new Map(),flows=new Map(),initial=flowFor('collections.saveCatalog');initial.inlineConfirmation=true;
    let busy=false,page=1,pages=1,query='',revision=0,loaded=false,complete=false;
    const results=dialog.querySelector('[data-picker-results]'),errorBox=dialog.querySelector('[data-picker-error]'),save=dialog.querySelector('[data-picker-save]'),saved=dialog.querySelector('[data-picker-saved]');
    const continuation=destination==='auto'?'Составить меню':destination==='groceries'?'Добавить продукты':'Добавить в меню';
    const update=()=>{save.disabled=busy||!selected.size;save.textContent=complete?continuation:busy?'Сохраняем…':ui.uncertain&&[...flows.values()].some(flow=>flow.id===ui.uncertain.id)?'Повторить сохранение':multiple?`Сохранить выбранные (${selected.size})`:'Сохранить рецепт';dialog.querySelector('[data-picker-prev]').disabled=busy||page<=1;dialog.querySelector('[data-picker-next]').disabled=busy||page>=pages;};
    const search=async()=>{const rev=++revision;loaded=false;results.textContent='Загружаем рецепты…';errorBox.hidden=true;const flow=crypto.randomUUID();RecipeAnalytics?.event('step_submit','other',{flowId:flow});RecipeAnalytics?.requestStarted(flow,'other');try{const data=await api('/api/catalog?'+new URLSearchParams({q:query,page:String(page)}),{signal:AbortSignal.timeout(12000)});if(rev!==revision||!dialog.open)return;page=data.page;pages=data.pages;loaded=true;
      results.innerHTML=data.recipes.map(recipe=>`<label class="r-picker-recipe"><input type="${multiple?'checkbox':'radio'}" name="catalogRecipe" value="${esc(recipe.id)}" ${selected.has(recipe.id)?'checked':''}><img src="${safeImage(recipe.image)}" alt="" loading="lazy"><span><strong>${esc(recipe.title)}</strong><small>${recipe.minutes} мин · ${num(recipe.servings,['порция','порции','порций'])}</small></span></label>`).join('')||'<p class="r-field-hint">Ничего не найдено. Попробуй другое название или продукт.</p>';
      results.querySelectorAll('input').forEach(input=>input.onchange=()=>{if(busy||complete)return;if(!multiple)selected.clear();if(input.checked)selected.set(input.value,data.recipes.find(recipe=>recipe.id===input.value));else selected.delete(input.value);update();});dialog.querySelector('[data-picker-page]').textContent=`${page} из ${pages}`;update();RecipeAnalytics?.requestVisible(results,flow,false,'full');
    }catch(error){if(rev===revision&&dialog.open){results.textContent='';errorBox.textContent='Не удалось загрузить каталог. Нажми «Найти», чтобы повторить.';errorBox.hidden=false;update();}}};
    dialog.querySelector('[data-picker-search]').onsubmit=event=>{event.preventDefault();if(busy||complete)return;query=dialog.querySelector('#ws-catalog-query').value.trim();page=1;void search();};
    for(const [selector,delta] of [['[data-picker-prev]',-1],['[data-picker-next]',1]])dialog.querySelector(selector).onclick=()=>{if(!busy&&!complete){page+=delta;void search();}};
    const close=()=>{if(!busy)dialog.close();};dialog.querySelector('[data-picker-close]').onclick=close;dialog.addEventListener('cancel',event=>{if(busy)event.preventDefault();});
    dialog.addEventListener('close',()=>{revision++;if(!initial.done&&!initial.started)actionEvent(initial,'cancelled');for(const flow of flows.values())if(!flow.done&&ui.uncertain?.id!==flow.id)actionEvent(flow,'cancelled');dialog.remove();if(ui.dialog===dialog)ui.dialog=null;observeWorkspace();},{once:true});
    save.onclick=async()=>{
      if(busy||!selected.size)return;
      if(complete){const ids=[...flows.values()].map(flow=>flow.savedRecipeId);dialog.close();if(destination==='auto')autoPlan();else if(destination==='groceries')groceriesFromRecipe(ids[0]);else planForm(null,ids[0]);return;}
      busy=true;update();errorBox.hidden=true;dialog.querySelectorAll('input,form button,.r-picker-pages button').forEach(el=>el.disabled=true);
      try{for(const [catalogId,recipe] of selected){let flow=flows.get(catalogId);if(!flow){flow=flows.size?flowFor('collections.saveCatalog'):initial;flow.inlineConfirmation=true;flows.set(catalogId,flow);}if(flow.done)continue;if(flow.failed){flow=flowFor('collections.saveCatalog');flow.inlineConfirmation=true;flows.set(catalogId,flow);}const result=await mutate(flow,{catalogId});flow.savedRecipeId=result.operation.result.recipeId;const confirmation=document.createElement('p');confirmation.className='r-picker-confirmation';confirmation.textContent='Сохранено: '+recipe.title;saved.append(confirmation);RecipeAnalytics?.observe(confirmation,'workspace_action','collection',{feature:'collections',action:'collections.saveCatalog',outcome:'success',flowId:flow.id,_started:flow.startedWall});}
        await refresh();redrawWorkspace();complete=true;dialog.querySelector('[data-picker-search]').hidden=true;results.hidden=true;dialog.querySelector('.r-picker-pages').hidden=true;saved.scrollIntoView({block:'nearest'});
      }catch(error){errorBox.textContent=error.message;errorBox.hidden=false;errorBox.scrollIntoView({block:'nearest'});if([...flows.values()].some(flow=>flow.done))await refresh().then(redrawWorkspace).catch(()=>{});}finally{busy=false;update();if(!ui.uncertain&&!flows.size)dialog.querySelectorAll('input,form button').forEach(el=>el.disabled=false);}
    };
    ui.dialog=dialog;document.body.append(dialog);dialog.showModal();void search();return dialog;
  }
  async function saveCatalogHere(catalogId,trigger){
    if(!await canEdit())return;
    const flow=flowFor('collections.saveCatalog');if(trigger)trigger.disabled=true;
    try{await mutate(flow,{catalogId});await refresh();closeOverlay();redrawWorkspace();actionEvent(flow,'success');}
    catch(error){toast(error.message);}finally{if(trigger?.isConnected)trigger.disabled=false;}
  }
  function servingInput(recipe,servings=null){const baseCount=validServings(recipe?.servings);return `<label class="r-field-label" for="ws-servings">Порции</label><input id="ws-servings" name="servings" type="number" min="1" max="100" step="1" value="${baseCount?(validServings(servings)||baseCount):''}" ${baseCount?'required':'disabled data-ws-fixed="true"'}><p class="r-field-hint" data-ws-servings-hint>${baseCount?'Количество ингредиентов будет пересчитано для списка покупок.':'Порции в рецепте не указаны. Используем исходные количества без пересчёта.'}</p>`;}
  function bindRecipeServings(dialog){const picker=dialog.querySelector('[name=recipeId]'),input=dialog.querySelector('[name=servings]'),hint=dialog.querySelector('[data-ws-servings-hint]');picker?.addEventListener('change',()=>{const amount=validServings(recipeById(picker.value)?.servings);input.value=amount||'';input.disabled=!amount;input.required=Boolean(amount);input.dataset.wsFixed=amount?'false':'true';hint.textContent=amount?'Количество ингредиентов будет пересчитано для списка покупок.':'Порции в рецепте не указаны. Используем исходные количества без пересчёта.';});}
  function readServings(form){const field=form.querySelector('[name=servings]');return field?.dataset.wsFixed==='true'?null:(field?.value?Number(field.value):null);}
  function recipeChecklist(selected=[]){const set=new Set(selected);return `<div class="r-recipe-checklist">${readyRecipes().map(recipe=>`<label class="r-check-row"><input type="checkbox" name="recipeIds" value="${esc(recipe.id)}" ${set.has(recipe.id)?'checked':''}><span>${esc(recipe.title)}</span></label>`).join('')||'<p class="r-field-hint">Пока нет готовых рецептов. Их можно добавить позже.</p>'}</div>`;}
  function collectionForm(book=null,selectedRecipeIds=[]){return formDialog({title:book?'Переименовать подборку':'Новая подборка',action:book?'collections.rename':'collections.create',body:`<label class="r-field-label" for="ws-collection-name">Название</label><input id="ws-collection-name" name="name" maxlength="80" required value="${esc(book?.name||'')}" placeholder="Например, быстрые ужины">${book?'':`<p class="r-field-label">Добавить рецепты</p>${recipeChecklist(selectedRecipeIds)}`}`,read:form=>({...(book?{collectionId:book.id}:{}),name:form.querySelector('[name=name]').value.trim(),...(!book?{recipeIds:[...form.querySelectorAll('[name=recipeIds]:checked')].map(input=>input.value)}:{})}),after:()=>recipesPage()});}
  function manageCollection(book){choiceDialog(book.name,[{label:'Переименовать',run:()=>collectionForm(book)},{label:'Выбрать рецепты',run:()=>formDialog({title:'Рецепты в подборке',action:'collections.setRecipes',body:recipeChecklist(book.recipeIds),read:form=>({collectionId:book.id,recipeIds:[...form.querySelectorAll('[name=recipeIds]:checked')].map(input=>input.value)})})},{label:'Удалить подборку',run:()=>formDialog({title:'Удалить подборку?',action:'collections.delete',submit:'Удалить подборку',body:`<p>Подборка «${esc(book.name)}» будет удалена. Сами рецепты останутся в коллекции.</p>`,read:()=>({collectionId:book.id}),after:()=>{ui.book=null;recipesPage();}})}]);}
  function recipeMemberships(recipe){
    if(!ui.workspace.collections.length){collectionForm(null,[recipe.id]);return;}
    choiceDialog('Добавить в подборку',ui.workspace.collections.map(book=>({label:`${book.name}${book.recipeIds.includes(recipe.id)?' — уже добавлен':''}`,run:()=>formDialog({title:book.name,action:'collections.setRecipes',submit:book.recipeIds.includes(recipe.id)?'Убрать из подборки':'Добавить в подборку',body:`<p>${esc(recipe.title)}</p><p class="r-field-hint">Рецепт может находиться в нескольких подборках.</p>`,read:()=>({collectionId:book.id,recipeIds:book.recipeIds.includes(recipe.id)?book.recipeIds.filter(id=>id!==recipe.id):[...book.recipeIds,recipe.id]})})})));
  }
  function planForm(entry=null,selected=null){
    const recipes=readyRecipes();if(!recipes.length)return catalogPicker('plan');
    const recipe=recipes.find(recipe=>recipe.id===(selected||entry?.recipeId))||recipes[0];
    const dialog=formDialog({title:entry?'Изменить блюдо в меню':'Добавить в меню',action:entry?'plan.update':'plan.add',body:`<label class="r-field-label" for="ws-plan-recipe">Рецепт</label><select id="ws-plan-recipe" name="recipeId">${recipeOptions(recipe.id)}</select><div class="r-field-pair"><div><label class="r-field-label" for="ws-plan-date">Дата</label><input id="ws-plan-date" name="date" type="date" required value="${esc(entry?.date||(ui.week===0?localDate():dateKey(dayList()[0])))}"></div><div><label class="r-field-label" for="ws-plan-meal">Приём пищи</label><select id="ws-plan-meal" name="meal">${Object.entries(meals).map(([key,label])=>`<option value="${key}" ${key===(entry?.meal||'dinner')?'selected':''}>${label}</option>`).join('')}</select></div></div>${servingInput(recipe,entry?.servings)}`,read:form=>({...(entry?{entryId:entry.id}:{}),recipeId:form.querySelector('[name=recipeId]').value,date:form.querySelector('[name=date]').value,meal:form.querySelector('[name=meal]').value,servings:readServings(form)})});bindRecipeServings(dialog);return dialog;
  }
  function plannedEntries(){const dates=new Set(dayList().map(dateKey));return ui.workspace?.plan.filter(entry=>dates.has(entry.date))||[];}
  function autoPlan(){
    const recipes=readyRecipes();if(!recipes.length)return catalogPicker('auto');
    const slots=dayList().map(dateKey).filter(date=>!ui.workspace.plan.some(entry=>entry.date===date&&entry.meal==='dinner'));
    if(!slots.length){note('Ужины уже запланированы','На этой неделе нет свободных ужинов. Можно изменить отдельное блюдо или выбрать другую неделю.');return;}
    const used=new Set(plannedEntries().map(entry=>entry.recipeId)),ordered=[...recipes.filter(recipe=>!used.has(recipe.id)),...recipes.filter(recipe=>used.has(recipe.id))];
    const body=`<p class="r-field-hint">Выбери ужины для свободных дней. Это подбор из твоей коллекции; существующее меню останется на месте.</p><div class="r-auto-plan">${slots.map((date,index)=>{const recipe=ordered[index%ordered.length];const amount=validServings(recipe.servings);return `<section class="r-auto-entry" data-ws-auto-date="${date}"><label class="r-check-row"><input type="checkbox" name="enabled" ${index<3?'checked':''}><strong>${esc(new Date(date+'T12:00:00').toLocaleDateString('ru-RU',{weekday:'short',day:'numeric',month:'short'}))}</strong></label><label class="r-field-label" for="ws-auto-recipe-${index}">Рецепт</label><select id="ws-auto-recipe-${index}" name="autoRecipe">${recipeOptions(recipe.id)}</select><label class="r-field-label" for="ws-auto-servings-${index}">Порции</label><input id="ws-auto-servings-${index}" name="autoServings" type="number" min="1" max="100" step="1" value="${amount||''}" ${amount?'':'disabled data-ws-fixed="true"'}><span class="r-field-hint" data-auto-hint>${amount?'':'Порции не указаны; используем исходные количества.'}</span></section>`;}).join('')}</div>`;
    const dialog=formDialog({title:'Составить из моих рецептов',action:'plan.apply',submit:'Добавить выбранные ужины',body,read:form=>{const entries=[...form.querySelectorAll('[data-ws-auto-date]')].filter(row=>row.querySelector('[name=enabled]').checked).map(row=>({date:row.dataset.wsAutoDate,meal:'dinner',recipeId:row.querySelector('[name=autoRecipe]').value,servings:row.querySelector('[name=autoServings]').dataset.wsFixed==='true'?null:Number(row.querySelector('[name=autoServings]').value)}));if(!entries.length)throw new Error('Выбери хотя бы один день.');return {entries};}});
    dialog.querySelectorAll('[name=autoRecipe]').forEach(select=>select.onchange=()=>{const row=select.closest('[data-ws-auto-date]'),input=row.querySelector('[name=autoServings]'),amount=validServings(recipeById(select.value)?.servings);input.value=amount||'';input.disabled=!amount;input.dataset.wsFixed=amount?'false':'true';row.querySelector('[data-auto-hint]').textContent=amount?'':'Порции не указаны; используем исходные количества.';});
    return dialog;
  }
  function manualGrocery(item=null){
    const dialog=formDialog({title:item?'Изменить продукт':'Добавить продукт',action:item?'groceries.updateManual':'groceries.addManual',body:'<label class="r-field-label" for="ws-item-name">Продукт</label><input id="ws-item-name" name="name" required maxlength="120" value="'+esc(item?.name||'')+'" placeholder="Например, молоко"><div class="r-field-pair"><div><label class="r-field-label" for="ws-item-quantity">Количество</label><input id="ws-item-quantity" name="quantity" type="number" min="0.01" max="100000" step="any" value="'+(item?.quantity??'')+'" placeholder="Не обязательно"></div><div><label class="r-field-label" for="ws-item-unit">Единица</label><input id="ws-item-unit" name="unit" maxlength="30" value="'+esc(item?.unit||'')+'" placeholder="л, г, шт."></div></div><label class="r-field-label" for="ws-item-note">Количество словами, если нет числа</label><input id="ws-item-note" name="amountText" maxlength="100" value="'+esc(item?.amountText||'')+'" placeholder="Например, одна упаковка" '+(item?.quantity!=null?'disabled data-ws-fixed="true"':'')+'>',read:form=>{const numeric=form.querySelector('[name=quantity]').value;return {...(item?{itemId:item.id}:{}),name:form.querySelector('[name=name]').value.trim(),quantity:numeric?Number(numeric):null,unit:form.querySelector('[name=unit]').value.trim(),amountText:numeric?'':form.querySelector('[name=amountText]').value.trim()};}});
    dialog.querySelector('[name=quantity]').oninput=event=>{const text=dialog.querySelector('[name=amountText]');text.disabled=Boolean(event.target.value);text.dataset.wsFixed=text.disabled?'true':'false';};
  }
  function groceriesFromRecipe(selected=null){const recipes=readyRecipes();if(!recipes.length)return catalogPicker('groceries');const recipe=recipes.find(recipe=>recipe.id===selected)||recipes[0];const dialog=formDialog({title:'Продукты для рецепта',action:'groceries.fromRecipe',submit:'Добавить продукты',body:`<label class="r-field-label" for="ws-shopping-recipe">Рецепт</label><select id="ws-shopping-recipe" name="recipeId">${recipeOptions(recipe.id)}</select>${servingInput(recipe)}<p class="r-field-hint">Повторное добавление обновит продукты этого рецепта, не создавая второй экземпляр.</p>`,read:form=>({recipeId:form.querySelector('[name=recipeId]').value,servings:readServings(form)})});bindRecipeServings(dialog);}
  function groceriesFromPlan(){const entries=plannedEntries();if(!entries.length){choiceDialog('Сначала выбери блюдо',[{label:'Добавить продукты из каталога',run:()=>catalogPicker('groceries')},{label:'Добавить блюдо в меню',run:()=>{setRoute({view:'meal-plan'});planner();choosePlanRecipe();}}]);return;}formDialog({title:'Продукты из меню',action:'groceries.fromPlan',submit:'Добавить продукты',body:`<p class="r-field-hint">Выбери блюда выбранной недели. Ручные позиции в покупках сохранятся.</p><div class="r-recipe-checklist">${entries.map(entry=>`<label class="r-check-row"><input type="checkbox" name="entryIds" value="${esc(entry.id)}" ${entry.recipeAvailable?'checked':'disabled data-ws-fixed="true"'}><span>${esc(entry.date)} · ${esc(meals[entry.meal])}<strong>${esc(entry.recipe?.title||'Рецепт недоступен')}</strong></span></label>`).join('')}</div>`,read:form=>{const entryIds=[...form.querySelectorAll('[name=entryIds]:checked')].map(input=>input.value);if(!entryIds.length)throw new Error('Выбери хотя бы одно доступное блюдо.');return {entryIds};}});}
  function shoppingChoices(){choiceDialog('Добавить продукты',[{label:'Ввести вручную',run:()=>manualGrocery()},{label:'Из сохранённого рецепта',run:()=>groceriesFromRecipe()},{label:'Из каталога',run:()=>catalogPicker('groceries')},{label:'Из меню на эту неделю',run:()=>groceriesFromPlan()}]);}
  function recipeChoices(recipe){choiceDialog(recipe.title,[{label:'Открыть рецепт',run:()=>openRecipe(recipe.id,true)},{label:'Подборки рецепта',disabled:recipe.status!=='ready'||recipe.previewOnly===true,run:()=>recipeMemberships(recipe)},{label:'Добавить в меню',disabled:recipe.status!=='ready'||recipe.previewOnly===true,run:()=>planForm(null,recipe.id)},{label:'Добавить продукты в покупки',disabled:recipe.status!=='ready'||recipe.previewOnly===true,run:()=>groceriesFromRecipe(recipe.id)}]);}
  function sourceChoices(){
    const sources=ui.workspace?.groceries.sources||[];
    if(!sources.length){note('Источники продуктов','Сейчас в списке только продукты, добавленные вручную.');return;}
    choiceDialog('Источники продуктов',sources.map(source=>({label:source.title+(source.stale?' — рецепт изменён':'')+(source.excludedCount?' · есть исключённые продукты':''),run:()=>choiceDialog(source.title,[...(source.excludedCount&&source.recipeAvailable?[{label:'Вернуть убранные продукты',run:()=>formDialog({title:'Вернуть убранные продукты?',action:source.kind==='plan'?'groceries.fromPlan':'groceries.fromRecipe',submit:'Вернуть продукты',body:'<p>Ингредиенты этого блюда снова появятся в покупках с текущими количествами. Ручные позиции и другие блюда сохранятся.</p>',read:()=>source.kind==='plan'?{entryIds:[source.planEntryId],restoreExcluded:true}:{recipeId:source.recipeId,servings:source.servings,restoreExcluded:true}})}]:[]),{label:source.stale?'Обновить изменившийся рецепт':'Обновить продукты',disabled:!source.recipeAvailable,run:()=>formDialog({title:'Обновить продукты?',action:source.kind==='plan'?'groceries.fromPlan':'groceries.fromRecipe',submit:'Обновить',body:'<p>Количество продуктов будет пересчитано. Изменившиеся позиции потребуется отметить купленными заново. Ручные строки сохранятся.</p>',read:()=>source.kind==='plan'?{entryIds:[source.planEntryId]}:{recipeId:source.recipeId,servings:source.servings}})},{label:'Убрать продукты этого блюда',run:()=>formDialog({title:'Убрать источник?',action:'groceries.removeSource',submit:'Убрать продукты',body:`<p>${esc(source.title)}</p><p class="r-field-hint">Продукты других блюд и ручные строки сохранятся.</p>`,read:()=>({sourceId:source.id})})}])})));
  }
  function itemChoices(item){choiceDialog(item.name,[...(item.manual?[{label:'Изменить продукт',run:()=>manualGrocery(item)}]:[]),{label:'Убрать из списка',run:()=>formDialog({title:'Убрать продукт?',action:'groceries.removeItem',submit:'Убрать',body:`<p>${esc(item.name)}</p>${item.manual?'':'<p class="r-field-hint">Продукт будет исключён из текущих источников списка.</p>'}`,read:()=>({itemId:item.id})})}]);}
  const paths={
    bookmark:'<path d="M6 3h12v18l-6-4-6 4z"/>',
    calendar:'<rect x="3" y="5" width="18" height="17" rx="2"/><path d="M7 2v6m10-6v6M3 11h18"/>',
    basket:'<path d="m7 8 3-5m7 5-3-5M2 9h20M4 10l2 10h12l2-10M9 12v5m6-5v5"/>',
    compass:'<circle cx="12" cy="12" r="9"/><path class="r-needle" d="m16 8-2.5 5.5L8 16l2.5-5.5Z"/>',
    user:'<circle cx="12" cy="7" r="4"/><path d="M4 22v-2c0-4 3.5-6 8-6s8 2 8 6v2Z"/>',
    chevron:'<path d="m9 5 7 7-7 7"/>',left:'<path d="m15 5-7 7 7 7"/>',up:'<path d="m7 14 5-5 5 5"/>',down:'<path d="m7 10 5 5 5-5"/>',
    check:'<path d="m5 12 4 4L19 6"/>',clock:'<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 3"/>',
    book:'<rect x="6" y="3" width="13" height="17" rx="1"/><path d="M9 3v13h7M3 6v17h13"/>',
    search:'<circle cx="10" cy="10" r="7"/><path d="m15 15 6 6"/>',
    sort:'<path d="M7 3v18m-4-14 4-4 4 4M17 21V3m-4 14 4 4 4-4"/>',
    list:'<path d="M3 4h4v4H3Zm0 8h4v4H3Zm0 8h4v2H3ZM11 5h10M11 13h10M11 21h10"/>',
    grid:'<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
    plus:'<path d="M12 4v16M4 12h16"/>',
    settings:'<path d="M3 5h5m4 0h9M3 12h10m4 0h4M3 19h3m4 0h11"/><rect x="8" y="3" width="4" height="4" rx="1"/><rect x="13" y="10" width="4" height="4" rx="1"/><rect x="6" y="17" width="4" height="4" rx="1"/>',
    magic:'<path d="M7 2v5m10-5v5M3 10h18M12 21H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v6m-2 2 1.4 3.6L24 19l-3.6 1.4L19 24l-1.4-3.6L14 19l3.6-1.4Z"/>',
    share:'<path d="M8 8H5v13h14V8h-3M12 15V2m-4 4 4-4 4 4"/>'
  };
  const ico=(n)=>`<svg class="r-icon r-i-${n}" viewBox="0 0 24 24" aria-hidden="true">${paths[n]||paths.plus}</svg>`;
  const num=(n,forms)=>`${n} ${forms[n%100>=11&&n%100<=14?2:n%10===1?0:n%10>=2&&n%10<=4?1:2]}`;
  const button=(action,label,name,cls='r-action',extra='')=>`<button type="button" class="${cls}" data-review="${action}" ${extra}>${name?ico(name):''}<span>${esc(label)}</span>${cls.includes('r-action')?ico('chevron'):''}</button>`;
  function dayList(){const now=new Date(),date=new Date(Date.UTC(now.getFullYear(),now.getMonth(),now.getDate()));const weekday=(date.getUTCDay()+6)%7;date.setUTCDate(date.getUTCDate()-weekday+ui.week*7);return Array.from({length:7},(_,i)=>new Date(date.getTime()+i*86400000));}
  function navigation(){return `<nav class="r-nav" aria-label="Разделы приложения">${[['collection','Рецепты','bookmark'],['meal-plan','Меню','calendar'],['groceries','Покупки','basket'],['discover','Подобрать','compass']].map(([v,t,i])=>`<button type="button" data-review-view="${v}" aria-current="${ui.section===v?'page':'false'}">${ico(i)}<span>${t}</span></button>`).join('')}</nav>`;}
  function setMarkup(content,step='other'){root.classList.add('review-shell');root.dataset.analyticsStep=step;root.innerHTML=content+navigation();window.__miniRendered=true;}
  function title(text,action=null,cls=''){return `<header class="r-header ${cls}"><h1>${text}</h1>${action?button(action,'Настройки','settings','r-round','aria-label="Настройки"'):''}</header>`;}
  function searchField(id,value,placeholder){return `<label class="r-search">${ico('search')}<input id="${id}" type="search" value="${esc(value)}" placeholder="${placeholder}" aria-label="${placeholder}" autocomplete="off"></label>`;}
  function books(){
    if(!ui.workspace)return [];
    const assigned=new Set(ui.workspace.collections.flatMap(book=>book.recipeIds));
    return [{name:'Без подборки',key:'__none',recipes:state.recipes.filter(recipe=>!assigned.has(recipe.id))},...ui.workspace.collections.map(book=>({...book,key:book.id,recipes:state.recipes.filter(recipe=>book.recipeIds.includes(recipe.id))}))];
  }
  function mosaic(recipes){return `<div class="r-mosaic">${Array.from({length:3},(_,i)=>{const image=safeImage(recipes[i]?.thumbnailUrl);return image?`<img src="${image}" alt="" loading="eager" referrerpolicy="no-referrer">`:'<span></span>'}).join('')}</div>`;}
  function libraryItems(){
    let all=state.recipes;const query=ui.query.toLocaleLowerCase('ru');
    if(ui.tab==='books'&&!ui.book&&!query){
      if(!ui.workspace)return '<p class="r-empty-library">'+(ui.workspaceError?'Подборки пока недоступны. Все рецепты можно открыть в соседней вкладке.':'Загружаем подборки…')+'</p>';
      let list=books().filter(book=>book.name.toLocaleLowerCase('ru').includes(query));
      if(ui.sort)list.sort((a,b)=>a.name.localeCompare(b.name,'ru'));
      return list.map(book=>'<button class="r-book" data-review="book" data-book="'+esc(book.key)+'">'+mosaic(book.recipes)+'<span><strong>'+esc(book.name)+'</strong><small>'+num(book.recipes.length,['рецепт','рецепта','рецептов'])+'</small></span></button>').join('')+(!query?'<button class="r-book" data-review="new-book">'+mosaic([])+'<span><strong>Новая подборка</strong><small>Создать подборку</small></span></button>':'');
    }
    if(ui.book)all=books().find(book=>book.key===ui.book)?.recipes||[];
    all=all.filter(recipe=>(recipe.title+' '+(recipe.tags||[]).join(' ')+' '+(recipe.ingredients||[]).map(item=>item.name||item.raw||'').join(' ')).toLocaleLowerCase('ru').includes(query));
    if(ui.sort)all=all.slice().sort((a,b)=>a.title.localeCompare(b.title,'ru'));
    all=all.slice().sort((a,b)=>Number(Boolean(ui.workspace?.recipeCards?.[b.id]?.pinned))-Number(Boolean(ui.workspace?.recipeCards?.[a.id]?.pinned)));
    return all.map(recipe=>'<article class="r-recipe-tile"><button class="r-book" data-review="recipe" data-recipe-id="'+esc(recipe.id)+'">'+(safeImage(recipe.thumbnailUrl)?'<img class="r-recipe-cover" src="'+safeImage(recipe.thumbnailUrl)+'" alt="" loading="lazy" referrerpolicy="no-referrer">':'<span class="r-recipe-cover"></span>')+'<span><strong>'+esc(recipe.title)+'</strong><small>'+esc(recipe.status==='draft'?'Черновик':cookingTimeLabel(recipe))+'</small></span></button><button type="button" class="r-card-more" data-review="recipe-actions" data-recipe-id="'+esc(recipe.id)+'" aria-label="Действия с рецептом '+esc(recipe.title)+'">'+ico('settings')+'</button></article>').join('')||'<p class="r-empty-library">'+(query?'Ничего не найдено':'В этой подборке пока нет рецептов')+'</p>';
  }
  function recipesPage(){
    ui.section='collection';const book=books().find(item=>item.key===ui.book);
    setMarkup('<header class="r-header"><button class="r-logo" data-review-view="collection" aria-label="Твои рецепты">Рецепты</button>'+button('profile','Профиль','user','r-round r-profile','aria-label="Профиль"')+'</header><section class="r-welcome '+(ui.folded?'is-folded':'')+'"><button class="r-plain r-fold" data-review="fold" aria-label="'+(ui.folded?'Развернуть':'Свернуть')+' подсказки" aria-expanded="'+!ui.folded+'">'+ico(ui.folded?'down':'up')+'</button>'+(ui.folded?'<h2>Давай готовить!</h2>':'<p class="r-script">Добро пожаловать</p><h2>Давай готовить!</h2><div class="r-tasks"><button class="r-task '+(state.recipes.length?'r-done':'')+'" data-review="import"><span class="r-task-icon">'+ico(state.recipes.length?'check':'plus')+'</span><span>Добавить первый рецепт</span></button><button class="r-task" data-review="quick"><span class="r-task-icon">'+ico('clock')+'</span><span>Добавляй рецепты быстрее</span>'+ico('chevron')+'</button><button class="r-task '+(ui.workspace?.collections.length?'r-done':'')+'" data-review="new-book"><span class="r-task-icon">'+ico(ui.workspace?.collections.length?'check':'book')+'</span><span>Создай свою подборку</span>'+ico('chevron')+'</button></div>')+'</section><div class="r-librarytabs" role="tablist" aria-label="Личная коллекция"><button role="tab" aria-selected="'+(ui.tab==='books')+'" data-review="tab" data-tab="books">Подборки</button><button role="tab" aria-selected="'+(ui.tab==='all')+'" data-review="tab" data-tab="all">Все рецепты</button></div><main class="r-library">'+workspaceNotice()+(ui.book?'<div class="r-breadcrumb"><button class="r-plain" data-review="all-books" aria-label="Все подборки">'+ico('left')+'</button><span>'+esc(book?.name||'Подборка недоступна')+'</span>'+(book?.id?'<button class="r-plain" data-review="manage-book" aria-label="Изменить подборку">'+ico('settings')+'</button>':'')+'</div>':'')+'<div class="r-searchbar">'+searchField('r-library-search',ui.query,'Найти рецепт')+'<div class="r-search-tools"><button class="r-plain" data-review="sort" aria-label="Сортировать по названию" aria-pressed="'+ui.sort+'">'+ico('sort')+'</button><button class="r-plain" data-review="layout" aria-label="'+(ui.list?'Показать плиткой':'Показать списком')+'">'+ico(ui.list?'grid':'list')+'</button></div></div>'+(state.jobs.length?'<div class="r-job">'+num(state.jobs.length,['рецепт обрабатывается','рецепта обрабатываются','рецептов обрабатываются'])+'</div>':'')+'<div id="r-library-items" class="'+(ui.list?'r-list':'r-grid')+'">'+libraryItems()+'</div></main><button class="r-fab" data-review="import" aria-label="Добавить рецепт">'+ico('plus')+'</button>','collection');
    workspaceStarted();
  }
  function planner(){
    ui.section='meal-plan';const dates=dayList(),entries=plannedEntries(),fmt=date=>date.toLocaleDateString('ru-RU',{day:'numeric',month:'short',timeZone:'UTC'});
    const content=!ui.workspace?'<div class="r-plan-empty"><p class="r-field-hint">Загружаем меню…</p></div>':entries.length?'<div class="r-week-plan">'+dates.map(date=>{const day=entries.filter(entry=>entry.date===dateKey(date));if(!day.length)return '';return '<section class="r-plan-day"><h2>'+esc(date.toLocaleDateString('ru-RU',{weekday:'long',day:'numeric',month:'long',timeZone:'UTC'}))+'</h2>'+day.map(entry=>'<article class="r-plan-entry" data-ws-entry="'+esc(entry.id)+'"><span class="r-meal-label">'+esc(meals[entry.meal])+'</span><button type="button" class="r-plan-recipe" data-review="plan-open" data-entry-id="'+esc(entry.id)+'" '+(entry.recipeAvailable?'':'disabled')+'>'+esc(entry.recipe?.title||'Рецепт недоступен')+'</button><small>'+esc(entry.servings?num(entry.servings,['порция','порции','порций']):'Порции не указаны')+'</small><div class="r-inline-actions"><button type="button" data-review="edit-plan" data-entry-id="'+esc(entry.id)+'">Изменить</button><button type="button" data-review="remove-plan" data-entry-id="'+esc(entry.id)+'">Убрать</button></div></article>').join('')+'</section>';}).join('')+'</div>':'<div class="r-plan-empty"><img class="r-plan-art" src="'+base+'calendar.svg?v=original-1" alt=""><h2 class="r-empty-title">Пока ничего не запланировано…</h2></div>';
    setMarkup(title('Моё меню','plan-settings')+'<main class="r-panel"><div class="r-week"><button class="r-plain" data-review="previous-week" aria-label="Предыдущая неделя">'+ico('left')+'</button><strong>'+(ui.week===0?'Эта неделя ':'')+fmt(dates[0])+' – '+fmt(dates[6])+' '+dates[6].getUTCFullYear()+'</strong><button class="r-plain" data-review="next-week" aria-label="Следующая неделя">'+ico('chevron')+'</button></div>'+workspaceNotice()+content+button('plan-add','Добавить блюдо','plus')+button('plan-magic',readyRecipes().length?'Составить из моих рецептов':'Составить меню','magic','r-action r-highlight')+(entries.length?button('plan-shopping','Продукты в список покупок','basket'):'')+'</main>');
    workspaceStarted();
  }
  function groceries(){
    ui.section='groceries';const items=ui.workspace?.groceries.items||[],checked=items.filter(item=>item.checked).length;
    const amount=item=>item.quantity!==null&&item.quantity!==undefined?[Number(item.quantity).toLocaleString('ru-RU',{maximumFractionDigits:3}),item.unit].filter(Boolean).join(' '):[item.amountText||'Количество не указано',item.unit].filter(Boolean).join(' ');
    const toolbar=(items.length||ui.workspace?.groceries.sources.length)?'<div class="r-shopping-tools"><button type="button" data-review="shopping-sources">Источники продуктов</button>'+(checked?'<button type="button" data-review="clear-checked">Убрать купленное</button>':'')+'</div>':'';
    const content=!ui.workspace?'<div class="r-shop-empty"><p class="r-field-hint">Загружаем список…</p></div>':items.length?'<div class="r-shopping-list">'+items.map(item=>'<article class="r-shopping-item '+(item.checked?'is-checked':'')+'" data-ws-item="'+esc(item.id)+'"><button type="button" class="r-item-check" role="checkbox" aria-checked="'+Boolean(item.checked)+'" aria-label="'+(item.checked?'Снять отметку: ':'Куплено: ')+esc(item.name)+'" data-review="check-item" data-item-id="'+esc(item.id)+'">'+(item.checked?ico('check'):'')+'</button><div><strong>'+esc(item.name)+'</strong>'+(item.comment?'<span class="r-item-comment">'+esc(item.comment)+'</span>':'')+'<small>'+esc(amount(item))+'</small><span class="r-item-source">'+(item.manual?'Добавлено вручную':esc([...new Set((item.provenance||[]).map(source=>source.title).filter(Boolean))].join(', ')||'Из рецепта'))+'</span></div><button type="button" class="r-plain" data-review="item-actions" data-item-id="'+esc(item.id)+'" aria-label="Изменить '+esc(item.name)+'">'+ico('settings')+'</button></article>').join('')+'</div>':'<div class="r-shop-empty"><img class="r-shop-art" src="'+base+'groceries.svg?v=original-1" alt=""><h2 class="r-empty-title">Пока нет продуктов</h2><p class="r-empty-hint">Нажми «+», чтобы добавить продукты</p></div><img class="r-arrow" src="'+base+'arrow.svg" alt="">';
    setMarkup(title('Список покупок',null,'r-grocery-header')+'<p class="r-count">'+(ui.workspace?num(items.length,['продукт','продукта','продуктов']):'Загружаем…')+'</p><main class="r-panel r-groceries">'+workspaceNotice()+toolbar+content+'</main><button class="r-fab" data-review="shopping-add" aria-label="Добавить продукты">'+ico('plus')+'</button>');
    workspaceStarted();
  }
  const chips=[['Быстрый ужин','time','30'],['Овощи','include','овощи'],['Салаты','category','salad'],['Итальянское','cuisine','italian'],['С рисом','category','rice'],['Японское','cuisine','japanese'],['Курица','category','chicken'],['Завтрак','category','breakfast']];
  function catalogContent(){if(ui.catalogError)return `<div class="r-error"><p>${esc(ui.catalogError)}</p>${button('retry-catalog','Попробовать ещё раз','plus')}</div>`;if(ui.catalogBusy&&!ui.catalog)return '<p class="r-empty-library">Загружаем рецепты…</p>';const list=ui.catalog?.recipes||[];if(!list.length)return '<p class="r-empty-library">Рецепты не найдены</p>';if(ui.catalogQuery||ui.catalogFilter)return `<div class="r-grid">${list.map(r=>`<button class="r-book" data-review="catalog-recipe" data-recipe-id="${esc(r.id)}"><img class="r-recipe-cover" src="${safeImage(r.image)}" alt="" loading="lazy"><span><strong>${esc(r.title)}</strong><small>${r.minutes} мин</small></span></button>`).join('')}</div>`;const r=list.find(r=>r.id==='pizza-margherita-family')||list[0];return `<article class="r-feature"><p class="r-script">Рецепт дня</p><h2>${esc(r.title)}</h2><p class="r-feature-meta"><span>Твои рецепты</span><span>·</span><span>${r.minutes} мин</span><span>·</span><span>${num(r.servings||2,['порция','порции','порций'])}</span></p><p class="r-feature-description">${esc(r.description||'Простой рецепт из нашей коллекции. Сохрани и приготовь, когда захочется.')}</p><div class="r-feature-photo"><button data-review="catalog-recipe" data-recipe-id="${esc(r.id)}" aria-label="Открыть ${esc(r.title)}"><img src="${safeImage(r.image)}" alt="${esc(r.title)}"></button><div class="r-feature-actions">${button('catalog-share','Поделиться','share','r-round',`data-recipe-id="${esc(r.id)}" aria-label="Поделиться рецептом"`)}${button('catalog-save','Сохранить','bookmark','r-round',`data-recipe-id="${esc(r.id)}" aria-label="Сохранить рецепт"`)}</div></div></article>`;}
  function discover(){ui.section='discover';setMarkup(`${title('Подобрать',null,'r-discover-header')}<main class="r-panel r-discover">${workspaceNotice()}<form id="r-catalog-form">${searchField('r-catalog-search',ui.catalogQuery,'Что хочешь приготовить?')}</form><section class="r-popular"><p>Популярные запросы</p><div class="r-chip-scroller">${[chips.slice(0,4),chips.slice(4)].map(row=>`<div class="r-chip-row">${row.map(([name],i)=>`<button class="r-chip" data-review="chip" data-chip="${esc(name)}" aria-pressed="${ui.catalogFilter===name}">${name}</button>`).join('')}</div>`).join('')}</div></section><div id="r-catalog-content">${catalogContent()}</div></main>`);if(!ui.catalog&&!ui.catalogBusy&&!ui.catalogError)void loadCatalog(false);}
  async function loadCatalog(observed){const rev=++ui.catalogRevision;ui.catalogBusy=true;ui.catalogError='';const params=new URLSearchParams();if(ui.catalogQuery)params.set('q',ui.catalogQuery);const c=chips.find(x=>x[0]===ui.catalogFilter);if(c)params.set(c[1],c[2]);const flow=observed?crypto.randomUUID():null;if(flow){RecipeAnalytics?.event('step_submit','other',{flowId:flow});RecipeAnalytics?.requestStarted(flow,'other');}try{const response=await api('/api/catalog?'+params,{signal:AbortSignal.timeout(12000)});if(rev!==ui.catalogRevision)return;ui.catalog=response;ui.catalogBusy=false;if(ui.section==='discover'){const el=document.querySelector('#r-catalog-content');if(el){el.innerHTML=catalogContent();if(flow)RecipeAnalytics?.requestVisible(el,flow,false,'full');}}}catch(error){if(rev!==ui.catalogRevision)return;ui.catalogError=error.message;ui.catalogBusy=false;if(ui.section==='discover')discover();}}
  function note(titleText,text,action=null){const dialog=document.createElement('dialog');dialog.className='r-review-dialog';dialog.innerHTML=`<h2>${esc(titleText)}</h2><p>${esc(text)}</p>${action?`<a href="${esc(action.href)}">${esc(action.label)}</a>`:''}<button type="button">Понятно</button>`;document.body.append(dialog);dialog.querySelector('button').onclick=()=>dialog.close();dialog.addEventListener('close',()=>{dialog.remove();RecipeAnalytics?.step(root.dataset.analyticsStep||'other')},{once:true});dialog.addEventListener('click',e=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close()}});dialog.showModal();RecipeAnalytics?.observe(dialog,'screen_view','other');}
  async function showCatalog(id){const rev=++ui.detailRevision;try{const raw=await api('/api/catalog/'+encodeURIComponent(id),{signal:AbortSignal.timeout(12000)});if(rev!==ui.detailRevision||ui.section!=='discover')return;const recipe={...raw,thumbnailUrl:raw.image,totalMinutes:raw.minutes,warnings:raw.warnings||[],tags:raw.tags||[]};closeOverlay();showReferenceCard(recipe,{catalogId:id});}catch(error){if(rev===ui.detailRevision)toast(error.message);}}
  function openCatalogSite(id){const url=new URL('/dinner/'+encodeURIComponent(id),location.origin).href;if(tg?.openLink)tg.openLink(url);else location.assign(url);}
  collection=function(recipes,titleText,suggestion){if(suggestion||new URLSearchParams(location.search).get('view')==='results'){root.classList.remove('review-shell');return oldCollection(recipes,titleText,suggestion)}recipesPage();};
  home=function(){recipesPage()};
  function cardSavedNotice(flow,target,message='Изменения сохранены'){
    if(!target?.isConnected)return;
    const confirmation=document.createElement('div');confirmation.className='rc-save-feedback';confirmation.setAttribute('role','status');confirmation.textContent=message;target.append(confirmation);
    RecipeAnalytics?.observe(confirmation,'workspace_action',analyticsStep(flow.feature),{feature:flow.feature,action:flow.action,outcome:'success',flowId:flow.id,_started:flow.startedWall});setTimeout(()=>confirmation.remove(),3500);
  }
  function cardSheet(heading,body){
    const confirmations=[...document.querySelectorAll('.rc-save-feedback')];
    const element=overlay(`<div class="sheet-head"><h2>${esc(heading)}</h2><button type="button" class="icon-btn" data-close aria-label="Закрыть">${ico('plus')}</button></div>${body}`,'rc-card-dialog');
    element.querySelector('.sheet').append(...confirmations);
    element.querySelector('[data-close]').onclick=()=>unmountModal(element);return element;
  }
  function cardWorkspaceForm(recipe,open){
    const routeRecipe=new URLSearchParams(location.search).get('recipe'),confirmations=[...document.querySelectorAll('.rc-save-feedback')],context={};ui.cardReturn=context;closeOverlay();open();
    document.querySelector('dialog[open]')?.append(...confirmations);
    const watch=new MutationObserver(()=>{
      if(document.querySelector('dialog[open]'))return;watch.disconnect();if(ui.cardReturn===context)ui.cardReturn=null;
      if(document.querySelector('.overlay')||new URLSearchParams(location.search).get('recipe')!==routeRecipe)return;
      void openRecipe(recipe.id,false).then(()=>{if(context.savedFlow)cardSavedNotice(context.savedFlow,document.querySelector('.rr-card-sheet'));});
    });
    if(document.querySelector('dialog[open]'))watch.observe(document.body,{childList:true});
  }
  async function prepareCardPhoto(file){
    if(!/^image\/(jpeg|png|webp)$/.test(file.type)||file.size>6*1024*1024)throw new Error('Выбери JPEG, PNG или WEBP размером до 6 МБ.');
    const image=await createImageBitmap(file);try{
      if(image.width*image.height>40000000)throw new Error('Выбери фото меньшего разрешения.');
      const scale=Math.min(1,1600/Math.max(image.width,image.height)),canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(image.width*scale));canvas.height=Math.max(1,Math.round(image.height*scale));canvas.getContext('2d').drawImage(image,0,0,canvas.width,canvas.height);
      for(const quality of [.86,.7,.5]){const data=canvas.toDataURL('image/webp',quality),value=data.split(',')[1];if(value.length<=Math.floor(1024*1024*4/3))return {mime:'image/webp',value};}
      throw new Error('Фото слишком большое. Выбери изображение меньшего размера.');
    }finally{image.close();}
  }
  function showReferenceCard(recipe,{catalogId=null,engagement=null}={}){
    const image=safeImage(recipe.thumbnailUrl),source=/^https?:\/\//i.test(recipe.sourceUrl||'')?esc(recipe.sourceUrl):'';
    const initial=ui.workspace?.recipeCards?.[recipe.id]||{};
    const element=overlay(RecipeReferenceCard.render(recipe,{metadata:initial,imageUrl:image,sourceUrl:source,catalog:Boolean(catalogId)}),'recipe-detail recipe-detail-sheet rr-card-sheet');
    const sheet=element.querySelector('.rr-card-sheet');
    const active=()=>{if(!element.isConnected)throw new DOMException('Карточка закрыта','AbortError');};
    const confirmCard=(flow,message='Изменения сохранены')=>cardSavedNotice(flow,sheet,message);
    element.querySelector('[data-close]').onclick=()=>{if(catalogId){closeOverlay();RecipeAnalytics?.step('other');}else closeDetailRoute();};
    element.querySelector('[data-source-link]')?.addEventListener('click',event=>{if(tg?.openLink){event.preventDefault();tg.openLink(recipe.sourceUrl);}});
    const own=async()=>{
      active();if(!catalogId)return recipe;
      const flow=flowFor('collections.saveCatalog');flow.inlineConfirmation=true;const result=await mutate(flow,{catalogId});
      active();confirmCard(flow,'Рецепт сохранён');const saved=await api('/api/recipes/'+encodeURIComponent(result.operation.result.recipeId));active();Object.assign(recipe,saved);catalogId=null;await refresh();active();
      const params=Object.fromEntries(new URLSearchParams(location.search));params.recipe=recipe.id;setRoute(params,{historyState:{recipeOverlay:true,scrollY:state.scrollY}});
      element.querySelector('[data-close]').onclick=closeDetailRoute;
      return recipe;
    };
    let cardLoadRevision=0,cardDetails={...initial};
    const loadCard=async()=>{const revision=++cardLoadRevision,value=await api('/api/recipes/'+encodeURIComponent(recipe.id)+'/card');if(element.isConnected&&revision===cardLoadRevision&&value.workspaceVersion>=(ui.workspace?.version||0)){cardDetails={...value,hasPhoto:Boolean(value.photo)};controller.sync(value);}return value;};
    const change=async(fields,action='collections.updateCard')=>{
      await own();if(!await canEdit())throw new Error('Сначала заверши текущее сохранение.');active();
      const flow=flowFor(action);flow.inlineConfirmation=true;await mutate(flow,{recipeId:recipe.id,...fields});
      const details={...(ui.workspace?.recipeCards?.[recipe.id]||{}),notes:fields.notes??recipe.notes,tags:fields.tags??recipe.tags,...(action==='collections.setPhoto'?{photo:{dataUrl:`data:${fields.mime};base64,${fields.value}`}}:action==='collections.removePhoto'?{photo:null}:{})};
      cardDetails={...cardDetails,...details};
      if(Object.hasOwn(fields,'notes'))recipe.notes=fields.notes;if(Object.hasOwn(fields,'tags'))recipe.tags=fields.tags;
      if(element.isConnected){
        controller.sync(details);confirmCard(flow);
        void loadCard().catch(()=>{});
      }
      return details;
    };
    const fieldsForm=(heading,field,value)=>{
      const modal=cardSheet(heading,`<form class="form-stack" data-card-field><label><span class="label">${field==='tags'?'Теги через запятую':'Моя заметка'}</span><textarea class="field" maxlength="${field==='tags'?1000:3000}" name="value">${esc(value)}</textarea></label><p data-card-error role="alert" hidden></p><button type="submit" class="primary accent">Сохранить</button></form>`);
      modal.querySelector('form').onsubmit=async event=>{event.preventDefault();const button=modal.querySelector('[type=submit]'),error=modal.querySelector('[data-card-error]');button.disabled=true;error.hidden=true;try{const text=modal.querySelector('textarea').value;await change({[field]:field==='tags'?text.split(',').map(s=>s.trim()).filter(Boolean):text});unmountModal(modal);if(field==='tags')element.querySelector('.rc-tag-list').innerHTML=recipe.tags.map(tag=>`<span>${esc(tag)}</span>`).join('');}catch(e){error.textContent=e.message;error.hidden=false;}finally{button.disabled=false;}};
    };
    const controller=RecipeReferenceCard.mount(element,recipe,{
      toast,saveMetadata:fields=>change(fields),saveNotes:notes=>change({notes}),
      collection:async()=>{await own();if(await canEdit()){active();cardWorkspaceForm(recipe,()=>recipeMemberships(recipe));}},
      plan:async({servings})=>{await own();if(await canEdit()){active();cardWorkspaceForm(recipe,()=>{const dialog=planForm(null,recipe.id);if(servings)dialog.querySelector('#ws-servings').value=servings;});}},
      groceries:async({servings})=>{await own();if(await canEdit()){active();cardWorkspaceForm(recipe,()=>{groceriesFromRecipe(recipe.id);if(servings)ui.dialog.querySelector('#ws-servings').value=servings;});}},
      edit:async()=>{await own();closeOverlay();editRecipe(recipe);},
      tags:async()=>{await own();fieldsForm('Теги рецепта','tags',(recipe.tags||[]).join(', '));},
      more:async()=>{await own();await loadCard();active();const modal=cardSheet('Действия с рецептом',`<div class="form-stack"><button class="secondary" data-more="edit">Изменить рецепт</button><button class="secondary" data-more="tags">Изменить теги</button><button class="secondary" data-more="photo" ${cardDetails.hasPhoto?'':'disabled'}>Вернуть исходное фото</button><p data-card-error role="alert" hidden></p></div>`);
        modal.querySelector('[data-more=edit]').onclick=()=>{closeOverlay();editRecipe(recipe);};
        modal.querySelector('[data-more=tags]').onclick=()=>{unmountModal(modal);fieldsForm('Теги рецепта','tags',(recipe.tags||[]).join(', '));};
        modal.querySelector('[data-more=photo]').onclick=async event=>{const button=event.currentTarget;button.disabled=true;try{await change({},'collections.removePhoto');if(modal.isConnected)unmountModal(modal);}catch(error){const notice=modal.querySelector('[data-card-error]');notice.textContent=error.message;notice.hidden=false;}finally{if(button.isConnected)button.disabled=false;}};
      },
      share:async({button})=>{await own();active();const markup=button.innerHTML;try{await shareRecipe(recipe,button);}finally{if(button.isConnected)button.innerHTML=markup;}},
      cook:()=>{if(catalogId){closeOverlay();RecipeCooking.open(recipe);}else void cookFromDinnerDetail(recipe);},
      photo:async file=>{const photo=await prepareCardPhoto(file),details=await change(photo,'collections.setPhoto');return details.photo?.dataUrl;},
      nutrition:async()=>{await own();const updated=await api('/api/recipes/'+encodeURIComponent(recipe.id));if(!updated.nutrition)throw new Error('Пока не удалось рассчитать КБЖУ. Повтори попытку позже.');controller.setNutrition(updated.nutrition);},
      ask:async()=>{await own();showRecipeQuestion(recipe);}
    },initial);
    element.onDispose=()=>controller.dispose();
    if(recipe.recipeViewToken)observeEngagement(sheet,recipe.recipeViewToken,engagement,true);
    RecipeAnalytics?.step('recipe');RecipeAnalytics?.observe(sheet,'screen_view','recipe');
    if(!catalogId)void loadCard().catch(error=>{if(element.isConnected)toast(error.message);});
    return element;
  }
  function showRecipeQuestion(recipe){
    ui.recipeQuestions??=new Map();let current=ui.recipeQuestions.get(recipe.id);
    const element=cardSheet('Спросить о рецепте',`<p class="help">${esc(recipe.title)}</p><form class="form-stack"><label><span class="label">Твой вопрос</span><textarea class="field" maxlength="1500" required placeholder="Например, можно ли приготовить в духовке?">${esc(current?.question||'')}</textarea></label><div class="rc-chat-answer" aria-live="polite" ${current?.answer?'':'hidden'}>${esc(current?.answer||'')}</div><p data-card-error role="alert" hidden></p><button class="primary accent" type="submit">${current?.pending?'Повторить запрос':'Спросить'}</button></form>`);
    const form=element.querySelector('form'),input=form.querySelector('textarea'),button=form.querySelector('button'),answer=form.querySelector('.rc-chat-answer'),errorBox=form.querySelector('[data-card-error]');
    if(current?.pending)input.disabled=true;
    if(current?.answer&&current.flow?.done)RecipeAnalytics?.observe(answer,'workspace_action','collection',{feature:'collections',action:'collections.askRecipe',outcome:'success',flowId:current.flow.id,_started:current.flow.startedWall});
    form.onsubmit=async event=>{
      event.preventDefault();if(button.disabled)return;const question=input.value.trim();if(!question)return;
      if(!current?.pending){const flow=flowFor('collections.askRecipe');flow.inlineConfirmation=true;flow.started=performance.now();flow.startedWall=Date.now();current={question,flow,pending:true,answer:null};ui.recipeQuestions.set(recipe.id,current);actionEvent(flow,'started');}
      button.disabled=true;input.disabled=true;errorBox.hidden=true;answer.hidden=false;answer.textContent='Готовлю ответ…';
      try{
        let response;
        for(let attempt=0;attempt<20;attempt++){
          const request=await fetch('/api/recipes/'+encodeURIComponent(recipe.id)+'/card/ask',{method:'POST',headers:{authorization:window.RecipePlatform?.authHeader()||`tma ${tg?.initData||''}`,'content-type':'application/json'},body:JSON.stringify({operationId:current.flow.id,question:current.question}),signal:AbortSignal.timeout(30000)});
          response=await request.json().catch(()=>null);
          if(!request.ok)throw Object.assign(new Error(response?.error||'Связь прервалась. Повтори запрос.'),{confirmed:response?.operationId===current.flow.id&&(typeof response?.replayed==='boolean'||response?.started===false),status:request.status});
          if(!response||response.operationId!==current.flow.id)throw new Error('Ответ не подтверждён. Повтори запрос.');
          if(response.status==='completed')break;
          if(response.status!=='pending')throw new Error('Сервер не подтвердил результат. Повтори запрос.');
          if(!element.isConnected)return;await new Promise(resolve=>setTimeout(resolve,Math.max(1000,Math.min(2500,response.retryAfterMs||1500))));
        }
        if(response?.status!=='completed')throw new Error('Ответ ещё готовится. Повтори запрос.');
        current.pending=false;current.answer=response.answer;current.flow.done=true;
        if(element.isConnected){answer.textContent=response.answer;RecipeAnalytics?.observe(answer,'workspace_action','collection',{feature:'collections',action:'collections.askRecipe',outcome:'success',flowId:current.flow.id,_started:current.flow.startedWall});}
      }catch(error){actionEvent(current.flow,'error');if(error.confirmed)current.pending=false;if(element.isConnected){answer.hidden=true;errorBox.textContent=error.message;errorBox.hidden=false;}}
      finally{if(element.isConnected){button.disabled=false;input.disabled=current.pending;button.textContent=current.pending?'Повторить запрос':'Спросить';}}
    };
  }
  const previousRecipeDetail=recipeDetail;
  recipeDetail=function(recipe,options={}){
    const view=new URLSearchParams(location.search).get('view');
    if(options.shared||options.suggestion||view==='request'||recipe.previewOnly||state.payment?.firstRecipe?.awaitingTrial&&!state.payment.active&&!(recipe.publicCatalogSaved&&publicCatalogRecipeReadable(recipe.id)))return previousRecipeDetail(recipe,options);
    if(/^(seed|dinner):/.test(recipe.id))return previousRecipeDetail(recipe,options);
    return showReferenceCard(recipe,options);
  };
  render=async function(){const view=new URLSearchParams(location.search).get('view');ui.detailRevision++;if(['meal-plan','groceries','discover'].includes(view)){({ 'meal-plan':planner,groceries,discover })[view]();const recipeId=new URLSearchParams(location.search).get('recipe');if(recipeId)await openRecipe(recipeId,false);return;}if(['collection',null,''].includes(view)){await oldRender();return;}root.classList.remove('review-shell');await oldRender();};
  root.addEventListener('click',async event=>{const el=event.target.closest('button');if(!el||!root.contains(el)||!root.classList.contains('review-shell'))return;if(el.dataset.reviewView){ui.book=null;ui.query='';ui.detailRevision++;ui.navigation=null;setRoute({view:el.dataset.reviewView});await render();resetPageScroll();if(el.dataset.reviewView!=='discover'&&!ui.saving&&!ui.uncertain)void ensureWorkspace(true).catch(()=>{});return}const a=el.dataset.review;if(!a)return;try{switch(a){
    case 'fold':ui.folded=!ui.folded;recipesPage();break;
    case 'tab':ui.tab=el.dataset.tab;ui.book=null;ui.query='';recipesPage();break;
    case 'sort':ui.sort=!ui.sort;recipesPage();break;case 'layout':ui.list=!ui.list;recipesPage();break;
    case 'book':ui.book=el.dataset.book;ui.query='';recipesPage();resetPageScroll();break;
    case 'all-books':ui.book=null;ui.query='';recipesPage();break;
    case 'recipe':await openRecipe(el.dataset.recipeId,true);break;
    case 'import':importSheet();break;
    case 'profile':settingsSheet();break;
    case 'quick':importSheet();break;
    case 'new-book':if(await canEdit())collectionForm();break;
    case 'manage-book':if(await canEdit()){const book=ui.workspace.collections.find(item=>item.id===ui.book);if(book)manageCollection(book);else toast('Подборка уже удалена.');}break;
    case 'recipe-actions':if(await canEdit()){const recipe=recipeById(el.dataset.recipeId);if(recipe)recipeChoices(recipe);}break;
    case 'previous-week':ui.week--;planner();break;case 'next-week':ui.week++;planner();break;
    case 'plan-settings':if(await canEdit())choiceDialog('Моё меню',[{label:'Перейти к этой неделе',run:()=>{ui.week=0;planner();}},{label:'Составить из моих рецептов',run:autoPlan},{label:'Продукты из выбранной недели',run:groceriesFromPlan}]);break;
    case 'plan-add':if(await canEdit())choosePlanRecipe();break;
    case 'plan-magic':if(await canEdit())autoPlan();break;
    case 'plan-shopping':if(await canEdit())groceriesFromPlan();break;
    case 'plan-open':{const entry=ui.workspace?.plan.find(item=>item.id===el.dataset.entryId);if(entry?.recipeAvailable)await openRecipe(entry.recipeId,true);break;}
    case 'edit-plan':if(await canEdit()){const entry=ui.workspace.plan.find(item=>item.id===el.dataset.entryId);if(entry)planForm(entry);}break;
    case 'remove-plan':if(await canEdit()){const entry=ui.workspace.plan.find(item=>item.id===el.dataset.entryId);if(entry)formDialog({title:'Убрать блюдо из меню?',action:'plan.delete',submit:'Убрать блюдо',body:`<p>${esc(entry.recipe?.title||'Недоступный рецепт')}</p><p class="r-field-hint">${esc(entry.date)} · ${esc(meals[entry.meal])}. Связанные продукты в покупках будут обновлены.</p>`,read:()=>({entryId:entry.id})});}break;
    case 'shopping-add':if(await canEdit())shoppingChoices();break;
    case 'shopping-sources':if(await canEdit())sourceChoices();break;
    case 'item-actions':if(await canEdit()){const item=ui.workspace.groceries.items.find(row=>row.id===el.dataset.itemId);if(item)itemChoices(item);}break;
    case 'check-item':if(await canEdit()){const item=ui.workspace.groceries.items.find(row=>row.id===el.dataset.itemId);if(item)await mutate(flowFor('groceries.setChecked'),{itemId:item.id,checked:!item.checked});}break;
    case 'clear-checked':if(await canEdit())formDialog({title:'Убрать купленное?',action:'groceries.clearChecked',submit:'Убрать купленное',body:'<p>Отмеченные продукты исчезнут из списка покупок. Остальные позиции сохранятся.</p>',read:()=>({})});break;
    case 'reload-workspace':await ensureWorkspace(true);break;
    case 'retry-workspace-operation':if(ui.uncertain&&!ui.saving){const flow=ui.uncertain;await mutate(flow,null);if(flow.action==='collections.saveCatalog'){await refresh();flow.inlineConfirmation=false;redrawWorkspace();actionEvent(flow,'success');}}break;
    case 'chip':ui.catalogFilter=ui.catalogFilter===el.dataset.chip?null:el.dataset.chip;ui.catalogQuery='';ui.catalog=null;ui.catalogBusy=true;discover();void loadCatalog(true);break;
    case 'retry-catalog':ui.catalogError='';ui.catalog=null;void loadCatalog(true);break;
    case 'catalog-recipe':await showCatalog(el.dataset.recipeId);break;
    case 'catalog-save':await saveCatalogHere(el.dataset.recipeId,el);break;
    case 'catalog-share':{const url=new URL('/dinner/'+encodeURIComponent(el.dataset.recipeId),location.origin).href;try{if(navigator.share)await navigator.share({url});else{await navigator.clipboard.writeText(url);toast('Ссылка скопирована')}}catch(error){if(error.name!=='AbortError')toast('Открой рецепт и скопируй ссылку на него')}break;}
  }}catch(error){toast(error.message||'Не удалось выполнить действие.');}});
  root.addEventListener('input',event=>{if(event.target.id==='r-library-search'){ui.query=event.target.value;const list=root.querySelector('#r-library-items');if(list)list.innerHTML=libraryItems();}});
  root.addEventListener('submit',event=>{if(event.target.id==='r-catalog-form'){event.preventDefault();ui.catalogQuery=root.querySelector('#r-catalog-search').value.trim();ui.catalogFilter=null;ui.catalog=null;void loadCatalog(true);}});
  window.RecipeReview={version:'workspace-4',resetView:()=>{ui.tab='books';ui.book=null;ui.query='';ui.folded=false;setRoute({view:'collection'});return render();}};
  // A direct browser opening provides the same honest entry error as the regular Mini App.
  if(!tg?.initData){const landing=document.querySelector('#landing');if(landing)landing.hidden=true;root.hidden=false;root.innerHTML='<main class="outside"><div class="brand-mark">Р</div><h1>Открой в тестовом боте</h1><p>Новый интерфейс доступен через кнопку «Меню» в Telegram.</p><a class="primary accent" href="https://t.me/recipeboi_test_bot">Открыть тестового бота</a></main>';window.__miniRendered=true;}
})();
