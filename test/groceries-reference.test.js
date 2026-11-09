import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
const context={window:{},URL,Intl,location:{origin:'https://example.test'}};
vm.runInNewContext(fs.readFileSync(new URL('../public/review/recime-20261109/groceries-view.js',import.meta.url),'utf8'),context);
const {categorize,groupItems,formatAmount,render}=context.window.GroceriesReference;
const plain=value=>JSON.parse(JSON.stringify(value));

test('grocery categories handle Russian morphology and English ingredient phrases without substring matches',()=>{
  for(const [category,names] of Object.entries({
    produce:['морковь','Свёкла','зелёный лук','огурцы','лимонная цедра','frozen mixed vegetables','bell pepper','spring onion'],
    protein:['chicken','chicken breast','chicken breasts','ground beef','ground turkey','куриные грудки','говядина','лосось','креветки'],
    dairy:['cottage cheese','egg whites','яйца','яиц','творог','сливочное масло','heavy cream','milk powder'],
    spices:['garlic powder','onion powder garlic powder black pepper','чеснок сушёный','соль','итальянские специи'],
    sauces:['soy sauce','reduced sugar ketchup / tomato sauce','соевый соус','томатная паста'],
    grains:['white rice','нут','красная чечевица','овсяные хлопья','макароны'],
    oils:['olive oil','rice wine vinegar','кунжутное масло','масло оливковое','яблочный уксус'],
    baking:['cornflour / cornstarch','пшеничная мука','сахар','разрыхлитель'],
    pantry:['fresh lemon juice','куриный бульон','peanut butter','coconut milk','мёд','тофу'],
    other:['toppings of your choice','ингредиент без категории','ирис','butterfly','',null]
  }))for(const name of names)assert.equal(categorize(name),category,String(name));
});

test('grouping never combines distinct products, compatible units or checked identities',()=>{
  const items=[{id:'a',name:'chicken',quantity:2,unit:'cup',checked:false},{id:'b',name:'chicken breast',quantity:600,unit:'g',checked:true},{id:'c',name:'chicken breasts',quantity:4,unit:'',checked:false},{id:'d',name:'Новый продукт',quantity:null,amountText:'по вкусу',manual:true}];
  const before=JSON.stringify(items),groups=plain(groupItems(items,[],'aisle')),rows=groups.flatMap(g=>g.items);
  assert.equal(rows.length,4);assert.deepEqual(rows.map(row=>row.id),['a','b','c','d']);
  assert.equal(rows[1].checked,true);assert.equal(rows[0].quantity,2);assert.equal(rows[1].quantity,600);assert.equal(rows[2].quantity,4);
  assert.equal(groups.at(-1).title,'Прочее');assert.equal(JSON.stringify(items),before);
});

test('recipe groups retain one global row for shared sources and put manual/unknown provenance in honest groups',()=>{
  const sources=[{id:'r1',title:'Первый рецепт'},{id:'r2',title:'Первый рецепт',stale:true}];
  const items=[{id:'single',name:'Молоко',provenance:[{sourceId:'r1'},{sourceId:'r1'}]},
    {id:'shared',name:'Соль',checked:true,provenance:[{sourceId:'r1'},{sourceId:'r2'}]},
    {id:'second',name:'Яйца',provenance:[{sourceId:'r2'}]},
    {id:'manual',name:'Хлеб',manual:true,provenance:[{sourceId:'manual'}]},
    {id:'missing',name:'Продукт',provenance:[{sourceId:'missing-source'}]}];
  const groups=plain(groupItems(items,sources,'recipe'));
  assert.deepEqual(groups.map(g=>[g.key,g.items.map(r=>r.id)]),[['source:r1',['single']],['source:r2',['second']],['shared',['shared']],['manual',['manual']],['other',['missing']]]);
  assert.equal(groups.flatMap(g=>g.items).filter(r=>r.id==='shared').length,1);
  assert.equal(groups.find(g=>g.key==='shared').items[0].checked,true);
  assert.equal(plain(groupItems(items,sources,'name')).length,1);
  assert.deepEqual(plain(groupItems([],sources,'name')),[]);
});

test('quantity labels preserve numbers, units and freeform uncertainty without invented totals',()=>{
  assert.equal(formatAmount({quantity:.5,unit:'кг'}),'0,5 кг');
  assert.equal(formatAmount({quantity:0,unit:'г'}),'0 г');
  assert.equal(formatAmount({quantity:.000001,unit:'г'}),'0,000001 г');
  assert.equal(formatAmount({quantity:2,unit:''}),'2');
  assert.equal(formatAmount({quantity:null,amountText:'1/2',unit:'cup'}),'1/2 cup');
  assert.equal(formatAmount({quantity:null,amountText:'по вкусу',unit:''}),'по вкусу');
  assert.equal(formatAmount({quantity:null,unit:'г'}),'Количество не указано · г');
  assert.equal(formatAmount({quantity:null}),'Количество не указано');
});

test('render escapes operational content, keeps checked/manual actions and represents missing sources',()=>{
  const html=render({items:[{id:'i" unsafe',name:'<script>unsafe</script>',quantity:null,amountText:'<b>по вкусу</b>',comment:'<img onerror=bad>',manual:true,checked:true}],
    sources:[{id:'s" unsafe',title:'<img src=x>',thumbnailUrl:'javascript:alert(1)',recipeAvailable:false,excludedCount:2},{id:'stale',title:'Изменённый',thumbnailUrl:'/image.jpg',stale:true}],noticeHtml:'<p class="trusted-notice">Ошибка загрузки</p>',sortMode:'recipe'});
  assert.match(html,/&lt;script&gt;/);assert.match(html,/&lt;img/);assert.doesNotMatch(html,/<script>|src="javascript:/);
  assert.match(html,/data-item-id="i&quot; unsafe"/);assert.match(html,/aria-checked="true"/);assert.match(html,/aria-label="Изменить продукт:/);
  assert.match(html,/Рецепт недоступен/);assert.match(html,/Рецепт изменён/);assert.match(html,/Исключено продуктов: 2/);
  assert.match(html,/<p class="trusted-notice">Ошибка загрузки<\/p>/);
  assert.equal((html.match(/class="gv-item is-checked"/g)||[]).length,1);
  assert.equal((html.match(/data-review="shopping-remove-source"/g)||[]).length,2);
  assert.match(html,/class="gv-source-count">2<\/span>/);
  assert.match(render({sources:[{id:'r',title:'Рецепт'}],recipesCollapsed:true}),/id="gv-source-rail" hidden/);
  assert.match(render(),/groceries\.svg\?v=original-1/);
  assert.doesNotMatch(render({loading:true}),/Пока нет продуктов|0 продуктов/);
});
