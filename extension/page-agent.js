(() => {
  'use strict';

  // 注入到隔离世界；重复注入保留当前引用，不接收网页脚本指令。
  if (globalThis.__aiBrowserPageAgent4) return;

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

  function describe(element) {
    const name = nameOf(element);
    let context = name;
    // 携带整行/卡片的身份信息，不能仅用重复的“订票”文字识别目标。
    for (let node = element.parentElement, depth = 0; node && node !== document.body && depth < 12; node = node.parentElement, depth++) {
      const text = compact(node.innerText, 1601);
      if (text.length > 1600) break;
      const row = node.matches('article,li,tr,[role="row"],[role="listitem"],[role="dialog"],[aria-modal="true"]');
      // 不跨入包含其他独立按钮的列表/页面容器：否则错误按钮也能匹配别班航班号。
      const buttons = [...node.querySelectorAll('button,[role="button"]')].filter(visible);
      if (!row && buttons.some(button => button !== element && !button.contains(element) && !element.contains(button))) break;
      if (text.length > context.length) context = text;
      if (row) break;
    }
    return { name, role: roleOf(element), tag: element.tagName.toLowerCase(), context,
      href: element.getAttribute('href'), expanded: element.getAttribute('aria-expanded') };
  }

  const identity = descriptor => JSON.stringify([descriptor.name, descriptor.role, descriptor.tag, descriptor.context, descriptor.href]);

  function resolve(ref) {
    if (typeof ref !== 'string' || !refs.has(ref)) throw new Error('ref 无效或已过期，请重新 snapshot');
    const record = refs.get(ref);
    const element = record.element;
    if (!visible(element)) throw new Error('目标已移除或不可见，请重新 snapshot');
    if (identity(describe(element)) !== record.identity) throw new Error('目标身份已变化（列表可能重排或复用节点），已阻止操作，请重新 snapshot');
    if (element.matches(':disabled') || element.closest('[inert], [aria-disabled="true"]')) {
      throw new Error('目标不可交互');
    }
    return element;
  }

  async function prepare(target) {
    const { ref, expectedContext, action } = typeof target === 'string' ? { ref: target } : target;
    const element = resolve(ref);
    if (action === 'click' && refs.get(ref).ambiguous && !expectedContext) throw new Error('同名按钮存在多个，请传 expectedContext 核对航班号等业务身份，不能只按序号点击');
    if (expectedContext && !describe(element).context.includes(expectedContext)) throw new Error('目标上下文与 expectedContext 不符，已阻止操作，请重新 snapshot');
    const before = element.getClientRects()[0];
    // 已在视口内的目标不滚动，避免每次动作把目标挪到同一屏幕坐标。
    const outside = before && (before.top < 0 || before.left < 0 || before.bottom > innerHeight || before.right > innerWidth);
    const smooth = outside && document.visibilityState === 'visible' && !matchMedia('(prefers-reduced-motion: reduce)').matches;
    element.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: smooth ? 'smooth' : 'instant' });
    if (smooth) {
      await new Promise(done => {
        let frame, timer, last = before, stable = 0;
        const finish = () => { cancelAnimationFrame(frame); clearTimeout(timer); done(); };
        const step = () => {
          const rect = element.getClientRects()[0];
          if (!rect || document.visibilityState !== 'visible') return finish();
          stable = Math.abs(rect.top - last.top) + Math.abs(rect.left - last.left) < .5 ? stable + 1 : 0;
          last = rect;
          if (stable >= 3 && rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth) finish();
          else frame = requestAnimationFrame(step);
        };
        frame = requestAnimationFrame(step);
        timer = setTimeout(finish, 450);
      });
      // 超出原生平滑滚动的等待上限后直接定位，不能无限拖住指令。
      element.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    }
    const after = element.getClientRects()[0];
    if (before && after && (before.top !== after.top || before.left !== after.left)) {
      // 仅实际发生滚动时等待布局稳定，后台不依赖 rAF。
      await new Promise((resolveLayout) => setTimeout(resolveLayout, 50));
    }
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
    return { x, y, target: describe(element) };
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

  function scrollArea(ref) {
    if (ref) {
      const element = resolve(ref);
      if (element.scrollHeight <= element.clientHeight) throw new Error('目标不是可滚动容器');
      return element;
    }
    const root = document.scrollingElement;
    // 优先主文档；主文档不滚动时支持应用内的独立列表容器。
    if (root && root.scrollHeight > root.clientHeight + 2) return root;
    return [...document.querySelectorAll('*')].filter(element => {
      const style = getComputedStyle(element);
      return /auto|scroll/.test(style.overflowY) && element.clientHeight > 80 &&
        element.scrollHeight > element.clientHeight + 2 && visible(element);
    }).sort((a, b) => b.clientHeight * b.clientWidth - a.clientHeight * a.clientWidth)[0] || root;
  }

  const position = area => ({ top: area.scrollTop, height: area.scrollHeight, viewport: area.clientHeight,
    atBottom: area.scrollTop + area.clientHeight >= area.scrollHeight - 2 });
  const moveScroll = (area, top) => area.scrollTo({ top, behavior: 'instant' });

  async function scroll({ direction, ref } = {}) {
    if (!['up', 'down', 'top', 'bottom'].includes(direction)) throw new Error('不支持的滚动方向');
    const area = scrollArea(ref);
    if (!area) throw new Error('页面没有可滚动区域');
    const before = position(area);
    const top = direction === 'top' ? 0 : direction === 'bottom' ? area.scrollHeight :
      area.scrollTop + (direction === 'up' ? -1 : 1) * area.clientHeight * .8;
    moveScroll(area, top);
    await new Promise(done => setTimeout(done, 250));
    refs.clear();
    return { before, after: position(area), refsExpired: true, note: '滚动到底不代表业务数据已完整；请重新 snapshot。' };
  }

  async function explore() {
    const started = Date.now();
    // 页面明确显示忙碌时先等待，不能把尚未出现滚动条当成加载完毕。
    while ([...document.querySelectorAll('[aria-busy="true"],[role="progressbar"]')].some(visible) && Date.now() - started < 2000) {
      await new Promise(done => setTimeout(done, 200));
    }
    const area = scrollArea();
    const report = { attempted: true, stopReason: 'no-scroll-area', complete: false, steps: 0,
      observed: [], observationsTruncated: false, warning: '探测停止不等于业务全量；没有可靠结束证据时不得认定最后一项。',
      limits: { milliseconds: 8000, steps: 40, observedCharacters: 24000 } };
    if (!area || area.scrollHeight <= area.clientHeight + 2) return report;
    // 弹层挡住页面时不盲目滚动底层列表。
    if ([...document.querySelectorAll('[role="dialog"],[aria-modal="true"]')].some(visible)) {
      report.stopReason = 'blocked-by-dialog'; return report;
    }
    const initial = { top: area.scrollTop, left: area.scrollLeft };
    const observed = new Set(); let chars = 0, signature = '', stableSince = Date.now();
    const hash = text => { let n = 0; for (let i = 0; i < text.length; i++) n = (n * 31 + text.charCodeAt(i)) | 0; return n; };
    try {
      moveScroll(area, 0);
      for (; report.steps < 40 && Date.now() - started < 8000; report.steps++) {
        await new Promise(done => setTimeout(done, 180));
        const state = position(area);
        const text = document.body?.innerText || '';
        const next = `${state.height}:${state.top}:${hash(text)}`;
        if (next !== signature) { signature = next; stableSince = Date.now(); }
        for (const element of document.querySelectorAll(SELECTOR)) {
          const rect = element.getClientRects()[0];
          if (!rect || rect.bottom <= 0 || rect.top >= innerHeight || !visible(element)) continue;
          const item = describe(element), key = identity(item);
          if (observed.has(key)) continue;
          observed.add(key);
          if (chars + item.context.length + item.name.length > 24000 || report.observed.length >= 300) {
            report.observationsTruncated = true; continue;
          }
          chars += item.context.length + item.name.length;
          report.observed.push({ ...item, scrollTop: state.top });
        }
        const busy = [...document.querySelectorAll('[aria-busy="true"],[role="progressbar"]')].some(visible);
        if (state.atBottom && !busy && Date.now() - stableSince >= 1600) {
          report.stopReason = 'bottom-stable'; break;
        }
        if (!state.atBottom) moveScroll(area, area.scrollTop + Math.max(1, area.clientHeight * .8));
      }
      if (report.stopReason !== 'bottom-stable') report.stopReason = Date.now() - started >= 8000 ? 'time-budget' : 'step-budget';
      report.end = position(area);
      report.end.textTail = (area.innerText || document.body?.innerText || '').slice(-4000);
    } finally {
      area.scrollTo({ top: initial.top, left: initial.left, behavior: 'instant' });
      await new Promise(done => setTimeout(done, 100));
      report.restoredScroll = Math.abs(area.scrollTop - initial.top) < 2;
      report.elapsedMs = Date.now() - started;
    }
    return report;
  }

  async function snapshot(options = {}) {
    const load = options?.load || 'auto';
    if (!['auto', 'current'].includes(load)) throw new Error('load 必须为 auto 或 current');
    const loading = load === 'auto' ? await explore() : { attempted: false, complete: false, stopReason: 'current-only' };
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
    // 返回当前真实内容；短文档不等于尚未加载，不无条件追加 1.2 秒延迟。

    const candidates = Array.from(document.querySelectorAll(SELECTOR));
    const buttonCounts = new Map();
    for (const element of candidates) {
      if (roleOf(element) !== 'button') continue;
      const name = nameOf(element);
      if (name) buttonCounts.set(name, (buttonCounts.get(name) || 0) + 1);
    }
    const domOrder = new Map(candidates.map((element, index) => [element, index]));
    // 先保留视口内控件，防止长列表把当前弹窗的关闭按钮挤出上限。
    const inViewport = new Set(candidates.filter(element => Array.from(element.getClientRects()).some(rect =>
      rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 &&
      rect.top < innerHeight && rect.left < innerWidth)));
    candidates.sort((a, b) => Number(inViewport.has(b)) - Number(inViewport.has(a)));
    let scannedCandidates = 0;
    for (const element of candidates) {
      if (elements.length >= 150) break;
      scannedCandidates++;
      if (!visible(element)) continue;
      const ref = `r${generation}-${elements.length + 1}`;
      const descriptor = describe(element);
      const ambiguous = descriptor.role === 'button' && buttonCounts.get(descriptor.name) > 1;
      refs.set(ref, { element, identity: identity(descriptor), ambiguous });
      const item = {
        ref,
        ...descriptor,
        requiresExpectedContext: ambiguous,
        inViewport: inViewport.has(element)
      };
      // 密码框保留定位信息，不把内容放入快照。
      if (element instanceof HTMLInputElement && element.type !== 'password') item.value = element.value.slice(0, 2000);
      else if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) item.value = element.value.slice(0, 2000);
      else if (element.isContentEditable) item.value = (element.innerText || '').slice(0, 2000);
      elements.push(item);
    }
    // 输出仍按 DOM 顺序排列；优先级只决定上限内保留哪些元素。
    elements.sort((a, b) => domOrder.get(refs.get(a.ref).element) - domOrder.get(refs.get(b.ref).element));
    return {
      title: document.title,
      url: location.href,
      text: text.slice(0, 12000),
      textLength: text.length,
      frames: iframes.length,
      elements,
      loading,
      coverage: {
        scope: 'loaded-dom',
        selectionPriority: 'viewport-first',
        dataCompleteness: 'unknown',
        documentReadyState: document.readyState || 'unknown',
        textTruncated: text.length > 12000,
        elementScanLimited: scannedCandidates < candidates.length,
        candidateCount: candidates.length,
        scannedCandidates,
        limits: { textCharacters: 12000, elements: 150 }
      }
    };
  }

  async function domClick(ref) {
    resolve(ref).click();
    return { clicked: true, mode: 'dom', trusted: false };
  }

  async function domFill({ ref, text }) {
    await focus(ref);
    const element = resolve(ref);
    if (element.isContentEditable) element.textContent = text;
    else {
      // 使用原生 setter，兼容通过 value 属性拦截输入的框架。
      const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, text);
    }
    element.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return { filled: true, mode: 'dom', trusted: false };
  }

  function domPress(key) {
    const element = document.activeElement || document.body;
    if (key === 'Control+A') {
      if (typeof element.select === 'function') element.select();
      else if (element.isContentEditable) {
        const range = document.createRange(); range.selectNodeContents(element);
        const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
      } else throw new Error('DOM 模式下全选需要先聚焦文本框');
      return { pressed: true, mode: 'dom', trusted: false };
    }
    const actual = key === 'Space' ? ' ' : key;
    const allowed = element.dispatchEvent(new KeyboardEvent('keydown', { key: actual, bubbles: true, cancelable: true }));
    if (allowed && key === 'Tab') {
      const targets = [...document.querySelectorAll('a[href],button,input,textarea,select,[tabindex],[contenteditable]')]
        .filter(item => visible(item) && !item.matches(':disabled') && item.tabIndex >= 0);
      targets[(targets.indexOf(element) + 1) % targets.length]?.focus();
    } else if (allowed && key === 'Enter' && element instanceof HTMLInputElement && element.form) {
      element.form.requestSubmit();
    } else if (allowed && ['Enter', 'Space'].includes(key) && element.matches('button,a[href],input[type=checkbox],input[type=radio]')) {
      element.click();
    } else if (allowed && ['Backspace', 'Delete'].includes(key) && typeof element.setRangeText === 'function') {
      const start = element.selectionStart, end = element.selectionEnd;
      if (start !== null && !element.readOnly) {
        element.setRangeText('', start === end && key === 'Backspace' ? Math.max(0, start - 1) : start,
          start === end && key === 'Delete' ? end + 1 : end, 'end');
        element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
      }
    }
    element.dispatchEvent(new KeyboardEvent('keyup', { key: actual, bubbles: true }));
    return { pressed: true, mode: 'dom', trusted: false, note: 'DOM 按键为非可信事件，网站可能忽略；不会自动启用 CDP。' };
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
    scroll: guarded('scroll', scroll),
    inspect: guarded('inspect', ref => { const record = refs.get(ref); return record?.element.isConnected ? describe(record.element) : { removed: true }; }),
    prepare: guarded('prepare', prepare),
    focus: guarded('focus', focus),
    focusTarget: guarded('focusTarget', focusTarget),
    showCursor: guarded('showCursor', point => globalThis.__aiBrowserCursor.show(point)),
    cursorPulse: guarded('cursorPulse', point => globalThis.__aiBrowserCursor.click(point)),
    hideCursor: guarded('hideCursor', () => { globalThis.__aiBrowserCursor?.hide(); return { hidden: true }; }),
    domClick: guarded('domClick', domClick),
    domFill: guarded('domFill', domFill),
    domPress: guarded('domPress', domPress)
  };

  Object.defineProperty(globalThis, '__aiBrowserPageAgent4', {
    value: Object.freeze(agent),
    configurable: false,
    writable: false
  });
})();
