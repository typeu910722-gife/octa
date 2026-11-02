// 4.2 手機遙控: the phone watches a bot's browser live and, after 接手, taps / scrolls / types on it.
//  - where a touch lands on the page (letterboxing, frames from 2× screens, the person's own pinch-zoom)
//  - the stream: starts when somebody looks, follows the bot's tab, falls back to screenshots, stops when nobody looks
//  - who may use it on the phone's (remote) port: paired phones only, and only after 接手 for anything that touches the page
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { pure, html, js, css, fnSrc, read } from './app-source.mjs';

const repo = join(import.meta.dirname, '..');
const { createScreens, inputCommands, navUrl, livePage, jpegSize } = await import(pathToFileURL(join(repo, 'desktop/screen-cast.mjs')).href);
let hasDeps = true;
try { createRequire(join(repo, 'desktop', 'package.json')).resolve('sql.js'); } catch { hasDeps = false; }

test('a touch on the live picture lands on the right spot of the page', () => {
  const { scrMap } = pure;
  const meta = { deviceWidth: 1200, deviceHeight: 800 };
  // a 390-wide phone shows a 1200×800 page 0.325× (260 px tall) in the middle of a taller picture area: bands above and below
  const box = { left: 0, top: 100, width: 390, height: 600 };   // the picture runs from y=100+170 to 100+430
  assert.deepEqual(scrMap({ x: 195, y: 270 + 130 }, { box, img: { w: 1200, h: 800 }, meta }), { x: 600, y: 400, per: 1200 / 390 });
  assert.equal(scrMap({ x: 100, y: 100 + 100 }, { box, img: { w: 1200, h: 800 }, meta }), null, 'the band above');
  assert.equal(scrMap({ x: 100, y: 100 + 500 }, { box, img: { w: 1200, h: 800 }, meta }), null, 'the band below');
  // a drag that starts on a band still scrolls: clamp to the nearest edge
  assert.equal(scrMap({ x: 195, y: 100 + 500 }, { box, img: { w: 1200, h: 800 }, meta, clamp: true }).y, 800);
  // a wide box (phone turned sideways): bands left and right of the picture
  const wide = { left: 0, top: 0, width: 800, height: 300 };   // 1200×800 → 450×300, starts at x=175
  assert.equal(scrMap({ x: 100, y: 150 }, { box: wide, img: { w: 1200, h: 800 }, meta }), null);
  assert.deepEqual(scrMap({ x: 175 + 225, y: 150 }, { box: wide, img: { w: 1200, h: 800 }, meta }).x, 600);
  // frames from a 2× screen are twice as big; the metadata (DIP) decides, or dpr without metadata
  assert.deepEqual(scrMap({ x: 195, y: 400 }, { box, img: { w: 2400, h: 1600 }, meta }).x, 600);
  assert.deepEqual(scrMap({ x: 195, y: 400 }, { box, img: { w: 2400, h: 1600 }, dpr: 2 }).x, 600);
  // the person pinch-zoomed 2× around the top-left of the picture area: the same screen point is half as far in
  const z = scrMap({ x: 195, y: 100 + 470 }, { box, img: { w: 1200, h: 800 }, meta, view: { s: 2, x: 0, y: 0 } });
  assert.deepEqual([z.x, z.y], [300, 200]);
  assert.equal(z.per, 1200 / 390 / 2, 'dragging while zoomed scrolls less');
  // …and moved the picture left by 100 px
  assert.equal(scrMap({ x: 195, y: 100 + 470 }, { box, img: { w: 1200, h: 800 }, meta, view: { s: 2, x: -100, y: 0 } }).x, Math.round((300 + 100 / 2 / 0.325) * 10) / 10);
  // the page's own zoom (150 %): CSS pixels are bigger than DIP
  assert.equal(scrMap({ x: 195, y: 400 }, { box, img: { w: 1200, h: 800 }, meta, zoom: 1.5 }).x, 400);
  assert.equal(scrMap({ x: 1, y: 1 }, { box, img: { w: 0, h: 0 }, meta }), null, 'no frame yet');
});

test('phone messages become CDP input, anything else is refused', () => {
  const tap = inputCommands({ type: 'tap', x: 10, y: 20 });
  assert.deepEqual(tap.map(([, p]) => p.type), ['mouseMoved', 'mousePressed', 'mouseReleased']);
  assert.equal(tap[1][1].button, 'left');
  assert.deepEqual(inputCommands({ type: 'scroll', x: 5, y: 5, dx: 0, dy: 300 }), [['Input.dispatchMouseEvent', { type: 'mouseWheel', x: 5, y: 5, deltaX: 0, deltaY: 300, button: 'none', buttons: 0, modifiers: 0 }]]);
  assert.deepEqual(inputCommands({ type: 'text', text: '密碼 123' }), [['Input.insertText', { text: '密碼 123' }]]);
  const enter = inputCommands({ type: 'key', key: 'Enter' });
  assert.equal(enter[0][1].type, 'keyDown'); assert.equal(enter[0][1].text, '\r'); assert.equal(enter[1][1].type, 'keyUp');
  assert.equal(inputCommands({ type: 'key', key: 'Backspace' })[0][1].type, 'rawKeyDown');
  assert.equal(inputCommands({ type: 'key', key: 'Tab' })[0][1].windowsVirtualKeyCode, 9);
  for (const bad of [{ type: 'key', key: 'F12' }, { type: 'tap', x: 'a', y: 1 }, { type: 'text', text: '' }, { type: 'eval', code: 'x' }, null]) assert.equal(inputCommands(bad), null);
  assert.equal(navUrl('shopee.tw'), 'https://shopee.tw');
  assert.equal(navUrl('https://a.b/c?d'), 'https://a.b/c?d');
  assert.match(navUrl('台北 天氣'), /^https:\/\/www\.google\.com\/search\?q=/);
  // a screenshot's own size decides the mapping (SOF0 header of a 37×21 JPEG)
  assert.deepEqual(jpegSize(Buffer.from('ffd8ffc0001108001500250301220002110103110100', 'hex')), { w: 37, h: 21 });
  assert.equal(jpegSize(Buffer.from('shot')), null);
  assert.equal(livePage([{ targetId: 'a', type: 'page', url: 'https://x/' }, { targetId: 'b', type: 'page', url: 'about:blank' }]).targetId, 'a');
});

// a browser that answers like Chrome over CDP, and a clock the test moves by hand
function fakeBrowser({ paints = true } = {}) {
  let listener = null;
  const b = {
    sent: [], closed: false, targets: [{ targetId: 'T1', type: 'page', url: 'https://shop.example/', title: '商店' }], connects: 0,
    emit: (m, p, s) => listener?.(m, p, s),
    async connect() {
      b.connects++;
      return {
        async send(m, p = {}, sid) {
          b.sent.push([m, p, sid]);
          if (m === 'Target.getTargets') return { targetInfos: b.targets };
          if (m === 'Target.attachToTarget') return { sessionId: 'S-' + p.targetId };
          if (m === 'Page.startScreencast' && paints) queueMicrotask(() => b.emit('Page.screencastFrame', { data: Buffer.from('frame1').toString('base64'), sessionId: 7, metadata: { deviceWidth: 1200, deviceHeight: 800 } }, 'S-' + b.targets.at(-1).targetId));
          if (m === 'Page.getLayoutMetrics') return { cssVisualViewport: { clientWidth: 1000, clientHeight: 700, pageX: 0, pageY: 0 } };
          if (m === 'Page.captureScreenshot') return { data: Buffer.from('shot').toString('base64') };
          return {};
        },
        on(fn) { listener = fn; },
        close() { b.closed = true; }
      };
    }
  };
  return b;
}
function fakeClock() {
  let t = 1000, seq = 0;
  const jobs = new Map();
  const clock = {
    now: () => t,
    setTimeout: (f, ms) => { const id = ++seq; jobs.set(id, { f, at: t + ms }); return id; },
    clearTimeout: id => jobs.delete(id),
    setInterval: (f, ms) => { const id = ++seq; jobs.set(id, { f, at: t + ms, every: ms }); return id; },
    clearInterval: id => jobs.delete(id),
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        const next = [...jobs].filter(([, j]) => j.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [id, j] = next; t = j.at;
        if (j.every) j.at += j.every; else jobs.delete(id);
        j.f();
        for (let i = 0; i < 20; i++) await Promise.resolve();
      }
      t = end;
    }
  };
  return clock;
}
const tick = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

test('the stream starts when somebody looks, acknowledges frames and stops 30 s after the last look', async () => {
  const br = fakeBrowser(), clock = fakeClock();
  const ports = [];
  const sc = createScreens({ resolvePort: async bot => { ports.push(bot); return bot.id === 'b1' ? 9311 : 0; }, connect: () => br.connect(), now: clock.now, timers: clock });
  assert.equal(await sc.frame('nobody', { wait: 0 }), null, 'no browser open: nothing to show (and nothing is opened)');
  assert.equal(br.connects, 0);
  const f = await sc.frame('b1', { browser: '', w: 1170, h: 3000, wait: 50 });
  assert.equal(f.jpeg.toString(), 'frame1');
  assert.equal(f.meta.url, 'https://shop.example/');
  assert.equal(f.meta.mode, 'cast');
  const cast = br.sent.find(([m]) => m === 'Page.startScreencast');
  assert.deepEqual(cast[1], { format: 'jpeg', quality: 60, maxWidth: 1170, maxHeight: 2400, everyNthFrame: 1 }, 'sized for the phone (capped)');
  assert.ok(br.sent.some(([m, p]) => m === 'Page.screencastFrameAck' && p.sessionId === 7), 'every frame is acknowledged');
  assert.equal(sc.active('b1'), true);
  // the same frame again: the phone waits for a newer one and gets "same" when none comes
  const same = sc.frame('b1', { after: f.seq, w: 1170, h: 3000, wait: 500 });
  await tick();
  await clock.advance(600);
  const sm = await same; assert.equal(sm.same, true, JSON.stringify({ seq: sm.seq, f: f.seq, txt: sm.jpeg?.toString() }));
  // a new frame wakes a waiting phone at once
  const next = sc.frame('b1', { after: f.seq, w: 1170, h: 3000, wait: 5000 });
  await tick();
  br.emit('Page.screencastFrame', { data: Buffer.from('frame2').toString('base64'), sessionId: 8, metadata: {} }, 'S-T1');
  assert.equal((await next).jpeg.toString(), 'frame2');
  // the bot opened a new tab: the stream follows it
  br.targets.push({ targetId: 'T2', type: 'page', url: 'https://login.example/', title: '登入' });
  await clock.advance(2000);
  assert.ok(br.sent.some(([m, p]) => m === 'Target.attachToTarget' && p.targetId === 'T2'));
  assert.equal(sc.info('b1').url, 'https://login.example/');
  // nobody asks for frames for 30 s: the screencast stops and the connection closes
  await clock.advance(31000);
  assert.equal(sc.active('b1'), false);
  assert.ok(br.sent.some(([m]) => m === 'Page.stopScreencast'));
  assert.equal(br.closed, true);
  // leaving the tab (bye) stops it right away
  const br2 = fakeBrowser(), sc2 = createScreens({ resolvePort: async () => 9312, connect: () => br2.connect(), now: clock.now, timers: clock });
  await sc2.frame('b2', { wait: 10 });
  assert.equal(sc2.active('b2'), true);
  sc2.bye('b2');
  assert.equal(sc2.active('b2'), false);
  assert.equal(br2.closed, true);
});

test('a browser that paints no screencast frames gets screenshots instead', async () => {
  const br = fakeBrowser({ paints: false }), clock = fakeClock();
  const sc = createScreens({ resolvePort: async () => 9311, connect: () => br.connect(), now: clock.now, timers: clock });
  const first = sc.frame('b1', { wait: 3000 });
  await tick();
  await clock.advance(1600);
  const f = await first;
  assert.equal(f.jpeg.toString(), 'shot');
  assert.equal(f.meta.mode, 'shot');
  assert.equal(f.meta.deviceWidth, 1000);
  const n = br.sent.filter(([m]) => m === 'Page.captureScreenshot').length;
  await clock.advance(1700);
  assert.ok(br.sent.filter(([m]) => m === 'Page.captureScreenshot').length > n, 'keeps taking them while somebody looks');
  sc.stopAll();
});

test('input goes to the page the phone sees, the page knows the person has control, and it is rate-limited', async () => {
  const br = fakeBrowser(), clock = fakeClock();
  const sc = createScreens({ resolvePort: async () => 9311, connect: () => br.connect(), now: clock.now, timers: clock });
  assert.equal((await sc.input('b1', { type: 'tap', x: 1, y: 1 })).status, 409, 'no picture yet');
  await sc.frame('b1', { wait: 10 });
  sc.flag('b1', true);
  assert.ok(br.sent.some(([m, p]) => m === 'Runtime.evaluate' && /__octaUser=true/.test(p.expression)));
  assert.deepEqual(await sc.input('b1', { type: 'tap', x: 100, y: 50 }), { ok: true });
  const press = br.sent.find(([m, p]) => m === 'Input.dispatchMouseEvent' && p.type === 'mousePressed');
  assert.deepEqual([press[1].x, press[1].y, press[2]], [100, 50, 'S-T1']);
  assert.equal((await sc.input('b1', { type: 'nope' })).status, 400);
  assert.deepEqual(await sc.nav('b1', { act: 'go', url: 'example.com' }), { ok: true, url: 'https://example.com' });
  let limited = 0;
  for (let i = 0; i < 60; i++) if ((await sc.input('b1', { type: 'text', text: 'a' })).status === 429) limited++;
  assert.ok(limited > 0, 'a flood of input is cut off');
  await clock.advance(2000);
  assert.deepEqual(await sc.input('b1', { type: 'text', text: 'b' }), { ok: true }, 'and allowed again a moment later');
  sc.flag('b1', false);
  assert.ok(br.sent.some(([m, p]) => m === 'Runtime.evaluate' && p.expression === 'window.__octaUser=false'));
  sc.stopAll();
});

test('remote port: watching needs pairing, touching the page needs 接手, runner and desktop stay closed', { skip: !hasDeps && 'desktop packages not installed' }, async t => {
  const { startServer } = await import(pathToFileURL(join(repo, 'desktop/server.mjs')).href);
  const dataDir = mkdtempSync(join(tmpdir(), 'octa-remote-'));
  mkdirSync(join(dataDir, 'bin'), { recursive: true });
  writeFileSync(join(dataDir, 'bin', 'cloudflared'), '#!/bin/sh\necho "https://phone-test.trycloudflare.com" 1>&2\nexec sleep 600\n'); chmodSync(join(dataDir, 'bin', 'cloudflared'), 0o755);
  const calls = [], hands = [];
  const screen = {
    async frame(bot) { calls.push(['frame', bot]); return { seq: 3, jpeg: Buffer.from([0xff, 0xd8, 0xff]), meta: { url: 'https://shop.example/', title: '商店', deviceWidth: 1200, deviceHeight: 800 } }; },
    async input(bot, ev) { calls.push(['input', bot, ev.type]); return { ok: true }; },
    async nav(bot, b) { calls.push(['nav', bot, b.act]); return { ok: true }; },
    flag(bot, on) { calls.push(['flag', bot, on]); }, bye(bot) { calls.push(['bye', bot]); }, stopAll() { }
  };
  const s = await startServer({ dataDir, runner: false, screen, hooks: { onHandoff: (bot, on) => hands.push([bot, on]) } });
  t.after(async () => { await s.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const jpost = (url, body, h = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify(body || {}) });
  const bot = (await (await jpost(s.url + '/api/bots', { name: '助理', task: '' })).json()).id;
  // the computer's own window may watch (the page opened in a browser on this computer, no embedded view)
  const own = await fetch(s.url + '/api/screen/' + bot);
  assert.equal(own.status, 200);
  assert.equal(own.headers.get('content-type'), 'image/jpeg');
  assert.equal(own.headers.get('x-octa-seq'), '3');
  assert.equal(JSON.parse(decodeURIComponent(own.headers.get('x-octa-meta'))).title, '商店');
  // remote off: nothing
  assert.equal((await fetch(s.remoteUrl + '/api/screen/' + bot)).status, 503);
  const on = await (await jpost(s.url + '/api/desktop/remote', { on: true })).json();
  assert.equal(on.on, true);
  // not paired: no picture, no input
  assert.equal((await fetch(s.remoteUrl + '/api/screen/' + bot)).status, 401);
  assert.equal((await jpost(s.remoteUrl + '/api/screen/' + bot + '/input', { type: 'tap', x: 1, y: 1 })).status, 401);
  assert.equal((await fetch(s.remoteUrl + '/api/screen/' + bot, { headers: { authorization: 'Bearer nottoken' } })).status, 401);
  const { token } = await (await jpost(s.remoteUrl + '/api/pair', { code: on.code })).json();
  const H = { authorization: 'Bearer ' + token };
  // paired: watch
  const r = await fetch(s.remoteUrl + '/api/screen/' + bot + '?after=0&w=1170&h=2000', { headers: H });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-octa-handed'), '0');
  assert.equal((await fetch(s.remoteUrl + '/api/screen/nobot', { headers: H })).status, 404);
  // touching the page before 接手 is refused, and the stream never sees it
  assert.equal((await jpost(s.remoteUrl + '/api/screen/' + bot + '/input', { type: 'tap', x: 1, y: 1 }, H)).status, 403);
  assert.equal((await jpost(s.remoteUrl + '/api/screen/' + bot + '/nav', { act: 'reload' }, H)).status, 403);
  assert.equal(calls.filter(c => c[0] === 'input' || c[0] === 'nav').length, 0);
  // 接手 from the phone: the computer's switch and the page flag follow
  assert.equal((await jpost(s.remoteUrl + '/api/handoff', { bot, on: true }, H)).status, 200);
  assert.deepEqual(hands.at(-1), [bot, true]);
  assert.deepEqual(calls.find(c => c[0] === 'flag'), ['flag', bot, true]);
  assert.equal((await fetch(s.remoteUrl + '/api/screen/' + bot, { headers: H })).headers.get('x-octa-handed'), '1');
  assert.equal((await jpost(s.remoteUrl + '/api/screen/' + bot + '/input', { type: 'tap', x: 1, y: 1 }, H)).status, 200);
  assert.equal((await jpost(s.remoteUrl + '/api/screen/' + bot + '/nav', { act: 'back' }, H)).status, 200);
  // the phone's taps don't wake every screen (no rev bump)
  const rev0 = (await (await fetch(s.url + '/api/state')).json()).rev;
  await jpost(s.remoteUrl + '/api/screen/' + bot + '/input', { type: 'text', text: 'x' }, H);
  assert.equal((await (await fetch(s.url + '/api/state')).json()).rev, rev0);
  // 我好了 (or the computer's 僅觀看): input is refused again
  await jpost(s.url + '/api/handoff', { bot, on: false });
  assert.deepEqual(hands.at(-1), [bot, false]);
  assert.equal((await jpost(s.remoteUrl + '/api/screen/' + bot + '/input', { type: 'tap', x: 1, y: 1 }, H)).status, 403);
  // leaving
  assert.equal((await jpost(s.remoteUrl + '/api/screen/' + bot + '/bye', {}, H)).status, 200);
  assert.deepEqual(calls.at(-1), ['bye', bot]);
  // the runner's and the computer's own endpoints stay closed to the phone, paired or not
  for (const p of ['/api/runner/next', '/api/runner/live', '/api/desktop/status', '/api/desktop/remote']) assert.equal((await fetch(s.remoteUrl + p, { headers: H })).status, 403, p);
});

test('phone UI: full-screen live picture, 接手 / 我好了, keyboard row, deep link', () => {
  assert.match(html, /<script defer src="\/js\/screen\.js"><\/script>/);
  for (const id of ['scr', 'scrIn', 'stPic', 'scrBar', 'scrAddr', 'scrBack', 'scrReload', 'scrKb', 'scrText', 'scrPaste', 'stHand', 'stGo', 'webCtl']) assert.match(html, new RegExp(`id="${id}"`), id);
  assert.match(html, />我好了</);
  for (const k of ['Backspace', 'Tab', 'Enter']) assert.match(html, new RegExp(`data-key="${k}"`));
  assert.match(css, /\.scr\{[^}]*touch-action:none/, 'the app itself never scrolls or zooms under the fingers');
  assert.match(css, /\.wp-pane\.web\.scr-on\{padding:0 0 calc\(6px \+ var\(--safe-b\)\)/, 'safe-area inset at the bottom');
  assert.match(css, /\.scr-kb input\{[^}]*font-size:max\(16px/, 'iOS does not zoom into the typing box');
  assert.match(fnSrc('scrTake'), /api\('handoff','POST',\{bot:id,on:true\}\)/);
  assert.match(fnSrc('scrDone'), /HAND_BUSY\.delete\(id\)\|\|handWaits\(id\)/, '我好了 continues the job the same way as the computer');
  assert.match(fnSrc('scrDone'), /登入好了，繼續剛才的工作/);
  assert.match(fnSrc('scrStop'), /\/bye/);
  assert.match(js, /if\(needsHand\(l\.text\)&&bot\(l\.by\)&&!window\.octaDesktop\?\.dock\)goWeb\(c,l\.by\)/, 'a sign-in notification opens the 瀏覽器 tab');
  assert.match(fnSrc('goWeb'), /SCR\.ready=id/);
  assert.match(js, /#web=/);
});

test('OCTA\'s own browser takes the phone\'s input through Electron (a parked page gets it too)', async () => {
  const { phoneInput } = await import(pathToFileURL(join(repo, 'desktop/embed-layout.mjs')).href);
  assert.deepEqual(phoneInput({ type: 'tap', x: 10.4, y: 20 }).filter(s => s.input).map(s => s.input.type), ['mouseMove', 'mouseDown', 'mouseUp']);
  assert.deepEqual(phoneInput({ type: 'text', text: 'abc' }), [{ text: 'abc' }]);
  assert.match(phoneInput({ type: 'scroll', x: 1, y: 1, dx: 0, dy: 300 })[0].script, /scrollBy/);
  assert.deepEqual(phoneInput({ type: 'key', key: 'Enter' }).map(s => s.input.type), ['keyDown', 'char', 'keyUp']);
  assert.equal(phoneInput({ type: 'key', key: 'Delete' }), null);
  // the stream hands input to the hook first; CDP input only when the hook does not take it
  const br = fakeBrowser(), clock = fakeClock(), got = [];
  const sc = createScreens({ resolvePort: async () => 19011, connect: () => br.connect(), now: clock.now, timers: clock, inputHook: a => { got.push(a); return a.port === 19011; } });
  await sc.frame('b1', { wait: 10 });
  assert.deepEqual(await sc.input('b1', { type: 'tap', x: 3, y: 4 }), { ok: true });
  assert.deepEqual([got[0].port, got[0].targetId, got[0].ev.type], [19011, 'T1', 'tap']);
  assert.equal(br.sent.some(([m]) => m === 'Input.dispatchMouseEvent'), false);
  sc.stopAll();
  assert.match(read('desktop/main.mjs'), /screenInput: async \(\{ port, targetId, ev \}\) =>[\s\S]*?wc\.sendInputEvent\(st\.input\)/);
  assert.match(read('desktop/main.mjs'), /onHandoff: \(id, on\) =>[\s\S]*?setControl\(bucket, !!on, false\)/, 'the computer\'s switch follows the phone');
});
