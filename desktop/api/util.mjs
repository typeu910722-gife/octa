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
export const WARM = [0, 30, 60, 120, 300, 600, -1];
export const JOB_MAX = [15, 30, 60, 120, 180]; // 單件工作最長時間 (minutes); a job still reporting is never cut short by the 20-minute silence check
export const jobMaxOk = v => (JOB_MAX.includes(+v) ? +v : 60); // AI 待機 seconds after a reply (0: off, -1: always)
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
