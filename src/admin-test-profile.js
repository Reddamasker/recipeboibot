// Local/server administration only. Does not start Telegram polling.
import { activatePrivateTestProfile, deactivatePrivateTestProfile, privateTestProfileStatus, db } from './db.js';

const [telegramId, action] = process.argv.slice(2);
try {
  if (process.argv.length !== 4 || !/^[1-9][0-9]*$/.test(telegramId || '') || !['start', 'stop', 'status'].includes(action)) {
    throw new Error('Usage: node src/admin-test-profile.js <telegram_id> start|stop|status');
  }
  const result = action === 'start' ? activatePrivateTestProfile(telegramId)
    : action === 'stop' ? deactivatePrivateTestProfile(telegramId) : privateTestProfileStatus(telegramId);
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally { db.close(); }
