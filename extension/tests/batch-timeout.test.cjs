'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');
const tick = () => new Promise(resolve => setImmediate(resolve));

// Exercise the production outer wrapper, not execute(batch) alone; all APIs and timers are isolated.
function harness() {
  const timers = new Map(), pending = new Map(), scripts = []; let timerId = 0;
  const tabs = [7, 9, 10].map(id => ({ id, windowId: 1, url: 'https://fixture.test/', status: id === 9 ? 'loading' : 'complete', frozen: false, discarded: false, active: false }));
  const event = { addListener() {} };
  const chrome = {
    runtime: { id: 'fixture', getManifest: () => ({ name: 'Fixture', version: '0.16.2' }), onMessage: event, onInstalled: event, onStartup: event },
    storage: { local: { get: async () => ({ disconnected: true, autoAuthorize: true }), set: async () => {} }, session: { get: async () => ({}), set: async () => {} } },
    tabs: { get: async id => tabs.find(tab => tab.id === id), query: async () => tabs, onRemoved: event },
    debugger: { onDetach: event }, alarms: { create: async () => {}, onAlarm: event },
    scripting: { executeScript: async spec => {
      scripts.push(spec);
      if (spec.files) {
        if (pending.has(spec.target.tabId)) return new Promise(resolve => pending.get(spec.target.tabId).push(resolve));
        return [{ frameId: 0, documentId: 'fixture-document' }];
      }
      return [{ frameId: 0, documentId: 'fixture-document', result: { protocol: 'ai-browser-page-rpc-v1', ok: true, payload: { title: 'Fixture', elements: [] }, diagnostic: { agentPresent: true, resultKind: 'object', stage: 'serialize' } } }];
    } }
  };
  const context = vm.createContext({ chrome, URL, AbortController, TextEncoder,
    setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => timers.delete(id), fetch: async () => { throw new Error('Unexpected network'); } });
  const run = code => vm.runInContext(code, context);
  context.importScripts = name => run(fs.readFileSync(path.resolve(__dirname, '..', name), 'utf8'));
  run(fs.readFileSync(path.resolve(__dirname, '../background.js'), 'utf8'));
  return { run, timers, pending, scripts, tabs,
    expire: () => { for (const [id, timer] of [...timers]) if (timer.ms === 11000) { timers.delete(id); timer.fn(); } },
    release: id => { const resolvers = pending.get(id) || []; pending.delete(id); for (const resolve of resolvers) resolve([{ frameId: 0, documentId: 'fixture-document' }]); } };
}

test('production batch retains fast result and child timeout with its phase and ID', async () => {
  const h = harness(); await tick(); h.run('wantDisconnect = false'); h.pending.set(9, []);
  const work = h.run("executeBounded({id:'parent',method:'batch',params:{commands:[{method:'snapshot',params:{tabId:7,load:'current'}},{method:'snapshot',params:{tabId:9,load:'current'}}]}})");
  await tick();
  assert.equal([...h.timers.values()].filter(timer => timer.ms === 11000).length, 1, 'only unresolved child has a deadline; no racing parent deadline');
  h.expire(); const response = await work;
  assert.equal(response.results[0].ok, true);
  const failure = response.results[1].error;
  assert.equal(failure.code, 'COMMAND_TIMEOUT'); assert.equal(failure.commandId, 'parent-1');
  assert.equal(failure.diagnostic.phase, 'scripting.inject'); assert.equal(failure.diagnostic.tabStatus, 'loading');
  assert.equal(failure.diagnostic.frozen, false);
  const before = h.scripts.length;
  await assert.rejects(h.run("executeBounded({id:'blocked',method:'fill',params:{tabId:9,ref:'r1-1',text:'do not write'}})"), error => error.code === 'TAB_BUSY' && error.outcome === 'not-dispatched');
  assert.equal(h.scripts.length, before);
  const listing = await h.run('listTabs()'); const tab = listing.find(item => item.id === 9);
  assert.equal(tab.operation.commandId, 'parent-1'); assert.equal(tab.operation.timedOut, true); assert.equal(tab.operation.phase, 'scripting.inject');
  h.release(9); await tick();
  assert.equal(h.run('runningTabs.has(9)'), false);
  assert.equal(h.scripts.filter(spec => spec.target.tabId === 9 && !spec.files).length, 0, 'late injection cannot invoke snapshot or any write');
});

test('incident-shaped busy sibling and hung sibling both survive the production batch', async () => {
  const h = harness(); await tick(); h.run('wantDisconnect = false'); h.pending.set(7, []); h.pending.set(9, []);
  const previous = h.run("executeBounded({id:'old-command',method:'snapshot',params:{tabId:7,load:'current'}})");
  const oldFailure = assert.rejects(previous, error => error.code === 'timeout'); await tick(); h.expire(); await oldFailure;
  const response = h.run("executeBounded({id:'incident',method:'batch',params:{commands:[{method:'snapshot',params:{tabId:7,load:'current'}},{method:'snapshot',params:{tabId:9,load:'current'}}]}})");
  await tick(); h.expire(); const result = await response;
  assert.equal(result.results[0].error.code, 'TAB_BUSY'); assert.equal(result.results[0].error.commandId, 'incident-0');
  assert.equal(result.results[1].error.code, 'COMMAND_TIMEOUT'); assert.equal(result.results[1].error.commandId, 'incident-1');
  assert.equal(h.scripts.filter(spec => spec.target.tabId === 7).length, 1, 'busy child never reinjects');
  h.release(7); h.release(9); await tick(); assert.equal(h.run('runningTabs.size'), 0);
});

test('all timed-out children settle independently and no late writes are replayed', async () => {
  const h = harness(); await tick(); h.run('wantDisconnect = false'); h.pending.set(7, []); h.pending.set(9, []);
  const work = h.run("executeBounded({id:'writes',method:'batch',params:{commands:[{method:'fill',params:{tabId:7,ref:'r1-1',text:'private'}},{method:'click',params:{tabId:9,ref:'r1-1'}}]}})");
  await tick(); h.expire(); const result = await work;
  assert.equal(result.results.length, 2); assert(result.results.every(item => item.error.code === 'COMMAND_TIMEOUT'));
  h.release(7); h.release(9); await tick();
  assert.equal(h.scripts.filter(spec => !spec.files).length, 0);
  assert.equal(h.run('runningTabs.size'), 0);
});

test('file injection and same-document invocation run immediately without changing tab activation', async () => {
  const h = harness(); await tick(); h.run('wantDisconnect = false');
  await h.run("executeBounded({id:'immediate',method:'snapshot',params:{tabId:7,load:'current'}})");
  assert.equal(h.scripts.length, 2); assert(h.scripts.every(spec => spec.injectImmediately === true));
  assert.deepEqual(Array.from(h.scripts[1].target.documentIds), ['fixture-document']);
  assert(h.tabs.every(tab => tab.active === false));
});

test('listTabs exposes known lifecycle state and omits unavailable lifecycle fields', async () => {
  const h = harness(); await tick(); h.run('wantDisconnect = false'); delete h.tabs[0].frozen; delete h.tabs[0].status;
  h.tabs[1].frozen = true; h.tabs[1].autoDiscardable = false;
  const list = await h.run('listTabs()');
  assert.equal(Object.hasOwn(list[0], 'frozen'), false); assert.equal(Object.hasOwn(list[0], 'status'), false);
  assert.equal(list[1].frozen, true); assert.equal(list[1].discarded, false);
  assert.equal(list[1].autoDiscardable, false); assert.equal(Object.hasOwn(list[0], 'autoDiscardable'), false);
  assert.equal(list[0].operation, undefined);
});

test('known-frozen DOM commands reject before any injection and leave no unfinished operation', async () => {
  const h = harness(); await tick(); h.run('wantDisconnect = false'); h.tabs[0].frozen = true; h.tabs[0].active = true;
  for (const method of ['snapshot','fill','click','inspect','scroll','wait','focus']) {
    await assert.rejects(h.run("executeBounded({id:'frozen-" + method + "',method:'" + method + "',params:{tabId:7,ref:'r1-1',text:'private',key:'Enter',load:'current'}})"), error => {
      assert.equal(error.code, 'TAB_FROZEN'); assert.equal(error.outcome, 'not-dispatched');
      assert.equal(error.diagnostic.stage, 'preflight'); assert.equal(error.diagnostic.frozen, true);
      return true;
    });
  }
  assert.equal(h.scripts.length, 0);
  assert.equal(h.run('runningTabs.size'), 0); assert.equal(h.run('runningOperations.size'), 0);
  assert.equal([...h.timers.values()].filter(timer => timer.ms === 11000).length, 0);
});

test('frozen sibling is reported immediately and a healthy sibling still succeeds', async () => {
  const h = harness(); await tick(); h.run('wantDisconnect = false'); h.tabs[0].frozen = true;
  const result = await h.run("executeBounded({id:'mixed-frozen',method:'batch',params:{commands:[{method:'snapshot',params:{tabId:7,load:'current'}},{method:'snapshot',params:{tabId:9,load:'current'}}]}})");
  assert.equal(result.results[0].error.code, 'TAB_FROZEN'); assert.equal(result.results[0].error.outcome, 'not-dispatched');
  assert.equal(result.results[0].error.commandId, 'mixed-frozen-0'); assert.equal(result.results[1].ok, true);
  assert.equal(h.scripts.filter(spec => spec.target.tabId === 7).length, 0);
  h.tabs[0].frozen = false;
  assert.equal((await h.run("executeBounded({id:'fresh-after-wake',method:'snapshot',params:{tabId:7,load:'current'}})")).title, 'Fixture');
});

test('freeze between injection and invocation prevents entering the page method', async () => {
  const h = harness(); await tick(); h.run('wantDisconnect = false');
  h.run("globalThis.nativeScript=chrome.scripting.executeScript;chrome.scripting.executeScript=async spec=>{const result=await nativeScript(spec);if(spec.files)(await chrome.tabs.get(7)).frozen=true;return result;}");
  await assert.rejects(h.run("executeBounded({id:'freeze-midway',method:'fill',params:{tabId:7,ref:'r1-1',text:'private'}})"), error => error.code === 'TAB_FROZEN' && error.outcome === 'not-dispatched');
  assert.equal(h.scripts.length, 1); assert(h.scripts[0].files);
  assert.equal(h.run('runningTabs.size'), 0);
});

test('discarded DOM target is distinguished without implicit reload or injection', async () => {
  const h = harness(); await tick(); h.run('wantDisconnect = false'); h.tabs[0].discarded = true;
  await assert.rejects(h.run("executeBounded({id:'discarded',method:'snapshot',params:{tabId:7,load:'current'}})"), error => error.code === 'TAB_DISCARDED' && error.outcome === 'not-dispatched' && error.diagnostic.discarded === true);
  assert.equal(h.scripts.length, 0); assert.equal(h.run('runningTabs.size'), 0);
});

test('a known-frozen state does not relabel previously entered page work as not dispatched', async () => {
  const h = harness(); await tick(); h.run('wantDisconnect = false'); h.tabs[0].frozen = true;
  await assert.rejects(h.run("pageAgent(7,'domFill',{ref:'r1-1',text:'private'},Object.assign(()=>{},{pageWorkStarted:true,diagnostic:{commandId:'later-stage',method:'fill',tabId:7}}))"), error => error.code === 'TAB_FROZEN' && error.outcome === 'unverified');
  assert.equal(h.scripts.length, 0);
});
