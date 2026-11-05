'use strict';

const ALARM = 'zcode-bridge-wakeup';
const authorized = new Set();
// 已附加调试器的标签页：只有写入类命令（点击/输入/截屏）需要，读取不附加——无提示条、无 CDP 痕迹。
const attached = new Set();
const revoked = new Set();
const detaching = new Set();
const tabQueues = new Map();
const completed = new Map();
let autoAuthorize = false;
// 输入默认使用 DOM；截图的 CDP 用途独立授权，不代表浏览器调试权限被降级。
let cdpEnabled = false;
let screenshotCdpEnabled = true;
// 光标消失延时（毫秒）：由弹窗配置（0-60 秒），随每次写入命令下发到页面代理。
let cursorHideMs = 10000;
let cursorTrailMs = 5000;
// 桥端口存扩展存储，弹窗可改；默认 17653 与 install.mjs 的首选端口一致。
let bridgePort = 17653;
// 配对状态只在内存里；service worker 重启后重新 /pair，同 ID 幂等。
let paired = false;
// 用户显式断开后置真：轮询循环空转待命，不再自动重连，直到再次连接。
let wantDisconnect = false;
let loopPromise = null;
let requestController = null;
let pendingResult = null;
let bridgeState = '未连接';
let bridgeFailures = 0;
// 唤醒轮询循环：连接/断开后立即生效，不等退避睡眠结束。
let wakeLoop = null;

function loopSleep(ms) {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); if (wakeLoop === done) wakeLoop = null; resolve(); };
    const timer = setTimeout(done, ms);
    wakeLoop = done;
  });
}

const ready = chrome.storage.local.get(['autoAuthorize', 'bridgePort', 'cdpEnabled', 'screenshotCdpEnabled', 'cursorHideSec', 'cursorTrailSec', 'disconnected']).then((stored) => {
  autoAuthorize = stored.autoAuthorize === true;
  cdpEnabled = stored.cdpEnabled === true;
  screenshotCdpEnabled = stored.screenshotCdpEnabled !== false;
  cursorHideMs = Number.isInteger(stored.cursorHideSec) && stored.cursorHideSec >= 0 && stored.cursorHideSec <= 60
    ? stored.cursorHideSec * 1000
    : 10000;
  cursorTrailMs = Number.isInteger(stored.cursorTrailSec) && stored.cursorTrailSec >= 0 && stored.cursorTrailSec <= 60
    ? stored.cursorTrailSec * 1000 : 5000;
  bridgePort = Number.isInteger(stored.bridgePort) && stored.bridgePort > 0 && stored.bridgePort < 65536 ? stored.bridgePort : 17653;
  wantDisconnect = stored.disconnected === true;
});

function isHttpUrl(url) {
  try {
    return ['http:', 'https:'].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function requireTabId(tabId) {
  if (!Number.isInteger(tabId) || tabId < 0) throw new Error('需要有效的 tabId');
  return tabId;
}

// 同一标签页的授权、释放和操作串行执行。
function withTab(tabId, action) {
  requireTabId(tabId);
  const previous = tabQueues.get(tabId) || Promise.resolve();
  const next = previous.catch(() => {}).then(action);
  tabQueues.set(tabId, next);
  void next.finally(() => {
    if (tabQueues.get(tabId) === next) tabQueues.delete(tabId);
  }).catch(() => {});
  return next;
}

// snapshot 本身不附加调试器；网站是否拦截仍取决于页面自身策略。
async function ensureAllowed(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!isHttpUrl(tab.url)) throw new Error('仅允许操作 HTTP(S) 标签页');
  if (revoked.has(tabId) || (!authorized.has(tabId) && !autoAuthorize)) throw new Error('该标签页尚未手动授权或已释放，请在弹窗中授权此页');
  return tab;
}

// 写入类命令（点击/输入/截屏）才附加调试器；首次写入时才出现提示条。
async function ensureAttached(tabId, purpose = 'input') {
  const tab = await ensureAllowed(tabId);
  if (purpose === 'screenshot' ? !screenshotCdpEnabled : !cdpEnabled) {
    throw new Error(purpose === 'screenshot' ? '截图 CDP 已关闭' : 'CDP 点击与输入已关闭，不能调用真实输入协议');
  }
  if (!attached.has(tabId)) {
    await chrome.debugger.attach({ tabId }, '1.3');
    attached.add(tabId);
  }
  return tab;
}

async function cdp(tabId, method, params = {}) {
  await ensureAttached(tabId, method === 'Page.captureScreenshot' ? 'screenshot' : 'input');
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

async function pageAgent(tabId, operation, ref) {
  await ensureAllowed(tabId);
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'ISOLATED',
    files: ['cursor.js', 'page-agent.js']
  });
  await ensureAllowed(tabId);
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'ISOLATED',
    func: (name, elementRef) => {
      const agent = globalThis.__aiBrowserPageAgent4;
      if (!agent) throw new Error('页面代理未就绪');
      if (name === 'snapshot') return agent.snapshot(elementRef);
      if (name === 'scroll') return agent.scroll(elementRef);
      if (name === 'inspect') return agent.inspect(elementRef);
      if (name === 'prepare') return agent.prepare(elementRef);
      if (name === 'focus') return agent.focus(elementRef);
      if (name === 'focusTarget') return agent.focusTarget(elementRef);
      if (name === 'showCursor') return agent.showCursor(elementRef);
      if (name === 'cursorPulse') return agent.cursorPulse(elementRef);
      if (name === 'hideCursor') return agent.hideCursor();
      if (name === 'domClick') return agent.domClick(elementRef);
      if (name === 'domFill') return agent.domFill(elementRef);
      if (name === 'domPress') return agent.domPress(elementRef);
      throw new Error('不支持的页面操作');
    },
    args: [operation, ref ?? null]
  });
  if (!results.length) throw new Error('页面代理没有返回结果');
  const outcome = results[0];
  // Edge 对页面内抛错可能返回 result:null 而不是 reject，必须把真实原因带出来。
  if (outcome.error) {
    const detail = typeof outcome.error === 'object' ? outcome.error.message : String(outcome.error);
    throw new Error(`页面代理执行失败：${detail}`);
  }
  if (outcome.result && typeof outcome.result === 'object' && '__zcodeError' in outcome.result) {
    throw new Error(`页面代理执行失败：${outcome.result.__zcodeError}`);
  }
  if (outcome.result === undefined || outcome.result === null) {
    throw new Error('页面代理未返回结果：目标可能已不可见或被遮挡，请重新 snapshot');
  }
  return outcome.result;
}

const KEYS = Object.freeze({
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32 },
  Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
  End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
  Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 }
});

async function press(tabId, key) {
  if (key === 'Control+A') {
    const control = { key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17 };
    const letter = { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 };
    await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', ...control, modifiers: 2 });
    try {
      await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', ...letter });
      await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...letter });
    } finally {
      await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...control, modifiers: 0 });
    }
    return;
  }
  if (typeof key !== 'string' || !Object.hasOwn(KEYS, key)) throw new Error('不支持的按键');
  const mapping = KEYS[key];
  await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', ...mapping });
  try {
    if (key === 'Enter' || key === 'Space') {
      const text = key === 'Enter' ? '\r' : ' ';
      await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'char', ...mapping, text, unmodifiedText: text });
    }
  } finally {
    await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...mapping });
  }
}

async function listTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs.filter((tab) => isHttpUrl(tab.url)).map((tab) => ({
    id: tab.id,
    title: tab.title || '',
    url: tab.url,
    active: Boolean(tab.active),
    authorized: !revoked.has(tab.id) && (authorized.has(tab.id) || autoAuthorize),
    inputMode: cdpEnabled ? 'cdp' : 'dom',
    screenshotMode: screenshotCdpEnabled ? 'cdp' : 'active-tab'
  }));
}

async function release(tabId) {
  const tracked = authorized.has(tabId) || attached.has(tabId) || (autoAuthorize && !revoked.has(tabId));
  if (!tracked) throw new Error('该标签页尚未授权');
  try { await pageAgent(tabId, 'hideCursor'); } catch {}
  if (attached.has(tabId)) await detach(tabId);
  authorized.delete(tabId);
  attached.delete(tabId);
  revoked.add(tabId);
  return { released: true, tabId };
}

async function detach(tabId) {
  detaching.add(tabId);
  try { await chrome.debugger.detach({ tabId }); attached.delete(tabId); }
  finally { detaching.delete(tabId); }
}

async function detachAll() {
  const failures = [];
  for (const tabId of [...attached]) {
    try {
      await withTab(tabId, async () => { if (attached.has(tabId)) await detach(tabId); });
    } catch { failures.push(tabId); }
  }
  if (failures.length) throw new Error(`标签页 ${failures.join(', ')} 的调试器未能解除，请手动点调试提示条 ×。`);
}

async function visibleScreenshot(tabId) {
  const tab = await ensureAllowed(tabId);
  const current = await chrome.tabs.query({ active: true, windowId: tab.windowId });
  if (!tab.active || current[0]?.id !== tabId) throw new Error('截图 CDP 已关闭：只能截取窗口当前选中的标签页；不会切换后台页。');
  let dataUrl;
  try { dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }); }
  catch (error) {
    const detail = errorMessage(error);
    if (/activeTab|all_urls|permission|Cannot access/i.test(detail)) {
      throw new Error('当前页截图失败：请先点击扩展图标授予当前页权限，再重试；也可在设置中允许截图使用 CDP。');
    }
    throw new Error(`当前页截图失败：${detail}`);
  }
  const after = await chrome.tabs.query({ active: true, windowId: tab.windowId });
  if (after[0]?.id !== tabId) throw new Error('截图期间标签页发生切换，已丢弃截图，请重试。');
  if (!dataUrl.startsWith('data:image/png;base64,')) throw new Error('浏览器未返回 PNG 截图');
  return { data: dataUrl.slice('data:image/png;base64,'.length), mimeType: 'image/png' };
}

async function execute(command) {
  const { method } = command;
  const params = command.params ?? {};
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('params 必须是对象');
  if (method === 'status') {
    return { bridge: `http://127.0.0.1:${bridgePort}`, port: bridgePort, autoAuthorize, authorizedTabIds: [...authorized] };
  }
  if (method === 'list_tabs') return listTabs();
  if (!['snapshot', 'scroll', 'click', 'fill', 'press', 'navigate', 'screenshot', 'release'].includes(method)) {
    throw new Error('不支持的方法');
  }
  const tabId = requireTabId(params.tabId);
  return withTab(tabId, async () => {
    // 释放允许已导航到非 HTTP(S) 的授权页恢复正常状态。
    if (method === 'release') return release(tabId);
    // snapshot（读取）走 ensureAllowed；写入类命令在首个 CDP 调用时经 ensureAttached 附加调试器。
    const currentTab = await ensureAllowed(tabId);
    switch (method) {
      case 'snapshot':
        return pageAgent(tabId, 'snapshot', { load: params.load ?? 'auto' });
      case 'scroll':
        return pageAgent(tabId, 'scroll', { direction: params.direction, ref: params.ref });
      case 'click': {
        const useCdp = cdpEnabled;
        if (useCdp) await ensureAttached(tabId);
        const target = { ref: params.ref, expectedContext: params.expectedContext, action: 'click' };
        const { x, y } = await pageAgent(tabId, 'prepare', target);
        await pageAgent(tabId, 'showCursor', { x, y, hideMs: cursorHideMs, trailMs: cursorTrailMs, animate: currentTab.active });
        const final = await pageAgent(tabId, 'prepare', target);
        if (Math.hypot(final.x - x, final.y - y) > 2) throw new Error('光标移动期间目标位置变化，请重新 snapshot');
        if (useCdp) {
          await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
          const checked = await pageAgent(tabId, 'prepare', target);
          if (Math.hypot(checked.x - x, checked.y - y) > 2) throw new Error('点击前目标位置变化，已阻止操作，请重新 snapshot');
          await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
          await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
        } else await pageAgent(tabId, 'domClick', params.ref);
        // 反馈不能让已成功的导航/点击被误报为失败。
        try { await pageAgent(tabId, 'cursorPulse', { x, y, hideMs: cursorHideMs }); } catch {}
        let after;
        try { after = await pageAgent(tabId, 'inspect', params.ref); } catch { after = { unavailable: true }; }
        return { clicked: true, actionDispatched: true, outcome: 'unverified', target: final.target, after,
          verificationRequired: 'clicked 只表示派发点击。请 snapshot(load=current)，核对同一业务对象的身份及预期状态；不能只数收起按钮。',
          mode: useCdp ? 'cdp' : 'dom', ...(useCdp ? {} : { trusted: false }) };
      }
      case 'fill':
        if (typeof params.text !== 'string') throw new Error('text 必须是字符串');
        if (cdpEnabled) await ensureAttached(tabId);
        const spot = await pageAgent(tabId, 'prepare', params.ref);
        await pageAgent(tabId, 'showCursor', { x: spot.x, y: spot.y, hideMs: cursorHideMs, trailMs: cursorTrailMs, animate: currentTab.active });
        if (!cdpEnabled) {
          const result = await pageAgent(tabId, 'domFill', { ref: params.ref, text: params.text });
          try { await pageAgent(tabId, 'cursorPulse', { ...spot, hideMs: cursorHideMs }); } catch {}
          return result;
        }
        await pageAgent(tabId, 'focus', params.ref);
        await press(tabId, 'Control+A');
        if (params.text === '') await press(tabId, 'Backspace');
        else await cdp(tabId, 'Input.insertText', { text: params.text });
        try { await pageAgent(tabId, 'cursorPulse', { ...spot, hideMs: cursorHideMs }); } catch {}
        return { filled: true, mode: 'cdp' };
      case 'press':
        // 带 ref 时先定位并展示光标，再聚焦目标；不触发点击或表单提交。
        if (params.ref !== undefined) {
          const spot = await pageAgent(tabId, 'prepare', params.ref);
          await pageAgent(tabId, 'showCursor', { x: spot.x, y: spot.y, hideMs: cursorHideMs, trailMs: cursorTrailMs, animate: currentTab.active });
          await pageAgent(tabId, 'focusTarget', params.ref);
          await pageAgent(tabId, 'cursorPulse', { x: spot.x, y: spot.y, hideMs: cursorHideMs });
        }
        if (!cdpEnabled) return pageAgent(tabId, 'domPress', params.key);
        await press(tabId, params.key);
        return { pressed: true, mode: 'cdp' };
      case 'navigate':
        if (typeof params.url !== 'string' || !isHttpUrl(params.url)) throw new Error('url 必须是绝对 HTTP(S) 地址');
        await chrome.tabs.update(tabId, { url: params.url });
        return { navigated: true, url: params.url };
      case 'screenshot': {
        if (!screenshotCdpEnabled) return visibleScreenshot(tabId);
        const wasAttached = attached.has(tabId);
        try {
          const image = await cdp(tabId, 'Page.captureScreenshot', { format: 'png' });
          return { data: image.data, mimeType: 'image/png' };
        } finally {
          if (!wasAttached && attached.has(tabId)) await detach(tabId);
        }
      }
    }
  });
}

async function bridgeFetch(path, body) {
  const controller = new AbortController();
  requestController = controller;
  // 桥正常约 20 秒返回 204；单次请求硬限时低于 30 秒。
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    return await fetch(`http://127.0.0.1:${bridgePort}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'X-Client-Id': chrome.runtime.id, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      signal: controller.signal
    }).then(async (response) => {
      if (!response.ok) {
        let message = `本机桥 HTTP ${response.status}`;
        try { message = (await response.json()).error ?? message; } catch {}
        throw Object.assign(new Error(message), { status: response.status });
      }
      if (body !== undefined || response.status === 204) {
        await response.body?.cancel();
        return null;
      }
      return response.json();
    });
  } finally {
    clearTimeout(timer);
    if (requestController === controller) requestController = null;
  }
}

async function ensurePaired() {
  if (paired) return;
  await bridgeFetch('/pair', { name: chrome.runtime.getManifest().name });
  paired = true;
}

function remember(id, payload) {
  completed.set(id, payload);
  if (completed.size > 200) completed.delete(completed.keys().next().value);
}

const sleep = (ms) => new Promise((resolve) => {
  const done = () => { clearTimeout(timer); if (wakeLoop === done) wakeLoop = null; resolve(); };
  const timer = setTimeout(done, ms);
  wakeLoop = done;
});

async function pollLoop() {
  await ready;
  while (true) {
    const attempt = async () => {
      // 用户显式断开后循环空转待命，不重新配对，直到再次连接。
      if (wantDisconnect) { bridgeState = '已断开'; await sleep(800); return; }
      if (pendingResult) {
        const payload = pendingResult;
        try {
          await bridgeFetch('/result', payload);
        } catch (error) {
          // 404：结果已过期或被桥消费，直接丢弃；其余错误按断线重试。
          if (error?.status !== 404) throw error;
        }
        if (pendingResult === payload) pendingResult = null;
        bridgeFailures = 0;
        bridgeState = '已连接';
        return;
      }
      await ensurePaired();
      bridgeFailures = 0;
      bridgeState = '等待本机桥命令';
      const command = await bridgeFetch('/poll');
      bridgeFailures = 0;
      bridgeState = '已连接';
      if (command === null) return;
      if (!command || typeof command !== 'object' ||
          !((typeof command.id === 'string' && command.id.length > 0) ||
            (typeof command.id === 'number' && Number.isFinite(command.id)))) {
        throw new Error('本机桥命令缺少有效 id');
      }
      let payload = completed.get(command.id);
      if (!payload) {
        try {
          payload = { id: command.id, result: await execute(command) };
        } catch (error) {
          payload = { id: command.id, error: { message: errorMessage(error) } };
        }
        remember(command.id, payload);
      }
      pendingResult = payload;
    };
    try {
      await attempt();
    } catch (error) {
      // 403：白名单被重置或换桥；409：被其他扩展占用。两种都退回重新配对。
      paired = false;
      if (error?.status === 409) {
        bridgeState = '本机桥已被其他扩展占用';
        await sleep(10000);
      } else {
        // 指数退避：连续失败 2s 起步、每次加倍、封顶 1 分钟；任何一次成功即归零。
        bridgeFailures++;
        const wait = Math.min(60000, 2000 * 2 ** Math.min(bridgeFailures - 1, 5));
        bridgeState = /fetch/i.test(String(error?.message ?? '')) ? `本机桥未运行，${Math.round(wait / 1000)} 秒后重试` : '连接中断，自动重试中';
        await sleep(wait);
      }
    }
  }
}

function startPolling() {
  if (loopPromise) return;
  loopPromise = pollLoop().finally(() => {
    loopPromise = null;
    startPolling();
  });
}

async function handlePopup(message) {
  await ready;
  switch (message.type) {
    case 'popup_status':
      return { bridgeState, connected: !wantDisconnect && paired, connecting: !wantDisconnect && !paired, autoAuthorize, cdpEnabled, screenshotCdpEnabled, cursorHideSec: Math.round(cursorHideMs / 1000), cursorTrailSec: Math.round(cursorTrailMs / 1000), bridgePort, authorizedTabIds: [...authorized], revokedTabIds: [...revoked] };
    case 'set_cursor_trail': {
      const sec = message.seconds;
      if (!Number.isInteger(sec) || sec < 0 || sec > 60) throw new Error('轨迹残留时间必须是 0-60 的整数秒');
      cursorTrailMs = sec * 1000;
      await chrome.storage.local.set({ cursorTrailSec: sec });
      return { cursorTrailSec: sec };
    }
    case 'set_cursor_hide': {
      const sec = message.seconds;
      if (!Number.isInteger(sec) || sec < 0 || sec > 60) throw new Error('光标消失延时必须是 0-60 的整数秒');
      cursorHideMs = sec * 1000;
      await chrome.storage.local.set({ cursorHideSec: sec });
      return { cursorHideSec: sec };
    }
    case 'set_cdp_enabled': {
      cdpEnabled = message.enabled === true;
      await chrome.storage.local.set({ cdpEnabled });
      if (!cdpEnabled) await detachAll();
      return { cdpEnabled };
    }
    case 'set_screenshot_cdp_enabled': {
      screenshotCdpEnabled = message.enabled === true;
      await chrome.storage.local.set({ screenshotCdpEnabled });
      if (!screenshotCdpEnabled && !cdpEnabled) await detachAll();
      return { screenshotCdpEnabled };
    }
    case 'set_bridge_port': {
      const port = message.port;
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口必须是 1-65535 的整数');
      bridgePort = port;
      paired = false;
      await chrome.storage.local.set({ bridgePort: port });
      requestController?.abort();
      wakeLoop?.();
      if (!wantDisconnect) await ensurePaired();
      return { bridgePort: port };
    }
    case 'connect':
      wantDisconnect = false;
      await chrome.storage.local.set({ disconnected: false });
      paired = false;
      requestController?.abort();
      wakeLoop?.();
      try {
        await ensurePaired();
      } catch (error) {
        wakeLoop?.();
        if (!error?.status && /fetch/i.test(String(error?.message ?? ''))) {
          throw new Error('本机桥未运行。双击插件目录的“启动桥接服务.cmd”，或在 AI 助手里调用一次浏览器工具自动拉起。');
        }
        throw error;
      }
      wakeLoop?.();   // 若循环还停在退避睡眠，立即唤醒进入轮询，状态/按钮即时刷新
      return { paired: true };
    case 'disconnect':
      wantDisconnect = true;   // 断开后循环空转待命，不自动重连
      await chrome.storage.local.set({ disconnected: true });
      paired = false;
      requestController?.abort();
      wakeLoop?.();
      try { await bridgeFetch('/unpair', {}); } catch {}
      for (const tabId of [...attached]) {
        try { await withTab(tabId, () => detach(tabId)); } catch {}
      }
      bridgeState = '已断开';
      return { paired: false };
    case 'set_auto_authorize': {
      autoAuthorize = message.enabled === true;
      await chrome.storage.local.set({ autoAuthorize });
      return { autoAuthorize };
    }
    case 'authorize_tab':
      return withTab(message.tabId, async () => {
        const tab = await chrome.tabs.get(message.tabId);
        if (!isHttpUrl(tab.url)) throw new Error('只能授权 HTTP(S) 标签页');
        // 只登记授权；调试器延迟到首个写入命令才附加（读取全程无提示条）。
        authorized.add(tab.id);
        revoked.delete(tab.id);
        return { authorized: true, tabId: tab.id };
      });
    case 'release_tab':
      return withTab(message.tabId, () => release(message.tabId));
    default:
      throw new Error('未知弹窗请求');
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('popup.html')) return false;
  handlePopup(message).then(
    (result) => sendResponse({ result }),
    (error) => sendResponse({ error: { message: errorMessage(error) } })
  );
  return true;
});

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId === undefined) return;
  attached.delete(source.tabId);
  if (!detaching.has(source.tabId)) {
    authorized.delete(source.tabId);
    revoked.add(source.tabId);
  }
});
chrome.tabs.onRemoved.addListener((tabId) => { authorized.delete(tabId); attached.delete(tabId); revoked.delete(tabId); });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) startPolling();
});
chrome.runtime.onInstalled.addListener(() => {
  void chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
  startPolling();
});
chrome.runtime.onStartup.addListener(() => {
  void chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
  startPolling();
});
void chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
startPolling();
