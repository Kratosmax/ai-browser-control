// Only fixed recovery guidance is emitted. Never echo page text, URLs, input, or raw exceptions.
const policies = new Map();
function policy(codes, category, action, maintenanceRequired, instruction) {
  for (const code of codes) policies.set(code, { category, action, maintenanceRequired, instruction });
}
policy(['STALE_REF','REF_EXPIRED','STALE_CURSOR','SNAPSHOT_CHANGED','TARGET_CHANGED','PAGE_AGENT_DOCUMENT_CHANGED'],
  'target-changed','reidentify-target',false,'重新读取并核对原业务对象，取得新引用；不要重放刚才的动作。');
policy(['AMBIGUOUS_TARGET'],'ambiguous-target','disambiguate-target',false,'补充能区分同名目标的业务上下文，核对同一对象后再发起新请求。');
policy(['ELEMENT_NOT_VISIBLE','ELEMENT_DISABLED','ELEMENT_OBSCURED','TARGET_OUTSIDE_VIEWPORT','UNSUPPORTED_TARGET','UNSUPPORTED_ACTION'],
  'target-state','inspect-target-state',false,'核对目标当前可见、禁用、遮挡和能力状态；保留当前进度，不绕过限制。');
policy(['TAB_FROZEN','TAB_DISCARDED'],'page-lifecycle','verify-page-lifecycle',false,'确认该页生命周期及旧操作状态；仅使用已有授权的恢复入口，再重新定位，不自动切页、刷新或重放。');
policy(['TAB_BUSY'],'operation-running','verify-original-operation',false,'本次未派发不代表旧操作失败；检查原命令和operation，等底层实际结束，不清锁或重放。');
policy(['COMMAND_NOT_DISPATCHED'],'connection','restore-connection',false,'确认正式命令通道和实际版本恢复，再在原授权范围发起新请求；不自动重放。');
policy(['COMMAND_TIMEOUT','CONNECTION_INVALIDATED'],'outcome-unknown','preserve-and-verify',true,'停止依赖该结果的步骤，保留命令编号、阶段及operation；核对实际状态后交接维护，不自动重放或清锁。');
policy(['CDP_DISABLED','UNAUTHORIZED','PAGE_NOT_AUTHORIZED'],'permission','verify-permission',false,'核对当前页面授权及该用途的独立开关；由用户处理缺口，不自行修改权限或扩大用途。');
policy(['MCP_BUSY','MCP_RESTARTING'],'maintenance-window','wait-for-maintenance',false,'等待正在进行的管理操作结束，再核对实际版本和连接；不重放业务请求。');
policy(['INVALID_PARAMS','INVALID_ARGUMENTS'],'request','correct-request',false,'按当前工具参数约束修正请求；已有动作结果未知时先核对，不能直接重发。');
policy(['INVALID_EXTENSION_RESULT','BRIDGE_INVALID_RESPONSE','BRIDGE_REQUEST_TIMEOUT','BRIDGE_TRANSPORT_ERROR','MCP_WORKER_TIMEOUT','MCP_WORKER_EXITED','MCP_WORKER_STOP_FAILED'],
  'transport-fault','preserve-and-handoff',true,'回传或工作进程未完成可信结果交付；保留命令和阶段，核对正式通道与实际页面状态，不自动重试或重放。');
policy(['PAGE_WAKE_FAILED','PAGE_WAKE_TIMEOUT'],'page-wake','preserve-and-handoff',true,'后台唤醒未完成，保留wake阶段和原命令证据；停止相关步骤，不改用其它CDP用途或反复唤醒。');
policy(['PAGE_AGENT_EMPTY_RESULT','PAGE_AGENT_NO_RESULT','PAGE_AGENT_INVALID_RESULT','PAGE_AGENT_API_ERROR','PAGE_AGENT_NOT_READY','PAGE_AGENT_METHOD_MISSING','PAGE_AGENT_SYNC_THROW','PAGE_AGENT_PROMISE_REJECTED','PAGE_AGENT_SERIALIZE_FAILED','PAGE_AGENT_FRAME_MISMATCH','PAGE_AGENT_COMMAND_EXPIRED','PAGE_ACTION_FAILED'],
  'capability-fault','preserve-and-handoff',true,'保留首错、命令编号、阶段及实际版本，停止依赖该能力的操作并交接维护；不盲目刷新、重载或重放。');
const unknown = Object.freeze({category:'unclassified',action:'preserve-and-handoff',maintenanceRequired:true,
  instruction:'原因尚未分类；保留首错和现有证据，停止依赖该结果的步骤并交接维护，不猜测原因或重放。'});

// Version alignment is not proof that a page or command is idle/usable.
export function versionHealthForStatus(status) {
  const valid = value => typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value) ? value : null;
  const target = valid(status?.mcpDiskVersion) || valid(status?.mcpVersion);
  const components = { mcp: valid(status?.mcpVersion), bridge: valid(status?.version), extension: valid(status?.extensionVersion) };
  const mismatches = target ? Object.keys(components).filter(key => components[key] && components[key] !== target) : [];
  const unknown = !target || Object.values(components).some(value => value === null);
  const steps = { mcp:'reload-mcp-worker', bridge:'update-bridge', extension:'reload-extension' };
  return { state: mismatches.length ? 'mismatch' : unknown ? 'unknown' : 'aligned',
    mismatches, nextActions: mismatches.map(component => ({component,action:steps[component]})),
    automaticChanges: false, pageReadiness: 'check-per-page' };
}

export function recoveryForError(error) {
  const selected = policies.get(error?.code) || unknown;
  const outcome = error?.outcome === 'not-dispatched' ? 'not-dispatched' : 'unverified';
  return { ...selected, outcome, automaticReplay: false };
}
