import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
function fixture(api) {
  class Element {
    children=[];dataset={};classList={add(){},remove(){}};textContent='';
    constructor(tag){this.tag=tag;}
    append(...nodes){this.children.push(...nodes);}
    replaceChildren(...nodes){this.children=nodes;}
    setAttribute(){}
    querySelectorAll(){return this.children.flatMap(n=>[...(n.tag==='details'&&n.open?[n]:[]),...n.querySelectorAll()]);}
  }
  const handlers={},window={},root=new Element('main');
  const document={visibilityState:'visible',createElement:t=>new Element(t),addEventListener:(n,f)=>{handlers[n]=f;}};
  window.addEventListener=(n,f)=>{handlers[n]=f;};
  vm.runInNewContext(fs.readFileSync('public/import-failures.js','utf8'),{window,document,Date,Set,encodeURIComponent,setTimeout(){return 1;},clearTimeout(){}});
  const text=(n=root)=>n.textContent+' '+n.children.map(x=>text(x)).join(' ');
  return {root,window,document,handlers,text,render:()=>window.ImportFailuresView.render(root,api,()=>{})};
}
const report=()=>({platform:'max',counters:{since:Date.now()},rows:[{id:'id',createdAt:Date.now(),lastAt:Date.now(),expiresAt:Date.now()+60000,source:'miniapp',code:'RECIPE_NOT_FOUND',attempts:1,text:'private fixture <script>danger()</script>'}]});
test('hidden screen discards a late response and clears previously visible text',async()=>{
  let resolve;const f=fixture(()=>new Promise(r=>{resolve=r;}));const pending=f.render();
  f.document.visibilityState='hidden';f.handlers.visibilitychange();resolve(report());await pending;
  assert.doesNotMatch(f.text(),/private fixture/);
  const shown=fixture(async()=>report());await shown.render();assert.match(shown.text(),/private fixture/);
  shown.document.visibilityState='hidden';shown.handlers.visibilitychange();assert.doesNotMatch(shown.text(),/private fixture/);
});
test('access denial displays no source text; expired records are never rendered',async()=>{
  const denied=fixture(async()=>{throw {status:403};});await denied.render();assert.match(denied.text(),/только владельцу/);
  const old=report();old.rows[0].expiresAt=Date.now()-1;const f=fixture(async()=>old);await f.render();assert.doesNotMatch(f.text(),/private fixture/);
});
test('leaving the page destroys the displayed private text',async()=>{
 const f=fixture(async()=>report());await f.render();assert.match(f.text(),/private fixture/);f.handlers.pagehide();assert.doesNotMatch(f.text(),/private fixture/);
});
