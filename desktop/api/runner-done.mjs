// runner/done: a job finished. Saves the reply, memory, routines, hand-offs and the next step.
import {
  FAIL_KINDS,
  MAX_AUTO_RETRY,
  autoRetryable,
  classifyJobFailure,
  classifyModelFailure,
  decideRoute,
  failureNotice,
  replyIsProviderRefusal,
  retryPrompt,
  stripRetryNote
} from '../lib/model-route.mjs';
import {
  BG,
  LOGIN_WAIT,
  autoStandby,
  calmReply,
  mentionAsks,
  mentionLine,
  mentionsIn,
  missingResult,
  noSpaces,
  passed,
  privateAsk,
  viaOf
} from './chat.mjs';
import { addJob, addMsg, bump, getSettings, loadAll, putSettings } from './db.mjs';
import { ENGINE_NAMES, avatarOk, chainIndex, resetAt } from './engines.mjs';
import { mimeOf, safePath } from './files.mjs';
import { PARTIAL_TAG } from './jobs.mjs';
import { REVIEW_TAG, parseManuals, saveManuals, statAdd } from './memory.mjs';
import { needsYou, sendNotify } from './notify.mjs';
import {
  moveTaskSchedules,
  nextText,
  routineEnded,
  ruleRescue,
  saveRoutine,
  scheduleRescue,
  triggerFrom,
  userTurn
} from './routines.mjs';
import { applySchedules, routinePlan } from './schedule.mjs';
import { MAX_ASK_DEPTH, clean, err, now, uid } from './util.mjs';

export async function runnerDone(c) {
  const { env, db, body, U, ok } = c;
  const job = await db.prepare("SELECT * FROM jobs WHERE id=? AND user_id=? AND status='running'").bind(+body.id, U).first();
  if (!job) return err('找不到執行中的任務', 404);
  // stopped halfway: what was already done goes out now (not lost with the failure); the retry continues from it
  if (job.kind === 'chat' && body.ok === false && String(body.text || '').includes(PARTIAL_TAG)) {
    const [head, ...rest] = String(body.text).split(PARTIAL_TAG),
      part = rest.join(PARTIAL_TAG).trim();
    body.text = head.trim();
    body.stalled = true;
    body.err_kind = body.err_kind || 'timeout';
    if (part)
      await addMsg(
        db,
        U,
        job.conv,
        job.bot_id,
        `⏸ 這次做到一半就停了，先送出已完成的部分（剩下的會自動接著做）：\n${clean(part, 3500)}`
      );
  }
  let good = body.ok !== false;
  let fail = null; // { kind, msg, ai }: why a chat job finally failed (工作紀錄, notification)
  // Classify the failure before choosing a backup. Quota, HTTP 429, auth, and
  // transient outages are not the same action, and a code or tool failure does not switch models.
  // A model that exits 0 and only says the quota is gone is the same failure: call the backup,
  // and do not show that sentence as the answer.
  if (job.kind === 'chat') {
    const b = (await loadAll(db, U)).bots.find(x => x.id === job.bot_id);
    const refused =
      good && !body.stopped && replyIsProviderRefusal(body.text, { files: Array.isArray(body.files) ? body.files.length : 0 });
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
        kind,
        tries: +job.tries || 0,
        index,
        resetsAt: /resets? in|小時|分鐘/i.test(raw) ? resetAt(raw) : 0,
        now: now(),
        chain: chain.map(id => ({ id, spentUntil: st.spent[id] || 0 }))
      });
      const lab = x => {
        const [e, mm] = String(x || '').split('|');
        return (ENGINE_NAMES[e] || e) + (mm ? `（${mm}）` : '');
      };
      const why =
        decision.reason === 'quota'
          ? '額度用完'
          : decision.reason === 'rate_limit'
            ? '被限流'
            : decision.reason === 'unavailable'
              ? '這台電腦還沒安裝'
              : '暫時故障';
      if (decision.action === 'retry' || decision.action === 'switch') {
        if (decision.spend) st.spent[chain[index]] = resetAt(raw);
        await putSettings(db, U, st);
        const nextEng = decision.action === 'switch' ? chain[decision.index] : current;
        const nextTries = decision.action === 'retry' ? (+job.tries || 0) + 1 : 0;
        const fk = classifyJobFailure(raw, { hint: body.err_kind, stalled: !!body.stalled });
        const once = await db
          .prepare("UPDATE jobs SET status='error', finished=?, result=?, err_kind=?, err_msg=? WHERE id=? AND status='running'")
          .bind(now(), clean(raw, 500), fk, clean(raw.replace(/^⚠\s*/, ''), 500), job.id)
          .run();
        if (!once.meta.changes) return ok(); // the same result was reported twice
        // the second try on the same model carries the reason and asks for another way
        const nextPrompt = decision.action === 'retry' ? retryPrompt(job.prompt, nextTries, fk, raw) : stripRetryNote(job.prompt);
        await db
          .prepare(
            'INSERT INTO jobs (user_id,conv,bot_id,chain,prompt,created,depth,eng,tries,retry_of,via,routine) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
          )
          .bind(
            U,
            job.conv,
            job.bot_id,
            job.chain,
            nextPrompt,
            now(),
            job.depth || 0,
            nextEng,
            nextTries,
            job.id,
            job.via || null,
            job.routine || null
          )
          .run();
        const note =
          decision.action === 'switch'
            ? `「${b.name}」的 ${lab(chain[index])} ${why}，改由 ${lab(nextEng)} 接手。已完成的對話會保留，不會重做已完成的步驟。`
            : `「${b.name}」的 ${lab(current)} ${decision.reason === 'rate_limit' ? '被限流，同一個模型再試一次' : '暫時故障，同一個模型再試一次'}（第 ${nextTries} 次）。`;
        await addMsg(db, U, job.conv, 'sys', note);
        await bump(db, U);
        return ok();
      }
      if (decision.message) body.text = (decision.reason === 'cancelled' ? '' : '⚠ ') + decision.message;
      if (decision.reason !== 'cancelled') {
        fail = {
          kind: classifyJobFailure(raw, { hint: body.err_kind, stalled: !!body.stalled }),
          msg: clean(raw.replace(/^⚠\s*/, ''), 500),
          ai: decision.reason === 'auth'
        };
        // timeouts, changed pages, tool errors and unknown errors: the same job again (at most twice),
        // the second time with the reason attached. Quota went to the backup AI above; a sign-in is never retried.
        const n = (+job.tries || 0) + 1;
        if (['execution', 'tool'].includes(decision.reason) && autoRetryable(fail.kind, raw) && n <= MAX_AUTO_RETRY) {
          const once = await db
            .prepare(
              "UPDATE jobs SET status='error', finished=?, result=?, err_kind=?, err_msg=? WHERE id=? AND status='running'"
            )
            .bind(now(), clean(raw, 500), fail.kind, fail.msg, job.id)
            .run();
          if (!once.meta.changes) return ok(); // the same result was reported twice
          await db
            .prepare(
              'INSERT INTO jobs (user_id,conv,bot_id,chain,prompt,created,depth,eng,tries,retry_of,via,routine) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
            )
            .bind(
              U,
              job.conv,
              job.bot_id,
              job.chain,
              retryPrompt(job.prompt, n, fail.kind, raw),
              now(),
              job.depth || 0,
              job.eng || null,
              n,
              job.id,
              job.via || null,
              job.routine || null
            )
            .run();
          await addMsg(
            db,
            U,
            job.conv,
            'sys',
            `「${b.name}」這次沒做成（${FAIL_KINDS[fail.kind].label}），自動重試第 ${n} 次${n >= MAX_AUTO_RETRY ? '，這次會換一種方法' : ''}…`
          );
          await bump(db, U);
          return ok();
        }
      }
    }
  }
  if (job.kind === 'test' || job.kind === 'list' || job.kind === 'install') {
    await db
      .prepare('UPDATE jobs SET status=?, finished=?, result=? WHERE id=?')
      .bind(good ? 'done' : 'error', now(), clean(body.text, 3000), job.id)
      .run();
    return ok();
  }
  if (job.kind === 'code') {
    await db
      .prepare('UPDATE jobs SET status=?, finished=?, result=? WHERE id=?')
      .bind(good ? 'done' : 'error', now(), clean(body.text, 3000), job.id)
      .run();
    return ok();
  }
  if (job.kind === 'open') {
    // the phone asked the computer to open a page: keep the address, don't drop a chat bubble
    await db
      .prepare('UPDATE jobs SET status=?, finished=?, result=? WHERE id=?')
      .bind(good ? 'done' : 'error', now(), clean(body.text, 500), job.id)
      .run();
    if (body.page)
      await db.prepare('UPDATE bots SET page=? WHERE id=? AND user_id=?').bind(clean(body.page, 500), job.bot_id, U).run();
    if (!good) await addMsg(db, U, job.conv, 'sys', clean(body.text, 500) || '⚠ 無法打開瀏覽器');
    return ok();
  }
  let text = clean(body.text, 20000) || (good ? '（完成，無回覆內容）' : '⚠ 執行失敗');
  if (fail) {
    // the final failure says why in plain words; a website sign-in shows the login card (接手／繼續)
    const fk = FAIL_KINDS[fail.kind] || FAIL_KINDS.unknown;
    if (fail.kind === 'not_logged_in' && !fail.ai && !LOGIN_WAIT.test(text))
      text = '⚠ 需要使用者在電腦上登入。' + text.replace(/^⚠\s*/, '');
    if (!/^⚠/.test(text)) text = '⚠ ' + text;
    text += `\n原因：${fk.label}。${fail.ai ? '' : fk.next}`;
  }
  if (good && job.kind === 'chat' && text.includes('【回覆】'))
    text = text.slice(text.lastIndexOf('【回覆】') + 4).trim() || '（完成）'; // drop the running commentary before the reply
  if (good && job.kind === 'chat') text = calmReply(text) || '（完成）';
  // 📛名稱：🎮 遊戲員 — a new bot names itself after it learns its job
  if (good && job.kind === 'chat' && /📛/.test(text)) {
    let nm = null;
    text =
      text
        .replace(/^\s*📛\s*名稱[:：]\s*(.+)$/gm, (_, v) => {
          nm = nm || v;
          return '';
        })
        .trim() || '（好的）';
    const self = await db.prepare('SELECT name, avatar FROM bots WHERE id=? AND user_id=?').bind(job.bot_id, U).first();
    if (nm && self && /^新機器人\d*$/.test(self.name)) {
      const mm = nm.trim().match(/^(\p{Extended_Pictographic}[\uFE0F\u200D\p{Extended_Pictographic}]*)?\s*(.+)$/u);
      let name = clean(noSpaces(clean((mm?.[2] || '').replace(/[「」"']/g, ''), 20)), 20);
      if (name) {
        const taken = await db
          .prepare('SELECT 1 FROM bots WHERE user_id=? AND name=? AND id<>?')
          .bind(U, name, job.bot_id)
          .first();
        if (taken) name = clean(name + '2', 20);
        await db
          .prepare('UPDATE bots SET name=?, avatar=? WHERE id=? AND user_id=?')
          .bind(name, mm?.[1] ? avatarOk(mm[1]) : self.avatar, job.bot_id, U)
          .run();
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
  const remember = [],
    sitesNew = [];
  // 🧩技能：名稱 … 🧩結束 — a workflow saved to rerun later (shown in the / menu)
  const skillsNew = [],
    factsNew = [],
    manualsNew = [];
  if (good && job.kind === 'chat') {
    text = text.replace(/^\s*📌\s*記住[:：]\s*(.+)$/gm, (_, t) => {
      const v = clean(t, 300);
      if (v) remember.push(v);
      return '';
    });
    // 🗺️網站筆記：網域｜做法 — how to get around a website, shared with every bot
    text = text.replace(/^\s*🗺️?\s*網站筆記[:：]\s*([^｜|\n]+)\s*[｜|]\s*(.+)$/gm, (_, d, t) => {
      const dom = clean(d, 60)
          .toLowerCase()
          .replace(/^https?:\/\//, '')
          .replace(/\/.*$/, ''),
        v = clean(t, 300);
      if (dom && v) sitesNew.push([dom, v]);
      return '';
    });
    text = text.replace(/🧩\s*技能[:：]\s*([^\n]+)\n([\s\S]*?)🧩\s*結束/g, (_, n, st2) => {
      const name = clean(n, 40),
        steps = clean(st2, 3000);
      if (name && steps) skillsNew.push({ name, steps });
      return '';
    });
    // 📇事實：… — a fixed piece of data (list, address, account name); 📘手冊：名稱｜步驟 — how a multi-step job was done
    text = text.replace(/^\s*📇\s*事實[:：]\s*(.+)$/gm, (_, t) => {
      const v = clean(t, 300);
      if (v) factsNew.push(v);
      return '';
    });
    const pm = parseManuals(text);
    text = pm.text;
    manualsNew.push(...pm.manuals);
    if (job.prompt.startsWith(REVIEW_TAG)) {
      remember.length = 0;
      factsNew.length = 0;
      manualsNew.length = 0;
    } // the weekly review only suggests; rules change when the user approves
    text = text.trim() || '（已記下）';
  }
  // ⏰例行任務：名稱｜08:00,13:30｜要做的事 — the bot sets up a daily routine the user asked for
  const plans = [];
  // ⏰刪除／停用／啟用：名稱、名稱 — the bot manages its own routines instead of asking the user to do it by hand
  const routineOps = [];
  if (good && job.kind === 'chat' && /⏰\s*(刪除|停用|啟用)/.test(text)) {
    text =
      text
        .replace(/^\s*⏰\s*(刪除|停用|啟用)(?:例行任務)?[:：]\s*(.+)$/gm, (_, op, list) => {
          for (const n of String(list)
            .split(/[、，,；;]+/)
            .map(x => clean(x.replace(/^[「『"]|[」』"]$/g, ''), 40))
            .filter(Boolean))
            routineOps.push([op, n]);
          return '';
        })
        .trim() || '（好的）';
  }
  if (good && job.kind === 'chat') {
    text =
      text
        .replace(/^\s*⏰\s*例行任務[:：]\s*(.+?)\s*[｜|]\s*(.+?)\s*[｜|]\s*(.+)$/gm, (_, n, t, p) => {
          const plan = routinePlan(n, t, p);
          if (plan) plans.push(plan);
          return '';
        })
        .trim() || '（已設定例行任務）';
    if (userTurn(job)) applySchedules(plans, job.prompt, text);
    else plans.length = 0; // a routine run, a colleague's question or a retry doesn't make routines (they kept growing back)
  }
  const claimedBuilt = good && job.kind === 'chat' && /排程已建好|例行任務已建好|已建立例行任務|已建好例行/.test(text);
  const tk = Number.isFinite(+body.tokens) && body.tokens !== null ? Math.max(0, Math.round(+body.tokens)) : null;
  // only once: a runner that retries runner/done must not post the reply (and start the next step) twice
  const fin = await db
    .prepare("UPDATE jobs SET status=?, finished=?, tokens=?, result=COALESCE(?, result) WHERE id=? AND status='running'")
    .bind(good ? 'done' : 'error', now(), tk, job.via || BG.test(job.prompt) ? text.slice(0, 1500) : null, job.id)
    .run();
  if (!fin.meta.changes) return ok();
  if (job.kind === 'chat' && !body.stopped) await statAdd(db, env, U, job, good, tk, !!body.browser);

  if (body.nskills && typeof body.nskills === 'object' && JSON.stringify(body.nskills).length < 300000) {
    // the bot's own Claude Code skills, kept with the account
    const st = await getSettings(db, U);
    st.nskills = st.nskills || {};
    st.nskills[job.bot_id] = { h: clean(body.nskills.h, 64), files: body.nskills.files || {} };
    await putSettings(db, U, st);
  }
  // files the bot made in its 輸出 folder become attachments of the reply
  const outs = [];
  for (const f of (Array.isArray(body.files) ? body.files : []).slice(0, 8)) {
    const p = safePath(f.path),
      name = clean(f.name, 120);
    if (!p || !name) continue;
    const id = 'file-' + uid(),
      mime = mimeOf(name, f.mime);
    await db
      .prepare("INSERT INTO files (id,user_id,name,mime,data,ts,conv,loc,path,size,pc) VALUES (?,?,?,?,'',?,?,'pc',?,?,?)")
      .bind(id, U, name, mime, now(), job.conv, p, +f.size || null, null)
      .run();
    outs.push({ id, name, mime });
  }
  const isGroup = (await loadAll(db, U)).groups.some(g => g.id === job.conv);
  const quiet =
    isGroup || job.prompt.startsWith('（例行任務') || BG.test(job.prompt) || /^同事「[^」]*」回覆了你在背景問/.test(job.prompt); // where "（略過）" means nothing to show
  let shown = text;
  if (isGroup && job.kind === 'chat') {
    const all2 = await loadAll(db, U),
      g2 = all2.groups.find(g => g.id === job.conv),
      mates = all2.bots.filter(b => g2?.members.includes(b.id) && b.id !== job.bot_id);
    shown = text
      .split('\n')
      .filter(l => {
        const ml = mentionLine(l, mates);
        return !(ml && privateAsk(ml.rest, job.prompt));
      })
      .join('\n')
      .trim();
  }
  // 4.1: what is not conversation goes to the work panel: answers to another bot's background request,
  // a job that failed (a sign-in request stays: the person has to act on it), the compacted progress note
  const vk = viaOf(job)?.k;
  const msgKind =
    vk === 'ask' || vk === 'give' || BG.test(job.prompt) ? 'bg' : !good && !LOGIN_WAIT.test(shown) ? 'fail' : vk === 'compact' ? 'note' : null;
  if (shown && !(quiet && passed(shown) && !outs.length)) await addMsg(db, U, job.conv, job.bot_id, shown, outs, null, msgKind);
  if (job.routine && job.kind === 'chat') {
    // 排程看得到有沒有跑: this run's result goes on the routine
    const st0 = !good || body.stopped || LOGIN_WAIT.test(text) ? 'error' : passed(text) && !outs.length ? 'skipped' : 'done';
    const rr = await routineEnded(db, U, job, st0, body.stopped ? '使用者按了停止' : text);
    if (rr && st0 === 'error' && !body.stopped) {
      const nx = nextText(env, rr);
      await addMsg(
        db,
        U,
        job.conv,
        'sys',
        `⚠ 例行任務「${rr.name}」這次沒有完成${fail ? `（${(FAIL_KINDS[fail.kind] || FAIL_KINDS.unknown).label}）` : LOGIN_WAIT.test(text) ? '（要先登入）' : ''}。${nx ? `下次 ${nx} 會再執行；` : ''}要現在重做，按上面的「↻ 重試」或直接叫它做。`
      );
    }
  }
  if (remember.length || skillsNew.length || sitesNew.length || factsNew.length || manualsNew.length) {
    const st = await getSettings(db, U);
    if (factsNew.length) {
      st.facts = st.facts || {};
      st.facts[job.bot_id] = [...new Set([...(st.facts[job.bot_id] || []), ...factsNew])].slice(-60);
    }
    if (manualsNew.length) {
      st.manuals = st.manuals || {};
      st.manuals[job.bot_id] = saveManuals(st.manuals[job.bot_id], manualsNew);
    }
    if (sitesNew.length) {
      st.sites = st.sites || {};
      for (const [d, v] of sitesNew) st.sites[d] = [...new Set([...(st.sites[d] || []), v])].slice(-12);
    }
    if (remember.length) {
      st.memory = st.memory || {};
      st.memory[job.bot_id] = [...new Set([...(st.memory[job.bot_id] || []), ...remember])].slice(-40);
    }
    if (skillsNew.length) {
      st.skills = st.skills || {};
      const cur = (st.skills[job.bot_id] || []).filter(x => !skillsNew.some(n => n.name === x.name));
      st.skills[job.bot_id] = [...cur, ...skillsNew].slice(-20);
    }
    await putSettings(db, U, st);
    if (remember.length) await addMsg(db, U, job.conv, 'sys', `已記住：${remember.join('；').slice(0, 200)}`);
    for (const k of skillsNew) await addMsg(db, U, job.conv, 'sys', `已存成技能「${k.name}」，輸入 / 就能叫它`);
    if (factsNew.length) await addMsg(db, U, job.conv, 'sys', `已記下事實：${factsNew.join('；').slice(0, 200)}`);
    for (const k of manualsNew)
      await addMsg(db, U, job.conv, 'sys', `已存成做事手冊「${k.name}」，下次做類似的事會照著做（任務設定可檢視、刪除）`);
  }
  const cv = viaOf(job);
  if (cv?.k === 'compact' && +cv.from > 0) {
    const del = await db.prepare('DELETE FROM messages WHERE user_id=? AND conv=? AND id<?').bind(U, job.conv, +cv.from).run();
    await db.prepare("DELETE FROM messages WHERE user_id=? AND conv=? AND id=? AND by_='sys'").bind(U, job.conv, +cv.from).run();
    await addMsg(
      db,
      U,
      job.conv,
      'sys',
      `🗜 已壓縮：刪掉 ${del.meta?.changes || 0} 則舊訊息，重點已寫進記憶，上面是目前進度。之後每次送給 AI 的文字會少很多。`
    );
  }
  for (const r of plans.filter(x => x.trigger).slice(0, 3)) {
    // event-triggered routines the bot set up
    const old = await db
      .prepare('SELECT * FROM routines WHERE user_id=? AND conv=? AND name=?')
      .bind(U, job.conv, r.name)
      .first();
    let trig;
    try {
      trig = triggerFrom(r, old);
    } catch {
      continue;
    }
    if (old)
      await db
        .prepare('UPDATE routines SET prompt=?,enabled=1,hook=?,watch=?,wstate=NULL WHERE id=?')
        .bind(r.prompt, trig.hook, trig.watch, old.id)
        .run();
    else
      await db
        .prepare(
          "INSERT INTO routines (id,user_id,conv,name,prompt,times,enabled,fired,created,hook,watch) VALUES (?,?,?,?,?,'[]',1,'{}',?,?,?)"
        )
        .bind('r-' + uid(), U, job.conv, r.name, r.prompt, now(), trig.hook, trig.watch)
        .run();
    await addMsg(
      db,
      U,
      job.conv,
      'sys',
      r.trigger === 'watch'
        ? `已設定例行任務「${r.name}」：網頁 ${r.watch.url} 有變化時開始（每 ${r.watch.every || 10} 分鐘檢查）`
        : `已設定例行任務「${r.name}」：外部事件觸發。觸發網址在任務設定 → 例行任務裡`
    );
  }
  for (const r of plans.filter(x => !x.trigger).slice(0, 12)) await saveRoutine(env, db, U, job.conv, r);
  if (routineOps.length) {
    const mine = (
      await db
        .prepare('SELECT id,name,enabled FROM routines WHERE user_id=? AND conv IN (?,?)')
        .bind(U, job.conv, job.bot_id)
        .all()
    ).results;
    const done = [],
      miss = [];
    for (const [op, n] of routineOps.slice(0, 30)) {
      const hits = mine.filter(r => r.name === n);
      const hit = hits.length ? hits : mine.filter(r => r.name.includes(n) || n.includes(r.name));
      if (!hit.length || (hits.length === 0 && hit.length > 1)) {
        miss.push(n);
        continue;
      }
      for (const r of hit) {
        if (op === '刪除') await db.prepare('DELETE FROM routines WHERE id=? AND user_id=?').bind(r.id, U).run();
        else
          await db
            .prepare('UPDATE routines SET enabled=? WHERE id=? AND user_id=?')
            .bind(op === '啟用' ? 1 : 0, r.id, U)
            .run();
        done.push(`${op}「${r.name}」`);
      }
    }
    if (done.length) await addMsg(db, U, job.conv, 'sys', `例行任務已${done.join('、')}`);
    if (miss.length) await addMsg(db, U, job.conv, 'sys', `找不到這些例行任務，沒有變更：${miss.join('、')}`);
  }
  if (claimedBuilt && !plans.length)
    await addMsg(db, U, job.conv, 'sys', '這次回覆說排程已建好，但沒有寫出可以建立的時間，所以沒有新增例行任務。');
  // 自己排時間 / 被糾正就記規則: the user asked for a schedule or set a rule, and the reply didn't do it → one-click ✅待確認
  if (good && job.kind === 'chat' && userTurn(job)) {
    const all3 = await loadAll(db, U),
      grp3 = all3.groups.find(g => g.id === job.conv),
      self3 = all3.bots.find(b => b.id === job.bot_id);
    const forMe =
      !grp3 ||
      (self3 && mentionsIn(job.prompt, [self3])[self3.id] !== undefined) ||
      (grp3.members[0] === job.bot_id &&
        !Object.keys(
          mentionsIn(
            job.prompt,
            all3.bots.filter(b => grp3.members.includes(b.id))
          )
        ).length);
    if (forMe && !plans.length && !routineOps.length) await scheduleRescue(db, U, job, all3);
    if (forMe && !remember.length && !factsNew.length) await ruleRescue(db, U, job);
  }
  if (learned && learned.length >= 4) {
    const cur = await db.prepare('SELECT task FROM bots WHERE id=? AND user_id=?').bind(job.bot_id, U).first();
    // 排程只寫一份: times in the new standing task move to routines (made when missing; an existing one wins)
    const moved = await moveTaskSchedules(env, db, U, job.bot_id, job.conv, learned);
    if (moved) learned = moved.task;
    if (cur && cur.task !== learned && learned.length >= 2) {
      await db.prepare('UPDATE bots SET task=? WHERE id=? AND user_id=?').bind(learned, job.bot_id, U).run();
      await addMsg(
        db,
        U,
        job.conv,
        'sys',
        `已自動更新「${(await db.prepare('SELECT name FROM bots WHERE id=?').bind(job.bot_id).first())?.name || '機器人'}」的指定任務，可在任務設定修改`
      );
      if (!String(cur.task || '').trim()) await autoStandby(db, U, job.bot_id);
    }
  }
  const earlierMine =
    job.kind === 'chat'
      ? (
          await db
            .prepare('SELECT text FROM messages WHERE user_id=? AND conv=? AND by_=? ORDER BY id DESC LIMIT 2')
            .bind(U, job.conv, job.bot_id)
            .all()
        ).results
      : [];
  const loginStuck = good && job.kind === 'chat' && LOGIN_WAIT.test(text);
  const loginAgain = loginStuck && earlierMine.length >= 2 && LOGIN_WAIT.test(earlierMine[1]?.text || '');
  // paused for a sign-in counts as not_logged_in in 工作紀錄, even though the reply itself came back fine
  if (fail || loginStuck)
    await db
      .prepare('UPDATE jobs SET err_kind=?, err_msg=? WHERE id=?')
      .bind(fail ? fail.kind : 'not_logged_in', fail ? fail.msg : clean(text, 500), job.id)
      .run();
  if (job.kind === 'chat' && !loginAgain) {
    const st = await getSettings(db, U);
    const who = (await db.prepare('SELECT name FROM bots WHERE id=?').bind(job.bot_id).first())?.name || '機器人';
    const photo =
      (fail || loginStuck) &&
      typeof body.shot === 'string' &&
      /^[A-Za-z0-9+/=]+$/.test(body.shot.slice(0, 200)) &&
      body.shot.length < 900000
        ? body.shot
        : null;
    if (fail || loginStuck)
      await sendNotify(
        env,
        st,
        failureNotice(who, job.prompt, fail ? fail.kind : 'not_logged_in', fail ? fail.msg : text),
        photo
      );
    else if (!good || needsYou(text)) await sendNotify(env, st, `【OCTA】${who} 需要你處理：\n${text.slice(0, 600)}`);
    else if (st.notifyAll && !JSON.parse(job.chain).length)
      await sendNotify(env, st, `【OCTA】${who} 完成：\n${text.slice(0, 600)}`);
  }
  if (body.page)
    await db.prepare('UPDATE bots SET page=? WHERE id=? AND user_id=?').bind(clean(body.page, 500), job.bot_id, U).run();
  if (!good && job.kind === 'chat') {
    const bgF = job.prompt.match(BG),
      via = viaOf(job);
    const asker = bgF && (await db.prepare('SELECT id FROM bots WHERE id=? AND user_id=?').bind(bgF[1], U).first());
    const me2 = (await db.prepare('SELECT name FROM bots WHERE id=?').bind(job.bot_id).first())?.name || '同事';
    if (asker) {
      await addMsg(
        db,
        U,
        via?.c && (await db.prepare('SELECT 1 AS n FROM groups_ WHERE id=? AND user_id=?').bind(via.c, U).first())
          ? via.c
          : asker.id,
        'sys',
        `🔁 「${me2}」沒能完成${bgF[2] === 'ask' ? '回覆' : '交辦'}：${text.slice(0, 300)}`
      );
      await bump(db, U);
    } else if (via?.k === 'ask' && JSON.parse(job.chain).length) {
      await addJob(db, U, job.conv, JSON.parse(job.chain), job.prompt, job.depth, job.routine);
      await bump(db, U);
    }
  }
  if (!good || job.kind !== 'chat') return ok();
  // Two replies in a row are stuck on the same sign-in: stop the chain and say so once.
  if (loginStuck) {
    if (loginAgain) {
      const noted = await db
        .prepare(
          "SELECT 1 AS n FROM messages WHERE user_id=? AND conv=? AND by_='sys' AND text LIKE '需要你在電腦上登入%' LIMIT 1"
        )
        .bind(U, job.conv)
        .first();
      if (!noted) await addMsg(db, U, job.conv, 'sys', '需要你在電腦上登入。登入好之後傳一句話，我就從這一頁繼續。');
    }
    return ok();
  }
  const side = viaOf(job)?.k === 'side';
  // a send / upload job that does not say whether it went out; 旁聊 that needs the browser runs again after the work
  if (!side && missingResult(job.prompt, text))
    await addMsg(
      db,
      U,
      job.conv,
      'sys',
      '⚠ 這件要傳送或上傳，但回覆沒有寫明結果（✅ 完成／⚠ 沒做成）。請它回頭確認有沒有真的送出。'
    );
  if (side && body.later) {
    await addJob(db, U, job.conv, [job.bot_id], job.prompt, job.depth);
    await bump(db, U);
  }
  // the bot stopped halfway ("還沒完成…"): one automatic follow-up, then it has to stop
  const round = +((job.prompt.match(/^（自動接續 (\d+)）/) || [])[1] || 0);
  if (
    !side &&
    round < 1 &&
    !passed(text) &&
    /(還沒|尚未|沒能|未能|無法)[^。\n]{0,8}(完成|核對|查完|核完|查到|整理|列出)|還沒查|先供參考|不能當作完整|不足以/.test(text) &&
    !LOGIN_WAIT.test(text) &&
    classifyModelFailure(text) !== 'quota' &&
    classifyModelFailure(text) !== 'rate_limit'
  ) {
    const orig = job.prompt.replace(/^（自動接續 \d+）[\s\S]*?原本的指示：/, '');
    await addMsg(db, U, job.conv, 'sys', '還沒做完，請它接著把剩下的做完…');
    await addJob(
      db,
      U,
      job.conv,
      [
        {
          b: job.bot_id,
          p: `（自動接續 ${round + 1}）上一則沒做完。只補還沒做的那一步。如果要登入，整則只寫一次「需要使用者在電腦上登入」和網站名稱，然後停下。不要把同一句再寫一遍，也不要編畫面上沒有的房號或姓名。\n原本的指示：${orig}`
        },
        ...JSON.parse(job.chain)
      ],
      orig,
      job.depth,
      job.routine
    );
    await bump(db, U);
    return ok();
  }
  let rest = JSON.parse(job.chain).map(s => (typeof s === 'string' ? { b: s, p: job.prompt } : s));
  // a bot asks a colleague in the same 分區: a line starting with "@名字 問題"
  const { bots, groups } = await loadAll(db, U);
  const self = bots.find(b => b.id === job.bot_id),
    grp = groups.find(g => g.id === job.conv);
  const asks = [],
    gives = [];
  // a background message finished: hand the answer back to the bot that sent it, where it was talking (its own chat or the group)
  const bg = job.prompt.match(BG),
    from = bg && bots.find(b => b.id === bg[1]);
  const back = viaOf(job)?.c,
    backConv = back && (bots.some(b => b.id === back) || groups.some(g => g.id === back)) ? back : from?.id;
  if (from && self && !passed(text)) {
    await addMsg(db, U, backConv, 'sys', `🔁 「${self.name}」${bg[2] === 'ask' ? '回覆' : '完成交辦'}：${text.slice(0, 800)}`);
    if (bg[2] === 'ask' && job.depth < MAX_ASK_DEPTH)
      await addJob(
        db,
        U,
        backConv,
        [
          {
            b: from.id,
            p: `同事「${self.name}」回覆了你在背景問的問題：\n${text.slice(0, 3000)}\n\n請根據回覆繼續你原本在做的工作（看前面的對話）${backConv !== from.id ? '；在群組只回使用者要的最後結果（一兩句），不要轉述問答過程' : ''}；已經沒事就只回「（略過）」。`
          }
        ],
        '',
        job.depth + 1
      );
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
      const hand = said.match(/^交接\s*[:：]?\s*(.+)$/); // "@名字 交接：…" passes the whole job on; no need to come back
      if (!hand && !mentionAsks(said, to, job.prompt)) continue; // "@甲 收到／好喔／謝謝" or an answer back to the one who asked: no new round (stops bots thanking each other in a loop)
      if (!grp || priv) {
        // outside a group, or asked privately: the other bot works on it in the background, in its own chat
        const what = hand ? hand[1] : said;
        await addMsg(db, U, to.id, 'sys', `🔁 「${self.name}」${hand ? '交辦' : '問'}：${what.slice(0, 600)}`);
        await addJob(
          db,
          U,
          to.id,
          [
            {
              b: to.id,
              v: { f: self.id, k: hand ? 'give' : 'ask', w: what.slice(0, 300), c: job.conv },
              p: hand
                ? `〔背景:${self.id}:give〕同事「${self.name}」交辦給你：${what}\n請照你的職責完成，最後簡短回報結果，回報會自動傳給${self.name}。`
                : `〔背景:${self.id}:ask〕同事「${self.name}」在背景問你：${what}\n請直接回答，回答會自動傳給${self.name}。`
            }
          ],
          '',
          job.depth + 1
        );
        gives.push({ b: to.id });
        continue;
      }
      if (hand)
        gives.push({
          b: to.id,
          v: { f: self.id, k: 'give', w: hand[1].slice(0, 300) },
          p: `${self.name} 把工作交接給你：${hand[1]}\n（原本的指示：${job.prompt.slice(0, 1500)}）\n請接手完成並回報。`
        });
      else
        asks.push({
          b: to.id,
          v: { f: self.id, k: 'ask', w: said.slice(0, 300) },
          p: `${self.name} 問你：${said}\n請直接回答 ${self.name}。`
        });
    }
  }
  // a group hand-off: the member it went to is next in line and does it once; its own later turn for this same instruction is dropped.
  // In a parallel group it may already be waiting on this message: it reads the hand-off in the chat, so it isn't queued twice.
  const handed = [];
  for (const g of gives) {
    if (!g.p) continue;
    const waiting = await db
      .prepare("SELECT 1 AS n FROM jobs WHERE user_id=? AND conv=? AND bot_id=? AND status='pending' LIMIT 1")
      .bind(U, job.conv, g.b)
      .first();
    if (!waiting) handed.push(g);
  }
  if (gives.some(g => g.p)) rest = [...handed, ...rest.filter(s => !gives.some(g => g.p && g.b === s.b))];
  if (asks.length)
    rest = [...asks, { b: self.id, p: `同事已在上面回覆你的問題，請根據回覆繼續完成原本的指示：${job.prompt}` }, ...rest];
  if (gives.length || from) await bump(db, U);
  await addJob(db, U, job.conv, rest, job.prompt, job.depth + (asks.length || handed.length ? 1 : 0), job.routine);
  return ok();
}
