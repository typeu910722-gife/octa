// 4.9 深海基地 (app/js/seamodel.js + seabase.js) and the 深海 look: the scene built from the polled state, the layout and
// routes through the tubes, the render loop's lifecycle, freeing GPU memory, the vendored three.js, and the theme's contrast.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { css, fnSrc, html, js, read, root, scripts } from './app-source.mjs';

const M = new Function(scripts['pure.js'] + '\n' + scripts['seamodel.js'] + '\nreturn { seaModel, seaLayout, seaSpot, seaRoute, seaLoop, seaDispose, seaCut, SEA_POD_COLS };')();
const now = Date.UTC(2026, 10, 4, 4);
const state = () => ({
  bots: [{ id: 'a', name: '小美', folder: 'f1', color: '#E58C8A' }, { id: 'b', name: '阿哲', folder: 'f1' }, { id: 'c', name: '客服', folder: 'f2' },
    { id: 'd', name: '記帳' }, { id: 'e', name: '秘書', folder: 'gone' }, { id: 'p', name: '排程', folder: 'f2' }, { id: 's', name: '社群', folder: 'f2' }],
  groups: [{ id: 'g1', name: '週報小組', members: ['p', 's', 'x'], folder: 'f2' }],
  folders: [{ id: 'f1', name: '台南店' }, { id: 'f2', name: '行銷部' }],
  busy: [
    { job: 1, bot_id: 'a', status: 'running', kind: 'chat', conv: 'a', progress: { text: '打開蝦皮賣家後台', step: 2, total: 5, kind: 'browse' } },
    { job: 2, bot_id: 'c', status: 'running', kind: 'chat', conv: 'c', bg: 1, from: 'b', progress: { text: '查 12/24 空房' } },
    { job: 3, bot_id: 'p', status: 'running', kind: 'chat', conv: 'p', paused: true, progress: { text: '排貼文', step: 1, total: 2 } },
    { job: 4, bot_id: 's', status: 'running', kind: 'chat', conv: 'g1', progress: { text: '整理本週數據', step: 2, total: 3 } },
    { job: 5, bot_id: 'd', status: 'pending', kind: 'chat', conv: 'd' }
  ],
  last: [{ conv: 'e', by: 'e', text: '✅ 待確認：寄出報價單', awhat: '寄出報價單', ts: now - 60000 }],
  lastJob: { d: { job: 9, ok: false, kind: 'api', msg: '銀行網站沒有回應（503）', at: now - 1000 } },
  gask: { g1: 1 }, done: { a: 3, c: 1, x: 0 }, now
});

test('the scene: a module per 分區, the hub for the rest, meeting rooms, each bot in its place', () => {
  const m = M.seaModel(state());
  assert.deepEqual(m.pods.map(p => [p.id, p.kind, p.name, p.depth]), [['hub', 'hub', '中央大廳', 120], ['f1', 'pod', '台南店', 140], ['f2', 'pod', '行銷部', 160]]);
  assert.deepEqual(m.pods.map(p => p.bots), [['d', 'e'], ['a', 'b'], ['c', 'p', 's']], 'a bot whose 分區 is gone waits in the hub');
  assert.equal(new Set(m.pods.map(p => p.color)).size, 3, 'each module has its own light');
  assert.deepEqual(m.rooms, [{ id: 'g1', name: '週報小組', pod: 'f2', members: ['p', 's'], need: 'ap', busy: true }]);
  assert.deepEqual(m.pods[2].rooms, ['g1']);
});

test('each bot: its state, a short bubble (step N/M), needs-you and failed, paused, hand-offs', () => {
  const m = M.seaModel(state()), b = id => m.bots.find(x => x.id === id);
  assert.equal(b('a').state, 'browsing');
  assert.deepEqual(b('a').bubble, { lab: '', txt: '2/5 打開蝦皮賣家後台', tone: 'run' });
  assert.equal(b('a').word, '操作瀏覽器');
  // 阿哲 handed work to 客服: 客服 is helping, 阿哲 swims over and waits beside it
  assert.equal(b('c').state, 'chatting'); assert.equal(b('c').from, 'b');
  assert.deepEqual(b('c').bubble, { lab: '幫同事', txt: '阿哲：查 12/24 空房', tone: 'chat' });
  assert.equal(b('b').visit, 'c'); assert.deepEqual(b('b').bubble, { lab: '等回覆', txt: '客服', tone: 'chat' });
  assert.deepEqual(m.links, [{ from: 'b', to: 'c', job: 2 }]);
  // paused
  assert.equal(b('p').paused, true); assert.equal(b('p').word, '已暫停');
  assert.deepEqual(b('p').bubble, { lab: '已暫停', txt: '1/2 排貼文', tone: 'pause' });
  // a group's work is done at the meeting table
  assert.equal(b('s').room, 'g1');
  // needs you (an approval card) and failed (its last run did not work out); queued
  assert.equal(b('e').need, 'ap'); assert.deepEqual(b('e').bubble, { lab: '待你核准', txt: '寄出報價單', tone: 'need' });
  assert.equal(b('d').fail, true); assert.deepEqual(b('d').bubble, { lab: '沒做成', txt: '銀行網站沒有回應（503）', tone: 'fail' });
  assert.equal(b('d').queued, 1);
  // counters: working (not paused), needs you (bots and group cards), done today
  assert.deepEqual(m.counters, { working: 3, need: 2, done: 4, fail: 1 });
  // bubbles stay short, cut where a phrase ends
  assert.equal(M.seaCut('今天的訂單整理好了，共有十二筆，其中三筆需要你確認地址', 20), '今天的訂單整理好了，共有十二筆…');
  assert.ok(M.seaCut('x'.repeat(80), 26).length <= 26);
});

test('the layout: modules around the hub without touching, desks inside their dome, swimming goes through the tubes', () => {
  const m = M.seaModel(state()), L = M.seaLayout(m);
  const pods = Object.entries(L.pods);
  for (const [i, [a, p]] of pods.entries()) for (const [b, q] of pods.slice(i + 1)) assert.ok(Math.hypot(p.x - q.x, p.z - q.z) > p.r + q.r + 2, a + ' and ' + b + ' apart');
  for (const r of Object.values(L.rooms)) for (const p of Object.values(L.pods)) assert.ok(Math.hypot(r.x - p.x, r.z - p.z) > r.r + p.r, 'a meeting room clear of the domes');
  for (const [id, d] of Object.entries(L.desks)) { const p = L.pods[d.pod]; assert.ok(Math.hypot(d.x - p.x, d.z - p.z) < p.r, id + ' sits inside its dome'); }
  // 阿哲 (台南店) to 客服 (行銷部): out of its dome, through the hub, into the other one
  const b = m.bots.find(x => x.id === 'b'), spot = M.seaSpot(m, L, b);
  assert.equal(spot.node, 'pod:f2');
  const route = M.seaRoute(L, 'pod:f1', spot.node, L.desks.b, spot);
  assert.ok(route.some(p => Math.hypot(p.x, p.z) < 0.01), 'through the middle of the hub');
  assert.ok(route.length >= 6);
  assert.deepEqual(M.seaRoute(L, 'pod:f1', 'pod:f1', { x: 1, z: 1 }, { x: 2, z: 2 }), [{ x: 1, z: 1 }, { x: 2, z: 2 }], 'same dome: straight there');
  const s = m.bots.find(x => x.id === 's'); assert.equal(M.seaSpot(m, L, s).node, 'room:g1');
});

test('the render loop: at most 30 frames a second, nothing while hidden, only while something moves, stops for good on close', () => {
  let q = [], id = 0, t = 0, hidden = false, moving = true, frames = 0;
  const raf = f => { q.push([++id, f]); return id; }, caf = x => { q = q.filter(([i]) => i !== x); };
  const run = n => { for (let i = 0; i < n && q.length; i++) { t += 1000 / 60; const [, f] = q.shift(); f(); } };
  const L = M.seaLoop({ raf, caf, now: () => t, frame: () => frames++, hidden: () => hidden, animate: () => moving });
  L.start(); run(60);
  assert.ok(frames >= 28 && frames <= 32, '60 display frames → about 30 drawn (' + frames + ')');
  hidden = true; run(5); assert.equal(q.length, 0, 'hidden: nothing scheduled'); const f0 = frames; run(10); assert.equal(frames, f0);
  hidden = false; L.kick(); assert.equal(q.length, 1, 'back: one frame asked for');
  moving = false; run(20); assert.equal(q.length, 0, 'still picture: stops once nothing moves'); assert.ok(L.on);
  L.kick(3); run(20); assert.equal(q.length, 0);
  L.stop(); L.kick(); assert.equal(q.length, 0, 'closed: kick does nothing'); assert.equal(L.running, false);
});

test('closing frees every geometry, material and texture once (shared ones too), and the view tears down', () => {
  const made = []; const thing = k => { const o = { k, n: 0, dispose() { this.n++; } }; made.push(o); return o; };
  const tex = () => Object.assign(thing('tex'), { isTexture: true });
  const shared = Object.assign(thing('mat'), { isMaterial: true, map: tex() }), glow = tex();
  const shader = Object.assign(thing('mat'), { isMaterial: true, uniforms: { uTime: { value: 1 }, uMap: { value: glow } } });
  const scene = { children: [{ geometry: thing('geo'), material: shared, children: [{ geometry: thing('geo'), material: [shared, shader] }] }, { geometry: thing('geo'), material: shared }] };
  const n = M.seaDispose(scene, [glow, tex()]);
  assert.deepEqual(n, { geo: 3, mat: 2, tex: 3 });
  assert.ok(made.every(o => o.n === 1), 'each freed exactly once');
  // the view: listeners on one AbortController, the poll interval cleared, the renderer and its GL context released
  const close = fnSrc('closeSea'), free = fnSrc('seaFree');
  assert.match(close, /clearInterval\(SEA\.iv\)/); assert.match(close, /SEA\.ac\?\.abort\(\)/); assert.match(close, /seaFree\(SEA\.g\)/); assert.match(close, /el\.remove\(\)/);
  assert.match(free, /G\.loop\.stop\(\)/); assert.match(free, /G\.r\.dispose\(\)/); assert.match(free, /forceContextLoss\(\)/); assert.match(free, /seaDispose\(G\.scene/);
  const src = scripts['seabase.js'], adds = [...src.matchAll(/addEventListener\('([a-z]+)'/g)];
  assert.ok(adds.length >= 12);
  for (const m of adds) assert.match(src.slice(m.index, m.index + 900), /,sig\)|\{\.\.\.sig/, m[1] + ' is removed on close');
  // hidden or minimised: the loop stops; reduced motion and 省電模式: still pictures, smaller pixel ratio
  assert.match(scripts['seabase.js'], /visibilitychange',\(\)=>\{if\(SEA\.g\)\{if\(document\.hidden\)SEA\.g\.loop\.stop\(\)/);
  assert.match(scripts['seabase.js'], /hidden:\(\)=>document\.hidden\|\|!SEA\.el,animate:\(\)=>!seaStill\(\)\|\|seaMoving\(G\)/);
  assert.match(fnSrc('seaStill'), /seaLow\(\)\|\|seaReduced\(\)/);
  assert.match(scripts['seabase.js'], /const seaPR=\(\)=>Math\.min\(devicePixelRatio\|\|1,seaLow\(\)\?1:1\.5\)/);
  // the phone's back gesture and Esc close it; the docked browser of the desktop app steps aside while it is open
  assert.match(read('app/js/sheets.js'), /k==='sea'\)\{if\(typeof closeSea==='function'\)closeSea\(true\)/);
  assert.match(fnSrc('dockSync'), /!\$\('sea'\)/);
});

test('three.js is vendored (pinned, MIT), loaded only when the view opens, from this computer', () => {
  const f = join(root, 'app/vendor/three-0.170.0.module.min.js');
  assert.ok(existsSync(f)); const size = statSync(f).size; assert.ok(size > 500e3 && size < 800e3, 'about 690 KB');
  assert.match(readFileSync(f, 'utf8').slice(0, 200), /SPDX-License-Identifier: MIT/);
  assert.match(read('app/vendor/three-LICENSE.txt'), /The MIT License/);
  assert.match(scripts['seabase.js'], /const SEA_LIB='\/vendor\/three-0\.170\.0\.module\.min\.js'/);
  assert.match(scripts['seabase.js'], /import\(SEA_LIB\)/, 'a dynamic import: nothing is loaded until 深海基地 opens');
  assert.doesNotMatch(html + js, /(cdn|unpkg|jsdelivr|cdnjs)[^'"]*three/i);
  assert.doesNotMatch(html, /vendor\/three/, 'not in the page itself');
  assert.match(read('desktop/server.mjs'), /p\.startsWith\('\/vendor\/'\) \? 'public, max-age=31536000, immutable'/);
  assert.ok(JSON.parse(read('desktop/package.json')).build.files.includes('web/**'));
  // the page: the button beside 任務總覽, the scripts in order, a fallback without WebGL
  assert.ok(html.includes('id="seaBtn"'));
  assert.ok(html.indexOf('/js/seamodel.js') < html.indexOf('/js/seabase.js') && html.indexOf('/js/pure.js') < html.indexOf('/js/seamodel.js'));
  assert.match(fnSrc('openSea'), /if\(!seaHasGL\(\)\)\{seaFallback\(\);return\}/);
  assert.match(css, /\.sea-cards\{/);
});

test('busy rows say who handed the job over (jobs.via f, or an older 〔背景:…〕 prompt)', async () => {
  const { busyRows } = await import('../desktop/api/progress.mjs');
  const [a, b, c] = busyRows([{ job: 1, via: '{"f":"bot-a","k":"give"}', p0: 'x', progress: null, paused: 0 }, { job: 2, via: null, p0: '〔背景:bot-b:ask〕同事「阿哲」', progress: null, paused: 1 }, { job: 3, via: null, p0: '幫我查', progress: null }]);
  assert.equal(a.from, 'bot-a'); assert.equal(b.from, 'bot-b'); assert.equal(c.from, null);
  assert.ok(!('via' in a) && !('p0' in a), 'the raw columns are not sent');
  assert.match(read('desktop/api/chat-routes.mjs'), /via, substr\(prompt,1,48\) AS p0/);
});

// ---------- the 深海 look ----------
const tokens = read('app/css/tokens.css');
const block = sel => { const i = tokens.indexOf(sel + '{'); assert.ok(i >= 0, sel); return tokens.slice(i, tokens.indexOf('}', i)); };
const vars = b => Object.fromEntries([...b.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/gi)].map(m => [m[1], m[2]]));
const rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const lum = c => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
const ratio = (a, b) => { const x = lum(rgb(a)), y = lum(rgb(b)); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

test('深海 tokens: text reads at WCAG AA on every surface, and the look comes after both dark rules', () => {
  const v = vars(block(':root[data-theme="sea"]'));
  for (const fg of ['ink', 'ink2', 'mute', 'accent-ink', 'accent', 'ok', 'warn', 'err', 'info']) for (const bg of ['bg', 'side', 'panel', 'raised', 'sunk'])
    assert.ok(ratio(v[fg], v[bg]) >= 4.5, `${fg} on ${bg}: ${ratio(v[fg], v[bg]).toFixed(2)}`);
  assert.ok(ratio(v['me-ink'], v.me) >= 4.5);
  assert.ok(ratio(v['on-accent'], v.accent) >= 4.5, 'button text');
  for (const bg of ['bg', 'side', 'panel']) assert.ok(ratio(v.faint, v[bg]) >= 3, 'placeholders and hints ≥ 3:1');
  assert.ok(tokens.indexOf(':root[data-theme="sea"]{') > tokens.lastIndexOf(':root[data-theme="dark"]{'), 'wins over the system-dark rule');
  assert.match(block(':root[data-theme="sea"]'), /color-scheme:dark/);
  // light and dark untouched
  assert.match(tokens, /:root\{\n\s+color-scheme:light;/); assert.equal(vars(block(':root[data-theme="dark"]')).bg, '#121110');
});

test('your 主題色 still applies in 深海, readable on its panels', () => {
  const helpers = ['hexRgb', 'rgbHex', 'lum', 'contrast', 'mixRgb', 'readable', 'accentCss'].map(fnSrc).join('\n');
  const accentCss = new Function(helpers + '\nreturn accentCss;')();
  const { PALETTE } = new Function(scripts['pure.js'] + '\nreturn { PALETTE };')();
  for (const [hex] of PALETTE) {
    const out = accentCss(hex), sea = out.slice(out.indexOf(':root[data-theme="sea"]{'));
    assert.ok(out.indexOf(':root[data-theme="sea"]') > out.indexOf(':root[data-theme="dark"]'), 'after the dark rules');
    const v = vars(sea);
    assert.ok(ratio(v.accent, '#0a2233') >= 4.5 && ratio(v['accent-ink'], '#0a2233') >= 4.5, hex + ' reads on the deep panels');
    assert.ok(ratio(v['on-accent'], v.accent) >= 4.5, hex + ' button text');
  }
  // stored before 4.9 (no 深海 part): redone once; the copy from <head> is moved after the stylesheets
  assert.match(scripts['prefs.js'], /if\(a&&!css\.includes\('data-theme="sea"'\)\)applyAccent\(a\);const el=\$\('accentCss'\);if\(el\)document\.head\.appendChild\(el\)/);
});

test('深海 in Settings, before first paint, the moving light, 省電模式', () => {
  assert.match(js, /\['sea','深海','sea'\]/);
  assert.match(fnSrc('themeChoice'), /s==='sea'/);
  assert.match(fnSrc('currentTheme'), /if\(t==='sea'\)return 'dark'/, 'the docked browser and anything light/dark-only see a dark look');
  assert.match(html, /if\(t==='sea'\)d\.setAttribute\('data-theme',t\);/);
  assert.match(scripts['util.js'], /\nseaFx\(\);/, 'the moving light starts with the page');
  assert.match(fnSrc('seaFx'), /h\.dataset\.theme==='sea'&&store\.get\('octa_seafx'\)!=='0'&&store\.get\('octa_lowpower'\)!=='1'/);
  const sea = read('app/css/sea.css');
  assert.match(sea, /@media \(prefers-reduced-motion:reduce\)\{:root\.seafx \.seafx-layer\{display:none\}\}/);
  assert.match(sea, /:root\.seafx \.seafx-layer\{display:block;position:fixed;[^}]*pointer-events:none/);
  assert.doesNotMatch(sea.replace(/\/\*[\s\S]*?\*\//g, ''), /@keyframes[^}]*\{[^}]*(filter|width|height|left|top)\s*:/, 'the moving light animates transforms only');
  assert.match(scripts['prefs.js'], /\$\('pLow'\)\.onchange=e=>\{store\.set\('octa_lowpower',e\.target\.checked\?'1':null\);seaFx\(\);if\(typeof seaPrefs==='function'\)seaPrefs\(\)\}/);
  assert.ok(html.includes('/css/sea.css') && html.includes('/css/seabase.css'));
});
