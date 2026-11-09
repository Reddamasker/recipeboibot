(() => {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const paths = {
    back:'<path d="m15 5-7 7 7 7"/>', plus:'<path d="M12 4v16M4 12h16"/>', minus:'<path d="M4 12h16"/>',
    more:'<circle cx="4" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="20" cy="12" r="1"/>',
    camera:'<path d="M3 6h4l2-3h6l2 3h4v15H3Z"/><circle cx="12" cy="13" r="4"/>',
    book:'<path d="M5 3h10v18l-5-3-5 3V3m14-1v8m-4-4h8"/>',
    calendar:'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 2v6m10-6v6M3 11h18m-5 3v6m-3-3h6"/>',
    basket:'<path d="m7 8 3-5m7 5-3-5M2 9h20M4 10l2 10h8M9 12v5m6-5v3m5 1v7m-3-3h6"/>',
    pin:'<path d="m15 3 6 6-4 1-3 6-3-3-7 7 7-7-3-3 6-3Z"/>',
    share:'<path d="M8 8H5v13h14V8h-3M12 15V2m-4 4 4-4 4 4"/>',
    check:'<circle cx="12" cy="12" r="9"/><path d="m7 12 3 3 7-7"/>',
    star:'<path d="m12 2 3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1Z"/>',
    convert:'<path d="M4 7h16M8 3 4 7l4 4m12 6H4m12-4 4 4-4 4"/>',
    play:'<circle cx="12" cy="12" r="9"/><path d="m10 8 6 4-6 4Z"/>',
    magic:'<path d="m5 20 9-9m-5-8v5m-2-2h5m7 5v6m-3-3h6M16 2l1.5 3.5L21 7l-3.5 1.5L16 12l-1.5-3.5L11 7l3.5-1.5Z"/>',
    link:'<path d="M13 3h8v8m0-8L11 13M10 5H3v16h16v-7"/>'
  };
  const icon = name => `<svg viewBox="0 0 24 24" class="rc-icon" aria-hidden="true">${paths[name] || paths.plus}</svg>`;
  const button = (action,label,name,extra='') => `<button type="button" class="rc-pill" data-rc="${action}" ${extra}>${name?icon(name):''}<span>${esc(label)}</span></button>`;
  const numeric = value => {
    if(typeof value==='number')return Number.isFinite(value)&&value>=0?value:null;
    const text=String(value??'').trim().replace(',','.');
    if(/^\d+(?:\.\d+)?$/.test(text))return Number.isFinite(Number(text))?Number(text):null;
    const fraction=text.match(/^(?:(\d+)\s+)?(\d+)\/(\d+)$/);
    return fraction&&Number(fraction[3])>0?Number(fraction[1]||0)+Number(fraction[2])/Number(fraction[3]):null;
  };
  const number = value => new Intl.NumberFormat('ru',{maximumSignificantDigits:6}).format(value);
  function ingredients(recipe,servings,unitMode='original'){
    const base=numeric(recipe.servings),factor=base>0&&servings>0?servings/base:1;
    return (recipe.ingredients||[]).map(item=>{
      if(typeof item==='string')return `<li class="rc-ingredient">${esc(item)}</li>`;
      if(item.group&&!item.name&&!item.raw)return `<li class="rc-ingredient-group">${esc(item.group)}</li>`;
      let quantity=numeric(item.quantity),unit=String(item.unit||''),key=unit.trim().toLocaleLowerCase('ru').replace(/\.$/,'');
      if(quantity!==null){quantity*=factor;
        if(unitMode==='small'&&['кг','kg','килограмм','килограмма','килограммов'].includes(key)){quantity*=1000;unit='г';}
        if(unitMode==='small'&&['л','l','литр','литра','литров'].includes(key)){quantity*=1000;unit='мл';}
        if(unitMode==='large'&&['г','g','гр','грамм','грамма','граммов'].includes(key)){quantity/=1000;unit='кг';}
        if(unitMode==='large'&&['мл','ml','миллилитр','миллилитра','миллилитров'].includes(key)){quantity/=1000;unit='л';}
      }
      const amount=[quantity===null?item.quantity:number(quantity),unit].filter(v=>v!==null&&v!==undefined&&v!=='').join(' ');
      const name=item.name||item.raw||'';
      return `<li class="rc-ingredient">${amount?`<strong>${esc(amount)}</strong> `:''}${esc(name)}${item.comment?` <span>${esc(item.comment)}</span>`:''}</li>`;
    }).join('')||'<li class="rc-muted">Ингредиенты не указаны</li>';
  }
  function render(recipe,{metadata={},imageUrl='',sourceUrl='',catalog=false}={}){
    const base=numeric(recipe.servings),servings=base>0?base:null;
    const source=recipe.sourceName||(recipe.origin==='generated'?'Создано в «Рецептах»':catalog?'Каталог «Рецепты»':'Личный рецепт');
    const steps=(recipe.steps||[]).map((step,index)=>`<li><span class="rc-step-number">${index+1}</span><p>${esc(typeof step==='string'?step:step.text).replace(/(\d+(?:[–-]\d+)?\s*°\s*[CСF])/gu,'<span class="rc-highlight">$1</span>')}</p></li>`).join('');
    return `<article class="rc-card" data-rc-recipe="${esc(recipe.id)}">
      <div class="rc-toolbar"><button class="rc-back" type="button" data-close aria-label="Назад">${icon('back')}</button><div class="rc-edit-tools"><button type="button" data-rc="edit">Изменить</button><button type="button" data-rc="more" aria-label="Другие действия">${icon('more')}</button></div></div>
      <div class="rc-hero ${imageUrl?'':'rc-without-photo'}">${imageUrl?`<img src="${imageUrl}" alt="${esc(recipe.title)}" referrerpolicy="no-referrer">`:'<span>Добавь фото блюда</span>'}<button class="rc-camera" type="button" data-rc="photo" aria-label="Изменить фото рецепта">${icon('camera')}</button><input data-rc-photo type="file" accept="image/jpeg,image/png,image/webp" hidden></div>
      <div class="rc-content"><section class="rc-heading" data-recipe-section="header"><h1 data-modal-heading>${esc(recipe.title)}</h1>${button('collection','В подборку','book')}
        <div class="rc-actions">${[['plan','Меню','calendar'],['groceries','Покупки','basket'],['pin',metadata.pinned?'Закреплён':'Закрепить','pin'],['share','Поделиться','share']].map(([action,label,name])=>`<button type="button" data-rc="${action}" ${action==='pin'?`aria-pressed="${Boolean(metadata.pinned)}"`:''}><span class="rc-action-icon">${icon(name)}</span><span data-rc-label>${label}</span></button>`).join('')}</div>
      </section>
      <section class="rc-personal"><div class="rc-source"><span class="rc-source-avatar" aria-hidden="true">${esc(source.slice(0,1))}</span><span>Источник: <strong>${esc(source)}</strong></span></div>${sourceUrl?`<a class="rc-source-link" href="${sourceUrl}" data-source-link target="_blank" rel="noopener noreferrer">Открыть источник ${icon('link')}</a>`:''}
        <div class="rc-feedback">${button('cooked',metadata.cooked?'Приготовлено':'Отметить приготовленным','check',`aria-pressed="${Boolean(metadata.cooked)}"`)}<div class="rc-rating" role="group" aria-label="Моя оценка рецепта">${[1,2,3,4,5].map(value=>`<button type="button" data-rc="rating" data-value="${value}" aria-label="Оценка ${value} из 5" aria-pressed="${value<=Number(metadata.rating||0)}">${icon('star')}</button>`).join('')}</div>
          <form class="rc-note-form"><label class="rc-sr" for="rc-note">Моя заметка</label><textarea id="rc-note" rows="1" maxlength="3000" placeholder="Добавить заметку…">${esc(recipe.notes||'')}</textarea><button class="rc-note-save" type="submit" hidden>Сохранить заметку</button></form>
        </div>
      </section>
      ${recipe.warnings?.length?`<details class="rc-warnings"><summary>Что стоит проверить</summary><ul>${recipe.warnings.map(text=>`<li>${esc(text)}</li>`).join('')}</ul></details>`:''}
      <section class="rc-section rc-ingredients" data-recipe-section="ingredients"><h2>Ингредиенты</h2><div class="rc-ingredient-tools"><div class="rc-serving-control"><div class="rc-stepper"><button type="button" data-rc="decrease" aria-label="Уменьшить порции" ${!servings||servings<=1?'disabled':''}>${icon('minus')}</button><output data-rc-servings>${servings?number(servings):'—'}</output><button type="button" data-rc="increase" aria-label="Увеличить порции" ${!servings||servings>=100?'disabled':''}>${icon('plus')}</button></div><span>порции</span></div>${button('units','Единицы','convert')}</div>${!servings?'<p class="rc-muted rc-serving-note">Порции не указаны в исходном рецепте</p>':''}<ul class="rc-ingredient-list" data-recipe-ingredients>${ingredients(recipe,servings)}</ul>${button('groceries','В список покупок','basket')}</section>
      <section class="rc-section rc-instructions" data-recipe-section="steps"><h2>Приготовление</h2>${button('cook','Готовить по шагам','play',recipe.steps?.length?'':'disabled')}<ol class="rc-step-list">${steps||'<li>Шаги не указаны</li>'}</ol></section>
      <section class="rc-section rc-nutrition"><h2>КБЖУ</h2><p class="rc-muted">На одну порцию</p><div data-rc-nutrition>${nutrition(recipe.nutrition)}</div></section>
      <section class="rc-section rc-tags"><h2>Теги</h2><div class="rc-tag-list">${(recipe.tags||[]).map(tag=>`<span>${esc(tag)}</span>`).join('')}</div>${button('tags','Добавить теги','plus')}</section></div>
      <button class="rc-ask" type="button" data-rc="ask" aria-label="Спросить о рецепте">${icon('magic')}<span>Спросить</span></button><p class="rc-status rc-sr" aria-live="polite"></p>
    </article>`;
  }
  function nutrition(n){
    if(!n)return button('nutrition','Рассчитать КБЖУ','magic');
    return `<div class="rc-nutrition-values">${[['calories','ккал'],['protein','белки, г'],['fat','жиры, г'],['carbs','углеводы, г']].map(([key,label])=>`<span><strong>${number(n[key])}</strong><small>${label}</small></span>`).join('')}</div><details class="rc-nutrition-note"><summary>${n.source==='recipe'?'Из исходного рецепта':'Примерный расчёт'}</summary><p>${esc((n.assumptions||[]).join(' ')||'Значения относятся к одной порции.')}</p></details>`;
  }
  function mount(element,recipe,hooks,initial={}){
    const card=element.querySelector('.rc-card'),scroll=element.querySelector('.rr-card-sheet')||element;
    let meta={...initial},servings=numeric(recipe.servings),unitMode='original',pending=false;
    const originalImage=card.querySelector('.rc-hero>img')?.getAttribute('src')||'';
    const report=message=>{card.querySelector('.rc-status').textContent=message;hooks.toast(message);};
    const updateServings=()=>{card.querySelector('[data-rc-servings]').textContent=servings?number(servings):'—';card.querySelector('[data-rc=decrease]').disabled=!servings||servings<=1;card.querySelector('[data-rc=increase]').disabled=!servings||servings>=100;card.querySelector('[data-recipe-ingredients]').innerHTML=ingredients(recipe,servings,unitMode);};
    const updateMeta=()=>{card.querySelector('[data-rc=pin]').setAttribute('aria-pressed',String(Boolean(meta.pinned)));card.querySelector('[data-rc=pin] [data-rc-label]').textContent=meta.pinned?'Закреплён':'Закрепить';card.querySelector('[data-rc=cooked]').setAttribute('aria-pressed',String(Boolean(meta.cooked)));card.querySelector('[data-rc=cooked] span').textContent=meta.cooked?'Приготовлено':'Отметить приготовленным';card.querySelectorAll('[data-rc=rating]').forEach(b=>b.setAttribute('aria-pressed',String(Number(b.dataset.value)<=Number(meta.rating||0))));};
    const run=async(button,work)=>{if(pending){report('Дождись завершения текущего действия.');return;}pending=true;const controls=[...new Set([...card.querySelectorAll('[data-rc]'),button].filter(Boolean))].map(control=>[control,control.disabled]);for(const [control] of controls)control.disabled=true;try{await work();}catch(error){if(error.name!=='AbortError')report(error.message||'Не удалось сохранить. Повтори попытку.');}finally{pending=false;for(const [control,disabled] of controls)if(control.isConnected)control.disabled=disabled;}};
    card.addEventListener('click',event=>{
      const control=event.target.closest('[data-rc]');if(!control)return;
      const action=control.dataset.rc;
      if(action==='increase'||action==='decrease'){servings=Math.min(100,Math.max(1,servings+(action==='increase'?1:-1)));updateServings();return;}
      if(action==='units'){
        const existing=card.querySelector('.rc-unit-options');if(existing){existing.remove();control.setAttribute('aria-expanded','false');return;}
        const menu=document.createElement('div');menu.className='rc-unit-options';menu.setAttribute('role','group');menu.setAttribute('aria-label','Единицы ингредиентов');
        for(const [mode,label] of [['original','Как в рецепте'],['small','Граммы и миллилитры'],['large','Килограммы и литры']]){const b=document.createElement('button');b.type='button';b.textContent=label;b.setAttribute('aria-pressed',String(mode===unitMode));b.onclick=()=>{unitMode=mode;updateServings();menu.remove();control.setAttribute('aria-expanded','false');control.focus();};menu.append(b);}
        card.querySelector('.rc-ingredient-tools').after(menu);control.setAttribute('aria-expanded','true');menu.querySelector('button').focus();return;
      }
      if(action==='photo'){if(!pending)card.querySelector('[data-rc-photo]').click();return;}
      if(action==='rating'||action==='pin'||action==='cooked')return void run(control,async()=>{const fields=action==='rating'?{rating:Number(meta.rating)===Number(control.dataset.value)?0:Number(control.dataset.value)}:action==='pin'?{pinned:!meta.pinned}:{cooked:!meta.cooked};await hooks.saveMetadata(fields);Object.assign(meta,fields);updateMeta();});
      void run(control,async()=>{await hooks[action]?.({recipe,servings,button:control,element});});
    });
    const input=card.querySelector('[data-rc-photo]');input.addEventListener('change',()=>{const file=input.files?.[0];if(!file)return;void run(card.querySelector('[data-rc=photo]'),async()=>{const image=await hooks.photo(file);if(image){const hero=card.querySelector('.rc-hero');hero.querySelector('img')?.remove();hero.querySelector(':scope>span')?.remove();const img=document.createElement('img');img.src=image;img.alt=recipe.title;hero.prepend(img);hero.classList.remove('rc-without-photo');}}).finally(()=>{input.value='';});});
    const note=card.querySelector('#rc-note'),save=card.querySelector('.rc-note-save');note.addEventListener('input',()=>{save.hidden=note.value===String(recipe.notes||'');});
    card.querySelector('.rc-note-form').addEventListener('submit',event=>{event.preventDefault();const value=note.value;void run(save,async()=>{await hooks.saveNotes(value);recipe.notes=value;save.hidden=note.value===value;});});
    const onScroll=()=>card.classList.toggle('rc-scrolled',scroll.scrollTop>140);scroll.addEventListener('scroll',onScroll,{passive:true});onScroll();
    return {dispose:()=>scroll.removeEventListener('scroll',onScroll),servings:()=>servings,setNutrition:n=>{card.querySelector('[data-rc-nutrition]').innerHTML=nutrition(n);},sync:details=>{
      Object.assign(meta,details);updateMeta();
      if(Object.hasOwn(details,'photo')){const hero=card.querySelector('.rc-hero'),url=details.photo?.dataUrl||originalImage;hero.querySelector('img')?.remove();hero.querySelector(':scope>span')?.remove();if(url){const image=document.createElement('img');image.src=url;image.alt=recipe.title;hero.prepend(image);hero.classList.remove('rc-without-photo');}else{const label=document.createElement('span');label.textContent='Добавь фото блюда';hero.prepend(label);hero.classList.add('rc-without-photo');}}
    }};
  }
  window.RecipeReferenceCard=Object.freeze({render,mount,ingredients,numeric,escape:esc,icon});
})();
