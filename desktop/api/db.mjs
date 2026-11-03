// The database side: paired-phone sessions, change signals (rev / long-poll wake-ups), messages and jobs, settings, schema upgrades, rate limits.
import { autonomyOk } from './chat.mjs';
import { fbParse } from './engines.mjs';
import { MIN, SESSION_IDLE, now, randTok, sha } from './util.mjs';

// ---------- paired phone ----------
export async function newSession(db, userId, kind, label = null, ua = null) {
  const t = randTok();
  await db
    .prepare('INSERT INTO sessions (token,user_id,kind,label,created,seen,ua) VALUES (?,?,?,?,?,?,?)')
    .bind(await sha(t), userId, kind, label, now(), now(), ua)
    .run();
  return t;
}
const SES_SQL =
  'SELECT s.token,s.user_id,s.kind,s.label,s.seen,s.created,u.name FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?';
export async function auth(req, db) {
  const h = req.headers.get('authorization') || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!t) return null;
  const tok = await sha(t);
  const s = await db.prepare(SES_SQL).bind(tok).first();
  if (!s || (s.kind !== 'web' && s.kind !== 'computer')) return null; // only a paired phone's (or, 4.3, a linked computer's) session opens the API
  const last = s.seen || s.created;
  if (now() - last > SESSION_IDLE) {
    await db.prepare('DELETE FROM sessions WHERE token=?').bind(tok).run();
    return null;
  }
  if (now() - last > 15 * MIN) await db.prepare('UPDATE sessions SET seen=? WHERE token=?').bind(now(), tok).run(); // rarely written (shown as 最近使用 in the paired phones list)
  return s;
}

// the runner and the open pages long-poll inside this same process, so a change wakes them at once
// instead of on their next look (every 1.5 s)
const wakers = new Set();
export const wake = () => {
  const ws = [...wakers];
  wakers.clear();
  for (const w of ws) w();
};
export const nap = (_env, ms) =>
  new Promise(r => {
    const f = () => {
        clearTimeout(t);
        wakers.delete(f);
        r();
      },
      t = setTimeout(f, ms);
    wakers.add(f);
  });
export const bump = (db, userId) =>
  db
    .prepare('UPDATE users SET rev=rev+1 WHERE id=?')
    .bind(userId)
    .run()
    .then(r => {
      wake();
      return r;
    });

// kind: null for conversation; 'bg' | 'fail' | 'note' go to the work panel instead of the chat (MSG_KINDS)
export const MSG_KINDS = ['bg', 'fail', 'note'];
export async function addMsg(db, userId, conv, by, text, files = null, reply = null, kind = null) {
  const rid = Number.isInteger(reply) && reply > 0 ? reply : null;
  await db
    .prepare('INSERT INTO messages (user_id,conv,by_,text,files,ts,reply,kind) VALUES (?,?,?,?,?,?,?,?)')
    .bind(userId, conv, by, text, files && files.length ? JSON.stringify(files) : null, now(), rid, MSG_KINDS.includes(kind) ? kind : null)
    .run();
}
// chain: list of bot ids (all use `prompt`) or {b, p} steps
// routine: the routines.id that started this work (the chain's later steps, retries and follow-ups keep it). Returns the new job id.
export async function addJob(db, userId, conv, chain, prompt, depth = 0, routine = null) {
  const steps = chain.map(s => (typeof s === 'string' ? { b: s, p: prompt } : s));
  if (!steps.length) return null;
  const r = await db
    .prepare('INSERT INTO jobs (user_id,conv,bot_id,chain,prompt,created,depth,via,routine) VALUES (?,?,?,?,?,?,?,?,?)')
    .bind(
      userId,
      conv,
      steps[0].b,
      JSON.stringify(steps.slice(1)),
      steps[0].p,
      now(),
      depth,
      steps[0].v ? JSON.stringify(steps[0].v) : null,
      routine || null
    )
    .run();
  return r?.meta?.last_row_id ?? null;
}

export async function loadAll(db, userId) {
  const [b, g, f, r] = await db.batch([
    db
      .prepare(
        'SELECT id,name,task,folder,engine,model,avatar,color,browser,shot_ts,shot_file,page,bpc,fb,autonomy,stood FROM bots WHERE user_id=? ORDER BY created'
      )
      .bind(userId),
    db.prepare('SELECT id,name,task,members,folder FROM groups_ WHERE user_id=? ORDER BY created').bind(userId),
    db.prepare('SELECT id,name,notes FROM folders WHERE user_id=? ORDER BY created').bind(userId),
    db
      .prepare(
        'SELECT id,conv,name,prompt,times,enabled,hook,watch,fired,last_run,last_status,last_job,last_text FROM routines WHERE user_id=? ORDER BY created'
      )
      .bind(userId)
  ]);
  return {
    bots: b.results.map(x => ({ ...x, fb: fbParse(x.fb), autonomy: autonomyOk(x.autonomy), stood: !!x.stood })),
    groups: g.results.map(x => ({ ...x, members: JSON.parse(x.members) })),
    folders: f.results,
    routines: r.results.map(x => ({
      ...x,
      times: JSON.parse(x.times),
      enabled: !!x.enabled,
      watch: x.watch ? JSON.parse(x.watch) : null,
      fired: JSON.parse(x.fired || '{}')
    }))
  };
}
export async function getSettings(db, userId) {
  const u = await db.prepare('SELECT settings FROM users WHERE id=?').bind(userId).first();
  try {
    return JSON.parse(u?.settings || '{}');
  } catch {
    return {};
  }
}
export const putSettings = (db, userId, st) =>
  db.prepare('UPDATE users SET settings=? WHERE id=?').bind(JSON.stringify(st), userId).run();
export const mask = t => (t ? '••••' + String(t).slice(-4) : '');

// Columns and tables added after the first release. Applied automatically the first time a new
// version runs against an older database (each statement is skipped if it already exists).
const MIGRATIONS = [
  'ALTER TABLE users ADD COLUMN host TEXT',
  'ALTER TABLE users ADD COLUMN rev INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE users ADD COLUMN reset TEXT',
  'ALTER TABLE sessions ADD COLUMN seen INTEGER',
  'ALTER TABLE sessions ADD COLUMN ua TEXT',
  'ALTER TABLE sessions ADD COLUMN ip TEXT',
  'ALTER TABLE sessions ADD COLUMN place TEXT',
  'ALTER TABLE sessions ADD COLUMN info TEXT',
  'ALTER TABLE bots ADD COLUMN shot_file TEXT',
  'ALTER TABLE files ADD COLUMN conv TEXT',
  'ALTER TABLE files ADD COLUMN loc TEXT',
  'ALTER TABLE files ADD COLUMN path TEXT',
  'ALTER TABLE files ADD COLUMN size INTEGER',
  'ALTER TABLE files ADD COLUMN want INTEGER',
  'CREATE INDEX IF NOT EXISTS file_user ON files(user_id, loc)',
  'CREATE INDEX IF NOT EXISTS ses_user ON sessions(user_id, kind)',
  'CREATE INDEX IF NOT EXISTS msg_conv ON messages(user_id, conv, id)',
  'ALTER TABLE messages ADD COLUMN reply INTEGER',
  'CREATE TABLE IF NOT EXISTS chunks (file_id TEXT NOT NULL, n INTEGER NOT NULL, data TEXT NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (file_id, n))',
  'CREATE TABLE IF NOT EXISTS logins (k TEXT PRIMARY KEY, fails INTEGER NOT NULL, until INTEGER NOT NULL)',
  'ALTER TABLE jobs ADD COLUMN progress TEXT',
  'ALTER TABLE jobs ADD COLUMN tokens INTEGER',
  'ALTER TABLE routines ADD COLUMN hook TEXT',
  'ALTER TABLE routines ADD COLUMN watch TEXT',
  'ALTER TABLE routines ADD COLUMN wstate TEXT',
  'CREATE INDEX IF NOT EXISTS routine_hook ON routines(hook)',
  'ALTER TABLE files ADD COLUMN pc TEXT',
  'ALTER TABLE bots ADD COLUMN bpc TEXT',
  'ALTER TABLE jobs ADD COLUMN pc TEXT',
  'ALTER TABLE bots ADD COLUMN fb TEXT',
  'ALTER TABLE jobs ADD COLUMN eng TEXT',
  'ALTER TABLE jobs ADD COLUMN tries INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE code_tasks ADD COLUMN fb TEXT',
  'CREATE TABLE IF NOT EXISTS code_repos (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, path TEXT NOT NULL, validated INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL)',
  "CREATE TABLE IF NOT EXISTS code_tasks (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, repo_id TEXT NOT NULL, title TEXT NOT NULL, prompt TEXT NOT NULL, criteria TEXT NOT NULL DEFAULT '', engine TEXT NOT NULL, model TEXT, fb TEXT, status TEXT NOT NULL DEFAULT 'queued', phase TEXT NOT NULL DEFAULT 'queued', role TEXT, workspace_id TEXT, branch TEXT, base_ref TEXT, head_ref TEXT, retries INTEGER NOT NULL DEFAULT 0, max_retries INTEGER NOT NULL DEFAULT 3, job_id INTEGER, summary TEXT, approval TEXT, cancel INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, updated INTEGER NOT NULL, finished INTEGER)",
  'ALTER TABLE code_tasks ADD COLUMN fb TEXT',
  'CREATE INDEX IF NOT EXISTS code_task_user ON code_tasks(user_id, created)',
  'CREATE TABLE IF NOT EXISTS code_events (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, user_id TEXT NOT NULL, ts INTEGER NOT NULL, role TEXT, kind TEXT NOT NULL, text TEXT, data TEXT)',
  'CREATE INDEX IF NOT EXISTS code_event_task ON code_events(task_id, id)',
  'CREATE TABLE IF NOT EXISTS live (bot_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, url TEXT, title TEXT, mime TEXT, data TEXT, ts INTEGER, handed INTEGER NOT NULL DEFAULT 0)',
  // 3.1: progress has its own counter (no full reload), live frames only while someone watches
  'ALTER TABLE users ADD COLUMN prog INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE live ADD COLUMN watch INTEGER',
  // why a job failed, its screenshot, and the automatic retry it led to
  'ALTER TABLE jobs ADD COLUMN err_kind TEXT',
  'ALTER TABLE jobs ADD COLUMN err_msg TEXT',
  'ALTER TABLE jobs ADD COLUMN shot TEXT',
  'ALTER TABLE jobs ADD COLUMN retry_of INTEGER',
  // 成果看板: per bot per day totals (jobs are kept only 14 days)
  'CREATE TABLE IF NOT EXISTS stats (user_id TEXT NOT NULL, bot_id TEXT NOT NULL, day TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0, ms INTEGER NOT NULL DEFAULT 0, timed INTEGER NOT NULL DEFAULT 0, tokens INTEGER NOT NULL DEFAULT 0, web INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, bot_id, day))',
  // 主動性: how freely a bot acts, default standby once, who asked for a job (幕後)
  'ALTER TABLE bots ADD COLUMN autonomy TEXT',
  'ALTER TABLE bots ADD COLUMN stood INTEGER',
  'ALTER TABLE jobs ADD COLUMN via TEXT',
  // D1 讀取量: today's / last-14-days job queries (token counts, 幕後, weekly review) read only their own days
  'CREATE INDEX IF NOT EXISTS job_created ON jobs(user_id, created)',
  // a running job's last heartbeat: a long job that keeps reporting is not taken for a stuck one
  'ALTER TABLE jobs ADD COLUMN beat INTEGER',
  // 排程看得到有沒有跑: each routine keeps its last run, and the jobs it started point back to it
  'ALTER TABLE routines ADD COLUMN last_run INTEGER',
  'ALTER TABLE routines ADD COLUMN last_status TEXT',
  'ALTER TABLE routines ADD COLUMN last_job INTEGER',
  'ALTER TABLE routines ADD COLUMN last_text TEXT',
  'ALTER TABLE jobs ADD COLUMN routine TEXT',
  // 4.1: each bot's avatar colour; what is conversation and what goes to the work panel
  'ALTER TABLE bots ADD COLUMN color TEXT',
  'ALTER TABLE messages ADD COLUMN kind TEXT'
];
const schemaReady = new WeakSet();
export async function ensureSchema(db) {
  if (schemaReady.has(db)) return;
  try {
    await db.batch(
      [
        'SELECT want, pc FROM files',
        'SELECT k FROM logins',
        'SELECT progress, tokens, pc, eng, tries FROM jobs',
        'SELECT hook, watch, wstate FROM routines',
        'SELECT bpc, fb FROM bots',
        'SELECT id, fb FROM code_tasks',
        'SELECT reply FROM messages',
        'SELECT handed, watch FROM live',
        'SELECT prog FROM users',
        'SELECT err_kind, err_msg, shot, retry_of FROM jobs',
        'SELECT web FROM stats',
        'SELECT autonomy, stood FROM bots',
        'SELECT via FROM jobs',
        "SELECT id FROM jobs INDEXED BY job_created WHERE user_id='' AND created>0",
        'SELECT beat FROM jobs',
        'SELECT last_run, last_status, last_job, last_text FROM routines',
        'SELECT routine FROM jobs',
        'SELECT color FROM bots',
        'SELECT kind FROM messages'
      ].map(q => db.prepare(q + ' LIMIT 0'))
    );
    schemaReady.add(db);
    return;
  } catch {}
  for (const sql of MIGRATIONS) {
    try {
      await db.prepare(sql).run();
    } catch {}
  }
  schemaReady.add(db);
}

// ---------- rate limiting (external events) ----------
export async function blocked(db, keys) {
  for (const [k, max] of keys) {
    const r = await db.prepare('SELECT fails,until FROM logins WHERE k=?').bind(k).first();
    if (r && r.until > now() && r.fails >= max) return Math.ceil((r.until - now()) / MIN);
  }
  return 0;
}
export async function failed(db, keys) {
  for (const [k] of keys)
    await db
      .prepare(
        `INSERT INTO logins (k,fails,until) VALUES (?,1,?) ON CONFLICT(k) DO UPDATE SET
      fails=CASE WHEN until<? THEN 1 ELSE fails+1 END, until=CASE WHEN until<? THEN excluded.until ELSE until END`
      )
      .bind(k, now() + 15 * MIN, now(), now())
      .run();
}
