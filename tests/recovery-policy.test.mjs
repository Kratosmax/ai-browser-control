import test from 'node:test';
import assert from 'node:assert/strict';
import { recoveryForError, versionHealthForStatus } from '../server/recovery-policy.mjs';

test('unknown outcomes never become proof of no dispatch or automatic retry', () => {
  for (const code of ['STALE_REF','TAB_FROZEN','TAB_BUSY','COMMAND_TIMEOUT','CDP_DISABLED','PAGE_AGENT_API_ERROR','PRIVATE-CODE']) {
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
