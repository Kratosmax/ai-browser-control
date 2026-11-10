// 仅监督桥进程，不重放任何浏览器命令。远端桥由所在机器管理。
export function superviseBridge({ ensure, log = () => {}, intervalMs = 5000, maxDelayMs = 60000,
  schedule = setTimeout, cancel = clearTimeout } = {}) {
  let stopped = false;
  let timer;
  let checking;
  let failures = 0;
  const check = () => {
    if (stopped) return Promise.resolve();
    if (checking) return checking;
    cancel(timer);
    checking = Promise.resolve().then(ensure).then(result => {
      if (result?.launched) log('supervisor_bridge_launch', { pid: result.pid });
      if (failures) log('supervisor_recovered', { failures });
      failures = 0;
    }, error => {
      failures++;
      log('supervisor_failed', { failures, code: /^[A-Z0-9_]{1,40}$/.test(error?.code) ? error.code : 'UNKNOWN' });
    }).finally(() => {
      checking = null;
      if (!stopped) {
        timer = schedule(check, failures ? Math.min(maxDelayMs, intervalMs * 2 ** Math.min(failures - 1, 5)) : intervalMs);
        timer?.unref?.();
      }
    });
    return checking;
  };
  void check();
  return { check, stop() { stopped = true; cancel(timer); } };
}
