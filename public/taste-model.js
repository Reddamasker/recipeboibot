var TasteFlow=(()=>{
 function create(items,order){
  const recipes=items.filter(i=>i.kind==='recipe'),byKey=new Map(recipes.map(i=>[i.key,i])),index=new Map(order.map((k,i)=>[k,i]));
  const unique=values=>[...new Set(values||[])],frequency=new Map();
  for(const item of recipes)for(const name of unique(item.ingredients))frequency.set(name,(frequency.get(name)||0)+1);
  const idf=name=>1+Math.log((recipes.length+1)/((frequency.get(name)||0)+1));
  function profile(choices={}){
   const result={ingredients:{},methods:{},primary:{}};
   for(const [key,value]of Object.entries(choices)){
    const item=byKey.get(key);if(!item||value!==1)continue;
    for(const name of unique(item.ingredients))result.ingredients[name]=(result.ingredients[name]||0)+1;
    for(const method of unique(item.methods))result.methods[method]=(result.methods[method]||0)+1;
    for(const name of unique(item.primary))result.primary[name]=(result.primary[name]||0)+1;
   }
   return result;
  }
  function cosine(features,weights,weightOf=()=>1){
   const names=unique(features);let product=0,itemNorm=0,profileNorm=0;
   for(const [name,value]of Object.entries(weights||{}))profileNorm+=(value*weightOf(name))**2;
   for(const name of names){const weight=weightOf(name);itemNorm+=weight**2;product+=(weights?.[name]||0)*weight**2;}
   return itemNorm&&profileNorm?product/Math.sqrt(itemNorm*profileNorm):0;
  }
  function score(item,p){
   const ingredients=cosine(item.ingredients,p.ingredients,idf),methods=cosine(item.methods,p.methods);
   if(!Object.keys(p.primary||{}).length)return .8*ingredients+.2*methods;
   const primary=cosine(item.primary,p.primary);
   // A matching main ingredient takes priority over any number of secondary matches.
   return (primary>0?1:0)+.7*primary+.2*ingredients+.1*methods;
  }
  const avoid=(item,choices={})=>!item||item.kind!=='recipe'||choices[item.key]===-1;
  function recommend(choices={}){
   const p=profile(choices),liked=Object.keys(choices).filter(k=>choices[k]===1&&byKey.has(k));
   return recipes.filter(i=>!choices[i.key]&&(!liked.length||liked.some(k=>compatible(k,i.key)))).map(i=>({key:i.key,score:score(i,p)}))
    .sort((a,b)=>b.score-a.score||(index.get(a.key)??9999)-(index.get(b.key)??9999)).map(i=>i.key);
  }
  const proteins=new Set(['chicken','beef','pork','turkey','fish','tuna','mince']);
  function compatible(a,b){
   const first=unique(byKey.get(a)?.primary).filter(Boolean),second=unique(byKey.get(b)?.primary).filter(Boolean);
   const animal=first.filter(k=>proteins.has(k)),otherAnimal=second.filter(k=>proteins.has(k));
   // A shared side dish cannot substitute the selected meat or fish.
   if(animal.length)return animal.some(k=>otherAnimal.includes(k))&&otherAnimal.every(k=>animal.includes(k));
   return first.some(k=>second.includes(k));
  }
  function related(key,value,choices={}){
   if(value!==1||choices[key]!==1||!byKey.has(key))return [];
   // A local refinement must explain this click; the full profile only ranks compatible dishes.
   return recommend(choices).filter(candidate=>compatible(key,candidate));
  }
  const validKeys=keys=>unique(Array.isArray(keys)?keys:[]).filter(k=>byKey.has(k));
  function prune(shown,choices={},branches={},refresh=''){
   const next=validKeys(shown),owned=new Set(),kept=new Set(),clean={};
   for(const [key,children]of Object.entries(branches||{})){
    const valid=validKeys(children).filter(k=>k!==key);valid.forEach(k=>owned.add(k));
    if(choices[key]!==1||key===refresh||!next.includes(key))continue;
    const keep=valid.filter(k=>next.includes(k)&&!choices[k]&&compatible(key,k)&&!kept.has(k));
    if(keep.length){clean[key]=keep;keep.forEach(k=>kept.add(k));}
   }
   const retained=next.filter(k=>choices[k]||!owned.has(k)||kept.has(k));
   for(const k of Object.keys(choices))if(byKey.has(k)&&!retained.includes(k))retained.push(k);
   return {shown:retained,branches:clean};
  }
  function expand(shown,key,value,choices={},branches={}){
   const cleaned=prune(shown,choices,branches,key),next=cleaned.shown;
   if(byKey.has(key)&&!next.includes(key))next.unshift(key);
   const added=related(key,value,choices).filter(k=>!next.includes(k)).slice(0,4);
   next.splice(Math.max(0,next.indexOf(key)+1),0,...added);
   if(added.length)cleaned.branches[key]=added;
   return {shown:next,added,branches:cleaned.branches};
  }
  function restore(state,choices={},pageSize=24){
   const anchor=byKey.has(state?.anchor)&&choices[state.anchor]===1?state.anchor:'';
   if(state?.version===2&&Array.isArray(state.shown)){
    const cleaned=prune(state.shown,choices,state.branches);
    if(cleaned.shown.length)return {...cleaned,anchor,added:[]};
   }
   // Older flat drafts cannot distinguish stale insertions. Keep every explicit rating.
   const shown=validKeys([...order.slice(0,pageSize),...Object.keys(choices)]);
   return anchor?{...expand(shown,anchor,1,choices),anchor}:{shown,anchor:'',branches:{},added:[]};
  }
  return {byKey,profile,score,recommend,related,expand,restore,compatible,avoid};
 }
 return {create};
})();

export { TasteFlow };
