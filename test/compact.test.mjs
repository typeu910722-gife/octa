// 一鍵壓縮對話 (2026-11-01)
// 主機斷線與排程 (2026-10-30 回報): a restarted host continues cut-off jobs, halfway work is sent before continuing,
// routine runs don't make routines, the same routine isn't made twice, and the runner can't wait forever.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const apiUrl = pathToFileURL(join(import.meta.dirname, '..', 'functions', 'api', '[[path]].js')).href;
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
    _run() { const info = db.prepare(this.sql).run(...this.args); return { success: true, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } }; }
    async run() { return this._run(); }
    _exec() { return /^\s*(SELECT|WITH)/i.test(this.sql) ? { results: db.prepare(this.sql).all(...this.args), meta: {} } : { results: [], ...this._run() }; }
  }
  return {
    prepare: sql => new Stmt(sql),
    async batch(stmts) {
      db.exec('BEGIN');
      try { const out = stmts.map(s => s._exec()); db.exec('COMMIT'); return out; } catch (e) { try { db.exec('ROLLBACK'); } catch { } throw e; }
    },
    exec: sql => db.exec(sql),
    raw: db
  };
}
let ip = 40;
async function call(db, method, path, { token, body, query } = {}) {
  const headers = { 'content-type': 'application/json', 'cf-connecting-ip': `203.0.113.${ip++}` };
  if (token) headers.authorization = 'Bearer ' + token;
  const url = new URL('http://octa.test/api/' + path);
  for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);
  const res = await onRequest({
    request: new Request(url, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(body || {}) }),
    env: { DB: db, ALLOW_SIGNUP: 'true', TZ_OFFSET_MIN: '480', isLocal: false },
    params: { path: path.split('/').filter(Boolean) }
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
const { onRequest } = await import(apiUrl);

test('one press compacts a chat: the bot writes memory and progress, then the old messages go', async () => {
  const db = openD1();
  const token = (await call(db, 'POST', 'signup', { body: { name: 'cmp1', pw: 'correcthorsebattery' } })).data.token;
  const bot = (await call(db, 'POST', 'bots', { token, body: { name: '小幫手', task: '查網站' } })).data.id;
  const rt = (await call(db, 'POST', 'runner-token', { token, body: { label: 'cmp-host' } })).data.token;
  const uid = db.raw.prepare('SELECT user_id FROM bots WHERE id=?').get(bot).user_id;
  assert.equal((await call(db, 'POST', 'compact', { token, body: { conv: bot } })).status, 400, 'a short chat is not compacted');
  for (let i = 0; i < 8; i++) db.raw.prepare('INSERT INTO messages (user_id,conv,by_,text,ts) VALUES (?,?,?,?,?)').run(uid, bot, i % 2 ? bot : 'me', '舊訊息 ' + i, Date.now());
  const r = await call(db, 'POST', 'compact', { token, body: { conv: bot } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await call(db, 'POST', 'compact', { token, body: { conv: bot } })).status, 409, 'not twice while it works');
  const job = (await call(db, 'POST', 'runner/next', { token: rt, body: { slots: 1, wait: false } })).data.job;
  assert.match(job.prompt, /^（壓縮對話）/);
  await call(db, 'POST', 'runner/done', { token: rt, body: { id: job.id, ok: true, text: '📌記住：補助週六不算\n目前進度：今天的入住名單做到一半，下次從 3 號房接著做。' } });
  const msgs = db.raw.prepare('SELECT by_,text FROM messages WHERE conv=? ORDER BY id').all(bot);
  assert.equal(msgs.some(m => m.text.startsWith('舊訊息')), false, 'old messages are gone');
  assert.ok(msgs.some(m => m.by_ === bot && /目前進度/.test(m.text)), 'the progress summary stays');
  assert.ok(msgs.some(m => /^🗜 已壓縮：刪掉 \d+ 則/.test(m.text)), msgs.map(m => m.text).join('\n'));
  const st = JSON.parse(db.raw.prepare('SELECT settings FROM users WHERE id=?').get(uid).settings || '{}');
  assert.deepEqual(st.memory?.[bot], ['補助週六不算'], 'the rule went into memory');
});
