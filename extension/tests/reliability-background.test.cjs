'use strict';
// Production worker orchestration; native APIs, events and time are private deterministic fixtures.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');
const tick = () => new Promise(resolve => setImmediate(resolve));
const plain = value => JSON.parse(JSON.stringify(value));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness(settings = {}) {
  const calls = [], hooks = {}, timers = new Map(), listeners = {};
  const tabs = new Map([7, 9, 10, 11].map(id => [id, {
    id, windowId: 1, url: 'https://fixture.test/' + id, status: 'complete',
    frozen: false, discarded: false, active: false
  }]));
  let now = 100000, serial = 0, command = 0;
  const event = name => ({ addListener: listener => { listeners[name] = listener; } });
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const envelope = (id, payload) => [{ frameId: 0, documentId: 'doc-' + id, result: {
    protocol: 'ai-browser-page-rpc-v1', ok: true, payload,
    diagnostic: { stage: 'serialize', agentPresent: true, resultKind: 'object' }
  } }];
  const chrome = {
    runtime: { id: 'reliability-fixture', getManifest: () => ({ version: 'fixture', name: 'Fixture' }),
      getURL: name => 'chrome-extension://reliability-fixture/' + name,
      onMessage: event('message'), onInstalled: event('installed'), onStartup: event('startup') },
    storage: { local: { get: async () => ({ disconnected: true, autoAuthorize: true, cdpEnabled: true,
      screenshotCdpEnabled: true, lifecycleWakeEnabled: true, ...settings }), set: async () => {} },
      session: { get: async () => ({}), set: async () => {} } },
    tabs: { get: async id => {
      calls.push({ kind: 'get', tabId: id });
      if (hooks.get) { const result = hooks.get(id); if (result !== undefined) return result; }
      if (!tabs.has(id)) throw new Error('No tab with id: ' + id);
      return { ...tabs.get(id) };
    }, query: async () => [...tabs.values()].map(tab => ({ ...tab })), onRemoved: event('removed'),
      update: async () => { throw new Error('Forbidden page navigation'); },
      reload: async () => { throw new Error('Forbidden reload'); } },
    debugger: { onDetach: event('detach'), attach: async target => {
      calls.push({ kind: 'attach', tabId: target.tabId }); if (hooks.attach) return hooks.attach(target);
    }, detach: async target => {
      calls.push({ kind: 'detach', tabId: target.tabId });
      if (hooks.detach) await hooks.detach(target);
      listeners.detach(target);
    }, sendCommand: async (target, method, params) => {
      calls.push({ kind: 'cdp', tabId: target.tabId, method, params: plain(params) });
      if (hooks.send) { const result = hooks.send(target, method, params); if (result !== undefined) return result; }
      if (method === 'Page.setWebLifecycleState') tabs.get(target.tabId).frozen = false;
      return method === 'Page.captureScreenshot' ? { data: 'PRIVATE-PNG' } : {};
    } },
    scripting: { executeScript: async spec => {
      calls.push({ kind: spec.files ? 'inject' : 'invoke', tabId: spec.target.tabId, spec });
      if (hooks.script) { const result = hooks.script(spec); if (result !== undefined) return result; }
      if (spec.files) return [{ frameId: 0, documentId: 'doc-' + spec.target.tabId }];
      return envelope(spec.target.tabId, spec.args[0] === 'prepare' ? { x: 20, y: 30, target: 'Fixture' } :
        spec.args[0] === 'snapshot' ? { title: 'Fixture', elements: [] } :
        spec.args[0] === 'waitFor' ? { matched: true, visible: true } : { focused: true });
    } },
    alarms: { create: async () => {}, onAlarm: event('alarm') }
  };
  const context = vm.createContext({ chrome, URL, AbortController, TextEncoder, Date: Clock,
    setTimeout: (fn, ms) => { const id = ++serial; timers.set(id, { fn, ms, at: now + ms }); return id; },
    clearTimeout: id => timers.delete(id), fetch: async () => { throw new Error('Forbidden network'); } });
  const run = code => vm.runInContext(code, context);
  context.importScripts = name => run(fs.readFileSync(path.resolve(__dirname, '..', name), 'utf8'));
  run(fs.readFileSync(path.resolve(__dirname, '../background.js'), 'utf8'));
  return { calls, hooks, tabs, timers, listeners, envelope, run,
    ready: async () => { await run('ready'); await tick(); run('wantDisconnect = false'); },
    popup: message => run('handlePopup(' + JSON.stringify(message) + ')'),
    exec: (method = 'snapshot', params = {}) => run('executeBounded(' + JSON.stringify({ id: 'reliable-' + ++command, method,
      params: { ...(['batch', 'list_tabs'].includes(method) ? {} : { tabId: 7 }), ...params } }) + ')'),
    fire: ms => { for (const [id, timer] of [...timers]) if (timer.ms === ms) {
      timers.delete(id); now = Math.max(now, timer.at); timer.fn();
    } },
    jump: ms => { now += ms; }
  };
}
const entries = (h, kind) => h.calls.filter(call => call.kind === kind);
function unlocked(h) {
  assert.equal(h.run('runningTabs.size'), 0);
  assert.equal(h.run('runningOperations.size'), 0);
  assert.equal(h.run('tabQueues.size'), 0);
}

test('pending mouse-release raw promise retains the tab lock through every timeout', async () => {
  const h = harness(); await h.ready(); const gate = deferred();
  h.hooks.send = (_, method, params) => method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased' ? gate.promise : undefined;
  const work = h.exec('click', { ref: 'r1-1', mode: 'cdp' }).catch(error => error);
  await tick(); assert(entries(h, 'cdp').some(call => call.params.type === 'mouseReleased'));
  h.fire(1000); await tick();
  assert.equal(h.run('runningTabs.has(7)'), true, 'cleanup timeout cannot release a still-running native operation');
  await assert.rejects(h.exec('fill', { ref: 'r1-1', text: 'never' }), error => error.code === 'TAB_BUSY');
  h.fire(11000); await tick(); assert.equal((await work).code, 'timeout');
  assert.equal(h.run('runningTabs.has(7)'), true);
  gate.resolve({}); await tick(); unlocked(h);
  assert.equal(entries(h, 'cdp').filter(call => call.params.type === 'mouseReleased').length, 1);
});

test('input disable/re-enable during preparation cannot grant an old command a new CDP generation', async () => {
  const h = harness(); await h.ready(); const gate = deferred();
  h.hooks.script = spec => !spec.files && spec.args[0] === 'prepare' ? gate.promise : undefined;
  const work = h.exec('fill', { ref: 'r1-1', text: 'never', mode: 'cdp' }).catch(error => error);
  await tick(); const disable = h.popup({ type: 'set_cdp_enabled', enabled: false }); await tick();
  await h.popup({ type: 'set_cdp_enabled', enabled: true });
  h.hooks.script = undefined; gate.resolve(h.envelope(7, { x: 20, y: 30 }));
  const error = await work; await disable;
  assert.equal(error.code, 'CDP_DISABLED');
  assert.equal(entries(h, 'cdp').length, 0, 'old input cannot resume under renewed permission');
  unlocked(h);
});

test('screenshot revoked and renewed during native capture cannot publish its stale result', async () => {
  const h = harness(); await h.ready(); const gate = deferred();
  h.hooks.send = (_, method) => method === 'Page.captureScreenshot' ? gate.promise : undefined;
  const work = h.exec('screenshot').catch(error => error); await tick();
  await h.popup({ type: 'set_screenshot_cdp_enabled', enabled: false });
  await h.popup({ type: 'set_screenshot_cdp_enabled', enabled: true });
  gate.resolve({ data: 'PRIVATE-PNG' }); const error = await work;
  assert.equal(error.code, 'CDP_DISABLED'); assert.equal(error.data, undefined);
  assert.equal(entries(h, 'detach').length, 1); assert.equal(h.run('attached.size'), 0); unlocked(h);
});

test('default input mode cannot turn a revoked pending attach into a late DOM fallback', async () => {
  const h = harness(); await h.ready(); const gate = deferred(); h.hooks.attach = () => gate.promise;
  const work = h.exec('fill', { ref: 'r1-1', text: 'never' }).catch(error => error); await tick();
  await h.popup({ type: 'set_cdp_enabled', enabled: false });
  await h.popup({ type: 'set_cdp_enabled', enabled: true });
  gate.resolve(); const error = await work;
  assert.equal(error.code, 'CDP_DISABLED');
  assert.equal(entries(h, 'invoke').length, 0, 'revocation is not an attach capability failure');
  assert.equal(entries(h, 'cdp').length, 0); assert.equal(h.run('attached.size'), 0); unlocked(h);
});

test('input attach settling after outer deadline cleans its owned attachment without late page work', async () => {
  const h = harness(); await h.ready(); const gate = deferred(); h.hooks.attach = () => gate.promise;
  const work = h.exec('fill', { ref: 'r1-1', text: 'never', mode: 'cdp' }).catch(error => error); await tick();
  h.fire(11000); assert.equal((await work).code, 'timeout');
  await assert.rejects(h.exec(), error => error.code === 'TAB_BUSY');
  gate.resolve(); await tick();
  assert.equal(entries(h, 'invoke').length, 0); assert.equal(entries(h, 'cdp').length, 0);
  assert.equal(entries(h, 'detach').length, 1); assert.equal(h.run('attached.size'), 0); unlocked(h);
});


for (const [name, mutate, expected] of [
  ['freeze', h => { h.tabs.get(7).frozen = true; }, 'TAB_FROZEN'],
  ['discard', h => { h.tabs.get(7).discarded = true; }, 'TAB_DISCARDED'],
  ['navigation', h => { h.tabs.get(7).url += '#new'; }, 'PAGE_AGENT_DOCUMENT_CHANGED'],
  ['window move', h => { h.tabs.get(7).windowId = 2; }, 'PAGE_AGENT_DOCUMENT_CHANGED'],
  ['revoke', h => { h.run('revoked.add(7)'); }, null],
  ['epoch', h => { h.run('connectionEpoch++'); }, 'invalidated'],
  ['tab close', h => { h.tabs.delete(7); h.listeners.removed(7); }, null]
]) for (const point of ['inject', 'invoke']) {
  test('wait ' + name + ' during native ' + point + ' cannot accept an old match or continue probing', async () => {
    const h = harness({ lifecycleWakeEnabled: false }); await h.ready(); const gate = deferred();
    h.hooks.script = spec => (point === 'inject' ? !!spec.files : !spec.files) ? gate.promise : undefined;
    const work = h.exec('wait', { name: 'Fixture', timeoutMs: 0 }).catch(error => error); await tick();
    mutate(h);
    gate.resolve(point === 'inject' ? [{ frameId: 0, documentId: 'doc-7' }] : h.envelope(7, { matched: true }));
    const error = await work;
    if (expected) assert.equal(error.code, expected); else assert.match(error.message, /授权|释放|No tab/);
    assert.equal(entries(h, 'invoke').length, point === 'inject' ? 0 : 1);
    assert.equal(entries(h, 'attach').length, 0); unlocked(h);
  });
}

test('known native document replacement in a same-URL invocation is rejected without replay', async () => {
  const h = harness(); await h.ready();
  h.hooks.script = spec => spec.files ? undefined : [{ ...h.envelope(7, { matched: true })[0], documentId: 'replacement' }];
  const error = await h.exec('wait', { name: 'Fixture', timeoutMs: 0 }).catch(error => error);
  assert.equal(error.code, 'PAGE_AGENT_DOCUMENT_CHANGED'); assert.equal(error.diagnostic.documentChanged, true);
  assert.equal(entries(h, 'invoke').length, 1); unlocked(h);
});

for (const owner of ['screenshot', 'lifecycle']) {
  test('pending ' + owner + ' detach keeps raw ownership after outer deadline until settlement', async () => {
    const h = harness(); await h.ready(); const gate = deferred();
    if (owner === 'lifecycle') h.tabs.get(7).frozen = true;
    h.hooks.detach = () => gate.promise;
    const work = h.exec(owner === 'screenshot' ? 'screenshot' : 'snapshot').catch(error => error); await tick();
    assert.equal(entries(h, 'detach').length, 1);
    h.fire(11000); assert.equal((await work).code, 'timeout');
    await assert.rejects(h.exec('fill', { ref: 'r1-1', text: 'never' }), error => error.code === 'TAB_BUSY');
    assert.equal(h.run('attached.has(7)'), true);
    gate.resolve(); await tick();
    assert.equal(h.run('attached.size'), 0); assert.equal(h.run('lifecycleAttachments.size'), 0);
    assert.equal(entries(h, 'invoke').length, 0); assert.equal(entries(h, 'detach').length, 1); unlocked(h);
  });
}

for (const settle of ['resolve', 'reject']) {
  test('mouse-release ' + settle + ' settles exactly once after timeout and leaves fresh commands usable', async () => {
    const h = harness(); await h.ready(); const gate = deferred();
    h.hooks.send = (_, method, params) => method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased' ? gate.promise : undefined;
    const work = h.exec('click', { ref: 'r1-1' }).catch(error => error); await tick();
    h.fire(11000); assert.equal((await work).code, 'timeout');
    if (settle === 'resolve') gate.resolve({}); else gate.reject(new Error('private cleanup rejection'));
    await tick(); unlocked(h); h.hooks.send = undefined;
    assert.equal((await h.exec()).title, 'Fixture'); unlocked(h);
    assert.equal(entries(h, 'cdp').filter(call => call.params.type === 'mousePressed').length, 1);
    assert.equal(entries(h, 'cdp').filter(call => call.params.type === 'mouseReleased').length, 1);
  });
}

for (const borrowed of [false, true]) for (const mutation of ['permission', 'epoch', 'revoke']) {
  test('screenshot ' + mutation + ' during capture preserves attachment owner borrowed=' + borrowed, async () => {
    const h = harness(); await h.ready(); const gate = deferred(); if (borrowed) h.run('attached.add(7)');
    h.hooks.send = (_, method) => method === 'Page.captureScreenshot' ? gate.promise : undefined;
    const work = h.exec('screenshot').catch(error => error); await tick();
    if (mutation === 'permission') await h.popup({ type: 'set_screenshot_cdp_enabled', enabled: false });
    else if (mutation === 'epoch') h.run('connectionEpoch++');
    else h.run('revoked.add(7)');
    gate.resolve({ data: 'PRIVATE-PNG' }); const error = await work;
    assert.equal(error.data, undefined);
    if (mutation === 'permission') assert.equal(error.code, 'CDP_DISABLED');
    else if (mutation === 'epoch') assert.equal(error.code, 'invalidated');
    else assert.match(error.message, /释放|授权/);
    assert.equal(entries(h, 'detach').length, borrowed ? 0 : 1);
    assert.equal(h.run('attached.has(7)'), borrowed); unlocked(h);
  });
}

test('ordinary attach capability failure still falls back once before any input is sent', async () => {
  const h = harness(); await h.ready(); h.hooks.attach = async () => { throw new Error('fixture capability unavailable'); };
  const result = await h.exec('fill', { ref: 'r1-1', text: 'Fixture' });
  assert.equal(result.fallbackReason, 'CDP_ATTACH_FAILED'); assert.equal(entries(h, 'cdp').length, 0);
  assert.equal(entries(h, 'invoke').filter(call => call.spec.args[0] === 'domFill').length, 1); unlocked(h);
});

test('unrelated purpose generation changes do not invalidate input permission', async () => {
  const h = harness(); await h.ready(); const gate = deferred();
  h.hooks.script = spec => !spec.files && spec.args[0] === 'prepare' ? gate.promise : undefined;
  const work = h.exec('fill', { ref: 'r1-1', text: 'Fixture', mode: 'cdp' }); await tick();
  await h.popup({ type: 'set_screenshot_cdp_enabled', enabled: false });
  await h.popup({ type: 'set_lifecycle_wake_enabled', enabled: false });
  h.hooks.script = undefined; gate.resolve(h.envelope(7, { x: 20, y: 30 }));
  assert.equal((await work).filled, true);
  assert.equal(entries(h, 'cdp').filter(call => call.method === 'Input.insertText').length, 1); unlocked(h);
});

test('mixed batch preserves order and independent results while timed-out cleanup remains busy', async () => {
  const h = harness({ lifecycleWakeEnabled: false }); await h.ready(); const release = deferred(), capture = deferred();
  h.hooks.send = (target, method, params) => target.tabId === 7 && params.type === 'mouseReleased' ? release.promise :
    target.tabId === 9 && method === 'Page.captureScreenshot' ? capture.promise : undefined;
  const old = h.exec('click', { ref: 'r1-1', mode: 'cdp' }).catch(error => error); await tick();
  h.fire(11000); assert.equal((await old).code, 'timeout'); h.tabs.get(11).frozen = true;
  const batch = h.exec('batch', { commands: [
    { method: 'snapshot', params: { tabId: 7 } },
    { method: 'screenshot', params: { tabId: 9 } },
    { method: 'wait', params: { tabId: 10, name: 'Fixture', timeoutMs: 0 } },
    { method: 'fill', params: { tabId: 11, ref: 'r1-1', text: 'never', mode: 'dom' } }
  ] }); await tick();
  await h.popup({ type: 'set_screenshot_cdp_enabled', enabled: false }); capture.resolve({ data: 'PRIVATE-PNG' });
  const result = await batch;
  assert.equal(result.results.length, 4);
  assert.equal(result.results[0].error.code, 'TAB_BUSY'); assert.equal(result.results[0].error.commandId, 'reliable-2-0');
  assert.equal(result.results[1].error.code, 'CDP_DISABLED'); assert.equal(result.results[1].error.commandId, 'reliable-2-1');
  assert.equal(result.results[2].ok, true); assert.equal(result.results[2].result.matched, true);
  assert.equal(result.results[3].error.code, 'TAB_FROZEN'); assert.equal(result.results[3].error.outcome, 'not-dispatched');
  assert.equal(entries(h, 'invoke').filter(call => call.tabId === 11).length, 0);
  assert.equal(h.run('runningTabs.has(7)'), true); release.resolve({}); await tick(); unlocked(h);
  assert.equal(entries(h, 'cdp').filter(call => call.tabId === 9).length, 1);
});


test('lifecycle permission renewed during initial native lookup cannot wake an older command', async () => {
  const h = harness(); await h.ready(); h.tabs.get(7).frozen = true; const gate = deferred();
  h.hooks.get = () => gate.promise;
  const work = h.exec().catch(error => error); await tick();
  await h.popup({ type: 'set_lifecycle_wake_enabled', enabled: false });
  await h.popup({ type: 'set_lifecycle_wake_enabled', enabled: true });
  h.hooks.get = undefined; gate.resolve({ ...h.tabs.get(7) }); const error = await work;
  assert.equal(error.code, 'CDP_DISABLED'); assert.equal(entries(h, 'attach').length, 0);
  assert.equal(entries(h, 'cdp').length, 0); assert.equal(entries(h, 'invoke').length, 0); unlocked(h);
});
