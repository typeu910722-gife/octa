// OCTA runner: the AI command-line tools (table, install check, spawning), and running one prompt on one of them.
import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { providerFailureText, replyIsProviderRefusal } from '../lib/model-route.mjs';
import { storeDir } from './files.mjs';
import { grokBotEnv, grokBotUnsupported } from './grokbot.mjs';
import { BU_WORDS, NO_TOOLS_TEXT, browserUseReady, ensureOllamaContext, ollamaCaps, ollamaModel } from './ollama.mjs';
import { keepBrowserTask } from './prompts.mjs';
import { JOB_TIMEOUT_MS, OLLAMA_NUM_CTX, QUIET_MS, WIN, q } from './state.mjs';

// install: { win, mac } shell commands, or npm: package name (needs Node.js); pre: installed first; login: command that starts sign-in
export const ENGINES = {
  claude: { label: 'Claude Code', bin: 'claude', site: 'https://code.claude.com', login: 'claude', loginHint: '視窗出現後輸入 /login，選 Claude 訂閱帳號',
    install: { win: 'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://claude.ai/install.ps1 | iex"', mac: 'curl -fsSL https://claude.ai/install.sh | bash' },
    paths: { win: '%USERPROFILE%\\.local\\bin', mac: '$HOME/.local/bin' } },
  codex: { label: 'Codex CLI（ChatGPT）', bin: 'codex', site: 'https://developers.openai.com/codex/cli', npm: '@openai/codex', login: 'codex login', loginHint: '瀏覽器會打開，用 ChatGPT 帳號登入' },
  // Google moved personal accounts from Gemini CLI to the Antigravity CLI (agy) in June 2026; the key stays 'gemini' so existing bots keep working
  gemini: { label: 'Antigravity CLI（Gemini／Claude）', bin: 'agy', site: 'https://antigravity.google/docs/cli', login: 'agy', loginHint: '瀏覽器會打開，用 Google 帳號登入（免費帳號也可以），完成後輸入 /quit 離開',
    install: { win: 'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://antigravity.google/cli/install.ps1 | iex"', mac: 'curl -fsSL https://antigravity.google/cli/install.sh | bash' },
    paths: { win: '%USERPROFILE%\\.local\\bin', mac: '$HOME/.local/bin' } },
  copilot: { label: 'GitHub Copilot CLI', bin: 'copilot', site: 'https://github.com/github/copilot-cli', npm: '@github/copilot', login: 'copilot', loginHint: '視窗出現後輸入 /login，用 GitHub 帳號登入' },
  cursor: { label: 'Cursor CLI', bin: 'agent', site: 'https://cursor.com/cli', login: 'agent login', loginHint: '瀏覽器會打開，用 Cursor 帳號登入',
    install: { win: 'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm \'https://cursor.com/install?win32=true\' | iex"', mac: 'curl https://cursor.com/install -fsS | bash' },
    paths: { win: '%LOCALAPPDATA%\\cursor-agent', mac: '$HOME/.local/bin' } },
  qwen: { label: 'Qwen Code', bin: 'qwen', site: 'https://github.com/QwenLM/qwen-code', npm: '@qwen-code/qwen-code', login: 'qwen', loginHint: '依畫面選擇登入方式，完成後輸入 /quit 離開' },
  // local open models only — no paid API keys. OpenCode drives the model and the browser tool; Ollama runs the model.
  grok: { label: 'Grok CLI（xAI）', bin: 'grok', site: 'https://docs.x.ai/build/overview', login: 'grok login', loginHint: '瀏覽器會打開，用你的 X／Grok 帳號登入',
    install: { win: 'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://x.ai/cli/install.ps1 | iex"', mac: 'curl -fsSL https://x.ai/cli/install.sh | bash' } },
  // a bot from the user's Grok Bot app, driven through the open-source grok-bot-cli (third party, not by xAI);
  // it uses the signed-in Grok Bot desktop app on this computer
  grokbot: { label: 'Grok Bot（grok-bot-cli）', bin: 'gbot', site: 'https://github.com/ScriptedAlchemy/grok-bot-cli', npm: 'grok-bot-cli',
    login: 'gbot bots list --gateway', loginHint: '這是進階的反向功能，要 Grok Bot App 開放本機連線才會列出機器人（目前 Windows 版通常沒有，出現錯誤是正常的）。這不影響「Grok Bot 交派任務給 OCTA」，那個用交接網址就好' },
  opencode: { label: 'Ollama 本機模型', bin: 'opencode', also: 'ollama', site: 'https://ollama.com', npm: 'opencode-ai',
    pre: { win: 'winget install -e --id Ollama.Ollama --accept-source-agreements --accept-package-agreements', mac: 'brew install --cask ollama' },
    paths: { win: '%LOCALAPPDATA%\\Programs\\Ollama', mac: '/usr/local/bin' },
    login: 'ollama pull qwen3', loginHint: '正在下載 qwen3 模型（約 5 GB），完成後機器人的「模型」填 qwen3。要讓機器人看得懂網頁畫面，可再執行 ollama pull qwen3-vl:8b。第一次操作瀏覽器時 OCTA 會自動安裝 browser-use（有 uv 會自動準備 Python 3.12；沒有就用電腦上 3.11–3.13 的 Python，沒有會自動裝）' }
};
const BASE_INSTR = '請先完整讀取目前資料夾裡的 octa-task.md，依照裡面的指示執行。最後的輸出要直接是給使用者看的回覆。';
const STDIN_INSTR = '請依照標準輸入中的完整指示執行，最後輸出要給使用者看的回覆。';
// Windows consoles often answer in the local code page (e.g. Big5), not UTF-8
export function decode(chunks) {
  const buf = Buffer.concat(chunks), utf = buf.toString('utf8');
  if (!WIN || !utf.includes('�')) return utf;
  for (const enc of ['big5', 'gbk', 'shift_jis']) { try { const t = new TextDecoder(enc).decode(buf); if (!t.includes('�')) return t; } catch { } }
  return utf;
}
export const installed = {};
// Windows: tools installed after OCTA started aren't on its PATH; re-read the saved PATH now and then
let pathRead = 0;
export function refreshPath() {
  if (!WIN || Date.now() - pathRead < 120000) return Promise.resolve();
  pathRead = Date.now();
  return new Promise(ok => execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')"],
    { windowsHide: true, timeout: 20000 }, (err, out) => {
      if (!err && out) {
        const have = new Set(String(process.env.PATH || '').toLowerCase().split(';'));
        const more = String(out).trim().split(';').map(p => p.replace(/%([^%]+)%/g, (_, v) => process.env[v] || '')).filter(p => p && !have.has(p.toLowerCase()));
        if (more.length) process.env.PATH = process.env.PATH + ';' + more.join(';');
      }
      ok();
    }));
}
// looks through PATH itself instead of running `where` for each tool: running many `where` at once
// sometimes timed out on Windows, which made AIs flip between connected and not connected
export function findBin(bin) {
  const dirs = String(process.env.PATH || '').split(WIN ? ';' : ':').filter(Boolean);
  const exts = WIN ? ['', ...String(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').toLowerCase().split(';').filter(Boolean)] : [''];
  for (const d of dirs) for (const x of exts) { const p = join(d.replace(/^"|"$/g, ''), bin + x); try { if (existsSync(p) && (WIN ? x !== '' : true)) return p; } catch { } }
  return '';
}
// async on purpose: a blocking check freezes the desktop app's window
export async function has(bin, fresh) {   // a missing command can't be told apart from a failing one after the fact, so check first
  if (isAbsolute(bin)) return existsSync(bin);
  const c = installed[bin];
  if (!fresh && c && (c.ok || Date.now() - c.t < 30000)) return c.ok;
  if (!c?.ok) await refreshPath();
  const p = findBin(bin);
  installed[bin] = { ok: !!p, t: Date.now(), path: p };
  return !!p;
}
// (4.5: on Windows Grok Bot is not even looked for — grokbot.mjs grokBotUnsupported)
export const engineReady = async (k, fresh) => !(k === 'grokbot' && grokBotUnsupported()) && (await has(ENGINES[k].bin, fresh)) && (!ENGINES[k].also || await has(ENGINES[k].also, fresh))
  && (k !== 'grokbot' || !grokBotEnv().missing);   // Grok Bot: the tool alone isn't enough, the app's sign-in must be readable

// opts.onLine: called with each stdout line (live progress); opts.ctl.kill() stops the run
export async function spawnCli(bin, args, dir, input, opts = {}) {
  if (!(await has(bin))) return { code: -1, out: '', err: '', missing: true };
  return new Promise(resolve => {
    const child = spawn(WIN && /\s/.test(bin) ? `"${bin}"` : bin, WIN ? args.map(q) : args, { cwd: dir, shell: WIN, windowsHide: true });
    const out = [], err = [];
    let killed = '', part = '', done = false, quietTimer = null, fallback = null;
    // On Windows the CLI runs under a shell: child.kill() ended only the shell, the AI (and its browser tool) kept running,
    // held the output pipe open so 'close' never came, and the job's slot stayed taken forever. Kill the whole tree.
    const killTree = () => { try { WIN ? spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true }) : child.kill(); } catch { } };
    const finish = r => { if (done) return; done = true; clearTimeout(timer); clearTimeout(quietTimer); clearTimeout(fallback); resolve(r); };
    const stop = why => { killed = why; killTree(); fallback = setTimeout(() => finish({ code: 1, out: decode(out), err: decode(err) + '\n' + why }), 10000); };
    if (opts.ctl) opts.ctl.kill = killTree;
    const maxMs = opts.maxMs || opts.ctl?.maxMs || JOB_TIMEOUT_MS;
    const timer = setTimeout(() => stop(`執行超過 ${Math.round(maxMs / 60000)} 分鐘（單件工作最長時間），已中止。`), maxMs);
    // a tool that never answers (e.g. a browser page frozen by a dialog): nothing comes out for minutes
    const quiet = () => {
      if (!opts.quietMs) return;
      clearTimeout(quietTimer);
      quietTimer = setTimeout(() => stop(`AI 超過 ${Math.round(opts.quietMs / 60000)} 分鐘沒有任何動靜，很久沒有回應，已中止。`), opts.quietMs);
    };
    quiet();
    child.stdout.on('data', d => {
      quiet();
      out.push(d);
      if (!opts.onLine) return;
      part += d.toString('utf8');
      let i; while ((i = part.indexOf('\n')) >= 0) { const l = part.slice(0, i); part = part.slice(i + 1); try { opts.onLine(l); } catch { } }
    });
    let epart = '';
    child.stderr.on('data', d => {
      err.push(d);
      if (!opts.onErrLine) return;
      quiet();
      epart += d.toString('utf8');
      let i; while ((i = epart.indexOf('\n')) >= 0) { const l = epart.slice(0, i); epart = epart.slice(i + 1); try { opts.onErrLine(l); } catch { } }
    });
    child.on('error', e => finish({ code: -1, out: decode(out), err: e.message, missing: e.code === 'ENOENT' }));
    child.on('close', code => finish({ code: killed ? (code || 1) : code, out: decode(out), err: decode(err) + (killed ? '\n' + killed : '') }));
    // the shell ended but something it started still holds the pipe: don't wait on it
    child.on('exit', code => setTimeout(() => finish({ code: killed ? (code || 1) : code, out: decode(out), err: decode(err) + (killed ? '\n' + killed : '') }), 5000));
    child.stdin.on('error', () => { });
    child.stdin.end(input);
  });
}
// tokens a run used: Claude reports them in its result; Codex prints "tokens used"
export const claudeTokens = u => (u ? (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) : null);
const toml = v => (Array.isArray(v) ? '[' + v.map(x => JSON.stringify(String(x))).join(',') + ']' : JSON.stringify(String(v)));
const PARENT_TOOLS = 'WebFetch,WebSearch,Read,Write,Edit,Glob,Grep';
const WORKER_TOOLS = 'mcp__browser,Read';
export const PARENT_ALLOWED = PARENT_TOOLS + ',Bash';   // Bash: call a site's API (curl / node fetch) and compute lists from record files
// 4.7 瀏覽器同一輪直接操作: the main turn also gets the bot's own browser (Playwright MCP on its CDP port)
export const DIRECT_ALLOWED = PARENT_ALLOWED + ',mcp__browser';
// which AI tools work the browser themselves in the main turn, and which still hand it to a separate round (【派瀏覽】):
// Ollama/OpenCode: a small local model can't carry the tool list in its context — browser-use (or an OpenCode MCP round) does the page;
// Grok Bot works on xAI's cloud computer, not this computer's browser.
export const DIRECT_BROWSE = ['claude', 'codex', 'gemini', 'qwen', 'copilot', 'cursor', 'grok'];
export const browseKind = engine => (DIRECT_BROWSE.includes(engine || 'claude') ? 'direct' : engine === 'grokbot' ? 'none' : 'relay');
// 省 token: --allowedTools only pre-approves; every built-in tool (Agent, TodoWrite, NotebookEdit…) and every installed
// skill / slash command is still described to the model on each request. When this Claude Code supports them, load only
// the tools a bot can use (Bash stays: bots compute lists from their record files) and skip skills and slash commands.
export let claudeFlags = null;
export function leanFlags(help, worker) {
  const out = [];
  if (/--tools\b/.test(help)) out.push('--tools', worker ? 'Read' : PARENT_TOOLS + ',Bash');
  if (/--disable-slash-commands/.test(help)) out.push('--disable-slash-commands');
  return out;
}
export async function claudeLean(worker) {
  if (claudeFlags === null) {
    claudeFlags = await new Promise(res => execFile('claude', ['--help'], { shell: WIN, windowsHide: true, timeout: 20000, maxBuffer: 1 << 20 }, (e, out) => res(String(out || ''))));
    if (!claudeFlags) setTimeout(() => { claudeFlags = null; }, 600000);   // try again later rather than never
  }
  return leanFlags(claudeFlags, worker);
}
// what a local model can do, from `ollama show` ("Capabilities: completion, tools, vision, thinking")
// what Claude Code is doing right now, in words, from its stream-json events
export function describeTool(name, input = {}) {
  const n = String(name).replace(/^mcp__browser__/, '');
  const host = u => { try { return new URL(u).host; } catch { return String(u || '').slice(0, 40); } };
  const short = s => String(s || '').replace(/\s+/g, ' ').slice(0, 40);
  // what was clicked, in words (a bare snapshot ref like e12 / f1e8 says nothing to a person)
  const what = i => { const w = String(i.element || i.target || '').trim(); return /^[a-z]{0,2}\d+(e\d+)?$/i.test(w) ? '' : short(w); };
  return ({
    browser_navigate: `打開 ${host(input.url)}`, browser_click: what(input) ? `點擊「${what(input)}」` : '點擊', browser_type: what(input) ? `在「${what(input)}」輸入` : '輸入文字',
    browser_fill_form: '填寫表單', browser_snapshot: '讀取網頁內容', browser_take_screenshot: '截圖', browser_select_option: '選擇選項',
    browser_tabs: '切換分頁', browser_wait_for: '等待網頁載入', browser_press_key: '按鍵盤', browser_navigate_back: '回上一頁', browser_evaluate: '讀取網頁資料',
    Read: `讀取檔案 ${basename(String(input.file_path || ''))}`, Write: `寫入檔案 ${basename(String(input.file_path || ''))}`, Edit: `修改檔案 ${basename(String(input.file_path || ''))}`,
    Glob: '找檔案', Grep: '搜尋檔案內容', ToolSearch: '準備工具', Bash: '執行指令', WebSearch: `上網搜尋「${short(input.query)}」`, WebFetch: `讀取網頁 ${host(input.url)}`
  })[n] || (n.startsWith('browser_') ? '操作瀏覽器' : `使用 ${n}`);
}
// one Claude Code stream-json event → progress (tool in words, 🧭 steps from its text), what tools returned, and 暫停:
// a tool's result just came back, so the last action is finished and the next one hasn't started — the step boundary
export function claudeEvent(e, live, stopHere) {
  if (e.type === 'assistant') for (const c of e.message?.content || []) {
    if (c.type === 'tool_use') { live.tool?.(c.name, c.input); live.progress?.(describeTool(c.name, c.input), toolKindOf(c.name)); }
    else if (c.type === 'text' && c.text?.trim()) { live.say?.(c.text); live.progress?.('整理回覆中', 'think'); }
  }
  if (e.type === 'user') {
    for (const c of e.message?.content || []) if (c.type === 'tool_result') {
      const t = Array.isArray(c.content) ? c.content.map(x => x.text || '').join('\n') : String(c.content || '');
      if (t) live.seen?.(t);
    }
    if (live.pauseNow?.()) stopHere();
  }
}
const toolKindOf = name => (/^(mcp__browser__)?browser_/.test(String(name)) ? 'browse' : 'tool');
// bots without a chosen model run on Sonnet: the CLI default on Max is Opus, which burns the shared Claude quota several times faster
const CLAUDE_DEFAULT_MODEL = 'sonnet';
// live: { browser (the bot's browser server goes to this run), worker (a 【派瀏覽】 round: only the browser and Read), files,
//   port, progress(text, kind), say(text) (the AI's own words, for 🧭 steps), tool(name, input), seen(text) (what a tool returned),
//   pauseNow() (暫停 was pressed: stop at the next step boundary), session ({ id, resume }: Claude's session, so a pause can go on), ctl }
export async function runEngine(engine, prompt, b, model, live = {}) {
  let tokens = null;
  const useBrowser = live.browser === true, worker = useBrowser && live.worker === true, { dir } = b, server = b.serverFor ? b.serverFor(useBrowser && live.files) : b.server;
  // the AI's printed lines (CLIs without an event stream): only the 🧭 step marks are read from them
  const lines = live.say ? { onLine: l => live.say(l), onErrLine: l => live.say(l) } : {};
  if (b.applyBrowser) b.applyBrowser(useBrowser, live.files);
  const store = storeDir();
  const m = (flag) => (model ? [flag, model] : []);
  writeFileSync(join(dir, 'octa-task.md'), prompt);
  // some CLIs treat another folder as "current" (agy: the store): always give the full path
  const FILE_INSTR = BASE_INSTR.replace('目前資料夾裡的 octa-task.md', `檔案 ${join(dir, 'octa-task.md')}（用讀檔工具讀這個完整路徑）`);   // for CLIs that take the prompt as an argument (avoids Windows length limits)
  let r, text, paused = false;
  switch (engine) {
    case 'codex': {
      const last = join(dir, '.codex-last.txt');
      try { writeFileSync(last, ''); } catch { }
      const c = ['approval_policy="never"', 'model_reasoning_effort="high"', `sandbox_workspace_write.writable_roots=${toml([store, dir])}`,
        ...(useBrowser ? [`mcp_servers.browser.command=${toml(server.command)}`, `mcp_servers.browser.args=${toml(server.args)}`,
          'mcp_servers.browser.startup_timeout_sec=60', 'mcp_servers.browser.default_tools_approval_mode="approve"',
          ...Object.entries(server.env || {}).map(([k, v]) => `mcp_servers.browser.env.${k}=${toml(v)}`)] : [])];
      const codex = sandbox => spawnCli('codex', ['exec', '--skip-git-repo-check', '--sandbox', sandbox, '-C', dir, '-o', last,
        ...m('-m'), ...c.flatMap(x => ['-c', x]), '-'], dir, prompt, { ctl: live.ctl, ...lines });
      r = await codex('workspace-write');
      // Codex's sandbox isn't available on every Windows setup: run without it rather than not at all (other engines run unsandboxed too)
      if (r.code !== 0 && /sandbox/i.test(r.err || '')) r = await codex('danger-full-access');
      try { text = readFileSync(last, 'utf8').trim(); } catch { }
      break;
    }
    case 'gemini': r = await spawnCli('agy', ['-p', FILE_INSTR, '--dangerously-skip-permissions', '--output-format', 'text',
      '--print-timeout', Math.round((live.ctl?.maxMs || JOB_TIMEOUT_MS) / 60000) + 'm', '--add-dir', store, ...m('--model')], dir, '', { ctl: live.ctl, ...lines }); break;
    case 'qwen': r = await spawnCli('qwen', ['--yolo', '--include-directories', store, ...m('-m'), '-p', STDIN_INSTR], dir, prompt, { ctl: live.ctl, ...lines }); break;
    case 'copilot': r = await spawnCli('copilot', ['-p', FILE_INSTR, '-s', '--allow-all-tools', '--allow-all-paths', '--no-color',
      '--additional-mcp-config', '@' + join(dir, 'copilot-mcp.json'), ...m('--model')], dir, '', { ctl: live.ctl, ...lines }); break;
    case 'grok': r = await spawnCli('grok', ['--no-auto-update', '--no-alt-screen', '--always-approve', '--cwd', dir,
      '--output-format', 'plain', ...m('-m'), '-p', FILE_INSTR], dir, '', { ctl: live.ctl, ...lines }); break;
    case 'cursor': r = await spawnCli('agent', ['-p', '--force', '--approve-mcps', '--output-format', 'text', ...m('--model'), FILE_INSTR], dir, '', { ctl: live.ctl, ...lines }); break;
    case 'opencode': {
      if (!(await has('ollama'))) { r = { missing: true }; break; }
      const name = ollamaModel(model);
      if (!name) return { ok: false, text: '⚠ 這台電腦的 Ollama 還沒有下載任何模型。請在「AI 連線 → Ollama」按「一鍵安裝並登入」，或在終端機執行 ollama pull qwen3。' };
      const caps = ollamaCaps(name);
      if (caps && !caps.has('tools')) return { ok: false, text: NO_TOOLS_TEXT(name) };
      const bu = useBrowser && live.port ? browserUseReady() : null;
      if (bu) {
        const out = join(dir, '.browseruse-out.txt');
        try { writeFileSync(out, ''); } catch { }
        r = await spawnCli(bu.python, ['-I', bu.script, '--task', join(dir, 'octa-task.md'), '--out', out, '--cdp', `http://127.0.0.1:${live.port}`,
          '--model', name, '--ctx', String(OLLAMA_NUM_CTX), '--steps', '25', '--vision', caps?.has('vision') ? '1' : '0'], dir, '', {
          ctl: live.ctl, quietMs: 8 * 60000,
          onLine: l => { const s = l.match(/^OCTA_STEP\s+(\d+)\s+(\S+)/); if (s) live.progress?.(`第 ${s[1]} 步：${BU_WORDS[s[2].split(',')[0]] || '操作瀏覽器'}`); }
        });
        try { text = readFileSync(out, 'utf8').trim(); } catch { }
        if (!text && r.code === 0) text = String(r.out || '').split('\n').filter(l => !/^OCTA_STEP/.test(l)).join('\n').trim();
        break;
      }
      const runName = ensureOllamaContext(name);
      // only the local Ollama provider is enabled: no paid APIs
      b.put('opencode.json', {
        $schema: 'https://opencode.ai/config.json', enabled_providers: ['ollama'], model: 'ollama/' + runName,
        provider: { ollama: { npm: '@ai-sdk/openai-compatible', name: 'Ollama', options: { baseURL: 'http://127.0.0.1:11434/v1' }, models: { [runName]: { name: runName } } } },
        mcp: useBrowser ? { browser: { type: 'local', command: [server.command, ...server.args], environment: server.env || {}, enabled: true } } : {},
        tools: { task: false, todowrite: false, todoread: false, grep: false, glob: false }   // grep/glob need ripgrep, often missing on Windows; small local models misuse sub-agents and to-do lists, then reply about the error
      });
      // /no_think: qwen3-style models skip their long hidden reasoning (several times faster on a laptop)
      r = await spawnCli('opencode', ['run', '--auto', '--dir', dir, '-m', 'ollama/' + runName, '/no_think ' + FILE_INSTR], dir, '', { ctl: live.ctl });
      break;
    }
    default: {
      // stream-json: lets OCTA show what the bot is doing while it works
      let result = null;
      const ses = live.session;
      let sesSeen = '';
      r = await spawnCli('claude', ['-p', '--output-format', 'stream-json', '--verbose',
        '--mcp-config', join(dir, useBrowser ? 'mcp-browser.json' : 'mcp.json'), '--strict-mcp-config',
        '--add-dir', store, '--model', model || CLAUDE_DEFAULT_MODEL,
        ...(ses?.id ? (ses.resume ? ['--resume', ses.id] : ['--session-id', ses.id]) : []),
        '--allowedTools', worker ? WORKER_TOOLS : useBrowser ? DIRECT_ALLOWED : PARENT_ALLOWED, ...(await claudeLean(worker))], dir, prompt, {
        ctl: live.ctl, quietMs: QUIET_MS,
        onLine: l => {
          let e; try { e = JSON.parse(l); } catch { return; }
          if (e.type === 'system' && e.session_id) sesSeen = e.session_id;   // (a resumed session may get a new id)
          claudeEvent(e, live, () => { paused = true; live.ctl?.kill?.(); });
          if (e.type === 'result') result = e;
        }
      });
      if (paused) return { ok: false, paused: true, session: sesSeen || ses?.id, text: '', tokens: result ? claudeTokens(result.usage) : null };
      if (result) { text = String(result.result || '').trim(); if (result.is_error && r.code === 0) r.code = 1; tokens = claudeTokens(result.usage); }
      else if (r.out && r.out.trim().startsWith('{')) text = '';   // stream with no result: fall back to the error output
    }
  }
  text = keepBrowserTask((text || r.out || '').replace(/\x1b\[[0-9;]*m/g, ''));
  // agy prints the model's running commentary too ("Let me read…"): keep the reply, drop English narration lines before it
  if (engine === 'gemini' && /[\u4e00-\u9fff]/.test(text)) {
    const narration = /^\s*(Let me|Let's|I'll|I will|I see|I need|I'm going|Found it|Now,? |Next,? |First,? |OK,? |Okay|Great|Perfect|Looking at|Checking|Reading)\b/i;
    text = text.split('\n').filter(l => !narration.test(l)).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }
  const E = ENGINES[engine] || ENGINES.claude;
  if (r.missing) return { ok: false, text: `⚠ 這台電腦沒有安裝 ${E.label}。請到「AI 連線」安裝並登入（${E.site}），或在任務設定把這個機器人改用其他 AI。` };
  if (tokens == null) { const tm = String((r.err || '') + (r.out || '')).match(/tokens used[:\s]*([\d,]+)/i); if (tm) tokens = +tm[1].replace(/,/g, ''); }
  // Exit 0 with only "流量不夠" is not an answer: report it as a failure so the backup runs.
  const refused = r.code === 0 && replyIsProviderRefusal(text);
  if (r.code === 0 && text && !refused) return { ok: true, text, tokens };
  const quoted = providerFailureText([text, r.err, r.out]);
  if (refused || quoted) return { ok: false, text: refused ? text : quoted };
  return { ok: false, text: `⚠ ${E.label} 執行失敗：` + failText(r, prompt) };
}
// the useful part of a failed run: CLIs like Codex echo the whole prompt into their log, which buried the real error
function failText(r, prompt) {
  let t = String((r.err || '').trim() || (r.out || '').trim()).replace(/\x1b\[[0-9;]*m/g, '');
  if (!t) return '結束碼 ' + r.code;
  const errs = [...new Set(t.split('\n').map(l => l.trim()).filter(l => /^(error|錯誤)\b|^\[?error\]?[:\s]|\berror:\s|exception\b|failed\b/i.test(l)))];
  if (errs.length) return errs.slice(-8).join('\n').slice(-1200);
  const p = String(prompt || '').trim();
  if (p) { const tail = p.slice(-200), i = t.lastIndexOf(tail); if (i >= 0) t = t.slice(i + tail.length).trim() || '（沒有錯誤訊息，結束碼 ' + r.code + '）'; }
  return t.slice(-1200);
}

