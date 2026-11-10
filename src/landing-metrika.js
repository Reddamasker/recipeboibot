// Only the public landing opts into these origins. App/API/dashboard keep their CSP.
const suffixes = ['ru','az','by','co.il','com','com.am','com.ge','com.tr','ee','fr','kg','kz','lt','lv','md','tj','tm','uz'];
const hosts = [...suffixes.map(s => `mc.yandex.${s}`), 'mc.webvisor.com', 'mc.webvisor.org'];
export const metrikaSources = hosts.map(h => `https://${h}`).join(' ');
export const metrikaConnections = `${metrikaSources} ${hosts.map(h => `wss://${h}`).join(' ')}`;
export const metrikaFrames = ['https://metrika.yandex.ru','https://metrica.yandex.com','https://metrika.yandex.by','https://metrica.yandex.com.tr','https://webvisor.com','https://*.webvisor.com'].join(' ');
export function landingMetrikaCounter(settings) {
  const value = Number(settings.yandexMetrikaCounterId);
  return !settings.testContour && settings.botPlatform === 'telegram' && Number.isSafeInteger(value) && value > 0 ? value : 0;
}
