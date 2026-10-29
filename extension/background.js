'use strict';

const ALARM = 'zcode-bridge-wakeup';
const authorized = new Set();
const tabQueues = new Map();
const completed = new Map();
let autoAuthorize = false;
// 桥端口存扩展存储，弹窗可改；默认 17653 与 install.mjs 的首选端口一致。
let bridgePort = 17653;
// 配对状态只在内存里；service worker 重启后重新 /pair，同 ID 幂等。
let paired = false;
let loopPromise = null;
let requestController = null;
let pendingResult = null;
let bridgeState = '未连接';
let bridgeFailures = 0;

const ready = chrome.storage.local.get(['autoAuthorize', 'bridgePort']).then((stored) => {
  autoAuthorize = stored.autoAuthorize === true;
  bridgePort = Number.isInteger(stored.bridgePort) && stored.bridgePort > 0 && stored.bridgePort < 65536 ? stored.bridgePort : 17653;
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

async function requireAuthorized(tabId) {
  // 自动授权开启时按需附加；开关只由用户在弹窗更改，AI 无法自行打开。
  if (!authorized.has(tabId)) {
    if (!autoAuthorize) throw new Error('该标签页尚未手动授权');
    const candidate = await chrome.tabs.get(tabId);
    if (!isHttpUrl(candidate.url)) throw new Error('仅允许操作 HTTP(S) 标签页');
    await chrome.debugger.attach({ tabId }, '1.3');
    authorized.add(tabId);
  }
  const tab = await chrome.tabs.get(tabId);
  if (!authorized.has(tabId)) throw new Error('标签页授权已被撤销');
  if (!isHttpUrl(tab.url)) throw new Error('仅允许操作 HTTP(S) 标签页');
  return tab;
}

async function cdp(tabId, method, params = {}) {
  await requireAuthorized(tabId);
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

async function pageAgent(tabId, operation, ref) {
  await requireAuthorized(tabId);
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'ISOLATED',
    files: ['page-agent.js']
  });
  await requireAuthorized(tabId);
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'ISOLATED',
    func: (name, elementRef) => {
      const agent = globalThis.__zcodeTabAgent;
      if (!agent) throw new Error('页面代理未就绪');
      if (name === 'snapshot') return agent.snapshot();
      if (name === 'prepare') return agent.prepare(elementRef);
      if (name === 'focus') return agent.focus(elementRef);
      if (name === 'focusTarget') return agent.focusTarget(elementRef);
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
    authorized: authorized.has(tab.id)
  }));
}

async function release(tabId) {
  if (!authorized.has(tabId)) throw new Error('该标签页尚未手动授权');
  await chrome.debugger.detach({ tabId });
  authorized.delete(tabId);
  return { released: true, tabId };
}

async function execute(command) {
  const { method } = command;
  const params = command.params ?? {};
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('params 必须是对象');
  if (method === 'status') {
    return { bridge: `http://127.0.0.1:${bridgePort}`, port: bridgePort, autoAuthorize, authorizedTabIds: [...authorized] };
  }
  if (method === 'list_tabs') return listTabs();
  if (!['snapshot', 'click', 'fill', 'press', 'navigate', 'screenshot', 'release'].includes(method)) {
    throw new Error('不支持的方法');
  }
  const tabId = requireTabId(params.tabId);
  return withTab(tabId, async () => {
    // 释放允许已导航到非 HTTP(S) 的授权页恢复正常状态。
    if (method === 'release') return release(tabId);
    await requireAuthorized(tabId);
    switch (method) {
      case 'snapshot':
        return pageAgent(tabId, 'snapshot');
      case 'click': {
        const { x, y } = await pageAgent(tabId, 'prepare', params.ref);
        await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
        await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
        await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
        return { clicked: true };
      }
      case 'fill':
        if (typeof params.text !== 'string') throw new Error('text 必须是字符串');
        await pageAgent(tabId, 'focus', params.ref);
        await press(tabId, 'Control+A');
        if (params.text === '') await press(tabId, 'Backspace');
        else await cdp(tabId, 'Input.insertText', { text: params.text });
        return { filled: true };
      case 'press':
        // 带 ref 时仅聚焦目标；不触发点击或表单提交。
        if (params.ref !== undefined) await pageAgent(tabId, 'focusTarget', params.ref);
        await press(tabId, params.key);
        return { pressed: true };
      case 'navigate':
        if (typeof params.url !== 'string' || !isHttpUrl(params.url)) throw new Error('url 必须是绝对 HTTP(S) 地址');
        await chrome.tabs.update(tabId, { url: params.url });
        return { navigated: true, url: params.url };
      case 'screenshot': {
        const image = await cdp(tabId, 'Page.captureScreenshot', { format: 'png' });
        return { data: image.data, mimeType: 'image/png' };
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function pollLoop() {
  await ready;
  while (true) {
    const attempt = async () => {
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
      return { bridgeState, connected: bridgeState === '已连接' || bridgeState === '等待本机桥命令', autoAuthorize, bridgePort, authorizedTabIds: [...authorized] };
    case 'set_bridge_port': {
      const port = message.port;
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口必须是 1-65535 的整数');
      bridgePort = port;
      paired = false;
      await chrome.storage.local.set({ bridgePort: port });
      requestController?.abort();
      await ensurePaired();
      return { bridgePort: port };
    }
    case 'connect':
      paired = false;
      requestController?.abort();
      try {
        await ensurePaired();
      } catch (error) {
        if (!error?.status && /fetch/i.test(String(error?.message ?? ''))) {
          throw new Error('本机桥未运行。双击插件目录的“启动桥接服务.cmd”，或在 AI 助手里调用一次浏览器工具自动拉起。');
        }
        throw error;
      }
      return { paired: true };
    case 'disconnect':
      try { await bridgeFetch('/unpair', {}); } catch {}
      paired = false;
      bridgeState = '未连接';
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
        if (!authorized.has(tab.id)) {
          await chrome.debugger.attach({ tabId: tab.id }, '1.3');
          authorized.add(tab.id);
        }
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
  if (source.tabId !== undefined) authorized.delete(source.tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => authorized.delete(tabId));
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
