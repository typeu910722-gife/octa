// 例行任務: routines, their schedule on this computer, event triggers (hook / watch), schedule tidy-up.
import { svcRing } from './service.mjs';
import { STANDBY, mentionLine, mentionsIn } from './chat.mjs';
import { addJob, addMsg, bump, getSettings, loadAll, putSettings } from './db.mjs';
import { REVIEW_TAG } from './memory.mjs';
import { noteSrc } from './memory-edit.mjs';
import { sendNotify } from './notify.mjs';
import {
  APPROVAL_TEXT,
  correctionAsk,
  isEvery,
  localNow,
  routinePlan,
  scheduleAsk,
  splitTaskSchedules,
  stripMeta,
  timesWords
} from './schedule.mjs';
import { DAY, MIN, clean, now, perDb, randTok, uid } from './util.mjs';

// ---------- 例行任務 ----------
// Each routine carries its own instruction. The standing task is background only, and times written in it don't count.
export const ROUTINE_NEEDS_PROMPT = '請寫這個例行任務每次要做什麼（每個排程有自己的說明，不會再回去讀指定任務）';
const ROUTINE_FALLBACK = '（這個例行任務還沒寫自己的指示）照你的指定任務，做這個時間該做的事，完成後回報結果。';
export function routinePrompt(r, o = {}) {
  const head = `（例行任務「${r.name}」${o.event ? '由事件觸發' : ''}）`;
  const when = o.catchup
    ? `這是主機重開後補做的一次${o.missed?.length > 1 ? `（錯過了 ${o.missed.join('、')}，只補做一次）` : ''}。先看今天的對話和工作紀錄：這次該做的如果已經做過、已經傳出去，就不要重做重傳，只補沒做到的；已經過時不用做的就說明略過。`
    : '';
  const where = o.group ? `做完把結果回報在群組「${o.group}」（這則對話就是那個群組）。` : '';
  return `${head}${when}${where}${String(r.prompt || '').trim() || ROUTINE_FALLBACK}`;
}
// where a routine runs and posts. A routine kept on a bot's own chat whose instruction says to report in one of
// that bot's groups ("貼到「房務群」") runs in that group, with only that bot.
const GROUP_POST = /群組|群裡|群內|貼到|貼在|發到|發在|傳到|回報到|回報在|報到/;
export function routineTarget(all, r) {
  const g = all.groups.find(x => x.id === r.conv);
  if (g) return { conv: g.id, chain: g.members.filter(id => all.bots.some(b => b.id === id)), name: g.name };
  const b = all.bots.find(x => x.id === r.conv);
  if (!b) return null;
  const p = String(r.prompt || '');
  const hits = GROUP_POST.test(p)
    ? all.groups.filter(x => x.members.includes(b.id) && String(x.name || '').length >= 2 && p.includes(x.name))
    : [];
  if (hits.length === 1) return { conv: hits[0].id, chain: [b.id], name: hits[0].name };
  return { conv: b.id, chain: [b.id], name: b.name };
}
// when the routine runs next (ms), from its times and what already fired today; null when off or event-only
export function nextRun(times, fired, enabled, t = now(), tzMin = 0) {
  if (!enabled || !Array.isArray(times) || !times.length) return null;
  const off = (+tzMin || 0) * MIN,
    f = fired || {};
  const local = new Date(t + off).toISOString(),
    date = local.slice(0, 10),
    hm = local.slice(11, 16);
  const day0 = Date.parse(date + 'T00:00:00Z') - off; // local midnight
  let best = null;
  const take = v => {
    if (best === null || v < best) best = v;
  };
  for (const x of times) {
    if (isEvery(x)) {
      const last = +f[x] || 0;
      take(last ? Math.max(t, last + +x.slice(2) * MIN) : t);
      continue;
    }
    const mm = String(x).match(/^([01]\d|2[0-3]):([0-5]\d)$/);
    if (!mm) continue;
    const at = day0 + (+mm[1] * 60 + +mm[2]) * MIN;
    if (x > hm) take(at);
    else if (f[x] !== date)
      take(t); // due now: the next check starts it
    else take(at + DAY);
  }
  return best;
}
// what the app gets: last_run, last_status, last_job, last_text and next_run (ms) per routine; 'fired' stays on the server
export const routinesOut = (env, list) =>
  list.map(({ fired, ...r }) => ({
    ...r,
    next_run: r.hook || r.watch ? null : nextRun(r.times, fired, r.enabled, now(), +env.TZ_OFFSET_MIN || 0)
  }));
const routineSummary = t =>
  clean(
    String(t || '')
      .replace(/^\s*(✅\s*待確認|❓|📍).*$/gm, '')
      .replace(/^⚠\s*/, '')
      .replace(/\s+/g, ' '),
    140
  );
// the end of one run: 'done' | 'error' | 'skipped'. In a group, one member's reply ("done") isn't hidden by another's「（略過）」, and a failure stays.
export async function routineEnded(db, U, job, status, text) {
  if (!job?.routine) return null;
  const when =
    {
      done: "(last_status IS NULL OR last_status IN ('done','skipped'))",
      skipped: "(last_status IS NULL OR last_status='skipped')",
      error: '1=1'
    }[status] || '1=0';
  await db
    .prepare(
      `UPDATE routines SET last_status=?, last_job=?, last_text=?, last_run=COALESCE(last_run, ?) WHERE id=? AND user_id=? AND ${when}`
    )
    .bind(status, job.id, routineSummary(text) || null, job.started || job.created || now(), job.routine, U)
    .run();
  return db.prepare('SELECT * FROM routines WHERE id=? AND user_id=?').bind(job.routine, U).first();
}
export const nextText = (env, r) => {
  const n = r
    ? nextRun(JSON.parse(r.times || '[]'), JSON.parse(r.fired || '{}'), !!r.enabled, now(), +env.TZ_OFFSET_MIN || 0)
    : null;
  if (!n) return '';
  const l = localNow(env, n),
    today = localNow(env).date;
  return l.date === today
    ? `今天 ${l.hm}`
    : l.date === localNow(env, now() + DAY).date
      ? `明天 ${l.hm}`
      : `${l.date.slice(5).replace('-', '/')} ${l.hm}`;
};
// This computer is the clock (the runner asks for work, and due routines fire then).
// A time missed while OCTA was closed is run once when it starts again, and the person is told.
// one routine with its own instruction, created or (same name in that chat) updated; says so in the chat
export async function saveRoutine(env, db, U, conv, r, quiet = false) {
  const { date, hm } = localNow(env);
  const fired = JSON.stringify(Object.fromEntries(r.times.filter(t => !isEvery(t) && t <= hm).map(t => [t, date]))); // times already past today start tomorrow
  let old = await db.prepare('SELECT id FROM routines WHERE user_id=? AND conv=? AND name=?').bind(U, conv, r.name).first();
  if (!old)
    old = sameRoutine(
      (await db.prepare('SELECT id,name,times,prompt FROM routines WHERE user_id=? AND conv=?').bind(U, conv).all()).results,
      r
    );
  if (old)
    await db
      .prepare('UPDATE routines SET times=?,prompt=?,enabled=1,fired=? WHERE id=?')
      .bind(JSON.stringify(r.times), r.prompt, fired, old.id)
      .run();
  else
    await db
      .prepare('INSERT INTO routines (id,user_id,conv,name,prompt,times,enabled,fired,created) VALUES (?,?,?,?,?,?,1,?,?)')
      .bind('r-' + uid(), U, conv, r.name, r.prompt, JSON.stringify(r.times), fired, now())
      .run();
  if (!quiet) await addMsg(db, U, conv, 'sys', `已${old ? '更新' : '新增'}例行任務「${r.name}」：${timesWords(r.times)}`);
  return old ? 'updated' : 'added';
}
// 不重複建: a routine at the same times whose name or instruction overlaps is the same routine
export function sameRoutine(rows, r) {
  const want = [...r.times].sort().join(','),
    key = x => String(x || '').replace(/[\s「」『』（）()。，,、:：]/g, '');
  const n = key(r.name),
    p = key(r.prompt).slice(0, 40);
  return (
    rows.find(x => {
      let t = x.times;
      try {
        if (typeof t === 'string') t = JSON.parse(t);
      } catch {
        t = [];
      }
      if ([...(t || [])].sort().join(',') !== want) return false;
      const xn = key(x.name),
        xp = key(x.prompt);
      return (
        (n.length >= 2 && xn.length >= 2 && (xn.includes(n) || n.includes(xn))) ||
        (p.length >= 6 && (xp.includes(p) || key(r.prompt).includes(xp.slice(0, 40))))
      );
    }) || null
  );
}
// a bot's routines: its own chat and the groups it is in
const routinesOfBot = async (db, U, botId) =>
  (
    await db
      .prepare(
        'SELECT r.id,r.conv,r.name,r.times,r.prompt,r.enabled FROM routines r LEFT JOIN groups_ g ON g.id=r.conv WHERE r.user_id=? AND (r.conv=? OR g.members LIKE ?)'
      )
      .bind(U, botId, '%' + JSON.stringify(botId) + '%')
      .all()
  ).results.map(r => ({ ...r, times: JSON.parse(r.times || '[]') }));
// how each time sentence of a task stands against the routines: same | differ (a routine of that name has other times) | missing
function compareSchedules(moved, routines) {
  return moved.map(m => {
    const fixed = m.times.filter(t => !isEvery(t));
    const same = routines.find(r => m.times.every(t => r.times.includes(t)));
    if (same) return { ...m, state: 'same', routine: same };
    const named = routines.find(
      r => r.name === m.name || (m.name.length >= 2 && r.name.length >= 2 && (r.name.includes(m.name) || m.name.includes(r.name)))
    );
    if (named) return { ...m, state: 'differ', routine: named };
    const near = fixed.length ? routines.find(r => r.times.some(t => fixed.includes(t))) : null;
    if (near) return { ...m, state: 'same', routine: near };
    return { ...m, state: 'missing' };
  });
}
// 📝任務更新 / 整理排程: the time sentences leave the task. A missing routine is made (with that sentence as its own instruction);
// an existing one is left as it is: the routine wins. Returns null when the task had no times.
export async function moveTaskSchedules(env, db, U, botId, conv, task) {
  const sp = splitTaskSchedules(task);
  if (!sp.moved.length) return null;
  const rows = compareSchedules(sp.moved, await routinesOfBot(db, U, botId));
  const lines = [];
  for (const m of rows) {
    if (
      m.state === 'missing' &&
      rows.indexOf(m) !== rows.findIndex(x => x.state === 'missing' && x.times.join() === m.times.join() && x.name === m.name)
    )
      continue; // the same sentence twice: one routine
    if (m.state === 'missing') {
      await saveRoutine(env, db, U, botId, { name: m.name, times: m.times, prompt: m.line }, true);
      lines.push(`「${m.line}」→ 新增例行任務「${m.name}」（${timesWords(m.times)}）`);
    } else
      lines.push(
        `「${m.line}」→ 已有例行任務「${m.routine.name}」（${timesWords(m.routine.times)}）${m.state === 'differ' ? '，時間不一樣，以例行任務為準' : ''}`
      );
  }
  await addMsg(
    db,
    U,
    conv,
    'sys',
    `排程時間只放在例行任務：指定任務裡的時間已移出。\n${lines.join('\n')}\n要改時間，到任務設定 → 例行任務改，或直接跟它說。`
  );
  return { task: sp.task, rows };
}
// a user's own instruction (not a routine run, a colleague, a retry note or an approval)
export const userTurn = job =>
  !job.routine &&
  !job.via &&
  !/^（例行任務|^〔背景:|^同事|^（自動接續|^\S+ (問你|把工作交接給你)：/.test(job.prompt || '') &&
  !String(job.prompt || '').startsWith(REVIEW_TAG) &&
  !APPROVAL_TEXT.test(stripMeta(job.prompt));
const pendingSame = (db, U, conv, line) =>
  db
    .prepare('SELECT 1 AS n FROM messages WHERE user_id=? AND conv=? AND text LIKE ? AND ts>? LIMIT 1')
    .bind(U, conv, '%' + line + '%', now() - 14 * DAY)
    .first();
// the user asked for a schedule but the reply wrote no ⏰ line: offer to make it with one press (nothing is made without it)
export async function scheduleRescue(db, U, job, all) {
  const asked = scheduleAsk(job.prompt);
  if (!asked.length) return false;
  const have = all.routines.filter(r => r.conv === job.conv || r.conv === job.bot_id);
  const todo = asked.filter(a => !have.some(r => a.times.every(t => r.times.includes(t))));
  if (!todo.length) return false;
  let n = 0;
  for (const a of todo.slice(0, 3)) {
    const line = `✅待確認：建立排程：${a.name}｜${a.times.map(t => (isEvery(t) ? `每${t.slice(2)}分鐘` : t)).join(',')}｜${a.prompt.replace(/\n+/g, ' ')}`;
    if (await pendingSame(db, U, job.conv, line.slice(0, 60))) continue;
    await addMsg(
      db,
      U,
      job.conv,
      job.bot_id,
      `你要我定時做這件事，但這次還沒建立排程。按「核准」就建立（${timesWords(a.times)}）：\n${line}`
    );
    n++;
  }
  return n > 0;
}
// a correction or new rule the reply didn't save with 📌: offer it as a rule (only written when the user approves)
export async function ruleRescue(db, U, job) {
  const rule = correctionAsk(job.prompt);
  if (!rule) return false;
  const st = await getSettings(db, U);
  if (((st.memory || {})[job.bot_id] || []).some(r => r === rule || (r.length >= 8 && (r.includes(rule) || rule.includes(r)))))
    return false;
  const line = `✅待確認：記住規則：${rule}`;
  if (await pendingSame(db, U, job.conv, line.slice(0, 60))) return false;
  await addMsg(
    db,
    U,
    job.conv,
    job.bot_id,
    `這聽起來是以後都要照做的規則，我這次沒有記下來。按「核准」就存成我的規則，之後每次照做：\n${line}`
  );
  return true;
}
// 一次性整理: the bots whose standing task still has times in it, and how those stand against their routines. Nothing changes here.
export async function tidyScan(env, db, U, { post = false, bot = null } = {}) {
  const { bots } = await loadAll(db, U),
    out = [];
  for (const b of bots) {
    if (bot && b.id !== bot) continue;
    const sp = splitTaskSchedules(b.task);
    if (!sp.moved.length) continue;
    const rows = compareSchedules(sp.moved, await routinesOfBot(db, U, b.id));
    out.push({
      bot: b.id,
      name: b.name,
      items: rows.map(r => ({
        line: r.line,
        times: r.times,
        state: r.state,
        routine: r.routine ? { id: r.routine.id, name: r.routine.name, times: r.routine.times } : null
      }))
    });
    if (!post) continue;
    const line = '✅待確認：整理排程：指定任務裡的時間搬到例行任務';
    if (
      await db
        .prepare('SELECT 1 AS n FROM messages WHERE user_id=? AND conv=? AND by_=? AND text LIKE ? AND ts>? LIMIT 1')
        .bind(U, b.id, b.id, '%' + line + '%', now() - 14 * DAY)
        .first()
    )
      continue;
    const says = rows.map(r =>
      r.state === 'missing'
        ? `- 「${r.line}」：還沒有對應的例行任務 → 會建立「${r.name}」（${timesWords(r.times)}）`
        : r.state === 'differ'
          ? `- 「${r.line}」：例行任務「${r.routine.name}」是 ${timesWords(r.routine.times)}，不一致`
          : `- 「${r.line}」：跟例行任務「${r.routine.name}」重複`
    );
    await addMsg(
      db,
      U,
      b.id,
      b.id,
      `我的指定任務裡還寫著排程時間，排程應該只放在例行任務一個地方：\n${says.join('\n')}\n按「核准」會把這些時間句從指定任務移掉；沒有例行任務的會建立；已經有的以例行任務為準，不會改。\n${line}`
    );
  }
  return out;
}
const tidyLooked = perDb(); // the one-time check looks at most once an hour per account, and runs once
export async function tidyOnce(env, db, U) {
  if (now() - (tidyLooked(db).get(U) || 0) < 60 * MIN) return 0;
  tidyLooked(db).set(U, now());
  const st = await getSettings(db, U);
  if (st.schedTidy) return 0;
  st.schedTidy = now();
  await putSettings(db, U, st);
  return (await tidyScan(env, db, U, { post: true })).length;
}
// 核准 one of OCTA's own ✅待確認 lines (建立排程, 記住規則, 整理排程): done here, no AI run. 不要做 → only noted.
export async function ownApproval(env, db, U, conv, text, bots, group) {
  const lead =
    group && String(text).startsWith('@')
      ? mentionLine(
          text,
          bots.filter(b => group.members.includes(b.id))
        )
      : null;
  const m = (lead ? lead.rest : stripMeta(text)).match(
    /^(核准|不要做)[:：]\s*(建立排程|記住規則|整理排程)[:：]\s*([\s\S]+?)(?:（以後這類事一律允許：[\s\S]*）)?(?:。這件事先停下，不用再問。)?$/
  );
  if (!m) return false;
  const [, verb, kind, spec] = m;
  const members = group ? bots.filter(b => group.members.includes(b.id)) : bots.filter(b => b.id === conv);
  const at = mentionsIn(text, members),
    named = members.find(b => at[b.id] !== undefined);
  const asked = await db
    .prepare('SELECT by_ FROM messages WHERE user_id=? AND conv=? AND text LIKE ? AND ts>? ORDER BY id DESC LIMIT 1')
    .bind(U, conv, `%✅待確認：${kind}：${spec.trim().slice(0, 40)}%`, now() - 14 * DAY)
    .first();
  const bot = named || members.find(b => b.id === asked?.by_);
  if (!asked || !bot) return false;
  if (verb === '不要做') {
    await addMsg(
      db,
      U,
      conv,
      'sys',
      kind === '記住規則' ? '好，這條不記成規則。' : kind === '建立排程' ? '好，不建立這個排程。' : '好，指定任務先不整理。'
    );
    return true;
  }
  if (kind === '記住規則') {
    const st = await getSettings(db, U),
      rule = clean(spec, 300);
    st.memory = st.memory || {};
    st.memory[bot.id] = [...new Set([...(st.memory[bot.id] || []), rule])].slice(-40);
    await putSettings(db, U, st);
    await noteSrc(db, U, 'rule', bot.id, [rule], 'fix'); // 4.7: a correction you approved
    await addMsg(db, U, conv, 'sys', `已記住：${rule.slice(0, 200)}（「${bot.name}」之後每次照做，跟指定任務衝突時以這條為準）`);
    return true;
  }
  if (kind === '建立排程') {
    const [n, t, ...p] = spec.split(/\s*[｜|]\s*/);
    const plan = routinePlan(n, t || '', p.join('｜'));
    if (!plan || plan.trigger) {
      await addMsg(db, U, conv, 'sys', '這個排程的時間看不懂，沒有建立。請直接說「每天 08:00 做…」或到任務設定 → 例行任務新增。');
      return true;
    }
    await saveRoutine(env, db, U, conv, plan);
    return true;
  }
  const cur = await db.prepare('SELECT task FROM bots WHERE id=? AND user_id=?').bind(bot.id, U).first();
  const moved = await moveTaskSchedules(env, db, U, bot.id, conv, cur?.task || '');
  if (!moved) {
    await addMsg(db, U, conv, 'sys', `「${bot.name}」的指定任務裡已經沒有排程時間。`);
    return true;
  }
  await db.prepare('UPDATE bots SET task=? WHERE id=? AND user_id=?').bind(moved.task, bot.id, U).run();
  return true;
}
export async function fireRoutines(env, db, userId) {
  const list = (await db.prepare('SELECT * FROM routines WHERE user_id=? AND enabled=1').bind(userId).all()).results;
  if (!list.length) return 0;
  const st = await getSettings(db, userId);
  const { date, hm } = localNow(env),
    late = localNow(env, now() - 10 * MIN).hm;
  let n = 0,
    all = null;
  for (const r of list) {
    const fired = JSON.parse(r.fired || '{}');
    const times = JSON.parse(r.times);
    const due = times.filter(t => !isEvery(t) && t <= hm && fired[t] !== date);
    // "every N minutes": due when N minutes passed since the last run, and the previous run is finished
    const ev = times.find(isEvery);
    if (ev && now() - (+fired[ev] || 0) >= +ev.slice(2) * MIN - 30000) {
      const open = await db
        .prepare("SELECT 1 FROM jobs WHERE user_id=? AND (conv=? OR routine=?) AND status IN ('pending','running') LIMIT 1")
        .bind(userId, r.conv, r.id)
        .first();
      if (!open) due.push(ev);
    }
    if (!due.length) continue;
    const old = { ...fired };
    due.forEach(t => (fired[t] = isEvery(t) ? now() : date));
    const upd = await db
      .prepare("UPDATE routines SET fired=? WHERE id=? AND IFNULL(fired,'')=IFNULL(?,'')")
      .bind(JSON.stringify(fired), r.id, r.fired)
      .run();
    if (!upd.meta.changes) continue; // someone else fired it
    const t = isEvery(due[due.length - 1]) ? hm : due[due.length - 1];
    const catchup = !isEvery(due[due.length - 1]) && hm >= '00:10' && t < late;
    all = all || (await loadAll(db, userId));
    const to = routineTarget(all, r);
    if (!to) continue;
    // the bot is waiting for the user to sign in: don't run (and report the same thing) again until they reply
    const lastReal = await db
      .prepare("SELECT by_, text FROM messages WHERE user_id=? AND conv=? AND by_<>'sys' ORDER BY id DESC LIMIT 1")
      .bind(userId, to.conv)
      .first();
    if (lastReal && lastReal.by_ !== 'me' && /需要使用者在電腦上登入/.test(lastReal.text)) {
      const last = await db
        .prepare('SELECT by_, text FROM messages WHERE user_id=? AND conv=? ORDER BY id DESC LIMIT 1')
        .bind(userId, to.conv)
        .first();
      if (!(last?.by_ === 'sys' && last.text.startsWith('例行任務先暫停'))) {
        await addMsg(
          db,
          userId,
          to.conv,
          'sys',
          `例行任務先暫停：「${r.name}」要等你在機器人的瀏覽器登入。登入後按「登入好了，繼續」或傳任何訊息，就會恢復。`
        );
        await db
          .prepare('UPDATE routines SET last_run=?, last_status=?, last_job=NULL, last_text=? WHERE id=?')
          .bind(now(), 'error', '等你在機器人的瀏覽器登入，這次沒有執行', r.id)
          .run();
        n++;
      }
      continue;
    }
    // times missed while the host computer was off: all of them are named, and the run is done once now
    const missed = catchup ? due.filter(x => !isEvery(x) && x < late) : [];
    const gap = due
      .filter(x => !isEvery(x) && old[x] && old[x] < localNow(env, now() - DAY).date)
      .map(x => old[x])
      .sort()[0]; // whole days with no run
    const gapNote = gap ? `（${gap} 之後有幾天主機電腦沒開，那幾次沒有做）` : '';
    const where = to.conv !== r.conv ? `（結果貼在群組「${to.name}」）` : '';
    if (r.name !== STANDBY || missed.length)
      await addMsg(
        db,
        userId,
        to.conv,
        'sys',
        catchup
          ? `補做錯過的例行任務「${r.name}」（${missed.join('、') || t}）。那時主機電腦沒有開著，主機剛連上，這一次會補做。${gapNote}`
          : `${t} 例行任務：${r.name}${gapNote}${where}`
      );
    if (to.conv !== r.conv && r.name !== STANDBY)
      await addMsg(db, userId, r.conv, 'sys', `${t} 例行任務「${r.name}」開始，結果會貼在群組「${to.name}」`);
    const jid = await addJob(
      db,
      userId,
      to.conv,
      to.chain,
      routinePrompt(r, { catchup, at: t, missed, group: to.conv !== r.conv ? to.name : '' }),
      0,
      r.id
    );
    await db
      .prepare('UPDATE routines SET last_run=?, last_status=NULL, last_job=?, last_text=NULL WHERE id=?')
      .bind(now(), jid, r.id)
      .run();
    if (catchup) await sendNotify(env, st, `【OCTA】補做錯過的例行任務「${r.name}」（${missed.join('、') || t}）`);
    n++;
  }
  if (n) await bump(db, userId);
  return n;
}

// ---------- event triggers ----------
// hook: a secret key → POST /api/hook/<key> starts the routine (LINE webhook, Zapier, forms…)
// watch: {url, sel, every} → the host computer checks the page in the bot's browser and starts the routine when it changes
export function triggerFrom(body, old) {
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
export async function fireEvent(env, db, r, what) {
  // 4.16.1 a LINE message (or a watched page) for a bot in 客服模式 only rings the bell: it looks at the chat now and
  // answers from there, so it never answers twice or over a person who already took the chat
  if ((r.watch || /^LINE [^\n]*訊息/m.test(String(what || ''))) && (await svcRing(db, r.user_id, r.conv))) return 'svc';
  const all = await loadAll(db, r.user_id);
  const to = routineTarget(all, r);
  if (!to) return 'gone';
  const pend = await db
    .prepare(
      "SELECT id,prompt FROM jobs WHERE user_id=? AND conv=? AND status='pending' AND prompt LIKE ? ORDER BY id DESC LIMIT 1"
    )
    .bind(r.user_id, to.conv, `（例行任務「${r.name}」%`)
    .first();
  if (pend) {
    await db
      .prepare('UPDATE jobs SET prompt=? WHERE id=?')
      .bind((pend.prompt + '\n\n（又來一個事件）\n' + what).slice(0, 20000), pend.id)
      .run();
    await bump(db, r.user_id);
    return 'merged';
  }
  await addMsg(db, r.user_id, to.conv, 'sys', /交接的工作：/.test(what) ? `⚡ ${what.slice(0, 300)}` : `⚡ 事件觸發：${r.name}`);
  const jid = await addJob(
    db,
    r.user_id,
    to.conv,
    to.chain,
    `${routinePrompt(r, { event: true, group: to.conv !== r.conv ? to.name : '' })}\n\n事件內容：\n${what}`.slice(0, 20000),
    0,
    r.id
  );
  await db
    .prepare('UPDATE routines SET last_run=?, last_status=NULL, last_job=?, last_text=NULL WHERE id=?')
    .bind(now(), jid, r.id)
    .run();
  await bump(db, r.user_id);
  return 'fired';
}
// LINE webhook body → readable lines
export function describeEvent(raw, body) {
  if (body && Array.isArray(body.events)) {
    return body.events
      .map(e => {
        const who = e.source?.userId ? `（使用者 ${e.source.userId}）` : '';
        if (e.type === 'message')
          return `LINE ${e.message?.type === 'text' ? '文字訊息' : e.message?.type || '訊息'}${who}：${e.message?.text || ''}`;
        return `LINE 事件 ${e.type}${who}`;
      })
      .join('\n');
  }
  // another AI (e.g. Grok Bot) handing work over: {"text": "...", "from": "..."}
  const t = body && typeof body === 'object' ? body.text || body.task || body.message || body.content : null;
  if (typeof t === 'string' && t.trim())
    return `${body.from ? `「${String(body.from).slice(0, 40)}」` : '外部'}交接的工作：${t.slice(0, 4000)}`;
  return raw.slice(0, 4000);
}

// works with runners that don't know the marker yet: the note travels with the prompt
export const ROUTINE_SELF =
  '\n\n（系統說明：你可以自己管理例行任務。要刪除、暫停或恢復時，在回覆最後寫一行「⏰刪除：名稱」「⏰停用：名稱」或「⏰啟用：名稱」，多個用、分開，名稱照你現有的例行任務抄，系統會直接處理。不要叫使用者去任務設定手動處理，也不要說自己刪不掉。）';
