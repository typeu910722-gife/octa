// Telegram / LINE notifications, and (4.7) 異常主動推播: a bot logged out, an API broke, expected data didn't show up.
import { FAIL_KINDS } from '../lib/model-route.mjs';
import { bump, getSettings } from './db.mjs';
import { J, MIN, clean, now } from './util.mjs';

// failure kinds that are pushed right away with 一鍵重試 (not_logged_in is the older name for a sign-in stop)
export const ALERT_KINDS = {
  logout: { label: '被登出了', why: '網站把它登出了，要你在它的瀏覽器登入一次。' },
  api: { label: 'API 出錯', why: '它用的網站或服務的 API 沒有正常回應。' },
  missing: { label: '該有的資料沒出現', why: '例行工作裡應該出現的清單或資料這次沒有出現。' },
  not_logged_in: { label: '被登出了', why: '網站把它登出了，要你在它的瀏覽器登入一次。', as: 'logout' }
};
export const ALERT_THROTTLE = 30 * MIN; // the same bot and the same kind: pushed once per 30 minutes
const alertKind = k => ALERT_KINDS[k]?.as || k;
// The generic failure notice runner/done sends for these kinds is replaced by the alert (with its retry link) that
// alertSweep sends right after it; its screenshot is kept for that alert.
const held = new Map(); // bot name → { photo, at }
export function heldNotice(text) {
  const m = String(text).match(/^【OCTA】(.+) 沒有完成工作\n[\s\S]*?原因：([^—\n]+)——/);
  if (!m) return null;
  const labels = Object.keys(ALERT_KINDS)
    .map(k => (FAIL_KINDS[k] || {}).label)
    .filter(Boolean);
  return labels.includes(m[2].trim()) ? m[1] : null;
}

export async function sendNotify(env, st, text, photo = null, opt = {}) {
  const out = [];
  if (!opt.alert) {
    const who = heldNotice(text);
    if (who) {
      held.set(who, { photo, at: now() });
      return ['（改由異常通知送出）'];
    }
  }
  if (st.tg?.token && st.tg?.chat && photo) {
    // base64 JPEG of the failed job's screen; the text goes as its caption
    let r = null;
    try {
      const fd = new FormData();
      fd.append('chat_id', st.tg.chat);
      fd.append('caption', text.slice(0, 1000));
      fd.append(
        'photo',
        new Blob([Uint8Array.from(atob(photo), c => c.charCodeAt(0))], { type: 'image/jpeg' }),
        'screenshot.jpg'
      );
      r = await fetch(`https://api.telegram.org/bot${st.tg.token}/sendPhoto`, { method: 'POST', body: fd }).catch(() => null);
    } catch {}
    if (r?.ok && text.length <= 1000) {
      out.push('Telegram');
      photo = 'sent';
    }
  }
  if (st.tg?.token && st.tg?.chat && photo !== 'sent') {
    const r = await fetch(`https://api.telegram.org/bot${st.tg.token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: st.tg.chat, text: text.slice(0, 4000) })
    }).catch(() => null);
    out.push(r?.ok ? 'Telegram' : 'Telegram（失敗）');
  }
  if (st.line?.token && st.line?.to) {
    const r = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + st.line.token },
      body: JSON.stringify({ to: st.line.to, messages: [{ type: 'text', text: text.slice(0, 4900) }] })
    }).catch(() => null);
    out.push(r?.ok ? 'LINE' : 'LINE（失敗）');
  }
  return out;
}

export const needsYou = t => /✅待確認|需要使用者|^⚠/m.test(t);

// ---------- 4.7 異常主動推播 ----------
const alertsReady = new WeakSet();
// the table is created here (once per database), so an older database needs no separate migration
export async function ensureAlerts(db) {
  if (alertsReady.has(db)) return;
  await db
    .prepare(
      'CREATE TABLE IF NOT EXISTS alerts (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, bot_id TEXT NOT NULL, conv TEXT NOT NULL, kind TEXT NOT NULL, job INTEGER NOT NULL UNIQUE, text TEXT, ts INTEGER NOT NULL, pushed INTEGER NOT NULL DEFAULT 0, retried INTEGER)'
    )
    .run();
  await db.prepare('CREATE INDEX IF NOT EXISTS alert_user ON alerts(user_id, id)').run();
  alertsReady.add(db);
}
// The link in a Telegram / LINE message: the phone's /go page opens this bot with a 一鍵重試 button.
// It carries only which bot and which job; the retry itself is an API call from a paired phone (nothing secret in
// the link, and nothing happens without the pairing).
export const retryLink = (base, bot, job) =>
  base ? `${base}#web=${encodeURIComponent(bot)}&retry=${encodeURIComponent(String(job))}` : '';
const stripNote = p =>
  String(p || '')
    .replace(/\n\n（自動重試 \d+）[\s\S]*$/, '')
    .replace(/^〔[^〕]*〕\s*/, '');
export function alertText(who, kind, prompt, msg, link) {
  const k = ALERT_KINDS[kind] || ALERT_KINDS.api;
  const what = stripNote(prompt).replace(/\s+/g, ' ').trim().slice(0, 100);
  const m = String(msg || '')
    .replace(/^⚠\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
  return [
    `【OCTA】⚠ ${who} ${k.label}`,
    what ? `做什麼：${what}` : '',
    k.why,
    m ? `訊息：${m}` : '',
    link ? `👉 一鍵重試（用手機打開）：${link}` : '打開 OCTA，在這個機器人上按「一鍵重試」。'
  ]
    .filter(Boolean)
    .join('\n');
}
// Jobs that just failed in one of these ways (looked at after every runner/done): one alert per job, pushed at once
// unless the same bot had the same kind pushed in the last 30 minutes (still recorded, shown in the app).
export async function alertSweep(env, db, U) {
  await ensureAlerts(db);
  const kinds = Object.keys(ALERT_KINDS);
  const rows = (
    await db
      .prepare(
        `SELECT j.id, j.conv, j.bot_id, j.prompt, j.err_kind, j.err_msg FROM jobs j WHERE j.user_id=? AND j.created>=? AND j.kind='chat'
         AND j.status IN ('error','done') AND j.err_kind IN (${kinds.map(() => '?').join(',')})
         AND NOT EXISTS (SELECT 1 FROM jobs r WHERE r.retry_of=j.id) AND NOT EXISTS (SELECT 1 FROM alerts a WHERE a.job=j.id)
         ORDER BY j.id LIMIT 20`
      )
      .bind(U, now() - 6 * 60 * MIN, ...kinds)
      .all()
  ).results;
  if (!rows.length) return 0;
  const st = await getSettings(db, U);
  let pushed = 0;
  for (const j of rows) {
    const kind = alertKind(j.err_kind);
    const recent = await db
      .prepare('SELECT 1 AS n FROM alerts WHERE user_id=? AND bot_id=? AND kind=? AND pushed=1 AND ts>? LIMIT 1')
      .bind(U, j.bot_id, kind, now() - ALERT_THROTTLE)
      .first();
    const who = (await db.prepare('SELECT name FROM bots WHERE id=? AND user_id=?').bind(j.bot_id, U).first())?.name || '機器人';
    const link = retryLink(env.remoteLink?.() || '', j.bot_id, j.id);
    const text = alertText(who, kind, j.prompt, j.err_msg, link);
    const send = !recent && !(st.mute || {})[j.conv];
    const ins = await db
      .prepare('INSERT OR IGNORE INTO alerts (user_id,bot_id,conv,kind,job,text,ts,pushed) VALUES (?,?,?,?,?,?,?,?)')
      .bind(U, j.bot_id, j.conv, kind, j.id, clean(text, 2000), now(), send ? 1 : 0)
      .run();
    if (!ins.meta?.changes) continue;
    const h = held.get(who);
    held.delete(who);
    if (send) {
      try {
        await sendNotify(env, st, text, h && now() - h.at < 2 * MIN ? h.photo : null, { alert: true });
      } catch {}
      pushed++;
    }
  }
  await bump(db, U);
  return pushed;
}
// 一鍵重試 (from an alert, a notification link or the overview): the same job again from the start, once.
// Only through the API: this computer, or a paired phone / linked computer (router auth).
export async function retryJob(db, U, id) {
  const j = await db.prepare('SELECT * FROM jobs WHERE id=? AND user_id=?').bind(+id || 0, U).first();
  if (!j) return { error: '找不到這件工作', status: 404 };
  if ((j.kind || 'chat') !== 'chat' || j.status === 'pending' || j.status === 'running') return { error: '這件工作不能重試' };
  const again = await db
    .prepare('SELECT id, status FROM jobs WHERE retry_of=? AND user_id=? ORDER BY id DESC LIMIT 1')
    .bind(j.id, U)
    .first();
  if (again)
    return {
      error: again.status === 'pending' || again.status === 'running' ? '已經在重試了' : '這件已經重試過了',
      status: 409,
      job: again.id
    };
  if (!(await db.prepare('SELECT 1 AS n FROM bots WHERE id=? AND user_id=?').bind(j.bot_id, U).first()))
    return { error: '機器人已刪除' };
  const r = await db
    .prepare('INSERT INTO jobs (user_id,conv,bot_id,chain,prompt,created,depth,retry_of,routine,hook) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .bind(
      U,
      j.conv,
      j.bot_id,
      j.chain || '[]',
      String(j.prompt || '').replace(/\n\n（自動重試 \d+）[\s\S]*$/, ''),
      now(),
      j.depth || 0,
      j.id,
      j.routine || null,
      j.hook || null
    )
    .run();
  try {
    await ensureAlerts(db);
    await db.prepare('UPDATE alerts SET retried=? WHERE job=? AND user_id=?').bind(now(), j.id, U).run();
  } catch {}
  await bump(db, U);
  return { job: r?.meta?.last_row_id ?? null };
}
export async function alertRoutes(c) {
  const { db, path, m, url, body, U } = c;
  if (path === 'alerts' && m === 'GET') {
    await ensureAlerts(db);
    const after = Math.max(0, +url.searchParams.get('after') || 0);
    const rows = (
      await db
        .prepare(
          `SELECT a.id, a.bot_id, a.conv, a.kind, a.job, a.text, a.ts, a.pushed,
             (SELECT r.status FROM jobs r WHERE r.retry_of=a.job ORDER BY r.id DESC LIMIT 1) AS rs
           FROM alerts a WHERE a.user_id=? AND a.id>? AND a.ts>? ORDER BY a.id DESC LIMIT 20`
        )
        .bind(U, after, now() - 24 * 60 * MIN)
        .all()
    ).results;
    const top = (await db.prepare('SELECT MAX(id) AS n FROM alerts WHERE user_id=?').bind(U).first())?.n || 0;
    return J({
      top,
      alerts: rows.map(a => ({
        id: a.id,
        bot: a.bot_id,
        conv: a.conv,
        kind: a.kind,
        label: (ALERT_KINDS[a.kind] || ALERT_KINDS.api).label,
        job: a.job,
        text: a.text,
        ts: a.ts,
        pushed: !!a.pushed,
        retry: a.rs || null
      }))
    });
  }
  if (path === 'alerts/retry' && m === 'POST') {
    const r = await retryJob(db, U, body.job);
    if (r.error) return J({ error: r.error, job: r.job || null }, r.status || 400);
    const res = J({ ok: true, job: r.job });
    return res;
  }
  return null;
}
