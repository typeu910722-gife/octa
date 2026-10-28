// 排程與記憶: one place for schedule times, each routine with its own instruction, run status and next run,
// group routines reporting in the group, schedules the bot sets up itself, and corrections kept as rules.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { buildPrompt, buildLocalPrompt, memoryLines } from '../public/octa-runner.mjs';

const apiUrl = pathToFileURL(join(import.meta.dirname, '..', 'functions', 'api', '[[path]].js')).href;
const { onRequest, nextRun, scheduleAsk, correctionAsk, splitTaskSchedules, clockWords, routineTarget } = await import(apiUrl);
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

let ip = 10, n = 0;
async function call(db, method, path, { token, body, query } = {}) {
  const headers = { 'content-type': 'application/json', 'cf-connecting-ip': `203.0.113.${ip++ % 250}` };
  if (token) headers.authorization = 'Bearer ' + token;
  const url = new URL('http://octa.test/api/' + path);
  for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);
  const req = new Request(url, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(body || {}) });
  const res = await onRequest({ request: req, env: { DB: db, ALLOW_SIGNUP: 'true', TZ_OFFSET_MIN: '480', isLocal: false }, params: { path: path.split('/').filter(Boolean) } });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
async function setup() {
  const db = openD1();
  const su = await call(db, 'POST', 'signup', { body: { name: 'sch' + n++, pw: 'correcthorsebattery' } });
  const token = su.data.token;
  const rt = (await call(db, 'POST', 'runner-token', { token, body: { label: 'host' } })).data.token;
  const uidRow = db.raw.prepare('SELECT id FROM users').get();
  const bot = async (name, task = '') => (await call(db, 'POST', 'bots', { token, body: { name, task } })).data.id;
  const group = async (name, members, task = '') => (await call(db, 'POST', 'groups', { token, body: { name, task, members } })).data.id;
  const say = (conv, text) => call(db, 'POST', 'messages', { token, body: { conv, text } });
  const next = async () => (await call(db, 'POST', 'runner/next', { token: rt, body: { slots: 3, wait: false } })).data.job;
  const done = (id, text, ok = true) => call(db, 'POST', 'runner/done', { token: rt, body: { id, ok, text } });
  const msgs = async conv => (await call(db, 'GET', 'messages', { token, query: { conv } })).data.msgs;
  const state = async () => (await call(db, 'GET', 'state', { token })).data;
  const routine = (conv, name, times, prompt, fired = '{}') => {
    const id = 'r-' + Math.random().toString(36).slice(2);
    db.raw.prepare('INSERT INTO routines (id,user_id,conv,name,prompt,times,enabled,fired,created) VALUES (?,?,?,?,?,?,1,?,?)').run(id, uidRow.id, conv, name, prompt, JSON.stringify(times), fired, Date.now());
    return id;
  };
  const row = id => db.raw.prepare('SELECT * FROM routines WHERE id=?').get(id);
  const settings = () => JSON.parse(db.raw.prepare('SELECT settings FROM users').get().settings || '{}');
  // the API decides "today" in UTC+8; a time that is always already past today there
  const pastToday = () => { const h = new Date(Date.now() + 480 * 60000).toISOString().slice(11, 16); return h >= '00:01' ? '00:00' : null; };
  return { db, token, rt, bot, group, say, next, done, msgs, state, routine, row, settings, pastToday, uid: uidRow.id };
}

test('a routine needs its own instruction: create and edit are refused without one, turning off is not', async () => {
  const t = await setup();
  const b = await t.bot('房務');
  let r = await call(t.db, 'POST', 'routines', { token: t.token, body: { conv: b, name: '早報', times: ['08:00'], prompt: '  ' } });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /每次要做什麼/);
  r = await call(t.db, 'POST', 'routines', { token: t.token, body: { conv: b, name: '早報', times: ['08:00'], prompt: '整理今天入住名單，貼給我' } });
  assert.equal(r.status, 200);
  const id = r.data.id;
  r = await call(t.db, 'PUT', 'routines/' + id, { token: t.token, body: { name: '早報', prompt: '', times: ['09:00'] } });
  assert.equal(r.status, 400, 'an edit that empties the instruction is refused');
  // an old routine without an instruction can still be switched off, but not back on
  t.db.raw.prepare("UPDATE routines SET prompt='' WHERE id=?").run(id);
  assert.equal((await call(t.db, 'PUT', 'routines/' + id, { token: t.token, body: { enabled: false } })).status, 200);
  assert.equal((await call(t.db, 'PUT', 'routines/' + id, { token: t.token, body: { enabled: true } })).status, 400);
  assert.equal((await call(t.db, 'PUT', 'routines/' + id, { token: t.token, body: { enabled: true, prompt: '整理名單' } })).status, 200);
});

test('next_run: fixed times, every N minutes, past midnight, UTC+8', () => {
  const tz = 480, at = (y, mo, d, h, mi) => Date.UTC(y, mo - 1, d, h, mi) - tz * 60000;   // local time → ms
  const now = at(2026, 10, 28, 15, 0);
  assert.equal(nextRun(['15:30'], {}, true, now, tz), at(2026, 10, 28, 15, 30));
  assert.equal(nextRun(['08:00'], { '08:00': '2026-10-28' }, true, now, tz), at(2026, 10, 29, 8, 0), 'done today: tomorrow');
  assert.equal(nextRun(['08:00', '20:00'], { '08:00': '2026-10-28' }, true, now, tz), at(2026, 10, 28, 20, 0));
  assert.equal(nextRun(['08:00'], {}, true, now, tz), now, 'past and not run yet today: due now');
  assert.equal(nextRun(['*/30'], { '*/30': now - 10 * 60000 }, true, now, tz), now + 20 * 60000);
  assert.equal(nextRun(['*/30'], {}, true, now, tz), now);
  assert.equal(nextRun(['*/30', '15:10'], { '*/30': now - 5 * 60000 }, true, now, tz), at(2026, 10, 28, 15, 10));
  const late = at(2026, 10, 28, 23, 50);
  assert.equal(nextRun(['00:10'], { '00:10': '2026-10-28' }, true, late, tz), at(2026, 10, 29, 0, 10), 'over midnight');
  assert.equal(new Date(nextRun(['00:10'], { '00:10': '2026-10-28' }, true, late, tz)).toISOString(), '2026-10-28T16:10:00.000Z');
  assert.equal(nextRun(['08:00'], {}, false, now, tz), null);
  assert.equal(nextRun([], {}, true, now, tz), null);
});

test('state gives each routine last_run, last_status, last_job, last_text and next_run; done, error and skipped are recorded', async () => {
  const t = await setup();
  const b = await t.bot('房務');
  const past = t.pastToday();
  if (!past) return;   // the first minute of the day in UTC+8: nothing is past yet
  const id = t.routine(b, '早報', [past], '整理入住名單');
  let job = await t.next();
  assert.equal(job.routine.name, '早報');
  assert.equal(job.routine.own, true);
  assert.match(job.prompt, /^（例行任務「早報」）/);
  let r = t.row(id);
  assert.ok(r.last_run > Date.now() - 5000);
  assert.equal(r.last_status, null, 'running: no result yet');
  assert.equal(t.db.raw.prepare('SELECT routine FROM jobs WHERE id=?').get(job.id).routine, id);
  await t.done(job.id, '今天入住 3 間：201、202、305');
  r = t.row(id);
  assert.equal(r.last_status, 'done');
  assert.equal(r.last_job, job.id);
  assert.match(r.last_text, /入住 3 間/);
  let st = (await t.state()).routines.find(x => x.id === id);
  for (const k of ['last_run', 'last_status', 'last_job', 'last_text', 'next_run']) assert.ok(k in st, k);
  assert.equal(st.fired, undefined);
  assert.ok(st.next_run > Date.now(), 'already ran today: next is tomorrow');

  // a failure: recorded, and the chat says so with the next run
  t.db.raw.prepare("UPDATE routines SET fired='{}' WHERE id=?").run(id);
  job = await t.next();
  let tries = 0;
  for (; job && tries < 5; tries++) {   // automatic retries keep the routine id and leave the status open until the last one
    await t.done(job.id, '⚠ 頁面打不開', false);
    job = await t.next();
    if (job) { assert.equal(t.row(id).last_status, null); assert.equal(t.db.raw.prepare('SELECT routine FROM jobs WHERE id=?').get(job.id).routine, id); }
  }
  assert.ok(tries >= 2, 'it was retried');
  r = t.row(id);
  assert.equal(r.last_status, 'error');
  const ms = await t.msgs(b);
  assert.ok(ms.some(m => m.by === 'sys' && /例行任務「早報」這次沒有完成/.test(m.text) && /下次/.test(m.text)), JSON.stringify(ms.slice(-3)));

  // nothing to report
  t.db.raw.prepare("UPDATE routines SET fired='{}' WHERE id=?").run(id);
  job = await t.next();
  await t.done(job.id, '（略過）');
  assert.equal(t.row(id).last_status, 'skipped');
  st = (await t.state()).routines.find(x => x.id === id);
  assert.equal(st.last_status, 'skipped');
});

test('missed times while the host was off are named in the chat', async () => {
  const t = await setup();
  const b = await t.bot('房務');
  const local = new Date(Date.now() + 480 * 60000).toISOString().slice(11, 16);
  if (local < '00:30') return;
  t.routine(b, '早報', ['00:00', '00:05'], '整理名單');
  const job = await t.next();
  assert.match(job.prompt, /補做/);
  const ms = await t.msgs(b);
  assert.ok(ms.some(m => m.by === 'sys' && /補做錯過的例行任務「早報」（00:00、00:05）/.test(m.text)), JSON.stringify(ms));
});

test('a group routine posts in the group; a bot routine that says to report in its group runs there too', async () => {
  const t = await setup();
  const a = await t.bot('甲'), b = await t.bot('乙');
  const g = await t.group('房務群', [a, b]);
  const past = t.pastToday();
  if (!past) return;
  const gid = t.routine(g, '午報', [past], '各自回報今天下午的進度');
  let job = await t.next();
  assert.equal(job.conv.id, g);
  assert.equal(job.bot.id, a);
  await t.done(job.id, '甲：三間掃完');
  job = await t.next();
  assert.equal(job.bot.id, b);
  assert.equal(job.conv.id, g);
  await t.done(job.id, '（略過）');
  assert.ok((await t.msgs(g)).some(m => m.by === a && /三間掃完/.test(m.text)));
  assert.ok(!(await t.msgs(a)).some(m => /三間掃完/.test(m.text)), 'not in the bot\'s own chat');
  assert.equal(t.row(gid).last_status, 'done', 'one member\'s「（略過）」does not hide the other\'s report');

  // a routine on 甲's own chat whose instruction says to post in 房務群 (how the 15:30 report ended up in the bot's own chat)
  t.db.raw.prepare('UPDATE routines SET enabled=0').run();
  const own = t.routine(a, '15:30 回報', [past], '把房況整理好，貼到群組「房務群」');
  assert.deepEqual(routineTarget({ bots: [{ id: a }, { id: b }], groups: [{ id: g, name: '房務群', members: [a, b] }] }, t.row(own)), { conv: g, chain: [a], name: '房務群' });
  job = await t.next();
  assert.equal(job.conv.id, g, 'runs in the group');
  assert.equal(job.bot.id, a);
  assert.match(job.prompt, /回報在群組「房務群」/);
  await t.done(job.id, '房況：201 已掃、305 待掃');
  assert.equal(await t.next(), null, 'only that bot, not every member');
  assert.ok((await t.msgs(g)).some(m => m.by === a && /305 待掃/.test(m.text)));
  assert.ok(!(await t.msgs(a)).some(m => m.by === a && /305 待掃/.test(m.text)));
  assert.ok((await t.msgs(a)).some(m => m.by === 'sys' && /結果會貼在群組「房務群」/.test(m.text)));
  assert.equal(t.row(own).last_status, 'done');
});

test('times in a 📝任務更新 move to routines: a missing one is made, an existing one wins', async () => {
  const t = await setup();
  const b = await t.bot('房務');
  t.routine(b, '整理訂單', ['09:00'], '整理今天的訂單');
  await t.say(b, '你以後負責房務');
  const job = await t.next();
  await t.done(job.id, '好的\n📝任務更新：\n- 負責貳宿房務，掃房前先看入住名單。\n- 每天 15:30 把房況回報貼到群組。\n- 每天 08:00 整理訂單。\n📝結束');
  const task = t.db.raw.prepare('SELECT task FROM bots WHERE id=?').get(b).task;
  assert.match(task, /負責貳宿房務/);
  assert.doesNotMatch(task, /15:30|08:00/);
  const rs = t.db.raw.prepare('SELECT name,times,prompt FROM routines WHERE conv=? ORDER BY created').all(b);
  const made = rs.find(r => JSON.parse(r.times).includes('15:30'));
  assert.ok(made, JSON.stringify(rs));
  assert.match(made.prompt, /房況回報貼到群組/, 'the moved sentence is the routine\'s own instruction');
  assert.deepEqual(JSON.parse(rs.find(r => r.name === '整理訂單').times), ['09:00'], 'the existing routine is not changed');
  assert.ok(!rs.some(r => JSON.parse(r.times).includes('08:00')));
  const sys = (await t.msgs(b)).filter(m => m.by === 'sys').map(m => m.text).join('\n');
  assert.match(sys, /指定任務裡的時間已移出/);
  assert.match(sys, /以例行任務為準/);
});

test('split task schedules: deadlines and opening hours stay, schedules leave', () => {
  const sp = splitTaskSchedules('負責房務。每天下午3點半回報房況。\n退房 11:00 前要掃好。\n營業時間 08:00-17:00\n每30分鐘巡一次 LINE 訊息');
  assert.equal(sp.moved.length, 2);
  assert.deepEqual(sp.moved[0].times, ['15:30']);
  assert.deepEqual(sp.moved[1].times, ['*/30']);
  assert.match(sp.task, /負責房務。/);
  assert.match(sp.task, /11:00 前要掃好/);
  assert.match(sp.task, /08:00-17:00/);
  assert.doesNotMatch(sp.task, /3點半|巡一次/);
  assert.equal(clockWords('晚上九點十五分'), '21:15');
  assert.equal(clockWords('早上8點'), '08:00');
});

test('the one-time tidy lists mismatches with ✅待確認 and changes nothing until approved', async () => {
  const t = await setup();
  const b = await t.bot('房務');
  t.db.raw.prepare("UPDATE bots SET task=? WHERE id=?").run('負責房務。\n每天 15:30 回報房況。\n每天 08:00 整理訂單。', b);
  const rid = t.routine(b, '回報房況', ['16:00'], '回報房況到群組');
  await t.next();
  const ms = await t.msgs(b);
  const ask = ms.find(m => m.by === b && /✅待確認：整理排程：/.test(m.text));
  assert.ok(ask, JSON.stringify(ms));
  assert.match(ask.text, /16:00，不一致/);
  assert.match(ask.text, /還沒有對應的例行任務/);
  assert.match(t.db.raw.prepare('SELECT task FROM bots WHERE id=?').get(b).task, /15:30/, 'nothing changed yet');
  assert.ok(t.settings().schedTidy, 'runs once');
  await t.next();
  assert.equal((await t.msgs(b)).filter(m => /✅待確認：整理排程/.test(m.text)).length, 1, 'only once');
  const scan = await call(t.db, 'GET', 'schedules/tidy', { token: t.token });
  assert.equal(scan.data.bots[0].items.find(i => i.times.includes('15:30')).state, 'differ');

  await t.say(b, '核准：整理排程：指定任務裡的時間搬到例行任務');
  assert.equal(await t.next(), null, 'approved without an AI run');
  const task = t.db.raw.prepare('SELECT task FROM bots WHERE id=?').get(b).task;
  assert.doesNotMatch(task, /15:30|08:00/);
  assert.match(task, /負責房務/);
  assert.deepEqual(JSON.parse(t.row(rid).times), ['16:00'], 'the routine wins');
  assert.ok(t.db.raw.prepare('SELECT times FROM routines WHERE conv=?').all(b).some(r => JSON.parse(r.times).includes('08:00')));
});

test('a schedule request without ⏰ gets a one-click ✅待確認 that makes the routine', async () => {
  const t = await setup();
  const b = await t.bot('房務');
  assert.equal(scheduleAsk('每天下午3點半把房況貼給我')[0].times[0], '15:30');
  assert.equal(scheduleAsk('為什麼今天 15:30 的回報沒有貼？').length, 0);
  assert.deepEqual(scheduleAsk('每30分鐘巡一次 LINE')[0].times, ['*/30']);
  await t.say(b, '每天下午3點半把房況整理好貼給我');
  let job = await t.next();
  assert.equal(job.schedAsk, true);
  assert.match(buildPrompt(job, '/tmp/octa-sch'), /這則是排程請求/);
  await t.done(job.id, '好的，我會每天整理');
  let ms = await t.msgs(b);
  const ask = ms.find(m => m.by === b && /✅待確認：建立排程：/.test(m.text));
  assert.ok(ask, JSON.stringify(ms));
  assert.match(ask.text, /｜15:30｜/);
  assert.equal(t.db.raw.prepare('SELECT COUNT(*) AS n FROM routines WHERE conv=?').get(b).n, 0, 'not made before approval');
  const line = ask.text.match(/✅待確認：(.+)$/m)[1];
  await t.say(b, '核准：' + line);
  assert.equal(await t.next(), null);
  const r = t.db.raw.prepare('SELECT * FROM routines WHERE conv=?').get(b);
  assert.deepEqual(JSON.parse(r.times), ['15:30']);
  assert.match(r.prompt, /房況/);
  assert.ok((await t.msgs(b)).some(m => m.by === 'sys' && /已新增例行任務/.test(m.text)));

  // the bot wrote the ⏰ line: nothing extra
  await t.say(b, '每天早上8點提醒我看訂單');
  job = await t.next();
  await t.done(job.id, '好，每天 08:00 提醒你\n⏰例行任務：看訂單提醒｜08:00｜提醒使用者看訂單');
  ms = await t.msgs(b);
  assert.ok(!ms.some(m => /✅待確認：建立排程：.*08:00/.test(m.text)));
  assert.ok(t.db.raw.prepare('SELECT times FROM routines WHERE conv=?').all(b).some(x => JSON.parse(x.times).includes('08:00')));
});

test('a correction without 📌 is offered as a rule; approving saves it, a 📌 reply needs nothing', async () => {
  const t = await setup();
  const b = await t.bot('房務');
  assert.ok(correctionAsk('不對，10/26-27 是住兩晚，續住不用掃'));
  assert.equal(correctionAsk('今天有幾間要掃？'), null);
  assert.equal(correctionAsk('以後每天 8 點提醒我'), null, 'a schedule, not a rule');
  await t.say(b, '不對，續住的房間不用掃，以後照這個做');
  let job = await t.next();
  assert.equal(job.correction, true);
  const p = buildPrompt(job, '/tmp/octa-sch');
  assert.match(p, /這則是在糾正你或立新規則/);
  assert.match(p, /記住了：/);
  assert.match(buildLocalPrompt(job, '/tmp/octa-sch'), /📌記住/);
  await t.done(job.id, '好，我改');
  let ms = await t.msgs(b);
  const ask = ms.find(m => m.by === b && /✅待確認：記住規則：/.test(m.text));
  assert.ok(ask, JSON.stringify(ms));
  assert.equal((t.settings().memory || {})[b], undefined, 'not written before approval');
  await t.say(b, '核准：' + ask.text.match(/✅待確認：(.+)$/m)[1]);
  assert.equal(await t.next(), null);
  assert.ok(t.settings().memory[b].some(r => /續住的房間不用掃/.test(r)));
  assert.ok((await t.msgs(b)).some(m => m.by === 'sys' && /已記住：/.test(m.text)));

  // the bot saved it itself
  await t.say(b, '記得以後 PDF 只傳一份');
  job = await t.next();
  await t.done(job.id, '記住了：PDF 只傳一份\n📌記住：同時傳兩間房的 PDF 只傳一份');
  ms = await t.msgs(b);
  assert.ok(!ms.some(m => /✅待確認：記住規則：記得以後 PDF/.test(m.text)));
  assert.ok(t.settings().memory[b].some(r => /只傳一份/.test(r)));

  // 不要做: noted, nothing saved, no AI run
  await t.say(b, '應該先看入住名單再掃');
  job = await t.next();
  await t.done(job.id, '好');
  const ask2 = (await t.msgs(b)).find(m => /✅待確認：記住規則：應該先看/.test(m.text));
  await t.say(b, '不要做：' + ask2.text.match(/✅待確認：(.+)$/m)[1] + '。這件事先停下，不用再問。');
  assert.equal(await t.next(), null);
  assert.ok(!t.settings().memory[b].some(r => /先看入住名單/.test(r)));
});

test('in a group: the named bot offers the schedule, approving with @name makes a group routine without a run', async () => {
  const t = await setup();
  const a = await t.bot('甲'), b = await t.bot('乙');
  const g = await t.group('房務群', [a, b], '同時做');
  await t.say(g, '@甲 每天早上9點把進度貼在這裡');
  const job = await t.next();
  assert.equal(job.bot.id, a);
  assert.equal(job.schedAsk, true);
  await t.done(job.id, '好');
  const ask = (await t.msgs(g)).find(m => m.by === a && /✅待確認：建立排程：.*09:00/.test(m.text));
  assert.ok(ask);
  await t.say(g, '@甲 核准：' + ask.text.match(/✅待確認：(.+)$/m)[1]);
  assert.equal(await t.next(), null);
  const r = t.db.raw.prepare('SELECT * FROM routines WHERE conv=?').get(g);
  assert.deepEqual(JSON.parse(r.times), ['09:00']);

  // a correction to 甲 in the group: 乙 doesn't get a rule offered
  await t.say(g, '@甲 不對，以後進度要寫房號');
  const j2 = await t.next();
  assert.equal(j2.bot.id, a);
  await t.done(j2.id, '好');
  const ms = await t.msgs(g);
  assert.ok(ms.some(m => m.by === a && /✅待確認：記住規則：/.test(m.text)));
  assert.ok(!ms.some(m => m.by === b && /✅待確認：記住規則：/.test(m.text)));
});

test('prompt: a routine run follows its own instruction; rules win over the old task wording', () => {
  const job = { bot: { id: 'b', name: '房務', engine: 'claude', task: '每天 15:30 回報房況', autonomy: 'report' }, prompt: '（例行任務「午報」）把房況貼到群組', history: [], lang: 'zh-TW',
    routine: { name: '午報', times: ['16:00'], own: true }, memory: ['回覆要簡短'] };
  const p = buildPrompt(job, '/tmp/octa-sch');
  assert.match(p, /這一則是例行任務「午報」（排程：每天 16:00）/);
  assert.match(p, /排程時間以例行任務為準，指定任務裡寫的時間不算/);
  assert.match(p, /你的指定任務（背景參考；這次是例行任務/);
  assert.match(memoryLines(job).join('\n'), /跟指定任務裡的舊寫法衝突時，以規則為準/);
  const plain = buildPrompt({ ...job, routine: null, prompt: '你好' }, '/tmp/octa-sch');
  assert.doesNotMatch(plain, /這一則是例行任務/);
  assert.match(plain, /時間只寫在 ⏰例行任務/);
});
