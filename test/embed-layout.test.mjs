import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ENGINE_ROW, OPEN_BAR, PANEL_EDGE, TAB_ROW, THUMB_RADIUS, embedFrames, freshOpen, isBlankUrl, resizeBox, sidebarBox, thumbBox } from '../desktop/embed-layout.mjs';
import { pickLivePage } from '../public/octa-runner.mjs';

test('the opened browser is a side panel and the chat keeps the whole window', () => {
  const lay = embedFrames(1920, 1000, 'open');
  assert.equal(lay.mode, 'open');
  assert.equal(lay.main.width, 1920);
  assert.equal(lay.main.height, 1000);
  assert.equal(lay.box.y, 12);
  assert.equal(lay.box.x, 1920 - lay.box.width - 12);
  assert.ok(lay.box.width > lay.box.height);
  assert.ok(Math.abs(lay.box.width / lay.box.height - 8 / 5) < 0.02);
  const short = embedFrames(1600, 700, 'open');
  assert.ok(short.box.width > short.box.height);
  assert.ok(Math.abs(short.box.width / short.box.height - 8 / 5) < 0.02);
  assert.equal(freshOpen({ x: 12, y: 12, w: 480, h: 900 }), null);
  const kept = freshOpen({ x: 40, y: 80, w: 960, h: 600 });
  assert.equal(kept.w, 960);
  const again = embedFrames(1920, 1000, 'open', freshOpen({ x: 1400, y: 12, w: 500, h: 976 }));
  assert.equal(again.box.width, lay.box.width);
  assert.equal(again.box.height, lay.box.height);
  assert.equal(lay.chrome.x, lay.box.x);
  assert.equal(lay.chrome.width, lay.box.width);
  assert.equal(lay.chrome.height, lay.box.height);
  assert.equal(lay.page.x, lay.box.x + PANEL_EDGE);
  assert.equal(lay.page.y, lay.box.y + OPEN_BAR + ENGINE_ROW);
  assert.equal(lay.page.width, lay.box.width - PANEL_EDGE * 2);
  const narrow = embedFrames(1366, 768, 'open');
  assert.equal(narrow.main.width, 1366);
  assert.equal(narrow.main.height, 768);
  assert.equal(narrow.box.x, 1366 - narrow.box.width - 12);
  assert.ok(narrow.box.x >= 12);
  assert.ok(narrow.page.y + narrow.page.height <= narrow.box.y + narrow.box.height);
});

test('the visible page is the real site, not the opening card', () => {
  assert.equal(isBlankUrl(''), true);
  assert.equal(isBlankUrl('about:blank'), true);
  assert.equal(isBlankUrl('data:text/html,hi'), true);
  assert.equal(isBlankUrl('https://chat.line.biz/'), false);
  assert.equal(isBlankUrl('https://www.google.com/'), false);
  const page = pickLivePage([
    { type: 'page', url: 'data:text/html,splash', targetId: 'splash' },
    { type: 'page', url: 'https://chat.line.biz/account', targetId: 'line' },
    { type: 'page', url: 'about:blank', targetId: 'blank' }
  ]);
  assert.equal(page.targetId, 'line');
});

test('foreground tabs are the on-screen view', () => {
  const src = readFileSync(new URL('../desktop/main.mjs', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('async createTarget'), src.indexOf('async closeTarget'));
  assert.ok(fn.includes('params?.background'));
  assert.ok(fn.indexOf('params?.background') < fn.indexOf('new BrowserWindow'));
  assert.match(fn, /isBlankUrl/);
  assert.match(fn, /embedShow\(port, true\)/);
  assert.doesNotMatch(fn, /embedShow\(port, 'open'\)/);
  assert.doesNotMatch(src, /dockLayout/);
  assert.match(src, /https:\/\/www\.google\.com\//);
  assert.doesNotMatch(src, /網頁會開在這裡/);
  assert.match(src, /bucket\.shown === 'open' \? 'open' : 'thumb'/);
  assert.match(src, /octa:focus-bot/);
  assert.match(src, /bucket\.botId === focusBotId/);
  const showFn = src.slice(src.indexOf('async function embedShow'), src.indexOf('async function embedStop'));
  assert.doesNotMatch(showFn, /e\.shown = false/);
  const pkg = JSON.parse(readFileSync(new URL('../desktop/package.json', import.meta.url), 'utf8'));
  assert.ok(pkg.build.files.includes('browser-chrome.html'));
  assert.ok(pkg.build.files.includes('browser-preload.cjs'));
});

test('a thumbnail leaves the chat full width', () => {
  const lay = embedFrames(1920, 1000, 'thumb');
  assert.equal(lay.mode, 'thumb');
  assert.equal(lay.main.width, 1920);
  assert.equal(lay.main.height, 1000);
  assert.equal(lay.page, null);
  assert.ok(lay.chrome.width <= 220);
  assert.ok(lay.chrome.x + lay.chrome.width <= 1920);
  assert.ok(lay.chrome.y + lay.chrome.height <= 1000);
  assert.ok(lay.chrome.width >= 120);
});

test('opening the browser keeps a toolbar and a closable tab row inside the panel', () => {
  const tabs = embedFrames(1920, 1000, 'open', { x: 40, y: 80, w: 480, h: 640 }, { tabs: 1 });
  assert.equal(tabs.main.width, 1920);
  assert.equal(tabs.box.x, 40);
  assert.equal(tabs.box.y, 80);
  assert.equal(tabs.box.width, 480);
  assert.equal(tabs.box.height, 640);
  assert.equal(tabs.page.y, tabs.box.y + OPEN_BAR + ENGINE_ROW + TAB_ROW);
  assert.equal(tabs.page.x, tabs.box.x + PANEL_EDGE);
  assert.ok(tabs.page.width > 0 && tabs.page.height > 0);
  const html = readFileSync(new URL('../desktop/browser-chrome.html', import.meta.url), 'utf8');
  assert.match(html, /返回上一頁/);
  assert.match(html, /開啟新分頁/);
  assert.match(html, />編輯</);
  assert.match(html, /id="goBack"/);
  assert.match(html, /關閉分頁/);
  assert.match(html, /data-close/);
  assert.match(html, /data-edge="se"/);
  assert.match(html, /data-edge="nw"/);
  assert.match(html, /data-engine="chrome"/);
  assert.match(html, /data-engine="brave"/);
  assert.match(html, /data-engine="firefox"/);
  assert.match(html, /data-engine="edge"/);
  assert.match(html, /這個網站不支援現在的瀏覽器/);
  const main = readFileSync(new URL('../desktop/main.mjs', import.meta.url), 'utf8');
  assert.match(main, /octa:browser-back/);
  assert.match(main, /octa:browser-tab/);
  assert.match(main, /octa:browser-go/);
  assert.match(main, /freshOpen/);
  assert.match(main, /octa:browser-close/);
  assert.match(main, /navigationHistory\.goBack/);
  assert.match(main, /tabs: bucket\.tabs\.length/);
  assert.match(main, /function closeEmbedTab/);
  const page = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(page, /function focusBrowser/);
  assert.match(page, /focusBot/);
  const preload = readFileSync(new URL('../desktop/preload.cjs', import.meta.url), 'utf8');
  assert.match(preload, /octa:focus-bot/);
});

test('dragging and resizing the side panel stays inside the window', () => {
  const moved = sidebarBox(1920, 1000, { x: 30, y: 40, w: 500, h: 700 });
  assert.equal(moved.x, 30);
  assert.equal(moved.y, 40);
  assert.equal(moved.width, 500);
  assert.equal(moved.height, 700);
  const clamped = sidebarBox(1920, 1000, { x: 9000, y: -40, w: 9000, h: 9000 });
  assert.equal(clamped.y, 12);
  assert.ok(clamped.x >= 12);
  assert.ok(clamped.x + clamped.width <= 1920 - 12);
  assert.ok(clamped.y + clamped.height <= 1000 - 12);
  const east = resizeBox(1920, 1000, { x: 800, y: 100, width: 400, height: 400 }, 'e', 1000, 0);
  assert.equal(east.x, 800);
  assert.equal(east.width, 1920 - 12 - 800);
  assert.equal(east.height, 400);
  const west = resizeBox(1920, 1000, { x: 100, y: 100, width: 400, height: 400 }, 'w', -200, 0);
  assert.equal(west.x + west.width, 500);
  assert.equal(west.x, 12);
  const north = resizeBox(1920, 1000, { x: 100, y: 100, width: 400, height: 400 }, 'n', 0, -40);
  assert.equal(north.y, 60);
  assert.equal(north.height, 440);
  assert.equal(north.x, 100);
  const corner = resizeBox(1920, 1000, { x: 100, y: 100, width: 400, height: 400 }, 'se', 20, 30);
  assert.equal(corner.x, 100);
  assert.equal(corner.y, 100);
  assert.equal(corner.width, 420);
  assert.equal(corner.height, 430);
  const tiny = resizeBox(1920, 1000, { x: 100, y: 100, width: 400, height: 400 }, 'e', -500, 0);
  assert.ok(tiny.width >= 360);
  assert.equal(tiny.x, 100);
});

test('a dragged thumbnail stays where it was put and stays on screen', () => {
  const placed = embedFrames(1920, 1000, 'thumb', { x: 40, y: 80 });
  assert.equal(placed.chrome.x, 40);
  assert.equal(placed.chrome.y, 80);
  assert.equal(placed.main.width, 1920);
  assert.equal(placed.page, null);
  const clamped = thumbBox(1920, 1000, { x: 9000, y: -40 });
  assert.equal(clamped.y, 12);
  assert.ok(clamped.x + clamped.width <= 1920 - 12);
  assert.equal(THUMB_RADIUS, 18);
  const html = readFileSync(new URL('../desktop/browser-chrome.html', import.meta.url), 'utf8');
  assert.match(html, /border-radius:\s*18px/);
  assert.match(html, /拖動/);
  const main = readFileSync(new URL('../desktop/main.mjs', import.meta.url), 'utf8');
  assert.match(main, /octa:browser-drag-start/);
  assert.match(main, /thumbAt/);
  assert.match(main, /setBorderRadius/);
});

test('a hidden browser does not take space', () => {
  const lay = embedFrames(1920, 1000, false);
  assert.equal(lay.mode, 'hidden');
  assert.equal(lay.main.width, 1920);
  assert.equal(lay.main.height, 1000);
  assert.equal(lay.page, null);
  assert.equal(lay.chrome, null);
});
