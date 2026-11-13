// Explicit catalog facets. Groups combine with AND; alternatives within a group
// combine with OR, except products and dietary conditions which all must match.
const group = (id, label, choices) => ({id,label,choices:choices.map(([id,label])=>({id,label}))});
export const discoveryGroups = [
  group('include','Продукты',['Курица','Яйца','Картофель','Гречка','Рис','Макароны','Фарш','Творог','Капуста','Морковь','Свёкла','Кабачок','Грибы','Помидоры','Огурцы','Свинина','Говядина','Рыба','Молоко','Сыр','Фасоль','Горох','Чечевица','Яблоки'].map(x=>[x.toLocaleLowerCase('ru'),x])),
  group('meal','Тип блюда',[['breakfast','Завтрак'],['soup','Суп'],['main','Горячее'],['salad','Салат'],['side','Гарнир'],['snack','Закуска'],['baking','Выпечка'],['dessert','Десерт']]),
  group('diet','Питание',[['vegetarian','Без мяса и рыбы'],['plant','Постное'],['dairy_free','Без молочных продуктов']]),
  group('cuisines','Кухня',[['russian','Русская'],['everyday','Домашняя'],['georgian','Грузинская'],['uzbek','Узбекская'],['ukrainian','Украинская'],['belarusian','Белорусская'],['italian','Итальянская'],['japanese','Японская'],['chinese','Китайская'],['greek','Греческая'],['turkish','Турецкая'],['indian','Индийская'],['hungarian','Венгерская'],['lebanese','Ливанская']]),
  group('occasion','Повод',[['quick','Ужин после работы'],['batch','На несколько дней'],['guests','К приходу гостей'],['picnic','На пикник'],['tea','К чаю']]),
  group('method','Как готовить',[['pan','На сковороде'],['oven','В духовке'],['pot','В кастрюле'],['multicooker','В мультиварке'],['grill','На мангале или гриле'],['steam','На пару'],['no_cook','Без готовки']]),
];
const meat = /мяс|куриц|курин|индей|говя|свинин|свин[оы]|баранин|фарш|бекон|ветчин|колбас|сосиск|(?:^|\s)сал[оа](?:\s|$)|печен|печён|сердеч|утк|кролик|желатин/iu;
const fish = /рыб|лосос|семг|сёмг|треск|минта|форел|тун[еёц]|сельд|анчоус|сардин|скумбр|кревет|кальмар|мидии|морепродукт|краб|икра|устрич/iu;
const dairy = /молок|молоч|сливк|сливоч|сметан|сыр|творог|творож|кефир|йогурт|ряжен|простокваш|брынз|моцарел|пармезан|фета|маскарпоне|масло гхи/iu;
const cache=new WeakMap();
function classifications(r) {
  if(cache.has(r))return cache.get(r);
  const title=r.title.toLocaleLowerCase('ru'), tags=(r.tags||[]).join(' '), steps=r.steps.join(' '), names=r.ingredients.map(i=>i.name).join(' ');
  const salad=r.categories.includes('salad'), soup=r.categories.includes('soup');
  const breakfast=/омлет|яичниц|сырник|каша|олад|блин|завтрак/iu.test(title+' '+tags);
  const dessert=/десерт|торт|пирожн|печень|кекс|сладк|шарлот|запеканка.*творо|творожная запеканка/iu.test(title+' '+tags);
  const baking=r.categories.includes('baking')||/выпечк|пирог|булоч|лепеш|лепёш/iu.test(title+' '+tags);
  const side=/гарнир/iu.test(tags)||/^(рис|гречка|картофельное пюре|булгур|овощи)/iu.test(title)&&!meat.test(names)&&!fish.test(names);
  const snack=/закуск|хумус|паштет|бутерброд|брускет|намазк/iu.test(title+' '+tags);
  const noMeat=!meat.test(names)&&!fish.test(names)&&!/(?:^|\s)бульон/iu.test(names.replace(/овощной бульон/giu,''));
  const noDairy=!dairy.test(names);
  const heated=/жар|вари|варит|варк|кип|туш|запек|выпек|духов|нагре|разогре|грил|мангал|микроволн|мультиварк|на пару/iu.test(steps);
  const result = {
    meal:{breakfast,soup,main:!soup&&!salad&&!dessert&&!snack&&!side&&!breakfast, salad,side,snack,baking,dessert},
    diet:{vegetarian:noMeat,plant:noMeat&&noDairy&&!/яйц|яич|мед|мёд|майонез/iu.test(names),dairy_free:noDairy},
    occasion:{quick:r.minutes<=30&&!dessert,batch:r.minutes<=90&&(soup||/рагу|туш|плов|котлет/iu.test(title)),guests:r.servings>=4,picnic:!soup&&(baking||snack),tea:dessert||baking&&/яблок|ягод|сахар|творог/iu.test(names)},
    method:{pan:/сковород/iu.test(steps),oven:/духов|духовом|запекайте|запеките|выпекайте/iu.test(steps),pot:/кастрюл/iu.test(steps),multicooker:/мультиварк/iu.test(steps),grill:/мангал|грил/iu.test(steps),steam:/на пару|паровар/iu.test(steps),no_cook:!heated},
  };
  cache.set(r,result);return result;
}
export function matchesDiscovery(recipe, params) {
  const facets=classifications(recipe);
  return discoveryGroups.filter(g=>g.id!=='include').every(g=>{
    const selected=String(params.get(g.id)||'').slice(0,250).split(',').filter(Boolean).slice(0,12);
    const match=id=>g.choices.some(c=>c.id===id)&&(g.id==='cuisines'?recipe.cuisineId===id:Boolean(facets[g.id]?.[id]));
    return !selected.length||(g.id==='diet'?selected.every(match):selected.some(match));
  });
}
