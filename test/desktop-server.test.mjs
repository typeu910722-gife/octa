// The real desktop server (desktop/server.mjs on sql.js), 4.0: always local. A 3.x cloud account's data is imported
// from a fake old cloud over HTTP; phones pair over the tunnel; external events reach /api/hook/* without pairing.
// Needs the desktop app's packages (cd desktop && npm ci --ignore-scripts); skipped without them.
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, mkdtempSync, readdirSync, rmSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
const repo = join(import.meta.dirname, '..');
let hasDeps = true;
try { createRequire(join(repo, 'desktop', 'package.json')).resolve('sql.js'); } catch { hasDeps = false; }

function openD1(schema) {
  const db = new DatabaseSync(':memory:'); db.exec(schema);
  const norm = a => a.map(v => (v === undefined ? null : typeof v === 'boolean' ? +v : v));
  class Stmt { constructor(sql) { this.sql = sql; this.args = []; } bind(...a) { this.args = norm(a); return this; }
    async first() { return db.prepare(this.sql).get(...this.args) ?? null; } async all() { return { results: db.prepare(this.sql).all(...this.args) }; }
    _run() { const i = db.prepare(this.sql).run(...this.args); return { success: true, meta: { changes: Number(i.changes), last_row_id: Number(i.lastInsertRowid) } }; }
    async run() { return this._run(); } _exec() { return /^\s*(SELECT|WITH)/i.test(this.sql) ? { results: db.prepare(this.sql).all(...this.args) } : { results: [], ...this._run() }; } }
  return { prepare: s => new Stmt(s), async batch(st) { db.exec('BEGIN'); try { const o = st.map(s => s._exec()); db.exec('COMMIT'); return o; } catch (e) { db.exec('ROLLBACK'); throw e; } }, exec: s => db.exec(s), raw: db };
}
const jpost = (url, body, headers = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body || {}) });

test('desktop server: import a 3.x cloud account, pair a phone, take external events', { skip: !hasDeps && 'desktop packages not installed' }, async t => {
  // the frozen legacy cloud, served over real HTTP like octa.yzprojecttw.com
  const cloudApi = await import(pathToFileURL(join(repo, 'functions/api/[[path]].js')).href + '?legacy');
  const cloud = openD1(readFileSync(join(repo, 'schema.sql'), 'utf8'));
  const env = { DB: cloud, ALLOW_SIGNUP: 'true', TZ_OFFSET_MIN: '480', isLocal: false };
  let n = 0;
  const legacy = http.createServer(async (req, res) => {
    const c = []; for await (const x of req) c.push(x);
    const headers = { ...req.headers, 'cf-connecting-ip': '192.0.2.' + (n++ % 200) };
    const request = new Request('http://octa.test' + req.url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(c) });
    const r = await cloudApi.onRequest({ request, env, params: { path: req.url.replace(/^\/api\//, '').split('?')[0].split('/').filter(Boolean) } });
    res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
  });
  await new Promise(ok => legacy.listen(0, '127.0.0.1', ok));
  t.after(() => legacy.close());
  const CLOUD = `http://127.0.0.1:${legacy.address().port}`;
  const call = async (method, path, token, body) => {
    const r = await fetch(CLOUD + '/api/' + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: method === 'GET' ? undefined : JSON.stringify(body || {}) });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  };
  const token = (await call('POST', 'signup', '', { name: 'smoke', pw: 'correcthorsebattery' })).data.token;
  const uid = (await call('GET', 'me', token)).data.id;
  const rt = (await call('POST', 'runner-token', token, { label: 'desktop:pc' })).data.token;
  const bot = (await call('POST', 'bots', token, { name: '助理', task: '' })).data.id;
  for (let i = 0; i < 1203; i++) cloud.raw.prepare("INSERT INTO messages (user_id,conv,by_,text,ts) VALUES (?,?,'me',?,?)").run(uid, bot, 'm' + i, Date.now());   // more than two pages

  const { startServer } = await import(pathToFileURL(join(repo, 'desktop/server.mjs')).href);
  const { cloudCaller } = await import(pathToFileURL(join(repo, 'desktop/cloud-import.mjs')).href);
  const dataDir = mkdtempSync(join(tmpdir(), 'octa-desk-'));
  const s = await startServer({ dataDir, runner: false });
  t.after(async () => { await s.close(); rmSync(dataDir, { recursive: true, force: true }); });
  // something written locally before the import is kept in the backup
  await jpost(s.url + '/api/bots', { name: '舊的本機機器人', task: '' });

  // a key the old cloud no longer knows: nothing changes here
  await assert.rejects(s.cloudImport({ call: cloudCaller('nope', { cloud: CLOUD }) }), /不認得這台電腦/);
  assert.equal((await (await fetch(s.url + '/api/state')).json()).bots[0].name, '舊的本機機器人');

  const progress = [];
  const res = await s.cloudImport({ call: cloudCaller(rt, { cloud: CLOUD }), onProgress: e => progress.push(e.label + ' ' + e.got) });
  assert.ok(res.counts.messages >= 1203);
  assert.ok(progress.length >= 12);
  assert.ok(readdirSync(dataDir).some(f => f.startsWith('ebot.backup-')), 'the old database is kept as a backup');
  assert.ok(res.backup.includes('ebot.backup-'));
  const st = await (await fetch(s.url + '/api/state')).json();
  assert.deepEqual(st.bots.map(b => b.name), ['助理'], 'the window now shows the cloud data');
  const msgs = await (await fetch(s.url + '/api/messages?conv=' + bot)).json();
  assert.ok(msgs.msgs.length > 0);
  // the local API answers as the only user; nothing points at a cloud
  const cfg = await (await fetch(s.url + '/api/config')).json();
  assert.equal(cfg.local, true);
  assert.ok(!cfg.host, 'no 主機模式 any more');

  // remote port: closed to the app until the phone remote is on…
  assert.equal((await fetch(s.remoteUrl + '/api/state')).status, 503);
  assert.equal((await fetch(s.remoteUrl + '/__octa_ping')).status, 200);
  // …but external events (the hook key is the secret) need no pairing
  const hk = await (await jpost(s.url + '/api/routines', { conv: bot, name: '收到訂單', trigger: 'hook', prompt: '處理訂單' })).json();
  assert.match(hk.hook || '', /^[0-9a-f]{48}$/, JSON.stringify(hk));
  const hookGet = await fetch(s.remoteUrl + '/api/hook/' + hk.hook);
  assert.equal(hookGet.status, 200);
  assert.equal((await hookGet.json()).routine, '收到訂單');
  const fired = await jpost(s.remoteUrl + '/api/hook/' + hk.hook, { order: 'A-17' });
  assert.equal(fired.status, 200);
  assert.equal((await fired.json()).ok, true);
  assert.equal((await fetch(s.remoteUrl + '/api/hook/' + '0'.repeat(48))).status, 404);
  assert.equal((await fetch(s.remoteUrl + '/api/hookx/' + hk.hook)).status, 503, 'only the hook route skips pairing');

  // phone remote: a fake cloudflared prints a tunnel address; the phone pairs with the code and sees this computer's data
  if (process.platform !== 'win32') {
    mkdirSync(join(dataDir, 'bin'), { recursive: true });
    writeFileSync(join(dataDir, 'bin', 'cloudflared'), '#!/bin/sh\necho "https://phone-test.trycloudflare.com" 1>&2\nexec sleep 600\n'); chmodSync(join(dataDir, 'bin', 'cloudflared'), 0o755);
    const on = await (await jpost(s.url + '/api/desktop/remote', { on: true })).json();
    assert.equal(on.on, true, JSON.stringify(on));
    assert.equal(on.url, 'https://phone-test.trycloudflare.com');
    assert.match(on.code, /^[A-Z2-9]{8}$/);
    assert.equal((await (await fetch(s.remoteUrl + '/api/config')).json()).pair, true);
    assert.equal((await fetch(s.remoteUrl + '/api/state')).status, 401, 'not paired yet');
    assert.equal((await jpost(s.remoteUrl + '/api/pair', { code: 'WRONG1' })).status, 401);
    assert.equal((await fetch(s.remoteUrl + '/api/desktop/status')).status, 403, 'the computer\'s own controls stay local');
    const pr = await (await jpost(s.remoteUrl + '/api/pair', { code: on.code })).json();
    const ps = await (await fetch(s.remoteUrl + '/api/state', { headers: { authorization: 'Bearer ' + pr.token } })).json();
    assert.equal(ps.bots[0].name, '助理', 'the paired phone sees this computer\'s data');
    assert.equal((await (await jpost(s.url + '/api/desktop/remote', { on: false })).json()).on, false);
    assert.equal((await fetch(s.remoteUrl + '/api/state', { headers: { authorization: 'Bearer ' + pr.token } })).status, 503);
  }
  // the window's port refuses other sites (DNS rebinding, cross-site POSTs)
  assert.equal((await fetch(s.url + '/api/state', { headers: { origin: 'https://evil.example' } })).status, 403);
});
