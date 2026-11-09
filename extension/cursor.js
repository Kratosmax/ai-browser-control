(() => {
  'use strict';
  if (globalThis.__aiBrowserCursor2) return;
  // 旧业务页热更新：停掉旧层，避免两代视觉光标重叠。
  globalThis.__aiBrowserCursor?.hide();
  document.getElementById('ai-browser-cursor')?.remove();

  // 原创光标和动效。仅移动期间运行一条帧循环，静止后停止。
  let host, shadow, pointer, halo, ring, trailLayer;
  let position = null;
  let move = null;
  let hideTimer = null;
  let hideMs = 10000;
  let trailMs = 5000;
  let held = false;
  let pulse = null;
  const trails = new Set();
  const MAX_TRAILS = 64;
  const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  function ensure() {
    if (host?.isConnected) return;
    host = document.createElement('div');
    host.id = 'ai-browser-cursor';
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;contain:layout style!important';
    shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `<style>
      :host { pointer-events:none; }
      #surface { position:fixed; inset:0; pointer-events:none; opacity:0; transition:opacity 160ms ease; }
      #pointer { position:absolute; left:0; top:0; width:28px; height:32px; transform-origin:3px 3px; }
      #halo { position:absolute; left:-16px; top:-16px; width:38px; height:38px; border-radius:50%;
        background:radial-gradient(circle,rgba(57,156,255,.48),rgba(57,156,255,.12) 44%,transparent 72%); }
      svg { position:relative; width:26px; height:30px; filter:drop-shadow(0 1px 2px #0005); }
      #ring { position:absolute; left:0; top:0; width:28px; height:28px; margin:-14px;
        box-sizing:border-box; border:2px solid #399cff; border-radius:50%; opacity:0; }
      #trails { position:fixed; inset:0; width:100%; height:100%; overflow:visible; pointer-events:none; filter:none; }
      #trails path { fill:none; stroke:#339cff; stroke-width:4; stroke-linecap:round; stroke-linejoin:round; opacity:.58; }
      @media (prefers-reduced-motion:reduce) { #surface { transition:none; } }
      @media print { #surface, #trails { display:none; } }
    </style><svg id="trails" aria-hidden="true"></svg><div id="surface"><div id="ring"></div><div id="pointer"><div id="halo"></div>
      <svg viewBox="0 0 26 30" fill="none"><path d="M3 2L21 15.5L12.4 17L8.7 25L3 2Z" fill="white" stroke="#162436" stroke-width="1.6" stroke-linejoin="round"/></svg>
    </div></div>`;
    document.documentElement.appendChild(host);
    pointer = shadow.getElementById('pointer');
    halo = shadow.getElementById('halo');
    ring = shadow.getElementById('ring');
    trailLayer = shadow.getElementById('trails');
  }

  function removeTrail(trail) {
    clearTimeout(trail.timer);
    trail.animation?.cancel();
    trail.path.remove();
    trails.delete(trail);
  }

  function startTrail(from) {
    if (!trailMs) return null;
    while (trails.size >= MAX_TRAILS) removeTrail(trails.values().next().value);
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    const trail = { path, data: `M${from.x},${from.y}`, lifetime: trailMs, retiring: false, timer: null, animation: null };
    path.setAttribute('d', trail.data);
    trailLayer.appendChild(path);
    trails.add(trail);
    return trail;
  }

  function extendTrail(trail, point) {
    if (!trail) return;
    trail.data += ` L${Math.round(point.x * 10) / 10},${Math.round(point.y * 10) / 10}`;
    trail.path.setAttribute('d', trail.data);
  }

  function retireTrail(trail) {
    if (!trail || trail.retiring || !trails.has(trail)) return;
    trail.retiring = true;
    const fade = Math.min(400, trail.lifetime);
    trail.animation = trail.path.animate([{ opacity: .58 }, { opacity: 0 }], {
      delay: trail.lifetime - fade, duration: fade, fill: 'forwards'
    });
    trail.animation.finished.then(() => removeTrail(trail)).catch(() => {});
    // 后台暂停绘制时也回收节点；静止期间不运行逐帧循环。
    trail.timer = setTimeout(() => removeTrail(trail), trail.lifetime + 100);
  }

  function draw(point, angle = 0) {
    position = point;
    pointer.style.transform = `translate3d(${point.x}px,${point.y}px,0) rotate(${angle}deg)`;
  }

  function cancelMove() {
    if (!move) return;
    cancelAnimationFrame(move.frame);
    clearTimeout(move.deadline);
    const previous = move;
    move = null;
    pointer.style.willChange = 'auto';
    retireTrail(previous.trail);
    previous.resolve();
  }

  function scheduleHide() {
    clearTimeout(hideTimer);
    if (!held || hideMs === 0) hideTimer = setTimeout(hidePointer, hideMs);
  }

  function hidePointer() {
    clearTimeout(hideTimer);
    cancelMove();
    pulse?.cancel();
    pulse = null;
    if (shadow) shadow.getElementById('surface').style.opacity = '0';
  }

  function hide() {
    held = false;
    hidePointer();
    for (const trail of [...trails]) removeTrail(trail);
  }

  async function show(point) {
    ensure();
    cancelMove();
    clearTimeout(hideTimer);
    if (Number.isFinite(point.hideMs)) hideMs = Math.max(0, Math.min(60000, point.hideMs));
    if (Number.isFinite(point.trailMs)) trailMs = Math.max(0, Math.min(60000, point.trailMs));
    const to = { x: point.x, y: point.y };
    if (!Number.isFinite(to.x) || !Number.isFinite(to.y)) throw new Error('光标坐标无效');
    const surface = shadow.getElementById('surface');
    surface.style.opacity = '1';
    const from = point.from && Number.isFinite(point.from.x) && Number.isFinite(point.from.y)
      ? { x: point.from.x, y: point.from.y } : position;
    // 第一次没有已知位置时直接出现在目标，不伪造“从旁边划入”的起点。
    if (!from) {
      draw(to); scheduleHide();
      return { shown: true, animated: false };
    }
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    if (point.animate === false || document.visibilityState !== 'visible' || reducedMotion() || distance < 2) {
      draw(to);
      scheduleHide();
      return { shown: true, animated: false };
    }
    const duration = Math.min(320, Math.max(160, 130 + distance * .18));
    const bend = point.linear ? 0 : Math.min(44, distance * .08);
    const control = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 - bend };
    const tilt = Math.max(-24, Math.min(24, (to.x - from.x) * .06));
    draw(from);
    const trail = startTrail(from);
    pointer.style.willChange = 'transform';
    await new Promise(resolve => {
      const start = performance.now();
      const current = { resolve, frame: null, deadline: null, to, trail };
      move = current;
      const finish = () => {
        if (move !== current) return;
        cancelAnimationFrame(current.frame);
        clearTimeout(current.deadline);
        draw(to);
        extendTrail(trail, to);
        retireTrail(trail);
        pointer.style.willChange = 'auto';
        move = null;
        resolve();
      };
      const step = now => {
        if (move !== current) return;
        const t = Math.min(1, (now - start) / duration);
        const eased = 1 - (1 - t) ** 3;
        const q = 1 - eased;
        const point = { x: q*q*from.x + 2*q*eased*control.x + eased*eased*to.x,
          y: q*q*from.y + 2*q*eased*control.y + eased*eased*to.y };
        draw(point, tilt * Math.sin(t * Math.PI));
        extendTrail(trail, point);
        if (t >= 1 || document.visibilityState !== 'visible') finish();
        else current.frame = requestAnimationFrame(step);
      };
      current.frame = requestAnimationFrame(step);
      // 标签页切到后台或暂停绘制时，不能阻塞浏览器命令。
      current.deadline = setTimeout(finish, duration + 100);
    });
    scheduleHide();
    return { shown: true, animated: true };
  }

  function click(point) {
    ensure();
    if (Number.isFinite(point.hideMs)) hideMs = Math.max(0, Math.min(60000, point.hideMs));
    pulse?.cancel();
    if (document.visibilityState === 'visible' && !reducedMotion()) {
      ring.style.left = `${point.x}px`;
      ring.style.top = `${point.y}px`;
      pulse = ring.animate([
        { opacity: .85, transform: 'scale(.35)' },
        { opacity: 0, transform: 'scale(1.65)' }
      ], { duration: 360, easing: 'cubic-bezier(.16,1,.3,1)' });
      halo.animate([{ opacity: 1, transform: 'scale(1.25)' }, { opacity: 1, transform: 'scale(1)' }], { duration: 180 });
    }
    scheduleHide();
    return { pulsed: true };
  }

  function hold(value) {
    const next = value === true;
    if (next === held) return;
    held = next;
    if (held) {
      clearTimeout(hideTimer);
      if (shadow && hideMs > 0) shadow.getElementById('surface').style.opacity = '1';
    } else scheduleHide();
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' && move) {
      const to = move.to;
      cancelMove();
      draw(to);
      pointer.style.willChange = 'auto';
    }
  });
  Object.defineProperty(globalThis, '__aiBrowserCursor2', { value: Object.freeze({ show, click, hide, hold,
    state: () => ({ position: position && { ...position }, held, moving: Boolean(move),
      visible: Boolean(shadow && shadow.getElementById('surface').style.opacity === '1') }) }) });
})();
