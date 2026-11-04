// 4.8.1 「登入是好的，但他們會一直看不到」: the bots' pages keep working whatever the person is looking at, and the
// bridge serves every later connection (each AI turn starts a new one) as well as the first.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { WAKE_COMMANDS, startCdpBridge } from '../desktop/cdp-bridge.mjs';
import { PAGE, onAnyScreen, parkSpot } from '../desktop/embed-layout.mjs';
import { googleWorkspacePage } from '../desktop/browser-catalog.mjs';

const { chromium } = createRequire(new URL('../desktop/package.json', import.meta.url))('playwright-core');
const main = readFileSync(new URL('../desktop/main.mjs', import.meta.url), 'utf8');

// a page debugger like Electron's: ONE per page, shared by every client. Runtime.enable reports the page's contexts
// only the first time (after that the domain is already on and Chromium says nothing).
function electronLike() {
  const pages = [{ id: 'page-1', title: 'Gmail', url: 'https://mail.example/' }];
  const commands = [];
  let emit = () => { }, gone = () => { }, added = () => { }, runtimeOn = false, ctx = 1, script = 0;
  const activated = [];
  const adapter = {
    commands, activated, pages,
    onEvent(cb) { emit = cb; },
    onTargetGone(cb) { gone = cb; },
    onTargetAdded(cb) { added = cb; },
    gone: id => { const i = pages.findIndex(p => p.id === id); if (i >= 0) pages.splice(i, 1); gone(id); },
    added: p => { pages.push(p); added(p); },
    list: () => pages.map(p => ({ ...p })),
    bounds: () => ({ windowId: 1, bounds: { left: 0, top: 0, width: 1280, height: 800, windowState: 'normal' } }),
    async command(targetId, method, params) {
      commands.push({ targetId, method, params });
      const page = pages.find(p => p.id === targetId);
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: targetId, loaderId: 'l1', url: page?.url || 'about:blank', mimeType: 'text/html' } } };
      if (method === 'Runtime.enable') {
        if (!runtimeOn) {
          runtimeOn = true;
          setTimeout(() => emit(targetId, 'Runtime.executionContextCreated', { context: { id: ctx, origin: page.url, name: '', auxData: { isDefault: true, type: 'default', frameId: targetId } } }), 10);
        }
        return {};
      }
      if (method === 'Runtime.disable') { runtimeOn = false; return {}; }
      if (method === 'Page.createIsolatedWorld') {
        const id = ++ctx;
        emit(targetId, 'Runtime.executionContextCreated', { context: { id, origin: page.url, name: params.worldName || '', auxData: { isDefault: false, type: 'isolated', frameId: params.frameId } } });
        return { executionContextId: id };
      }
      if (method === 'Runtime.evaluate') {
        if (String(params.expression || '').includes('UtilityScript')) return { result: { type: 'object', objectId: 'util-' + (params.contextId || 0), description: 'UtilityScript' } };
        return { result: { type: 'string', value: page?.url } };
      }
      if (method === 'Runtime.callFunctionOn') return { result: { type: 'string', value: page?.url } };
      if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 's' + (++script) };
      if (method.startsWith('Target.')) throw new Error('page debugger rejected ' + method);
      return {};
    },
    async createTarget(params) {
      const page = { id: 'page-' + (pages.length + 1), title: '', url: params.url || 'about:blank' };
      pages.push(page);
      return page;
    },
    async closeTarget(id) { const i = pages.findIndex(p => p.id === id); if (i >= 0) pages.splice(i, 1); },
    async activateTarget(id) { activated.push(id); }
  };
  return adapter;
}

async function client(port) {
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = () => no(new Error('ws')); });
  let n = 0; const wait = new Map(); const events = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id); } else events.push(m);
  };
  const send = (method, params = {}, sessionId) => new Promise((ok, no) => {
    const id = ++n;
    wait.set(id, m => (m.error ? no(new Error(m.error.message)) : ok(m.result)));
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    setTimeout(() => { if (wait.has(id)) { wait.delete(id); no(new Error('timeout ' + method)); } }, 3000);
  });
  return { ws, send, events };
}
const settle = ms => new Promise(r => setTimeout(r, ms));

test('a later connection (the next AI turn) still reads the page: its contexts are replayed', async () => {
  const ad = electronLike();
  const bridge = await startCdpBridge(ad);
  try {
    for (const turn of [1, 2, 3]) {
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${bridge.port}`, { timeout: 8000, noDefaults: true });
      const page = browser.contexts()[0].pages()[0];
      page.setDefaultTimeout(3000);
      assert.equal(await page.evaluate('location.href'), 'https://mail.example/', 'turn ' + turn);
      await browser.close();
      await settle(50);
    }
    // the page debugger was asked once; later turns did not turn the shared domain off
    assert.equal(ad.commands.filter(c => c.method === 'Runtime.disable').length, 0);
  } finally { await bridge.close(); }
});

test('raw: a second client gets executionContextCreated after Runtime.enable and the frame tree', async () => {
  const ad = electronLike();
  const bridge = await startCdpBridge(ad);
  try {
    const one = await client(bridge.port);
    const a = await one.send('Target.attachToTarget', { targetId: 'page-1', flatten: true });
    await one.send('Page.getFrameTree', {}, a.sessionId);
    await one.send('Runtime.enable', {}, a.sessionId);
    await settle(60);
    assert.equal(one.events.filter(e => e.method === 'Runtime.executionContextCreated').length, 1);
    one.ws.close();
    await settle(30);
    const two = await client(bridge.port);
    const b = await two.send('Target.attachToTarget', { targetId: 'page-1', flatten: true });
    await Promise.all([two.send('Page.getFrameTree', {}, b.sessionId), two.send('Runtime.enable', {}, b.sessionId)]);
    await settle(60);
    const got = two.events.filter(e => e.method === 'Runtime.executionContextCreated');
    assert.equal(got.length, 1);
    assert.equal(got[0].sessionId, b.sessionId);
    assert.equal(got[0].params.context.auxData.frameId, 'page-1');
    // a client turning Runtime off does not turn it off for the others
    await two.send('Runtime.disable', {}, b.sessionId);
    assert.equal(ad.commands.some(c => c.method === 'Runtime.disable'), false);
    two.ws.close();
  } finally { await bridge.close(); }
});

test('attaching wakes the page: focus emulation and an active lifecycle state', async () => {
  const ad = electronLike();
  const bridge = await startCdpBridge(ad);
  try {
    assert.deepEqual(WAKE_COMMANDS.map(([m]) => m), ['Emulation.setFocusEmulationEnabled', 'Page.setWebLifecycleState']);
    const c = await client(bridge.port);
    await c.send('Target.attachToTarget', { targetId: 'page-1', flatten: true });
    await settle(30);
    const sent = ad.commands.filter(x => x.targetId === 'page-1').map(x => x.method + ':' + JSON.stringify(x.params));
    assert.ok(sent.includes('Emulation.setFocusEmulationEnabled:{"enabled":true}'));
    assert.ok(sent.includes('Page.setWebLifecycleState:{"state":"active"}'));
    c.ws.close();
  } finally { await bridge.close(); }
});

test('switching tabs (bringToFront / activateTarget) keeps the connection and goes to the bridge, not the page debugger', async () => {
  const ad = electronLike();
  const bridge = await startCdpBridge(ad);
  try {
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${bridge.port}`, { timeout: 8000, noDefaults: true });
    const ctx = browser.contexts()[0];
    const first = ctx.pages()[0];
    const second = await ctx.newPage();
    await first.bringToFront();
    await second.bringToFront();
    assert.deepEqual(ad.activated, ['page-1', 'page-2']);
    assert.equal(ad.commands.some(c => c.method === 'Page.bringToFront'), false);
    assert.equal(browser.isConnected(), true);
    first.setDefaultTimeout(3000);
    assert.equal(await first.evaluate('location.href'), 'https://mail.example/');
    // a failing switch is answered, never a dropped connection
    ad.activateTarget = async () => { throw new Error('view gone'); };
    await first.bringToFront();
    assert.equal(browser.isConnected(), true);
    const raw = await client(bridge.port);
    await raw.send('Target.activateTarget', { targetId: 'page-2' });
    assert.ok((await fetch(`http://127.0.0.1:${bridge.port}/json/version`)).ok);
    raw.ws.close();
    await browser.close();
  } finally { await bridge.close(); }
});

test('closing a tab tells every client it detached (Playwright close() returns)', async () => {
  const ad = electronLike();
  const bridge = await startCdpBridge(ad);
  try {
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${bridge.port}`, { timeout: 8000, noDefaults: true });
    const ctx = browser.contexts()[0];
    const extra = await ctx.newPage();
    await Promise.race([extra.close(), settle(3000).then(() => { throw new Error('close() hung'); })]);
    assert.equal(ctx.pages().length, 1);
    // a tab the person (or OCTA) closed: the client hears about it as well
    const watcher = await client(bridge.port);
    await watcher.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    ad.added({ id: 'page-9', title: '', url: 'https://line.example/' });
    await settle(30);
    assert.ok(watcher.events.some(e => e.method === 'Target.attachedToTarget' && e.params.targetInfo.targetId === 'page-9'));
    ad.gone('page-9');
    await settle(30);
    assert.ok(watcher.events.some(e => e.method === 'Target.detachedFromTarget' && e.params.targetId === 'page-9'));
    assert.ok(watcher.events.some(e => e.method === 'Target.targetDestroyed' && e.params.targetId === 'page-9'));
    watcher.ws.close();
    await browser.close();
  } finally { await bridge.close(); }
});

test('a client that leaves takes back its scripts, bindings and request interception', async () => {
  const ad = electronLike();
  const bridge = await startCdpBridge(ad);
  try {
    const c = await client(bridge.port);
    const { sessionId } = await c.send('Target.attachToTarget', { targetId: 'page-1', flatten: true });
    const { identifier } = await c.send('Page.addScriptToEvaluateOnNewDocument', { source: '1' }, sessionId);
    await c.send('Runtime.addBinding', { name: '__pw' }, sessionId);
    await c.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] }, sessionId);
    c.ws.close();
    await settle(80);
    const m = ad.commands.map(x => x.method + ':' + JSON.stringify(x.params));
    assert.ok(m.includes(`Page.removeScriptToEvaluateOnNewDocument:${JSON.stringify({ identifier })}`));
    assert.ok(m.includes('Runtime.removeBinding:{"name":"__pw"}'));
    assert.ok(m.includes('Fetch.disable:{}'));
  } finally { await bridge.close(); }
});

test('a long message split into websocket fragments still arrives', async () => {
  const ad = electronLike();
  const bridge = await startCdpBridge(ad);
  try {
    const { connect } = await import('node:net');
    const sock = connect(bridge.port, '127.0.0.1');
    await new Promise(r => sock.once('connect', r));
    sock.write('GET /devtools/browser/octa HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
    let buf = '';
    sock.on('data', d => { buf += d.toString('latin1'); });
    await settle(50);
    const frame = (opcode, fin, text) => {
      const p = Buffer.from(text), mask = Buffer.from([1, 2, 3, 4]);
      const masked = Buffer.from(p.map((b, i) => b ^ mask[i & 3]));
      return Buffer.concat([Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | p.length]), mask, masked]);
    };
    const msg = JSON.stringify({ id: 7, method: 'Target.getTargets', params: {} });
    sock.write(frame(1, false, msg.slice(0, 10)));
    sock.write(frame(0, false, msg.slice(10, 20)));
    sock.write(frame(0, true, msg.slice(20)));
    await settle(80);
    assert.match(buf, /"id":7,"result":\{"targetInfos"/);
    sock.destroy();
  } finally { await bridge.close(); }
});

test('pages that are not on screen wait in shown windows past every screen, side by side', () => {
  const displays = [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }, { bounds: { x: -1280, y: -200, width: 1280, height: 1024 } }];
  const a = parkSpot(displays, PAGE, 0), b = parkSpot(displays, PAGE, 1);
  for (const s of [a, b]) assert.equal(onAnyScreen({ ...s, ...PAGE }, displays), false);
  assert.ok(b.x + PAGE.width <= a.x, 'the second page sits beside the first, not on it');
  assert.equal(onAnyScreen({ x: 100, y: 100, ...PAGE }, displays), true);
  assert.deepEqual(parkSpot([], PAGE, 0), { x: -PAGE.width - 400, y: -PAGE.height - 400 });
  // main.mjs: the waiting windows are shown (a hidden one does not draw), one per page, never throttled
  const host = main.slice(main.indexOf('function hostFor'), main.indexOf('function unhost'));
  assert.match(host, /showInactive|parkHost\(host\)/);
  assert.match(main, /function parkHost[\s\S]{0,600}showInactive\(\)/);
  assert.match(host, /backgroundThrottling: false/);
  assert.match(host, /skipTaskbar: true/);
  assert.match(host, /focusable: false/);
  assert.doesNotMatch(main, /setVisible\(false\)/);
  // OCTA's own window in the tray / minimised: its pages move to their waiting windows
  assert.match(main, /win\.on\('minimize'/);
  assert.match(main, /setAway\('hidden', true\)/);
  assert.match(main, /if \(!winDrawing\(\)\)[\s\S]{0,200}holdOffscreen/);
  // every page: no throttling and woken on attach; a lost debugger comes back
  assert.match(main, /setBackgroundThrottling\(false\)/);
  assert.match(main, /WAKE_COMMANDS/);
  assert.match(main, /debugger\.on\('detach'/);
  assert.match(main, /revive: embedRevive/);
});

test('Gmail, Drive, Docs… open in the bot\'s Chrome window, even when signed in here', () => {
  for (const u of ['https://mail.google.com/mail/u/0/#sent', 'https://gmail.com/', 'https://drive.google.com/drive/my-drive', 'https://docs.google.com/spreadsheets/d/1/edit', 'https://calendar.google.com/', 'https://search.google.com/search-console', 'https://business.google.com/'])
    assert.equal(googleWorkspacePage(u), true, u);
  for (const u of ['https://www.google.com/search?q=gmail', 'https://www.google.com/', 'https://example.com/?next=mail.google.com', 'https://mail.google.com.evil.test/', 'chrome://settings', 'not a url', 'https://www.youtube.com/'])
    assert.equal(googleWorkspacePage(u), false, u);
  assert.match(main, /googleWorkspacePage\(url\)/);
});
