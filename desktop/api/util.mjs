// Small helpers and limits shared by every part of the local API.

export const J = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
export const err = (msg, status = 400) => J({ error: msg }, status);
export const now = () => Date.now();
export const uid = () => crypto.randomUUID();
const enc = new TextEncoder();
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
export const sha = async s => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
export const randTok = () => hex(crypto.getRandomValues(new Uint8Array(24)));
export const MIN = 60000,
  DAY = 86400000;
export const WARM = [0, 30, 60, 120, 300, 600, -1]; // AI 待機 seconds after a reply (0: off, -1: always)
// 單件工作最長時間 (minutes; 0: 不限); a job still reporting is never cut short by the 20-minute silence check
export const JOB_MAX = [0, 15, 30, 60, 120, 180];
// 4.15.3 同時工作的機器人: how many bots work at once on this computer (0 = 不限制; the runner still keeps memory free)
export const PAR = [3, 5, 8, 12, 0];
export const PAR_NONE = 99;
export const parOf = st => (PAR.includes(st?.par) ? (st.par === 0 ? PAR_NONE : st.par) : 3);
const unset = v => v === undefined || v === null || v === '';
export const jobMaxOk = (v, full = false) => (!unset(v) && JOB_MAX.includes(+v) ? +v : full ? 0 : 60);
// 4.11 全力模式: no per-job time / token / turn caps, AI 待機 always on, the runner keeps going until the work is done.
// On by default; 關 restores the economical behaviour (lean flags, 60-minute limit, 120-second standby, retry caps).
// Per bot: st.power[botId] = 'full' | 'save' overrides the global switch.
export const POWER = ['full', 'save'];
export const fullOn = (st, botId) => {
  const p = botId ? (st?.power || {})[botId] : null;
  return p === 'full' ? true : p === 'save' ? false : st?.full !== false;
};
// what a job gets: the user's own choice when made, else the mode's default
export const jobMaxOf = (st, botId) => {
  const full = fullOn(st, botId);
  const v = jobMaxOk(st?.jobMax, full);
  return !full && v === 0 ? 60 : v; // 不限 belongs to 全力模式 only
};
export const warmOf = (st, botId) => {
  const full = fullOn(st, botId);
  if (!unset(st?.warm) && WARM.includes(+st.warm)) return +st.warm;
  return full ? -1 : 120;
};
// unattended routines leave room for the person's own work: a 5-hour (or weekly) window this full is not spent on them
export const ROUTINE_QUOTA_CAP = 90;
// 全力模式: transient failures (timeouts, interruptions, tool/browser errors) keep being retried, with a growing pause
export const FULL_RETRY_MAX = 8;
export const retryDelay = n => Math.min(30 * MIN, 30000 * 2 ** Math.max(0, n - 1));
export const MAX_ASK_DEPTH = 4; // how many times bots may hand questions to each other in one run
export const WAIT_MS = 25000; // long-poll length
export const CHUNK = 900_000; // base64 characters per stored piece
export const MAX_FILE = 10 * 1024 * 1024;
export const SESSION_IDLE = 90 * DAY; // a paired phone's sign-in expires after 90 days without use
// "looked at most once per …" marks, kept per database (a database that is swapped or opened again starts fresh)
export const perDb = () => {
  const w = new WeakMap();
  return db => {
    let m = w.get(db);
    if (!m) w.set(db, (m = new Map()));
    return m;
  };
};

export const clean = (s, max) =>
  String(s ?? '')
    .trim()
    .slice(0, max);

export const folderOk = (folders, id) => (id && folders.some(f => f.id === id) ? id : null);

export const parseJson = (s, fallback = null) => {
  try {
    return s ? JSON.parse(s) : fallback;
  } catch {
    return fallback;
  }
};
