// Source-backed features shared by the preference editor and dinner ranking.
import {pantryKey} from './dinner.js';
import {matchesIngredientConstraint} from './meal-request.js';
export const normalize=s=>String(s).toLocaleLowerCase('ru').replace(/ё/g,'е').replace(/\s+/g,' ').trim();
const meatTypes=[['chicken','курица'],['beef','говядина'],['pork','свинина'],['turkey','индейка']];
export const primaryKeys=names=>[...new Set(names.flatMap(name=>{
 const n=normalize(name);if(/тунец|тунц/u.test(n))return ['fish'];
 const key=pantryKey(name);if(key!=='mince')return [key||n];
 const types=meatTypes.filter(([,food])=>matchesIngredientConstraint(name,food)).map(([key])=>key);return types.length?types:['mince'];
}).filter(Boolean))];
const rules=[
 ['fry',/(?:обжарьте|обжаривайте|жарьте|жарите)/iu],
 ['boil',/(?:отварите|отваривайте|сварите|варите|вариться|доведите[^.!?;]{0,35}до[^.!?;]{0,20}кипения)/iu],
 ['stew',/(?:тушите|тушить|тушения|томите)/iu],
 ['bake',/(?:запекайте|запеките|выпекайте|духовк)/iu],
 ['steam',/(?:на пару(?!\s+(?:минут|секунд|час))|паровар|над кипящей водой|образовании пара)/iu],
 ['waffle-iron',/вафельниц/iu],
 ['blend',/блендер/iu],
 ['steep',/(?:залейте[^.!?]{0,50}кускус|кускус[^.!?]{0,30}кипятк)/iu]
];
// Reviewed implicit instructions. IDs select evidence, never recommendation winners.
const reviewed={
 'seed:soboro-don':[['fry',[2,3],'Мясо готовится на масле; яйца в сковороде на масле.']],
 'seed:it-pumpkin-frittata':[['fry',[2,4],'Тыква и яйцо готовятся на масле в сковороде до духовки.']],
 'seed:hu-cabbage-noodles':[['fry',[2,3],'Капуста в сковороде на масле до золотистого цвета.']],
 'seed:cn-cabbage-stirfry':[['fry',[3,4],'Капуста в сковороде на масле, сильный огонь и перемешивание.']],
 'seed:eu-spanish-tortilla':[['fry',[2,4,5],'Картофель и яйцо готовятся на масле в сковороде с переворотом.']],
 'seed:cn-vegetable-lo-mein':[['fry',[3,4],'Грибы и овощи готовятся на масле в сковороде.']],
 'seed:chickpea-beet-dip':[['warm',[2],'Готовые нут и свёкла прогреваются с водой под крышкой.']],
 'seed:ge-spinach-pkhali':[['warm',[1],'Шпинат прогревается до размораживания.']],
 'seed:tuna-salad':[['assemble',[1,2,3,4],'Готовый тунец и фасоль соединяются с овощами и заправкой.']],
 'seed:gr-horiatiki':[['assemble',[1,2,3,5],'Нарезанные овощи соединяются с фетой и заправкой.']],
 'seed:in-cucumber-raita':[['assemble',[1,3,4,5],'Огурец смешивается с йогуртом и подаётся холодным.']],
 'seed:jp-sunomono':[['assemble',[1,2,3,5],'Огурцы заправляются уксусом; основа подаётся холодной.']],
 'seed:cn-smacked-cucumber':[['assemble',[1,2,3,4,5],'Огурцы смешиваются с заправкой без нагрева.']]
};
export function methodsOf(recipe){
 const evidence=rules.flatMap(([method,re])=>recipe.steps.filter(step=>re.test(step.text)).map(step=>({method,position:step.position,text:step.text})));
 for(const [method,positions,reason]of reviewed[recipe.id]||[])for(const position of positions){
  const step=recipe.steps.find(s=>s.position===position);if(!step)throw Error('Missing evidence '+recipe.id+':'+position);
  evidence.push({method,position,text:step.text,reason,reviewed:true});
 }
 return {methods:[...new Set(evidence.map(e=>e.method))],evidence};
}
