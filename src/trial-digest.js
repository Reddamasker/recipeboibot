import { db } from './db.js';
import { config } from './config.js';
import { getFoodProfile, getDinnerHistory } from './dinner-store.js';
import { SEED_RECIPES, rankCandidates, totalMinutes, isDinnerCandidate } from './dinner.js';
import { getTrialStatus, getSubscriptionAccess } from './subscriptions.js';
import { getNotificationSchedule } from './notification-store.js';
import { digestMember, digestTerminal, sendDigestPart } from './trial-digest-store.js';
import { getTasteCatalog } from './taste-profile.js';

const escape = text => String(text).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const button = (text,url) => ({text,web_app:{url}});
const controls = url => [button('Изменить время',url({view:'notifications'})),{text:'Отключить',callback_data:'digest:stop'}];

export async function sendDigestWelcome(userId, chatId, trial, {send,url}, at=new Date()) {
  if (!config.legacyDinnerNotificationsEnabled) return false;
  const member=digestMember(userId);
  if (!member) return false;
  const schedule=getNotificationSchedule(userId,at);
  const timing=`${schedule.time} (${schedule.timezone})`;
  const first=schedule.nextDueAt ? new Date(schedule.nextDueAt).toLocaleString('ru-RU',{timeZone:schedule.timezone,dateStyle:'short',timeStyle:'short'}) : null;
  const description=member.auto_enabled && schedule.enabled
    ? `Мы включили ежедневные подборки в ${timing}, чтобы тебе больше не приходилось искать рецепты самостоятельно.${first?` Первая подборка — ${first}.`:''}`
    : schedule.enabled ? `Подборки будут приходить по твоему расписанию в ${timing}.`
      : 'Подборки отключены по твоей настройке. Их можно включить в любое время.';
  await sendDigestPart({userId,key:'welcome',kind:'welcome',dueAt:trial.startsAt},()=>send('sendMessage',{
    chat_id:chatId,parse_mode:'HTML',text:`<b>Спасибо за активацию пробного периода!</b>\n\n${escape(description)}`,
    reply_markup:{inline_keyboard:[controls(url)]}
  }),at);
  await sendDigestPart({userId,key:'personalization',kind:'personalization',dueAt:trial.startsAt},()=>send('sendMessage',{
    chat_id:chatId,parse_mode:'HTML',disable_notification:true,
    text:'Чтобы подборки лучше подходили тебе, настроим персонализацию. Отметь блюда, которые нравятся и не нравятся: учтём их состав и способ приготовления.',
    reply_markup:{inline_keyboard:[[button('Настроить персонализацию',url({view:'tastes'}))]]}
  }),at);
  return true;
}

export function digestRecipes(userId, at=new Date()) {
  const profile=getFoodProfile(userId), history=getDinnerHistory(userId);
  // Recent delivery IDs are operational recommendation history, never product analytics payloads.
  const recent=new Set(db.prepare(`SELECT b.recipe_ids_json FROM trial_digest_batches b
    JOIN notification_deliveries d ON d.id=b.delivery_id WHERE b.user_id=? AND b.created_at>=?
    AND EXISTS(SELECT 1 FROM trial_digest_parts p WHERE p.delivery_id=b.delivery_id AND p.status IN ('sent','unknown','sending'))`)
    .all(userId,new Date(at.getTime()-7*86400000).toISOString()).flatMap(r=>JSON.parse(r.recipe_ids_json)));
  const ranked=rankCandidates(SEED_RECIPES.filter(r=>r.thumbnailUrl && isDinnerCandidate(r)),{profile,history,now:at.getTime()});
  const familiarOrder=new Map(getTasteCatalog().order.map((id,index)=>[id,index]));
  ranked.sort((a,b)=>b.score-a.score || familiarOrder.get(a.recipe.id)-familiarOrder.get(b.recipe.id));
  // Never fill empty slots with recipes rejected by allergies, dislikes or cooking limits.
  const fresh=ranked.filter(c=>!recent.has(c.recipe.id));
  return [...fresh,...ranked.filter(c=>recent.has(c.recipe.id))].slice(0,3).map(c=>c.recipe);
}

export async function sendDigestBatch(delivery,{send,url},fixedTime) {
  if (!config.legacyDinnerNotificationsEnabled) throw digestTerminal('scenario_retired');
  const now=()=>fixedTime||new Date(),at=now();
  const userId=delivery.userId,member=digestMember(userId);
  if (!member) return false;
  if (!db.prepare('SELECT is_allowed FROM users WHERE id=?').get(userId)?.is_allowed) throw digestTerminal('recipient_unavailable');
  let batch=db.prepare('SELECT * FROM trial_digest_batches WHERE delivery_id=?').get(delivery.id);
  if (!batch) {
    const localKey=db.prepare('SELECT local_key FROM notification_deliveries WHERE id=?').get(delivery.id)?.local_key;
    if (!localKey) throw digestTerminal('missing_delivery');
    const recipes=digestRecipes(userId,at);
    db.prepare('INSERT OR IGNORE INTO trial_digest_batches VALUES(?,?,?,?,?)')
      .run(delivery.id,userId,at.toISOString(),JSON.stringify(recipes.map(r=>r.id)),localKey.split('|')[0]);
    batch=db.prepare('SELECT * FROM trial_digest_batches WHERE delivery_id=?').get(delivery.id);
    if (!batch) throw digestTerminal('already_sent_today');
  }
  const recipes=JSON.parse(batch.recipe_ids_json).map(id=>SEED_RECIPES.find(r=>r.id===id));
  const profile=getFoodProfile(userId);
  if (recipes.some(r=>!r||!rankCandidates([r],{profile}).length)) throw digestTerminal('preferences_changed');
  const firstBatch=!db.prepare('SELECT 1 FROM trial_digest_batches WHERE user_id=? AND created_at<? LIMIT 1').get(userId,batch.created_at);
  const personalize=firstBatch && Object.keys(profile.dishRatings||{}).length<3;
  const trial=getTrialStatus(userId,at),access=getSubscriptionAccess(userId,at);
  const schedule=getNotificationSchedule(userId,at);
  const remaining=trial.expiresAt ? Date.parse(trial.expiresAt)-Date.parse(delivery.scheduledFor) : Infinity;
  const expiry=access.source==='trial' && remaining<=2*86400000
    ? `Пробный период заканчивается ${new Date(trial.expiresAt).toLocaleString('ru-RU',{timeZone:schedule.timezone,dateStyle:'short',timeStyle:'short'})} (${schedule.timezone}). Оформи подписку, чтобы продолжать получать подборки.` : '';
  for (let index=0;index<Math.max(1,recipes.length);index++) {
    // Recheck after each awaited network call: disable/access changes stop the remaining cards.
    if (!getNotificationSchedule(userId,now()).enabled || !getSubscriptionAccess(userId,now()).active) throw digestTerminal('disabled_or_expired');
    if (recipeUnsafeAfterUpdate(userId,recipes[index])) throw digestTerminal('preferences_changed');
    const recipe=recipes[index],last=index===Math.max(1,recipes.length)-1;
    let caption=recipe ? `${index===0?'<b>Что приготовить сегодня</b>\n\n':''}<b>${escape(recipe.title)}</b>\n${totalMinutes(recipe)} минут`
      : 'Пока не нашлось блюд под твои ограничения. Можно проверить настройки или поискать рецепт в приложении.';
    const keyboard=recipe?[[button('Открыть рецепт',url({recipe:recipe.id}))]]:[[button('Проверить ограничения',url({view:'dinner'}))]];
    if (last) {
      if (personalize) { caption+='\n\nОтметь хотя бы три блюда — подборки станут точнее.'; keyboard.push([button('Настроить персонализацию',url({view:'tastes'}))]); }
      if (expiry && getSubscriptionAccess(userId,now()).source==='trial') { caption+='\n\n'+escape(expiry); keyboard.push([button('Оформить подписку',url({view:'pricing'}))]); }
      keyboard.push(controls(url));
    }
    await sendDigestPart({userId,key:`${delivery.id}:${index}`,kind:recipe?'recipe':'empty',deliveryId:delivery.id,dueAt:delivery.scheduledFor},()=>send(recipe?'sendPhoto':'sendMessage',{
      chat_id:delivery.telegramId,parse_mode:'HTML',disable_notification:index>0,
      ...(recipe?{photo:new URL(recipe.thumbnailUrl,url({})).toString(),caption}:{text:caption}),
      reply_markup:{inline_keyboard:keyboard}
    }),at);
  }
  return true;
}

function recipeUnsafeAfterUpdate(userId,recipe) {
  return recipe && !rankCandidates([recipe],{profile:getFoodProfile(userId)}).length;
}
