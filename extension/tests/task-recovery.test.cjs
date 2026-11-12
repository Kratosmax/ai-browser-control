const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

// Load the shipped registry, not a replica. Each test gets an isolated browser session.
function harness() {
  let nextTab = 100, nextGroup = 20, stored = { managedTabs: [] };
  const tabs = new Map([[1, { id: 1, windowId: 1, groupId: -1, active: true, url: 'https://user.test/original' }]]);
  const groups = new Map(), busy = new Set(), removed = [], grouped = [], noOpRemove = new Set();
  const hooks = {};
  const copy = value => structuredClone(value);
  const notFound = id => new Error(`No tab with id: ${id}.`);
  const chrome = {
    storage: { session: {
      get: async () => copy(stored),
      set: async value => { stored = copy(value); }
    } },
    tabs: {
      query: async (query = {}) => {
        if (hooks.beforeQuery) await hooks.beforeQuery(query);
        const result = [...tabs.values()].filter(tab =>
          (query.windowId === undefined || tab.windowId === query.windowId) &&
          (query.groupId === undefined || tab.groupId === query.groupId) &&
          (query.active === undefined || tab.active === query.active)).map(copy);
        if (hooks.afterQuery) await hooks.afterQuery(result, query);
        return result;
      },
      get: async id => {
        if (hooks.beforeGet) await hooks.beforeGet(id);
        const tab = tabs.get(id);
        if (!tab) throw notFound(id);
        const result = copy(tab);
        if (hooks.afterGet) await hooks.afterGet(id, result);
        return result;
      },
      create: async params => {
        const tab = { active: false, windowId: 1, ...params, id: ++nextTab, groupId: -1 };
        tabs.set(tab.id, tab);
        return copy(tab);
      },
      update: async (id, params) => {
        const tab = tabs.get(id);
        if (!tab) throw notFound(id);
        Object.assign(tab, params);
        return copy(tab);
      },
      group: async params => {
        if (hooks.beforeGroup) await hooks.beforeGroup(params);
        const ids = Array.isArray(params.tabIds) ? params.tabIds : [params.tabIds];
        const groupId = params.groupId ?? ++nextGroup;
        const first = tabs.get(ids[0]);
        groups.set(groupId, { id: groupId, windowId: first?.windowId ?? 1, ...groups.get(groupId) });
        for (const id of ids) {
          if (!tabs.has(id)) throw notFound(id);
          tabs.get(id).groupId = groupId;
        }
        grouped.push({ ...copy(params), groupId });
        if (hooks.afterGroup) await hooks.afterGroup(params, groupId);
        return groupId;
      },
      remove: async ids => {
        for (const id of Array.isArray(ids) ? ids : [ids]) {
          if (hooks.beforeRemove) await hooks.beforeRemove(id);
          removed.push(id);
          if (!noOpRemove.has(id)) tabs.delete(id);
          if (hooks.afterRemove) await hooks.afterRemove(id);
        }
      }
    },
    tabGroups: {
      get: async id => {
        if (!groups.has(id)) throw new Error(`No group with id: ${id}.`);
        return copy(groups.get(id));
      },
      query: async (query = {}) => [...groups.values()].filter(group => query.windowId === undefined || group.windowId === query.windowId).map(copy),
      update: async (id, params) => {
        groups.set(id, { ...groups.get(id), ...params, id });
        return copy(groups.get(id));
      }
    }
  };
  const context = vm.createContext({ URL });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../tasks.js'), 'utf8'), context);
  const registry = new context.AiBrowserTasks(chrome, id => busy.has(id));
  const add = (id, groupId = -1, url = `https://recovery.test/${id}`, windowId = 1) => {
    const tab = { id, groupId, url, windowId, active: false };
    tabs.set(id, tab);
    if (groupId >= 0) groups.set(groupId, { id: groupId, windowId });
    return tab;
  };
  return { registry, chrome, tabs, groups, busy, removed, grouped, noOpRemove, hooks, add,
    restore: () => new context.AiBrowserTasks(chrome, id => busy.has(id)),
    snapshot: () => ({ tabs: copy([...tabs]), groups: copy([...groups]), stored: copy(stored), grouped: copy(grouped), removed: copy(removed) }) };
}

const open = (h, taskId, suffix) => h.registry.open({ taskId, taskName: taskId, url: `https://managed.test/${suffix}`, reuse: false }, 1);
const ids = values => [...values].sort((a, b) => a - b);
const skipped = (result, id) => assert(result.skipped.some(item => item.tabId === id && typeof item.reason === 'string'), `missing skipped reason for tab ${id}`);
const evidence = (kind = 'agent-created', reference = 'session:recovery-test/create-receipt:42') => ({ kind, reference });
const page = (tab, proof = evidence()) => ({ tabId: tab.id, url: tab.url, groupId: tab.groupId, evidence: proof });
const adopt = (h, pages, taskId = 'recover') => h.registry.task({ action: 'adopt', taskId, taskName: '恢复测试', pages });
const close = (h, tabIds, taskId = 'a') => h.registry.task({ action: 'close', taskId, tabIds });
const list = async (h, taskId) => (await h.registry.task({ action: 'list', taskId })).tabs;

// Assertions below distinguish a request receipt from independently confirmed absence.
test('close ends only selected page operations; both task A and task B continue', async () => {
  const h = harness();
  const a = await open(h, 'a', 'a-done'), aPending = await open(h, 'a', 'a-pending'), b = await open(h, 'b', 'b-pending');
  const result = await close(h, [a.tab.id]);
  assert.deepEqual([...result.closed], [a.tab.id]);
  assert.equal(result.requestedCount, 1);
  assert.equal(result.closedCount, 1);
  assert(result.verificationRequired);
  assert.deepEqual(h.removed, [a.tab.id]);
  assert.deepEqual(ids((await list(h, 'a')).map(tab => tab.id)), [aPending.tab.id]);
  assert.deepEqual(ids((await list(h, 'b')).map(tab => tab.id)), [b.tab.id]);
  assert.equal((await h.registry.open({ taskId: 'b', url: b.tab.url }, 1)).tab.id, b.tab.id);
  assert((await open(h, 'a', 'a-next')).tab.id);
  assert(h.tabs.has(1));
});

test('close and unkeep reject empty selections; invalid adopt batch has no side effects', async () => {
  for (const action of ['close', 'unkeep']) {
    const h = harness();
    await open(h, 'a', action);
    const before = h.snapshot();
    await assert.rejects(h.registry.task({ action, taskId: 'a', tabIds: [] }));
    assert.deepEqual(h.snapshot(), before);
  }
  const h = harness(), candidate = h.add(10, 50);
  for (const pages of [[], [page(candidate), { ...page(h.add(11, 50)), evidence: { kind: 'agent-related' } }]]) {
    const before = h.snapshot();
    await assert.rejects(adopt(h, pages));
    assert.deepEqual(h.snapshot(), before, 'batch shape must be validated before adoption or grouping');
    assert.equal(h.registry.tabs.has(candidate.id), false);
  }
});

test('keep requires explicit selective unkeep; unrelated kept pages stay kept', async () => {
  const h = harness(), a = await open(h, 'a', 'a'), other = await open(h, 'a', 'kept-other'), b = await open(h, 'b', 'b');
  await h.registry.task({ action: 'keep', taskId: 'a', keepTabIds: [a.tab.id, other.tab.id] });
  await h.registry.task({ action: 'keep', taskId: 'b', keepTabIds: [b.tab.id] });
  const kept = await close(h, [a.tab.id]);
  assert.equal(kept.closed.length, 0);
  skipped(kept, a.tab.id);
  await h.registry.task({ action: 'unkeep', taskId: 'a', tabIds: [a.tab.id] });
  assert.equal(h.registry.tabs.get(a.tab.id).keep, false);
  assert.equal(h.registry.tabs.get(other.tab.id).keep, true);
  assert.equal(h.registry.tabs.get(b.tab.id).keep, true);
  assert.deepEqual([...(await close(h, [a.tab.id])).closed], [a.tab.id]);
  assert.deepEqual(h.removed, [a.tab.id]);
});

test('close skips unknown, other-task, moved, kept and busy pages without touching unselected pages', async () => {
  const h = harness(), a = await open(h, 'a', 'allowed'), unselected = await open(h, 'a', 'unselected');
  const b = await open(h, 'b', 'other-task'), moved = await open(h, 'a', 'moved');
  const kept = await open(h, 'a', 'kept'), busy = await open(h, 'a', 'busy');
  h.tabs.get(moved.tab.id).groupId = 77;
  await h.registry.task({ action: 'keep', taskId: 'a', keepTabIds: [kept.tab.id] });
  h.busy.add(busy.tab.id);
  const unknown = h.add(10, a.groupId);
  const selected = [a.tab.id, b.tab.id, moved.tab.id, kept.tab.id, busy.tab.id, unknown.id, 999];
  const result = await close(h, selected);
  assert.deepEqual([...result.closed], [a.tab.id]);
  assert.equal(result.requestedCount, selected.length);
  for (const id of selected.slice(1)) skipped(result, id);
  assert.deepEqual(h.removed, [a.tab.id]);
  for (const id of [1, unselected.tab.id, ...selected.slice(1, -1)]) assert(h.tabs.has(id));
});

test('an all-skipped close reports zero confirmed pages and leaves unrelated managed pages alone', async () => {
  const h = harness(), managed = await open(h, 'a', 'pending'), unknown = h.add(10, managed.groupId);
  const result = await close(h, [unknown.id, 999]);
  assert.deepEqual([...result.closed], []);
  assert.equal(result.closedCount, 0);
  assert.equal(result.requestedCount, 2);
  assert(result.verificationRequired);
  assert.equal(typeof result.summary, 'string');
  assert(!result.summary.includes('完成清理'));
  skipped(result, unknown.id);
  skipped(result, 999);
  assert.equal(h.removed.length, 0);
  assert(h.registry.tabs.has(managed.tab.id));
});

test('close, unkeep and adopt reject oversized or duplicate batches before any changes', async () => {
  for (const action of ['close', 'unkeep', 'adopt']) {
    for (const invalid of ['oversized', 'duplicate']) {
      const h = harness(), managed = await open(h, 'a', 'untouched');
      const candidate = h.add(10, managed.groupId);
      const tabIds = invalid === 'oversized' ? Array.from({ length: 51 }, (_, index) => 1000 + index) : [candidate.id, candidate.id];
      const pages = invalid === 'oversized' ? tabIds.map(id => ({ ...page(candidate), tabId: id })) : [page(candidate), page(candidate)];
      const before = h.snapshot();
      await assert.rejects(h.registry.task({ action, taskId: 'a', taskName: '批次校验', ...(action === 'adopt' ? { pages } : { tabIds }) }));
      assert.deepEqual(h.snapshot(), before);
    }
  }
});

test('unkeep skips other-task and unknown selections while preserving all other keep flags', async () => {
  const h = harness(), a = await open(h, 'a', 'a'), b = await open(h, 'b', 'b');
  await h.registry.task({ action: 'keep', taskId: 'a', keepTabIds: [a.tab.id] });
  await h.registry.task({ action: 'keep', taskId: 'b', keepTabIds: [b.tab.id] });
  const result = await h.registry.task({ action: 'unkeep', taskId: 'a', tabIds: [b.tab.id, 999] });
  skipped(result, b.tab.id);
  skipped(result, 999);
  assert.equal(h.registry.tabs.get(a.tab.id).keep, true);
  assert.equal(h.registry.tabs.get(b.tab.id).keep, true);
  assert.equal(h.removed.length, 0);
});

test('query independently confirms absence after an ordinary get error, but a live result cannot', async () => {
  for (const survives of [false, true]) {
    const h = harness(), a = await open(h, 'a', 'query-fallback');
    if (survives) h.noOpRemove.add(a.tab.id);
    h.hooks.beforeGet = async id => {
      if (id === a.tab.id && h.removed.includes(id)) throw new Error('Chrome permission check failed');
    };
    const result = await close(h, [a.tab.id]);
    assert.deepEqual([...result.closed], survives ? [] : [a.tab.id]);
    assert.equal(h.registry.tabs.has(a.tab.id), survives);
    assert.equal(h.tabs.has(a.tab.id), survives);
    if (survives) skipped(result, a.tab.id);
  }
});

test('activity, edits, pinned and audible flags do not block explicitly completed pages', async () => {
  const h = harness(), a = await open(h, 'a', 'edited');
  Object.assign(h.tabs.get(a.tab.id), { active: true, pinned: true, audible: true });
  h.registry.markModified(a.tab.id);
  assert.deepEqual([...(await close(h, [a.tab.id])).closed], [a.tab.id]);
});

for (const action of ['close', 'finish', 'cleanup']) {
  test(`${action} never reports closed when tabs.remove resolves but the page survives`, async () => {
    const h = harness(), count = action === 'cleanup' ? 12 : 1, opened = [];
    for (let index = 0; index < count; index++) opened.push(await open(h, 'a', `${action}-${index}`));
    if (action === 'cleanup') {
      // Seed one additional real management record without calling open's auto cleanup.
      const extra = h.add(20, opened[0].groupId, 'https://managed.test/overflow');
      h.registry.tabs.set(extra.id, { ...h.registry.tabs.get(opened[0].tab.id), id: extra.id, used: Date.now() + 1000 });
    }
    for (const id of h.tabs.keys()) h.noOpRemove.add(id);
    const result = await h.registry.task({ action, taskId: 'a', ...(action === 'close' ? { tabIds: [opened[0].tab.id] } : {}) });
    assert.equal(result.closed.length, 0);
    assert.equal(result.closedCount, 0);
    assert(result.verificationRequired);
    assert(result.skipped.some(item => item.reason === 'close-not-confirmed'));
    for (const item of opened) {
      assert(h.tabs.has(item.tab.id));
      assert(h.registry.tabs.has(item.tab.id), 'an unconfirmed close must retain ownership');
    }
  });
}

test('ordinary tabs.get error during close verification is not evidence of absence', async () => {
  const h = harness(), a = await open(h, 'a', 'verification-error');
  h.noOpRemove.add(a.tab.id);
  h.hooks.beforeGet = async id => { if (id === a.tab.id && h.removed.includes(id)) throw new Error('Chrome transport disconnected'); };
  h.hooks.beforeQuery = async () => { if (h.removed.length) throw new Error('Chrome query unavailable'); };
  const result = await close(h, [a.tab.id]);
  assert.equal(result.closed.length, 0);
  skipped(result, a.tab.id);
  assert(h.registry.tabs.has(a.tab.id));
  assert(h.tabs.has(a.tab.id));
});

test('close rechecks group after an awaited browser query before removing', async () => {
  const h = harness(), a = await open(h, 'a', 'move-during-query');
  let changed = false;
  h.hooks.afterQuery = async () => {
    if (!changed) { changed = true; h.tabs.get(a.tab.id).groupId = 88; }
  };
  const result = await close(h, [a.tab.id]);
  assert.equal(result.closed.length, 0);
  skipped(result, a.tab.id);
  assert.equal(h.removed.length, 0);
  assert.equal(h.tabs.get(a.tab.id).groupId, 88);
});

for (const kind of ['agent-created', 'agent-related']) {
  test(`adopt accepts explicit ${kind} evidence, marks attestation, restores it, and claims only selected pages`, async () => {
    const h = harness(), selected = h.add(10, 50), userSibling = h.add(11, 50);
    const reference = `session:recovery-test/${kind}/receipt:42`;
    await adopt(h, [page(selected, evidence(kind, reference))]);
    const record = h.registry.tabs.get(selected.id);
    assert(record);
    assert.equal(record.provenance, 'agent-attested');
    assert(JSON.stringify(record).includes(reference), 'persist the submitted reference without claiming plugin verification');
    assert.equal(record.groupId, 50);
    assert.equal(h.registry.tabs.has(userSibling.id), false);
    assert.equal(h.grouped.length, 0, 'already grouped pages must not be moved');
    const restored = h.restore();
    await restored.ready;
    assert.equal(restored.tabs.get(selected.id).provenance, 'agent-attested');
    assert(JSON.stringify(restored.tabs.get(selected.id)).includes(reference));
    const result = await restored.task({ action: 'close', taskId: 'recover', tabIds: [selected.id, userSibling.id] });
    assert.deepEqual([...result.closed], [selected.id]);
    skipped(result, userSibling.id);
    assert(h.tabs.has(userSibling.id));
    assert(h.tabs.has(1));
  });
}

test('adopt requires evidence on every page before any batch member is claimed', async () => {
  for (const proof of [undefined, {}, { kind: 'agent-created' }, evidence('agent-related', ''), evidence('agent-created', '   '), evidence('user-created')]) {
    const h = harness(), valid = h.add(10), invalid = h.add(11);
    const invalidPage = { tabId: invalid.id, groupId: invalid.groupId, url: invalid.url, evidence: proof };
    const before = h.snapshot();
    await assert.rejects(adopt(h, [page(valid), invalidPage]));
    assert.deepEqual(h.snapshot(), before);
    assert.equal(h.registry.tabs.size, 0);
  }
});

test('adopt rejects URL, group and scheme mismatches without moving or claiming the page', async () => {
  for (const patch of [{ url: 'https://recovery.test/10#different' }, { url: 'https://recovery.test/10?different=1' }, { groupId: 51 }, { url: 'file:///private.txt' }]) {
    const h = harness(), candidate = h.add(10, 50), before = h.snapshot();
    try { await adopt(h, [{ ...page(candidate), ...patch }]); } catch { /* structural errors may reject the whole batch */ }
    assert.equal(h.registry.tabs.has(candidate.id), false);
    assert.deepEqual(h.snapshot(), before);
  }
});

test('adopt cannot steal another task or move a different existing group into the target group', async () => {
  const h = harness(), a = await open(h, 'a', 'a'), b = await open(h, 'b', 'b'), elsewhere = h.add(10, 55), sameGroup = h.add(11, a.groupId);
  const before = h.grouped.length;
  await adopt(h, [page(h.tabs.get(b.tab.id)), page(elsewhere), page(sameGroup)], 'a');
  assert.equal(h.registry.tabs.get(b.tab.id).taskId, 'b');
  assert.equal(h.tabs.get(b.tab.id).groupId, b.groupId);
  assert.equal(h.registry.tabs.has(elsewhere.id), false);
  assert.equal(elsewhere.groupId, 55);
  assert.equal(h.registry.tabs.get(sameGroup.id).taskId, 'a');
  assert.equal(sameGroup.groupId, a.groupId);
  assert.equal(h.grouped.length, before);
  assert.equal(h.removed.length, 0);
});

test('explicit adopt may group an ungrouped page with the same-window task; other user pages stay outside ownership', async () => {
  const h = harness(), existing = await open(h, 'a', 'target'), candidate = h.add(10), sibling = h.add(11);
  await adopt(h, [page(candidate)], 'a');
  assert.equal(candidate.groupId, existing.groupId);
  assert.equal(h.registry.tabs.get(candidate.id).groupId, existing.groupId);
  assert.equal(sibling.groupId, -1);
  assert.equal(h.registry.tabs.has(sibling.id), false);
});

for (const property of ['groupId', 'url']) {
  test(`adopt rejects ${property} changed between awaited reads and does not overwrite the user change`, async () => {
    const h = harness(), candidate = h.add(10, 50), submitted = page(candidate);
    const value = property === 'groupId' ? 77 : 'https://user.test/new-location';
    let reads = 0;
    // The first get returns an old snapshot while the actual browser changes before its await completes.
    h.hooks.afterGet = async id => {
      if (id === candidate.id && ++reads === 1) candidate[property] = value;
    };
    await adopt(h, [submitted]);
    assert(reads > 0);
    assert.equal(candidate[property], value);
    assert.equal(h.registry.tabs.has(candidate.id), false);
    assert.equal(h.grouped.length, 0);
    assert.equal(h.removed.length, 0);
  });
}

test('automatic navigation registration cannot overwrite an explicit adoption that reported success', async () => {
  const h = harness(), root = await open(h, 'a', 'source');
  const child = h.add(500);
  let release, entered;
  const atChild = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let held = false;
  h.hooks.afterGet = async id => {
    if (id === child.id && !held) { held = true; entered(); await gate; }
  };
  const automatic = h.registry.created({ tabId: child.id, sourceTabId: root.tab.id });
  await atChild;
  const adoption = adopt(h, [page(child)], 'b');
  await new Promise(resolve => setImmediate(resolve));
  release();
  const [, result] = await Promise.all([automatic, adoption]);
  const owner = h.registry.tabs.get(child.id);
  if (result.adopted.includes(child.id)) {
    assert.equal(owner.taskId, 'b');
    assert.equal(owner.provenance, 'agent-attested');
    assert.notEqual(h.tabs.get(child.id).groupId, root.groupId);
  } else {
    assert.equal(owner.taskId, 'a');
    skipped(result, child.id);
  }
});

test('explicit adoption queued first retains its evidence when a delayed navigation event arrives', async () => {
  const h = harness(), root = await open(h, 'a', 'source');
  const child = h.add(501);
  let release, entered;
  const atChild = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let held = false;
  h.hooks.afterGet = async id => {
    if (id === child.id && !held) { held = true; entered(); await gate; }
  };
  const adoption = adopt(h, [page(child)], 'b');
  await atChild;
  const automatic = h.registry.created({ tabId: child.id, sourceTabId: root.tab.id });
  await new Promise(resolve => setImmediate(resolve));
  release();
  const [result] = await Promise.all([adoption, automatic]);
  assert.deepEqual([...result.adopted], [child.id]);
  assert.equal(h.registry.tabs.get(child.id).taskId, 'b');
  assert.equal(h.registry.tabs.get(child.id).provenance, 'agent-attested');
  assert.notEqual(h.tabs.get(child.id).groupId, root.groupId);
});

test('completed adoption remains durable when a later page invalidates the command', async () => {
  const h = harness(), first = h.add(600, 70), second = h.add(601, 70);
  let invalidated = false;
  h.hooks.beforeGet = async id => { if (id === second.id) invalidated = true; };
  const check = () => { if (invalidated) throw Object.assign(new Error('connection changed'), { code: 'invalidated' }); };
  await assert.rejects(h.registry.task({ taskId: 'recover', taskName: '恢复', action: 'adopt', pages: [page(first), page(second)] }, check), { code: 'invalidated' });
  const restored = h.restore();
  await restored.ready;
  assert.equal(restored.tabs.get(first.id).taskId, 'recover');
  assert.equal(restored.tabs.get(first.id).provenance, 'agent-attested');
  assert.equal(restored.tabs.has(second.id), false);
});
