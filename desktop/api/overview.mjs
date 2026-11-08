// 4.7 任務總覽: every bot and group on one page — its job, today's done and not-done work, the next routine runs,
// what is running now (with its steps), and failures to 重試. One request, a few aggregate reads.
import { FAIL_KINDS, classifyJobFailure } from '../lib/model-route.mjs';
// older rows were saved as 'unknown' (其他錯誤): read the message again with today's rules
const kindOf = j => (!j.err_kind || j.err_kind === 'unknown' ? classifyJobFailure(j.err_msg || '') : j.err_kind);
import { STANDBY } from './chat.mjs';
import { bump, loadAll } from './db.mjs';
import { REVIEW_TAG } from './memory.mjs';
import { ALERT_KINDS, ensureAlerts, retryJob } from './notify.mjs';
import { nextRun } from './routines.mjs';
import { localNow } from './schedule.mjs';
import { DAY, J, now } from './util.mjs';

// progress: the 4.7 JSON form {text, step, total, steps, kind, at} or an older plain line
export function progressOf(p) {
  if (p == null || p === '') return null;
  if (typeof p === 'object') return p;
  const s = String(p);
  if (s.startsWith('{'))
    try {
      const o = JSON.parse(s);
      if (o && typeof o === 'object') return o;
    } catch {}
  return { text: s };
}
// one line about what a job was for (no retry notes, no 〔背景〕 tags, a routine run says which routine)
export function jobLine(prompt, routineName) {
  if (routineName) return '例行任務：' + routineName;
  return (
    String(prompt || '')
      .replace(/\n\n（自動重試 \d+）[\s\S]*$/, '')
      .replace(/^（例行任務「[^」]*」）/, '')
      .replace(/^〔[^〕]*〕\s*/, '')
      .replace(/^同事「[^」]*」[^：]*：/, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80) || '（沒有內容）'
  );
}
// the first sentence of the 指定任務: what this bot is for
export const roleOf = task =>
  String(task || '')
    .split(/\n|(?<=[。！？!?])/)[0]
    .trim()
    .slice(0, 70);
const failLabel = k => (ALERT_KINDS[k] || FAIL_KINDS[k] || FAIL_KINDS.unknown).label;

export async function overviewData(env, db, U) {
  const tz = +env.TZ_OFFSET_MIN || 0;
  const { date } = localNow(env);
  const dayStart = Date.parse(date + 'T00:00:00Z') - tz * 60000;
  const { bots, groups, routines } = await loadAll(db, U);
  const fired = new Map(
    (await db.prepare('SELECT id, fired FROM routines WHERE user_id=?').bind(U).all()).results.map(r => [r.id, r.fired])
  );
  const [today, live] = await db.batch([
    // today's chat work (job_created index); the newest first
    db
      .prepare(
        "SELECT id,conv,bot_id,prompt,status,created,started,finished,err_kind,err_msg,retry_of,routine FROM jobs WHERE user_id=? AND created>=? AND kind='chat' ORDER BY id DESC LIMIT 1500"
      )
      .bind(U, dayStart),
    // running and queued, from any day (paused, when the runner supports it, is read from the row)
    db.prepare("SELECT * FROM jobs WHERE user_id=? AND status IN ('pending','running') AND kind<>'test' ORDER BY id").bind(U)
  ]);
  await ensureAlerts(db);
  const alerts = (
    await db
      .prepare('SELECT bot_id, kind, job, ts FROM alerts WHERE user_id=? AND ts>? ORDER BY id DESC LIMIT 100')
      .bind(U, now() - DAY)
      .all()
  ).results;
  const rname = new Map(routines.map(r => [r.id, r.name]));
  const jobs = today.results.filter(j => !String(j.prompt || '').startsWith(REVIEW_TAG));
  const retriedIds = new Set(jobs.map(j => j.retry_of).filter(Boolean));
  // a failure that was retried is not a failure any more (its retry is shown instead)
  const isFail = j => j.status === 'error' || (j.status === 'done' && j.err_kind);
  const pack = (rows, liveRows, rts, members) => {
    const done = rows.filter(j => j.status === 'done' && !j.err_kind);
    const failed = rows.filter(j => isFail(j) && !retriedIds.has(j.id));
    const running = liveRows.filter(j => j.status === 'running');
    const queued = liveRows.filter(j => j.status === 'pending');
    const next = rts
      .map(r => ({ id: r.id, name: r.name, at: r.hook || r.watch ? null : nextRun(r.times, JSON.parse(fired.get(r.id) || '{}'), r.enabled, now(), tz), enabled: r.enabled, last: r.last_status || null, lastAt: r.last_run || null, event: !!(r.hook || r.watch) }))
      .filter(r => r.enabled);
    return {
      doneN: done.length,
      done: done.slice(0, 6).map(j => ({ id: j.id, what: jobLine(j.prompt, rname.get(j.routine)), at: j.finished || j.created, bot: members ? j.bot_id : undefined })),
      failed: failed.slice(0, 8).map(j => ({
        id: j.id,
        what: jobLine(j.prompt, rname.get(j.routine)),
        kind: kindOf(j),
        label: failLabel(kindOf(j)),
        msg: String(j.err_msg || '').replace(/\s+/g, ' ').slice(0, 160),
        at: j.finished || j.created,
        bot: j.bot_id
      })),
      running: running.map(j => ({
        id: j.id,
        what: jobLine(j.prompt, rname.get(j.routine)),
        progress: progressOf(j.progress),
        paused: !!j.paused,
        started: j.started || j.created,
        bot: j.bot_id
      })),
      queued: queued.length,
      queue: queued.slice(0, 10).map(j => ({ id: j.id, what: jobLine(j.prompt, rname.get(j.routine)), bot: j.bot_id })), // 4.15.2 each can be cancelled
      routines: next
        .filter(r => r.at)
        .sort((a, b) => a.at - b.at)
        .slice(0, 3),
      routineErr: rts.filter(r => r.enabled && r.last_status === 'error').map(r => ({ id: r.id, name: r.name, at: r.last_run })),
      events: next.filter(r => r.event).length
    };
  };
  const out = {
    now: now(),
    day: date,
    bots: bots.map(b => {
      const mine = jobs.filter(j => j.bot_id === b.id);
      const a = alerts.find(x => x.bot_id === b.id && mine.some(j => j.id === x.job && !retriedIds.has(j.id)));
      return {
        id: b.id,
        name: b.name,
        avatar: b.avatar,
        color: b.color || null,
        folder: b.folder || null,
        role: roleOf(b.task),
        engine: b.engine || 'claude',
        alert: a ? { kind: a.kind, label: failLabel(a.kind), job: a.job, at: a.ts } : null,
        ...pack(
          mine,
          live.results.filter(j => j.bot_id === b.id),
          routines.filter(r => r.conv === b.id),
          false
        )
      };
    }),
    groups: groups.map(g => ({
      id: g.id,
      name: g.name,
      folder: g.folder || null,
      members: g.members,
      role: roleOf(g.task) || '',
      alert: null,
      ...pack(
        jobs.filter(j => j.conv === g.id),
        live.results.filter(j => j.conv === g.id),
        routines.filter(r => r.conv === g.id),
        true
      )
    }))
  };
  return out;
}

export async function overviewRoutes(c) {
  const { env, db, path, m, body, U } = c;
  if (path === 'overview' && m === 'GET') return J(await overviewData(env, db, U));
  // 4.15 公司組織圖: work each bot has finished, ever (its level). 待命巡查 checks and connection tests don't count
  if (path === 'overview/org' && m === 'GET') {
    const rows = (
      await db
        .prepare(
          "SELECT bot_id, COUNT(*) AS n FROM jobs WHERE user_id=? AND status='done' AND (err_kind IS NULL OR err_kind='') AND kind<>'test' AND (routine IS NULL OR routine NOT IN (SELECT id FROM routines WHERE user_id=? AND name=?)) GROUP BY bot_id"
        )
        .bind(U, U, STANDBY)
        .all()
    ).results;
    return J({ total: Object.fromEntries(rows.filter(r => r.bot_id).map(r => [r.bot_id, +r.n || 0])) });
  }
  if (path === 'overview/retry' && m === 'POST') {
    const r = await retryJob(db, U, body.job);
    if (r.error) return J({ error: r.error, job: r.job || null }, r.status || 400);
    return J({ ok: true, job: r.job });
  }
  // 4.8.2: 「上次沒跑成」 handled by hand → mark it so the card stops showing it (the next run still reports as usual)
  if (path === 'overview/routine-ok' && m === 'POST') {
    const r = await db
      .prepare("UPDATE routines SET last_status='skipped', last_text=? WHERE id=? AND user_id=? AND last_status='error'")
      .bind('已手動處理', String(body.id || ''), U)
      .run();
    if (!r?.meta?.changes) return J({ error: '這個例行任務目前沒有失敗紀錄' }, 404);
    await bump(db, U);
    return J({ ok: true });
  }
  return null;
}
