import test from 'node:test';
import assert from 'node:assert/strict';
import {catalogSelection,validCatalogSelection} from '../src/catalog-selection.js';
const selection=()=>({version:1,products:['картофель','курица'],cuisine:'georgian',query:'чахохбили',minutes:30,category:null,excludedCount:1});
test('authorised selections retain food and submitted query, enforce bounded schema and redact accidental credentials or URLs',()=>{
  const s=selection();assert.deepEqual(catalogSelection(s),s);assert.equal(validCatalogSelection(s),true);
  for(const bad of [{...s,products:['a'.repeat(81)]},{...s,products:Array(13).fill('яйцо')},{...s,products:Array(4).fill('а'.repeat(80))},{...s,query:'a'.repeat(161)},
    {...s,query:' x '},{...s,query:'x\ny'},{...s,cuisine:'unknown'},{...s,category:'unknown'},{...s,minutes:0},{...s,minutes:1.5},{...s,excludedCount:13},
    {...s,exclude:['private']},{...s,products:null},{...s,query:null},{...s,version:2}]){assert.throws(()=>catalogSelection(bad),{status:400});assert.equal(validCatalogSelection(bad),false);}
  for(const query of ['https://example.test/private','email@example.test','Bearer private-secret','sk-abcdefghijklmnop','token=private-value','123456:abcdefghijklmnopqrstuvwxyz']){
    const unsafe={...s,query,products:[query]};assert.equal(catalogSelection(unsafe).query,'[скрыто]');assert.deepEqual(catalogSelection(unsafe).products,['[скрыто]']);assert.equal(validCatalogSelection(unsafe),false);
  }
  assert.equal(catalogSelection({...s,query:'<img src=x onerror=alert(1)>'}).query,'<img src=x onerror=alert(1)>','plain text is escaped by DOM textContent, not interpreted');
});
