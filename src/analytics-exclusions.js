import { config } from './config.js';

// Owner and Albina in Telegram/MAX. Match platform identities so reset/recreation
// also stays excluded. Stored recipes, access and advertising totals are intact.
export const analyticsExcludedIds = Object.freeze([...new Set([
  config.analyticsOwnerId, '6971956699', '193553580', 'max:464796559', 'max:115437425'
])]);
export const analyticsUserCondition = "u.telegram_id NOT IN (" + analyticsExcludedIds.map(() => '?').join(',') + ") AND u.telegram_id NOT LIKE 'private-test:%'";
