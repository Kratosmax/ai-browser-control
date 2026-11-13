// 稳定 stdio launcher：只能静态依赖 Node 内置模块，产品依赖在可替换 worker 中加载。
import readline from 'node:readline';
import fs from 'node:fs';
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';

const START_TIMEOUT_MS = 8000;
const CALL_TIMEOUT_MS = 40000;
const workerUrl = new URL('./mcp-worker.mjs', import.meta.url);
const originalArgs = process.argv.slice(2);
function launcherFingerprint() {
  try { return createHash('sha256').update(fs.readFileSync(new URL(import.meta.url))).digest('hex'); }
  catch { return null; }
}
const loadedLauncherFingerprint = launcherFingerprint();
function launcherHealth() {
  const disk = launcherFingerprint();
  const known = loadedLauncherFingerprint !== null && disk !== null;
  return { state: known ? loadedLauncherFingerprint === disk ? 'current' : 'outdated' : 'unknown',
    hostReconnectRequired: known ? loadedLauncherFingerprint !== disk : null, automaticChanges: false };
}
function statusWithLauncherHealth(result) {
  if (result?.isError || !Array.isArray(result?.content)) return result;
  return { ...result, content: result.content.map(item => {
    if (item?.type !== 'text') return item;
    try {
      const data = JSON.parse(item.text);
      if (!data || typeof data !== 'object' || Array.isArray(data)) return item;
      return {...item,text:JSON.stringify({...data,mcpLauncherPid:process.pid,launcherHealth:launcherHealth()})};
    } catch { return item; }
  }) };
}
const value = name => { const i = originalArgs.indexOf(name); return i >= 0 ? originalArgs[i + 1] : undefined; };
const portValue = Number(value('--port'));
const PORT = Number.isInteger(portValue) && portValue > 0 && portValue < 65536 ? portValue : 17653;
const HOST = value('--host') ?? '127.0.0.1';
const SERVER_NAME = HOST === '127.0.0.1' ? 'ai-browser-' + PORT : 'ai-browser-' + HOST.replaceAll('.', '-') + '-' + PORT;
// 产品目录完全由活动 worker 提供。仅在 worker 不可用时提供恢复所需的管理目录。
const recoveryTools = [
  { name: 'browser_status', description: '检查 MCP 工作进程状态；工作进程可用时同时检查桥与扩展。', inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false } },
  { name: 'browser_restart', description: '仅重载当前 MCP 工作进程，保持宿主 stdio 连接；不重启共享桥或修改浏览器权限。', inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false } }
];
let active = null;
let lastInfo = null;
let nextGeneration = 0;
let nextCall = 0;
let inFlight = 0;
let restarting = false;
let booting = true;
let shuttingDown = false;
let inputClosed = false;
let initialized = false;
let startupError = null;
const workers = new Set();
const handlers = new Set();

function failure(code, message, outcome = 'unverified') { return Object.assign(new Error(message), { code, outcome }); }
function toolError(error) {
  return { isError: true, content: [{ type: 'text', text: error.message + '\n诊断：' + JSON.stringify({ code: error.code || 'BROWSER_ACTION_FAILED', outcome: error.outcome || 'unverified' }) }],
    structuredContent: { error: { code: error.code || 'BROWSER_ACTION_FAILED', message: error.message, outcome: error.outcome || 'unverified' } } };
}
function write(message) { if (!shuttingDown) process.stdout.write(JSON.stringify(message) + '\n'); }
function listChanged() { if (initialized && !shuttingDown) write({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }); }
function diskVersion() {
  try { const version = JSON.parse(fs.readFileSync(new URL('../.zcode-plugin/plugin.json', import.meta.url), 'utf8')).version; return typeof version === 'string' ? version : null; }
  catch { return null; }
}
function info(entry = active) {
  return entry?.info ?? { mcpVersion: lastInfo?.mcpVersion ?? null, mcpPid: null, mcpGeneration: lastInfo?.mcpGeneration ?? 0 };
}
function localStatus() {
  const current = info();
  const mcpDiskVersion = diskVersion();
  const data = { ...current, mcpDiskVersion, mcpLauncherPid: process.pid, launcherHealth: launcherHealth(),
    mcpState: restarting ? 'restarting' : booting ? 'starting' : 'unavailable',
    restartRequired: !active || (mcpDiskVersion === null ? null : mcpDiskVersion !== current.mcpVersion),
    bridgeStatusAvailable: false, port: PORT, host: HOST,
    state: '当前仅提供 MCP 状态；未查询共享桥或浏览器扩展。',
    ...(startupError ? { mcpError: { code: startupError.code, message: startupError.message } } : {}) };
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}
function bounded(promise, milliseconds) {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), milliseconds);
    promise.then(() => { clearTimeout(timer); resolve(true); }, () => { clearTimeout(timer); resolve(true); });
  });
}
function send(entry, message) {
  return new Promise((resolve, reject) => {
    if (entry.exited || !entry.child.connected) return reject(failure('MCP_WORKER_UNAVAILABLE', 'MCP 工作进程不可用，请调用 browser_restart({}) 恢复。'));
    entry.child.send(message, error => error ? reject(failure('MCP_WORKER_UNAVAILABLE', 'MCP 工作进程 IPC 不可用；命令未自动重放。')) : resolve());
  });
}
async function stopWorker(entry) {
  if (!entry || entry.exited) return;
  if (entry.stopPromise) return entry.stopPromise;
  entry.stopping = true;
  entry.stopPromise = (async () => {
    void send(entry, { type: 'shutdown' }).catch(() => {});
    if (await bounded(entry.closed, 500)) return;
    try { entry.child.kill('SIGTERM'); } catch {}
    if (await bounded(entry.closed, 1000)) return;
    try { entry.child.kill('SIGKILL'); } catch {}
    if (!await bounded(entry.closed, 1000)) throw failure('MCP_WORKER_STOP_FAILED', 'MCP 工作进程在有界终止期限内未退出。');
  })();
  return entry.stopPromise;
}
async function launchWorker() {
  let child;
  try {
    // 原 argv 原样透传，包括 host/port/token/config-dir；既不输出参数，也不把 worker stdout 混入 MCP。
    child = fork(workerUrl, originalArgs, { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true, execArgv: [] });
  } catch { throw failure('MCP_WORKER_START_FAILED', '无法启动 MCP 候选工作进程；原工作进程保持不变。'); }
  const entry = { child, generation: ++nextGeneration, pending: new Map(), exited: false, stopping: false, info: null, tools: null };
  workers.add(entry);
  let resolveReady, rejectReady, resolveClosed;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  entry.closed = new Promise(resolve => { resolveClosed = resolve; });
  const startTimer = setTimeout(() => rejectReady(failure('MCP_WORKER_START_TIMEOUT', 'MCP 候选工作进程未在 8 秒内 ready；原工作进程保持不变。')), START_TIMEOUT_MS);
  function unavailable(reason) {
    rejectReady(reason);
    entry.rejectActivation?.(reason);
    for (const pending of entry.pending.values()) { clearTimeout(pending.timer); pending.reject(reason); }
    entry.pending.clear();
    if (active === entry) {
      active = null;
      startupError = reason;
      listChanged();
    }
  }
  child.on('error', () => unavailable(failure('MCP_WORKER_START_FAILED', 'MCP 工作进程启动或 IPC 失败；不会自动重放命令。')));
  child.on('disconnect', () => {
    unavailable(failure('MCP_WORKER_EXITED', 'MCP 工作进程 IPC 已断开；请调用 browser_restart({}) 恢复，命令不会自动重放。'));
    if (!entry.stopping) void stopWorker(entry).catch(() => {});
  });
  child.on('exit', (code, signal) => {
    entry.exited = true;
    workers.delete(entry);
    resolveClosed();
    unavailable(failure('MCP_WORKER_EXITED', 'MCP 工作进程已退出（' + (signal || 'exit ' + code) + '）；请调用 browser_restart({}) 恢复，命令不会自动重放。'));
  });
  // spawn 失败可能只有 error/close，没有 exit。
  child.on('close', () => {
    if (!entry.exited) { entry.exited = true; workers.delete(entry); resolveClosed(); }
  });
  child.on('message', message => {
    if (!message || entry.exited) return;
    if (message.type === 'ready' && !entry.info) {
      const names = Array.isArray(message.tools) ? message.tools.map(tool => tool?.name) : [];
      if (message.pid !== child.pid || message.generation !== entry.generation || typeof message.version !== 'string' || !message.version ||
          !names.length || names.some(name => typeof name !== 'string') || new Set(names).size !== names.length || !names.includes('browser_restart') || !names.includes('browser_status')) {
        return rejectReady(failure('MCP_WORKER_INVALID_READY', 'MCP 候选工作进程返回了无效的 ready/工具目录；原工作进程保持不变。'));
      }
      entry.info = { mcpVersion: message.version, mcpPid: child.pid, mcpGeneration: entry.generation };
      entry.tools = message.tools;
      entry.serverName = message.serverName;
      resolveReady(entry);
    }
    if (message.type === 'activated' && message.pid === child.pid && message.generation === entry.generation) entry.resolveActivation?.();
    if (message.type === 'result') {
      const pending = entry.pending.get(message.id);
      if (!pending) return;
      entry.pending.delete(message.id);
      clearTimeout(pending.timer);
      pending.resolve(message.result);
    }
  });
  void send(entry, { type: 'start', generation: entry.generation }).catch(rejectReady);
  try { await ready; if (entry.exited || !child.connected) throw failure('MCP_WORKER_START_FAILED', 'MCP 候选工作进程 ready 后已退出；原工作进程保持不变。'); return entry; }
  catch (error) { await stopWorker(entry); throw error; }
  finally { clearTimeout(startTimer); }
}
async function activate(entry) {
  let timer;
  const activated = new Promise((resolve, reject) => {
    entry.resolveActivation = resolve;
    entry.rejectActivation = reject;
    timer = setTimeout(() => reject(failure('MCP_WORKER_START_TIMEOUT', 'MCP 候选工作进程未在 2 秒内确认激活；原工作进程保持不变。')), 2000);
  });
  try {
    void send(entry, { type: 'activate' }).catch(entry.rejectActivation);
    await activated;
  } finally {
    clearTimeout(timer);
    entry.resolveActivation = entry.rejectActivation = null;
  }
  if (shuttingDown || entry.exited || !entry.child.connected) throw failure('MCP_WORKER_START_FAILED', 'MCP 候选工作进程激活前已退出。');
  active = entry;
  lastInfo = entry.info;
  startupError = null;
}
function callWorker(entry, name, args) {
  if (entry.stopping || entry.exited || !entry.child.connected) return Promise.reject(failure('MCP_WORKER_UNAVAILABLE', 'MCP 工作进程正在停止或已不可用；本次调用未派发。', 'not-dispatched'));
  return new Promise((resolve, reject) => {
    const id = ++nextCall;
    const timer = setTimeout(() => {
      // 截止后先移出结果路由，避免停止期间的迟到结果或 disconnect 抢先覆盖超时。
      // inFlight 保留到有界停止结束；失败时也不能声称进程已终止。
      entry.pending.delete(id);
      void stopWorker(entry).then(() => {
        reject(failure('MCP_WORKER_TIMEOUT', 'MCP 工作进程调用超时，已终止该工作进程；执行结果未知，不会自动重放。请先回读确认，保留诊断并交接维护。'));
      }, error => reject(error));
    }, CALL_TIMEOUT_MS);
    entry.pending.set(id, { resolve, reject, timer });
    void send(entry, { type: 'call', id, name, args }).catch(error => {
      if (entry.pending.delete(id)) { clearTimeout(timer); reject(error); }
    });
  });
}
const startup = (async () => {
  let entry;
  try { entry = await launchWorker(); await activate(entry); }
  catch (error) { startupError = error; await stopWorker(entry).catch(() => {}); }
  finally { booting = false; }
})();

async function restart(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length) throw failure('INVALID_ARGUMENTS', 'browser_restart 只接受空对象 {}。');
  if (restarting || booting) throw failure('MCP_RESTARTING', 'MCP 工作进程正在启动或重载；本次调用已拒绝，不会排队。');
  if (inFlight) throw failure('MCP_BUSY', '存在尚未完成的 tools/call；本次重载已拒绝，不会排队。');
  restarting = true;
  const old = active;
  const before = info();
  let candidate;
  try {
    // 失联 worker 可能尚在有界终止阶段；恢复前先确认它们已经收敛。
    await Promise.all([...workers].filter(entry => entry !== old).map(stopWorker));
    candidate = await launchWorker();
    if (inputClosed) throw failure('MCP_INPUT_CLOSED', '宿主输入已关闭，取消尚未切换的MCP重载。');
    await activate(candidate);
    await stopWorker(old);
    const result = { restart: true, scope: 'mcp-worker', mcpLauncherPid: process.pid, before, after: info(candidate), launcherHealth: launcherHealth() };
    listChanged();
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
  } catch (error) {
    if (candidate && active !== candidate) await stopWorker(candidate).catch(() => {});
    throw error;
  } finally { restarting = false; }
}
async function handle(message) {
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string' || !Object.hasOwn(message, 'id')) return;
  const reply = result => write({ jsonrpc: '2.0', id: message.id, result });
  if (message.method === 'ping') return reply({});
  if (message.method === 'initialize') {
    await startup;
    initialized = true;
    return reply({ protocolVersion: ['2024-11-05', '2025-03-26', '2025-06-18'].includes(message.params?.protocolVersion) ? message.params.protocolVersion : '2024-11-05',
      capabilities: { tools: { listChanged: true } }, serverInfo: { name: active?.serverName || SERVER_NAME, version: info().mcpVersion || 'unknown' } });
  }
  if (message.method === 'tools/list') { await startup; return reply({ tools: active?.tools ?? recoveryTools }); }
  if (message.method === 'tools/call') {
    const name = message.params?.name;
    if (name === 'browser_restart') {
      try { return reply(await restart(Object.hasOwn(message.params, 'arguments') ? message.params.arguments : {})); }
      catch (error) { return reply(toolError(error)); }
    }
    if (restarting) return reply(name === 'browser_status' ? localStatus() : toolError(failure('MCP_RESTARTING', 'MCP 工作进程正在重载；本次调用已拒绝，不会排队或重放。')));
    inFlight++;
    try {
      await startup;
      if (!active) {
        if (name === 'browser_status') return reply(localStatus());
        throw failure('MCP_WORKER_UNAVAILABLE', 'MCP 工作进程不可用，请调用 browser_restart({}) 恢复；本次调用未派发。');
      }
      const result = await callWorker(active, name, message.params?.arguments ?? {});
      return reply(name === 'browser_status' ? statusWithLauncherHealth(result) : result);
    } catch (error) { return reply(toolError(error)); }
    finally { inFlight--; }
  }
  write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
}
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await Promise.allSettled([...workers].map(stopWorker));
  // 让已经接受的 stdio 响应写完；关闭父进程不会终止共享桥。
  const timer = setTimeout(() => process.exit(0), 250);
  process.stdout.write('', () => { clearTimeout(timer); process.exit(0); });
}
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { void shutdown(); });
process.stdout.on('error', () => { void shutdown(); });
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('close', () => {
  inputClosed = true;
  // EOF不再接收新请求；取消尚未切换的候选，但让已接受的业务请求按完整调用期限返回。
  if (restarting) for (const entry of workers) if (entry !== active) void stopWorker(entry).catch(() => {});
  // CALL_TIMEOUT含工作进程的有界终止余量，不能用8秒启动期限截断合法慢调用。
  void bounded(Promise.allSettled([...handlers]), CALL_TIMEOUT_MS + 5000).then(shutdown);
});
input.on('line', line => {
  if (!line.trim() || shuttingDown) return;
  let message;
  try { message = JSON.parse(line); }
  catch { return write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
  const task = handle(message).catch(() => write({ jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32603, message: 'MCP internal error' } }));
  handlers.add(task);
  void task.finally(() => handlers.delete(task));
});
