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

  // —— 可视光标：Web Animations API 驱动。
  // 显式关键帧 + 合成器动画：不依赖 CSS transition / rAF / 前后计算样式，
  // 任何页面任何负载下中间帧必然渲染。操作停止后自动淡出（弹窗可配 0-60 秒）。——
  let cursorHost = null;
  let cursorShadow = null;
  let hideTimer = null;
  let hideAfterMs = 10000;   // 弹窗配置：0-60 秒
  let cursorX = -100, cursorY = -100;
  let cursorSeen = false;

  function ensureCursor() {
    if (cursorHost && cursorShadow && cursorHost.isConnected) return cursorShadow;
    const host = document.createElement('div');
    host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none';
    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `<style>
      #layer { position: fixed; inset: 0; }
      #cursor { position: fixed; top: 0; left: 0; width: 26px; height: 26px; will-change: transform; }
      #ball { position: absolute; left: -2px; top: -2px; width: 13px; height: 13px;
              border-radius: 50%; background: rgba(37,99,235,.9);
              box-shadow: 0 0 10px rgba(37,99,235,.75); }
      #f { position: fixed; width: 20px; height: 20px; margin: -10px 0 0 -10px; border-radius: 50%;
           background: rgba(37,99,235,.8); opacity: 0; }
      #r { position: fixed; width: 22px; height: 22px; margin: -11px 0 0 -11px;
           border: 3px solid rgba(37,99,235,.9); border-radius: 50%; opacity: 0; }
    </style>
    <div id="layer">
      <div id="cursor">
        <div id="ball"></div>
        <svg width="26" height="26" viewBox="0 0 24 24">
          <path d="M5 2 L19 12.5 L11.8 13.6 L8.6 20.5 Z" fill="rgba(17,24,39,.85)" stroke="#fff" stroke-width="1.6"/>
        </svg>
      </div>
    </div>
    <div id="f"></div><div id="r"></div>`;
    document.documentElement.appendChild(host);
    cursorHost = host;
    cursorShadow = shadow;
    const mo = new MutationObserver(() => {
      if (cursorHost && !cursorHost.isConnected) document.documentElement.appendChild(cursorHost);
    });
    mo.observe(document.documentElement, { childList: true });
    return shadow;
  }

  async function showCursor(point) {
    const shadow = ensureCursor();
    clearTimeout(hideTimer);
    cursorHost.style.opacity = '1';
    const cursor = shadow.getElementById('cursor');
    const flash = shadow.getElementById('f');
    const to = { x: point.x - 3, y: point.y - 3 };
    const from = cursorSeen ? { x: cursorX, y: cursorY } : to;
    cursorSeen = true;
    cursorX = to.x; cursorY = to.y;
    // WAAPI：显式关键帧，合成器驱动，不依赖 rAF/CSS transition/前后计算样式
    cursor.animate(
      [
        { transform: `translate(${from.x}px, ${from.y}px)` },
        { transform: `translate(${to.x}px, ${to.y}px)` }
      ],
      { duration: 500, easing: 'cubic-bezier(.4, 0, .2, 1)', fill: 'forwards' }
    );
    flash.style.left = `${to.x + 3}px`;
    flash.style.top = `${to.y + 3}px`;
    await new Promise(r => setTimeout(r, 500));   // 等动画完成（点击与视觉同步）
    return { shown: true };
  }

  function cursorPulse(point) {
    const shadow = ensureCursor();
    clearTimeout(hideTimer);
    const flash = cursorShadow.getElementById('f');
    flash.style.left = `${point.x}px`;
    flash.style.top = `${point.y}px`;
    flash.animate(
      [{ transform: 'scale(.5)', opacity: .85 }, { transform: 'scale(2.2)', opacity: 0 }],
      { duration: 350, easing: 'ease-out', fill: 'forwards' }
    );
    const ripple = cursorShadow.getElementById('r');
    ripple.style.left = `${point.x}px`;
    ripple.style.top = `${point.y}px`;
    ripple.animate(
      [{ transform: 'scale(.35)', opacity: .95 }, { transform: 'scale(3.4)', opacity: 0 }],
      { duration: 650, easing: 'cubic-bezier(.2,.6,.35,1)', fill: 'forwards' }
    );
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { cursorHost.style.opacity = '0'; }, hideAfterMs);
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
