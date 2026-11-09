import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/review/recime-20261109/meal-plan-view.js', import.meta.url), 'utf8');

// A small event/DOM fixture exercises the shipped mount function, including
// capture/bubbling and action delegation. Assertions describe visible/accessibly
// exposed lanes and actual clicks, not the recognizer's private pointer state.
function fixture() {
  let now = 1000, nextFrame = 0, dispatch;
  const nodes = [], frames = new Map(), captures = new Map();
  const result = {recipeClicks: 0, actionClicks: 0};
  class Element {
    constructor(classes = '', tagName = 'DIV', width = 360) {
      this.tagName = tagName; this.width = width; this.children = []; this.parentElement = null;
      this.dataset = {}; this.attributes = new Map(); this.listeners = new Map();
      this.disabled = false; this.inert = false; this.tabIndex = 0; this.isConnected = true;
      const values = new Set(classes.split(' ').filter(Boolean)), styles = new Map();
      this.classList = {contains: value => values.has(value), add: (...names) => names.forEach(name => values.add(name)),
        remove: (...names) => names.forEach(name => values.delete(name)), toggle: (name, enabled) => {const on = enabled ?? !values.has(name); if (on) values.add(name); else values.delete(name); return on;}};
      this.style = {setProperty: (key, value) => styles.set(key, value), getPropertyValue: key => styles.get(key) || '', removeProperty: key => styles.delete(key)};
      nodes.push(this);
    }
    append(...children) {for (const child of children) {child.parentElement = this; this.children.push(child);}}
    matches(selector) {
      if (selector.includes(',')) return selector.split(',').some(part => this.matches(part.trim()));
      if (selector === 'button:not(:disabled)') return this.tagName === 'BUTTON' && !this.disabled;
      if (selector === 'button') return this.tagName === 'BUTTON';
      if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
      const attribute = selector.match(/^\[([^=\]]+)(?:=["']?([^"'\]]+)["']?)?\]$/);
      return attribute ? this.hasAttribute(attribute[1]) && (attribute[2] === undefined || this.getAttribute(attribute[1]) === attribute[2]) : false;
    }
    closest(selector) {for (let item = this; item; item = item.parentElement) if (item.matches(selector)) return item; return null;}
    contains(element) {for (let item = element; item; item = item.parentElement) if (item === this) return true; return false;}
    querySelectorAll(selector) {return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);}
    querySelector(selector) {return this.querySelectorAll(selector)[0] || null;}
    setAttribute(name, value) {this.attributes.set(name, String(value)); if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(value);}
    getAttribute(name) {if (name.startsWith('data-')) return this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] ?? null; return this.attributes.get(name) ?? null;}
    hasAttribute(name) {return this.getAttribute(name) !== null;}
    removeAttribute(name) {this.attributes.delete(name);}
    addEventListener(type, fn, options) {const entries = this.listeners.get(type) || []; entries.push({fn, capture: options === true || Boolean(options?.capture)}); this.listeners.set(type, entries);}
    removeEventListener(type, fn, options) {const capture = options === true || Boolean(options?.capture); this.listeners.set(type, (this.listeners.get(type) || []).filter(entry => entry.fn !== fn || entry.capture !== capture));}
    focus() {document.activeElement = this;}
    getBoundingClientRect() {const row = this.closest('.mp-entry'); const shift = this.classList.contains('mp-surface') ? Number.parseFloat(row?.style.getPropertyValue('--mp-offset') || 0) : 0; return {left: shift, right: shift + this.width, top: 0, bottom: 86, width: this.width, height: 86};}
    setPointerCapture(id) {const old = captures.get(id); captures.set(id, this); if (old && old !== this) dispatch('lostpointercapture', {target: old, pointerId: id});}
    hasPointerCapture(id) {return captures.get(id) === this;}
    releasePointerCapture(id) {if (captures.get(id) !== this) return; captures.delete(id); dispatch('lostpointercapture', {target: this, pointerId: id});}
  }
  const document = new Element(), window = new Element(), view = new Element('mp-view');
  document.hidden = false; document.visibilityState = 'visible'; document.append(view);
  const rows = [0, 1].map(index => {
    const row = new Element('mp-entry'), surface = new Element('mp-surface'), opener = new Element('mp-entry-open', 'BUTTON'), child = new Element('mp-entry-title', 'SPAN');
    row.dataset.entryId = String(index); opener.setAttribute('data-review', 'plan-open'); opener.append(child);
    const more = new Element('mp-more', 'BUTTON'); more.setAttribute('data-mp-more', ''); more.setAttribute('aria-expanded', 'false');
    const lanes = [new Element('mp-actions mp-actions--before', 'DIV', 64), new Element('mp-actions mp-actions--after', 'DIV', 192)];
    lanes.forEach((lane, side) => {lane.inert = true; lane.setAttribute('aria-hidden', 'true'); for (let i = 0; i < (side ? 3 : 1); i++) {const action = new Element('mp-swipe-action', 'BUTTON', 64); action.setAttribute('data-review', side ? ['plan-cooked', 'plan-grocery', 'remove-plan'][i] : 'plan-type'); action.tabIndex = -1; lane.append(action);}});
    surface.append(opener, more); row.append(...lanes, surface); view.append(row);
    return {row, surface, opener, child, more, before: lanes[0], after: lanes[1]};
  });
  function event(overrides = {}) {
    return {pointerId: 1, isPrimary: true, button: 0, buttons: 1, pointerType: 'touch', clientX: 180, clientY: 100, timeStamp: now,
      target: rows[0].opener, detail: 1, cancelable: true, defaultPrevented: false, stopped: false, immediate: false,
      preventDefault() {this.defaultPrevented = true;}, stopPropagation() {this.stopped = true;}, stopImmediatePropagation() {this.immediate = true; this.stopped = true;}, ...overrides};
  }
  dispatch = (type, overrides = {}) => {
    const input = event(overrides); input.type = type;
    const path = []; for (let item = input.target; item; item = item.parentElement) path.push(item);
    const invoke = (target, capture) => {input.currentTarget = target; for (const entry of [...(target.listeners.get(type) || [])]) {if (entry.capture !== capture) continue; entry.fn(input); if (input.immediate) break;}};
    for (const target of [...path].reverse()) {invoke(target, true); if (input.stopped) return input;}
    for (const target of path) {invoke(target, false); if (input.stopped) break;}
    return input;
  };
  const sandbox = {window, document, URL, location: {origin: 'https://example.test'}, performance: {now: () => now},
    requestAnimationFrame: fn => {frames.set(++nextFrame, fn); return nextFrame;}, cancelAnimationFrame: id => frames.delete(id),
    getComputedStyle: element => ({getPropertyValue: key => element.style.getPropertyValue(key)}), setTimeout, clearTimeout};
  vm.runInNewContext(source, sandbox);
  let dispose = window.MealPlanReference.mount(view);
  view.addEventListener('click', input => {if (input.defaultPrevented) return; if (input.target.closest('.mp-swipe-action')) result.actionClicks++; else if (input.target.closest('.mp-entry-open')) result.recipeClicks++;});
  const flush = () => {const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn(now));};
  function send(type, overrides = {}, paint = true) {
    const {at, ...fields} = overrides; if (at !== undefined) now = at;
    if (type === 'pointerdown' && (fields.pointerType || 'touch') === 'touch' && fields.isPrimary !== false) captures.set(fields.pointerId || 1, fields.target || rows[0].opener);
    const input = dispatch(type, fields); if (paint) flush(); return input;
  }
  const exposed = item => item.before.getAttribute('aria-hidden') === 'false' && !item.before.inert ? 1 : item.after.getAttribute('aria-hidden') === 'false' && !item.after.inert ? -1 : 0;
  const listenerCount = () => nodes.reduce((sum, node) => sum + [...node.listeners.values()].reduce((n, list) => n + list.length, 0), 0);
  return {rows, view, document, window, result, exposed, send, flush, listenerCount, captures, frames,
    dispose: () => dispose(), remount: () => {dispose = window.MealPlanReference.mount(view);},
    advance: ms => {now += ms;},
    click: target => send('click', {target}),
    drag(side, distance = 40, row = rows[0], start = 1000) {send('pointerdown', {target: row.opener, at: start}); send('pointermove', {target: row.opener, clientX: 180 + side * 16, at: start + 200}); send('pointermove', {target: row.opener, clientX: 180 + side * distance, at: start + 450}); send('pointerup', {target: row.opener, clientX: 180 + side * distance, at: start + 600});},
  };
}

test('the same short slow drag opens both narrow and wide meal action lanes', () => {
  for (const side of [-1, 1]) for (const distance of [36, 40]) {
    const f = fixture(); f.drag(side, distance);
    assert.equal(f.exposed(f.rows[0]), side, `slow ${distance}px drag in direction ${side}`);
    assert.equal(f.result.recipeClicks, 0);
  }
});

test('a short reverse drag closes an open lane without traversing its full width', () => {
  for (const side of [-1, 1]) {
    const f = fixture(), row = f.rows[0]; f.send('keydown', {target: row.opener, key: side < 0 ? 'ArrowLeft' : 'ArrowRight'});
    assert.equal(f.exposed(row), side);
    f.drag(-side, 40, row, 2000);
    assert.equal(f.exposed(row), 0, `40px reverse drag closes direction ${side}`);
    assert.equal(row.before.inert && row.after.inert, true);
  }
});

test('a short flick uses recent speed even after holding the recipe still', () => {
  for (const side of [-1, 1]) {
    const f = fixture(); f.send('pointerdown', {at: 1000});
    f.send('pointermove', {at: 2000});
    f.send('pointermove', {clientX: 180 + side * 8, at: 2010});
    f.send('pointermove', {clientX: 180 + side * 24, at: 2035});
    f.send('pointerup', {clientX: 180 + side * 24, at: 2040});
    assert.equal(f.exposed(f.rows[0]), side, `24px recent flick in direction ${side}`);
  }
});

test('small slow movement, a stopped flick and returning to the start do not reveal actions', () => {
  for (const side of [-1, 1]) for (const motion of ['slow', 'stopped', 'returned']) {
    const f = fixture(); f.send('pointerdown', {at: 1000});
    if (motion === 'slow') {
      f.send('pointermove', {clientX: 180 + side * 24, at: 1400});
      f.send('pointerup', {clientX: 180 + side * 24, at: 1600});
    } else if (motion === 'stopped') {
      f.send('pointermove', {clientX: 180 + side * 24, at: 1040});
      f.send('pointerup', {clientX: 180 + side * 24, at: 1400});
    } else {
      f.send('pointermove', {clientX: 180 + side * 50, at: 1100});
      f.send('pointerup', {clientX: 180, at: 1300});
    }
    assert.equal(f.exposed(f.rows[0]), 0, `${motion}, direction ${side}`);
    f.click(f.rows[0].opener); assert.equal(f.result.recipeClicks, 0);
  }
});

test('release coordinates complete a gesture even when moves are missing or arrive early', () => {
  for (const side of [-1, 1]) for (const moved of [false, true]) {
    const f = fixture(); f.send('pointerdown', {at: 1000});
    if (moved) f.send('pointermove', {clientX: 180 + side * 10, at: 1200});
    f.send('pointerup', {clientX: 180 + side * 40, clientY: 102, at: 1500});
    assert.equal(f.exposed(f.rows[0]), side, `${moved ? 'early' : 'missing'} move, direction ${side}`);
    assert.equal(f.click(f.rows[0].opener).defaultPrevented, true);
    assert.equal(f.result.recipeClicks, 0);
  }
});

test('vertical scrolling and cancelled movement cannot accidentally open a recipe', () => {
  for (const ending of ['vertical', 'pointercancel', 'lostpointercapture']) {
    const f = fixture(), row = f.rows[0]; f.send('pointerdown');
    if (ending === 'vertical') {
      const move = f.send('pointermove', {clientX: 184, clientY: 155, at: 1100});
      assert.equal(move.defaultPrevented, false, 'native vertical scrolling stays available');
      f.send('pointerup', {clientX: 184, clientY: 165, at: 1200});
    } else {
      f.send('pointermove', {clientX: 220, at: 1100});
      const owner = f.captures.get(1) || row.row;
      f.send(ending, {target: owner, at: 1200}); f.send('pointerup', {clientX: 240, at: 1250});
    }
    f.click(row.opener);
    assert.equal(f.exposed(row), 0, ending); assert.equal(f.result.recipeClicks, 0, ending);
  }
});

test('implicit touch capture leaving a child does not interrupt the swipe', () => {
  for (const side of [-1, 1]) {
    const f = fixture(), row = f.rows[0]; f.send('pointerdown', {target: row.child});
    f.send('pointermove', {target: row.child, clientX: 180 + side * 20, at: 1100});
    f.send('lostpointercapture', {target: row.child, at: 1110});
    f.send('pointermove', {target: row.row, clientX: 180 + side * 80, at: 1400});
    f.send('pointerup', {target: row.row, clientX: 180 + side * 80, at: 1500});
    assert.equal(f.exposed(row), side); assert.equal(f.result.recipeClicks, 0);
  }
});

test('a revealed action accepts the very next tap after dragging', () => {
  const f = fixture(), row = f.rows[0]; f.drag(-1, 80);
  const button = row.after.children[1]; assert.equal(button.tabIndex, 0); assert.equal(row.after.inert, false);
  f.send('pointerdown', {target: button, at: 1620}); f.send('pointerup', {target: button, at: 1650});
  assert.equal(f.click(button).defaultPrevented, false);
  assert.equal(f.result.actionClicks, 1); assert.equal(f.result.recipeClicks, 0); assert.equal(f.exposed(row), 0);
});

test('dragging the revealed action strip back closes it without pressing its buttons', () => {
  const f = fixture(), row = f.rows[0]; f.send('keydown', {target: row.opener, key: 'ArrowLeft'});
  const button = row.after.children[1];
  f.send('pointerdown', {target: button, at: 2000});
  f.send('pointermove', {target: button, clientX: 220, at: 2400});
  f.send('pointerup', {target: button, clientX: 220, at: 2600});
  assert.equal(f.exposed(row), 0);
  f.click(button); assert.equal(f.result.actionClicks, 0); assert.equal(f.result.recipeClicks, 0);
});

test('only one row is open and keyboard actions remain available without a swipe', () => {
  const f = fixture(), [first, second] = f.rows;
  f.send('keydown', {target: first.opener, key: 'ArrowRight'});
  assert.equal(f.exposed(first), 1); assert.equal(f.document.activeElement, first.before.children[0]);
  f.send('keydown', {target: second.opener, key: 'ArrowLeft'});
  assert.equal(f.exposed(first), 0); assert.equal(f.exposed(second), -1);
  f.send('keydown', {target: second.after.children[0], key: 'Escape'});
  assert.equal(f.exposed(second), 0); assert.equal(f.document.activeElement, second.more);
  f.send('pointerdown'); f.send('pointerup'); f.click(first.opener);
  assert.equal(f.result.recipeClicks, 1, 'an ordinary tap still opens the recipe');
});

test('disposal and remount remove listeners and cannot paint a stale gesture', () => {
  const f = fixture(), row = f.rows[0], mounted = f.listenerCount();
  f.send('pointerdown'); f.send('pointermove', {clientX: 220, at: 1100}, false);
  f.dispose(); f.flush();
  assert.equal(f.exposed(row), 0); assert.equal(row.surface.getBoundingClientRect().left, 0);
  assert.equal(f.listenerCount(), 1, 'only the simulated application click delegate remains');
  assert.equal(f.captures.size, 0); assert.equal(f.frames.size, 0);
  f.remount(); assert.equal(f.listenerCount(), mounted);
  f.remount(); assert.equal(f.listenerCount(), mounted, 'mounting twice does not double event listeners');
  f.send('keydown', {key: 'ArrowLeft'}); assert.equal(f.exposed(row), -1);
  f.dispose(); f.flush(); assert.equal(f.exposed(row), 0); assert.equal(f.listenerCount(), 1);
});
