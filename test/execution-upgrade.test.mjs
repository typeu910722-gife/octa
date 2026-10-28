// 執行力與群組協作: 旁聊 while a bot works, stop still stops, the result line, API-first / log back in / look first /
// files / group hand-over prompt rules, and the in-process wake-up that makes the host computer react faster.
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { buildPrompt, buildBrowserPrompt, buildLocalPrompt, sideNote, loginHints, hideSecrets, findUploads, triedText, sideReport } from '../public/octa-runner.mjs';
import { connectorLines, runConnector } from '../public/connectors.mjs';

const apiUrl = pathToFileURL(join(import.meta.dirname, '..', 'functions', 'api', '[[path]].js')).href;
const { onRequest, sideKind, missingResult } = await import(apiUrl);
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
    exec: sql => db.exec(sql), raw: db
  };
}
let ip = 10, n = 0;
async function call(db, method, path, { token, body, query, env } = {}) {
  const headers = { 'content-type': 'application/json', 'cf-connecting-ip': `198.51.100.${ip++ % 250}` };
  if (token) headers.authorization = 'Bearer ' + token;
  const url = new URL('http://octa.test/api/' + path);
  for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);
  const req = new Request(url, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(body || {}) });
  const res = await onRequest({ request: req, env: { DB: db, ALLOW_SIGNUP: 'true', TZ_OFFSET_MIN: '480', isLocal: false, ...env }, params: { path: path.split('/').filter(Boolean) } });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
async function setup() {
  const db = openD1();
  const token = (await call(db, 'POST', 'signup', { body: { name: 'exe' + n++, pw: 'correcthorsebattery' } })).data.token;
  const rt = (await call(db, 'POST', 'runner-token', { token, body: { label: 'host' } })).data.token;
  const bot = async (name, task = '') => (await call(db, 'POST', 'bots', { token, body: { name, task } })).data.id;
  const say = (conv, text) => call(db, 'POST', 'messages', { token, body: { conv, text } });
  const next = async () => (await call(db, 'POST', 'runner/next', { token: rt, body: { slots: 3, wait: false } })).data.job;
  const done = (id, text, extra = {}) => call(db, 'POST', 'runner/done', { token: rt, body: { id, ok: true, text, ...extra } });
  const progress = (id, text) => call(db, 'POST', 'runner/progress', { token: rt, body: { id, text } });
  const msgs = async conv => (await call(db, 'GET', 'messages', { token, query: { conv } })).data.msgs;
  const row = id => db.raw.prepare('SELECT * FROM jobs WHERE id=?').get(id);
  const open = () => db.raw.prepare("SELECT * FROM jobs WHERE status IN ('pending','running') ORDER BY id").all();
  return { db, token, rt, bot, say, next, done, progress, msgs, row, open };
}

test('sideKind: stop, change of plan, or a side chat', () => {
  for (const t of ['停', '停止', '先停一下', '取消', '算了', '不用了', '別做了', '停止目前的工作', 'stop']) assert.equal(sideKind(t), 'stop', t);
  for (const t of ['改成查明天的', '順便把 302 也看一下', '核准：照計畫執行', '先別送出', '']) assert.equal(sideKind(t), 'later', t);
  for (const t of ['你現在在做什麼？', '停車場在哪', '今天天氣怎樣', '謝謝你']) assert.equal(sideKind(t), 'side', t);
});

test('旁聊: a message while the bot works gets its own quick job; the work keeps running and finishes', async () => {
  const t = await setup();
  const a = await t.bot('房號快遞員', '每天整理房號');
  await t.say(a, '把今天的房號整理好傳給 Fongting');
  const main = await t.next();
  assert.ok(main && !main.side);
  await t.progress(main.id, '讀取網頁');
  await t.say(a, '你現在在幹嘛？');
  const side = await t.next();
  assert.ok(side, 'the side chat is handed out while the work still runs');
  assert.equal(side.bot.id, a);
  assert.match(side.side.doing, /把今天的房號整理好/);
  assert.equal(side.side.progress, '讀取網頁');
  assert.equal(t.row(main.id).status, 'running', 'the work was not touched');
  await t.say(a, '那今天幾間？');
  assert.equal(await t.next(), null, 'one side chat at a time');
  await t.done(side.id, '我正在讀 eroom 的房況，大概再兩分鐘。');
  assert.equal(t.row(main.id).status, 'running');
  const side2 = await t.next();
  assert.ok(side2?.side, 'the next side chat runs after the first');
  await t.done(side2.id, '整理完就跟你說。');
  const p = await t.progress(main.id, '整理回覆中');
  assert.ok(!p.data.stop, 'the work was not asked to stop');
  await t.done(main.id, '房號整理好了。\n✅ 完成：已傳給 Fongting');
  const said = (await t.msgs(a)).filter(m => m.by === a).map(m => m.text);
  assert.deepEqual(said, ['我正在讀 eroom 的房況，大概再兩分鐘。', '整理完就跟你說。', '房號整理好了。\n✅ 完成：已傳給 Fongting']);
  assert.equal(t.open().length, 0);
});

test('a stop message still stops the work; a change of plan waits for it', async () => {
  const t = await setup();
  const a = await t.bot('甲');
  await t.say(a, '整理這週的訂單');
  const main = await t.next();
  await t.say(a, '先停一下');
  assert.equal(t.row(main.id).status, 'error');
  assert.ok((await t.progress(main.id, '還在跑')).data.stop, 'the runner hears the stop on its next progress');
  assert.ok((await t.msgs(a)).some(m => m.by === 'sys' && m.text === '已停止目前的任務'));
  assert.equal(t.open().length, 0, 'no job for the stop message itself');

  await t.say(a, '整理這週的訂單');
  const main2 = await t.next();
  await t.say(a, '改成整理上週的');
  assert.ok((await t.msgs(a)).some(m => m.by === 'sys' && /正在做「整理這週的訂單」，做完就接著處理這則/.test(m.text)));
  assert.equal(await t.next(), null, 'the change is not run beside the work');
  await t.done(main2.id, '這週的整理好了');
  const after = await t.next();
  assert.equal(after.prompt, '改成整理上週的');
  assert.equal(after.side, null);
});

test('旁聊 that needs the browser runs again after the work; a side chat after the work is an ordinary turn', async () => {
  const t = await setup();
  const a = await t.bot('乙');
  await t.say(a, '巡一次 LINE');
  const main = await t.next();
  await t.say(a, '幫我看一下 eroom 現在幾間待掃');
  const side = await t.next();
  await t.done(side.id, '好，手上這件做完我就接著看。', { later: true });
  assert.equal(await t.next(), null, 'waits for the work');
  await t.done(main.id, '巡完了，沒有新訊息');
  const again = await t.next();
  assert.equal(again.prompt, '幫我看一下 eroom 現在幾間待掃');
  assert.equal(again.side, null);
  await t.done(again.id, '待掃 3 間');

  await t.say(a, '巡一次 LINE');
  const m2 = await t.next();
  await t.say(a, '你好嗎');
  await t.done(m2.id, '巡完了');   // the work ends before the side chat is picked up
  const late = await t.next();
  assert.equal(late.side, null, 'nothing to be beside any more');
  assert.equal(t.row(late.id).via, null);
});

test('a group message still queues (no side chat in groups)', async () => {
  const t = await setup();
  const a = await t.bot('丙'), b = await t.bot('丁');
  const g = (await call(t.db, 'POST', 'groups', { token: t.token, body: { name: '群', task: '', members: [a, b] } })).data.id;
  await t.say(a, '整理訂單');
  const main = await t.next();
  await t.say(g, '@丙 你在幹嘛');
  const nx = await t.next();
  assert.equal(nx, null);
  await t.done(main.id, '好了');
});

test('result line: a send job without ✅ 完成／⚠ 沒做成 gets a reminder; a question about it does not', async () => {
  assert.equal(missingResult('把報表傳給 Fongting', '好了'), true);
  assert.equal(missingResult('把報表傳給 Fongting', '報表已傳。\n✅ 完成：傳給 Fongting'), false);
  assert.equal(missingResult('把報表傳給 Fongting', '⚠ 沒做成：LINE 登出了，登入後再傳'), false);
  assert.equal(missingResult('把報表傳給 Fongting', '✅待確認：傳報表給 Fongting'), false);
  assert.equal(missingResult('你有傳給 Fongting 嗎？', '有，早上傳了'), false);
  assert.equal(missingResult('（例行任務「早報」）整理早報傳給 Yzz', '（略過）'), false);
  assert.equal(missingResult('今天幾間待掃', '3 間'), false);
  const t = await setup();
  const a = await t.bot('戊');
  await t.say(a, '把今天的回報傳給 Fongting');
  let j = await t.next();
  await t.done(j.id, '回報整理好了');
  assert.ok((await t.msgs(a)).some(m => m.by === 'sys' && /沒有寫明結果/.test(m.text)));
  await t.say(a, '再傳一次');
  j = await t.next();
  await t.done(j.id, '已傳。\n✅ 完成：Fongting 的對話裡看得到');
  assert.equal((await t.msgs(a)).filter(m => m.by === 'sys' && /沒有寫明結果/.test(m.text)).length, 1);
});

// ---------- prompts ----------
const base = extra => ({ id: 1, kind: 'chat', prompt: '整理房號', bot: { id: 'b1', name: '房號快遞員', task: '整理房號', engine: 'claude' }, history: [], memory: [], facts: [], manuals: [], lang: 'zh-TW', ...extra });

test('prompt rules: API first, log back in, look before asking, files, result line', () => {
  const p = buildPrompt(base({ colleagues: [{ name: '乙', task: '' }], canAsk: true }), '/tmp/x');
  assert.match(p, /能用 API、公開資料或連接器做到的先用/);
  assert.match(p, /Bash 跑 curl 或 node fetch/);
  assert.match(p, /帳密、API 金鑰從共用資料、分區資料或連接器拿，不要寫進回覆/);
  assert.match(p, /會先自己登回去/);
  assert.match(p, /卡住或缺資料.*不要乾等：先查共用資料、分區資料、工作筆記、紀錄檔/);
  assert.match(p, /先用 Glob 在這個對話的資料夾/);
  assert.match(p, /不要叫使用者把檔案放到指定位置/);
  assert.match(p, /回頭確認真的成功/);
  assert.match(p, /「✅ 完成：做了什麼」或「⚠ 沒做成：原因＋下一步」/);
  assert.match(p, /該做的沒做成一定要回報/);
  assert.ok(!/需要輸入帳號密碼、驗證碼或手機確認時，派瀏覽停在那一頁/.test(p), 'the old "stop at the login page" rule is gone');
  assert.match(buildLocalPrompt(base({ bot: { ...base().bot, engine: 'opencode' } }), '/tmp/x'), /⚠ 沒做成/);
});

test('group prompt: see what the others did, fill the gap, hand over, leave a word', () => {
  const g = buildPrompt(base({ group: { name: '貳宿', task: '', members: ['房號快遞員', '整備員'], mode: 'turns' }, canAsk: true }), '/tmp/x');
  assert.match(g, /先看其他成員已經做了什麼、還缺什麼：做過的不要重做，缺的你能補就補，該由別人做就 @交接；做完在群組留一句交代/);
  assert.match(g, /資訊不夠時先自己找、問同事，都沒有才問使用者/);
});

test('旁聊 prompt: says what the bot is busy with, no browser, no records or page picture', () => {
  const job = base({ side: { doing: '把今天的房號整理好傳給 Fongting', progress: '讀取網頁' }, prompt: '你在幹嘛' });
  const p = buildPrompt(job, '/tmp/x');
  assert.ok(p.includes(sideNote(job)));
  assert.match(p, /你手上正在做「把今天的房號整理好傳給 Fongting」（目前：讀取網頁）/);
  assert.match(p, /不開瀏覽器、不寫【派瀏覽】/);
  assert.match(p, /【稍後】/);
  assert.ok(!p.includes('你的讀取紀錄資料夾'), 'no record list');
  assert.ok(!p.includes('這輪還沒有現成的圖'), 'no page picture rules');
  const full = buildPrompt(base({}), '/tmp/x');
  assert.ok(p.length < full.length - 500, `side ${p.length} vs full ${full.length}`);
});

test('browse round: logs back in by itself with 共用資料, reports what it tried, keeps passwords out', () => {
  const job = base({ notes: '店名：貳宿\neroom 後台 https://eroom.yzprojecttw.com\n帳號：yzz 密碼：Secret123\n營業時間 9-18', folderNotes: 'LINE 官方帳號用「LINE 登入」' });
  const hints = loginHints(job);
  assert.match(hints, /eroom 後台/);
  assert.match(hints, /密碼：Secret123/);
  assert.match(hints, /LINE 登入/);
  assert.ok(!hints.includes('營業時間'));
  const w = buildBrowserPrompt(job, { url: 'https://eroom.yzprojecttw.com', prompt: '讀房況' }, '/tmp/x');
  assert.match(w, /先自己登回去：點已記住的帳號.*「LINE 登入」/);
  assert.match(w, /登入資料（只拿來登入，不要寫進報告）/);
  assert.match(w, /試過哪些方法/);
  assert.match(w, /回頭看畫面確認真的出現了/);
  assert.match(w, /browser_file_upload/);
  assert.equal(hideSecrets('我用 Secret123 登入了', job), '我用 •••• 登入了');
  assert.equal(triedText('網址：https://x\n頁面上有什麼：登入頁\n做成了什麼：沒有\n卡在哪裡：需要使用者在電腦上登入。點了 LINE 登入還是回到登入頁，共用資料沒有密碼'), '點了 LINE 登入還是回到登入頁，共用資料沒有密碼');
  assert.equal(loginHints(base({})), '');
});

test('files to upload are found in the bot\'s own folders by name', () => {
  const root = mkdtempSync(join(tmpdir(), 'octa-up-'));
  mkdirSync(join(root, '貳宿_ab12', '輸出'), { recursive: true });
  writeFileSync(join(root, '貳宿_ab12', '輸出', '10月對帳.pdf'), 'x');
  const abs = join(root, 'a.png'); writeFileSync(abs, 'x');
  const got = findUploads(`把 10月對帳.pdf 上傳到 LINE，再附上 ${abs}，還有 沒有這個.pdf`, [join(root, 'nope'), root]);
  assert.deepEqual(got, [join(root, '貳宿_ab12', '輸出', '10月對帳.pdf'), abs]);
  assert.deepEqual(findUploads('看一下訂單', [root]), []);
});

test('connectors: a JSON body goes to your own service as JSON; the bot is told it can', async () => {
  const st = { connectors: [{ name: 'eroom', base: 'https://eroom.example.com/api', header: 'Authorization', secret: 'Bearer k-123456' }] };
  let sent;
  const fetchImpl = async (url, init) => { sent = { url: String(url), init }; return new Response('{"ok":true}', { status: 200 }); };
  await runConnector(st, { name: 'eroom', action: '送出', path: '/rooms/302', content: '{"status":"clean"}' }, { approved: true, fetchImpl });
  assert.equal(sent.init.body, '{"status":"clean"}');
  await runConnector(st, { name: 'eroom', action: '送出', path: '/note', content: '302 已掃' }, { approved: true, fetchImpl });
  assert.equal(sent.init.body, JSON.stringify({ text: '302 已掃' }));
  const lines = connectorLines([{ name: 'eroom', kind: 'http', can: ['讀取', '送出'] }]).join('\n');
  assert.match(lines, /可以直接寫 JSON/);
});

// ---------- 反應快 ----------
test('host computer: a new message wakes the runner\'s long-poll at once (not on the next 1.5 s look)', async () => {
  const db = openD1();
  db.raw.prepare("INSERT INTO users (id,name,pw,created) VALUES ('local','本機','-',?)").run(Date.now());
  const env = { isLocal: true };
  const bot = (await call(db, 'POST', 'bots', { env, body: { name: '助理', task: '' } })).data.id;
  await call(db, 'POST', 'runner/next', { env, body: { slots: 3, wait: false } });
  const times = [];
  for (let i = 0; i < 5; i++) {
    const waiting = call(db, 'POST', 'runner/next', { env, body: { slots: 3, wait: true } });
    await new Promise(r => setTimeout(r, 300 + i * 170));   // somewhere inside the 1.5 s look
    const t0 = performance.now();
    await call(db, 'POST', 'messages', { env, body: { conv: bot, text: '第' + i + '則' } });
    const got = await waiting;
    times.push(performance.now() - t0);
    assert.equal(got.data.job?.prompt, '第' + i + '則');
    await call(db, 'POST', 'runner/done', { env, body: { id: got.data.job.id, ok: true, text: '好' } });
  }
  assert.ok(Math.max(...times) < 400, 'picked up within a few ms: ' + times.map(x => x.toFixed(0)).join(', '));
  // the open page's /api/wait wakes too
  const rev = (await call(db, 'GET', 'wait', { env, query: { rev: -5 } })).data.rev;
  const w = call(db, 'GET', 'wait', { env, query: { rev } });
  await new Promise(r => setTimeout(r, 200));
  const t0 = performance.now();
  await call(db, 'POST', 'messages', { env, body: { conv: bot, text: '再一則' } });
  await w;
  assert.ok(performance.now() - t0 < 400);
});

test('a slow quota or model check does not hold up asking for the next job', async () => {
  let calls = 0;
  const slow = sideReport(() => new Promise(r => setTimeout(() => r({ n: ++calls }), 300)));
  const t0 = performance.now();
  assert.equal(slow(), undefined);
  assert.ok(performance.now() - t0 < 50, 'returns at once');
  assert.equal(slow(), undefined, 'still running: not started twice');
  await new Promise(r => setTimeout(r, 350));
  assert.deepEqual(slow(), { n: 1 }, 'the result goes up with the next ask');
  assert.equal(calls, 1);
});

// ---------- the runner itself: the work and a side chat at the same time ----------
test('runner: a side chat runs beside the work (own folder, no AI 待機 session) and does not interrupt it', { skip: process.platform === 'win32' }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'octa-side-'));
  const bin = join(home, 'bin'); mkdirSync(bin);
  // a fake Claude Code: the work takes 2.5 s (also as an AI 待機 session), a 旁聊 answers at once; each says where it ran
  writeFileSync(join(bin, 'claude'), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--help')) { console.log('  --tools <tools...>  --disable-slash-commands'); process.exit(0); }
const out = (text) => process.stdout.write(JSON.stringify({ type: 'result', result: text + ' @' + require('path').basename(process.cwd()), usage: { input_tokens: 1 } }) + '\\n');
let buf = '';
process.stdin.on('data', d => {
  buf += d;
  if (!args.includes('--input-format')) return;
  let i; while ((i = buf.indexOf('\\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); const m = JSON.parse(l).message.content; setTimeout(() => out('工作做完了'), /旁聊/.test(m) ? 0 : 2500); }
});
process.stdin.on('end', () => { if (args.includes('--input-format')) return; if (/旁聊/.test(buf)) out('我正在整理房號'); else setTimeout(() => { out('工作做完了'); process.exit(0); }, 2500); });
`);
  chmodSync(join(bin, 'claude'), 0o755);
  const oldPath = process.env.PATH, oldHome = process.env.HOME;
  process.env.PATH = bin + ':' + oldPath; process.env.HOME = home;
  const hist = [{ id: 1, who: '使用者', text: '整理房號', files: [] }];
  const job = (id, prompt, side) => ({ id, kind: 'chat', prompt, warm: 120, bot: { id: 'bot1', name: '房號快遞員', task: '整理房號', engine: 'claude', browser: 'own' }, conv: { id: 'bot1', name: '房號快遞員' }, history: hist, memory: [], facts: [], manuals: [], lang: 'zh-TW', ...(side ? { side } : {}) });
  const queue = [job(1, '整理房號')], done = [], progress = [];
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', d => b += d); req.on('end', () => {
      const body = b ? JSON.parse(b) : {}, p = req.url.replace('/api/', '');
      const send = o => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (p === 'runner/next') return queue.length ? send({ job: queue.shift() }) : setTimeout(() => send({ job: null }), 100);
      if (p === 'runner/progress') { progress.push(body); return send({ ok: true }); }
      if (p === 'runner/done') { done.push({ ...body, at: Date.now() }); return send({ ok: true }); }
      send({ ok: true, watches: [] });
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const { startRunner } = await import('../public/octa-runner.mjs');
  const r = startRunner({ url: 'http://127.0.0.1:' + srv.address().port, token: 't', home, pwCli: join(home, 'none.js'), chrome: join(home, 'no-chrome'), log: () => { } });
  try {
    const t0 = Date.now();
    while (!progress.some(x => x.id === 1) && Date.now() - t0 < 5000) await new Promise(r => setTimeout(r, 50));
    queue.push(job(2, '你在幹嘛', { doing: '整理房號', progress: '開始工作' }));
    while (done.length < 2 && Date.now() - t0 < 15000) await new Promise(r => setTimeout(r, 50));
    assert.equal(done.length, 2, 'both finished: ' + JSON.stringify(done));
    assert.equal(done[0].id, 2, 'the side chat answered first, while the work was still running: ' + JSON.stringify(done));
    assert.match(done[0].text, /我正在整理房號 @bot1-side/, 'in its own folder');
    assert.equal(done[1].id, 1);
    assert.match(done[1].text, /工作做完了 @bot1$/, 'the work finished in its own folder, not stopped');
    assert.ok(!done[1].stopped && done[1].ok);
    assert.ok(existsSync(join(home, 'work', 'bots', 'bot1-side', 'octa-task.md')), 'the side chat wrote its instructions in its own folder');
  } finally {
    r.stop(); srv.closeAllConnections(); srv.close(); process.env.PATH = oldPath; process.env.HOME = oldHome;
  }
});
