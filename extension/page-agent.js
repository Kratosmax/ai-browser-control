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

  function snapshot() {
    generation = Math.max(generation + 1, Date.now());
    refs = new Map();
    const elements = [];
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
      text: (document.body?.innerText || '').slice(0, 12000),
      elements
    };
  }

  Object.defineProperty(globalThis, '__zcodeTabAgent', {
    value: Object.freeze({ snapshot, prepare, focus, focusTarget }),
    configurable: false,
    writable: false
  });
})();
