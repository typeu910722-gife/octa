// Memory layers (rules / facts / manuals), the weekly self-review, approval reminders and the results board.
import { addJob, bump, getSettings, loadAll, putSettings } from './db.mjs';
import { sendNotify } from './notify.mjs';
import { localNow } from './schedule.mjs';
import { DAY, MIN, clean, now, perDb } from './util.mjs';

// ---------- 記憶分層（規則／事實／做事手冊）、每週自我檢討、成果看板 ----------
// st.memory = 規則 (📌), st.facts = 事實 (📇), st.manuals = 做事手冊 (📘 {name, steps, ts, used}); all per bot id
export const MEM_KEYS = { rule: 'memory', fact: 'facts', manual: 'manuals' };
const MEM_CAP = { rule: { n: 30, chars: 3000 }, fact: { n: 40, chars: 3000 }, manual: { n: 2, chars: 1500 } };
export const MANUAL_MAX = 20;
// the newest items that fit both limits (older ones stay saved, they just aren't sent)
export function capList(list, n, chars) {
  const out = [];
  let len = 0;
  for (let i = (list || []).length - 1; i >= 0 && out.length < n; i--) {
    const v = String(list[i] ?? '');
    if (!v) continue;
    if (len + v.length > chars) break;
    len += v.length;
    out.unshift(v);
  }
  return out;
}
// words of a name: latin words and CJK pairs ("訂房報表" → 訂房, 房報, 報表)
const kwOf = s => {
  const t = String(s || '').toLowerCase(),
    out = new Set();
  for (const w of t.match(/[a-z0-9]{3,}/g) || []) out.add(w);
  for (const run of t.match(/[㐀-鿿豈-﫿]+/g) || []) {
    if (run.length === 1) out.add(run);
    for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2));
  }
  return [...out];
};
export function manualScore(m, prompt) {
  const p = String(prompt || '').toLowerCase(),
    name = String(m?.name || '')
      .toLowerCase()
      .trim();
  if (!name || !p) return 0;
  if (p.includes(name)) return 100;
  const kw = kwOf(name);
  if (!kw.length) return 0;
  const hits = kw.filter(k => p.includes(k)).length;
  return hits >= 2 && hits / kw.length >= 0.4 ? Math.round((hits / kw.length) * 50) : 0;
}
// the manuals that look like this task: best match first, then the most used, then the newest
export function pickManuals(list, prompt, max = MEM_CAP.manual.n) {
  return (list || [])
    .map(m => ({ m, s: manualScore(m, prompt) }))
    .filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s || (+b.m.used || 0) - (+a.m.used || 0) || (+b.m.ts || 0) - (+a.m.ts || 0))
    .slice(0, max)
    .map(x => x.m);
}
export function memoryFor(st, botId, prompt) {
  const manuals = pickManuals((st.manuals || {})[botId], prompt).map(m => ({
    name: m.name,
    steps: String(m.steps || '').slice(0, MEM_CAP.manual.chars)
  }));
  return {
    memory: capList((st.memory || {})[botId], MEM_CAP.rule.n, MEM_CAP.rule.chars),
    facts: capList((st.facts || {})[botId], MEM_CAP.fact.n, MEM_CAP.fact.chars),
    manuals
  };
}
const stepCount = s =>
  String(s || '')
    .split(/\s*(?:→|->|⇒|\n|；|;|(?:^|\s)\d+[.)、]\s*)\s*/)
    .map(x => x.trim())
    .filter(Boolean).length;
// 📘手冊：名稱｜步驟 → 步驟 → 步驟   or   📘手冊：名稱 (newline) steps… 📘結束
export function parseManuals(text) {
  const found = [];
  let t = String(text || '').replace(/📘\s*手冊[:：]\s*([^\n｜|]+)\n([\s\S]*?)📘\s*結束/g, (_, n, s) => {
    found.push({ name: clean(n, 40), steps: clean(s, 1500) });
    return '';
  });
  t = t.replace(/^\s*📘\s*手冊[:：]\s*([^｜|\n]+?)\s*[｜|]\s*(.+)$/gm, (_, n, s) => {
    found.push({ name: clean(n, 40), steps: clean(s, 1500) });
    return '';
  });
  return { text: t, manuals: found.filter(m => m.name && m.steps && stepCount(m.steps) >= 3) };
}
export function saveManuals(cur, add, t = now()) {
  const keep = (cur || []).filter(x => !add.some(n => n.name === x.name));
  const merged = [
    ...keep,
    ...add.map(n => ({ name: n.name, steps: n.steps, ts: t, used: (cur || []).find(x => x.name === n.name)?.used || 0 }))
  ];
  if (merged.length <= MANUAL_MAX) return merged;
  const drop = new Set(
    [...merged]
      .sort((a, b) => (+a.used || 0) - (+b.used || 0) || (+a.ts || 0) - (+b.ts || 0))
      .slice(0, merged.length - MANUAL_MAX)
  );
  return merged.filter(x => !drop.has(x));
}
// ✅待確認：更新規則：新增：…；修改：舊 → 新；刪除：…  — applied only when the user presses 核准
export function applyRuleUpdates(list, spec) {
  const rules = [...(list || [])],
    done = [];
  const same = (a, b) => a === b || (b.length >= 4 && a.includes(b)) || (a.length >= 4 && b.includes(a));
  for (let item of String(spec || '').split(/[；;\n]+/)) {
    item = item.replace(/^\s*(?:[①-⑩]|\d+[.)、]|[-•·])\s*/, '').trim();
    if (!item) continue;
    let mm;
    if ((mm = item.match(/^修改[:：]\s*(.+?)\s*(?:→|->|=>|⇒)\s*(.+)$/))) {
      const from = clean(mm[1], 300),
        to = clean(mm[2], 300),
        i = rules.findIndex(r => same(r, from));
      if (i >= 0) rules[i] = to;
      else rules.push(to);
      done.push('修改：' + to);
    } else if ((mm = item.match(/^刪除[:：]\s*(.+)$/))) {
      const v = clean(mm[1], 300),
        i = rules.findIndex(r => same(r, v));
      if (i >= 0) {
        rules.splice(i, 1);
        done.push('刪除：' + v);
      }
    } else {
      const v = clean(item.replace(/^新增[:：]\s*/, ''), 300);
      if (v && !rules.includes(v)) {
        rules.push(v);
        done.push('新增：' + v);
      }
    }
  }
  return { rules: rules.slice(-40), done };
}
const REVIEW_NAME = '每週自我檢討';
export const REVIEW_TAG = `（例行任務「${REVIEW_NAME}」）`;
const reviewLooked = perDb(); // look at most once an hour per account
// once a week, for each bot that had work: its failures and corrections → suggested rules, sent as ✅待確認
export async function weeklyReview(env, db, U, force = false) {
  if (!force) {
    if (now() - (reviewLooked(db).get(U) || 0) < 60 * MIN) return 0;
    reviewLooked(db).set(U, now());
  }
  const st = await getSettings(db, U);
  if (st.review === false && !force) return 0;
  if (!force && !st.reviewAt) {
    st.reviewAt = now();
    await putSettings(db, U, st);
    return 0;
  } // the first week starts at the first look
  if (!force && (now() - st.reviewAt < 7 * DAY || localNow(env).hm < '09:00')) return 0;
  st.reviewAt = now();
  await putSettings(db, U, st);
  const since = now() - 7 * DAY;
  const [rows, worked] = await db.batch([
    // only the last 7 days of rows are read: the id bound comes from the newest older message
    db
      .prepare(
        "SELECT conv, by_, text FROM messages WHERE user_id=?1 AND id>IFNULL((SELECT id FROM messages WHERE user_id=?1 AND ts<?2 ORDER BY id DESC LIMIT 1),0) AND ((by_ NOT IN ('sys','me') AND (text LIKE '⚠%' OR meta LIKE '%\"ok\":false%')) OR (by_='sys' AND text LIKE '已記住：%')) ORDER BY id DESC LIMIT 400"
      )
      .bind(U, since),
    db
      .prepare(
        "SELECT bot_id, COUNT(*) AS n FROM jobs WHERE user_id=? AND created>=? AND kind='chat' AND prompt NOT LIKE ? GROUP BY bot_id"
      )
      .bind(U, since, REVIEW_TAG + '%')
  ]);
  const { bots } = await loadAll(db, U);
  let n = 0;
  for (const b of bots) {
    if (!worked.results.some(w => w.bot_id === b.id)) continue;
    const fails = rows.results
      .filter(r => r.by_ === b.id)
      .map(r => clean(r.text, 200))
      .slice(0, 8);
    const fixes = rows.results
      .filter(r => r.by_ === 'sys' && r.conv === b.id)
      .map(r => clean(r.text.replace(/^已記住：/, ''), 200))
      .slice(0, 10);
    if (!fails.length && !fixes.length) continue; // nothing to learn from: say nothing
    const rules = (st.memory || {})[b.id] || [];
    await addJob(
      db,
      U,
      b.id,
      [b.id],
      `${REVIEW_TAG}回顧你過去 7 天的工作，想想要新增或修改哪些規則，下次才不會再犯。\n` +
        (fails.length ? `失敗或出錯的回覆：\n${fails.map(x => '- ' + x).join('\n')}\n` : '') +
        (fixes.length ? `使用者糾正後記下的事：\n${fixes.map(x => '- ' + x).join('\n')}\n` : '') +
        `你目前的規則：\n${rules.length ? rules.map(x => '- ' + x).join('\n') : '（沒有）'}\n\n` +
        '最多提 3 條，每條一句話、具體可照做；跟現有規則重複的不要提，舊規則寫得不好就用修改。不要寫 📌記住，也不要開瀏覽器或做其他事。' +
        '沒有值得改的就整則只回「（略過）」。有的話，先用一兩句說明為什麼，最後單獨一行照這個格式寫（「✅待確認：更新規則：」照抄）：\n' +
        '✅待確認：更新規則：新增：規則內容；修改：舊規則 → 新規則'
    );
    n++;
  }
  if (n) await bump(db, U);
  return n;
}
// ✅待確認 nobody answered for 15 minutes: one more Telegram / LINE message, once per card
// (評論：「核准框有時候沒人看到，接班人就一直卡著」). Looked at from runner/next, at most once a minute per account.
const NAG_MS = 15 * MIN,
  nagLooked = perDb();
const APPR_LINE = /^✅\s*待確認[:：]\s*(.+)$/m;
// is this ✅待確認 still open? Your reply closes it (in a group only when it isn't @ another member), and so does the bot moving on.
export function apprOpen(m, later, who) {
  for (const x of later) {
    if (x.by_ === m.by_) return false;
    if (x.by_ === 'me') {
      const to = String(x.text || '')
        .trim()
        .match(/^@(\S+)/);
      if (to && who && to[1] !== who) continue;
      return false;
    }
  }
  return true;
}
async function pendingApprovals(db, U, olderThan = 0) {
  const rows = (
    await db
      .prepare(
        "SELECT m.id, m.conv, m.by_, m.text, m.ts FROM messages m WHERE m.user_id=?1 AND m.id>IFNULL((SELECT id FROM messages WHERE user_id=?1 AND ts<?2 ORDER BY id DESC LIMIT 1),0) AND m.by_ NOT IN ('me','sys') AND m.ts<=?3 AND instr(m.text,'待確認')>0 ORDER BY m.id DESC LIMIT 20"
      )
      .bind(U, now() - DAY, now() - olderThan)
      .all()
  ).results.filter(r => APPR_LINE.test(r.text));
  if (!rows.length) return [];
  const { bots } = await loadAll(db, U);
  const out = [];
  for (const r of rows) {
    const later = (
      await db
        .prepare("SELECT by_, text FROM messages WHERE user_id=? AND conv=? AND id>? AND by_<>'sys' ORDER BY id LIMIT 30")
        .bind(U, r.conv, r.id)
        .all()
    ).results;
    if (apprOpen(r, later, bots.find(b => b.id === r.by_)?.name)) out.push({ ...r, by: r.by_, act: r.text.match(APPR_LINE)[1] });
  }
  return out;
}
// a group's newest open ✅待確認 among its last 30 messages (the list preview only sees the very last message)
export function groupAsk(rows, bots) {
  const asc = rows.slice().reverse();
  for (let i = asc.length - 1; i >= 0; i--) {
    const m = asc[i];
    if (m.by_ === 'me' || !APPR_LINE.test(m.text || '')) continue;
    if (apprOpen(m, asc.slice(i + 1), bots.find(b => b.id === m.by_)?.name))
      return { id: m.id, by: m.by_, ts: m.ts, ask: m.text.match(APPR_LINE)[0] };
  }
  return null;
}
export async function approvalNag(env, db, U, force = false) {
  if (!force && now() - (nagLooked(db).get(U) || 0) < MIN) return 0;
  nagLooked(db).set(U, now());
  const waiting = await pendingApprovals(db, U, NAG_MS);
  if (!waiting.length) return 0;
  const st = await getSettings(db, U);
  const told = new Set(st.nagged || []),
    fresh = waiting.filter(r => !told.has(r.id) && !(st.mute || {})[r.conv]);
  if (!fresh.length) return 0;
  const { bots, groups } = await loadAll(db, U);
  const nm = id => bots.find(b => b.id === id)?.name || groups.find(g => g.id === id)?.name || '機器人';
  const lines = fresh
    .slice(0, 5)
    .map(
      r =>
        `・${nm(r.by)}${r.conv !== r.by ? `（${nm(r.conv)}）` : ''}：${clean(r.act, 120)}（等了 ${Math.round((now() - r.ts) / MIN)} 分鐘）`
    );
  await sendNotify(
    env,
    st,
    `【OCTA】還有 ${fresh.length} 件等你核准，機器人停在這裡：\n${lines.join('\n')}\n打開 OCTA，清單最上面就是。`
  );
  st.nagged = [...fresh.map(r => r.id), ...(st.nagged || [])].slice(0, 100);
  await putSettings(db, U, st);
  return fresh.length;
}
// 成果看板: one row per bot per day, added to when a chat job ends (jobs themselves are kept only 14 days)
export async function statAdd(db, env, U, job, good, tokens, web) {
  if (String(job.prompt || '').startsWith(REVIEW_TAG)) return;
  const ms = good && job.started ? Math.max(0, now() - job.started) : 0;
  try {
    await db
      .prepare(
        'INSERT INTO stats (user_id,bot_id,day,done,failed,ms,timed,tokens,web) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,bot_id,day) DO UPDATE SET done=done+excluded.done, failed=failed+excluded.failed, ms=ms+excluded.ms, timed=timed+excluded.timed, tokens=tokens+excluded.tokens, web=web+excluded.web'
      )
      .bind(
        U,
        job.bot_id,
        localNow(env).date,
        good ? 1 : 0,
        good ? 0 : 1,
        ms,
        ms ? 1 : 0,
        Math.max(0, +tokens || 0),
        good && web ? 1 : 0
      )
      .run();
  } catch {}
}
const SAVED_MIN = { task: 5, web: 10 }; // 估計：每件完成的工作省 5 分鐘，用到瀏覽器的再加 10 分鐘
export async function boardData(env, db, U) {
  const d7 = localNow(env, now() - 6 * DAY).date,
    d30 = localNow(env, now() - 29 * DAY).date;
  const w = c => `SUM(CASE WHEN day>=?1 THEN ${c} ELSE 0 END)`;
  const rows = (
    await db
      .prepare(
        `SELECT bot_id, ${w('done')} AS wd, ${w('failed')} AS wf, ${w('ms')} AS wms, ${w('timed')} AS wt, ${w('tokens')} AS wtk, ${w('web')} AS ww, SUM(done) AS md, SUM(failed) AS mf, SUM(ms) AS mms, SUM(timed) AS mt, SUM(tokens) AS mtk, SUM(web) AS mw FROM stats WHERE user_id=?2 AND day>=?3 GROUP BY bot_id`
      )
      .bind(d7, U, d30)
      .all()
  ).results;
  const { bots } = await loadAll(db, U);
  const pack = (d, f, ms, t, tk, wb) => ({
    done: +d || 0,
    failed: +f || 0,
    rate: (+d || 0) + (+f || 0) ? Math.round(((+d || 0) / ((+d || 0) + (+f || 0))) * 100) : null,
    avgSec: +t ? Math.round(+ms / +t / 1000) : null,
    tokens: +tk || 0,
    savedMin: (+d || 0) * SAVED_MIN.task + (+wb || 0) * SAVED_MIN.web
  });
  return {
    since: { d7, d30 },
    est: SAVED_MIN,
    bots: bots.map(b => {
      const r = rows.find(x => x.bot_id === b.id) || {};
      return {
        id: b.id,
        name: b.name,
        avatar: b.avatar,
        color: b.color || null,
        d7: pack(r.wd, r.wf, r.wms, r.wt, r.wtk, r.ww),
        d30: pack(r.md, r.mf, r.mms, r.mt, r.mtk, r.mw)
      };
    })
  };
}
