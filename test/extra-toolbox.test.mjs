// 4.13 擴充工具箱: off by default (the catalog, the settings page, bots and their prompt stay as in 4.12); on: the vetted
// open-source tools are offered and installed on demand, recipes are learned; checksums are mandatory; ComfyUI only with an
// NVIDIA GPU, its big downloads only after the size is confirmed; ComfyUI started / stopped by OCTA and generating through
// its HTTP API (a fake ComfyUI here: test/fake-comfy.mjs).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { dict, js } from './app-source.mjs';

const at = (...p) => pathToFileURL(join(import.meta.dirname, '..', 'desktop', ...p)).href;
const { onRequest } = await import(at('api', 'index.mjs'));
const { skillWork, toolsForBot } = await import(at('api', 'skills.mjs'));
const tb = await import(at('lib', 'toolbox.mjs'));
const gen = await import(at('lib', 'gen.mjs'));
const { skillPromptLines } = await import(at('lib', 'skills.mjs'));
const { comfyWorkflow } = await import(at('lib', 'comfy-workflows.mjs'));
const { configure } = await import(at('runner', 'state.mjs'));
const rt = await import(at('runner', 'toolbox.mjs'));
const comfy = await import(at('runner', 'comfy.mjs'));
const { genRound } = await import(at('runner', 'chat.mjs'));
const schema = readFileSync(join(import.meta.dirname, '..', 'schema.sql'), 'utf8');

function openD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(schema);
  const norm = a => a.map(v => (v === undefined ? null : typeof v === 'boolean' ? +v : v));
  class Stmt {
    constructor(sql) { this.sql = sql; this.args = []; }
    bind(...a) { this.args = norm(a); return this; }
    async first() { return db.prepare(this.sql).get(...this.args) ?? null; }
    async all() { return { results: db.prepare(this.sql).all(...this.args) }; }
    _run() { const info = db.prepare(this.sql).run(...this.args); return { success: true, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } }; }
    async run() { return this._run(); }
    _exec() { return /^\s*(SELECT|WITH)/i.test(this.sql) ? { results: db.prepare(this.sql).all(...this.args), meta: {} } : { results: [], ...this._run() }; }
  }
  return {
    prepare: sql => new Stmt(sql),
    async batch(stmts) { db.exec('BEGIN'); try { const out = stmts.map(s => s._exec()); db.exec('COMMIT'); return out; } catch (e) { try { db.exec('ROLLBACK'); } catch { } throw e; } },
    raw: db
  };
}
async function setup() {
  const db = openD1();
  await db.prepare("INSERT OR IGNORE INTO users (id,name,pw,created) VALUES ('local','本機','-',?)").bind(Date.now()).run();
  const env = { DB: db, TZ_OFFSET_MIN: '480', isLocal: true, fetch: async () => new Response('{}', { status: 404 }) };
  const call = async (method, path, body) => {
    const url = new URL('http://octa.test/api/' + path);
    const res = await onRequest({
      request: new Request(url, { method, headers: { 'content-type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(body || {}) }),
      env, params: { path: path.split('?')[0].split('/').filter(Boolean) }
    });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  };
  const bot = async name => (await call('POST', 'bots', { name, task: '幫忙', engine: 'claude' })).data.id;
  const msgs = async conv => (await call('GET', 'messages?conv=' + conv)).data.msgs || [];
  const next = async () => (await call('POST', 'runner/next', { slots: 3, wait: false })).data.job;
  const nextChat = async () => { for (let i = 0; i < 10; i++) { const j = await next(); if (!j || j.kind !== 'tool') return j; } };
  // what the runner on this computer reports (platform, GPU, installed tools)
  const report = async tools => {
    const st = JSON.parse(db.raw.prepare('SELECT settings FROM users').get().settings || '{}');
    st._tools = tools;
    db.raw.prepare('UPDATE users SET settings=?').run(JSON.stringify(st));
  };
  const toolJobs = () => db.raw.prepare("SELECT * FROM jobs WHERE kind='tool'").all().map(j => JSON.parse(j.prompt));
  return { db, env, call, bot, msgs, next, nextChat, report, toolJobs };
}
const EXTRA = ['realesrgan', 'rembg', 'whisper', 'auto-editor', 'pyimage', 'comfyui'];
const NV = { name: 'NVIDIA GeForce RTX 4080', vram: 16, driver: '581.80' };

test('catalog: every 擴充工具箱 download and model file is pinned, official and has a SHA-256; big ones flagged', () => {
  for (const t of tb.extraItems()) {
    assert.ok(t.license && t.what && t.source.startsWith('https://'), t.id);
    for (const [k, b] of Object.entries(t.builds || {})) {
      assert.match(b.sha256, /^[0-9a-f]{64}$/, `${t.id} ${k}`);
      assert.match(b.url, /^https:\/\/github\.com\/(xinntao|ggml-org|WyattBlue|comfyanonymous)\//, `${t.id} ${k}`);
      assert.ok(b.version && b.size > 0, `${t.id} ${k}`);
    }
    for (const p of tb.packList(t))
      for (const f of p.files) {
        assert.match(f.sha256, /^[0-9a-f]{64}$/, `${t.id} ${p.id}`);
        assert.match(f.url, /^https:\/\/(huggingface\.co\/(ggerganov|Comfy-Org|stabilityai)\/|github\.com\/danielgatis\/rembg\/releases\/)/, `${t.id} ${p.id}`);
        assert.ok(f.size > 0 && !f.to.includes('..'), `${t.id} ${p.id}`);
      }
    if (t.pip) for (const p of t.pip) assert.match(p, /==\d/, `${t.id}: exact versions`);
  }
  assert.match(tb.PIP_AS_OF, /^\d{4}-\d\d-\d\dT/);
  assert.equal(tb.catalogItem('comfyui').big, true);
  assert.ok(tb.downloadSize(tb.catalogItem('comfyui'), 'win-x64', ['flux-schnell'], NV) > tb.BIG_BYTES);
  assert.ok(tb.downloadSize(tb.catalogItem('rembg'), 'win-x64') < tb.BIG_BYTES, 'rembg is not big');
  // an old NVIDIA driver gets the CUDA 12.6 build; a new one the default
  assert.match(tb.buildFor(tb.catalogItem('comfyui'), 'win-x64', { driver: '560.94' }).url, /_cu126\.7z$/);
  assert.match(tb.buildFor(tb.catalogItem('comfyui'), 'win-x64', NV).url, /_nvidia\.7z$/);
  assert.equal(tb.buildFor(tb.catalogItem('comfyui'), 'linux-x64').way, 'manual');
  // packs sized to the graphics memory: 16 GB → FLUX, 8 GB → SDXL (video and FLUX do not fit), none without
  assert.deepEqual(tb.defaultPacks(tb.catalogItem('comfyui'), 16), ['flux-schnell']);
  assert.deepEqual(tb.defaultPacks(tb.catalogItem('comfyui'), 8), ['sdxl']);
  assert.deepEqual(tb.defaultPacks(tb.catalogItem('comfyui'), 4), []);
  assert.deepEqual(tb.defaultPacks(tb.catalogItem('whisper')), ['base']);
  assert.deepEqual(tb.parseToolAsk('comfyui:wan-1.3b'), { type: 'catalog', id: 'comfyui', packs: ['wan-1.3b'] });
  assert.deepEqual(tb.parseToolAsk('whisper.cpp'), { type: 'catalog', id: 'whisper' });
});

test('擴充工具箱 off (default): nothing new in the catalog, the settings page, the job or the prompt; 4.12 as it was', async () => {
  const t = await setup();
  const a = await t.bot('甲');
  await t.report({ platform: 'win-x64', gpu: true, gpuInfo: NV, installed: { ffmpeg: { ok: true, type: 'catalog', version: '9.0.2' }, rembg: { ok: true, type: 'catalog', version: '2.0.86' } } });
  const v = (await t.call('GET', 'skills')).data.tools;
  assert.equal(v.extra, false);
  assert.ok(!v.catalog.some(x => EXTRA.includes(x.id)), 'no extra tool listed');
  assert.equal(v.gpuInfo, null);
  for (const id of EXTRA) {
    assert.equal(tb.catalogItem(id, false), null, id);
    assert.ok(!tb.catalogView('win-x64', true).some(x => x.id === id), id);
  }
  assert.equal(tb.parseToolAsk('rembg', false), null);
  assert.deepEqual(tb.parseToolAsk('pip:rembg', false), { type: 'pip', pkg: 'rembg', version: '' }, 'pip: still the off-catalog way (card)');
  // a bot that names one anyway: not known, nothing queued, no card
  await t.call('POST', 'messages', { conv: a, text: '把這張圖去背' });
  const j = await t.next();
  assert.equal(j.extraTools, undefined);
  assert.equal(j.genLocal, undefined);
  assert.deepEqual(j.tools.map(x => x.id), ['ffmpeg'], 'an installed extra tool is not given to bots while it is off');
  const lines = skillPromptLines({ ...j, bot: { engine: 'claude' } }).join('\n');
  assert.doesNotMatch(lines, /擴充工具箱|rembg|comfyui|realesrgan/i);
  await t.call('POST', 'runner/done', { id: j.id, ok: true, text: '好\n🧰安裝：rembg' });
  await skillWork();
  assert.equal(t.toolJobs().length, 0);
  assert.ok((await t.msgs(a)).some(m => /不認得「rembg」/.test(m.text)));
  assert.equal((await t.call('POST', 'tools/install', { id: 'realesrgan', bots: null })).status, 400);
  assert.equal((await t.call('POST', 'tools/install-all', {})).status, 400);
  // no recipe skills, runner/genkeys says local is off
  assert.equal(t.db.raw.prepare("SELECT COUNT(*) AS n FROM lskills WHERE name LIKE 'octa-%-tools'").get().n, 0);
  assert.equal((await t.call('POST', 'runner/genkeys', {})).data.local, 'off');
});

test('擴充工具箱 on: offered with size / license / source, bots told how to use them, installed on demand without a card', async () => {
  const t = await setup();
  const a = await t.bot('甲');
  await t.report({ platform: 'win-x64', gpu: false, installed: { realesrgan: { ok: true, type: 'catalog', version: '0.2.5.0' } } });
  assert.equal((await t.call('PUT', 'skills/settings', { extra: true })).status, 200);
  const v = (await t.call('GET', 'skills')).data.tools;
  assert.equal(v.extra, true);
  const ids = v.catalog.filter(x => x.extra).map(x => x.id);
  assert.deepEqual(ids, ['realesrgan', 'rembg', 'whisper', 'auto-editor', 'pyimage'], 'no ComfyUI without an NVIDIA GPU');
  const w = v.catalog.find(x => x.id === 'whisper');
  assert.equal(w.license, 'MIT');
  assert.ok(w.total > w.size, 'program + its default model');
  assert.deepEqual(w.packs.map(p => [p.id, p.pick]), [['base', true], ['small', false]]);
  // the recipes are learned (all bots), and come off again when it is turned off
  const names = () => t.db.raw.prepare("SELECT name FROM lskills WHERE src='catalog' ORDER BY name").all().map(r => r.name);
  assert.deepEqual(names(), ['octa-image-tools', 'octa-video-tools']);
  // the job and the prompt: what is there, how to use it, which is installed
  await t.call('POST', 'messages', { conv: a, text: '幫我把影片加字幕' });
  const j = await t.next();
  assert.deepEqual(j.extraTools.map(x => x.id), ['realesrgan', 'rembg', 'whisper', 'auto-editor', 'pyimage']);
  assert.equal(j.extraTools.find(x => x.id === 'realesrgan').installed, true);
  assert.deepEqual(j.tools.map(x => x.id), ['realesrgan']);
  const lines = skillPromptLines({ ...j, bot: { engine: 'claude' } }).join('\n');
  assert.match(lines, /擴充工具箱/);
  assert.match(lines, /- realesrgan（已裝好）：/);
  assert.match(lines, /- whisper：.*octa-subtitle 影片\.mp4/);
  assert.match(lines, /🧰安裝：名稱」：ffmpeg、imagemagick、yt-dlp、uv、python、rembg、whisper/);
  assert.doesNotMatch(lines, /comfyui/i);
  assert.ok(j.lskills.some(s => s.name === 'octa-video-tools' && /字幕/.test(s.words)));
  // 🧰安裝：whisper → queued at once with its default model, no card
  await t.call('POST', 'runner/done', { id: j.id, ok: true, text: '要先裝字幕工具\n🧰安裝：whisper' });
  await skillWork();
  const q = t.toolJobs();
  assert.deepEqual(q.map(x => [x.id, x.packs]), [['whisper', ['base']]]);
  const ms = await t.msgs(a);
  assert.ok(ms.some(m => /正在安裝 whisper\.cpp（base 模型（多國語言））（OCTA 驗證過的官方檔案，不用核准）/.test(m.text)));
  assert.ok(!ms.some(m => /✅待確認/.test(m.text)));
  // 全部安裝（不含 ComfyUI）: the rest, nothing big
  const all = (await t.call('POST', 'tools/install-all', {})).data;
  assert.deepEqual(all.queued, ['rembg', 'whisper.cpp', 'auto-editor', 'Python 圖片套件（Pillow、OpenCV）']);
  // a done install of an extra tool keeps the recipes; turning it off hides tools and recipes again
  await t.call('PUT', 'skills/settings', { extra: false });
  assert.deepEqual(names(), []);
  const st = JSON.parse(t.db.raw.prepare('SELECT settings FROM users').get().settings);
  assert.deepEqual(toolsForBot(st, a).tools, []);
});

test('NVIDIA: found by nvidia-smi or Windows WMI; ComfyUI only offered with one, models sized to its memory', async () => {
  assert.deepEqual(rt.parseNvidiaSmi('NVIDIA GeForce RTX 3060, 12288, 566.36\n'), { name: 'NVIDIA GeForce RTX 3060', vram: 12, driver: '566.36', via: 'nvidia-smi' });
  assert.equal(rt.parseNvidiaSmi(''), null);
  assert.equal(rt.parseNvidiaSmi('NVIDIA-SMI has failed because it could not communicate with the NVIDIA driver.'), null);
  const wmi = JSON.stringify([{ Name: 'Intel(R) UHD Graphics 770', DriverVersion: '31.0.101.4502', AdapterRAM: 1073741824 }, { Name: 'NVIDIA GeForce RTX 4070', DriverVersion: '32.0.15.8180', AdapterRAM: 4293918720, Mem: 12884901888 }]);
  assert.deepEqual(rt.parseWmi(wmi), { name: 'NVIDIA GeForce RTX 4070', vram: 12, driver: '581.80', via: 'wmi' });
  assert.equal(rt.parseWmi(JSON.stringify({ Name: 'AMD Radeon RX 7800 XT', DriverVersion: '31.0.24027.1012' })), null);
  // the runner reports what it found
  configure({ url: 'http://127.0.0.1:1', home: mkdtempSync(join(tmpdir(), 'octa-x-')) });
  rt.setGpuProbe(async () => NV);
  await rt.refreshGpu();
  assert.deepEqual(rt.toolsHere().gpuInfo, { name: NV.name, vram: 16, driver: '581.80' });
  rt.setGpuProbe(async () => null);
  await rt.refreshGpu();
  assert.equal(rt.toolsHere().gpu, false);
  // the server: no GPU → no ComfyUI (asked by name: refused); 8 GB → shown, SDXL picked, FLUX and video do not fit
  const t = await setup();
  const a = await t.bot('甲');
  await t.call('PUT', 'skills/settings', { extra: true });
  await t.report({ platform: 'win-x64', gpu: false, installed: {} });
  assert.match((await t.call('POST', 'tools/install', { id: 'comfyui', bots: null })).data.error, /NVIDIA/);
  await t.report({ platform: 'win-x64', gpu: true, gpuInfo: { name: 'RTX 4060', vram: 8, driver: '575.10' }, installed: {} });
  const c = (await t.call('GET', 'skills')).data.tools.catalog.find(x => x.id === 'comfyui');
  assert.ok(c, 'shown with an NVIDIA GPU');
  assert.equal(c.big, true);
  assert.deepEqual(c.packs.map(p => [p.id, p.fits, p.pick]), [['flux-schnell', false, false], ['sdxl', true, true], ['wan-1.3b', false, false]]);
  assert.match(c.version, /CUDA 12\.6/, 'driver 575 < 580: the cu126 build');
  // a bot learns ComfyUI can be installed (asked only when the person wants local generation)
  await t.call('POST', 'messages', { conv: a, text: '畫圖' });
  const j = await t.next();
  assert.match(skillPromptLines({ ...j, bot: { engine: 'claude' } }).join('\n'), /🧰安裝：comfyui」，OCTA 會先請使用者確認大小/);
});

test('big downloads: the size is confirmed first (settings), a bot gets a card; nothing queued before', async () => {
  const t = await setup();
  const a = await t.bot('甲');
  await t.call('PUT', 'skills/settings', { extra: true });
  await t.report({ platform: 'win-x64', gpu: true, gpuInfo: NV, installed: {} });
  // settings: first the size, then (confirmed) the job with the packs that were shown
  const r1 = (await t.call('POST', 'tools/install', { id: 'comfyui', bots: null, packs: ['flux-schnell'] })).data;
  assert.equal(r1.needConfirm, true);
  assert.ok(r1.size > 19e9 && r1.size < 20e9, String(r1.size));
  assert.match(r1.text, /要下載約 19\.\d GB/);
  assert.equal(t.toolJobs().length, 0, 'nothing downloaded before it is confirmed');
  const r2 = (await t.call('POST', 'tools/install', { id: 'comfyui', bots: null, packs: ['flux-schnell'], confirm: true })).data;
  assert.equal(r2.queued, 'comfyui');
  assert.deepEqual(t.toolJobs().map(x => [x.id, x.packs]), [['comfyui', ['flux-schnell']]]);
  // a bot asking for ComfyUI: a card with the size, models and licenses; 核准 queues exactly that
  await t.call('POST', 'messages', { conv: a, text: '用本機做影片' });
  const j = await t.nextChat();
  await t.call('POST', 'runner/done', { id: j.id, ok: true, text: '需要本機影片模型\n🧰安裝：comfyui:wan-1.3b' });
  await skillWork();
  const card = [...(await t.msgs(a))].reverse().find(m => /✅待確認：安裝工具：comfyui/.test(m.text));
  assert.ok(card, 'a card');
  assert.match(card.text, /下載約 \d+\.\d GB/);
  assert.match(card.text, /Wan 2\.1 文字轉影片 1\.3B（約 2 秒短片）（Apache-2\.0，9\.8 GB）/);
  assert.equal(t.toolJobs().length, 1, 'still only the confirmed one');
  const id = +card.text.match(/（#(\d+)）/)[1];
  await t.call('POST', 'messages', { conv: a, text: `核准：安裝工具：comfyui（#${id}）` });
  assert.deepEqual(t.toolJobs().map(x => [x.id, x.packs]), [['comfyui', ['flux-schnell']], ['comfyui', ['wan-1.3b']]]);
  // installed → more packs are an 'packs' job (confirmed too: 9.8 GB)
  await t.report({ platform: 'win-x64', gpu: true, gpuInfo: NV, installed: { comfyui: { ok: true, type: 'catalog', version: '0.44.0', packs: ['flux-schnell'] } } });
  const r3 = (await t.call('POST', 'tools/install', { id: 'comfyui', bots: null, packs: ['wan-1.3b'] })).data;
  assert.equal(r3.needConfirm, true);
  assert.ok(r3.size > 9e9 && r3.size < 10.5e9);
  await t.call('POST', 'tools/install', { id: 'comfyui', bots: null, packs: ['wan-1.3b'], confirm: true });
  assert.equal(t.toolJobs().pop().op, 'packs');
  assert.equal((await t.call('POST', 'tools/install', { id: 'comfyui', bots: null, packs: ['flux-schnell'] })).data.same, true);
  // small ones need no confirmation
  assert.equal((await t.call('POST', 'tools/install', { id: 'auto-editor', bots: null })).data.queued, 'auto-editor');
});

test('checksums are mandatory: a model or program that does not match is refused and nothing is kept', async () => {
  const home = mkdtempSync(join(tmpdir(), 'octa-x-'));
  configure({ url: 'http://127.0.0.1:1', home });
  const bytes = Buffer.from('fake model bytes');
  const good = createHash('sha256').update(bytes).digest('hex');
  const fetchImpl = async () => new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.length) } });
  const item = { id: 'whisper', packs: { base: { label: 'b', files: [{ url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/x.bin', sha256: '0'.repeat(64), size: bytes.length, to: 'models/x.bin' }] } } };
  const dir = join(home, 'tools', 'whisper');
  await assert.rejects(rt.installPacks(item, dir, ['base'], { fetchImpl }), /檢查碼不符/);
  assert.ok(!existsSync(join(dir, 'models', 'x.bin')) && !existsSync(join(dir, 'models', 'x.bin.part')), 'nothing kept');
  item.packs.base.files[0].sha256 = good;
  assert.deepEqual(await rt.installPacks(item, dir, ['base'], { fetchImpl }), ['base']);
  assert.deepEqual(readFileSync(join(dir, 'models', 'x.bin')), bytes);
  // already there and the same: not downloaded again
  let calls = 0;
  assert.deepEqual(await rt.installPacks(item, dir, ['base'], { fetchImpl: async () => { calls++; return fetchImpl(); } }), ['base']);
  assert.equal(calls, 0);
  // a program of 擴充工具箱 without a registered checksum: refused before downloading
  await assert.rejects(rt.installTool({ key: 'auto-editor', type: 'catalog', id: 'auto-editor' }, { fetchImpl, build: { way: 'download', url: 'https://github.com/WyattBlue/auto-editor/x', sha256: '', version: '1', unpack: 'file', file: 'auto-editor', bin: '' } }), /沒有登記檢查碼/);
  // and a wrong one: refused, not installed
  await assert.rejects(rt.installTool({ key: 'auto-editor', type: 'catalog', id: 'auto-editor' }, { fetchImpl, build: { way: 'download', url: 'https://github.com/WyattBlue/auto-editor/x', sha256: 'f'.repeat(64), version: '1', unpack: 'file', file: 'auto-editor', bin: '' } }), /檢查碼不符/);
  assert.equal(rt.readInstalled()['auto-editor'], undefined);
  const ok = await rt.installTool({ key: 'auto-editor', type: 'catalog', id: 'auto-editor' }, { fetchImpl, build: { way: 'download', url: 'https://github.com/WyattBlue/auto-editor/x', sha256: good, version: '31.8.0', unpack: 'file', file: 'auto-editor', bin: '' } });
  assert.equal(ok.rec.sha256, good);
  // not too little room: refused before downloading (statfs says how much is free)
  assert.throws(() => rt.roomFor(home, 1e18), /硬碟空間不夠/);
});

test('ComfyUI: OCTA starts it on a local port when asked, generates through its HTTP API, stops it (fake ComfyUI)', async t0 => {
  const home = mkdtempSync(join(tmpdir(), 'octa-x-'));
  configure({ url: 'http://127.0.0.1:1', home });
  const logf = join(home, 'prompts.log');
  process.env.FAKE_COMFY_LOG = logf;
  mkdirSync(join(home, 'tools'), { recursive: true });
  const rec = { ok: true, type: 'catalog', version: '0.44.0', packs: ['flux-schnell', 'wan-1.3b'], run: { cmd: process.execPath, args: [join(import.meta.dirname, 'fake-comfy.mjs')], cwd: home } };
  writeFileSync(join(home, 'tools', 'installed.json'), JSON.stringify({ comfyui: rec }));
  t0.after(() => comfy.stopComfy());
  assert.equal(comfy.comfyState().running, false, 'not running until something is asked for');
  const here = join(home, 'files', '甲_b1');
  const res = await genRound({ bot: { name: '甲' } }, here,
    { ok: true, text: '好\n【產生】\n種類：圖片\n服務：本機\n描述：a latte on a wooden table\n檔名：拿鐵\n比例：16:9\n【產生完】\n【產生】\n種類：影片\n描述：waves on a beach\n檔名：海浪\n【產生完】' }, null,
    { api: async () => ({ keys: {}, local: 'auto' }), comfy: { pollMs: 50, startMs: 20000 } });
  assert.match(res.text, /🎨 已產生圖片：拿鐵\.png（本機 ComfyUI）/);
  assert.match(res.text, /🎨 已產生影片：海浪\.webm（本機 ComfyUI）/);
  assert.deepEqual(readdirSync(join(here, '輸出')).sort(), ['拿鐵.png', '海浪.webm']);
  const st = comfy.comfyState();
  assert.equal(st.running, true);
  assert.match(st.base, /^http:\/\/127\.0\.0\.1:\d+$/, 'this computer only');
  // what OCTA sent: core nodes, the prompt, the size of 16:9, nothing else from the bot
  const sent = readFileSync(logf, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(sent[0][4].inputs.ckpt_name, 'flux1-schnell-fp8.safetensors');
  assert.equal(sent[0][6].inputs.text, 'a latte on a wooden table');
  assert.deepEqual([sent[0][5].inputs.width, sent[0][5].inputs.height], [1344, 768]);
  assert.equal(sent[1][47].class_type, 'SaveWEBM');
  for (const wf of sent) for (const n of Object.values(wf)) assert.ok(!/Manager|Custom/i.test(n.class_type), 'core nodes only');
  // the args it was started with: local only, no custom nodes (the real run command adds these too)
  const stats = await (await fetch(st.base + '/system_stats')).json();
  assert.deepEqual(stats.args.slice(-4), ['--listen', '127.0.0.1', '--port', st.base.split(':').pop()]);
  assert.ok(rt.comfyRun('/x').args.includes('--disable-all-custom-nodes'));
  // stopped: the process ends
  const pid = st.pid;
  await comfy.stopComfy();
  assert.equal(comfy.comfyState().running, false);
  assert.throws(() => process.kill(pid, 0), 'the ComfyUI process is gone');
  // the setting decides: 只用雲端 → the cloud (no key here: says so); 只用本機 without a video model → says so
  const cloud = await genRound({ bot: { name: '甲' } }, here, { ok: true, text: '【產生】\n種類：圖片\n描述：cat\n【產生完】' }, null, { api: async () => ({ keys: {}, local: 'cloud' }) });
  assert.match(cloud.text, /還沒有可以產生圖片的金鑰/);
  writeFileSync(join(home, 'tools', 'installed.json'), JSON.stringify({ comfyui: { ...rec, packs: ['sdxl'] } }));
  const none = await genRound({ bot: { name: '甲' } }, here, { ok: true, text: '【產生】\n種類：影片\n描述：cat\n【產生完】' }, null, { api: async () => ({ keys: {}, local: 'local' }) });
  assert.match(none.text, /只用本機」，但本機 ComfyUI 沒有影片模型/);
  // 自動 with a cloud key and a block that names that service: the cloud
  assert.equal(gen.localFirst({ kind: 'image', provider: 'openai' }, { openai: { secret: 'k' } }, 'auto', true), 'cloud');
  assert.equal(gen.localFirst({ kind: 'image', provider: '' }, { openai: { secret: 'k' } }, 'auto', true), 'local');
  assert.equal(gen.localFirst({ kind: 'image', provider: 'local' }, {}, 'off', true), 'cloud', '擴充工具箱 off: as 4.12');
  assert.equal(gen.takeGenTasks('【產生】\n種類：圖片\n服務：本機\n描述：x\n【產生完】')[0].provider, 'local');
  assert.equal(comfyWorkflow('sdxl', { prompt: 'x', aspect: '9:16' }, 5)[5].inputs.height, 1344);
  delete process.env.FAKE_COMFY_LOG;
});

test('server: octa-local-gen is learned once ComfyUI has a model; runner/genkeys tells the runner the setting', async () => {
  const t = await setup();
  await t.bot('甲');
  await t.call('PUT', 'skills/settings', { extra: true, genLocal: 'local' });
  assert.equal((await t.call('POST', 'runner/genkeys', {})).data.local, 'local');
  await t.report({ platform: 'win-x64', gpu: true, gpuInfo: NV, installed: {} });
  await t.call('POST', 'tools/install', { id: 'comfyui', bots: null, confirm: true });
  const tj = await t.next();
  assert.equal(tj.kind, 'tool');
  await t.call('POST', 'runner/done', { id: tj.id, ok: true, text: '已安裝 comfyui 0.44.0', version: '0.44.0', tools: { platform: 'win-x64', gpu: true, gpuInfo: NV, installed: { comfyui: { ok: true, type: 'catalog', version: '0.44.0', packs: ['flux-schnell'] } } } });
  const names = t.db.raw.prepare("SELECT name FROM lskills ORDER BY name").all().map(r => r.name);
  assert.deepEqual(names, ['octa-image-tools', 'octa-local-gen', 'octa-video-tools']);
  const v = (await t.call('GET', 'skills')).data.tools;
  assert.equal(v.localReady, true);
  assert.equal(v.genLocal, 'local');
  // ComfyUI itself is not a command for bots (OCTA runs it); it is not on their PATH list
  const st = JSON.parse(t.db.raw.prepare('SELECT settings FROM users').get().settings);
  assert.ok(!toolsForBot(st, 'x').tools.some(x => x.id === 'comfyui'));
});

test('app: 擴充工具箱 switch, 全部安裝, model packs, size confirmation and 在哪裡產生; translated', () => {
  assert.match(js, /id="skExtra"|'skExtra'/);
  assert.match(js, /tools\/install-all/);
  assert.match(js, /data-tlpack/);
  assert.match(js, /needConfirm/);
  assert.match(js, /genWhere/);
  for (const k of ['擴充工具箱', '全部安裝（不含 ComfyUI）', '在哪裡產生', '只用本機（ComfyUI）', '圖片去背（人像、商品都可以，只用 CPU）']) {
    assert.ok(dict.en.t[k], k);
    assert.ok(dict.ja.t[k], k);
  }
});
