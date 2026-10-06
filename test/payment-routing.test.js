import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_INVOICE_FLOOR, MAX_RESULT_URL, invoiceBelongsToContour, callbackDestination, jwsRoutingParameters } from '../src/payment-routing.js';
const main = { botPlatform:'telegram',testContour:false,robokassaMaxResultUrl:MAX_RESULT_URL,robokassaTestResultUrl:'https://test.example/api/payments/robokassa/result' };
test('invoice namespaces and callback routes cannot overlap',()=>{
  for(const invId of [1,MAX_INVOICE_FLOOR-1]) { assert.equal(invoiceBelongsToContour(invId,main),true);assert.equal(invoiceBelongsToContour(invId,{botPlatform:'max'}),false); }
  for(const invId of [MAX_INVOICE_FLOOR,Number.MAX_SAFE_INTEGER]) { assert.equal(invoiceBelongsToContour(invId,main),false);assert.equal(invoiceBelongsToContour(invId,{botPlatform:'max'}),true); }
  for(const invId of [0,-1,NaN,Number.MAX_SAFE_INTEGER+1]) assert.equal(invoiceBelongsToContour(invId,{botPlatform:'max'}),false);
  assert.equal(callbackDestination({InvId:MAX_INVOICE_FLOOR,Shp_contour:'max'},main),MAX_RESULT_URL);
  assert.equal(callbackDestination({InvId:1,Shp_contour:'test'},main),main.robokassaTestResultUrl);
  assert.equal(callbackDestination({InvId:1},main),null);
  for(const params of [{InvId:1,Shp_contour:'max'},{InvId:MAX_INVOICE_FLOOR},{InvId:MAX_INVOICE_FLOOR,Shp_contour:'production'}]) assert.throws(()=>callbackDestination(params,main),{status:400});
  assert.throws(()=>callbackDestination({InvId:MAX_INVOICE_FLOOR,Shp_contour:'max'},{...main,testContour:true}),{status:400});
  assert.equal(callbackDestination({InvId:MAX_INVOICE_FLOOR},{...main,botPlatform:'max'}),null);
});
test('JWS routing uses only bounded invoice hint and never treats it as verification',()=>{
  const body='e30.'+Buffer.from(JSON.stringify({data:{invId:String(MAX_INVOICE_FLOOR),shop:'untrusted'}})).toString('base64url')+'.c2ln';
  assert.deepEqual(jwsRoutingParameters(body),{InvId:String(MAX_INVOICE_FLOOR)});
  assert.equal(callbackDestination(jwsRoutingParameters(body),main,{jws:true}),MAX_RESULT_URL);
  for(const body of ['', 'x.y.z','e30.@@.c2ln']) assert.throws(()=>jwsRoutingParameters(body),{status:400});
});
