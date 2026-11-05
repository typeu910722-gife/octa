// 4.11 全力模式: no caps, run until done (continuation, loop guard), quota pause and auto-resume, AI 待機 without a time
// limit (LRU cap), 不限 job time with a heartbeat check, routines that leave quota room, the settings switch.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';


const apiUrl = pathToFileURL(join(import.meta.dirname, '..', 'desktop', 'api', 'index.mjs')).href;
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


import { runUntilDone, needsMore, mergeReplies, contPrompt, buildPrompt, FULL_RULE, browseRules, historyCaps, warmCap, sessions, staleSession, CONT_GUARD, stuckText } from '../desktop/runner/index.mjs';
const { quotaResumeAt } = await import(pathToFileURL(join(import.meta.dirname, '..', 'desktop', 'api', 'runner-done.mjs')).href);
const { routineQuotaTight } = await import(pathToFileURL(join(import.meta.dirname, '..', 'desktop', 'api', 'jobs.mjs')).href);
const { decideRoute } = await import(pathToFileURL(join(import.meta.dirname, '..', 'desktop', 'lib', 'model-route.mjs')).href);

// ---------- runner: run until done ----------
// a fake AI: each round does what the script says (tool calls, then its reply)
function fakeJob(extra = {}) { return { full: true, prompt: '建立 3 個檔案再驗證', toolCount: 0, toolSigs: new Set(), steps: { steps: null, step: 0 }, ...extra }; }
function scripted(job, rounds) {
  const prompts = [];
  return { prompts, turn: async (p, n) => {
    prompts.push(p);
    const r = rounds[n - 1];
    for (const sig of r.tools || []) { job.toolCount++; job.toolSigs.add(sig); }
    return { ok: r.ok !== false, text: r.text, tokens: 100 };
  } };
}

test('全力模式: a turn without a result goes on in the same session until ✅ 完成', async () => {
  const job = fakeJob();
  job.toolCount = 2; job.toolSigs = new Set(['Write:a', 'Write:b']);
  const ai = scripted(job, [
    { tools: ['Write:c'], text: '已建立 a、b、c，接下來驗證內容。' },
    { tools: ['Read:a', 'Read:b', 'Read:c'], text: '三個檔案都建立好了，內容都對過：a=1、b=4、c=9。\n✅ 完成：建立並驗證 3 個檔案' }
  ]);
  const res = await runUntilDone(job, { ok: true, text: '已建立 a、b，還沒建 c。', tokens: 50 }, { turn: ai.turn });
  assert.equal(res.rounds, 2);
  assert.match(res.text, /✅ 完成：建立並驗證 3 個檔案/);
  assert.match(res.text, /a=1、b=4、c=9/, 'the final reply covers the whole job');
  assert.equal(res.tokens, 250);
  assert.match(ai.prompts[0], /繼續做，直到完成或確定做不出來/);
  assert.match(ai.prompts[0], /原本的指示：建立 3 個檔案再驗證/);
  assert.match(ai.prompts[0], /還沒建 c/, 'the nudge says where it stopped');
});

test('全力模式: answers, conclusions, approvals, questions and sign-ins are not continued', async () => {
  const job = fakeJob();
  assert.equal(needsMore(job, '台北今天 25 度。'), false, 'an answer with no tools used is not work');
  job.toolCount = 3;
  for (const t of ['✅ 完成：寄出', '⚠ 沒做成：找不到檔案', '✅待確認：寄信給王小明', '❓問你：要寄給哪一位？', '需要使用者在電腦上登入（LINE）', '（略過）', '📋計畫\n1. a\n✅待確認：照計畫執行：x'])
    assert.equal(needsMore(job, t), false, t);
  assert.equal(needsMore(job, '已讀完第一頁，接下來讀第二頁。'), true);
  assert.equal(needsMore({ ...job, full: false }, '已讀完第一頁，接下來讀第二頁。'), false, '省額度: the runner does not loop');
  assert.equal(needsMore({ ...job, side: { doing: 'x' } }, '還沒做完'), false, '旁聊 never loops');
  assert.equal(needsMore({ ...fakeJob(), steps: { steps: ['a', 'b', 'c'], step: 1 } }, '第一步做完了'), true, 'a plan with steps left');
});

test('全力模式: the loop guard calls it stuck after CONT_GUARD rounds with no new action', async () => {
  const job = fakeJob({ toolCount: 1, toolSigs: new Set(['Read:x']) });
  const rounds = Array.from({ length: 10 }, (_, i) => ({ tools: ['Read:x'], text: `我再看一次檔案，接下來繼續處理（第 ${i} 次）。` }));
  const ai = scripted(job, rounds);
  const res = await runUntilDone(job, { ok: true, text: '正在處理。' }, { turn: ai.turn });
  assert.equal(res.rounds, CONT_GUARD);
  assert.ok(res.stuck);
  assert.match(res.text, /⚠ 沒做成：自動接續了 4 輪都沒有新的進展/);
  assert.equal(needsMore(job, res.text), false, 'the stuck line ends it');
});

test('全力模式: new actions reset the guard; a failure keeps what was done; 停止 ends the loop', async () => {
  const job = fakeJob({ toolCount: 1, toolSigs: new Set() });
  const rounds = Array.from({ length: 7 }, (_, i) => ({ tools: [`Write:f${i}`], text: `寫好 f${i}，接下來寫下一個。` }));
  rounds.push({ text: '✅ 完成：8 個檔案' });
  const res = await runUntilDone(job, { ok: true, text: '開始寫，接下來寫 f0。' }, { turn: scripted(job, rounds).turn });
  assert.equal(res.rounds, 8, 'seven rounds with new files are progress, not a loop');
  assert.ok(!res.stuck);
  const j2 = fakeJob({ toolCount: 1 });
  const fail = await runUntilDone(j2, { ok: true, text: '做到第 2 項，接下來第 3 項。' }, { turn: async () => ({ ok: false, text: '⚠ Claude AI usage limit reached|1999999999' }) });
  assert.equal(fail.ok, false);
  assert.match(fail.prevText, /做到第 2 項/);
  let asked = 0;
  const stop = await runUntilDone(fakeJob({ toolCount: 1 }), { ok: true, text: '接下來做第 2 項。' }, { turn: async () => { asked++; return { ok: true, text: 'x' }; }, canGo: async () => false });
  assert.equal(asked, 0); assert.equal(stop.rounds, 0);
});

test('mergeReplies: a bare result line keeps the earlier text; markers from earlier rounds are kept', () => {
  assert.equal(mergeReplies('三個檔案內容：a=1 b=4 c=9', '✅ 完成：已驗證'), '三個檔案內容：a=1 b=4 c=9\n\n✅ 完成：已驗證');
  const m = mergeReplies('建立好了 a。\n📌記住：檔案放在輸出資料夾', '全部建立並驗證。\n細節…\n✅ 完成：3 個檔案');
  assert.match(m, /^全部建立並驗證/);
  assert.match(m, /📌記住：檔案放在輸出資料夾/);
  assert.match(contPrompt(fakeJob({ steps: { steps: ['建檔', '驗證'], step: 1 } }), 'x', 3), /第 3 輪[\s\S]*1\.建檔 2\.驗證（目前第 1 步）/);
});

// ---------- runner: prompts ----------
const pjob = extra => ({ id: 1, kind: 'chat', prompt: '整理全部訂單', bot: { id: 'b1', name: '甲', task: '', engine: 'opencode' }, browse: 'relay', history: Array.from({ length: 50 }, (_, i) => ({ id: i, who: i % 2 ? '甲' : '使用者', text: `第${i}則 ` + '很長的內容。'.repeat(400), files: [] })), memory: [], facts: [], manuals: [], lang: 'zh-TW', ...extra });
test('全力模式 prompt: no time budget, no 「最多派兩次」, longer history; 省額度 unchanged', () => {
  const full = buildPrompt({ ...pjob({ full: true }), bot: { id: 'b1', name: '甲', task: '', engine: 'claude' }, browse: 'direct' }, '/tmp/x');
  assert.ok(full.includes(FULL_RULE));
  assert.match(full, /花多久都沒關係/);
  assert.match(full, /密碼不進對話/, 'safety rules stay');
  assert.match(full, /✅待確認/);
  const save = buildPrompt({ ...pjob({}), bot: { id: 'b1', name: '甲', task: '', engine: 'claude' }, browse: 'direct' }, '/tmp/x');
  assert.ok(!save.includes(FULL_RULE));
  assert.ok(full.length > save.length * 2, `full ${full.length} vs economical ${save.length}`);
  assert.match(browseRules(pjob({})).join('\n'), /最多派兩次/);
  assert.ok(!browseRules(pjob({ full: true })).join('\n').includes('最多派兩次'));
  assert.deepEqual(historyCaps({ group: {} }), [14, 300, 1500]);
  assert.deepEqual(historyCaps({ group: {}, full: true }), [40, 1500, 6000]);
  // 做完告知 + 全力: a big job starts right away; only irreversible actions wait for a plan approval
  assert.match(full, /先單獨一行寫「🧭步驟：…」就直接開始做，不用等核准/);
});

// ---------- runner: AI 待機 ----------
test('AI 待機 in 全力模式: no idle time limit, a sleep restarts it, and at most WARM_MAX sessions (least recently used goes)', () => {
  const closed = [];
  const fake = (id, usedAt, busy) => sessions.set(id, { usedAt, turn: busy ? {} : null, timer: null, child: { pid: 0, stdin: { end: () => closed.push(id) }, kill() { } } });
  sessions.clear();
  for (let i = 0; i < 6; i++) fake('b' + i, 1000 + i, i === 0);
  warmCap('new', 64 * 1024 ** 3);
  assert.deepEqual(closed, ['b1'], 'the oldest idle session goes (b0 is working)');
  assert.equal(sessions.size, 5);
  warmCap('new2', 512 * 1024 ** 2);   // short of memory: only 3
  assert.equal(sessions.size, 2);
  sessions.clear();
  const old = { doneAt: Date.now() - 5 * 3600000, turn: null };
  assert.equal(staleSession(old, { full: true }), false, '全力: five idle hours are fine');
  assert.equal(staleSession(old, { full: false }), true, '省額度: 20 minutes');
  assert.equal(staleSession({ ...old, slept: true, doneAt: Date.now() }, { full: true }), true, 'after a sleep it starts fresh');
});

// ---------- API ----------
test('全力模式 is the default: 不限 time, always standby; 關 restores 60 minutes and 120 s; per bot override', async () => {
  const t = await setup();
  const a = await t.bot('全力'), b = await t.bot('省錢');
  let s = (await call(t.db, 'GET', 'settings', { token: t.token })).data;
  assert.deepEqual([s.full, s.jobMax, s.warm], [true, 0, -1]);
  await call(t.db, 'PUT', 'settings', { token: t.token, body: { power: { bot: b, mode: 'save' } } });
  await t.say(a, '整理資料'); await t.say(b, '整理資料');
  const ja = await t.next(), jb = await t.next();
  const [x, y] = ja.bot.id === a ? [ja, jb] : [jb, ja];
  assert.deepEqual([x.full, x.maxMin, x.warm], [true, 0, -1]);
  assert.deepEqual([y.full, y.maxMin, y.warm], [false, 60, 120], 'a bot set to 省額度');
  await call(t.db, 'PUT', 'settings', { token: t.token, body: { full: false } });
  s = (await call(t.db, 'GET', 'settings', { token: t.token })).data;
  assert.deepEqual([s.full, s.jobMax, s.warm], [false, 60, 120]);
  await call(t.db, 'PUT', 'settings', { token: t.token, body: { jobMax: 0 } });
  assert.equal((await call(t.db, 'GET', 'settings', { token: t.token })).data.jobMax, 60, '不限 only in 全力模式');
  await call(t.db, 'PUT', 'settings', { token: t.token, body: { full: true, power: { bot: b, mode: null } } });
  s = (await call(t.db, 'GET', 'settings', { token: t.token })).data;
  assert.deepEqual([s.full, s.jobMax, s.warm, s.power[b]], [true, 0, -1, undefined]);
  await call(t.db, 'PUT', 'settings', { token: t.token, body: { warm: 300, jobMax: 120 } });
  s = (await call(t.db, 'GET', 'settings', { token: t.token })).data;
  assert.deepEqual([s.jobMax, s.warm], [120, 300], 'the user can still choose');
});

test('不限: a job that keeps reporting runs for hours; 20 silent minutes are checked with the runner, not killed blindly', async () => {
  const t = await setup();
  const a = await t.bot('長工');
  await t.say(a, '讀兩館所有 LINE 對話');
  const j = await t.next();
  assert.equal(j.maxMin, 0);
  t.db.raw.prepare('UPDATE jobs SET started=?, beat=? WHERE id=?').run(Date.now() - 5 * 3600000, Date.now(), j.id);
  await t.next();
  assert.equal(t.db.raw.prepare('SELECT status FROM jobs WHERE id=?').get(j.id).status, 'running', 'five hours, still reporting');
  t.db.raw.prepare('UPDATE jobs SET beat=? WHERE id=?').run(Date.now() - 25 * 60000, j.id);
  await call(t.db, 'POST', 'runner/next', { token: t.rt, body: { slots: 3, wait: false, running: [j.id] } });
  const row = t.db.raw.prepare('SELECT status, beat FROM jobs WHERE id=?').get(j.id);
  assert.equal(row.status, 'running', 'the runner still holds it');
  assert.ok(row.beat > Date.now() - 60000, 'and its heartbeat is refreshed');
  t.db.raw.prepare('UPDATE jobs SET beat=? WHERE id=?').run(Date.now() - 25 * 60000, j.id);
  await t.next();   // the runner no longer lists it: lost
  const r2 = t.db.raw.prepare('SELECT status, err_msg FROM jobs WHERE id=?').get(j.id);
  assert.equal(r2.status, 'error');
  assert.match(r2.err_msg, /20 分鐘沒有任何回報/);
  assert.ok(t.pending().some(p => p.retry_of === j.id), 'and it continues from what is done');
});

test('額度用完 in 全力模式: the job waits for the reset, says when, and goes on by itself', async () => {
  const t = await setup();
  const a = await t.bot('寫手');
  await t.say(a, '把 20 份報告整理成一份');
  const j = await t.next();
  const reset = Math.floor(Date.now() / 1000) + 2 * 3600;
  await t.done(j.id, `⚠ Claude AI usage limit reached|${reset}`, false);
  const w = t.pending().find(p => p.retry_of === j.id);
  assert.ok(w, 'the same work is queued again');
  assert.ok(Math.abs(w.after - (reset * 1000 + 60000)) < 1000, 'until the window resets');
  assert.match(w.prompt, /（額度恢復後自動繼續）/);
  const sys = (await t.msgs(a)).filter(m => m.by === 'sys' || m.by_ === 'sys').map(m => m.text).join('\n');
  assert.match(sys, /額度用完，(\d+\/\d+ )?\d\d:\d\d 自動繼續/);
  assert.equal(await t.next(), null, 'not before the reset');
  t.db.raw.prepare('UPDATE jobs SET after=? WHERE id=?').run(Date.now() - 1000, w.id);
  const again = await t.next();
  assert.equal(again?.id, w.id, 'due now: it runs');
  assert.equal(t.db.raw.prepare('SELECT after FROM jobs WHERE id=?').get(w.id).after, null);
  // 省額度: the old behaviour (stop and say so)
  await call(t.db, 'PUT', 'settings', { token: t.token, body: { full: false } });
  await t.done(again.id, '⚠ Claude AI usage limit reached|' + reset, false);
  assert.ok(!t.pending().some(p => p.retry_of === again.id));
});

test('quotaResumeAt reads the CLI words, then the quota report, else an hour', () => {
  const t0 = Date.parse('2026-11-05T10:00:00');
  assert.equal(quotaResumeAt('Claude AI usage limit reached|1999999999', null, t0), 1999999999000 + 60000);
  const pm = new Date(quotaResumeAt("5-hour limit reached ∙ resets 3pm", null, t0));
  assert.deepEqual([pm.getHours(), pm.getMinutes()], [15, 1]);
  const am = new Date(quotaResumeAt('You have hit your limit · resets 2am', null, t0));
  assert.equal(am.getDate(), new Date(t0).getDate() + 1, 'a time already past is tomorrow');
  const u = { windows: [{ k: '5h', used: 100, reset: new Date(t0 + 3 * 3600000).toISOString() }] };
  assert.equal(quotaResumeAt('usage limit', u, t0), t0 + 3 * 3600000 + 60000);
  assert.equal(quotaResumeAt('usage limit', null, t0), t0 + 3600000);
});

test('routines leave room for your own work: at 90% of a window they wait for its reset (once, not piled up)', async () => {
  assert.equal(routineQuotaTight({ windows: [{ k: '5h', used: 89 }] }), null);
  assert.equal(routineQuotaTight(null), null, 'no report: not throttled');
  const t = await setup();
  const a = await t.bot('巡查');
  const reset = new Date(Date.now() + 2 * 3600000).toISOString();
  await call(t.db, 'POST', 'runner/next', { token: t.rt, body: { slots: 0, wait: false, usage: { claude: { windows: [{ k: '5h', used: 93, reset }, { k: '7d', used: 40 }] } } } });
  t.db.raw.prepare("INSERT INTO routines (id,user_id,conv,name,prompt,times,enabled,created) VALUES ('r1','local',?,'巡訊息','看新訊息','[\"*/30\"]',1,?)").run(a, Date.now());
  const add = () => t.db.raw.prepare("INSERT INTO jobs (user_id,conv,bot_id,chain,prompt,created,depth,routine,kind) VALUES ('local',?,?,'[]','（例行任務「巡訊息」）看新訊息',?,0,'r1','chat')").run(a, a, Date.now());
  add();
  assert.equal(await t.next(), null, 'put off');
  const rows = t.pending();
  assert.equal(rows.length, 1);
  assert.ok(Math.abs(rows[0].after - (Date.parse(reset) + 60000)) < 1000);
  add();
  assert.equal(await t.next(), null);
  assert.equal(t.pending().length, 1, 'the next firing does not pile up');
  await t.say(a, '幫我查一下');
  assert.equal((await t.next())?.prompt, '幫我查一下', 'your own messages are not held back');
});

test('全力模式 retries transient failures beyond two, with a growing pause; a sign-in is never hammered', async () => {
  const route = decideRoute({ kind: 'transient', tries: 4, chain: [{ id: 'claude' }], maxTransient: 8 });
  assert.equal(route.action, 'retry');
  assert.equal(decideRoute({ kind: 'transient', tries: 2, chain: [{ id: 'claude' }] }).action, 'stop', '省額度 keeps two');
  const t = await setup();
  const a = await t.bot('查詢');
  await t.say(a, '查今天的訂單');
  let j = await t.next();
  for (let i = 1; i <= 4; i++) {
    await call(t.db, 'POST', 'runner/done', { token: t.rt, body: { id: j.id, ok: false, stalled: true, err_kind: 'timeout', text: '⚠ AI 很久沒有回應，已中止' } });
    const nx = t.pending().find(p => p.retry_of === j.id);
    assert.ok(nx, `retry ${i}`);
    assert.equal(nx.tries, i);
    if (i > 2) assert.ok(nx.after > Date.now(), `retry ${i} waits a while`);
    t.db.raw.prepare('UPDATE jobs SET after=NULL WHERE id=?').run(nx.id);
    j = await t.next();
  }
  await t.done(j.id, '⚠ 需要使用者在電腦上登入（LINE）', false);
  assert.ok(!t.pending().some(p => p.retry_of === j.id), 'a sign-in waits for you');
});
