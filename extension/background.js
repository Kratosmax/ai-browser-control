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
const requestControllers = new Set();
let connectionEpoch = 0;
let pairing = null;
let lastPollAt = 0;
let commandStartedAt = 0;
const runningTabs = new Set();
let pendingResult = null;
let bridgeState = '未连接';
let bridgeFailures = 0;
// 唤醒轮询循环：连接/断开后立即生效，不等退避睡眠结束。
let wakeLoop = null;

const diagnosticVersion = chrome.runtime.getManifest().version || 'unknown';
const diagnosticSession = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
let diagnosticSeq = 0;
let diagnosticLog = [];
let diagnosticPending = [];
let diagnosticTimer = null;
let diagnosticSending = null;
let diagnosticSaving = false;

function diagnosticRecord(value) {
  const record = {};
  for (const key of ['time', 'seq', 'epoch', 'port', 'tabId', 'durationMs', 'status', 'retryMs']) {
    if (Number.isSafeInteger(value?.[key]) && value[key] >= 0) record[key] = value[key];
  }
  for (const key of ['event', 'version', 'session', 'commandId', 'method', 'phase', 'outcome']) {
    if (typeof value?.[key] === 'string' && /^[a-zA-Z0-9_.-]{1,64}$/.test(value[key])) record[key] = value[key];
  }
  return record;
}

function trimDiagnostics() {
  while (diagnosticLog.length > 128 || JSON.stringify(diagnosticLog).length > 64 * 1024 - 1024) diagnosticLog.shift();
  const retained = new Set(diagnosticLog.map(e => `${e.session}:${e.seq}`));
  diagnosticPending = diagnosticPending.filter(e => retained.has(`${e.session}:${e.seq}`));
}

function diagnostic(event, fields = {}) {
  const record = diagnosticRecord({ ...fields, event, version: diagnosticVersion, session: diagnosticSession,
    time: Date.now(), seq: ++diagnosticSeq, epoch: fields.epoch ?? connectionEpoch, port: fields.port ?? bridgePort });
  diagnosticLog.push(record);
  diagnosticPending.push(record);
  trimDiagnostics();
  scheduleDiagnosticSave();
}

function scheduleDiagnosticSave() {
  // 合并短时间内的阶段事件，存储故障不阻塞命令；所有字段均为有界 ASCII 元数据。
  if (diagnosticTimer === null && !diagnosticSaving) diagnosticTimer = setTimeout(() => {
    diagnosticTimer = null;
    const snapshot = diagnosticLog.slice();
    diagnosticSaving = true;
    // 底层存储未结束前不追加第二个写请求；不等待它完成浏览器命令。
    void Promise.resolve().then(() => chrome.storage.local.set({ diagnosticLog: snapshot })).catch(() => {}).finally(() => {
      diagnosticSaving = false;
      if (snapshot.at(-1) !== diagnosticLog.at(-1)) scheduleDiagnosticSave();
    });
  }, 200);
}

function flushDiagnostics() {
  if (diagnosticSending || !paired || wantDisconnect) return;
  const events = diagnosticPending.filter(e => e.port === bridgePort).slice(0, 32);
  if (!events.length) return;
  const epoch = connectionEpoch;
  let uploaded = false;
  diagnosticSending = bridgeFetch('/diagnostics', { events }, 2000).then(() => {
    if (epoch !== connectionEpoch) return;
    const sent = new Set(events.map(e => `${e.session}:${e.seq}`));
    diagnosticPending = diagnosticPending.filter(e => !sent.has(`${e.session}:${e.seq}`));
    uploaded = true;
  }).catch(() => {}).finally(() => {
    diagnosticSending = null;
    if (uploaded) flushDiagnostics();
  });
}

async function browserStep(check, phase, work) {
  check();
  if (!check.diagnostic) return work();
  check.phase = phase;
  const started = Date.now();
  diagnostic('step_start', { ...check.diagnostic, phase });
  let outcome = 'ok';
  try { return await work(); }
  catch (error) { outcome = 'error'; throw error; }
  finally { diagnostic('step_end', { ...check.diagnostic, phase, outcome, durationMs: Date.now() - started }); }
}

function loopSleep(ms) {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); if (wakeLoop === done) wakeLoop = null; resolve(); };
    const timer = setTimeout(done, ms);
    wakeLoop = done;
  });
}

const ready = chrome.storage.local.get(['autoAuthorize', 'bridgePort', 'cdpEnabled', 'screenshotCdpEnabled', 'cursorHideSec', 'cursorTrailSec', 'disconnected', 'diagnosticLog']).then((stored) => {
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
  diagnosticLog = Array.isArray(stored.diagnosticLog) ? stored.diagnosticLog.slice(-128).map(diagnosticRecord) : [];
  diagnosticPending = diagnosticLog.slice();
  diagnostic('worker_start');
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
async function ensureAllowed(tabId, check = () => {}) {
  const tab = await browserStep(check, 'tabs.get', () => chrome.tabs.get(tabId));
  if (!isHttpUrl(tab.url)) throw new Error('仅允许操作 HTTP(S) 标签页');
  if (revoked.has(tabId) || (!authorized.has(tabId) && !autoAuthorize)) throw new Error('该标签页尚未手动授权或已释放，请在弹窗中授权此页');
  return tab;
}

// 写入类命令（点击/输入/截屏）才附加调试器；首次写入时才出现提示条。
async function ensureAttached(tabId, purpose = 'input', check = () => {}) {
  const tab = await ensureAllowed(tabId, check);
  if (purpose === 'screenshot' ? !screenshotCdpEnabled : !cdpEnabled) {
    throw new Error(purpose === 'screenshot' ? '截图 CDP 已关闭' : 'CDP 真实交互已关闭，不能调用真实输入协议');
  }
  if (!attached.has(tabId)) {
    await browserStep(check, 'debugger.attach', () => chrome.debugger.attach({ tabId }, '1.3'));
    attached.add(tabId);
  }
  return tab;
}

async function cdp(tabId, method, params = {}, check = () => {}) {
  check();
  await ensureAttached(tabId, method === 'Page.captureScreenshot' ? 'screenshot' : 'input', check);
  check();
  return browserStep(check, method, () => chrome.debugger.sendCommand({ tabId }, method, params));
}

async function pageAgent(tabId, operation, ref, check = () => {}) {
  check();
  await ensureAllowed(tabId, check);
  check();
  await browserStep(check, 'scripting.inject', () => chrome.scripting.executeScript({
    target: { tabId },
    world: 'ISOLATED',
    files: ['cursor.js', 'page-agent.js']
  }));
  check();
  await ensureAllowed(tabId, check);
  check();
  const results = await browserStep(check, operation, () => chrome.scripting.executeScript({
    target: { tabId },
    world: 'ISOLATED',
    func: (name, elementRef) => {
      const agent = globalThis.__aiBrowserPageAgent7;
      if (!agent) throw new Error('页面代理未就绪');
      if (name === 'snapshot') return agent.snapshot(elementRef);
      if (name === 'scroll') return agent.scroll(elementRef);
      if (name === 'inspect') return agent.inspect(elementRef);
      if (name === 'prepare') return agent.prepare(elementRef);
      if (name === 'focus') return agent.focus(elementRef);
      if (name === 'focusTarget') return agent.focusTarget(elementRef);
      if (name === 'showCursor') return agent.showCursor(elementRef);
      if (name === 'holdHover') return agent.holdHover(elementRef);
      if (name === 'cursorPulse') return agent.cursorPulse(elementRef);
      if (name === 'hideCursor') return agent.hideCursor();
      if (name === 'domClick') return agent.domClick(elementRef);
      if (name === 'domHover') return agent.domHover(elementRef);
      if (name === 'pointerClick') return agent.pointerClick(elementRef);
      if (name === 'domDrag') return agent.domDrag(elementRef);
      if (name === 'select') return agent.select(elementRef);
      if (name === 'waitFor') return agent.waitFor(elementRef);
      if (name === 'domFill') return agent.domFill(elementRef);
      if (name === 'domPress') return agent.domPress(elementRef);
      throw new Error('不支持的页面操作');
    },
    args: [operation, ref ?? null]
  }));
  if (!results.length) throw new Error('页面代理没有返回结果');
  const outcome = results[0];
  // Edge 对页面内抛错可能返回 result:null 而不是 reject，必须把真实原因带出来。
  if (outcome.error) {
    const detail = typeof outcome.error === 'object' ? outcome.error.message : String(outcome.error);
    throw new Error(`页面代理执行失败：${detail}`);
  }
  if (outcome.result && typeof outcome.result === 'object' && '__zcodeError' in outcome.result) {
    throw Object.assign(new Error(`页面代理执行失败：${outcome.result.__zcodeError}`), { code: outcome.result.__zcodeCode || 'PAGE_ACTION_FAILED' });
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
  Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
  F10: { key: 'F10', code: 'F10', windowsVirtualKeyCode: 121 }
});

async function press(tabId, key, check = () => {}) {
  const send = (method, params) => cdp(tabId, method, params, check);
  if (key === 'Control+A') {
    const control = { key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17 };
    const letter = { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 };
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...control, modifiers: 2 });
    try {
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...letter });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...letter });
    } finally {
      await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...control, modifiers: 0 });
    }
    return;
  }
  if (['Shift+Tab', 'Alt+ArrowDown', 'Alt+ArrowUp', 'Shift+F10', 'Control+Enter'].includes(key)) {
    const [modifier, base] = key.split('+');
    const mapping = { Alt: { key: 'Alt', code: 'AltLeft', windowsVirtualKeyCode: 18, modifiers: 1 },
      Shift: { key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, modifiers: 8 },
      Control: { key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, modifiers: 2 } }[modifier];
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...mapping });
    try {
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...KEYS[base], modifiers: mapping.modifiers });
    } finally {
      try { await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...KEYS[base], modifiers: mapping.modifiers }); }
      finally { await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...mapping, modifiers: 0 }); }
    }
    return;
  }
  if (typeof key !== 'string' || !Object.hasOwn(KEYS, key)) throw new Error('不支持的按键');
  const mapping = KEYS[key];
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...mapping });
  try {
    if (key === 'Enter' || key === 'Space') {
      const text = key === 'Enter' ? '\r' : ' ';
      await send('Input.dispatchKeyEvent', { type: 'char', ...mapping, text, unmodifiedText: text });
    }
  } finally {
    await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...mapping });
  }
}

async function listTabs(check = () => {}) {
  const tabs = await browserStep(check, 'tabs.query', () => chrome.tabs.query({}));
  return tabs.filter((tab) => isHttpUrl(tab.url)).map((tab) => ({
    id: tab.id,
    title: tab.title || '',
    url: tab.url,
    active: Boolean(tab.active),
    authorized: !revoked.has(tab.id) && (authorized.has(tab.id) || autoAuthorize),
    inputMode: cdpEnabled ? 'cdp' : 'dom',
    screenshotMode: screenshotCdpEnabled ? 'cdp' : 'active-tab',
    capabilities: { hover: cdpEnabled ? 'cdp' : 'dom-events', cssHover: cdpEnabled,
      pointer: cdpEnabled ? 'cdp' : 'synthetic', drag: cdpEnabled ? 'cdp-pointer' : 'synthetic-pointer-and-html5',
      nativeSelect: 'dom', inspect: true, wait: true, focus: true,
      nativeBrowserMenus: false, systemDialogs: false, canvasTargets: false }
  }));
}

async function release(tabId, check = () => {}) {
  const tracked = authorized.has(tabId) || attached.has(tabId) || (autoAuthorize && !revoked.has(tabId));
  if (!tracked) throw new Error('该标签页尚未授权');
  try { await pageAgent(tabId, 'hideCursor', undefined, check); } catch {}
  if (attached.has(tabId)) await detach(tabId, check);
  authorized.delete(tabId);
  attached.delete(tabId);
  revoked.add(tabId);
  return { released: true, tabId };
}

async function detach(tabId, check = () => {}) {
  detaching.add(tabId);
  try { await browserStep(check, 'debugger.detach', () => chrome.debugger.detach({ tabId })); attached.delete(tabId); }
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

async function visibleScreenshot(tabId, check = () => {}) {
  const tab = await ensureAllowed(tabId, check);
  const current = await browserStep(check, 'tabs.query', () => chrome.tabs.query({ active: true, windowId: tab.windowId }));
  if (!tab.active || current[0]?.id !== tabId) throw new Error('截图 CDP 已关闭：只能截取窗口当前选中的标签页；不会切换后台页。');
  let dataUrl;
  try { dataUrl = await browserStep(check, 'tabs.captureVisibleTab', () => chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' })); }
  catch (error) {
    const detail = errorMessage(error);
    if (/activeTab|all_urls|permission|Cannot access/i.test(detail)) {
      throw new Error('当前页截图失败：请先点击扩展图标授予当前页权限，再重试；也可在设置中允许截图使用 CDP。');
    }
    throw new Error(`当前页截图失败：${detail}`);
  }
  const after = await browserStep(check, 'tabs.query', () => chrome.tabs.query({ active: true, windowId: tab.windowId }));
  if (after[0]?.id !== tabId) throw new Error('截图期间标签页发生切换，已丢弃截图，请重试。');
  if (!dataUrl.startsWith('data:image/png;base64,')) throw new Error('浏览器未返回 PNG 截图');
  return { data: dataUrl.slice('data:image/png;base64,'.length), mimeType: 'image/png' };
}

async function execute(command, check = () => {}) {
  check();
  const { method } = command;
  const params = command.params ?? {};
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('params 必须是对象');
  if (method === 'status') {
    return { bridge: `http://127.0.0.1:${bridgePort}`, port: bridgePort, autoAuthorize, authorizedTabIds: [...authorized] };
  }
  if (method === 'list_tabs') return listTabs(check);
  if (method === 'open') {
    if (typeof params.url !== 'string' || !isHttpUrl(params.url)) throw Object.assign(new Error('url必须是HTTP(S)地址'), { code: 'INVALID_ARGUMENTS' });
    let windowId;
    if (params.tabId !== undefined) windowId = (await ensureAllowed(requireTabId(params.tabId), check)).windowId;
    else {
      try { windowId = (await browserStep(check, 'windows.getLastFocused', () => chrome.windows.getLastFocused({ windowTypes: ['normal'] }))).id; }
      catch (error) { check(); throw Object.assign(new Error('没有可用的普通浏览器窗口，请先手动打开窗口；插件不会激活或新建窗口'), { code: 'NO_BROWSER_WINDOW' }); }
    }
    if (!Number.isInteger(windowId) || windowId < 0) throw Object.assign(new Error('没有可用的普通浏览器窗口'), { code: 'NO_BROWSER_WINDOW' });
    const beforeWindow = await browserStep(check, 'windows.get', () => chrome.windows.get(windowId));
    check();
    const tab = await browserStep(check, 'tabs.create', () => chrome.tabs.create({ windowId, url: params.url, active: false,
      ...(params.tabId === undefined ? {} : { openerTabId: params.tabId }) }));
    const afterWindow = await browserStep(check, 'windows.get', () => chrome.windows.get(windowId));
    return { opened: true, tabId: tab.id, windowId: tab.windowId, active: tab.active === true,
      windowFocusedBefore: beforeWindow.focused === true, windowFocusedAfter: afterWindow.focused === true,
      requestedActive: false, authorized: !revoked.has(tab.id) && (autoAuthorize || authorized.has(tab.id)),
      verificationRequired: '请按返回的新tabId读取；未授权时需用户授权，不能自动激活页面。' };
  }
  if (!['snapshot', 'scroll', 'click', 'hover', 'focus', 'drag', 'select', 'set_checked', 'inspect', 'wait', 'fill', 'press', 'navigate', 'screenshot', 'release'].includes(method)) {
    throw new Error('不支持的方法');
  }
  const tabId = requireTabId(params.tabId);
  return withTab(tabId, async () => {
    check();
    const agent = async (operation, value) => {
      check();
      const result = await pageAgent(tabId, operation, value, check);
      check();
      return result;
    };
    const send = (method, params) => cdp(tabId, method, params, check);
    const cleanupUp = async (point, button = 'left', clickCount = 1) => {
      if (attached.has(tabId)) await bounded(chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent',
        { type: 'mouseReleased', x: point.x, y: point.y, button, buttons: 0, clickCount }), 1000, '释放鼠标等待超时');
    };
    const dispatched = extra => ({ actionDispatched: true, outcome: 'unverified',
      mode: cdpEnabled ? 'cdp' : 'dom', trusted: cdpEnabled,
      verificationRequired: '请用wait或snapshot(load=current)确认同一目标的预期菜单/业务状态。', ...extra });
    const prepareTarget = async (ref, expectedContext, position) => {
      const target = { ref, expectedContext, position, action: method };
      const point = await agent('prepare', target);
      await agent('showCursor', { ...point, hideMs: cursorHideMs, trailMs: cursorTrailMs, animate: currentTab.active });
      const after = await agent('prepare', target);
      if (Math.hypot(after.x - point.x, after.y - point.y) > 2) throw Object.assign(new Error('目标在动作前移动，请重新snapshot'), { code: 'TARGET_CHANGED' });
      return after;
    };
    // 释放允许已导航到非 HTTP(S) 的授权页恢复正常状态。
    if (method === 'release') return release(tabId, check);
    // snapshot（读取）走 ensureAllowed；写入类命令在首个 CDP 调用时经 ensureAttached 附加调试器。
    const currentTab = await ensureAllowed(tabId, check);
    switch (method) {
      case 'snapshot':
        return agent('snapshot', { load: params.load ?? 'auto' });
      case 'scroll':
        return agent('scroll', { direction: params.direction, ref: params.ref });
      case 'inspect':
        return agent('inspect', params.ref);
      case 'wait':
        return agent('waitFor', params);
      case 'focus': {
        await prepareTarget(params.ref, params.expectedContext);
        await agent('focusTarget', params.ref);
        const focused = (await agent('inspect', params.ref)).focused;
        return { focused, outcome: focused ? 'verified-focus' : 'unverified' };
      }
      case 'select': {
        await prepareTarget(params.ref, params.expectedContext);
        return agent('select', { ref: params.ref, values: params.values });
      }
      case 'set_checked': {
        const before = await agent('inspect', params.ref);
        if (before.removed || before.identityChanged || (params.expectedContext && !before.context?.includes(params.expectedContext))) throw Object.assign(new Error('勾选目标身份或上下文已变化'), { code: 'TARGET_CHANGED' });
        const actual = value => typeof value === 'boolean' ? value : value === 'true' ? true : value === 'false' ? false : null;
        if (actual(before.checked) === null && before.checked !== 'mixed') throw Object.assign(new Error('目标不是可设置勾选状态的控件'), { code: 'UNSUPPORTED_TARGET' });
        if (actual(before.checked) === params.checked) return { checked: params.checked, changed: false, verified: true };
        if (!params.checked && (before.role === 'radio' || before.inputType === 'radio')) throw Object.assign(new Error('radio不能单独取消，请选择其他radio'), { code: 'UNSUPPORTED_ACTION' });
        const point = await prepareTarget(params.ref, params.expectedContext);
        if (cdpEnabled) {
          await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
          try { await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 }); }
          finally { await cleanupUp(point); }
        } else await agent('domClick', params.ref);
        const after = await agent('inspect', params.ref);
        return dispatched({ checked: actual(after.checked), changed: true, verified: !after.identityChanged && actual(after.checked) === params.checked });
      }
      case 'hover': {
        const point = await prepareTarget(params.ref, params.expectedContext, params.position);
        if (cdpEnabled) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
        else await agent('domHover', { ref: params.ref, point });
        await new Promise(done => setTimeout(done, params.durationMs ?? 300));
        check();
        const held = await agent('holdHover', { ref: params.ref });
        return dispatched({ cssHover: cdpEnabled, cursorHeld: held.held === true, note: cdpEnabled ? '浏览器指针已移动，系统鼠标不动。' : '合成悬停事件不能设置CSS :hover，也不保证网站接受非可信事件。' });
      }
      case 'drag': {
        let from = await prepareTarget(params.fromRef, params.expectedFromContext);
        if (cdpEnabled) {
          // 离开此前悬停菜单可能改变布局；按下前先完成移入并重新定位源。
          await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y });
          from = await agent('prepare', { ref: params.fromRef, expectedContext: params.expectedFromContext, action: 'drag' });
          await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y });
        }
        const to = await prepareTarget(params.toRef, params.expectedToContext);
        const finalFrom = await agent('prepare', { ref: params.fromRef, expectedContext: params.expectedFromContext, action: 'drag' });
        if (Math.hypot(finalFrom.x - from.x, finalFrom.y - from.y) > 2) throw Object.assign(new Error('两个拖拽目标需同时位于可操作视口，请先滚动定位'), { code: 'TARGET_CHANGED' });
        if ((await agent('inspect', params.fromRef)).inViewport === false || (await agent('inspect', params.toRef)).inViewport === false) throw Object.assign(new Error('两个拖拽目标需同时位于可操作视口'), { code: 'TARGET_OUTSIDE_VIEWPORT' });
        const durationMs = params.durationMs ?? 400;
        if (!cdpEnabled) return dispatched(await agent('domDrag', { fromRef: params.fromRef, toRef: params.toRef, from, to, durationMs }));
        let last = from;
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y });
        try {
          await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 });
          const dragStarted = Date.now();
          let progress = 0;
          while (progress < 1) {
            await new Promise(done => setTimeout(done, Math.min(40, durationMs / 12)));
            progress = Math.min(1, Math.max(progress + 1 / 12, (Date.now() - dragStarted) / durationMs));
            last = { x: from.x + (to.x - from.x) * progress, y: from.y + (to.y - from.y) * progress };
            await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...last, button: 'left', buttons: 1 });
          }
          const finalTo = await agent('prepare', { ref: params.toRef, expectedContext: params.expectedToContext, action: 'drag' });
          if (Math.hypot(finalTo.x - to.x, finalTo.y - to.y) > 2) throw Object.assign(new Error('拖拽目标位置变化，未确认放置结果'), { code: 'TARGET_CHANGED' });
        } finally { await cleanupUp(last); }
        return dispatched();
      }
      case 'click': {
        const useCdp = cdpEnabled;
        if (useCdp) await ensureAttached(tabId, 'input', check);
        const target = { ref: params.ref, expectedContext: params.expectedContext, position: params.position, action: 'click' };
        const { x, y } = await agent('prepare', target);
        await agent('showCursor', { x, y, hideMs: cursorHideMs, trailMs: cursorTrailMs, animate: currentTab.active });
        const final = await agent('prepare', target);
        if (Math.hypot(final.x - x, final.y - y) > 2) throw new Error('光标移动期间目标位置变化，请重新 snapshot');
        if (useCdp) {
          await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
          const checked = await agent('prepare', target);
          if (Math.hypot(checked.x - x, checked.y - y) > 2) throw new Error('点击前目标位置变化，已阻止操作，请重新 snapshot');
          for (let count = 1; count <= (params.clickCount ?? 1); count++) {
            if (count > 1) {
              const again = await agent('prepare', target);
              if (Math.hypot(again.x - x, again.y - y) > 2) throw Object.assign(new Error('双击期间目标位置变化'), { code: 'TARGET_CHANGED' });
            }
            try {
              await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: params.button ?? 'left', clickCount: count });
              if (params.holdMs) { await new Promise(done => setTimeout(done, params.holdMs)); check(); }
            } finally {
              await cleanupUp({ x, y }, params.button, count);
            }
          }
        } else if (params.button === 'right' || params.clickCount === 2 || params.holdMs || params.position) {
          await agent('pointerClick', { ref: params.ref, point: { x, y }, button: params.button, clickCount: params.clickCount, holdMs: params.holdMs });
        } else await agent('domClick', params.ref);
        // 反馈不能让已成功的导航/点击被误报为失败。
        try { await agent('cursorPulse', { x, y, hideMs: cursorHideMs }); } catch {}
        let after;
        try { after = await agent('inspect', params.ref); } catch { after = { unavailable: true }; }
        return { clicked: !params.holdMs, actionDispatched: true, outcome: 'unverified', target: final.target, after,
          verificationRequired: 'clicked 只表示派发点击。请 snapshot(load=current)，核对同一业务对象的身份及预期状态；不能只数收起按钮。',
          mode: useCdp ? 'cdp' : 'dom', ...(useCdp ? {} : { trusted: false }) };
      }
      case 'fill':
        if (typeof params.text !== 'string') throw new Error('text 必须是字符串');
        if (cdpEnabled) await ensureAttached(tabId, 'input', check);
        const spot = await agent('prepare', params.ref);
        await agent('showCursor', { x: spot.x, y: spot.y, hideMs: cursorHideMs, trailMs: cursorTrailMs, animate: currentTab.active });
        if (!cdpEnabled) {
          const result = await agent('domFill', { ref: params.ref, text: params.text });
          try { await agent('cursorPulse', { ...spot, hideMs: cursorHideMs }); } catch {}
          return result;
        }
        await agent('focus', params.ref);
        await press(tabId, 'Control+A', check);
        if (params.text === '') await press(tabId, 'Backspace', check);
        else await send('Input.insertText', { text: params.text });
        try { await agent('cursorPulse', { ...spot, hideMs: cursorHideMs }); } catch {}
        return { filled: true, mode: 'cdp' };
      case 'press':
        // 带 ref 时先定位并展示光标，再聚焦目标；不触发点击或表单提交。
        if (params.ref !== undefined) {
          const spot = await agent('prepare', { ref: params.ref, expectedContext: params.expectedContext, action: 'press' });
          await agent('showCursor', { x: spot.x, y: spot.y, hideMs: cursorHideMs, trailMs: cursorTrailMs, animate: currentTab.active });
          await agent('focusTarget', params.ref);
          await agent('cursorPulse', { x: spot.x, y: spot.y, hideMs: cursorHideMs });
        }
        if (!cdpEnabled) return agent('domPress', params.key);
        await press(tabId, params.key, check);
        return { pressed: true, mode: 'cdp' };
      case 'navigate':
        if (typeof params.url !== 'string' || !isHttpUrl(params.url)) throw new Error('url 必须是绝对 HTTP(S) 地址');
        check();
        await browserStep(check, 'tabs.update', () => chrome.tabs.update(tabId, { url: params.url }));
        return { navigated: true, url: params.url };
      case 'screenshot': {
        if (!screenshotCdpEnabled) return visibleScreenshot(tabId, check);
        const wasAttached = attached.has(tabId);
        try {
          const image = await send('Page.captureScreenshot', { format: 'png' });
          return { data: image.data, mimeType: 'image/png' };
        } finally {
          // 清理临时附加不受动作失效 guard 阻止。
          if (!wasAttached && attached.has(tabId)) await browserStep(Object.assign(() => {}, { diagnostic: check.diagnostic }), 'debugger.detach', () => detach(tabId));
        }
      }
    }
  });
}

function connectionChanged() {
  return Object.assign(new Error('连接设置已变化'), { connectionChanged: true });
}

function resetConnection() {
  diagnostic('connection_reset', { outcome: 'invalidated' });
  connectionEpoch++;
  paired = false;
  pairing = null;
  lastPollAt = 0;
  for (const controller of requestControllers) controller.abort();
  wakeLoop?.();
}

function bounded(work, ms, message) {
  let timer;
  return Promise.race([work, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(message), { code: 'timeout' })), ms);
  })]).finally(() => clearTimeout(timer));
}

async function bridgeFetch(path, body, timeout = 25000) {
  const controller = new AbortController();
  requestController = controller;
  requestControllers.add(controller);
  // 桥正常约 20 秒返回 204；单次请求硬限时低于 30 秒。
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await bounded(fetch(`http://127.0.0.1:${bridgePort}${path}`, {
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
    }), timeout, '本机桥请求超时');
  } finally {
    clearTimeout(timer);
    requestControllers.delete(controller);
    if (requestController === controller) requestController = null;
  }
}

async function ensurePaired() {
  if (paired) return;
  if (pairing) return pairing;
  const epoch = connectionEpoch;
  const work = (async () => {
    diagnostic('pair_start');
    await bridgeFetch('/pair', { name: chrome.runtime.getManifest().name });
    if (epoch !== connectionEpoch || wantDisconnect) throw connectionChanged();
    paired = true;
    diagnostic('pair_ok');
  })();
  pairing = work;
  try { await work; } finally { if (pairing === work) pairing = null; }
}

async function executeBounded(command) {
  const tabId = command.params?.tabId;
  const meta = { commandId: String(command.id), method: command.method, tabId, epoch: connectionEpoch, port: bridgePort };
  if (runningTabs.has(tabId)) {
    diagnostic('command_end', { ...meta, outcome: 'busy' });
    throw new Error('此标签页上一条操作仍未结束，结果不确定；请勿重复提交。可操作其他标签页。');
  }
  runningTabs.add(tabId);
  commandStartedAt = Date.now();
  let expired = false;
  const epoch = connectionEpoch;
  const started = Date.now();
  const check = () => { if (expired || epoch !== connectionEpoch || wantDisconnect) throw Object.assign(new Error('原操作已过期或连接已变化，未继续派发动作；已派发部分结果不确定。'), { code: 'invalidated' }); };
  check.diagnostic = meta;
  check.phase = 'queue';
  diagnostic('command_start', meta);
  const work = Promise.resolve().then(() => execute(command, check)).finally(() => runningTabs.delete(tabId));
  let outcome = 'ok';
  try {
    return await bounded(work, 11000, '浏览器操作等待超时，结果不确定；轮询已恢复，原操作不会自动重放，请先回读。');
  } catch (error) {
    outcome = ['timeout', 'invalidated'].includes(error.code) ? error.code : 'error';
    throw error;
  } finally {
    expired = true; commandStartedAt = 0;
    diagnostic('command_end', { ...meta, phase: check.phase, outcome, durationMs: Date.now() - started });
    flushDiagnostics();
  }
}

async function connectionStatus() {
  let verified = false;
  const epoch = connectionEpoch;
  if (!wantDisconnect && paired) {
    try {
      const status = await bridgeFetch('/status', undefined, 2000);
      if (epoch !== connectionEpoch) throw connectionChanged();
      verified = status.connected === true && status.standby !== true &&
        status.client === `chrome-extension://${chrome.runtime.id}` &&
        lastPollAt > 0 && Date.now() - lastPollAt < 35000;
      if (!verified) {
        diagnostic('status_failed');
        bridgeState = '命令通道未响应，正在恢复连接';
        resetConnection();
      }
    } catch (error) {
      if (epoch === connectionEpoch) {
        diagnostic('status_failed', { status: error.status, outcome: error.code === 'timeout' ? 'timeout' : 'error' });
        bridgeState = '本机桥通信异常，自动重连中';
        resetConnection();
      }
    }
  }
  return { bridgeState, connected: !wantDisconnect && verified, connecting: !wantDisconnect && !verified,
    autoAuthorize, cdpEnabled, screenshotCdpEnabled, cursorHideSec: Math.round(cursorHideMs / 1000),
    cursorTrailSec: Math.round(cursorTrailMs / 1000), bridgePort, authorizedTabIds: [...authorized], revokedTabIds: [...revoked],
    commandRunning: commandStartedAt > 0, lastPollAt: lastPollAt || null };
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
    const epoch = connectionEpoch;
    const current = () => { if (epoch !== connectionEpoch || wantDisconnect) throw connectionChanged(); };
    const attempt = async () => {
      // 用户显式断开后循环空转待命，不重新配对，直到再次连接。
      if (wantDisconnect) { bridgeState = '已断开'; await sleep(800); return; }
      await ensurePaired();
      current();
      flushDiagnostics();
      if (pendingResult) {
        const payload = pendingResult;
        try {
          await bridgeFetch('/result', payload);
        } catch (error) {
          // 404：结果已过期或被桥消费，直接丢弃；其余错误按断线重试。
          if (error?.status !== 404) throw error;
        }
        current();
        if (pendingResult === payload) pendingResult = null;
        bridgeFailures = 0;
        bridgeState = '已连接';
        return;
      }
      bridgeFailures = 0;
      bridgeState = '等待本机桥命令';
      lastPollAt = Date.now();
      const command = await bridgeFetch('/poll');
      current();
      lastPollAt = Date.now();
      bridgeFailures = 0;
      bridgeState = '已连接';
      diagnostic('poll_ok');
      if (command === null) return;
      if (!command || typeof command !== 'object' ||
          !((typeof command.id === 'string' && command.id.length > 0) ||
            (typeof command.id === 'number' && Number.isFinite(command.id)))) {
        throw new Error('本机桥命令缺少有效 id');
      }
      let payload = completed.get(command.id);
      if (!payload) {
        try {
          payload = { id: command.id, result: await executeBounded(command) };
        } catch (error) {
          payload = { id: command.id, error: { message: errorMessage(error), code: error.code === 'timeout' ? 'COMMAND_TIMEOUT' : error.code === 'invalidated' ? 'CONNECTION_INVALIDATED' : error.code || 'BROWSER_ACTION_FAILED', outcome: 'unverified' } };
        }
        remember(command.id, payload);
      }
      current();
      pendingResult = payload;
    };
    try {
      await attempt();
    } catch (error) {
      // 403：白名单被重置或换桥；409：被其他扩展占用。两种都退回重新配对。
      if (epoch !== connectionEpoch || error?.connectionChanged || wantDisconnect) continue;
      paired = false;
      lastPollAt = 0;
      if (error?.status === 409) {
        diagnostic('transport_error', { status: 409, retryMs: 10000, outcome: 'error' });
        bridgeState = '本机桥已被其他扩展占用';
        await sleep(10000);
      } else {
        // 指数退避：连续失败 2s 起步、每次加倍、封顶 1 分钟；任何一次成功即归零。
        bridgeFailures++;
        const wait = Math.min(60000, 2000 * 2 ** Math.min(bridgeFailures - 1, 5));
        diagnostic('transport_error', { status: error.status, retryMs: wait, outcome: error.code === 'timeout' ? 'timeout' : 'error' });
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
      return connectionStatus();
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
      pendingResult = null;
      resetConnection();
      await chrome.storage.local.set({ bridgePort: port });
      if (!wantDisconnect) await ensurePaired();
      return { bridgePort: port };
    }
    case 'connect':
      diagnostic('manual_connect');
      wantDisconnect = false;
      await chrome.storage.local.set({ disconnected: false });
      resetConnection();
      bridgeState = '正在恢复命令通道';
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
      diagnostic('manual_disconnect');
      wantDisconnect = true;   // 断开后循环空转待命，不自动重连
      await chrome.storage.local.set({ disconnected: true });
      paired = false;
      resetConnection();
      try { await bridgeFetch('/unpair', {}); } catch {}
      for (const tabId of [...attached]) {
        try { await bounded(withTab(tabId, () => detach(tabId)), 2000, '解除调试等待超时'); } catch {}
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
