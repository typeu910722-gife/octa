// OCTA desktop (Electron). 4.0: everything runs and stays on this computer — the window always shows the local
// server's page. Users of the old cloud version get their data moved here once, on the first start (cloud-import.mjs).
import { app, BrowserWindow, WebContentsView, Tray, Menu, Notification, shell, nativeImage, dialog, ipcMain, screen, powerSaveBlocker, powerMonitor, session } from 'electron';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, appendFileSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync, createWriteStream } from 'node:fs';
import { startServer } from './server.mjs';
import { cloudCaller, importStatus, migrateConfig } from './cloud-import.mjs';
import { WAKE_COMMANDS, startCdpBridge } from './cdp-bridge.mjs';
import { backupRootFrom, doneText, finishPendingWipe, makeBackup, planWipe, wipeTargets, writeMarker } from './wipe.mjs';
import { PAGE, THUMB_RADIUS, controlStage, embedFrames, freshOpen, isBlankUrl, onAnyScreen, parkSpot, phoneInput, resizeBox, scrollScript, shieldFor, sidebarBox, thumbBox, userFlagScript, wheelDelta } from './embed-layout.mjs';
import { BRAVE_RELEASE, CHROME_CATALOG, ENGINE_IDS, ENGINE_LABEL, SAME_TO_CDP, braveDownload, chromeDownload, clientHintHeaders, edgeDownload, electronCookie, firefoxDownload, googleRefused, googleSignInPage, googleWorkspacePage, hostPlatform, identity, pageNeedsAttention, pageUnsupported } from './browser-catalog.mjs';

// ---------- updates (GitHub Releases) ----------
const { autoUpdater } = createRequire(import.meta.url)('electron-updater');
let upd = { state: 'idle', version: '', percent: 0, error: '' };   // idle | checking | available | none | downloading | ready | error
function setUpd(u) { upd = { ...upd, ...u }; win?.webContents.send('octa:update', upd); }
autoUpdater.autoDownload = false;                 // ask first: the user presses 更新
autoUpdater.autoInstallOnAppQuit = false;   // install only when the user presses the button (after freeing the install folder)
autoUpdater.on('checking-for-update', () => setUpd({ state: 'checking', error: '' }));
const plainNotes = n => (Array.isArray(n) ? n.map(x => x.note || '').join('\n') : String(n || '')).replace(/<\/(p|li|h\d)>/g, '\n').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\n{3,}/g, '\n\n').trim().slice(0, 3000);
autoUpdater.on('update-available', i => setUpd({ state: 'available', version: i.version, notes: plainNotes(i.releaseNotes), date: i.releaseDate || '' }));
autoUpdater.on('update-not-available', () => setUpd({ state: 'none' }));
autoUpdater.on('download-progress', p => setUpd({ state: 'downloading', percent: Math.round(p.percent || 0) }));
autoUpdater.on('update-downloaded', i => setUpd({ state: 'ready', version: i.version, percent: 100, admin: needsAdmin() }));
autoUpdater.on('error', e => { setUpd({ state: 'error', error: String(e?.message || e).slice(0, 300) }); });
function checkUpdates() { if (app.isPackaged) autoUpdater.checkForUpdates().catch(() => { }); }

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const unpacked = p => p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }   // already running: the first copy shows its window
app.setAppUserModelId('tw.yzproject.octa');
// 4.5 清除這台電腦的資料: what the wipe could not delete while OCTA was running goes now, before anything is opened
let wipedNow = null;
try { wipedNow = finishPendingWipe(app.getPath('userData')); } catch (e) { wipedNow = { marker: {}, left: [], error: String(e) }; }

let win = null, tray = null, server = null, quitting = false, runner = null;
const LOGIN_ARGS = ['--hidden'];
const hiddenStart = process.argv.includes('--hidden') || app.getLoginItemSettings({ args: LOGIN_ARGS }).wasOpenedAtLogin;
const icon = () => nativeImage.createFromPath(join(here, 'icon.png'));
// Started from the shortcut, OCTA's working folder is its install folder, and every program it starts (the bots' Chrome,
// cloudflared, AI tools) inherits it: Windows then can't remove that folder and updates fail. Work from the home folder.
try { process.chdir(app.getPath('home')); } catch { }

// keep data from installs made before the rename
const oldDir = join(app.getPath('appData'), 'E·BOT');
const dataDir = existsSync(join(oldDir, 'ebot.sqlite')) && !existsSync(join(app.getPath('userData'), 'ebot.sqlite')) ? oldDir : app.getPath('userData');
const cfgFile = join(dataDir, 'desktop.json');
const readCfg = () => { try { return JSON.parse(readFileSync(cfgFile, 'utf8')); } catch { return {}; } };
let wipeDone = false;   // after the wipe nothing may write the old settings back
const writeCfg = c => { if (wipeDone) return; try { mkdirSync(dataDir, { recursive: true }); writeFileSync(cfgFile, JSON.stringify(c, null, 2)); } catch { } };
let cfg = readCfg();
// the wipe left autostart as the user had chosen it: keep that choice (otherwise it would be switched back on)
if (wipedNow?.marker?.keep?.autostartChosen && !cfg.autostartChosen) { cfg = { ...cfg, autostartChosen: true }; writeCfg(cfg); }
// 4.0 is local only: 雲端模式 / 主機模式 settings from 3.x are dropped; a cloud account's data is imported once (below)
let pendingImport = '';
if (cfg.mode !== 'local' || cfg.runnerToken || cfg.hostKey) {
  const m = migrateConfig(cfg);
  cfg = m.cfg; pendingImport = m.pending;
  writeCfg(cfg);
}

// anything that goes wrong is written to octa-error.log and shown, instead of failing silently
function logError(where, e) {
  const line = `[${new Date().toISOString()}] ${where}: ${e?.stack || e}\n`;
  try { mkdirSync(dataDir, { recursive: true }); appendFileSync(join(dataDir, 'octa-error.log'), line); } catch { }
  return line;
}
process.on('uncaughtException', e => logError('uncaught', e));
process.on('unhandledRejection', e => logError('unhandled', e));

// ---------- window ----------
const progress = (p, t) => win?.webContents.executeJavaScript(`window.setP&&setP(${p},${JSON.stringify(t || '')})`).catch(() => { });

function placeWindow() {
  const area = screen.getPrimaryDisplay().workArea;
  const saved = cfg.win;
  let b = null;
  if (saved?.width && saved?.height) {
    const onScreen = screen.getAllDisplays().some(d => {
      const a = d.workArea;
      return saved.x + Math.min(saved.width, 200) > a.x && saved.x < a.x + a.width - 40 && saved.y > a.y - 8 && saved.y < a.y + a.height - 40;
    });
    if (onScreen) b = saved;
  }
  if (!b) {
    const width = Math.max(960, Math.min(area.width, Math.round(area.width * 0.96)));
    const height = Math.max(640, Math.min(area.height, Math.round(area.height * 0.94)));
    b = { x: area.x + Math.max(0, Math.round((area.width - width) / 2)), y: area.y + Math.max(0, Math.round((area.height - height) / 2)), width, height };
  }
  win.setBounds({
    x: Math.round(b.x), y: Math.round(b.y),
    width: Math.max(380, Math.min(Math.round(b.width), area.width)),
    height: Math.max(520, Math.min(Math.round(b.height), area.height))
  });
  if (b.max) win.maximize();
}
let winSave;
function saveWin() {
  if (!win || win.isDestroyed()) return;
  clearTimeout(winSave);
  winSave = setTimeout(() => {
    if (!win || win.isDestroyed()) return;
    const b = win.getNormalBounds();
    cfg = { ...cfg, win: { x: b.x, y: b.y, width: b.width, height: b.height, max: win.isMaximized() } };
    writeCfg(cfg);
  }, 400);
}
function createWindow() {
  const area = screen.getPrimaryDisplay().workArea;
  win = new BrowserWindow({
    width: Math.min(1280, area.width), height: Math.min(800, area.height), minWidth: 380, minHeight: 520,
    backgroundColor: '#12110e', title: 'OCTA｜奧克塔', icon: icon(), show: false,
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true, preload: join(here, 'preload.cjs'), backgroundThrottling: false }
  });
  placeWindow();
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('blob:')) return { action: 'allow' };
    shell.openExternal(url); return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {   // stay inside OCTA; other links open in the browser
    if (!(server && url.startsWith(server.url)) && !url.startsWith('file:')) { e.preventDefault(); shell.openExternal(url); }
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMain) => {
    if (!isMain || code === -3) return;   // -3: navigation replaced by another one
    logError('load', `${code} ${desc} ${url}`);
  });
  win.on('close', e => {
    if (quitting) return;
    e.preventDefault(); win.hide(); setAway('hidden', true);   // ('hide' is not emitted everywhere)
    if (!cfg.toldTray) {   // the first time: say the bots keep working in the background
      cfg = { ...cfg, toldTray: true }; writeCfg(cfg);
      new Notification({ title: 'OCTA 還在背景工作', body: '機器人會繼續執行。點右下角章魚圖示可以打開，要完全關閉請在圖示上按右鍵 →「結束」。', icon: icon() }).on('click', showWindow).show();
    }
  });
  // the window is gone: pages that were in it would stop drawing, so they move to their own waiting windows
  win.on('closed', () => { win = null; for (const bucket of embeds.values()) { bucket.docked = false; stopThumbs(bucket); holdOffscreen(bucket); } });
  win.on('resize', () => { layoutEmbed(); saveWin(); });
  win.on('move', saveWin);
  win.on('maximize', () => { layoutEmbed(); saveWin(); });
  const away = (k, v) => () => setAway(k, v);
  win.on('hide', away('hidden', true)); win.on('show', away('hidden', false));
  win.on('minimize', away('min', true)); win.on('restore', away('min', false));
  win.on('unmaximize', () => { layoutEmbed(); saveWin(); });
  win.once('ready-to-show', () => { if (!hiddenStart) { win.show(); win.focus(); } });
}
function showWindow() {
  if (!win) { createWindow(); loadMain(); }
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
  setAway('hidden', false);
}
const showSplash = () => win.loadFile(join(here, 'splash.html'));

// The page is on this computer, but opening it still needs a free local port. When another program uses up the
// computer's connections (thousands left waiting to close), Chromium fails with ERR_ADDRESS_IN_USE: wait and try
// again instead of giving up with an error box.
const TRANSIENT_LOAD = /ERR_ADDRESS_IN_USE|ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_TIMED_OUT|ERR_INSUFFICIENT_RESOURCES|ERR_NETWORK_CHANGED/;
export function loadRetryDelay(tries) { return Math.min(30000, 1000 * 2 ** Math.min(tries, 5)); }
async function loadLocal() {
  for (let tries = 0; ; tries++) {
    if (!win || win.isDestroyed()) return;   // the window was closed while waiting: nothing to load into
    try { await win.loadURL(server.url); return; }
    catch (e) {
      if (!TRANSIENT_LOAD.test(String(e)) || tries >= 12 || !win || win.isDestroyed()) throw e;
      logError('load-retry', e);
      progress(60, /ADDRESS_IN_USE|INSUFFICIENT/.test(String(e)) ? '電腦的網路連線被其他程式占滿了，等一下再試…' : '等本機服務準備好…');
      await new Promise(r => setTimeout(r, loadRetryDelay(tries)));
    }
  }
}
const loadMain = () => loadLocal();

// ---------- in-app Chromium (the bot's browser lives in the OCTA window, not a separate Chrome) ----------
const embeds = new Map();
let embedSeq = 0;
let focusBotId = '';
// a dialog or menu is open in the chat page: the browser views sit above the page, so they step aside
let covered = false;
let pipSent = 'null';
// 4.1: the page docks the open bot's browser in its work panel (瀏覽器 tab). Once it has said so, the floating
// thumbnail / side panel are not used: the browser shows only in that rectangle, and is hidden otherwise.
let docking = false;
let dockRect = null;
let dockTheme = 'dark';
const thumbDot = () => !!cfg.thumbDot;
function fitView(view, bounds, visible) {
  if (!view || !bounds) return;
  try { view.setBounds(bounds); } catch { }
  try { view.setVisible(visible); } catch { }
}
// 4.8.1: where a bot's pages wait while they are not on screen. It used to be one hidden window per bot: a hidden window
// does not draw, so its pages got no animation frames (about 1 a second at best), screenshots took seconds or never came
// back and loaders that wait for a painted frame (Gmail's) never finished; a tab under another tab got none at all.
// Now every page has its own real, shown window, placed past the top-left corner of every screen (embed-layout parkSpot,
// side by side so none covers another), without a taskbar button, Alt+Tab entry or focus.
const displaysNow = () => { try { return screen.getAllDisplays(); } catch { return []; } };
const parkSlots = [];   // slot → window
function parkHost(host) {
  if (!host || host.isDestroyed()) return;
  const spot = parkSpot(displaysNow(), PAGE, Math.max(0, parkSlots.indexOf(host)));
  try {
    const b = host.getBounds();
    if (b.x !== spot.x || b.y !== spot.y || b.width !== PAGE.width || b.height !== PAGE.height || onAnyScreen(b, displaysNow())) host.setBounds({ ...spot, width: PAGE.width, height: PAGE.height });
  } catch { }
  try { if (host.isMinimized()) host.restore(); } catch { }
  try { if (!host.isVisible()) host.showInactive(); } catch { }
}
function hostFor(bucket, view) {
  let host = bucket.hosts.get(view);
  if (host && !host.isDestroyed()) return host;
  let slot = parkSlots.findIndex(w => !w || w.isDestroyed());
  if (slot < 0) slot = parkSlots.length;
  host = new BrowserWindow({
    show: false, ...parkSpot(displaysNow(), PAGE, slot), width: PAGE.width, height: PAGE.height,
    skipTaskbar: true, focusable: false, frame: false, thickFrame: false, hasShadow: false,
    minimizable: false, maximizable: false, movable: false, resizable: false, enableLargerThanScreen: true,
    ...(process.platform === 'win32' ? { type: 'toolbar' } : {}),   // a tool window: no Alt+Tab entry
    title: 'OCTA', backgroundColor: '#ffffff',
    webPreferences: { backgroundThrottling: false }
  });
  parkSlots[slot] = host;
  bucket.hosts.set(view, host);
  try { host.setMenuBarVisibility(false); } catch { }
  try { host.webContents.setBackgroundThrottling(false); } catch { }
  const again = () => setTimeout(() => { if (embeds.has(bucket.port) && bucket.hosts.get(view) === host) parkHost(host); }, 50);
  host.on('minimize', again);
  host.on('hide', again);
  host.on('closed', () => { const i = parkSlots.indexOf(host); if (i >= 0) parkSlots[i] = null; if (bucket.hosts.get(view) === host) bucket.hosts.delete(view); });
  parkHost(host);
  return host;
}
function unhost(bucket, view) {
  const host = bucket.hosts.get(view);
  try { if (host && !host.isDestroyed()) host.contentView.removeChildView(view); } catch { }
}
function dropHost(bucket, view) {
  const host = bucket.hosts.get(view);
  bucket.hosts.delete(view);
  try { if (host && !host.isDestroyed()) { host.contentView.removeChildView(view); host.destroy(); } } catch { }
}
function parkView(bucket, view) {
  const host = hostFor(bucket, view);
  try { if (win && !win.isDestroyed()) win.contentView.removeChildView(view); } catch { }
  try { if (!host.contentView.children.includes(view)) host.contentView.addChildView(view); } catch { }
  fitView(view, { x: 0, y: 0, width: PAGE.width, height: PAGE.height }, true);
}
function shownUrl(wc) {
  if (!wc || wc.isDestroyed()) return '';
  const u = wc.getURL() || '';
  return isBlankUrl(u) ? '' : u;
}
function canGoBack(wc) {
  if (!wc || wc.isDestroyed()) return false;
  try { return !!wc.navigationHistory?.canGoBack?.(); } catch { return false; }
}
function tabTitle(wc) {
  if (!wc || wc.isDestroyed()) return '新分頁';
  return (wc.getTitle() || '').replace(/^【[^】]*】/, '').trim().slice(0, 18) || '新分頁';
}
function sendFrame(bucket, extra) {
  const wc = bucket.chrome?.webContents;
  if (!wc || wc.isDestroyed()) return;
  const page = bucket.active?.webContents;
  const tabs = bucket.tabs.map((v, i) => ({ i, on: v === bucket.active, title: tabTitle(v.webContents) }));
  const engines = ENGINE_IDS.map(id => ({ id, label: ENGINE_LABEL[id], on: id === (bucket.engine || 'chrome'), state: bucket.downloading === id ? 'down' : (ownedExe(id) ? 'ready' : 'none') }));
  wc.send('octa:browser-frame', { name: bucket.name, mode: bucket.docked ? 'dock' : bucket.shown || 'thumb', theme: dockTheme, dot: thumbDot(), control: !!bucket.control, url: shownUrl(page), canBack: canGoBack(page), tabs, engines, blocked: !!bucket.blocked, downloading: bucket.downloading || '', percent: bucket.percent || 0, error: bucket.engineError || '', ...extra });
}
function roundChrome(view, radius, solid) {
  if (!view) return;
  try { view.setBackgroundColor(solid ? '#1c1814' : '#00000000'); } catch { }
  try { view.setBorderRadius?.(Math.max(0, radius || 0)); } catch { }
}
function savedThumbAt() {
  const at = cfg.thumbAt;
  return at && Number.isFinite(+at.x) && Number.isFinite(+at.y) ? { x: +at.x, y: +at.y } : null;
}
function savedPlace(botId) {
  const at = botId && cfg.browserAt?.[botId];
  return at && typeof at === 'object' ? at : {};
}
function rememberPlace(bucket) {
  if (!bucket?.botId) return;
  const all = { ...(cfg.browserAt || {}) };
  all[bucket.botId] = { thumb: bucket.thumbAt || null, open: bucket.openAt || null };
  cfg = { ...cfg, browserAt: all, thumbAt: bucket.thumbAt || cfg.thumbAt };
  writeCfg(cfg);
}
function onScreen(bucket) {
  return !!(bucket?.shown && focusBotId && bucket.botId === focusBotId);
}
function stopThumbs(bucket) { clearTimeout(bucket.thumbTimer); bucket.thumbTimer = null; }
function startThumbs(bucket) {
  stopThumbs(bucket);
  const tick = async () => {
    if (bucket.shown !== 'thumb' || thumbDot() || !bucket.active?.webContents || bucket.active.webContents.isDestroyed()) return;
    try {
      const shot = await bucket.active.webContents.debugger.sendCommand('Page.captureScreenshot', { format: 'jpeg', quality: 45 });
      sendFrame(bucket, { mode: 'thumb', jpeg: shot.data });
    } catch { sendFrame(bucket, { mode: 'thumb' }); }
    if (bucket.shown === 'thumb') bucket.thumbTimer = setTimeout(tick, 900);
  };
  bucket.thumbTimer = setTimeout(tick, 400);
}
function detachChrome(bucket) {
  stopThumbs(bucket);
  try { if (win && !win.isDestroyed() && bucket.chrome) win.contentView.removeChildView(bucket.chrome); } catch { }
  dropShield(bucket);
}
// ---- watch only / take control ----
// Watch only (the default): a clear view lies over the page. Mouse, wheel and keys from the person land on it,
// not on the site. The bot is unaffected: its Input.dispatch* commands go through the page's own debugger
// straight into that page's renderer, which no view on top can intercept.
function shieldOf(bucket) {
  if (bucket.shield && !bucket.shield.webContents.isDestroyed()) return bucket.shield;
  const shield = new WebContentsView({ webPreferences: { preload: join(here, 'browser-preload.cjs'), contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  try { shield.setBackgroundColor('#00000000'); } catch { }
  shield.webContents.loadFile(join(here, 'browser-shield.html')).catch(() => { });
  bucket.shield = shield;
  return shield;
}
function dropShield(bucket) {
  try { if (win && !win.isDestroyed() && bucket.shield) win.contentView.removeChildView(bucket.shield); } catch { }
}
function placeShield(bucket, rect) {
  if (!rect || !win || win.isDestroyed()) { dropShield(bucket); return; }
  const shield = shieldOf(bucket);
  raiseView(shield);
  fitView(shield, rect, true);
  try { shield.setBorderRadius?.(12); } catch { }
}
// tell the page's tag script whether the mouse it sees is the person's (control) or only the bot's
function flagPage(bucket, wc) {
  if (!wc || wc.isDestroyed()) return;
  wc.executeJavaScript(userFlagScript(!!bucket.control)).catch(() => { });
}
function shieldBucket(sender) {
  for (const [, bucket] of embeds) if (bucket.shield?.webContents === sender) return bucket;
  return null;
}
// on = take control (the person clicks, types, signs in; the bot pauses), off = back to watch only (the bot carries on).
// relay: also tell the chat page, which records the hand-off (接手 / 繼續) for the bot.
function setControl(bucket, on, relay) {
  const next = !!on;
  if (!bucket) return false;
  const changed = next !== !!bucket.control;
  bucket.control = next;
  if (changed) bucket.controlAt = Date.now();
  for (const v of bucket.tabs) flagPage(bucket, v.webContents);
  layoutEmbed();
  const page = bucket.active?.webContents;
  try {
    if (next && bucket.shown === 'open' && page && !page.isDestroyed()) page.focus();
    else if (!next && page && !page.isDestroyed() && page.isFocused?.()) bucket.shield?.webContents.focus();   // keys you were typing stop reaching the site
  } catch { }
  sendFrame(bucket, {});
  if (relay && changed && win && !win.isDestroyed()) win.webContents.send('octa:stage', { bot: bucket.botId, act: controlStage(next) });
  return next;
}
function raiseView(view) {
  if (!view || !win || win.isDestroyed()) return;
  try { win.contentView.removeChildView(view); } catch { }
  try { win.contentView.addChildView(view); } catch { }
}
function placeBucket(bucket, frames) {
  const page = (frames.mode === 'open' || frames.mode === 'dock') && frames.page ? bucket.active : null;
  for (const v of bucket.tabs) {
    if (v === page) continue;
    parkView(bucket, v);
  }
  if (frames.chrome && bucket.chrome && win) {
    // put the panel back above the chat every time, so a reload cannot cover it
    raiseView(bucket.chrome);
    fitView(bucket.chrome, frames.chrome, true);
    roundChrome(bucket.chrome, frames.mode === 'dock' ? 12 : frames.dot ? Math.floor(frames.chrome.width / 2) : THUMB_RADIUS, frames.mode !== 'thumb');
  }
  // the page sits above the panel frame; the frame's edges stay outside the page and can still be grabbed
  if (page && frames.page && win) {
    unhost(bucket, page);
    raiseView(page);
    fitView(page, frames.page, true);
    roundChrome(page, frames.mode === 'dock' ? 8 : 12, true);
  }
  // watch only: the shield goes on top of the page, exactly over it
  placeShield(bucket, page ? frames.shield : null);
}
function holdOffscreen(bucket) {
  detachChrome(bucket);
  for (const v of bucket.tabs) parkView(bucket, v);
}
// the chat page keeps its last messages clear of the corner card
function tellPip(pip) {
  const next = JSON.stringify(pip || null);
  if (next === pipSent || !win || win.isDestroyed()) return;
  pipSent = next;
  try { win.webContents.send('octa:pip', pip || null); } catch { }
}
// the work panel's 瀏覽器 tab: only the bot shown there, exactly in its rectangle; every other browser is parked
function layoutDocked(w, h) {
  const zoom = win.webContents.getZoomFactor?.() || 1;
  for (const bucket of embeds.values()) {
    const frames = bucket.shown && bucket.botId === focusBotId && dockRect   // 收到背景 (not shown) keeps it out of the tab
      ? embedFrames(w, h, 'dock', dockRect, { tabs: bucket.tabs.length, control: !!bucket.control, covered, zoom })
      : { mode: 'hidden' };
    const was = !!bucket.docked;
    bucket.docked = frames.mode === 'dock';
    stopThumbs(bucket);
    if (!bucket.docked) { holdOffscreen(bucket); continue; }
    placeBucket(bucket, frames);
    if (!was) sendFrame(bucket, {});
  }
  tellPip(null);
}
// OCTA's own window is in the tray or minimised: it no longer draws, so a page docked in it would stop too
// (its own events count first: on some systems isVisible() still says true right after hide())
let winAway = { hidden: false, min: false };
function setAway(k, v) {
  if (!win || win.isDestroyed()) return;
  winAway = { ...winAway, [k]: v };
  if (k === 'hidden' && !v) winAway.min = win.isMinimized();
  layoutEmbed();
  setTimeout(layoutEmbed, 300);
}
const winDrawing = () => !!(win && !win.isDestroyed() && !winAway.hidden && !winAway.min && win.isVisible() && !win.isMinimized());
function layoutEmbed() {
  if (!win || win.isDestroyed()) return;
  if (!winDrawing()) {
    for (const bucket of embeds.values()) { bucket.docked = false; stopThumbs(bucket); holdOffscreen(bucket); }
    return;
  }
  const [w, h] = win.getContentSize();
  const main = win.contentView.children.find(v => v.webContents === win.webContents);
  fitView(main, { x: 0, y: 0, width: w, height: h }, true);
  if (docking) { layoutDocked(w, h); return; }
  let pip = null;
  for (const bucket of embeds.values()) {
    if (!onScreen(bucket)) {
      stopThumbs(bucket);
      holdOffscreen(bucket);
      continue;
    }
    if (bucket.dragging && bucket.panelBox) {
      placeDrag(bucket);
      pip = JSON.parse(pipSent);
      continue;
    }
    if (bucket.shown === 'open') bucket.openAt = freshOpen(bucket.openAt);
    const at = bucket.shown === 'open' ? bucket.openAt : (bucket.thumbAt || savedThumbAt());
    const frames = embedFrames(w, h, bucket.shown, at, { tabs: bucket.tabs.length, dot: thumbDot(), control: !!bucket.control, covered });
    if (frames.mode === 'hidden') {
      stopThumbs(bucket);
      holdOffscreen(bucket);
      continue;
    }
    if (frames.dot) stopThumbs(bucket);
    else if (bucket.shown === 'thumb' && !bucket.thumbTimer) startThumbs(bucket);
    placeBucket(bucket, frames);
    if (frames.chrome) pip = { mode: frames.mode, dot: !!frames.dot, ...frames.chrome };
  }
  tellPip(pip);
}
function versionFor(engine) {
  // Brave's release number is not a Chrome version. Chrome and Edge use this Chromium's own version
  // so the page is not claiming a build it is not. Firefox uses the portable build's version.
  if (engine === 'firefox') return String(cfg.browserGot?.firefox?.version || '156.0');
  return process.versions.chrome || '131.0.6778.86';
}
function ownedExe(engine) {
  const exe = cfg.browserGot?.[engine]?.exe;
  return exe && existsSync(exe) ? exe : '';
}
async function applyIdentity(wc, engine) {
  if (!wc || wc.isDestroyed()) return;
  const id = identity(engine || 'chrome', versionFor(engine || 'chrome'), process.platform, process.arch);
  try { wc.setUserAgent(id.userAgent); } catch { }
  try {
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
    const params = { userAgent: id.userAgent, acceptLanguage: 'zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7', platform: id.platform };
    if (id.metadata) params.userAgentMetadata = id.metadata;
    // a slow override must not hold the browser off the screen
    await Promise.race([
      wc.debugger.sendCommand('Emulation.setUserAgentOverride', params),
      new Promise(r => setTimeout(r, 400))
    ]);
    // a cross-site frame (Google's sign-in uses them) is its own target: without this it still says Electron
    wc.__octaUa = params;
    if (!wc.__octaFrames) {
      wc.__octaFrames = true;
      wc.debugger.on('message', (_e, method, ev) => { if (method === 'Target.attachedToTarget') void dressChild(wc, ev); });
    }
    await Promise.race([
      wc.debugger.sendCommand('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }),
      new Promise(r => setTimeout(r, 400))
    ]);
  } catch (e) { logError('ua', e); }
}
// a frame or worker that just started (paused until we let it run): same identity, then resume it
async function dressChild(wc, ev) {
  const sid = ev?.sessionId, type = ev?.targetInfo?.type;
  if (!sid || wc.isDestroyed()) return;
  const send = (method, params) => Promise.race([wc.debugger.sendCommand(method, params, sid), new Promise(r => setTimeout(r, 400))]).catch(() => { });
  try {
    const params = wc.__octaUa;
    if (params && (type === 'iframe' || type === 'page')) {
      await send('Emulation.setUserAgentOverride', params);
      await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });   // frames inside that frame
    } else if (params && /worker/.test(String(type))) await send('Network.setUserAgentOverride', params);
  } finally { await send('Runtime.runIfWaitingForDebugger', {}); }
}
// CDP cookies ↔ Electron cookies: electronCookie() in browser-catalog.mjs
// sites often keep the login in a session cookie; keep those across restarts so the bot stays signed in
function keepLogins(ses) {
  if (!ses || ses.__octaKeep) return;
  ses.__octaKeep = true;
  ses.cookies.on('changed', (_e, c, _cause, removed) => {
    if (removed || !c.session || !c.name) return;
    const kept = electronCookie({ ...c, expires: 0 });
    if (kept) ses.cookies.set(kept).catch(() => { });
  });
}
function dressSession(ses, bucket) {
  if (!ses || ses.__octaEngine) return;
  ses.__octaEngine = true;
  try { ses.setUserAgent(identity(bucket.engine || 'chrome', versionFor(bucket.engine || 'chrome'), process.platform, process.arch).userAgent, 'zh-TW,zh,en-US,en'); } catch { }
  ses.webRequest.onBeforeSendHeaders((details, cb) => {
    try {
      const id = identity(bucket.engine || 'chrome', versionFor(bucket.engine || 'chrome'), process.platform, process.arch);
      const set = (name, value) => {
        const key = Object.keys(details.requestHeaders).find(k => k.toLowerCase() === name) || name;
        if (value == null) delete details.requestHeaders[key];
        else details.requestHeaders[key] = value;
      };
      set('user-agent', id.userAgent);
      for (const [name, value] of Object.entries(clientHintHeaders(id, details.requestHeaders))) set(name, value);
    } catch { }
    cb({ requestHeaders: details.requestHeaders });
  });
}
function launchOwned(exe, bucket, url) {
  const profile = join(dataDir, 'browsers', 'profiles', String(bucket.botId || 'bot').replace(/[^\w-]/g, '').slice(0, 40), bucket.engine || 'chrome');
  try { mkdirSync(profile, { recursive: true }); } catch { }
  // Firefox keeps its own profile with -profile. The others are Chromium and use --user-data-dir.
  const args = bucket.engine === 'firefox'
    ? ['-profile', profile, '-no-remote', '-new-window', url]
    : ['--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check', '--new-window', url];
  const child = spawn(exe, args, { detached: true, stdio: 'ignore' });
  child.unref();
}
async function notePage(wc, bucket) {
  if (!wc || wc.isDestroyed() || bucket.active?.webContents !== wc) return;
  let text = '';
  try { text = await wc.executeJavaScript('document.body?document.body.innerText.slice(0,4000):""'); } catch { return; }
  bucket.blocked = pageNeedsAttention(text);
  const url = shownUrl(wc);
  googleBlocked(bucket, wc.getURL(), text);
  if (pageUnsupported(text) && url && !bucket.handed) {
    const exe = ownedExe(bucket.engine || 'chrome');
    if (exe) {
      bucket.handed = true;
      launchOwned(exe, bucket, url);
      bucket.engineError = '已改用 OCTA 下載的瀏覽器開啟，登入只留在 OCTA';
    }
  }
  sendFrame(bucket, {});
}
// Google's sign-in inside OCTA: Google refuses it ("這個瀏覽器或應用程式可能不安全"), and a sign-in copied in from Chrome
// logs out again (Google binds it to the browser). 4.7: the moment this browser lands on Google's sign-in page (or a
// refusal), the bot moves to its own real Chrome window (its own profile, driven over CDP) and stays there — no
// automatic way back, no sign-in loop in here. 「改回內建瀏覽器」 by hand still works (Google's cookies are not copied).
function googleBlocked(bucket, url, text = '') {
  // 4.8.1: also Gmail, Drive, Docs… when already signed in here: they hang on their loading screen in this browser
  if (!googleRefused(url, text) && !googleSignInPage(url) && !googleWorkspacePage(url)) return;
  if (!bucket.botId || bucket.toChrome || typeof embedApi.onGoogle !== 'function') return;
  bucket.toChrome = true;
  const again = (+cfg.embedBack?.[bucket.botId] || 0) > 0;   // it was in Chrome before and came back by hand
  const stay = true;
  cfg = { ...cfg, realChrome: { ...(cfg.realChrome || {}), [bucket.botId]: { at: Date.now(), why: 'google', stay: true } } };
  writeCfg(cfg);
  bucket.engineError = googleWorkspacePage(url) ? 'Google 的服務（Gmail 等）改在這個機器人的 Chrome 視窗開啟…' : 'Google 不讓內嵌瀏覽器登入，正在改用 Chrome 視窗…';
  sendFrame(bucket, {});
  setTimeout(() => Promise.resolve(embedApi.onGoogle(bucket.botId, url, { again, stay })).catch(e => logError('google-chrome', e)), 300);
}
// 4.7: the runner moves a bot to its Chrome window before Google work (Gmail…), so it never meets the sign-in in here
function useChrome(botId) {
  const id = String(botId || '');
  if (!id) return false;
  cfg = { ...cfg, realChrome: { ...(cfg.realChrome || {}), [id]: { at: Date.now(), why: 'google', stay: true } } };
  writeCfg(cfg);
  return true;
}
// the bot's browser is back in OCTA (by hand): forget the Chrome window, remember when
function useEmbedded(botId) {
  const id = String(botId || '');
  if (!id) return false;
  const rc = { ...(cfg.realChrome || {}) };
  delete rc[id];
  cfg = { ...cfg, realChrome: rc, embedBack: { ...(cfg.embedBack || {}), [id]: Date.now() } };
  writeCfg(cfg);
  return true;
}
function browserMode(botId) {
  const v = cfg.realChrome?.[String(botId || '')];
  if (!v) return { chrome: false };
  // true: set by 3.0.37–3.3.x, always because of Google's sign-in
  return { chrome: true, why: v === true ? 'google' : (v.why || 'google'), at: v === true ? 0 : (+v.at || 0), stay: !!v?.stay };
}
// 4.8.1: the page acts as the active, focused tab whatever the person is looking at (see cdp-bridge WAKE_COMMANDS)
function wakePage(wc) {
  if (!wc || wc.isDestroyed()) return;
  try { wc.setBackgroundThrottling(false); } catch { }
  try { if (!wc.debugger.isAttached()) return; } catch { return; }
  for (const [method, params] of WAKE_COMMANDS) wc.debugger.sendCommand(method, params).catch(() => { });
}
// the page's debugger is how the bot works the page: if it comes off (the renderer was replaced, DevTools took it), put it
// back at once — otherwise every command of the bot fails until OCTA restarts
async function reattach(wc, bucket) {
  if (!wc || wc.isDestroyed() || !embeds.has(bucket.port)) return false;
  try { if (!wc.debugger.isAttached()) wc.debugger.attach('1.3'); } catch (e) { if (!/already/i.test(String(e))) { logError('debugger', e); return false; } }
  await applyIdentity(wc, bucket.engine || 'chrome');
  wakePage(wc);
  return true;
}
async function hookPage(wc, id, bucket) {
  try { if (!wc.debugger.isAttached()) wc.debugger.attach('1.3'); } catch (e) { if (!/already/i.test(String(e))) logError('debugger', e); }
  await applyIdentity(wc, bucket.engine || 'chrome');
  wakePage(wc);
  wc.debugger.on('detach', (_e, reason) => setTimeout(() => {
    if (wc.isDestroyed() || !embeds.has(bucket.port)) return;   // the tab was closed: nothing to put back
    logError('debugger-detach', new Error(String(reason || '')));
    void reattach(wc, bucket);
  }, 300));
  // the page's renderer died (out of memory, a crash): load it again instead of leaving a dead tab under the bot
  wc.on('render-process-gone', (_e, d) => {
    if (d?.reason === 'clean-exit') return;
    logError('page-gone', new Error(String(d?.reason || '')));
    setTimeout(() => { if (!wc.isDestroyed()) { try { wc.reload(); } catch { } void reattach(wc, bucket); } }, 500);
  });
  wc.once('destroyed', () => { bucket.pages.delete(id); try { bucket.onGone?.(id); } catch { } });
  // events of the frames and workers OCTA attached to itself (sessionId set) are not the page's: Playwright never asked for them
  wc.debugger.on('message', (_e, method, params, sessionId) => {
    if (sessionId || method === 'Target.attachedToTarget' || method === 'Target.detachedFromTarget') return;
    bucket.onEvent?.(id, method, params);
  });
  bucket.pages.set(id, { wc });
  const ping = () => { if (bucket.active?.webContents === wc) sendFrame(bucket, {}); };
  wc.on('did-navigate', (_e, url) => { ping(); googleBlocked(bucket, url); });
  // 4.8.1: Gmail & co. go to the bot's Chrome window as soon as they are asked for, before they start loading here
  wc.on('did-start-navigation', (d, legacyUrl, _inPlace, legacyMain) => {
    const url = d?.url || legacyUrl, mainFrame = d?.isMainFrame ?? legacyMain;
    if (mainFrame && !d?.isSameDocument && googleWorkspacePage(url)) googleBlocked(bucket, url);
  });
  // Google's sign-in changes pages without loading: look at the text again once it has drawn
  wc.on('did-navigate-in-page', (_e, url, main) => { ping(); if (main !== false && /accounts\.google\.com/.test(url)) setTimeout(() => void notePage(wc, bucket), 1200); });
  wc.on('did-finish-load', () => { ping(); void notePage(wc, bucket); });
  // a new page while the person has control: its live cursor must not follow the person's mouse either
  wc.on('dom-ready', () => { if (bucket.control) flagPage(bucket, wc); });
  return id;
}
function pageId(bucket, wc) {
  return [...bucket.pages].find(([, p]) => p.wc === wc)?.[0];
}
function focusTab(bucket, view) {
  bucket.active = view;
  layoutEmbed();
  sendFrame(bucket, {});
}
function closeEmbedTab(bucket, index) {
  const tab = bucket.tabs[index];
  if (!tab || tab.webContents.isDestroyed()) return;
  const id = pageId(bucket, tab.webContents);
  if (bucket.tabs.length === 1) {
    tab.webContents.loadURL(bucket.splash || 'https://www.google.com/').catch(() => { });
    sendFrame(bucket, {});
    return;
  }
  bucket.tabs.splice(index, 1);
  if (id) bucket.pages.delete(id);
  if (bucket.active === tab) bucket.active = bucket.tabs[Math.max(0, index - 1)] || bucket.tabs[0];
  try { win?.contentView.removeChildView(tab); } catch { }
  dropHost(bucket, tab);
  try { tab.webContents.close(); } catch { }
  layoutEmbed();
  sendFrame(bucket, {});
}
function bindOpen(bucket, tab) {
  tab.webContents.setWindowOpenHandler(({ url }) => {
    focusTab(bucket, tab);
    tab.webContents.loadURL(url).catch(() => { });
    embedShow(bucket.port, true);
    return { action: 'deny' };
  });
}
async function addEmbedTab(bucket, url) {
  const tab = new WebContentsView({ webPreferences: bucket.prefs });
  const id = 'p' + (++embedSeq);
  bucket.tabs.push(tab);
  await hookPage(tab.webContents, id, bucket);
  bindOpen(bucket, tab);
  const home = url && !isBlankUrl(url) ? url : 'https://www.google.com/';
  tab.webContents.loadURL(home).catch(() => { });
  focusTab(bucket, tab);
  return { id, title: '', url: home };
}
function goTo(wc, raw) {
  let url = String(raw || '').trim();
  if (!wc || wc.isDestroyed()) return;
  if (!url) url = 'https://www.google.com/';
  else if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  wc.loadURL(url).catch(() => { });
}
// true keeps an open dock open and otherwise shows the thumbnail. 'open' and 'thumb' are explicit.
async function embedShow(port, show) {
  const bucket = embeds.get(port);
  if (!bucket || !win || win.isDestroyed()) return;
  const mode = show === 'open' || show === 'thumb' ? show : (show ? (bucket.shown === 'open' ? 'open' : 'thumb') : false);
  bucket.shown = mode || false;
  // an explicit open while no chat is focused still has to land on screen (not when docking: the page decides)
  if (mode && !focusBotId && !docking) focusBotId = bucket.botId;
  // docking: the page puts a dot on its 瀏覽器 tab
  if (mode && docking) try { win.webContents.send('octa:stage', { bot: bucket.botId, act: 'shown', mode }); } catch { }
  if (!mode) {
    detachChrome(bucket);
    for (const v of bucket.tabs) parkView(bucket, v);
  } else if (docking) stopThumbs(bucket);
  else if (mode === 'thumb') startThumbs(bucket);
  else { stopThumbs(bucket); sendFrame(bucket, { mode: 'open' }); }
  layoutEmbed();
}
async function embedStop(port) {
  const bucket = embeds.get(port);
  if (!bucket) return;
  try { await bucket.active?.webContents?.session?.cookies.flushStore(); } catch { }
  embeds.delete(port);
  detachChrome(bucket);
  try { if (bucket.chrome && !bucket.chrome.webContents.isDestroyed()) bucket.chrome.webContents.close(); } catch { }
  try { if (bucket.shield && !bucket.shield.webContents.isDestroyed()) bucket.shield.webContents.close(); } catch { }
  for (const v of bucket.tabs) {
    try { if (win && !win.isDestroyed()) win.contentView.removeChildView(v); } catch { }
    try { if (!v.webContents.isDestroyed()) v.webContents.close(); } catch { }
    dropHost(bucket, v);
  }
  for (const v of [...bucket.hidden]) dropHidden(bucket, v);
  for (const v of [...bucket.hosts.keys()]) dropHost(bucket, v);
  try { await bucket.bridge?.close(); } catch { }
  layoutEmbed();
}
function dropHidden(bucket, v) {
  bucket.hidden = bucket.hidden.filter(x => x !== v);
  try { if (!v.webContents.isDestroyed()) v.webContents.close(); } catch { }
  dropHost(bucket, v);
}
// 4.8.1 watchdog (the runner calls it before a job and whenever the bot's browser stops answering): every page drawn,
// attached and alive, the waiting window shown out of sight, the layout redone. false: no such browser (start it again)
async function embedRevive(port) {
  const bucket = embeds.get(port);
  if (!bucket) return false;
  for (const host of bucket.hosts.values()) parkHost(host);
  const all = [...bucket.tabs, ...bucket.hidden];
  for (const v of all) {
    const wc = v.webContents;
    if (!wc || wc.isDestroyed()) continue;
    try { if (wc.isCrashed()) wc.reload(); } catch { }
    await reattach(wc, bucket);
  }
  layoutEmbed();
  return true;
}
const usedPartitions = new Set();
async function embedStart(bot, port) {
  if (embeds.has(port)) return;
  if (!win || win.isDestroyed()) throw new Error('視窗還沒開');
  const partition = 'persist:octa-bot-' + String(bot.id || 'bot').replace(/[^\w-]/g, '').slice(0, 40);
  usedPartitions.add(partition);
  const prefs = { partition, contextIsolation: true, sandbox: true, backgroundThrottling: false };
  const view = new WebContentsView({ webPreferences: prefs });
  const name = String(bot.name || '機器人').replace(/[<&]/g, '');
  const chrome = new WebContentsView({ webPreferences: { preload: join(here, 'browser-preload.cjs'), contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  const place = savedPlace(String(bot.id || ''));
  const engine = ENGINE_IDS.includes(cfg.botEngine?.[String(bot.id || '')]) ? cfg.botEngine[String(bot.id || '')] : 'chrome';
  const bucket = { port, botId: String(bot.id || ''), prefs, tabs: [view], active: view, pages: new Map(), shown: false, onEvent: null, hidden: [], bridge: null, splash: '', chrome, name, hosts: new Map(), thumbTimer: null, thumbAt: place.thumb || savedThumbAt(), openAt: place.open || null, dragging: false, panelBox: null, engine, blocked: false, downloading: '', percent: 0, engineError: '', handed: false, engineJob: null, control: false, shield: null };
  dressSession(view.webContents.session, bucket);
  keepLogins(view.webContents.session);
  roundChrome(chrome, THUMB_RADIUS);
  await hookPage(view.webContents, 'p' + (++embedSeq), bucket);
  bindOpen(bucket, view);
  bucket.splash = 'https://www.google.com/';
  view.webContents.loadURL(bucket.splash).catch(() => { });
  chrome.webContents.loadFile(join(here, 'browser-chrome.html')).catch(() => { });
  chrome.webContents.on('did-finish-load', () => sendFrame(bucket, {}));
  parkView(bucket, view);
  const adapter = {
    list: () => [...bucket.pages].filter(([, p]) => !p.wc.isDestroyed()).map(([id, p]) => ({ id, title: p.wc.getTitle(), url: p.wc.getURL() || 'about:blank' })),
    bounds: () => {
      if (bucket.shown === 'open' || bucket.docked) {
        const b = bucket.active?.getBounds?.() || {};
        return { windowId: 1, bounds: { left: 0, top: 0, width: b.width > 50 ? b.width : PAGE.width, height: b.height > 50 ? b.height : PAGE.height, windowState: 'normal' } };
      }
      // parked at the working size, so a thumbnail does not make the bot's page collapse
      return { windowId: 1, bounds: { left: 0, top: 0, width: PAGE.width, height: PAGE.height, windowState: bucket.shown === 'thumb' ? 'normal' : 'minimized' } };
    },
    setBounds: bounds => embedShow(port, bounds?.windowState !== 'minimized' && !(bounds?.left < -5000)),
    version: () => ({ product: 'Chrome/' + versionFor('chrome'), userAgent: identity(bucket.engine || 'chrome', versionFor(bucket.engine || 'chrome'), process.platform, process.arch).userAgent }),
    onEvent: cb => { bucket.onEvent = cb; },
    async command(targetId, method, params) {
      const page = bucket.pages.get(targetId);
      if (!page || page.wc.isDestroyed()) throw new Error('找不到分頁');
      if (method === 'Storage.getCookies') {
        const cookies = await page.wc.session.cookies.get({});
        return { cookies: cookies.map(c => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly, expires: c.expirationDate || 0, ...(SAME_TO_CDP[c.sameSite] ? { sameSite: SAME_TO_CDP[c.sameSite] } : {}) })) };
      }
      if (method === 'Storage.setCookies') {
        for (const c of params.cookies || []) { const el = electronCookie(c); if (el) { try { await page.wc.session.cookies.set(el); } catch { } } }
        try { await page.wc.session.cookies.flushStore(); } catch { }
        return {};
      }
      return await page.wc.debugger.sendCommand(method, params || {});
    },
    async createTarget(params) {
      const url = params?.url || 'about:blank';
      if (params?.background) {
        // a page nobody sees (監看網頁): it still lives in the drawing window, under the tabs
        const id = 'p' + (++embedSeq);
        const hidden = new WebContentsView({ webPreferences: prefs });
        bucket.hidden.push(hidden);
        parkView(bucket, hidden);
        await hookPage(hidden.webContents, id, bucket);
        hidden.webContents.loadURL(url).catch(() => { });
        return { id, title: '', url };
      }
      const active = bucket.active;
      if (active && !active.webContents.isDestroyed() && isBlankUrl(active.webContents.getURL())) {
        const id = pageId(bucket, active.webContents);
        if (!isBlankUrl(url)) active.webContents.loadURL(url).catch(() => { });
        focusTab(bucket, active);
        await embedShow(port, true);
        return { id, title: active.webContents.getTitle(), url };
      }
      const made = await addEmbedTab(bucket, url);
      await embedShow(port, true);
      return made;
    },
    async closeTarget(id) {
      const page = bucket.pages.get(id);
      if (!page) return;
      const idx = bucket.tabs.findIndex(v => v.webContents === page.wc);
      if (idx >= 0) { closeEmbedTab(bucket, idx); return; }
      bucket.pages.delete(id);
      const hv = bucket.hidden.find(v => v.webContents === page.wc);
      if (hv) dropHidden(bucket, hv);
    },
    // the bot switched tabs (browser_tabs → bringToFront): the person's view follows it. It does not pop the browser
    // back up when the person put it away, and never takes the connection down
    activateTarget: async id => {
      const page = bucket.pages.get(id);
      const tab = page && bucket.tabs.find(v => v.webContents === page.wc);
      if (tab && tab !== bucket.active) focusTab(bucket, tab);
      wakePage(page?.wc);
    },
    onTargetAdded: cb => { bucket.onAdded = cb; },
    onTargetGone: cb => { bucket.onGone = cb; },
    close: () => embedStop(port)
  };
  bucket.bridge = await startCdpBridge(adapter, port);
  embeds.set(port, bucket);
}

// ---------- runner ----------
const embedApi = {
  start: embedStart, show: embedShow, stop: embedStop, revive: embedRevive, onGoogle: null,
  external: id => !!cfg.realChrome?.[String(id)],
  autoBack: () => false,   // 4.7: a bot in Chrome for Google stays there (its Google sign-in only works in that profile)
  useChrome, useEmbedded, mode: browserMode
};
async function bundledRunnerOpts() {
  const pwCli = unpacked(join(dirname(require.resolve('@playwright/mcp/package.json')), 'cli.js'));
  return {
    home: dataDir, pwCli, nodeBin: process.execPath, nodeEnv: { ELECTRON_RUN_AS_NODE: '1' }, getExtToken: () => cfg.extToken || '',
    getStore: () => server.getStore(), appVersion: app.getVersion(),
    embed: embedApi,
    log: (...a) => console.log(new Date().toLocaleTimeString(), ...a),
    onFatal: m => { logError('runner', m); stopRunner(); }
    // notifications are shown by the page itself (same as on phones and other computers)
  };
}
let runnerMod = null, browsersClosed = false;
// close the bots' browsers before OCTA exits (at most a few seconds)
async function closeBrowsers() {
  if (browsersClosed || !runnerMod?.closeAllBrowsers) return; browsersClosed = true;
  await Promise.race([runnerMod.closeAllBrowsers().catch(e => logError('close-browsers', e)), new Promise(r => setTimeout(r, 4000))]);
}
// 主機不斷線: while the bots work, Windows must not put the computer to sleep (that stopped every job and routine
// for hours). After waking up, or when the runner hasn't heard from the server for minutes, it starts over cleanly;
// the server then continues whatever was cut off and catches up the missed routines.
let awakeId = null, runnerWanted = false, restarting = false;
function keepAwake(on) {
  try {
    if (on && (awakeId === null || !powerSaveBlocker.isStarted(awakeId))) awakeId = powerSaveBlocker.start('prevent-app-suspension');
    if (!on && awakeId !== null) { powerSaveBlocker.stop(awakeId); awakeId = null; }
  } catch (e) { logError('keep-awake', e); }
}
async function restartRunner(why) {
  if (!runnerWanted || restarting || importing) return;   // a cloud import restarts the runner itself
  restarting = true;
  // 4.8.1: the bots' browsers stay open — an AI still working in one would otherwise lose it mid-step (「連不上 127.0.0.1:…」)
  try { logError('runner-restart', new Error(why)); stopRunner({ keepBrowsers: true }); await startLocalRunner(); }
  catch (e) { logError('runner-restart', e); }
  finally { restarting = false; }
}
setInterval(() => { if (runner && runnerMod?.pollAge && runnerMod.pollAge() > 4 * 60000) restartRunner('超過 4 分鐘沒有收到伺服器回應'); }, 60000);
app.whenReady().then(() => powerMonitor.on('resume', () => setTimeout(() => restartRunner('電腦從睡眠醒來'), 5000)));
function stopRunner(opts) { runner?.stop(opts); runner = null; keepAwake(false); }
async function startLocalRunner() {
  if (runner) return;
  const mod = await server.loadRunner(); runnerMod = mod;
  const { startRunner } = mod;
  runner = startRunner({ url: server.url, token: '', openInstall: k => server.installEngine(k), ...(await bundledRunnerOpts()), onStandby: sb => keepAwake(!sb) });   // a standby computer may sleep
  runnerWanted = true;
  keepAwake(true);
}

// only OCTA's own pages may use the bridge
const trusted = e => { const u = e.senderFrame?.url || ''; return (server && (u === server.url || u.startsWith(server.url + '/'))) || u.startsWith('file:'); };
function chromeBucket(sender) {
  for (const [, bucket] of embeds) if (bucket.chrome?.webContents === sender) return bucket;
  return null;
}
ipcMain.on('octa:browser-toggle', e => {
  if (!trusted(e)) return;
  const bucket = chromeBucket(e.sender);
  if (!bucket || bucket.dragging || docking) return;   // docked: the work panel folds it, not the frame
  embedShow(bucket.port, bucket.shown === 'open' ? 'thumb' : 'open');
});
ipcMain.on('octa:browser-back', e => {
  if (!trusted(e)) return;
  const wc = chromeBucket(e.sender)?.active?.webContents;
  if (!wc || wc.isDestroyed() || !canGoBack(wc)) return;
  try { wc.navigationHistory.goBack(); } catch { }
});
ipcMain.on('octa:browser-tab', e => {
  if (!trusted(e)) return;
  const bucket = chromeBucket(e.sender);
  if (!bucket) return;
  void addEmbedTab(bucket, 'https://www.google.com/').then(made => { try { bucket.onAdded?.(made); } catch { } return embedShow(bucket.port, 'open'); });
});
ipcMain.on('octa:browser-pick', (e, index) => {
  if (!trusted(e)) return;
  const bucket = chromeBucket(e.sender);
  const tab = bucket?.tabs?.[index];
  if (!tab || tab.webContents.isDestroyed()) return;
  focusTab(bucket, tab);
});
// the switch under the page replaced the old 接手 / 繼續 buttons: take control = hand, watch only = go
ipcMain.on('octa:browser-control', (e, on) => {
  if (!trusted(e)) return;
  const bucket = chromeBucket(e.sender);
  if (!bucket || bucket.dragging) return;
  setControl(bucket, !!on, true);
});
// a wheel turn on the watch-only shield scrolls the page by script, so the site never gets the person's mouse
ipcMain.on('octa:browser-wheel', (e, d) => {
  if (!trusted(e)) return;
  const bucket = shieldBucket(e.sender);
  const wc = bucket?.active?.webContents;
  if (!bucket || bucket.control || !wc || wc.isDestroyed()) return;
  const { dx, dy } = wheelDelta({ deltaX: d?.dx, deltaY: d?.dy }, bucket.active.getBounds?.().height);
  if (!dx && !dy) return;
  wc.executeJavaScript(scrollScript(d?.x, d?.y, dx, dy)).catch(() => { });
});
ipcMain.on('octa:browser-go', (e, raw) => {
  if (!trusted(e)) return;
  const bucket = chromeBucket(e.sender);
  const wc = bucket?.active?.webContents;
  if (!bucket || !wc) return;
  goTo(wc, raw);
  embedShow(bucket.port, 'open');
});
function placeDrag(bucket) {
  if (!win || win.isDestroyed() || !bucket?.panelBox || !bucket.chrome) return;
  const box = bucket.panelBox;
  const [w, h] = win.getContentSize();
  fitView(bucket.chrome, { x: box.x, y: box.y, width: box.width, height: box.height }, true);
  if (bucket.shown !== 'open' || !bucket.active) return;
  const frames = embedFrames(w, h, 'open', { x: box.x, y: box.y, w: box.width, h: box.height }, { tabs: bucket.tabs.length });
  if (!frames.page) return;
  unhost(bucket, bucket.active);
  try { if (!win.contentView.children.includes(bucket.active)) win.contentView.addChildView(bucket.active); } catch { }
  fitView(bucket.active, frames.page, true);
  const rect = shieldFor('open', frames.page, bucket.control);
  if (rect && bucket.shield) fitView(bucket.shield, rect, true);   // it moves with the page while the panel is dragged
  else if (rect) placeShield(bucket, rect);
}
function panelFrom(bucket, w, h) {
  if (bucket.shown === 'open') {
    bucket.openAt = freshOpen(bucket.openAt);
    return sidebarBox(w, h, bucket.openAt);
  }
  return thumbBox(w, h, bucket.thumbAt || savedThumbAt());
}
function rememberPanel(bucket, box) {
  bucket.panelBox = box;
  if (bucket.shown === 'open') bucket.openAt = { x: box.x, y: box.y, w: box.width, h: box.height };
  else bucket.thumbAt = { x: box.x, y: box.y };
}
function findBrowserExe(root, engine) {
  const want = engine === 'firefox' ? /^firefox(\.exe)?$/i : engine === 'brave' ? /^brave(\.exe)?$/i : engine === 'edge' ? /^msedge(\.exe)?$/i : /^chrome(\.exe)?$/i;
  let entries = [];
  try { entries = readdirSync(root, { recursive: true }); } catch { return ''; }
  for (const rel of entries) {
    const name = basename(String(rel));
    if (!want.test(name)) continue;
    const full = join(root, String(rel));
    try { if (statSync(full).isFile()) return full; } catch { }
  }
  return '';
}
function extractZip(zip, dest) {
  return new Promise((resolve, reject) => {
    const p = spawn('tar', ['-xf', zip, '-C', dest], { windowsHide: true });
    let err = '';
    p.stderr?.on('data', d => { err += d; });
    p.on('error', reject);
    p.on('exit', code => code === 0 ? resolve() : reject(new Error(String(err || '解壓縮失敗').slice(0, 180))));
  });
}
async function downloadFile(url, dest, onProgress) {
  const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'OCTA', accept: 'application/octet-stream,*/*' } });
  if (!res.ok || !res.body) throw new Error('下載失敗 HTTP ' + res.status);
  const total = Number(res.headers.get('content-length')) || 0;
  const file = createWriteStream(dest);
  const reader = res.body.getReader();
  let got = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!file.write(Buffer.from(value))) await new Promise(r => file.once('drain', r));
      got += value.byteLength;
      if (total) onProgress(Math.min(99, Math.round(got / total * 100)));
    }
  } finally {
    await new Promise((resolve, reject) => file.end(err => err ? reject(err) : resolve()));
  }
}
async function resolveEngine(engine) {
  const plat = hostPlatform(process.platform, process.arch);
  const headers = { 'user-agent': 'OCTA', accept: 'application/json' };
  if (engine === 'chrome') {
    const res = await fetch(CHROME_CATALOG, { headers });
    if (!res.ok) throw new Error('找不到 Chrome 的下載清單');
    return chromeDownload(await res.json(), plat);
  }
  if (engine === 'brave') {
    const res = await fetch(BRAVE_RELEASE, { headers });
    if (!res.ok) throw new Error('找不到 Brave 的下載清單');
    return braveDownload(await res.json(), plat);
  }
  if (engine === 'firefox') return firefoxDownload(plat);
  return edgeDownload();
}
async function downloadEngine(engine, onProgress) {
  const spec = await resolveEngine(engine);
  if (!spec?.url) return null;
  const root = join(dataDir, 'browsers', engine);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const zip = join(root, 'pack.zip');
  await downloadFile(spec.url, zip, onProgress);
  await extractZip(zip, root);
  rmSync(zip, { force: true });
  const exe = findBrowserExe(root, engine);
  if (!exe) throw new Error('下載完成，但沒有找到瀏覽器');
  const got = { ...(cfg.browserGot || {}), [engine]: { version: spec.version, exe, at: Date.now() } };
  cfg = { ...cfg, browserGot: got };
  writeCfg(cfg);
  onProgress(100);
  return got[engine];
}
async function useEngine(bucket, engine) {
  if (!ENGINE_IDS.includes(engine) || !bucket) return;
  bucket.engine = engine;
  bucket.handed = false;
  bucket.engineError = '';
  const chosen = { ...(cfg.botEngine || {}) };
  if (bucket.botId) chosen[bucket.botId] = engine;
  cfg = { ...cfg, botEngine: chosen };
  writeCfg(cfg);
  if (!ownedExe(engine)) {
    bucket.downloading = engine;
    bucket.percent = 0;
    sendFrame(bucket, {});
    try {
      const got = await downloadEngine(engine, p => { bucket.percent = p; sendFrame(bucket, {}); });
      if (!got && engine === 'edge') bucket.engineError = '已改用 Edge 的身分';
    } catch (e) {
      bucket.engineError = String(e?.message || e).slice(0, 80);
    }
    bucket.downloading = '';
  }
  dressSession(bucket.active?.webContents?.session, bucket);
  for (const v of bucket.tabs) await applyIdentity(v.webContents, engine);
  const url = shownUrl(bucket.active?.webContents);
  if (url) bucket.active.webContents.reloadIgnoringCache();
  else sendFrame(bucket, {});
}
ipcMain.on('octa:browser-engine', (e, engine) => {
  if (!trusted(e)) return;
  const bucket = chromeBucket(e.sender);
  if (!bucket || bucket.engineJob) return;
  bucket.engineJob = useEngine(bucket, String(engine || '')).finally(() => { bucket.engineJob = null; });
});
ipcMain.on('octa:browser-close', (e, index) => {
  if (!trusted(e)) return;
  const bucket = chromeBucket(e.sender);
  if (!bucket || !Number.isInteger(index)) return;
  closeEmbedTab(bucket, index);
});
ipcMain.on('octa:browser-drag-start', e => {
  const none = { dragging: false };
  try {
    if (!trusted(e) || !win || win.isDestroyed()) { e.returnValue = none; return; }
    const bucket = chromeBucket(e.sender);
    if (!bucket || docking || (bucket.shown !== 'thumb' && bucket.shown !== 'open') || covered || (bucket.shown === 'thumb' && thumbDot())) { e.returnValue = none; return; }
    const [w, h] = win.getContentSize();
    const box = panelFrom(bucket, w, h);
    bucket.dragging = true;
    rememberPanel(bucket, box);
    e.returnValue = { dragging: true, x: box.x, y: box.y, w: box.width, h: box.height };
  } catch (err) {
    logError('panel-drag', err);
    e.returnValue = none;
  }
});
ipcMain.on('octa:browser-drag-by', (e, delta) => {
  if (!trusted(e) || !win || win.isDestroyed()) return;
  const bucket = chromeBucket(e.sender);
  if (!bucket?.dragging) return;
  const dx = Number(delta?.dx), dy = Number(delta?.dy);
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
  const [w, h] = win.getContentSize();
  const edge = String(delta?.edge || '');
  const cur = bucket.panelBox || panelFrom(bucket, w, h);
  const box = edge
    ? resizeBox(w, h, cur, edge, dx, dy)
    : (bucket.shown === 'open'
      ? sidebarBox(w, h, { x: cur.x + dx, y: cur.y + dy, w: cur.width, h: cur.height })
      : thumbBox(w, h, { x: cur.x + dx, y: cur.y + dy }));
  rememberPanel(bucket, box);
  placeDrag(bucket);
});
ipcMain.on('octa:browser-drag-end', e => {
  if (!trusted(e)) return;
  const bucket = chromeBucket(e.sender);
  if (!bucket) return;
  bucket.dragging = false;
  rememberPlace(bucket);
  layoutEmbed();
  sendFrame(bucket, { mode: bucket.shown || 'thumb', dragging: false });
});
const handle = (ch, fn) => ipcMain.handle(ch, (e, ...a) => { if (!trusted(e)) throw new Error('not allowed'); return fn(e, ...a); });
// shrink every bot's corner card to a round button, or bring it back. Remembered on this computer.
ipcMain.on('octa:browser-dot', (e, on) => {
  if (!trusted(e) || !chromeBucket(e.sender)) return;
  cfg = { ...cfg, thumbDot: !!on };
  writeCfg(cfg);
  layoutEmbed();
  for (const bucket of embeds.values()) sendFrame(bucket, {});
});
handle('octa:version', () => app.getVersion());
handle('octa:pip', () => JSON.parse(pipSent));
handle('octa:cover', (_e, on) => {
  const next = !!on;
  if (next === covered) return covered;
  covered = next;
  layoutEmbed();
  return covered;
});
handle('octa:show', () => { showWindow(); return true; });
// the chat's own 接手 / 繼續 buttons (login card) flip this bot's browser switch too; the chat already recorded the hand-off
handle('octa:control', (_e, id, on) => {
  const bucket = [...embeds.values()].find(b => b.botId === String(id || ''));
  if (!bucket) return null;
  if (on && bucket.shown !== 'open') void embedShow(bucket.port, 'open');   // taking over to sign in: show the page to sign in on
  return setControl(bucket, !!on, false);
});
// 4.1: where the page's 瀏覽器 tab is ({x, y, width, height, bot, theme} in CSS pixels), or null to hide the browser.
handle('octa:dock', (_e, d) => {
  docking = true;
  const ok = d && typeof d === 'object' && ['x', 'y', 'width', 'height'].every(k => Number.isFinite(+d[k]));
  dockRect = ok ? { x: +d.x, y: +d.y, width: +d.width, height: +d.height } : null;
  if (ok && typeof d.bot === 'string') focusBotId = d.bot.slice(0, 64);
  const theme = d?.theme === 'light' ? 'light' : 'dark';
  const themed = theme !== dockTheme;
  dockTheme = theme;
  layoutEmbed();
  if (themed) for (const bucket of embeds.values()) sendFrame(bucket, {});
  return !!dockRect;
});
handle('octa:focus-bot', (_e, id) => {
  if (docking) return focusBotId;   // the work panel's dock call says which bot (a group member, too)
  const next = String(id || '');
  if (next === focusBotId) return focusBotId;
  focusBotId = next;
  layoutEmbed();
  for (const bucket of embeds.values()) if (onScreen(bucket)) sendFrame(bucket, {});
  return focusBotId;
});
handle('octa:desk', (_e, p, body) => server.desktopApi(String(p), body));
handle('octa:update-status', () => upd);
handle('octa:update-check', () => { checkUpdates(); return upd; });
handle('octa:update-download', () => { if (upd.state === 'available' || upd.state === 'error') { setUpd({ state: 'downloading', percent: 0 }); autoUpdater.downloadUpdate().catch(() => { }); } return upd; });
handle('octa:update-install', () => {
  if (upd.state === 'ready') {
    quitting = true; stopRunner();
    cfg = { ...cfg, updating: { to: upd.version, from: app.getVersion(), at: Date.now() } }; writeCfg(cfg);
    setTimeout(async () => { await closeBrowsers(); freeInstallDir(); reopenAfterUpdate(); autoUpdater.quitAndInstall(true, true); }, 800);
  }
  return upd;
});
// a silent update fails if anything still runs from the install folder (bot browsers' helpers, AI sessions,
// OCTA.exe copies running as node) — end them all first
function freeInstallDir() {
  if (process.platform !== 'win32') return;
  // the folder goes in through an environment variable: non-ASCII paths (e.g. E:\哲\OCTA) got garbled inside the command line
  const ps = `$me=${process.pid}; $dir=$env:OCTA_DIR; $all=Get-CimInstance Win32_Process; ` +
    `function Kids($p){ $all | ? { $_.ParentProcessId -eq $p } | % { Kids $_.ProcessId; $_.ProcessId } }; ` +
    `$data=$env:OCTA_DATA; $ids=@(Kids $me) + @($all | ? { $_.ProcessId -ne $me -and (($_.ExecutablePath -and $_.ExecutablePath.StartsWith($dir, 'OrdinalIgnoreCase')) -or ($data -and $_.CommandLine -and $_.CommandLine.IndexOf($data, [StringComparison]::OrdinalIgnoreCase) -ge 0)) } | % { $_.ProcessId }); ` +
    `$ids | Select-Object -Unique | % { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }; exit 0`;
  try { execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 15000, windowsHide: true, env: { ...process.env, OCTA_DIR: dirname(process.execPath), OCTA_DATA: dataDir } }); } catch (e) { logError('free-install-dir', e); }
}
// the silent installer doesn't always start OCTA again, and a helper started by OCTA dies with it: Windows Task Scheduler
// runs the helper on its own. It waits for the installer to finish, then opens OCTA (the new version, or the old one if
// the update didn't go through)
function reopenAfterUpdate() {
  if (process.platform !== 'win32') return;
  try {
    const f = join(dataDir, 'reopen-octa.ps1'), q = t => "'" + String(t).replace(/'/g, "''") + "'";
    writeFileSync(f, '\ufeff' + [`$exe = ${q(process.execPath)}`, 'Start-Sleep 6', '$end = (Get-Date).AddMinutes(8)',
      "while ((Get-Date) -lt $end -and (Get-Process | Where-Object { $_.ProcessName -like '*octa*setup*' -or $_.ProcessName -like 'Un_A*' })) { Start-Sleep 2 }",
      'Start-Sleep 3', 'if (-not (Get-Process -Name ([IO.Path]::GetFileNameWithoutExtension($exe)) -ErrorAction SilentlyContinue)) { Start-Process -FilePath $exe }',
      'schtasks /Delete /TN OCTA-reopen /F | Out-Null'].join('\r\n'));
    execFileSync('schtasks', ['/Create', '/TN', 'OCTA-reopen', '/TR', `powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "${f}"`, '/SC', 'ONCE', '/ST', '23:59', '/F'], { windowsHide: true, timeout: 15000 });
    execFileSync('schtasks', ['/Run', '/TN', 'OCTA-reopen'], { windowsHide: true, timeout: 15000 });
  } catch (e) { logError('reopen', e); }
}
// installed "for all users" (e.g. into E:\ or Program Files): Windows asks for permission at every update
function needsAdmin() {
  if (process.platform !== 'win32') return false;
  const t = join(dirname(process.execPath), '.octa-write-test');
  try { writeFileSync(t, ''); rmSync(t, { force: true }); return false; } catch { return true; }
}
// tell the user when the last silent update didn't go through, and offer the installer
function checkLastUpdate() {
  const u = cfg.updating; if (!u) return;
  cfg = { ...cfg, updating: null }; writeCfg(cfg);
  if (u.to === app.getVersion() || Date.now() - u.at > 7 * 864e5) return;
  logError('update', `update to ${u.to} did not complete (still ${app.getVersion()})`);
  const r = dialog.showMessageBoxSync(win, { type: 'warning', title: 'OCTA', message: `更新到 v${u.to} 沒有完成，目前還是 v${app.getVersion()}。`,
    detail: '可能有程式還在使用 OCTA 的檔案。按「下載安裝檔」直接安裝最新版（你的機器人和設定都會保留）。', buttons: ['下載安裝檔', '稍後'], defaultId: 0, cancelId: 1 });
  if (r === 0) shell.openExternal('https://github.com/typeu910722-gife/octa/releases/latest/download/OCTA-Setup.exe');
}
// ---------- moving a 3.x cloud account's data here (once; retry from settings if it failed) ----------
let importing = null;
function runCloudImport(token, onStep) {
  if (importing) return importing;
  importing = (async () => {
    const hadRunner = !!runner;
    stopRunner();   // the database file is replaced: nothing may write to it meanwhile
    try {
      onStep(0, '把雲端的資料搬到這台電腦（只需要一次）…');
      const res = await server.cloudImport({
        call: cloudCaller(token),
        onProgress: e => onStep(Math.round(100 * (e.index + (e.expect ? Math.min(1, e.got / e.expect) : 1)) / e.total), `搬移${e.label}… ${e.got}${e.expect ? ' / ' + e.expect : ''}`)
      });
      cfg = { ...cfg, cloudImport: { state: 'done', at: Date.now(), counts: res.counts, backup: res.backup } };   // the old cloud key is no longer needed
      writeCfg(cfg);
      onStep(100, '雲端資料已搬到這台電腦');
      return { ok: true, counts: res.counts, backup: res.backup };
    } catch (e) {
      if (e?.status === 409) {   // the account's data lives on its 主機 computer: nothing to move to this one
        cfg = { ...cfg, cloudImport: { state: 'done', at: Date.now(), counts: {}, note: String(e.message || '') } };
        writeCfg(cfg);
        onStep(100, '這個帳號的資料在主機電腦上，這台電腦從空白開始');
        return { ok: true, counts: {}, backup: '' };
      }
      logError('cloud-import', e);
      cfg = { ...cfg, cloudImport: { ...(cfg.cloudImport || {}), token, state: 'failed', at: Date.now(), error: String(e?.message || e).slice(0, 300) } };
      writeCfg(cfg);
      if (win && !win.isDestroyed()) new Notification({ title: 'OCTA', body: '雲端資料沒有搬完，目前使用這台電腦的資料。可在設定重試。', icon: icon() }).show();
      return { ok: false, error: cfg.cloudImport.error };
    } finally {
      if (hadRunner) await startLocalRunner().catch(e => logError('runner', e));
    }
  })().finally(() => (importing = null));
  return importing;
}
handle('octa:cloud-import-status', () => importStatus(cfg.cloudImport, !!importing));
handle('octa:cloud-import', async () => {
  const token = cfg.cloudImport?.token;
  if (!token) return { ok: false, error: cfg.cloudImport?.state === 'done' ? '已經搬過了' : '這台電腦沒有雲端帳號可以搬' };
  const r = await runCloudImport(token, (p, text) => win?.webContents.send('octa:cloud-import-progress', { p, text }));
  if (r.ok) setTimeout(() => win?.loadURL(server.url).catch(() => { }), 700);   // show the moved data
  return r;
});

// ---------- 4.5 清除這台電腦的 OCTA 資料 (設定 → 進階) ----------
// Called by the local server (POST /api/desktop/wipe, this computer only). The backup is made first; if that fails
// nothing is deleted. Then: stop the runner and every bot browser, say goodbye to linked computers, close the tunnel
// and the database, clear the bots' browser sessions and the window's own storage, delete the folders, restart into
// the first-run screen. Anything Windows still holds open is deleted at the very start of the next launch.
const userDir = () => app.getPath('userData');
const backupRoot = () => {
  const get = k => { try { return app.getPath(k); } catch { return ''; } };
  return backupRootFrom({ documents: get('documents'), downloads: get('downloads'), home: get('home') });
};
let wiping = false;
async function wipeComputer(opts = {}, ctl = {}) {
  if (wiping) return { error: '正在清除' };
  const store = cfg.store || join(dataDir, 'files');
  const get = k => { try { return app.getPath(k); } catch { return ''; } };
  const plan = planWipe({ dataDir, userData: userDir(), store, deleteStore: !!opts.deleteStore, protect: ['home', 'documents', 'downloads', 'desktop', 'appData', 'pictures', 'music', 'videos'].map(get) });
  if (plan.error) return { error: plan.error };
  const lang = ['zh-TW', 'zh-CN', 'en', 'ja'].includes(opts.lang) ? opts.lang : 'zh-TW';
  const wasHost = server.link.role() === 'host';
  wiping = true;
  runnerWanted = false; stopRunner();   // nothing changes the database while it is copied
  let backup = null;
  if (opts.backup !== false) {
    try { ctl.saveDb?.(); backup = makeBackup({ dataDir, store, root: backupRoot(), lang }); }
    catch (e) {
      logError('wipe-backup', e);
      wiping = false;
      if (wasHost) await startLocalRunner().catch(err => logError('runner', err));
      return { error: '備份失敗，沒有刪除任何資料：' + (e?.message || e) };
    }
  }
  setTimeout(() => runWipe(plan, backup, lang).catch(e => { logError('wipe', e); app.relaunch(); app.exit(0); }), 1500);   // the page shows where the backup went meanwhile
  return { ok: true, backup: backup ? { path: backup.path, files: backup.files } : null, role: server.link.role() };
}
async function runWipe(plan, backup, lang) {
  quitting = true; runnerWanted = false; stopRunner();
  try { await win?.loadFile(join(here, 'splash.html')); progress(50, '正在清除這台電腦的 OCTA 資料…'); } catch { }
  await closeBrowsers();
  for (const port of [...embeds.keys()]) await embedStop(port).catch(() => { });
  const said = await Promise.race([server.wipeShutdown().catch(e => { logError('wipe-shutdown', e); return {}; }), new Promise(r => setTimeout(() => r({}), 9000))]);
  // first the marker: whatever cannot be deleted now (or if OCTA stops half way) is deleted at the next start
  writeMarker(userDir(), { at: Date.now(), targets: plan.targets, backup: backup?.path || '', lang, said, keep: cfg.autostartChosen ? { autostartChosen: true } : null });
  wipeDone = true; cfg = {};
  // every bot's browser (sign-ins, cookies, cache) and this window's own storage (language, drafts, 入門導覽)
  const parts = new Set(usedPartitions);
  try { for (const n of readdirSync(join(userDir(), 'Partitions'))) if (/^octa-bot-/i.test(n)) parts.add('persist:' + decodeURIComponent(n)); } catch { }
  for (const p of parts) {
    try { const ses = session.fromPartition(p); await ses.clearStorageData(); await ses.clearCache(); } catch { }
  }
  try { await session.defaultSession.clearStorageData(); await session.defaultSession.clearCache(); } catch { }
  const left = await wipeTargets(plan.targets);
  if (left.length) console.log('wipe: left for the next start', left.length);
  tray?.destroy(); tray = null;
  try { app.releaseSingleInstanceLock(); } catch { }
  app.relaunch({ args: process.argv.slice(1).filter(a => a !== '--hidden') });
  app.exit(0);
}
// after the restart: once, where the backup went (and 打開資料夾)
function toldWipe() {
  if (!wipedNow) return;
  const m = wipedNow.marker || {};
  const t = doneText(m.lang, m.backup || '', wipedNow.left || []);
  wipedNow = null;
  dialog.showMessageBox(win, { type: 'info', title: t.title, message: t.message, detail: t.detail, buttons: t.buttons, defaultId: t.buttons.length - 1, cancelId: t.buttons.length - 1, noLink: true })
    .then(r => { if (m.backup && r.response === 0) shell.openPath(m.backup); }).catch(() => { });
}

// ---------- app ----------
app.on('second-instance', () => {
  if (server) return showWindow();
  const r = dialog.showMessageBoxSync({ type: 'info', title: 'OCTA', message: 'OCTA 還在啟動中。', detail: '如果一直沒有出現，按「重新啟動」。', buttons: ['重新啟動', '再等一下'], defaultId: 0, cancelId: 1 });
  if (r === 0) { app.relaunch(); app.exit(0); }
});
app.on('before-quit', e => {
  quitting = true;
  if (browsersClosed || !runnerMod?.closeAllBrowsers) return;
  e.preventDefault(); Promise.all([closeBrowsers(), flushLogins()]).finally(() => app.quit());
});
// write every bot's sign-ins to disk now (an update or shutdown right after logging in must not lose them)
async function flushLogins() {
  const seen = new Set();
  for (const b of embeds.values()) { const ses = b.active?.webContents?.session; if (ses && !seen.has(ses)) { seen.add(ses); try { await ses.cookies.flushStore(); } catch { } } }
}
app.on('window-all-closed', e => e.preventDefault());   // keep running in the tray

app.whenReady().then(start).catch(e => {
  const msg = logError('start', e);
  dialog.showErrorBox('OCTA 無法啟動', `${e?.message || e}\n\n詳細紀錄：${join(dataDir, 'octa-error.log')}\n\n${msg.slice(0, 1500)}`);
  app.exit(1);
});

// a screen added, removed or moved can put the bots' waiting windows in sight (or Windows moves them back): out again
function reparkAll() { for (const bucket of embeds.values()) for (const host of bucket.hosts.values()) parkHost(host); }
async function start() {
  for (const ev of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(ev, () => setTimeout(reparkAll, 500));
  setInterval(reparkAll, 30000).unref?.();
  createWindow();
  await showSplash();   // the YZ progress bar shows right away while things load
  progress(10, '啟動 OCTA…');
  const slow = setTimeout(() => {
    const r = dialog.showMessageBoxSync({ type: 'warning', title: 'OCTA', message: 'OCTA 啟動比平常久。', detail: `可以再等一下，或按「重新啟動」。\n紀錄檔：${join(dataDir, 'octa-error.log')}`, buttons: ['重新啟動', '再等一下'], defaultId: 1, cancelId: 1 });
    if (r === 0) { app.relaunch(); app.exit(0); }
  }, 45000);

  progress(25, '準備本機服務…');
  server = await startServer({
    dataDir,
    runner: false,   // started below, with the embedded browsers handed over
    hooks: {
      openFolder: () => shell.openPath(dataDir),
      pickFolder: async () => { const r = await dialog.showOpenDialog(win, { title: '選擇 OCTA 檔案資料夾', properties: ['openDirectory', 'createDirectory'] }); return r.canceled ? null : r.filePaths[0]; },
      getStore: () => cfg.store || join(dataDir, 'files'),
      setStore: p => { cfg = { ...cfg, store: p }; writeCfg(cfg); },
      getExtToken: () => cfg.extToken || '',
      browserMode: id => browserMode(id),
      // 4.2: 接手 / 我好了 pressed on the phone (or anywhere): this computer's 僅觀看 / 取得控制權 switch follows
      onHandoff: (id, on) => {
        const bucket = [...embeds.values()].find(b => b.botId === String(id || ''));
        if (bucket) setControl(bucket, !!on, false);
      },
      // the phone's taps and typing on a page of OCTA's own browser (docked, open or parked off screen)
      screenInput: async ({ port, targetId, ev }) => {
        const bucket = embeds.get(port);
        const wc = bucket?.pages.get(targetId)?.wc;
        const steps = wc && !wc.isDestroyed() ? phoneInput(ev) : null;
        if (!steps) return false;
        // right after 接手 the page is re-laid out and focused; a tap in that moment can get lost
        const settle = 700 - (Date.now() - (bucket.controlAt || 0));
        if (settle > 0) await new Promise(r => setTimeout(r, settle));
        for (const st of steps) {
          if (st.input) wc.sendInputEvent(st.input);
          else if (st.text) wc.insertText(st.text);
          else if (st.script) await wc.executeJavaScript(st.script).catch(() => { });
          else if (st.wait) await new Promise(r => setTimeout(r, st.wait));
        }
        return true;
      },
      // 改回內建瀏覽器: the runner moves the Chrome window's sign-ins into OCTA's browser and closes the window
      useEmbedded: async bot => {
        if (runner && runnerMod?.returnToEmbed) return runnerMod.returnToEmbed(bot, { manual: true });
        useEmbedded(bot.id);
        return { ok: true, cookies: 0 };
      },
      setExtToken: t => { cfg = { ...cfg, extToken: t }; writeCfg(cfg); },
      // 4.3 主機電腦／遙控器: the link settings live in desktop.json with everything else
      getLink: () => cfg.link || null,
      setLink: l => { cfg = { ...cfg, link: l }; writeCfg(cfg); },
      // 4.4: the phone remote comes back on after a restart while the user wants it
      getPhoneRemote: () => cfg.phoneRemote,
      setPhoneRemote: v => { cfg = { ...cfg, phoneRemote: !!v }; writeCfg(cfg); },
      // another computer is taking over the data: nothing may change it meanwhile
      pauseHost: async () => { runnerWanted = false; stopRunner(); },
      resumeHost: async () => { await startLocalRunner().catch(e => logError('runner', e)); },
      onRole: async r => {
        if (r === 'remote') {   // this computer is now a remote control: the host does the work
          runnerWanted = false; stopRunner();
          await closeBrowsers(); browsersClosed = false;
          for (const b of embeds.values()) holdOffscreen(b);
          new Notification({ title: 'OCTA', body: `這台電腦現在是「${server.link.viaName()}」的遙控器，機器人在那台電腦上工作。`, icon: icon() }).on('click', showWindow).show();
        } else {
          await startLocalRunner().catch(e => logError('runner', e));
          new Notification({ title: 'OCTA', body: '這台電腦現在是主機，機器人在這台電腦上工作。', icon: icon() }).on('click', showWindow).show();
        }
        if (win && !win.isDestroyed()) win.loadURL(server.url).catch(() => { });
      },
      backupRoot,
      wipe: (o, ctl) => wipeComputer(o, ctl),
      getAutostart: () => app.getLoginItemSettings({ args: LOGIN_ARGS }).openAtLogin,   // Windows needs the same args to find the entry
      setAutostart: on => { app.setLoginItemSettings({ openAtLogin: on, args: LOGIN_ARGS, path: process.execPath }); cfg = { ...cfg, autostartChosen: true }; writeCfg(cfg); }
    }
  });
  // start with Windows by default (after installing or updating), unless the user turned it off themselves
  if (app.isPackaged && !cfg.autostartChosen && !app.getLoginItemSettings({ args: LOGIN_ARGS }).openAtLogin) {
    try { app.setLoginItemSettings({ openAtLogin: true, args: LOGIN_ARGS, path: process.execPath }); } catch (e) { logError('autostart', e); }
  }
  // 3.x → 4.0: cloud users' data comes to this computer once (it takes as long as it takes: no "slow start" box)
  if (pendingImport) {
    clearTimeout(slow);
    const r = await runCloudImport(pendingImport, (p, t) => progress(30 + Math.round(p * 0.6), t)).catch(e => ({ ok: false, error: e.message }));
    if (!r.ok) { progress(90, '雲端資料這次沒能取回，先使用這台電腦的資料，之後可在設定重試。'); await new Promise(ok => setTimeout(ok, 3500)); }
  }
  progress(92, '準備機器人…');
  if (server.link.role() === 'host') await startLocalRunner();   // a remote control's bots run on the host computer
  clearTimeout(slow);

  tray = new Tray(icon().resize({ width: 16, height: 16 }));
  tray.setToolTip('OCTA｜奧克塔');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '開啟 OCTA', click: showWindow },
    { label: '打開檔案資料夾', click: () => { const p = cfg.store || join(dataDir, 'files'); mkdirSync(p, { recursive: true }); shell.openPath(p); } },
    { type: 'separator' },
    { label: '結束（機器人會停止工作）', click: async () => { quitting = true; await closeBrowsers(); stopRunner(); await server.close(); app.quit(); } }
  ]));
  tray.on('click', showWindow);

  await loadMain();
  if (wipedNow) { if (wipedNow.left?.length) logError('wipe-left', wipedNow.left.join('\n')); setTimeout(toldWipe, 1500); }
  setTimeout(checkLastUpdate, 3000);
  setTimeout(checkUpdates, 8000);                       // look for a new version shortly after start…
  setInterval(checkUpdates, 6 * 3600 * 1000);           // …and every six hours
  if (hiddenStart) new Notification({ title: 'OCTA', body: '已在背景啟動，點右下角章魚圖示打開。', icon: icon() }).on('click', showWindow).show();
}
