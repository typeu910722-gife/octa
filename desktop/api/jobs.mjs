// Work for the runner: what to do next, the job payload, and continuing a job that stopped halfway.
import { svcOf } from './service.mjs';
import { extraOn, genKeys, genLocalMode, skillSet, skillsForBot, toolsForBot } from './skills.mjs';
import { extraForBots } from '../lib/toolbox.mjs';
import { publicConnectors } from '../lib/connectors.mjs';
import { MAX_AUTO_RETRY, retryPrompt } from '../lib/model-route.mjs';
import { SIDE_LIKE, autonomyOk, turnsOf, viaOf } from './chat.mjs';
import { publicCodeTask } from './code-routes.mjs';
import { addMsg, bump, getSettings, loadAll, putSettings } from './db.mjs';
import { engineOk } from './engines.mjs';
import { memoryFor } from './memory.mjs';
import { parseProgress } from './progress.mjs';
import { ROUTINE_SELF, userTurn } from './routines.mjs';
import { correctionAsk, localNow, scheduleAsk } from './schedule.mjs';
import { FULL_RETRY_MAX, MAX_ASK_DEPTH, MIN, ROUTINE_QUOTA_CAP, clean, fullOn, jobMaxOf, now, retryDelay, warmOf } from './util.mjs';

// 4.14 Grok Bot（雲端）: chat work of a bot on that AI (or handed to it as a backup) goes out as a webhook call
// (grokcloud.mjs gcDispatch); the runner never takes it
export const GC_JOB_SQL = `(IFNULL(j.kind,'chat')='chat' AND ((j.eng IS NULL AND EXISTS (SELECT 1 FROM bots gb WHERE gb.id=j.bot_id AND gb.engine='grokcloud')) OR IFNULL(j.eng,'') LIKE 'grokcloud%'))`;
export const PARTIAL_TAG = '【中止前已完成的部分】'; // same tag as octa-runner.mjs partialNote()
// a chat job that stopped halfway (no answer for a long time, or the host computer went offline): the same job again,
// told to continue from what is done, at most MAX_AUTO_RETRY times (全力模式: FULL_RETRY_MAX, with a growing pause). Other kinds just fail.
export async function continueJob(db, U, job, kind, msg) {
  const done = await db
    .prepare("UPDATE jobs SET status='error', finished=?, err_kind=?, err_msg=? WHERE id=? AND status='running'")
    .bind(now(), kind, msg, job.id)
    .run();
  if (!done.meta.changes) return false;
  const n = (+job.tries || 0) + 1,
    chat = !job.kind || job.kind === 'chat';
  const who = (await db.prepare('SELECT name FROM bots WHERE id=? AND user_id=?').bind(job.bot_id, U).first())?.name || '機器人';
  const full = fullOn(await getSettings(db, U), job.bot_id);
  if (!chat || n > (full ? FULL_RETRY_MAX : MAX_AUTO_RETRY) || String(job.via || '').includes('"side"')) {
    await addMsg(db, U, job.conv, job.bot_id, `⚠ ${msg}`, null, null, 'fail');
    if (job.routine)
      await db
        .prepare("UPDATE routines SET last_status='error', last_text=? WHERE id=? AND last_job=?")
        .bind(clean(msg, 200), job.routine, job.id)
        .run();
    return true;
  }
  const r = await db
    .prepare(
      'INSERT INTO jobs (user_id,conv,bot_id,chain,prompt,created,depth,eng,tries,retry_of,via,routine,hook,after) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
    )
    .bind(
      U,
      job.conv,
      job.bot_id,
      job.chain,
      retryPrompt(job.prompt, n, kind, msg),
      now(),
      job.depth || 0,
      job.eng || null,
      n,
      job.id,
      job.via || null,
      job.routine || null,
      job.hook || null,
      full && n > MAX_AUTO_RETRY ? now() + retryDelay(n - MAX_AUTO_RETRY) : null
    )
    .run();
  if (job.routine)
    await db
      .prepare('UPDATE routines SET last_job=? WHERE id=? AND last_job=?')
      .bind(r.meta.last_row_id, job.routine, job.id)
      .run();
  const wait = full && n > MAX_AUTO_RETRY ? retryDelay(n - MAX_AUTO_RETRY) : 0;
  await addMsg(
    db,
    U,
    job.conv,
    'sys',
    `「${who}」的工作中斷了（${msg}），${wait ? `${Math.max(1, Math.round(wait / MIN))} 分鐘後` : ''}自動接著做剩下的（第 ${n} 次）。`
  );
  return true;
}

// what the runner should do next: a job (if it has a free slot), uploads to save, files to send
export async function nextWork(env, db, U, slots) {
  const files = (
    await db
      .prepare(
        "SELECT id,name,mime,conv,loc,path FROM files WHERE user_id=? AND ((loc='cloud' AND conv IS NOT NULL) OR (loc='pc' AND want>?)) LIMIT 10"
      )
      .bind(U, now() - MIN)
      .all()
  ).results;
  const inbox = files.filter(f => f.loc === 'cloud').map(f => ({ id: f.id, name: f.name, conv: f.conv }));
  const pull = files.filter(f => f.loc === 'pc').map(f => ({ id: f.id, path: f.path }));
  let job = null;
  if (slots > 0) {
    // one task per bot at a time; showing its browser on screen ('open') never waits; a 旁聊 runs beside the work (one at a time)
    const j = await db
      .prepare(
        `SELECT * FROM jobs j WHERE user_id=? AND status='pending' AND (j.pc IS NULL OR j.pc=?) AND IFNULL(j.after,0)<=?4 AND NOT ${GC_JOB_SQL}
      AND (j.kind='open' OR NOT EXISTS (SELECT 1 FROM jobs r WHERE r.user_id=j.user_id AND r.bot_id=j.bot_id AND r.status='running' AND r.kind<>'open'
        AND (IFNULL(j.via,'') LIKE ?3) = (IFNULL(r.via,'') LIKE ?3)))
      ORDER BY (j.kind='open') DESC, IFNULL(j.prio,0) DESC, id LIMIT 1`
      )
      .bind(U, '', SIDE_LIKE, now())
      .first();
    // 4.11: a routine (nobody waiting on it) is not run when its AI's 5-hour or weekly window is nearly used up
    if (j && (await deferRoutine(db, U, j))) return nextWork(env, db, U, slots);
    if (j) {
      const claimed = await db
        .prepare("UPDATE jobs SET status='running', started=? WHERE id=? AND status='pending'")
        .bind(now(), j.id)
        .run();
      if (claimed.meta.changes) {
        await bump(db, U);
        job = await jobPayload(env, db, U, j);
      }
    }
  }
  if (!job && !inbox.length && !pull.length) return null;
  const all = inbox.length || job ? await loadAll(db, U) : null;
  const convName = id => (all?.bots.find(b => b.id === id) || all?.groups.find(g => g.id === id))?.name || '';
  return { job, inbox: inbox.map(f => ({ ...f, convName: convName(f.conv) })), pull };
}
// The routine waits (jobs.after) until that window resets; an older waiting run of the same routine makes this one redundant.
// Returns true when the job was put off (the caller looks for the next one).
export async function deferRoutine(db, U, j) {
  if (!j.routine || (j.kind && j.kind !== 'chat')) return false;
  const st = await getSettings(db, U);
  const bot = await db.prepare('SELECT engine, model FROM bots WHERE id=? AND user_id=?').bind(j.bot_id, U).first();
  const eng = (j.eng ? j.eng.split('|')[0] : bot?.engine) || 'claude';
  const tight = routineQuotaTight(st._usage?.[eng]);
  if (!tight) return false;
  const rt = await db.prepare('SELECT name FROM routines WHERE id=? AND user_id=?').bind(j.routine, U).first();
  const waiting = await db
    .prepare("SELECT id FROM jobs WHERE user_id=? AND routine=? AND status='pending' AND id<>? AND after IS NOT NULL LIMIT 1")
    .bind(U, j.routine, j.id)
    .first();
  if (waiting) {
    await db.prepare("DELETE FROM jobs WHERE id=? AND status='pending'").bind(j.id).run();
    return true;
  }
  await db.prepare('UPDATE jobs SET after=? WHERE id=?').bind(tight.until, j.id).run();
  await addMsg(
    db,
    U,
    j.conv,
    'sys',
    `例行任務「${rt?.name || ''}」先延後：AI ${tight.k === '7d' ? '本週' : '5 小時'}額度已用 ${tight.used}%，留給你自己的工作；${hhmm(tight.until)} 額度重置後自動執行。`,
    null,
    null,
    'note'
  );
  await bump(db, U);
  return true;
}
// { k, used, until } of the first window at or over ROUTINE_QUOTA_CAP, or null (no report: not throttled)
export function routineQuotaTight(u, t = now()) {
  for (const w of u?.windows || []) {
    if (!Number.isFinite(+w.used) || +w.used < ROUTINE_QUOTA_CAP) continue;
    const reset = Date.parse(w.reset || '');
    // the report is up to 10 minutes old; an unknown reset waits an hour
    return { k: w.k, used: Math.round(+w.used), until: Number.isFinite(reset) && reset > t ? reset + MIN : t + 60 * MIN };
  }
  return null;
}
export const hhmm = t => {
  const d = new Date(t),
    z = n => String(n).padStart(2, '0');
  const day = new Date(t).toDateString() === new Date().toDateString() ? '' : `${d.getMonth() + 1}/${d.getDate()} `;
  return `${day}${z(d.getHours())}:${z(d.getMinutes())}`;
};
export async function jobPayload(env, db, U, job) {
  if (job.kind === 'code') {
    const task = await db.prepare('SELECT * FROM code_tasks WHERE id=? AND user_id=?').bind(job.url, U).first();
    const repo = task && (await db.prepare('SELECT * FROM code_repos WHERE id=? AND user_id=?').bind(task.repo_id, U).first());
    if (!task || !repo) {
      await db.prepare("UPDATE jobs SET status='error', finished=? WHERE id=?").bind(now(), job.id).run();
      return null;
    }
    if (task.cancel) {
      await db.prepare("UPDATE jobs SET status='error', finished=? WHERE id=?").bind(now(), job.id).run();
      await db
        .prepare("UPDATE code_tasks SET status='cancelled', phase='cancelled', finished=? WHERE id=?")
        .bind(now(), task.id)
        .run();
      return null;
    }
    return { id: job.id, kind: 'code', task: publicCodeTask(task), repo: { id: repo.id, name: repo.name, path: repo.path } };
  }
  if (job.kind === 'test') return { id: job.id, kind: 'test', engine: engineOk(job.url), prompt: job.prompt };
  if (job.kind === 'list') return { id: job.id, kind: 'list', what: job.url };
  if (job.kind === 'install') return { id: job.id, kind: 'install', engine: engineOk(job.url) };
  if (job.kind === 'tool') {
    let spec = {};
    try {
      spec = JSON.parse(job.prompt || '{}');
    } catch {}
    return { id: job.id, kind: 'tool', spec };
  }
  const { bots, groups, folders } = await loadAll(db, U);
  const name = id => (id === 'me' ? '使用者' : id === 'sys' ? '系統' : bots.find(b => b.id === id)?.name || '已刪除的機器人');
  const bot = bots.find(b => b.id === job.bot_id);
  if (!bot) {
    await db.prepare("UPDATE jobs SET status='error' WHERE id=?").bind(job.id).run();
    return null;
  }
  const group = groups.find(g => g.id === job.conv);
  const conv = group || bot;
  const hist = (
    await db
      .prepare('SELECT id,by_,text,files,reply FROM messages WHERE user_id=? AND conv=? ORDER BY id DESC LIMIT ?')
      .bind(U, job.conv, fullOn(await getSettings(db, U), job.bot_id) ? 50 : 30)
      .all()
  ).results.reverse();
  const seen = new Map(hist.map(h => [h.id, h]));
  const missing = [...new Set(hist.map(h => h.reply).filter(id => id && !seen.has(id)))];
  if (missing.length) {
    const more = (
      await db
        .prepare(`SELECT id, by_, text FROM messages WHERE user_id=? AND conv=? AND id IN (${missing.map(() => '?').join(',')})`)
        .bind(U, job.conv, ...missing)
        .all()
    ).results;
    for (const row of more) seen.set(row.id, row);
  }
  const fileIds = [...new Set(hist.flatMap(h => (h.files ? JSON.parse(h.files) : []).map(f => f.id)))];
  const where = fileIds.length
    ? (
        await db
          .prepare(`SELECT id,path FROM files WHERE user_id=? AND id IN (${fileIds.map(() => '?').join(',')})`)
          .bind(U, ...fileIds)
          .all()
      ).results
    : [];
  const pathOf = id => where.find(w => w.id === id)?.path || null;
  const st = await getSettings(db, U);
  const full = fullOn(st, bot.id);
  // its AI ran out of quota recently: start straight on the first backup that still has some
  if (!job.eng && job.kind === 'chat' && bot.fb?.length) {
    const sp = st.spent || {},
      list = [bot.engine + (bot.model ? '|' + bot.model : ''), ...bot.fb];
    if (sp[list[0]] > now()) {
      const alt = list.find(x => !(sp[x] > now()));
      if (alt) {
        job.eng = alt;
        await db.prepare('UPDATE jobs SET eng=? WHERE id=?').bind(alt, job.id).run();
      }
    }
  }
  const rt = job.routine
    ? await db.prepare('SELECT name,times,prompt FROM routines WHERE id=? AND user_id=?').bind(job.routine, U).first()
    : null;
  const { date } = localNow(env); // how many jobs this AI already ran today, so the bot can tell the user
  const dayStart = Date.parse(date + 'T00:00:00Z') - (+env.TZ_OFFSET_MIN || 0) * 60000;
  const usageToday =
    (
      await db
        .prepare(
          "SELECT COUNT(*) AS n FROM jobs j JOIN bots b ON b.id=j.bot_id WHERE j.user_id=? AND j.kind='chat' AND j.created>=? AND IFNULL(b.engine,'claude')=?"
        )
        .bind(U, dayStart, bot.engine || 'claude')
        .first()
    )?.n ?? null;
  // 規則／事實 capped (newest kept), and only the 做事手冊 that look like this task; a used manual counts toward "most used"
  const mem = memoryFor(st, bot.id, job.kind === 'chat' ? job.prompt : '', full);
  if (mem.manuals.length) {
    for (const m of (st.manuals || {})[bot.id] || []) if (mem.manuals.some(x => x.name === m.name)) m.used = (+m.used || 0) + 1;
    await putSettings(db, U, st);
  }
  // 旁聊: what the bot is busy with right now. Once that work is over, this is an ordinary turn.
  const sv = viaOf(job),
    main =
      sv?.k === 'side' &&
      (await db
        .prepare("SELECT prompt,progress FROM jobs WHERE id=? AND user_id=? AND status='running'")
        .bind(+sv.m || 0, U)
        .first());
  if (sv?.k === 'side' && !main) await db.prepare('UPDATE jobs SET via=NULL WHERE id=?').bind(job.id).run();
  return {
    side: main
      ? {
          doing: String(main.prompt || '')
            .replace(/\s+/g, ' ')
            .slice(0, 200),
          progress: parseProgress(main.progress)?.text || ''
        }
      : null,
    id: job.id,
    kind: job.kind,
    url: job.url,
    prompt:
      job.kind === 'chat' && /例行|排程|定時|刪|停用|暫停|取消/.test(job.prompt || '') ? job.prompt + ROUTINE_SELF : job.prompt,
    usageToday,
    full, // 4.11 全力模式: no time / turn / token caps; the runner goes on until the work is done or stuck
    maxMin: jobMaxOf(st, bot.id), // 0: 不限
    warm: warmOf(st, bot.id),
    allowed: (st.allow || {})[bot.id] || [],
    ...mem,
    skills: (st.skills || {})[bot.id] || [],
    // 4.12 技能與工具: learned skills (the runner fetches their files), tools on its PATH, MCP servers, finding more
    lskills: await skillsForBot(db, U, bot.id),
    ...toolsForBot(st, bot.id),
    skillSelf: skillSet(st).selfFind,
    gen: Object.keys(genKeys(st)),
    // 4.13 擴充工具箱: only when it is on — what is there to install or use, and where 【產生】 goes
    ...(extraOn(st) ? { extraTools: extraForBots(st._tools?.platform || undefined, !!st._tools?.gpu, st._tools?.installed || {}), genLocal: genLocalMode(st) } : {}),
    nskills: (st.nskills || {})[bot.id] || null,
    svc: (await svcOf(db, U))[bot.id] || null, // 4.16.3 客服模式 as it really is (the bot answers questions about it from this)
    routines: (
      await db
        .prepare('SELECT name,times,enabled FROM routines WHERE user_id=? AND conv IN (?,?)')
        .bind(U, job.conv, bot.id)
        .all()
    ).results.map(r => ({ name: r.name, times: JSON.parse(r.times), enabled: !!r.enabled })),
    // a routine run: its own instruction leads, the standing task is background, and its times are the only times
    routine: rt ? { name: rt.name, times: JSON.parse(rt.times || '[]'), own: !!String(rt.prompt || '').trim() } : null,
    schedAsk: job.kind === 'chat' && userTurn(job) && scheduleAsk(job.prompt).length > 0, // "每天 15:30 …": set the routine up this turn
    correction: job.kind === 'chat' && userTurn(job) && !!correctionAsk(job.prompt), // a correction: save a 📌 rule this turn
    routeTries: +job.tries || 0,
    canAsk: job.depth < MAX_ASK_DEPTH,
    conv: { id: conv.id, name: conv.name },
    shareBrowser: st.shareBrowser !== false,
    backup: !!(job.eng && job.eng !== (bot.engine || 'claude') + (bot.model ? '|' + bot.model : '')),
    bot: {
      id: bot.id,
      name: bot.name,
      task: bot.task,
      page: bot.page,
      engine: (job.eng ? job.eng.split('|')[0] : bot.engine) || 'claude',
      model: job.eng ? job.eng.split('|')[1] || '' : bot.model || '',
      browser: bot.browser === 'mine' ? 'mine' : 'own',
      autonomy: autonomyOk(bot.autonomy)
    },
    folder: folders.find(f => f.id === bot.folder)?.name || null,
    folderNotes: folders.find(f => f.id === bot.folder)?.notes || '',
    notes: st.notes || '',
    nick: st.nick || '',
    sites: Object.entries(st.sites || {})
      .map(([d, l]) => `${d}：\n` + l.map(x => '- ' + x).join('\n'))
      .join('\n')
      .slice(full ? -24000 : -6000),
    lang: st.lang || 'zh-TW',
    connectors: publicConnectors(st),
    colleagues: bots
      .filter(b => b.id !== bot.id)
      .sort(
        (a, b) => ((a.folder || null) === (bot.folder || null) ? 0 : 1) - ((b.folder || null) === (bot.folder || null) ? 0 : 1)
      )
      .slice(0, 20)
      .map(b => ({ id: b.id, name: b.name, task: b.task })),
    group: group
      ? { name: group.name, task: group.task, members: group.members.map(name), mode: turnsOf(group) ? 'turns' : 'parallel' }
      : null,
    history: hist.map(h => {
      const q = h.reply ? seen.get(h.reply) : null;
      return {
        id: h.id,
        who: name(h.by_),
        text: h.text,
        replyWho: q ? name(q.by_) : '',
        replyText: q
          ? String(q.text || '')
              .replace(/\s+/g, ' ')
              .trim()
              .slice(0, 160)
          : '',
        files: (h.files ? JSON.parse(h.files) : []).map(f => ({ ...f, path: pathOf(f.id) }))
      };
    })
  };
}
