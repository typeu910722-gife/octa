// 4.15.3 同時工作的機器人: 3 / 5 / 8 / 12 / 不限制 in Settings; the runner follows at once, and beyond 3 it starts a
// new bot only while the computer has memory to spare.
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

const ST = await import(pathToFileURL(join(import.meta.dirname, '..', 'desktop', 'runner', 'state.mjs')).href);

test('the setting is kept with the account, the runner is told at once, 不限制 is 99', async () => {
  const db = openD1();
  const token = (await call(db, 'POST', 'signup')).data.token;
  assert.equal((await call(db, 'GET', 'state', { token })).data.par, 3, '3 unless you pick another');
  let r = await call(db, 'POST', 'runner/next', { token, body: { slots: 3, max: 3, wait: false } });
  assert.equal(r.data.par, 3);
  assert.equal((await call(db, 'PUT', 'settings', { token, body: { par: 0 } })).status, 200);
  assert.equal((await call(db, 'GET', 'state', { token })).data.par, 0);
  r = await call(db, 'POST', 'runner/next', { token, body: { slots: 3, max: 3, wait: true } });
  assert.deepEqual(r.data, { job: null, par: 99, keep: [] }, 'a runner on the old number gets the new one without waiting');
  await call(db, 'PUT', 'settings', { token, body: { par: 8 } });
  assert.equal((await call(db, 'POST', 'runner/next', { token, body: { slots: 99, max: 99, wait: false } })).data.par, 8);
  await call(db, 'PUT', 'settings', { token, body: { par: 7 } });
  assert.equal((await call(db, 'GET', 'state', { token })).data.par, 8, 'only the offered choices');
});

test('the runner: changeable while running, 1…99; beyond 3 it keeps memory free; the Settings select', () => {
  assert.equal(ST.setMax(99), 99); assert.equal(ST.setMax(500), 99); assert.equal(ST.setMax(0), 3); assert.equal(ST.setMax(5), 5);
  assert.equal(ST.MAX, 5, 'the live binding the loop reads');
  ST.setMax(3);
  const loop = readFileSync(join(import.meta.dirname, '..', 'desktop', 'runner', 'loop.mjs'), 'utf8');
  assert.match(loop, /const slots = MAX > 3 && active >= 3 && freemem\(\) < LOW_FREE \? 0 : Math\.max\(0, MAX - active\);/);
  assert.match(loop, /if \(r\.par && \+r\.par !== MAX\)/);
  assert.match(scripts['ai.js'], /api\('settings','PUT',\{par:\+e\.target\.value\}\)/);
  assert.match(scripts['ai.js'], /\[3,5,8,12,0\]/);
});
