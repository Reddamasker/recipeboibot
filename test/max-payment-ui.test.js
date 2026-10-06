import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync('public/app.js','utf8').replace(/boot\(\);\s*$/,'');
function fixture(status='pending'){
  const root={innerHTML:''},next={},resume={},opened=[],pages=[];
  const location=new URL('https://max-recipes.test/?view=payment-result&order=11111111-1111-1111-1111-111111111111');
  const window={RecipePlatform:{name:'max',sdk:{openLink:url=>opened.push(url)}},addEventListener(){}};
  const sandbox={window,location,URL,URLSearchParams,document:{querySelector:s=>s==='#app'?root:s==='#result-next'?next:s==='#resume-provider-payment'?resume:null},history:{replaceState:(_,unused,url)=>{location.href=url;},pushState:(_,unused,url)=>{location.href=url;}},clearTimeout(){},requestAnimationFrame(){},scrollY:0};
  vm.createContext(sandbox);vm.runInContext(source+`
    header=()=>'';bindCommon=()=>{};pollProviderPayment=()=>{};
    paymentSuccessPage=()=>window.recordSuccess();
    Object.assign(state,{payment:{mode:'provider',available:true,active:true},trialOnboarding:'payment-success',checkoutOrder:{id:'22222222-2222-2222-2222-222222222222',status:'${status}',priceRub:199}});
    window.run=paymentResultPage;window.route=setRoute;
  `,sandbox);
  window.recordSuccess=()=>pages.push('success');
  return {window,location,root,next,resume,opened,pages};
}
test('pending MAX payment remains pending despite older success and active trial; opening uses a direct click',()=>{
  const f=fixture();f.window.run();assert.deepEqual(f.pages,[]);assert.match(f.root.innerHTML,/Ожидаем подтверждение/);assert.match(f.root.innerHTML,/Открыть оплату/);
  f.resume.onclick();assert.deepEqual(f.opened,['https://max-recipes.test/payment/start/22222222-2222-2222-2222-222222222222']);
});
test('confirmed owned payment shows success and navigation drops stale order identifiers',()=>{
  const f=fixture('paid');f.window.run();assert.deepEqual(f.pages,['success']);
  f.window.route({view:'offer'});assert.equal(f.location.search,'?view=offer');
  f.window.route({view:'payment-result',order:'22222222-2222-2222-2222-222222222222'});
  assert.equal(f.location.search,'?view=payment-result&order=22222222-2222-2222-2222-222222222222');
});
