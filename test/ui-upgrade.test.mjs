// 介面升級（四個 Grok Bot 的評論）：畫面不亂跳、傳給、存檔只按一次、核准卡、排程狀態、群組成員狀態。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const root = join(import.meta.dirname, '..');
const read = p => readFileSync(join(root, p), 'utf8');
const page = read('public/index.html');
const { onRequest } = await import(pathToFileURL(join(root, 'functions', 'api', '[[path]].js')).href);

// the page's plain functions, loaded on their own
const pure = (() => {
  const a = page.indexOf('/* ui-pure:start'), b = page.indexOf('/* ui-pure:end */');
  assert.ok(a > 0 && b > a, 'ui-pure block present');
  return new Function(page.slice(a, b) + '\nreturn { APPR, apprDecision, apprImpact, apprStrip, rtStatus, memberState };')();
})();
// a function's source text inside the page (from its declaration to the next top-level declaration)
const fnSrc = name => {
  const re = new RegExp('\\n(?:async )?function ' + name + '\\(|\\nconst ' + name + '=');
  const m = re.exec(page); assert.ok(m, name + ' exists');
  const rest = page.slice(m.index + 1);
  const end = rest.slice(1).search(/\n(?:async function |function |const |let |\$\('|\/\* )/);
  return end < 0 ? rest : rest.slice(0, end + 1);
};

function openD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(read('schema.sql'));
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
let ip = 10, n = 0;
async function call(db, method, path, { token, body, query } = {}) {
  const headers = { 'content-type': 'application/json', 'cf-connecting-ip': `192.0.2.${ip++ % 250}` };
  if (token) headers.authorization = 'Bearer ' + token;
  const url = new URL('http://octa.test/api/' + path);
  for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);
  const req = new Request(url, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(body || {}) });
  const res = await onRequest({ request: req, env: { DB: db, ALLOW_SIGNUP: 'true', TZ_OFFSET_MIN: '480', isLocal: false }, params: { path: path.split('/').filter(Boolean) } });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
async function setup() {
  const db = openD1();
  const su = await call(db, 'POST', 'signup', { body: { name: 'ui' + n++, pw: 'correcthorsebattery' } });
  const token = su.data.token;
  const rt = (await call(db, 'POST', 'runner-token', { token, body: { label: 'host' } })).data.token;
  const user = db.raw.prepare('SELECT id FROM users LIMIT 1').get().id;
  const bot = async name => (await call(db, 'POST', 'bots', { token, body: { name, task: '' } })).data.id;
  const msg = (conv, by, text, ago = 0) => db.raw.prepare('INSERT INTO messages (user_id,conv,by_,text,ts) VALUES (?,?,?,?,?)').run(user, conv, by, text, Date.now() - ago);
  const next = () => call(db, 'POST', 'runner/next', { token: rt, body: { slots: 0, wait: false } });
  const settings = st => db.raw.prepare('UPDATE users SET settings=? WHERE id=?').run(JSON.stringify(st), user);
  const getSt = () => JSON.parse(db.raw.prepare('SELECT settings FROM users WHERE id=?').get(user).settings || '{}');
  return { db, token, rt, user, bot, msg, next, settings, getSt };
}

/* ---------- 1. 畫面不會亂跳、訊息不會傳錯人 ---------- */
test('nothing but your own tap changes the open chat', () => {
  // another device's focus only shows a hint; it never opens that chat
  const refresh = fnSrc('refresh');
  assert.match(refresh, /followRemote\(d\.focus\)/);
  assert.doesNotMatch(refresh, /openConv\(/);
  assert.doesNotMatch(refresh, /publishFocus\(cur\)/, 'no focus ping-pong between devices');
  assert.doesNotMatch(fnSrc('followRemote'), /openConv\(/);
  assert.match(fnSrc('followRemote'), /showHint\(/);
  // clearing the box no longer jumps to the chat another device is looking at
  const input = page.match(/\$\('msg'\)\.addEventListener\('input',\(\)=>\{grow\(\)[^\n]*/)[0];
  assert.doesNotMatch(input, /openConv/);
  // new replies elsewhere: a hint while a chat is open
  assert.match(fnSrc('notifyNew'), /showHint\(c,/);
  // an automatic switch is refused while something is being written
  const open = fnSrc('openConv');
  assert.match(open, /opt\.auto&&id!==cur&&composing\(\)/);
  assert.match(fnSrc('composing'), /pending\.length/);
  // attachments stay with their own chat
  assert.match(open, /PEND\[cur\]=pending/);
  // every remaining openConv( call is a tap, a notification click or a new bot you just made
  const calls = [...page.matchAll(/openConv\(([^)]*)\)/g)].map(m => m[1]);
  assert.ok(calls.every(c => !/remote/.test(c)), 'no {remote:true} switches left: ' + calls.join(' | '));
});

test('傳給 names the receiver and the send key uses it', () => {
  assert.match(page, /<div class="sendto" id="sendTo" hidden><\/div>\s*<form class="in" id="f"/);
  const paint = fnSrc('paintTo');
  assert.match(paint, /傳給：/);
  assert.match(paint, /\$\('f'\)\.dataset\.to=cur/);
  const submit = page.slice(page.indexOf("$('f').onsubmit="), page.indexOf("$('f').onsubmit=") + 1500);
  assert.match(submit, /const to=\$\('f'\)\.dataset\.to\|\|cur/);
  assert.match(submit, /sendMsg\(v,files,undefined,rid,to\)/);
  assert.match(submit, /Date\.now\(\)-TO\.at<700/, 'a receiver that changed a moment ago needs one more press');
  assert.match(fnSrc('sendMsg'), /const c=to\|\|cur/);
  // phone layout keeps the line too
  assert.match(page, /\n\s+\.sendto\{justify-content:flex-start/);
});

/* ---------- 2. 存檔只按一次 ---------- */
test('one 儲存 saves the inner forms, flags unsaved edits and asks before closing', () => {
  const close = fnSrc('closeSheet');
  assert.match(close, /force!==true&&isDirty\(\)/);
  assert.match(fnSrc('leaveOk'), /還有沒儲存的變更/);
  const sheet = fnSrc('sheet');
  assert.match(sheet, /rf\._save\(true\)/, 'the open routine form is saved by the outer 儲存');
  assert.match(sheet, /sheet\.addMem/, 'a typed memory line is added by the outer 儲存');
  assert.match(sheet, /trackDirty\(\$\('sf'\),saveAll\)/);
  assert.match(sheet, /data-dirty-flag/);
  assert.match(sheet, /已儲存 ✓/);
  assert.match(fnSrc('renderRoutines'), /f\._save=async quiet=>/);
  for (const f of ['folderSheet', 'openNotes', 'openNotify', 'openProfile']) assert.match(fnSrc(f), /trackDirty\(/, f + ' tracks edits');
  assert.match(fnSrc('subSheet'), /leaveOk\(/);
  assert.match(page, /\.snav \[data-s\]'\)\.forEach\(b=>b\.onclick=\(\)=>leaveOk\(/, 'switching settings pages asks first');
});

/* ---------- 3. 核准會講清楚、不會被漏看 ---------- */
test('a 待確認 card knows when it is decided, by whom and when', () => {
  const { apprDecision } = pure;
  const ask = { id: 5, by: 'b1', text: '我整理好了。\n✅待確認：把 3 筆回覆傳給客人', ts: 1 };
  assert.deepEqual(apprDecision(ask, []), { state: 'wait', act: '把 3 筆回覆傳給客人', plan: false });
  assert.equal(apprDecision(ask, [{ by: 'me', text: '核准：把 3 筆回覆傳給客人', ts: 9 }]).state, 'ok');
  assert.equal(apprDecision(ask, [{ by: 'me', text: '核准：把 3 筆回覆傳給客人', ts: 9 }]).at, 9);
  assert.equal(apprDecision(ask, [{ by: 'me', text: '核准：x（以後這類事一律允許：x）', ts: 9 }]).always, true);
  assert.equal(apprDecision(ask, [{ by: 'me', text: '不要做：把 3 筆回覆傳給客人。這件事先停下，不用再問。', ts: 9 }]).state, 'no');
  assert.equal(apprDecision(ask, [{ by: 'me', text: '先等一下', ts: 9 }]).state, 'answered');
  assert.equal(apprDecision(ask, [{ by: 'b1', text: '我先做別的', ts: 9 }]).state, 'stale');
  assert.equal(apprDecision(ask, [{ by: 'b2', text: '收到', ts: 9 }]).state, 'wait', 'another member talking does not decide it');
  // in a group, words for another member leave the card waiting; words for this bot decide it
  assert.equal(apprDecision(ask, [{ by: 'me', text: '@乙 你先查', ts: 9 }], '甲').state, 'wait');
  assert.equal(apprDecision(ask, [{ by: 'me', text: '@甲 核准：把 3 筆回覆傳給客人', ts: 9 }], '甲').state, 'ok');
  // the plan card
  assert.equal(apprDecision({ id: 1, by: 'b1', text: '📋計畫\n1. 查\n✅待確認：照計畫執行' }, []).plan, true);
  assert.equal(apprDecision({ id: 1, by: 'b1', text: '沒有要確認的事' }, []), null);
});

test('the card says what the action touches', () => {
  const { apprImpact, apprStrip } = pure;
  assert.equal(apprImpact('付款 1200 元', ''), '會花錢，付出去就收不回來');
  assert.equal(apprImpact('刪除舊訂單', ''), '刪掉後無法復原');
  assert.equal(apprImpact('把回覆傳給客人', ''), '訊息會送到對方那邊，送出就收不回來');
  assert.equal(apprImpact('更新規則：新增：xx', ''), '會改寫它的規則，之後每次工作都照新規則做');
  assert.equal(apprImpact('照計畫執行', ''), '照計畫開始做，做完會回報');
  assert.equal(apprImpact('付款', '說明\n影響：只動到測試帳號'), '只動到測試帳號', "the bot's own 影響 line wins");
  assert.equal(apprImpact('看一下報表', ''), '照上面寫的去做，做完會回報');
  assert.equal(apprStrip('整理好了。\n\n✅待確認：傳給客人\n影響：客人會收到'), '整理好了。');
  // the impact lines are translated
  const strings = read('i18n/strings.py');
  for (const s of ['會花錢，付出去就收不回來', '刪掉後無法復原', '待你核准', '件待你核准', '誰要做', '會影響', '已核准', '已拒絕']) assert.ok(strings.includes(`'${s}'`), s + ' translated');
});

test('waiting 核准 are counted at the top, on 小八, and noticed again after 15 minutes', () => {
  assert.match(page, /class="apbar" data-apgo=/);
  assert.match(fnSrc('buddySync'), /apprConvs\(\)\.length/);
  assert.match(page, /<i class="need ap">待你核准<\/i>/);
  const nag = fnSrc('apprNag');
  assert.match(page, /const NAG_MS=15\*60000/);
  assert.match(nag, /new Notification\(/);
  assert.match(nag, /octa_nag/);
  assert.match(page, /setInterval\(apprNag,60000\)/);
});

test('the list knows about a 待確認 past the 140-character preview', async () => {
  const t = await setup();
  const b = await t.bot('房號快遞員');
  t.msg(b, b, '今天的房號整理如下：\n' + '101 102 103 105 106 107 '.repeat(12) + '\n✅待確認：把房號表傳給 Fongting');
  const st = (await call(t.db, 'GET', 'state', { token: t.token })).data;
  const l = st.last.find(x => x.conv === b);
  assert.ok(l.text.length <= 140);
  assert.ok(!/待確認/.test(l.text), 'the preview alone would miss it');
  assert.match(l.ask, /^\n?✅待確認：把房號表傳給 Fongting/);
  assert.ok(pure.APPR.test(l.ask));
  t.msg(b, 'me', '好');
  const st2 = (await call(t.db, 'GET', 'state', { token: t.token })).data;
  assert.equal(st2.last.find(x => x.conv === b).ask, null);
});

test('a 核准 left 15 minutes gets one more Telegram message, once', async () => {
  const t = await setup();
  const a = await t.bot('房號快遞員'), c = await t.bot('補助小獵人'), d = await t.bot('Eroom整備員');
  t.settings({ tg: { token: 'T', chat: '42' }, review: false });
  t.msg(a, a, '整理好了\n✅待確認：把房號表傳給 Fongting', 20 * 60000);   // waiting 20 minutes
  t.msg(c, c, '✅待確認：送出補助申請', 5 * 60000);                     // only 5 minutes: not yet
  t.msg(d, d, '✅待確認：清空舊紀錄', 30 * 60000); t.msg(d, 'me', '核准：清空舊紀錄', 25 * 60000);   // already answered
  const sent = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts) => { sent.push({ url: String(url), body: JSON.parse(opts.body) }); return new Response('{}', { status: 200 }); };
  try {
    await t.next();
    assert.equal(sent.length, 1);
    assert.match(sent[0].url, /api\.telegram\.org\/botT\/sendMessage/);
    assert.match(sent[0].body.text, /還有 1 件等你核准/);
    assert.match(sent[0].body.text, /房號快遞員：把房號表傳給 Fongting（等了 20 分鐘）/);
    assert.doesNotMatch(sent[0].body.text, /補助|清空/);
    assert.ok(t.getSt().nagged.length === 1);
    // later looks don't repeat it (the once-a-minute limit is skipped by moving the clock)
    const realNow = Date.now;
    Date.now = () => realNow() + 2 * 60000;
    try { await t.next(); } finally { Date.now = realNow; }
    assert.equal(sent.length, 1);
    // the 5-minute one becomes due later and is sent by itself
    Date.now = () => realNow() + 12 * 60000;
    try { await t.next(); } finally { Date.now = realNow; }
    assert.equal(sent.length, 2);
    assert.match(sent[1].body.text, /補助小獵人：送出補助申請/);
    assert.doesNotMatch(sent[1].body.text, /房號表/);
  } finally { globalThis.fetch = real; }
});

test('a muted chat or a card the bot moved past is not nagged', async () => {
  const t = await setup();
  const a = await t.bot('甲'), b = await t.bot('乙');
  t.settings({ tg: { token: 'T', chat: '42' }, review: false, mute: { [a]: 1 } });
  t.msg(a, a, '✅待確認：傳訊息', 20 * 60000);
  t.msg(b, b, '✅待確認：傳訊息', 20 * 60000); t.msg(b, b, '我先做別的了', 18 * 60000);
  const sent = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts) => { sent.push(opts.body); return new Response('{}', { status: 200 }); };
  try { await t.next(); } finally { globalThis.fetch = real; }
  assert.equal(sent.length, 0);
});
