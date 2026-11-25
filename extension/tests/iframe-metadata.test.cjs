'use strict';

// Pure in-memory DOM fixtures execute the real page agent: iframe metadata is exercised without any browser,
// bridge or CDP. The harness mirrors snapshot-query.test.cjs and adds HTMLIFrameElement/baseURI behavior.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const test = require('node:test');
const pageSource = fs.readFileSync(path.join(__dirname, '..', 'page-agent.js'), 'utf8');

const OWNER = 'https://owner.test/app';
const OWNER_ORIGIN = 'https://owner.test';
const ENTRY_KEYS = ['kind', 'src', 'srcTruncated', 'url', 'urlTruncated', 'origin', 'crossOrigin',
  'originSource', 'sandboxOpaque', 'documentAccessible', 'note'].sort();
const URL_LIMIT = 2048;

function pageHarness() {
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
    title: 'Frame metadata fixture', baseURI: OWNER, readyState: 'complete', visibilityState: 'hidden',
    activeElement: null, addEventListener() {}, scrollingElement: null,
    querySelectorAll(selector) { return [this.body, ...descendants(this.body)].filter(node => matches(node, selector)); },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
    getElementById(id) { return [this.body, ...descendants(this.body)].find(node => node.id === id) || null; },
    elementFromPoint() { return null; }
  };
  class Element {
    constructor(tag, attrs = {}, text = '') {
      this.tagName = tag.toUpperCase(); this.attrs = { ...attrs }; this.children = []; this.parentElement = null;
      this._text = text; this.value = ''; this.style = {}; this.nodeType = 1; this.ownerDocument = document;
      this.type = attrs.type || (tag === 'button' ? 'submit' : 'text');
      this.disabled = false; this.readOnly = false; this.multiple = false; this.isContentEditable = false;
      this.rect = { left: 10, top: 10, right: 110, bottom: 30, width: 100, height: 20 };
    }
    get id() { return this.attrs.id || ''; }
    get parentNode() { return this.parentElement; }
    get childNodes() { return this.children; }
    get isConnected() { return this === document.body || Boolean(this.parentElement?.isConnected); }
    get innerText() { return this._text + this.children.filter(child => !child.hasAttribute('hidden') && child.style.display !== 'none').map(child => child.innerText).join(' '); }
    set innerText(text) { this._text = String(text); }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(' '); }
    set textContent(text) { this._text = String(text); }
    getAttribute(name) { return Object.hasOwn(this.attrs, name) ? String(this.attrs[name]) : null; }
    hasAttribute(name) { return Object.hasOwn(this.attrs, name); }
    setAttribute(name, value) { this.attrs[name] = String(value); }
    removeAttribute(name) { delete this.attrs[name]; }
    matches(selector) { return matches(this, selector); }
    closest(selector) { for (let node = this; node; node = node.parentElement) if (matches(node, selector)) return node; return null; }
    querySelectorAll(selector) { return descendants(this).filter(node => matches(node, selector)); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    contains(other) { for (let node = other; node; node = node.parentElement) if (node === this) return true; return false; }
    append(...nodes) { for (const node of nodes) { node.remove(); node.parentElement = this; this.children.push(node); } }
    remove() { if (this.parentElement) this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1); this.parentElement = null; }
    getClientRects() { return this.type === 'hidden' ? [] : [this.rect]; }
    getBoundingClientRect() { return this.rect; }
    compareDocumentPosition(other) {
      const order = [document.body, ...descendants(document.body)];
      return order.indexOf(this) < order.indexOf(other) ? 4 : 2;
    }
    scrollIntoView() {}
    focus() { document.activeElement = this; }
  }
  class HTMLInputElement extends Element { constructor(attrs, text) { super('input', attrs, text); } }
  class HTMLTextAreaElement extends Element { constructor(attrs, text) { super('textarea', attrs, text); } }
  class HTMLSelectElement extends Element { constructor(attrs, text) { super('select', attrs, text); } }
  // Reflected src getter resolves the attribute against the owner base URI like a real HTMLIFrameElement.
  class HTMLIFrameElement extends Element { constructor(attrs, text) { super('iframe', attrs, text); }
    get src() {
      const value = this.getAttribute('src');
      if (value === null || value === '') return '';
      try { return new URL(value, this.ownerDocument.baseURI).href; } catch { return value; }
    }
  }
  document.body = new Element('body');
  document.documentElement = document.body;
  const context = vm.createContext({
    Element, HTMLElement: Element, HTMLInputElement, HTMLTextAreaElement, HTMLSelectElement, HTMLIFrameElement, document,
    Node: { DOCUMENT_POSITION_PRECEDING: 2, DOCUMENT_POSITION_FOLLOWING: 4 },
    location: { href: OWNER, origin: OWNER_ORIGIN }, innerHeight: 800, innerWidth: 1200,
    URL, URLSearchParams, TextEncoder, TextDecoder, btoa, atob,
    getComputedStyle: element => ({ display: 'block', visibility: 'visible', opacity: '1', position: 'static', cursor: 'auto', zIndex: 'auto', ...element.style }),
    matchMedia: () => ({ matches: true }),
    setTimeout(fn, ms) { timers.push(ms); queueMicrotask(fn); return timers.length; }, clearTimeout() {}
  });
  context.window = context;
  vm.runInContext(pageSource, context);
  function node(tag, attrs = {}, text = '', parent = document.body) {
    const Constructor = { input: HTMLInputElement, textarea: HTMLTextAreaElement, select: HTMLSelectElement, iframe: HTMLIFrameElement }[tag];
    const element = Constructor ? new Constructor(attrs, text) : new Element(tag, attrs, text);
    parent.append(element); return element;
  }
  return { document, node, timers, agent: context.__aiBrowserPageAgent8, context };
}

const snapshot = (h, options = {}) => h.agent.snapshot({ load: 'current', ...options });
const ok = result => { assert.equal(result.__zcodeError, undefined, JSON.stringify(result)); return result; };
const entryOf = (result, frame) => {
  const frames = ok(result).frameList;
  return frames[[...frame.ownerDocument.querySelectorAll('iframe')].indexOf(frame)];
};

test('fresh snapshot exposes a bounded frameList while frames stays an integer and [iframe] text survives', async () => {
  const h = pageHarness(); h.node('button', {}, 'Top action');
  const inner = h.node('iframe');
  inner.contentDocument = { location: { href: OWNER + '/inner', origin: OWNER_ORIGIN }, body: { innerText: 'Frame body text' } };
  const result = await snapshot(h);
  assert.equal(Number.isInteger(result.frames), true);
  assert.equal(result.frames, 1);
  assert.equal(Array.isArray(result.frameList), true);
  assert.equal(result.frameList.length, 1);
  assert.deepEqual(Object.keys(result.frameList[0]).sort(), ENTRY_KEYS);
  assert.deepEqual(JSON.parse(JSON.stringify(result.frameList[0])), { kind: 'noSrc', src: null, srcTruncated: false, url: OWNER + '/inner', urlTruncated: false,
    origin: OWNER_ORIGIN, crossOrigin: false, originSource: 'document', sandboxOpaque: false, documentAccessible: true, note: null });
  assert(result.text.includes('[iframe]'));
  assert(result.text.includes('Frame body text'));
});

test('kind follows srcdoc/src presence and requested http(s) resolves against the owner baseURI', async () => {
  const h = pageHarness();
  const relative = h.node('iframe', { src: '/child?tab=1' });
  const absolute = h.node('iframe', { src: 'https://embed.example.test/widget' });
  const data = h.node('iframe', { src: 'data:text/html,<p>RAW_PAYLOAD</p>' });
  const blank = h.node('iframe', { src: 'about:blank' });
  const injected = h.node('iframe', { src: 'javascript:alert(1)' });
  const empty = h.node('iframe', { src: '' });
  const none = h.node('iframe');
  const result = await snapshot(h);
  assert.deepEqual(Array.from(result.frameList, entry => entry.kind), ['src', 'src', 'src', 'src', 'src', 'noSrc', 'noSrc']);
  assert.equal(result.frameList[0].src, OWNER_ORIGIN + '/child?tab=1');
  assert.equal(result.frameList[1].src, 'https://embed.example.test/widget');
  for (const index of [2, 3, 4]) {
    assert.equal(result.frameList[index].src, null);
    assert.equal(result.frameList[index].srcTruncated, false);
  }
  const whole = JSON.stringify(result);
  assert(!whole.includes('RAW_PAYLOAD'));
  assert(!whole.includes('javascript:'));
  assert.equal(entryOf(result, relative).origin, OWNER_ORIGIN);
});

test('srcdoc frames report kind without exposing markup or the ignored src attribute', async () => {
  const h = pageHarness(); h.node('button', {}, 'Top');
  h.node('iframe', { srcdoc: '<p>SECRET_MARKUP</p>', src: 'https://owner.test/ignored' });
  const result = await snapshot(h);
  const entry = result.frameList[0];
  assert.equal(entry.kind, 'srcdoc');
  assert.equal(entry.src, null);
  assert.equal(entry.documentAccessible, false);
  const whole = JSON.stringify(result);
  assert(!whole.includes('SECRET_MARKUP'));
  assert(!whole.includes('/ignored'));
});

test('userinfo never appears and oversized urls become null with a truncated flag while origin stays', async () => {
  const h = pageHarness();
  h.node('iframe', { src: 'https://user:pass@example.test/path' });
  h.node('iframe', { src: 'https://long.example.test/' + 'x'.repeat(3000) });
  h.node('iframe', { src: 'https://mixed.example.test/' + 'z'.repeat(3000) }).contentDocument =
    { location: { href: 'https://owner.test/' + 'y'.repeat(3000), origin: OWNER_ORIGIN }, body: { innerText: '' } };
  const result = await snapshot(h);
  const [cred, oversized, readable] = result.frameList;
  assert.equal(cred.src, 'https://example.test/path');
  assert.equal(cred.origin, 'https://example.test');
  assert.equal(cred.crossOrigin, true);
  assert.equal(cred.originSource, 'src');
  assert.equal(oversized.src, null);
  assert.equal(oversized.srcTruncated, true);
  assert.equal(oversized.origin, 'https://long.example.test');
  assert.equal(oversized.originSource, 'src');
  assert.equal(readable.src, null);
  assert.equal(readable.srcTruncated, true);
  assert.equal(readable.url, null);
  assert.equal(readable.urlTruncated, true);
  assert.equal(readable.origin, OWNER_ORIGIN);
  assert.equal(readable.originSource, 'document');
  const whole = JSON.stringify(result);
  assert(!whole.includes('user:pass'));
  assert(!whole.includes('x'.repeat(200)));
  assert(!whole.includes('y'.repeat(200)));
});

test('an address of exactly the bound is kept intact and oversized becomes null, never a clipped link', async () => {
  const h = pageHarness();
  const atLimit = h.node('iframe', { src: 'https://owner.test/' + 'a'.repeat(2029) });
  const result = await snapshot(h);
  const entry = result.frameList[0];
  assert.equal(atLimit.getAttribute('src').length, URL_LIMIT);
  assert.equal(entry.src.length, URL_LIMIT);
  assert.equal(entry.srcTruncated, false);
  assert.equal(entry.origin, OWNER_ORIGIN);
});

test('cross-origin frames stay sealed and derive origin/crossOrigin from src', async () => {
  const h = pageHarness();
  const frame = h.node('iframe', { src: 'https://other.example.test/page' });
  Object.defineProperty(frame, 'contentDocument', { get() { throw new Error('cross-origin fixture'); } });
  const result = await snapshot(h);
  const entry = result.frameList[0];
  assert.equal(entry.documentAccessible, false);
  assert.equal(entry.url, null);
  assert.equal(entry.origin, 'https://other.example.test');
  assert.equal(entry.crossOrigin, true);
  assert.equal(entry.originSource, 'src');
  assert.equal(entry.sandboxOpaque, null);
  assert.equal(entry.note, null);
});

test('sandbox without allow-same-origin is flagged opaque with a requested-vs-actual note', async () => {
  const h = pageHarness();
  const opaque = h.node('iframe', { src: 'https://owner.test/inner', sandbox: '' });
  Object.defineProperty(opaque, 'contentDocument', { get() { throw new Error('sandboxed fixture'); } });
  const sealed = h.node('iframe', { src: 'https://other.example.test/x', sandbox: 'allow-scripts' });
  const kept = h.node('iframe', { src: 'https://other.example.test/y', sandbox: 'allow-scripts allow-same-origin' });
  kept.contentDocument = { location: { href: 'https://other.example.test/y', origin: 'https://other.example.test' }, body: { innerText: '' } };
  const result = await snapshot(h);
  const [opaqueEntry, sealedEntry, keptEntry] = result.frameList;
  assert.equal(opaqueEntry.sandboxOpaque, true);
  assert.equal(opaqueEntry.documentAccessible, false);
  assert.equal(opaqueEntry.origin, OWNER_ORIGIN);
  assert.equal(opaqueEntry.crossOrigin, false);
  assert.equal(opaqueEntry.originSource, 'src');
  assert.match(opaqueEntry.note, /sandbox/);
  assert.equal(sealedEntry.sandboxOpaque, true);
  assert.equal(sealedEntry.crossOrigin, true);
  assert.match(sealedEntry.note, /sandbox/);
  assert.equal(keptEntry.sandboxOpaque, false);
  assert.equal(keptEntry.documentAccessible, true);
  assert.equal(keptEntry.origin, 'https://other.example.test');
  assert.equal(keptEntry.originSource, 'document');
  assert.equal(keptEntry.crossOrigin, true);
  assert.equal(keptEntry.note, null);
});

test('readable frames without a readable origin keep accessibility and fall back to src attribution', async () => {
  const h = pageHarness();
  const withSrc = h.node('iframe', { src: '/blank-child' });
  withSrc.contentDocument = { body: { innerText: 'Blank child' } };
  const noSrc = h.node('iframe');
  noSrc.contentDocument = { body: { innerText: 'Inherited' } };
  const result = await snapshot(h);
  const [withSrcEntry, noSrcEntry] = result.frameList;
  assert.equal(withSrcEntry.documentAccessible, true);
  assert.equal(withSrcEntry.url, null);
  assert.equal(withSrcEntry.origin, OWNER_ORIGIN);
  assert.equal(withSrcEntry.crossOrigin, false);
  assert.equal(withSrcEntry.originSource, 'src');
  assert.equal(withSrcEntry.sandboxOpaque, false);
  assert.equal(noSrcEntry.documentAccessible, true);
  assert.equal(noSrcEntry.origin, null);
  assert.equal(noSrcEntry.crossOrigin, false);
  assert.equal(noSrcEntry.originSource, null);
  assert.equal(noSrcEntry.sandboxOpaque, false);
});

test('frameList bounds at 32 entries with frameListTruncated while frames keeps the full count', async () => {
  const h = pageHarness();
  for (let i = 0; i < 35; i++) h.node('iframe', { src: '/frame-' + i });
  const result = await snapshot(h);
  assert.equal(result.frames, 35);
  assert.equal(result.frameList.length, 32);
  assert.equal(result.frameListTruncated, true);
  assert.deepEqual(Array.from(result.frameList, entry => entry.src),
    Array.from({ length: 32 }, (_, i) => OWNER_ORIGIN + '/frame-' + i));
});

test('cursor pages carry the same frameList and popup ordering stays in front with frames present', async () => {
  const h = pageHarness();
  h.node('iframe', { src: '/embedded' });
  h.node('button', { 'aria-haspopup': 'menu', 'aria-controls': 'menu' }, 'Actions');
  const menu = h.node('div', { id: 'menu', role: 'menu' });
  menu.style = { position: 'absolute' };
  for (let i = 0; i < 3; i++) h.node('button', {}, 'Item ' + i, menu);
  for (let i = 0; i < 5; i++) h.node('button', {}, 'Page ' + i);
  const first = await snapshot(h, { limit: 3 });
  assert.equal(first.elements.filter(item => item.inPopup).length, 3);
  assert.equal(first.elements[0].inPopup, true);
  assert.equal(first.frameList.length, 1);
  assert.equal(first.frameList[0].src, OWNER_ORIGIN + '/embedded');
  const second = ok(await h.agent.snapshot({ cursor: first.pagination.nextCursor, load: 'current' }));
  assert.equal(second.frameList, first.frameList);
  assert.equal(second.frameList[0].src, OWNER_ORIGIN + '/embedded');
  assert(second.pagination.offset > 0);
  assert(second.elements.every(item => !String(item.name).includes('Frame')));
  assert(!JSON.stringify(second.elements).includes('/embedded'));
});

test('frame metadata survives hostile frames without breaking the snapshot', async () => {
  const h = pageHarness(); h.node('button', {}, 'Top');
  const throwing = h.node('iframe', { src: '/a' });
  Object.defineProperty(throwing, 'contentDocument', { get() { throw new Error('doc getter'); } });
  Object.defineProperty(throwing, 'src', { get() { throw new Error('src getter'); } });
  const weird = h.node('iframe');
  weird.contentDocument = { get location() { throw new Error('location getter'); } };
  const junk = h.node('iframe');
  junk.contentDocument = 'not-an-object';
  const result = await snapshot(h);
  assert.equal(result.frames, 3);
  const [throwingEntry, weirdEntry, junkEntry] = result.frameList;
  assert.equal(throwingEntry.documentAccessible, false);
  assert.equal(throwingEntry.src, OWNER_ORIGIN + '/a');
  assert.equal(weirdEntry.documentAccessible, true);
  assert.equal(weirdEntry.url, null);
  assert.equal(weirdEntry.origin, null);
  assert.equal(weirdEntry.crossOrigin, false);
  assert.equal(junkEntry.documentAccessible, false);
  assert.equal(junkEntry.origin, null);
  assert.equal(junkEntry.crossOrigin, null);
  assert.equal(junkEntry.sandboxOpaque, null);
});
