// 4.8.1 watchdog: before a job (and when its port disappears mid-job) the runner checks that the bot's browser and its
// page answer, fixes it by itself, and only then gives up with a clear kind (「瀏覽器沒有回應」).
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startCdpBridge } from '../desktop/cdp-bridge.mjs';
import { FAIL_KINDS, classifyJobFailure } from '../desktop/lib/model-route.mjs';
import { browsers, browserHealth, closeAllBrowsers, ensureHealthy, CHROME_AWAKE } from '../desktop/runner/browser.mjs';
import { configure } from '../desktop/runner/state.mjs';

const src = p => readFileSync(new URL('../desktop/' + p, import.meta.url), 'utf8');

function page(state) {
  return {
    list: () => [{ id: 'p1', title: 'Inbox', url: 'https://mail.example/' }],
    async command(_t, method) {
      if (method === 'Page.captureScreenshot' && state.stuck) return new Promise(() => { });   // a page that does not draw
      if (method === 'Page.captureScreenshot') return { data: '' };
      if (method === 'Runtime.evaluate') return { result: { type: 'string', value: 'complete' } };
      return {};
    },
    async createTarget() { return { id: 'p1' }; },
    close: async () => { }
  };
}
const freePort = () => new Promise(ok => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });

test('health: a browser that answers, one whose page is stuck, one that is gone', async () => {
  const st = { stuck: false };
  const bridge = await startCdpBridge(page(st));
  try {
    assert.equal((await browserHealth(bridge.port)).ok, true);
    st.stuck = true;
    const t0 = Date.now();
    const h = await browserHealth(bridge.port, 1500);
    assert.equal(h.ok, false);
    assert.equal(h.why, 'stuck');
    assert.ok(Date.now() - t0 < 4000, 'a stuck page is noticed in seconds, not after the AI tool timeout');
  } finally { await bridge.close(); }
  assert.deepEqual(await browserHealth(await freePort()), { ok: false, why: 'down' });
});

test('recovery: revive first; if the page is still stuck, start the bot\'s browser over on its own port; else a clear kind', async () => {
  const home = mkdtempSync(join(tmpdir(), 'octa-dog-'));
  mkdirSync(join(home, 'work'), { recursive: true });
  const bot = { id: 'bot-dog', name: '看門狗' };
  const embedPort = await freePort();
  writeFileSync(join(home, 'work', 'embed-ports.json'), JSON.stringify({ [bot.id]: embedPort }));
  const st = { stuck: true };
  let live = await startCdpBridge(page(st), embedPort);
  const calls = [];
  const embed = {
    external: () => false,
    revive: async () => { calls.push('revive'); return true; },
    stop: async () => { calls.push('stop'); await live?.close(); live = null; },
    start: async (_b, port) => { calls.push('start'); st.stuck = false; live = await startCdpBridge(page(st), port); },
    show: async () => { }
  };
  configure({ url: 'http://127.0.0.1:1', home, embed, log: () => { } });
  try {
    // 1. revive fixes it
    browsers.set(bot.id, { port: embedPort, embed: true });
    embed.revive = async () => { calls.push('revive'); st.stuck = false; return true; };
    assert.equal(await ensureHealthy(bot, embedPort), embedPort);
    assert.deepEqual(calls, ['revive']);
    // 2. revive does not: the embedded browser is started over (same port, so the AI's tools reconnect by themselves)
    calls.length = 0; st.stuck = true;
    embed.revive = async () => { calls.push('revive'); return true; };
    assert.equal(await ensureHealthy(bot, embedPort), embedPort);
    assert.deepEqual(calls, ['revive', 'stop', 'start']);
    // 3. nothing helps: an error with kind 'browser'
    calls.length = 0; st.stuck = true;
    embed.start = async (_b, port) => { calls.push('start'); live = await startCdpBridge(page(st), port); };
    await assert.rejects(ensureHealthy(bot, embedPort), e => e.kind === 'browser' && /瀏覽器沒有回應/.test(e.message));
  } finally {
    await closeAllBrowsers().catch(() => { });
    await live?.close();
  }
});

test('「瀏覽器沒有回應」 is its own failure kind, retried automatically', () => {
  assert.equal(FAIL_KINDS.browser.label, '瀏覽器沒有回應');
  assert.equal(FAIL_KINDS.browser.retry, true);
  for (const t of ['現在回報「連不上 127.0.0.1:9334」', '瀏覽器連線一直逾時（連兩次都是 30 秒沒回應）', 'browserType.connectOverCDP: connect ECONNREFUSED 127.0.0.1:19011', '⚠ 沒做成：瀏覽器沒有回應'])
    assert.equal(classifyJobFailure(t), 'browser', t);
  assert.equal(classifyJobFailure('net::ERR_CONNECTION_REFUSED'), 'tool_error');
  assert.equal(classifyJobFailure('x', { hint: 'browser' }), 'browser');
  assert.match(src('../app/js/pure.js'), /browser:'瀏覽器沒有回應'/);
  assert.match(src('../app/js/settings.js'), /browser:\['瀏覽器沒有回應'/);
});

test('the runner checks the browser before the AI starts, watches it during the turn, and follows a move to Chrome', () => {
  const chat = src('runner/chat.mjs');
  const pre = chat.slice(chat.indexOf('async function chatRun'), chat.indexOf('restoreSkills('));
  assert.match(pre, /ensureHealthy\(job\.bot, port\)/);
  assert.match(pre, /job\.browserDown = e\.message/);
  assert.match(chat, /const dog = port \? setInterval/);
  assert.match(chat, /clearInterval\(dog\)/);
  assert.match(chat, /moving\.set\(job\.bot\.id/);
  assert.match(chat, /moving\.delete\(job\.bot\.id\)/);
  assert.match(chat, /b = botDir\(job\.bot\.id, job\.bot\.browser, to\)/);
  assert.match(chat, /MOVED_PROMPT/);
  assert.match(chat, /err_kind: 'browser'/);
  assert.match(src('runner/prompts.mjs'), /job\.browserNote/);
  const google = src('runner/google.mjs');
  assert.match(google, /googleSignInUrl\(url\) \|\| \(googleWorkspacePage\(url\) \? url : ''\)/);
  assert.match(google, /moving\.get\(botId\)\?\.\(port\)/);
  // a restart of the runner (after sleep, or a stuck poll) leaves the bots' browsers open
  assert.match(src('runner/loop.mjs'), /if \(!opts\.keepBrowsers\) reapBrowsers\(true\)/);
  assert.match(src('main.mjs'), /stopRunner\(\{ keepBrowsers: true \}\)/);
  // a bot's Chrome window keeps drawing behind other windows
  assert.ok(CHROME_AWAKE.includes('--disable-backgrounding-occluded-windows'));
  assert.ok(CHROME_AWAKE.includes('--disable-renderer-backgrounding'));
  assert.match(src('runner/browser.mjs'), /\.\.\.CHROME_AWAKE/);
});
