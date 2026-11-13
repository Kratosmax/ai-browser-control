#!/usr/bin/env node
// 固定可靠性验收入口（task-25 / workstream D）。
// 零运行时依赖，Node 22+。只做验证编排，不改产品运行时。
//
// 用法:
//   node scripts/check-reliability.mjs [--unit|--native|--all] [--list|--dry-run] [--help]
//
// --unit   默认。非递归发现 tests/*.test.mjs 与 extension/tests/*.test.cjs 并逐个执行
//          （含并行开发中的 A/B/C 新测试文件，不硬编码数量或清单）。
// --native 执行固定审计过的原生允许清单（仅私有临时 profile / 随机端口 / 本机夹具，
//          不触碰真实业务页、默认桥 17653、用户配置或全局设置）。
// --all    unit + native。
// --list   只打印计划执行的命令，不执行、不写报告。
// --dry-run 建立计划并做 native 前置探测（不装任何东西），写报告但不执行测试。
//
// 退出码: 0=通过; 2=参数错误; 3=native 前置缺失（明确失败，绝不静默跳过）;
//         4=存在测试失败; 5=崩溃/超时/阶段期限; 6=运行器内部错误; 130=被中断。
// 所有子进程都用 argv 数组直接 spawn（不经 shell），stdio 走日志文件描述符，
// 不使用可能悬挂的 stdio 管道。Windows 超时清理用 taskkill /PID <pid> /T /F 杀本运行器启动的子树。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RUNNER_VERSION = '1.0.0';
export const REPORT_SCHEMA = 'ai-browser-reliability-report/1';

export const EXIT_CODES = Object.freeze({
  PASS: 0,
  USAGE: 2,
  NATIVE_PREREQ_MISSING: 3,
  TESTS_FAILED: 4,
  CRASH_OR_TIMEOUT: 5,
  INTERNAL: 6,
  INTERRUPTED: 130,
});

// 有界期限：单文件与整阶段都必须有上限，超时杀树并显式判失败（不判通过）。
export const LIMITS = Object.freeze({
  unitFileMs: 240_000,
  unitStageMs: 1_800_000,
  nativeFileMs: 900_000,
  nativeStageMs: 3_600_000,
  captureMs: 20_000,
  killGraceMs: 8_000,
});

// 固定原生允许清单：仅这四个已经审计过隔离护栏的脚本（见 RELIABILITY.md）。
// browser-wait-lifecycle.py 不带 --baseline，即“当前源码模式”；
// browser-custom-controls.py 固定 --source current --label reliability（不依赖 git 历史）。
export const NATIVE_ALLOWLIST = Object.freeze([
  Object.freeze({ id: 'browser-frozen', file: 'tests/browser-frozen.py', fixedArgs: Object.freeze([]), modules: Object.freeze(['websocket']) }),
  Object.freeze({ id: 'browser-lifecycle-wake', file: 'tests/browser-lifecycle-wake.py', fixedArgs: Object.freeze([]), modules: Object.freeze(['websocket']) }),
  Object.freeze({ id: 'browser-custom-controls', file: 'tests/browser-custom-controls.py', fixedArgs: Object.freeze(['--source', 'current', '--label', 'reliability']), modules: Object.freeze(['playwright']) }),
  Object.freeze({ id: 'browser-wait-lifecycle', file: 'tests/browser-wait-lifecycle.py', fixedArgs: Object.freeze([]), modules: Object.freeze(['websocket']) }),
]);

export class UsageError extends Error {}
export class RunnerError extends Error {}

export function usageText() {
  return [
    '用法: node scripts/check-reliability.mjs [--unit|--native|--all] [--list|--dry-run] [--help]',
    '',
    '  --unit     默认。运行 tests/*.test.mjs 与 extension/tests/*.test.cjs（非递归发现，含并行新增文件）',
    '  --native   运行固定审计过的原生允许清单（私有临时 profile/随机端口/本机夹具，无真实业务与默认桥）',
    '  --all      unit + native',
    '  --list     只打印计划，不执行、不写报告',
    '  --dry-run  计划 + native 前置探测（不安装），写报告但不执行测试',
    '  --help     显示本说明',
    '',
    '退出码: 0 通过 · 2 参数错误 · 3 native 前置缺失 · 4 测试失败 · 5 崩溃/超时/阶段期限 · 6 内部错误 · 130 中断',
    '报告: temp/qa/reliability/<时间戳>/report.json（机器可读）与 summary.txt（人类可读）',
  ].join('\n');
}

export function toPosix(value) {
  return String(value).split(path.sep).join('/');
}

function safeName(label) {
  const base = path.basename(String(label)).replace(/\.[^.]+$/, '');
  return base.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80) || 'test';
}

function timestampStamp(now = new Date()) {
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${pad(now.getMilliseconds(), 3)}`;
}

export function nodeVersionOk(version = process.version) {
  const match = /^v(\d+)\./.exec(String(version || ''));
  return Boolean(match) && Number(match[1]) >= 22;
}

const MODE_FLAGS = new Set(['--unit', '--native', '--all']);
const MODIFIER_FLAGS = new Set(['--list', '--dry-run']);
const HELP_FLAGS = new Set(['--help', '-h']);

export function parseArgs(argv) {
  let mode = null;
  let list = false;
  let dryRun = false;
  let help = false;
  const seen = new Set();
  for (const raw of argv) {
    const token = String(raw);
    if (HELP_FLAGS.has(token)) {
      if (seen.has(token)) throw new UsageError(`重复参数: ${token}`);
      seen.add(token);
      help = true;
      continue;
    }
    if (MODE_FLAGS.has(token)) {
      if (mode) throw new UsageError(`模式参数互斥: ${mode} 与 ${token}（同时跑 unit+native 请用 --all）`);
      if (seen.has(token)) throw new UsageError(`重复参数: ${token}`);
      seen.add(token);
      mode = token;
      continue;
    }
    if (MODIFIER_FLAGS.has(token)) {
      if (seen.has(token)) throw new UsageError(`重复参数: ${token}`);
      seen.add(token);
      if (token === '--list') list = true;
      else dryRun = true;
      continue;
    }
    if (token.startsWith('-')) throw new UsageError(`未知参数: ${token}`);
    throw new UsageError(`不接受位置参数: ${token}`);
  }
  if (list && dryRun) throw new UsageError('--list 与 --dry-run 互斥');
  return { mode: mode ?? (help ? null : '--unit'), list, dryRun, help };
}

export function defaultSpawn(command, args, options) {
  return spawn(command, args, options);
}

// Windows 上仅终止本运行器启动的子进程树（taskkill /T /F，argv 数组，不经 shell）。
export async function defaultKillTree(child, deps = {}) {
  const spawnImpl = deps.spawnImpl ?? defaultSpawn;
  const pid = child?.pid;
  if (process.platform === 'win32' && pid != null) {
    await new Promise(resolve => {
      let settled = false;
      const done = () => { if (!settled) { settled = true; resolve(); } };
      try {
        const killer = spawnImpl('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        killer.once('exit', done);
        killer.once('error', done);
        setTimeout(done, 5000).unref?.();
      } catch {
        done();
      }
    });
  }
  try { child?.kill('SIGKILL'); } catch { /* 已退出 */ }
}

// 单个子进程执行：stdio 全部指向调用者打开的文件 fd（或 'ignore'），不用管道。
// 结果分类由 classifyChildResult 完成；超时会先杀树再等待真实退出，宽限后强制判 timeout。
export async function runChild(options) {
  const {
    command, args, outFd = 'ignore', errFd = 'ignore',
    cwd, env, timeoutMs = 0, graceMs = LIMITS.killGraceMs,
    spawnImpl = defaultSpawn, killTree = defaultKillTree, onSpawn,
  } = options;
  const startedAt = Date.now();
  let child;
  try {
    child = spawnImpl(command, args, { stdio: ['ignore', outFd, errFd], cwd, env, windowsHide: true });
  } catch (error) {
    return { status: 'spawn-error', exitCode: null, signal: null, timedOut: false, spawnError: errorMessage(error), durationMs: Date.now() - startedAt };
  }
  if (!child || typeof child.once !== 'function') {
    return { status: 'spawn-error', exitCode: null, signal: null, timedOut: false, spawnError: 'spawnImpl 未返回可监听 exit/error 的子进程', durationMs: Date.now() - startedAt };
  }
  if (typeof onSpawn === 'function') { try { onSpawn(child); } catch { /* 观察回调不失效 */ } }
  return await new Promise(resolve => {
    let settled = false;
    let timedOutFlag = false;
    let timer = null;
    let grace = null;
    const finish = result => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (grace) clearTimeout(grace);
      resolve({ spawnError: null, exitCode: null, signal: null, timedOut: timedOutFlag, ...result, durationMs: Date.now() - startedAt });
    };
    child.once?.('error', error => finish({ status: 'spawn-error', spawnError: errorMessage(error) }));
    child.once?.('exit', (code, signal) => finish({ status: timedOutFlag ? 'timeout' : 'exited', exitCode: code ?? null, signal: signal ?? null }));
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timer = null;
        timedOutFlag = true;
        grace = setTimeout(() => finish({ status: 'timeout', exitCode: null, signal: null }), graceMs);
        Promise.resolve(killTree(child)).catch(() => {});
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    }
  });
}

function errorMessage(error) {
  return String(error?.message ?? error);
}

export function classifyChildResult(result) {
  if (!result || result.status === 'spawn-error') return 'crash';
  if (result.status === 'timeout') return 'timeout';
  if (result.signal) return 'crash';
  if (result.status === 'exited' && result.exitCode === 0) return 'pass';
  if (result.status === 'exited' && result.exitCode != null) return 'fail';
  return 'crash'; // exit code 为 null（信号终止且非本运行器超时杀树）
}

// 捕获式命令（git/前置探测）：输出写临时日志文件后回读，同样不用管道。
export async function defaultRunCapture(command, args, options = {}) {
  const { timeoutMs = LIMITS.captureMs, cwd, env, logPath } = options;
  const file = logPath ?? path.join(os.tmpdir(), `reliability-capture-${process.pid}-${Date.now()}.log`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'w');
  try {
    const result = await runChild({ command, args, outFd: fd, errFd: fd, cwd, env, timeoutMs });
    let output = '';
    try { output = fs.readFileSync(file, 'utf8').slice(0, 65536); } catch { /* 读不到输出不算成功 */ }
    return { ...result, output };
  } finally {
    try { fs.closeSync(fd); } catch { /* 已关闭 */ }
  }
}

// 非递归发现：只读这两个固定目录的第一层文件。temp/、归档与历史夹具天然不会被扫到。
export async function discoverUnitTests(rootDir, deps = {}) {
  const readdir = deps.readdir ?? (dir => fsp.readdir(dir, { withFileTypes: true }));
  const sources = [
    { dir: path.join(rootDir, 'tests'), suffix: '.test.mjs' },
    { dir: path.join(rootDir, 'extension', 'tests'), suffix: '.test.cjs' },
  ];
  const found = [];
  const problems = [];
  for (const { dir, suffix } of sources) {
    let entries;
    try {
      entries = await readdir(dir);
    } catch (error) {
      problems.push({ dir: toPosix(path.relative(rootDir, dir)), error: errorMessage(error) });
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(suffix)) continue;
      found.push(toPosix(path.relative(rootDir, path.join(dir, entry.name))));
    }
  }
  if (problems.length > 0) {
    throw new RunnerError('必需测试目录不可读，拒绝漏测判通过: ' + JSON.stringify(problems));
  }
  if (found.length === 0) {
    throw new RunnerError('发现 0 个单元测试文件（tests/*.test.mjs 与 extension/tests/*.test.cjs）；拒绝空跑判通过');
  }
  found.sort((a, b) => a.localeCompare(b));
  return found;
}

// native 前置：只探测本机已有能力，绝不安装。缺任何一项都明确失败（missing 列出明细）。
export async function checkNativePrereqs(deps = {}) {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const runCapture = deps.runCapture ?? defaultRunCapture;
  const exists = deps.exists ?? (candidate => fs.existsSync(candidate));
  const checks = [];
  const missing = [];
  const record = (name, ok, detail) => { checks.push({ name, ok: Boolean(ok), detail: String(detail) }); return Boolean(ok); };

  const candidates = platform === 'win32'
    ? [{ command: 'python', pre: [] }, { command: 'py', pre: ['-3'] }]
    : [{ command: 'python3', pre: [] }, { command: 'python', pre: [] }];
  let python = null;
  const attempts = [];
  for (const candidate of candidates) {
    const result = await runCapture(candidate.command, [...candidate.pre, '--version'], { timeoutMs: LIMITS.captureMs });
    attempts.push(`${candidate.command}: ${result.status}/${result.exitCode ?? 'null'}`);
    const text = result.output || '';
    if (result.status === 'exited' && result.exitCode === 0 && /Python 3[.\d]*/.test(text)) {
      python = { ...candidate, version: (/Python 3[.\d]*/.exec(text) || ['Python 3'])[0] };
      break;
    }
  }
  if (!record('python3', python, python ? `${python.command} ${python.version}` : `未找到 Python 3（尝试: ${attempts.join('；')}）`)) {
    missing.push('python3');
  }

  let edgePath = null;
  if (python) {
    const modules = [...new Set(NATIVE_ALLOWLIST.flatMap(entry => [...entry.modules]))].sort();
    for (const name of modules) {
      const probe = "import importlib.util,sys;sys.exit(0 if importlib.util.find_spec('" + name + "') else 1)";
      const result = await runCapture(python.command, [...python.pre, '-c', probe], { timeoutMs: LIMITS.captureMs });
      const ok = result.status === 'exited' && result.exitCode === 0;
      if (!record('module:' + name, ok, ok ? '已安装' : `Python 模块 ${name} 不可用（${result.status === 'exited' ? 'find_spec 为空' : '探测 ' + result.status}）；按仓库约定不自动安装`)) {
        missing.push('python-module:' + name);
      }
    }
    const overrides = ['FROZEN_TEST_EDGE', 'LIFECYCLE_TEST_EDGE'].map(key => env[key]).filter(Boolean);
    const candidatesEdge = overrides.length > 0 ? overrides : (platform === 'win32' ? [
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    ] : []);
    edgePath = candidatesEdge.find(candidate => exists(candidate)) ?? null;
    if (!record('edge', edgePath, edgePath ? `Edge 可执行文件存在: ${edgePath}` : '未找到 Edge（可设 FROZEN_TEST_EDGE / LIFECYCLE_TEST_EDGE 指向 msedge.exe）')) {
      missing.push('edge');
    }
  } else {
    checks.push({ name: 'edge', ok: false, detail: 'python3 缺失，模块与 Edge 探测未执行' });
  }
  return { ok: missing.length === 0, missing, checks, python, edgePath };
}

export async function collectProvenance(rootDir, deps = {}) {
  const runCapture = deps.runCapture ?? defaultRunCapture;
  const provenance = { productVersion: null, gitAvailable: false, commit: null, branch: null, dirty: null, dirtyEntries: [], warnings: [] };
  try {
    const version = JSON.parse(fs.readFileSync(path.join(rootDir,'.zcode-plugin','plugin.json'),'utf8')).version;
    if (typeof version === 'string' && /^\d+\.\d+\.\d+$/.test(version)) provenance.productVersion=version;
    else provenance.warnings.push('产品版本缺失或格式无效，保留未知');
  } catch { provenance.warnings.push('无法读取产品版本，保留未知'); }
  const git = args => runCapture('git', args, { cwd: rootDir, timeoutMs: LIMITS.captureMs });
  const head = await git(['rev-parse', 'HEAD']);
  if (head.status !== 'exited' || head.exitCode !== 0) {
    provenance.warnings.push('git 不可用或非 git 仓库，无法钉住 commit（' + (head.spawnError || (head.output || '').split(/\r?\n/)[0] || head.status) + '）');
    return provenance;
  }
  provenance.gitAvailable = true;
  provenance.commit = (head.output || '').trim();
  const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD']);
  provenance.branch = branch.status === 'exited' && branch.exitCode === 0 ? (branch.output || '').trim() : null;
  if (provenance.branch === null) provenance.warnings.push('git 分支查询未完成，保留未知');
  const status = await git(['status', '--porcelain=v1']);
  const statusKnown = status.status === 'exited' && status.exitCode === 0;
  const lines = statusKnown ? (status.output || '').split(/\r?\n/).filter(Boolean) : [];
  provenance.dirty = statusKnown ? lines.length > 0 : null;
  if (!statusKnown) provenance.warnings.push('git 状态查询未完成，工作树是否干净保持未知');
  provenance.dirtyEntries = lines.slice(0, 500);
  if (lines.length > 500) provenance.warnings.push(`git 状态条目过多，仅记录前 500/共 ${lines.length} 条`);
  if (provenance.dirty) provenance.warnings.push(`工作树非干净（${lines.length} 条变更，含并行开发中的文件）；报告按当前磁盘状态钉住`);
  return provenance;
}

const STAGE_SEVERITY = { pass: 0, fail: 1, crash: 2, timeout: 3, 'stage-deadline': 4, interrupted: 5, 'prereq-missing': 5 };

function worseStatus(current, next) {
  if (!(next in STAGE_SEVERITY)) return current;
  if (!(current in STAGE_SEVERITY)) return next;
  return STAGE_SEVERITY[next] > STAGE_SEVERITY[current] ? next : current;
}

// 阶段执行：顺序逐项，先检查阶段剩余预算再启动；单文件超时=剩余预算与文件上限取小。
export async function runStage(stageOptions, deps = {}) {
  const { name, entries, fileMs, stageMs, logDir, state = { interrupted: false } } = stageOptions;
  const run = deps.run ?? ((entry, context) => runChild({
    command: entry.command, args: entry.args, outFd: context.outFd, errFd: context.errFd,
    cwd: entry.cwd, env: entry.env, timeoutMs: context.timeoutMs,
    spawnImpl: deps.spawnImpl ?? defaultSpawn, killTree: deps.killTree ?? defaultKillTree,
    onSpawn: child => { state.currentChild = child; },
  }));
  const reportRelBase = path.dirname(logDir);
  const startedAt = Date.now();
  let outcome = 'pass';
  const tests = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (state.interrupted) {
      tests.push({ ...entry, status: 'skipped-interrupted', exitCode: null, signal: null, timedOut: false, spawnError: null, durationMs: null, log: null });
      outcome = worseStatus(outcome, 'interrupted');
      continue;
    }
    const remaining = stageMs - (Date.now() - startedAt);
    if (remaining <= 0) {
      tests.push({ ...entry, status: 'skipped-stage-deadline', exitCode: null, signal: null, timedOut: false, spawnError: null, durationMs: null, log: null });
      outcome = worseStatus(outcome, 'stage-deadline');
      continue;
    }
    const logFile = path.join(logDir, 'logs', `${name}-${String(index + 1).padStart(2, '0')}-${safeName(entry.label)}.log`);
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const fd = fs.openSync(logFile, 'w');
    let result;
    try {
      result = await run(entry, { outFd: fd, errFd: fd, timeoutMs: Math.min(fileMs, remaining), logFile });
    } catch (error) {
      result = { status: 'spawn-error', exitCode: null, signal: null, timedOut: false, spawnError: errorMessage(error), durationMs: null };
    } finally {
      try { fs.closeSync(fd); } catch { /* 已关闭 */ }
    }
    const status = classifyChildResult(result);
    tests.push({
      label: entry.label, command: entry.command, args: entry.args,
      status, exitCode: result.exitCode ?? null, signal: result.signal ?? null,
      timedOut: result.timedOut === true, spawnError: result.spawnError ?? null,
      durationMs: result.durationMs ?? null, log: toPosix(path.relative(reportRelBase, logFile)),
    });
    outcome = worseStatus(outcome, status);
    if (typeof deps.onTestEnd === 'function') {
      try { deps.onTestEnd({ stage: name, index, total: entries.length, entry, status, result }); } catch { /* 汇报回调不失效 */ }
    }
  }
  return { name, status: outcome, startedAt: new Date(startedAt).toISOString(), durationMs: Date.now() - startedAt, deadlineMs: stageMs, fileDeadlineMs: fileMs, tests };
}

export function computeExit(report) {
  if (report?.interrupted) return EXIT_CODES.INTERRUPTED;
  const stages = report?.stages ?? [];
  const statuses = stages.flatMap(stage => [stage.status, ...(stage.tests ?? []).map(test => test.status)]);
  if (statuses.includes('skipped-interrupted')) return EXIT_CODES.INTERRUPTED;
  if (statuses.includes('prereq-missing')) return EXIT_CODES.NATIVE_PREREQ_MISSING;
  if (statuses.includes('skipped-stage-deadline')) return EXIT_CODES.CRASH_OR_TIMEOUT;
  if (!report?.dryRun && statuses.includes('planned')) return EXIT_CODES.INTERNAL;
  if (statuses.some(status => status === 'timeout' || status === 'crash' || status === 'stage-deadline')) return EXIT_CODES.CRASH_OR_TIMEOUT;
  if (statuses.includes('fail')) return EXIT_CODES.TESTS_FAILED;
  return EXIT_CODES.PASS;
}

function summarize(stages) {
  const byStatus = {};
  let total = 0;
  for (const stage of stages) for (const test of stage.tests ?? []) {
    total++;
    byStatus[test.status] = (byStatus[test.status] ?? 0) + 1;
  }
  return { total, byStatus };
}

function humanSummaryBlock(report) {
  const lines = [];
  lines.push(`mode=${report.mode}${report.dryRun ? ' --dry-run' : ''}${report.list ? ' --list' : ''} node=${report.runner.node} platform=${report.runner.platform}`);
  lines.push(`provenance: commit=${report.provenance.commit ?? 'unavailable'} branch=${report.provenance.branch ?? '?'} dirty=${String(report.provenance.dirty)}`);
  for (const stage of report.stages) {
    const counts = {};
    for (const test of stage.tests ?? []) counts[test.status] = (counts[test.status] ?? 0) + 1;
    lines.push(`stage ${stage.name}: ${stage.status} (${(stage.tests ?? []).length} 项, ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ') || '无'}) ${Math.round((stage.durationMs ?? 0) / 100) / 10}s`);
  }
  for (const warning of report.warnings) lines.push('warning: ' + warning);
  lines.push(`RESULT: ${report.result} (exit ${report.exitCode})`);
  return lines.join('\n');
}

export async function main(deps = {}) {
  const argv = deps.argv ?? process.argv.slice(2);
  const rootDir = deps.rootDir ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const reportRoot = deps.reportRoot ?? path.join(rootDir, 'temp', 'qa', 'reliability');
  const log = deps.log ?? (line => process.stdout.write(line + '\n'));
  const errLog = deps.errLog ?? (line => process.stderr.write(line + '\n'));
  const state = deps.state ?? { interrupted: false };

  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    errLog('参数错误: ' + errorMessage(error));
    errLog(usageText());
    return { exitCode: EXIT_CODES.USAGE, report: null, reportDir: null };
  }
  if (parsed.help) {
    log(usageText());
    return { exitCode: EXIT_CODES.PASS, report: null, reportDir: null };
  }
  if (!nodeVersionOk(deps.nodeVersion ?? process.version)) {
    errLog(`需要 Node.js 22+（当前 ${deps.nodeVersion ?? process.version}）`);
    return { exitCode: EXIT_CODES.INTERNAL, report: null, reportDir: null };
  }

  const mode = parsed.mode; // '--unit' | '--native' | '--all'
  const wantUnit = mode === '--unit' || mode === '--all';
  const wantNative = mode === '--native' || mode === '--all';
  const now = deps.now ?? (() => new Date());

  let unitFiles = [];
  if (wantUnit) {
    try {
      unitFiles = await discoverUnitTests(rootDir, deps);
    } catch (error) {
      errLog((error instanceof RunnerError ? '' : '内部错误: ') + errorMessage(error));
      return { exitCode: EXIT_CODES.INTERNAL, report: null, reportDir: null };
    }
  }

  const nativeEntries = wantNative
    ? NATIVE_ALLOWLIST.map(entry => ({ label: entry.file, allowlistId: entry.id, file: entry.file, fixedArgs: [...entry.fixedArgs] }))
    : [];

  if (parsed.list) {
    log(`unit (${unitFiles.length}):`);
    for (const file of unitFiles) log('  node ' + file);
    log(`native (${nativeEntries.length}):`);
    for (const entry of nativeEntries) log('  python -B ' + entry.file + (entry.fixedArgs.length ? ' ' + entry.fixedArgs.join(' ') : ''));
    return { exitCode: EXIT_CODES.PASS, report: null, reportDir: null };
  }

  const startedAt = now();
  const reportDir = path.join(reportRoot, timestampStamp(startedAt));
  const logDir = path.join(reportDir, 'stage');
  fs.mkdirSync(path.join(logDir, 'logs'), { recursive: true });
  const captureDir = path.join(reportDir, 'captures');
  fs.mkdirSync(captureDir, { recursive: true });
  let captureSeq = 0;
  const captureRun = (command, args, options = {}) => {
    captureSeq += 1;
    const logPath = path.join(captureDir, `capture-${String(captureSeq).padStart(2, '0')}-${safeName(command)}.log`);
    return (deps.runCapture ?? defaultRunCapture)(command, args, { ...options, logPath });
  };

  const report = {
    schema: REPORT_SCHEMA,
    runnerVersion: RUNNER_VERSION,
    generatedAt: startedAt.toISOString(),
    localTimestamp: timestampStamp(startedAt),
    mode, list: false, dryRun: parsed.dryRun,
    runner: { node: deps.nodeVersion ?? process.version, platform: process.platform, argv: [process.execPath, ...argv], pid: process.pid },
    root: rootDir,
    provenance: null,
    limits: { ...LIMITS },
    nativeAllowlist: NATIVE_ALLOWLIST.map(entry => ({ ...entry, fixedArgs: [...entry.fixedArgs], modules: [...entry.modules] })),
    plan: {
      unit: unitFiles.map(file => ({ file, command: process.execPath, args: [file] })),
      native: nativeEntries.map(entry => ({ file: entry.file, fixedArgs: entry.fixedArgs })),
    },
    prereq: null,
    stages: [],
    summary: null,
    result: null,
    exitCode: null,
    interrupted: false,
    warnings: [],
  };
  const finish = () => {
    report.summary = summarize(report.stages);
    report.exitCode = computeExit(report);
    report.result = report.exitCode === EXIT_CODES.PASS ? 'pass'
      : report.exitCode === EXIT_CODES.NATIVE_PREREQ_MISSING ? 'prereq-missing'
      : report.exitCode === EXIT_CODES.INTERRUPTED ? 'interrupted'
      : 'fail';
    const json = JSON.stringify(report, null, 2);
    fs.writeFileSync(path.join(reportDir, 'report.json'), json, 'utf8');
    const summary = humanSummaryBlock(report);
    fs.writeFileSync(path.join(reportDir, 'summary.txt'), summary + '\n', 'utf8');
    log('');
    log('== reliability runner ==');
    log(summary);
    log('report: ' + toPosix(path.relative(rootDir, path.join(reportDir, 'report.json'))));
    return { exitCode: report.exitCode, report, reportDir };
  };

  report.provenance = await collectProvenance(rootDir, { runCapture: captureRun });
  report.warnings.push(...report.provenance.warnings);

  if (parsed.dryRun) {
    if (wantUnit) {
      report.stages.push({
        name: 'unit', status: 'planned', startedAt: startedAt.toISOString(), durationMs: 0,
        deadlineMs: LIMITS.unitStageMs, fileDeadlineMs: LIMITS.unitFileMs,
        tests: unitFiles.map(file => ({ label: file, command: process.execPath, args: [file], status: 'planned', exitCode: null, signal: null, timedOut: false, spawnError: null, durationMs: null, log: null })),
      });
    }
    if (wantNative) {
      const prereq = await checkNativePrereqs({ ...deps, runCapture: captureRun });
      report.prereq = prereq;
      report.stages.push({
        name: 'native', status: prereq.ok ? 'planned' : 'prereq-missing', startedAt: new Date().toISOString(), durationMs: 0,
        deadlineMs: LIMITS.nativeStageMs, fileDeadlineMs: LIMITS.nativeFileMs,
        tests: nativeEntries.map(entry => ({
          label: entry.file,
          command: prereq.python ? prereq.python.command : null,
          args: prereq.python ? [...prereq.python.pre, '-B', entry.file, ...entry.fixedArgs] : entry.fixedArgs,
          status: prereq.ok ? 'planned' : 'prereq-missing',
          exitCode: null, signal: null, timedOut: false,
          spawnError: prereq.ok ? null : '缺少前置: ' + prereq.missing.join(', '),
          durationMs: null, log: null,
        })),
      });
      if (!prereq.ok) {
        errLog('native 前置缺失，按约定明确失败（不安装、不静默跳过）: ' + prereq.missing.join(', '));
        for (const check of prereq.checks) errLog('  [' + (check.ok ? 'ok' : 'MISSING') + '] ' + check.name + ': ' + check.detail);
      }
    }
    return finish();
  }

  const onTestEnd = event => {
    const mark = `[${event.stage} ${event.index + 1}/${event.total}] ${(event.status || '?').toUpperCase().padEnd(7)} ${event.entry.label}`;
    const seconds = event.result?.durationMs != null ? ` (${Math.round(event.result.durationMs / 100) / 10}s)` : '';
    log(mark + seconds);
  };

  if (wantUnit) {
    const entries = unitFiles.map(file => ({ label: file, command: process.execPath, args: [file], cwd: rootDir, env: process.env }));
    report.stages.push(await runStage(
      { name: 'unit', entries, fileMs: LIMITS.unitFileMs, stageMs: LIMITS.unitStageMs, logDir, state },
      { ...deps, onTestEnd },
    ));
  }

  if (wantNative) {
    const prereq = await checkNativePrereqs({ ...deps, runCapture: captureRun });
    report.prereq = prereq;
    if (!prereq.ok) {
      errLog('native 前置缺失，按约定明确失败（不安装、不静默跳过）: ' + prereq.missing.join(', '));
      for (const check of prereq.checks) errLog('  [' + (check.ok ? 'ok' : 'MISSING') + '] ' + check.name + ': ' + check.detail);
      report.stages.push({
        name: 'native', status: 'prereq-missing', startedAt: new Date().toISOString(), durationMs: 0,
        deadlineMs: LIMITS.nativeStageMs, fileDeadlineMs: LIMITS.nativeFileMs,
        tests: nativeEntries.map(entry => ({
          label: entry.file, command: null, args: entry.fixedArgs, status: 'prereq-missing',
          exitCode: null, signal: null, timedOut: false, spawnError: '缺少前置: ' + prereq.missing.join(', '),
          durationMs: null, log: null,
        })),
      });
    } else {
      const entries = nativeEntries.map(entry => ({
        label: entry.file,
        command: prereq.python.command,
        args: [...prereq.python.pre, '-B', entry.file, ...entry.fixedArgs],
        cwd: rootDir, env: process.env,
      }));
      report.plan.native = entries.map(entry => ({ file: entry.label, command: entry.command, args: entry.args }));
      report.stages.push(await runStage(
        { name: 'native', entries, fileMs: LIMITS.nativeFileMs, stageMs: LIMITS.nativeStageMs, logDir, state },
        { ...deps, onTestEnd },
      ));
    }
  }

  if (state.interrupted) report.interrupted = true;
  return finish();
}

const invokedAsScript = (() => {
  try {
    return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (invokedAsScript) {
  const state = { interrupted: false, currentChild: null };
  const interrupt = () => {
    if (state.interrupted) return;
    state.interrupted = true;
    process.stderr.write('收到中断信号：停止后续测试并尽快写部分报告\n');
    Promise.resolve(defaultKillTree(state.currentChild)).catch(() => {});
  };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  main({ state }).then(outcome => {
    process.exit(outcome.exitCode);
  }).catch(error => {
    process.stderr.write('运行器内部错误: ' + errorMessage(error) + '\n');
    process.exit(EXIT_CODES.INTERNAL);
  });
}
