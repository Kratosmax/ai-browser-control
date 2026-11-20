'use strict';
// Isolated production-worker fixtures: no real browser, bridge, settings, or permissions.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const plain = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
const source = name => fs.readFileSync(path.resolve(__dirname, '..', name), 'utf8');
function fixture({ autoAuthorize = true, records = [] } = {}) {
  const calls = [], hooks = {}, timers = new Map();
  const tabs = new Map([
    [7, { id: 7, windowId: 1, incognito: false, title: 'Regular', url: 'https://regular.test/', groupId: 17, active: false }],
    [9, { id: 9, windowId: 2, incognito: true, title: 'PRIVATE TITLE', url: 'https://private.test/', groupId: 19, active: false }],
    [10, { id: 10, windowId: 2, incognito: true, title: 'Other private', url: 'https://private.test/10', groupId: 19, active: false }]
  ]);
  const windows = new Map([
    [1, { id: 1, incognito: false, type: 'normal', focused: false }],
    [2, { id: 2, incognito: true, type: 'normal', focused: true }]
  ]);
  let session = { managedTabs: records }, next = 100, group = 30, timer = 0, command = 0, focused = 2;
  const event = () => ({ addListener() {} });
  const chrome = {
    runtime: { id: 'mode-fixture', getManifest: () => ({ name: 'Fixture', version: 'test' }), getURL: p => 'chrome-extension://fixture/' + p,
      onMessage: event(), onInstalled: event(), onStartup: event() },
    alarms: { create: async () => {}, onAlarm: event() },
    storage: { local: { get: async () => ({ disconnected: true, autoAuthorize }), set: async () => {} },
      session: { get: async () => plain(session), set: async value => { session = { ...session, ...plain(value) }; } } },
    tabs: {
      query: async () => { if (hooks.query) await hooks.query(); return [...tabs.values()].map(tab => ({ ...tab })); },
      get: async id => { calls.push(['get', id]); if (hooks.get) await hooks.get(id); if (!tabs.has(id)) throw new Error('No tab with id: ' + id); return { ...tabs.get(id) }; },
      create: async params => { calls.push(['create', plain(params)]); const tab = { id: ++next, ...params, incognito: windows.get(params.windowId).incognito, groupId: -1 }; tabs.set(tab.id, tab); return { ...tab }; },
      update: async (id, params) => { calls.push(['update', id, plain(params)]); Object.assign(tabs.get(id), params); return { ...tabs.get(id) }; },
      group: async params => { calls.push(['group', plain(params)]); const id = params.groupId ?? ++group; for (const tabId of params.tabIds) tabs.get(tabId).groupId = id; return id; },
      remove: async id => { calls.push(['remove', id]); tabs.delete(id); },
      captureVisibleTab: async () => { calls.push(['capture']); return 'data:image/png;base64,PNG'; },
      onCreated: event(), onRemoved: event()
    },
    windows: {
      getLastFocused: async () => { calls.push(['lastFocused']); return { ...windows.get(focused) }; },
      getAll: async () => { calls.push(['allWindows']); return [...windows.values()].map(window => ({ ...window })); },
      get: async id => { calls.push(['window', id]); if (hooks.window) await hooks.window(id); if (!windows.has(id)) throw new Error('No window'); return { ...windows.get(id) }; },
      create: async () => { throw new Error('Must never create window'); }, update: async () => { throw new Error('Must never activate window'); }
    },
    tabGroups: { update: async () => {} },
    debugger: { onDetach: event(), attach: async () => { calls.push(['attach']); }, detach: async () => { calls.push(['detach']); },
      sendCommand: async (_, method) => { calls.push(['cdp', method]); return { data: 'PNG' }; } },
    scripting: { executeScript: async spec => {
      calls.push(['script', spec.target.tabId, spec.files ? 'inject' : spec.args?.[0]]);
      if (spec.files) return [{ frameId: 0 }];
      // Reuse protection's standalone function is a read of the empty form fixture.
      if (!spec.args) return [{ result: false }];
      const payload = spec.args[0] === 'prepare' ? { x: 10, y: 20 } : spec.args[0] === 'snapshot' ? { title: 'Fixture', elements: [] } : { focused: true };
      return [{ frameId: 0, result: { protocol: 'ai-browser-page-rpc-v1', ok: true, payload, diagnostic: { stage: 'serialize', resultKind: 'object' } } }];
    } }
  };
  const context = vm.createContext({ chrome, URL, AbortController, TextEncoder,
    setTimeout: (fn, ms) => { const id = ++timer; timers.set(id, { fn, ms }); return id; }, clearTimeout: id => timers.delete(id),
    fetch: async (url, params) => { calls.push(['fetch', url, plain(params.headers), params.method]); return { ok: true, status: 204, body: { cancel: async () => {} } }; }
  });
  const run = code => vm.runInContext(code, context);
  context.importScripts = name => run(source(name));
  run(source('background.js'));
  return { tabs, windows, calls, hooks, run, chrome, focused: id => { focused = id; },
    ready: async () => { await run('ready'); await tick(); run('wantDisconnect = false'); },
    exec: (method, params = {}) => run('executeBounded(' + JSON.stringify({ id: 'mode-' + ++command, method, params }) + ')'),
    task: (action, params = {}) => run('taskTabs.task(' + JSON.stringify({ action, taskId: 'same', ...params }) + ')'),
    registry: () => run('taskTabs'), session: () => session
  };
}
const effects = h => h.calls.filter(call => ['script', 'attach', 'detach', 'cdp', 'capture', 'create', 'update', 'remove', 'group'].includes(call[0]));
const mismatch = { code: 'BROWSER_MODE_MISMATCH', outcome: 'not-dispatched' };
const legacy = (id, groupId, extra = {}) => ({ id, taskId: 'same', name: id === 9 ? 'PRIVATE TASK NAME' : 'Task', groupId, used: id, key: 'key:detail', keep: false, ...extra });

test('list_tabs defaults to regular, preserves array shape, and reports actual mode without private metadata', async () => {
  const h = fixture({ records: [legacy(7, 17), legacy(9, 19)] }); await h.ready();
  const regular = await h.exec('list_tabs');
  assert(Array.isArray(regular)); assert.deepEqual(regular.map(tab => tab.id), [7]);
  assert.equal(regular[0].incognito, false); assert.equal(regular[0].browserMode, 'regular');
  assert(!JSON.stringify(regular).includes('PRIVATE'));
  const privateTabs = await h.exec('list_tabs', { browserMode: 'incognito' });
  assert.deepEqual(privateTabs.map(tab => tab.id), [9, 10]);
  for (const tab of privateTabs) { assert.equal(tab.incognito, true); assert.equal(tab.browserMode, 'incognito'); }
  assert.equal(effects(h).length, 0);
});

for (const method of ['snapshot', 'scroll', 'click', 'hover', 'focus', 'drag', 'select', 'set_checked', 'inspect', 'wait', 'fill', 'press', 'navigate', 'screenshot', 'release']) {
  test(method + ' rejects either wrong mode before authorization, scripts, debug state, or page effects', async () => {
    const h = fixture(); await h.ready(); h.run('authorized.add(9); attached.add(9)');
    await assert.rejects(h.exec(method, { tabId: 9, url: 'https://example.test/', ref: 'r1', key: 'Enter' }), mismatch);
    await assert.rejects(h.exec(method, { tabId: 7, browserMode: 'incognito' }), mismatch);
    assert.equal(effects(h).length, 0); assert.equal(h.run('authorized.has(9) && attached.has(9) && !revoked.has(9)'), true);
  });
}

test('matching incognito still needs existing authorization; successful read, capture, and release return actual mode', async () => {
  const h = fixture({ autoAuthorize: false }); await h.ready();
  await assert.rejects(h.exec('snapshot', { tabId: 9, browserMode: 'incognito' }), /授权/);
  assert.equal(effects(h).length, 0); h.run('authorized.add(9)');
  for (const method of ['snapshot', 'screenshot', 'release']) {
    const result = await h.exec(method, { tabId: 9, browserMode: 'incognito', load: 'current' });
    assert.equal(result.browserMode, 'incognito'); assert.equal(result.incognito, true);
  }
  assert.equal(h.run('revoked.has(9)'), true);
});

test('mode check runs after the tab queue and uses the existing first lookup', async () => {
  const h = fixture(); await h.ready();
  h.run('withTab(7, () => new Promise(resolve => { globalThis.unlock = resolve; }))');
  const work = h.exec('snapshot', { tabId: 7 }).catch(error => error);
  await tick(); assert.equal(h.calls.filter(call => call[0] === 'get').length, 0);
  h.tabs.get(7).incognito = true; h.run('unlock()');
  assert.equal((await work).code, mismatch.code);
  assert.equal(h.calls.filter(call => call[0] === 'get').length, 1);
  assert.equal(effects(h).length, 0);
});

test('batch children independently default regular and allow explicit private selection', async () => {
  const h = fixture(); await h.ready();
  const result = await h.exec('batch', { commands: [
    { method: 'snapshot', params: { tabId: 7, load: 'current' } },
    { method: 'release', params: { tabId: 9 } },
    { method: 'snapshot', params: { tabId: 10, browserMode: 'incognito', load: 'current' } }
  ] });
  assert.deepEqual([...result.results].map(item => item.ok), [true, false, true]);
  assert.equal(result.results[1].error.code, mismatch.code); assert.equal(result.results[1].error.outcome, 'not-dispatched');
  assert.equal(result.results[0].result.browserMode, 'regular'); assert.equal(result.results[2].result.browserMode, 'incognito');
  assert(!effects(h).some(call => call[1] === 9));
});

test('open chooses matching existing normal windows, never creates or activates one', async () => {
  const h = fixture(); await h.ready();
  const regular = await h.exec('open', { url: 'https://example.test/', taskId: 'new' });
  assert.equal(regular.windowId, 1); assert.equal(regular.browserMode, 'regular'); assert.equal(regular.incognito, false);
  const privateTab = await h.exec('open', { url: 'https://example.test/', taskId: 'new', browserMode: 'incognito' });
  assert.equal(privateTab.windowId, 2); assert.equal(privateTab.incognito, true);
  assert(h.calls.some(call => call[0] === 'allWindows'));
  assert(h.calls.filter(call => call[0] === 'create').every(call => call[1].active === false));
  assert.equal((await h.exec('snapshot', { tabId: privateTab.tabId, browserMode: 'incognito', load: 'current' })).incognito, true);
});

for (const mode of ['regular', 'incognito']) test('open refuses absent ' + mode + ' window without falling back', async () => {
  const h = fixture(); await h.ready(); h.windows.delete(mode === 'regular' ? 1 : 2);
  await assert.rejects(h.exec('open', { url: 'https://example.test/', browserMode: mode }), { code: 'NO_BROWSER_WINDOW', outcome: 'not-dispatched' });
  assert.equal(effects(h).length, 0);
});

test('last focused popup cannot be an open target even when its mode matches', async () => {
  const h = fixture(); await h.ready(); h.windows.set(3, { id: 3, type: 'popup', incognito: false }); h.focused(3);
  const result = await h.exec('open', { url: 'https://example.test/' }); assert.equal(result.windowId, 1);
});

test('explicit open anchor requires matching mode and existing authorization', async () => {
  const h = fixture({ autoAuthorize: false }); await h.ready();
  await assert.rejects(h.exec('open', { tabId: 9, url: 'https://example.test/' }), mismatch);
  await assert.rejects(h.exec('open', { tabId: 9, url: 'https://example.test/', browserMode: 'incognito' }), /授权/);
  assert.equal(effects(h).length, 0); h.run('authorized.add(9)');
  assert.equal((await h.exec('open', { tabId: 9, url: 'https://example.test/', browserMode: 'incognito' })).windowId, 2);
});

test('open revalidates actual window immediately before create or reuse navigation dispatch', async () => {
  for (const reuse of [false, true]) {
    const h = fixture({ records: reuse ? [legacy(7, 17)] : [] }); await h.ready(); h.focused(1);
    let gets = 0; h.hooks.window = async () => { if (++gets === 2) h.windows.get(1).incognito = true; };
    await assert.rejects(h.exec('open', { url: 'https://regular.test/next', taskId: 'same', reuseKey: reuse ? 'detail' : undefined }), mismatch);
    assert(!effects(h).some(call => ['create', 'update', 'remove', 'group'].includes(call[0])));
  }
});

test('open does not navigate a reuse candidate whose URL changes during mode verification', async () => {
  for (const reuseKey of [undefined, 'detail']) {
    const h = fixture({ records: [legacy(7, 17)] }); await h.ready();
    h.hooks.get = async id => { if (id === 7) h.tabs.get(id).url = 'https://other-origin.test/'; };
    await assert.rejects(h.exec('open', { url: 'https://regular.test/', taskId: 'same', reuseKey }),
      { code: 'TARGET_CHANGED', outcome: 'not-dispatched' });
    assert.equal(h.tabs.get(7).url, 'https://other-origin.test/');
    assert(!effects(h).some(call => call[0] === 'create' || call[0] === 'update'));
  }
});

test('legacy task storage is filtered using live Tab.incognito; opposite records and details stay untouched', async () => {
  const h = fixture({ records: [legacy(7, 17), legacy(9, 19)] }); await h.ready();
  h.tabs.get(9).groupId = 99; // regular list must not even prune private ownership after a user group move.
  const result = await h.task('list'); assert.deepEqual(result.tabs.map(tab => tab.id), [7]);
  assert.equal(result.tabs[0].incognito, false); assert(!JSON.stringify(result).includes('PRIVATE'));
  assert(h.registry().tabs.has(9)); h.tabs.get(9).groupId = 19;
  const privateResult = await h.task('list', { browserMode: 'incognito' });
  assert.deepEqual(privateResult.tabs.map(tab => tab.id), [9]); assert.equal(privateResult.tabs[0].incognito, true);
  const close = await h.task('finish'); assert.deepEqual([...close.closed], [7]); assert.deepEqual([...close.remaining], []);
  assert(h.registry().tabs.has(9)); assert(h.tabs.has(9));
});

for (const action of ['close', 'keep', 'unkeep']) test('task ' + action + ' skips selected opposite-mode tabs before mutation or ownership disclosure', async () => {
  const h = fixture({ records: [legacy(7, 17), legacy(9, 19, { keep: action === 'unkeep' })] }); await h.ready();
  const before = plain(h.registry().tabs.get(9));
  const result = await h.task(action, action === 'keep' ? { keepTabIds: [9] } : { tabIds: [9] });
  assert.deepEqual(plain(h.registry().tabs.get(9)), before);
  assert.deepEqual(plain(result.skipped), [{ tabId: 9, reason: 'browser-mode-mismatch' }]);
  assert(!JSON.stringify(result).includes('PRIVATE')); assert.equal(effects(h).length, 0);
});

test('finish and cleanup skip opposite-mode keep selections without changing their keep flags', async () => {
  for (const action of ['finish', 'cleanup']) {
    const h = fixture({ records: [legacy(7, 17), legacy(9, 19)] }); await h.ready();
    const before = plain(h.registry().tabs.get(9));
    const result = await h.task(action, { keepTabIds: [9] });
    assert.deepEqual(plain(h.registry().tabs.get(9)), before);
    assert(result.skipped.some(item => item.tabId === 9 && item.reason === 'browser-mode-mismatch'));
    assert(!result.remaining.includes(9)); assert(h.tabs.has(9));
  }
});

test('unavailable selected-tab mode fails closed without private ownership or keep changes', async () => {
  for (const action of ['close', 'keep', 'unkeep']) {
    const h = fixture({ records: [legacy(9, 19, { taskId: 'PRIVATE TASK', keep: true })] }); await h.ready();
    const before = plain(h.registry().tabs.get(9));
    h.hooks.get = async () => { throw new Error('Transport unavailable'); };
    const result = await h.task(action, action === 'keep' ? { keepTabIds: [9] } : { tabIds: [9] });
    assert.deepEqual(plain(result.skipped), [{ tabId: 9, reason: 'tab-unavailable' }]);
    assert.deepEqual(plain(h.registry().tabs.get(9)), before);
    assert(!JSON.stringify(result).includes('PRIVATE')); assert.equal(effects(h).length, 0);
  }
});

test('task keep and unkeep cannot mutate after invalidation during native mode lookup', async () => {
  for (const action of ['keep', 'unkeep']) {
    const h = fixture({ records: [legacy(7, 17, { keep: action === 'unkeep' })] }); await h.ready();
    let invalid = false; h.hooks.get = async () => { invalid = true; };
    const check = () => { if (invalid) throw new Error('Invalidated'); };
    await assert.rejects(h.registry().task({ action, taskId: 'same', ...(action === 'keep' ? { keepTabIds: [7] } : { tabIds: [7] }) }, check), /Invalidated/);
    assert.equal(h.registry().tabs.get(7).keep, action === 'unkeep');
  }
});

test('private finish and cleanup only operate on private pages with the same taskId', async () => {
  const h = fixture({ records: [legacy(7, 17), legacy(9, 19)] }); await h.ready();
  for (let id = 20; id < 33; id++) {
    h.tabs.set(id, { id, windowId: 2, incognito: true, url: 'https://private.test/' + id, groupId: 19, active: false });
    h.registry().tabs.set(id, legacy(id, 19));
  }
  const cleaned = await h.task('cleanup', { browserMode: 'incognito' }); assert.equal(cleaned.closedCount, 2);
  assert(!cleaned.closed.includes(7)); assert(!cleaned.remaining.includes(7)); assert(h.tabs.has(7));
  const finished = await h.task('finish', { browserMode: 'incognito' }); assert.equal(finished.closedCount, 12);
  assert(h.tabs.has(7)); assert(h.registry().tabs.has(7)); assert.deepEqual([...finished.remaining], []);
});

test('task adopt cannot group or disclose opposite-mode pages, but explicit private adoption works', async () => {
  const h = fixture(); await h.ready(); h.tabs.get(9).groupId = -1;
  const params = { taskName: 'Adopt', pages: [{ tabId: 9, url: 'https://private.test/', groupId: -1, evidence: { kind: 'agent-created', reference: 'fixture:create:9' } }] };
  const result = await h.task('adopt', params);
  assert.deepEqual(plain(result.skipped), [{ tabId: 9, reason: 'browser-mode-mismatch' }]);
  assert.equal(result.adoptedCount, 0); assert.equal(effects(h).length, 0); assert(!h.registry().tabs.has(9));
  const privateResult = await h.task('adopt', { ...params, browserMode: 'incognito' });
  assert.deepEqual([...privateResult.adopted], [9]); assert.equal(privateResult.tabs[0].browserMode, 'incognito');
  assert.equal(privateResult.tabs[0].incognito, true);
});

test('task cap, reuse and automatic cleanup are scoped to the selected actual mode', async () => {
  const h = fixture(); await h.ready();
  for (let id = 20; id < 33; id++) {
    h.tabs.set(id, { id, windowId: 2, incognito: true, url: 'https://private.test/' + id, groupId: 19, active: false });
    h.registry().tabs.set(id, legacy(id, 19, { keep: true }));
  }
  const regular = await h.exec('open', { url: 'https://regular.test/new', taskId: 'same', reuseKey: 'detail' });
  assert.equal(regular.browserMode, 'regular'); assert.equal(regular.reused, false);
  const again = await h.exec('open', { url: 'https://regular.test/next', taskId: 'same', reuseKey: 'detail' });
  assert.equal(again.tabId, regular.tabId); assert.equal(again.reused, true);
  const clean = await h.task('cleanup'); assert.equal(clean.closedCount, 0); assert(!clean.remaining.some(id => id >= 20 && id < 33));
  assert(!h.calls.some(call => call[0] === 'remove'));
  await assert.rejects(h.exec('open', { url: 'https://private.test/new', taskId: 'same', browserMode: 'incognito' }), { code: 'TASK_TAB_LIMIT' });
  assert.equal(h.calls.filter(call => call[0] === 'create').length, 1);
});

test('task cleanup and adoption recheck mode before destructive or grouping dispatch', async () => {
  const h = fixture({ records: [legacy(7, 17)] }); await h.ready();
  h.hooks.get = async id => { if (id === 7) h.tabs.get(id).incognito = true; };
  const result = await h.task('finish'); assert.equal(result.closedCount, 0);
  assert.deepEqual(plain(result.skipped), [{ tabId: 7, reason: 'browser-mode-mismatch' }]); assert.equal(effects(h).length, 0);
  const a = fixture(); await a.ready(); a.tabs.get(7).groupId = -1; let reads = 0;
  a.hooks.get = async id => { if (id === 7 && ++reads === 2) a.tabs.get(id).incognito = true; };
  const adopted = await a.task('adopt', { taskName: 'A', pages: [{ tabId: 7, url: 'https://regular.test/', groupId: -1, evidence: { kind: 'agent-created', reference: 'fixture:7' } }] });
  assert.equal(adopted.adoptedCount, 0); assert.equal(effects(a).length, 0);
});

test('automatic opener inheritance requires matching actual modes and preserves private cleanup scope', async () => {
  const h = fixture({ records: [legacy(7, 17), legacy(9, 19)] }); await h.ready();
  h.tabs.set(40, { id: 40, windowId: 1, incognito: true, url: 'https://child.test/', groupId: -1 });
  await h.registry().created({ tabId: 40, sourceTabId: 7 });
  assert(!h.registry().tabs.has(40)); assert.equal(effects(h).length, 0);
  h.tabs.set(41, { id: 41, windowId: 2, incognito: true, url: 'https://child.test/', groupId: -1 });
  await h.registry().created({ tabId: 41, sourceTabId: 9 });
  assert.equal(h.registry().tabs.get(41).browserMode, 'incognito'); assert.equal(h.registry().tabs.get(41).incognito, true);
  assert(h.registry().tabs.has(7)); assert(h.tabs.has(7));
});

test('invalid browser modes fail before side effects on list, task, open, and explicit methods', async () => {
  const h = fixture(); await h.ready();
  for (const browserMode of ['private', '', null, 1, true]) for (const method of ['list_tabs', 'snapshot', 'release', 'open', 'task']) {
    await assert.rejects(h.exec(method, { tabId: 7, url: 'https://example.test/', action: 'list', taskId: 'same', browserMode }), { code: 'INVALID_ARGUMENTS', outcome: 'not-dispatched' });
  }
  assert.equal(effects(h).length, 0);
});

test('browser-mode protocol capability is sent only on GET /poll', async () => {
  const h = fixture(); await h.ready();
  await h.run("bridgeFetch('/poll')"); await h.run("bridgeFetch('/pair', {})"); await h.run("bridgeFetch('/status')"); await h.run("bridgeFetch('/poll', {})");
  const requests = h.calls.filter(call => call[0] === 'fetch'); assert.equal(requests.length, 4);
  assert.equal(requests[0][2]['X-Browser-Mode-Protocol'], '1');
  for (const request of requests.slice(1)) assert.equal(request[2]['X-Browser-Mode-Protocol'], undefined);
});
