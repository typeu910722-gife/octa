// 4.8: what the 4.7 field test found — a failed run shown as 完成, one turn answered twice, the queue nobody could
// read, cut-off previews and notifications that did not say what happened (the API side; the app side is in ui-48).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { firstSentence, gist, sameSaying } from '../desktop/api/reply-meta.mjs';

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
    _run() { const i = db.prepare(this.sql).run(...this.args); return { success: true, meta: { changes: Number(i.changes), last_row_id: Number(i.lastInsertRowid) } }; }
    async run() { return this._run(); }
    _exec() { return /^\s*(SELECT|WITH)/i.test(this.sql) ? { results: db.prepare(this.sql).all(...this.args), meta: {} } : { results: [], ...this._run() }; }
  }
  return {
    prepare: sql => new Stmt(sql),
    async batch(stmts) { db.exec('BEGIN'); try { const out = stmts.map(s => s._exec()); db.exec('COMMIT'); return out; } catch (e) { try { db.exec('ROLLBACK'); } catch { } throw e; } },
    raw: db
  };
}
async function call(db, method, path, body) {
  const url = new URL('http://octa.test/api/' + path.split('?')[0]);
  const q = path.split('?')[1]; if (q) url.search = q;
  const req = new Request(url, { method, headers: { 'content-type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(body || {}) });
  const res = await onRequest({ request: req, env: { DB: db, TZ_OFFSET_MIN: '480', isLocal: true }, params: { path: url.pathname.replace('/api/', '').split('/').filter(Boolean) } });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
async function setup(n = 1) {
  const db = openD1();
  await db.prepare("INSERT OR IGNORE INTO users (id,name,pw,created) VALUES ('local','本機','-',?)").bind(Date.now()).run();
  const bots = [];
  for (let i = 0; i < n; i++) bots.push((await call(db, 'POST', 'bots', { name: '房號快遞員' + (i || ''), task: '' })).data.id);
  const next = async () => (await call(db, 'POST', 'runner/next', { slots: 3, wait: false, max: 3 })).data.job;
  const msgs = async conv => (await call(db, 'GET', 'messages?conv=' + conv)).data.msgs;
  return { db, bot: bots[0], bots, next, msgs, row: id => db.raw.prepare('SELECT * FROM jobs WHERE id=?').get(id) };
}

test('the one line that says what happened: approval, result, first sentence; smart cut', () => {
  assert.equal(firstSentence('補助小獵人：Yzz，我看到 11/4 的名單有三筆新的。細節如下'), '補助小獵人：Yzz，我看到 11/4 的名單有三筆新的。');
  assert.equal(firstSentence('📌記住：老闆姓王\n**今天** 沒有新訂單。'), '今天 沒有新訂單。');
  const long = firstSentence('我先停手，你在旁邊的畫面登入或看完，按繼續我就重新讀頁再做，這樣比較不會錯過任何一筆資料喔', 30);
  assert.ok(long.length <= 31 && long.endsWith('…'), long);
  assert.equal(gist('好的\n✅待確認：寄出 11 月對帳單給王老闆', { approval: { what: '寄出 11 月對帳單給王老闆' } }), '要你核准：寄出 11 月對帳單給王老闆');
  assert.equal(gist('細節很長…', { result: { ok: false, text: '後台登入過期，名單沒抓到' } }), '沒做成：後台登入過期，名單沒抓到');
  assert.equal(gist('今天沒有新訂單。其他照舊。', null), '今天沒有新訂單。');
  assert.ok(sameSaying('⚠ 沒做成：後台要先登入，我沒辦法讀到房號。', '後台要先登入，所以我沒辦法讀到房號'));
  assert.ok(!sameSaying('後台要先登入。', '已寄出 3 封入住通知給今天的房客。'));
});

test('a reply that says ⚠ 沒做成 is a conclusion: no automatic second run, one message, 未完成 on the job', async () => {
  const t = await setup();
  await call(t.db, 'POST', 'messages', { conv: t.bot, text: '把今天的房號傳給房客' });
  const j = await t.next();
  await call(t.db, 'POST', 'runner/done', { id: j.id, ok: true, text: '後台要先登入，我無法完成房號查詢。\n⚠ 沒做成：後台要先登入，無法完成房號查詢' });
  const pending = t.db.raw.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status='pending'").get().n;
  assert.equal(pending, 0, 'no 自動接續 round after a stated outcome');
  const bot = (await t.msgs(t.bot)).filter(m => m.by === t.bot);
  assert.equal(bot.length, 1);
  assert.equal(bot[0].meta.result.ok, false);
  assert.ok(t.row(j.id).err_kind, 'the job is marked as not done (err_kind)');
  const st = (await call(t.db, 'GET', 'state')).data;
  assert.equal(st.lastJob[t.bot].ok, false);
  const last = st.last.find(x => x.conv === t.bot);
  assert.equal(last.rok, 0);
  assert.match(last.rtext, /後台要先登入/);
});

test('one message per turn: a follow-up run of the same instruction rewrites the reply instead of posting again', async () => {
  const t = await setup();
  await call(t.db, 'POST', 'messages', { conv: t.bot, text: '整理今天的入住名單' });
  const j = await t.next();
  // "還沒…完成" without a result line: one automatic follow-up round is queued (as before)
  await call(t.db, 'POST', 'runner/done', { id: j.id, ok: true, text: '名單還沒整理完成，先供參考：王先生 201。' });
  const before = (await t.msgs(t.bot)).filter(m => m.by === t.bot);
  assert.equal(before.length, 1);
  const t0 = Date.now() - 1;
  const j2 = await t.next();
  assert.match(j2.prompt, /自動接續 1/);
  await call(t.db, 'POST', 'runner/done', { id: j2.id, ok: true, text: '名單整理好了：王先生 201、林小姐 305。\n✅ 完成：入住名單 2 筆' });
  const after = (await t.msgs(t.bot)).filter(m => m.by === t.bot);
  assert.equal(after.length, 1, 'still one reply');
  assert.match(after[0].text, /林小姐 305/);
  assert.equal(after[0].meta.result.ok, true);
  const since = (await call(t.db, 'GET', `messages?conv=${t.bot}&after=${after[0].id}&since=${t0}`)).data;
  assert.equal(since.msgs.filter(m => m.by === t.bot).length, 0);
  assert.equal(since.changed.length, 1, 'the app learns the reply changed');
  assert.ok(since.now > 0);
  // the same thing said again replaces it (no doubled text)
  await call(t.db, 'POST', 'messages', { conv: t.bot, text: '把名單傳到群組' });
  const j3 = await t.next();
  await call(t.db, 'POST', 'runner/done', { id: j3.id, ok: false, text: '⚠ LINE 後台要先登入，名單沒傳出去。' });
  t.db.raw.prepare('INSERT INTO jobs (user_id,conv,bot_id,chain,prompt,created,retry_of) VALUES (?,?,?,?,?,?,?)').run('local', t.bot, t.bot, '[]', '把名單傳到群組', Date.now(), j3.id);
  // the failed run went to the work panel; the retry's answer is the one reply
  const j4 = await t.next();
  await call(t.db, 'POST', 'runner/done', { id: j4.id, ok: true, text: 'LINE 後台要先登入，名單沒傳出去。\n⚠ 沒做成：LINE 後台要先登入' });
  const j5 = t.db.raw.prepare('INSERT INTO jobs (user_id,conv,bot_id,chain,prompt,created,retry_of) VALUES (?,?,?,?,?,?,?)').run('local', t.bot, t.bot, '[]', '把名單傳到群組', Date.now(), j4.id).lastInsertRowid;
  const r5 = await t.next();
  assert.equal(r5.id, Number(j5));
  await call(t.db, 'POST', 'runner/done', { id: r5.id, ok: true, text: 'LINE 後台還是要先登入，名單沒傳出去。\n⚠ 沒做成：LINE 後台要先登入' });
  const chat = (await t.msgs(t.bot)).filter(m => m.by === t.bot && !m.kind);
  assert.equal(chat.length, 2, 'one reply for each of your two instructions');
  assert.doesNotMatch(chat[1].text, /名單沒傳出去。\s*\n\s*\nLINE/, 'the repeat replaced the earlier answer');
});

test('接手 stops the run to wait for you: not 完成 in the work panel', async () => {
  const t = await setup();
  await call(t.db, 'POST', 'messages', { conv: t.bot, text: '看吧' });
  const j = await t.next();
  await call(t.db, 'POST', 'runner/done', { id: j.id, ok: true, handed: true, text: '我先停手。你在旁邊的畫面登入或看完，按繼續我就重新讀頁再做。' });
  assert.equal(t.row(j.id).err_kind, 'handed');
  const logs = (await call(t.db, 'GET', 'logs?conv=' + t.bot)).data.logs;
  assert.equal(logs[0].err_kind, 'handed');
  assert.equal(t.db.raw.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status='pending'").get().n, 0);
});

test('the queue: no 先排隊 note in the chat; position data, 插隊 moves a job to the front; how long runs take', async () => {
  const t = await setup(5);
  for (const b of t.bots.slice(0, 3)) t.db.raw.prepare("INSERT INTO jobs (user_id,conv,bot_id,chain,prompt,status,created,started,kind) VALUES ('local',?,?,'[]','做','running',?,?,'chat')").run(b, b, Date.now() - 60000, Date.now() - 60000);
  // finished runs: 2 and 4 minutes
  t.db.raw.prepare("INSERT INTO jobs (user_id,conv,bot_id,chain,prompt,status,created,started,finished,kind) VALUES ('local',?,?,'[]','舊','done',?,?,?,'chat')").run(t.bot, t.bot, Date.now() - 9e5, Date.now() - 9e5, Date.now() - 9e5 + 120000);
  t.db.raw.prepare("INSERT INTO jobs (user_id,conv,bot_id,chain,prompt,status,created,started,finished,kind) VALUES ('local',?,?,'[]','舊','done',?,?,?,'chat')").run(t.bot, t.bot, Date.now() - 8e5, Date.now() - 8e5, Date.now() - 8e5 + 240000);
  await call(t.db, 'POST', 'messages', { conv: t.bots[3], text: '也做' });
  await call(t.db, 'POST', 'messages', { conv: t.bots[4], text: '這個比較急' });
  const ms = await t.msgs(t.bots[4]);
  assert.ok(!ms.some(m => /先排隊/.test(m.text)), 'no queue note in the conversation');
  const st = (await call(t.db, 'GET', 'state')).data;
  assert.equal(st.queue.avg, 180000);
  assert.equal(st.queue.slots, 3);
  const q = st.busy.filter(x => x.status === 'pending');
  assert.equal(q.length, 2);
  assert.ok('prio' in q[0]);
  const urgent = q.find(x => x.conv === t.bots[4]);
  assert.equal((await call(t.db, 'POST', `job/${urgent.job}/bump`)).status, 200);
  t.db.raw.prepare("UPDATE jobs SET status='done', finished=? WHERE status='running'").run(Date.now());
  const first = await t.next();
  assert.equal(first.id, urgent.job, '插隊 goes first');
  assert.equal((await call(t.db, 'POST', `job/${urgent.job}/bump`)).status, 404, 'only a queued job can 插隊');
  const busy = (await call(t.db, 'GET', 'busy')).data;
  assert.equal(busy.queue.slots, 3);
});

test('the run reports how much of the 5-hour window it used; the work panel record gets it with tokens', async () => {
  const t = await setup();
  await call(t.db, 'POST', 'messages', { conv: t.bot, text: '整理' });
  const j = await t.next();
  await call(t.db, 'POST', 'runner/done', { id: j.id, ok: true, tokens: 12345, quse: { eng: 'claude', k: '5h', before: 40, after: 42 }, text: '好了。\n✅ 完成：整理好了' });
  const log = (await call(t.db, 'GET', 'logs?conv=' + t.bot)).data.logs[0];
  assert.equal(log.tokens, 12345);
  assert.deepEqual(log.quse, { eng: 'claude', k: '5h', before: 40, after: 42 });
});

test('notifications start with what happened', async () => {
  const t = await setup();
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u, o) => { sent.push(JSON.parse(o.body).text); return new Response('{}'); };
  try {
    t.db.raw.prepare("UPDATE users SET settings=? WHERE id='local'").run(JSON.stringify({ tg: { token: '1:x', chat: '5' } }));
    await call(t.db, 'POST', 'messages', { conv: t.bot, text: '寄對帳單' });
    const j = await t.next();
    await call(t.db, 'POST', 'runner/done', { id: j.id, ok: true, text: '對帳單擬好了。\n✅待確認：寄出 11 月對帳單給王老闆\n對象：王老闆\n內容：附件是 11 月對帳單' });
    assert.ok(sent.some(x => /^【OCTA】房號快遞員 需要你處理：要你核准：寄出 11 月對帳單給王老闆/.test(x)), sent.join('\n---\n'));
  } finally { globalThis.fetch = realFetch; }
});

test('migrations: messages.upd, jobs.prio and jobs.quse in both lists and schema.sql', () => {
  const server = readFileSync(join(import.meta.dirname, '..', 'desktop', 'server.mjs'), 'utf8');
  const db = readFileSync(join(import.meta.dirname, '..', 'desktop', 'api', 'db.mjs'), 'utf8');
  for (const sql of ['ALTER TABLE messages ADD COLUMN upd INTEGER', 'ALTER TABLE jobs ADD COLUMN prio INTEGER', 'ALTER TABLE jobs ADD COLUMN quse TEXT']) {
    assert.ok(server.includes(sql), 'server.mjs ' + sql);
    assert.ok(db.includes(sql), 'db.mjs ' + sql);
  }
  assert.match(schema, /upd INTEGER/);
  assert.match(schema, /prio INTEGER/);
  assert.match(schema, /quse TEXT/);
});
