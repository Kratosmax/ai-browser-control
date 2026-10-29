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

function backgroundHarness() {
  const calls = [];
  const listeners = {};
  const timers = new Map();
  const event = (name) => ({ addListener: (fn) => { listeners[name] = fn; } });
  const tabs = [
    { id: 7, title: 'Example', url: 'https://example.test/', active: true },
    { id: 8, url: 'chrome://settings', active: false }
  ];
  let fetchImpl = async () => { throw new Error('offline'); };
  let timerId = 0;
  const chrome = {
    storage: { local: {
      get: async () => ({}), set: async (data) => calls.push(['store', data]), remove: async () => {}
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
    fetch: (...args) => fetchImpl(...args)
  });
  vm.runInContext(source('background.js'), context);
  return {
    calls, listeners, timers,
    run: (code) => vm.runInContext(code, context),
    fetch: (fn) => { fetchImpl = fn; }
  };
}

test('后台授权、全部方法、按键映射和撤销', async () => {
  const { calls, listeners, run } = backgroundHarness();
  await tick();
  assert.equal(calls.find((c) => c[0] === 'alarm')[1].periodInMinutes, 0.5);
  await assert.rejects(run("execute({method:'click',params:{tabId:7,ref:'r1-1'}})"), /未.*授权/);
  await run("handlePopup({type:'authorize_tab',tabId:7})");
  assert.equal(calls.find((c) => c[0] === 'attach')[2], '1.3');
  await assert.rejects(run("handlePopup({type:'authorize_tab',tabId:8})"), /HTTP/);
  const listed = await run("execute({method:'list_tabs'})");
  assert.equal(listed.length, 1);
  assert.equal(listed[0].authorized, true);
  await run("execute({method:'status'})");
  await run("execute({method:'snapshot',params:{tabId:7}})");
  assert(calls.filter((c) => c[0] === 'script').every((c) => c[1].world === 'ISOLATED'));
  calls.length = 0;
  await run("execute({method:'click',params:{tabId:7,ref:'r1-1'}})");
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
  await run("execute({method:'snapshot',params:{tabId:7}})");
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
  assert.equal(pairs, 1);
  // 后台循环停在断线重试的假定时器上；触发后恢复轮询并执行第一条指令
  const fire = (ms) => { for (const [id, timer] of [...timers]) if (timer.ms === ms) { timers.delete(id); timer.fn(); } };
  fire(2000);
  await tick();
  assert.equal(polls, 1);
  assert.equal(posts, 1);
  fire(2000);
  await tick();
  // 断线重试会重新配对并重传结果，但点击动作只执行一次
  assert.equal(pairs, 2);
  assert.equal(posts, 3);
  assert.equal(polls, 3);
  assert.equal(calls.filter((c) => c[0] === 'cdp' && c[2].type === 'mousePressed').length, 1);
  for (let i = 0; i < 5; i++) listeners.alarm({ name: 'zcode-bridge-wakeup' });
  await tick();
  assert.equal(polls, 3);
  assert([...timers.values()].some((timer) => timer.ms === 25000));
  await run("handlePopup({type:'disconnect'})");
  await tick();
});

function pageHarness() {
  let nodes = [];
  let hit = null;
  const document = {
    title: 'Mock page', body: { innerText: '可见文本'.repeat(5000) }, activeElement: null,
    querySelectorAll: () => nodes,
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
    get agent() { return context.__zcodeTabAgent; }
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
  const first = h.agent.snapshot();
  assert.equal(first.text.length, 12000);
  assert.equal(first.elements.length, 150);
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
  const second = h.agent.snapshot();
  assert.notEqual(second.elements[0].ref, oldRef);
  await assert.rejects(h.agent.prepare(oldRef), /过期/);
  await assert.rejects(h.agent.focus(second.elements[2].ref), /仅支持/);
  input.readOnly = true;
  await assert.rejects(h.agent.focus(second.elements[0].ref), /只读/);
  input.readOnly = false;
  input.isConnected = false;
  await assert.rejects(h.agent.prepare(second.elements[0].ref), /已移除/);
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
