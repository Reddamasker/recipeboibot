import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {buildMiniAppDocument} from '../src/web-document.js';

test('shared Mini App document selects authenticated transport and exact CSP hash',()=>{
  for(const name of ['telegram','max']){
    const doc=buildMiniAppDocument(path.resolve('public'),{botPlatform:name,botUsername:name==='max'?'id500912857935_bot':'Recipeboibot'});
    const html=doc.bytes.toString(),source=html.match(/<script>(.*?)<\/script>/)[1];
    assert.equal(doc.scriptHashes,`'sha256-${createHash('sha256').update(source).digest('base64')}'`);
    const context={window:{}};vm.runInNewContext(source,context);assert.equal(context.window.__recipePlatform.name,name);
    assert.equal(html.includes('https://st.max.ru/js/max-web-app.js'),name==='max');
    assert.ok(!html.includes('тестовый интерфейс'));
  }
});

test('legacy hash-only launch replaces root while preserving all launch parameters; public landing never redirects',()=>{
 const source=fs.readFileSync('public/mini-boot.js','utf8');
 for(const authenticated of [true,false])for(const pathname of ['/','/index.html','/app','/share/public']){
  const url=new URL('https://fixture.test'+pathname+'?campaign=fixture#tgWebAppData=signed%26value&tgWebAppVersion=8');let destination=null;
  const window={RecipePlatform:{name:'telegram'},...(authenticated?{Telegram:{WebApp:{initData:'fixture',ready(){}}}}:{}),addEventListener(){}};
  const location={href:url.href,pathname,hash:authenticated?url.hash:'#pricing',replace(value){destination=value;}};
  const element={hidden:false};const context={window,location,document:{querySelector:()=>element,addEventListener(){},documentElement:{}},fetch:()=>Promise.resolve(),MutationObserver:class{observe(){}disconnect(){}},URL,setInterval(){},setTimeout(){},clearInterval(){},encodeURIComponent,JSON};
  vm.runInNewContext(source,context);
  if(authenticated&&['/','/index.html'].includes(pathname)){const next=new URL(destination);assert.equal(next.pathname,'/app');assert.equal(next.search,url.search);assert.equal(next.hash,url.hash);assert.equal(window.__miniRedirect,true);}
  else assert.equal(destination,null);
 }
});
