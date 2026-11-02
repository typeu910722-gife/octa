// 4.1.0: the OCTA octopus as every bot's avatar (state + colour from a palette), the right-side work panel,
// what stays in the chat and what moves to the panel, and the desktop browser docked in the panel's 瀏覽器 tab.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { PALETTE as API_PALETTE, colorOk } from '../desktop/api/engines.mjs';
import { DOCK_EDGE, CONTROL_ROW, OPEN_BAR, ENGINE_ROW, TAB_ROW, dockBox, embedFrames, shieldFor } from '../desktop/embed-layout.mjs';
import { html, js, css, fnSrc, pure, read } from './app-source.mjs';

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
  return { prepare: sql => new Stmt(sql), async batch(st) { db.exec('BEGIN'); try { const o = st.map(s => s._exec()); db.exec('COMMIT'); return o; } catch (e) { db.exec('ROLLBACK'); throw e; } }, exec: s => db.exec(s), raw: db };
}
const { onRequest } = await import(pathToFileURL(join(import.meta.dirname, '..', 'desktop', 'api', 'index.mjs')).href);
async function call(db, method, path, { body, query } = {}) {
  const url = new URL('http://octa.test/api/' + path);
  for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);
  const res = await onRequest({ request: new Request(url, { method, headers: { 'content-type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(body || {}) }), env: { DB: db, TZ_OFFSET_MIN: '480', isLocal: true }, params: { path: path.split('/').filter(Boolean) } });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
async function setup() {
  const db = openD1();
  await db.prepare("INSERT OR IGNORE INTO users (id,name,pw,created) VALUES ('local','本機','-',?)").bind(Date.now()).run();
  return db;
}

test('the palette: 14 colours, the default gold first, the same list in the page and the API', () => {
  const app = pure.PALETTE.map(([c]) => c);
  assert.deepEqual(app, API_PALETTE);
  assert.equal(app[0], '#D6B27A');
  assert.equal(pure.OC_DEFAULT, '#D6B27A');
  assert.ok(app.length >= 12 && app.length <= 16);
  assert.equal(new Set(app).size, app.length, 'no colour twice');
  for (const c of app) assert.match(c, /^#[0-9A-F]{6}$/);
  // every colour is light enough for the dark eyes (#1c140a) to read on it
  const lum = h => { const n = parseInt(h.slice(1), 16), f = v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }; return .2126 * f(n >> 16) + .7152 * f(n >> 8 & 255) + .0722 * f(n & 255); };
  for (const c of app) assert.ok((lum(c) + .05) / (lum('#1c140a') + .05) >= 6, c + ' contrast with the eyes');
  // the star: the default keeps its own gold; others get a richer shade of their own colour
  assert.equal(pure.accentOf('#D6B27A'), '#E2A93B');
  assert.equal(pure.accentOf(''), '#E2A93B');
  for (const c of app.slice(1)) assert.match(pure.accentOf(c), /^#[0-9A-F]{6}$/);
  assert.equal(pure.colorHex('#7ec4e6'), '#7EC4E6');
  assert.equal(pure.colorHex('red'), '');
});

test('colorOk: a palette value or #rrggbb, empty means default, anything else is refused', () => {
  assert.equal(colorOk('#7ec4e6'), '#7EC4E6');
  assert.equal(colorOk(' #D6B27A '), '#D6B27A');
  assert.equal(colorOk(''), null);
  assert.equal(colorOk(null), null);
  assert.equal(colorOk(undefined), null);
  for (const bad of ['red', '#fff', '#12345g', 'url(x)', '#1234567', '<b>']) assert.equal(colorOk(bad), undefined, bad);
});

test('bots keep a colour: POST and PUT validate it, PUT without it keeps it, state returns it', async () => {
  const db = await setup();
  const r = await call(db, 'POST', 'bots', { body: { name: '客服', color: '#7ec4e6' } });
  assert.equal(r.status, 200);
  const id = r.data.id;
  assert.equal((await call(db, 'POST', 'bots', { body: { name: '壞', color: 'pink' } })).status, 400);
  let st = (await call(db, 'GET', 'state')).data;
  assert.equal(st.bots.find(b => b.id === id).color, '#7EC4E6');
  assert.equal((await call(db, 'PUT', 'bots/' + id, { body: { name: '客服', task: '', color: 'nope' } })).status, 400);
  assert.equal((await call(db, 'PUT', 'bots/' + id, { body: { name: '客服', task: '', color: '#E79AB5' } })).status, 200);
  st = (await call(db, 'GET', 'state')).data;
  assert.equal(st.bots.find(b => b.id === id).color, '#E79AB5');
  assert.equal((await call(db, 'PUT', 'bots/' + id, { body: { name: '客服2', task: '' } })).status, 200);
  st = (await call(db, 'GET', 'state')).data;
  assert.equal(st.bots.find(b => b.id === id).color, '#E79AB5', 'left out: kept');
  // a bot made without a colour has none (the page draws the default gold)
  const plain = (await call(db, 'POST', 'bots', { body: { name: '預設' } })).data.id;
  assert.equal((await call(db, 'GET', 'state')).data.bots.find(b => b.id === plain).color, null);
});

test('work-panel messages (kind) are not unread conversation or list previews; messages return their kind', async () => {
  const db = await setup();
  const id = (await call(db, 'POST', 'bots', { body: { name: '甲' } })).data.id;
  const add = (by, text, kind) => db.raw.prepare('INSERT INTO messages (user_id,conv,by_,text,ts,kind) VALUES (?,?,?,?,?,?)').run('local', id, by, text, Date.now(), kind ?? null);
  add(id, '這是回覆');
  add(id, '⚠ 額度用完', 'fail');
  add(id, '背景回答', 'bg');
  const st = (await call(db, 'GET', 'state')).data;
  assert.equal(st.ur.filter(([c]) => c === id).length, 1, 'only the reply counts as unread');
  assert.equal(st.last.find(l => l.conv === id).text, '這是回覆', 'the preview is the conversation');
  const ms = (await call(db, 'GET', 'messages', { query: { conv: id } })).data.msgs;
  assert.deepEqual(ms.filter(m => m.by === id).map(m => m.kind), [null, 'fail', 'bg']);
  // busy says when a bot is answering another bot (its avatar shows it chatting)
  db.raw.prepare("INSERT INTO jobs (user_id,conv,bot_id,chain,prompt,created,status,kind,via,started) VALUES ('local',?,?,'[]','x',?, 'running','chat',?,?)").run(id, id, Date.now(), JSON.stringify({ f: 'b', k: 'ask', w: 'x' }), Date.now());
  const busy = (await call(db, 'GET', 'busy')).data.busy;
  assert.equal(busy[0].bg, 1);
  assert.ok(busy[0].job > 0);
  // the panel reads one chat's jobs
  const logs = (await call(db, 'GET', 'logs', { query: { conv: id } })).data.logs;
  assert.equal(logs.length, 1);
});

test('the chat keeps the conversation; everything else goes to the work panel (msgPlace)', () => {
  const { msgPlace, bgKey } = pure;
  const chat = [
    { by: 'me', text: '幫我整理訂單' },
    { by: 'b', text: '整理好了：…' },
    { by: 'b', text: '', files: [{ id: 'f', name: 'a.png' }] },
    { by: 'b', text: '擬好了\n✅待確認：傳給客人' },
    { by: 'b', text: '要用哪個網址？❓' },
    { by: 'b', text: '需要使用者在電腦上登入 shopee' },
    { by: 'sys', text: '需要你在電腦上登入。登入好之後傳一句話，我就從這一頁繼續。' },
    { by: 'me', text: '（附件）', tmp: true }
  ];
  for (const m of chat) assert.equal(msgPlace(m), 'chat', m.text);
  const work = [
    { by: 'sys', text: '機器人已建立' },
    { by: 'sys', text: '已停止目前的任務' },
    { by: 'sys', text: '🔁 「乙」問：幾點開門' },
    { by: 'sys', text: '⚠ 例行任務「日報」這次沒有完成' },
    { by: 'sys', text: '「甲」這次沒做成（逾時），自動重試第 1 次…' },
    { by: 'sys', text: '已開啟 24 小時待命' },
    { by: 'b', text: '⚠ 額度用完', kind: 'fail' },
    { by: 'b', text: '九點開門', kind: 'bg' },
    { by: 'b', text: '目前進度：…', kind: 'note' }
  ];
  for (const m of work) assert.equal(msgPlace(m), 'work', m.text);
  // older answers to a background request carry no kind: matched with 幕後 by their first words
  assert.equal(msgPlace({ by: 'b', text: '九點  開門\n細節' }, new Set([bgKey('b', '九點 開門\n細節')])), 'work');
  assert.equal(msgPlace({ by: 'c', text: '九點 開門' }, new Set([bgKey('b', '九點 開門')])), 'chat', 'another bot saying the same is conversation');
  // the page uses it: the chat, previews and approval cards
  assert.match(fnSrc('chatMsgs'), /msgPlace\(m,bgKeysFor\(id\)\)==='chat'/);
  assert.match(fnSrc('renderChat'), /const shown=chatMsgs\(cur\)/);
  assert.match(fnSrc('preview'), /msgPlace\(x\)==='chat'/);
  assert.match(fnSrc('apprHtml'), /chatMsgs\(m\.conv\|\|cur\)/);
  assert.doesNotMatch(fnSrc('renderChat'), /class="work"|id="stop"|bstage/, 'no status lines in the chat');
});

test('what the avatar shows: idle, thinking, working, browsing, chatting', () => {
  const { botState } = pure;
  const run = (p, x = {}) => [{ bot_id: 'a', status: 'running', kind: 'chat', progress: p, ...x }];
  assert.equal(botState('a', []), 'idle');
  assert.equal(botState('a', [{ bot_id: 'a', status: 'pending' }]), 'idle', 'queued is not working yet');
  assert.equal(botState('a', run('')), 'thinking');
  assert.equal(botState('a', run('開始工作')), 'thinking');
  assert.equal(botState('a', run('整理回覆中')), 'working');
  assert.equal(botState('a', run('讀取檔案 orders.csv')), 'working');
  assert.equal(botState('a', run('讀取網頁 example.com')), 'working', 'WebFetch is not the browser');
  for (const p of ['打開 seller.shopee.tw', '點擊「聊聊」', '在「搜尋」輸入', '讀取網頁內容', '第 3 步：點擊', '操作瀏覽器', '切換分頁']) assert.equal(botState('a', run(p)), 'browsing', p);
  assert.equal(botState('a', run('', { kind: 'open' })), 'browsing');
  assert.equal(botState('a', run('讀取網頁內容', { bg: 1 })), 'chatting', 'answering another bot');
  assert.equal(botState('b', run('打開 x')), 'idle');
});

test('the octopus is drawn inline from the five states, coloured, still unless it matters', () => {
  const av = read('app/js/avatar.js');
  for (const s of ['idle', 'working', 'thinking', 'browsing', 'chatting']) assert.match(av, new RegExp('\\n  ' + s + ':\\(\\)=>'), s);
  assert.doesNotMatch(av.slice(0, av.indexOf('const OA_CACHE')), /\bid="/, 'no ids inside the drawing (many on one page)');
  assert.match(fnSrc('octSvg'), /class="oa s-\$\{s\}\$\{live\?' live':''\}"/);
  assert.match(fnSrc('octSvg'), /style="--oc:\$\{c\};--os:\$\{accentOf\(c\)\}"/);
  const acss = read('app/css/avatar.css');
  assert.match(acss, /\.oa-body\{fill:var\(--oc\)\}/);
  assert.match(acss, /\.oa-eye\{fill:#1c140a/, 'eyes stay dark on any colour');
  assert.match(acss, /background:color-mix\(in srgb,var\(--oc\) 24%,var\(--panel\)\)/, 'a disc of its colour behind it, light and dark');
  assert.match(acss, /@media \(prefers-reduced-motion:reduce\)\{\.oa \*\{animation:none!important\}\}/);
  assert.match(acss, /\.oa\.live \.oa-bob\{animation:/, 'only .live moves');
  for (const [, sel] of acss.matchAll(/([^{}]+)\{[^{}]*animation:oa-[^{}]*\}/g)) assert.match(sel, /\.live/, 'only .live moves: ' + sel.trim());
  // the sidebar moves only while a bot does something; the header and the panel always
  assert.match(fnSrc('avOf'), /live&&st!=='idle'\|\|live==='always'/);
  assert.match(fnSrc('rowHtml'), /avOf\(c\.id,true\)/);
  assert.match(fnSrc('renderChat'), /avOf\(c\.id,'always'\)/);
  // the palette picker is a radiogroup that the keyboard can move through
  assert.match(fnSrc('paletteHtml'), /role="radiogroup"/);
  assert.match(fnSrc('paletteHtml'), /role="radio" aria-checked="\$\{on\}" tabindex="\$\{on\?0:-1\}"/);
  assert.match(fnSrc('bindPalette'), /ArrowRight:1,ArrowLeft:-1,ArrowDown:cols,ArrowUp:-cols/);
  assert.match(fnSrc('paintDetail'), /paletteHtml\(c\.color,'dPal'\)/);
  assert.match(fnSrc('paintDetail'), /body\.color=pal\?pal\.get\(\)/);
});

test('one work panel on the right: 工作 · 瀏覽器 · 詳細資料, folded or open remembered on this device', () => {
  assert.match(html, /<aside class="wp" id="wp" hidden/);
  for (const [k, t] of [['work', '工作'], ['web', '瀏覽器'], ['info', '詳細資料']]) assert.match(html, new RegExp(`data-wt="${k}"[^>]*><span>${t}</span>`), k);
  assert.match(html, /id="panelBtn"[^>]*aria-controls="wp"/);
  assert.match(html, /id="wpBadge"/);
  assert.match(html, /<section class="wp-pane detail" id="detail"/, '詳細資料 is a tab of the panel, not its own panel');
  assert.match(html, /id="webCtl"/, 'room for the phone remote control (4.2)');
  assert.match(fnSrc('openPanel'), /store\.set\('octa_wp','1'\)/);
  assert.match(fnSrc('closePanel'), /store\.set\('octa_wp','0'\)/);
  assert.match(fnSrc('openPanel'), /navPush\('detail'\)/, 'a full page on a phone, Back closes it');
  assert.match(js, /if\(!wpWide\(\)&&!phoneUI\(\)\)WP\.open=false/, 'a medium window starts folded');
  // a job starting switches 詳細資料 to 工作 only when the panel is open and nothing is being edited
  assert.match(fnSrc('trackJobs'), /panelOn\(\)&&WP\.tab==='info'&&!isDirty\(\)/);
  // the dot on the folded toggle: running, new, failed
  assert.match(fnSrc('paintBadge'), /fail\?'err':run\?'run':fresh\?'new'/);
  // layout: a third column on big screens, floating at medium widths, a page on a phone
  assert.match(css, /\.app\.wp-on\{grid-template-columns:var\(--side-w\) minmax\(0,1fr\) var\(--wpw\)\}/);
  assert.match(css, /@media \(max-width:1180px\) and \(min-width:761px\)\{\n  \.wp\{position:fixed;top:0;right:0;bottom:0/);
  assert.match(fnSrc('paintFail'), /上次的工作沒有完成/);
  assert.match(fnSrc('paintSend'), /run&&!\$\('msg'\)\.value\.trim\(\)&&!pending\.length/, 'send becomes stop while it works');
});

test('the desktop browser docks inside the 瀏覽器 tab (embed-layout dock mode)', () => {
  assert.equal(dockBox(1400, 860, null), null);
  assert.deepEqual(dockBox(1400, 860, { x: 900.4, y: 110, width: 488, height: 740 }), { x: 900, y: 110, width: 488, height: 740 });
  assert.deepEqual(dockBox(1400, 860, { x: 450, y: 55, width: 244, height: 370 }, 2), { x: 900, y: 110, width: 488, height: 740 }, 'page zoom');
  assert.deepEqual(dockBox(1000, 700, { x: 600, y: 100, width: 600, height: 800 }), { x: 600, y: 100, width: 400, height: 600 }, 'kept inside the window');
  assert.equal(dockBox(1400, 860, { x: 0, y: 0, width: 80, height: 500 }), null, 'too small: hidden');
  assert.equal(dockBox(1400, 860, { x: 'a', y: 0, width: 300, height: 300 }), null);
  const f = embedFrames(1400, 860, 'dock', { x: 900, y: 110, width: 488, height: 740 }, { tabs: 0 });
  assert.equal(f.mode, 'dock');
  assert.deepEqual(f.chrome, { x: 900, y: 110, width: 488, height: 740 });
  const bar = OPEN_BAR + ENGINE_ROW;
  assert.deepEqual(f.page, { x: 900 + DOCK_EDGE, y: 110 + bar, width: 488 - 2 * DOCK_EDGE, height: 740 - bar - CONTROL_ROW - DOCK_EDGE });
  assert.deepEqual(f.shield, f.page, 'watch only: the shield lies over the page');
  assert.equal(embedFrames(1400, 860, 'dock', { x: 900, y: 110, width: 488, height: 740 }, { control: true }).shield, null, 'take control: no shield');
  assert.equal(embedFrames(1400, 860, 'dock', { x: 900, y: 110, width: 488, height: 740 }, { tabs: 2 }).page.y, 110 + bar + TAB_ROW);
  assert.equal(embedFrames(1400, 860, 'dock', { x: 900, y: 110, width: 488, height: 740 }, { covered: true }).mode, 'hidden', 'a dialog on top');
  assert.equal(embedFrames(1400, 860, 'dock', null, {}).mode, 'hidden', 'folded panel or another tab');
  assert.equal(shieldFor('dock', { x: 1, y: 1, width: 2, height: 2 }, false).width, 2);
  // main: the page says where (octa:dock), and only that bot's browser is placed there
  const main = read('desktop/main.mjs'), pre = read('desktop/preload.cjs');
  assert.match(pre, /dock: rect => ipcRenderer\.invoke\('octa:dock', rect \|\| null\)/);
  assert.match(main, /handle\('octa:dock', \(_e, d\) => \{\n  docking = true;/);
  assert.match(main, /if \(docking\) \{ layoutDocked\(w, h\); return; \}/);
  assert.match(main, /bucket\.shown && bucket\.botId === focusBotId && dockRect/);
  assert.match(main, /if \(docking\) return focusBotId;/, 'the dock call decides which bot (a group member, too)');
  const chrome = read('desktop/browser-chrome.html');
  assert.match(chrome, /document\.body\.classList\.toggle\('dock', d\.mode === 'dock'\)/);
  assert.match(chrome, /body\.dock \.edges, body\.dock #collapse \{ display: none !important; \}/);
});
