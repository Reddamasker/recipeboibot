(() => {
  const esc=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const descriptions={include:'Что есть дома',meal:'От завтрака до десерта',diet:'По составу блюда',cuisines:'Знакомые и новые вкусы',occasion:'На каждый день и для гостей',method:'Выбери удобный способ'};
  const photos={курица:'ingredients-v2/chicken',яйца:'ingredients-v2/egg',картофель:'ingredients-v2/potato',гречка:'ingredients-v4/buckwheat',рис:'ingredients-v2/rice',макароны:'ingredients-v3/pasta',фарш:'variant2/mince',творог:'ingredients-v4/curd',капуста:'ingredients-v4/cabbage',морковь:'variant2/carrot',свёкла:'ingredients-v4/beet',кабачок:'ingredients-v4/zucchini',грибы:'ingredients-v2/mushroom',помидоры:'ingredients-v2/tomato',огурцы:'ingredients-v4/cucumber',свинина:'ingredients-v2/pork',говядина:'ingredients-v2/beef',рыба:'ingredients-v2/fish',молоко:'ingredients-v4/milk',сыр:'ingredients-v2/cheese',фасоль:'ingredients-v4/beans',горох:'ingredients-v4/peas',чечевица:'ingredients-v4/lentils',яблоки:'ingredients-v4/apple'};
  function render(groups, selected){
    if(!groups?.length)return '';
    const count=Object.values(selected).reduce((n,v)=>n+v.length,0);
    return `<section class="d-discovery" aria-label="Подбор по условиям"><h2>Что будем готовить?</h2><div class="d-groups">${groups.map(g=>`<button type="button" class="d-group d-${g.id}" data-review="discovery-filter" data-group="${esc(g.id)}"><strong>${esc(g.label)}</strong><span>${selected[g.id]?.length?esc(g.choices.filter(c=>selected[g.id].includes(c.id)).map(c=>c.label).join(', ')):descriptions[g.id]}</span></button>`).join('')}</div>${count?`<div class="d-selection"><span>Выбрано условий: ${count}</span><button type="button" data-review="discovery-clear">Сбросить всё</button></div>`:''}</section>`;
  }
  function open(group, selected, apply){
    const draft=new Set(selected||[]), dialog=document.createElement('dialog');
    dialog.className='d-filter-sheet';dialog.setAttribute('aria-label',group.label);
    dialog.innerHTML=`<header><h2>${esc(group.label)}</h2><button type="button" data-close aria-label="Закрыть">×</button></header><label class="d-filter-search"><span class="d-sr">Найти вариант</span><input type="search" placeholder="${group.id==='include'?'Что есть в холодильнике?':'Найти вариант'}" maxlength="80"></label><p class="d-filter-help">${group.id==='include'?'В рецепте будут все выбранные продукты.':group.id==='diet'?'Условия применяются вместе. Проверяй состав и маркировку продуктов.':'Можно выбрать несколько вариантов.'}${group.id==='occasion'?' Подбор по времени, порциям и типу блюда.':''}</p><div class="d-filter-options"></div><footer><button type="button" data-clear>Сбросить</button><button type="button" data-apply>Применить</button></footer>`;
    const list=dialog.querySelector('.d-filter-options'), input=dialog.querySelector('input');
    const draw=()=>{
      const query=input.value.toLocaleLowerCase('ru').replaceAll('ё','е').trim();
      const choices=group.choices.filter(c=>c.label.toLocaleLowerCase('ru').replaceAll('ё','е').includes(query));
      const row=(c,photo=false)=>`<label>${photo?`<img src="/assets/filters/${photos[c.id]}.webp" width="72" height="64" alt="">`:''}<span>${esc(c.label)}${c.count===0?'<small>Рецептов пока нет</small>':''}</span><input type="checkbox" value="${esc(c.id)}" ${draft.has(c.id)?'checked':''} ${c.count===0&&!draft.has(c.id)?'disabled':''}></label>`;
      list.innerHTML=!choices.length?'<p>Ничего не найдено. Попробуй другое название.</p>':group.id==='include'?`<div class="d-products">${choices.map(c=>row(c,true)).join('')}</div>`:choices.map(c=>row(c)).join('');
      dialog.querySelector('[data-apply]').textContent=draft.size?`Применить (${draft.size})`:'Применить';
    };
    list.onchange=e=>{if(e.target.checked){if(draft.size>=12){e.target.checked=false;return;}draft.add(e.target.value);}else draft.delete(e.target.value);dialog.querySelector('[data-apply]').textContent=draft.size?`Применить (${draft.size})`:'Применить';};
    input.oninput=draw;
    dialog.querySelector('[data-clear]').onclick=()=>{draft.clear();draw();};
    dialog.querySelector('[data-close]').onclick=()=>dialog.close();
    dialog.querySelector('[data-apply]').onclick=()=>{dialog.close();apply([...draft]);};
    dialog.addEventListener('close',()=>dialog.remove(),{once:true});
    document.body.append(dialog);draw();dialog.showModal();dialog.querySelector('[data-close]').focus();
    window.RecipeAnalytics?.observe(dialog,'screen_view','other');
  }
  window.RecipeDiscovery={render,open};
})();
