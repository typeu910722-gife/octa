// OCTA runner: what this computer tells the app — installed AIs, their models, how much quota is left.
import os from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { api } from './api-client.mjs';
import { ENGINES, engineReady, has } from './engines.mjs';
import { grokBotUnsupported, grokBots } from './grokbot.mjs';
import { ollamaChoices } from './ollama.mjs';
import { VERSION, WIN, cfg, log } from './state.mjs';

export let lastReport = 0;
export const engineReport = async () => {   // tell the app which AI tools this computer has, about once a minute
  if (Date.now() - lastReport < 60000) return undefined;
  lastReport = Date.now();
  const keys = Object.keys(ENGINES), oks = await Promise.all(keys.map(k => engineReady(k, true)));
  return Object.fromEntries(keys.map((k, i) => [k, oks[i]]));
};

// ---------- how much of each plan is left ----------
// Claude and ChatGPT report their plan limits; the others don't offer a way to ask.
async function claudeUsage() {
  const f = join(os.homedir(), '.claude', '.credentials.json');
  if (!existsSync(f)) return { error: 'no-credentials' };   // e.g. kept in the macOS keychain
  const o = JSON.parse(readFileSync(f, 'utf8'))?.claudeAiOauth || {}, tok = o.accessToken;
  if (!tok) return { error: 'no-credentials' };
  const plan = { max: 'Claude Max', pro: 'Claude Pro', team: 'Claude Team', enterprise: 'Claude Enterprise' }[String(o.subscriptionType || '').toLowerCase()] || (o.subscriptionType ? 'Claude ' + o.subscriptionType : '');
  const r = await fetch('https://api.anthropic.com/api/oauth/usage', { headers: { authorization: 'Bearer ' + tok, 'anthropic-beta': 'oauth-2025-04-20' }, signal: AbortSignal.timeout(10000) });
  if (!r.ok) return { error: 'HTTP ' + r.status, plan };
  const d = await r.json();
  const w = (x, k) => (x && typeof x.utilization === 'number' ? { k, used: Math.round(x.utilization), reset: x.resets_at || null } : null);
  return { plan, windows: [w(d.five_hour, '5h'), w(d.seven_day, '7d')].filter(Boolean) };
}
function codexPlan() {   // ChatGPT plan from the sign-in Codex saved (only the plan label is read)
  try {
    const a = JSON.parse(readFileSync(join(os.homedir(), '.codex', 'auth.json'), 'utf8'));
    const p = JSON.parse(Buffer.from(String(a?.tokens?.id_token || '').split('.')[1] || '', 'base64url').toString())['https://api.openai.com/auth']?.chatgpt_plan_type;
    return p ? 'ChatGPT ' + p[0].toUpperCase() + p.slice(1) : '';
  } catch { return ''; }
}
// label a quota window by its real length (the free ChatGPT plan has a monthly window, not 5 hours)
const winKey = (m, k) => !m ? k : m <= 1440 ? (m === 300 ? '5h' : Math.round(m / 60) + 'h') : m <= 10080 ? '7d' : '30d';
function codexUsage() {   // `codex app-server` answers account/rateLimits/read over JSON-RPC
  return new Promise(resolve => {
    let done = false, buf = '';
    const child = spawn('codex', ['app-server'], { shell: WIN, windowsHide: true });
    const finish = v => { if (done) return; done = true; clearTimeout(t); try { child.kill(); } catch { } resolve(v); };
    const t = setTimeout(() => finish({ error: 'timeout' }), 15000);
    const send = o => { try { child.stdin.write(JSON.stringify(o) + '\n'); } catch { } };
    child.on('error', () => finish(null));
    child.stdout.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) { send({ method: 'initialized' }); send({ id: 2, method: 'account/rateLimits/read' }); }
        if (msg.id === 2) {
          const rl = msg.result?.rateLimits || msg.result || {};
          const w = (x, k) => (x && typeof x.usedPercent === 'number' ? { k: winKey(x.windowDurationMins, k), used: Math.round(x.usedPercent), reset: x.resetsAt ? new Date(x.resetsAt * (x.resetsAt < 1e12 ? 1000 : 1)).toISOString() : null } : null);
          finish(msg.error ? { error: msg.error.message || 'error', plan: codexPlan() } : { plan: codexPlan() || (rl.planType ? 'ChatGPT ' + rl.planType : ''), windows: [w(rl.primary, '5h'), w(rl.secondary, '7d')].filter(Boolean) });
        }
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'octa', title: 'OCTA', version: VERSION } } });
  });
}
// which models each AI on this computer offers (for the model menu); asked from the tools that can list them
const runText = (bin, args) => new Promise(ok => execFile(bin, args, { shell: WIN, windowsHide: true, timeout: 20000, encoding: 'utf8', maxBuffer: 4 << 20 }, (e, out, err) => ok(e ? '' : String(out || '') + String(err || ''))));
export let lastModels = 0, lastOllamaCheck = 0, ollamaSig = null;
const ollamaList = async () => ollamaChoices((await runText('ollama', ['list'])).split('\n').slice(1).map(l => l.trim().split(/\s+/)[0]).filter(Boolean)).slice(0, 30);
export async function modelReport() {   // every 30 minutes, or right away once a new Ollama model shows up (checked every minute)
  let quick;
  if (Date.now() - lastOllamaCheck > 60000) {
    lastOllamaCheck = Date.now();
    if (await has('ollama')) { quick = await ollamaList(); if (ollamaSig !== null && quick.join('|') !== ollamaSig) lastModels = 0; }
  }
  if (Date.now() - lastModels < 30 * 60000) return undefined;
  lastModels = Date.now();
  const out = {};
  if (quick || await has('ollama')) out.opencode = quick || await ollamaList();
  ollamaSig = (out.opencode || []).join('|');
  if (await has('agent')) {
    const t = (await runText('agent', ['--list-models'])).replace(/\x1b\[[0-9;]*m/g, '');
    out.cursor = [...new Set(t.split('\n').map(l => (l.match(/^\s*(?:[-*•]\s*)?([a-z0-9][\w.\-]{2,40})(?:\s|$)/i) || [])[1]).filter(x => x && /\d|-/.test(x)))].slice(0, 30);
  }
  if (await has('agy')) {
    const t = (await runText('agy', ['models'])).replace(/\x1b\[[0-9;]*m/g, '');
    out.gemini = [...new Set(t.split("\n").map(l => (l.match(/^\s*([a-z][\w.\-]*-[\w.\-]+)\s/i) || [])[1]).filter(Boolean))].slice(0, 30);   // agy also serves Claude and GPT-OSS models (separate weekly quota)
  }
  if (!grokBotUnsupported() && await has('gbot')) { try { out.grokbot = (await grokBots()).map(b => b.name).slice(0, 40); } catch { } }
  if (await has('copilot')) {
    const t = await runText('copilot', ['--help']);
    const m = t.match(/--model[\s\S]{0,300}?choices:\s*([^)]+)\)/);
    if (m) out.copilot = [...m[1].matchAll(/"([^"]+)"/g)].map(x => x[1]).slice(0, 40);
  }
  return out;
}
export let lastUsage = 0, usageNow = {};
// ask again on the next report: which AIs are installed, their models, how much quota is left
export function resetReports({ engines = true, models = true, usage = true } = {}) {
  if (engines) lastReport = 0;
  if (models) lastModels = 0;
  if (usage) lastUsage = 0;
}
export async function usageReport() {   // every 10 minutes
  if (Date.now() - lastUsage < 10 * 60000) return undefined;
  lastUsage = Date.now();
  const out = {};
  usageNow = out;   // bots read this to answer "how much quota is left" 
  const safe = async (k, fn) => { try { const v = (await engineReady(k)) ? await fn() : null; if (v) out[k] = { ...v, t: Date.now() }; } catch (e) { out[k] = { error: String(e.message || e).slice(0, 80), t: Date.now() }; } };
  await Promise.all([safe('claude', claudeUsage), safe('codex', codexUsage)]);
  return out;
}
// started from any device (phone, web): open the install window on this computer, then watch for the tool
export async function installJob(job) {
  const E = ENGINES[job.engine];
  if (!E || !cfg.openInstall) return api('runner/done', { id: job.id, ok: false, text: '這台主機不是 OCTA 桌面版，無法自動安裝，請在主機電腦上手動安裝。' });
  try { await cfg.openInstall(job.engine); } catch (e) { return api('runner/done', { id: job.id, ok: false, text: '無法打開安裝視窗：' + e.message }); }
  log(`🧩 已打開 ${E.label} 的安裝視窗`);
  await api('runner/done', { id: job.id, ok: true, text: `已在主機電腦「${os.hostname()}」打開 ${E.label} 的安裝視窗。` });
  // report as soon as it's installed (checks every 10 seconds for up to 15 minutes)
  const t0 = Date.now();
  const tick = setInterval(async () => {
    if (await engineReady(job.engine, true)) { clearInterval(tick); resetReports(); log(`✓ ${E.label} 已安裝`); }
    else if (Date.now() - t0 > 15 * 60000) clearInterval(tick);
  }, 10000);
}
