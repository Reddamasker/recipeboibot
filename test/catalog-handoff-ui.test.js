import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';

const source = fs.readFileSync(new URL('../public/catalog-handoff.js', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
function browser({ storage = new Map(), storageDisabled = false, trackerThrows = false, response, hidden = false } = {}) {
  const events = [], requests = [], navigations = [], nodes = new Map();
  const element = () => ({
    isConnected: true, hidden: false, disabled: false, dataset: {}, textContent: '', handlers: {}, attributes: {},
    setAttribute(name,value) { this.attributes[name] = value; },
    addEventListener(name, handler) { this.handlers[name] = handler; }, focus() {},
    click() { return this.handlers.click?.(); }
  });
  for (const selector of ['[data-handoff-open]', '#save-bot-platforms', '.handoff-status', '.handoff-continue', '.handoff-cancel']) nodes.set(selector, element());
  nodes.get('#save-bot-platforms').hidden = true;
  nodes.get('.handoff-continue').hidden = true;
  const buttons = ['telegram','max'].map(platform => Object.assign(element(), { dataset: {handoffPlatform:platform} }));
  const section = Object.assign(element(), {querySelector: selector => nodes.get(selector), querySelectorAll: () => buttons});
  const window = {RecipeAnalytics:{sessionId:'visitor-id-123456789',event(name,step,detail) { if(trackerThrows)throw Error('tracker');events.push({name,step,...detail}); }}};
  const document = {visibilityState:hidden?'hidden':'visible'};
  const location = {pathname:'/dinner/pasta-tomato',search:'?campaign=campaign-one&include=private-food',assign: url => navigations.push(url)};
  let handler=response || (async (_url, options) => ({ok:true,json:async()=>({url:JSON.parse(options.body).platform==='max'?'https://max.ru/recipe_bot?start=web_test':'https://t.me/recipe_bot?start=web_test'})}));
  vm.runInNewContext(source, {window,document,location,URL,URLSearchParams,AbortController,crypto:{randomUUID},setTimeout,clearTimeout,sessionStorage:{getItem(key){if(storageDisabled)throw Error('storage');return storage.get(key);},setItem(key,value){if(storageDisabled)throw Error('storage');storage.set(key,value);}},fetch:async(url,options)=>{requests.push({url,options});return handler(url,options);}});
  window.CatalogHandoff.mount(section,{id:'pasta-tomato',title:'Private recipe title'});
  return {api:window.CatalogHandoff,section,nodes,buttons,events,requests,navigations,storage,document,setResponse(value){handler=value;},open(){nodes.get('[data-handoff-open]').click();}};
}

test('explicit save chooses a platform and carries exact recipe with stable anonymous context only', async () => {
  const b=browser();assert.equal(b.requests.length,0);assert.equal(b.navigations.length,0);
  b.open();b.open();
  assert.equal(b.events.filter(e=>e.name==='catalog_save_intent').length,1);
  await b.buttons[0].click();
  assert.equal(b.requests.length,1);assert.equal(b.navigations[0],'https://t.me/recipe_bot?start=web_test');
  const sent=JSON.parse(b.requests[0].options.body);
  assert.deepEqual(Object.keys(sent).sort(),['campaign','flowId','platform','recipeId','sessionId']);
  assert.equal(sent.recipeId,'pasta-tomato');assert.equal(sent.platform,'telegram');assert.equal(sent.campaign,'campaign-one');
  assert.equal(sent.sessionId,'visitor-id-123456789');assert.equal(sent.flowId,b.api.context.flowId);
  assert.equal(b.requests[0].options.headers['x-catalog-request'],'1');
  assert.doesNotMatch(JSON.stringify(b.events),/pasta-tomato|private-food|Private recipe title|https:/);
  assert.equal(b.events.find(e=>e.name==='catalog_handoff_ready').platform,'telegram');
  assert.doesNotMatch(b.nodes.get('.handoff-status').textContent,/Рецепт сохранён/);
  await b.buttons[1].click();assert.equal(JSON.parse(b.requests[1].options.body).flowId,sent.flowId);
  assert.equal(b.navigations[1],'https://max.ru/recipe_bot?start=web_test');
  const reloaded=browser({storage:b.storage});assert.equal(reloaded.api.context.flowId,sent.flowId);
});

test('double tap does not create parallel handoffs and cancelled preparation never redirects later', async () => {
  let resolve;
  const b=browser({response:()=>new Promise(done=>{resolve=done;})});b.open();
  const pending=b.buttons[0].click();await tick();await b.buttons[0].click();
  assert.equal(b.requests.length,1);assert.equal(b.navigations.length,0);
  b.nodes.get('.handoff-cancel').click();
  resolve({ok:true,json:async()=>({url:'https://t.me/recipe_bot?start=web_test'})});await pending;
  assert.equal(b.navigations.length,0);assert.equal(b.events.filter(e=>e.name==='catalog_handoff_ready').length,0);
  assert.ok(b.buttons.every(button=>!button.disabled));
});

test('failed transfer keeps reading available and retry uses the same flow and selected recipe', async () => {
  const b=browser({response:async()=>{throw new TypeError('offline');}});b.open();await b.buttons[0].click();
  assert.equal(b.navigations.length,0);assert.match(b.nodes.get('.handoff-status').textContent,/Рецепт остаётся/);
  assert.equal(b.events.find(e=>e.name==='catalog_handoff_error').code,'network');
  b.setResponse(async()=>({ok:true,json:async()=>({url:'https://t.me/recipe_bot?start=web_retry'})}));
  await b.buttons[0].click();assert.equal(b.navigations.length,1);
  assert.equal(b.requests[0].options.body,b.requests[1].options.body);
});

test('foreign or wrong-platform destinations are rejected without leaking server URL into telemetry', async () => {
  for(const url of ['https://attacker.example/','javascript:alert(1)','https://t.me@attacker.example/','https://max.ru/recipe_bot','http://t.me/recipe_bot']) {
    const b=browser({response:async()=>({ok:true,json:async()=>({url})})});b.open();await b.buttons[0].click();
    assert.equal(b.navigations.length,0,url);assert.equal(b.events.at(-1).code,'http');
    assert.equal(JSON.stringify(b.events).includes(url),false);
  }
});

test('storage and analytics failures do not prevent handoff; hidden document cannot start it', async () => {
  const b=browser({storageDisabled:true,trackerThrows:true});b.open();await b.buttons[0].click();assert.equal(b.navigations.length,1);
  const hidden=browser({hidden:true});hidden.open();await hidden.buttons[0].click();assert.equal(hidden.requests.length,0);
});

test('Mini App public catalog exception checks the exact server-granted saved recipe id', () => {
  const state={payment:{firstRecipe:{publicCatalogRecipeIds:['saved-public-id']}}};
  const sandbox={state};
  vm.runInNewContext(app.slice(app.indexOf('function publicCatalogRecipeReadable('),app.indexOf('\nfunction closeDetailRoute(')),sandbox);
  assert.equal(sandbox.publicCatalogRecipeReadable('saved-public-id'),true);
  assert.equal(sandbox.publicCatalogRouteReadable('collection',null),true);
  assert.equal(sandbox.publicCatalogRouteReadable('tastes',null),false);
  state.payment.firstRecipe.catalogObtained=true;
  assert.equal(sandbox.publicCatalogRouteReadable('tastes',null),true);
  for(const view of ['dinner','request','checkout','notifications'])assert.equal(sandbox.publicCatalogRouteReadable(view,'saved-public-id'),false);
  for(const id of ['seed:pasta-tomato','other-saved-id','',null])assert.equal(sandbox.publicCatalogRecipeReadable(id),false);
  delete state.payment.firstRecipe.publicCatalogRecipeIds;
  assert.equal(sandbox.publicCatalogRecipeReadable('saved-public-id'),false);
});
