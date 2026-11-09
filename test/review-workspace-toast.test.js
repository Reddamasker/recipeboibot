import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const shell = fs.readFileSync(new URL('../public/review/recime-20261109/shell.js', import.meta.url), 'utf8');
const confirmationCode = shell.slice(shell.indexOf('  function stopWorkspaceConfirmation('), shell.indexOf('  async function workspaceRequest('));

function harness() {
  let now = 10000, nextId = 0, blocked = false;
  const tasks = new Map(), events = [], listeners = {}, shown = [];
  const classes = new Set();
  const style = {display: 'block', visibility: 'visible', opacity: '1', pointerEvents: 'none'};
  const rect = {left: 30, top: 600, right: 290, bottom: 650, width: 260, height: 50};
  const ui = {visibleOutcomes: [], toastObservation: null};
  const toastEl = {isConnected: true, textContent: '', classList: {contains: value => classes.has(value)}, getBoundingClientRect: () => rect};
  const document = {visibilityState: 'visible', querySelector: () => blocked ? {} : null, addEventListener: (name, handler) => {listeners[name] = handler;}};
  const schedule = (callback, delay) => {const id = ++nextId; tasks.set(id, {callback, at: now + delay}); return id;};
  const sandbox = {
    ui, toastEl, document, Date: {now: () => now}, performance: {now: () => now}, innerWidth: 320, innerHeight: 700,
    getComputedStyle: () => style, currentFeature: () => null,
    analyticsStep: feature => feature === 'collections' ? 'collection' : 'other',
    window: {RecipeAnalytics: {event: (...event) => events.push(event)}},
    requestAnimationFrame: callback => schedule(callback, 16), cancelAnimationFrame: id => tasks.delete(id),
    setTimeout: schedule, clearTimeout: id => tasks.delete(id),
    toast: message => {shown.push(message); toastEl.textContent = message; classes.add('show');},
  };
  vm.runInNewContext(confirmationCode, sandbox);
  function advance(ms) {
    const target = now + ms;
    while (true) {
      const due = [...tasks].filter(([, task]) => task.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      tasks.delete(due[0]); now = due[1].at; due[1].callback();
    }
    now = target;
  }
  const flow = (id = 'flow-1') => ({id, feature: 'collections', action: 'collections.create', started: 9900, startedWall: 9900, opened: 9800});
  return {ui, events, shown, style, rect, toastEl, classes, tasks, advance, flow,
    success: value => sandbox.actionEvent(value, 'success'),
    block: value => {blocked = value;},
    visibility: value => {document.visibilityState = value; listeners.visibilitychange();},
  };
}

test('workspace success observes pointer-transparent toast only after its transition and records actual visible latency', () => {
  const h = harness(), flow = h.flow();
  h.style.opacity = '.94'; h.success(flow); h.advance(120);
  assert.equal(h.events.length, 0);
  h.style.opacity = '1'; h.advance(80);
  assert.equal(h.events.length, 1);
  const [event, step, detail] = h.events[0];
  assert.equal(event, 'workspace_action'); assert.equal(step, 'collection');
  assert.equal(detail.outcome, 'success'); assert.equal(detail.flowId, flow.id);
  assert.ok(detail.durationMs >= 220 && detail.durationMs <= 300);
  assert.deepEqual(Object.keys(detail).sort(), ['action', 'durationMs', 'feature', 'flowId', 'outcome']);
  assert.equal(h.style.pointerEvents, 'none');
  h.success(flow); h.advance(4000);
  assert.equal(h.events.length, 1); assert.equal(h.tasks.size, 0);
});

test('hidden workspace successes retain only latest flow and explicitly show it on return with hidden time included', () => {
  const h = harness(); h.visibility('hidden');
  h.success(h.flow('older')); h.success(h.flow('latest')); h.advance(10000);
  assert.equal(h.events.length, 0); assert.equal(h.shown.length, 0);
  h.visibility('visible'); assert.equal(h.shown.length, 1); h.advance(20);
  assert.equal(h.events.length, 1); assert.equal(h.events[0][2].flowId, 'latest');
  assert.ok(h.events[0][2].durationMs > 10000);
});

test('catalog picker uses its visible inline confirmation instead of a hidden toast behind the dialog', () => {
  const h = harness(), flow = h.flow();
  flow.inlineConfirmation = true;
  h.success(flow); h.advance(4000);
  assert.equal(h.events.length, 0); assert.equal(h.shown.length, 0);
  // A retry after the picker was closed returns to the ordinary visible toast.
  flow.inlineConfirmation = false;
  h.success(flow); h.advance(50);
  assert.equal(h.events.length, 1);
});

test('hiding during toast transition defers observation and shows a fresh confirmation on return', () => {
  const h = harness(); h.style.opacity = '.2'; h.success(h.flow()); h.advance(20);
  h.visibility('hidden'); h.advance(5000);
  assert.equal(h.events.length, 0); assert.equal(h.tasks.size, 0);
  h.style.opacity = '1'; h.visibility('visible'); h.advance(20);
  assert.equal(h.shown.length, 2); assert.equal(h.events.length, 1);
  assert.ok(h.events[0][2].durationMs >= 5100);
});

test('modal or overlay blocks success, but closing it before toast expiry permits actual observation', () => {
  const h = harness(); h.block(true); h.success(h.flow()); h.advance(650);
  assert.equal(h.events.length, 0);
  h.block(false); h.advance(100);
  assert.equal(h.events.length, 1); assert.ok(h.events[0][2].durationMs >= 750);
});

test('unseen toast expires after bounded polling without generating a success later', () => {
  const h = harness(); h.block(true); h.success(h.flow()); h.advance(4000);
  assert.equal(h.events.length, 0); assert.equal(h.tasks.size, 0); assert.equal(h.ui.toastObservation, null);
  h.block(false); h.advance(100);
  assert.equal(h.events.length, 0);
});

test('offscreen, detached, hidden and replaced confirmations cannot produce visible successes', () => {
  for (const mutate of [
    h => {h.rect.left = 400; h.rect.right = 660;},
    h => {h.toastEl.isConnected = false;},
    h => {h.style.display = 'none';},
    h => {h.style.visibility = 'hidden';},
    h => {h.classes.delete('show');},
    h => {h.toastEl.textContent = 'Другое сообщение';},
  ]) {
    const h = harness(); h.success(h.flow()); mutate(h); h.advance(4000);
    assert.equal(h.events.length, 0); assert.equal(h.tasks.size, 0);
  }
});

test('replacing a pending confirmation observes only the latest action once', () => {
  const h = harness(); h.style.opacity = '.3'; h.success(h.flow('older')); h.advance(20);
  h.success(h.flow('latest')); h.style.opacity = '1'; h.advance(4000);
  assert.equal(h.events.length, 1); assert.equal(h.events[0][2].flowId, 'latest'); assert.equal(h.tasks.size, 0);
});
