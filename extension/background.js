'use strict';
importScripts('tasks.js');

const ALARM = 'zcode-bridge-wakeup';
const authorized = new Set();
// 输入、截图与生命周期唤醒独立授权；普通DOM读取不附加，冻结页仅按独立开关临时唤醒。
const attached = new Set();
const revoked = new Set();
const revocationTouched = new Set();
let revocationSaving = Promise.resolve();
const cdpGeneration = { input: 0, screenshot: 0, lifecycle: 0 };
const lifecycleAttachments = new Set();
const detaching = new Set();
const tabQueues = new Map();
const completed = new Map();
let autoAuthorize = false;
// 输入默认使用 DOM；截图的 CDP 用途独立授权，不代表浏览器调试权限被降级。
let cdpEnabled = false;
let screenshotCdpEnabled = true;
// 独立用途，默认关闭；截图或点击授权不能开启生命周期唤醒。
let lifecycleWakeEnabled = false;
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
const runningOperations = new Map();
const taskTabs = new AiBrowserTasks(chrome, tabId => runningTabs.has(tabId), async tab => {
  if (revoked.has(tab.id)) return 'released';
  if (!authorized.has(tab.id) && !autoAuthorize) return 'not-authorized';
  try {
    const results = await bounded(chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'ISOLATED', func: () => {
      return [...document.querySelectorAll('input:not([type=hidden]),textarea,select,[contenteditable=true]')].some(el => {
        if (el.isContentEditable) return el.textContent.trim().length > 0;
        if (el instanceof HTMLSelectElement) {
          const options = [...el.options];
          if (el.multiple) return options.some(option => option.selected !== option.defaultSelected);
          const explicit = options.findLastIndex(option => option.defaultSelected);
          const initial = explicit >= 0 ? explicit : options.findIndex(option => !option.disabled && !option.closest('optgroup[disabled]'));
          return el.selectedIndex !== initial;
        }
        return ['checkbox', 'radio'].includes(el.type) ? el.checked !== el.defaultChecked : el.value !== el.defaultValue;
      });
    } }), 500, '表单状态检查超时');
    return results[0]?.result === false ? null : 'form-state';
  } catch { return 'unverified-form-state'; }
});
const domFallbackTabs = new Set();
let pendingResult = null;
// 为桥的12MiB请求体上限预留JSON封装余量；单结果与批次统一按UTF-8字节计算。
const RESULT_MAX_BYTES = 10 * 1024 * 1024;
const resultBytes = value => new TextEncoder().encode(JSON.stringify(value)).byteLength;
function resultError(id, code, message) {
  return { id, error: { code, message, outcome: 'unverified' } };
}
function boundedResult(payload) {
  return resultBytes(payload) <= RESULT_MAX_BYTES ? payload : resultError(payload.id, 'RESULT_TOO_LARGE', '结果超过10MiB字节上限，已丢弃内容；动作不会重放，请回读确认。');
}
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

const PAGE_RESULT_ERROR_CODES = new Set(["PAGE_AGENT_EMPTY_RESULT","PAGE_AGENT_NO_RESULT","PAGE_AGENT_INVALID_RESULT","PAGE_AGENT_API_ERROR","PAGE_AGENT_NOT_READY","PAGE_AGENT_METHOD_MISSING","PAGE_AGENT_SYNC_THROW","PAGE_AGENT_PROMISE_REJECTED","PAGE_AGENT_SERIALIZE_FAILED","PAGE_AGENT_DOCUMENT_CHANGED","PAGE_AGENT_FRAME_MISMATCH","PAGE_AGENT_INVALID_OPERATION","PAGE_AGENT_COMMAND_EXPIRED","TAB_FROZEN","TAB_DISCARDED","PAGE_WAKE_FAILED","PAGE_WAKE_TIMEOUT","CDP_DISABLED","PAGE_ACTION_FAILED","INVALID_PARAMS","INVALID_ARGUMENTS","STALE_REF","REF_EXPIRED","STALE_CURSOR","SNAPSHOT_CHANGED","ELEMENT_NOT_VISIBLE","TARGET_CHANGED","ELEMENT_DISABLED","AMBIGUOUS_TARGET","TARGET_OUTSIDE_VIEWPORT","ELEMENT_OBSCURED","UNSUPPORTED_TARGET","UNSUPPORTED_ACTION"]);

const COMMAND_PHASES = new Set(['queue', 'tabs.get', 'tabs.query', 'tabs.update', 'tabs.create', 'windows.get', 'windows.getLastFocused', 'tabs.captureVisibleTab', 'debugger.attach', 'debugger.detach', 'scripting.inject', 'snapshot', 'scroll', 'inspect', 'prepare', 'focus', 'focusTarget', 'showCursor', 'cursorPulse', 'hideCursor', 'domClick', 'domFill', 'domPress', 'domHover', 'holdHover', 'pointerClick', 'domDrag', 'select', 'waitFor', 'Input.dispatchMouseEvent', 'Input.dispatchKeyEvent', 'Input.insertText', 'Page.captureScreenshot', 'Page.setWebLifecycleState']);

// 固定白名单也用于工具错误回执；绝不携带页面内容或原始异常正文。
function pageResultDiagnostic(value) {
  const out = {};
  if (!value || typeof value !== 'object') return out;
  for (const key of ['resultCount', 'frameId', 'durationMs']) {
    if (Number.isSafeInteger(value[key]) && value[key] >= 0) out[key] = value[key];
  }
  for (const key of ['agentPresent', 'documentChanged', 'frozen', 'discarded', 'wakeAttempted', 'wakeVerified']) if (typeof value[key] === 'boolean') out[key] = value[key];
  if (['loading', 'complete'].includes(value.tabStatus)) out.tabStatus = value.tabStatus;
  if (COMMAND_PHASES.has(value.phase)) out.phase = value.phase;
  if (['preflight', 'wake', 'inject', 'invoke', 'decode', 'serialize'].includes(value.stage)) out.stage = value.stage;
  if (['null', 'undefined', 'object', 'array', 'number', 'string', 'boolean'].includes(value.resultKind)) out.resultKind = value.resultKind;
  if (['envelope', 'legacy', 'empty', 'no-result', 'api-error'].includes(value.transportKind)) out.transportKind = value.transportKind;
  if (PAGE_RESULT_ERROR_CODES.has(value.errorCode)) out.errorCode = value.errorCode;
  if (['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'EvalError', 'URIError', 'AggregateError', 'DOMException', 'other'].includes(value.exceptionKind)) out.exceptionKind = value.exceptionKind;
  return out;
}

function diagnosticRecord(value) {
  const record = pageResultDiagnostic(value);
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

const ready = Promise.all([
  chrome.storage.local.get(['autoAuthorize', 'bridgePort', 'cdpEnabled', 'screenshotCdpEnabled', 'lifecycleWakeEnabled', 'cursorHideSec', 'cursorTrailSec', 'disconnected', 'diagnosticLog']),
  chrome.storage.session.get('revokedTabIds')
]).then(([stored, session]) => {
  for (const id of session.revokedTabIds || []) if (Number.isInteger(id) && id >= 0 && !revocationTouched.has(id)) revoked.add(id);
  autoAuthorize = stored.autoAuthorize === true;
  cdpEnabled = stored.cdpEnabled === true;
  screenshotCdpEnabled = stored.screenshotCdpEnabled !== false;
  lifecycleWakeEnabled = stored.lifecycleWakeEnabled === true;
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

function setRevoked(tabId, value) {
  revocationTouched.add(tabId);
  if (value) revoked.add(tabId); else revoked.delete(tabId);
  revocationSaving = revocationSaving.catch(() => {}).then(async () => {
    await ready;
    await chrome.storage.session.set({ revokedTabIds: [...revoked] });
  });
  return revocationSaving;
}

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

// 核对页面访问授权；冻结页是否可临时唤醒由独立生命周期用途决定。
async function ensureAllowed(tabId, check = () => {}) {
  const tab = await browserStep(check, 'tabs.get', () => chrome.tabs.get(tabId));
  check.lifecycle = pageResultDiagnostic({ tabStatus: tab.status, frozen: tab.frozen, discarded: tab.discarded });
  if (!isHttpUrl(tab.url)) throw new Error('仅允许操作 HTTP(S) 标签页');
  if (revoked.has(tabId) || (!authorized.has(tabId) && !autoAuthorize)) throw new Error('该标签页尚未手动授权或已释放，请在弹窗中授权此页');
  return tab;
}

// 原生冻结页不能执行任务。只判断浏览器已知状态，不用注入去等待其自行解冻。
function ensurePageRunnable(tab, check = () => {}) {
  const code = tab.frozen === true ? 'TAB_FROZEN' : tab.discarded === true ? 'TAB_DISCARDED' : null;
  if (!code) return;
  const diagnostic = pageResultDiagnostic({ stage: 'preflight', phase: 'tabs.get', ...check.lifecycle, errorCode: code });
  throw Object.assign(new Error(code === 'TAB_FROZEN'
    ? '目标页已被浏览器冻结，页面脚本无法运行；本次未继续注入。请先由用户唤醒该页，再重新定位；后台唤醒需要独立授权，不会自动切页、刷新、改节能设置或开启CDP。'
    : '目标页已被浏览器丢弃，页面内容不在内存；本次未继续注入。请先由用户恢复该页，再重新定位；不会自动刷新或重放。'), {
    code, outcome: check.pageWorkStarted ? 'unverified' : 'not-dispatched', diagnostic
  });
}

// 写入类命令（点击/输入/截屏）才附加调试器；首次写入时才出现提示条。
function checkCdpPermission(tabId, purpose, generation) {
  const permitted = purpose === 'lifecycle' ? lifecycleWakeEnabled : purpose === 'screenshot' ? screenshotCdpEnabled : purpose === 'input' ? cdpEnabled : false;
  if (generation !== cdpGeneration[purpose] || !permitted) {
    throw Object.assign(new Error(purpose === 'lifecycle' ? '后台唤醒已关闭或授权已变化' : purpose === 'screenshot' ? '截图 CDP 已关闭或授权已变化' : 'CDP 真实交互已关闭或授权已变化'), { code: 'CDP_DISABLED' });
  }
  if (revoked.has(tabId) || (!authorized.has(tabId) && !autoAuthorize)) throw new Error('该标签页已释放或授权已变化');
}

async function ensureAttached(tabId, purpose = 'input', check = () => {}) {
  const generation = cdpGeneration[purpose];
  const tab = await ensureAllowed(tabId, check);
  checkCdpPermission(tabId, purpose, generation);
  if (!attached.has(tabId)) {
    try {
      await browserStep(check, 'debugger.attach', async () => {
        await chrome.debugger.attach({ tabId }, '1.3');
        attached.add(tabId);
        if (purpose === 'lifecycle') lifecycleAttachments.add(tabId);
      });
      checkCdpPermission(tabId, purpose, generation);
    } catch (error) {
      if (attached.has(tabId)) { try { await detach(tabId); } catch {} }
      throw error;
    }
  }
  if (purpose === 'input') lifecycleAttachments.delete(tabId);
  return tab;
}

async function cdp(tabId, method, params = {}, check = () => {}) {
  check();
  const purpose = method === 'Page.captureScreenshot' ? 'screenshot' : 'input';
  const generation = cdpGeneration[purpose];
  await ensureAttached(tabId, purpose, check);
  check();
  return browserStep(check, method, () => {
    checkCdpPermission(tabId, purpose, generation);
    return chrome.debugger.sendCommand({ tabId }, method, params);
  });
}

// 只为新读取命令尝试一次；不唤醒已有悬挂命令，也不扩展点击/截图权限。
async function wakeFrozenPage(tab, check) {
  const tabId = tab.id;
  const generation = cdpGeneration.lifecycle;
  const started = Date.now();
  const wasAttached = attached.has(tabId);
  check.wakeAttempted = true;
  check.wakeDiagnostic = { wakeAttempted: true, wakeVerified: false };
  const guard = () => {
    check();
    checkCdpPermission(tabId, 'lifecycle', generation);
    if (Date.now() - started >= 2500) throw Object.assign(new Error('后台唤醒验证超时'), { code: 'PAGE_WAKE_TIMEOUT' });
  };
  guard.diagnostic = check.diagnostic;
  // 原生步骤沿用同一个命令的阶段和生命周期记录，超时时保留真实卡点。
  Object.defineProperties(guard, {
    phase: { get: () => check.phase, set: value => { check.phase = value; } },
    lifecycle: { get: () => check.lifecycle, set: value => { check.lifecycle = value; } }
  });
  const wakeError = error => {
    const code = ['invalidated', 'timeout', 'CDP_DISABLED', 'TARGET_CHANGED', 'PAGE_WAKE_TIMEOUT'].includes(error?.code) ? error.code : 'PAGE_WAKE_FAILED';
    diagnostic('page_result', { ...check.diagnostic, ...check.wakeDiagnostic, stage: 'wake', errorCode: code, outcome: 'error' });
    return Object.assign(new Error('后台唤醒未完成，未继续页面读取；不会切页或重放原操作。'), {
      code, outcome: 'unverified', diagnostic: pageResultDiagnostic({ stage: 'wake', ...check.lifecycle, ...check.wakeDiagnostic, errorCode: code })
    });
  };
  try {
    guard();
    await ensureAttached(tabId, 'lifecycle', guard);
    guard();
    const before = await ensureAllowed(tabId, guard);
    if (before.url !== tab.url || before.windowId !== tab.windowId || before.discarded === true) {
      throw Object.assign(new Error('唤醒前目标页面身份已变化'), { code: 'TARGET_CHANGED' });
    }
    if (before.frozen === true) {
      await browserStep(guard, 'Page.setWebLifecycleState', () => {
        guard();
        return chrome.debugger.sendCommand({ tabId }, 'Page.setWebLifecycleState', { state: 'active' });
      });
    }
    guard();
    let latest;
    // 有界确认原生状态；原生API挂起仍受命令总期限和原操作锁保护。
    for (const delay of [0, 300, 600]) {
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      guard();
      latest = await ensureAllowed(tabId, guard);
      guard();
      if (latest.url !== tab.url || latest.windowId !== tab.windowId || latest.discarded === true) {
        throw Object.assign(new Error('唤醒期间目标页面身份已变化'), { code: 'TARGET_CHANGED' });
      }
      if (latest.frozen === false) break;
    }
    if (latest?.frozen !== false) throw Object.assign(new Error('浏览器未确认页面已解冻'), { code: 'PAGE_WAKE_TIMEOUT' });
  } catch (error) {
    throw wakeError(error);
  } finally {
    // 只解除自己新建的附加；既有输入附加不属于本次临时唤醒。
    if (!wasAttached && lifecycleAttachments.has(tabId) && attached.has(tabId)) {
      try { await detach(tabId, Object.assign(() => {}, { diagnostic: check.diagnostic })); }
      catch {
        throw Object.assign(new Error('后台唤醒的临时调试连接未能解除，未继续读取'), {
          code: 'PAGE_WAKE_FAILED', outcome: 'unverified', diagnostic: pageResultDiagnostic({ stage: 'wake', ...check.wakeDiagnostic })
        });
      }
    }
  }
  try {
    guard();
    const after = await ensureAllowed(tabId, guard);
    guard();
    if (after.url !== tab.url || after.windowId !== tab.windowId || after.discarded === true) {
      throw Object.assign(new Error('唤醒清理后目标页面身份已变化'), { code: 'TARGET_CHANGED' });
    }
    if (after.frozen !== false) throw Object.assign(new Error('清理后浏览器未确认页面可读'), { code: 'PAGE_WAKE_TIMEOUT' });
    check.wakeDiagnostic.wakeVerified = true;
    diagnostic('page_result', { ...check.diagnostic, ...check.wakeDiagnostic, stage: 'wake', outcome: 'ok' });
    return after;
  } catch (error) {
    throw wakeError(error);
  }
}

async function ensureReadablePage(tab, check) {
  const eligible = ['snapshot', 'inspect', 'wait'].includes(check.diagnostic?.method);
  if (tab.frozen === true && tab.discarded !== true && lifecycleWakeEnabled && eligible && !check.pageWorkStarted && !check.wakeAttempted) {
    return wakeFrozenPage(tab, check);
  }
  ensurePageRunnable(tab, check);
  return tab;
}

const PAGE_METHODS = Object.freeze(['snapshot', 'scroll', 'inspect', 'prepare', 'focus', 'focusTarget',
  'showCursor', 'holdHover', 'cursorPulse', 'hideCursor', 'domClick', 'domHover', 'pointerClick',
  'domDrag', 'select', 'waitFor', 'domFill', 'domPress']);
const PAGE_RPC_PROTOCOL = 'ai-browser-page-rpc-v1';
const pageResultKind = value => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;

async function pageAgent(tabId, operation, ref, check = () => {}) {
  const report = (stage, fields = {}) => diagnostic('page_result', { ...check.diagnostic, outcome: fields.outcome, ...pageResultDiagnostic({ ...fields, stage }) });
  const fail = (code, message, fields) => {
    const detail = pageResultDiagnostic({ ...fields, errorCode: code });
    report(detail.stage || 'decode', { ...detail, outcome: 'error' });
    throw Object.assign(new Error(message), { code, diagnostic: detail });
  };
  const apiFailure = (error, stage) => {
    if (['invalidated', 'timeout'].includes(error?.code)) throw error;
    fail('PAGE_AGENT_API_ERROR', String(error?.message ?? error), {
      stage, transportKind: 'api-error', exceptionKind: pageExceptionKind(error)
    });
  };
  if (!PAGE_METHODS.includes(operation)) fail('PAGE_AGENT_INVALID_OPERATION', '不支持的页面操作', { stage: 'invoke' });
  check();
  await ensureReadablePage(await ensureAllowed(tabId, check), check);
  check();
  let injected;
  try {
    injected = await browserStep(check, 'scripting.inject', () => chrome.scripting.executeScript({
      // load=current读取已经存在的DOM，不等待页面document_idle；长连接/慢资源不应阻塞注入。
      target: { tabId }, world: 'ISOLATED', injectImmediately: true, files: ['cursor.js', 'page-agent.js']
    }));
  } catch (error) { apiFailure(error, 'inject'); }
  const injectionMeta = { stage: 'inject', resultCount: Array.isArray(injected) ? injected.length : undefined };
  if (!Array.isArray(injected) || injected.length !== 1 || !injected[0] || typeof injected[0] !== 'object' || Array.isArray(injected[0])) {
    fail('PAGE_AGENT_NO_RESULT', '页面代理注入未返回预期的主文档元数据', { ...injectionMeta, transportKind: 'no-result' });
  }
  if (injected[0].error) apiFailure(injected[0].error, 'inject');
  if (Number.isSafeInteger(injected[0].frameId) && injected[0].frameId !== 0) fail('PAGE_AGENT_FRAME_MISMATCH', '页面代理注入返回的框架不是主框架', { ...injectionMeta, frameId: injected[0].frameId });
  report('inject', { ...injectionMeta, frameId: injected[0].frameId, outcome: 'ok' });
  check();
  await ensureReadablePage(await ensureAllowed(tabId, check), check);
  check();
  let results;
  try {
    check.pageWorkStarted = true;
    results = await browserStep(check, operation, () => chrome.scripting.executeScript({
      // Chrome提供documentId时锁定注入的同一文档，避免页面导航后把操作派到新文档。
      target: { tabId, ...(typeof injected[0].documentId === 'string' && injected[0].documentId ? { documentIds: [injected[0].documentId] } : {}) },
      world: 'ISOLATED', injectImmediately: true,
      // 显式 async/await 在注入边界捕获；兼容已安装的 agent8，不依赖其 guarded 包装。
      func: async (name, elementRef, deadline) => {
        const protocol = 'ai-browser-page-rpc-v1';
        const safeCodes = new Set(["PAGE_AGENT_EMPTY_RESULT","PAGE_AGENT_NO_RESULT","PAGE_AGENT_INVALID_RESULT","PAGE_AGENT_API_ERROR","PAGE_AGENT_NOT_READY","PAGE_AGENT_METHOD_MISSING","PAGE_AGENT_SYNC_THROW","PAGE_AGENT_PROMISE_REJECTED","PAGE_AGENT_SERIALIZE_FAILED","PAGE_AGENT_DOCUMENT_CHANGED","PAGE_AGENT_FRAME_MISMATCH","PAGE_AGENT_INVALID_OPERATION","PAGE_AGENT_COMMAND_EXPIRED","TAB_FROZEN","TAB_DISCARDED","PAGE_WAKE_FAILED","PAGE_WAKE_TIMEOUT","CDP_DISABLED","PAGE_ACTION_FAILED","INVALID_PARAMS","INVALID_ARGUMENTS","STALE_REF","REF_EXPIRED","STALE_CURSOR","SNAPSHOT_CHANGED","ELEMENT_NOT_VISIBLE","TARGET_CHANGED","ELEMENT_DISABLED","AMBIGUOUS_TARGET","TARGET_OUTSIDE_VIEWPORT","ELEMENT_OBSCURED","UNSUPPORTED_TARGET","UNSUPPORTED_ACTION"]);
        const kind = value => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
        let agentPresent = false;
        const errorEnvelope = (code, error, stage, extra = {}) => {
          let message = '页面代理执行失败';
          let exceptionKind = 'other';
          try { message = String(error?.message ?? error ?? message); } catch {}
          try {
            if (['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'EvalError', 'URIError', 'AggregateError', 'DOMException'].includes(error?.name)) exceptionKind = error.name;
          } catch {}
          return { protocol, ok: false, error: { code, message }, diagnostic: { stage, agentPresent, exceptionKind, ...extra } };
        };
        try {
          const methods = ['snapshot', 'scroll', 'inspect', 'prepare', 'focus', 'focusTarget', 'showCursor',
            'holdHover', 'cursorPulse', 'hideCursor', 'domClick', 'domHover', 'pointerClick', 'domDrag',
            'select', 'waitFor', 'domFill', 'domPress'];
          if (!methods.includes(name)) return errorEnvelope('PAGE_AGENT_INVALID_OPERATION', '不支持的页面操作', 'invoke');
          // Chrome回调可能在期限后才开始；进入页面方法前拒绝，不能让迟到回调执行写入。
          if (Number.isFinite(deadline) && Date.now() >= deadline) return errorEnvelope('PAGE_AGENT_COMMAND_EXPIRED', '页面操作已过期，未调用页面方法', 'invoke');
          const agent = globalThis.__aiBrowserPageAgent9 || globalThis.__aiBrowserPageAgent8;
          agentPresent = !!agent;
          if (!agent) return errorEnvelope('PAGE_AGENT_NOT_READY', '页面代理未就绪', 'invoke');
          if (typeof agent[name] !== 'function') return errorEnvelope('PAGE_AGENT_METHOD_MISSING', '页面代理缺少所需方法', 'invoke');
          let pending;
          try { pending = name === 'hideCursor' ? agent[name]() : agent[name](elementRef); }
          catch (error) { return errorEnvelope('PAGE_AGENT_SYNC_THROW', error, 'invoke'); }
          let payload;
          try { payload = await pending; }
          catch (error) { return errorEnvelope('PAGE_AGENT_PROMISE_REJECTED', error, 'invoke'); }
          if (payload && typeof payload === 'object' && '__zcodeError' in payload) {
            const code = safeCodes.has(payload.__zcodeCode) ? payload.__zcodeCode : 'PAGE_ACTION_FAILED';
            return errorEnvelope(code, payload.__zcodeError, 'invoke');
          }
          const resultKind = kind(payload);
          if (payload === null || payload === undefined) return errorEnvelope('PAGE_AGENT_EMPTY_RESULT', '页面代理业务结果为空', 'serialize', { resultKind });
          if (typeof payload !== 'object' || Array.isArray(payload)) return errorEnvelope('PAGE_AGENT_INVALID_RESULT', '页面代理业务结果类型异常', 'serialize', { resultKind: ['number', 'string', 'boolean', 'array'].includes(resultKind) ? resultKind : undefined });
          try {
            // 先实际序列化再反序列化，防止 Chrome 在传输循环引用/BigInt/toJSON 异常时仅回传空值。
            const safePayload = JSON.parse(JSON.stringify(payload));
            if (!safePayload || typeof safePayload !== 'object' || Array.isArray(safePayload)) return errorEnvelope('PAGE_AGENT_INVALID_RESULT', '页面代理序列化结果类型异常', 'serialize', { resultKind: kind(safePayload) });
            return { protocol, ok: true, payload: safePayload, diagnostic: { stage: 'serialize', agentPresent, resultKind: 'object' } };
          } catch (error) { return errorEnvelope('PAGE_AGENT_SERIALIZE_FAILED', error, 'serialize', { resultKind }); }
        } catch (error) { return errorEnvelope('PAGE_AGENT_SYNC_THROW', error, 'invoke'); }
      },
      args: [operation, ref ?? null, Number.isFinite(check.deadline) ? check.deadline : null]
    }));
  } catch (error) {
    if (typeof injected[0].documentId === 'string' && /No document with id/i.test(String(error?.message ?? ''))) {
      fail('PAGE_AGENT_DOCUMENT_CHANGED', '原页面文档已不可用，未向新文档重试操作；原因需结合现场确认', { stage: 'invoke', transportKind: 'api-error', documentChanged: true });
    }
    apiFailure(error, 'invoke');
  }
  const meta = { stage: 'decode', resultCount: Array.isArray(results) ? results.length : undefined };
  report('invoke', { resultCount: meta.resultCount, outcome: 'ok' });
  if (!Array.isArray(results)) fail('PAGE_AGENT_INVALID_RESULT', '页面代理传输结果不是数组', { ...meta, transportKind: 'no-result', resultKind: pageResultKind(results) });
  if (!results.length) fail('PAGE_AGENT_NO_RESULT', '页面代理传输没有返回结果条目', { ...meta, transportKind: 'no-result' });
  if (results.length !== 1 || !results[0] || typeof results[0] !== 'object' || Array.isArray(results[0])) fail('PAGE_AGENT_INVALID_RESULT', '页面代理传输结果条目结构异常', { ...meta, transportKind: 'no-result' });
  const outcome = results[0];
  meta.frameId = outcome.frameId;
  if (typeof injected[0].documentId === 'string' && typeof outcome.documentId === 'string') meta.documentChanged = injected[0].documentId !== outcome.documentId;
  if (meta.documentChanged) fail('PAGE_AGENT_DOCUMENT_CHANGED', '页面代理注入与调用返回的文档不一致；调用结果不确定', meta);
  if ((Number.isSafeInteger(injected[0].frameId) && Number.isSafeInteger(outcome.frameId) && injected[0].frameId !== outcome.frameId) || (Number.isSafeInteger(outcome.frameId) && outcome.frameId !== 0)) fail('PAGE_AGENT_FRAME_MISMATCH', '页面代理注入与调用返回的框架不一致；调用结果不确定', meta);
  if (outcome.error) fail('PAGE_AGENT_API_ERROR', String(outcome.error?.message ?? outcome.error), { ...meta, transportKind: 'api-error', exceptionKind: pageExceptionKind(outcome.error) });
  if (!Object.prototype.hasOwnProperty.call(outcome, 'result')) fail('PAGE_AGENT_NO_RESULT', '页面代理传输条目缺少 result 字段', { ...meta, transportKind: 'no-result' });
  const value = outcome.result;
  meta.resultKind = pageResultKind(value);
  if (value === null || value === undefined) fail('PAGE_AGENT_EMPTY_RESULT', '页面代理传输返回空结果，原因尚未确定', { ...meta, transportKind: 'empty' });
  if (typeof value !== 'object' || Array.isArray(value)) fail('PAGE_AGENT_INVALID_RESULT', '页面代理传输结果类型异常', { ...meta, transportKind: 'legacy' });
  if (Object.prototype.hasOwnProperty.call(value, 'protocol')) {
    meta.transportKind = 'envelope';
    if (value.protocol !== PAGE_RPC_PROTOCOL || typeof value.ok !== 'boolean') fail('PAGE_AGENT_INVALID_RESULT', '页面代理协议结构异常', meta);
    report('decode', { ...meta, outcome: 'ok' });
    const detail = { ...meta, ...pageResultDiagnostic(value.diagnostic) };
    if (!value.ok) {
      const code = PAGE_RESULT_ERROR_CODES.has(value.error?.code) ? value.error.code : 'PAGE_AGENT_INVALID_RESULT';
      fail(code, typeof value.error?.message === 'string' ? value.error.message : '页面代理错误协议结构异常', detail);
    }
    if (!value.payload || typeof value.payload !== 'object' || Array.isArray(value.payload)) fail('PAGE_AGENT_INVALID_RESULT', '页面代理协议缺少有效业务结果', detail);
    report('serialize', { ...detail, outcome: 'ok' });
    return value.payload;
  }
  // 仅兼容旧传输夹具/回执；真实 func 始终生成上面的固定 envelope。
  meta.transportKind = 'legacy';
  if ('__zcodeError' in value) {
    const code = PAGE_RESULT_ERROR_CODES.has(value.__zcodeCode) ? value.__zcodeCode : 'PAGE_ACTION_FAILED';
    fail(code, String(value.__zcodeError), meta);
  }
  report('decode', { ...meta, outcome: 'ok' });
  return value;
}

function pageExceptionKind(error) {
  return ['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'EvalError', 'URIError', 'AggregateError', 'DOMException'].includes(error?.name) ? error.name : 'other';
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
  await taskTabs.ready;
  const tabs = await browserStep(check, 'tabs.query', () => chrome.tabs.query({}));
  return tabs.filter((tab) => isHttpUrl(tab.url)).map((tab) => {
    const useCdp = cdpEnabled && !domFallbackTabs.has(tab.id);
    return {
    id: tab.id,
    title: tab.title || '',
    url: tab.url,
    active: Boolean(tab.active),
    ...(typeof tab.autoDiscardable === 'boolean' ? { autoDiscardable: tab.autoDiscardable } : {}),
    ...(typeof tab.status === 'string' ? { status: tab.status } : {}),
    ...(typeof tab.frozen === 'boolean' ? { frozen: tab.frozen } : {}),
    ...(typeof tab.discarded === 'boolean' ? { discarded: tab.discarded } : {}),
    ...(runningOperations.has(tab.id) ? { operation: {
      commandId: runningOperations.get(tab.id).check.diagnostic.commandId,
      method: runningOperations.get(tab.id).check.diagnostic.method,
      phase: runningOperations.get(tab.id).check.phase,
      durationMs: Date.now() - runningOperations.get(tab.id).started,
      timedOut: runningOperations.get(tab.id).timedOut
    } } : {}),
    managed: taskTabs.tabs.has(tab.id),
    taskId: taskTabs.tabs.get(tab.id)?.taskId,
    taskName: taskTabs.tabs.get(tab.id)?.name,
    provenance: taskTabs.tabs.get(tab.id)?.provenance,
    evidence: taskTabs.tabs.get(tab.id)?.evidence,
    keep: taskTabs.tabs.get(tab.id)?.keep,
    groupId: tab.groupId,
    authorized: !revoked.has(tab.id) && (authorized.has(tab.id) || autoAuthorize),
    inputMode: useCdp ? 'cdp' : 'dom',
    domFallback: domFallbackTabs.has(tab.id),
    screenshotMode: screenshotCdpEnabled ? 'cdp' : 'active-tab',
    lifecycleWakeEnabled,
    capabilities: { hover: useCdp ? 'cdp' : 'dom-events', cssHover: useCdp,
      pointer: useCdp ? 'cdp' : 'synthetic', drag: useCdp ? 'cdp-pointer' : 'synthetic-pointer-and-html5',
      nativeSelect: 'dom', inspect: true, wait: true, focus: true,
      nativeBrowserMenus: false, systemDialogs: false, canvasTargets: false }
  }; });
}

async function release(tabId, check = () => {}) {
  const tracked = authorized.has(tabId) || attached.has(tabId) || (autoAuthorize && !revoked.has(tabId));
  if (!tracked) throw new Error('该标签页尚未授权');
  try { await pageAgent(tabId, 'hideCursor', undefined, check); } catch {}
  if (attached.has(tabId)) await detach(tabId, check);
  authorized.delete(tabId);
  attached.delete(tabId);
  await setRevoked(tabId, true);
  return { released: true, tabId };
}

async function detach(tabId, check = () => {}) {
  detaching.add(tabId);
  try { await browserStep(check, 'debugger.detach', () => chrome.debugger.detach({ tabId })); attached.delete(tabId); lifecycleAttachments.delete(tabId); }
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
  if (method === 'task') return taskTabs.task(params, check);
  if (method === 'batch') {
    const results = await Promise.all(params.commands.map(async (item, index) => {
      try { return { ok: true, result: await executeBounded({ id: `${command.id}-${index}`, ...item }, check) }; }
      catch (error) {
        const diagnostic = pageResultDiagnostic(error.diagnostic);
        return { ok: false, error: { code: error.code === 'timeout' ? 'COMMAND_TIMEOUT' : error.code === 'invalidated' ? 'CONNECTION_INVALIDATED' : error.code || 'BROWSER_ACTION_FAILED', message: errorMessage(error), outcome: error.outcome || 'unverified',
          commandId: String(command.id) + '-' + index, ...(Object.keys(diagnostic).length ? { diagnostic } : {}) } };
      }
    }));
    let bytes = 0;
    for (let index = 0; index < results.length; index++) {
      const size = resultBytes(results[index]);
      if (bytes + size > RESULT_MAX_BYTES - 4096) results[index] = { ok: false, error: { code: 'RESULT_TOO_LARGE', message: '本批次图像过大，请单独截图该页；其他结果保留', outcome: 'unverified' } };
      else bytes += size;
    }
    return { results };
  }
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
    const opened = await browserStep(check, 'tabs.create', () => taskTabs.open(params, windowId, check));
    const { tab } = opened;
    const afterWindow = await browserStep(check, 'windows.get', () => chrome.windows.get(windowId));
    return { opened: !opened.reused, reused: opened.reused, taskId: opened.taskId, groupId: opened.groupId, groupError: opened.groupError,
      tabId: tab.id, windowId: tab.windowId, active: tab.active === true,
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
      if (attached.has(tabId) && cdpEnabled && !revoked.has(tabId)) await bounded(chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent',
        { type: 'mouseReleased', x: point.x, y: point.y, button, buttons: 0, clickCount }), 1000, '释放鼠标等待超时');
    };
    const dispatched = extra => ({ actionDispatched: true, outcome: 'unverified',
      mode: useCdp ? 'cdp' : 'dom', trusted: useCdp, fallbackReason,
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
    const inputActions = ['click', 'hover', 'drag', 'set_checked', 'fill', 'press'];
    let useCdp = cdpEnabled && params.mode !== 'dom' && (params.mode === 'cdp' || !domFallbackTabs.has(tabId));
    let fallbackReason;
    if (inputActions.includes(method)) {
      if (params.mode === 'cdp' && !cdpEnabled) throw Object.assign(new Error('CDP真实交互开关已关闭，不能通过参数开启'), { code: 'CDP_DISABLED' });
      if (params.mode === 'dom' || !useCdp) {
        if (attached.has(tabId)) await detach(tabId, check);
      } else {
        try { await ensureAttached(tabId, 'input', check); domFallbackTabs.delete(tabId); }
        catch (error) {
          check();
          if (params.mode === 'cdp') throw error;
          // 仅在输入尚未派发时降级。执行阶段失败不能重放点击/提交。
          if (attached.has(tabId)) await detach(tabId, check);
          await ensureAllowed(tabId, check);
          useCdp = false;
          domFallbackTabs.add(tabId);
          fallbackReason = 'CDP_ATTACH_FAILED';
        }
      }
    }
    if (['fill', 'select', 'set_checked', 'drag', 'press'].includes(method)) taskTabs.markModified(tabId);
    switch (method) {
      case 'snapshot':
        return { ...await agent('snapshot', { load: params.load ?? (params.cursor ? 'current' : 'auto'),
            ...Object.fromEntries(['name', 'role', 'context', 'exact', 'scope', 'scopeRef', 'cursor', 'limit'].filter(key => Object.hasOwn(params, key)).map(key => [key, params[key]])) }),
          verificationHint: 'DOM有遮挡、身份歧义、截断或状态矛盾时，先browser_screenshot核对可见结果；截图不能证明未加载数据完整。' };
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
        if (useCdp) {
          await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
          try { await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 }); }
          finally { await cleanupUp(point); }
        } else await agent('domClick', params.ref);
        const after = await agent('inspect', params.ref);
        return dispatched({ checked: actual(after.checked), changed: true, verified: !after.identityChanged && actual(after.checked) === params.checked });
      }
      case 'hover': {
        const point = await prepareTarget(params.ref, params.expectedContext, params.position);
        if (useCdp) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
        else await agent('domHover', { ref: params.ref, point });
        await new Promise(done => setTimeout(done, params.durationMs ?? 300));
        check();
        const held = await agent('holdHover', { ref: params.ref });
        return dispatched({ cssHover: useCdp, cursorHeld: held.held === true, note: useCdp ? '浏览器指针已移动，系统鼠标不动。' : '合成悬停事件不能设置CSS :hover，也不保证网站接受非可信事件。' });
      }
      case 'drag': {
        let from = await prepareTarget(params.fromRef, params.expectedFromContext);
        if (useCdp) {
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
        if (!useCdp) return dispatched(await agent('domDrag', { fromRef: params.fromRef, toRef: params.toRef, from, to, durationMs }));
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
          mode: useCdp ? 'cdp' : 'dom', fallbackReason, ...(useCdp ? {} : { trusted: false }) };
      }
      case 'fill':
        if (typeof params.text !== 'string') throw new Error('text 必须是字符串');
        const spot = await agent('prepare', params.ref);
        await agent('showCursor', { x: spot.x, y: spot.y, hideMs: cursorHideMs, trailMs: cursorTrailMs, animate: currentTab.active });
        if (!useCdp) {
          const result = await agent('domFill', { ref: params.ref, text: params.text });
          try { await agent('cursorPulse', { ...spot, hideMs: cursorHideMs }); } catch {}
          return { ...result, fallbackReason };
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
        if (!useCdp) return { ...await agent('domPress', params.key), fallbackReason };
        await press(tabId, params.key, check);
        return { pressed: true, mode: 'cdp' };
      case 'navigate':
        if (typeof params.url !== 'string' || !isHttpUrl(params.url)) throw new Error('url 必须是绝对 HTTP(S) 地址');
        check();
        await browserStep(check, 'tabs.update', () => chrome.tabs.update(tabId, { url: params.url }));
        domFallbackTabs.delete(tabId);
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

async function executeBounded(command, parentCheck = () => {}) {
  parentCheck();
  const tabId = command.params?.tabId;
  const isBatch = command.method === 'batch';
  const meta = { commandId: String(command.id), method: command.method, tabId, epoch: connectionEpoch, port: bridgePort };
  if (!isBatch && runningTabs.has(tabId)) {
    diagnostic('command_end', { ...meta, outcome: 'busy' });
    const previous = runningOperations.get(tabId);
    throw Object.assign(new Error('此标签页上一条操作仍未结束，结果不确定；本次未派发，请勿重复提交。可操作其他标签页。'), {
      code: 'TAB_BUSY', outcome: 'not-dispatched', commandId: meta.commandId,
      diagnostic: pageResultDiagnostic({ phase: previous?.check.phase, ...previous?.check.lifecycle })
    });
  }
  if (!isBatch) runningTabs.add(tabId);
  commandStartedAt = Date.now();
  let expired = false;
  const epoch = connectionEpoch;
  const started = Date.now();
  const check = () => { parentCheck(); if (expired || epoch !== connectionEpoch || wantDisconnect) throw Object.assign(new Error('原操作已过期或连接已变化，未继续派发动作；已派发部分结果不确定。'), { code: 'invalidated' }); };
  check.diagnostic = meta;
  check.phase = 'queue';
  check.deadline = isBatch ? undefined : started + 11000;
  diagnostic('command_start', meta);
  const operation = { check, started, timedOut: false };
  if (!isBatch) runningOperations.set(tabId, operation);
  const work = Promise.resolve().then(() => execute(command, check)).finally(() => {
    if (!isBatch) {
      runningTabs.delete(tabId);
      if (runningOperations.get(tabId) === operation) runningOperations.delete(tabId);
    }
  });
  let outcome = 'ok';
  try {
    // 子项各有11秒期限；父批次不再抢先用相同期限丢掉全部逐项结果。
    const result = await (isBatch ? work : bounded(work, 11000, '浏览器操作等待超时，结果不确定；原操作不会自动重放，请停止相关业务并交接维护。'));
    return check.wakeAttempted ? { ...result, lifecycleWake: { attempted: true, verified: check.wakeDiagnostic?.wakeVerified === true } } : result;
  } catch (error) {
    outcome = ['timeout', 'invalidated'].includes(error.code) ? error.code : 'error';
    operation.timedOut = error.code === 'timeout';
    error.commandId = meta.commandId;
    error.diagnostic = pageResultDiagnostic({ phase: check.phase, ...check.lifecycle, ...check.wakeDiagnostic, ...error.diagnostic, durationMs: Date.now() - started });
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
    autoAuthorize, cdpEnabled, screenshotCdpEnabled, lifecycleWakeEnabled, cursorHideSec: Math.round(cursorHideMs / 1000),
    cursorTrailSec: Math.round(cursorTrailMs / 1000), bridgePort, authorizedTabIds: [...authorized], revokedTabIds: [...revoked],
    commandRunning: runningTabs.size > 0, lastPollAt: lastPollAt || null };
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
          // 认证/占用/限流等暂态错误保留结果重传；无效请求不可永久堵住poll。
          const terminal = error?.status >= 400 && error.status < 500 && ![401, 403, 408, 409, 425, 429].includes(error.status);
          if (!terminal) throw error;
          if (error.status !== 404 && payload.error?.code !== 'RESULT_REJECTED') {
            const rejected = resultError(payload.id, 'RESULT_REJECTED', '桥拒绝结果(HTTP ' + error.status + ')，原内容已丢弃；动作不会重放，请回读确认。');
            remember(payload.id, rejected);
            if (pendingResult === payload) pendingResult = rejected;
            return;
          }
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
          payload = { id: command.id, error: { message: errorMessage(error), code: error.code === 'timeout' ? 'COMMAND_TIMEOUT' : error.code === 'invalidated' ? 'CONNECTION_INVALIDATED' : error.code || 'BROWSER_ACTION_FAILED', outcome: error.outcome || 'unverified', ...(error.diagnostic ? { diagnostic: pageResultDiagnostic(error.diagnostic) } : {}) } };
        }
        payload = boundedResult(payload);
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
      cdpGeneration.input++;
      cdpEnabled = message.enabled === true;
      await chrome.storage.local.set({ cdpEnabled });
      if (!cdpEnabled) await detachAll();
      return { cdpEnabled };
    }
    case 'set_screenshot_cdp_enabled': {
      cdpGeneration.screenshot++;
      screenshotCdpEnabled = message.enabled === true;
      await chrome.storage.local.set({ screenshotCdpEnabled });
      if (!screenshotCdpEnabled && !cdpEnabled && !lifecycleWakeEnabled) await detachAll();
      return { screenshotCdpEnabled };
    }
    case 'set_lifecycle_wake_enabled': {
      cdpGeneration.lifecycle++;
      lifecycleWakeEnabled = message.enabled === true;
      await chrome.storage.local.set({ lifecycleWakeEnabled });
      if (!lifecycleWakeEnabled) {
        const results = await Promise.allSettled([...lifecycleAttachments].map(tabId => bounded(withTab(tabId, async () => {
          if (lifecycleAttachments.has(tabId) && attached.has(tabId)) await detach(tabId);
        }), 2000, '临时唤醒连接仍在清理，原操作不会重放')));
        if (results.some(result => result.status === 'rejected')) throw new Error('后台唤醒已关闭；部分临时连接尚未确认解除，将随原操作结束清理');
      }
      return { lifecycleWakeEnabled };
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
        // 只登记页面访问授权，不附加调试器；输入、截图和冻结唤醒分别检查自身用途开关。
        authorized.add(tab.id);
        await setRevoked(tab.id, false);
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
  lifecycleAttachments.delete(source.tabId);
  if (!detaching.has(source.tabId)) {
    authorized.delete(source.tabId);
    void setRevoked(source.tabId, true).catch(() => {});
  }
});
chrome.webNavigation?.onCreatedNavigationTarget.addListener(event => { void taskTabs.created(event); });
chrome.tabs.onRemoved.addListener((tabId) => { authorized.delete(tabId); attached.delete(tabId); lifecycleAttachments.delete(tabId); void setRevoked(tabId, false).catch(() => {}); domFallbackTabs.delete(tabId); taskTabs.removed(tabId); });
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
