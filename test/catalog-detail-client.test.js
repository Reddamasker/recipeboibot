import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {randomUUID} from 'node:crypto';

const source=fs.readFileSync(new URL('../public/catalog-journey-detail.js',import.meta.url),'utf8');
const queueSource=fs.readFileSync(new URL('../public/analytics.js',import.meta.url),'utf8');
const handoffSource=fs.readFileSync(new URL('../public/catalog-handoff.js',import.meta.url),'utf8');
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const {catalogSelection}=await import('../src/catalog-selection.js');
function browser({hidden=false,pathname='/dinner',search='?campaign=detail-campaign',actualQueue=false,trackerThrows=false}={}){
  let clock=0,next=0,uuids=0;
  const events=[],flushes=[],timers=new Map(),frames=new Map(),selectors=new Map(),stored=new Map(),requests=[];
  function target(){return {listeners:new Map(),addEventListener(name,handler,options){const entries=this.listeners.get(name)||[];entries.push({handler,capture:options===true||options?.capture===true});this.listeners.set(name,entries);},dispatch(name){for(const {handler}of [...(this.listeners.get(name)||[])].sort((a,b)=>Number(b.capture)-Number(a.capture)))handler({type:name});}};}
  const document=Object.assign(target(),{visibilityState:hidden?'hidden':'visible',documentElement:{scrollHeight:1000},body:{scrollHeight:1000},querySelectorAll:selector=>selectors.get(selector)||[]});
  const window=Object.assign(target(),{scrollY:0,CatalogHandoff:{detail:()=>({flowId:'c19c06a0-90f7-456b-b940-fffb17829c9b',journey:'recipe-first-v1',campaign:'detail-campaign'})},RecipeAnalytics:{event(event,step,extra){if(trackerThrows)throw Error('tracker');events.push(JSON.parse(JSON.stringify({event,step,...extra})));},visible:element=>element.visible,flushBeforeNavigate(){flushes.push(events.at(-1));}}});
  const location={pathname,search};
  const sandbox={window,document,location,URLSearchParams,performance:{now:()=>clock},crypto:{randomUUID(){uuids++;return randomUUID();}},innerWidth:390,innerHeight:500,
    setTimeout(fn,delay){const id=++next;timers.set(id,{fn,at:clock+delay});return id;},clearTimeout:id=>timers.delete(id),setInterval:()=>++next,
    requestAnimationFrame(fn){const id=++next;frames.set(id,fn);return id;},cancelAnimationFrame:id=>frames.delete(id),
    navigator:{onLine:true},Date:class extends Date{static now(){return clock;}},TextEncoder,AbortSignal,
    sessionStorage:{getItem:key=>stored.get(key)||null,setItem:(key,value)=>stored.set(key,value)},
    fetch:async(_url,options)=>{const body=JSON.parse(options.body);requests.push(body);if(requests.length===1)throw Error('temporary offline');return {ok:true,json:async()=>({accepted:body.events.map(e=>e.id)})};}
  };
  const context=vm.createContext(sandbox);
  if(actualQueue)vm.runInContext(queueSource,context);
  vm.runInContext(source,context);
  return {api:window.CatalogDetail,window,document,events,flushes,timers,selectors,requests,stored,location,sandbox,
    uuidCount:()=>uuids,
    node(visible=true){return {visible,isConnected:true};},
    frames(){const pending=[...frames.values()];frames.clear();pending.forEach(fn=>fn());},
    advance(ms){const until=clock+ms;let count=0;while(true){const entry=[...timers.entries()].filter(([,t])=>t.at<=until).sort((a,b)=>a[1].at-b[1].at)[0];if(!entry)break;const[id,t]=entry;timers.delete(id);clock=t.at;t.fn();assert.ok(++count<1000);}clock=until;},
    hide(){document.visibilityState='hidden';document.dispatch('visibilitychange');},
    show(){document.visibilityState='visible';document.dispatch('visibilitychange');}
  };
}

test('each list navigation captures submitted selection once, bounds free text and leaves excluded names out',()=>{
  const search=new URLSearchParams({include:'картофель,курица',cuisine:'japanese',q:'курица с картофелем',time:'30',exclude:'private-allergy',campaign:'detail-campaign'}).toString();
  const b=browser({search:'?'+search,hidden:true});b.api.begin('list');
  const first=b.events[0];assert.deepEqual(first.selection,{version:1,products:['картофель','курица'],cuisine:'japanese',query:'курица с картофелем',minutes:30,category:null,excludedCount:1});
  assert.deepEqual(catalogSelection(first.selection),first.selection);assert.equal(b.events.length,1);assert.ok(!JSON.stringify(first).includes('private-allergy'));
  b.location.search='?include=курица&q=новый+поиск';b.api.begin('list','search');
  assert.equal(b.events.at(-1).selection.query,'новый поиск');assert.equal(first.selection.query,'курица с картофелем');
  b.location.search='?'+new URLSearchParams({q:'https://private.example/?token=secret',include:'user@example.test',exclude:'private-allergy'});
  b.api.begin('list','search');assert.equal(b.events.at(-1).selection.query,'[скрыто]');assert.deepEqual(b.events.at(-1).selection.products,['[скрыто]']);
  assert.ok(!JSON.stringify(b.events).includes('private.example'));
  b.location.search='?'+new URLSearchParams({q:'я'.repeat(200),include:Array(15).fill('я'.repeat(90)).join(','),time:'-3',cuisine:'not-valid'});
  b.api.begin('list');const limited=b.events.at(-1).selection;assert.equal(limited.query.length,160);assert.doesNotThrow(()=>catalogSelection(limited));
  b.api.begin('recipe');assert.equal(b.events.at(-1).selection,undefined);
});

test('visible sections and actual card positions are recorded once per page, including collapsed controls',()=>{
  const b=browser(),intro=b.node(),products=b.node(false),results=b.node(),cards=Array.from({length:25},(_,i)=>b.node(i===0));
  b.selectors.set('#catalog-view .intro',[intro]);b.selectors.set('#ingredient-chips',[products]);b.selectors.set('#catalog-view .results',[results]);b.selectors.set('#cards .card-link',cards);
  b.api.begin('list','initial');const id=b.api.detail().pageId;b.api.mount();b.frames();
  assert.deepEqual(b.events.filter(e=>e.event==='catalog_section_visible').map(e=>e.section),['intro','results']);
  b.api.recheck();b.frames();assert.equal(b.events.filter(e=>e.section==='results').length,1);
  products.visible=true;cards[0].visible=false;cards[4].visible=true;cards[24].visible=true;b.api.recheck();b.frames();
  b.advance(5000);
  const progress=b.events.find(e=>e.event==='catalog_page_progress');
  assert.equal(progress.pageId,id);assert.equal(progress.screen,'list');assert.equal(progress.visibleMs,5000);assert.equal(progress.cardsSeen,2);assert.equal(progress.scrollDepth,50);
  assert.equal(b.events.filter(e=>e.section==='products').length,1);
  b.window.scrollY=400;b.window.dispatch('resize');b.frames();b.advance(15000);
  assert.equal(b.events.at(-1).scrollDepth,90);assert.equal(b.events.at(-1).cardsSeen,2);
});

test('first heartbeat is at five seconds, then fifteen; hidden time and duplicate lifecycle events do not inflate progress',()=>{
  const b=browser();b.api.begin('recipe','initial');
  b.advance(4999);assert.equal(b.events.filter(e=>e.event==='catalog_page_progress').length,0);
  b.advance(1);assert.equal(b.events.at(-1).visibleMs,5000);
  b.advance(4999);b.hide();
  assert.equal(b.events.at(-1).reason,'hidden');assert.equal(b.events.at(-1).visibleMs,9999);
  const count=b.events.length;b.document.dispatch('visibilitychange');b.window.dispatch('pagehide');b.advance(40000);assert.equal(b.events.length,count);
  b.window.dispatch('pageshow');assert.equal(b.timers.size,0,'pageshow while document hidden does not restart clock');
  b.show();b.advance(14999);assert.equal(b.events.length,count);
  b.advance(1);assert.equal(b.events.at(-1).visibleMs,24999);assert.equal(b.events.at(-1).elapsedMs,64999);
  assert.equal(b.events.at(-1).reason,'heartbeat');
});

test('shared recipe sections and either save button count once only when visible; portions and favorites do not reopen recipe',()=>{
  const b=browser(),header=b.node(),ingredients=b.node(false),steps=b.node(false),save=b.node(false),shortcut=b.node();
  b.selectors.set('#recipe-view [data-recipe-section="header"]',[header]);
  b.selectors.set('#recipe-view [data-recipe-section="ingredients"]',[ingredients]);
  b.selectors.set('#recipe-view [data-recipe-section="steps"]',[steps]);
  b.selectors.set('#recipe-view [data-handoff-open],#recipe-view [data-recipe-save]',[save,shortcut]);
  b.api.begin('recipe');b.api.mount();b.frames();
  assert.deepEqual(b.events.filter(e=>e.event==='catalog_section_visible').map(e=>e.section),['recipe_header','save_cta']);
  ingredients.visible=true;steps.visible=true;save.visible=true;b.api.recheck();b.frames();
  b.api.action('servings_change');b.api.action('favorite_add');b.api.mount();b.frames();
  assert.equal(b.events.filter(e=>e.event==='catalog_page_started').length,1);
  assert.equal(b.events.filter(e=>e.event==='catalog_section_visible').length,4);
  assert.deepEqual(b.events.filter(e=>e.event==='catalog_action').map(e=>e.action),['servings_change','favorite_add']);
  b.hide();b.api.action('servings_change');b.frames();
  assert.equal(b.events.filter(e=>e.event==='catalog_action').length,2);
});

test('a slow loading placeholder cannot mark the later long recipe as fully scrolled',()=>{
  const b=browser();b.document.documentElement.scrollHeight=500;b.document.body.scrollHeight=500;
  b.api.begin('recipe');b.advance(5000);assert.equal(b.events.at(-1).scrollDepth,0);
  b.document.documentElement.scrollHeight=5000;b.document.body.scrollHeight=5000;
  b.selectors.set('#recipe-view [data-recipe-section="header"]',[b.node()]);b.api.mount();b.frames();b.advance(15000);
  assert.equal(b.events.at(-1).scrollDepth,10);assert.equal(b.events.at(-1).cardsSeen,0);
});

test('a page opened in a hidden tab has no visibility, sections, actions or progress until shown',()=>{
  const b=browser({hidden:true});b.selectors.set('#catalog-view .intro',[b.node()]);
  b.api.begin('list','initial');b.api.mount();b.api.action('card_open',{position:1});b.advance(30000);b.frames();
  assert.deepEqual(b.events.map(e=>e.event),['catalog_page_started']);assert.equal(b.timers.size,0);
  b.hide();assert.equal(b.events.length,1);
  b.show();b.frames();b.advance(5000);
  assert.equal(b.events.find(e=>e.event==='catalog_section_visible').section,'intro');
  const progress=b.events.find(e=>e.event==='catalog_page_progress');assert.equal(progress.visibleMs,5000);assert.equal(progress.elapsedMs,35000);
});

test('navigation finishes the prior page before a new random page ID and BFcache resumes that page',()=>{
  const b=browser();b.api.begin('list','initial');const first=b.api.detail().pageId;
  b.advance(1200);b.api.begin('recipe','link');const second=b.api.detail().pageId;
  assert.notEqual(first,second);assert.equal(b.events[1].event,'catalog_page_progress');assert.equal(b.events[1].pageId,first);assert.equal(b.events[1].reason,'navigation');
  assert.equal(b.events[2].event,'catalog_page_started');assert.equal(b.events[2].pageId,second);
  b.advance(600);b.window.dispatch('pagehide');const ended=b.events.at(-1);assert.equal(ended.visibleMs,600);assert.equal(ended.reason,'pagehide');
  b.advance(20000);b.window.dispatch('pageshow');b.advance(5000);
  assert.equal(b.api.detail().pageId,second);assert.equal(b.events.at(-1).visibleMs,5600);
  assert.equal(b.events.filter(e=>e.event==='catalog_page_started').length,2);
});

test('actions retain only bounded enums and position and final progress enters keepalive before navigation',()=>{
  const b=browser({search:'?campaign=detail-campaign&page=3&q=быстрый+ужин'});b.api.begin('list','pagination');
  assert.equal(b.events[0].selection.query,'быстрый ужин');
  assert.equal(b.events[0].pageNumber,3);assert.equal(b.events[0].viewport,'compact');
  b.api.action('filter_change',{control:'include',position:2,recipeId:'private-recipe',value:'private allergy',url:'https://private.example'});
  b.api.action('card_open',{position:2,control:'include'});
  b.api.action('private text',{control:'allergy'});b.api.action('search_submit',{control:'private allergy',position:999});
  assert.deepEqual(b.events.filter(e=>e.event==='catalog_action').map(e=>({action:e.action,control:e.control,position:e.position})),[
    {action:'filter_change',control:'include',position:undefined},{action:'card_open',control:undefined,position:2},{action:'search_submit',control:undefined,position:undefined}
  ]);
  const count=b.events.length;b.api.action('open_bot');assert.equal(b.events.length,count,'recipe action cannot make a list event batch invalid');
  b.api.begin('recipe','link');b.api.action('filter_change',{control:'cuisine'});assert.equal(b.events.at(-1).event,'catalog_page_started');
  b.advance(700);b.api.action('open_bot');assert.equal(b.events.at(-1).event,'catalog_page_progress');assert.equal(b.events.at(-1).reason,'navigation');
  b.advance(400);b.hide();assert.equal(b.flushes.at(-1).event,'catalog_page_progress');assert.equal(b.flushes.at(-1).reason,'hidden');
  assert.doesNotMatch(JSON.stringify(b.events),/private|allergy|https:|recipeId|value/);
  assert.ok(b.document.listeners.get('visibilitychange')[0].capture);assert.ok(b.window.listeners.get('pagehide')[0].capture);
});

test('preview and the legacy catalogue are inert without IDs, timers or lifecycle hooks; tracker failure is non-blocking',()=>{
  for(const options of [{search:'?benefits=preview&campaign=detail-campaign'},{pathname:'/recipes'}]){
    const b=browser(options);b.api.begin('list');b.api.action('search_submit');b.api.mount();b.hide();b.advance(60000);
    assert.equal(b.uuidCount(),0);assert.equal(b.events.length,0);assert.equal(b.timers.size,0);assert.equal(b.document.listeners.size,0);
    assert.deepEqual(JSON.parse(JSON.stringify(b.api.detail())),{});
  }
  const b=browser({trackerThrows:true});assert.doesNotThrow(()=>{b.api.begin('list');b.api.action('search_submit');b.advance(5000);b.hide();});
});

test('detail events use the existing persistent queue and retry exactly the same event IDs and bounded fields',async()=>{
  const b=browser({actualQueue:true});b.api.begin('list','search');b.api.action('card_open',{position:3,recipeId:'never-store'});
  b.advance(300);await settle();assert.equal(b.requests.length,1);
  const first=b.requests[0].events.filter(e=>e.event.startsWith('catalog_'));assert.equal(first.length,2);
  b.advance(2000);await settle();assert.equal(b.requests.length,2);
  const second=b.requests[1].events.filter(e=>e.event.startsWith('catalog_'));
  assert.deepEqual(first.map(e=>e.id),second.map(e=>e.id));assert.equal(second[0].pageId,first[0].pageId);assert.equal(second[1].position,3);
  assert.equal(JSON.parse([...b.stored.values()][0]).queue.length,0);
  assert.doesNotMatch(JSON.stringify(b.requests),/never-store|recipeId/);
});

test('Back while handoff is pending cannot navigate later or attribute its result to the new list page',async()=>{
  for(const changedPageId of [false,true]){
    const nodes=new Map(),events=[],navigations=[];let resolve,currentPage='recipe-page',hiddenAncestor=false;
    const node=()=>({isConnected:true,hidden:false,dataset:{},handlers:{},setAttribute(){},addEventListener(name,fn){this.handlers[name]=fn;},focus(){},click(){return this.handlers.click?.();}});
    for(const key of ['[data-handoff-open]','#save-bot-platforms','.handoff-status','.handoff-continue','.handoff-cancel'])nodes.set(key,node());
    nodes.get('#save-bot-platforms').hidden=true;
    const button=Object.assign(node(),{dataset:{handoffPlatform:'telegram'}});
    const section=Object.assign(node(),{querySelector:key=>nodes.get(key),querySelectorAll:()=>[button],closest:()=>hiddenAncestor?{}:null});
    const window={RecipeAnalytics:{sessionId:randomUUID(),event:(name)=>events.push(name)},CatalogDetail:{detail:()=>({pageId:currentPage,screen:currentPage==='recipe-page'?'recipe':'list'}),action(){}}};
    vm.runInNewContext(handoffSource,{window,document:{visibilityState:'visible'},location:{pathname:'/dinner/pasta-tomato',search:'?campaign=detail-campaign',assign:url=>navigations.push(url)},URL,URLSearchParams,crypto:{randomUUID},AbortController,setTimeout,clearTimeout,sessionStorage:{getItem(){return null;},setItem(){}},fetch:()=>new Promise(done=>{resolve=done;})});
    window.CatalogHandoff.mount(section,{id:'pasta-tomato'});nodes.get('[data-handoff-open]').click();const pending=button.click();await settle();
    if(changedPageId)currentPage='list-page';else hiddenAncestor=true;
    resolve({ok:true,json:async()=>({url:'https://t.me/Recipeboibot?start=qa'})});await pending;
    assert.deepEqual(navigations,[]);assert.ok(!events.includes('catalog_handoff_ready'));assert.ok(!events.includes('catalog_handoff_error'));assert.equal(button.disabled,false);
  }
});
