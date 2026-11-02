// OCTA runner: what the bot's browser shows (live picture, screenshots, showing/hiding the window) and 監看網頁.
import { writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import { api } from './api-client.mjs';
import {
  browsers, busyBots, cdp, cdpInfo, embedPortOf, ensureBrowser, pagesOf, pause, pickLivePage, portOf,
  setShareBrowser, shareBrowser, syncOut, touchBrowser
} from './browser.mjs';
import { convDir, freeName, rel, safeName } from './files.mjs';
import { standby, stopped } from './loop.mjs';
import { GOOGLE_HOME, cfg, log } from './state.mjs';
import { sessions } from './warm.mjs';

export async function pushLive(port, job) {
  // nobody has this bot's browser open: don't upload frames, just check every 6 s whether someone started watching or took over
  if (!job.liveWatch) {
    if (Date.now() - (job.livePeek || 0) < 6000) return;
    job.livePeek = Date.now();
    const p = await api('runner/live', { bot: job.bot.id, peek: 1 });
    if (p.hand) { job.handed = true; job.stopForHand?.(); }
    if (!p.watch) return;
    job.liveWatch = true;
  }
  const shot = await browserSnapshot(port, 0, 40);
  if (!shot?.jpeg || shot.jpeg.length > 350000) return;
  let title = '';
  try { title = (pickLivePage(await cdp(port, send => pagesOf(send)))?.title || '').slice(0, 80); } catch { }
  const r = await api('runner/live', { bot: job.bot.id, url: realPage(shot.url) || '', title, data: shot.jpeg.toString('base64') });
  if (r.hand) { job.handed = true; job.stopForHand?.(); }
  if (r.watch === false) job.liveWatch = false;
}
export async function captureEyes(port, dir) {
  try {
    const live = await browserSnapshot(port);
    if (!live?.jpeg) return '';
    const p = join(dir, '畫面.jpg');
    writeFileSync(p, live.jpeg);
    return p;
  } catch (e) { log('看畫面失敗：' + e.message); return ''; }
}
export async function browserSnapshot(port, since, quality = 70) {   // screenshot + address of the tab the bot used last
  const q = Math.min(80, Math.max(20, +quality || 70));
  return cdp(port, async send => {
    const p = pickLivePage(await pagesOf(send));
    if (!p) return null;
    const { sessionId } = await send('Target.attachToTarget', { targetId: p.targetId, flatten: true });
    let jpeg = null;
    try { jpeg = Buffer.from((await send('Page.captureScreenshot', { format: 'jpeg', quality: q }, sessionId)).data, 'base64'); } catch { }
    await send('Target.detachFromTarget', { sessionId }).catch(() => { });
    return { url: p.url, jpeg };
  });
}
export const realPage = u => (u && !/^(about:|data:|chrome:)/.test(u)) ? u : '';
const blankPage = u => !u || /^(about:|data:|chrome:)/.test(u);
export function browserWindowAsk(text) {
  const t = String(text || '');
  if (/不要關|別關|先別關/.test(t)) return '';
  if (/關閉瀏覽器|關掉瀏覽器|把瀏覽器關|收起瀏覽器|瀏覽器收起來|瀏覽器關掉/.test(t)) return 'close';
  if (/打開瀏覽器|開啟瀏覽器|開瀏覽器|把瀏覽器打開/.test(t)) return 'open';
  return '';
}
export function takeWindowMarks(text) {
  const raw = String(text || '');
  const open = raw.match(/【開瀏覽器】\s*(https?:\/\/\S+)?/);
  return { close: /【關瀏覽器】/.test(raw), open: open ? (open[1] || GOOGLE_HOME) : '' };
}
export async function settleBrowserWindow(port, job) {
  const ask = browserWindowAsk(job.prompt);
  if (ask === 'close') {
    try { await showBrowser(port, '', true, false); } catch (e) { log('關閉瀏覽器：' + e.message); }
    job.windowNote = '使用者要你關閉瀏覽器。視窗已經收起來了。回覆直接說已經關閉。禁止說「沒有控制工具」「沒辦法替你關閉」「無法操作瀏覽器視窗」。';
  } else if (ask === 'open') {
    try { await showBrowser(port, '', false, true); } catch (e) { log('打開瀏覽器：' + e.message); }
    job.windowNote = '使用者要你打開瀏覽器。沒有指定網址時，已經在 OCTA 視窗裡打開內嵌的 Google。直接說已經打開，不要叫他先輸入網址。';
  }
}
export async function finishBrowserWindow(port, job, text) {
  const marks = takeWindowMarks(text);
  if (marks.close) { try { await showBrowser(port, '', true, false); } catch (e) { log('關閉瀏覽器：' + e.message); } }
  if (marks.open) { try { await showBrowser(port, marks.open, false, true); } catch (e) { log('打開瀏覽器：' + e.message); } }
  let out = String(text || '').replace(/【關瀏覽器】/g, '').replace(/【開瀏覽器】\s*(https?:\/\/\S+)?/g, '').trim();
  if (browserWindowAsk(job.prompt) === 'close' && /控制工具|沒能替你關閉|沒辦法替你關閉|無法關閉|無法操作/.test(out)) out = '瀏覽器已經關閉。';
  if (browserWindowAsk(job.prompt) === 'open' && /先輸入網址|先打網址|沒有控制工具/.test(out)) out = '瀏覽器已經打開，裡面是 Google。';
  if (out) return out;
  if (marks.close || browserWindowAsk(job.prompt) === 'close') return '瀏覽器已經關閉。';
  if (marks.open || browserWindowAsk(job.prompt) === 'open') return '瀏覽器已經打開，裡面是 Google。';
  return text;
}
export async function showBrowser(port, url, hide, expand) {
  const embed = [...browsers.values()].some(b => b.port === port && b.embed);
  if (embed) await cfg.embed?.show?.(port, hide ? false : (expand ? 'open' : true));
  return cdp(port, async send => {
    const pages = await pagesOf(send);
    const live = pickLivePage(pages);
    let targetId = live?.targetId;
    const dest = hide ? '' : (url || (blankPage(live?.url) ? GOOGLE_HOME : ''));
    if (dest || !targetId) targetId = (await send('Target.createTarget', { url: dest || GOOGLE_HOME })).targetId;
    const seen = async () => realPage((await pagesOf(send)).find(p => p.targetId === targetId)?.url);
    if (hide || !targetId) return seen();   // handing back: the window stays where it is on the desktop
    const { windowId } = await send('Browser.getWindowForTarget', { targetId });
    await send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } }).catch(() => { });
    if (!embed) {
      const { bounds } = await send('Browser.getWindowForTarget', { targetId });
      if (bounds.left < -5000) await send('Browser.setWindowBounds', { windowId, bounds: { left: 60, top: 40, width: 1200, height: 820 } });   // windows from older versions sat off-screen
    }
    await send('Target.activateTarget', { targetId });
    return seen();
  });
}
async function rememberOpen(port, job) {   // the phone is waiting for the address and a picture of what the computer opened
  let seen = '', jpeg = null;
  for (let i = 0; i < 8; i++) {
    const live = await browserSnapshot(port).catch(() => null);
    const url = realPage(live?.url);
    if (url) seen = url;
    if (live?.jpeg) jpeg = live.jpeg;
    if (jpeg && (seen || i === 7)) break;
    await pause(400);
  }
  if (jpeg) {
    try {
      const conv = job.conv?.id ? job.conv : job.bot;
      const p = freeName(join(convDir(conv), '截圖'), safeName(job.bot.name) + '-畫面.jpeg');
      writeFileSync(p, jpeg);
      await api('runner/shot', { id: job.id, path: rel(p), name: basename(p), size: jpeg.length });
    } catch (e) { log('截圖儲存失敗：' + e.message); }
  }
  return seen;
}
export async function openJob(job) {
  setShareBrowser(job);
  const done = (ok, text, page) => { log(`🌐 ${job.bot.name}：${text}`); return api('runner/done', { id: job.id, ok, text, ...(page ? { page } : {}) }).catch(() => { }); };
  const hide = job.url === 'octa:hide';
  const expand = String(job.url || '').startsWith('octa:open');
  const page = expand ? String(job.url).slice('octa:open'.length).trim() : (hide ? '' : (job.url || ''));
  try {
    const ports = [...new Set([browsers.get(job.bot.id)?.port, cfg.embed && job.bot.browser !== 'mine' && !cfg.embed.external?.(job.bot.id) ? embedPortOf(job.bot.id) : 0, portOf(job.bot.id)].filter(Boolean))];
    if (hide && (await Promise.all(ports.map(p => cdpInfo(p)))).every(v => !v)) return done(true, '我的瀏覽器已經收起來了。');
    const port = await ensureBrowser(job.bot, { show: !hide, expand });
    const landed = realPage(await showBrowser(port, page, hide, expand));
    touchBrowser(job.bot.id);
    if (hide && shareBrowser) await syncOut(port);   // signed in by hand: every bot gets it
    if (hide) return done(true, '我的瀏覽器已收到背景，我會繼續在裡面工作。');
    const seen = await rememberOpen(port, job);
    const where = browsers.get(job.bot.id)?.embed ? (expand ? 'OCTA 視窗裡，按「收回」會縮回角落' : 'OCTA 視窗的角落縮圖，點一下可以打開') : '電腦上';
    return done(true, busyBots.has(job.bot.id) ? `我的瀏覽器已經在${where}，我正在裡面工作，先別操作；要幫我登入請等我停下來。`
      : `我的瀏覽器已經在${where}。需要登入就直接在裡面登入，好了回來按「登入好了，繼續」。`, seen || landed || realPage(page));
  } catch (e) { return done(false, '⚠ 無法打開瀏覽器：' + e.message); }
}
// ---------- 監看網頁: check pages in the bot's own browser, start the routine only when they change ----------
// No AI is used for checking, so it costs no tokens; the bot is called only when something new shows up.
export let watches = [], watchesAt = 0;
export const lastLook = new Map();
export function resetWatches() { watchesAt = 0; lastLook.clear(); }
async function readPage(port, url, sel) {
  return cdp(port, async send => {
    const { targetId } = await send('Target.createTarget', { url, background: true });
    try {
      const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
      const ev = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true }, sessionId)).result?.value;
      for (let i = 0; i < 40 && (await ev('document.readyState').catch(() => '')) !== 'complete'; i++) await pause(500);
      await pause(4000);   // pages that load their content afterwards (chat lists, dashboards)
      const s = JSON.stringify(sel || '');
      return String(await ev(`(()=>{const sel=${s};const els=sel?[...document.querySelectorAll(sel)]:[document.body];return els.map(e=>e.innerText).join('\\n')})()`) || '').slice(0, 8000);
    } finally { await send('Target.closeTarget', { targetId }).catch(() => { }); }
  });
}
export async function checkWatches() {
  if (standby || stopped) return;
  if (Date.now() - watchesAt > 5 * 60000) { watchesAt = Date.now(); try { watches = (await api('runner/watches', {})).watches || []; } catch { } }
  for (const w of watches) {
    if (Date.now() - (lastLook.get(w.id) || 0) < (w.every || 10) * 60000) continue;
    if (busyBots.has(w.bot) || sessions.get(w.bot)?.turn) continue;   // don't disturb a bot at work
    lastLook.set(w.id, Date.now());
    try {
      const port = await ensureBrowser({ id: w.bot, name: '監看' }, { show: false });
      const text = (await readPage(port, w.url, w.sel)).replace(/\d{1,2}:\d{2}(:\d{2})?/g, '').trim();   // ignore clocks on the page
      const hash = createHash('sha1').update(text).digest('hex');
      const r = await api('runner/watched', { id: w.id, hash, text });
      if (r.changed) log(`👀 監看的網頁有變化：${w.url}`);
    } catch (e) { log('監看失敗：' + e.message); }
  }
}
