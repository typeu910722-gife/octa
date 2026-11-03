// Work for the runner: what to do next, the job payload, and continuing a job that stopped halfway.
import { publicConnectors } from '../lib/connectors.mjs';
import { MAX_AUTO_RETRY, retryPrompt } from '../lib/model-route.mjs';
import { SIDE_LIKE, autonomyOk, turnsOf, viaOf } from './chat.mjs';
import { publicCodeTask } from './code-routes.mjs';
import { addMsg, bump, getSettings, loadAll, putSettings } from './db.mjs';
import { engineOk } from './engines.mjs';
import { memoryFor } from './memory.mjs';
import { ROUTINE_SELF, userTurn } from './routines.mjs';
import { correctionAsk, localNow, scheduleAsk } from './schedule.mjs';
import { MAX_ASK_DEPTH, MIN, WARM, clean, jobMaxOk, now } from './util.mjs';

export const PARTIAL_TAG = '【中止前已完成的部分】'; // same tag as octa-runner.mjs partialNote()
// a chat job that stopped halfway (no answer for a long time, or the host computer went offline): the same job again,
// told to continue from what is done, at most MAX_AUTO_RETRY times. Other kinds just fail.
export async function continueJob(db, U, job, kind, msg) {
  const done = await db
    .prepare("UPDATE jobs SET status='error', finished=?, err_kind=?, err_msg=? WHERE id=? AND status='running'")
    .bind(now(), kind, msg, job.id)
    .run();
  if (!done.meta.changes) return false;
  const n = (+job.tries || 0) + 1,
    chat = !job.kind || job.kind === 'chat';
  const who = (await db.prepare('SELECT name FROM bots WHERE id=? AND user_id=?').bind(job.bot_id, U).first())?.name || '機器人';
  if (!chat || n > MAX_AUTO_RETRY || String(job.via || '').includes('"side"')) {
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
      'INSERT INTO jobs (user_id,conv,bot_id,chain,prompt,created,depth,eng,tries,retry_of,via,routine,hook) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
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
      job.hook || null
    )
    .run();
  if (job.routine)
    await db
      .prepare('UPDATE routines SET last_job=? WHERE id=? AND last_job=?')
      .bind(r.meta.last_row_id, job.routine, job.id)
      .run();
  await addMsg(db, U, job.conv, 'sys', `「${who}」的工作中斷了（${msg}），自動接著做剩下的（第 ${n} 次）。`);
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
        `SELECT * FROM jobs j WHERE user_id=? AND status='pending' AND (j.pc IS NULL OR j.pc=?)
      AND (j.kind='open' OR NOT EXISTS (SELECT 1 FROM jobs r WHERE r.user_id=j.user_id AND r.bot_id=j.bot_id AND r.status='running' AND r.kind<>'open'
        AND (IFNULL(j.via,'') LIKE ?3) = (IFNULL(r.via,'') LIKE ?3)))
      ORDER BY (j.kind='open') DESC, id LIMIT 1`
      )
      .bind(U, '', SIDE_LIKE)

      .first();
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
async function jobPayload(env, db, U, job) {
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
      .prepare('SELECT id,by_,text,files,reply FROM messages WHERE user_id=? AND conv=? ORDER BY id DESC LIMIT 30')
      .bind(U, job.conv)
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
  const mem = memoryFor(st, bot.id, job.kind === 'chat' ? job.prompt : '');
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
          progress: main.progress || ''
        }
      : null,
    id: job.id,
    kind: job.kind,
    url: job.url,
    prompt:
      job.kind === 'chat' && /例行|排程|定時|刪|停用|暫停|取消/.test(job.prompt || '') ? job.prompt + ROUTINE_SELF : job.prompt,
    usageToday,
    maxMin: jobMaxOk(st.jobMax),
    warm: WARM.includes(+st.warm) ? +st.warm : 120,
    allowed: (st.allow || {})[bot.id] || [],
    ...mem,
    skills: (st.skills || {})[bot.id] || [],
    nskills: (st.nskills || {})[bot.id] || null,
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
      .slice(-6000),
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
