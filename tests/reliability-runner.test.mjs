// task-25: 固定可靠性验收运行器的测试。
// 全部通过模块内导出/依赖注入打桩，或只做极小的真实子进程检查（--list / 参数拒绝 / 退出码透传），
// 不重复跑重型套件，不触碰真实业务、默认桥或全局设置。
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  UsageError, RunnerError, NATIVE_ALLOWLIST, LIMITS,
  parseArgs, usageText, nodeVersionOk, discoverUnitTests, checkNativePrereqs,
  runChild, classifyChildResult, runStage, computeExit,
} from '../scripts/check-reliability.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runnerPath = path.join(root, 'scripts', 'check-reliability.mjs');

async function tempDir(prefix = 'reliability-runner-test-') {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

// ---- 参数解析 ----

test('parseArgs: 默认 unit，识别 native/all/list/dry-run/help', () => {
  assert.deepEqual(parseArgs([]), { mode: '--unit', list: false, dryRun: false, help: false });
  assert.equal(parseArgs(['--native']).mode, '--native');
  assert.equal(parseArgs(['--all']).mode, '--all');
  assert.equal(parseArgs(['--list']).list, true);
  assert.equal(parseArgs(['--native', '--list']).mode, '--native');
  assert.equal(parseArgs(['--all', '--dry-run']).dryRun, true);
  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs(['-h']).help, true);
});

test('parseArgs: 拒绝未知参数、位置参数、重复与互斥组合', () => {
  const rejects = [
    ['--bogus'], ['positional'], ['--unit', '--native'], ['--all', '--unit'], ['--native', '--all'],
    ['--list', '--dry-run'], ['--unit', '--unit'], ['--dry-run', '--dry-run'], ['--mode=unit'], ['--'],
  ];
  for (const argv of rejects) {
    assert.throws(() => parseArgs(argv), UsageError, '应拒绝: ' + JSON.stringify(argv));
  }
  assert.match(usageText(), /--unit|--native|--all/);
});

test('nodeVersionOk: 仅 Node 22+ 通过', () => {
  assert.equal(nodeVersionOk('v22.0.0'), true);
  assert.equal(nodeVersionOk('v24.20.0'), true);
  assert.equal(nodeVersionOk('v18.17.0'), false);
  assert.equal(nodeVersionOk(''), false);
});

// ---- 计划发现 ----

test('discoverUnitTests: 只取两个固定目录第一层的指定后缀，动态数量不硬编码', async () => {
  const base = await tempDir('reliability-discover-');
  await fsp.mkdir(path.join(base, 'tests', 'sub'), { recursive: true });
  await fsp.mkdir(path.join(base, 'extension', 'tests', 'nested'), { recursive: true });
  await fsp.mkdir(path.join(base, 'temp', 'qa', 'reliability'), { recursive: true });
  const files = [
    'tests/a.test.mjs', 'tests/b-new.test.mjs', 'tests/notes.txt', 'tests/helper.mjs',
    'tests/sub/deep.test.mjs',
    'extension/tests/x.test.cjs', 'extension/tests/reliability-example.test.cjs', 'extension/tests/readme.md',
    'extension/tests/nested/inner.test.cjs',
    'temp/qa/reliability/archived.test.mjs',
  ];
  for (const rel of files) await fsp.writeFile(path.join(base, rel), '', 'utf8');
  const found = await discoverUnitTests(base);
  assert.deepEqual(found, [
    'extension/tests/reliability-example.test.cjs',
    'extension/tests/x.test.cjs',
    'tests/a.test.mjs',
    'tests/b-new.test.mjs',
  ]);
  await fsp.rm(base, { recursive: true, force: true });
});

test('discoverUnitTests: 真实仓库当前清单与磁盘一致（含并行新增文件，不写死数量）', async () => {
  const expected = [];
  for (const [dir, suffix] of [[path.join(root, 'tests'), '.test.mjs'], [path.join(root, 'extension', 'tests'), '.test.cjs']]) {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(suffix)) expected.push(path.relative(root, path.join(dir, entry.name)).split(path.sep).join('/'));
    }
  }
  expected.sort((a, b) => a.localeCompare(b));
  assert.ok(expected.length > 0, '仓库应已有单元测试');
  assert.deepEqual(await discoverUnitTests(root), expected);
});

test('discoverUnitTests: 目录全部不可读或零测试都显式报错，不允许空跑', async () => {
  const base = await tempDir('reliability-empty-');
  await assert.rejects(() => discoverUnitTests(base), RunnerError);
  await fsp.mkdir(path.join(base, 'tests'), { recursive: true });
  await fsp.writeFile(path.join(base, 'tests', 'readme.txt'), '', 'utf8');
  await assert.rejects(() => discoverUnitTests(base), RunnerError);
  await fsp.rm(base, { recursive: true, force: true });
});

test('NATIVE_ALLOWLIST: 固定四个已审计脚本与参数（wait-lifecycle 无 baseline，custom-controls current+reliability）', async () => {
  assert.deepEqual(NATIVE_ALLOWLIST.map(entry => entry.file), [
    'tests/browser-frozen.py',
    'tests/browser-lifecycle-wake.py',
    'tests/browser-custom-controls.py',
    'tests/browser-wait-lifecycle.py',
  ]);
  const byId = Object.fromEntries(NATIVE_ALLOWLIST.map(entry => [entry.id, entry]));
  assert.deepEqual(byId['browser-custom-controls'].fixedArgs, ['--source', 'current', '--label', 'reliability']);
  assert.deepEqual(byId['browser-wait-lifecycle'].fixedArgs, []);
  for (const entry of NATIVE_ALLOWLIST) {
    await assert.ok(fs.existsSync(path.join(root, entry.file)), '允许清单文件应存在: ' + entry.file);
  }
});

// ---- native 前置探测（打桩）----

function pythonRunStub({ pythonOk = true, modules = new Set(['websocket', 'playwright']), pyOk = false } = {}) {
  return async (command, args) => {
    if (args.includes('--version')) {
      if (command === 'python' && pythonOk) return { status: 'exited', exitCode: 0, output: 'Python 3.11.4\n' };
      if (command === 'py' && pyOk) return { status: 'exited', exitCode: 0, output: 'Python 3.12.0\n' };
      return { status: 'exited', exitCode: 9009, output: '' };
    }
    const probe = args[args.length - 1];
    if (args.includes('-c') && typeof probe === 'string' && probe.includes('find_spec')) {
      const name = /find_spec\('([^']+)'/.exec(probe)[1];
      return { status: 'exited', exitCode: modules.has(name) ? 0 : 1, output: '' };
    }
    return { status: 'exited', exitCode: 0, output: '' };
  };
}
const edgeExists = candidate => /msedge\.exe$/.test(candidate);

test('checkNativePrereqs: 齐全时通过并给出 python 版本', async () => {
  const result = await checkNativePrereqs({ runCapture: pythonRunStub(), exists: edgeExists, platform: 'win32', env: {} });
  assert.equal(result.ok, true);
  assert.deepEqual(result.missing, []);
  assert.equal(result.python.command, 'python');
  assert.match(result.python.version, /Python 3\.11\.4/);
});

test('checkNativePrereqs: python 缺失时明确失败并跳过其余探测', async () => {
  const result = await checkNativePrereqs({ runCapture: pythonRunStub({ pythonOk: false }), exists: edgeExists, platform: 'win32', env: {} });
  assert.equal(result.ok, false);
  assert.ok(result.missing.includes('python3'));
  assert.ok(result.checks.some(check => check.name === 'edge' && !check.ok));
});

test('checkNativePrereqs: 模块缺失逐项列出，绝不静默跳过', async () => {
  const result = await checkNativePrereqs({ runCapture: pythonRunStub({ modules: new Set(['websocket']) }), exists: edgeExists, platform: 'win32', env: {} });
  assert.equal(result.ok, false);
  assert.ok(result.missing.includes('python-module:playwright'));
  assert.ok(!result.missing.includes('python-module:websocket'));
});

test('checkNativePrereqs: py 启动器回退与 Edge 环境变量覆盖', async () => {
  const viaPy = await checkNativePrereqs({ runCapture: pythonRunStub({ pythonOk: false, pyOk: true }), exists: edgeExists, platform: 'win32', env: {} });
  assert.equal(viaPy.ok, true);
  assert.equal(viaPy.python.command, 'py');
  assert.deepEqual(viaPy.python.pre, ['-3']);

  const noEdge = await checkNativePrereqs({ runCapture: pythonRunStub(), exists: () => false, platform: 'win32', env: { FROZEN_TEST_EDGE: 'C:/missing/msedge.exe' } });
  assert.equal(noEdge.ok, false);
  assert.ok(noEdge.missing.includes('edge'));
  assert.ok(noEdge.checks.find(check => check.name === 'edge').detail.includes('未找到 Edge'));
});

// ---- 子进程执行与失败透传（打桩 + 最小真实进程）----

function stubChild({ exitCode = 0, delayMs = 5, hang = false } = {}) {
  const child = new EventEmitter();
  child.pid = 4242 + Math.floor(Math.random() * 100);
  child.kill = () => {
    if (hang && child.listenerCount('exit') > 0) setTimeout(() => child.emit('exit', null, 'SIGKILL'), 2);
    return true;
  };
  if (!hang) setTimeout(() => child.emit('exit', exitCode, null), delayMs);
  return child;
}

test('runChild: 退出码原样透传并分类', async () => {
  const fail = await runChild({ command: 'stub', args: [], spawnImpl: () => stubChild({ exitCode: 3 }) });
  assert.equal(fail.status, 'exited');
  assert.equal(fail.exitCode, 3);
  assert.equal(classifyChildResult(fail), 'fail');

  const pass = await runChild({ command: 'stub', args: [], spawnImpl: () => stubChild({ exitCode: 0 }) });
  assert.equal(classifyChildResult(pass), 'pass');
});

test('runChild: 超时先杀树再判 timeout，不误判通过', async () => {
  let killed = null;
  const result = await runChild({
    command: 'stub', args: [], timeoutMs: 30, graceMs: 500,
    spawnImpl: () => stubChild({ hang: true }),
    killTree: async child => { killed = child.pid; child.kill(); },
  });
  assert.equal(result.status, 'timeout');
  assert.equal(result.timedOut, true);
  assert.equal(classifyChildResult(result), 'timeout');
  assert.ok(killed !== null, 'killTree 必须被调用');
  assert.ok(Number.isInteger(killed), 'killTree 收到的是子进程 pid');
});

test('runChild: 启动失败（如 ENOENT）归类为 crash 并保留错误信息', async () => {
  // spawnImpl 正常返回子进程对象但异步抛出 error 事件：
  const errored = await runChild({
    command: 'x', args: [], spawnImpl: () => {
      const child = stubChild({ hang: true });
      setTimeout(() => child.emit('error', Object.assign(new Error('spawn x ENOENT'), { code: 'ENOENT' })), 2);
      return child;
    },
  });
  assert.equal(errored.status, 'spawn-error');
  assert.match(errored.spawnError, /ENOENT/);
  assert.equal(classifyChildResult(errored), 'crash');
});

test('runChild: 真实最小子进程的退出码与日志 fd 落盘', async () => {
  const dir = await tempDir('reliability-realchild-');
  const logFile = path.join(dir, 'child.log');
  const fd = fs.openSync(logFile, 'w');
  const fail = await runChild({ command: process.execPath, args: ['-e', 'console.log("out"); console.error("err"); process.exit(7)'], outFd: fd, errFd: fd });
  fs.closeSync(fd);
  assert.equal(fail.status, 'exited');
  assert.equal(fail.exitCode, 7);
  assert.equal(classifyChildResult(fail), 'fail');
  assert.match(fs.readFileSync(logFile, 'utf8'), /out[\s\S]*err/);

  const fd2 = fs.openSync(path.join(dir, 'ok.log'), 'w');
  const pass = await runChild({ command: process.execPath, args: ['-e', 'process.exit(0)'], outFd: fd2, errFd: fd2 });
  fs.closeSync(fd2);
  assert.equal(classifyChildResult(pass), 'pass');
  await fsp.rm(dir, { recursive: true, force: true });
});

// ---- 阶段执行 ----

test('runStage: 顺序执行、逐项日志、失败与崩溃不掩盖后续结果', async () => {
  const dir = await tempDir('reliability-stage-');
  const logDir = path.join(dir, 'stage');
  const seen = [];
  const run = async (entry, context) => {
    seen.push({ label: entry.label, hasFd: Number.isInteger(context.outFd) });
    if (entry.label === 'bad') return { status: 'exited', exitCode: 1, signal: null, timedOut: false, spawnError: null, durationMs: 4 };
    if (entry.label === 'crash') return { status: 'spawn-error', exitCode: null, signal: null, timedOut: false, spawnError: 'ENOENT', durationMs: 1 };
    if (entry.label === 'hang') return { status: 'timeout', exitCode: null, signal: null, timedOut: true, spawnError: null, durationMs: context.timeoutMs };
    return { status: 'exited', exitCode: 0, signal: null, timedOut: false, spawnError: null, durationMs: 2 };
  };
  const stage = await runStage(
    { name: 'unit', entries: [
      { label: 'ok-a', command: 'node', args: ['a'] },
      { label: 'bad', command: 'node', args: ['b'] },
      { label: 'crash', command: 'node', args: ['c'] },
      { label: 'hang', command: 'node', args: ['d'] },
      { label: 'ok-b', command: 'node', args: ['e'] },
    ], fileMs: 1000, stageMs: 60000, logDir },
    { run },
  );
  assert.equal(stage.status, 'timeout'); // 最严重状态上浮
  assert.deepEqual(stage.tests.map(t => t.status), ['pass', 'fail', 'crash', 'timeout', 'pass']);
  assert.deepEqual(seen.map(s => s.label), ['ok-a', 'bad', 'crash', 'hang', 'ok-b']);
  assert.ok(seen.every(s => s.hasFd), '每项都必须拿到真实日志 fd');
  const logs = stage.tests.filter(t => t.log).map(t => t.log);
  assert.equal(logs.length, 5);
  for (const rel of logs) assert.ok(fs.existsSync(path.join(dir, rel)), '日志应落盘: ' + rel);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('runStage: 阶段期限耗尽后剩余项标记 skipped-stage-deadline，不再启动', async () => {
  const dir = await tempDir('reliability-deadline-');
  let started = 0;
  const stage = await runStage(
    { name: 'unit', entries: [
      { label: 'slow', command: 'node', args: ['a'] },
      { label: 'next', command: 'node', args: ['b'] },
    ], fileMs: 1000, stageMs: 5, logDir: path.join(dir, 'stage') },
    { run: async entry => { started++; await new Promise(resolve => setTimeout(resolve, 20)); return { status: 'exited', exitCode: 0, signal: null, timedOut: false, spawnError: null, durationMs: 20 }; } },
  );
  assert.equal(stage.status, 'stage-deadline');
  assert.deepEqual(stage.tests.map(t => t.status), ['pass', 'skipped-stage-deadline']);
  assert.equal(started, 1);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('runStage: 中断后剩余项标记 skipped-interrupted', async () => {
  const dir = await tempDir('reliability-interrupt-');
  const state = { interrupted: false };
  const stage = await runStage(
    { name: 'unit', entries: [{ label: 'a', command: 'node', args: [] }, { label: 'b', command: 'node', args: [] }], fileMs: 1000, stageMs: 60000, logDir: path.join(dir, 'stage'), state },
    { run: async () => { state.interrupted = true; return { status: 'exited', exitCode: 0, signal: null, timedOut: false, spawnError: null, durationMs: 1 }; } },
  );
  assert.deepEqual(stage.tests.map(t => t.status), ['pass', 'skipped-interrupted']);
  await fsp.rm(dir, { recursive: true, force: true });
});

// ---- 汇总退出码 ----

function stageOf(name, statuses) {
  return { name, status: statuses.includes('timeout') ? 'timeout' : statuses.includes('crash') ? 'crash' : statuses.includes('fail') ? 'fail' : 'pass', tests: statuses.map(s => ({ status: s })) };
}

test('computeExit: 前置缺失 > 崩溃/超时 > 失败 > 通过；中断独立', () => {
  assert.equal(computeExit({ stages: [stageOf('unit', ['pass', 'pass'])] }), 0);
  assert.equal(computeExit({ stages: [stageOf('unit', ['pass', 'fail'])] }), 4);
  assert.equal(computeExit({ stages: [stageOf('unit', ['fail']), stageOf('native', ['crash'])] }), 5);
  assert.equal(computeExit({ stages: [stageOf('unit', ['timeout'])] }), 5);
  assert.equal(computeExit({ stages: [{ name: 'native', status: 'prereq-missing', tests: [{ status: 'prereq-missing' }] }] }), 3);
  assert.equal(computeExit({ interrupted: true, stages: [] }), 130);
});

// ---- 真实 CLI 冒烟（--list 与参数拒绝；不执行任何测试套件）----

async function runCli(args, timeoutMs = 30000) {
  const dir = await tempDir('reliability-cli-');
  const logFile = path.join(dir, 'cli.log');
  const fd = fs.openSync(logFile, 'w');
  const result = await runChild({ command: process.execPath, args: [runnerPath, ...args], outFd: fd, errFd: fd, cwd: root, timeoutMs });
  fs.closeSync(fd);
  const output = fs.readFileSync(logFile, 'utf8');
  await fsp.rm(dir, { recursive: true, force: true });
  return { result, output };
}

test('CLI --list: 退出 0，列出与磁盘一致的计划（unit 动态 + native 固定参数）', async () => {
  const { result, output } = await runCli(['--all', '--list']);
  assert.equal(result.exitCode, 0, output);
  assert.match(output, /unit \(\d+\):/);
  assert.match(output, /node tests\/bridge\.test\.mjs/);
  assert.match(output, /node extension\/tests\/mock\.test\.cjs/);
  assert.match(output, /native \(4\):/);
  assert.match(output, /python -B tests\/browser-frozen\.py/);
  assert.match(output, /python -B tests\/browser-custom-controls\.py --source current --label reliability/);
  assert.match(output, /python -B tests\/browser-wait-lifecycle\.py(\s|$)/);
  const expected = await discoverUnitTests(root);
  const listed = output.split(/\r?\n/).filter(line => /^  node /.test(line)).map(line => line.trim().slice(5));
  assert.deepEqual(listed, expected, '--list 输出必须与发现结果一致');
});

test('CLI 参数错误: 退出 2 并给出用法', async () => {
  const bogus = await runCli(['--bogus']);
  assert.equal(bogus.result.exitCode, 2);
  assert.match(bogus.output, /未知参数|--bogus|用法/);
  const conflict = await runCli(['--list', '--dry-run']);
  assert.equal(conflict.result.exitCode, 2);
});

test('CLI --help: 退出 0', async () => {
  const helped = await runCli(['--help']);
  assert.equal(helped.result.exitCode, 0);
  assert.match(helped.output, /--unit/);
});
