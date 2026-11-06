// OCTA runner: the file folder (one per bot or group) and each bot's work folder with its AI tool settings.
import { existsSync, mkdirSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, sep } from 'node:path';
import { PW_MCP, WIN, cfg, workDir } from './state.mjs';

// ---------- file folder (attachments, screenshots, outputs) ----------
export const storeDir = () => (cfg.getStore ? cfg.getStore() : cfg.store) || join(cfg.home || '.', 'files');
export const safeName = s => String(s || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+/, '').trim().slice(0, 60) || '未命名';
const shortId = id => String(id).replace(/^g-/, '').replace(/[^\w]/g, '').slice(0, 8);
// one folder per bot or group, named "名稱_編號"; renamed when the bot is renamed
export function convDir(conv) {
  const root = storeDir(), tag = '_' + shortId(conv.id), want = join(root, safeName(conv.name) + tag);
  mkdirSync(root, { recursive: true });
  if (!existsSync(want)) {
    const old = readdirSync(root).find(f => f.endsWith(tag));
    if (old) { try { renameSync(join(root, old), want); } catch { return join(root, old); } }
  }
  for (const sub of ['附件', '截圖', '輸出']) mkdirSync(join(want, sub), { recursive: true });
  return want;
}
export const rel = p => relative(storeDir(), p).split(sep).join('/');
export function freeName(dir, name) {   // don't overwrite: "報表.xlsx" → "報表 (2).xlsx"
  const ext = extname(name), base = name.slice(0, name.length - ext.length);
  let p = join(dir, name);
  for (let i = 2; existsSync(p); i++) p = join(dir, `${base} (${i})${ext}`);
  return p;
}
// ---------- per-bot workspace (browser profile and AI tool settings) ----------
const extToken = () => (cfg.getExtToken ? cfg.getExtToken() : cfg.extToken) || '';
// 4.12: what each bot brings to its AI tool besides the browser: MCP servers from the toolbox, learned skills, its PATH
// (set by chat.mjs before botDir; a 旁聊 folder "<id>-side" uses the bot's own)
export const botExtras = new Map();
const extrasOf = id => botExtras.get(String(id).replace(/-side$/, '')) || { mcp: [], skills: false, env: null };
// mode 'own': the bot's own Chrome profile (separate logins). mode 'mine': the user's real Chrome through the
// Playwright Extension, so saved logins and passwords work; each bot gets its own tab group there.
export function botDir(id, mode = 'own', port = 0) {
  const safe = String(id).replace(/[^\w-]/g, '');
  const dir = join(workDir, 'bots', safe);
  mkdirSync(join(dir, 'shots'), { recursive: true });
  const profile = join(dir, 'profile');
  const mine = mode === 'mine';
  const pwArgs = mine ? ['--extension', '--output-dir', join(dir, 'shots')]
    : port ? ['--cdp-endpoint', `http://127.0.0.1:${port}`, '--caps', 'vision', '--output-dir', join(dir, 'shots')]   // the bot's own browser that stays open
    : ['--browser', 'chrome', '--user-data-dir', profile, '--output-dir', join(dir, 'shots')];
  const env = { ...(cfg.pwCli ? cfg.nodeEnv || {} : {}), ...(mine && extToken() ? { PLAYWRIGHT_MCP_EXTENSION_TOKEN: extToken() } : {}) };
  const server = cfg.pwCli
    ? { command: cfg.nodeBin || process.execPath, args: [cfg.pwCli, ...pwArgs], env }   // bundled (desktop app)
    : WIN ? { command: 'cmd', args: ['/c', 'npx', '-y', PW_MCP, ...pwArgs], env } : { command: 'npx', args: ['-y', PW_MCP, ...pwArgs], env };
  const put = (f, o) => { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), JSON.stringify(o, null, 2)); };
  // The main turn never receives the browser server. A separate file is handed only to the one round that reads the page.
  const extra = extrasOf(id);
  const more = Object.fromEntries((extra.mcp || []).map(m => [m.name, { command: WIN && m.command === 'npx' ? 'cmd' : m.command, args: WIN && m.command === 'npx' ? ['/c', 'npx', ...m.args] : m.args, env: m.env || {} }]));
  writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ mcpServers: more }, null, 2));
  // a round that uploads a file may reach it outside the bot's folder (its conversation folder, the shared OCTA folder)
  const serverFor = files => (files ? { ...server, args: [...server.args, '--allow-unrestricted-file-access'] } : server);
  const applyBrowser = (on, files) => {
    const srv = serverFor(on && files), trusted = { ...Object.fromEntries(Object.entries(more).map(([k, v]) => [k, { ...v, timeout: 60000, trust: true }])), ...(on ? { browser: { ...srv, timeout: 60000, trust: true } } : {}) };
    writeFileSync(join(dir, 'mcp-browser.json'), JSON.stringify({ mcpServers: { ...more, browser: srv } }, null, 2));
    put('.gemini/settings.json', { mcpServers: trusted });
    put('.agents/mcp_config.json', { mcpServers: { ...more, ...(on ? { browser: { ...srv } } : {}) } });   // Antigravity CLI (agy)
    put('.qwen/settings.json', { mcpServers: trusted });
    put('.cursor/mcp.json', { mcpServers: { ...more, ...(on ? { browser: srv } : {}) } });
    put('.mcp.json', { mcpServers: { ...more, ...(on ? { browser: srv } : {}) } });
    put('copilot-mcp.json', { mcpServers: { ...Object.fromEntries(Object.entries(more).map(([k, v]) => [k, { type: 'local', ...v, tools: ['*'] }])), ...(on ? { browser: { type: 'local', ...srv, tools: ['*'] } } : {}) } });
  };
  applyBrowser(false);
  return { dir, profile, server, serverFor, put, applyBrowser, extra, more };
}
export function findChrome() {
  if (cfg.chrome && existsSync(cfg.chrome)) return cfg.chrome;
  const c = WIN ? [
    join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
    join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
    join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe')
  ] : process.platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
    : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'];
  return c.find(p => p && existsSync(p));
}
export function newestImage(dir, since) {
  let best = null;
  const walk = d => {
    for (const f of readdirSync(d)) {
      if (f === 'profile') continue;
      const p = join(d, f), st = statSync(p);
      if (st.isDirectory()) { if (d === dir) walk(p); continue; }
      if (/\.(png|jpe?g|webp)$/i.test(f) && st.mtimeMs >= since && (!best || st.mtimeMs > best.t)) best = { p, t: st.mtimeMs, size: st.size };
    }
  };
  try { walk(dir); } catch { }
  return best;
}
export function newFiles(dir, since) {   // what the bot put in its 輸出 folder during this job
  try {
    return readdirSync(dir).map(f => ({ f, p: join(dir, f) })).filter(x => { const st = statSync(x.p); return st.isFile() && st.mtimeMs >= since; })
      .slice(0, 8).map(x => ({ name: x.f, path: rel(x.p), size: statSync(x.p).size }));
  } catch { return []; }
}
