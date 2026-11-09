'use strict';

// 可重跑：node --test extension/tests/*.test.cjs；不启动浏览器或连接本机桥。
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const test = require('node:test');
const root = path.resolve(__dirname, '..');
const source = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const tick = () => new Promise((resolve) => setImmediate(resolve));

function backgroundHarness(stored = { cdpEnabled: true, screenshotCdpEnabled: true }) {
  const calls = [];
  const listeners = {};
  const timers = new Map();
  const event = (name) => ({ addListener: (fn) => { listeners[name] = fn; } });
  const tabs = [
    { id: 7, windowId: 1, title: 'Example', url: 'https://example.test/', active: true },
    { id: 8, url: 'chrome://settings', active: false }
  ];
  let fetchImpl = async () => { throw new Error('offline'); };
  let diagnosticFetch = async () => ({ ok: true, status: 200, body: { cancel: async () => {} } });
  let timerId = 0;
  const chrome = {
    storage: { local: {
      get: async () => stored, set: async (data) => calls.push(['store', data]), remove: async () => {}
    } },
    runtime: {
      id: 'test', getURL: (p) => `chrome-extension://test/${p}`,
      getManifest: () => ({ name: 'AI Browser Control' }),
      onMessage: event('message'), onInstalled: event('installed'), onStartup: event('startup')
    },
    alarms: {
      create: async (name, config) => calls.push(['alarm', config]), onAlarm: event('alarm')
    },
    tabs: {
      query: async () => tabs,
      captureVisibleTab: async (windowId) => { calls.push(['capture', windowId]); return 'data:image/png;base64,PNG'; },
      get: async (id) => {
        const tab = tabs.find((item) => item.id === id);
        if (!tab) throw new Error('missing');
        return tab;
      },
      update: async (id, params) => calls.push(['update', id, params]), onRemoved: event('removed')
    },
    debugger: {
      attach: async (target, version) => calls.push(['attach', target, version]),
      detach: async (target) => { calls.push(['detach', target]); listeners.detach(target); },
      sendCommand: async (target, method, params) => {
        calls.push(['cdp', method, params]);
        return method === 'Page.captureScreenshot' ? { data: 'PNG' } : {};
      },
      onDetach: event('detach')
    },
    scripting: { executeScript: async (spec) => {
      calls.push(['script', spec]);
      if (spec.files) return [{ result: undefined }];
      const result = spec.args[0] === 'prepare' ? { x: 20, y: 30 } :
        spec.args[0] === 'snapshot' ? { title: 'test', elements: [] } : { focused: true };
      return [{ result }];
    } }
  };
  const context = vm.createContext({
    chrome, URL, AbortController,
    setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => timers.delete(id),
    fetch: (...args) => {
      if (args[0].endsWith('/diagnostics')) {
        calls.push(['diagnostics', JSON.parse(args[1].body)]);
        return diagnosticFetch(...args);
      }
      return fetchImpl(...args);
    }
  });
  vm.runInContext(source('background.js'), context);
  return {
    calls, listeners, timers,
    run: (code) => vm.runInContext(code, context),
    fetch: (fn) => { fetchImpl = fn; },
    diagnosticFetch: (fn) => { diagnosticFetch = fn; }
  };
}

test('诊断环形记录有数量与字节上限，保留最新事件，存储后可跨worker恢复', async () => {
  const h = backgroundHarness({ disconnected: true });
  await tick();
  h.run("for(let i=0;i<1000;i++) diagnostic('transport_error',{status:503,retryMs:i,error:'PRIVATE-ERROR',text:'PRIVATE-TEXT'})");
  const records = JSON.parse(h.run('JSON.stringify(diagnosticLog)'));
  assert.equal(records.length, 128);
  assert(JSON.stringify(records).length < 65536);
  assert.equal(records.at(-1).retryMs, 999);
  assert(!JSON.stringify(records).includes('PRIVATE-'));
  const save = [...h.timers.values()].find(t => t.ms === 200);
  save.fn();
  await tick();
  const persisted = h.calls.filter(c => c[0] === 'store' && c[1].diagnosticLog).at(-1)[1].diagnosticLog;
  const resumed = backgroundHarness({ disconnected: true, diagnosticLog: persisted });
  await tick();
  assert(resumed.run('diagnosticLog.some(e=>e.retryMs===999)'));
  assert(resumed.run("diagnosticLog.at(-1).event==='worker_start'"));
  h.run("for(let i=0;i<1000;i++) diagnostic('transport_error',{commandId:'c'.repeat(64),method:'m'.repeat(64),phase:'p'.repeat(64),outcome:'o'.repeat(64),durationMs:99999999999999,status:99999999999999,tabId:99999999999999,retryMs:99999999999999})");
  assert(h.run('JSON.stringify(diagnosticLog).length') < 64 * 1024);
  assert(h.run('diagnosticLog.length') < 128, '长元数据达到字节上限时应先于数量上限回收');
});

test('诊断存储永久悬挂时最多保留一个写请求，后续事件仍按环形上限回收', async () => {
  const h = backgroundHarness({ disconnected: true });
  await tick();
  h.run('globalThis.qaStorageWrites=0;chrome.storage.local.set=()=>{qaStorageWrites++;return new Promise(()=>{})}');
  [...h.timers.values()].find(t => t.ms === 200).fn();
  await tick();
  h.run("for(let i=0;i<1000;i++) diagnostic('transport_error',{retryMs:i})");
  await tick();
  assert.equal(h.run('qaStorageWrites'), 1);
  assert.equal(h.run('diagnosticLog.length'), 128);
  assert.equal(h.run('diagnosticTimer'), null);
});

test('诊断补传失败不阻塞命令，恢复后补传且不重复发送已确认批次', async () => {
  const h = backgroundHarness({ disconnected: true });
  await tick();
  h.run('wantDisconnect=false;paired=true;diagnosticPending=[]');
  h.diagnosticFetch(async () => { throw new Error('offline'); });
  h.run("diagnostic('manual_connect');flushDiagnostics()");
  await tick();
  assert.equal(h.run('diagnosticPending.length'), 1);
  h.diagnosticFetch(async () => ({ ok: true, status: 200, body: { cancel: async () => {} } }));
  h.run('flushDiagnostics()');
  await tick();
  assert.equal(h.run('diagnosticPending.length'), 0);
  h.run('flushDiagnostics()');
  await tick();
  assert.equal(h.calls.filter(c => c[0] === 'diagnostics').length, 2);
});

test('悬挂定位命令诊断保留ID、最后阶段与超时，不保存输入或错误正文', async () => {
  const h = backgroundHarness({ disconnected: true, autoAuthorize: true });
  await tick();
  h.run("wantDisconnect=false;chrome.scripting.executeScript=async(spec)=>spec.files?[{}]:new Promise(()=>{})");
  const work = h.run("executeBounded({id:'hang-1',method:'fill',params:{tabId:7,ref:'r1-1',text:'PRIVATE-FORM'}})");
  const rejected = assert.rejects(work, /超时/);
  await tick();
  [...h.timers.values()].find(t => t.ms === 11000).fn();
  await rejected;
  const records = JSON.parse(h.run('JSON.stringify(diagnosticLog)'));
  const end = records.find(e => e.event === 'command_end');
  assert.equal(end.commandId, 'hang-1');
  assert.equal(end.phase, 'prepare');
  assert.equal(end.outcome, 'timeout');
  assert(records.some(e => e.event === 'step_start' && e.phase === 'prepare'));
  assert(!JSON.stringify(records).includes('PRIVATE-'));
});

test('DOM悬停与新增能力不偷偷启用CDP；按ref发送组合键先聚焦正确目标', async () => {
  const h = backgroundHarness({ autoAuthorize: true, disconnected: true });
  await tick();
  const hovering = h.run("execute({method:'hover',params:{tabId:7,ref:'r1-1',durationMs:0}})");
  await tick();
  [...h.timers.values()].find(t => t.ms === 0).fn();
  const result = await hovering;
  assert.equal(result.cssHover, false);
  assert(!h.calls.some(c => c[0] === 'attach'));
  assert(h.calls.some(c => c[0] === 'script' && c[1].args?.[0] === 'domHover'));
  await h.run("execute({method:'press',params:{tabId:7,ref:'r1-1',key:'Alt+ArrowDown'}})");
  const operations = h.calls.filter(c => c[0] === 'script' && c[1].args).map(c => c[1].args[0]);
  assert(operations.indexOf('focusTarget') < operations.indexOf('domPress'));
  const tabs = await h.run("execute({method:'list_tabs'})");
  assert.equal(tabs[0].capabilities.cssHover, false);
  assert.equal(tabs[0].capabilities.nativeBrowserMenus, false);
});

test('CDP点击按下失败仍尝试释放，组合键失败仍释放修饰键', async () => {
  const h = backgroundHarness({ autoAuthorize: true, cdpEnabled: true, disconnected: true });
  await tick();
  h.run("globalThis.qaInput=[];chrome.debugger.sendCommand=async(target,method,params)=>{qaInput.push(params);if(params.type==='mousePressed'||(params.type==='rawKeyDown'&&params.key==='ArrowDown'))throw new Error('fixture failure');return {}};");
  await assert.rejects(h.run("execute({method:'click',params:{tabId:7,ref:'r1-1'}})"), /fixture/);
  assert(h.run("qaInput.some(p=>p.type==='mouseReleased')"));
  await assert.rejects(h.run("execute({method:'press',params:{tabId:7,key:'Alt+ArrowDown'}})"), /fixture/);
  assert(h.run("qaInput.some(p=>p.type==='keyUp'&&p.key==='Alt'&&p.modifiers===0)"));
});

test('后台授权、全部方法、按键映射和撤销', async () => {
  const { calls, listeners, run } = backgroundHarness();
  await tick();
  assert.equal(calls.find((c) => c[0] === 'alarm')[1].periodInMinutes, 0.5);
  await assert.rejects(run("execute({method:'click',params:{tabId:7,ref:'r1-1'}})"), /未.*授权/);
  await run("handlePopup({type:'authorize_tab',tabId:7})"); // 只登记授权，不附加调试器
  await assert.rejects(run("handlePopup({type:'authorize_tab',tabId:8})"), /HTTP/);
  const listed = await run("execute({method:'list_tabs'})");
  assert.equal(listed.length, 1);
  assert.equal(listed[0].authorized, true);
  await run("execute({method:'status'})");
  await run("execute({method:'snapshot',params:{tabId:7}})");
  assert(calls.filter((c) => c[0] === 'script').every((c) => c[1].world === 'ISOLATED'));
  calls.length = 0;
  await run("execute({method:'click',params:{tabId:7,ref:'r1-1'}})");
  assert.equal(calls.find((c) => c[0] === 'attach')[2], '1.3', '首次写入命令才附加调试器');
  assert.deepEqual(calls.filter((c) => c[0] === 'cdp').map((c) => c[2].type),
    ['mouseMoved', 'mousePressed', 'mouseReleased']);
  calls.length = 0;
  await run("execute({method:'fill',params:{tabId:7,ref:'r1-1',text:'abc'}})");
  assert(calls.some((c) => c[0] === 'cdp' && c[2].windowsVirtualKeyCode === 65 && c[2].modifiers === 2));
  assert(calls.some((c) => c[1] === 'Input.insertText' && c[2].text === 'abc'));
  calls.length = 0;
  await run("execute({method:'fill',params:{tabId:7,ref:'r1-1',text:''}})");
  assert(calls.some((c) => c[0] === 'cdp' && c[2].key === 'Backspace'));
  assert(!calls.some((c) => c[1] === 'Input.insertText'));
  for (const key of ['Enter', 'Tab', 'Escape', 'Backspace', 'ArrowUp', 'ArrowDown',
    'ArrowLeft', 'ArrowRight', 'Space', 'Home', 'End', 'Delete', 'Control+A']) {
    await run(`execute({method:'press',params:{tabId:7,key:${JSON.stringify(key)}}})`);
  }
  assert(calls.some((c) => c[0] === 'cdp' && c[2].code === 'Space' && c[2].key === ' '));
  await assert.rejects(run("execute({method:'press',params:{tabId:7,key:'toString'}})"), /不支持/);
  await assert.rejects(run("execute({method:'navigate',params:{tabId:7,url:'javascript:alert(1)'}})"), /HTTP/);
  await run("execute({method:'navigate',params:{tabId:7,url:'https://example.test/new'}})");
  assert.deepEqual(Object.keys(calls.find((c) => c[0] === 'update')[2]), ['url']);
  assert.equal((await run("execute({method:'screenshot',params:{tabId:7}})")).mimeType, 'image/png');
  listeners.detach({ tabId: 7 });
  await assert.rejects(run("execute({method:'snapshot',params:{tabId:7}})"), /未.*授权/);
  await run("handlePopup({type:'authorize_tab',tabId:7})");
  await run("execute({method:'release',params:{tabId:7}})");
  assert.equal((await run("handlePopup({type:'popup_status'})")).authorizedTabIds.length, 0);
  assert.equal(listeners.message({}, { id: 'test', url: 'https://example.test/' }, () => {}), false);
});

test('自动授权按需附加调试、拒绝非 HTTP 页且可关闭', async () => {
  const { calls, run } = backgroundHarness();
  await tick();
  await assert.rejects(run("execute({method:'snapshot',params:{tabId:7}})"), /未.*授权/);
  const state = await run("handlePopup({type:'set_auto_authorize',enabled:true})");
  assert.equal(state.autoAuthorize, true);
  assert(calls.some((c) => c[0] === 'store' && c[1].autoAuthorize === true));
  await run("execute({method:'snapshot',params:{tabId:7}})"); // 读取：不附加调试器
  assert(!calls.some((c) => c[0] === 'attach'), '读取不应附加调试器');
  await run("execute({method:'click',params:{tabId:7,ref:'r1-1'}})"); // 写入：按需附加
  assert.equal(calls.find((c) => c[0] === 'attach')[2], '1.3');
  const status = await run("handlePopup({type:'popup_status'})");
  assert.equal(status.autoAuthorize, true);
  await assert.rejects(run("execute({method:'snapshot',params:{tabId:8}})"), /HTTP/);
  await run("handlePopup({type:'set_auto_authorize',enabled:false})");
  await run("handlePopup({type:'release_tab',tabId:7})");
  await assert.rejects(run("execute({method:'snapshot',params:{tabId:7}})"), /未.*授权/);
});

test('一键配对、单轮询、25秒超时及结果重传不重复动作', async () => {
  const { calls, listeners, timers, run, fetch } = backgroundHarness();
  await tick();
  await run("handlePopup({type:'authorize_tab',tabId:7})");
  let pairs = 0;
  let polls = 0;
  let posts = 0;
  fetch(async (url, options) => {
    assert.equal(options.headers['X-Client-Id'], 'test');
    assert.equal(options.cache, 'no-store');
    if (url.endsWith('/pair') || url.endsWith('/unpair')) {
      if (url.endsWith('/pair')) pairs++;
      return { ok: true, status: 200, body: { cancel: async () => {} } };
    }
    if (url.endsWith('/poll')) {
      assert.equal(options.method, 'GET');
      polls++;
      if (polls <= 2) return {
        ok: true, status: 200,
        json: async () => ({ id: 'same-action', method: 'click', params: { tabId: 7, ref: 'r1-1' } })
      };
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }
    assert.equal(options.method, 'POST');
    posts++;
    assert.equal(JSON.parse(options.body).id, 'same-action');
    if (posts === 1) throw new Error('dropped result');
    return { ok: true, status: 200, body: { cancel: async () => {} } };
  });
  calls.length = 0;
  await run("handlePopup({type:'connect'})");
  await tick();
  assert.ok(pairs >= 1 && pairs <= 2, 'connect 与循环的配对竞态合计 1-2 次');
  // connect 唤醒退避中的循环：立即恢复轮询并执行第一条指令（含光标脚本注入）
  assert.equal(polls, 1);
  assert.equal(posts, 1);
  assert.equal(calls.filter((c) => c[0] === 'cdp' && c[2].type === 'mousePressed').length, 1);
  const fire = (ms) => { for (const [id, timer] of [...timers]) if (timer.ms === ms) { timers.delete(id); timer.fn(); } };
  fire(2000);
  await tick();
  fire(2000);
  await tick();
  // 重试周期的重复 /pair 幂等无害；断开后配对次数不再增长才是关键不变量
  const pairsBeforeDisconnect = pairs;
  assert.ok(pairsBeforeDisconnect >= 1 && pairsBeforeDisconnect <= 4);
  assert.equal(posts, 3);
  assert.equal(polls, 3);
  assert.equal(calls.filter((c) => c[0] === 'cdp' && c[2].type === 'mousePressed').length, 1);
  for (let i = 0; i < 5; i++) listeners.alarm({ name: 'zcode-bridge-wakeup' });
  await tick();
  assert.equal(polls, 3);
  assert([...timers.values()].some((timer) => timer.ms === 25000));
  // 断开后循环空转待命：不再自动重新配对，状态保持已断开
  await run("handlePopup({type:'disconnect'})");
  await tick();
  assert.equal(run("bridgeState"), '已断开');
  await tick();
  await tick();
  assert.equal(pairs, pairsBeforeDisconnect, '断开后不自动重连');
  assert.equal(run("bridgeState"), '已断开');
  assert.equal(run("bridgeState"), '已断开');
});

test('命令悬挂到期后继续poll，迟到定位不再点击，同一id不自动重放', async () => {
  const { run, fetch, timers, calls } = backgroundHarness({ disconnected: true });
  await tick();
  let polls = 0, posts = 0;
  fetch(async (url, options) => {
    if (url.endsWith('/pair') || url.endsWith('/unpair') || url.endsWith('/result')) {
      if (url.endsWith('/result')) posts++;
      return { ok: true, status: 200, body: { cancel: async () => {} } };
    }
    if (url.endsWith('/status')) return { ok: true, status: 200, json: async () => ({ connected: true, standby: false, client: 'chrome-extension://test' }) };
    polls++;
    if (polls <= 2) return { ok: true, status: 200, json: async () => ({ id: 'hung-click', method: 'click', params: { tabId: 7, ref: 'r1-1' } }) };
    return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  });
  await run("handlePopup({type:'authorize_tab',tabId:7})");
  await run("let releasePrepare;const originalPageAgent=pageAgent;pageAgent=async(id,op,value)=>op==='prepare'?new Promise(done=>releasePrepare=done):originalPageAgent(id,op,value);");
  await run("handlePopup({type:'connect'})");
  await tick();
  assert.equal(polls, 1);
  for (const [id, timer] of [...timers]) if (timer.ms === 11000) { timers.delete(id); timer.fn(); }
  await tick();
  assert.equal(polls, 3, '超时回执及重复id回执后恢复poll');
  assert.equal(posts, 2);
  assert.match(run("completed.get('hung-click').error.message"), /结果不确定/);
  await assert.rejects(run("executeBounded({id:'another',method:'click',params:{tabId:7,ref:'r1-1'}})"), /上一条操作仍未结束/);
  await run('releasePrepare({x:20,y:30})');
  await tick();
  assert(!calls.some(c => c[0] === 'cdp' && c[2].type === 'mousePressed'), '迟到prepare不得继续点击');
  assert.equal(run('runningTabs.size'), 0);
});

test('配对成功不能代替命令通道；桥心跳过期时状态拒绝假连接', async () => {
  const { run, fetch } = backgroundHarness({ disconnected: true });
  await tick();
  fetch(async () => ({ ok: true, status: 200, json: async () => ({ connected: false, standby: false, client: 'chrome-extension://test' }) }));
  run('wantDisconnect=false;paired=true;lastPollAt=Date.now();');
  const state = await run("handlePopup({type:'popup_status'})");
  assert.equal(state.connected, false);
  assert.equal(state.connecting, true);
  assert.match(state.bridgeState, /未响应/);
  assert.equal(run('paired'), false);
});

test('DOM写入前脚本注入迟到时，操作到期不得继续派发domFill', async () => {
  const { run, calls, timers } = backgroundHarness({ disconnected: true });
  await tick();
  await run("handlePopup({type:'authorize_tab',tabId:7})");
  run("wantDisconnect=false;cdpEnabled=false;let resumeInjection;const actualScript=chrome.scripting.executeScript;let filesCount=0;chrome.scripting.executeScript=spec=>spec.files&&++filesCount===3?new Promise(done=>resumeInjection=()=>done([{result:undefined}])):actualScript(spec)");
  const work = run("executeBounded({id:'late-fill',method:'fill',params:{tabId:7,ref:'r1-1',text:'do-not-write'}})");
  const caught = assert.rejects(work, /等待超时/);
  await tick();
  for (const [id, timer] of [...timers]) if (timer.ms === 11000) { timers.delete(id); timer.fn(); }
  await caught;
  await run('resumeInjection()');
  await tick();
  assert(!calls.some(c => c[0] === 'script' && c[1].args?.[0] === 'domFill'));
});

test('断开后的旧pair迟到不会恢复连接，重连不受旧请求污染', async () => {
  const { run, fetch } = backgroundHarness({ disconnected: true });
  await tick();
  let finishPair;
  fetch(async url => url.endsWith('/pair') ? new Promise(done => { finishPair = done; }) : { ok: true, status: 200, body: { cancel: async () => {} } });
  const connecting = run("handlePopup({type:'connect'})").catch(e => e);
  await tick();
  await run("handlePopup({type:'disconnect'})");
  finishPair({ ok: true, status: 200, body: { cancel: async () => {} } });
  await connecting;
  await tick();
  assert.equal(run('paired'), false);
  assert.equal((await run("handlePopup({type:'popup_status'})")).connected, false);
});

test('网络忽略abort或正文不结束仍有硬期限，不会永久占住循环', async () => {
  const { run, fetch, timers } = backgroundHarness({ disconnected: true });
  await tick();
  fetch(async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) }));
  const pending = run("bridgeFetch('/poll')");
  const caught = assert.rejects(pending, /超时/);
  for (const [id, timer] of [...timers]) if (timer.ms === 25000) { timers.delete(id); timer.fn(); }
  await caught;
  assert.equal(run('requestControllers.size'), 0);
});

test('结果重传收到403会重新配对，不会在未配对状态反复卡住result', async () => {
  const { run, fetch, timers } = backgroundHarness({ disconnected: true });
  await tick();
  let pairs = 0, posts = 0, polls = 0;
  fetch(async (url, options) => {
    if (url.endsWith('/pair')) { pairs++; return { ok: true, status: 200, body: { cancel: async () => {} } }; }
    if (url.endsWith('/result')) {
      posts++;
      return posts === 1 ? { ok: false, status: 403, json: async () => ({ error: '来源未配对' }) } : { ok: true, status: 200, body: { cancel: async () => {} } };
    }
    polls++;
    if (polls === 1) return { ok: true, status: 200, json: async () => ({ id: 'result-repair', method: 'list_tabs' }) };
    return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  });
  await run("handlePopup({type:'connect'})");
  await tick();
  assert.equal(posts, 1);
  for (const [id, timer] of [...timers]) if (timer.ms === 2000) { timers.delete(id); timer.fn(); }
  await tick();
  assert.equal(pairs, 2);
  assert.equal(posts, 2);
  assert.equal(polls, 2);
});

function pageHarness() {
  let nodes = [];
  let hit = null;
  const document = {
    title: 'Mock page', body: { innerText: '可见文本'.repeat(5000) }, activeElement: null,
    querySelectorAll: selector => (selector === '*' || selector.startsWith('input,textarea,select,button,a,')) ? nodes : [],
    getElementById: () => null,
    elementFromPoint: () => hit
  };
  class Element {
    constructor(tag, attrs = {}) {
      this.tagName = tag.toUpperCase(); this.attrs = attrs; this.isConnected = true;
      this.parentElement = null; this.innerText = ''; this.textContent = ''; this.value = '';
      this.type = attrs.type || 'text'; this.isContentEditable = false; this.readOnly = false;
    }
    getAttribute(name) { return this.attrs[name] ?? null; }
    hasAttribute(name) { return Object.hasOwn(this.attrs, name); }
    closest(selector) {
      if (selector === '[hidden]' && this.hasAttribute('hidden')) return this;
      if (selector.includes('[inert]') && this.hasAttribute('inert')) return this;
      return null;
    }
    getClientRects() {
      return this.type === 'hidden' ? [] : [{ left: 10, right: 110, top: 10, bottom: 30, width: 100, height: 20 }];
    }
    matches(selector) { return selector === ':disabled' && Boolean(this.disabled); }
    querySelectorAll() { return []; }
    contains(other) { return other === this; }
    scrollIntoView() { hit = this; }
    focus() { document.activeElement = this; }
  }
  class HTMLInputElement extends Element { constructor(attrs) { super('input', attrs); } }
  class HTMLTextAreaElement extends Element { constructor(attrs) { super('textarea', attrs); } }
  class HTMLSelectElement extends Element { constructor(attrs) { super('select', attrs); } }
  const context = vm.createContext({
    Element, HTMLInputElement, HTMLTextAreaElement, HTMLSelectElement, document,
    location: { href: 'https://example.test/' }, innerHeight: 800, innerWidth: 1200,
    getComputedStyle: (element) => ({ display: element.attrs.display || 'block', visibility: 'visible', opacity: '1' }),
    setTimeout
  });
  const inject = () => vm.runInContext(source('page-agent.js'), context);
  inject();
  return {
    document, Element, HTMLInputElement, HTMLTextAreaElement,
    setNodes: (items) => { nodes = items; }, inject,
    get agent() { return context.__aiBrowserPageAgent6; }
  };
}

test('页面快照上限、隐藏过滤、密码保密、重复注入保留refs及快照使旧refs过期', async () => {
  const h = pageHarness();
  const input = new h.HTMLInputElement(); input.value = '文本';
  const password = new h.HTMLInputElement({ type: 'password' }); password.value = 'SECRET_PASSWORD';
  const hidden = new h.HTMLInputElement({ type: 'hidden' }); hidden.value = 'HIDDEN_SECRET';
  const hiddenButton = new h.Element('button', { hidden: '' });
  const displayNone = new h.Element('button', { display: 'none' });
  const extras = Array.from({ length: 160 }, () => new h.Element('button'));
  h.setNodes([input, password, hidden, hiddenButton, displayNone, ...extras]);
  const first = await h.agent.snapshot();
  assert.equal(first.text.length, 12000);
  assert.equal(first.elements.length, 150);
  assert.equal(first.coverage.scope, 'loaded-dom');
  assert.equal(first.coverage.dataCompleteness, 'unknown');
  assert.equal(first.coverage.textTruncated, true);
  assert.equal(first.coverage.elementScanLimited, true);
  assert(first.coverage.scannedCandidates < first.coverage.candidateCount);
  assert.equal(first.elements[0].value, '文本');
  assert(!Object.hasOwn(first.elements[1], 'value'));
  assert(!JSON.stringify(first).includes('SECRET'));
  const oldRef = first.elements[0].ref;
  const originalAgent = h.agent;
  h.inject();
  assert.equal(h.agent, originalAgent);
  const point = await h.agent.prepare(oldRef);
  assert.equal(point.x, 60);
  await h.agent.focus(oldRef);
  assert.equal(h.document.activeElement, input);
  assert.equal(input.value, '文本');
  const second = await h.agent.snapshot();
  assert.notEqual(second.elements[0].ref, oldRef);
  const expiredRef = await h.agent.prepare(oldRef);
  assert.match(expiredRef.__zcodeError, /过期/);
  const notInput = await h.agent.focus(second.elements[2].ref);
  assert.match(notInput.__zcodeError, /仅支持/);
  input.readOnly = true;
  const readOnly = await h.agent.focus(second.elements[0].ref);
  assert.match(readOnly.__zcodeError, /只读/);
  input.readOnly = false;
  input.isConnected = false;
  const removed = await h.agent.prepare(second.elements[0].ref);
  assert.match(removed.__zcodeError, /已移除/);
});

test('页面代理返回 null 或携带 error 时，报告真实原因而非解构报错', async () => {
  const event = { addListener() {} };
  let mode = 'null';
  const timers = new Map();
  let timerId = 0;
  const source = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
  const context = vm.createContext({
    URL, AbortController,
    // 假定时器：无 fetch 时后台重试的 sleep 停在假计时器上，避免真实事件循环挂起。
    setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => timers.delete(id),
    chrome: {
      storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
      runtime: { id: 'test', getURL: (p) => `ext://${p}`, getManifest: () => ({ name: 'AI' }),
        onMessage: event, onInstalled: event, onStartup: event },
      alarms: { create: async () => {}, onAlarm: event },
      tabs: { query: async () => [{ id: 7, url: 'https://x.test/' }],
        get: async (id) => ({ id, url: 'https://x.test/' }), onRemoved: event },
      debugger: { attach: async () => {}, detach: async () => {}, sendCommand: async () => ({}), onDetach: event },
      scripting: { executeScript: async (spec) => {
        if (spec.files) return [{ result: undefined }];
        return mode === 'null' ? [{ result: null }] : [{ result: undefined, error: { message: '目标中心被其他元素遮挡' } }];
      } }
    }
  });
  vm.runInContext(source, context);
  const run = (code) => vm.runInContext(code, context);
  await tick();
  await run("handlePopup({type:'authorize_tab',tabId:7})");
  await assert.rejects(run("execute({method:'click',params:{tabId:7,ref:'r1-1'}})"), /页面代理未返回结果/);
  mode = 'error';
  await assert.rejects(run("execute({method:'snapshot',params:{tabId:7}})"), /目标中心被其他元素遮挡/);
});

test('长列表不会挤掉当前弹窗按钮，保留控件仍按 DOM 顺序输出', async () => {
  const h = pageHarness();
  const rows = Array.from({ length: 180 }, (_, index) => {
    const node = new h.Element('button');
    node.innerText = `航班 ${index}`;
    node.getClientRects = () => [{ left: 10, right: 110, top: 2000 + index * 20, bottom: 2020 + index * 20, width: 100, height: 20 }];
    return node;
  });
  const close = new h.Element('button'); close.innerText = '我知道了';
  h.setNodes([...rows, close]);
  const snap = await h.agent.snapshot();
  assert.equal(snap.elements.length, 150);
  assert.equal(snap.elements.at(-1).name, '我知道了');
  assert.equal(snap.elements[0].name, '航班 0');
  assert.equal(snap.coverage.selectionPriority, 'viewport-first');
  assert.equal(snap.coverage.elementScanLimited, true);
  const point = await h.agent.prepare(snap.elements.at(-1).ref);
  assert.equal(point.x, 60);
});

test('列表复用同一个按钮节点时，身份变化阻止点击；同名按钮要求业务上下文', async () => {
  const h = pageHarness();
  const first = new h.Element('button'); first.innerText = '订票';
  const second = new h.Element('button'); second.innerText = '订票';
  const row1 = new h.Element('article'); row1.innerText = '航班 F001 订票';
  const row2 = new h.Element('article'); row2.innerText = '航班 F002 订票';
  first.parentElement = row1; second.parentElement = row2;
  h.setNodes([first, second]);
  const snap = await h.agent.snapshot({ load: 'current' });
  assert.equal(snap.elements[1].context, '航班 F002 订票');
  assert.equal(snap.elements[1].requiresExpectedContext, true);
  assert.match((await h.agent.prepare({ ref: snap.elements[1].ref, action: 'click' })).__zcodeError, /expectedContext/);
  assert.match((await h.agent.prepare({ ref: snap.elements[1].ref, expectedContext: 'F001' })).__zcodeError, /不符/);
  assert.equal((await h.agent.prepare({ ref: snap.elements[1].ref, expectedContext: 'F002' })).x, 60);
  row2.innerText = '航班 F999 订票';
  assert.match((await h.agent.prepare(snap.elements[1].ref)).__zcodeError, /身份已变化/);
  assert.match((await h.agent.domClick(snap.elements[1].ref)).__zcodeError, /身份已变化/);
});

test('点击回执明确未验证业务结果，快照默认自动加载且可显式只回读当前DOM', async () => {
  const { run, calls } = backgroundHarness({});
  await tick();
  await run("handlePopup({type:'authorize_tab',tabId:7})");
  await run("execute({method:'snapshot',params:{tabId:7}})");
  assert(calls.some(c => c[0] === 'script' && c[1].args?.[0] === 'snapshot' && c[1].args[1].load === 'auto'));
  await run("execute({method:'snapshot',params:{tabId:7,load:'current'}})");
  assert(calls.some(c => c[0] === 'script' && c[1].args?.[0] === 'snapshot' && c[1].args[1].load === 'current'));
  const result = await run("execute({method:'click',params:{tabId:7,ref:'r1-1',expectedContext:'F002'}})");
  assert.equal(result.actionDispatched, true);
  assert.equal(result.outcome, 'unverified');
  assert.match(result.verificationRequired, /身份/);
  assert(calls.some(c => c[0] === 'script' && c[1].args?.[0] === 'prepare' && c[1].args[1].expectedContext === 'F002'));
  await run("execute({method:'scroll',params:{tabId:7,direction:'bottom'}})");
  assert(calls.some(c => c[0] === 'script' && c[1].args?.[0] === 'scroll'));
});

test('光标消失延时：0-60 秒校验、持久化并可随命令下发', async () => {
  const { calls, run } = backgroundHarness();
  await tick();
  await assert.rejects(run("handlePopup({type:'set_cursor_hide',seconds:61})"), /0-60/);
  await assert.rejects(run("handlePopup({type:'set_cursor_hide',seconds:-1})"), /0-60/);
  const st = await run("handlePopup({type:'set_cursor_hide',seconds:10})");
  assert.equal(st.cursorHideSec, 10);
  assert(calls.some((c) => c[0] === 'store' && c[1].cursorHideSec === 10));
  const status = await run("handlePopup({type:'popup_status'})");
  assert.equal(status.cursorHideSec, 10);
});

test('输入 CDP 与截图 CDP 独立，截图可单独关闭并回退当前页接口', async () => {
  const { calls, run } = backgroundHarness();
  await tick();
  await run("handlePopup({type:'set_auto_authorize',enabled:true})");
  await run("execute({method:'click',params:{tabId:7,ref:'r1-1'}})");
  assert(calls.some(c => c[0] === 'attach'));
  calls.length = 0;
  await run("handlePopup({type:'set_cdp_enabled',enabled:false})");
  assert(calls.some(c => c[0] === 'detach'));
  await run("execute({method:'snapshot',params:{tabId:7}})");          // 读取不受影响
  assert(!calls.some((c) => c[0] === 'attach'), '读取不附加调试器');
  assert.equal((await run("execute({method:'click',params:{tabId:7,ref:'r1-1'}})")).mode, 'dom');
  await run("execute({method:'fill',params:{tabId:7,ref:'r1-1',text:'abc'}})");
  await run("execute({method:'press',params:{tabId:7,key:'Enter'}})");
  assert(calls.some(c => c[0] === 'script' && c[1].args?.[0] === 'domFill'));
  assert(calls.some(c => c[0] === 'script' && c[1].args?.[0] === 'domPress'));
  assert(!calls.some(c => c[0] === 'cdp' || c[0] === 'attach'), 'DOM 模式不调用 CDP');
  assert.equal((await run("execute({method:'screenshot',params:{tabId:7}})")).data, 'PNG');
  assert(calls.some(c => c[0] === 'cdp' && c[1] === 'Page.captureScreenshot'));
  assert.equal((await run("handlePopup({type:'popup_status'})")).cdpEnabled, false);
  await run("handlePopup({type:'set_screenshot_cdp_enabled',enabled:false})");
  calls.length = 0;
  assert.equal((await run("execute({method:'screenshot',params:{tabId:7}})")).data, 'PNG');
  assert(!calls.some(c => c[0] === 'cdp' || c[0] === 'attach'));
  await run("chrome.tabs.query=async()=>[{id:9}]");
  await assert.rejects(run("execute({method:'screenshot',params:{tabId:7}})"), /当前选中/);
  assert.equal(calls.filter(c => c[0] === 'capture').length, 1, '后台目标拒绝时不截其他页面');
  await run("handlePopup({type:'set_cdp_enabled',enabled:true})");
  await run("execute({method:'click',params:{tabId:7,ref:'r1-1'}})");
  assert(calls.some((c) => c[0] === 'attach'), '重新开启后写入恢复');
  const st = await run("handlePopup({type:'popup_status'})");
  assert.equal(st.cdpEnabled, true);
});

test('默认 DOM 输入、允许独立截图；截图只调用捕获命令并解除临时附加', async () => {
  const { calls, run } = backgroundHarness({});
  await tick();
  const state = await run("handlePopup({type:'popup_status'})");
  assert.equal(state.cdpEnabled, false);
  assert.equal(state.screenshotCdpEnabled, true);
  await run("handlePopup({type:'authorize_tab',tabId:7})");
  const click = await run("execute({method:'click',params:{tabId:7,ref:'r1-1'}})");
  assert.equal(click.mode, 'dom');
  assert(!calls.some(c => c[0] === 'attach'));
  calls.length = 0;
  await run("execute({method:'screenshot',params:{tabId:7}})");
  assert.deepEqual(calls.filter(c => c[0] === 'cdp').map(c => c[1]), ['Page.captureScreenshot']);
  assert.equal(calls.filter(c => c[0] === 'attach').length, 1);
  assert.equal(calls.filter(c => c[0] === 'detach').length, 1);
  assert.equal(run('attached.size'), 0);
  await run("execute({method:'snapshot',params:{tabId:7}})");
  const tab = (await run("execute({method:'list_tabs'})"))[0];
  assert.equal(tab.inputMode, 'dom');
  assert.equal(tab.screenshotMode, 'cdp');
  calls.length = 0;
  await run("chrome.debugger.sendCommand=async()=>{throw new Error('capture failed')}");
  await assert.rejects(run("execute({method:'screenshot',params:{tabId:7}})"), /capture failed/);
  assert.equal(run('attached.size'), 0, '截图失败也必须解除临时附加');
  assert.equal(calls.filter(c => c[0] === 'detach').length, 1);
  const persisted = backgroundHarness({ cdpEnabled: true, screenshotCdpEnabled: false });
  await tick();
  const saved = await persisted.run("handlePopup({type:'popup_status'})");
  assert.equal(saved.cdpEnabled, true);
  assert.equal(saved.screenshotCdpEnabled, false);
});

test('轨迹时间与光标时间独立，默认5秒、最多60秒并可持久化', async () => {
  const { calls, run } = backgroundHarness();
  await tick();
  assert.equal((await run("handlePopup({type:'popup_status'})")).cursorTrailSec, 5);
  for (const seconds of [-1, 61, 1.5, '5']) {
    await assert.rejects(run(`handlePopup({type:'set_cursor_trail',seconds:${JSON.stringify(seconds)}})`), /0-60/);
  }
  await run("handlePopup({type:'set_cursor_trail',seconds:60})");
  assert(calls.some(c => c[0] === 'store' && c[1].cursorTrailSec === 60));
  const state = await run("handlePopup({type:'popup_status'})");
  assert.equal(state.cursorTrailSec, 60);
  assert.equal(state.cursorHideSec, 10);
  await run("handlePopup({type:'authorize_tab',tabId:7})");
  await run("execute({method:'click',params:{tabId:7,ref:'r1-1'}})");
  assert(calls.some(c => c[0] === 'script' && c[1].args?.[0] === 'showCursor' && c[1].args[1].trailMs === 60000));
  const persisted = backgroundHarness({ cursorTrailSec: 0 });
  await tick();
  assert.equal((await persisted.run("handlePopup({type:'popup_status'})")).cursorTrailSec, 0);
});

test('释放授权在自动模式下生效，手动重新授权后恢复', async () => {
  const { run } = backgroundHarness();
  await tick();
  await run("handlePopup({type:'set_auto_authorize',enabled:true})");
  assert.equal((await run("execute({method:'list_tabs'})"))[0].authorized, true);
  await run("execute({method:'release',params:{tabId:7}})");
  assert.equal((await run("execute({method:'list_tabs'})"))[0].authorized, false);
  await assert.rejects(run("execute({method:'snapshot',params:{tabId:7}})"), /已释放/);
  await run("handlePopup({type:'authorize_tab',tabId:7})");
  await run("execute({method:'snapshot',params:{tabId:7}})");
});

test('断开选择持久化，后台重启不自动配对', async () => {
  const { run, calls, fetch } = backgroundHarness({ disconnected: true });
  let requests = 0;
  fetch(async () => { requests++; throw new Error('offline'); });
  await tick();
  assert.equal(requests, 0);
  const state = await run("handlePopup({type:'popup_status'})");
  assert.equal(state.connected, false);
  assert.equal(state.connecting, false);
  await run("handlePopup({type:'disconnect'})");
  assert(calls.some(c => c[0] === 'store' && c[1].disconnected === true));
});

test('截图期间切页会丢弃图片，不返回其他标签页内容', async () => {
  const { run } = backgroundHarness();
  await tick();
  await run("handlePopup({type:'set_auto_authorize',enabled:true})");
  await run("handlePopup({type:'set_cdp_enabled',enabled:false})");
  await run("handlePopup({type:'set_screenshot_cdp_enabled',enabled:false})");
  await run("let queries=0;chrome.tabs.query=async()=>[{id:++queries===1?7:9}]");
  await assert.rejects(run("execute({method:'screenshot',params:{tabId:7}})"), /已丢弃截图/);
});

test('用户取消调试后，自动授权也不偷偷重新附加', async () => {
  const { run, listeners, calls } = backgroundHarness();
  await tick();
  await run("handlePopup({type:'set_auto_authorize',enabled:true})");
  await run("execute({method:'click',params:{tabId:7,ref:'r1-1'}})");
  listeners.detach({ tabId: 7 });
  calls.length = 0;
  await assert.rejects(run("execute({method:'click',params:{tabId:7,ref:'r1-1'}})"), /已释放/);
  assert(!calls.some(c => c[0] === 'attach'));
});

test('光标移动期间目标移位时不按旧坐标点击', async () => {
  const { run, calls } = backgroundHarness();
  await tick();
  await run("handlePopup({type:'authorize_tab',tabId:7})");
  await run("let prepares=0; pageAgent=async(id,op)=>op==='prepare'?{x:++prepares*20,y:30}:{};");
  await assert.rejects(run("execute({method:'click',params:{tabId:7,ref:'r1-1'}})"), /位置变化/);
  assert(!calls.some(c => c[0] === 'cdp' && c[2].type === 'mousePressed'));
});

test('桥端口可配置、失败按指数退避、成功归零', async () => {
  const { timers, run, fetch } = backgroundHarness();
  await tick(); // 初始 offline 失败 → failures=1 → 假 2000
  const urls = [];
  const msValues = () => [...timers.values()].map(t => t.ms);
  const fire = (ms) => { for (const [id, timer] of [...timers]) if (timer.ms === ms) { timers.delete(id); timer.fn(); } };

  fetch(async (url) => { urls.push(url); throw new Error('boom'); });
  await assert.rejects(run("handlePopup({type:'set_bridge_port',port:17700})"), /boom/);
  assert(urls.some(u => u.startsWith('http://127.0.0.1:17700/')), '端口配置后的请求应指向新端口');

  fire(2000); await tick(); assert(msValues().includes(4000));  // 失败#2 → 4000
  fire(4000); await tick(); assert(msValues().includes(8000));  // 失败#3 → 8000
  fire(8000); await tick(); assert(msValues().includes(16000)); // 失败#4 → 16000

  // 恢复：pair/poll 成功 → 退避归零，循环挂在长轮询上
  fetch(async (url, options) => {
    urls.push(url);
    if (url.endsWith('/pair')) return { ok: true, status: 200, body: { cancel: async () => {} } };
    if (url.endsWith('/poll')) return new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
    return { ok: true, status: 200, body: { cancel: async () => {} } };
  });
  fire(16000); await tick();
  assert(urls.some(u => u === 'http://127.0.0.1:17700/pair'));

  // 再断开：唤醒挂起的 poll 触发一次失败 → 退避从 2000 重新起步
  fetch(async () => { throw new Error('Failed to fetch'); });
  run('requestController && requestController.abort()');
  await tick();
  assert(msValues().includes(2000), '成功归零后应回到 2000 起步');
  assert(!msValues().includes(32000) && !msValues().includes(16000));
});

test('MV3 清单含图标、popup 无内联脚本且引用自动授权开关', () => {
  const manifest = JSON.parse(source('manifest.json'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.name, 'AI Browser Control');
  assert.equal(manifest.background.service_worker, 'background.js');
  assert.equal(manifest.minimum_chrome_version, '120');
  assert(!manifest.content_security_policy.extension_pages.includes('unsafe-inline'));
  assert.deepEqual(manifest.host_permissions,
    ['http://127.0.0.1:*/*', 'http://*/*', 'https://*/*']);
  for (const size of ['16', '48', '128']) {
    assert.match(manifest.icons[size], new RegExp(`icon${size}\\.png$`));
    assert(fs.existsSync(path.join(root, 'icons', `icon${size}.png`)));
  }
  const html = source('popup.html');
  assert(html.includes('<script src="popup.js" defer></script>'));
  assert(html.includes('href="popup.css"'));
  assert(html.includes('id="auto-authorize"'));
  assert(html.includes('id="toggle"'));
  assert(html.includes('id="bridge-port"'));
  assert(!/<script[^>]*>\s*[^<\s]/i.test(html));
  const popupJs = source('popup.js');
  assert(popupJs.includes("getElementById('auto-authorize')"));
  assert(popupJs.includes('set_bridge_port'));
  assert(!popupJs.includes('token'));
});
