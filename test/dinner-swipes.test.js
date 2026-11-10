// Historical compatibility only; deployed defaults are covered by retired-flows.test.js.
process.env.LEGACY_RECIPE_FLOWS_ENABLED = 'true';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync('public/app.js', 'utf8');
function fixture() {
  const listeners = {}, classes = new Set(), styles = new Map(), label = {};
  let accepted = 0, rejected = 0, active = false, enabled = true, capture;
  const card = {
    querySelector: () => label, getBoundingClientRect: () => ({ width: 300 }),
    classList: { add: value => classes.add(value), remove: (...values) => values.forEach(value => classes.delete(value)), toggle: (value, enabled) => enabled ? classes.add(value) : classes.delete(value) },
    style: { setProperty: (key, value) => styles.set(key, value), removeProperty: key => styles.delete(key) },
    addEventListener: (key, fn) => { listeners[key] = fn; },
    setPointerCapture: id => { capture = id; }, hasPointerCapture: id => capture === id,
    releasePointerCapture: id => { capture = null; listeners.lostpointercapture({ target: card, pointerId: id }); },
  };
  const frames = new Map(); let nextFrame = 0;
  const sandbox = { requestAnimationFrame: fn => { frames.set(++nextFrame, fn); return nextFrame; }, cancelAnimationFrame: id => frames.delete(id) };
  vm.runInNewContext(source.slice(source.indexOf('function bindDinnerSwipe('), source.indexOf('\nfunction updateDinnerIngredients')), sandbox);
  sandbox.bindDinnerSwipe(card, { canStart: () => enabled, onAccept: () => accepted++, onReject: () => rejected++, onActive: value => { active = value; } });
  const opener = { closest() { return this; }, matches: () => true };
  function event(overrides = {}) {
    return { pointerId: 1, isPrimary: true, button: 0, clientX: 150, clientY: 100, target: opener,
      prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...overrides };
  }
  const flush = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn()); };
  const send = (type, overrides, paint = true) => { const input = event(overrides); listeners[type](input); if (paint) flush(); return input; };
  return { send, flush, styles, classes, label, card, opener, get result() { return { accepted, rejected, active }; }, disable: () => { enabled = false; } };
}

test('touch swipe survives implicit capture moving from the recipe button to its parent card', () => {
  for (const direction of [-1, 1]) {
    const f = fixture(); f.send('pointerdown', { pointerType: 'touch' });
    f.send('pointermove', { pointerType: 'touch', clientX: 150 + direction * 20 });
    // Touch starts with implicit capture on the child button. Its loss bubbles
    // when the next move transfers capture to the card; the gesture continues.
    f.send('lostpointercapture', { pointerType: 'touch', target: f.opener });
    assert.equal(f.result.active, true);
    f.send('pointermove', { pointerType: 'touch', clientX: 150 + direction * 100 });
    f.send('pointerup', { pointerType: 'touch', clientX: 150 + direction * 100 });
    assert.deepEqual(f.result, { accepted: direction > 0 ? 1 : 0, rejected: direction < 0 ? 1 : 0, active: false });
    assert.equal(f.send('click').prevented, true);
  }
});

test('losing the card capture cancels only the pointer that owns the gesture', () => {
  for (const ending of ['pointercancel', 'lostpointercapture']) {
    const f = fixture(); f.send('pointerdown'); f.send('pointermove', { clientX: 175 });
    f.send(ending, { pointerId: 2, target: f.card });
    assert.equal(f.result.active, true);
    f.send(ending, { target: f.card });
    f.send('pointerup', { clientX: 270 });
    assert.deepEqual(f.result, { accepted: 0, rejected: 0, active: false });
    assert.equal(f.styles.size, 0);
    assert.equal(f.send('click').prevented, true);
  }
});

test('horizontal swipe chooses one dinner or opens rejection; the following click cannot open a recipe', () => {
  for (const direction of [-1, 1]) {
    const f = fixture(); f.send('pointerdown');
    const movement = f.send('pointermove', { clientX: 150 + direction * 100, clientY: 105 });
    assert.equal(movement.prevented, false);
    assert.equal(f.label.textContent, direction > 0 ? 'Готовим' : 'Не подходит');
    assert.equal(f.classes.has('is-swiping'), true);
    f.send('pointerup', { clientX: 150 + direction * 100, clientY: 105 });
    assert.deepEqual(f.result, { accepted: direction > 0 ? 1 : 0, rejected: direction < 0 ? 1 : 0, active: false });
    assert.equal(f.styles.size, 0);
    const click = f.send('click'); assert.equal(click.prevented, true); assert.equal(click.stopped, true);
    f.send('pointerup'); assert.equal(f.result.accepted + f.result.rejected, 1);
  }
});

test('a short fast flick in either direction commits without a long slow drag', () => {
  for (const direction of [-1, 1]) {
    const f = fixture(); f.send('pointerdown', { timeStamp: 1000 });
    f.send('pointermove', { clientX: 150 + direction * 20, timeStamp: 1025 });
    f.send('pointermove', { clientX: 150 + direction * 48, timeStamp: 1055 });
    f.send('pointerup', { clientX: 150 + direction * 48, timeStamp: 1070 });
    assert.deepEqual(f.result, { accepted: direction > 0 ? 1 : 0, rejected: direction < 0 ? 1 : 0, active: false });
    assert.equal(f.send('click').prevented, true);
  }
});

test('vertical movement releases an initially horizontal drag without cancelling native scrolling', () => {
  for (const direction of [-1, 1]) {
    const f = fixture(); f.send('pointerdown');
    assert.equal(f.send('pointermove', { clientX: 170, clientY: 102 }).prevented, false);
    assert.equal(f.classes.has('is-swiping'), true);
    assert.equal(f.send('pointermove', { clientX: 174, clientY: 100 + direction * 40 }).prevented, false);
    assert.deepEqual(f.result, { accepted: 0, rejected: 0, active: false });
    assert.equal(f.classes.has('is-swiping'), false);
    f.send('pointermove', { clientX: 270, clientY: 100 + direction * 160 });
    f.send('pointerup', { clientX: 270, clientY: 100 + direction * 160 });
    assert.equal(f.send('click').prevented, true);
    assert.deepEqual(f.result, { accepted: 0, rejected: 0, active: false });
  }
});

test('frames display the latest position and cannot repaint a cancelled or released swipe', () => {
  const f = fixture(); f.send('pointerdown');
  f.send('pointermove', { clientX: 170 }, false);
  f.send('pointermove', { clientX: 190 }, false);
  f.flush(); assert.equal(f.styles.get('--dinner-swipe-x'), '40px');
  f.send('pointermove', { clientX: 210 }, false);
  f.send('pointercancel', {}, false); f.flush();
  assert.equal(f.styles.size, 0); assert.equal(f.classes.has('is-swiping'), false);
  f.send('pointerdown'); f.send('pointermove', { clientX: 260 }, false);
  f.send('pointerup', { clientX: 260 }, false); f.flush();
  assert.equal(f.styles.size, 0); assert.equal(f.classes.has('is-swiping'), false);
  assert.deepEqual(f.result, { accepted: 1, rejected: 0, active: false });
});

test('release coordinates still recognize a horizontal swipe without delivered move events', () => {
  for (const direction of [-1, 1]) for (const distance of [48, 110]) {
    const f = fixture(); f.send('pointerdown', { timeStamp: 1000 });
    f.send('pointerup', { clientX: 150 + direction * distance, clientY: 103, timeStamp: 1070 });
    assert.deepEqual(f.result, { accepted: direction > 0 ? 1 : 0, rejected: direction < 0 ? 1 : 0, active: false });
    assert.equal(f.send('click').prevented, true);
  }
});

test('short slow drags, tiny flicks, diagonals, a pause and reversing direction do not commit', () => {
  const paths = [
    [[48, 0, 300], [48, 0, 320]],
    [[25, 0, 20], [25, 0, 30]],
    [[48, 40, 40], [48, 40, 60]],
    [[48, 0, 40], [48, 0, 240]],
    [[120, 0, 30], [40, 0, 60], [40, 0, 70]],
  ];
  for (const path of paths) for (const direction of [-1, 1]) {
    const f = fixture(); f.send('pointerdown', { timeStamp: 1000 });
    path.forEach(([dx, dy, time], index) => f.send(index === path.length - 1 ? 'pointerup' : 'pointermove', { clientX: 150 + direction * dx, clientY: 100 + dy, timeStamp: 1000 + time }));
    assert.deepEqual(f.result, { accepted: 0, rejected: 0, active: false });
  }
});

test('recent speed recognizes a flick after holding the card and uses coalesced movement when available', () => {
  for (const coalesced of [false, true]) {
    const f = fixture(); f.send('pointerdown', { timeStamp: 1000 });
    if (!coalesced) f.send('pointermove', { clientX: 165, timeStamp: 2010 });
    f.send('pointermove', { clientX: 198, timeStamp: 2060, ...(coalesced ? { getCoalescedEvents: () => [{ clientX: 165, timeStamp: 2010 }] } : {}) });
    f.send('pointerup', { clientX: 198, timeStamp: 2070 });
    assert.deepEqual(f.result, { accepted: 1, rejected: 0, active: false });
  }
});

test('tap, short drag, vertical scroll and cancelled gesture never select or reject', () => {
  for (const [dx, dy, cancel] of [[0, 0, false], [35, 3, false], [10, 100, false], [100, 75, false], [120, 0, true]]) {
    const f = fixture(); f.send('pointerdown');
    f.send('pointermove', { clientX: 150 + dx, clientY: 100 + dy });
    f.send(cancel ? 'pointercancel' : 'pointerup', { clientX: 150 + dx, clientY: 100 + dy });
    assert.deepEqual(f.result, { accepted: 0, rejected: 0, active: false });
    assert.equal(f.classes.has('is-swiping'), false);
    if (!dx && !dy) assert.equal(f.send('click').prevented, false);
  }
});

test('swipes ignore action buttons, secondary pointers and gestures while a request is pending', () => {
  for (const blocked of ['button', 'secondary', 'pending', 'changed']) {
    const f = fixture();
    if (blocked === 'pending') f.disable();
    f.send('pointerdown', blocked === 'button' ? { target: { closest: () => ({ matches: () => false }) } } : blocked === 'secondary' ? { isPrimary: false } : {});
    f.send('pointermove', { clientX: 270 });
    if (blocked === 'changed') f.disable();
    f.send('pointerup', { clientX: 270 });
    assert.deepEqual(f.result, { accepted: 0, rejected: 0, active: false });
  }
});

test('dragging back cancels selection and a deliberate next tap remains available', () => {
  const f = fixture(); f.send('pointerdown');
  f.send('pointermove', { clientX: 270 });
  f.send('pointerup', { clientX: 156 });
  assert.deepEqual(f.result, { accepted: 0, rejected: 0, active: false });
  assert.equal(f.send('click').prevented, true);
  f.send('pointerdown'); f.send('pointerup');
  assert.equal(f.send('click').prevented, false);
});

test('right swipe selection blocks duplicates, uses notification routing and recovers on failure', async () => {
  const handler = source.slice(source.indexOf('async function acceptDinnerItem('), source.indexOf('\nasync function cookFromDinnerDetail'));
  for (const notification of [false, true]) for (const success of [false, true]) {
    const option = { id: 'b', recipe: { id: 'seed:b' } }, dinner = { recommendations: [{ id: 'a' }, option, { id: 'c' }], notificationId: notification ? 'notice' : null };
    let requests = 0, url, settle;
    const sandbox = { state: { dinner, recipes: [] }, dinnerPollTimer: null, clearTimeout() {}, dinnerView() {}, scheduleDinnerPrefetch() {}, toast() {},
      api(path) { requests++; url = path; return new Promise((resolve, reject) => { settle = () => success ? resolve({ status: 'accepted', savedRecipe: { id: 'saved' } }) : reject(new Error('offline')); }); } };
    vm.runInNewContext(handler, sandbox);
    const pending = sandbox.acceptDinnerItem(option);
    assert.equal(dinner.switching, true);
    assert.equal(await sandbox.acceptDinnerItem({ id: 'a' }), false);
    assert.equal(requests, 1);
    assert.equal(url, notification ? '/api/notifications/notice/select' : '/api/dinner/recommendations/b/accept');
    settle(); assert.equal(await pending, success);
    assert.equal(dinner.switching, false);
    assert.equal(Boolean(dinner.accepted), success);
    assert.equal(dinner.recommendations.length, 3);
    assert.equal(sandbox.state.recipes.length, success ? 1 : 0);
  }
});
