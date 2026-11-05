// OCTA runner: constants and the state shared by every runner module.
import os from 'node:os';
import { join } from 'node:path';

export const VERSION = '20.0';
// OpenCode's own system prompt + browser tool schemas run ~16–18K tokens per call (seen in Ollama's server log);
// at 4K/8K Ollama cut every prompt down to ~2K, the model lost its instructions and tools and looped until the job timed out.
export const OLLAMA_NUM_CTX = 24576;
export const GOOGLE_HOME = 'https://www.google.com/';
export const PW_MCP = '@playwright/mcp@0.0.83';
export const WIN = process.platform === 'win32';
export const JOB_TIMEOUT_MS = 60 * 60 * 1000;   // default 單件工作最長時間; the server sends the user's choice as job.maxMin
export const QUIET_MS = 8 * 60 * 1000;   // Claude streams an event at least every step; 8 silent minutes means a tool is stuck
// 4.11 全力模式: one tool call may legitimately run long (a 10-minute Bash, a slow page); silence still ends a stuck run
export const QUIET_FULL_MS = 20 * 60 * 1000;
// 4.11 全力模式, run until done: the runner continues the same session while a turn ends without a result.
// CONT_GUARD continuations in a row with no new action, step, file or (for AIs whose tools are not visible) new words: stuck.
// CONT_MAX is only a last safety net against a runaway loop.
export const CONT_GUARD = 4, CONT_MAX = 60;
// AI 待機 sessions kept at once (least recently used goes first); fewer when the computer is short of memory
export const WARM_MAX = 6, WARM_MAX_LOW_MEM = 3, LOW_MEM_BYTES = 1.5 * 1024 ** 3;
export const CHUNK = 900_000;

// Shared runner state. Other modules read these live bindings; only configure() (called by startRunner) changes them.
export let cfg = {}, workDir = '', MAX = 3;
export let log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);
export function configure(opts) {
  cfg = { ...opts, url: opts.url.replace(/\/+$/, '') };
  workDir = join(opts.home, 'work');
  MAX = Math.max(1, Math.min(+opts.max || 3, 8));
  if (opts.log) log = opts.log;
}

// tools installed after the app started aren't on its PATH yet; add the usual install folders
if (WIN) {
  const add = [
    join(os.homedir(), '.local', 'bin'),
    join(process.env.APPDATA || '', 'npm'),
    join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama'),
    join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs'),
    join(process.env.LOCALAPPDATA || '', 'cursor-agent')
  ];
  process.env.PATH = [...add.filter(p => !(process.env.PATH || '').includes(p)), process.env.PATH].join(';');
}

// quote a command-line argument for Windows' shell
export const q = a => (WIN && /[\s"&|<>^]/.test(a) ? '"' + a.replace(/"/g, '\\"') + '"' : a);
