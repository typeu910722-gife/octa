// 4.3 主機電腦／遙控器 inside the desktop server (server.mjs).
//
// Host (role 'host', the default): keeps the data and runs the bots. Other computers link to it once with a 連線碼
// (shown under 設定 → 電腦) and get a long-lived device session (sessions.kind 'computer'). While any computer is
// linked the host keeps its tunnel open and publishes the tunnel's address, encrypted, on ntfy.sh (host-link.mjs).
//
// Remote control (role 'remote'): this computer's window shows the host's data. The local server forwards the page's
// API calls to the host through the tunnel, adding this computer's device token (the token never reaches the page).
// This computer's own runner and database are not used; the database stays as it was, as a backup.
//
// 換成這台當主機 (a remote control asks): the host pauses its runner and refuses new work, hands over a copy of its
// database (and the files folder when it is not too big) in pieces, the remote control checks it (checksum, row
// counts), keeps its own old database as a backup, puts the copy in place, opens its tunnel and tells the old host
// the new address. The old host then becomes a remote control of the new one. A higher `epoch` on the relay decides
// who is host. Anything failing midway puts both back the way they were.
//
// Routes on the tunnel (remote port), all but pair need a computer session:
//   POST /api/link/pair {code, id, name}           → {token, secret, hostId, hostName, epoch}
//   GET  /api/link/hello                           → {hostId, name, role, epoch, version}
//   POST /api/link/bye                             (the remote control stops: its session is removed)
//   POST /api/link/handover/begin {confirm}        → {ticket, db: {size, sha, counts}, files: {count, bytes}}
//   GET  /api/link/handover/db?ticket&off          → database bytes (up to 4 MB per call)
//   GET  /api/link/handover/files?ticket           → [{p, s}]
//   GET  /api/link/handover/file?ticket&p&off      → file bytes (up to 4 MB per call)
//   POST /api/link/handover/commit {ticket, host: {id, name, url, token}, epoch}
//   POST /api/link/handover/abort {ticket}
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { copyFileSync, createReadStream, existsSync, mkdirSync, openSync, readSync, writeSync, closeSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join, dirname, sep } from 'node:path';
import os from 'node:os';
import { RELAY, REPUBLISH_MS, createRemoteClient, decodeLinkCode, encodeLinkCode, helloHost, hostUrlOk, newId, newSecret, pollHost, publishHost } from './host-link.mjs';

export const PIECE = 4 * 1024 * 1024;
export const FILES_LIMIT = 1024 * 1024 * 1024;   // above this the files folder is not moved (explained to the user)
const INVITE_MS = 10 * 60000;
const HANDOVER_IDLE_MS = 10 * 60000;
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const sha256 = s => createHash('sha256').update(s).digest('hex');
const randTok = () => randomBytes(24).toString('hex');
const json = (res, data, status = 200) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); };
const readBody = async req => { const c = []; for await (const x of req) c.push(x); return c.length ? Buffer.concat(c) : null; };
const readJson = async req => { try { return JSON.parse((await readBody(req))?.toString() || '{}'); } catch { return {}; } };
const fileSha = file => new Promise((ok, no) => { const h = createHash('sha256'); createReadStream(file).on('data', d => h.update(d)).on('end', () => ok(h.digest('hex'))).on('error', no); });
const parseInfo = s => { try { return JSON.parse(s || '{}') || {}; } catch { return {}; } };

// every table's row count: the copy must match the original
export async function tableCounts(db) {
  const tables = (await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()).results.map(r => r.name);
  const out = {};
  for (const t of tables) out[t] = (await db.prepare(`SELECT COUNT(*) AS n FROM "${t.replace(/"/g, '')}"`).first()).n;
  return out;
}
// the files folder: relative paths with '/' and sizes
export function listFiles(root) {
  const out = [];
  const walk = (dir, rel) => {
    let names = []; try { names = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of names) {
      const full = join(dir, d.name), r = rel ? rel + '/' + d.name : d.name;
      if (d.isDirectory()) walk(full, r);
      else if (d.isFile()) { try { out.push({ p: r, s: statSync(full).size }); } catch { } }
    }
  };
  if (root && existsSync(root)) walk(root, '');
  return out;
}
const relOk = p => typeof p === 'string' && p.length < 600 && !p.split('/').some(x => !x || x === '.' || x === '..') && !/^([a-z]:|\/|\\)/i.test(p) && !p.includes('\\');
function readPiece(file, off) {
  const size = statSync(file).size;
  if (!(off >= 0) || off > size) return null;
  const len = Math.min(PIECE, size - off), buf = Buffer.alloc(len);
  const fd = openSync(file, 'r'); try { readSync(fd, buf, 0, len, off); } finally { closeSync(fd); }
  return { buf, size };
}

// ctx: { dataDir, version, name?, getDb, swapDb(file) → backup, restoreDb(backup), saveDb, getStore,
//        tunnel: { ensure() → url, current() → url, release() }, remoteOff(), getLink, saveLink,
//        hooks: { onRole(role), pauseHost(), resumeHost() }, fetch, relay }
export function createLinking(ctx) {
  const fetchFn = ctx.fetch || globalThis.fetch;
  const relay = ctx.relay || RELAY;
  const myName = () => String(ctx.name || process.env.OCTA_PC_NAME || os.hostname() || '電腦').slice(0, 40);
  const link = () => {
    let l = ctx.getLink() || {};
    if (!l.id) { l = { ...l, id: newId() }; ctx.saveLink(l); }
    return { role: 'host', epoch: 0, ...l };
  };
  const save = l => ctx.saveLink(l);
  const role = () => link().role === 'remote' ? 'remote' : 'host';
  const hooks = ctx.hooks || {};
  const callHook = async (k, ...a) => { try { return await hooks[k]?.(...a); } catch (e) { console.error('link hook', k, e); } };

  // ---------- small rate limits (all tunnel traffic arrives from the local cloudflared) ----------
  const hits = new Map();
  const limited = (k, n, ms) => {
    const t = Date.now(), a = (hits.get(k) || []).filter(x => t - x < ms);
    if (a.length >= n) { hits.set(k, a); return true; }
    a.push(t); hits.set(k, a); return false;
  };

  // ---------- computer sessions on the host ----------
  async function computers() {
    const rows = (await ctx.getDb().prepare("SELECT token,label,created,seen,info FROM sessions WHERE kind='computer' ORDER BY created").all()).results;
    return rows.map(r => ({ id: r.token.slice(0, 16), name: r.label || '電腦', created: r.created, seen: r.seen || r.created, pc: parseInfo(r.info).pc || '' }));
  }
  async function computerOf(req) {
    const h = req.headers.authorization || '';
    const t = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
    if (!t || t.length > 200) return null;
    const tok = sha256(t);
    const s = await ctx.getDb().prepare("SELECT token,label,info,seen,created FROM sessions WHERE token=? AND kind='computer'").bind(tok).first();
    if (!s) return null;
    if (Date.now() - (s.seen || s.created) > 3600000) await ctx.getDb().prepare('UPDATE sessions SET seen=? WHERE token=?').bind(Date.now(), tok).run();
    return { ...s, pc: parseInfo(s.info).pc || '' };
  }
  async function addComputer(db, pc, name) {
    const rows = (await db.prepare("SELECT token,info FROM sessions WHERE kind='computer'").all()).results;
    for (const r of rows) if (parseInfo(r.info).pc === pc) await db.prepare('DELETE FROM sessions WHERE token=?').bind(r.token).run();   // linked again: one session per computer
    const t = randTok();
    await db.prepare('INSERT INTO sessions (token,user_id,kind,label,created,seen,info) VALUES (?,?,?,?,?,?,?)')
      .bind(sha256(t), 'local', 'computer', String(name || '電腦').slice(0, 40), Date.now(), Date.now(), JSON.stringify({ pc })).run();
    return t;
  }
  const linked = async () => role() === 'host' && (await computers()).length > 0;

  // ---------- host: publish where this computer is ----------
  const pub = { url: '', at: 0, error: '', ok: 0 };
  let superseded = null;
  async function publish(force) {
    const l = link();
    if (l.role !== 'host' || !l.secret) return;
    const url = ctx.tunnel.current();
    if (!url) return;
    if (!force && url === pub.url && Date.now() - pub.at < REPUBLISH_MS) return;
    // before telling everyone "I am the host": has another computer taken over meanwhile?
    try {
      const m = await pollHost({ secret: l.secret, fetch: fetchFn, relay });
      if (m && m.hostId !== l.id && m.epoch > (+l.epoch || 0)) return supersede(m);
    } catch { }
    try {
      await publishHost({ secret: l.secret, url, epoch: l.epoch || 0, hostId: l.id, hostName: myName(), fetch: fetchFn, relay });
      Object.assign(pub, { url, at: Date.now(), error: '', ok: Date.now() });
    } catch (e) { pub.error = e.message; pub.at = Date.now() - REPUBLISH_MS + 5 * 60000; pub.url = url; }   // try again in 5 minutes
  }
  // another computer is the host now (it has a higher epoch): stop working here and follow it
  async function supersede(m) {
    const l = link();
    superseded = { name: m.hostName, at: Date.now() };
    save({ ...l, role: 'remote', hostId: m.hostId, hostName: m.hostName || '', lastUrl: m.url, epoch: m.epoch, token: l.hostId === m.hostId ? l.token : '' });
    await becomeRemote();
  }
  let watchTimer = null;
  async function keepTunnel() {
    if (!(await linked())) {   // nobody linked and the 連線碼 has run out: the tunnel is not needed for this
      if (!(invite && Date.now() < invite.until) && !handing && role() === 'host') ctx.tunnel.release();
      return;
    }
    try { await ctx.tunnel.ensure(); await publish(false); } catch (e) { pub.error = e.message; }
  }
  function startWatch() { clearInterval(watchTimer); watchTimer = setInterval(() => { keepTunnel().catch(() => { }); }, ctx.watchMs || 60000); watchTimer.unref?.(); }

  // ---------- remote control ----------
  let client = null;
  function startClient() {
    client?.stop();
    client = createRemoteClient({ getLink: link, saveLink: save, fetch: fetchFn, relay, onState: s => { lastState = s; } });
    client.connect();
  }
  let lastState = null;
  async function becomeRemote() {
    clearInterval(watchTimer); watchTimer = null;
    invite = null;
    ctx.remoteOff?.();
    ctx.tunnel.release();
    startClient();
    await callHook('onRole', 'remote');
  }
  async function becomeHost() {
    client?.stop(); client = null; lastState = null;
    startWatch();
    keepTunnel().catch(() => { });
    await callHook('onRole', 'host');
  }

  // forward one request from this computer's page to the host
  const HOP = /^(content-type|cache-control|content-disposition|x-octa-[a-z-]+)$/i;
  async function proxy(req, res) {
    if (!client) startClient();
    let url = client.url();
    if (!url) { await Promise.race([client.connect(), new Promise(r => setTimeout(r, 4000))]); url = client.url(); }
    const st = client.status();
    if (!url) return json(res, { error: st.state === 'revoked' ? '主機電腦已經移除這台電腦，請重新連線' : '連不到主機電腦，重新連線中…', offline: true, state: st.state }, 503);
    const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await readBody(req);
    const headers = { authorization: 'Bearer ' + link().token };
    for (const k of ['content-type', 'accept']) if (req.headers[k]) headers[k] = req.headers[k];
    let r;
    const ac = new AbortController(), t = setTimeout(() => ac.abort(), 90000);
    res.on('close', () => { if (!res.writableEnded) ac.abort(); });   // the page went away (a long-poll it no longer needs)
    try { r = await fetchFn(url + req.url, { method: req.method, headers, body, signal: ac.signal }); }
    catch (e) { clearTimeout(t); if (res.destroyed || res.writableEnded) return; client.lost('連不到主機電腦'); return json(res, { error: '連不到主機電腦，重新連線中…', offline: true }, 503); }
    clearTimeout(t);
    const ct = r.headers.get('content-type') || '';
    if (r.status >= 500 && !ct.includes('json')) { client.lost('連不到主機電腦'); return json(res, { error: '連不到主機電腦，重新連線中…', offline: true }, 503); }   // the tunnel is gone (Cloudflare's own error page)
    if (r.status === 401) { client.lost('主機電腦拒絕了這台電腦'); return json(res, { error: '主機電腦已經移除這台電腦，請重新連線', unlinked: true }, 403); }
    if (r.status === 409 && ct.includes('json')) {   // the computer there is no longer the host
      const d = await r.clone().json().catch(() => ({}));
      if (d.moved) client.lost('那台電腦已經不是主機');
    }
    const out = {};
    for (const [k, v] of r.headers) if (HOP.test(k)) out[k] = v;
    res.writeHead(r.status, out);
    res.end(Buffer.from(await r.arrayBuffer()));
  }

  // ---------- invites (host) ----------
  let invite = null;   // {code, until, fails}
  async function makeInvite() {
    if (role() !== 'host') throw new Error('這台電腦正在遙控另一台電腦');
    const url = await ctx.tunnel.ensure();
    let l = link();
    if (!l.secret) { l = { ...l, secret: newSecret() }; save(l); }
    invite = { code: Array.from({ length: 8 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join(''), until: Date.now() + INVITE_MS, fails: 0 };
    startWatch();
    return { url, code: invite.code, linkCode: encodeLinkCode({ url, code: invite.code }), until: invite.until };
  }

  // ---------- handover (host side) ----------
  let handing = null;   // {ticket, by, at, last, snapshot, files, timer}
  function touch() { if (handing) handing.last = Date.now(); }
  async function endHandover(resume) {
    const h = handing; if (!h) return;
    handing = null; clearInterval(h.timer);
    rmSync(h.snapshot, { force: true });
    if (resume) await callHook('resumeHost');
  }
  async function begin(pc, body) {
    if (role() !== 'host') return [409, { error: '這台電腦已經不是主機', moved: true }];
    if (body.confirm !== 'HANDOVER') return [400, { error: '需要確認' }];
    if (handing && handing.by !== pc.pc) return [409, { error: '另一台電腦正在接手資料' }];
    if (handing) await endHandover(false);
    if (limited('begin', 6, 3600000)) return [429, { error: '試太多次了，請一小時後再試' }];
    await callHook('pauseHost');   // the runner stops: nothing changes the data while it is copied
    ctx.saveDb();
    const ticket = randTok();
    const snapshot = join(ctx.dataDir, `handover-${ticket.slice(0, 12)}.sqlite`);
    copyFileSync(ctx.dbFile(), snapshot);
    const counts = await tableCounts(ctx.getDb());
    const files = listFiles(ctx.getStore());
    handing = { ticket, by: pc.pc, name: pc.label, at: Date.now(), last: Date.now(), snapshot, files };
    handing.timer = setInterval(() => { if (handing && Date.now() - handing.last > HANDOVER_IDLE_MS) endHandover(true); }, 30000);
    handing.timer.unref?.();
    return [200, { ticket, db: { size: statSync(snapshot).size, sha: await fileSha(snapshot), counts }, files: { count: files.length, bytes: files.reduce((a, f) => a + f.s, 0) } }];
  }
  async function commit(pc, body) {
    if (!handing || body.ticket !== handing.ticket || handing.by !== pc.pc) return [409, { error: '交接已經取消，請重新開始' }];
    const h = body.host || {}, l = link();
    if (!hostUrlOk(h.url) || typeof h.token !== 'string' || h.token.length < 20 || typeof h.id !== 'string' || !h.id) return [400, { error: '新主機的資料不完整' }];
    const epoch = +body.epoch;
    if (!(epoch > (+l.epoch || 0))) return [400, { error: '交接編號不正確' }];
    save({ ...l, role: 'remote', hostId: h.id, hostName: String(h.name || '').slice(0, 40), token: h.token, lastUrl: String(h.url).replace(/\/+$/, ''), epoch, handedAt: Date.now() });
    await endHandover(false);
    setTimeout(() => { becomeRemote().catch(e => console.error('becomeRemote', e)); }, 300);   // after this answer has gone out through the tunnel
    return [200, { ok: true }];
  }

  // ---------- the tunnel side: /api/link/* ----------
  async function remoteApi(req, res) {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname.slice('/api/link/'.length);
    if (limited('all', 600, 60000)) return json(res, { error: '太多要求' }, 429);
    if (p === 'pair' && req.method === 'POST') {
      const body = await readJson(req);
      if (role() !== 'host') return json(res, { error: '這台電腦正在遙控另一台電腦，請在主機電腦上產生連線碼' }, 409);
      const code = String(body.code || '').trim().toUpperCase();
      if (!invite || Date.now() > invite.until || code !== invite.code) {
        if (invite && ++invite.fails >= 10) invite = null;   // too many guesses: the code stops working
        return json(res, { error: '連線碼錯誤或已過期，請在主機電腦上重新產生' }, 401);
      }
      const pcId = String(body.id || '').slice(0, 40), name = String(body.name || '電腦').slice(0, 40);
      if (!pcId || pcId === link().id) return json(res, { error: '不能連到自己' }, 400);
      invite = null;   // one code, one computer
      const token = await addComputer(ctx.getDb(), pcId, name);
      const l = link();
      startWatch(); publish(true).catch(() => { });
      return json(res, { token, secret: l.secret, hostId: l.id, hostName: myName(), epoch: l.epoch || 0 });
    }
    const pc = await computerOf(req);
    if (!pc) return json(res, { error: '這台電腦還沒有連結' }, 401);
    if (p === 'hello') {
      const l = link();
      return json(res, { hostId: l.id, name: myName(), role: l.role === 'remote' ? 'remote' : handing ? 'handing' : 'host', newHost: l.role === 'remote' ? l.hostId : undefined, epoch: l.epoch || 0, version: ctx.version });
    }
    if (p === 'bye' && req.method === 'POST') { await ctx.getDb().prepare('DELETE FROM sessions WHERE token=?').bind(pc.token).run(); return json(res, { ok: true }); }
    if (!p.startsWith('handover/')) return json(res, { error: '找不到' }, 404);
    const q = p.slice(9);
    if (q === 'begin' && req.method === 'POST') { const [s, d] = await begin(pc, await readJson(req)); return json(res, d, s); }
    if (q === 'abort' && req.method === 'POST') {
      const body = await readJson(req);
      if (handing && handing.ticket === body.ticket) await endHandover(true);
      return json(res, { ok: true });
    }
    if (q === 'commit' && req.method === 'POST') { const [s, d] = await commit(pc, await readJson(req)); return json(res, d, s); }
    // reading the copy: only with the ticket from begin, only by the computer that asked
    if (!handing || u.searchParams.get('ticket') !== handing.ticket || handing.by !== pc.pc) return json(res, { error: '交接已經取消，請重新開始' }, 409);
    touch();
    if (q === 'db') {
      const piece = readPiece(handing.snapshot, +u.searchParams.get('off') || 0);
      if (!piece) return json(res, { error: '位置不正確' }, 400);
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'x-octa-size': String(piece.size) }); return res.end(piece.buf);
    }
    if (q === 'files') return json(res, { files: handing.files });
    if (q === 'file') {
      const rel = u.searchParams.get('p') || '';
      if (!relOk(rel) || !handing.files.some(f => f.p === rel)) return json(res, { error: '找不到檔案' }, 404);
      const full = join(ctx.getStore(), ...rel.split('/'));
      if (!existsSync(full)) return json(res, { error: '找不到檔案' }, 404);
      const piece = readPiece(full, +u.searchParams.get('off') || 0);
      if (!piece) return json(res, { error: '位置不正確' }, 400);
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'x-octa-size': String(piece.size) }); return res.end(piece.buf);
    }
    return json(res, { error: '找不到' }, 404);
  }

  // ---------- 換成這台當主機 (remote-control side) ----------
  let switching = null;   // {p, text, error, done}
  const step = (p, text) => { switching = { ...switching, p, text }; };
  async function hostCall(url, token, path, { method = 'GET', body, raw } = {}) {
    const r = await fetchFn(url + '/api/link/' + path, { method, headers: { authorization: 'Bearer ' + token, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    if (raw && r.ok) return { buf: Buffer.from(await r.arrayBuffer()), size: +r.headers.get('x-octa-size') };
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(d.error || '主機電腦回應 ' + r.status), { status: r.status });
    return d;
  }
  async function download(url, token, path, dest) {
    const tmp = dest + '.part';
    mkdirSync(dirname(dest), { recursive: true });
    rmSync(tmp, { force: true });
    let off = 0, size = Infinity;
    const fd = openSync(tmp, 'w');
    try {
      while (off < size) {
        let piece, tries = 0;
        for (; ;) {
          try { piece = await hostCall(url, token, path + '&off=' + off, { raw: true }); break; }
          catch (e) { if (++tries >= 4 || e.status === 409) throw e; await new Promise(r => setTimeout(r, 1500 * tries)); }
        }
        if (!piece.buf) throw new Error('主機電腦沒有給資料');
        size = piece.size;
        if (!piece.buf.length && off < size) throw new Error('資料不完整');
        writeSync(fd, piece.buf); off += piece.buf.length;
        if (size === 0) break;
      }
    } finally { closeSync(fd); }
    renameSync(tmp, dest);
    return size;
  }
  async function switchHere() {
    if (switching && !switching.done) return { started: true };
    const l = link();
    if (l.role !== 'remote' || !l.token) throw new Error('這台電腦現在不是遙控器');
    if (!client) startClient();
    const url = client.url() || await client.connect();
    if (!url) throw new Error('連不到主機電腦，請等連線恢復再試');
    switching = { p: 0, text: '請主機電腦暫停工作…', error: '', done: false, started: Date.now() };
    run(url, l).catch(() => { });
    return { started: true };
  }
  async function run(url, l) {
    let ticket = '', backup = '', tunnelOn = false, committed = false;
    const tmpDb = join(ctx.dataDir, 'handover-in.sqlite');
    try {
      const b = await hostCall(url, l.token, 'handover/begin', { method: 'POST', body: { confirm: 'HANDOVER' } });
      ticket = b.ticket;
      step(5, '下載資料庫…');
      await download(url, l.token, `handover/db?ticket=${ticket}`, tmpDb);
      if (await fileSha(tmpDb) !== b.db.sha) throw new Error('資料庫下載不完整（檢查碼不符）');
      step(30, '檢查資料…');
      const fresh = await ctx.openDb(tmpDb);
      let counts;
      try { counts = await tableCounts(fresh); } catch (e) { fresh.close(); throw e; }
      for (const [t, n] of Object.entries(b.db.counts)) if ((counts[t] ?? -1) !== n) { fresh.close(); throw new Error(`資料筆數不符（${t}：${counts[t]} / ${n}）`); }
      // sessions: phones paired with the old host must pair again; this computer is no longer a remote control of
      // itself; the old host becomes a remote control of this one
      await fresh.prepare("DELETE FROM sessions WHERE kind='web'").run();
      for (const r of (await fresh.prepare("SELECT token,info FROM sessions WHERE kind='computer'").all()).results)
        if (parseInfo(r.info).pc === l.id) await fresh.prepare('DELETE FROM sessions WHERE token=?').bind(r.token).run();
      const oldHostToken = await addComputer(fresh, l.hostId, l.hostName || '原主機');
      fresh.close();
      // the files folder
      let filesNote = '';
      if (b.files.count) {
        if (b.files.bytes > FILES_LIMIT) filesNote = `檔案資料夾太大（${(b.files.bytes / 1073741824).toFixed(1)} GB），沒有搬過來。請把「${l.hostName || '原主機'}」的 OCTA 檔案資料夾複製到這台電腦的檔案資料夾。`;
        else {
          const { files } = await hostCall(url, l.token, `handover/files?ticket=${ticket}`);
          const store = ctx.getStore();
          let done = 0, bytes = 0;
          for (const f of files) {
            if (!relOk(f.p)) continue;
            const dest = join(store, ...f.p.split('/'));
            if (!dest.startsWith(store + sep) && dest !== store) continue;
            let have = -1; try { have = statSync(dest).size; } catch { }
            if (have !== f.s) {
              if (have >= 0) renameSync(dest, dest + '.octa-old');   // never lose this computer's own copy
              await download(url, l.token, `handover/file?ticket=${ticket}&p=${encodeURIComponent(f.p)}`, dest);
            }
            done++; bytes += f.s;
            step(35 + Math.round(45 * bytes / Math.max(1, b.files.bytes)), `搬移檔案… ${done} / ${files.length}`);
          }
        }
      }
      step(82, '把資料放到這台電腦（先備份原本的資料）…');
      backup = await ctx.swapDb(tmpDb);
      step(88, '打開這台電腦的連線…');
      const myUrl = await ctx.tunnel.ensure(); tunnelOn = true;
      step(93, '通知原主機改當遙控器…');
      const epoch = (+l.epoch || 0) + 1;
      save({ ...link(), switching: { ticket, epoch, backup, at: Date.now() } });   // a crash from here on is sorted out at the next start
      try { await hostCall(url, l.token, 'handover/commit', { method: 'POST', body: { ticket, epoch, host: { id: l.id, name: myName(), url: myUrl, token: oldHostToken } } }); committed = true; }
      catch (e) {
        // the answer may have been lost on the way: did the old host switch anyway?
        try { const h = await helloHost(url, l.token, { fetch: fetchFn }); committed = h.role === 'remote' && h.newHost === l.id; } catch { }
        if (!committed) throw e;
      }
      const fin = { ...link(), role: 'host', epoch, hostId: '', hostName: '', token: '', lastUrl: '', formerHost: { id: l.hostId, name: l.hostName } };
      delete fin.switching;
      save(fin);
      client?.stop(); client = null; lastState = null;
      switching = { p: 100, text: '完成，這台電腦現在是主機', error: '', done: true, ok: true, filesNote };
      startWatch();
      await publish(true);
      await callHook('onRole', 'host');
    } catch (e) {
      // put everything back: the old host carries on, this computer stays its remote control
      if (!committed) {
        if (backup) { try { await ctx.restoreDb(backup); } catch (x) { console.error('restore', x); } }
        if (tunnelOn) ctx.tunnel.release();
        const cur = link(); delete cur.switching; save(cur);
        if (ticket) hostCall(url, l.token, 'handover/abort', { method: 'POST', body: { ticket } }).catch(() => { });
      }
      rmSync(tmpDb, { force: true }); rmSync(tmpDb + '.part', { force: true });
      switching = { ...switching, error: e.message || String(e), done: true, ok: false };
    }
  }
  // started again in the middle of a switch (crash, power cut): finish it if the old host already let go, else undo
  async function resumeSwitch() {
    const l = link(), s = l.switching;
    if (!s) return;
    let gone = false;
    try { const h = await helloHost(l.lastUrl, l.token, { fetch: fetchFn }); gone = h.role === 'remote' && h.newHost === l.id; }
    catch (e) { gone = false; }
    if (gone) {
      const fin = { ...l, role: 'host', epoch: s.epoch, hostId: '', hostName: '', token: '', lastUrl: '', formerHost: { id: l.hostId, name: l.hostName } };
      delete fin.switching; save(fin);
      return 'host';
    }
    if (s.backup && existsSync(s.backup)) { try { await ctx.restoreDb(s.backup); } catch (e) { console.error('restore', e); } }
    const back = { ...l }; delete back.switching; save(back);
    return 'remote';
  }

  // ---------- this computer's own settings page: /api/desktop/link ----------
  async function desktop(body) {
    const l = link();
    const act = body?.act;
    if (act === 'invite') return makeInvite();
    if (act === 'remove') {
      const id = String(body.id || '');
      for (const c of await computers()) if (c.id === id) await ctx.getDb().prepare("DELETE FROM sessions WHERE kind='computer' AND token LIKE ?").bind(id + '%').run();
      if (!(await computers()).length && !invite) { clearInterval(watchTimer); watchTimer = null; ctx.tunnel.release(); }
      return status();
    }
    if (act === 'connect') {
      if (l.role === 'remote') throw new Error('這台電腦已經在遙控另一台電腦');
      if (handing) throw new Error('正在把資料交給另一台電腦，請稍後');
      if ((await computers()).length) throw new Error('已經有其他電腦連到這台電腦。請先在「已連結的電腦」移除它們，再把這台改成遙控器。');
      const d = decodeLinkCode(body.code, body.pin);
      if (d.error) throw new Error(d.error);
      let r;
      try { r = await fetchFn(d.url + '/api/link/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: d.code, id: l.id, name: myName() }) }); }
      catch { throw new Error('連不到這個網址。請確認主機電腦開著 OCTA，並重新產生連線碼。'); }
      const res = await r.json().catch(() => ({}));
      if (!r.ok || !res.token) throw new Error(res.error || '連不到主機電腦（' + r.status + '）');
      save({ ...link(), role: 'remote', secret: res.secret, epoch: +res.epoch || 0, hostId: res.hostId, hostName: res.hostName || '', token: res.token, lastUrl: d.url, linkedAt: Date.now() });
      await becomeRemote();
      return status();
    }
    if (act === 'address') {   // ntfy.sh unreachable: the user pastes the host's new address
      if (l.role !== 'remote') throw new Error('這台電腦不是遙控器');
      const raw = String(body.code || '').trim();
      const d = decodeLinkCode(raw.includes('#') ? raw : raw + '#octa-link=XXXXXXXX');
      if (d.error && !hostUrlOk(raw)) throw new Error('網址不正確');
      save({ ...l, lastUrl: (d.url || raw).replace(/\/+$/, '') });
      if (!client) startClient(); else await client.connect();
      return status();
    }
    if (act === 'retry') { if (l.role === 'remote') { if (!client) startClient(); await client.connect(); } return status(); }
    if (act === 'disconnect') {   // 停止遙控，回到這台電腦自己的資料
      if (l.role !== 'remote') return status();
      const url = client?.url() || l.lastUrl;
      if (url && l.token) fetchFn(url + '/api/link/bye', { method: 'POST', headers: { authorization: 'Bearer ' + l.token } }).catch(() => { });
      client?.stop(); client = null; lastState = null;
      save({ id: l.id, role: 'host', epoch: 0 });   // this computer starts over on its own (its own data)
      await becomeHost();
      return status();
    }
    if (act === 'switch') { await switchHere(); return status(); }
    if (act === 'switch-clear') { if (switching?.done) switching = null; return status(); }
    return status();
  }
  async function status() {
    const l = link();
    const base = { role: l.role === 'remote' ? 'remote' : 'host', id: l.id, name: myName(), switching, superseded };
    if (base.role === 'remote') {
      const st = client?.status() || lastState || { state: 'connecting' };
      return { ...base, host: { id: l.hostId, name: l.hostName, url: st.state === 'online' ? st.url : l.lastUrl || '', state: st.state, error: st.error || '', version: st.info?.version || '' }, relay: 'ntfy.sh' };
    }
    return {
      ...base, handing: handing ? { name: handing.name, at: handing.at } : null,
      invite: invite && Date.now() < invite.until ? { url: ctx.tunnel.current(), code: invite.code, linkCode: encodeLinkCode({ url: ctx.tunnel.current(), code: invite.code }), until: invite.until } : null,
      computers: (await computers()).map(({ pc, ...c }) => c),
      relay: { name: 'ntfy.sh', ok: pub.ok, error: pub.error }
    };
  }

  return {
    role, link, computerOf, remoteApi, proxy, desktop, status,
    handing: () => !!handing,
    viaName: () => (role() === 'remote' ? link().hostName || '主機電腦' : ''),
    async start() {
      const l = link();
      if (l.switching) { const r = await resumeSwitch(); if (r === 'host') { startWatch(); await keepTunnel(); await publish(true); return; } }
      if (role() === 'remote') { startClient(); return; }
      startWatch();
      keepTunnel().catch(() => { });
    },
    publish,
    stop() { clearInterval(watchTimer); client?.stop(); if (handing) { clearInterval(handing.timer); rmSync(handing.snapshot, { force: true }); handing = null; } }
  };
}
