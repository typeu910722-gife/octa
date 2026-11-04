// 4.7 步驟進度 and 暫停: what a running job reports (jobs.progress, JSON) and the pause switch (jobs.paused).
//   POST runner/progress {id, text, step?, total?, steps?, kind?, pmode?, held?}  (runner-routes.mjs)
//   POST job/<id>/pause {on}                                            (here)
// GET state / busy give every running job `progress` (parsed object) and `paused` (boolean).
import { bump } from './db.mjs';
import { clean, err, now } from './util.mjs';

const KINDS = ['browse', 'think', 'tool', 'ask'];
// what the runner sent → the stored object (at: when it was reported). Unknown fields are dropped.
export function progressOf(body) {
  const p = { text: clean(body?.text, 120) };
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
export const busyRows = rows => rows.map(r => ({ ...r, progress: parseProgress(r.progress), paused: !!r.paused }));

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
  return null;
}
