import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { buildPrompt, memoryLines, manualLines } from '../public/octa-runner.mjs';

const apiUrl = pathToFileURL(join(import.meta.dirname, '..', 'functions', 'api', '[[path]].js')).href;
const { onRequest, capList, pickManuals, parseManuals, saveManuals, applyRuleUpdates, memoryFor } = await import(apiUrl);
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
    exec: sql => db.exec(sql),
    raw: db
  };
}
let ip = 40;
async function call(db, method, path, { token, body } = {}) {
  const headers = { 'content-type': 'application/json', 'cf-connecting-ip': `203.0.113.${ip++}` };
  if (token) headers.authorization = 'Bearer ' + token;
  const res = await onRequest({
    request: new Request('http://octa.test/api/' + path, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(body || {}) }),
    env: { DB: db, ALLOW_SIGNUP: 'true', TZ_OFFSET_MIN: '480', isLocal: false },
    params: { path: path.split('?')[0].split('/').filter(Boolean) }
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
async function setup(name) {
  const db = openD1();
  const su = await call(db, 'POST', 'signup', { body: { name, pw: 'correcthorsebattery' } });
  const token = su.data.token;
  const bot = (await call(db, 'POST', 'bots', { token, body: { name: '助理', task: '整理報表' } })).data.id;
  const rt = (await call(db, 'POST', 'runner-token', { token, body: { label: 'test-host' } })).data.token;
  return { db, token, bot, rt };
}
// one user message → the runner takes it → finishes with `text`
async function turn(t, prompt, text, extra = {}) {
  await call(t.db, 'POST', 'messages', { token: t.token, body: { conv: t.bot, text: prompt } });
  const next = await call(t.db, 'POST', 'runner/next', { token: t.rt, body: { slots: 1, wait: false } });
  assert.equal(next.status, 200);
  assert.ok(next.data.job, 'runner got a job');
  const done = await call(t.db, 'POST', 'runner/done', { token: t.rt, body: { id: next.data.job.id, ok: true, text, ...extra } });
  assert.equal(done.status, 200);
  return next.data.job;
}

test('capList keeps the newest items within the count and character limits', () => {
  assert.deepEqual(capList(['a', 'b', 'c', 'd'], 2, 100), ['c', 'd']);
  assert.deepEqual(capList(['x'.repeat(50), 'y'.repeat(30), 'z'.repeat(30)], 10, 70), ['y'.repeat(30), 'z'.repeat(30)]);
  assert.deepEqual(capList(undefined, 3, 10), []);
});

test('parseManuals keeps only multi-step playbooks and strips the marker', () => {
  const r = parseManuals('做完了\n📘手冊：下載訂房報表｜打開後台 → 點報表 → 選日期 → 下載 CSV\n📘手冊：太短｜打開 → 關閉');
  assert.equal(r.manuals.length, 1);
  assert.equal(r.manuals[0].name, '下載訂房報表');
  assert.doesNotMatch(r.text, /📘/);
  const block = parseManuals('好\n📘手冊：寄送週報\n1. 打開信箱\n2. 貼上報表\n3. 寄出\n📘結束');
  assert.equal(block.manuals[0].name, '寄送週報');
  assert.match(block.manuals[0].steps, /寄出/);
});

test('pickManuals matches by name or keywords, prefers the most used', () => {
  const list = [
    { name: '下載訂房報表', steps: 'a→b→c', used: 1, ts: 1 },
    { name: '回覆客人訊息', steps: 'a→b→c', used: 0, ts: 2 },
    { name: '訂房報表彙整', steps: 'a→b→c', used: 5, ts: 3 }
  ];
  assert.deepEqual(pickManuals(list, '幫我下載訂房報表').map(m => m.name), ['下載訂房報表', '訂房報表彙整']);
  assert.deepEqual(pickManuals(list, '今天的天氣').map(m => m.name), []);
  assert.deepEqual(pickManuals(list, '有新的客人訊息要回覆嗎').map(m => m.name), ['回覆客人訊息']);
  const many = saveManuals(Array.from({ length: 20 }, (_, i) => ({ name: 'm' + i, steps: 's', used: i === 0 ? 9 : 0, ts: i })), [{ name: 'new', steps: 'x→y→z' }], 99);
  assert.equal(many.length, 20);
  assert.ok(many.some(m => m.name === 'm0'), 'the most used one stays');
  assert.ok(!many.some(m => m.name === 'm1'), 'the oldest unused one goes');
});

test('applyRuleUpdates adds, modifies and deletes rules', () => {
  const r = applyRuleUpdates(['回覆要用敬語', '每天 9 點巡訊息'], '新增：報表日期用西元年；修改：每天 9 點巡訊息 → 每天 8 點巡訊息；刪除：回覆要用敬語');
  assert.deepEqual(r.rules, ['每天 8 點巡訊息', '報表日期用西元年']);
  assert.equal(r.done.length, 3);
  assert.equal(applyRuleUpdates(['已有'], '新增：已有').done.length, 0);
});

test('memoryFor splits rules, facts and only the matching manuals', () => {
  const st = { memory: { b: ['規則一'] }, facts: { b: ['後台網址 https://x.test'] }, manuals: { b: [{ name: '下載報表', steps: '1→2→3' }, { name: '寄信', steps: '1→2→3' }] } };
  const m = memoryFor(st, 'b', '請下載報表');
  assert.deepEqual(m.memory, ['規則一']);
  assert.deepEqual(m.facts, ['後台網址 https://x.test']);
  assert.deepEqual(m.manuals.map(x => x.name), ['下載報表']);
});

test('the runner prompt has a section per memory kind', () => {
  const job = { bot: { id: 'b1', name: '測', engine: 'claude', task: '' }, prompt: '下載報表', history: [], lang: 'zh-TW', memory: ['回覆要簡短'], facts: ['門市電話 02-0000'], manuals: [{ name: '下載報表', steps: '登入 → 報表 → 下載' }] };
  const lines = memoryLines(job).join('\n');
  assert.match(lines, /你的規則[\s\S]*回覆要簡短/);
  assert.match(lines, /你記得的事實[\s\S]*門市電話/);
  assert.match(lines, /做事手冊[\s\S]*【下載報表】/);
  assert.deepEqual(memoryLines({ ...job, memory: [], facts: [], manuals: [] }), []);
  assert.equal(manualLines({ manuals: [] }).length, 0);
  const full = buildPrompt(job, '/tmp/octa-mem');
  assert.match(full, /📇事實/);
  assert.match(full, /📘手冊：名稱｜步驟1/);
  assert.match(full, /【下載報表】/);
});

test('replies save facts and playbooks; the next similar job gets the playbook; settings edit by type', async () => {
  const t = await setup('mia');
  await turn(t, '幫我下載訂房報表', '下載好了。\n📌記住：報表要用西元年\n📇事實：後台網址是 https://admin.example.test\n📘手冊：下載訂房報表｜登入後台 → 點「報表」 → 選日期區間 → 按下載', { browser: true, tokens: 1200 });
  let state = (await call(t.db, 'GET', 'state', { token: t.token })).data;
  assert.deepEqual(state.memory[t.bot], ['報表要用西元年']);
  assert.deepEqual(state.facts[t.bot], ['後台網址是 https://admin.example.test']);
  assert.equal(state.manuals[t.bot][0].name, '下載訂房報表');
  assert.equal(state.review, true);
  const msgs = (await call(t.db, 'GET', 'messages?conv=' + t.bot, { token: t.token })).data;
  const shown = JSON.stringify(msgs);
  assert.doesNotMatch(shown, /📘手冊：/);
  assert.match(shown, /已存成做事手冊/);

  await call(t.db, 'POST', 'messages', { token: t.token, body: { conv: t.bot, text: '再下載一次訂房報表' } });
  const next = (await call(t.db, 'POST', 'runner/next', { token: t.rt, body: { slots: 1, wait: false } })).data.job;
  assert.deepEqual(next.memory, ['報表要用西元年']);
  assert.deepEqual(next.facts, ['後台網址是 https://admin.example.test']);
  assert.equal(next.manuals[0].name, '下載訂房報表');
  await call(t.db, 'POST', 'runner/done', { token: t.rt, body: { id: next.id, ok: false, text: '⚠ 網站打不開' } });
  state = (await call(t.db, 'GET', 'state', { token: t.token })).data;
  assert.equal(state.manuals[t.bot][0].used, 1);

  const put = await call(t.db, 'PUT', 'settings', { token: t.token, body: { memory: { bot: t.bot, type: 'fact', list: ['新事實'] } } });
  assert.equal(put.status, 200);
  await call(t.db, 'PUT', 'settings', { token: t.token, body: { memory: { bot: t.bot, type: 'manual', list: [] } } });
  state = (await call(t.db, 'GET', 'state', { token: t.token })).data;
  assert.deepEqual(state.facts[t.bot], ['新事實']);
  assert.equal(state.manuals[t.bot], undefined);
  assert.deepEqual(state.memory[t.bot], ['報表要用西元年'], 'rules untouched');

  // a playbook with fewer than 3 steps is not saved
  await turn(t, '打招呼', '你好\n📘手冊：打招呼｜說你好');
  state = (await call(t.db, 'GET', 'state', { token: t.token })).data;
  assert.equal(state.manuals[t.bot], undefined);

  // 成果看板
  const board = (await call(t.db, 'GET', 'board', { token: t.token })).data;
  const row = board.bots.find(b => b.id === t.bot);
  assert.equal(row.d7.done, 2);
  assert.equal(row.d7.failed, 1);
  assert.equal(row.d7.rate, 67);
  assert.equal(row.d7.tokens, 1200);
  assert.equal(row.d7.savedMin, 2 * board.est.task + board.est.web);
  assert.equal(row.d30.done, 2);
  assert.ok(row.d7.avgSec !== null);
});

test('weekly review asks the bot, its suggestion needs approval, approval writes the rule', async () => {
  const t = await setup('noa');
  await turn(t, '查一下訂單', '查好了\n📌記住：訂單編號前面要加 #');
  await call(t.db, 'POST', 'messages', { token: t.token, body: { conv: t.bot, text: '再查一次' } });
  const j = (await call(t.db, 'POST', 'runner/next', { token: t.rt, body: { slots: 1, wait: false } })).data.job;
  await call(t.db, 'POST', 'runner/done', { token: t.rt, body: { id: j.id, ok: false, text: '⚠ 找不到訂單頁' } });

  // 「現在檢討一次」: one failure and one correction this week → one review job
  const r = await call(t.db, 'POST', 'review/run', { token: t.token });
  assert.equal(r.data.sent, 1);
  const rv = (await call(t.db, 'POST', 'runner/next', { token: t.rt, body: { slots: 1, wait: false } })).data.job;
  assert.match(rv.prompt, /^（例行任務「每週自我檢討」）/);
  assert.match(rv.prompt, /找不到訂單頁/);
  assert.match(rv.prompt, /訂單編號前面要加 #/);
  await call(t.db, 'POST', 'runner/done', { token: t.rt, body: { id: rv.id, ok: true, text: '這週訂單頁常找不到。\n📌記住：不該直接存\n✅待確認：更新規則：新增：訂單頁打不開就先重新整理一次' } });
  let state = (await call(t.db, 'GET', 'state', { token: t.token })).data;
  assert.deepEqual(state.memory[t.bot], ['訂單編號前面要加 #'], 'nothing written before approval');

  await call(t.db, 'POST', 'messages', { token: t.token, body: { conv: t.bot, text: '核准：更新規則：新增：訂單頁打不開就先重新整理一次' } });
  state = (await call(t.db, 'GET', 'state', { token: t.token })).data;
  assert.deepEqual(state.memory[t.bot], ['訂單編號前面要加 #', '訂單頁打不開就先重新整理一次']);
  const none = (await call(t.db, 'POST', 'runner/next', { token: t.rt, body: { slots: 1, wait: false } })).data.job;
  assert.equal(none, null, 'approval does not start an AI run');
  // the review job itself does not count on the board
  const board = (await call(t.db, 'GET', 'board', { token: t.token })).data;
  const row = board.bots.find(b => b.id === t.bot);
  assert.equal(row.d7.done, 1);
  assert.equal(row.d7.failed, 1);

  // a quiet bot (no failures, no corrections) gets no review
  const q = await setup('ola');
  await turn(q, '你好', '你好');
  assert.equal((await call(q.db, 'POST', 'review/run', { token: q.token })).data.sent, 0);
  // the setting can be switched off
  assert.equal((await call(q.db, 'PUT', 'settings', { token: q.token, body: { review: false } })).status, 200);
  assert.equal((await call(q.db, 'GET', 'state', { token: q.token })).data.review, false);
});

test('older databases get the stats table', async () => {
  const db = openD1();
  db.exec('DROP TABLE stats');
  const su = await call(db, 'POST', 'signup', { body: { name: 'pia', pw: 'correcthorsebattery' } });
  assert.equal(su.status, 200);
  const board = await call(db, 'GET', 'board', { token: su.data.token });
  assert.equal(board.status, 200);
  assert.deepEqual(board.data.bots, []);
});

test('the settings page has the board, the review switch and the memory kinds', () => {
  const html = readFileSync(join(import.meta.dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(html, /\['board','📊','成果看板'/);
  assert.match(html, /board:\(\)=>openBoard\(\)/);
  assert.match(html, /api\('board'\)/);
  assert.match(html, /id="scRev"/);
  assert.match(html, /function memHtml\(c\)/);
  assert.match(html, /memory:\{bot:c\.id,type:t,list\}/);
  const dict = readFileSync(join(import.meta.dirname, '..', 'public', 'i18n-dict.js'), 'utf8');
  for (const k of ['成果看板', '做事手冊', '每週自我檢討', '估計省下']) assert.ok(dict.includes(`"${k}"`), k + ' is translated');
});
