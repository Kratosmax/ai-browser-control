'use strict';

// Pure in-memory DOM fixtures execute the real page agent: no browser, bridge or copied query logic.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const test = require('node:test');
const pageSource = fs.readFileSync(path.join(__dirname, '..', 'page-agent.js'), 'utf8');

function pageHarness() {
  let hit = null;
  const timers = [];
  const descendants = node => node.children.flatMap(child => [child, ...descendants(child)]);
  // Only DOM selector matching lives here. Candidate selection/filtering/paging stays in page-agent.js.
  function matches(element, selector) {
    return selector.split(',').some(part => {
      part = part.trim();
      if (!part) return false;
      const nots = [...part.matchAll(/:not\(([^)]+)\)/g)].map(match => match[1]);
      part = part.replace(/:not\([^)]+\)/g, '');
      if (nots.some(excluded => matches(element, excluded))) return false;
      if (part.includes(':disabled')) {
        if (!element.disabled) return false;
        part = part.replace(':disabled', '');
      }
      const attrs = [...part.matchAll(/\[([\w-]+)(?:([~^$*|]?=)["']?([^\]"']*)["']?)?\]/g)];
      for (const [, name, operator, value] of attrs) {
        const actual = element.getAttribute(name);
        if (actual === null) return false;
        if (operator === '=' && actual !== value) return false;
        if (operator === '~=' && !actual.split(/\s+/).includes(value)) return false;
        if (operator === '^=' && !actual.startsWith(value)) return false;
        if (operator === '$=' && !actual.endsWith(value)) return false;
        if (operator === '*=' && !actual.includes(value)) return false;
      }
      part = part.replace(/\[[^\]]+\]/g, '');
      const id = /#([\w-]+)/.exec(part);
      if (id && element.id !== id[1]) return false;
      part = part.replace(/#[\w-]+/g, '');
      if (part === '' || part === '*') return true;
      return element.tagName.toLowerCase() === part.toLowerCase();
    });
  }
  const document = {
    title: 'Snapshot query fixture', readyState: 'complete', visibilityState: 'hidden',
    activeElement: null, addEventListener() {}, scrollingElement: null,
    querySelectorAll(selector) { return [this.body, ...descendants(this.body)].filter(node => matches(node, selector)); },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
    getElementById(id) { return [this.body, ...descendants(this.body)].find(node => node.id === id) || null; },
    elementFromPoint() { return hit; }
  };
  class Element {
    constructor(tag, attrs = {}, text = '') {
      this.tagName = tag.toUpperCase(); this.attrs = { ...attrs }; this.children = []; this.parentElement = null;
      this._text = text; this.value = ''; this.style = {}; this.nodeType = 1; this.ownerDocument = document;
      this.type = attrs.type || (tag === 'button' ? 'submit' : 'text');
      this.disabled = false; this.readOnly = false; this.multiple = false; this.isContentEditable = false;
      this.rect = { left: 10, top: 10, right: 110, bottom: 30, width: 100, height: 20 };
      this.scrollCalls = [];
    }
    get id() { return this.attrs.id || ''; }
    get parentNode() { return this.parentElement; }
    get childNodes() { return this.children; }
    get isConnected() { return this === document.body || Boolean(this.parentElement?.isConnected); }
    get innerText() { return this._text + this.children.filter(child => !child.hasAttribute('hidden') && child.style.display !== 'none').map(child => child.innerText).join(' '); }
    set innerText(text) { this._text = String(text); }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(' '); }
    set textContent(text) { this._text = String(text); }
    get options() { return descendants(this).filter(node => node.tagName === 'OPTION'); }
    get selectedOptions() { return this.options.filter(node => node.selected); }
    getAttribute(name) { return Object.hasOwn(this.attrs, name) ? String(this.attrs[name]) : null; }
    hasAttribute(name) { return Object.hasOwn(this.attrs, name); }
    setAttribute(name, value) { this.attrs[name] = String(value); }
    removeAttribute(name) { delete this.attrs[name]; }
    matches(selector) { return matches(this, selector); }
    closest(selector) { for (let node = this; node; node = node.parentElement) if (matches(node, selector)) return node; return null; }
    querySelectorAll(selector) { return descendants(this).filter(node => matches(node, selector)); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    contains(other) { for (let node = other; node; node = node.parentElement) if (node === this) return true; return false; }
    append(...nodes) {
      for (const node of nodes) { node.remove(); node.parentElement = this; this.children.push(node); }
    }
    remove() {
      if (this.parentElement) this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1);
      this.parentElement = null;
    }
    getClientRects() { return this.type === 'hidden' ? [] : [this.rect]; }
    getBoundingClientRect() { return this.rect; }
    compareDocumentPosition(other) {
      const order = [document.body, ...descendants(document.body)];
      return order.indexOf(this) < order.indexOf(other) ? 4 : 2;
    }
    scrollIntoView(options) {
      this.scrollCalls.push(options); hit = this;
      if (this.rect.top >= 800 || this.rect.bottom <= 0) this.rect = { left: 10, top: 10, right: 110, bottom: 30, width: 100, height: 20 };
    }
    focus() { document.activeElement = this; }
  }
  class HTMLInputElement extends Element { constructor(attrs, text) { super('input', attrs, text); } }
  class HTMLTextAreaElement extends Element { constructor(attrs, text) { super('textarea', attrs, text); } }
  class HTMLSelectElement extends Element { constructor(attrs, text) { super('select', attrs, text); } }
  document.body = new Element('body');
  document.documentElement = document.body;
  const context = vm.createContext({
    Element, HTMLElement: Element, HTMLInputElement, HTMLTextAreaElement, HTMLSelectElement, document,
    Node: { DOCUMENT_POSITION_PRECEDING: 2, DOCUMENT_POSITION_FOLLOWING: 4 },
    location: { href: 'https://snapshot-query.test/' }, innerHeight: 800, innerWidth: 1200,
    URL, URLSearchParams, TextEncoder, TextDecoder, btoa, atob,
    getComputedStyle: element => ({ display: 'block', visibility: 'visible', opacity: '1', position: 'static', cursor: 'auto', zIndex: 'auto', ...element.style }),
    matchMedia: () => ({ matches: true }),
    // Resolve layout waits without wall-clock sleeps; auto exploration is not invoked by these tests.
    setTimeout(fn, ms) { timers.push(ms); queueMicrotask(fn); return timers.length; }, clearTimeout() {}
  });
  context.window = context;
  vm.runInContext(pageSource, context);
  function node(tag, attrs = {}, text = '', parent = document.body) {
    const Constructor = { input: HTMLInputElement, textarea: HTMLTextAreaElement, select: HTMLSelectElement }[tag];
    const element = Constructor ? new Constructor(attrs, text) : new Element(tag, attrs, text);
    parent.append(element); return element;
  }
  return { document, node, timers, agent: context.__aiBrowserPageAgent8, context };
}

const snapshot = (h, options = {}) => h.agent.snapshot({ load: 'current', ...options });
function success(result) { assert.equal(result.__zcodeError, undefined, JSON.stringify(result)); return result; }
function names(result) { return Array.from(success(result).elements, item => item.name); }
function errorCode(result, code) { assert.equal(result.__zcodeCode, code, JSON.stringify(result)); }
function buttons(h, count, parent) { return Array.from({ length: count }, (_, i) => h.node('button', {}, 'Action ' + i, parent)); }
function pagination(result) {
  success(result); assert(result.pagination, 'snapshot must expose pagination'); return result.pagination;
}

test('name query reaches an offscreen download after 1600 loaded candidates and prepare scrolls it', async () => {
  const h = pageHarness(); buttons(h, 1600);
  const download = h.node('button', {}, '下载月报'); download.rect = { left: 10, top: 2000, right: 110, bottom: 2020, width: 100, height: 20 };
  const result = await snapshot(h, { name: '下载' });
  assert.deepEqual(names(result), ['下载月报']); assert.match(result.elements[0].ref, /^r\d+-\d+$/);
  assert.equal(pagination(result).total, 1);
  assert.equal(success(await h.agent.prepare(result.elements[0].ref)).target.name, '下载月报');
  assert(download.scrollCalls.length > 0);
});

test('name/role/context compose, exact only changes name, and independent same-name actions survive', async () => {
  const h = pageHarness();
  const a = h.node('article', {}, '订单 A '), b = h.node('article', {}, '订单 B ');
  h.node('button', {}, '下载', a); h.node('button', {}, '下载', a);
  h.node('a', { href: '/download' }, '下载', a); h.node('button', {}, '下载副本', a);
  h.node('button', {}, '下载', b);
  const exact = await snapshot(h, { name: '下载', role: 'button', context: '订单 A', exact: true });
  assert.deepEqual(names(exact), ['下载', '下载']); assert.notEqual(exact.elements[0].ref, exact.elements[1].ref);
  assert(exact.elements.every(item => item.context.includes('订单 A')));
  const partial = await snapshot(h, { name: '下载', role: 'button', context: '订单 A' });
  assert.deepEqual(names(partial), ['下载', '下载', '下载副本']);
  assert.deepEqual(names(await snapshot(h, { role: 'link', context: '订单 A' })), ['下载']);
});

test('main scope includes semantic and ARIA main regions and composes with name', async () => {
  const h = pageHarness(); h.node('button', {}, '下载导航');
  const main = h.node('main'), ariaMain = h.node('section', { role: 'main' });
  h.node('button', {}, '下载正文', main); h.node('button', {}, '下载附件', ariaMain);
  assert.deepEqual(names(await snapshot(h, { scope: 'main', name: '下载', role: 'button' })), ['下载正文', '下载附件']);
});

test('missing main scope returns an explicit empty result instead of falling back to the page', async () => {
  const h = pageHarness(); h.node('button', {}, 'Outside');
  const result = await snapshot(h, { scope: 'main' }); assert.deepEqual(names(result), []);
  assert.equal(pagination(result).total, 0); assert.match(JSON.stringify(result), /main/);
});

test('dialog scope contains only visible native/ARIA/modal dialogs', async () => {
  const h = pageHarness(); h.node('button', {}, 'Outside');
  const native = h.node('dialog', { open: '' }); h.node('button', {}, 'Native', native);
  const aria = h.node('section', { role: 'dialog' }); h.node('button', {}, 'ARIA', aria);
  const modal = h.node('section', { 'aria-modal': 'true' }); h.node('button', {}, 'Modal', modal);
  const hidden = h.node('div', { role: 'dialog', hidden: '' }); h.node('button', {}, 'Hidden', hidden);
  assert.deepEqual(names(await snapshot(h, { scope: 'dialog', role: 'button' })), ['Native', 'ARIA', 'Modal']);
});

test('viewport scope uses rectangle intersection and excludes fully offscreen candidates', async () => {
  const h = pageHarness(); h.node('button', {}, 'Inside');
  const partial = h.node('button', {}, 'Partial'); partial.rect = { left: -20, top: 0, right: 20, bottom: 20, width: 40, height: 20 };
  const outside = h.node('button', {}, 'Outside'); outside.rect = { left: 10, top: 801, right: 110, bottom: 821, width: 100, height: 20 };
  assert.deepEqual(names(await snapshot(h, { scope: 'viewport' })), ['Inside', 'Partial']);
});

test('scopeRef resolves an old container ref before refresh and includes the interactive container itself', async () => {
  const h = pageHarness(); const main = h.node('section', { role: 'main', 'aria-label': 'Report area' });
  h.node('button', {}, 'Download', main); h.node('button', {}, 'Outside');
  const initial = await snapshot(h); const ref = success(initial).elements.find(item => item.role === 'main').ref;
  const scoped = await snapshot(h, { scopeRef: ref }); assert.deepEqual(names(scoped), ['Report area', 'Download']);
  errorCode(await h.agent.prepare(ref), 'STALE_REF');
  const nested = scoped.elements.find(item => item.name === 'Download'); success(await h.agent.prepare(nested.ref));
});

test('scopeRef filters combine and scope plus scopeRef is rejected', async () => {
  const h = pageHarness(); const main = h.node('section', { role: 'main', 'aria-label': 'Region' });
  h.node('button', {}, 'Download', main); h.node('a', { href: '/outside' }, 'Download');
  let ref = success(await snapshot(h)).elements.find(item => item.role === 'main').ref;
  assert.deepEqual(names(await snapshot(h, { scopeRef: ref, name: 'Download', role: 'button', exact: true })), ['Download']);
  ref = success(await snapshot(h)).elements.find(item => item.role === 'main').ref;
  const invalid = await snapshot(h, { scopeRef: ref, scope: 'all' }); assert(invalid.__zcodeError, 'scope and scopeRef must be mutually exclusive');
});

test('150-item stable pagination covers 1600 candidates without missing or repeated refs', async () => {
  const h = pageHarness(); buttons(h, 1600);
  let page = await snapshot(h); const first = page; const id = pagination(first).snapshotId;
  assert.equal(first.elements.length, 150); assert.equal(pagination(first).total, 1600);
  const refs = [], found = []; let offset = 0, pages = 0;
  while (true) {
    const p = pagination(page); assert.equal(p.snapshotId, id); assert.equal(p.offset, offset); assert.equal(p.limit, 150);
    assert.equal(p.total, 1600); assert(page.elements.length <= 150);
    refs.push(...Array.from(page.elements, item => item.ref)); found.push(...names(page)); offset += page.elements.length; pages++;
    if (!p.hasMore) { assert.equal(p.nextCursor, null); break; }
    assert.equal(typeof p.nextCursor, 'string'); page = await h.agent.snapshot({ cursor: p.nextCursor, load: 'current', format: 'full' });
    if (pages === 1) success(await h.agent.prepare(first.elements[0].ref));
    assert(pages < 20, 'cursor must make progress');
  }
  assert.equal(pages, 11); assert.equal(refs.length, 1600); assert.equal(new Set(refs).size, 1600);
  assert.deepEqual([...found].sort(), Array.from({ length: 1600 }, (_, i) => 'Action ' + i).sort());
});

test('custom page limit retains the original query on cursor-only continuations', async () => {
  const h = pageHarness(); buttons(h, 160);
  for (let i = 0; i < 5; i++) h.node('button', {}, '下载 ' + i);
  const first = await snapshot(h, { name: '下载', role: 'button', limit: 2 });
  assert.deepEqual(names(first), ['下载 0', '下载 1']); assert.equal(pagination(first).total, 5);
  const second = await h.agent.snapshot({ cursor: first.pagination.nextCursor });
  assert.deepEqual(names(second), ['下载 2', '下载 3']); assert.equal(pagination(second).limit, 2);
  const third = await h.agent.snapshot({ cursor: second.pagination.nextCursor });
  assert.deepEqual(names(third), ['下载 4']); assert.equal(pagination(third).hasMore, false);
  assert.deepEqual(h.timers, [], 'cursor-only continuation must not invoke auto loading probes');
});

test('a fresh no-cursor snapshot expires both the old refs and cursor', async () => {
  const h = pageHarness(); buttons(h, 151);
  const first = await snapshot(h); const ref = success(first).elements[0].ref; const cursor = pagination(first).nextCursor;
  const fresh = await snapshot(h); assert.notEqual(fresh.elements[0].ref, ref);
  errorCode(await h.agent.prepare(ref), 'STALE_REF');
  errorCode(await h.agent.snapshot({ cursor }), 'STALE_CURSOR');
});

for (const mutation of ['identity reuse', 'node replacement', 'addition', 'removal', 'reorder', 'visibility']) {
  test('cursor rejects relevant candidate ' + mutation + ' as SNAPSHOT_CHANGED', async () => {
    const h = pageHarness(); const nodes = buttons(h, 152); const first = await snapshot(h); const cursor = pagination(first).nextCursor;
    if (mutation === 'identity reuse') nodes[151].innerText = 'Different business action';
    if (mutation === 'node replacement') { nodes[151].remove(); h.node('button', {}, 'Action 151'); }
    if (mutation === 'addition') h.node('button', {}, 'New action');
    if (mutation === 'removal') nodes[151].remove();
    if (mutation === 'reorder') h.document.body.append(nodes[150]);
    if (mutation === 'visibility') nodes[151].style.display = 'none';
    errorCode(await h.agent.snapshot({ cursor, load: 'current' }), 'SNAPSHOT_CHANGED');
  });
}

test('unrelated decorative text, cursor and timestamp changes do not invalidate a cursor', async () => {
  const h = pageHarness(); buttons(h, 151); const decoration = h.node('div', { 'data-clock': '1' }, '12:00');
  const first = await snapshot(h); decoration.innerText = '12:01'; decoration.attrs['data-clock'] = '2';
  h.node('div', { 'data-ai-cursor': 'true' });
  assert.deepEqual(names(await h.agent.snapshot({ cursor: pagination(first).nextCursor, load: 'current' })), ['Action 150']);
});

test('arbitrary and forged cursors return STALE_CURSOR instead of refreshing the snapshot', async () => {
  const h = pageHarness(); buttons(h, 151); const first = await snapshot(h);
  for (const cursor of ['not-a-cursor', '{"offset":150}', pagination(first).nextCursor + '-tampered']) {
    errorCode(await h.agent.snapshot({ cursor, load: 'current' }), 'STALE_CURSOR');
  }
  success(await h.agent.prepare(first.elements[0].ref));
});

test('navigation invalidates a cursor even when the candidate nodes remain connected', async () => {
  const h = pageHarness(); buttons(h, 151); const first = await snapshot(h);
  h.context.location.href = 'https://snapshot-query.test/other';
  const result = await h.agent.snapshot({ cursor: pagination(first).nextCursor, load: 'current' });
  assert(['STALE_CURSOR', 'SNAPSHOT_CHANGED'].includes(result.__zcodeCode), JSON.stringify(result));
});

test('permanent navigation menu and ordinary select/listbox are not popup items', async () => {
  const h = pageHarness(); const nav = h.node('nav'); const menu = h.node('ul', { role: 'menu' }, '', nav);
  h.node('a', { href: '/home', role: 'menuitem' }, 'Home', menu);
  const select = h.node('select', { role: 'listbox', 'aria-label': 'Native choices' });
  h.node('option', { role: 'option' }, 'Native option', select);
  const list = h.node('div', { role: 'listbox', 'aria-label': 'Permanent choices' }); h.node('div', { role: 'option' }, 'Static option', list);
  const result = success(await snapshot(h));
  assert(result.elements.some(item => item.name === 'Home'));
  assert(result.elements.every(item => !item.inPopup), JSON.stringify(result.elements));
});

test('permanent menu cannot displace ordinary earlier actions through popup priority', async () => {
  const h = pageHarness(); buttons(h, 150); const nav = h.node('nav'); const menu = h.node('ul', { role: 'menu' }, '', nav);
  h.node('a', { role: 'menuitem', href: '/late' }, 'Late navigation', menu);
  assert.equal(names(await snapshot(h)).includes('Late navigation'), false);
});

test('legacy nonsemantic aria-haspopup controls popup keeps priority beyond the first 150 actions', async () => {
  const h = pageHarness(); buttons(h, 150);
  h.node('button', { 'aria-haspopup': 'true', 'aria-controls': 'actions', 'aria-expanded': 'true' }, 'Open actions');
  const root = h.node('div', { id: 'actions' }); const item = h.node('div', {}, '下载文件', root); item.style.cursor = 'pointer';
  const result = success(await snapshot(h)); const download = result.elements.find(item => item.name === '下载文件');
  assert(download, 'linked nonsemantic popup action must receive a ref'); assert.equal(download.inPopup, true);
});

test('aria-expanded=false does not make a permanent linked menu a popup', async () => {
  const h = pageHarness(); h.node('button', { 'aria-haspopup': 'menu', 'aria-controls': 'menu', 'aria-expanded': 'false' }, 'Menu');
  const root = h.node('ul', { id: 'menu', role: 'menu' }); h.node('button', {}, 'Permanent action', root);
  const result = success(await snapshot(h)); assert(result.elements.every(item => !item.inPopup));
});

test('nested li/button/span describing one real menu action yields only one ref', async () => {
  const h = pageHarness(); h.node('button', { 'aria-haspopup': 'menu', 'aria-controls': 'actions', 'aria-expanded': 'true' }, 'Actions');
  const root = h.node('ul', { id: 'actions', role: 'menu' });
  const li = h.node('li', { role: 'menuitem' }, '', root); const button = h.node('button', {}, '', li);
  const span = h.node('span', {}, '下载', button); span.style.cursor = 'pointer';
  const result = await snapshot(h, { name: '下载', exact: true });
  success(result);
  // Keep the menu container available for scopeRef; only its action representations must converge.
  const actions = result.elements.filter(item => item.role !== 'menu');
  assert.deepEqual(Array.from(actions, item => item.name), ['下载'], JSON.stringify(result.elements));
  assert.equal(actions[0].inPopup, true);
});

test('two independent same-name buttons inside one menu item retain two action refs', async () => {
  const h = pageHarness(); h.node('button', { 'aria-haspopup': 'menu', 'aria-controls': 'actions' }, 'Actions');
  const root = h.node('ul', { id: 'actions', role: 'menu' }); const li = h.node('li', { role: 'menuitem' }, '', root);
  h.node('button', {}, '下载', li); h.node('button', {}, '下载', li);
  const result = await snapshot(h, { name: '下载', exact: true });
  assert.deepEqual(names(result), ['下载', '下载']); assert.notEqual(result.elements[0].ref, result.elements[1].ref);
});

test('same-name action outside the returned page still requires expectedContext', async () => {
  const h = pageHarness(); const firstRow = h.node('article', {}, 'Order A ');
  h.node('button', {}, '下载', firstRow); buttons(h, 150);
  const lastRow = h.node('article', {}, 'Order B '); h.node('button', {}, '下载', lastRow);
  const page = success(await snapshot(h)); const first = page.elements.find(item => item.name === '下载');
  assert.equal(first.requiresExpectedContext, true);
  errorCode(await h.agent.prepare({ ref: first.ref, action: 'click' }), 'AMBIGUOUS_TARGET');
  success(await h.agent.prepare({ ref: first.ref, action: 'click', expectedContext: 'Order A' }));
});

test('scopeRef cannot follow a container whose business identity changed', async () => {
  const h = pageHarness(); const main = h.node('section', { role: 'main', 'aria-label': 'Order A' });
  h.node('button', {}, 'Download', main);
  const page = success(await snapshot(h)); const ref = page.elements.find(item => item.role === 'main').ref;
  main.attrs['aria-label'] = 'Order B';
  errorCode(await snapshot(h, { scopeRef: ref }), 'TARGET_CHANGED');
});

test('unlinked visible floating menu receives popup priority while permanent navigation does not', async () => {
  const h = pageHarness(); buttons(h, 150);
  const menu = h.node('div', { role: 'menu' }); menu.style.position = 'absolute'; menu.style.zIndex = '20';
  h.node('button', {}, 'Floating action', menu);
  const result = success(await snapshot(h)); const item = result.elements.find(item => item.name === 'Floating action');
  assert(item, 'a visible floating menu has independent popup evidence'); assert.equal(item.inPopup, true);
});

test('password value never leaks through queried pages, text, descriptors or pagination', async () => {
  const h = pageHarness(); buttons(h, 151);
  const password = h.node('input', { type: 'password', 'aria-label': 'Account password' }); password.value = 'DO_NOT_LEAK_PASSWORD_1700';
  const first = await snapshot(h); const last = await h.agent.snapshot({ cursor: pagination(first).nextCursor, load: 'current' });
  const queried = await snapshot(h, { name: 'Account password' });
  for (const result of [first, last, queried]) assert(!JSON.stringify(success(result)).includes(password.value));
  assert.deepEqual(names(queried), ['Account password']); assert(!Object.hasOwn(queried.elements[0], 'value'));
  assert(!JSON.stringify(success(await h.agent.inspect(queried.elements[0].ref))).includes(password.value));
  assert.deepEqual(names(await snapshot(h, { name: password.value })), [], 'password contents are not searchable names');
});

test('aria-controls on a static permanent navigation menu is not popup evidence', async () => {
  const h = pageHarness();
  h.node('button', { 'aria-controls': 'permanent', 'aria-expanded': 'true' }, '侧栏');
  const nav = h.node('nav');
  const root = h.node('ul', { id: 'permanent', role: 'menu' }, '', nav);
  h.node('a', { role: 'menuitem', href: '/home' }, 'Home', root);
  const result = success(await snapshot(h, { name: 'Home', exact: true }));
  assert.equal(result.elements.length, 1);
  assert.equal(result.elements[0].inPopup, false);
});

test('independent delegated ARIA buttons inside a menu wrapper remain separate actions', async () => {
  const h = pageHarness();
  h.node('button', { 'aria-controls': 'delegated', 'aria-haspopup': 'menu', 'aria-expanded': 'true' }, 'Actions');
  const root = h.node('ul', { id: 'delegated', role: 'menu' });
  const li = h.node('li', { role: 'menuitem' }, '', root);
  h.node('div', { role: 'button', tabindex: '0' }, 'Download', li);
  h.node('div', { role: 'button', tabindex: '0' }, 'Delete', li);
  const result = success(await snapshot(h, { role: 'button', name: 'Download', exact: true }));
  assert.deepEqual(names(result), ['Download']);
  assert.equal(result.elements[0].inPopup, true);
});

test('nearby open trigger supports a floating CSS menu without controls inside navigation', async () => {
  const h = pageHarness(); const nav = h.node('nav');
  h.node('button', { 'aria-haspopup': 'menu', 'aria-expanded': 'true' }, 'More', nav);
  const root = h.node('ul', { role: 'menu' }, '', nav); root.style.position = 'absolute';
  h.node('button', {}, 'Floating nav action', root);
  const result = success(await snapshot(h, { name: 'Floating nav action', exact: true }));
  assert.equal(result.elements[0].inPopup, true);
});

test('collapsed trigger cannot regain popup priority from floating fallback', async () => {
  const h = pageHarness();
  h.node('button', { 'aria-controls': 'collapsed', 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, 'Closed');
  const root = h.node('ul', { role: 'menu', id: 'collapsed' }); root.style.position = 'absolute';
  h.node('button', {}, 'Still visible during animation', root);
  const result = success(await snapshot(h, { name: 'Still visible during animation', exact: true }));
  assert.equal(result.elements[0].inPopup, false);
});
