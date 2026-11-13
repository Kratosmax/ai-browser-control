(() => {
  'use strict';

  // 注入到隔离世界；重复注入保留当前引用，不接收网页脚本指令。
  if (globalThis.__aiBrowserPageAgent10) return;
  // 旧代理不可覆盖；新后台使用10，旧调用方仅在首次注入时获得兼容别名。
  const previousAgent = globalThis.__aiBrowserPageAgent9 || globalThis.__aiBrowserPageAgent8;
  if (previousAgent) void previousAgent.hideCursor?.();

  // 代次保留mod100=10的命名空间，避免同一毫秒升级后误认旧9的ref。
  let generation = Date.now() * 100 + 10;
  let refs = new Map();
  let refUrl = location.href;
  let refDocument = document.documentElement;
  let snapshotCache = null;
  let snapshotRequest = 0;
  const SELECTOR = 'input,textarea,select,button,a,td,th,main,dialog,[role],[tabindex],[contenteditable],[aria-haspopup],[draggable="true"],[ondrop]';
  const TEXT_INPUTS = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number']);
  const IMPLICIT_SUBMIT_INPUTS = new Set([...TEXT_INPUTS, 'date', 'month', 'week', 'time', 'datetime-local']);

  // HTMLFormElement的命名控件可遮住DOM方法；正常可调用方法保留原行为，非函数才退回原生原型。
  function elementMethod(element, name, ...args) {
    const own = element[name];
    const method = typeof own === 'function' ? own : Element.prototype[name];
    return method.apply(element, args);
  }

  function visible(element) {
    if (!element.isConnected || elementMethod(element, 'closest', '[hidden]')) return false;
    for (let node = element; node instanceof Element; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' ||
          style.visibility === 'collapse' || Number(style.opacity) === 0) return false;
    }
    return Array.from(elementMethod(element, 'getClientRects', )).some((rect) => rect.width > 0 && rect.height > 0);
  }

  function scanCache() {
    return { descriptors: new WeakMap(), ancestors: new WeakMap(), visibility: new WeakMap(), styleVisibility: new WeakMap() };
  }

  function scanVisible(element, cache) {
    if (!cache) return visible(element);
    if (cache.visibility.has(element)) return cache.visibility.get(element);
    const path = []; let shown = element.isConnected && !elementMethod(element, 'closest', '[hidden]');
    if (shown) for (let node = element; node instanceof Element; node = node.parentElement) {
      if (cache.styleVisibility.has(node)) { shown = cache.styleVisibility.get(node); break; }
      path.push(node);
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0) { shown = false; break; }
    }
    for (const node of path) cache.styleVisibility.set(node, shown);
    const result = Boolean(shown && Array.from(elementMethod(element, 'getClientRects', )).some(rect => rect.width > 0 && rect.height > 0));
    cache.visibility.set(element, result);
    return result;
  }

  function inViewport(element) {
    return Array.from(elementMethod(element, 'getClientRects', )).some(rect => rect.width > 0 && rect.height > 0 &&
      rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth);
  }

  function popupRoots(cache) {
    const roots = new Set(), collapsed = new Set();
    const nativeSelect = root => root instanceof HTMLSelectElement || Boolean(elementMethod(root, 'closest', 'select'));
    for (const trigger of document.querySelectorAll('[aria-controls],[aria-owns]')) {
      if (trigger instanceof HTMLSelectElement) continue;
      const ids = (elementMethod(trigger, 'getAttribute', 'aria-controls') || '') + ' ' + (elementMethod(trigger, 'getAttribute', 'aria-owns') || '');
      for (const id of ids.split(/\s+/).filter(Boolean)) {
        const root = document.getElementById(id), popup = elementMethod(trigger, 'getAttribute', 'aria-haspopup');
        if (!root || nativeSelect(root) || !((popup && popup !== 'false') || ['menu', 'listbox'].includes(elementMethod(root, 'getAttribute', 'role')))) continue;
        if (elementMethod(trigger, 'getAttribute', 'aria-expanded') === 'false') { collapsed.add(root); continue; }
        const nav = elementMethod(root, 'closest', 'nav,[role="navigation"]');
        const floating = ['absolute', 'fixed'].includes(getComputedStyle(root).position) || elementMethod(root, 'matches', ':popover-open');
        // aria-controls也用于侧栏折叠；静态导航不能仅凭关联属性晋升为弹层。
        if (nav && (nav === root || !floating || !popup || popup === 'false')) continue;
        if (!popup && !floating) continue;
        if (scanVisible(trigger, cache) && scanVisible(root, cache)) roots.add(root);
      }
    }
    // Plain menus/listboxes in navigation are not popups. Floating CSS menus
    // inside navigation need a nearby open popup trigger as additional evidence.
    for (const root of document.querySelectorAll('[role="menu"],[role="listbox"]')) {
      if (roots.has(root) || collapsed.has(root) || nativeSelect(root) || !scanVisible(root, cache)) continue;
      const style = getComputedStyle(root);
      if (!['absolute', 'fixed'].includes(style.position) && !elementMethod(root, 'matches', ':popover-open')) continue;
      const nav = elementMethod(root, 'closest', 'nav,[role="navigation"]');
      if (nav === root) continue;
      if (!nav && elementMethod(root, 'getAttribute', 'role') !== 'listbox') { roots.add(root); continue; }
      let associated = false;
      for (let node = root.parentElement, depth = 0; node && node !== document.body && depth < 3; node = node.parentElement, depth++) {
        associated = [node, ...elementMethod(node, 'querySelectorAll', '[aria-haspopup]')].some(trigger => {
          const popup = elementMethod(trigger, 'getAttribute', 'aria-haspopup');
          if (!popup || popup === 'false' || trigger instanceof HTMLSelectElement || elementMethod(root, 'contains', trigger) ||
              elementMethod(trigger, 'getAttribute', 'aria-expanded') === 'false' || !scanVisible(trigger, cache)) return false;
          const ids = ((elementMethod(trigger, 'getAttribute', 'aria-controls') || '') + ' ' + (elementMethod(trigger, 'getAttribute', 'aria-owns') || '')).trim();
          return !ids || ids.split(/\s+/).includes(root.id);
        });
        if (associated || node === nav) break;
      }
      if (associated) roots.add(root);
    }
    return [...roots];
  }

  function independentAction(element) {
    return elementMethod(element, 'matches', 'button,input,select,textarea,a[href],[contenteditable="true"],[draggable="true"],[ondrop]') ||
      ['button', 'link', 'checkbox', 'radio', 'switch', 'combobox', 'textbox', 'searchbox', 'slider', 'spinbutton'].includes(elementMethod(element, 'getAttribute', 'role')) ||
      elementMethod(element, 'hasAttribute', 'onclick') || typeof element.onclick === 'function' ||
      Boolean(elementMethod(element, 'getAttribute', 'aria-haspopup') && elementMethod(element, 'getAttribute', 'aria-haspopup') !== 'false');
  }

  function popupItems(roots, cache) {
    const items = new Set();
    for (const root of roots) {
      for (const element of elementMethod(root, 'querySelectorAll', 'li,[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="option"],[tabindex],button,a')) {
        if (scanVisible(element, cache)) items.add(element);
      }
      // Pointer-only items are recognized only inside an evidenced popup.
      for (const element of elementMethod(root, 'querySelectorAll', 'div,span')) {
        if (scanVisible(element, cache) && compact(element.innerText) && getComputedStyle(element).cursor === 'pointer') items.add(element);
      }
    }
    return items;
  }

  // 自绘控件可能只有原生点击处理器或CSS指针，没有role/ARIA弹层关联。
  // 保留真实tag/role；这是候选证据，不代表已验证网站绑定了业务动作。
  function customControlCandidates(primary, cache) {
    const primarySet = new Set(primary), signals = new Map();
    for (const element of document.querySelectorAll('td,th,li,div,span,label,[onclick]')) {
      const handler = elementMethod(element, 'hasAttribute', 'onclick') || typeof element.onclick === 'function';
      const pointer = getComputedStyle(element).cursor === 'pointer';
      if ((!handler && !pointer) || !scanVisible(element, cache)) continue;
      const text = String(element.innerText || '').replace(/\s+/g, ' ').trim();
      const name = nameOf(element);
      if ((!name && !handler) || text.length > 500) continue;
      signals.set(element, { name, rank: independentAction(element) ? 4 : ['td', 'th', 'li', 'label'].includes(element.tagName.toLowerCase()) ? 2 : 1 });
    }
    const wrappers = new Set(), descendantActions = new Set();
    for (const element of new Set([...primary, ...signals.keys()])) {
      if (!scanVisible(element, cache)) continue;
      const name = nameOf(element);
      for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
        const signal = signals.get(parent);
        if (!signal) continue;
        if (signal.name !== name) wrappers.add(parent);
        if (primarySet.has(element) && independentAction(element)) descendantActions.add(parent);
      }
    }
    const kept = new Set();
    for (const [element, signal] of signals) {
      // 既有语义控件维持原集合；不新增包含多项操作的外层布局。
      if (primarySet.has(element)) continue;
      if (independentAction(element)) { kept.add(element); continue; }
      if (wrappers.has(element) || descendantActions.has(element)) continue;
      let duplicate = false;
      for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
        if (primarySet.has(parent) && independentAction(parent)) { duplicate = true; break; }
        const owner = signals.get(parent);
        if (owner && !wrappers.has(parent) && !descendantActions.has(parent) && owner.name === signal.name && owner.rank >= signal.rank) {
          duplicate = true; break;
        }
      }
      if (!duplicate) kept.add(element);
    }
    // 当内层有更明确的独立处理器时，让它替代仅继承pointer的同名包装。
    for (const element of [...kept]) {
      for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
        if (kept.has(parent) && !independentAction(parent) && signals.get(parent).name === signals.get(element).name && signals.get(parent).rank < signals.get(element).rank) kept.delete(parent);
      }
    }
    return kept;
  }

  function candidateSet(cache = scanCache()) {
    const roots = popupRoots(cache), rootSet = new Set(roots), popup = popupItems(roots, cache);
    const primary = [...document.querySelectorAll(SELECTOR)], primarySet = new Set(primary);
    const custom = customControlCandidates(primary, cache);
    const candidates = [...new Set([...primary, ...popup, ...custom])];
    // Merge only nested representations of one action, never same-name siblings.
    // Native controls and explicit independent handlers always remain separate targets.
    const nested = new Map();
    for (const element of candidates) {
      if (!popup.has(element)) continue;
      for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
        if (!nested.has(parent)) nested.set(parent, []);
        nested.get(parent).push(element);
        if (rootSet.has(parent)) break;
      }
    }
    const kept = candidates.filter(element => {
      if (!popup.has(element) || independentAction(element)) return true;
      if ((nested.get(element) || []).some(child => scanVisible(child, cache) &&
          (independentAction(child) || elementMethod(child, 'getAttribute', 'role')?.startsWith('menuitem') ||
           (!elementMethod(element, 'getAttribute', 'role')?.startsWith('menuitem') && nameOf(child) === nameOf(element))))) return false;
      for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
        if (popup.has(parent) && (independentAction(parent) || elementMethod(parent, 'getAttribute', 'role')?.startsWith('menuitem'))) return false;
        if (rootSet.has(parent)) break;
      }
      return true;
    });
    // The selector and pointer-item lists can overlap; restore actual document order.
    if (kept.some(element => !primarySet.has(element))) {
      kept.sort((a, b) => typeof a.compareDocumentPosition === 'function' ?
        (a.compareDocumentPosition(b) & 2 ? 1 : a.compareDocumentPosition(b) & 4 ? -1 : 0) : 0);
    }
    return { candidates: kept, popup, roots, custom };
  }

  function interactiveCandidates() {
    return candidateSet().candidates;
  }

  function compact(value, limit = 500) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
  }

  function nameOf(element) {
    const labelledBy = elementMethod(element, 'getAttribute', 'aria-labelledby');
    const labelledText = labelledBy ? labelledBy.split(/\s+/).map((id) => {
      return document.getElementById(id)?.textContent || '';
    }).join(' ') : '';
    const labels = element.labels ? Array.from(element.labels).map((label) => label.innerText).join(' ') : '';
    // Region/menu names come from author labels, not every descendant's changing text.
    const contents = ['main', 'navigation', 'menu', 'menubar', 'listbox', 'dialog', 'region', 'list'].includes(roleOf(element)) ? '' : element.innerText;
    return compact(elementMethod(element, 'getAttribute', 'aria-label') || labelledText || labels ||
      elementMethod(element, 'getAttribute', 'alt') || contents || elementMethod(element, 'getAttribute', 'placeholder') ||
      elementMethod(element, 'getAttribute', 'title') ||
      (element instanceof HTMLInputElement && ['button', 'submit', 'reset'].includes(element.type) ? element.value : ''));
  }

  function roleOf(element) {
    const explicit = elementMethod(element, 'getAttribute', 'role');
    if (explicit) return explicit;
    const tag = element.tagName.toLowerCase();
    if (tag === 'a') return elementMethod(element, 'hasAttribute', 'href') ? 'link' : 'generic';
    if (tag === 'button') return 'button';
    if (tag === 'main' || tag === 'dialog') return tag;
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

  function describe(element, cache) {
    if (cache?.descriptors.has(element)) return cache.descriptors.get(element);
    const name = nameOf(element);
    let context = name;
    const region = ['main', 'navigation', 'menu', 'menubar', 'listbox', 'dialog', 'region', 'list'].includes(roleOf(element));
    // Cache ancestor summaries for this synchronous scan, never across DOM changes.
    for (let node = region ? null : element.parentElement, depth = 0; node && node !== document.body && depth < 12; node = node.parentElement, depth++) {
      let summary = cache?.ancestors.get(node);
      if (!summary) {
        const text = compact(node.innerText, 1601);
        const row = elementMethod(node, 'matches', 'article,li,tr,[role="row"],[role="listitem"],[role="dialog"],[aria-modal="true"]');
        summary = { text, row, buttons: text.length <= 1600 && !row ?
          [...elementMethod(node, 'querySelectorAll', 'button,[role="button"]')].filter(button => scanVisible(button, cache)) : [] };
        cache?.ancestors.set(node, summary);
      }
      if (summary.text.length > 1600) break;
      // Do not borrow another row's business identity through a shared list container.
      if (!summary.row && summary.buttons.some(button => button !== element && !elementMethod(button, 'contains', element) && !elementMethod(element, 'contains', button))) break;
      if (summary.text.length > context.length) context = summary.text;
      if (summary.row) break;
    }
    const title = compact(elementMethod(element, 'getAttribute', 'title'));
    if (title && !context.includes(title)) context = compact(context + ' ' + title, 1600);
    const descriptor = { name, role: roleOf(element), tag: element.tagName.toLowerCase(), context,
      href: elementMethod(element, 'getAttribute', 'href'), expanded: elementMethod(element, 'getAttribute', 'aria-expanded') };
    cache?.descriptors.set(element, descriptor);
    return descriptor;
  }

  // Action-defining state stays private: never include input values (especially passwords).
  const formIdentities = new WeakMap();
  let nextFormIdentity = 0;
  function identity(descriptor, element) {
    const form = element.form;
    if (form && !formIdentities.has(form)) formIdentities.set(form, ++nextFormIdentity);
    return JSON.stringify([descriptor.name, descriptor.role, descriptor.tag, descriptor.context, descriptor.href,
      element.type, element.multiple, element.isContentEditable,
      ['name', 'form', 'formaction', 'formmethod', 'formenctype', 'formtarget', 'formnovalidate',
        'aria-controls', 'aria-owns', 'aria-haspopup', 'draggable', 'ondrop'].map(name => elementMethod(element, 'getAttribute', name)),
      form ? [formIdentities.get(form), ...['action', 'method', 'enctype', 'target', 'noValidate'].map(name => {
        const value = form[name];
        // Named form controls can shadow these properties; never serialize those nodes.
        return [elementMethod(form, 'getAttribute', name.toLowerCase()), typeof value === 'string' || typeof value === 'boolean' ? value : null];
      })] : null]);
  }

  const refDocumentCurrent = () => location.href === refUrl && document.documentElement === refDocument;

  function resolve(ref) {
    if (!refDocumentCurrent() || typeof ref !== 'string' || !refs.has(ref)) throw Object.assign(new Error('ref 无效或已过期，请重新 snapshot'), { code: 'STALE_REF' });
    const record = refs.get(ref);
    const element = record.element;
    if (!visible(element)) throw Object.assign(new Error('目标已移除或不可见，请重新 snapshot'), { code: 'ELEMENT_NOT_VISIBLE' });
    if (identity(describe(element), element) !== record.identity) throw Object.assign(new Error('目标身份已变化（列表可能重排或复用节点），已阻止操作，请重新 snapshot'), { code: 'TARGET_CHANGED' });
    if (elementMethod(element, 'matches', ':disabled') || elementMethod(element, 'closest', '[inert], [aria-disabled="true"]')) {
      throw Object.assign(new Error('目标不可交互'), { code: 'ELEMENT_DISABLED' });
    }
    return element;
  }

  async function prepare(target) {
    const { ref, expectedContext, action, position } = typeof target === 'string' ? { ref: target } : target;
    const element = resolve(ref);
    if (action && refs.get(ref).ambiguous && !expectedContext) throw Object.assign(new Error('同名目标存在多个，请传 expectedContext 核对业务身份，不能只按序号操作'), { code: 'AMBIGUOUS_TARGET' });
    if (expectedContext && !describe(element).context.includes(expectedContext)) throw Object.assign(new Error('目标上下文与 expectedContext 不符，已阻止操作，请重新 snapshot'), { code: 'TARGET_CHANGED' });
    const before = elementMethod(element, 'getClientRects', )[0];
    // 已在视口内的目标不滚动，避免每次动作把目标挪到同一屏幕坐标。
    const outside = before && (before.top < 0 || before.left < 0 || before.bottom > innerHeight || before.right > innerWidth);
    const smooth = outside && document.visibilityState === 'visible' && !matchMedia('(prefers-reduced-motion: reduce)').matches;
    element.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: smooth ? 'smooth' : 'instant' });
    if (smooth) {
      await new Promise(done => {
        let frame, timer, last = before, stable = 0;
        const finish = () => { cancelAnimationFrame(frame); clearTimeout(timer); done(); };
        const step = () => {
          const rect = elementMethod(element, 'getClientRects', )[0];
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
    const after = elementMethod(element, 'getClientRects', )[0];
    if (before && after && (before.top !== after.top || before.left !== after.left)) {
      // 仅实际发生滚动时等待布局稳定，后台不依赖 rAF。
      await new Promise((resolveLayout) => setTimeout(resolveLayout, 50));
    }
    resolve(ref);
    const rects = Array.from(elementMethod(element, 'getClientRects', ));
    const rect = rects.find((item) => item.width > 0 && item.height > 0 &&
      item.bottom > 0 && item.right > 0 && item.top < innerHeight && item.left < innerWidth);
    if (!rect) throw Object.assign(new Error('目标不在可操作的视口内'), { code: 'TARGET_OUTSIDE_VIEWPORT' });
    const left = Math.max(0, rect.left);
    const right = Math.min(innerWidth, rect.right);
    const top = Math.max(0, rect.top);
    const bottom = Math.min(innerHeight, rect.bottom);
    const x = Math.min(right - .5, Math.max(left + .5, rect.left + rect.width * (position?.x ?? .5)));
    const y = Math.min(bottom - .5, Math.max(top + .5, rect.top + rect.height * (position?.y ?? .5)));
    const hit = document.elementFromPoint(x, y);
    if (!hit || (hit !== element && !elementMethod(element, 'contains', hit))) throw Object.assign(new Error('目标中心被其他元素遮挡'), { code: 'ELEMENT_OBSCURED' });
    return { x, y, target: describe(element) };
  }

  async function focusTarget(ref) {
    await prepare(ref);
    const element = resolve(ref);
    element.focus({ preventScroll: true });
    if (document.activeElement !== element && !elementMethod(element, 'contains', document.activeElement)) {
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
    if (element.readOnly || elementMethod(element, 'getAttribute', 'aria-readonly') === 'true') throw new Error('目标为只读');
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
    snapshotCache = null;
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
        const cache = scanCache();
        for (const element of document.querySelectorAll(SELECTOR)) {
          const rect = elementMethod(element, 'getClientRects', )[0];
          if (!rect || rect.bottom <= 0 || rect.top >= innerHeight || !scanVisible(element, cache)) continue;
          const item = describe(element, cache), key = identity(item, element);
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

  function snapshotError(code, message) {
    return Object.assign(new Error(message), { code });
  }

  function snapshotQuery(options) {
    const scope = options.scope ?? 'all', limit = options.limit ?? 150;
    if (!['all', 'main', 'dialog', 'viewport'].includes(scope)) throw snapshotError('INVALID_PARAMS', 'scope 必须为 all、main、dialog 或 viewport');
    if (!Number.isInteger(limit) || limit < 1 || limit > 150) throw snapshotError('INVALID_PARAMS', 'limit 必须为 1..150 的整数');
    if (options.scopeRef !== undefined && options.scope !== undefined) throw snapshotError('INVALID_PARAMS', 'scopeRef 与 scope 互斥');
    for (const key of ['name', 'role', 'context', 'scopeRef']) {
      if (options[key] !== undefined && typeof options[key] !== 'string') throw snapshotError('INVALID_PARAMS', key + ' 必须为字符串');
    }
    if (options.exact !== undefined && typeof options.exact !== 'boolean') throw snapshotError('INVALID_PARAMS', 'exact 必须为布尔值');
    // Resolve the old ref before the fresh snapshot expires the previous generation.
    const container = options.scopeRef !== undefined ? resolve(options.scopeRef) : null;
    return { scope, limit, name: options.name, role: options.role, context: options.context,
      exact: options.exact ?? false, container, containerIdentity: container ? identity(describe(container), container) : null };
  }

  function scopeRoots(query, cache) {
    if (query.container) return scanVisible(query.container, cache) ? [query.container] : [];
    const selector = query.scope === 'main' ? 'main,[role="main"]' :
      query.scope === 'dialog' ? 'dialog,[role="dialog"],[aria-modal="true"]' : null;
    if (!selector) return [];
    const roots = [...document.querySelectorAll(selector)].filter(root => scanVisible(root, cache)), rootSet = new Set(roots);
    return roots.filter(root => {
      for (let parent = root.parentElement; parent; parent = parent.parentElement) if (rootSet.has(parent)) return false;
      return true;
    });
  }

  function scanSnapshot(query) {
    const cache = scanCache(), collected = candidateSet(cache), regions = scopeRoots(query, cache);
    const records = [], buttonCounts = new Map(), customCounts = new Map(), regionSet = new Set(regions), membership = new WeakMap();
    const limitedRegion = query.container || ['main', 'dialog'].includes(query.scope);
    const inRegion = element => {
      const path = []; let node = element;
      while (node && !regionSet.has(node) && !membership.has(node)) { path.push(node); node = node.parentElement; }
      const found = Boolean(node && (regionSet.has(node) || membership.get(node)));
      for (const visited of path) membership.set(visited, found);
      return found;
    };
    for (const [domIndex, element] of collected.candidates.entries()) {
      if (!scanVisible(element, cache)) continue;
      const descriptor = describe(element, cache);
      if (descriptor.role === 'button' && descriptor.name) buttonCounts.set(descriptor.name, (buttonCounts.get(descriptor.name) || 0) + 1);
      const candidateKind = ['td', 'th'].includes(descriptor.tag) ? 'native-cell' : collected.custom.has(element) ? 'custom-control' : 'semantic';
      if ((candidateKind !== 'semantic' || descriptor.role === 'generic') && descriptor.name) {
        const key = descriptor.role + ':' + descriptor.name;
        customCounts.set(key, (customCounts.get(key) || 0) + 1);
      }
      if (limitedRegion && !inRegion(element)) continue;
      const viewport = inViewport(element);
      if (query.scope === 'viewport' && !viewport) continue;
      if (query.name !== undefined && !(query.exact ? descriptor.name === query.name : descriptor.name.includes(query.name))) continue;
      if (query.role !== undefined && descriptor.role !== query.role) continue;
      if (query.context !== undefined && !descriptor.context.includes(query.context)) continue;
      records.push({ element, descriptor: { ...descriptor, candidateKind }, identity: identity(descriptor, element), domIndex,
        inViewport: viewport, inPopup: collected.popup.has(element) });
    }
    for (const record of records) record.ambiguous = (record.descriptor.role === 'button' && (buttonCounts.get(record.descriptor.name) || 0) > 1) ||
      ((record.descriptor.candidateKind !== 'semantic' || record.descriptor.role === 'generic') && (customCounts.get(record.descriptor.role + ':' + record.descriptor.name) || 0) > 1);
    return { records, regions, candidateCount: collected.candidates.length,
      popupCount: records.filter(record => record.inPopup).length, cache };
  }

  function snapshotText(query, regions, iframes) {
    let text = '';
    const limitedRegion = query.container || ['main', 'dialog'].includes(query.scope);
    if (limitedRegion) text = regions.map(root => root.innerText || '').join('\n');
    else if (query.scope === 'viewport') {
      // Read the text's own rectangles, not a large ancestor that straddles the viewport.
      if (document.body && document.createTreeWalker && document.createRange) {
        const walker = document.createTreeWalker(document.body, 4), range = document.createRange();
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (!node.textContent?.trim() || !node.parentElement || !visible(node.parentElement)) continue;
          range.selectNodeContents(node);
          if (inViewport(range)) text += node.textContent + '\n';
        }
      }
    } else text = document.body?.innerText || '';
    // Preserve existing same-origin frame text coverage; cross-origin frames remain isolated.
    for (const frame of iframes) {
      if (limitedRegion && !regions.some(root => elementMethod(root, 'contains', frame))) continue;
      if (query.scope === 'viewport' && (!visible(frame) || !inViewport(frame))) continue;
      try {
        const inner = frame.contentDocument?.body?.innerText || '';
        if (inner.trim()) text += '\n[iframe]\n' + inner;
      } catch { /* cross-origin iframe */ }
    }
    return text;
  }

  function snapshotPage(cache, offset) {
    const records = cache.ordered.slice(offset, offset + cache.query.limit);
    // Selection honors popup/viewport priority; each batch retains readable DOM order.
    const elements = [...records].sort((a, b) => a.domIndex - b.domIndex).map(record => {
      const { element, descriptor } = record;
      refs.set(record.ref, { element, identity: record.identity, ambiguous: record.ambiguous });
      const item = { ref: record.ref, ...descriptor, expanded: elementMethod(element, 'getAttribute', 'aria-expanded'), requiresExpectedContext: record.ambiguous,
        inViewport: inViewport(element), inPopup: record.inPopup, ...elementState(element) };
      // Password contents never enter the snapshot or pagination cache.
      if (element instanceof HTMLInputElement && element.type !== 'password') item.value = element.value.slice(0, 2000);
      else if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) item.value = element.value.slice(0, 2000);
      else if (element.isContentEditable) item.value = (element.innerText || '').slice(0, 2000);
      return item;
    });
    const total = cache.ordered.length, next = offset + records.length, hasMore = next < total;
    const nextCursor = hasMore ? cache.cursorBase + '.' + next : null;
    if (nextCursor) cache.cursors.set(nextCursor, next);
    return { ...cache.base, elements,
      pagination: { snapshotId: cache.snapshotId, offset, limit: cache.query.limit, total, hasMore, nextCursor } };
  }

  function continueSnapshot(options) {
    for (const key of Object.keys(options)) {
      if (!['tabId', 'cursor', 'format', 'load'].includes(key)) throw snapshotError('INVALID_PARAMS', '续页只能携带 tabId、cursor、format，以及可选 load=current');
    }
    if (options.load !== undefined && options.load !== 'current') throw snapshotError('INVALID_PARAMS', 'cursor 续页不执行加载探测，load 只能为 current');
    const cache = snapshotCache;
    if (!cache || typeof options.cursor !== 'string' || !cache.cursors.has(options.cursor) || !refDocumentCurrent()) {
      if (!refDocumentCurrent()) { snapshotCache = null; refs = new Map(); }
      throw snapshotError('STALE_CURSOR', 'cursor 无效或已过期，请重新 snapshot');
    }
    const current = scanSnapshot(cache.query);
    const changed = cache.query.container && (!visible(cache.query.container) || identity(describe(cache.query.container), cache.query.container) !== cache.query.containerIdentity) ||
      current.records.length !== cache.records.length || current.records.some((record, index) => {
        const previous = cache.records[index];
        return record.element !== previous.element || record.identity !== previous.identity || record.inPopup !== previous.inPopup || record.ambiguous !== previous.ambiguous;
      });
    if (changed) {
      snapshotCache = null;
      refs = new Map();
      throw snapshotError('SNAPSHOT_CHANGED', '本轮匹配候选的顺序、身份或可见性已变化；已停止分页，请重新 snapshot');
    }
    // Do not refresh generation, probe loading, or expire refs returned on previous pages.
    return snapshotPage(cache, cache.cursors.get(options.cursor));
  }

  async function snapshot(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw snapshotError('INVALID_PARAMS', 'snapshot 参数必须为对象');
    if (options.format !== undefined && !['full', 'compact'].includes(options.format)) throw snapshotError('INVALID_PARAMS', 'format 必须为 full 或 compact');
    if (options.cursor !== undefined) return continueSnapshot(options);
    const load = options.load ?? 'auto';
    if (!['auto', 'current'].includes(load)) throw snapshotError('INVALID_PARAMS', 'load 必须为 auto 或 current');
    const query = snapshotQuery(options), request = ++snapshotRequest;
    generation = Math.max(generation + 100, Date.now() * 100 + 10);
    refs = new Map();
    snapshotCache = null;
    refUrl = location.href;
    refDocument = document.documentElement;
    const loading = load === 'auto' ? await explore() : { attempted: false, complete: false, stopReason: 'current-only' };
    if (request !== snapshotRequest || !refDocumentCurrent()) throw snapshotError('SNAPSHOT_CHANGED', '快照探测期间页面或快照代际已变化，请重新 snapshot');
    if (query.container && (!visible(query.container) || identity(describe(query.container), query.container) !== query.containerIdentity)) throw snapshotError('SNAPSHOT_CHANGED', 'scopeRef 容器在探测期间已变化，请重新 snapshot');
    const scanned = scanSnapshot(query), iframes = [...document.querySelectorAll('iframe')];
    const text = snapshotText(query, scanned.regions, iframes), snapshotId = 'r' + generation;
    // Store one complete latest matching set; no hidden candidate budget drops later pages.
    const records = scanned.records;
    records.forEach((record, index) => { record.ref = snapshotId + '-' + (index + 1); });
    const ordered = [...records].sort((a, b) => Number(b.inPopup) - Number(a.inPopup) || Number(b.inViewport) - Number(a.inViewport));
    const requestedScope = query.container ? 'ref' : query.scope;
    const scopeFound = !query.container && ['all', 'viewport'].includes(query.scope) || scanned.regions.length > 0;
    snapshotCache = { query, snapshotId, records, ordered, cursors: new Map(),
      cursorBase: snapshotId + '.' + Math.random().toString(36).slice(2),
      base: { title: document.title, url: location.href, text: text.slice(0, 12000), textLength: text.length,
        frames: iframes.length, loading,
        coverage: { scope: 'loaded-dom', requestedScope, scopeFound,
          scopeNote: scopeFound ? '仅当前已加载 DOM；匹配总数不代表业务全量。' : '未找到可见的 ' + requestedScope + ' 区域；没有回退到整页。',
          selectionPriority: scanned.popupCount ? 'popup-then-viewport' : 'viewport-first',
          dataCompleteness: 'unknown', documentReadyState: document.readyState || 'unknown',
          textTruncated: text.length > 12000, elementScanLimited: false,
          candidateCount: scanned.candidateCount, scannedCandidates: scanned.candidateCount,
          matchedCandidateCount: records.length, limits: { textCharacters: 12000, elements: query.limit } } } };
    return snapshotPage(snapshotCache, 0);
  }

  function elementState(element) {
    return {
      disabled: Boolean(elementMethod(element, 'matches', ':disabled') || elementMethod(element, 'closest', '[inert],[aria-disabled="true"]')),
      focused: document.activeElement === element,
      checked: element instanceof HTMLInputElement && ['checkbox', 'radio'].includes(element.type) ? element.checked : elementMethod(element, 'getAttribute', 'aria-checked'),
      selected: elementMethod(element, 'getAttribute', 'aria-selected'),
      hasPopup: elementMethod(element, 'getAttribute', 'aria-haspopup'), controls: elementMethod(element, 'getAttribute', 'aria-controls'),
      busy: elementMethod(element, 'getAttribute', 'aria-busy') === 'true',
      editable: Boolean(element.isContentEditable || elementMethod(element, 'matches', 'input:not([readonly]),textarea:not([readonly])'))
    };
  }

  function inspectStyle(element) {
    const style = getComputedStyle(element);
    return { display: style.display, visibility: style.visibility, opacity: style.opacity,
      pointerEvents: style.pointerEvents, position: style.position, zIndex: style.zIndex, cursor: style.cursor, filter: style.filter };
  }

  function inspectNode(element) {
    return { tag: element.tagName.toLowerCase(), role: roleOf(element), name: nameOf(element),
      id: compact(elementMethod(element, 'getAttribute', 'id'), 160), className: compact(elementMethod(element, 'getAttribute', 'class'), 200), style: inspectStyle(element) };
  }

  function inspect(ref) {
    syncHoverHold();
    const record = refs.get(ref);
    if (!refDocumentCurrent() || !record) throw snapshotError('STALE_REF', 'ref无效或已过期，请重新snapshot');
    const element = record.element;
    if (!element.isConnected) return { removed: true, visible: false };
    const descriptor = describe(element), rect = elementMethod(element, 'getClientRects', )[0];
    const x = rect && (Math.max(0, rect.left) + Math.min(innerWidth, rect.right)) / 2;
    const y = rect && (Math.max(0, rect.top) + Math.min(innerHeight, rect.bottom)) / 2;
    const hitTestable = Boolean(rect && rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight);
    const hit = hitTestable ? document.elementFromPoint(x, y) : null;
    const state = { ...descriptor, ...elementState(element), visible: visible(element),
      identityChanged: identity(descriptor, element) !== record.identity,
      obscured: Boolean(hit && hit !== element && !elementMethod(element, 'contains', hit)),
      inViewport: Boolean(rect && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth) };
    state.hitTest = { status: !hitTestable ? 'outside-viewport' : !hit ? 'no-hit' : 'tested', ...(hitTestable ? { x, y } : {}) };
    state.style = inspectStyle(element);
    state.hitTarget = hit ? inspectNode(hit) : null;
    state.ancestors = [];
    for (let node = element.parentElement; node && state.ancestors.length < 6; node = node.parentElement) state.ancestors.push(inspectNode(node));
    if (globalThis.__aiBrowserCursor2) state.cursor = globalThis.__aiBrowserCursor2.state();
    if (element instanceof HTMLInputElement) state.inputType = element.type;
    if (elementMethod(element, 'hasAttribute', 'aria-controls') || elementMethod(element, 'hasAttribute', 'aria-owns')) {
      const roots = `${elementMethod(element, 'getAttribute', 'aria-controls') || ''} ${elementMethod(element, 'getAttribute', 'aria-owns') || ''}`.split(/\s+/).filter(Boolean)
        .map(id => document.getElementById(id)).filter(Boolean);
      const collected = candidateSet();
      state.popups = roots.filter(root => collected.roots.includes(root)).map(root => ({ id: root.id, visible: visible(root),
        itemCount: collected.candidates.filter(item => collected.popup.has(item) && elementMethod(root, 'contains', item)).length }));
    }
    if (rect) state.rect = { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
    if (element instanceof HTMLSelectElement) {
      state.options = [...element.options].slice(0, 100).map(o => ({ value: o.value, label: o.label, disabled: o.disabled, selected: o.selected }));
      state.optionsTruncated = element.options.length > 100;
      state.selectedValues = [...element.selectedOptions].map(o => o.value);
      state.multiple = element.multiple;
    }
    return state;
  }

  let hovered = null;
  let pointerPosition = null;
  let hoverOwner = null;
  let hoverObserver = null;
  let hoverSyncPending = false;

  function hoverPopups(owner) {
    const roots = new Set();
    for (const id of `${elementMethod(owner, 'getAttribute', 'aria-controls') || ''} ${elementMethod(owner, 'getAttribute', 'aria-owns') || ''}`.split(/\s+/).filter(Boolean)) {
      const root = document.getElementById(id);
      if (root) roots.add(root);
    }
    // 没有controls的内联菜单，只查触发器附近，不把全页其他菜单关联进来。
    for (let node = owner.parentElement, depth = 0; node && node !== document.body && depth < 3; node = node.parentElement, depth++) {
      for (const root of elementMethod(node, 'querySelectorAll', '[role="menu"],[role="listbox"]')) roots.add(root);
      if (roots.size) break;
    }
    return [...roots];
  }

  function syncHoverHold() {
    hoverObserver?.disconnect();
    if (!hoverOwner?.isConnected) {
      hoverOwner = null;
      globalThis.__aiBrowserCursor2?.hold(false);
      return;
    }
    const roots = hoverPopups(hoverOwner);
    globalThis.__aiBrowserCursor2?.hold(roots.some(visible));
    if (typeof MutationObserver !== 'function') return;
    hoverObserver ??= new MutationObserver(queueHoverSync);
    const nodes = new Set();
    for (const start of [hoverOwner, ...roots]) {
      for (let node = start; node; node = node.parentElement) nodes.add(node);
    }
    for (const node of nodes) hoverObserver.observe(node, { attributes: true, attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'aria-expanded'], childList: true });
  }

  function queueHoverSync() {
    if (!hoverOwner || hoverSyncPending) return;
    hoverSyncPending = true;
    setTimeout(() => { hoverSyncPending = false; syncHoverHold(); }, 0);
  }

  function holdHover({ ref }) {
    const element = refs.get(ref)?.element;
    if (!element?.isConnected) { clearHover(); return { held: false }; }
    const owner = elementMethod(element, 'closest', '[aria-haspopup]:not([aria-haspopup="false"])');
    const within = hoverOwner && (elementMethod(hoverOwner, 'contains', element) || hoverPopups(hoverOwner).some(root => elementMethod(root, 'contains', element)));
    if (!within) hoverOwner = null;
    if (owner) hoverOwner = owner;
    syncHoverHold();
    return { held: Boolean(globalThis.__aiBrowserCursor2?.state().held) };
  }

  async function showCursor(point) {
    await globalThis.__aiBrowserCursor2.show({ ...point, from: pointerPosition, linear: Boolean(hoverOwner) });
    pointerPosition = { x: point.x, y: point.y };
    return { shown: true };
  }

  function clearHover() {
    hoverOwner = null;
    hoverObserver?.disconnect();
    globalThis.__aiBrowserCursor2?.hold(false);
  }

  // CSS hover可随真实指针变化，不一定产生DOM属性变化；只在进入/离开事件后核对。
  document.addEventListener('pointerover', queueHoverSync, true);
  document.addEventListener('pointerout', queueHoverSync, true);
  const hoverTransition = event => {
    if (hoverOwner && (elementMethod(event.target, 'contains', hoverOwner) || hoverPopups(hoverOwner).some(root =>
      elementMethod(root, 'contains', event.target) || elementMethod(event.target, 'contains', root)))) queueHoverSync();
  };
  document.addEventListener('transitionend', hoverTransition, true);
  document.addEventListener('animationend', hoverTransition, true);
  function mouse(element, type, point, extra = {}) {
    const init = { clientX: point.x, clientY: point.y, bubbles: !/enter|leave/.test(type),
      cancelable: true, composed: true, view: window, ...extra };
    const event = type.startsWith('pointer') ? new PointerEvent(type, { pointerId: 1, pointerType: 'mouse', isPrimary: true, ...init }) : new MouseEvent(type, init);
    return element.dispatchEvent(event);
  }

  function hoverAt(element, point) {
    const previous = hovered?.isConnected ? hovered : null;
    if (previous !== element) {
      const path = node => { const chain = []; for (; node instanceof Element; node = node.parentElement) chain.push(node); return chain; };
      const oldPath = path(previous), newPath = path(element);
      if (previous) {
        mouse(previous, 'pointerout', point, { relatedTarget: element });
        mouse(previous, 'mouseout', point, { relatedTarget: element });
        for (const node of oldPath.filter(n => !newPath.includes(n))) {
          mouse(node, 'pointerleave', point, { relatedTarget: element }); mouse(node, 'mouseleave', point, { relatedTarget: element });
        }
      }
      mouse(element, 'pointerover', point, { relatedTarget: previous }); mouse(element, 'mouseover', point, { relatedTarget: previous });
      for (const node of newPath.filter(n => !oldPath.includes(n)).reverse()) {
        mouse(node, 'pointerenter', point, { relatedTarget: previous }); mouse(node, 'mouseenter', point, { relatedTarget: previous });
      }
      hovered = element;
    }
    mouse(element, 'pointermove', point); mouse(element, 'mousemove', point);
  }

  function pointerTarget(ref, point) {
    const element = resolve(ref), hit = document.elementFromPoint(point.x, point.y);
    if (!hit || (hit !== element && !elementMethod(element, 'contains', hit))) throw new Error('目标被遮挡或已移动，请重新snapshot');
    return hit;
  }

  async function domHover({ ref, point }) {
    const element = resolve(ref), before = elementMethod(element, 'getClientRects', )[0];
    hoverAt(pointerTarget(ref, point), point);
    const after = elementMethod(element, 'getClientRects', )[0];
    // 悬停事件可能关闭旧菜单并重排页面；视觉位置跟随同一个元素，不停在旧坐标的空白处。
    const aligned = before?.width > 0 && before?.height > 0 && after?.width > 0 && after?.height > 0 ? {
      x: after.left + after.width * (point.x - before.left) / before.width,
      y: after.top + after.height * (point.y - before.top) / before.height
    } : { x: point.x, y: point.y };
    await globalThis.__aiBrowserCursor2?.show({ ...aligned, animate: false });
    pointerPosition = aligned;
    holdHover({ ref });
    return { actionDispatched: true, mode: 'dom', trusted: false, cssHover: false, position: aligned };
  }

  async function pointerClick({ ref, point, button = 'left', clickCount = 1, holdMs = 0 }) {
    const element = pointerTarget(ref, point), right = button === 'right';
    if (hovered) hoverAt(element, point);
    pointerPosition = { x: point.x, y: point.y };
    holdHover({ ref });
    const data = { button: right ? 2 : 0, buttons: right ? 2 : 1 };
    const checkTarget = () => {
      const hit = pointerTarget(ref, point);
      if (!element.isConnected || (hit !== element && !elementMethod(element, 'contains', hit))) {
        throw Object.assign(new Error('按下期间命中目标已变化，请重新 snapshot'), { code: 'TARGET_CHANGED' });
      }
    };
    // 处理器或长按等待可能复用节点；释放始终完成，业务事件必须重新核验。
    for (let count = 1; count <= clickCount; count++) {
      checkTarget();
      try {
        mouse(element, 'pointerdown', point, data);
        checkTarget();
        mouse(element, 'mousedown', point, { ...data, detail: count });
        checkTarget();
        if (holdMs) await new Promise(done => setTimeout(done, holdMs));
      } finally {
        mouse(element, 'pointerup', point, { ...data, buttons: 0 }); mouse(element, 'mouseup', point, { ...data, buttons: 0, detail: count });
      }
      checkTarget();
      if (right) mouse(element, 'contextmenu', point, { button: 2, detail: count });
      else if (!holdMs) mouse(element, 'click', point, { detail: count });
    }
    if (!right && clickCount === 2) {
      checkTarget();
      mouse(element, 'dblclick', point, { detail: 2 });
    }
    return { clicked: !holdMs, actionDispatched: true, mode: 'dom', trusted: false };
  }

  async function domDrag({ fromRef, toRef, from, to, durationMs = 400 }) {
    const source = pointerTarget(fromRef, from), target = pointerTarget(toRef, to);
    const transfer = new DataTransfer();
    const dragEvent = (element, type, point) => element.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: point.x, clientY: point.y }));
    const html5 = elementMethod(source, 'closest', '[draggable="true"]');
    const checkTargets = () => {
      const sourceRoot = resolve(fromRef), targetRoot = resolve(toRef);
      if (!source.isConnected || !elementMethod(sourceRoot, 'contains', source) || !target.isConnected || !elementMethod(targetRoot, 'contains', target)) {
        throw snapshotError('TARGET_CHANGED', '拖动期间原始命中目标已变化，请重新 snapshot');
      }
    };
    const checkDropTarget = () => {
      checkTargets();
      const hit = pointerTarget(toRef, to);
      if (hit !== target && !elementMethod(target, 'contains', hit)) throw snapshotError('TARGET_CHANGED', '拖动期间放置目标已变化，请重新 snapshot');
    };
    let dropped = false;
    try {
      mouse(source, 'pointerdown', from, { buttons: 1 });
      checkTargets();
      mouse(source, 'mousedown', from, { buttons: 1 });
      checkTargets();
      if (html5 && !dragEvent(html5, 'dragstart', from)) return { actionDispatched: true, canceled: true, mode: 'dom', trusted: false };
      checkTargets();
      for (let i = 1; i <= 12; i++) {
        await new Promise(done => setTimeout(done, durationMs / 12));
        checkTargets();
        const point = { x: from.x + (to.x - from.x) * i / 12, y: from.y + (to.y - from.y) * i / 12 };
        const hit = document.elementFromPoint(point.x, point.y) || source;
        mouse(hit, 'pointermove', point, { buttons: 1 });
        checkTargets();
        mouse(hit, 'mousemove', point, { buttons: 1 });
        checkTargets();
        if (html5) dragEvent(html5, 'drag', point);
        checkTargets();
      }
      checkDropTarget();
      if (html5) {
        dragEvent(target, 'dragenter', to);
        checkDropTarget();
        const accepted = !dragEvent(target, 'dragover', to);
        checkDropTarget();
        if (accepted) { dragEvent(target, 'drop', to); dropped = true; }
      }
      return { actionDispatched: true, mode: 'dom', trusted: false, dropDispatched: dropped };
    } finally {
      // Release the original nodes even when an event handler invalidated either ref.
      mouse(target, 'pointerup', to, { buttons: 0 }); mouse(target, 'mouseup', to, { buttons: 0 });
      if (html5) dragEvent(html5, 'dragend', to);
    }
  }

  function select({ ref, values }) {
    const element = resolve(ref);
    if (!(element instanceof HTMLSelectElement)) throw new Error('仅支持原生select；自绘下拉请用hover/click/press');
    if (!element.multiple && values.length !== 1) throw new Error('单选select只能选择一个值');
    const options = [...element.options];
    for (const value of values) {
      const option = options.find(o => o.value === value);
      if (!option || option.disabled || elementMethod(option, 'closest', 'optgroup[disabled]')) throw new Error('目标选项不存在或已禁用');
    }
    const before = [...element.selectedOptions].map(o => o.value);
    if (JSON.stringify([...before].sort()) === JSON.stringify([...values].sort())) return { selectedValues: before, changed: false, verified: true };
    for (const option of options) option.selected = values.includes(option.value);
    element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true }));
    const actual = [...element.selectedOptions].map(o => o.value);
    return { selectedValues: actual, changed: true, actionDispatched: true, verified: JSON.stringify([...actual].sort()) === JSON.stringify([...values].sort()), trusted: false, mode: 'dom' };
  }

  async function waitFor({ ref, text, name, role, state = 'visible', timeoutMs = 3000 }) {
    const started = Date.now();
    let count = 0;
    while (true) {
      let candidates;
      if (ref) {
        if (!refDocumentCurrent() || !refs.has(ref)) throw snapshotError('STALE_REF', 'ref无效或已过期，请重新snapshot');
        const record = refs.get(ref);
        if (record.element.isConnected && identity(describe(record.element), record.element) !== record.identity) throw snapshotError('TARGET_CHANGED', '等待目标身份已变化，请重新snapshot');
        candidates = [record.element];
      } else if (name || role) {
        candidates = interactiveCandidates().filter(e => (!name || nameOf(e) === name) && (!role || roleOf(e) === role) && (!text || (e.innerText || '').includes(text)));
      } else {
        const found = (document.body?.innerText || '').includes(text);
        if (!['visible', 'hidden'].includes(state)) throw new Error('文本等待只支持visible/hidden');
        candidates = found ? [document.body] : [];
      }
      const shown = candidates.filter(visible);
      count = shown.length;
      const matched = state === 'hidden' ? shown.length === 0 : shown.some(e => state === 'visible' ||
        (state === 'enabled' && !elementState(e).disabled) ||
        (state === 'expanded' && elementMethod(e, 'getAttribute', 'aria-expanded') === 'true') ||
        (state === 'collapsed' && elementMethod(e, 'getAttribute', 'aria-expanded') === 'false'));
      if (matched || Date.now() - started >= timeoutMs) return { matched, state, count, elapsedMs: Date.now() - started, timedOut: !matched };
      await new Promise(done => setTimeout(done, 100));
    }
  }

  async function domClick(ref) {
    let point = await prepare(ref);
    if (hovered?.isConnected) hoverAt(pointerTarget(ref, point), point);
    // 离开旧菜单可能改变布局；派发click前再次核对，并把视觉端点校准到当前目标。
    point = await prepare(ref);
    await globalThis.__aiBrowserCursor2?.show({ ...point, animate: false });
    pointerPosition = { x: point.x, y: point.y };
    holdHover({ ref });
    resolve(ref).click();
    syncHoverHold();
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
    const pieces = key.split('+'), base = pieces.at(-1);
    const modifiers = { altKey: pieces.includes('Alt'), ctrlKey: pieces.includes('Control'), shiftKey: pieces.includes('Shift') };
    const actual = base === 'Space' ? ' ' : base;
    const allowed = element.dispatchEvent(new KeyboardEvent('keydown', { key: actual, ...modifiers, bubbles: true, cancelable: true }));
    if (allowed && ['Tab', 'Shift+Tab'].includes(key)) {
      const targets = [...document.querySelectorAll('a[href],button,input,textarea,select,[tabindex],[contenteditable]')]
        .filter(item => visible(item) && !elementMethod(item, 'matches', ':disabled') && item.tabIndex >= 0);
      const index = targets.indexOf(element), next = modifiers.shiftKey ? (index <= 0 ? targets.length - 1 : index - 1) : (index + 1) % targets.length;
      targets[next]?.focus();
    } else if (allowed && ((key === 'Enter' && element instanceof HTMLInputElement && ['button', 'submit', 'reset', 'image'].includes(element.type)) ||
        (['Enter', 'Space'].includes(key) && elementMethod(element, 'matches', 'button,a[href],input[type=checkbox],input[type=radio]')))) {
      element.click();
    } else if (allowed && key === 'Enter' && element instanceof HTMLInputElement && IMPLICIT_SUBMIT_INPUTS.has(element.type) && element.form) {
      const form = element.form;
      // 包含form属性关联的外部按钮和不在form.elements中的image，按文档顺序保留默认submitter。
      const controls = [...document.querySelectorAll('button,input')].filter(control => control.form === form);
      const submitter = controls.find(control => (control.tagName === 'BUTTON' && control.type === 'submit') ||
        (control instanceof HTMLInputElement && ['submit', 'image'].includes(control.type)));
      if (submitter) {
        // 禁用的默认按钮阻止隐式提交；click保留取消处理器和name/value、formaction等原生语义。
        if (!elementMethod(submitter, 'matches', ':disabled')) submitter.click();
      } else if (controls.filter(control => control instanceof HTMLInputElement && IMPLICIT_SUBMIT_INPUTS.has(control.type)).length <= 1) {
        form.requestSubmit();
      }
    } else if (allowed && ['Backspace', 'Delete'].includes(key) && typeof element.setRangeText === 'function') {
      const start = element.selectionStart, end = element.selectionEnd;
      if (start !== null && !element.readOnly) {
        element.setRangeText('', start === end && key === 'Backspace' ? Math.max(0, start - 1) : start,
          start === end && key === 'Delete' ? end + 1 : end, 'end');
        element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
      }
    }
    element.dispatchEvent(new KeyboardEvent('keyup', { key: actual, ...modifiers, bubbles: true }));
    return { pressed: true, mode: 'dom', trusted: false, note: 'DOM 按键为非可信事件，网站可能忽略；不会自动启用 CDP。' };
  }

  // Edge 对注入函数抛错可能返回 result:null；这里统一捕获并把真实错误带回主世界。
  const guarded = (name, fn) => async (...a) => {
    try {
      return await fn(...a);
    } catch (error) {
      return { __zcodeError: String((error && error.message) || error), __zcodeCode: error?.code || 'PAGE_ACTION_FAILED' };
    }
  };

  const agent = {
    snapshot: guarded('snapshot', snapshot),
    scroll: guarded('scroll', scroll),
    inspect: guarded('inspect', inspect),
    prepare: guarded('prepare', prepare),
    focus: guarded('focus', focus),
    focusTarget: guarded('focusTarget', focusTarget),
    showCursor: guarded('showCursor', showCursor),
    holdHover: guarded('holdHover', holdHover),
    cursorPulse: guarded('cursorPulse', point => globalThis.__aiBrowserCursor2.click(point)),
    hideCursor: guarded('hideCursor', () => { clearHover(); globalThis.__aiBrowserCursor2?.hide(); return { hidden: true }; }),
    domClick: guarded('domClick', domClick),
    domHover: guarded('domHover', domHover),
    pointerClick: guarded('pointerClick', pointerClick),
    domDrag: guarded('domDrag', domDrag),
    select: guarded('select', select),
    waitFor: guarded('waitFor', waitFor),
    domFill: guarded('domFill', domFill),
    domPress: guarded('domPress', domPress)
  };

  Object.freeze(agent);
  Object.defineProperty(globalThis, '__aiBrowserPageAgent10', { value: agent, configurable: false, writable: false });
  if (!globalThis.__aiBrowserPageAgent9) Object.defineProperty(globalThis, '__aiBrowserPageAgent9', { value: agent, configurable: false, writable: false });
  if (!globalThis.__aiBrowserPageAgent8) Object.defineProperty(globalThis, '__aiBrowserPageAgent8', { value: agent, configurable: false, writable: false });
})();
