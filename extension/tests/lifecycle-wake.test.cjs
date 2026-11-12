'use strict';
// Independent contract tests: real background.js + executeBounded, isolated Chrome APIs.
// No network, browser, default bridge, or production timers are used.
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

function harness(options = {}) {
  const stored = options.stored || { disconnected: true, autoAuthorize: true, cdpEnabled: false, screenshotCdpEnabled: false, lifecycleWakeEnabled: true };
  const calls = [], timers = new Map(), hooks = {}, alarmListeners = [];
  const tabs = new Map([7, 9].map(id => [id, { id, windowId: 1, url: 'https://fixture.test/' + id,
    status: 'complete', frozen: true, discarded: false, active: false, autoDiscardable: true }]));
  let serial = 0, now = 100000;
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const event = { addListener() {} };
  const chrome = {
    runtime: { id: 'wake-fixture', getManifest: () => ({ name: 'Wake Fixture', version: '0.16.2' }),
      getURL: name => 'chrome-extension://wake-fixture/' + name, onMessage: event, onInstalled: event, onStartup: event },
    storage: { local: { get: async keys => { calls.push({ kind: 'storage.get', keys }); return { ...stored }; },
      set: async values => { calls.push({ kind: 'storage.set', values: plain(values) }); Object.assign(stored, values); } },
      session: { get: async () => ({}), set: async () => {} } },
    tabs: {
      get: async id => { calls.push({ kind: 'get', tabId: id }); if (hooks.get) return hooks.get(id); return { ...tabs.get(id) }; },
      query: async () => [...tabs.values()].map(tab => ({ ...tab })), onRemoved: event,
      update: async (...args) => { calls.push({ kind: 'forbidden.tabs.update', args }); throw new Error('Unexpected tabs.update'); },
      reload: async () => { throw new Error('Unexpected tabs.reload'); },
      captureVisibleTab: async () => { throw new Error('Unexpected screenshot'); }
    },
    windows: { update: async (...args) => { calls.push({ kind: 'forbidden.windows.update', args }); throw new Error('Unexpected focus'); } },
    debugger: { onDetach: event,
      attach: async target => { calls.push({ kind: 'attach', tabId: target.tabId }); if (hooks.attach) await hooks.attach(target); },
      detach: async target => { calls.push({ kind: 'detach', tabId: target.tabId }); if (hooks.detach) await hooks.detach(target); },
      sendCommand: async (target, method, params) => {
        calls.push({ kind: 'cdp', tabId: target.tabId, method, params: plain(params) });
        if (hooks.send) return hooks.send(target, method, params);
        if (method === 'Page.setWebLifecycleState' && params.state === 'active') tabs.get(target.tabId).frozen = false;
        else throw new Error('Unexpected CDP method: ' + method);
        return {};
      }
    },
    scripting: { executeScript: async spec => {
      calls.push({ kind: 'script', tabId: spec.target.tabId, spec });
      if (hooks.script) return hooks.script(spec);
      const documentId = 'native-document-' + spec.target.tabId;
      if (spec.files) return [{ frameId: 0, documentId }];
      return [{ frameId: 0, documentId, result: { protocol: 'ai-browser-page-rpc-v1', ok: true,
        payload: { title: 'Wake Fixture', elements: [], matched: true, visible: true },
        diagnostic: { agentPresent: true, resultKind: 'object', stage: 'serialize' } } }];
    } },
    alarms: { create: async () => {}, onAlarm: { addListener: listener => alarmListeners.push(listener) } }
  };
  const context = vm.createContext({ chrome, URL, AbortController, TextEncoder, Date: Clock,
    setTimeout: (fn, ms) => { const id = ++serial; timers.set(id, { fn, ms, at: now + ms }); return id; },
    clearTimeout: id => timers.delete(id), fetch: async () => { throw new Error('Unexpected network'); } });
  const run = code => vm.runInContext(code, context);
  context.importScripts = name => run(fs.readFileSync(path.resolve(__dirname, '..', name), 'utf8'));
  run(fs.readFileSync(path.resolve(__dirname, '../background.js'), 'utf8'));
  let command = 0;
  return { calls, hooks, tabs, timers, stored, run,
    alarm: () => { for (const listener of alarmListeners) listener({ name: run('ALARM') }); },
    ready: async () => { await run('ready'); await tick(); run('wantDisconnect = false'); },
    popup: message => run('handlePopup(' + JSON.stringify(message) + ')'),
    exec: (method = 'snapshot', params = {}) => run('executeBounded(' + JSON.stringify({ id: 'qa-' + ++command, method, params: { ...(['list_tabs', 'batch'].includes(method) ? {} : { tabId: 7, load: 'current' }), ...params } }) + ')'),
    expireOuter: () => { for (const [id, timer] of [...timers]) if (timer.ms === 11000) { timers.delete(id); now = Math.max(now, timer.at); timer.fn(); } },
    advanceWake: async () => {
      // Run only command-local short deadlines/poll intervals; never bridge/diagnostic timers.
      const next = [...timers].filter(([, t]) => t.ms <= 1500).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) return false;
      timers.delete(next[0]); now = Math.max(now, next[1].at); next[1].fn(); await tick(); return true;
    }
  };
}
const entries = (h, kind) => h.calls.filter(call => call.kind === kind);
function exactWake(h, count = 1) {
  assert.equal(entries(h, 'cdp').length, count);
  for (const call of entries(h, 'cdp')) {
    assert.equal(call.method, 'Page.setWebLifecycleState'); assert.deepEqual(call.params, { state: 'active' });
  }
  assert.equal(h.calls.some(call => call.kind.startsWith('forbidden.')), false);
}
function wakeError(code) {
  return error => { assert.equal(error.code, code); assert.equal(error.diagnostic.stage, 'wake'); assert.equal(typeof error.diagnostic.phase, 'string'); return true; };
}
async function settleShortTimers(h, promise) {
  let done = false;
  promise.then(() => { done = true; }, () => { done = true; });
  for (let n = 0; n < 12 && !done; n++) { await tick(); if (!done) await h.advanceWake(); }
  assert(done, 'wake confirmation must finish within its bounded short timer budget');
}

test('missing storage flag defaults false and both popup/list expose that value', async () => {
  const h = harness({ stored: { disconnected: true, autoAuthorize: true, cdpEnabled: true, screenshotCdpEnabled: true } }); await h.ready();
  assert.equal((await h.popup({ type: 'popup_status' })).lifecycleWakeEnabled, false);
  assert((await h.exec('list_tabs')).every(tab => tab.lifecycleWakeEnabled === false));
  await assert.rejects(h.exec(), error => error.code === 'TAB_FROZEN' && error.outcome === 'not-dispatched');
  assert.equal(entries(h, 'attach').length, 0); assert.equal(entries(h, 'script').length, 0);
});

test('setter persists true/false, advances only lifecycle token, and reload retains saved value', async () => {
  const h = harness(); await h.ready();
  const before = plain(h.run('cdpGeneration'));
  assert.equal((await h.popup({ type: 'set_lifecycle_wake_enabled', enabled: false })).lifecycleWakeEnabled, false);
  assert.equal(h.stored.lifecycleWakeEnabled, false);
  const after = plain(h.run('cdpGeneration'));
  assert.equal(after.lifecycle, before.lifecycle + 1); assert.equal(after.input, before.input); assert.equal(after.screenshot, before.screenshot);
  await h.popup({ type: 'set_lifecycle_wake_enabled', enabled: true });
  assert.equal(h.stored.lifecycleWakeEnabled, true);
  const reload = harness({ stored: h.stored }); await reload.ready();
  assert.equal((await reload.popup({ type: 'popup_status' })).lifecycleWakeEnabled, true);
  assert((await reload.exec('list_tabs')).every(tab => tab.lifecycleWakeEnabled === true));
});

for (const input of [false, true]) for (const screenshot of [false, true]) for (const wake of [false, true]) {
  test('independent permission matrix input=' + input + ' screenshot=' + screenshot + ' lifecycle=' + wake, async () => {
    const h = harness({ stored: { disconnected: true, autoAuthorize: true, cdpEnabled: input, screenshotCdpEnabled: screenshot, lifecycleWakeEnabled: wake } }); await h.ready();
    if (wake) {
      const result = await h.exec(); assert.deepEqual(plain(result.lifecycleWake), { attempted: true, verified: true });
      exactWake(h); assert.equal(entries(h, 'attach').length, 1); assert.equal(entries(h, 'detach').length, 1);
      assert.equal(h.run('attached.size'), 0);
    } else {
      await assert.rejects(h.exec(), error => error.code === 'TAB_FROZEN');
      exactWake(h, 0); assert.equal(entries(h, 'attach').length, 0); assert.equal(entries(h, 'script').length, 0);
    }
  });
}

for (const method of ['snapshot', 'inspect', 'wait']) {
  test('fresh ' + method + ' thaws before page work and targets the injected native document', async () => {
    const h = harness(); await h.ready(); await h.exec(method, { ref: 'r1-1', name: 'Ready', timeoutMs: 1 });
    exactWake(h); const scripts = entries(h, 'script'); assert.equal(scripts.length, 2);
    const wakeAt = h.calls.findIndex(call => call.kind === 'cdp'); const scriptAt = h.calls.findIndex(call => call.kind === 'script');
    assert(wakeAt < scriptAt); assert(h.calls.slice(wakeAt + 1, scriptAt).some(call => call.kind === 'get'), 'native thaw verification precedes injection');
    assert.deepEqual(Array.from(scripts[1].spec.target.documentIds), ['native-document-7']);
    assert(scripts.every(call => call.spec.injectImmediately === true));
    assert.equal(h.tabs.get(7).active, false); assert.equal(h.tabs.get(7).autoDiscardable, true);
    assert.equal(h.run('runningTabs.size'), 0);
  });
}

for (const [method, params] of [['fill', { ref: 'r1-1', text: 'never' }], ['click', { ref: 'r1-1' }], ['scroll', {}]]) {
  test(method + (params.cursor ? ' pagination continuation' : '') + ' cannot auto-wake a frozen page', async () => {
    const h = harness(); await h.ready(); await assert.rejects(h.exec(method, params), error => error.code === 'TAB_FROZEN');
    exactWake(h, 0); assert.equal(entries(h, 'attach').length, 0); assert.equal(entries(h, 'script').length, 0);
  });
}

test('discarded pages never wake; unknown/false frozen does not trigger CDP', async () => {
  const h = harness(); await h.ready(); h.tabs.get(7).discarded = true; h.tabs.get(7).frozen = false;
  await assert.rejects(h.exec(), error => error.code === 'TAB_DISCARDED'); exactWake(h, 0);
  h.tabs.get(7).frozen = true;
  await assert.rejects(h.exec(), error => ['TAB_DISCARDED', 'TAB_FROZEN'].includes(error.code)); exactWake(h, 0);
  h.tabs.get(7).discarded = false; delete h.tabs.get(7).frozen; await h.exec(); exactWake(h, 0);
  h.tabs.get(7).frozen = false; await h.exec(); exactWake(h, 0);
});

test('tab authorization remains required despite independent lifecycle permission', async () => {
  const h = harness(); await h.ready(); h.run('revoked.add(7)'); await assert.rejects(h.exec());
  assert.equal(entries(h, 'attach').length, 0); assert.equal(entries(h, 'script').length, 0);
});

test('an existing input attachment is borrowed and never detached by successful wake', async () => {
  const h = harness(); await h.ready(); h.run('attached.add(7); cdpEnabled = true');
  await h.exec(); exactWake(h); assert.equal(entries(h, 'attach').length, 0); assert.equal(entries(h, 'detach').length, 0);
  assert.equal(h.run('attached.has(7)'), true);
});

test('attach rejection is sanitized PAGE_WAKE_FAILED and no page work runs', async () => {
  const h = harness(); await h.ready(); h.hooks.attach = async () => { throw new Error('private fixture error'); };
  await assert.rejects(h.exec(), wakeError('PAGE_WAKE_FAILED')); exactWake(h, 0); assert.equal(entries(h, 'script').length, 0);
});

test('active command rejection cleans owned attachment and exposes fixed wake diagnostic', async () => {
  const h = harness(); await h.ready(); h.hooks.send = async () => { throw new Error('private fixture error'); };
  await assert.rejects(h.exec(), wakeError('PAGE_WAKE_FAILED')); exactWake(h); assert.equal(entries(h, 'detach').length, 1);
  assert.equal(entries(h, 'script').length, 0); assert.equal(h.run('attached.size'), 0);
});

test('native still-frozen confirmation is bounded to <=3 reads and one attempt', async () => {
  const h = harness(); await h.ready(); h.hooks.send = async () => ({});
  const started = h.run('Date.now()');
  const work = h.exec(); const rejected = assert.rejects(work, wakeError('PAGE_WAKE_TIMEOUT'));
  await settleShortTimers(h, work); await rejected; exactWake(h);
  const wakeAt = h.calls.findIndex(call => call.kind === 'cdp');
  assert(h.calls.slice(wakeAt + 1).filter(call => call.kind === 'get').length <= 3);
  assert(h.run('Date.now()') - started <= 1500, 'prompt native APIs keep confirmation within 1500ms');
  assert.equal(entries(h, 'script').length, 0); assert.equal(entries(h, 'detach').length, 1);
});

test('native unknown frozen state cannot masquerade as a verified thaw', async () => {
  const h = harness(); await h.ready(); h.hooks.send = async () => { delete h.tabs.get(7).frozen; return {}; };
  const work = h.exec(); const rejected = assert.rejects(work, error => ['PAGE_WAKE_TIMEOUT', 'PAGE_WAKE_FAILED'].includes(error.code) && error.diagnostic.stage === 'wake');
  await settleShortTimers(h, work); await rejected; assert.equal(entries(h, 'script').length, 0); exactWake(h);
});

for (const point of ['attach', 'active']) {
  test('revocation during pending ' + point + ' prevents every later page read and cleans owned attachment', async () => {
    const h = harness(); await h.ready(); const gate = deferred();
    if (point === 'attach') h.hooks.attach = () => gate.promise;
    else h.hooks.send = () => gate.promise;
    const work = h.exec(); const rejected = assert.rejects(work, wakeError('CDP_DISABLED')); await tick();
    const disable = h.popup({ type: 'set_lifecycle_wake_enabled', enabled: false });
    // Cleanup may queue behind current work, but revocation must become visible now.
    await tick();
    const enable = h.popup({ type: 'set_lifecycle_wake_enabled', enabled: true });
    await tick();
    gate.resolve({}); await rejected; await Promise.all([disable, enable]); await tick();
    exactWake(h, point === 'attach' ? 0 : 1); assert.equal(entries(h, 'script').length, 0);
    assert.equal(entries(h, 'detach').length, 1); assert.equal(h.run('runningTabs.size'), 0);
  });
}

for (const point of ['attach', 'active']) {
  test('hung raw ' + point + ' obeys outer 11s bound and holds busy until late work settles', async () => {
    const h = harness(); await h.ready(); const gate = deferred();
    if (point === 'attach') h.hooks.attach = () => gate.promise; else h.hooks.send = () => gate.promise;
    const work = h.exec(); const rejected = assert.rejects(work, error => ['timeout', 'PAGE_WAKE_TIMEOUT'].includes(error.code));
    await tick(); h.expireOuter(); await rejected;
    assert.equal(h.run('runningTabs.has(7)'), true);
    const before = h.calls.length;
    await assert.rejects(h.exec(), error => error.code === 'TAB_BUSY' && error.outcome === 'not-dispatched');
    assert.equal(h.calls.slice(before).some(call => ['get', 'attach', 'cdp', 'script'].includes(call.kind)), false);
    const listing = await h.exec('list_tabs'); assert.equal(listing.find(tab => tab.id === 7).operation.timedOut, true);
    gate.resolve({}); await tick(); await tick();
    exactWake(h, point === 'attach' ? 0 : 1); assert.equal(entries(h, 'detach').length, 1);
    assert.equal(entries(h, 'script').length, 0); assert.equal(h.run('runningTabs.has(7)'), false);
  });
}

test('a previous unfinished command wins over thaw and independent batch sibling can proceed', async () => {
  const h = harness(); await h.ready(); const gate = deferred(); h.hooks.attach = target => target.tabId === 7 ? gate.promise : Promise.resolve();
  const old = h.exec(); const rejected = assert.rejects(old); await tick(); h.expireOuter(); await rejected;
  const result = await h.exec('batch', { tabId: undefined, commands: [
    { method: 'snapshot', params: { tabId: 7, load: 'current' } }, { method: 'snapshot', params: { tabId: 9, load: 'current' } }
  ] });
  assert.equal(result.results[0].error.code, 'TAB_BUSY'); assert.equal(result.results[1].ok, true);
  assert.equal(entries(h, 'attach').filter(call => call.tabId === 7).length, 1);
  assert.equal(entries(h, 'cdp').filter(call => call.tabId === 9).length, 1);
  gate.resolve(); await tick(); assert.equal(h.run('runningTabs.size'), 0);
});

test('two frozen pages wake independently in one batch with exact per-page cleanup', async () => {
  const h = harness(); await h.ready(); const result = await h.exec('batch', { tabId: undefined, commands: [7, 9].map(tabId => ({ method: 'snapshot', params: { tabId, load: 'current' } })) });
  assert(result.results.every(item => item.ok && item.result.lifecycleWake.verified)); exactWake(h, 2);
  for (const tabId of [7, 9]) { assert.equal(entries(h, 'attach').filter(call => call.tabId === tabId).length, 1); assert.equal(entries(h, 'detach').filter(call => call.tabId === tabId).length, 1); }
  assert.equal(h.run('runningTabs.size'), 0); assert.equal(h.run('attached.size'), 0);
});

test('a refreeze after injection never triggers a second wake or stale invocation', async () => {
  const h = harness(); await h.ready(); h.hooks.script = async spec => {
    h.tabs.get(spec.target.tabId).frozen = true;
    return [{ frameId: 0, documentId: 'refrozen-document' }];
  };
  await assert.rejects(h.exec(), error => error.code === 'TAB_FROZEN'); exactWake(h);
  assert.equal(entries(h, 'script').length, 1); assert.equal(h.run('runningTabs.size'), 0);
});

for (const field of ['url', 'windowId']) {
  test('native target ' + field + ' change during attach prevents active command and stale read', async () => {
    const h = harness(); await h.ready(); h.hooks.attach = async () => { h.tabs.get(7)[field] = field === 'url' ? 'https://other.test/' : 2; };
    await assert.rejects(h.exec(), error => error.code === 'TARGET_CHANGED' && error.diagnostic.stage === 'wake');
    exactWake(h, 0); assert.equal(entries(h, 'script').length, 0); assert.equal(entries(h, 'detach').length, 1);
  });
}

test('native target change after active command cannot confirm a different page as thawed', async () => {
  const h = harness(); await h.ready(); h.hooks.send = async () => { h.tabs.get(7).url = 'https://other.test/'; h.tabs.get(7).frozen = false; return {}; };
  await assert.rejects(h.exec(), error => error.code === 'TARGET_CHANGED' && error.diagnostic.stage === 'wake');
  exactWake(h); assert.equal(entries(h, 'script').length, 0); assert.equal(entries(h, 'detach').length, 1);
});

test('failed wake also preserves a borrowed existing input attachment', async () => {
  const h = harness(); await h.ready(); h.run('attached.add(7); cdpEnabled = true');
  h.hooks.send = async () => { throw new Error('private failure'); };
  await assert.rejects(h.exec(), wakeError('PAGE_WAKE_FAILED')); exactWake(h);
  assert.equal(entries(h, 'attach').length, 0); assert.equal(entries(h, 'detach').length, 0); assert.equal(h.run('attached.has(7)'), true);
});

test('bridge alarms never proactively re-wake a page after a completed read', async () => {
  const h = harness(); await h.ready(); await h.exec(); h.tabs.get(7).frozen = true;
  const scriptsBefore = entries(h, 'script').length;
  for (let n = 0; n < 3; n++) { h.alarm(); await tick(); }
  exactWake(h); assert.equal(entries(h, 'script').length, scriptsBefore);
  assert.equal(h.tabs.get(7).frozen, true); assert.equal(h.run('runningTabs.size'), 0);
});

test('hung native thaw confirmation holds busy until it settles without late page work', async () => {
  const h = harness(); await h.ready(); const gate = deferred();
  h.hooks.send = async () => { h.hooks.get = () => gate.promise; return {}; };
  const work = h.exec(); const rejected = assert.rejects(work, error => ['timeout', 'PAGE_WAKE_TIMEOUT'].includes(error.code));
  await tick(); h.expireOuter(); await rejected;
  assert.equal(h.run('runningTabs.has(7)'), true);
  await assert.rejects(h.exec(), error => error.code === 'TAB_BUSY');
  gate.resolve({ ...h.tabs.get(7), frozen: false }); await tick(); await tick();
  exactWake(h); assert.equal(entries(h, 'script').length, 0); assert.equal(entries(h, 'detach').length, 1);
  assert.equal(h.run('runningTabs.has(7)'), false);
});

// Lead regressions for the independent review's final-detach target boundary.
for (const [name, mutate, code] of [
  ['url', h => { h.tabs.get(7).url = 'https://changed.test/'; }, 'TARGET_CHANGED'],
  ['window', h => { h.tabs.get(7).windowId = 2; }, 'TARGET_CHANGED'],
  ['discarded', h => { h.tabs.get(7).discarded = true; }, 'TARGET_CHANGED'],
  ['missing frozen', h => { delete h.tabs.get(7).frozen; }, 'PAGE_WAKE_TIMEOUT'],
  ['refrozen', h => { h.tabs.get(7).frozen = true; }, 'PAGE_WAKE_TIMEOUT'],
  ['revoked lifecycle generation', h => { h.run('cdpGeneration.lifecycle++'); }, 'CDP_DISABLED']
]) {
  test('post-detach ' + name + ' cannot continue into a stale or unverified page', async () => {
    const h = harness(); await h.ready(); h.hooks.detach = async () => { mutate(h); };
    await assert.rejects(h.exec(), error => {
      assert.equal(error.code, code); assert.equal(error.diagnostic.stage, 'wake');
      assert.equal(error.diagnostic.wakeVerified, false); return true;
    });
    exactWake(h); assert.equal(entries(h, 'script').length, 0);
    assert.equal(h.run('attached.size'), 0); assert.equal(h.run('runningTabs.size'), 0);
  });
}
