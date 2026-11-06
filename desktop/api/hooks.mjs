// 4.5 交接網址: /api/hook/<token>[/…] — another AI (e.g. Grok Bot, working on xAI's cloud computer) hands work to an
// OCTA bot, reads the result, corrects it and teaches it. The token is a routine's hook key (例行任務 → 外部事件, or
// the 外部交接 routine made from AI 連線 / 詳細資料); it names that routine's bot or group and works like a password.
// Reached on this computer's tunnel, and from https://octa.yzprojecttw.com/api/hook/<token>/… through the stateless
// forwarder on the OCTA site (legacy/hook-relay.mjs), which finds the tunnel through ntfy.sh (desktop/host-link.mjs).
//
//   POST hook/<t>                {text, from}   → {ok, job}            new work (a body without `text`: an event, as before)
//   GET  hook/<t>                               → {ok, routine}        lets a service check the address
//   GET  hook/<t>/job/<id>                      → {ok, job, status: running|done|failed, queued?, text, files}
//   GET  hook/<t>/inbox[?peek=1]                → {ok, jobs: [...]}    finished work this token hasn't read yet (marked read)
//   POST hook/<t>/feedback       {job, text}    → {ok, job}            redo with the correction (new job)
//   POST hook/<t>/teach          {text, name?}  → {ok, saved}          into the bot's 📌 rules (📘 manual with a name and steps)
// 4.14: a Grok Bot（雲端）bot's reply token (not a routine's) answers only reply / progress / file/<id> (grokcloud.mjs);
// those three answer 404 for a routine's token.
// A missing or wrong token always gets 401 with the same body, whatever the path.
import { gcByToken, gcHookRoute } from './grokcloud.mjs';
import { addJob, addMsg, blocked, bump, failed, getSettings, loadAll, putSettings } from './db.mjs';
import { saveManuals } from './memory.mjs';
import { noteSrc } from './memory-edit.mjs';
import { describeEvent, fireEvent, routinePrompt, routineTarget } from './routines.mjs';
import { correctionAsk } from './schedule.mjs';
import { DAY, MIN, clean, now } from './util.mjs';

export const HOOK_CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization',
  'access-control-max-age': '600'
};
const HJ = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...HOOK_CORS }
  });
export const BAD_TOKEN = { error: '交接網址不正確' }; // the same body the OCTA site's forwarder answers with
export const HOOK_MAX_BODY = 64 * 1024;
const WRITES_PER_15MIN = 120, // new work, feedback, teach and events, per token (stored, like before)
  READS_PER_15MIN = 900, // status and inbox polls, per token (kept in memory)
  BAD_PER_15MIN = 300; // wrong tokens, all together
const TEXT_MAX = 8000;

// constant-time comparison of two strings of the same kind (the tokens are 48 hex characters)
export function sameToken(a, b) {
  a = String(a || '');
  b = String(b || '');
  let d = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0 && a.length > 0;
}
async function routineOf(db, token) {
  if (!/^[0-9a-f]{48}$/.test(token)) return null;
  const rows = (await db.prepare('SELECT id, hook FROM routines WHERE hook IS NOT NULL').all()).results;
  let hit = null;
  for (const r of rows) if (sameToken(r.hook, token) && !hit) hit = r.id; // every row is compared
  return hit ? db.prepare('SELECT * FROM routines WHERE id=?').bind(hit).first() : null;
}

// in-memory windows: { key → [count, until] }
const windows = new Map();
function over(key, max) {
  const t = now(),
    w = windows.get(key);
  if (!w || w[1] < t) {
    if (windows.size > 5000) windows.clear();
    windows.set(key, [1, t + 15 * MIN]);
    return false;
  }
  return ++w[0] > max;
}

const newHookId = () => 'h' + [...crypto.getRandomValues(new Uint8Array(10))].map(b => b.toString(16).padStart(2, '0')).join('');
const fromName = v => clean(String(v ?? '').replace(/[\r\n]+/g, ' '), 40) || '外部 AI';

// where a token's work runs and who it is: the routine's bot, or its group (members in order)
async function targetOf(db, r) {
  const all = await loadAll(db, r.user_id);
  const to = routineTarget(all, r);
  if (!to) return null;
  return { ...to, all, bots: to.chain.map(id => all.bots.find(b => b.id === id)).filter(Boolean) };
}

// one piece of 交接網址 work as the caller sees it: the jobs that carry its id (the first, retries, the chain's steps)
export async function hookStatus(db, h) {
  const jobs = (
    await db
      .prepare('SELECT id,bot_id,status,result,outs,chain,started,finished,err_msg FROM jobs WHERE user_id=? AND hook=? ORDER BY id')
      .bind(h.user_id, h.id)
      .all()
  ).results;
  const out = { job: h.id, from: h.from_ || '', created: h.created, ...(h.parent ? { redo: h.parent } : {}) };
  if (!jobs.length) return { ...out, status: 'failed', text: '這件工作已經取消（在 OCTA 上被停止或清除）', files: [] };
  const open = jobs.filter(j => j.status === 'pending' || j.status === 'running');
  const last = jobs[jobs.length - 1];
  // a step that just ended with more steps after it: the next one is about to be queued
  const nextStep = last.status === 'done' && JSON.parse(last.chain || '[]').length && now() - (last.finished || 0) < 60000;
  if (open.length || nextStep) {
    const queued = !jobs.some(j => j.started && j.status === 'running') && open.every(j => j.status === 'pending');
    return { ...out, status: 'running', ...(queued ? { queued: true } : {}), text: '', files: [] };
  }
  const { bots } = await loadAll(db, h.user_id);
  const name = id => bots.find(b => b.id === id)?.name || '';
  const files = [];
  for (const j of jobs) for (const f of JSON.parse(j.outs || '[]')) files.push({ id: f.id, name: f.name });
  if (last.status !== 'done') return { ...out, status: 'failed', text: clean(last.result || last.err_msg || '執行失敗', TEXT_MAX), files, finished: last.finished };
  // done: every reply, in order (a group's members each answer; a failed try that was retried is left out)
  const done = jobs.filter(j => j.status === 'done' && String(j.result || '').trim());
  const many = new Set(done.map(j => j.bot_id)).size > 1;
  const text = done.map(j => (many ? `【${name(j.bot_id)}】\n` : '') + String(j.result).trim()).join('\n\n');
  return { ...out, status: 'done', text: clean(text || '（完成，沒有回覆內容）', TEXT_MAX), files, finished: last.finished };
}

// a new piece of work for the token's bot (or group): its own job, shown in the work panel (not the chat) until the
// bot's reply, which goes to the chat as any other routine's reply
async function startWork(env, db, r, to, { text, from, parent = null, prompt }) {
  const id = newHookId();
  await db
    .prepare('INSERT INTO hook_jobs (id,user_id,routine,conv,from_,text,parent,created) VALUES (?,?,?,?,?,?,?,?)')
    .bind(id, r.user_id, r.id, to.conv, from, text, parent, now())
    .run();
  await db.prepare('DELETE FROM hook_jobs WHERE user_id=? AND created<?').bind(r.user_id, now() - 30 * DAY).run();
  await addJob(db, r.user_id, to.conv, to.chain, prompt.slice(0, 20000), 0, r.id, id);
  await db
    .prepare('UPDATE routines SET last_run=?, last_status=NULL, last_job=NULL, last_text=NULL WHERE id=?')
    .bind(now(), r.id)
    .run();
  return id;
}
const head = (r, to) => routinePrompt(r, { event: true, group: to.conv !== r.conv ? to.name : '' });

export async function hookRoute({ req, env, db, path, m, url, body, rawBody }) {
  if (m === 'OPTIONS') return new Response(null, { status: 204, headers: HOOK_CORS });
  const [, token = '', ...restParts] = path.split('/');
  const rest = restParts.join('/');
  const bad = () => (over('bad', BAD_PER_15MIN) ? HJ({ error: '嘗試太多次，請稍後再試' }, 429) : HJ(BAD_TOKEN, 401));
  const r = await routineOf(db, token);
  if (!r) {
    const g = await gcByToken(db, token);
    if (!g) return bad();
    // a Bearer header, when sent, must be the same token (Grok Bot is told to send it; the OCTA site passes it on)
    const auth = req?.headers?.get?.('authorization') || '';
    if (auth && !sameToken(auth.replace(/^Bearer\s+/i, '').trim(), token)) return bad();
    if ((rawBody || '').length > HOOK_MAX_BODY) return HJ({ error: '內容太大（上限 64 KB）' }, 413);
    return gcHookRoute({ env, db, m, url, body, rest, g, cors: HOOK_CORS, bad });
  }
  if ((rawBody || '').length > HOOK_MAX_BODY) return HJ({ error: '內容太大（上限 64 KB）' }, 413);
  if (rest === 'reply' || rest === 'progress' || rest.startsWith('file/')) return HJ({ ok: false, error: '找不到這個功能' }, 404);
  const U = r.user_id,
    key = r.hook;
  const write = async () => {
    const lim = [['hook:' + key, WRITES_PER_15MIN]];
    if (await blocked(db, lim)) return HJ({ ok: false, error: '太多次了，15 分鐘內最多 ' + WRITES_PER_15MIN + ' 次' }, 429);
    await failed(db, lim); // counts per 15 minutes
    return null;
  };
  const read = () => (over('read:' + key, READS_PER_15MIN) ? HJ({ ok: false, error: '查詢太頻繁，請放慢一點' }, 429) : null);
  const textOf = v => clean(typeof v === 'string' ? v : '', TEXT_MAX);

  // ---------- the address itself: check, new work, or an event (LINE, forms, Zapier…) ----------
  if (!rest) {
    if (m === 'GET') return HJ({ ok: true, routine: r.name });
    if (m !== 'POST') return HJ({ error: '只接受 GET 或 POST' }, 405);
    const text = !Array.isArray(body.events) ? textOf(body.text) : '';
    if (!text) {
      // as before 4.5: anything posted starts the routine with what came in
      if (!r.enabled) return HJ({ ok: true, skipped: 'disabled' });
      if (Array.isArray(body.events) && !body.events.length) return HJ({ ok: true }); // LINE "Verify" sends no events
      const stop = await write();
      if (stop) return stop;
      return HJ({ ok: true, result: await fireEvent(env, db, r, describeEvent(rawBody || '', body) || '（沒有內容）') });
    }
    if (!r.enabled) return HJ({ ok: false, error: '這個交接網址已暫停（在 OCTA 的例行任務裡關掉了）' }, 409);
    const stop = await write();
    if (stop) return stop;
    const to = await targetOf(db, r);
    if (!to?.bots.length) return HJ({ ok: false, error: '接這個網址的機器人已經刪除' }, 410);
    const from = fromName(body.from);
    const id = await startWork(env, db, r, to, {
      text,
      from,
      prompt: `${head(r, to)}\n\n來自「${from}」的工作（經交接網址，你的回覆會自動傳回給${from}）：\n${text}`
    });
    await addMsg(db, U, to.conv, 'sys', `📨 來自 ${from}：${text.slice(0, 300)}`, null, null, 'bg');
    await bump(db, U);
    return HJ({ ok: true, job: id });
  }

  // ---------- one piece of work ----------
  const jm = rest.match(/^job\/(h[0-9a-f]{20})$/);
  if (jm || rest.startsWith('job/')) {
    if (m !== 'GET') return HJ({ error: '只接受 GET' }, 405);
    const stop = read();
    if (stop) return stop;
    const h = jm ? await db.prepare('SELECT * FROM hook_jobs WHERE id=? AND routine=?').bind(jm[1], r.id).first() : null;
    if (!h) return HJ({ ok: false, error: '找不到這件工作' }, 404);
    const s = await hookStatus(db, h);
    // the caller has the result now: it won't come again in the inbox (unless ?peek=1)
    if (s.status !== 'running' && !h.seen && url.searchParams.get('peek') !== '1')
      await db.prepare('UPDATE hook_jobs SET seen=? WHERE id=?').bind(now(), h.id).run();
    return HJ({ ok: true, ...s });
  }

  // ---------- finished work this token hasn't read ----------
  if (rest === 'inbox') {
    if (m !== 'GET') return HJ({ error: '只接受 GET' }, 405);
    const stop = read();
    if (stop) return stop;
    const rows = (
      await db
        .prepare('SELECT * FROM hook_jobs WHERE routine=? AND seen IS NULL AND created>? ORDER BY created LIMIT 50')
        .bind(r.id, now() - 14 * DAY)
        .all()
    ).results;
    const jobs = [];
    for (const h of rows) {
      const s = await hookStatus(db, h);
      if (s.status !== 'running') jobs.push(s);
    }
    if (jobs.length && url.searchParams.get('peek') !== '1') {
      const t = now();
      for (const s of jobs) await db.prepare('UPDATE hook_jobs SET seen=? WHERE id=?').bind(t, s.job).run();
    }
    return HJ({ ok: true, jobs });
  }

  // ---------- redo with a correction ----------
  if (rest === 'feedback') {
    if (m !== 'POST') return HJ({ error: '只接受 POST' }, 405);
    const text = textOf(body.text);
    if (!text) return HJ({ ok: false, error: '要寫指正內容（text）' }, 400);
    const h = /^h[0-9a-f]{20}$/.test(String(body.job || ''))
      ? await db.prepare('SELECT * FROM hook_jobs WHERE id=? AND routine=?').bind(String(body.job), r.id).first()
      : null;
    if (!h) return HJ({ ok: false, error: '找不到這件工作（job）' }, 404);
    if (!r.enabled) return HJ({ ok: false, error: '這個交接網址已暫停（在 OCTA 的例行任務裡關掉了）' }, 409);
    const prev = await hookStatus(db, h);
    if (prev.status === 'running') return HJ({ ok: false, error: '這件工作還在做，做完再指正' }, 409);
    const stop = await write();
    if (stop) return stop;
    const to = await targetOf(db, r);
    if (!to?.bots.length) return HJ({ ok: false, error: '接這個網址的機器人已經刪除' }, 410);
    const from = fromName(body.from ?? h.from_);
    // the original instruction (a redo of a redo goes back to the first one)
    let first = h;
    for (let i = 0; first.parent && i < 10; i++) {
      const p = await db.prepare('SELECT * FROM hook_jobs WHERE id=? AND routine=?').bind(first.parent, r.id).first();
      if (!p) break;
      first = p;
    }
    const id = await startWork(env, db, r, to, {
      text,
      from,
      parent: h.id,
      prompt:
        `${head(r, to)}\n\n「${from}」對你上一次交回的結果提出指正，請照指正重做（經交接網址，你的回覆會自動傳回給${from}）。\n` +
        `原本的工作：\n${first.text}\n\n你上一次的結果${prev.status === 'failed' ? '（沒有做成）' : ''}：\n${clean(prev.text, 3000) || '（沒有內容）'}\n\n` +
        `指正：\n${text}\n\n請照指正重做一次，回覆完整的新結果（不是只說改了哪裡）。這個指正如果以後做類似的事也適用，在回覆最後加一行「📌記住：…」。`
    });
    // a correction that says how to do it from now on is kept as a rule right away (the token is trusted like the user)
    const rule = correctionAsk(text);
    let remembered = false;
    if (rule && /以後|之後都|從現在起|每次|一律|永遠|下次|記得|記住|不要再|別再|規則/.test(rule)) {
      const st = await getSettings(db, U);
      st.memory = st.memory || {};
      for (const b of to.bots) st.memory[b.id] = [...new Set([...(st.memory[b.id] || []), rule])].slice(-40);
      await putSettings(db, U, st);
      for (const b of to.bots) await noteSrc(db, U, 'rule', b.id, [rule], 'hook');
      remembered = true;
    }
    await addMsg(
      db,
      U,
      to.conv,
      'sys',
      `✏️ ${from} 指正，重做：${text.slice(0, 300)}${remembered ? `\n已記住：${rule.slice(0, 200)}` : ''}`,
      null,
      null,
      'bg'
    );
    await bump(db, U);
    return HJ({ ok: true, job: id, ...(remembered ? { remembered: rule } : {}) });
  }

  // ---------- teach: a rule (or, with a name and steps, a 做事手冊) ----------
  if (rest === 'teach') {
    if (m !== 'POST') return HJ({ error: '只接受 POST' }, 405);
    const text = clean(textOf(body.text), 1500);
    if (!text) return HJ({ ok: false, error: '要寫要記住的做法（text）' }, 400);
    const stop = await write();
    if (stop) return stop;
    const to = await targetOf(db, r);
    if (!to?.bots.length) return HJ({ ok: false, error: '接這個網址的機器人已經刪除' }, 410);
    const from = fromName(body.from);
    const name = clean(String(body.name ?? '').replace(/[\r\n｜|]+/g, ' '), 40);
    const steps = text.split(/\s*(?:→|->|⇒|\n|；|;|(?:^|\s)\d+[.)、]\s*)\s*/).filter(x => x.trim()).length;
    const st = await getSettings(db, U);
    let saved;
    // a group's token teaches every member (each keeps its own rules)
    if (name && steps >= 3) {
      st.manuals = st.manuals || {};
      for (const b of to.bots) st.manuals[b.id] = saveManuals(st.manuals[b.id], [{ name, steps: text }]);
      for (const b of to.bots) await noteSrc(db, U, 'manual', b.id, [{ name }], 'hook');
      saved = 'manual';
    } else {
      const rule = clean(text.replace(/\s+/g, ' '), 300);
      st.memory = st.memory || {};
      for (const b of to.bots) st.memory[b.id] = [...new Set([...(st.memory[b.id] || []), rule])].slice(-40);
      for (const b of to.bots) await noteSrc(db, U, 'rule', b.id, [rule], 'hook');
      saved = 'rule';
    }
    await putSettings(db, U, st);
    await addMsg(
      db,
      U,
      to.conv,
      'sys',
      saved === 'manual'
        ? `🧠 ${from} 教了做法，已存成做事手冊「${name}」${to.bots.length > 1 ? `（${to.bots.map(b => b.name).join('、')}）` : ''}`
        : `🧠 ${from} 教了：${text.slice(0, 200)}（已記住${to.bots.length > 1 ? `，${to.bots.map(b => b.name).join('、')}都會照做` : ''}）`,
      null,
      null,
      'bg'
    );
    await bump(db, U);
    return HJ({ ok: true, saved, bots: to.bots.map(b => b.name) });
  }
  return HJ({ ok: false, error: '找不到這個功能' }, 404);
}
