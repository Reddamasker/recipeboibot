// Serving and consent evidence must use the same document a user actually reads.
export function platformLegalDocument(content, settings) {
  if (settings.botPlatform !== 'max') return content;
  let document = content.replaceAll('Telegram', 'MAX').replaceAll('нажать Start', 'нажать «Начать»')
    .replaceAll('https://t.me/Recipeboibot', `https://max.ru/${settings.maxBotUsername}`)
    .replaceAll('@Recipeboibot', `@${settings.maxBotUsername}`);
  document = document.replace('Исходные изображения и аудио обрабатываются в памяти и не сохраняются приложением.', 'Исходные изображения и аудио не сохраняются в коллекции. Для проверки аудио создаётся временный файл, который удаляется после обработки.');
  if (!settings.robokassaConfigured) document = document.replace('</header>', '</header><p>Оплата в MAX пока не подключена. Пробный период запускается отдельно по кнопке, без карты и списаний.</p>');
  return document;
}
