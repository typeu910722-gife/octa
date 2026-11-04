// A localhost Chrome DevTools endpoint for one in-app Chromium page.
// Playwright and the runner speak browser-level CDP; Electron's debugger is page-level.
// This bridge is the browser, and it forwards page commands to the adapter.
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function encodeFrame(text, opcode = 0x81) {
  const payload = Buffer.from(text);
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([opcode, len]);
  else if (len < 65536) head = Buffer.from([opcode, 126, len >> 8, len & 255]);
  else {
    head = Buffer.alloc(10);
    head[0] = opcode; head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, payload]);
}

function createParser(onText, onControl) {
  let buf = Buffer.alloc(0), parts = null;
  return chunk => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const opcode = buf[0] & 0x0f, chunkFin = (buf[0] & 0x80) !== 0;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const maskLen = masked ? 4 : 0;
      if (buf.length < off + maskLen + len) return;
      let payload = buf.subarray(off + maskLen, off + maskLen + len);
      if (masked) {
        const mask = buf.subarray(off, off + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      }
      buf = buf.subarray(off + maskLen + len);
      const fin = chunkFin;
      if (opcode === 8) return 'close';
      if (opcode === 9) { onControl?.('pong', payload); continue; }
      if (opcode === 10) continue;
      // a long message can come in pieces (text frame without FIN, then continuation frames)
      if (opcode === 1 && !fin) { parts = [payload]; continue; }
      if (opcode === 0) {
        if (!parts) continue;
        parts.push(payload);
        if (!fin) continue;
        payload = Buffer.concat(parts); parts = null;
        onText(payload.toString('utf8'));
        continue;
      }
      if (opcode === 1) onText(payload.toString('utf8'));
    }
  };
}

// sent to a page whenever a client attaches to it or brings it to the front: the page acts as the focused, active tab
// even when OCTA's window is in the tray, folded away or showing another bot (no frozen loaders, no stalled waits)
export const WAKE_COMMANDS = [
  ['Emulation.setFocusEmulationEnabled', { enabled: true }],
  ['Page.setWebLifecycleState', { state: 'active' }]
];
// a client turning a domain off would turn it off for every other client of the same page debugger
const SHARED_DOMAINS_OFF = new Set(['Runtime.disable', 'Page.disable', 'Network.disable', 'Log.disable', 'DOM.disable', 'CSS.disable', 'Inspector.disable']);

export function startCdpBridge(adapter, port = 0) {
  const clients = new Set();
  const sessions = new Map();
  const told = new WeakMap(); // socket → Set of target ids it has already been given
  let seq = 0, autoAttach = false, waitDbg = false;
  // Electron gives each page ONE debugger, shared by every client. A domain one client turned on stays on after it
  // leaves, so the next client's Runtime.enable does nothing there and it never hears about the page's scripts: every
  // evaluate / snapshot then waits until it times out (4.8.1: 「瀏覽器連線一直逾時」 from the second AI turn on).
  // The bridge keeps the live contexts and replays them to each later client.
  const contexts = new Map();   // targetId → Map(context id → Runtime.executionContextCreated params)
  const runtimeOn = new Set();  // targets whose page debugger already has Runtime on
  const per = new WeakMap();    // socket → Map(targetId → what this client set up on that page)
  const flags = new WeakMap();  // socket → { discover, auto }
  const gone = new WeakSet();
  const woke = new Map();
  const stateOf = (socket, targetId) => {
    let m = per.get(socket);
    if (!m) per.set(socket, m = new Map());
    let st = m.get(targetId);
    if (!st) m.set(targetId, st = { tree: false, replay: false, scripts: new Set(), bindings: new Set(), fetch: false });
    return st;
  };
  const flagsOf = socket => { let f = flags.get(socket); if (!f) flags.set(socket, f = { discover: false, auto: false }); return f; };
  const quiet = p => Promise.resolve().then(p).catch(() => { });
  function wake(targetId, again) {
    if (!again && Date.now() - (woke.get(targetId) || 0) < 2000) return;
    woke.set(targetId, Date.now());
    for (const [method, params] of WAKE_COMMANDS) quiet(() => adapter.command(targetId, method, params));
  }
  async function activate(targetId) {
    // never let a slow or failing switch take the connection down: the client just gets its answer
    await Promise.race([quiet(() => adapter.activateTarget?.(targetId)), new Promise(r => setTimeout(r, 3000))]);
    wake(targetId, true);
  }
  // what the browser says it is: the page's own identity when the adapter knows it (never "Electron" or "OCTA")
  const version = () => { const v = adapter.version?.() || {}; return { product: v.product || 'Chrome/128.0.6613.186', userAgent: v.userAgent || 'OCTA' }; };
  const sendTo = (socket, obj) => { try { socket.write(encodeFrame(JSON.stringify(obj))); } catch { } };
  const sendAll = obj => { for (const socket of clients) sendTo(socket, obj); };
  const sessionFor = targetId => [...sessions].find(([, id]) => id === targetId)?.[0] || null;
  // each connection hears about a page once. the name tag connects first; the bot's browser tools connect
  // later and must still be told, or they see no page and cannot open anything
  function notify(t, sockets) {
    let sessionId = sessionFor(t.id);
    if (!sessionId) { sessionId = 's' + (++seq); sessions.set(sessionId, t.id); }
    const msg = { method: 'Target.attachedToTarget', params: { sessionId, targetInfo: { ...info(t), attached: true }, waitingForDebugger: waitDbg } };
    for (const socket of sockets) {
      if (!clients.has(socket)) continue;
      let seen = told.get(socket);
      if (!seen) told.set(socket, seen = new Set());
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      sendTo(socket, msg);
      wake(t.id);
    }
    return sessionId;
  }
  // a client left: take back what it put into the shared page debugger (its scripts for new documents, its bindings,
  // request interception), or the pages carry dead hooks and, with Fetch on, every request would wait for it forever
  function forget(socket) {
    if (gone.has(socket)) return;
    gone.add(socket);
    clients.delete(socket);
    const mine = per.get(socket);
    per.delete(socket);
    const others = [...clients];
    for (const [targetId, st] of mine || []) {
      for (const identifier of st.scripts) quiet(() => adapter.command(targetId, 'Page.removeScriptToEvaluateOnNewDocument', { identifier }));
      for (const name of st.bindings) if (!others.some(c => per.get(c)?.get(targetId)?.bindings.has(name))) quiet(() => adapter.command(targetId, 'Runtime.removeBinding', { name }));
      if (st.fetch && !others.some(c => per.get(c)?.get(targetId)?.fetch)) quiet(() => adapter.command(targetId, 'Fetch.disable', {}));
    }
    const seen = told.get(socket);
    told.delete(socket);
    if (!seen) return;
    for (const id of seen) {
      if (others.some(c => told.get(c)?.has(id))) continue;
      for (const [sid, tid] of [...sessions]) if (tid === id) sessions.delete(sid);
    }
  }
  // the page is gone (closed by a client, by the person, or by OCTA): every client that had it hears it detach,
  // or Playwright's close() waits forever and its tab list keeps a dead page
  function dropTarget(targetId, stillThere) {
    const sid = sessionFor(targetId);
    for (const c of clients) {
      const seen = told.get(c);
      if (seen?.has(targetId)) {
        seen.delete(targetId);
        if (sid) sendTo(c, { method: 'Target.detachedFromTarget', params: { sessionId: sid, targetId } });
      }
      per.get(c)?.delete(targetId);
    }
    for (const [s, id] of [...sessions]) if (id === targetId) sessions.delete(s);
    // a bot's last tab is not closed (it goes back to its start page): its page debugger keeps what it had
    if (!stillThere) { frames.delete(targetId); contexts.delete(targetId); runtimeOn.delete(targetId); woke.delete(targetId); }
    sendAll({ method: 'Target.targetDestroyed', params: { targetId } });
  }
  // a page that opened without a client asking (the person's new tab): clients that follow targets hear about it
  function announce(t) {
    if (!t?.id) return;
    for (const c of clients) if (flagsOf(c).discover) sendTo(c, { method: 'Target.targetCreated', params: { targetInfo: info(t) } });
    const auto = [...clients].filter(c => flagsOf(c).auto);
    if (auto.length) notify(t, auto);
  }
  adapter.onTargetAdded?.(t => { try { announce(t); } catch { } });
  adapter.onTargetGone?.(id => { try { dropTarget(id); } catch { } });
  // a client that turned Runtime on after another one did: give it the page's contexts once it has the frame tree
  function replay(socket, targetId, force) {
    const st = per.get(socket)?.get(targetId);
    if (!st || !st.replay || (!st.tree && !force) || !clients.has(socket)) return;
    st.replay = false;
    const sid = sessionFor(targetId);
    if (!sid) return;
    const list = [...(contexts.get(targetId)?.values() || [])].sort((a, b) => (a.context?.id || 0) - (b.context?.id || 0));
    for (const params of list) {
      let body;
      try { body = mapIds(structuredClone(params), id => mapOut(targetId, id)); } catch { body = params; }
      sendTo(socket, { method: 'Runtime.executionContextCreated', params: body, sessionId: sid });
    }
  }
  function keepContext(targetId, method, params) {
    if (method === 'Runtime.executionContextCreated' && params?.context?.id != null) {
      let m = contexts.get(targetId);
      if (!m) contexts.set(targetId, m = new Map());
      m.set(params.context.id, params);
    } else if (method === 'Runtime.executionContextDestroyed') contexts.get(targetId)?.delete(params?.executionContextId);
    else if (method === 'Runtime.executionContextsCleared') contexts.get(targetId)?.clear();
  }
  // Electron names the main frame with its own id. Playwright looks that frame up under the target
  // id, and anything else throws "Frame has been detached" before the address is even opened.
  const frames = new Map();
  const PRE_TREE = new Set(['Runtime.executionContextCreated', 'Runtime.executionContextDestroyed', 'Runtime.executionContextsCleared', 'Page.lifecycleEvent']);
  const track = targetId => {
    let s = frames.get(targetId);
    if (!s) frames.set(targetId, s = { main: null, children: new Set(), seenTree: false, pre: [], held: [] });
    return s;
  };
  const learnMain = (targetId, realId) => {
    if (!realId || realId === targetId) return false;
    const s = track(targetId);
    if (s.main === realId) return false;
    s.children.delete(realId);
    s.main = realId;
    return true;
  };
  const mapOut = (targetId, id) => (id && track(targetId).main === id ? targetId : id);
  const mapIn = (targetId, id) => (id === targetId && track(targetId).main ? track(targetId).main : id);
  const ID_KEYS = new Set(['frameId', 'parentFrameId', 'parentId']);
  function mapIds(node, fn, parentKey) {
    if (Array.isArray(node)) return node.map(item => mapIds(item, fn, parentKey));
    if (!node || typeof node !== 'object') return node;
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === 'string' && (ID_KEYS.has(k) || (k === 'id' && parentKey === 'frame'))) out[k] = fn(v);
      else if (v && typeof v === 'object') out[k] = mapIds(v, fn, k);
      else out[k] = v;
    }
    return out;
  }
  function absorbTree(targetId, node, isRoot) {
    const frame = node?.frame;
    if (!frame) return;
    const s = track(targetId);
    if (isRoot) learnMain(targetId, frame.id);
    else if (frame.id && frame.id !== s.main) s.children.add(frame.id);
    if (!isRoot && !frame.parentId) frame.parentId = s.main || targetId;
    frame.id = mapOut(targetId, frame.id);
    if (frame.parentId) frame.parentId = mapOut(targetId, frame.parentId);
    for (const child of node.childFrames || []) absorbTree(targetId, child, false);
  }
  function noteFrame(targetId, method, params) {
    const s = track(targetId);
    if (method === 'Page.frameNavigated' && params?.frame) {
      if (!params.frame.parentId) return learnMain(targetId, params.frame.id);
      if (params.frame.id) s.children.add(params.frame.id);
      return true;
    }
    if (method === 'Page.frameAttached') {
      if (!params?.parentFrameId) return learnMain(targetId, params?.frameId);
      if (params?.frameId) s.children.add(params.frameId);
      return true;
    }
    if (method === 'Page.frameDetached' && params?.frameId && params.frameId !== s.main) s.children.delete(params.frameId);
    return false;
  }
  function deliver(targetId, method, params) {
    const sessionId = sessionFor(targetId);
    if (!sessionId) {
      if (PRE_TREE.has(method)) track(targetId).pre.push({ method, params });
      return;
    }
    const learned = noteFrame(targetId, method, params);
    let body = params || {};
    try { body = mapIds(structuredClone(body), id => mapOut(targetId, id)); } catch { body = mapIds(body, id => mapOut(targetId, id)); }
    sendAll({ method, params: body, sessionId });
    if (learned) releaseHeld(targetId);
  }
  function holdContext(targetId, method, params) {
    if (method !== 'Runtime.executionContextCreated') return false;
    const id = params?.context?.auxData?.frameId;
    if (!id) return false;
    const s = track(targetId);
    if (id === s.main || id === targetId || s.children.has(id)) return false;
    s.held.push(params);
    return true;
  }
  function releaseHeld(targetId) {
    const s = track(targetId);
    const pending = s.held.splice(0);
    for (const params of pending) {
      const id = params?.context?.auxData?.frameId;
      if (id === s.main || s.children.has(id)) deliver(targetId, 'Runtime.executionContextCreated', params);
      else s.held.push(params);
    }
  }
  function flushPre(targetId) {
    const s = track(targetId);
    const queued = s.pre.splice(0);
    for (const ev of queued) {
      if (holdContext(targetId, ev.method, ev.params)) continue;
      deliver(targetId, ev.method, ev.params);
    }
  }
  adapter.onEvent?.((targetId, method, params) => {
    const raw = params || {};
    keepContext(targetId, method, raw);
    const s = track(targetId);
    if (!s.seenTree && PRE_TREE.has(method)) {
      s.pre.push({ method, params: raw });
      if (s.pre.length > 100) s.pre.shift();
      return;
    }
    if (s.seenTree && holdContext(targetId, method, raw)) return;
    deliver(targetId, method, raw);
  });
  // Playwright drops the whole connection (the tools then all report "Transport closed") unless every
  // page target carries a browserContextId, even when that context is the default one.
  const CONTEXT = 'octa';
  const info = t => ({ targetId: t.id, type: 'page', title: t.title || '', url: t.url || 'about:blank', attached: false, canAccessOpener: false, browserContextId: CONTEXT });
  async function browserCommand(method, params, socket) {
    if (method === 'Browser.getVersion') { const v = version(); return { protocolVersion: '1.3', product: v.product, revision: 'octa', userAgent: v.userAgent, jsVersion: '12.0' }; }
    if (method === 'Browser.getWindowForTarget') return adapter.bounds?.(params?.targetId) || { windowId: 1, bounds: { left: 0, top: 0, width: 1100, height: 800, windowState: 'normal' } };
    if (method === 'Browser.setWindowBounds') { await adapter.setBounds?.(params?.bounds || {}); return {}; }
    if (method === 'Browser.close') { await adapter.close?.(); return {}; }
    if (method === 'Browser.setDownloadBehavior' || method === 'Browser.grantPermissions' || method === 'Browser.resetPermissions') return {};
    if (method === 'Storage.getCookies' || method === 'Storage.setCookies') {
      const page = adapter.list()[0];
      if (!page) return method === 'Storage.getCookies' ? { cookies: [] } : {};
      return await adapter.command(page.id, method, params || {}) || {};
    }
    if (method === 'Target.getTargets' || method === 'Target.getTargetInfo') {
      const list = adapter.list();
      if (method === 'Target.getTargetInfo') return { targetInfo: info(list.find(t => t.id === params.targetId) || list[0]) };
      return { targetInfos: list.map(info) };
    }
    if (method === 'Target.setDiscoverTargets') {
      flagsOf(socket).discover = !!params?.discover;
      if (params?.discover) for (const t of adapter.list()) sendAll({ method: 'Target.targetCreated', params: { targetInfo: info(t) } });
      return {};
    }
    if (method === 'Target.setAutoAttach') {
      flagsOf(socket).auto = !!params?.autoAttach;
      autoAttach = !!params?.autoAttach;
      waitDbg = !!params?.waitForDebuggerOnStart;
      if (autoAttach) for (const t of adapter.list()) notify(t, [socket]);
      return {};
    }
    if (method === 'Target.attachToTarget') {
      const t = adapter.list().find(x => x.id === params.targetId) || { id: params.targetId, title: '', url: 'about:blank' };
      return { sessionId: notify(t, [socket]) };
    }
    if (method === 'Target.detachFromTarget') {
      const tid = params?.targetId || (params?.sessionId && sessions.get(params.sessionId));
      if (tid) told.get(socket)?.delete(tid);
      if (tid && ![...clients].some(c => told.get(c)?.has(tid))) { for (const [sid, id] of [...sessions]) if (id === tid) sessions.delete(sid); }
      return {};
    }
    if (method === 'Target.activateTarget') { await activate(params?.targetId); return {}; }
    if (method === 'Target.createTarget') {
      const created = await adapter.createTarget(params || {});
      if (!sessionFor(created.id)) sendAll({ method: 'Target.targetCreated', params: { targetInfo: info(created) } });
      notify(created, [...new Set([socket, ...[...clients].filter(c => flagsOf(c).auto)])]);
      return { targetId: created.id };
    }
    if (method === 'Target.closeTarget') {
      await quiet(() => adapter.closeTarget?.(params.targetId));
      dropTarget(params.targetId, adapter.list().some(t => t.id === params.targetId));
      return { success: true };
    }
    const err = new Error('OCTA 瀏覽器沒有這個指令：' + method);
    err.expose = true;
    throw err;
  }
  async function onMessage(text, socket) {
    let msg; try { msg = JSON.parse(text); } catch { return; }
    const reply = (extra) => { try { socket.write(encodeFrame(JSON.stringify({ id: msg.id, ...extra, ...(msg.sessionId ? { sessionId: msg.sessionId } : {}) }))); } catch { } };
    try {
      if (msg.sessionId) {
        if (msg.method === 'Runtime.runIfWaitingForDebugger') { reply({ result: {} }); return; }
        // these are browser-target commands; a page debugger rejects them and Playwright then abandons the page
        if (msg.method === 'Target.setAutoAttach' || msg.method === 'Target.setDiscoverTargets') { reply({ result: {} }); return; }
        const targetId = sessions.get(msg.sessionId);
        if (!targetId) throw new Error('分頁連線已結束');
        // switching tabs is the bridge's job: the page debugger cannot bring a view to the front
        if (msg.method === 'Page.bringToFront') { await activate(targetId); reply({ result: {} }); return; }
        if (SHARED_DOMAINS_OFF.has(msg.method)) { reply({ result: {} }); return; }
        const st = stateOf(socket, targetId);
        if (msg.method === 'Fetch.disable' && [...clients].some(c => c !== socket && per.get(c)?.get(targetId)?.fetch)) { st.fetch = false; reply({ result: {} }); return; }
        const sent = mapIds(msg.params || {}, id => mapIn(targetId, id));
        const wasOn = runtimeOn.has(targetId);
        let out = await adapter.command(targetId, msg.method, sent) || {};
        if (msg.method === 'Runtime.enable') {
          runtimeOn.add(targetId);
          if (wasOn) { st.replay = true; setTimeout(() => replay(socket, targetId, true), 1000); }
        } else if (msg.method === 'Page.addScriptToEvaluateOnNewDocument' && out.identifier) st.scripts.add(out.identifier);
        else if (msg.method === 'Page.removeScriptToEvaluateOnNewDocument') st.scripts.delete(sent.identifier);
        else if (msg.method === 'Runtime.addBinding' && sent.name) st.bindings.add(sent.name);
        else if (msg.method === 'Fetch.enable') st.fetch = true;
        else if (msg.method === 'Fetch.disable') st.fetch = false;
        else if (msg.method === 'Page.getFrameTree') st.tree = true;
        try { out = structuredClone(out); } catch { /* already a plain result */ }
        if (msg.method === 'Page.getFrameTree' && out.frameTree) absorbTree(targetId, out.frameTree, true);
        else if (msg.method === 'Page.navigate' && typeof out.frameId === 'string') {
          if (!sent.frameId || sent.frameId === track(targetId).main) learnMain(targetId, out.frameId);
          out.frameId = mapOut(targetId, out.frameId);
        } else out = mapIds(out, id => mapOut(targetId, id));
        if (msg.method === 'Page.getFrameTree') track(targetId).seenTree = true;
        reply({ result: out });
        // the context can arrive before the frame tree. hold it until Playwright has read the tree
        // and attached its listeners, or the read of the page waits until it times out
        if (msg.method === 'Page.getFrameTree') setTimeout(() => flushPre(targetId), 0);
        if (msg.method === 'Page.getFrameTree' || msg.method === 'Runtime.enable') setTimeout(() => replay(socket, targetId), 0);
        releaseHeld(targetId);
      } else reply({ result: await browserCommand(msg.method, msg.params || {}, socket) || {} });
    } catch (e) { reply({ error: { code: -32000, message: String(e.message || e) } }); }
  }
  const server = createServer((req, res) => {
    const path = (req.url || '').split('?')[0].replace(/\/+$/, '') || '/';
    const list = () => adapter.list().map(t => ({ id: t.id, type: 'page', title: t.title || '', url: t.url || 'about:blank', webSocketDebuggerUrl: `ws://127.0.0.1:${bound}/devtools/page/${t.id}` }));
    let body = null;
    if (path === '/json/version') body = { Browser: version().product, 'Protocol-Version': '1.3', 'User-Agent': version().userAgent, 'V8-Version': '12.0', 'WebKit-Version': '537.36', webSocketDebuggerUrl: `ws://127.0.0.1:${bound}/devtools/browser/octa` };
    else if (path === '/json/list' || path === '/json') body = list();
    res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' });
    res.end(body ? JSON.stringify(body) : '{}');
  });
  let bound = port;
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }
    const accept = createHash('sha1').update(key + GUID).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    clients.add(socket);
    const feed = createParser(text => onMessage(text, socket), (kind, payload) => {
      if (kind === 'pong') { try { socket.write(encodeFrame(payload, 0x8a)); } catch { } }
    });
    socket.on('data', chunk => { if (feed(chunk) === 'close') { forget(socket); try { socket.end(); } catch { } } });
    socket.on('close', () => forget(socket));
    socket.on('error', () => { forget(socket); try { socket.destroy(); } catch { } });
  });
  return new Promise((ok, no) => {
    server.once('error', no);
    server.listen(port, '127.0.0.1', () => {
      bound = server.address().port;
      ok({
        port: bound,
        close: () => new Promise(done => { for (const s of clients) { try { s.destroy(); } catch { } } server.close(() => done()); })
      });
    });
  });
}
