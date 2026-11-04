// 4.7 track C: 任務總覽 (GET /api/overview), 它記得什麼 (memview + who set each item), 異常主動推播 (alerts, throttle,
// 一鍵重試 only through the API), role templates (roles/create), and the app pieces (overview.js, memory-view.js).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { dict, html, scripts } from './app-source.mjs';

const api = p => pathToFileURL(join(import.meta.dirname, '..', 'desktop', 'api', p)).href;
const { onRequest } = await import(api('index.mjs'));
const { alertSweep, alertText, retryLink, sendNotify, heldNotice, ALERT_THROTTLE } = await import(api('notify.mjs'));
const { applyEdit } = await import(api('memory-edit.mjs'));
const { progressOf, jobLine } = await import(api('overview.mjs'));
const { newSession } = await import(api('db.mjs'));
const { failureNotice } = await import(pathToFileURL(join(import.meta.dirname, '..', 'desktop', 'lib', 'model-route.mjs')).href);
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
    async batch(stmts) { db.exec('BEGIN'); try { const out = stmts.map(s => s._exec()); db.exec('COMMIT'); return out; } catch (e) { try { db.exec('ROLLBACK'); } catch { } throw e; } },
    raw: db
  };
}
async function call(db, method, path, { body, env = {}, token } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = 'Bearer ' + token;
  const res = await onRequest({
    request: new Request('http://octa.test/api/' + path, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(body || {}) }),
    env: { DB: db, TZ_OFFSET_MIN: '480', isLocal: true, ...env },
    params: { path: path.split('?')[0].split('/').filter(Boolean) }
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
async function setup() {
  const db = openD1();
  await db.prepare("INSERT OR IGNORE INTO users (id,name,pw,created) VALUES ('local','本機','-',?)").bind(Date.now()).run();
  return db;
}
const job = (db, o) =>
  db
    .prepare('INSERT INTO jobs (user_id,conv,bot_id,prompt,status,created,started,finished,err_kind,err_msg,retry_of,progress,routine) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .bind('local', o.conv || o.bot, o.bot, o.prompt || '做事', o.status || 'done', o.created || Date.now(), o.started || null, o.finished || null, o.err_kind || null, o.err_msg || null, o.retry_of || null, o.progress || null, o.routine || null)
    .run()
    .then(r => r.meta.last_row_id);

test('overview: one call with each bot’s role, today’s done / failed (retried ones drop out), running with steps, next routine runs', async () => {
  const db = await setup();
  const a = (await call(db, 'POST', 'bots', { body: { name: '訂房員', task: '整理今天的入住和退房。之後回報。' } })).data.id;
  const b = (await call(db, 'POST', 'bots', { body: { name: '客服', task: '' } })).data.id;
  const g = (await call(db, 'POST', 'groups', { body: { name: '早班', members: [a, b] } })).data.id;
  await call(db, 'POST', 'routines', { body: { conv: a, name: '早上整理', times: ['23:59'], prompt: '整理訂房' } });
  const old = Date.now() - 3 * 86400000;
  await job(db, { bot: a, status: 'done', created: old, finished: old }); // not today
  await job(db, { bot: a, status: 'done', prompt: '整理今天的訂房', finished: Date.now() });
  const f1 = await job(db, { bot: a, status: 'error', prompt: '查後台', err_kind: 'timeout', err_msg: '做太久' });
  await job(db, { bot: a, status: 'done', prompt: '查後台', retry_of: f1 }); // retried and done: no longer a failure
  const f2 = await job(db, { bot: a, status: 'error', prompt: '回報\n\n（自動重試 1）前一次失敗了', err_kind: 'logout', err_msg: '被登出' });
  await job(db, { bot: b, conv: g, status: 'running', prompt: '回覆客人', started: Date.now(), progress: JSON.stringify({ text: '打開後台', step: 2, total: 4, steps: ['登入', '打開後台', '看訊息', '回覆'] }) });
  await job(db, { bot: a, conv: g, status: 'pending', prompt: '下一步' });
  const r = await call(db, 'GET', 'overview');
  assert.equal(r.status, 200);
  const A = r.data.bots.find(x => x.id === a), B = r.data.bots.find(x => x.id === b), G = r.data.groups.find(x => x.id === g);
  assert.equal(A.role, '整理今天的入住和退房。');
  assert.equal(A.doneN, 2);
  assert.deepEqual(A.failed.map(x => x.id), [f2]);
  assert.equal(A.failed[0].what, '回報'); // retry note stripped
  assert.equal(A.failed[0].label, '被登出了');
  assert.equal(A.queued, 1);
  const rt0 = A.routines.find(x => x.name === '早上整理');
  assert.ok(rt0.at > Date.now());
  assert.equal(B.running[0].progress.step, 2);
  assert.equal(B.running[0].progress.steps.length, 4);
  assert.equal(G.running.length, 1);
  assert.equal(G.queued, 1);
  // old plain-text progress still reads
  assert.deepEqual(progressOf('打開網頁'), { text: '打開網頁' });
  assert.equal(progressOf(null), null);
  assert.equal(jobLine('x', '早上整理'), '例行任務：早上整理');
  // retry from the overview: once
  const rt = await call(db, 'POST', 'overview/retry', { body: { job: f2 } });
  assert.equal(rt.status, 200);
  const again = await call(db, 'POST', 'overview/retry', { body: { job: f2 } });
  assert.equal(again.status, 409);
  const after = await call(db, 'GET', 'overview');
  assert.equal(after.data.bots.find(x => x.id === a).failed.length, 0);
  const nj = await db.prepare('SELECT prompt, retry_of FROM jobs WHERE id=?').bind(rt.data.job).first();
  assert.equal(nj.prompt, '回報');
  assert.equal(nj.retry_of, f2);
});

test('memory page: list with who set each item; add, edit, delete; old items say 來源不明; the runner still reads the same lists', async () => {
  const db = await setup();
  // saved before 4.7 (straight into the database); the first request after the upgrade marks it old
  const a = 'bot-a';
  db.raw.prepare("INSERT INTO bots (id,user_id,name,task,created) VALUES (?, 'local', '助理', '幫忙', ?)").run(a, Date.now());
  const st = { memory: { [a]: ['舊規則'] }, sites: { 'example.com': ['登入按右上角'] } };
  db.raw.prepare("UPDATE users SET settings=? WHERE id='local'").run(JSON.stringify(st));
  const db2 = db;
  let r = await call(db2, 'GET', 'memview?id=' + a);
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.items.rule.map(x => [x.text, x.by]), [['舊規則', 'old']]);
  // add / edit / delete through the page
  assert.equal((await call(db2, 'POST', 'memview/item', { body: { bot: a, kind: 'rule', op: 'add', text: '回覆要用敬語' } })).status, 200);
  assert.equal((await call(db2, 'POST', 'memview/item', { body: { bot: a, kind: 'rule', op: 'add', text: '回覆要用敬語' } })).status, 400); // duplicate
  assert.equal((await call(db2, 'POST', 'memview/item', { body: { bot: a, kind: 'fact', op: 'add', text: '後台 https://x.test' } })).status, 200);
  assert.equal((await call(db2, 'POST', 'memview/item', { body: { bot: a, kind: 'manual', op: 'add', name: '月結', steps: '1. 匯出 2. 對帳 3. 寄出' } })).status, 200);
  assert.equal((await call(db2, 'POST', 'memview/item', { body: { bot: a, kind: 'rule', op: 'edit', old: '舊規則', text: '新規則' } })).status, 200);
  r = await call(db2, 'GET', 'memview?id=' + a);
  assert.deepEqual(r.data.items.rule.map(x => [x.text, x.by]), [['新規則', 'user'], ['回覆要用敬語', 'user']]);
  assert.ok(r.data.items.rule[0].ts > 0);
  assert.equal(r.data.items.manual[0].name, '月結');
  assert.equal((await call(db2, 'POST', 'memview/item', { body: { bot: a, kind: 'fact', op: 'del', old: '後台 https://x.test' } })).status, 200);
  assert.equal((await call(db2, 'POST', 'memview/item', { body: { bot: a, kind: 'fact', op: 'del', old: '沒有這條' } })).status, 400);
  // an item written by something that doesn't record (the bot's own 📌記住 in runner/done) after 4.7: the bot
  const s2 = JSON.parse(db.raw.prepare("SELECT settings FROM users WHERE id='local'").get().settings);
  s2.memory[a].push('機器人自己記的');
  db.raw.prepare("UPDATE users SET settings=? WHERE id='local'").run(JSON.stringify(s2));
  r = await call(db2, 'GET', 'memview?id=' + a);
  assert.equal(r.data.items.rule.find(x => x.text === '機器人自己記的').by, 'bot');
  // the runner's state view reads the same settings
  const state = await call(db2, 'GET', 'state');
  assert.deepEqual(state.data.memory[a], ['新規則', '回覆要用敬語', '機器人自己記的']);
  // 任務設定 saves a whole list: the new item is the person's
  await call(db2, 'PUT', 'settings', { body: { memory: { bot: a, type: 'rule', list: ['新規則', '從任務設定加的'] } } });
  r = await call(db2, 'GET', 'memview?id=' + a);
  assert.equal(r.data.items.rule.find(x => x.text === '從任務設定加的').by, 'user');
  // shared: site notes (old) and 共用資料
  r = await call(db2, 'GET', 'memview?id=shared');
  assert.equal(r.data.shared.sites[0].items[0].by, 'old');
  assert.equal((await call(db2, 'POST', 'memview/item', { body: { kind: 'site', domain: 'https://shop.test/admin', op: 'add', text: '訂單在左邊選單' } })).status, 200);
  assert.equal((await call(db2, 'PUT', 'memview/notes', { body: { notes: '營業時間 9-18' } })).status, 200);
  r = await call(db2, 'GET', 'memview?id=shared');
  assert.equal(r.data.shared.notes, '營業時間 9-18');
  assert.ok(r.data.shared.sites.some(s => s.domain === 'shop.test' && s.items[0].by === 'user'));
  assert.equal((await call(db2, 'GET', 'memview?id=nope')).status, 404);
  // pure edit rules
  assert.equal(applyEdit(['a'], 'rule', 'edit', { old: 'zz', text: 'b' }).error, '找不到這一項，可能已經被改過了');
  assert.equal(applyEdit([], 'skill', 'add', { name: 'x' }).error, '名稱和步驟都要填');
});

test('hook teach is recorded as the other AI’s; a role template’s rules as the template’s', async () => {
  const db = await setup();
  const r = await call(db, 'POST', 'roles/create', { body: { role: 'housekeeping' } });
  assert.equal(r.status, 200);
  const id = r.data.id;
  const bot = await db.prepare('SELECT name, task, color, avatar, stood FROM bots WHERE id=?').bind(id).first();
  assert.equal(bot.name, '房務');
  assert.match(bot.task, /打掃/);
  assert.equal(bot.color, '#9BD39A');
  assert.equal(bot.stood, 1);
  const rts = (await db.prepare('SELECT name, times, enabled FROM routines WHERE conv=?').bind(id).all()).results;
  assert.deepEqual(rts.map(x => [x.name, JSON.parse(x.times), x.enabled]), [['今日打掃清單', ['08:30'], 1]]);
  const mv = await call(db, 'GET', 'memview?id=' + id);
  assert.equal(mv.data.items.rule.length, 3);
  assert.ok(mv.data.items.rule.every(x => x.by === 'tpl'));
  // the same role again gets a numbered name; a taken name chosen by hand is refused
  assert.equal((await call(db, 'POST', 'roles/create', { body: { role: 'housekeeping' } })).data.name, '房務2');
  assert.equal((await call(db, 'POST', 'roles/create', { body: { role: 'housekeeping', name: '房務' } })).status, 400);
  assert.equal((await call(db, 'POST', 'roles/create', { body: { role: 'nope' } })).status, 400);
  // without routines
  const r3 = await call(db, 'POST', 'roles/create', { body: { role: 'report', name: '日報', routines: false } });
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM routines WHERE conv=?').bind(r3.data.id).first()).n, 0);
  // the list for the picker, per language
  const list = await call(db, 'GET', 'roles?lang=en');
  assert.deepEqual(list.data.roles.map(x => x.key), ['support', 'housekeeping', 'report', 'booking', 'social', 'books']);
  assert.equal(list.data.roles[0].name, 'Support');
  assert.equal((await call(db, 'GET', 'roles?lang=zh-TW')).data.roles[5].name, '記帳');
  // 交接網址 teach
  const hk = await call(db, 'POST', 'routines', { body: { conv: id, name: '外部交接', trigger: 'hook', prompt: '交接' } });
  assert.equal(hk.status, 200);
  const key = (await db.prepare('SELECT hook FROM routines WHERE conv=? AND hook IS NOT NULL').bind(id).first()).hook;
  const t = await call(db, 'POST', 'hook/' + key + '/teach', { body: { text: '退房後先拍照', from: 'Grok' }, env: { isLocal: false } });
  assert.equal(t.status, 200);
  const mv2 = await call(db, 'GET', 'memview?id=' + id);
  assert.equal(mv2.data.items.rule.find(x => x.text === '退房後先拍照').by, 'hook');
});

test('alerts: pushed at once with a retry link, the same bot and kind throttled for 30 minutes, the generic notice replaced', async () => {
  const db = await setup();
  const a = (await call(db, 'POST', 'bots', { body: { name: '訂房員', task: '整理' } })).data.id;
  const b = (await call(db, 'POST', 'bots', { body: { name: '客服', task: '回覆' } })).data.id;
  db.raw.prepare("UPDATE users SET settings=? WHERE id='local'").run(JSON.stringify({ tg: { token: 'T', chat: '1' } }));
  const sent = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (u, o) => { sent.push({ u: String(u), body: JSON.parse(o.body) }); return new Response('{}'); };
  try {
    const env = { remoteLink: () => 'https://octa.yzprojecttw.com/go' };
    // runner/done's generic failure notice for these kinds is held back (alertSweep sends the alert instead)
    const held = await sendNotify(env, { tg: { token: 'T', chat: '1' } }, failureNotice('訂房員', '整理', 'logout', 'x'));
    assert.deepEqual(held, ['（改由異常通知送出）']);
    assert.equal(heldNotice(failureNotice('訂房員', '整理', 'timeout', 'x')), null);
    assert.equal(sent.length, 0);
    const j1 = await job(db, { bot: a, status: 'error', err_kind: 'logout', prompt: '整理訂房' });
    await job(db, { bot: a, status: 'error', err_kind: 'timeout' }); // not an alert kind
    await job(db, { bot: a, status: 'running', err_kind: 'api' }); // not finished
    assert.equal(await alertSweep(env, db, 'local'), 1);
    assert.equal(sent.length, 1);
    const text = sent[0].body.text;
    assert.match(text, /訂房員 被登出了/);
    assert.ok(text.includes(`https://octa.yzprojecttw.com/go#web=${a}&retry=${j1}`));
    assert.doesNotMatch(text, /token|t=/); // nothing secret in the link
    // the same job again: nothing; the same bot and kind within 30 minutes: recorded, not pushed; another kind: pushed
    assert.equal(await alertSweep(env, db, 'local'), 0);
    await job(db, { bot: a, status: 'error', err_kind: 'not_logged_in' });
    await job(db, { bot: a, status: 'done', err_kind: 'missing', prompt: '（例行任務「早上」）看名單' });
    await job(db, { bot: b, status: 'error', err_kind: 'api' });
    assert.equal(await alertSweep(env, db, 'local'), 2);
    assert.equal(sent.length, 3);
    const al = await call(db, 'GET', 'alerts');
    assert.equal(al.data.alerts.length, 4);
    assert.equal(al.data.alerts.filter(x => !x.pushed).length, 1);
    assert.equal(al.data.alerts.find(x => !x.pushed).kind, 'logout');
    // after 30 minutes it is pushed again
    db.raw.prepare('UPDATE alerts SET ts=ts-?').run(ALERT_THROTTLE + 1000);
    await job(db, { bot: a, status: 'error', err_kind: 'logout' });
    assert.equal(await alertSweep(env, db, 'local'), 1);
    // no phone remote: the message says to open OCTA
    assert.match(alertText('X', 'api', 'p', '', ''), /打開 OCTA/);
    assert.equal(retryLink('', 'b', 1), '');
    // a retried job is not alerted
    const j9 = await job(db, { bot: b, status: 'error', err_kind: 'api' });
    await job(db, { bot: b, status: 'pending', retry_of: j9 });
    assert.equal(await alertSweep(env, db, 'local'), 0);
    // 一鍵重試 needs the API's own sign-in: a phone that hasn't paired gets 401, a paired one can
    const no = await call(db, 'POST', 'alerts/retry', { body: { job: j1 }, env: { isLocal: false } });
    assert.equal(no.status, 401);
    const bad = await call(db, 'POST', 'alerts/retry', { body: { job: j1 }, env: { isLocal: false }, token: 'x'.repeat(48) });
    assert.equal(bad.status, 401);
    const tok = await newSession(db, 'local', 'web', 'iPhone');
    const yes = await call(db, 'POST', 'alerts/retry', { body: { job: j1 }, env: { isLocal: false }, token: tok });
    assert.equal(yes.status, 200);
    assert.equal((await call(db, 'POST', 'alerts/retry', { body: { job: j1 }, env: { isLocal: false }, token: tok })).status, 409);
    const al2 = await call(db, 'GET', 'alerts');
    assert.equal(al2.data.alerts.find(x => x.job === j1).retry, 'pending');
  } finally {
    globalThis.fetch = real;
  }
});

test('app: overview, memory page, alerts, usage and role picker are wired in and translated', () => {
  for (const f of ['overview.js', 'memory-view.js']) assert.ok(html.includes(`<script defer src="/js/${f}"></script>`), f);
  assert.ok(html.includes('id="ovBtn"'));
  assert.ok(html.includes('id="quota"'));
  const ov = scripts['overview.js'], mv = scripts['memory-view.js'];
  assert.match(ov, /api\('overview'\)/);
  assert.match(ov, /有問題的/);
  assert.match(ov, /api\('alerts/);
  assert.match(ov, /ai-usage/);
  assert.match(mv, /memview/);
  assert.match(mv, /來源不明（舊資料）/);
  assert.match(scripts['bots.js'], /roles\/create/);
  assert.match(scripts['pure.js'], /retry/);
  for (const s of ['任務總覽', '它記得什麼', '一鍵重試', '只取名字', '有問題的']) assert.ok(dict.en.t[s], s);
});

test('the /go page passes a 一鍵重試 link on to the app (only with a bot, only digits)', async () => {
  const go = await import(pathToFileURL(join(import.meta.dirname, '..', 'site', 'go-core.js')).href);
  assert.deepEqual(go.parseFragment('#web=b-1&retry=42'), { web: 'b-1', retry: '42' });
  assert.equal(go.parseFragment('#retry=42').retry, undefined);
  assert.equal(go.parseFragment('#web=b-1&retry=4x').retry, undefined);
  assert.match(go.appUrl('https://x.trycloudflare.com', { t: 't'.repeat(20), web: 'b-1', retry: '42', go: 'https://octa.yzprojecttw.com/go' }), /#t=t+&web=b-1&retry=42&go=/);
  const octaFrag = new Function(scripts['pure.js'] + ';return octaFrag')();
  assert.deepEqual(octaFrag('#web=b-1&retry=42'), { web: 'b-1', retry: '42' });
  assert.equal(octaFrag('#retry=42').retry, undefined);
});
