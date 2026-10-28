import { classifyModelFailure, decideRoute, replyIsProviderRefusal, classifyJobFailure, FAIL_KINDS, MAX_AUTO_RETRY, autoRetryable, retryPrompt, stripRetryNote, failureNotice } from '../../public/model-route.mjs';
import { normalizeCustom, publicConnectors, runConnector } from '../../public/connectors.mjs';
// OCTA API — Cloudflare Pages Function, single router.
// Web app uses a "web" session token; each computer's runner uses its own "runner" token.
// One computer per account is the 主機 (host): it runs every bot. Phones and other computers
// use the web app to give instructions. Changes bump users.rev; clients and the host long-poll it.

const J = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const err = (msg, status = 400) => J({ error: msg }, status);
const now = () => Date.now();
const uid = () => crypto.randomUUID();
const enc = new TextEncoder();
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const sha = async s => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
const randTok = () => hex(crypto.getRandomValues(new Uint8Array(24)));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const MIN = 60000, DAY = 86400000;
const WARM = [0, 30, 60, 120, 300, 600, -1];   // AI 待機 seconds after a reply (0: off, -1: always)
const MAX_ASK_DEPTH = 4;          // how many times bots may hand questions to each other in one run
const HOST_ONLINE_MS = 6 * MIN;   // the host writes a heartbeat every ~4 minutes
const WAIT_MS = 25000;            // long-poll length
const CHUNK = 900_000;            // base64 characters per stored piece
const MAX_FILE = 10 * 1024 * 1024;
const SESSION_IDLE = 90 * DAY;    // web sign-ins expire after 90 days without use

async function pbkdf2(pw, salt, iter = 100000) {
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations: iter }, key, 256));
}
async function hashPw(pw) { const salt = randTok(); return `pbkdf2$100000$${salt}$${await pbkdf2(pw, salt)}`; }
async function checkPw(pw, stored) {
  const [, iter, salt, h] = String(stored || '').split('$');
  if (!salt) return false;
  const got = await pbkdf2(pw, salt, +iter);
  if (got.length !== h.length) return false;
  let d = 0; for (let i = 0; i < h.length; i++) d |= got.charCodeAt(i) ^ h.charCodeAt(i);
  return d === 0;
}
// short description of the device from its user agent, for the device list
function deviceName(ua) {
  ua = String(ua || '');
  const os = /OCTA|Electron/.test(ua) ? 'OCTA 電腦版' : /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android'
    : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '裝置';
  const br = /OCTA|Electron/.test(ua) ? '' : /Edg\//.test(ua) ? 'Edge' : /SamsungBrowser/.test(ua) ? 'Samsung' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /FxiOS|Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '';
  return br ? `${os} · ${br}` : os;
}
const reqMeta = req => ({
  ua: deviceName(req.headers.get('user-agent')),
  ip: req.headers.get('cf-connecting-ip') || '',
  place: [req.cf?.city, req.cf?.country].filter(Boolean).join(', ')
});
async function newSession(db, userId, kind, label = null, meta = {}) {
  const t = randTok();
  await db.prepare('INSERT INTO sessions (token,user_id,kind,label,created,seen,ua,ip,place) VALUES (?,?,?,?,?,?,?,?,?)')
    .bind(await sha(t), userId, kind, label, now(), now(), meta.ua || null, meta.ip || null, meta.place || null).run();
  return t;
}
// the sign-in lookup also brings the account's 主機模式 fields, so the forwarding check and auth() share one read
const SES_SQL = 'SELECT s.token,s.user_id,s.kind,s.label,s.seen,s.created,s.info,u.name,u.hmode,u.hurl,u.hkey FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?';
const preAuth = new WeakMap();   // request → session row already read for it by viaHost()
async function auth(req, db) {
  const h = req.headers.get('authorization') || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!t) return null;
  const tok = await sha(t);
  const s = preAuth.has(req) ? preAuth.get(req) : await db.prepare(SES_SQL).bind(tok).first();
  if (!s || s.kind === 'coach') return null;   // a coach link only opens /api/coach/<key>
  if (s.kind === 'web') {
    const last = s.seen || s.created;
    if (now() - last > SESSION_IDLE) { await db.prepare('DELETE FROM sessions WHERE token=?').bind(tok).run(); return null; }
    if (now() - last > 6 * 3600000) await db.prepare('UPDATE sessions SET seen=? WHERE token=?').bind(now(), tok).run();   // rarely written
  }
  return s;
}
const clean = (s, max) => String(s ?? '').trim().slice(0, max);
// routine times: "HH:MM" every day, or "*/N" every N minutes (5–720)
const isEvery = t => /^\*\/\d+$/.test(t);
const cleanTimes = a => {
  const list = Array.isArray(a) ? a : [];
  const fixed = [...new Set(list.filter(s => /^([01]\d|2[0-3]):[0-5]\d$/.test(s)))].sort().slice(0, 12);
  const ev = list.map(s => String(s).match(/^\*\/(\d+)$/)).filter(Boolean).map(mm => Math.min(720, Math.max(5, +mm[1])))[0];
  return ev ? ['*/' + ev, ...fixed] : fixed;
};
const CLOCK_RE = /(?<![0-9])([01]?\d|2[0-3])[:：]([0-5]\d)(?![0-9])/g;
function clockHits(text) {
  const hits = [];
  const re = new RegExp(CLOCK_RE.source, 'g');
  let m;
  while ((m = re.exec(String(text || '')))) hits.push({ t: m[1].padStart(2, '0') + ':' + m[2], i: m.index, end: m.index + m[0].length });
  return hits;
}
function routineName(raw) {
  let name = String(raw || '').replace(/^[的\s:：,，、和與及]+/, '');
  name = name.replace(/[（(].*$/, '');
  name = name.replace(/(要給|交給|給「|給『|，|。|；|;|→|➡).*$/, '');
  name = name.replace(/^(請|幫我|建立|新增|設定|例行任務|排程|每天|每日|的)+/, '').trim();
  return clean(name, 40);
}
// Times written in the instruction win. A prose "已建好" does not.
export function schedulesFromTurn(prompt, reply) {
  const src = String(prompt || '');
  const asks = /例行任務/.test(src)
    || /(?:建立|新增|設定|做成|改成|排進|寫成|建成).{0,16}排程|排程.{0,16}(?:建立|新增|設定|做成|改成|建成)/.test(src)
    || (/交接/.test(src) && clockHits(src).length && /名單|早報|入住|退房|續住|掃房|訂單|每天|每日|例行|排程|要給|交給/.test(src));
  if (!asks) return { fromPrompt: false, routines: [] };
  const hits = clockHits(src);
  if (hits.length) {
    const routines = routinesFromClocks(src, hits);
    return { fromPrompt: routines.length > 0, routines };
  }
  return { fromPrompt: false, routines: routinesFromReplyLines(reply) };
}
function routinesFromClocks(text, hits) {
  const groups = [];
  let cur = [hits[0]];
  for (let i = 1; i < hits.length; i++) {
    const between = text.slice(cur[cur.length - 1].end, hits[i].i);
    if (/^[\s,，、和與及的]+$/.test(between)) cur.push(hits[i]);
    else { groups.push(cur); cur = [hits[i]]; }
  }
  groups.push(cur);
  const out = [];
  const skip = /^(結束|為止|之前|之後|左右|開始|停止|見|回我|再說)$/;
  for (let g = 0; g < groups.length && out.length < 12; g++) {
    const group = groups[g];
    const nameEnd = g + 1 < groups.length ? groups[g + 1][0].i : text.length;
    const times = cleanTimes(group.map(x => x.t));
    if (!times.length) continue;
    let name = routineName(text.slice(group[group.length - 1].end, nameEnd));
    if (skip.test(name)) continue;
    if (!name) name = clean('每天 ' + times.join('、'), 40);
    out.push({ name, times, prompt: clean(text.slice(group[0].i, nameEnd), 2000) });
  }
  return out;
}
function routinesFromReplyLines(reply) {
  const out = [];
  for (const line of String(reply || '').split('\n')) {
    const m = line.trim().match(/^(?:\d+\s*[.、．)）]\s*)?([01]?\d|2[0-3])[:：]([0-5]\d)\s+(\S.{0,80})/);
    if (!m) continue;
    const name = routineName(m[3]);
    const times = cleanTimes([m[1].padStart(2, '0') + ':' + m[2]]);
    if (!name || !times.length || /^(結束|為止|之前|之後|左右|開始|停止|見|回我|再說)$/.test(name)) continue;
    out.push({ name, times, prompt: clean(line, 2000) });
    if (out.length >= 12) break;
  }
  return out;
}
function applySchedules(plans, prompt, reply) {
  const asked = schedulesFromTurn(prompt, reply);
  if (asked.fromPrompt) {
    const sets = new Set(asked.routines.map(r => r.times.join(',')));
    for (let i = plans.length - 1; i >= 0; i--) {
      const p = plans[i];
      if (p.trigger || p.times.every(isEvery)) continue;
      if (!sets.has(p.times.filter(t => !isEvery(t)).join(','))) plans.splice(i, 1);
    }
  }
  for (const r of asked.routines) {
    if (plans.some(p => !p.trigger && (p.name === r.name || (p.times.length === r.times.length && p.times.every((t, i) => t === r.times[i]))))) continue;
    plans.push(r);
  }
  return plans;
}
const localNow = (env, t = now()) => {
  const d = new Date(t + (+env.TZ_OFFSET_MIN || 0) * 60000);
  return { date: d.toISOString().slice(0, 10), hm: d.toISOString().slice(11, 16) };
};
const bump = (db, userId) => db.prepare('UPDATE users SET rev=rev+1 WHERE id=?').bind(userId).run();

async function addMsg(db, userId, conv, by, text, files = null, reply = null) {
  const rid = Number.isInteger(reply) && reply > 0 ? reply : null;
  await db.prepare('INSERT INTO messages (user_id,conv,by_,text,files,ts,reply) VALUES (?,?,?,?,?,?,?)').bind(userId, conv, by, text, files && files.length ? JSON.stringify(files) : null, now(), rid).run();
}
// chain: list of bot ids (all use `prompt`) or {b, p} steps
async function addJob(db, userId, conv, chain, prompt, depth = 0) {
  const steps = chain.map(s => (typeof s === 'string' ? { b: s, p: prompt } : s));
  if (!steps.length) return;
  await db.prepare('INSERT INTO jobs (user_id,conv,bot_id,chain,prompt,created,depth,via) VALUES (?,?,?,?,?,?,?,?)')
    .bind(userId, conv, steps[0].b, JSON.stringify(steps.slice(1)), steps[0].p, now(), depth, steps[0].v ? JSON.stringify(steps[0].v) : null).run();
}
// a user message starts the bot (or the group's members). `text` is what was typed; an empty one still hands the files over.
async function enqueueTurn(db, userId, conv, text, bot, group, bots, quoted) {
  const prompt = [quoted?.note, text || '請處理我傳的附件。'].filter(Boolean).join('\n');
  let chain, ordered = false;
  if (bot) chain = [bot.id];
  else {
    const pos = mentionsIn(text, group.members.map(id => bots.find(x => x.id === id)).filter(Boolean));
    const at = id => (pos[id] ?? -1);
    const named = group.members.filter(id => at(id) >= 0).sort((a, b) => at(a) - at(b));
    chain = named.length ? named : group.members;
    const everyone = /你們|大家|各位|每位|每個|所有人|全部/.test(text);
    if (!named.length && !everyone && quoted?.by && group.members.includes(quoted.by)) chain = [quoted.by];
    else if (!named.length && !everyone) {
      const prev = (await db.prepare("SELECT by_,text FROM messages WHERE user_id=? AND conv=? AND by_<>'sys' ORDER BY id DESC LIMIT 2").bind(userId, conv).all()).results[1];
      if (prev && group.members.includes(prev.by_) && asksUser(prev.text)) chain = [prev.by_];
    }
    ordered = chain.length > 1 && ((named.length > 1 && /收到.{0,20}後|之後|然後|接著|再由|再交|完成後|做完|拿到.{0,10}(後|再)|依序|輪流/.test(text)) || /互相|彼此|聊聊|討論|交流|心得|對話|聊天|你們聊/.test(text));
  }
  // One group instruction runs in member order. Parallel only when the group task asks for it.
  if (group && parallelGroup(group) && !ordered) for (const id of chain) await addJob(db, userId, conv, [id], prompt);
  else await addJob(db, userId, conv, chain, prompt);
  const running = (await db.prepare("SELECT DISTINCT bot_id FROM jobs WHERE user_id=? AND status='running' AND (kind IS NULL OR kind='' OR kind='chat')").bind(userId).all()).results;
  if (running.length >= 3) {
    const names = (bots || []).filter(b => running.some(r => r.bot_id === b.id)).map(b => b.name);
    await addMsg(db, userId, conv, 'sys', `先排隊。現在有 ${running.length} 個在工作${names.length ? '：' + names.join('、') : ''}。做完就輪到這個。`);
  }
}
// a second record of the same bytes, so the copy survives if the source conversation is deleted
async function cloneFile(db, userId, fileId, conv) {
  const f = await db.prepare('SELECT id,name,mime,data,loc,path,size,pc FROM files WHERE id=? AND user_id=?').bind(fileId, userId).first();
  if (!f) return null;
  const id = 'file-' + uid();
  if (f.loc === 'pc' && f.path) {
    await db.prepare("INSERT INTO files (id,user_id,name,mime,data,ts,conv,loc,path,size,pc) VALUES (?,?,?,?,'',?,?,'pc',?,?,?)").bind(id, userId, f.name, f.mime, now(), conv, f.path, f.size, f.pc).run();
  } else if (f.data) {
    await db.prepare('INSERT INTO files (id,user_id,name,mime,data,ts,conv,loc,size) VALUES (?,?,?,?,?,?,?,?,?)').bind(id, userId, f.name, f.mime, f.data, now(), conv, f.loc || 'db', f.size).run();
  } else {
    const data = await readChunks(db, f.id);
    if (data) await storeChunks(db, id, data);
    await db.prepare("INSERT INTO files (id,user_id,name,mime,data,ts,conv,loc,size) VALUES (?,?,?,?,'',?,?,'cloud',?)").bind(id, userId, f.name, f.mime, now(), conv, f.size || (data ? Math.round(data.length * 0.75) : null)).run();
  }
  return { id, name: f.name, mime: f.mime };
}
const STANDBY = '待命巡查';   // a bot on 24-hour standby: checks its duties every N minutes, says nothing when there's nothing to do
const STANDBY_PROMPT = '（待命巡查）照你的指定任務檢查有沒有新狀況要處理（例如新訊息、新訂單、到期的事）。有就處理，需要同事幫忙就 @同事；處理完簡短回報。完全沒事就只回「（略過）」。';
const STANDBY_EVERY = 30;   // minutes: the default for a bot that just got a standing task
// bot names are called with "@名字": no spaces of any kind (old names with spaces are left as they are)
const NAME_SPACE = /[\s\u3000]/;
const NAME_SPACE_ERR = '名稱不能有空格，才能用 @ 叫它';
const noSpaces = n => String(n || '').replace(/[\s\u3000]+/g, '_');   // names OCTA makes itself (templates, hire, self-naming)
const autonomyOk = a => (['auto', 'report', 'ask'].includes(a) ? a : 'report');
// A bot that just got its standing task goes on 24-hour standby, once. Off again if the person turns it off; existing settings are left alone.
async function autoStandby(db, userId, botId) {
  const b = await db.prepare('SELECT id, task, stood FROM bots WHERE id=? AND user_id=?').bind(botId, userId).first();
  if (!b || b.stood || !String(b.task || '').trim()) return false;
  const has = await db.prepare('SELECT 1 AS n FROM routines WHERE user_id=? AND conv=? AND name=?').bind(userId, botId, STANDBY).first();
  await db.prepare('UPDATE bots SET stood=1 WHERE id=? AND user_id=?').bind(botId, userId).run();
  if (has) return false;
  const ev = '*/' + STANDBY_EVERY;
  await db.prepare('INSERT INTO routines (id,user_id,conv,name,prompt,times,enabled,fired,created) VALUES (?,?,?,?,?,?,1,?,?)')
    .bind('r-' + uid(), userId, botId, STANDBY, STANDBY_PROMPT, JSON.stringify([ev]), JSON.stringify({ [ev]: now() }), now()).run();
  await addMsg(db, userId, botId, 'sys', `已開啟 24 小時待命：每 ${STANDBY_EVERY} 分鐘照指定任務巡查一次，沒事不會出聲。可在任務設定調整或關閉。`);
  return true;
}
const BG = /^〔背景:([^:〕]+):(ask|give)〕/;   // a bot's message to another bot, run in the other bot's own chat
const parallelGroup = g => /同時做|同時回|並行|各自處理|各自回/.test(g?.task || '');
const turnsOf = g => !parallelGroup(g);
const LOGIN_WAIT = /需要使用者在電腦上登入/;
// Drop a stuck model's repeated lines before they are saved or used to start another round.
export function calmReply(text) {
  let t = String(text || '').replace(/【派瀏覽】[\s\S]*?【派完】/g, '\n');
  t = t.replace(/^\s*【派瀏覽】.*$/gm, '').replace(/^\s*【派完】.*$/gm, '');
  const out = [];
  const seen = new Set();
  for (const line of t.split('\n')) {
    const v = line.trim();
    if (!v) continue;
    const key = v.replace(/\s+/g, '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out.join('\n').trim();
}
// "@名字" in a message. Names may have spaces, emoji or mixed scripts; where names overlap ("claude" / "claude 測試用") the longest one wins.
const nameEnds = (s, i) => i >= s.length || /[\s:：,，、。!！?？]/.test(s[i]) || (/[\u3400-\u9fff]/.test(s[i]) && !/[\u3400-\u9fff]/.test(s[i - 1]));
function mentionsIn(text, bots) {
  const t = String(text || ''), pos = {}, taken = [];
  for (const b of [...bots].filter(b => b?.name).sort((x, y) => y.name.length - x.name.length)) {
    let i = -1;
    while ((i = t.indexOf('@' + b.name, i + 1)) >= 0) {
      const end = i + b.name.length + 1;
      if (taken.some(([a, z]) => i < z && end > a) || !nameEnds(t, end)) continue;
      pos[b.id] = i; taken.push([i, end]); break;
    }
  }
  return pos;
}
// a line that starts with "@名字 內容": {bot, rest}
function mentionLine(line, bots) {
  const t = String(line || '').trim();
  if (!t.startsWith('@')) return null;
  const hit = [...bots].filter(b => b?.name && t.startsWith('@' + b.name) && nameEnds(t, b.name.length + 1)).sort((x, y) => y.name.length - x.name.length)[0];
  const rest = hit ? t.slice(hit.name.length + 1).replace(/^[\s:：,，、]+/, '').trim() : '';
  return rest ? { bot: hit, rest } : null;
}
const PRIVATE = /私下|私底下|偷偷|背景(問|找|去)|不要在群組(問|說)/;   // the person wants the colleague asked out of the group's sight
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
  const answering = p.match(/^(.+?) (?:問你：|把工作交接給你：)/);   // answering a question, or reporting back on a hand-off
  if ((answering && answering[1] === to?.name) || /^同事已在上面回覆你的問題/.test(p)) return /[？?]/.test(s);
  return true;
}
const privateAsk = (rest, prompt) => !/^交接/.test(rest) && (/^私下\s*[:：]/.test(rest) || PRIVATE.test(prompt || ''));
const viaOf = job => { try { return job?.via ? JSON.parse(job.via) : null; } catch { return null; } };
// 幕後 rows: who asked whom, what, the answer and how long it took. Old background jobs (before jobs.via) are read from their prompt.
function backstageItems(rows) {
  const out = [];
  rows.forEach((r, i) => {
    const v = viaOf(r), bg = String(r.prompt || '').match(BG);
    const from = v?.f || bg?.[1], kind = v?.k || bg?.[2];
    if (!from || !kind) return;
    // a backup AI took the same job over: show only the run that counts
    if (r.status === 'error' && rows.slice(i + 1).some(x => x.conv === r.conv && x.bot_id === r.bot_id && x.prompt === r.prompt)) return;
    const what = v?.w || (String(r.prompt).match(/(?:交辦給你|在背景問你)：([^\n]*)/) || [])[1] || '';
    out.push({ id: r.id, conv: r.conv, from, to: r.bot_id, kind, what: what.slice(0, 300), reply: r.result || '', status: r.status, created: r.created, ms: r.finished ? r.finished - (r.started || r.created) : null });
  });
  return out;
}
const passed = t => /^[（(]?\s*(略過|PASS)\s*[）)]?[。.]?$/i.test(String(t).replace(/^\s*📍.*$/gm, '').trim());   // "（略過）" plus the 📍 page line is still nothing to show
async function loadAll(db, userId) {
  const [b, g, f, r] = await db.batch([
    db.prepare('SELECT id,name,task,folder,engine,model,avatar,browser,shot_ts,shot_file,page,bpc,fb,autonomy,stood FROM bots WHERE user_id=? ORDER BY created').bind(userId),
    db.prepare('SELECT id,name,task,members,folder FROM groups_ WHERE user_id=? ORDER BY created').bind(userId),
    db.prepare('SELECT id,name,notes FROM folders WHERE user_id=? ORDER BY created').bind(userId),
    db.prepare('SELECT id,conv,name,prompt,times,enabled,hook,watch FROM routines WHERE user_id=? ORDER BY created').bind(userId)
  ]);
  return {
    bots: b.results.map(x => ({ ...x, fb: fbParse(x.fb), autonomy: autonomyOk(x.autonomy), stood: !!x.stood })),
    groups: g.results.map(x => ({ ...x, members: JSON.parse(x.members) })),
    folders: f.results,
    routines: r.results.map(x => ({ ...x, times: JSON.parse(x.times), enabled: !!x.enabled, watch: x.watch ? JSON.parse(x.watch) : null }))
  };
}
async function getSettings(db, userId) {
  const u = await db.prepare('SELECT settings FROM users WHERE id=?').bind(userId).first();
  try { return JSON.parse(u?.settings || '{}'); } catch { return {}; }
}
const putSettings = (db, userId, st) => db.prepare('UPDATE users SET settings=? WHERE id=?').bind(JSON.stringify(st), userId).run();
const mask = t => (t ? '••••' + String(t).slice(-4) : '');
async function sendNotify(env, st, text, photo = null) {
  const out = [];
  if (st.tg?.token && st.tg?.chat && photo) {   // base64 JPEG of the failed job's screen; the text goes as its caption
    let r = null;
    try {
      const fd = new FormData();
      fd.append('chat_id', st.tg.chat);
      fd.append('caption', text.slice(0, 1000));
      fd.append('photo', new Blob([Uint8Array.from(atob(photo), c => c.charCodeAt(0))], { type: 'image/jpeg' }), 'screenshot.jpg');
      r = await fetch(`https://api.telegram.org/bot${st.tg.token}/sendPhoto`, { method: 'POST', body: fd }).catch(() => null);
    } catch { }
    if (r?.ok && text.length <= 1000) { out.push('Telegram'); photo = 'sent'; }
  }
  if (st.tg?.token && st.tg?.chat && photo !== 'sent') {
    const r = await fetch(`https://api.telegram.org/bot${st.tg.token}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: st.tg.chat, text: text.slice(0, 4000) })
    }).catch(() => null);
    out.push(r?.ok ? 'Telegram' : 'Telegram（失敗）');
  }
  if (st.line?.token && st.line?.to) {
    const r = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + st.line.token },
      body: JSON.stringify({ to: st.line.to, messages: [{ type: 'text', text: text.slice(0, 4900) }] })
    }).catch(() => null);
    out.push(r?.ok ? 'LINE' : 'LINE（失敗）');
  }
  return out;
}
const needsYou = t => /✅待確認|需要使用者|^⚠/m.test(t);
const ENGINES = ['claude', 'codex', 'gemini', 'grok', 'grokbot', 'copilot', 'cursor', 'qwen', 'opencode'];
// backup AIs: up to three "engine|model" entries (two backups plus an optional local Ollama / opencode)
const fbParse = v => { try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };
const fbOk = v => JSON.stringify((Array.isArray(v) ? v : []).map(x => String(x || '').split('|')).filter(([e]) => ENGINES.includes(e) && !['copilot', 'cursor', 'qwen', 'grok'].includes(e)).slice(0, 3).map(([e, m]) => e + (clean(m, 80) ? '|' + clean(m, 80) : '')));
const CODE_FB = ['ollama', 'opencode', 'claude', 'codex', 'gemini'];
const codeFbOk = v => JSON.stringify((Array.isArray(v) ? v : []).map(x => String(x || '').split('|')).filter(([e]) => CODE_FB.includes(e)).slice(0, 2).map(([e, m]) => e + (clean(m, 80) ? '|' + clean(m, 80) : '')));
// a bot's message that waits on the user (a question, something to confirm or decide)
const asksUser = t => /❓/.test(String(t || '')) || (!/@\S/.test(String(t || '').trim().split('\n').pop()) && /[？?]\s*$/.test(String(t || '').trim()));
// "Resets in 156h16m" or "5 小時後" → when that AI can be used again. Unknown windows wait an hour, not forever.
const resetAt = t => {
  const s = String(t);
  const dated = s.match(/resets?\s+([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,|\s)+(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
  if (dated) {
    const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
    const month = months[dated[1].slice(0, 3).toLowerCase()];
    if (month != null) {
      let hour = +dated[3];
      const minute = dated[4] ? +dated[4] : 0;
      const ap = dated[5].toLowerCase();
      if (ap === 'pm' && hour < 12) hour += 12;
      if (ap === 'am' && hour === 12) hour = 0;
      const year = new Date().getUTCFullYear();
      let utc = Date.UTC(year, month, +dated[2], hour - 8, minute);
      if (utc < now() - 86400000) utc = Date.UTC(year + 1, month, +dated[2], hour - 8, minute);
      if (utc > now()) return utc;
    }
  }
  const m = s.match(/resets? in\s*(?:(\d+)\s*h(?:ours?)?)?\s*(?:(\d+)\s*m(?:in(?:ute)?s?)?)?/i);
  if (m && (m[1] || m[2])) return now() + ((+m[1] || 0) * 60 + (+m[2] || 0)) * 60000;
  const zh = s.match(/(\d+)\s*個?\s*小時/);
  const zm = s.match(/(\d+)\s*分鐘/);
  if (zh || zm) {
    const mins = (zh ? +zh[1] * 60 : 0) + (zm ? +zm[1] : 0);
    if (mins > 0 && mins < 14 * 24 * 60) return now() + mins * 60000;
  }
  return now() + 60 * 60000;
};
// job.eng is "engine" or "engine|model". A saved model that no longer matches exactly (opus → sonnet)
// still belongs to that engine, so a failure there must not be charged to the primary again.
const chainIndex = (chain, current) => {
  const id = String(current || '');
  const exact = chain.indexOf(id);
  if (exact >= 0) return exact;
  const head = id.split('|')[0];
  if (!head) return 0;
  const loose = chain.findIndex(x => x === head || String(x).startsWith(head + '|'));
  return loose >= 0 ? loose : 0;
};
const ENGINE_NAMES = { claude: 'Claude', codex: 'ChatGPT', gemini: 'Antigravity', grokbot: 'Grok Bot', opencode: 'Ollama' };
const engineOk = e => (ENGINES.includes(e) ? e : 'claude');
const avatarOk = a => { const v = clean(a, 16); return v && !/[<>&"']/.test(v) ? v : null; };
// grokbot: the model field holds the Grok Bot's name. opencode is only used with local Ollama models (no paid APIs): "qwen3" → "ollama/qwen3"
const modelOk = (engine, m) => { const v = clean(m, 80) || null; if (!v || engine !== 'opencode') return v; return 'ollama/' + v.replace(/^ollama\//, '').replace(/^.*\//, ''); };
const TEMPLATE_AVATARS = { a: '🤖', r1: '🔎', r2: '📝', s1: '🧾', s2: '💬', s3: '📊', l1: '🛎️', l2: '🧹', l3: '👋', m1: '📅', d1: '📊', w1: '👀', g1: '🎮' };
// Columns and tables added after the first release. Applied automatically the first time a new
// version runs against an older database (each statement is skipped if it already exists).
const MIGRATIONS = [
  'ALTER TABLE users ADD COLUMN host TEXT', 'ALTER TABLE users ADD COLUMN rev INTEGER NOT NULL DEFAULT 0', 'ALTER TABLE users ADD COLUMN reset TEXT',
  'ALTER TABLE sessions ADD COLUMN seen INTEGER', 'ALTER TABLE sessions ADD COLUMN ua TEXT', 'ALTER TABLE sessions ADD COLUMN ip TEXT', 'ALTER TABLE sessions ADD COLUMN place TEXT', 'ALTER TABLE sessions ADD COLUMN info TEXT',
  'ALTER TABLE bots ADD COLUMN shot_file TEXT',
  'ALTER TABLE files ADD COLUMN conv TEXT', 'ALTER TABLE files ADD COLUMN loc TEXT', 'ALTER TABLE files ADD COLUMN path TEXT', 'ALTER TABLE files ADD COLUMN size INTEGER', 'ALTER TABLE files ADD COLUMN want INTEGER',
  'CREATE INDEX IF NOT EXISTS file_user ON files(user_id, loc)', 'CREATE INDEX IF NOT EXISTS ses_user ON sessions(user_id, kind)', 'CREATE INDEX IF NOT EXISTS msg_conv ON messages(user_id, conv, id)',
  'ALTER TABLE messages ADD COLUMN reply INTEGER',
  'CREATE TABLE IF NOT EXISTS chunks (file_id TEXT NOT NULL, n INTEGER NOT NULL, data TEXT NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (file_id, n))',
  'CREATE TABLE IF NOT EXISTS logins (k TEXT PRIMARY KEY, fails INTEGER NOT NULL, until INTEGER NOT NULL)',
  'ALTER TABLE jobs ADD COLUMN progress TEXT', 'ALTER TABLE jobs ADD COLUMN tokens INTEGER',
  'ALTER TABLE routines ADD COLUMN hook TEXT', 'ALTER TABLE routines ADD COLUMN watch TEXT', 'ALTER TABLE routines ADD COLUMN wstate TEXT',
  'CREATE INDEX IF NOT EXISTS routine_hook ON routines(hook)',
  'ALTER TABLE files ADD COLUMN pc TEXT', 'ALTER TABLE bots ADD COLUMN bpc TEXT', 'ALTER TABLE jobs ADD COLUMN pc TEXT',
  'ALTER TABLE bots ADD COLUMN fb TEXT', 'ALTER TABLE jobs ADD COLUMN eng TEXT', 'ALTER TABLE jobs ADD COLUMN tries INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE code_tasks ADD COLUMN fb TEXT',
  'CREATE TABLE IF NOT EXISTS code_repos (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, path TEXT NOT NULL, validated INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS code_tasks (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, repo_id TEXT NOT NULL, title TEXT NOT NULL, prompt TEXT NOT NULL, criteria TEXT NOT NULL DEFAULT \'\', engine TEXT NOT NULL, model TEXT, fb TEXT, status TEXT NOT NULL DEFAULT \'queued\', phase TEXT NOT NULL DEFAULT \'queued\', role TEXT, workspace_id TEXT, branch TEXT, base_ref TEXT, head_ref TEXT, retries INTEGER NOT NULL DEFAULT 0, max_retries INTEGER NOT NULL DEFAULT 3, job_id INTEGER, summary TEXT, approval TEXT, cancel INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, updated INTEGER NOT NULL, finished INTEGER)',
  'ALTER TABLE code_tasks ADD COLUMN fb TEXT',
  'CREATE INDEX IF NOT EXISTS code_task_user ON code_tasks(user_id, created)',
  'CREATE TABLE IF NOT EXISTS code_events (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, user_id TEXT NOT NULL, ts INTEGER NOT NULL, role TEXT, kind TEXT NOT NULL, text TEXT, data TEXT)',
  'CREATE INDEX IF NOT EXISTS code_event_task ON code_events(task_id, id)',
  'CREATE TABLE IF NOT EXISTS live (bot_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, url TEXT, title TEXT, mime TEXT, data TEXT, ts INTEGER, handed INTEGER NOT NULL DEFAULT 0)',
  // 3.1: progress has its own counter (no full reload), live frames only while someone watches
  'ALTER TABLE users ADD COLUMN prog INTEGER NOT NULL DEFAULT 0', 'ALTER TABLE live ADD COLUMN watch INTEGER',
  // why a job failed, its screenshot, and the automatic retry it led to
  'ALTER TABLE jobs ADD COLUMN err_kind TEXT', 'ALTER TABLE jobs ADD COLUMN err_msg TEXT', 'ALTER TABLE jobs ADD COLUMN shot TEXT', 'ALTER TABLE jobs ADD COLUMN retry_of INTEGER',
  // 成果看板: per bot per day totals (jobs are kept only 14 days)
  'CREATE TABLE IF NOT EXISTS stats (user_id TEXT NOT NULL, bot_id TEXT NOT NULL, day TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0, ms INTEGER NOT NULL DEFAULT 0, timed INTEGER NOT NULL DEFAULT 0, tokens INTEGER NOT NULL DEFAULT 0, web INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, bot_id, day))',
  // 主動性: how freely a bot acts, default standby once, who asked for a job (幕後)
  'ALTER TABLE bots ADD COLUMN autonomy TEXT', 'ALTER TABLE bots ADD COLUMN stood INTEGER', 'ALTER TABLE jobs ADD COLUMN via TEXT',
  // D1 讀取量: today's / last-14-days job queries (token counts, 幕後, weekly review) read only their own days
  'CREATE INDEX IF NOT EXISTS job_created ON jobs(user_id, created)',
  // 主機模式: the account's data lives on its host computer; the cloud keeps the account and forwards
  'ALTER TABLE users ADD COLUMN hmode INTEGER', 'ALTER TABLE users ADD COLUMN hurl TEXT', 'ALTER TABLE users ADD COLUMN hkey TEXT', 'ALTER TABLE users ADD COLUMN hseen INTEGER',
  'CREATE TABLE IF NOT EXISTS host_hooks (k TEXT PRIMARY KEY, user_id TEXT NOT NULL)'
];
const schemaReady = new WeakSet();
async function ensureSchema(db) {
  if (schemaReady.has(db)) return;
  try {
    await db.batch(['SELECT want, pc FROM files', 'SELECT k FROM logins', 'SELECT progress, tokens, pc, eng, tries FROM jobs', 'SELECT hook, watch, wstate FROM routines', 'SELECT bpc, fb FROM bots', 'SELECT id, fb FROM code_tasks', 'SELECT reply FROM messages', 'SELECT handed, watch FROM live', 'SELECT prog FROM users', 'SELECT err_kind, err_msg, shot, retry_of FROM jobs', 'SELECT web FROM stats', 'SELECT autonomy, stood FROM bots', 'SELECT via FROM jobs', "SELECT id FROM jobs INDEXED BY job_created WHERE user_id='' AND created>0", 'SELECT hmode, hurl, hkey, hseen FROM users', 'SELECT k, user_id FROM host_hooks'].map(q => db.prepare(q + ' LIMIT 0')));
    schemaReady.add(db); return; } catch { }
  for (const sql of MIGRATIONS) { try { await db.prepare(sql).run(); } catch { } }
  schemaReady.add(db);
}

// requests that don't change anything other devices need to see
const NO_BUMP = /^(signup|login|logout|pair|cron|wait|reset|password|devices|notify\/|settings|runner\/(next|blob|hello|bye|progress|live))/;
const folderOk = (folders, id) => (id && folders.some(f => f.id === id) ? id : null);
const MIMES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', md: 'text/markdown', json: 'application/json',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
const mimeOf = (name, given) => clean(given, 100) || MIMES[String(name).split('.').pop().toLowerCase()] || 'application/octet-stream';
const safePath = p => { const v = clean(p, 400).replace(/\\/g, '/'); return v && !v.split('/').includes('..') && !/^\/|^[a-z]:/i.test(v) ? v : null; };

// ---------- host computer ----------
async function hostInfo(db, userId) {
  const u = await db.prepare('SELECT host, engines, hmode, hseen FROM users WHERE id=?').bind(userId).first();
  const runners = (await db.prepare("SELECT token,label,seen,info,created FROM sessions WHERE user_id=? AND kind='runner' ORDER BY created").bind(userId).all()).results;
  const host = runners.find(r => (r.label || 'runner') === (u?.host || '')) || null;
  const info = host?.info ? JSON.parse(host.info) : null;
  return {
    hostLabel: host ? (host.label || 'runner') : null,
    // 主機模式: the host works from its own data and only checks in with the cloud every 10 minutes
    online: !!host && (+u?.hmode === 1 ? now() - (u.hseen || 0) < HOST_SEEN_MS : now() - (host.seen || 0) < HOST_ONLINE_MS),
    hmode: +u?.hmode === 1,
    engines: info?.engines || (u?.engines ? JSON.parse(u.engines) : null),
    models: info?.models || null,
    runners
  };
}

// ---------- 主機模式: the account's data lives on the host computer ----------
// The cloud keeps accounts and sign-ins, and forwards everything else through the host's tunnel, signed with
// HMAC-SHA256(hkey, user \n ts \n method \n path?query \n sha256(body)). The host checks the signature and answers
// from its own database. A host that is off answers nothing: the cloud says so (503 hostOffline).
// Paths the cloud always answers itself, even when the data is on the host computer:
const CLOUD_ONLY = /^(signup|login|logout|password|reset|reset\/send|reset-code|pair|config|cron|me|devices|devices\/remove|host|host\/[a-z]+|runner-token|runner\/hello|runner\/bye|coach)$/;
// hook/<key> and coach/<key> are looked up in the cloud, then forwarded (see route()).
const HOST_SEEN_MS = 15 * MIN;
const HOST_TABLES = ['bots', 'groups_', 'folders', 'routines', 'messages', 'jobs', 'files', 'stats', 'code_repos', 'code_tasks'];   // + settings, chunks   // the host registers every 10 minutes
const HOST_TIMEOUT = 40000;      // longer than a long-poll (25 s) or a file read (20 s) on the host
const CACHE_MS = 60000;          // D1 讀取量: sign-ins and 主機模式 fields are kept in this isolate's memory for a minute
const sesCache = new Map(), userCache = new Map();
const cacheGet = (map, k) => { const c = map.get(k); return c && c.exp > now() ? c.v : undefined; };
const cacheSet = (map, k, v) => { if (map.size > 5000) map.clear(); map.set(k, { v, exp: now() + CACHE_MS }); };
function forgetUser(userId) { userCache.delete(userId); for (const [k, c] of sesCache) if (c.v?.user_id === userId) sesCache.delete(k); }
const hostFields = r => ({ hmode: +r?.hmode === 1 ? 1 : 0, hurl: r?.hurl || null, hkey: r?.hkey || null });
async function hostOf(db, userId) {
  let h = cacheGet(userCache, userId);
  if (!h) { h = hostFields(await db.prepare('SELECT hmode, hurl, hkey FROM users WHERE id=?').bind(userId).first()); cacheSet(userCache, userId, h); }
  return h;
}
// a session lookup that is free for a minute when the account is in 主機模式 (at most one D1 read otherwise)
async function sessionLookup(db, tok) {
  const c = cacheGet(sesCache, tok), h = c && cacheGet(userCache, c.user_id);
  if (c && h?.hmode === 1) return { s: { ...c, ...h }, fresh: false };
  const s = await db.prepare(SES_SQL).bind(tok).first();
  if (s) {
    cacheSet(sesCache, tok, { token: s.token, user_id: s.user_id, kind: s.kind, label: s.label, seen: s.seen, created: s.created, name: s.name });
    cacheSet(userCache, s.user_id, hostFields(s));
  }
  return { s, fresh: true };
}
export const hostSignText = (user, ts, method, pathQuery, bodyHash) => `${user}\n${ts}\n${method}\n${pathQuery}\n${bodyHash}`;
export async function hostSign(key, user, ts, method, pathQuery, body) {
  const bytes = body == null ? new Uint8Array() : typeof body === 'string' ? enc.encode(body) : new Uint8Array(body);
  const bh = hex(await crypto.subtle.digest('SHA-256', bytes));
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return { sig: hex(await crypto.subtle.sign('HMAC', k, enc.encode(hostSignText(user, ts, method, pathQuery, bh)))), bodyHash: bh, bytes };
}
const hostOffline = () => J({ error: '主機電腦目前沒有連線，開機並打開 OCTA 後會自動恢復', hostOffline: true }, 503);
// send one request to the host computer. null: the computer says it no longer keeps this account's data.
async function toHost(h, userId, method, pathQuery, body, extra = {}) {
  if (!h?.hurl || !h?.hkey) return hostOffline();
  const ts = String(now());
  const { sig, bytes } = await hostSign(h.hkey, userId, ts, method, pathQuery, ['GET', 'HEAD'].includes(method) ? null : body);
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), HOST_TIMEOUT);
  let r;
  try {
    r = await fetch(h.hurl.replace(/\/+$/, '') + '/api/' + pathQuery, {
      method, signal: ctl.signal, body: ['GET', 'HEAD'].includes(method) ? undefined : bytes,
      headers: { 'content-type': extra['content-type'] || 'application/json', 'x-octa-user': userId, 'x-octa-ts': ts, 'x-octa-sig': sig, ...extra }
    });
  } catch { clearTimeout(timer); return hostOffline(); }
  clearTimeout(timer);
  const said = r.headers.get('x-octa-host');
  if (said === 'off') return null;
  if (said === 'bad') return J({ error: '主機電腦的連線金鑰不符，請在主機電腦重新打開 OCTA', hostOffline: true }, 503);
  if (said !== 'on') return hostOffline();   // the tunnel answered (computer off or OCTA closed), not OCTA
  return new Response(r.body, { status: r.status, headers: { 'content-type': r.headers.get('content-type') || 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}
// signed-in request for an account in 主機模式: forward it (web) or tell other computers to stand by (runner)
async function viaHost(req, env, path) {
  const a = req.headers.get('authorization') || '';
  const t = a.startsWith('Bearer ') ? a.slice(7) : '';
  if (!t) return null;
  const db = env.DB, tok = await sha(t);
  const { s, fresh } = await sessionLookup(db, tok);
  if (fresh) preAuth.set(req, s);
  if (!s || +s.hmode !== 1 || (s.kind !== 'web' && s.kind !== 'runner')) return null;
  if (s.kind === 'runner' && path.startsWith('runner/')) {   // the host computer works from its own data; others wait
    let wait = false;
    try { wait = !!(await req.clone().json()).wait; } catch { }
    if (path === 'runner/next' && wait) await sleep(WAIT_MS);
    return J({ job: null, standby: true, hostMode: true });
  }
  if (s.kind === 'web') {
    const last = s.seen || s.created;
    if (now() - last > SESSION_IDLE) return null;   // auth() signs it out
    if (now() - last > 6 * 3600000) {
      await db.prepare('UPDATE sessions SET seen=? WHERE token=?').bind(now(), tok).run();
      const c = cacheGet(sesCache, tok); if (c) c.seen = now();
    }
  }
  const url = new URL(req.url);
  const body = ['GET', 'HEAD'].includes(req.method) ? null : await req.clone().arrayBuffer();
  const r = await toHost(s, s.user_id, req.method, url.pathname.replace(/^\/api\/?/, '') + url.search, body,
    { 'content-type': req.headers.get('content-type') || 'application/json', 'x-octa-origin': url.origin });
  if (r) return r;
  forgetUser(s.user_id); preAuth.delete(req);   // the computer stopped keeping the data: answer from the cloud
  return null;
}

// ---------- 例行任務 ----------
// The host computer is the clock. sched 'cloud' is the alternate: the cloud fires, and a disconnected host waits.
// A time missed while the host was restarting is run once when it connects, and the person is told.
async function fireRoutines(env, db, userId, byHost) {
  const list = (await db.prepare('SELECT * FROM routines WHERE user_id=? AND enabled=1').bind(userId).all()).results;
  if (!list.length) return 0;
  const st = await getSettings(db, userId);
  const pc = st.sched !== 'cloud';
  if (pc && !byHost) return 0;
  const { date, hm } = localNow(env), late = localNow(env, now() - 10 * MIN).hm;
  let n = 0, all = null, hostOnline = null;
  for (const r of list) {
    const fired = JSON.parse(r.fired || '{}');
    const times = JSON.parse(r.times);
    const due = times.filter(t => !isEvery(t) && t <= hm && fired[t] !== date);
    // "every N minutes": due when N minutes passed since the last run, and the previous run is finished
    const ev = times.find(isEvery);
    if (ev && now() - (+fired[ev] || 0) >= (+ev.slice(2)) * MIN - 30000) {
      const open = await db.prepare("SELECT 1 FROM jobs WHERE user_id=? AND conv=? AND status IN ('pending','running') LIMIT 1").bind(userId, r.conv).first();
      if (!open) due.push(ev);
    }
    if (!due.length) continue;
    due.forEach(t => (fired[t] = isEvery(t) ? now() : date));
    const upd = await db.prepare("UPDATE routines SET fired=? WHERE id=? AND IFNULL(fired,'')=IFNULL(?,'')").bind(JSON.stringify(fired), r.id, r.fired).run();
    if (!upd.meta.changes) continue;   // someone else fired it
    const t = isEvery(due[due.length - 1]) ? hm : due[due.length - 1];
    const catchup = pc && !isEvery(due[due.length - 1]) && hm >= '00:10' && t < late;
    all = all || await loadAll(db, userId);
    const g = all.groups.find(x => x.id === r.conv), b = all.bots.find(x => x.id === r.conv);
    if (!g && !b) continue;
    // the bot is waiting for the user to sign in: don't run (and report the same thing) again until they reply
    const lastReal = await db.prepare("SELECT by_, text FROM messages WHERE user_id=? AND conv=? AND by_<>'sys' ORDER BY id DESC LIMIT 1").bind(userId, r.conv).first();
    if (lastReal && lastReal.by_ !== 'me' && /需要使用者在電腦上登入/.test(lastReal.text)) {
      const last = await db.prepare('SELECT by_, text FROM messages WHERE user_id=? AND conv=? ORDER BY id DESC LIMIT 1').bind(userId, r.conv).first();
      if (!(last?.by_ === 'sys' && last.text.startsWith('例行任務先暫停'))) { await addMsg(db, userId, r.conv, 'sys', `例行任務先暫停：「${r.name}」要等你在機器人的瀏覽器登入。登入後按「登入好了，繼續」或傳任何訊息，就會恢復。`); n++; }
      continue;
    }
    if (r.name !== STANDBY) await addMsg(db, userId, r.conv, 'sys', catchup ? `補做錯過的例行任務「${r.name}」（${t}）。主機剛連上，這一次會補做。` : `${t} 例行任務：${r.name}`);
    await addJob(db, userId, r.conv, g ? g.members : [b.id], `（例行任務「${r.name}」）${catchup ? '這是主機重開後補做的一次。' : ''}${r.prompt || '請執行你的指定任務，完成後回報結果。'}`);
    if (catchup) await sendNotify(env, st, `【OCTA】補做錯過的例行任務「${r.name}」`);
    if (!byHost) {
      if (hostOnline === null) hostOnline = env.isLocal ? true : (await hostInfo(db, userId)).online;
      if (!hostOnline) {
        await addMsg(db, userId, r.conv, 'sys', '主機電腦目前離線，開機連上後就會執行');
        await sendNotify(env, st, `【OCTA】例行任務「${r.name}」時間到了，但主機電腦離線。電腦開機連上 OCTA 後會自動執行。`);
      }
    }
    n++;
  }
  if (n) await bump(db, userId);
  return n;
}

// ---------- event triggers ----------
// hook: a secret key → POST /api/hook/<key> starts the routine (LINE webhook, Zapier, forms…)
// watch: {url, sel, every} → the host computer checks the page in the bot's browser and starts the routine when it changes
function triggerFrom(body, old) {
  const t = body.trigger;
  if (t === 'hook') return { hook: old?.hook || randTok(), watch: null };
  if (t === 'watch') {
    let url = clean(body.watch?.url, 500);
    if (url && !/^https?:\/\//.test(url)) url = 'https://' + url;
    if (!url) throw new Error('要監看的網址要填');
    const every = [5, 10, 15, 30, 60].includes(+body.watch?.every) ? +body.watch.every : 10;
    return { hook: null, watch: JSON.stringify({ url, sel: clean(body.watch?.sel, 200), every }) };
  }
  return { hook: null, watch: null };
}
// a routine started by an event: if an earlier event is still waiting in line, add this one to it
async function fireEvent(env, db, r, what) {
  const pend = await db.prepare("SELECT id,prompt FROM jobs WHERE user_id=? AND conv=? AND status='pending' AND prompt LIKE ? ORDER BY id DESC LIMIT 1").bind(r.user_id, r.conv, `（例行任務「${r.name}」%`).first();
  if (pend) { await db.prepare('UPDATE jobs SET prompt=? WHERE id=?').bind((pend.prompt + '\n\n（又來一個事件）\n' + what).slice(0, 20000), pend.id).run(); await bump(db, r.user_id); return 'merged'; }
  const all = await loadAll(db, r.user_id);
  const g = all.groups.find(x => x.id === r.conv), b = all.bots.find(x => x.id === r.conv);
  if (!g && !b) return 'gone';
  await addMsg(db, r.user_id, r.conv, 'sys', /交接的工作：/.test(what) ? `⚡ ${what.slice(0, 300)}` : `⚡ 事件觸發：${r.name}`);
  await addJob(db, r.user_id, r.conv, g ? g.members : [b.id], `（例行任務「${r.name}」由事件觸發）${r.prompt || '請執行你的指定任務，完成後回報結果。'}\n\n事件內容：\n${what}`.slice(0, 20000));
  await bump(db, r.user_id);
  return 'fired';
}
// LINE webhook body → readable lines
function describeEvent(raw, body) {
  if (body && Array.isArray(body.events)) {
    return body.events.map(e => {
      const who = e.source?.userId ? `（使用者 ${e.source.userId}）` : '';
      if (e.type === 'message') return `LINE ${e.message?.type === 'text' ? '文字訊息' : e.message?.type || '訊息'}${who}：${e.message?.text || ''}`;
      return `LINE 事件 ${e.type}${who}`;
    }).join('\n');
  }
  // another AI (e.g. Grok Bot) handing work over: {"text": "...", "from": "..."}
  const t = body && typeof body === 'object' ? body.text || body.task || body.message || body.content : null;
  if (typeof t === 'string' && t.trim()) return `${body.from ? `「${String(body.from).slice(0, 40)}」` : '外部'}交接的工作：${t.slice(0, 4000)}`;
  return raw.slice(0, 4000);
}

// works with runners that don't know the marker yet: the note travels with the prompt
const ROUTINE_SELF = '\n\n（系統說明：你可以自己管理例行任務。要刪除、暫停或恢復時，在回覆最後寫一行「⏰刪除：名稱」「⏰停用：名稱」或「⏰啟用：名稱」，多個用、分開，名稱照你現有的例行任務抄，系統會直接處理。不要叫使用者去任務設定手動處理，也不要說自己刪不掉。）';
// ---------- coach link: another AI (e.g. Grok Bot) follows up on and trains the OCTA bots ----------
// The key is stored hashed in sessions (kind 'coach'); auth() never accepts it, so it only opens these routes.
const coachGuide = (base, coach) => `你是 OCTA 機器人們的教練「${coach}」。OCTA 的機器人在使用者的電腦上工作（瀏覽器、登入好的網站、檔案）。你的工作：交派任務、檢查成果、給回饋、把你會的做法教給它們，必要時建立接班人。
所有網址都以 ${base} 開頭，回傳 JSON。POST 用 Content-Type: application/json。
1. GET ${base} → 這份說明＋機器人(bots)和群組(groups)清單。
2. GET ${base}/bot/<id> → 它的任務、記憶、技能、最近 30 則對話、是否在忙。<id> 可以是機器人或群組。
3. POST ${base}/ask {"to":"<id>","text":"要它做的事或問題"} → 它會開始做，回傳 {"job":編號}。加 "feedback":true 表示這是你對它上一個成果的回饋，它會修正並記下教訓。
4. GET ${base}/job/<編號>?wait=25 → {"status":"pending|running|done|error","replies":[它的回覆]}。wait 最多等 25 秒，沒好就再查一次。
5. POST ${base}/teach {"to":"<id>","remember":["要它永遠記住的事"],"skill":{"name":"技能名","steps":"一步一步的做法"},"task":"新的任務說明（會取代舊的，可省略）"} → 直接寫進它的記憶／技能／任務。
5b. POST ${base}/routine {"to":"<id>","name":"例行任務名","op":"add|delete|disable|enable","times":["07:55","*/30"],"prompt":"每次要做的事"} → 幫它新增、修改、刪除或暫停例行任務（GET bot/<id> 的 routines 看現有的）。
6. POST ${base}/hire {"name":"接班人名字","task":"它負責的工作，寫清楚步驟與標準","remember":["交接重點"],"avatar":"🤖"} → 建立新的 OCTA 機器人，回傳 {"id":...}。
7. GET ${base}/inbox?since=<上次看到的訊息編號> → 機器人們的新回覆（含 asks=true 的提問）。定時查這裡就能跟進；有人問問題就用 ask 回答它。
帶人的方法：先 ask 讓它實際做一次 → 用 job 看結果 → 錯了就 ask 加 feedback 指出哪裡錯、正確答案是什麼 → 穩定的做法用 teach 寫成 remember 或 skill。不要替它編造資料，也不要要求它付款、刪除或對外發訊息而不經使用者同意。`;
async function coachApi(env, db, path, m, body, url, pathQuery, rawBody) {
  const [, key, sub = '', arg = ''] = path.split('/');
  if (!/^[0-9a-f]{48}$/.test(key || '')) return err('找不到', 404);
  // on a host computer the cloud already checked the link (the forwarded request is signed)
  const s = env.coachAs || await db.prepare("SELECT user_id,label FROM sessions WHERE token=? AND kind='coach'").bind(await sha(key)).first();
  if (!s) return err('這個教練連結已停用', 404);
  if (!env.isLocal) {   // 主機模式: the bots' data is on the host computer
    const h = await hostOf(db, s.user_id);
    if (h.hmode === 1) {
      const fr = await toHost(h, s.user_id, m, pathQuery, rawBody, { 'x-octa-coach': encodeURIComponent(s.label || 'Grok Bot'), 'x-octa-origin': url.origin });
      if (fr) return fr;
    }
  }
  const lim = [['coach:' + key.slice(0, 16), 400]];
  if (await blocked(db, lim)) return J({ error: '太頻繁了，15 分鐘後再試' }, 429);
  if (m === 'POST') await failed(db, lim);   // counts changes per 15 minutes
  const U = s.user_id, coach = s.label || 'Grok Bot';
  const base = `${url.origin}/api/coach/${key}`;
  const q = k => body?.[k] ?? url.searchParams.get(k);
  const all = await loadAll(db, U);
  const named = id => all.bots.find(b => b.id === id)?.name || (id === 'me' ? '使用者' : id === 'sys' ? '系統' : id);
  const target = id => { const b = all.bots.find(x => x.id === id || x.name === id); if (b) return { b }; const g = all.groups.find(x => x.id === id || x.name === id); return g ? { g } : null; };
  const busyOf = async conv => !!(await db.prepare("SELECT 1 FROM jobs WHERE user_id=? AND conv=? AND status IN ('pending','running') LIMIT 1").bind(U, conv).first());
  if (!sub && m === 'GET') return J({
    guide: coachGuide(base, coach),
    bots: all.bots.map(b => ({ id: b.id, name: b.name, avatar: b.avatar || '', task: b.task, engine: b.engine })),
    groups: all.groups.map(g => ({ id: g.id, name: g.name, task: g.task, members: g.members.map(named) }))
  });
  if (sub === 'bot' && m === 'GET') {
    const t = target(decodeURIComponent(arg)); if (!t) return err('找不到這個機器人或群組', 404);
    const it = t.b || t.g, st = await getSettings(db, U);
    const msgs = (await db.prepare('SELECT id,by_,text,ts FROM messages WHERE user_id=? AND conv=? ORDER BY id DESC LIMIT 30').bind(U, it.id).all()).results.reverse();
    return J({ id: it.id, name: it.name, task: it.task, kind: t.b ? 'bot' : 'group', members: t.g ? it.members.map(named) : undefined,
      memory: t.b ? (st.memory || {})[it.id] || [] : undefined, skills: t.b ? (st.skills || {})[it.id] || [] : undefined,
      notes: (all.folders.find(f => f.id === it.folder)?.notes || '').slice(0, 3000), busy: await busyOf(it.id),
      routines: all.routines.filter(r => r.conv === it.id).map(r => ({ name: r.name, times: r.times, enabled: r.enabled, prompt: r.prompt })),
      messages: msgs.map(x => ({ id: x.id, from: named(x.by_), text: String(x.text).slice(0, 2500), ts: x.ts })) });
  }
  if (sub === 'ask' && (m === 'POST' || m === 'GET')) {
    const t = target(clean(q('to'), 64)), text = clean(q('text'), 6000);
    if (!t || !text) return err('要有 to（機器人或群組）和 text');
    if (m === 'GET') await failed(db, lim);
    const fb = q('feedback') === true || q('feedback') === 'true' || q('feedback') === '1';
    const conv = (t.b || t.g).id;
    await addMsg(db, U, conv, 'sys', `🎓 ${coach}${fb ? '的回饋' : ''}：${text.slice(0, 1500)}`);
    const prompt = fb ? `（你的教練「${coach}」看過你的成果，給你回饋。照回饋修正並重做需要重做的部分，最後用 📌記住 寫下這次學到的教訓。）\n${text}`
      : `（你的教練「${coach}」交代你。照做或回答；他會檢查你的回覆。學到可重複的做法時用 📌記住 或 🧩技能 留下。）\n${text}`;
    const r = await db.prepare('INSERT INTO jobs (user_id,conv,bot_id,chain,prompt,created,depth) VALUES (?,?,?,?,?,?,0)')
      .bind(U, conv, t.b ? t.b.id : t.g.members[0], JSON.stringify(t.b ? [] : t.g.members.slice(1).map(b => ({ b, p: prompt }))), prompt, now()).run();
    await bump(db, U);
    return J({ ok: true, job: r.meta.last_row_id, conv });
  }
  if (sub === 'job' && m === 'GET') {
    const job = await db.prepare('SELECT id,conv,status,created FROM jobs WHERE id=? AND user_id=?').bind(+arg || 0, U).first();
    if (!job) return err('找不到這個工作', 404);
    const wait = Math.min(25, Math.max(0, +url.searchParams.get('wait') || 0)), t0 = now();
    let busy = await busyOf(job.conv);
    while (busy && now() - t0 < wait * 1000) { await sleep(2500); busy = await busyOf(job.conv); }
    const fresh = await db.prepare('SELECT status FROM jobs WHERE id=?').bind(job.id).first();
    const replies = (await db.prepare("SELECT id,by_,text,ts FROM messages WHERE user_id=? AND conv=? AND ts>=? AND by_<>'sys' AND by_<>'me' ORDER BY id LIMIT 20").bind(U, job.conv, job.created).all()).results;
    return J({ status: fresh?.status === 'error' ? 'error' : busy ? (fresh?.status === 'pending' ? 'pending' : 'running') : 'done',
      replies: replies.map(x => ({ id: x.id, from: named(x.by_), text: String(x.text).slice(0, 4000) })) });
  }
  if (sub === 'teach' && m === 'POST') {
    const t = target(clean(body.to, 64)); if (!t?.b) return err('to 要是一個機器人');
    const id = t.b.id, st = await getSettings(db, U), done = [];
    const rem = (Array.isArray(body.remember) ? body.remember : body.remember ? [body.remember] : []).map(x => clean(x, 300)).filter(Boolean).slice(0, 10);
    if (rem.length) { st.memory = st.memory || {}; st.memory[id] = [...new Set([...(st.memory[id] || []), ...rem])].slice(-40); done.push(`記住：${rem.join('；')}`); }
    const sk = body.skill && clean(body.skill.name, 40) && clean(body.skill.steps, 3000) ? { name: clean(body.skill.name, 40), steps: clean(body.skill.steps, 3000) } : null;
    if (sk) { st.skills = st.skills || {}; st.skills[id] = [...(st.skills[id] || []).filter(x => x.name !== sk.name), sk].slice(-20); done.push(`技能「${sk.name}」`); }
    if (rem.length || sk) await putSettings(db, U, st);
    const task = clean(body.task, 4000);
    if (task) { await db.prepare('UPDATE bots SET task=? WHERE id=? AND user_id=?').bind(task, id, U).run(); done.push('更新了任務'); }
    if (!done.length) return err('要有 remember、skill 或 task');
    await addMsg(db, U, id, 'sys', `🎓 ${coach}教了它：${done.join('、').slice(0, 400)}`);
    await bump(db, U);
    return J({ ok: true });
  }
  if (sub === 'routine' && m === 'POST') {   // {to, name, op: add|delete|disable|enable, times:["08:00","*/30"], prompt}
    const t = target(clean(body.to, 64)), name = clean(body.name, 40), op = clean(body.op, 10) || 'add';
    if (!t || !name) return err('要有 to 和 name');
    const conv = (t.b || t.g).id, old = all.routines.find(r => r.conv === conv && r.name === name);
    if (op === 'add') {
      const times = cleanTimes((Array.isArray(body.times) ? body.times : String(body.times || '').split(/[,，、\s]+/)).map(x => String(x).trim()));
      if (!times.length) return err('times 要有時間，例如 ["08:00","*/30"]');
      const prompt = clean(body.prompt, 2000), { date, hm } = localNow(env);
      const fired = JSON.stringify(Object.fromEntries(times.filter(x => !isEvery(x) && x <= hm).map(x => [x, date])));
      if (old) await db.prepare('UPDATE routines SET times=?,prompt=?,enabled=1,fired=? WHERE id=?').bind(JSON.stringify(times), prompt || old.prompt, fired, old.id).run();
      else await db.prepare('INSERT INTO routines (id,user_id,conv,name,prompt,times,enabled,fired,created) VALUES (?,?,?,?,?,?,1,?,?)').bind('r-' + uid(), U, conv, name, prompt, JSON.stringify(times), fired, now()).run();
    } else {
      if (!old) return err('找不到這個例行任務', 404);
      if (op === 'delete') await db.prepare('DELETE FROM routines WHERE id=?').bind(old.id).run();
      else if (op === 'disable' || op === 'enable') await db.prepare('UPDATE routines SET enabled=? WHERE id=?').bind(op === 'enable' ? 1 : 0, old.id).run();
      else return err('op 只能是 add、delete、disable、enable');
    }
    const word = { add: old ? '更新' : '新增', delete: '刪除', disable: '停用', enable: '啟用' }[op];
    await addMsg(db, U, conv, 'sys', `🎓 ${coach}${word}了例行任務「${name}」`);
    await bump(db, U);
    return J({ ok: true });
  }
  if (sub === 'hire' && m === 'POST') {
    let name = clean(noSpaces(clean(body.name, 20)), 20), task = clean(body.task, 4000);
    if (!name || !task) return err('要有 name 和 task');
    if (all.bots.length >= 60) return err('機器人太多了');
    for (let i = 2; all.bots.some(b => b.name === name); i++) name = clean(noSpaces(clean(body.name, 17)), 17) + i;
    let eng = {}; try { eng = JSON.parse((await db.prepare('SELECT engines FROM users WHERE id=?').bind(U).first())?.engines || '{}') || {}; } catch { }
    const engine = ['claude', 'codex', 'gemini', 'opencode'].find(e => eng[e]) || all.bots[all.bots.length - 1]?.engine || 'claude';
    const id = 'b-' + uid();
    await db.prepare('INSERT INTO bots (id,user_id,name,task,folder,engine,model,avatar,browser,created,fb) VALUES (?,?,?,?,NULL,?,NULL,?,NULL,?,?)').bind(id, U, name, task, engine, avatarOk(body.avatar) || '🤖', now(), '[]').run();
    const rem = (Array.isArray(body.remember) ? body.remember : []).map(x => clean(x, 300)).filter(Boolean).slice(0, 20);
    if (rem.length) { const st = await getSettings(db, U); st.memory = st.memory || {}; st.memory[id] = rem; await putSettings(db, U, st); }
    await addMsg(db, U, id, 'sys', `🎓 ${coach}建立了這個機器人，當它的接班人。`);
    await bump(db, U);
    return J({ ok: true, id, name, engine });
  }
  if (sub === 'inbox' && m === 'GET') {
    const since = +url.searchParams.get('since') || 0;
    const rows = (await db.prepare("SELECT id,conv,by_,text,ts FROM messages WHERE user_id=? AND id>? AND by_<>'sys' AND by_<>'me' ORDER BY id DESC LIMIT 40").bind(U, since).all()).results.reverse();
    const conv = id => all.bots.find(b => b.id === id)?.name || all.groups.find(g => g.id === id)?.name || id;
    return J({ last: rows.length ? rows[rows.length - 1].id : since, messages: rows.map(x => ({ id: x.id, conv: x.conv, where: conv(x.conv), from: named(x.by_), text: String(x.text).slice(0, 2000), asks: asksUser(x.text), ts: x.ts })) });
  }
  return err('找不到，先 GET ' + base + ' 看說明', 404);
}

// ---------- rate limiting (sign-in, password reset) ----------
async function blocked(db, keys) {
  for (const [k, max] of keys) {
    const r = await db.prepare('SELECT fails,until FROM logins WHERE k=?').bind(k).first();
    if (r && r.until > now() && r.fails >= max) return Math.ceil((r.until - now()) / MIN);
  }
  return 0;
}
async function failed(db, keys) {
  for (const [k] of keys)
    await db.prepare(`INSERT INTO logins (k,fails,until) VALUES (?,1,?) ON CONFLICT(k) DO UPDATE SET
      fails=CASE WHEN until<? THEN 1 ELSE fails+1 END, until=CASE WHEN until<? THEN excluded.until ELSE until END`).bind(k, now() + 15 * MIN, now(), now()).run();
}
const cleared = (db, keys) => db.batch(keys.map(([k]) => db.prepare('DELETE FROM logins WHERE k=?').bind(k)));

// ---------- files ----------
async function storeChunks(db, fileId, data) {
  const st = [];
  for (let i = 0, n = 0; i < data.length; i += CHUNK, n++) st.push(db.prepare('INSERT OR REPLACE INTO chunks (file_id,n,data,ts) VALUES (?,?,?,?)').bind(fileId, n, data.slice(i, i + CHUNK), now()));
  for (let i = 0; i < st.length; i += 20) await db.batch(st.slice(i, i + 20));
}
async function readChunks(db, fileId) {
  return (await db.prepare('SELECT data FROM chunks WHERE file_id=? ORDER BY n').bind(fileId).all()).results.map(r => r.data).join('');
}
// periodic clean-up, run from /api/cron about once an hour
async function cleanup(db) {
  const t = now();
  await db.batch([
    db.prepare("DELETE FROM chunks WHERE file_id IN (SELECT id FROM files WHERE loc='pc') AND ts<?").bind(t - 3600000),   // temporary viewing copies
    db.prepare("UPDATE files SET want=NULL WHERE loc='pc' AND want IS NOT NULL AND id NOT IN (SELECT file_id FROM chunks)"),
    db.prepare("DELETE FROM chunks WHERE file_id IN (SELECT id FROM files WHERE loc='cloud' AND conv IS NULL AND ts<?)").bind(t - 2 * DAY),
    db.prepare("DELETE FROM files WHERE loc='cloud' AND conv IS NULL AND ts<?").bind(t - 2 * DAY),
    db.prepare("DELETE FROM jobs WHERE status IN ('done','error') AND created<?").bind(t - 14 * DAY),
    db.prepare("UPDATE live SET data='' WHERE ts<? AND data<>''").bind(t - 6 * 3600000),   // old browser frames take space and time
    db.prepare("DELETE FROM sessions WHERE kind='web' AND IFNULL(seen,created)<?").bind(t - SESSION_IDLE),
    db.prepare('DELETE FROM logins WHERE until<?').bind(t - DAY),
    db.prepare('DELETE FROM stats WHERE day<?').bind(new Date(t - 60 * DAY).toISOString().slice(0, 10))   // 成果看板 shows 30 days
  ]);
}

// Templates offered in the app, per interface language (generated from i18n/templates.py)
const TEMPLATES_I18N = {
 "zh-TW": {
  "assistant": {
   "folder": null,
   "bots": [
    [
     "a",
     "助理",
     "回答我的問題。需要時用瀏覽器查資料，或操作我已登入的網站。做完用幾句話回報重點。"
    ]
   ],
   "groups": []
  },
  "research": {
   "folder": "研究",
   "bots": [
    [
     "r1",
     "查資料員",
     "依我的問題上網找資料，至少比對兩個來源，附上網址。"
    ],
    [
     "r2",
     "整理員",
     "把查資料員找到的內容整理成重點摘要或表格，標出不確定的地方。"
    ]
   ],
   "groups": [
    [
     "研究小組",
     "查資料員先找資料，整理員再整理成摘要。",
     [
      "r1",
      "r2"
     ]
    ]
   ]
  },
  "shop": {
   "folder": "門市",
   "bots": [
    [
     "s1",
     "訂單員",
     "打開分區資料裡寫的訂單後台，整理今天的新訂單：品項、數量、客人、取貨或出貨時間。"
    ],
    [
     "s2",
     "客服員",
     "依訂單員的資料，擬好要回覆客人的訊息，列出來給我確認。我說「發送」前不要發出。"
    ],
    [
     "s3",
     "回報員",
     "把今天的訂單和待處理事項整理成一則簡短日報。"
    ]
   ],
   "groups": [
    [
     "每日門市流程",
     "訂單員整理訂單 → 客服員擬回覆 → 回報員寫日報。",
     [
      "s1",
      "s2",
      "s3"
     ]
    ]
   ]
  },
  "lodging": {
   "folder": "民宿",
   "notes": "住宿日期規則：暱稱或訂單的日期換成「住哪幾晚」再分類（「10/21-23」＝住 10/21、10/22、10/23 三晚，10/24 退房）。第一晚是今天＝今日入住；昨天和今天都住＝今日續住（最後一晚是今天的人明天才退房）；最後一晚是昨天＝今天退房。應掃房＝昨晚有住、今晚沒有同一組客人續住的房間。名單照館別、房號由小到大排，每行「館別 房號 姓名」；一人多房、同房多組、延期、取消另外列出來給我決定。",
   "bots": [
    [
     "l1",
     "訂房員",
     "打開分區資料裡寫的訂房平台後台，整理今天與明天的入住、退房：房號、客人、晚數。"
    ],
    [
     "l2",
     "房務員",
     "依訂房員的資料，算出今天要打掃的房間，列成清單；分區資料有房務看板網址時就更新上去。"
    ],
    [
     "l3",
     "迎賓員",
     "依今天入住名單，用分區資料裡的入住說明擬好每位客人的訊息，列出來給我確認。我說「發送」前不要發出。"
    ]
   ],
   "groups": [
    [
     "每日入住流程",
     "訂房員整理訂房 → 房務員排打掃 → 迎賓員擬入住訊息給我確認。",
     [
      "l1",
      "l2",
      "l3"
     ]
    ]
   ]
  },
  "remind": {
   "folder": "排程發訊",
   "notes": "提醒清單（一行一件）：時間｜要提醒的事｜發到哪裡（不寫就發在 OCTA 對話）。例：每天 09:00｜提醒我喝水｜OCTA。要發到 LINE、Telegram 等外部對象時寫清楚對象，第一次發送前會先給你確認。",
   "bots": [
    [
     "m1",
     "提醒員",
     "依分區資料的提醒清單，在例行任務時間到時擬好要發的提醒或訊息。發在 OCTA 對話的直接發；要發給別人（LINE、Email 等）時，第一次先列出來給我確認，我說「發送」前不要發出。我說要新增或更改提醒時間時，用例行任務排好，並更新提醒清單。"
    ]
   ],
   "groups": [],
   "routines": [
    [
     "m1",
     "每日提醒",
     [
      "09:00"
     ],
     "看分區資料的提醒清單，把今天這個時間要提醒的事整理成一則訊息發給我；有要發給別人的，先列出來給我確認。"
    ]
   ]
  },
  "tidy": {
   "folder": "資料整理",
   "notes": "輸出格式：CSV（或 Excel）。常用欄位：姓名、電話、Email、日期。日期寫成 2026-01-31，電話只留數字。",
   "bots": [
    [
     "d1",
     "整理員",
     "把我給的表格、名單或檔案（附件、Google 試算表、網頁）整理乾淨：去除重複、統一格式（日期、電話、姓名）、依分區資料或我說的欄位排序，輸出成檔案放在輸出資料夾。做完列出改了什麼，以及有疑問、需要我決定的列。不要刪掉看不懂的資料，另外列出來。"
    ]
   ],
   "groups": []
  },
  "watch": {
   "folder": "網站監看",
   "notes": "要監看的網址（一行一個，可加上要注意的內容）：\n例：https://example.com/news｜有新公告時通知我",
   "bots": [
    [
     "w1",
     "監看員",
     "我給你網址（或分區資料列出網址）時，替每個網址設好例行任務：在回覆最後寫「⏰例行任務：監看 網站名｜每10分鐘監看 網址｜網頁有變化時要做的事」。網頁有變化時，打開網頁確認新內容，用幾句話告訴我變了什麼並附上網址；只是廣告、時間或版面小變動就回「（略過）」。"
    ]
   ],
   "groups": []
  },
  "game": {
   "folder": "遊戲自動化",
   "notes": "遊戲網址：\n每次要做的步驟：1. 登入 2. 領每日獎勵 3. …\n注意：遵守遊戲規則，不要購買任何東西。",
   "bots": [
    [
     "g1",
     "遊戲員",
     "依分區資料寫的遊戲網址和步驟，用瀏覽器打開遊戲網頁，做重複的操作（例如每日簽到、領獎勵、收成）。做完回報做了什麼、拿到什麼。遇到要付款、輸入密碼或驗證碼就停下來問我；不要購買任何東西，也不要更改帳號設定。"
    ]
   ],
   "groups": [],
   "routines": [
    [
     "g1",
     "每日遊戲",
     [
      "09:00",
      "21:00"
     ],
     "照分區資料的步驟打開遊戲網頁，完成每日操作，做完回報。"
    ]
   ]
  }
 },
 "en": {
  "assistant": {
   "folder": null,
   "bots": [
    [
     "a",
     "Assistant",
     "Answer my questions. Use the browser to look things up or work on sites I am signed into when needed. Report the key points in a few sentences when done."
    ]
   ],
   "groups": []
  },
  "research": {
   "folder": "Research",
   "bots": [
    [
     "r1",
     "Researcher",
     "Search the web for my question, compare at least two sources, and include links."
    ],
    [
     "r2",
     "Summarizer",
     "Turn what the Researcher found into a short summary or table and flag anything uncertain."
    ]
   ],
   "groups": [
    [
     "Research team",
     "The Researcher finds sources first, then the Summarizer writes the summary.",
     [
      "r1",
      "r2"
     ]
    ]
   ]
  },
  "shop": {
   "folder": "Shop",
   "bots": [
    [
     "s1",
     "Order clerk",
     "Open the order dashboard listed in the folder notes and list today’s new orders: items, quantities, customers, pickup or shipping times."
    ],
    [
     "s2",
     "Support",
     "Using the Order clerk’s list, draft replies to customers and show them to me for approval. Do not send anything until I say “send”."
    ],
    [
     "s3",
     "Reporter",
     "Write a short daily report of today’s orders and open items."
    ]
   ],
   "groups": [
    [
     "Daily shop routine",
     "Order clerk lists orders → Support drafts replies → Reporter writes the daily report.",
     [
      "s1",
      "s2",
      "s3"
     ]
    ]
   ]
  },
  "lodging": {
   "folder": "Guesthouse",
   "notes": "Stay rules: turn each booking's dates into the nights stayed (\"10/21-23\" = nights of 10/21, 10/22, 10/23, checkout 10/24). First night today = check-in today; stayed last night and tonight = continuing; last night was yesterday = checking out today. Rooms to clean = rooms occupied last night with no continuing stay tonight. Sort lists by property and room number; list unclear cases separately for me to decide.",
   "bots": [
    [
     "l1",
     "Bookings",
     "Open the booking platform dashboard listed in the folder notes and list today’s and tomorrow’s check-ins and check-outs: room, guest, nights."
    ],
    [
     "l2",
     "Housekeeping",
     "From the Bookings list, work out which rooms need cleaning today; update the housekeeping board if the folder notes list one."
    ],
    [
     "l3",
     "Welcome",
     "For today’s arrivals, draft each guest’s message using the check-in instructions in the folder notes and show them to me for approval. Do not send anything until I say “send”."
    ]
   ],
   "groups": [
    [
     "Daily check-in routine",
     "Bookings lists arrivals → Housekeeping plans cleaning → Welcome drafts check-in messages for my approval.",
     [
      "l1",
      "l2",
      "l3"
     ]
    ]
   ]
  },
  "remind": {
   "folder": "Scheduled messages",
   "notes": "Reminder list (one per line): time | what to remind | where to send (leave empty for this OCTA chat). Example: daily 09:00 | remind me to drink water | OCTA. For LINE, Telegram or other people, name the recipient; the first message is shown to you for approval.",
   "bots": [
    [
     "m1",
     "Reminder",
     "Using the reminder list in the folder notes, draft the reminders or messages when a routine runs. Post reminders in this OCTA chat directly; for messages to other people (LINE, email, etc.) show them to me for approval the first time and do not send anything until I say “send”. When I ask to add or change a reminder time, set it up as a routine and update the reminder list."
    ]
   ],
   "groups": [],
   "routines": [
    [
     "m1",
     "Daily reminder",
     [
      "09:00"
     ],
     "Check the reminder list in the folder notes and send me one message with what to remember at this time today; show anything meant for other people to me for approval first."
    ]
   ]
  },
  "tidy": {
   "folder": "Data cleanup",
   "notes": "Output format: CSV (or Excel). Common columns: name, phone, email, date. Dates as 2026-01-31; phone numbers digits only.",
   "bots": [
    [
     "d1",
     "Organizer",
     "Clean up the tables, lists or files I give you (attachments, Google Sheets, web pages): remove duplicates, make dates, phone numbers and names consistent, sort by the columns in the folder notes or what I ask, and save the result as a file in the output folder. When done, list what you changed and the rows that are unclear or need my decision. Do not delete data you do not understand; list it separately."
    ]
   ],
   "groups": []
  },
  "watch": {
   "folder": "Site watch",
   "notes": "URLs to watch (one per line, optionally with what to look for):\nExample: https://example.com/news | tell me about new announcements",
   "bots": [
    [
     "w1",
     "Watcher",
     "When I give you URLs (or the folder notes list them), set up a routine for each one by ending your reply with “⏰例行任務：Watch site name｜每10分鐘監看 URL｜what to do when the page changes”. When a page changes, open it, tell me in a few sentences what changed and include the link; if it is only ads, times or small layout changes, reply “（略過）”."
    ]
   ],
   "groups": []
  },
  "game": {
   "folder": "Game automation",
   "notes": "Game URL:\nSteps each time: 1. sign in 2. claim the daily reward 3. …\nNote: follow the game’s rules and never buy anything.",
   "bots": [
    [
     "g1",
     "Gamer",
     "Using the game URL and steps in the folder notes, open the game page in the browser and do the repeated actions (daily check-in, rewards, harvests, etc.). Report what you did and what you got. Stop and ask me if a payment, password or verification code is needed; never buy anything or change account settings."
    ]
   ],
   "groups": [],
   "routines": [
    [
     "g1",
     "Daily game",
     [
      "09:00",
      "21:00"
     ],
     "Open the game page and follow the steps in the folder notes to finish the daily actions, then report."
    ]
   ]
  }
 },
 "ja": {
  "assistant": {
   "folder": null,
   "bots": [
    [
     "a",
     "アシスタント",
     "私の質問に答えてください。必要に応じてブラウザで調べたり、ログイン済みのサイトを操作したりして、終わったら要点を数文で報告してください。"
    ]
   ],
   "groups": []
  },
  "research": {
   "folder": "リサーチ",
   "bots": [
    [
     "r1",
     "調査係",
     "質問についてウェブで調べ、2 つ以上の情報源を比較し、URL を添えてください。"
    ],
    [
     "r2",
     "まとめ係",
     "調査係が見つけた内容を要点や表にまとめ、不確かな点を明記してください。"
    ]
   ],
   "groups": [
    [
     "リサーチチーム",
     "調査係が先に調べ、まとめ係が要約します。",
     [
      "r1",
      "r2"
     ]
    ]
   ]
  },
  "shop": {
   "folder": "店舗",
   "bots": [
    [
     "s1",
     "注文係",
     "フォルダのメモに書かれた注文管理画面を開き、今日の新規注文（品目・数量・お客様・受け取りや発送の時間）をまとめてください。"
    ],
    [
     "s2",
     "カスタマー係",
     "注文係の情報をもとにお客様への返信を下書きし、確認のため私に見せてください。「送信」と言うまで送らないでください。"
    ],
    [
     "s3",
     "レポート係",
     "今日の注文と未対応の事項を短い日報にまとめてください。"
    ]
   ],
   "groups": [
    [
     "毎日の店舗業務",
     "注文係が注文を整理 → カスタマー係が返信を下書き → レポート係が日報を作成。",
     [
      "s1",
      "s2",
      "s3"
     ]
    ]
   ]
  },
  "lodging": {
   "folder": "民宿",
   "notes": "宿泊日のルール：予約の日付を「泊まる夜」に直して分類する（「10/21-23」＝10/21・10/22・10/23 の3泊、10/24 チェックアウト）。初日が今日＝本日チェックイン；昨夜も今夜も泊まる＝連泊；最終泊が昨夜＝本日チェックアウト。清掃する部屋＝昨夜使われ、今夜は同じ客が連泊しない部屋。施設・部屋番号順に並べ、不明な件は別にまとめて私に確認する。",
   "bots": [
    [
     "l1",
     "予約係",
     "フォルダのメモに書かれた予約サイトの管理画面を開き、今日と明日のチェックイン・チェックアウト（部屋番号・お客様・泊数）をまとめてください。"
    ],
    [
     "l2",
     "清掃係",
     "予約係の情報から今日清掃する部屋をリストにし、フォルダのメモに清掃ボードの URL があれば更新してください。"
    ],
    [
     "l3",
     "お迎え係",
     "今日到着するお客様ごとに、フォルダのメモのチェックイン案内を使ってメッセージを下書きし、確認のため私に見せてください。「送信」と言うまで送らないでください。"
    ]
   ],
   "groups": [
    [
     "毎日のチェックイン業務",
     "予約係が予約を整理 → 清掃係が清掃を計画 → お迎え係がチェックイン案内を下書きして私に確認。",
     [
      "l1",
      "l2",
      "l3"
     ]
    ]
   ]
  },
  "remind": {
   "folder": "定時メッセージ",
   "notes": "リマインド一覧（1 行に 1 件）：時間｜リマインドする内容｜送り先（空欄なら OCTA の会話）。例：毎日 09:00｜水を飲む｜OCTA。LINE や Telegram など他の人に送る場合は相手を書いてください。最初の送信前に確認をお願いします。",
   "bots": [
    [
     "m1",
     "リマインド係",
     "フォルダのメモのリマインド一覧をもとに、定期タスクの時間にリマインドやメッセージを作成してください。OCTA の会話へはそのまま送り、他の人（LINE、メールなど）へ送るものは最初に確認のため私に見せ、「送信」と言うまで送らないでください。リマインドの追加や時間変更を頼まれたら、定期タスクを設定し、一覧も更新してください。"
    ]
   ],
   "groups": [],
   "routines": [
    [
     "m1",
     "毎日のリマインド",
     [
      "09:00"
     ],
     "フォルダのメモのリマインド一覧を確認し、今日のこの時間に伝えることを 1 つのメッセージにまとめて送ってください。他の人に送るものは先に確認のため見せてください。"
    ]
   ]
  },
  "tidy": {
   "folder": "データ整理",
   "notes": "出力形式：CSV（または Excel）。よく使う列：氏名・電話・メール・日付。日付は 2026-01-31 形式、電話番号は数字のみ。",
   "bots": [
    [
     "d1",
     "整理係",
     "渡した表・名簿・ファイル（添付、Google スプレッドシート、ウェブページ）を整理してください：重複を除き、日付・電話・氏名の形式をそろえ、フォルダのメモか指示された列で並べ替え、出力フォルダにファイルとして保存します。終わったら変更点と、不明な行・判断が必要な行を一覧にしてください。分からないデータは削除せず、別にまとめてください。"
    ]
   ],
   "groups": []
  },
  "watch": {
   "folder": "サイト監視",
   "notes": "監視する URL（1 行に 1 つ、注目する内容も書けます）：\n例：https://example.com/news｜新しいお知らせがあれば通知",
   "bots": [
    [
     "w1",
     "監視係",
     "URL を渡されたら（またはフォルダのメモに URL があれば）、それぞれに定期タスクを設定してください。返信の最後に「⏰例行任務：監視 サイト名｜每10分鐘監看 URL｜ページが変わったときにすること」と書きます。ページが変わったら開いて確認し、何が変わったかを数文で URL 付きで伝えてください。広告・時刻・小さなレイアウト変更だけなら「（略過）」と返してください。"
    ]
   ],
   "groups": []
  },
  "game": {
   "folder": "ゲーム自動化",
   "notes": "ゲームの URL：\n毎回の手順：1. ログイン 2. デイリー報酬を受け取る 3. …\n注意：ゲームのルールを守り、何も購入しないこと。",
   "bots": [
    [
     "g1",
     "ゲーム係",
     "フォルダのメモのゲーム URL と手順に従い、ブラウザでゲームページを開いて繰り返しの操作（デイリーログイン、報酬受け取り、収穫など）を行ってください。何をして何を得たかを報告してください。支払い・パスワード・認証コードが必要になったら止めて聞いてください。何も購入せず、アカウント設定も変えないでください。"
    ]
   ],
   "groups": [],
   "routines": [
    [
     "g1",
     "毎日のゲーム",
     [
      "09:00",
      "21:00"
     ],
     "フォルダのメモの手順でゲームページを開き、デイリー操作を終えたら報告してください。"
    ]
   ]
  }
 },
 "zh-CN": {
  "assistant": {
   "folder": null,
   "bots": [
    [
     "a",
     "助理",
     "回答我的问题。需要时用浏览器查数据，或操作我已登录的网站。做完用几句话回报重点。"
    ]
   ],
   "groups": []
  },
  "research": {
   "folder": "研究",
   "bots": [
    [
     "r1",
     "查数据员",
     "依我的问题上网找数据，至少比对两个来源，附上网址。"
    ],
    [
     "r2",
     "整理员",
     "把查数据员找到的内容整理成重点摘要或表格，标出不确定的地方。"
    ]
   ],
   "groups": [
    [
     "研究小组",
     "查数据员先找数据，整理员再整理成摘要。",
     [
      "r1",
      "r2"
     ]
    ]
   ]
  },
  "shop": {
   "folder": "门市",
   "bots": [
    [
     "s1",
     "订单员",
     "打开分区数据里写的订单后台，整理今天的新订单：品项、数量、客人、取货或出货时间。"
    ],
    [
     "s2",
     "客服员",
     "依订单员的数据，拟好要回复客人的消息，列出来给我确认。我说「发送」前不要发出。"
    ],
    [
     "s3",
     "回报员",
     "把今天的订单和待处理事项整理成一则简短日报。"
    ]
   ],
   "groups": [
    [
     "每日门市流程",
     "订单员整理订单 → 客服员拟回复 → 回报员写日报。",
     [
      "s1",
      "s2",
      "s3"
     ]
    ]
   ]
  },
  "lodging": {
   "folder": "民宿",
   "notes": "住宿日期规则：昵称或订单的日期换成「住哪几晚」再分类（「10/21-23」＝住 10/21、10/22、10/23 三晚，10/24 退房）。第一晚是今天＝今日入住；昨天和今天都住＝今日续住（最后一晚是今天的人明天才退房）；最后一晚是昨天＝今天退房。应扫房＝昨晚有住、今晚没有同一组客人续住的房间。名单照馆别、房号由小到大排，每行「馆别 房号 姓名」；一人多房、同房多组、延期、取消另外列出来给我决定。",
   "bots": [
    [
     "l1",
     "订房员",
     "打开分区数据里写的订房平台后台，整理今天与明天的入住、退房：房号、客人、晚数。"
    ],
    [
     "l2",
     "房务员",
     "依订房员的数据，算出今天要打扫的房间，列成清单；分区数据有房务看板网址时就更新上去。"
    ],
    [
     "l3",
     "迎宾员",
     "依今天入住名单，用分区数据里的入住说明拟好每位客人的消息，列出来给我确认。我说「发送」前不要发出。"
    ]
   ],
   "groups": [
    [
     "每日入住流程",
     "订房员整理订房 → 房务员排打扫 → 迎宾员拟入住消息给我确认。",
     [
      "l1",
      "l2",
      "l3"
     ]
    ]
   ]
  },
  "remind": {
   "folder": "调度发讯",
   "notes": "提醒清单（一行一件）：时间｜要提醒的事｜发到哪里（不写就发在 OCTA 对话）。例：每天 09:00｜提醒我喝水｜OCTA。要发到 LINE、Telegram 等外部对象时写清楚对象，第一次发送前会先给你确认。",
   "bots": [
    [
     "m1",
     "提醒员",
     "依分区数据的提醒清单，在例行任务时间到时拟好要发的提醒或消息。发在 OCTA 对话的直接发；要发给别人（LINE、Email 等）时，第一次先列出来给我确认，我说「发送」前不要发出。我说要添加或更改提醒时间时，用例行任务排好，并更新提醒清单。"
    ]
   ],
   "groups": [],
   "routines": [
    [
     "m1",
     "每日提醒",
     [
      "09:00"
     ],
     "看分区数据的提醒清单，把今天这个时间要提醒的事整理成一则消息发给我；有要发给别人的，先列出来给我确认。"
    ]
   ]
  },
  "tidy": {
   "folder": "数据整理",
   "notes": "输出格式：CSV（或 Excel）。常用字段：姓名、电话、Email、日期。日期写成 2026-01-31，电话只留数字。",
   "bots": [
    [
     "d1",
     "整理员",
     "把我给的表格、名单或文件（附件、Google 试算表、网页）整理干净：去除重复、统一格式（日期、电话、姓名）、依分区数据或我说的字段排序，输出成文件放在输出文件夹。做完列出改了什么，以及有疑问、需要我决定的列。不要删掉看不懂的数据，另外列出来。"
    ]
   ],
   "groups": []
  },
  "watch": {
   "folder": "网站监看",
   "notes": "要监看的网址（一行一个，可加上要注意的内容）：\n例：https://example.com/news｜有新公告时通知我",
   "bots": [
    [
     "w1",
     "监看员",
     "我给你网址（或分区数据列出网址）时，替每个网址设好例行任务：在回复最后写「⏰例行任務：监看 网站名｜每10分鐘監看 网址｜网页有变化时要做的事」。网页有变化时，打开网页确认新内容，用几句话告诉我变了什么并附上网址；只是广告、时间或版面小变动就回「（略過）」。"
    ]
   ],
   "groups": []
  },
  "game": {
   "folder": "游戏自动化",
   "notes": "游戏网址：\n每次要做的步骤：1. 登录 2. 领每日奖励 3. …\n注意：遵守游戏规则，不要购买任何东西。",
   "bots": [
    [
     "g1",
     "游戏员",
     "依分区数据写的游戏网址和步骤，用浏览器打开游戏网页，做重复的操作（例如每日签到、领奖励、收成）。做完回报做了什么、拿到什么。遇到要付款、输入密码或验证码就停下来问我；不要购买任何东西，也不要更改帐号设置。"
    ]
   ],
   "groups": [],
   "routines": [
    [
     "g1",
     "每日游戏",
     [
      "09:00",
      "21:00"
     ],
     "照分区数据的步骤打开游戏网页，完成每日操作，做完回报。"
    ]
   ]
  }
 }
};

const CODE_ENGINES = ['ollama', 'opencode', 'claude', 'codex', 'gemini', 'grok', 'grokbot', 'copilot', 'cursor', 'qwen', 'fixture'];
const codeEngineOk = e => (CODE_ENGINES.includes(e) ? e : '');
const repoPathOk = p => {
  const v = String(p || '').trim();
  if (v.length < 2 || v.length > 500 || v.includes('\0') || v.split(/[\\/]/).includes('..')) return null;
  if (!v.startsWith('/') && !/^[a-zA-Z]:[\\/]/.test(v)) return null;
  return v;
};
const parseJson = (s, fallback = null) => { try { return s ? JSON.parse(s) : fallback; } catch { return fallback; } };
function publicCodeTask(row) {
  return {
    id: row.id, repoId: row.repo_id, title: row.title, prompt: row.prompt, criteria: row.criteria,
    engine: row.engine, model: row.model || '', fb: fbParse(row.fb), status: row.status, phase: row.phase, role: row.role || '',
    workspaceId: row.workspace_id || '', branch: row.branch || '', baseRef: row.base_ref || '', headRef: row.head_ref || '',
    retries: row.retries, maxRetries: row.max_retries, jobId: row.job_id, summary: parseJson(row.summary),
    approval: parseJson(row.approval), cancel: !!row.cancel, created: row.created, updated: row.updated, finished: row.finished,
    deployed: false, merged: false
  };
}

export async function onRequest(ctx) {
  const { request: req, env, params } = ctx;
  const path = (params.path || []).join('/');
  await ensureSchema(ctx.env.DB);
  if (!env.isLocal && !CLOUD_ONLY.test(path) && !/^(hook|coach)\//.test(path)) {   // 主機模式: the host computer answers
    const fw = await viaHost(req, env, path);
    if (fw) return fw;
  }
  const res = await route(ctx);
  if (req.method !== 'GET' && res.status < 300 && res._u && !NO_BUMP.test(path)) { try { await bump(env.DB, res._u); } catch { } }
  return res;
}

async function route({ request: req, env, params }) {
  const db = env.DB;
  const path = (params.path || []).join('/');
  const m = req.method;
  const url = new URL(req.url);
  const pathQuery = url.pathname.replace(/^\/api\/?/, '') + url.search;   // as forwarded to a host computer
  let body = {}, rawBody = '';
  if (m !== 'GET') { rawBody = await req.text().catch(() => ''); try { body = rawBody ? JSON.parse(rawBody) : {}; } catch { body = {}; } }

  try {
    // ---------- public ----------
    const meta = reqMeta(req);
    if (path === 'signup' && m === 'POST') {
      if (env.ALLOW_SIGNUP !== 'true') return err('目前不開放註冊', 403);
      const name = clean(body.name, 32), pw = String(body.pw || '');
      if (!/^[\w.\-一-鿿]{2,32}$/.test(name)) return err('帳號需 2–32 字，只能用中英文、數字、底線、點、減號');
      if (pw.length < 8) return err('密碼至少 8 碼');
      const lim = [['ipsign:' + meta.ip, 10]];
      const wait = await blocked(db, lim);
      if (wait) return err(`嘗試太多次，請 ${wait} 分鐘後再試`, 429);
      if (await db.prepare('SELECT 1 FROM users WHERE name=?').bind(name).first()) return err('這個帳號已被使用');
      await failed(db, lim);   // counts sign-ups per IP
      const id = uid();
      await db.prepare('INSERT INTO users (id,name,pw,created) VALUES (?,?,?,?)').bind(id, name, await hashPw(pw), now()).run();
      return J({ token: await newSession(db, id, 'web', null, meta) });
    }
    if (path === 'login' && m === 'POST') {
      const name = clean(body.name, 32);
      const lim = [['n:' + name.toLowerCase(), 5], ['ip:' + meta.ip, 30]];
      const wait = await blocked(db, lim);
      if (wait) return err(`密碼錯太多次，請 ${wait} 分鐘後再試，或用「忘記密碼」`, 429);
      const u = await db.prepare('SELECT id,pw FROM users WHERE name=?').bind(name).first();
      if (!u || !(await checkPw(String(body.pw || ''), u.pw))) { await failed(db, lim); return err('帳號或密碼錯誤', 401); }
      await cleared(db, lim.slice(0, 1));
      return J({ token: await newSession(db, u.id, 'web', null, meta) });
    }
    if (path === 'reset/send' && m === 'POST') {   // send a reset code to the account's Telegram / LINE
      const name = clean(body.name, 32), lim = [['rs:' + name.toLowerCase(), 3], ['ip:' + meta.ip, 30]];
      const wait = await blocked(db, lim);
      if (wait) return err(`請 ${wait} 分鐘後再試`, 429);
      await failed(db, lim);
      const u = await db.prepare('SELECT id FROM users WHERE name=?').bind(name).first();
      if (u) {
        const st = await getSettings(db, u.id);
        if ((st.tg?.token && st.tg?.chat) || (st.line?.token && st.line?.to)) {
          const code = await newResetCode(db, u.id);
          await sendNotify(env, st, `【OCTA】密碼重設碼：${code}\n15 分鐘內有效。不是你本人操作的話，請忽略這則訊息。`);
        }
      }
      return J({ ok: true });   // same answer either way, so account names can't be probed
    }
    if (path === 'reset' && m === 'POST') {
      const name = clean(body.name, 32), pw = String(body.pw || ''), code = clean(body.code, 20).toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (pw.length < 8) return err('新密碼至少 8 碼');
      const lim = [['rc:' + name.toLowerCase(), 5], ['ip:' + meta.ip, 30]];
      const wait = await blocked(db, lim);
      if (wait) return err(`嘗試太多次，請 ${wait} 分鐘後再試`, 429);
      const u = await db.prepare('SELECT id,reset FROM users WHERE name=?').bind(name).first();
      const r = u?.reset ? JSON.parse(u.reset) : null;
      if (!r || r.exp < now() || r.h !== await sha(code)) { await failed(db, lim); return err('重設碼錯誤或已過期', 401); }
      await db.batch([
        db.prepare('UPDATE users SET pw=?, reset=NULL WHERE id=?').bind(await hashPw(pw), u.id),
        db.prepare("DELETE FROM sessions WHERE user_id=? AND kind='web'").bind(u.id)
      ]);
      await cleared(db, [lim[0], ['n:' + name.toLowerCase()]]);   // a successful reset also unlocks sign-in
      return J({ token: await newSession(db, u.id, 'web', null, meta) });
    }
    if (path === 'config' && m === 'GET') return J({ signup: env.ALLOW_SIGNUP === 'true', local: !!env.isLocal, pair: !!env.pairCheck, download: env.DOWNLOAD_URL || '', repo: env.REPO_URL || '',
      host: typeof env.hostMode === 'function' ? env.hostMode() : null });   // desktop 主機模式: {name} of the cloud account whose data is here
    if (path === 'pair' && m === 'POST') {   // desktop offline mode: phone pairs with a code instead of an account
      if (!env.pairCheck) return err('這個版本不使用配對碼', 404);
      if (!env.pairCheck(String(body.code || ''))) return err('配對碼錯誤或已失效', 401);
      return J({ token: await newSession(db, 'local', 'web', 'phone', meta) });
    }
    if (path.startsWith('hook/')) {   // external event: LINE webhook, Zapier, a form…
      const key = path.slice(5);
      if (!/^[0-9a-f]{48}$/.test(key)) return err('找不到', 404);
      const r = await db.prepare('SELECT * FROM routines WHERE hook=?').bind(key).first();
      if (!env.isLocal) {   // 主機模式: the routine lives on the host computer
        const owner = r?.user_id || (await db.prepare('SELECT user_id FROM host_hooks WHERE k=?').bind(key).first())?.user_id;
        const h = owner ? await hostOf(db, owner) : null;
        if (h?.hmode === 1) {
          const extra = { 'content-type': req.headers.get('content-type') || 'application/json', 'x-octa-origin': url.origin };
          if (req.headers.get('x-line-signature')) extra['x-line-signature'] = req.headers.get('x-line-signature');
          const fr = await toHost(h, owner, m, pathQuery, rawBody, extra);
          if (fr) return fr;
        }
      }
      if (!r) return err('找不到', 404);
      if (m === 'GET') return J({ ok: true, routine: r.name });   // lets services check the address
      if (!r.enabled) return J({ ok: true, skipped: 'disabled' });
      const raw = rawBody || '';
      const what = describeEvent(raw, body);
      if (Array.isArray(body.events) && !body.events.length) return J({ ok: true });   // LINE "Verify" sends no events
      const lim = [['hook:' + key, 120]];
      if (await blocked(db, lim)) return J({ ok: false, error: 'too many events' }, 429);
      await failed(db, lim);   // counts events per 15 minutes
      return J({ ok: true, result: await fireEvent(env, db, r, what || '（沒有內容）') });
    }
    if (path.startsWith('coach/')) return coachApi(env, db, path, m, body, url, pathQuery, rawBody);
    if (path === 'cron') {   // called every few minutes (GitHub Actions); fires routines on time and tidies up
      // 主機模式 accounts are skipped: their host computer keeps the clock
      const users = (await db.prepare('SELECT DISTINCT r.user_id FROM routines r JOIN users u ON u.id=r.user_id WHERE r.enabled=1 AND IFNULL(u.hmode,0)<>1').all()).results;
      let fired = 0;
      for (const u of users) { try { fired += await fireRoutines(env, db, u.user_id, false); } catch { } }
      if (new Date().getUTCMinutes() < 5 || url.searchParams.has('clean')) await cleanup(db);
      return J({ ok: true, fired });
    }

    const me = env.isLocal ? { user_id: 'local', kind: 'local', name: (typeof env.hostMode === 'function' && env.hostMode()?.name) || '本機', label: 'local' } : await auth(req, db);
    if (!me) return err('請先登入', 401);
    const U = me.user_id;
    const ok = (data = { ok: true }) => { const r = J(data); r._u = U; return r; };   // a change other devices should see

    // ---------- 主機模式: this account's data on its host computer ----------
    if (path.startsWith('host/') && !env.isLocal && m === 'POST') {
      const u = await db.prepare('SELECT host, hmode, hurl, hkey, settings, engines FROM users WHERE id=?').bind(U).first();
      const isHostPc = me.kind === 'runner' && (me.label || 'runner') === (u?.host || '');
      if (path === 'host/deactivate') {   // back to the cloud: the host computer itself, or a signed-in device with the password
        if (!isHostPc) {
          if (me.kind !== 'web') return err('只有主機電腦可以使用', 403);
          const pw = await db.prepare('SELECT pw FROM users WHERE id=?').bind(U).first();
          const lim = [['n:' + me.name.toLowerCase(), 5]];
          if (await blocked(db, lim)) return err('密碼錯太多次，請稍後再試', 429);
          if (!(await checkPw(String(body.pw || ''), pw?.pw))) { await failed(db, lim); return err('密碼錯誤', 403); }
        }
        await db.prepare('UPDATE users SET hmode=0 WHERE id=?').bind(U).run();
        forgetUser(U); await bump(db, U);
        return J({ ok: true, hmode: 0 });
      }
      if (!isHostPc) return err('只有主機電腦可以使用', 403);
      if (path === 'host/register') {   // the host's tunnel address (sent when it changes and every 10 minutes)
        const addr = clean(body.url, 300).replace(/\/+$/, '');
        if (!/^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?$/i.test(addr) || /^https:\/\/(localhost|\d+\.\d+\.\d+\.\d+)/i.test(addr)) return err('主機網址不正確');
        const hkey = u.hkey || hex(crypto.getRandomValues(new Uint8Array(32)));
        const stmts = [db.prepare('UPDATE users SET hurl=?, hkey=?, hseen=? WHERE id=?').bind(addr, hkey, now(), U),
          db.prepare('UPDATE sessions SET seen=? WHERE token=?').bind(now(), me.token)];
        if (Array.isArray(body.hooks)) {   // external-event keys of the routines on the host (sent only when they change)
          stmts.push(db.prepare('DELETE FROM host_hooks WHERE user_id=?').bind(U));
          for (const k of [...new Set(body.hooks.map(String).filter(k => /^[0-9a-f]{48}$/.test(k)))].slice(0, 500))
            stmts.push(db.prepare('INSERT OR IGNORE INTO host_hooks (k,user_id) VALUES (?,?)').bind(k, U));
        }
        await db.batch(stmts);
        forgetUser(U);
        return J({ hkey, hmode: +u.hmode === 1 ? 1 : 0 });
      }
      if (path === 'host/export') {   // the account's data, one table page at a time, for moving it to the host
        const table = String(body.table || ''), after = Math.max(0, +body.after || 0);
        if (table === 'settings') return J({ table, rows: [{ name: me.name, settings: u.settings || null, engines: u.engines || null }], next: null, count: 1 });
        const lim = { files: 25, chunks: 2 }[table] || 500;
        const since = now() - 14 * DAY;   // jobs are kept 14 days
        let q, c;
        if (table === 'chunks') {   // uploads the host had not saved yet
          q = db.prepare('SELECT c.rowid AS _r, c.* FROM chunks c JOIN files f ON f.id=c.file_id WHERE f.user_id=? AND c.rowid>? ORDER BY c.rowid LIMIT ?').bind(U, after, lim);
          c = db.prepare('SELECT COUNT(*) AS n FROM chunks c JOIN files f ON f.id=c.file_id WHERE f.user_id=?').bind(U);
        } else if (HOST_TABLES.includes(table)) {
          const extra = table === 'jobs' ? ' AND created>?' : '';
          q = db.prepare(`SELECT rowid AS _r, * FROM ${table} WHERE user_id=? AND rowid>?${extra} ORDER BY rowid LIMIT ?`).bind(...(extra ? [U, after, since, lim] : [U, after, lim]));
          c = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id=?${extra}`).bind(...(extra ? [U, since] : [U]));
        } else return err('沒有這個資料表');
        const rows = (await q.all()).results;
        const count = after ? undefined : (await c.first())?.n || 0;
        const next = rows.length === lim ? rows[rows.length - 1]._r : null;
        return J({ table, rows: rows.map(({ _r, ...r }) => r), next, count });
      }
      if (path === 'host/activate') {
        if (!u.hurl || !u.hkey) return err('主機電腦還沒連上雲端，請稍候再試');
        await db.prepare('UPDATE users SET hmode=1 WHERE id=?').bind(U).run();
        forgetUser(U); await bump(db, U);
        return J({ ok: true, hmode: 1 });
      }
      return err('找不到這個 API', 404);
    }

    // ---------- files ----------
    if (path.startsWith('file/') && m === 'GET') {
      const id = path.slice(5);
      let f = await db.prepare('SELECT id,name,mime,data,loc,want,path,size,pc FROM files WHERE id=? AND user_id=?').bind(id, U).first();
      if (!f) return err('找不到檔案', 404);
      // where the file is: the desktop app on the host computer reads it from its own disk instead of through the cloud
      if (url.searchParams.has('meta')) return J({ name: f.name, mime: f.mime, loc: f.loc || (f.data ? 'db' : 'cloud'), path: f.loc === 'pc' ? f.path : null, size: f.size || null });
      if (f.data) return J({ name: f.name, mime: f.mime, data: f.data });   // older files kept in the database
      if (f.loc === 'pc' && f.want !== -1) {
        // the file is on the computer that made it (host or not): ask it for a temporary copy and wait
        const pcOf = f.pc || null;
        if (!f.want || now() - f.want > MIN) { await db.prepare('UPDATE files SET want=? WHERE id=?').bind(now(), id).run(); await bump(db, U); }
        const t0 = now();
        while (now() - t0 < 20000) {
          await sleep(1000);
          f = await db.prepare('SELECT want FROM files WHERE id=?').bind(id).first();
          if (f?.want === -1) break;
        }
        if (f?.want !== -1) {
          if (env.isLocal) return err('電腦還在讀取檔案，請稍後再試', 503);
          const h = await hostInfo(db, U), owner = pcOf, on = owner ? h.runners.find(r => (r.label || 'runner') === owner) : null;
          const who = (owner || h.hostLabel || '').replace(/^desktop:/, '');
          if (owner && owner !== h.hostLabel) return err(on && now() - (on.seen || 0) < HOST_ONLINE_MS ? `檔案在「${who}」電腦上，還在讀取，請稍後再試` : `這個檔案存在「${who}」電腦上，那台電腦目前離線。打開那台電腦的 OCTA 就能讀取`, 503);
          return err(h.online ? '電腦還在讀取檔案，請稍後再試' : '這個檔案存在主機電腦上，電腦目前離線', 503);
        }
        f = await db.prepare('SELECT name,mime FROM files WHERE id=?').bind(id).first();
      }
      return J({ name: f.name, mime: f.mime, data: await readChunks(db, id) });
    }
    if (path === 'files' && m === 'POST') {   // upload: kept in the cloud only until the host computer saves it
      const data = String(body.data || ''), name = clean(body.name, 120).replace(/[\\/:*?"<>|]/g, '_') || '檔案';
      if (!data) return err('檔案是空的');
      if (data.length > MAX_FILE * 1.37) return err('檔案太大（上限 10MB）');
      const conv = clean(body.conv, 64) || null;
      const id = 'file-' + uid();
      await storeChunks(db, id, data);
      await db.prepare("INSERT INTO files (id,user_id,name,mime,data,ts,conv,loc,size) VALUES (?,?,?,?,'',?,?,'cloud',?)").bind(id, U, name, mimeOf(name, body.mime), now(), conv, Math.round(data.length * 0.75)).run();
      return ok({ id, name, mime: mimeOf(name, body.mime) });
    }

    // ---------- runner (the computer that runs bots) ----------
    if (path.startsWith('runner/')) {
      if (me.kind !== 'runner' && me.kind !== 'local') return err('需要執行器金鑰', 403);
      const label = me.label || 'runner';
      // heartbeat and computer info, written only every few minutes or when something changed
      if (me.kind === 'runner' && (path === 'runner/next' || path === 'runner/hello')) {
        const info = { engines: body.engines && typeof body.engines === 'object' ? Object.fromEntries(ENGINES.map(k => [k, !!body.engines[k]])) : undefined, version: clean(body.version, 20) || undefined, app: clean(body.app, 20) || undefined, store: clean(body.store, 300) || undefined, usage: body.usage && typeof body.usage === 'object' && JSON.stringify(body.usage).length < 3000 ? body.usage : undefined,
          models: body.models && typeof body.models === 'object' && JSON.stringify(body.models).length < 6000 ? body.models : undefined,
          coding: body.coding && typeof body.coding === 'object' && JSON.stringify(body.coding).length < 4000 ? body.coding : undefined };
        const old = me.info ? JSON.parse(me.info) : {};
        const merged = { ...old, ...Object.fromEntries(Object.entries(info).filter(([, v]) => v !== undefined)) };
        if (now() - (me.seen || 0) > 4 * MIN || JSON.stringify(merged) !== JSON.stringify(old))
          await db.prepare('UPDATE sessions SET seen=?, info=? WHERE token=?').bind(now(), JSON.stringify(merged), me.token).run();
        if (info.engines && JSON.stringify(info.engines) !== JSON.stringify(old.engines || null)) await bump(db, U);   // an AI got installed or removed: open pages update
      }
      if (me.kind === 'local' && body.engines && typeof body.engines === 'object')
        await db.prepare('UPDATE users SET engines=? WHERE id=?').bind(JSON.stringify(Object.fromEntries(ENGINES.map(k => [k, !!body.engines[k]]))), U).run();
      if (me.kind === 'local' && ((body.usage && typeof body.usage === 'object') || (body.models && typeof body.models === 'object') || (body.coding && typeof body.coding === 'object'))) { const st = await getSettings(db, U); if (body.usage) st._usage = body.usage; if (body.models) st._models = body.models; if (body.coding && JSON.stringify(body.coding).length < 4000) st._coding = body.coding; await putSettings(db, U, st); }
      if (path === 'runner/hello') return J({ user: U, name: me.name, label });
      if (path === 'runner/bye' && m === 'POST') { if (me.kind === 'runner') await db.prepare('UPDATE sessions SET seen=0 WHERE token=?').bind(me.token).run(); return J({ ok: true }); }

      // only the host computer works; others wait on standby
      let isHost = me.kind === 'local';
      if (!isHost) {
        const u = await db.prepare('SELECT host FROM users WHERE id=?').bind(U).first();
        const hostExists = u?.host && await db.prepare("SELECT 1 FROM sessions WHERE user_id=? AND kind='runner' AND IFNULL(label,'runner')=?").bind(U, u.host).first();
        if (!hostExists) { await db.prepare('UPDATE users SET host=? WHERE id=?').bind(label, U).run(); await bump(db, U); isHost = true; }   // first computer becomes the host
        else isHost = u.host === label;
      }
      // a computer on standby still sends files that live on it, and does jobs addressed to it (handing logins over)
      if (!isHost && path === 'runner/next' && m === 'POST') {
        const t0 = now(); let rev = null;
        for (; ;) {
          const u2 = await db.prepare('SELECT rev, host FROM users WHERE id=?').bind(U).first(), r = u2?.rev ?? 0;
          if (u2?.host === label) return J({ job: null });   // this computer just became the host: ask again as the host
          if (r !== rev) { rev = r; const w = await pcWork(env, db, U, label, body.slots === undefined ? 1 : +body.slots); if (w) return J({ ...w, standby: true }); }
          if (!body.wait || now() - t0 > WAIT_MS) return J({ job: null, standby: true });
          await sleep(1000);
        }
      }
      if (!isHost && !['runner/done', 'runner/blob', 'runner/xfer', 'runner/progress'].includes(path)) {
        if (body.wait) await sleep(WAIT_MS);
        return J({ job: null, standby: true });
      }

      if (path === 'runner/next' && m === 'POST') {
        let changed = await fireRoutines(env, db, U, true);
        // stale running jobs become errors
        const stale = (await db.prepare("SELECT id,conv,bot_id FROM jobs WHERE user_id=? AND status='running' AND ((kind='chat' AND started<?) OR started<?)").bind(U, now() - 20 * MIN, now() - 3 * 3600000).all()).results;
        for (const s of stale) {
          await db.prepare("UPDATE jobs SET status='error', err_kind='timeout', err_msg=? WHERE id=?").bind('執行超過 20 分鐘沒有回報，已中止', s.id).run();
          await addMsg(db, U, s.conv, s.bot_id, '⚠ 執行逾時，已中止。');
          changed++;
        }
        try { changed += await weeklyReview(env, db, U); } catch { }
        try { await approvalNag(env, db, U); } catch { }
        if (changed) await bump(db, U);
        const slots = body.slots === undefined ? 1 : +body.slots;
        const t0 = now();
        let rev = null;
        for (; ;) {
          const u2 = await db.prepare('SELECT rev, host FROM users WHERE id=?').bind(U).first(), r = u2?.rev ?? 0;
          if (r !== rev) {   // something changed since the last look
            rev = r;
            if (me.kind === 'runner' && u2.host !== label) return J({ job: null, standby: true });   // another computer just became the host
            const out = await nextWork(env, db, U, slots, me.kind === 'runner' ? label : null);
            if (out) return J(out);
          }
          if (!body.wait || now() - t0 > WAIT_MS) return J({ job: null });
          await sleep(1500);
        }
      }
      if (path === 'runner/watches' && m === 'POST') {   // pages the host should check for changes
        const rows = (await db.prepare("SELECT r.id,r.conv,r.watch,g.members FROM routines r LEFT JOIN groups_ g ON g.id=r.conv WHERE r.user_id=? AND r.enabled=1 AND r.watch IS NOT NULL").bind(U).all()).results;
        return J({ watches: rows.map(r => { const w = JSON.parse(r.watch); return { id: r.id, bot: r.members ? JSON.parse(r.members)[0] : r.conv, ...w }; }) });
      }
      if (path === 'runner/watched' && m === 'POST') {   // a checked page: start the routine when it changed
        const r = await db.prepare('SELECT * FROM routines WHERE id=? AND user_id=?').bind(clean(body.id, 64), U).first();
        if (!r || !r.watch) return J({ ok: true });
        const text = clean(body.text, 8000), hash = clean(body.hash, 80);
        const old = r.wstate ? JSON.parse(r.wstate) : null;
        await db.prepare('UPDATE routines SET wstate=? WHERE id=?').bind(JSON.stringify({ hash, text, t: now() }), r.id).run();
        if (!old || old.hash === hash || !hash) return J({ ok: true, changed: false });   // first look only remembers the page
        const before = new Set(String(old.text || '').split('\n').map(x => x.trim()).filter(Boolean));
        const added = text.split('\n').map(x => x.trim()).filter(x => x && !before.has(x)).slice(0, 40).join('\n');
        const w = JSON.parse(r.watch);
        const res = await fireEvent(env, db, r, `監看的網頁有變化：${w.url}\n新出現的內容：\n${added || '（版面有變動，請打開網頁確認）'}`);
        return J({ ok: true, changed: true, result: res });
      }
      if (path === 'runner/progress' && m === 'POST') {   // what the bot is doing now; also tells the computer if 停止 was pressed
        const txt = clean(body.text, 120);
        const jr = await db.prepare("SELECT progress FROM jobs WHERE id=? AND user_id=? AND status='running'").bind(+body.id, U).first();
        if (!jr) return J({ stop: true });
        if (jr.progress !== txt) {   // a heartbeat with the same text changes nothing for the screens
          await db.batch([db.prepare('UPDATE jobs SET progress=? WHERE id=?').bind(txt, +body.id), db.prepare('UPDATE users SET prog=prog+1 WHERE id=?').bind(U)]);
        }
        const jobRow = await db.prepare('SELECT bot_id FROM jobs WHERE id=? AND user_id=?').bind(+body.id, U).first();
        const handed = jobRow && await db.prepare('SELECT handed FROM live WHERE bot_id=? AND user_id=?').bind(jobRow.bot_id, U).first();
        return J({ ok: true, hand: !!handed?.handed });
      }
      if (path === 'runner/live' && m === 'POST') {
        const bot = clean(body.bot, 64);
        const owns = await db.prepare('SELECT id FROM bots WHERE id=? AND user_id=?').bind(bot, U).first();
        if (!owns) return err('找不到', 404);
        const watching = r => !!r && +r.watch > now() - 15000;   // a screen opened this bot's browser in the last 15 s
        if (body.peek) {
          const row = await db.prepare('SELECT handed, watch FROM live WHERE bot_id=? AND user_id=?').bind(bot, U).first();
          return J({ hand: !!row?.handed, watch: watching(row) });
        }
        const data = String(body.data || '');
        if (data.length > 500000) return J({ ok: true, skipped: true });
        const url = clean(body.url, 300), title = clean(body.title, 80);
        const cur = await db.prepare('SELECT handed, watch FROM live WHERE bot_id=? AND user_id=?').bind(bot, U).first();
        if (cur) await db.prepare('UPDATE live SET url=?, title=?, mime=?, data=?, ts=? WHERE bot_id=? AND user_id=?').bind(url, title, 'image/jpeg', data, now(), bot, U).run();
        else await db.prepare('INSERT INTO live (bot_id,user_id,url,title,mime,data,ts,handed) VALUES (?,?,?,?,?,?,?,0)').bind(bot, U, url, title, 'image/jpeg', data, now()).run();
        return J({ ok: true, hand: !!cur?.handed, watch: watching(cur) });
      }
      if (path === 'runner/stored' && m === 'POST') {   // the host saved an uploaded file into its OCTA folder
        const p = safePath(body.path);
        if (!p) return err('路徑不正確');
        await db.batch([
          db.prepare("UPDATE files SET loc='pc', path=?, size=COALESCE(?,size), want=NULL, pc=? WHERE id=? AND user_id=?").bind(p, +body.size || null, me.kind === 'runner' ? label : null, clean(body.id, 64), U),
          db.prepare('DELETE FROM chunks WHERE file_id=?').bind(clean(body.id, 64))
        ]);
        return J({ ok: true });
      }
      if (path === 'runner/xfer' && m === 'POST') {   // the old computer's logins, kept here only until the host takes them
        const job = await db.prepare("SELECT * FROM jobs WHERE id=? AND user_id=? AND kind='export' AND status='running'").bind(+body.id, U).first();
        if (!job) return err('找不到任務', 404);
        const n = Math.max(0, Math.floor(+body.n || 0)), data = String(body.data || '');
        if (data.length > CHUNK + 10 || n > 20) return err('資料太大');
        await db.prepare('INSERT OR REPLACE INTO chunks (file_id,n,data,ts) VALUES (?,?,?,?)').bind('xfer-' + job.id, n, data, now()).run();
        if (body.last) {
          await db.prepare("UPDATE jobs SET status='done', finished=? WHERE id=?").bind(now(), job.id).run();
          await db.prepare("INSERT INTO jobs (user_id,conv,bot_id,chain,prompt,created,kind,url,pc) VALUES (?,?,?,'[]','',?,'import',?,?)").bind(U, job.conv, job.bot_id, now(), 'xfer-' + job.id, job.url).run();
          await bump(db, U);
        }
        return J({ ok: true });
      }
      if (path.startsWith('runner/xfer/') && m === 'GET') {
        const id = path.slice('runner/xfer/'.length);
        const job = await db.prepare("SELECT 1 FROM jobs WHERE user_id=? AND kind='import' AND url=? AND status='running'").bind(U, id).first();
        if (!job) return err('找不到資料', 404);
        return J({ data: await readChunks(db, id) });
      }
      if (path === 'runner/blob' && m === 'POST') {   // temporary copy of a file someone wants to see
        const id = clean(body.id, 64);
        const f = await db.prepare('SELECT 1 FROM files WHERE id=? AND user_id=?').bind(id, U).first();
        if (!f) return err('找不到檔案', 404);
        if (body.missing) { await db.prepare('UPDATE files SET want=NULL WHERE id=?').bind(id).run(); return J({ ok: true }); }
        const n = Math.max(0, Math.floor(+body.n || 0)), data = String(body.data || '');
        if (data.length > CHUNK + 10) return err('片段太大');
        await db.prepare('INSERT OR REPLACE INTO chunks (file_id,n,data,ts) VALUES (?,?,?,?)').bind(id, n, data, now()).run();
        if (body.last) await db.prepare('UPDATE files SET want=-1 WHERE id=?').bind(id).run();
        return J({ ok: true });
      }
      if (path === 'runner/connector' && m === 'POST') {
        const job = await db.prepare('SELECT id,prompt FROM jobs WHERE id=? AND user_id=?').bind(+body.job, U).first();
        if (!job) return err('找不到這次工作', 404);
        const st = await getSettings(db, U);
        const task = { name: clean(body.name, 40), action: clean(body.action, 10), path: clean(body.path, 200), content: clean(body.content, 4000) };
        return J(await runConnector(st, task, { approved: /核准[:：]/.test(job.prompt || '') }));
      }
      if (path === 'runner/done' && m === 'POST') {
        const job = await db.prepare("SELECT * FROM jobs WHERE id=? AND user_id=? AND status='running'").bind(+body.id, U).first();
        if (!job) return err('找不到執行中的任務', 404);
        let good = body.ok !== false;
        let fail = null;   // { kind, msg, ai }: why a chat job finally failed (工作紀錄, notification)
        // Classify the failure before choosing a backup. Quota, HTTP 429, auth, and
        // transient outages are not the same action, and a code or tool failure does not switch models.
        // A model that exits 0 and only says the quota is gone is the same failure: call the backup,
        // and do not show that sentence as the answer.
        if (job.kind === 'chat') {
          const b = (await loadAll(db, U)).bots.find(x => x.id === job.bot_id);
          const refused = good && !body.stopped && replyIsProviderRefusal(body.text, { files: Array.isArray(body.files) ? body.files.length : 0 });
          if (b && (!good || refused)) {
            if (refused) good = false;
            const st = await getSettings(db, U);
            st.spent = Object.fromEntries(Object.entries(st.spent || {}).filter(([, t]) => t > now()));
            const chain = [b.engine + (b.model ? '|' + b.model : ''), ...(b.fb || [])];
            const current = job.eng || chain[0];
            const index = chainIndex(chain, current);
            const raw = String(body.text || '');
            const kind = refused || classifyModelFailure(raw, { stopped: !!body.stopped });
            const decision = decideRoute({
              kind, tries: +job.tries || 0, index,
              resetsAt: /resets? in|小時|分鐘/i.test(raw) ? resetAt(raw) : 0,
              now: now(),
              chain: chain.map(id => ({ id, spentUntil: st.spent[id] || 0 }))
            });
            const lab = x => { const [e, mm] = String(x || '').split('|'); return (ENGINE_NAMES[e] || e) + (mm ? `（${mm}）` : ''); };
            const why = decision.reason === 'quota' ? '額度用完' : decision.reason === 'rate_limit' ? '被限流' : decision.reason === 'unavailable' ? '這台電腦還沒安裝' : '暫時故障';
            if (decision.action === 'retry' || decision.action === 'switch') {
              if (decision.spend) st.spent[chain[index]] = resetAt(raw);
              await putSettings(db, U, st);
              const nextEng = decision.action === 'switch' ? chain[decision.index] : current;
              const nextTries = decision.action === 'retry' ? (+job.tries || 0) + 1 : 0;
              const fk = classifyJobFailure(raw, { hint: body.err_kind, stalled: !!body.stalled });
              const once = await db.prepare("UPDATE jobs SET status='error', finished=?, result=?, err_kind=?, err_msg=? WHERE id=? AND status='running'").bind(now(), clean(raw, 500), fk, clean(raw.replace(/^⚠\s*/, ''), 500), job.id).run();
              if (!once.meta.changes) return ok();   // the same result was reported twice
              // the second try on the same model carries the reason and asks for another way
              const nextPrompt = decision.action === 'retry' ? retryPrompt(job.prompt, nextTries, fk, raw) : stripRetryNote(job.prompt);
              await db.prepare('INSERT INTO jobs (user_id,conv,bot_id,chain,prompt,created,depth,eng,tries,retry_of,via) VALUES (?,?,?,?,?,?,?,?,?,?,?)').bind(U, job.conv, job.bot_id, job.chain, nextPrompt, now(), job.depth || 0, nextEng, nextTries, job.id, job.via || null).run();
              const note = decision.action === 'switch'
                ? `「${b.name}」的 ${lab(chain[index])} ${why}，改由 ${lab(nextEng)} 接手。已完成的對話會保留，不會重做已完成的步驟。`
                : `「${b.name}」的 ${lab(current)} ${decision.reason === 'rate_limit' ? '被限流，同一個模型再試一次' : '暫時故障，同一個模型再試一次'}（第 ${nextTries} 次）。`;
              await addMsg(db, U, job.conv, 'sys', note);
              await bump(db, U);
              return ok();
            }
            if (decision.message) body.text = (decision.reason === 'cancelled' ? '' : '⚠ ') + decision.message;
            if (decision.reason !== 'cancelled') {
              fail = { kind: classifyJobFailure(raw, { hint: body.err_kind, stalled: !!body.stalled }), msg: clean(raw.replace(/^⚠\s*/, ''), 500), ai: decision.reason === 'auth' };
              // timeouts, changed pages, tool errors and unknown errors: the same job again (at most twice),
              // the second time with the reason attached. Quota went to the backup AI above; a sign-in is never retried.
              const n = (+job.tries || 0) + 1;
              if (['execution', 'tool'].includes(decision.reason) && autoRetryable(fail.kind, raw) && n <= MAX_AUTO_RETRY) {
                const once = await db.prepare("UPDATE jobs SET status='error', finished=?, result=?, err_kind=?, err_msg=? WHERE id=? AND status='running'").bind(now(), clean(raw, 500), fail.kind, fail.msg, job.id).run();
                if (!once.meta.changes) return ok();   // the same result was reported twice
                await db.prepare('INSERT INTO jobs (user_id,conv,bot_id,chain,prompt,created,depth,eng,tries,retry_of,via) VALUES (?,?,?,?,?,?,?,?,?,?,?)').bind(U, job.conv, job.bot_id, job.chain, retryPrompt(job.prompt, n, fail.kind, raw), now(), job.depth || 0, job.eng || null, n, job.id, job.via || null).run();
                await addMsg(db, U, job.conv, 'sys', `「${b.name}」這次沒做成（${FAIL_KINDS[fail.kind].label}），自動重試第 ${n} 次${n >= MAX_AUTO_RETRY ? '，這次會換一種方法' : ''}…`);
                await bump(db, U);
                return ok();
              }
            }
          }
        }
        if (job.kind === 'export' || job.kind === 'import') {   // handing a bot's website logins to another computer
          await db.prepare('UPDATE jobs SET status=?, finished=?, result=? WHERE id=?').bind(good ? 'done' : 'error', now(), clean(body.text, 3000), job.id).run();
          if (job.kind === 'import' || !good) {
            await db.prepare('DELETE FROM chunks WHERE file_id=?').bind(job.kind === 'import' ? job.url : 'xfer-' + job.id).run();
            if (good) await db.prepare('UPDATE bots SET bpc=? WHERE id=? AND user_id=?').bind(job.pc || null, job.bot_id, U).run();
            await addMsg(db, U, job.conv, 'sys', clean(body.text, 500) || (good ? '已帶入網站登入' : '⚠ 帶入網站登入失敗'));
            await bump(db, U);
          }
          return ok();
        }
        if (job.kind === 'test' || job.kind === 'list' || job.kind === 'install') {
          await db.prepare('UPDATE jobs SET status=?, finished=?, result=? WHERE id=?').bind(good ? 'done' : 'error', now(), clean(body.text, 3000), job.id).run();
          return ok();
        }
        if (job.kind === 'code') {
          await db.prepare('UPDATE jobs SET status=?, finished=?, result=? WHERE id=?').bind(good ? 'done' : 'error', now(), clean(body.text, 3000), job.id).run();
          return ok();
        }
        if (job.kind === 'open') {   // the phone asked the computer to open a page: keep the address, don't drop a chat bubble
          await db.prepare('UPDATE jobs SET status=?, finished=?, result=? WHERE id=?').bind(good ? 'done' : 'error', now(), clean(body.text, 500), job.id).run();
          if (body.page) await db.prepare('UPDATE bots SET page=? WHERE id=? AND user_id=?').bind(clean(body.page, 500), job.bot_id, U).run();
          if (!good) await addMsg(db, U, job.conv, 'sys', clean(body.text, 500) || '⚠ 無法打開瀏覽器');
          return ok();
        }
        let text = clean(body.text, 20000) || (good ? '（完成，無回覆內容）' : '⚠ 執行失敗');
        if (fail) {   // the final failure says why in plain words; a website sign-in shows the login card (接手／繼續)
          const fk = FAIL_KINDS[fail.kind] || FAIL_KINDS.unknown;
          if (fail.kind === 'not_logged_in' && !fail.ai && !LOGIN_WAIT.test(text)) text = '⚠ 需要使用者在電腦上登入。' + text.replace(/^⚠\s*/, '');
          if (!/^⚠/.test(text)) text = '⚠ ' + text;
          text += `\n原因：${fk.label}。${fail.ai ? '' : fk.next}`;
        }
        if (good && job.kind === 'chat' && text.includes('【回覆】')) text = text.slice(text.lastIndexOf('【回覆】') + 4).trim() || '（完成）';   // drop the running commentary before the reply
        if (good && job.kind === 'chat') text = calmReply(text) || '（完成）';
        // 📛名稱：🎮 遊戲員 — a new bot names itself after it learns its job
        if (good && job.kind === 'chat' && /📛/.test(text)) {
          let nm = null;
          text = text.replace(/^\s*📛\s*名稱[:：]\s*(.+)$/gm, (_, v) => { nm = nm || v; return ''; }).trim() || '（好的）';
          const self = await db.prepare('SELECT name, avatar FROM bots WHERE id=? AND user_id=?').bind(job.bot_id, U).first();
          if (nm && self && /^新機器人\d*$/.test(self.name)) {
            const mm = nm.trim().match(/^(\p{Extended_Pictographic}[\uFE0F\u200D\p{Extended_Pictographic}]*)?\s*(.+)$/u);
            let name = clean(noSpaces(clean((mm?.[2] || '').replace(/[「」"']/g, ''), 20)), 20);
            if (name) {
              const taken = await db.prepare('SELECT 1 FROM bots WHERE user_id=? AND name=? AND id<>?').bind(U, name, job.bot_id).first();
              if (taken) name = clean(name + '2', 20);
              await db.prepare('UPDATE bots SET name=?, avatar=? WHERE id=? AND user_id=?').bind(name, mm?.[1] ? avatarOk(mm[1]) : self.avatar, job.bot_id, U).run();
              await addMsg(db, U, job.conv, 'sys', `它幫自己取名叫「${name}」，可在任務設定修改`);
            }
          }
        }
        // 📝任務更新：… 📝結束 — the bot learned what its standing job is; save it as its 指定任務
        let learned = null;
        const tm = good && job.kind === 'chat' ? text.match(/📝\s*任務更新[:：]\s*([\s\S]*?)(?:📝\s*結束|$)/) : null;
        if (tm) {
          learned = clean(tm[1], 4000);
          text = clean(text.replace(tm[0], ''), 20000) || '（已更新指定任務）';
        }
        // 📌記住：… — a lasting fact or preference the bot should keep (its memory)
        const remember = [], sitesNew = [];
        // 🧩技能：名稱 … 🧩結束 — a workflow saved to rerun later (shown in the / menu)
        const skillsNew = [], factsNew = [], manualsNew = [];
        if (good && job.kind === 'chat') {
          text = text.replace(/^\s*📌\s*記住[:：]\s*(.+)$/gm, (_, t) => { const v = clean(t, 300); if (v) remember.push(v); return ''; });
          // 🗺️網站筆記：網域｜做法 — how to get around a website, shared with every bot
          text = text.replace(/^\s*🗺️?\s*網站筆記[:：]\s*([^｜|\n]+)\s*[｜|]\s*(.+)$/gm, (_, d, t) => { const dom = clean(d, 60).toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''), v = clean(t, 300); if (dom && v) sitesNew.push([dom, v]); return ''; });
          text = text.replace(/🧩\s*技能[:：]\s*([^\n]+)\n([\s\S]*?)🧩\s*結束/g, (_, n, st2) => { const name = clean(n, 40), steps = clean(st2, 3000); if (name && steps) skillsNew.push({ name, steps }); return ''; });
          // 📇事實：… — a fixed piece of data (list, address, account name); 📘手冊：名稱｜步驟 — how a multi-step job was done
          text = text.replace(/^\s*📇\s*事實[:：]\s*(.+)$/gm, (_, t) => { const v = clean(t, 300); if (v) factsNew.push(v); return ''; });
          const pm = parseManuals(text); text = pm.text; manualsNew.push(...pm.manuals);
          if (job.prompt.startsWith(REVIEW_TAG)) { remember.length = 0; factsNew.length = 0; manualsNew.length = 0; }   // the weekly review only suggests; rules change when the user approves
          text = text.trim() || '（已記下）';
        }
        // ⏰例行任務：名稱｜08:00,13:30｜要做的事 — the bot sets up a daily routine the user asked for
        const plans = [];
        // ⏰刪除／停用／啟用：名稱、名稱 — the bot manages its own routines instead of asking the user to do it by hand
        const routineOps = [];
        if (good && job.kind === 'chat' && /⏰\s*(刪除|停用|啟用)/.test(text)) {
          text = text.replace(/^\s*⏰\s*(刪除|停用|啟用)(?:例行任務)?[:：]\s*(.+)$/gm, (_, op, list) => {
            for (const n of String(list).split(/[、，,；;]+/).map(x => clean(x.replace(/^[「『"]|[」』"]$/g, ''), 40)).filter(Boolean)) routineOps.push([op, n]);
            return '';
          }).trim() || '（好的）';
        }
        if (good && job.kind === 'chat') {
          text = text.replace(/^\s*⏰\s*例行任務[:：]\s*(.+?)\s*[｜|]\s*(.+?)\s*[｜|]\s*(.+)$/gm, (_, n, t, p) => {
            const wm = String(t).match(/監看\s*(https?:\/\/\S+)/), every = (String(t).match(/每\s*(\d+)\s*分/) || [])[1];
            if (wm) { plans.push({ name: clean(n, 40), times: [], prompt: clean(p, 2000), trigger: 'watch', watch: { url: wm[1], every: +every || 10 } }); return ''; }
            if (/外部事件|webhook/i.test(t)) { plans.push({ name: clean(n, 40), times: [], prompt: clean(p, 2000), trigger: 'hook' }); return ''; }
            const times = cleanTimes(String(t).replace(/每\s*(\d+)\s*分(鐘)?/g, '*/$1').replace(/每\s*(\d+)\s*小時/g, (_, h) => '*/' + h * 60).split(/[,，、\s]+/).map(x => { if (/^\*\/\d+$/.test(x)) return x; const mm = x.match(/^(\d{1,2})[:：](\d{2})$/); return mm ? mm[1].padStart(2, '0') + ':' + mm[2] : ''; }));
            if (clean(n, 40) && times.length) plans.push({ name: clean(n, 40), times, prompt: clean(p, 2000) });
            return '';
          }).trim() || '（已設定例行任務）';
          applySchedules(plans, job.prompt, text);
        }
        const claimedBuilt = good && job.kind === 'chat' && /排程已建好|例行任務已建好|已建立例行任務|已建好例行/.test(text);
        const tk = Number.isFinite(+body.tokens) && body.tokens !== null ? Math.max(0, Math.round(+body.tokens)) : null;
        // only once: a runner that retries runner/done must not post the reply (and start the next step) twice
        const fin = await db.prepare("UPDATE jobs SET status=?, finished=?, tokens=?, result=COALESCE(?, result) WHERE id=? AND status='running'").bind(good ? 'done' : 'error', now(), tk, job.via || BG.test(job.prompt) ? text.slice(0, 1500) : null, job.id).run();
        if (!fin.meta.changes) return ok();
        if (job.kind === 'chat' && !body.stopped) await statAdd(db, env, U, job, good, tk, !!body.browser);
        // where its website logins live: the first computer its browser ran on, until they're moved
        if (me.kind === 'runner' && body.browser) await db.prepare('UPDATE bots SET bpc=? WHERE id=? AND user_id=? AND bpc IS NULL').bind(label, job.bot_id, U).run();
        if (body.nskills && typeof body.nskills === 'object' && JSON.stringify(body.nskills).length < 300000) {   // the bot's own Claude Code skills, kept with the account
          const st = await getSettings(db, U); st.nskills = st.nskills || {}; st.nskills[job.bot_id] = { h: clean(body.nskills.h, 64), files: body.nskills.files || {} }; await putSettings(db, U, st);
        }
        // files the bot made in its 輸出 folder become attachments of the reply
        const outs = [];
        for (const f of (Array.isArray(body.files) ? body.files : []).slice(0, 8)) {
          const p = safePath(f.path), name = clean(f.name, 120);
          if (!p || !name) continue;
          const id = 'file-' + uid(), mime = mimeOf(name, f.mime);
          await db.prepare("INSERT INTO files (id,user_id,name,mime,data,ts,conv,loc,path,size,pc) VALUES (?,?,?,?,'',?,?,'pc',?,?,?)").bind(id, U, name, mime, now(), job.conv, p, +f.size || null, me.kind === 'runner' ? label : null).run();
          outs.push({ id, name, mime });
        }
        const isGroup = (await loadAll(db, U)).groups.some(g => g.id === job.conv);
        const quiet = isGroup || job.prompt.startsWith('（例行任務') || BG.test(job.prompt) || /^同事「[^」]*」回覆了你在背景問/.test(job.prompt);   // where "（略過）" means nothing to show
        let shown = text;
        if (isGroup && job.kind === 'chat') {
          const all2 = await loadAll(db, U), g2 = all2.groups.find(g => g.id === job.conv), mates = all2.bots.filter(b => g2?.members.includes(b.id) && b.id !== job.bot_id);
          shown = text.split('\n').filter(l => { const ml = mentionLine(l, mates); return !(ml && privateAsk(ml.rest, job.prompt)); }).join('\n').trim();
        }
        if (shown && !(quiet && passed(shown) && !outs.length)) await addMsg(db, U, job.conv, job.bot_id, shown, outs);
        if (remember.length || skillsNew.length || sitesNew.length || factsNew.length || manualsNew.length) {
          const st = await getSettings(db, U);
          if (factsNew.length) { st.facts = st.facts || {}; st.facts[job.bot_id] = [...new Set([...(st.facts[job.bot_id] || []), ...factsNew])].slice(-60); }
          if (manualsNew.length) { st.manuals = st.manuals || {}; st.manuals[job.bot_id] = saveManuals(st.manuals[job.bot_id], manualsNew); }
          if (sitesNew.length) { st.sites = st.sites || {}; for (const [d, v] of sitesNew) st.sites[d] = [...new Set([...(st.sites[d] || []), v])].slice(-12); }
          if (remember.length) { st.memory = st.memory || {}; st.memory[job.bot_id] = [...new Set([...(st.memory[job.bot_id] || []), ...remember])].slice(-40); }
          if (skillsNew.length) { st.skills = st.skills || {}; const cur = (st.skills[job.bot_id] || []).filter(x => !skillsNew.some(n => n.name === x.name)); st.skills[job.bot_id] = [...cur, ...skillsNew].slice(-20); }
          await putSettings(db, U, st);
          if (remember.length) await addMsg(db, U, job.conv, 'sys', `已記住：${remember.join('；').slice(0, 200)}`);
          for (const k of skillsNew) await addMsg(db, U, job.conv, 'sys', `已存成技能「${k.name}」，輸入 / 就能叫它`);
          if (factsNew.length) await addMsg(db, U, job.conv, 'sys', `已記下事實：${factsNew.join('；').slice(0, 200)}`);
          for (const k of manualsNew) await addMsg(db, U, job.conv, 'sys', `已存成做事手冊「${k.name}」，下次做類似的事會照著做（任務設定可檢視、刪除）`);
        }
        for (const r of plans.filter(x => x.trigger).slice(0, 3)) {   // event-triggered routines the bot set up
          const old = await db.prepare('SELECT * FROM routines WHERE user_id=? AND conv=? AND name=?').bind(U, job.conv, r.name).first();
          let trig; try { trig = triggerFrom(r, old); } catch { continue; }
          if (old) await db.prepare('UPDATE routines SET prompt=?,enabled=1,hook=?,watch=?,wstate=NULL WHERE id=?').bind(r.prompt, trig.hook, trig.watch, old.id).run();
          else await db.prepare("INSERT INTO routines (id,user_id,conv,name,prompt,times,enabled,fired,created,hook,watch) VALUES (?,?,?,?,?,'[]',1,'{}',?,?,?)").bind('r-' + uid(), U, job.conv, r.name, r.prompt, now(), trig.hook, trig.watch).run();
          await addMsg(db, U, job.conv, 'sys', r.trigger === 'watch' ? `已設定例行任務「${r.name}」：網頁 ${r.watch.url} 有變化時開始（每 ${r.watch.every || 10} 分鐘檢查）` : `已設定例行任務「${r.name}」：外部事件觸發。觸發網址在任務設定 → 例行任務裡`);
        }
        for (const r of plans.filter(x => !x.trigger).slice(0, 12)) {
          const { date, hm } = localNow(env);
          const fired = JSON.stringify(Object.fromEntries(r.times.filter(t => !isEvery(t) && t <= hm).map(t => [t, date])));   // times already past today start tomorrow
          const old = await db.prepare('SELECT id FROM routines WHERE user_id=? AND conv=? AND name=?').bind(U, job.conv, r.name).first();
          if (old) await db.prepare('UPDATE routines SET times=?,prompt=?,enabled=1,fired=? WHERE id=?').bind(JSON.stringify(r.times), r.prompt, fired, old.id).run();
          else await db.prepare('INSERT INTO routines (id,user_id,conv,name,prompt,times,enabled,fired,created) VALUES (?,?,?,?,?,?,1,?,?)').bind('r-' + uid(), U, job.conv, r.name, r.prompt, JSON.stringify(r.times), fired, now()).run();
          await addMsg(db, U, job.conv, 'sys', `已${old ? '更新' : '新增'}例行任務「${r.name}」：${r.times.map(t => isEvery(t) ? `每 ${t.slice(2)} 分鐘` : '每天 ' + t).join('、')}`);
        }
        if (routineOps.length) {
          const mine = (await db.prepare('SELECT id,name,enabled FROM routines WHERE user_id=? AND conv IN (?,?)').bind(U, job.conv, job.bot_id).all()).results;
          const done = [], miss = [];
          for (const [op, n] of routineOps.slice(0, 30)) {
            const hits = mine.filter(r => r.name === n);
            const hit = hits.length ? hits : mine.filter(r => r.name.includes(n) || n.includes(r.name));
            if (!hit.length || (hits.length === 0 && hit.length > 1)) { miss.push(n); continue; }
            for (const r of hit) {
              if (op === '刪除') await db.prepare('DELETE FROM routines WHERE id=? AND user_id=?').bind(r.id, U).run();
              else await db.prepare('UPDATE routines SET enabled=? WHERE id=? AND user_id=?').bind(op === '啟用' ? 1 : 0, r.id, U).run();
              done.push(`${op}「${r.name}」`);
            }
          }
          if (done.length) await addMsg(db, U, job.conv, 'sys', `例行任務已${done.join('、')}`);
          if (miss.length) await addMsg(db, U, job.conv, 'sys', `找不到這些例行任務，沒有變更：${miss.join('、')}`);
        }
        if (claimedBuilt && !plans.length) await addMsg(db, U, job.conv, 'sys', '這次回覆說排程已建好，但沒有寫出可以建立的時間，所以沒有新增例行任務。');
        if (learned && learned.length >= 4) {
          const cur = await db.prepare('SELECT task FROM bots WHERE id=? AND user_id=?').bind(job.bot_id, U).first();
          if (cur && cur.task !== learned) {
            await db.prepare('UPDATE bots SET task=? WHERE id=? AND user_id=?').bind(learned, job.bot_id, U).run();
            await addMsg(db, U, job.conv, 'sys', `已自動更新「${(await db.prepare('SELECT name FROM bots WHERE id=?').bind(job.bot_id).first())?.name || '機器人'}」的指定任務，可在任務設定修改`);
            if (!String(cur.task || '').trim()) await autoStandby(db, U, job.bot_id);
          }
        }
        const earlierMine = job.kind === 'chat'
          ? (await db.prepare('SELECT text FROM messages WHERE user_id=? AND conv=? AND by_=? ORDER BY id DESC LIMIT 2').bind(U, job.conv, job.bot_id).all()).results
          : [];
        const loginStuck = good && job.kind === 'chat' && LOGIN_WAIT.test(text);
        const loginAgain = loginStuck && earlierMine.length >= 2 && LOGIN_WAIT.test(earlierMine[1]?.text || '');
        // paused for a sign-in counts as not_logged_in in 工作紀錄, even though the reply itself came back fine
        if (fail || loginStuck) await db.prepare('UPDATE jobs SET err_kind=?, err_msg=? WHERE id=?').bind(fail ? fail.kind : 'not_logged_in', fail ? fail.msg : clean(text, 500), job.id).run();
        if (job.kind === 'chat' && !loginAgain) {
          const st = await getSettings(db, U);
          const who = (await db.prepare('SELECT name FROM bots WHERE id=?').bind(job.bot_id).first())?.name || '機器人';
          const photo = (fail || loginStuck) && typeof body.shot === 'string' && /^[A-Za-z0-9+/=]+$/.test(body.shot.slice(0, 200)) && body.shot.length < 900000 ? body.shot : null;
          if (fail || loginStuck) await sendNotify(env, st, failureNotice(who, job.prompt, fail ? fail.kind : 'not_logged_in', fail ? fail.msg : text), photo);
          else if (!good || needsYou(text)) await sendNotify(env, st, `【OCTA】${who} 需要你處理：\n${text.slice(0, 600)}`);
          else if (st.notifyAll && !JSON.parse(job.chain).length) await sendNotify(env, st, `【OCTA】${who} 完成：\n${text.slice(0, 600)}`);
        }
        if (body.page) await db.prepare('UPDATE bots SET page=? WHERE id=? AND user_id=?').bind(clean(body.page, 500), job.bot_id, U).run();
        if (!good && job.kind === 'chat') {
          const bgF = job.prompt.match(BG), via = viaOf(job);
          const asker = bgF && (await db.prepare('SELECT id FROM bots WHERE id=? AND user_id=?').bind(bgF[1], U).first());
          const me2 = (await db.prepare('SELECT name FROM bots WHERE id=?').bind(job.bot_id).first())?.name || '同事';
          if (asker) { await addMsg(db, U, (via?.c && (await db.prepare('SELECT 1 AS n FROM groups_ WHERE id=? AND user_id=?').bind(via.c, U).first()) ? via.c : asker.id), 'sys', `🔁 「${me2}」沒能完成${bgF[2] === 'ask' ? '回覆' : '交辦'}：${text.slice(0, 300)}`); await bump(db, U); }
          else if (via?.k === 'ask' && JSON.parse(job.chain).length) { await addJob(db, U, job.conv, JSON.parse(job.chain), job.prompt, job.depth); await bump(db, U); }
        }
        if (!good || job.kind !== 'chat') return ok();
        // Two replies in a row are stuck on the same sign-in: stop the chain and say so once.
        if (loginStuck) {
          if (loginAgain) {
            const noted = await db.prepare("SELECT 1 AS n FROM messages WHERE user_id=? AND conv=? AND by_='sys' AND text LIKE '需要你在電腦上登入%' LIMIT 1").bind(U, job.conv).first();
            if (!noted) await addMsg(db, U, job.conv, 'sys', '需要你在電腦上登入。登入好之後傳一句話，我就從這一頁繼續。');
          }
          return ok();
        }
        // the bot stopped halfway ("還沒完成…"): one automatic follow-up, then it has to stop
        const round = +((job.prompt.match(/^（自動接續 (\d+)）/) || [])[1] || 0);
        if (round < 1 && !passed(text) && /(還沒|尚未|沒能|未能|無法)[^。\n]{0,8}(完成|核對|查完|核完|查到|整理|列出)|還沒查|先供參考|不能當作完整|不足以/.test(text) && !LOGIN_WAIT.test(text) && classifyModelFailure(text) !== 'quota' && classifyModelFailure(text) !== 'rate_limit') {
          const orig = job.prompt.replace(/^（自動接續 \d+）[\s\S]*?原本的指示：/, '');
          await addMsg(db, U, job.conv, 'sys', '還沒做完，請它接著把剩下的做完…');
          await addJob(db, U, job.conv, [{ b: job.bot_id, p: `（自動接續 ${round + 1}）上一則沒做完。只補還沒做的那一步。如果要登入，整則只寫一次「需要使用者在電腦上登入」和網站名稱，然後停下。不要把同一句再寫一遍，也不要編畫面上沒有的房號或姓名。\n原本的指示：${orig}` }, ...JSON.parse(job.chain)], orig, job.depth);
          await bump(db, U);
          return ok();
        }
        let rest = JSON.parse(job.chain).map(s => (typeof s === 'string' ? { b: s, p: job.prompt } : s));
        // a bot asks a colleague in the same 分區: a line starting with "@名字 問題"
        const { bots, groups } = await loadAll(db, U);
        const self = bots.find(b => b.id === job.bot_id), grp = groups.find(g => g.id === job.conv);
        const asks = [], gives = [];
        // a background message finished: hand the answer back to the bot that sent it, where it was talking (its own chat or the group)
        const bg = job.prompt.match(BG), from = bg && bots.find(b => b.id === bg[1]);
        const back = viaOf(job)?.c, backConv = back && (bots.some(b => b.id === back) || groups.some(g => g.id === back)) ? back : from?.id;
        if (from && self && !passed(text)) {
          await addMsg(db, U, backConv, 'sys', `🔁 「${self.name}」${bg[2] === 'ask' ? '回覆' : '完成交辦'}：${text.slice(0, 800)}`);
          if (bg[2] === 'ask' && job.depth < MAX_ASK_DEPTH) await addJob(db, U, backConv, [{ b: from.id, p: `同事「${self.name}」回覆了你在背景問的問題：\n${text.slice(0, 3000)}\n\n請根據回覆繼續你原本在做的工作（看前面的對話）${backConv !== from.id ? '；在群組只回使用者要的最後結果（一兩句），不要轉述問答過程' : ''}；已經沒事就只回「（略過）」。` }], '', job.depth + 1);
        }
        if (self && job.depth < MAX_ASK_DEPTH && !passed(text)) {
          const mates = bots.filter(b => b.id !== self.id && (!grp || grp.members.includes(b.id)));
          for (const line of text.split('\n')) {
            const ml = mentionLine(line, mates);
            if (!ml) continue;
            const to = ml.bot;
            if (asks.some(a => a.b === to.id) || gives.some(a => a.b === to.id)) continue;
            const priv = !!grp && privateAsk(ml.rest, job.prompt);
            const said = ml.rest.replace(/^私下\s*[:：]?\s*/, '');
            const hand = said.match(/^交接\s*[:：]?\s*(.+)$/);   // "@名字 交接：…" passes the whole job on; no need to come back
            if (!hand && !mentionAsks(said, to, job.prompt)) continue;   // "@甲 收到／好喔／謝謝" or an answer back to the one who asked: no new round (stops bots thanking each other in a loop)
            if (!grp || priv) {   // outside a group, or asked privately: the other bot works on it in the background, in its own chat
              const what = hand ? hand[1] : said;
              await addMsg(db, U, to.id, 'sys', `🔁 「${self.name}」${hand ? '交辦' : '問'}：${what.slice(0, 600)}`);
              await addJob(db, U, to.id, [{ b: to.id, v: { f: self.id, k: hand ? 'give' : 'ask', w: what.slice(0, 300), c: job.conv }, p: hand
                ? `〔背景:${self.id}:give〕同事「${self.name}」交辦給你：${what}\n請照你的職責完成，最後簡短回報結果，回報會自動傳給${self.name}。`
                : `〔背景:${self.id}:ask〕同事「${self.name}」在背景問你：${what}\n請直接回答，回答會自動傳給${self.name}。` }], '', job.depth + 1);
              gives.push({ b: to.id });
              continue;
            }
            if (hand) gives.push({ b: to.id, v: { f: self.id, k: 'give', w: hand[1].slice(0, 300) }, p: `${self.name} 把工作交接給你：${hand[1]}\n（原本的指示：${job.prompt.slice(0, 1500)}）\n請接手完成並回報。` });
            else asks.push({ b: to.id, v: { f: self.id, k: 'ask', w: said.slice(0, 300) }, p: `${self.name} 問你：${said}\n請直接回答 ${self.name}。` });
          }
        }
        // a group hand-off: the member it went to is next in line and does it once; its own later turn for this same instruction is dropped.
        // In a parallel group it may already be waiting on this message: it reads the hand-off in the chat, so it isn't queued twice.
        const handed = [];
        for (const g of gives) {
          if (!g.p) continue;
          const waiting = await db.prepare("SELECT 1 AS n FROM jobs WHERE user_id=? AND conv=? AND bot_id=? AND status='pending' LIMIT 1").bind(U, job.conv, g.b).first();
          if (!waiting) handed.push(g);
        }
        if (gives.some(g => g.p)) rest = [...handed, ...rest.filter(s => !gives.some(g => g.p && g.b === s.b))];
        if (asks.length) rest = [...asks, { b: self.id, p: `同事已在上面回覆你的問題，請根據回覆繼續完成原本的指示：${job.prompt}` }, ...rest];
        if (gives.length || from) await bump(db, U);
        await addJob(db, U, job.conv, rest, job.prompt, job.depth + (asks.length || handed.length ? 1 : 0));
        return ok();
      }
      if (path === 'runner/shot' && m === 'POST') {   // the screenshot stays on the computer; only where it is goes up
        const job = await db.prepare('SELECT bot_id,conv FROM jobs WHERE id=? AND user_id=?').bind(+body.id, U).first();
        if (!job) return err('找不到任務', 404);
        const p = safePath(body.path), name = clean(body.name, 120) || 'screenshot.jpg';
        if (!p) return err('路徑不正確');
        const old = await db.prepare('SELECT shot_file FROM bots WHERE id=? AND user_id=?').bind(job.bot_id, U).first();
        const id = 'file-' + uid();
        const kept = old?.shot_file && await db.prepare('SELECT 1 AS n FROM jobs WHERE user_id=? AND shot=? AND err_kind IS NOT NULL').bind(U, old.shot_file).first();   // a failed job's screenshot stays
        await db.batch([
          db.prepare("INSERT INTO files (id,user_id,name,mime,data,ts,conv,loc,path,size,pc) VALUES (?,?,?,?,'',?,?,'pc',?,?,?)").bind(id, U, name, mimeOf(name, body.mime), now(), job.conv, p, +body.size || null, me.kind === 'runner' ? label : null),
          db.prepare('UPDATE bots SET shot_ts=?, shot_file=?, bpc=IFNULL(bpc,?) WHERE id=? AND user_id=?').bind(now(), id, me.kind === 'runner' ? label : null, job.bot_id, U),
          db.prepare('UPDATE jobs SET shot=? WHERE id=? AND user_id=?').bind(id, +body.id, U),
          db.prepare('DELETE FROM files WHERE id=? AND user_id=?').bind(kept ? '' : old?.shot_file || '', U),
          db.prepare('DELETE FROM chunks WHERE file_id=?').bind(kept ? '' : old?.shot_file || ''),
          db.prepare('DELETE FROM shots WHERE bot_id=? AND user_id=?').bind(job.bot_id, U)
        ]);
        return ok();
      }
      if (path === 'runner/code/event' && m === 'POST') {
        const id = clean(body.id || body.taskId, 80);
        const task = await db.prepare('SELECT * FROM code_tasks WHERE id=? AND user_id=?').bind(id, U).first();
        if (!task) return err('找不到程式任務', 404);
        const summary = body.summary && typeof body.summary === 'object' ? JSON.stringify(body.summary).slice(0, 80000) : (typeof body.summary === 'string' ? body.summary.slice(0, 80000) : task.summary);
        const status = clean(body.status, 40) || task.status;
        const phase = clean(body.phase, 40) || task.phase;
        await db.prepare(`UPDATE code_tasks SET status=?, phase=?, role=?, workspace_id=COALESCE(?, workspace_id), branch=COALESCE(?, branch), base_ref=COALESCE(?, base_ref), head_ref=COALESCE(?, head_ref), retries=?, summary=?, updated=? WHERE id=? AND user_id=?`)
          .bind(status, phase, clean(body.role, 40) || task.role, clean(body.workspaceId, 80) || null, clean(body.branch, 120) || null, clean(body.baseRef, 80) || null, clean(body.headRef, 80) || null, Number.isFinite(+body.retries) ? +body.retries : task.retries, summary, now(), id, U).run();
        const evs = (Array.isArray(body.events) ? body.events : (body.event ? [body.event] : [])).slice(-12);
        for (const ev of evs) {
          if (!ev || typeof ev !== 'object') continue;
          await db.prepare('INSERT INTO code_events (task_id,user_id,ts,role,kind,text,data) VALUES (?,?,?,?,?,?,?)')
            .bind(id, U, now(), clean(ev.role, 40), clean(ev.kind, 40) || 'log', clean(ev.text, 1500), ev.data ? JSON.stringify(ev.data).slice(0, 8000) : null).run();
        }
        if (task.job_id) await db.prepare("UPDATE jobs SET progress=? WHERE id=? AND user_id=? AND status='running'").bind(clean(phase, 120), task.job_id, U).run();
        const r = J({ ok: true, cancel: !!task.cancel || status === 'cancelled' });
        r._u = U;
        return r;
      }
      if (path === 'runner/code/resume' && m === 'POST') {
        const id = clean(body.taskId || body.id, 80);
        const task = await db.prepare('SELECT * FROM code_tasks WHERE id=? AND user_id=?').bind(id, U).first();
        if (!task) return J({ continue: false, gone: true });
        if (task.cancel) return J({ continue: false, cancel: true });
        const job = task.job_id ? await db.prepare("SELECT * FROM jobs WHERE id=? AND user_id=? AND kind='code' AND status='running'").bind(task.job_id, U).first() : null;
        if (!job) return J({ continue: false });
        const repo = await db.prepare('SELECT * FROM code_repos WHERE id=? AND user_id=?').bind(task.repo_id, U).first();
        if (!repo) return J({ continue: false, gone: true });
        return J({ continue: true, job: { id: job.id, kind: 'code', task: publicCodeTask(task), repo: { id: repo.id, name: repo.name, path: repo.path } } });
      }
      return err('未知的執行器路徑', 404);
    }

    // ---------- web app ----------
    if (path === 'logout' && m === 'POST') {
      if (me.token) { await db.prepare('DELETE FROM sessions WHERE token=?').bind(me.token).run(); sesCache.delete(me.token); }
      return J({ ok: true });
    }
    if (path === 'wait' && m === 'GET') {   // long-poll: returns as soon as anything changes (or after 25 s)
      const have = +url.searchParams.get('rev');
      try { await fireRoutines(env, db, U, false); } catch { }
      const t0 = now();
      const haveP = url.searchParams.has('prog') ? +url.searchParams.get('prog') : null;
      for (; ;) {
        const u = await db.prepare('SELECT rev, prog FROM users WHERE id=?').bind(U).first(), rev = u?.rev ?? 0, prog = u?.prog ?? 0;
        if (rev !== have || (haveP !== null && prog !== haveP) || now() - t0 > WAIT_MS) return J({ rev, prog });
        await sleep(1500);
      }
    }
    if (path === 'busy' && m === 'GET') {   // just what is running now (progress lines), without reloading everything
      const busy = (await db.prepare("SELECT conv,bot_id,status,kind,started,progress,eng FROM jobs WHERE user_id=? AND kind<>'test' AND status IN ('pending','running')").bind(U).all()).results;
      const u = await db.prepare('SELECT prog FROM users WHERE id=?').bind(U).first();
      return J({ busy, prog: u?.prog ?? 0 });
    }
    if (path === 'state' && m === 'GET') {
      const all = await loadAll(db, U);
      const convIds = [...all.bots.map(b => b.id), ...all.groups.map(g => g.id)];
      const [ur, busy, rev, ...lasts] = await db.batch([
        // recent bot replies, for unread counts and notifications
        db.prepare("SELECT conv,id FROM messages WHERE user_id=? AND by_ NOT IN ('me','sys') ORDER BY id DESC LIMIT 100").bind(U),   // D1 讀取量: every device reads this on each change
        db.prepare("SELECT conv,bot_id,status,kind,started,progress,eng FROM jobs WHERE user_id=? AND kind<>'test' AND status IN ('pending','running')").bind(U),
        db.prepare('SELECT rev, prog FROM users WHERE id=?').bind(U),
        // newest non-system message of each conversation (list previews); one indexed lookup each
        // ask: the ✅待確認 line of a bot's message, so 待你核准 shows even when it is past the 140-character preview
        ...convIds.map(c => db.prepare("SELECT conv,id,by_ AS by,substr(text,1,140) AS text,ts,CASE WHEN by_<>'me' AND instr(text,'待確認')>0 THEN substr(text,instr(text,'待確認')-(CASE WHEN substr(text,instr(text,'待確認')-1,1)=' ' THEN 2 ELSE 1 END),200) END AS ask FROM messages WHERE user_id=? AND conv=? AND by_<>'sys' ORDER BY id DESC LIMIT 1").bind(U, c))
      ]);
      const last = { results: lasts.flatMap(r => r.results) };
      const h = env.isLocal ? null : await hostInfo(db, U);
      const st = await getSettings(db, U);
      const { date } = localNow(env), dayStart = Date.parse(date + 'T00:00:00Z') - (+env.TZ_OFFSET_MIN || 0) * 60000;
      const tok = (await db.prepare('SELECT bot_id, SUM(tokens) AS t, COUNT(*) AS n FROM jobs WHERE user_id=? AND created>=? AND kind=\'chat\' GROUP BY bot_id').bind(U, dayStart).all()).results;
      let codeTasks = [];
      try {
        codeTasks = (await db.prepare('SELECT id,title,status,phase,engine,model FROM code_tasks WHERE user_id=? ORDER BY created DESC LIMIT 8').bind(U).all()).results;
      } catch { codeTasks = []; }
      return J({ tokens: Object.fromEntries(tok.map(r => [r.bot_id, { t: r.t, n: r.n }])), codeTasks,
        me: me.name, local: me.kind === 'local', rev: rev.results[0]?.rev ?? 0, prog: rev.results[0]?.prog ?? 0,
        engines: h ? h.engines : JSON.parse((await db.prepare('SELECT engines FROM users WHERE id=?').bind(U).first())?.engines || 'null'),
        runnerOnline: env.runnerOnline ? env.runnerOnline() : (h ? h.online : true),
        host: h ? h.hostLabel : 'local', computers: h ? h.runners.length : 1, shareBrowser: st.shareBrowser !== false, nick: st.nick || '', sched: st.sched === 'cloud' ? 'cloud' : 'pc', quick: st.quick || {}, allow: st.allow || {}, pins: st.pins || [], mute: st.mute || {}, memory: st.memory || {}, facts: st.facts || {}, manuals: st.manuals || {}, review: st.review !== false, skills: st.skills || {}, nsk: Object.fromEntries(Object.entries(st.nskills || {}).map(([k, v]) => [k, [...new Set(Object.keys(v.files || {}).map(p => p.split('/')[0]))]])), warm: WARM.includes(+st.warm) ? +st.warm : 120, models: h ? h.models : st._models || null,
        focus: st.focus?.conv ? { conv: st.focus.conv, dev: st.focus.dev || '', at: st.focus.at || 0 } : null,
        ...all, last: last.results, ur: ur.results.map(r => [r.conv, r.id]), busy: busy.results
      });
    }
    if (path === 'messages' && m === 'GET') {   // one conversation, 50 at a time
      const conv = clean(url.searchParams.get('conv'), 64), before = +url.searchParams.get('before') || 0, after = +url.searchParams.get('after') || 0;
      const lim = Math.min(100, +url.searchParams.get('limit') || 50);
      const rows = (await (after
        ? db.prepare('SELECT id,conv,by_ AS by,text,files,ts,reply FROM messages WHERE user_id=? AND conv=? AND id>? ORDER BY id LIMIT ?').bind(U, conv, after, lim)
        : db.prepare('SELECT * FROM (SELECT id,conv,by_ AS by,text,files,ts,reply FROM messages WHERE user_id=? AND conv=? AND id<? ORDER BY id DESC LIMIT ?) ORDER BY id').bind(U, conv, before || 9e15, lim)
      ).all()).results.map(x => ({ ...x, files: x.files ? JSON.parse(x.files) : [] }));
      return J({ msgs: rows, more: !after && rows.length === lim });
    }
    if (path === 'template' && m === 'POST') {
      const lang = TEMPLATES_I18N[body.lang] ? body.lang : ((await getSettings(db, U)).lang || 'zh-TW');
      const raw = (TEMPLATES_I18N[lang] || TEMPLATES_I18N['zh-TW'])[body.name];
      if (!raw) return err('沒有這個範本');
      const t = { folder: raw.folder, notes: raw.notes || '', bots: raw.bots.map(([k, name, task]) => ({ k, name: noSpaces(name), task })), groups: raw.groups.map(([name, task, members]) => ({ name, task, members })) };
      let folder = null;
      if (t.folder) {
        folder = (await db.prepare('SELECT id FROM folders WHERE user_id=? AND name=?').bind(U, t.folder).first())?.id;
        if (!folder) { folder = 'f-' + uid(); await db.prepare('INSERT INTO folders (id,user_id,name,notes,created) VALUES (?,?,?,?,?)').bind(folder, U, t.folder, t.notes || null, now()).run(); }
      }
      const map = {};
      for (const b of t.bots) {
        map[b.k] = uid();
        await db.prepare('INSERT INTO bots (id,user_id,name,task,folder,avatar,created) VALUES (?,?,?,?,?,?,?)').bind(map[b.k], U, b.name, b.task, folder, TEMPLATE_AVATARS[b.k] || null, now()).run();
      }
      for (const g of t.groups)
        await db.prepare('INSERT INTO groups_ (id,user_id,name,task,members,folder,created) VALUES (?,?,?,?,?,?,?)')
          .bind('g-' + uid(), U, g.name, g.task, JSON.stringify(g.members.map(k => map[k])), folder, now() + 1).run();
      // routines the template needs start paused: the person fills in the folder notes and times first
      for (const [k, name, times, prompt] of raw.routines || []) {
        if (!map[k]) continue;
        await db.prepare("INSERT INTO routines (id,user_id,conv,name,prompt,times,enabled,fired,created) VALUES (?,?,?,?,?,?,0,'{}',?)").bind('r-' + uid(), U, map[k], clean(name, 40), clean(prompt, 2000), JSON.stringify(cleanTimes(times)), now()).run();
        await addMsg(db, U, map[k], 'sys', `這個範本附了例行任務「${clean(name, 40)}」（${cleanTimes(times).join('、')}），目前暫停。先在分區資料寫好內容，再到任務設定 → 例行任務打開。`);
      }
      return ok();
    }

    // ---------- coding tasks (host computer executes them; this API only stores state) ----------
    if (path === 'code/providers' && m === 'GET') {
      const h = env.isLocal ? null : await hostInfo(db, U);
      const st = env.isLocal ? await getSettings(db, U) : null;
      const hostRow = h?.runners.find(r => (r.label || 'runner') === h.hostLabel);
      const info = env.isLocal ? (st?._coding || null) : (hostRow?.info ? parseJson(hostRow.info)?.coding || null : null);
      const engines = h ? h.engines : parseJson((await db.prepare('SELECT engines FROM users WHERE id=?').bind(U).first())?.engines);
      const row = (id, label, available, reason, models) => ({ id, label, available: !!available, reason: reason || (available ? '' : '主機尚未回報'), models: models || [] });
      return J({
        limits: { maxRepairs: 3, maxWritersPerWorktree: 1 },
        fixture: env.OCTA_CODE_ALLOW_FIXTURE === '1',
        providers: [
          row('ollama', 'Ollama 本機模型', info?.ollama?.available, info?.ollama?.reason, info?.ollama?.models),
          row('opencode', 'OpenCode', info?.opencode?.available, info?.opencode?.reason),
          row('claude', 'Claude Code', engines?.claude, engines ? '' : '主機尚未回報'),
          row('codex', 'ChatGPT / Codex', engines?.codex, engines ? '' : '主機尚未回報'),
          row('gemini', 'Antigravity', engines?.gemini, engines ? '' : '主機尚未回報'),
          row('unity', 'Unity', info?.unity?.available, info?.unity?.reason || '未偵測到 Unity'),
          row('unreal', 'Unreal', info?.unreal?.available, info?.unreal?.reason || '未偵測到 Unreal')
        ]
      });
    }
    if (path === 'code/repos' && m === 'GET') {
      const rows = (await db.prepare('SELECT * FROM code_repos WHERE user_id=? ORDER BY created').bind(U).all()).results;
      return J({ repos: rows });
    }
    if (path === 'code/repos' && m === 'POST') {
      const name = clean(body.name, 40), pathName = repoPathOk(body.path);
      if (!name || !pathName) return err('名稱和絕對路徑都要填，路徑不能含 ..');
      const id = 'cr-' + uid();
      await db.prepare('INSERT INTO code_repos (id,user_id,name,path,validated,created) VALUES (?,?,?,?,0,?)').bind(id, U, name, pathName, now()).run();
      return ok({ id });
    }
    if (path.startsWith('code/repos/') && m === 'DELETE') {
      const id = path.slice('code/repos/'.length);
      const open = await db.prepare("SELECT 1 FROM code_tasks WHERE user_id=? AND repo_id=? AND status NOT IN ('tested','failed','cancelled','blocked')").bind(U, id).first();
      if (open) return err('這個儲存庫還有進行中的程式任務', 409);
      await db.prepare('DELETE FROM code_repos WHERE id=? AND user_id=?').bind(id, U).run();
      return ok();
    }
    if (path === 'code/tasks' && m === 'GET') {
      const rows = (await db.prepare('SELECT * FROM code_tasks WHERE user_id=? ORDER BY created DESC LIMIT 50').bind(U).all()).results;
      return J({ tasks: rows.map(publicCodeTask) });
    }
    if (path === 'code/tasks' && m === 'POST') {
      const repo = await db.prepare('SELECT * FROM code_repos WHERE id=? AND user_id=?').bind(clean(body.repoId, 80), U).first();
      if (!repo) return err('找不到授權的儲存庫', 404);
      const title = clean(body.title, 80), prompt = clean(body.prompt, 8000), criteria = clean(body.criteria, 4000);
      const engine = codeEngineOk(body.engine);
      if (!engine) return err('要選擇模型或引擎');
      if (engine === 'fixture' && env.OCTA_CODE_ALLOW_FIXTURE !== '1') return err('測試替身未啟用');
      if (!title || !prompt) return err('標題和任務內容都要填');
      const maxRetries = Math.max(0, Math.min(3, Number.isFinite(+body.maxRetries) ? Math.floor(+body.maxRetries) : 3));
      const id = 'ct-' + uid();
      const t = now();
      const fb = codeFbOk(body.fallbacks);
      await db.prepare(`INSERT INTO code_tasks (id,user_id,repo_id,title,prompt,criteria,engine,model,fb,status,phase,retries,max_retries,cancel,created,updated)
        VALUES (?,?,?,?,?,?,?,?,?,'queued','queued',0,?,0,?,?)`).bind(id, U, repo.id, title, prompt, criteria || '測試要通過', engine, clean(body.model, 80) || null, fb, maxRetries, t, t).run();
      const job = await db.prepare("INSERT INTO jobs (user_id,conv,bot_id,chain,prompt,created,kind,url) VALUES (?,?,?,'[]',?,?,'code',?)").bind(U, 'code:' + id, 'code-agent', title, t, id).run();
      await db.prepare('UPDATE code_tasks SET job_id=? WHERE id=?').bind(job.meta.last_row_id, id).run();
      await db.prepare('INSERT INTO code_events (task_id,user_id,ts,role,kind,text) VALUES (?,?,?,?,?,?)').bind(id, U, t, 'orchestrator', 'queued', '已排隊，等待主機電腦執行').run();
      return ok({ id, jobId: job.meta.last_row_id });
    }
    const codeTaskMatch = path.match(/^code\/tasks\/([^/]+)$/);
    if (codeTaskMatch && m === 'GET') {
      const id = codeTaskMatch[1];
      const task = await db.prepare('SELECT * FROM code_tasks WHERE id=? AND user_id=?').bind(id, U).first();
      if (!task) return err('找不到程式任務', 404);
      const events = (await db.prepare('SELECT id,ts,role,kind,text,data FROM code_events WHERE task_id=? AND user_id=? ORDER BY id DESC LIMIT 80').bind(id, U).all()).results.reverse();
      return J({ task: publicCodeTask(task), events: events.map(e => ({ ...e, data: parseJson(e.data) })) });
    }
    const codeCancel = path.match(/^code\/tasks\/([^/]+)\/cancel$/);
    if (codeCancel && m === 'POST') {
      const id = codeCancel[1];
      const task = await db.prepare('SELECT * FROM code_tasks WHERE id=? AND user_id=?').bind(id, U).first();
      if (!task) return err('找不到程式任務', 404);
      await db.prepare('UPDATE code_tasks SET cancel=1, updated=? WHERE id=? AND user_id=?').bind(now(), id, U).run();
      if (task.status === 'queued' && task.job_id) {
        await db.prepare("DELETE FROM jobs WHERE id=? AND user_id=? AND status='pending'").bind(task.job_id, U).run();
        await db.prepare("UPDATE code_tasks SET status='cancelled', phase='cancelled', finished=? WHERE id=? AND user_id=?").bind(now(), id, U).run();
      }
      await db.prepare('INSERT INTO code_events (task_id,user_id,ts,role,kind,text) VALUES (?,?,?,?,?,?)').bind(id, U, now(), 'orchestrator', 'cancel', '使用者取消任務').run();
      return ok({ cancelled: task.status === 'queued', stopping: task.status !== 'queued' });
    }
    const codeApprove = path.match(/^code\/tasks\/([^/]+)\/approve$/);
    if (codeApprove && m === 'POST') {
      const id = codeApprove[1];
      const task = await db.prepare('SELECT * FROM code_tasks WHERE id=? AND user_id=?').bind(id, U).first();
      if (!task) return err('找不到程式任務', 404);
      const action = body.action === 'deploy' ? 'deploy' : body.action === 'merge' ? 'merge' : '';
      if (!action) return err('要指定 merge 或 deploy');
      if (body.allow !== true) return err('需要明確核准');
      if (action === 'deploy' && body.target !== 'production') return err('正式部署要明示 target=production');
      const approval = parseJson(task.approval, {}) || {};
      approval[action] = { allow: true, by: 'user', target: action === 'deploy' ? 'production' : 'branch', at: now() };
      await db.prepare('UPDATE code_tasks SET approval=?, updated=? WHERE id=? AND user_id=?').bind(JSON.stringify(approval), now(), id, U).run();
      await db.prepare('INSERT INTO code_events (task_id,user_id,ts,role,kind,text,data) VALUES (?,?,?,?,?,?,?)')
        .bind(id, U, now(), 'policy', 'approval', action === 'deploy' ? '已記錄正式部署核准，尚未部署' : '已記錄合併核准，尚未合併', JSON.stringify({ action, executed: false })).run();
      return ok({ executed: false, deployed: false, merged: false, approval });
    }

    // folders (分區)
    if (path === 'folders' && m === 'POST') {
      const name = clean(body.name, 20);
      if (!name) return err('分區名稱要填');
      const id = 'f-' + uid();
      await db.prepare('INSERT INTO folders (id,user_id,name,notes,created) VALUES (?,?,?,?,?)').bind(id, U, name, clean(body.notes, 20000), now()).run();
      return ok({ id });
    }
    if (path.startsWith('folders/')) {
      const id = path.slice(8);
      if (m === 'PUT') {
        const name = clean(body.name, 20);
        if (!name) return err('分區名稱要填');
        await db.prepare('UPDATE folders SET name=?, notes=? WHERE id=? AND user_id=?').bind(name, clean(body.notes, 20000), id, U).run();
        return ok();
      }
      if (m === 'DELETE') {   // items fall back to 未分區
        await db.batch([
          db.prepare('UPDATE bots SET folder=NULL WHERE folder=? AND user_id=?').bind(id, U),
          db.prepare('UPDATE groups_ SET folder=NULL WHERE folder=? AND user_id=?').bind(id, U),
          db.prepare('DELETE FROM folders WHERE id=? AND user_id=?').bind(id, U)
        ]);
        return ok();
      }
    }
    if (path === 'move' && m === 'POST') {
      const { folders } = await loadAll(db, U);
      const folder = folderOk(folders, body.folder);
      const id = clean(body.id, 64);
      await db.prepare(`UPDATE ${id.startsWith('g-') ? 'groups_' : 'bots'} SET folder=? WHERE id=? AND user_id=?`).bind(folder, id, U).run();
      return ok();
    }

    // bots
    if (path === 'coach') {   // the coach link for another AI (Grok Bot): show, create, revoke
      if (me.kind === 'coach' || me.kind === 'runner') return err('不允許', 403);
      const st = await getSettings(db, U);
      if (m === 'GET') return J({ coach: st.coach || null });
      if (m === 'POST') {
        await db.prepare("DELETE FROM sessions WHERE user_id=? AND kind='coach'").bind(U).run();
        const key = randTok(), name = clean(body.name, 30) || 'Grok Bot';
        await db.prepare("INSERT INTO sessions (token,user_id,kind,label,created,seen) VALUES (?,?,'coach',?,?,?)").bind(await sha(key), U, name, now(), now()).run();
        st.coach = { key, name }; await putSettings(db, U, st);
        return J({ coach: st.coach });
      }
      if (m === 'DELETE') {
        await db.prepare("DELETE FROM sessions WHERE user_id=? AND kind='coach'").bind(U).run();
        delete st.coach; await putSettings(db, U, st);
        return J({ ok: true });
      }
    }
    if (path === 'bots' && m === 'POST') {
      const name = clean(body.name, 20), task = clean(body.task, 4000);
      if (!name) return err('名稱要填');   // the task may be empty: the bot learns it from the chat
      if (NAME_SPACE.test(name)) return err(NAME_SPACE_ERR);
      const { folders, bots } = await loadAll(db, U);
      if (bots.some(b => b.name === name)) return err('已經有同名的機器人，名字要不同才能用 @ 叫它');
      const id = uid(), engine = engineOk(body.engine);
      await db.prepare('INSERT INTO bots (id,user_id,name,task,folder,engine,model,avatar,browser,created,fb,autonomy) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').bind(id, U, name, task, folderOk(folders, body.folder), engine, modelOk(engine, body.model), avatarOk(body.avatar), body.browser === 'mine' ? 'mine' : null, now(), fbOk(body.fb), autonomyOk(body.autonomy)).run();
      await addMsg(db, U, id, 'sys', task ? '機器人已建立' : '機器人已建立：直接傳訊息告訴它要做什麼，它會自己整理成指定任務');
      if (task) await autoStandby(db, U, id);
      return ok({ id });
    }
    if (path.startsWith('bots/') && path.endsWith('/bring-logins') && m === 'POST') {   // move a bot's website logins to the host computer
      const id = path.slice(5, -'/bring-logins'.length);
      const b = await db.prepare('SELECT id,bpc FROM bots WHERE id=? AND user_id=?').bind(id, U).first();
      if (!b) return err('找不到機器人', 404);
      const h = await hostInfo(db, U);
      if (!b.bpc) return err('這個機器人還沒在任何電腦上用過自己的瀏覽器');
      if (b.bpc === h.hostLabel) return err('它的網站登入已經在主機電腦上了');
      const old = h.runners.find(r => (r.label || 'runner') === b.bpc), who = b.bpc.replace(/^desktop:/, '');
      if (!old) return err(`找不到「${who}」電腦（可能已移除）`);
      if (now() - (old.seen || 0) >= HOST_ONLINE_MS) return err(`「${who}」電腦目前離線，請先打開那台電腦的 OCTA`, 409);
      if (!h.online) return err('主機電腦離線', 409);
      const r = await db.prepare("INSERT INTO jobs (user_id,conv,bot_id,chain,prompt,created,kind,url,pc) VALUES (?,?,?,'[]','',?,'export',?,?)").bind(U, id, id, now(), h.hostLabel, b.bpc).run();
      await addMsg(db, U, id, 'sys', `正在從「${who}」電腦把網站登入帶到主機…`);
      return ok({ id: r.meta.last_row_id });
    }
    if (path.startsWith('bots/')) {
      const id = path.slice(5);
      if (m === 'PUT') {
        const name = clean(body.name, 20), task = clean(body.task, 4000);
        if (!name) return err('名稱要填');   // the task may be empty: the bot learns it from the chat
        const { folders, bots } = await loadAll(db, U);
        if (bots.some(b => b.name === name && b.id !== id)) return err('已經有同名的機器人');
        const old = bots.find(b => b.id === id);
        if (NAME_SPACE.test(name) && name !== old?.name) return err(NAME_SPACE_ERR);   // an old name with spaces may stay until it is renamed
        const engine = engineOk(body.engine);
        const fb = body.fb === undefined ? JSON.stringify(old?.fb || []) : fbOk(body.fb);
        const autonomy = body.autonomy === undefined ? (old?.autonomy || null) : autonomyOk(body.autonomy);
        await db.prepare('UPDATE bots SET name=?,task=?,folder=?,engine=?,model=?,avatar=?,browser=?,fb=?,autonomy=? WHERE id=? AND user_id=?').bind(name, task, folderOk(folders, body.folder), engine, modelOk(engine, body.model), avatarOk(body.avatar), body.browser === 'mine' ? 'mine' : null, fb, autonomy, id, U).run();
        if (old && task && !String(old.task || '').trim()) await autoStandby(db, U, id);   // just got its standing task
        return ok();
      }
      if (m === 'DELETE') {   // files stay on the host computer; only the records go
        // take the bot out of its groups; a group left with nobody is removed too
        const { groups } = await loadAll(db, U);
        for (const g of groups.filter(x => x.members.includes(id))) {
          const left = g.members.filter(x => x !== id);
          if (left.length) await db.prepare('UPDATE groups_ SET members=? WHERE id=? AND user_id=?').bind(JSON.stringify(left), g.id, U).run();
          else await db.batch([
            db.prepare('DELETE FROM groups_ WHERE id=? AND user_id=?').bind(g.id, U),
            db.prepare('DELETE FROM routines WHERE conv=? AND user_id=?').bind(g.id, U),
            db.prepare('DELETE FROM messages WHERE conv=? AND user_id=?').bind(g.id, U),
            db.prepare("DELETE FROM jobs WHERE conv=? AND user_id=? AND status='pending'").bind(g.id, U)
          ]);
        }
        await db.batch([
          db.prepare('DELETE FROM shots WHERE bot_id=? AND user_id=?').bind(id, U),
          db.prepare('DELETE FROM routines WHERE conv=? AND user_id=?').bind(id, U),
          db.prepare('DELETE FROM bots WHERE id=? AND user_id=?').bind(id, U),
          db.prepare('DELETE FROM messages WHERE conv=? AND user_id=?').bind(id, U),
          db.prepare('DELETE FROM chunks WHERE file_id IN (SELECT id FROM files WHERE conv=? AND user_id=?)').bind(id, U),
          db.prepare('DELETE FROM files WHERE conv=? AND user_id=?').bind(id, U),
          db.prepare("DELETE FROM jobs WHERE bot_id=? AND user_id=? AND status='pending'").bind(id, U)
        ]);
        return ok();
      }
    }

    // groups
    const groupBody = async () => {
      const name = clean(body.name, 20), task = clean(body.task, 4000);
      const { bots, folders } = await loadAll(db, U);
      const members = (Array.isArray(body.members) ? body.members : []).filter(x => bots.some(b => b.id === x));
      if (!name || !members.length) throw new Error('名稱和成員都要填');   // rules are optional: members take turns in order
      return { name, task, members: JSON.stringify(members), folder: folderOk(folders, body.folder) };
    };
    if (path === 'groups' && m === 'POST') {
      let g; try { g = await groupBody(); } catch (e) { return err(e.message); }
      const id = 'g-' + uid();
      await db.prepare('INSERT INTO groups_ (id,user_id,name,task,members,folder,created) VALUES (?,?,?,?,?,?,?)').bind(id, U, g.name, g.task, g.members, g.folder, now()).run();
      await addMsg(db, U, id, 'sys', '群組已建立');
      return ok({ id });
    }
    if (path.startsWith('groups/')) {
      const id = path.slice(7);
      if (m === 'PUT') {
        let g; try { g = await groupBody(); } catch (e) { return err(e.message); }
        await db.prepare('UPDATE groups_ SET name=?,task=?,members=?,folder=? WHERE id=? AND user_id=?').bind(g.name, g.task, g.members, g.folder, id, U).run();
        return ok();
      }
      if (m === 'DELETE') {
        await db.batch([
          db.prepare('DELETE FROM routines WHERE conv=? AND user_id=?').bind(id, U),
          db.prepare('DELETE FROM groups_ WHERE id=? AND user_id=?').bind(id, U),
          db.prepare('DELETE FROM messages WHERE conv=? AND user_id=?').bind(id, U),
          db.prepare('DELETE FROM chunks WHERE file_id IN (SELECT id FROM files WHERE conv=? AND user_id=?)').bind(id, U),
          db.prepare('DELETE FROM files WHERE conv=? AND user_id=?').bind(id, U),
          db.prepare("DELETE FROM jobs WHERE conv=? AND user_id=? AND status='pending'").bind(id, U)
        ]);
        return ok();
      }
    }

    // routines (例行任務)
    if (path === 'routines' && m === 'POST') {
      const { bots, groups } = await loadAll(db, U);
      const conv = clean(body.conv, 64), name = clean(body.name, 40), times = cleanTimes(body.times);
      if (!bots.some(b => b.id === conv) && !groups.some(g => g.id === conv)) return err('找不到對話', 404);
      let trig; try { trig = triggerFrom(body); } catch (e) { return err(e.message); }
      if (!name || (!times.length && !trig.hook && !trig.watch)) return err('名稱和時間（或觸發方式）都要填');
      const { date, hm } = localNow(env);   // times already past today start tomorrow
      const fired = Object.fromEntries(times.filter(t => !isEvery(t) && t <= hm).map(t => [t, date]));
      const id = 'r-' + uid();
      await db.prepare('INSERT INTO routines (id,user_id,conv,name,prompt,times,enabled,fired,created,hook,watch) VALUES (?,?,?,?,?,?,1,?,?,?,?)')
        .bind(id, U, conv, name, clean(body.prompt, 2000), JSON.stringify(times), JSON.stringify(fired), now(), trig.hook, trig.watch).run();
      if (name === STANDBY) await db.prepare('UPDATE bots SET stood=1 WHERE id=? AND user_id=?').bind(conv, U).run();
      return ok({ id, hook: trig.hook });
    }
    if (path.startsWith('routines/')) {
      const id = path.slice(9);
      const r = await db.prepare('SELECT * FROM routines WHERE id=? AND user_id=?').bind(id, U).first();
      if (!r) return err('找不到例行任務', 404);
      if (m === 'PUT') {
        const name = clean(body.name ?? r.name, 40), times = body.times ? cleanTimes(body.times) : JSON.parse(r.times);
        let trig = { hook: r.hook, watch: r.watch };
        if (body.trigger !== undefined) { try { trig = triggerFrom(body, r); } catch (e) { return err(e.message); } }
        if (!name || (!times.length && !trig.hook && !trig.watch)) return err('名稱和時間（或觸發方式）都要填');
        const enabled = body.enabled === undefined ? r.enabled : body.enabled ? 1 : 0;
        let fired = r.fired;
        if (enabled && !r.enabled || body.times) {   // turning on or changing times: don't fire times already past today
          const { date, hm } = localNow(env);
          fired = JSON.stringify(Object.fromEntries(times.filter(t => !isEvery(t) && t <= hm).map(t => [t, date])));
        }
        await db.prepare('UPDATE routines SET name=?,prompt=?,times=?,enabled=?,fired=?,hook=?,watch=?,wstate=? WHERE id=?')
          .bind(name, body.prompt === undefined ? r.prompt : clean(body.prompt, 2000), JSON.stringify(times), enabled, fired, trig.hook, trig.watch, trig.watch === r.watch ? r.wstate : null, id).run();
        return ok({ hook: trig.hook });
      }
      if (m === 'DELETE') {
        await db.prepare('DELETE FROM routines WHERE id=?').bind(id).run();
        if (r.name === STANDBY) await db.prepare('UPDATE bots SET stood=1 WHERE id=? AND user_id=?').bind(r.conv, U).run();   // turned off by the person: stays off
        return ok();
      }
    }

    // 幕後: what bots asked of / handed to each other around this conversation
    if (path === 'backstage' && m === 'GET') {
      const conv = clean(url.searchParams.get('conv'), 64);
      if (!conv) return err('要指定對話');
      const rows = (await db.prepare(`SELECT id,conv,bot_id,prompt,via,status,created,started,finished,result FROM jobs
        WHERE user_id=? AND kind='chat' AND created>? AND (via IS NOT NULL OR prompt LIKE '〔背景:%')
          AND (conv=? OR via LIKE ? OR via LIKE ? OR prompt LIKE ?) ORDER BY id DESC LIMIT 80`)
        .bind(U, now() - 14 * DAY, conv, '%"f":' + JSON.stringify(conv) + '%', '%"c":' + JSON.stringify(conv) + '%', '〔背景:' + conv + ':%').all()).results.reverse();
      return J({ items: backstageItems(rows) });
    }
    if (path === 'messages' && m === 'POST') {
      const conv = clean(body.conv, 64), text = clean(body.text, 4000);
      if (!text && !(body.files || []).length) return err('訊息是空的');
      const { bots, groups } = await loadAll(db, U);
      const bot = bots.find(b => b.id === conv), group = groups.find(g => g.id === conv);
      if (!bot && !group) return err('找不到對話', 404);
      const fileIds = (Array.isArray(body.files) ? body.files : []).slice(0, 6).map(x => clean(x, 64));
      const files = fileIds.length ? (await db.prepare(`SELECT id,name,mime,size FROM files WHERE user_id=? AND id IN (${fileIds.map(() => '?').join(',')})`).bind(U, ...fileIds).all()).results : [];
      files.sort((x, y) => fileIds.indexOf(x.id) - fileIds.indexOf(y.id));   // keep the order they were attached in
      if (files.length) await db.prepare(`UPDATE files SET conv=? WHERE user_id=? AND conv IS NULL AND id IN (${files.map(() => '?').join(',')})`).bind(conv, U, ...files.map(f => f.id)).run();
      const want = Math.floor(+body.reply);
      let quoted = null;
      if (want > 0) {
        const src = await db.prepare('SELECT id, by_, text FROM messages WHERE id=? AND user_id=? AND conv=?').bind(want, U, conv).first();
        if (src) {
          const who = src.by_ === 'me' ? '你自己' : src.by_ === 'sys' ? '系統' : (bots.find(b => b.id === src.by_)?.name || '那則訊息');
          const bit = String(src.text || '').replace(/\s+/g, ' ').trim().slice(0, 160) || '（沒有文字）';
          quoted = { by: src.by_, id: src.id, note: `（這則是在回覆「${who}」的這一則：${bit}。請針對這一則回答。）` };
        }
      }
      await addMsg(db, U, conv, 'me', text || '（附件）', files, quoted?.id || null);
      // 核准 a 每週自我檢討 suggestion: write the rules directly, no AI run needed
      const ru = bot && text.match(/^核准[:：]\s*更新規則[:：]\s*([\s\S]+)$/);
      if (ru && (await db.prepare("SELECT 1 AS n FROM messages WHERE user_id=? AND conv=? AND by_=? AND text LIKE '%✅待確認：更新規則%' AND ts>? LIMIT 1").bind(U, conv, bot.id, now() - 14 * DAY).first())) {
        const st = await getSettings(db, U), { rules, done } = applyRuleUpdates((st.memory || {})[bot.id], ru[1]);
        st.memory = st.memory || {}; if (rules.length) st.memory[bot.id] = rules; else delete st.memory[bot.id];
        await putSettings(db, U, st);
        await addMsg(db, U, conv, 'sys', done.length ? `已更新規則：${done.join('；').slice(0, 300)}` : '規則沒有變更（建議的內容已經有了）');
        return ok();
      }
      await enqueueTurn(db, U, conv, text, bot, group, bots, quoted);
      return ok();
    }
    if (path === 'messages/copy' && m === 'POST') {   // drag a message onto another bot: same text and its own copies of the files
      const to = clean(body.to, 64), from = clean(body.from, 64), id = Math.floor(+body.id);
      if (!to || !from || !id) return err('要指定訊息和要貼到哪裡');
      if (to === from) return err('已經在這個對話');
      const { bots, groups } = await loadAll(db, U);
      const bot = bots.find(b => b.id === to), group = groups.find(g => g.id === to);
      if (!bot && !group) return err('找不到對話', 404);
      const src = await db.prepare('SELECT id,text,files FROM messages WHERE id=? AND user_id=? AND conv=?').bind(id, U, from).first();
      if (!src) return err('找不到訊息', 404);
      const text = String(src.text || '');
      let parsed = [];
      try { parsed = src.files ? JSON.parse(src.files) : []; } catch { parsed = []; }
      const files = [];
      for (const f of (Array.isArray(parsed) ? parsed : []).slice(0, 6)) {
        const copy = await cloneFile(db, U, clean(f?.id, 64), to);
        if (copy) files.push(copy);
      }
      if (!text && !files.length) return err('訊息是空的');
      await addMsg(db, U, to, 'me', text || '（附件）', files);
      await enqueueTurn(db, U, to, text.slice(0, 8000), bot, group, bots);
      if (body.replace) await db.prepare('DELETE FROM messages WHERE id=? AND user_id=? AND conv=?').bind(id, U, from).run();
      return ok({ replaced: !!body.replace });
    }
    if (path === 'clear' && m === 'POST') {   // empty one conversation's history
      const conv = clean(body.conv, 64);
      const { bots, groups } = await loadAll(db, U);
      if (!bots.some(b => b.id === conv) && !groups.some(g => g.id === conv)) return err('找不到對話', 404);
      await db.batch([
        db.prepare('DELETE FROM messages WHERE conv=? AND user_id=?').bind(conv, U),
        db.prepare("DELETE FROM jobs WHERE conv=? AND user_id=? AND status='pending'").bind(conv, U)
      ]);
      await addMsg(db, U, conv, 'sys', '對話紀錄已清空');
      return ok();
    }
    if (path === 'grokbot/list' && m === 'POST') {   // ask the host computer for the bots in the user's Grok Bot
      const r = await db.prepare("INSERT INTO jobs (user_id,conv,bot_id,chain,prompt,created,kind,url) VALUES (?,'__test','list:grokbot','[]','',?,'list','grokbot')").bind(U, now()).run();
      return ok({ id: r.meta.last_row_id });
    }
    if (path === 'engine-install' && m === 'POST') {   // from any device: the host computer opens the install window
      const engine = engineOk(body.engine);
      if (['copilot', 'cursor', 'qwen', 'grok', 'grokbot'].includes(engine)) return err('這個 AI 暫時不開放連接', 400);
      const h = env.isLocal ? null : await hostInfo(db, U);
      if (h && !h.online) return err('主機電腦離線，請先打開主機電腦上的 OCTA', 409);
      const hs = h && h.runners.find(r => (r.label || 'runner') === h.hostLabel), hv = hs?.info ? JSON.parse(hs.info).app || '' : '';
      if (h && hv && hv.split('.').map(Number).reduce((a, n) => a * 1000 + n, 0) < 2002004) return err('主機電腦的 OCTA 版本太舊，請先更新到 v2.2.4 以上', 409);
      const r = await db.prepare("INSERT INTO jobs (user_id,conv,bot_id,chain,prompt,created,kind,url) VALUES (?,'__test',?,'[]','',?,'install',?)")
        .bind(U, 'install:' + engine, now(), engine).run();
      return ok({ id: r.meta.last_row_id });
    }
    if (path === 'engine-test' && m === 'POST') {
      const engine = engineOk(body.engine);
      const r = await db.prepare("INSERT INTO jobs (user_id,conv,bot_id,chain,prompt,created,kind,url) VALUES (?,'__test',?,'[]',?,?,'test',?)")
        .bind(U, 'test:' + engine, '這是 OCTA 的連線測試，請只回覆兩個字：OK', now(), engine).run();
      return ok({ id: r.meta.last_row_id });
    }
    if (path.startsWith('job/') && m === 'GET') {
      const j = await db.prepare('SELECT status,result FROM jobs WHERE id=? AND user_id=?').bind(+path.slice(4), U).first();
      return j ? J(j) : err('找不到', 404);
    }
    if (path === 'handoff' && m === 'POST') {
      const bot = clean(body.bot, 64);
      const owns = await db.prepare('SELECT id FROM bots WHERE id=? AND user_id=?').bind(bot, U).first();
      if (!owns) return err('找不到這個機器人', 404);
      const on = !(body.on === false || body.on === 0);
      const cur = await db.prepare('SELECT bot_id FROM live WHERE bot_id=? AND user_id=?').bind(bot, U).first();
      if (cur) await db.prepare('UPDATE live SET handed=?, ts=? WHERE bot_id=? AND user_id=?').bind(on ? 1 : 0, now(), bot, U).run();
      else await db.prepare('INSERT INTO live (bot_id,user_id,url,title,mime,data,ts,handed) VALUES (?,?,?,?,?,?,?,?)').bind(bot, U, '', '', 'image/jpeg', '', now(), on ? 1 : 0).run();
      return ok({ handed: on });
    }
    if (path.startsWith('live/') && m === 'GET') {
      const id = path.slice(5);
      const since = +url.searchParams.get('since') || 0;
      const head = await db.prepare('SELECT ts,handed FROM live WHERE bot_id=? AND user_id=?').bind(id, U).first();
      if (head && since && +head.ts === since) { await db.prepare('UPDATE live SET watch=? WHERE bot_id=? AND user_id=?').bind(now(), id, U).run(); return J({ same: true, ts: head.ts, handed: !!head.handed }); }   // same frame: don't send the picture again
      const row = head && await db.prepare('SELECT url,title,data,ts,handed FROM live WHERE bot_id=? AND user_id=?').bind(id, U).first();
      if (row) await db.prepare('UPDATE live SET watch=? WHERE bot_id=? AND user_id=?').bind(now(), id, U).run();   // tells the host to keep sending frames
      else await db.prepare('INSERT INTO live (bot_id,user_id,url,title,mime,data,ts,handed,watch) VALUES (?,?,?,?,?,?,?,0,?)').bind(id, U, '', '', 'image/jpeg', '', 0, now()).run();
      return J(row ? { url: row.url || '', title: row.title || '', data: row.data || '', ts: row.ts || 0, handed: !!row.handed } : {});
    }
    if (path === 'focus' && m === 'PUT') {
      const dev = clean(body.dev, 40), conv = clean(body.conv, 64);
      if (!/^[a-z0-9]{8,40}$/i.test(dev)) return err('這台裝置沒有代號');
      const { bots, groups } = await loadAll(db, U);
      if (![...bots, ...groups].some(x => x.id === conv)) return err('找不到這個對話', 404);
      const st = await getSettings(db, U);
      st.focus = { conv, dev, at: now() };
      await putSettings(db, U, st);
      return ok({ ok: true });
    }
    if (path === 'connectors' && m === 'GET') {
      const st = await getSettings(db, U);
      return J({
        builtins: [
          { name: 'Telegram', on: !!(st.tg?.token && st.tg?.chat), can: ['送出'], where: '通知' },
          { name: 'LINE', on: !!(st.line?.token && st.line?.to), can: ['送出'], where: '通知' }
        ],
        custom: (st.connectors || []).map(c => ({ id: c.id, name: c.name, base: c.base, header: c.header || 'Authorization', secret: mask(c.secret) }))
      });
    }
    if (path === 'connectors' && m === 'POST') {
      const st = await getSettings(db, U);
      const list = st.connectors || [];
      if (list.length >= 8) return err('最多接 8 個自己的服務');
      const n = normalizeCustom(body, list);
      if (n.error) return err(n.error);
      const id = 'c-' + uid();
      st.connectors = [...list, { ...n.item, id }];
      await putSettings(db, U, st);
      return ok({ id });
    }
    if (path.startsWith('connectors/') && m === 'DELETE') {
      const id = path.slice('connectors/'.length);
      const st = await getSettings(db, U);
      const list = st.connectors || [];
      if (!list.some(c => c.id === id)) return err('找不到這個連接器', 404);
      st.connectors = list.filter(c => c.id !== id);
      await putSettings(db, U, st);
      return ok({ ok: true });
    }
    if (path === 'settings' && m === 'GET') {
      const st = await getSettings(db, U);
      return J({ warm: WARM.includes(+st.warm) ? +st.warm : 120, shareBrowser: st.shareBrowser !== false, notes: st.notes || '', notifyAll: !!st.notifyAll, sched: st.sched === 'cloud' ? 'cloud' : 'pc', tg: { token: mask(st.tg?.token), chat: st.tg?.chat || '' }, line: { token: mask(st.line?.token), to: st.line?.to || '' } });
    }
    if (path === 'settings' && m === 'PUT') {
      const st = await getSettings(db, U);
      if (body.notes !== undefined) st.notes = clean(body.notes, 20000);
      if (body.notifyAll !== undefined) st.notifyAll = !!body.notifyAll;
      if (body.nick !== undefined) st.nick = clean(body.nick, 20);   // what the bots call you
      if (['cloud', 'pc'].includes(body.sched)) st.sched = body.sched;
      if (body.warm !== undefined && WARM.includes(+body.warm)) st.warm = +body.warm;
      if (body.shareBrowser !== undefined) st.shareBrowser = !!body.shareBrowser;
      if (['zh-TW', 'zh-CN', 'en', 'ja'].includes(body.lang)) st.lang = body.lang;
      // per-bot extras kept with the account: 置頂, notifications, memory (📌), skills (🧩)
      if (Array.isArray(body.pins)) { st.pins = body.pins.map(x => clean(x, 64)).filter(Boolean).slice(0, 50); await putSettings(db, U, st); await bump(db, U); return J({ ok: true }); }
      if (body.mute && typeof body.mute === 'object') { st.mute = st.mute || {}; const id = clean(body.mute.bot, 64); if (body.mute.on) st.mute[id] = 1; else delete st.mute[id]; await putSettings(db, U, st); await bump(db, U); return J({ ok: true }); }
      if (body.memory && typeof body.memory === 'object') {   // type: rule (📌, default) | fact (📇) | manual (📘)
        const key = MEM_KEYS[body.memory.type] || 'memory', id = clean(body.memory.bot, 64), raw = Array.isArray(body.memory.list) ? body.memory.list : [];
        const list = key === 'manuals'
          ? raw.map(x => ({ name: clean(x?.name, 40), steps: clean(x?.steps, 1500), ts: +x?.ts || now(), used: Math.max(0, +x?.used || 0) })).filter(x => x.name && x.steps).slice(-MANUAL_MAX)
          : raw.map(x => clean(x, 300)).filter(Boolean).slice(key === 'facts' ? -60 : -40);
        st[key] = st[key] || {};
        if (list.length) st[key][id] = list; else delete st[key][id];
        await putSettings(db, U, st); await bump(db, U); return J({ ok: true });
      }
      if (body.review !== undefined) st.review = !!body.review;   // 每週自我檢討
      if (body.skills && typeof body.skills === 'object') {
        st.skills = st.skills || {}; const id = clean(body.skills.bot, 64);
        const list = (Array.isArray(body.skills.list) ? body.skills.list : []).map(x => ({ name: clean(x?.name, 40), steps: clean(x?.steps, 3000) })).filter(x => x.name && x.steps).slice(0, 20);
        if (list.length) st.skills[id] = list; else delete st.skills[id];
        await putSettings(db, U, st); await bump(db, U); return J({ ok: true });
      }
      if (body.allow && typeof body.allow === 'object') {   // 一律允許: things a bot may do without asking each time
        const bid = clean(body.allow.bot, 64), list = (Array.isArray(body.allow.list) ? body.allow.list : []).map(x => clean(x, 120)).filter(Boolean).slice(0, 20);
        st.allow = st.allow || {};
        if (list.length) st.allow[bid] = list; else delete st.allow[bid];
        await putSettings(db, U, st);
        await bump(db, U);
        return J({ ok: true });
      }
      if (body.quick && typeof body.quick === 'object') {   // 常用指令 per conversation
        const conv = clean(body.quick.conv, 64), list = (Array.isArray(body.quick.list) ? body.quick.list : []).map(x => clean(x, 300)).filter(Boolean).slice(0, 12);
        st.quick = st.quick || {};
        if (list.length) st.quick[conv] = list; else delete st.quick[conv];
        await putSettings(db, U, st);
        await bump(db, U);
        return J({ ok: true });
      }
      for (const k of ['tg', 'line']) if (body[k]) {
        const cur = st[k] || {};
        const tok = clean(body[k].token, 300);
        if (tok && !tok.startsWith('••••')) cur.token = tok;
        if (body[k].token === '') delete cur.token;
        const dest = clean(body[k][k === 'tg' ? 'chat' : 'to'], 100);
        cur[k === 'tg' ? 'chat' : 'to'] = dest;
        st[k] = cur;
      }
      await putSettings(db, U, st);
      if (body.sched !== undefined) await bump(db, U);
      return J({ ok: true });
    }
    if (path === 'notify/test' && m === 'POST') {
      const sent = await sendNotify(env, await getSettings(db, U), '【OCTA】測試通知：設定成功 ✓');
      return sent.length ? J({ sent }) : err('還沒有設定任何通知管道');
    }
    if (path === 'notify/detect' && m === 'POST') {   // find the Telegram chat id from the latest message sent to the bot
      const st = await getSettings(db, U);
      if (!st.tg?.token) return err('先填 Telegram Bot Token 並儲存');
      const r = await fetch(`https://api.telegram.org/bot${st.tg.token}/getUpdates`).then(x => x.json()).catch(() => null);
      const chat = r?.result?.reverse().find(u => u.message?.chat?.id)?.message.chat.id;
      if (!chat) return err('找不到訊息。請先用 Telegram 傳任何一句話給你的 bot，再按一次');
      st.tg.chat = String(chat);
      await putSettings(db, U, st);
      return J({ chat: String(chat) });
    }
    if (path === 'logs' && m === 'GET') {
      const { bots, groups } = await loadAll(db, U);
      const rows = (await db.prepare("SELECT id,conv,bot_id,prompt,status,kind,url,created,started,finished,err_kind,err_msg,shot,retry_of FROM jobs WHERE user_id=? ORDER BY id DESC LIMIT 100").bind(U).all()).results;
      const retried = new Set(rows.map(r => r.retry_of).filter(Boolean));
      return J({ logs: rows.map(r => ({ ...r, retried: retried.has(r.id), bot: r.kind === 'test' ? 'AI 連線測試：' + r.url : bots.find(b => b.id === r.bot_id)?.name || '已刪除', convName: (bots.find(b => b.id === r.conv) || groups.find(g => g.id === r.conv))?.name || '', prompt: stripRetryNote(r.prompt).slice(0, 80) })) });
    }
    if (path === 'logs/retry' && m === 'POST') {   // 工作紀錄 → 重試: the same job again, from the start
      const j = await db.prepare('SELECT * FROM jobs WHERE id=? AND user_id=?').bind(+body.id, U).first();
      if (!j) return err('找不到這筆紀錄', 404);
      if ((j.kind || 'chat') !== 'chat' || j.status === 'pending' || j.status === 'running') return err('這筆不能重試');
      const { bots } = await loadAll(db, U), b = bots.find(x => x.id === j.bot_id);
      if (!b) return err('機器人已刪除');
      await db.prepare('INSERT INTO jobs (user_id,conv,bot_id,chain,prompt,created,depth,retry_of) VALUES (?,?,?,?,?,?,?,?)').bind(U, j.conv, j.bot_id, j.chain || '[]', stripRetryNote(j.prompt), now(), j.depth || 0, j.id).run();
      await addMsg(db, U, j.conv, 'sys', `從工作紀錄重新執行「${b.name}」的工作`);
      await bump(db, U);
      return ok();
    }
    if (path === 'board' && m === 'GET') return J(await boardData(env, db, U));   // 成果看板: one aggregate over the per-day totals
    if (path === 'review/run' && m === 'POST') return ok({ sent: await weeklyReview(env, db, U, true) });   // 每週自我檢討, now
    if (path.startsWith('shot/') && m === 'GET') {
      const b = await db.prepare('SELECT shot_file FROM bots WHERE id=? AND user_id=?').bind(path.slice(5), U).first();
      if (b?.shot_file) return J({ file: b.shot_file });
      const s = await db.prepare('SELECT mime,data,ts FROM shots WHERE bot_id=? AND user_id=?').bind(path.slice(5), U).first();
      return J(s || {});
    }
    if (path === 'open' && m === 'POST') {
      const { bots, groups } = await loadAll(db, U);
      const bot = bots.find(b => b.id === body.bot);
      const conv = clean(body.conv, 64);
      if (!bot || !(conv === bot.id || groups.some(g => g.id === conv))) return err('找不到機器人', 404);
      let link = clean(body.url, 500), page = '';
      if (body.hide) link = 'octa:hide';   // put the window back in the background
      else if (body.expand) {   // the person asked to see it: open the dock. a bot's own browsing stays a thumbnail
        page = link ? (/^https?:\/\//.test(link) ? link : 'https://' + link) : '';
        link = page ? 'octa:open ' + page : 'octa:open';
      } else if (link && !/^https?:\/\//.test(link)) link = 'https://' + link;
      // a second address typed before the computer picks up the first replaces it, instead of being dropped
      const pending = await db.prepare("SELECT id FROM jobs WHERE user_id=? AND bot_id=? AND kind='open' AND status='pending'").bind(U, bot.id).first();
      await addMsg(db, U, conv, 'sys', body.hide ? `把「${bot.name}」的瀏覽器收到背景` : body.expand ? `打開「${bot.name}」的瀏覽器${page ? '：' + page : ''}` : `在電腦上顯示「${bot.name}」的瀏覽器${link ? '：' + link : ''}`);
      if (pending) {
        await db.prepare('UPDATE jobs SET url=?, conv=?, created=? WHERE id=?').bind(link || null, conv, now(), pending.id).run();
        return J({ ok: true, queued: true });
      }
      await db.prepare("INSERT INTO jobs (user_id,conv,bot_id,chain,prompt,created,kind,url) VALUES (?,?,?,'[]','',?,'open',?)").bind(U, conv, bot.id, now(), link || null).run();
      return ok();
    }
    if (path === 'cancel' && m === 'POST') {
      const conv = clean(body.conv, 64);
      await db.prepare("DELETE FROM jobs WHERE user_id=? AND conv=? AND status='pending'").bind(U, conv).run();
      await db.prepare("UPDATE jobs SET status='error' WHERE user_id=? AND conv=? AND status='running'").bind(U, conv).run();
      await addMsg(db, U, conv, 'sys', '已停止目前的任務');
      return ok();
    }
    if (path === 'runner-token' && m === 'POST') {
      // each computer keeps its own key; making a new one only replaces the key with the same label
      const label = clean(body.label, 60) || 'runner';
      await db.prepare("DELETE FROM sessions WHERE user_id=? AND kind='runner' AND IFNULL(label,'runner')=?").bind(U, label).run();
      return ok({ token: await newSession(db, U, 'runner', label, { ua: clean(body.device, 60) || label }) });
    }

    // ---------- account: devices, computers, password ----------
    if (path === 'devices' && m === 'GET') {
      const rows = (await db.prepare('SELECT token,kind,label,created,seen,ua,ip,place,info FROM sessions WHERE user_id=? ORDER BY IFNULL(seen,created) DESC').bind(U).all()).results;
      const h = env.isLocal ? null : await hostInfo(db, U);
      return J({
        hmode: !!h?.hmode,   // 主機模式: the data is on the host computer
        devices: rows.filter(r => r.kind === 'web').map(r => ({ id: r.token.slice(0, 16), name: r.ua || '裝置', place: r.place || '', created: r.created, seen: r.seen || r.created, current: r.token === me.token })),
        computers: rows.filter(r => r.kind === 'runner').map(r => {
          const info = r.info ? JSON.parse(r.info) : {};
          return { id: r.token.slice(0, 16), name: (r.label || 'runner').replace(/^desktop:/, ''), seen: r.seen || 0, online: now() - (r.seen || 0) < HOST_ONLINE_MS, host: (r.label || 'runner') === h?.hostLabel, version: info.app || info.version || '', engines: info.engines || null, store: info.store || '' };
        })
      });
    }
    if (path === 'devices/remove' && m === 'POST') {   // sign out chosen devices / remove computers (password required)
      const u = await db.prepare('SELECT pw FROM users WHERE id=?').bind(U).first();
      const lim = [['n:' + me.name.toLowerCase(), 5]];
      if (await blocked(db, lim)) return err('密碼錯太多次，請稍後再試', 429);
      if (!(await checkPw(String(body.pw || ''), u?.pw))) { await failed(db, lim); return err('密碼錯誤', 403); }
      const ids = (Array.isArray(body.ids) ? body.ids : []).map(x => clean(x, 16)).filter(x => /^[0-9a-f]{16}$/.test(x));
      if (!ids.length) return err('請選擇裝置');
      for (const id of ids) await db.prepare("DELETE FROM sessions WHERE user_id=? AND substr(token,1,16)=?").bind(U, id).run();
      forgetUser(U); await bump(db, U);
      return J({ ok: true, removed: ids.length });
    }
    if (path === 'host' && m === 'POST') {   // choose which computer runs the bots
      const r = await db.prepare("SELECT label FROM sessions WHERE user_id=? AND kind='runner' AND substr(token,1,16)=?").bind(U, clean(body.id, 16)).first();
      if (!r) return err('找不到這台電腦', 404);
      if (!env.isLocal && (await hostOf(db, U)).hmode === 1) return err('資料存在主機電腦時不能換主機，請先在主機電腦改回存在雲端');
      await db.prepare('UPDATE users SET host=? WHERE id=?').bind(r.label || 'runner', U).run();
      return ok();
    }
    if (path === 'password' && m === 'POST') {
      const pw = String(body.pw || '');
      if (pw.length < 8) return err('新密碼至少 8 碼');
      const u = await db.prepare('SELECT pw FROM users WHERE id=?').bind(U).first();
      const lim = [['n:' + me.name.toLowerCase(), 5]];
      if (await blocked(db, lim)) return err('密碼錯太多次，請稍後再試', 429);
      if (!(await checkPw(String(body.old || ''), u?.pw))) { await failed(db, lim); return err('目前的密碼不對', 403); }
      await db.batch([
        db.prepare('UPDATE users SET pw=? WHERE id=?').bind(await hashPw(pw), U),
        db.prepare("DELETE FROM sessions WHERE user_id=? AND kind='web' AND token<>?").bind(U, me.token || '')   // other devices sign in again
      ]);
      forgetUser(U);
      return J({ ok: true });
    }
    if (path === 'me' && m === 'GET') return J({ id: U, name: me.name });
    if (path === 'ai-usage' && m === 'GET') {   // plan quota reported by the host + how often OCTA used each AI today
      const { date } = localNow(env);
      const dayStart = Date.parse(date + 'T00:00:00Z') - (+env.TZ_OFFSET_MIN || 0) * 60000;
      const rows = (await db.prepare("SELECT b.engine AS e, COUNT(*) AS n FROM jobs j JOIN bots b ON b.id=j.bot_id WHERE j.user_id=? AND j.kind='chat' AND j.created>=? GROUP BY b.engine").bind(U, dayStart).all()).results;
      const h = env.isLocal ? null : await hostInfo(db, U);
      const hostRow = h?.runners.find(r => (r.label || 'runner') === h.hostLabel);
      const usage = env.isLocal ? (await getSettings(db, U))._usage || null : (hostRow?.info ? JSON.parse(hostRow.info).usage || null : null);
      return J({ today: Object.fromEntries(rows.map(r => [r.e || 'claude', r.n])), usage, engines: h ? h.engines : null });
    }
    if (path === 'reset-code' && m === 'POST') return J({ code: await newResetCode(db, U), minutes: 15 });   // shown on a signed-in device

    return err('找不到這個 API', 404);
  } catch (e) {
    return err('伺服器錯誤：' + (e.message || e), 500);
  }
}

async function newResetCode(db, userId) {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789', rnd = crypto.getRandomValues(new Uint8Array(8));
  const code = [...rnd].map(b => chars[b % chars.length]).join('');
  await db.prepare('UPDATE users SET reset=? WHERE id=?').bind(JSON.stringify({ h: await sha(code), exp: now() + 15 * MIN }), userId).run();
  return code;
}

// what the host computer should do next: a job (if it has a free slot), uploads to save, files to send
// what a computer on standby should do: send files that live on it, jobs addressed to it
async function pcWork(env, db, U, label, slots) {
  const pull = (await db.prepare("SELECT id,path FROM files WHERE user_id=? AND loc='pc' AND want>? AND pc=? LIMIT 10").bind(U, now() - MIN, label).all()).results;
  let job = null;
  if (slots > 0) {
    const j = await db.prepare("SELECT * FROM jobs WHERE user_id=? AND status='pending' AND pc=? AND kind='export' ORDER BY id LIMIT 1").bind(U, label).first();
    if (j && (await db.prepare("UPDATE jobs SET status='running', started=? WHERE id=? AND status='pending'").bind(now(), j.id).run()).meta.changes) job = await jobPayload(env, db, U, j);
  }
  return job || pull.length ? { job, inbox: [], pull } : null;
}
async function nextWork(env, db, U, slots, label = null) {
  // files that live on another computer are sent by that computer
  const files = (await db.prepare("SELECT id,name,mime,conv,loc,path FROM files WHERE user_id=? AND ((loc='cloud' AND conv IS NOT NULL) OR (loc='pc' AND want>? AND (pc IS NULL OR pc=? OR ? IS NULL))) LIMIT 10").bind(U, now() - MIN, label, label).all()).results;
  const inbox = files.filter(f => f.loc === 'cloud').map(f => ({ id: f.id, name: f.name, conv: f.conv }));
  const pull = files.filter(f => f.loc === 'pc').map(f => ({ id: f.id, path: f.path }));
  let job = null;
  if (slots > 0) {
    // one task per bot at a time; showing its browser on screen ('open') never waits
    const j = await db.prepare(`SELECT * FROM jobs j WHERE user_id=? AND status='pending' AND (j.pc IS NULL OR j.pc=?)
      AND (j.kind='open' OR NOT EXISTS (SELECT 1 FROM jobs r WHERE r.user_id=j.user_id AND r.bot_id=j.bot_id AND r.status='running' AND r.kind<>'open'))
      ORDER BY (j.kind='open') DESC, id LIMIT 1`).bind(U, label || '').first();
    if (j) {
      const claimed = await db.prepare("UPDATE jobs SET status='running', started=? WHERE id=? AND status='pending'").bind(now(), j.id).run();
      if (claimed.meta.changes) { await bump(db, U); job = await jobPayload(env, db, U, j); }
    }
  }
  if (!job && !inbox.length && !pull.length) return null;
  const all = (inbox.length || job) ? await loadAll(db, U) : null;
  const convName = id => (all?.bots.find(b => b.id === id) || all?.groups.find(g => g.id === id))?.name || '';
  return { job, inbox: inbox.map(f => ({ ...f, convName: convName(f.conv) })), pull };
}
async function jobPayload(env, db, U, job) {
  if (job.kind === 'code') {
    const task = await db.prepare('SELECT * FROM code_tasks WHERE id=? AND user_id=?').bind(job.url, U).first();
    const repo = task && await db.prepare('SELECT * FROM code_repos WHERE id=? AND user_id=?').bind(task.repo_id, U).first();
    if (!task || !repo) { await db.prepare("UPDATE jobs SET status='error', finished=? WHERE id=?").bind(now(), job.id).run(); return null; }
    if (task.cancel) { await db.prepare("UPDATE jobs SET status='error', finished=? WHERE id=?").bind(now(), job.id).run(); await db.prepare("UPDATE code_tasks SET status='cancelled', phase='cancelled', finished=? WHERE id=?").bind(now(), task.id).run(); return null; }
    return { id: job.id, kind: 'code', task: publicCodeTask(task), repo: { id: repo.id, name: repo.name, path: repo.path } };
  }
  if (job.kind === 'test') return { id: job.id, kind: 'test', engine: engineOk(job.url), prompt: job.prompt };
  if (job.kind === 'list') return { id: job.id, kind: 'list', what: job.url };
  if (job.kind === 'install') return { id: job.id, kind: 'install', engine: engineOk(job.url) };
  if (job.kind === 'export' || job.kind === 'import') {
    const b = await db.prepare('SELECT id,name,browser FROM bots WHERE id=? AND user_id=?').bind(job.bot_id, U).first();
    if (!b) { await db.prepare("UPDATE jobs SET status='error' WHERE id=?").bind(job.id).run(); return null; }
    const st = await getSettings(db, U);
    return { id: job.id, kind: job.kind, shareBrowser: st.shareBrowser !== false, bot: { id: b.id, name: b.name, browser: 'own' }, xfer: job.kind === 'import' ? job.url : undefined };
  }
  const { bots, groups, folders } = await loadAll(db, U);
  const name = id => id === 'me' ? '使用者' : id === 'sys' ? '系統' : (bots.find(b => b.id === id)?.name || '已刪除的機器人');
  const bot = bots.find(b => b.id === job.bot_id);
  if (!bot) { await db.prepare("UPDATE jobs SET status='error' WHERE id=?").bind(job.id).run(); return null; }
  const group = groups.find(g => g.id === job.conv);
  const conv = group || bot;
  const hist = (await db.prepare('SELECT id,by_,text,files,reply FROM messages WHERE user_id=? AND conv=? ORDER BY id DESC LIMIT 30').bind(U, job.conv).all()).results.reverse();
  const seen = new Map(hist.map(h => [h.id, h]));
  const missing = [...new Set(hist.map(h => h.reply).filter(id => id && !seen.has(id)))];
  if (missing.length) {
    const more = (await db.prepare(`SELECT id, by_, text FROM messages WHERE user_id=? AND conv=? AND id IN (${missing.map(() => '?').join(',')})`).bind(U, job.conv, ...missing).all()).results;
    for (const row of more) seen.set(row.id, row);
  }
  const fileIds = [...new Set(hist.flatMap(h => (h.files ? JSON.parse(h.files) : []).map(f => f.id)))];
  const where = fileIds.length ? (await db.prepare(`SELECT id,path FROM files WHERE user_id=? AND id IN (${fileIds.map(() => '?').join(',')})`).bind(U, ...fileIds).all()).results : [];
  const pathOf = id => where.find(w => w.id === id)?.path || null;
  const st = await getSettings(db, U);
  // its AI ran out of quota recently: start straight on the first backup that still has some
  if (!job.eng && job.kind === 'chat' && bot.fb?.length) {
    const sp = st.spent || {}, list = [bot.engine + (bot.model ? '|' + bot.model : ''), ...bot.fb];
    if (sp[list[0]] > now()) { const alt = list.find(x => !(sp[x] > now())); if (alt) { job.eng = alt; await db.prepare('UPDATE jobs SET eng=? WHERE id=?').bind(alt, job.id).run(); } }
  }
  const { date } = localNow(env);   // how many jobs this AI already ran today, so the bot can tell the user
  const dayStart = Date.parse(date + 'T00:00:00Z') - (+env.TZ_OFFSET_MIN || 0) * 60000;
  const usageToday = (await db.prepare("SELECT COUNT(*) AS n FROM jobs j JOIN bots b ON b.id=j.bot_id WHERE j.user_id=? AND j.kind='chat' AND j.created>=? AND IFNULL(b.engine,'claude')=?").bind(U, dayStart, bot.engine || 'claude').first())?.n ?? null;
  // 規則／事實 capped (newest kept), and only the 做事手冊 that look like this task; a used manual counts toward "most used"
  const mem = memoryFor(st, bot.id, job.kind === 'chat' ? job.prompt : '');
  if (mem.manuals.length) {
    for (const m of (st.manuals || {})[bot.id] || []) if (mem.manuals.some(x => x.name === m.name)) m.used = (+m.used || 0) + 1;
    await putSettings(db, U, st);
  }
  return {
    id: job.id, kind: job.kind, url: job.url, prompt: job.kind === 'chat' && /例行|排程|定時|刪|停用|暫停|取消/.test(job.prompt || '') ? job.prompt + ROUTINE_SELF : job.prompt, usageToday, warm: WARM.includes(+st.warm) ? +st.warm : 120, allowed: (st.allow || {})[bot.id] || [], ...mem, skills: (st.skills || {})[bot.id] || [],
    nskills: (st.nskills || {})[bot.id] || null,
    routines: (await db.prepare('SELECT name,times,enabled FROM routines WHERE user_id=? AND conv IN (?,?)').bind(U, job.conv, bot.id).all()).results.map(r => ({ name: r.name, times: JSON.parse(r.times), enabled: !!r.enabled })),
    routeTries: +job.tries || 0,
    canAsk: job.depth < MAX_ASK_DEPTH,
    conv: { id: conv.id, name: conv.name },
    shareBrowser: st.shareBrowser !== false,
    backup: !!(job.eng && job.eng !== ((bot.engine || 'claude') + (bot.model ? '|' + bot.model : ''))),
    bot: { id: bot.id, name: bot.name, task: bot.task, page: bot.page, engine: (job.eng ? job.eng.split('|')[0] : bot.engine) || 'claude', model: job.eng ? job.eng.split('|')[1] || '' : bot.model || '', browser: bot.browser === 'mine' ? 'mine' : 'own', autonomy: autonomyOk(bot.autonomy) },
    folder: folders.find(f => f.id === bot.folder)?.name || null,
    folderNotes: folders.find(f => f.id === bot.folder)?.notes || '',
    notes: st.notes || '',
    nick: st.nick || '',
    sites: Object.entries(st.sites || {}).map(([d, l]) => `${d}：\n` + l.map(x => '- ' + x).join('\n')).join('\n').slice(-6000),
    lang: st.lang || 'zh-TW',
    connectors: publicConnectors(st),
    colleagues: bots.filter(b => b.id !== bot.id).sort((a, b) => ((a.folder || null) === (bot.folder || null) ? 0 : 1) - ((b.folder || null) === (bot.folder || null) ? 0 : 1)).slice(0, 20).map(b => ({ id: b.id, name: b.name, task: b.task })),
    group: group ? { name: group.name, task: group.task, members: group.members.map(name), mode: turnsOf(group) ? 'turns' : 'parallel' } : null,
    history: hist.map(h => {
      const q = h.reply ? seen.get(h.reply) : null;
      return { id: h.id, who: name(h.by_), text: h.text, replyWho: q ? name(q.by_) : '', replyText: q ? String(q.text || '').replace(/\s+/g, ' ').trim().slice(0, 160) : '', files: (h.files ? JSON.parse(h.files) : []).map(f => ({ ...f, path: pathOf(f.id) })) };
    })
  };
}

// ---------- 記憶分層（規則／事實／做事手冊）、每週自我檢討、成果看板 ----------
// st.memory = 規則 (📌), st.facts = 事實 (📇), st.manuals = 做事手冊 (📘 {name, steps, ts, used}); all per bot id
const MEM_KEYS = { rule: 'memory', fact: 'facts', manual: 'manuals' };
const MEM_CAP = { rule: { n: 30, chars: 3000 }, fact: { n: 40, chars: 3000 }, manual: { n: 2, chars: 1500 } };
const MANUAL_MAX = 20;
// the newest items that fit both limits (older ones stay saved, they just aren't sent)
export function capList(list, n, chars) {
  const out = []; let len = 0;
  for (let i = (list || []).length - 1; i >= 0 && out.length < n; i--) {
    const v = String(list[i] ?? ''); if (!v) continue;
    if (len + v.length > chars) break;
    len += v.length; out.unshift(v);
  }
  return out;
}
// words of a name: latin words and CJK pairs ("訂房報表" → 訂房, 房報, 報表)
const kwOf = s => {
  const t = String(s || '').toLowerCase(), out = new Set();
  for (const w of t.match(/[a-z0-9]{3,}/g) || []) out.add(w);
  for (const run of t.match(/[㐀-鿿豈-﫿]+/g) || []) {
    if (run.length === 1) out.add(run);
    for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2));
  }
  return [...out];
};
export function manualScore(m, prompt) {
  const p = String(prompt || '').toLowerCase(), name = String(m?.name || '').toLowerCase().trim();
  if (!name || !p) return 0;
  if (p.includes(name)) return 100;
  const kw = kwOf(name); if (!kw.length) return 0;
  const hits = kw.filter(k => p.includes(k)).length;
  return hits >= 2 && hits / kw.length >= 0.4 ? Math.round(hits / kw.length * 50) : 0;
}
// the manuals that look like this task: best match first, then the most used, then the newest
export function pickManuals(list, prompt, max = MEM_CAP.manual.n) {
  return (list || []).map(m => ({ m, s: manualScore(m, prompt) })).filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s || (+b.m.used || 0) - (+a.m.used || 0) || (+b.m.ts || 0) - (+a.m.ts || 0))
    .slice(0, max).map(x => x.m);
}
export function memoryFor(st, botId, prompt) {
  const manuals = pickManuals((st.manuals || {})[botId], prompt).map(m => ({ name: m.name, steps: String(m.steps || '').slice(0, MEM_CAP.manual.chars) }));
  return {
    memory: capList((st.memory || {})[botId], MEM_CAP.rule.n, MEM_CAP.rule.chars),
    facts: capList((st.facts || {})[botId], MEM_CAP.fact.n, MEM_CAP.fact.chars),
    manuals
  };
}
const stepCount = s => String(s || '').split(/\s*(?:→|->|⇒|\n|；|;|(?:^|\s)\d+[.)、]\s*)\s*/).map(x => x.trim()).filter(Boolean).length;
// 📘手冊：名稱｜步驟 → 步驟 → 步驟   or   📘手冊：名稱 (newline) steps… 📘結束
export function parseManuals(text) {
  const found = [];
  let t = String(text || '').replace(/📘\s*手冊[:：]\s*([^\n｜|]+)\n([\s\S]*?)📘\s*結束/g, (_, n, s) => { found.push({ name: clean(n, 40), steps: clean(s, 1500) }); return ''; });
  t = t.replace(/^\s*📘\s*手冊[:：]\s*([^｜|\n]+?)\s*[｜|]\s*(.+)$/gm, (_, n, s) => { found.push({ name: clean(n, 40), steps: clean(s, 1500) }); return ''; });
  return { text: t, manuals: found.filter(m => m.name && m.steps && stepCount(m.steps) >= 3) };
}
export function saveManuals(cur, add, t = now()) {
  const keep = (cur || []).filter(x => !add.some(n => n.name === x.name));
  const merged = [...keep, ...add.map(n => ({ name: n.name, steps: n.steps, ts: t, used: (cur || []).find(x => x.name === n.name)?.used || 0 }))];
  if (merged.length <= MANUAL_MAX) return merged;
  const drop = new Set([...merged].sort((a, b) => (+a.used || 0) - (+b.used || 0) || (+a.ts || 0) - (+b.ts || 0)).slice(0, merged.length - MANUAL_MAX));
  return merged.filter(x => !drop.has(x));
}
// ✅待確認：更新規則：新增：…；修改：舊 → 新；刪除：…  — applied only when the user presses 核准
export function applyRuleUpdates(list, spec) {
  const rules = [...(list || [])], done = [];
  const same = (a, b) => a === b || (b.length >= 4 && a.includes(b)) || (a.length >= 4 && b.includes(a));
  for (let item of String(spec || '').split(/[；;\n]+/)) {
    item = item.replace(/^\s*(?:[①-⑩]|\d+[.)、]|[-•·])\s*/, '').trim();
    if (!item) continue;
    let mm;
    if ((mm = item.match(/^修改[:：]\s*(.+?)\s*(?:→|->|=>|⇒)\s*(.+)$/))) {
      const from = clean(mm[1], 300), to = clean(mm[2], 300), i = rules.findIndex(r => same(r, from));
      if (i >= 0) rules[i] = to; else rules.push(to);
      done.push('修改：' + to);
    } else if ((mm = item.match(/^刪除[:：]\s*(.+)$/))) {
      const v = clean(mm[1], 300), i = rules.findIndex(r => same(r, v));
      if (i >= 0) { rules.splice(i, 1); done.push('刪除：' + v); }
    } else {
      const v = clean(item.replace(/^新增[:：]\s*/, ''), 300);
      if (v && !rules.includes(v)) { rules.push(v); done.push('新增：' + v); }
    }
  }
  return { rules: rules.slice(-40), done };
}
const REVIEW_NAME = '每週自我檢討';
const REVIEW_TAG = `（例行任務「${REVIEW_NAME}」）`;
const reviewLooked = new Map();   // per isolate: look at most once an hour per account
// once a week, for each bot that had work: its failures and corrections → suggested rules, sent as ✅待確認
async function weeklyReview(env, db, U, force = false) {
  if (!force) {
    if (now() - (reviewLooked.get(U) || 0) < 60 * MIN) return 0;
    reviewLooked.set(U, now());
  }
  const st = await getSettings(db, U);
  if (st.review === false && !force) return 0;
  if (!force && !st.reviewAt) { st.reviewAt = now(); await putSettings(db, U, st); return 0; }   // the first week starts at the first look
  if (!force && (now() - st.reviewAt < 7 * DAY || localNow(env).hm < '09:00')) return 0;
  st.reviewAt = now(); await putSettings(db, U, st);
  const since = now() - 7 * DAY;
  const [rows, worked] = await db.batch([
    // only the last 7 days of rows are read: the id bound comes from the newest older message
    db.prepare("SELECT conv, by_, text FROM messages WHERE user_id=?1 AND id>IFNULL((SELECT id FROM messages WHERE user_id=?1 AND ts<?2 ORDER BY id DESC LIMIT 1),0) AND ((by_ NOT IN ('sys','me') AND text LIKE '⚠%') OR (by_='sys' AND text LIKE '已記住：%')) ORDER BY id DESC LIMIT 400").bind(U, since),
    db.prepare("SELECT bot_id, COUNT(*) AS n FROM jobs WHERE user_id=? AND created>=? AND kind='chat' AND prompt NOT LIKE ? GROUP BY bot_id").bind(U, since, REVIEW_TAG + '%')
  ]);
  const { bots } = await loadAll(db, U);
  let n = 0;
  for (const b of bots) {
    if (!worked.results.some(w => w.bot_id === b.id)) continue;
    const fails = rows.results.filter(r => r.by_ === b.id).map(r => clean(r.text, 200)).slice(0, 8);
    const fixes = rows.results.filter(r => r.by_ === 'sys' && r.conv === b.id).map(r => clean(r.text.replace(/^已記住：/, ''), 200)).slice(0, 10);
    if (!fails.length && !fixes.length) continue;   // nothing to learn from: say nothing
    const rules = (st.memory || {})[b.id] || [];
    await addJob(db, U, b.id, [b.id], `${REVIEW_TAG}回顧你過去 7 天的工作，想想要新增或修改哪些規則，下次才不會再犯。\n` +
      (fails.length ? `失敗或出錯的回覆：\n${fails.map(x => '- ' + x).join('\n')}\n` : '') +
      (fixes.length ? `使用者糾正後記下的事：\n${fixes.map(x => '- ' + x).join('\n')}\n` : '') +
      `你目前的規則：\n${rules.length ? rules.map(x => '- ' + x).join('\n') : '（沒有）'}\n\n` +
      '最多提 3 條，每條一句話、具體可照做；跟現有規則重複的不要提，舊規則寫得不好就用修改。不要寫 📌記住，也不要開瀏覽器或做其他事。' +
      '沒有值得改的就整則只回「（略過）」。有的話，先用一兩句說明為什麼，最後單獨一行照這個格式寫（「✅待確認：更新規則：」照抄）：\n' +
      '✅待確認：更新規則：新增：規則內容；修改：舊規則 → 新規則');
    n++;
  }
  if (n) await bump(db, U);
  return n;
}
// ✅待確認 nobody answered for 15 minutes: one more Telegram / LINE message, once per card
// (評論：「核准框有時候沒人看到，接班人就一直卡著」). Looked at from runner/next, at most once a minute per account.
const NAG_MS = 15 * MIN, nagLooked = new Map();
async function pendingApprovals(db, U, olderThan = 0) {
  const rows = (await db.prepare("SELECT m.id, m.conv, m.by_ AS by, m.text, m.ts FROM messages m WHERE m.user_id=?1 AND m.id>IFNULL((SELECT id FROM messages WHERE user_id=?1 AND ts<?2 ORDER BY id DESC LIMIT 1),0) AND m.by_ NOT IN ('me','sys') AND m.ts<=?3 AND instr(m.text,'待確認')>0 AND NOT EXISTS (SELECT 1 FROM messages x WHERE x.user_id=?1 AND x.conv=m.conv AND x.id>m.id AND (x.by_='me' OR x.by_=m.by_)) ORDER BY m.id DESC LIMIT 20")
    .bind(U, now() - DAY, now() - olderThan).all()).results;
  return rows.map(r => ({ ...r, act: (String(r.text).match(/^✅\s*待確認[:：]\s*(.+)$/m) || [])[1] })).filter(r => r.act);
}
async function approvalNag(env, db, U, force = false) {
  if (!force && now() - (nagLooked.get(U) || 0) < MIN) return 0;
  nagLooked.set(U, now());
  const waiting = await pendingApprovals(db, U, NAG_MS);
  if (!waiting.length) return 0;
  const st = await getSettings(db, U);
  const told = new Set(st.nagged || []), fresh = waiting.filter(r => !told.has(r.id) && !(st.mute || {})[r.conv]);
  if (!fresh.length) return 0;
  const { bots, groups } = await loadAll(db, U);
  const nm = id => bots.find(b => b.id === id)?.name || groups.find(g => g.id === id)?.name || '機器人';
  const lines = fresh.slice(0, 5).map(r => `・${nm(r.by)}${r.conv !== r.by ? `（${nm(r.conv)}）` : ''}：${clean(r.act, 120)}（等了 ${Math.round((now() - r.ts) / MIN)} 分鐘）`);
  await sendNotify(env, st, `【OCTA】還有 ${fresh.length} 件等你核准，機器人停在這裡：\n${lines.join('\n')}\n打開 OCTA，清單最上面就是。`);
  st.nagged = [...fresh.map(r => r.id), ...(st.nagged || [])].slice(0, 100);
  await putSettings(db, U, st);
  return fresh.length;
}
// 成果看板: one row per bot per day, added to when a chat job ends (jobs themselves are kept only 14 days)
async function statAdd(db, env, U, job, good, tokens, web) {
  if (String(job.prompt || '').startsWith(REVIEW_TAG)) return;
  const ms = good && job.started ? Math.max(0, now() - job.started) : 0;
  try {
    await db.prepare('INSERT INTO stats (user_id,bot_id,day,done,failed,ms,timed,tokens,web) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,bot_id,day) DO UPDATE SET done=done+excluded.done, failed=failed+excluded.failed, ms=ms+excluded.ms, timed=timed+excluded.timed, tokens=tokens+excluded.tokens, web=web+excluded.web')
      .bind(U, job.bot_id, localNow(env).date, good ? 1 : 0, good ? 0 : 1, ms, ms ? 1 : 0, Math.max(0, +tokens || 0), good && web ? 1 : 0).run();
  } catch { }
}
const SAVED_MIN = { task: 5, web: 10 };   // 估計：每件完成的工作省 5 分鐘，用到瀏覽器的再加 10 分鐘
async function boardData(env, db, U) {
  const d7 = localNow(env, now() - 6 * DAY).date, d30 = localNow(env, now() - 29 * DAY).date;
  const w = c => `SUM(CASE WHEN day>=?1 THEN ${c} ELSE 0 END)`;
  const rows = (await db.prepare(`SELECT bot_id, ${w('done')} AS wd, ${w('failed')} AS wf, ${w('ms')} AS wms, ${w('timed')} AS wt, ${w('tokens')} AS wtk, ${w('web')} AS ww, SUM(done) AS md, SUM(failed) AS mf, SUM(ms) AS mms, SUM(timed) AS mt, SUM(tokens) AS mtk, SUM(web) AS mw FROM stats WHERE user_id=?2 AND day>=?3 GROUP BY bot_id`).bind(d7, U, d30).all()).results;
  const { bots } = await loadAll(db, U);
  const pack = (d, f, ms, t, tk, wb) => ({ done: +d || 0, failed: +f || 0, rate: (+d || 0) + (+f || 0) ? Math.round((+d || 0) / ((+d || 0) + (+f || 0)) * 100) : null, avgSec: +t ? Math.round(+ms / +t / 1000) : null, tokens: +tk || 0, savedMin: (+d || 0) * SAVED_MIN.task + (+wb || 0) * SAVED_MIN.web });
  return {
    since: { d7, d30 }, est: SAVED_MIN,
    bots: bots.map(b => { const r = rows.find(x => x.bot_id === b.id) || {}; return { id: b.id, name: b.name, avatar: b.avatar, d7: pack(r.wd, r.wf, r.wms, r.wt, r.wtk, r.ww), d30: pack(r.md, r.mf, r.mms, r.mt, r.mtk, r.mw) }; })
  };
}
