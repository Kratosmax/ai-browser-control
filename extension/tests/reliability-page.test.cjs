'use strict';

// Reuse only the DOM fixture; all identity, pagination and dispatch code is the real agent.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const test = require('node:test');
const harnessPath = path.join(__dirname, 'snapshot-query.test.cjs');
let harnessSource = fs.readFileSync(harnessPath, 'utf8').split('\nconst snapshot =')[0];
if (process.env.QA_PAGE_AGENT_SOURCE) harnessSource = harnessSource.replace(
  "fs.readFileSync(path.join(__dirname, '..', 'page-agent.js'), 'utf8')",
  'fs.readFileSync(' + JSON.stringify(process.env.QA_PAGE_AGENT_SOURCE) + ", 'utf8')");
const harnessModule = new Module(harnessPath, module);
harnessModule.filename = harnessPath;
harnessModule.paths = module.paths;
harnessModule._compile(harnessSource + '\nmodule.exports = pageHarness;', harnessPath);
const pageHarness = harnessModule.exports;
const ok = result => { assert.equal(result.__zcodeError, undefined, JSON.stringify(result)); return result; };
const snap = (h, options = {}) => h.agent.snapshot({ load: 'current', ...options }).then(ok);

function events(h) {
  const log = [];
  class SyntheticEvent {
    constructor(type, init = {}) { Object.assign(this, init); this.type = type; this.defaultPrevented = false; }
    preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
  }
  for (const name of ['Event', 'MouseEvent', 'PointerEvent', 'DragEvent']) h.context[name] = SyntheticEvent;
  h.context.DataTransfer = class {};
  h.context.Element.prototype.dispatchEvent = function (event) {
    log.push({ element: this, type: event.type });
    this.handlers?.[event.type]?.(event);
    return !event.defaultPrevented;
  };
  return log;
}

const semanticMutations = {
  'text input becomes password': h => { const element = h.node('input', { 'aria-label': 'Account field' }); return { element, mutate: () => { element.type = 'password'; } }; },
  'submit button becomes reset': h => { const element = h.node('button', {}, 'Continue'); return { element, mutate: () => { element.type = 'reset'; } }; },
  'form owner changes without visible context change': h => { const element = h.node('button', {}, 'Continue'); element.form = h.node('form'); return { element, mutate: () => { element.form = h.node('form'); } }; },
  'form destination changes': h => { const element = h.node('button', {}, 'Continue'); element.form = h.node('form'); element.form.action = '/preview'; return { element, mutate: () => { element.form.action = '/submit'; } }; },
  'submit override changes': h => { const element = h.node('button', { formaction: '/preview' }, 'Continue'); return { element, mutate: () => { element.attrs.formaction = '/submit'; } }; },
  'popup ownership changes': h => { const element = h.node('button', { 'aria-controls': 'first', 'aria-haspopup': 'menu' }, 'Actions'); return { element, mutate: () => { element.attrs['aria-controls'] = 'second'; } }; },
  'link destination changes': h => { const element = h.node('a', { href: '/preview' }, 'Continue'); return { element, mutate: () => { element.attrs.href = '/submit'; } }; },
  'ARIA label changes': h => { const element = h.node('button', { 'aria-label': 'Preview' }, 'Continue'); return { element, mutate: () => { element.attrs['aria-label'] = 'Submit'; } }; },
  'referenced label changes': h => { const label = h.node('label', { id: 'label' }, 'Preview'); const element = h.node('input', { 'aria-labelledby': 'label' }); return { element, mutate: () => { label.innerText = 'Submit'; } }; }
};
for (const [name, setup] of Object.entries(semanticMutations)) {
  test('action identity rejects ' + name + ' across prepare, inspect, wait and cursor', async () => {
    const h = pageHarness(); const { element, mutate } = setup(h);
    h.node('button', {}, 'Other');
    const first = await snap(h, { limit: 1 }); const item = first.elements[0];
    assert.equal(item.tag, element.tagName.toLowerCase());
    mutate();
    assert.equal(ok(await h.agent.inspect(item.ref)).identityChanged, true);
    assert.equal((await h.agent.prepare(item.ref)).__zcodeCode, 'TARGET_CHANGED');
    assert.equal((await h.agent.waitFor({ ref: item.ref, timeoutMs: 0 })).__zcodeCode, 'TARGET_CHANGED');
    assert.equal((await h.agent.snapshot({ cursor: first.pagination.nextCursor })).__zcodeCode, 'SNAPSHOT_CHANGED');
  });
}

test('same-URL document root replacement expires refs, waits and cursors even if a node is reattached', async () => {
  const h = pageHarness(); h.node('button', {}, 'Keep'); h.node('button', {}, 'Other');
  const first = await snap(h, { limit: 1 }), ref = first.elements[0].ref;
  // document.open/write may preserve the isolated global while replacing the DOM tree.
  const root = new h.context.Element('html'); root.append(h.document.body);
  h.document.documentElement = root;
  assert.equal((await h.agent.prepare(ref)).__zcodeCode, 'STALE_REF');
  assert.equal((await h.agent.inspect(ref)).__zcodeCode, 'STALE_REF');
  assert.equal((await h.agent.waitFor({ ref, timeoutMs: 0 })).__zcodeCode, 'STALE_REF');
  assert.equal((await h.agent.snapshot({ cursor: first.pagination.nextCursor })).__zcodeCode, 'STALE_CURSOR');
  ok(await h.agent.prepare((await snap(h)).elements[0].ref));
});

test('ref wait checks navigation before accepting a still-connected target', async () => {
  const h = pageHarness(); h.node('button', {}, 'Keep'); const first = await snap(h);
  h.context.location.href += '?route=other';
  assert.equal((await h.agent.waitFor({ ref: first.elements[0].ref, timeoutMs: 0 })).__zcodeCode, 'STALE_REF');
});

async function dragFixture() {
  const h = pageHarness(), log = events(h);
  const source = h.node('div', { draggable: 'true' }, 'Move item');
  const target = h.node('div', { ondrop: 'fixture()' }, 'Destination');
  source.handlers = {}; target.handlers = { dragover: event => event.preventDefault() };
  const page = await snap(h);
  h.document.elementFromPoint = x => x < 100 ? source : target;
  return { h, log, source, target, args: {
    fromRef: page.elements.find(item => item.name === 'Move item').ref,
    toRef: page.elements.find(item => item.name === 'Destination').ref,
    from: { x: 50, y: 20 }, to: { x: 150, y: 20 }, durationMs: 12
  } };
}
for (const phase of ['pointerdown', 'mousedown', 'dragstart', 'pointermove', 'dragenter', 'dragover']) {
  test('drag stops before drop after identity changes during ' + phase + ' and releases', async () => {
    const { h, log, source, target, args } = await dragFixture();
    const owner = ['dragenter', 'dragover'].includes(phase) ? target : source;
    owner.handlers[phase] = event => { source.innerText = 'Different item'; if (phase === 'dragover') event.preventDefault(); };
    const result = await h.agent.domDrag(args);
    assert.equal(result.__zcodeCode, 'TARGET_CHANGED', JSON.stringify(result));
    assert(!log.some(event => event.type === 'drop'));
    assert(log.some(event => event.type === 'pointerup'));
    assert(log.some(event => event.type === 'mouseup'));
    if (phase === 'pointerdown') assert(!log.some(event => event.type === 'mousedown'));
  });
}

test('drag rejects a replaced original hit child even when the ref and text remain stable', async () => {
  const { h, log, source, target, args } = await dragFixture();
  const child = h.node('span', {}, '', target);
  h.document.elementFromPoint = x => x < 100 ? source : child;
  child.handlers = { dragover: event => { child.remove(); h.document.elementFromPoint = x => x < 100 ? source : target; event.preventDefault(); } };
  assert.equal((await h.agent.domDrag(args)).__zcodeCode, 'TARGET_CHANGED');
  assert(!log.some(event => event.type === 'drop'));
});

test('stable drag dispatches one drop and canceled dragstart dispatches none', async () => {
  for (const cancel of [false, true]) {
    const { h, log, source, args } = await dragFixture();
    source.handlers.dragstart = event => { if (cancel) event.preventDefault(); };
    const result = ok(await h.agent.domDrag(args));
    assert.equal(log.filter(event => event.type === 'drop').length, cancel ? 0 : 1);
    assert.equal(log.filter(event => event.type === 'dragend').length, 1);
    assert.equal(result.canceled === true, cancel);
  }
});

test('password value stays private across semantic identity and inspect metadata', async () => {
  const h = pageHarness(); const parent = h.node('article', {}, 'Account ');
  parent.style.filter = 'brightness(0.8)';
  const password = h.node('input', { type: 'password', 'aria-label': 'Password' }, '', parent);
  password.value = 'PRIVATE_PASSWORD_SENTINEL'; h.node('button', {}, 'Other');
  const first = await snap(h, { limit: 1 });
  const state = ok(await h.agent.inspect(first.elements[0].ref));
  const last = ok(await h.agent.snapshot({ cursor: first.pagination.nextCursor }));
  assert(!JSON.stringify([first, state, last]).includes(password.value));
  password.value = 'NEW_PRIVATE_PASSWORD_SENTINEL';
  assert.equal(ok(await h.agent.inspect(first.elements[0].ref)).identityChanged, false);
});

test('repeated injection preserves current refs and a new snapshot expires the previous generation', async () => {
  const h = pageHarness(); h.node('button', {}, 'Keep');
  const first = await snap(h), agent = h.context.__aiBrowserPageAgent9;
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'page-agent.js'), 'utf8'), h.context);
  assert.equal(h.context.__aiBrowserPageAgent9, agent);
  ok(await h.agent.prepare(first.elements[0].ref));
  const second = await snap(h); assert.notEqual(first.elements[0].ref, second.elements[0].ref);
  assert.equal((await h.agent.prepare(first.elements[0].ref)).__zcodeCode, 'STALE_REF');
});

for (const mutation of ['hidden', 'inert', 'aria-disabled', 'display', 'visibility', 'opacity', 'disabled']) {
  test('inherited visibility and disabled guards preserve ' + mutation, async () => {
    const h = pageHarness(), parent = h.node('article', {}, 'Account ');
    const element = h.node('button', {}, 'Continue', parent), first = await snap(h);
    if (mutation === 'hidden' || mutation === 'inert') parent.attrs[mutation] = '';
    else if (mutation === 'aria-disabled') parent.attrs[mutation] = 'true';
    else if (mutation === 'disabled') element.disabled = true;
    else parent.style[mutation] = { display: 'none', visibility: 'hidden', opacity: '0' }[mutation];
    const state = ok(await h.agent.inspect(first.elements[0].ref));
    const disabled = ['inert', 'aria-disabled', 'disabled'].includes(mutation);
    assert.equal(state.visible, disabled); assert.equal(state.disabled, disabled);
    assert.equal((await h.agent.prepare(first.elements[0].ref)).__zcodeCode, disabled ? 'ELEMENT_DISABLED' : 'ELEMENT_NOT_VISIBLE');
  });
}

test('shadow and iframe contents receive no actionable top-document refs', async () => {
  const h = pageHarness(); h.node('button', {}, 'Top action');
  const host = h.node('div');
  const shadow = new h.context.Element('button', {}, 'Shadow action'); host.shadowRoot = { children: [shadow] };
  const same = h.node('iframe'); same.contentDocument = { body: { innerText: 'Same-origin frame text' } };
  const cross = h.node('iframe'); Object.defineProperty(cross, 'contentDocument', { get() { throw new Error('cross-origin fixture'); } });
  const page = await snap(h);
  assert.deepEqual(Array.from(page.elements, item => item.name), ['Top action']);
  assert.equal(page.frames, 2); assert(page.text.includes('Same-origin frame text'));
});

for (const mutation of ['navigation', 'disabled', 'inert', 'hidden']) {
  test('drag stops after ' + mutation + ' during a move and releases', async () => {
    const { h, log, source, target, args } = await dragFixture();
    source.handlers.pointermove = () => {
      if (mutation === 'navigation') h.context.location.href += '?changed';
      else if (mutation === 'disabled') target.disabled = true;
      else target.attrs[mutation] = '';
    };
    const result = await h.agent.domDrag(args);
    assert(result.__zcodeError, JSON.stringify(result));
    assert(!log.some(event => event.type === 'drop'));
    assert.equal(log.filter(event => event.type === 'pointermove').length, 1);
    assert(!log.some(event => event.type === 'mousemove'), 'stop at the event that changed the page');
    assert(log.some(event => event.type === 'pointerup'));
    assert(log.some(event => event.type === 'mouseup'));
  });
}

test('named form controls never enter the private identity serialization', async () => {
  const h = pageHarness(), form = h.node('form', { action: '/preview' });
  const element = h.node('button', {}, 'Continue'); element.form = form;
  const named = h.node('input', { type: 'password', name: 'action' }); named.value = 'PRIVATE_SENTINEL';
  named.toJSON = () => { throw new Error('must not serialize a named control'); }; form.action = named;
  const first = await snap(h, { name: 'Continue' });
  assert.equal(ok(await h.agent.inspect(first.elements[0].ref)).identityChanged, false);
  form.attrs.action = '/submit';
  assert.equal((await h.agent.prepare(first.elements[0].ref)).__zcodeCode, 'TARGET_CHANGED');
});
