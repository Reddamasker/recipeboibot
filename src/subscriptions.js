import { db, saveRecipeSuggestion } from './db.js';
import {selectionRecord,selectionMetadata,stageSelection,unlockSelection,redactRecipeData} from './first-recipe-selection.js';
import { config } from './config.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

// Only trusted server administration/payment integrations may write this table.
db.exec(`CREATE TABLE IF NOT EXISTS user_subscriptions (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  plan TEXT NOT NULL CHECK(plan IN ('subscription','premium')),
  starts_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  updated_at TEXT NOT NULL
);`);

db.exec(`CREATE TABLE IF NOT EXISTS user_trials (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  starts_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);`);

db.exec(`CREATE TABLE IF NOT EXISTS first_recipe_results (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  request_key TEXT NOT NULL,
  owner TEXT NOT NULL,
  started_at TEXT NOT NULL,
  result_json TEXT
);`);
const firstRecipeContext = new AsyncLocalStorage();
db.exec(`CREATE TABLE IF NOT EXISTS first_dinner_previews (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  selected_id TEXT
);`);

// Historical records keep the prior delivered-recipe entitlement.
if(!db.prepare('PRAGMA table_info(first_recipe_results)').all().some(c=>c.name==='trial_required'))db.exec('ALTER TABLE first_recipe_results ADD COLUMN trial_required INTEGER NOT NULL DEFAULT 0');
if(!db.prepare('PRAGMA table_info(first_dinner_previews)').all().some(c=>c.name==='trial_gate'))db.exec('ALTER TABLE first_dinner_previews ADD COLUMN trial_gate INTEGER NOT NULL DEFAULT 0');

export const getPendingFirstRecipe=userId=>selectionMetadata(userId);
export function firstRecipeTrialGateUsed(userId){return Boolean(selectionRecord(userId)||db.prepare('SELECT 1 FROM first_recipe_results WHERE user_id=? AND trial_required=1').get(userId)||db.prepare('SELECT 1 FROM first_dinner_previews WHERE user_id=? AND trial_gate=1').get(userId));}
export function isFirstRecipeAwaitingTrial(userId){const selected=selectionMetadata(userId);return Boolean(selected&&!selected.unlocked&&!getSubscriptionAccess(userId).active);}
export function unlockFirstRecipe(userId,at=new Date()){return getSubscriptionAccess(userId,at).active?unlockSelection(userId,at):null;}
export function stageFirstRecipe(userId,input){
 if(getSubscriptionAccess(userId).active||hasUsedTrialOrPromo(userId)||!firstRecipeTrialGateUsed(userId))return null;
 return stageSelection(userId,input);
}
export function firstRecipePreviewLocked(userId){
 if(getSubscriptionAccess(userId).active||selectionMetadata(userId)?.unlocked)return false;
 if(firstRecipeTrialGateUsed(userId))return true;
 // Existing legacy dinner previews remain on their former entitlement.
 if(db.prepare('SELECT 1 FROM first_dinner_previews WHERE user_id=? AND trial_gate=0').get(userId))return false;
 return false;
}
export function assertFirstRecipeReadable(userId,options={}){
 const freshCatalog=options?.catalog&&getFirstRecipeStatus(userId).available&&!db.prepare('SELECT 1 FROM first_dinner_previews WHERE user_id=? AND trial_gate=0').get(userId);
 if(!firstRecipePreviewLocked(userId)&&!freshCatalog){if(getSubscriptionAccess(userId).active)unlockFirstRecipe(userId);return;}
 throw Object.assign(new Error(getPendingFirstRecipe(userId)?'Рецепт выбран. Начните 7 дней бесплатно, чтобы открыть ингредиенты и шаги.':'Сначала выберите первый рецепт и начните пробный период.'),{status:402,offerPath:'/?view=benefits',awaitingTrial:isFirstRecipeAwaitingTrial(userId),pendingFirstRecipe:getPendingFirstRecipe(userId)});
}
export function protectFirstRecipeResponse(userId,value){
 if(!firstRecipePreviewLocked(userId))return value;
 const safe=redactRecipeData(value),pending=getPendingFirstRecipe(userId);
 if(pending&&safe&&typeof safe==='object'&&!Array.isArray(safe))return {...safe,firstFreeRecipe:false,awaitingTrial:true,pendingFirstRecipe:pending};
 return safe;
}

export function hasFirstDinnerPreview(userId) {
  return !hasUsedTrialOrPromo(userId) && !db.prepare('SELECT 1 FROM user_subscriptions WHERE user_id=?').get(userId)
    && Boolean(db.prepare('SELECT 1 FROM first_dinner_previews WHERE user_id=? AND selected_id IS NULL').get(userId));
}

export function requireDinnerEntry(userId, claim = true) {
  if(isFirstRecipeAwaitingTrial(userId))return assertFirstRecipeReadable(userId);
  if (getSubscriptionAccess(userId).active || hasFirstDinnerPreview(userId)) return;
  const legacy = db.prepare('SELECT request_key,result_json FROM first_recipe_results WHERE user_id=?').get(userId);
  if (legacy?.request_key.startsWith('dinner:') && legacy.result_json && !getFirstRecipeStatus(userId).usedAccess
    && !db.prepare("SELECT 1 FROM dinner_events WHERE user_id=? AND event='recommendation_accepted' LIMIT 1").get(userId)) {
    db.prepare('INSERT OR IGNORE INTO first_dinner_previews(user_id) VALUES(?)').run(userId);
    return;
  }
  if (!getFirstRecipeStatus(userId).available) return requireUnexpiredTrial(userId);
  if (!claim) return;
  db.prepare('INSERT OR IGNORE INTO first_dinner_previews(user_id,trial_gate) VALUES(?,1)').run(userId);
}

export function canChooseFirstDinner(userId) {
  if (getSubscriptionAccess(userId).active || getFirstRecipeStatus(userId).usedAccess) return false;
  if (hasFirstDinnerPreview(userId) || getFirstRecipeStatus(userId).available) return true;
  const legacy = db.prepare('SELECT request_key,result_json FROM first_recipe_results WHERE user_id=?').get(userId);
  return Boolean(legacy?.request_key.startsWith('dinner:') && legacy.result_json
    && !db.prepare("SELECT 1 FROM dinner_events WHERE user_id=? AND event='recommendation_accepted' LIMIT 1").get(userId));
}

export function completeFirstDinner(userId, selectedId, recipe) {
  if (!hasFirstDinnerPreview(userId)) return !getSubscriptionAccess(userId).active && !hasUsedTrialOrPromo(userId)
    && db.prepare('SELECT selected_id FROM first_dinner_previews WHERE user_id=?').get(userId)?.selected_id === selectedId;
  db.prepare('UPDATE first_dinner_previews SET selected_id=? WHERE user_id=? AND selected_id IS NULL').run(selectedId, userId);
  const timestamp = new Date().toISOString();
  db.prepare(`INSERT INTO first_recipe_results(user_id,request_key,owner,started_at,result_json,completed_at) VALUES(?,?,?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET request_key=excluded.request_key,result_json=excluded.result_json,completed_at=excluded.completed_at`)
    .run(userId, `dinner-selected:${selectedId}`, randomUUID(), timestamp, JSON.stringify({ recipe, firstFreeRecipe: true }), timestamp);
  if(firstRecipeTrialGateUsed(userId))stageFirstRecipe(userId,{recipe,recipeId:recipe?.id,selectedId,source:'dinner'});
  return true;
}
if (!db.prepare('PRAGMA table_info(first_recipe_results)').all().some(column => column.name === 'completed_at')) db.exec('ALTER TABLE first_recipe_results ADD COLUMN completed_at TEXT');
const firstRecipeInFlight = new Map();
const tableExists = name => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));

export function getFirstRecipeResult(userId) {
  const row = db.prepare('SELECT result_json FROM first_recipe_results WHERE user_id=?').get(userId);
  return row?.result_json ? JSON.parse(row.result_json) : null;
}

export function getFirstRecipeStatus(userId) {
  const row = db.prepare('SELECT * FROM first_recipe_results WHERE user_id=?').get(userId);
  const historical = Boolean(db.prepare("SELECT 1 FROM recipes WHERE user_id=? AND status IN ('ready','archived') LIMIT 1").get(userId)
    || (tableExists('recipe_suggestions') && db.prepare('SELECT 1 FROM recipe_suggestions WHERE user_id=? LIMIT 1').get(userId))
    || (tableExists('dinner_events') && db.prepare("SELECT 1 FROM dinner_events WHERE user_id=? AND event='recommendation_shown' LIMIT 1").get(userId)));
  const usedAccess = hasUsedTrialOrPromo(userId) || Boolean(db.prepare('SELECT 1 FROM user_subscriptions WHERE user_id=?').get(userId));
  const preview = hasFirstDinnerPreview(userId);
  const awaitingTrial=isFirstRecipeAwaitingTrial(userId);
  return { available: !row && (!historical || preview) && !usedAccess, delivered: !preview && !awaitingTrial && (Boolean(row?.result_json) || historical),
    pending: Boolean(row && !row.result_json), usedAccess,awaitingTrial,trialGateUsed:firstRecipeTrialGateUsed(userId) };
}

export function canReceiveFirstRecipe(userId) {
  return getSubscriptionAccess(userId).active || getFirstRecipeStatus(userId).available
    || firstRecipeContext.getStore() === userId;
}

export function requireRecipeEntry(userId) {
  if(isFirstRecipeAwaitingTrial(userId))return assertFirstRecipeReadable(userId);
  if (hasFirstDinnerPreview(userId)) return;
  if (canReceiveFirstRecipe(userId)) return;
  if (getFirstRecipeStatus(userId).pending) throw Object.assign(new Error('Первый рецепт ещё готовится. Дождитесь результата.'), { status: 409 });
  requireUnexpiredTrial(userId);
}

// One successful result shared by requests, dinner and import. Failed attempts do not use it.
export async function withFirstRecipe(userId, requestKey, operation, succeeded = () => true) {
  if (getSubscriptionAccess(userId).active || firstRecipeContext.getStore() === userId) return operation();
  if (hasFirstDinnerPreview(userId)) return requireUnexpiredTrial(userId);
  const running = firstRecipeInFlight.get(userId);
  if (running) {
    if (running.key === requestKey) return running.promise;
    throw Object.assign(new Error('Первый рецепт ещё готовится. Дождитесь результата.'), { status: 409 });
  }
  let row = db.prepare('SELECT * FROM first_recipe_results WHERE user_id=?').get(userId);
  if (row?.result_json && row.request_key === requestKey && !getFirstRecipeStatus(userId).usedAccess) return JSON.parse(row.result_json);
  if (row && !row.result_json && Date.now() - Date.parse(row.started_at) > 10 * 60_000) {
    db.prepare('DELETE FROM first_recipe_results WHERE user_id=? AND owner=? AND result_json IS NULL').run(userId, row.owner);
    row = null;
  }
  if (row && !row.result_json) throw Object.assign(new Error('Первый рецепт ещё готовится. Дождитесь результата.'), { status: 409 });
  if (!getFirstRecipeStatus(userId).available) requireUnexpiredTrial(userId);
  const owner = randomUUID();
  const claimed = db.prepare('INSERT OR IGNORE INTO first_recipe_results(user_id,request_key,owner,started_at,trial_required) VALUES(?,?,?,?,1)')
    .run(userId, requestKey, owner, new Date().toISOString()).changes;
  if (!claimed) throw Object.assign(new Error('Первый рецепт ещё готовится. Дождитесь результата.'), { status: 409 });
  const promise = firstRecipeContext.run(userId, async () => {
    try {
      const result = await operation();
      const completed = succeeded(result);
      const delivered = completed ? { ...result, firstFreeRecipe: true } : result;
      if(completed){
        const recipe=result.recipe||result.suggestion?.recipe||result.recommendation?.recipe;
        let recipeId=recipe?.id;
        if(result.suggestion?.id&&db.prepare('SELECT 1 FROM recipe_suggestions WHERE id=? AND user_id=?').get(result.suggestion.id,userId))recipeId=saveRecipeSuggestion(userId,result.suggestion.id)?.id||recipeId;
        stageFirstRecipe(userId,{recipe,recipeId,source:requestKey.startsWith('import')?'import':'request'});
      }
      if (completed) db.prepare('UPDATE first_recipe_results SET result_json=?,completed_at=? WHERE user_id=? AND owner=?').run(JSON.stringify(delivered), new Date().toISOString(), userId, owner);
      else db.prepare('DELETE FROM first_recipe_results WHERE user_id=? AND owner=?').run(userId, owner);
      return delivered;
    } catch (error) {
      db.prepare('DELETE FROM first_recipe_results WHERE user_id=? AND owner=? AND result_json IS NULL').run(userId, owner);
      throw error;
    } finally { firstRecipeInFlight.delete(userId); }
  });
  firstRecipeInFlight.set(userId, { key: requestKey, promise });
  return promise;
}

export function getTrialStatus(userId, at = new Date()) {
  const trial = db.prepare('SELECT starts_at,expires_at FROM user_trials WHERE user_id=?').get(userId);
  return {
    used: Boolean(trial),
    active: Boolean(trial && Date.parse(trial.starts_at) <= at.getTime() && at.getTime() < Date.parse(trial.expires_at)),
    startsAt: trial?.starts_at || null,
    expiresAt: trial?.expires_at || null,
    durationDays: 7
  };
}

export function startTrial(userId, at = new Date()) {
  // The unique user key makes retries and concurrent clicks idempotent.
  if (getTrialStatus(userId, at).used) { unlockFirstRecipe(userId,at); return getTrialStatus(userId, at); }
  if (getSubscriptionAccess(userId, at).active) throw Object.assign(new Error('У вас уже есть активный доступ'), { status: 409 });
  db.prepare('INSERT OR IGNORE INTO user_trials(user_id,starts_at,expires_at) VALUES(?,?,?)')
    .run(userId, at.toISOString(), new Date(at.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString());
  unlockFirstRecipe(userId,at);
  return getTrialStatus(userId, at);
}

export function monthsAfter(timestamp, months = 1) {
  const date = new Date(timestamp);
  const count = Number(months);
  if (!Number.isFinite(date.getTime()) || !Number.isSafeInteger(count) || count < 1 || count > 120) return null;
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + count);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return date.toISOString();
}

export function monthAfter(timestamp) {
  return monthsAfter(timestamp, 1);
}

export function getSubscriptionAccess(userId, at = new Date()) {
  const row = db.prepare('SELECT * FROM user_subscriptions WHERE user_id=?').get(userId);
  if (row && !row.revoked_at && Date.parse(row.starts_at) <= at.getTime() && Date.parse(row.expires_at) > at.getTime()) {
    return { active: true, plan: row.plan, expiresAt: row.expires_at, source: 'subscription' };
  }
  // Mock payment is an entitlement only inside the separate test contour.
  if (config.testContour && db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='mock_payments'").get()) {
    const payment = db.prepare('SELECT active,updated_at FROM mock_payments WHERE user_id=?').get(userId);
    if (payment?.active) {
      const orderTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='mock_orders'").get();
      const success = orderTable && db.prepare("SELECT * FROM mock_orders WHERE user_id=? AND status='success' ORDER BY updated_at DESC LIMIT 1").get(userId);
      const startedAt = success?.updated_at || payment.updated_at;
      const expiresAt = monthsAfter(startedAt, success?.period_months || 1);
      if (Date.parse(startedAt) <= at.getTime() && Date.parse(expiresAt) > at.getTime()) return { active: true, plan: 'subscription', expiresAt, source: 'test_payment' };
    }
  }
  const trial = getTrialStatus(userId, at);
  if (trial.active && !row?.revoked_at) return { active: true, plan: 'trial', expiresAt: trial.expiresAt, source: 'trial' };
  return { active: false, plan: null, expiresAt: row?.expires_at || trial.expiresAt || null, source: null };
}

export function requireNotificationSubscription(userId, at = new Date()) {
  const access = getSubscriptionAccess(userId, at);
  if (!access.active) throw Object.assign(new Error('Напоминания доступны с активной подпиской или премиум-доступом к боту'), { status: 402 });
  return access;
}

export function requireUnexpiredTrial(userId, at = new Date()) {
  if (!getSubscriptionAccess(userId, at).active) {
    const message = hasUsedTrialOrPromo(userId, at)
      ? 'Бесплатный период закончился. Оформите подписку, чтобы продолжить.'
      : 'Начните бесплатный пробный период на 7 дней или оформите подписку, чтобы продолжить.';
    throw Object.assign(new Error(message), { status: 402, offerPath: '/?view=offer' });
  }
}

export function hasUsedTrialOrPromo(userId, at = new Date()) {
  return getTrialStatus(userId, at).used || Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='promo_redemptions'").get()
    && db.prepare('SELECT 1 FROM promo_redemptions WHERE user_id=? AND redeemed_at IS NOT NULL LIMIT 1').get(userId));
}

export function grantSubscription(userId, plan, expiresAt, at = new Date()) {
  const expires = new Date(expiresAt);
  if (!['subscription', 'premium'].includes(plan) || !Number.isFinite(expires.getTime()) || expires <= at) throw new Error('Укажите тариф subscription|premium и будущий срок окончания');
  const timestamp = at.toISOString();
  db.prepare(`INSERT INTO user_subscriptions(user_id,plan,starts_at,expires_at,updated_at) VALUES(?,?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET plan=excluded.plan,starts_at=excluded.starts_at,expires_at=excluded.expires_at,revoked_at=NULL,updated_at=excluded.updated_at`)
    .run(userId, plan, timestamp, expires.toISOString(), timestamp);
  return getSubscriptionAccess(userId, at);
}

export function revokeSubscription(userId, at = new Date()) {
  db.prepare('UPDATE user_subscriptions SET revoked_at=?,updated_at=? WHERE user_id=?').run(at.toISOString(), at.toISOString(), userId);
  return getSubscriptionAccess(userId, at);
}
