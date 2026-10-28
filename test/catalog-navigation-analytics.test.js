import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {randomUUID} from 'node:crypto';

test('leaving for messenger immediately sends bounded keepalive batches and retries original event ids',()=>{
 const sent=[],storage=new Map(),listeners={};let now=10000;
 const sandbox={location:{pathname:'/dinner'},crypto:{randomUUID},Date:{now:()=>now},Promise,TextEncoder,AbortSignal,navigator:{onLine:true},
  sessionStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value)},
  window:{addEventListener:(name,handler)=>{listeners[name]=handler;}},document:{visibilityState:'visible',addEventListener(){}},
  setTimeout(){},clearTimeout(){},setInterval(){},
  fetch(path,options){sent.push({path,options,body:JSON.parse(options.body)});return new Promise(()=>{});}
 };
 vm.runInNewContext(fs.readFileSync(new URL('../public/analytics.js',import.meta.url),'utf8'),sandbox);
 const api=sandbox.window.RecipeAnalytics,flowId=randomUUID();
 for(let i=0;i<79;i++)api.event('catalog_platform_selected','catalog',{flowId,journey:'recipe-first-v1',platform:'telegram'});
 api.event('catalog_handoff_ready','catalog',{flowId,journey:'recipe-first-v1',platform:'telegram',durationMs:24});
 const stored=JSON.parse(storage.get('recipe-public-analytics-v1'));
 assert.equal(api.sessionId,stored.visitor);
 assert.equal(api.flushBeforeNavigate(),undefined,'navigation never waits for analytics');
 assert.ok(sent.length>0&&sent.length<=4);
 assert.ok(sent.every(r=>r.path==='/api/analytics/public'&&r.options.keepalive===true&&new TextEncoder().encode(r.options.body).length<=12000));
 assert.ok(sent.reduce((sum,r)=>sum+new TextEncoder().encode(r.options.body).length,0)<=48000);
 const ids=sent.flatMap(r=>r.body.events.map(e=>e.id));assert.deepEqual(ids,stored.queue.map(e=>e.id));
 assert.ok(sent.some(r=>r.body.events.some(e=>e.event==='catalog_handoff_ready')));
 const count=sent.length;listeners.pagehide();assert.equal(sent.length,count,'one departure cannot consume the keepalive budget twice');
 now+=1001;api.flushBeforeNavigate();assert.deepEqual(sent.slice(count).flatMap(r=>r.body.events.map(e=>e.id)),ids);
 assert.ok(sent.slice(count).every(r=>r.body.events.every(e=>e.attempts===2)));
});
