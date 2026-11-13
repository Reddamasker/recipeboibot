import test from 'node:test';
import assert from 'node:assert/strict';
import {catalogSearch,catalogRecipe,catalogDaily} from '../src/web-catalog.js';
import {matchesDiscovery} from '../src/catalog-discovery.js';
const search=p=>catalogSearch(new URLSearchParams(p));
const all=p=>Array.from({length:search(p).pages},(_,i)=>search({...p,page:String(i+1)}).recipes).flat();
test('discovery exposes six bounded groups with accurate availability',()=>{
 const groups=search({}).discoveryGroups;
 assert.equal(groups.length,6);assert.deepEqual(catalogDaily().discoveryGroups,groups);
 for(const g of groups)for(const c of g.choices)assert.equal(search({[g.id]:c.id}).total,c.count,g.id+':'+c.id);
 assert.ok(groups.find(g=>g.id==='include').choices.some(c=>c.id==='гречка'&&c.count>0));
});
test('cuisine alternatives union, independent groups intersect and pagination keeps conditions',()=>{
 const ru=all({cuisines:'russian'}),ge=all({cuisines:'georgian'});
 assert.equal(search({cuisines:'russian,georgian'}).total,ru.length+ge.length);
 const a=all({diet:'plant',method:'pan'});
 assert.ok(a.length);assert.ok(a.every(r=>all({diet:'plant'}).some(x=>x.id===r.id)&&all({method:'pan'}).some(x=>x.id===r.id)));
 assert.equal(new Set(all({diet:'vegetarian'}).map(r=>r.id)).size,search({diet:'vegetarian'}).total);
 assert.equal(search({meal:'not-valid'}).total,0);
 assert.equal(search({include:'курица',diet:'vegetarian'}).total,0);
});
test('product inclusions distinguish milk, cheese and curd',()=>{
 for(const r of all({include:'творог'}))assert.match(catalogRecipe(r.id).ingredients.map(i=>i.name).join(' '),/творог|творож/iu);
 assert.ok(search({include:'творог'}).total>0);
 assert.ok(search({include:'творог'}).total<search({include:'сыр'}).total);
});
test('diet and cooking conditions inspect ingredients and actual steps',()=>{
 const r={title:'Ужин',tags:[],categories:[],ingredients:[{name:'сало'}],steps:['Нарежьте'],minutes:10,servings:2};
 assert.equal(matchesDiscovery(r,new URLSearchParams({diet:'vegetarian'})),false);
 for(const name of ['тунец','куриный бульон','желатин','творожный сыр'])assert.equal(matchesDiscovery({...r,ingredients:[{name}]},new URLSearchParams({diet:'plant'})),false);
 assert.equal(matchesDiscovery({...r,ingredients:[{name:'картофель'}],steps:['Отварите картофель.']},new URLSearchParams({method:'no_cook'})),false);
 assert.equal(matchesDiscovery({...r,ingredients:[{name:'огурец'}],steps:['Нарежьте огурец.']},new URLSearchParams({method:'no_cook',diet:'plant'})),true);
});
test('no-cook never includes warming, pan cooking or a cooked tortilla from the real catalog',()=>{
 const found=all({method:'no_cook'});
 assert.ok(found.length>0);
 for(const r of found)assert.doesNotMatch(catalogRecipe(r.id).steps.join(' '),/прогре|готовьте|огне|сковород|кип|вари|жар|духов|запек/iu,r.title);
 assert.ok(found.some(r=>r.title.includes('греческий салат')));
 assert.ok(!found.some(r=>/тортилья|Пхали|Тёплый|райта|Суномоно|Капуста/iu.test(r.title)));
});
