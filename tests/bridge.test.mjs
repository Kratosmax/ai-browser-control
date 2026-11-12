import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bridgeRequest, createBridge, validateCommand } from '../server/bridge.mjs';

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

test('断开立即清除本客户端心跳与poll，不影响另一客户端', async () => {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-browser-unpair-'));
  const bridge = createBridge({ port: 0, configDir, pollTimeout: 10000 });
  const port = await bridge.start(), base = `http://127.0.0.1:${port}`;
  const post = (route, client) => fetch(base + route, { method: 'POST', headers: headers(client), body: '{}' });
  try {
    await post('/pair', EXT_A); await post('/pair', EXT_B);
    const polling = fetch(base + '/poll', { headers: headers(EXT_A) });
    await new Promise(done => setTimeout(done, 30));
    await post('/unpair', EXT_B);
    assert.equal((await (await fetch(base + '/status')).json()).connected, true);
    await post('/unpair', EXT_A);
    assert.equal((await polling).status, 204);
    const state = await (await fetch(base + '/status')).json();
    assert.equal(state.connected, false);
    assert.equal(state.client, null);
    await post('/pair', EXT_A);
    assert.equal((await (await fetch(base + '/status')).json()).connected, false, '只有pair不能称命令通道连通');
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

// 所有反例仅使用临时目录和随机回环端口；不连接真实扩展。
async function isolatedBridge(t, options = {}) {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-browser-lease-'));
  const bridge = createBridge({ port: 0, configDir, commandTimeout: 1500, pollTimeout: 1000, ...options });
  const port = await bridge.start();
  t.after(async () => { await bridge.close(); await fs.rm(configDir, { recursive: true, force: true }); });
  const get = (route, client) => fetch('http://127.0.0.1:' + port + route, { headers: client ? headers(client) : {} });
  const post = (route, client, body = {}) => fetch('http://127.0.0.1:' + port + route, {
    method: 'POST', headers: client ? headers(client) : { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  const state = async () => (await get('/status')).json();
  const waitFor = async predicate => {
    const deadline = Date.now() + 1000;
    while (!predicate(await state())) {
      assert.ok(Date.now() < deadline, '隔离桥未达到预期状态');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  };
  await post('/pair', EXT_A); await post('/pair', EXT_B);
  return { port, get, post, state, waitFor, rpc: () => post('/rpc', null, { method: 'snapshot', params: { tabId: 42 } }) };
}

test('活跃租约覆盖轮询间隙；到期切换拒绝原客户端排队命令且不重放', async t => {
  const { get, post, state, waitFor, rpc } = await isolatedBridge(t, { leaseMs: 150, staleAfterMs: 50, pollTimeout: 30 });
  assert.equal((await get('/poll', EXT_A)).status, 204);
  assert.equal((await get('/poll', EXT_B)).status, 409, '空闲poll返回后仍由A持有租约');
  assert.equal((await state()).client, EXT_A);
  await new Promise(resolve => setTimeout(resolve, 160));
  const oldRpc = rpc();
  await waitFor(s => s.pending === 1);
  assert.equal((await get('/poll', EXT_B)).status, 204, '旧租约到期后B可接管，但不能获得A的排队命令');
  assert.equal((await oldRpc).status, 503);
  assert.equal((await state()).client, EXT_B);
  const polling = get('/poll', EXT_B);
  const nextRpc = rpc();
  const command = await (await polling).json();
  await post('/result', EXT_B, { id: command.id, result: { owner: 'B' } });
  assert.deepEqual((await (await nextRpc).json()).result, { owner: 'B' });
});

test('A执行时B不能抢占或冒领结果；租约到期仍保护执行中recipient', async t => {
  const { get, post, state, waitFor, rpc } = await isolatedBridge(t, { leaseMs: 50 });
  const polling = get('/poll', EXT_A);
  await waitFor(s => s.client === EXT_A);
  const firstRpc = rpc();
  const first = await (await polling).json();
  await new Promise(resolve => setTimeout(resolve, 70));
  assert.equal((await get('/poll', EXT_B)).status, 409);
  assert.equal((await post('/result', EXT_B, { id: first.id, result: { owner: 'wrong' } })).status, 403);
  const secondRpc = rpc();
  await waitFor(s => s.pending === 2);
  assert.equal((await get('/poll', EXT_B)).status, 409);
  assert.equal((await state()).client, EXT_A);
  assert.equal((await post('/result', EXT_A, { id: first.id, result: { owner: 'A' } })).status, 200);
  assert.deepEqual((await (await firstRpc).json()).result, { owner: 'A' });
  const second = await (await get('/poll', EXT_A)).json();
  assert.notEqual(second.id, first.id);
  await post('/result', EXT_A, { id: second.id, result: { owner: 'A-again' } });
  assert.deepEqual((await (await secondRpc).json()).result, { owner: 'A-again' });
});

test('解除配对取消已派发和排队RPC；旧结果在重配对及B接管后不混淆', async t => {
  const { get, post, state, waitFor, rpc } = await isolatedBridge(t);
  const polling = get('/poll', EXT_A);
  await waitFor(s => s.client === EXT_A);
  const oldRpc = rpc();
  const oldCommand = await (await polling).json();
  const queuedRpc = rpc();
  await waitFor(s => s.pending === 2);
  await post('/unpair', EXT_B);
  assert.equal((await state()).pending, 2, '非活跃扩展解除不影响A');
  await post('/unpair', EXT_A);
  assert.equal((await oldRpc).status, 503);
  assert.equal((await queuedRpc).status, 503);
  assert.equal((await state()).connected, false);
  await post('/pair', EXT_B);
  const pollB = get('/poll', EXT_B);
  await waitFor(s => s.client === EXT_B);
  const newRpc = rpc();
  const newCommand = await (await pollB).json();
  await post('/pair', EXT_A);
  assert.equal((await post('/result', EXT_A, { id: oldCommand.id, result: { owner: 'old-A' } })).status, 404);
  assert.equal((await post('/result', EXT_A, { id: newCommand.id, result: { owner: 'wrong-A' } })).status, 403);
  assert.equal((await state()).client, EXT_B);
  await post('/result', EXT_B, { id: newCommand.id, result: { owner: 'new-B' } });
  assert.deepEqual((await (await newRpc).json()).result, { owner: 'new-B' });
});

test('待机租约保留原扩展恢复机会，B不能接走等待唤醒的RPC', async t => {
  const { get, post, state, waitFor, rpc } = await isolatedBridge(t, { pollTimeout: 30, staleAfterMs: 10 });
  assert.equal((await get('/poll', EXT_A)).status, 204);
  assert.equal((await state()).standby, true);
  const waitingRpc = rpc();
  await waitFor(s => s.pending === 1);
  assert.equal((await get('/poll', EXT_B)).status, 409);
  const command = await (await get('/poll', EXT_A)).json();
  await post('/result', EXT_A, { id: command.id, result: { resumed: true } });
  assert.deepEqual((await (await waitingRpc).json()).result, { resumed: true });
});

test('已派发RPC超时后不重放；租约切换后迟到的A结果不能污染B', async t => {
  const { get, post, state, waitFor, rpc } = await isolatedBridge(t, { commandTimeout: 100, leaseMs: 50 });
  const polling = get('/poll', EXT_A);
  await waitFor(s => s.client === EXT_A);
  const expiredRpc = rpc();
  const expired = await (await polling).json();
  assert.equal((await expiredRpc).status, 504);
  assert.equal((await state()).pending, 0);
  const pollB = get('/poll', EXT_B);
  await waitFor(s => s.client === EXT_B);
  const currentRpc = rpc();
  const current = await (await pollB).json();
  assert.notEqual(current.id, expired.id);
  assert.equal((await post('/result', EXT_A, { id: expired.id, result: { stale: true } })).status, 404);
  assert.equal((await state()).client, EXT_B);
  await post('/result', EXT_B, { id: current.id, result: { current: true } });
  assert.deepEqual((await (await currentRpc).json()).result, { current: true });
});

test('待机命令已派发后超时必须报告结果不确定，不能提示重试提交', async t => {
  const { get, post, waitFor, rpc } = await isolatedBridge(t, { staleAfterMs: 1, pollTimeout: 30, rpcWaitWhenStaleMs: 250 });
  assert.equal((await get('/poll', EXT_A)).status, 204);
  const waiting = rpc();
  await waitFor(s => s.pending === 1);
  const command = await (await get('/poll', EXT_A)).json();
  const response = await waiting;
  assert.equal(response.status, 504);
  const data = await response.json();
  assert.equal(data.code, 'COMMAND_TIMEOUT');
  assert.equal(data.commandId, command.id);
  assert.equal(data.outcome, 'unverified');
  assert.match(data.error, /勿直接重复提交/);
  assert.doesNotMatch(data.error, /唤醒.*重试/);
  assert.equal((await post('/result', EXT_A, { id: command.id, result: {} })).status, 404);
});

test('默认bridgeRequest在15秒后仍等待待机扩展恢复，且不重放命令', { timeout: 30000 }, async t => {
  const { port, get, post, waitFor } = await isolatedBridge(t, { staleAfterMs: 10, pollTimeout: 30 });
  assert.equal((await get('/poll', EXT_A)).status, 204);
  await new Promise(resolve => setTimeout(resolve, 20));
  const started = Date.now();
  const result = bridgeRequest('/rpc', { port, body: { method: 'list_tabs' } });
  await waitFor(s => s.pending === 1);
  await new Promise(resolve => setTimeout(resolve, 16000));
  const command = await (await get('/poll', EXT_A)).json();
  await post('/result', EXT_A, { id: command.id, result: { tabs: [] } });
  assert.deepEqual(await result, { result: { tabs: [] } });
  assert.ok(Date.now() - started >= 16000);
  assert.equal((await get('/poll', EXT_A)).status, 204, '已完成命令不会重新派发');
});

test('桥接验证标签页 ID、ref、协议和参数白名单', () => {
  for (const [method, params] of [
    ['snapshot', { tabId: -1 }], ['snapshot', { tabId: '42' }], ['snapshot', { tabId: 1, load: 'forever' }],
    ['scroll', { tabId: 1, direction: 'sideways' }], ['scroll', { tabId: 1, direction: 'bottom', ref: 'guess' }],
    ['click', { tabId: 1, ref: 'r1-1', expectedContext: '' }],
    ['click', { tabId: 1, ref: '#guess' }], ['fill', { tabId: 1, ref: 'r1-0', text: 5 }],
    ['navigate', { tabId: 1, url: 'file:///C:/secret' }],
    ['press', { tabId: 1, key: 'F12' }], ['list_tabs', { unexpected: 1 }]
  ]) assert.throws(() => validateCommand(method, params));
  assert.deepEqual(validateCommand('click', { tabId: 42, ref: 'r1-3' }), { method: 'click', params: { tabId: 42, ref: 'r1-3' } });
  assert.equal(validateCommand('snapshot', { tabId: 42, load: 'current' }).params.load, 'current');
  assert.equal(validateCommand('scroll', { tabId: 42, direction: 'bottom' }).method, 'scroll');
});

test('MCP stdio 握手、工具目录和错误响应', async (t) => {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-browser-mcp-'));
  const bridge = createBridge({ port: 0, configDir });
  const port = await bridge.start();
  // 在自有随机端口上先监听，监督器只检查此桥，不探测或拉起默认用户桥。
  const child = spawn(process.execPath, [path.join(root, 'server', 'mcp.mjs'), '--port', String(port), '--config-dir', configDir], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    await bridge.close();
    await fs.rm(configDir, { recursive: true, force: true });
  });
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
  assert.equal(replies.find(x => x.id === 1).result.serverInfo.name, `ai-browser-${port}`);
  assert.equal(replies.find(x => x.id === 1).result.serverInfo.version, JSON.parse(await fs.readFile(path.join(root, '.zcode-plugin', 'plugin.json'), 'utf8')).version);
  const tools = replies.find(x => x.id === 2).result.tools;
  assert.equal(tools.length, 21);
  assert.equal(new Set(tools.map(x => x.name)).size, 21);
  assert(tools.find(x => x.name === 'browser_restart'));
  assert.equal(tools.find(x => x.name === 'browser_snapshot').inputSchema.properties.load.default, 'auto');
  assert(tools.find(x => x.name === 'browser_scroll'));
  assert.equal(replies.find(x => x.id === 3).result.isError, true);
  assert.equal(replies.find(x => x.id === 4).error.code, -32601);
});

test('插件清单、可选市场、图标指向同一版本及实际资源', async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(root, '.zcode-plugin', 'plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'ai-browser-control');
  // 独立 GitHub 仓库不含父目录市场；本机附带市场时仍验证其一致性。
  let catalog;
  try { catalog = JSON.parse(await fs.readFile(path.join(root, '..', 'marketplace.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (catalog) {
    const listing = catalog.plugins.find(x => x.name === manifest.name);
    assert.equal(listing.version, manifest.version);
    assert.equal(catalog.name, 'dev-ai-browser-local');
    assert.equal(path.resolve(root, '..', listing.source), root);
  }
  const mcp = JSON.parse(await fs.readFile(path.join(root, manifest.mcpServers), 'utf8'));
  assert.ok(mcp.mcpServers['ai-browser'].args[0].includes('${CLAUDE_PLUGIN_ROOT}'));
  await fs.access(mcp.mcpServers['ai-browser'].command);
  const extension = JSON.parse(await fs.readFile(path.join(root, 'extension', 'manifest.json'), 'utf8'));
  assert.equal(extension.name, 'AI Browser Control');
  assert.equal(extension.version, manifest.version);
  for (const file of Object.values(extension.icons)) await fs.access(path.join(root, 'extension', file));
  await fs.access(path.join(root, manifest.skills, 'ai-browser-control', 'SKILL.md'));
});

test('页面回传故障在桥与MCP请求层保留安全诊断和命令关联，丢弃业务原始值', async t => {
  const { port, get, post, waitFor } = await isolatedBridge(t);
  const polling = get('/poll', EXT_A);
  await waitFor(s => s.client === EXT_A);
  const result = bridgeRequest('/rpc', { port, body: { method: 'snapshot', params: { tabId: 42, load: 'current' } } }).catch(error => error);
  const command = await (await polling).json();
  await post('/result', EXT_A, { id: command.id, error: { message: '页面RPC空回传，原因未确定', code: 'PAGE_AGENT_EMPTY_RESULT', diagnostic: {
    stage: 'decode', resultKind: 'null', transportKind: 'empty', resultCount: 1, frameId: 0,
    errorCode: 'PAGE_AGENT_EMPTY_RESULT', agentPresent: true, documentChanged: false,
    url: 'https://private.test/token-secret', payload: 'PRIVATE-BUSINESS-CONTENT', exception: 'PRIVATE-ERROR-CONTENT'
  } } });
  const error = await result;
  assert.equal(error.code, 'PAGE_AGENT_EMPTY_RESULT');
  assert.equal(error.commandId, command.id);
  assert.equal(error.diagnostic.resultKind, 'null');
  assert.equal(error.diagnostic.stage, 'decode');
  assert.equal(error.diagnostic.frameId, 0);
  assert(!JSON.stringify(error.diagnostic).includes('PRIVATE'));
  for (const key of ['url', 'payload', 'exception']) assert(!Object.hasOwn(error.diagnostic, key));
});

test('frozen preflight preserves not-dispatched outcome and fixed metadata through HTTP', async t => {
  const { port, get, post, waitFor } = await isolatedBridge(t);
  const polling = get('/poll', EXT_A); await waitFor(s => s.client === EXT_A);
  const pending = bridgeRequest('/rpc', { port, body: { method: 'snapshot', params: { tabId: 42, load: 'current' } } }).catch(error => error);
  const command = await (await polling).json();
  await post('/result', EXT_A, { id: command.id, error: { code: 'TAB_FROZEN', message: 'Frozen fixture', outcome: 'not-dispatched', diagnostic: { stage: 'preflight', phase: 'tabs.get', frozen: true, discarded: false, errorCode: 'TAB_FROZEN', url: 'PRIVATE-URL', text: 'PRIVATE-TEXT' } } });
  const error = await pending;
  assert.equal(error.code, 'TAB_FROZEN'); assert.equal(error.outcome, 'not-dispatched'); assert.equal(error.commandId, command.id);
  assert.equal(error.diagnostic.stage, 'preflight'); assert.equal(error.diagnostic.frozen, true);
  assert(!JSON.stringify(error.diagnostic).includes('PRIVATE'));
});
