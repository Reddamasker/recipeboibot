import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('all bot entry addresses use the shared shell with contour identity; anonymous landing and public pages remain separate', () => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'test-ui-entry-'));
  try {
    for(const [platform,testContour] of [['telegram','true'],['telegram','false'],['max','false']]) {
      const result=spawnSync(process.execPath,['--input-type=module','-e',`
        import {createServer} from './src/server.js';
        import {webAppUrl} from './src/telegram.js';
        import {db} from './src/db.js';
        const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
        const origin='http://127.0.0.1:'+server.address().port,documents=[];
        for(const route of ['/?recipe=personal-id','/index.html?view=collection&recipe=personal-id','/?view=menu','/review/recime-20261109/index.html?recipe=personal-id','/share/'+'a'.repeat(32),'/recipes','/','/app','/app/?view=groceries']) {
          const response=await fetch(origin+route),html=await response.text();documents.push({route,status:response.status,cache:response.headers.get('cache-control'),review:html.includes('/shell.js?v=collection-onboarding-1'),platform:html.includes('"name":"max"'),testBot:html.includes('"botUsername":"recipeboi_test_bot"'),maxSdk:html.includes('https://st.max.ru/js/max-web-app.js')});
        }
        const head=await fetch(origin+'/index.html?recipe=personal-id',{method:'HEAD'});
        const links=[webAppUrl({recipe:'personal id'}),webAppUrl({view:'results',q:'курица с рисом',notification:'fixture-id'}),webAppUrl({view:'payment-result',order:'order-id'}),webAppUrl({view:'benefits'})];
        await new Promise(resolve=>server.close(resolve));db.close();console.log(JSON.stringify({documents,links,head:{status:head.status,body:await head.text()}}));
      `],{cwd:path.resolve('.'),encoding:'utf8',timeout:20000,env:{...process.env,DATABASE_PATH:path.join(directory,platform+testContour+'.sqlite'),BOT_PLATFORM:platform,TEST_CONTOUR:testContour,TEST_BOT_USERNAME:'recipeboi_test_bot',APP_URL:'https://recipes.example.test/?campaign=retained',TELEGRAM_BOT_TOKEN:'fixture-only',MAX_BOT_USERNAME:'max_fixture_bot',TELEGRAM_POLLING:'false',DINNER_LLM_ENABLED:'false',DINNER_IMAGES_ENABLED:'false',OPENAI_API_KEY:'unused'}});
      assert.equal(result.status,0,result.stderr);
      const value=JSON.parse(result.stdout.trim());
      for(const document of [...value.documents.slice(0,4),...value.documents.slice(7)]) {assert.equal(document.status,200);assert.equal(document.cache,'no-store');assert.equal(document.review,true);assert.equal(document.platform,platform==='max');assert.equal(document.maxSdk,platform==='max');assert.equal(document.testBot,testContour==='true');}
      assert.equal(value.documents[3].review,true);
      assert.equal(value.documents[4].review,false,'Public shared links retain their independent entry');
      assert.equal(value.documents[5].review,false,'Public catalog retains its independent entry');
      assert.equal(value.documents[6].review,testContour==='true'||platform==='max','Only anonymous production Telegram root retains landing');
      assert.deepEqual(value.head,{status:200,body:''});
      const urls=value.links.map(link=>new URL(link));
      for(const url of urls){assert.equal(url.origin,'https://recipes.example.test');assert.equal(url.pathname,'/app');assert.equal(url.searchParams.get('campaign'),'retained');}
      assert.equal(urls[0].searchParams.get('recipe'),'personal id');
      assert.equal(urls[1].searchParams.get('q'),'курица с рисом');assert.equal(urls[1].searchParams.get('notification'),'fixture-id');
      assert.equal(urls[2].searchParams.get('order'),'order-id');assert.equal(urls[3].searchParams.get('view'),'benefits');
    }
  } finally {fs.rmSync(directory,{recursive:true,force:true});}
});
