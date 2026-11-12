'use strict';

// Standalone VM fixtures: only load page-agent.js; no background worker, bridge or browser.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const test = require('node:test');
const pageSource = fs.readFileSync(path.join(__dirname, '..', 'page-agent.js'), 'utf8');

function pageHarness() {
  let nodes = [], hit = null;
  const timers = [], events = [];
  const document = {
    title: 'Interaction fixture', activeElement: null, addEventListener() {},
    getElementById: () => null, elementFromPoint: () => hit,
    querySelectorAll: selector => selector.startsWith('input,textarea,select,button,a,') ? nodes :
      selector === 'button,input' ? nodes.filter(node => ['BUTTON', 'INPUT'].includes(node.tagName)) : []
  };
  class SyntheticEvent {
    constructor(type, init = {}) { Object.assign(this, init); this.type = type; this.defaultPrevented = false; }
    preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
  }
  class Element {
    constructor(tag, attrs = {}) {
      this.tagName = tag.toUpperCase(); this.attrs = attrs; this.isConnected = true;
      this.innerText = ''; this.textContent = ''; this.value = ''; this.parentElement = null;
      this.type = attrs.type || (tag === 'button' ? 'submit' : 'text');
      this.handlers = {}; this.clicks = 0; this.form = null;
    }
    getAttribute(name) { return this.attrs[name] ?? null; }
    hasAttribute(name) { return Object.hasOwn(this.attrs, name); }
    matches(selector) {
      return selector.split(',').some(part => {
        part = part.trim();
        if (part === ':disabled') return Boolean(this.disabled || this.disabledByFieldset);
        if (part === this.tagName.toLowerCase()) return true;
        if (part === 'a[href]') return this.tagName === 'A' && this.hasAttribute('href');
        const inputType = /^input\[type=([^\]]+)\]$/.exec(part);
        return Boolean(inputType && this.tagName === 'INPUT' && this.type === inputType[1]);
      });
    }
    closest(selector) {
      for (let node = this; node; node = node.parentElement) {
        if ((selector.includes('[hidden]') && node.hasAttribute('hidden')) ||
            (selector.includes('[inert]') && node.hasAttribute('inert')) ||
            (selector.includes('[aria-disabled="true"]') && node.getAttribute('aria-disabled') === 'true')) return node;
      }
      return null;
    }
    getClientRects() { return [{ left: 10, right: 110, top: 10, bottom: 30, width: 100, height: 20 }]; }
    querySelectorAll() { return nodes.filter(node => node !== this && this.contains(node) && node.tagName === 'BUTTON'); }
    contains(other) { for (let node = other; node; node = node.parentElement) if (node === this) return true; return false; }
    focus() { document.activeElement = this; }
    dispatchEvent(event) {
      events.push({ target: this, type: event.type, detail: event.detail, buttons: event.buttons });
      this.handlers[event.type]?.(event);
      return !event.defaultPrevented;
    }
    click() {
      if (this.matches(':disabled')) return;
      this.clicks++;
      if (!this.dispatchEvent(new SyntheticEvent('click', { cancelable: true }))) return;
      // Model native activation at the boundary so tests can detect a lost submitter.
      if (this.form && ['submit', 'image'].includes(this.type)) this.form.requestSubmit(this);
      if (this.form && this.type === 'reset') this.form.resets++;
    }
  }
  class HTMLInputElement extends Element { constructor(attrs) { super('input', attrs); } }
  class HTMLTextAreaElement extends Element { constructor() { super('textarea'); } }
  class HTMLSelectElement extends Element { constructor() { super('select'); } }
  document.body = new Element('body');
  const context = vm.createContext({
    Element, HTMLInputElement, HTMLTextAreaElement, HTMLSelectElement, document,
    Event: SyntheticEvent, KeyboardEvent: SyntheticEvent, MouseEvent: SyntheticEvent, PointerEvent: SyntheticEvent,
    location: { href: 'https://example.test/' }, innerHeight: 800, innerWidth: 1200,
    getComputedStyle: element => ({ display: element.attrs.display || 'block', visibility: 'visible', opacity: '1' }),
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }
  });
  context.window = context;
  vm.runInContext(pageSource, context);
  return {
    Element, HTMLInputElement, HTMLTextAreaElement, document, timers, events,
    agent: context.__aiBrowserPageAgent8,
    setNodes(items) { nodes = items; }, setHit(node) { hit = node; },
    form() {
      const form = new Element('form');
      form.submissions = []; form.resets = 0;
      form.requestSubmit = submitter => form.submissions.push(submitter);
      return form;
    }
  };
}

async function pointerFixture() {
  const h = pageHarness();
  const row = new h.Element('article'); row.innerText = 'Flight F001';
  const target = new h.Element('button'); target.innerText = 'Book'; target.parentElement = row;
  h.setNodes([target]); h.setHit(target);
  const snapshot = await h.agent.snapshot({ load: 'current' });
  assert.equal(snapshot.__zcodeError, undefined);
  return { h, row, target, ref: snapshot.elements[0].ref, point: { x: 60, y: 20 } };
}

for (const phase of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'hold']) {
  for (const button of ['left', 'right']) {
    test('pointerClick blocks reused business identity after ' + phase + ' (' + button + ') and releases', async () => {
      const { h, row, target, ref, point } = await pointerFixture();
      if (phase !== 'hold') target.handlers[phase] = () => { row.innerText = 'Flight F999'; };
      const pending = h.agent.pointerClick({ ref, point, button, clickCount: 2, holdMs: phase === 'hold' ? 500 : 0 });
      if (phase === 'hold') {
        assert.equal(h.timers.length, 1);
        assert.equal(h.timers[0].ms, 500);
        row.innerText = 'Flight F999';
        h.timers[0].fn();
      }
      const result = await pending;
      assert.equal(target.isConnected, true);
      assert.equal(result.__zcodeCode, 'TARGET_CHANGED');
      assert(!h.events.some(event => ['click', 'contextmenu', 'dblclick'].includes(event.type)));
      assert.deepEqual(h.events.slice(-2).map(event => [event.type, event.buttons]), [['pointerup', 0], ['mouseup', 0]]);
      if (phase === 'pointerdown') assert(!h.events.some(event => event.type === 'mousedown'));
    });
  }
}

for (const mutation of ['disabled', 'inert', 'aria-disabled', 'hidden', 'display', 'obscured']) {
  test('pointerClick blocks non-interactable target after mousedown: ' + mutation, async () => {
    const { h, row, target, ref, point } = await pointerFixture();
    target.handlers.mousedown = () => {
      if (mutation === 'disabled') target.disabled = true;
      else if (mutation === 'inert') row.attrs.inert = '';
      else if (mutation === 'aria-disabled') row.attrs['aria-disabled'] = 'true';
      else if (mutation === 'hidden') target.attrs.hidden = '';
      else if (mutation === 'display') target.attrs.display = 'none';
      else h.setHit(new h.Element('div'));
    };
    const result = await h.agent.pointerClick({ ref, point });
    assert(result.__zcodeError);
    assert(!h.events.some(event => ['click', 'contextmenu', 'dblclick'].includes(event.type)));
    assert.deepEqual(h.events.slice(-2).map(event => event.type), ['pointerup', 'mouseup']);
  });
}

for (const count of [1, 2]) {
  test('double click rechecks identity after click ' + count, async () => {
    const { h, row, target, ref, point } = await pointerFixture();
    target.handlers.click = event => { if (event.detail === count) row.innerText = 'Flight F999'; };
    const result = await h.agent.pointerClick({ ref, point, clickCount: 2 });
    assert.equal(result.__zcodeCode, 'TARGET_CHANGED');
    assert.equal(h.events.filter(event => event.type === 'click').length, count);
    assert.equal(h.events.filter(event => event.type === 'pointerdown').length, count);
    assert(!h.events.some(event => event.type === 'dblclick'));
  });
}

test('pointerClick stops when an originally hit child is replaced inside a stable ref', async () => {
  const { h, target, ref, point } = await pointerFixture();
  const child = new h.Element('span'); child.parentElement = target; h.setHit(child);
  child.handlers.mousedown = () => {
    child.isConnected = false; child.parentElement = null; h.setHit(target);
  };
  const result = await h.agent.pointerClick({ ref, point });
  assert.equal(result.__zcodeCode, 'TARGET_CHANGED');
  assert(!h.events.some(event => event.type === 'click'));
});

test('stable special clicks preserve event details and long press does not add click', async () => {
  for (const [button, clickCount, holdMs, expected] of [
    ['left', 2, 0, ['click', 'click', 'dblclick']],
    ['right', 1, 0, ['contextmenu']],
    ['left', 1, 500, []],
    ['right', 1, 500, ['contextmenu']]
  ]) {
    const { h, ref, point } = await pointerFixture();
    const pending = h.agent.pointerClick({ ref, point, button, clickCount, holdMs });
    if (holdMs) h.timers[0].fn();
    const result = await pending;
    assert.equal(result.__zcodeError, undefined);
    assert.deepEqual(h.events.filter(event => ['click', 'dblclick', 'contextmenu'].includes(event.type)).map(event => event.type), expected);
    assert.deepEqual(h.events.filter(event => event.type === 'click').map(event => event.detail), button === 'left' && !holdMs ? [1, 2] : []);
  }
});

for (const type of ['button', 'reset', 'submit', 'image']) {
  test('Enter activates input type=' + type + ' with its own submitter', async () => {
    const h = pageHarness(), form = h.form(), input = new h.HTMLInputElement({ type });
    input.form = form; input.value = 'keep-value'; input.attrs.formaction = '/specific';
    h.setNodes([input]); input.focus();
    const result = await h.agent.domPress('Enter');
    assert.equal(result.__zcodeError, undefined);
    assert.equal(input.clicks, 1);
    assert.deepEqual(form.submissions, ['submit', 'image'].includes(type) ? [input] : []);
    assert.equal(form.resets, type === 'reset' ? 1 : 0);
  });
}

test('Enter activates an input button outside a form and respects canceled keydown', async () => {
  const h = pageHarness(), input = new h.HTMLInputElement({ type: 'button' }); input.focus();
  await h.agent.domPress('Enter');
  assert.equal(input.clicks, 1);
  input.handlers.keydown = event => event.preventDefault();
  await h.agent.domPress('Enter');
  assert.equal(input.clicks, 1);
  assert.equal(h.events.at(-1).type, 'keyup');
});

for (const defaultType of ['button', 'submit', 'image']) {
  test('text Enter activates the first form-associated default submitter: ' + defaultType, async () => {
    const h = pageHarness(), form = h.form(), other = h.form();
    const unrelated = new h.Element('button'); unrelated.form = other;
    const input = new h.HTMLInputElement(); input.form = form;
    const first = defaultType === 'button' ? new h.Element('button') : new h.HTMLInputElement({ type: defaultType });
    first.form = form; first.attrs.form = 'external-owner';
    first.attrs.name = 'action'; first.value = 'save'; first.attrs.formaction = '/save';
    const second = new h.Element('button'); second.form = form;
    // The first submitter is outside the form and precedes the text input in document order.
    h.setNodes([unrelated, first, input, second]); input.focus();
    await h.agent.domPress('Enter');
    assert.equal(first.clicks, 1); assert.equal(second.clicks, 0); assert.equal(unrelated.clicks, 0);
    assert.deepEqual(form.submissions, [first]);
  });
}

test('disabled default submitter blocks implicit submission without falling through', async () => {
  for (const disabledByFieldset of [false, true]) {
    const h = pageHarness(), form = h.form(), input = new h.HTMLInputElement(); input.form = form;
    const first = new h.Element('button'); first.form = form;
    first.disabled = !disabledByFieldset; first.disabledByFieldset = disabledByFieldset;
    const second = new h.Element('button'); second.form = form;
    h.setNodes([input, first, second]); input.focus();
    await h.agent.domPress('Enter');
    assert.equal(first.clicks, 0); assert.equal(second.clicks, 0); assert.deepEqual(form.submissions, []);
  }
});

test('default submitter click handler can cancel implicit submission', async () => {
  const h = pageHarness(), form = h.form(), input = new h.HTMLInputElement(); input.form = form;
  const button = new h.Element('button'); button.form = form; button.handlers.click = event => event.preventDefault();
  h.setNodes([input, button]); input.focus();
  await h.agent.domPress('Enter');
  assert.equal(button.clicks, 1); assert.deepEqual(form.submissions, []);
});

test('implicit submit without a button requires a single blocking input', async () => {
  for (const extraType of [null, 'hidden', 'button', 'text', 'password', 'date', 'datetime-local', 'number']) {
    const h = pageHarness(), form = h.form(), input = new h.HTMLInputElement(); input.form = form;
    const nodes = [input];
    if (extraType) { const extra = new h.HTMLInputElement({ type: extraType }); extra.form = form; nodes.push(extra); }
    h.setNodes(nodes); input.focus();
    await h.agent.domPress('Enter');
    assert.deepEqual(form.submissions, [null, 'hidden', 'button'].includes(extraType) ? [undefined] : []);
  }
});

test('non-text inputs and textarea do not implicitly submit; modified Enter stays synthetic', async () => {
  for (const type of ['range', 'color', 'file', 'hidden', 'textarea']) {
    const h = pageHarness(), form = h.form();
    const input = type === 'textarea' ? new h.HTMLTextAreaElement() : new h.HTMLInputElement({ type });
    input.form = form; h.setNodes([input]); input.focus();
    await h.agent.domPress('Enter');
    assert.deepEqual(form.submissions, []);
  }
  const h = pageHarness(), form = h.form(), input = new h.HTMLInputElement(); input.form = form;
  h.setNodes([input]); input.focus();
  await h.agent.domPress('Control+Enter');
  assert.deepEqual(form.submissions, []);
  assert.deepEqual(h.events.map(event => event.type), ['keydown', 'keyup']);
});
