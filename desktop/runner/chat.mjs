// OCTA runner: a chat job — one turn of a bot, with its browsing and connector rounds.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { stripConnectorTask, takeConnectorTask, toolForBrowse } from '../lib/connectors.mjs';
import { api, saveUpload } from './api-client.mjs';
import { busyBots, cdp, ensureBrowser, pagesOf, setShareBrowser, shareBrowser, syncOut, touchBrowser } from './browser.mjs';
import { has, runEngine } from './engines.mjs';
import { botDir, convDir, freeName, newFiles, newestImage, rel, safeName, storeDir } from './files.mjs';
import { runGrokBot } from './grokbot.mjs';
import { browserSnapshot, captureEyes, finishBrowserWindow, pushLive, settleBrowserWindow } from './live.mjs';
import { browserUseReady } from './ollama.mjs';
import {
  buildBrowserPrompt, evidenceText, findUploads, fitLocal, forcedBrowseTask, hideSecrets, notesFile,
  planBrowserRound, refreshNotes, saveRecord, scrubNotes, stripBrowserTask, takeBrowserTask, taskPrompt
} from './prompts.mjs';
import { resetReports } from './reports.mjs';
import { cfg, log, workDir } from './state.mjs';
import { collectSkills, restoreSkills } from './transfer.mjs';
import { sessions, warmClaude, warmSend } from './warm.mjs';

// ---------- job handlers ----------
export async function chatJob(job) {
  setShareBrowser(job);
  return chatRun(job);
}
async function chatRun(job) {
  // 旁聊 beside the bot's running work: no browser, no AI 待機 session, its own folder (the work's octa-task.md stays untouched)
  const side = !!job.side;
  if (side) job.warm = 0;
  const own = job.bot.browser !== 'mine';
  let port = 0;
  if (own && !side && job.bot.engine !== 'grokbot') { try { port = await ensureBrowser(job.bot); } catch (e) { log('瀏覽器：' + e.message); } }   // a Grok Bot works on xAI's cloud computer
  const b = botDir(side ? job.bot.id + '-side' : job.bot.id, side ? 'own' : job.bot.browser, port), { dir } = b;
  const here = convDir(job.conv || job.bot);
  if (port) busyBots.add(job.bot.id);
  for (const h of job.history) {   // attachments: already in the folder, or saved there now
    h.paths = [];
    for (const f of h.files || []) {
      try {
        const p = f.path ? join(storeDir(), f.path) : null;
        if (p && existsSync(p)) { h.paths.push(p); continue; }
        if (!f.path) { h.paths.push(await saveUpload({ ...f, conv: job.conv?.id || job.bot.id, convName: job.conv?.name || job.bot.name })); continue; }
        // made on another computer: get a copy through OCTA (that computer sends it) and keep it here
        const d = await api('file/' + encodeURIComponent(f.id), undefined, 'GET');
        mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, Buffer.from(d.data || '', 'base64')); h.paths.push(p);
        log(`📥 從其他電腦取得：${f.path}`);
      } catch (e) { log('附件讀取失敗：' + e.message); }
    }
  }
  restoreSkills(dir, job.nskills);
  const start = Date.now() - 1000;
  log(`${side ? '💬' : '▶'} ${job.bot.name}［${job.bot.engine || 'claude'}］${job.group ? ' @' + job.group.name : ''}：${job.prompt.slice(0, 40)}`);
  job.bot.livePort = port;
  // the open tabs and the picture of the page at the same time (each is a CDP round trip)
  const openTabs = async send => (await pagesOf(send)).filter(p => !/^(about:blank|chrome:)/.test(p.url)).slice(0, 6)
    .map(p => ({ title: p.title.slice(0, 80), url: p.url.slice(0, 200) }));
  const [tabs, eyes] = port
    ? await Promise.all([cdp(port, openTabs).catch(() => undefined), captureEyes(port, dir)])
    : [undefined, ''];
  if (tabs) job.bot.tabs = tabs;
  job.eyes = eyes;
  // live progress (at most every 4 s); if the user pressed 停止, the server says so and the run is stopped
  const ctl = { maxMs: job.maxMin ? job.maxMin * 60000 : undefined };   // 單件工作最長時間, for every AI tool
  let lastSent = 0, pendingText = '', timerP = null, stoppedByUser = false;
  const flush = () => {
    timerP = null; lastSent = Date.now();
    api('runner/progress', { id: job.id, text: pendingText }).then(r => {
      if (r.hand && !side) { job.handed = true; log(`✋ ${job.bot.name}：使用者接手，停止點擊`); ctl.kill?.(); }
      if (r.stop) { stoppedByUser = true; log(`■ ${job.bot.name}：使用者按了停止`); ctl.kill?.(); }
    }).catch(() => { });
  };
  const progress = t => { pendingText = t; if (timerP) return; const wait = Math.max(0, 4000 - (Date.now() - lastSent)); timerP = setTimeout(flush, wait); };
  progress('開始工作');
  const beat = setInterval(() => { if (!timerP) flush(); }, 15000);   // also notices 停止 for AIs that don't report progress
  let res;
  const engine = job.bot.engine || 'claude';
  job.stopForHand = () => ctl.kill?.();
  const liveBeat = port ? setInterval(() => pushLive(port, job).catch(() => { }), 1500) : null;
  try {
    if (port) await settleBrowserWindow(port, job);
    if (!side) refreshNotes(job);
    res = engine === 'grokbot' ? await runGrokBot(job, { progress, ctl })
      : engine === 'claude' && job.warm && (await has('claude'))
      ? await warmClaude(job, b, here, { progress, ctl })        // AI 待機: reuse the running Claude session
      : await runEngine(engine, taskPrompt(job, here), b, job.bot.model, { progress, ctl, browser: false });
    if (res?.ok && engine !== 'grokbot') {
      const pendingBrowser = takeBrowserTask(res.text);
      res = await connectorRounds(job, b, here, engine, res, { progress, ctl });
      if (pendingBrowser && res?.ok && !takeBrowserTask(res.text)) res = { ...res, text: `【派瀏覽】\n網址：${pendingBrowser.url || '目前頁面'}\n要做的事：${pendingBrowser.prompt}\n【派完】\n${stripConnectorTask(res.text)}` };
      if (side) {   // a page to look at waits until the work is done: the server runs this message again then
        if (res?.ok && (takeBrowserTask(res.text) || /【稍後】/.test(res.text))) { job.later = true; res = { ...res, text: stripBrowserTask(res.text).replace(/^\s*【稍後】\s*$/gm, '').trim() || '好，手上這件做完我就接著做。' }; }
      } else res = await browseRounds(job, b, here, engine, res, { progress, ctl, port });
      const again = res?.ok && port && !job.handed && !/需要使用者在電腦上登入/.test(res.text || '') ? forcedBrowseTask(job) : null;
      if (again) {
        res = { ...res, text: `【派瀏覽】\n網址：目前頁面\n要做的事：${again}\n【派完】` };
        res = await browseRounds(job, b, here, engine, res, { progress, ctl, port });
      }
    }
  }
  finally { clearTimeout(timerP); clearInterval(beat); clearInterval(liveBeat); if (port) { busyBots.delete(job.bot.id); touchBrowser(job.bot.id); } }
  if (job.handed && res) { res.ok = true; res.text = '我先停手。你在旁邊的畫面登入或看完，按繼續我就重新讀頁再做。'; }
  if (res?.text) res.text = hideSecrets(stripConnectorTask(stripBrowserTask(res.text)), job) || '這次沒有新的結果。';
  if (port && res?.text) res.text = await finishBrowserWindow(port, job, res.text);
  if (port && shareBrowser) await syncOut(port);
  // 📒工作筆記：…📒結束 — the bot couldn't write its notes file itself (sandbox): OCTA saves it
  if (res?.text) res.text = res.text.replace(/📒\s*工作筆記[:：]\s*([\s\S]*?)📒\s*結束/g, (_, n) => {
    try {
      const cleanNotes = scrubNotes(n, evidenceText(job)).text;
      if (!cleanNotes) return '';
      mkdirSync(dirname(notesFile(job)), { recursive: true });
      writeFileSync(notesFile(job), cleanNotes + '\n');
      log(`📒 已更新 ${job.bot.name} 的工作筆記`);
    } catch (e) { log('工作筆記寫入失敗：' + e.message); }
    return '';
  }).trim() || '（已更新工作筆記）';
  if (!side) refreshNotes(job);
  // what the browser shows now: taken by OCTA itself (no need for the bot to remember)
  let page = (res.text.match(/📍\s*目前頁面[:：]\s*(\S+)/) || [])[1];
  const d = new Date(), z = n => String(n).padStart(2, '0'), stamp = `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}`;
  // a failed run (or one waiting for a sign-in) also sends its screen once, for the Telegram notification
  let shotB64 = null;
  const saveShot = async (buf, ext) => {
    const p = freeName(join(here, '截圖'), safeName(job.bot.name) + '-' + stamp + ext);
    writeFileSync(p, buf);
    await api('runner/shot', { id: job.id, path: rel(p), name: basename(p), size: buf.length });
    if ((!res.ok || /需要使用者在電腦上登入/.test(res.text || '')) && /^\.jpe?g$/.test(ext) && buf.length < 600000) shotB64 = buf.toString('base64');
  };
  try {
    const live = port ? await browserSnapshot(port, start) : null;
    if (live) { if (live.url && !/^(about:|chrome:)/.test(live.url)) page = live.url; if (live.jpeg) await saveShot(live.jpeg, '.jpeg'); }
    else { const shot = newestImage(dir, start); if (shot) await saveShot(readFileSync(shot.p), extname(shot.p).toLowerCase()); }
  } catch (e) { log('截圖儲存失敗：' + e.message); }
  const nsk = collectSkills(dir, job.nskills);
  await api('runner/done', {
    id: job.id, ok: res.ok, text: res.text, page, tokens: res.tokens ?? null,
    files: res.ok ? newFiles(join(here, '輸出'), start) : [], browser: !!port, stopped: stoppedByUser,
    ...(job.later ? { later: true } : {}), ...(nsk ? { nskills: nsk } : {}),
    ...(res.stalled ? { stalled: true, err_kind: 'timeout' } : {}), ...(shotB64 ? { shot: shotB64 } : {})
  });
  log(`${res.ok ? '✓' : '✗'} ${job.bot.name}`);
  if (['claude', 'codex'].includes(job.bot.engine || 'claude')) resetReports({ engines: false, models: false });   // refresh how much is left
  try { cfg.onDone?.(job, res); } catch { }
}

// The main turn cannot click. A logged-in page is one extra round on the same browser, then a text report.
function addTokens(a, b) {
  if (a == null && b == null) return null;
  return (a || 0) + (b || 0);
}
async function parentFollow(job, b, here, engine, follow, live) {
  if (b.applyBrowser) b.applyBrowser(false);
  if (engine === 'claude' && job.warm && sessions.get(job.bot.id)) return warmSend(job, follow, live);
  return runEngine(engine, taskPrompt({ ...job, prompt: follow }, here), b, job.bot.model, { progress: live.progress, ctl: live.ctl, browser: false });
}
async function connectorRounds(job, b, here, engine, res, live) {
  for (let depth = 0; depth < 2 && res?.ok; depth++) {
    const task = takeConnectorTask(res.text);
    if (!task) break;
    const known = (job.connectors || []).some(c => c.name === task.name);
    const approved = /核准[:：]/.test(job.prompt || '');
    if (!known || (task.action === '送出' && !approved)) {
      const why = !known
        ? `沒有接上「${task.name}」。已接上的只有：${(job.connectors || []).map(c => c.name).join('、') || '（沒有）'}。不要再寫【連接器】，直接用【回覆】說明。`
        : `「${task.name}」這次沒有送出。對別人送出要先寫 ✅待確認，等使用者回「核准：」再做。不要再寫【連接器】，直接用【回覆】寫出準備送出的內容。`;
      const next = await parentFollow(job, b, here, engine, why, live);
      const text = next?.ok ? (stripConnectorTask(next.text) || why) : why;
      return { ok: true, text, tokens: addTokens(res.tokens, next?.tokens) };
    }
    live.progress?.('呼叫連接器 ' + task.name);
    let report = '連接器沒有完成。';
    try {
      const r = await api('runner/connector', { job: job.id, name: task.name, action: task.action, path: task.path, content: task.content });
      report = stripConnectorTask(r.text || report).slice(0, 4000) || report;
    } catch (e) { report = '連接器沒有完成：' + e.message; }
    const follow = [
      `下面是連接器「${task.name}」的結果。只根據這份結果回答，不要貼金鑰，也不要把整段原文以外的內容說成你看到的。`,
      depth + 1 < 2 ? '還要再呼叫一次就寫【連接器】到【接完】，而且不要寫【回覆】。夠了就用【回覆】回答。' : '不能再呼叫連接器。直接用【回覆】回答。',
      '結果：', report,
      '使用者原本的指示：', job.prompt
    ].join('\n');
    const next = await parentFollow(job, b, here, engine, follow, live);
    const tokens = addTokens(res.tokens, next?.tokens);
    if (!next?.ok) return { ok: true, text: report, tokens };
    let text = next.text || '';
    if (depth + 1 >= 2 || !takeConnectorTask(text)) text = stripConnectorTask(text) || report;
    res = { ok: true, text, tokens };
  }
  if (res?.text) res = { ...res, text: stripConnectorTask(res.text) || '這次沒有新的結果。' };
  return res;
}
const LOGIN_RE = /需要使用者在電腦上登入/;
// what the browse round says it already tried, from its 「卡在哪裡」 part
export const triedText = report => (String(report || '').match(/卡在哪裡[:：]\s*([^\n]+(?:\n(?!網址|頁面上有什麼|做成了什麼)[^\n]+){0,2})/) || [])[1]?.replace(/需要使用者在電腦上登入[。，,]?/g, '').replace(/\s+/g, ' ').trim().slice(0, 200) || '';
async function browseRounds(job, b, here, engine, res, live) {
  const port = live.port, mine = job.bot.browser === 'mine';
  for (let depth = 0; depth < 2 && res?.ok; depth++) {
    const plan = planBrowserRound(res.text, { engine, port, mine, depth });
    if (plan.action === 'keep') break;
    if (plan.action === 'strip') { res = { ...res, text: stripBrowserTask(res.text) || '這次的頁面沒有新的結果。' }; break; }
    if (plan.action === 'work') job.didBrowse = true;
    const viaTool = toolForBrowse(plan.task, job.connectors);
    if (viaTool) {
      const next = await parentFollow(job, b, here, engine, `這件事連接器「${viaTool.name}」做得到。不要開瀏覽器，改寫【連接器】。名稱用「${viaTool.name}」。讀取可以直接做，送出要先 ✅待確認。`, live);
      const text = next?.ok ? (stripBrowserTask(stripConnectorTask(next.text)) || `改用連接器「${viaTool.name}」。`) : `改用連接器「${viaTool.name}」。`;
      return { ok: true, text, tokens: addTokens(res.tokens, next?.tokens) };
    }
    if (job.handed) return { ok: true, text: '我先停手。你在旁邊的畫面登入或看完，按繼續我就重新讀頁再做。', tokens: res.tokens };
    if (plan.action === 'down') {
      const next = await parentFollow(job, b, here, engine, '內建瀏覽器沒有起來，這次不能讀頁面。請用你已經有的資料回答，或直接說瀏覽器沒有打開。不要再派瀏覽。', live);
      const text = next?.ok ? (stripBrowserTask(next.text) || '瀏覽器沒有打開，這次沒有讀到頁面。') : '瀏覽器沒有打開，這次沒有讀到頁面。';
      return { ok: true, text, tokens: addTokens(res.tokens, next?.tokens) };
    }
    live.progress?.('讀取網頁');
    // a file to upload: its full path goes with the task, and that round may read outside the bot's folder
    const sending = /上傳|附上|附加|夾帶|傳(給|送|到)|寄|upload|attach/i.test(plan.task.prompt);
    const ups = sending ? findUploads(`${plan.task.prompt}\n${job.prompt}`, [here, join(workDir, 'bots', String(job.bot.id).replace(/[^\w-]/g, '')), storeDir()]) : [];
    if (ups.length) plan.task = { ...plan.task, prompt: plan.task.prompt + '\n要上傳的檔案（完整路徑）：' + ups.join('、') };
    const files = sending;
    const work = async task => {
      const prompt = engine === 'opencode' ? fitLocal(buildBrowserPrompt(job, task, here, { plain: !!(port && !mine && browserUseReady()) }), 4000) : buildBrowserPrompt(job, task, here);
      const w = await runEngine(engine, prompt, b, job.bot.model, { progress: live.progress, ctl: live.ctl, browser: true, files, port });
      if (b.applyBrowser) b.applyBrowser(false);
      return { w, report: hideSecrets(stripBrowserTask(w?.ok ? w.text : ('瀏覽沒有完成：' + String(w?.text || '沒有報告'))), job).slice(0, 6000) || '瀏覽沒有完成。' };
    };
    let { w: worker, report } = await work(plan.task), wTokens = worker?.tokens;
    // logged out: one more round only to log back in (remembered account, 「LINE 登入」, a password from 共用資料), then the task
    if (LOGIN_RE.test(report) && !job.relogin && !job.handed) {
      job.relogin = true;
      live.progress?.('自己重新登入');
      const again = await work({ url: plan.task.url, prompt: `上一輪停在登入頁（${triedText(report) || '沒寫試過什麼'}）。這一輪先自己登回去，換上一輪沒試過的方法；登入成功就接著做：${plan.task.prompt}` });
      worker = again.w; report = again.report; wTokens = addTokens(wTokens, worker?.tokens);
    }
    job.seen = ((job.seen || '') + '\n' + report).slice(-8000);
    if (LOGIN_RE.test(report)) {
      const site = (report.match(/https?:\/\/[^\s）)]+/) || [])[0] || '', tried = triedText(report);
      return { ok: true, text: `需要使用者在電腦上登入${site ? '（' + site + '）' : ''}。${tried ? '我先自己試過：' + tried + '。' : '我先自己試過登入，沒有成功。'}登入好之後跟我說一聲。`, tokens: addTokens(res.tokens, wTokens) };
    }
    if (worker?.ok) { const rec = saveRecord(job, plan.task, report); if (rec) report += `\n（這份報告已存成紀錄檔：${rec}）`; }
    if (port) {
      const eyes = await captureEyes(port, b.dir);
      if (eyes) { job.eyes = eyes; report += `\n確認停在哪，用 Read 讀這個檔：${eyes}`; }
    }
    const follow = [
      '下面是單獨一輪瀏覽交回的文字報告。只根據這份報告回答使用者原本的指示，不要把整頁貼上。',
      '報告裡如果寫了「需要使用者在電腦上登入」，回覆裡照抄這幾個字和網站名稱。',
      depth + 1 < 2 ? '報告不夠、還要再看已登入的頁面時，可以再寫一次【派瀏覽】到【派完】，而且不要寫【回覆】。夠了就用【回覆】回答。' : '不能再派瀏覽了。直接用【回覆】根據報告回答。',
      '報告：', report,
      '使用者原本的指示：', job.prompt
    ].join('\n');
    const next = await parentFollow(job, b, here, engine, follow, live);
    const tokens = addTokens(addTokens(res.tokens, wTokens), next?.tokens);
    if (!next?.ok) return { ok: true, text: report, tokens };
    let text = next.text || '';
    if (depth + 1 >= 2 || !takeBrowserTask(text)) text = stripBrowserTask(text) || report;
    res = { ok: true, text, tokens };
  }
  if (res?.text) res = { ...res, text: stripBrowserTask(res.text) || '這次的頁面沒有新的結果。' };
  return res;
}
