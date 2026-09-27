import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// A small DOM fixture exercises the modal lifecycle without browser or npm dependencies.
function modalFixture() {
  const listeners = new Map();
  const all = [];
  const document = {
    activeElement: null,
    addEventListener(type, callback) { const set = listeners.get(type) || new Set(); set.add(callback); listeners.set(type, set); },
    removeEventListener(type, callback) { listeners.get(type)?.delete(callback); },
    querySelectorAll(selector) { const attr = selector.slice(1, -1); return all.filter((el) => el.isConnected && el.hasAttribute(attr)); },
  };
  function element(tagName = 'DIV', attributes = {}) {
    const el = {
      tagName, attributes: { ...attributes }, children: [], parentElement: null, isConnected: true, inert: false,
      disabled: false, tabIndex: tagName === 'BUTTON' ? 0 : -1,
      get id() { return this.attributes.id || ''; }, set id(value) { this.attributes.id = value; },
      setAttribute(key, value) { this.attributes[key] = value; },
      getAttribute(key) { return this.attributes[key] ?? null; },
      hasAttribute(key) { return Object.hasOwn(this.attributes, key); },
      append(child) { child.parentElement = this; this.children.push(child); },
      remove() { this.isConnected = false; if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((child) => child !== this); },
      contains(target) { return target === this || this.children.some((child) => child.contains(target)); },
      closest() { return this.inert || this.hasAttribute('hidden') ? this : this.parentElement?.closest() || null; },
      getClientRects() { return this.isConnected ? [{}] : []; },
      querySelector(selector) { return selector.startsWith('h1') ? this.children.find((child) => ['H1', 'H2'].includes(child.tagName)) || null : null; },
      querySelectorAll() { return this.children; },
      focus() { if (this.closest()) return; document.activeElement = this; for (const callback of listeners.get('focusin') || []) callback({ target: this }); },
    };
    all.push(el); return el;
  }
  const body = document.body = element('BODY');
  const root = element(), toastEl = element(); body.append(root); body.append(toastEl);
  const opener = element('BUTTON', { id: 'open-recipe' }); root.append(opener); opener.focus();
  const source = fs.readFileSync('public/app.js', 'utf8');
  const handler = source.slice(source.indexOf('const modalStack = []'), source.indexOf('\nfunction importSheet()'));
  const sandbox = { document, root, toastEl };
  vm.runInNewContext(handler, sandbox);
  function modal() {
    const dialog = element(), heading = element('H2'), first = element('BUTTON'), last = element('BUTTON');
    dialog.append(heading); dialog.append(first); dialog.append(last);
    sandbox.mountModal(dialog, dialog, () => sandbox.unmountModal(dialog));
    return { dialog, heading, first, last };
  }
  function key(key, shiftKey = false) {
    const event = { key, shiftKey, prevented: false, preventDefault() { this.prevented = true; }, stopPropagation() {} };
    for (const callback of [...listeners.get('keydown') || []]) callback(event);
    return event;
  }
  return { sandbox, document, root, toastEl, opener, element, modal, key, listeners };
}

test('modal names itself, confines keyboard focus, dismisses with Escape and restores the opener', () => {
  const f = modalFixture(), m = f.modal();
  assert.equal(m.dialog.getAttribute('role'), 'dialog');
  assert.equal(m.dialog.getAttribute('aria-modal'), 'true');
  assert.equal(m.dialog.getAttribute('aria-labelledby'), m.heading.id);
  assert.equal(f.document.activeElement, m.heading);
  assert.equal(f.root.inert, true);
  assert.equal(f.toastEl.inert, false, 'errors remain available in the live region');
  assert.equal(f.key('Tab').prevented, true);
  assert.equal(f.document.activeElement, m.first);
  f.key('Tab', true); assert.equal(f.document.activeElement, m.last);
  f.key('Tab'); assert.equal(f.document.activeElement, m.first);
  f.key('Escape');
  assert.equal(m.dialog.isConnected, false);
  assert.equal(f.root.inert, false);
  assert.equal(f.document.activeElement, f.opener);
  assert.equal(f.listeners.get('keydown').size, 0);
  assert.equal(f.listeners.get('focusin').size, 0);
});

test('nested cooking dialog restores its parent and preserves originally inert content', () => {
  const f = modalFixture();
  const alreadyInert = f.element(); alreadyInert.inert = true; f.document.body.append(alreadyInert);
  const recipe = f.modal(); recipe.last.focus();
  const cooking = f.modal();
  assert.equal(recipe.dialog.inert, true);
  f.key('Escape');
  assert.equal(cooking.dialog.isConnected, false);
  assert.equal(recipe.dialog.isConnected, true);
  assert.equal(recipe.dialog.inert, false);
  assert.equal(f.root.inert, true);
  assert.equal(f.document.activeElement, recipe.last);
  f.key('Escape');
  assert.equal(f.root.inert, false);
  assert.equal(alreadyInert.inert, true);
  assert.equal(f.document.activeElement, f.opener);
});

test('modal focus survives a background repaint and handles a dialog with no enabled controls', () => {
  const f = modalFixture(), m = f.modal();
  f.opener.remove();
  const replacement = f.element('BUTTON', { id: 'open-recipe' }); f.root.append(replacement);
  m.first.disabled = true; m.last.disabled = true;
  f.key('Tab'); assert.equal(f.document.activeElement, m.dialog);
  f.key('Escape'); assert.equal(f.document.activeElement, replacement);
});

test('closing the recipe underneath cooking cleans up both dialog listeners and restores background', () => {
  const f = modalFixture(), recipe = f.modal(), cooking = f.modal();
  f.sandbox.unmountModal(recipe.dialog);
  assert.equal(recipe.dialog.isConnected, false);
  assert.equal(cooking.dialog.isConnected, false);
  assert.equal(f.root.inert, false);
  assert.equal(f.document.activeElement, f.opener);
  assert.equal(f.listeners.get('keydown').size, 0);
});

test('cooking keeps navigation focus across live step updates and only completes on Done', () => {
  const source = fs.readFileSync('public/app.js', 'utf8');
  const handler = source.slice(source.indexOf('function cookMode('), source.indexOf('\nfunction settingsSheet()'));
  const controls = Object.fromEntries(['.cook-step', '#cook-progress', '#cook-close', '#prev', '#next'].map((key) => [key, { textContent: '', disabled: false, focus() { document.activeElement = this; } }]));
  const element = { innerHTML: '', attributes: {}, setAttribute(key, value) { this.attributes[key] = value; }, querySelector(key) { return controls[key]; } };
  const document = { activeElement: null, createElement: () => element };
  let closes = 0, completed = 0, dismiss;
  const sandbox = { document, state: {}, mountModal(el, dialog, onDismiss, initialFocus) { assert.equal(el, dialog); dismiss = onDismiss; initialFocus.focus(); }, unmountModal() { closes++; } };
  vm.runInNewContext(handler, sandbox);
  sandbox.cookMode({ title: 'Ужин', steps: [{ text: 'Нарежьте овощи' }, { text: 'Потушите овощи' }] }, () => { completed++; });
  assert.equal(element.attributes['aria-label'], 'Готовим: Ужин');
  assert.match(element.innerHTML, /aria-live="polite" aria-atomic="true"/);
  assert.equal(document.activeElement, controls['.cook-step']);
  assert.equal(controls['#prev'].disabled, true);
  controls['#next'].focus(); controls['#next'].onclick();
  assert.equal(document.activeElement, controls['#next']);
  assert.equal(controls['.cook-step'].textContent, 'Потушите овощи');
  assert.equal(controls['#cook-progress'].textContent, 'Шаг 2 из 2');
  controls['#prev'].focus(); controls['#prev'].onclick();
  assert.equal(document.activeElement, controls['#next'], 'disabled Back must not keep focus');
  assert.equal(controls['.cook-step'].textContent, 'Нарежьте овощи');
  dismiss(); assert.equal(closes, 1); assert.equal(completed, 0);
  sandbox.cookMode({ title: 'Ужин', steps: [{ text: 'Нарежьте овощи' }] }, () => { completed++; });
  controls['#next'].onclick(); assert.equal(closes, 2); assert.equal(completed, 1);
});
