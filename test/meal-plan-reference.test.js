import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

function load(file,exportName){const context={window:{},URL,location:{origin:'https://example.test'}};vm.runInNewContext(fs.readFileSync(new URL('../public/review/recime-20261109/'+file,import.meta.url),'utf8'),context);return context.window[exportName];}

test('menu calendar starts on Monday and preserves leap/month/year boundaries',()=>{
  const {monthDays}=load('meal-plan-editor.js','MealPlanEditor');
  assert.equal(monthDays(2026,10).offset,6);
  assert.equal(monthDays(2026,10).dates.length,30);
  assert.equal(monthDays(2028,1).dates.at(-1),'2028-02-29');
  assert.equal(monthDays(2027,1).dates.at(-1),'2027-02-28');
  assert.equal(monthDays(2099,11).dates.at(-1),'2099-12-31');
  assert.equal(monthDays(2000,0).dates[0],'2000-01-01');
});

test('menu keeps seven days and protects note/photo contents without offering note groceries',()=>{
  const {render}=load('meal-plan-view.js','MealPlanReference');
  const days=Array.from({length:7},(_,i)=>({key:`2026-11-${9+i}`,weekday:'День',dateLabel:String(9+i)}));
  const html=render({days,entries:[{id:'note',kind:'note',date:days[0].key,note:'<img src=x onerror=alert(1)>',meal:null},{id:'recipe',kind:'recipe',date:days[1].key,meal:'dinner',recipeAvailable:true,recipe:{title:'<script>unsafe</script>',thumbnailUrl:'javascript:alert(1)'}}]});
  assert.equal((html.match(/class="mp-day-heading"/g)||[]).length,7);
  assert.equal((html.match(/class="mp-day-empty"/g)||[]).length,5);
  assert.match(html,/&lt;img/);assert.match(html,/&lt;script&gt;/);
  assert.doesNotMatch(html,/<img[^>]+src="javascript:/);
  assert.equal((html.match(/data-review="plan-grocery"/g)||[]).length,1);
  assert.equal((html.match(/data-review="plan-type"/g)||[]).length,2);
  assert.doesNotMatch(render({days,entries:[]}),/class="mp-day-heading"/);
});
