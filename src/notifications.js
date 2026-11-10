import { getDinnerRecommendation } from './dinner-store.js';
import { decideDinner, getDinnerRecipe, prefetchDinner, resumeDinner, startDinner } from './dinner-service.js';
import {
  attachNotificationSession, chooseNotificationRecipe, discardNotificationDelivery, enqueueDueNotifications, getNotificationDelivery, getNotificationSchedule,
  getNotificationDeliveryForDispatch, listPendingChoiceDeliveries, listPendingReminderDeliveries,
  markChoiceFailed, markChoiceSent, markReminderFailed, markReminderSent
} from './notification-store.js';
import { log } from './log.js';
import { config } from './config.js';
import { getSubscriptionAccess, requireNotificationSubscription } from './subscriptions.js';
import { digestMember, cancelDigestParts } from './trial-digest-store.js';

const notFound = () => Object.assign(new Error('Это уведомление больше недоступно'), { status: 404 });
const badRequest = (message) => Object.assign(new Error(message), { status: 400 });

function preparedDelivery(id) {
  let delivery = getNotificationDeliveryForDispatch(id);
  if (!delivery) throw notFound();
  if (digestMember(delivery.userId)) return delivery;
  if (!delivery.sessionId) {
    const dinner = startDinner(delivery.userId, { prefetchOnly: true });
    delivery = attachNotificationSession(id, dinner.sessionId);
  }
  prefetchDinner(delivery.userId, delivery.sessionId);
  return delivery;
}

export function openNotificationDinner(userId, id) {
  const delivery = getNotificationDelivery(userId, id);
  if (!delivery || !delivery.sessionId || !['sent', 'chosen'].includes(delivery.status)) throw notFound();
  requireNotificationSubscription(userId);
  const acceptedOption = delivery.status === 'chosen' ? { id: delivery.recommendationId, recipe: getDinnerRecipe(userId, delivery.recipeKey) } : null;
  if (acceptedOption && !acceptedOption.recipe) throw notFound();
  return { ...resumeDinner(userId, delivery.sessionId), notificationId: delivery.id, alreadyChosen: delivery.status === 'chosen', acceptedOption };
}

export function selectNotificationDinner(userId, id, recommendationId) {
  const delivery = getNotificationDelivery(userId, id);
  if (!delivery || !delivery.sessionId || !['sent', 'chosen'].includes(delivery.status)) throw notFound();
  requireNotificationSubscription(userId);
  if (delivery.status === 'chosen') {
    if (delivery.recommendationId !== recommendationId) throw badRequest('Рецепт для этого уведомления уже выбран');
    const recipe = getDinnerRecipe(userId, delivery.recipeKey);
    if (!recipe) throw notFound();
    return { delivery, recipe, status: 'accepted', alreadyChosen: true };
  }
  const recommendation = getDinnerRecommendation(userId, recommendationId);
  if (!recommendation || recommendation.session_id !== delivery.sessionId) throw badRequest('Этот рецепт не относится к подборке из уведомления');
  const decision = decideDinner(userId, recommendationId, 'accepted');
  if (decision.status !== 'accepted' || !decision.recipe) throw badRequest('Этот вариант уже недоступен');
  const chosen = chooseNotificationRecipe(userId, id, recommendationId, decision.recipeKey);
  if (!chosen) throw badRequest('Не удалось сохранить выбор');
  return { delivery: chosen, recipe: decision.recipe, savedRecipe: decision.savedRecipe, status: decision.status, alreadyChosen: false };
}

let cycleRunning = false;
export async function runNotificationCycle({ sendReminder, sendChoice }, at) {
  if (!config.legacyDinnerNotificationsEnabled) return;
  if (cycleRunning) return;
  cycleRunning = true;
  const currentTime = () => at || new Date();
  try {
    enqueueDueNotifications(currentTime());
    for (const pending of listPendingReminderDeliveries(currentTime())) {
      if (!getSubscriptionAccess(pending.userId, currentTime()).active || !getNotificationSchedule(pending.userId, currentTime()).enabled
        || digestMember(pending.userId) && currentTime().getTime()-Date.parse(pending.scheduledFor)>15*60000) {
        discardNotificationDelivery(pending.id, currentTime());
        cancelDigestParts(pending.id);
        continue;
      }
      try {
        const delivery = preparedDelivery(pending.id);
        await sendReminder(delivery);
        markReminderSent(delivery.id);
      } catch (error) {
        if (error?.digestTerminal) { discardNotificationDelivery(pending.id,currentTime()); cancelDigestParts(pending.id); }
        else markReminderFailed(pending.id);
        log('warn', 'notification_reminder_failed', { error, deliveryId: pending.id });
      }
    }
    for (const pending of listPendingChoiceDeliveries(currentTime())) {
      if (!getSubscriptionAccess(pending.userId, currentTime()).active) {
        discardNotificationDelivery(pending.id, currentTime());
        continue;
      }
      try {
        const recipe = getDinnerRecipe(pending.userId, pending.recipeKey);
        if (!recipe) throw new Error('Chosen notification recipe is unavailable');
        await sendChoice(pending, recipe);
        markChoiceSent(pending.id);
      } catch (error) {
        markChoiceFailed(pending.id);
        log('warn', 'notification_choice_failed', { error, deliveryId: pending.id });
      }
    }
  } finally { cycleRunning = false; }
}

let notificationTimer = null;
export function startNotificationScheduler(adapters) {
  if (!config.legacyDinnerNotificationsEnabled) return;
  if (notificationTimer) return;
  const tick = () => runNotificationCycle(adapters).catch((error) => log('error', 'notification_cycle_failed', { error }));
  void tick();
  notificationTimer = setInterval(tick, 30000);
  notificationTimer.unref?.();
}

export function stopNotificationScheduler() {
  if (notificationTimer) clearInterval(notificationTimer);
  notificationTimer = null;
}
