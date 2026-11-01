import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { buildWebDocument, acceptsGzip } from '../src/web-document.js';

test('existing page includes all startup resources and allows only their exact script hashes', () => {
  const doc = buildWebDocument(path.resolve('public'));
  const html = doc.bytes.toString();
  assert.deepEqual(gunzipSync(doc.gzip), doc.bytes);
  assert.ok(doc.gzip.length < 100_000);
  assert.doesNotMatch(html, /<script[^>]+src=|<link rel="stylesheet"/);
  assert.match(html, /id="landing"/);
  assert.match(html, /id="app"/);
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 7);
  for (const [, source] of scripts) {
    assert.ok(doc.scriptHashes.includes(`'sha256-${createHash('sha256').update(source).digest('base64')}'`));
    new vm.Script(source);
  }
  assert.ok(html.indexOf('id="app"') < html.indexOf(scripts[1][0]), 'SDK and app run only after the existing DOM is parsed');
  assert.ok(scripts[3][1].includes('globalThis.RecipeDetail ='));
  assert.ok(scripts[4][1].includes("window.miniProbe?.('app-script')"));
  for (const name of ['styles.css', 'refinements.css', 'landing.css', 'recipe-detail.css']) {
    assert.ok(html.includes(fs.readFileSync(`public/${name}`, 'utf8').replace(/\r\n?/g, '\n')), `${name} unchanged`);
  }
  assert.doesNotMatch(doc.scriptHashes, /unsafe-inline/);
});

test('local preview substitutes its test SDK without changing production assets', () => {
  const doc = buildWebDocument(path.resolve('public'), { telegramSdk: 'window.Telegram = { WebApp: { initData: "test-only" } };' });
  assert.match(doc.bytes.toString(), /initData: "test-only"/);
  assert.doesNotMatch(buildWebDocument(path.resolve('public')).bytes.toString(), /test-only/);
});

test('gzip is sent only when the client accepts it', () => {
  assert.equal(acceptsGzip(), false);
  assert.equal(acceptsGzip('br'), false);
  assert.equal(acceptsGzip('gzip;q=0, br'), false);
  assert.equal(acceptsGzip('gzip; q=0.000'), false);
  assert.equal(acceptsGzip('gzip;q=0.5, br'), true);
  assert.equal(acceptsGzip('gzip, deflate, br'), true);
});

test('landing exposes the public offer and entrepreneur details', () => {
  const landing = fs.readFileSync('public/index.html', 'utf8');
  const offer = fs.readFileSync('public/offer.html', 'utf8');
  const tariffs = fs.readFileSync('public/tariffs.html', 'utf8');
  const footer = landing.match(/<footer class="lp-footer[\s\S]*?<\/footer>/)?.[0] ?? '';
  assert.match(landing, /href="\/offer\.html"/);
  assert.doesNotMatch(landing, /href="\/tariffs\.html"/);
  assert.match(footer, /href="\/privacy\.html"/);
  assert.doesNotMatch(footer, /terms\.html/);
  assert.match(landing, /ИП Спасский Никита Алексеевич/);
  assert.match(landing, /ИНН 500912857935/);
  assert.match(landing, /ОГРНИП 319502700028548/);
  assert.match(offer, /Публичная оферта о заключении договора об оказании услуг/);
  assert.match(offer, /<strong>Тариф<\/strong>/);
  assert.match(offer, /оплаты Услуг Заказчиком, когда выбранный тариф является платным/);
  assert.match(offer, /формирование вариантов рецептов с применением программных алгоритмов и технологий искусственного интеллекта/);
  assert.match(offer, /ОГРНИП<\/dt><dd>319502700028548/);
  assert.match(offer, /Досудебный порядок является обязательным только в случаях/);
  assert.doesNotMatch(offer, /бесплатного закрытого теста/);
  assert.doesNotMatch(offer, /Telegram Stars/i);
  assert.match(offer, /href="\/#pricing"/);
  const faq = landing.match(/<section class="lp-faq[\s\S]*?<\/section>/)[0];
  assert.doesNotMatch(faq, /199|id="pricing"/);
  assert.ok(landing.indexOf('id="pricing"') > landing.indexOf(faq) + faq.length);
  assert.match(landing, /7 дней бесплатно/);
  assert.match(landing, /Без карты и автоматических списаний/);
  assert.match(landing, /1 месяц/);
  assert.match(landing, /3 месяца <small>скидка 16%/);
  assert.match(landing, /1 год <small>скидка 37%/);
  assert.match(landing, /1 499 ₽/);
  assert.match(tariffs, /http-equiv="refresh" content="0;url=\/#pricing"/);
  assert.doesNotMatch(tariffs, /Telegram Stars/i);
});
