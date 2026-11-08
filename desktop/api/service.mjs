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
async function ensure(db) {
  if (ready.has(db)) return;
  await db.prepare(TABLE).run();
  ready.add(db);
}
const pub = r =>
  r ? { on: !!r.on_, url: r.url, sel: r.sel || '', sec: r.sec, until: r.until || null, rules: r.rules || '', started: r.started, replies: r.replies || 0 } : { on: false };
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
  return { url, sel: clean(b?.sel, 200), sec, minutes, rules: clean(b?.rules, 2000) };
}
const endText = (env, until) => (until ? `到 ${localNow(env, until).hm}` : '直到你說停');
export async function svcStart(env, db, U, bot, plan) {
  await ensure(db);
  const until = plan.minutes ? now() + plan.minutes * MIN : null;
  await db
    .prepare(
      'INSERT INTO svc (bot_id,user_id,url,sel,sec,until,rules,started,replies,state,rebase,on_) VALUES (?,?,?,?,?,?,?,?,0,NULL,NULL,1) ON CONFLICT(bot_id) DO UPDATE SET url=excluded.url, sel=excluded.sel, sec=excluded.sec, until=excluded.until, rules=excluded.rules, started=excluded.started, replies=0, state=NULL, rebase=NULL, on_=1'
    )
    .bind(bot.id, U, plan.url, plan.sel || null, plan.sec, until, plan.rules || null, now())
    .run();
  await addMsg(db, U, bot.id, 'sys', `🎧 客服模式開始：每 ${plan.sec} 秒看一次 ${plan.url}，有新訊息就回覆，${endText(env, until)}。沒有新訊息時不會用到 AI。`);
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
      out.push({ bot: r.bot_id, url: r.url, sel: r.sel || '', sec: r.sec });
    }
    return J({ svc: out });
  }
  if (path === 'runner/svc/seen' && m === 'POST') {
    await ensure(db);
    const r = await db.prepare('SELECT * FROM svc WHERE bot_id=? AND user_id=? AND on_=1').bind(clean(body.bot, 64), U).first();
    if (!r) return J({ ok: true, stop: true });
    const text = clean(body.text, 12000),
      hash = clean(body.hash, 80);
    if (!hash) return J({ ok: true });
    const old = r.state ? JSON.parse(r.state) : null;
    const save = () => db.prepare('UPDATE svc SET state=?, rebase=NULL WHERE bot_id=?').bind(JSON.stringify({ hash, text, t: now() }), r.bot_id).run();
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
    if (old.hash === hash) return J({ ok: true, changed: false });
    const before = new Set(lines(old.text));
    const added = lines(text).filter(x => !before.has(x));
    await save();
    if (!added.length) return J({ ok: true, changed: false }); // only moved around (a list re-sorted, a badge)
    const prompt =
      `${SVC_TAG}你正在客服模式，看著這個聊天畫面：${r.url}\n畫面上新出現的內容：\n${added.slice(-30).join('\n')}\n\n` +
      '請到你的瀏覽器裡那個聊天畫面，讀完客人最新的訊息後直接回覆客人（用客人的語言，簡短、有禮貌）。' +
      '新出現的內容也可能只是你自己剛送出的回覆、系統通知或時間：沒有客人的新訊息就不要回，最後只寫「（略過）」。' +
      '回覆完再看一次聊天畫面，這段時間又有新訊息就一併回覆。不確定答案、要退款、要改訂單或客人生氣時，先回客人「我幫您確認一下」，再在給我的回報裡寫「❓ 問題」。' +
      '給我的回報只要一行：回了誰、回了什麼。' +
      (r.rules ? `\n\n我給你的客服規則：\n${r.rules}` : '');
    await addJob(db, U, r.bot_id, [r.bot_id], prompt);
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
