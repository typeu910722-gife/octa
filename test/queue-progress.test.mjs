// 4.15.2 取消排隊 (one queued job, the running one goes on) and 進度 without a 🧭步驟 plan (what it finished, how many
// actions, when it last moved) — in the 工作 panel, the overview cards and the chat header.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { fnSrc, scripts } from './app-source.mjs';

const { onRequest } = await import(pathToFileURL(join(import.meta.dirname, '..', 'desktop', 'api', 'index.mjs')).href);
const schema = readFileSync(join(import.meta.dirname, '..', 'schema.sql'), 'utf8');
function openD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(schema);
  const norm = a => a.map(v => (v === undefined ? null : typeof v === 'boolean' ? +v : v));
  class Stmt {
    constructor(sql) { this.sql = sql; this.args = []; }
    bind(...a) { this.args = norm(a); return this; }
    async first() { return db.prepare(this.sql).get(...this.args) ?? null; }
    async all() { return { results: db.prepare(this.sql).all(...this.args) }; }
    _run() {
      const info = db.prepare(this.sql).run(...this.args);
      return { success: true, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
    }
    async run() { return this._run(); }
    _exec() { return /^\s*(SELECT|WITH)/i.test(this.sql) ? { results: db.prepare(this.sql).all(...this.args), meta: {} } : { results: [], ...this._run() }; }
  }
  return {
    prepare: sql => new Stmt(sql),
    async batch(stmts) {
      db.exec('BEGIN');
      try { const out = stmts.map(s => s._exec()); db.exec('COMMIT'); return out; }
      catch (e) { try { db.exec('ROLLBACK'); } catch { /* closed */ } throw e; }
    },
    exec: sql => db.exec(sql),
    raw: db
  };
}

let ip = 40, n = 0;
// 4.0: one local user and no accounts. The old sign-up / runner-key steps only make sure that user exists.
async function localLogin(db) {
  await db.prepare("INSERT OR IGNORE INTO users (id,name,pw,created) VALUES ('local','本機','-',?)").bind(Date.now()).run();
  return { status: 200, data: { token: 'local' } };
}
async function call(db, method, path, { token, body, query } = {}) {
  if (path === 'signup' || path === 'runner-token') return localLogin(db);
  const headers = { 'content-type': 'application/json', 'cf-connecting-ip': `198.51.100.${ip++ % 250}` };
  if (token) headers.authorization = 'Bearer ' + token;
  const url = new URL('http://octa.test/api/' + path);
  for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);
  const req = new Request(url, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(body || {}) });
  const res = await onRequest({ request: req, env: { DB: db, TZ_OFFSET_MIN: '480', isLocal: true }, params: { path: path.split('/').filter(Boolean) } });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

const P = await import(pathToFileURL(join(import.meta.dirname, '..', 'desktop', 'api', 'progress.mjs')).href);

test('withTrail: each new action moves the last one into the trail, counts it, keeps when it started', () => {
  let raw = null;
  for (const [i, text] of ['打開後台', '打開後台', '找今天的訂單', '整理名單'].entries()) raw = JSON.stringify(P.withTrail(raw, P.progressOf({ text }), 1000 + i));
  const o = JSON.parse(raw);
  assert.equal(o.text, '整理名單');
  assert.deepEqual(o.trail.map(x => x.t), ['打開後台', '找今天的訂單']);
  assert.equal(o.n, 3, 'the same report again is not a new action');
  assert.equal(o.t0, 1000);
  assert.ok(P.sameProgress(raw, P.progressOf({ text: '整理名單' })), 'a heartbeat changes nothing');
  let many = null;
  for (let i = 0; i < 30; i++) many = JSON.stringify(P.withTrail(many, P.progressOf({ text: 'a' + i }), i));
  assert.equal(JSON.parse(many).trail.length, P.TRAIL_MAX);
});

test('取消排隊: one queued job leaves, the running one and the others stay; the overview lists each queued job', async () => {
  const db = openD1();
  const token = (await call(db, 'POST', 'signup')).data.token;
  const bot = (await call(db, 'POST', 'bots', { token, body: { name: '小美', task: '' } })).data.id;
  const ins = (status, prompt) => Number(db.raw.prepare(`INSERT INTO jobs (user_id,conv,bot_id,chain,prompt,created,status,kind) VALUES ('local',?,?,'[]',?,?,?,'chat')`).run(bot, bot, prompt, Date.now(), status).lastInsertRowid);
  const run = ins('running', '整理訂單'), q1 = ins('pending', '寫週報'), q2 = ins('pending', '回客人訊息');
  const ov = (await call(db, 'GET', 'overview', { token })).data.bots.find(b => b.id === bot);
  assert.equal(ov.queued, 2);
  assert.deepEqual(ov.queue.map(q => [q.id, q.what]), [[q1, '寫週報'], [q2, '回客人訊息']]);
  assert.equal((await call(db, 'POST', `job/${q1}/cancel`, { token })).status, 200);
  const left = db.raw.prepare('SELECT id,status FROM jobs ORDER BY id').all().map(r => [r.id, r.status]);
  assert.deepEqual(left, [[run, 'running'], [q2, 'pending']]);
  assert.equal((await call(db, 'POST', `job/${run}/cancel`, { token })).status, 404, 'a running job is stopped with 停止, not here');
  const msgs = (await call(db, 'GET', 'messages', { token, query: { conv: bot } })).data.msgs;
  assert.ok(msgs.some(m => m.by === 'sys' && m.text === '已取消排隊中的工作：寫週報'));
});

test('the app: a 取消排隊 button on every queued job, the trail and the count when there is no plan, the header shows the action', () => {
  assert.match(fnSrc('queueHtml'), /data-qcancel="\$\{x\.job\}"/);
  assert.doesNotMatch(fnSrc('queueHtml'), /data-wstop/, 'cancelling a queued job never stops the running one');
  assert.match(fnSrc('jobUnqueue'), /api\('job\/'\+id\+'\/cancel','POST'/);
  assert.match(fnSrc('curCard'), /v\.trail\.slice\(-6\)/);
  assert.match(fnSrc('ovStepHtml'), /p\.trail\.slice\(-3\)/);
  assert.match(scripts['overview.js'], /data-ovqc="\$\{q\.id\}"/);
  assert.match(fnSrc('psubHtml'), /class="pnow"/);
  const pure = new Function(scripts['pure.js'] + '\nreturn { progView };')();
  const v = pure.progView({ text: '整理名單', trail: [{ t: '打開後台', at: 1 }], n: 2, at: 5 });
  assert.equal(v.cur, '整理名單'); assert.equal(v.n, 2); assert.deepEqual(v.trail, [{ t: '打開後台', at: 1 }]); assert.equal(v.has, false);
});
