// 4.7 track A: the browser in the main turn (per engine), 🧭 step progress, 暫停／繼續, markers kept out of the chat
// (messages.meta), the approval card fields, and the failure kinds a routine reports (logout / api / missing).
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { classifyOutcome, classifyJobFailure, FAIL_KINDS } from '../desktop/lib/model-route.mjs';
import {
  DIRECT_BROWSE, RESUME_PROMPT, browseKind, browseMode, buildPrompt, buildLocalPrompt, parsePlan, parseStep, stepTracker, stripStepMarks
} from '../desktop/runner/index.mjs';
import { configure } from '../desktop/runner/state.mjs';
import { botDir } from '../desktop/runner/files.mjs';
import { runEngine } from '../desktop/runner/engines.mjs';
import { parseApproval, replyMeta, stripLeaks } from '../desktop/api/reply-meta.mjs';
import { parseProgress, progressOf } from '../desktop/api/progress.mjs';

const apiUrl = pathToFileURL(join(import.meta.dirname, '..', 'desktop', 'api', 'index.mjs')).href;
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
async function setup() {
  const db = openD1();
  await db.prepare("INSERT OR IGNORE INTO users (id,name,pw,created) VALUES ('local','本機','-',?)").bind(Date.now()).run();
  const bot = (await call(db, 'POST', 'bots', { name: '小幫手', task: '' })).data.id;
  const next = async () => (await call(db, 'POST', 'runner/next', { slots: 3, wait: false })).data.job;
  return { db, bot, next, row: id => db.raw.prepare('SELECT * FROM jobs WHERE id=?').get(id) };
}

// ---------- which AI works the browser itself ----------
test('direct browsing per engine: CLI agents with MCP do it in the main turn; Ollama relays; Grok Bot has no OCTA browser', () => {
  for (const e of ['claude', 'codex', 'gemini', 'qwen', 'copilot', 'cursor', 'grok']) assert.equal(browseKind(e), 'direct', e);
  assert.deepEqual(DIRECT_BROWSE, ['claude', 'codex', 'gemini', 'qwen', 'copilot', 'cursor', 'grok']);
  assert.equal(browseKind('opencode'), 'relay');
  assert.equal(browseKind('grokbot'), 'none');
  assert.equal(browseKind(undefined), 'direct', 'no engine = Claude');
  assert.equal(browseMode({ bot: { engine: 'codex' } }), 'direct');
  assert.equal(browseMode({ bot: { engine: 'codex' }, browse: 'none' }), 'none');
});

test('the direct prompt: own browser tools, snapshot refs, take-over, safety, API first; no "你不能自己點"', () => {
  for (const engine of ['claude', 'codex', 'gemini']) {
    const p = buildPrompt({ bot: { id: 'b', name: '測', engine }, browse: 'direct', prompt: '打開 https://example.com 告訴我標題', history: [], lang: 'zh-TW' }, '/tmp/x');
    assert.match(p, /你自己就能操作這個機器人的瀏覽器/);
    assert.match(p, /browser_navigate/);
    assert.match(p, /只用這一份快照裡的引用/);
    assert.match(p, /接手/);
    assert.match(p, /能用 API、公開資料或連接器做到的先用/);
    assert.match(p, /需要使用者在電腦上登入/);
    assert.match(p, /停在按「送出」之前/);
    assert.match(p, /🧭步驟：/);
    assert.match(p, /🧭第N步/);
    assert.match(p, /第一行之後空一行再寫細節/);
    assert.match(p, /對象：.*內容：.*時間：/s);
    assert.ok(!p.includes('你不能自己點'));
    assert.ok(!/【派瀏覽】\n網址/.test(p));
    assert.match(p, /Gmail、Google 雲端硬碟/);
  }
  const local = buildLocalPrompt({ bot: { id: 'b', name: '測', engine: 'opencode', autonomy: 'ask' }, prompt: '看訂單', history: [] }, '/tmp/x');
  assert.match(local, /對象：」「內容：」「時間：/);
});

test('MCP config: the main turn gets the bot\'s own browser over CDP, in every engine\'s config file', () => {
  const home = mkdtempSync(join(tmpdir(), 'octa-direct-'));
  configure({ url: 'http://127.0.0.1:1', home, pwCli: '/x/cli.js', nodeBin: '/x/node' });
  const b = botDir('bot-a', 'own', 19011);
  b.applyBrowser(true, true);
  const srv = JSON.parse(readFileSync(join(b.dir, 'mcp-browser.json'), 'utf8')).mcpServers.browser;
  assert.deepEqual(srv.args.slice(0, 3), ['/x/cli.js', '--cdp-endpoint', 'http://127.0.0.1:19011']);
  assert.ok(srv.args.includes('--allow-unrestricted-file-access'));
  for (const f of ['.gemini/settings.json', '.agents/mcp_config.json', '.qwen/settings.json', '.cursor/mcp.json', '.mcp.json', 'copilot-mcp.json'])
    assert.ok(JSON.parse(readFileSync(join(b.dir, f), 'utf8')).mcpServers.browser, f);
  b.applyBrowser(false);
  assert.deepEqual(JSON.parse(readFileSync(join(b.dir, '.mcp.json'), 'utf8')).mcpServers, {});
});

// a fake Claude Code: streams an init, a browser tool call and its result, then (unless stopped) the answer.
// It writes its arguments next to it, so the test sees the MCP file, the allowed tools and --session-id / --resume.
function fakeClaude(home) {
  const bin = join(home, 'bin'); mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'claude'), `#!/usr/bin/env node
const fs = require('fs'), args = process.argv.slice(2);
if (args.includes('--help')) { console.log('--tools --disable-slash-commands'); process.exit(0); }
fs.appendFileSync(${JSON.stringify(join(home, 'args.jsonl'))}, JSON.stringify(args) + '\\n');
let input = ''; process.stdin.on('data', d => input += d); process.stdin.on('end', () => {
  const w = o => process.stdout.write(JSON.stringify(o) + '\\n');
  const sid = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : args[args.indexOf('--session-id') + 1];
  w({ type: 'system', subtype: 'init', session_id: sid });
  if (args.includes('--resume')) { w({ type: 'result', result: '【回覆】\\n標題是 Example Domain\\n✅ 完成：讀到標題', usage: { output_tokens: 3 } }); return; }
  w({ type: 'assistant', message: { content: [{ type: 'text', text: '🧭步驟：打開網頁｜讀標題' }, { type: 'text', text: '🧭第1步' }, { type: 'tool_use', name: 'mcp__browser__browser_navigate', input: { url: 'https://example.com' } }] } });
  setTimeout(() => {
    w({ type: 'user', message: { content: [{ type: 'tool_result', content: [{ type: 'text', text: '- Page Title: Example Domain' }] }] } });
    setTimeout(() => { w({ type: 'assistant', message: { content: [{ type: 'text', text: '🧭第2步' }] } }); w({ type: 'result', result: '【回覆】\\n標題是 Example Domain', usage: { output_tokens: 3 } }); }, 400);
  }, 200);
});
`);
  chmodSync(join(bin, 'claude'), 0o755);
  return bin;
}

test('Claude: one run with the browser (DIRECT_ALLOWED + mcp-browser.json), steps from its text, 暫停 at the step boundary and --resume', { skip: process.platform === 'win32' }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'octa-direct-run-'));
  const bin = fakeClaude(home);
  const oldPath = process.env.PATH; process.env.PATH = bin + ':' + oldPath;
  try {
    configure({ url: 'http://127.0.0.1:1', home, pwCli: '/x/cli.js', nodeBin: '/x/node' });
    const b = botDir('bot-r', 'own', 19012);
    const tr = stepTracker(), tools = [], seen = [];
    const live = { browser: true, files: true, port: 19012, ctl: {}, progress: (t, k) => tr.doing(t, k), say: t => tr.said(t), tool: n => tools.push(n), seen: t => seen.push(t) };
    const r = await runEngine('claude', '打開 example.com', b, '', { ...live, session: { id: '11111111-1111-4111-8111-111111111111' } });
    assert.equal(r.ok, true);
    assert.match(r.text, /Example Domain/);
    const a = JSON.parse(readFileSync(join(home, 'args.jsonl'), 'utf8').trim().split('\n')[0]);
    assert.ok(a[a.indexOf('--mcp-config') + 1].endsWith('mcp-browser.json'));
    assert.equal(a[a.indexOf('--allowedTools') + 1], 'WebFetch,WebSearch,Read,Write,Edit,Glob,Grep,Bash,mcp__browser');
    assert.equal(a[a.indexOf('--session-id') + 1], '11111111-1111-4111-8111-111111111111');
    assert.deepEqual(tr.payload().steps, ['打開網頁', '讀標題']);
    assert.equal(tr.payload().step, 2);
    assert.deepEqual(tools, ['mcp__browser__browser_navigate']);
    assert.match(seen.join(''), /Example Domain/);
    // 暫停: stopped right after the tool result, before the answer; 繼續 resumes the same session
    const p = await runEngine('claude', '打開 example.com', b, '', { ...live, pauseNow: () => true, session: { id: '22222222-2222-4222-8222-222222222222' } });
    assert.equal(p.paused, true);
    assert.equal(p.session, '22222222-2222-4222-8222-222222222222');
    const c = await runEngine('claude', RESUME_PROMPT, b, '', { ...live, session: { id: p.session, resume: true } });
    assert.equal(c.ok, true);
    const last = JSON.parse(readFileSync(join(home, 'args.jsonl'), 'utf8').trim().split('\n').at(-1));
    assert.equal(last[last.indexOf('--resume') + 1], '22222222-2222-4222-8222-222222222222');
    assert.match(RESUME_PROMPT, /browser_snapshot 重新讀目前的頁面/);
    // a relay round (worker) keeps the narrow tool list
    await runEngine('claude', 'x', b, '', { browser: true, worker: true, port: 19012, ctl: {} });
    const w = JSON.parse(readFileSync(join(home, 'args.jsonl'), 'utf8').trim().split('\n').at(-1));
    assert.equal(w[w.indexOf('--allowedTools') + 1], 'mcp__browser,Read');
  } finally { process.env.PATH = oldPath; }
});

test('🧭 steps: plan, step marks, payload, and the marks never reach the chat', () => {
  assert.deepEqual(parsePlan('好\n🧭步驟：打開後台｜找今天訂單｜整理名單\n'), ['打開後台', '找今天訂單', '整理名單']);
  assert.equal(parsePlan('🧭步驟：只有一步'), null);
  assert.equal(parseStep('🧭第2步 …🧭第3步'), 3);
  assert.equal(parseStep('🧭 2/5'), 2);
  const t = stepTracker();
  t.said('🧭步驟：打開後台｜找訂單');
  t.doing('點擊「訂單」', 'browse');
  assert.deepEqual(t.payload(), { text: '打開後台：點擊「訂單」', kind: 'browse', steps: ['打開後台', '找訂單'], total: 2, step: 1 });
  assert.equal(stripStepMarks('🧭步驟：a｜b\n🧭第1步\n結果是 3 筆'), '結果是 3 筆');
});

// ---------- API: progress JSON, busy / state, pause ----------
test('runner/progress keeps JSON (step, total, steps, kind); busy and state give it parsed with paused; old text rows still work', async () => {
  const t = await setup();
  await call(t.db, 'POST', 'messages', { conv: t.bot, text: '整理今天訂單' });
  const job = await t.next();
  const r = await call(t.db, 'POST', 'runner/progress', { id: job.id, text: '點擊「訂單」', step: 2, total: 3, steps: ['打開後台', '找訂單', '整理'], kind: 'browse', pmode: 'step' });
  assert.equal(r.data.pause, false);
  const stored = JSON.parse(t.row(job.id).progress);
  assert.equal(stored.step, 2); assert.equal(stored.total, 3); assert.equal(stored.kind, 'browse'); assert.ok(stored.at);
  const busy = (await call(t.db, 'GET', 'busy')).data.busy.find(x => x.job === job.id);
  assert.deepEqual({ ...busy.progress, at: 0 }, { text: '點擊「訂單」', steps: ['打開後台', '找訂單', '整理'], total: 3, step: 2, kind: 'browse', pmode: 'step', at: 0 });
  assert.equal(busy.paused, false);
  const st = (await call(t.db, 'GET', 'state')).data.busy.find(x => x.job === job.id);
  assert.equal(st.progress.step, 2);
  // an old runner (text only) and an old row
  await call(t.db, 'POST', 'runner/progress', { id: job.id, text: '讀取網頁' });
  assert.deepEqual(parseProgress(t.row(job.id).progress).text, '讀取網頁');
  assert.deepEqual(parseProgress('舊的進度'), { text: '舊的進度' });
  assert.equal(parseProgress(null), null);
  assert.equal(progressOf({ text: 'x', step: 9, total: 3 }).step, 3, 'step stays inside the plan');
});

test('POST job/<id>/pause: paused in busy, the runner is told, not timed out while paused; 繼續 clears it', async () => {
  const t = await setup();
  await call(t.db, 'POST', 'messages', { conv: t.bot, text: '整理今天訂單' });
  const job = await t.next();
  assert.equal((await call(t.db, 'POST', `job/${job.id}/pause`, { on: true })).data.paused, true);
  assert.equal(t.row(job.id).paused, 1);
  assert.equal((await call(t.db, 'GET', 'busy')).data.busy.find(x => x.job === job.id).paused, true);
  assert.equal((await call(t.db, 'POST', 'runner/progress', { id: job.id, text: '已暫停', held: true })).data.pause, true);
  // paused for longer than the job time limit, still reporting: not stopped by the time limit
  t.db.raw.prepare('UPDATE jobs SET started=?, beat=? WHERE id=?').run(Date.now() - 5 * 3600e3, Date.now(), job.id);
  await call(t.db, 'POST', 'runner/next', { slots: 0, wait: false });
  assert.equal(t.row(job.id).status, 'running');
  assert.equal((await call(t.db, 'POST', `job/${job.id}/pause`, { on: false })).data.paused, false);
  assert.equal((await call(t.db, 'POST', 'runner/progress', { id: job.id, text: '繼續工作' })).data.pause, false);
  assert.equal((await call(t.db, 'POST', 'job/99999/pause', { on: true })).status, 404);
});

// ---------- markers out of the chat, into messages.meta ----------
test('runner/done: markers leave the text; notes, result and the approval card go to meta (GET messages returns it parsed)', async () => {
  const t = await setup();
  await call(t.db, 'POST', 'messages', { conv: t.bot, text: '以後回客人都用敬語，然後幫我擬一封回覆' });
  const job = await t.next();
  const reply = [
    '🧭步驟：讀信｜擬回覆',
    '已擬好回覆。',
    '',
    '細節：客人問入住時間。',
    '📌記住：回客人都用敬語',
    '🗺️網站筆記：mail.example.com｜收件匣在左上',
    '【開瀏覽器】https://example.com',
    '📍 目前頁面：https://mail.example.com/inbox',
    '✅待確認：回覆王小明的信',
    '對象：王小明（wang@example.com）',
    '內容：王先生您好，',
    '入住時間是下午三點。',
    '時間：核准後馬上',
    '✅ 完成：回覆已擬好'
  ].join('\n');
  await call(t.db, 'POST', 'runner/done', { id: job.id, ok: true, text: reply });
  const msgs = (await call(t.db, 'GET', `messages?conv=${t.bot}`)).data.msgs;
  const m = msgs.filter(x => x.by === t.bot).at(-1);
  assert.ok(!/🧭|📌|🗺️|【開瀏覽器】|📍|✅ 完成/.test(m.text), m.text);
  assert.match(m.text, /^已擬好回覆。\n\n細節/);
  assert.match(m.text, /✅待確認：回覆王小明的信/, 'the approval line stays (history, 待你處理)');
  assert.deepEqual(m.meta.result, { ok: true, text: '回覆已擬好' });
  assert.deepEqual(m.meta.approval, { what: '回覆王小明的信', to: '王小明（wang@example.com）', content: '王先生您好，\n入住時間是下午三點。', when: '核准後馬上' });
  const types = m.meta.notes.map(n => n.type);
  for (const k of ['memory', 'site', 'page']) assert.ok(types.includes(k), k);
  // the tag under the reply says it now: the separate "已記住" line goes to the work panel
  const sys = msgs.find(x => x.by === 'sys' && /^已記住/.test(x.text));
  assert.equal(sys.kind, 'note');
});

test('reply-meta: leaks, a reply that is only the result line, approval fields, nothing to keep', () => {
  assert.equal(stripLeaks('a\n【派瀏覽】\n網址：x\n【派完】\n🧭第2步\n【關瀏覽器】\nb'), 'a\n\nb');
  assert.deepEqual(replyMeta('⚠ 沒做成：找不到今天的訂單名單'), { text: '找不到今天的訂單名單', meta: { result: { ok: false, text: '找不到今天的訂單名單', whole: true } } });
  assert.deepEqual(replyMeta('今天 3 筆'), { text: '今天 3 筆', meta: null });
  assert.equal(parseApproval('沒有核准'), null);
  assert.deepEqual(parseApproval('✅待確認：付款 300 元'), { what: '付款 300 元' });
});

// ---------- #8 failure kinds ----------
test('failure kinds for the alert: logout (a routine met a sign-in), api, missing', async () => {
  for (const k of ['logout', 'api', 'missing']) assert.ok(FAIL_KINDS[k]?.label, k);
  assert.equal(classifyOutcome('需要使用者在電腦上登入（LINE）', { routine: true }), 'logout');
  assert.equal(classifyOutcome('需要使用者在電腦上登入（LINE）'), 'not_logged_in');
  assert.equal(classifyJobFailure('API 回應 500，訂單系統出錯'), 'api');
  assert.equal(classifyJobFailure('找不到今天的訂單名單'), 'missing');
  // a routine run whose result line says it could not do it: err_kind on the job, routine marked error
  const t = await setup();
  const rid = 'r-test';
  t.db.raw.prepare("INSERT INTO routines (id,user_id,conv,name,prompt,times,enabled,fired,created) VALUES (?,?,?,?,?,'[]',1,'{}',?)").run(rid, 'local', t.bot, '巡訂單', '看今天訂單', Date.now());
  t.db.raw.prepare("INSERT INTO jobs (user_id,conv,bot_id,chain,prompt,created,routine) VALUES ('local',?,?,'[]','（例行任務「巡訂單」）看今天訂單',?,?)").run(t.bot, t.bot, Date.now(), rid);
  const job = await t.next();
  await call(t.db, 'POST', 'runner/done', { id: job.id, ok: true, text: '⚠ 沒做成：找不到今天的訂單名單，頁面是空的' });
  assert.equal(t.row(job.id).err_kind, 'missing');
  const t2 = await setup();
  t2.db.raw.prepare("INSERT INTO routines (id,user_id,conv,name,prompt,times,enabled,fired,created) VALUES (?,?,?,?,?,'[]',1,'{}',?)").run(rid, 'local', t2.bot, '巡訂單', '看今天訂單', Date.now());
  t2.db.raw.prepare("INSERT INTO jobs (user_id,conv,bot_id,chain,prompt,created,routine) VALUES ('local',?,?,'[]','（例行任務「巡訂單」）看今天訂單',?,?)").run(t2.bot, t2.bot, Date.now(), rid);
  const j2 = await t2.next();
  await call(t2.db, 'POST', 'runner/done', { id: j2.id, ok: true, text: '需要使用者在電腦上登入（後台）。我先自己試過：點已記住的帳號。' });
  assert.equal(t2.row(j2.id).err_kind, 'logout');
});

test('migrations: messages.meta and jobs.paused in both lists and schema.sql', () => {
  const server = readFileSync(join(import.meta.dirname, '..', 'desktop', 'server.mjs'), 'utf8');
  const db = readFileSync(join(import.meta.dirname, '..', 'desktop', 'api', 'db.mjs'), 'utf8');
  for (const sql of ['ALTER TABLE messages ADD COLUMN meta TEXT', 'ALTER TABLE jobs ADD COLUMN paused INTEGER']) {
    assert.ok(server.includes(sql), 'server.mjs ' + sql);
    assert.ok(db.includes(sql), 'db.mjs ' + sql);
  }
  assert.match(schema, /meta TEXT/);
  assert.match(schema, /paused INTEGER/);
  assert.ok(existsSync(join(import.meta.dirname, '..', 'desktop', 'api', 'progress.mjs')));
});

test('Google: the in-app browser hands any Google sign-in page to the Chrome window; Google cookies are never copied', async () => {
  const { googleSignInPage } = await import('../desktop/browser-catalog.mjs');
  const { isGoogleCookie, wantsGoogle } = await import('../desktop/runner/google.mjs');
  assert.equal(googleSignInPage('https://accounts.google.com/v3/signin/identifier?continue=https%3A%2F%2Fmail.google.com'), true);
  assert.equal(googleSignInPage('https://accounts.google.com/ServiceLogin'), true);
  assert.equal(googleSignInPage('https://www.google.com/search?q=x'), false);
  assert.equal(googleSignInPage('https://mail.google.com/mail/u/0/'), false);
  for (const d of ['.google.com', 'mail.google.com', 'accounts.google.com', '.youtube.com', '.google.com.tw']) assert.equal(isGoogleCookie({ domain: d }), true, d);
  for (const d of ['.instagram.com', 'line.me', 'notgoogle.com']) assert.equal(isGoogleCookie({ domain: d }), false, d);
  assert.equal(wantsGoogle({ prompt: '整理 Gmail' }), true);
  const main = readFileSync(join(import.meta.dirname, '..', 'desktop', 'main.mjs'), 'utf8');
  assert.match(main, /if \(!googleRefused\(url, text\) && !googleSignInPage\(url\)\) return;/);
  assert.match(main, /autoBack: \(\) => false/);
  assert.match(main, /useChrome, useEmbedded/);
});
