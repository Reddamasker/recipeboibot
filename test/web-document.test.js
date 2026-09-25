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
  assert.equal(scripts.length, 4);
  for (const [, source] of scripts) {
    assert.ok(doc.scriptHashes.includes(`'sha256-${createHash('sha256').update(source).digest('base64')}'`));
    new vm.Script(source);
  }
  assert.ok(html.indexOf('id="app"') < html.indexOf(scripts[1][0]), 'SDK and app run only after the existing DOM is parsed');
  assert.ok(scripts[2][1].includes("window.miniProbe?.('app-script')"));
  for (const name of ['styles.css', 'refinements.css', 'landing.css']) {
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
