import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLogger } from '../server/diagnostics.mjs';
import { createBridge, VERSION } from '../server/bridge.mjs';

test('日志按字节轮转，只保留当前与两份历史；旧超大日志也收敛到上限', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-log-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const suffix of ['', '.1', '.2']) fs.writeFileSync(path.join(dir, `bridge.log${suffix}`), '旧日志\n'.repeat(2000));
  const log = createLogger(dir, { maxBytes: 1024, backups: 2 });
  for (let seq = 0; seq < 80; seq++) log('test', { seq, text: '中文'.repeat(20) });
  const files = fs.readdirSync(dir);
  assert.deepEqual(files.sort(), ['bridge.log', 'bridge.log.1', 'bridge.log.2']);
  assert(files.every(n => fs.statSync(path.join(dir, n)).size <= 1024));
  const entries = files.flatMap(n => fs.readFileSync(path.join(dir, n), 'utf8').trim().split('\n').map(s => JSON.parse(s)));
  assert(entries.some(e => e.seq === 79));
  assert(!entries.some(e => e.seq === 0));
  const before = fs.readFileSync(path.join(dir, 'bridge.log'));
  log('oversize', { data: 'x'.repeat(2000) });
  assert.deepEqual(fs.readFileSync(path.join(dir, 'bridge.log')), before);
});

test('日志轮转遇到文件故障时不破坏命令链，也不回退无限追加', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-log-fail-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = createLogger(dir, { maxBytes: 100, backups: 2 });
  log('start');
  fs.mkdirSync(path.join(dir, 'bridge.log.2'));
  for (let i = 0; i < 20; i++) log('event', { seq: i });
  assert(fs.statSync(path.join(dir, 'bridge.log')).size <= 100);
});

test('监督日志固定文件单份有界，重复创建logger不按PID累积文件', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-supervisor-log-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (let session = 0; session < 10; session++) {
    const log = createLogger(dir, { maxBytes: 300, backups: 0, filename: 'supervisor.log' });
    for (let failures = 0; failures < 20; failures++) log('supervisor_failed', { failures });
  }
  assert.deepEqual(fs.readdirSync(dir), ['supervisor.log']);
  assert(fs.statSync(path.join(dir, 'supervisor.log')).size <= 300);
});

test('扩展诊断须配对、有批次大小限制，落盘只保留固定元数据并显示真实版本', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-telemetry-'));
  const bridge = createBridge({ port: 0, configDir: dir, pollTimeout: 20 });
  const port = await bridge.start(), base = `http://127.0.0.1:${port}`;
  const id = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const headers = { Origin: `chrome-extension://${id}`, 'X-Client-Id': id, 'Content-Type': 'application/json' };
  const post = (route, body) => fetch(base + route, { method: 'POST', headers, body: JSON.stringify(body) });
  try {
    assert.equal((await post('/diagnostics', { events: [] })).status, 403);
    await post('/pair', {});
    await fetch(base + '/poll', { headers });
    const event = { event: 'command_end', session: 'worker-1', seq: 1, version: VERSION, method: 'fill',
      commandId: 'command-1', tabId: 7, phase: 'domFill', outcome: 'timeout', durationMs: 11000,
      text: 'PRIVATE-FORM-CONTENT', error: 'PRIVATE-ERROR-CONTENT', url: 'PRIVATE-PAGE-URL' };
    assert.equal((await post('/diagnostics', { events: [event] })).status, 200);
    assert.equal((await post('/diagnostics', { events: Array(129).fill(event) })).status, 400);
    assert.equal((await post('/diagnostics', { events: [], padding: 'x'.repeat(65536) })).status, 400);
    await fetch(base + '/private?token=PRIVATE-QUERY-TOKEN', { headers });
    const status = await (await fetch(base + '/status')).json();
    assert.equal(status.version, VERSION);
    assert.equal(status.extensionVersion, VERSION);
    assert.deepEqual(status.diagnostics, { fileMaxBytes: 1048576, fileCount: 3 });
    const text = fs.readFileSync(path.join(dir, 'bridge.log'), 'utf8');
    assert(!text.includes('PRIVATE-'));
    const entry = text.trim().split('\n').map(s => JSON.parse(s)).find(e => e.event === 'extension_event');
    assert.equal(entry.diagnostic.phase, 'domFill');
    assert.equal(entry.diagnostic.outcome, 'timeout');
  } finally { await bridge.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
