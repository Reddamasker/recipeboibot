import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { catalogDaily } from '../src/web-catalog.js';

const shell=fs.readFileSync(new URL('../public/review/recime-20261109/shell.js',import.meta.url),'utf8');
const code=shell.slice(shell.indexOf('  const chips='),shell.indexOf('  function note('));
function harness(){
  let now=1000,handler=async()=>catalogDaily(new Date('2026-11-09T20:59:59Z'));
  const content={innerHTML:''},events=[],requests=[],timers=new Map(),listeners={};let timerId=0;
  const ui={section:'discover',catalog:null,catalogQuery:'',catalogFilter:null,catalogBusy:false,catalogError:'',catalogRevision:0,discoverySelected:{},discoveryGroups:[],catalogPage:1};
  const context={ui,Date:class extends Date{static now(){return now;}},URLSearchParams,AbortSignal,
    hasDiscovery:()=>Object.values(ui.discoverySelected).some(v=>v.length),RecipeDiscovery:{render:()=>''},
    document:{hidden:false,querySelector:()=>ui.section==='discover'?content:null,addEventListener:(name,fn)=>listeners[name]=fn},
    window:{addEventListener:(name,fn)=>listeners[name]=fn},
    setTimeout:(fn,ms)=>{timers.set(++timerId,{fn,ms});return timerId;},clearTimeout:id=>timers.delete(id),
    api:async url=>{requests.push(url);return handler(url);},
    RecipeAnalytics:{event:(...args)=>events.push(args),observe:(_el,...args)=>events.push(args),requestStarted:()=>events.push('request_started'),requestVisible:()=>events.push('request_visible')},
    esc:value=>String(value??''),safeImage:value=>value,num:value=>String(value),button:(action,label,icon,css,attrs)=>`<button data-review="${action}" ${attrs||''}>${label}</button>`,
    title:()=>'',searchField:()=>'',workspaceNotice:()=>'',setMarkup:html=>{content.innerHTML=html;},crypto:{randomUUID:()=> 'request-flow'},
  };
  vm.createContext(context);vm.runInContext(code,context);
  return {...context,content,events,requests,timers,listeners,setNow:value=>{now=value;},respond:fn=>{handler=fn;}};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));

test('spotlight uses the server recipe, all actions target it, midnight refresh emits no recipe-request events',async()=>{
  const h=harness();await h.loadCatalog(false);
  const first=h.ui.catalog.daily.recipe.id;
  assert.match(h.content.innerHTML,/Рецепт дня/);
  assert.equal((h.content.innerHTML.match(new RegExp(`data-recipe-id="${first}"`,'g'))||[]).length,3);
  assert.equal(h.ui.catalogExpiresAt,2000);
  assert.equal(h.timers.size,1);
  h.setNow(2001);h.respond(async()=>catalogDaily(new Date('2026-11-09T21:00:00Z')));
  h.refreshDailyCatalog();await settle();
  assert.notEqual(h.ui.catalog.daily.recipe.id,first);
  assert.equal(h.requests.length,2);assert.deepEqual(h.events,[]);
});

test('hidden screen waits for resume; revisiting before expiry reuses the same recipe',async()=>{
  const h=harness();await h.loadCatalog(false);
  h.refreshDailyCatalog();assert.equal(h.requests.length,1);
  h.setNow(3000);h.document.hidden=true;h.refreshDailyCatalog();assert.equal(h.requests.length,1);
  h.document.hidden=false;h.ui.section='collection';h.listeners.focus();assert.equal(h.requests.length,1);
  h.ui.section='discover';h.listeners.visibilitychange();await settle();assert.equal(h.requests.length,2);
});

test('late daily response cannot overwrite a newer search and refresh leaves filters intact',async()=>{
  const h=harness();let resolveDaily;
  h.respond(()=>new Promise(resolve=>{resolveDaily=resolve;}));const pending=h.loadCatalog(false);
  h.ui.catalogQuery='рис';h.respond(async()=>({recipes:[{id:'search-rice',title:'Рис',minutes:20}]}));
  await h.loadCatalog(true);resolveDaily(catalogDaily());await pending;
  assert.equal(h.ui.catalog.recipes[0].id,'search-rice');assert.match(h.content.innerHTML,/r-grid/);
  h.setNow(100000);h.refreshDailyCatalog();assert.equal(h.requests.length,2);
  assert.equal(h.ui.catalogBusy,false);
});

test('failed automatic refresh shows retry, backs off and recovers without losing the daily actions',async()=>{
  const h=harness();h.respond(async()=>{throw Error('Нет сети');});await h.loadCatalog(false);
  assert.match(h.content.innerHTML,/Нет сети/);assert.match(h.content.innerHTML,/retry-catalog/);
  assert.equal(h.ui.catalogExpiresAt,61000);assert.equal(h.timers.size,1);
  h.refreshDailyCatalog();assert.equal(h.requests.length,1);
  h.setNow(62000);h.respond(async()=>catalogDaily());h.refreshDailyCatalog();await settle();
  assert.equal(h.ui.catalogError,'');assert.match(h.content.innerHTML,/catalog-save/);
  assert.deepEqual(h.events,[]);
});

test('discovery conditions suppress daily refresh and empty/error outcomes never become visible recipes',async()=>{
  const h=harness();h.ui.discoverySelected={include:['курица'],diet:['plant']};
  h.respond(async()=>({recipes:[],total:0,page:1,pages:1}));await h.loadCatalog(true);
  assert.match(h.requests[0],/diet=plant/);assert.match(h.content.innerHTML,/По этим условиям/);
  assert.ok(h.events.some(e=>Array.isArray(e)&&e[0]==='screen_view'&&e[2].results===0));
  assert.ok(!h.events.includes('request_visible'));h.refreshDailyCatalog();assert.equal(h.requests.length,1);
  h.respond(async()=>{throw Error('Нет сети');});await h.loadCatalog(true);
  assert.ok(h.events.some(e=>Array.isArray(e)&&e[0]==='client_error'));
  assert.ok(!h.events.includes('request_visible'));assert.deepEqual(h.ui.discoverySelected,{include:['курица'],diet:['plant']});
});
