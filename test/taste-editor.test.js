import test from 'node:test';
import assert from 'node:assert/strict';
import {mountTasteEditor} from '../public/taste-editor.js';
import {getTasteCatalog} from '../src/taste-profile.js';
import {tasteElement,clickDish} from './helpers/taste-dom.js';
const initial={'seed:chicken-cutlets':1,'seed:borscht-beef':-1,'seed:fish-potato':1};
async function fixture({ratings={},conflict=false}={}){
 const element=tasteElement(),requests=[],completed=[];let skip=0,fail=false;
 let profile={dishRatings:{...ratings},tasteRevision:1,tastePreferencesStatus:'completed'};
 const api=async(path,options={})=>{
  requests.push({path,options});
  if(fail)throw Error('offline');
  if(!options.method)return path.endsWith('/profile')?profile:{...getTasteCatalog(),profile};
  const input=JSON.parse(options.body);
  if(conflict){conflict=false;profile={...profile,dishRatings:{...profile.dishRatings,'seed:egg-salad':-1},tasteRevision:2};throw Object.assign(Error('conflict'),{status:409});}
  profile={...profile,...input,tasteRevision:profile.tasteRevision+1};return profile;
 };
 await mountTasteEditor({element,api,complete:p=>completed.push(p),skip:()=>skip++});
 return {element,requests,completed,get profile(){return profile;},get skipped(){return skip;},setFail:v=>fail=v};
}
test('one dish cycles green/red/neutral, minimum three includes both signs and save failure retains choices',async()=>{
 const f=await fixture(),el=f.element,done=el.querySelector('#taste-save');
 assert.equal(done.disabled,true);
 clickDish(el,'seed:chicken-cutlets');assert.match(el.querySelector('.taste-cloud').innerHTML,/is-liked/);
 clickDish(el,'seed:chicken-cutlets');assert.match(el.querySelector('.taste-cloud').innerHTML,/is-disliked/);
 assert.equal(done.disabled,true);
 clickDish(el,'seed:chicken-cutlets');assert.doesNotMatch(el.querySelector('.taste-cloud').innerHTML,/is-disliked/);
 for(const id of Object.keys(initial))clickDish(el,id);
 clickDish(el,'seed:borscht-beef');assert.equal(done.disabled,false);
 f.setFail(true);await done.onclick();assert.equal(f.completed.length,0);assert.equal(done.disabled,false);assert.equal(el.querySelector('.taste-status').textContent,'offline');
 f.setFail(false);await done.onclick();assert.deepEqual(f.profile.dishRatings,initial);assert.equal(f.completed.length,1);
 const g=await fixture({ratings:f.profile.dishRatings});assert.match(g.element.querySelector('.taste-cloud').innerHTML,/is-disliked/);assert.equal(g.element.querySelector('#taste-save').disabled,false);
});
test('conflicting second-device save rebases only changed dishes and preserves unrelated ratings',async()=>{
 const f=await fixture({ratings:initial,conflict:true});
 clickDish(f.element,'seed:chicken-cutlets');
 await f.element.querySelector('#taste-save').onclick();
 assert.deepEqual(f.profile.dishRatings,{...initial,'seed:chicken-cutlets':-1,'seed:egg-salad':-1});
 assert.equal(f.completed.length,1);
 assert.equal(f.requests.filter(r=>r.options.method==='PUT').length,2);
});
test('later preserves saved profile; close during save never navigates after delayed response',async()=>{
 const f=await fixture({ratings:initial});clickDish(f.element,'seed:fish-potato');await f.element.querySelector('#taste-skip').onclick();
 assert.deepEqual(f.profile.dishRatings,initial);assert.equal(f.skipped,1);assert.equal(f.requests.length,1);
 const element=tasteElement();let resolve,completed=0;
 await mountTasteEditor({element,api:async(path,o={})=>o.method?new Promise(r=>resolve=r):{...getTasteCatalog(),profile:{dishRatings:initial,tasteRevision:1}},complete:()=>completed++,skip:()=>{}});
 const pending=element.querySelector('#taste-save').onclick();element.isConnected=false;resolve({});await pending;assert.equal(completed,0);
});
test('search accesses full catalog without ingredient tags, pagination and cleared branches remain usable',async()=>{
 const f=await fixture(),el=f.element;
 el.querySelector('input').oninput({target:{value:'Кефтедес'}});assert.match(el.querySelector('.taste-cloud').innerHTML,/Кефтедес/i);
 el.querySelector('input').oninput({target:{value:''}});
 clickDish(el,'seed:chicken-cutlets');const liked=el.querySelector('.taste-cloud').innerHTML;
 assert.ok(liked.indexOf('data-dish="seed:chicken-cutlets"')>=0);
 el.querySelector('#taste-more').onclick();el.querySelector('#taste-other').onclick();
 clickDish(el,'seed:chicken-cutlets');assert.equal(el.querySelector('#taste-save').disabled,true);
 assert.doesNotMatch(el.innerHTML,/Ингредиенты|Кухни|Любимые блюда \(через/);
});
