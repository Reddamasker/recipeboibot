import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';

// Preserve the production catalogue while the separate advertising journey is
// released. Hashes come from verified production commit 9870784; the HTML only
// renames its three local bundle URLs. Normalize checkout line endings only.
test('production catalogue retains its verified appearance and behavior independently of dinner entry',()=>{
 const expected={
  'catalog-legacy.html':'a119d27c19af6be558302a863ba19106302952cb491d33d3da32475465f3f8e7',
  'catalog-legacy.js':'732cdc731bf0b088477468516e371e0d085f4079ff9fb585be65427c84caec3e',
  'catalog-legacy.css':'8b115fc4b1100340d14c9049ab7263f1c342c7ac2059d37fcc432070baf19bf1',
  'catalog-legacy-visual.css':'fa2b52468c4f3455f5fcb136fe51ac9f4aa4b5abf5dac36c958bf8efefb5720b'
 };
 for(const [name,hash] of Object.entries(expected)){
  const content=fs.readFileSync(new URL('../public/'+name,import.meta.url),'utf8').replace(/\r\n?/g,'\n');
  assert.equal(createHash('sha256').update(content).digest('hex'),hash,name);
 }
 for(const name of ['everyday','italian','georgian','asian','japanese','russian','ukrainian','belarusian','greek','indian','hungarian','uzbek','eastern','european','caucasian'])assert.ok(fs.existsSync(new URL('../public/assets/filters/cuisine-'+name+'.webp',import.meta.url)));
 for(const name of ['chicken','beef','pork','fish','rice','potato','mushroom','egg','tomato','cheese'])assert.ok(fs.existsSync(new URL('../public/assets/filters/ingredient-'+name+'.webp',import.meta.url)));
});
