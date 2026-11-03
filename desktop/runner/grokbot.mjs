// OCTA runner: Grok Bot (through grok-bot-cli).
import os from 'node:os';
import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import { api } from './api-client.mjs';
import { pause } from './browser.mjs';
import { findBin, has, installed } from './engines.mjs';
import { stopped } from './loop.mjs';
import { JOB_TIMEOUT_MS, WIN, cfg, q } from './state.mjs';

// ---------- 4.5: not on Windows ----------
// The Grok Bot app for Windows never writes gateway-descriptor.json, so grok-bot-cli can't sign in there. On Windows
// nothing here runs (no looking for the tool or the app's files, no tries): the engine reports unavailable with this
// reason, and Grok Bot works the other way round — it hands work to OCTA through a 交接網址.
// (cfg.platform: the tests pretend to be another system)
export const GROKBOT_WIN_TEXT = '⚠ Windows 不支援 Grok Bot：Windows 版的 Grok Bot App 不會產生 gateway-descriptor.json，grok-bot-cli 沒辦法用。請改用交接網址（AI 連線 → Grok Bot），讓 Grok Bot 把工作交給 OCTA 的機器人。';
export const grokBotUnsupported = () => (cfg.platform || process.platform) === 'win32';

// ---------- Grok Bot (through grok-bot-cli) ----------
function jsonOut(text) { const t = String(text || '').trim(); const i = t.search(/[[{]/); if (i < 0) return null; try { return JSON.parse(t.slice(i)); } catch { return null; } }
const pickArr = o => (Array.isArray(o) ? o : o && (o.bots || o.items || o.entries || o.thread || o.messages || o.data || o.results)) || [];
// gbot reads the Grok Bot app's session and asks xAI's gateway: the first call can take a while, and its errors matter
// grok-bot-cli finds the app's sign-in at <APPDATA>/Grok Bot/gateway-descriptor.json; if this copy of the app keeps it
// somewhere else, look for it and point grok-bot-cli there
let gbEnv = null, gbLook = 0;
export function grokBotEnv() {
  if (grokBotUnsupported()) return { missing: '(Windows)', unsupported: true };
  if (Date.now() - gbLook < 5 * 60000) return gbEnv;
  gbLook = Date.now(); gbEnv = null;
  const want = 'gateway-descriptor.json', home = os.homedir();
  const std = WIN ? join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'Grok Bot') : process.platform === 'darwin' ? join(home, 'Library', 'Application Support', 'Grok Bot') : join(process.env.XDG_CONFIG_HOME || join(home, '.config'), 'Grok Bot');
  if (existsSync(join(std, want))) return gbEnv = { found: std };
  const roots = WIN ? [process.env.APPDATA, process.env.LOCALAPPDATA, home, join(home, '.grokbot')] : [join(home, '.config'), join(home, 'Library', 'Application Support'), join(home, '.grokbot')];
  for (const r of roots.filter(Boolean)) {
    let subs = []; try { subs = readdirSync(r, { withFileTypes: true }).filter(d => d.isDirectory() && /grok/i.test(d.name)).map(d => join(r, d.name)); } catch { }
    for (const d of [r, ...subs]) if (existsSync(join(d, want)) && basename(d) === 'Grok Bot') return gbEnv = { found: d, env: WIN ? { APPDATA: dirname(d) } : { XDG_CONFIG_HOME: dirname(d) } };
  }
  return gbEnv = { missing: std };
}
// on Windows run grok-bot-cli's script with node directly: going through gbot.cmd (cmd.exe) mangles messages with line breaks or quotes
function gbotCmd(args) {
  if (WIN) {
    const shim = installed.gbot?.path || findBin('gbot'), mjs = shim && join(dirname(shim), 'node_modules', 'grok-bot-cli', 'dist', 'bin', 'gbot.mjs');
    if (mjs && existsSync(mjs)) return ['node', [mjs, ...args], false];
  }
  return ['gbot', WIN ? args.map(q) : args, WIN];
}
const runGbot = (args, timeout = 90000) => new Promise(ok => { const [cmd, a, shell] = gbotCmd(args); execFile(cmd, a, { shell, windowsHide: true, timeout, encoding: 'utf8', maxBuffer: 8 << 20, env: { ...process.env, ...(grokBotEnv()?.env || {}) } },
  (e, out, err) => ok({ code: e ? (e.code ?? 1) : 0, out: String(out || ''), err: String(err || '') + (e?.killed ? '\n（超過 90 秒沒有回應）' : '') })); });
const gbotError = r => (r.err || r.out).replace(/\x1b\[[0-9;]*m/g, '').trim().split('\n').slice(-6).join('\n').slice(0, 600) || ('結束碼 ' + r.code);
export async function grokBots() {   // [{name, description}] — groups included (they take messages too)
  if (grokBotUnsupported()) throw new Error(GROKBOT_WIN_TEXT.replace(/^⚠ /, ''));
  const where = grokBotEnv();
  if (where.missing) throw new Error(`找不到 Grok Bot 桌面 App 的登入資料（${where.missing}${sep}gateway-descriptor.json）。請在這台電腦打開 Grok Bot App 並登入（用官方安裝版，不是複製來的資料夾），讓它連上一次後再試。`);
  const r = await runGbot(['bots', 'list', '--gateway', '--json']);
  const j = jsonOut(r.out);
  if (j) return pickArr(j).map(b => ({ name: String(b.name || b.title || b.displayName || ''), description: (b.isGroup ? '（群組）' : '') + String(b.description || b.instructions || b.label || '') })).filter(b => b.name);
  if (r.code !== 0) throw new Error('grok-bot-cli 讀取失敗：' + gbotError(r));
  return r.out.split('\n').map(l => l.replace(/\x1b\[[0-9;]*m/g, '').trim()).filter(l => l && !/^(name|bots?)\b/i.test(l)).map(l => ({ name: l.split(/\s{2,}|\t/)[0], description: '' })).filter(b => b.name);
}
const entryText = e => typeof e === 'string' ? e : e.text || e.body || e.markdown || e.message?.text || (Array.isArray(e.content) ? e.content.map(c => c.text || '').join('') : typeof e.content === 'string' ? e.content : '');
const fromUser = e => /^(user|me|human|you)$/i.test(String(e.role || e.author?.type || e.author || e.from || e.sender || e.kind || ''));
export async function runGrokBot(job, live) {
  if (grokBotUnsupported()) return { ok: false, text: GROKBOT_WIN_TEXT + '\n（這台電腦沒有安裝可用的 Grok Bot 連線，所以不會重試）' };   // "這台電腦沒有安裝": a backup AI takes over, no retries
  const name = job.bot.model;
  if (!(await has('gbot'))) return { ok: false, text: '⚠ 這台電腦還沒安裝 grok-bot-cli。請到「AI 連線 → Grok Bot」安裝。' };
  if (!name) return { ok: false, text: '⚠ 這個機器人還沒選擇要帶入的 Grok Bot 機器人，請到任務設定的「模型」選一個。' };
  let cursor = jsonOut((await runGbot(['thread', name, '--json'])).out)?.cursor;
  const msg = [job.prompt, ...job.history.slice(-1).flatMap(h => h.paths?.length ? ['（附件在使用者電腦上：' + h.paths.join('、') + '）'] : [])].join('\n');
  live.progress?.('交給 Grok Bot「' + name + '」處理');
  const sent = await runGbot(['send', name, msg], 120000);
  if (sent.code !== 0) return { ok: false, text: '⚠ 傳給 Grok Bot 失敗：' + ((sent.err || sent.out || '').trim().slice(-800) || '結束碼 ' + sent.code) };
  const got = [], t0 = Date.now();
  let quiet = 0;
  while (Date.now() - t0 < (job.maxMin ? job.maxMin * 60000 : JOB_TIMEOUT_MS) && !stopped) {
    await pause(5000);
    const j = jsonOut((await runGbot(['thread', name, ...(cursor ? ['--after', String(cursor)] : []), '--json'])).out);
    if (!j) continue;
    if (j.cursor) cursor = j.cursor;
    const fresh = pickArr(j).filter(e => !fromUser(e)).map(entryText).filter(x => x && x.trim() && x.trim() !== msg.trim());
    if (fresh.length) { got.push(...fresh); quiet = 0; live.progress?.('Grok Bot 回覆中'); }
    else if (got.length && ++quiet >= 3) break;   // replies stopped for ~15 s
  }
  return got.length ? { ok: true, text: got.join('\n\n') } : { ok: false, text: '⚠ Grok Bot 在時間內沒有回覆，可以在 Grok Bot App 裡看看它的狀況。' };
}
export async function listJob(job) {
  let result;
  if (grokBotUnsupported()) result = JSON.stringify({ error: GROKBOT_WIN_TEXT.replace(/^⚠ /, '') });
  else if (!(await has('gbot', true))) result = JSON.stringify({ error: '這台電腦還沒安裝 grok-bot-cli，請先在「AI 連線 → Grok Bot」按安裝' });
  else try { result = JSON.stringify(await grokBots()); } catch (e) { result = JSON.stringify({ error: e.message }); }
  await api('runner/done', { id: job.id, ok: true, text: result });
}

