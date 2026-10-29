// The way back from the Chrome window, end to end in the runner: a fake Chrome (CDP on the bot's port),
// a fake in-app browser (the desktop's embed API) and a fake server that records the chat lines.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { startCdpBridge } from '../desktop/cdp-bridge.mjs';
import { closeAllBrowsers, ensureBrowser, returnToEmbed, startRunner } from '../public/octa-runner.mjs';

const BOT = { id: 'b1', name: '映日所', browser: 'own' };
const NOW = Date.now() / 1000;
const g = (name, value, domain = '.google.com') => ({ name, value, domain, path: '/', secure: true, httpOnly: true, expires: NOW + 86400 * 200, sameSite: 'None' });
const pause = ms => new Promise(r => setTimeout(r, ms));
const notes = [];
let home, api, runner;

// a Chrome window on the bot's port (9311: the first port the runner hands out in a new work folder)
let lastChrome = null;
async function fakeChrome(cookies, url = 'https://www.instagram.com/') {
  for (let i = 0; i < 40 && lastChrome && !lastChrome.gone; i++) await pause(50);   // the previous window has fully closed
  const state = { cookies, closed: false, bridge: null };
  const pages = [{ id: 'c1', title: 'Instagram', url }];
  state.bridge = await startCdpBridge({
    list: () => pages,
    bounds: () => ({ windowId: 1, bounds: { left: 10, top: 10, width: 1200, height: 800, windowState: 'normal' } }),
    async command(_t, method) { return method === 'Storage.getCookies' ? { cookies: state.cookies } : {}; },
    async createTarget(p) { const page = { id: 'c' + (pages.length + 1), title: '', url: p.url || 'about:blank' }; pages.push(page); return page; },
    async closeTarget() { },
    close: async () => { state.closed = true; setTimeout(() => state.bridge.close().then(() => { state.gone = true; }), 50); }
  }, 9311);
  lastChrome = state;
  return state;
}
// the desktop's side: realChrome flag, the in-app browser and the cookies set into it
function fakeEmbed() {
  const e = { external: new Set(), stay: new Set(), set: [], started: 0, used: [], bridge: null, onGoogle: null };
  return Object.assign(e, {
    api: {
      external: id => e.external.has(id),
      autoBack: id => e.external.has(id) && !e.stay.has(id),
      useEmbedded: id => { e.used.push(id); e.external.delete(id); return true; },
      async start(_bot, port) {
        e.started++;
        const pages = [{ id: 'p1', title: '', url: 'https://www.google.com/' }];
        e.bridge = await startCdpBridge({
          list: () => pages,
          bounds: () => ({ windowId: 1, bounds: { left: 0, top: 0, width: 900, height: 700, windowState: 'normal' } }),
          async command(_t, method, params) { if (method === 'Storage.setCookies') e.set.push(...params.cookies); return method === 'Storage.getCookies' ? { cookies: [] } : {}; },
          async createTarget(p) { const page = { id: 'p' + (pages.length + 1), title: '', url: p.url }; pages.push(page); return page; },
          async closeTarget() { }
        }, port);
      },
      async show() { },
      async stop() { try { await e.bridge?.close(); } catch { } e.bridge = null; },
      get onGoogle() { return e.onGoogle; },
      set onGoogle(f) { e.onGoogle = f; }
    }
  });
}
const embed = fakeEmbed();

before(async () => {
  home = mkdtempSync(join(tmpdir(), 'octa-back-'));
  api = createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      if (req.url === '/api/runner/note') notes.push(JSON.parse(body || '{}'));
      res.setHeader('content-type', 'application/json');
      // the work loop: nothing to do, ask again later
      if (req.url.startsWith('/api/runner/next')) setTimeout(() => res.end('{"job":null}'), 300);
      else res.end('{"ok":true}');
    });
  }).listen(0, '127.0.0.1');
  await new Promise(r => api.once('listening', r));
  runner = startRunner({ url: `http://127.0.0.1:${api.address().port}`, token: '', home, pwCli: 'none', embed: embed.api, log: () => { } });
});
after(async () => {
  runner?.stop();
  await closeAllBrowsers().catch(() => { });
  await embed.api.stop();
  api.close();
  rmSync(home, { recursive: true, force: true });
});

test('a bot whose Chrome window is already signed in to Google comes back into OCTA with every sign-in', async () => {
  const chrome = await fakeChrome([g('SID', 'old'), g('__Secure-1PSID', 'p-old'), g('sessionid', 'ig', '.instagram.com')]);
  embed.external.add(BOT.id);
  const port = await ensureBrowser(BOT);
  assert.equal(port, 19011, 'the in-app browser, not the Chrome window');
  assert.deepEqual(embed.used, [BOT.id]);
  assert.equal(chrome.closed, true, 'the Chrome window is closed');
  const names = embed.set.map(c => c.name);
  for (const n of ['SID', '__Secure-1PSID', 'sessionid']) assert.ok(names.includes(n), n + ' brought over');
  assert.ok(embed.set.find(c => c.name === 'SID').domain === '.google.com');
  assert.ok(notes.some(n => n.bot === BOT.id && /已改回 OCTA 內建（帶入 3 筆網站登入）/.test(n.text)));
});

test('refused again: Chrome window plus a chat line, and a new sign-in there brings it back by itself', async () => {
  embed.set.length = 0; notes.length = 0; embed.used.length = 0;
  const chrome = await fakeChrome([g('SID', 'old'), g('__Secure-1PSID', 'p-old')], 'https://accounts.google.com/v3/signin/identifier');
  embed.external.add(BOT.id);   // what desktop googleBlocked() records before calling onGoogle
  assert.equal(typeof embed.onGoogle, 'function');
  assert.equal(await embed.onGoogle(BOT.id, 'https://accounts.google.com/v3/signin/rejected?continue=https%3A%2F%2Fmail.google.com%2F', { again: true }), true);
  assert.equal(embed.bridge, null, 'the in-app browser was stopped');
  assert.ok(notes.some(n => /Google 又擋下內建瀏覽器的登入/.test(n.text) && /自動改回/.test(n.text)));
  // the sign-in it already had does not count
  await pause(4600);
  assert.deepEqual(embed.used, []);
  assert.equal(chrome.closed, false);
  // the person signs in in the Chrome window
  chrome.cookies = [g('SID', 'new'), g('__Secure-1PSID', 'p-new'), g('NID', 'n')];
  for (let i = 0; i < 30 && !embed.used.length; i++) await pause(300);
  for (let i = 0; i < 20 && !embed.set.length; i++) await pause(100);
  assert.deepEqual(embed.used, [BOT.id]);
  assert.equal(chrome.closed, true);
  assert.equal(embed.set.find(c => c.name === 'SID')?.value, 'new');
  assert.ok(notes.some(n => /已在 Chrome 視窗登入 Google/.test(n.text)));
});

test('refused right after coming back: stays in the Chrome window until switched back by hand', async () => {
  notes.length = 0; embed.used.length = 0; embed.set.length = 0;
  const chrome = await fakeChrome([g('SID', 'new')]);
  embed.external.add(BOT.id); embed.stay.add(BOT.id);
  await embed.onGoogle(BOT.id, 'https://accounts.google.com/signin/rejected', { again: true, stay: true });
  assert.ok(notes.some(n => /先固定用 Chrome 視窗/.test(n.text)));
  chrome.cookies = [g('SID', 'newer')];
  await pause(4600);
  assert.deepEqual(embed.used, [], 'no automatic way back');
  const r = await returnToEmbed({ id: BOT.id, name: BOT.name }, { manual: true });
  assert.equal(r.ok, true);
  assert.equal(r.google, true);
  assert.deepEqual(embed.used, [BOT.id]);
  assert.equal(chrome.closed, true);
  assert.equal(embed.set.find(c => c.name === 'SID')?.value, 'newer');
});
