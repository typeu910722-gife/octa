// How the in-app browser shares the OCTA window.
// The chat always keeps the whole window. A thumbnail sits in the corner.
// The opened browser is that bot's own side panel: it can be dragged and resized,
// and it stays inside the window.

export const PAGE = { width: 1280, height: 800 };
export const THUMB_RADIUS = 18;
export const OPEN_BAR = 48;
export const ENGINE_ROW = 36;
export const TAB_ROW = 28;
export const PANEL_EDGE = 8;
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

// thumb: a corner preview, the chat keeps the whole window. opts.dot shrinks it to a round button.
// opts.covered: a dialog is open in the chat, so nothing is placed over it.
// open: a side panel for this bot only. The chat stays full size underneath.
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
  if (mode === 'open') {
    const box = sidebarBox(w, h, at);
    const edge = PANEL_EDGE;
    const bar = OPEN_BAR + ENGINE_ROW + ((opts?.tabs || 0) > 0 ? TAB_ROW : 0);
    return {
      mode: 'open',
      main,
      box,
      chrome: { x: box.x, y: box.y, width: box.width, height: box.height },
      page: {
        x: box.x + edge,
        y: box.y + bar,
        width: Math.max(1, box.width - edge * 2),
        height: Math.max(1, box.height - bar - edge)
      }
    };
  }
  return { mode: 'hidden', main, page: null, chrome: null };
}
