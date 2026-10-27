// 主機模式: the account's data moves to the host computer; the cloud signs in, forwards signed requests,
// and keeps its own D1 reads to at most one per forwarded request.
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { hostHandler, hostLink, importFromCloud, sign, verifyForwarded, sha256Hex, SKEW_MS } from '../desktop/host-mode.mjs';

const apiUrl = pathToFileURL(join(import.meta.dirname, '..', 'functions', 'api', '[[path]].js')).href;
const cloudApi = await import(apiUrl);
const hostApi = await import(apiUrl + '?host');   // the host computer runs its own copy of the API (own memory)
const schema = readFileSync(join(import.meta.dirname, '..', 'schema.sql'), 'utf8');

// D1 on node:sqlite; counts the statements that read (first/all, and SELECTs inside a batch)
function openD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(schema);
  const counter = { reads: 0 };
  const norm = a => a.map(v => (v === undefined ? null : typeof v === 'boolean' ? +v : v));
  class Stmt {
    constructor(sql) { this.sql = sql; this.args = []; }
    bind(...a) { this.args = norm(a); return this; }
    async first() { counter.reads++; return db.prepare(this.sql).get(...this.args) ?? null; }
    async all() { counter.reads++; return { results: db.prepare(this.sql).all(...this.args) }; }
    _run() {
      const info = db.prepare(this.sql).run(...this.args);
      return { success: true, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
    }
    async run() { return this._run(); }
    _exec() { if (/^\s*(SELECT|WITH)/i.test(this.sql)) { counter.reads++; return { results: db.prepare(this.sql).all(...this.args), meta: {} }; } return { results: [], ...this._run() }; }
  }
  return {
    prepare: sql => new Stmt(sql),
    async batch(stmts) {
      db.exec('BEGIN');
      try { const out = stmts.map(s => s._exec()); db.exec('COMMIT'); return out; }
      catch (e) { try { db.exec('ROLLBACK'); } catch { /* closed */ } throw e; }
    },
    exec: sql => db.exec(sql),
    raw: db, counter
  };
}

let ip = 10;
const cloudEnv = db => ({ DB: db, ALLOW_SIGNUP: 'true', TZ_OFFSET_MIN: '480', isLocal: false });
async function call(db, method, path, { token, body, raw, headers: extra } = {}) {
  const headers = { 'content-type': 'application/json', 'cf-connecting-ip': `192.0.2.${ip++ % 250}`, ...extra };
  if (token) headers.authorization = 'Bearer ' + token;
  const req = new Request('http://octa.test/api/' + path, { method, headers, body: method === 'GET' ? undefined : raw ?? JSON.stringify(body || {}) });
  const res = await cloudApi.onRequest({ request: req, env: cloudEnv(db), params: { path: path.split('?')[0].split('/').filter(Boolean) } });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

// the host computer: a local database and the tunnel port's handler (the same one desktop/server.mjs uses)
async function startHost(hostDb, state) {
  const handle = hostHandler({
    onRequest: hostApi.onRequest,
    env: () => ({ DB: hostDb, TZ_OFFSET_MIN: '480', ALLOW_SIGNUP: 'false', runnerOnline: () => true }),
    enabled: () => state.enabled, key: () => state.key, expectUser: () => state.user
  });
  const srv = http.createServer(async (req, res) => {
    const c = []; for await (const x of req) c.push(x);
    try { await handle(req, res, Buffer.concat(c)); } catch (e) { res.writeHead(500); res.end(String(e)); }
  });
  await new Promise(ok => srv.listen(0, '127.0.0.1', ok));
  return { srv, url: `http://127.0.0.1:${srv.address().port}` };
}

test('signatures: the cloud signs, the host checks time, body and replays', async () => {
  const key = 'k'.repeat(64), body = '{"a":1}', ts = String(Date.now());
  const { sig, bodyHash } = await cloudApi.hostSign(key, 'u1', ts, 'POST', 'messages?x=1', body);
  assert.equal(bodyHash, sha256Hex(Buffer.from(body)));
  assert.equal(sig, sign(key, 'u1', ts, 'POST', 'messages?x=1', Buffer.from(body)));   // same as the host's own
  const headers = { 'x-octa-user': 'u1', 'x-octa-ts': ts, 'x-octa-sig': sig };
  const base = { key, headers, method: 'POST', pathQuery: 'messages?x=1', body: Buffer.from(body) };
  assert.equal(verifyForwarded(base).ok, true);
  assert.equal(verifyForwarded({ ...base, body: Buffer.from('{"a":2}') }).ok, false);   // body changed
  assert.equal(verifyForwarded({ ...base, pathQuery: 'messages?x=2' }).ok, false);
  assert.equal(verifyForwarded({ ...base, method: 'GET' }).ok, false);
  assert.equal(verifyForwarded({ ...base, key: 'x'.repeat(64) }).ok, false);
  assert.equal(verifyForwarded({ ...base, now: +ts + SKEW_MS + 1000 }).ok, false);   // too old
  assert.equal(verifyForwarded({ ...base, expectUser: 'someone-else' }).ok, false);
  const seen = new Map();
  assert.equal(verifyForwarded({ ...base, seen }).ok, true);
  assert.equal(verifyForwarded({ ...base, seen }).ok, false);   // replayed
});

test('主機模式: move the data, forward through the cloud, hooks, cron, standby, offline', async t => {
  const cloud = openD1(), hostDb = openD1();
  hostDb.raw.prepare("INSERT INTO users (id,name,pw,created) VALUES ('local','本機','-',?)").run(Date.now());
  const su = await call(cloud, 'POST', 'signup', { body: { name: 'hoster', pw: 'correcthorsebattery' } });
  const token = su.data.token;
  const uid = (await call(cloud, 'GET', 'me', { token })).data.id;
  const rt = (await call(cloud, 'POST', 'runner-token', { token, body: { label: 'desktop:pc1' } })).data.token;
  await call(cloud, 'POST', 'runner/next', { token: rt, body: { wait: false } });   // the first computer becomes the host
  const rt2 = (await call(cloud, 'POST', 'runner-token', { token, body: { label: 'desktop:pc2' } })).data.token;

  // data in the cloud before moving
  await call(cloud, 'PUT', 'settings', { token, body: { sched: 'cloud', nick: '老闆' } });
  const bot = (await call(cloud, 'POST', 'bots', { token, body: { name: '助理', task: '回答問題' } })).data.id;
  assert.ok(bot);
  await call(cloud, 'POST', 'messages', { token, body: { conv: bot, text: '你好' } });
  const job = (await call(cloud, 'POST', 'runner/next', { token: rt, body: { slots: 3, wait: false } })).data.job;
  await call(cloud, 'POST', 'runner/done', { token: rt, body: { id: job.id, ok: true, text: '你好，我是助理' } });
  await call(cloud, 'POST', 'routines', { token, body: { conv: bot, name: '巡查', times: ['*/5'], prompt: '看一下' } });
  const cloudMsgs = (await call(cloud, 'GET', 'messages?conv=' + bot, { token })).data.msgs;
  assert.ok(cloudMsgs.length >= 2);

  // a second account that stays in the cloud
  const other = (await call(cloud, 'POST', 'signup', { body: { name: 'cloudy', pw: 'correcthorsebattery' } })).data.token;
  await call(cloud, 'PUT', 'settings', { token: other, body: { sched: 'cloud' } });
  const obot = (await call(cloud, 'POST', 'bots', { token: other, body: { name: '雲端', task: '' } })).data.id;
  await call(cloud, 'POST', 'routines', { token: other, body: { conv: obot, name: '巡查', times: ['*/5'], prompt: '看一下' } });

  // only the host computer may register / export
  assert.equal((await call(cloud, 'POST', 'host/register', { token, body: { url: 'https://abc.trycloudflare.com' } })).status, 403);
  assert.equal((await call(cloud, 'POST', 'host/register', { token: rt2, body: { url: 'https://abc.trycloudflare.com' } })).status, 403);
  assert.equal((await call(cloud, 'POST', 'host/register', { token: rt, body: { url: 'http://127.0.0.1:9' } })).status, 400);
  const state = { enabled: false, key: '', user: uid };
  const host = await startHost(hostDb, state);
  t.after(() => host.srv.close());
  const viaCloud = async (url, init) => {   // what hostLink sends, answered by the cloud API
    const path = new URL(url).pathname.replace(/^\/api\//, '');
    const r = await call(cloud, init.method, path, { token: init.headers.authorization.slice(7), raw: init.body });
    return new Response(JSON.stringify(r.data), { status: r.status });
  };
  const link = hostLink({
    cloud: 'http://octa.test', fetch: viaCloud, token: () => rt, tunnel: async () => 'https://abc.trycloudflare.com',
    hooks: async () => hostDb.raw.prepare('SELECT hook FROM routines WHERE hook IS NOT NULL').all().map(r => r.hook),
    onKey: k => (state.key = k), onMode: m => (state.mode = m)
  });
  await link.start();
  assert.match(state.key, /^[0-9a-f]{64}$/);
  assert.equal(state.mode, 0);
  const firstKey = state.key;
  await link.start();   // registering again keeps the same key
  assert.equal(state.key, firstKey);
  link.stop();

  // move every table into the host's database
  const steps = [];
  const post = async (p, b) => { const r = await call(cloud, 'POST', p, { token: rt, body: b }); if (r.status !== 200) throw new Error(r.data.error); return r.data; };
  const moved = await importFromCloud({ call: post, db: hostDb, onProgress: e => steps.push(e.table) });
  assert.ok(steps.includes('messages') && steps.includes('bots') && steps.includes('settings'));
  assert.equal(moved.counts.bots, 1);
  assert.equal(moved.counts.messages, cloud.raw.prepare('SELECT COUNT(*) AS n FROM messages WHERE user_id=?').get(uid).n);
  assert.equal(hostDb.raw.prepare("SELECT COUNT(*) AS n FROM messages WHERE user_id='local'").get().n, moved.counts.messages);
  assert.deepEqual(hostDb.raw.prepare("SELECT id FROM messages ORDER BY id").all().map(r => r.id), cloudMsgs.map(m => m.id));   // ids kept
  const hostUser = hostDb.raw.prepare("SELECT name, settings FROM users WHERE id='local'").get();
  assert.equal(hostUser.name, 'hoster');
  assert.equal(JSON.parse(hostUser.settings).sched, 'pc');   // the host keeps the clock
  assert.equal(JSON.parse(hostUser.settings).nick, '老闆');
  assert.equal((await call(cloud, 'POST', 'host/export', { token: rt, body: { table: 'users' } })).status, 400);   // only the account's own tables

  // the cloud starts forwarding
  cloud.raw.prepare('UPDATE users SET hurl=? WHERE id=?').run(host.url, uid);   // the tunnel address, here on loopback
  state.enabled = true;
  assert.equal((await call(cloud, 'POST', 'host/activate', { token: rt })).data.hmode, 1);
  hostDb.raw.prepare('UPDATE bots SET name=? WHERE id=?').run('主機上的助理', bot);   // proves answers come from the host

  const st = await call(cloud, 'GET', 'state', { token });
  assert.equal(st.status, 200);
  assert.equal(st.data.bots[0].name, '主機上的助理');
  const before = cloud.raw.prepare('SELECT COUNT(*) AS n FROM messages').get().n;
  const sent = await call(cloud, 'POST', 'messages', { token, body: { conv: bot, text: '從手機傳的' } });
  assert.equal(sent.status, 200);
  const list = (await call(cloud, 'GET', 'messages?conv=' + bot, { token })).data.msgs;
  assert.equal(list.at(-1).text, '從手機傳的');
  assert.equal(cloud.raw.prepare('SELECT COUNT(*) AS n FROM messages').get().n, before);   // nothing new in the cloud
  assert.equal(hostDb.raw.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status='pending'").get().n, 1);   // the host's runner gets the work

  // D1 reads: at most one per forwarded request, none while the sign-in is cached
  for (const p of ['state', 'messages?conv=' + bot, 'busy', 'state']) {
    cloud.counter.reads = 0;
    assert.equal((await call(cloud, 'GET', p, { token })).status, 200);
    assert.ok(cloud.counter.reads <= 1, `${p}: ${cloud.counter.reads} D1 reads`);
  }
  cloud.counter.reads = 0;
  await call(cloud, 'POST', 'messages', { token, body: { conv: bot, text: '再一則' } });
  assert.equal(cloud.counter.reads, 0);

  // account pages stay in the cloud
  const dev = await call(cloud, 'GET', 'devices', { token });
  assert.equal(dev.data.hmode, true);
  assert.equal(dev.data.computers.find(c => c.host).online, true);
  assert.equal((await call(cloud, 'POST', 'host', { token, body: { id: dev.data.computers.find(c => !c.host).id } })).status, 400);   // no switching hosts now

  // other computers stand by
  const sb = await call(cloud, 'POST', 'runner/next', { token: rt2, body: { wait: false } });
  assert.equal(sb.data.standby, true);
  assert.equal(sb.data.job, null);

  // an external-event key made on the host reaches it through the cloud
  const hk = await call(cloud, 'POST', 'routines', { token, body: { conv: bot, name: '收到訂單', trigger: 'hook', prompt: '處理訂單' } });
  assert.equal(hk.status, 200);
  assert.ok(hk.data.hook);
  assert.equal(cloud.raw.prepare('SELECT COUNT(*) AS n FROM routines WHERE hook=?').get(hk.data.hook).n, 0);   // only on the host
  link.poke(); await link.start(); link.stop();   // the host tells the cloud its keys
  cloud.raw.prepare('UPDATE users SET hurl=? WHERE id=?').run(host.url, uid);   // (the test tunnel address again)
  assert.equal(cloud.raw.prepare('SELECT user_id FROM host_hooks WHERE k=?').get(hk.data.hook).user_id, uid);
  const ev = await call(cloud, 'POST', 'hook/' + hk.data.hook, { body: { order: 'A-17' } });
  assert.equal(ev.status, 200);
  assert.equal(ev.data.ok, true);
  assert.equal(ev.data.result, 'fired');
  assert.equal(hostDb.raw.prepare("SELECT COUNT(*) AS n FROM jobs WHERE prompt LIKE '%A-17%'").get().n, 1);   // the host's runner gets the event

  // the coach link (kept in the cloud) works on the host's bots
  const coach = (await call(cloud, 'POST', 'coach', { token, body: { name: '教練' } })).data.coach;
  const cg = await call(cloud, 'GET', 'coach/' + coach.key);
  assert.equal(cg.status, 200);
  assert.ok(JSON.stringify(cg.data).includes('主機上的助理'));
  assert.ok(JSON.stringify(cg.data).includes('http://octa.test/api/coach/'));   // links point at the cloud, not the tunnel

  // cron: the host keeps this account's clock; other accounts still fire in the cloud
  const cloudRoutineBefore = cloud.raw.prepare('SELECT fired FROM routines WHERE user_id=?').get(uid).fired;
  const cr = await call(cloud, 'GET', 'cron');
  assert.equal(cr.data.fired, 1);
  assert.equal(cloud.raw.prepare('SELECT fired FROM routines WHERE user_id=?').get(uid).fired, cloudRoutineBefore);

  // a bad signature is refused by the host
  const bad = await fetch(host.url + '/api/state', { headers: { 'x-octa-user': uid, 'x-octa-ts': String(Date.now()), 'x-octa-sig': 'f'.repeat(64) } });
  assert.equal(bad.status, 401);
  assert.equal(bad.headers.get('x-octa-host'), 'bad');
  const ts = String(Date.now());
  const noRunner = await fetch(host.url + '/api/runner/next', { method: 'POST', headers: { 'x-octa-user': uid, 'x-octa-ts': ts, 'x-octa-sig': sign(state.key, uid, ts, 'POST', 'runner/next', Buffer.from('{}')), 'content-type': 'application/json' }, body: '{}' });
  assert.equal(noRunner.status, 403);   // even signed, the tunnel never runs this computer's runner

  // the host computer stopped keeping the data (switched back without telling the cloud): the cloud answers itself
  state.enabled = false;
  const fallback = await call(cloud, 'GET', 'state', { token });
  assert.equal(fallback.status, 200, JSON.stringify(fallback.data));
  assert.equal(fallback.data.bots[0].name, '助理');
  state.enabled = true;

  // host off → 503 hostOffline (and no sign-out)
  await new Promise(ok => host.srv.close(ok));
  const off = await call(cloud, 'GET', 'state', { token });
  assert.equal(off.status, 503);
  assert.equal(off.data.hostOffline, true);
  assert.equal((await call(cloud, 'GET', 'me', { token })).status, 200);   // account pages still work

  // back to the cloud from a phone: the password is needed
  assert.equal((await call(cloud, 'POST', 'host/deactivate', { token, body: { pw: 'wrong' } })).status, 403);
  assert.equal((await call(cloud, 'POST', 'host/deactivate', { token, body: { pw: 'correcthorsebattery' } })).data.hmode, 0);
  const back = await call(cloud, 'GET', 'state', { token });
  assert.equal(back.status, 200);
  assert.equal(back.data.bots[0].name, '助理');   // the cloud's copy from the moment of moving
});

test('moving again into a database that already has the rows only adds new ones', async () => {
  const db = openD1();
  db.raw.prepare("INSERT INTO users (id,name,pw,created) VALUES ('local','本機','-',1)").run();
  const pages = { messages: [{ rows: [{ id: 5, user_id: 'u', conv: 'b', by_: 'me', text: 'a', ts: 1 }, { id: 9, user_id: 'u', conv: 'b', by_: 'me', text: 'b', ts: 2 }], next: null, count: 2 }] };
  const callFn = async (_p, b) => pages[b.table].shift();
  const r = await importFromCloud({ call: callFn, db, tables: ['messages'] });
  assert.equal(r.lastMessage, 9);
  pages.messages = [{ rows: [{ id: 9, user_id: 'u', conv: 'b', by_: 'me', text: 'changed', ts: 2 }, { id: 11, user_id: 'u', conv: 'b', by_: 'x', text: 'c', ts: 3 }], next: null }];
  await importFromCloud({ call: callFn, db, tables: ['messages'], start: { messages: 9 }, insert: 'ignore', verify: false });
  assert.deepEqual(db.raw.prepare('SELECT id, text, user_id FROM messages ORDER BY id').all().map(x => ({ ...x })), [
    { id: 5, text: 'a', user_id: 'local' }, { id: 9, text: 'b', user_id: 'local' }, { id: 11, text: 'c', user_id: 'local' }]);
  // a short page is caught before anything is used
  pages.messages = [{ rows: [{ id: 1, user_id: 'u', conv: 'b', by_: 'me', text: 'a', ts: 1 }], next: null, count: 3 }];
  const fresh = openD1();
  fresh.raw.prepare("INSERT INTO users (id,name,pw,created) VALUES ('local','本機','-',1)").run();
  await assert.rejects(importFromCloud({ call: callFn, db: fresh, tables: ['messages'] }), /只搬到/);
});

test('the page backs off while the host is off and knows which paths the cloud answers itself', () => {
  const page = readFileSync(join(import.meta.dirname, '..', 'public', 'index.html'), 'utf8');
  const api = readFileSync(join(import.meta.dirname, '..', 'functions', 'api', '[[path]].js'), 'utf8');
  assert.match(page, /id="hostOff"[^>]*role="status"/);
  assert.match(page, /HOFF_STEPS=\[5000,10000,30000,60000\]/);
  const pageRe = new RegExp(page.match(/const CLOUD_ONLY=\/(.+?)\/;/)[1]);
  const apiRe = new RegExp(api.match(/const CLOUD_ONLY = \/(.+?)\/;/)[1]);
  for (const p of ['login', 'logout', 'me', 'devices', 'devices/remove', 'password', 'reset-code', 'host/deactivate', 'coach', 'runner-token', 'state', 'messages', 'wait', 'settings', 'bots', 'files'])
    assert.equal(pageRe.test(p), apiRe.test(p), p);
  assert.equal(pageRe.test('messages?conv=x'), false);
  assert.equal(pageRe.test('me?x=1'), true);
});
