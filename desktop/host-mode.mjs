// 主機模式 on the desktop app: the account's data lives in this computer's database.
// The cloud (octa.yzprojecttw.com) keeps the account and sign-ins, and forwards every other request through
// this computer's tunnel, signed with HMAC-SHA256(hkey, user \n ts \n method \n path?query \n sha256(body)).
// No Electron or sql.js here, so the pieces can be tested with plain Node.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const SKEW_MS = 5 * 60000;          // forwarded requests older or newer than this are refused
export const REGISTER_EVERY = 10 * 60000;  // the cloud is told the tunnel address this often (and when it changes)

export const sha256Hex = buf => createHash('sha256').update(buf || Buffer.alloc(0)).digest('hex');
export const signText = (user, ts, method, pathQuery, bodyHash) => `${user}\n${ts}\n${method}\n${pathQuery}\n${bodyHash}`;
export const sign = (key, user, ts, method, pathQuery, body) =>
  createHmac('sha256', String(key)).update(signText(user, ts, method, pathQuery, sha256Hex(body))).digest('hex');

// a request the cloud forwarded → { ok: true, user } or { ok: false, error }
// headers: Node's lower-case header object. seen: a Map that remembers signatures (a replayed request is refused).
export function verifyForwarded({ key, headers, method, pathQuery, body, now = Date.now(), seen = null, expectUser = '' }) {
  const user = String(headers['x-octa-user'] || ''), ts = String(headers['x-octa-ts'] || ''), sig = String(headers['x-octa-sig'] || '');
  if (!key) return { ok: false, error: '這台電腦還沒有連線金鑰' };
  if (!user || !/^\d{10,16}$/.test(ts) || !/^[0-9a-f]{64}$/.test(sig)) return { ok: false, error: '簽章格式不正確' };
  if (Math.abs(now - Number(ts)) > SKEW_MS) return { ok: false, error: '請求時間差太大' };
  if (expectUser && user !== expectUser) return { ok: false, error: '帳號不符' };
  const want = Buffer.from(sign(key, user, ts, method, pathQuery, body), 'hex');
  if (!timingSafeEqual(want, Buffer.from(sig, 'hex'))) return { ok: false, error: '簽章不正確' };
  if (seen) {
    if (seen.has(sig)) return { ok: false, error: '重複的請求' };
    seen.set(sig, now);
    if (seen.size > 500) for (const [k, t] of seen) if (now - t > 2 * SKEW_MS) seen.delete(k);
  }
  return { ok: true, user };
}

// Handler for the tunnel port. Signed requests are answered by the API as this computer's only user (like the window).
// opts: { onRequest, env() → base env, key() → hkey, enabled() → in 主機模式, expectUser() → cloud user id, onChange() }
// Returns (req, res, body: Buffer) => Promise. Every answer says x-octa-host: on | off | bad so the cloud can tell
// OCTA's answers from the tunnel's own error pages.
export function hostHandler(opts) {
  const seen = new Map();
  const send = (res, status, data, said) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'x-octa-host': said, 'cache-control': 'no-store' });
    res.end(JSON.stringify(data));
  };
  return async (req, res, body) => {
    if (!opts.enabled()) return send(res, 409, { error: '這台電腦目前不是資料主機' }, 'off');
    if (!req.url.startsWith('/api/')) return send(res, 404, { error: '找不到' }, 'on');
    const pathQuery = req.url.slice(5);
    const v = verifyForwarded({ key: opts.key(), headers: req.headers, method: req.method, pathQuery, body, seen, expectUser: opts.expectUser?.() || '' });
    if (!v.ok) return send(res, 401, { error: v.error }, 'bad');
    const path = pathQuery.split('?')[0].split('/').filter(Boolean).map(s => { try { return decodeURIComponent(s); } catch { return s; } });
    if (path[0] === 'desktop' || path[0] === 'runner') return send(res, 403, { error: '不允許' }, 'on');   // this computer's own controls and its runner stay local
    const o = String(req.headers['x-octa-origin'] || '');
    const origin = /^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(o) ? o : 'https://' + (req.headers.host || 'host');   // links the API writes point at the cloud address
    let coach = String(req.headers['x-octa-coach'] || '');
    try { coach = decodeURIComponent(coach); } catch { }
    const env = { ...opts.env(), isLocal: true, ...(path[0] === 'coach' && coach ? { coachAs: { user_id: 'local', label: coach.slice(0, 40) } } : {}) };
    const headers = { 'content-type': String(req.headers['content-type'] || 'application/json') };
    if (req.headers['x-line-signature']) headers['x-line-signature'] = String(req.headers['x-line-signature']);
    const request = new Request(origin + req.url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
    const r = await opts.onRequest({ request, env, params: { path } });
    res.writeHead(r.status, { ...Object.fromEntries(r.headers), 'x-octa-host': 'on' });
    res.end(Buffer.from(await r.arrayBuffer()));
    if (req.method !== 'GET') opts.onChange?.();
  };
}

// ---------- moving the account's data from the cloud ----------
// settings first (account name, schedule), then the tables; ids are kept so messages, files and jobs stay linked
export const MOVE_TABLES = ['settings', 'folders', 'bots', 'groups_', 'routines', 'messages', 'jobs', 'files', 'chunks', 'stats', 'code_repos', 'code_tasks'];
const LABEL = { settings: '設定', folders: '分區', bots: '機器人', groups_: '群組', routines: '例行任務', messages: '對話', jobs: '工作紀錄', files: '檔案', chunks: '檔案內容', stats: '成果看板', code_repos: '程式專案', code_tasks: '程式任務' };
export const tableLabel = t => LABEL[t] || t;

// call(path, body) → the cloud's JSON answer (POST with this computer's runner key)
// db: D1-like (prepare/bind/all/first/run, batch). Writes every row with user_id → localUser.
// insert 'replace' for a fresh database; 'ignore' to add only what is new (a second pass after switching).
// → { counts: {table: rows}, lastMessage }
export async function importFromCloud({ call, db, localUser = 'local', tables = MOVE_TABLES, start = {}, insert = 'replace', verify = true, onProgress = () => { } }) {
  const counts = {};
  let lastMessage = start.messages || 0;
  for (let i = 0; i < tables.length; i++) {
    const t = tables[i];
    const cols = t === 'settings' ? [] : (await db.prepare(`PRAGMA table_info(${t})`).all()).results.map(r => r.name);
    let after = start[t] || 0, got = 0, expect = null;
    for (; ;) {
      const d = await call('host/export', { table: t, after });
      if (!d || !Array.isArray(d.rows)) throw new Error(`雲端沒有回傳「${tableLabel(t)}」`);
      if (expect === null) expect = +d.count || 0;
      if (t === 'settings') {
        const r = d.rows[0] || {};
        let st = {};
        try { st = JSON.parse(r.settings || '{}') || {}; } catch { }
        st.sched = 'pc';   // the host computer keeps the clock for 例行任務
        await db.prepare('UPDATE users SET settings=?, engines=COALESCE(?, engines) WHERE id=?').bind(JSON.stringify(st), r.engines || null, localUser).run();
        if (r.name) await db.prepare('UPDATE users SET name=? WHERE id=?').bind(String(r.name).slice(0, 32), localUser).run();
      } else if (d.rows.length) {
        const stmts = d.rows.map(row => {
          const keys = Object.keys(row).filter(k => cols.includes(k));
          const vals = keys.map(k => (k === 'user_id' ? localUser : row[k]));
          return db.prepare(`INSERT OR ${insert === 'ignore' ? 'IGNORE' : 'REPLACE'} INTO ${t} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).bind(...vals);
        });
        await db.batch(stmts);
        if (t === 'messages') lastMessage = Math.max(lastMessage, ...d.rows.map(r => +r.id || 0));
      }
      got += d.rows.length;
      onProgress({ table: t, label: tableLabel(t), index: i, total: tables.length, got, expect });
      if (d.next == null) break;
      if (+d.next <= after) throw new Error('雲端分頁游標不正確');
      after = +d.next;
    }
    if (verify && t !== 'settings') {
      const n = (await db.prepare(t === 'chunks' ? 'SELECT COUNT(*) AS n FROM chunks' : `SELECT COUNT(*) AS n FROM ${t} WHERE user_id=?`).bind(...(t === 'chunks' ? [] : [localUser])).first())?.n ?? 0;
      if (n !== got || got < expect) throw new Error(`「${tableLabel(t)}」只搬到 ${n} / ${Math.max(expect, got)} 筆，請重試`);
    }
    counts[t] = got;
  }
  if (tables.includes('jobs'))   // the cloud runner was stopped for the move: work that was running did not finish
    await db.prepare("UPDATE jobs SET status='error', err_kind='timeout', err_msg='改成存在這台電腦時中止' WHERE user_id=? AND status='running'").bind(localUser).run();
  return { counts, lastMessage };
}

// ---------- telling the cloud where this computer is ----------
// opts: { cloud, token() → runner key, tunnel() → Promise<https url>, ping(url) → Promise<bool>, restartTunnel(),
//         hooks() → Promise<string[]>, onKey(hkey), onMode(hmode), log(e), every, fetch }
export function hostLink(opts) {
  const f = opts.fetch || fetch;
  let timer = null, on = false, lastUrl = '', lastHooks = null, busy = null;
  const post = async body => {
    const r = await f(opts.cloud + '/api/host/register', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + opts.token() }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(d.error || 'HTTP ' + r.status); e.status = r.status; throw e; }
    return d;
  };
  async function register(force) {
    let url = await opts.tunnel();
    if (force && opts.ping && !(await opts.ping(url).catch(() => false))) { await opts.restartTunnel?.(); url = await opts.tunnel(); }   // after sleep the old address may be dead
    const hooks = opts.hooks ? (await opts.hooks()).slice().sort() : null;
    const sendHooks = hooks && JSON.stringify(hooks) !== JSON.stringify(lastHooks);
    if (!force && url === lastUrl && !sendHooks) return null;
    const d = await post({ url, ...(sendHooks ? { hooks } : {}) });
    lastUrl = url; if (sendHooks) lastHooks = hooks;
    if (d.hkey) opts.onKey?.(d.hkey);
    opts.onMode?.(+d.hmode === 1 ? 1 : 0);
    return d;
  }
  const run = force => (busy = busy || register(force).finally(() => (busy = null)));
  function schedule(ms) { clearTimeout(timer); if (on) timer = setTimeout(tick, ms); }
  async function tick() {
    try { await run(true); schedule(opts.every || REGISTER_EVERY); }
    catch (e) { opts.log?.(e); schedule(e?.status === 401 || e?.status === 403 ? 5 * 60000 : 30000); }
  }
  return {
    async start() { on = true; try { const d = await run(true); schedule(opts.every || REGISTER_EVERY); return d; } catch (e) { schedule(30000); throw e; } },
    stop() { on = false; clearTimeout(timer); lastUrl = ''; lastHooks = null; },
    // something changed here (a routine got an external-event key, the tunnel moved): tell the cloud if needed
    poke() { if (on) run(false).catch(e => opts.log?.(e)); },
    get running() { return on; }
  };
}
