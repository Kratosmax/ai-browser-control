'use strict';

const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const toggleButton = document.getElementById('toggle');
const tabTitle = document.getElementById('tab-title');
const tabStatus = document.getElementById('tab-status');
const authorizeButton = document.getElementById('authorize');
const releaseButton = document.getElementById('release');
const autoAuthorize = document.getElementById('auto-authorize');
const cdpEnabled = document.getElementById('cdp-enabled');
const bridgePortInput = document.getElementById('bridge-port');
const savePortButton = document.getElementById('save-port');
const cursorHideInput = document.getElementById('cursor-hide');
const saveHideButton = document.getElementById('save-hide');
const message = document.getElementById('message');
let busy = false;
let refreshPromise = null;
let isConnected = false;

function httpTab(tab) {
  return Boolean(tab && /^https?:\/\//i.test(tab.url || ''));
}

async function send(type, data = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...data });
  if (!response || response.error) throw new Error(response?.error?.message || '后台未响应');
  return response.result;
}

async function currentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('找不到当前标签页');
  return tab;
}

function renderConnection(state) {
  isConnected = state.connected === true;
  statusText.textContent = isConnected ? `已连接 · 端口 ${state.bridgePort}` : state.bridgeState;
  statusDot.className = 'dot' + (isConnected ? ' on'
    : /重试|占用|未连接/.test(state.bridgeState) ? ' err' : '');
  toggleButton.textContent = isConnected ? '断开连接' : '开始连接';
  toggleButton.classList.toggle('connected', isConnected);
  toggleButton.disabled = busy;
}

function renderTab(state, tab) {
  tabTitle.textContent = tab.title || '无标题';
  const allowed = state.authorizedTabIds.includes(tab.id);
  tabStatus.textContent = allowed ? '已授权'
    : httpTab(tab) ? (state.autoAuthorize ? '自动授权中 · 可被 AI 控制' : '尚未授权')
    : '此页面不支持授权';
  authorizeButton.disabled = busy || !httpTab(tab) || allowed;
  releaseButton.disabled = busy || !allowed;
}

function refresh() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    const [state, tab] = await Promise.all([send('popup_status'), currentTab()]);
    renderConnection(state);
    autoAuthorize.checked = state.autoAuthorize === true;
    cdpEnabled.checked = state.cdpEnabled !== false;
    if (document.activeElement !== bridgePortInput) bridgePortInput.value = state.bridgePort;
    if (document.activeElement !== cursorHideInput) cursorHideInput.value = state.cursorHideSec;
    renderTab(state, tab);
    savePortButton.disabled = busy;
  })().finally(() => { refreshPromise = null; });
  return refreshPromise;
}

async function act(action) {
  if (busy) return;
  busy = true;
  message.textContent = '';
  message.classList.remove('error');
  document.querySelectorAll('button').forEach((button) => { button.disabled = true; });
  try {
    await action();
  } catch (error) {
    message.textContent = error.message || '操作失败';
    message.classList.add('error');
  } finally {
    busy = false;
    try {
      await refresh();
    } catch (error) {
      message.textContent = error.message || '无法读取状态';
      message.classList.add('error');
    }
  }
}

toggleButton.addEventListener('click', () => {
  void act(async () => {
    if (isConnected) {
      await send('disconnect');
      message.textContent = '已断开连接。';
    } else {
      await send('connect');
      message.textContent = '已连接本机桥。';
    }
  });
});

autoAuthorize.addEventListener('change', () => {
  void act(async () => {
    const state = await send('set_auto_authorize', { enabled: autoAuthorize.checked });
    message.textContent = state.autoAuthorize
      ? '已开启自动授权：AI 可按需控制任意网页。'
      : '已关闭自动授权，回到手动逐页授权。';
  });
});

cdpEnabled.addEventListener('change', () => {
  void act(async () => {
    const state = await send('set_cdp_enabled', { enabled: cdpEnabled.checked });
    message.textContent = state.cdpEnabled
      ? '已开启 CDP 写入：点击/输入/截屏可用，写入时会出现提示条。'
      : '已关闭 CDP 写入：点击/输入/截屏将拒绝执行，纯读取照常可用。';
  });
});

saveHideButton.addEventListener('click', () => {
  void act(async () => {
    const state = await send('set_cursor_hide', { seconds: Number(cursorHideInput.value) });
    message.textContent = state.cursorHideSec === 0
      ? '光标将在每次移动结束的瞬间消失。'
      : `光标将在操作 ${state.cursorHideSec} 秒后淡出。`;
  });
});

savePortButton.addEventListener('click', () => {
  void act(async () => {
    const state = await send('set_bridge_port', { port: Number(bridgePortInput.value) });
    message.textContent = `本机桥端口已保存为 ${state.bridgePort}。`;
  });
});

authorizeButton.addEventListener('click', () => {
  void act(async () => {
    const tab = await currentTab();
    if (!httpTab(tab)) throw new Error('只能授权 HTTP(S) 标签页');
    await send('authorize_tab', { tabId: tab.id });
    message.textContent = '当前标签页已授权。';
  });
});

releaseButton.addEventListener('click', () => {
  void act(async () => {
    const tab = await currentTab();
    await send('release_tab', { tabId: tab.id });
    message.textContent = '当前标签页授权已释放。';
  });
});

void refresh().catch((error) => {
  message.textContent = error.message || '无法读取状态';
  message.classList.add('error');
});
// 只刷新状态，不改变用户选择的标签页。
const refreshTimer = setInterval(() => {
  if (!busy) void refresh().catch(() => {});
}, 2000);
window.addEventListener('pagehide', () => clearInterval(refreshTimer));
