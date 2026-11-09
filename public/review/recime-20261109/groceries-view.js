(() => {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const categories = Object.freeze([
    ['produce','Овощи и фрукты'],['protein','Мясо и рыба'],['dairy','Молочное и яйца'],['spices','Травы и специи'],
    ['sauces','Соусы'],['grains','Крупы, макароны и бобовые'],['oils','Масла и уксус'],['baking','Мука и сахар'],['pantry','Бакалея'],['other','Прочее']
  ].map(([id,title]) => Object.freeze({id,title})));
  const normalize = name => String(name ?? '').normalize('NFKC').toLocaleLowerCase('ru-RU').replace(/ё/g,'е').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
  const word = source => new RegExp('(?:^| )(?:'+source+')(?= |$)','u');
  // Specific prepared products precede their raw ingredient names. These rules
  // classify only; the backend's item identities and quantities stay intact.
  const rules = [
    ['oils',word('(?:olive|sesame|sunflower|vegetable|rapeseed|canola|coconut|avocado|peanut) oil|oils?|vinegars?|уксус[а-я]*|масл[а-я]* (?:оливков[а-я]*|растительн[а-я]*|подсолнечн[а-я]*|кунжутн[а-я]*|кокосов[а-я]*|рапсов[а-я]*)|(?:оливков[а-я]*|растительн[а-я]*|подсолнечн[а-я]*|кунжутн[а-я]*|кокосов[а-я]*|рапсов[а-я]*) масл[а-я]*')],
    ['sauces',word('sauces?|ketchup|mayonnaise|mustard|pesto|sriracha|tahini|соус[а-я]*|кетчуп[а-я]*|майонез[а-я]*|горчиц[а-я]*|песто|шрирач[а-я]*|тахини|томатн[а-я]* паст[а-я]*')],
    ['pantry',word('juices?|broths?|stocks?|peanut butter|almond butter|coconut milk|coconut cream|canned|tinned|сок[аиу]?|бульон[а-я]*|арахисов[а-я]* паст[а-я]*|кокосов[а-я]* (?:молок[а-я]*|сливк[а-я]*)|консерв[а-я]*')],
    ['baking',word('flours?|cornflour|cornstarch|starch|sugars?|baking powder|baking soda|yeast|мук[аиу]|крахмал[а-я]*|сахар[а-я]*|разрыхлител[а-я]*|дрожж[а-я]*|сод[аыу]')],
    ['spices',word('(?:garlic|onion) (?:powder|granules)|seasonings?|spices?|herbs|порошок (?:чеснока|лука)|(?:чесночн[а-я]*|луков[а-я]*) порошок|(?:чеснок[а-я]*|лук[а-я]*) (?:сушен[а-я]*|сух[а-я]*|гранулированн[а-я]*)|(?:сушен[а-я]*|сух[а-я]*|гранулированн[а-я]*) (?:чеснок[а-я]*|лук[а-я]*)|приправ[а-я]*|специ[а-я]*')],
    ['produce',word('bell peppers?|sweet peppers?|перец (?:болгарск[а-я]*|сладк[а-я]*)|(?:болгарск[а-я]*|сладк[а-я]*) пер(?:ец|цы|ца)')],
    ['spices',word('salt|peppers?|paprika|cumin|coriander|turmeric|cinnamon|nutmeg|cloves|ginger|vanilla|oregano|thyme|rosemary|basil|parsley|dill|cilantro|mint|chili|chilli|bay leaves|соль|соли|перец|перца|паприк[а-я]*|зир[аыу]|тмин[а-я]*|кориандр[а-я]*|куркум[а-я]*|кориц[а-я]*|имбир[а-я]*|ванил[а-я]*|орегано|тимьян[а-я]*|розмарин[а-я]*|базилик[а-я]*|петрушк[а-я]*|укроп[а-я]*|кинз[а-я]*|мят[а-я]*|чили|лавров[а-я]*')],
    ['protein',word('chickens?|beef|pork|turkey|lamb|veal|duck|bacon|ham|sausages?|meat|fish|salmon|tuna|cod|trout|haddock|shrimp|prawns?|seafood|squid|mussels?|куриц[а-я]*|курин[а-я]*|цыплен[а-я]*|говядин[а-я]*|свинин[а-я]*|инд[ею]йк[а-я]*|баранин[а-я]*|телятин[а-я]*|утк[а-я]*|бекон[а-я]*|ветчин[а-я]*|колбас[а-я]*|сосиск[а-я]*|мяс[а-я]*|рыб[а-я]*|лосос[а-я]*|семг[а-я]*|тун[еца][а-я]*|треск[а-я]*|форел[а-я]*|креветк[а-я]*|морепродукт[а-я]*|кальмар[а-я]*|миди[а-я]*')],
    ['dairy',word('milk|cheese|eggs?|yog[hu]*urt|cream|butter|kefir|parmesan|mozzarella|feta|ricotta|молок[а-я]*|сыр[а-я]*|яйц[а-я]*|яиц|йогурт[а-я]*|сливк[а-я]*|сметан[а-я]*|творог[а-я]*|кефир[а-я]*|ряженк[а-я]*|пармезан[а-я]*|моцарелл[а-я]*|фет[аыу]|рикотт[а-я]*|сливочн[а-я]* масл[а-я]*|масл[а-я]* сливочн[а-я]*')],
    ['grains',word('rice|pasta|spaghetti|noodles?|macaroni|couscous|bulgur|quinoa|buckwheat|oats?|oatmeal|lentils?|beans?|chickpeas?|peas|barley|рис[а-я]*|макарон[а-я]*|паст[аы]|спагетти|лапш[а-я]*|кускус[а-я]*|булгур[а-я]*|киноа|греч[а-я]*|овес|овсян[а-я]*|чечевиц[а-я]*|фасол[а-я]*|нут[а-я]*|горох[а-я]*|перлов[а-я]*|пшен[а-я]*|круп[а-я]*')],
    ['produce',word('vegetables?|fruits?|tomatoes?|potatoes?|onions?|garlic|carrots?|cabbage|broccoli|cauliflower|cucumbers?|zucchini|courgette|aubergine|eggplant|pumpkin|squash|mushrooms?|spinach|lettuce|salad|celery|beetroot|beets?|corn|leeks?|avocados?|lemons?|limes?|apples?|bananas?|oranges?|pears?|berries|strawberries|raspberries|blueberries|grapes?|peaches?|mango|pineapple|овощ[а-я]*|фрукт[а-я]*|помидор[а-я]*|томат[а-я]*|картоф[а-я]*|лук[а-я]*|чеснок[а-я]*|морков[а-я]*|капуст[а-я]*|брокколи|огур[а-я]*|кабач[а-я]*|баклажан[а-я]*|тыкв[а-я]*|гриб[а-я]*|шампиньон[а-я]*|шпинат[а-я]*|салат[а-я]*|сельдере[а-я]*|свекл[а-я]*|кукуруз[а-я]*|порей|авокадо|лимон[а-я]*|лайм[а-я]*|яблок[а-я]*|банан[а-я]*|апельсин[а-я]*|груш[а-я]*|ягод[а-я]*|клубник[а-я]*|малин[а-я]*|черник[а-я]*|виноград[а-я]*|персик[а-я]*|манго|ананас[а-я]*')],
    ['pantry',word('honey|nuts?|almonds?|walnuts?|cashews?|peanuts?|seeds?|raisins?|dates|bread|breadcrumbs|crackers?|chocolate|cocoa|coffee|tea|jam|olives?|tofu|tempeh|мед[ау]?|орех[а-я]*|миндал[а-я]*|фундук[а-я]*|кешью|арахис[а-я]*|семечк[а-я]*|семен[а-я]*|изюм[а-я]*|финик[а-я]*|хлеб[а-я]*|сухар[а-я]*|шоколад[а-я]*|какао|кофе|чай|варень[а-я]*|джем[а-я]*|оливк[а-я]*|маслин[а-я]*|тофу|темпе')]
  ];
  function categorize(name) {const value = normalize(name);return rules.find(([,pattern]) => pattern.test(value))?.[0] || 'other';}
  const collator = new Intl.Collator('ru-RU',{numeric:true,sensitivity:'base'});
  const sorted = items => items.map((item,index) => ({item,index})).sort((a,b) => collator.compare(String(a.item.name ?? ''),String(b.item.name ?? '')) || a.index-b.index).map(row => row.item);
  function groupItems(items = [], sources = [], sortMode = 'aisle') {
    if (sortMode === 'name') return items.length ? [{key:'all',title:'',items:sorted(items)}] : [];
    if (sortMode !== 'recipe') {
      const buckets = new Map(categories.map(category => [category.id,[]]));
      for (const item of items) buckets.get(categorize(item.name)).push(item);
      return categories.map(category => ({key:category.id,title:category.title,items:sorted(buckets.get(category.id))})).filter(group => group.items.length);
    }
    const known = new Map(sources.map(source => [source.id,source]));
    const groups = new Map(sources.map(source => ['source:'+source.id,{key:'source:'+source.id,title:source.title || 'Рецепт недоступен',items:[]}]));
    for (const [key,title] of [['shared','Для нескольких рецептов'],['manual','Добавлено вручную'],['other','Прочее']]) groups.set(key,{key,title,items:[]});
    for (const item of items) {
      const sourceIds = [...new Set((item.provenance || []).map(row => row.sourceId).filter(id => typeof id === 'string' && id))];
      const key = item.manual ? 'manual' : sourceIds.length > 1 ? 'shared' : sourceIds.length === 1 && known.has(sourceIds[0]) ? 'source:'+sourceIds[0] : 'other';
      groups.get(key).items.push(item);
    }
    return [...groups.values()].filter(group => group.items.length).map(group => ({...group,items:sorted(group.items)}));
  }
  function formatAmount(item) {
    const unit = String(item.unit ?? '').trim();
    if (typeof item.quantity === 'number' && Number.isFinite(item.quantity)) return [item.quantity.toLocaleString('ru-RU',{maximumFractionDigits:12}),unit].filter(Boolean).join(' ');
    const amount = String(item.amountText || (typeof item.quantity === 'string' ? item.quantity : '')).trim();
    return amount ? [amount,unit].filter(Boolean).join(' ') : 'Количество не указано'+(unit?' · '+unit:'');
  }
  const paths = {
    share:'<path d="M7 8H4v13h16V8h-3M12 15V2m-4 4 4-4 4 4"/>',
    more:'<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>',
    up:'<path d="m5 15 7-7 7 7"/>',close:'<path d="m6 6 12 12M18 6 6 18"/>',
    sort:'<path d="M7 3v18m-4-4 4 4 4-4M17 21V3m-4 4 4-4 4 4"/>',
    plus:'<path d="M12 3v18M3 12h18"/>',check:'<path d="m5 12 5 5L20 7"/>',
    recipe:'<path d="M5 3h14v18H5ZM8 7h8m-8 5h8m-8 5h5"/>'
  };
  const icon = name => `<svg class="gv-icon" viewBox="0 0 24 24" aria-hidden="true">${paths[name]}</svg>`;
  function imageUrl(value) {if(typeof value !== 'string' || !value)return '';try{return ['http:','https:'].includes(new URL(value,location.origin).protocol)?value:'';}catch{return '';}}
  const plural = n => n%100>=11&&n%100<=14?'продуктов':n%10===1?'продукт':n%10>=2&&n%10<=4?'продукта':'продуктов';
  function sourceCard(source) {
    const title = source.title || 'Рецепт недоступен', image = imageUrl(source.thumbnailUrl);
    const status = source.recipeAvailable === false ? 'Рецепт недоступен' : source.stale ? 'Рецепт изменён' : '';
    const details = [status,Number.isSafeInteger(source.excludedCount)&&source.excludedCount>0?'Исключено продуктов: '+source.excludedCount:''].filter(Boolean).join('. ');
    return `<article class="gv-source-card"><button type="button" class="gv-source-open" data-review="shopping-source" data-source-id="${esc(source.id)}" aria-label="${esc(title)}${details?'. '+esc(details):''}">${image?`<img class="gv-source-image" src="${esc(image)}" alt="" loading="lazy" draggable="false">`:`<span class="gv-source-image gv-source-placeholder">${icon('recipe')}</span>`}<span class="gv-source-text"><strong>${esc(title)}</strong>${status?`<small>${esc(status)}</small>`:''}</span></button><button type="button" class="gv-source-remove" data-review="shopping-remove-source" data-source-id="${esc(source.id)}" aria-label="Убрать продукты рецепта: ${esc(title)}">${icon('close')}</button></article>`;
  }
  function itemRow(item) {
    const checked = item.checked === true, name = String(item.name ?? '');
    return `<article class="gv-item${checked?' is-checked':''}" data-item-id="${esc(item.id)}"><button type="button" class="gv-item-details" data-review="item-actions" data-item-id="${esc(item.id)}" aria-label="${item.manual?'Изменить продукт: ':'Действия с продуктом: '}${esc(name)}"><span class="gv-item-name">${esc(name)}</span><span class="gv-item-amount">${esc(formatAmount(item))}</span>${item.comment?`<span class="gv-item-comment">${esc(item.comment)}</span>`:''}</button><button type="button" class="gv-check" role="checkbox" aria-checked="${checked}" aria-label="${checked?'Снять отметку: ':'Отметить купленным: '}${esc(name)}" data-review="check-item" data-item-id="${esc(item.id)}"><span>${checked?icon('check'):''}</span></button></article>`;
  }
  function render({items = [],sources = [],loading = false,noticeHtml = '',recipesCollapsed = false,sortMode = 'aisle'} = {}) {
    const groups = groupItems(items,sources,sortMode), sortLabel = {aisle:'Категории',name:'По названию',recipe:'По рецептам'}[sortMode] || 'Категории';
    const rail = sources.length ? `<section class="gv-sources${recipesCollapsed?' is-collapsed':''}"><button type="button" class="gv-sources-toggle" data-review="shopping-collapse" aria-expanded="${!recipesCollapsed}" aria-controls="gv-source-rail"><span>Рецепты</span><span class="gv-source-count">${sources.length}</span>${icon('up')}</button><div class="gv-source-rail" id="gv-source-rail" ${recipesCollapsed?'hidden':''} aria-label="Рецепты в списке покупок">${sources.map(sourceCard).join('')}</div></section>` : '';
    const content = groups.length ? groups.map(group => `<section class="gv-category"${group.title?` aria-label="${esc(group.title)}"`:''}>${group.title?`<h2>${esc(group.title)}</h2>`:''}${group.items.map(itemRow).join('')}</section>`).join('') : loading ? '<p class="gv-loading" role="status">Загружаем список…</p>' : '<div class="gv-empty"><img src="/review/recime-20261109/groceries.svg?v=original-1" alt=""><h2>Пока нет продуктов</h2><p>Нажми «+», чтобы добавить продукты</p></div>';
    return `<section class="gv-view"><header class="gv-header"><h1>Список покупок</h1><div class="gv-header-actions"><button type="button" class="gv-round" data-review="shopping-share" aria-label="Поделиться списком" ${loading||!items.length?'disabled':''}>${icon('share')}</button><button type="button" class="gv-round" data-review="shopping-more" aria-label="Ещё действия" aria-haspopup="dialog">${icon('more')}</button></div></header>${rail}<div class="gv-toolbar"><p>${loading&&!items.length?'Загружаем…':items.length+' '+plural(items.length)}</p><button type="button" class="gv-sort" data-review="shopping-sort" aria-haspopup="dialog" ${loading?'disabled':''}>${icon('sort')}<span>${sortLabel}</span></button></div>${noticeHtml?`<div class="gv-notice">${noticeHtml}</div>`:''}<main class="gv-panel" aria-busy="${Boolean(loading)}">${content}</main>${!items.length&&!loading?'<img class="gv-empty-arrow" src="/review/recime-20261109/arrow.svg" alt="">':''}<button type="button" class="gv-add" data-review="shopping-add" aria-label="Добавить продукт" ${loading?'disabled':''}>${icon('plus')}</button></section>`;
  }
  // State changes belong to the shell's existing delegated action handler.
  window.GroceriesReference = Object.freeze({render,categorize,groupItems,formatAmount,categories});
})();
