// 4.16 客服模式: the computer looks at a chat page every few seconds without the AI; new lines give the bot a job,
// its own reply is not a new message, it ends when the time is up, and the bot can start / end it from chat (🎧).
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

const RS = await import(pathToFileURL(join(import.meta.dirname, '..', 'desktop', 'runner', 'service.mjs')).href);

async function setup() {
  const db = openD1();
  const token = (await call(db, 'POST', 'signup')).data.token;
  const bot = (await call(db, 'POST', 'bots', { token, body: { name: '貳宿客服', task: '' } })).data.id;
  const jobs = () => db.raw.prepare("SELECT id,prompt,status FROM jobs WHERE bot_id=? AND status IN ('pending','running') ORDER BY id").all(bot);
  const msgs = async () => (await call(db, 'GET', 'messages', { token, query: { conv: bot } })).data.msgs;
  const seen = text => call(db, 'POST', 'runner/svc/seen', { token, body: { bot, hash: String(text.length) + text.slice(-20), text } });
  return { db, token, bot, jobs, msgs, seen };
}

test('start, look, a new message → one job; its own reply is not a new message; stop', async () => {
  const x = await setup();
  assert.equal((await call(x.db, 'POST', `svc/${x.bot}`, { token: x.token, body: { url: 'chat.line.biz/U1/chat', sec: 10, minutes: 60, rules: '要退款先問我' } })).status, 200);
  const st = (await call(x.db, 'GET', 'state', { token: x.token })).data.svc[x.bot];
  assert.equal(st.url, 'https://chat.line.biz/U1/chat'); assert.equal(st.sec, 10); assert.ok(st.until > Date.now());
  assert.match((await x.msgs()).at(-1).text, /^🎧 客服模式開始：每 10 秒看一次 https:\/\/chat\.line\.biz\/U1\/chat，有新訊息就回覆，到 \d\d:\d\d。/);
  assert.deepEqual((await call(x.db, 'POST', 'runner/svc', { token: x.token })).data.svc, [{ bot: x.bot, url: 'https://chat.line.biz/U1/chat', sel: '', sec: 10 }]);
  const page1 = 'Yzz\n您好 我是貳宿文旅 AI 客服';
  assert.equal((await x.seen(page1)).data.changed, false, 'the first look only remembers the page');
  assert.equal((await x.seen(page1)).data.changed, false);
  assert.equal(x.jobs().length, 0, 'nothing new: no AI');
  const page2 = page1 + '\n請問 12/24 還有空房嗎';
  assert.equal((await x.seen(page2)).data.changed, true);
  const [j] = x.jobs();
  assert.ok(j.prompt.startsWith('〔客服模式〕'));
  assert.match(j.prompt, /請問 12\/24 還有空房嗎/); assert.doesNotMatch(j.prompt, /AI 客服/, 'only the new lines');
  assert.match(j.prompt, /要退款先問我/);
  // while it answers: no second job; afterwards the page with its reply becomes the baseline
  const page3 = page2 + '\n有的，12/24 還有雙人房';
  assert.equal((await x.seen(page3)).data.busy, true);
  assert.equal(x.jobs().length, 1);
  db_run(x, j.id);
  assert.equal((await call(x.db, 'POST', 'runner/done', { token: x.token, body: { id: j.id, ok: true, text: '回了 Yzz：12/24 還有雙人房' } })).status, 200);
  assert.equal((await x.seen(page3)).data.changed, false, 'its own reply');
  assert.equal(x.jobs().length, 0);
  assert.equal((await x.seen(page3 + '\n那我訂一間')).data.changed, true);
  assert.equal((await call(x.db, 'GET', 'state', { token: x.token })).data.svc[x.bot].replies, 1);
  assert.equal((await call(x.db, 'POST', `svc/${x.bot}/stop`, { token: x.token })).status, 200);
  assert.deepEqual((await call(x.db, 'GET', 'state', { token: x.token })).data.svc, {});
  assert.equal((await x.msgs()).at(-1).text, '🎧 客服模式已停止（回覆了 1 次）');
  assert.equal((await x.seen('anything')).data.stop, true);
});
function db_run(x, id) { x.db.raw.prepare("UPDATE jobs SET status='running', started=? WHERE id=?").run(Date.now(), id); }

test('it ends by itself when the time is up; a bad address is refused', async () => {
  const x = await setup();
  assert.equal((await call(x.db, 'POST', `svc/${x.bot}`, { token: x.token, body: { url: 'not a url at all', sec: 10, minutes: 30 } })).status, 400);
  await call(x.db, 'POST', `svc/${x.bot}`, { token: x.token, body: { url: 'https://chat.example.com/', sec: 5, minutes: 15 } });
  x.db.raw.prepare('UPDATE svc SET until=? WHERE bot_id=?').run(Date.now() - 1, x.bot);
  assert.deepEqual((await call(x.db, 'POST', 'runner/svc', { token: x.token })).data.svc, []);
  assert.equal((await x.msgs()).at(-1).text, '🎧 客服模式時間到，已結束（回覆了 0 次）');
});

test('from chat: 「每十秒看一次…直到我說測試結束」 → 🎧客服模式 starts it; 「測試結束」 → 🎧客服模式結束 ends it', async () => {
  const x = await setup();
  const j1 = Number(x.db.raw.prepare("INSERT INTO jobs (user_id,conv,bot_id,chain,prompt,created,status,kind,started) VALUES ('local',?,?,'[]','等等我會跟貳宿聊天，你每十秒看一次並回覆我，直到我說測試結束',?,'running','chat',?)").run(x.bot, x.bot, Date.now(), Date.now()).lastInsertRowid);
  await call(x.db, 'POST', 'runner/done', { token: x.token, body: { id: j1, ok: true, text: '好，開始顧客服了。\n🎧客服模式：https://chat.line.biz/U1/chat｜10｜不限｜回覆要有禮貌' } });
  const s = (await call(x.db, 'GET', 'state', { token: x.token })).data.svc[x.bot];
  assert.equal(s.sec, 10); assert.equal(s.until, null); assert.equal(s.rules, '回覆要有禮貌');
  const msgs = await x.msgs();
  assert.ok(msgs.some(m => m.by === x.bot && m.text === '好，開始顧客服了。'), 'the 🎧 line is not shown');
  const j2 = Number(x.db.raw.prepare("INSERT INTO jobs (user_id,conv,bot_id,chain,prompt,created,status,kind,started) VALUES ('local',?,?,'[]','測試結束',?,'running','chat',?)").run(x.bot, x.bot, Date.now(), Date.now()).lastInsertRowid);
  await call(x.db, 'POST', 'runner/done', { token: x.token, body: { id: j2, ok: true, text: '好的，停了。\n🎧客服模式結束' } });
  assert.deepEqual((await call(x.db, 'GET', 'state', { token: x.token })).data.svc, {});
});

test('the computer side: same chat page, clock times ignored; the app and the bot instructions', () => {
  assert.ok(RS.samePage('https://chat.line.biz/U1/chat/abc?x=1', 'https://chat.line.biz/U1/chat'));
  assert.ok(!RS.samePage('https://shopee.tw/chat', 'https://chat.line.biz/U1/chat'));
  assert.equal(RS.svcText('Yzz 下午2:41\n您好 14:40'), 'Yzz\n您好');
  const loop = readFileSync(join(import.meta.dirname, '..', 'desktop', 'runner', 'loop.mjs'), 'utf8');
  assert.match(loop, /setInterval\(\(\) => checkService\(\)\.catch\(\(\) => \{ \}\), 2000\)/);
  const prompts = readFileSync(join(import.meta.dirname, '..', 'desktop', 'runner', 'prompts.mjs'), 'utf8');
  assert.match(prompts, /🎧客服模式：聊天畫面的網址｜秒數｜分鐘數｜客服規則/);
  assert.match(scripts['service.js'], /api\('svc\/'\+id,'POST'/);
  assert.match(scripts['bots.js'], /dsec\('svc','客服模式'/);
  assert.match(scripts['panel.js'], /h\+=svcCard\(id\);/);
});

test('4.16.1 Webhook 當門鈴: a LINE message for a bot in 客服模式 starts no job of its own, only “look now”; wait and draft', async () => {
  const x = await setup();
  // a LINE webhook routine on the same bot
  const rt = await call(x.db, 'POST', 'routines', { token: x.token, body: { conv: x.bot, name: 'LINE 客服', prompt: '回覆 LINE 客人', trigger: 'hook' } });
  assert.equal(rt.status, 200, JSON.stringify(rt.data));
  const hook = x.db.raw.prepare('SELECT hook FROM routines WHERE id=?').get(rt.data.id).hook;
  const line = { events: [{ type: 'message', source: { userId: 'U9' }, message: { type: 'text', text: '請問還有空房嗎' } }] };
  // not in 客服模式: the webhook works as before (a job of its own)
  await call(x.db, 'POST', 'hook/' + hook, { body: line });
  assert.equal(x.jobs().length, 1);
  x.db.raw.prepare("DELETE FROM jobs WHERE bot_id=?").run(x.bot);
  await call(x.db, 'POST', `svc/${x.bot}`, { token: x.token, body: { url: 'https://chat.line.biz/U1/chat', sec: 30, minutes: 0, wait: 10, mode: 'draft' } });
  const page = 'Yzz\n您好';
  await x.seen(page);
  const r = await call(x.db, 'POST', 'hook/' + hook, { body: line });
  assert.equal(r.data.result, 'svc');
  assert.equal(x.jobs().length, 0, 'the webhook made no job of its own');
  const [w] = (await call(x.db, 'POST', 'runner/svc', { token: x.token })).data.svc;
  assert.ok(w.ring > 0, 'the computer is told to look now');
  // the chat shows it: one job, after 10 s, written as a draft
  assert.equal((await x.seen(page + '\n請問還有空房嗎')).data.changed, true);
  const j = x.db.raw.prepare("SELECT prompt, after FROM jobs WHERE bot_id=? AND status='pending'").get(x.bot);
  assert.ok(j.after > Date.now() + 8000, 'waits 10 s so a person or the auto-reply can go first');
  assert.match(j.prompt, /手動聊天/); assert.match(j.prompt, /不要在聊天畫面送出任何訊息/); assert.match(j.prompt, /✅待確認：回覆客人/);
  assert.equal((await call(x.db, 'POST', 'runner/svc', { token: x.token })).data.svc[0].ring, undefined, 'the bell is answered');
  const st = (await call(x.db, 'GET', 'state', { token: x.token })).data.svc[x.bot];
  assert.equal(st.mode, 'draft'); assert.equal(st.wait, 10);
  // a handover from another AI (not a chat message) still works as a job of its own
  await call(x.db, 'POST', 'hook/' + hook, { body: { from: 'Grok', task: '整理今天的訂房' } });
  assert.ok(x.db.raw.prepare("SELECT COUNT(*) AS n FROM jobs WHERE bot_id=? AND prompt LIKE '%整理今天的訂房%'").get(x.bot).n >= 1);
});
