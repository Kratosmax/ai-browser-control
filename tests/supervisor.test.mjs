import test from 'node:test';
import assert from 'node:assert/strict';
import { superviseBridge } from '../server/supervisor.mjs';

test('启动即检查，失败有界退避、恢复归零、停止后不再拉起桥', async () => {
  const timers = new Map(), logs = [];
  let calls = 0, healthy = false, sequence = 0;
  const supervisor = superviseBridge({
    ensure: async () => { calls++; if (!healthy) throw new Error('offline'); },
    log: (...entry) => logs.push(entry),
    schedule: (fn, ms) => { const id = ++sequence; timers.set(id, { fn, ms }); return id; },
    cancel: id => timers.delete(id)
  });
  await supervisor.check();
  assert.equal(calls, 1);
  for (const delay of [5000, 10000, 20000, 40000, 60000, 60000]) {
    const [id, timer] = [...timers][0];
    assert.equal(timer.ms, delay);
    timers.delete(id);
    await timer.fn();
  }
  healthy = true;
  await supervisor.check();
  assert.equal([...timers.values()][0].ms, 5000);
  assert(logs.some(([name]) => name === 'supervisor_recovered'));
  supervisor.stop();
  assert.equal(timers.size, 0);
  const before = calls;
  await supervisor.check();
  assert.equal(calls, before);
});

test('检查尚未结束时并发请求只执行一份，停止不再设置后续定时器', async () => {
  let release, calls = 0, scheduled = 0;
  const supervisor = superviseBridge({ ensure: () => { calls++; return new Promise(done => { release = done; }); }, schedule: () => { scheduled++; } });
  const one = supervisor.check(), two = supervisor.check();
  assert.equal(one, two);
  await Promise.resolve();
  assert.equal(calls, 1);
  supervisor.stop(); release(); await one;
  assert.equal(scheduled, 0);
});
