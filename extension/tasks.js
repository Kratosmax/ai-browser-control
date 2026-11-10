'use strict';

// 浏览器会话级归属记录。浏览器重启后失效，避免复用的tabId误伤用户页面。
globalThis.AiBrowserTasks = class {
  constructor(chrome, busy, protect = async () => null) {
    this.chrome = chrome;
    this.busy = busy;
    this.protect = protect;
    this.tabs = new Map();
    this.queues = new Map();
    this.saving = Promise.resolve();
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
      if (!tab || (record.groupId !== undefined && tab.groupId !== record.groupId)) { this.tabs.delete(id); changed = true; }
    }
    if (changed) await this.save();
    return all.filter(tab => this.tabs.get(tab.id)?.taskId === taskId);
  }
  async clean(taskId, finish, keep = [], check = () => {}) {
    const live = await this.live(taskId);
    const seen = new Set();
    const closed = [], skipped = [];
    for (const tab of live.sort((a, b) => this.tabs.get(b.id).used - this.tabs.get(a.id).used)) {
      check();
      const record = this.tabs.get(tab.id);
      if (keep.includes(tab.id)) record.keep = true;
      const key = record.key;
      const duplicate = seen.has(key);
      seen.add(key);
      if (!finish && !duplicate) continue;
      const reason = record.keep ? 'kept' : tab.active ? 'active' : tab.pinned ? 'pinned' : tab.audible ? 'audible' : this.busy(tab.id) ? 'busy' : record.modified ? 'modified' : await this.protect(tab);
      if (reason) { skipped.push({ tabId: tab.id, reason }); continue; }
      try {
        check();
        await this.chrome.tabs.remove(tab.id);
        this.tabs.delete(tab.id);
        closed.push(tab.id);
      } catch { skipped.push({ tabId: tab.id, reason: 'close-failed' }); }
    }
    await this.save();
    return { taskId, closed, skipped, remaining: [...this.tabs.values()].filter(tab => tab.taskId === taskId).map(tab => tab.id) };
  }
  async task(params, check = () => {}) {
    const { taskId } = params;
    if (params.action === 'list') {
      await this.ready;
      await this.live(taskId);
      return { taskId, tabs: [...this.tabs.values()].filter(tab => tab.taskId === taskId) };
    }
    return this.serial(taskId, async () => {
      if (params.action === 'finish' || params.action === 'cleanup') return this.clean(taskId, params.action === 'finish', params.keepTabIds, check);
      await this.live(taskId);
      if (params.action === 'keep') {
        for (const id of params.keepTabIds || []) {
          const record = this.tabs.get(id);
          if (!record || record.taskId !== taskId) throw new Error('只能保留本任务创建的页面');
          record.keep = true;
        }
      }
      await this.save();
      return { taskId, tabs: [...this.tabs.values()].filter(tab => tab.taskId === taskId) };
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
        return tab.windowId === windowId && !record.keep && !record.modified && !tab.active && !tab.pinned && !tab.audible && !this.busy(tab.id) &&
          (params.reuseKey ? record.key === key && new URL(tab.url).origin === new URL(url).origin : new URL(tab.url).href === url);
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
      if (live.length >= 12) {
        await this.clean(taskId, false, [], check);
        live = await this.live(taskId);
        if (live.length >= 12) throw Object.assign(new Error('本任务已有12个页面，重复页已整理；请finish已完成的任务或明确保留交付页后清理，不会自动关闭独立工作页'), { code: 'TASK_TAB_LIMIT' });
      }
      check();
      tab = await this.chrome.tabs.create({ windowId, url, active: false, ...(params.tabId === undefined ? {} : { openerTabId: params.tabId }) });
      const record = { id: tab.id, taskId, name: params.taskName || this.tabs.get(live[0]?.id)?.name || `AI · ${new URL(url).hostname}`,
        key, used: Date.now(), keep: false, modified: false };
      this.tabs.set(tab.id, record);
      // 先保存归属，分组失败也不能让已创建页面变成无法清理的孤儿。
      await this.save();
      let groupError;
      try {
        check();
        const groupId = live.find(tab => tab.windowId === windowId && Number.isInteger(tab.groupId) && tab.groupId >= 0)?.groupId;
        record.groupId = await this.chrome.tabs.group({ tabIds: [tab.id], ...(groupId === undefined ? { createProperties: { windowId } } : { groupId }) });
        check();
        await this.chrome.tabGroups.update(record.groupId, { title: record.name.slice(0, 50), color: 'blue' });
        await this.save();
      } catch { groupError = '页面已创建并记录，浏览器未完成分组；可用browser_task清理，勿重复打开'; }
      return { tab, taskId, reused: false, groupId: record.groupId, groupError };
    });
  }
  markModified(tabId) {
    const record = this.tabs.get(tabId);
    if (record) { record.modified = true; void this.save(); }
  }
  removed(tabId) { this.tabs.delete(tabId); void this.save(); }
};
