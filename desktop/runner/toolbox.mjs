// OCTA runner 4.12: the toolbox on this computer — <data>/tools/<id>/, a list of what is installed (installed.json),
// installs (catalog: checksum-verified official downloads; npm / pip / MCP / GitHub release: after approval),
// and the PATH each bot's AI tool runs with (only the tools given to that bot).
// 4.13 擴充工具箱: model packs (each file checksum-checked), tools in their own uv venv (pinned versions, resolved as of a
// fixed day), the small helper commands (tool-helpers.mjs), the NVIDIA check (nvidia-smi, else Windows' own WMI) and
// ComfyUI (runner/comfy.mjs).
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, statfsSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, delimiter, dirname, join } from 'node:path';
import { COMFY_DIR, PIP_AS_OF, TOOLS_VERSION, TOOL_LIMIT_BYTES, buildFor, catalogItem, defaultPacks, mcpName, packList, platformKey } from '../lib/toolbox.mjs';
import { REMBG_PY, SUBTITLE_MJS } from '../lib/tool-helpers.mjs';
import { api } from './api-client.mjs';
import { stopComfy } from './comfy.mjs';
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
// ---------- the graphics card: NVIDIA (name, memory in GB, driver) — asked once an hour, in the background ----------
// nvidia-smi comes with NVIDIA's driver (Windows: System32); without it, Windows' own WMI still names the card
let gpu = { info: null, at: 0, busy: false };
let gpuProbe = null; // tests
export const setGpuProbe = fn => { gpuProbe = fn; gpu = { info: null, at: 0, busy: false }; };
const sh = (cmd, args, ms = 15000) => new Promise(ok => execFile(cmd, args, { windowsHide: true, timeout: ms }, (e, out) => ok(e ? '' : String(out || ''))));
export function parseNvidiaSmi(out) {
  const l = String(out || '').split(/\r?\n/).map(x => x.split(',').map(y => y.trim())).filter(x => x[0] && /^\d/.test(x[1] || ''));
  if (!l.length) return null;
  const best = l.sort((a, b) => +b[1] - +a[1])[0];
  return { name: best[0], vram: Math.round((+best[1] / 1024) * 10) / 10, driver: best[2] || '', via: 'nvidia-smi' };
}
// WMI: DriverVersion 32.0.15.8180 → NVIDIA 581.80; memory from the display driver's registry key (AdapterRAM stops at 4 GB)
export function parseWmi(out) {
  let d;
  try { d = JSON.parse(out); } catch { return null; }
  const all = (Array.isArray(d) ? d : [d]).filter(x => /nvidia/i.test(x?.Name || ''));
  if (!all.length) return null;
  const x = all.sort((a, b) => (+b.Mem || 0) - (+a.Mem || 0))[0];
  const digits = String(x.DriverVersion || '').split('.').slice(-2).join('').slice(-5);
  return { name: x.Name, vram: Math.round(((+x.Mem || +x.AdapterRAM || 0) / 1073741824) * 10) / 10, driver: digits.length === 5 ? `${digits.slice(0, 3)}.${digits.slice(3)}` : '', via: 'wmi' };
}
const WMI_PS = "$m=@{};Get-ItemProperty 'HKLM:\\SYSTEM\\ControlSet001\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0*' -ErrorAction SilentlyContinue|%{$m[$_.DriverDesc]=$_.'HardwareInformation.qwMemorySize'};Get-CimInstance Win32_VideoController|%{[pscustomobject]@{Name=$_.Name;DriverVersion=$_.DriverVersion;AdapterRAM=$_.AdapterRAM;Mem=$m[$_.Name]}}|ConvertTo-Json -Compress";
export async function detectGpu() {
  if (gpuProbe) return gpuProbe();
  const sys32 = 'C:\\Windows\\System32\\nvidia-smi.exe';
  const smi = findBin('nvidia-smi') || (WIN && existsSync(sys32) ? sys32 : '');
  if (smi) {
    const r = parseNvidiaSmi(await sh(smi, ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits']));
    if (r) return r;
  }
  if (WIN) return parseWmi(await sh('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WMI_PS], 30000));
  return null;
}
export async function refreshGpu() {
  if (gpu.busy) return gpu.info;
  gpu.busy = true;
  try { gpu.info = await detectGpu(); } catch { gpu.info = null; }
  gpu.at = Date.now();
  gpu.busy = false;
  return gpu.info;
}
export const gpuInfo = () => {
  if (!gpu.busy && Date.now() - gpu.at > 3600_000) refreshGpu();
  return gpu.info;
};
export const hasNvidia = () => !!gpuInfo();
// what the runner tells the server with each ask for work (settings page, prompt lines)
export function toolsHere() {
  const inst = readInstalled();
  const pub = {};
  for (const [k, v] of Object.entries(inst)) pub[k] = { ok: !!v.ok, type: v.type, version: v.version || '', sha256: v.sha256 || '', source: v.source || '', ts: v.ts || 0, bins: v.bins || [], pkg: v.pkg, by: v.by, summary: v.summary, ...(v.packs ? { packs: v.packs } : {}) };
  const g = gpuInfo();
  return { platform: platformKey(), gpu: !!g, gpuInfo: g ? { name: g.name, vram: g.vram, driver: g.driver } : null, v: TOOLS_VERSION, installed: pub };
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
      if (progress && n - last > Math.max(5e6, len / 40)) {
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

// ---------- 4.13 擴充工具箱: model packs, room on the disk, helper commands, ComfyUI's start command ----------
const uvBin = (inst, root) => {
  if (!inst.uv?.ok) throw new Error('需要先裝 uv');
  return join(root, inst.uv.binDir, WIN ? 'uv.exe' : 'uv');
};
// a big download needs room: the file, unpacking it, and some to spare (refused before anything is downloaded)
export function roomFor(root, bytes) {
  if (!bytes || bytes < 500e6) return;
  try {
    mkdirSync(root, { recursive: true });
    const s = statfsSync(root);
    const free = Number(s.bavail) * Number(s.bsize);
    if (free && free < bytes * 1.1) throw new Error(`硬碟空間不夠：需要約 ${gb(bytes * 1.1)}，只剩 ${gb(free)}`);
  } catch (e) {
    if (/硬碟空間/.test(e.message)) throw e;
  }
}
const gb = n => (n / 1e9).toFixed(1) + ' GB';
// each file of the chosen packs, from the place written in the catalog, checked against its SHA-256 (a wrong one: nothing kept)
export async function installPacks(item, dir, ids, { fetchImpl = globalThis.fetch, progress } = {}) {
  const done = [];
  for (const p of packList(item).filter(x => ids.includes(x.id))) {
    for (const f of p.files) {
      const to = join(dir, ...f.to.split('/'));
      if (existsSync(to) && statSync(to).size === f.size && (await sha256File(to)) === f.sha256) continue;   // already here, the same
      const part = to + '.part';
      await download(f.url, part, { sha256: f.sha256, fetchImpl, progress, max: f.size + 1e6 });
      rmSync(to, { force: true });
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(part, to);
      rmSync(part, { force: true });
    }
    done.push(p.id);
  }
  return done;
}
async function sha256File(p) {
  const h = createHash('sha256');
  const { createReadStream } = await import('node:fs');
  for await (const c of createReadStream(p)) h.update(c);
  return h.digest('hex');
}
// a command on the bot's PATH that runs a helper (a .cmd on Windows, a small sh script elsewhere)
function shim(binDir, name, cmd, args, env = {}) {
  mkdirSync(binDir, { recursive: true });
  const q = s => `"${s}"`;
  if (WIN) writeFileSync(join(binDir, name + '.cmd'), `@echo off\r\n${Object.entries(env).map(([k, v]) => `set ${k}=${v}\r\n`).join('')}${q(cmd)} ${args.map(q).join(' ')} %*\r\n`);
  else {
    writeFileSync(join(binDir, name), `#!/bin/sh\n${Object.entries(env).map(([k, v]) => `${k}='${v}' `).join('')}exec ${q(cmd)} ${args.map(q).join(' ')} "$@"\n`);
    chmodSync(join(binDir, name), 0o755);
  }
}
function writeHelper(item, dir, rec, root, inst) {
  const helpers = join(dir, 'octa');
  mkdirSync(helpers, { recursive: true });
  if (item.helper === 'rembg') {
    // the venv's own `rembg` needs extras OCTA does not install (a web UI); this one only removes backgrounds
    writeFileSync(join(helpers, 'octa_rembg.py'), REMBG_PY);
    const py = join(dir, 'venv', WIN ? 'Scripts' : 'bin', WIN ? 'python.exe' : 'python');
    shim(join(dir, 'bin'), 'rembg', py, ['-I', join(helpers, 'octa_rembg.py')], { U2NET_HOME: join(dir, 'models') });
    rec.binDir = join(dir, 'bin').slice(root.length + 1);
  }
  if (item.helper === 'subtitle') {
    writeFileSync(join(helpers, 'octa-subtitle.mjs'), SUBTITLE_MJS.replace('__TOOLS__', JSON.stringify(root)).replace('__WHISPER__', JSON.stringify(dir)));
    const node = cfg.nodeBin || process.execPath;
    shim(join(dir, 'bin'), 'octa-subtitle', node, [join(helpers, 'octa-subtitle.mjs')], cfg.nodeEnv?.ELECTRON_RUN_AS_NODE ? { ELECTRON_RUN_AS_NODE: '1' } : {});
    rec.binDirs = [rec.binDir, join(dir, 'bin').slice(root.length + 1)];
  }
}
// ComfyUI (Windows portable): its own Python, core nodes only, this computer only, no browser window, its own output folder
export const comfyRun = dir => ({
  cmd: join(dir, COMFY_DIR, 'python_embeded', 'python.exe'),
  args: ['-s', join('ComfyUI', 'main.py'), '--disable-auto-launch', '--disable-all-custom-nodes', '--disable-partner-nodes', '--output-directory', join(dir, 'output')],
  cwd: join(dir, COMFY_DIR)
});

// ---------- one install / removal (a 'tool' job from the server) ----------
// the same tool asked for twice at once (two tools that both need uv): one install, both wait for it
const inflight = new Map();
export function installTool(spec, opts = {}) {
  const k = spec.key + '|' + (spec.op || '');
  if (inflight.has(k)) return inflight.get(k);
  const p = installOne(spec, opts).finally(() => inflight.delete(k));
  inflight.set(k, p);
  return p;
}
async function installOne(spec, opts = {}) {
  const inst = readInstalled();
  const key = spec.key;
  const root = toolsRoot();
  const dir = join(root, key.replace(/[^\w.-]+/g, '_'));
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (spec.op === 'remove') {
    if (key === 'comfyui') await stopComfy();
    rmSync(join(root, inst[key]?.dir || dir.slice(root.length + 1)), { recursive: true, force: true });
    const now = readInstalled();
    delete now[key];
    writeInstalled(now);
    return { ok: true, text: `已移除 ${key}` };
  }
  const rec = { ok: true, type: spec.type || 'catalog', by: spec.by || 'me', ts: Date.now() };
  if (spec.type === 'catalog') {
    const item = catalogItem(spec.id || key);
    if (!item) throw new Error('不認得這個工具');
    const b = opts.build || buildFor(item, opts.platform || platformKey(), opts.gpu || gpuInfo());   // opts.build: tests
    // 4.13: only more model packs for a tool that is already here (ComfyUI's video model, whisper's small model)
    if (spec.op === 'packs' && inst[key]?.ok) {
      const have = inst[key];
      const got = await installPacks(item, join(root, have.dir || key), (spec.packs || []).filter(p => !(have.packs || []).includes(p)), { fetchImpl, progress: opts.progress });
      have.packs = [...new Set([...(have.packs || []), ...got])];
      have.ts = Date.now();
      const now = readInstalled();
      now[key] = have;
      writeInstalled(now);
      return { ok: true, rec: have, text: `已加裝 ${got.join('、') || '（沒有新的）'}` };
    }
    // what it needs first (whisper.cpp → ffmpeg, rembg → uv)
    for (const n of item.needs || []) if (!inst[n]?.ok) Object.assign(inst, { [n]: (await installTool({ key: n, type: 'catalog', id: n, by: spec.by }, { ...opts, build: undefined })).rec });
    if (item.extra && b.way === 'download' && !/^[0-9a-f]{64}$/.test(b.sha256 || '')) throw new Error('這個檔案沒有登記檢查碼，不安裝');
    const packs = spec.packs || defaultPacks(item, (opts.gpu || gpuInfo())?.vram);
    roomFor(root, (b.size || 0) * (b.unpack === '7z' ? 4 : 2) + packList(item).filter(p => packs.includes(p.id)).reduce((n, p) => n + p.size, 0));
    if (b.way === 'bundled') {
      const node = cfg.nodeBin || findBin('node');
      if (!node) throw new Error('找不到 Node.js');
      Object.assign(rec, { version: process.versions.node, source: 'OCTA 內建', binDir: dirname(node), bins: ['node'] });
    } else if (b.way === 'uv-python') {
      const uv = uvBin(inst, root);
      const env = { ...process.env, UV_PYTHON_INSTALL_DIR: join(dir, 'pythons') };
      await run(uv, ['python', 'install', item.version], { env });
      const exe = (await run(uv, ['python', 'find', item.version], { env })).trim().split('\n').pop();
      if (!exe || !existsSync(exe)) throw new Error('Python 裝好了但找不到執行檔');
      const shim = join(dir, 'bin');
      mkdirSync(shim, { recursive: true });
      // python / python3 on the PATH: the folder of the real one (Windows has python.exe there) plus links elsewhere
      if (!WIN) for (const n of ['python', 'python3']) { try { rmSync(join(shim, n), { force: true }); symlinkSync(exe, join(shim, n)); } catch { } }
      Object.assign(rec, { version: item.version, source: 'uv python install（python-build-standalone）', binDirs: WIN ? [dirname(exe), join(dirname(exe), 'Scripts')] : [join(dir, 'bin').slice(root.length + 1)], bins: ['python'] });
    } else if (b.way === 'uv-venv') {
      // 4.13: its own venv, exact versions, dependencies as they were on PIP_AS_OF (never "whatever is newest today")
      const uv = uvBin(inst, root);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      const env = { ...process.env, UV_PYTHON_INSTALL_DIR: join(dir, 'pythons'), UV_PYTHON_PREFERENCE: 'only-managed' };
      const venv = join(dir, 'venv');
      await run(uv, ['venv', '--python', '3.12', venv], { env });
      const py = join(venv, WIN ? 'Scripts' : 'bin', WIN ? 'python.exe' : 'python');
      await run(uv, ['pip', 'install', '--python', py, '--exclude-newer', PIP_AS_OF, ...item.pip], { env, timeout: 40 * 60000 });
      Object.assign(rec, { version: item.version, source: `PyPI：${item.pip.join('、')}`, binDir: join(dir.slice(root.length + 1), 'venv', WIN ? 'Scripts' : 'bin'), bins: item.bins });
    } else if (b.way === 'download') {
      const tmp = join(root, '.dl', basename(new URL(b.url).pathname));
      let got = null,
        lastErr = null;
      for (const u of [b.url, ...(b.alt || [])]) {
        try {
          got = await download(u, tmp, { sha256: b.sha256, fetchImpl, progress: opts.progress, max: Math.max(TOOL_LIMIT_BYTES, (b.size || 0) + 1e6) });
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
      const binDir = join(dir, ...String(b.bin || '').split('/').filter(Boolean));
      if (!WIN) for (const f of b.exec || []) { try { chmodSync(join(binDir, f), 0o755); } catch { } }
      Object.assign(rec, { version: b.version, sha256: got.sha256, source: b.url, binDir: binDir.slice(root.length + 1), bins: item.bins });
      if (item.id === 'imagemagick' && !WIN) rec.env = { APPIMAGE_EXTRACT_AND_RUN: '1' };
    } else if (b.way === 'manual') throw new Error(`這台電腦請自己安裝：${b.how || '看官方網站'}`);
    else throw new Error('這個工具之後的版本才會開放');
    if (item.packs) rec.packs = await installPacks(item, dir, packs, { fetchImpl, progress: opts.progress });
    rec.dir = dir.slice(root.length + 1);
    if (item.env) rec.env = { ...(rec.env || {}), ...Object.fromEntries(Object.entries(item.env).map(([k, v]) => [k, join(dir, v)])) };
    if (item.helper) writeHelper(item, dir, rec, root, inst);
    if (item.via === 'comfyui') rec.run = comfyRun(dir);
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
  // what other installs finished meanwhile stays (read again, then this one added)
  const now = readInstalled();
  for (const n of Object.keys(inst)) if (inst[n]?.ok && !now[n]) now[n] = inst[n];
  now[key] = rec;
  writeInstalled(now);
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
