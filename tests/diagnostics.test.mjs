import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLogger, diagnosticEvent, pageResultDiagnostic } from '../server/diagnostics.mjs';
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

test('page_result 诊断及错误透传共用严格白名单，异常正文和页面资料不能自由写盘', () => {
  const safe = { stage: 'decode', resultKind: 'null', transportKind: 'empty', resultCount: 1, frameId: 0,
    errorCode: 'PAGE_AGENT_EMPTY_RESULT', agentPresent: true, documentChanged: false, exceptionKind: 'TypeError' };
  const input = { ...safe, event: 'page_result', commandId: 'command-1', method: 'snapshot', outcome: 'error',
    error: { message: 'PRIVATE-EXCEPTION' }, message: 'PRIVATE-MESSAGE', stack: 'PRIVATE-STACK',
    documentId: 'PRIVATE-DOCUMENT', url: 'PRIVATE-URL', title: 'PRIVATE-TITLE', text: 'PRIVATE-TEXT',
    input: 'PRIVATE-INPUT', image: 'PRIVATE-IMAGE', payload: { title: 'PRIVATE-PAYLOAD' } };
  assert.deepEqual(pageResultDiagnostic(input), safe);
  const event = diagnosticEvent(input);
  assert.deepEqual(event, { event: 'page_result', ...safe, commandId: 'command-1', method: 'snapshot', outcome: 'error' });
  assert(!JSON.stringify(event).includes('PRIVATE-'));
  for (const key of Object.keys(safe)) {
    assert.equal(pageResultDiagnostic({ [key]: 'PRIVATE-UNRECOGNIZED' })[key], undefined, key);
  }
  for (const n of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.deepEqual(pageResultDiagnostic({ resultCount: n, frameId: n }), {});
  }
  for (const code of ['lowercase', 'HAS-DASH', 'A'.repeat(65), '', 'PRIVATE-URL']) {
    assert.deepEqual(pageResultDiagnostic({ errorCode: code }), {});
  }
  for (const empty of [null, undefined, 'PRIVATE-TEXT', 42]) assert.deepEqual(pageResultDiagnostic(empty), {});
});

test('page_result HTTP 上报落盘保留枚举与一致性布尔值，丢弃任意页面/异常字段', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-page-result-'));
  const bridge = createBridge({ port: 0, configDir: dir, pollTimeout: 20 });
  const port = await bridge.start(), base = 'http://127.0.0.1:' + port;
  const id = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const headers = { Origin: 'chrome-extension://' + id, 'X-Client-Id': id, 'Content-Type': 'application/json' };
  const post = (route, body) => fetch(base + route, { method: 'POST', headers, body: JSON.stringify(body) });
  try {
    await post('/pair', {});
    const events = ['inject', 'invoke', 'decode', 'serialize'].map((stage, seq) => ({
      event: 'page_result', commandId: 'page-rpc-1', method: 'snapshot', version: VERSION, seq, stage,
      transportKind: 'envelope', resultKind: 'object', resultCount: 1, frameId: 0, agentPresent: true,
      documentChanged: false, errorCode: 'PAGE_AGENT_SYNC_THROW', exceptionKind: 'TypeError', outcome: 'error',
      exception: 'PRIVATE-EXCEPTION', message: 'PRIVATE-MESSAGE', documentId: 'PRIVATE-DOC',
      url: 'PRIVATE-URL', title: 'PRIVATE-TITLE', text: 'PRIVATE-TEXT', input: 'PRIVATE-INPUT', image: 'PRIVATE-IMAGE',
      diagnostic: { arbitrary: 'PRIVATE-NESTED' }
    }));
    assert.equal((await post('/diagnostics', { events })).status, 200);
    const text = fs.readFileSync(path.join(dir, 'bridge.log'), 'utf8');
    assert(!text.includes('PRIVATE-'));
    const entries = text.trim().split('\n').map(line => JSON.parse(line)).filter(e => e.event === 'extension_event');
    assert.deepEqual(entries.map(e => e.diagnostic.stage), ['inject', 'invoke', 'decode', 'serialize']);
    assert(entries.every(e => e.diagnostic.commandId === 'page-rpc-1' && e.diagnostic.documentChanged === false && e.diagnostic.agentPresent === true));
  } finally { await bridge.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('diagnostic错误码必须属于固定集合，不能仅凭字符格式记录业务敏感值', () => {
  assert.deepEqual(pageResultDiagnostic({ errorCode: 'PRIVATE_BILLING_SECRET' }), {});
  assert(!JSON.stringify(diagnosticEvent({ event: 'page_result', errorCode: 'PRIVATE_BILLING_SECRET', stage: 'decode' })).includes('PRIVATE'));
  assert.deepEqual(pageResultDiagnostic({ errorCode: 'PAGE_AGENT_EMPTY_RESULT' }), { errorCode: 'PAGE_AGENT_EMPTY_RESULT' });
});
