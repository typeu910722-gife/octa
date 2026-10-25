import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { runCodingTask, selectProvider } from '../public/coding-runtime.mjs';

const apiUrl = pathToFileURL(join(import.meta.dirname, '..', 'functions', 'api', '[[path]].js')).href;
const { onRequest, schedulesFromTurn, calmReply } = await import(apiUrl);
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
      catch (e) { try { db.exec('ROLLBACK'); } catch { /* already closed */ } throw e; }
    },
    exec: sql => db.exec(sql),
    raw: db
  };
}

let ip = 20;
async function call(db, method, path, { token, body, ipOverride, query } = {}) {
  const headers = { 'content-type': 'application/json', 'cf-connecting-ip': ipOverride || `203.0.113.${ip++}` };
  if (token) headers.authorization = 'Bearer ' + token;
  const url = new URL('http://octa.test/api/' + path);
  for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);
  const req = new Request(url, {
    method, headers, body: method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(body || {})
  });
  const res = await onRequest({
    request: req,
    env: { DB: db, ALLOW_SIGNUP: 'true', TZ_OFFSET_MIN: '480', isLocal: false, OCTA_CODE_ALLOW_FIXTURE: '1' },
    params: { path: path.split('/').filter(Boolean) }
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'octa-api-repo-'));
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'add', scripts: { test: 'node test.js' } }));
  writeFileSync(join(dir, 'src/add.js'), 'function add(a, b) { return a - b; }\nmodule.exports = { add };\n');
  writeFileSync(join(dir, 'test.js'), "const assert = require('assert');\nconst { add } = require('./src/add.js');\nassert.strictEqual(add(2, 3), 5);\n");
  const git = (args) => { const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' }); if (r.status) throw new Error(r.stderr); };
  git(['init']); git(['add', '-A']); git(['commit', '-m', 'init']);
  return dir;
}

test('existing account, bot, and message flow still works', async () => {
  const db = openD1();
  const su = await call(db, 'POST', 'signup', { body: { name: 'ada', pw: 'correcthorsebattery' } });
  assert.equal(su.status, 200);
  assert.ok(su.data.token);
  const bad = await call(db, 'POST', 'login', { body: { name: 'ada', pw: 'wrong-password' } });
  assert.equal(bad.status, 401);
  const bot = await call(db, 'POST', 'bots', { token: su.data.token, body: { name: '助理', task: '回答問題' } });
  assert.equal(bot.status, 200);
  const msg = await call(db, 'POST', 'messages', { token: su.data.token, body: { conv: bot.data.id, text: '你好' } });
  assert.equal(msg.status, 200);
  const state = await call(db, 'GET', 'state', { token: su.data.token });
  assert.equal(state.status, 200);
  assert.equal(state.data.bots.length, 1);
  assert.equal(state.data.bots[0].name, '助理');
  const anon = await call(db, 'GET', 'code/tasks');
  assert.equal(anon.status, 401);
});

test('code routes reject fixture when the server flag is off and require auth', async () => {
  const db = openD1();
  const su = await call(db, 'POST', 'signup', { body: { name: 'bea', pw: 'correcthorsebattery' } });
  const repo = await call(db, 'POST', 'code/repos', { token: su.data.token, body: { name: 'app', path: '/tmp/octa-nope' } });
  assert.equal(repo.status, 200);
  const saved = process.env.OCTA_CODE_ALLOW_FIXTURE;
  const blocked = await onRequest({
    request: new Request('http://octa.test/api/code/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + su.data.token, 'cf-connecting-ip': '198.51.100.8' },
      body: JSON.stringify({ repoId: repo.data.id, title: 't', prompt: 'p', criteria: '測試要通過', engine: 'fixture' })
    }),
    env: { DB: db, ALLOW_SIGNUP: 'true', TZ_OFFSET_MIN: '0', isLocal: false },
    params: { path: ['code', 'tasks'] }
  });
  assert.equal(blocked.status, 400);
  if (saved === undefined) delete process.env.OCTA_CODE_ALLOW_FIXTURE; else process.env.OCTA_CODE_ALLOW_FIXTURE = saved;
  const rel = await call(db, 'POST', 'code/repos', { token: su.data.token, body: { name: 'bad', path: 'relative/path' } });
  assert.equal(rel.status, 400);
  const dot = await call(db, 'POST', 'code/repos', { token: su.data.token, body: { name: 'bad', path: '/tmp/../etc' } });
  assert.equal(dot.status, 400);
});

test('one coding task is queued, executed in a worktree, persisted, and not deployed', async () => {
  const db = openD1();
  const repoPath = makeRepo();
  const su = await call(db, 'POST', 'signup', { body: { name: 'cy', pw: 'correcthorsebattery' } });
  const token = su.data.token;
  const repo = await call(db, 'POST', 'code/repos', { token, body: { name: 'add', path: repoPath } });
  assert.equal(repo.status, 200);
  const created = await call(db, 'POST', 'code/tasks', {
    token, body: { repoId: repo.data.id, title: '修正加法', prompt: '讓 add(2, 3) 等於 5', criteria: '測試要通過', engine: 'fixture', model: 'repair', maxRetries: 3 }
  });
  assert.equal(created.status, 200);
  const runner = await call(db, 'POST', 'runner-token', { token, body: { label: 'test-host' } });
  const rt = runner.data.token;
  const next = await call(db, 'POST', 'runner/next', { token: rt, body: { slots: 1, wait: false, coding: { ollama: { available: false, reason: '這台電腦連不到 Ollama（127.0.0.1:11434）', models: [] }, opencode: { available: false, reason: '這台電腦沒有安裝 OpenCode' }, unity: { available: false }, unreal: { available: false } } } });
  assert.equal(next.status, 200);
  assert.equal(next.data.job.kind, 'code');
  assert.equal(next.data.job.repo.path, repoPath);
  const provider = await selectProvider({ engine: 'fixture', model: 'repair', allowFixture: true });
  const root = mkdtempSync(join(tmpdir(), 'octa-api-ws-'));
  const state = await runCodingTask({
    id: created.data.id, title: '修正加法', prompt: '讓 add(2, 3) 等於 5', criteria: '測試要通過',
    engine: 'fixture', model: 'repair', maxRepairs: 3, repoPath, workspacesRoot: root, provider,
    persist: async summary => {
      const fresh = summary.events || [];
      const r = await call(db, 'POST', 'runner/code/event', { token: rt, body: {
        taskId: summary.id, status: summary.status, phase: summary.phase, role: summary.role,
        workspaceId: summary.workspaceId, branch: summary.branch, baseRef: summary.baseRef, headRef: summary.headRef,
        retries: summary.repairs, summary, events: fresh.slice(-3)
      } });
      assert.equal(r.status, 200);
      return r.data;
    }
  });
  assert.equal(state.status, 'tested');
  await call(db, 'POST', 'runner/done', { token: rt, body: { id: next.data.job.id, ok: true, text: 'tested' } });
  const got = await call(db, 'GET', 'code/tasks/' + created.data.id, { token });
  assert.equal(got.status, 200);
  assert.equal(got.data.task.status, 'tested');
  assert.equal(got.data.task.deployed, false);
  assert.match(got.data.task.summary.diff, /a \+ b/);
  assert.equal(got.data.task.summary.tests.at(-1).passed, true);
  assert.ok(got.data.events.some(e => e.role === 'reviewer' || e.kind === 'diff' || e.kind === 'test'));
  assert.match(readFileSync(join(repoPath, 'src/add.js'), 'utf8'), /a - b/);
  const no = await call(db, 'POST', 'code/tasks/' + created.data.id + '/approve', { token, body: { action: 'deploy', allow: true } });
  assert.equal(no.status, 400);
  const yes = await call(db, 'POST', 'code/tasks/' + created.data.id + '/approve', { token, body: { action: 'deploy', allow: true, target: 'production' } });
  assert.equal(yes.status, 200);
  assert.equal(yes.data.executed, false);
  assert.equal(yes.data.deployed, false);
  const providers = await call(db, 'GET', 'code/providers', { token });
  assert.equal(providers.data.providers.find(p => p.id === 'ollama').available, false);
  rmSync(repoPath, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

test('queued coding tasks cancel before the host starts, and migrations add the tables', async () => {
  const bare = new DatabaseSync(':memory:');
  const old = schema.replace(/CREATE TABLE IF NOT EXISTS code_repos[\s\S]*$/m, '');
  bare.exec(old);
  assert.throws(() => bare.prepare('SELECT id FROM code_tasks').get());
  const db = openD1From(bare);
  const su = await call(db, 'POST', 'signup', { body: { name: 'dee', pw: 'correcthorsebattery' } });
  assert.equal(su.status, 200);
  assert.doesNotThrow(() => bare.prepare('SELECT id FROM code_tasks').get());
  const repo = await call(db, 'POST', 'code/repos', { token: su.data.token, body: { name: 'app', path: '/tmp/octa-cancel-repo' } });
  const task = await call(db, 'POST', 'code/tasks', { token: su.data.token, body: { repoId: repo.data.id, title: '稍後', prompt: '先不要做', criteria: '測試要通過', engine: 'ollama' } });
  const cancel = await call(db, 'POST', 'code/tasks/' + task.data.id + '/cancel', { token: su.data.token, body: {} });
  assert.equal(cancel.data.cancelled, true);
  const got = await call(db, 'GET', 'code/tasks/' + task.data.id, { token: su.data.token });
  assert.equal(got.data.task.status, 'cancelled');
});

test('an old offline database keeps its messages and gains the reply column', async () => {
  const db = openD1();
  db.raw.exec("INSERT INTO users (id,name,pw,created) VALUES ('local','本機','-',1)");
  db.raw.exec("INSERT INTO bots (id,user_id,name,task,created) VALUES ('bot1','local','測','看房',1)");
  db.raw.exec('ALTER TABLE messages DROP COLUMN reply');
  db.raw.prepare("INSERT INTO messages (user_id,conv,by_,text,ts) VALUES ('local','bot1','me','舊訊息',1)").run();
  assert.throws(() => db.raw.prepare('SELECT reply FROM messages').get());
  const sent = await onRequest({
    request: new Request('http://127.0.0.1/api/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: '127.0.0.1' },
      body: JSON.stringify({ conv: 'bot1', text: '新訊息' })
    }),
    env: { DB: db, ALLOW_SIGNUP: 'false', TZ_OFFSET_MIN: '480', isLocal: true },
    params: { path: ['messages'] }
  });
  const data = await sent.json();
  assert.equal(sent.status, 200, data.error || '');
  const rows = db.raw.prepare("SELECT text, reply FROM messages WHERE user_id='local' ORDER BY id").all();
  assert.deepEqual(rows.map(r => r.text), ['舊訊息', '新訊息']);
  assert.equal(rows[0].reply, null);
  const server = readFileSync(join(import.meta.dirname, '..', 'desktop', 'server.mjs'), 'utf8');
  assert.match(server, /ALTER TABLE messages ADD COLUMN reply INTEGER/);
});

test('local mode state loads when there is no host computer row', async () => {
  const db = openD1();
  await db.prepare("INSERT OR IGNORE INTO users (id,name,pw,created) VALUES ('local','本機','-',?)").bind(Date.now()).run();
  const res = await onRequest({
    request: new Request('http://127.0.0.1/api/state', { headers: { host: '127.0.0.1' } }),
    env: { DB: db, ALLOW_SIGNUP: 'false', TZ_OFFSET_MIN: '480', isLocal: true },
    params: { path: ['state'] }
  });
  const data = await res.json();
  assert.equal(res.status, 200, data.error || '');
  assert.equal(data.local, true);
  assert.equal(data.host, 'local');
  assert.equal(data.runnerOnline, true);
  assert.ok(Array.isArray(data.codeTasks));
});

test('state does not return notification tokens', async () => {
  const db = openD1();
  const su = await call(db, 'POST', 'signup', { body: { name: 'eve', pw: 'correcthorsebattery' } });
  const token = su.data.token;
  const secret = 'tg-secret-should-not-leak-9f3a';
  const line = 'line-secret-should-not-leak-9f3a';
  const saved = await call(db, 'PUT', 'settings', { token, body: { tg: { token: secret, chat: '100' }, line: { token: line, to: 'Uabc' } } });
  assert.equal(saved.status, 200);
  const state = await call(db, 'GET', 'state', { token });
  assert.equal(state.status, 200);
  const raw = JSON.stringify(state.data);
  assert.equal(raw.includes('should-not-leak'), false);
  assert.equal(raw.includes(secret), false);
  const settings = await call(db, 'GET', 'settings', { token });
  assert.match(settings.data.tg.token, /^••••/);
  assert.equal(String(settings.data.tg.token).includes('should-not-leak'), false);
  assert.equal(String(settings.data.line.token).includes('should-not-leak'), false);
});

async function runnerOf(db, token) {
  const runner = await call(db, 'POST', 'runner-token', { token, body: { label: 'route-host' } });
  assert.equal(runner.status, 200, JSON.stringify(runner.data));
  return runner.data.token;
}
async function claimChat(db, rt) {
  const next = await call(db, 'POST', 'runner/next', { token: rt, body: { slots: 1, wait: false } });
  assert.equal(next.status, 200, JSON.stringify(next.data));
  return next.data.job;
}

test('simulated model failures keep the chat queue and classify the route', async () => {
  const db = openD1();
  const su = await call(db, 'POST', 'signup', { body: { name: 'fay', pw: 'correcthorsebattery' } });
  const token = su.data.token;
  const bot = await call(db, 'POST', 'bots', { token, body: { name: '助理', task: '回答', fb: ['gemini', 'opencode|qwen3'] } });
  const id = bot.data.id;
  await call(db, 'POST', 'messages', { token, body: { conv: id, text: '請回答這題' } });
  const rt = await runnerOf(db, token);
  const first = await claimChat(db, rt);
  assert.equal(first.kind, 'chat');
  assert.equal(first.bot.engine, 'claude');
  const quota = await call(db, 'POST', 'runner/done', { token: rt, body: { id: first.id, ok: false, text: 'usage limit exceeded. Resets in 1h' } });
  assert.equal(quota.status, 200);
  const second = await claimChat(db, rt);
  assert.equal(second.bot.engine, 'gemini');
  assert.equal(second.prompt, '請回答這題');
  assert.equal(second.routeTries, 0);
  const limited = await call(db, 'POST', 'runner/done', { token: rt, body: { id: second.id, ok: false, text: 'HTTP 429 too many requests' } });
  assert.equal(limited.status, 200);
  const third = await claimChat(db, rt);
  assert.equal(third.bot.engine, 'gemini');
  assert.equal(third.routeTries, 1);
  const still = await call(db, 'POST', 'runner/done', { token: rt, body: { id: third.id, ok: false, text: 'HTTP 429 too many requests' } });
  assert.equal(still.status, 200);
  const fourth = await claimChat(db, rt);
  assert.equal(fourth.bot.engine, 'opencode');
  assert.equal(fourth.bot.model, 'qwen3');
  const auth = await call(db, 'POST', 'runner/done', { token: rt, body: { id: fourth.id, ok: false, text: 'invalid api key' } });
  assert.equal(auth.status, 200);
  const none = await claimChat(db, rt);
  assert.equal(none, null);
  const msgs = await call(db, 'GET', 'messages', { token, query: { conv: id } });
  const text = msgs.data.msgs.map(m => m.text).join('\n');
  assert.match(text, /額度用完/);
  assert.match(text, /被限流/);
  assert.match(text, /API Key/);
  assert.equal(text.includes('請回答這題'), true);
  const okRun = await call(db, 'POST', 'messages', { token, body: { conv: id, text: '再說一次' } });
  assert.equal(okRun.status, 200);
  const again = await claimChat(db, rt);
  assert.equal(again.kind, 'chat');
  assert.equal(again.prompt, '再說一次');
  const done = await call(db, 'POST', 'runner/done', { token: rt, body: { id: again.id, ok: true, text: '這是真實回覆' } });
  assert.equal(done.status, 200);
  const after = await call(db, 'GET', 'messages', { token, query: { conv: id } });
  assert.ok(after.data.msgs.some(m => m.text === '這是真實回覆'));
});

test('a weekly limit reply still calls the backup when the task text follows it', async () => {
  const db = openD1();
  const su = await call(db, 'POST', 'signup', { body: { name: 'weeka', pw: 'correcthorsebattery' } });
  const token = su.data.token;
  const bot = await call(db, 'POST', 'bots', { token, body: { name: '貳寅首席', task: '看房', engine: 'claude', fb: ['gemini'] } });
  await call(db, 'POST', 'messages', { token, body: { conv: bot.data.id, text: '整理今天的訂單' } });
  const rt = await runnerOf(db, token);
  const first = await claimChat(db, rt);
  assert.equal(first.bot.engine, 'claude');
  assert.equal(first.backup, false);
  const text = "You've hit your weekly limit - resets Oct 26, 11pm (Asia/Taipei)\n" + '規則——只讀。'.repeat(200);
  const done = await call(db, 'POST', 'runner/done', { token: rt, body: { id: first.id, ok: true, text } });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  const second = await claimChat(db, rt);
  assert.equal(second.bot.engine, 'gemini');
  assert.equal(second.backup, true);
  assert.equal(second.prompt, '整理今天的訂單');
  const msgs = await call(db, 'GET', 'messages', { token, query: { conv: bot.data.id } });
  assert.equal(msgs.data.msgs.some(m => m.by === bot.data.id && /weekly limit/.test(m.text)), false);
  assert.ok(msgs.data.msgs.some(m => m.by === 'sys' && m.text.includes('改由')));
});

test('a stopped chat and a code failure do not queue another model', async () => {
  const db = openD1();
  const su = await call(db, 'POST', 'signup', { body: { name: 'gia', pw: 'correcthorsebattery' } });
  const token = su.data.token;
  const bot = await call(db, 'POST', 'bots', { token, body: { name: '助理', task: '回答', fb: ['gemini'] } });
  await call(db, 'POST', 'messages', { token, body: { conv: bot.data.id, text: '做這個' } });
  const rt = await runnerOf(db, token);
  const first = await claimChat(db, rt);
  await call(db, 'POST', 'runner/done', { token: rt, body: { id: first.id, ok: false, stopped: true, text: 'usage limit exceeded' } });
  const stopped = await claimChat(db, rt);
  assert.equal(stopped, null);
  await call(db, 'POST', 'messages', { token, body: { conv: bot.data.id, text: '改程式' } });
  const code = await claimChat(db, rt);
  const failed = await call(db, 'POST', 'runner/done', { token: rt, body: { id: code.id, ok: false, text: 'AssertionError test.js failed' } });
  assert.equal(failed.status, 200, JSON.stringify(failed.data));
  const noSwitch = await claimChat(db, rt);
  assert.equal(noSwitch, null);
  const msgs = await call(db, 'GET', 'messages', { token, query: { conv: bot.data.id } });
  const text = msgs.data.msgs.map(m => m.text).join('\n');
  assert.match(text, /已停止/);
  assert.match(text, /AssertionError/);
  assert.equal(/改由/.test(text), false);
});

test('a new bot that is told the quota is gone calls the backups in order', async () => {
  const db = openD1();
  const su = await call(db, 'POST', 'signup', { body: { name: 'hoa', pw: 'correcthorsebattery' } });
  const token = su.data.token;
  const bot = await call(db, 'POST', 'bots', {
    token,
    body: { name: '新助手', task: '處理工作', engine: 'gemini', model: '', fb: ['claude|opus', 'codex', 'opencode|qwen3:latest'] }
  });
  assert.equal(bot.status, 200, JSON.stringify(bot.data));
  const id = bot.data.id;
  await call(db, 'POST', 'messages', { token, body: { conv: id, text: '請看一下後台' } });
  const rt = await runnerOf(db, token);
  const first = await claimChat(db, rt);
  assert.equal(first.bot.engine, 'gemini');
  assert.equal(first.bot.model, '');
  const said = await call(db, 'POST', 'runner/done', { token: rt, body: { id: first.id, ok: true, text: '目前這個 AI 的流量不夠，請 5 小時後再試。' } });
  assert.equal(said.status, 200, JSON.stringify(said.data));
  const second = await claimChat(db, rt);
  assert.equal(second.bot.engine, 'claude');
  assert.equal(second.bot.model, 'opus');
  assert.equal(second.prompt, '請看一下後台');
  const missing = await call(db, 'POST', 'runner/done', { token: rt, body: { id: second.id, ok: false, text: '⚠ 這台電腦沒有安裝 Claude Code。請到「AI 連線」安裝並登入。' } });
  assert.equal(missing.status, 200, JSON.stringify(missing.data));
  const third = await claimChat(db, rt);
  assert.equal(third.bot.engine, 'codex');
  assert.equal(third.bot.model, '');
  const hidden = await call(db, 'POST', 'runner/done', { token: rt, body: { id: third.id, ok: false, text: 'Error: request failed\n目前流量不夠，請稍後再試' } });
  assert.equal(hidden.status, 200, JSON.stringify(hidden.data));
  const fourth = await claimChat(db, rt);
  assert.equal(fourth.bot.engine, 'opencode');
  assert.equal(fourth.bot.model, 'qwen3:latest');
  const local = await call(db, 'POST', 'runner/done', { token: rt, body: { id: fourth.id, ok: true, text: '後台目前沒有新訊息。' } });
  assert.equal(local.status, 200);
  const quiet = await claimChat(db, rt);
  assert.equal(quiet, null);
  const msgs = await call(db, 'GET', 'messages', { token, query: { conv: id } });
  const bubbles = msgs.data.msgs.filter(m => m.by === id).map(m => m.text);
  assert.deepEqual(bubbles, ['後台目前沒有新訊息。']);
  const sys = msgs.data.msgs.filter(m => m.by === 'sys').map(m => m.text).join('\n');
  assert.match(sys, /Antigravity 額度用完，改由 Claude（opus）/);
  assert.match(sys, /Claude（opus） 這台電腦還沒安裝，改由 ChatGPT/);
  assert.match(sys, /ChatGPT 額度用完，改由 Ollama（qwen3:latest）/);
  assert.equal(bubbles.some(t => t.includes('流量不夠')), false);
  const again = await call(db, 'POST', 'messages', { token, body: { conv: id, text: '再看一次' } });
  assert.equal(again.status, 200);
  const skipped = await claimChat(db, rt);
  assert.equal(skipped.bot.engine, 'opencode');
  assert.equal(skipped.bot.model, 'qwen3:latest');
  assert.equal(skipped.prompt, '再看一次');
  const ordinary = await call(db, 'POST', 'runner/done', { token: rt, body: { id: skipped.id, ok: true, text: '人流量不夠，不建議開店' } });
  assert.equal(ordinary.status, 200);
  const noHop = await claimChat(db, rt);
  assert.equal(noHop, null);
  const kept = await call(db, 'GET', 'messages', { token, query: { conv: id } });
  assert.ok(kept.data.msgs.some(m => m.by === id && m.text === '人流量不夠，不建議開店'));
  const page = readFileSync(join(import.meta.dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(page, /模型說流量不夠或額度用完，會立刻改叫下一個備援/);
  const runner = readFileSync(join(import.meta.dirname, '..', 'public', 'octa-runner.mjs'), 'utf8');
  assert.match(runner, /replyIsProviderRefusal\(text\)/);
  assert.match(runner, /providerFailureText\(\[text, r\.err, r\.out\]\)/);
});

test('dragging a message copies it, and replace removes the original', async () => {
  const db = openD1();
  const su = await call(db, 'POST', 'signup', { body: { name: 'copya', pw: 'correcthorsebattery' } });
  const token = su.data.token;
  const a = await call(db, 'POST', 'bots', { token, body: { name: '甲', task: '收訊息' } });
  const b = await call(db, 'POST', 'bots', { token, body: { name: '乙', task: '收訊息' } });
  const up = await call(db, 'POST', 'files', { token, body: { conv: a.data.id, name: '圖.jpg', mime: 'image/jpeg', data: 'aGVsbG8=' } });
  assert.equal(up.status, 200, JSON.stringify(up.data));
  const sent = await call(db, 'POST', 'messages', { token, body: { conv: a.data.id, text: '照這張圖', files: [up.data.id] } });
  assert.equal(sent.status, 200);
  const src = await call(db, 'GET', 'messages', { token, query: { conv: a.data.id } });
  const msg = src.data.msgs.find(m => m.text === '照這張圖');
  assert.ok(msg);
  assert.equal(msg.files[0].id, up.data.id);
  const same = await call(db, 'POST', 'messages/copy', { token, body: { to: a.data.id, from: a.data.id, id: msg.id, replace: false } });
  assert.equal(same.status, 400);
  const copied = await call(db, 'POST', 'messages/copy', { token, body: { to: b.data.id, from: a.data.id, id: msg.id, replace: false } });
  assert.equal(copied.status, 200, JSON.stringify(copied.data));
  assert.equal(copied.data.replaced, false);
  const kept = await call(db, 'GET', 'messages', { token, query: { conv: a.data.id } });
  assert.ok(kept.data.msgs.some(m => m.id === msg.id));
  const dest = await call(db, 'GET', 'messages', { token, query: { conv: b.data.id } });
  const copy = dest.data.msgs.find(m => m.text === '照這張圖');
  assert.ok(copy);
  assert.notEqual(copy.files[0].id, up.data.id);
  const file = await call(db, 'GET', 'file/' + copy.files[0].id, { token });
  assert.equal(file.status, 200);
  assert.equal(file.data.data, 'aGVsbG8=');
  const jobs = db.raw.prepare("SELECT conv, prompt FROM jobs WHERE kind IS NULL OR kind='chat' OR kind=''").all();
  assert.ok(jobs.some(j => j.conv === b.data.id && j.prompt === '照這張圖'));
  const other = await call(db, 'POST', 'signup', { body: { name: 'copyb', pw: 'correcthorsebattery' } });
  const stolen = await call(db, 'POST', 'messages/copy', { token: other.data.token, body: { to: b.data.id, from: a.data.id, id: msg.id, replace: true } });
  assert.equal(stolen.status, 404);
  const replaced = await call(db, 'POST', 'messages/copy', { token, body: { to: b.data.id, from: a.data.id, id: msg.id, replace: true } });
  assert.equal(replaced.status, 200);
  assert.equal(replaced.data.replaced, true);
  const gone = await call(db, 'GET', 'messages', { token, query: { conv: a.data.id } });
  assert.equal(gone.data.msgs.some(m => m.id === msg.id), false);
  const still = await call(db, 'GET', 'file/' + up.data.id, { token });
  assert.equal(still.status, 200);
  const g = await call(db, 'POST', 'groups', { token, body: { name: '組', task: '', members: [a.data.id] } });
  assert.equal(g.status, 200, JSON.stringify(g.data));
  const joined = await call(db, 'PUT', 'groups/' + g.data.id, { token, body: { name: '組', task: '', members: [a.data.id, b.data.id], folder: null } });
  assert.equal(joined.status, 200, JSON.stringify(joined.data));
  const state = await call(db, 'GET', 'state', { token });
  assert.deepEqual(state.data.groups.find(x => x.id === g.data.id).members, [a.data.id, b.data.id]);
  const page = readFileSync(join(import.meta.dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(page, /複製並蓋掉原本的訊息/);
  assert.match(page, /messages\/copy/);
  assert.match(page, /加入群組/);
  assert.match(page, /確定要複製？/);
  const runner = readFileSync(join(import.meta.dirname, '..', 'public', 'octa-runner.mjs'), 'utf8');
  assert.match(runner, /octa:open/);
  const api = readFileSync(join(import.meta.dirname, '..', 'functions', 'api', '[[path]].js'), 'utf8');
  assert.match(api, /body\.expand/);
});

test('a phone can replace the address waiting on the computer, and the open result saves the page without a bot reply', async () => {
  const db = openD1();
  const su = await call(db, 'POST', 'signup', { body: { name: 'phoneurl', pw: 'correcthorsebattery' } });
  const token = su.data.token;
  const bot = await call(db, 'POST', 'bots', { token, body: { name: '瀏覽', task: '開網頁' } });
  assert.equal(bot.status, 200, JSON.stringify(bot.data));
  const id = bot.data.id;
  const first = await call(db, 'POST', 'open', { token, body: { bot: id, conv: id, url: 'example.com', expand: true } });
  assert.equal(first.status, 200, JSON.stringify(first.data));
  const row = db.raw.prepare("SELECT url, status FROM jobs WHERE kind='open'").get();
  assert.equal(row.url, 'octa:open https://example.com');
  assert.equal(row.status, 'pending');
  const second = await call(db, 'POST', 'open', { token, body: { bot: id, conv: id, url: 'https://manager.line.biz/', expand: true } });
  assert.equal(second.status, 200);
  assert.equal(second.data.queued, true);
  const rows = db.raw.prepare("SELECT url, status FROM jobs WHERE kind='open'").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].url, 'octa:open https://manager.line.biz/');
  const runner = await call(db, 'POST', 'runner-token', { token, body: { label: 'desk' } });
  const rt = runner.data.token;
  const next = await call(db, 'POST', 'runner/next', { token: rt, body: { slots: 1, wait: false } });
  assert.equal(next.status, 200, JSON.stringify(next.data));
  assert.equal(next.data.job.kind, 'open');
  assert.equal(next.data.job.url, 'octa:open https://manager.line.biz/');
  const before = await call(db, 'GET', 'messages', { token, query: { conv: id } });
  const replies = before.data.msgs.filter(m => m.by === id).length;
  const done = await call(db, 'POST', 'runner/done', { token: rt, body: { id: next.data.job.id, ok: true, text: '我的瀏覽器已經在電腦上。', page: 'https://manager.line.biz/account' } });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  const state = await call(db, 'GET', 'state', { token });
  assert.equal(state.data.bots.find(b => b.id === id).page, 'https://manager.line.biz/account');
  const after = await call(db, 'GET', 'messages', { token, query: { conv: id } });
  assert.equal(after.data.msgs.filter(m => m.by === id).length, replies);
  const again = await call(db, 'POST', 'open', { token, body: { bot: id, conv: id, url: 'https://a.example/', expand: true } });
  assert.equal(again.status, 200);
  const nxt2 = await call(db, 'POST', 'runner/next', { token: rt, body: { slots: 1, wait: false } });
  const bad = await call(db, 'POST', 'runner/done', { token: rt, body: { id: nxt2.data.job.id, ok: false, text: '⚠ 無法打開瀏覽器：離線' } });
  assert.equal(bad.status, 200);
  const msgs = await call(db, 'GET', 'messages', { token, query: { conv: id } });
  assert.ok(msgs.data.msgs.some(m => m.by === 'sys' && m.text.includes('無法打開')));
  const src = readFileSync(join(import.meta.dirname, '..', 'public', 'octa-runner.mjs'), 'utf8');
  assert.match(src, /rememberOpen/);
  assert.match(src, /browserSnapshot\(port\)/);
  assert.match(src, /\.\.\.\(page \? \{ page \} : \{\}\)/);
  const api = readFileSync(join(import.meta.dirname, '..', 'functions', 'api', '[[path]].js'), 'utf8');
  assert.match(api, /job\.kind === 'open'/);
  assert.match(api, /UPDATE jobs SET url=\?, conv=\?/);
});

test('a reply points at one message, and a group answer goes only to that bot', async () => {
  const db = openD1();
  db.raw.exec('ALTER TABLE messages DROP COLUMN reply');
  const su = await call(db, 'POST', 'signup', { body: { name: 'rea', pw: 'correcthorsebattery' } });
  const token = su.data.token;
  const a = await call(db, 'POST', 'bots', { token, body: { name: '房務', task: '看房' } });
  const b = await call(db, 'POST', 'bots', { token, body: { name: '清潔', task: '打掃' } });
  const id = a.data.id;
  assert.equal((await call(db, 'POST', 'messages', { token, body: { conv: id, text: '房況 302' } })).status, 200);
  const listed = await call(db, 'GET', 'messages', { token, query: { conv: id } });
  const origin = listed.data.msgs.find(m => m.text === '房況 302');
  assert.equal((await call(db, 'POST', 'messages', { token, body: { conv: id, text: '這間先不要', reply: origin.id } })).status, 200);
  assert.equal((await call(db, 'POST', 'messages', { token, body: { conv: id, text: '沒有那則', reply: 999999 } })).status, 200);
  const msgs = await call(db, 'GET', 'messages', { token, query: { conv: id } });
  assert.equal(msgs.data.msgs.find(m => m.text === '這間先不要').reply, origin.id);
  assert.equal(msgs.data.msgs.find(m => m.text === '沒有那則').reply, null);
  const rt = await runnerOf(db, token);
  const first = await claimChat(db, rt);
  assert.equal(first.prompt, '房況 302');
  assert.equal((await call(db, 'POST', 'runner/done', { token: rt, body: { id: first.id, ok: true, text: '收到房況' } })).status, 200);
  const second = await claimChat(db, rt);
  assert.match(second.prompt, /回覆「你自己」/);
  assert.match(second.prompt, /房況 302/);
  assert.match(second.prompt, /這間先不要/);
  const hit = second.history.find(h => h.text === '這間先不要');
  assert.match(hit.replyText, /房況 302/);
  assert.equal(hit.replyWho, '使用者');
  assert.equal((await call(db, 'POST', 'runner/done', { token: rt, body: { id: second.id, ok: true, text: '好，先跳過' } })).status, 200);
  const third = await claimChat(db, rt);
  assert.equal(third.prompt, '沒有那則');
  assert.equal((await call(db, 'POST', 'runner/done', { token: rt, body: { id: third.id, ok: true, text: '好' } })).status, 200);
  const g = await call(db, 'POST', 'groups', { token, body: { name: '館內', members: [a.data.id, b.data.id] } });
  assert.equal(g.status, 200, JSON.stringify(g.data));
  assert.equal((await call(db, 'POST', 'messages', { token, body: { conv: g.data.id, text: '@房務 今天掃哪幾間' } })).status, 200);
  const job = await claimChat(db, rt);
  assert.equal(job.bot.id, a.data.id);
  assert.equal((await call(db, 'POST', 'runner/done', { token: rt, body: { id: job.id, ok: true, text: '302 和 303' } })).status, 200);
  const gm = await call(db, 'GET', 'messages', { token, query: { conv: g.data.id } });
  const said = gm.data.msgs.find(m => m.text === '302 和 303');
  assert.equal(said.by, a.data.id);
  const cross = await call(db, 'POST', 'messages', { token, body: { conv: id, text: '別的對話', reply: said.id } });
  assert.equal(cross.status, 200);
  const crossed = await call(db, 'GET', 'messages', { token, query: { conv: id } });
  assert.equal(crossed.data.msgs.find(m => m.text === '別的對話').reply, null);
  const stray = await claimChat(db, rt);
  assert.equal(stray.prompt, '別的對話');
  assert.equal((await call(db, 'POST', 'runner/done', { token: rt, body: { id: stray.id, ok: true, text: '好' } })).status, 200);
  assert.equal((await call(db, 'POST', 'messages', { token, body: { conv: g.data.id, text: '303 先不要', reply: said.id } })).status, 200);
  const only = await claimChat(db, rt);
  assert.equal(only.bot.id, a.data.id);
  assert.match(only.prompt, /302 和 303/);
  assert.match(only.prompt, /303 先不要/);
  assert.equal(await claimChat(db, rt), null);
});

test('two devices share one open conversation, and a connector keeps its secret', async () => {
  const db = openD1();
  const su = await call(db, 'POST', 'signup', { body: { name: 'synca', pw: 'correcthorsebattery' } });
  const token = su.data.token;
  const again = await call(db, 'POST', 'login', { body: { name: 'synca', pw: 'correcthorsebattery' } });
  const phone = again.data.token;
  const bot = await call(db, 'POST', 'bots', { token, body: { name: '房務', task: '看房' } });
  const id = bot.data.id;
  const missing = await call(db, 'PUT', 'focus', { token, body: { conv: 'nope', dev: 'devicephone1' } });
  assert.equal(missing.status, 404);
  const put = await call(db, 'PUT', 'focus', { token: phone, body: { conv: id, dev: 'devicephone1' } });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  const desk = await call(db, 'GET', 'state', { token });
  const hand = await call(db, 'GET', 'state', { token: phone });
  assert.equal(desk.data.focus.conv, id);
  assert.equal(desk.data.focus.dev, 'devicephone1');
  assert.equal(hand.data.focus.conv, id);
  const bad = await call(db, 'POST', 'connectors', { token, body: { name: '內網', base: 'https://127.0.0.1/secret', header: 'Authorization', secret: 'nope' } });
  assert.equal(bad.status, 400);
  const http = await call(db, 'POST', 'connectors', { token, body: { name: '訂單', base: 'http://api.example.com/v1', secret: 'super-secret-key' } });
  assert.equal(http.status, 400);
  const added = await call(db, 'POST', 'connectors', { token, body: { name: '訂單', base: 'https://api.example.com/v1', header: 'Authorization', secret: 'super-secret-key' } });
  assert.equal(added.status, 200, JSON.stringify(added.data));
  const list = await call(db, 'GET', 'connectors', { token: phone });
  assert.equal(list.data.custom[0].name, '訂單');
  assert.equal(list.data.custom[0].secret.includes('super-secret-key'), false);
  assert.match(list.data.custom[0].secret, /••••/);
  await call(db, 'PUT', 'settings', { token, body: { tg: { token: 'tg-secret-token', chat: '99' } } });
  assert.equal((await call(db, 'POST', 'messages', { token, body: { conv: id, text: '看訂單' } })).status, 200);
  const rt = await runnerOf(db, token);
  const job = await claimChat(db, rt);
  assert.ok(job.connectors.some(c => c.name === '訂單' && c.can.includes('讀取')));
  assert.ok(job.connectors.some(c => c.name === 'Telegram' && !c.can.includes('讀取')));
  assert.equal(JSON.stringify(job).includes('super-secret-key'), false);
  assert.equal(JSON.stringify(job).includes('tg-secret-token'), false);
  const held = await call(db, 'POST', 'runner/connector', { token: rt, body: { job: job.id, name: 'Telegram', action: '送出', content: '你好' } });
  assert.equal(held.status, 200, JSON.stringify(held.data));
  assert.equal(held.data.ok, false);
  assert.match(held.data.text, /沒有送出/);
  const gone = await call(db, 'DELETE', 'connectors/' + added.data.id, { token: phone });
  assert.equal(gone.status, 200);
  const left = await call(db, 'GET', 'connectors', { token });
  assert.equal(left.data.custom.length, 0);
});

test('the host catches up one missed routine, and a fourth job waits', async () => {
  const db = openD1();
  const su = await call(db, 'POST', 'signup', { body: { name: 'hosty', pw: 'correcthorsebattery' } });
  const token = su.data.token;
  const state = await call(db, 'GET', 'state', { token });
  assert.equal(state.data.sched, 'pc');
  const bot = await call(db, 'POST', 'bots', { token, body: { name: '房務', task: '看房' } });
  const id = bot.data.id;
  const uid = db.raw.prepare('SELECT id FROM users').get().id;
  db.raw.prepare('INSERT INTO routines (id,user_id,conv,name,prompt,times,enabled,fired,created) VALUES (?,?,?,?,?,?,1,?,?)')
    .run('r-miss', uid, id, '早報', '整理訂單', '["00:00"]', '{}', Date.now());
  const rt = await runnerOf(db, token);
  const next = await call(db, 'POST', 'runner/next', { token: rt, body: { slots: 1, wait: false } });
  assert.equal(next.status, 200, JSON.stringify(next.data));
  const msgs = await call(db, 'GET', 'messages', { token, query: { conv: id } });
  assert.ok(msgs.data.msgs.some(m => m.by === 'sys' && m.text.includes('補做錯過的例行任務')));
  assert.match(next.data.job.prompt, /補做/);
  await call(db, 'POST', 'runner/done', { token: rt, body: { id: next.data.job.id, ok: true, text: '好' } });
  const names = ['甲', '乙', '丙', '丁'];
  const ids = [];
  for (const name of names) ids.push((await call(db, 'POST', 'bots', { token, body: { name, task: '工作' } })).data.id);
  for (const bid of ids.slice(0, 3)) {
    db.raw.prepare("INSERT INTO jobs (user_id,conv,bot_id,chain,prompt,status,created,kind) VALUES (?,?,?,'[]','做', 'running', ?, 'chat')").run(uid, bid, bid, Date.now());
  }
  assert.equal((await call(db, 'POST', 'messages', { token, body: { conv: ids[3], text: '也做' } })).status, 200);
  const queued = await call(db, 'GET', 'messages', { token, query: { conv: ids[3] } });
  assert.ok(queued.data.msgs.some(m => m.by === 'sys' && m.text.includes('先排隊') && m.text.includes('甲')));
});

test('schedule times come from the instruction, and a backup still saves memory', () => {
  const handoff = '請建立例行任務：06:04 和 15:30 的補助名單要給補助小蝦人；06:41 早報要給整備員；11:20 入住名單要給快遞員';
  const invented = '任務排程已建好\n00:46 核對前一天\n01:46 登入檢查\n⏰例行任務：登入檢查｜00:46｜檢查登入';
  const saved = schedulesFromTurn(handoff, invented);
  assert.equal(saved.fromPrompt, true);
  assert.deepEqual(saved.routines.map(r => [r.name, r.times]), [
    ['補助名單', ['06:04', '15:30']],
    ['早報', ['06:41']],
    ['入住名單', ['11:20']]
  ]);
  const later = schedulesFromTurn('請把那幾個時間建在例行任務裡', '06:04 補助名單\n06:41 早報\n今天 15:30 見');
  assert.equal(later.fromPrompt, false);
  assert.deepEqual(later.routines.map(r => [r.name, r.times]), [
    ['補助名單', ['06:04']],
    ['早報', ['06:41']]
  ]);
  assert.deepEqual(schedulesFromTurn('今天 15:30 見', '00:46 登入檢查\n排程已建好').routines, []);
  const duty = schedulesFromTurn('交接的工作：06:04 和 15:30 的補助名單要給「補助小蝦人」；06:41 早報要給「Eroom整備員」', '00:46 登入檢查');
  assert.deepEqual(duty.routines.map(r => r.times), [['06:04', '15:30'], ['06:41']]);
  assert.equal(duty.routines.some(r => r.times.includes('00:46')), false);
});

test('an Ollama reply still stores the instruction routines, memory, and skill', async () => {
  const db = openD1();
  const su = await call(db, 'POST', 'signup', { body: { name: 'olla', pw: 'correcthorsebattery' } });
  const token = su.data.token;
  const bot = await call(db, 'POST', 'bots', { token, body: { name: '備援助手', task: '看房號', engine: 'opencode', model: 'qwen3' } });
  assert.equal(bot.status, 200, JSON.stringify(bot.data));
  const id = bot.data.id;
  const prompt = '請建立例行任務：06:04 和 15:30 的補助名單要給補助小蝦人；06:41 早報要給整備員；11:20 入住名單要給快遞員';
  await call(db, 'POST', 'messages', { token, body: { conv: id, text: prompt } });
  const rt = await runnerOf(db, token);
  const job = await claimChat(db, rt);
  assert.equal(job.bot.engine, 'opencode');
  assert.equal(job.backup, false);
  const reply = [
    '任務排程已建好，包含以下每日例行任務：',
    '00:46 核對前一天',
    '01:46 登入檢查',
    '⏰例行任務：登入檢查｜00:46｜檢查登入',
    '📌記住：302 房冷氣壞了',
    '🗺️網站筆記：example.com｜左側是訂單',
    '🧩技能：查房',
    '打開後台',
    '看房號',
    '🧩結束'
  ].join('\n');
  const done = await call(db, 'POST', 'runner/done', { token: rt, body: { id: job.id, ok: true, text: reply } });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  const state = await call(db, 'GET', 'state', { token });
  const routines = Object.fromEntries(state.data.routines.map(r => [r.name, r.times]));
  assert.deepEqual(routines, {
    補助名單: ['06:04', '15:30'],
    早報: ['06:41'],
    入住名單: ['11:20']
  });
  assert.deepEqual(state.data.memory[id], ['302 房冷氣壞了']);
  assert.equal(state.data.skills[id][0].name, '查房');
  const msgs = await call(db, 'GET', 'messages', { token, query: { conv: id } });
  const sys = msgs.data.msgs.filter(m => m.by === 'sys').map(m => m.text).join('\n');
  assert.match(sys, /已新增例行任務「補助名單」/);
  assert.match(sys, /已記住：302 房冷氣壞了/);
  assert.match(sys, /已存成技能「查房」/);
  assert.equal(sys.includes('沒有新增例行任務'), false);
  assert.equal(sys.includes('00:46'), false);
  await call(db, 'POST', 'messages', { token, body: { conv: id, text: '再看一次' } });
  const next = await claimChat(db, rt);
  assert.match(next.sites, /example.com/);
  assert.match(next.sites, /左側是訂單/);
  const bare = await call(db, 'POST', 'runner/done', { token: rt, body: { id: next.id, ok: true, text: '排程已建好' } });
  assert.equal(bare.status, 200);
  const after = await call(db, 'GET', 'messages', { token, query: { conv: id } });
  assert.ok(after.data.msgs.some(m => m.by === 'sys' && m.text.includes('沒有新增例行任務')));
  const still = await call(db, 'GET', 'state', { token });
  assert.equal(still.data.routines.length, 3);
});

test('a stuck reply is said once, and a group takes turns', async () => {
  assert.equal(calmReply(['需要使用者在電腦上登入（LINE 登入頁面）', '需要使用者在電腦上登入（LINE 登入頁面）', '【派瀏覽】', '看登入頁', '【派瀏覽】', '看登入頁'].join('\n')), '需要使用者在電腦上登入（LINE 登入頁面）\n看登入頁');
  const db = openD1();
  const su = await call(db, 'POST', 'signup', { body: { name: 'loopa', pw: 'correcthorsebattery' } });
  const token = su.data.token;
  const names = ['貳家首席', '補助小獵人', '房號快遞員', 'Eroom整備員'];
  const ids = [];
  for (const name of names) ids.push((await call(db, 'POST', 'bots', { token, body: { name, task: '看房號', engine: 'claude', fb: ['opencode|qwen3:latest'] } })).data.id);
  const g = await call(db, 'POST', 'groups', { token, body: { name: '旅宿不貳家', task: '', members: ids } });
  assert.equal(g.status, 200, JSON.stringify(g.data));
  const rt = await runnerOf(db, token);
  assert.equal((await call(db, 'POST', 'messages', { token, body: { conv: g.data.id, text: '整理今天的入住名單' } })).status, 200);
  const first = await claimChat(db, rt);
  assert.equal(first.bot.id, ids[0]);
  assert.equal(first.group.mode, 'turns');
  assert.equal(await claimChat(db, rt), null);
  const repeated = Array.from({ length: 6 }, () => '需要使用者在電腦上登入（LINE 登入頁面）').join('\n') + '\n【派瀏覽】\n看登入頁\n【派瀏覽】\n看登入頁';
  assert.equal((await call(db, 'POST', 'runner/done', { token: rt, body: { id: first.id, ok: true, text: repeated } })).status, 200);
  assert.equal(await claimChat(db, rt), null);
  const once = await call(db, 'GET', 'messages', { token, query: { conv: g.data.id } });
  const said = once.data.msgs.filter(m => m.by === ids[0]).map(m => m.text);
  assert.deepEqual(said, ['需要使用者在電腦上登入（LINE 登入頁面）\n看登入頁']);
  assert.equal(once.data.msgs.filter(m => m.by === 'sys' && m.text.includes('需要你在電腦上登入')).length, 0);
  assert.equal((await call(db, 'POST', 'messages', { token, body: { conv: g.data.id, text: '我登入好了，繼續' } })).status, 200);
  const second = await claimChat(db, rt);
  assert.equal(second.bot.id, ids[0]);
  assert.equal((await call(db, 'POST', 'runner/done', { token: rt, body: { id: second.id, ok: true, text: '需要使用者在電腦上登入（https://manager.line.biz）' } })).status, 200);
  assert.equal(await claimChat(db, rt), null);
  const stopped = await call(db, 'GET', 'messages', { token, query: { conv: g.data.id } });
  const notices = stopped.data.msgs.filter(m => m.by === 'sys' && m.text.includes('需要你在電腦上登入'));
  assert.equal(notices.length, 1);
  assert.equal((await call(db, 'POST', 'messages', { token, body: { conv: g.data.id, text: '再試一次' } })).status, 200);
  const third = await claimChat(db, rt);
  assert.equal((await call(db, 'POST', 'runner/done', { token: rt, body: { id: third.id, ok: true, text: '需要使用者在電腦上登入（LINE 登入頁面）' } })).status, 200);
  const still = await call(db, 'GET', 'messages', { token, query: { conv: g.data.id } });
  assert.equal(still.data.msgs.filter(m => m.by === 'sys' && m.text.includes('需要你在電腦上登入')).length, 1);
});

test('an unfinished reply is continued once, then it stops', async () => {
  const db = openD1();
  const su = await call(db, 'POST', 'signup', { body: { name: 'cont', pw: 'correcthorsebattery' } });
  const token = su.data.token;
  const bot = await call(db, 'POST', 'bots', { token, body: { name: '房務', task: '掃房' } });
  const id = bot.data.id;
  const rt = await runnerOf(db, token);
  assert.equal((await call(db, 'POST', 'messages', { token, body: { conv: id, text: '整理今日入住' } })).status, 200);
  const first = await claimChat(db, rt);
  assert.equal((await call(db, 'POST', 'runner/done', { token: rt, body: { id: first.id, ok: true, text: '兩館還沒查完，先停在這裡。' } })).status, 200);
  const again = await claimChat(db, rt);
  assert.match(again.prompt, /^（自動接續 1）/);
  assert.match(again.prompt, /只寫一次「需要使用者在電腦上登入」/);
  assert.equal((await call(db, 'POST', 'runner/done', { token: rt, body: { id: again.id, ok: true, text: '還沒查完，下面還有。' } })).status, 200);
  assert.equal(await claimChat(db, rt), null);
  const msgs = await call(db, 'GET', 'messages', { token, query: { conv: id } });
  assert.equal(msgs.data.msgs.filter(m => m.by === 'sys' && m.text.includes('還沒做完')).length, 1);
});

function openD1From(raw) {
  const norm = a => a.map(v => (v === undefined ? null : typeof v === 'boolean' ? +v : v));
  class Stmt {
    constructor(sql) { this.sql = sql; this.args = []; }
    bind(...a) { this.args = norm(a); return this; }
    async first() { return raw.prepare(this.sql).get(...this.args) ?? null; }
    async all() { return { results: raw.prepare(this.sql).all(...this.args) }; }
    _run() {
      const info = raw.prepare(this.sql).run(...this.args);
      return { success: true, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
    }
    async run() { return this._run(); }
    _exec() { return /^\s*(SELECT|WITH)/i.test(this.sql) ? { results: raw.prepare(this.sql).all(...this.args), meta: {} } : { results: [], ...this._run() }; }
  }
  return { prepare: sql => new Stmt(sql), async batch(stmts) { raw.exec('BEGIN'); try { const out = stmts.map(s => s._exec()); raw.exec('COMMIT'); return out; } catch (e) { try { raw.exec('ROLLBACK'); } catch { /* */ } throw e; } }, exec: sql => raw.exec(sql) };
}
