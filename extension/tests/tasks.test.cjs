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
  return { registry, tabs, groups, busy, removed, restore: () => new context.AiBrowserTasks(chrome, id => busy.has(id)) };
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

test('整理只合并重复页，结束只关本任务页；活动/保留/修改/固定/有声/忙碌页均保护', async () => {
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
  assert(clean.closed.length > 0);
  const finished = await h.registry.task({ action: 'finish', taskId: 'a' });
  assert.equal(finished.remaining.length, 6);
  for (const reason of ['active', 'pinned', 'audible', 'busy', 'modified', 'kept']) assert(finished.skipped.some(tab => tab.reason === reason));
  assert(h.tabs.some(tab => tab.id === 1)); assert(h.tabs.some(tab => tab.id === other));
  assert(!h.removed.includes(1) && !h.removed.includes(other));
});

test('用户移出分组的页交还用户，阈值整理重复页，独立页达到12不再无限新建', async () => {
  const h = harness(), p = { taskId: 'a', url: 'https://example.test/' };
  const moved = await h.registry.open(p, 1);
  h.tabs.find(tab => tab.id === moved.tab.id).groupId = -1;
  await h.registry.task({ taskId: 'a', action: 'finish' });
  assert(!h.removed.includes(moved.tab.id));
  for (let i = 0; i < 12; i++) await h.registry.open({ ...p, url: `https://example.test/${i}` }, 1);
  await assert.rejects(h.registry.open({ ...p, url: 'https://example.test/13' }, 1), { code: 'TASK_TAB_LIMIT' });
  assert.equal((await h.registry.task({ taskId: 'a', action: 'list' })).tabs.length, 12);
  const d = harness();
  for (let i = 0; i < 13; i++) await d.registry.open({ ...p, reuse: false }, 1);
  assert(d.tabs.length <= 13);
  assert(d.removed.length > 0);
});
