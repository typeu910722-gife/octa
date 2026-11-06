// OCTA desktop server: the web app and its API, entirely on this computer (4.0: no cloud server).
// - Data lives in a local SQLite file (sql.js, no native build needed).
// - No accounts: the app on this computer is trusted; phones pair with a one-time code over a quick tunnel.
// - The runner is built in and talks to this server over loopback.
// Can run inside Electron (main.mjs) or on its own: `node server.mjs`.

import http from 'node:http';
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, chmodSync, cpSync, rmSync, readdirSync, statSync, copyFileSync } from 'node:fs';
import { join, dirname, extname, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync, execFile } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { createRequire } from 'node:module';
import os from 'node:os';
import { importFromCloud } from './cloud-import.mjs';
import { createScreens } from './screen-cast.mjs';
import { createLinking, FILES_LIMIT } from './link-server.mjs';
import { confirmOk, dirSize, isInside, backupRootFrom } from './wipe.mjs';
import { RELAY, REPUBLISH_MS, publishHook } from './host-link.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const WIN = process.platform === 'win32';
const pick = (...ps) => ps.find(p => existsSync(p));

// When packaged, build.mjs copies the web app (app/) and the schema next to this file.
// Fallbacks keep a checkout working while parts of the 4.0 layout are still on their way.
const WEB = pick(join(here, 'web', 'index.html'), join(here, '..', 'app', 'index.html'), join(here, '..', 'public', 'index.html'))?.replace(/[\\/]index\.html$/, '') || join(here, 'web');
const API = join(here, 'api', 'index.mjs');
const RUNNER = join(here, 'runner', 'index.mjs');
export const loadRunner = () => import(pathToFileURL(RUNNER).href);
const SCHEMA = pick(join(here, 'schema.sql'), join(here, '..', 'schema.sql'));
export const APP_VERSION = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8')).version;

// ---------- D1-compatible wrapper around sql.js ----------
async function openDb(file) {
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs({ locateFile: f => join(dirname(require.resolve('sql.js')), f) });
  const db = existsSync(file) ? new SQL.Database(readFileSync(file)) : new SQL.Database();
  let timer = null, closed = false;
  const save = () => {
    clearTimeout(timer); timer = null;
    if (closed) return;
    const tmp = file + '.tmp';
    writeFileSync(tmp, Buffer.from(db.export()));
    renameSync(tmp, file);
  };
  const dirty = () => { if (!timer) timer = setTimeout(save, 3000); };   // saving rewrites the whole file, so batch writes
  const norm = a => a.map(v => (v === undefined ? null : typeof v === 'boolean' ? +v : v));
  class Stmt {
    constructor(sql) { this.sql = sql; this.args = []; }
    bind(...a) { this.args = norm(a); return this; }
    _all() {
      const st = db.prepare(this.sql); st.bind(this.args);
      const rows = []; while (st.step()) rows.push(st.getAsObject()); st.free();
      return rows;
    }
    _run() {
      db.run(this.sql, this.args);
      const changes = db.getRowsModified();
      const last = db.exec('SELECT last_insert_rowid() AS id')[0]?.values[0][0] ?? 0;
      dirty();
      return { success: true, meta: { changes, last_row_id: last } };
    }
    _exec() { return /^\s*(SELECT|WITH)/i.test(this.sql) ? { results: this._all(), meta: {} } : { results: [], ...this._run() }; }
    async first() { return this._all()[0] ?? null; }
    async all() { return { results: this._all(), meta: {} }; }
    async run() { return this._run(); }
  }
  const d1 = {
    prepare: sql => new Stmt(sql),
    async batch(stmts) {
      db.run('BEGIN');
      try { const out = stmts.map(s => s._exec()); db.run('COMMIT'); dirty(); return out; }
      catch (e) { db.run('ROLLBACK'); throw e; }
    },
    exec: sql => { db.exec(sql); dirty(); },
    save,
    close() { save(); closed = true; db.close(); }   // cloud import: the file is replaced by the imported copy
  };
  return d1;
}
// Columns added after a release go here so existing installs upgrade in place.
const MIGRATIONS = ["ALTER TABLE bots ADD COLUMN engine TEXT NOT NULL DEFAULT 'claude'", 'ALTER TABLE bots ADD COLUMN model TEXT', 'ALTER TABLE users ADD COLUMN engines TEXT', 'ALTER TABLE jobs ADD COLUMN result TEXT', 'ALTER TABLE bots ADD COLUMN avatar TEXT', 'ALTER TABLE bots ADD COLUMN browser TEXT',
  // 2.0: host computer, live updates, files on the computer, devices
  'ALTER TABLE users ADD COLUMN host TEXT', 'ALTER TABLE users ADD COLUMN rev INTEGER NOT NULL DEFAULT 0', 'ALTER TABLE users ADD COLUMN reset TEXT',
  'ALTER TABLE sessions ADD COLUMN seen INTEGER', 'ALTER TABLE sessions ADD COLUMN ua TEXT', 'ALTER TABLE sessions ADD COLUMN ip TEXT', 'ALTER TABLE sessions ADD COLUMN place TEXT', 'ALTER TABLE sessions ADD COLUMN info TEXT',
  'ALTER TABLE bots ADD COLUMN shot_file TEXT',
  'ALTER TABLE files ADD COLUMN conv TEXT', 'ALTER TABLE files ADD COLUMN loc TEXT', 'ALTER TABLE files ADD COLUMN path TEXT', 'ALTER TABLE files ADD COLUMN size INTEGER', 'ALTER TABLE files ADD COLUMN want INTEGER',
  'CREATE INDEX IF NOT EXISTS file_user ON files(user_id, loc)', 'ALTER TABLE jobs ADD COLUMN progress TEXT', 'ALTER TABLE jobs ADD COLUMN tokens INTEGER',
  'ALTER TABLE routines ADD COLUMN hook TEXT', 'ALTER TABLE routines ADD COLUMN watch TEXT', 'ALTER TABLE routines ADD COLUMN wstate TEXT', 'CREATE INDEX IF NOT EXISTS routine_hook ON routines(hook)', 'ALTER TABLE files ADD COLUMN pc TEXT', 'ALTER TABLE bots ADD COLUMN bpc TEXT', 'ALTER TABLE jobs ADD COLUMN pc TEXT', 'ALTER TABLE bots ADD COLUMN fb TEXT', 'ALTER TABLE jobs ADD COLUMN eng TEXT', 'ALTER TABLE jobs ADD COLUMN tries INTEGER NOT NULL DEFAULT 0', 'ALTER TABLE code_tasks ADD COLUMN fb TEXT',
  'CREATE TABLE IF NOT EXISTS code_repos (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, path TEXT NOT NULL, validated INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS code_tasks (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, repo_id TEXT NOT NULL, title TEXT NOT NULL, prompt TEXT NOT NULL, criteria TEXT NOT NULL DEFAULT \'\', engine TEXT NOT NULL, model TEXT, fb TEXT, status TEXT NOT NULL DEFAULT \'queued\', phase TEXT NOT NULL DEFAULT \'queued\', role TEXT, workspace_id TEXT, branch TEXT, base_ref TEXT, head_ref TEXT, retries INTEGER NOT NULL DEFAULT 0, max_retries INTEGER NOT NULL DEFAULT 3, job_id INTEGER, summary TEXT, approval TEXT, cancel INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, updated INTEGER NOT NULL, finished INTEGER)',
  'CREATE INDEX IF NOT EXISTS code_task_user ON code_tasks(user_id, created)',
  'CREATE TABLE IF NOT EXISTS code_events (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, user_id TEXT NOT NULL, ts INTEGER NOT NULL, role TEXT, kind TEXT NOT NULL, text TEXT, data TEXT)',
  'CREATE INDEX IF NOT EXISTS code_event_task ON code_events(task_id, id)',
  // quote-reply and the live stage: CREATE TABLE in schema.sql does not add columns to a database from an older install
  'ALTER TABLE messages ADD COLUMN reply INTEGER',
  'CREATE TABLE IF NOT EXISTS chunks (file_id TEXT NOT NULL, n INTEGER NOT NULL, data TEXT NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (file_id, n))',
  'CREATE TABLE IF NOT EXISTS logins (k TEXT PRIMARY KEY, fails INTEGER NOT NULL, until INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS live (bot_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, url TEXT, title TEXT, mime TEXT, data TEXT, ts INTEGER, handed INTEGER NOT NULL DEFAULT 0)',
  // 4.1: each bot's avatar colour; work-panel messages (background, failures, long notes) are kept apart from the conversation
  'ALTER TABLE bots ADD COLUMN color TEXT', 'ALTER TABLE messages ADD COLUMN kind TEXT',
  // 4.5: work handed over through a 交接網址 (status, inbox, feedback)
  'ALTER TABLE jobs ADD COLUMN hook TEXT', 'ALTER TABLE jobs ADD COLUMN outs TEXT', 'CREATE INDEX IF NOT EXISTS job_hook ON jobs(hook)',
  'CREATE TABLE IF NOT EXISTS hook_jobs (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, routine TEXT NOT NULL, conv TEXT NOT NULL, from_ TEXT, text TEXT NOT NULL, parent TEXT, created INTEGER NOT NULL, seen INTEGER)',
  'CREATE INDEX IF NOT EXISTS hook_job_routine ON hook_jobs(routine, created)',
  // 4.7: markers taken out of a reply (notes, result, approval card) and 暫停
  'ALTER TABLE messages ADD COLUMN meta TEXT', 'ALTER TABLE jobs ADD COLUMN paused INTEGER',
  'ALTER TABLE messages ADD COLUMN upd INTEGER', 'ALTER TABLE jobs ADD COLUMN prio INTEGER', 'ALTER TABLE jobs ADD COLUMN quse TEXT',
  'ALTER TABLE jobs ADD COLUMN after INTEGER',
  // 4.14 Grok Bot（雲端）: the webhook and reply token of each bot on it, its runs (Grok Bot's hourly limit), jobs sent out
  'ALTER TABLE jobs ADD COLUMN ext INTEGER', 'CREATE TABLE IF NOT EXISTS grokcloud (bot_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token TEXT NOT NULL, url TEXT, key TEXT, created INTEGER NOT NULL, test TEXT)', 'CREATE TABLE IF NOT EXISTS gc_runs (user_id TEXT NOT NULL, bot_id TEXT NOT NULL, at INTEGER NOT NULL)'];

// ---------- helpers ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8' };
function serveStatic(req, res) {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') p = '/index.html';
  const f = normalize(join(WEB, p));
  if (!f.startsWith(WEB) || !existsSync(f)) { res.writeHead(404); return res.end('Not found'); }
  // 4.9: app/vendor/ files carry their version in the name (three-0.170.0…): the phone keeps them instead of fetching 700 KB again
  res.writeHead(200, { 'content-type': MIME[extname(f)] || 'application/octet-stream', 'cache-control': p.startsWith('/vendor/') ? 'public, max-age=31536000, immutable' : 'no-cache', 'x-content-type-options': 'nosniff' });
  res.end(readFileSync(f));
}
async function toRequest(req, base) {
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  return new Request(base + req.url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
}
async function sendResponse(res, r) {
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
}
const json = (res, data, status = 200) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
const readJson = async req => { const c = []; for await (const x of req) c.push(x); try { return JSON.parse(Buffer.concat(c).toString() || '{}'); } catch { return {}; } };
// Windows reserves random port ranges (Hyper-V, WSL, Docker): a blocked port fails with EACCES, a used one with EADDRINUSE.
function listen(server, port, tries = 0) {
  return new Promise((ok, no) => {
    server.once('error', e => {
      if (!['EADDRINUSE', 'EACCES', 'EPERM'].includes(e.code)) return no(e);
      ok(listen(server, tries < 20 ? port + 2 : 0, tries + 1));   // after 20 tries let the system pick a free port
    });
    server.listen(port, '127.0.0.1', () => ok(server.address().port));
  });
}
function openExternal(target) {
  if (WIN) spawn('cmd', ['/c', 'start', '', target], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [target], { detached: true, stdio: 'ignore' }).unref();
}

// ---------- file folder ----------
// Google Drive for desktop shows up as a drive (G:\我的雲端硬碟) or under CloudStorage on a Mac
function googleDrive() {
  const names = ['我的雲端硬碟', 'My Drive', '我的云端硬盘', 'マイドライブ'];
  if (WIN) {
    for (const L of 'GHIJKLMNOPQRSTUVWXYZDEF') for (const n of names) { const p = `${L}:\\${n}`; if (existsSync(p)) return p; }
    for (const n of names) { const p = join(os.homedir(), 'Google Drive', n); if (existsSync(p)) return p; }
    const old = join(os.homedir(), 'Google Drive'); if (existsSync(old)) return old;
  } else {
    const cs = join(os.homedir(), 'Library', 'CloudStorage');
    try { for (const d of readdirSync(cs).filter(x => x.startsWith('GoogleDrive'))) for (const n of names) { const p = join(cs, d, n); if (existsSync(p)) return p; } } catch { }
  }
  return null;
}
function moveDir(from, to) {   // move existing files into the new folder (merge, keep anything already there)
  for (const f of readdirSync(from)) {
    const a = join(from, f), b = join(to, f);
    if (existsSync(b)) continue;
    try { renameSync(a, b); } catch { cpSync(a, b, { recursive: true }); rmSync(a, { recursive: true, force: true }); }
  }
}

// ---------- remote access (Cloudflare quick tunnel) ----------
const CF_URL = {
  win32: 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe',
  darwin: `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-${os.arch() === 'arm64' ? 'arm64' : 'amd64'}.tgz`,
  linux: `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${os.arch() === 'arm64' ? 'arm64' : 'amd64'}`
};
async function ensureCloudflared(dir) {
  const bin = join(dir, WIN ? 'cloudflared.exe' : 'cloudflared');
  if (existsSync(bin)) return bin;
  mkdirSync(dir, { recursive: true });
  const url = CF_URL[process.platform];
  if (!url) throw new Error('這個作業系統不支援手機遠端');
  const r = await fetch(url);
  if (!r.ok) throw new Error('下載連線工具失敗（' + r.status + '）');
  const buf = Buffer.from(await r.arrayBuffer());
  if (url.endsWith('.tgz')) {
    const tgz = bin + '.tgz'; writeFileSync(tgz, buf);
    spawnSync('tar', ['-xzf', tgz, '-C', dir]);
  } else writeFileSync(bin, buf);
  if (!WIN) chmodSync(bin, 0o755);
  return bin;
}
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
// 4.4: the phone's stable entry (a static page on the OCTA site; site/go.html). It finds this computer's current
// address on ntfy.sh and signs the phone in with what it keeps in its own storage.
export const GO_URL = 'https://octa.yzprojecttw.com/go';
// 4.5: the 交接網址 other AIs call is <HOOK_BASE>/api/hook/<token>; the OCTA site forwards it to this computer's tunnel
// (legacy/hook-relay.mjs), which it finds through ntfy.sh (host-link.mjs publishHook)
export const HOOK_BASE = 'https://octa.yzprojecttw.com';
const HOOK_PATH = /^\/api\/hook\/[0-9a-zA-Z]{1,64}(\/(job\/[0-9a-zA-Z]{1,40}|inbox|feedback|teach|reply|progress|file\/[0-9a-zA-Z-]{1,60}))?\/?(\?[\w=&%.-]*)?$/;
const PHONE_IDLE = 90 * 86400000;   // a paired phone unused this long is signed out (desktop/api/util.mjs SESSION_IDLE)
const newCode = () => Array.from({ length: 8 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join('');

// ---------- main ----------
// opts: { dataDir, port, onNotify(text), hooks: { loginClaude, openFolder, getAutostart, setAutostart }, runnerOpts }
export async function startServer(opts = {}) {
  const dataDir = opts.dataDir || (existsSync(join(os.homedir(), '.ebot')) ? join(os.homedir(), '.ebot') : join(os.homedir(), '.octa'));
  mkdirSync(dataDir, { recursive: true });
  const dbFile = join(dataDir, 'ebot.sqlite');
  const prepDb = async file => {
    const d = await openDb(file);
    d.exec(readFileSync(SCHEMA, 'utf8'));
    for (const m of MIGRATIONS) { try { d.exec(m); } catch { } }
    await d.prepare("INSERT OR IGNORE INTO users (id,name,pw,created) VALUES ('local','本機','-',?)").bind(Date.now()).run();
    return d;
  };
  let db = await prepDb(dbFile);
  // 4.3: the database is replaced by another computer's copy (換成這台當主機) — the old one is kept as a dated backup
  const stampNow = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  async function swapDb(file) {
    db.save();
    const backup = join(dataDir, `ebot.backup-${stampNow()}.sqlite`);
    if (existsSync(dbFile)) copyFileSync(dbFile, backup);
    db.close();
    renameSync(file, dbFile);
    db = await prepDb(dbFile);
    base.DB = db;
    return backup;
  }
  async function restoreDb(backup) {
    db.close();
    copyFileSync(backup, dbFile);
    db = await prepDb(dbFile);
    base.DB = db;
  }
  const { onRequest } = await import(pathToFileURL(API).href);
  const { grokTick } = await import(pathToFileURL(join(dirname(API), 'grokcloud.mjs')).href);

  const tzOffset = -new Date().getTimezoneOffset();
  let runnerSeen = 0;
  const remote = { on: false, url: '', code: '', fails: 0 };   // phone pairing over the tunnel
  const goUrl = opts.goUrl || process.env.OCTA_GO_URL || GO_URL;
  const goOrigin = new URL(goUrl).origin;
  const hookBase = (opts.hookBase || process.env.OCTA_HOOK_BASE || HOOK_BASE).replace(/\/+$/, '');
  // 4.2 手機遙控: live pictures of the bots' browsers (only while someone watches) and the phone's input into them
  // (OCTA's own embedded browser takes the phone's input through Electron: opts.hooks.screenInput)
  const screen = opts.screen || createScreens({ resolvePort: async bot => (await loadRunner()).livePortOf(bot), inputHook: a => opts.hooks?.screenInput?.(a) });
  const base = {
    DB: db, TZ_OFFSET_MIN: String(tzOffset), ALLOW_SIGNUP: 'false', screen,
    // 接手 / 我好了 from any screen: the page's own flag, and the computer's 僅觀看 / 取得控制權 switch
    onHandoff: (bot, on) => { screen.flag(bot, on); try { opts.hooks?.onHandoff?.(bot, on); } catch { } },
    // links in notices (Telegram / LINE) go through /go, so they still work after this computer restarts
    remoteLink: () => (remote.on && remote.url ? goUrl : ''),
    // a paired phone asks what its /go page needs (the phones' relay key, this host's id and name)
    phoneGo: () => (linking?.role() === 'host' ? { ...linking.phoneInfo(), u: remote.url, go: goUrl } : null),
    // 4.5 交接網址: the public address other AIs call (the OCTA site forwards it here), and the tunnel it goes to now
    hostOs: opts.platform || process.platform,
    hookBase,
    hookTunnel: () => (linking?.role() === 'host' ? tunnel.url : ''),
    hooksChanged: () => { setTimeout(() => { hookKeep().catch(() => { }); }, 0); },
    // 4.14 Grok Bot（雲端）: is this token's current tunnel address on ntfy.sh (else replies go straight to the tunnel)
    hookPublished: token => { const p = hookPub.get(token); return !!p && !p.error && p.url === tunnel.url; },
    // 4.7 郵件連接器: mail attachments go to (and come from) the bot's folder in the file folder
    getStore: () => hooks.getStore(),
    mailConnect: opts.mailConnect,   // tests only: a plain socket to a fake mail server
    grokFileAllow: opts.grokFileAllow || [],   // tests only: origins Grok Bot's files may come from besides public https
  };
  const callApi = async (req, res, env, origin) => {
    const request = await toRequest(req, origin);
    const path = new URL(request.url).pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
    if (path[0] === 'runner') runnerSeen = Date.now();
    await sendResponse(res, await onRequest({ request, env, params: { path } }));
  };

  // 4.3 主機電腦／遙控器 (link-server.mjs); set up once the tunnel functions exist (below)
  let linking = null;
  const HANDING = { error: '正在把資料交給另一台電腦，暫時不能變更', handing: true };

  // local port: the desktop window and the built-in runner; trusted, no login
  let localPort = 0;
  const local = http.createServer(async (req, res) => {
    try {
      const host = req.headers.host || '';
      if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host)) { res.writeHead(403); return res.end(); }   // DNS-rebinding guard
      const origin = req.headers.origin;
      if (origin && !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin)) { res.writeHead(403); return res.end(); }
      if (!req.url.startsWith('/api/')) return serveStatic(req, res);
      if (req.method !== 'GET' && !(req.headers['content-type'] || '').includes('application/json')) { res.writeHead(415); return res.end(); }   // forces a CORS preflight for other sites
      if (req.url.startsWith('/api/desktop/')) return desktopApi(req, res);
      // a remote control: the page's API calls go to the host computer (this computer's own data is not used)
      if (linking?.role() === 'remote') {
        if (/^\/api\/config(\?|$)/.test(req.url)) return json(res, { local: true, pair: false, hook: hookBase, via: { name: linking.viaName() } });
        if (req.url.startsWith('/api/runner') || req.url.startsWith('/api/hook/')) { res.writeHead(503); return res.end(); }
        return linking.proxy(req, res);
      }
      if (linking?.handing() && req.method !== 'GET' && !req.url.startsWith('/api/runner')) return json(res, HANDING, 503);
      await callApi(req, res, { ...base, isLocal: true, runnerOnline: () => Date.now() - runnerSeen < 60000 }, `http://${host}`);
    } catch (e) { json(res, { error: e.message }, 500); }
  });
  // reuse last port so the window keeps its saved preferences (language, drafts)
  const portFile = join(dataDir, 'port.txt');
  let want = opts.port || 17777;
  try { const p = +readFileSync(portFile, 'utf8'); if (p > 1024 && p < 65535) want = p; } catch { }
  localPort = await listen(local, want);
  try { writeFileSync(portFile, String(localPort)); } catch { }

  // remote port: only reached through the tunnel. A phone must pair first; external events (/api/hook/<key>,
  // the key itself is the secret) come in without pairing while the tunnel is open.
  const remoteSrv = http.createServer(async (req, res) => {
    try {
      // is the tunnel still alive (the /go page asks too: which computer is this)
      if (req.url === '/__octa_ping') { res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store', 'access-control-allow-origin': '*', 'access-control-expose-headers': 'x-octa-host, x-octa-phone', 'x-octa-host': linking?.link().id || '', 'x-octa-phone': remote.on ? 'on' : 'off' }); return res.end('ok'); }
      // the /go page pairs a phone that scanned this computer's QR (the pairing code is in the QR)
      if (req.url === '/api/pair' && req.headers.origin === goOrigin) {
        res.setHeader('access-control-allow-origin', goOrigin); res.setHeader('vary', 'origin');
        if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '600' }); return res.end(); }
      }
      const hosting = linking?.role() !== 'remote';
      // (4.5: also hook/<key>/job/<id>, /inbox, /feedback, /teach — only these exact shapes, so nothing like "../" can
      // turn into another API path; and without the local trust: the hook route checks the key itself)
      if (hosting && HOOK_PATH.test(req.url)) {
        if (+(req.headers['content-length'] || 0) > 64 * 1024) return json(res, { error: '內容太大（上限 64 KB）' }, 413);
        return await callApi(req, res, { ...base, runnerOnline: () => Date.now() - runnerSeen < 60000 }, 'https://' + (req.headers.host || 'remote'));
      }
      // 4.3: other computers (pairing, finding the host, 換成這台當主機)
      if (req.url.startsWith('/api/link/') && linking) return await linking.remoteApi(req, res);
      // a linked computer works through here even while the phone remote is off
      const pc = req.url.startsWith('/api/') && linking ? await linking.computerOf(req) : null;
      if (pc && !hosting) return json(res, { error: '這台電腦已經不是主機', moved: true }, 409);
      if (!remote.on && !pc) { res.writeHead(503); return res.end('遠端已關閉'); }
      if (!hosting) { res.writeHead(503); return res.end('遠端已關閉'); }
      if (linking?.handing() && req.method !== 'GET') return json(res, HANDING, 503);
      if (!req.url.startsWith('/api/')) return serveStatic(req, res);
      if (req.url.startsWith('/api/desktop/') || req.url.startsWith('/api/runner')) { res.writeHead(403); return res.end(); }
      await callApi(req, res, {
        ...base, runnerOnline: () => Date.now() - runnerSeen < 60000,
        pairCheck: code => {
          if (remote.code && code.trim().toUpperCase() === remote.code) { remote.fails = 0; return true; }
          if (++remote.fails >= 10) { remote.code = newCode(); remote.fails = 0; }   // too many guesses: rotate
          return false;
        }
      }, 'https://' + (req.headers.host || 'remote'));
    } catch (e) { json(res, { error: e.message }, 500); }
  });
  const remotePort = await listen(remoteSrv, localPort + 1);

  // one Cloudflare quick tunnel to the remote port (phone pairing and external events)
  const tunnel = { url: '', proc: null, starting: null };
  function ensureTunnel() {
    if (tunnel.url && tunnel.proc) return Promise.resolve(tunnel.url);
    if (tunnel.starting) return tunnel.starting;
    tunnel.starting = (async () => {
      // tests and the two-computer check on one machine: the "tunnel" is the remote port itself
      if (opts.tunnel || process.env.OCTA_TEST_TUNNEL === 'direct') {
        const url = opts.tunnel ? await opts.tunnel(remotePort) : `http://127.0.0.1:${remotePort}`;
        tunnel.url = url; tunnel.proc = { kill() { } };
        return url;
      }
      const bin = await ensureCloudflared(join(dataDir, 'bin'));
      const proc = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${remotePort}`], { windowsHide: true });
      tunnel.proc = proc;
      const url = await new Promise((ok, no) => {
        const t = setTimeout(() => no(new Error('連線逾時，請再試一次')), 45000);
        const scan = d => { const m = String(d).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/); if (m) { clearTimeout(t); ok(m[0]); } };
        proc.stdout.on('data', scan); proc.stderr.on('data', scan);
        proc.on('exit', () => { clearTimeout(t); no(new Error('連線工具結束了')); });
      }).catch(e => { proc.kill(); if (tunnel.proc === proc) tunnel.proc = null; throw e; });
      tunnel.url = url;
      proc.on('exit', () => {
        if (tunnel.proc !== proc) return;
        Object.assign(tunnel, { url: '', proc: null }); Object.assign(remote, { on: false, url: '', code: '' });
      });
      return url;
    })().finally(() => (tunnel.starting = null));
    return tunnel.starting;
  }
  function stopTunnel() { const p = tunnel.proc; Object.assign(tunnel, { url: '', proc: null }); p?.kill(); }
  // A quick tunnel can stay running but stop working (sleep, network change: Cloudflare then answers 1033 for its
  // address). Check it from outside every minute; two misses in a row → start a new one (new address, published again).
  // Only Cloudflare itself saying the tunnel is gone counts (HTTP 530 / "Error 1033"). Our own network or DNS failing to
  // reach the brand-new address (Windows caches "not found" for minutes) is not the tunnel's fault and must not make
  // us throw away a working tunnel — that would change the address again and again and sign phones out each time.
  let tunnelMiss = 0, tunnelBorn = 0;
  async function tunnelCheck(fetchImpl = fetch, { now = Date.now() } = {}) {
    const url = tunnel.url;
    if (!url || !tunnel.proc || tunnel.starting || !/^https:\/\//.test(url)) { tunnelMiss = 0; return true; }
    if (!tunnelBorn) tunnelBorn = now;
    if (now - tunnelBorn < 3 * 60000) return true;   // a new quick tunnel needs a little while to be reachable everywhere
    let dead = false;
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 15000);
    try {
      const r = await fetchImpl(url + '/__octa_ping', { signal: ctl.signal, cache: 'no-store' });
      if (!(r.ok && r.headers.has('x-octa-host'))) {
        const body = r.ok ? '' : String(await r.text().catch(() => '')).slice(0, 4000);
        dead = r.status === 530 || /error\s*1033|cloudflare tunnel error/i.test(body);
      }
    } catch { dead = false; } finally { clearTimeout(t); }
    if (!dead) { tunnelMiss = 0; return true; }
    if (++tunnelMiss < 3 || tunnel.url !== url) return false;
    tunnelMiss = 0; tunnelBorn = 0;
    const wasRemote = remote.on;
    stopTunnel(); Object.assign(remote, { on: false, url: '', code: '' });
    try { await ensureTunnel(); if (wasRemote) await setRemote(true); } catch { }
    return false;
  }
  // the tunnel stays open while computers are linked to this one (4.3), even with the phone remote off
  let keepForLinks = async () => false;
  // (4.4: not while the phone remote is on or turning on — at start the two can overlap)
  // (4.5: nor while a 交接網址 exists — other AIs reach this computer through it)
  async function releaseTunnel() { if (remote.on || remote.starting || await keepForLinks() || await hooksExist() || remote.on || remote.starting) return; stopTunnel(); }
  // user: the switch in 設定 → 手機遠端 (remembered, so the phone remote comes back on after a restart)
  async function setRemote(on, user) {
    if (on && linking.role() === 'remote') throw new Error('這台電腦正在遙控另一台電腦。手機請連到主機電腦（在主機電腦的「設定 → 手機遠端」開啟）。');
    if (user) setPhoneWanted(!!on);
    if (!on) { Object.assign(remote, { on: false, url: '', code: '' }); await releaseTunnel(); return { on: false }; }
    if (!(remote.on && remote.url && tunnel.url && remote.url === tunnel.url)) {
      remote.starting = true;
      try {
        const url = await ensureTunnel();
        Object.assign(remote, { on: true, url, code: remote.code || newCode(), fails: 0 });
      } finally { remote.starting = false; }
    }
    linking.publishPhone(false).catch(() => { });
    return remoteInfo();
  }
  // what 設定 → 手機遠端 shows: the address and code, and the /go link (a QR) that pairs a phone and remembers this computer
  async function remoteInfo() {
    if (!remote.on) return { on: false };
    const p = linking.phoneInfo();
    const frag = new URLSearchParams({ tp: p.tp, k: p.k, h: p.h, n: p.n, u: remote.url, c: remote.code }).toString();
    const go = goUrl + '#' + frag;
    return { on: true, url: remote.url, code: remote.code, qr: await qr(remote.url), go, goQr: await qr(go), relay: linking.phoneRelay() };
  }
  // ---------- 4.4: the phone remote stays on across restarts ----------
  // desktop.json phoneRemote: true (the user turned it on) / false (turned it off) / unset (before 4.4: on when a phone
  // is still paired)
  const phoneWanted = () => { const v = opts.hooks?.getPhoneRemote ? opts.hooks.getPhoneRemote() : readCfgFile().phoneRemote; return typeof v === 'boolean' ? v : undefined; };
  function setPhoneWanted(v) { if (opts.hooks?.setPhoneRemote) return opts.hooks.setPhoneRemote(v); const c = readCfgFile(); c.phoneRemote = v; writeFileSync(cfgPath, JSON.stringify(c, null, 2)); }
  const livePhones = async () => !!(await db.prepare("SELECT 1 FROM sessions WHERE kind='web' AND COALESCE(seen,created)>? LIMIT 1").bind(Date.now() - PHONE_IDLE).first());
  async function phoneKeep() {
    if (linking.role() !== 'host' || linking.handing()) return;
    const want = phoneWanted();
    if (!(want === true || (want === undefined && await livePhones()))) return;
    if (remote.on && tunnel.url) return linking.publishPhone(false);
    try { await setRemote(true); } catch (e) { remote.error = e.message; }   // no network yet: the next check tries again
  }
  // ---------- 4.5: 交接網址 reach this computer from the OCTA site ----------
  // While any routine has a hook key, the tunnel stays open and, for each key, its current address is published on
  // ntfy.sh, sealed with a key derived from the hook key (only someone holding the 交接網址 can read it): when the
  // tunnel's address changes, when a hook is made, and every 6 hours (ntfy.sh keeps messages about 12 hours).
  const hookPub = new Map();   // hook key → { url, at, error }
  const hookState = { error: '', at: 0 };
  // 4.14: a Grok Bot（雲端）bot's reply token is published the same way (Grok Bot answers at /api/hook/<token>/reply)
  const gcKeys = async () => { try { return (await db.prepare('SELECT token FROM grokcloud').all()).results.map(r => r.token).filter(Boolean); } catch { return []; } };
  const hookKeys = async () => [...(await db.prepare('SELECT hook FROM routines WHERE hook IS NOT NULL').all()).results.map(r => r.hook).filter(Boolean), ...(await gcKeys())];
  const hooksExist = async () => linking?.role() === 'host' && (!!(await db.prepare('SELECT 1 FROM routines WHERE hook IS NOT NULL LIMIT 1').first()) || (await gcKeys()).length > 0);
  let hookRun = null;
  function hookKeep() {
    if (hookRun) return hookRun;
    hookRun = (async () => {
      if (linking.role() !== 'host' || linking.handing()) return;
      const keys = await hookKeys();
      for (const k of [...hookPub.keys()]) if (!keys.includes(k)) hookPub.delete(k);
      if (!keys.length) return;
      let url;
      try { url = await ensureTunnel(); } catch (e) { Object.assign(hookState, { error: e.message, at: Date.now() }); return; }
      for (const token of keys) {
        const p = hookPub.get(token);
        if (p && p.url === url && Date.now() - p.at < REPUBLISH_MS) continue;
        try { await publishHook({ token, url, fetch: opts.fetch || globalThis.fetch, relay: opts.relay || process.env.OCTA_RELAY || RELAY }); hookPub.set(token, { url, at: Date.now(), error: '' }); }
        catch (e) { hookPub.set(token, { url, at: Date.now() - REPUBLISH_MS + 5 * 60000, error: e.message }); }   // try again in 5 minutes
      }
      Object.assign(hookState, { error: '', at: Date.now() });
    })().finally(() => { hookRun = null; });
    return hookRun;
  }
  async function phones() {
    const rows = (await db.prepare("SELECT token,label,ua,created,seen FROM sessions WHERE kind='web' ORDER BY created").all()).results;
    return rows.map(r => ({ id: r.token.slice(0, 16), name: r.label && r.label !== 'phone' ? r.label : '手機', created: r.created, seen: r.seen || r.created }));
  }

  // 3.x cloud users: copy the account's data from the old cloud into a new database file, check it, then put it in
  // place of this one. The old file is kept as a dated backup; a failure leaves everything as it was.
  async function cloudImport({ call, onProgress }) {
    db.save();
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const backup = join(dataDir, `ebot.backup-${stamp}.sqlite`);
    if (existsSync(dbFile)) copyFileSync(dbFile, backup);
    const tmpFile = dbFile + '.moving';
    rmSync(tmpFile, { force: true });
    const fresh = await prepDb(tmpFile);
    let out;
    try { out = await importFromCloud({ call, db: fresh, onProgress }); fresh.close(); }
    catch (e) { try { fresh.close(); } catch { } rmSync(tmpFile, { force: true }); throw e; }
    db.close();
    renameSync(tmpFile, dbFile);
    db = await prepDb(dbFile);
    base.DB = db;
    return { ...out, backup };
  }
  // 4.3 link settings live in desktop.json (the Electron app passes its own copy of that file)
  const cfgPath = join(dataDir, 'desktop.json');
  const readCfgFile = () => { try { return JSON.parse(readFileSync(cfgPath, 'utf8')); } catch { return {}; } };
  linking = createLinking({
    dataDir, version: APP_VERSION, name: opts.name, fetch: opts.fetch, relay: opts.relay || process.env.OCTA_RELAY || undefined, watchMs: opts.watchMs,
    getDb: () => db, dbFile: () => dbFile, saveDb: () => db.save(), openDb: prepDb, swapDb, restoreDb,
    getStore: () => hooks.getStore(),
    tunnel: { ensure: () => ensureTunnel(), current: () => tunnel.url, release: () => { releaseTunnel().catch(() => { }); } },
    remoteOff: () => { Object.assign(remote, { on: false, url: '', code: '' }); },
    getLink: () => (opts.hooks?.getLink ? opts.hooks.getLink() : readCfgFile().link) || null,
    saveLink: l => { if (opts.hooks?.setLink) return opts.hooks.setLink(l); const c = readCfgFile(); c.link = l; writeFileSync(cfgPath, JSON.stringify(c, null, 2)); },
    hooks: {
      pauseHost: () => (opts.hooks?.pauseHost ? opts.hooks.pauseHost() : stopOwnRunner()),
      resumeHost: () => (opts.hooks?.resumeHost ? opts.hooks.resumeHost() : startOwnRunner()),
      onRole: r => { if (opts.hooks?.onRole) return opts.hooks.onRole(r); if (r === 'host') startOwnRunner(); else stopOwnRunner(); }
    }
  });
  keepForLinks = async () => linking.role() === 'host' && !!(await db.prepare("SELECT 1 FROM sessions WHERE kind='computer' LIMIT 1").first());

  async function qr(text) { try { return await require('qrcode').toDataURL(text, { margin: 1, width: 360 }); } catch { return ''; } }

  const hooks = {
    loginClaude: () => {
      if (WIN) spawn('cmd', ['/c', 'start', '', 'powershell', '-NoProfile', '-NoExit', '-Command', "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Write-Host 'Type /login to sign in to Claude, then close this window.'; claude"], { detached: true, stdio: 'ignore' }).unref();
      else if (process.platform === 'darwin') spawn('osascript', ['-e', 'tell application "Terminal" to do script "claude"']).unref();
      else spawn('x-terminal-emulator', ['-e', 'claude'], { detached: true, stdio: 'ignore' }).unref();
    },
    openFolder: () => openExternal(dataDir),
    installEngine: async (key) => {   // opens a terminal window that installs the tool, then starts its sign-in
      const { ENGINES } = await loadRunner();
      const e = ENGINES[key];
      if (!e) throw new Error('沒有這個 AI');
      const dir = join(dataDir, 'bin'); mkdirSync(dir, { recursive: true });
      const installCmd = e.npm ? `npm install -g ${e.npm}` : e.install[WIN ? 'win' : 'mac'];
      const preCmd = e.pre ? e.pre[WIN ? 'win' : 'mac'] : '';
      if (WIN) {   // PowerShell script saved as UTF-8 with BOM: cmd batch files mangle Chinese text ("'◆' is not recognized")
        const q = t => "'" + String(t).replace(/'/g, "''") + "'";
        const say = t => `Write-Host ${q(t)}`;
        const f = join(dir, `install-${key}.ps1`);
        // "powershell -Command '...'" installers run with the progress bar off
        // (Windows PowerShell 5's progress bar makes downloads crawl)
        // (an installer run in a child PowerShell, so an `exit` inside it can't close this window)
        const inline = c => { const m = /^(powershell .*?-Command )"(.*)"$/.exec(c || ''); return m ? `${m[1]}"\`$ProgressPreference='SilentlyContinue'; ${m[2]}"` : c; };
        const install = inline(installCmd), pre = inline(preCmd);
        writeFileSync(f, '\ufeff' + ['[Console]::OutputEncoding = [Text.Encoding]::UTF8', `$Host.UI.RawUI.WindowTitle = ${q('安裝 ' + e.label)}`,
          '$ErrorActionPreference = "Continue"', "$ProgressPreference = 'SilentlyContinue'",
          e.npm ? `if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { ${say('先安裝 Node.js（安裝 AI 工具需要它）…')}; winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements; $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User') }` : '',
          e.npm ? `if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { ${say('無法自動安裝 Node.js，請到 https://nodejs.org 安裝後重新按一次「安裝並登入」')}; Start-Process 'https://nodejs.org'; Read-Host ${q('按 Enter 關閉')}; exit }` : '',
          'Set-Location $HOME',   // not the OCTA folder: AI tools ask whether to trust the folder they start in
          say(`正在安裝 ${e.label}…`), pre, install,
          e.paths ? `$env:Path = [Environment]::ExpandEnvironmentVariables(${q(e.paths.win)}) + ';' + $env:Path` : '',
          e.npm ? `$env:Path = (npm prefix -g) + ';' + $env:Path` : '',
          // installer servers sometimes refuse for a moment (rate limits); try once more
          `if (-not (Get-Command ${q(e.bin)} -ErrorAction SilentlyContinue)) { ${say('安裝沒有成功，10 秒後再試一次…')}; Start-Sleep 10; ${install}; $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User') + ';' + $env:Path }`,
          `if (-not (Get-Command ${q(e.bin)} -ErrorAction SilentlyContinue)) { ${say('還是沒有安裝成功，請把上面的錯誤訊息截圖給我們，或稍後再按一次「安裝並登入」。')}; Read-Host ${q('按 Enter 關閉')}; exit }`,
          "Write-Host ''", say(`安裝完成。接著登入：${e.loginHint}`), "Write-Host ''", e.login,
          "Write-Host ''", `Read-Host ${q('完成後按 Enter 關閉這個視窗，回到 OCTA 按「測試」')}`].filter(Boolean).join('\r\n'));
        spawn('cmd', ['/c', 'start', '', 'powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', f], { cwd: os.homedir(), detached: true, stdio: 'ignore', windowsHide: false }).unref();
      } else {
        const f = join(dir, `install-${key}.command`);
        const install = installCmd, pre = preCmd;
        writeFileSync(f, ['#!/bin/bash', e.npm ? 'command -v npm >/dev/null || { echo "需要先安裝 Node.js：https://nodejs.org"; read -p "按 Enter 關閉"; exit; }' : '',
          `echo "正在安裝 ${e.label}…"`, pre, install, e.paths ? `export PATH="${e.paths.mac}:$PATH"` : '',
          `echo; echo "安裝完成。接著登入：${e.loginHint}"; echo`, e.login, 'echo; read -p "完成後按 Enter 關閉，回到 OCTA 按「測試」"'].filter(Boolean).join('\n'));
        chmodSync(f, 0o755);
        if (process.platform === 'darwin') spawn('open', ['-a', 'Terminal', f], { detached: true, stdio: 'ignore' }).unref();
        else spawn('x-terminal-emulator', ['-e', f], { detached: true, stdio: 'ignore' }).unref();
      }
    },
    getAutostart: () => false,
    getExtToken: () => { try { return JSON.parse(readFileSync(join(dataDir, 'desktop.json'), 'utf8')).extToken || ''; } catch { return ''; } },
    setExtToken: t => { let c = {}; try { c = JSON.parse(readFileSync(join(dataDir, 'desktop.json'), 'utf8')); } catch { } c.extToken = t; writeFileSync(join(dataDir, 'desktop.json'), JSON.stringify(c, null, 2)); },
    setAutostart: () => { throw new Error('只有安裝版支援開機自動啟動'); },
    getStore: () => { try { return JSON.parse(readFileSync(join(dataDir, 'desktop.json'), 'utf8')).store || join(dataDir, 'files'); } catch { return join(dataDir, 'files'); } },
    setStore: p => { let c = {}; try { c = JSON.parse(readFileSync(join(dataDir, 'desktop.json'), 'utf8')); } catch { } c.store = p; writeFileSync(join(dataDir, 'desktop.json'), JSON.stringify(c, null, 2)); },
    pickFolder: async () => null,
    ...opts.hooks
  };
  // which AI tools are installed; checked in parallel without blocking, cached for a minute
  let engCache = null, engAt = 0, engJob = null;
  async function engineStatus(fresh) {
    if (!fresh && engCache && Date.now() - engAt < 60000) return engCache;
    if (engJob) return engJob;
    const { ENGINES } = await loadRunner();
    const ver = bin => new Promise(ok => execFile(bin, ['--version'], { shell: WIN, timeout: 15000, windowsHide: true, encoding: 'utf8' },
      (err, out) => ok({ ok: !err, version: (out || '').trim().split(/\s/).find(x => /\d/.test(x)) || '' })));
    engJob = Promise.all(Object.entries(ENGINES).map(async ([k, e]) => { if (k === 'grokbot' && WIN) return [k, { ok: false, version: '', unsupported: true }];   // 4.5: grok-bot-cli doesn't work on Windows
      const v = await ver(e.bin); if (v.ok && e.also) v.ok = (await ver(e.also)).ok; return [k, v]; }))
      .then(r => { engCache = Object.fromEntries(r); engAt = Date.now(); return engCache; }).finally(() => (engJob = null));
    return engJob;
  }
  engineStatus().catch(() => { });   // warm the cache in the background
  async function desktopApi(req, res) {
    const p = new URL(req.url, 'http://x').pathname.slice('/api/desktop/'.length);
    const body = req.method === 'POST' ? await readJson(req) : {};
    // 4.5 清除這台電腦的資料 (設定 → 進階): only on this computer's own port (the remote port refuses /api/desktop/*).
    // On a remote control this is the remote control's own data; the host is not touched.
    if (p === 'wipe-info') {
      const store = hooks.getStore();
      const size = dirSize(store, FILES_LIMIT);
      const l = linking.link();
      return json(res, {
        can: !!hooks.wipe, dataDir, store, storeCustom: !isInside(store, dataDir), storeBytes: size.bytes, storeOver: size.over, limit: FILES_LIMIT,
        backupRoot: hooks.backupRoot ? hooks.backupRoot() : backupRootFrom({ documents: join(os.homedir(), 'Documents') }),
        role: linking.role(), hostName: linking.viaName(),
        computers: l.role === 'remote' ? 0 : (await db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE kind='computer'").first())?.n || 0,
        phones: l.role === 'remote' ? 0 : (await db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE kind='web'").first())?.n || 0
      });
    }
    if (p === 'wipe') {
      if (req.method !== 'POST') return json(res, { error: '找不到' }, 404);
      if (!confirmOk(body.word)) return json(res, { error: '請輸入「刪除」確認' }, 400);
      if (!hooks.wipe) return json(res, { error: '只有 OCTA 桌面版可以清除資料' }, 400);
      if (linking.handing()) return json(res, HANDING, 503);
      try {
        const r = await hooks.wipe({ backup: body.backup !== false, deleteStore: !!body.deleteStore, lang: String(body.lang || 'zh-TW').slice(0, 8) }, { saveDb: () => db.save() });
        return json(res, r || { ok: true }, r?.error ? 400 : 200);
      } catch (e) { return json(res, { error: e.message }, 400); }
    }
    if (p === 'status') {
      const engines = await engineStatus(!!body.fresh || new URL(req.url, 'http://x').searchParams.has('fresh'));
      const { findChrome } = await loadRunner();
      return json(res, {
        version: APP_VERSION,
        claude: engines.claude, engines,
        chrome: !!findChrome(),
        autostart: !!hooks.getAutostart(), extToken: !!hooks.getExtToken(), store: hooks.getStore(),
        remote: await remoteInfo(),
        role: linking.role(),
        // 4.5 交接網址: the public base, the tunnel it is forwarded to, and whether the addresses got published
        hooks: { base: hookBase, tunnel: tunnel.url, published: [...hookPub.values()].filter(p => !p.error).length, error: hookState.error || [...hookPub.values()].find(p => p.error)?.error || '' }
      });
    }
    try {
      if (p === 'remote') return json(res, await setRemote(!!body.on, true));
      // 4.4: the phones paired with this computer; 移除 signs one out at once
      if (p === 'phones') {
        if (body.remove) await db.prepare("DELETE FROM sessions WHERE kind='web' AND token LIKE ?").bind(String(body.remove).replace(/[^0-9a-f]/g, '').slice(0, 16) + '%').run();
        return json(res, { phones: await phones(), on: remote.on });
      }
      if (p === 'link') return json(res, req.method === 'POST' ? await linking.desktop(body) : await linking.status());
      if (p === 'login-claude') { hooks.loginClaude(); return json(res, { ok: true }); }
      if (p === 'install') { await hooks.installEngine(String(body.engine || '')); return json(res, { ok: true }); }
      if (p === 'open-folder') { hooks.openFolder(); return json(res, { ok: true }); }
      // files that live on this computer: read, show or open them
      if (p === 'file' || p === 'show-file' || p === 'open-file') {
        const rel = String(body.path || '').replace(/\\/g, '/');
        if (!rel || rel.split('/').includes('..') || /^([a-z]:|\/)/i.test(rel)) return json(res, { error: '路徑不正確' }, 400);
        const full = join(hooks.getStore(), ...rel.split('/'));
        if (!existsSync(full)) return json(res, { missing: true });
        if (p === 'show-file') {
          if (WIN) spawn('explorer', ['/select,', full], { detached: true, stdio: 'ignore' }).unref();
          else if (process.platform === 'darwin') spawn('open', ['-R', full], { detached: true, stdio: 'ignore' }).unref();
          else openExternal(dirname(full));
          return json(res, { ok: true });
        }
        if (p === 'open-file') { openExternal(full); return json(res, { ok: true }); }
        if (statSync(full).size > 40 * 1024 * 1024) return json(res, { tooBig: true });
        return json(res, { data: readFileSync(full).toString('base64') });
      }
      if (p === 'autostart') { hooks.setAutostart(!!body.on); return json(res, { ok: true }); }
      // a bot's browser: in OCTA, or a Chrome window because Google refused the sign-in in OCTA (and switching back)
      if (p === 'browser-mode') return json(res, hooks.browserMode ? hooks.browserMode(String(body.bot || '')) : { chrome: false });
      if (p === 'browser-embed') {
        const id = String(body.bot || '').slice(0, 64);
        if (!id || !hooks.useEmbedded) return json(res, { error: '這台電腦不能切換瀏覽器' }, 400);
        const r = await hooks.useEmbedded({ id, name: String(body.name || '機器人').slice(0, 40) });
        if (!r?.ok) return json(res, { error: r?.error || '切換失敗' }, 400);
        return json(res, r);
      }
      if (p === 'store') {   // where attachments, screenshots and outputs are kept
        const cur = hooks.getStore(), def = join(dataDir, 'files'), gd = googleDrive();
        if (body.set) {
          let to = body.set === 'default' ? def : body.set === 'google' ? (gd ? join(gd, 'OCTA') : null) : body.set === 'pick' ? await hooks.pickFolder() : null;
          if (!to) return json(res, { error: body.set === 'google' ? '找不到 Google 雲端硬碟。請先安裝「Google 雲端硬碟電腦版」並登入。' : '沒有選擇資料夾' }, 400);
          if (body.set === 'pick' && !/OCTA$/i.test(to)) to = join(to, 'OCTA');
          if (to !== cur) {
            mkdirSync(to, { recursive: true });
            if (body.move && existsSync(cur)) moveDir(cur, to);
            hooks.setStore(to);
          }
        }
        const now = hooks.getStore();
        return json(res, { path: now, isDefault: now === def, google: gd ? join(gd, 'OCTA') : '', onGoogle: !!gd && now.startsWith(gd) });
      }
      if (p === 'open-store') { mkdirSync(hooks.getStore(), { recursive: true }); openExternal(hooks.getStore()); return json(res, { ok: true }); }
      if (p === 'ext-token') {   // token from the Playwright Extension, kept only on this computer
        if (body.token !== undefined) hooks.setExtToken(String(body.token).trim().slice(0, 200));
        return json(res, { set: !!hooks.getExtToken() });
      }
    } catch (e) { return json(res, { error: e.message }, 400); }
    json(res, { error: '找不到' }, 404);
  }

  // call the desktop API from the Electron main process (the preload bridge's octaDesktop.call)
  async function callDesktop(p, body) {
    const r = await fetch(`http://127.0.0.1:${localPort}/api/desktop/${p}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || 'HTTP ' + r.status);
    return d;
  }

  // built-in runner
  const { startRunner } = await loadRunner();
  let bundled = {};
  try { bundled = { pwCli: join(dirname(require.resolve('@playwright/mcp/package.json')), 'cli.js'), nodeBin: process.execPath }; } catch { }
  // the Electron app starts the runner itself (runner: false) so it can hand over its embedded browsers
  let runner = null;
  function startOwnRunner() {
    if (opts.runner === false || runner) return;
    runner = startRunner({ url: `http://127.0.0.1:${localPort}`, token: '', home: dataDir, getExtToken: () => hooks.getExtToken(), getStore: () => hooks.getStore(), openInstall: k => hooks.installEngine(k), ...bundled, ...opts.runnerOpts });
  }
  function stopOwnRunner() { runner?.stop(); runner = null; }
  // a remote control's own runner stays off: the host does the work
  if (linking.role() === 'host') startOwnRunner();
  await linking.start();
  // 4.4: phone remote back on at start (when it was on, or a phone is paired), kept on while wanted (the tunnel can
  // drop), and its address kept on the relay for the /go page
  phoneKeep().catch(() => { });
  hookKeep().catch(() => { });   // 4.5: the 交接網址 work from the OCTA site after a restart
  // 4.14 Grok Bot（雲端）: work for those bots goes out from here too (the runner may be off or busy)
  let gcBusy = false;
  const gcTimer = setInterval(async () => { if (gcBusy || linking?.role() === 'remote') return; gcBusy = true; try { await grokTick(base, base.DB); } catch { } gcBusy = false; }, opts.grokMs || 3000);
  const phoneTimer = setInterval(async () => { await tunnelCheck().catch(() => { }); phoneKeep().catch(() => { }); hookKeep().catch(() => { }); }, opts.watchMs || 60000);
  phoneTimer.unref?.();

  return {
    tunnelCheck, tunnelUrl: () => tunnel.url,
    url: `http://127.0.0.1:${localPort}`, remoteUrl: `http://127.0.0.1:${remotePort}`, dataDir, webDir: WEB, runnerPath: RUNNER, apiPath: API, loadRunner,
    desktopApi: (p, body) => callDesktop(p, body), getStore: () => hooks.getStore(), installEngine: k => hooks.installEngine(k),
    cloudImport, link: linking, remotePort,
    // 4.5: before this computer's data is deleted — say goodbye to linked computers, close the tunnel and the database
    async wipeShutdown() {
      clearInterval(phoneTimer); clearInterval(gcTimer);
      const said = await linking.farewell().catch(() => ({}));
      linking.stop(); runner?.stop(); runner = null; screen.stopAll?.();
      Object.assign(remote, { on: false, url: '', code: '' }); stopTunnel();
      try { db.close(); } catch { }
      local.close(); remoteSrv.close(); local.closeAllConnections?.(); remoteSrv.closeAllConnections?.();
      return said;
    },
    get db() { return db; },   // tests: the database itself
    async close() { clearInterval(phoneTimer); clearInterval(gcTimer); linking.stop(); runner?.stop(); screen.stopAll?.(); tunnel.proc?.kill(); db.save(); local.close(); remoteSrv.close(); local.closeAllConnections?.(); remoteSrv.closeAllConnections?.(); }
  };
}

// standalone: node server.mjs
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const s = await startServer({ onNotify: t => console.log('🔔 ' + t) });
  console.log(`OCTA 已啟動：${s.url}　資料夾：${s.dataDir}`);
  if (!process.argv.includes('--no-open')) openExternal(s.url);
  const bye = async () => { await s.close(); process.exit(0); };
  process.on('SIGINT', bye); process.on('SIGTERM', bye);
}
