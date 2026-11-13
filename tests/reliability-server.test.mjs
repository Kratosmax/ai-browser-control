import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bridgeRequest, createBridge } from '../server/bridge.mjs';
import { diagnosticEvent } from '../server/diagnostics.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const artifacts = path.join(root, 'temp/qa/reliability-20261113');
const A = 'a'.repeat(32), B = 'b'.repeat(32);
const headers = id => ({ Origin: 'chrome-extension://' + id, 'X-Client-Id': id, 'Content-Type': 'application/json' });
async function directory(t) {
  await fs.mkdir(artifacts, { recursive: true });
  const dir = await fs.mkdtemp(path.join(artifacts, 'C-runtime-'));
  return dir;
}
async function fixture(t, options = {}) {
  const configDir = await directory(t);
  const bridge = createBridge({ port: 0, configDir, commandTimeout: 350, pollTimeout: 15, ...options });
  const port = await bridge.start();
  assert.notEqual(port, 17653);
  t.after(async () => { await bridge.close(); await fs.rm(configDir, { recursive: true, force: true, maxRetries: 3 }); });
  const get = (route, id) => fetch('http://127.0.0.1:' + port + route, { headers: id ? headers(id) : {}, signal: AbortSignal.timeout(4000) });
  const post = (route, body, id) => fetch('http://127.0.0.1:' + port + route, { method: 'POST', headers: id ? headers(id) : { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(4000) });
  await post('/pair', {}, A); await post('/pair', {}, B);
  assert.equal((await get('/poll', A)).status, 204);
  return { port, configDir, get, post, async dispatch(method = 'snapshot', params = {tabId:7}) {
    const rpc = post('/rpc', { method, params });
    const command = await (await get('/poll', A)).json();
    return { rpc, command };
  } };
}

for (const [label, body] of [
  ['missing payload', {}], ['null success', { result: null }], ['scalar success', { result: 42 }],
  ['array success', { result: [] }], ['empty error', { error: {} }],
  ['non-string error message', { error: { message: { private: 'SECRET' } } }],
  ['conflicting payloads', { result: {}, error: { message: 'conflict' } }]
]) test('malformed extension envelope: ' + label, async t => {
  const f = await fixture(t);
  const { rpc, command } = await f.dispatch();
  const ack = await f.post('/result', { id: command.id, ...body }, A);
  assert.equal(ack.status, 200, 'terminal receipt must not provoke result replay');
  const response = await rpc, error = await response.json();
  assert.equal(response.status, 502);
  assert.equal(error.code, 'INVALID_EXTENSION_RESULT');
  assert.equal(error.commandId, command.id);
  assert.equal(error.outcome, 'unverified');
  assert.match(error.error, /不会.*重放|不会重放/);
  assert.equal((await (await f.get('/status')).json()).pending, 0);
  assert.equal((await f.post('/result', { id: command.id, result: {} }, A)).status, 404);
  assert.equal((await f.get('/poll', A)).status, 204, 'no implicit replay');
});

test('batch and screenshot shape corruption is a classified failure before worker formatting', async t => {
  const f = await fixture(t);
  for (const [method, params, result] of [
    ['batch', { commands: [{ method: 'snapshot', params: { tabId: 1 } }, { method: 'snapshot', params: { tabId: 2 } }] }, { results: [{ ok: true, result: {} }] }],
    ['batch', { commands: [{ method: 'snapshot', params: { tabId: 1 } }, { method: 'snapshot', params: { tabId: 2 } }] }, { results: [{ ok: true, result: {} }, { ok: 'true', result: {} }] }],
    ['screenshot', { tabId: 1 }, { data: '', mimeType: 'image/png' }]
  ]) {
    const { rpc, command } = await f.dispatch(method, params);
    assert.equal((await f.post('/result', { id: command.id, result }, A)).status, 200);
    const response = await rpc;
    assert.equal(response.status, 502);
    assert.equal((await response.json()).code, 'INVALID_EXTENSION_RESULT');
  }
});

test('error metadata is scalar, diagnostic version cannot pass via regex coercion', async t => {
  assert.deepEqual(diagnosticEvent({ event: 'worker_start', version: ['1.2.3'] }), { event: 'worker_start' });
  const f = await fixture(t);
  const { rpc, command } = await f.dispatch();
  await f.post('/result', { id: command.id, error: { message: 'known failure', code: ['PRIVATE_CODE'], outcome: ['not-dispatched'] } }, A);
  const error = await (await rpc).json();
  assert.equal(error.code, 'BROWSER_ACTION_FAILED');
  assert.equal(error.outcome, 'unverified');
});

async function fakeHttp(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const port = server.address().port;
  assert.notEqual(port, 17653);
  return port;
}
for (const [label, reply] of [
  ['invalid JSON', 'not JSON PRIVATE_TOKEN'], ['null JSON', 'null'],
  ['missing result', '{}'], ['null result', '{"result":null}'],
  ['ambiguous result', '{"result":{},"error":"bad"}']
]) test('bridgeRequest classifies ' + label + ' without reflecting transport payload', async t => {
  const port = await fakeHttp(t, (_req, res) => res.end(reply));
  await assert.rejects(bridgeRequest('/rpc', { port, body: { method: 'list_tabs' } }), error => {
    assert.equal(error.code, 'BRIDGE_INVALID_RESPONSE');
    assert.equal(error.outcome, 'unverified');
    assert.doesNotMatch(error.message, /PRIVATE_TOKEN/);
    assert.match(error.message, /重放/);
    return true;
  });
});

test('bridgeRequest timeout and truncated response stay ambiguous and never retry RPC', async t => {
  let requests = 0;
  const port = await fakeHttp(t, (req, res) => { requests++; if (req.url === '/truncated') { res.writeHead(200, { 'Content-Length': '100' }); res.write('{'); res.destroy(); } });
  await assert.rejects(bridgeRequest('/rpc', { port, body: { method: 'list_tabs' }, timeout: 40 }), error => {
    assert.equal(error.code, 'BRIDGE_REQUEST_TIMEOUT'); assert.equal(error.outcome, 'unverified'); assert.match(error.message, /重放/); return true;
  });
  await assert.rejects(bridgeRequest('/truncated', { port, timeout: 500 }), error => {
    assert.equal(error.code, 'BRIDGE_TRANSPORT_ERROR'); assert.equal(error.outcome, 'unverified'); return true;
  });
  assert.equal(requests, 2, 'one network attempt per explicit request');
});

test('UTF-8 multibyte result under bridge byte cap roundtrips without content in diagnostics', async t => {
  const f = await fixture(t, { commandTimeout: 2000 });
  const text = '私密😀'.repeat(180000);
  assert(Buffer.byteLength(text) > text.length);
  const { rpc, command } = await f.dispatch();
  assert.equal((await f.post('/result', { id: command.id, result: { text } }, A)).status, 200);
  assert.equal((await (await rpc).json()).result.text, text);
  assert.doesNotMatch(await fs.readFile(path.join(f.configDir, 'bridge.log'), 'utf8'), /私密/);
});

test('timeout/result ordering and duplicate result do not settle or deliver a command twice', async t => {
  const f = await fixture(t, { commandTimeout: 60 });
  const { rpc, command } = await f.dispatch();
  const response = await rpc;
  assert.equal(response.status, 504);
  const error = await response.json();
  assert.equal(error.commandId, command.id); assert.equal(error.outcome, 'unverified');
  assert.equal((await f.post('/result', { id: command.id, result: {} }, A)).status, 404);
  const next = await f.dispatch();
  assert.notEqual(next.command.id, command.id);
  assert.equal((await f.post('/result', { id: next.command.id, result: { next: true } }, B)).status, 403);
  assert.equal((await f.post('/result', { id: next.command.id, result: { next: true } }, A)).status, 200);
  assert.equal((await (await next.rpc).json()).result.next, true);
  assert.equal((await f.post('/result', { id: next.command.id, result: {} }, A)).status, 404);
  assert.equal((await f.get('/poll', A)).status, 204);
});

test('valid mixed batch preserves result ordering, image and individual failure', async t => {
  const f = await fixture(t);
  const commands = [{ method: 'screenshot', params: { tabId: 1 } }, { method: 'snapshot', params: { tabId: 2 } }];
  const result = { results: [{ ok: true, result: { data: 'iVBORw0KGgo=', mimeType: 'image/png' } },
    { ok: false, error: { code: 'TAB_FROZEN', message: 'frozen fixture', outcome: 'not-dispatched' } }] };
  const { rpc, command } = await f.dispatch('batch', { commands });
  assert.equal((await f.post('/result', { id: command.id, result }, A)).status, 200);
  assert.deepEqual((await (await rpc).json()).result, result);
});

test('bridge body cap uses UTF-8 bytes, oversized result is rejected before forwarding', async t => {
  const f = await fixture(t, { commandTimeout: 1500 });
  const text = '密'.repeat(Math.floor(12 * 1024 * 1024 / 3) + 100);
  assert(text.length < 12 * 1024 * 1024);
  assert(Buffer.byteLength(text) > 12 * 1024 * 1024);
  const { rpc, command } = await f.dispatch();
  const rejected = await f.post('/result', { id: command.id, result: { text } }, A);
  assert.equal(rejected.status, 400);
  assert.match((await rejected.json()).error, /过大/);
  // The extension may explicitly report the delivery failure under the same id.
  await f.post('/result', { id: command.id, error: { code: 'RESULT_REJECTED', message: 'oversized fixture', outcome: 'unverified' } }, A);
  const response = await rpc;
  assert.equal(response.status, 502);
  assert.equal((await response.json()).code, 'RESULT_REJECTED');
  assert.doesNotMatch(await fs.readFile(path.join(f.configDir, 'bridge.log'), 'utf8'), /密/);
});

test('HTTP client abort drops only its RPC and never replays queued or dispatched work', async t => {
  const f = await fixture(t);
  const state = async () => (await f.get('/status')).json();
  async function waitFor(predicate) {
    const deadline = Date.now() + 1500;
    while (!predicate(await state())) { assert(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 5)); }
  }
  for (const delivered of [false, true]) {
    const abort = new AbortController();
    const rpc = fetch('http://127.0.0.1:' + f.port + '/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'list_tabs' }), signal: abort.signal }).catch(error => error);
    await waitFor(s => s.pending === 1);
    const command = delivered ? await (await f.get('/poll', A)).json() : null;
    abort.abort();
    assert.equal((await rpc).name, 'AbortError');
    await waitFor(s => s.pending === 0);
    assert.equal((await state()).connected, true, 'extension liveness is independent of RPC waiters');
    if (command) assert.equal((await f.post('/result', { id: command.id, result: {} }, A)).status, 404);
    assert.equal((await f.get('/poll', A)).status, 204);
  }
});

test('launcher deadline cannot be won by a result arriving during worker shutdown', { timeout: 10000 }, async t => {
  const dir = await directory(t);
  await fs.mkdir(path.join(dir, 'server'));
  const source = await fs.readFile(path.join(root, 'server/mcp.mjs'), 'utf8');
  // Scale only the private fixture deadline; production remains 40 seconds.
  assert(source.includes('const CALL_TIMEOUT_MS = 40000;'));
  await fs.writeFile(path.join(dir, 'server/mcp.mjs'), source.replace('const CALL_TIMEOUT_MS = 40000;', 'const CALL_TIMEOUT_MS = 60;'));
  const marker = path.join(dir, 'stopping');
  await fs.writeFile(path.join(dir, 'server/mcp-worker.mjs'), `
import fs from 'node:fs';
let generation, call;
process.on('disconnect', () => process.exit(0));
process.on('message', message => {
  if (message.type === 'start') {
    generation = message.generation;
    process.send({ type: 'ready', generation, pid: process.pid, version: '1.0.0',
      tools: [{ name: 'browser_status' }, { name: 'browser_restart' }, { name: 'browser_list_tabs' }] });
  }
  if (message.type === 'activate') process.send({ type: 'activated', generation, pid: process.pid });
  if (message.type === 'call') call = message;
  if (message.type === 'shutdown') {
    if (call) {
      fs.writeFileSync(${JSON.stringify(marker)}, 'stopping');
      process.send({ type: 'result', id: call.id, result: { content: [{ type: 'text', text: 'LATE_SUCCESS' }] } });
    }
    setTimeout(() => process.exit(0), call ? 250 : 10);
  }
});
`);
  const child = spawn(process.execPath, [path.join(dir, 'server/mcp.mjs')], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, NODE_OPTIONS: '' } });
  let workerPid;
  const closed = new Promise((resolve, reject) => { child.on('close', resolve); child.on('error', reject); });
  t.after(async () => {
    child.stdin.end();
    const timer = setTimeout(() => child.kill(), 3000);
    try { await closed; } finally { clearTimeout(timer); }
    if (workerPid) assert.throws(() => process.kill(workerPid, 0), { code: 'ESRCH' });
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  const lines = createInterface({ input: child.stdout });
  const waiting = new Map();
  lines.on('line', line => { const response = JSON.parse(line); waiting.get(response.id)?.(response.result); });
  function request(id, method, params) { const response = new Promise(resolve => waiting.set(id, resolve)); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); return response; }
  await request(1, 'initialize');
  // local status is unavailable in this fake worker, so obtain its PID from the
  // successful restart receipt before the adversarial timed call.
  const restart = await request(2, 'tools/call', { name: 'browser_restart', arguments: {} });
  workerPid = restart.structuredContent.after.mcpPid;
  const timed = request(3, 'tools/call', { name: 'browser_list_tabs', arguments: {} });
  const deadline = Date.now() + 2000;
  while (!await fs.stat(marker).then(() => true, () => false)) {
    assert(Date.now() < deadline, 'worker must reach the shutdown barrier');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  const busy = await request(4, 'tools/call', { name: 'browser_restart', arguments: {} });
  assert.equal(busy.structuredContent.error.code, 'MCP_BUSY', 'timed call stays inFlight until shutdown completes');
  const rejected = await request(5, 'tools/call', { name: 'browser_list_tabs', arguments: {} });
  assert.equal(rejected.structuredContent.error.code, 'MCP_WORKER_UNAVAILABLE');
  assert.equal(rejected.structuredContent.error.outcome, 'not-dispatched');
  const result = await timed;
  assert.equal(result.isError, true, 'a result after deadline cannot become success');
  assert.equal(result.structuredContent.error.code, 'MCP_WORKER_TIMEOUT');
  assert.equal(result.structuredContent.error.outcome, 'unverified');
  assert.match(result.content[0].text, /MCP_WORKER_TIMEOUT/);
  child.stdin.end(); await closed;
});
