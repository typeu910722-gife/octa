// 4.5 交接網址: another AI (Grok Bot, on xAI's cloud computer) hands work to an OCTA bot and follows it up.
// - the host seals its tunnel address per hook token (Node crypto); the OCTA site's forwarder opens it (WebCrypto)
// - /api/hook/<token>: new work → status → inbox (read marks) → feedback (a redo with the context) → teach (memory);
//   a missing or wrong token is always 401 with the same body; CORS * for these routes; group tokens
// - the legacy Pages Function forwards https://octa.yzprojecttw.com/api/hook/<token>/… to the host found on ntfy.sh
//   (fake ntfy.sh + the real host server), without a database; 401 / 503 when it can't
// - Grok Bot on Windows: refused by the API, never tried by the runner, the AI page shows the hand-off URL instead
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { fnSrc } from './app-source.mjs';
const repo = join(import.meta.dirname, '..');
const HL = await import(pathToFileURL(join(repo, 'desktop/host-link.mjs')).href);
const HR = await import(pathToFileURL(join(repo, 'legacy/hook-relay.mjs')).href);
let hasDeps = true;
try { createRequire(join(repo, 'desktop', 'package.json')).resolve('sql.js'); } catch { hasDeps = false; }

function fakeNtfy() {
  const topics = new Map();
  let down = false;
  const handle = async (url, init = {}) => {
    if (down) throw new Error('ENOTFOUND ntfy');
    const u = new URL(url), parts = u.pathname.split('/').filter(Boolean);
    if ((init.method || 'GET') === 'POST') {
      const list = topics.get(parts[0]) || []; list.push({ event: 'message', id: String(list.length), time: Math.floor(Date.now() / 1000), message: String(init.body) });
      topics.set(parts[0], list);
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (parts[1] === 'json' && u.searchParams.get('poll') === '1') return new Response((topics.get(parts[0]) || []).map(m => JSON.stringify(m)).join('\n') + '\n', { status: 200 });
    return new Response('not found', { status: 404 });
  };
  return { topics, handle, setDown: v => (down = v) };
}
async function relayServer() {
  const ntfy = fakeNtfy();
  const srv = http.createServer(async (req, res) => {
    const c = []; for await (const x of req) c.push(x);
    try {
      const r = await ntfy.handle('http://relay' + req.url, { method: req.method, body: Buffer.concat(c).toString() });
      res.writeHead(r.status); res.end(await r.text());
    } catch { res.destroy(); }
  });
  await new Promise(ok => srv.listen(0, '127.0.0.1', ok));
  return { ntfy, url: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() };
}
const jpost = (url, body, headers = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body || {}) });
const jget = async url => { const r = await fetch(url); return { status: r.status, data: await r.json().catch(() => null), headers: r.headers }; };
const until = async (f, ms = 15000) => { const t0 = Date.now(); for (; ;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timed out'); await new Promise(r => setTimeout(r, 100)); } };
const BAD = { error: '交接網址不正確' };

test('the OCTA site opens what the host seals for a hook token (Node crypto ↔ WebCrypto), both ways', async () => {
  const token = 'a1'.repeat(24), other = 'b2'.repeat(24);
  assert.equal(await HR.hookTopic(token), HL.hookTopicOf(token), 'same topic from the token');
  assert.match(HL.hookTopicOf(token), /^[a-z2-7]{32}$/);
  assert.notEqual(HL.hookTopicOf(token), HL.hookTopicOf(other));
  const msg = { v: 1, url: 'https://a-b-c.trycloudflare.com', ts: Date.now() };
  assert.deepEqual(await HR.unsealHook(HL.sealKey(msg, HL.hookKeyOf(token)), token), msg, 'Node → WebCrypto');
  assert.deepEqual(HL.unsealKey(await HR.sealHook(msg, token), HL.hookKeyOf(token)), msg, 'WebCrypto → Node');
  assert.equal(await HR.unsealHook(HL.sealKey(msg, HL.hookKeyOf(token)), other), null, 'another token opens nothing');
  const box = HL.sealKey(msg, HL.hookKeyOf(token));
  assert.equal(await HR.unsealHook(box.slice(0, -4) + 'AAAA', token), null, 'a changed message is refused');
  // the 4.3/4.4 secret-based seal is unchanged (the hook key is a different key)
  const secret = HL.newSecret();
  assert.deepEqual(HL.unseal(HL.seal(msg, secret), secret), msg);
  assert.equal(HL.unsealKey(HL.seal(msg, secret), HL.hookKeyOf(token)), null);
  // where the forwarder may send a request: a quick tunnel only (plus origins allowed for a local check)
  assert.equal(HR.hostAllowed('https://a-b-c.trycloudflare.com'), true);
  for (const u of ['http://a.trycloudflare.com', 'https://evil.example', 'https://a.trycloudflare.com.evil.example', 'https://a.trycloudflare.com/x', 'https://u:p@a.trycloudflare.com', 'http://127.0.0.1:9'])
    assert.equal(HR.hostAllowed(u), false, u);
  assert.equal(HR.hostAllowed('http://127.0.0.1:9', ['http://127.0.0.1:9']), true);
});

test('the forwarder: an old tunnel\'s error page → looks again and uses the new address; a timeout is never sent twice', async () => {
  const ntfy = fakeNtfy(), relay = 'https://ntfy.test', token = 'd4'.repeat(24), calls = [];
  const fetch = async (url, init = {}) => {
    if (url.startsWith(relay)) return ntfy.handle(url, init);
    calls.push((init.method || 'GET') + ' ' + url);
    if (url.startsWith('https://old.trycloudflare.com')) return new Response('<html>Error 1033</html>', { status: 530, headers: { 'content-type': 'text/html' } });
    if (url.startsWith('https://new.trycloudflare.com')) return new Response(JSON.stringify({ ok: true, jobs: [] }), { headers: { 'content-type': 'application/json' } });
    return new Promise((_, no) => init.signal.addEventListener('abort', () => no(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  };
  const req = (m = 'GET') => new Request('https://octa.test/api/hook/' + token + '/inbox', { method: m, headers: { 'content-type': 'application/json' }, body: m === 'POST' ? '{"text":"x"}' : undefined });
  HR.clearCache();
  await HL.publishHook({ token, url: 'https://old.trycloudflare.com', fetch: ntfy.handle, relay });
  let r = await HR.forwardHook(req(), token, 'inbox', { fetch, relay });
  assert.equal(r.status, 503);
  assert.deepEqual(await r.json(), HR.HOST_DOWN);
  // the host restarted and published a new address; the forwarder still has the old one cached
  await HL.publishHook({ token, url: 'https://new.trycloudflare.com', fetch: ntfy.handle, relay, now: Date.now() + 1000 });
  calls.length = 0;
  r = await HR.forwardHook(req(), token, 'inbox', { fetch, relay });
  assert.equal(r.status, 200);
  assert.deepEqual(calls, ['GET https://old.trycloudflare.com/api/hook/' + token + '/inbox', 'GET https://new.trycloudflare.com/api/hook/' + token + '/inbox']);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  // a host that takes too long: 503, and the request is not sent again anywhere
  await HL.publishHook({ token, url: 'https://slow.trycloudflare.com', fetch: ntfy.handle, relay, now: Date.now() + 2000 });
  HR.clearCache();
  calls.length = 0;
  r = await HR.forwardHook(req('POST'), token, '', { fetch, relay, timeoutMs: 50 });
  assert.equal(r.status, 503);
  assert.equal(calls.length, 1);
  // too big a body never leaves the site
  const big = new Request('https://octa.test/api/hook/' + token, { method: 'POST', body: 'x'.repeat(70000) });
  assert.equal((await HR.forwardHook(big, token, '', { fetch, relay })).status, 413);
  assert.equal((await HR.forwardHook(new Request('https://octa.test/x', { method: 'DELETE' }), token, '', { fetch, relay })).status, 405);
});

test('交接網址 API: work → status → inbox → feedback → teach; wrong tokens 401; groups; the OCTA site forwards it',
  { skip: !hasDeps && 'desktop packages not installed', timeout: 120000 }, async t => {
  const { startServer } = await import(pathToFileURL(join(repo, 'desktop/server.mjs')).href);
  const relay = await relayServer();
  const dataDir = mkdtempSync(join(tmpdir(), 'octa-hook-'));
  // the "tunnel" is the remote port itself (like OCTA_TEST_TUNNEL=direct)
  const s = await startServer({ dataDir, runner: false, relay: relay.url, watchMs: 300, tunnel: async port => `http://127.0.0.1:${port}` });
  let closed = false;
  t.after(async () => { if (!closed) await s.close(); relay.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const L = s.url + '/api/';
  const state = async () => (await fetch(L + 'state')).json();
  const next = async () => (await (await jpost(L + 'runner/next', { slots: 1, wait: false })).json()).job;
  const done = (id, text, extra = {}) => jpost(L + 'runner/done', { id, ok: true, text, ...extra });

  assert.equal((await (await fetch(L + 'config')).json()).hook, 'https://octa.yzprojecttw.com', 'the app shows the public address');
  const bot = (await (await jpost(L + 'bots', { name: '助理', task: '整理訂單' })).json()).id;
  const hk = await (await jpost(L + 'routines', { conv: bot, name: '外部交接', trigger: 'hook', prompt: '其他 AI 把工作交接給你：照交接內容處理，完成後在這裡回報結果；資訊不夠就直接問使用者。' })).json();
  const token = hk.hook;
  assert.match(token, /^[0-9a-f]{48}$/);
  const H = s.remoteUrl + '/api/hook/' + token;   // what the tunnel (and the forwarder) calls

  // ---------- wrong or missing token: 401, the same body everywhere ----------
  const wrong = s.remoteUrl + '/api/hook/' + 'f'.repeat(48);
  for (const [m, u, b] of [['GET', wrong], ['POST', wrong, { text: 'x' }], ['GET', wrong + '/job/h' + '0'.repeat(20)], ['GET', wrong + '/inbox'],
    ['POST', wrong + '/feedback', { job: 'h' + '0'.repeat(20), text: 'x' }], ['POST', wrong + '/teach', { text: 'x' }],
    ['GET', s.remoteUrl + '/api/hook/abc'], ['GET', s.remoteUrl + '/api/hook/' + token.toUpperCase()], ['GET', L + 'hook/' + 'f'.repeat(48) + '/inbox']]) {
    const r = await fetch(u, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
    assert.equal(r.status, 401, m + ' ' + u);
    assert.deepEqual(await r.json(), BAD);
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
  }
  // only the exact hook shapes skip pairing on the tunnel ("..": no way into the rest of the API)
  const raw = p => new Promise(ok => http.get({ host: '127.0.0.1', port: s.remotePort, path: p }, r => { let d = ''; r.on('data', c => (d += c)); r.on('end', () => ok({ status: r.statusCode, body: d })); }));
  for (const p of [`/api/hook/${token}/../../state`, `/api/hook/${token}/%2e%2e/%2e%2e/state`, `/api/hook/${token}/job/../../state`]) {
    const r = await raw(p);
    assert.notEqual(r.status, 200, p);
    assert.doesNotMatch(r.body, /助理/, p);
  }
  // CORS preflight for callers in a browser
  const pre = await fetch(H + '/inbox', { method: 'OPTIONS' });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), '*');
  assert.match(pre.headers.get('access-control-allow-methods'), /POST/);
  assert.deepEqual((await jget(H)).data, { ok: true, routine: '外部交接' }, 'a service can check the address');

  // ---------- new work ----------
  const c1 = await (await jpost(H, { text: '整理今天的訂單', from: 'Grok Bot' })).json();
  assert.equal(c1.ok, true);
  assert.match(c1.job, /^h[0-9a-f]{20}$/);
  let st = await jget(H + '/job/' + c1.job);
  assert.equal(st.status, 200);
  assert.equal(st.data.status, 'running');
  assert.equal(st.data.queued, true, 'waiting for the runner');
  assert.equal(st.headers.get('access-control-allow-origin'), '*');
  assert.deepEqual((await jget(H + '/inbox')).data.jobs, [], 'nothing finished yet');
  // shown in the work panel (not the chat), sender named
  const msgs = (await (await fetch(L + 'messages?conv=' + bot)).json()).msgs;
  const note = msgs.find(m => m.text.startsWith('📨 來自 Grok Bot：整理今天的訂單'));
  assert.ok(note, JSON.stringify(msgs.map(m => m.text)));
  assert.equal(note.kind, 'bg');
  const j1 = await next();
  assert.equal(j1.bot.id, bot);
  assert.match(j1.prompt, /來自「Grok Bot」的工作/);
  assert.match(j1.prompt, /整理今天的訂單/);
  st = await jget(H + '/job/' + c1.job + '?peek=1');
  assert.equal(st.data.status, 'running');
  assert.equal(st.data.queued, undefined, 'started');
  await done(j1.id, '今天有 3 筆訂單，合計 1,200 元。', { files: [{ path: '助理/輸出/訂單.csv', name: '訂單.csv', size: 12 }] });
  st = await jget(H + '/job/' + c1.job + '?peek=1');
  assert.equal(st.data.status, 'done', JSON.stringify(st.data));
  assert.equal(st.data.text, '今天有 3 筆訂單，合計 1,200 元。');
  assert.deepEqual(st.data.files.map(f => f.name), ['訂單.csv']);
  assert.match(st.data.files[0].id, /^file-/);
  // the reply itself goes to the chat like any routine's reply
  assert.ok((await (await fetch(L + 'messages?conv=' + bot)).json()).msgs.some(m => m.by === bot && m.text.includes('3 筆訂單') && !m.kind));

  // ---------- inbox: finished and unread, then marked read ----------
  assert.deepEqual((await jget(H + '/inbox?peek=1')).data.jobs.map(j => j.job), [c1.job], 'peek leaves it unread');
  const inbox = (await jget(H + '/inbox')).data;
  assert.equal(inbox.ok, true);
  assert.deepEqual(inbox.jobs.map(j => [j.job, j.status, j.from]), [[c1.job, 'done', 'Grok Bot']]);
  assert.match(inbox.jobs[0].text, /3 筆訂單/);
  assert.deepEqual((await jget(H + '/inbox')).data.jobs, [], 'read once');
  // reading a finished job by its id marks it read too
  const c2 = (await (await jpost(H, { text: '查庫存' })).json()).job;
  await done((await next()).id, '庫存正常');
  assert.equal((await jget(H + '/job/' + c2)).data.status, 'done');
  assert.deepEqual((await jget(H + '/inbox')).data.jobs, []);
  // a failed job
  const c3 = (await (await jpost(H, { text: '登入後台' })).json()).job;
  await jpost(L + 'runner/done', { id: (await next()).id, ok: false, stopped: true, text: '使用者按了停止' });
  const f3 = (await jget(H + '/job/' + c3 + '?peek=1')).data;
  assert.equal(f3.status, 'failed', JSON.stringify(f3));
  assert.deepEqual((await jget(H + '/inbox')).data.jobs.map(j => [j.job, j.status]), [[c3, 'failed']], JSON.stringify({ c1: c1.job, c2, c3 }));
  assert.equal((await jget(H + '/job/h' + '0'.repeat(20))).status, 404);
  assert.equal((await (await jpost(H, { text: '   ' })).json()).ok, true, 'no text: an event, as before 4.5');

  // ---------- feedback: a redo with the original, the last result and the correction ----------
  for (let j; (j = await next());) await done(j.id, '（略過）');   // (the event above)
  const busy = (await (await jpost(H, { text: '寫週報' })).json()).job;
  assert.equal((await jpost(H + '/feedback', { job: busy, text: '不對' })).status, 409, 'still working');
  await done((await next()).id, '週報寫好了');
  assert.equal((await jget(H + '/job/' + busy)).data.text, '週報寫好了');   // (read: not in the inbox later)
  assert.equal((await jpost(H + '/feedback', { job: 'h' + '1'.repeat(20), text: 'x' })).status, 404);
  assert.equal((await jpost(H + '/feedback', { job: c1.job })).status, 400, 'needs the correction');
  const fb = await (await jpost(H + '/feedback', { job: c1.job, text: '以後金額都要含稅', from: 'Grok Bot' })).json();
  assert.equal(fb.ok, true);
  assert.match(fb.job, /^h[0-9a-f]{20}$/);
  assert.notEqual(fb.job, c1.job);
  assert.equal(fb.remembered, '以後金額都要含稅', 'a rule for the future is kept right away');
  const jr = await next();
  for (const x of ['整理今天的訂單', '今天有 3 筆訂單，合計 1,200 元。', '以後金額都要含稅', '重做']) assert.ok(jr.prompt.includes(x), x + ' in ' + jr.prompt);
  assert.ok((await state()).memory[bot].includes('以後金額都要含稅'));
  assert.ok((await (await fetch(L + 'messages?conv=' + bot)).json()).msgs.some(m => m.kind === 'bg' && m.text.startsWith('✏️ Grok Bot 指正，重做')));
  await done(jr.id, '含稅合計 1,260 元。');
  const r2 = (await jget(H + '/job/' + fb.job)).data;
  assert.equal(r2.status, 'done');
  assert.equal(r2.redo, c1.job);
  assert.equal(r2.text, '含稅合計 1,260 元。');

  // ---------- teach ----------
  assert.equal((await jpost(H + '/teach', {})).status, 400);
  const te = await (await jpost(H + '/teach', { text: '回報時用表格，金額靠右', from: 'Grok Bot' })).json();
  assert.deepEqual(te, { ok: true, saved: 'rule', bots: ['助理'] });
  assert.ok((await state()).memory[bot].includes('回報時用表格，金額靠右'));
  const tm = await (await jpost(H + '/teach', { name: '月結', text: '1. 打開後台\n2. 匯出本月訂單\n3. 加總含稅金額' })).json();
  assert.equal(tm.saved, 'manual');
  assert.equal((await state()).manuals[bot].find(m => m.name === '月結')?.steps, '1. 打開後台\n2. 匯出本月訂單\n3. 加總含稅金額');
  assert.ok((await (await fetch(L + 'messages?conv=' + bot)).json()).msgs.some(m => m.kind === 'bg' && m.text.startsWith('🧠 Grok Bot 教了：')));

  // ---------- a group's token: members in order, every reply comes back; teach reaches every member ----------
  const bot2 = (await (await jpost(L + 'bots', { name: '會計', task: '' })).json()).id;
  const grp = (await (await jpost(L + 'groups', { name: '店務', task: '', members: [bot, bot2] })).json()).id;
  assert.ok(grp);
  const gt = (await (await jpost(L + 'routines', { conv: grp, name: '外部交接', trigger: 'hook', prompt: '照交接內容處理' })).json()).hook;
  const G = s.remoteUrl + '/api/hook/' + gt;
  const gj = (await (await jpost(G, { text: '月底結帳', from: 'Grok Bot' })).json()).job;
  assert.equal((await jget(H + '/job/' + gj)).status, 404, 'another token can\'t read it');
  const a = await next();
  assert.equal(a.bot.id, bot);
  await done(a.id, '訂單整理好了');
  assert.equal((await jget(G + '/job/' + gj + '?peek=1')).data.status, 'running', 'the next member is still to go');
  const b = await next();
  assert.equal(b.bot.id, bot2);
  await done(b.id, '帳結好了');
  const gs = (await jget(G + '/job/' + gj)).data;
  assert.equal(gs.status, 'done');
  assert.match(gs.text, /【助理】\n訂單整理好了/);
  assert.match(gs.text, /【會計】\n帳結好了/);
  assert.deepEqual((await (await jpost(G + '/teach', { text: '結帳前先對發票' })).json()).bots, ['助理', '會計']);
  const mem = (await state()).memory;
  assert.ok(mem[bot].includes('結帳前先對發票') && mem[bot2].includes('結帳前先對發票'));
  // a paused hook takes no new work
  const rid = (await state()).routines.find(r => r.hook === gt).id;
  await fetch(L + 'routines/' + rid, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }) });
  assert.equal((await jpost(G, { text: 'x' })).status, 409);

  // ---------- the OCTA site: the legacy Pages Function forwards to the host found on ntfy.sh ----------
  const site = await import(pathToFileURL(join(repo, 'functions/api/[[path]].js')).href);
  const env = { HOOK_RELAY: relay.url, HOOK_ALLOW_ORIGINS: s.remoteUrl };   // no DB: the forwarder never touches one
  const viaSite = async (method, path, body) => {
    const request = new Request('https://octa.test/api/' + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const r = await site.onRequest({ request, env, params: { path: path.split('?')[0].split('/') } });
    return { status: r.status, data: await r.json().catch(() => null), headers: r.headers };
  };
  // the host published its tunnel address for every hook token (sealed per token)
  await until(() => relay.ntfy.topics.get(HL.hookTopicOf(token))?.length && relay.ntfy.topics.get(HL.hookTopicOf(gt))?.length);
  const pub = relay.ntfy.topics.get(HL.hookTopicOf(token)).at(-1).message;
  assert.ok(!pub.includes('127.0.0.1') && !pub.includes(token), 'only an encrypted blob on ntfy.sh');
  assert.equal(HL.unsealKey(pub, HL.hookKeyOf(token)).url, s.remoteUrl);
  const ds = await (await fetch(L + 'desktop/status')).json();
  assert.equal(ds.hooks.tunnel, s.remoteUrl);
  assert.ok(ds.hooks.published >= 2);
  assert.equal((await state()).hookTunnel, s.remoteUrl);

  HR.clearCache();
  const t0 = Date.now();
  const sc = await viaSite('POST', 'hook/' + token, { text: '經網站交派的工作', from: 'Grok Bot' });
  const firstMs = Date.now() - t0;
  assert.equal(sc.status, 200, JSON.stringify(sc.data));
  assert.match(sc.data.job, /^h[0-9a-f]{20}$/);
  assert.equal(sc.headers.get('access-control-allow-origin'), '*');
  assert.equal((await viaSite('GET', 'hook/' + token + '/job/' + sc.data.job)).data.status, 'running');
  await done((await next()).id, '經網站的結果');
  const sj = await viaSite('GET', 'hook/' + token + '/job/' + sc.data.job + '?peek=1');
  assert.equal(sj.data.status, 'done');
  assert.equal(sj.data.text, '經網站的結果');
  assert.deepEqual((await viaSite('GET', 'hook/' + token + '/inbox')).data.jobs.map(j => j.job), [sc.data.job]);
  assert.deepEqual((await viaSite('GET', 'hook/' + token + '/inbox')).data.jobs, []);
  const sf = await viaSite('POST', 'hook/' + token + '/feedback', { job: sc.data.job, text: '請附上日期' });
  assert.equal(sf.status, 200);
  assert.match((await next()).prompt, /請附上日期/);
  assert.equal((await viaSite('POST', 'hook/' + token + '/teach', { text: '日期用 YYYY-MM-DD' })).data.saved, 'rule');
  const pf = await viaSite('OPTIONS', 'hook/' + token + '/inbox');
  assert.equal(pf.status, 204);
  // wrong / unknown / malformed tokens: the same 401, whether the forwarder or the host says no
  for (const p of ['hook/' + 'e'.repeat(48), 'hook/' + 'e'.repeat(48) + '/inbox', 'hook/nope', 'hook', 'hook/' + token.slice(0, 47)]) {
    const r = await viaSite('GET', p);
    assert.equal(r.status, 401, p);
    assert.deepEqual(r.data, BAD);
  }
  // someone publishing an address for a token of their own can't point the forwarder anywhere else
  const own = 'c3'.repeat(24);
  await HL.publishHook({ token: own, url: 'https://evil.example', fetch: relay.ntfy.handle, relay: 'http://relay' });
  assert.equal((await viaSite('GET', 'hook/' + own)).status, 401);
  // the token at the host is gone (routine deleted) while its address is still on ntfy.sh: 401 from the host
  const gone = (await state()).routines.find(r => r.hook === gt).id;
  assert.equal((await fetch(L + 'routines/' + gone, { method: 'DELETE', headers: { 'content-type': 'application/json' } })).status, 200);
  const gr = await viaSite('GET', 'hook/' + gt + '/inbox');
  assert.equal(gr.status, 401);
  assert.deepEqual(gr.data, BAD);
  // ntfy.sh unreachable (nothing cached): 503
  HR.clearCache();
  relay.ntfy.setDown(true);
  assert.equal((await viaSite('GET', 'hook/' + token + '/inbox')).status, 503);
  relay.ntfy.setDown(false);
  // the host computer is off: 503 主機電腦沒有連線
  await s.close(); closed = true;
  HR.clearCache();
  const off = await viaSite('GET', 'hook/' + token + '/inbox');
  assert.equal(off.status, 503);
  assert.deepEqual(off.data, { error: '主機電腦沒有連線' });
  t.diagnostic(`first call through the site (ntfy lookup + forward): ${firstMs} ms`);
});

test('Grok Bot on Windows: the API refuses it, the runner never tries it, the AI page offers the hand-off URL', { skip: !hasDeps && 'desktop packages not installed', timeout: 60000 }, async t => {
  const { startServer } = await import(pathToFileURL(join(repo, 'desktop/server.mjs')).href);
  const dataDir = mkdtempSync(join(tmpdir(), 'octa-gbwin-'));
  const s = await startServer({ dataDir, runner: false, platform: 'win32', relay: 'http://127.0.0.1:9', port: 21000 + Math.floor(Math.random() * 9000) * 2 });
  t.after(async () => { await s.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const L = s.url + '/api/';
  assert.equal((await (await fetch(L + 'state')).json()).hostOs, 'win32');
  for (const [p, b] of [['grokbot/list', {}], ['engine-test', { engine: 'grokbot' }], ['bots', { name: 'G', engine: 'grokbot', model: 'x' }]]) {
    const r = await jpost(L + p, b);
    assert.equal(r.status, 400, p);
    assert.match((await r.json()).error, /Windows 不支援，請改用交接網址/);
  }
  assert.equal((await (await jpost(L + 'engine-test', { engine: 'claude' })).json()).id > 0, true, 'other AIs are tested as before');

  // the runner: nothing is looked for or started for Grok Bot; the engine is unavailable, with the reason
  const st = await import(pathToFileURL(join(repo, 'desktop/runner/state.mjs')).href);
  const gb = await import(pathToFileURL(join(repo, 'desktop/runner/grokbot.mjs')).href);
  const eng = await import(pathToFileURL(join(repo, 'desktop/runner/engines.mjs')).href);
  const route = await import(pathToFileURL(join(repo, 'desktop/lib/model-route.mjs')).href);
  st.configure({ url: 'http://127.0.0.1:9', home: dataDir, platform: 'win32' });
  assert.equal(gb.grokBotUnsupported(), true);
  assert.deepEqual(gb.grokBotEnv(), { missing: '(Windows)', unsupported: true });
  delete eng.installed.gbot;
  assert.equal(await eng.engineReady('grokbot', true), false);
  assert.equal(eng.installed.gbot, undefined, 'grok-bot-cli was not even looked for');
  const r = await gb.runGrokBot({ bot: { model: 'x' }, prompt: 'hi', history: [] }, {});
  assert.equal(r.ok, false);
  assert.match(r.text, /Windows 不支援 Grok Bot/);
  assert.equal(route.classifyModelFailure(r.text), 'unavailable', 'a backup AI takes over; no retries on the same one');
  await assert.rejects(gb.grokBots(), /Windows 不支援 Grok Bot/);
  // macOS / Linux unchanged
  st.configure({ url: 'http://127.0.0.1:9', home: dataDir, platform: 'darwin' });
  assert.equal(gb.grokBotUnsupported(), false);
  st.configure({ url: 'http://127.0.0.1:9', home: dataDir });

  // a Linux / Mac host still accepts Grok Bot bots
  const d2 = mkdtempSync(join(tmpdir(), 'octa-gbmac-'));
  const s2 = await startServer({ dataDir: d2, runner: false, platform: 'darwin', relay: 'http://127.0.0.1:9', port: 41000 + Math.floor(Math.random() * 9000) * 2 });
  t.after(async () => { await s2.close(); rmSync(d2, { recursive: true, force: true }); });
  assert.equal((await jpost(s2.url + '/api/bots', { name: 'G', engine: 'grokbot', model: 'x' })).status, 200);

  // the AI page's Grok Bot section, drawn for a Windows host and for a Mac host
  const draw = hostOs => {
    const gb2 = { innerHTML: '', querySelectorAll: () => [], querySelector: () => null };
    const S = { hostOs, bots: [{ id: 'b1', name: '助理' }], routines: [{ id: 'r1', conv: 'b1', hook: 'a'.repeat(48), name: '外部交接' }], runnerOnline: true };
    const f = new Function('S', 'esc', 'ic', 'hookNote', 'paintIcons', '$', 'api', 'refresh', 'toast', 'grokImport', fnSrc('grokWin') + '\n' + fnSrc('paintGrok') + '\nreturn paintGrok;');
    f(S, x => String(x), () => '', () => '', () => { }, () => null, null, null, null, null)(gb2);
    return gb2.innerHTML;
  };
  const win = draw('win32'), mac = draw('darwin');
  assert.match(win, /Windows 不支援，請改用交接網址/);
  assert.match(win, /取得交接網址/);
  assert.doesNotMatch(win, /data-gbimport/, 'no import (grok-bot-cli) on Windows');
  assert.match(win, /data-hookspec="r1"/, 'the hand-off URL is right there');
  assert.doesNotMatch(mac, /Windows 不支援/);
  assert.match(mac, /data-gbimport/);
});

test('the text to paste into the other AI has the public URL with the token and every endpoint', () => {
  const r = { id: 'r1', hook: 'ab'.repeat(24) };
  const g = new Function('CFG', 'document', fnSrc('hookUrl') + '\n' + fnSrc('hookSpec') + '\nreturn hookSpec;');
  const f = cfg => g(cfg, { addEventListener() { } });
  const spec = f({ hook: 'https://octa.yzprojecttw.com' })(r, '助理');
  const base = 'https://octa.yzprojecttw.com/api/hook/' + r.hook;
  for (const x of [`POST ${base}`, `GET ${base}/job/<job id>`, `GET ${base}/inbox`, `POST ${base}/feedback`, `POST ${base}/teach`, '"from":"Grok Bot"', '401', '助理'])
    assert.ok(spec.includes(x), x);
});
