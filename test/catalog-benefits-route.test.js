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
  fs.copyFileSync(new URL('../public/catalog-legacy.html',import.meta.url),path.join(directory,'public','catalog-legacy.html'));
  const serverModule = new URL('../src/server.js', import.meta.url).href;
  const dbModule = new URL('../src/db.js', import.meta.url).href;
  try {
    for (const [platform, testContour, maxUsername, expectedMax] of [
      ['telegram', 'false', '', 'id500912857935_bot'],
      ['telegram', 'true', '', 'id500912857935_bot'],
      ['max', 'false', 'id500912857935_bot', 'id500912857935_bot'],
      ['telegram', 'false', 'configured_recipe_bot', 'configured_recipe_bot'],
      ['telegram', 'false', 'https://attacker.example/bot?token=bad', 'id500912857935_bot'],
    ]) {
      const code = `
        const { createServer } = await import(${JSON.stringify(serverModule)});
        const { db } = await import(${JSON.stringify(dbModule)});
        const server = createServer();
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const origin = 'http://127.0.0.1:' + server.address().port;
        const results = [];
        for (const route of ['', '/telegram', '/max', '/other', '/https://attacker.example']) for (const method of ['GET', 'HEAD', 'POST']) {
          const response = await fetch(origin + '/open/recipe-bot' + route + '?url=https://example.org&start=other&platform=other', { method, redirect: 'manual' });
          results.push({route, method, status:response.status, location:response.headers.get('location'), cache:response.headers.get('cache-control')});
          await response.text();
        }
        const catalog = await fetch('http://127.0.0.1:' + server.address().port + '/recipes?benefits=preview');
        const html = await catalog.text();
        const head = await fetch('http://127.0.0.1:' + server.address().port + '/recipes', {method:'HEAD'});
        const headBody = await head.text();
        const dinner = await fetch(origin + '/dinner');
        const dinnerHtml = await dinner.text();
        const dinnerRecipe = await fetch(origin + '/dinner/pasta-tomato');
        const dinnerRecipeHtml = await dinnerRecipe.text();
        await new Promise(resolve => server.close(resolve)); db.close();
        console.log(JSON.stringify({results, html, catalogStatus:catalog.status, cache:catalog.headers.get('cache-control'), headStatus:head.status, headBody,dinnerStatus:dinner.status,dinnerHtml,dinnerRecipeStatus:dinnerRecipe.status,dinnerRecipeHtml}));
      `;
      const run = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
        cwd: directory, encoding: 'utf8', timeout: 15000,
        env: { ...process.env, DATABASE_PATH: path.join(directory, `${platform}-${testContour}.sqlite`),
          BOT_PLATFORM: platform, TEST_CONTOUR: testContour, TEST_BOT_USERNAME: 'recipeboi_test_bot',
          MAX_BOT_USERNAME: maxUsername, TELEGRAM_BOT_TOKEN: 'local-test-only',
          TELEGRAM_POLLING: 'false', DINNER_LLM_ENABLED: 'false', DINNER_IMAGES_ENABLED: 'false', OPENAI_API_KEY: 'unused' },
      });
      assert.equal(run.status, 0, run.stderr);
      const {results,html,catalogStatus,cache,headStatus,headBody,dinnerStatus,dinnerHtml,dinnerRecipeStatus,dinnerRecipeHtml} = JSON.parse(run.stdout.trim());
      assert.equal(catalogStatus,200);assert.equal(cache,'no-store');assert.equal(headStatus,200);assert.equal(headBody,'');
      if(testContour==='true'){
        assert.ok(html.includes('id="benefits-cta"'));assert.ok(html.includes('id="benefits-cta-max"'));
        assert.ok(html.includes('href="/open/recipe-bot/telegram"'));assert.ok(html.includes('href="/open/recipe-bot/max"'));
        assert.ok(!html.includes('/catalog-legacy.js'));
      }else{
        assert.ok(html.includes('/catalog-legacy.js?v=9870784'));
        assert.ok(!html.includes('catalog-benefits'));assert.ok(!html.includes('catalog-handoff'));
      }
      assert.equal(dinnerStatus,200);assert.equal(dinnerRecipeStatus,200);
      for(const document of [dinnerHtml,dinnerRecipeHtml]){assert.ok(document.includes('/catalog-handoff.js'));assert.ok(!document.includes('/catalog-legacy.js'));}
      assert.equal(html.includes('<svg data-benefits-telegram hidden'),false);
      for (const result of results) {
        if (!['','/telegram','/max'].includes(result.route)) {
          assert.equal(result.status,404);assert.equal(result.location,null);continue;
        }
        if (result.method === 'POST') {assert.equal(result.status,405);assert.equal(result.location,null);continue;}
        const useMax=result.route==='/max'||result.route===''&&platform==='max';
        const expected=useMax?`https://max.ru/${expectedMax}?start=dinner`:`https://t.me/${testContour==='true'?'recipeboi_test_bot':'Recipeboibot'}?start=dinner`;
        assert.equal(result.status, 302);
        assert.equal(result.location, expected);
        assert.equal(result.cache, 'no-store');
      }
    }
  } finally { fs.rmSync(directory, {recursive:true, force:true}); }
});
