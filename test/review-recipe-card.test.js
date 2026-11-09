import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const sandbox={window:{},Intl};
vm.runInNewContext(fs.readFileSync(new URL('../public/review/recime-20261109/recipe-card.js',import.meta.url),'utf8'),sandbox);
const card=sandbox.window.RecipeReferenceCard;

test('recipe card rescales numeric quantities without changing source data or inventing missing quantities',()=>{
  const recipe={servings:2,ingredients:[{name:'Рис',quantity:'1/2',unit:'кг'},{name:'Вода',quantity:'1,5',unit:'л'},{name:'Соль',quantity:null,unit:'',comment:'по вкусу'}]};
  const original=JSON.stringify(recipe),html=card.ingredients(recipe,4,'small');
  assert.match(html,/<strong>1[\s\u00a0]000 г<\/strong> Рис/);
  assert.match(html,/<strong>3[\s\u00a0]000 мл<\/strong> Вода/);
  assert.match(html,/Соль <span>по вкусу<\/span>/);
  assert.doesNotMatch(html,/<strong>0[^<]*<\/strong> Соль/);
  assert.equal(JSON.stringify(recipe),original);
  assert.match(card.ingredients({...recipe,servings:null},8),/<strong>0,5 кг<\/strong> Рис/);
});

test('large-unit conversion preserves small quantities instead of rounding them to zero',()=>{
  const html=card.ingredients({servings:1,ingredients:[{name:'Соль',quantity:1,unit:'г'},{name:'Вода',quantity:1,unit:'мл'},{name:'Специя',quantity:0.001,unit:'г'}]},1,'large');
  assert.match(html,/<strong>0,001 кг<\/strong> Соль/);
  assert.match(html,/<strong>0,001 л<\/strong> Вода/);
  assert.match(html,/<strong>0,000001 кг<\/strong> Специя/);
  assert.doesNotMatch(html,/<strong>0 /);
  assert.equal(card.numeric('1 1/2'),1.5);
  assert.equal(card.numeric('1/0'),null);
  assert.equal(card.numeric('9'.repeat(400)),null);
});

test('reference card escapes user-authored content in title, source, ingredients, notes, steps and tags',()=>{
  const malicious='<img src=x onerror="alert(1)">',html=card.render({id:'id',title:malicious,sourceName:malicious,servings:null,ingredients:[{name:malicious}],steps:[{text:malicious}],notes:malicious,tags:[malicious]});
  assert.doesNotMatch(html,/<img src=x/);
  assert.ok(html.match(/&lt;img/g).length>=6);
  assert.match(html,/Порции не указаны в исходном рецепте/);
  assert.doesNotMatch(html,/0[\s<]+ккал/);
});
