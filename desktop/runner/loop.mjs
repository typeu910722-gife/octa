// OCTA runner: the main loop (long-poll the local API for work) and startRunner().
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { listRecoverableStates, probeCodingHosts, runCodingTask, selectProvider } from '../lib/coding-runtime.mjs';
import { api, saveUpload, sendCopy } from './api-client.mjs';
import { reapBrowsers, keepOpen, setKeepBrowsers } from './browser.mjs';
import { chatJob } from './chat.mjs';
import { storeDir } from './files.mjs';
import { listJob } from './grokbot.mjs';
import { checkWatches, openJob, resetWatches } from './live.mjs';
import { engineReport, installJob, modelReport, resetReports, usageReport } from './reports.mjs';
import { MAX, PW_MCP, VERSION, WIN, cfg, configure, log, setMax, workDir } from './state.mjs';
import { freemem } from 'node:os';
import { checkService, resetService } from './service.mjs';
import { exportJob, importJob } from './transfer.mjs';
import { refreshGpu, toolJob, toolsHere } from './toolbox.mjs';
import { stopComfy } from './comfy.mjs';
import { closeSession, sessions, testJob } from './warm.mjs';

// ---------- main loop: long-poll, so work starts the moment it's sent ----------
export let active = 0, failures = 0, stopped = true, polling = false, standby = false;
const fileWork = new Set();
const holding = new Set();   // 4.11: job ids this runner is working on (the server checks a silent job against it, not kills it)
function codeSummary(state) {
  const { events, context, ...rest } = state || {};
  rest.diff = String(rest.diff || '').slice(0, 20000);
  rest.tests = (rest.tests || []).map(t => ({ ...t, stdout: String(t.stdout || '').slice(0, 2000), stderr: String(t.stderr || '').slice(0, 2000) }));
  return rest;
}
async function codeJob(job) {
  const ac = new AbortController();
  const resumed = job.resumeState || null;
  let sent = resumed?.events?.length || 0;
  const workspacesRoot = join(workDir, 'code-workspaces');
  const fb = Array.isArray(job.task.fb) ? job.task.fb : [];
  const routeChain = [{ engine: job.task.engine, model: job.task.model || '' }, ...fb.map(s => {
    const [engine, model] = String(s).split('|');
    return { engine, model: model || '' };
  })];
  const providerFor = slot => selectProvider({ engine: slot.engine, model: slot.model, allowFixture: process.env.OCTA_CODE_ALLOW_FIXTURE === '1' });
  const slot = routeChain[resumed?.routeIndex || 0] || routeChain[0];
  const provider = await providerFor(slot);
  const res = await runCodingTask({
    id: job.task.id, title: job.task.title, prompt: job.task.prompt, criteria: job.task.criteria,
    engine: slot.engine, model: slot.model, maxRepairs: job.task.maxRetries,
    repoPath: job.repo.path, workspacesRoot, provider, routeChain, providerFor, signal: ac.signal, resume: resumed || undefined,
    approval: job.task.approval || undefined,
    isCancelled: async () => ac.signal.aborted,
    persist: async state => {
      const fresh = (state.events || []).slice(sent);
      sent = (state.events || []).length;
      const r = await api('runner/code/event', {
        taskId: state.id, status: state.status, phase: state.phase, role: state.role,
        workspaceId: state.workspaceId, branch: state.branch, baseRef: state.baseRef, headRef: state.headRef,
        retries: state.repairs, summary: codeSummary(state),
        events: fresh.map(e => ({ role: e.role, kind: e.kind, text: e.text, data: e.data || null }))
      });
      if (r.cancel) ac.abort();
      return r;
    }
  });
  const text = `${res.providerNote || res.providerId || ''} ${res.status}${res.reason ? ' ' + res.reason : ''}${res.error ? ' ' + res.error : ''}`.trim();
  await api('runner/done', { id: job.id, ok: res.status === 'tested', text: text.slice(0, 2000) });
  log(`${res.status === 'tested' ? '✓' : '✗'} 程式任務 ${job.task.title || job.task.id}：${res.status}`);
}
async function recoverCodeTasks() {
  const root = join(workDir, 'code-workspaces');
  for (const state of listRecoverableStates(root)) {
    try {
      const r = await api('runner/code/resume', { taskId: state.id });
      if (r?.continue && r.job) runJob({ ...r.job, resumeState: state });
    } catch (e) { log('程式任務恢復失敗：' + e.message); }
  }
}
let lastCoding = 0, codingCache = null;
async function codingProbe() {
  if (codingCache && Date.now() - lastCoding < 60000) return codingCache;
  lastCoding = Date.now();
  try { codingCache = await probeCodingHosts({ timeoutMs: 400 }); } catch { codingCache = null; }
  return codingCache;
}
function runJob(job) {
  active++; holding.add(job.id);
  const handlers = { code: codeJob, open: openJob, test: testJob, list: listJob, install: installJob, export: exportJob, import: importJob, tool: toolJob };
  (Object.hasOwn(handlers, job.kind) ? handlers[job.kind] : chatJob)(job)
    .catch(e => { log('任務錯誤：' + e.message); return api('runner/done', { id: job.id, ok: false, text: '⚠ ' + e.message }).catch(() => { }); })
    .finally(() => { active--; holding.delete(job.id); kick(); });
}
function doFiles(inbox = [], pull = []) {
  for (const f of inbox) if (!fileWork.has(f.id)) { fileWork.add(f.id); saveUpload(f).catch(e => log('附件儲存失敗：' + e.message)).finally(() => fileWork.delete(f.id)); }
  for (const f of pull) if (!fileWork.has(f.id)) { fileWork.add(f.id); sendCopy(f).catch(e => log('傳送檔案失敗：' + e.message)).finally(() => fileWork.delete(f.id)); }
}
let poll = null, booting = true, lastPoll = 0;
export const pollAge = () => (lastPoll ? Date.now() - lastPoll : 0);   // how long the wait-for-work loop has been stuck (desktop watchdog)
const LOW_FREE = 1.2 * 1024 ** 3;   // 4.15.3: below this much free memory no 4th, 5th… bot starts
const kick = () => { if (active < MAX) poll?.abort(); };   // a slot freed up: ask again right away (with the free slot)
// 反應快: checking the AI tools, quotas and models can take many seconds (codex app-server, model lists). Asking for the
// next job no longer waits on them: they run on the side and their result goes up with a later ask. Only the very
// first look at the installed AIs is awaited, so the app knows them right after start.
export function sideReport(fn) {
  let busy = null, ready;
  return () => {
    if (ready !== undefined) { const v = ready; ready = undefined; return v; }
    if (!busy) busy = Promise.resolve().then(fn).then(v => { if (v !== undefined) ready = v; }, () => { }).finally(() => { busy = null; });
    return undefined;
  };
}
const reportsBg = { engines: sideReport(engineReport), usage: sideReport(usageReport), models: sideReport(modelReport), coding: sideReport(codingProbe) };
let firstLook = true;
// 4.12: the toolbox on this computer goes up at the start and then once a minute (a small file read)
let toolsAt = 0;
const toolsTick = () => { if (Date.now() - toolsAt < 60000) return undefined; toolsAt = Date.now(); try { return toolsHere(); } catch { return undefined; } };
async function reports() {
  if (firstLook) { firstLook = false; return { engines: await engineReport(), usage: reportsBg.usage(), models: reportsBg.models(), coding: await codingProbe() }; }
  return { engines: reportsBg.engines(), usage: reportsBg.usage(), models: reportsBg.models(), coding: reportsBg.coding() };
}
async function loop() {
  if (polling) return;
  polling = true;
  while (!stopped) {
    try {
      // beyond 3 at once, a new bot starts only while the computer has memory to spare (each one runs an AI and a browser)
      const slots = MAX > 3 && active >= 3 && freemem() < LOW_FREE ? 0 : Math.max(0, MAX - active);
      poll = new AbortController();
      const r = await api('runner/next', {
        wait: true, slots, max: MAX, running: [...holding], ...(await reports()), ...(booting ? { boot: true } : {}),
        version: VERSION, app: cfg.appVersion || undefined, store: storeDir(), toolsHere: toolsTick()
      }, 'POST', slots ? undefined : poll.signal).catch(e => {
        if (e.name === 'AbortError' && poll.signal.aborted) return {};
        if (e.name === 'TimeoutError' || e.name === 'AbortError') throw new Error('等待工作逾時，重新連線');
        throw e;
      });
      failures = 0; lastPoll = Date.now();
      if (r.keep) setKeepBrowsers(r.keep);
      if (r.par && +r.par !== MAX) log(`同時工作的機器人改為${setMax(r.par) >= 99 ? '不限制' : ' ' + MAX + ' 個'}`);
      if ('job' in r && !!r.standby !== standby) {
        standby = !!r.standby;
        log(standby ? '⏸ 這台電腦目前是備用電腦，由主機執行機器人。可在「設定 → 電腦」改成主機。' : '▶ 這台電腦是主機，開始接工作。');
        cfg.onStandby?.(standby);
      }
      booting = false;
      doFiles(r.inbox, r.pull);
      if (r.job) runJob(r.job);
    } catch (e) {
      failures++; lastPoll = Date.now();   // an answer, even a failed one: the loop itself is alive
      log('連線問題：' + e.message);
      await new Promise(ok => setTimeout(ok, Math.min(2000 * 2 ** Math.min(failures, 5), 60000)));
    }
  }
  polling = false;
}

// Started by the desktop app's local server (desktop/server.mjs) or main process; talks to the local API at opts.url.
// opts: { url, home, max, chrome, pwCli, nodeBin, nodeEnv, log, onDone, onStandby, getStore, getExtToken, appVersion, embed,
//         openInstall(engine) }
// (`token` and `onFatal` from the cloud days are still accepted and ignored.)
export function startRunner(opts) {
  configure(opts);
  stopped = false; booting = true; lastPoll = Date.now(); standby = false; firstLook = true;
  resetReports();
  mkdirSync(join(workDir, 'bots'), { recursive: true });
  mkdirSync(storeDir(), { recursive: true });
  log(`OCTA 執行器 v${VERSION} 啟動，最多 ${MAX} 個機器人同時工作；檔案資料夾：${storeDir()}`);
  if (!cfg.pwCli) {
    log('準備瀏覽器工具…');
    spawnSync(WIN ? 'cmd' : 'npx', WIN ? ['/c', 'npx', '-y', PW_MCP, '--version'] : ['-y', PW_MCP, '--version'], { stdio: 'ignore', timeout: 180000 });
  }
  refreshGpu().catch(() => { });   // 4.13: NVIDIA or not (擴充工具箱 offers ComfyUI only there), in the background
  loop();
  recoverCodeTasks().catch(e => log('程式任務恢復失敗：' + e.message));
  const reaper = setInterval(() => reapBrowsers(false).catch(() => { }), 5 * 60000);
  const watcher = setInterval(() => checkWatches().catch(() => { }), 60000);
  const svcTimer = setInterval(() => checkService().catch(() => { }), 2000);   // 4.16 客服模式
  const keepTimer = setInterval(() => { if (!standby && !stopped) keepOpen().catch(() => { }); }, 60000);   // 4.16.2 瀏覽器一直開著
  resetService();
  resetWatches();
  const firstWatch = setTimeout(() => checkWatches().catch(() => { }), 15000);
  return {
    // keepBrowsers: a restart (after sleep, or the server not answering) leaves the bots' browsers open for the next run
    stop: (opts = {}) => {
      stopped = true; poll?.abort();
      clearInterval(reaper); clearInterval(watcher); clearInterval(svcTimer); clearInterval(keepTimer); clearTimeout(firstWatch);
      if (!opts.keepBrowsers) reapBrowsers(true).catch(() => { });
      for (const id of [...sessions.keys()]) closeSession(id);
      if (!opts.keepBrowsers) stopComfy().catch(() => { });   // 4.13: local ComfyUI does not outlive OCTA
    },
    active: () => active, standby: () => standby
  };
}

