// 主機模式 with the real desktop server (desktop/server.mjs on sql.js): move from the cloud API, answer signed
// requests the cloud forwards. Needs the desktop app's packages (cd desktop && npm install); skipped without them.
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
const repo = join(import.meta.dirname, '..');
let hasDeps = true;
try { createRequire(join(repo, 'desktop', 'package.json')).resolve('sql.js'); } catch { hasDeps = false; }

test('desktop server: move the data in, then answer through the cloud', { skip: !hasDeps && 'desktop packages not installed' }, async () => {
  const cloudApi = await import(pathToFileURL(join(repo, 'functions/api/[[path]].js')).href + '?cloud');
  const { startServer } = await import(pathToFileURL(join(repo, 'desktop/server.mjs')).href);
  const schema = readFileSync(join(repo, 'schema.sql'), 'utf8');
  function openD1() {
    const db = new DatabaseSync(':memory:'); db.exec(schema);
    const norm = a => a.map(v => (v === undefined ? null : typeof v === 'boolean' ? +v : v));
    class Stmt { constructor(sql) { this.sql = sql; this.args = []; } bind(...a) { this.args = norm(a); return this; }
      async first() { return db.prepare(this.sql).get(...this.args) ?? null; } async all() { return { results: db.prepare(this.sql).all(...this.args) }; }
      _run() { const i = db.prepare(this.sql).run(...this.args); return { success: true, meta: { changes: Number(i.changes), last_row_id: Number(i.lastInsertRowid) } }; }
      async run() { return this._run(); } _exec() { return /^\s*(SELECT|WITH)/i.test(this.sql) ? { results: db.prepare(this.sql).all(...this.args) } : { results: [], ...this._run() }; } }
    return { prepare: s => new Stmt(s), async batch(st) { db.exec('BEGIN'); try { const o = st.map(s => s._exec()); db.exec('COMMIT'); return o; } catch (e) { db.exec('ROLLBACK'); throw e; } }, exec: s => db.exec(s), raw: db };
  }
  const cloud = openD1();
  async function call(method, path, { token, body } = {}) {
    const headers = { 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.' + Math.floor(Math.random() * 200) };
    if (token) headers.authorization = 'Bearer ' + token;
    const req = new Request('http://octa.test/api/' + path, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(body || {}) });
    const res = await cloudApi.onRequest({ request: req, env: { DB: cloud, ALLOW_SIGNUP: 'true', TZ_OFFSET_MIN: '480', isLocal: false }, params: { path: path.split('?')[0].split('/').filter(Boolean) } });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  }
  const token = (await call('POST', 'signup', { body: { name: 'smoke', pw: 'correcthorsebattery' } })).data.token;
  const uid = (await call('GET', 'me', { token })).data.id;
  const rt = (await call('POST', 'runner-token', { token, body: { label: 'desktop:pc' } })).data.token;
  await call('POST', 'runner/next', { token: rt, body: { wait: false } });
  const bot = (await call('POST', 'bots', { token, body: { name: '助理', task: '' } })).data.id;
  for (let i = 0; i < 1203; i++) cloud.raw.prepare("INSERT INTO messages (user_id,conv,by_,text,ts) VALUES (?,?,'me',?,?)").run(uid, bot, 'm' + i, Date.now());   // more than two pages
  await call('POST', 'host/register', { token: rt, body: { url: 'https://x.trycloudflare.com' } });
  const hkey = cloud.raw.prepare('SELECT hkey FROM users WHERE id=?').get(uid).hkey;

  const cfg = { mode: 'cloud' };
  const dataDir = mkdtempSync(join(tmpdir(), 'octa-smoke-'));
  const s = await startServer({ dataDir, runner: false, host: { enabled: () => cfg.mode === 'host', key: () => hkey, user: () => uid, name: () => 'smoke' } });
  const post = async (p, b) => { const r = await call('POST', p, { token: rt, body: b }); if (r.status !== 200) throw new Error(r.data.error); return r.data; };
  const progress = [];
  const res = await s.hostImport({ call: post, onProgress: e => progress.push(e.label + ' ' + e.got) });
  assert.ok(res.counts.messages >= 1203);
  assert.ok(readdirSync(dataDir).some(f => f.startsWith('ebot.backup-')));
  cfg.mode = 'host';
  cloud.raw.prepare('UPDATE users SET hurl=? WHERE id=?').run(s.remoteUrl, uid);
  await post('host/activate');
  const cfgRes = await (await fetch(s.url + '/api/config')).json();
  assert.deepEqual(cfgRes.host, { name: 'smoke' });
  const st = await call('GET', 'state', { token });
  assert.equal(st.status, 200, JSON.stringify(st.data));
  assert.equal(st.data.me, 'smoke');
  assert.equal(st.data.bots[0].name, '助理');
  const sent = await call('POST', 'messages', { token, body: { conv: bot, text: '轉送測試' } });
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  const local = await (await fetch(s.url + '/api/messages?conv=' + bot)).json();
  assert.equal(local.msgs.at(-1).text, '轉送測試');
  const bad = await fetch(s.remoteUrl + '/api/state', { headers: { 'x-octa-user': uid, 'x-octa-ts': String(Date.now()), 'x-octa-sig': '0'.repeat(64) } });
  assert.equal(bad.status, 401);
  const ping = await fetch(s.remoteUrl + '/__octa_ping');
  assert.equal(ping.status, 200);
  cfg.mode = 'cloud';
  const fb = await call('GET', 'state', { token });
  assert.equal(fb.status, 200);   // host says it is not the host → the cloud answers
  await s.close();
  assert.ok(progress.length >= 12);
  rmSync(dataDir, { recursive: true, force: true });
});
