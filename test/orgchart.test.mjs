// 4.15 公司組織圖: the main screen as a company org chart (app/js/orgchart.js, orgModel in seamodel.js), chosen in
// 設定 → 主畫面樣式 instead of the deep-sea base; CEO / leads saved with the account; levels from work ever finished.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { css, dict, html, scripts } from './app-source.mjs';

const { onRequest } = await import(pathToFileURL(join(import.meta.dirname, '..', 'desktop', 'api', 'index.mjs')).href);
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

let ip = 40, n = 0;
// 4.0: one local user and no accounts. The old sign-up / runner-key steps only make sure that user exists.
async function localLogin(db) {
  await db.prepare("INSERT OR IGNORE INTO users (id,name,pw,created) VALUES ('local','本機','-',?)").bind(Date.now()).run();
  return { status: 200, data: { token: 'local' } };
}
async function call(db, method, path, { token, body, query } = {}) {
  if (path === 'signup' || path === 'runner-token') return localLogin(db);
  const headers = { 'content-type': 'application/json', 'cf-connecting-ip': `198.51.100.${ip++ % 250}` };
  if (token) headers.authorization = 'Bearer ' + token;
  const url = new URL('http://octa.test/api/' + path);
  for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);
  const req = new Request(url, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(body || {}) });
  const res = await onRequest({ request: req, env: { DB: db, TZ_OFFSET_MIN: '480', isLocal: true }, params: { path: path.split('/').filter(Boolean) } });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

const M = new Function(scripts['pure.js'] + '\n' + scripts['seamodel.js'] + '\nreturn { seaModel, orgModel, orgLevel };')();
const now = Date.UTC(2026, 10, 7, 4);
const state = () => ({
  bots: [{ id: 'a', name: '小美', folder: 'f1' }, { id: 'b', name: '阿哲', folder: 'f1' }, { id: 'c', name: '客服', folder: 'f2' }, { id: 'd', name: '記帳' }],
  groups: [{ id: 'g1', name: '週報小組', members: ['b', 'c'], folder: 'f2' }],
  folders: [{ id: 'f1', name: '台南店' }, { id: 'f2', name: '行銷部' }, { id: 'f3', name: '空的' }],
  busy: [
    { job: 1, bot_id: 'a', status: 'running', kind: 'chat', conv: 'a', progress: { text: '打開後台', step: 1, total: 3 } },
    { job: 2, bot_id: 'c', status: 'running', kind: 'chat', conv: 'c', bg: 1, from: 'b', progress: { text: '查空房' } }
  ],
  last: [], lastJob: {}, gask: {}, done: {}, now
});

test('orgModel: departments from 分區 (總部 for the rest), CEO leaves its department, a lead must be in the department', () => {
  const m = M.seaModel(state());
  const o = M.orgModel(m, { ceo: 'd', leads: { f1: 'b', f2: 'a' }, total: { a: 12, b: 0, c: 3 } });
  assert.equal(o.ceo.id, 'd');
  assert.deepEqual(o.depts.map(d => [d.id, d.name]), [['f1', '台南店'], ['f2', '行銷部']], '總部 is empty once the CEO left; empty 分區 are not shown');
  const f1 = o.depts[0], f2 = o.depts[1];
  assert.equal(f1.lead.id, 'b');
  assert.deepEqual(f1.members.map(x => x.id), ['a']);
  assert.equal(f2.lead, null, 'a bot from another department is not its lead');
  assert.equal(f1.busy, 1); assert.equal(f1.n, 2);
  assert.ok(f1.members[0].on, 'working bots glow');
  assert.deepEqual(f2.rooms.map(r => r.id), ['g1']);
  assert.deepEqual(o.links, [{ from: 'b', to: 'c', job: 2 }], 'work handed from one bot to another');
  assert.equal(f1.members[0].lv, 3); assert.equal(f2.members[0].lv, 2); assert.equal(f1.lead.lv, 1);
});

test('orgModel: no CEO set (or one that is gone) keeps everyone in their department', () => {
  const o = M.orgModel(M.seaModel(state()), { ceo: 'zz' });
  assert.equal(o.ceo, null);
  assert.deepEqual(o.depts.map(d => d.name), ['總部', '台南店', '行銷部']);
  assert.deepEqual(o.depts[0].members.map(x => x.id), ['d']);
  assert.equal(M.orgLevel(0), 1); assert.equal(M.orgLevel(3), 2); assert.equal(M.orgLevel(48), 5); assert.equal(M.orgLevel(1e9), 99);
});

test('the style is picked in Settings, kept on this device; the org chart never loads three.js', () => {
  assert.ok(html.indexOf('/js/seabase.js') < html.indexOf('/js/orgchart.js'));
  assert.ok(html.includes('/css/orgchart.css'));
  assert.match(scripts['orgchart.js'], /const stageStyle=\(\)=>store\.get\('octa_stagestyle'\)==='org'\?'org':'sea'/);
  assert.match(scripts['seabase.js'], /function seaEnsure\(\)\{if\(typeof orgOn==='function'&&orgOn\(\)\)return;/, 'seaEnsure skips the 3D scene');
  assert.match(scripts['orgchart.js'], /if\(k==='org'&&SEA\.g\)seaFree\(SEA\.g\)/, 'switching frees the GPU');
  assert.match(scripts['prefs.js'], /pick\(\$\('pStageStyle'\),stageStyleSet\)/);
  assert.match(scripts['seabase.js'], /orgSync\(\);seaEnsure\(\);/);
  assert.match(scripts['api.js'], /org:d\.org\|\|\{ceo:null,leads:\{\}\}/);
  assert.match(css, /prefers-reduced-motion:reduce\)\{\.org-wires/);
  for (const s of ['公司組織圖', '深海工作室', '主畫面樣式', '調整組織', '總部', '不設主管', '點一張名片，或從左邊選一個機器人開始對話'])
    for (const l of ['en', 'ja', 'zh-CN']) assert.ok(dict[l].t[s], s + ' ' + l);
});

test('the CEO and the leads are saved with the account; levels count work ever finished, not 待命巡查 checks', async () => {
  const db = openD1();
  const token = (await call(db, 'POST', 'signup')).data.token;
  const a = (await call(db, 'POST', 'bots', { token, body: { name: '小美', task: '' } })).data.id;
  const b = (await call(db, 'POST', 'bots', { token, body: { name: '阿哲', task: '' } })).data.id;
  assert.deepEqual((await call(db, 'GET', 'state', { token })).data.org, { ceo: null, leads: {} });
  assert.equal((await call(db, 'PUT', 'settings', { token, body: { org: { ceo: a, leads: { hub: b, '': 'x' } } } })).status, 200);
  assert.deepEqual((await call(db, 'GET', 'state', { token })).data.org, { ceo: a, leads: { hub: b } });
  db.raw.exec("INSERT INTO routines (id,user_id,conv,name,prompt,times,enabled,created) VALUES ('r1','local','" + b + "','待命巡查','x','[]',1,0)");
  const job = (bot, status, extra = '') => db.raw.exec(`INSERT INTO jobs (user_id,conv,bot_id,chain,prompt,created,status${extra ? ',' + extra.split('=')[0] : ''}) VALUES ('local','${bot}','${bot}','[]','p',0,'${status}'${extra ? ",'" + extra.split('=')[1] + "'" : ''})`);
  job(a, 'done'); job(a, 'done'); job(a, 'error'); job(a, 'done', 'err_kind=api'); job(b, 'done', 'routine=r1'); job(b, 'done', 'kind=test'); job(b, 'done');
  assert.deepEqual((await call(db, 'GET', 'overview/org', { token })).data.total, { [a]: 2, [b]: 1 });
});
