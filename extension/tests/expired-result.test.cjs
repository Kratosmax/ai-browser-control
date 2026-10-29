'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');

// 命令12秒过期或结果已被桥消费后，404不能卡住后续轮询，也不能重复执行动作。
test('/result 404 丢弃过期结果，继续 poll；重复 id 不重执行', async () => {
  const event = { addListener() {} };
  let pairs = 0;
  let polls = 0;
  let posts = 0;
  let actions = 0;
  const timers = new Map();
  let timerId = 0;
  const source = fs.readFileSync(path.resolve(__dirname, '../background.js'), 'utf8');
  const context = vm.createContext({
    URL, AbortController,
    // 假定时器：意外错误的重试 sleep 停在假计时器上，避免真实事件循环挂起。
    setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => timers.delete(id),
    chrome: {
      storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
      runtime: {
        onMessage: event, onInstalled: event, onStartup: event,
        getManifest: () => ({ name: 'AI Browser Control' })
      },
      debugger: { onDetach: event }, tabs: { onRemoved: event },
      alarms: { create: async () => {}, onAlarm: event }
    },
    countAction: () => { actions++; },
    fetch: async (url, options) => {
      if (url.endsWith('/pair')) { pairs++; return { ok: true, status: 200, body: { cancel: async () => {} } }; }
      if (url.endsWith('/result')) {
        posts++;
        return { ok: false, status: 404, body: { cancel: async () => {} } };
      }
      polls++;
      if (polls <= 2) return {
        ok: true, status: 200,
        json: async () => ({ id: 'expired-command', method: 'click', params: { tabId: 7 } })
      };
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }
  });
  vm.runInContext(source, context);
  // 此用例仅验证协议控制流，实际动作在mock.test.cjs另行覆盖。
  vm.runInContext('execute = async () => { countAction(); return {clicked: true}; };', context);
  const run = (code) => vm.runInContext(code, context);
  // 后台循环自启动：配对一次，取到同一条命令两次，动作只执行一次，404 两次后回到 poll。
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pairs, 1);
  assert.equal(polls, 3);
  assert.equal(posts, 2);
  assert.equal(actions, 1);
  assert.equal(run('pendingResult'), null);
  assert(timers.size > 0, '最终停在 poll 等待或重试定时器上，不应退出循环');
});
