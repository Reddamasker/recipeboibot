import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const catalogSource=fs.readFileSync(new URL('../public/catalog.js',import.meta.url),'utf8');
const analyticsSource=fs.readFileSync(new URL('../public/analytics.js',import.meta.url),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));

function browser(search='?benefits=preview&cuisine=italian', {failFirst=false}={}) {
  const nodes=new Map(),listeners={},opens=[],observations=[],replaces=[],requests=[];
  const element=()=>({dataset:{},style:{},addEventListener(){},setAttribute(){},before(){},value:'',innerHTML:'',textContent:''});
  const node=selector=>{if(!nodes.has(selector))nodes.set(selector,element());return nodes.get(selector);};
  const location={pathname:'/recipes/pasta',search,hash:'#recipe',origin:'https://catalog.example'};
  const history={state:{preserved:true},replaceState(state,unused,url){replaces.push(url);this.state=state;const parsed=new URL(url,location.origin);location.pathname=parsed.pathname;location.search=parsed.search;location.hash=parsed.hash;}};
  const document={body:element(),querySelector:node,querySelectorAll:()=>[],createElement:element,addEventListener:(name,fn)=>{listeners['document:'+name]=fn;}};
  const window={RecipeAnalytics:{observe:(...args)=>observations.push(args)},CatalogBenefits:{close(){},open(recipe,options){opens.push({recipe,options});return true;}},addEventListener:(name,fn)=>{listeners[name]=fn;}};
  const sandbox={document,window,location,history,URL,URLSearchParams,AbortController,Intl,Set,FormData,localStorage:{getItem:()=>null},matchMedia:()=>({matches:false,addEventListener(){}}),
    fetch:async url=>{requests.push(url);if(failFirst&&requests.length===1)throw new Error('offline');return {ok:true,json:async()=>({id:'pasta',title:'Паста',description:'Рецепт',minutes:15,servings:2,ingredients:[],steps:[]})};}};
  vm.runInNewContext(catalogSource,sandbox);
  const retry=()=>{const button={dataset:{},matches:()=>false,hasAttribute:name=>name==='data-retry'};listeners['document:click']({target:{closest:()=>button}});};
  return {location,history,listeners,opens,observations,replaces,requests,retry};
}

test('failed review fetch retains intent for Retry and consumes it only after successful rendering',async()=>{
  const b=browser('?benefits=preview',{failFirst:true});await tick();
  assert.equal(b.location.search,'');assert.equal(b.opens.length,0);assert.equal(b.observations.length,0);
  b.retry();await tick();assert.equal(b.requests.length,2);assert.equal(b.opens.length,1);assert.equal(b.opens[0].options.automatic,false);
  assert.equal(b.observations.length,0);b.opens[0].options.afterClose();assert.equal(b.observations.length,1);
  b.listeners.popstate({});await tick();assert.equal(b.opens.length,1);
});

test('leaving a failed preview abandons the pending intent for other recipes and Back',async()=>{
  const b=browser('?benefits=preview',{failFirst:true});await tick();
  b.location.pathname='/recipes/soup';b.listeners.popstate({});await tick();assert.equal(b.opens.length,0);
  b.location.pathname='/recipes/pasta';b.listeners.popstate({});await tick();assert.equal(b.opens.length,0);
});

test('review recipe link bypasses seen flag once, preserves filters and defers recipe observation until close',async()=>{
  const b=browser();await tick();
  assert.equal(b.opens.length,1);assert.equal(b.opens[0].options.automatic,false);
  assert.deepEqual(b.requests,['/api/catalog/pasta']);assert.deepEqual(b.replaces,['/recipes/pasta?cuisine=italian#recipe']);
  assert.deepEqual(b.history.state,{preserved:true});assert.equal(b.observations.length,0);
  b.opens[0].options.afterClose();b.opens[0].options.afterClose();assert.equal(b.observations.length,1);
  b.listeners.popstate({});await tick();assert.equal(b.opens.length,1,'history re-entry does not reopen the review');
});

test('ordinary direct recipe link and unknown preview value preserve ordinary behavior',async()=>{
  for(const query of ['', '?benefits=other']){
    const b=browser(query);await tick();assert.equal(b.opens.length,0);assert.equal(b.observations.length,1);assert.equal(b.replaces.length,0);
  }
});

test('review analytics is inert for the whole document and does not touch a stored queue',async()=>{
  const forbidden=()=>{throw new Error('Review telemetry must not run');};
  const location={pathname:'/recipes/pasta',search:'?benefits=preview'},window={addEventListener:forbidden};
  const sandbox={location,window,URLSearchParams,Promise,sessionStorage:{getItem:forbidden,setItem:forbidden},document:{addEventListener:forbidden},fetch:forbidden,setTimeout:forbidden,setInterval:forbidden,crypto:{randomUUID:forbidden}};
  vm.runInNewContext(analyticsSource,sandbox);
  const api=window.RecipeAnalytics;
  for(const search of ['?benefits=preview','', '?cuisine=italian']){
    location.search=search;
    api.event('benefits_view','catalog');api.observe({});api.setUser('review');api.requestStarted('flow','request');api.requestVisible({});api.step('catalog');api.health();
    assert.equal(api.visible({}),false);await api.receipt({eventId:'review'});
  }
});
