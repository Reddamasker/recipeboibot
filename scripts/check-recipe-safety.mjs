import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'recipe-safety-')),platform=process.env.BOT_PLATFORM||'telegram';
Object.assign(process.env,{DATABASE_PATH:path.join(directory,'test.sqlite'),TELEGRAM_POLLING:'false',BOT_PLATFORM:platform,TEST_CONTOUR:'false',LEGACY_RECIPE_FLOWS_ENABLED:'true',CHAT_RECIPE_GENERATION_ENABLED:'true',TELEGRAM_BOT_TOKEN:'safety-test',MAX_BOT_TOKEN:'safety-test',MAX_BOT_USERNAME:'recipe_safety_bot',APP_URL:'https://recipes.example.test',OPENAI_API_KEY:'test-key',OPENAI_TEXT_MODEL:'test-model',DINNER_LLM_ENABLED:'false',DINNER_IMAGES_ENABLED:'false',OPENAI_IMAGE_MODEL:''});
const sent=[];let refusal='raw_animal',generations=0;
globalThis.fetch=async(url,options={})=>{
 const address=new URL(url),body=JSON.parse(options.body||'{}');
 if(address.hostname==='api.openai.com'){
  const operation=body.text.format.name,input=operation==='meal_request_interpretation'?body.input[0].content[0].text:JSON.parse(body.input[0].content[0].text);let output;
  if(operation==='meal_request_interpretation'&&refusal==='interpretation')return Response.json({status:'completed',output:[{content:[{type:'refusal',refusal:'Untrusted private provider text'}]}],usage:{input_tokens:2,output_tokens:3}});
  if(operation==='meal_request_interpretation')output={text:input,kind:'exact',confidence:'high',dish:'Тестовое блюдо '+refusal,requiredIngredients:[],excludedIngredients:[],methods:[],maxMinutes:null,servings:null,semanticCriteria:[]};
  else if(operation==='recipe_semantic_validation')output={candidates:input.candidates.map(c=>({id:c.id,criteria:input.criteria.map((_,index)=>({index,matches:false,confidence:'high',evidence:'Не совпадает блюдо'}))}))};
  else if(operation==='requested_recipe_generation'){
   generations++;assert.ok(body.text.format.schema.required.includes('safetyRefusal'));
   if(refusal==='provider')return Response.json({status:'completed',output:[{content:[{type:'refusal',refusal:'Untrusted private provider text'}]}],usage:{input_tokens:2,output_tokens:3}});
   output={safetyRefusal:refusal,result:{title:'Не должен быть показан',ingredients:[{name:'PRIVATE'}]}};
  }else assert.fail('Unexpected AI operation '+operation);
  return Response.json({status:'completed',output_text:JSON.stringify(output),usage:{input_tokens:2,output_tokens:3}});
 }
 assert.ok(['api.telegram.org','platform-api2.max.ru'].includes(address.hostname));sent.push(body);
 return platform==='telegram'?Response.json({ok:true,result:{message_id:sent.length}}):Response.json({success:true,message:{body:{mid:'out-'+sent.length,text:body.text||''},recipient:{chat_id:900,chat_type:'dialog'}}});
};
const {db,resolvePrivateTelegramUser,allowUser,claimUpdate,completeUpdate}=await import('../src/db.js');
const {startTrial}=await import('../src/subscriptions.js');const {handleChatUpdate}=await import('../src/telegram.js');const {normalizeMaxUpdate}=await import('../src/max-events.js');const {productReport}=await import('../src/product-analytics.js');
const from={id:platform==='max'?'max:91003001':91003001,first_name:'Safety'},chat={id:from.id,type:'private'};
const user=resolvePrivateTelegramUser(from);allowUser(user.id);startTrial(user.id);
try{
 for(const [reason,expected]of [['raw_animal',/обработка сырого мяса или рыбы/],['wild_mushrooms',/съедобность грибов/],['preservation',/способа консервирования/],['other',/безопасность его приготовления/],['provider',/модель отказалась/],['interpretation',/модель отказалась/]]){
  refusal=reason;const text='/find Тестовое блюдо '+reason;
  const update=platform==='max'?normalizeMaxUpdate({update_type:'message_created',timestamp:Date.now(),message:{sender:{user_id:91003001,first_name:'Safety'},recipient:{chat_id:900,chat_type:'dialog'},body:{mid:'in-'+reason,text}}}):{message:{from,chat,text,message_id:generations+1}};
  const before=generations;
  for(let i=0;i<2;i++)if(claimUpdate('safety-'+reason)){await handleChatUpdate(update);completeUpdate('safety-'+reason);}
  assert.equal(generations,before+(reason==='interpretation'?0:1),'No retry of refused generation or duplicate delivery');
  assert.match(sent.at(-1).text,expected);assert.doesNotMatch(sent.at(-1).text,/Не получилось|ID запроса|PRIVATE|Untrusted/);
 }
 assert.equal(db.prepare('SELECT count(*) n FROM recipes').get().n,0);
 assert.equal(db.prepare('SELECT count(*) n FROM recipe_suggestions').get().n,0);
 assert.equal(db.prepare('SELECT count(*) n FROM generated_catalog_candidates').get().n,0);
 const events=db.prepare("SELECT * FROM product_events WHERE event='operation_finished' AND user_id=?").all(user.id);
 assert.equal(events.length,6);assert.ok(events.every(r=>JSON.parse(r.detail_json).status===422&&r.duration_ms>=0&&!JSON.parse(r.detail_json).resultMode));
 assert.equal(productReport([{id:user.id}]).errors.find(r=>r.code==='http_422').count,6);assert.equal(productReport([]).errors.length,0);
 assert.equal(db.prepare("SELECT count(*) n FROM product_events WHERE event IN ('request_visible','request_preview_visible')").get().n,0);
 assert.equal(db.prepare("SELECT count(*) n FROM provider_requests WHERE error_code='recipe_safety_refusal'").get().n,4);
 console.log(platform+': safety messages, single attempt, no saved recipe, analytics and duplicate delivery verified');
}finally{db.close();fs.rmSync(directory,{recursive:true,force:true});}
