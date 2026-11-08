// OCTA runner: each bot's own browser (Chrome or OCTA's embedded one) over CDP — start, tag, share sign-ins, close.
import { spawn } from 'node:child_process';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chatNote } from './api-client.mjs';
import { botDir, findChrome } from './files.mjs';
import { isGoogleCookie, switchToChrome } from './google.mjs';
import { WIN, cfg, log, workDir } from './state.mjs';
import { cookieParams, mergeOldProfiles } from './transfer.mjs';
import { closeSession, sessions } from './warm.mjs';

// ---------- each bot's own browser: one Chrome that stays open between jobs ----------
// It starts in the background (off screen). The AI connects to it over CDP, so tabs and logins carry over.
// 「在電腦上顯示」 brings the same window forward: you see what the bot sees, and can log in right there.
export const browsers = new Map();   // key ('shared' or bot id) → { port, last }
export let shareBrowser = true;   // sign-ins shared between bots; each bot still has its own browser, so bots work in parallel
export function setShareBrowser(job) { if (typeof job.shareBrowser === 'boolean') shareBrowser = job.shareBrowser; }
export const sharedProfile = () => join(workDir, 'profile-shared');   // 2.4.0–2.4.2 used one shared Chrome here: its sign-ins get merged in
const jarFile = () => join(workDir, 'shared-logins.json');
const readJar = () => { try { return JSON.parse(readFileSync(jarFile(), 'utf8')); } catch { return []; } };
const ckKey = c => `${c.name}|${c.domain}|${c.path || '/'}`;
// 4.7: Google's sign-in is never shared or copied: Google ties it to the browser it was made in (copied, it logs out
// again — the Gmail problem). Each bot signs in to Google once, in its own Chrome window, and keeps it there.
export function addToJar(list) {   // newest values win; expired ones drop out
  const now = Date.now() / 1000, m = new Map(readJar().filter(c => !isGoogleCookie(c)).map(c => [ckKey(c), c]));
  for (const c of list) if (c.name && c.domain && !isGoogleCookie(c)) m.set(ckKey(c), c);
  const out = [...m.values()].filter(c => !(c.expires > 0 && c.expires < now));
  mkdirSync(workDir, { recursive: true }); writeFileSync(jarFile(), JSON.stringify(out)); return out.length;
}
// before a bot works: give its browser everyone's sign-ins; after: add what it signed in to
async function syncIn(port) {   // also take sign-ins from other bots' browsers that are open right now (they only save theirs when their job ends)
  let m = {}; try { m = JSON.parse(readFileSync(join(workDir, 'ports.json'), 'utf8')); } catch { }
  await Promise.all(Object.values(m).filter(p => p !== port).map(async p => { if (await cdpInfo(p)) await syncOut(p); }));
  await syncOut(port);   // its own newest sign-ins last, so an older copy in the shared store never logs it out
  const jar = readJar().filter(c => !isGoogleCookie(c)); if (jar.length) await cdp(port, send => send('Storage.setCookies', { cookies: cookieParams(jar) })).catch(e => log('帶入共用登入失敗：' + e.message)); }
export async function syncOut(port) { try { const { cookies = [] } = await cdp(port, send => send('Storage.getCookies')); addToJar(cookies); } catch (e) { log('儲存共用登入失敗：' + e.message); } }
export const busyBots = new Set();
export const pause = ms => new Promise(r => setTimeout(r, ms));
export function profileInUse(profile) {   // a Chrome window (without the debugging port) still has this profile open
  if (WIN) {
    const f = join(profile, 'lockfile');
    if (!existsSync(f)) return false;
    try { closeSync(openSync(f, 'r+')); return false; } catch (e) { return ['EBUSY', 'EPERM', 'EACCES'].includes(e.code); }
  }
  try { lstatSync(join(profile, 'SingletonLock')); return true; } catch { return false; }
}
export function portOf(id) {   // a fixed local port per bot, kept in work/ports.json
  const f = join(workDir, 'ports.json');
  let m = {}; try { m = JSON.parse(readFileSync(f, 'utf8')); } catch { }
  if (!m[id]) { const used = new Set(Object.values(m)); let p = 9311; while (used.has(p)) p++; m[id] = p; writeFileSync(f, JSON.stringify(m)); }
  return m[id];
}
export function embedPortOf(id) {   // separate from Chrome's ports, so a leftover Chrome does not get driven by mistake
  const f = join(workDir, 'embed-ports.json');
  let m = {}; try { m = JSON.parse(readFileSync(f, 'utf8')); } catch { }
  if (!m[id]) { const used = new Set(Object.values(m)); let p = 19011; while (used.has(p)) p++; m[id] = p; try { writeFileSync(f, JSON.stringify(m)); } catch { } }
  return m[id];
}
function savedPorts() {
  const out = [];
  for (const name of ['ports.json', 'embed-ports.json']) {
    try { out.push(...Object.values(JSON.parse(readFileSync(join(workDir, name), 'utf8')))); } catch { }
  }
  return out;
}
export async function cdpInfo(port) {
  try { const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) }); return r.ok ? await r.json() : null; } catch { return null; }
}
export async function cdp(port, fn) {   // a short CDP session on the browser
  if (typeof WebSocket === 'undefined') throw new Error('需要 Node 22 以上');
  const v = await cdpInfo(port);
  if (!v) throw new Error('瀏覽器沒有開著');
  const ws = new WebSocket(v.webSocketDebuggerUrl);
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = () => no(new Error('連不上瀏覽器')); setTimeout(() => no(new Error('連不上瀏覽器')), 5000); });
  let n = 0; const wait = {};
  ws.onmessage = e => { const m = JSON.parse(e.data); if (wait[m.id]) { wait[m.id](m); delete wait[m.id]; } };
  const send = (method, params = {}, sessionId) => new Promise((ok, no) => {
    const id = ++n; wait[id] = m => (m.error ? no(new Error(m.error.message)) : ok(m.result));
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    setTimeout(() => { if (wait[id]) { delete wait[id]; no(new Error('瀏覽器沒有回應')); } }, 15000);
  });
  try { return await fn(send); } finally { try { ws.close(); } catch { } }
}
export const pagesOf = async send => (await send('Target.getTargets')).targetInfos.filter(t => t.type === 'page' && !t.url.startsWith('devtools://'));
export function pickLivePage(pages) {
  const list = (pages || []).filter(p => p && !String(p.url || '').startsWith('devtools://'));
  const real = list.filter(p => { const u = String(p.url || ''); return u && u !== 'about:blank' && !u.startsWith('data:'); });
  return real.at(-1) || list.at(-1) || null;
}
export const touchBrowser = id => { const b = browsers.get(id); if (b) b.last = Date.now(); };
// a name tag on every page of a bot's browser: a colored badge in the corner, and its name before the tab title
const tags = new Map();   // port → open CDP connection that tags new pages
const colorOf = name => { let h = 0; for (const ch of name) h = (h * 31 + ch.codePointAt(0)) >>> 0; return '#' + (BOT_COLORS[h % BOT_COLORS.length] & 0xFFFFFF).toString(16).padStart(6, '0'); };
const tagScript = (name, color) => `(() => { if (window.top !== window) return; const N = ${JSON.stringify(name)}, C = ${JSON.stringify(color)}, P = '【' + N + '】';
  const fix = () => { if (document.title && !document.title.startsWith(P)) document.title = P + document.title; else if (!document.title) document.title = P + location.hostname; };
  const put = () => { if (!document.documentElement || document.getElementById('__octa_tag')) return; const d = document.createElement('div'); d.id = '__octa_tag'; d.textContent = '🐙 ' + N;
    d.setAttribute('style', 'position:fixed;right:10px;top:10px;z-index:2147483647;background:' + C + ';color:#fff;font:600 13px/1 system-ui,sans-serif;padding:7px 12px;border-radius:999px;box-shadow:0 2px 10px rgba(0,0,0,.35);pointer-events:none;opacity:.92');
    document.documentElement.appendChild(d); fix(); new MutationObserver(fix).observe(document.querySelector('title') || document.head || document.documentElement, { childList: true, subtree: true, characterData: true });
    // a live cursor so you can watch what the bot does: glides to each mouse move, ripples on clicks, flashes what it clicked
    const cur = document.createElement('div'); cur.id = '__octa_cur';
    cur.innerHTML = '<svg width="26" height="26" viewBox="0 0 24 24"><path d="M3 2l7.5 19 2.6-7.9L21 10.5z" fill="' + C + '" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg><span></span>';
    cur.setAttribute('style', 'position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;transform:translate(-60px,-60px);transition:transform .38s cubic-bezier(.3,.8,.3,1),opacity .4s;opacity:0;filter:drop-shadow(0 2px 4px rgba(0,0,0,.4))');
    const lab = cur.querySelector('span'); lab.setAttribute('style', 'position:absolute;left:22px;top:20px;white-space:nowrap;background:' + C + ';color:#fff;font:600 11px/1 system-ui,sans-serif;padding:4px 7px;border-radius:999px;opacity:0;transition:opacity .2s');
    lab.textContent = N; document.documentElement.appendChild(cur);
    let idle, x = -60, y = -60; const wake = () => { cur.style.opacity = '1'; clearTimeout(idle); idle = setTimeout(() => { cur.style.opacity = '0' }, 8000); };
    // OCTA desktop: watch only puts a shield over the page, so every mouse event here is the bot's;
    // while the person has taken control it sets window.__octaUser and the cursor stays hidden instead of following them
    const mine = () => { if (!window.__octaUser) return false; cur.style.opacity = '0'; return true; };
    const move = (nx, ny) => { x = nx; y = ny; cur.style.transform = 'translate(' + (x - 3) + 'px,' + (y - 2) + 'px)'; wake(); };
    addEventListener('mousemove', e => { if (!mine()) move(e.clientX, e.clientY); }, true);
    addEventListener('mousedown', e => { if (mine()) return; move(e.clientX, e.clientY);
      const r = document.createElement('div'); r.setAttribute('style', 'position:fixed;z-index:2147483646;pointer-events:none;left:' + (e.clientX - 18) + 'px;top:' + (e.clientY - 18) + 'px;width:36px;height:36px;border-radius:50%;border:3px solid ' + C + ';transform:scale(.3);opacity:1;transition:transform .5s ease-out,opacity .5s');
      document.documentElement.appendChild(r); requestAnimationFrame(() => { r.style.transform = 'scale(1.6)'; r.style.opacity = '0'; }); setTimeout(() => r.remove(), 600);
      const t = e.target; if (t && t.style) { const o = t.style.outline, oo = t.style.outlineOffset; t.style.outline = '3px solid ' + C; t.style.outlineOffset = '2px'; setTimeout(() => { t.style.outline = o; t.style.outlineOffset = oo; }, 700); } }, true);
    addEventListener('keydown', () => { if (mine()) return; lab.textContent = '⌨️ ' + N + ' 輸入中'; lab.style.opacity = '1'; wake();
      const f = document.activeElement; if (f && f.getBoundingClientRect && x < 0) { const b = f.getBoundingClientRect(); move(b.left + 12, b.top + b.height / 2); }
      clearTimeout(lab._t); lab._t = setTimeout(() => { lab.style.opacity = '0'; lab.textContent = N; }, 900); }, true);
    addEventListener('focusin', e => { if (mine()) return; const b = e.target.getBoundingClientRect && e.target.getBoundingClientRect(); if (b && b.width && !(x >= b.left && x <= b.right && y >= b.top && y <= b.bottom)) move(b.left + Math.min(24, b.width / 2), b.top + b.height / 2); }, true); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', put); else put(); })()`;
async function tagBrowser(port, name) {
  if (tags.has(port) || typeof WebSocket === 'undefined') return;
  const v = await cdpInfo(port); if (!v) return;
  const ws = new WebSocket(v.webSocketDebuggerUrl), src = tagScript(name, colorOf(name)), done = new Set(), sess = new Map();
  tags.set(port, ws);
  let n = 0; const send = (method, params = {}, sessionId) => ws.send(JSON.stringify({ id: ++n, method, params, ...(sessionId ? { sessionId } : {}) }));
  const attach = t => { if (t.type === 'page' && !t.attached && !done.has(t.targetId)) { done.add(t.targetId); send('Target.attachToTarget', { targetId: t.targetId, flatten: true }); } };
  ws.onopen = () => { send('Target.setDiscoverTargets', { discover: true }); };
  ws.onmessage = e => { const m = JSON.parse(e.data);
    if (m.method === 'Target.targetCreated' || m.method === 'Target.targetInfoChanged') attach(m.params.targetInfo);
    // a page that was already loading when we attached: tag it again once its address changes
    if (m.method === 'Target.targetInfoChanged' && sess.has(m.params.targetInfo.targetId)) send('Runtime.evaluate', { expression: src }, sess.get(m.params.targetInfo.targetId));
    if (m.method === 'Target.attachedToTarget' && m.params.targetInfo.type === 'page') { const sid = m.params.sessionId; sess.set(m.params.targetInfo.targetId, sid);
      send('Page.addScriptToEvaluateOnNewDocument', { source: src }, sid); send('Runtime.evaluate', { expression: src }, sid); send('Runtime.runIfWaitingForDebugger', {}, sid); }
    if (m.method === 'Target.targetDestroyed') { done.delete(m.params.targetId); sess.delete(m.params.targetId); } };
  ws.onclose = ws.onerror = () => { tags.delete(port); };
}
export async function ensureBrowser(bot, opts) {
  const port = await openBrowser(bot, opts);
  if (shareBrowser) { await mergeOldProfiles().catch(e => log('合併舊登入失敗：' + e.message)); await syncIn(port); }
  return port;
}
// tell the bots' browsers apart: the profile is named after the bot and gets its own theme color
const BOT_COLORS = [0xFFD93025, 0xFF1A73E8, 0xFF188038, 0xFFF9AB00, 0xFF9334E6, 0xFFE8710A, 0xFF12B5CB, 0xFFE52592];
function markProfile(profile, name) {
  try {
    const f = join(profile, 'Default', 'Preferences');
    mkdirSync(join(profile, 'Default'), { recursive: true });
    let pr = {}; try { pr = JSON.parse(readFileSync(f, 'utf8')); } catch { }
    let h = 0; for (const ch of name) h = (h * 31 + ch.codePointAt(0)) >>> 0;
    const color = BOT_COLORS[h % BOT_COLORS.length] | 0;
    pr.profile = { ...(pr.profile || {}), name };
    pr.browser = { ...(pr.browser || {}), theme: { ...((pr.browser || {}).theme || {}), user_color: color, color_variant: 1 } };
    writeFileSync(f, JSON.stringify(pr));
  } catch (e) { log('瀏覽器標記失敗：' + e.message); }
}
const onDesk = new Set();
// 4.8.1: a bot's Chrome window keeps drawing and running its pages while it is behind other windows or minimised
// (Windows otherwise marks it occluded: pages go hidden, screenshots and waits time out)
export const CHROME_AWAKE = ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-features=CalculateNativeWinOcclusion'];
export const knownBots = new Map();
export const lookedBack = new Set();   // bots whose Chrome profile was already checked for a Google sign-in since this start
// Google refuses sign-in inside the embedded browser ("這個瀏覽器或應用程式可能有安全疑慮").
// From then on this bot uses a real Chrome window with its own profile, opened at the sign-in page.
export async function openBrowser(bot, opts = {}) {
  if (bot?.id && bot.name !== '監看') knownBots.set(bot.id, bot);
  if (cfg.embed && !cfg.embed.onGoogle) cfg.embed.onGoogle = switchToChrome;
  // 4.7: a bot in its Chrome window because of Google stays there (its Google sign-in lives in that profile);
  // it goes back into OCTA's browser only when the person presses 「改回內建瀏覽器」 (returnToEmbed, manual)
  if (cfg.embed && bot.browser !== 'mine' && !cfg.embed.external?.(bot.id)) {
    const port = embedPortOf(bot.id);
    try {
      if (!(await cdpInfo(port))) await cfg.embed.start(bot, port);
      for (let i = 0; i < 30 && !(await cdpInfo(port)); i++) await pause(100);
      if (await cdpInfo(port)) {
        browsers.set(bot.id, { port, last: Date.now(), embed: true });
        if (opts.show !== false) await cfg.embed.show?.(port, opts.expand ? 'open' : true);
        log(`🌐 ${bot.name} 的瀏覽器在 OCTA 裡`);
        await tagBrowser(port, bot.name).catch(() => { });
        return port;
      }
    } catch (e) { log('內建瀏覽器沒有起來，改開 Chrome：' + e.message); }
  }
  const port = portOf(bot.id);
  const key = bot.id;
  if (await cdpInfo(port)) {
    browsers.set(key, { port, last: Date.now() });
    if (!onDesk.has(port)) { onDesk.add(port); await cdp(port, async send => {   // a window an older version hid off-screen or minimised comes back onto the desktop
      const [p] = await pagesOf(send); if (!p) return;
      const { windowId, bounds } = await send('Browser.getWindowForTarget', { targetId: p.targetId });
      if (bounds.windowState === 'minimized' || bounds.left < -5000) { await send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } }).catch(() => { }); await send('Browser.setWindowBounds', { windowId, bounds: { left: 40 + ((port - 9311) % 6) * 60, top: 30 + ((port - 9311) % 6) * 40, width: 1200, height: 820 } }).catch(() => { }); }
    }).catch(() => { }); }
    await tagBrowser(port, bot.name).catch(() => { });
    return port;
  }
  const chrome = findChrome();
  if (!chrome) throw new Error('找不到 Google Chrome');
  const profile = botDir(bot.id).profile;
  mkdirSync(profile, { recursive: true });
  for (let i = 0; i < 10 && profileInUse(profile); i++) await pause(1000);   // an old window may still be closing
  if (profileInUse(profile)) throw new Error('這個機器人的瀏覽器有一個舊視窗開著，請先關掉它');
  markProfile(profile, bot.name);
  const child = spawn(chrome, [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--no-first-run', '--no-default-browser-check', `--window-name=OCTA｜${bot.name}`,
    `data:text/html;charset=utf-8,${encodeURIComponent(`<title>${bot.name} 的瀏覽器</title><body style="margin:0;display:grid;place-items:center;height:100vh;background:${colorOf(bot.name)};color:#fff;font:600 32px system-ui,sans-serif">🐙 ${bot.name.replace(/[<&]/g, '')} 的瀏覽器<div style="font:400 15px system-ui;opacity:.85;margin-top:12px">OCTA 機器人專用，登入後網站會共用給其他機器人</div></body>`)}`,
    '--restore-last-session', ...CHROME_AWAKE, `--window-position=${40 + ((port - 9311) % 6) * 60},${30 + ((port - 9311) % 6) * 40}`, '--window-size=1200,820'], { detached: true, stdio: 'ignore', windowsHide: false });
  child.on('error', () => { });
  child.unref();
  for (let i = 0; i < 40; i++) { if (await cdpInfo(port)) break; await pause(500); }
  if (!(await cdpInfo(port))) throw new Error('Chrome 沒有啟動');
  browsers.set(key, { port, last: Date.now(), profile });
  if (sessions.has(bot.id)) closeSession(bot.id);   // a waiting AI was connected to the old browser
  log(`🌐 ${bot.name} 的瀏覽器已在背景開啟`);
  // the window stays on the desktop (cascaded per bot) so you can click into any bot's browser at any time
  await tagBrowser(port, bot.name).catch(() => { });
  return port;
}

// browsers idle for 30 minutes and not on screen are closed to save memory (tabs come back next time)
// OCTA is closing: close every bot's browser (also ones a previous run left open), so the next start doesn't pile up windows
export async function closeAllBrowsers() {
  await Promise.all(savedPorts().map(async p => { if (await cdpInfo(p)) await cdp(p, send => send('Browser.close')).catch(() => { }); }));
  for (const ws of tags.values()) { try { ws.close(); } catch { } }
  tags.clear(); browsers.clear(); onDesk.clear();
}
// 4.16.2 瀏覽器一直開著 (and 客服模式): these bots' browsers stay open, and are opened again if they close
export const keepBrowsers = new Map();   // bot id → name
export function setKeepBrowsers(list) { if (!Array.isArray(list)) return; keepBrowsers.clear(); for (const b of list) if (b?.id) keepBrowsers.set(b.id, b.name || ''); }
export async function keepOpen() {
  for (const [id, name] of keepBrowsers) {
    const b = browsers.get(id);
    if (b && (await cdpInfo(b.port))) { b.last = Date.now(); continue; }
    try { await ensureBrowser({ id, name }, { show: false }); } catch (e) { log('瀏覽器打不開（一直開著）：' + e.message); }
  }
}
export async function reapBrowsers(all) {
  if (all) return closeAllBrowsers();
  for (const [id, b] of browsers) {
    const inUse = busyBots.has(id) || sessions.has(id) || keepBrowsers.has(id);
    if (!all && inUse) continue;   // in use, or an AI is waiting (待機)
    if (!all && Date.now() - b.last < 30 * 60000) continue;
    try {
      await cdp(b.port, async send => {
        if (!all) {
          const [p] = await pagesOf(send);
          if (p) { const { bounds } = await send('Browser.getWindowForTarget', { targetId: p.targetId }); if (bounds.left > -5000 && bounds.windowState !== 'minimized') return; }   // the user is looking at it
        }
        await send('Browser.close');
      });
      browsers.delete(id);
    } catch { browsers.delete(id); }
  }
}

// ---------- 4.8.1 watchdog: the bot's browser answers, and so does its page ----------
// The port can be up while the page under it is stuck (not drawing, a dead debugger): read it and take a tiny picture.
const within = (p, ms, what) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error(what + '逾時')), ms))]);
export async function browserHealth(port, ms = 6000) {
  if (!port || !(await cdpInfo(port))) return { ok: false, why: 'down' };
  try {
    return await within(cdp(port, async send => {
      const p = pickLivePage(await pagesOf(send));
      if (!p) return { ok: true, why: 'no-page' };
      const { sessionId } = await send('Target.attachToTarget', { targetId: p.targetId, flatten: true });
      try {
        await send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }, sessionId);
        await send('Page.captureScreenshot', { format: 'jpeg', quality: 10, clip: { x: 0, y: 0, width: 16, height: 16, scale: 1 } }, sessionId);
        return { ok: true, targetId: p.targetId };
      } finally { send('Target.detachFromTarget', { sessionId }).catch(() => { }); }
    }), ms, '瀏覽器檢查');
  } catch (e) { return { ok: false, why: 'stuck', error: e.message }; }
}
// before a job (and when the watchdog sees the port gone): bring the bot's browser back by itself.
// embedded: re-show / re-attach its pages (revive), else start it over; Chrome window: open it again.
// Returns the port that works, or throws an error with kind 'browser' (shown as 「瀏覽器沒有回應」).
export async function ensureHealthy(bot, port, opts = {}) {
  let h = await browserHealth(port);
  if (h.ok) return port;
  log(`🩺 ${bot.name} 的瀏覽器沒有回應（${h.why}${h.error ? '：' + h.error : ''}），自動修復中…`);
  const embedded = !!browsers.get(bot.id)?.embed || (cfg.embed && bot.browser !== 'mine' && !cfg.embed.external?.(bot.id) && port === embedPortOf(bot.id));
  if (embedded && h.why === 'stuck' && cfg.embed?.revive) {
    try { if (await cfg.embed.revive(port)) { h = await browserHealth(port); if (h.ok) { log(`🩺 ${bot.name} 的瀏覽器恢復了`); return port; } } } catch (e) { log('修復瀏覽器：' + e.message); }
  }
  if (!embedded && h.why === 'stuck') {   // a Chrome window whose page hangs: load the page again first
    try { await within(cdp(port, async send => { const p = pickLivePage(await pagesOf(send)); if (p) { const { sessionId } = await send('Target.attachToTarget', { targetId: p.targetId, flatten: true }); await send('Page.reload', {}, sessionId); } }), 6000, '重新載入'); } catch { }
    await pause(2000);
    h = await browserHealth(port);
    if (h.ok) { log(`🩺 ${bot.name} 的瀏覽器恢復了`); return port; }
  }
  // start it over: a waiting AI connected to the old one starts fresh too
  if (sessions.has(bot.id)) closeSession(bot.id);
  if (embedded) { try { await cfg.embed.stop?.(port); } catch { } }
  else if (h.why === 'stuck') { try { await cdp(port, send => send('Browser.close')); } catch { } await pause(1500); }
  browsers.delete(bot.id);
  let again = 0;
  try { again = await openBrowser(bot, { show: opts.show === true }); } catch (e) { h = { ok: false, why: 'down', error: e.message }; }
  if (again) { for (let i = 0; i < 3 && !(h = await browserHealth(again)).ok; i++) await pause(1000); }
  if (again && h.ok) { log(`🩺 ${bot.name} 的瀏覽器已重新開好`); return again; }
  const err = new Error(`瀏覽器沒有回應（已自動重開仍不行${h.error ? '：' + h.error : ''}）`);
  err.kind = 'browser';
  throw err;
}

// 4.2 手機遙控: the CDP port of the browser this bot uses right now (OCTA's embedded one or its Chrome window), 0 if none is open.
// It never opens a browser: the phone watches what is already there.
export async function livePortOf(bot) {
  if (!bot?.id || bot.browser === 'mine') return 0;
  const tries = [browsers.get(bot.id)?.port, cfg.embed && !cfg.embed.external?.(bot.id) ? embedPortOf(bot.id) : 0, portOf(bot.id)];
  for (const p of [...new Set(tries.filter(Boolean))]) if (await cdpInfo(p)) return p;
  return 0;
}
