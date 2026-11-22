import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { publicRecipe, createGeneratedCatalogStore, catalogProjection, publicationProblems, validateCatalogSnapshot, exactCatalogDuplicate, readCatalogInput } from '../src/generated-catalog.js';
import { reviewCatalogCandidate } from '../src/catalog-review.js';
import { SEED_RECIPES, withSeedImage } from '../src/dinner-seeds.js';

const dish=()=>({title:'Тыквенная каша с пшеном',description:'Пшённая каша с мягкой тыквой.',servings:3,prepMinutes:10,cookMinutes:30,
  ingredients:[{name:'пшено',quantity:150,unit:'г'},{name:'тыква',quantity:300,unit:'г'},{name:'вода',quantity:600,unit:'мл'}],
  steps:[{position:1,text:'Промойте пшено несколько раз горячей водой.'},{position:2,text:'Нарежьте очищенную тыкву небольшими кубиками.'},{position:3,text:'Залейте тыкву и пшено водой и варите на слабом огне 30 минут до мягкости, помешивая.'}],tags:['каша']});
function fixture(){const db=new DatabaseSync(':memory:');return {db,store:createGeneratedCatalogStore(db)};}
test('replication preserves Cyrillic across arbitrary byte boundaries and bounds the actual byte payload',async()=>{
  const value={title:'Щи со свёклой'},bytes=Buffer.from(JSON.stringify(value));
  assert.deepEqual(await readCatalogInput(Readable.from([...bytes].map(b=>Buffer.from([b])))),value);
  await assert.rejects(()=>readCatalogInput(Readable.from([bytes]),bytes.length-1),/Payload too large/);
});

test('only trusted generation enters the durable queue; screenshots, imports and personal fields are excluded',()=>{
  const {db,store}=fixture();
  for(const source of ['image','screenshot','text','url','imported','catalog',null])assert.equal(store.enqueue('telegram',dish(),source),false);
  const recipe={...dish(),notes:'private note',sourceUrl:'https://private.example',thumbnailUrl:'/private/photo',userId:'secret',query:'private query'};
  assert.equal(store.enqueue('telegram',recipe,'generated'),true);
  assert.equal(store.enqueue('telegram',recipe,'generated'),false);
  const row=store.exportCandidates()[0];
  for(const key of ['notes','sourceUrl','thumbnailUrl','userId','query'])assert.ok(!Object.hasOwn(row.recipe,key));
  assert.equal(store.enqueue('test',recipe,'generated'),false);
  db.close();
});
test('duplicates are checked against both seed recipes and earlier publications, including scaled portions',async()=>{
  const original=SEED_RECIPES[0],scaled={...original,servings:original.servings*2,ingredients:original.ingredients.map(i=>({...i,quantity:i.quantity*2})),title:'Другое название'};
  assert.equal(exactCatalogDuplicate(scaled,SEED_RECIPES).id,original.id);
  const verdict=await reviewCatalogCandidate(original,SEED_RECIPES,()=>{throw Error('Should not spend AI on an exact duplicate');});
  assert.equal(verdict.state,'duplicate');
  assert.equal((await reviewCatalogCandidate(dish(),SEED_RECIPES,async()=>({decision:'duplicate',duplicateId:original.id}))).state,'duplicate');
  await assert.rejects(()=>reviewCatalogCandidate(dish(),SEED_RECIPES,async()=>({decision:'duplicate',duplicateId:'invented'})));
});
test('quality rejects incomplete publication and untrusted model responses; provider failures remain retryable',async()=>{
  const {db,store}=fixture();store.enqueue('max',dish(),'generated');const row=store.pending()[0];
  assert.ok(publicationProblems({...dish(),ingredients:[{name:'тыква',quantity:null,unit:''}]}).length);
  assert.ok(publicationProblems({...dish(),description:'https://private.example'}).length);
  await assert.rejects(()=>reviewCatalogCandidate(dish(),[],async()=>({decision:'publish',recipe:{title:'broken'}})));
  const result=await reviewCatalogCandidate(dish(),[],async()=>({decision:'reject',reason:'unsafe'}));assert.equal(result.state,'rejected');
  store.finish(row.id,'error',{reason:'review_unavailable',elapsed:100});
  assert.equal(store.pending().length,0);assert.equal(store.report().platforms[1].error,1);
  db.prepare('UPDATE generated_catalog_candidates SET next_attempt_at=?').run('2000-01-01');assert.equal(store.pending().length,1);
  db.close();
});
test('reviewed nutrition survives publication for ingredients outside the local reference table without copying private assumptions',()=>{
  const {db,store}=fixture();
  const recipe={...dish(),ingredients:[{name:'кешью жареный',quantity:80,unit:'г'},{name:'финики',quantity:100,unit:'г'}],nutrition:{calories:250,protein:6,fat:12,carbs:30,basis:'serving',source:'calculated',servings:3,weightGrams:null,assumptions:['private user note']}};
  assert.deepEqual(publicationProblems(recipe),[]);store.publish(null,recipe);
  assert.equal(store.read()[0].nutrition.calories,250);
  assert.ok(!JSON.stringify(store.snapshot()).includes('private user note'));db.close();
});
test('long preparation retains the full waiting time instead of appearing as a quick meal',()=>{
  assert.deepEqual(publicationProblems({...dish(),cookMinutes:17*1440}),[]);
  assert.ok(publicationProblems({...dish(),cookMinutes:525601}).includes('timing'));
});
test('lost replication replies do not duplicate candidates/cards; schema errors do not erase published data',()=>{
  const a=fixture(),b=fixture();a.store.enqueue('max',dish(),'generated');
  const rows=a.store.exportCandidates();b.store.ingest(rows);b.store.ingest(rows);assert.equal(b.store.pending().length,1);
  a.store.acknowledge(rows.map(r=>r.id));assert.equal(a.store.exportCandidates().length,0);
  const id=b.store.publish(b.store.pending()[0],dish());b.store.finish(b.store.pending()[0].id,'published',{elapsed:500});
  const snapshot=b.store.snapshot();validateCatalogSnapshot(snapshot);a.store.applySnapshot(snapshot);a.store.applySnapshot(snapshot);
  assert.equal(a.store.read().length,1);assert.equal(a.store.read()[0].id,`seed:${id}`);
  assert.equal(a.store.diagnostics().platforms[1].published,1);assert.equal(a.store.read()[0].sourceUrl,null);
  assert.throws(()=>a.store.applySnapshot({...snapshot,version:2}));
  assert.throws(()=>a.store.applySnapshot({...snapshot,report:{...snapshot.report,platforms:[{platform:'max'}]}}));
  a.store.applySnapshot({...snapshot,recipes:[]});assert.equal(a.store.read().length,1);
  for(const {db} of [a,b])db.close();
});
test('reviewed cards appear without restart in anonymous search/detail, can be saved and retain private API protection',async()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'generated-catalog-'));
  process.env.DATABASE_PATH=path.join(temp,'recipes.sqlite');process.env.TELEGRAM_POLLING='false';process.env.DINNER_LLM_ENABLED='false';
  const {db,generatedCatalog,upsertTelegramUser}=await import('../src/db.js');
  const {catalogSearch,catalogRecipe}=await import('../src/web-catalog.js');
  const {saveCatalogRecipeForUser,isPublicCatalogRecipe}=await import('../src/catalog-handoff.js');
  const {createServer}=await import('../src/server.js');
  const baseline=catalogSearch().catalogTotal;
  const id=generatedCatalog.publish(null,dish());
  assert.equal(catalogSearch().catalogTotal,baseline+1);
  assert.equal(catalogRecipe(id).title,dish().title);
  assert.ok(catalogSearch(new URLSearchParams({q:'Тыквенная каша'})).recipes.some(r=>r.id===id));
  const user=upsertTelegramUser({id:444001,first_name:'Catalog test'});
  const first=saveCatalogRecipeForUser(user.id,id),again=saveCatalogRecipeForUser(user.id,id);
  assert.equal(again.recipe.id,first.recipe.id);assert.ok(isPublicCatalogRecipe(user.id,first.recipe.id));
  const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try{
    const base=`http://127.0.0.1:${server.address().port}`;
    const detail=await fetch(base+'/api/catalog/'+id);assert.equal(detail.status,200);
    assert.equal((await fetch(base+'/api/recipes')).status,401);
    assert.equal((await fetch(base+'/api/dashboard/generated-catalog')).status,401);
  }finally{await new Promise(r=>server.close(r));db.close();fs.rmSync(temp,{recursive:true,force:true});}
});

test('published recipes use only the editorial frame for their own catalog ID', () => {
  const id = 'community-457776eb2d0860ddad6cdbcb';
  const recipe = {...dish(), thumbnailUrl: 'https://example.org/private-photo.jpg'};
  assert.equal(publicRecipe(recipe, id).thumbnailUrl, `/assets/dinner/${id}.jpg`);
  assert.equal(publicRecipe(recipe, id).imageGenerated, false);
  const saved = {sourceKey: 'dinner-choice:seed:' + id, thumbnailUrl: null};
  assert.deepEqual(withSeedImage(saved), {...saved, sourceName: '@DinaRecipes · YouTube', sourceUrl: 'https://www.youtube.com/watch?v=BMwO91b1gNU', thumbnailUrl: `/assets/dinner/${id}.jpg`, imageGenerated: false});
  assert.equal(withSeedImage({...saved, thumbnailUrl: '/custom.jpg'}).thumbnailUrl, '/custom.jpg');
  assert.equal(publicRecipe(recipe, 'community-000000000000000000000000').thumbnailUrl, null);
  assert.equal(publicRecipe(recipe, '../' + id).thumbnailUrl, null);
});

test('editorial attribution survives an existing photo and a separately saved catalog snapshot', () => {
  const id = 'community-23365ee30f4ed2f19e46fb74';
  const source = 'https://vkvideo.ru/clip-228244946_456239071';
  const card = publicRecipe(dish(), id);
  assert.equal(card.sourceName, 'prodasha_live · VK Видео');
  assert.equal(card.sourceUrl, source);
  const copy = {sourceKey: 'dinner-choice:public-catalog:' + id + ':00000000-0000-4000-a000-000000000001', thumbnailUrl: '/custom.jpg'};
  assert.equal(withSeedImage(copy).sourceUrl, source);
  assert.equal(withSeedImage(copy).thumbnailUrl, '/custom.jpg');
  const personal = {...copy, sourceUrl: 'https://example.org/own', sourceName: 'Personal'};
  assert.deepEqual(withSeedImage(personal), personal);
  assert.equal(publicRecipe({...dish(), sourceUrl: source}, 'community-000000000000000000000000').sourceUrl, null);
});
