const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function harness() {
  let next = 10, group = 1, stored = {};
  const tabs = [{ id: 1, windowId: 1, url: 'https://example.test/', active: true, groupId: -1 }];
  const groups = new Map(), busy = new Set(), removed = [];
  const chrome = {
    storage: { session: { get: async () => stored, set: async value => { stored = structuredClone(value); } } },
    tabs: {
      query: async () => tabs.map(tab => ({ ...tab })),
      get: async id => { const tab = tabs.find(tab => tab.id === id); if (!tab) throw new Error('No tab with id: ' + id); return { ...tab }; },
      create: async params => { const tab = { ...params, id: ++next, groupId: -1 }; tabs.push(tab); return { ...tab }; },
      update: async (id, params) => { const tab = tabs.find(tab => tab.id === id); Object.assign(tab, params); return { ...tab }; },
      group: async params => { const id = params.groupId ?? ++group; for (const tab of tabs) if (params.tabIds.includes(tab.id)) tab.groupId = id; return id; },
      remove: async id => { tabs.splice(tabs.findIndex(tab => tab.id === id), 1); removed.push(id); }
    },
    tabGroups: { update: async (id, value) => groups.set(id, value) }
  };
  const context = vm.createContext({ URL });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../tasks.js'), 'utf8'), context);
  const registry = new context.AiBrowserTasks(chrome, id => busy.has(id));
  return { registry, chrome, tabs, groups, busy, removed, restore: () => new context.AiBrowserTasks(chrome, id => busy.has(id)) };
}

test('只复用本任务插件页，同URL用户页、其他任务与不同来源不复用；并发打开只建一个', async () => {
  const h = harness(), p = { url: 'https://example.test/', taskId: 'job-a', taskName: '账单核对' };
  const [one, two] = await Promise.all([h.registry.open(p, 1), h.registry.open(p, 1)]);
  assert.notEqual(one.tab.id, 1);
  assert.equal(one.tab.id, two.tab.id);
  assert.equal(two.reused, true);
  assert.equal(h.groups.get(one.groupId).title, '账单核对');
  assert.notEqual((await h.registry.open({ ...p, taskId: 'job-b' }, 1)).tab.id, one.tab.id);
  const keyed = await h.registry.open({ ...p, url: 'https://example.test/a', reuseKey: 'detail' }, 1);
  assert.equal((await h.registry.open({ ...p, url: 'https://example.test/b', reuseKey: 'detail' }, 1)).tab.id, keyed.tab.id);
  assert.notEqual((await h.registry.open({ ...p, url: 'https://other.test/b', reuseKey: 'detail' }, 1)).tab.id, keyed.tab.id);
  const resumed = h.restore(); await resumed.ready;
  assert.equal((await resumed.open(p, 1)).tab.id, one.tab.id);
});

test('未超限cleanup不关页；finish关闭活动/修改/固定/有声页，仅keep和执行中保留', async () => {
  const h = harness(), p = { url: 'https://example.test/', taskId: 'a', reuse: false };
  const ids = [];
  for (let i = 0; i < 9; i++) ids.push((await h.registry.open(p, 1)).tab.id);
  const other = (await h.registry.open({ ...p, taskId: 'b' }, 1)).tab.id;
  h.tabs.find(tab => tab.id === ids[0]).active = true;
  h.tabs.find(tab => tab.id === ids[1]).pinned = true;
  h.tabs.find(tab => tab.id === ids[2]).audible = true;
  h.busy.add(ids[3]);
  h.registry.markModified(ids[4]);
  await h.registry.task({ action: 'keep', taskId: 'a', keepTabIds: [ids[5]] });
  const clean = await h.registry.task({ action: 'cleanup', taskId: 'a' });
  assert.equal(clean.closed.length, 0);
  const finished = await h.registry.task({ action: 'finish', taskId: 'a' });
  assert.equal(finished.remaining.length, 2);
  for (const reason of ['busy', 'kept']) assert(finished.skipped.some(tab => tab.reason === reason));
  for (const id of [ids[0], ids[1], ids[2], ids[4]]) assert(h.removed.includes(id));
  h.busy.clear();
  assert.equal((await h.registry.task({ action: 'finish', taskId: 'a' })).remaining.length, 1);
  assert(h.tabs.some(tab => tab.id === 1)); assert(h.tabs.some(tab => tab.id === other));
  assert(!h.removed.includes(1) && !h.removed.includes(other));
});

test('用户移出分组的页交还用户；第13个不同key页回收最旧页，keep仍阻止无限新建', async () => {
  const h = harness(), p = { taskId: 'a', url: 'https://example.test/' };
  const moved = await h.registry.open(p, 1);
  h.tabs.find(tab => tab.id === moved.tab.id).groupId = -1;
  await h.registry.task({ taskId: 'a', action: 'finish' });
  assert(!h.removed.includes(moved.tab.id));
  for (let i = 0; i < 12; i++) await h.registry.open({ ...p, url: `https://example.test/${i}` }, 1);
  const old = (await h.registry.task({ taskId: 'a', action: 'list' })).tabs[0].id;
  const newest = await h.registry.open({ ...p, url: 'https://example.test/13' }, 1);
  assert(h.removed.includes(old));
  assert(!h.removed.includes(newest.tab.id));
  assert.equal((await h.registry.task({ taskId: 'a', action: 'list' })).tabs.length, 12);
  const d = harness();
  for (let i = 0; i < 13; i++) await d.registry.open({ ...p, reuse: false }, 1);
  assert(d.tabs.length <= 13);
  assert(d.removed.length > 0);
  const kept = (await d.registry.task({ taskId: 'a', action: 'list' })).tabs.map(tab => tab.id);
  await d.registry.task({ taskId: 'a', action: 'keep', keepTabIds: kept });
  const count = d.tabs.length;
  await assert.rejects(d.registry.open({ ...p, url: 'https://example.test/blocked' }, 1), { code: 'TASK_TAB_LIMIT' });
  assert.equal(d.tabs.length, count, '上限拒绝时不先制造孤立新页');
});

test('分组失败/缺失groupId不清理，删除前移出目标组也不关', async () => {
  const h = harness(), p = { taskId: 'a', url: 'https://example.test/' };
  const group = h.chrome.tabs.group;
  h.chrome.tabs.group = async () => { throw new Error('group failed'); };
  const ungrouped = await h.registry.open(p, 1);
  assert(ungrouped.groupError);
  h.chrome.tabs.group = group;
  const managed = await h.registry.open({ ...p, url: 'https://example.test/managed' }, 1);
  const get = h.chrome.tabs.get;
  h.chrome.tabs.get = async id => {
    if (id === managed.tab.id) h.tabs.find(tab => tab.id === id).groupId = -1;
    return get(id);
  };
  const result = await h.registry.task({ taskId: 'a', action: 'finish' });
  assert.equal(result.closed.length, 0);
  assert.equal(result.skipped.filter(tab => tab.reason === 'outside-task-group').length, 2);
  assert(h.tabs.some(tab => tab.id === ungrouped.tab.id));
  assert(h.tabs.some(tab => tab.id === managed.tab.id));
});

test('仅创建事件中已知AI opener链可纳入同组；用户页与同组非归属页不追认', async () => {
  const h = harness(), p = { taskId: 'a', url: 'https://example.test/' };
  const root = await h.registry.open(p, 1);
  const child = { id: 100, openerTabId: root.tab.id, windowId: 1, groupId: -1 };
  const grandchild = { id: 101, openerTabId: child.id, windowId: 1, groupId: -1 };
  h.tabs.push(child, grandchild);
  // 子页尚在异步分组时，孙页事件也必须保留可核验链。
  const one = h.registry.created({ tabId: child.id, sourceTabId: root.tab.id }), two = h.registry.created({ tabId: grandchild.id, sourceTabId: child.id });
  await Promise.all([one, two]);
  assert.equal(child.groupId, root.groupId);
  assert.equal(grandchild.groupId, root.groupId);
  const user = { id: 102, openerTabId: 1, windowId: 1, groupId: root.groupId };
  const unknown = { id: 103, windowId: 1, groupId: root.groupId };
  const crossWindow = { id: 104, openerTabId: root.tab.id, windowId: 2, groupId: -1 };
  h.tabs.push(user, unknown, crossWindow);
  await Promise.all([h.registry.created({ tabId: user.id, sourceTabId: 1 }), h.registry.created({ tabId: unknown.id }), h.registry.created({ tabId: crossWindow.id, sourceTabId: root.tab.id })]);
  const restored = h.restore(); await restored.ready;
  const done = await restored.task({ taskId: 'a', action: 'finish' });
  assert.deepEqual([...done.closed].sort((a, b) => a - b), [root.tab.id, 100, 101]);
  for (const id of [1, 102, 103, 104]) assert(!h.removed.includes(id));
});

test('导航创建事件唤醒worker时先恢复归属，忽略指向用户活动页的错误opener', async () => {
  const h = harness();
  const root = await h.registry.open({ taskId: 'a', url: 'https://example.test/' }, 1);
  const restored = h.restore();
  const child = { id: 100, openerTabId: 1, windowId: 1, groupId: -1 };
  h.tabs.push(child);
  await restored.created({ tabId: child.id, sourceTabId: root.tab.id });
  assert.equal(restored.tabs.get(child.id).taskId, 'a');
  assert.equal(child.groupId, root.groupId);
  // 尚未获得URL的AI派生页不应让下一次open抛URL解析异常。
  assert((await restored.open({ taskId: 'a', url: 'https://example.test/new' }, 1)).tab.id);
});

test('删除前归属已被交还时，即使页又回到相同组也不能关闭', async () => {
  const h = harness();
  const root = await h.registry.open({ taskId: 'a', url: 'https://example.test/' }, 1);
  const get = h.chrome.tabs.get;
  h.chrome.tabs.get = async id => { h.registry.tabs.delete(id); return get(id); };
  const result = await h.registry.task({ taskId: 'a', action: 'finish' });
  assert.equal(result.closed.length, 0);
  assert.equal(h.removed.length, 0);
  assert(h.tabs.some(tab => tab.id === root.tab.id));
});

test('回收被浏览器拒绝时，上限错误不能使后续open继续制造新页', async () => {
  const h = harness(), p = { taskId: 'a', url: 'https://example.test/', reuse: false };
  for (let i = 0; i < 12; i++) await h.registry.open(p, 1);
  h.chrome.tabs.remove = async () => { throw new Error('browser denied'); };
  await assert.rejects(h.registry.open(p, 1), { code: 'TASK_TAB_LIMIT' });
  const count = h.tabs.length;
  await assert.rejects(h.registry.open(p, 1), { code: 'TASK_TAB_LIMIT' });
  assert.equal(h.tabs.length, count);
});

test('导航来源为用户页或来源移出分组时拒绝连带归属', async () => {
  const h = harness(), p = { taskId: 'a', url: 'https://example.test/' };
  const root = await h.registry.open(p, 1);
  const mismatch = { id: 100, openerTabId: 1, windowId: 1, groupId: -1 };
  h.tabs.push(mismatch);
  await h.registry.created({ tabId: mismatch.id, sourceTabId: 1 });
  h.tabs.find(tab => tab.id === root.tab.id).groupId = -1;
  const moved = { id: 101, openerTabId: root.tab.id, windowId: 1, groupId: -1 };
  h.tabs.push(moved);
  await h.registry.created({ tabId: moved.id, sourceTabId: root.tab.id });
  assert.equal(h.registry.tabs.has(100), false);
  assert.equal(h.registry.tabs.has(101), false);
  await h.registry.task({ taskId: 'a', action: 'finish' });
  assert.equal(h.removed.length, 0);
});

test('独立关闭核验：get的非目标not-found和普通失败不能证明消失，query可独立证实消失', async () => {
  for (const failure of ['transport failed', 'No tab with id: 999999.']) {
    const h = harness();
    const { tab } = await h.registry.open({ taskId: 'a', url: 'https://example.test/verify' }, 1);
    const get = h.chrome.tabs.get;
    let removed = false;
    h.chrome.tabs.remove = async () => { removed = true; };
    h.chrome.tabs.get = async id => { if (removed) throw new Error(failure); return get(id); };
    const result = await h.registry.task({ action: 'close', taskId: 'a', tabIds: [tab.id] });
    assert.equal(result.closedCount, 0);
    assert.equal(result.skipped[0].reason, 'close-not-confirmed');
    assert(h.registry.tabs.has(tab.id));
    assert(!result.summary.includes('完成清理'));
  }
  const h = harness();
  const { tab } = await h.registry.open({ taskId: 'a', url: 'https://example.test/query-proof' }, 1);
  const get = h.chrome.tabs.get, remove = h.chrome.tabs.remove;
  let removed = false;
  h.chrome.tabs.remove = async id => { await remove(id); removed = true; };
  h.chrome.tabs.get = async id => { if (removed) throw new Error('transport failed'); return get(id); };
  const result = await h.registry.task({ action: 'close', taskId: 'a', tabIds: [tab.id] });
  assert.deepEqual([...result.closed], [tab.id]);
  assert.equal(result.closedCount, 1);
});

test('关闭后的get与query均失败时保留归属，不能将核验错误当作不存在', async () => {
  const h = harness();
  const { tab } = await h.registry.open({ taskId: 'a', url: 'https://example.test/uncertain' }, 1);
  const get = h.chrome.tabs.get, query = h.chrome.tabs.query;
  let removed = false;
  h.chrome.tabs.remove = async () => { removed = true; };
  h.chrome.tabs.get = async id => { if (removed) throw new Error('permission denied'); return get(id); };
  h.chrome.tabs.query = async () => { if (removed) throw new Error('query unavailable'); return query(); };
  const result = await h.registry.task({ action: 'close', taskId: 'a', tabIds: [tab.id] });
  assert.equal(result.closedCount, 0);
  assert.equal(result.skipped[0].reason, 'close-not-confirmed');
  assert(h.registry.tabs.has(tab.id));
});

test('超限期间旧页变为busy时拒绝新open，不能回收新页后返回已关闭tabId', async () => {
  const h = harness(), p = { taskId: 'a', url: 'https://example.test/', reuse: false };
  for (let i = 0; i < 12; i++) await h.registry.open(p, 1);
  const oldIds = [...h.registry.tabs.keys()];
  const create = h.chrome.tabs.create;
  let created;
  h.chrome.tabs.create = async params => {
    for (const id of oldIds) h.busy.add(id);
    created = await create(params);
    return created;
  };
  await assert.rejects(h.registry.open(p, 1), { code: 'TASK_TAB_LIMIT' });
  assert(created);
  assert(h.tabs.some(tab => tab.id === created.id));
  assert(!h.removed.includes(created.id));
  const count = h.tabs.length;
  h.busy.add(created.id);
  await assert.rejects(h.registry.open(p, 1), { code: 'TASK_TAB_LIMIT' });
  assert.equal(h.tabs.length, count);
});

test('adopt等待时复制证据，跨任务并发不能抢占同一页', async () => {
  const h = harness();
  h.tabs.push({ id: 100, windowId: 1, groupId: 20, url: 'https://example.test/historical' });
  const page = { tabId: 100, groupId: 20, url: 'https://example.test/historical', evidence: { kind: 'agent-related', reference: 'session:record-42' } };
  const one = h.registry.task({ action: 'adopt', taskId: '__adopt__', taskName: '恢复', pages: [page] });
  const two = h.registry.task({ action: 'adopt', taskId: 'b', taskName: '其他任务', pages: [page] });
  page.evidence.reference = 'mutated-after-submit';
  const [a, b] = await Promise.all([one, two]);
  assert.deepEqual([...a.adopted], [100]);
  assert.equal(b.adopted.length, 0);
  assert.equal(b.skipped[0].reason, 'other-task');
  const record = h.registry.tabs.get(100);
  assert.equal(record.provenance, 'agent-attested');
  assert.equal(record.evidence.reference, 'session:record-42');
});
