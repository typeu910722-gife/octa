// Reliability: a failed job says why, retries itself when that can help, keeps its screenshot,
// notifies with a plain reason, and a sign-in pauses with the login card.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { classifyJobFailure, retryPrompt, stripRetryNote, failureNotice, autoRetryable, FAIL_KINDS } from '../public/model-route.mjs';
import { buildPrompt, buildLocalPrompt } from '../public/octa-runner.mjs';

const apiUrl = pathToFileURL(join(import.meta.dirname, '..', 'functions', 'api', '[[path]].js')).href;
const { onRequest } = await import(apiUrl);
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
// Telegram / LINE calls are captured instead of sent
const sent = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, init = {}) => {
  const s = String(u);
  if (/api\.telegram\.org|api\.line\.me/.test(s)) {
    sent.push({ url: s, body: init.body instanceof FormData ? Object.fromEntries([...init.body.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : 'blob:' + v.size])) : JSON.parse(init.body || '{}') });
    return new Response('{"ok":true}', { status: 200 });
  }
  return realFetch(u, init);
};

async function setup(name, botBody = {}) {
  const db = openD1();
  const su = await call(db, 'POST', 'signup', { body: { name, pw: 'correcthorsebattery' } });
  const token = su.data.token;
  await call(db, 'PUT', 'settings', { token, body: { tg: { token: 'tg-x', chat: '100' } } });
  const bot = await call(db, 'POST', 'bots', { token, body: { name: '小幫手', task: '查網站', ...botBody } });
  const runner = await call(db, 'POST', 'runner-token', { token, body: { label: 'rel-host' } });
  return { db, token, bot: bot.data.id, rt: runner.data.token };
}
const claim = async (db, rt) => (await call(db, 'POST', 'runner/next', { token: rt, body: { slots: 1, wait: false } })).data.job;
const jobRow = (db, id) => db.raw.prepare('SELECT * FROM jobs WHERE id=?').get(id);

test('failures are sorted into plain kinds', () => {
  assert.equal(classifyJobFailure('⚠ AI 很久沒有回應，已中止'), 'timeout');
  assert.equal(classifyJobFailure('x', { stalled: true }), 'timeout');
  assert.equal(classifyJobFailure('⚠ Claude Code 執行失敗：\n執行超過 15 分鐘，已中止。'), 'timeout');
  assert.equal(classifyJobFailure('需要使用者在電腦上登入 LINE 官方帳號'), 'not_logged_in');
  assert.equal(classifyJobFailure('Your session has expired, please sign in to continue'), 'not_logged_in');
  assert.equal(classifyJobFailure('usage limit exceeded. Resets in 1h'), 'quota');
  assert.equal(classifyJobFailure('Error: Ref e42 not found in the current page snapshot'), 'site_changed');
  assert.equal(classifyJobFailure('找不到按鈕「送出」，頁面不同'), 'site_changed');
  assert.equal(classifyJobFailure('Error: MCP server browser failed to start'), 'tool_error');
  assert.equal(classifyJobFailure('net::ERR_CONNECTION_REFUSED'), 'tool_error');
  assert.equal(classifyJobFailure('something odd happened'), 'unknown');
  assert.equal(classifyJobFailure('anything', { hint: 'site_changed' }), 'site_changed');
  assert.equal(autoRetryable('unknown', 'AssertionError test.js failed'), false);
  assert.equal(autoRetryable('unknown', 'odd'), true);
  assert.equal(autoRetryable('not_logged_in', ''), false);
  assert.equal(autoRetryable('quota', ''), false);
  for (const k of ['timeout', 'site_changed', 'tool_error', 'unknown']) assert.equal(FAIL_KINDS[k].retry, true);
});

test('only the second retry carries the reason, and notes never stack', () => {
  assert.equal(retryPrompt('查訂單', 1, 'site_changed', 'x'), '查訂單');
  // stopped halfway: every retry continues from what is done instead of starting over
  assert.match(retryPrompt('查訂單', 1, 'timeout', 'x'), /^查訂單\n\n（自動重試 1）上一次做到一半中斷了.*不要重做、不要重傳/s);
  assert.match(retryPrompt('查訂單', 1, 'interrupted', 'x'), /主機斷線或重新啟動/);
  const two = retryPrompt('查訂單', 2, 'site_changed', 'Ref e1 not found');
  assert.match(two, /^查訂單\n\n（自動重試 2）前一次失敗了，原因：網頁變了/);
  assert.match(two, /換一種方法/);
  assert.equal(stripRetryNote(two), '查訂單');
  assert.equal(retryPrompt(two, 2, 'timeout', '').match(/自動重試/g).length, 1);
  const n = failureNotice('小幫手', two, 'timeout', '⚠ AI 很久沒有回應');
  assert.match(n, /小幫手/); assert.match(n, /做什麼：查訂單/); assert.match(n, /原因：逾時/); assert.match(n, /建議：/);
  assert.equal(n.includes('自動重試'), false);
});

test('a timeout retries twice (the second time with the reason), then fails with a reason, notification and 重試', async () => {
  const { db, token, bot, rt } = await setup('rel1');
  await call(db, 'POST', 'messages', { token, body: { conv: bot, text: '查今天的訂單' } });
  const j1 = await claim(db, rt);
  sent.length = 0;
  await call(db, 'POST', 'runner/done', { token: rt, body: { id: j1.id, ok: false, stalled: true, err_kind: 'timeout', text: '⚠ AI 很久沒有回應，已中止' } });
  assert.equal(jobRow(db, j1.id).err_kind, 'timeout');
  const j2 = await claim(db, rt);
  assert.match(j2.prompt, /^查今天的訂單\n\n（自動重試 1）上一次做到一半中斷了/);
  assert.equal(jobRow(db, j2.id).retry_of, j1.id);
  await call(db, 'POST', 'runner/done', { token: rt, body: { id: j2.id, ok: false, text: 'Error: Ref e9 not found in the current page snapshot' } });
  assert.equal(jobRow(db, j2.id).err_kind, 'site_changed');
  const j3 = await claim(db, rt);
  assert.match(j3.prompt, /^查今天的訂單\n\n（自動重試 2）.*網頁變了.*換一種方法/s);
  assert.equal(sent.length, 0, 'no notification while it is still retrying');
  await call(db, 'POST', 'runner/done', { token: rt, body: { id: j3.id, ok: false, stalled: true, text: '⚠ AI 很久沒有回應，已中止', shot: Buffer.from('fakejpeg').toString('base64') } });
  assert.equal(await claim(db, rt), null, 'stops after two automatic retries');
  const last = jobRow(db, j3.id);
  assert.equal(last.status, 'error');
  assert.equal(last.err_kind, 'timeout');
  assert.match(last.err_msg, /很久沒有回應/);
  const msgs = (await call(db, 'GET', 'messages', { token, query: { conv: bot } })).data.msgs;
  assert.equal(msgs.filter(m => m.by === 'sys' && /自動重試第/.test(m.text)).length, 2);
  const final = msgs.filter(m => m.by === bot).pop();
  assert.match(final.text, /^⚠/);
  assert.match(final.text, /原因：逾時/);
  // Telegram: one photo with the plain reason as its caption
  assert.equal(sent.length, 1);
  assert.match(sent[0].url, /sendPhoto/);
  assert.match(sent[0].body.caption, /小幫手 沒有完成工作/);
  assert.match(sent[0].body.caption, /做什麼：查今天的訂單/);
  assert.match(sent[0].body.caption, /原因：逾時/);
  assert.match(sent[0].body.photo, /^blob:/);
  // 工作紀錄 shows the reason, which attempts were retried, and lets the user retry the last one
  const logs = (await call(db, 'GET', 'logs', { token })).data.logs;
  const row = id => logs.find(l => l.id === id);
  assert.equal(row(j1.id).retried, true);
  assert.equal(row(j3.id).retried, false);
  assert.equal(row(j3.id).err_kind, 'timeout');
  assert.equal(row(j3.id).prompt, '查今天的訂單');
  const again = await call(db, 'POST', 'logs/retry', { token, body: { id: j3.id } });
  assert.equal(again.status, 200, JSON.stringify(again.data));
  const j4 = await claim(db, rt);
  assert.equal(j4.prompt, '查今天的訂單');
  assert.equal(jobRow(db, j4.id).tries, 0);
  assert.equal((await call(db, 'POST', 'logs/retry', { token, body: { id: j4.id } })).status, 400, 'a running job cannot be retried');
});

test('a website sign-in is never retried: it pauses with the login card and notifies', async () => {
  const { db, token, bot, rt } = await setup('rel2');
  await call(db, 'POST', 'messages', { token, body: { conv: bot, text: '看後台訊息' } });
  const j1 = await claim(db, rt);
  sent.length = 0;
  await call(db, 'POST', 'runner/done', { token: rt, body: { id: j1.id, ok: false, text: 'Error: session expired, please log in again' } });
  assert.equal(await claim(db, rt), null);
  assert.equal(jobRow(db, j1.id).err_kind, 'not_logged_in');
  const msgs = (await call(db, 'GET', 'messages', { token, query: { conv: bot } })).data.msgs;
  const card = msgs.filter(m => m.by === bot).pop();
  assert.match(card.text, /需要使用者在電腦上登入/, 'the bot message brings up the 接手／繼續 login card');
  assert.match(card.text, /原因：需要登入/);
  assert.equal(sent.length, 1);
  assert.match(sent[0].url, /sendMessage/);
  assert.match(sent[0].body.text, /原因：需要登入/);
  // a reply that stops to wait for a sign-in is marked too, and notifies with the same plain words
  // (another bot: two sign-in stops in a row in one chat are only said once, as before)
  const other = (await call(db, 'POST', 'bots', { token, body: { name: '另一個', task: '看後台' } })).data.id;
  await call(db, 'POST', 'messages', { token, body: { conv: other, text: '再看一次' } });
  const j2 = await claim(db, rt);
  sent.length = 0;
  await call(db, 'POST', 'runner/done', { token: rt, body: { id: j2.id, ok: true, text: '需要使用者在電腦上登入 Example 後台', shot: Buffer.from('jpeg').toString('base64') } });
  const r2 = jobRow(db, j2.id);
  assert.equal(r2.status, 'done');
  assert.equal(r2.err_kind, 'not_logged_in');
  assert.equal(sent.length, 1);
  assert.match(sent[0].url, /sendPhoto/);
  assert.match(sent[0].body.caption, /需要登入/);
});

test('quota still goes to the backup AI and records why', async () => {
  const { db, token, bot, rt } = await setup('rel3', { fb: ['gemini'] });
  await call(db, 'POST', 'messages', { token, body: { conv: bot, text: '整理名單' } });
  const j1 = await claim(db, rt);
  await call(db, 'POST', 'runner/done', { token: rt, body: { id: j1.id, ok: false, text: 'usage limit exceeded. Resets in 1h' } });
  assert.equal(jobRow(db, j1.id).err_kind, 'quota');
  const j2 = await claim(db, rt);
  assert.equal(j2.bot.engine, 'gemini');
  assert.equal(j2.prompt, '整理名單');
});

test('the screenshot is linked to its job, and a failed job keeps it', async () => {
  const { db, token, bot, rt } = await setup('rel4');
  await call(db, 'POST', 'messages', { token, body: { conv: bot, text: '看頁面' } });
  const j1 = await claim(db, rt);
  await call(db, 'POST', 'runner/shot', { token: rt, body: { id: j1.id, path: '截圖/a.jpeg', name: 'a.jpeg', size: 10 } });
  const shot1 = jobRow(db, j1.id).shot;
  assert.ok(shot1);
  await call(db, 'POST', 'runner/done', { token: rt, body: { id: j1.id, ok: false, text: 'AssertionError: same every time' } });
  assert.equal(await claim(db, rt), null, 'a program that fails the same way is not run again');
  assert.equal(jobRow(db, j1.id).err_kind, 'unknown');
  await call(db, 'POST', 'messages', { token, body: { conv: bot, text: '再看' } });
  const j2 = await claim(db, rt);
  await call(db, 'POST', 'runner/shot', { token: rt, body: { id: j2.id, path: '截圖/b.jpeg', name: 'b.jpeg', size: 10 } });
  assert.ok(db.raw.prepare('SELECT 1 FROM files WHERE id=?').get(shot1), 'the failed job still has its screenshot');
  await call(db, 'POST', 'runner/done', { token: rt, body: { id: j2.id, ok: true, text: '好了' } });
  await call(db, 'POST', 'messages', { token, body: { conv: bot, text: '第三次' } });
  const j3 = await claim(db, rt);
  const shot2 = jobRow(db, j2.id).shot;
  await call(db, 'POST', 'runner/shot', { token: rt, body: { id: j3.id, path: '截圖/c.jpeg', name: 'c.jpeg', size: 10 } });
  assert.equal(db.raw.prepare('SELECT 1 FROM files WHERE id=?').get(shot2), undefined, 'a finished job’s screenshot is replaced as before');
  const logs = (await call(db, 'GET', 'logs', { token })).data.logs;
  assert.equal(logs.find(l => l.id === j1.id).shot, shot1);
});

test('an old database gains the failure columns', async () => {
  const db = openD1();
  for (const c of ['err_kind', 'err_msg', 'shot', 'retry_of']) db.raw.exec(`ALTER TABLE jobs DROP COLUMN ${c}`);
  const su = await call(db, 'POST', 'signup', { body: { name: 'rel5', pw: 'correcthorsebattery' } });
  assert.equal(su.status, 200);
  await call(db, 'GET', 'logs', { token: su.data.token });
  const cols = db.raw.prepare('PRAGMA table_info(jobs)').all().map(c => c.name);
  for (const c of ['err_kind', 'err_msg', 'shot', 'retry_of']) assert.ok(cols.includes(c), c);
});

test('工作紀錄 shows the reason, the screenshot and a retry button', () => {
  const page = readFileSync(join(import.meta.dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(page, /function logFail\(l\)/);
  for (const k of Object.keys(FAIL_KINDS)) assert.match(page, new RegExp(k + ":\\['" + FAIL_KINDS[k].label));
  assert.match(page, /data-lshot=/);
  assert.match(page, /api\('logs\/retry','POST'/);
  const dict = readFileSync(join(import.meta.dirname, '..', 'public', 'i18n-dict.js'), 'utf8');
  for (const s of ['看截圖', '已自動重試', '待登入', '網頁變了']) assert.ok(dict.includes(`"${s}"`), s);
});

test('the work prompt asks for a check against the source before numbers and lists', () => {
  const job = { bot: { id: 'b1', name: '測', engine: 'claude', task: '' }, prompt: '算人數', history: [], lang: 'zh-TW' };
  for (const p of [buildPrompt(job, '/tmp/octa-rel'), buildLocalPrompt({ ...job, bot: { ...job.bot, engine: 'opencode' } }, '/tmp/octa-rel')]) {
    assert.match(p, /交出數字、名單、清單之前，先回頭對照原始資料/);
    assert.match(p, /對不上就重算/);
    assert.match(p, /不用描述核對過程/);
  }
});
