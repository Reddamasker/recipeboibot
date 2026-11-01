import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';

// Preserve the legacy list and filters. The owner's 1 November request replaces
// only its recipe detail with the shared Mini App presentation.
test('legacy catalogue preserves its list and filters while using the shared recipe detail',()=>{
 const expected={
  'catalog-legacy.html':'a119d27c19af6be558302a863ba19106302952cb491d33d3da32475465f3f8e7',
  'catalog-legacy.js':'420152aaf4ebbb5ddb2f8faadde8dd4e816c673966cf88987d5cd7f708731f8d',
  'catalog-legacy.css':'8b115fc4b1100340d14c9049ab7263f1c342c7ac2059d37fcc432070baf19bf1',
  'catalog-legacy-visual.css':'fa2b52468c4f3455f5fcb136fe51ac9f4aa4b5abf5dac36c958bf8efefb5720b'
 };
 for(const [name,hash] of Object.entries(expected)){
  let content=fs.readFileSync(new URL('../public/'+name,import.meta.url),'utf8').replace(/\r\n?/g,'\n');
  if(name.endsWith('.html'))content=content.replace('<script defer src="/recipe-detail.js?v=1"></script><script defer src="/catalog-recipe.js?v=2"></script>','').replace('catalog-legacy.js?v=shared-recipe-2','catalog-legacy.js?v=9870784').replace('  <link rel="stylesheet" href="/recipe-detail.css?v=1">\n','');
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
