// 4.16 客服模式 on the host computer: every few seconds, read the chat page that is already open in the bot's browser
// (no reload, no AI, no tokens) and tell the server what it shows; the server gives the bot a job only for new lines.
// A bot at work is left alone (it is answering); its browser is kept open while the mode is on.
import { createHash } from 'node:crypto';
import { api } from './api-client.mjs';
import { busyBots, cdp, ensureBrowser, pagesOf, pause, touchBrowser } from './browser.mjs';
import { standby, stopped } from './loop.mjs';
import { log } from './state.mjs';
import { sessions } from './warm.mjs';

let list = [], listAt = 0, running = false;
const lastLook = new Map();
const failed = new Map(); // bot → when the last failure was logged (one line a minute at most)
// the same chat page: same site and path (a query string or #hash that changes as you click around doesn't matter)
export function samePage(a, b) {
  try {
    const x = new URL(a), y = new URL(b);
    return x.origin === y.origin && (y.pathname === '/' || x.pathname.replace(/\/+$/, '').startsWith(y.pathname.replace(/\/+$/, '')));
  } catch { return false; }
}
// times on the page (14:41, 下午2:41) change by themselves: not a new message
export const svcText = t => String(t || '').replace(/(上午|下午)?\s*\d{1,2}:\d{2}(:\d{2})?/g, '').split('\n').map(l => l.replace(/[ \t]+/g, ' ').trim()).filter(Boolean).join('\n');
export async function readChat(port, url, sel) {
  return cdp(port, async send => {
    let page = (await pagesOf(send)).filter(p => samePage(p.url, url)).at(-1);
    let opened = false;
    if (!page) {   // not open yet: open it once and keep it (later looks read the same tab)
      const { targetId } = await send('Target.createTarget', { url, background: true });
      page = { targetId };
      opened = true;
    }
    const { sessionId } = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
    const ev = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true }, sessionId)).result?.value;
    if (opened) { for (let i = 0; i < 40 && (await ev('document.readyState').catch(() => '')) !== 'complete'; i++) await pause(500); await pause(3000); }
    const s = JSON.stringify(sel || '');
    const text = await ev(`(()=>{const sel=${s};const els=sel?[...document.querySelectorAll(sel)]:[document.body];return els.map(e=>e.innerText).join('\\n')})()`);
    await send('Target.detachFromTarget', { sessionId }).catch(() => { });
    return String(text || '').slice(-12000);
  });
}
export async function checkService() {
  if (running || standby || stopped) return;
  running = true;
  try {
    // every 3 s: a webhook may have rung (4.16.1) — then it looks at once instead of waiting for its turn
    if (Date.now() - listAt > 3000) { listAt = Date.now(); try { list = (await api('runner/svc', {})).svc || []; } catch { } }
    for (const s of list) {
      const rung = s.ring && s.ring > (lastLook.get(s.bot) || 0) - 5000;
      if (!rung && Date.now() - (lastLook.get(s.bot) || 0) < (s.sec || 10) * 1000 - 300) continue;
      if (rung && Date.now() - (lastLook.get(s.bot) || 0) < 1500) continue;   // rung: every 1.5 s until the message shows
      lastLook.set(s.bot, Date.now());
      touchBrowser(s.bot);
      if (busyBots.has(s.bot) || sessions.get(s.bot)?.turn) continue;   // it is answering right now
      try {
        const port = await ensureBrowser({ id: s.bot, name: '客服模式' }, { show: false });
        const text = svcText(await readChat(port, s.url, s.sel));
        const hash = createHash('sha1').update(text).digest('hex');
        const r = await api('runner/svc/seen', { bot: s.bot, hash, text });
        if (r.changed) log('🎧 客服模式：有新訊息，交給機器人回覆');
        if (r.stop) listAt = 0;
      } catch (e) {
        if (Date.now() - (failed.get(s.bot) || 0) > 60000) { failed.set(s.bot, Date.now()); log('客服模式看不到聊天畫面：' + e.message); api('runner/svc/seen', { bot: s.bot, error: e.message }).catch(() => { }); }
      }
    }
  } finally { running = false; }
}
export const resetService = () => { list = []; listAt = 0; lastLook.clear(); };
