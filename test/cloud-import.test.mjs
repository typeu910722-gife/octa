// 4.0: a 3.x cloud user's data moves to the desktop once, through the frozen legacy cloud API's host/export.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { cloudCaller, importFromCloud, importStatus, migrateConfig, MOVE_TABLES } from '../desktop/cloud-import.mjs';

const repo = join(import.meta.dirname, '..');
const cloudApi = await import(pathToFileURL(join(repo, 'functions', 'api', '[[path]].js')).href);
const schema = readFileSync(join(repo, 'schema.sql'), 'utf8');

function openD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(schema);
  const norm = a => a.map(v => (v === undefined ? null : typeof v === 'boolean' ? +v : v));
  class Stmt {
    constructor(sql) { this.sql = sql; this.args = []; }
    bind(...a) { this.args = norm(a); return this; }
    async first() { return db.prepare(this.sql).get(...this.args) ?? null; }
    async all() { return { results: db.prepare(this.sql).all(...this.args) }; }
    _run() { const i = db.prepare(this.sql).run(...this.args); return { success: true, meta: { changes: Number(i.changes), last_row_id: Number(i.lastInsertRowid) } }; }
    async run() { return this._run(); }
    _exec() { return /^\s*(SELECT|WITH)/i.test(this.sql) ? { results: db.prepare(this.sql).all(...this.args), meta: {} } : { results: [], ...this._run() }; }
  }
  return {
    prepare: sql => new Stmt(sql),
    async batch(stmts) { db.exec('BEGIN'); try { const o = stmts.map(s => s._exec()); db.exec('COMMIT'); return o; } catch (e) { db.exec('ROLLBACK'); throw e; } },
    exec: sql => db.exec(sql), raw: db
  };
}
let ip = 10;
async function call(db, method, path, { token, body } = {}) {
  const headers = { 'content-type': 'application/json', 'cf-connecting-ip': `192.0.2.${ip++ % 250}` };
  if (token) headers.authorization = 'Bearer ' + token;
  const req = new Request('http://octa.test/api/' + path, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(body || {}) });
  const res = await cloudApi.onRequest({ request: req, env: { DB: db, ALLOW_SIGNUP: 'true', TZ_OFFSET_MIN: '480', isLocal: false }, params: { path: path.split('?')[0].split('/').filter(Boolean) } });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

test('legacy cloud: any of the account\'s computers exports everything, ids kept, settings and name too', async () => {
  const cloud = openD1(), local = openD1();
  local.raw.prepare("INSERT INTO users (id,name,pw,created) VALUES ('local','本機','-',?)").run(Date.now());
  const token = (await call(cloud, 'POST', 'signup', { body: { name: 'mover', pw: 'correcthorsebattery' } })).data.token;
  const uid = (await call(cloud, 'GET', 'me', { token })).data.id;
  const rt1 = (await call(cloud, 'POST', 'runner-token', { token, body: { label: 'desktop:pc1' } })).data.token;
  await call(cloud, 'POST', 'runner/next', { token: rt1, body: { wait: false } });   // pc1 becomes the 3.x "host"
  const rt2 = (await call(cloud, 'POST', 'runner-token', { token, body: { label: 'desktop:pc2' } })).data.token;
  await call(cloud, 'PUT', 'settings', { token, body: { sched: 'cloud', nick: '老闆' } });
  const bot = (await call(cloud, 'POST', 'bots', { token, body: { name: '助理', task: '回答問題' } })).data.id;
  await call(cloud, 'POST', 'messages', { token, body: { conv: bot, text: '你好' } });
  await call(cloud, 'POST', 'routines', { token, body: { conv: bot, name: '巡查', times: ['*/5'], prompt: '看一下' } });
  const cloudMsgs = (await call(cloud, 'GET', 'messages?conv=' + bot, { token })).data.msgs;
  // another account's data never comes along
  const other = (await call(cloud, 'POST', 'signup', { body: { name: 'someone', pw: 'correcthorsebattery' } })).data.token;
  await call(cloud, 'POST', 'bots', { token: other, body: { name: '別人的', task: '' } });

  // a signed-in browser session cannot export; only a desktop computer's runner key
  assert.equal((await call(cloud, 'POST', 'host/export', { token, body: { table: 'bots' } })).status, 403);
  // pc2 was never the 主機 and still may export (4.0 moves the data to whichever computer starts first)…
  const post = async (p, b) => { const r = await call(cloud, 'POST', p, { token: rt2, body: b }); if (r.status !== 200) throw new Error(r.data.error); return r.data; };
  // …but register (the old 主機模式) stays for the host computer only
  assert.equal((await call(cloud, 'POST', 'host/register', { token: rt2, body: { url: 'https://abc.trycloudflare.com' } })).status, 403);
  assert.equal((await call(cloud, 'POST', 'host/export', { token: rt2, body: { table: 'users' } })).status, 400);   // only the account's own tables

  const steps = [];
  const moved = await importFromCloud({ call: post, db: local, onProgress: e => steps.push(e.table) });
  assert.deepEqual([...new Set(steps)], MOVE_TABLES);
  assert.equal(moved.counts.bots, 1);
  assert.equal(moved.counts.routines, cloud.raw.prepare('SELECT COUNT(*) AS n FROM routines WHERE user_id=?').get(uid).n);
  assert.ok(moved.counts.routines >= 1);
  assert.equal(moved.counts.messages, cloud.raw.prepare('SELECT COUNT(*) AS n FROM messages WHERE user_id=?').get(uid).n);
  assert.deepEqual(local.raw.prepare('SELECT id FROM messages ORDER BY id').all().map(r => r.id), cloudMsgs.map(m => m.id));
  assert.equal(local.raw.prepare("SELECT COUNT(*) AS n FROM bots WHERE user_id='local'").get().n, 1);
  assert.equal(local.raw.prepare("SELECT COUNT(*) AS n FROM bots WHERE user_id!='local'").get().n, 0);
  const me = local.raw.prepare("SELECT name, settings FROM users WHERE id='local'").get();
  assert.equal(me.name, 'mover');
  assert.equal(JSON.parse(me.settings).nick, '老闆');
  assert.equal(JSON.parse(me.settings).sched, 'pc');
});

test('importing again only adds what is new; a short page is refused', async () => {
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
  pages.messages = [{ rows: [{ id: 1, user_id: 'u', conv: 'b', by_: 'me', text: 'a', ts: 1 }], next: null, count: 3 }];
  const fresh = openD1();
  fresh.raw.prepare("INSERT INTO users (id,name,pw,created) VALUES ('local','本機','-',1)").run();
  await assert.rejects(importFromCloud({ call: callFn, db: fresh, tables: ['messages'] }), /只搬到/);
});

test('3.x desktop.json becomes local; only a cloud account with a key has something to import', () => {
  const cloud = migrateConfig({ mode: 'cloud', runnerToken: 'rt-1', runnerUser: 'u1', store: 'D:\\OCTA', win: { x: 1 } });
  assert.equal(cloud.pending, 'rt-1');
  assert.deepEqual(cloud.cfg, { mode: 'local', store: 'D:\\OCTA', win: { x: 1 }, cloudImport: { token: 'rt-1', state: 'pending', at: 0 } });
  const host = migrateConfig({ mode: 'host', runnerToken: 'rt-2', hostKey: 'k', hostUser: { id: 'u' }, hostMoved: 5 });
  assert.equal(host.pending, '');   // 主機模式: the data is already here
  assert.deepEqual(host.cfg, { mode: 'local' });
  assert.deepEqual(migrateConfig({}).cfg, { mode: 'local' });   // a 3.x install that never signed in
  assert.deepEqual(migrateConfig({ mode: 'cloud' }), { cfg: { mode: 'local' }, pending: '' });
  // a failed import keeps its key for a retry from settings; a finished one has nothing left
  const failed = migrateConfig({ mode: 'local', cloudImport: { token: 'rt-1', state: 'failed', error: 'x' } });
  assert.equal(failed.pending, 'rt-1');
  assert.equal(migrateConfig({ mode: 'local', cloudImport: { state: 'done', at: 3 } }).pending, '');
  // the page sees the state, never the key
  assert.deepEqual(importStatus({ token: 'rt-1', state: 'failed', at: 7, error: '逾時' }), { state: 'failed', at: 7, error: '逾時', counts: null, backup: '' });
  assert.equal(importStatus(null).state, 'none');
  assert.equal(importStatus({ token: 't', state: 'failed' }, true).state, 'running');
});

test('cloudCaller posts with the old runner key and explains a refused key', async () => {
  const seen = [];
  const fake = async (url, init) => {
    seen.push({ url, auth: init.headers.authorization, body: JSON.parse(init.body) });
    return url.endsWith('/host/export') ? new Response('{"rows":[],"next":null}', { status: 200 }) : new Response('{"error":"請先登入"}', { status: 401 });
  };
  const c = cloudCaller('rt-9', { cloud: 'https://old.example', fetch: fake });
  assert.deepEqual(await c('host/export', { table: 'bots', after: 0 }), { rows: [], next: null });
  assert.deepEqual(seen[0], { url: 'https://old.example/api/host/export', auth: 'Bearer rt-9', body: { table: 'bots', after: 0 } });
  await assert.rejects(c('runner/hello'), e => e.status === 401 && /不認得這台電腦/.test(e.message));
});
