// Historical compatibility; current retired behavior is covered separately.
process.env.LEGACY_RECIPE_FLOWS_ENABLED = 'true';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
const file = `data/taste-${randomUUID()}.sqlite`;
Object.assign(process.env,{DATABASE_PATH:file,TELEGRAM_BOT_TOKEN:'taste-test-only',TELEGRAM_POLLING:'false',DINNER_LLM_ENABLED:'false',DINNER_IMAGES_ENABLED:'false',OPENAI_API_KEY:'disabled',TEST_CONTOUR:'false'});
const {db,upsertTelegramUser,allowUser} = await import('../src/db.js');
const {getFoodProfile} = await import('../src/dinner-store.js');
const {updateDinnerProfile} = await import('../src/dinner-service.js');
const {getTasteCatalog,tasteEngine,dishTasteProfile,legacyDishRatings} = await import('../src/taste-profile.js');
const {rankCandidates,SEED_RECIPES} = await import('../src/dinner.js');
const {createServer} = await import('../src/server.js');
const {makeTelegramInitData} = await import('../src/security.js');
const {apiStep} = await import('../src/product-analytics.js');
let id=9321000;
const user=()=>{const raw={id:++id,first_name:'Synthetic'};const u=upsertTelegramUser(raw);allowUser(u.id);return {...u,raw};};
const sample={'seed:chicken-cutlets':1,'seed:borscht-beef':-1,'seed:fish-potato':1};
test.after(()=>{db.close();for(const suffix of ['','-wal','-shm'])fs.rmSync(file+suffix,{force:true});});

test('dish ratings roundtrip on two independent authenticated devices, isolated by account and idempotent',async()=>{
 const u=user(),v=user(),server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin=`http://127.0.0.1:${server.address().port}`;
 const request=async(who,method='GET',body,path='/api/dinner/tastes')=>{const r=await fetch(origin+path,{method,headers:{authorization:`tma ${makeTelegramInitData(who.raw,'taste-test-only')}`,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json()};};
 try{
  assert.equal((await fetch(origin+'/api/dinner/tastes')).status,401);
  const first=await request(u);assert.equal(first.data.items.length,340);assert.equal(first.data.profile.tasteRevision,0);
  const input={dishRatings:sample,tasteRevision:0,tastePreferencesStatus:'completed'};
  const saved=await request(u,'PUT',input);assert.equal(saved.status,200);assert.equal(saved.data.tasteRevision,1);
  assert.deepEqual((await request(u)).data.profile.dishRatings,sample,'new auth session/device reads server profile');
  assert.deepEqual((await request(v)).data.profile.dishRatings,{});
  assert.equal((await request(u,'PUT',input)).data.tasteRevision,1,'lost-response retry does not change revision');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM dinner_events WHERE user_id=? AND event='taste_preferences_completed'").get(u.id).n,1);
  const different={...sample,'seed:egg-salad':1};
  assert.equal((await request(u,'PUT',{...input,dishRatings:different})).status,409,'stale screen cannot erase new choices');
  assert.deepEqual(getFoodProfile(u.id).dishRatings,sample);
  assert.equal((await request(u,'PUT',{...input,tasteRevision:1,dishRatings:different})).status,200);
  assert.equal((await request(u,'PUT',{dishRatings:{'seed:fake':1},tasteRevision:2})).status,400);
  assert.equal((await request(u,'PUT',{dishRatings:{'seed:fish-potato':1},tasteRevision:2})).status,400);
  assert.equal((await request(u,'PUT',{dishRatings:{...sample,'seed:fish-potato':2},tasteRevision:2})).status,400);
  const events=db.prepare('SELECT detail_json FROM product_events WHERE user_id=?').all(u.id);
  assert.ok(events.length);assert.ok(events.every(e=>!e.detail_json.includes('seed:')));
  assert.equal(apiStep('/api/dinner/tastes'),'taste');
  for(let n=0;n<95;n++) {
    const photo=await fetch(origin+'/assets/dinner/chicken-cutlets.jpg');assert.equal(photo.status,200);await photo.arrayBuffer();
  }
  assert.equal((await request(u)).status,200,'photo exploration does not exhaust the API rate limit');
 }finally{await new Promise(resolve=>server.close(resolve));}
});

test('legacy exact dish choices migrate without guessing categories; unrelated settings and neutral removals survive',()=>{
 const u=user();
 updateDinnerProfile(u.id,{householdSize:4,hasChildren:true,excludedIngredients:['арахис'],preferredCategories:{pasta:1},dishPreferences:{'рубленые куриные котлеты':1,'неизвестное блюдо':-1}});
 let p=getFoodProfile(u.id);assert.equal(p.dishRatings['seed:chicken-cutlets'],1);assert.equal(Object.keys(p.dishRatings).length,1);
 p=updateDinnerProfile(u.id,{dishRatings:sample,tasteRevision:p.tasteRevision,tastePreferencesStatus:'completed'});
 const next={...sample};delete next['seed:chicken-cutlets'];next['seed:egg-salad']=-1;
 p=updateDinnerProfile(u.id,{dishRatings:next,tasteRevision:p.tasteRevision});
 assert.equal(p.dishRatings['seed:chicken-cutlets'],undefined);assert.equal(p.dishPreferences['рубленые куриные котлеты'],undefined);
 assert.equal(p.dishPreferences['неизвестное блюдо'],-1);assert.deepEqual(p.preferredCategories,{pasta:1});
 assert.equal(p.householdSize,4);assert.equal(p.hasChildren,true);assert.deepEqual(p.excludedIngredients,['арахис']);
 updateDinnerProfile(u.id,{preferredMaxCookingTime:45});assert.deepEqual(getFoodProfile(u.id).dishRatings,next);
 assert.deepEqual(legacyDishRatings({'курица':1}),{},'a category does not invent specific dish ratings');
});

test('all source dishes and mixed histories use compatible main ingredients, full composition and cooking methods',()=>{
 const {items,order}=getTasteCatalog(),m=tasteEngine();
 assert.equal(new Set(order).size,340);assert.equal(order.length,items.length);
 assert.ok(items.every(i=>i.ingredients.length && i.methods.length && i.primary.every(Boolean) && i.photo));
 let pairs=0;
 for(const anchor of items){
  const choices={[anchor.key]:1};
  for(const candidate of m.related(anchor.key,1,choices)){assert.ok(m.compatible(anchor.key,candidate));pairs++;}
  let shown=order.slice(0,24),branches={};
  for(let n=0;n<12;n++){
   const key=order[(order.indexOf(anchor.key)+n*29)%order.length];
   if(n%3===2)delete choices[key];else choices[key]=n%3===0?1:-1;
   ({shown,branches}=m.expand(shown,key,choices[key]||0,choices,branches));
   const p=dishTasteProfile(choices),reverse=dishTasteProfile(Object.fromEntries(Object.entries(choices).reverse()));
   assert.deepEqual(p,reverse);
   for(const key of m.recommend(choices)){assert.equal(choices[key],undefined);const likes=Object.keys(choices).filter(k=>choices[k]===1);assert.ok(!likes.length||likes.some(k=>m.compatible(k,key)));}
   for(const [owner,children]of Object.entries(branches)){assert.equal(choices[owner],1);assert.ok(children.every(k=>m.compatible(owner,k)));}
  }
 }
 assert.ok(pairs>1000);
 const chicken=m.byKey.get('seed:chicken-cutlets'),p=m.profile({'seed:chicken-cutlets':1});
 for(const ingredient of chicken.ingredients)assert.equal(p.ingredients[ingredient],1);
 for(const method of chicken.methods)assert.equal(p.methods[method],1);
 assert.deepEqual(m.profile({'seed:chicken-cutlets':-1}),{ingredients:{},methods:{},primary:{}});
 const own=m.score(chicken,p);assert.ok(own>m.score({...chicken,methods:['unrelated']},p));assert.ok(own>m.score({...chicken,ingredients:['unrelated']},p));
 assert.ok(m.related(chicken.key,1,{[chicken.key]:1}).every(k=>!m.byKey.get(k).primary.includes('beef')));
});

test('saved composition and methods affect real dinner ranking, while dislikes never become ingredient bans',()=>{
 const u=user(),p=updateDinnerProfile(u.id,{dishRatings:sample,tasteRevision:0,tastePreferencesStatus:'completed'});
 const ranked=rankCandidates(SEED_RECIPES,{profile:p});
 assert.ok(!ranked.some(r=>r.recipe.id==='seed:borscht-beef'));
 assert.ok(ranked.some(r=>r.recipe.id==='seed:chicken-cutlets'&&r.dishTaste>0));
 assert.deepEqual(p.excludedIngredients,[]);
 assert.ok(ranked.some(r=>r.recipe.ingredients.some(i=>/говя/i.test(i.name))),'disliking borscht does not ban all beef');
});
