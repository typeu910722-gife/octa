// How the in-app browser shares the OCTA window.
// 4.1: the page has a work panel on the right; its 瀏覽器 tab tells the app its rectangle ('dock')
// and the bot's browser sits exactly there. The older modes stay for a page that does not dock:
// a thumbnail in the corner, or the bot's own side panel that can be dragged and resized.

export const PAGE = { width: 1280, height: 800 };
export const THUMB_RADIUS = 18;
export const OPEN_BAR = 48;
export const ENGINE_ROW = 36;
export const TAB_ROW = 28;
export const PANEL_EDGE = 8;
// the "watch only | take control" switch sits in the frame right under the page, so it never covers the site
export const CONTROL_ROW = 40;
export const PANEL_MIN = { width: 360, height: 280 };

// Where the collapsed browser card sits. `at` is the place the person dragged it to.
export function thumbBox(w, h, at) {
  w = Math.max(1, Math.round(w));
  h = Math.max(1, Math.round(h));
  const margin = 12;
  const width = Math.min(220, Math.max(120, w - margin * 2));
  const height = Math.min(148, Math.max(84, Math.round(width * 0.67)));
  const maxX = Math.max(margin, w - width - margin);
  const maxY = Math.max(margin, h - height - margin);
  const x = at && Number.isFinite(+at.x) ? Math.round(+at.x) : maxX;
  const y = at && Number.isFinite(+at.y) ? Math.round(+at.y) : maxY;
  return {
    x: Math.min(maxX, Math.max(Math.min(margin, maxX), x)),
    y: Math.min(maxY, Math.max(Math.min(margin, maxY), y)),
    width,
    height
  };
}

// The thumbnail shrunk to a small round button. It sits in the corner the card was in,
// so it does not cover the chat; clicking it brings the card back.
export const DOT_SIZE = 44;
export function dotBox(w, h, at) {
  const card = thumbBox(w, h, at);
  const size = Math.min(DOT_SIZE, card.width, card.height);
  return { x: card.x + card.width - size, y: card.y + card.height - size, width: size, height: size };
}

export function isBlankUrl(url) {
  const u = String(url || '');
  return !u || u === 'about:blank' || u.startsWith('data:');
}

function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

// A normal browser window is wider than it is tall. 8:5 is 16:10.
const OPEN_W = 8;
const OPEN_H = 5;

// The old default was a full-height strip at most 520px wide. Drop that saved place
// so the next open uses the normal proportion. A box the person actually widened stays.
export function freshOpen(at) {
  if (!at || !Number.isFinite(+at.w) || !Number.isFinite(+at.h)) return null;
  if (+at.h > +at.w && +at.w <= 520) return null;
  return at;
}

function defaultOpen(maxW, maxH, minW, minH) {
  let width = maxW;
  let height = Math.round(width * OPEN_H / OPEN_W);
  if (height > maxH) {
    height = maxH;
    width = Math.round(height * OPEN_W / OPEN_H);
  }
  width = clamp(width, minW, maxW);
  height = clamp(height, minH, maxH);
  return { width, height };
}

// The opened browser. `at` is {x, y, w, h} after the person drags or resizes it.
// With no `at`, it opens on the right as a normal landscape window, inside this window.
export function sidebarBox(w, h, at) {
  w = Math.max(1, Math.round(w));
  h = Math.max(1, Math.round(h));
  const margin = 12;
  const minW = Math.min(PANEL_MIN.width, Math.max(160, w - margin * 2));
  const minH = Math.min(PANEL_MIN.height, Math.max(160, h - margin * 2));
  const maxW = Math.max(minW, w - margin * 2);
  const maxH = Math.max(minH, h - margin * 2);
  const fresh = defaultOpen(maxW, maxH, minW, minH);
  const width = clamp(at && Number.isFinite(+at.w) ? Math.round(+at.w) : fresh.width, minW, maxW);
  const height = clamp(at && Number.isFinite(+at.h) ? Math.round(+at.h) : fresh.height, minH, maxH);
  const maxX = Math.max(margin, w - width - margin);
  const maxY = Math.max(margin, h - height - margin);
  const x = at && Number.isFinite(+at.x) ? Math.round(+at.x) : maxX;
  const y = at && Number.isFinite(+at.y) ? Math.round(+at.y) : margin + Math.round((maxH - height) / 2);
  return {
    x: clamp(x, Math.min(margin, maxX), maxX),
    y: clamp(y, Math.min(margin, maxY), maxY),
    width,
    height
  };
}

// edge is a string of n, s, e, w. The opposite edge stays put.
// The box stays inside the window and never shrinks past the minimum.
export function resizeBox(winW, winH, box, edge, dx, dy) {
  const w = Math.max(1, Math.round(winW));
  const h = Math.max(1, Math.round(winH));
  const margin = 12;
  const minW = Math.min(PANEL_MIN.width, Math.max(160, w - margin * 2));
  const minH = Math.min(PANEL_MIN.height, Math.max(160, h - margin * 2));
  const e = String(edge || '');
  const left = e.includes('w');
  const right = e.includes('e');
  const top = e.includes('n');
  const bottom = e.includes('s');
  let x = Math.round(+box.x);
  let y = Math.round(+box.y);
  let width = Math.round(+box.width);
  let height = Math.round(+box.height);
  const x2 = x + width;
  const y2 = y + height;
  if (right) width += dx;
  if (bottom) height += dy;
  if (left) { x += dx; width = x2 - x; }
  if (top) { y += dy; height = y2 - y; }
  if (left && !right) { width = Math.max(minW, width); x = x2 - width; }
  else width = Math.max(minW, width);
  if (top && !bottom) { height = Math.max(minH, height); y = y2 - height; }
  else height = Math.max(minH, height);
  if (x < margin) {
    if (left && !right) width -= margin - x;
    x = margin;
  }
  if (y < margin) {
    if (top && !bottom) height -= margin - y;
    y = margin;
  }
  if (x + width > w - margin) {
    if (right || !left) width = (w - margin) - x;
    else x = (w - margin) - width;
  }
  if (y + height > h - margin) {
    if (bottom || !top) height = (h - margin) - y;
    else y = (h - margin) - height;
  }
  width = Math.max(Math.min(minW, w - margin * 2), Math.min(width, w - margin * 2));
  height = Math.max(Math.min(minH, h - margin * 2), Math.min(height, h - margin * 2));
  x = Math.min(Math.max(margin, x), Math.max(margin, w - width - margin));
  y = Math.min(Math.max(margin, y), Math.max(margin, h - height - margin));
  return { x, y, width, height };
}

// The work panel's 瀏覽器 area, as the page measured it (CSS pixels × zoom = window pixels), kept inside the window.
// Too small to use (a folded or squeezed panel): null, nothing is shown.
export const DOCK_EDGE = 6;
export const DOCK_MIN = 120;
export function dockBox(w, h, rect, zoom) {
  if (!rect) return null;
  const z = Number.isFinite(+zoom) && +zoom > 0 ? +zoom : 1;
  const n = v => (Number.isFinite(+v) ? +v * z : NaN);
  let x = n(rect.x), y = n(rect.y), width = n(rect.width), height = n(rect.height);
  if (![x, y, width, height].every(Number.isFinite)) return null;
  w = Math.max(1, Math.round(w));
  h = Math.max(1, Math.round(h));
  x = Math.round(Math.max(0, x));
  y = Math.round(Math.max(0, y));
  width = Math.round(Math.min(width, w - x));
  height = Math.round(Math.min(height, h - y));
  if (width < DOCK_MIN || height < DOCK_MIN) return null;
  return { x, y, width, height };
}

// thumb: a corner preview, the chat keeps the whole window. opts.dot shrinks it to a round button.
// opts.covered: a dialog is open in the chat, so nothing is placed over it.
// open: a side panel for this bot only. The chat stays full size underneath.
// opts.control: the person took control of this page. Otherwise (watch only) a clear shield
// lies exactly over the page so the person's mouse and keys never reach it; the bot's own
// input goes straight to the page's renderer and is not stopped by it.
export function embedFrames(w, h, mode, at, opts) {
  w = Math.max(1, Math.round(w));
  h = Math.max(1, Math.round(h));
  const main = { x: 0, y: 0, width: w, height: h };
  if (mode === 'thumb') {
    if (opts?.covered) return { mode: 'hidden', main, page: null, chrome: null };
    return { mode: 'thumb', main, page: null, dot: !!opts?.dot, chrome: opts?.dot ? dotBox(w, h, at) : thumbBox(w, h, at) };
  }
  // a dialog in the chat is open: the browser views sit above the page, so they step aside until it closes
  if (mode === 'open' && opts?.covered) return { mode: 'hidden', main, page: null, chrome: null };
  // dock: inside the work panel's 瀏覽器 tab. The frame (address bar, tabs, the watch/control switch) fills the
  // area and the page sits inside it, a few pixels in from the edges. at = the area (dockBox).
  if (mode === 'dock') {
    const box = opts?.covered ? null : dockBox(w, h, at, opts?.zoom);
    if (!box) return { mode: 'hidden', main, page: null, chrome: null };
    const bar = OPEN_BAR + ENGINE_ROW + ((opts?.tabs || 0) > 0 ? TAB_ROW : 0);
    const page = {
      x: box.x + DOCK_EDGE,
      y: box.y + bar,
      width: Math.max(1, box.width - DOCK_EDGE * 2),
      height: Math.max(1, box.height - bar - CONTROL_ROW - DOCK_EDGE)
    };
    return { mode: 'dock', main, box, chrome: { ...box }, page, shield: shieldFor('dock', page, opts?.control) };
  }
  if (mode === 'open') {
    const box = sidebarBox(w, h, at);
    const edge = PANEL_EDGE;
    const bar = OPEN_BAR + ENGINE_ROW + ((opts?.tabs || 0) > 0 ? TAB_ROW : 0);
    const page = {
      x: box.x + edge,
      y: box.y + bar,
      width: Math.max(1, box.width - edge * 2),
      height: Math.max(1, box.height - bar - CONTROL_ROW - edge)
    };
    return {
      mode: 'open',
      main,
      box,
      chrome: { x: box.x, y: box.y, width: box.width, height: box.height },
      page,
      shield: shieldFor('open', page, opts?.control)
    };
  }
  return { mode: 'hidden', main, page: null, chrome: null };
}

// Watch only is the default. The shield is the page's exact rectangle, only while the panel is open (or docked)
// and the person has not taken control. A thumbnail's page is parked in a hidden window, so it needs none.
export function shieldFor(mode, page, control) {
  if ((mode !== 'open' && mode !== 'dock') || !page || control) return null;
  return { x: page.x, y: page.y, width: page.width, height: page.height };
}

// A wheel turn over the shield scrolls the page with script, not with an input event,
// so the page (and the bot's live cursor) never sees the person's mouse.
export function wheelDelta(e, pageHeight) {
  const unit = e?.deltaMode === 1 ? 40 : e?.deltaMode === 2 ? Math.max(1, +pageHeight || 800) : 1;
  const cap = v => Math.max(-4000, Math.min(4000, Math.round(v)));
  return { dx: cap((+e?.deltaX || 0) * unit), dy: cap((+e?.deltaY || 0) * unit) };
}
// scrolls the innermost scrollable box under the pointer, or else the page itself
export function scrollScript(x, y, dx, dy) {
  const n = v => (Number.isFinite(+v) ? Math.round(+v) : 0);
  return '((x,y,dx,dy)=>{let el=document.elementFromPoint(x,y);' +
    'while(el&&el!==document.body&&el!==document.documentElement){const s=getComputedStyle(el);' +
    'const sy=dy&&/(auto|scroll|overlay)/.test(s.overflowY)&&el.scrollHeight>el.clientHeight+1;' +
    'const sx=dx&&/(auto|scroll|overlay)/.test(s.overflowX)&&el.scrollWidth>el.clientWidth+1;' +
    'if(sy||sx){el.scrollBy(dx,dy);return}el=el.parentElement}' +
    `(document.scrollingElement||document.documentElement).scrollBy(dx,dy)})(${n(x)},${n(y)},${n(dx)},${n(dy)})`;
}

// While the person has control, the bot's live cursor stays out of the way: the page's tag script
// (desktop/runner/) checks this flag and does not follow the person's mouse.
export function userFlagScript(on) {
  return on
    ? "window.__octaUser=true;try{var c=document.getElementById('__octa_cur');if(c)c.style.opacity='0'}catch(e){}"
    : 'window.__octaUser=false';
}

// The stage message the chat page gets when the switch flips: take control = 接手 (hand), back to watching = 繼續 (go).
export function controlStage(on) {
  return on ? 'hand' : 'go';
}

// 4.2 手機遙控 on OCTA's own browser: the phone's tap / scroll / typing as Electron input. webContents.sendInputEvent
// reaches a page that is parked off screen (the 瀏覽器 tab closed on the computer), where CDP mouse events get lost.
// Returns steps for main.mjs: { input } → sendInputEvent, { text } → insertText, { script } → executeJavaScript, { wait } ms.
export function phoneInput(ev) {
  const n = (v, lo, hi) => { const x = +v; return Number.isFinite(x) ? Math.round(Math.min(hi, Math.max(lo, x))) : null; };
  if (ev?.type === 'tap') {
    const x = n(ev.x, 0, 20000), y = n(ev.y, 0, 20000);
    if (x === null || y === null) return null;
    // a short pause like a real finger: a press that lands in the same instant as the move is sometimes dropped
    return [{ input: { type: 'mouseMove', x, y } }, { wait: 30 }, { input: { type: 'mouseDown', x, y, button: 'left', clickCount: 1 } }, { wait: 30 }, { input: { type: 'mouseUp', x, y, button: 'left', clickCount: 1 } }];
  }
  if (ev?.type === 'scroll') {
    const x = n(ev.x, 0, 20000), y = n(ev.y, 0, 20000), dx = n(ev.dx, -20000, 20000) || 0, dy = n(ev.dy, -20000, 20000) || 0;
    if (x === null || y === null || (!dx && !dy)) return null;
    return [{ script: scrollScript(x, y, dx, dy) }];
  }
  if (ev?.type === 'text') { const text = String(ev.text ?? '').slice(0, 2000); return text ? [{ text }] : null; }
  if (ev?.type === 'key') {
    const k = { Enter: 'Enter', Backspace: 'Backspace', Tab: 'Tab' }[ev.key];
    if (!k) return null;
    return [{ input: { type: 'keyDown', keyCode: k } }, ...(k === 'Enter' ? [{ input: { type: 'char', keyCode: '\r' } }] : []), { input: { type: 'keyUp', keyCode: k } }];
  }
  return null;
}

// 4.8.1: where a bot's pages wait while they are not on screen. The window holding them is SHOWN (a hidden or
// minimised window stops drawing: the page's animation frames stop, screenshots never come back and loaders such as
// Gmail's never finish), so it is placed past the top-left corner of every screen, where nobody sees it.
export const PARK_GAP = 400;
// One window per page, side by side (slot 0, 1, 2… further left): a page covered by another page or window stops drawing too.
export function parkSpot(displays, size = PAGE, slot = 0) {
  const all = (displays || []).map(d => d?.bounds || d).filter(b => b && Number.isFinite(+b.x) && Number.isFinite(+b.y));
  const minX = all.length ? Math.min(...all.map(b => +b.x)) : 0;
  const minY = all.length ? Math.min(...all.map(b => +b.y)) : 0;
  const n = Math.max(0, Math.floor(+slot || 0));
  return { x: Math.round(minX - size.width - PARK_GAP - n * (size.width + 40)), y: Math.round(minY - size.height - PARK_GAP) };
}
// true when a window at `box` would show on any screen (then it is moved back out of sight)
export function onAnyScreen(box, displays) {
  if (!box) return false;
  return (displays || []).map(d => d?.bounds || d).some(b => b && box.x < b.x + b.width && box.x + box.width > b.x && box.y < b.y + b.height && box.y + box.height > b.y);
}
