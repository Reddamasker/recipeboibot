import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';

// Preserve the legacy list and filters. The owner's 1 November request replaces
// only its recipe detail with the shared Mini App presentation.
test('legacy catalogue preserves its list and filters while using the shared recipe detail',()=>{
 const expected={
  'catalog-legacy.html':'a119d27c19af6be558302a863ba19106302952cb491d33d3da32475465f3f8e7',
  'catalog-legacy.css':'8b115fc4b1100340d14c9049ab7263f1c342c7ac2059d37fcc432070baf19bf1',
  'catalog-legacy-visual.css':'fa2b52468c4f3455f5fcb136fe51ac9f4aa4b5abf5dac36c958bf8efefb5720b'
 };
 for(const [name,hash] of Object.entries(expected)){
  let content=fs.readFileSync(new URL('../public/'+name,import.meta.url),'utf8').replace(/\r\n?/g,'\n');
  if(name.endsWith('.html'))content=content.replace(/<script defer src="\/(?:recipe-detail|recipe-cooking|catalog-recipe|catalog-handoff|catalog-journey-detail)\.js\?[^"]+"><\/script>/g,'').replace('catalog-legacy.js?v=shared-recipe-3','catalog-legacy.js?v=9870784').replace('  <link rel="stylesheet" href="/catalog-handoff.css?v=1"><link rel="stylesheet" href="/recipe-detail.css?v=4">\n','');
  if(name.endsWith('.js')){
    assert.match(content,/window\.CatalogRecipe\.render/);
    const start=content.indexOf('  function renderRecipe('),end=content.indexOf('  function applyFilters(',start);
    content=content.slice(0,start)+content.slice(end);
  }
  assert.equal(createHash('sha256').update(content).digest('hex'),hash,name);
 }
 for(const name of ['everyday','italian','georgian','asian','japanese','russian','ukrainian','belarusian','greek','indian','hungarian','uzbek','eastern','european','caucasian'])assert.ok(fs.existsSync(new URL('../public/assets/filters/cuisine-'+name+'.webp',import.meta.url)));
 for(const name of ['chicken','beef','pork','fish','rice','potato','mushroom','egg','tomato','cheese'])assert.ok(fs.existsSync(new URL('../public/assets/filters/ingredient-'+name+'.webp',import.meta.url)));
});

test('legacy filter and list rendering stay unchanged through shared-card wiring',()=>{const source=fs.readFileSync('public/catalog-legacy.js','utf8').replace(/\r\n/g,'\n');for(const {from,to,hash} of [{"from":"function options(","to":"function card(","hash":"b3b38fee6cc60ec14afa626013bd6f3eb531bc770a719cb2139b903ca0f9e191"},{"from":"function card(","to":"function activeFilters(","hash":"6884e9cb9ca1423c6a8df62af71130f3d95ec9ad59587d9441a8fad18f0c8f84"},{"from":"function activeFilters(","to":"async function load(","hash":"b40cb7ec094221b60203be415da58311eb92811e8c2580743b6ed8a691c5d9c6"},{"from":"function applyFilters(","to":"  $('#search-form')","hash":"e6b7da3bdbcd02df0740e68a20e470639ea8b4db5ec6f191a8d025bdc05eb5f3"}]){const start=source.indexOf(from),end=source.indexOf(to,start+from.length);assert.ok(start>=0&&end>start,from);assert.equal(createHash('sha256').update(source.slice(start,end).trim()).digest('hex'),hash,from);}});
