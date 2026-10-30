import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {catalogSearch} from '../src/web-catalog.js';

const source=fs.readFileSync(new URL('../public/catalog.js',import.meta.url),'utf8');
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function browser({deferred=false}={}) {
  const nodes=new Map(),listeners={},requests=[],actions=[],observed=[];
  const node=()=>({dataset:{},hidden:false,value:'',innerHTML:'',textContent:'',attributes:{},handlers:{},
    setAttribute(k,v){this.attributes[k]=v;},addEventListener(k,v){this.handlers[k]=v;},append(){},before(){},after(){},add(){},focus(){},scrollIntoView(){}});
  const get=selector=>{if(!nodes.has(selector))nodes.set(selector,node());return nodes.get(selector);};
  const location={origin:'http://localhost',pathname:'/dinner',search:'?campaign=qa-variant2'};
  const document={body:node(),activeElement:null,querySelector:get,querySelectorAll:()=>[],createElement:node,addEventListener:(k,v)=>listeners[k]=v};
  const window={addEventListener:(k,v)=>listeners[k]=v,scrollTo(){},CatalogDetail:{begin(){},mount(){},action:(...args)=>actions.push(args)},
    RecipeAnalytics:{event(){},observe:(element,event,step,detail)=>observed.push({html:element.innerHTML,event,detail})}};
  const history={pushState(_state,_title,url){const next=new URL(url,location.origin);location.pathname=next.pathname;location.search=next.search;},replaceState(...args){this.pushState(...args);}};
  const fetch=(url,{signal})=>new Promise((resolve,reject)=>{const item={url,signal,resolve:()=>resolve({ok:true,json:async()=>catalogSearch(new URL(url,location.origin).searchParams)}),reject};requests.push(item);if(!deferred)item.resolve();});
  vm.runInNewContext(source,{window,document,location,history,fetch,URL,URLSearchParams,AbortController,Option:function(){},localStorage:{getItem:()=>null,setItem(){}},matchMedia:()=>({matches:true,addEventListener(){}}),setTimeout,clearTimeout});
  return {nodes,requests,actions,observed,location,get,
    click(dataset){const target={dataset,matches:()=>false,hasAttribute:name=>Object.hasOwn(dataset,name.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase()))};target.closest=()=>target;listeners.click({target,button:0});},
    reset(){get('#visual-reset').handlers.click();}
  };
}

test('approved product choices filter real recipes; individual removal preserves other filters and campaign',async()=>{
  const b=browser();await settle();
  assert.equal(b.get('#results-title').textContent,'Все рецепты');
  assert.equal((b.get('#ingredient-chips').innerHTML.match(/class="ingredient-chip"/g)||[]).length,12);
  assert.equal((b.get('#cuisine-tiles').innerHTML.match(/<img /g)||[]).length,6);
  b.click({visualFilter:'include',value:'картофель'});await settle();
  b.click({visualFilter:'include',value:'курица'});await settle();
  assert.equal(b.get('#result-count').textContent,'Найдено: 3');
  assert.equal(b.get('#results-title').textContent,'Подходящие рецепты');
  assert.equal(b.get('#selection-label').textContent,'Выбрано 2 продукта');
  b.click({visualFilter:'cuisine',value:'japanese'});await settle();
  assert.equal(b.get('#result-count').textContent,'Найдено: 0');
  assert.match(b.get('#cards').innerHTML,/data-remove="cuisine"/);
  b.click({remove:'cuisine'});await settle();
  assert.equal(b.get('#result-count').textContent,'Найдено: 3');
  b.click({remove:'include',product:'картофель'});await settle();
  assert.equal(new URLSearchParams(b.location.search).get('include'),'курица');
  b.reset();await settle();
  assert.equal(b.get('#selection-state').hidden,true);
  assert.equal(new URLSearchParams(b.location.search).get('campaign'),'qa-variant2');
  assert.equal(b.actions.filter(([action])=>action==='filter_change').length,5);
  assert.equal(b.actions.at(-1)[0],'filter_reset');
  assert.doesNotMatch(JSON.stringify(b.actions),/картофель|курица|japanese/);
  assert.ok(b.observed.every(item=>!item.html.includes('catalog-skeleton')),'loading placeholders are not counted as results');
});

test('fast successive choices immediately update controls and late responses cannot restore stale results',async()=>{
  const b=browser({deferred:true});b.requests[0].resolve();await settle();
  b.click({visualFilter:'include',value:'картофель'});
  assert.match(b.get('#cards').innerHTML,/catalog-skeleton/);
  b.click({visualFilter:'include',value:'курица'});
  assert.equal(b.requests[1].signal.aborted,true);
  assert.equal(b.get('#selection-label').textContent,'Выбрано 2 продукта');
  b.requests[2].resolve();await settle();b.requests[1].resolve();await settle();
  assert.equal(b.get('#result-count').textContent,'Найдено: 3');
  assert.equal(b.get('#cards').attributes['aria-busy'],'false');
});

test('failed filter request shows retry and preserves selected products without counting a result',async()=>{
  const b=browser({deferred:true});b.requests[0].resolve();await settle();
  b.click({visualFilter:'include',value:'морковь'});b.requests[1].reject(new Error('Connection unavailable'));await settle();
  assert.equal(b.get('#cards').attributes['aria-busy'],'false');
  assert.match(b.get('#cards').innerHTML,/data-retry/);
  assert.equal(b.get('#selection-label').textContent,'Выбрано 1 продукт');
  assert.equal(b.observed.length,1);
  b.click({retry:''});b.requests[2].resolve();await settle();
  assert.ok(Number(b.get('#result-count').textContent.split(': ')[1])>0);
  assert.equal(b.observed.length,2);
});
