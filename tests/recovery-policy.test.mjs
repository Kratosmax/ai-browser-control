import test from 'node:test';
import assert from 'node:assert/strict';
import { recoveryForError, versionHealthForStatus } from '../server/recovery-policy.mjs';

test('unknown outcomes never become proof of no dispatch or automatic retry', () => {
  for (const code of ['STALE_REF','TAB_FROZEN','TAB_BUSY','COMMAND_TIMEOUT','CDP_DISABLED','PAGE_AGENT_API_ERROR','BROWSER_MODE_MISMATCH','NO_BROWSER_WINDOW','BROWSER_MODE_EXTENSION_UPDATE_REQUIRED','PRIVATE-CODE']) {
    for (const outcome of [undefined,'unverified','verified','ok',false]) {
      const result = recoveryForError({code,outcome});
      assert.equal(result.outcome,'unverified'); assert.equal(result.automaticReplay,false);
    }
    assert.equal(recoveryForError({code,outcome:'not-dispatched'}).outcome,'not-dispatched');
  }
});
test('known target, lifecycle, running-operation and internal faults have distinct actionable handling', () => {
  const stale=recoveryForError({code:'STALE_REF'}), lifecycle=recoveryForError({code:'TAB_FROZEN'}),
    busy=recoveryForError({code:'TAB_BUSY',outcome:'not-dispatched'}), broken=recoveryForError({code:'PAGE_AGENT_EMPTY_RESULT'});
  assert.equal(stale.action,'reidentify-target'); assert.equal(stale.maintenanceRequired,false);
  assert.equal(lifecycle.action,'verify-page-lifecycle'); assert.equal(lifecycle.maintenanceRequired,false);
  assert.equal(busy.action,'verify-original-operation'); assert.match(busy.instruction,/旧操作/);
  assert.equal(broken.action,'preserve-and-handoff'); assert.equal(broken.maintenanceRequired,true);
  assert.equal(new Set([stale.category,lifecycle.category,busy.category,broken.category]).size,4);
});
test('recovery metadata is fixed guidance and cannot echo arbitrary diagnostic or business content', () => {
  const error=Object.freeze({code:'PRIVATE-BILLING-CODE',message:'PRIVATE-INPUT',outcome:'PRIVATE-OUTCOME',
    diagnostic:{phase:'PRIVATE-PHASE',url:'PRIVATE-URL',payload:'PRIVATE-CONTENT'}});
  const result=recoveryForError(error);
  assert.equal(result.category,'unclassified'); assert.equal(result.maintenanceRequired,true);
  assert(!JSON.stringify(result).includes('PRIVATE'));
  assert.deepEqual(Object.keys(result).sort(),['action','automaticReplay','category','instruction','maintenanceRequired','outcome']);
});

test('version mismatch identifies every unloaded component without declaring page readiness', () => {
  const result=versionHealthForStatus({mcpDiskVersion:'0.17.3',mcpVersion:'0.17.2',version:'0.17.2',extensionVersion:'0.17.1',pending:0,connected:true});
  assert.equal(result.state,'mismatch'); assert.deepEqual(result.mismatches,['mcp','bridge','extension']);
  assert.deepEqual(result.nextActions.map(step=>step.action),['reload-mcp-worker','update-bridge','reload-extension']);
  assert.equal(result.automaticChanges,false); assert.equal(result.pageReadiness,'check-per-page');
});
test('missing version stays unknown, alignment never asserts a working browser', () => {
  assert.equal(versionHealthForStatus({mcpVersion:'0.17.3',version:'0.17.3'}).state,'unknown');
  const aligned=versionHealthForStatus({mcpDiskVersion:'0.17.3',mcpVersion:'0.17.3',version:'0.17.3',extensionVersion:'0.17.3',connected:false});
  assert.equal(aligned.state,'aligned'); assert.equal(aligned.pageReadiness,'check-per-page');
  assert.equal(versionHealthForStatus({mcpVersion:'PRIVATE-VERSION',version:'PRIVATE-BRIDGE'}).state,'unknown');
});

test('browser mode faults give fixed guidance without mode switching, permission edits or incognito push', () => {
  const mismatch = recoveryForError({ code: 'BROWSER_MODE_MISMATCH' });
  const noWindow = recoveryForError({ code: 'NO_BROWSER_WINDOW', outcome: 'not-dispatched' });
  const update = recoveryForError({ code: 'BROWSER_MODE_EXTENSION_UPDATE_REQUIRED' });
  for (const result of [mismatch, noWindow, update]) {
    assert.equal(result.automaticReplay, false);
    assert.match(result.instruction, /不(自行)?修改(扩展)?权限/);
    assert.doesNotMatch(result.instruction, /(请|可|建议|尝试)[^。]{0,8}(开启|启用)无痕/);
  }
  assert.equal(mismatch.category, 'browser-mode'); assert.equal(mismatch.action, 'verify-browser-mode');
  assert.equal(mismatch.maintenanceRequired, false);
  assert.match(mismatch.instruction, /不自行切换/); assert.match(mismatch.instruction, /不开启无痕/);
  assert.equal(noWindow.category, 'browser-window'); assert.equal(noWindow.outcome, 'not-dispatched');
  assert.match(noWindow.instruction, /不自行拉起/);
  assert.equal(update.category, 'extension-update'); assert.equal(update.action, 'reload-extension');
  assert.equal(update.maintenanceRequired, true);
  assert.match(update.instruction, /browser_status/); assert.match(update.instruction, /核对实际版本/);
  assert.equal(new Set([mismatch.category, noWindow.category, update.category]).size, 3);
  assert.equal(recoveryForError({ code: 'CDP_DISABLED' }).category, 'permission');
});

test('committed non-HTTP(S) tab URLs get fixed task-list recovery guidance, never list_tabs or URL echo', () => {
  const notDispatched = recoveryForError({ code: 'UNSUPPORTED_TAB_URL', outcome: 'not-dispatched' });
  assert.equal(notDispatched.category, 'unsupported-tab-url');
  assert.equal(notDispatched.action, 'verify-tab-url');
  assert.equal(notDispatched.maintenanceRequired, false);
  assert.equal(notDispatched.outcome, 'not-dispatched');
  assert.equal(notDispatched.automaticReplay, false);
  // list_tabs 只列 HTTP(S) 页，恢复指引必须指向任务范围内的 browser_task list。
  assert.match(notDispatched.instruction, /browser_task/); assert.match(notDispatched.instruction, /list/);
  assert.match(notDispatched.instruction, /browser_list_tabs/); assert.match(notDispatched.instruction, /只列HTTP/);
  assert.match(notDispatched.instruction, /任务范围/); assert.match(notDispatched.instruction, /url\/pendingUrl|实际地址/);
  // 恢复只允许显式已授权的 HTTP(S) navigate；未知结果不得当作未派发。
  assert.match(notDispatched.instruction, /navigate/); assert.match(notDispatched.instruction, /明确HTTP/);
  assert.match(notDispatched.instruction, /已授权/); assert.match(notDispatched.instruction, /不重放/);
  const unverified = recoveryForError({ code: 'UNSUPPORTED_TAB_URL' });
  assert.equal(unverified.outcome, 'unverified'); assert.equal(unverified.automaticReplay, false);
  const targetState = recoveryForError({ code: 'UNSUPPORTED_TARGET' });
  const lifecycle = recoveryForError({ code: 'TAB_FROZEN' });
  assert.equal(new Set([notDispatched.category, targetState.category, lifecycle.category]).size, 3);
  const echoed = recoveryForError(Object.freeze({ code: 'UNSUPPORTED_TAB_URL', outcome: 'not-dispatched',
    diagnostic: { protocol: 'PRIVATE-PROTOCOL', url: 'PRIVATE-URL', otherExtension: 'PRIVATE-STRING' }, message: 'PRIVATE-DETAIL' }));
  assert(!JSON.stringify(echoed).includes('PRIVATE'));
});
