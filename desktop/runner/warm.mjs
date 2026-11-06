// OCTA runner: AI 待機 — a Claude Code session kept running between messages; connection tests.
import { spawn } from 'node:child_process';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { api } from './api-client.mjs';
import {
  DIRECT_ALLOWED, ENGINES, PARENT_ALLOWED, allowedFor, claudeEvent, claudeFlags, claudeLean, claudeTokens, decode, has, leanFlags,
  runEngine
} from './engines.mjs';
import { botDir, storeDir } from './files.mjs';
import { GROKBOT_WIN_TEXT, grokBotUnsupported, grokBots } from './grokbot.mjs';
import {
  STEP_RULE, buildPrompt, dayInfo, fullRules, keepBrowserTask, manualLines, mustMarkLines, records, routineLines, seeNow, studioAim,
  tabsNow, turnGuide, whoAmI, workLoop, workNotes
} from './prompts.mjs';
import { resetReports } from './reports.mjs';
import { JOB_TIMEOUT_MS, LOW_MEM_BYTES, QUIET_FULL_MS, VERSION, WARM_MAX, WARM_MAX_LOW_MEM, WIN, log, q } from './state.mjs';

// ---------- AI 待機: keep a Claude Code session running between messages ----------
// The first message sends everything; while the session waits, the next message only sends what's new,
// so there is no restart and nothing to re-read. job.warm: seconds to keep waiting (-1: always).
export const sessions = new Map();   // bot id → { child, fp, lastId, turn, timer }
// now: 暫停 — end it right away (a polite close lets it start the next action in the meantime)
export function closeSession(id, why, now) {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  clearTimeout(s.timer);
  const kill = () => { try { WIN ? spawn('taskkill', ['/pid', String(s.child.pid), '/t', '/f'], { windowsHide: true }) : s.child.kill(); } catch { } };
  if (now) kill();
  else { try { s.child.stdin.end(); } catch { } setTimeout(kill, 4000); }
  if (why) log(`💤 ${why}`);
}
function startSession(job, b) {
  const { dir } = b, m = job.bot.model ? ['--model', job.bot.model] : [];
  const direct = job.browse === 'direct', sid = randomUUID();   // 4.7: the browser is in the session itself; its id lets a pause go on with --resume
  if (b.applyBrowser) b.applyBrowser(direct, direct);
  const child = spawn('claude', (WIN ? a => a.map(q) : a => a)(['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--mcp-config', join(dir, direct ? 'mcp-browser.json' : 'mcp.json'), '--strict-mcp-config', '--add-dir', storeDir(), ...m, '--session-id', sid,
    '--allowedTools', allowedFor(direct ? DIRECT_ALLOWED : PARENT_ALLOWED, b.extra), ...(job.full ? [] : leanFlags(claudeFlags || '', false, !!b.extra?.skills))]), { cwd: dir, shell: WIN, windowsHide: true, ...(b.extra?.env ? { env: b.extra.env } : {}) });
  if (claudeFlags === null && !job.full) claudeLean(false);   // known from the next session on
  const s = { child, turn: null, err: [], sid, botId: job.bot.id, usedAt: Date.now() };
  let part = '';
  child.stdout.on('data', d => {
    s.seenAt = Date.now();
    part += d.toString('utf8');
    let i;
    while ((i = part.indexOf('\n')) >= 0) {
      const l = part.slice(0, i); part = part.slice(i + 1);
      let e; try { e = JSON.parse(l); } catch { continue; }
      if (!s.turn) continue;
      s.turn.heard = true;
      const t0 = s.turn;
      claudeEvent(e, t0.live || {}, () => { t0.paused = true; closeSession(s.botId, null, true); });
      if (e.type === 'assistant') for (const c of e.message?.content || []) if (c.type === 'text' && c.text?.trim()) (t0.parts = t0.parts || []).push(c.text.trim());
      if (!s.turn) continue;
      if (e.type === 'result') {
        const t = s.turn; s.turn = null;
        const raw = String(e.result || '').trim();
        t.done({ ok: !e.is_error && !!raw, text: keepBrowserTask(raw) || '⚠ Claude Code 沒有回覆內容', tokens: claudeTokens(e.usage) });
      }
    }
  });
  child.stderr.on('data', d => { s.err.push(d); if (s.err.length > 50) s.err.shift(); });
  child.stdin.on('error', () => { });
  const gone = msg => {
    for (const [k, v] of sessions) if (v === s) sessions.delete(k);
    clearTimeout(s.timer);
    if (s.turn) {
      const t = s.turn; s.turn = null;
      if (t.paused) return t.done({ ok: false, paused: true, session: s.sid, text: '' });   // 暫停: the runner goes on later with --resume
      t.done({ ok: false, text: '⚠ Claude Code 執行失敗：' + (decode(s.err).trim().slice(-1200) || msg) });
    }
  };
  child.on('error', e => gone(e.message));
  child.on('exit', code => gone('結束碼 ' + code));
  return s;
}
export function warmSend(job, text, live) {
  const s = sessions.get(job.bot.id);
  if (!s?.child) return Promise.resolve({ ok: false, text: '⚠ 沒有正在待機的對話' });
  live.ctl.kill = () => closeSession(job.bot.id, `${job.bot.name}：已停止`);
  s.usedAt = Date.now();
  return turnWithWatch(job, s, text, live).then(r => { s.doneAt = Date.now(); if (!r.ok && sessions.get(job.bot.id) === s) closeSession(job.bot.id); return r; });
}
const WARM_STALE = 20 * 60000;   // reuse a waiting session only if it answered within the last 20 minutes (省額度)
// 4.11 全力模式: a waiting session is kept however long it waits. What made old sessions hang was the computer
// sleeping (the session's connection died), so a sleep is noticed instead: a timer that fires much later than it
// should means the computer was asleep, and every waiting session starts fresh on its next turn.
let tickAt = Date.now();
const sleepWatch = setInterval(() => {
  const gap = Date.now() - tickAt;
  tickAt = Date.now();
  if (gap > 120000) for (const s of sessions.values()) s.slept = true;
}, 30000);
sleepWatch.unref?.();
export const staleSession = (s, job, t = Date.now()) => !!s && !s.turn && (s.slept || (!job.full && s.doneAt && t - s.doneAt > WARM_STALE));
// 4.11: no time limit on standby, so too many waiting sessions are capped instead: the least recently used idle ones go
export function warmCap(keepId, freeMem = os.freemem()) {
  const cap = freeMem < LOW_MEM_BYTES ? WARM_MAX_LOW_MEM : WARM_MAX;
  const idle = [...sessions.entries()].filter(([id, s]) => id !== keepId && !s.turn).sort((a, b) => (a[1].usedAt || 0) - (b[1].usedAt || 0));
  let over = sessions.size + (sessions.has(keepId) ? 0 : 1) - cap;
  for (const [id] of idle) { if (over-- <= 0) break; closeSession(id, `${id}：AI 待機的機器人太多，先讓最久沒用的休息`); }
}
const FIRST_WORD = 180000, QUIET = 360000;   // no sign of life this long → the session is stuck
// what the AI had already written when a run was stopped: sent up with the failure, so finished parts aren't lost
export const PARTIAL_TAG = '【中止前已完成的部分】';
export function partialNote(parts, max = 3000) {
  const t = (Array.isArray(parts) ? parts : [parts]).filter(Boolean).join('\n').trim();
  return t ? `\n\n${PARTIAL_TAG}\n${t.length > max ? '…' + t.slice(-max) : t}` : '';
}
function turnWithWatch(job, s, text, live) {
  return new Promise(done => {
    const started = Date.now();
    s.seenAt = started;
    const end = r => { clearInterval(dog); done(r); };
    s.turn = { done: end, progress: live.progress, live, heard: false };
    const dog = setInterval(() => {
      if (!s.turn) return clearInterval(dog);
      // 不限 (全力模式, maxMin 0): no time limit; silence still means stuck
      const quiet = Date.now() - (s.seenAt || started), limit = job.maxMin ? job.maxMin * 60000 : job.full ? Infinity : JOB_TIMEOUT_MS;
      if (Date.now() - started > limit) {   // the job's own time limit: stop here and keep what is done
        const t = s.turn; s.turn = null;
        closeSession(job.bot.id, `${job.bot.name}：超過單件工作最長時間`);
        t.done({ ok: false, stalled: true, limit: true, text: `⚠ 執行超過 ${Math.round(limit / 60000)} 分鐘（單件工作最長時間），已中止` + partialNote(t.parts, job.full ? 12000 : 3000) });
        return;
      }
      if (quiet > (s.turn.heard ? (job.full ? QUIET_FULL_MS : QUIET) : FIRST_WORD)) {
        const t = s.turn; s.turn = null;
        closeSession(job.bot.id, `${job.bot.name}：AI ${Math.round(quiet / 60000)} 分鐘沒有動靜`);
        t.done({ ok: false, stalled: true, text: '⚠ AI 很久沒有回應，已中止' + partialNote(t.parts, job.full ? 12000 : 3000) });
      }
    }, 10000);
    try { s.child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n'); }
    catch (e) { s.turn = null; end({ ok: false, text: '⚠ ' + e.message }); }
  });
}
export async function warmClaude(job, b, here, live) {
  // anything that changes the bot's standing instructions starts a fresh session
  const fp = JSON.stringify([
    VERSION, job.memory, job.facts, (job.skills || []).map(k => k.name + k.steps), job.bot.task, job.bot.model, job.bot.browser,
    job.bot.livePort, job.browse, job.notes, job.folderNotes, job.group, (job.colleagues || []).map(c => c.name + c.task), job.allowed, job.lang,
    storeDir(), job.conv?.id, job.nick, !!job.full, (job.lskills || []).map(k => k.id), (job.tools || []).map(t => t.id), (job.mcp || []).map(m => m.name)
  ]);
  let s = sessions.get(job.bot.id), text;
  const ids = job.history.map(h => h.id || 0), newest = Math.max(0, ...ids);
  // a session that sat idle a long time (the computer may have slept) can hang on its old connection: start fresh
  if (staleSession(s, job)) { closeSession(job.bot.id, `${job.bot.name}：${s.slept ? '電腦睡眠過' : '待機太久'}，重新開始對話`); s = null; }
  const reused = !!(s && s.fp === fp && s.convId === job.conv?.id);
  if (reused) {
    clearTimeout(s.timer);
    // only what happened since the last turn, then the new instruction
    const fresh = job.history.filter(h => (h.id || 0) > s.lastId && !(h.who === '使用者' && h.text === job.prompt));
    text = [fresh.length ? '（上次之後的新對話）\n' + fresh.map(h => `【${h.who}】${h.text}` + (h.paths?.length ? `\n（附件，可直接讀取這些檔案：${h.paths.join('、')}）` : '')).join('\n') : '',
      dayInfo(job).join('\n'), workNotes(job).join('\n'), records(job).join('\n'), tabsNow(job).join('\n'), seeNow(job).join('\n'),
      workLoop(job).join('\n'), studioAim(job).join('\n'), turnGuide(job), routineLines(job).join('\n'), mustMarkLines(job).join('\n'),
      whoAmI(job), manualLines(job).join('\n').trim(), STEP_RULE, ...fullRules(job), '現在請處理這則指示：', job.prompt].filter(Boolean).join('\n\n');
    log(`⚡ ${job.bot.name}：AI 待機中，直接接續`);
  } else {
    if (s) closeSession(job.bot.id);
    warmCap(job.bot.id);
    s = startSession(job, b);
    s.fp = fp; s.convId = job.conv?.id;
    sessions.set(job.bot.id, s);
    text = buildPrompt(job, here);
  }
  s.lastId = newest; s.usedAt = Date.now();
  live.ctl.kill = () => closeSession(job.bot.id, `${job.bot.name}：已停止`);
  const res = await turnWithWatch(job, s, text, live);
  s.doneAt = Date.now();
  // a compacted chat starts over from memory: the standing session still holds the whole old conversation
  if (String(job.prompt || '').startsWith('（壓縮對話）')) closeSession(job.bot.id, `${job.bot.name}：對話已壓縮，下次從記憶重新開始`);
  if (res.stalled && !res.limit && !String(res.text).includes(PARTIAL_TAG) && !job.stallRetried) {   // (with work done: the server continues from it instead)   // the AI never answered: one fresh try with the full instructions
    job.stallRetried = true;
    log(`⏱ ${job.bot.name}：AI 沒有回應，重新開始一次`);
    live.progress?.('AI 沒有回應，重新開始');
    closeSession(job.bot.id);
    return warmClaude(job, b, here, live);
  }
  if (sessions.get(job.bot.id) === s) {
    if (job.warm > 0) s.timer = setTimeout(() => closeSession(job.bot.id, `${job.bot.name}：待機 ${job.warm} 秒到了，AI 先休息`), job.warm * 1000);
    if (!res.ok) closeSession(job.bot.id);   // start clean after an error
  }
  return res;
}

export async function testJob(job) {
  if (job.engine === 'grokbot' && grokBotUnsupported()) return api('runner/done', { id: job.id, ok: false, text: GROKBOT_WIN_TEXT.replace(/^⚠ /, '') });   // 4.5: nothing is tried on Windows
  if (job.engine === 'grokbot') {
    const ok = await has('gbot', true);
    let bots = [], why = '';
    if (ok) try { bots = await grokBots(); } catch (e) { why = e.message; }
    resetReports({ usage: false });
    const text = !ok ? '這台電腦還沒安裝 grok-bot-cli'
      : bots.length ? `連上了，找到 ${bots.length} 個 Grok Bot 機器人：${bots.map(b => b.name).join('、')}`
      : why || 'Grok Bot 裡沒有任何機器人（請確認 Grok Bot 桌面 App 已登入）';
    return api('runner/done', { id: job.id, ok: ok && bots.length > 0, text });
  }
  const b = botDir('_test-' + job.engine);
  log(`🔌 測試 ${ENGINES[job.engine]?.label || job.engine}`);
  const res = await runEngine(job.engine, job.prompt, b, '');
  resetReports();   // refresh the installed list, models and quotas right after a test
  await api('runner/done', { id: job.id, ok: res.ok, text: res.text });
}

