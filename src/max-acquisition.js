import { config } from './config.js';
export const MAX_AD_PLACEMENT = 'ya-max-dinner-202610';
export const MAX_AD_PAYLOAD = 'campaign_' + MAX_AD_PLACEMENT;
export const MAX_AD_NAME = 'Яндекс — ужин в MAX, октябрь 2026';
export function maxAdvertisingLink() {
  const username = config.maxBotUsername || 'id500912857935_bot';
  if (!/^[A-Za-z0-9_]{5,64}$/.test(username)) throw new Error('Неверное имя MAX-бота');
  return 'https://max.ru/' + username + '?start=' + MAX_AD_PAYLOAD;
}
