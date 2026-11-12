import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

// Run with: node --test tests/mcp-restart.test.mjs
// These are real NDJSON stdio sessions, not imports of the MCP implementation.
// Every case owns a minimal runtime project copy, configuration and HTTP bridge.
const PROJECT = fileURLToPath(new URL('../', import.meta.url));
const REQUEST_TIMEOUT = 15000;
const TEST_TIMEOUT = 35000;
const BRIDGE_VERSION = 'fake-bridge-7.8.9';
const EXTENSION_VERSION = 'fake-extension-4.5.6';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  // A later awaited response must not become an unhandled rejection on teardown.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

async function bounded(promise, label, ms = REQUEST_TIMEOUT) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}

class StdioClient {
  constructor(directory, args) {
    this.sequence = 0;
    this.pending = new Map();
    this.notifications = [];
    this.notificationWaiters = new Set();
    this.stderr = '';
    this.failure = null;
    this.closed = deferred();
    this.child = spawn(process.execPath, [path.join(directory, 'server/mcp.mjs'), ...args], {
      cwd: directory, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      // Do not inherit loaders/coverage hooks that can modify the worker process.
      env: { ...process.env, NODE_OPTIONS: '' }
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk).slice(-16000); });
    this.child.stdin.on('error', error => this.fail(error));
    this.child.on('error', error => this.fail(error));
    const lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    lines.on('line', line => {
      if (!line.trim()) return;
      try {
        const message = JSON.parse(line);
        assert.equal(message.jsonrpc, '2.0', 'stdout must contain JSON-RPC only');
        if (Object.hasOwn(message, 'id')) {
          const pending = this.pending.get(message.id);
          assert(pending, `Unexpected/duplicate JSON-RPC response ${message.id}`);
          this.pending.delete(message.id);
          clearTimeout(pending.timer);
          if (message.error) pending.reject(Object.assign(new Error(message.error.message), { rpcError: message.error }));
          else pending.resolve(message.result);
        } else {
          assert.equal(typeof message.method, 'string', 'notification must have a method');
          this.notifications.push(message);
          for (const waiter of [...this.notificationWaiters]) waiter();
        }
      } catch (error) { this.protocolFailure ??= error; this.fail(error); }
    });
    this.child.on('close', (code, signal) => {
      this.fail(new Error(`MCP stdio closed (${code ?? signal}); stderr: ${this.stderr}`));
      this.closed.resolve({ code, signal });
    });
  }

  fail(error) {
    this.failure ??= error;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    for (const waiter of [...this.notificationWaiters]) waiter();
  }

  request(method, params) {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.sequence;
    const reply = deferred();
    const timer = setTimeout(() => {
      this.pending.delete(id);
      reply.reject(new Error(`No response to ${method} #${id}; stderr: ${this.stderr}`));
    }, REQUEST_TIMEOUT);
    this.pending.set(id, { ...reply, timer });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`);
    return reply.promise;
  }

  call(name, args = {}) { return this.request('tools/call', { name, arguments: args }); }

  async initialize() {
    const info = await this.request('initialize', {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'restart-black-box', version: '1' }
    });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    return info;
  }

  async notification(method, since = 0) {
    const match = () => this.notifications.slice(since).find(item => item.method === method);
    if (match()) return match();
    const signal = deferred();
    const check = () => {
      if (match()) signal.resolve(match());
      else if (this.failure) signal.reject(this.failure);
    };
    this.notificationWaiters.add(check);
    try { check(); return await bounded(signal.promise, method); }
    finally { this.notificationWaiters.delete(check); }
  }

  async end() {
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.stdin.end();
    return bounded(this.closed.promise, 'MCP exit after stdin EOF', 6000);
  }
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

async function assertExited(pid) {
  // A bounded condition check is needed for non-child worker PIDs. Delays only
  // pace OS observations; elapsed time alone never constitutes a successful test.
  const deadline = performance.now() + 6000;
  let backoff = 5;
  while (isAlive(pid)) {
    assert(performance.now() < deadline, `Worker ${pid} survived MCP reload/EOF`);
    await new Promise(resolve => setTimeout(resolve, backoff));
    backoff = Math.min(backoff * 2, 150);
  }
}

function json(response, data) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
  response.end(JSON.stringify(data));
}

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'mcp-restart-blackbox-'));
  const workers = new Set();
  const requests = [];
  const arrivals = new Set();
  let client, holdRpc = false, holdCandidate = false;
  const bridge = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/health') return json(response, { service: 'ai-browser-control', version: BRIDGE_VERSION });
      if (url.pathname === '/status') return json(response, {
        connected: true, standby: false, version: BRIDGE_VERSION, extensionVersion: EXTENSION_VERSION,
        bridgeMethods: ['list_tabs', 'click'], client: 'black-box-fake-extension', pending: 0
      });
      if (url.pathname === '/rpc' || url.pathname === '/__candidate') {
        let body;
        if (url.pathname === '/rpc') {
          const chunks = [];
          for await (const chunk of request) chunks.push(chunk);
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } else {
          const pid = Number(url.searchParams.get('pid'));
          assert(Number.isInteger(pid) && pid > 0);
          workers.add(pid);
        }
        const item = { route: url.pathname, body, response, pid: Number(url.searchParams.get('pid')) };
        requests.push(item);
        for (const check of [...arrivals]) check();
        if (url.pathname === '/rpc' ? !holdRpc : !holdCandidate) {
          json(response, url.pathname === '/rpc' ? { result: { acknowledged: true } } : { ready: true });
        }
        return;
      }
      response.writeHead(404); response.end();
    } catch (error) { response.destroy(error); }
  });
  // localhost resolves identically in the test and child and keeps this fake
  // bridge off external interfaces. No default/user bridge is ever contacted.
  await new Promise((resolve, reject) => { bridge.once('error', reject); bridge.listen(0, 'localhost', resolve); });
  const port = bridge.address().port;
  assert.notEqual(port, 17653);
  t.after(async () => {
    const problems = [];
    // Release every owned barrier before asking the host to shut down.
    for (const request of requests) json(request.response, { result: { cleanup: true } });
    if (client) {
      try { await client.end(); }
      catch (error) { problems.push(error); client.child.kill(); await bounded(client.closed.promise, 'killed test host', 3000).catch(e => problems.push(e)); }
    }
    if (client?.protocolFailure) problems.push(client.protocolFailure);
    for (const pid of workers) {
      try { await assertExited(pid); }
      catch (error) {
        problems.push(error);
        if (isAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
      }
    }
    bridge.closeAllConnections();
    await new Promise(resolve => bridge.close(resolve));
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
    if (problems.length) throw new AggregateError(problems, 'MCP fixture cleanup failed');
  });
  // Copy the complete runtime dependency graph, never the real configuration,
  // extension or browser profile. Runtime edits below affect only mkdtemp.
  await cp(path.join(PROJECT, 'server'), path.join(directory, 'server'), { recursive: true });
  await cp(path.join(PROJECT, '.zcode-plugin'), path.join(directory, '.zcode-plugin'), { recursive: true });
  const config = path.join(directory, 'config');
  await mkdir(config);
  client = new StdioClient(directory, ['--host', 'localhost', '--port', String(port), '--config-dir', config]);
  const initialized = await client.initialize();

  async function arrival(route, since = 0) {
    const match = () => requests.slice(since).find(item => item.route === route);
    const signal = deferred();
    const check = () => { if (match()) signal.resolve(match()); };
    arrivals.add(check);
    try { check(); return await bounded(signal.promise, `fake bridge received ${route}`); }
    finally { arrivals.delete(check); }
  }
  return {
    directory, client, initialized, requests, arrival, workers,
    holdRpc: () => { holdRpc = true; },
    holdCandidate: () => { holdCandidate = true; },
    candidatePrefix: `await fetch(${JSON.stringify(`http://localhost:${port}/__candidate`)} + '?pid=' + process.pid);\n`,
    async status() {
      const data = payload(await client.call('browser_status'));
      assert.equal(typeof data.mcpVersion, 'string', 'status must identify the MCP code version');
      assert(Number.isInteger(data.mcpPid) && data.mcpPid > 0, 'status must expose worker PID');
      assert(Number.isInteger(data.mcpGeneration) && data.mcpGeneration > 0, 'status must expose generation');
      assert.notEqual(data.mcpPid, client.child.pid, 'stdio host must not impersonate its worker');
      workers.add(data.mcpPid);
      assert.equal(data.version, BRIDGE_VERSION, 'bridge version must stay independent of MCP version');
      assert.equal(data.extensionVersion, EXTENSION_VERSION, 'extension version must stay independent of MCP version');
      return { version: data.mcpVersion, pid: data.mcpPid, generation: data.mcpGeneration };
    }
  };
}

function payload(result) {
  assert.notEqual(result.isError, true, JSON.stringify(result));
  return result.structuredContent ?? JSON.parse(result.content.find(item => item.type === 'text').text);
}

function errorCode(result, code) {
  assert.equal(result.isError, true, JSON.stringify(result));
  if (code instanceof RegExp) assert.match(result.structuredContent?.error?.code ?? '', code, JSON.stringify(result));
  else assert.equal(result.structuredContent?.error?.code, code, JSON.stringify(result));
}

function changed(before, after) {
  assert.notEqual(after.pid, before.pid, 'reload must replace the worker PID');
  assert(after.generation > before.generation, 'generation must increase');
  assert(isAlive(after.pid), 'new ready worker must be running');
}

async function restart(f) {
  const since = f.client.notifications.length;
  const result = payload(await f.client.call('browser_restart'));
  await f.client.notification('notifications/tools/list_changed', since);
  assert.equal(result.restart, true);
  const identity = info => ({ version: info.mcpVersion, pid: info.mcpPid, generation: info.mcpGeneration });
  return { ...result, before: identity(result.before), after: identity(result.after) };
}

test('restart preserves the stdio session, replaces only its worker and announces listChanged', { timeout: TEST_TIMEOUT }, async t => {
  const f = await fixture(t);
  assert.equal(f.initialized.capabilities.tools.listChanged, true);
  const before = await f.status();
  assert.equal(f.initialized.serverInfo.version, before.version);
  const host = f.client.child.pid;
  const tools = (await f.client.request('tools/list')).tools;
  const definition = tools.find(tool => tool.name === 'browser_restart');
  assert(definition, 'browser_restart must be discoverable');
  assert.equal(definition.inputSchema.type, 'object');
  assert.deepEqual(definition.inputSchema.properties, {});
  assert.equal(definition.inputSchema.additionalProperties, false);
  assert.deepEqual(definition.inputSchema.required ?? [], []);
  const result = await restart(f);
  const after = await f.status();
  changed(before, after);
  assert.deepEqual(result.before, before);
  assert.deepEqual(result.after, after);
  assert.equal(f.client.child.pid, host);
  assert.equal(f.client.child.exitCode, null, 'stdio host must survive reload');
  await assertExited(before.pid);
  assert.deepEqual(await f.client.request('ping'), {});
  assert.deepEqual((await f.client.request('tools/list')).tools, tools);
  assert.equal(f.requests.filter(item => item.route === '/rpc').length, 0, 'restart must not dispatch to the bridge');
});

test('restart refreshes version and transitive protocol schema from the project copy', { timeout: TEST_TIMEOUT }, async t => {
  const f = await fixture(t);
  const before = await f.status();
  const initial = (await f.client.request('tools/list')).tools;
  const manifest = path.join(f.directory, '.zcode-plugin/plugin.json');
  const config = JSON.parse(await readFile(manifest, 'utf8'));
  config.version = `${before.version}-blackbox-reloaded`;
  await writeFile(manifest, JSON.stringify(config));
  const protocol = path.join(f.directory, 'server/protocol.mjs');
  const source = await readFile(protocol, 'utf8');
  await writeFile(protocol, source + "\ntools.find(t => t.name === 'browser_click').inputSchema.properties.blackboxReload = { type: 'string', enum: ['fresh-schema'] };\n");
  // Disk changes cannot affect the currently loaded worker.
  assert.deepEqual((await f.client.request('tools/list')).tools, initial);
  const result = await restart(f);
  const after = await f.status();
  changed(before, after);
  assert.equal(after.version, config.version);
  assert.deepEqual(result.before, before);
  assert.deepEqual(result.after, after);
  const updated = (await f.client.request('tools/list')).tools;
  assert.deepEqual(updated.find(tool => tool.name === 'browser_click').inputSchema.properties.blackboxReload, { type: 'string', enum: ['fresh-schema'] });
  assert.deepEqual(await f.client.request('ping'), {});
  await assertExited(before.pid);
});

test('a broken candidate keeps the old worker usable and can be repaired for another restart', { timeout: TEST_TIMEOUT }, async t => {
  const f = await fixture(t);
  const before = await f.status();
  const worker = path.join(f.directory, 'server/mcp-worker.mjs');
  const source = await readFile(worker, 'utf8');
  const tools = await f.client.request('tools/list');
  const since = f.client.notifications.length;
  await writeFile(worker, f.candidatePrefix + "throw new Error('black-box deliberately broken worker');\n" + source);
  const failed = await f.client.call('browser_restart');
  errorCode(failed, /^MCP_WORKER_(START_FAILED|START_TIMEOUT|EXITED|INVALID_READY)$/);
  const candidate = await f.arrival('/__candidate');
  await assertExited(candidate.pid);
  assert.deepEqual(await f.status(), before);
  assert.deepEqual(await f.client.request('ping'), {});
  assert.deepEqual(await f.client.request('tools/list'), tools);
  assert.equal(f.client.notifications.slice(since).filter(item => item.method === 'notifications/tools/list_changed').length, 0);
  assert(isAlive(before.pid), 'failed candidate must not evict the current worker');
  await writeFile(worker, source);
  await restart(f);
  changed(before, await f.status());
  await assertExited(before.pid);
});

test('an in-flight browser action rejects restart with MCP_BUSY and is never replayed', { timeout: TEST_TIMEOUT }, async t => {
  const f = await fixture(t);
  const before = await f.status();
  f.holdRpc();
  const action = f.client.call('browser_click', { tabId: 7, ref: 'r1-1' });
  const received = await f.arrival('/rpc');
  assert.deepEqual(received.body, { method: 'click', params: { tabId: 7, ref: 'r1-1' } });
  const since = f.client.notifications.length;
  errorCode(await f.client.call('browser_restart'), 'MCP_BUSY');
  assert.deepEqual(await f.client.request('ping'), {});
  assert.deepEqual(await f.status(), before);
  assert(isAlive(before.pid));
  json(received.response, { result: { clicked: 1 } });
  assert.deepEqual(payload(await action), { clicked: 1 });
  assert.deepEqual(await f.status(), before);
  assert.equal(f.client.notifications.slice(since).filter(item => item.method === 'notifications/tools/list_changed').length, 0);
  await restart(f);
  changed(before, await f.status());
  assert.equal(f.requests.filter(item => item.route === '/rpc').length, 1, 'action must not be retried during or after restart');
});

test('new business calls are rejected with MCP_RESTARTING until candidate ready', { timeout: TEST_TIMEOUT }, async t => {
  const f = await fixture(t);
  const before = await f.status();
  const worker = path.join(f.directory, 'server/mcp-worker.mjs');
  const source = await readFile(worker, 'utf8');
  await writeFile(worker, f.candidatePrefix + source);
  f.holdCandidate();
  let settled = false;
  const loading = restart(f).finally(() => { settled = true; });
  loading.catch(() => {});
  const candidate = await f.arrival('/__candidate');
  assert(isAlive(before.pid), 'old worker must survive until candidate ready');
  assert.notEqual(candidate.pid, before.pid);
  errorCode(await f.client.call('browser_click', { tabId: 7, ref: 'r1-1' }), 'MCP_RESTARTING');
  errorCode(await f.client.call('browser_restart'), 'MCP_RESTARTING');
  assert.equal(settled, false, 'restart must not acknowledge a candidate before ready');
  assert.equal(f.requests.filter(item => item.route === '/rpc').length, 0);
  json(candidate.response, { ready: true });
  await loading;
  const after = await f.status();
  changed(before, after);
  assert.equal(after.pid, candidate.pid);
  await assertExited(before.pid);
  assert.deepEqual(payload(await f.client.call('browser_list_tabs')), { acknowledged: true });
  assert.deepEqual(f.requests.filter(item => item.route === '/rpc').map(item => item.body.method), ['list_tabs'], 'rejected action must never be queued/replayed');
});

test('restart rejects non-empty arguments without replacing its worker', { timeout: TEST_TIMEOUT }, async t => {
  const f = await fixture(t);
  const before = await f.status();
  const since = f.client.notifications.length;
  for (const args of [{ force: true }, [], null, 'restart']) {
    errorCode(await f.client.call('browser_restart', args), 'INVALID_ARGUMENTS');
    assert.deepEqual(await f.status(), before);
  }
  assert.equal(f.client.notifications.slice(since).filter(item => item.method === 'notifications/tools/list_changed').length, 0);
  assert.equal(f.requests.filter(item => item.route === '/rpc').length, 0);
});

test('stdin EOF during candidate loading leaves neither old nor candidate worker behind', { timeout: TEST_TIMEOUT }, async t => {
  const f = await fixture(t);
  const before = await f.status();
  const worker = path.join(f.directory, 'server/mcp-worker.mjs');
  const source = await readFile(worker, 'utf8');
  await writeFile(worker, f.candidatePrefix + source);
  f.holdCandidate();
  const loading = f.client.call('browser_restart');
  const candidate = await f.arrival('/__candidate');
  assert(isAlive(before.pid));
  assert(isAlive(candidate.pid));
  const settled = loading.then(result => assert.equal(result.isError, true, 'EOF取消尚未就绪的重载，不能成功确认'), error => assert.match(error.message, /MCP stdio closed/));
  const exit = await f.client.end();
  await settled;
  assert.equal(exit.code, 0, `host stderr: ${f.client.stderr}`);
  // Intentionally never release the HTTP gate: EOF must terminate the candidate
  // even though its application-level shutdown listener is not installed yet.
  await assertExited(before.pid);
  await assertExited(candidate.pid);
});

test('stdin EOF shuts down the stdio host and all workers after a successful reload', { timeout: TEST_TIMEOUT }, async t => {
  const f = await fixture(t);
  const before = await f.status();
  await restart(f);
  const after = await f.status();
  changed(before, after);
  const exit = await f.client.end();
  assert.equal(exit.code, 0, `host stderr: ${f.client.stderr}`);
  await assertExited(before.pid);
  await assertExited(after.pid);
  assert.equal(isAlive(f.client.child.pid), false);
});

test('stdin EOF preserves an already dispatched slow response beyond the startup deadline', { timeout: TEST_TIMEOUT }, async t => {
  const f = await fixture(t);
  const before = await f.status();
  f.holdRpc();
  const action = f.client.call('browser_click', { tabId: 7, ref: 'r1-1' });
  const received = await f.arrival('/rpc');
  const responseTimer = setTimeout(() => json(received.response, { result: { completedOnce: true } }), 10500);
  t.after(() => clearTimeout(responseTimer));
  f.client.child.stdin.end();
  assert.deepEqual(payload(await action), { completedOnce: true });
  const exit = await bounded(f.client.closed.promise, 'MCP drained slow call after EOF', 20000);
  assert.equal(exit.code, 0);
  assert.equal(f.requests.filter(item => item.route === '/rpc').length, 1);
  await assertExited(before.pid);
});

test('page error diagnostic and command id remain visible in text and structured MCP output', { timeout: TEST_TIMEOUT }, async t => {
  const f = await fixture(t);
  f.holdRpc();
  const action = f.client.call('browser_snapshot', { tabId: 7, load: 'current' });
  const received = await f.arrival('/rpc');
  received.response.writeHead(502, { 'Content-Type': 'application/json' });
  received.response.end(JSON.stringify({ error: '页面代理传输空结果', code: 'PAGE_AGENT_EMPTY_RESULT', outcome: 'unverified', commandId: 'page-rpc-command-1',
    diagnostic: { resultKind: 'null', stage: 'decode', transportKind: 'empty', resultCount: 1, frameId: 0, url: 'PRIVATE-URL', payload: 'PRIVATE-PAYLOAD' } }));
  const result = await action;
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.commandId, 'page-rpc-command-1');
  assert.equal(result.structuredContent.error.diagnostic.resultKind, 'null');
  assert.match(result.content[0].text, /PAGE_AGENT_EMPTY_RESULT/);
  assert.match(result.content[0].text, /page-rpc-command-1/);
  assert.match(result.content[0].text, /decode/);
  assert(!JSON.stringify(result).includes('PRIVATE-'));
});
