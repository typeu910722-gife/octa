// 4.14.1 「每次更新手機都要重連」: /go is the phone's permanent page and shows the app inside itself.
// - go-core's shell: the computer stops answering → cover (電腦正在更新／重新啟動) → the new address from the relay → the
//   frame gets the new address with the phone's token, no tap
// - postMessage both ways only between the exact origins (/go ↔ the address the frame shows)
// - the host announces 「正在重新啟動」 before it quits or installs an update, and publishes its new address right away
// - phone sessions survive a restart that runs the schema migrations (an update)
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { pure, scripts } from './app-source.mjs';
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
      const list = topics.get(parts[0]) || []; list.push({ event: 'message', id: String(list.length), time: Math.floor(Date.now() / 1000), message: String(init.body), at: Date.now() });
      topics.set(parts[0], list);
      return new Response('{}', { status: 200 });
    }
    if (parts[1] === 'json' && u.searchParams.get('poll') === '1') return new Response((topics.get(parts[0]) || []).map(m => JSON.stringify(m)).join('\n') + '\n', { status: 200 });
    return new Response('not found', { status: 404 });
  };
  return { topics, handle, setDown: v => (down = v) };
}
// a manual clock for the shell's timers: run the pending one by hand
function manual() {
  const q = [];
  return {
    q, schedule: (fn, ms) => { const e = { fn, ms }; q.push(e); return () => { e.dead = true; }; },
    async next() { const e = q.filter(x => !x.dead).pop(); assert.ok(e, 'a timer is waiting'); e.dead = true; await e.fn(); return e.ms; }
  };
}

test('/go shell: computer updates → cover says so → new address from the relay → the frame gets it with the token, no tap', async () => {
  const secret = HL.newSecret(), ntfy = fakeNtfy(), relay = 'https://ntfy.test';
  const k = HL.phoneKeyOf(secret), tp = HL.topicOf(secret), tok = 'T'.repeat(40);
  const alive = new Map([['https://old.trycloudflare.com', 'H1']]);
  const fetch = async (url, init) => {
    if (url.startsWith(relay)) return ntfy.handle(url, init);
    const id = alive.get(new URL(url).origin);
    if (!id) return new Response('<h1>Error 1033</h1>', { status: 530 });   // what Cloudflare answers for a dead tunnel
    return new Response('ok', { status: 200, headers: { 'x-octa-host': id, 'x-octa-phone': 'on', 'x-octa-shell': '1' } });
  };
  const host = { tp, k, h: 'H1', n: '店裡電腦', t: tok, u: 'https://old.trycloudflare.com' };
  const shown = [], saved = [], clock = manual();
  let t = 1_000_000;
  const sh = GO.createShell({ host, save: h => saved.push({ ...h }), show: s => shown.push(s), go: 'https://octa.yzprojecttw.com/go', web: 'bot7', fetch, relay, schedule: clock.schedule, now: () => t });
  assert.equal(await GO.shellOk('https://old.trycloudflare.com', { fetch }), true, 'this host can be shown inside /go');

  sh.enter('https://old.trycloudflare.com');
  let s = shown.at(-1);
  assert.equal(s.mode, 'app');
  const f1 = new URL(s.src);
  assert.equal(f1.origin, 'https://old.trycloudflare.com');
  assert.deepEqual(pure.octaFrag(f1.hash), { t: tok, web: 'bot7', go: 'https://octa.yzprojecttw.com/go', sh: 1 }, 'the token and /go travel in the fragment; inside /go');
  sh.message({ octa: 1, type: 'ready' });
  assert.equal(sh.state().ready, true);
  assert.equal(await clock.next(), GO.WATCH_MS, 'watching every 15 s while the app shows');
  assert.equal(shown.length, 1, 'still answering: nothing changes');

  // the host says it is about to install an update, then its address dies
  await HL.publishHost({ secret, key: k, url: 'https://old.trycloudflare.com', epoch: 0, hostId: 'H1', hostName: '店裡電腦', restarting: 'update', fetch: ntfy.handle, relay, now: t });
  assert.equal((await HL.pollHost({ secret, fetch: ntfy.handle, relay })), null, 'computers ignore the phones\' copy (and 「restarting」 itself)');
  alive.delete('https://old.trycloudflare.com');
  t += 1000;
  await clock.next();   // the watch: two misses → waiting; the first look says why
  s = shown.at(-1);
  assert.equal(s.mode, 'wait'); assert.equal(s.why, 'update', 'the cover says the computer is updating');
  assert.equal(await clock.next(), GO.FAST_MS, 'looking again every 2.5 s at first');
  assert.equal(shown.at(-1).why, 'update');

  // OCTA is back with a new address: the next look puts it in the frame, with the token, by itself
  t += 20000;
  await HL.publishHost({ secret, key: k, url: 'https://new.trycloudflare.com', epoch: 0, hostId: 'H1', hostName: '店裡電腦', fetch: ntfy.handle, relay, now: t });
  alive.set('https://new.trycloudflare.com', 'H1');
  await clock.next();
  s = shown.at(-1);
  assert.equal(s.mode, 'app'); assert.equal(s.reload, true);
  const f2 = new URL(s.src);
  assert.equal(f2.origin, 'https://new.trycloudflare.com');
  assert.deepEqual(pure.octaFrag(f2.hash), { t: tok, go: 'https://octa.yzprojecttw.com/go', sh: 1 }, 'the notice\'s bot opened once, not again after the restart');
  assert.notEqual(f1.searchParams.get('n'), f2.searchParams.get('n'), 'a new load every time');
  assert.equal(saved.at(-1).u, 'https://new.trycloudflare.com', 'the new address is remembered');
  assert.equal(sh.state().ready, false);
  sh.message({ octa: 1, type: 'ready' });
  assert.equal(clock.q.filter(x => !x.dead).at(-1).ms, GO.WATCH_MS, 'watching again');
  sh.stop();
});

test('/go shell: unknown outage → 「電腦重新啟動中」, then 主機沒開 after 2 minutes, slower after 5; a hiccup resumes without a reload; OCTA closed', async () => {
  const secret = HL.newSecret(), ntfy = fakeNtfy(), relay = 'https://ntfy.test';
  const k = HL.phoneKeyOf(secret), tp = HL.topicOf(secret);
  const alive = new Set();
  const fetch = async (url, init) => {
    if (url.startsWith(relay)) return ntfy.handle(url, init);
    if (!alive.has(new URL(url).origin)) throw new TypeError('fetch failed');
    return new Response('ok', { headers: { 'x-octa-host': 'H1', 'x-octa-phone': 'on' } });
  };
  const host = { tp, k, h: 'H1', t: 'T'.repeat(40) }, shown = [], clock = manual();
  let t = 5_000_000;
  const sh = GO.createShell({ host, show: s => shown.push(s), go: 'https://octa.yzprojecttw.com/go', fetch, relay, schedule: clock.schedule, now: () => t });
  alive.add('https://a.trycloudflare.com');
  sh.enter('https://a.trycloudflare.com');
  sh.message({ octa: 1, type: 'ready' });
  alive.delete('https://a.trycloudflare.com');
  // the app itself noticed first (its long-poll failed): checked at once
  sh.message({ octa: 1, type: 'down' });
  await new Promise(r => setTimeout(r, 10));
  assert.equal(shown.at(-1).why, 'lost');
  t += 3 * 60000; await clock.next();
  assert.equal(shown.at(-1).why, 'down', 'no news for minutes: 主機電腦沒開或沒連上網路');
  t += 3 * 60000;
  await clock.next();
  assert.equal(clock.q.filter(x => !x.dead).at(-1).ms, GO.SLOW_MS, 'after 5 minutes: every 10 s');
  // the phone's own network blinked: the same address answers again — no reload (the app is still there)
  alive.add('https://a.trycloudflare.com');
  const n = shown.length;
  await clock.next();
  assert.equal(shown.at(-1).mode, 'app'); assert.equal(shown.at(-1).reload, false); assert.ok(shown.length > n);
  // OCTA closed on the computer (結束): says so; a 「closing」 left long ago is not believed
  await HL.publishHost({ secret, key: k, url: 'https://a.trycloudflare.com', epoch: 0, hostId: 'H1', restarting: 'quit', fetch: ntfy.handle, relay, now: t });
  alive.delete('https://a.trycloudflare.com');
  await sh.check();
  assert.equal(shown.at(-1).why, 'quit');
  t += GO.RESTART_FRESH + 1000;
  await clock.next();
  assert.notEqual(shown.at(-1).why, 'quit');
  // opening /go while the computer is updating: the same wait, from the start (locate says why)
  await HL.publishHost({ secret, key: k, url: 'https://a.trycloudflare.com', epoch: 0, hostId: 'H1', restarting: 'update', fetch: ntfy.handle, relay, now: t });
  await assert.rejects(GO.locate({ ...host, u: 'https://a.trycloudflare.com' }, { fetch, relay, now: t }), e => e.code === 'restarting' && e.why === 'update');
  sh.stop();
});

test('/go shell: this phone signed out on the computer → 需要重新配對 (token dropped); a code typed in the app signs it in again', async () => {
  const host = { tp: 'a'.repeat(32), k: 'k'.repeat(43), h: 'H1', t: 'T'.repeat(40) }, shown = [], saved = [], clock = manual();
  const fetch = async () => new Response('ok', { headers: { 'x-octa-host': 'H1' } });
  const sh = GO.createShell({ host, save: h => saved.push({ ...h }), show: s => shown.push(s), go: 'https://octa.yzprojecttw.com/go', fetch, relay: 'https://ntfy.test', schedule: clock.schedule });
  sh.enter('https://a.trycloudflare.com');
  sh.message({ octa: 1, type: 'unpaired' });
  assert.equal(shown.at(-1).why, 'unpaired');
  assert.equal(saved.at(-1).t, undefined, 'the old token is gone');
  assert.equal(clock.q.filter(x => !x.dead).length, 0, 'nothing to look for: it waits for the person');
  sh.message({ octa: 1, type: 'paired', t: 'short' });
  assert.equal(saved.at(-1).t, undefined, 'not a token');
  sh.message({ octa: 1, type: 'paired', t: 'N'.repeat(40) });
  assert.equal(saved.at(-1).t, 'N'.repeat(40));
  assert.equal(shown.at(-1).mode, 'app'); assert.equal(shown.at(-1).reload, false, 'the app is already signed in');
  sh.stop();
});

test('postMessage: /go hears only the address its frame shows; the app talks only to the OCTA site\'s /go', () => {
  const frameWin = {}, url = 'https://a-b.trycloudflare.com';
  const ok = { origin: url, source: frameWin, data: { octa: 1, type: 'ready' } };
  assert.deepEqual(GO.shellAccept(ok, url, frameWin), { octa: 1, type: 'ready' });
  assert.equal(GO.shellAccept({ ...ok, origin: 'https://evil.trycloudflare.com' }, url, frameWin), null, 'another address');
  assert.equal(GO.shellAccept({ ...ok, origin: 'https://a-b.trycloudflare.com.evil.example' }, url, frameWin), null);
  assert.equal(GO.shellAccept({ ...ok, source: {} }, url, frameWin), null, 'another window');
  assert.equal(GO.shellAccept({ ...ok, data: { type: 'ready' } }, url, frameWin), null, 'not ours');
  assert.equal(GO.shellAccept({ ...ok, data: 'ready' }, url, frameWin), null);
  assert.equal(GO.shellAccept(ok, '', frameWin), null, 'no frame yet');
  // the app: /go's origin only from the go link it was given (the OCTA site, or this computer in tests)
  assert.equal(pure.shellOrigin('https://octa.yzprojecttw.com/go'), 'https://octa.yzprojecttw.com');
  assert.equal(pure.shellOrigin('http://127.0.0.1:8080/go'), 'http://127.0.0.1:8080');
  for (const bad of ['https://evil.example/go', 'https://octa.yzprojecttw.com.evil.example/go', 'https://octa.yzprojecttw.com/go/x', 'javascript:alert(1)', '']) assert.equal(pure.shellOrigin(bad), '', bad);
  assert.equal(pure.octaFrag('#sh=1').sh, undefined, 'inside /go only with a /go link');
  assert.equal(pure.octaFrag('#go=https://octa.yzprojecttw.com/go&sh=1').sh, 1);
  const api = scripts['api.js'];
  assert.match(api, /window\.parent\.postMessage\(\{octa:1,type,\.\.\.\(data\|\|\{\}\)\},SHELL_ORIGIN\)/, 'sends to /go\'s exact origin, never *');
  assert.doesNotMatch(api, /postMessage\([^)]*'\*'\)/);
  assert.match(api, /e\.origin!==SHELL_ORIGIN\|\|e\.source!==window\.parent/, 'hears only /go itself');
  assert.match(api, /const SHELL=.*window\.parent!==window/, 'inside a frame only');
  // the host lets only /go (and itself) frame the app; /go asks whether the host can be shown inside it
  const srv = readFileSync(join(repo, 'desktop/server.mjs'), 'utf8');
  assert.match(srv, /'content-security-policy': `frame-ancestors 'self' \$\{goOrigin\}`/);
  assert.match(srv, /'x-octa-shell': '1'/);
  // inside the frame: the app goes back to /go never by navigating (it tells /go), and asks for no notifications
  assert.match(api, /if\(SHELL\)return toShell\('down'\)/);
  assert.match(scripts['settings.js'], /const perm=SHELL\?'shell'/);
  // /go: the frame with what the app needs; the cover; messages checked
  const html = readFileSync(join(repo, 'site/go.html'), 'utf8');
  assert.match(html, /<iframe id="frame"[^>]*allow="camera; microphone; clipboard-read; clipboard-write/);
  assert.match(html, /shellAccept\(e, shell\.state\(\)\.url, frame\.contentWindow\)/);
  assert.match(html, /電腦重新啟動中，馬上回來…/);
  assert.match(html, /電腦正在更新 OCTA，馬上回來…/);
  assert.match(html, /這台手機需要重新配對/);
  assert.match(html, /location\.replace\(url\);   \/\/ an OCTA from before 4\.14\.1/, 'older hosts still open directly');
});

test('the phone\'s look and what it has read come along to the next address (only those keys, never the token)', () => {
  const p = GO.encodePrefs({ octa_theme: 'dark', octa_lang: 'ja', octa_seen_v: '4.14.1', ebot_token: 'SECRET', octa_go: 'https://evil.example/go', octa_draft_x: 'x'.repeat(10) });
  const back = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  assert.deepEqual(back, { octa_lang: 'ja', octa_theme: 'dark', octa_seen_v: '4.14.1' });
  assert.equal(GO.encodePrefs({ octa_seen: 'x'.repeat(5000) }), '', 'nothing too big');
  const src = GO.appUrl('https://a.trycloudflare.com', { t: 'T'.repeat(40), go: 'https://octa.yzprojecttw.com/go', sh: 1, p: { octa_theme: 'sea' } });
  assert.equal(new URLSearchParams(new URL(src).hash.slice(1)).get('p'), GO.encodePrefs({ octa_theme: 'sea' }), 'in the fragment: never sent to a server');
  assert.equal(new URLSearchParams(new URL(GO.appUrl('https://a.trycloudflare.com', { t: 'T'.repeat(40), p: { octa_theme: 'sea' } })).hash.slice(1)).get('p'), null, 'only inside /go');
  // the same keys in the app (what it sends) and in index.html (what it restores, before the first paint)
  const keep = JSON.parse(scripts['api.js'].match(/const SHELL_KEEP=(\[[^\]]+\]);/)[1]);
  assert.deepEqual(keep, GO.PREF_KEYS);
  const html = readFileSync(join(repo, 'app/index.html'), 'utf8');
  assert.equal(html.match(/K=\/\^\(([^)]+)\)\$\//)[1], GO.PREF_KEYS.join('|'));
  assert.ok(!GO.PREF_KEYS.some(k => /token|_go$|_dev$/.test(k)));
  assert.match(html, /localStorage\.getItem\(k\)===null\)localStorage\.setItem/, 'what this address already has wins');
});

test('direct mode (bookmarks, desktop browsers): the app goes back to /go as soon as its address is gone', () => {
  const api = scripts['api.js'];
  assert.match(api, /if\(Date\.now\(\)-last<15000\)return false;/, 'not once a minute any more: a short guard against loops');
  assert.match(api, /catch\(e\)\{fails\+\+;if\(TOKEN&&!\(await hostAlive\(\)\)&&!\(await hostAlive\(\)\)&&backToGo\(\)/, 'the first failed long-poll checks the address');
  assert.match(api, /r\.ok&&r\.headers\.has\('x-octa-host'\)/, 'Cloudflare\'s error page is not the computer');
});

test('the host says 「正在更新」 before it quits or installs an update (main.mjs)', () => {
  const src = readFileSync(join(repo, 'desktop/main.mjs'), 'utf8');
  assert.match(src, /await announceRestart\('update'\); await closeBrowsers\(\); freeInstallDir\(\); reopenAfterUpdate\(\); autoUpdater\.quitAndInstall/);
  assert.match(src, /if \(!announced && server\?\.announceRestart\) \{ e\.preventDefault\(\); announceRestart\('quit'\)\.finally\(\(\) => app\.quit\(\)\); return; \}/);
  assert.match(src, /quitting = true; await announceRestart\('quit'\); await closeBrowsers\(\)/);
  assert.match(src, /setTimeout\(r, 2500\)/, 'quitting waits at most 2.5 s');
});

// ---------- the host across an update ----------
async function relayServer() {
  const ntfy = fakeNtfy();
  const srv = http.createServer(async (req, res) => {
    const c = []; for await (const x of req) c.push(x);
    try { const r = await ntfy.handle('http://relay' + req.url, { method: req.method, body: Buffer.concat(c).toString() }); res.writeHead(r.status, { 'access-control-allow-origin': '*' }); res.end(await r.text()); }
    catch { res.destroy(); }
  });
  await new Promise(ok => srv.listen(0, '127.0.0.1', ok));
  return { ntfy, url: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() };
}
const until = async (f, ms = 15000) => { const t0 = Date.now(); for (; ;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timed out'); await new Promise(r => setTimeout(r, 25)); } };

test('an update: 「正在更新」 published, sessions survive the restart and its migrations, the new address is out at once, /go swaps it in', { skip: !hasDeps && 'desktop packages not installed', timeout: 120000 }, async t => {
  const { startServer } = await import(pathToFileURL(join(repo, 'desktop/server.mjs')).href);
  const relay = await relayServer();
  const dataDir = mkdtempSync(join(tmpdir(), 'octa-shell-'));
  const goUrl = 'http://127.0.0.1:9/go';
  let n = 0;
  // the "tunnel" is the remote port itself, at a new address (host name) every start, like a quick tunnel
  const start = () => startServer({ dataDir, runner: false, relay: relay.url, watchMs: 60000, goUrl, tunnel: async port => `http://localhost:${port}`.replace('localhost', ++n % 2 ? 'localhost' : '127.0.0.1') });
  let s = await start();
  t.after(async () => { await s?.close(); relay.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const jpost = (url, body, headers = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body || {}) });
  const on = await (await jpost(s.url + '/api/desktop/remote', { on: true })).json();
  const qr = GO.parseFragment(new URL(on.go).hash).host;
  const token = (await (await jpost(on.url + '/api/pair', { code: qr.c })).json()).token;
  assert.ok(token);
  const phone = { ...qr, t: token };
  await until(() => GO.readRelay(phone, { relay: relay.url }).then(m => m?.url === on.url, () => false));
  // the app on the remote port: only /go may frame it; the ping says it can be shown inside /go
  const page = await fetch(on.url + '/');
  assert.equal(page.headers.get('content-security-policy'), "frame-ancestors 'self' http://127.0.0.1:9");
  assert.equal(await GO.shellOk(on.url), true);

  // the update: announce, quit (no announce when nothing to tell: still fine)
  const said = await s.announceRestart('update');
  assert.deepEqual(said, { phones: true, computers: false });
  const m = await GO.readRelay(phone, { relay: relay.url });
  assert.equal(m.restarting, 'update'); assert.equal(m.url, on.url);
  await s.close(); await new Promise(r => setTimeout(r, 200));
  await assert.rejects(GO.locate({ ...phone, u: on.url }, { relay: relay.url }), e => e.code === 'restarting' && e.why === 'update', '/go knows to wait');

  // as if the data were from the version before (4.13: no Grok Bot tables yet): the schema and migrations run at start
  {
    const initSqlJs = createRequire(join(repo, 'desktop', 'package.json'))('sql.js');
    const SQL = await initSqlJs();
    const db = new SQL.Database(readFileSync(join(dataDir, 'ebot.sqlite')));
    db.exec('DROP TABLE grokcloud; DROP TABLE gc_runs');
    writeFileSync(join(dataDir, 'ebot.sqlite'), Buffer.from(db.export()));
    db.close();
  }
  const t0 = Date.now();
  s = await start();
  const back = await until(async () => { const x = await GO.readRelay(phone, { relay: relay.url }).catch(() => null); return x && !x.restarting && x.url !== on.url && x; });
  const ms = Date.now() - t0;
  console.log(`# start → new address on the relay: ${ms} ms`);
  assert.ok(ms < 5000, 'published right after the tunnel is up');
  assert.equal((await fetch(back.url + '/api/state', { headers: { authorization: 'Bearer ' + token } })).status, 200, 'the phone is still signed in');
  assert.ok((await s.db.prepare('SELECT bot_id, test FROM grokcloud LIMIT 0').all()), 'the new tables are there');
  assert.equal((await s.db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE kind='web'").first()).n, 1, 'the phone\'s session is still there');
  // /go's shell, waiting since the update, puts the new address in by itself
  const shown = [], clock = manual();
  const sh = GO.createShell({ host: { ...phone }, show: x => shown.push(x), go: goUrl, relay: relay.url, schedule: clock.schedule });
  await sh.find(on.url, 'update');
  assert.equal(shown.at(-1).mode, 'app');
  assert.equal(new URL(shown.at(-1).src).origin, back.url);
  assert.equal(pure.octaFrag(new URL(shown.at(-1).src).hash).t, token);
  sh.stop();
  // no update ever drops phone sessions
  for (const f of ['desktop/server.mjs', 'desktop/api/db.mjs']) assert.doesNotMatch(readFileSync(join(repo, f), 'utf8').match(/MIGRATIONS = \[[\s\S]*?\];/)[0], /sessions\b(?!\s+ADD|\()|DROP TABLE|DELETE FROM/i, f);
});
