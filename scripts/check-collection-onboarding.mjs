// Runs against isolated data and intercepted transports, including in a published container.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const platform = process.env.QA_PLATFORM || 'telegram';
assert.ok(['telegram', 'max'].includes(platform));
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'collection-onboarding-'));
Object.assign(process.env, { DATABASE_PATH:path.join(directory,'test.sqlite'), BOT_PLATFORM:platform, TEST_CONTOUR:'false',
  TELEGRAM_POLLING:'false', TELEGRAM_BOT_TOKEN:'test-only', TELEGRAM_API_ORIGIN:'https://api.telegram.org', MAX_BOT_TOKEN:'test-only',
  MAX_BOT_USERNAME:'id500912857935_bot', APP_URL:'https://recipes.example.test', OPENAI_API_KEY:'test-only', OPENAI_TEXT_MODEL:'test-model',
  DINNER_LLM_ENABLED:'false', DINNER_IMAGES_ENABLED:'false', CHAT_RECIPE_GENERATION_ENABLED:'false', ROBOKASSA_TEST:'false' });
const fromRoot = file => import(pathToFileURL(path.join(process.cwd(), 'src', file)));
const {db,resolvePrivateTelegramUser,getPendingIntent,setPendingIntent,listRecipes,claimUpdate,completeUpdate} = await fromRoot('db.js');
const {startTrial,getSubscriptionAccess} = await fromRoot('subscriptions.js');
// A live container may configure a CONNECT proxy which bypasses global fetch.
delete process.env.OPENAI_HTTPS_PROXY;
const {handleChatUpdate} = await fromRoot('telegram.js');
const {collectionWelcome,collectionSaved,collectionButtonText} = await fromRoot('collection-onboarding.js');
const {normalizeMaxUpdate} = await fromRoot('max-events.js');
const {maxStore} = await fromRoot('max-store.js');
const id=876543210,from={id:platform==='max'?'max:'+id:id,first_name:'Onboarding QA'},chat={id:platform==='max'?'max:'+id:id,type:'private'};
if(platform==='max')maxStore.bind(String(id),String(id));
const user=resolvePrivateTelegramUser(from),messages=[];let calls=0,failImport=false,failDelivery=false;
const recipe={title:'Омлет по семейному рецепту',description:'',servings:2,prepMinutes:5,cookMinutes:10,ingredients:[{raw:'2 яйца',name:'яйца',quantity:2,unit:'шт',comment:null,confidence:1}],steps:[{position:1,text:'Взбить яйца и приготовить на сковороде.',confidence:1}],tags:[],warnings:[],sourceName:null};
const originalFetch=globalThis.fetch;
globalThis.fetch=async(url,options)=>{
  const u=new URL(url);
  if(u.hostname==='api.openai.com'){
    calls++;const body=JSON.parse(options.body);assert.equal(body.text.format.name,'recipe_extraction');
    if(failImport)return Response.json({error:{message:'fixture unavailable'}},{status:400});
    return Response.json({status:'completed',model:'test-model',output_text:JSON.stringify(recipe),usage:{input_tokens:10,output_tokens:20}});
  }
  assert.ok(['api.telegram.org','platform-api2.max.ru'].includes(u.hostname),'Unexpected network: '+u.hostname);
  if(failDelivery)throw new Error('fixture transport failure');
  const body=JSON.parse(options.body);messages.push(body);
  return platform==='max'?Response.json({message:{body:{mid:'qa-'+messages.length,text:body.text},recipient:{chat_type:'dialog',chat_id:id}}}):Response.json({ok:true,result:{message_id:messages.length}});
};
const send=text=>handleChatUpdate({message:{from,chat,text}});
try{
  const previous={kind:'dinner-intake',profileOnly:true,intake:{householdSize:2}};
  setPendingIntent(user.id,previous);
  const initial=platform==='max'?normalizeMaxUpdate({update_type:'bot_started',timestamp:1,chat_id:id,user:{user_id:id,first_name:'QA'},payload:'collection'}):{message:{from,chat,text:'/start collection'}};
  await handleChatUpdate(initial);
  assert.equal(messages.at(-1).text,collectionWelcome);assert.equal(calls,0);assert.equal(getSubscriptionAccess(user.id).active,false);
  const buttons=platform==='max'?messages.at(-1).attachments[0].payload.buttons:messages.at(-1).reply_markup.inline_keyboard;
  assert.equal(buttons[0][0].text,collectionButtonText);
  if(platform==='telegram')assert.equal(new URL(buttons[0][0].web_app.url).searchParams.get('view'),'collection');
  else assert.equal(JSON.parse(Buffer.from(buttons[0][0].payload,'base64url')).view,'collection');
  await send('/start collection');assert.deepEqual(getPendingIntent(user.id).resumeIntent,previous);
  await send('/cancel');assert.deepEqual(getPendingIntent(user.id),previous);
  await send('/start collection_save');assert.match(messages.at(-1).text,/Добавить рецепт/);
  failImport=true;await send('Семейный омлет');assert.equal(listRecipes(user.id).length,0);assert.equal(getPendingIntent(user.id).collectionOnboarding,true);
  failImport=false;await send('Семейный омлет');assert.equal(listRecipes(user.id).length,1);assert.equal(getSubscriptionAccess(user.id).active,false);
  const accessCalls=calls;await send('Ещё один рецепт');assert.equal(calls,accessCalls);
  await send('/cancel');assert.deepEqual(getPendingIntent(user.id),previous);
  await send('/start collection');assert.equal(messages.at(-1).text,collectionWelcome);
  startTrial(user.id);await send('Другой семейный рецепт');assert.equal(listRecipes(user.id).length,2);
  assert.ok(messages.some(m=>m.text?.includes(collectionSaved)));assert.equal(getPendingIntent(user.id).collectionOnboarding,true);
  const before=calls;await send('Другой семейный рецепт');assert.equal(calls,before);assert.equal(listRecipes(user.id).length,2);
  // The production update registry prevents replayed deliveries from duplicating prompts.
  const key=platform==='max'?'max:collection-onboarding-qa':987654321;let delivered=0;
  for(let i=0;i<2;i++)if(claimUpdate(key)){await send('/start collection');completeUpdate(key);delivered++;}
  assert.equal(delivered,1);
  const prompts=db.prepare("SELECT COUNT(*) n FROM product_events WHERE event='chat_prompt_delivered' AND user_id=?").get(user.id).n;
  failDelivery=true;await assert.rejects(send('/start collection'));failDelivery=false;
  assert.equal(db.prepare("SELECT COUNT(*) n FROM product_events WHERE event='chat_prompt_delivered' AND user_id=?").get(user.id).n,prompts);
  const operations=db.prepare("SELECT step,duration_ms,detail_json FROM product_events WHERE event='operation_finished' AND user_id=?").all(user.id);
  assert.ok(operations.some(o=>o.step==='import'&&o.duration_ms>=0));assert.ok(operations.some(o=>JSON.parse(o.detail_json).status>=400));
  console.log(JSON.stringify({platform,checks:['entry','collection-button','no-auto-trial','resume-cancel','explicit-import','access-denial','failed-import-retry','saved-confirmation','duplicate-import','duplicate-update','delivery-failure','analytics'],recipes:listRecipes(user.id).length,operations:operations.length,network:'intercepted',database:'temporary'}));
} finally {globalThis.fetch=originalFetch;db.close();for(const suffix of ['','-wal','-shm'])fs.rmSync(path.join(directory,'test.sqlite')+suffix,{force:true});fs.rmdirSync(directory);}
