// 主動性: autonomy levels, plan-first prompt rules, default 24-hour standby, the 幕後 log, and group collaboration paths.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { autonomyRules, buildPrompt } from '../public/octa-runner.mjs';

const apiUrl = pathToFileURL(join(import.meta.dirname, '..', 'functions', 'api', '[[path]].js')).href;
const { onRequest, mentionAsks } = await import(apiUrl);
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
async function call(db, method, path, { token, body, query } = {}) {
  const headers = { 'content-type': 'application/json', 'cf-connecting-ip': `198.51.100.${ip++ % 250}` };
  if (token) headers.authorization = 'Bearer ' + token;
  const url = new URL('http://octa.test/api/' + path);
  for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);
  const req = new Request(url, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(body || {}) });
  const res = await onRequest({ request: req, env: { DB: db, ALLOW_SIGNUP: 'true', TZ_OFFSET_MIN: '480', isLocal: false }, params: { path: path.split('/').filter(Boolean) } });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
async function setup() {
  const db = openD1();
  const su = await call(db, 'POST', 'signup', { body: { name: 'pro' + n++, pw: 'correcthorsebattery' } });
  const token = su.data.token;
  const rt = (await call(db, 'POST', 'runner-token', { token, body: { label: 'host' } })).data.token;
  // names with spaces can't be made any more; such a name stands for a bot from an older version
  const bot = async (name, task = '', extra = {}) => {
    const id = (await call(db, 'POST', 'bots', { token, body: { name: name.replace(/\s/g, '') + '_tmp', task, ...extra } })).data.id;
    db.raw.prepare('UPDATE bots SET name=? WHERE id=?').run(name, id);
    return id;
  };
  const group = async (name, members, task = '') => (await call(db, 'POST', 'groups', { token, body: { name, task, members } })).data.id;
  const say = (conv, text) => call(db, 'POST', 'messages', { token, body: { conv, text } });
  const next = async () => (await call(db, 'POST', 'runner/next', { token: rt, body: { slots: 3, wait: false } })).data.job;
  const done = (id, text, ok = true) => call(db, 'POST', 'runner/done', { token: rt, body: { id, ok, text } });
  const msgs = async conv => (await call(db, 'GET', 'messages', { token, query: { conv } })).data.msgs;
  const pending = () => db.raw.prepare("SELECT * FROM jobs WHERE status IN ('pending','running') ORDER BY id").all();
  return { db, token, rt, bot, group, say, next, done, msgs, pending };
}

test('autonomy is saved per bot, kept on edit, and sent to the runner', async () => {
  const t = await setup();
  const a = await t.bot('甲', '', { autonomy: 'ask' });
  const b = await t.bot('乙');
  let st = (await call(t.db, 'GET', 'state', { token: t.token })).data;
  assert.equal(st.bots.find(x => x.id === a).autonomy, 'ask');
  assert.equal(st.bots.find(x => x.id === b).autonomy, 'report');   // default
  await call(t.db, 'PUT', 'bots/' + a, { token: t.token, body: { name: '甲', task: '' } });   // an old client without the field
  st = (await call(t.db, 'GET', 'state', { token: t.token })).data;
  assert.equal(st.bots.find(x => x.id === a).autonomy, 'ask');
  await call(t.db, 'PUT', 'bots/' + a, { token: t.token, body: { name: '甲', task: '', autonomy: 'nonsense' } });
  st = (await call(t.db, 'GET', 'state', { token: t.token })).data;
  assert.equal(st.bots.find(x => x.id === a).autonomy, 'report');
  await call(t.db, 'PUT', 'bots/' + a, { token: t.token, body: { name: '甲', task: '', autonomy: 'auto' } });
  await t.say(a, '你好');
  const job = await t.next();
  assert.equal(job.bot.autonomy, 'auto');
});

test('prompt rules: auto skips the plan, report/ask plan big jobs first, approved plans and routines run straight', () => {
  const job = (autonomy, prompt) => ({ bot: { id: 'b', name: '測', engine: 'claude', task: '', autonomy }, prompt, history: [], lang: 'zh-TW' });
  const auto = autonomyRules(job('auto', '每天整理全部訂單')).join('\n');
  assert.match(auto, /全權處理/);
  assert.doesNotMatch(auto, /📋計畫/);
  assert.match(auto, /付款、刪除資料、更改帳號設定仍要先寫 ✅待確認/);
  const report = autonomyRules(job('report', '每天整理全部訂單')).join('\n');
  assert.match(report, /做完告知/);
  assert.match(report, /📋計畫/);
  assert.match(report, /✅待確認：照計畫執行：/);
  const ask = autonomyRules(job('ask', '回覆客人')).join('\n');
  assert.match(ask, /每一次都先把內容擬好/);
  assert.match(ask, /就算之前「一律允許」過也一樣/);
  assert.doesNotMatch(autonomyRules(job('report', '核准：照計畫執行：整理訂單')).join('\n'), /先規劃再動手/);
  assert.match(autonomyRules(job('report', '@測 核准：照計畫執行：整理訂單')).join('\n'), /不要再出一次計畫/);
  assert.doesNotMatch(autonomyRules(job('report', '（例行任務「待命巡查」）照你的指定任務檢查')).join('\n'), /先規劃再動手/);
  assert.doesNotMatch(autonomyRules(job('ask', '〔背景:x:ask〕同事「甲」在背景問你：幾點')).join('\n'), /先規劃再動手/);
  const full = buildPrompt(job('ask', '整理全部訂單'), '/tmp/octa-pro');
  assert.match(full, /權限：重要動作先問/);
  assert.match(full, /先規劃再動手/);
});

test('a bot that gets its standing task goes on 30-minute standby once; existing settings stay', async () => {
  const t = await setup();
  const routines = conv => t.db.raw.prepare("SELECT * FROM routines WHERE conv=? AND name='待命巡查'").all(conv);
  const withTask = await t.bot('值班', '每天巡 LINE 訊息');
  const r = routines(withTask);
  assert.equal(r.length, 1);
  assert.deepEqual(JSON.parse(r[0].times), ['*/30']);
  assert.ok(JSON.parse(r[0].fired)['*/30'] > Date.now() - 5000, 'first check is 30 minutes from now, not right away');
  assert.ok((await t.msgs(withTask)).some(m => m.by === 'sys' && /已開啟 24 小時待命/.test(m.text)));

  const blank = await t.bot('空白');
  assert.equal(routines(blank).length, 0, 'a new bot with no task stays blank');
  await call(t.db, 'PUT', 'bots/' + blank, { token: t.token, body: { name: '空白', task: '整理訂單' } });
  assert.equal(routines(blank).length, 1, 'filling in the task turns standby on');

  // turned off by the person: emptying and refilling the task does not turn it back on
  await call(t.db, 'DELETE', 'routines/' + routines(blank)[0].id, { token: t.token });
  await call(t.db, 'PUT', 'bots/' + blank, { token: t.token, body: { name: '空白', task: '' } });
  await call(t.db, 'PUT', 'bots/' + blank, { token: t.token, body: { name: '空白', task: '新的工作' } });
  assert.equal(routines(blank).length, 0);

  // a bot from before this version that already had a task: editing the task leaves standby alone
  const old = await t.bot('舊的');
  t.db.raw.prepare("UPDATE bots SET task='原本的工作', stood=NULL WHERE id=?").run(old);
  await call(t.db, 'PUT', 'bots/' + old, { token: t.token, body: { name: '舊的', task: '改過的工作' } });
  assert.equal(routines(old).length, 0);

  // the bot learns its task from the chat (📝任務更新)
  const learner = await t.bot('學徒');
  await t.say(learner, '以後你每天幫我看訂單');
  const job = await t.next();
  await t.done(job.id, '好喔\n📝任務更新：\n每天看訂單並回報\n📝結束');
  assert.equal(routines(learner).length, 1);
  const st = (await call(t.db, 'GET', 'state', { token: t.token })).data;
  assert.equal(st.bots.find(x => x.id === learner).stood, true);
});

test('group without @ in parallel: every member gets it once, and a "（略過）" with the page line stays hidden', async () => {
  const t = await setup();
  const a = await t.bot('甲'), b = await t.bot('乙');
  const g = await t.group('並行組', [a, b], '大家各自處理');
  await t.say(g, '今天天氣如何');
  const jobs = t.pending();
  assert.deepEqual(jobs.map(j => j.bot_id).sort(), [a, b].sort());
  assert.ok(jobs.every(j => JSON.parse(j.chain).length === 0));
  const j1 = await t.next(), j2 = await t.next();
  assert.notEqual(j1.bot.id, j2.bot.id);
  await t.done(j1.id, '晴天，大約 25 度');
  await t.done(j2.id, '（略過）\n📍 目前頁面：https://example.com/');
  const list = (await t.msgs(g)).filter(m => m.by !== 'sys' && m.by !== 'me');
  assert.equal(list.length, 1);
  assert.match(list[0].text, /晴天/);
  assert.equal(t.pending().length, 0);
});

test('group in order: the next member starts only after the first one finished', async () => {
  const t = await setup();
  const a = await t.bot('甲'), b = await t.bot('乙');
  const g = await t.group('接力組', [a, b], '依序：甲先查，乙再整理');
  await t.say(g, '查一下明天的訂房');
  let jobs = t.pending();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].bot_id, a);
  const j1 = await t.next();
  assert.equal(await t.next(), null, 'nothing else to do while the first member works');
  await t.done(j1.id, '明天有 3 間');
  jobs = t.pending();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].bot_id, b);
  const j2 = await t.next();
  await t.done(j2.id, '整理好了：3 間');
  assert.equal(t.pending().length, 0);
});

test('@交接 in a relay: the member it went to runs once, not again as the next turn (no duplicate reply)', async () => {
  const t = await setup();
  const a = await t.bot('claude 測試用'), b = await t.bot('2');
  const g = await t.group('接力', [a, b]);
  await t.say(g, '先讓 claude 測試用 列出 3 個景點，然後 2 把它們排成半天行程');
  const j1 = await t.next();
  assert.equal(j1.bot.id, a);
  await t.done(j1.id, '赤崁樓、孔廟、林百貨\n@2 交接：把這三個排成半天行程');
  const jobs = t.pending();
  assert.equal(jobs.length, 1, 'one job for 2, not the hand-off plus its own turn');
  assert.equal(jobs[0].bot_id, b);
  assert.match(jobs[0].prompt, /把工作交接給你/);
  assert.equal(JSON.parse(jobs[0].via).k, 'give');
  const j2 = await t.next();
  await t.done(j2.id, '09:00 赤崁樓 → 10:00 孔廟 → 11:00 林百貨');
  assert.equal(t.pending().length, 0);
  const back = (await call(t.db, 'GET', 'backstage', { token: t.token, query: { conv: g } })).data.items;
  assert.equal(back.length, 1);
  assert.equal(back[0].from, a);
  assert.equal(back[0].to, b);
  assert.equal(back[0].kind, 'give');
  assert.match(back[0].reply, /赤崁樓/);
  assert.equal(typeof back[0].ms, 'number');
});

test('@names with spaces: the longest member name wins, and a bot\'s @question wakes the colleague', async () => {
  const t = await setup();
  const short = await t.bot('claude'), long = await t.bot('claude 測試用'), two = await t.bot('2');
  const g = await t.group('名字組', [short, long, two], '大家各自處理');
  await t.say(g, '@claude 測試用 你好');
  assert.deepEqual(t.pending().map(j => j.bot_id), [long]);
  const j = await t.next();
  await t.done(j.id, '你好！');
  await t.say(g, '@2 問一下 claude 測試用 覺得哪個好');
  const j2 = await t.next();
  assert.equal(j2.bot.id, two);
  await t.done(j2.id, '@claude 測試用 你覺得哪一個景點最好？');
  const jobs = t.pending();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].bot_id, long, 'not left waiting because only "@claude" was read');
  assert.match(jobs[0].prompt, /2 問你：你覺得哪一個景點最好/);
  assert.deepEqual(JSON.parse(jobs[0].chain).map(s => s.b), [two], 'the asker continues afterwards');
});

test('"私下去問": the question runs in the background, stays out of the group, and the asker answers in the group', async () => {
  const t = await setup();
  const long = await t.bot('claude 測試用'), two = await t.bot('2');
  const g = await t.group('私下組', [long, two], '大家各自處理');
  await t.say(g, '@2 請你私下去問 claude 測試用：最推薦哪個景點，再整理成一句話回給我');
  const j1 = await t.next();
  assert.equal(j1.bot.id, two);
  await t.done(j1.id, '好，我去問一下\n@claude 測試用 私下：你最推薦哪個景點？');
  const shown = (await t.msgs(g)).filter(m => m.by === two);
  assert.equal(shown.length, 1);
  assert.equal(shown[0].text, '好，我去問一下', 'the private question is not posted in the group');
  let jobs = t.pending();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].conv, long, 'asked in the colleague\'s own chat');
  assert.match(jobs[0].prompt, /^〔背景:/);
  const bgJob = await t.next();
  await t.done(bgJob.id, '我最推薦赤崁樓');
  jobs = t.pending();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].conv, g, 'the answer comes back to the group');
  assert.equal(jobs[0].bot_id, two);
  assert.match(jobs[0].prompt, /只回使用者要的最後結果/);
  const j3 = await t.next();
  await t.done(j3.id, 'claude 測試用最推薦赤崁樓。');
  const back = (await call(t.db, 'GET', 'backstage', { token: t.token, query: { conv: g } })).data.items;
  assert.equal(back.length, 1);
  assert.equal(back[0].kind, 'ask');
  assert.match(back[0].what, /最推薦/);
  assert.match(back[0].reply, /赤崁樓/);
  // the 🔁 note went to the group (shown folded under 幕後), not lost in the asker's own chat
  assert.ok((await t.msgs(g)).some(m => m.by === 'sys' && /^🔁/.test(m.text)));
});

test('background ask between private chats: logged in 幕後; a failure is reported back; a repeated done is ignored', async () => {
  const t = await setup();
  const a = await t.bot('甲'), b = await t.bot('乙');
  await t.say(a, '問乙明天幾點開門');
  const j1 = await t.next();
  await t.done(j1.id, '我問一下\n@乙 明天幾點開門？');
  const again = await t.done(j1.id, '我問一下\n@乙 明天幾點開門？');   // the runner retried the same report
  assert.equal(again.status, 404);
  const jobs = t.pending();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].conv, b);
  const bj = await t.next();
  await t.done(bj.id, '⚠ TypeError: 執行失敗', false);   // a fixed-code error: final, not retried automatically
  assert.ok((await t.msgs(a)).some(m => m.by === 'sys' && /🔁 「乙」沒能完成回覆/.test(m.text)));
  const back = (await call(t.db, 'GET', 'backstage', { token: t.token, query: { conv: a } })).data.items;
  assert.equal(back.length, 1);
  assert.equal(back[0].status, 'error');
  assert.equal((await t.msgs(a)).filter(m => m.by === a).length, 1, 'the reply was posted once');
});

test('bot names: no spaces for new names or renames; an old spaced name may stay; names OCTA makes get "_"', async () => {
  const t = await setup();
  for (const name of ['claude 測試用', '全形　空白', 'tab\tname']) {
    const r = await call(t.db, 'POST', 'bots', { token: t.token, body: { name } });
    assert.equal(r.status, 400);
    assert.equal(r.data.error, '名稱不能有空格，才能用 @ 叫它');
  }
  const ok = await call(t.db, 'POST', 'bots', { token: t.token, body: { name: '小幫手' } });
  assert.equal(ok.status, 200);
  const bad = await call(t.db, 'PUT', 'bots/' + ok.data.id, { token: t.token, body: { name: '小 幫手' } });
  assert.equal(bad.data.error, '名稱不能有空格，才能用 @ 叫它');
  const old = await t.bot('舊 名字');   // from an older version
  const keep = await call(t.db, 'PUT', 'bots/' + old, { token: t.token, body: { name: '舊 名字', task: '照舊' } });
  assert.equal(keep.status, 200, 'other settings still save; the name is not changed for them');
  assert.equal(t.db.raw.prepare('SELECT name FROM bots WHERE id=?').get(old).name, '舊 名字');
  const tpl = await call(t.db, 'POST', 'template', { token: t.token, body: { name: 'shop', lang: 'en' } });
  assert.equal(tpl.status, 200);
  assert.ok(t.db.raw.prepare('SELECT name FROM bots').all().every(b => b.name === '舊 名字' || !/\s/.test(b.name)));
  // a new bot names itself: spaces become "_"
  const fresh = (await call(t.db, 'POST', 'bots', { token: t.token, body: { name: '新機器人' } })).data.id;
  await t.say(fresh, '你負責遊戲');
  const job = await t.next();
  await t.done(job.id, '好喔\n📛名稱：🎮 Game Pal');
  assert.equal(t.db.raw.prepare('SELECT name FROM bots WHERE id=?').get(fresh).name, 'Game_Pal');
  const page = readFileSync(join(import.meta.dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(page, /名稱有空格，群組裡 @ 不到它，建議改名/);
  assert.match(page, /if\(!g&&sheet\.nameOk&&!sheet\.nameOk\(\)\)/);
});

test('web app: autonomy choice, standby status, plan buttons and the folded 幕後 line', () => {
  const page = readFileSync(join(import.meta.dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(page, /name="sf_au" value="\$\{v\}"/);
  assert.match(page, /\['auto','直接做'/);
  assert.match(page, /\['report','做完告知（建議）'/);
  assert.match(page, /\['ask','重要動作先問'/);
  assert.match(page, /body\.autonomy=\$\('veil'\)\.querySelector\('input\[name=sf_au\]:checked'\)/);
  assert.match(page, /id="sf_standnow"/);
  assert.match(page, />照做<\/button>/);
  assert.match(page, /if\(\/\^照計畫\/\.test\(a\[1\]\.trim\(\)\)\)/);
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const backSrc = page.slice(page.indexOf('function backHtml'), page.indexOf("$('msgs').addEventListener('toggle'"));
  const standSrc = page.slice(page.indexOf('function standNow'), page.indexOf('\n', page.indexOf('function standNow')));
  const backForSrc = page.slice(page.indexOf('function backFor'), page.indexOf('function backHtml'));
  const make = new Function('esc', 'nameOf', 'BSOPEN', 'BS', 'convMsgs', 'loadBack', `${standSrc}\n${backSrc}\n${backForSrc}\nreturn {standNow, backHtml, backFor};`);
  const BS = {}, msgs = [{ id: 1, by: 'me', text: '問', ts: 1000 }, { id: 2, by: 'sys', text: '🔁 「乙」回覆：九點', ts: Date.now() }, { id: 3, by: 'a', text: '九點開門', ts: Date.now() + 1 }];
  const ui = make(esc, id => ({ a: '甲', b: '乙' })[id] || id, new Set(), BS, () => msgs, () => {});
  assert.equal(ui.standNow('30', false), '目前：開啟，每 30 分鐘巡查一次');
  assert.match(ui.standNow('', true), /填入指定任務後會自動開啟/);
  const html = ui.backHtml([{ id: 9, from: 'a', to: 'b', kind: 'ask', what: '幾點<開門>', reply: '九點', status: 'done', ms: 4200 }, { id: 10, from: 'a', to: 'b', kind: 'give', what: '整理', reply: '', status: 'running', ms: null }]);
  assert.match(html, /<details class="bstage" data-bs="9">/);
  assert.match(html, /🔁 幕後 2 則/);
  assert.match(html, /進行中/);
  assert.match(html, /4 秒/);
  assert.match(html, /幾點&lt;開門&gt;/);
  assert.doesNotMatch(html, / open>/, 'folded by default');
  BS.x = { ok: true, items: [{ id: 9, from: 'a', to: 'b', kind: 'ask', what: '幾點', reply: '九點', status: 'done', created: 1500, ms: 1 }] };
  const bs = ui.backFor('x', { loaded: true, more: false });
  assert.equal(bs.hide(msgs[1]), true, 'the 🔁 note is folded into 幕後');
  assert.equal(bs.before(msgs[0]), '');
  assert.match(bs.before(msgs[2]), /幕後 1 則/, 'shown where it happened, after the question');
  assert.equal(bs.rest(), '');
});

test('bots in a group stop after the answer: no "收到／好喔" ping-pong', async () => {
  const t = await setup();
  const a = await t.bot('claude測試用'), b = await t.bot('2');
  const g = await t.group('互問', [a, b]);
  await t.say(g, '@2 去問 claude測試用 行程最需要調整哪一點，再整理成一句話給我');
  const j1 = await t.next();
  assert.equal(j1.bot.id, b);
  await t.done(j1.id, '@claude測試用 你覺得行程最需要調整哪一點？');
  const j2 = await t.next();
  assert.equal(j2.bot.id, a);
  await t.done(j2.id, '@2 收到，我覺得神農街排太早，改成 16:30 再去。');   // an answer back to the asker
  const j3 = await t.next();
  assert.equal(j3.bot.id, b);
  assert.match(j3.prompt, /同事已在上面回覆你的問題/);
  await t.done(j3.id, '@claude測試用 好喔，那就這樣定了。\nYzz：神農街改到 16:30 再去。');
  assert.equal(t.pending().length, 0, 'the thank-you does not start another round');
});

test('mentionAsks: acknowledgements and plain answers are not new questions', () => {
  const two = { name: '2' };
  assert.equal(mentionAsks('收到，這版就定案了', two, '幫我排行程'), false);
  assert.equal(mentionAsks('好喔，那就這樣定了', two, ''), false);
  assert.equal(mentionAsks('可以把行程排成半天', two, ''), true);
  assert.equal(mentionAsks('好，請你再幫我查開放時間', two, ''), true);
  assert.equal(mentionAsks('把這三個排成行程', two, '幫我排行程'), true);
  assert.equal(mentionAsks('我覺得神農街太早', two, '2 問你：哪裡要改？'), false);
  assert.equal(mentionAsks('那開放時間你查過嗎？', two, '2 問你：哪裡要改？'), true);
});

test('a hand-off report back to the one who handed it over is not a new question', () => {
  const a = { name: 'claude測試用' };
  assert.equal(mentionAsks('我這邊配好了，你挑的兩樣早餐都有配飲料', a, 'claude測試用 把工作交接給你：配飲料'), false);
  assert.equal(mentionAsks('牛肉湯要配熱的還是冰的？', a, 'claude測試用 把工作交接給你：配飲料'), true);
});
