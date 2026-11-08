// Routes the built-in runner calls (runner/*), except runner/done.
import { runConnector } from '../lib/connectors.mjs';
import { publicCodeTask } from './code-routes.mjs';
import { addMsg, bump, getSettings, nap, putSettings, wake } from './db.mjs';
import { ENGINES } from './engines.mjs';
import { mimeOf, safePath } from './files.mjs';
import { continueJob, nextWork } from './jobs.mjs';
import { progressOf, sameProgress, withTrail } from './progress.mjs';
import { approvalNag, weeklyReview } from './memory.mjs';
import { fireEvent, fireRoutines, tidyOnce } from './routines.mjs';
import { grokTick } from './grokcloud.mjs';
import { runnerDone } from './runner-done.mjs';
import { CHUNK, J, MIN, WAIT_MS, clean, err, jobMaxOf, now, uid } from './util.mjs';

export async function runnerRoutes(c) {
  const { env, db, path, m, body, me, U, ok } = c;
  // ---------- runner (the built-in runner on this computer) ----------
  if (path.startsWith('runner/')) {
    if (me.kind !== 'local') return err('需要執行器金鑰', 403);
    const label = me.label;
    if (body.engines && typeof body.engines === 'object')
      await db
        .prepare('UPDATE users SET engines=? WHERE id=?')
        .bind(JSON.stringify(Object.fromEntries(ENGINES.map(k => [k, !!body.engines[k]]))), U)
        .run();
    if (
      (body.usage && typeof body.usage === 'object') ||
      (body.models && typeof body.models === 'object') ||
      (body.coding && typeof body.coding === 'object') ||
      (body.toolsHere && typeof body.toolsHere === 'object')
    ) {
      const st = await getSettings(db, U);
      if (body.usage) st._usage = body.usage;
      if (body.models) st._models = body.models;
      if (body.coding && JSON.stringify(body.coding).length < 4000) st._coding = body.coding;
      if (body.toolsHere && JSON.stringify(body.toolsHere).length < 100000) st._tools = body.toolsHere; // 4.12: the toolbox on this computer
      await putSettings(db, U, st);
    }
    // 4.8: how many bots the runner works at once (the 工作 panel's queue estimate)
    if (Number.isInteger(+body.max) && +body.max > 0) {
      const st = await getSettings(db, U);
      if (st._slots !== +body.max) {
        st._slots = Math.min(8, +body.max);
        await putSettings(db, U, st);
      }
    }
    if (path === 'runner/hello') return J({ user: U, name: me.name, label });
    if (path === 'runner/bye' && m === 'POST') return J({ ok: true });

    if (path === 'runner/next' && m === 'POST') {
      let changed = await fireRoutines(env, db, U);
      // stale running jobs become errors
      const stNow = await getSettings(db, U);
      // the host just (re)started: whatever was running belonged to the old run and will never report back.
      // Those jobs continue (from what is done) instead of sitting in 處理中 until they time out.
      if (body.boot) {
        const lost = (
          await db
            .prepare("SELECT * FROM jobs WHERE user_id=? AND status='running' AND (kind IS NULL OR kind='' OR kind='chat') AND ext IS NULL")
            .bind(U)
            .all()
        ).results;
        for (const j of lost) if (await continueJob(db, U, j, 'interrupted', '主機電腦斷線或重新啟動')) changed++;
      }
      // 4.11: what the runner says it is still working on (a heartbeat-silent job it still holds is checked, not killed)
      const holding = new Set((Array.isArray(body.running) ? body.running : []).map(Number).filter(Number.isFinite));
      const cands = (
        await db
          .prepare(
            "SELECT * FROM jobs WHERE user_id=? AND status='running' AND ext IS NULL AND (IFNULL(beat,started)<? OR (started<? AND IFNULL(paused,0)=0))"
          )
          .bind(U, now() - 20 * MIN, now() - 10 * MIN)
          .all()
      ).results;
      for (const s of cands) {
        const chat = s.kind === 'chat';
        // 0: 不限 (全力模式) — only the heartbeat decides; other kinds of work keep their 3-hour bound
        const maxMin = jobMaxOf(stNow, s.bot_id);
        const quietLong = now() - (s.beat || s.started) >= 20 * MIN;
        const tooLong = !s.paused && (chat ? maxMin > 0 && s.started < now() - (maxMin + 5) * MIN : s.started < now() - Math.max(3 * 60, maxMin + 5) * MIN);
        const lost = chat && quietLong && !holding.has(s.id);
        if (chat && quietLong && !lost && !tooLong) {
          // 20 minutes without a report, but the runner says it still has it: alive (e.g. one very long tool call)
          await db.prepare('UPDATE jobs SET beat=? WHERE id=?').bind(now(), s.id).run();
          continue;
        }
        if (!lost && !tooLong) continue;
        if (
          await continueJob(
            db,
            U,
            s,
            lost ? 'interrupted' : 'timeout',
            lost ? '超過 20 分鐘沒有任何回報（主機可能睡眠或斷線）' : `執行超過 ${maxMin} 分鐘（單件工作最長時間）`
          )
        )
          changed++;
      }
      try {
        changed += await weeklyReview(env, db, U);
      } catch {}
      try {
        changed += await tidyOnce(env, db, U);
      } catch {}
      try {
        await approvalNag(env, db, U);
      } catch {}
      if (changed) await bump(db, U);
      // 4.14: Grok Bot（雲端）work goes out from here (and from the server's own timer), never to the runner
      try {
        await grokTick(env, db, U);
      } catch {}
      const slots = body.slots === undefined ? 1 : +body.slots;
      const t0 = now();
      let rev = null;
      for (;;) {
        const u2 = await db.prepare('SELECT rev FROM users WHERE id=?').bind(U).first(),
          r = u2?.rev ?? 0;
        // 4.11: a job that was waiting for a time (quota reset, retry back-off) is due now
        const due = await db
          .prepare("SELECT 1 AS n FROM jobs WHERE user_id=? AND status='pending' AND after IS NOT NULL AND after<=? LIMIT 1")
          .bind(U, now())
          .first();
        if (due) {
          await db.prepare("UPDATE jobs SET after=NULL WHERE user_id=? AND status='pending' AND after<=?").bind(U, now()).run();
          rev = null;
        }
        if (r !== rev) {
          // something changed since the last look
          rev = r;
          try {
            await grokTick(env, db, U);
          } catch {}
          const out = await nextWork(env, db, U, slots);
          if (out) return J(out);
        }
        if (!body.wait || now() - t0 > WAIT_MS) return J({ job: null });
        await nap(env, 1500);
      }
    }
    if (path === 'runner/watches' && m === 'POST') {
      // pages the host should check for changes
      const rows = (
        await db
          .prepare(
            'SELECT r.id,r.conv,r.watch,g.members FROM routines r LEFT JOIN groups_ g ON g.id=r.conv WHERE r.user_id=? AND r.enabled=1 AND r.watch IS NOT NULL'
          )
          .bind(U)
          .all()
      ).results;
      return J({
        watches: rows.map(r => {
          const w = JSON.parse(r.watch);
          return { id: r.id, bot: r.members ? JSON.parse(r.members)[0] : r.conv, ...w };
        })
      });
    }
    if (path === 'runner/watched' && m === 'POST') {
      // a checked page: start the routine when it changed
      const r = await db.prepare('SELECT * FROM routines WHERE id=? AND user_id=?').bind(clean(body.id, 64), U).first();
      if (!r || !r.watch) return J({ ok: true });
      const text = clean(body.text, 8000),
        hash = clean(body.hash, 80);
      const old = r.wstate ? JSON.parse(r.wstate) : null;
      await db
        .prepare('UPDATE routines SET wstate=? WHERE id=?')
        .bind(JSON.stringify({ hash, text, t: now() }), r.id)
        .run();
      if (!old || old.hash === hash || !hash) return J({ ok: true, changed: false }); // first look only remembers the page
      const before = new Set(
        String(old.text || '')
          .split('\n')
          .map(x => x.trim())
          .filter(Boolean)
      );
      const added = text
        .split('\n')
        .map(x => x.trim())
        .filter(x => x && !before.has(x))
        .slice(0, 40)
        .join('\n');
      const w = JSON.parse(r.watch);
      const res = await fireEvent(
        env,
        db,
        r,
        `監看的網頁有變化：${w.url}\n新出現的內容：\n${added || '（版面有變動，請打開網頁確認）'}`
      );
      return J({ ok: true, changed: true, result: res });
    }
    if (path === 'runner/note' && m === 'POST') {
      // a system line from the computer in a bot's own chat (e.g. its browser moved to a Chrome window)
      const bot = clean(body.bot, 64),
        text = clean(body.text, 400);
      const owns = await db.prepare('SELECT id FROM bots WHERE id=? AND user_id=?').bind(bot, U).first();
      if (!owns) return err('找不到', 404);
      if (!text) return J({ ok: true });
      await addMsg(db, U, bot, 'sys', text);
      await bump(db, U);
      return J({ ok: true });
    }
    if (path === 'runner/progress' && m === 'POST') {
      // what the bot is doing now (4.7: step x of y, kind); also tells the computer if 停止, 暫停 or 接手 was pressed
      const p = progressOf(body);
      const jr = await db
        .prepare("SELECT progress, beat, bot_id, paused FROM jobs WHERE id=? AND user_id=? AND status='running'")
        .bind(+body.id, U)
        .first();
      if (!jr) return J({ stop: true });
      if (now() - (jr.beat || 0) > MIN) await db.prepare('UPDATE jobs SET beat=? WHERE id=?').bind(now(), +body.id).run(); // alive (at most one write a minute)
      if (!sameProgress(jr.progress, p)) {
        // a heartbeat with the same report changes nothing for the screens
        await db.batch([
          db.prepare('UPDATE jobs SET progress=? WHERE id=?').bind(JSON.stringify(withTrail(jr.progress, p)), +body.id),
          db.prepare('UPDATE users SET prog=prog+1 WHERE id=?').bind(U)
        ]);
        wake();
      }
      const handed = await db.prepare('SELECT handed FROM live WHERE bot_id=? AND user_id=?').bind(jr.bot_id, U).first();
      return J({ ok: true, hand: !!handed?.handed, pause: !!jr.paused });
    }
    if (path === 'runner/live' && m === 'POST') {
      const bot = clean(body.bot, 64);
      const owns = await db.prepare('SELECT id FROM bots WHERE id=? AND user_id=?').bind(bot, U).first();
      if (!owns) return err('找不到', 404);
      const watching = r => !!r && +r.watch > now() - 15000; // a screen opened this bot's browser in the last 15 s
      if (body.peek) {
        const row = await db.prepare('SELECT handed, watch FROM live WHERE bot_id=? AND user_id=?').bind(bot, U).first();
        return J({ hand: !!row?.handed, watch: watching(row) });
      }
      const data = String(body.data || '');
      if (data.length > 500000) return J({ ok: true, skipped: true });
      const url = clean(body.url, 300),
        title = clean(body.title, 80);
      const cur = await db.prepare('SELECT handed, watch FROM live WHERE bot_id=? AND user_id=?').bind(bot, U).first();
      if (cur)
        await db
          .prepare('UPDATE live SET url=?, title=?, mime=?, data=?, ts=? WHERE bot_id=? AND user_id=?')
          .bind(url, title, 'image/jpeg', data, now(), bot, U)
          .run();
      else
        await db
          .prepare('INSERT INTO live (bot_id,user_id,url,title,mime,data,ts,handed) VALUES (?,?,?,?,?,?,?,0)')
          .bind(bot, U, url, title, 'image/jpeg', data, now())
          .run();
      return J({ ok: true, hand: !!cur?.handed, watch: watching(cur) });
    }
    if (path === 'runner/stored' && m === 'POST') {
      // the host saved an uploaded file into its OCTA folder
      const p = safePath(body.path);
      if (!p) return err('路徑不正確');
      await db.batch([
        db
          .prepare("UPDATE files SET loc='pc', path=?, size=COALESCE(?,size), want=NULL, pc=? WHERE id=? AND user_id=?")
          .bind(p, +body.size || null, null, clean(body.id, 64), U),
        db.prepare('DELETE FROM chunks WHERE file_id=?').bind(clean(body.id, 64))
      ]);
      return J({ ok: true });
    }
    if (path === 'runner/blob' && m === 'POST') {
      // temporary copy of a file someone wants to see
      const id = clean(body.id, 64);
      const f = await db.prepare('SELECT 1 FROM files WHERE id=? AND user_id=?').bind(id, U).first();
      if (!f) return err('找不到檔案', 404);
      if (body.missing) {
        await db.prepare('UPDATE files SET want=NULL WHERE id=?').bind(id).run();
        return J({ ok: true });
      }
      const n = Math.max(0, Math.floor(+body.n || 0)),
        data = String(body.data || '');
      if (data.length > CHUNK + 10) return err('片段太大');
      await db.prepare('INSERT OR REPLACE INTO chunks (file_id,n,data,ts) VALUES (?,?,?,?)').bind(id, n, data, now()).run();
      if (body.last) await db.prepare('UPDATE files SET want=-1 WHERE id=?').bind(id).run();
      return J({ ok: true });
    }
    if (path === 'runner/connector' && m === 'POST') {
      const job = await db.prepare('SELECT id,prompt FROM jobs WHERE id=? AND user_id=?').bind(+body.job, U).first();
      if (!job) return err('找不到這次工作', 404);
      const st = await getSettings(db, U);
      const task = {
        name: clean(body.name, 40),
        action: clean(body.action, 10),
        path: clean(body.path, 200),
        content: clean(body.content, 4000)
      };
      return J(await runConnector(st, task, { approved: /核准[:：]/.test(job.prompt || '') }));
    }
    if (path === 'runner/done' && m === 'POST') return runnerDone(c);
    if (path === 'runner/shot' && m === 'POST') {
      // the screenshot stays on the computer; only where it is goes up
      const job = await db.prepare('SELECT bot_id,conv FROM jobs WHERE id=? AND user_id=?').bind(+body.id, U).first();
      if (!job) return err('找不到任務', 404);
      const p = safePath(body.path),
        name = clean(body.name, 120) || 'screenshot.jpg';
      if (!p) return err('路徑不正確');
      const old = await db.prepare('SELECT shot_file FROM bots WHERE id=? AND user_id=?').bind(job.bot_id, U).first();
      const id = 'file-' + uid();
      const kept =
        old?.shot_file &&
        (await db
          .prepare('SELECT 1 AS n FROM jobs WHERE user_id=? AND shot=? AND err_kind IS NOT NULL')
          .bind(U, old.shot_file)
          .first()); // a failed job's screenshot stays
      await db.batch([
        db
          .prepare("INSERT INTO files (id,user_id,name,mime,data,ts,conv,loc,path,size,pc) VALUES (?,?,?,?,'',?,?,'pc',?,?,?)")
          .bind(id, U, name, mimeOf(name, body.mime), now(), job.conv, p, +body.size || null, null),
        db.prepare('UPDATE bots SET shot_ts=?, shot_file=? WHERE id=? AND user_id=?').bind(now(), id, job.bot_id, U),
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
      const summary =
        body.summary && typeof body.summary === 'object'
          ? JSON.stringify(body.summary).slice(0, 80000)
          : typeof body.summary === 'string'
            ? body.summary.slice(0, 80000)
            : task.summary;
      const status = clean(body.status, 40) || task.status;
      const phase = clean(body.phase, 40) || task.phase;
      await db
        .prepare(
          `UPDATE code_tasks SET status=?, phase=?, role=?, workspace_id=COALESCE(?, workspace_id), branch=COALESCE(?, branch), base_ref=COALESCE(?, base_ref), head_ref=COALESCE(?, head_ref), retries=?, summary=?, updated=? WHERE id=? AND user_id=?`
        )
        .bind(
          status,
          phase,
          clean(body.role, 40) || task.role,
          clean(body.workspaceId, 80) || null,
          clean(body.branch, 120) || null,
          clean(body.baseRef, 80) || null,
          clean(body.headRef, 80) || null,
          Number.isFinite(+body.retries) ? +body.retries : task.retries,
          summary,
          now(),
          id,
          U
        )
        .run();
      const evs = (Array.isArray(body.events) ? body.events : body.event ? [body.event] : []).slice(-12);
      for (const ev of evs) {
        if (!ev || typeof ev !== 'object') continue;
        await db
          .prepare('INSERT INTO code_events (task_id,user_id,ts,role,kind,text,data) VALUES (?,?,?,?,?,?,?)')
          .bind(
            id,
            U,
            now(),
            clean(ev.role, 40),
            clean(ev.kind, 40) || 'log',
            clean(ev.text, 1500),
            ev.data ? JSON.stringify(ev.data).slice(0, 8000) : null
          )
          .run();
      }
      if (task.job_id)
        await db
          .prepare("UPDATE jobs SET progress=? WHERE id=? AND user_id=? AND status='running'")
          .bind(clean(phase, 120), task.job_id, U)
          .run();
      const r = J({ ok: true, cancel: !!task.cancel || status === 'cancelled' });
      r._u = U;
      return r;
    }
    if (path === 'runner/code/resume' && m === 'POST') {
      const id = clean(body.taskId || body.id, 80);
      const task = await db.prepare('SELECT * FROM code_tasks WHERE id=? AND user_id=?').bind(id, U).first();
      if (!task) return J({ continue: false, gone: true });
      if (task.cancel) return J({ continue: false, cancel: true });
      const job = task.job_id
        ? await db
            .prepare("SELECT * FROM jobs WHERE id=? AND user_id=? AND kind='code' AND status='running'")
            .bind(task.job_id, U)
            .first()
        : null;
      if (!job) return J({ continue: false });
      const repo = await db.prepare('SELECT * FROM code_repos WHERE id=? AND user_id=?').bind(task.repo_id, U).first();
      if (!repo) return J({ continue: false, gone: true });
      return J({
        continue: true,
        job: { id: job.id, kind: 'code', task: publicCodeTask(task), repo: { id: repo.id, name: repo.name, path: repo.path } }
      });
    }
    return err('未知的執行器路徑', 404);
  }
}
