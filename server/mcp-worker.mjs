// 可替换的产品工作进程：只通过 fork IPC 收发，不占用宿主的 MCP stdio。
import fs from 'node:fs';
import { compactSnapshot, browserRequestParams } from './snapshot-format.mjs';

let generation = 0;
let supervisor;
let activated = false;
let stopping = false;
let runtimeReady = false;
let readySent = false;

function stop() {
  if (stopping) return;
  stopping = true;
  // 桥是可被多个 MCP 实例共享的独立进程；这里只停止本 worker 的监督计时器。
  supervisor?.stop();
  process.exit(0);
}
function send(message) {
  if (!process.connected) return stop();
  process.send(message, error => { if (error) stop(); });
}
function diskVersion() {
  try { return JSON.parse(fs.readFileSync(new URL('../.zcode-plugin/plugin.json', import.meta.url), 'utf8')).version ?? null; }
  catch { return null; }
}
async function callTool(name, args) {
  // 管理方法永远不下发到桥，即使 IPC 被错误调用也拒绝。
  if (name === 'browser_restart' || !tools.some(tool => tool.name === name)) throw new Error('未知工具：' + name);
  await ensureBridge(PORT, { host: HOST, token: TOKEN, configDir: CONFIG_DIR });
  if (name === 'browser_status') {
    const status = await bridgeRequest('/status', { port: PORT, host: HOST, token: TOKEN });
    const where = HOST === '127.0.0.1' ? '桥端口 ' + PORT : '远端桥 ' + HOST + ':' + PORT;
    let state;
    if (!status.connected) state = '扩展命令通道未连接（桥可达，但尚未收到近期轮询）';
    else if (status.standby) state = '扩展命令通道暂未响应，等待自动重连；可打开扩展弹窗检查连接状态';
    else state = '已连接';
    const mcpDiskVersion = diskVersion();
    return { content: [{ type: 'text', text: JSON.stringify({ ...status, port: PORT, host: HOST, state,
      mcpVersion: VERSION, mcpPid: process.pid, mcpGeneration: generation, mcpDiskVersion,
      mcpState: 'ready', restartRequired: mcpDiskVersion === null ? null : mcpDiskVersion !== VERSION,
      setup: where + '：' + state + '。目标页未授权且未开自动授权时，工具会报“该标签页尚未手动授权”。' }) }] };
  }
  const data = await bridgeRequest('/rpc', { port: PORT, host: HOST, token: TOKEN, body: { method: name.slice('browser_'.length), params: browserRequestParams(name, args) } });
  if (name === 'browser_snapshot' && args.format === 'compact') data.result = compactSnapshot(data.result);
  if (name === 'browser_batch') data.result.results.forEach((item, index) => {
    if (item.ok && args.commands[index].method === 'snapshot' && args.commands[index].params.format === 'compact') item.result = compactSnapshot(item.result);
  });
  if (name === 'browser_screenshot') {
    if (typeof data.result?.data !== 'string' || data.result.mimeType !== 'image/png') throw new Error('浏览器未返回有效 PNG 截图');
    return { content: [{ type: 'image', data: data.result.data, mimeType: 'image/png' }] };
  }
  if (name === 'browser_batch') {
    const content = [{ type: 'text', text: JSON.stringify(data.result.results.map((item, index) =>
      item.result?.mimeType === 'image/png' ? { index, ok: item.ok, screenshot: true, tabId: args.commands[index].params.tabId } : { index, ...item })) }];
    for (const item of data.result.results) if (item.result?.mimeType === 'image/png') content.push({ type: 'image', data: item.result.data, mimeType: 'image/png' });
    return { content };
  }
  return { content: [{ type: 'text', text: JSON.stringify(data.result) }] };
}

function announceReady() {
  if (!runtimeReady || !generation || readySent) return;
  readySent = true;
  send({ type: 'ready', version: VERSION, pid: process.pid, generation, serverName: SERVER_NAME, tools });
}

// 先监听父进程断连，保证产品依赖加载挂起时也能退出。
for (const signal of ['SIGTERM', 'SIGINT', 'disconnect']) process.on(signal, stop);
if (!process.send) throw new Error('MCP worker 必须由 stdio launcher 通过 fork IPC 启动');
if (!process.connected) stop();
process.on('message', message => {
  if (!message || stopping) return;
  if (message.type === 'shutdown') return stop();
  if (message.type === 'start' && !generation) {
    generation = message.generation;
    return announceReady();
  }
  if (!runtimeReady) return;
  if (message.type === 'activate' && generation) {
    if (!activated && isLoopbackAddress(HOST)) {
      supervisor = superviseBridge({
        ensure: () => ensureBridge(PORT, { host: HOST, token: TOKEN, configDir: CONFIG_DIR }),
        log: createLogger(CONFIG_DIR, { filename: 'supervisor.log', backups: 0 })
      });
    }
    activated = true;
    return send({ type: 'activated', generation, pid: process.pid });
  }
  if (message.type !== 'call' || !activated) return;
  void callTool(message.name, message.args).then(result => send({ type: 'result', id: message.id, result }), error => {
    const diagnostic = pageResultDiagnostic(error.diagnostic);
    const commandId = typeof error.commandId === 'string' && /^[a-zA-Z0-9-]{1,64}$/.test(error.commandId) ? error.commandId : undefined;
    // 有些宿主只展示text而隐藏structuredContent；固定安全证据也放入文字，确保可一次交接。
    const text = Object.keys(diagnostic).length ? error.message + '\n诊断：' + JSON.stringify({ code: error.code || 'BROWSER_ACTION_FAILED', ...(commandId ? { commandId } : {}), ...diagnostic }) : error.message;
    send({ type: 'result', id: message.id, result: { isError: true, content: [{ type: 'text', text }],
      structuredContent: { error: { code: error.code || 'BROWSER_ACTION_FAILED', message: error.message, outcome: error.outcome || 'unverified',
        ...(error.diagnostic && Object.keys(pageResultDiagnostic(error.diagnostic) || {}).length ? { diagnostic: pageResultDiagnostic(error.diagnostic) } : {}),
        ...(typeof error.commandId === 'string' && /^[a-zA-Z0-9-]{1,64}$/.test(error.commandId) ? { commandId: error.commandId } : {}) } } } });
  });
});

// 全新进程重新加载完整 ESM 依赖图；模块缓存不在 launcher 中保留。
const { ensureBridge, bridgeRequest, VERSION, bridgeDir, isLoopbackAddress } = await import('./bridge.mjs');
const { createLogger, pageResultDiagnostic } = await import('./diagnostics.mjs');
const { superviseBridge } = await import('./supervisor.mjs');
const { tools } = await import('./protocol.mjs');

const portIndex = process.argv.indexOf('--port');
const portValue = portIndex >= 0 ? Number(process.argv[portIndex + 1]) : NaN;
const PORT = Number.isInteger(portValue) && portValue > 0 && portValue < 65536 ? portValue : 17653;
const hostIndex = process.argv.indexOf('--host');
const HOST = hostIndex >= 0 ? process.argv[hostIndex + 1] : '127.0.0.1';
const tokenIndex = process.argv.indexOf('--token');
const TOKEN = tokenIndex >= 0 ? process.argv[tokenIndex + 1] : '';
const configIndex = process.argv.indexOf('--config-dir');
const CONFIG_DIR = configIndex >= 0 ? process.argv[configIndex + 1] : bridgeDir(PORT);
const SERVER_NAME = HOST === '127.0.0.1' ? 'ai-browser-' + PORT : 'ai-browser-' + HOST.replaceAll('.', '-') + '-' + PORT;
runtimeReady = true;
announceReady();
