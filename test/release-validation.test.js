import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {validateOnce} from '../scripts/release-validation.js';
test('release validation reuses only a successful identical unexpired tree/environment',()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'release-receipt-'));let runs=0;const run=()=>runs++;
 try{
  assert.equal(validateOnce({directory,key:'treeA/node24/envA',run,now:1000}),true);
  assert.equal(validateOnce({directory,key:'treeA/node24/envA',run,now:2000}),false);
  assert.equal(validateOnce({directory,key:'treeB/node24/envA',run,now:2000}),true);
  assert.equal(validateOnce({directory,key:'treeA/node24/envB',run,now:2000}),true);
  assert.equal(validateOnce({directory,key:'treeA/node24/envA',run,now:86401001}),true);
  assert.equal(runs,4);
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
test('failed checks or a changing tree never authorize a later release',()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'release-receipt-'));
 try{
  assert.throws(()=>validateOnce({directory,key:'failed',run:()=>{throw Error('test failed');}}));
  assert.throws(()=>validateOnce({directory,key:'changed',run:()=>{},currentKey:()=> 'different'}));
  assert.deepEqual(fs.readdirSync(directory),[]);
  assert.equal(validateOnce({directory,key:'failed',run:()=>{}}),true);
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
