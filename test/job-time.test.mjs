// 主動性: autonomy levels, plan-first prompt rules, default 24-hour standby, the 幕後 log, and group collaboration paths.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';


const apiUrl = pathToFileURL(join(import.meta.dirname, '..', 'functions', 'api', '[[path]].js')).href;
const { onRequest, mentionAsks } = await import(apiUrl);
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
async function call(db, method, path, { token, body, query } = {}) {
  const headers = { 'content-type': 'application/json', 'cf-connecting-ip': `198.51.100.${ip++ % 250}` };
  if (token) headers.authorization = 'Bearer ' + token;
  const url = new URL('http://octa.test/api/' + path);
  for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);
  const req = new Request(url, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(body || {}) });
  const res = await onRequest({ request: req, env: { DB: db, ALLOW_SIGNUP: 'true', TZ_OFFSET_MIN: '480', isLocal: false }, params: { path: path.split('/').filter(Boolean) } });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
async function setup() {
  const db = openD1();
  const su = await call(db, 'POST', 'signup', { body: { name: 'pro' + n++, pw: 'correcthorsebattery' } });
  const token = su.data.token;
  const rt = (await call(db, 'POST', 'runner-token', { token, body: { label: 'host' } })).data.token;
  // names with spaces can't be made any more; such a name stands for a bot from an older version
  const bot = async (name, task = '', extra = {}) => {
    const id = (await call(db, 'POST', 'bots', { token, body: { name: name.replace(/\s/g, '') + '_tmp', task, ...extra } })).data.id;
    db.raw.prepare('UPDATE bots SET name=? WHERE id=?').run(name, id);
    return id;
  };
  const group = async (name, members, task = '') => (await call(db, 'POST', 'groups', { token, body: { name, task, members } })).data.id;
  const say = (conv, text) => call(db, 'POST', 'messages', { token, body: { conv, text } });
  const next = async () => (await call(db, 'POST', 'runner/next', { token: rt, body: { slots: 3, wait: false } })).data.job;
  const done = (id, text, ok = true) => call(db, 'POST', 'runner/done', { token: rt, body: { id, ok, text } });
  const msgs = async conv => (await call(db, 'GET', 'messages', { token, query: { conv } })).data.msgs;
  const pending = () => db.raw.prepare("SELECT * FROM jobs WHERE status IN ('pending','running') ORDER BY id").all();
  return { db, token, rt, bot, group, say, next, done, msgs, pending };
}

// 單件工作最長時間: a long job that keeps sending heartbeats is not cut at 20 minutes; a silent one is
test('a job that keeps reporting runs past 20 minutes; a silent one is stopped; the limit is a setting', async () => {
  const t = await setup();
  const a = await t.bot('長工');
  assert.equal((await call(t.db, 'GET', 'settings', { token: t.token })).data.jobMax, 60);
  await t.say(a, '讀兩館所有 LINE 對話');
  const j = await t.next();
  assert.equal(j.maxMin, 60);
  const ago = Date.now() - 30 * 60000;
  t.db.raw.prepare('UPDATE jobs SET started=? WHERE id=?').run(ago, j.id);
  await call(t.db, 'POST', 'runner/progress', { token: t.rt, body: { id: j.id, text: '讀取網頁內容' } });   // heartbeat now
  await t.next();
  assert.equal(t.db.raw.prepare('SELECT status FROM jobs WHERE id=?').get(j.id).status, 'running', 'still reporting: not stopped');
  t.db.raw.prepare('UPDATE jobs SET beat=? WHERE id=?').run(Date.now() - 21 * 60000, j.id);   // then silent for 21 minutes
  await t.next();
  const row = t.db.raw.prepare('SELECT status, err_msg FROM jobs WHERE id=?').get(j.id);
  assert.equal(row.status, 'error');
  assert.match(row.err_msg, /20 分鐘沒有任何回報/);
  await call(t.db, 'PUT', 'settings', { token: t.token, body: { jobMax: 120 } });
  assert.equal((await call(t.db, 'GET', 'settings', { token: t.token })).data.jobMax, 120);
  await call(t.db, 'PUT', 'settings', { token: t.token, body: { jobMax: 7 } });
  assert.equal((await call(t.db, 'GET', 'settings', { token: t.token })).data.jobMax, 120, 'only the offered choices');
});
