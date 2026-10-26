// OCTA desktop (Electron).
// Signed in: the window shows the OCTA website (same account as the web version, everything syncs)
// and this computer runs that account's bots. Offline mode: everything stays on this computer.
import { app, BrowserWindow, WebContentsView, Tray, Menu, Notification, shell, nativeImage, dialog, ipcMain, screen } from 'electron';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, appendFileSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync, createWriteStream } from 'node:fs';
import os from 'node:os';
import { startServer } from './server.mjs';
import { startCdpBridge } from './cdp-bridge.mjs';
import { PAGE, THUMB_RADIUS, embedFrames, freshOpen, isBlankUrl, resizeBox, sidebarBox, thumbBox } from './embed-layout.mjs';
import { BRAVE_RELEASE, CHROME_CATALOG, ENGINE_IDS, ENGINE_LABEL, braveDownload, chromeDownload, edgeDownload, firefoxDownload, hostPlatform, identity, pageNeedsAttention, pageUnsupported } from './browser-catalog.mjs';

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
const CLOUD = (process.env.OCTA_CLOUD || 'https://octa.yzprojecttw.com').replace(/\/+$/, '');

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }   // already running: the first copy shows its window
app.setAppUserModelId('tw.yzproject.octa');

let win = null, tray = null, server = null, quitting = false, runner = null, runnerFor = '';
const LOGIN_ARGS = ['--hidden'];
const hiddenStart = process.argv.includes('--hidden') || app.getLoginItemSettings({ args: LOGIN_ARGS }).wasOpenedAtLogin;
const icon = () => nativeImage.createFromPath(join(here, 'icon.png'));

// keep data from installs made before the rename
const oldDir = join(app.getPath('appData'), 'E·BOT');
const dataDir = existsSync(join(oldDir, 'ebot.sqlite')) && !existsSync(join(app.getPath('userData'), 'ebot.sqlite')) ? oldDir : app.getPath('userData');
const cfgFile = join(dataDir, 'desktop.json');
const readCfg = () => { try { return JSON.parse(readFileSync(cfgFile, 'utf8')); } catch { return {}; } };
const writeCfg = c => { try { mkdirSync(dataDir, { recursive: true }); writeFileSync(cfgFile, JSON.stringify(c, null, 2)); } catch { } };
let cfg = readCfg();

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
const failSplash = t => win?.webContents.executeJavaScript(`window.fail&&fail(${JSON.stringify(t)})`).catch(() => { });

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
    if (!url.startsWith(CLOUD) && !(server && url.startsWith(server.url)) && !url.startsWith('file:')) { e.preventDefault(); shell.openExternal(url); }
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMain) => {
    if (!isMain || code === -3) return;   // -3: navigation replaced by another one
    logError('load', `${code} ${desc} ${url}`);
    if (url.startsWith(CLOUD)) showSplash().then(() => failSplash('連不上 OCTA 雲端（' + desc + '）。請檢查網路後重試，或先用離線模式。'));
  });
  win.on('close', e => {
    if (quitting) return;
    e.preventDefault(); win.hide();
    if (!cfg.toldTray) {   // the first time: say the bots keep working in the background
      cfg = { ...cfg, toldTray: true }; writeCfg(cfg);
      new Notification({ title: 'OCTA 還在背景工作', body: '機器人會繼續執行。點右下角章魚圖示可以打開，要完全關閉請在圖示上按右鍵 →「結束」。', icon: icon() }).on('click', showWindow).show();
    }
  });
  win.on('closed', () => (win = null));
  win.on('resize', () => { layoutEmbed(); saveWin(); });
  win.on('move', saveWin);
  win.on('maximize', () => { layoutEmbed(); saveWin(); });
  win.on('unmaximize', () => { layoutEmbed(); saveWin(); });
  win.once('ready-to-show', () => { if (!hiddenStart) { win.show(); win.focus(); } });
}
function showWindow() {
  if (!win) { createWindow(); loadMain(); }
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
}
const showSplash = () => win.loadFile(join(here, 'splash.html'));

async function loadMain() {
  if (cfg.mode === 'local') { await win.loadURL(server.url); return; }
  progress(70, '連線到 OCTA 雲端…');
  try { await win.loadURL(CLOUD); }
  catch (e) { if (!String(e).includes('ERR_ABORTED')) logError('cloud', e); }
}

// ---------- in-app Chromium (the bot's browser lives in the OCTA window, not a separate Chrome) ----------
const embeds = new Map();
let embedSeq = 0;
let focusBotId = '';
function fitView(view, bounds, visible) {
  if (!view || !bounds) return;
  try { view.setBounds(bounds); } catch { }
  try { view.setVisible(visible); } catch { }
}
function hostOf(bucket) {
  if (bucket.host && !bucket.host.isDestroyed()) return bucket.host;
  // the page stays 1280×800 here, so a thumbnail does not shrink what the bot sees
  bucket.host = new BrowserWindow({
    show: false, x: -3200, y: -3200, width: PAGE.width, height: PAGE.height,
    skipTaskbar: true, focusable: false, frame: false, thickFrame: false,
    minimizable: false, movable: false, resizable: false,
    webPreferences: { backgroundThrottling: false }
  });
  try { bucket.host.setMenuBarVisibility(false); } catch { }
  return bucket.host;
}
function parkView(bucket, view, visible) {
  const host = hostOf(bucket);
  try { if (win && !win.isDestroyed()) win.contentView.removeChildView(view); } catch { }
  try { if (!host.contentView.children.includes(view)) host.contentView.addChildView(view); } catch { }
  fitView(view, { x: 0, y: 0, width: PAGE.width, height: PAGE.height }, visible);
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
  wc.send('octa:browser-frame', { name: bucket.name, mode: bucket.shown || 'thumb', url: shownUrl(page), canBack: canGoBack(page), tabs, engines, blocked: !!bucket.blocked, downloading: bucket.downloading || '', percent: bucket.percent || 0, error: bucket.engineError || '', ...extra });
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
    if (bucket.shown !== 'thumb' || !bucket.active || bucket.active.webContents.isDestroyed()) return;
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
}
function raiseView(view) {
  if (!view || !win || win.isDestroyed()) return;
  try { win.contentView.removeChildView(view); } catch { }
  try { win.contentView.addChildView(view); } catch { }
}
function placeBucket(bucket, frames) {
  const page = frames.mode === 'open' && frames.page ? bucket.active : null;
  for (const v of bucket.tabs) {
    if (v === page) continue;
    // the active tab stays visible off to the side, so a thumbnail can still photograph it
    parkView(bucket, v, v === bucket.active);
  }
  if (frames.chrome && bucket.chrome && win) {
    // put the panel back above the chat every time, so a reload cannot cover it
    raiseView(bucket.chrome);
    fitView(bucket.chrome, frames.chrome, true);
    roundChrome(bucket.chrome, THUMB_RADIUS, frames.mode === 'open');
  }
  // the page sits above the panel frame; the frame's edges stay outside the page and can still be grabbed
  if (page && frames.page && win) {
    try { bucket.host?.contentView.removeChildView(page); } catch { }
    raiseView(page);
    fitView(page, frames.page, true);
    roundChrome(page, 12, true);
  }
}
function holdOffscreen(bucket) {
  detachChrome(bucket);
  for (const v of bucket.tabs) parkView(bucket, v, !!bucket.shown && v === bucket.active);
}
function layoutEmbed() {
  if (!win || win.isDestroyed()) return;
  const [w, h] = win.getContentSize();
  const main = win.contentView.children.find(v => v.webContents === win.webContents);
  fitView(main, { x: 0, y: 0, width: w, height: h }, true);
  for (const bucket of embeds.values()) {
    if (!onScreen(bucket)) {
      stopThumbs(bucket);
      holdOffscreen(bucket);
      continue;
    }
    if (bucket.dragging && bucket.panelBox) {
      placeDrag(bucket);
      continue;
    }
    if (bucket.shown === 'open') bucket.openAt = freshOpen(bucket.openAt);
    const at = bucket.shown === 'open' ? bucket.openAt : (bucket.thumbAt || savedThumbAt());
    const frames = embedFrames(w, h, bucket.shown, at, { tabs: bucket.tabs.length });
    if (bucket.shown === 'thumb' && !bucket.thumbTimer) startThumbs(bucket);
    placeBucket(bucket, frames);
  }
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
  } catch (e) { logError('ua', e); }
}
// CDP cookies (what the runner keeps) ↔ Electron cookies. Electron needs a url and calls the expiry expirationDate.
const SAME_TO_CDP = { lax: 'Lax', strict: 'Strict', no_restriction: 'None' };
const SAME_TO_EL = { Lax: 'lax', Strict: 'strict', None: 'no_restriction', lax: 'lax', strict: 'strict', no_restriction: 'no_restriction' };
const KEEP_DAYS = 30;
function electronCookie(c) {
  const host = String(c.domain || '').replace(/^\./, '') || (() => { try { return new URL(c.url).hostname; } catch { return ''; } })();
  const out = { url: c.url || `${c.secure ? 'https' : 'http'}://${host}${c.path || '/'}`, name: c.name, value: c.value, path: c.path || '/', secure: !!c.secure, httpOnly: !!c.httpOnly };
  if (String(c.domain || '').startsWith('.')) out.domain = c.domain;
  if (SAME_TO_EL[c.sameSite]) out.sameSite = SAME_TO_EL[c.sameSite];
  // a sign-in kept only "for this session" would be gone after OCTA restarts: bots keep it like a remembered login
  out.expirationDate = +c.expires > 0 ? +c.expires : Date.now() / 1000 + KEEP_DAYS * 86400;
  return out;
}
// sites often keep the login in a session cookie; keep those across restarts so the bot stays signed in
function keepLogins(ses) {
  if (!ses || ses.__octaKeep) return;
  ses.__octaKeep = true;
  ses.cookies.on('changed', (_e, c, _cause, removed) => {
    if (removed || !c.session || !c.name) return;
    ses.cookies.set(electronCookie({ ...c, expires: 0 })).catch(() => { });
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
      set('sec-ch-ua', id.clientHint || null);
      set('sec-ch-ua-mobile', id.clientHint ? '?0' : null);
      set('sec-ch-ua-platform', id.clientHint ? `"${id.metadata.platform}"` : null);
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
// Google blocks sign-in in embedded browsers. Hand this bot to a real Chrome window (its own profile) for good.
function googleBlocked(bucket, url) {
  let u; try { u = new URL(url); } catch { return; }
  if (u.hostname !== 'accounts.google.com' || !/signin|ServiceLogin|AddSession|rejected/i.test(u.pathname)) return;
  if (!bucket.botId || bucket.toChrome || typeof embedApi.onGoogle !== 'function') return;
  bucket.toChrome = true;
  cfg = { ...cfg, realChrome: { ...(cfg.realChrome || {}), [bucket.botId]: true } };
  writeCfg(cfg);
  bucket.engineError = 'Google 不讓內嵌瀏覽器登入，正在改用 Chrome 視窗…';
  sendFrame(bucket, {});
  setTimeout(() => Promise.resolve(embedApi.onGoogle(bucket.botId, url)).catch(e => logError('google-chrome', e)), 300);
}
async function hookPage(wc, id, bucket) {
  try { if (!wc.debugger.isAttached()) wc.debugger.attach('1.3'); } catch (e) { if (!/already/i.test(String(e))) logError('debugger', e); }
  await applyIdentity(wc, bucket.engine || 'chrome');
  wc.debugger.on('message', (_e, method, params) => bucket.onEvent?.(id, method, params));
  bucket.pages.set(id, { wc });
  const ping = () => { if (bucket.active?.webContents === wc) sendFrame(bucket, {}); };
  wc.on('did-navigate', (_e, url) => { ping(); googleBlocked(bucket, url); });
  wc.on('did-navigate-in-page', ping);
  wc.on('did-finish-load', () => { ping(); void notePage(wc, bucket); });
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
  try { bucket.host?.contentView.removeChildView(tab); } catch { }
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
  // an explicit open while no chat is focused still has to land on screen
  if (mode && !focusBotId) focusBotId = bucket.botId;
  if (!mode) {
    detachChrome(bucket);
    for (const v of bucket.tabs) parkView(bucket, v, false);
  } else if (mode === 'thumb') startThumbs(bucket);
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
  for (const v of bucket.tabs) {
    try { if (win && !win.isDestroyed()) win.contentView.removeChildView(v); } catch { }
    try { bucket.host?.contentView.removeChildView(v); } catch { }
    try { if (!v.webContents.isDestroyed()) v.webContents.close(); } catch { }
  }
  try { if (bucket.host && !bucket.host.isDestroyed()) bucket.host.destroy(); } catch { }
  for (const w of bucket.hidden) { try { if (!w.isDestroyed()) w.destroy(); } catch { } }
  try { await bucket.bridge?.close(); } catch { }
  layoutEmbed();
}
async function embedStart(bot, port) {
  if (embeds.has(port)) return;
  if (!win || win.isDestroyed()) throw new Error('視窗還沒開');
  const partition = 'persist:octa-bot-' + String(bot.id || 'bot').replace(/[^\w-]/g, '').slice(0, 40);
  const prefs = { partition, contextIsolation: true, sandbox: true, backgroundThrottling: false };
  const view = new WebContentsView({ webPreferences: prefs });
  const name = String(bot.name || '機器人').replace(/[<&]/g, '');
  const chrome = new WebContentsView({ webPreferences: { preload: join(here, 'browser-preload.cjs'), contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  const place = savedPlace(String(bot.id || ''));
  const engine = ENGINE_IDS.includes(cfg.botEngine?.[String(bot.id || '')]) ? cfg.botEngine[String(bot.id || '')] : 'chrome';
  const bucket = { port, botId: String(bot.id || ''), prefs, tabs: [view], active: view, pages: new Map(), shown: false, onEvent: null, hidden: [], bridge: null, splash: '', chrome, name, host: null, thumbTimer: null, thumbAt: place.thumb || savedThumbAt(), openAt: place.open || null, dragging: false, panelBox: null, engine, blocked: false, downloading: '', percent: 0, engineError: '', handed: false, engineJob: null };
  dressSession(view.webContents.session, bucket);
  keepLogins(view.webContents.session);
  roundChrome(chrome, THUMB_RADIUS);
  await hookPage(view.webContents, 'p' + (++embedSeq), bucket);
  bindOpen(bucket, view);
  bucket.splash = 'https://www.google.com/';
  view.webContents.loadURL(bucket.splash).catch(() => { });
  chrome.webContents.loadFile(join(here, 'browser-chrome.html')).catch(() => { });
  chrome.webContents.on('did-finish-load', () => sendFrame(bucket, {}));
  parkView(bucket, view, true);
  const adapter = {
    list: () => [...bucket.pages].filter(([, p]) => !p.wc.isDestroyed()).map(([id, p]) => ({ id, title: p.wc.getTitle(), url: p.wc.getURL() || 'about:blank' })),
    bounds: () => {
      if (bucket.shown === 'open') {
        const b = bucket.active?.getBounds?.() || {};
        return { windowId: 1, bounds: { left: 0, top: 0, width: b.width > 50 ? b.width : PAGE.width, height: b.height > 50 ? b.height : PAGE.height, windowState: 'normal' } };
      }
      // parked at the working size, so a thumbnail does not make the bot's page collapse
      return { windowId: 1, bounds: { left: 0, top: 0, width: PAGE.width, height: PAGE.height, windowState: bucket.shown === 'thumb' ? 'normal' : 'minimized' } };
    },
    setBounds: bounds => embedShow(port, bounds?.windowState !== 'minimized' && !(bounds?.left < -5000)),
    onEvent: cb => { bucket.onEvent = cb; },
    async command(targetId, method, params) {
      const page = bucket.pages.get(targetId);
      if (!page || page.wc.isDestroyed()) throw new Error('找不到分頁');
      if (method === 'Storage.getCookies') {
        const cookies = await page.wc.session.cookies.get({});
        return { cookies: cookies.map(c => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly, expires: c.expirationDate || 0, ...(SAME_TO_CDP[c.sameSite] ? { sameSite: SAME_TO_CDP[c.sameSite] } : {}) })) };
      }
      if (method === 'Storage.setCookies') {
        for (const c of params.cookies || []) { try { await page.wc.session.cookies.set(electronCookie(c)); } catch { } }
        try { await page.wc.session.cookies.flushStore(); } catch { }
        return {};
      }
      return await page.wc.debugger.sendCommand(method, params || {});
    },
    async createTarget(params) {
      const url = params?.url || 'about:blank';
      if (params?.background) {
        const id = 'p' + (++embedSeq);
        const hidden = new BrowserWindow({ show: false, width: 1280, height: 800, skipTaskbar: true, parent: win, webPreferences: prefs });
        bucket.hidden.push(hidden);
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
      const hw = bucket.hidden.find(w => !w.isDestroyed() && w.webContents === page.wc);
      try { hw?.destroy(); } catch { }
    },
    activateTarget: async id => {
      const page = bucket.pages.get(id);
      const tab = page && bucket.tabs.find(v => v.webContents === page.wc);
      if (tab) focusTab(bucket, tab);
      await embedShow(port, true);
    },
    close: () => embedStop(port)
  };
  bucket.bridge = await startCdpBridge(adapter, port);
  embeds.set(port, bucket);
}

// ---------- runner ----------
const embedApi = { start: embedStart, show: embedShow, stop: embedStop, external: id => !!cfg.realChrome?.[String(id)], onGoogle: null };
async function bundledRunnerOpts() {
  const pwCli = unpacked(join(dirname(require.resolve('@playwright/mcp/package.json')), 'cli.js'));
  return {
    home: dataDir, pwCli, nodeBin: process.execPath, nodeEnv: { ELECTRON_RUN_AS_NODE: '1' }, getExtToken: () => cfg.extToken || '',
    getStore: () => server.getStore(), appVersion: app.getVersion(),
    embed: embedApi,
    log: (...a) => console.log(new Date().toLocaleTimeString(), ...a),
    onFatal: m => { logError('runner', m); stopRunner(); cfg.runnerToken = ''; writeCfg(cfg); }
    // notifications are shown by the page itself (same as on phones and other computers)
  };
}
let runnerMod = null, browsersClosed = false;
// close the bots' browsers before OCTA exits (at most a few seconds)
async function closeBrowsers() {
  if (browsersClosed || !runnerMod?.closeAllBrowsers) return; browsersClosed = true;
  await Promise.race([runnerMod.closeAllBrowsers().catch(e => logError('close-browsers', e)), new Promise(r => setTimeout(r, 4000))]);
}
function stopRunner() { runner?.stop(); runner = null; runnerFor = ''; }
async function startRunnerFor(url, token) {
  if (runner && runnerFor === url + token) return;
  stopRunner();
  const mod = await import(pathToFileURL(join(server.webDir, 'octa-runner.mjs')).href); runnerMod = mod;
  const { startRunner } = mod;
  runner = startRunner({ url, token, openInstall: k => server.installEngine(k), ...(await bundledRunnerOpts()) });
  runnerFor = url + token;
}

// only OCTA's own pages may use the bridge
const trusted = e => { const u = e.senderFrame?.url || ''; return u.startsWith(CLOUD + '/') || u === CLOUD || (server && u.startsWith(server.url)) || u.startsWith('file:'); };
function chromeBucket(sender) {
  for (const [, bucket] of embeds) if (bucket.chrome?.webContents === sender) return bucket;
  return null;
}
ipcMain.on('octa:browser-toggle', e => {
  if (!trusted(e)) return;
  const bucket = chromeBucket(e.sender);
  if (!bucket || bucket.dragging) return;
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
  void addEmbedTab(bucket, 'https://www.google.com/').then(() => embedShow(bucket.port, 'open'));
});
ipcMain.on('octa:browser-pick', (e, index) => {
  if (!trusted(e)) return;
  const bucket = chromeBucket(e.sender);
  const tab = bucket?.tabs?.[index];
  if (!tab || tab.webContents.isDestroyed()) return;
  focusTab(bucket, tab);
});
function relayStage(e, act) {
  if (!trusted(e)) return;
  const bucket = chromeBucket(e.sender);
  if (!bucket || !win || win.isDestroyed()) return;
  win.webContents.send('octa:stage', { bot: bucket.botId, act });
}
ipcMain.on('octa:browser-hand', e => relayStage(e, 'hand'));
ipcMain.on('octa:browser-continue', e => relayStage(e, 'go'));
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
  try { bucket.host?.contentView.removeChildView(bucket.active); } catch { }
  try { if (!win.contentView.children.includes(bucket.active)) win.contentView.addChildView(bucket.active); } catch { }
  fitView(bucket.active, frames.page, true);
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
    if (!bucket || (bucket.shown !== 'thumb' && bucket.shown !== 'open')) { e.returnValue = none; return; }
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
handle('octa:version', () => app.getVersion());
handle('octa:show', () => { showWindow(); return true; });
handle('octa:focus-bot', (_e, id) => {
  const next = String(id || '');
  if (next === focusBotId) return focusBotId;
  focusBotId = next;
  layoutEmbed();
  for (const bucket of embeds.values()) if (onScreen(bucket)) sendFrame(bucket, {});
  return focusBotId;
});
handle('octa:desk', (_e, p, body) => server.desktopApi(String(p), body));
const call = async (path, token, method = 'GET', body) => {
  const r = await fetch(CLOUD + '/api/' + path, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(d.error || 'HTTP ' + r.status); e.status = r.status; throw e; }
  return d;
};
handle('octa:connect', async (_e, webToken) => {   // the page signed in: run this account's bots on this computer
  if (!webToken || cfg.mode === 'local') return { ok: false };
  const who = await call('me', webToken);
  // keep this computer's key when the same account signs in again (it stays the same computer in the list)
  let reuse = false;
  if (cfg.runnerToken) {
    try { reuse = (await call('runner/hello', cfg.runnerToken, 'POST', { app: app.getVersion() })).user === who.id; }
    catch (e) { if (e.status !== 401 && e.status !== 403 && cfg.runnerUser === who.id) reuse = true; }   // offline: trust the saved key
  }
  if (!reuse) {
    const d = await call('runner-token', webToken, 'POST', { label: 'desktop:' + os.hostname(), device: 'OCTA 電腦版 · ' + os.hostname() });
    cfg = { ...cfg, runnerToken: d.token, runnerUser: who.id };
    writeCfg(cfg);
  } else if (cfg.runnerUser !== who.id) { cfg = { ...cfg, runnerUser: who.id }; writeCfg(cfg); }
  await startRunnerFor(CLOUD, cfg.runnerToken);
  return { ok: true };
});
// signing out: keep=true leaves this computer working for the account (the window just shows the sign-in page)
handle('octa:disconnect', (_e, opts) => {
  if (opts?.keep && cfg.runnerToken) return { ok: true, working: true };
  stopRunner(); cfg = { ...cfg, runnerToken: '', runnerUser: '' }; writeCfg(cfg); return { ok: true };
});
handle('octa:working', () => ({ working: !!runner && runnerFor.startsWith(CLOUD), standby: !!runner?.standby?.() }));
handle('octa:offline', async () => {
  cfg = { ...cfg, mode: 'local' }; writeCfg(cfg);
  stopRunner(); await startRunnerFor(server.url, '');
  await win.loadURL(server.url); return { ok: true };
});
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
    `$ids=@(Kids $me) + @($all | ? { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($dir, 'OrdinalIgnoreCase') -and $_.ProcessId -ne $me } | % { $_.ProcessId }); ` +
    `$ids | Select-Object -Unique | % { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }; exit 0`;
  try { execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 15000, windowsHide: true, env: { ...process.env, OCTA_DIR: dirname(process.execPath) } }); } catch (e) { logError('free-install-dir', e); }
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
handle('octa:cloud', async () => {
  cfg = { ...cfg, mode: 'cloud' }; writeCfg(cfg);
  stopRunner(); await showSplash(); progress(60, '重新連線…'); await loadMain(); return { ok: true };
});

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

async function start() {
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
    runner: false,   // started below for whichever mode is in use
    hooks: {
      openFolder: () => shell.openPath(dataDir),
      pickFolder: async () => { const r = await dialog.showOpenDialog(win, { title: '選擇 OCTA 檔案資料夾', properties: ['openDirectory', 'createDirectory'] }); return r.canceled ? null : r.filePaths[0]; },
      getStore: () => cfg.store || join(dataDir, 'files'),
      setStore: p => { cfg = { ...cfg, store: p }; writeCfg(cfg); },
      getExtToken: () => cfg.extToken || '',
      setExtToken: t => { cfg = { ...cfg, extToken: t }; writeCfg(cfg); },
      getAutostart: () => app.getLoginItemSettings({ args: LOGIN_ARGS }).openAtLogin,   // Windows needs the same args to find the entry
      setAutostart: on => { app.setLoginItemSettings({ openAtLogin: on, args: LOGIN_ARGS, path: process.execPath }); cfg = { ...cfg, autostartChosen: true }; writeCfg(cfg); }
    }
  });
  // start with Windows by default (after installing or updating), unless the user turned it off themselves
  if (app.isPackaged && !cfg.autostartChosen && !app.getLoginItemSettings({ args: LOGIN_ARGS }).openAtLogin) {
    try { app.setLoginItemSettings({ openAtLogin: true, args: LOGIN_ARGS, path: process.execPath }); } catch (e) { logError('autostart', e); }
  }
  progress(50, '準備機器人…');
  if (cfg.mode === 'local') await startRunnerFor(server.url, '');
  else if (cfg.runnerToken) await startRunnerFor(CLOUD, cfg.runnerToken);   // keep working before the page finishes loading
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
  setTimeout(checkLastUpdate, 3000);
  setTimeout(checkUpdates, 8000);                       // look for a new version shortly after start…
  setInterval(checkUpdates, 6 * 3600 * 1000);           // …and every six hours
  if (hiddenStart) new Notification({ title: 'OCTA', body: '已在背景啟動，點右下角章魚圖示打開。', icon: icon() }).on('click', showWindow).show();
}
