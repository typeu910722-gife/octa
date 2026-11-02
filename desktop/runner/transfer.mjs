// OCTA runner: a bot's Claude Code skills and website logins, exported and imported.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { api } from './api-client.mjs';
import {
  addToJar, browsers, cdp, cdpInfo, ensureBrowser, pause, profileInUse, setShareBrowser, shareBrowser,
  sharedProfile
} from './browser.mjs';
import { findChrome } from './files.mjs';
import { CHUNK, log, workDir } from './state.mjs';

// ---------- the bot's own Claude Code skills (.claude/skills in its folder) travel with the account ----------
const SKILL_EXT = /\.(md|txt|json|ya?ml|py|js|mjs|ts|sh|ps1|csv|html|css|toml)$/i;
function skillFiles(root) {
  const out = {}; let total = 0;
  const walk = (d, pre) => { let es = []; try { es = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) { const p = join(d, e.name), r = pre ? pre + '/' + e.name : e.name;
      if (e.isDirectory()) { if (!/^(node_modules|\.git)$/.test(e.name)) walk(p, r); }
      else if (SKILL_EXT.test(e.name)) { try { const st = statSync(p); if (st.size > 60000 || total + st.size > 250000) continue; total += st.size; out[r] = readFileSync(p, 'utf8'); } catch { } } } };
  walk(root, ''); return out;
}
export function collectSkills(dir, had) {
  const files = skillFiles(join(dir, '.claude', 'skills'));
  if (!Object.keys(files).length && !had) return null;
  const h = createHash('sha1').update(JSON.stringify(files)).digest('hex');
  return h === had?.h ? null : { h, files };
}
export function restoreSkills(dir, sk) {   // e.g. on a new host computer
  if (!sk?.files) return;
  for (const [r, text] of Object.entries(sk.files)) {
    if (r.split('/').includes('..')) continue;
    const p = join(dir, '.claude', 'skills', ...r.split('/'));
    try { if (!existsSync(p) || readFileSync(p, 'utf8') !== text) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); } } catch { }
  }
}

// ---------- handing a bot's website logins to another computer (cookies of its own browser) ----------
const SAME_CDP = { Lax: 'Lax', Strict: 'Strict', None: 'None', lax: 'Lax', strict: 'Strict', no_restriction: 'None' };   // the embedded browser used to save Electron's names
export const cookieParams = list => list.filter(c => c.name && c.domain)
  .map(c => ({ name: c.name, value: c.value, path: c.path || '/', secure: !!c.secure, httpOnly: !!c.httpOnly,
    ...(c.domain.startsWith('.') && !c.name.startsWith('__Host-') ? { domain: c.domain } : { url: `${c.secure ? 'https' : 'http'}://${c.domain.replace(/^\./, '')}${c.path || '/'}` }),
    ...(SAME_CDP[c.sameSite] ? { sameSite: SAME_CDP[c.sameSite] } : {}), ...(c.expires > 0 ? { expires: c.expires } : {}), ...(c.partitionKey ? { partitionKey: c.partitionKey } : {}), ...(c.sourceScheme ? { sourceScheme: c.sourceScheme } : {}) }));
// switching to the shared browser: bring the sign-ins from every bot's old browser into it, once
export async function mergeOldProfiles() {   // once: the sign-ins in every bot's browser (and the 2.4.x shared one) go into the shared store
  const mark = join(workDir, '.octa-logins-merged');
  if (existsSync(mark)) return;
  const root = join(workDir, 'bots'), chrome = findChrome();
  const when = p => { for (const f of [join(p, 'Default', 'Network', 'Cookies'), join(p, 'Default', 'Cookies'), p]) { try { return statSync(f).mtimeMs; } catch { } } return 0; };
  let dirs = []; try { dirs = readdirSync(root).map(d => join(root, d, 'profile')).filter(p => existsSync(p)); } catch { }
  if (existsSync(sharedProfile())) dirs.push(sharedProfile());
  dirs.sort((a, b) => when(a) - when(b));   // newest last: its sign-in wins when two have the same site
  const all = []; let n = 0;
  for (const p of dirs) {
    let port = 0;
    for (const [, b] of browsers) if (b.profile === p) port = b.port;   // already open: read it directly
    let child = null;
    if (!port) {
      if (!chrome || profileInUse(p)) continue;
      port = 9390 + (n++ % 9);
      child = spawn(chrome, [`--user-data-dir=${p}`, `--remote-debugging-port=${port}`, '--headless=new', '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore', windowsHide: true });
      child.on('error', () => { });
    }
    try {
      for (let i = 0; i < 40 && !(await cdpInfo(port)); i++) await pause(300);
      const { cookies = [] } = await cdp(port, send => send('Storage.getCookies'));
      all.push(...cookies);
      if (child) await cdp(port, send => send('Browser.close')).catch(() => { });
    } catch (e) { log('讀取舊瀏覽器登入失敗：' + e.message); }
    finally { try { child?.kill(); } catch { } }
  }
  const total = all.length ? addToJar(all) : 0;
  mkdirSync(workDir, { recursive: true }); writeFileSync(mark, String(total));
  const sites = new Set(all.map(c => String(c.domain).replace(/^\./, '').split('.').slice(-2).join('.')));
  if (all.length) log(`🔑 已把各機器人瀏覽器的登入合併成共用登入（${sites.size} 個網站）`);
}

export async function exportJob(job) {
  setShareBrowser(job);
  const port = await ensureBrowser(job.bot);
  const { cookies = [] } = await cdp(port, send => send('Storage.getCookies'));
  const data = Buffer.from(JSON.stringify(cookies)).toString('base64');
  for (let i = 0, n = 0; i < data.length || n === 0; i += CHUNK, n++) await api('runner/xfer', { id: job.id, n, data: data.slice(i, i + CHUNK), last: i + CHUNK >= data.length });
  log(`🔑 已送出 ${job.bot.name} 的網站登入（${cookies.length} 筆）`);
}
export async function importJob(job) {
  setShareBrowser(job);
  const { data } = await api('runner/xfer/' + encodeURIComponent(job.xfer), undefined, 'GET');
  const cookies = cookieParams(JSON.parse(Buffer.from(data || '', 'base64').toString('utf8') || '[]'));
  const port = await ensureBrowser(job.bot);
  await cdp(port, send => send('Storage.setCookies', { cookies }));
  if (shareBrowser) addToJar(cookies);
  const sites = new Set(cookies.map(c => c.domain.replace(/^\./, '').split('.').slice(-2).join('.')));
  log(`🔑 已帶入 ${job.bot.name} 的網站登入（${sites.size} 個網站）`);
  await api('runner/done', { id: job.id, ok: true, text: `已把「${job.bot.name}」的網站登入帶到這台主機（${sites.size} 個網站）。有些網站會綁定裝置，可能還是要再登入一次。` });
}

