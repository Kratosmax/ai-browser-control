import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCommand, tools } from '../server/protocol.mjs';

test('交互参数覆盖ref按键、等待、分裂按钮、拖拽与状态设置，并拒绝无界或含糊请求', () => {
  for (const [method, params] of [
    ['hover', { tabId: 7, ref: 'r1-1', durationMs: 0 }],
    ['open', { url: 'https://example.test/' }], ['open', { tabId: 7, url: 'https://example.test/' }],
    ['click', { tabId: 7, ref: 'r1-1', button: 'right' }],
    ['click', { tabId: 7, ref: 'r1-1', position: { x: .95, y: .5 } }],
    ['drag', { tabId: 7, fromRef: 'r1-1', toRef: 'r1-2' }],
    ['wait', { tabId: 7, name: '创建需求', role: 'menuitem', timeoutMs: 5000 }],
    ['press', { tabId: 7, ref: 'r1-1', key: 'Alt+ArrowDown' }],
    ['select', { tabId: 7, ref: 'r1-1', values: ['a', 'b'] }],
    ['set_checked', { tabId: 7, ref: 'r1-1', checked: false }]
  ]) assert.equal(validateCommand(method, params).method, method);
  for (const [method, params] of [
    ['hover', { tabId: 7, ref: 'r1-1', durationMs: 60000 }],
    ['open', { url: 'https://example.test/', active: true }],
    ['click', { tabId: 7, ref: 'r1-1', position: { x: -1, y: .5 } }],
    ['click', { tabId: 7, ref: 'r1-1', clickCount: 2, holdMs: 100 }],
    ['wait', { tabId: 7 }], ['wait', { tabId: 7, ref: 'r1-1', text: '猜测' }],
    ['wait', { tabId: 7, text: '菜单', timeoutMs: 60000 }],
    ['drag', { tabId: 7, fromRef: 'r1-1', toRef: 'guess' }],
    ['select', { tabId: 7, ref: 'r1-1', values: ['a', 'a'] }],
    ['set_checked', { tabId: 7, ref: 'r1-1', checked: 'false' }],
    ['inspect', { tabId: 7, ref: 'r1-1', script: 'arbitrary()' }]
  ]) assert.throws(() => validateCommand(method, params), { code: 'INVALID_ARGUMENTS' });
  assert(tools.find(t => t.name === 'browser_press').inputSchema.properties.ref);
});
