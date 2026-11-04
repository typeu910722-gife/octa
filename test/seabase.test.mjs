// 4.9 深海基地 (app/js/seamodel.js + seabase.js) and the 深海 look: the scene built from the polled state, the layout and
// routes through the tubes, the render loop's lifecycle, freeing GPU memory, the vendored three.js, and the theme's contrast.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { css, dict, fnSrc, html, js, read, root, scripts, secSrc } from './app-source.mjs';

const M = new Function(scripts['pure.js'] + '\n' + scripts['seamodel.js'] + '\nreturn { seaModel, seaLayout, seaSpot, seaRoute, seaLoop, seaDispose, seaCut, SEA_POD_COLS, seaActs, SEA_ACTS, seaHash, seaRate, seaFrameOf };')();
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

test('turning 主畫面 3D 基地 off frees every geometry, material and texture once (shared ones too), and its GL context', () => {
  const made = []; const thing = k => { const o = { k, n: 0, dispose() { this.n++; } }; made.push(o); return o; };
  const tex = () => Object.assign(thing('tex'), { isTexture: true });
  const shared = Object.assign(thing('mat'), { isMaterial: true, map: tex() }), glow = tex();
  const shader = Object.assign(thing('mat'), { isMaterial: true, uniforms: { uTime: { value: 1 }, uMap: { value: glow } } });
  const scene = { children: [{ geometry: thing('geo'), material: shared, children: [{ geometry: thing('geo'), material: [shared, shader] }] }, { geometry: thing('geo'), material: shared }] };
  const n = M.seaDispose(scene, [glow, tex()]);
  assert.deepEqual(n, { geo: 3, mat: 2, tex: 3 });
  assert.ok(made.every(o => o.n === 1), 'each freed exactly once');
  // 4.10 the scene lives as long as the setting is on: freed only by seaSet(false); listeners on one AbortController
  assert.match(fnSrc('seaSet'), /if\(!on&&SEA\.g\)seaFree\(SEA\.g\)/);
  const free = fnSrc('seaFree');
  assert.match(free, /G\.loop\.stop\(\)/); assert.match(free, /SEA\.ac\?\.abort\(\)/); assert.match(free, /G\.r\.dispose\(\)/); assert.match(free, /forceContextLoss\(\)/); assert.match(free, /seaDispose\(G\.scene/);
  assert.match(free, /G\.cv\.remove\(\)/); assert.match(free, /SEA\.g=null/);
  for (const f of ['seaInit', 'seaControls']) {
    const src = fnSrc(f), adds = [...src.matchAll(/addEventListener\('([a-z]+)'/g)];
    assert.ok(adds.length >= (f === 'seaInit' ? 6 : 8), f);
    for (const m of adds) assert.match(src.slice(m.index, m.index + 900), /,sig\)|\{\.\.\.sig/, f + ': ' + m[1] + ' is removed with the scene');
  }
  // hidden (the window, or the base not on screen): nothing drawn; the rate is asked every frame
  assert.match(fnSrc('seaInit'), /hidden:\(\)=>document\.hidden\|\|!seaShown\(\),rate:seaRateNow/);
  assert.match(fnSrc('seaStill'), /seaLow\(\)\|\|seaReduced\(\)/);
  assert.match(scripts['seabase.js'], /const seaPR=\(\)=>Math\.min\(devicePixelRatio\|\|1,seaLow\(\)\?1:1\.5\)/);
  // the separate page is gone: no back-gesture entry for it, and the docked browser no longer steps aside for it
  assert.doesNotMatch(read('app/js/sheets.js'), /closeSea|k==='sea'/);
  assert.doesNotMatch(fnSrc('dockSync'), /\$\('sea'\)/);
});

test('three.js is vendored (pinned, MIT), fetched after the first paint, from this computer', () => {
  const f = join(root, 'app/vendor/three-0.170.0.module.min.js');
  assert.ok(existsSync(f)); const size = statSync(f).size; assert.ok(size > 500e3 && size < 800e3, 'about 690 KB');
  assert.match(readFileSync(f, 'utf8').slice(0, 200), /SPDX-License-Identifier: MIT/);
  assert.match(read('app/vendor/three-LICENSE.txt'), /The MIT License/);
  assert.match(scripts['seabase.js'], /const SEA_LIB='\/vendor\/three-0\.170\.0\.module\.min\.js'/);
  assert.match(scripts['seabase.js'], /import\(SEA_LIB\)/, 'a dynamic import');
  assert.doesNotMatch(html + js, /(cdn|unpkg|jsdelivr|cdnjs)[^'"]*three/i);
  assert.doesNotMatch(html, /vendor\/three/, 'not in the page itself');
  assert.match(read('desktop/server.mjs'), /p\.startsWith\('\/vendor\/'\) \? 'public, max-age=31536000, immutable'/);
  assert.ok(JSON.parse(read('desktop/package.json')).build.files.includes('web/**'));
  assert.ok(!html.includes('id="seaBtn"'));
  assert.ok(html.indexOf('/js/seamodel.js') < html.indexOf('/js/seabase.js') && html.indexOf('/js/pure.js') < html.indexOf('/js/seamodel.js'));
  // 4.10: after the app is on screen (a frame, then a moment), only when the base is to be shown; no WebGL: a still gradient
  const start = fnSrc('start');
  assert.ok(start.indexOf('render(true)') < start.indexOf('requestAnimationFrame(()=>setTimeout(seaBoot,250))'), 'seaBoot after the first render');
  const ens = fnSrc('seaEnsure');
  assert.match(ens, /!seaEnabled\(\)\|\|!seaShown\(\)\)return/);
  assert.match(ens, /if\(SEA\.gl==null&&!seaHasGL\(\)\)\{seaFallback\(\);return\}/);
  assert.match(ens, /seaLib\(\)\.then\(T=>\{SEA\.loading=false;if\(seaEnabled\(\)&&!SEA\.g&&SEA\.st\)seaInit\(T\)\}\)/);
  assert.match(fnSrc('seaFallback'), /if\(SEA\.gl===false\)return;SEA\.gl=false/, 'once (no loop with stageSync)');
  assert.match(css, /\.sea-stage\.flat \.sea-hint/);
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

// ---------- 4.9.2: nothing to do → something to do (遊戲角), and one page with 任務總覽 ----------
const idleState = (busy = []) => ({
  bots: ['a', 'b', 'c', 'd', 'e'].map((id, i) => ({ id, name: 'B' + id, folder: i % 2 ? 'f1' : null })),
  folders: [{ id: 'f1', name: '台南店' }], groups: [], busy, now
});

test('idle bots find something to do: the same answer for the same moment, pairs at the tables, one at a time at the arcade', () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];
  assert.deepEqual(M.seaActs(ids, now), M.seaActs([...ids].reverse(), now), 'deterministic, whatever the order');
  const seen = new Set(), pairs = new Set();
  for (let k = 0; k < 400; k++) {
    const t = now + k * 15000, a = M.seaActs(ids, t);
    assert.deepEqual(Object.keys(a).sort(), ids, 'everyone gets something');
    for (const [id, x] of Object.entries(a)) {
      seen.add(x.k);
      assert.ok(M.SEA_ACTS[x.k], x.k);
      if (M.SEA_ACTS[x.k].two) { assert.equal(a[x.with].with, id, 'a game for two has both players'); assert.equal(a[x.with].k, x.k); assert.notEqual(a[x.with].side, x.side); pairs.add(x.at); }
    }
    // one bot at a time at the arcade, the jukebox and the bean bag; at most one game per table
    for (const k2 of ['arcade', 'dance', 'read']) assert.ok(Object.values(a).filter(x => x.k === k2).length <= 1, k2);
    for (const at of ['t0', 't1']) assert.ok(Object.values(a).filter(x => x.at === at).length <= 2, at);
  }
  assert.ok(seen.size >= 10, 'variety over time: ' + [...seen].join(','));
  assert.deepEqual([...pairs].sort(), ['t0', 't1'], 'both tables get used');
  // two idle bots: usually they play together
  let together = 0; for (let k = 0; k < 200; k++) { const a = M.seaActs(['x', 'y'], now + k * 45000); if (a.x.with === 'y') together++; }
  assert.ok(together > 120, 'two free bots mostly play a game for two (' + together + '/200)');
  // each changes on its own rhythm (20–60 s), a nap is rare
  let changes = 0, naps = 0, prev = M.seaActs(['solo'], now).solo.k;
  for (let k = 1; k <= 600; k++) { const x = M.seaActs(['solo'], now + k * 5000).solo.k; if (x !== prev) changes++; if (x === 'nap') naps++; prev = x; }
  assert.ok(changes >= 40 && changes <= 160, '50 minutes, a change every 20–60 s (' + changes + ')');
  assert.ok(naps < 120, 'a nap is rare (' + naps + '/600)');
});

test('the scene model: free bots play (bubble says what), work wins at once and they go back to their desk', () => {
  const m = M.seaModel(idleState()), L = M.seaLayout(m);
  assert.ok(m.bots.every(b => b.act), 'nobody just dozes');
  for (const b of m.bots) { assert.equal(b.bubble.lab, M.SEA_ACTS[b.act.k].word); assert.equal(b.word, M.SEA_ACTS[b.act.k].word); }
  // 遊戲角: its own dome beside the hub, clear of everything, joined by a tube (it is a pod in the layout)
  assert.ok(L.pods.play && L.spots.t0a && L.spots.arcadeB);
  for (const [k, p] of Object.entries(L.pods)) if (k !== 'play') assert.ok(Math.hypot(p.x - L.pods.play.x, p.z - L.pods.play.z) > p.r + L.pods.play.r + 2, k);
  for (const [k, sp] of Object.entries(L.spots)) assert.ok(Math.hypot(sp.x - L.pods.play.x, sp.z - L.pods.play.z) < L.pods.play.r, k + ' inside 遊戲角');
  const player = m.bots.find(b => M.SEA_ACTS[b.act.k].two) || m.bots.find(b => ['arcade', 'dance', 'read'].includes(b.act.k));
  if (player) { const sp = M.seaSpot(m, L, player); assert.equal(sp.node, 'pod:play'); assert.ok(M.seaRoute(L, 'pod:' + player.pod, 'pod:play', L.desks[player.id], sp).length >= 3, 'swims there through the tubes'); }
  // a job starts: no game, back at its own desk, its bubble says the work
  const id = (player || m.bots[0]).id;
  const m2 = M.seaModel(idleState([{ job: 7, bot_id: id, status: 'running', kind: 'chat', conv: id, progress: { text: '查訂單', step: 1, total: 2 } }]));
  const b2 = m2.bots.find(b => b.id === id);
  assert.equal(b2.act, null); assert.equal(b2.bubble.tone, 'run');
  assert.deepEqual(M.seaSpot(m2, M.seaLayout(m2), b2), { x: L.desks[id].x, z: L.desks[id].z, node: 'pod:' + L.desks[id].pod }, 'straight back to its console');
  // waiting for you, failed, queued, paused, waiting on a colleague: not playing
  const s = state(), mb = M.seaModel(s);
  for (const id2 of ['b', 'd', 'e', 'p']) assert.equal(mb.bots.find(b => b.id === id2).act, null, id2);
  // the 3D: the pose of the game, props from one pool per bot, a still pose when the picture is still
  assert.match(fnSrc('seaBotState'), /b\.act&&!b\.job\?SEA_ACTS\[b\.act\.k\]\.pose/);
  assert.match(scripts['seabase.js'], /const ak=!e\.route&&b\.act&&!b\.job\?b\.act\.k:''/, 'props only once it got there, never while working');
  assert.doesNotMatch(fnSrc('seaPlay'), /new |\[\]|\{\s*\w+:/, 'no allocations per frame');
  assert.doesNotMatch(fnSrc('seaLoungeFrame'), /new /);
  assert.match(fnSrc('seaPropTex'), /if\(G\.tex\[key\]\)return G\.tex\[key\]/, 'prop pictures made once, freed with the rest');
});

test('4.10 the base is the main screen: no separate page; 總覽 is a tab of the right panel; old links land there', () => {
  // one button (with its needs-you badge), now 「總覽」; the page and its pieces are gone
  assert.equal((html.match(/class="ovbtn/g) || []).length, 1);
  assert.match(html, /id="ovBtn"[^>]*><span data-i="sea" aria-hidden="true"><\/span><span>總覽<\/span><i class="ovbadge" id="ovBadge"/);
  assert.ok(!html.includes('seaBtn'));
  assert.doesNotMatch(js, /openSea|closeSea|openOverview|seaPanel\(|seaSplit\(|\$\('seaX'\)|\$\('seaFold'\)/);
  assert.doesNotMatch(css, /\.seaview/);
  assert.match(scripts['overview.js'], /\$\('ovBtn'\)\.onclick=\(\)=>goOverview\(\);/);
  // 總覽: the right panel's 總覽 tab, the chat folds to its bar, the camera shows the whole base; a phone: 總覽 on its list
  const go = fnSrc('goOverview');
  assert.match(go, /if\(phoneUI\(\)\)\{[^}]*listSeg\('ov'\);return\}/);
  assert.match(go, /openPanel\('ov',\{user:true\}\);if\(stageMode\(\)&&cur\)\{STAGE\.min=true\}/);
  assert.match(go, /seaFocus\(null\)/);
  // the markup: the stage host in the middle, the chat panel (its grip, the fold button, the bar), the hint, the 總覽 tab
  for (const id of ['seaHostD', 'chatp', 'chatGrip', 'chatMin', 'chatMinGo', 'chatMinBtn', 'stageHint', 'wtOv', 'wpOv', 'ovWrap', 'ovSeg', 'ovBody', 'seaHead', 'seaHeadBar', 'seaHostP', 'lov', 'lsegBadge']) assert.ok(html.includes(`id="${id}"`), id);
  assert.ok(html.indexOf('id="wtOv"') < html.indexOf('id="wtWork"'), '總覽 is the first tab');
  assert.ok(html.indexOf('id="seaHostD"') < html.indexOf('id="chatp"') && html.indexOf('id="chatp"') < html.indexOf('id="msgs"') && html.indexOf('id="composer"') < html.indexOf('id="wp"'));
  assert.match(scripts['panel.js'], /const WP_TABS=\['ov','work','web','info'\]/);
  assert.match(scripts['panel.js'], /const panelOn=\(\)=>!\$\('app'\)\.hidden&&\(phoneUI\(\)\?WP\.sheet&&hasConv\(\):WP\.open&&\(WP\.tab==='ov'\|\|hasConv\(\)\)\)/, '總覽 needs no open chat');
  assert.match(fnSrc('renderPanel'), /b\.disabled=b\.dataset\.wt!=='ov'&&!hc/);
  // one set of counters, and they are the filters; cards grouped by 分區
  const paint = fnSrc('paintOverview');
  for (const k of ["'all'", "'run'", "'need'", "'done'", "'fail'"]) assert.ok(paint.includes('[' + k), k);
  assert.match(paint, /role="tab" data-f=/);
  assert.match(paint, /m\.pods\.map\(p=>/, 'cards grouped by 分區, in the base\'s order');
  assert.match(scripts['overview.js'], /f==='bad'\?'fail':f==='today'\?'done'/);
  // #view=overview (also #view=sea and older 深海基地 links) and the 一鍵重試 bar's 總覽 → the 總覽 state
  const octaFrag = new Function(scripts['pure.js'] + ';return octaFrag')();
  assert.equal(octaFrag('#view=overview').view, 'overview'); assert.equal(octaFrag('#view=sea').view, 'overview'); assert.equal(octaFrag('#view=x').view, undefined);
  assert.match(scripts['api.js'], /if\(f\.view\)try\{sessionStorage\.setItem\('octa_goview','1'\)/);
  assert.match(fnSrc('viewDeepLink'), /if\(v\)goOverview\(\)/);
  assert.match(fnSrc('retryBar'), /data-al="ov"/); assert.match(fnSrc('retryBar'), /if\(k==='ov'\)\{el\.remove\(\);goOverview\(\);return\}/);
  // the cards are painted with the picture: one poll, only while they are on screen
  assert.match(fnSrc('loadOverview'), /if\(!ovShown\(\)\|\|OV\.busy\)return/);
  assert.match(fnSrc('loadOverview'), /SEA\.done=Object\.fromEntries/);
  assert.match(fnSrc('seaTick'), /if\(!ovShown\(\)\)return;[^]*loadOverview\(\)/);
  assert.doesNotMatch(scripts['overview.js'], /setInterval\(\(\)=>\{if\(!ovShown\(\)\)/, 'no second poll');
  // every function stays: retry, 已處理, open chat, 工作, 它記得什麼, pause, go approve
  const card = fnSrc('ovCard'), click = fnSrc('ovClick');
  for (const a of ['data-retry', 'data-rok', 'data-open', 'data-work', 'data-mem', 'data-pz', 'data-ask']) { assert.ok(card.includes(a), a); assert.ok(click.includes(a.slice(5)) || click.includes(a), a); }
  for (const s2 of ['遊戲角', '打桌球中 🏓', '總覽', '聊天', '收起對話', '展開對話', '主畫面 3D 基地', '點章魚打開對話', '點一隻章魚，或從左邊選一個機器人開始對話']) assert.ok(dict.en.t[s2] && dict.ja.t[s2], s2);
  // Alt+O 總覽, Alt+M folds the chat; both in the shortcut sheet
  assert.match(scripts['main.js'], /e\.code==='KeyO'&&\$\('veil'\)\.hidden\)\{e\.preventDefault\(\);goOverview\(\)\}/);
  assert.match(scripts['main.js'], /e\.code==='KeyM'[^\n]*chatMinimise\(!STAGE\.min\)/);
  assert.match(scripts['prefs.js'], /\['Alt O','總覽'\],\['Alt M','收起或展開對話'\]/);
});

test('the base and the cards point at each other: an octopus or a card opens its chat, the camera swims there, both light up', () => {
  // a click in the picture → that chat (the chat panel unfolds), and its card is shown when the cards are on screen
  const click = fnSrc('seaClick');
  assert.match(click, /if\(u\.bot\)\{seaOpenConv\(u\.bot\);return\}/);
  assert.match(click, /if\(u\.room\)\{seaOpenConv\(u\.room\);return\}/);
  assert.match(click, /seaFocus\(u\.pod\);if\(u\.pod!=='play'\)ovRevealPod\(u\.pod\)/);
  const oc = fnSrc('seaOpenConv');
  assert.match(oc, /STAGE\.min=false/); assert.match(oc, /else openConv\(id\)/); assert.match(oc, /ovReveal\(id\)/);
  const rev = fnSrc('ovReveal');
  assert.match(rev, /if\(!ovShown\(\)\)return/); assert.match(rev, /OV\.filter='all'/); assert.match(rev, /scrollIntoView/); assert.match(rev, /classList\.add\('flash'\)/);
  // a card → its chat (and the camera); its 分區 header → into that module
  assert.match(fnSrc('ovClick'), /if\(c\)seaOpenConv\(c\.dataset\.oc\)/);
  assert.match(fnSrc('ovClick'), /seaFocus\(SEA\.focus===id\?null:id\)/);
  // the open chat is the picked one (sidebar, card, octopus, Alt ↑↓ all go through openConv → render → stageSync)
  assert.match(fnSrc('render'), /stageSync\(\)/);
  assert.match(fnSrc('stageSync'), /seaCover\(\);if\(SEA\.sel!==\(\(c&&cur\)\|\|null\)\)seaPick\(\(c&&cur\)\|\|null\)/, 'the cover first, so the camera aims beside the panel');
  assert.match(fnSrc('seaPick'), /if\(id&&!phoneUI\(\)\)seaLook\(id\)/);
  assert.match(fnSrc('openConv'), /STAGE\.min=false/);
  // hovering: a card lights its octopus (name tag, halo), an octopus lights its card
  assert.match(scripts['overview.js'], /\$\('ovBody'\)\.addEventListener\('pointerover',e=>\{if\(e\.pointerType!=='mouse'\)return;const c=e\.target\.closest\('\[data-oc\]'\);seaHi\(c\?c\.dataset\.oc:null\)\}\)/);
  assert.match(fnSrc('seaHover'), /SEA\.hover=hb;ovMark\(\)/);
  assert.match(fnSrc('ovMark'), /classList\.toggle\('hov',SEA\.hover===id\)/);
  assert.match(fnSrc('ovMark'), /classList\.toggle\('sel',SEA\.sel===id\)/);
  assert.match(fnSrc('seaTags'), /lb\.el\.classList\.toggle\('hl',hl\)/);
  assert.match(scripts['seabase.js'], /const hl=SEA\.hover===id\|\|SEA\.sel===id;e\.halo\.scale\.set\(hl\?4:2\.6/);
  // the picked octopus stands in a ring
  assert.match(fnSrc('seaInit'), /G\.ring=new T\.Mesh\(new T\.RingGeometry/);
  assert.match(fnSrc('seaFrame'), /const se=SEA\.sel&&G\.bots\[SEA\.sel\]/);
  // what needs you / failed glows in both: the beacon in 3D, the card's glow
  assert.match(fnSrc('ovCard'), /\$\{i\.bad\?' bad':''\}\$\{i\.need\?' ov-need':''\}/);
  assert.match(css, /\.ov-card\.ov-need::after,\.ov-card\.bad::after\{[^}]*animation:ovGlow/);
  assert.match(css, /\.ovwrap\.still \.ov-card::after/);
  // the card's state comes from the same model as the picture
  const info = new Function('SEA', 'apprWait', fnSrc('ovInfo') + '\n' + fnSrc('OV_PASS') + '\nreturn { ovInfo, OV_PASS };');
  const m = M.seaModel(state()), { ovInfo, OV_PASS } = info({ m }, id => id === 'e');
  const row = id => ({ id, failed: [], alert: null, routineErr: [], running: [], queued: 0, doneN: 0, done: [] });
  assert.deepEqual(ovInfo(row('e'), false), { need: true, bad: false, run: false, pod: 'hub', act: null, job: null, paused: false });
  assert.equal(ovInfo(row('d'), false).bad, true, 'its last run failed');
  assert.equal(ovInfo(row('a'), false).run, true); assert.equal(ovInfo(row('a'), false).pod, 'f1');
  assert.equal(ovInfo(row('g1'), true).need, true, 'a group card waiting for your 核准'); assert.equal(ovInfo(row('g1'), true).pod, 'f2');
  assert.ok(OV_PASS.need(row('e'), ovInfo(row('e'), false)) && !OV_PASS.need(row('a'), ovInfo(row('a'), false)));
  assert.ok(OV_PASS.done({ ...row('a'), doneN: 2 }) && !OV_PASS.done(row('a')));
});

// ---------- 4.10 深海基地就是主畫面 ----------
test('4.10 layout states: a chat open over the base, folded to its bar, none (the base with a hint), blank (welcome)', () => {
  const stageState = new Function(fnSrc('stageState') + '\n;return stageState')();
  assert.equal(stageState({ stage: true, conv: true, min: false, bots: true }), 'chat');
  assert.equal(stageState({ stage: true, conv: true, min: true, bots: true }), 'min');
  assert.equal(stageState({ stage: true, conv: false, min: true, bots: true }), 'none', 'no chat: nothing to fold');
  assert.equal(stageState({ stage: true, conv: false, bots: false }), 'blank', 'no bots yet: the welcome in the glass panel');
  assert.equal(stageState({ stage: true, conv: false, bots: true, tour: true }), 'blank', 'the tour');
  assert.equal(stageState({ stage: false, conv: true }), 'classic', 'narrow windows and 主畫面 3D 基地 off: the plain layout');
  // what each state shows
  const sync = fnSrc('stageSync');
  assert.match(sync, /app\.classList\.toggle\('stage',on\);app\.classList\.toggle\('chat-min',st==='min'\);app\.classList\.toggle\('stage-none',st==='none'\)/);
  assert.match(sync, /\$\('chatMin'\)\.hidden=st!=='min';\$\('stageHint'\)\.hidden=st!=='none'/);
  assert.match(css, /\.app\.stage\.chat-min \.chatp,\.app\.stage\.stage-none \.chatp\{display:none\}/);
  assert.match(css, /\.app\.stage #seaHostD\{display:block;position:absolute;inset:0\}/);
  assert.match(css, /\.app\.stage \.chatp\{position:absolute;left:14px;top:14px;bottom:14px;z-index:3;width:min\(var\(--chatw/);
  assert.match(css, /\.sea-host,\.stage-hint,\.chatmin,\.chat-grip,\.ib\.cmin,\.sea-head,\.lseg,\.lov\{display:none\}/, 'nothing of it in the plain layout');
  // the main screen from 1024 px with the setting on; folding and unfolding; the width is remembered
  assert.match(scripts['seabase.js'], /const stageMode=\(\)=>!phoneUI\(\)&&innerWidth>=1024&&seaEnabled\(\)/);
  assert.match(fnSrc('chatMinimise'), /STAGE\.min=!!on;stageSync\(\)/);
  assert.match(scripts['seabase.js'], /\$\('chatMinBtn'\)\.onclick=\(\)=>chatMinimise\(true\)/);
  assert.match(scripts['seabase.js'], /\$\('chatMinGo'\)\.onclick=\(\)=>chatMinimise\(false\)/);
  assert.match(scripts['seabase.js'], /store\.set\('octa_chatw',String\(w\)\)/);
  assert.match(scripts['seabase.js'], /const n=\+store\.get\('octa_chatw'\);if\(n>=340\)pane\.style\.setProperty\('--chatw',n\+'px'\)/);
  // how much of the stage it covers: from the panel itself (and a right panel floating over a 1024–1180 px window)
  const cov = fnSrc('seaCover');
  assert.match(cov, /l=p\.offsetLeft\+p\.offsetWidth\+8/); assert.match(cov, /getComputedStyle\(wp\)\.position==='fixed'\)r=wp\.offsetWidth/);
  assert.match(cov, /if\(a\.classList\.contains\('chat-min'\)\)b=\$\('chatMin'\)\.offsetHeight\+28/);
  // the docked browser still follows the 瀏覽器 tab (its rect is measured from the panel, whatever the layout)
  assert.match(fnSrc('dockSync'), /panelOn\(\)&&WP\.tab==='web'&&!phoneUI\(\)&&\$\('veil'\)\.hidden&&hasConv\(\)/);
  assert.match(fnSrc('dockSync'), /\$\('webStage'\)\.getBoundingClientRect\(\)/);
});

test('4.10 picking a bot moves the camera to it, aimed at the part of the stage beside the chat panel', () => {
  // the view is shifted by half the covered width: what the camera looks at lands in the middle of the free part
  const f = M.seaFrameOf({ w: 700, h: 800, left: 420 });
  assert.equal(f.ox, -210); assert.equal(f.cx, 560); assert.equal(700 / 2 - f.ox, f.cx, 'the stage centre moved by -ox');
  assert.ok(Math.abs(f.xl - 0.2) < 1e-9); assert.equal(f.xr, 1); assert.equal(f.cover, 0.6);
  const n = M.seaFrameOf({ w: 700, h: 800 }); assert.equal(n.ox, -0); assert.equal(n.cx, 350);
  const r = M.seaFrameOf({ w: 1000, h: 800, left: 400, right: 200 }); assert.equal(r.cx, 600); assert.equal(r.ox, -100);
  assert.ok(M.seaFrameOf({ w: 500, h: 800, left: 5000 }).cover <= 0.85, 'never all covered');
  // seaLook: the goal is the octopus; the narrower the free part, the further back the camera stays
  const look = new Function('SEA', '$', 'seaShown', 'seaDepth', 'ovMark', 'seaReduced', fnSrc('seaLook') + '\n;return seaLook');
  const mk = l => { const G = { goal: { th: 0, ph: .9, d: 60, tx: 0, tz: 0 }, view: { th: 0, ph: .9, d: 60, tx: 0, tz: 0 }, w: 700, h: 800, l, rr: 0, bots: { a: { pos: { x: 5, z: -3 } } }, loop: { kick() {} } };
    const SEA = { g: G, L: { rooms: { g1: { x: -8, z: 4 } } }, m: { bots: [{ id: 'a', pod: 'f1' }], rooms: [{ id: 'g1', pod: 'hub' }] }, focus: null };
    return { G, SEA, look: look(SEA, () => ({ hidden: true }), () => true, () => {}, () => {}, () => false) }; };
  const open = mk(420), wide = mk(0);
  open.look('a'); wide.look('a');
  assert.equal(open.G.goal.tx, 5); assert.equal(open.G.goal.tz, -3); assert.equal(open.SEA.focus, 'f1', 'into its module');
  assert.ok(open.G.goal.d > wide.G.goal.d, 'beside a chat panel the camera keeps more of the base in view');
  open.look('g1'); assert.equal(open.G.goal.tx, -8); assert.equal(open.SEA.focus, 'hub', 'a group: its meeting room');
  // every frame eases the shift (no jump when the panel opens, folds or is resized) and fits the whole base into the free part
  assert.match(fnSrc('seaFrame'), /G\.cam\.setViewOffset\(G\.w,G\.h,o\.x,o\.y,G\.w,G\.h\)/);
  assert.match(fnSrc('seaAim'), /G\.fr=seaFrameOf\(\{w:G\.w,h:G\.h,left:G\.l\|\|0,right:G\.rr\|\|0,top:0\}\)/);
  assert.match(fnSrc('seaFit'), /c\.setViewOffset\(W,H,fr\.ox,fr\.oy,W,H\)/);
  // names and bubbles never sit under the chat panel: moved out beside it, or not shown
  const tags = fnSrc('seaTags');
  assert.match(tags, /if\(!it\.pod&&\(it\.x<lf-36\|\|it\.x>rt\+36\)\)show=false/);
  assert.match(tags, /Math\.max\(lf\+w\/2\+4,Math\.min\(rt-w\/2-4,it\.x\)\)/);
  assert.match(tags, /if\(it\.pod&&\(it\.x-w\/2<lf\+4\|\|it\.x\+w\/2>rt-4\)\)show=false/);
});

test('4.10 render-rate policy: 30 while you watch, 10 when covered, typing or behind, nothing when hidden, 30 s behind or 省電', () => {
  const on = { on: true, gl: true, hidden: false, blurMs: 0, still: false, moving: false, covered: 0.3, typing: false, focused: true };
  assert.equal(M.seaRate(on), 30, 'focused, watching');
  assert.equal(M.seaRate({ ...on, typing: true }), 10, 'typing in the message box');
  assert.equal(M.seaRate({ ...on, covered: 0.7 }), 10, 'the chat covers most of the stage');
  assert.equal(M.seaRate({ ...on, covered: 0.6 }), 30);
  assert.equal(M.seaRate({ ...on, focused: false, blurMs: 5000 }), 10, 'the window is behind another');
  assert.equal(M.seaRate({ ...on, focused: false, blurMs: 31000 }), 0, 'behind for more than 30 s');
  assert.equal(M.seaRate({ ...on, hidden: true }), 0, 'hidden or minimised');
  assert.equal(M.seaRate({ ...on, hidden: true, moving: true }), 0);
  assert.equal(M.seaRate({ ...on, still: true }), 0, '省電模式 / reduced motion: a still picture');
  assert.equal(M.seaRate({ ...on, still: true, moving: true }), 30, 'still: only while the camera glides');
  assert.equal(M.seaRate({ ...on, on: false }), 0, '主畫面 3D 基地 off');
  assert.equal(M.seaRate({ ...on, gl: false }), 0, 'no WebGL');
  // the loop follows the rate every frame: 30 waits for the display, 10 sleeps between frames, 0 draws only what is asked for
  let q = [], id = 0, t = 0, timers = [], frames = 0, rate = 30;
  const raf = f => { q.push([++id, f]); return id; }, caf = x => { q = q.filter(([i]) => i !== x); };
  const later = (f, ms) => { timers.push({ f, at: t + ms }); return timers.length; }, clear = () => { timers = []; };
  const L = M.seaLoop({ raf, caf, later, clear, now: () => t, frame: () => frames++, hidden: () => false, rate: () => rate });
  const run = ms => { const end = t + ms; while (t < end) { t += 1000 / 60; const due = timers.filter(x => x.at <= t); timers = timers.filter(x => x.at > t); due.forEach(x => x.f()); const now = q; q = []; now.forEach(([, f]) => f()); } };
  L.start(); run(1000); assert.ok(frames >= 28 && frames <= 31, '30 a second (' + frames + ')');
  rate = 10; frames = 0; run(2000); assert.ok(frames >= 17 && frames <= 24, '10 a second (' + frames + ')');
  assert.ok(timers.length === 1 || q.length === 1, 'sleeping in between, not woken every display frame');
  rate = 0; run(200); frames = 0; run(2000); assert.equal(frames, 0, 'still');
  L.kick(); run(200); assert.equal(frames, 1, 'a change: one redraw');
  rate = 30; L.kick(); frames = 0; run(1000); assert.ok(frames >= 28, 'back to 30 once it is asked for');
  L.stop(); frames = 0; run(500); assert.equal(frames, 0);
  // what the page tells the policy, and the events that make it look again
  const now = fnSrc('seaRateNow');
  for (const k of ['hidden:document.hidden||!seaShown()', 'blurMs:SEA.blurAt?Date.now()-SEA.blurAt:0', 'still:seaStill()', 'covered:SEA.cover', 'typing:seaTyping()', 'focused:document.hasFocus()']) assert.ok(now.includes(k), k);
  const init = fnSrc('seaInit');
  assert.match(init, /addEventListener\('blur',\(\)=>\{SEA\.blurAt=Date\.now\(\);G\.loop\.kick\(\)\},sig\)/);
  assert.match(init, /addEventListener\('focus',\(\)=>\{SEA\.blurAt=0;G\.loop\.kick\(\)\},sig\)/);
  assert.match(init, /document\.addEventListener\('focusin',\(\)=>G\.loop\.kick\(\),sig\)/);
});

test('4.10 主畫面 3D 基地 off (or no WebGL): no WebGL context is made, the plain layout; turned on again: one scene', () => {
  const ens = new Function('SEA', 'seaEnabled', 'seaShown', 'seaHasGL', 'seaFallback', 'seaLib', 'seaInit', fnSrc('seaEnsure') + '\n;return seaEnsure');
  const run = (enabled, gl) => { const calls = []; const SEA = { booted: true, g: null, loading: false, gl: null, st: {} };
    ens(SEA, () => enabled, () => true, () => { calls.push('probe'); return gl; }, () => calls.push('fallback'), () => { calls.push('three'); return { then() { return { catch() {} }; } }; }, () => calls.push('init'))();
    return calls; };
  assert.deepEqual(run(false, true), [], 'off: not even the WebGL probe');
  assert.deepEqual(run(true, false), ['probe', 'fallback'], 'no WebGL: the still gradient, three.js not fetched');
  assert.deepEqual(run(true, true), ['probe', 'three']);
  assert.match(fnSrc('seaHasGL'), /getExtension\('WEBGL_lose_context'\)\?\.loseContext\(\)/, 'the probe lets its context go');
  assert.match(scripts['seabase.js'], /const seaEnabled=\(\)=>store\.get\('octa_stage3d'\)!=='0'/);
  assert.match(fnSrc('seaSet'), /store\.set\('octa_stage3d',on\?null:'0'\)/);
  assert.match(fnSrc('seaSet'), /if\(on\)seaEnsure\(\)/);
  // Settings → 外觀與語言
  const look = secSrc('look');
  assert.match(look, /id="pStage" \$\{seaEnabled\(\)\?'checked':''\}><span><b>主畫面 3D 基地<\/b>/);
  assert.match(look, /\$\('pStage'\)\.onchange=e=>seaSet\(e\.target\.checked\)/);
  // switching chats moves the camera only: the scene is made in seaInit (called from seaEnsure) and nowhere else
  assert.equal((js.match(/seaInit\(/g) || []).length, 2, 'declared once, called once');
  assert.doesNotMatch(fnSrc('seaPick') + fnSrc('seaOpenConv') + fnSrc('stageSync'), /seaInit|seaFree|seaBuild/);
});

test('4.10 the phone: the base folds into a strip above the list (nothing drawn then), 聊天 | 總覽, never in the chat screen', () => {
  const shown = new Function('SEA', '$', 'seaEnabled', 'phoneUI', 'seaFolded', 'stageMode', fnSrc('seaShown') + '\n;return seaShown');
  const el = (cls = [], hidden = false) => ({ hidden, classList: { contains: c => cls.includes(c) } });
  const at = (o) => shown({ st: { isConnected: true } }, id => id === 'app' ? el(o.app || []) : id === 'seaHead' ? el([], !!o.headHidden) : el(), () => true, () => true, () => !!o.folded, () => false)();
  assert.equal(at({}), true, 'the list screen, unfolded');
  assert.equal(at({ folded: true }), false, 'folded: not drawn');
  assert.equal(at({ app: ['chat'] }), false, 'the chat screen: no 3D');
  assert.equal(at({ app: ['wp-on'] }), false, 'the work page');
  assert.equal(at({ headHidden: true }), false, 'no header (no WebGL / turned off)');
  assert.match(scripts['seabase.js'], /const seaFolded=\(\)=>store\.get\('octa_seafold'\)==='1'/);
  assert.match(fnSrc('seaBoot'), /\$\('seaHeadBar'\)\.onclick=\(\)=>\{store\.set\('octa_seafold',seaFolded\(\)\?null:'1'\);stageSync\(\)/);
  assert.match(css, /\.sea-head\.folded #seaHostP\{display:none\}/);
  assert.match(fnSrc('seaPlace'), /host=phoneUI\(\)\?\$\('seaHostP'\):\$\('seaHostD'\)/, 'one stage, moved between the phone header and the main screen');
  assert.match(fnSrc('seaPlace'), /oh=phoneUI\(\)\?\$\('lov'\):\$\('wpOv'\)/, 'one set of cards too');
  // 聊天 | 總覽 (remembered), the badge on 總覽; tapping an octopus opens its chat
  assert.match(scripts['overview.js'], /const LSEG=\{k:store\.get\('octa_lseg'\)==='ov'\?'ov':'chat'\}/);
  assert.match(fnSrc('listSeg'), /store\.set\('octa_lseg'/);
  assert.match(fnSrc('ovBadge'), /\$\('lsegBadge'\)/);
  assert.match(css, /\.side\.seg-ov \.list\{display:none\}/);
  assert.match(css, /\.wp-tabs \[data-wt=ov\]\{display:none\}/, 'no 總覽 tab in the phone\'s work page');
  assert.match(fnSrc('openPanel'), /if\(phoneUI\(\)&&\(tab==='ov'\|\|!tab&&WP\.tab==='ov'\)\)tab='work'/);
});
