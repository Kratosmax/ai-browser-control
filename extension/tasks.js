'use strict';

// 浏览器会话级归属记录。浏览器重启后失效，避免复用的tabId误伤用户页面。
globalThis.AiBrowserTasks = class {
  constructor(chrome, busy, protect = async () => null) {
    this.chrome = chrome;
    this.busy = busy;
    this.protect = protect;
    this.tabs = new Map();
    this.queues = new Map();
    this.children = new Map();
    this.saving = Promise.resolve();
    this.adopting = Promise.resolve();
    this.ready = chrome.storage.session.get('managedTabs').then(stored => {
      for (const tab of stored.managedTabs || []) if (Number.isInteger(tab.id) && typeof tab.taskId === 'string') this.tabs.set(tab.id, tab);
    });
  }
  save() {
    this.saving = this.saving.catch(() => {}).then(() => this.chrome.storage.session.set({ managedTabs: [...this.tabs.values()] }));
    return this.saving;
  }
  async serial(taskId, work) {
    await this.ready;
    const next = (this.queues.get(taskId) || Promise.resolve()).catch(() => {}).then(work);
    this.queues.set(taskId, next);
    try { return await next; } finally { if (this.queues.get(taskId) === next) this.queues.delete(taskId); }
  }
  async live(taskId) {
    const all = await this.chrome.tabs.query({});
    const actual = new Map(all.map(tab => [tab.id, tab]));
    let changed = false;
    for (const [id, record] of this.tabs) {
      const tab = actual.get(id);
      // 用户把页移出原分组后，交还用户；不再复用或清理。
      if (!tab || (Number.isInteger(record.groupId) && record.groupId >= 0 && tab.groupId !== record.groupId)) { this.tabs.delete(id); changed = true; }
    }
    if (changed) await this.save();
    return all.filter(tab => this.tabs.get(tab.id)?.taskId === taskId);
  }
  validateTask(params) {
    const fail = message => { throw Object.assign(new Error(message), { code: 'INVALID_PARAMS' }); };
    if (!params || typeof params !== 'object' || Array.isArray(params)) fail('task参数必须是对象');
    if (typeof params.taskId !== 'string' || !params.taskId.trim()) fail('taskId必须为非空字符串');
    if (!['list', 'keep', 'unkeep', 'finish', 'cleanup', 'close', 'adopt'].includes(params.action)) fail('未知task action');
    const ids = (value, required, name) => {
      if (value === undefined && !required) return;
      if (!Array.isArray(value) || (required && value.length === 0) || value.length > 50 ||
          value.some(id => !Number.isSafeInteger(id) || id < 0) || new Set(value).size !== value.length) fail(name + '必须为最多50个不重复的有效tabId' + (required ? '，且不能为空' : ''));
    };
    if (['close', 'unkeep'].includes(params.action)) ids(params.tabIds, true, 'tabIds');
    if (['keep', 'finish', 'cleanup'].includes(params.action)) ids(params.keepTabIds, params.action === 'keep', 'keepTabIds');
    if (params.action === 'adopt') {
      if (typeof params.taskName !== 'string' || !params.taskName.trim()) fail('adopt必须提供非空taskName');
      if (!Array.isArray(params.pages) || !params.pages.length || params.pages.length > 50) fail('pages必须为1到50项');
      const seen = new Set();
      for (const page of params.pages) {
        if (!page || typeof page !== 'object' || Array.isArray(page) || !Number.isSafeInteger(page.tabId) || page.tabId < 0 || seen.has(page.tabId)) fail('pages必须提供不重复的有效tabId');
        seen.add(page.tabId);
        if (!Number.isSafeInteger(page.groupId) || page.groupId < -1) fail('pages.groupId必须为-1或有效分组ID');
        let url;
        try { url = new URL(page.url); } catch { fail('pages.url必须为HTTP(S) URL'); }
        if (typeof page.url !== 'string' || !['http:', 'https:'].includes(url.protocol)) fail('pages.url必须为HTTP(S) URL');
        if (!page.evidence || !['agent-created', 'agent-related'].includes(page.evidence.kind) ||
            typeof page.evidence.reference !== 'string' || !page.evidence.reference.trim()) fail('adopt必须提供明确创建证据kind与非空真实记录reference');
      }
    }
  }
  async absence(tabId) {
    try {
      const tab = await this.chrome.tabs.get(tabId);
      if (tab?.id === tabId) return false;
    } catch (error) {
      // Chrome明确的不存在错误才可直接证明已关；传输/权限错误不是不存在。
      const message = String(error?.message || error);
      const missing = /^(?:No tab with id: ?(\d+)\.?|Tab (?:with id )?(\d+) (?:not found|does not exist)\.?)$/i.exec(message);
      if (missing && Number(missing[1] || missing[2]) === tabId) return true;
    }
    try {
      const tabs = await this.chrome.tabs.query({});
      return Array.isArray(tabs) && !tabs.some(tab => tab.id === tabId);
    } catch { return false; }
  }
  async clean(taskId, finish, keep = [], check = () => {}, selectedIds, excludedIds = []) {
    const before = new Map(this.tabs);
    const live = await this.live(taskId);
    check();
    const closed = [], skipped = [];
    let excess = Math.max(0, live.length - 12);
    const selected = selectedIds !== undefined;
    const candidates = selected ? selectedIds.map(id => live.find(tab => tab.id === id) || { id }) :
      live.sort((a, b) => this.tabs.get(a.id).used - this.tabs.get(b.id).used || a.id - b.id);
    for (const tab of candidates) {
      check();
      const record = this.tabs.get(tab.id);
      if (selected && (!record || record.taskId !== taskId)) {
        const previous = before.get(tab.id);
        skipped.push({ tabId: tab.id, reason: record && record.taskId !== taskId ? 'other-task' : previous?.taskId === taskId ? 'outside-task-group' : 'not-managed' });
        continue;
      }
      if (!record || excludedIds.includes(tab.id)) continue;
      if (keep.includes(tab.id)) record.keep = true;
      if (!finish && !selected && excess <= 0) continue;
      const reason = record.keep ? 'kept' : this.busy(tab.id) ? 'busy' : null;
      if (reason) { skipped.push({ tabId: tab.id, reason }); continue; }
      try {
        const current = await this.chrome.tabs.get(tab.id);
        check();
        if (this.tabs.get(tab.id) !== record || record.taskId !== taskId || !Number.isInteger(record.groupId) || record.groupId < 0 || current.groupId !== record.groupId) {
          skipped.push({ tabId: tab.id, reason: 'outside-task-group' });
          if (this.tabs.get(tab.id) === record && Number.isInteger(record.groupId) && record.groupId >= 0) this.tabs.delete(tab.id);
          continue;
        }
        if (record.keep || this.busy(tab.id)) { skipped.push({ tabId: tab.id, reason: record.keep ? 'kept' : 'busy' }); continue; }
        await this.chrome.tabs.remove(tab.id);
        const absent = await this.absence(tab.id);
        check();
        if (!absent) { skipped.push({ tabId: tab.id, reason: 'close-not-confirmed' }); continue; }
        if (this.tabs.get(tab.id) === record) this.tabs.delete(tab.id);
        closed.push(tab.id);
        excess--;
      } catch (error) { check(); skipped.push({ tabId: tab.id, reason: 'close-failed' }); }
    }
    await this.save();
    return { taskId, closed, closedCount: closed.length, ...(selected ? { requestedCount: selectedIds.length } : {}), skipped,
      remaining: [...this.tabs.values()].filter(tab => tab.taskId === taskId).map(tab => tab.id),
      summary: closed.length ? '已独立核验关闭' + closed.length + '页' : '未核验关闭任何页面',
      verificationRequired: '仅依据closed中的已核验tabId报告关闭；closed为空时不得声称完成清理。skipped说明未关闭原因。' };
  }
  async adopt(params, check) {
    const { taskId } = params, adopted = [], skipped = [];
    await this.live(taskId);
    for (const page of params.pages) {
      const skip = reason => skipped.push({ tabId: page.tabId, reason });
      try {
        check();
        let tab = await this.chrome.tabs.get(page.tabId);
        check();
        const existing = this.tabs.get(page.tabId);
        if (existing && existing.taskId !== taskId) { skip('other-task'); continue; }
        if (tab.url !== page.url) { skip('url-mismatch'); continue; }
        if (tab.groupId !== page.groupId) { skip('group-mismatch'); continue; }
        // 只以当前浏览器分组和已有归属决定目标组；不追认同组其他用户页。
        const all = await this.chrome.tabs.query({});
        check();
        const taskGroups = new Set(all.filter(t => t.windowId === tab.windowId && t.groupId >= 0 &&
          this.tabs.get(t.id)?.taskId === taskId && this.tabs.get(t.id)?.groupId === t.groupId).map(t => t.groupId));
        const groupOwnedByOther = groupId => all.some(t => t.groupId === groupId && this.tabs.has(t.id) && this.tabs.get(t.id).taskId !== taskId);
        if (tab.groupId >= 0 && groupOwnedByOther(tab.groupId)) { skip('other-task-group'); continue; }
        if (tab.groupId >= 0 && taskGroups.size && !taskGroups.has(tab.groupId)) { skip('outside-task-group'); continue; }
        // query/get等await之间页面发生变化时拒绝，不覆盖用户导航或分组操作。
        const current = await this.chrome.tabs.get(page.tabId);
        check();
        if (current.url !== page.url || current.groupId !== page.groupId || current.windowId !== tab.windowId || this.tabs.get(page.tabId) !== existing) { skip('page-changed'); continue; }
        let targetGroup = tab.groupId;
        if (targetGroup === -1) {
          const groupId = taskGroups.values().next().value;
          targetGroup = await this.chrome.tabs.group({ tabIds: [page.tabId], ...(groupId === undefined ? { createProperties: { windowId: tab.windowId } } : { groupId }) });
          check();
          if (groupId === undefined) {
            await this.chrome.tabGroups.update(targetGroup, { title: params.taskName.slice(0, 50), color: 'blue' });
            check();
          }
          tab = await this.chrome.tabs.get(page.tabId);
          check();
          if (tab.url !== page.url || tab.groupId !== targetGroup || tab.windowId !== current.windowId || this.tabs.get(page.tabId) !== existing) { skip('page-changed'); continue; }
        } else tab = current;
        // 此处无await，其他任务不能在最后一次归属核验和登记之间抢占。
        this.tabs.set(page.tabId, { ...existing, id: page.tabId, taskId, name: params.taskName,
          groupId: targetGroup, key: existing?.key || 'url:' + page.url, used: Date.now(), keep: existing?.keep || false,
          modified: existing?.modified || false, provenance: 'agent-attested', evidence: { kind: page.evidence.kind, reference: page.evidence.reference } });
        // 每页完成即持久化；后续页超时或连接变化不能抹掉已完成页面的归属证据。
        await this.save();
        adopted.push(page.tabId);
      } catch (error) { check(); skip('adopt-failed'); }
    }
    await this.save();
    return { taskId, adopted, adoptedCount: adopted.length, requestedCount: params.pages.length, skipped,
      tabs: [...this.tabs.values()].filter(tab => tab.taskId === taskId),
      verificationRequired: 'adopt仅登记agent明确提交的历史证据声明（agent-attested）；插件不能独立验证reference真伪，不表示已关闭页面。' };
  }
  async task(params, check = () => {}) {
    this.validateTask(params);
    // 在await前复制，避免调用方于异步处理中替换已校验的批次和证据。
    params = { ...params, tabIds: params.tabIds && [...params.tabIds], keepTabIds: params.keepTabIds && [...params.keepTabIds],
      pages: params.pages?.map(page => ({ ...page, evidence: { ...page.evidence } })) };
    const { taskId } = params;
    return this.serial(taskId, async () => {
      check();
      if (['finish', 'cleanup', 'close'].includes(params.action)) return this.clean(taskId, params.action === 'finish', params.action === 'close' ? [] : params.keepTabIds, check, params.action === 'close' ? params.tabIds : undefined);
      if (params.action === 'adopt') {
        const work = this.adopting.catch(() => {}).then(() => this.adopt(params, check));
        this.adopting = work;
        return work;
      }
      const before = new Map(this.tabs);
      await this.live(taskId);
      check();
      const unkept = [], skipped = [];
      if (params.action === 'unkeep') {
        for (const id of params.tabIds) {
          const record = this.tabs.get(id);
          if (!record || record.taskId !== taskId) {
            skipped.push({ tabId: id, reason: record ? 'other-task' : before.get(id)?.taskId === taskId ? 'outside-task-group' : 'not-managed' });
            continue;
          }
          record.keep = false;
          unkept.push(id);
        }
      }
      if (params.action === 'keep') {
        for (const id of params.keepTabIds) if (this.tabs.get(id)?.taskId !== taskId) throw new Error('只能保留本任务创建的页面');
        for (const id of params.keepTabIds) this.tabs.get(id).keep = true;
      }
      await this.save();
      return { taskId, ...(params.action === 'unkeep' ? { unkept, skipped, requestedCount: params.tabIds.length } : {}),
        tabs: [...this.tabs.values()].filter(tab => tab.taskId === taskId) };
    });
  }
  async open(params, windowId, check = () => {}) {
    const taskId = params.taskId || `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    return this.serial(taskId, async () => {
      let live = await this.live(taskId);
      const url = new URL(params.url).href;
      const key = params.reuseKey ? `key:${params.reuseKey}` : `url:${url}`;
      let tab = params.reuse === false ? null : live.find(tab => {
        const record = this.tabs.get(tab.id);
        let current;
        try { current = new URL(tab.url); } catch { return false; }
        return Number.isInteger(record.groupId) && record.groupId >= 0 && tab.groupId === record.groupId && tab.windowId === windowId && !record.keep && !record.modified && !tab.active && !tab.pinned && !tab.audible && !this.busy(tab.id) &&
          (params.reuseKey ? record.key === key && current.origin === new URL(url).origin : current.href === url);
      });
      if (tab) {
        if (await this.protect(tab)) tab = null;
      }
      if (tab) {
        check();
        // 同类页显式reuseKey可导航，默认只复用相同完整URL。
        if (tab.url !== url) tab = await this.chrome.tabs.update(tab.id, { url });
        this.tabs.get(tab.id).used = Date.now();
        await this.save();
        return { tab, taskId, reused: true, groupId: this.tabs.get(tab.id).groupId };
      }
      if (live.length > 12) { await this.clean(taskId, false, [], check); live = await this.live(taskId); }
      if (live.length > 12 || (live.length >= 12 && !live.some(tab => {
        const record = this.tabs.get(tab.id);
        return !record.keep && !this.busy(tab.id) && Number.isInteger(record.groupId) && record.groupId >= 0 && tab.groupId === record.groupId;
      }))) throw Object.assign(new Error('本任务达到页面上限且没有足够可回收页，请先评估keep或执行中的页面'), { code: 'TASK_TAB_LIMIT' });
      check();
      // 显式open单独登记归属，不伪造网页派生的opener链。
      tab = await this.chrome.tabs.create({ windowId, url, active: false });
      const record = { id: tab.id, taskId, name: params.taskName || this.tabs.get(live[0]?.id)?.name || `AI · ${new URL(url).hostname}`,
        key, used: Date.now(), keep: false, modified: false };
      this.tabs.set(tab.id, record);
      // 先保存创建证据；分组失败仍不可清理该页。
      await this.save();
      let groupError;
      try {
        check();
        const groupId = live.find(tab => tab.windowId === windowId && Number.isInteger(tab.groupId) && tab.groupId >= 0)?.groupId;
        record.groupId = await this.chrome.tabs.group({ tabIds: [tab.id], ...(groupId === undefined ? { createProperties: { windowId } } : { groupId }) });
        check();
        await this.chrome.tabGroups.update(record.groupId, { title: record.name.slice(0, 50), color: 'blue' });
        await this.save();
      } catch { groupError = '页面已创建并记录，浏览器未完成分组；该页不参与自动清理，勿重复打开'; }
      if ((await this.live(taskId)).length > 12) {
        await this.clean(taskId, false, [], check, undefined, [tab.id]);
        if ((await this.live(taskId)).length > 12) throw Object.assign(new Error('本任务超过12页且没有足够可回收页；新页' + tab.id + '已创建，勿重复打开，请评估keep或执行中的页面'), { code: 'TASK_TAB_LIMIT' });
      }
      // 超限回收不得返回刚被回收或已不存在的tabId。
      try { tab = await this.chrome.tabs.get(tab.id); }
      catch { throw Object.assign(new Error('新建页面已不可读取，请先list_tabs核对，勿重复打开'), { code: 'OPEN_TAB_UNAVAILABLE' }); }
      check();
      return { tab, taskId, reused: false, groupId: record.groupId, groupError };
    });
  }
  async created({ tabId, sourceTabId }) {
    // 仅接收浏览器onCreatedNavigationTarget来源证据。后台window.open的openerTabId可能指向活动用户页。
    if (!Number.isInteger(tabId) || !Number.isInteger(sourceTabId) || tabId === sourceTabId) return;
    await this.ready;
    const parent = this.tabs.get(sourceTabId) || this.children.get(sourceTabId);
    if (!parent || this.tabs.has(tabId) || this.children.has(tabId)) return;
    const candidate = { taskId: parent.taskId, name: parent.name };
    this.children.set(tabId, candidate);
    const work = this.serial(parent.taskId, () => {
      // 自动来源登记和显式adopt共用登记队列，不能在await间抢走对方已登记的页面。
      const registration = this.adopting.catch(() => {}).then(async () => {
        if (this.tabs.has(tabId)) return;
        const record = this.tabs.get(sourceTabId);
        if (!record || record.taskId !== candidate.taskId || !Number.isInteger(record.groupId) || record.groupId < 0) return;
        const opener = await this.chrome.tabs.get(sourceTabId);
        let child = await this.chrome.tabs.get(tabId);
        if (this.tabs.has(tabId) || this.tabs.get(opener.id) !== record || opener.groupId !== record.groupId || child.windowId !== opener.windowId ||
            (child.groupId >= 0 && child.groupId !== record.groupId)) return;
        await this.chrome.tabs.group({ tabIds: [child.id], groupId: record.groupId });
        child = await this.chrome.tabs.get(child.id);
        if (this.tabs.has(tabId) || this.tabs.get(sourceTabId) !== record || child.groupId !== record.groupId) return;
        this.tabs.set(child.id, { id: child.id, taskId: record.taskId, name: record.name, groupId: record.groupId,
          openerTabId: opener.id, key: 'child:' + child.id, used: Date.now(), keep: false, modified: false });
        await this.save();
        await this.clean(record.taskId, false);
      });
      this.adopting = registration;
      return registration;
    });
    return work.catch(() => {}).finally(() => this.children.delete(tabId));
  }
  markModified(tabId) {
    const record = this.tabs.get(tabId);
    if (record) { record.modified = true; void this.save(); }
  }
  removed(tabId) { this.tabs.delete(tabId); void this.save(); }
};
