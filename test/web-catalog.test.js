import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { catalogSearch, catalogRecipe } from '../src/web-catalog.js';

const search = values => catalogSearch(new URLSearchParams(values));
test('public catalog paginates every house recipe once without returning full instructions in lists',()=>{
  const ids=[];
  for(let page=1;page<=search({}).pages;page++) for(const r of search({page}).recipes) {
    ids.push(r.id); assert.ok(!r.steps && !r.ingredients); assert.ok(catalogRecipe(r.id).steps.length);
  }
  assert.equal(ids.length,340); assert.equal(new Set(ids).size,340);
  assert.equal(search({page:-1}).page,1); assert.equal(search({page:999}).page,15);
});
test('cuisine, category and time compose and unknown values never silently widen results',()=>{
  const result=search({cuisine:'italian',category:'pasta',time:'30'});
  assert.ok(result.total>=3); assert.ok(result.recipes.every(r=>r.minutes<=30&&r.categories.includes('italian')&&r.categories.includes('pasta')));
  assert.equal(search({cuisine:'unknown'}).total,0);
  assert.ok(search({cuisine:'everyday'}).total>100);
  assert.ok(search({cuisine:'georgian'}).recipes.some(r=>r.id==='lobio'));
});
test('ingredients use food aliases, all included products and exclusions together',()=>{
  const result=search({include:'курица, рис',exclude:'молоко'});
  assert.ok(result.recipes.some(r=>r.id==='chicken-rice'));
  assert.ok(!search({q:'сливочном',exclude:'молоко'}).recipes.some(r=>r.id==='chicken-creamy'));
  assert.equal(search({include:'курица',exclude:'курица'}).total,0);
  assert.ok(search({q:'ТУШЕНОЙ КАПУСТОЙ'}).recipes.some(r=>r.id==='pork-cabbage'));
});
test('favorites are limited to explicit catalog IDs and fast sorting is monotonic',()=>{
  assert.equal(search({saved:''}).total,0);
  assert.deepEqual(search({saved:'pasta-tomato,private-recipe'}).recipes.map(r=>r.id),['pasta-tomato']);
  assert.equal(catalogRecipe('private-recipe'),null);
  const times=search({sort:'fast'}).recipes.map(r=>r.minutes);
  assert.deepEqual(times,[...times].sort((a,b)=>a-b));
});

const directory=fs.mkdtempSync(path.join(os.tmpdir(),'web-catalog-'));
Object.assign(process.env,{DATABASE_PATH:path.join(directory,'recipes.sqlite'),TELEGRAM_BOT_TOKEN:'123:catalog-test',TELEGRAM_POLLING:'false',DINNER_LLM_ENABLED:'false',DINNER_IMAGES_ENABLED:'false',OPENAI_API_KEY:'unused',BOT_PLATFORM:'telegram'});
const {createServer}=await import('../src/server.js');
const {db}=await import('../src/db.js');
let server,base;
test.before(async()=>{server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port;});
test.after(async()=>{await new Promise(resolve=>server.close(resolve));db.close();fs.rmSync(directory,{recursive:true,force:true});});
test('anonymous browser gets catalog and full house recipe; private API still requires authentication',async()=>{
  const list=await fetch(base+'/api/catalog'); assert.equal(list.status,200);assert.equal((await list.json()).total,340);
  const recipe=await fetch(base+'/api/catalog/pasta-tomato');assert.equal(recipe.status,200);assert.ok((await recipe.json()).steps.length);
  assert.equal((await fetch(base+'/api/catalog/private-recipe')).status,404);
  assert.equal((await fetch(base+'/api/recipes')).status,401);
  assert.equal((await fetch(base+'/api/dinner/recipes/seed:pasta-tomato')).status,401);
  assert.equal((await fetch(base+'/api/catalog',{method:'POST'})).status,405);
});
test('daily catalog API is uncached, read-only and resolves to an existing public recipe',async()=>{
  const response = await fetch(base+'/api/catalog/daily');
  assert.equal(response.status,200);
  assert.equal(response.headers.get('cache-control'),'no-store');
  const value=await response.json();
  assert.equal(value.timeZone,'Europe/Moscow');
  assert.equal(value.recipe.title,catalogRecipe(value.recipe.id).title);
  assert.ok(Date.parse(value.nextChangeAt)>Date.parse(value.serverTime));
  assert.ok(Date.parse(value.nextChangeAt)-Date.parse(value.serverTime)<=86400000);
  const again=await (await fetch(base+'/api/catalog/daily?q=unknown&page=999')).json();
  if(again.date===value.date)assert.equal(again.recipe.id,value.recipe.id);
  assert.equal((await fetch(base+'/api/catalog/daily',{method:'POST'})).status,405);
});
test('catalog and direct recipe URLs work without messenger SDK and unknown recipes return 404',async()=>{
  for(const route of ['/recipes','/recipes/','/recipes/pasta-tomato']) {
    const response=await fetch(base+route),html=await response.text();assert.equal(response.status,200);assert.match(html,/catalog(?:-legacy)?\.js/);assert.doesNotMatch(html,/telegram-web-app|platform-bridge/);
  }
  assert.equal((await fetch(base+'/recipes/unknown')).status,404);
});

test('filter illustrations are served anonymously as WebP images',async()=>{
  for(const name of ['cuisine-everyday','ingredient-tomato']) {
    const response=await fetch(base+'/assets/filters/'+name+'.webp');
    assert.equal(response.status,200);
    assert.equal(response.headers.get('content-type'),'image/webp');
    const bytes=Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.subarray(0,4).toString(),'RIFF');
    assert.equal(bytes.subarray(8,12).toString(),'WEBP');
  }
});
