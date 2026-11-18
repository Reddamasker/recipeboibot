import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
import {checkedGeneration,generationSchema,safetyReasons} from '../src/recipe-safety.js';
test('only explicit safe generation is released; refusals discard even a supplied recipe',()=>{
 const recipe={title:'Суп'};assert.equal(checkedGeneration({safetyRefusal:'none',result:recipe}),recipe);
 for(const reason of safetyReasons.filter(x=>x!=='none'))assert.throws(()=>checkedGeneration({safetyRefusal:reason,result:recipe}),e=>e.status===422&&e.code==='RECIPE_SAFETY_REFUSAL');
 for(const value of [null,recipe,{safetyRefusal:'none',result:null},{safetyRefusal:'unknown',result:recipe}])assert.throws(()=>checkedGeneration(value),e=>e.providerCode==='invalid_structured_output');
 assert.equal(generationSchema({type:'object'}).additionalProperties,false);
});
for(const platform of ['telegram','max'])test(platform+': safety refusal reaches the real chat handler with accurate analytics',()=>{
 const r=spawnSync(process.execPath,['scripts/check-recipe-safety.mjs'],{encoding:'utf8',timeout:90000,env:{...process.env,BOT_PLATFORM:platform}});
 assert.equal(r.status,0,r.stdout+r.stderr);assert.match(r.stdout,/safety messages.*verified/);
});
