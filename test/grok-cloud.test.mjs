// 4.14 Grok Bot（雲端）: a bot whose AI is the user's own Grok Bot, reached through a Grok Bot routine's webhook.
// A fake Grok Bot (a small HTTP server) takes the webhook call (Authorization: Bearer <key>, 200 = started) and answers
// through the OCTA site's forwarder (the legacy Pages Function + a fake ntfy.sh) at /api/hook/<token>/progress and /reply.
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { fnSrc } from './app-source.mjs';
const repo = join(import.meta.dirname, '..');
const HL = await import(pathToFileURL(join(repo, 'desktop/host-link.mjs')).href);
const HR = await import(pathToFileURL(join(repo, 'legacy/hook-relay.mjs')).href);
const GCM = await import(pathToFileURL(join(repo, 'desktop/api/grokcloud.mjs')).href);
let hasDeps = true;
try { createRequire(join(repo, 'desktop', 'package.json')).resolve('sql.js'); } catch { hasDeps = false; }

const jpost = (url, body, headers = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body || {}) });
const until = async (f, ms = 15000) => { const t0 = Date.now(); for (; ;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timed out'); await new Promise(r => setTimeout(r, 100)); } };
const listen = srv => new Promise(ok => srv.listen(0, '127.0.0.1', () => ok(`http://127.0.0.1:${srv.address().port}`)));
const readBody = async req => { const c = []; for await (const x of req) c.push(x); return Buffer.concat(c).toString(); };

function fakeNtfy() {
  const topics = new Map();
  return {
    topics,
    handle: async (url, init = {}) => {
      const u = new URL(url), parts = u.pathname.split('/').filter(Boolean);
      if ((init.method || 'GET') === 'POST') {
        const list = topics.get(parts[0]) || []; list.push({ event: 'message', id: String(list.length), time: Math.floor(Date.now() / 1000), message: String(init.body) });
        topics.set(parts[0], list);
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (parts[1] === 'json') return new Response((topics.get(parts[0]) || []).map(m => JSON.stringify(m)).join('\n') + '\n', { status: 200 });
      return new Response('not found', { status: 404 });
    }
  };
}
// the fake Grok Bot: its routine webhook, a file it made, and what it does when a run starts (`plan`)
function fakeGrok() {
  const calls = [], key = 'xai-routine-key-123456';
  let plan = async () => { }, status = 200;
  const srv = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/files/report.csv') { res.writeHead(200, { 'content-type': 'text/csv' }); return res.end('a,b\n1,2\n'); }
    if (req.method === 'GET' && req.url === '/files/login') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html>sign in</html>'); }
    if (req.method === 'POST' && req.url === '/hooks/routine-1') {
      const body = await readBody(req);
      if (req.headers.authorization !== 'Bearer ' + key) { res.writeHead(401); return res.end('unauthorized'); }
      if (status !== 200) { res.writeHead(status); return res.end('Automation run rate limit exceeded'); }
      const b = JSON.parse(body);
      calls.push({ body: b, auth: req.headers.authorization, ct: req.headers['content-type'] });
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}');   // 200 = a run started, not finished
      setTimeout(() => plan(b).catch(e => console.error('fake grok', e)), 10);
      return;
    }
    res.writeHead(404); res.end();
  });
  return { srv, calls, key, setPlan: f => (plan = f), setStatus: s => (status = s) };
}
// Grok Bot's own HTTP calls back to OCTA (what its cloud computer's curl would do)
const say = (b, kind, data) => jpost(b[kind === 'reply' ? 'reply_url' : 'progress_url'], { job: b.job, ...data }, { authorization: 'Bearer ' + b.reply_token }).then(async r => ({ status: r.status, data: await r.json().catch(() => null) }));

async function setup(t, extra = {}) {
  const { startServer } = await import(pathToFileURL(join(repo, 'desktop/server.mjs')).href);
  const ntfy = fakeNtfy();
  const relaySrv = http.createServer(async (req, res) => {
    const body = await readBody(req);
    const r = await ntfy.handle('http://relay' + req.url, { method: req.method, body });
    res.writeHead(r.status); res.end(await r.text());
  });
  const relay = await listen(relaySrv);
  // the OCTA site (legacy Pages Function) as a local HTTP server: /api/hook/* → ntfy.sh lookup → the host's tunnel
  const site = await import(pathToFileURL(join(repo, 'functions/api/[[path]].js')).href);
  const siteEnv = { HOOK_RELAY: relay, HOOK_ALLOW_ORIGINS: '' };
  const siteSrv = http.createServer(async (req, res) => {
    const body = req.method === 'POST' ? await readBody(req) : undefined;
    const path = new URL(req.url, 'http://x').pathname.replace(/^\/api\//, '');
    const request = new Request('https://octa.test' + req.url, { method: req.method, headers: req.headers, body });
    const r = await site.onRequest({ request, env: siteEnv, params: { path: path.split('/') } });
    res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
  });
  const siteUrl = await listen(siteSrv);
  const grok = fakeGrok();
  const grokUrl = await listen(grok.srv);
  const dataDir = mkdtempSync(join(tmpdir(), 'octa-gc-'));
  const s = await startServer({ dataDir, runner: false, relay, hookBase: siteUrl, watchMs: 300, grokMs: 150, port: 21000 + Math.floor(Math.random() * 9000) * 2, grokFileAllow: [grokUrl], tunnel: async port => `http://127.0.0.1:${port}`, ...extra });
  siteEnv.HOOK_ALLOW_ORIGINS = s.remoteUrl;
  t.after(async () => { await s.close(); relaySrv.close(); siteSrv.close(); grok.srv.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const L = s.url + '/api/';
  const api = async (m, p, b) => { const r = await fetch(L + p, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, data: await r.json().catch(() => null) }; };
  return { s, L, api, grok, grokUrl, siteUrl, ntfy, dataDir, msgs: async conv => (await api('GET', 'messages?conv=' + conv)).data.msgs };
}
// a bot on Grok Bot（雲端）with its webhook saved
async function gcBot(x, name = '雲端助理') {
  const { api, grok, grokUrl } = x;
  const bot = (await api('POST', 'bots', { name, task: '幫我查資料、整理報表', engine: 'grokcloud' })).data.id;
  const su = await api('POST', `grokcloud/${bot}/setup`);
  assert.equal(su.status, 200);
  const sv = await api('POST', `grokcloud/${bot}`, { url: grokUrl + '/hooks/routine-1', key: 'Bearer ' + grok.key });
  assert.equal(sv.status, 200, JSON.stringify(sv.data));
  return { bot, info: sv.data };
}

test('the webhook address check, the reply URL fallback and the file URL rules', () => {
  assert.equal(GCM.webhookCheck('https://grok.com/api/routines/abc/webhook').warn, '');
  assert.equal(GCM.webhookCheck('https://api.x.ai/v1/hooks/1').warn, '');
  assert.match(GCM.webhookCheck('https://example.com/hook').warn, /不是常見的 Grok Bot 網域/, 'other https hosts: a warning, not refused');
  assert.ok(GCM.webhookCheck('http://example.com/hook').error, 'plain http refused');
  assert.ok(GCM.webhookCheck('not a url').error);
  assert.equal(GCM.webhookCheck('http://127.0.0.1:9/x').error, undefined, 'a local test server');
  const t = 'ab'.repeat(24);
  const env = { hookBase: 'https://octa.yzprojecttw.com', hookTunnel: () => 'https://a-b.trycloudflare.com' };
  assert.equal(GCM.replyBase({ ...env, hookPublished: () => true }, t).main, 'https://octa.yzprojecttw.com/api/hook/' + t);
  assert.equal(GCM.replyBase({ ...env, hookPublished: () => false }, t).main, 'https://a-b.trycloudflare.com/api/hook/' + t, 'the site has no address yet: the tunnel');
  for (const u of ['http://cdn.example.com/a', 'https://127.0.0.1/a', 'https://localhost/a', 'https://192.168.1.2/a', 'https://10.0.0.1/a', 'https://[::1]/a', 'https://u:p@cdn.example.com/a', 'file:///etc/passwd'])
    assert.equal(GCM.fileUrlOk(u), false, u);
  assert.equal(GCM.fileUrlOk('https://files.x.ai/out/report.pdf'), true);
  const ins = GCM.gcInstruction({ hookBase: 'https://octa.yzprojecttw.com' }, { name: '小幫手' }, t);
  for (const x of ['「小幫手」', `https://octa.yzprojecttw.com/api/hook/${t}/reply`, t, 'Authorization: Bearer', '✅待確認', '⚠ 沒做成', '"progress"', '{"stop":true}', 'history', 'memory'])
    assert.ok(ins.includes(x), x);
});

test('Grok Bot（雲端）: setup, 測試連線, a job goes out by webhook, progress and the reply come back through the OCTA site; no runner, no CLI',
  { skip: !hasDeps && 'desktop packages not installed', timeout: 120000 }, async t => {
  const x = await setup(t);
  const { api, grok, s, L, msgs, ntfy } = x;
  const { bot, info } = await gcBot(x);
  assert.equal(info.ready, true);
  assert.equal(info.key, '••••3456', 'the key is never shown in full');
  assert.equal(info.host, '127.0.0.1');
  assert.ok(!JSON.stringify(info).includes(grok.key));
  assert.match(info.instruction, /你是 OCTA 的工作機器人「雲端助理」/);
  const token = info.instruction.match(/reply_token：([0-9a-f]{48})/)[1];
  // the reply token is published on ntfy.sh like a 交接網址 (the tunnel stays open while such a bot exists)
  await until(() => ntfy.topics.get(HL.hookTopicOf(token))?.length);
  assert.equal(HL.unsealKey(ntfy.topics.get(HL.hookTopicOf(token)).at(-1).message, HL.hookKeyOf(token)).url, s.remoteUrl);
  const st0 = (await api('GET', 'state')).data;
  assert.deepEqual(st0.gc[bot], { ready: true, test: '' });
  assert.equal(st0.engines?.grokcloud ?? true, true);
  assert.ok(!JSON.stringify(st0).includes(token) && !JSON.stringify(st0).includes(grok.key), 'neither secret in the state');

  // ---------- 測試連線: sent → started → replied ----------
  grok.setPlan(async b => {
    await new Promise(r => setTimeout(r, 300));
    assert.equal((await say(b, 'progress', { progress: '收到測試' })).status, 200);
    await new Promise(r => setTimeout(r, 300));
    assert.equal((await say(b, 'reply', { text: 'OCTA 連線測試成功 ✅ 完成：連線正常' })).status, 200);
  });
  const tst = await api('POST', `grokcloud/${bot}/test`);
  assert.equal(tst.data.sent, true);
  assert.equal(tst.data.test.state, 'sent');
  assert.equal(grok.calls.at(-1).body.test, true);
  assert.match(grok.calls.at(-1).body.reply_url, new RegExp('^' + x.siteUrl + '/api/hook/' + token + '/reply$'), 'answers go to the stable site address');
  await until(async () => (await api('GET', `grokcloud/${bot}`)).data.test?.state === 'started');
  const tdone = await until(async () => { const d = (await api('GET', `grokcloud/${bot}`)).data; return d.test?.state === 'replied' && d; });
  assert.match(tdone.test.text, /連線測試成功/);

  // ---------- a chat message → the webhook, with its context ----------
  await api('PUT', 'settings', { memory: { bot, list: ['金額都要含稅'] } }).catch(() => { });
  let replied = null;
  grok.setPlan(async b => {
    await new Promise(r => setTimeout(r, 400));
    const p = await say(b, 'progress', { progress: '正在打開後台下載訂單' });
    assert.deepEqual(p.data, { ok: true, stop: false });
    await new Promise(r => setTimeout(r, 400));
    replied = await say(b, 'reply', { text: '今天 3 筆訂單，合計 1,260 元（含稅）。\n✅ 完成：整理好今天的訂單', files: [{ name: '訂單.csv', url: x.grokUrl + '/files/report.csv' }] });
  });
  assert.equal((await api('POST', 'messages', { conv: bot, text: '幫我整理今天的訂單' })).status, 200);
  await until(() => grok.calls.length >= 2);
  const call = grok.calls.at(-1);
  assert.equal(call.auth, 'Bearer ' + grok.key, 'Authorization: Bearer <routine key>');
  assert.match(call.ct, /application\/json/);
  const b = call.body;
  assert.match(b.job, /^\d+$/);
  assert.equal(b.task, '幫我整理今天的訂單');
  assert.equal(b.from, '使用者');
  assert.equal(b.standing_task, '幫我查資料、整理報表');
  assert.ok(Array.isArray(b.history) && b.history.some(h => h.text === '幫我整理今天的訂單'));
  assert.ok(b.memory && Array.isArray(b.memory.rules));
  assert.equal(b.reply_token, token);
  assert.equal(b.reply_url, x.siteUrl + '/api/hook/' + token + '/reply');
  assert.equal(b.progress_url, x.siteUrl + '/api/hook/' + token + '/progress');
  // 200 = started: the job stays running, shown as working on Grok Bot's cloud computer
  const busy = (await api('GET', 'state')).data.busy.find(j => j.bot_id === bot);
  assert.equal(busy.status, 'running');
  assert.ok(busy.ext > 0);
  // the runner never gets it
  assert.equal((await api('POST', 'runner/next', { slots: 3, wait: false })).data.job, null);
  await until(async () => /正在打開後台/.test(JSON.stringify((await api('GET', 'state')).data.busy.find(j => j.bot_id === bot)?.progress || '')));
  const reply = await until(async () => (await msgs(bot)).find(m => m.by === bot && /3 筆訂單/.test(m.text)), 20000);
  assert.equal(replied.status, 200);
  assert.equal(reply.files?.length, 1);
  assert.equal(reply.files[0].name, '訂單.csv');
  const saved = (await x.api('GET', 'state')).data;
  assert.ok(!saved.busy.some(j => j.bot_id === bot), 'the job finished');
  const logs = (await api('GET', 'logs?conv=' + bot)).data.logs;
  assert.equal(logs.find(j => +j.id === +b.job)?.status, 'done');
  // the file is in the bot's 輸出 folder
  const store = join(x.dataDir, 'files');
  const { readdirSync } = await import('node:fs');
  const folder = readdirSync(store).find(f => f.startsWith('雲端助理_'));
  assert.equal(readFileSync(join(store, folder, '輸出', '訂單.csv'), 'utf8'), 'a,b\n1,2\n');
  // a second reply for the same job changes nothing
  assert.equal((await say(b, 'reply', { text: '又一次' })).data.late, true);
  assert.ok(!(await msgs(bot)).some(m => m.by === bot && m.text === '又一次'));

  // ---------- an attachment Grok Bot can download (tunnel direct; JSON through the site) ----------
  const fileMsg = reply.files[0];
  const direct = await fetch(s.remoteUrl + '/api/hook/' + token + '/file/' + fileMsg.id);
  assert.equal(direct.status, 200);
  assert.equal(await direct.text(), 'a,b\n1,2\n');
  const viaSite = await (await fetch(x.siteUrl + '/api/hook/' + token + '/file/' + fileMsg.id + '?b64=1')).json();
  assert.equal(Buffer.from(viaSite.data, 'base64').toString(), 'a,b\n1,2\n');

  // ---------- 401: wrong token, wrong bearer; a routine's token can't post replies; bot tokens can't hand out work ----------
  const wrong = 'f'.repeat(48);
  for (const [u, h] of [[x.siteUrl + '/api/hook/' + wrong + '/reply', {}], [s.remoteUrl + '/api/hook/' + wrong + '/reply', {}], [s.remoteUrl + '/api/hook/' + token + '/reply', { authorization: 'Bearer ' + wrong }]]) {
    const r = await jpost(u, { job: b.job, text: 'x' }, h);
    assert.equal(r.status, 401, u);
    assert.deepEqual(await r.json(), { error: '交接網址不正確' });
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
  }
  const hk = (await api('POST', 'routines', { conv: bot, name: '外部交接', trigger: 'hook', prompt: '照交接內容處理' })).data.hook;
  assert.equal((await jpost(s.remoteUrl + '/api/hook/' + hk + '/reply', { job: b.job, text: 'x' })).status, 404, 'a routine token: no reply endpoint');
  assert.equal((await jpost(s.remoteUrl + '/api/hook/' + token, { text: 'new work' })).status, 405, 'a bot token: only its callbacks');
  const pre = await fetch(s.remoteUrl + '/api/hook/' + token + '/reply', { method: 'OPTIONS' });
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get('access-control-allow-headers'), /authorization/);
  // too big a body
  assert.equal((await jpost(s.remoteUrl + '/api/hook/' + token + '/reply', { job: b.job, text: 'x'.repeat(70000) })).status, 413);
  void L;
});

test('Grok Bot（雲端）: approval round-trip, 停止 then a late reply, a bad file, failures and the hourly limit',
  { skip: !hasDeps && 'desktop packages not installed', timeout: 120000 }, async t => {
  const x = await setup(t);
  const { api, grok, msgs } = x;
  const { bot } = await gcBot(x, '小雲');
  // ---------- an approval: ✅待確認 → the card; 核准 → a second webhook run that says so ----------
  grok.setPlan(async b => { await say(b, 'reply', { text: '信擬好了：\n✅待確認：寄出報價信\n對象：王先生\n內容：報價 1,000 元' }); });
  await api('POST', 'messages', { conv: bot, text: '寄報價信給王先生' });
  const ask = await until(async () => (await msgs(bot)).find(m => m.by === bot && m.meta?.approval));
  assert.equal(ask.meta.approval.what, '寄出報價信');
  const runs = grok.calls.length;
  grok.setPlan(async b => { await say(b, 'reply', { text: '已寄出。\n✅ 完成：報價信寄給王先生了' }); });
  await api('POST', 'messages', { conv: bot, text: '核准：寄出報價信' });
  await until(() => grok.calls.length > runs);
  const second = grok.calls.at(-1).body;
  assert.equal(second.approved, true);
  assert.match(second.task, /^核准：寄出報價信/);
  assert.ok(second.history.some(h => /✅待確認：寄出報價信/.test(h.text)), 'the same context: the approval request is in the history');
  await until(async () => (await msgs(bot)).some(m => m.by === bot && /已寄出/.test(m.text)));

  // ---------- 停止: nothing is sent to Grok Bot; progress answers stop; a late reply is only a note ----------
  let held = null;
  grok.setPlan(async b => { held = b; });
  await api('POST', 'messages', { conv: bot, text: '查一下明天的天氣' });
  await until(() => held);
  const before = grok.calls.length;
  await api('POST', 'cancel', { conv: bot });
  assert.deepEqual((await say(held, 'progress', { progress: '還在查' })).data, { ok: true, stop: true });
  const late = await say(held, 'reply', { text: '明天晴，28 度' });
  assert.equal(late.data.late, true);
  const ms = await msgs(bot);
  assert.ok(ms.some(m => m.kind === 'note' && /停止後才回覆/.test(m.text) && /明天晴/.test(m.text)));
  assert.ok(!ms.some(m => m.by === bot && !m.kind && /明天晴/.test(m.text)), 'not posted as the answer');
  assert.equal(grok.calls.length, before, 'nothing sent to Grok Bot for 停止');

  // ---------- a file that is really a sign-in page, and one on a private address ----------
  grok.setPlan(async b => { await say(b, 'reply', { text: '附上檔案。', files: [{ name: 'data.xlsx', url: x.grokUrl + '/files/login' }, { name: 'x.pdf', url: 'https://192.168.0.5/x.pdf' }] }); });
  await api('POST', 'messages', { conv: bot, text: '下載報表' });
  const bad = await until(async () => (await msgs(bot)).find(m => m.by === bot && /附上檔案/.test(m.text)));
  assert.match(bad.text, /有 2 個檔案沒能存下來/);
  assert.match(bad.text, /下載到的是網頁/);
  assert.match(bad.text, /公開的 https/);

  // ---------- the routine's key is wrong: said once, no other AI, no retry ----------
  const n0 = grok.calls.length;
  await api('POST', `grokcloud/${bot}`, { url: x.grokUrl + '/hooks/routine-1', key: 'wrong-key-0000' });
  await api('POST', 'messages', { conv: bot, text: '再試一次' });
  const f401 = await until(async () => (await msgs(bot)).find(m => m.kind === 'fail' && /Grok Bot 拒絕了/.test(m.text)));
  assert.ok(f401);
  assert.equal(grok.calls.length, n0);
  await api('POST', `grokcloud/${bot}`, { url: x.grokUrl + '/hooks/routine-1', key: grok.key });

  // ---------- Grok Bot's hourly limit: OCTA stops at 200 runs a routine and waits ----------
  const st = await api('GET', `grokcloud/${bot}`);
  assert.equal(st.data.limit, 200);
  const before2 = grok.calls.length;
  for (let i = 0; i < 200; i++) await x.s.db.prepare('INSERT INTO gc_runs (user_id,bot_id,at) VALUES (?,?,?)').bind('local', bot, Date.now()).run();
  await api('POST', 'messages', { conv: bot, text: '超過上限的工作' });
  const note = await until(async () => (await msgs(bot)).find(m => /每小時最多執行 200 次/.test(m.text)));
  assert.ok(note);
  await new Promise(r => setTimeout(r, 500));
  assert.equal(grok.calls.length, before2, 'not sent');
  const waiting = (await api('GET', 'state')).data.busy.find(j => j.bot_id === bot);
  assert.equal(waiting.status, 'pending', 'it waits for the next free run');
  assert.equal((await api('POST', `grokcloud/${bot}/test`)).data.test.state, 'error', 'the test ping counts too');
});

test('Grok Bot（雲端）: no other AI for this bot — compaction is refused, weekly review / group turns go to the webhook; the forwarder passes /reply',
  { skip: !hasDeps && 'desktop packages not installed', timeout: 120000 }, async t => {
  const x = await setup(t);
  const { api, grok, msgs } = x;
  const { bot } = await gcBot(x, '雲一');
  const other = (await api('POST', 'bots', { name: '本機', task: '', engine: 'claude' })).data.id;
  for (let i = 0; i < 4; i++) { await api('POST', 'messages', { conv: bot, text: '訊息 ' + i }); }
  const cp = await api('POST', 'compact', { conv: bot });
  assert.equal(cp.status, 400);
  assert.match(cp.data.error, /不需要壓縮/);
  // standby patrol isn't set up by itself for this AI (each look would be a Grok Bot run)
  assert.ok(!(await api('GET', 'state')).data.routines.some(r => r.conv === bot && r.name === '待命巡查'));
  // a group: the Grok Bot member's turn goes to the webhook, the Claude member's to the runner — each in turn
  grok.setPlan(async b => { await new Promise(r => setTimeout(r, 300)); await say(b, 'reply', { text: '我查好了：A 方案比較便宜。' }); });
  const g = (await api('POST', 'groups', { name: '比價', task: '', members: [bot, other] })).data.id;
  await api('POST', 'messages', { conv: g, text: '比較 A、B 方案' });
  await until(() => grok.calls.some(c => c.body.task.includes('比較 A、B 方案') && c.body.group));
  // while Grok Bot works, the runner only ever sees non-Grok work
  for (let i = 0; i < 3; i++) { const j = (await api('POST', 'runner/next', { slots: 3, wait: false })).data.job; assert.ok(!j || j.bot.id !== bot); if (j) assert.fail('the Claude member must wait its turn'); }
  await until(async () => (await msgs(g)).some(m => m.by === bot && /A 方案/.test(m.text)));
  const next = await until(async () => (await api('POST', 'runner/next', { slots: 3, wait: false })).data.job);
  assert.equal(next.bot.id, other, 'then the next member, on the runner');
  assert.ok(next.history.some(h => /A 方案/.test(h.text)));
  await jpost(x.L + 'runner/done', { id: next.id, ok: true, text: 'B 比較好用' });
  // 旁聊 while it works: another Grok Bot run beside the work (never a local AI)
  let held = null;
  grok.setPlan(async b => { if (!held) held = b; else await say(b, 'reply', { text: '我正在比對規格，大概還要五分鐘。' }); });
  await api('POST', 'messages', { conv: bot, text: '整理三家廠商的規格' });
  await until(() => held);
  await api('POST', 'messages', { conv: bot, text: '你現在做到哪？' });
  const side = await until(() => grok.calls.find(c => c.body.task === '你現在做到哪？'));
  assert.ok(side, 'the side question went to the webhook');
  await until(async () => (await msgs(bot)).some(m => m.by === bot && /五分鐘/.test(m.text)));
  grok.setPlan(async b => { await say(b, 'reply', { text: '⚠ 沒做成：廠商網站打不開' }); });
  await say(held, 'reply', { text: '⚠ 沒做成：廠商網站打不開' });
  await until(async () => (await msgs(bot)).some(m => m.by === bot && /廠商網站打不開/.test(m.text)));
  // the weekly review of this bot: a Grok Bot run too
  const { weeklyReview } = await import(pathToFileURL(join(repo, 'desktop/api/memory.mjs')).href);
  const { REVIEW_TAG } = await import(pathToFileURL(join(repo, 'desktop/api/memory.mjs')).href);
  grok.setPlan(async b => { await say(b, 'reply', { text: '（略過）' }); });
  assert.ok(await weeklyReview({ DB: x.s.db }, x.s.db, 'local', true) >= 1);
  await until(() => grok.calls.some(c => c.body.task.startsWith(REVIEW_TAG)));
  assert.equal((await api('POST', 'runner/next', { slots: 3, wait: false })).data.job, null, 'nothing for the runner');
  // the forwarder (OCTA site) passes reply / progress / file and the Bearer header on
  const fw = [];
  const fetchSpy = async (url, init = {}) => { fw.push([url, init.headers?.authorization || '']); return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } }); };
  const ntfy = fakeNtfy();
  const tk = 'cd'.repeat(24);
  await HL.publishHook({ token: tk, url: 'https://host-1.trycloudflare.com', fetch: ntfy.handle, relay: 'https://ntfy.test' });
  HR.clearCache();
  for (const rest of ['reply', 'progress', 'file/file-abc']) {
    const req = new Request('https://octa.test/api/hook/' + tk + '/' + rest, { method: rest.startsWith('file') ? 'GET' : 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tk }, body: rest.startsWith('file') ? undefined : '{"job":"1"}' });
    const r = await HR.forwardHook(req, tk, rest, { fetch: (u, i) => (u.startsWith('https://ntfy.test') ? ntfy.handle(u, i) : fetchSpy(u, i)), relay: 'https://ntfy.test' });
    assert.equal(r.status, 200, rest);
  }
  assert.deepEqual(fw.map(f => f[0]), ['reply', 'progress', 'file/file-abc'].map(r => 'https://host-1.trycloudflare.com/api/hook/' + tk + '/' + r));
  assert.ok(fw.every(f => f[1] === 'Bearer ' + tk), 'the Bearer header is passed on');
});

test('the runner never starts an AI for a Grok Bot（雲端）job, and the server never hands one out', { skip: !hasDeps && 'desktop packages not installed' }, async () => {
  const src = readFileSync(join(repo, 'desktop/runner/chat.mjs'), 'utf8');
  assert.match(src, /job\.bot\?\.engine === 'grokcloud'\) return api\('runner\/done'/);
  const jobs = readFileSync(join(repo, 'desktop/api/jobs.mjs'), 'utf8');
  assert.match(jobs, /AND NOT \$\{GC_JOB_SQL\}/);
  assert.ok(existsSync(join(repo, 'desktop/api/grokcloud.mjs')));
});

test('the app: Grok Bot（雲端）on the AI page, the Windows card points to it, the old engine gets a one-tap switch', () => {
  const ai = readFileSync(join(repo, 'app/js/ai.js'), 'utf8');
  assert.match(ai, /ENG\.grokcloud=\{n:'Grok Bot（雲端）'/);
  assert.match(ai, /改用 Grok Bot（雲端）/);
  assert.match(ai, /使用你的 Grok Bot 額度/);
  void fnSrc;
});

test('Grok Bot（雲端） never quietly uses another AI: switching drops backups, and a bot not set up yet is not handed to a backup', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../desktop/api/manage-routes.mjs', import.meta.url), 'utf8');
  assert.match(src, /engine === 'grokcloud' && old\?\.engine !== 'grokcloud'\) fb = '\[\]'/);
  assert.match(src, /engine === 'grokcloud' \? '\[\]' : fbOk\(body\.fb\)/);
  const gc = (await import('node:fs')).readFileSync(new URL('../desktop/api/grokcloud.mjs', import.meta.url), 'utf8');
  assert.match(gc, /kind !== 'not_logged_in' \? \(bot\?\.fb/);
});

test('4.15.1 a long job: the reply fields come first, the body stays small (cut → context_url); files other bots made can be downloaded', async t => {
  // gcFit: the body never grows past the limit, the answer fields stay whole and first
  const long = 'x'.repeat(2900);
  const full = { job: '7', reply_url: 'https://o/api/hook/t/reply', progress_url: 'https://o/api/hook/t/progress', reply_token: 'ab'.repeat(24), context_url: 'https://o/api/hook/t/context/7', task: '剪 8 支影片'.repeat(900), files: [],
    memory: { rules: Array(40).fill('規則'.repeat(40)), facts: [], manuals: [] }, notes: 'n'.repeat(8000), history: Array.from({ length: 30 }, (_, i) => ({ who: 'a', text: long + i })) };
  const fit = GCM.gcFit(full);
  const s = JSON.stringify(fit);
  assert.ok(s.length <= GCM.GC_BODY_MAX, s.length + ' chars');
  assert.equal(fit.cut, true);
  assert.deepEqual(Object.keys(fit).slice(0, 5), ['job', 'reply_url', 'progress_url', 'reply_token', 'context_url']);
  assert.equal(fit.reply_token, full.reply_token);
  assert.equal(GCM.gcFit({ job: '1', task: 'hi', history: [] }).cut, undefined, 'a short body is sent as it is');

  // a colleague's output: listed in the job and downloadable with this bot's token; the whole context by context_url
  const x = await setup(t);
  const { api, grok } = x;
  const maker = await gcBot(x, '剪輯師');
  grok.setPlan(async b => { await say(b, 'reply', { text: '剪好了\n✅ 完成：影片', files: [{ name: '成品影片01.csv', url: x.grokUrl + '/files/report.csv' }] }); });
  await api('POST', 'messages', { conv: maker.bot, text: '剪影片' });
  await until(async () => (await x.msgs(maker.bot)).find(m => m.by === maker.bot && m.files?.length), 20000);
  const yt = await gcBot(x, 'YTBR');
  const ytTok = yt.info.instruction.match(/reply_token：([0-9a-f]{48})/)[1];
  grok.setPlan(async () => {});
  const n0 = grok.calls.length;
  await api('POST', 'messages', { conv: yt.bot, text: '把「成品影片01.csv」上傳到 YouTube' });
  await until(() => grok.calls.length > n0);
  const b = grok.calls.at(-1).body;
  assert.deepEqual(Object.keys(b).slice(0, 4), ['job', 'reply_url', 'progress_url', 'reply_token']);
  const f = b.files.find(x => x.name === '成品影片01.csv');
  assert.ok(f, 'the colleague’s file is listed');
  const got = await fetch(f.url);
  assert.equal(got.status, 200);
  assert.equal(await got.text(), 'a,b\n1,2\n');
  await until(() => x.ntfy.topics.get(HL.hookTopicOf(ytTok))?.length);   // the site knows where this bot's host is
  const ctx = await (await fetch(b.context_url)).json();
  assert.equal(ctx.ok, true);
  assert.match(ctx.task, /成品影片01/);
  // another bot's token can't read this job's context
  const other = maker.info.instruction.match(/reply_token：([0-9a-f]{48})/)[1];
  assert.equal((await fetch(b.context_url.replace(ytTok, other))).status, 404);
});
