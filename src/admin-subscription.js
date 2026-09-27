// Trusted server CLI only. Never starts Telegram polling or accepts web input.
import { db, getUserByTelegramId } from './db.js';
import { getSubscriptionAccess, grantSubscription, revokeSubscription } from './subscriptions.js';

const [telegramId, action, plan, expiresAt] = process.argv.slice(2);
try {
  if (!/^[1-9][0-9]*$/.test(telegramId || '') || !['status', 'grant', 'revoke'].includes(action)
    || process.argv.length !== (action === 'grant' ? 6 : 4)) throw new Error('Usage: node src/admin-subscription.js <telegram_id> status|revoke|grant <subscription|premium> <ISO_expiry_with_timezone>');
  if (action === 'grant' && !/(?:Z|[+-]\d{2}:\d{2})$/.test(expiresAt || '')) throw new Error('Укажите часовой пояс срока окончания');
  const owner = getUserByTelegramId(telegramId);
  if (!owner) throw new Error('Пользователь не найден');
  const mapped = db.prepare('SELECT test_user_id FROM private_test_profiles WHERE owner_user_id=?').get(owner.id);
  const userId = mapped?.test_user_id || owner.id;
  const access = action === 'grant' ? grantSubscription(userId, plan, expiresAt)
    : action === 'revoke' ? revokeSubscription(userId) : getSubscriptionAccess(userId);
  console.log(JSON.stringify({ userId, ...access }));
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { db.close(); }
