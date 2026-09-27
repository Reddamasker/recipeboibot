// Temporary browser-side export helper for editable Telegram message layouts.
// Load after telegram-backend-shots.js in the local preview.
const svgEscape = value => String(value).replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'
})[char]);
const round = value => Math.round(value * 100) / 100;
const rectOf = element => {
  const rect = element.getBoundingClientRect();
  return { x: round(rect.x), y: round(rect.y), w: round(rect.width), h: round(rect.height) };
};
const rectSvg = (rect, fill, radius = 0) => `<rect x="${rect.x}" y="${rect.y}" width="${rect.w}" height="${rect.h}" rx="${radius}" fill="${fill}"/>`;
const textSvg = (x, y, value, size = 14, weight = 400, color = '#111111', anchor = 'start') =>
  `<text x="${round(x)}" y="${round(y)}" font-family="Arial" font-size="${size}" font-weight="${weight}" fill="${color}" text-anchor="${anchor}">${svgEscape(value)}</text>`;

function exportTelegramBlocks() {
  const blocks = [];
  let svg = '<svg xmlns="http://www.w3.org/2000/svg" width="390" height="844" viewBox="0 0 390 844">';
  svg += rectSvg({x: 0, y: 0, w: 390, h: 844}, '#d9e5dd');
  svg += rectSvg({x: 0, y: 0, w: 390, h: 87}, '#ffffff');
  svg += rectSvg({x: 0, y: 766, w: 390, h: 78}, '#ffffff');
  svg += textSvg(17, 17, '9:41', 13, 600);
  svg += textSvg(373, 17, '●●●  ▰  ▰', 13, 600, '#111111', 'end');
  svg += textSvg(13, 66, '‹', 28, 400, '#7d8d91');
  svg += '<circle cx="60" cy="56" r="20" fill="#547866"/>';
  svg += textSvg(60, 63, '🍽', 20, 400, '#ffffff', 'middle');
  svg += textSvg(92, 53, document.querySelector('.title').textContent, 16, 600);
  svg += textSvg(92, 72, document.querySelector('.sub').textContent, 13, 400, '#7b8589');
  svg += textSvg(373, 66, '⋮', 22, 400, '#87969a', 'end');
  const date = rectOf(document.querySelector('.date'));
  svg += rectSvg(date, '#8ca79b', 12);
  svg += textSvg(date.x + date.w / 2, date.y + date.h - 5, 'Сегодня', 12, 400, '#ffffff', 'middle');

  for (const [index, message] of [...document.querySelectorAll('.message')].entries()) {
    const bounds = rectOf(message);
    const user = message.classList.contains('user');
    svg += rectSvg(bounds, user ? '#e2ffc9' : '#ffffff', 11);
    const photo = message.querySelector('.photo');
    if (photo) svg += rectSvg(rectOf(photo), '#ecf0e9');
    const content = [...message.children].find(child => !child.className);
    const box = rectOf(content);
    const style = getComputedStyle(message);
    blocks.push({
      index,
      x: box.x,
      y: box.y,
      w: box.w,
      h: box.h,
      size: round(parseFloat(style.fontSize)),
      lineHeight: round(parseFloat(style.lineHeight)),
      text: content.innerText.replace(/\r/g, ''),
      user
    });
    const buttons = message.querySelector('.buttons');
    if (buttons) {
      const bar = rectOf(buttons);
      svg += `<line x1="${bar.x}" y1="${bar.y}" x2="${bar.x + bar.w}" y2="${bar.y}" stroke="#edf0f2"/>`;
      const items = [...buttons.querySelectorAll('.button')];
      items.forEach((item, itemIndex) => {
        const button = rectOf(item);
        if (itemIndex > 0) {
          if (buttons.classList.contains('row')) svg += `<line x1="${button.x}" y1="${button.y}" x2="${button.x}" y2="${button.y + button.h}" stroke="#edf0f2"/>`;
          else svg += `<line x1="${button.x}" y1="${button.y}" x2="${button.x + button.w}" y2="${button.y}" stroke="#edf0f2"/>`;
        }
        svg += textSvg(button.x + button.w / 2, button.y + button.h / 2 + 5, item.textContent, 14, 600, '#2790bd', 'middle');
      });
    }
    const clock = rectOf(message.querySelector('.time'));
    svg += textSvg(clock.x + clock.w, clock.y + 10, message.querySelector('.time').textContent, 10, 400, user ? '#68a16d' : '#89969b', 'end');
  }
  svg += textSvg(13, 821, '☺', 21, 400, '#89969b');
  svg += textSvg(56, 821, 'Сообщение', 15, 400, '#89969b');
  svg += textSvg(326, 821, '⌕', 21, 400, '#89969b');
  svg += textSvg(375, 821, '🎙', 21, 400, '#258fbc', 'end');
  svg += rectSvg({x: 135, y: 836, w: 120, h: 4}, '#141414', 2);
  svg += '</svg>';
  window.telegramBlockExport = {id, name: selected.name, svg, blocks};
  const output = document.createElement('textarea');
  output.id = 'telegram-block-export';
  output.value = JSON.stringify(window.telegramBlockExport);
  output.hidden = true;
  document.body.append(output);
}

exportTelegramBlocks();
