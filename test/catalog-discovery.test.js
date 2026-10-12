import test from 'node:test';
import assert from 'node:assert/strict';
import {catalogSearch,catalogRecipe} from '../src/web-catalog.js';
const search=params=>catalogSearch(new URLSearchParams(params));
test('browse offers specific cuisines and country counters match actual filtered results',()=>{
 const all=search({});
 assert.ok(!all.cuisineChoices.some(c=>['asian','eastern','european','caucasian'].includes(c.id)));
 for(const c of all.cuisineChoices){const result=search({cuisine:c.id});assert.equal(result.total,c.count,c.id);assert.ok(result.recipes.every(r=>r.cuisineId===c.id),c.id);}
 assert.equal(search({cuisine:'japanese'}).total,12);
 assert.equal(search({cuisine:'chinese'}).total,12);
 assert.deepEqual(search({cuisine:'japanese',category:'soup'}).recipes.map(r=>r.id),['jp-miso-ramen']);
 assert.ok(!search({cuisine:'japanese'}).recipes.some(r=>r.id==='uz-samsa-beef'));
 assert.equal(catalogRecipe('ea-hummus').cuisineId,'lebanese');
 assert.equal(catalogRecipe('ea-lentil-bulgur').cuisineId,'turkish');
});
test('noodle choices include proper noodles and exclude rice, pastry and zucchini ribbons',()=>{
 assert.equal(search({cuisine:'japanese',category:'noodles'}).total,4);
 assert.equal(search({cuisine:'chinese',category:'noodles'}).total,4);
 const noodles=search({category:'noodles'}).recipes;
 assert.ok(noodles.some(r=>r.id==='jp-yaki-udon-chicken'));
 assert.ok(noodles.some(r=>r.id==='cn-vegetable-lo-mein'));
 assert.ok(noodles.some(r=>r.id==='hu-cabbage-noodles'));
 assert.ok(!noodles.some(r=>['uz-samsa-beef','chicken-zucchini-ribbons','in-jeera-rice'].includes(r.id)));
 assert.ok(noodles.every(r=>!r.categories.includes('pasta')));
 const baking=search({cuisine:'uzbek',category:'baking'});
 assert.deepEqual(baking.recipes.map(r=>r.id),['uz-samsa-beef']);
});
test('rice product inclusion cannot treat rice vinegar in noodle sauces as rice',()=>{
 assert.equal(search({category:'noodles',include:'рис'}).total,0);
 assert.ok(search({include:'рис'}).recipes.some(r=>r.id==='chicken-rice'));
 assert.equal(search({cuisine:'japanese',category:'noodles',time:'30',include:'курица'}).total,1);
});
