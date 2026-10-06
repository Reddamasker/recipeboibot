import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { platformLegalDocument } from '../src/platform-legal.js';

test('Telegram legal documents remain byte identical for every billing mode', () => {
  for (const file of ['offer.html', 'privacy.html', 'terms.html']) {
    const content = fs.readFileSync('public/' + file, 'utf8');
    for (const robokassaConfigured of [true, false]) assert.equal(platformLegalDocument(content, { botPlatform: 'telegram', robokassaConfigured }), content);
  }
});

test('MAX legal documents reflect configured bot and billing availability', () => {
  const raw = '<header>Telegram</header><p>нажать Start</p><a href="https://t.me/Recipeboibot">@Recipeboibot</a>';
  const ready = platformLegalDocument(raw, { botPlatform: 'max', maxBotUsername: 'max_test_bot', robokassaConfigured: true });
  assert.match(ready, /https:\/\/max\.ru\/max_test_bot/);
  assert.match(ready, /@max_test_bot/);
  assert.match(ready, /нажать «Начать»/);
  assert.doesNotMatch(ready, /Telegram|пока не подключена/);
  const disabled = platformLegalDocument(raw, { botPlatform: 'max', maxBotUsername: 'max_test_bot', robokassaConfigured: false });
  assert.match(disabled, /Оплата в MAX пока не подключена/);
});
