'use strict';

// Reuse only the existing DOM harness. All candidate/query/action logic is the real page agent.
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

function calendar(h, { disabled, hidden, offscreen = false } = {}) {
  h.node('input', { placeholder: '请选择月份' });
  const root = h.node('div'); root.style.position = 'absolute'; root.style.zIndex = '20';
  const table = h.node('table', {}, '', root), tbody = h.node('tbody', {}, '', table);
  let october;
  for (let row = 0; row < 3; row++) {
    const tr = h.node('tr', {}, '', tbody);
    for (let col = 1; col <= 4; col++) {
      const month = row * 4 + col;
      const td = h.node('td', { title: '2026-' + String(month).padStart(2, '0') }, '', tr);
      const div = h.node('div', {}, '', td), span = h.node('span', {}, month + '月', div);
      for (const node of [td, div, span]) node.style.cursor = 'pointer';
      if (month === 10) {
        october = td;
        if (disabled) td.attrs[disabled] = disabled === 'inert' ? '' : 'true';
        if (hidden) td.style.display = 'none';
        if (offscreen) for (const node of [td, div, span]) node.rect = { left: 10, top: 1600, right: 110, bottom: 1620, width: 100, height: 20 };
      }
    }
  }
  return { root, october };
}

function onlyOctober(result) {
  assert.equal(result.elements.length, 1, JSON.stringify(result));
  const item = result.elements[0];
  assert.equal(item.name, '10月'); assert.equal(item.role, 'generic');
  assert(['td', 'div', 'span'].includes(item.tag)); assert.match(item.ref, /^r\d+-\d+$/);
  return item;
}

test('roleless pointer calendar yields one October ref with its real tag and role', async () => {
  const h = pageHarness(); calendar(h);
  const item = onlyOctober(await snap(h, { name: '10月', exact: true }));
  const state = ok(await h.agent.inspect(item.ref)); assert.equal(state.visible, true);
  assert.equal(state.tag, item.tag); assert.equal(state.role, 'generic');
  assert.equal(ok(await h.agent.prepare(item.ref)).target.name, '10月');
});

test('roleless pointer custom-select items are queryable without invented semantics', async () => {
  const h = pageHarness(); const popup = h.node('div'); popup.style.position = 'absolute';
  for (const name of ['第一项', '第二项']) { const item = h.node('div', {}, name, popup); item.style.cursor = 'pointer'; }
  const result = await snap(h, { name: '第二项', exact: true });
  assert.equal(result.elements.length, 1); assert.equal(result.elements[0].tag, 'div'); assert.equal(result.elements[0].role, 'generic');
});

test('inline click handler alone supports a nonsemantic div', async () => {
  const h = pageHarness(); h.node('div', { onclick: 'selectFixture()' }, '点击项');
  const result = await snap(h, { name: '点击项', exact: true }); assert.equal(result.elements.length, 1); assert.equal(result.elements[0].role, 'generic');
});

test('nested custom action does not collapse independent same-name native buttons', async () => {
  const h = pageHarness(); calendar(h); h.node('button', {}, '10月'); h.node('button', {}, '10月');
  const result = await snap(h, { name: '10月', exact: true });
  assert.equal(result.elements.length, 3); assert.equal(result.elements.filter(item => item.role === 'button').length, 2);
  assert.equal(new Set(result.elements.map(item => item.ref)).size, 3);
});

test('static body text remains excluded while native cells are labeled as content, not buttons', async () => {
  const h = pageHarness(); h.node('div', {}, '10月');
  assert.equal((await snap(h, { name: '10月', exact: true })).elements.length, 0);
  const td = h.node('td', { title: '2026-10' }); h.node('span', {}, '10月', td);
  const result = await snap(h, { name: '10月', exact: true });
  assert.equal(result.elements.length, 1); const item = result.elements[0];
  assert.equal(item.tag, 'td'); assert.equal(item.role, 'generic');
  assert.equal(item.candidateKind, 'native-cell'); assert.equal(item.inPopup, false);
});

test('a roleless native calendar with default cursor is queryable before hover', async () => {
  const h = pageHarness(); const { october } = calendar(h);
  for (const element of [october, ...october.querySelectorAll('div,span')]) element.style.cursor = 'auto';
  const item = onlyOctober(await snap(h, { name: '10月', exact: true }));
  assert.equal(item.tag, 'td'); assert.equal(item.candidateKind, 'native-cell');
  assert(item.context.includes('2026-10'));
});

test('same-name custom targets require distinguishing context before actions', async () => {
  const h = pageHarness();
  for (const year of ['2025', '2026']) { const td = h.node('td', { title: year + '-10' }, '10月'); td.style.cursor = 'auto'; }
  const result = await snap(h, { name: '10月', exact: true });
  assert.equal(result.elements.length, 2); assert(result.elements.every(item => item.requiresExpectedContext));
  assert.equal((await h.agent.prepare({ref:result.elements[0].ref,action:'click'})).__zcodeCode, 'AMBIGUOUS_TARGET');
  assert.equal(ok(await h.agent.prepare({ref:result.elements[1].ref,action:'click',expectedContext:'2026-10'})).target.name, '10月');
});

test('nested independent onclick handlers remain separate even with identical text', async () => {
  const h = pageHarness(); const outer = h.node('div', {onclick:'outer()'}, '');
  h.node('div', {onclick:'inner()'}, '同名项', outer);
  const result = await snap(h, {name:'同名项',exact:true});
  assert.equal(result.elements.length, 2); assert(result.elements.every(item => item.requiresExpectedContext));
});

test('role-marked generic and custom generic targets share ambiguity guarding', async () => {
  const h = pageHarness(); h.node('div', {role:'generic',onclick:'first()'}, '同名项');
  h.node('div', {onclick:'second()'}, '同名项');
  const result = await snap(h, {name:'同名项',exact:true});
  assert.equal(result.elements.length, 2); assert(result.elements.every(item => item.requiresExpectedContext));
  for (const item of result.elements) assert.equal((await h.agent.prepare({ref:item.ref,action:'click'})).__zcodeCode,'AMBIGUOUS_TARGET');
});

test('inspect reports bounded style and hit-test metadata without changing page styles', async () => {
  const h = pageHarness(); const parent = h.node('div', {id:'container',class:'pane'}, ''); parent.style.opacity = '0.2'; parent.style.filter = 'brightness(0.8)';
  h.node('button', {}, 'Inspect target', parent);
  const item = (await snap(h, {name:'Inspect target',exact:true})).elements[0];
  const before = JSON.stringify(parent.style); const state = ok(await h.agent.inspect(item.ref));
  assert.equal(state.ancestors[0].style.opacity, '0.2'); assert.equal(state.ancestors[0].style.filter, 'brightness(0.8)');
  assert.equal(state.hitTest.status, 'no-hit'); assert.equal(state.hitTarget, null);
  assert(state.ancestors.length <= 6); assert.equal(JSON.stringify(parent.style), before);
});

for (const disabled of ['aria-disabled', 'inert']) test(disabled + ' custom month is blocked on prepare', async () => {
  const h = pageHarness(); calendar(h, { disabled });
  const item = onlyOctober(await snap(h, { name: '10月', exact: true }));
  const result = await h.agent.prepare(item.ref); assert.equal(result.__zcodeCode, 'ELEMENT_DISABLED', JSON.stringify(result));
});

test('hidden pointer month is excluded', async () => {
  const h = pageHarness(); calendar(h, { hidden: true });
  assert.equal((await snap(h, { name: '10月', exact: true })).elements.length, 0);
});

test('exact custom query reaches a month beyond 1600 ordinary actions', async () => {
  const h = pageHarness(); for (let i = 0; i < 1600; i++) h.node('button', {}, 'Action ' + i);
  calendar(h); onlyOctober(await snap(h, { name: '10月', exact: true }));
});

test('agent9 upgrades a nonconfigurable legacy agent8 without replacing its global', async () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../page-agent.js'), 'utf8');
  const legacySource = "Object.defineProperty(globalThis,'__aiBrowserPageAgent8',{value:Object.freeze({snapshot:async()=>({legacy:true}),hideCursor:()=>{}}),configurable:false,writable:false});";
  const alternate = new Module(harnessPath, module); alternate.filename=harnessPath; alternate.paths=module.paths;
  const legacyHarness = harnessSource.replace(/const pageSource = [^;]+;/, 'const pageSource = ' + JSON.stringify(legacySource) + ';');
  alternate._compile(legacyHarness + '\nmodule.exports=pageHarness;', harnessPath);
  const h = alternate.exports(); const old = h.context.__aiBrowserPageAgent8; calendar(h);
  vm.runInContext(source, h.context); const fresh = h.context.__aiBrowserPageAgent9;
  assert(fresh && fresh !== old); assert.equal(h.context.__aiBrowserPageAgent8, old);
  const result = ok(await fresh.snapshot({load:'current',name:'10月',exact:true})); onlyOctober(result);
  vm.runInContext(source,h.context); assert.equal(h.context.__aiBrowserPageAgent9,fresh);
  assert.equal(ok(await fresh.prepare(result.elements[0].ref)).target.name,'10月');
});

test('custom controls participate in scope and stable cursor pagination', async () => {
  const h = pageHarness(); const main = h.node('main');
  for (let i = 0; i < 155; i++) { const node = h.node('div', {}, 'Choice ' + i, main); node.style.cursor = 'pointer'; }
  const outside = h.node('div', {}, 'Choice outside'); outside.style.cursor = 'pointer';
  let result = await snap(h, { name: 'Choice ', scope: 'main' });
  assert.equal(result.pagination.total, 155); assert.equal(result.elements.length, 150);
  const refs = result.elements.map(item => item.ref);
  result = ok(await h.agent.snapshot({ cursor: result.pagination.nextCursor, load: 'current' }));
  assert.equal(result.elements.length, 5); assert.equal(result.pagination.hasMore, false);
  assert.equal(new Set([...refs, ...result.elements.map(item => item.ref)]).size, 155);
  assert(result.elements.every(item => item.name !== 'Choice outside'));
});
