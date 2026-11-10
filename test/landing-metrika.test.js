import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {randomUUID} from 'node:crypto';
import {landingMetrikaCounter} from '../src/landing-metrika.js';
const file=path.resolve('data','metrika-'+randomUUID()+'.sqlite');
process.env.DATABASE_PATH=file;process.env.TELEGRAM_BOT_TOKEN='test-only';process.env.TELEGRAM_POLLING='false';process.env.YANDEX_METRIKA_COUNTER_ID='123456789';process.env.BOT_PLATFORM='telegram';process.env.TEST_CONTOUR='false';
const {createServer}=await import('../src/server.js');const {db}=await import('../src/db.js');
test.after(()=>{db.close();for(const suffix of ['','-wal','-shm'])try{fs.unlinkSync(file+suffix);}catch{}});
function fixture(options={}) {
 const scripts=[],listeners={},masked=[],identityRequests=[],root={hidden:Boolean(options.hidden),getClientRects:()=>[{}],addEventListener:(name,fn)=>{listeners[name]=fn;}},input={classList:{add:(...classes)=>masked.push(...classes)}};
 let mutation;
 class Element {constructor(platform){this.dataset={landingPlatform:platform};}closest(){return this;}}
 const window={Telegram:options.mini?{WebApp:{initData:'private'}}:undefined};window.self=window;window.top=options.frame?{}:window;
 const document={visibilityState:options.hidden?'hidden':'visible',addEventListener:(name,fn)=>{listeners[name]=fn;},removeEventListener:()=>{},getElementById:()=>root,querySelector:()=>({content:options.id??'123456789'}),querySelectorAll:()=>[input],head:{append:s=>scripts.push(s)},createElement:()=>({}),referrer:'https://example.com/private?token=secret'};
 const context=vm.createContext({window,document,location:new URL('https://dishfinder.ru/'+(options.query??'?campaign=ya-product-landing-202611&yclid=123')),navigator:{userAgent:options.probe?'preview verification':'Browser'},localStorage:{getItem:()=>options.internal?Date.now()+60000:null},URL,URLSearchParams,Element,AbortSignal,setTimeout:fn=>setTimeout(fn,0),fetch:async(url,init)=>{identityRequests.push({url,init});return options.identityFails?{ok:false,status:503}:{ok:true,status:200};},MutationObserver:class {constructor(fn){mutation=fn;}observe(){}disconnect(){}}});
 vm.runInContext(fs.readFileSync('public/landing-metrika.js','utf8').replace('export function start','function start')+';start('+JSON.stringify(options.visitId??null)+');',context);
 return {scripts,masked,root,context,window,document,identityRequests,show:()=>{root.hidden=false;document.visibilityState='visible';listeners.visibilitychange?.();},click:(platform,trusted=true)=>listeners.click?.({target:new Element(platform),isTrusted:trusted}),mutate:()=>mutation?.()};
}
test('Metrika starts once, masks private elements and emits each messenger goal once without capturing URLs as goal data',()=>{
 const p=fixture();assert.equal(p.scripts.length,1);assert.ok(p.masked.includes('ym-disable-keys'));
 assert.equal(new URL(p.scripts[0].src).searchParams.get('id'),'123456789','server selects the recorder bundle for this counter');
 assert.equal(p.window.ym.a[0][2].ssr,true);
 assert.equal(p.window.ym.a[0][1],'init');assert.equal(p.window.ym.a[0][2].webvisor,true);assert.equal(p.window.ym.a[0][2].disableYtm,true);
 assert.equal(p.window.ym.a[1][3].referer,'https://example.com/');assert.equal(p.window.ym.a[1][1],'hit');
 p.click('telegram',false);p.click('telegram');p.click('telegram');p.click('max');p.click('other');
 assert.deepEqual(Array.from(p.window.ym.a.slice(2),a=>a[2]),['landing_telegram_click','landing_max_click']);
 vm.runInContext('start()',p.context);assert.equal(p.scripts.length,1);
 p.root.hidden=true;p.mutate();assert.equal(p.window.ym.a.length,0,'late private view clears pending third-party commands');
});
test('no Metrika on hidden, internal, probe, embedded, Mini App or private-query visits; unavailable SDK leaves bounded empty queue',()=>{
 for(const options of [{hidden:true},{internal:true},{probe:true},{frame:true},{mini:true},{id:'0'},{query:'?token=private'},{query:'?view=collection'},{query:'#tgWebAppData=private'}])assert.equal(fixture(options).scripts.length,0,JSON.stringify(options));
 const p=fixture();p.scripts[0].onerror();for(let i=0;i<50;i++)p.click('telegram');assert.equal(p.window.ym.a.length,0);
 const hidden=fixture({hidden:true});hidden.show();assert.equal(hidden.scripts.length,1);
 for (const query of ['?_ym_status-check=123456789&_ym_lang=ru','?_ym_debug=2']) { const check=fixture({query,internal:true});assert.equal(check.scripts.length,1);assert.equal(check.window.ym.a[1][2],'https://dishfinder.ru/'); }
 assert.equal(fixture({query:'?_ym_status-check=987654321'}).scripts.length,0);
 for(const settings of [{botPlatform:'max'},{botPlatform:'telegram',testContour:true}])assert.equal(landingMetrikaCounter({...settings,yandexMetrikaCounterId:123456789}),0);
});
test('only public landing HTML opts into Metrika; Mini App, dashboard and APIs retain their policy',async()=>{
 const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 try {
  const landing=await fetch(base+'/');assert.match(await landing.text(),/name="yandex-metrika-counter" content="123456789"/);assert.match(landing.headers.get('content-security-policy'),/https:\/\/mc.yandex.ru/);
  for(const route of ['/app','/?view=collection','/dashboard.html','/api/dashboard/funnel']){const r=await fetch(base+route);assert.doesNotMatch(r.headers.get('content-security-policy'),/mc.yandex/);assert.doesNotMatch(await r.text(),/name="yandex-metrika-counter"/);}
 }finally{await new Promise(r=>server.close(r));}
});

test('per-visit Metrika association sends only random visit ID and attaches client identity idempotently without blocking links',async()=>{
 const visitId='a'.repeat(32), p=fixture({visitId});
 assert.deepEqual(JSON.parse(JSON.stringify(p.window.ym.a[1][3].params)),{recipe_visit_id:visitId});
 const callback=p.window.ym.a.find(call=>call[1]==='getClientID')[2];
 callback('1234567890');callback('1234567890');
 await new Promise(r=>setTimeout(r,10));
 assert.equal(p.identityRequests.length,1);
 assert.equal(p.identityRequests[0].url,'/api/landing/identity');
 assert.deepEqual(JSON.parse(p.identityRequests[0].init.body),{visitId,clientId:'1234567890'});
 assert.equal(p.identityRequests[0].init.keepalive,true);
 assert.ok(!JSON.stringify(p.window.ym.a).includes('user_id'));
 p.click('telegram');assert.ok(p.window.ym.a.some(call=>call[1]==='reachGoal'&&call[2]==='landing_telegram_click'));
});

test('Metrika identity failures retry at most once and late hidden/private callbacks never collect identity',async()=>{
 const failed=fixture({visitId:'b'.repeat(32),identityFails:true});
 failed.window.ym.a.find(call=>call[1]==='getClientID')[2]('999');
 await new Promise(r=>setTimeout(r,20));assert.equal(failed.identityRequests.length,2);
 for(const mode of ['hidden','private','sdk-error']) {
  const p=fixture({visitId:'c'.repeat(32)}), callback=p.window.ym.a.find(call=>call[1]==='getClientID')[2];
  if(mode==='hidden')p.document.visibilityState='hidden';
  if(mode==='private'){p.root.hidden=true;p.mutate();}
  if(mode==='sdk-error')p.scripts[0].onerror();
  callback('123');await new Promise(r=>setTimeout(r,5));assert.equal(p.identityRequests.length,0,mode);
 }
 const invalid=fixture({visitId:'d'.repeat(32)});invalid.window.ym.a.find(call=>call[1]==='getClientID')[2]('https://private.example/token');
 assert.equal(invalid.identityRequests.length,0);
});
