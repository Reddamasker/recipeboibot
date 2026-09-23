import { db, listActiveTelegramGroups, setGroupAccessByTelegramId } from './db.js';

const [telegramId, value] = process.argv.slice(2);
const normalized = String(value || '').toLowerCase();
if (!/^\d+$/.test(telegramId || '') || !['on', 'off'].includes(normalized)) {
  console.error('Использование: npm run group-access -- <telegram_id> on|off');
  process.exitCode = 2;
} else {
  const user = setGroupAccessByTelegramId(telegramId, normalized === 'on');
  if (!user) {
    console.error(`Пользователь Telegram ${telegramId} не найден. Сначала он должен открыть бота.`);
    process.exitCode = 1;
  } else {
    const groups = listActiveTelegramGroups(user.id);
    console.log(JSON.stringify({ telegramId: user.telegram_id, displayName: user.display_name, groupAccess: Boolean(user.group_access), activeGroups: groups.length }, null, 2));
  }
}

db.close();
