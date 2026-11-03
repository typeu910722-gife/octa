// 4.5 清除這台電腦的 OCTA 資料: the backup, what is deleted and kept, the marker finished at the next start, the
// confirm word, the local-only endpoint, and the "host cleared its data" message for linked computers.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
const repo = join(import.meta.dirname, '..');
const W = await import(pathToFileURL(join(repo, 'desktop/wipe.mjs')).href);
const HL = await import(pathToFileURL(join(repo, 'desktop/host-link.mjs')).href);
let hasDeps = true;
try { createRequire(join(repo, 'desktop', 'package.json')).resolve('sql.js'); } catch { hasDeps = false; }

function fakeData() {
  const root = mkdtempSync(join(tmpdir(), 'octa-wipe-'));
  const dataDir = join(root, 'OCTA'), userData = dataDir;
  mkdirSync(join(dataDir, 'files', 'bot1'), { recursive: true });
  writeFileSync(join(dataDir, 'ebot.sqlite'), 'SQLITE-DB-' + 'x'.repeat(1000));
  writeFileSync(join(dataDir, 'desktop.json'), JSON.stringify({ store: '', link: { role: 'host' } }));
  writeFileSync(join(dataDir, 'files', 'bot1', 'report.txt'), 'hello');
  writeFileSync(join(dataDir, 'octa-error.log'), 'log');
  writeFileSync(join(dataDir, 'ebot.backup-20261101-000000.sqlite'), 'old');
  mkdirSync(join(dataDir, 'Partitions', 'octa-bot-abc', 'Local Storage'), { recursive: true });
  writeFileSync(join(dataDir, 'Partitions', 'octa-bot-abc', 'Cookies'), 'c');
  mkdirSync(join(dataDir, 'bin'), { recursive: true }); writeFileSync(join(dataDir, 'bin', 'cloudflared'), 'bin');
  writeFileSync(join(dataDir, 'SingletonLock'), 'lock');
  const custom = join(root, 'Drive', 'OCTA');
  mkdirSync(join(custom, 'g1'), { recursive: true }); writeFileSync(join(custom, 'g1', 'mine.pdf'), 'pdf');
  return { root, dataDir, userData, custom, done: () => rmSync(root, { recursive: true, force: true }) };
}

test('the confirm word: 刪除 / 删除 / DELETE / 削除, nothing else', () => {
  for (const w of ['刪除', '删除', 'DELETE', 'delete', ' 削除 ', '「刪除」', 'ＤＥＬＥＴＥ']) assert.ok(W.confirmOk(w), w);
  for (const w of ['', '刪', 'del', 'DELETE ME', null, undefined, '確認']) assert.ok(!W.confirmOk(w), String(w));
  assert.equal(W.confirmWordFor('en'), 'DELETE'); assert.equal(W.confirmWordFor('ja'), '削除');
  assert.equal(W.confirmWordFor('zh-CN'), '删除'); assert.equal(W.confirmWordFor('zh-TW'), '刪除'); assert.equal(W.confirmWordFor('x'), '刪除');
});

test('backup: a dated folder with the database, desktop.json and the files (≤ limit), and a note', t => {
  const d = fakeData(); t.after(d.done);
  const docs = join(d.root, 'Documents');
  const now = new Date(2026, 10, 3, 9, 5);
  const b = W.makeBackup({ dataDir: d.dataDir, store: join(d.dataDir, 'files'), root: docs, now });
  assert.equal(b.path, join(docs, 'OCTA-備份-20261103-0905'));
  assert.equal(readFileSync(join(b.path, 'ebot.sqlite'), 'utf8'), readFileSync(join(d.dataDir, 'ebot.sqlite'), 'utf8'));
  assert.deepEqual(JSON.parse(readFileSync(join(b.path, 'desktop.json'), 'utf8')).link, { role: 'host' });
  assert.equal(readFileSync(join(b.path, 'files', 'bot1', 'report.txt'), 'utf8'), 'hello');
  assert.ok(b.files); assert.match(readFileSync(join(b.path, '說明.txt'), 'utf8'), /ebot\.sqlite/);
  // the same minute again: a second folder, the first is not overwritten
  assert.equal(W.makeBackup({ dataDir: d.dataDir, store: join(d.dataDir, 'files'), root: docs, now }).path, join(docs, 'OCTA-備份-20261103-0905-2'));
  const b2 = W.makeBackup({ dataDir: d.dataDir, store: join(d.dataDir, 'files'), root: docs, now, lang: 'en' });
  assert.equal(b2.path, join(docs, 'OCTA-backup-20261103-0905'));
  assert.ok(existsSync(join(b2.path, 'README.txt')));
  // files over the limit: database and settings only, and the note says where the files are
  const b3 = W.makeBackup({ dataDir: d.dataDir, store: d.custom, root: docs, now, limit: 2 });
  assert.equal(b3.files, false); assert.equal(b3.filesOver, true);
  assert.ok(existsSync(join(b3.path, 'ebot.sqlite')) && !existsSync(join(b3.path, 'files')));
  assert.ok(readFileSync(join(b3.path, '說明.txt'), 'utf8').includes(d.custom));
  assert.equal(W.backupName(now, 'ja'), 'OCTA-バックアップ-20261103-0905');
  assert.throws(() => W.makeBackup({ dataDir: d.dataDir, store: '', root: '' }));
});

test('wipe: the data folder is emptied (lock kept); a custom files folder is kept unless chosen', async t => {
  const d = fakeData(); t.after(d.done);
  const plan = W.planWipe({ dataDir: d.dataDir, userData: d.userData, store: d.custom });
  assert.equal(plan.storeCustom, true); assert.equal(plan.keepStore, d.custom);
  assert.deepEqual(plan.targets, [{ path: d.dataDir, whole: false }], 'the same folder once; the custom store is not a target');
  const left = await W.wipeTargets(plan.targets);
  assert.deepEqual(left, []);
  assert.deepEqual(readdirSync(d.dataDir), ['SingletonLock']);
  assert.ok(existsSync(join(d.custom, 'g1', 'mine.pdf')), 'the user\'s own folder is untouched');
  // chosen: the custom folder goes too
  const p2 = W.planWipe({ dataDir: d.dataDir, userData: d.userData, store: d.custom, deleteStore: true });
  assert.deepEqual(p2.targets.map(x => x.whole), [false, true]);
  await W.wipeTargets(p2.targets);
  assert.ok(!existsSync(d.custom));
  // the default files folder is inside the data folder: never a separate choice
  assert.equal(W.planWipe({ dataDir: d.dataDir, store: join(d.dataDir, 'files'), deleteStore: true }).storeCustom, false);
  // never a drive, the home folder or a protected folder
  assert.match(W.planWipe({ dataDir: '/', store: '' }).error, /不能清除/);
  assert.match(W.planWipe({ dataDir: d.dataDir, userData: (await import('node:os')).homedir(), store: '' }).error, /不能清除/);
  assert.match(W.planWipe({ dataDir: d.dataDir, store: d.custom, deleteStore: true, protect: [d.custom] }).error, /不能清除/);
  assert.ok(W.isInside(join(d.dataDir, 'files'), d.dataDir) && !W.isInside(d.custom, d.dataDir) && !W.isInside(d.dataDir + '2', d.dataDir));
});

test('pending wipe: leftovers listed in the marker are deleted at the next start, then the marker goes', t => {
  const d = fakeData(); t.after(d.done);
  const other = join(d.root, 'E·BOT');   // a legacy data folder (before the rename)
  mkdirSync(join(other, 'browsers'), { recursive: true }); writeFileSync(join(other, 'ebot.sqlite'), 'db');
  assert.equal(W.finishPendingWipe(d.userData), null, 'no marker: nothing happens');
  assert.ok(existsSync(join(d.dataDir, 'ebot.sqlite')));
  W.writeMarker(d.userData, { at: 1, targets: [{ path: d.dataDir, whole: false }, { path: other, whole: false }], backup: '/x/OCTA-備份', lang: 'en', keep: { autostartChosen: true } });
  const r = W.finishPendingWipe(d.userData);
  assert.equal(r.marker.backup, '/x/OCTA-備份'); assert.equal(r.marker.keep.autostartChosen, true); assert.deepEqual(r.left, []);
  assert.deepEqual(readdirSync(d.dataDir), ['SingletonLock'], 'the lock stays, the marker is gone');
  assert.ok(!existsSync(other), 'the emptied legacy folder goes too');
  assert.ok(existsSync(join(d.custom, 'g1', 'mine.pdf')), 'only folders named in the marker are touched');
  assert.equal(W.finishPendingWipe(d.userData), null, 'once');
  // the message after the restart
  const t1 = W.doneText('en', '/x/b', []);
  assert.deepEqual(t1.buttons, ['Open backup folder', 'OK']); assert.ok(t1.detail.includes('/x/b'));
  assert.deepEqual(W.doneText('zh-TW', '', []).buttons, ['好']);
  // a marker that names an unsafe folder is ignored
  W.writeMarker(d.userData, { targets: [{ path: '/', whole: false }] });
  assert.deepEqual(W.finishPendingWipe(d.userData).left, []);
});

test('the host cleared its data: linked computers see "gone" (ntfy.sh) and stop looking', async () => {
  const msgs = [];
  const fetch = async (url, init = {}) => {
    if ((init.method || 'GET') === 'POST') { msgs.push({ event: 'message', message: String(init.body) }); return new Response('{}', { status: 200 }); }
    if (url.includes('/json?poll=1')) return new Response(msgs.map(m => JSON.stringify(m)).join('\n') + '\n', { status: 200 });
    throw new Error('down');   // the host's old address does not answer
  };
  const secret = HL.newSecret();
  await HL.publishHost({ secret, url: 'https://a.trycloudflare.com', epoch: 0, hostId: 'H1', hostName: '店裡', fetch, relay: 'http://r', now: Date.now() - 1000 });
  await HL.publishGone({ secret, epoch: 0, hostId: 'H1', hostName: '店裡', fetch, relay: 'http://r' });
  const m = await HL.pollHost({ secret, fetch, relay: 'http://r' });
  assert.equal(m.gone, true);
  // the phones' copy (another key) never reads it
  assert.equal(await HL.pollHost({ secret, key: HL.phoneKeyOf(secret), fetch, relay: 'http://r' }), null);
  const link = { role: 'remote', hostId: 'H1', token: 't', secret, lastUrl: 'https://a.trycloudflare.com', epoch: 0 };
  await assert.rejects(HL.findHost({ link, fetch, relay: 'http://r' }), e => e.code === 'gone');
  let timers = 0;
  const c = HL.createRemoteClient({ getLink: () => link, saveLink: () => { }, fetch, relay: 'http://r', timers: { setTimeout: () => { timers++; return 0; }, clearTimeout: () => { } } });
  await c.connect();
  assert.equal(c.status().state, 'gone'); assert.equal(timers, 0, 'no retries');
});

test('the wipe endpoint: this computer only, confirm word required; phones (remote port) are refused', { skip: !hasDeps && 'desktop packages not installed', timeout: 60000 }, async t => {
  const { startServer } = await import(pathToFileURL(join(repo, 'desktop/server.mjs')).href);
  const dataDir = mkdtempSync(join(tmpdir(), 'octa-wipe-srv-'));
  const calls = [];
  const s = await startServer({ dataDir, runner: false, relay: 'http://127.0.0.1:9', tunnel: async port => `http://127.0.0.1:${port}`, hooks: { wipe: async (o, ctl) => { ctl.saveDb(); calls.push(o); return { ok: true, backup: null }; }, backupRoot: () => join(dataDir, 'Docs') } });
  t.after(async () => { await s.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const jpost = (url, body, headers = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body || {}) });
  const info = await (await fetch(s.url + '/api/desktop/wipe-info')).json();
  assert.equal(info.can, true); assert.equal(info.role, 'host'); assert.equal(info.storeCustom, false); assert.equal(info.backupRoot, join(dataDir, 'Docs'));
  assert.equal((await jpost(s.url + '/api/desktop/wipe', { word: '確定' })).status, 400);
  assert.equal(calls.length, 0, 'a wrong word does nothing');
  const r = await jpost(s.url + '/api/desktop/wipe', { word: 'DELETE', backup: false, deleteStore: true, lang: 'en' });
  assert.equal(r.status, 200);
  assert.deepEqual(calls, [{ backup: false, deleteStore: true, lang: 'en' }]);
  // a paired phone through the tunnel (remote port) can't reach it
  const on = await (await jpost(s.url + '/api/desktop/remote', { on: true })).json();
  const token = (await (await jpost(s.remoteUrl + '/api/pair', { code: on.code })).json()).token;
  assert.ok(token);
  assert.equal((await jpost(s.remoteUrl + '/api/desktop/wipe', { word: '刪除' }, { authorization: 'Bearer ' + token })).status, 403);
  assert.equal((await fetch(s.remoteUrl + '/api/desktop/wipe-info', { headers: { authorization: 'Bearer ' + token } })).status, 403);
  assert.equal(calls.length, 1);
  // another site in this computer's browser can't either (the local port checks the origin)
  assert.equal((await jpost(s.url + '/api/desktop/wipe', { word: '刪除' }, { origin: 'https://evil.example' })).status, 403);
  // without the desktop app (node server.mjs) there is no wipe
  assert.equal(calls.length, 1);
});

test('the settings item: only in the desktop app (never on a phone), and the dialog asks for the word', () => {
  const settings = readFileSync(join(repo, 'app/js/settings.js'), 'utf8'), wipe = readFileSync(join(repo, 'app/js/wipe.js'), 'utf8');
  assert.match(settings, /if\(window\.octaDesktop\?\.isDesktop\)paintWipe\(/);
  assert.match(readFileSync(join(repo, 'app/index.html'), 'utf8'), /<script defer src="\/js\/settings\.js"><\/script>\s*<script defer src="\/js\/wipe\.js"><\/script>/);
  assert.match(wipe, /id="wGo" disabled/);
  assert.match(wipe, /\$\('wGo'\)\.disabled=!wipeOk\(/);
  assert.match(wipe, /<input type="checkbox" id="wBk" checked>/);
  assert.match(wipe, /<input type="checkbox" id="wStore">/, 'a custom files folder is kept unless ticked');
  assert.match(wipe, /api\('desktop\/wipe','POST'/);
});
