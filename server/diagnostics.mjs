import fs from 'node:fs';
import path from 'node:path';
import { METHODS as SUPPORTED_METHODS } from './protocol.mjs';

export const LOG_MAX_BYTES = 1024 * 1024;
export const LOG_BACKUPS = 2;

// 一个桥进程是日志的唯一写入方；不把子进程 stdout 重定向到这些文件。
export function createLogger(dir, { maxBytes = LOG_MAX_BYTES, backups = LOG_BACKUPS, filename = 'bridge.log' } = {}) {
  const file = path.join(dir, filename);
  const size = name => { try { return fs.statSync(name).size; } catch (e) { if (e.code === 'ENOENT') return 0; throw e; } };
  const trim = name => {
    const length = size(name);
    if (length <= maxBytes) return;
    const fd = fs.openSync(name, 'r');
    const tail = Buffer.alloc(maxBytes);
    try { fs.readSync(fd, tail, 0, maxBytes, length - maxBytes); } finally { fs.closeSync(fd); }
    const newline = tail.indexOf(10);
    fs.writeFileSync(name, newline < 0 ? Buffer.alloc(0) : tail.subarray(newline + 1));
  };
  try {
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i <= backups; i++) trim(i ? `${file}.${i}` : file);
  } catch { /* 诊断不可用不应阻断浏览器操作。 */ }
  return (event, fields = {}) => {
    try {
      const line = Buffer.from(`${JSON.stringify({ time: new Date().toISOString(), event, ...fields })}\n`);
      if (line.length > maxBytes) return;
      trim(file);
      if (size(file) + line.length > maxBytes) {
        if (backups === 0) fs.writeFileSync(file, '');
        else {
          fs.rmSync(`${file}.${backups}`, { force: true });
          for (let i = backups - 1; i >= 1; i--) {
            if (fs.existsSync(`${file}.${i}`)) fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`);
          }
          if (fs.existsSync(file)) fs.renameSync(file, `${file}.1`);
        }
      }
      fs.appendFileSync(file, line);
    } catch { /* 轮转失败时跳过写入，不退回无界追加。 */ }
  };
}

const EVENTS = new Set(['worker_start', 'connection_reset', 'pair_start', 'pair_ok', 'poll_ok', 'transport_error',
  'manual_connect', 'manual_disconnect', 'command_start', 'command_end', 'step_start', 'step_end', 'status_failed', 'page_result']);
const METHODS = new Set(['status', ...SUPPORTED_METHODS]);
const PHASES = new Set(['queue', 'tabs.get', 'tabs.query', 'tabs.update', 'tabs.create', 'windows.get', 'windows.getLastFocused', 'tabs.captureVisibleTab', 'debugger.attach',
  'debugger.detach', 'scripting.inject', 'snapshot', 'scroll', 'inspect', 'prepare', 'focus', 'focusTarget',
  'showCursor', 'cursorPulse', 'hideCursor', 'domClick', 'domFill', 'domPress',
  'domHover', 'holdHover', 'pointerClick', 'domDrag', 'select', 'waitFor',
  'Input.dispatchMouseEvent', 'Input.dispatchKeyEvent', 'Input.insertText', 'Page.captureScreenshot', 'Page.setWebLifecycleState']);

const PAGE_RESULT_ERROR_CODES = new Set(["PAGE_AGENT_EMPTY_RESULT","PAGE_AGENT_NO_RESULT","PAGE_AGENT_INVALID_RESULT","PAGE_AGENT_API_ERROR","PAGE_AGENT_NOT_READY","PAGE_AGENT_METHOD_MISSING","PAGE_AGENT_SYNC_THROW","PAGE_AGENT_PROMISE_REJECTED","PAGE_AGENT_SERIALIZE_FAILED","PAGE_AGENT_DOCUMENT_CHANGED","PAGE_AGENT_FRAME_MISMATCH","PAGE_AGENT_INVALID_OPERATION","PAGE_AGENT_COMMAND_EXPIRED","TAB_FROZEN","TAB_DISCARDED","PAGE_WAKE_FAILED","PAGE_WAKE_TIMEOUT","CDP_DISABLED","PAGE_ACTION_FAILED","INVALID_PARAMS","INVALID_ARGUMENTS","STALE_REF","REF_EXPIRED","STALE_CURSOR","SNAPSHOT_CHANGED","ELEMENT_NOT_VISIBLE","TARGET_CHANGED","ELEMENT_DISABLED","AMBIGUOUS_TARGET","TARGET_OUTSIDE_VIEWPORT","ELEMENT_OBSCURED","UNSUPPORTED_TARGET","UNSUPPORTED_ACTION"]);

export function pageResultDiagnostic(value) {
  const out = {};
  if (!value || typeof value !== 'object') return out;
  for (const key of ['resultCount', 'frameId', 'durationMs']) {
    if (Number.isSafeInteger(value[key]) && value[key] >= 0) out[key] = value[key];
  }
  for (const key of ['agentPresent', 'documentChanged', 'frozen', 'discarded', 'wakeAttempted', 'wakeVerified']) if (typeof value[key] === 'boolean') out[key] = value[key];
  if (['loading', 'complete'].includes(value.tabStatus)) out.tabStatus = value.tabStatus;
  if (PHASES.has(value.phase)) out.phase = value.phase;
  if (['preflight', 'wake', 'inject', 'invoke', 'decode', 'serialize'].includes(value.stage)) out.stage = value.stage;
  if (['null', 'undefined', 'object', 'array', 'number', 'string', 'boolean'].includes(value.resultKind)) out.resultKind = value.resultKind;
  if (['envelope', 'legacy', 'empty', 'no-result', 'api-error'].includes(value.transportKind)) out.transportKind = value.transportKind;
  if (PAGE_RESULT_ERROR_CODES.has(value.errorCode)) out.errorCode = value.errorCode;
  if (['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'EvalError', 'URIError', 'AggregateError', 'DOMException', 'other'].includes(value.exceptionKind)) out.exceptionKind = value.exceptionKind;
  return out;
}

// 只接受固定元数据；错误正文、网页地址、输入内容等不能进入日志。
export function diagnosticEvent(value) {
  if (!value || !EVENTS.has(value.event)) return null;
  const out = { event: value.event, ...pageResultDiagnostic(value) };
  for (const key of ['time', 'seq', 'epoch', 'port', 'tabId', 'durationMs', 'status', 'retryMs']) {
    if (Number.isSafeInteger(value[key]) && value[key] >= 0) out[key] = value[key];
  }
  for (const key of ['session', 'commandId']) {
    if (typeof value[key] === 'string' && /^[a-zA-Z0-9-]{1,64}$/.test(value[key])) out[key] = value[key];
  }
  if (/^\d+\.\d+\.\d+$/.test(value.version)) out.version = value.version;
  if (METHODS.has(value.method)) out.method = value.method;
  if (PHASES.has(value.phase)) out.phase = value.phase;
  if (['ok', 'error', 'timeout', 'invalidated', 'busy'].includes(value.outcome)) out.outcome = value.outcome;
  return out;
}
