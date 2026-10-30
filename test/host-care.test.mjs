// 主機斷線與排程 (2026-10-30 回報): a restarted host continues cut-off jobs, halfway work is sent before continuing,
// routine runs don't make routines, the same routine isn't made twice, and the runner can't wait forever.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { partialNote, PARTIAL_TAG, SAFE_WORK_RULES, limitSignal, buildPrompt } from '../public/octa-runner.mjs';
import { googleRefused } from '../desktop/browser-catalog.mjs';

const apiUrl = pathToFileURL(join(import.meta.dirname, '..', 'functions', 'api', '[[path]].js')).href;
const { onRequest, schedulesFromTurn, splitTaskSchedules, sameRoutine } = await import(apiUrl);
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
  const runner = await call(db, 'POST', 'runner-token', { token, body: { label: 'care-host' } });
  return { db, token, bot: bot.data.id, rt: runner.data.token };
}
const claim = async (db, rt) => (await call(db, 'POST', 'runner/next', { token: rt, body: { slots: 1, wait: false } })).data.job;
const jobRow = (db, id) => db.raw.prepare('SELECT * FROM jobs WHERE id=?').get(id);


test('a routine run, a colleague or a retry never makes routines from its own text', () => {
  assert.equal(schedulesFromTurn('（例行任務「刪掉兩個亂碼排程」）07:03 刪掉兩個亂碼排程', '').routines.length, 0);
  assert.equal(schedulesFromTurn('（例行任務「入住名單」）這是主機重開後補做的一次。11:20 入住名單', '').routines.length, 0);
  assert.equal(schedulesFromTurn('把 07:03 那個例行任務刪掉', '').routines.length, 0);
  assert.ok(schedulesFromTurn('幫我建立例行任務：每天 09:00 問候客人', '').routines.length >= 1);
});

test('"不要做" sentences stay in the task, and list numbers leave the routine name', () => {
  const sp = splitTaskSchedules('1. 每天 07:30 不要做早餐統計。\n2. 每天 11:20 傳入住名單給房務。4.');
  assert.equal(sp.moved.length, 1);
  assert.match(sp.task, /07:30 不要做/);
  assert.equal(/\d\.?$/.test(sp.moved[0].name), false, sp.moved[0].name);
});

test('the same times with an overlapping name or instruction is the same routine', () => {
  const rows = [{ id: 'r1', name: '入住名單', times: '["11:20"]', prompt: '11:20 傳入住名單給房號快遞員' }];
  assert.equal(sameRoutine(rows, { name: '給房號快遞員入住名單', times: ['11:20'], prompt: '11:20 傳入住名單給房號快遞員' })?.id, 'r1');
  assert.equal(sameRoutine(rows, { name: '入住名單', times: ['12:00'], prompt: 'x' }), null);
  assert.equal(sameRoutine(rows, { name: '早報', times: ['11:20'], prompt: '寫早報' }), null);
});

test('a host that starts again continues the jobs that were cut off', async () => {
  const { db, token, bot, rt } = await setup('care1');
  await call(db, 'POST', 'messages', { token, body: { conv: bot, text: '把今天三間房的密碼傳給客人' } });
  const j1 = await claim(db, rt);
  assert.ok(j1);
  const r = await call(db, 'POST', 'runner/next', { token: rt, body: { slots: 1, wait: false, boot: true } });
  assert.equal(jobRow(db, j1.id).status, 'error');
  assert.equal(jobRow(db, j1.id).err_kind, 'interrupted');
  const j2 = r.data.job || await claim(db, rt);
  assert.ok(j2, 'the cut-off job is handed out again');
  assert.match(j2.prompt, /自動重試 1）上一次做到一半中斷了（主機斷線或重新啟動）.*不要重傳/s);
  const msgs = db.raw.prepare("SELECT text FROM messages WHERE conv=? AND by_='sys'").all(bot).map(x => x.text).join('\n');
  assert.match(msgs, /自動接著做剩下的/);
});

test('work done before a stop is posted, and the retry continues from it', async () => {
  const { db, token, bot, rt } = await setup('care2');
  await call(db, 'POST', 'messages', { token, body: { conv: bot, text: '整理三間房' } });
  const j1 = await claim(db, rt);
  const text = '⚠ AI 很久沒有回應，已中止' + partialNote(['302 完成', '303 完成']);
  assert.ok(text.includes(PARTIAL_TAG));
  await call(db, 'POST', 'runner/done', { token: rt, body: { id: j1.id, ok: false, text, stalled: true, err_kind: 'timeout' } });
  const msgs = db.raw.prepare('SELECT by_,text FROM messages WHERE conv=? ORDER BY id').all(bot);
  assert.ok(msgs.some(m => m.by_ === bot && /先送出已完成的部分[\s\S]*302 完成[\s\S]*303 完成/.test(m.text)));
  const j2 = await claim(db, rt);
  assert.ok(j2);
  assert.match(j2.prompt, /做到一半中斷了/);
  assert.equal(partialNote([]), '');
});

test('every runner call has a time limit, and the general rules cover sending and saving safely', async () => {
  const s = limitSignal(null, 20);
  await new Promise(r => setTimeout(r, 60));
  assert.equal(s.aborted, true);
  const c = new AbortController(), s2 = limitSignal(c.signal, 60000); c.abort();
  assert.equal(s2.aborted, true);
  const all = SAFE_WORK_RULES.join('\n');
  for (const w of ['搜尋框', '不要改傳給別人', '已經傳過', '先傳附件', '逐字比對', '重新讀一次目前最新', '只用 API']) assert.ok(all.includes(w), w);
  const p = buildPrompt({ bot: { id: 'b1', name: '測', engine: 'claude', task: '' }, prompt: '傳訊息', history: [], lang: 'zh-TW' }, '/tmp');
  assert.ok(p.includes('搜尋框'));
});

test('Google saying it cannot sign in to the account counts as a refusal', () => {
  assert.equal(googleRefused('https://accounts.google.com/v3/signin/identifier', '目前無法登入帳戶'), true);
  assert.equal(googleRefused('https://accounts.google.com/v3/signin/identifier', '登入'), false);
  assert.equal(googleRefused('https://example.com/', '目前無法登入帳戶'), false);
});

test('desktop keeps the host awake and restarts a stuck runner', () => {
  const main = readFileSync(join(import.meta.dirname, '..', 'desktop', 'main.mjs'), 'utf8');
  assert.match(main, /powerSaveBlocker\.start\('prevent-app-suspension'\)/);
  assert.match(main, /powerMonitor\.on\('resume'/);
  assert.match(main, /pollAge\(\) > 4 \* 60000/);
});
