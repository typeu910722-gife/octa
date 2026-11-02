// OCTA runner: Ollama local models (context size, tool support) and the browser-use bridge (octa-browseruse.py).
import { execFile, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { has, refreshPath } from './engines.mjs';
import { OLLAMA_NUM_CTX, WIN, log, workDir } from './state.mjs';

export function ollamaContextTag(base) {
  const safe = String(base || 'model').replace(/[^A-Za-z0-9._-]/g, '-').replace(/-+/g, '-').slice(0, 48);
  return `octa-ctx-${safe}`;
}
export function ollamaContextModelfile(base, numCtx = OLLAMA_NUM_CTX) {
  return `FROM ${String(base || '').trim()}\nPARAMETER num_ctx ${numCtx}\n`;
}
// OpenCode talks to Ollama's OpenAI endpoint, which ignores a per-request num_ctx.
// A local model tag bakes the larger window in, then OpenCode can use it.
export function ensureOllamaContext(base) {
  const tag = ollamaContextTag(base);
  const show = spawnSync('ollama', ['show', tag, '--modelfile'], { encoding: 'utf8', timeout: 15000, shell: WIN, windowsHide: true });
  if (show.status === 0 && new RegExp(`num_ctx\\s+${OLLAMA_NUM_CTX}\\b`).test(show.stdout || '')) return tag;
  const created = spawnSync('ollama', ['create', tag, '-f', '-'], { input: ollamaContextModelfile(base), encoding: 'utf8', timeout: 60000, shell: WIN, windowsHide: true });
  if (created.status === 0) { log(`本機模型改用上下文 ${OLLAMA_NUM_CTX}：${tag}`); return tag; }
  log('無法加大本機模型的上下文，仍用原本的模型。' + String(created.stderr || created.stdout || '').slice(0, 180));
  return base;
}

// what the bot runs on and how much of the plan is left, for the prompt
export function parseOllamaCaps(text) {
  const out = new Set(), lines = String(text || '').split(/\r?\n/);
  const i = lines.findIndex(l => /^\s*Capabilities\s*$/i.test(l));
  if (i < 0) return out;
  for (const l of lines.slice(i + 1)) { const w = l.trim(); if (!w) { if (out.size) break; continue; } if (!/^[a-z_-]+$/i.test(w)) break; out.add(w.toLowerCase()); }
  return out;
}
const capsCache = new Map();
export function ollamaCaps(name) {
  if (capsCache.has(name)) return capsCache.get(name);
  const r = spawnSync('ollama', ['show', name], { encoding: 'utf8', shell: WIN, windowsHide: true, timeout: 15000 });
  const caps = r.status === 0 ? parseOllamaCaps(r.stdout) : null;   // null: couldn't tell, don't block on it
  if (caps) capsCache.set(name, caps);
  return caps;
}
// OCTA's own context copies (octa-ctx-…) are not choices: they mirror a model the user downloaded
export const ollamaChoices = list => list.filter(n => !/^octa-ctx-/.test(n));
// the model Ollama should use: the bot's, or a downloaded one that can call tools (seeing pages is a bonus)
export function ollamaModel(model) {
  if (model) return model.replace(/^ollama\//, '');
  const r = spawnSync('ollama', ['list'], { encoding: 'utf8', shell: WIN, windowsHide: true, timeout: 10000 });
  const all = ollamaChoices((r.stdout || '').split('\n').slice(1).map(l => l.trim().split(/\s+/)[0]).filter(Boolean));
  const score = n => { const c = ollamaCaps(n); return c ? (c.has('tools') ? 2 : 0) + (c.has('vision') ? 1 : 0) : 1; };
  return all.map(n => [n, score(n)]).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
}
export const NO_TOOLS_TEXT = name => `⚠ 本機模型「${name}」不支援工具呼叫（tool calling），沒辦法讀任務、寫檔或操作瀏覽器，所以會一直卡住。請把這個機器人的模型改成支援工具的模型，例如 qwen3、qwen3-vl:8b（看得懂網頁畫面）、gpt-oss:20b 或 gemma4。`;

// browser-use (Python, MIT): the local model drives the bot's own browser one action at a time with Ollama's
// native structured calls — far steadier for small models than OpenCode + the long Playwright tool list.
// Installed once into OCTA's own folder (its own Python venv); until it is ready the old OpenCode path is used.
const BROWSER_USE_PIN = 'browser-use==0.13.14';
let buState = null;   // null: not tried · { busy } · { python, script } · { failed, t }
const buDir = () => join(workDir, 'browser-use');
const venvPy = () => join(buDir(), 'venv', WIN ? 'Scripts\\python.exe' : 'bin/python');
const runQ = (cmd, args, ms) => new Promise(res => execFile(cmd, args, { windowsHide: true, timeout: ms, maxBuffer: 1 << 22 }, (e, out, err) => res({ ok: !e, out: String(out || ''), err: String(err || e?.message || '') })));
async function systemPython() {
  const tries = WIN ? [['py', ['-3.12']], ['py', ['-3.13']], ['py', ['-3.11']], ['python', []], ['python3', []]] : [['python3', []], ['python', []]];
  for (const [cmd, pre] of tries) {
    const r = await runQ(cmd, [...pre, '-c', 'import sys;print(sys.version_info[0]*100+sys.version_info[1])'], 20000);
    const v = +r.out.trim();
    if (r.ok && v >= 311 && v <= 313) return [cmd, pre];   // browser-use's dependencies lag behind brand-new Python (3.14+)
  }
  return null;
}
function buScript() {
  const dst = join(buDir(), 'octa-browseruse.py');
  // the bridge script ships next to this module (inside app.asar when packaged; Electron's fs reads it from there),
  // so it is copied out to a real folder that Python can run it from
  const src = fileURLToPath(new URL('./octa-browseruse.py', import.meta.url));
  try { writeFileSync(dst, readFileSync(src)); } catch (e) { if (!existsSync(dst)) throw e; }
  return dst;
}
export function browserUseReady() {
  if (buState?.python) return buState;
  if (!buState || (buState.failed && Date.now() - buState.t > 3600000)) setupBrowserUse();
  return null;
}
async function setupBrowserUse() {
  buState = { busy: true };
  try {
    mkdirSync(buDir(), { recursive: true });
    const py = venvPy();
    if (!existsSync(py) || !(await runQ(py, ['-I', '-c', 'import browser_use'], 60000)).ok) {
      log('🧩 第一次幫 Ollama 機器人安裝 browser-use（操作瀏覽器用，約 3–5 分鐘），裝好前先用原本的方式');
      // uv (if installed) fetches its own Python 3.12 into the venv — no matter which Python the computer has
      const uv = await has('uv', true);   // a uv-made venv has no pip of its own, so keep installing with uv
      if (uv && !existsSync(py)) {
        const v = await runQ('uv', ['venv', '--python', '3.12', join(buDir(), 'venv')], 600000);
        if (!v.ok) log('🧩 uv 建立 Python 3.12 環境失敗，改用電腦上的 Python：' + v.err.slice(-200));
      }
      if (existsSync(py)) {
        const pip = uv ? await runQ('uv', ['pip', 'install', '--python', py, BROWSER_USE_PIN], 1800000)
          : await runQ(py, ['-m', 'pip', 'install', '--disable-pip-version-check', '-q', BROWSER_USE_PIN], 1800000);
        if (!pip.ok) throw new Error('安裝 browser-use 失敗：' + pip.err.slice(-300));
        log('🧩 browser-use 安裝完成，Ollama 機器人之後用它操作瀏覽器');
        buState = { python: py, script: buScript() };
        return;
      }
      let sys = await systemPython();
      if (!sys && WIN) {
        log('🧩 這台電腦沒有 Python 3.11 以上，先用 winget 安裝 Python 3.12');
        await runQ('winget', ['install', '-e', '--id', 'Python.Python.3.12', '--scope', 'user', '--accept-source-agreements', '--accept-package-agreements'], 900000);
        await refreshPath(); sys = await systemPython();
      }
      if (!sys) throw new Error('找不到 Python 3.11 以上');
      if (!existsSync(py)) { const v = await runQ(sys[0], [...sys[1], '-m', 'venv', join(buDir(), 'venv')], 300000); if (!v.ok) throw new Error('建立 Python 環境失敗：' + v.err.slice(-200)); }
      const pip = await runQ(py, ['-m', 'pip', 'install', '--disable-pip-version-check', '-q', BROWSER_USE_PIN], 1800000);
      if (!pip.ok) throw new Error('pip 安裝失敗：' + pip.err.slice(-300));
      log('🧩 browser-use 安裝完成，Ollama 機器人之後用它操作瀏覽器');
    }
    buState = { python: py, script: buScript() };
  } catch (e) {
    buState = { failed: true, t: Date.now() };
    log('🧩 browser-use 沒裝好，Ollama 機器人先用原本的方式操作瀏覽器：' + e.message);
  }
}
export const BU_WORDS = { navigate: '打開網頁', search: '搜尋', click: '點擊', input: '輸入文字', input_text: '輸入文字', scroll: '捲動頁面', extract: '讀取網頁內容',
  switch: '切換分頁', switch_tab: '切換分頁', go_back: '回上一頁', send_keys: '按鍵盤', select_dropdown: '選擇選項', upload_file: '上傳檔案', wait: '等待網頁載入', done: '整理報告', think: '思考下一步' };
