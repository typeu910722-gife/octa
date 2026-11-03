// 4.3 主機電腦／遙控器: one computer keeps the data and does the work, another one is its remote control.
// Unit tests for desktop/host-link.mjs (link code, encrypted relay messages, finding the host again) and an
// end-to-end test with two real desktop servers (A = host, B = remote control) talking through their remote ports
// directly (the Cloudflare tunnel is replaced by the port itself) and a fake ntfy.sh relay.
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
const repo = join(import.meta.dirname, '..');
const HL = await import(pathToFileURL(join(repo, 'desktop/host-link.mjs')).href);
let hasDeps = true;
try { createRequire(join(repo, 'desktop', 'package.json')).resolve('sql.js'); } catch { hasDeps = false; }

// an in-memory ntfy.sh: POST /<topic> keeps the body, GET /<topic>/json?poll=1 answers one JSON line per message
function fakeNtfy() {
  const topics = new Map();
  let down = false;
  const handle = async (url, init = {}) => {
    if (down) throw new Error('ENOTFOUND ntfy');
    const u = new URL(url), parts = u.pathname.split('/').filter(Boolean);
    if ((init.method || 'GET') === 'POST') {
      const list = topics.get(parts[0]) || []; list.push({ event: 'message', id: String(list.length), time: Math.floor(Date.now() / 1000), message: String(init.body) });
      topics.set(parts[0], list);
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (parts[1] === 'json' && u.searchParams.get('poll') === '1') return new Response((topics.get(parts[0]) || []).map(m => JSON.stringify(m)).join('\n') + '\n', { status: 200 });
    return new Response('not found', { status: 404 });
  };
  return { topics, handle, setDown: v => (down = v) };
}

test('link code: one string with the address and the code, or the two pasted separately', () => {
  const code = HL.encodeLinkCode({ url: 'https://able-baker-cat.trycloudflare.com/', code: 'abcd2345' });
  assert.equal(code, 'https://able-baker-cat.trycloudflare.com#octa-link=ABCD2345');
  assert.deepEqual(HL.decodeLinkCode(code), { url: 'https://able-baker-cat.trycloudflare.com', code: 'ABCD2345' });
  assert.deepEqual(HL.decodeLinkCode('  able-baker-cat.trycloudflare.com   abcd-2345 '), { url: 'https://able-baker-cat.trycloudflare.com', code: 'ABCD2345' });
  assert.deepEqual(HL.decodeLinkCode('https://x.trycloudflare.com', 'ABCD2345'), { url: 'https://x.trycloudflare.com', code: 'ABCD2345' });
  assert.match(HL.decodeLinkCode('https://x.trycloudflare.com#octa-link=AB').error, /8 碼/);
  assert.ok(HL.decodeLinkCode('http://evil.example#octa-link=ABCD2345').error, 'plain http only for this computer itself');
  assert.ok(!HL.decodeLinkCode('http://127.0.0.1:9#octa-link=ABCD2345').error);
  assert.ok(HL.decodeLinkCode('').error);
});

test('relay messages: topic and key come from the shared secret; only the right secret opens them', async () => {
  const secret = HL.newSecret(), other = HL.newSecret();
  assert.match(HL.topicOf(secret), /^[a-z2-7]{32}$/);
  assert.notEqual(HL.topicOf(secret), HL.topicOf(other));
  const box = HL.seal({ url: 'https://a.trycloudflare.com', epoch: 3 }, secret);
  assert.ok(!box.includes('trycloudflare'), 'the address is not readable on the relay');
  assert.deepEqual(HL.unseal(box, secret), { url: 'https://a.trycloudflare.com', epoch: 3 });
  assert.equal(HL.unseal(box, other), null);
  assert.equal(HL.unseal(box.slice(0, -4) + 'AAAA', secret), null, 'tampered');

  const ntfy = fakeNtfy();
  const base = { secret, fetch: ntfy.handle, relay: 'https://ntfy.test' };
  await HL.publishHost({ ...base, url: 'https://one.trycloudflare.com/', epoch: 1, hostId: 'A', hostName: '店裡' });
  await HL.publishHost({ ...base, url: 'https://two.trycloudflare.com', epoch: 2, hostId: 'B', hostName: '家裡' });
  await HL.publishHost({ ...base, url: 'https://three.trycloudflare.com', epoch: 1, hostId: 'A', hostName: '店裡' });   // an old host still talking: lower epoch loses
  // someone without the secret writes to the topic; a message from the far future
  ntfy.topics.get(HL.topicOf(secret)).push({ event: 'message', message: 'hello' }, { event: 'message', message: HL.seal({ v: 1, url: 'https://evil.trycloudflare.com', epoch: 99, hostId: 'X', ts: Date.now() + 86400000 }, secret) });
  assert.equal(ntfy.topics.size, 1);
  const m = await HL.pollHost(base);
  assert.equal(m.url, 'https://two.trycloudflare.com');
  assert.equal(m.epoch, 2); assert.equal(m.hostId, 'B'); assert.equal(m.hostName, '家裡');
  ntfy.setDown(true);
  await assert.rejects(HL.pollHost(base), e => e.code === 'relay-down');
});

test('finding the host again: the last address is dead → the relay has the new one', async () => {
  const secret = HL.newSecret(), ntfy = fakeNtfy();
  const hosts = { 'https://new.trycloudflare.com': { hostId: 'A', name: '店裡電腦', role: 'host', epoch: 0 } };
  const fetch = async (url, init) => {
    if (url.startsWith('https://ntfy.test')) return ntfy.handle(url, init);
    const h = hosts[url.replace(/\/api\/link\/hello$/, '')];
    if (!h) throw new Error('ECONNREFUSED');
    if (init?.headers?.authorization !== 'Bearer tok') return new Response('{}', { status: 401 });
    return new Response(JSON.stringify(h), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const link = { role: 'remote', secret, token: 'tok', hostId: 'A', epoch: 0, lastUrl: 'https://old.trycloudflare.com' };
  await assert.rejects(HL.findHost({ link, fetch, relay: 'https://ntfy.test' }), e => e.code === 'down', 'nothing published yet');
  await HL.publishHost({ secret, url: 'https://new.trycloudflare.com', epoch: 0, hostId: 'A', fetch, relay: 'https://ntfy.test' });
  const r = await HL.findHost({ link, fetch, relay: 'https://ntfy.test' });
  assert.equal(r.url, 'https://new.trycloudflare.com'); assert.equal(r.via, 'relay');
  assert.equal((await HL.findHost({ link: { ...link, lastUrl: r.url }, fetch, relay: 'https://ntfy.test' })).via, 'last');
  await assert.rejects(HL.findHost({ link: { ...link, token: 'bad' }, fetch, relay: 'https://ntfy.test' }), e => e.code === 'revoked');
  ntfy.setDown(true);
  await assert.rejects(HL.findHost({ link, fetch, relay: 'https://ntfy.test' }), e => e.code === 'relay-down');
  ntfy.setDown(false);

  // the client keeps the new address, and looks again when told the host is gone
  let saved = { ...link };
  const states = [];
  const timers = { setTimeout: () => 0, clearTimeout: () => { } };   // no automatic retries in this test
  const c = HL.createRemoteClient({ getLink: () => saved, saveLink: l => (saved = l), fetch, relay: 'https://ntfy.test', onState: s => states.push(s.state), timers });
  assert.equal(await c.connect(), 'https://new.trycloudflare.com');
  assert.equal(saved.lastUrl, 'https://new.trycloudflare.com');
  assert.equal(saved.hostName, '店裡電腦');
  assert.equal(c.url(), 'https://new.trycloudflare.com');
  // the host restarts: new tunnel address, published again
  delete hosts['https://new.trycloudflare.com'];
  hosts['https://newer.trycloudflare.com'] = { hostId: 'A', name: '店裡電腦', role: 'host', epoch: 0 };
  c.lost('gone');
  assert.equal(c.url(), '');
  assert.equal(c.status().state, 'offline');
  await c.connect();
  assert.equal(c.status().state, 'offline', 'not published yet');
  await HL.publishHost({ secret, url: 'https://newer.trycloudflare.com', epoch: 0, hostId: 'A', fetch, relay: 'https://ntfy.test' });
  assert.equal(await c.connect(), 'https://newer.trycloudflare.com');
  assert.equal(saved.lastUrl, 'https://newer.trycloudflare.com');
  assert.ok(states.includes('online') && states.includes('offline'));
  c.stop();
});

// ---------- two real desktop servers ----------
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
const jget = async url => (await fetch(url)).json();
const until = async (f, ms = 15000) => { const t0 = Date.now(); for (; ;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timed out'); await new Promise(r => setTimeout(r, 100)); } };

test('two computers: link, work through the host, reconnect, remove, switch the host, roll back', { skip: !hasDeps && 'desktop packages not installed', timeout: 120000 }, async t => {
  const { startServer } = await import(pathToFileURL(join(repo, 'desktop/server.mjs')).href);
  const relay = await relayServer();
  const dirA = mkdtempSync(join(tmpdir(), 'octa-A-')), dirB = mkdtempSync(join(tmpdir(), 'octa-B-'));
  let cutA = null;   // A's outgoing calls matching this fail (to break a switch midway)
  const fetchA = (u, i) => (cutA && cutA.test(String(u)) ? Promise.reject(new Error('cut')) : fetch(u, i));
  const opts = { runner: false, relay: relay.url, tunnel: p => `http://127.0.0.1:${p}`, watchMs: 300 };
  const A = await startServer({ ...opts, dataDir: dirA, name: '店裡電腦', fetch: fetchA });
  const B = await startServer({ ...opts, dataDir: dirB, name: '家裡電腦' });
  t.after(async () => { await A.close(); await B.close(); relay.close(); rmSync(dirA, { recursive: true, force: true }); rmSync(dirB, { recursive: true, force: true }); });

  // A has the shop's data; B has a little of its own
  const botA = (await (await jpost(A.url + '/api/bots', { name: '門市小幫手', task: '' })).json()).id;
  await jpost(A.url + '/api/messages', { conv: botA, text: '早安' });
  await jpost(B.url + '/api/bots', { name: '家裡的機器人', task: '' });
  mkdirSync(join(dirA, 'files', '門市小幫手', '輸出'), { recursive: true });
  writeFileSync(join(dirA, 'files', '門市小幫手', '輸出', '報表.txt'), 'A 的報表');

  // nothing linked yet: no tunnel needed, nothing on the relay
  assert.deepEqual((await jget(A.url + '/api/desktop/link')).computers, []);
  assert.equal((await jget(A.url + '/api/desktop/link')).role, 'host');
  // the link endpoints need a linked computer
  assert.equal((await fetch(A.remoteUrl + '/api/link/hello')).status, 401);
  const inv = await (await jpost(A.url + '/api/desktop/link', { act: 'invite' })).json();
  assert.match(inv.code, /^[A-Z2-9]{8}$/);
  assert.equal(inv.linkCode, `${A.remoteUrl}#octa-link=${inv.code}`);
  // a wrong code is refused and nothing changes on B
  const bad = await (await jpost(B.url + '/api/desktop/link', { act: 'connect', code: `${A.remoteUrl}#octa-link=ZZZZZZZZ` })).json();
  assert.match(bad.error, /連線碼錯誤/);
  assert.equal((await jget(B.url + '/api/desktop/link')).role, 'host');
  const ok = await (await jpost(B.url + '/api/desktop/link', { act: 'connect', code: inv.linkCode })).json();
  assert.equal(ok.role, 'remote', JSON.stringify(ok));
  assert.equal(ok.host.name, '店裡電腦');
  // the code worked once
  assert.equal((await jpost(A.remoteUrl + '/api/link/pair', { code: inv.code, id: 'x', name: 'x' })).status, 401);

  const la = await jget(A.url + '/api/desktop/link');
  assert.equal(la.computers.length, 1);
  assert.equal(la.computers[0].name, '家裡電腦');
  assert.equal(la.invite, null);
  // A published its address, encrypted, for the linked computer
  await until(() => relay.ntfy.topics.size === 1);
  const blob = [...relay.ntfy.topics.values()][0][0].message;
  assert.ok(!blob.includes('127.0.0.1'), 'the address travels encrypted');

  // B's window now shows A's data; B's own data stays in B's database untouched
  const cfgB = await jget(B.url + '/api/config');
  assert.deepEqual(cfgB.via, { name: '店裡電腦' });
  const stB = await jget(B.url + '/api/state');
  assert.deepEqual(stB.bots.map(b => b.name), ['門市小幫手']);
  // a message sent on B is queued as a job on A (A's runner will do it)
  const sent = await jpost(B.url + '/api/messages', { conv: botA, text: '幫我看今天的訂單' });
  assert.equal(sent.status, 200, await sent.clone().text());
  const busyA = await jget(A.url + '/api/busy');
  assert.ok(busyA.busy.some(j => j.conv === botA), 'the job waits on A: ' + JSON.stringify(busyA));
  const msgs = await jget(A.url + '/api/messages?conv=' + botA);
  assert.ok(msgs.msgs.some(m => m.text === '幫我看今天的訂單'));
  // B's own controls stay B's; the runner endpoints are not forwarded
  assert.equal((await fetch(B.url + '/api/runner/next')).status, 503);
  assert.equal((await jpost(B.url + '/api/desktop/remote', { on: true })).status, 400, 'the phone remote belongs to the host');
  // A's remote port: a computer works even with the phone remote off; the phone path is still closed
  const tokB = B.link.link().token;
  assert.equal((await fetch(A.remoteUrl + '/api/state', { headers: { authorization: 'Bearer ' + tokB } })).status, 200);
  assert.equal((await fetch(A.remoteUrl + '/api/state')).status, 503);
  assert.equal((await fetch(A.remoteUrl + '/api/desktop/status', { headers: { authorization: 'Bearer ' + tokB } })).status, 403);

  // A's address changed (tunnel restarted): B's request fails, B looks it up on the relay and carries on
  B.link.link();   // (settings exist)
  const l0 = JSON.parse(readFileSync(join(dirB, 'desktop.json'), 'utf8')).link;
  writeFileSync(join(dirB, 'desktop.json'), JSON.stringify({ link: { ...l0, lastUrl: 'http://127.0.0.1:9' } }));
  await jpost(B.url + '/api/desktop/link', { act: 'retry' });
  assert.equal((await jget(B.url + '/api/desktop/link')).host.state, 'online');
  assert.equal(JSON.parse(readFileSync(join(dirB, 'desktop.json'), 'utf8')).link.lastUrl, A.remoteUrl, 'found again through the relay');
  // and when the relay can't be reached either: a clear state, and a way to paste the new address
  writeFileSync(join(dirB, 'desktop.json'), JSON.stringify({ link: { ...l0, lastUrl: 'http://127.0.0.1:9' } }));
  relay.ntfy.setDown(true);
  await jpost(B.url + '/api/desktop/link', { act: 'retry' });
  const off = await fetch(B.url + '/api/state');
  assert.equal(off.status, 503);
  assert.equal((await off.json()).offline, true);
  assert.equal((await jget(B.url + '/api/desktop/link')).host.state, 'relay-down');
  const pasted = await (await jpost(B.url + '/api/desktop/link', { act: 'address', code: A.remoteUrl })).json();
  assert.equal(pasted.host.state, 'online');
  relay.ntfy.setDown(false);
  assert.equal((await fetch(B.url + '/api/state')).status, 200);

  // A removes B: B is told, and can link again with a new code
  await jpost(A.url + '/api/desktop/link', { act: 'remove', id: la.computers[0].id });
  const gone = await fetch(B.url + '/api/state');
  assert.ok([403, 503].includes(gone.status), 'refused (or, with no computer left, A closed its tunnel)');
  await until(async () => (await jget(B.url + '/api/desktop/link')).host.state === 'revoked');
  const again = await fetch(B.url + '/api/state');
  assert.match((await again.json()).error, /移除這台電腦/);
  await jpost(B.url + '/api/desktop/link', { act: 'disconnect' });
  assert.deepEqual((await jget(B.url + '/api/state')).bots.map(b => b.name), ['家裡的機器人'], 'back to its own data, untouched');
  const inv2 = await (await jpost(A.url + '/api/desktop/link', { act: 'invite' })).json();
  assert.equal((await (await jpost(B.url + '/api/desktop/link', { act: 'connect', code: inv2.linkCode })).json()).role, 'remote');

  // the export endpoints need the linked computer, the confirmation and the ticket
  const tok2 = B.link.link().token;
  assert.equal((await jpost(A.remoteUrl + '/api/link/handover/begin', { confirm: 'HANDOVER' })).status, 401);
  assert.equal((await jpost(A.remoteUrl + '/api/link/handover/begin', {}, { authorization: 'Bearer ' + tok2 })).status, 400);
  assert.equal((await fetch(A.remoteUrl + '/api/link/handover/db?ticket=x&off=0', { headers: { authorization: 'Bearer ' + tok2 } })).status, 409);
  // while a handover is open the host takes no new work, and it carries on when it is called off
  const tk = await (await jpost(A.remoteUrl + '/api/link/handover/begin', { confirm: 'HANDOVER' }, { authorization: 'Bearer ' + tok2 })).json();
  assert.ok(tk.ticket && tk.db.counts.bots === 1 && tk.files.count === 1, JSON.stringify(tk));
  assert.equal((await jpost(A.url + '/api/bots', { name: '不該建立', task: '' })).status, 503);
  await jpost(A.remoteUrl + '/api/link/handover/abort', { ticket: tk.ticket }, { authorization: 'Bearer ' + tok2 });
  assert.equal((await jpost(A.url + '/api/messages', { conv: botA, text: '交接取消後照常工作' })).status, 200);

  // 換成這台當主機: B gets A's data and files, A becomes B's remote control
  await jpost(B.url + '/api/desktop/link', { act: 'switch' });
  const done = await until(async () => { const s = await jget(B.url + '/api/desktop/link'); return s.switching?.done && s; }, 30000);
  assert.equal(done.switching.ok, true, JSON.stringify(done.switching));
  assert.equal(done.role, 'host');
  assert.ok(readdirSync(dirB).some(f => f.startsWith('ebot.backup-')), 'B\'s own database is kept as a backup');
  assert.equal(readFileSync(join(dirB, 'files', '門市小幫手', '輸出', '報表.txt'), 'utf8'), 'A 的報表', 'the files folder came along');
  const stB2 = await jget(B.url + '/api/state');
  assert.deepEqual(stB2.bots.map(b => b.name), ['門市小幫手'], 'B now holds the data itself');
  assert.ok((await jget(B.url + '/api/messages?conv=' + botA)).msgs.some(m => m.text === '交接取消後照常工作'));
  await until(async () => (await jget(A.url + '/api/desktop/link')).role === 'remote');
  const la2 = await until(async () => { const s = await jget(A.url + '/api/desktop/link'); return s.host?.state === 'online' && s; });
  assert.equal(la2.host.name, '家裡電腦');
  assert.deepEqual((await jget(A.url + '/api/config')).via, { name: '家裡電腦' });
  assert.deepEqual((await jget(A.url + '/api/state')).bots.map(b => b.name), ['門市小幫手'], 'A shows the data that now lives on B');
  // the relay says B is host now (higher epoch)
  const { pollHost } = HL;
  const newest = await pollHost({ secret: B.link.link().secret, relay: relay.url });
  assert.equal(newest.hostId, B.link.link().id);
  assert.equal(newest.epoch, 1);
  // B lists A as its linked computer; the old phone sessions and B's own remote-control session are gone
  assert.deepEqual((await jget(B.url + '/api/desktop/link')).computers.map(c => c.name), ['店裡電腦']);
  // the old host refuses to act as host for anyone still pointing at it
  assert.equal((await fetch(A.remoteUrl + '/api/state', { headers: { authorization: 'Bearer ' + tok2 } })).status, 409);

  // switching back fails midway (the last step can't reach B): everything goes back the way it was
  cutA = /handover\/commit/;
  await jpost(A.url + '/api/desktop/link', { act: 'switch' });
  const fail = await until(async () => { const s = await jget(A.url + '/api/desktop/link'); return s.switching?.done && s; }, 30000);
  assert.equal(fail.switching.ok, false);
  assert.equal(fail.role, 'remote', 'A stays a remote control');
  await until(async () => !B.link.handing());
  assert.equal((await jget(B.url + '/api/desktop/link')).role, 'host', 'B carries on as host');
  assert.equal((await jpost(B.url + '/api/messages', { conv: botA, text: '還在 B 上工作' })).status, 200);
  assert.ok((await jget(A.url + '/api/messages?conv=' + botA)).msgs.some(m => m.text === '還在 B 上工作'), 'A still works through B');
  assert.ok(!('switching' in A.link.link()));
  cutA = null;
});
