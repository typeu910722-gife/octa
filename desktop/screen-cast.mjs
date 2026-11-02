// 4.2 手機遙控: a live picture of a bot's browser for the phone (or this computer's own window), and the phone's
// taps, scrolls and typing sent back into the page. It speaks CDP to whichever browser the bot uses:
//  - OCTA's embedded browser, through its localhost bridge (cdp-bridge.mjs), or
//  - the bot's own Chrome window (its --remote-debugging-port).
// Frames come from Page.startScreencast (JPEG, sized for the viewer's screen, every frame acknowledged). When a
// browser sends none (a hidden or minimised window does not paint), it falls back to a screenshot about every 0.8 s.
// A stream only runs while somebody looks: it stops on 「離開」 (bye) or 30 s after the last frame was asked for.
//
// createScreens({ resolvePort, connect, idleMs, now }) — resolvePort(bot) → CDP port or 0; connect(port) → client
// ({ send(method, params, sessionId), on(fn(method, params, sessionId)), close() }), replaced by a fake in tests.

const IDLE_MS = 30000;
const FIRST_FRAME_MS = 1500;   // no screencast frame by then: take screenshots instead
const SHOT_EVERY = 800;
const LOOK_EVERY = 2000;       // which tab the bot is on, and whether anybody still watches
const BUCKET = { size: 40, perSec: 20 };   // input: at most 20 events a second (bursts of 40)

// the tab the bot used last (same rule as the runner's pickLivePage)
export function livePage(targets) {
  const list = (targets || []).filter(t => t && t.type === 'page' && !String(t.url || '').startsWith('devtools://'));
  const real = list.filter(p => { const u = String(p.url || ''); return u && u !== 'about:blank' && !u.startsWith('data:'); });
  return real.at(-1) || list.at(-1) || null;
}
// what the person typed in the address box: a web address, or words to look up
export function navUrl(text) {
  const t = String(text || '').trim();
  if (!t) return 'https://www.google.com/';
  if (/^https?:\/\//i.test(t)) return t;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/.test(t) && !/\s/.test(t)) return 'https://' + t;
  return 'https://www.google.com/search?q=' + encodeURIComponent(t);
}
const KEYS = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 }
};
const num = (v, lo, hi) => { const n = +v; return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : null; };
// the phone's message → the CDP commands that do it (null: not a valid message)
export function inputCommands(ev) {
  const t = ev?.type;
  if (t === 'tap') {
    const x = num(ev.x, 0, 20000), y = num(ev.y, 0, 20000);
    if (x === null || y === null) return null;
    const at = { x, y, modifiers: 0 };
    return [['Input.dispatchMouseEvent', { type: 'mouseMoved', ...at, button: 'none', buttons: 0 }],
      ['Input.dispatchMouseEvent', { type: 'mousePressed', ...at, button: 'left', buttons: 1, clickCount: 1 }],
      ['Input.dispatchMouseEvent', { type: 'mouseReleased', ...at, button: 'left', buttons: 0, clickCount: 1 }]];
  }
  if (t === 'scroll') {
    const x = num(ev.x, 0, 20000), y = num(ev.y, 0, 20000), dx = num(ev.dx, -20000, 20000) ?? 0, dy = num(ev.dy, -20000, 20000) ?? 0;
    if (x === null || y === null || (!dx && !dy)) return null;
    return [['Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: dx, deltaY: dy, button: 'none', buttons: 0, modifiers: 0 }]];
  }
  if (t === 'text') {
    const text = String(ev.text ?? '').slice(0, 2000);
    return text ? [['Input.insertText', { text }]] : null;
  }
  if (t === 'key') {
    const k = KEYS[ev.key];
    if (!k) return null;
    const { text, unmodifiedText, ...base } = k;
    return [['Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...base, ...(text ? { text, unmodifiedText } : {}) }],
      ['Input.dispatchKeyEvent', { type: 'keyUp', ...base }]];
  }
  return null;
}
// the page's own flag: while the person has control the bot's live cursor (tag script) stays out of the way
const userFlag = on => on ? "window.__octaUser=true;try{var c=document.getElementById('__octa_cur');if(c)c.style.opacity='0'}catch(e){}" : 'window.__octaUser=false';

// a CDP connection over the browser's WebSocket (Node 22+ / Electron has a global WebSocket)
export async function wsConnect(port) {
  const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
  if (!r.ok) throw new Error('瀏覽器沒有開著');
  const { webSocketDebuggerUrl } = await r.json();
  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = () => no(new Error('連不上瀏覽器')); setTimeout(() => no(new Error('連不上瀏覽器')), 5000); });
  let n = 0; const wait = new Map(), subs = new Set();
  let closed = false;
  ws.onmessage = e => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.id && wait.has(m.id)) { const w = wait.get(m.id); wait.delete(m.id); m.error ? w.no(new Error(m.error.message)) : w.ok(m.result || {}); return; }
    if (m.method) for (const fn of subs) { try { fn(m.method, m.params || {}, m.sessionId); } catch { } }
  };
  ws.onclose = () => { closed = true; for (const w of wait.values()) w.no(new Error('瀏覽器連線結束')); wait.clear(); for (const fn of subs) { try { fn('octa.closed', {}); } catch { } } };
  return {
    send(method, params = {}, sessionId) {
      if (closed) return Promise.reject(new Error('瀏覽器連線結束'));
      return new Promise((ok, no) => {
        const id = ++n; wait.set(id, { ok, no });
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
        setTimeout(() => { if (wait.has(id)) { wait.delete(id); no(new Error('瀏覽器沒有回應')); } }, 10000);
      });
    },
    on(fn) { subs.add(fn); },
    close() { try { ws.close(); } catch { } }
  };
}

export function createScreens({ resolvePort, connect = wsConnect, inputHook = null, idleMs = IDLE_MS, now = Date.now, timers = globalThis } = {}) {
  const streams = new Map();   // bot id → stream
  const users = new Map();     // bot id → the person has control (接手)
  const buckets = new Map();   // bot id → input rate limit
  const wakeAll = s => { const w = [...s.waiters]; s.waiters.clear(); for (const f of w) f(); };

  function newFrame(s, jpeg, meta) {
    s.seq++;
    s.frame = { seq: s.seq, jpeg, meta: { ...meta, url: s.url, title: s.title, mode: s.mode, at: now() } };
    wakeAll(s);
  }
  async function attach(s, target) {
    const { client } = s;
    if (s.sessionId) {
      await client.send('Page.stopScreencast', {}, s.sessionId).catch(() => { });
      await client.send('Target.detachFromTarget', { sessionId: s.sessionId }).catch(() => { });
    }
    s.targetId = target.targetId; s.url = target.url || ''; s.title = target.title || '';
    const { sessionId } = await client.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    s.sessionId = sessionId;
    await client.send('Page.enable', {}, sessionId).catch(() => { });
    if (users.get(s.bot)) await client.send('Runtime.evaluate', { expression: userFlag(true) }, sessionId).catch(() => { });
    s.mode = 'cast'; s.castAt = 0; s.startedAt = now();
    await client.send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: s.w, maxHeight: s.h, everyNthFrame: 1 }, sessionId).catch(() => { s.mode = 'shot'; });
    timers.setTimeout(() => { if (s.alive && s.sessionId === sessionId && !s.castAt) { s.mode = 'shot'; shoot(s); } }, FIRST_FRAME_MS);
  }
  async function shoot(s) {   // a browser that paints no screencast frames (hidden, minimised): one screenshot
    if (!s.alive || s.shooting || !s.sessionId) return;
    s.shooting = true;
    try {
      const sid = s.sessionId;
      const m = await s.client.send('Page.getLayoutMetrics', {}, sid).catch(() => ({}));
      const vp = m.cssVisualViewport || m.cssLayoutViewport || {};
      const w = +vp.clientWidth || 1280, h = +vp.clientHeight || 800;
      const scale = Math.min(1, s.w / w, s.h / h);
      const shot = await s.client.send('Page.captureScreenshot', { format: 'jpeg', quality: 60, ...(scale < 1 ? { clip: { x: +vp.pageX || 0, y: +vp.pageY || 0, width: w, height: h, scale } } : {}) }, sid);
      if (s.alive && sid === s.sessionId && shot?.data) newFrame(s, Buffer.from(shot.data, 'base64'), { deviceWidth: w, deviceHeight: h, offsetTop: 0, pageScaleFactor: 1, scrollX: +vp.pageX || 0, scrollY: +vp.pageY || 0 });
    } catch { } finally { s.shooting = false; }
  }
  // something changed on the page (a tap, a new address): if no new frame shows it within a second, take a screenshot
  function kick(s) {
    const seq = s.seq;
    timers.setTimeout(() => { if (s.alive && s.seq === seq) void shoot(s); }, 1000);
  }
  async function look(s) {   // every 2 s: nobody watching → stop; the bot moved to another tab → follow it; no screencast → screenshot
    if (!s.alive) return;
    if (now() - s.lastView > idleMs) return stop(s.bot, 'idle');
    try {
      const { targetInfos = [] } = await s.client.send('Target.getTargets');
      const p = livePage(targetInfos);
      if (p && p.targetId !== s.targetId) await attach(s, p);
      else if (p) { s.url = p.url || s.url; s.title = p.title || s.title; }
    } catch { }
  }
  async function start(bot, browser, size) {
    const port = await resolvePort({ id: bot, browser });
    if (!port) return null;
    const client = await connect(port);
    const s = { bot, port, client, alive: true, seq: 0, frame: null, waiters: new Set(), lastView: now(), w: size.w, h: size.h, mode: 'cast', sessionId: '', targetId: '', url: '', title: '', castAt: 0 };
    streams.set(bot, s);
    client.on((method, params, sessionId) => {
      if (method === 'octa.closed') { if (streams.get(bot) === s) stop(bot, 'closed'); return; }
      if (method === 'Page.screencastFrame' && (!sessionId || sessionId === s.sessionId)) {
        s.client.send('Page.screencastFrameAck', { sessionId: params.sessionId }, s.sessionId).catch(() => { });
        s.castAt = now(); s.mode = 'cast';
        newFrame(s, Buffer.from(params.data || '', 'base64'), params.metadata || {});
      }
      if (method === 'Page.frameNavigated' && sessionId === s.sessionId && !params.frame?.parentId) {
        s.url = params.frame?.url || s.url;
        if (users.get(bot)) s.client.send('Runtime.evaluate', { expression: userFlag(true) }, s.sessionId).catch(() => { });
        // Electron's embedded page drops the screencast on a new document: ask again, and make sure a picture follows
        if (s.mode === 'cast') timers.setTimeout(() => { if (s.alive && s.sessionId) s.client.send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: s.w, maxHeight: s.h, everyNthFrame: 1 }, s.sessionId).catch(() => { }); }, 200);
        kick(s);
      }
    });
    const { targetInfos = [] } = await client.send('Target.getTargets');
    const p = livePage(targetInfos);
    if (!p) { stop(bot, 'nopage'); return null; }
    await attach(s, p);
    s.lookTimer = timers.setInterval(() => void look(s), LOOK_EVERY);
    s.shotTimer = timers.setInterval(() => { if (s.mode === 'shot' && now() - s.lastView < 5000) void shoot(s); }, SHOT_EVERY);
    return s;
  }
  function stop(bot, why = 'bye') {
    const s = streams.get(bot);
    if (!s) return false;
    streams.delete(bot);
    s.alive = false; s.why = why;
    timers.clearInterval(s.lookTimer); timers.clearInterval(s.shotTimer);
    if (s.sessionId) s.client.send('Page.stopScreencast', {}, s.sessionId).catch(() => { });
    try { s.client.close(); } catch { }
    wakeAll(s);
    return true;
  }
  const starting = new Map();
  async function ensure(bot, browser, size) {
    const s = streams.get(bot);
    if (s?.alive) {
      // the viewer's screen is a lot bigger or smaller now (turned the phone, zoomed): ask for frames of that size
      if (Math.abs(size.w - s.w) > 160 || Math.abs(size.h - s.h) > 160) {
        s.w = size.w; s.h = size.h;
        if (s.sessionId && s.mode === 'cast') s.client.send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: s.w, maxHeight: s.h, everyNthFrame: 1 }, s.sessionId).catch(() => { });
      }
      return s;
    }
    if (!starting.has(bot)) starting.set(bot, start(bot, browser, size).catch(() => null).finally(() => starting.delete(bot)));
    return starting.get(bot);
  }
  const fit = (v, lo, hi, d) => { const n = Math.round(+v); return Number.isFinite(n) && n > 0 ? Math.min(hi, Math.max(lo, n)) : d; };
  return {
    // the newest frame after `after` (waits up to `wait` ms for one). null: this bot's browser is not open
    async frame(bot, { browser = '', after = 0, w, h, wait = 8000 } = {}) {
      const size = { w: fit(w, 240, 1920, 1080), h: fit(h, 240, 2400, 1920) };
      const s = await ensure(bot, browser, size);
      if (!s) return null;
      s.lastView = now();
      if (!s.frame || s.frame.seq <= after) {
        await new Promise(ok => { const t = timers.setTimeout(ok, wait); s.waiters.add(() => { timers.clearTimeout(t); ok(); }); });
      }
      if (!s.alive && !s.frame) return null;
      return s.frame && s.frame.seq > after ? s.frame : { seq: s.frame?.seq || after, same: true, meta: s.frame?.meta || {} };
    },
    async input(bot, ev) {
      const cmds = inputCommands(ev);
      if (!cmds) return { error: '看不懂這個操作', status: 400 };
      // rate limit: a token bucket per bot
      const t = now(), b = buckets.get(bot) || { tokens: BUCKET.size, at: t };
      b.tokens = Math.min(BUCKET.size, b.tokens + ((t - b.at) / 1000) * BUCKET.perSec); b.at = t;
      buckets.set(bot, b);
      if (b.tokens < 1) return { error: '操作太快了，請慢一點', status: 429 };
      b.tokens -= 1;
      const s = streams.get(bot);
      if (!s?.sessionId) return { error: '畫面還沒連上，請稍等一下', status: 409 };
      s.lastView = t;
      // OCTA's own browser: Electron delivers it (also to a page parked off screen); anything else gets CDP input
      const viaHook = inputHook ? await Promise.resolve(inputHook({ bot, port: s.port, targetId: s.targetId, ev })).catch(() => false) : false;
      if (!viaHook) for (const [m, p] of cmds) await s.client.send(m, p, s.sessionId);
      // a screenshot-only browser: show the result of the tap right away
      if (s.mode === 'shot') timers.setTimeout(() => void shoot(s), 250);
      else kick(s);
      return { ok: true };
    },
    async nav(bot, { act, url } = {}) {
      const s = streams.get(bot);
      if (!s?.sessionId) return { error: '畫面還沒連上，請稍等一下', status: 409 };
      const sid = s.sessionId;
      kick(s);
      if (act === 'go') { const to = navUrl(url); await s.client.send('Page.navigate', { url: to }, sid); s.url = to; return { ok: true, url: to }; }
      if (act === 'reload') { await s.client.send('Page.reload', {}, sid); return { ok: true }; }
      if (act === 'back') {
        const h = await s.client.send('Page.getNavigationHistory', {}, sid).catch(() => null);
        const prev = h?.entries?.[h.currentIndex - 1];
        if (prev) await s.client.send('Page.navigateToHistoryEntry', { entryId: prev.id }, sid);
        else await s.client.send('Runtime.evaluate', { expression: 'history.back()' }, sid);
        return { ok: true };
      }
      return { error: '看不懂這個操作', status: 400 };
    },
    // 接手 / 我好了 (from the phone, the computer's switch or the chat): the page knows the mouse is the person's
    flag(bot, on) {
      users.set(bot, !!on);
      const s = streams.get(bot);
      if (s?.sessionId) s.client.send('Runtime.evaluate', { expression: userFlag(!!on) }, s.sessionId).catch(() => { });
    },
    bye: bot => stop(bot, 'bye'),
    stopAll() { for (const id of [...streams.keys()]) stop(id, 'close'); },
    active: bot => !!streams.get(bot)?.alive,
    info: bot => { const s = streams.get(bot); return s ? { mode: s.mode, seq: s.seq, port: s.port, url: s.url, w: s.w, h: s.h } : null }
  };
}
