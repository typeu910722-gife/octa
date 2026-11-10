// 4.16 客服模式: a bot keeps an eye on one chat page for a while and answers every new message.
// The host computer looks at the page every few seconds in the bot's own browser — no AI, no tokens — and only when
// new lines show up does the bot get a job (〔客服模式〕 + what is new + your rules). It ends by itself at the time set.
//   GET  svc/<bot>                → {on, url, sel, sec, until, rules, started, replies}
//   POST svc/<bot>                {url, sel?, sec, minutes (0 = until you stop it), rules?} → starts (or changes) it
//   POST svc/<bot>/stop
//   POST runner/svc               → the pages the host checks now (ends the ones whose time is up)
//   POST runner/svc/seen          {bot, hash, text} → new lines: a job for the bot
// A bot that is already answering is not given a second job; the page it saw after answering becomes the new baseline
// (its own reply is not a new message), and it is told to read the chat again before it finishes.
import { addJob, addMsg, bump } from './db.mjs';
import { localNow } from './schedule.mjs';
import { J, MIN, clean, err, now } from './util.mjs';

export const SVC_TAG = '〔客服模式〕';
export const SVC_SECS = [5, 10, 20, 30, 60];
export const SVC_MINS = [15, 30, 60, 120, 240, 480, 0]; // 0: until you stop it
const TABLE =
  'CREATE TABLE IF NOT EXISTS svc (bot_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, url TEXT NOT NULL, sel TEXT, sec INTEGER NOT NULL, until INTEGER, rules TEXT, started INTEGER NOT NULL, replies INTEGER NOT NULL DEFAULT 0, state TEXT, rebase INTEGER, on_ INTEGER NOT NULL DEFAULT 1)';
const ready = new WeakSet();
// 4.16.1: ring (a webhook said a message came in: look now), wait (seconds to let a person or LINE's auto-reply go
// first), mode (reply: answer in the chat · draft: write the answer for you to approve, never send it)
// 4.16.3 seen_at: the last time the computer looked at the chat · err: why it couldn't (shown in OCTA, told to the bot)
const COLS = ['ring INTEGER', 'wait INTEGER', 'mode TEXT', 'seen_at INTEGER', 'err TEXT'];
async function ensure(db) {
  if (ready.has(db)) return;
  await db.prepare(TABLE).run();
  for (const c of COLS) {
    try {
      await db.prepare('ALTER TABLE svc ADD COLUMN ' + c).run();
    } catch {} // already there
  }
  ready.add(db);
}
export const SVC_WAITS = [0, 10, 30, 60];
const RING_MS = 30000;
const pub = r =>
  r
    ? { on: !!r.on_, url: r.url, sel: r.sel || '', sec: r.sec, until: r.until || null, rules: r.rules || '', started: r.started, replies: r.replies || 0, wait: r.wait || 0, mode: r.mode === 'draft' ? 'draft' : 'reply', seenAt: r.seen_at || null, err: r.err || '' }
    : { on: false };
export async function svcOf(db, U) {
  await ensure(db);
  const rows = (await db.prepare('SELECT * FROM svc WHERE user_id=? AND on_=1').bind(U).all()).results;
  return Object.fromEntries(rows.map(r => [r.bot_id, pub(r)]));
}
// what the person (or the bot, with 🎧客服模式) asked for → a checked plan, or an error
export function svcPlan(b) {
  let url = clean(b?.url, 500);
  if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) throw 0;
  } catch {
    return { error: '要看的聊天網址不對' };
  }
  const sec = SVC_SECS.includes(+b?.sec) ? +b.sec : 10;
  const minutes = SVC_MINS.includes(+b?.minutes) ? +b.minutes : Number.isFinite(+b?.minutes) && +b.minutes > 0 ? Math.min(24 * 60, Math.round(+b.minutes)) : 60;
  const wait = SVC_WAITS.includes(+b?.wait) ? +b.wait : 0;
  return { url, sel: clean(b?.sel, 200), sec, minutes, rules: clean(b?.rules, 2000), wait, mode: b?.mode === 'draft' ? 'draft' : 'reply' };
}
const endText = (env, until) => (until ? `到 ${localNow(env, until).hm}` : '直到你說停');
export async function svcStart(env, db, U, bot, plan) {
  await ensure(db);
  const until = plan.minutes ? now() + plan.minutes * MIN : null;
  await db
    .prepare(
      'INSERT INTO svc (bot_id,user_id,url,sel,sec,until,rules,started,replies,state,rebase,on_,ring,wait,mode) VALUES (?,?,?,?,?,?,?,?,0,NULL,NULL,1,NULL,?,?) ON CONFLICT(bot_id) DO UPDATE SET url=excluded.url, sel=excluded.sel, sec=excluded.sec, until=excluded.until, rules=excluded.rules, started=excluded.started, replies=0, state=NULL, rebase=NULL, on_=1, ring=NULL, wait=excluded.wait, mode=excluded.mode, seen_at=NULL, err=NULL'
    )
    .bind(bot.id, U, plan.url, plan.sel || null, plan.sec, until, plan.rules || null, now(), plan.wait || 0, plan.mode || 'reply')
    .run();
  await addMsg(db, U, bot.id, 'sys', `🎧 客服模式開始：每 ${plan.sec} 秒看一次 ${plan.url}，有新訊息就${plan.mode === 'draft' ? '擬好回覆給你確認' : '回覆'}，${endText(env, until)}。沒有新訊息時不會用到 AI。`);
  await bump(db, U);
}
export async function svcStop(env, db, U, botId, why = '') {
  await ensure(db);
  const r = await db.prepare('SELECT * FROM svc WHERE bot_id=? AND user_id=? AND on_=1').bind(botId, U).first();
  if (!r) return false;
  await db.prepare('UPDATE svc SET on_=0 WHERE bot_id=?').bind(botId).run();
  await addMsg(db, U, botId, 'sys', `🎧 客服模式${why || '已結束'}（回覆了 ${r.replies || 0} 次）`);
  await bump(db, U);
  return true;
}
/* 4.16.1 Webhook 當門鈴: a message event for a bot in 客服模式 doesn't start its own job (it would answer from the event
   alone, without the chat around it, and could answer a customer a person is already talking to). It only tells the
   computer to look at the chat now; the answer is written from the chat itself. → true when 客服模式 took it. */
export async function svcRing(db, U, botId) {
  await ensure(db);
  const r = await db.prepare('UPDATE svc SET ring=? WHERE bot_id=? AND user_id=? AND on_=1 AND (until IS NULL OR until>?)').bind(now(), botId, U, now()).run();
  if (!r?.meta?.changes) return false;
  await bump(db, U);
  return true;
}
// the person's (or the bot's) words: 「客服模式」 starts, 「測試結束／停止客服」 ends — used by runner-done for 🎧 lines
export const SVC_START_RE = /^\s*🎧\s*客服模式[:：]\s*(.+?)\s*[｜|]\s*(\d+)\s*秒?\s*[｜|]\s*(\d+|不限)\s*(?:分鐘?)?\s*(?:[｜|]\s*(.*))?$/m;
export const SVC_END_RE = /^\s*🎧\s*客服模式(結束|停止)\s*$/m;

const lines = t =>
  String(t || '')
    .split('\n')
    .map(x => x.trim())
    .filter(Boolean);

export async function serviceRoutes(c) {
  const { env, db, path, m, body, U, ok } = c;
  const sm = path.match(/^svc\/([^/]{1,64})(\/stop)?$/);
  if (sm) {
    await ensure(db);
    const bot = await db.prepare('SELECT id,name FROM bots WHERE id=? AND user_id=?').bind(sm[1], U).first();
    if (!bot) return err('找不到這個機器人', 404);
    if (m === 'GET' && !sm[2]) return J(pub(await db.prepare('SELECT * FROM svc WHERE bot_id=? AND user_id=? AND on_=1').bind(bot.id, U).first()));
    if (m !== 'POST') return null;
    if (sm[2]) {
      await svcStop(env, db, U, bot.id, '已停止');
      return ok({ ok: true });
    }
    const plan = svcPlan(body);
    if (plan.error) return err(plan.error);
    await svcStart(env, db, U, bot, plan);
    return ok({ ok: true });
  }
  if (path === 'runner/svc' && m === 'POST') {
    await ensure(db);
    const rows = (await db.prepare('SELECT * FROM svc WHERE user_id=? AND on_=1').bind(U).all()).results;
    const out = [];
    for (const r of rows) {
      if (r.until && r.until <= now()) {
        await svcStop(env, db, U, r.bot_id, '時間到，已結束');
        continue;
      }
      out.push({ bot: r.bot_id, url: r.url, sel: r.sel || '', sec: r.sec, ...(r.ring && now() - r.ring < RING_MS ? { ring: r.ring } : {}) });
    }
    return J({ svc: out });
  }
  if (path === 'runner/svc/seen' && m === 'POST') {
    await ensure(db);
    const r = await db.prepare('SELECT * FROM svc WHERE bot_id=? AND user_id=? AND on_=1').bind(clean(body.bot, 64), U).first();
    if (!r) return J({ ok: true, stop: true });
    // the computer couldn't read the chat (not signed in, page gone…): remember why, nothing else
    if (body.error) {
      await db.prepare('UPDATE svc SET err=? WHERE bot_id=?').bind(clean(body.error, 200), r.bot_id).run();
      await bump(db, U);
      return J({ ok: true });
    }
    await db.prepare('UPDATE svc SET seen_at=?, err=NULL WHERE bot_id=?').bind(now(), r.bot_id).run();
    // the screens show the last look: tell them every 30 s or so (not on every look), and at once when it works again
    if (r.err || !r.seen_at || now() - r.seen_at > 30000) await bump(db, U);
    const text = clean(body.text, 12000),
      hash = clean(body.hash, 80);
    if (!hash) return J({ ok: true });
    const old = r.state ? JSON.parse(r.state) : null;
    const save = () => db.prepare('UPDATE svc SET state=?, rebase=NULL, ring=NULL WHERE bot_id=?').bind(JSON.stringify({ hash, text, t: now() }), r.bot_id).run();
    // a job of this mode still waiting or running: leave the baseline as it was (its reply is not a new message)
    const busy = await db
      .prepare("SELECT 1 AS n FROM jobs WHERE user_id=? AND bot_id=? AND status IN ('pending','running') AND prompt LIKE ? LIMIT 1")
      .bind(U, r.bot_id, SVC_TAG + '%')
      .first();
    if (busy) return J({ ok: true, changed: false, busy: true });
    // the first look, or the first one after it answered: remember the page, nothing to answer
    if (!old || r.rebase) {
      await save();
      return J({ ok: true, changed: false });
    }
    if (old.hash === hash) {
      // rung but the chat shows nothing new yet: keep looking for a while, then give up
      if (r.ring && now() - r.ring >= RING_MS) await db.prepare('UPDATE svc SET ring=NULL WHERE bot_id=?').bind(r.bot_id).run();
      return J({ ok: true, changed: false });
    }
    const before = new Set(lines(old.text));
    const added = lines(text).filter(x => !before.has(x));
    await save();
    if (!added.length) return J({ ok: true, changed: false }); // only moved around (a list re-sorted, a badge)
    const prompt =
      `${SVC_TAG}你正在客服模式，看著這個聊天畫面：${r.url}\n畫面上新出現的內容：\n${added.slice(-30).join('\n')}\n\n` +
      '請到你的瀏覽器裡那個聊天畫面，打開那位客人的聊天室，讀完整段對話（不是只看上面這幾行）再決定。' +
      '以下情況不要回、最後只寫「（略過）」：新出現的只是你自己剛送出的回覆、系統通知或時間；這位客人是手動聊天或真人客服已經接手（例如畫面上有「手動聊天」標籤、黑色提示條，或真人剛回過）；客人的問題已經被自動回應或別人回答了。' +
      (r.mode === 'draft'
        ? '這段時間是「先擬稿」：不要在聊天畫面送出任何訊息。把要回給客人的話寫好，回報裡最後單獨一行寫「✅待確認：回覆客人「要說的話」」，核准後才送出。'
        : '要回覆時用客人的語言，簡短、有禮貌。價格、折扣、退款、改訂單或取消這類事不要直接答應：先回客人「我幫您確認一下」，再在回報最後單獨一行寫「✅待確認：要回客人的內容」等我核准。不確定答案或客人生氣時也一樣先這樣做。') +
      '回覆完再看一次聊天畫面，這段時間又有新訊息就一併處理。給我的回報只要一行：回了誰、回了什麼（或擬了什麼）。' +
      (r.rules ? `\n\n我給你的客服規則：\n${r.rules}` : '');
    const jid = await addJob(db, U, r.bot_id, [r.bot_id], prompt);
    // 先等幾秒: a person or LINE's auto-reply gets to answer first; the bot reads the chat again when it starts
    if (r.wait > 0 && jid) await db.prepare('UPDATE jobs SET after=? WHERE id=?').bind(now() + r.wait * 1000, jid).run();
    await bump(db, U);
    return J({ ok: true, changed: true });
  }
  return null;
}
// a 客服模式 job finished: count it, and look at the page afresh next time (its own reply is not a new message)
export async function svcDone(db, U, job, good) {
  if (!String(job.prompt || '').startsWith(SVC_TAG)) return;
  await ensure(db);
  await db.prepare('UPDATE svc SET rebase=1, replies=replies+? WHERE bot_id=? AND user_id=?').bind(good ? 1 : 0, job.bot_id, U).run();
}
