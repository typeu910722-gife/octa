// OCTA runner: Google sign-in — switching a bot to a real Chrome window and back into OCTA's browser.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { chatNote } from './api-client.mjs';
import {
  addToJar, browsers, busyBots, cdp, cdpInfo, embedPortOf, knownBots, lookedBack, openBrowser, pagesOf, pause,
  pickLivePage, portOf, profileInUse, shareBrowser
} from './browser.mjs';
import { findChrome } from './files.mjs';
import { realPage, showBrowser } from './live.mjs';
import { cfg, log, workDir } from './state.mjs';
import { cookieParams } from './transfer.mjs';
import { closeSession, sessions } from './warm.mjs';

// Google's own cookies (sign-in, account choice): bound to the browser they were made in, never copied between browsers
const GOOGLE_DOMAIN = /(^|\.)(google\.[a-z.]+|gmail\.com|youtube\.com|googleusercontent\.com|gstatic\.com|googleapis\.com|withgoogle\.com)$/i;
export const isGoogleCookie = c => GOOGLE_DOMAIN.test(String(c?.domain || '').replace(/^\./, ''));
// a job that needs a Google account (Gmail, Drive, Calendar, Docs/Sheets, YouTube Studio, Business Profile…):
// it runs in the bot's own Chrome window, where Google lets it sign in and keeps it signed in
const GOOGLE_WORK = /gmail|mail\.google|google\s*(drive|雲端|日曆|calendar|docs?|文件|sheets?|試算表|表單|forms?|帳號|帳戶|account|商家|business|ads|analytics|search console|meet|photos|相簿|聯絡人|contacts)|雲端硬碟|docs\.google|drive\.google|calendar\.google|youtube\s*studio|accounts\.google/i;
export const wantsGoogle = job => GOOGLE_WORK.test(`${job?.prompt || ''}\n${job?.bot?.task || ''}`);
// before such a job: the bot moves to its Chrome window once (and stays there)
export async function chromeForGoogle(bot) {
  if (!cfg.embed?.useChrome || bot?.browser === 'mine' || cfg.embed.external?.(bot.id)) return false;
  if (!findChrome()) return false;
  cfg.embed.useChrome(bot.id);
  if (browsers.get(bot.id)?.embed) browsers.delete(bot.id);
  if (sessions.has(bot.id)) closeSession(bot.id);   // a waiting AI was connected to the in-app browser
  try { await cfg.embed.stop?.(embedPortOf(bot.id)); } catch { }
  log(`🌐 ${bot.name}：要用 Google 帳號，改用這個機器人自己的 Chrome 視窗`);
  await chatNote(bot.id, '這件要用 Google 帳號（Gmail 等）。Google 不讓 OCTA 內建瀏覽器登入，所以這個機器人改用自己的 Chrome 視窗，登入會一直留在那裡。第一次需要登入時，在 Chrome 視窗或手機按「接手」登入一次就好。').catch(() => { });
  return true;
}
export function googleSignInUrl(url) {
  let u; try { u = new URL(url); } catch { return ''; }
  if (u.hostname !== 'accounts.google.com' || !/signin|ServiceLogin|AddSession|rejected/i.test(u.pathname)) return '';
  const cont = u.searchParams.get('continue') || 'https://www.google.com/';
  return 'https://accounts.google.com/ServiceLogin?continue=' + encodeURIComponent(cont);
}
export async function switchToChrome(botId, url, info = {}) {
  const bot = knownBots.get(botId);
  const dest = googleSignInUrl(url);
  if (!bot || !dest || !cfg.embed) return false;
  lookedBack.add(botId);
  if (browsers.get(botId)?.embed) browsers.delete(botId);
  try { await cfg.embed.stop?.(embedPortOf(botId)); } catch { }
  try {
    const port = await openBrowser(bot, { noBack: true });
    await showBrowser(port, dest, false, true);
    log(`🌐 ${bot.name}：Google 不讓內嵌瀏覽器登入，已改用 Chrome 視窗`);
    // 4.7: it stays in the Chrome window (no automatic way back: a copied Google sign-in logs out again)
    await chatNote(botId, 'Google 不讓 OCTA 內建瀏覽器登入，這個機器人改用自己的 Chrome 視窗，Google 的登入會一直留在那裡（重開 OCTA 也一樣）。在 Chrome 視窗或手機按「接手」登入一次就好。').catch(() => { });
    return true;
  } catch (e) { log('改用 Chrome 失敗：' + e.message); return false; }
}
// ---------- back from the Chrome window into OCTA's browser once Google's sign-in is done ----------
// Google keeps the sign-in in these cookies on .google.com; any one of them (not expired) means signed in
const GOOGLE_SID = ['SID', '__Secure-1PSID', '__Secure-3PSID'];
export function googleSignedIn(cookies, now = Date.now() / 1000) {
  return (cookies || []).some(c => c && GOOGLE_SID.includes(c.name) && c.value && /^\.?google\.com$/i.test(String(c.domain || '')) && !(+c.expires > 0 && +c.expires < now));
}
// what the sign-in looks like now: a new sign-in (or another account) changes it
export function googleLoginMark(cookies, now = Date.now() / 1000) {
  if (!googleSignedIn(cookies, now)) return '';
  return (cookies || []).filter(c => c && GOOGLE_SID.includes(c.name) && /^\.?google\.com$/i.test(String(c.domain || '')))
    .map(c => c.name + '=' + c.value).sort().join(';');
}
// signed in, and not just the sign-in the profile already had when Google refused OCTA's browser
export function googleLoginDone(before, cookies, now = Date.now() / 1000) {
  const mark = googleLoginMark(cookies, now);
  return !!mark && mark !== before;
}
// a bot's Chrome profile: read straight from its window, or (closed) by opening it briefly without a window
export async function chromeCookies(bot) {
  const port = portOf(bot.id);
  if (await cdpInfo(port)) { const { cookies = [] } = await cdp(port, send => send('Storage.getCookies')); return { cookies, port, open: true }; }
  const profile = join(workDir, 'bots', String(bot.id).replace(/[^\w-]/g, ''), 'profile'), chrome = findChrome();
  if (!chrome || !existsSync(profile) || profileInUse(profile)) return { cookies: [], port: 0, open: false };
  const tmp = 9389;
  const child = spawn(chrome, [`--user-data-dir=${profile}`, `--remote-debugging-port=${tmp}`, '--headless=new', '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore', windowsHide: true });
  child.on('error', () => { });
  try {
    for (let i = 0; i < 40 && !(await cdpInfo(tmp)); i++) await pause(300);
    const { cookies = [] } = await cdp(tmp, send => send('Storage.getCookies'));
    await cdp(tmp, send => send('Browser.close')).catch(() => { });
    return { cookies, port: 0, open: false };
  } finally { try { child.kill(); } catch { } }
}
const chromeWatch = new Map();   // bot id → timer that looks for a finished Google sign-in in its Chrome window
function stopChromeWatch(id) { clearInterval(chromeWatch.get(id)); chromeWatch.delete(id); }
function watchChromeLogin(bot, before) {
  stopChromeWatch(bot.id);
  const until = Date.now() + 30 * 60000;
  let looking = false;
  const t = setInterval(async () => {
    if (looking) return;
    if (Date.now() > until || !cfg.embed?.external?.(bot.id)) return stopChromeWatch(bot.id);
    if (busyBots.has(bot.id)) return;   // working in that window now: switch once the job has stopped
    looking = true;
    try {
      const port = portOf(bot.id);
      if (!(await cdpInfo(port))) return;
      const { cookies = [] } = await cdp(port, send => send('Storage.getCookies'));
      if (!googleLoginDone(before, cookies)) return;
      stopChromeWatch(bot.id);
      const r = await returnToEmbed(bot, { cookies });
      if (r.ok) await chatNote(bot.id, `已在 Chrome 視窗登入 Google，瀏覽器已改回 OCTA 內建（帶入 ${r.cookies} 筆網站登入），Chrome 視窗已關閉。`);
    } catch (e) { log('檢查 Chrome 登入失敗：' + e.message); }
    finally { looking = false; }
  }, 4000);
  t.unref?.();
  chromeWatch.set(bot.id, t);
}
export const backing = new Set();
// Chrome window → OCTA's browser: take the window's sign-ins (Google and every other site), forget the Chrome mode,
// close the window and open the bot's browser in OCTA at the page it was on. opts.cookies: already read
export async function returnToEmbed(bot, opts = {}) {
  if (!bot?.id) return { ok: false, error: '找不到機器人' };
  if (!cfg.embed?.useEmbedded) return { ok: false, error: '只有電腦版 OCTA 有內建瀏覽器' };
  if (bot.name === undefined && knownBots.has(bot.id)) bot = knownBots.get(bot.id);
  else if (knownBots.has(bot.id)) bot = { ...knownBots.get(bot.id), ...bot };
  if (opts.manual && busyBots.has(bot.id)) return { ok: false, error: '機器人正在工作，等它停下來再切換' };
  if (backing.has(bot.id)) return { ok: false, error: '正在切換中' };
  backing.add(bot.id);
  try {
    stopChromeWatch(bot.id);
    let cookies = opts.cookies, page = '';
    const port = portOf(bot.id);
    try {
      if (!cookies) ({ cookies } = await chromeCookies(bot));
      if (await cdpInfo(port)) {
        try { const live = pickLivePage(await cdp(port, send => pagesOf(send))); if (live && !/accounts\.google\.com/.test(live.url || '')) page = realPage(live.url); } catch { }
      }
    } catch (e) { log('讀取 Chrome 登入失敗：' + e.message); cookies = cookies || []; }
    cfg.embed.useEmbedded(bot.id);
    if (sessions.has(bot.id)) closeSession(bot.id);   // a waiting AI was connected to the Chrome window
    browsers.delete(bot.id);
    if (await cdpInfo(port)) await cdp(port, send => send('Browser.close')).catch(() => { });
    const embedPort = await openBrowser(bot, { show: opts.show !== false && !opts.quiet, noBack: true });
    if (!browsers.get(bot.id)?.embed) return { ok: false, error: '內建瀏覽器沒有起來' };
    // Google's own cookies stay in the Chrome profile: copied here they only lead to a sign-in loop
    const list = cookieParams((cookies || []).filter(c => !isGoogleCookie(c)));
    if (list.length) await cdp(embedPort, send => send('Storage.setCookies', { cookies: list })).catch(e => log('帶入 Chrome 登入失敗：' + e.message));
    if (shareBrowser && list.length) addToJar(cookies);   // (addToJar leaves Google's out)
    if (page && opts.show !== false && !opts.quiet) await showBrowser(embedPort, page, false, false).catch(() => { });
    log(`🌐 ${bot.name || bot.id}：瀏覽器改回 OCTA 內建（帶入 ${list.length} 筆登入）`);
    return { ok: true, cookies: list.length, google: false, port: embedPort };
  } finally { backing.delete(bot.id); }
}
