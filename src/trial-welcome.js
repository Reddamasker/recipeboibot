import { db } from './db.js';
import { config } from './config.js';
import { getTrialStatus, getSubscriptionAccess } from './subscriptions.js';
import { selectionRecord } from './first-recipe-selection.js';
import { log } from './log.js';
import { enrollTrialDigest, eligibleDigestUser, cancelDigestParts } from './trial-digest-store.js';
import { getMaxChatBinding } from './max-store.js';

db.exec(`CREATE TABLE IF NOT EXISTS trial_welcome_messages (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 chat_id TEXT NOT NULL, trial_started_at TEXT NOT NULL,
 ready INTEGER NOT NULL DEFAULT 0,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','cancelled')),
 attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL,
 claimed_at TEXT, sent_at TEXT, last_error TEXT
)`);
let sender, timer, running=false;
const rowFor=userId=>db.prepare('SELECT * FROM trial_welcome_messages WHERE user_id=?').get(userId);
function ownsRecipient(userId, chatId) {
 const id=String(chatId);
 if(!(config.botPlatform==='max'? /^max:[1-9][0-9]*$/:/^[1-9][0-9]*$/).test(id))return false;
 return Boolean(db.prepare(`SELECT 1 FROM users WHERE id=? AND telegram_id=?
 UNION SELECT 1 FROM private_test_profiles p JOIN users u ON u.id=p.owner_user_id
 WHERE p.test_user_id=? AND u.telegram_id=?`).get(userId,id,userId,id));
}
export function queueTrialWelcome(userId, chatId, {ready=false,timezone}={}) {
 const trial=getTrialStatus(userId);
 if(!trial.active||!getSubscriptionAccess(userId).active||!ownsRecipient(userId,chatId))return false;
 const digest=enrollTrialDigest(userId,timezone);
 if(digest) { ready=true; markTrialWelcomeReady(userId); }
 return Boolean(db.prepare('INSERT OR IGNORE INTO trial_welcome_messages(user_id,chat_id,trial_started_at,ready,next_attempt_at) VALUES(?,?,?,?,?)')
 .run(userId,String(chatId),trial.startsAt,ready?1:0,new Date().toISOString()).changes);
}
export function markTrialWelcomeReady(userId) {
 return Boolean(db.prepare("UPDATE trial_welcome_messages SET ready=1 WHERE user_id=? AND status='pending'").run(userId).changes);
}
export async function deliverTrialWelcome(userId, sendFn=sender) {
 if(typeof sendFn!=='function')return false;
 let row=rowFor(userId);if(!row||!row.ready||['sent','cancelled'].includes(row.status))return false;
 const now=new Date(),trial=getTrialStatus(userId,now);
 if(!trial.active||trial.startsAt!==row.trial_started_at||!getSubscriptionAccess(userId,now).active||!ownsRecipient(userId,row.chat_id)) {
  db.prepare("UPDATE trial_welcome_messages SET status='cancelled' WHERE user_id=? AND status<>'sent'").run(userId);cancelDigestParts(null,userId);return false;
 }
 // A signed Mini App session proves identity, not that the user started a chat.
 // Keep the welcome pending without transport attempts until a trusted MAX event
 // has established the recipient's chat. A later start resumes normal delivery.
 if(config.botPlatform==='max'&&!getMaxChatBinding(row.chat_id))return false;
 const stale=new Date(now.getTime()-120000).toISOString();
 db.prepare("UPDATE trial_welcome_messages SET status='pending',claimed_at=NULL WHERE user_id=? AND status='sending' AND claimed_at<=?").run(userId,stale);
 if(!db.prepare("UPDATE trial_welcome_messages SET status='sending',attempts=attempts+1,claimed_at=? WHERE user_id=? AND status='pending' AND ready=1 AND next_attempt_at<=?")
 .run(now.toISOString(),userId,now.toISOString()).changes)return false;
 row=rowFor(userId);
 try {
  await sendFn(userId,config.botPlatform==='max'?row.chat_id:Number(row.chat_id),trial);
  db.prepare("UPDATE trial_welcome_messages SET status='sent',sent_at=?,last_error=NULL WHERE user_id=? AND status='sending' AND claimed_at=?").run(new Date().toISOString(),userId,row.claimed_at);
  return true;
 }catch(error){
  if(error?.digestTerminal) {
   db.prepare("UPDATE trial_welcome_messages SET status='cancelled',last_error=? WHERE user_id=? AND status='sending'").run(error.code,userId);
   log('warn','trial_digest_welcome_stopped',{code:error.code});return false;
  }
  const next=new Date(Date.now()+Math.min(3600000,30000*2**Math.min(row.attempts-1,7))).toISOString();
  db.prepare("UPDATE trial_welcome_messages SET status='pending',next_attempt_at=?,claimed_at=NULL,last_error=? WHERE user_id=? AND status='sending' AND claimed_at=?")
  .run(next,String(error?.message||'delivery failed').slice(0,250),userId,row.claimed_at);
  log('warn','trial_welcome_delivery_failed',{userId});return false;
 }
}
export function markFirstRecipeReadForWelcome(userId, recipeId) {
 const chosen=selectionRecord(userId);
 if(!chosen||!chosen.unlocked_at||![chosen.recipe_id,chosen.recipe_key].includes(String(recipeId))||!getSubscriptionAccess(userId).active)return false;
 const marked=markTrialWelcomeReady(userId);void deliverTrialWelcome(userId);return marked;
}
export function startTrialWelcomeScheduler(sendFn) {
 stopTrialWelcomeScheduler();sender=sendFn;
 const tick=async()=>{
  if(running)return;running=true;
  try{
   recoverDigestWelcomes();
   const connected=config.botPlatform==='max'?" AND EXISTS(SELECT 1 FROM max_chat_bindings b WHERE 'max:'||b.user_id=w.chat_id)":"";
   // Waiting app-only users must not occupy the entire delivery batch.
   for(const row of db.prepare("SELECT user_id FROM trial_welcome_messages w WHERE ready=1 AND status IN ('pending','sending')"+connected+" ORDER BY next_attempt_at LIMIT 20").all())await deliverTrialWelcome(row.user_id);
  }
  catch(error){log('warn','trial_welcome_scheduler_failed',{error});}finally{running=false;}
 };
 timer=setInterval(()=>void tick(),15000);timer.unref();void tick();
}
export function stopTrialWelcomeScheduler(){if(timer)clearInterval(timer);timer=null;sender=undefined;}

export function recoverDigestWelcomes(at=new Date()) {
 if(!config.legacyDinnerNotificationsEnabled)return;
 if(config.botPlatform!=='telegram')return;
 const since=db.prepare('SELECT started_at FROM trial_digest_rollout WHERE id=1').get()?.started_at;
 if(!since)return;
 const rows=db.prepare(`SELECT u.id,u.telegram_id FROM users u JOIN user_trials t ON t.user_id=u.id
 WHERE u.created_at>? AND t.expires_at>? AND u.is_allowed=1
 AND (NOT EXISTS(SELECT 1 FROM trial_digest_members m WHERE m.user_id=u.id)
 OR NOT EXISTS(SELECT 1 FROM trial_welcome_messages w WHERE w.user_id=u.id)) LIMIT 100`).all(since,at.toISOString());
 for(const u of rows)if(eligibleDigestUser(u.id,at))queueTrialWelcome(u.id,u.telegram_id,{ready:true});
}
