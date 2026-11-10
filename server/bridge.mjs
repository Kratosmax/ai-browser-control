import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createLogger, diagnosticEvent, LOG_MAX_BYTES, LOG_BACKUPS } from './diagnostics.mjs';
import { validateCommand, METHODS } from './protocol.mjs';

export const DEFAULT_PORT = 17653;
export const SERVICE_NAME = 'ai-browser-control';
export const VERSION = JSON.parse(fs.readFileSync(new URL('../.zcode-plugin/plugin.json', import.meta.url), 'utf8')).version;
// 本地配置目录：扩展白名单、实例日志与远程访问 token。
export function defaultConfigDir() {
  return path.join(os.homedir(), '.zcode', SERVICE_NAME);
}

// 每个桥实例（按端口）一个配置目录：白名单互不共享，可多桥并存。
export function bridgeDir(port) {
  return path.join(defaultConfigDir(), String(port));
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
export const isLoopbackAddress = (address) => LOOPBACK.has(String(address ?? '').replace(/^::ffff:/, ''));

// 桥实例的访问凭据：远程（非本机回环）访问必须携带；本机回环豁免。
// token 持久化在实例目录 token 文件（0600）；删除该文件并重启桥即轮换。
function loadOrCreateToken(dir) {
  const file = path.join(dir, 'token');
  try {
    const stored = fs.readFileSync(file, 'utf8').trim();
    if (/^[a-f0-9]{64}$/.test(stored)) return stored;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const generated = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, `${generated}\n`, { mode: 0o600 });
  return generated;
}

export function loadAllowlist(configDir) {
  fs.mkdirSync(configDir, { recursive: true });
  try {
    const config = JSON.parse(fs.readFileSync(path.join(configDir, 'config.json'), 'utf8'));
    if (Array.isArray(config.allowedOrigins)) return config.allowedOrigins.filter(x => typeof x === 'string');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return [];
}

function saveAllowlist(configDir, origins) {
  const configFile = path.join(configDir, 'config.json');
  const temporaryFile = path.join(configDir, `config-${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporaryFile, JSON.stringify({ allowedOrigins: origins }, null, 2), { flag: 'wx', mode: 0o600 });
    try { fs.linkSync(temporaryFile, configFile); }
    catch (error) { if (error.code !== 'EEXIST') throw error; fs.writeFileSync(configFile, JSON.stringify({ allowedOrigins: origins }, null, 2), { mode: 0o600 }); }
  } finally {
    if (fs.existsSync(temporaryFile)) fs.unlinkSync(temporaryFile);
  }
}

const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;

function json(res, status, data) {
  if (res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function readJson(req, limit = 12 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export { validateCommand } from './protocol.mjs';

// 一键配对：扩展首次连接时把自身来源登记进白名单（TOFU，上限 8 个）。
// 该边界只隔离网页来源；本机进程的信任范围与旧 token 方案相同（token 文件它们本来就读得到）。
// 桥实例：host 默认只绑本机回环。跨机器访问时绑定网卡（--host 0.0.0.0 或局域网 IP），
// 此时远程请求必须携带 Bearer token，可选 allowedIps 限制来源 IP。
export function createBridge({ port = DEFAULT_PORT, host = '127.0.0.1', configDir = bridgeDir(port), token = loadOrCreateToken(configDir), allowedIps = [], commandTimeout = 12000, pollTimeout = 20000, maxOrigins = 8, staleAfterMs = 35000, rpcWaitWhenStaleMs = 25000 } = {}) {
  const pending = new Map();
  const queue = [];
  let poll = null;
  let lastSeen = 0;
  let lastClient = null;
  const extensionVersions = new Map();
  let allowedOrigins = loadAllowlist(configDir);
  const isAllowed = origin => typeof origin === 'string' && allowedOrigins.includes(origin);
  const log = createLogger(configDir);
  const deliver = () => {
    while (queue.length && !pending.has(queue[0].id)) queue.shift();
    if (!poll || !queue.length) return;
    const current = poll;
    poll = null;
    clearTimeout(current.timer);
    const command = queue.shift();
    log('command_deliver', { id: command.id, method: command.method, tabId: command.params?.tabId });
    json(current.res, 200, command);
  };
  const server = http.createServer(async (req, res) => {
    try {
      const origin = req.headers.origin;
      const route = ['/health', '/status', '/rpc', '/pair', '/unpair', '/poll', '/result', '/diagnostics'].includes(req.url) ? req.url : 'unknown';
      const client = /^[a-p]{32}$/.test(req.headers['x-client-id']) ? req.headers['x-client-id'] : undefined;
      const started = Date.now();
      if (!['/health', '/status', '/diagnostics'].includes(route)) log('request', { route, client });
      res.on('finish', () => {
        if (res.statusCode >= 400 || !['/health', '/status', '/diagnostics'].includes(route)) {
          log('response', { route, client, status: res.statusCode, durationMs: Date.now() - started });
        }
      });
      // 网页来源一律拒绝；浏览器会在 CORS 预检阶段拦截页面脚本请求。
      if (origin && !EXTENSION_ORIGIN.test(origin)) return json(res, 403, { error: '不接受网页来源的请求' });
      if (isAllowed(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
      }
      if (req.method === 'OPTIONS') {
        if (!isAllowed(origin)) return json(res, 403, { error: '来源未配对' });
        res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, X-Client-Id' });
        return res.end();
      }
      const clientId = req.headers['x-client-id'];
      // GET 请求（/poll）浏览器不携带 Origin；身份一致性只要求 Origin 存在时与
      // X-Client-Id 一致。网页伪造该头会先被 CORS 预检拦截。
      const identityMatches = typeof clientId === 'string' &&
        (!origin || clientId === origin.slice('chrome-extension://'.length));
      const clientMatches = identityMatches && allowedOrigins.includes(`chrome-extension://${clientId}`);
      if (req.url === '/health' && req.method === 'GET') return json(res, 200, { service: SERVICE_NAME, version: VERSION });
      // 跨机器访问防护：非回环来源必须持有效 token；configured allowedIps 时再限来源 IP。
      // 本机回环豁免（扩展与本地 agent 不受影响）。
      const sourceIp = String(req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
      if (!isLoopbackAddress(sourceIp) && host !== '127.0.0.1') {
        const provided = String(req.headers.authorization ?? '');
        const expected = `Bearer ${token}`;
        const tokenOk = provided.length === expected.length &&
          crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
        if (!tokenOk) return json(res, 401, { error: '远程访问需要有效 token：Authorization: Bearer <token>（token 在桥实例目录的 token 文件）' });
        if (allowedIps.length && !allowedIps.includes(sourceIp)) return json(res, 403, { error: `来源 IP ${sourceIp} 不在白名单` });
      }
      if (req.url === '/status' && req.method === 'GET') {
        if (origin && !isAllowed(origin)) return json(res, 403, { error: '来源未配对' });
        const lastSeenAgeMs = lastSeen ? Date.now() - lastSeen : null;
        return json(res, 200, {
          connected: lastSeen > 0 && lastSeenAgeMs < 90000,
          standby: lastSeen > 0 && lastSeenAgeMs >= staleAfterMs && lastSeenAgeMs < 90000,
          lastSeenAgeMs,
          lastSeen: lastSeen ? new Date(lastSeen).toISOString() : null,
          client: lastClient,
          pending: pending.size,
          allowedOrigins: allowedOrigins.length,
          version: VERSION,
          bridgeMethods: METHODS,
          extensionVersion: extensionVersions.get(lastClient) ?? null,
          diagnostics: { fileMaxBytes: LOG_MAX_BYTES, fileCount: LOG_BACKUPS + 1 }
        });
      }
      // /rpc 面向本地 MCP 客户端（无 Origin）和已配对扩展；其余接口仅限扩展。
      if (req.url === '/rpc' && req.method === 'POST') {
        if (origin && !isAllowed(origin)) return json(res, 403, { error: '来源未配对' });
        const { method, params } = await readJson(req);
        validateCommand(method, params);
        const lastSeenAgeMs = lastSeen ? Date.now() - lastSeen : null;
        // 从未连接：立即报错并给出指引。曾连接但现在待机（浏览器后台挂起）：
        // 挂住请求等待扩展醒来执行，而不是直接拒绝——待机窗口最长可到约 1 分钟。
        if (lastSeen === 0) return json(res, 503, { error: '浏览器扩展尚未连接。在本机上打开浏览器里的 AI Browser Control 扩展弹窗即可自动连接；本机桥未启动时会由 AI 工具调用自动拉起。' });
        const stale = lastSeenAgeMs >= staleAfterMs;
        if (pending.size >= 20) return json(res, 429, { error: '待处理指令过多' });
        const id = crypto.randomUUID();
        const item = { res, timer: null, stale, method, started: Date.now() };
        log('command_queued', { id, method, tabId: params?.tabId, stale });
        pending.set(id, item);
        item.timer = setTimeout(() => {
          pending.delete(id);
          log('command_timeout', { id, method, durationMs: Date.now() - item.started });
          json(res, stale ? 504 : 504, { error: stale
            ? '扩展待机中（浏览器后台挂起），唤醒超时。点一下浏览器里的 AI Browser Control 扩展图标即可立即唤醒，然后重试。'
            : '浏览器指令超时；操作结果不确定，请读取快照确认，勿直接重复提交。' });
        }, stale ? rpcWaitWhenStaleMs : commandTimeout);
        res.on('close', () => {
          if (pending.has(id) && !res.writableEnded) log('command_client_closed', { id, method, durationMs: Date.now() - item.started });
          clearTimeout(item.timer); pending.delete(id);
        });
        queue.push({ id, method, params });
        deliver();
        return;
      }
      if (!identityMatches) return json(res, 403, { error: '缺少有效的扩展来源标识' });
      if (req.url === '/pair' && req.method === 'POST') {
        if (isAllowed(origin)) return json(res, 200, { paired: true, already: true });
        if (allowedOrigins.length >= maxOrigins) return json(res, 409, { error: `白名单已满（${maxOrigins}）。关闭本机桥后删除 ${path.join(configDir, 'config.json')} 即可重置。` });
        allowedOrigins.push(origin);
        saveAllowlist(configDir, allowedOrigins);
        return json(res, 200, { paired: true });
      }
      if (req.url === '/unpair' && req.method === 'POST') {
        allowedOrigins = allowedOrigins.filter(item => item !== origin);
        saveAllowlist(configDir, allowedOrigins);
        if (lastClient === `chrome-extension://${clientId}`) {
          lastSeen = 0;
          lastClient = null;
          if (poll) { clearTimeout(poll.timer); poll.res.writeHead(204); poll.res.end(); poll = null; }
        }
        extensionVersions.delete(`chrome-extension://${clientId}`);
        return json(res, 200, { unpaired: true });
      }
      if (!clientMatches) return json(res, 403, { error: '来源未配对；请打开扩展弹窗重新连接' });
      if (req.url === '/diagnostics' && req.method === 'POST') {
        const data = await readJson(req, 64 * 1024);
        if (!Array.isArray(data.events) || data.events.length > 128) return json(res, 400, { error: '诊断批次无效' });
        for (const value of data.events) {
          const diagnostic = diagnosticEvent(value);
          if (!diagnostic) continue;
          log('extension_event', { client: clientId, diagnostic });
          if (diagnostic.version) extensionVersions.set(`chrome-extension://${clientId}`, diagnostic.version);
        }
        return json(res, 200, { ok: true });
      }
      if (req.url === '/poll' && req.method === 'GET') {
        if (poll) return json(res, 409, { error: '已有扩展连接正在等待；请只在一个浏览器配置文件中启用本扩展' });
        lastSeen = Date.now();
        lastClient = origin ?? `chrome-extension://${clientId}`;
        const current = { res, timer: null };
        poll = current;
        current.timer = setTimeout(() => { if (poll === current) poll = null; res.writeHead(204); res.end(); }, pollTimeout);
        res.on('close', () => { clearTimeout(current.timer); if (poll === current) poll = null; });
        deliver();
        return;
      }
      if (req.url === '/result' && req.method === 'POST') {
        const data = await readJson(req);
        const item = pending.get(data.id);
        if (!item) return json(res, 404, { error: '指令已过期或不存在' });
        log('command_result', { id: data.id, method: item.method, outcome: data.error ? 'error' : 'ok', durationMs: Date.now() - item.started });
        pending.delete(data.id);
        clearTimeout(item.timer);
        if (data.error) json(item.res, 502, { error: String(data.error.message ?? data.error), code: /^[A-Z_]{1,50}$/.test(data.error.code) ? data.error.code : 'BROWSER_ACTION_FAILED', outcome: 'unverified' });
        else json(item.res, 200, { result: data.result });
        return json(res, 200, { ok: true });
      }
      return json(res, 404, { error: '接口不存在' });
    } catch (error) {
      json(res, 400, { error: error.message, code: error.code || 'INVALID_ARGUMENTS' });
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  return {
    server,
    async start() {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
      log('bridge_start', { version: VERSION, pid: process.pid, port: server.address().port });
      return server.address().port;
    },
    async close() {
      log('bridge_stop', { pending: pending.size });
      if (poll) { clearTimeout(poll.timer); poll.res.end(); poll = null; }
      for (const item of pending.values()) { clearTimeout(item.timer); json(item.res, 503, { error: '本机桥已关闭' }); }
      pending.clear();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  };
}

export async function bridgeRequest(route, { port = DEFAULT_PORT, host = '127.0.0.1', token = '', body, timeout = 15000 } = {}) {
  const response = await fetch(`http://${host}:${port}${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout)
  });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error ?? `本机桥 HTTP ${response.status}`), { code: data.code || `BRIDGE_HTTP_${response.status}`, outcome: data.outcome });
  return data;
}

const ensuring = new Map();
export function ensureBridge(port = DEFAULT_PORT, options = {}) {
  const key = `${options.host ?? '127.0.0.1'}:${port}`;
  if (ensuring.has(key)) return ensuring.get(key);
  const work = ensureBridgeOnce(port, options).finally(() => { if (ensuring.get(key) === work) ensuring.delete(key); });
  ensuring.set(key, work);
  return work;
}

async function ensureBridgeOnce(port, { host = '127.0.0.1', token = '' } = {}) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const healthy = async () => {
    try {
      const response = await fetch(`http://${host}:${port}/health`, { headers, signal: AbortSignal.timeout(1500) });
      const health = await response.json();
      if (health.service !== SERVICE_NAME) throw new Error(`${host}:${port} 已被其他服务占用`);
      return true;
    } catch (error) {
      if (String(error.message).includes('占用')) throw error;
      return false;
    }
  };
  if (await healthy()) return;
  if (!isLoopbackAddress(host)) {
    throw new Error(`远端桥 ${host}:${port} 不可达或凭据不符。请在浏览器所在机器上启动：node server/bridge.mjs --bridge --port ${port} --host <网卡IP>；并核对 agent 配置里的 token 与防火墙设置。远端桥不会被本进程代拉。`);
  }
  const dir = bridgeDir(port);
  fs.mkdirSync(dir, { recursive: true });
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--bridge', '--port', String(port)], { detached: true, windowsHide: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    try { await bridgeRequest('/status', { port, timeout: 500 }); return { launched: true, pid: child.pid }; } catch {}
  }
  throw new Error(`本机桥启动失败，请检查 ${path.join(dir, 'bridge.log')}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    if (process.argv.includes('--bridge')) {
      const value = (name) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
      const portIndex = process.argv.indexOf('--port');
      const portValue = portIndex >= 0 ? Number(process.argv[portIndex + 1]) : DEFAULT_PORT;
      const port = Number.isInteger(portValue) && portValue > 0 && portValue < 65536 ? portValue : DEFAULT_PORT;
      const host = value('host') ?? '127.0.0.1';
      const allowedIps = process.argv.flatMap((a, i) => a === '--allow-ip' && process.argv[i + 1] ? [process.argv[i + 1]] : []);
      const bridge = createBridge({ port, host, allowedIps });
      await bridge.start();
      const exposed = host === '127.0.0.1' ? '仅本机' : `已对 ${host} 开放（远程访问必须携带 token）`;
      if (process.stdout.isTTY) {
        console.log(`AI Browser Control ${VERSION} 本机桥监听 ${host}:${port}，PID ${process.pid}（${exposed}）`);
        if (host !== '127.0.0.1') console.log(`远程凭据已保存到实例目录；运行 node install.mjs bridge token ${port} 查看。`);
        if (allowedIps.length) console.log(`远程来源白名单：${allowedIps.join(', ')}`);
        console.log('保持此窗口开启；关闭窗口即停止服务。');
      }
      for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => { await bridge.close(); process.exit(0); });
    } else if (process.argv.includes('--status')) {
      const portIndex = process.argv.indexOf('--port');
      const port = portIndex >= 0 ? Number(process.argv[portIndex + 1]) : DEFAULT_PORT;
      console.log(JSON.stringify(await bridgeRequest('/status', { port, timeout: 1500 }), null, 2));
    } else {
      console.log('用法：--bridge [--port N] 启动本机桥 | --status [--port N] 查看状态。通常无需手动运行；AI 工具调用会自动拉起。');
    }
  } catch (error) {
    if (process.argv.includes('--bridge')) {
      const index = process.argv.indexOf('--port');
      const value = Number(process.argv[index + 1]);
      const port = index >= 0 && Number.isInteger(value) && value > 0 && value < 65536 ? value : DEFAULT_PORT;
      createLogger(bridgeDir(port))('bridge_start_failed', { version: VERSION, code: /^[A-Z0-9_]{1,40}$/.test(error.code) ? error.code : 'UNKNOWN' });
    }
    if (!process.argv.includes('--bridge') || process.stderr.isTTY) console.error(error.message);
    process.exitCode = 1;
  }
}
