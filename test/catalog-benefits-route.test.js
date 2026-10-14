import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('catalog invitation resolves the correct bot in all contours without accepting an external destination', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-entry-'));
  fs.mkdirSync(path.join(directory,'public'));
  fs.copyFileSync(new URL('../public/catalog.html',import.meta.url),path.join(directory,'public','catalog.html'));
  const serverModule = new URL('../src/server.js', import.meta.url).href;
  const dbModule = new URL('../src/db.js', import.meta.url).href;
  try {
    for (const [platform, testContour, expected] of [
      ['telegram', 'false', 'https://t.me/Recipeboibot?start=dinner'],
      ['telegram', 'true', 'https://t.me/recipeboi_test_bot?start=dinner'],
      ['max', 'false', 'https://max.ru/id500912857935_bot?start=dinner'],
    ]) {
      const code = `
        const { createServer } = await import(${JSON.stringify(serverModule)});
        const { db } = await import(${JSON.stringify(dbModule)});
        const server = createServer();
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const url = 'http://127.0.0.1:' + server.address().port + '/open/recipe-bot?url=https://example.org&start=other';
        const results = [];
        for (const method of ['GET', 'HEAD', 'POST']) {
          const response = await fetch(url, { method, redirect: 'manual' });
          results.push({status:response.status, location:response.headers.get('location'), cache:response.headers.get('cache-control')});
          await response.text();
        }
        const catalog = await fetch('http://127.0.0.1:' + server.address().port + '/recipes?benefits=preview');
        const html = await catalog.text();
        const head = await fetch('http://127.0.0.1:' + server.address().port + '/recipes', {method:'HEAD'});
        const headBody = await head.text();
        await new Promise(resolve => server.close(resolve)); db.close();
        console.log(JSON.stringify({results, html, catalogStatus:catalog.status, cache:catalog.headers.get('cache-control'), headStatus:head.status, headBody}));
      `;
      const run = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
        cwd: directory, encoding: 'utf8', timeout: 15000,
        env: { ...process.env, DATABASE_PATH: path.join(directory, `${platform}-${testContour}.sqlite`),
          BOT_PLATFORM: platform, TEST_CONTOUR: testContour, TEST_BOT_USERNAME: 'recipeboi_test_bot',
          MAX_BOT_USERNAME: 'id500912857935_bot', TELEGRAM_BOT_TOKEN: 'local-test-only',
          TELEGRAM_POLLING: 'false', DINNER_LLM_ENABLED: 'false', DINNER_IMAGES_ENABLED: 'false', OPENAI_API_KEY: 'unused' },
      });
      assert.equal(run.status, 0, run.stderr);
      const {results,html,catalogStatus,cache,headStatus,headBody} = JSON.parse(run.stdout.trim());
      assert.equal(catalogStatus,200);assert.equal(cache,'no-store');assert.equal(headStatus,200);assert.equal(headBody,'');
      assert.ok(html.includes(`<span data-benefits-platform>${platform === 'max' ? 'MAX' : 'Telegram'}</span>`));
      assert.equal(html.includes('<svg data-benefits-telegram hidden'),platform === 'max');
      assert.ok(html.includes('href="/open/recipe-bot"'));
      for (const result of results.slice(0, 2)) {
        assert.equal(result.status, 302);
        assert.equal(result.location, expected);
        assert.equal(result.cache, 'no-store');
      }
      assert.equal(results[2].status, 405);
    }
  } finally { fs.rmSync(directory, {recursive:true, force:true}); }
});
