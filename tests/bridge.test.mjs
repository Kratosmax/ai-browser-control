import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBridge, validateCommand } from '../server/bridge.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const EXT_A = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const EXT_B = 'chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const ID_A = EXT_A.slice('chrome-extension://'.length);
const ID_B = EXT_B.slice('chrome-extension://'.length);
const headers = origin => ({ Origin: origin, 'X-Client-Id': origin.slice('chrome-extension://'.length), 'Content-Type': 'application/json' });

test('一键配对白名单：网页拒绝、首连登记、占用互斥、可解除', async () => {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zcode-bridge-test-'));
  const bridge = createBridge({ port: 0, configDir, commandTimeout: 1000, pollTimeout: 200 });
  const port = await bridge.start();
  const base = `http://127.0.0.1:${port}`;
  const post = (route, { headers: heads, body } = {}) => fetch(base + route, { method: 'POST', headers: heads, body: body === undefined ? '{}' : JSON.stringify(body) });
  try {
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await fetch(`${base}/status`, { headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await fetch(`${base}/status`, { headers: { Origin: EXT_A } })).status, 403);
    // 本地 MCP 无扩展时明确报错而非挂起
    const noExtension = await post('/rpc', { body: { method: 'list_tabs' } });
    assert.equal(noExtension.status, 503);
    assert.match((await noExtension.json()).error, /扩展/);
    // 未配对扩展不能 poll；/pair 后放行
    assert.equal((await fetch(`${base}/poll`, { headers: headers(EXT_A) })).status, 403);
    assert.equal((await post('/pair', { headers: headers(EXT_A) })).status, 200);
    assert.equal((await post('/pair', { headers: headers(EXT_A) })).status, 200);
    // 请求头与来源不一致时拒绝，防止伪造客户端 ID
    const forged = await fetch(`${base}/poll`, { headers: { Origin: EXT_A, 'X-Client-Id': ID_B } });
    assert.equal(forged.status, 403);
    // 扩展上线后本地 /rpc 收到指令，/result 回传需要同一扩展身份
    const polling = fetch(`${base}/poll`, { headers: headers(EXT_A) });
    await new Promise(resolve => setTimeout(resolve, 30));
    const rpc = post('/rpc', { body: { method: 'snapshot', params: { tabId: 42 } } });
    const command = await (await polling).json();
    assert.equal(command.method, 'snapshot');
    assert.deepEqual(command.params, { tabId: 42 });
    assert.equal((await fetch(`${base}/result`, { method: 'POST', headers: { ...headers(EXT_B), 'Content-Type': 'application/json' }, body: JSON.stringify({ id: command.id, result: {} }) })).status, 403);
    assert.equal((await fetch(`${base}/result`, { method: 'POST', headers: headers(EXT_A), body: JSON.stringify({ id: command.id, result: { title: 'Magpie 测试' } }) })).status, 200);
    assert.equal((await (await rpc).json()).result.title, 'Magpie 测试');
    // 多个 AI Agent 的扩展可同时配对；同一时刻只允许一个扩展在 poll
    assert.equal((await post('/pair', { headers: headers(EXT_B) })).status, 200);
    const pollA = fetch(`${base}/poll`, { headers: headers(EXT_A) });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal((await fetch(`${base}/poll`, { headers: headers(EXT_B) })).status, 409);
    assert.equal((await pollA).status, 204);
    // 解除配对后恢复拒绝
    assert.equal((await post('/unpair', { headers: headers(EXT_A) })).status, 200);
    assert.equal((await fetch(`${base}/poll`, { headers: headers(EXT_A) })).status, 403);
  } finally { await bridge.close(); await fs.rm(configDir, { recursive: true, force: true }); }
});

test('白名单持久化：重启桥后已配对扩展直接可用', async () => {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zcode-bridge-test-'));
  const first = createBridge({ port: 0, configDir, pollTimeout: 100 });
  const firstPort = await first.start();
  await fetch(`http://127.0.0.1:${firstPort}/pair`, { method: 'POST', headers: headers(EXT_A) });
  await first.close();
  const second = createBridge({ port: 0, configDir, pollTimeout: 100 });
  const secondPort = await second.start();
  try {
    assert.equal((await fetch(`http://127.0.0.1:${secondPort}/status`, { headers: { Origin: EXT_A } })).status, 200);
  } finally { await second.close(); await fs.rm(configDir, { recursive: true, force: true }); }
});

test('多桥实例配置隔离：各桥白名单互不影响', async () => {
  const dir1 = await fs.mkdtemp(path.join(os.tmpdir(), 'zcode-iso-1-'));
  const dir2 = await fs.mkdtemp(path.join(os.tmpdir(), 'zcode-iso-2-'));
  const b1 = createBridge({ port: 0, configDir: dir1, pollTimeout: 150 });
  const b2 = createBridge({ port: 0, configDir: dir2, pollTimeout: 150 });
  const p1 = await b1.start();
  const p2 = await b2.start();
  try {
    assert.equal((await fetch(`http://127.0.0.1:${p1}/pair`, { method: 'POST', headers: headers(EXT_A) })).status, 200);
    // 同一扩展在桥 1 已配对，在桥 2 仍是陌生来源
    assert.equal((await fetch(`http://127.0.0.1:${p2}/status`, { headers: { Origin: EXT_A } })).status, 403);
    const poll = fetch(`http://127.0.0.1:${p1}/poll`, { headers: headers(EXT_A) });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal((await poll).status, 204);
  } finally { await b1.close(); await b2.close(); await fs.rm(dir1, { recursive: true, force: true }); await fs.rm(dir2, { recursive: true, force: true }); }
});

test('跨机器防护：非回环来源必须 token，支持 IP 白名单；本机豁免', async (t) => {
  const lanIp = Object.values(os.networkInterfaces()).flat()
    .find(i => i && i.family === 'IPv4' && !i.internal)?.address;
  if (!lanIp) return t.skip('本机无局域网 IPv4，跳过跨机器防护测试');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zcode-remote-'));
  const dir2 = await fs.mkdtemp(path.join(os.tmpdir(), 'zcode-remote-ip-'));
  const bridge = createBridge({ port: 0, host: '0.0.0.0', configDir: dir });
  const port = await bridge.start();
  const strict = createBridge({ port: 0, host: '0.0.0.0', configDir: dir2, allowedIps: ['203.0.113.9'] });
  const port2 = await strict.start();
  const lan = (route, headers = {}) => fetch(`http://${lanIp}:${port}${route}`, { headers });
  try {
    assert.equal((await fetch(`http://${lanIp}:${port}/health`)).status, 200, 'health 保持开放');
    assert.equal((await lan('/status')).status, 401, '无 token 拒绝');
    assert.equal((await lan('/status', { Authorization: 'Bearer wrong' })).status, 401, '错 token 拒绝');
    const token = (await fs.readFile(path.join(dir, 'token'), 'utf8')).trim();
    assert.match(token, /^[a-f0-9]{64}$/);
    assert.equal((await lan('/status', { Authorization: `Bearer ${token}` })).status, 200, '正确 token 放行');
    assert.equal((await fetch(`http://127.0.0.1:${port}/status`)).status, 200, '本机回环豁免 token');

    const strictToken = (await fs.readFile(path.join(dir2, 'token'), 'utf8')).trim();
    const strictFetch = (route, headers = {}) => fetch(`http://${lanIp}:${port2}${route}`, { headers });
    assert.equal((await strictFetch('/status', { Authorization: `Bearer ${strictToken}` })).status, 403, '不在 IP 白名单拒绝');
    assert.equal((await strictFetch('/status', { Authorization: `Bearer ${strictToken}`, 'x-forwarded-for': '203.0.113.9' })).status, 403, '伪造头不生效（按 socket 地址判定）');
  } finally {
    await bridge.close(); await strict.close();
    await fs.rm(dir, { recursive: true, force: true }); await fs.rm(dir2, { recursive: true, force: true });
  }
});

test('扩展待机时 /rpc 等待唤醒（不立即拒绝），超时给出可操作提示', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zcode-standby-'));
  const bridge = createBridge({ port: 0, configDir: dir, commandTimeout: 1000, pollTimeout: 150, staleAfterMs: 300, rpcWaitWhenStaleMs: 800 });
  const port = await bridge.start();
  const base = 'http://127.0.0.1:' + port;
  const heads = headers(EXT_A);
  try {
    assert.equal((await fetch(base+'/pair', { method: 'POST', headers: heads })).status, 200);
    const poll1 = await fetch(base+'/poll', { headers: heads });
    assert.equal(poll1.status, 204);
    await new Promise(resolve => setTimeout(resolve, 350));
    const started = Date.now();
    const rpc = await fetch(base+'/rpc', { method: 'POST', headers: { ...heads, 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'list_tabs' }) });
    const elapsed = Date.now() - started;
    assert.equal(rpc.status, 504);
    assert.match((await rpc.json()).error, /待机.*扩展图标/);
    assert.ok(elapsed >= 700, '应等待扩展唤醒而不是立即拒绝');
    const poll2 = fetch(base+'/poll', { headers: heads });
    await new Promise(resolve => setTimeout(resolve, 30));
    const rpc2 = fetch(base+'/rpc', { method: 'POST', headers: { ...heads, 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'list_tabs' }) });
    const command = await (await poll2).json();
    await fetch(base+'/result', { method: 'POST', headers: heads, body: JSON.stringify({ id: command.id, result: { tabs: [] } }) });
    assert.equal((await rpc2).status, 200);
  } finally { await bridge.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('桥接验证标签页 ID、ref、协议和参数白名单', () => {
  for (const [method, params] of [
    ['snapshot', { tabId: -1 }], ['snapshot', { tabId: '42' }],
    ['click', { tabId: 1, ref: '#guess' }], ['fill', { tabId: 1, ref: 'r1-0', text: 5 }],
    ['navigate', { tabId: 1, url: 'file:///C:/secret' }],
    ['press', { tabId: 1, key: 'F12' }], ['list_tabs', { unexpected: 1 }]
  ]) assert.throws(() => validateCommand(method, params));
  assert.deepEqual(validateCommand('click', { tabId: 42, ref: 'r1-3' }), { method: 'click', params: { tabId: 42, ref: 'r1-3' } });
});

test('MCP stdio 握手、工具目录和错误响应', async () => {
  const child = spawn(process.execPath, [path.join(root, 'server', 'mcp.mjs')], { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  let stderr = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'not_a_tool' } },
    { jsonrpc: '2.0', id: 4, method: 'unknown' }
  ];
  const exited = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  child.stdin.end(requests.map(x => JSON.stringify(x)).join('\n') + '\n');
  assert.equal(await exited, 0);
  assert.equal(stderr, '');
  const replies = output.trim().split('\n').map(x => JSON.parse(x));
  assert.equal(replies.length, 4);
  assert.equal(replies.find(x => x.id === 1).result.serverInfo.name, 'ai-browser-17653');
  const tools = replies.find(x => x.id === 2).result.tools;
  assert.equal(tools.length, 9);
  assert.equal(new Set(tools.map(x => x.name)).size, 9);
  assert.equal(replies.find(x => x.id === 3).result.isError, true);
  assert.equal(replies.find(x => x.id === 4).error.code, -32601);
});

test('插件清单、市场、图标指向同一版本及实际资源', async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(root, '.zcode-plugin', 'plugin.json'), 'utf8'));
  const catalog = JSON.parse(await fs.readFile(path.join(root, '..', 'marketplace.json'), 'utf8'));
  assert.equal(manifest.name, 'ai-browser-control');
  const listing = catalog.plugins.find(x => x.name === manifest.name);
  assert.equal(listing.version, manifest.version);
  assert.equal(catalog.name, 'dev-ai-browser-local');
  assert.equal(path.resolve(root, '..', listing.source), root);
  const mcp = JSON.parse(await fs.readFile(path.join(root, manifest.mcpServers), 'utf8'));
  assert.ok(mcp.mcpServers['ai-browser'].args[0].includes('${CLAUDE_PLUGIN_ROOT}'));
  await fs.access(mcp.mcpServers['ai-browser'].command);
  const extension = JSON.parse(await fs.readFile(path.join(root, 'extension', 'manifest.json'), 'utf8'));
  assert.equal(extension.name, 'AI Browser Control');
  assert.equal(extension.version, '0.6.1');
  for (const file of Object.values(extension.icons)) await fs.access(path.join(root, 'extension', file));
  await fs.access(path.join(root, manifest.skills, 'ai-browser-control', 'SKILL.md'));
});
