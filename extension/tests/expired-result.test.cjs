'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');
const tick = () => new Promise(resolve => setImmediate(resolve));

// 全部传输在VM内模拟，不启动浏览器或连接默认桥。
function deliveryHarness({ status = 200, actionResult = { clicked: true } } = {}) {
  const event = { addListener() {} };
  const stats = { pairs: 0, polls: 0, actions: 0, posts: [] };
  const timers = new Map();
  let timerId = 0;
  const context = vm.createContext({
    URL, AbortController, TextEncoder,
    setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => timers.delete(id),
    chrome: {
      storage: { session: { get: async () => ({}), set: async () => {} }, local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
      runtime: { onMessage: event, onInstalled: event, onStartup: event, getManifest: () => ({ name: 'AI Browser Control' }) },
      debugger: { onDetach: event }, tabs: { onRemoved: event },
      alarms: { create: async () => {}, onAlarm: event }
    },
    countAction: () => { stats.actions++; return actionResult; },
    fetch: async (url, options) => {
      if (url.endsWith('/diagnostics')) return { ok: true, status: 200, body: { cancel: async () => {} } };
      if (url.endsWith('/pair')) { stats.pairs++; return { ok: true, status: 200, body: { cancel: async () => {} } }; }
      if (url.endsWith('/result')) {
        stats.posts.push({ payload: JSON.parse(options.body), bytes: Buffer.byteLength(options.body, 'utf8') });
        return { ok: status < 400, status, body: { cancel: async () => {} } };
      }
      stats.polls++;
      if (stats.polls <= 2) return {
        ok: true, status: 200,
        json: async () => ({ id: 'same-command', method: 'click', params: { tabId: 7 } })
      };
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }
  });
  const run = code => vm.runInContext(code, context);
  context.importScripts = name => run(fs.readFileSync(path.resolve(__dirname, '..', name), 'utf8'));
  run(fs.readFileSync(path.resolve(__dirname, '../background.js'), 'utf8'));
  // 此用例仅验证协议控制流，实际动作在mock.test.cjs另行覆盖。
  run('execute = async () => countAction();');
  return { stats, timers, run };
}

test('/result 404丢弃过期结果继续poll；相同id不重执行', async () => {
  const h = deliveryHarness({ status: 404 });
  await tick();
  assert.equal(h.stats.pairs, 1);
  assert.equal(h.stats.polls, 3);
  assert.equal(h.stats.posts.length, 2);
  assert.equal(h.stats.actions, 1);
  assert.equal(h.run('pendingResult'), null);
  assert(h.timers.size > 0);
});

for (const status of [400, 413, 415, 422]) {
  test('/result HTTP ' + status + '仅回报一次小错误；再次拒绝后继续poll，不重放动作', async () => {
    const h = deliveryHarness({ status });
    await tick();
    assert.equal(h.stats.polls, 3);
    assert.equal(h.stats.actions, 1);
    assert.equal(h.stats.posts.length, 3);
    assert.equal(h.stats.posts[0].payload.result.clicked, true);
    for (const post of h.stats.posts.slice(1)) {
      assert.equal(post.payload.error.code, 'RESULT_REJECTED');
      assert(post.bytes < 1024);
    }
    assert.equal(h.run('pendingResult'), null);
  });
}

for (const [name, actionResult] of [
  ['单张PNG超过12MiB', { data: 'A'.repeat(13 * 1024 * 1024), mimeType: 'image/png' }],
  ['非ASCII字符数小但UTF-8字节超限', { text: '汉'.repeat(4 * 1024 * 1024) }]
]) {
  test(name + '改报RESULT_TOO_LARGE，正常上报并继续poll，不重放动作', async () => {
    const h = deliveryHarness({ actionResult });
    await tick();
    assert.equal(h.stats.polls, 3);
    assert.equal(h.stats.actions, 1);
    assert.equal(h.stats.posts.length, 2);
    for (const post of h.stats.posts) {
      assert.equal(post.payload.error.code, 'RESULT_TOO_LARGE');
      assert(post.bytes < 1024);
    }
    assert.equal(h.run('pendingResult'), null);
  });
}

test('接近10MiB但封装后仍在预算内的截图正常保留', async () => {
  const h = deliveryHarness({ actionResult: { data: 'A'.repeat(10 * 1024 * 1024 - 256), mimeType: 'image/png' } });
  await tick();
  assert.equal(h.stats.actions, 1);
  assert.equal(h.stats.polls, 3);
  assert.equal(h.stats.posts[0].payload.result.mimeType, 'image/png');
  assert(h.stats.posts[0].bytes <= 10 * 1024 * 1024);
});
