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
    const dead = async () => new Response('<html>Error 1033</html>', { status: 530 });
    const alive = async () => new Response('ok', { headers: { 'x-octa-host': 'abc' } });
    assert.equal(await srv.tunnelCheck(alive), true);
    assert.equal(await srv.tunnelCheck(dead), false);
    assert.equal(srv.tunnelUrl(), first, 'one miss is not enough');
    assert.equal(await srv.tunnelCheck(dead), false);
    assert.notEqual(srv.tunnelUrl(), first, 'a new tunnel was started');
    assert.match(srv.tunnelUrl(), /trycloudflare/);
  } finally { await srv.close?.(); rmSync(dir, { recursive: true, force: true }); }
});
