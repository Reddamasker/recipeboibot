import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
Object.assign(process.env,{DATABASE_PATH:path.resolve('data','payment-gateway-'+process.pid+'.sqlite'),BOT_PLATFORM:'telegram',TELEGRAM_POLLING:'false',TEST_CONTOUR:'false',ROBOKASSA_TEST:'false',ROBOKASSA_MERCHANT_LOGIN:'gateway-test-shop',ROBOKASSA_PASSWORD1:'one',ROBOKASSA_PASSWORD2:'two',ROBOKASSA_HASH_ALGORITHM:'md5',ROBOKASSA_RECURRING_ENABLED:'false',PAYMENT_TAX:'none'});
const {db,upsertTelegramUser,createRecipe}=await import('../src/db.js');
const {createPaymentOrder,getPaymentOrder}=await import('../src/billing.js');
const {createServer}=await import('../src/server.js');
const {MAX_INVOICE_FLOOR,MAX_RESULT_URL}=await import('../src/payment-routing.js');
const user=upsertTelegramUser({id:994455,first_name:'Покупатель'});
createRecipe(user.id,{title:'Суп',status:'ready',ingredients:[],steps:[]});
const order=createPaymentOrder(user.id);
let server,base;
const request=global.fetch;
test.before(async()=>{server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;});
test.after(async()=>{global.fetch=request;await new Promise(r=>server.close(r));db.close();for(const suffix of ['','-wal','-shm'])fs.rmSync(process.env.DATABASE_PATH+suffix,{force:true});});
test('production gateway relays MAX GET, form POST and JWS unchanged to fixed destination',async()=>{
  const calls=[];
  global.fetch=async(url,options)=>{calls.push({url,options});return new Response('OK'+MAX_INVOICE_FLOOR);};
  try {
    const form=new URLSearchParams({InvId:String(MAX_INVOICE_FLOOR),Shp_contour:'max',OutSum:'199.00',EMail:'person@example.com',SignatureValue:'opaque'}).toString();
    for(const [method,body] of [['GET',null],['POST',form]]) {
      const r=await request(base+'/api/payments/robokassa/result'+(method==='GET'?'?'+form:''),{method,...(body?{body}: {})});
      assert.equal(r.status,200);assert.equal(await r.text(),'OK'+MAX_INVOICE_FLOOR);
      assert.equal(calls.at(-1).options.body,form);
    }
    const jws='e30.'+Buffer.from(JSON.stringify({data:{invId:String(MAX_INVOICE_FLOOR)}})).toString('base64url')+'.c2ln';
    const r=await request(base+'/api/payments/robokassa/result',{method:'POST',body:jws});
    assert.equal(r.status,200);assert.equal(calls.at(-1).options.body,jws);assert.equal(calls.at(-1).options.headers['content-type'],'application/jose');
    for(const call of calls){assert.equal(call.url,MAX_RESULT_URL);assert.equal(call.options.redirect,'error');}
    assert.equal(getPaymentOrder(user.id,order.id).status,'pending');
    assert.equal(db.prepare('SELECT count(*) AS n FROM user_subscriptions WHERE user_id=?').get(user.id).n,0);
  } finally {global.fetch=request;}
});
test('gateway refuses invalid namespace and never acknowledges destination signature failure or wrong invoice',async()=>{
  let calls=0;
  global.fetch=async()=>{calls++;return new Response('Invalid signature',{status:400});};
  try {
    const invalid=await request(base+'/api/payments/robokassa/result?InvId=1&Shp_contour=max');assert.equal(invalid.status,400);assert.equal(calls,0);
    const rejected=await request(base+'/api/payments/robokassa/result?InvId='+MAX_INVOICE_FLOOR+'&Shp_contour=max&SignatureValue=forged');assert.equal(rejected.status,502);assert.equal(calls,1);
    global.fetch=async()=>new Response('OK1');
    const wrongAck=await request(base+'/api/payments/robokassa/result?InvId='+MAX_INVOICE_FLOOR+'&Shp_contour=max');assert.equal(wrongAck.status,502);
    assert.equal(getPaymentOrder(user.id,order.id).status,'pending');
  } finally {global.fetch=request;}
});
