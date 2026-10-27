// Browser corner card, stale / outdated computers, and the extra templates.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { DOT_SIZE, dotBox, embedFrames, thumbBox } from '../desktop/embed-layout.mjs';

const root = join(import.meta.dirname, '..');
const read = p => readFileSync(join(root, p), 'utf8');
const page = read('public/index.html');
const apiSrc = read('functions/api/[[path]].js');
const { onRequest } = await import(pathToFileURL(join(root, 'functions', 'api', '[[path]].js')).href);

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
let ip = 60;
async function call(db, method, path, { token, body } = {}) {
  const headers = { 'content-type': 'application/json', 'cf-connecting-ip': `203.0.113.${ip++}` };
  if (token) headers.authorization = 'Bearer ' + token;
  const req = new Request('http://octa.test/api/' + path, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(body || {}) });
  const res = await onRequest({ request: req, env: { DB: db, ALLOW_SIGNUP: 'true', TZ_OFFSET_MIN: '480', isLocal: false }, params: { path: path.split('/').filter(Boolean) } });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

test('the corner card can shrink to a round button in the same corner', () => {
  const card = thumbBox(1920, 1000);
  const dot = dotBox(1920, 1000);
  assert.equal(dot.width, DOT_SIZE);
  assert.equal(dot.height, DOT_SIZE);
  assert.equal(dot.x + dot.width, card.x + card.width);
  assert.equal(dot.y + dot.height, card.y + card.height);
  const lay = embedFrames(1920, 1000, 'thumb', { x: 40, y: 80 }, { dot: true });
  assert.equal(lay.mode, 'thumb');
  assert.equal(lay.dot, true);
  assert.equal(lay.chrome.width, DOT_SIZE);
  assert.equal(lay.chrome.x, 40 + card.width - DOT_SIZE);
});

test('an open dialog sends the browser views out of the way', () => {
  for (const mode of ['thumb', 'open']) {
    const lay = embedFrames(1920, 1000, mode, null, { covered: true });
    assert.equal(lay.mode, 'hidden');
    assert.equal(lay.chrome, null);
    assert.equal(lay.page, null);
    assert.equal(lay.main.width, 1920);
  }
  const main = read('desktop/main.mjs');
  assert.match(main, /handle\('octa:cover'/);
  assert.match(main, /covered \}\);/);
  assert.match(main, /ipcMain\.on\('octa:browser-dot'/);
  assert.match(main, /thumbDot: !!on/);
  assert.match(main, /win\.webContents\.send\('octa:pip'/);
  const pre = read('desktop/preload.cjs');
  assert.match(pre, /cover: on => ipcRenderer\.invoke\('octa:cover'/);
  assert.match(pre, /onPip: cb =>/);
  assert.match(read('desktop/browser-preload.cjs'), /octa:browser-dot/);
  const chrome = read('desktop/browser-chrome.html');
  assert.match(chrome, /id="mini"/);
  assert.match(chrome, /id="dot"/);
  assert.match(chrome, /api\(\)\?\.dot\?\.\(true\)/);
  // the page tells the app when a sheet, menu or loading screen is up, and keeps room under the last message
  assert.match(page, /D\.cover\(on\)/);
  assert.match(page, /!\$\('veil'\)\.hidden\|\|!!document\.querySelector\('\.mveil'\)/);
  assert.match(page, /html\.pip \.msgs::after\{content:"";flex:none;height:var\(--pip,0px\)\}/);
  assert.match(page, /if\(!D\?\.cover\)return;/);
});

test('computers not seen for 30 days are marked and older versions are flagged', () => {
  const src = page.match(/const PC_STALE_MS=[^\n]+\nconst pcStale=[^\n]+\nconst verCmp=[^\n]+/)[0];
  const { pcStale, verCmp } = new Function(src + ';return {pcStale,verCmp}')();
  const t = Date.UTC(2026, 9, 27);
  assert.equal(pcStale({ seen: 0, online: false }, t), true);
  assert.equal(pcStale({ seen: t - 31 * 86400000, online: false }, t), true);
  assert.equal(pcStale({ seen: t - 3 * 86400000, online: false }, t), false);
  assert.equal(pcStale({ seen: 0, online: true }, t), false);
  assert.equal(verCmp('2.3.0', '3.0.44'), -1);
  assert.equal(verCmp('3.0.9', '3.0.44'), -1);
  assert.equal(verCmp('v3.0.44', '3.0.44'), 0);
  assert.equal(verCmp('3.1', '3.0.44'), 1);
  assert.match(page, /很久沒連線/);
  assert.match(page, /版本較舊，建議更新/);
  assert.match(page, /<span>從未連線<\/span>/);
  assert.match(page, /data-stale="1"/);
  assert.match(page, /清除很久沒連線的電腦/);
  assert.match(page, /api\('devices\/remove','POST',\{ids:\[b\.dataset\.rmpc\]/);
});

test('new templates exist in every language and their routines start paused', async () => {
  for (const k of ['remind', 'tidy', 'watch', 'game']) assert.match(page, new RegExp(`\\{k:'${k}',n:'`));
  const dict = read('public/i18n-dict.js');
  for (const s of ['排程發訊', '資料整理', '網站監看', '遊戲自動化', '很久沒連線', '版本較舊，建議更新']) assert.ok(dict.includes(JSON.stringify(s) + ':'), s);
  // the build only replaces the template data, not the code after it
  assert.match(apiSrc, /const CODE_ENGINES = /);
  assert.match(apiSrc, /function publicCodeTask\(row\)/);
  const db = openD1();
  const su = await call(db, 'POST', 'signup', { body: { name: 'tpl', pw: 'correcthorsebattery' } });
  const token = su.data.token;
  for (const lang of ['zh-TW', 'en', 'ja', 'zh-CN']) {
    for (const name of ['remind', 'tidy', 'watch', 'game']) {
      const r = await call(db, 'POST', 'template', { token, body: { name, lang } });
      assert.equal(r.status, 200, lang + ' ' + name + ' ' + JSON.stringify(r.data));
    }
  }
  const bots = db.raw.prepare('SELECT name,task,avatar,folder FROM bots').all();
  assert.equal(bots.length, 16);
  assert.ok(bots.some(b => b.name === '提醒員' && b.avatar === '📅'));
  assert.ok(bots.some(b => b.name === 'Gamer' && b.avatar === '🎮'));
  assert.ok(bots.every(b => b.folder));
  // the routine marker the API parses stays the same in every language (Simplified Chinese too)
  const watchers = bots.filter(b => b.avatar === '👀');
  assert.equal(watchers.length, 4);
  for (const w of watchers) assert.match(w.task, /⏰例行任務：.+｜每10分鐘監看 .+｜.+（略過）/);
  const notes = db.raw.prepare("SELECT notes FROM folders WHERE name='遊戲自動化'").get();
  assert.match(notes.notes, /不要購買/);
  const routines = db.raw.prepare('SELECT name,times,enabled FROM routines').all();
  assert.equal(routines.length, 8);   // remind + game, four languages
  assert.ok(routines.every(r => r.enabled === 0));
  assert.deepEqual(JSON.parse(routines.find(r => r.name === '每日遊戲').times), ['09:00', '21:00']);
  const sys = db.raw.prepare("SELECT text FROM messages WHERE by_='sys' AND text LIKE '這個範本附了例行任務%'").all();
  assert.equal(sys.length, 8);
  assert.equal((await call(db, 'POST', 'template', { token, body: { name: 'nope', lang: 'en' } })).status, 400);
});
