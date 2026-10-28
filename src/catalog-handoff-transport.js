import { randomBytes, generateKeyPairSync, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { db } from './db.js';
import { config } from './config.js';
import { catalogRecipe } from './web-catalog.js';
import { createCampaign } from './funnel.js';
import { campaignPriceAssignment } from './campaign-prices.js';
import { analyticsExcludedIds } from './analytics-exclusions.js';
import { registerCatalogJourneyHandoff, recordCatalogJourneyServer } from './catalog-journey-analytics.js';

// Fixed origins are essential: a public request may never select a fetch destination.
export const handoffOrigins = Object.freeze({m:'https://dishfinder.ru',t:'https://recipeboibot-test.89-223-123-75.sslip.io',x:'https://recipeboibot-max.89-223-123-75.sslip.io'});
const own = config.botPlatform === 'max' ? 'x' : config.testContour ? 't' : 'm';
const pattern = /^ch_([mtx])_([A-Za-z0-9_-]{24})$/;
const idPattern = /^[A-Za-z0-9_-]{16,80}$/;
const ttl = 7 * 86400000;
const fail = (code,status=400) => Object.assign(new Error(code==='expired'?'Ссылка устарела. Вернитесь к рецепту на сайте и нажмите «Сохранить в боте» ещё раз.':'Не удалось передать рецепт. Вернитесь к нему на сайте и попробуйте ещё раз.'),{status,code});
db.exec(`CREATE TABLE IF NOT EXISTS catalog_transfer_metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS catalog_acquisition_visits(flow_id TEXT PRIMARY KEY,session_id TEXT NOT NULL,campaign TEXT,click_token TEXT,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS catalog_transfers(token TEXT PRIMARY KEY,origin TEXT NOT NULL,target TEXT NOT NULL,recipe_id TEXT NOT NULL,flow_id TEXT NOT NULL,session_id TEXT NOT NULL,campaign TEXT,click_token TEXT,created_at TEXT NOT NULL,expires_at TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS catalog_transfers_flow ON catalog_transfers(flow_id,recipe_id,target);
 CREATE TABLE IF NOT EXISTS catalog_transfer_outbox(token TEXT NOT NULL,event TEXT NOT NULL,body TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,delivered_at TEXT,PRIMARY KEY(token,event));`);

function keys() {
 let row=db.prepare("SELECT value FROM catalog_transfer_metadata WHERE key='signing_key'").get();
 if(!row){const pair=generateKeyPairSync('ed25519');const pem=pair.privateKey.export({type:'pkcs8',format:'pem'});db.prepare("INSERT OR IGNORE INTO catalog_transfer_metadata VALUES('signing_key',?)").run(pem);row=db.prepare("SELECT value FROM catalog_transfer_metadata WHERE key='signing_key'").get();}
 const privateKey=createPrivateKey(row.value);return {privateKey,publicKey:createPublicKey(privateKey)};
}
export function catalogHandoffPublicKey(){return {source:own,key:keys().publicKey.export({type:'spki',format:'der'}).toString('base64url')};}
export function signedCatalogEnvelope(data,at=Date.now()){
 const message={source:own,at,data};return {...message,signature:sign(null,Buffer.from(JSON.stringify(message)),keys().privateKey).toString('base64url')};
}
const keyCache=new Map();
async function boundedJson(response){if(!response.ok)throw fail('network',502);const text=await response.text();if(text.length>16000)throw fail('invalid',502);try{return JSON.parse(text);}catch{throw fail('invalid',502);}}
export async function verifyCatalogEnvelope(envelope,{transport=fetch,now=Date.now()}={}){
 const {source,at,data,signature}=envelope||{};
 if(!Object.hasOwn(handoffOrigins,source)||!Number.isSafeInteger(at)||Math.abs(now-at)>300000||typeof signature!=='string'||!/^[A-Za-z0-9_-]{86}$/.test(signature))throw fail('invalid',403);
 let entry=keyCache.get(source);
 if(!entry||now-entry.at>3600000){const remote=source===own?catalogHandoffPublicKey():await boundedJson(await transport(handoffOrigins[source]+'/api/internal/catalog-handoff/key',{redirect:'error',signal:AbortSignal.timeout(5000)}));
  if(remote.source!==source||typeof remote.key!=='string'||remote.key.length>200)throw fail('invalid',403);
  try{entry={key:createPublicKey({key:Buffer.from(remote.key,'base64url'),type:'spki',format:'der'}),at:now};}catch{throw fail('invalid',403);}
  if(entry.key.asymmetricKeyType!=='ed25519')throw fail('invalid',403);keyCache.set(source,entry);
 }
 if(!verify(null,Buffer.from(JSON.stringify({source,at,data})),entry.key,Buffer.from(signature,'base64url')))throw fail('invalid',403);
 return {source,data};
}
function knownCampaign(value){return /^[a-z0-9][a-z0-9_-]{0,39}$/.test(value||'')?db.prepare('SELECT slug FROM acquisition_campaigns WHERE slug=?').get(value)?.slug||null:null;}
export function registerCatalogAcquisitionVisit(input){
 if(input?.journey!=='recipe-first-v1'||!idPattern.test(input.flowId||'')||!idPattern.test(input.sessionId||input.session||''))return;
 const session=input.sessionId||input.session,campaign=knownCampaign(input.campaign),old=db.prepare('SELECT * FROM catalog_acquisition_visits WHERE flow_id=?').get(input.flowId);
 if(old){
  if(old.session_id!==session)return old;
  if(!old.click_token&&old.campaign&&input.visible===true){
   const clickToken=randomBytes(18).toString('base64url');
   db.exec('SAVEPOINT catalog_late_visit');
   try{db.prepare('INSERT INTO acquisition_clicks(token,campaign,created_at,tags_json) VALUES(?,?,?,?)').run(clickToken,old.campaign,old.created_at,'{}');
    db.prepare('UPDATE catalog_acquisition_visits SET click_token=? WHERE flow_id=? AND click_token IS NULL').run(clickToken,input.flowId);
    db.prepare('UPDATE catalog_transfers SET click_token=? WHERE origin=? AND flow_id=? AND click_token IS NULL').run(clickToken,own,input.flowId);
    db.exec('RELEASE catalog_late_visit');
   }catch(error){db.exec('ROLLBACK TO catalog_late_visit');db.exec('RELEASE catalog_late_visit');throw error;}
  }
  return db.prepare('SELECT * FROM catalog_acquisition_visits WHERE flow_id=?').get(input.flowId);
 }
 const token=campaign&&input.visible===true?randomBytes(18).toString('base64url'):null,at=new Date().toISOString();
 db.exec('SAVEPOINT catalog_visit');
 try{if(token)db.prepare('INSERT INTO acquisition_clicks(token,campaign,created_at,tags_json) VALUES(?,?,?,?)').run(token,campaign,at,'{}');
  db.prepare('INSERT INTO catalog_acquisition_visits VALUES(?,?,?,?,?)').run(input.flowId,session,campaign,token,at);db.exec('RELEASE catalog_visit');
 }catch(error){db.exec('ROLLBACK TO catalog_visit');db.exec('RELEASE catalog_visit');throw error;}
 return db.prepare('SELECT * FROM catalog_acquisition_visits WHERE flow_id=?').get(input.flowId);
}
const context=row=>({payload:row.token,origin:row.origin,target:row.target,catalogId:row.recipe_id,flowId:row.flow_id,sessionId:row.session_id,campaign:row.campaign,clickToken:row.click_token,targetPlatform:row.target==='x'?'max':'telegram',journey:'recipe-first-v1',createdAt:row.created_at,expiresAt:row.expires_at});
export function createCatalogHandoff(input){
 if(!input||!['telegram','max'].includes(input.platform)||!idPattern.test(input.flowId||'')||!idPattern.test(input.sessionId||'')||!catalogRecipe(input.recipeId))throw fail('invalid');
 const visit=registerCatalogAcquisitionVisit({...input,journey:'recipe-first-v1'});
 if(visit.session_id!==input.sessionId)throw fail('invalid',409);
 const target=input.platform==='max'?'x':own==='t'?'t':'m',now=Date.now();
 let row=db.prepare('SELECT * FROM catalog_transfers WHERE origin=? AND target=? AND recipe_id=? AND flow_id=? AND expires_at>? ORDER BY created_at DESC LIMIT 1').get(own,target,input.recipeId,input.flowId,new Date(now).toISOString());
 if(!row){const token=`ch_${own}_${randomBytes(18).toString('base64url')}`;
  db.prepare('INSERT INTO catalog_transfers VALUES(?,?,?,?,?,?,?,?,?,?)').run(token,own,target,input.recipeId,input.flowId,input.sessionId,visit.campaign,visit.click_token,new Date(now).toISOString(),new Date(now+ttl).toISOString());row=db.prepare('SELECT * FROM catalog_transfers WHERE token=?').get(token);}
 registerCatalogJourneyHandoff({flowId:input.flowId,sessionId:input.sessionId,campaign:visit.campaign,platform:input.platform});
 const username=target==='x'?(config.maxBotUsername||'id500912857935_bot'):target==='t'?config.testBotUsername||'recipeboi_test_bot':'Recipeboibot';
 return {url:`https://${target==='x'?'max.ru':'t.me'}/${encodeURIComponent(username)}?start=${row.token}`,flowId:input.flowId,expiresAt:row.expires_at};
}
function validRow(token){const row=db.prepare('SELECT * FROM catalog_transfers WHERE token=?').get(token);if(!row)throw fail('not_found',404);if(Date.parse(row.expires_at)<=Date.now())throw fail('expired',410);return row;}
export function catalogHandoffResolveForTarget(token,target){const row=validRow(token);if(row.origin!==own||row.target!==target)throw fail('invalid',403);return context(row);}
export async function resolveCatalogHandoff(payload,{transport=fetch}={}){
 const match=String(payload).match(pattern);if(!match)throw fail('invalid');
 let row=db.prepare('SELECT * FROM catalog_transfers WHERE token=?').get(payload);
 if(!row){if(match[1]===own)throw fail('not_found',404);
  const response=await transport(handoffOrigins[match[1]]+'/api/internal/catalog-handoff/resolve',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(signedCatalogEnvelope({token:payload})),redirect:'error',signal:AbortSignal.timeout(6000)});
  if(response.status===410)throw fail('expired',410);
  const r=await boundedJson(response);
  if(r.payload!==payload||r.origin!==match[1]||r.target!==own||!catalogRecipe(r.catalogId)||!idPattern.test(r.flowId||'')||!idPattern.test(r.sessionId||'')||!Number.isFinite(Date.parse(r.createdAt))||!Number.isFinite(Date.parse(r.expiresAt))||Date.parse(r.expiresAt)>Date.now()+ttl+60000||r.campaign!==null&&!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(r.campaign)||r.clickToken!==null&&!/^[A-Za-z0-9_-]{24}$/.test(r.clickToken))throw fail('invalid',502);
  db.prepare('INSERT OR IGNORE INTO catalog_transfers VALUES(?,?,?,?,?,?,?,?,?,?)').run(payload,r.origin,r.target,r.catalogId,r.flowId,r.sessionId,r.campaign,r.clickToken,r.createdAt,r.expiresAt);
 }
 row=validRow(payload);if(row.target!==own)throw fail('invalid',403);return context(row);
}
export function recordCatalogBotStart(user,r){
 const row=validRow(r.payload);if(row.target!==own)throw fail('invalid',403);
 if(row.campaign){createCampaign(row.campaign);if(row.click_token)db.prepare('INSERT OR IGNORE INTO acquisition_clicks(token,campaign,created_at,tags_json) VALUES(?,?,?,?)').run(row.click_token,row.campaign,row.created_at,'{}');}
 db.prepare('INSERT OR IGNORE INTO acquisition_starts(user_id,campaign,click_token,started_at,is_returning) VALUES(?,?,?,?,?)').run(user.id,row.campaign,row.click_token,new Date().toISOString(),user.is_allowed?1:0);
 campaignPriceAssignment(user.id);
}
const outcomeTypes=['catalog_bot_started','catalog_recipe_saved','catalog_save_failed'];
export function queueCatalogHandoffOutcome(r,outcome,{flush=true}={}){
 try{if(r.origin===own||!outcomeTypes.includes(outcome.type))return;
  const identity=db.prepare('SELECT telegram_id FROM users WHERE id=?').get(outcome.userId)?.telegram_id||'';
  const occurredAt=typeof outcome.occurredAt==='string'&&Number.isFinite(Date.parse(outcome.occurredAt))?outcome.occurredAt:new Date().toISOString();
  const data={token:r.payload,type:outcome.type,occurredAt,isReturning:Boolean(outcome.isReturning),isInternal:analyticsExcludedIds.includes(identity)||identity.startsWith('private-test:')||r.origin==='t',durationMs:Number.isSafeInteger(outcome.durationMs)?Math.max(0,Math.min(86400000,outcome.durationMs)):null,code:['invalid','expired','network','not_found','failed','http','timeout'].includes(outcome.code)?outcome.code:null};
  db.prepare('INSERT OR IGNORE INTO catalog_transfer_outbox(token,event,body) VALUES(?,?,?)').run(r.payload,outcome.type,JSON.stringify(data));
  if(flush)void flushCatalogHandoffOutcomes().catch(()=>{});
 }catch{/* Analytics cannot interrupt saving. */}
}
export function acceptCatalogHandoffOutcome(data,source){
 if(!data||!pattern.test(data.token||'')||!outcomeTypes.includes(data.type)||typeof data.isReturning!=='boolean'||typeof data.isInternal!=='boolean'||typeof data.occurredAt!=='string'||data.occurredAt.length>32||!Number.isFinite(Date.parse(data.occurredAt))||data.durationMs!==null&&(!Number.isSafeInteger(data.durationMs)||data.durationMs<0||data.durationMs>86400000)||data.code!==null&&!['invalid','expired','network','not_found','failed','http','timeout'].includes(data.code))throw fail('invalid');
 const row=db.prepare('SELECT * FROM catalog_transfers WHERE token=?').get(data.token);
 if(!row||row.origin!==own||row.target!==source)throw fail('invalid',403);
 if(Date.parse(data.occurredAt)<Date.parse(row.created_at)-300000||Date.parse(data.occurredAt)>Math.min(Date.now()+300000,Date.parse(row.expires_at)+300000))throw fail('invalid');
 const platform=row.target==='x'?'max':'telegram';
 recordCatalogJourneyServer(data.type,{userId:null,flowId:row.flow_id,sessionId:row.session_id,campaign:row.campaign,platform,isReturning:data.isReturning,isInternal:data.isInternal,durationMs:data.durationMs,code:data.code,occurredAt:data.occurredAt});
 if(!db.prepare('SELECT 1 FROM catalog_journey_outcomes WHERE flow_id=? AND platform=? AND event=?').get(row.flow_id,platform,data.type))throw fail('network',503);
 return {ok:true};
}
let flushing=false,timer;
export async function flushCatalogHandoffOutcomes({transport=fetch}={}){
 if(flushing)return;flushing=true;
 try{for(const row of db.prepare('SELECT * FROM catalog_transfer_outbox WHERE delivered_at IS NULL AND next_at<=? ORDER BY next_at,rowid LIMIT 10').all(Date.now())){
  try{const source=row.token.match(pattern)?.[1];if(!source)continue;
   const response=await transport(handoffOrigins[source]+'/api/internal/catalog-handoff/outcome',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(signedCatalogEnvelope(JSON.parse(row.body))),redirect:'error',signal:AbortSignal.timeout(5000)});
   const result=await boundedJson(response);if(result.ok!==true)throw fail('invalid');
   db.prepare('UPDATE catalog_transfer_outbox SET delivered_at=? WHERE token=? AND event=?').run(new Date().toISOString(),row.token,row.event);
  }catch{db.prepare('UPDATE catalog_transfer_outbox SET attempts=attempts+1,next_at=? WHERE token=? AND event=?').run(Date.now()+Math.min(3600000,10000*2**Math.min(row.attempts,9)),row.token,row.event);}
 }}finally{flushing=false;}
}
export function startCatalogHandoffScheduler(){if(!timer){timer=setInterval(()=>void flushCatalogHandoffOutcomes().catch(()=>{}),30000);timer.unref();void flushCatalogHandoffOutcomes().catch(()=>{});}}
export function stopCatalogHandoffScheduler(){clearInterval(timer);timer=null;}
