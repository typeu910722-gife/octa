import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkBase, joinBase, normalizeCustom, publicConnectors, runConnector, takeConnectorTask } from '../public/connectors.mjs';
import { keepBrowserTask } from '../public/octa-runner.mjs';

test('a connector call is parsed, and a private address is refused', () => {
  const task = takeConnectorTask('【連接器】\n名稱：訂單\n動作：讀取\n路徑：/orders?day=1\n【接完】');
  assert.equal(task.name, '訂單');
  assert.equal(task.action, '讀取');
  assert.equal(task.path, '/orders?day=1');
  assert.equal(takeConnectorTask('沒有'), null);
  assert.equal(checkBase('https://api.example.com/v1'), '');
  assert.ok(checkBase('http://api.example.com'));
  assert.ok(checkBase('https://127.0.0.1/a'));
  assert.ok(checkBase('https://192.168.1.9/a'));
  assert.ok(checkBase('https://169.254.169.254/'));
  assert.equal(joinBase('https://api.example.com/v1', '/orders?day=1').href, 'https://api.example.com/v1/orders?day=1');
  assert.equal(normalizeCustom({ name: 'Telegram', base: 'https://api.example.com', secret: 'x' }, []).error.includes('內建'), true);
});

test('a read sends the secret and the result hides it; a send waits for approval', async () => {
  const st = {
    tg: { token: 'tg-secret-token', chat: '9' },
    connectors: [{ name: '訂單', base: 'https://api.example.com/v1', header: 'X-Key', secret: 'super-secret-key' }]
  };
  assert.deepEqual(publicConnectors(st).map(c => c.name), ['Telegram', '訂單']);
  let called = false;
  const held = await runConnector(st, { name: 'Telegram', action: '送出', content: 'hi' }, { approved: false, fetchImpl: () => { called = true; } });
  assert.equal(called, false);
  assert.match(held.text, /沒有送出/);
  assert.equal(held.text.includes('tg-secret-token'), false);
  const read = await runConnector(st, { name: '訂單', action: '讀取', path: '/orders?day=1' }, {
    fetchImpl: async (url, init) => {
      assert.equal(String(url), 'https://api.example.com/v1/orders?day=1');
      assert.equal(init.method, 'GET');
      assert.equal(init.headers['X-Key'], 'super-secret-key');
      assert.equal(init.redirect, 'manual');
      return { ok: true, status: 200, text: async () => 'order super-secret-key' };
    }
  });
  assert.equal(read.ok, true);
  assert.match(read.text, /200/);
  assert.match(read.text, /已隱藏/);
  assert.equal(read.text.includes('super-secret-key'), false);
  const kept = keepBrowserTask('【連接器】\n名稱：訂單\n動作：讀取\n路徑：/orders\n【接完】\n【回覆】\n好了');
  assert.match(kept, /【連接器】/);
  assert.match(kept, /好了/);
});
