// OCTA runner 4.13: ComfyUI on this computer (擴充工具箱, NVIDIA only). Not running all the time: started on a free local
// port (127.0.0.1 only) when a 【產生】 block wants a local picture or video, stopped after IDLE_MS without work and when
// OCTA quits. A generation is ComfyUI's own HTTP API: POST /prompt (a workflow of core nodes) → GET /history/<id> until
// it is done → GET /view for each output file.
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { packList } from '../lib/toolbox.mjs';
import { comfyWorkflow } from '../lib/comfy-workflows.mjs';
import { WIN, log } from './state.mjs';

export const IDLE_MS = 10 * 60000;
const S = { child: null, base: '', idle: null, starting: null, tail: '' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () =>
  new Promise((ok, no) => {
    const s = createServer();
    s.once('error', no);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => ok(p));
    });
  });
export const comfyState = () => ({ running: !!S.child, base: S.base, pid: S.child?.pid || 0 });
async function answers(base, ms = 3000) {
  try {
    const r = await fetch(base + '/system_stats', { signal: AbortSignal.timeout(ms) });
    return r.ok;
  } catch {
    return false;
  }
}
// rec: the installed ComfyUI ({ run: { cmd, args, cwd } }); opts.startMs: how long to wait for it to answer
export async function startComfy(rec, opts = {}) {
  if (S.child && S.base && (await answers(S.base))) return S.base;
  if (S.starting) return S.starting;
  S.starting = (async () => {
    if (S.child) await stopComfy();
    const run = rec?.run;
    if (!run?.cmd) throw new Error('ComfyUI 還沒裝好');
    const port = await freePort();
    S.tail = '';
    const child = spawn(run.cmd, [...(run.args || []), '--listen', '127.0.0.1', '--port', String(port)], { cwd: run.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const keep = d => { S.tail = (S.tail + d).slice(-4000); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('exit', () => { if (S.child === child) { S.child = null; S.base = ''; } });
    S.child = child;
    S.base = `http://127.0.0.1:${port}`;
    log(`🎨 啟動本機 ComfyUI（連接埠 ${port}）…`);
    const t0 = Date.now(), wait = opts.startMs ?? 5 * 60000;
    while (Date.now() - t0 < wait) {
      if (child.exitCode !== null || child.signalCode) throw new Error('ComfyUI 沒有啟動：' + S.tail.trim().split('\n').slice(-3).join(' ').slice(-300));
      if (await answers(S.base)) return S.base;
      await sleep(opts.pollMs ?? 1000);
    }
    await stopComfy();
    throw new Error('ComfyUI 太久沒有回應，已關掉');
  })();
  try {
    return await S.starting;
  } finally {
    S.starting = null;
  }
}
export async function stopComfy() {
  clearTimeout(S.idle);
  const c = S.child;
  S.child = null;
  S.base = '';
  if (!c || c.exitCode !== null) return;
  const gone = new Promise(r => c.once('exit', r));
  if (WIN) execFile('taskkill', ['/pid', String(c.pid), '/T', '/F'], { windowsHide: true }, () => {});   // its Python and children
  else c.kill('SIGTERM');
  await Promise.race([gone, sleep(8000)]);
  if (c.exitCode === null && !c.signalCode) try { c.kill('SIGKILL'); } catch { }
  log('🎨 本機 ComfyUI 已關閉');
}
process.once('exit', () => { try { S.child?.kill(); } catch { } });
function touch(ms = IDLE_MS) {
  clearTimeout(S.idle);
  S.idle = setTimeout(() => stopComfy(), ms);
  S.idle.unref?.();
}
// the model pack that does this kind (picture / video), best first
export function packFor(item, rec, kind) {
  const have = rec?.packs || [];
  return packList(item).filter(p => p.kind === kind && have.includes(p.id)).sort((a, b) => (b.minVram || 0) - (a.minVram || 0))[0] || null;
}
// one generation → { ok, files: [{ ext, mime, buf }], text }   opts: { idleMs, startMs, pollMs, maxWaitMs }
export async function comfyGenerate(task, item, rec, opts = {}) {
  const pack = packFor(item, rec, task.kind);
  if (!pack) return { ok: false, provider: 'local', text: task.kind === 'video' ? '本機 ComfyUI 沒有影片模型（設定 → 技能與工具 加裝）' : '本機 ComfyUI 沒有圖片模型' };
  let base;
  try {
    base = await startComfy(rec, opts);
  } catch (e) {
    return { ok: false, provider: 'local', text: e.message };
  }
  clearTimeout(S.idle);
  try {
    const wf = comfyWorkflow(pack.workflow, task, opts.seed ?? Math.floor(Math.random() * 2 ** 31));
    const r = await fetch(base + '/prompt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: wf, client_id: randomUUID() }), signal: AbortSignal.timeout(60000) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.prompt_id) return { ok: false, provider: 'local', text: 'ComfyUI：' + (d.error?.message || d.error || 'HTTP ' + r.status) };
    const t0 = Date.now(), maxWait = opts.maxWaitMs ?? (task.kind === 'video' ? 40 : 15) * 60000;
    let h = null;
    while (Date.now() - t0 < maxWait) {
      const x = await fetch(`${base}/history/${d.prompt_id}`, { signal: AbortSignal.timeout(30000) }).then(y => y.json()).catch(() => ({}));
      h = x[d.prompt_id];
      if (h?.status?.status_str === 'error') return { ok: false, provider: 'local', text: 'ComfyUI 沒做成：' + JSON.stringify(h.status.messages?.find(m => m[0] === 'execution_error')?.[1]?.exception_message || '').slice(0, 300) };
      if (h?.status?.completed || (h?.outputs && Object.keys(h.outputs).length)) break;
      h = null;
      await sleep(opts.pollMs ?? 1500);
    }
    if (!h) return { ok: false, provider: 'local', text: `ComfyUI 超過 ${Math.round(maxWait / 60000)} 分鐘還沒做好，先停下` };
    const files = [];
    for (const out of Object.values(h.outputs || {}))
      for (const f of [...(out.images || []), ...(out.gifs || []), ...(out.videos || [])]) {
        if (f.type && f.type !== 'output') continue;
        const q = new URLSearchParams({ filename: f.filename, subfolder: f.subfolder || '', type: 'output' });
        const v = await fetch(`${base}/view?${q}`, { signal: AbortSignal.timeout(120000) });
        if (!v.ok) continue;
        const ext = (String(f.filename).match(/\.(png|jpe?g|webp|webm|mp4|gif)$/i) || [])[1]?.toLowerCase() || (task.kind === 'video' ? 'webm' : 'png');
        files.push({ ext: ext === 'jpeg' ? 'jpg' : ext, mime: (task.kind === 'video' && /webm|mp4/.test(ext) ? 'video/' : 'image/') + (ext === 'jpg' ? 'jpeg' : ext), buf: Buffer.from(await v.arrayBuffer()) });
        if (files.length >= 4) break;
      }
    if (!files.length) return { ok: false, provider: 'local', text: 'ComfyUI 沒有產生檔案' };
    return { ok: true, provider: 'local', model: pack.id, files };
  } catch (e) {
    return { ok: false, provider: 'local', text: 'ComfyUI：' + (e?.message || '失敗') };
  } finally {
    touch(opts.idleMs);
  }
}
