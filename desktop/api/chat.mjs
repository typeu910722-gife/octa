// Conversation logic: starting a turn, side chats, @mentions, stand-by, the background (幕後) list.
import { addJob, addMsg } from './db.mjs';
import { now, uid } from './util.mjs';

// a user message starts the bot (or the group's members). `text` is what was typed; an empty one still hands the files over.
export const COMPACT_PROMPT =
  '（壓縮對話）使用者要把這段對話壓縮，舊訊息整理完就會刪掉，你之後只看得到你的記憶和你這則回覆。請只做這件事，不要開瀏覽器、不要做其他工作：\n1. 之後還用得到、而且記憶裡還沒有的長期規則、偏好、例外和做法，每條一行「📌記住：…」（一條一句，具體可照做；已經記住的不要重複）。\n2. 最後寫一段「目前進度」（300 字內）：進行中的工作、待辦、最近的結論和要接續的地方，當作新對話的開頭。';
export async function enqueueTurn(db, userId, conv, text, bot, group, bots, quoted) {
  const prompt = [quoted?.note, text || '請處理我傳的附件。'].filter(Boolean).join('\n');
  let chain,
    ordered = false;
  if (bot) chain = [bot.id];
  else {
    const pos = mentionsIn(text, group.members.map(id => bots.find(x => x.id === id)).filter(Boolean));
    const at = id => pos[id] ?? -1;
    const named = group.members.filter(id => at(id) >= 0).sort((a, b) => at(a) - at(b));
    chain = named.length ? named : group.members;
    const everyone = /你們|大家|各位|每位|每個|所有人|全部/.test(text);
    if (!named.length && !everyone && quoted?.by && group.members.includes(quoted.by)) chain = [quoted.by];
    else if (!named.length && !everyone) {
      const prev = (
        await db
          .prepare("SELECT by_,text FROM messages WHERE user_id=? AND conv=? AND by_<>'sys' ORDER BY id DESC LIMIT 2")
          .bind(userId, conv)
          .all()
      ).results[1];
      if (prev && group.members.includes(prev.by_) && asksUser(prev.text)) chain = [prev.by_];
    }
    ordered =
      chain.length > 1 &&
      ((named.length > 1 && /收到.{0,20}後|之後|然後|接著|再由|再交|完成後|做完|拿到.{0,10}(後|再)|依序|輪流/.test(text)) ||
        /互相|彼此|聊聊|討論|交流|心得|對話|聊天|你們聊/.test(text));
  }
  // One group instruction runs in member order. Parallel only when the group task asks for it.
  if (group && parallelGroup(group) && !ordered) for (const id of chain) await addJob(db, userId, conv, [id], prompt);
  else await addJob(db, userId, conv, chain, prompt);
  const running = (
    await db
      .prepare(
        "SELECT DISTINCT bot_id FROM jobs WHERE user_id=? AND status='running' AND (kind IS NULL OR kind='' OR kind='chat')"
      )
      .bind(userId)
      .all()
  ).results;
  if (running.length >= 3) {
    const names = (bots || []).filter(b => running.some(r => r.bot_id === b.id)).map(b => b.name);
    await addMsg(
      db,
      userId,
      conv,
      'sys',
      `先排隊。現在有 ${running.length} 個在工作${names.length ? '：' + names.join('、') : ''}。做完就輪到這個。`
    );
  }
}
// 旁聊: a message to a bot that is already working. The work is not interrupted: a stop goes to it (as 停止 does),
// a change of plan waits until it is done, and anything else gets a quick reply from a side job (no browser).
export const SIDE_LIKE = '%"k":"side"%';
const STOP_RE =
  /^\s*(請|先|幫我|那就|好)?\s*(停|停止|停下來?|停掉|中止|取消|算了|別做了|不要做了|不用做了|不用了|先不要)(一下|吧|啦|了|掉|它|這個|這件|目前的?|現在的?|那件)?\s*[。！!～~.…]*\s*$/i;
const STOP_ANY = /(停止|取消|中止)(目前|現在|手上|正在)|(先|請)停下|^stop\b/i;
const LATER_RE =
  /^(核准|照做|拒絕|❌)|改成|改做|改為|改用|換成|換做|改一下|重做|重來|不要做|別做|先做|先別|順便|另外再|也要|加上|多做|追加/;
export function sideKind(text) {
  const t = String(text || '').trim();
  if (!t) return 'later'; // only files: they belong to the work
  if (STOP_RE.test(t) || STOP_ANY.test(t)) return 'stop';
  return LATER_RE.test(t) ? 'later' : 'side';
}
export async function busyTurn(db, userId, conv, text, bot, quoted) {
  const main = await db
    .prepare(
      "SELECT id,conv,prompt FROM jobs WHERE user_id=? AND bot_id=? AND status='running' AND kind='chat' AND IFNULL(via,'') NOT LIKE ? ORDER BY id LIMIT 1"
    )
    .bind(userId, bot.id, SIDE_LIKE)
    .first();
  if (!main) return false;
  const how = sideKind(text),
    what = String(main.prompt || '')
      .replace(/\s+/g, ' ')
      .slice(0, 30);
  if (how === 'stop') {
    await db.prepare("UPDATE jobs SET status='error', finished=? WHERE id=? AND status='running'").bind(now(), main.id).run();
    await db
      .prepare("DELETE FROM jobs WHERE user_id=? AND conv=? AND bot_id=? AND status='pending'")
      .bind(userId, conv, bot.id)
      .run();
    await addMsg(db, userId, conv, 'sys', '已停止目前的任務');
    return true;
  }
  if (how === 'later') {
    await addMsg(db, userId, conv, 'sys', `「${bot.name}」正在做「${what}」，做完就接著處理這則。`);
    return false;
  }
  const prompt = [quoted?.note, text].filter(Boolean).join('\n');
  await addJob(db, userId, conv, [{ b: bot.id, p: prompt, v: { k: 'side', m: main.id } }], prompt);
  return true;
}
// a send / upload job has to end with a clear result line (✅ 完成／⚠ 沒做成); a question about it does not
const SEND_RE = /傳給|傳送|發給|發送|寄給|寄出|送出|上傳|回報給|通知/;
const RESULT_RE = /✅\s*(完成|待確認)|⚠\s*沒做成|❓|需要使用者在電腦上登入|^⚠/m;
export function missingResult(prompt, text) {
  const p = String(prompt || '');
  if (!SEND_RE.test(p) || /[？?]|嗎|有沒有/.test(p.replace(/^（例行任務「[^」]*」）/, '').slice(0, 300))) return false;
  return !RESULT_RE.test(String(text || '')) && !passed(text);
}

export const STANDBY = '待命巡查'; // a bot on 24-hour standby: checks its duties every N minutes, says nothing when there's nothing to do
const STANDBY_PROMPT =
  '（待命巡查）照你的指定任務檢查有沒有新狀況要處理（例如新訊息、新訂單、到期的事）。有就處理，需要同事幫忙就 @同事；處理完簡短回報。完全沒事就只回「（略過）」。';
const STANDBY_EVERY = 30; // minutes: the default for a bot that just got a standing task
// bot names are called with "@名字": no spaces of any kind (old names with spaces are left as they are)
export const NAME_SPACE = /[\s\u3000]/;
export const NAME_SPACE_ERR = '名稱不能有空格，才能用 @ 叫它';
export const noSpaces = n => String(n || '').replace(/[\s\u3000]+/g, '_'); // names OCTA makes itself (templates, hire, self-naming)
export const autonomyOk = a => (['auto', 'report', 'ask'].includes(a) ? a : 'report');
// A bot that just got its standing task goes on 24-hour standby, once. Off again if the person turns it off; existing settings are left alone.
export async function autoStandby(db, userId, botId) {
  const b = await db.prepare('SELECT id, task, stood FROM bots WHERE id=? AND user_id=?').bind(botId, userId).first();
  if (!b || b.stood || !String(b.task || '').trim()) return false;
  const has = await db
    .prepare('SELECT 1 AS n FROM routines WHERE user_id=? AND conv=? AND name=?')
    .bind(userId, botId, STANDBY)
    .first();
  await db.prepare('UPDATE bots SET stood=1 WHERE id=? AND user_id=?').bind(botId, userId).run();
  if (has) return false;
  const ev = '*/' + STANDBY_EVERY;
  await db
    .prepare('INSERT INTO routines (id,user_id,conv,name,prompt,times,enabled,fired,created) VALUES (?,?,?,?,?,?,1,?,?)')
    .bind('r-' + uid(), userId, botId, STANDBY, STANDBY_PROMPT, JSON.stringify([ev]), JSON.stringify({ [ev]: now() }), now())
    .run();
  await addMsg(
    db,
    userId,
    botId,
    'sys',
    `已開啟 24 小時待命：每 ${STANDBY_EVERY} 分鐘照指定任務巡查一次，沒事不會出聲。可在任務設定調整或關閉。`
  );
  return true;
}
export const BG = /^〔背景:([^:〕]+):(ask|give)〕/; // a bot's message to another bot, run in the other bot's own chat
const parallelGroup = g => /同時做|同時回|並行|各自處理|各自回/.test(g?.task || '');
export const turnsOf = g => !parallelGroup(g);
export const LOGIN_WAIT = /需要使用者在電腦上登入/;
// Drop a stuck model's repeated lines before they are saved or used to start another round.
// 4.7 回覆分層: one blank line the bot left (the result, then the details after it) stays, so the app can fold the details
export function calmReply(text) {
  let t = String(text || '').replace(/[ \t]*【派瀏覽】[\s\S]*?【派完】[ \t]*\n?/g, '');
  t = t.replace(/^[ \t]*【(派瀏覽|派完)】.*(\n|$)/gm, '');
  const out = [];
  const seen = new Set();
  for (const line of t.split('\n')) {
    const v = line.trim();
    if (!v) {
      if (out.length && out.at(-1) !== '') out.push('');
      continue;
    }
    const key = v.replace(/\s+/g, '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
// "@名字" in a message. Names may have spaces, emoji or mixed scripts; where names overlap ("claude" / "claude 測試用") the longest one wins.
const nameEnds = (s, i) =>
  i >= s.length || /[\s:：,，、。!！?？]/.test(s[i]) || (/[\u3400-\u9fff]/.test(s[i]) && !/[\u3400-\u9fff]/.test(s[i - 1]));
export function mentionsIn(text, bots) {
  const t = String(text || ''),
    pos = {},
    taken = [];
  for (const b of [...bots].filter(b => b?.name).sort((x, y) => y.name.length - x.name.length)) {
    let i = -1;
    while ((i = t.indexOf('@' + b.name, i + 1)) >= 0) {
      const end = i + b.name.length + 1;
      if (taken.some(([a, z]) => i < z && end > a) || !nameEnds(t, end)) continue;
      pos[b.id] = i;
      taken.push([i, end]);
      break;
    }
  }
  return pos;
}
// a line that starts with "@名字 內容": {bot, rest}
export function mentionLine(line, bots) {
  const t = String(line || '').trim();
  if (!t.startsWith('@')) return null;
  const hit = [...bots]
    .filter(b => b?.name && t.startsWith('@' + b.name) && nameEnds(t, b.name.length + 1))
    .sort((x, y) => y.name.length - x.name.length)[0];
  const rest = hit
    ? t
        .slice(hit.name.length + 1)
        .replace(/^[\s:：,，、]+/, '')
        .trim()
    : '';
  return rest ? { bot: hit, rest } : null;
}
const PRIVATE = /私下|私底下|偷偷|背景(問|找|去)|不要在群組(問|說)/; // the person wants the colleague asked out of the group's sight
// in a group, a private question "@名字 私下：…" (or any @question when the person asked for it privately) is not shown in the group
// Does "@同事 …" ask the colleague for something, or only acknowledge / answer them?
// A reply to the bot that asked (or the follow-up after asking) only counts when it asks something new.
const ACK_RE = /^(好|好喔|好的|好啊|好，|收到|了解|明白|OK|ok|Ok|沒問題|謝謝|感謝|讚|嗯|同意|就這樣|太好了|辛苦了|👍)/;
const REQUEST_RE = /[？?]|請|幫我|幫忙|麻煩|能不能|可不可以|要不要|確認一下|交給你|你來/;
export function mentionAsks(said, to, prompt) {
  const s = String(said || '').trim();
  if (!s) return false;
  if (ACK_RE.test(s) && !REQUEST_RE.test(s)) return false;
  const p = String(prompt || '');
  const answering = p.match(/^(.+?) (?:問你：|把工作交接給你：)/); // answering a question, or reporting back on a hand-off
  if ((answering && answering[1] === to?.name) || /^同事已在上面回覆你的問題/.test(p)) return /[？?]/.test(s);
  return true;
}
export const privateAsk = (rest, prompt) => !/^交接/.test(rest) && (/^私下\s*[:：]/.test(rest) || PRIVATE.test(prompt || ''));
export const viaOf = job => {
  try {
    return job?.via ? JSON.parse(job.via) : null;
  } catch {
    return null;
  }
};
// 幕後 rows: who asked whom, what, the answer and how long it took. Old background jobs (before jobs.via) are read from their prompt.
export function backstageItems(rows) {
  const out = [];
  rows.forEach((r, i) => {
    const v = viaOf(r),
      bg = String(r.prompt || '').match(BG);
    const from = v?.f || bg?.[1],
      kind = v?.k || bg?.[2];
    if (!from || !kind) return;
    // a backup AI took the same job over: show only the run that counts
    if (r.status === 'error' && rows.slice(i + 1).some(x => x.conv === r.conv && x.bot_id === r.bot_id && x.prompt === r.prompt))
      return;
    const what = v?.w || (String(r.prompt).match(/(?:交辦給你|在背景問你)：([^\n]*)/) || [])[1] || '';
    out.push({
      id: r.id,
      conv: r.conv,
      from,
      to: r.bot_id,
      kind,
      what: what.slice(0, 300),
      reply: r.result || '',
      status: r.status,
      created: r.created,
      ms: r.finished ? r.finished - (r.started || r.created) : null
    });
  });
  return out;
}
export const passed = t =>
  /^[（(]?\s*(略過|PASS)\s*[）)]?[。.]?$/i.test(
    String(t)
      .replace(/^\s*📍.*$/gm, '')
      .trim()
  ); // "（略過）" plus the 📍 page line is still nothing to show

// a bot's message that waits on the user (a question, something to confirm or decide)
const asksUser = t =>
  /❓/.test(String(t || '')) ||
  (!/@\S/.test(
    String(t || '')
      .trim()
      .split('\n')
      .pop()
  ) &&
    /[？?]\s*$/.test(String(t || '').trim()));
