// 4.4 手機遠端 stays on and the phone's stable entry (site/go.html + site/go-core.js on the OCTA site):
// - the browser code reads exactly what the host seals (desktop/host-link.mjs), run here under Node's WebCrypto
// - phones get only a key derived from the link secret: they read their copy, not the computers' messages
// - the fragment the host's QR / the app hands to /go, and the one /go hands to the app (app/js/pure.js)
// - the host server keeps the phone remote on across restarts (desktop.json phoneRemote), publishes its address for
//   the phones, phone tokens survive the restart, and 移除 signs a phone out
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { pure } from './app-source.mjs';
const repo = join(import.meta.dirname, '..');
const HL = await import(pathToFileURL(join(repo, 'desktop/host-link.mjs')).href);
const GO = await import(pathToFileURL(join(repo, 'site/go-core.js')).href);
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
      res.writeHead(r.status, { 'access-control-allow-origin': '*' }); res.end(await r.text());
    } catch { res.destroy(); }
  });
  await new Promise(ok => srv.listen(0, '127.0.0.1', ok));
  return { ntfy, url: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() };
}

test('the /go page opens what the host seals (Node crypto ↔ WebCrypto), both ways', async () => {
  const secret = HL.newSecret();
  const msg = { v: 1, url: 'https://a-b-c.trycloudflare.com', epoch: 2, hostId: 'H1', hostName: '店裡電腦', ts: Date.now() };
  assert.deepEqual(await GO.unseal(HL.seal(msg, secret), secret), msg, 'Node → browser');
  assert.deepEqual(HL.unseal(await GO.seal(msg, secret), secret), msg, 'browser → Node');
  assert.equal(await GO.unseal(HL.seal(msg, secret), HL.newSecret()), null, 'another secret opens nothing');
  const box = HL.seal(msg, secret);
  assert.equal(await GO.unseal(box.slice(0, -4) + 'AAAA', secret), null, 'a changed message is refused');
  assert.equal(await GO.unseal('x' + box, secret), null);
  assert.equal(await GO.unseal('o1.AAAA', secret), null);
  // base64url helpers agree with Node's
  const bytes = new Uint8Array([0, 251, 255, 62, 63, 1, 2]);
  assert.equal(GO.b64uEncode(bytes), Buffer.from(bytes).toString('base64url'));
  assert.deepEqual([...GO.b64uDecode(Buffer.from(bytes).toString('base64url'))], [...bytes]);
});

test('phones read their own copy on the same topic, never the computers\' messages', async () => {
  const secret = HL.newSecret(), ntfy = fakeNtfy(), relay = 'https://ntfy.test';
  const k = HL.phoneKeyOf(secret), tp = HL.topicOf(secret);
  assert.match(k, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(k, secret);
  await HL.publishHost({ secret, url: 'https://pcs-only.trycloudflare.com', epoch: 0, hostId: 'H1', fetch: ntfy.handle, relay });
  await HL.publishHost({ secret, key: k, url: 'https://for-phones.trycloudflare.com', epoch: 0, hostId: 'H1', hostName: 'A', fetch: ntfy.handle, relay });
  assert.equal(ntfy.topics.size, 1, 'one topic per host group');
  const phone = { tp, k, h: 'H1' };
  const m = await GO.readRelay(phone, { fetch: ntfy.handle, relay });
  assert.equal(m.url, 'https://for-phones.trycloudflare.com');
  assert.equal((await HL.pollHost({ secret, fetch: ntfy.handle, relay })).url, 'https://pcs-only.trycloudflare.com', 'computers ignore the phones\' copy');
  assert.equal(await GO.readRelay({ ...phone, h: 'OTHER' }, { fetch: ntfy.handle, relay }), null, 'another host id is ignored');
  // the newest from the highest epoch wins; a clock far in the future does not
  await HL.publishHost({ secret, key: k, url: 'https://newer.trycloudflare.com', epoch: 0, hostId: 'H1', fetch: ntfy.handle, relay, now: Date.now() + 1000 });
  await HL.publishHost({ secret, key: k, url: 'https://future.trycloudflare.com', epoch: 0, hostId: 'H1', fetch: ntfy.handle, relay, now: Date.now() + 3600000 });
  assert.equal((await GO.readRelay(phone, { fetch: ntfy.handle, relay })).url, 'https://newer.trycloudflare.com');
  ntfy.setDown(true);
  await assert.rejects(GO.readRelay(phone, { fetch: ntfy.handle, relay }), e => e.code === 'relay-down');
});

test('finding the host from /go: relay address → ping (right host, phone remote on) → else the last address', async () => {
  const secret = HL.newSecret(), ntfy = fakeNtfy(), relay = 'https://ntfy.test';
  const host = { tp: HL.topicOf(secret), k: HL.phoneKeyOf(secret), h: 'H1', u: 'https://old.trycloudflare.com' };
  const alive = new Map();   // url → [hostId, phone on?]
  const fetch = async (url, init) => {
    if (url.startsWith(relay)) return ntfy.handle(url, init);
    const u = new URL(url), a = alive.get(u.origin);
    if (!a) throw new TypeError('fetch failed');
    return new Response('ok', { status: 200, headers: { 'x-octa-host': a[0], 'x-octa-phone': a[1] ? 'on' : 'off' } });
  };
  await assert.rejects(GO.locate(host, { fetch, relay }), e => e.code === 'down', 'nothing published, old address dead');
  alive.set('https://old.trycloudflare.com', ['H1', true]);
  assert.deepEqual(await GO.locate(host, { fetch, relay }), { url: 'https://old.trycloudflare.com', via: 'last' });
  await HL.publishHost({ secret, key: host.k, url: 'https://new.trycloudflare.com', epoch: 0, hostId: 'H1', hostName: '店裡電腦', fetch: ntfy.handle, relay });
  alive.set('https://new.trycloudflare.com', ['H1', true]);
  assert.deepEqual(await GO.locate(host, { fetch, relay }), { url: 'https://new.trycloudflare.com', via: 'relay', name: '店裡電腦' });
  alive.set('https://new.trycloudflare.com', ['SOMEONE-ELSE', true]);
  alive.delete('https://old.trycloudflare.com');
  await assert.rejects(GO.locate(host, { fetch, relay }), e => e.code === 'down', 'a different computer at that address is not ours');
  alive.set('https://new.trycloudflare.com', ['H1', false]);
  await assert.rejects(GO.locate(host, { fetch, relay }), e => e.code === 'off', 'OCTA is there but the phone remote is off');
  ntfy.setDown(true);
  await assert.rejects(GO.locate(host, { fetch, relay }), e => e.code === 'relay-down');
  alive.set('https://old.trycloudflare.com', ['H1', true]);
  assert.equal((await GO.locate(host, { fetch, relay })).via, 'last', 'ntfy.sh down: the last address still works');
});

test('fragments: from the host\'s QR or the app to /go, and from /go to the app', () => {
  const k = HL.phoneKeyOf(HL.newSecret()), tp = HL.topicOf(HL.newSecret());
  const qr = GO.buildFragment({ tp, k, h: 'abcDEF123', n: '店裡 電腦&1', u: 'https://x-y.trycloudflare.com/', c: 'ab2c-d3ef' });
  const f = GO.parseFragment(qr);
  assert.deepEqual(f.host, { tp, k, h: 'abcDEF123', n: '店裡 電腦&1', u: 'https://x-y.trycloudflare.com', c: 'AB2CD3EF' });
  assert.deepEqual(GO.parseFragment('#web=bot_1').web, 'bot_1');
  assert.equal(GO.parseFragment('#web=bot_1').host, undefined, 'a notice link carries no credentials');
  assert.equal(GO.parseFragment(`#tp=${tp}&k=${k}&h=H1&u=http://evil.example`).host.u, undefined, 'plain http only for this computer itself');
  assert.equal(GO.parseFragment(`#tp=NOT_A_TOPIC&k=${k}&h=H1`).host, undefined);
  const tok = 'a'.repeat(48);
  assert.equal(GO.parseFragment(GO.buildFragment({ tp, k, h: 'H1', t: tok, c: 'ABCD2345' })).host.t, tok);
  assert.equal(GO.parseFragment(GO.buildFragment({ tp, k, h: 'H1', t: tok, c: 'ABCD2345' })).host.c, undefined, 'a token means no pairing');
  // what the phone keeps: the same host keeps its last address; another host replaces it; scanning again pairs afresh
  const a = GO.mergeHost(null, { tp, k, h: 'H1', c: 'ABCD2345' });
  const b = GO.mergeHost({ ...a, t: tok, u: 'https://last.trycloudflare.com' }, { tp, k, h: 'H1', c: 'ZZZZ2345' });
  assert.equal(b.c, 'ZZZZ2345'); assert.equal(b.t, undefined); assert.equal(b.u, 'https://last.trycloudflare.com');
  const c = GO.mergeHost(b, { tp, k, h: 'H2', t: tok });
  assert.equal(c.u, undefined); assert.equal(c.t, tok); assert.equal(c.h, 'H2');
  const mem = new Map(), storage = { getItem: x => mem.get(x) ?? null, setItem: (x, v) => mem.set(x, v) };
  assert.equal(GO.loadHost(storage), null);
  GO.saveHost(storage, c); assert.deepEqual(GO.loadHost(storage), c);
  // /go → the app on the computer's address: token, bot, and where /go is, all in the fragment
  const app = GO.appUrl('https://x-y.trycloudflare.com/', { t: tok, web: 'bot1', go: 'https://octa.yzprojecttw.com/go' });
  assert.ok(app.startsWith('https://x-y.trycloudflare.com/#'));
  assert.ok(!new URL(app).search, 'nothing in the query: the fragment never reaches a server');
  assert.deepEqual(pure.octaFrag(new URL(app).hash), { t: tok, web: 'bot1', go: 'https://octa.yzprojecttw.com/go' });
  assert.deepEqual(pure.octaFrag('#web=bot1'), { web: 'bot1' }, 'the old notice links still open the bot');
  assert.deepEqual(pure.octaFrag('#t=short&go=https://evil.example/go'), {}, 'no short token, no other site to return to');
  assert.deepEqual(pure.octaFrag('#go=http://127.0.0.1:8080/go').go, 'http://127.0.0.1:8080/go');
  // the app on a phone builds the /go link from /api/phone/go and its own token; /go reads it back
  const link = pure.goLink('https://octa.yzprojecttw.com/go', { tp, k, h: 'H1', n: 'A' }, tok, 'https://x-y.trycloudflare.com');
  assert.deepEqual(GO.parseFragment(new URL(link).hash).host, { tp, k, h: 'H1', n: 'A', u: 'https://x-y.trycloudflare.com', t: tok });
});

test('the /go page itself: a module from the site, no server calls of its own, follows light/dark, add-to-home-screen manifest', () => {
  const html = readFileSync(join(repo, 'site/go.html'), 'utf8');
  assert.match(html, /<script type="module">\s*import \{[^}]+\} from '\/go-core\.js'/);
  assert.match(html, /prefers-color-scheme:dark/);
  assert.match(html, /history\.replaceState\(null, '', location\.pathname \+ location\.search\)/, 'the fragment leaves the address bar');
  assert.match(html, /主機電腦沒開或沒連上網路，開機後會自動連上/);
  assert.match(html, /left = 10/, 'tries again every 10 seconds');
  assert.match(html, /<link rel="manifest" href="\/go\.webmanifest">/);
  assert.match(html, /name="referrer" content="no-referrer"/);
  const man = JSON.parse(readFileSync(join(repo, 'site/go.webmanifest'), 'utf8'));
  assert.equal(man.start_url, '/go');
  // opens in the browser itself (iOS gives home-screen web apps their own empty storage)
  assert.equal(man.display, 'browser');
  const core = readFileSync(join(repo, 'site/go-core.js'), 'utf8');
  assert.doesNotMatch(core, /yzprojecttw/, 'only ntfy.sh and the host computer are called');
});

// ---------- the host server across restarts ----------
const jpost = (url, body, headers = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body || {}) });
const until = async (f, ms = 15000) => { const t0 = Date.now(); for (; ;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timed out'); await new Promise(r => setTimeout(r, 100)); } };

test('phone remote stays on across restarts; phone tokens survive; 移除 signs a phone out', { skip: (!hasDeps && 'desktop packages not installed') || (process.platform === 'win32' && 'fake cloudflared is a shell script'), timeout: 120000 }, async t => {
  const { startServer } = await import(pathToFileURL(join(repo, 'desktop/server.mjs')).href);
  const relay = await relayServer();
  const dataDir = mkdtempSync(join(tmpdir(), 'octa-go-'));
  // a fake cloudflared: a new address every start, like the real quick tunnel
  mkdirSync(join(dataDir, 'bin'), { recursive: true });
  const cf = join(dataDir, 'bin', 'cloudflared');
  writeFileSync(cf, '#!/bin/sh\nn=$(cat "$0.n" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$0.n"\necho "https://run-$n.trycloudflare.com" 1>&2\nexec sleep 600\n'); chmodSync(cf, 0o755);
  const goUrl = 'http://127.0.0.1:9/go', goOrigin = 'http://127.0.0.1:9';
  const start = () => startServer({ dataDir, runner: false, relay: relay.url, watchMs: 300, goUrl });
  let s = await start();
  t.after(async () => { await s?.close(); relay.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const status = async () => (await (await fetch(s.url + '/api/desktop/status')).json()).remote;
  // (a pause after closing: kept-alive connections to the old server are gone before the new one is asked)
  const restart = async () => { await s.close(); await new Promise(r => setTimeout(r, 250)); s = await start(); };
  const cfg = () => JSON.parse(readFileSync(join(dataDir, 'desktop.json'), 'utf8'));
  const auth = tok => ({ headers: { authorization: 'Bearer ' + tok } });

  assert.equal((await status()).on, false, 'never turned on: stays off');
  const on = await (await jpost(s.url + '/api/desktop/remote', { on: true })).json();
  assert.equal(on.url, 'https://run-1.trycloudflare.com');
  assert.equal(cfg().phoneRemote, true, 'the choice is remembered');
  // the QR: /go with what the phone needs in the fragment (nothing in the query)
  assert.ok(on.go.startsWith(goUrl + '#'));
  assert.match(on.goQr, /^data:image\/png;base64,/);
  const qr = GO.parseFragment(new URL(on.go).hash).host;
  assert.equal(qr.c, on.code); assert.equal(qr.u, on.url); assert.equal(qr.h, cfg().link.id);
  assert.equal(qr.k, HL.phoneKeyOf(cfg().link.secret), 'the link secret was made for the first phone');
  assert.ok(!on.go.includes(cfg().link.secret), 'the phones never get the computers\' secret');
  // the host published its address for the phones
  const m1 = await until(() => GO.readRelay(qr, { relay: relay.url }).catch(() => null));
  assert.equal(m1.url, 'https://run-1.trycloudflare.com');
  // /go pairs across sites: preflight and answer carry CORS for the OCTA site only
  const pre = await fetch(s.remoteUrl + '/api/pair', { method: 'OPTIONS', headers: { origin: goOrigin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } });
  assert.equal(pre.status, 204); assert.equal(pre.headers.get('access-control-allow-origin'), goOrigin);
  const pr = await jpost(s.remoteUrl + '/api/pair', { code: qr.c }, { origin: goOrigin, 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' });
  assert.equal(pr.headers.get('access-control-allow-origin'), goOrigin);
  const token = (await pr.json()).token;
  assert.equal((await jpost(s.remoteUrl + '/api/pair', { code: 'WRONG234' }, { origin: 'https://evil.example' })).headers.get('access-control-allow-origin'), null, 'other sites get no CORS');
  const ping = await fetch(s.remoteUrl + '/__octa_ping');
  assert.equal(ping.headers.get('x-octa-host'), qr.h); assert.equal(ping.headers.get('x-octa-phone'), 'on'); assert.equal(ping.headers.get('access-control-allow-origin'), '*');
  // what the app on the phone asks for its /go link
  const g = await (await fetch(s.remoteUrl + '/api/phone/go', auth(token))).json();
  assert.deepEqual([g.tp, g.k, g.h, g.go], [qr.tp, qr.k, qr.h, goUrl]);
  assert.equal((await fetch(s.url + '/api/phone/go')).status, 404, 'only a paired phone needs it');
  let phones = (await (await fetch(s.url + '/api/desktop/phones')).json()).phones;
  assert.equal(phones.length, 1); assert.equal(phones[0].name, 'iPhone');

  // restart: phone remote back on by itself, new address, published again, the phone's token still works
  await restart();
  const r2 = await until(async () => { const r = await status(); return r.on && r; });
  assert.equal(r2.url, 'https://run-2.trycloudflare.com');
  assert.notEqual(r2.code, on.code, 'a new pairing code for new phones');
  assert.equal((await until(async () => { const m = await GO.readRelay(qr, { relay: relay.url }).catch(() => null); return m?.url === r2.url && m; })).url, r2.url);
  assert.equal((await fetch(s.remoteUrl + '/api/state', auth(token))).status, 200, 'no pairing again');

  // from before 4.4 (no choice saved): on at start when a phone is still paired
  const c0 = cfg(); delete c0.phoneRemote;
  await s.close(); writeFileSync(join(dataDir, 'desktop.json'), JSON.stringify(c0)); await new Promise(r => setTimeout(r, 250));
  s = await start();
  await until(async () => (await status()).on);
  // turned off: every phone is cut off, and it stays off after a restart; on again, the phones need no pairing
  assert.equal((await (await jpost(s.url + '/api/desktop/remote', { on: false })).json()).on, false);
  assert.equal(cfg().phoneRemote, false);
  assert.equal((await fetch(s.remoteUrl + '/api/state', auth(token))).status, 503);
  assert.equal((await fetch(s.remoteUrl + '/__octa_ping')).headers.get('x-octa-phone'), 'off', '/go can tell it was turned off');
  await restart();
  await new Promise(r => setTimeout(r, 800));
  assert.equal((await status()).on, false, 'stays off');
  await jpost(s.url + '/api/desktop/remote', { on: true });
  assert.equal((await fetch(s.remoteUrl + '/api/state', auth(token))).status, 200);
  // 移除: signed out at once
  phones = (await (await fetch(s.url + '/api/desktop/phones')).json()).phones;
  const left = await (await jpost(s.url + '/api/desktop/phones', { remove: phones[0].id })).json();
  assert.equal(left.phones.length, 0);
  assert.equal((await fetch(s.remoteUrl + '/api/state', auth(token))).status, 401);
  assert.equal((await fetch(s.remoteUrl + '/api/desktop/phones')).status, 403, 'the list and 移除 stay on this computer');
});

test('notices link to /go, so they still work after the computer restarts', () => {
  const src = readFileSync(join(repo, 'desktop/api/runner-done.mjs'), 'utf8');
  assert.match(src, /\$\{link\}#web=\$\{encodeURIComponent\(job\.bot_id\)\}/);
  const srv = readFileSync(join(repo, 'desktop/server.mjs'), 'utf8');
  assert.match(srv, /remoteLink: \(\) => \(remote\.on && remote\.url \? goUrl : ''\)/);
});
