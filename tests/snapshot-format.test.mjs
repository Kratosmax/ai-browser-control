import test from 'node:test';
import assert from 'node:assert/strict';
import { compactSnapshot, browserRequestParams } from '../server/snapshot-format.mjs';
import { validateCommand } from '../server/protocol.mjs';

test('精简快照完整还原元素值、未勾选、禁用、遮挡、上下文及覆盖范围', () => {
  const original = { url: 'https://example.test/', coverage: { textTruncated: true }, loading: { complete: false },
    elements: Array.from({ length: 140 }, (_, i) => ({ ref: `r1-${i + 1}`, name: '', role: 'textbox', tag: 'input',
      checked: null, disabled: false, focused: false, expanded: null, editable: true,
      context: '填写花费 花费日期 花费工时（人时） 花费描述', inViewport: true,
      ...(i === 0 ? { checked: false, role: 'checkbox', value: 'false' } : { value: String(i) }),
      ...(i === 1 ? { disabled: true, obscured: true, context: '另一工单' } : {}) })) };
  const before = JSON.stringify(original);
  const compact = compactSnapshot(original);
  const restored = { ...compact, elements: compact.elements.map(item => ({ ...compact.elementDefaults, ...item })) };
  delete restored.format; delete restored.elementDefaults; delete restored.formatNote;
  assert.deepEqual(restored, original);
  assert.equal(JSON.stringify(original), before);
  assert(JSON.stringify(compact).length < before.length * .5);
});

test('缺字段、小结果、空结果不丢失信息', () => {
  for (const original of [{ elements: [] }, { error: 'failed' }, { elements: [{ ref: 'r1-1', checked: false }, { ref: 'r1-2' }] }]) {
    const compact = compactSnapshot(original);
    if (!compact.elementDefaults) assert.deepEqual(compact, original);
    else assert.deepEqual(compact.elements.map(item => ({ ...compact.elementDefaults, ...item })), original.elements);
  }
  const tiny = { elements: [{ ref: 'r1-1', name: '确认' }] };
  assert.deepEqual(compactSnapshot(tiny), tiny);
});

test('单页和批量只在MCP处理format，不改变业务参数、不发给旧桥', () => {
  const args = { tabId: 7, load: 'current', format: 'compact' };
  assert.equal(validateCommand('snapshot', args).method, 'snapshot');
  assert.throws(() => validateCommand('snapshot', { ...args, format: 'guess' }));
  assert.deepEqual(browserRequestParams('browser_snapshot', args), { tabId: 7, load: 'current' });
  const batch = { commands: [{ method: 'snapshot', params: args }, { method: 'click', params: { tabId: 8, ref: 'r1-1' } }] };
  validateCommand('batch', batch);
  const outgoing = browserRequestParams('browser_batch', batch);
  assert.equal(Object.hasOwn(outgoing.commands[0].params, 'format'), false);
  assert.deepEqual(outgoing.commands[1], batch.commands[1]);
  assert.equal(args.format, 'compact');
});

test('查询与分页信息在compact转换及MCP透传中保持完整', () => {
  const query = { tabId: 7, load: 'current', format: 'compact', name: '下载', role: 'button', scope: 'main', limit: 50 };
  const outgoing = browserRequestParams('browser_snapshot', query);
  assert.deepEqual(outgoing, { tabId: 7, load: 'current', name: '下载', role: 'button', scope: 'main', limit: 50 });
  const continuation = { tabId: 7, cursor: 'opaque', format: 'compact' };
  assert.deepEqual(browserRequestParams('browser_snapshot', continuation), { tabId: 7, cursor: 'opaque' });
  const original = { pagination: { snapshotId: 'sample', total: 350, offset: 150, limit: 150, hasMore: true, nextCursor: 'opaque-next' },
    elements: Array.from({ length: 150 }, (_, i) => ({ ref: 'r1-' + (i + 151), name: '下载', role: 'button', disabled: false, context: '订单' + i })) };
  const result = compactSnapshot(original);
  assert.deepEqual(result.pagination, original.pagination);
  assert.deepEqual(result.elements.map(item => ({ ...result.elementDefaults, ...item })), original.elements);
});
