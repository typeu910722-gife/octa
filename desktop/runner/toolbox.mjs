// OCTA runner 4.12: the toolbox on this computer — <data>/tools/<id>/, a list of what is installed (installed.json),
// installs (catalog: checksum-verified official downloads; npm / pip / MCP / GitHub release: after approval),
// and the PATH each bot's AI tool runs with (only the tools given to that bot).
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, delimiter, dirname, join } from 'node:path';
import { TOOLS_VERSION, TOOL_LIMIT_BYTES, buildFor, catalogItem, mcpName, platformKey } from '../lib/toolbox.mjs';
import { api } from './api-client.mjs';
import { findBin } from './engines.mjs';
import { WIN, cfg, log } from './state.mjs';

export const toolsRoot = () => join(cfg.home || '.', 'tools');
const listFile = () => join(toolsRoot(), 'installed.json');
export function readInstalled() {
  try {
    return JSON.parse(readFileSync(listFile(), 'utf8'));
  } catch {
    return {};
  }
}
function writeInstalled(m) {
  mkdirSync(toolsRoot(), { recursive: true });
  writeFileSync(listFile(), JSON.stringify(m, null, 2));
}
let gpuSeen = null;
export const hasNvidia = () => (gpuSeen === null ? (gpuSeen = !!findBin('nvidia-smi')) : gpuSeen);
// what the runner tells the server with each ask for work (settings page, prompt lines)
export function toolsHere() {
  const inst = readInstalled();
  const pub = {};
  for (const [k, v] of Object.entries(inst)) pub[k] = { ok: !!v.ok, type: v.type, version: v.version || '', sha256: v.sha256 || '', source: v.source || '', ts: v.ts || 0, bins: v.bins || [], pkg: v.pkg, by: v.by, summary: v.summary };
  return { platform: platformKey(), gpu: hasNvidia(), v: TOOLS_VERSION, installed: pub };
}
// the PATH for one bot: its tools' folders first
export function toolEnv(tools, base = process.env) {
  const inst = readInstalled();
  const dirs = [],
    more = {};
  for (const t of tools || []) {
    const v = inst[t.id];
    if (!v?.ok) continue;
    Object.assign(more, v.env || {});
    for (const d of v.binDirs || [v.binDir]) if (d) dirs.push(/^([a-zA-Z]:|\/)/.test(d) ? d : join(toolsRoot(), d));
  }
  if (!dirs.length) return null;
  const key = WIN ? Object.keys(base).find(k => k.toLowerCase() === 'path') || 'Path' : 'PATH';
  return { ...base, ...more, [key]: [...new Set(dirs), base[key] || ''].join(delimiter) };
}

// ---------- downloading, checking, unpacking ----------
export async function download(url, file, { sha256 = '', max = TOOL_LIMIT_BYTES, fetchImpl = globalThis.fetch, progress } = {}) {
  const r = await fetchImpl(url, { redirect: 'follow', headers: { 'user-agent': 'OCTA-desktop' }, signal: AbortSignal.timeout(30 * 60000) });
  if (!r.ok || !r.body) throw new Error(`下載失敗（${r.status}）`);
  const len = +r.headers?.get?.('content-length') || 0;
  if (len > max) throw new Error('檔案太大');
  mkdirSync(dirname(file), { recursive: true });
  const h = createHash('sha256'),
    out = createWriteStream(file);
  let n = 0,
    last = 0;
  try {
    for await (const chunk of r.body) {
      n += chunk.length;
      if (n > max) throw new Error('檔案太大');
      h.update(chunk);
      if (!out.write(chunk)) await new Promise(ok => out.once('drain', ok));
      if (progress && n - last > 5e6) {
        last = n;
        progress(n, len);
      }
    }
  } finally {
    await new Promise(ok => out.end(ok));
  }
  const got = h.digest('hex');
  if (sha256 && got !== sha256.toLowerCase()) {
    rmSync(file, { force: true });
    throw new Error(`檢查碼不符（下載到的檔案跟官方公布的不一樣），已刪除，沒有安裝`);
  }
  return { sha256: got, size: n };
}
const run = (cmd, args, opts = {}) =>
  new Promise((ok, no) =>
    execFile(cmd, args, { windowsHide: true, shell: !!opts.shell, timeout: opts.timeout || 20 * 60000, maxBuffer: 8 << 20, env: opts.env || process.env, cwd: opts.cwd }, (e, out, er) =>
      e ? no(new Error(String(er || e.message).trim().slice(-600))) : ok(String(out || '')))
  );
// tar reads zip and 7z too where it is bsdtar (Windows 10+, macOS); Linux' GNU tar only gets .tar.*
export async function unpack(file, dir, kind) {
  mkdirSync(dir, { recursive: true });
  if (kind === 'zip' && !WIN && process.platform !== 'darwin' && findBin('unzip')) return run('unzip', ['-q', '-o', file, '-d', dir]);
  return run('tar', ['-xf', file, '-C', dir]);
}

// ---------- one install / removal (a 'tool' job from the server) ----------
export async function installTool(spec, opts = {}) {
  const inst = readInstalled();
  const key = spec.key;
  const root = toolsRoot();
  const dir = join(root, key.replace(/[^\w.-]+/g, '_'));
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (spec.op === 'remove') {
    rmSync(dir, { recursive: true, force: true });
    delete inst[key];
    writeInstalled(inst);
    return { ok: true, text: `已移除 ${key}` };
  }
  const rec = { ok: true, type: spec.type || 'catalog', by: spec.by || 'me', ts: Date.now() };
  if (spec.type === 'catalog') {
    const item = catalogItem(spec.id || key);
    const b = opts.build || buildFor(item, opts.platform || platformKey());   // opts.build: tests
    if (b.way === 'bundled') {
      const node = cfg.nodeBin || findBin('node');
      if (!node) throw new Error('找不到 Node.js');
      Object.assign(rec, { version: process.versions.node, source: 'OCTA 內建', binDir: dirname(node), bins: ['node'] });
    } else if (b.way === 'uv-python') {
      if (!inst.uv?.ok) Object.assign(inst, { uv: (await installTool({ key: 'uv', type: 'catalog', id: 'uv', by: spec.by }, opts)).rec });
      const uv = join(root, inst.uv.binDir, WIN ? 'uv.exe' : 'uv');
      const env = { ...process.env, UV_PYTHON_INSTALL_DIR: join(dir, 'pythons') };
      await run(uv, ['python', 'install', item.version], { env });
      const exe = (await run(uv, ['python', 'find', item.version], { env })).trim().split('\n').pop();
      if (!exe || !existsSync(exe)) throw new Error('Python 裝好了但找不到執行檔');
      const shim = join(dir, 'bin');
      mkdirSync(shim, { recursive: true });
      // python / python3 on the PATH: the folder of the real one (Windows has python.exe there) plus links elsewhere
      if (!WIN) for (const n of ['python', 'python3']) { try { rmSync(join(shim, n), { force: true }); symlinkSync(exe, join(shim, n)); } catch { } }
      Object.assign(rec, { version: item.version, source: 'uv python install（python-build-standalone）', binDirs: WIN ? [dirname(exe), join(dirname(exe), 'Scripts')] : [join(dir, 'bin').slice(root.length + 1)], bins: ['python'] });
    } else if (b.way === 'download') {
      const tmp = join(root, '.dl', basename(new URL(b.url).pathname));
      let got = null,
        lastErr = null;
      for (const u of [b.url, ...(b.alt || [])]) {
        try {
          got = await download(u, tmp, { sha256: b.sha256, fetchImpl, progress: opts.progress });
          break;
        } catch (e) {
          lastErr = e;
          if (/檢查碼/.test(e.message)) break;
        }
      }
      if (!got) throw lastErr || new Error('下載失敗');
      rmSync(dir, { recursive: true, force: true });
      if (b.unpack === 'file') {
        mkdirSync(dir, { recursive: true });
        copyFileSync(tmp, join(dir, b.file));
        if (!WIN) chmodSync(join(dir, b.file), 0o755);
        // an AppImage runs without FUSE when extracted on the fly
      } else await unpack(tmp, dir, b.unpack);
      rmSync(tmp, { force: true });
      Object.assign(rec, { version: b.version, sha256: got.sha256, source: b.url, binDir: join(dir.slice(root.length + 1), ...String(b.bin || '').split('/').filter(Boolean)), bins: item.bins });
      if (item.id === 'imagemagick' && !WIN) rec.env = { APPIMAGE_EXTRACT_AND_RUN: '1' };
    } else if (b.way === 'manual') throw new Error(`這台電腦請自己安裝：${b.how || '看官方網站'}`);
    else throw new Error('這個工具之後的版本才會開放');
  } else if (spec.type === 'npm' || spec.type === 'mcp') {
    const a = spec.ask,
      v = spec.info?.version || a.version || 'latest';
    if (spec.type === 'mcp') Object.assign(rec, { pkg: a.pkg, version: v, source: spec.info?.source, summary: spec.info?.summary, mcp: { name: mcpName(a.pkg), command: 'npx', args: ['-y', `${a.pkg}@${v}`] } });
    else {
      const npm = findBin('npm');
      if (!npm) throw new Error('這台電腦沒有 npm（Node.js），先安裝 Node.js');
      mkdirSync(dir, { recursive: true });
      await run(npm, ['install', '--prefix', dir, '--no-audit', '--no-fund', `${a.pkg}@${v}`], { shell: WIN });
      Object.assign(rec, { pkg: a.pkg, version: v, source: spec.info?.source, summary: spec.info?.summary, binDir: join(dir.slice(root.length + 1), 'node_modules', '.bin'), bins: spec.info?.bins || [] });
    }
  } else if (spec.type === 'pip') {
    if (!inst.uv?.ok) Object.assign(inst, { uv: (await installTool({ key: 'uv', type: 'catalog', id: 'uv', by: spec.by }, opts)).rec });
    const uv = join(root, inst.uv.binDir, WIN ? 'uv.exe' : 'uv');
    const a = spec.ask,
      v = spec.info?.version || a.version;
    const env = { ...process.env, UV_TOOL_DIR: join(root, 'uv-tools'), UV_TOOL_BIN_DIR: join(root, 'uv-bin'), UV_PYTHON_INSTALL_DIR: join(root, 'python', 'pythons') };
    await run(uv, ['tool', 'install', v ? `${a.pkg}==${v}` : a.pkg], { env });
    Object.assign(rec, { pkg: a.pkg, version: v || '', source: spec.info?.source, summary: spec.info?.summary, binDir: 'uv-bin', bins: [] });
  } else if (spec.type === 'github') {
    const info = spec.info || {};
    const tmp = join(root, '.dl', info.asset || 'download');
    const got = await download(info.url, tmp, { sha256: info.sha256 || '', fetchImpl });
    rmSync(dir, { recursive: true, force: true });
    if (/\.(zip|tar\.gz|tgz|tar\.xz)$/i.test(info.asset || '')) await unpack(tmp, dir, /\.zip$/i.test(info.asset) ? 'zip' : 'tar');
    else {
      mkdirSync(dir, { recursive: true });
      copyFileSync(tmp, join(dir, info.asset));
      if (!WIN) chmodSync(join(dir, info.asset), 0o755);
    }
    rmSync(tmp, { force: true });
    // one folder inside: use it; a bin/ folder: use that
    let bin = dir;
    const ents = readdirSync(bin);
    if (ents.length === 1 && statSync(join(bin, ents[0])).isDirectory()) bin = join(bin, ents[0]);
    if (existsSync(join(bin, 'bin'))) bin = join(bin, 'bin');
    Object.assign(rec, { version: info.version || '', sha256: got.sha256, source: info.source, binDir: bin.slice(root.length + 1), bins: [] });
  } else throw new Error('不認得這種工具');
  inst[key] = rec;
  writeInstalled(inst);
  return { ok: true, rec, text: `已安裝 ${key}${rec.version ? ' ' + rec.version : ''}` };
}
export async function toolJob(job) {
  const spec = job.spec || {};
  let res;
  try {
    log(`🧰 ${spec.op === 'remove' ? '移除' : '安裝'} ${spec.key}…`);
    res = await installTool(spec, { progress: (n, all) => log(`🧰 ${spec.key}：已下載 ${Math.round(n / 1e6)}${all ? ' / ' + Math.round(all / 1e6) : ''} MB`) });
  } catch (e) {
    res = { ok: false, text: e.message };
  }
  log(`${res.ok ? '✓' : '✗'} ${spec.key}：${res.text}`);
  await api('runner/done', { id: job.id, ok: res.ok, text: res.text, version: res.rec?.version || '', tools: toolsHere() });
}
// MCP servers given to a bot (installed as type mcp)
export function mcpFor(list) {
  return (list || []).filter(m => m?.name && m.command && Array.isArray(m.args));
}
export const toolsSig = job => JSON.stringify([(job.tools || []).map(t => t.id), (job.mcp || []).map(m => m.name)]);
