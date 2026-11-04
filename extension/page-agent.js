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
  // 无事件监听器、无定时器、pointer-events:none，不影响页面交互与性能。——
  let cursorHost = null;
  let cursorSeen = false;

  function ensureCursor() {
    if (cursorHost && cursorHost.isConnected) return cursorHost.shadowRoot;
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;pointer-events:none';
    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `<style>
      #c { position: fixed; top: 0; left: 0; width: 22px; height: 22px; opacity: .95;
           will-change: transform; transition: transform 210ms cubic-bezier(.22,.61,.36,1);
           filter: drop-shadow(0 1px 2px rgba(0,0,0,.45)); }
      #c.first { transition: none; }
      #r { position: fixed; width: 14px; height: 14px; margin: -7px 0 0 -7px;
           border: 2px solid rgba(37,99,235,.85); border-radius: 50%; opacity: 0;
           will-change: transform, opacity; }
      #r.play { animation: ab-ripple 450ms ease-out forwards; }
      @keyframes ab-ripple { from { transform: scale(.45); opacity: .85; } to { transform: scale(3); opacity: 0; } }
    </style>
    <div id="c"><svg width="22" height="22" viewBox="0 0 24 24">
      <path d="M5 2 L19 12.5 L11.8 13.6 L8.6 20.5 Z" fill="rgba(17,24,39,.82)" stroke="#fff" stroke-width="1.5"/>
    </svg></div>
    <div id="r"></div>`;
    document.documentElement.appendChild(host);
    cursorHost = host;
    return shadow;
  }

  async function showCursor(point) {
    const shadow = ensureCursor();
    const cursor = shadow.getElementById('c');
    const ripple = shadow.getElementById('r');
    if (!cursorSeen) {
      cursor.classList.add('first');   // 首次出现直接落在目标点，不从 (0,0) 飞过来
      cursorSeen = true;
    }
    cursor.style.transform = `translate(${point.x - 2}px, ${point.y - 2}px)`;
    ripple.style.left = `${point.x}px`;
    ripple.style.top = `${point.y}px`;
    await new Promise((r) => setTimeout(r, 210));   // 等滑动完成，与视觉同步后再点击
    return { shown: true };
  }

  function cursorPulse(point) {
    const shadow = ensureCursor();
    const ripple = shadow.getElementById('r');
    ripple.style.left = `${point.x}px`;
    ripple.style.top = `${point.y}px`;
    ripple.classList.remove('play');
    void ripple.offsetWidth;                        // 重启动画
    ripple.classList.add('play');
    return { pulsed: true };
  }

  Object.defineProperty(globalThis, '__zcodeTabAgent', {
    value: Object.freeze({ snapshot, prepare, focus, focusTarget, showCursor, cursorPulse }),
    configurable: false,
    writable: false
  });
})();
