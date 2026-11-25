'use strict';
// Isolated production-worker fixtures: no real browser, bridge, or settings.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const tick = () => new Promise(resolve => setImmediate(resolve));
const plain = value => JSON.parse(JSON.stringify(value));
const source = name => fs.readFileSync(path.resolve(__dirname, '..', name), 'utf8');
const RESTRICTED = "chrome-extension://other-extension/page.html";
const RACE_ERROR = "Cannot access a chrome-extension:// URL of different extension";

function fixture({ autoAuthorize = true, screenshotCdpEnabled = true } = {}) {
  const calls = [], hooks = {}, timers = new Map();
  const tabs = new Map([
    [7, { id: 7, windowId: 1, incognito: false, title: 'Regular', url: 'https://regular.test/', groupId: 17, active: true }],
    [9, { id: 9, windowId: 2, incognito: true, title: 'Private', url: 'https://private.test/', groupId: 19, active: false }],
    [11, { id: 11, windowId: 1, incognito: false, title: 'OTHER EXTENSION PAGE', url: RESTRICTED, groupId: 21, active: false }],
    [12, { id: 12, windowId: 1, incognito: false, title: 'Own page', url: 'chrome-extension://fixture/panel.html', groupId: 22, active: false }],
    [13, { id: 13, windowId: 1, incognito: false, title: 'Settings', url: 'chrome://settings/', groupId: -1, active: false }],
    [14, { id: 14, windowId: 1, incognito: false, title: 'File', url: 'file:///C:/private.txt', groupId: -1, active: false }],
    [15, { id: 15, windowId: 1, incognito: false, title: 'App', url: 'msteams://launch', groupId: -1, active: false }]
  ]);
  const windows = new Map([[1, { id: 1, incognito: false, type: 'normal', focused: true }], [2, { id: 2, incognito: true, type: 'normal', focused: false }]]);
  let session = { managedTabs: [] }, timer = 0, command = 0;
  const event = () => ({ addListener() {} });
  const chrome = {
    runtime: { id: 'fixture', getManifest: () => ({ name: 'Fixture', version: '0.0.0-test' }), getURL: name => 'chrome-extension://fixture/' + name,
      onMessage: event(), onInstalled: event(), onStartup: event() },
    alarms: { create: async () => {}, onAlarm: event() },
    storage: { local: { get: async () => ({ disconnected: true, autoAuthorize, cdpEnabled: true, screenshotCdpEnabled }), set: async () => {} },
      session: { get: async () => plain(session), set: async value => { session = { ...session, ...plain(value) }; } } },
    tabs: {
      query: async () => { if (hooks.query) await hooks.query(); return [...tabs.values()].map(tab => ({ ...tab })); },
      get: async id => { calls.push(['get', id]); if (hooks.get) await hooks.get(id); if (!tabs.has(id)) throw new Error('No tab with id: ' + id); return { ...tabs.get(id) }; },
      update: async (id, params) => { calls.push(['update', id, plain(params)]); Object.assign(tabs.get(id), params); return { ...tabs.get(id) }; },
      group: async params => { const id = params.groupId ?? 40; for (const tabId of params.tabIds) tabs.get(tabId).groupId = id; return id; },
      remove: async id => { calls.push(['remove', id]); tabs.delete(id); },
      captureVisibleTab: async () => { calls.push(['capture']); return 'data:image/png;base64,PNG'; },
      onCreated: event(), onRemoved: event()
    },
    windows: { get: async id => { if (!windows.has(id)) throw new Error('No window'); return { ...windows.get(id) }; },
      getAll: async () => [...windows.values()], getLastFocused: async () => ({ ...windows.get(1) }) },
    tabGroups: { update: async () => {} },
    debugger: { onDetach: event(),
      attach: async target => { calls.push(['attach', target.tabId]); if (hooks.attach) await hooks.attach(target); },
      detach: async target => { calls.push(['detach', target.tabId]); },
      sendCommand: async (target, method) => { calls.push(['cdp', method]); return { data: 'PNG' }; } },
    scripting: { executeScript: async spec => {
      calls.push(['script', spec.target.tabId, spec.files ? 'inject' : spec.args?.[0]]);
      if (spec.files) return [{ frameId: 0 }];
      if (!spec.args) return [{ result: false }];
      const payload = spec.args[0] === 'snapshot' ? { title: 'Fixture', elements: [] } : { x: 10, y: 20 };
      return [{ frameId: 0, result: { protocol: 'ai-browser-page-rpc-v1', ok: true, payload, diagnostic: { stage: 'serialize', resultKind: 'object' } } }];
    } }
  };
  const context = vm.createContext({ chrome, URL, AbortController, TextEncoder,
    setTimeout: (fn, ms) => { const id = ++timer; timers.set(id, { fn, ms }); return id; }, clearTimeout: id => timers.delete(id),
    fetch: async () => ({ ok: true, status: 204, body: { cancel: async () => {} } }) });
  const run = code => vm.runInContext(code, context);
  context.importScripts = name => run(source(name));
  run(source('background.js'));
  return { tabs, calls, hooks, run,
    ready: async () => { await run('ready'); await tick(); run('wantDisconnect = false'); },
    exec: (method, params = {}) => run('executeBounded(' + JSON.stringify({ id: 'rt-' + ++command, method, params }) + ')'),
    task: (action, params = {}) => run('taskTabs.task(' + JSON.stringify({ action, taskId: 'same', ...params }) + ')'),
    registry: () => run('taskTabs') };
}

const restrictedDiagnostic = diagnostic => {
  assert.equal(diagnostic.stage, 'preflight');
  assert.equal(diagnostic.phase, 'tabs.get');
  assert.equal(diagnostic.errorCode, 'UNSUPPORTED_TAB_URL');
};

test('screenshot and snapshot classify committed restricted URLs before attach or injection', async () => {
  const h = fixture(); await h.ready();
  for (const method of ['snapshot', 'screenshot']) {
    const error = await h.exec(method, { tabId: 11, ...(method === 'snapshot' ? { load: 'current' } : {}) }).catch(e => e);
    assert.equal(error.code, 'UNSUPPORTED_TAB_URL');
    assert.equal(error.outcome, 'not-dispatched');
    restrictedDiagnostic(error.diagnostic);
    assert.equal(error.diagnostic.protocol, 'chrome-extension');
    assert.equal(error.diagnostic.otherExtension, true);
    const leak = error.message + JSON.stringify(error.diagnostic);
    assert(!leak.includes(RESTRICTED));
    assert(!leak.includes('different extension'));
  }
  assert(!h.calls.some(call => call[0] === 'attach'), 'no debugger attach before classification');
  assert(!h.calls.some(call => call[0] === 'cdp'), 'no CDP command dispatched');
  assert(!h.calls.some(call => call[0] === 'script'), 'no page agent injection');
});

test('a later preflight retains an unverified outcome after earlier page work', async () => {
  const h = fixture(); await h.ready();
  await assert.rejects(h.run('ensureAllowed(11, Object.assign(() => {}, { pageWorkStarted: true }))'), {
    code: 'UNSUPPORTED_TAB_URL', outcome: 'unverified'
  });
});

test('committed URL evidence stays within the fixed allowlist and boolean', async () => {
  const h = fixture(); await h.ready();
  const own = await h.exec('snapshot', { tabId: 12, load: 'current' }).catch(e => e);
  restrictedDiagnostic(own.diagnostic);
  assert.equal(own.diagnostic.protocol, 'chrome-extension');
  assert.equal(own.diagnostic.otherExtension, false);
  const settings = await h.exec('inspect', { tabId: 13 }).catch(e => e);
  restrictedDiagnostic(settings.diagnostic);
  assert.equal(settings.diagnostic.protocol, 'chrome');
  assert.equal(settings.diagnostic.otherExtension, undefined);
  const file = await h.exec('snapshot', { tabId: 14, load: 'current' }).catch(e => e);
  restrictedDiagnostic(file.diagnostic);
  assert.equal(file.diagnostic.protocol, 'file');
  assert.equal(file.diagnostic.otherExtension, undefined);
  const app = await h.exec('screenshot', { tabId: 15 }).catch(e => e);
  restrictedDiagnostic(app.diagnostic);
  assert.equal(app.diagnostic.protocol, undefined, 'unknown schemes are not echoed');
  assert.equal(app.code, 'UNSUPPORTED_TAB_URL');
  for (const tabId of [12, 13, 14, 15]) assert(!h.calls.some(call => (call[0] === 'attach' || call[0] === 'script') && call[1] === tabId));
});

test('mode and authorization gates run before committed URL classification', async () => {
  const h = fixture({ autoAuthorize: false }); await h.ready();
  const auth = await h.exec('snapshot', { tabId: 11, load: 'current' }).catch(e => e);
  assert.match(auth.message, /授权/);
  assert.notEqual(auth.code, 'UNSUPPORTED_TAB_URL');
  const mismatch = await h.exec('screenshot', { tabId: 11, browserMode: 'incognito' }).catch(e => e);
  assert.equal(mismatch.code, 'BROWSER_MODE_MISMATCH');
  assert.equal(mismatch.outcome, 'not-dispatched');
  h.run('authorized.add(11)');
  const classified = await h.exec('snapshot', { tabId: 11, load: 'current' }).catch(e => e);
  assert.equal(classified.code, 'UNSUPPORTED_TAB_URL');
  assert.equal(classified.diagnostic.otherExtension, true);
});

test('authorized navigate recovers restricted targets to explicit HTTP(S) with unchanged gates and lock', async () => {
  const h = fixture({ autoAuthorize: false }); await h.ready();
  const denied = await h.exec('navigate', { tabId: 11, url: 'https://recovery.test/page' }).catch(e => e);
  assert.match(denied.message, /授权/);
  assert(!h.calls.some(call => call[0] === 'update'));
  const mismatch = await h.exec('navigate', { tabId: 11, browserMode: 'incognito', url: 'https://recovery.test/page' }).catch(e => e);
  assert.equal(mismatch.code, 'BROWSER_MODE_MISMATCH');
  assert(!h.calls.some(call => call[0] === 'update'));
  h.run('authorized.add(11)');
  const invalid = await h.exec('navigate', { tabId: 11, url: 'file:///C:/private.txt' }).catch(e => e);
  assert.equal(invalid.code, 'INVALID_ARGUMENTS');
  assert.equal(invalid.outcome, 'not-dispatched');
  assert(!h.calls.some(call => call[0] === 'update'));
  const recovered = await h.exec('navigate', { tabId: 11, url: 'https://recovery.test/page' });
  assert.equal(recovered.navigated, true);
  assert.equal(recovered.url, 'https://recovery.test/page');
  assert.equal(recovered.browserMode, 'regular');
  assert(h.calls.some(call => call[0] === 'update' && call[1] === 11 && call[2].url === 'https://recovery.test/page'));
  const after = await h.exec('snapshot', { tabId: 11, load: 'current' });
  assert.equal(after.browserMode, 'regular');
  assert(h.calls.some(call => call[0] === 'script' && call[1] === 11));
});

test('active-tab screenshot mode preflights the committed URL the same way', async () => {
  const h = fixture({ screenshotCdpEnabled: false }); await h.ready();
  const error = await h.exec('screenshot', { tabId: 11 }).catch(e => e);
  assert.equal(error.code, 'UNSUPPORTED_TAB_URL');
  restrictedDiagnostic(error.diagnostic);
  assert.equal(error.diagnostic.otherExtension, true);
  assert(!h.calls.some(call => call[0] === 'capture'));
  const ok = await h.exec('screenshot', { tabId: 7 });
  assert.equal(ok.mimeType, 'image/png');
});

test('different-extension attach race is reclassified from the committed URL without fallback or replay', async () => {
  const h = fixture(); await h.ready();
  h.hooks.attach = async () => { h.tabs.get(7).url = RESTRICTED; throw new Error(RACE_ERROR); };
  const error = await h.exec('screenshot', { tabId: 7 }).catch(e => e);
  assert.equal(error.code, 'UNSUPPORTED_TAB_URL');
  assert.equal(error.outcome, 'not-dispatched');
  assert.equal(error.diagnostic.otherExtension, true);
  assert(!(error.message + JSON.stringify(error.diagnostic)).includes(RACE_ERROR));
  assert.equal(h.calls.filter(call => call[0] === 'attach').length, 1, 'attach is never replayed');
  assert(!h.calls.some(call => call[0] === 'cdp'));
  assert(!h.calls.some(call => call[0] === 'capture'), 'no visible-tab fallback');
});

test('race rechecking back to HTTP(S) retains the conservative outcome without fallback', async () => {
  const h = fixture(); await h.ready();
  h.hooks.attach = async () => { throw new Error(RACE_ERROR); };
  const screenshotError = await h.exec('screenshot', { tabId: 7 }).catch(e => e);
  assert.match(screenshotError.message, /different extension/);
  assert.equal(screenshotError.outcome, 'not-dispatched');
  assert.equal(h.calls.filter(call => call[0] === 'attach').length, 1);
  assert(!h.calls.some(call => call[0] === 'cdp'), 'screenshot not dispatched');
  const clickError = await h.exec('click', { tabId: 7, ref: 'r1-1' }).catch(e => e);
  assert.match(clickError.message, /different extension/);
  assert.equal(clickError.outcome, 'not-dispatched');
  assert.equal(h.calls.filter(call => call[0] === 'attach').length, 2);
  assert(!h.calls.some(call => call[0] === 'script'), 'no DOM fallback injection');
});

test('release still recovers authorized pages committed to restricted URLs', async () => {
  const h = fixture({ autoAuthorize: false }); await h.ready();
  h.run('authorized.add(11)');
  const released = await h.exec('release', { tabId: 11 });
  assert.equal(released.released, true);
  assert.equal(h.run('revoked.has(11)'), true);
  assert(!h.calls.some(call => call[0] === 'attach'));
});

test('task list exposes real live url and pendingUrl after task and mode filtering without persisting', async () => {
  const h = fixture({ autoAuthorize: false }); await h.ready();
  h.tabs.get(7).pendingUrl = 'https://regular.test/next';
  h.run("taskTabs.tabs.set(7, {id:7, taskId:'same', name:'Task', groupId:17, key:'key:detail', used:1, keep:false, modified:false})");
  h.run("taskTabs.tabs.set(9, {id:9, taskId:'same', name:'Task', groupId:19, key:'key:private', used:2, keep:false, modified:false})");
  h.run("taskTabs.tabs.set(11, {id:11, taskId:'same', name:'Task', groupId:21, key:" + JSON.stringify('url:' + RESTRICTED) + ", used:3, keep:false, modified:false})");
  h.run("taskTabs.tabs.set(13, {id:13, taskId:'other', name:'Other', groupId:-1, key:'key:other', used:4, keep:false, modified:false})");
  const listed = await h.task('list', { browserMode: 'regular' });
  assert.deepEqual(listed.tabs.map(tab => tab.id), [7, 11]);
  assert.equal(listed.tabs[0].url, 'https://regular.test/');
  assert.equal(listed.tabs[0].pendingUrl, 'https://regular.test/next');
  assert.equal(listed.tabs[1].url, RESTRICTED, 'live URL of restricted target is visible');
  assert.equal(listed.tabs[0].key, 'key:detail', 'registration key remains');
  assert.equal(listed.tabs[1].key, 'url:' + RESTRICTED);
  const incognito = await h.task('list', { browserMode: 'incognito' });
  assert.deepEqual(incognito.tabs.map(tab => tab.id), [9]);
  assert.equal(incognito.tabs[0].url, 'https://private.test/');
  const record = JSON.parse(h.run("JSON.stringify(taskTabs.tabs.get(7))"));
  assert.deepEqual(record, { id: 7, taskId: 'same', name: 'Task', groupId: 17, key: 'key:detail', used: 1, keep: false, modified: false });
  assert(!('url' in record) && !('pendingUrl' in record), 'live fields never enter the registry');
});
