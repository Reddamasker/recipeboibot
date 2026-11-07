import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function fixture({ reduced = false, hidden = false, background = false } = {}) {
  const element = () => ({
    events: {}, classes: new Set(), style: { setProperty() {} },
    addEventListener(name, callback) { this.events[name] = callback; },
    getBoundingClientRect() { return { left: 10, top: 100, width: 70, height: 100 }; },
    get classList() { return { add: (...names) => names.forEach(name => this.classes.add(name)), remove: (...names) => names.forEach(name => this.classes.delete(name)) }; }
  });
  const showcase = element(), bot = element(), replay = element(), row = element(), share = element();
  showcase.querySelectorAll = () => [element(), element(), element(), element()];
  showcase.querySelector = () => row;
  const root = { hidden, getClientRects: () => hidden ? [] : [{}], querySelector: () => showcase };
  const document = { visibilityState: background ? 'hidden' : 'visible', events: {},
    getElementById: id => ({ landing: root, 'lp-flow-bot': bot, 'lp-flow-replay': replay, 'lp-demo-share': share })[id],
    addEventListener(name, callback) { this.events[name] = callback; } };
  const motion = { matches: reduced, addEventListener(_name, callback) { this.change = callback; } };
  let intersection, observed;
  vm.runInNewContext(fs.readFileSync('public/landing.js', 'utf8'), {
    document, window: { matchMedia: () => motion },
    IntersectionObserver: class { constructor(callback) { intersection = callback; } observe(target) { observed = target; } }
  });
  return { showcase, bot, replay, row, document, motion, observed,
    intersect: ratio => intersection([{ isIntersecting: ratio > 0, intersectionRatio: ratio }]),
    playing: () => showcase.classes.has('is-playing') };
}

test('landing waits for the receiving bot, plays once automatically and supports replay', () => {
  const page = fixture();
  assert.equal(page.observed, page.bot);
  page.intersect(.9); assert.equal(page.playing(), false);
  page.intersect(1); assert.equal(page.playing(), true);
  page.row.events.animationend({ animationName: 'lp-row-appear' });
  assert.equal(page.playing(), false); assert.equal(page.showcase.classes.has('is-complete'), true);
  page.intersect(0); page.intersect(1); assert.equal(page.playing(), false);
  page.replay.events.click(); assert.equal(page.playing(), true);
});

test('hidden landing and background tab do not consume the automatic animation', () => {
  const hidden = fixture({ hidden: true }); hidden.intersect(1); assert.equal(hidden.playing(), false);
  const background = fixture({ background: true }); background.intersect(1); assert.equal(background.playing(), false);
  background.document.visibilityState = 'visible'; background.document.events.visibilitychange();
  assert.equal(background.playing(), true);
});

test('reduced motion shows the complete result and can interrupt or re-enable motion', () => {
  const page = fixture({ reduced: true }); page.intersect(1);
  assert.equal(page.playing(), false); assert.equal(page.replay.hidden, true);
  assert.equal(page.showcase.classes.has('is-complete'), true);
  page.motion.matches = false; page.motion.change(); assert.equal(page.playing(), true);
  assert.equal(page.replay.hidden, false);
  page.motion.matches = true; page.motion.change(); assert.equal(page.playing(), false);
  assert.equal(page.showcase.classes.has('is-complete'), true);
});
