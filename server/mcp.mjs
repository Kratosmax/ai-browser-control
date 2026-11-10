import readline from 'node:readline';
import { ensureBridge, bridgeRequest, VERSION } from './bridge.mjs';
import { bridgeDir, isLoopbackAddress } from './bridge.mjs';
import { createLogger } from './diagnostics.mjs';
import { superviseBridge } from './supervisor.mjs';

// 每个桥实例对应一个 MCP 进程实例：
//   本机：node mcp.mjs [--port 17653]
//   跨机器：node mcp.mjs --host <浏览器机器IP> --port <桥端口> --token <桥token>
const portIndex = process.argv.indexOf('--port');
const portValue = portIndex >= 0 ? Number(process.argv[portIndex + 1]) : NaN;
const PORT = Number.isInteger(portValue) && portValue > 0 && portValue < 65536 ? portValue : 17653;
const hostIndex = process.argv.indexOf('--host');
const HOST = hostIndex >= 0 ? process.argv[hostIndex + 1] : '127.0.0.1';
const tokenIndex = process.argv.indexOf('--token');
const TOKEN = tokenIndex >= 0 ? process.argv[tokenIndex + 1] : '';
const SERVER_NAME = HOST === '127.0.0.1' ? `ai-browser-${PORT}` : `ai-browser-${HOST.replaceAll('.', '-')}-${PORT}`;
const supervisor = isLoopbackAddress(HOST) ? superviseBridge({
  ensure: () => ensureBridge(PORT, { host: HOST, token: TOKEN }),
  // 固定有界文件，不按PID增加文件；日志失败不影响监督。
  log: createLogger(bridgeDir(PORT), { filename: 'supervisor.log', backups: 0 })
}) : null;

export { tools } from './protocol.mjs';
import { tools } from './protocol.mjs';

async function callTool(name, args) {
  if (!tools.some(tool => tool.name === name)) throw new Error(`未知工具：${name}`);
  await ensureBridge(PORT, { host: HOST, token: TOKEN });
  if (name === 'browser_status') {
    const status = await bridgeRequest('/status', { port: PORT, host: HOST, token: TOKEN });
    const where = HOST === '127.0.0.1' ? `桥端口 ${PORT}` : `远端桥 ${HOST}:${PORT}`;
    let state;
    if (!status.connected) state = '扩展命令通道未连接（桥可达，但尚未收到近期轮询）';
    else if (status.standby) state = '扩展命令通道暂未响应，等待自动重连；可打开扩展弹窗检查连接状态';
    else state = '已连接';
    return { content: [{ type: 'text', text: JSON.stringify({ ...status, port: PORT, host: HOST, state, setup: `${where}：${state}。目标页未授权且未开自动授权时，工具会报“该标签页尚未手动授权”。` }) }] };
  }
  const data = await bridgeRequest('/rpc', { port: PORT, host: HOST, token: TOKEN, body: { method: name.slice('browser_'.length), params: args } });
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

async function handle(message) {
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return;
  if (!Object.hasOwn(message, 'id')) return;
  const reply = result => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`);
  const error = (code, text) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code, message: text } })}\n`);
  if (message.method === 'initialize') return reply({ protocolVersion: ['2024-11-05', '2025-03-26', '2025-06-18'].includes(message.params?.protocolVersion) ? message.params.protocolVersion : '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: SERVER_NAME, version: VERSION } });
  if (message.method === 'ping') return reply({});
  if (message.method === 'tools/list') return reply({ tools });
  if (message.method === 'tools/call') {
    try { return reply(await callTool(message.params?.name, message.params?.arguments ?? {})); }
    catch (err) { return reply({ isError: true, content: [{ type: 'text', text: err.message }], structuredContent: { error: { code: err.code || 'BROWSER_ACTION_FAILED', message: err.message, outcome: err.outcome || 'unverified' } } }); }
  }
  error(-32601, 'Method not found');
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('close', () => supervisor?.stop());
input.on('line', line => {
  if (!line.trim()) return;
  try { void handle(JSON.parse(line)).catch(error => console.error(error.message)); }
  catch { process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`); }
});
