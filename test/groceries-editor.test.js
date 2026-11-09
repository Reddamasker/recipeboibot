import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/review/recime-20261109/groceries-editor.js', import.meta.url), 'utf8');
const decode = text => text.replace(/&(amp|lt|gt|quot|#39);/g, (_, key) => ({amp:'&',lt:'<',gt:'>',quot:'"','#39':"'"}[key]));
const plain = value => JSON.parse(JSON.stringify(value));
const defer = () => {let resolve, reject; const promise = new Promise((yes,no) => {resolve=yes;reject=no;}); return {promise,resolve,reject};};

// A small native-dialog fixture. It parses rendered controls and dispatches real
// delegated events; the assertions do not depend on the editor's private state.
function browser() {
  let document, uuid = 0;
  const frames = [];
  class Element {
    constructor(tag = 'div') {this.tagName=tag.toUpperCase();this.children=[];this.parentElement=null;this.dataset={};this.attributes={};this.listeners=new Map();this.disabled=false;this.checked=false;this.hidden=false;this.value='';this.scrollTop=0;this._text='';this.open=false;}
    setAttribute(name,value='') {value=String(value);this.attributes[name]=value;if(name.startsWith('data-'))this.dataset[name.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=value;if(name==='class')this.className=value;if(name==='id')this.id=value;if(['disabled','checked','hidden'].includes(name))this[name]=true;if(name==='value')this.value=value;}
    getAttribute(name) {return this.attributes[name] ?? null;}
    get isConnected() {return this===document.body || Boolean(this.parentElement?.isConnected);}
    append(...elements) {for(const element of elements){element.parentElement=this;this.children.push(element);}}
    remove() {if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(child=>child!==this);this.parentElement=null;}
    contains(element) {return element===this || this.children.some(child=>child.contains(element));}
    matches(selector) {
      if(selector.startsWith('.'))return (this.className||'').split(' ').includes(selector.slice(1));
      if(selector.startsWith('#'))return this.id===selector.slice(1);
      const attr=selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
      if(attr)return Object.hasOwn(this.attributes,attr[1]) && (attr[2]===undefined || this.attributes[attr[1]]===attr[2]);
      return this.tagName.toLowerCase()===selector;
    }
    querySelectorAll(selector) {const selectors=selector.split(',').map(s=>s.trim()),results=[];const walk=element=>{for(const child of element.children){if(selectors.some(s=>child.matches(s)))results.push(child);walk(child);}};walk(this);return results;}
    querySelector(selector) {return this.querySelectorAll(selector)[0] || null;}
    closest(selector) {const selectors=selector.split(',').map(s=>s.trim());for(let el=this;el;el=el.parentElement)if(selectors.some(s=>el.matches(s)))return el;return null;}
    set innerHTML(html) {
      this._html=html;this.children=[];this._text='';const stack=[this];
      for(const token of html.match(/<[^>]*>|[^<]+/g)||[]){
        if(token.startsWith('</')){stack.pop();continue;}
        if(!token.startsWith('<')){stack.at(-1)._text+=decode(token);continue;}
        const tag=token.match(/^<([a-z][\w-]*)\b/i)?.[1];if(!tag)continue;
        const element=new Element(tag),attrs=token.slice(tag.length+1,-1);
        for(const match of attrs.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g))element.setAttribute(match[1],decode(match[2]??match[3]??match[4]??''));
        stack.at(-1).append(element);
        if(!['input','img','br','hr','meta','link'].includes(tag)&&!token.endsWith('/>'))stack.push(element);
      }
    }
    get innerHTML() {return this._html||'';}
    set textContent(text) {this._text=String(text);this.children=[];}
    get textContent() {return this._text+this.children.map(child=>child.textContent).join('');}
    addEventListener(type,handler,options={}) {const list=this.listeners.get(type)||[];list.push({handler,once:options.once});this.listeners.set(type,list);}
    removeEventListener(type,handler) {this.listeners.set(type,(this.listeners.get(type)||[]).filter(item=>item.handler!==handler));}
    dispatch(type,extra={}) {const event={target:this,preventDefault(){this.defaultPrevented=true;},...extra};for(const item of [...(this.listeners.get(type)||[])]){item.handler(event);if(item.once)this.removeEventListener(type,item.handler);}return event;}
    focus() {document.activeElement=this;}
    showModal() {this.open=true;}
    close(value='') {if(!this.open)return;this.returnValue=value;this.open=false;this.dispatch('close');}
  }
  document=new Element('document');document.body=new Element('body');document.visibilityState='visible';document.activeElement=document.body;document.createElement=tag=>new Element(tag);
  const context={window:{},document,crypto:{randomUUID:()=>`00000000-0000-4000-8000-${String(++uuid).padStart(12,'0')}`},location:{origin:'http://localhost:3094'},URL,Intl,Date,requestAnimationFrame:callback=>frames.push(callback)};
  vm.runInNewContext(source,context,{filename:'groceries-editor.js'});
  const find=(dialog,selector)=>{const element=dialog.querySelector(selector);assert.ok(element,`Missing ${selector}`);return element;};
  return {
    api:context.window.GroceriesEditor,document,
    find,
    click(dialog,selector){const element=find(dialog,selector);if(!element.disabled)dialog.dispatch('click',{target:element});},
    change(dialog,selector,checked){const element=find(dialog,selector);if(element.disabled)return;element.checked=checked;dialog.dispatch('change',{target:element});},
    input(dialog,selector,value){const element=find(dialog,selector);if(element.disabled)return;element.value=String(value);dialog.dispatch('input',{target:element});},
    async settle(){for(let i=0;i<8;i++){await Promise.resolve();for(const callback of frames.splice(0))callback();}},
  };
}

const ingredient = (key,overrides={}) => ({key,name:key,quantity:200,unit:'г',amountText:'',comment:'',...overrides});
const preview = (entryId='a',overrides={}) => ({entryId,recipeId:'recipe-'+entryId,title:'Рис с овощами',thumbnailUrl:'',date:'2026-11-09',meal:'dinner',servings:4,baseServings:2,recipeRevision:'revision-1',ingredients:[ingredient('rice'),ingredient('salt',{quantity:null,unit:'ст. л.',amountText:'1–2'})],...overrides});
const entry = (id='a',overrides={}) => ({id,date:'2026-11-09',meal:'dinner',recipeAvailable:true,recipe:{id:'recipe-'+id,title:'Рис с овощами'},...overrides});
const response = (...entries) => ({version:3,entries});
const submit = '[data-gwe="submit"]';

test('choose recipes includes available dishes only and writes only after Add', async()=>{
  const b=browser(),loads=[],saved=[];
  const dialog=b.api.open({entries:[entry(),entry('b',{recipeAvailable:false}),entry('n',{kind:'note'})],loadIngredients:async ids=>{loads.push(plain(ids));return response(preview());},onSave:async fields=>saved.push(plain(fields))});
  assert.equal(dialog.dataset.wsDialog,'groceries.editor');
  assert.equal(dialog.querySelectorAll('[data-gwe-entry]').length,2);
  assert.equal(b.find(dialog,'[data-gwe-entry="0"]').checked,true);
  assert.equal(b.find(dialog,'[data-gwe-entry="1"]').disabled,true);
  assert.deepEqual(loads,[]);assert.deepEqual(saved,[]);
  b.click(dialog,submit);await b.settle();
  assert.deepEqual(loads,[['a']]);assert.deepEqual(saved,[]);
  assert.equal(dialog.querySelectorAll('[data-gwe-ingredient]').length,2);
  b.click(dialog,submit);await b.settle();
  assert.equal(saved.length,1);assert.equal(dialog.returnValue,'saved');assert.equal(dialog.isConnected,false);
});

test('servings scale the loaded preview, preserve text units, and convert only supported dimensions',async()=>{
  const b=browser(),saved=[];
  const dialog=b.api.open({entries:[entry()],skipChoose:true,loadIngredients:async()=>response(preview()),onSave:async fields=>saved.push(plain(fields))});await b.settle();
  assert.equal(b.find(dialog,'[data-gwe-amount="0:0"]').textContent,'200 г ');
  b.input(dialog,'[data-gwe-servings="0"]',8);
  assert.equal(b.find(dialog,'[data-gwe-amount="0:0"]').textContent,'400 г ');
  assert.equal(b.find(dialog,'[data-gwe-amount="0:1"]').textContent,'1–2 ст. л. ');
  b.click(dialog,'[data-gwe="units"]');b.click(dialog,'[data-gwe-unit="large"]');
  assert.equal(b.find(dialog,'[data-gwe-amount="0:0"]').textContent,'0,4 кг ');
  assert.equal(b.api.formatAmount(ingredient('oil',{quantity:2,unit:'ст. л.'}),2,'large'),'4 ст. л.');
  assert.equal(b.api.formatAmount(ingredient('milk',{quantity:1.5,unit:'л'}),1,'small'),'1 500 мл');
  b.click(dialog,submit);await b.settle();
  assert.equal(saved[0].selections[0].servings,8);
});

test('Back and changing recipes preserve local selections and servings without reapplying server defaults',async()=>{
  const b=browser(),loads=[],saved=[];
  const dialog=b.api.open({entries:[entry(),entry('b')],loadIngredients:async ids=>{loads.push(plain(ids));return response(...ids.map(id=>preview(id,{selectedIngredientKeys:['rice']})));},onSave:async fields=>saved.push(plain(fields))});
  b.click(dialog,submit);await b.settle();
  assert.equal(b.find(dialog,'[data-gwe-ingredient="0:1"]').checked,false);
  b.change(dialog,'[data-gwe-ingredient="0:1"]',true);b.input(dialog,'[data-gwe-servings="0"]',6);
  b.click(dialog,'[data-gwe="back"]');b.click(dialog,submit);await b.settle();
  assert.equal(loads.length,1);assert.equal(b.find(dialog,'[data-gwe-servings="0"]').value,'6');assert.equal(b.find(dialog,'[data-gwe-ingredient="0:1"]').checked,true);
  b.click(dialog,'[data-gwe="back"]');b.change(dialog,'[data-gwe-entry="1"]',false);b.click(dialog,submit);await b.settle();
  assert.equal(loads.length,2);assert.equal(b.find(dialog,'[data-gwe-servings="0"]').value,'6');assert.equal(b.find(dialog,'[data-gwe-ingredient="0:1"]').checked,true);
  b.click(dialog,submit);await b.settle();
  assert.deepEqual(saved[0],{entryIds:['a'],selections:[{entryId:'a',servings:6,ingredientKeys:['rice','salt'],recipeRevision:'revision-1'}]});
});

test('unknown portions stay null and empty selections cannot be saved; single recipe uses a null entry',async()=>{
  const b=browser(),saved=[],loads=[];
  const dialog=b.api.open({entries:[entry(null)],skipChoose:true,loadIngredients:async ids=>{loads.push(plain(ids));return response(preview(null,{baseServings:null,servings:null,selectedIngredientKeys:[]}));},onSave:async fields=>saved.push(plain(fields))});await b.settle();
  assert.deepEqual(loads,[[]]);assert.equal(b.find(dialog,'[data-gwe-servings="0"]').disabled,true);assert.equal(b.find(dialog,submit).disabled,true);
  b.click(dialog,submit);await b.settle();assert.equal(saved.length,0);
  b.click(dialog,'[data-gwe="toggle-all"]');assert.equal(b.find(dialog,submit).disabled,false);b.click(dialog,submit);await b.settle();
  assert.deepEqual(saved[0],{entryIds:[],selections:[{entryId:null,servings:null,ingredientKeys:['rice','salt'],recipeRevision:'revision-1'}]});
});

test('uncertain saving freezes the draft and retries the identical payload; pending double-taps do not duplicate',async()=>{
  const b=browser(),calls=[],pending=defer();let attempts=0;
  const dialog=b.api.open({entries:[entry()],loadIngredients:async()=>response(preview()),onSave:async fields=>{calls.push(fields);if(++attempts===1)return pending.promise;}});
  b.click(dialog,submit);await b.settle();b.click(dialog,submit);b.click(dialog,submit);await b.settle();
  assert.equal(calls.length,1);assert.equal(b.find(dialog,'[data-gwe="close"]').disabled,true);assert.equal(dialog.dispatch('cancel').defaultPrevented,true);
  pending.reject(Object.assign(new Error('Связь прервалась. Повтори добавление.'),{uncertain:true}));await b.settle();
  assert.equal(b.find(dialog,'[data-gwe-servings="0"]').disabled,true);assert.equal(b.find(dialog,'[data-gwe="back"]').disabled,true);assert.equal(b.find(dialog,'[data-gwe="close"]').disabled,false);assert.equal(b.find(dialog,submit).disabled,false);
  assert.equal(b.document.activeElement,b.find(dialog,'[data-gwe-status]'));
  b.input(dialog,'[data-gwe-servings="0"]',9);b.click(dialog,submit);await b.settle();
  assert.equal(calls.length,2);assert.equal(calls[0],calls[1]);assert.equal(calls[1].selections[0].servings,4);assert.equal(dialog.returnValue,'saved');
});

test('a conflict locks saving and invalid portions block Add',async()=>{
  const b=browser();let calls=0;
  const dialog=b.api.open({entries:[entry()],loadIngredients:async()=>response(preview()),onSave:async()=>{calls++;throw Object.assign(new Error('Меню изменилось. Открой заново.'),{status:409});}});
  b.click(dialog,submit);await b.settle();b.input(dialog,'[data-gwe-servings="0"]','');assert.equal(b.find(dialog,submit).disabled,true);
  b.input(dialog,'[data-gwe-servings="0"]',101);assert.equal(b.find(dialog,submit).disabled,true);
  b.input(dialog,'[data-gwe-servings="0"]',2);assert.equal(b.find(dialog,submit).disabled,false);
  b.click(dialog,submit);await b.settle();
  assert.equal(b.find(dialog,submit).disabled,true);assert.equal(b.find(dialog,'[data-gwe="back"]').disabled,true);assert.equal(b.find(dialog,'[data-gwe-ingredient="0:0"]').disabled,true);
  b.click(dialog,submit);assert.equal(calls,1);b.click(dialog,'[data-gwe="close"]');assert.equal(dialog.open,false);
});

test('a definite validation failure leaves an editable draft and changed recipe revisions reset stale selections',async()=>{
  const b=browser(),saved=[];let loads=0;
  const dialog=b.api.open({entries:[entry(),entry('b')],loadIngredients:async ids=>{loads++;return response(...ids.map(id=>preview(id,{recipeRevision:loads>1?'revision-2':'revision-1',selectedIngredientKeys:['rice']})));},onSave:async fields=>{saved.push(plain(fields));if(saved.length===1)throw Object.assign(new Error('Проверь количество.'),{status:422});}});
  b.click(dialog,submit);await b.settle();b.change(dialog,'[data-gwe-ingredient="0:1"]',true);b.input(dialog,'[data-gwe-servings="0"]',6);
  b.click(dialog,submit);await b.settle();assert.equal(b.find(dialog,'[data-gwe-servings="0"]').disabled,false);assert.equal(b.find(dialog,'[data-gwe="back"]').disabled,false);
  b.click(dialog,'[data-gwe="back"]');b.change(dialog,'[data-gwe-entry="1"]',false);b.click(dialog,submit);await b.settle();
  assert.equal(b.find(dialog,'[data-gwe-ingredient="0:1"]').checked,false);assert.equal(b.find(dialog,'[data-gwe-servings="0"]').value,'4');assert.match(b.find(dialog,'[data-gwe-status]').textContent,/Состав рецепта обновился/);
  b.click(dialog,submit);await b.settle();assert.equal(saved[1].selections[0].recipeRevision,'revision-2');assert.deepEqual(saved[1].selections[0].ingredientKeys,['rice']);
});

test('load errors can be retried and closing a pending load cannot restore its dialog or notify visibility',async()=>{
  const b=browser();let calls=0,visible=0;
  const dialog=b.api.open({entries:[entry()],skipChoose:true,loadIngredients:async()=>{if(++calls===1)throw new Error('Нет соединения');return response(preview());},onSave:async()=>{},onIngredientsVisible:()=>visible++});await b.settle();
  assert.equal(b.find(dialog,submit).textContent,'Повторить загрузку');assert.equal(visible,0);assert.equal(b.document.activeElement,b.find(dialog,'[data-gwe-status]'));
  b.click(dialog,submit);await b.settle();assert.equal(visible,1);b.click(dialog,'[data-gwe="close"]');
  const late=defer(),dialog2=b.api.open({entries:[entry()],skipChoose:true,loadIngredients:()=>late.promise,onSave:async()=>{},onIngredientsVisible:()=>visible++});
  b.click(dialog2,'[data-gwe="close"]');late.resolve(response(preview()));await b.settle();assert.equal(dialog2.isConnected,false);assert.equal(visible,1);
});

test('ingredient visibility fires once per successful preview, waits while hidden, and does not duplicate on Back',async()=>{
  const b=browser();let visible=0;b.document.visibilityState='hidden';
  const dialog=b.api.open({entries:[entry()],loadIngredients:async()=>response(preview()),onSave:async()=>{},onIngredientsVisible:element=>{assert.equal(element.isConnected,true);visible++;}});
  b.click(dialog,submit);await b.settle();assert.equal(visible,0);
  b.document.visibilityState='visible';b.document.dispatch('visibilitychange');await b.settle();assert.equal(visible,1);
  b.click(dialog,'[data-gwe="back"]');b.click(dialog,submit);await b.settle();assert.equal(visible,1);
  b.document.dispatch('visibilitychange');await b.settle();assert.equal(visible,1);
});

test('names and comments render as text, unsafe or empty photos do not create image requests',async()=>{
  const b=browser();
  const dialog=b.api.open({entries:[entry()],skipChoose:true,loadIngredients:async()=>response(preview('a',{title:'<script>bad()</script>',thumbnailUrl:'javascript:bad()',ingredients:[ingredient('x',{name:'<img onerror="bad()">',comment:'a & b <script>'})]})),onSave:async()=>{}});await b.settle();
  assert.equal(dialog.querySelectorAll('img').length,0);assert.equal(dialog.querySelectorAll('script').length,0);
  assert.match(dialog.textContent,/<script>bad\(\)<\/script>/);assert.match(dialog.textContent,/a & b <script>/);
});
