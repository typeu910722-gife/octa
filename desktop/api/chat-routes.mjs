// Routes for the open app: long-poll, state, messages, compact, live view, opening a bot's browser.
import { COMPACT_PROMPT, backstageItems, busyTurn, enqueueTurn } from './chat.mjs';
import { addJob, addMsg, bump, getSettings, loadAll, nap, putSettings } from './db.mjs';
import { cloneFile } from './files.mjs';
import { applyRuleUpdates, groupAsk } from './memory.mjs';
import { noteListChange } from './memory-edit.mjs';
import { ownApproval, routinesOut } from './routines.mjs';
import { localNow } from './schedule.mjs';
import { busyRows, queueInfo } from './progress.mjs';
import { metaOf } from './reply-meta.mjs';
import { DAY, J, WAIT_MS, WARM, clean, err, now } from './util.mjs';

// what is running now. bg: the bot is answering / doing what another bot asked (its avatar shows it chatting);
// job: the id, for the work panel's timeline; created: when it was queued
const BUSY_SQL = `SELECT id AS job,conv,bot_id,status,kind,created,started,progress,paused,eng,prio,
  CASE WHEN prompt LIKE '〔背景:%' OR via LIKE '%"k":"ask"%' OR via LIKE '%"k":"give"%' OR prompt LIKE '同事「%'
    OR instr(substr(prompt,1,80),' 問你：')>0 OR instr(substr(prompt,1,80),'把工作交接給你：')>0 THEN 1 ELSE 0 END AS bg,
  via, substr(prompt,1,48) AS p0
  FROM jobs WHERE user_id=? AND kind<>'test' AND status IN ('pending','running')`;
export async function chatRoutes(c) {
  const { env, db, path, m, url, body, me, U, ok } = c;
  // ---------- web app ----------
  if (path === 'wait' && m === 'GET') {
    // long-poll: returns as soon as anything changes (or after 25 s)
    const have = +url.searchParams.get('rev');
    const t0 = now();

    const haveP = url.searchParams.has('prog') ? +url.searchParams.get('prog') : null;
    for (;;) {
      const u = await db.prepare('SELECT rev, prog FROM users WHERE id=?').bind(U).first(),
        rev = u?.rev ?? 0,
        prog = u?.prog ?? 0;
      if (rev !== have || (haveP !== null && prog !== haveP) || now() - t0 > WAIT_MS) return J({ rev, prog });
      await nap(env, 1500);
    }
  }
  if (path === 'busy' && m === 'GET') {
    // just what is running now (progress lines), without reloading everything
    const busy = (
      await db
        .prepare(
          BUSY_SQL
        )
        .bind(U)
        .all()
    ).results;
    const u = await db.prepare('SELECT prog FROM users WHERE id=?').bind(U).first();
    return J({ busy: busyRows(busy), prog: u?.prog ?? 0, queue: await queueInfo(db, U) });
  }
  if (path === 'state' && m === 'GET') {
    const all = await loadAll(db, U);
    const convIds = [...all.bots.map(b => b.id), ...all.groups.map(g => g.id)];
    const [ur, busy, rev, ...lasts] = await db.batch([
      // recent bot replies, for unread counts and notifications
      db.prepare("SELECT conv,id FROM messages WHERE user_id=? AND by_ NOT IN ('me','sys') AND kind IS NULL ORDER BY id DESC LIMIT 100").bind(U), // 4.1: work-panel messages are not unread conversation // D1 讀取量: every device reads this on each change
      db
        .prepare(
          BUSY_SQL
        )
        .bind(U),
      db.prepare('SELECT rev, prog FROM users WHERE id=?').bind(U),
      // newest non-system message of each conversation (list previews); one indexed lookup each
      // ask: the ✅待確認 line of a bot's message, so 待你核准 shows even when it is past the 140-character preview
      ...convIds.map(c =>
        db
          .prepare(
            "SELECT conv,id,by_ AS by,substr(text,1,140) AS text,ts,json_extract(meta,'$.result.ok') AS rok,substr(json_extract(meta,'$.result.text'),1,140) AS rtext,substr(json_extract(meta,'$.approval.what'),1,140) AS awhat,CASE WHEN by_<>'me' AND instr(text,'待確認')>0 THEN substr(text,instr(text,'待確認')-(CASE WHEN substr(text,instr(text,'待確認')-1,1)=' ' THEN 2 ELSE 1 END),200) END AS ask FROM messages WHERE user_id=? AND conv=? AND by_<>'sys' AND kind IS NULL ORDER BY id DESC LIMIT 1"
          )
          .bind(U, c)
      )
    ]);
    const last = { results: lasts.flatMap(r => r.results) };
    // groups: the newest open ✅待確認 even when someone spoke after it (≤30 rows per group)
    const gq = all.groups.length
      ? await db.batch(
          all.groups.map(g =>
            db
              .prepare("SELECT id,by_,text,ts FROM messages WHERE user_id=? AND conv=? AND by_<>'sys' ORDER BY id DESC LIMIT 30")
              .bind(U, g.id)
          )
        )
      : [];
    const gask = Object.fromEntries(all.groups.map((g, i) => [g.id, groupAsk(gq[i].results, all.bots)]).filter(([, v]) => v));
    // 4.8: the newest finished chat work of each conversation, newer than your last message there (未完成 in the sidebar)
    const lastJob = Object.fromEntries(
      (
        await db
          .prepare(
            `SELECT j.conv, j.id, j.status, j.err_kind, substr(j.err_msg,1,140) AS msg, j.finished FROM jobs j
             WHERE j.user_id=? AND j.kind='chat' AND j.status IN ('done','error') AND j.created>? AND j.prompt NOT LIKE '〔背景:%' AND j.via IS NULL
               AND j.id=(SELECT MAX(k.id) FROM jobs k WHERE k.user_id=j.user_id AND k.conv=j.conv AND k.kind='chat' AND k.status IN ('done','error') AND k.prompt NOT LIKE '〔背景:%' AND k.via IS NULL)`
          )
          .bind(U, now() - 3 * DAY)
          .all()
      ).results.map(r => [r.conv, { job: r.id, ok: r.status === 'done' && !r.err_kind, kind: r.err_kind || (r.status === 'error' ? 'stopped' : null), msg: r.msg || '', at: r.finished }])
    );
    const st = await getSettings(db, U);
    const { date } = localNow(env),
      dayStart = Date.parse(date + 'T00:00:00Z') - (+env.TZ_OFFSET_MIN || 0) * 60000;
    const tok = (
      await db
        .prepare(
          "SELECT bot_id, SUM(tokens) AS t, COUNT(*) AS n FROM jobs WHERE user_id=? AND created>=? AND kind='chat' GROUP BY bot_id"
        )
        .bind(U, dayStart)
        .all()
    ).results;
    let codeTasks = [];
    try {
      codeTasks = (
        await db
          .prepare('SELECT id,title,status,phase,engine,model FROM code_tasks WHERE user_id=? ORDER BY created DESC LIMIT 8')
          .bind(U)
          .all()
      ).results;
    } catch {
      codeTasks = [];
    }
    return J({
      tokens: Object.fromEntries(tok.map(r => [r.bot_id, { t: r.t, n: r.n }])),
      codeTasks,
      me: me.name,
      local: me.kind === 'local',
      rev: rev.results[0]?.rev ?? 0,
      prog: rev.results[0]?.prog ?? 0,
      engines: JSON.parse((await db.prepare('SELECT engines FROM users WHERE id=?').bind(U).first())?.engines || 'null'),
      runnerOnline: env.runnerOnline ? env.runnerOnline() : true,
      hostOs: env.hostOs || '', // 4.5: the host computer's system (Grok Bot's grok-bot-cli doesn't work on Windows)
      hookTunnel: env.hookTunnel ? env.hookTunnel() : '', // the tunnel address the 交接網址 is forwarded to right now
      shareBrowser: st.shareBrowser !== false,
      nick: st.nick || '',
      quick: st.quick || {},
      allow: st.allow || {},
      pins: st.pins || [],
      mute: st.mute || {},
      memory: st.memory || {},
      facts: st.facts || {},
      manuals: st.manuals || {},
      review: st.review !== false,
      skills: st.skills || {},
      nsk: Object.fromEntries(
        Object.entries(st.nskills || {}).map(([k, v]) => [k, [...new Set(Object.keys(v.files || {}).map(p => p.split('/')[0]))]])
      ),
      warm: WARM.includes(+st.warm) ? +st.warm : 120,
      models: st._models || null,
      focus: st.focus?.conv ? { conv: st.focus.conv, dev: st.focus.dev || '', at: st.focus.at || 0 } : null,
      gask,
      ...all,
      routines: routinesOut(env, all.routines),
      last: last.results,
      ur: ur.results.map(r => [r.conv, r.id]),
      busy: busyRows(busy.results),
      queue: await queueInfo(db, U),
      lastJob // 4.8: each conversation's newest finished work — the sidebar shows 「未完成」 when it did not work out
    });
  }
  if (path === 'messages' && m === 'GET') {
    // one conversation, 50 at a time
    const conv = clean(url.searchParams.get('conv'), 64),
      before = +url.searchParams.get('before') || 0,
      after = +url.searchParams.get('after') || 0;
    const lim = Math.min(100, +url.searchParams.get('limit') || 50);
    const rows = (
      await (
        after
          ? db
              .prepare(
                'SELECT id,conv,by_ AS by,text,files,ts,reply,kind,meta FROM messages WHERE user_id=? AND conv=? AND id>? ORDER BY id LIMIT ?'
              )
              .bind(U, conv, after, lim)
          : db
              .prepare(
                'SELECT * FROM (SELECT id,conv,by_ AS by,text,files,ts,reply,kind,meta FROM messages WHERE user_id=? AND conv=? AND id<? ORDER BY id DESC LIMIT ?) ORDER BY id'
              )
              .bind(U, conv, before || 9e15, lim)
      ).all()
    ).results.map(x => ({ ...x, files: x.files ? JSON.parse(x.files) : [], meta: metaOf(x.meta) }));
    // 4.8: replies rewritten since the app last looked (a follow-up of the same turn folded into it)
    const since = +url.searchParams.get('since') || 0;
    const changed = since
      ? (
          await db
            .prepare('SELECT id,conv,by_ AS by,text,files,ts,reply,kind,meta,upd FROM messages WHERE user_id=? AND conv=? AND upd>=? ORDER BY id LIMIT 50')
            .bind(U, conv, since)
            .all()
        ).results.map(x => ({ ...x, files: x.files ? JSON.parse(x.files) : [], meta: metaOf(x.meta) }))
      : [];
    return J({ msgs: rows, more: !after && rows.length === lim, changed, now: now() });
  }
  // 幕後: what bots asked of / handed to each other around this conversation
  if (path === 'backstage' && m === 'GET') {
    const conv = clean(url.searchParams.get('conv'), 64);
    if (!conv) return err('要指定對話');
    const rows = (
      await db
        .prepare(
          `SELECT id,conv,bot_id,prompt,via,status,created,started,finished,result FROM jobs
        WHERE user_id=? AND kind='chat' AND created>? AND (via IS NOT NULL OR prompt LIKE '〔背景:%')
          AND (conv=? OR via LIKE ? OR via LIKE ? OR prompt LIKE ?) ORDER BY id DESC LIMIT 80`
        )
        .bind(
          U,
          now() - 14 * DAY,
          conv,
          '%"f":' + JSON.stringify(conv) + '%',
          '%"c":' + JSON.stringify(conv) + '%',
          '〔背景:' + conv + ':%'
        )
        .all()
    ).results.reverse();
    return J({ items: backstageItems(rows) });
  }
  if (path === 'messages' && m === 'POST') {
    const conv = clean(body.conv, 64),
      text = clean(body.text, 4000);
    if (!text && !(body.files || []).length) return err('訊息是空的');
    const { bots, groups } = await loadAll(db, U);
    const bot = bots.find(b => b.id === conv),
      group = groups.find(g => g.id === conv);
    if (!bot && !group) return err('找不到對話', 404);
    const fileIds = (Array.isArray(body.files) ? body.files : []).slice(0, 6).map(x => clean(x, 64));
    const files = fileIds.length
      ? (
          await db
            .prepare(`SELECT id,name,mime,size FROM files WHERE user_id=? AND id IN (${fileIds.map(() => '?').join(',')})`)
            .bind(U, ...fileIds)
            .all()
        ).results
      : [];
    files.sort((x, y) => fileIds.indexOf(x.id) - fileIds.indexOf(y.id)); // keep the order they were attached in
    if (files.length)
      await db
        .prepare(`UPDATE files SET conv=? WHERE user_id=? AND conv IS NULL AND id IN (${files.map(() => '?').join(',')})`)
        .bind(conv, U, ...files.map(f => f.id))
        .run();
    const want = Math.floor(+body.reply);
    let quoted = null;
    if (want > 0) {
      const src = await db
        .prepare('SELECT id, by_, text FROM messages WHERE id=? AND user_id=? AND conv=?')
        .bind(want, U, conv)
        .first();
      if (src) {
        const who =
          src.by_ === 'me' ? '你自己' : src.by_ === 'sys' ? '系統' : bots.find(b => b.id === src.by_)?.name || '那則訊息';
        const bit =
          String(src.text || '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 160) || '（沒有文字）';
        quoted = { by: src.by_, id: src.id, note: `（這則是在回覆「${who}」的這一則：${bit}。請針對這一則回答。）` };
      }
    }
    await addMsg(db, U, conv, 'me', text || '（附件）', files, quoted?.id || null);
    if (await ownApproval(env, db, U, conv, text, bots, group)) return ok();
    // 核准 a 每週自我檢討 suggestion: write the rules directly, no AI run needed
    const ru = bot && text.match(/^核准[:：]\s*更新規則[:：]\s*([\s\S]+)$/);
    if (
      ru &&
      (await db
        .prepare(
          "SELECT 1 AS n FROM messages WHERE user_id=? AND conv=? AND by_=? AND text LIKE '%✅待確認：更新規則%' AND ts>? LIMIT 1"
        )
        .bind(U, conv, bot.id, now() - 14 * DAY)
        .first())
    ) {
      const st = await getSettings(db, U),
        { rules, done } = applyRuleUpdates((st.memory || {})[bot.id], ru[1]);
      st.memory = st.memory || {};
      const before = st.memory[bot.id];
      if (rules.length) st.memory[bot.id] = rules;
      else delete st.memory[bot.id];
      await putSettings(db, U, st);
      await noteListChange(db, U, 'rule', bot.id, before, rules, 'review'); // 4.7: the weekly review you approved
      await addMsg(
        db,
        U,
        conv,
        'sys',
        done.length ? `已更新規則：${done.join('；').slice(0, 300)}` : '規則沒有變更（建議的內容已經有了）'
      );
      return ok();
    }
    if (bot && (await busyTurn(db, U, conv, text, bot, quoted))) return ok();
    await enqueueTurn(db, U, conv, text, bot, group, bots, quoted);
    return ok();
  }
  if (path === 'messages/copy' && m === 'POST') {
    // drag a message onto another bot: same text and its own copies of the files
    const to = clean(body.to, 64),
      from = clean(body.from, 64),
      id = Math.floor(+body.id);
    if (!to || !from || !id) return err('要指定訊息和要貼到哪裡');
    if (to === from) return err('已經在這個對話');
    const { bots, groups } = await loadAll(db, U);
    const bot = bots.find(b => b.id === to),
      group = groups.find(g => g.id === to);
    if (!bot && !group) return err('找不到對話', 404);
    const src = await db
      .prepare('SELECT id,text,files FROM messages WHERE id=? AND user_id=? AND conv=?')
      .bind(id, U, from)
      .first();
    if (!src) return err('找不到訊息', 404);
    const text = String(src.text || '');
    let parsed = [];
    try {
      parsed = src.files ? JSON.parse(src.files) : [];
    } catch {
      parsed = [];
    }
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
  if (path === 'compact' && m === 'POST') {
    // one press: the bot writes what still matters into its memory, then the old messages go
    const conv = clean(body.conv, 64);
    const { bots } = await loadAll(db, U);
    const bot = bots.find(b => b.id === conv);
    if (!bot) return err('只有單一機器人的對話可以壓縮', 404);
    if (
      await db
        .prepare("SELECT 1 FROM jobs WHERE user_id=? AND conv=? AND status IN ('pending','running') LIMIT 1")
        .bind(U, conv)
        .first()
    )
      return err('它還在工作，做完再壓縮', 409);
    const n =
      (await db.prepare("SELECT COUNT(*) AS n FROM messages WHERE user_id=? AND conv=? AND by_<>'sys'").bind(U, conv).first())
        ?.n || 0;
    if (n < 6) return err('對話還很短，不用壓縮', 400);
    const from = await addMsg(db, U, conv, 'sys', '🗜 壓縮對話中：機器人正在把重點寫進記憶…');
    const fromId =
      typeof from === 'number'
        ? from
        : (await db.prepare('SELECT MAX(id) AS id FROM messages WHERE user_id=? AND conv=?').bind(U, conv).first())?.id;
    await addJob(db, U, conv, [{ b: bot.id, p: COMPACT_PROMPT, v: { k: 'compact', from: fromId } }]);
    await bump(db, U);
    return ok();
  }
  if (path === 'clear' && m === 'POST') {
    // empty one conversation's history
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
  if (path === 'handoff' && m === 'POST') {
    const bot = clean(body.bot, 64);
    const owns = await db.prepare('SELECT id FROM bots WHERE id=? AND user_id=?').bind(bot, U).first();
    if (!owns) return err('找不到這個機器人', 404);
    const on = !(body.on === false || body.on === 0);
    const cur = await db.prepare('SELECT bot_id FROM live WHERE bot_id=? AND user_id=?').bind(bot, U).first();
    if (cur)
      await db
        .prepare('UPDATE live SET handed=?, ts=? WHERE bot_id=? AND user_id=?')
        .bind(on ? 1 : 0, now(), bot, U)
        .run();
    else
      await db
        .prepare('INSERT INTO live (bot_id,user_id,url,title,mime,data,ts,handed) VALUES (?,?,?,?,?,?,?,?)')
        .bind(bot, U, '', '', 'image/jpeg', '', now(), on ? 1 : 0)
        .run();
    // the computer's browser switch (僅觀看 / 取得控制權) and the live page follow, whichever screen pressed it
    try {
      env.onHandoff?.(bot, on);
    } catch {}
    return ok({ handed: on });
  }
  if (path.startsWith('live/') && m === 'GET') {
    const id = path.slice(5);
    const since = +url.searchParams.get('since') || 0;
    const head = await db.prepare('SELECT ts,handed FROM live WHERE bot_id=? AND user_id=?').bind(id, U).first();
    if (head && since && +head.ts === since) {
      await db.prepare('UPDATE live SET watch=? WHERE bot_id=? AND user_id=?').bind(now(), id, U).run();
      return J({ same: true, ts: head.ts, handed: !!head.handed });
    } // same frame: don't send the picture again
    const row =
      head && (await db.prepare('SELECT url,title,data,ts,handed FROM live WHERE bot_id=? AND user_id=?').bind(id, U).first());
    if (row)
      await db.prepare('UPDATE live SET watch=? WHERE bot_id=? AND user_id=?').bind(now(), id, U).run(); // tells the host to keep sending frames
    else
      await db
        .prepare('INSERT INTO live (bot_id,user_id,url,title,mime,data,ts,handed,watch) VALUES (?,?,?,?,?,?,?,0,?)')
        .bind(id, U, '', '', 'image/jpeg', '', 0, now())
        .run();
    return J(
      row ? { url: row.url || '', title: row.title || '', data: row.data || '', ts: row.ts || 0, handed: !!row.handed } : {}
    );
  }
  if (path === 'focus' && m === 'PUT') {
    const dev = clean(body.dev, 40),
      conv = clean(body.conv, 64);
    if (!/^[a-z0-9]{8,40}$/i.test(dev)) return err('這台裝置沒有代號');
    const { bots, groups } = await loadAll(db, U);
    if (![...bots, ...groups].some(x => x.id === conv)) return err('找不到這個對話', 404);
    const st = await getSettings(db, U);
    st.focus = { conv, dev, at: now() };
    await putSettings(db, U, st);
    return ok({ ok: true });
  }
  if (path === 'open' && m === 'POST') {
    const { bots, groups } = await loadAll(db, U);
    const bot = bots.find(b => b.id === body.bot);
    const conv = clean(body.conv, 64);
    if (!bot || !(conv === bot.id || groups.some(g => g.id === conv))) return err('找不到機器人', 404);
    let link = clean(body.url, 500),
      page = '';
    if (body.hide)
      link = 'octa:hide'; // put the window back in the background
    else if (body.expand) {
      // the person asked to see it: open the dock. a bot's own browsing stays a thumbnail
      page = link ? (/^https?:\/\//.test(link) ? link : 'https://' + link) : '';
      link = page ? 'octa:open ' + page : 'octa:open';
    } else if (link && !/^https?:\/\//.test(link)) link = 'https://' + link;
    // a second address typed before the computer picks up the first replaces it, instead of being dropped
    const pending = await db
      .prepare("SELECT id FROM jobs WHERE user_id=? AND bot_id=? AND kind='open' AND status='pending'")
      .bind(U, bot.id)
      .first();
    await addMsg(
      db,
      U,
      conv,
      'sys',
      body.hide
        ? `把「${bot.name}」的瀏覽器收到背景`
        : body.expand
          ? `打開「${bot.name}」的瀏覽器${page ? '：' + page : ''}`
          : `在電腦上顯示「${bot.name}」的瀏覽器${link ? '：' + link : ''}`
    );
    if (pending) {
      await db
        .prepare('UPDATE jobs SET url=?, conv=?, created=? WHERE id=?')
        .bind(link || null, conv, now(), pending.id)
        .run();
      return J({ ok: true, queued: true });
    }
    await db
      .prepare("INSERT INTO jobs (user_id,conv,bot_id,chain,prompt,created,kind,url) VALUES (?,?,?,'[]','',?,'open',?)")
      .bind(U, conv, bot.id, now(), link || null)
      .run();
    return ok();
  }
  if (path === 'cancel' && m === 'POST') {
    const conv = clean(body.conv, 64);
    await db.prepare("DELETE FROM jobs WHERE user_id=? AND conv=? AND status='pending'").bind(U, conv).run();
    await db.prepare("UPDATE jobs SET status='error' WHERE user_id=? AND conv=? AND status='running'").bind(U, conv).run();
    await addMsg(db, U, conv, 'sys', '已停止目前的任務');
    return ok();
  }
}
