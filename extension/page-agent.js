(() => {
  'use strict';

  // 注入到隔离世界；重复注入保留当前引用，不接收网页脚本指令。
  if (globalThis.__zcodeTabAgent) return;

  let generation = Date.now();
  let refs = new Map();
  const SELECTOR = 'input,textarea,select,button,a,[role],[contenteditable]';
  const TEXT_INPUTS = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number']);

  function visible(element) {
    if (!element.isConnected || element.closest('[hidden]')) return false;
    for (let node = element; node instanceof Element; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' ||
          style.visibility === 'collapse' || Number(style.opacity) === 0) return false;
    }
    return Array.from(element.getClientRects()).some((rect) => rect.width > 0 && rect.height > 0);
  }

  function compact(value, limit = 500) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
  }

  function nameOf(element) {
    const labelledBy = element.getAttribute('aria-labelledby');
    const labelledText = labelledBy ? labelledBy.split(/\s+/).map((id) => {
      return document.getElementById(id)?.textContent || '';
    }).join(' ') : '';
    const labels = element.labels ? Array.from(element.labels).map((label) => label.innerText).join(' ') : '';
    return compact(element.getAttribute('aria-label') || labelledText || labels ||
      element.getAttribute('alt') || element.innerText || element.getAttribute('placeholder') ||
      element.getAttribute('title') ||
      (element instanceof HTMLInputElement && ['button', 'submit', 'reset'].includes(element.type) ? element.value : ''));
  }

  function roleOf(element) {
    const explicit = element.getAttribute('role');
    if (explicit) return explicit;
    const tag = element.tagName.toLowerCase();
    if (tag === 'a') return element.hasAttribute('href') ? 'link' : 'generic';
    if (tag === 'button') return 'button';
    if (tag === 'textarea' || element.isContentEditable) return 'textbox';
    if (tag === 'select') return element.multiple ? 'listbox' : 'combobox';
    if (tag === 'input') {
      const roles = {
        button: 'button', submit: 'button', reset: 'button', image: 'button',
        checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton',
        search: 'searchbox'
      };
      return roles[element.type] || 'textbox';
    }
    return 'generic';
  }

  function resolve(ref) {
    if (typeof ref !== 'string' || !refs.has(ref)) throw new Error('ref 无效或已过期，请重新 snapshot');
    const element = refs.get(ref);
    if (!visible(element)) throw new Error('目标已移除或不可见，请重新 snapshot');
    if (element.matches(':disabled') || element.closest('[inert], [aria-disabled="true"]')) {
      throw new Error('目标不可交互');
    }
    return element;
  }

  async function prepare(ref) {
    const element = resolve(ref);
    element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    // 等待布局稳定；后台标签页不依赖 requestAnimationFrame。
    await new Promise((resolveLayout) => setTimeout(resolveLayout, 50));
    resolve(ref);
    const rects = Array.from(element.getClientRects());
    const rect = rects.find((item) => item.width > 0 && item.height > 0 &&
      item.bottom > 0 && item.right > 0 && item.top < innerHeight && item.left < innerWidth);
    if (!rect) throw new Error('目标不在可操作的视口内');
    const left = Math.max(0, rect.left);
    const right = Math.min(innerWidth, rect.right);
    const top = Math.max(0, rect.top);
    const bottom = Math.min(innerHeight, rect.bottom);
    const x = (left + right) / 2;
    const y = (top + bottom) / 2;
    const hit = document.elementFromPoint(x, y);
    if (!hit || (hit !== element && !element.contains(hit))) throw new Error('目标中心被其他元素遮挡');
    return { x, y };
  }

  async function focusTarget(ref) {
    await prepare(ref);
    const element = resolve(ref);
    element.focus({ preventScroll: true });
    if (document.activeElement !== element && !element.contains(document.activeElement)) {
      throw new Error('目标无法获得焦点');
    }
    return { focused: true };
  }

  async function focus(ref) {
    const element = resolve(ref);
    const isTextInput = element instanceof HTMLInputElement && TEXT_INPUTS.has(element.type);
    const isTextarea = element instanceof HTMLTextAreaElement;
    if (!isTextInput && !isTextarea && !element.isContentEditable) {
      throw new Error('fill 仅支持文本输入框、textarea 或 contenteditable');
    }
    if (element.readOnly || element.getAttribute('aria-readonly') === 'true') throw new Error('目标为只读');
    await focusTarget(ref);
    return { focused: true };
  }

  async function snapshot() {
    generation = Math.max(generation + 1, Date.now());
    refs = new Map();
    const elements = [];
    const iframes = Array.from(document.querySelectorAll('iframe'));

    const collectText = () => {
      let text = (document.body?.innerText || '');
      // 同源 iframe 文本并入；跨域受浏览器隔离拿不到，如实以 frames 计数呈现。
      for (const frame of iframes) {
        try {
          const inner = frame.contentDocument?.body?.innerText || '';
          if (inner.trim()) text += '\n[iframe]\n' + inner;
        } catch { /* 跨域 iframe */ }
      }
      return text;
    };

    let text = collectText();
    // SPA 异步渲染：首拍过短时等一次再补拍（有上限，避免拖慢正常页面）。
    if (text.trim().length < 200) {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      text = collectText();
    }

    for (const element of document.querySelectorAll(SELECTOR)) {
      if (elements.length >= 150) break;
      if (!visible(element)) continue;
      const ref = `r${generation}-${elements.length + 1}`;
      refs.set(ref, element);
      const item = {
        ref,
        role: roleOf(element),
        name: nameOf(element),
        tag: element.tagName.toLowerCase()
      };
      // 密码框保留定位信息，不把内容放入快照。
      if (element instanceof HTMLInputElement && element.type !== 'password') item.value = element.value.slice(0, 2000);
      else if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) item.value = element.value.slice(0, 2000);
      else if (element.isContentEditable) item.value = (element.innerText || '').slice(0, 2000);
      elements.push(item);
    }
    return {
      title: document.title,
      url: location.href,
      text: text.slice(0, 12000),
      textLength: text.length,
      frames: iframes.length,
      elements
    };
  }

  // —— 可视光标：仅在写入操作时出现。纯 transform/opacity 合成器动画，
  // 无事件监听器、无轮询，pointer-events:none，不影响页面交互与性能。
  // 操作停止 2.5 秒后光标自动淡出，不残留屏幕。——
  let cursorHost = null;
  let cursorShadow = null;
  let cursorSeen = false;
  let hideTimer = null;
  let hideAfterMs = 10000;   // 每次操作随命令下发（0-60000ms），由扩展弹窗配置

  function ensureCursor() {
    // 注意：closed 模式下 host.shadowRoot 恒为 null，必须持有 ShadowRoot 引用。
    if (cursorHost && cursorShadow && cursorHost.isConnected) return cursorShadow;
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;pointer-events:none';
    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `<style>
      #c { position: fixed; top: 0; left: 0; width: 26px; height: 26px; opacity: .96;
           will-change: transform; transition: transform 600ms cubic-bezier(.45,.05,.25,1);
           filter: drop-shadow(0 1px 3px rgba(0,0,0,.5)); }
      #c.first { transition: none; }
      #t { position: absolute; left: -1px; top: -1px; width: 13px; height: 13px; border-radius: 50%;
           background: rgba(37,99,235,.9); box-shadow: 0 0 10px rgba(37,99,235,.75); }
      #f { position: fixed; width: 20px; height: 20px; margin: -10px 0 0 -10px; border-radius: 50%;
           background: rgba(37,99,235,.8); opacity: 0; will-change: transform, opacity; }
      #f.play { animation: ab-flash 350ms ease-out forwards; }
      #r { position: fixed; width: 22px; height: 22px; margin: -11px 0 0 -11px;
           border: 3px solid rgba(37,99,235,.9); border-radius: 50%; opacity: 0;
           will-change: transform, opacity; }
      #r.play { animation: ab-ripple 720ms cubic-bezier(.2,.6,.35,1) forwards; }
      @keyframes ab-flash { from { transform: scale(.5); opacity: .9; } to { transform: scale(2.2); opacity: 0; } }
      @keyframes ab-ripple { from { transform: scale(.35); opacity: .95; } to { transform: scale(3.4); opacity: 0; } }
    </style>
    <div id="c">
      <div id="t"></div>
      <svg width="26" height="26" viewBox="0 0 24 24">
        <path d="M5 2 L19 12.5 L11.8 13.6 L8.6 20.5 Z" fill="rgba(17,24,39,.85)" stroke="#fff" stroke-width="1.6"/>
      </svg>
    </div>
    <div id="f"></div><div id="r"></div>`;
    document.documentElement.appendChild(host);
    cursorHost = host;
    cursorShadow = shadow;
    cursorSeen = false;
    return shadow;
  }

  async function showCursor(point) {
    const shadow = ensureCursor();
    const cursor = shadow.getElementById('c');
    const flash = shadow.getElementById('f');
    const ripple = shadow.getElementById('r');
    clearTimeout(hideTimer);
    cursorHost.style.opacity = '1';
    if (Number.isInteger(point.hideMs) && point.hideMs >= 0 && point.hideMs <= 60000) hideAfterMs = point.hideMs;
    const target = `translate(${point.x - 3}px, ${point.y - 3}px)`;
    if (!cursorSeen) {
      // 首次出现：直接落在目标点（无过渡），强制重算后恢复过渡，后续移动平滑滑动
      cursor.style.transition = 'none';
      cursor.style.transform = target;
      void cursor.offsetWidth;
      cursor.style.transition = '';
      cursorSeen = true;
    }
    // 拖尾光球内嵌在光标元素里，随同一个 transform 平滑移动——永不分离
    cursor.style.transform = target;
    flash.style.left = `${point.x}px`;
    flash.style.top = `${point.y}px`;
    ripple.style.left = `${point.x}px`;
    ripple.style.top = `${point.y}px`;
    await new Promise((r) => setTimeout(r, 600));   // 等滑动完成（600ms 可见轨迹），与视觉同步后再点击
    return { shown: true };
  }

  function cursorPulse(point) {
    const shadow = ensureCursor();
    const flash = shadow.getElementById('f');
    const ripple = shadow.getElementById('r');
    if (Number.isInteger(point.hideMs) && point.hideMs >= 0 && point.hideMs <= 60000) hideAfterMs = point.hideMs;
    flash.style.left = `${point.x}px`;
    flash.style.top = `${point.y}px`;
    flash.classList.remove('play');
    void flash.offsetWidth;                         // 重启动画
    flash.classList.add('play');                    // 点击闪光
    ripple.classList.remove('play');
    void ripple.offsetWidth;
    ripple.classList.add('play');                   // 点击涟漪
    // 消失延时由弹窗配置（0=运动完立即消失，默认 10s，上限 60s）
    clearTimeout(hideTimer);
    if (hideAfterMs <= 0) {
      if (cursorHost) cursorHost.style.opacity = '0';
    } else {
      hideTimer = setTimeout(() => { if (cursorHost) cursorHost.style.opacity = '0'; }, hideAfterMs);
    }
    return { pulsed: true };
  }

  // Edge 对注入函数抛错可能返回 result:null；这里统一捕获并把真实错误带回主世界。
  const guarded = (name, fn) => async (...a) => {
    try {
      return await fn(...a);
    } catch (error) {
      return { __zcodeError: String((error && error.message) || error) };
    }
  };

  const agent = {
    snapshot: guarded('snapshot', snapshot),
    prepare: guarded('prepare', prepare),
    focus: guarded('focus', focus),
    focusTarget: guarded('focusTarget', focusTarget),
    showCursor: guarded('showCursor', showCursor),
    cursorPulse: guarded('cursorPulse', cursorPulse)
  };

  Object.defineProperty(globalThis, '__zcodeTabAgent', {
    value: Object.freeze(agent),
    configurable: false,
    writable: false
  });
})();
