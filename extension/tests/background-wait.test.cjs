'use strict';
// Exercise production executeBounded, execute, pageAgent and waitForCondition together.
// Only Chrome native boundaries and the worker clock are isolated; no coordinator mock.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');
const tick = () => new Promise(resolve => setImmediate(resolve));
const plain = value => JSON.parse(JSON.stringify(value));
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
function harness() {
  let now = 100000, serial = 0, command = 0;
  const timers = new Map(), calls = [], hooks = {};
  const tab = { id: 7, windowId: 1, url: 'https://fixture.test/wait', status: 'complete', frozen: false, discarded: false, active: false };
  const event = { addListener() {} };
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const context = vm.createContext({ URL, AbortController, TextEncoder, Date: Clock,
    setTimeout: (fn, ms) => { const id = ++serial; timers.set(id, { fn, ms, at: now + ms }); return id; },
    clearTimeout: id => timers.delete(id),
    fetch: async () => { throw new Error('No private or default bridge is allowed in VM tests'); },
    chrome: {
      runtime: { id: 'wait-fixture', getManifest: () => ({ name: 'Wait fixture', version: '0.16.2' }), getURL: name => 'chrome-extension://wait-fixture/' + name, onMessage: event, onInstalled: event, onStartup: event },
      storage: { local: { get: async () => ({ disconnected: true, autoAuthorize: true, cdpEnabled: false, screenshotCdpEnabled: false, lifecycleWakeEnabled: false }), set: async () => {} }, session: { get: async () => ({}), set: async () => {} } },
      tabs: { get: async id => { calls.push({ kind: 'get', id }); return { ...tab }; }, query: async () => [{ ...tab }], onRemoved: event,
        update: async () => { throw new Error('Unexpected page update'); }, reload: async () => { throw new Error('Unexpected reload'); } },
      debugger: { onDetach: event, attach: async () => { throw new Error('Unexpected debugger attach'); } },
      scripting: { executeScript: async spec => {
        calls.push({ kind: spec.files ? 'inject' : 'invoke', spec });
        if (hooks.script) { const answer = hooks.script(spec); if (answer !== undefined) return answer; }
        const documentId = hooks.documentId ? hooks.documentId(spec) : 'doc-7';
        if (spec.files) return [{ frameId: 0, documentId }];
        const count = calls.filter(call => call.kind === 'invoke').length;
        const payload = hooks.payload ? hooks.payload(spec, count) : { matched: false, visible: false, elapsedMs: 0, timedOut: true };
        return [{ frameId: 0, documentId, result: { protocol: 'ai-browser-page-rpc-v1', ok: true, payload, diagnostic: { stage: 'serialize', agentPresent: true, resultKind: 'object' } } }];
      } },
      alarms: { create: async () => {}, onAlarm: event }
    }
  });
  const run = code => vm.runInContext(code, context);
  context.importScripts = name => run(fs.readFileSync(path.resolve(__dirname, '..', name), 'utf8'));
  run(fs.readFileSync(path.resolve(__dirname, '../background.js'), 'utf8'));
  return { calls, hooks, tab, timers, run, get now() { return now; },
    ready: async () => { await run('ready'); await tick(); run('wantDisconnect=false'); },
    exec: (params = {}, method = 'wait') => run('executeBounded(' + JSON.stringify({ id: 'wait-qa-' + ++command, method, params: { tabId: 7, name: 'Absent fixture', timeoutMs: 500, ...params } }) + ')'),
    jump: ms => { now += ms; },
    advance: async (maximum = 5000) => { const next = [...timers].filter(([, t]) => t.ms <= maximum).sort((a,b) => a[1].at-b[1].at)[0]; if (!next) return false; timers.delete(next[0]); now = Math.max(now, next[1].at); next[1].fn(); await tick(); return true; },
    outer: async () => { const entry = [...timers].find(([,t]) => t.ms === 11000); assert(entry, 'actual outer deadline exists'); timers.delete(entry[0]); now = Math.max(now, entry[1].at); entry[1].fn(); await tick(); }
  };
}
async function settle(h, promise) { let done = false; promise.then(() => { done = true; }, () => { done = true; }); for (let n = 0; n < 100 && !done; n++) { await tick(); if (!done) await h.advance(); } assert(done, 'worker wait must settle within its requested deadline'); return promise; }
const invoked = h => h.calls.filter(c => c.kind === 'invoke');
const unlocked = h => { assert.equal(h.run('runningTabs.size'), 0); assert.equal(h.run('runningOperations.size'), 0); assert.equal(h.run('tabQueues.size'), 0); };
function envelope(payload) { return [{ frameId: 0, documentId: 'doc-7', result: { protocol: 'ai-browser-page-rpc-v1', ok: true, payload, diagnostic: { stage: 'serialize', agentPresent: true, resultKind: 'object' } } }]; }

test('absent condition obeys worker deadline and every page probe is immediate', async () => {
  const h = harness(); await h.ready(); const started = h.now;
  const result = await settle(h, h.exec());
  assert.equal(result.matched, false); assert.equal(result.timedOut, true); assert.equal(result.elapsedMs, 500); assert.equal(h.now - started, 500);
  assert.equal(invoked(h).length, 5); for (const {spec} of invoked(h)) { assert.equal(spec.args[0], 'waitFor'); assert.equal(spec.args[1].timeoutMs, 0); }
  unlocked(h);
});
test('later condition succeeds and returns total elapsed time without another probe', async () => {
  const h = harness(); await h.ready(); h.hooks.payload = (_, n) => ({ matched: n === 3, visible: n === 3, elapsedMs: 0, timedOut: n !== 3 });
  const result = await settle(h, h.exec()); assert.equal(result.matched, true); assert.equal(result.timedOut, false); assert.equal(result.elapsedMs, 200); assert.equal(invoked(h).length, 3); unlocked(h);
});
test('zero deadline performs one immediate condition check', async () => {
  const h = harness(); await h.ready(); const result = await h.exec({ timeoutMs: 0 }); assert.equal(result.matched, false); assert.equal(result.elapsedMs, 0); assert.equal(invoked(h).length, 1); unlocked(h);
});
test('ref waits preserve the same ref and expectedContext and never call snapshot', async () => {
  const h = harness(); await h.ready(); await settle(h, h.exec({ name: undefined, ref: 'stable-ref-17', expectedContext: 'fixture row', state: 'enabled' }));
  for (const {spec} of invoked(h)) { assert.equal(spec.args[0], 'waitFor'); assert.deepEqual(plain(spec.args[1]), { tabId: 7, timeoutMs: 0, ref: 'stable-ref-17', expectedContext: 'fixture row', state: 'enabled' }); } unlocked(h);
});
test('freeze after completed probe refuses new dispatch and releases all locks', async () => {
  const h = harness(); await h.ready(); h.hooks.payload = () => { h.tab.frozen = true; return { matched: false }; };
  const error = await settle(h, h.exec()).catch(error => error); assert.equal(error.code, 'TAB_FROZEN'); assert.equal(error.outcome, 'unverified'); assert.equal(error.diagnostic.frozen, true);
  assert.equal(invoked(h).length, 1); assert.equal(h.calls.filter(c => c.kind === 'inject').length, 1); unlocked(h);
  h.tab.frozen = false; h.hooks.payload = () => ({ matched: true }); assert.equal((await h.exec()).matched, true); unlocked(h);
});
test('same-document URL navigation rejects the next probe before injection', async () => {
  const h = harness(); await h.ready(); h.hooks.payload = () => { h.tab.url += '#changed'; return { matched: false }; };
  const error = await settle(h, h.exec()).catch(error => error); assert.equal(error.code, 'PAGE_AGENT_DOCUMENT_CHANGED'); assert.equal(error.diagnostic.documentChanged, true); assert.equal(invoked(h).length, 1); assert.equal(h.calls.filter(c => c.kind === 'inject').length, 1); unlocked(h);
});
test('same URL with replacement document rejects before invoking new document', async () => {
  const h = harness(); await h.ready(); h.hooks.documentId = () => h.calls.filter(c => c.kind === 'inject').length >= 2 ? 'replacement-doc' : 'doc-7';
  const error = await settle(h, h.exec()).catch(error => error); assert.equal(error.code, 'PAGE_AGENT_DOCUMENT_CHANGED'); assert.equal(invoked(h).length, 1); assert.equal(h.calls.filter(c => c.kind === 'inject').length, 2); unlocked(h);
});
test('expensive native probe is never overlapped or replaced at requested deadline', async () => {
  const h = harness(); await h.ready(); const held = deferred(); h.hooks.script = spec => spec.files ? undefined : held.promise;
  const pending = h.exec(); await tick(); h.jump(700); await tick(); assert.equal(invoked(h).length, 1);
  await assert.rejects(h.exec(), error => error.code === 'TAB_BUSY'); assert.equal(invoked(h).length, 1);
  held.resolve(envelope({ matched: false })); const result = await pending; assert.equal(result.matched, false); assert.equal(result.elapsedMs, 700); assert.equal(result.timedOut, true); unlocked(h);
});
test('hanging native probe retains busy after outer timeout until raw settlement', async () => {
  const h = harness(); await h.ready(); const held = deferred(); h.hooks.script = spec => spec.files ? undefined : held.promise;
  const pending = h.exec().catch(error => error); await tick(); await h.outer(); const error = await pending; assert.equal(error.code, 'timeout'); assert.equal(error.diagnostic.phase, 'waitFor');
  assert.equal(h.run('runningTabs.has(7)'), true); assert.equal(h.run('runningOperations.get(7).timedOut'), true);
  await assert.rejects(h.exec(), error => error.code === 'TAB_BUSY' && error.outcome === 'not-dispatched'); assert.equal(invoked(h).length, 1);
  held.resolve(envelope({ matched: false })); await tick(); unlocked(h); assert.equal(invoked(h).length, 1);
});
test('connection invalidation during poll sleep stops further page probes', async () => {
  const h = harness(); await h.ready(); const pending = h.exec().catch(error => error); await tick(); h.run('connectionEpoch++'); await h.advance(); const error = await pending; assert.equal(error.code, 'invalidated'); assert.equal(invoked(h).length, 1); unlocked(h);
});
