'use strict';

const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const connectionDetail = document.getElementById('connection-detail');
const toggleButton = document.getElementById('toggle');
const tabTitle = document.getElementById('tab-title');
const tabStatus = document.getElementById('tab-status');
const tabBadge = document.getElementById('tab-badge');
const tabDomain = document.getElementById('tab-domain');
const modeDescription = document.getElementById('mode-description');
const authorizeButton = document.getElementById('authorize');
const releaseButton = document.getElementById('release');
const autoAuthorize = document.getElementById('auto-authorize');
const cdpEnabled = document.getElementById('cdp-enabled');
const screenshotCdp = document.getElementById('screenshot-cdp');
const screenshotDescription = document.getElementById('screenshot-description');
const bridgePortInput = document.getElementById('bridge-port');
const savePortButton = document.getElementById('save-port');
const cursorHideInput = document.getElementById('cursor-hide');
const saveHideButton = document.getElementById('save-hide');
const cursorTrailInput = document.getElementById('cursor-trail');
const saveTrailButton = document.getElementById('save-trail');
const message = document.getElementById('message');
let busy = false;
let refreshPromise = null;
let isConnected = false;
let isConnecting = false;
const dirty = new Set();
document.getElementById('version').textContent = `v${chrome.runtime.getManifest().version}`;
for (const input of [bridgePortInput, cursorHideInput, cursorTrailInput]) input.addEventListener('input', () => dirty.add(input));

function httpTab(tab) {
  return Boolean(tab && /^https?:\/\//i.test(tab.url || ''));
}

async function send(type, data = {}) {
  let timer;
  const response = await Promise.race([chrome.runtime.sendMessage({ type, ...data }), new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('扩展后台未响应，请重新加载扩展后重试')), 6000);
  })]).finally(() => clearTimeout(timer));
  if (!response || response.error) throw new Error(response?.error?.message || '后台未响应');
  return response.result;
}

async function currentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

function renderConnection(state) {
  isConnected = state.connected === true;
  isConnecting = state.connecting === true;
  statusText.textContent = isConnected ? '已连接' : isConnecting ? '正在连接' : '已断开';
  connectionDetail.textContent = isConnected ? 'AI 助手可以访问已授权网页'
    : isConnecting ? state.bridgeState : '连接后，AI 可操作已授权网页';
  statusDot.className = 'dot' + (isConnected ? ' on'
    : isConnecting ? ' wait' : '');
  toggleButton.textContent = isConnected ? '断开' : isConnecting ? '停止重连' : '连接';
  toggleButton.classList.toggle('connected', isConnected);
  toggleButton.disabled = busy;
}

function renderTab(state, tab) {
  tabTitle.textContent = tab?.title || '未找到网页';
  tabTitle.title = tab?.title || '';
  tabDomain.textContent = httpTab(tab) ? new URL(tab.url).host : '';
  const revoked = state.revokedTabIds?.includes(tab?.id);
  const allowed = httpTab(tab) && !revoked && (state.authorizedTabIds.includes(tab.id) || state.autoAuthorize);
  tabBadge.textContent = allowed ? '可控制' : httpTab(tab) ? '未授权' : '不支持';
  tabBadge.classList.toggle('allowed', allowed);
  tabStatus.textContent = httpTab(tab) ? (allowed ? (state.autoAuthorize ? '自动授权已开启' : '仅授权此页')
    : revoked ? '此页已释放，可重新授权' : '授权后，AI 才能读取和操作') : '请切换到 HTTP 或 HTTPS 网页';
  tabStatus.hidden = allowed;
  authorizeButton.hidden = allowed;
  releaseButton.hidden = !allowed;
  authorizeButton.disabled = busy || !httpTab(tab);
  releaseButton.disabled = busy || !allowed;
}

function refresh() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    const [state, tab] = await Promise.all([send('popup_status'), currentTab()]);
    renderConnection(state);
    autoAuthorize.checked = state.autoAuthorize === true;
    cdpEnabled.checked = state.cdpEnabled === true;
    screenshotCdp.checked = state.screenshotCdpEnabled !== false;
    modeDescription.textContent = state.cdpEnabled === true ? '优先 CDP，允许按页使用 DOM' : '使用 DOM 操作';
    screenshotDescription.textContent = state.screenshotCdpEnabled !== false ? '后台截图，按需临时附加' : '仅当前选中页，需临时授权';
    if (!dirty.has(bridgePortInput)) bridgePortInput.value = state.bridgePort;
    if (!dirty.has(cursorHideInput)) cursorHideInput.value = state.cursorHideSec;
    if (!dirty.has(cursorTrailInput)) cursorTrailInput.value = state.cursorTrailSec;
    renderTab(state, tab);
    savePortButton.disabled = busy;
    saveHideButton.disabled = busy;
    saveTrailButton.disabled = busy;
    autoAuthorize.disabled = busy;
    cdpEnabled.disabled = busy;
    screenshotCdp.disabled = busy;
    bridgePortInput.disabled = busy;
    cursorHideInput.disabled = busy;
    cursorTrailInput.disabled = busy;
  })().finally(() => { refreshPromise = null; });
  return refreshPromise;
}

function showConnectionError(error) {
  isConnected = false;
  isConnecting = true;
  statusText.textContent = '连接异常';
  connectionDetail.textContent = error.message || '无法读取连接状态';
  statusDot.className = 'dot wait';
  toggleButton.textContent = '重新连接';
  toggleButton.disabled = busy;
  toggleButton.classList.remove('connected');
  // 异常时点击应重新建立连接，而不是仅停止一个已失效的重连循环。
  isConnecting = false;
}

async function act(action) {
  if (busy) return;
  busy = true;
  message.textContent = '';
  message.hidden = true;
  message.classList.remove('error');
  document.querySelectorAll('button').forEach((button) => { button.disabled = true; });
  document.querySelectorAll('input').forEach((input) => { input.disabled = true; });
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
      showConnectionError(error);
      message.textContent = error.message || '无法读取状态';
      message.classList.add('error');
    }
    message.hidden = !message.textContent;
  }
}

toggleButton.addEventListener('click', () => {
  void act(async () => {
    if (isConnected || isConnecting) {
      toggleButton.textContent = '正在断开…';
      await send('disconnect');
      message.textContent = '已断开连接。';
    } else {
      toggleButton.textContent = '正在连接…';
      await send('connect');
      message.textContent = '已请求连接，正在确认命令通道。';
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
      ? '优先使用 CDP，附加失败可安全回退 DOM；截图设置独立。'
      : '点击与输入改用 DOM；截图设置独立，部分网站可能忽略模拟输入。';
  });
});

screenshotCdp.addEventListener('change', () => {
  void act(async () => {
    const state = await send('set_screenshot_cdp_enabled', { enabled: screenshotCdp.checked });
    message.textContent = state.screenshotCdpEnabled
      ? '已允许截图单独使用 CDP；仅为截图附加的调试器完成后会解除。'
      : '已关闭截图 CDP；仅能截取窗口当前选中的网页。';
  });
});

saveHideButton.addEventListener('click', () => {
  void act(async () => {
    const seconds = Number(cursorHideInput.value);
    if (!cursorHideInput.value.trim() || !Number.isInteger(seconds) || seconds < 0 || seconds > 60) throw new Error('请输入 0–60 的整数秒');
    const state = await send('set_cursor_hide', { seconds: Number(cursorHideInput.value) });
    dirty.delete(cursorHideInput);
    message.textContent = state.cursorHideSec === 0
      ? '光标将在每次移动结束的瞬间消失。'
      : `光标将在操作结束 ${state.cursorHideSec} 秒后淡出。`;
  });
});

saveTrailButton.addEventListener('click', () => {
  void act(async () => {
    const seconds = Number(cursorTrailInput.value);
    if (!cursorTrailInput.value.trim() || !Number.isInteger(seconds) || seconds < 0 || seconds > 60) throw new Error('请输入 0–60 的整数秒');
    const state = await send('set_cursor_trail', { seconds });
    dirty.delete(cursorTrailInput);
    message.textContent = state.cursorTrailSec === 0 ? '已关闭移动轨迹。' : `移动轨迹将在结束 ${state.cursorTrailSec} 秒后消失。`;
  });
});

savePortButton.addEventListener('click', () => {
  void act(async () => {
    const port = Number(bridgePortInput.value);
    if (!bridgePortInput.value.trim() || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('请输入 1–65535 的整数端口');
    const state = await send('set_bridge_port', { port: Number(bridgePortInput.value) });
    dirty.delete(bridgePortInput);
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
  showConnectionError(error);
  message.hidden = false;
  message.textContent = error.message || '无法读取状态';
  message.classList.add('error');
});
// 只刷新状态，不改变用户选择的标签页。
const refreshTimer = setInterval(() => {
  if (!busy) void refresh().catch(showConnectionError);
}, 2000);
window.addEventListener('pagehide', () => clearInterval(refreshTimer));
