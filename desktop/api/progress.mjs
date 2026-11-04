// 4.7 步驟進度 and 暫停: what a running job reports (jobs.progress, JSON) and the pause switch (jobs.paused).
//   POST runner/progress {id, text, step?, total?, steps?, kind?, pmode?, held?}  (runner-routes.mjs)
//   POST job/<id>/pause {on}                                            (here)
//   POST job/<id>/bump                     4.8 插隊: to the front of the queue (jobs.prio)
// GET state / busy give every running job `progress` (parsed object) and `paused` (boolean).
import { bump, getSettings } from './db.mjs';
import { clean, err, now } from './util.mjs';

const KINDS = ['browse', 'think', 'tool', 'ask'];
// what the runner sent → the stored object (at: when it was reported). Unknown fields are dropped.
export function progressOf(body) {
  const p = { text: clean(body?.text, 200) };
  const total = Math.floor(+body?.total || 0);
  if (Array.isArray(body?.steps) && body.steps.length) {
    p.steps = body.steps.slice(0, 7).map(s => clean(s, 40)).filter(Boolean);
    if (!p.steps.length) delete p.steps;
  }
  if (total > 0 && total <= 20) p.total = total;
  else if (p.steps) p.total = p.steps.length;
  const step = Math.floor(+body?.step || 0);
  if (step > 0 && p.total) p.step = Math.min(step, p.total);
  if (KINDS.includes(body?.kind)) p.kind = body.kind;
  if (body?.pmode === 'step' || body?.pmode === 'turn') p.pmode = body.pmode; // how soon 暫停 takes hold (step: before the next action; turn: after this AI run)
  if (body?.held) p.held = true; // stopped and waiting for 繼續
  return p;
}
// a stored progress (JSON, or plain text from before 4.7) → an object, or null
export function parseProgress(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw);
  if (s.startsWith('{')) {
    try {
      const o = JSON.parse(s);
      if (o && typeof o === 'object') return o;
    } catch {}
  }
  return { text: s };
}
// the same report again (a heartbeat) changes nothing the screens show
export const sameProgress = (raw, p) => {
  const o = parseProgress(raw);
  if (!o) return false;
  const { at, ...a } = o;
  return JSON.stringify(a) === JSON.stringify(p);
};
// busy rows (state / busy) as the app gets them
// 4.8 the queue in the 工作 panel: how long a run takes here lately (ms, the last 30 finished chat runs of 3 days)
// and how many bots the runner works at once
export async function queueInfo(db, U) {
  const r = await db
    .prepare(
      "SELECT AVG(finished-started) AS a, COUNT(*) AS n FROM (SELECT finished, started FROM jobs WHERE user_id=? AND kind='chat' AND status IN ('done','error') AND started IS NOT NULL AND finished>started AND created>? ORDER BY id DESC LIMIT 30)"
    )
    .bind(U, now() - 3 * 86400000)
    .first();
  const st = await getSettings(db, U);
  return { avg: r?.n ? Math.round(r.a) : null, slots: +st._slots || 3 };
}
// 4.9: from — the colleague that asked or handed this job over (jobs.via f, or an older 〔背景:<id>:…〕 prompt), for 深海基地
const fromOf = r => {
  try { const v = r.via ? JSON.parse(r.via) : null; if (v?.f) return String(v.f); } catch { }
  return (String(r.p0 || '').match(/^〔背景:([^:〕]+):/) || [])[1] || null;
};
export const busyRows = rows => rows.map(({ via, p0, ...r }) => ({ ...r, progress: parseProgress(r.progress), paused: !!r.paused, from: fromOf({ via, p0 }) }));

export async function jobRoutes(c) {
  const { db, path, m, body, U, ok } = c;
  const pm = path.match(/^job\/(\d+)\/pause$/);
  if (pm && m === 'POST') {
    const id = +pm[1];
    const job = await db.prepare("SELECT id,status FROM jobs WHERE id=? AND user_id=? AND status IN ('pending','running')").bind(id, U).first();
    if (!job) return err('這件工作已經結束', 404);
    const on = !(body.on === false || body.on === 0 || body.on === 'false');
    await db.batch([
      db.prepare('UPDATE jobs SET paused=?, beat=? WHERE id=?').bind(on ? 1 : null, now(), id),
      db.prepare('UPDATE users SET prog=prog+1 WHERE id=?').bind(U)
    ]);
    await bump(db, U);
    return ok({ ok: true, paused: on });
  }
  // 4.8 插隊: a queued job goes to the front of the queue (the runner takes the highest prio first, then the oldest)
  const bm = path.match(/^job\/(\d+)\/bump$/);
  if (bm && m === 'POST') {
    const id = +bm[1];
    const job = await db.prepare("SELECT id FROM jobs WHERE id=? AND user_id=? AND status='pending'").bind(id, U).first();
    if (!job) return err('這件工作已經開始或結束了', 404);
    const top = await db.prepare("SELECT MAX(IFNULL(prio,0)) AS p FROM jobs WHERE user_id=? AND status='pending'").bind(U).first();
    await db.prepare('UPDATE jobs SET prio=? WHERE id=?').bind((top?.p || 0) + 1, id).run();
    await bump(db, U);
    return ok({ ok: true });
  }
  return null;
}
