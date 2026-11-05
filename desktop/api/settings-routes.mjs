// Settings, connectors, notifications, logs, the board, AI engines and usage.
import { normalizeCustom } from '../lib/connectors.mjs';
import { mailView } from '../lib/mail-connector.mjs';
import { stripRetryNote } from '../lib/model-route.mjs';
import { addMsg, bump, getSettings, loadAll, mask, putSettings } from './db.mjs';
import { GROKBOT_WIN, engineOk, grokBotOff } from './engines.mjs';
import { MANUAL_MAX, MEM_KEYS, boardData, weeklyReview } from './memory.mjs';
import { noteListChange } from './memory-edit.mjs';
import { sendNotify } from './notify.mjs';
import { localNow } from './schedule.mjs';
import { J, JOB_MAX, POWER, WARM, clean, err, fullOn, jobMaxOf, now, uid, warmOf } from './util.mjs';

export async function settingsRoutes(c) {
  const { env, db, path, m, url, body, me, U, ok } = c;
  if (path === 'grokbot/list' && m === 'POST') {
    // ask the host computer for the bots in the user's Grok Bot
    if (grokBotOff(env)) return err(GROKBOT_WIN, 400);
    const r = await db
      .prepare(
        "INSERT INTO jobs (user_id,conv,bot_id,chain,prompt,created,kind,url) VALUES (?,'__test','list:grokbot','[]','',?,'list','grokbot')"
      )
      .bind(U, now())
      .run();
    return ok({ id: r.meta.last_row_id });
  }
  if (path === 'engine-install' && m === 'POST') {
    // from any device (the phone too): this computer opens the install window
    const engine = engineOk(body.engine);
    if (['copilot', 'cursor', 'qwen', 'grok', 'grokbot'].includes(engine)) return err('這個 AI 暫時不開放連接', 400);
    const r = await db
      .prepare("INSERT INTO jobs (user_id,conv,bot_id,chain,prompt,created,kind,url) VALUES (?,'__test',?,'[]','',?,'install',?)")
      .bind(U, 'install:' + engine, now(), engine)
      .run();
    return ok({ id: r.meta.last_row_id });
  }
  if (path === 'engine-test' && m === 'POST') {
    const engine = engineOk(body.engine);
    if (engine === 'grokbot' && grokBotOff(env)) return err(GROKBOT_WIN, 400);
    const r = await db
      .prepare("INSERT INTO jobs (user_id,conv,bot_id,chain,prompt,created,kind,url) VALUES (?,'__test',?,'[]',?,?,'test',?)")
      .bind(U, 'test:' + engine, '這是 OCTA 的連線測試，請只回覆兩個字：OK', now(), engine)
      .run();
    return ok({ id: r.meta.last_row_id });
  }
  if (path.startsWith('job/') && m === 'GET') {
    const j = await db.prepare('SELECT status,result FROM jobs WHERE id=? AND user_id=?').bind(+path.slice(4), U).first();
    return j ? J(j) : err('找不到', 404);
  }
  if (path === 'connectors' && m === 'GET') {
    const st = await getSettings(db, U);
    return J({
      builtins: [
        { name: 'Telegram', on: !!(st.tg?.token && st.tg?.chat), can: ['送出'], where: '通知' },
        { name: 'LINE', on: !!(st.line?.token && st.line?.to), can: ['送出'], where: '通知' }
      ],
      // 4.7 信箱（應用程式密碼）: the password only ever comes back masked
      mail: (st.connectors || []).filter(c => c.kind === 'mail').map(c => mailView(c, mask)),
      custom: (st.connectors || []).filter(c => c.kind !== 'mail').map(c => ({
        id: c.id,
        name: c.name,
        base: c.base,
        header: c.header || 'Authorization',
        secret: mask(c.secret)
      }))
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
    return J({
      full: fullOn(st), // 4.11 全力模式
      power: st.power || {},
      jobMax: jobMaxOf(st),
      warm: warmOf(st),
      shareBrowser: st.shareBrowser !== false,
      notes: st.notes || '',
      notifyAll: !!st.notifyAll,
      tg: { token: mask(st.tg?.token), chat: st.tg?.chat || '' },
      line: { token: mask(st.line?.token), to: st.line?.to || '' }
    });
  }
  if (path === 'settings' && m === 'PUT') {
    const st = await getSettings(db, U);
    if (body.notes !== undefined) st.notes = clean(body.notes, 20000);
    if (body.notifyAll !== undefined) st.notifyAll = !!body.notifyAll;
    if (body.nick !== undefined) st.nick = clean(body.nick, 20); // what the bots call you

    // 4.11 全力模式 開／關: the time limit and AI 待機 go back to that mode's defaults (they can still be set after)
    if (body.full !== undefined) {
      st.full = !!body.full;
      delete st.jobMax;
      delete st.warm;
    }
    // per bot: 跟隨全域 (null) / 全力 / 省額度
    if (body.power && typeof body.power === 'object') {
      const id = clean(body.power.bot, 64),
        mode = POWER.includes(body.power.mode) ? body.power.mode : null;
      st.power = st.power || {};
      if (id && mode) st.power[id] = mode;
      else if (id) delete st.power[id];
    }
    if (body.warm !== undefined && body.warm !== null && WARM.includes(+body.warm)) st.warm = +body.warm;
    if (body.jobMax !== undefined && body.jobMax !== null && JOB_MAX.includes(+body.jobMax)) st.jobMax = +body.jobMax;
    if (body.shareBrowser !== undefined) st.shareBrowser = !!body.shareBrowser;
    if (['zh-TW', 'zh-CN', 'en', 'ja'].includes(body.lang)) st.lang = body.lang;
    // per-bot extras kept with the account: 置頂, notifications, memory (📌), skills (🧩)
    if (Array.isArray(body.pins)) {
      st.pins = body.pins
        .map(x => clean(x, 64))
        .filter(Boolean)
        .slice(0, 50);
      await putSettings(db, U, st);
      await bump(db, U);
      return J({ ok: true });
    }
    if (body.mute && typeof body.mute === 'object') {
      st.mute = st.mute || {};
      const id = clean(body.mute.bot, 64);
      if (body.mute.on) st.mute[id] = 1;
      else delete st.mute[id];
      await putSettings(db, U, st);
      await bump(db, U);
      return J({ ok: true });
    }
    if (body.memory && typeof body.memory === 'object') {
      // type: rule (📌, default) | fact (📇) | manual (📘)
      const key = MEM_KEYS[body.memory.type] || 'memory',
        id = clean(body.memory.bot, 64),
        raw = Array.isArray(body.memory.list) ? body.memory.list : [];
      const list =
        key === 'manuals'
          ? raw
              .map(x => ({
                name: clean(x?.name, 40),
                steps: clean(x?.steps, 1500),
                ts: +x?.ts || now(),
                used: Math.max(0, +x?.used || 0)
              }))
              .filter(x => x.name && x.steps)
              .slice(-MANUAL_MAX)
          : raw
              .map(x => clean(x, 300))
              .filter(Boolean)
              .slice(key === 'facts' ? -60 : -40);
      st[key] = st[key] || {};
      const before = st[key][id];
      if (list.length) st[key][id] = list;
      else delete st[key][id];
      await putSettings(db, U, st);
      await noteListChange(db, U, { memory: 'rule', facts: 'fact', manuals: 'manual' }[key], id, before, list); // 4.7: who set it
      await bump(db, U);
      return J({ ok: true });
    }
    if (body.review !== undefined) st.review = !!body.review; // 每週自我檢討
    if (body.skills && typeof body.skills === 'object') {
      st.skills = st.skills || {};
      const id = clean(body.skills.bot, 64);
      const list = (Array.isArray(body.skills.list) ? body.skills.list : [])
        .map(x => ({ name: clean(x?.name, 40), steps: clean(x?.steps, 3000) }))
        .filter(x => x.name && x.steps)
        .slice(0, 20);
      const before = st.skills[id];
      if (list.length) st.skills[id] = list;
      else delete st.skills[id];
      await putSettings(db, U, st);
      await noteListChange(db, U, 'skill', id, before, list);
      await bump(db, U);
      return J({ ok: true });
    }
    if (body.allow && typeof body.allow === 'object') {
      // 一律允許: things a bot may do without asking each time
      const bid = clean(body.allow.bot, 64),
        list = (Array.isArray(body.allow.list) ? body.allow.list : [])
          .map(x => clean(x, 120))
          .filter(Boolean)
          .slice(0, 20);
      st.allow = st.allow || {};
      const before = st.allow[bid];
      if (list.length) st.allow[bid] = list;
      else delete st.allow[bid];
      await putSettings(db, U, st);
      await noteListChange(db, U, 'allow', bid, before, list);
      await bump(db, U);
      return J({ ok: true });
    }
    if (body.quick && typeof body.quick === 'object') {
      // 常用指令 per conversation
      const conv = clean(body.quick.conv, 64),
        list = (Array.isArray(body.quick.list) ? body.quick.list : [])
          .map(x => clean(x, 300))
          .filter(Boolean)
          .slice(0, 12);
      st.quick = st.quick || {};
      if (list.length) st.quick[conv] = list;
      else delete st.quick[conv];
      await putSettings(db, U, st);
      await bump(db, U);
      return J({ ok: true });
    }
    for (const k of ['tg', 'line'])
      if (body[k]) {
        const cur = st[k] || {};
        const tok = clean(body[k].token, 300);
        if (tok && !tok.startsWith('••••')) cur.token = tok;
        if (body[k].token === '') delete cur.token;
        const dest = clean(body[k][k === 'tg' ? 'chat' : 'to'], 100);
        cur[k === 'tg' ? 'chat' : 'to'] = dest;
        st[k] = cur;
      }
    await putSettings(db, U, st);
    return J({ ok: true });
  }
  if (path === 'notify/test' && m === 'POST') {
    const sent = await sendNotify(env, await getSettings(db, U), '【OCTA】測試通知：設定成功 ✓');
    return sent.length ? J({ sent }) : err('還沒有設定任何通知管道');
  }
  if (path === 'notify/detect' && m === 'POST') {
    // find the Telegram chat id from the latest message sent to the bot
    const st = await getSettings(db, U);
    if (!st.tg?.token) return err('先填 Telegram Bot Token 並儲存');
    const r = await fetch(`https://api.telegram.org/bot${st.tg.token}/getUpdates`)
      .then(x => x.json())
      .catch(() => null);
    const chat = r?.result?.reverse().find(u => u.message?.chat?.id)?.message.chat.id;
    if (!chat) return err('找不到訊息。請先用 Telegram 傳任何一句話給你的 bot，再按一次');
    st.tg.chat = String(chat);
    await putSettings(db, U, st);
    return J({ chat: String(chat) });
  }
  if (path === 'logs' && m === 'GET') {
    const { bots, groups } = await loadAll(db, U);
    // ?conv=: one conversation's work, for its work panel (jobs it ran, and jobs its bot ran elsewhere)
    const conv = clean(url.searchParams.get('conv'), 64);
    const cols = 'SELECT id,conv,bot_id,prompt,status,kind,url,created,started,finished,err_kind,err_msg,shot,retry_of,routine,tokens,quse FROM jobs';
    const rows = (
      await (conv
        ? db.prepare(cols + " WHERE user_id=? AND (conv=? OR bot_id=?) AND kind<>'test' ORDER BY id DESC LIMIT 40").bind(U, conv, conv)
        : db.prepare(cols + ' WHERE user_id=? ORDER BY id DESC LIMIT 100').bind(U)
      ).all()
    ).results;
    const retried = new Set(rows.map(r => r.retry_of).filter(Boolean));
    return J({
      logs: rows.map(r => ({
        ...r,
        retried: retried.has(r.id),
        quse: (() => {
          try {
            return r.quse ? JSON.parse(r.quse) : null;
          } catch {
            return null;
          }
        })(),
        bot: r.kind === 'test' ? 'AI 連線測試：' + r.url : bots.find(b => b.id === r.bot_id)?.name || '已刪除',
        convName: (bots.find(b => b.id === r.conv) || groups.find(g => g.id === r.conv))?.name || '',
        prompt: stripRetryNote(r.prompt).slice(0, 80)
      }))
    });
  }
  if (path === 'logs/retry' && m === 'POST') {
    // 工作紀錄 → 重試: the same job again, from the start
    const j = await db.prepare('SELECT * FROM jobs WHERE id=? AND user_id=?').bind(+body.id, U).first();
    if (!j) return err('找不到這筆紀錄', 404);
    if ((j.kind || 'chat') !== 'chat' || j.status === 'pending' || j.status === 'running') return err('這筆不能重試');
    const { bots } = await loadAll(db, U),
      b = bots.find(x => x.id === j.bot_id);
    if (!b) return err('機器人已刪除');
    await db
      .prepare('INSERT INTO jobs (user_id,conv,bot_id,chain,prompt,created,depth,retry_of,hook) VALUES (?,?,?,?,?,?,?,?,?)')
      .bind(U, j.conv, j.bot_id, j.chain || '[]', stripRetryNote(j.prompt), now(), j.depth || 0, j.id, j.hook || null)
      .run();
    await addMsg(db, U, j.conv, 'sys', `從工作紀錄重新執行「${b.name}」的工作`);
    await bump(db, U);
    return ok();
  }
  if (path === 'board' && m === 'GET') return J(await boardData(env, db, U)); // 成果看板: one aggregate over the per-day totals
  if (path === 'review/run' && m === 'POST') return ok({ sent: await weeklyReview(env, db, U, true) }); // 每週自我檢討, now
  if (path.startsWith('shot/') && m === 'GET') {
    const b = await db.prepare('SELECT shot_file FROM bots WHERE id=? AND user_id=?').bind(path.slice(5), U).first();
    if (b?.shot_file) return J({ file: b.shot_file });
    const s = await db.prepare('SELECT mime,data,ts FROM shots WHERE bot_id=? AND user_id=?').bind(path.slice(5), U).first();
    return J(s || {});
  }
  if (path === 'me' && m === 'GET') return J({ id: U, name: me.name });
  if (path === 'ai-usage' && m === 'GET') {
    // plan quota reported by the runner + how often OCTA used each AI today
    const { date } = localNow(env);
    const dayStart = Date.parse(date + 'T00:00:00Z') - (+env.TZ_OFFSET_MIN || 0) * 60000;
    const rows = (
      await db
        .prepare(
          "SELECT b.engine AS e, COUNT(*) AS n FROM jobs j JOIN bots b ON b.id=j.bot_id WHERE j.user_id=? AND j.kind='chat' AND j.created>=? GROUP BY b.engine"
        )
        .bind(U, dayStart)
        .all()
    ).results;
    const usage = (await getSettings(db, U))._usage || null;
    return J({ today: Object.fromEntries(rows.map(r => [r.e || 'claude', r.n])), usage, engines: null });
  }
}
