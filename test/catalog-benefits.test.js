import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';

const script = fs.readFileSync(new URL('../public/catalog-benefits.js', import.meta.url), 'utf8');
const recipe = {title:'Паста с томатами', image:'/assets/catalog/pasta.jpg'};

// The harness models visibility, storage and DOM events; native modal focus handling
// and viewport layout are covered by the accompanying real-browser review.
function browser({storage = new Map(), storageDisabled = false, hidden = false, trackerThrows = false} = {}) {
  const frames = [], events = [], scrolls = [], focusCalls = [];
  let now = 1000, document;
  function element(tagName = 'DIV') {
    const listeners = new Map(), classes = new Set(), attributes = new Map();
    return {
      tagName, isConnected:true, style:{}, scrollTop:0, textContent:'',
      classList:{add:name=>classes.add(name), remove:name=>classes.delete(name), contains:name=>classes.has(name)},
      addEventListener(name, callback) { if(!listeners.has(name))listeners.set(name,[]); listeners.get(name).push(callback); },
      fire(name, data = {}) {
        const event = {defaultPrevented:false, preventDefault(){this.defaultPrevented=true;}, ...data};
        for(const callback of listeners.get(name)||[])callback(event);
        return event;
      },
      closest() { return this.inCatalog ? this : null; },
      setAttribute(name, value) { attributes.set(name,value); },
      getAttribute(name) { return attributes.get(name); },
      focus(options) { document.activeElement=this; focusCalls.push({element:this, options}); },
      getClientRects() { return [{}]; }
    };
  }
  const ids = new Map(['catalog-benefits','benefits-close','benefits-cta','benefits-cta-max','benefits-image','benefits-recipe-title'].map(id=>[id,element()]));
  const dialog = ids.get('catalog-benefits'), heading = element('H1'), body = element('BODY'), scroll = element();
  const trigger = element('BUTTON');
  const controls = ['benefits-close','benefits-cta','benefits-cta-max'].map(id=>ids.get(id));
  const state = {cssVisible:true, covered:false};
  dialog.open = false;
  dialog.showModal = () => { dialog.open=true; document.activeElement=ids.get('benefits-close'); };
  dialog.close = () => { dialog.open=false; };
  dialog.getBoundingClientRect = () => ({left:0,top:0,width:390,height:844});
  dialog.contains = point => point === dialog || controls.includes(point);
  dialog.querySelector = selector => selector === '.benefits-scroll' ? scroll : null;
  dialog.querySelectorAll = () => controls;
  document = Object.assign(element(), {
    body, activeElement:body, visibilityState:hidden?'hidden':'visible',
    getElementById:id=>ids.get(id),
    querySelector:selector=>selector==='#recipe-view h1'?heading:null,
    elementFromPoint:()=>state.covered?body:dialog
  });
  const window = Object.assign(element(), {
    scrollY:280,
    scrollTo(options) { scrolls.push(options); this.scrollY=options.top; },
    RecipeAnalytics:{event(event, step, detail) {
      if(trackerThrows)throw new Error('Tracker unavailable');
      events.push({event,step,...JSON.parse(JSON.stringify(detail))});
    }}
  });
  const sandbox = {
    document, window, crypto:{randomUUID}, innerWidth:390, innerHeight:844,
    Date:{now:()=>now},
    getComputedStyle:()=>({visibility:state.cssVisible?'visible':'hidden'}),
    requestAnimationFrame:callback=>frames.push(callback),
    sessionStorage:{
      getItem(key) { if(storageDisabled)throw new Error('Storage disabled');return storage.get(key)??null; },
      setItem(key,value) { if(storageDisabled)throw new Error('Storage disabled');storage.set(key,value); }
    }
  };
  vm.runInNewContext(script, sandbox, {filename:'catalog-benefits.js'});
  return {
    api:window.CatalogBenefits, window, document, dialog, heading, body, trigger, ids, scroll, state,
    events, storage, scrolls, focusCalls,
    frame() { const pending=frames.splice(0);for(const callback of pending)callback(); },
    advance(ms) { now+=ms; },
    click(id) { return ids.get(id).fire('click'); },
    reveal() { document.visibilityState='visible';document.fire('visibilitychange'); }
  };
}

test('automatic benefits appear once per tab, including reload; manual reopening stays available', () => {
  const page=browser();
  assert.equal(page.api.open(recipe,{automatic:true}),true);
  assert.equal(page.api.open(recipe,{automatic:true}),false);
  page.frame(); page.api.close();
  assert.equal(page.api.open(recipe,{automatic:true}),false);
  const reloaded=browser({storage:page.storage});
  assert.equal(reloaded.api.open(recipe,{automatic:true}),false);
  assert.equal(reloaded.api.open(recipe),true);
  reloaded.frame();
  assert.equal(reloaded.events.filter(event=>event.event==='benefits_view').length,1);
});

test('unavailable sessionStorage retains once-per-page behavior without blocking a recipe', () => {
  const page=browser({storageDisabled:true});
  assert.equal(page.api.open(recipe,{automatic:true}),true);
  assert.doesNotThrow(()=>page.frame());
  assert.doesNotThrow(()=>page.api.close());
  assert.equal(page.api.open(recipe,{automatic:true}),false);
  assert.equal(page.api.open(recipe),true);
  page.frame();
  assert.equal(page.events.filter(event=>event.event==='benefits_view').length,2);
});

test('hidden tab delays a view and its duration origin until the dialog is actually visible', () => {
  const page=browser({hidden:true});
  page.api.open(recipe,{automatic:true}); page.frame(); page.advance(5000);
  assert.equal(page.events.length,0);
  assert.equal(page.storage.size,0);
  page.reveal(); page.reveal(); page.window.fire('resize');
  assert.equal(page.events.length,1);
  assert.equal(page.events[0].event,'benefits_view');
  page.advance(400); page.click('benefits-cta');
  assert.equal(page.events[1].durationMs,400);
});

test('closed, CSS-hidden or covered dialogs do not report a view', () => {
  const page=browser({hidden:true});
  page.api.open(recipe); page.api.close(); page.reveal(); page.frame();
  assert.equal(page.events.length,0);
  page.state.cssVisible=false;
  page.api.open(recipe); page.frame();
  assert.equal(page.events.length,0);
  page.state.cssVisible=true; page.state.covered=true; page.window.fire('resize');
  assert.equal(page.events.length,0);
  page.state.covered=false; page.window.fire('resize');
  assert.equal(page.events.length,1);
});

test('duplicate CTA clicks have one shared flow and reopening creates a new flow', () => {
  const page=browser();
  page.api.open(recipe); page.frame(); page.advance(1200);
  page.click('benefits-cta'); page.click('benefits-cta-max'); page.click('benefits-cta');
  assert.equal(page.dialog.open,true,'CTA must preserve the current recipe and dialog');
  assert.deepEqual(page.events.map(event=>event.event),['benefits_view','benefits_cta']);
  assert.equal(page.events[1].durationMs,1200);
  page.advance(500); page.api.close();
  assert.equal(page.events[2].durationMs,1700);
  assert.equal(new Set(page.events.map(event=>event.flowId)).size,1);
  assert.ok(page.events.every(event=>event.step==='catalog'));
  assert.match(page.events[0].flowId,/^[a-f\d-]{36}$/i);
  page.api.open(recipe); page.frame(); page.click('benefits-cta-max'); page.click('benefits-cta');
  assert.notEqual(page.events[3].flowId,page.events[0].flowId);
  assert.equal(page.events.filter(event=>event.event==='benefits_cta').length,2);
});

test('both CTA buttons ignore a hidden or closed dialog and share one visible conversion', () => {
  const page=browser({hidden:true});page.api.open(recipe);page.frame();
  page.click('benefits-cta');page.click('benefits-cta-max');assert.equal(page.events.length,0);
  page.reveal();page.click('benefits-cta-max');page.click('benefits-cta');
  assert.deepEqual(page.events.map(e=>e.event),['benefits_view','benefits_cta']);
  assert.ok(page.events.every(e=>!('destination' in e)&&!('url' in e)));
  page.api.close();page.click('benefits-cta');page.click('benefits-cta-max');
  assert.equal(page.events.filter(e=>e.event==='benefits_cta').length,1);
});

test('keyboard focus wraps around all controls while either platform button stays in the tab sequence', () => {
  const page=browser();page.api.open(recipe);page.frame();
  page.ids.get('benefits-close').focus();
  assert.equal(page.dialog.fire('keydown',{key:'Tab',shiftKey:true}).defaultPrevented,true);
  assert.equal(page.document.activeElement,page.ids.get('benefits-cta-max'));
  assert.equal(page.dialog.fire('keydown',{key:'Tab',shiftKey:false}).defaultPrevented,true);
  assert.equal(page.document.activeElement,page.ids.get('benefits-close'));
  for(const id of ['benefits-cta']){
    page.ids.get(id).focus();assert.equal(page.dialog.fire('keydown',{key:'Tab',shiftKey:false}).defaultPrevented,false);
  }
});

for(const action of ['escape','benefits-close']) {
  test(`${action} restores scroll and recipe focus and calls afterClose exactly once`, () => {
    const page=browser(); let callbacks=0;
    page.api.open(recipe,{afterClose:()=>callbacks++}); page.frame();
    assert.equal(page.body.classList.contains('benefits-open'),true);
    assert.equal(page.body.style.top,'-280px');
    page.window.scrollY=0;
    if(action==='escape')assert.equal(page.dialog.fire('cancel').defaultPrevented,true);
    else page.click(action);
    assert.equal(page.dialog.open,false);
    assert.equal(page.body.classList.contains('benefits-open'),false);
    assert.equal(page.body.style.top,'');
    assert.equal(page.window.scrollY,280);
    assert.equal(page.document.activeElement,page.heading);
    assert.equal(page.heading.getAttribute('tabindex'),'-1');
    assert.equal(callbacks,1);
    page.api.close();
    assert.equal(callbacks,1);
    assert.equal(page.events.filter(event=>event.event==='benefits_close').length,1);
  });
}

test('manual reopening returns focus to its trigger, while navigation skips focus and recipe observation', () => {
  const page=browser(); let callbacks=0;
  page.document.activeElement=page.trigger;
  page.api.open(recipe); page.frame(); page.api.close();
  assert.equal(page.document.activeElement,page.trigger);
  const previousFocusCalls=page.focusCalls.length;
  page.api.open(recipe,{afterClose:()=>callbacks++}); page.frame();
  page.api.close({restoreFocus:false,observeRecipe:false});
  assert.equal(page.dialog.open,false);
  assert.equal(page.body.classList.contains('benefits-open'),false);
  assert.equal(page.focusCalls.length,previousFocusCalls);
  assert.equal(callbacks,0);
  page.api.open(recipe); page.frame(); page.api.close();
  assert.equal(callbacks,0,'navigation must not leak the old recipe observer to another opening');
});

test('a throwing analytics tracker does not block showing or closing the recipe', () => {
  const page=browser({trackerThrows:true}); let callbacks=0;
  assert.doesNotThrow(()=>page.api.open(recipe,{afterClose:()=>callbacks++}));
  assert.doesNotThrow(()=>page.frame());
  assert.doesNotThrow(()=>page.click('benefits-cta'));
  assert.doesNotThrow(()=>page.click('benefits-close'));
  assert.equal(page.dialog.open,false);
  assert.equal(page.body.classList.contains('benefits-open'),false);
  assert.equal(page.document.activeElement,page.heading);
  assert.equal(page.window.scrollY,280);
  assert.equal(callbacks,1);
});
