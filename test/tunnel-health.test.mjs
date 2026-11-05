import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { startServer } from '../desktop/server.mjs';

test('a tunnel that stops answering (Cloudflare 1033) is replaced after two missed checks', async () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'octa-tun-'));
  let n = 0;
  const srv = await startServer({ dataDir: dir, runner: false, watchMs: 3600000, tunnel: async () => `https://t${++n}.trycloudflare.com` });
  try {
    await srv.desktopApi('remote', { on: true });
    const first = srv.tunnelUrl();
    assert.match(first, /^https:\/\/t\d\.trycloudflare\.com$/);
    const dead = async () => new Response('<html>Error 1033 Cloudflare Tunnel error</html>', { status: 530 });
    const alive = async () => new Response('ok', { headers: { 'x-octa-host': 'abc' } });
    const offline = async () => { throw new TypeError('fetch failed: getaddrinfo ENOTFOUND'); };
    const t0 = Date.now(), later = { now: t0 + 10 * 60000 };
    assert.equal(await srv.tunnelCheck(dead, { now: t0 }), true, 'a brand-new tunnel gets a few minutes');
    assert.equal(await srv.tunnelCheck(alive, later), true);
    for (let i = 0; i < 5; i++) assert.equal(await srv.tunnelCheck(offline, later), true, 'our own DNS or network failing never replaces the tunnel');
    assert.equal(srv.tunnelUrl(), first);
    assert.equal(await srv.tunnelCheck(dead, later), false);
    assert.equal(await srv.tunnelCheck(dead, later), false);
    assert.equal(srv.tunnelUrl(), first, 'two misses are not enough');
    assert.equal(await srv.tunnelCheck(dead, later), false);
    assert.notEqual(srv.tunnelUrl(), first, 'Cloudflare saying 1033 three times starts a new tunnel');
    assert.match(srv.tunnelUrl(), /trycloudflare/);
  } finally { await srv.close?.(); rmSync(dir, { recursive: true, force: true }); }
});
