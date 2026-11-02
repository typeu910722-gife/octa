// Reading schedules out of text: times in an instruction, a reply or a standing task.
import { clean, now } from './util.mjs';

// routine times: "HH:MM" every day, or "*/N" every N minutes (5–720)
export const isEvery = t => /^\*\/\d+$/.test(t);
export const cleanTimes = a => {
  const list = Array.isArray(a) ? a : [];
  const fixed = [...new Set(list.filter(s => /^([01]\d|2[0-3]):[0-5]\d$/.test(s)))].sort().slice(0, 12);
  const ev = list
    .map(s => String(s).match(/^\*\/(\d+)$/))
    .filter(Boolean)
    .map(mm => Math.min(720, Math.max(5, +mm[1])))[0];
  return ev ? ['*/' + ev, ...fixed] : fixed;
};
const CLOCK_RE = /(?<![0-9])([01]?\d|2[0-3])[:：]([0-5]\d)(?![0-9])/g;
function clockHits(text) {
  const hits = [];
  const re = new RegExp(CLOCK_RE.source, 'g');
  let m;
  while ((m = re.exec(String(text || ''))))
    hits.push({ t: m[1].padStart(2, '0') + ':' + m[2], i: m.index, end: m.index + m[0].length });
  return hits;
}
function routineName(raw) {
  let name = String(raw || '').replace(/^[的\s:：,，、和與及]+/, '');
  name = name.replace(/[（(].*$/, '');
  name = name.replace(/(要給|交給|給「|給『|，|。|；|;|→|➡).*$/, '');
  name = name.replace(/^(請|幫我|建立|新增|設定|例行任務|排程|每天|每日|的)+/, '').trim();
  name = name
    .replace(/[\s「」『』]*\d{1,2}\s*[.、．)）]?\s*$/, '')
    .replace(/[「」『』]/g, '')
    .trim(); // "…不要傳房號的人用。4." → no list number
  return clean(name, 40);
}
// Times written in the instruction win. A prose "已建好" does not.
const NOT_A_SCHEDULE_ASK =
  /^（例行任務|^〔背景:|^同事|^（自動接續|^\S+ (問你|把工作交接給你)：|（自動重試 \d+）|這是主機重開後補做/;
export function schedulesFromTurn(prompt, reply) {
  const src = String(prompt || '');
  // a routine's own run (its instruction names the routine and its time), a colleague's question or a retry is not
  // the user asking for a schedule: reading times out of it made the same routines over and over
  if (NOT_A_SCHEDULE_ASK.test(src) || /刪除|刪掉|停用|取消|不要/.test(src.replace(/不要再|別再/g, '')))
    return { fromPrompt: false, routines: [] };
  const asks =
    /例行任務/.test(src) ||
    /(?:建立|新增|設定|做成|改成|排進|寫成|建成).{0,16}排程|排程.{0,16}(?:建立|新增|設定|做成|改成|建成)/.test(src) ||
    (/交接/.test(src) && clockHits(src).length && /名單|早報|入住|退房|續住|掃房|訂單|每天|每日|例行|排程|要給|交給/.test(src));
  if (!asks) return { fromPrompt: false, routines: [] };
  const hits = clockHits(src);
  if (hits.length) {
    const routines = routinesFromClocks(src, hits);
    return { fromPrompt: routines.length > 0, routines };
  }
  return { fromPrompt: false, routines: routinesFromReplyLines(reply) };
}
function routinesFromClocks(text, hits) {
  const groups = [];
  let cur = [hits[0]];
  for (let i = 1; i < hits.length; i++) {
    const between = text.slice(cur[cur.length - 1].end, hits[i].i);
    if (/^[\s,，、和與及的]+$/.test(between)) cur.push(hits[i]);
    else {
      groups.push(cur);
      cur = [hits[i]];
    }
  }
  groups.push(cur);
  const out = [];
  const skip = /^(結束|為止|之前|之後|左右|開始|停止|見|回我|再說)$/;
  for (let g = 0; g < groups.length && out.length < 12; g++) {
    const group = groups[g];
    const nameEnd = g + 1 < groups.length ? groups[g + 1][0].i : text.length;
    const times = cleanTimes(group.map(x => x.t));
    if (!times.length) continue;
    let name = routineName(text.slice(group[group.length - 1].end, nameEnd));
    if (skip.test(name)) continue;
    if (!name) name = clean('每天 ' + times.join('、'), 40);
    out.push({ name, times, prompt: clean(text.slice(group[0].i, nameEnd), 2000) });
  }
  return out;
}
function routinesFromReplyLines(reply) {
  const out = [];
  for (const line of String(reply || '').split('\n')) {
    const m = line.trim().match(/^(?:\d+\s*[.、．)）]\s*)?([01]?\d|2[0-3])[:：]([0-5]\d)\s+(\S.{0,80})/);
    if (!m) continue;
    const name = routineName(m[3]);
    const times = cleanTimes([m[1].padStart(2, '0') + ':' + m[2]]);
    if (!name || !times.length || /^(結束|為止|之前|之後|左右|開始|停止|見|回我|再說)$/.test(name)) continue;
    out.push({ name, times, prompt: clean(line, 2000) });
    if (out.length >= 12) break;
  }
  return out;
}
export function applySchedules(plans, prompt, reply) {
  const asked = schedulesFromTurn(prompt, reply);
  if (asked.fromPrompt) {
    const sets = new Set(asked.routines.map(r => r.times.join(',')));
    for (let i = plans.length - 1; i >= 0; i--) {
      const p = plans[i];
      if (p.trigger || p.times.every(isEvery)) continue;
      if (!sets.has(p.times.filter(t => !isEvery(t)).join(','))) plans.splice(i, 1);
    }
  }
  for (const r of asked.routines) {
    if (
      plans.some(
        p => !p.trigger && (p.name === r.name || (p.times.length === r.times.length && p.times.every((t, i) => t === r.times[i])))
      )
    )
      continue;
    plans.push(r);
  }
  return plans;
}
// ---------- 排程只寫一份: schedule sentences in what the user says, and in a standing task ----------
const CN_DIGIT = { 零: 0, 〇: 0, 一: 1, 二: 2, 兩: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const cnNum = v => {
  v = String(v || '').trim();
  if (/^\d+$/.test(v)) return +v;
  if (!v.includes('十')) return v.length === 1 && v in CN_DIGIT ? CN_DIGIT[v] : NaN;
  const [a, b] = v.split('十');
  return (a ? (CN_DIGIT[a] ?? NaN) : 1) * 10 + (b ? (CN_DIGIT[b] ?? NaN) : 0);
};
// "下午3點半" / "早上八點" / "晚上 9 點 15 分" → "15:30" / "08:00" / "21:15"; other text unchanged
export function clockWords(text) {
  return String(text || '').replace(
    /(早上|上午|中午|下午|晚上|傍晚|凌晨|清晨|半夜)?\s*([0-9]{1,2}|[零〇一二兩两三四五六七八九十]{1,3})\s*[點点時](?![間间])(?:\s*(半|[0-9]{1,2}\s*分|[零〇一二兩两三四五六七八九十]{1,3}\s*分))?/g,
    (m, ap, h, mm) => {
      let H = cnNum(h);
      if (!Number.isFinite(H) || H > 24) return m;
      if (/下午|晚上|傍晚/.test(ap || '') && H < 12) H += 12;
      if (ap === '中午' && H < 6) H += 12;
      if (H === 24) H = 0;
      const M = !mm ? 0 : mm === '半' ? 30 : cnNum(mm.replace(/\s*分$/, ''));
      if (!Number.isFinite(M) || M > 59) return m;
      return String(H).padStart(2, '0') + ':' + String(M).padStart(2, '0');
    }
  );
}
const SCHED_WORD =
  /每天|每日|每晚|每早|天天|每個?(早上|晚上|中午|下午|上午)|每[週周]|每星期|每隔|每\s*\d+\s*(分鐘|分|個?小時)|每個?小時|每半小時|定時|固定/;
const SCHED_NOT =
  /為什麼|為何|怎麼(沒|又|會|都)|有沒有|是不是|幾點|哪時|什麼時候|沒有?(貼|跑|做|回報|發|傳)|取消|刪除|停用|暫停|不用再|不要再|別再|[嗎呢][？?]?\s*$/;
const NOT_START = /^\s*(前|後|以前|之前|以後|之後|左右|為止|到|至|~|～|-|—|－)/; // "11:00 前退房", "08:00-17:00": a deadline or opening hours, not a schedule
const WEEK = /每[週周]|每星期/;
// the routines one sentence asks for: [{name, times, prompt}] (empty when it isn't a schedule)
function scheduleIn(text, whole = false) {
  const t = clockWords(text);
  if (!SCHED_WORD.test(t)) return [];
  const hits = clockHits(t).filter(h => !NOT_START.test(t.slice(h.end)));
  const out = hits.length ? routinesFromClocks(t, hits) : [];
  const em = t.match(/每\s*(\d+)\s*分(?:鐘)?|每\s*(\d+)\s*個?小時|每(?:個)?小時|每半小時/);
  if (em) {
    const every = em[1] ? +em[1] : em[2] ? +em[2] * 60 : /半/.test(em[0]) ? 30 : 60;
    const times = cleanTimes(['*/' + every]);
    if (times.length)
      out.push({
        name: routineName(t.slice(em.index + em[0].length).replace(/^[一1]?次|^巡?一次/, '')) || clean(em[0], 40),
        times,
        prompt: clean(t, 2000)
      });
  }
  const wk = (t.match(/每[週周星期]+([一二三四五六日天](?:[、,，和及][一二三四五六日天])*)/) || [])[1];
  return out.map(r => ({
    ...r,
    prompt: clean(
      (whole || out.length === 1 ? t : r.prompt) +
        (WEEK.test(t) && !isEvery(r.times[0])
          ? `（例行任務是每天跑：只在每週${wk || '指定的那天'}做，其他天只回「（略過）」）`
          : ''),
      2000
    )
  }));
}
export const APPROVAL_TEXT = /^[^\n]{0,40}?(核准|不要做|計畫要改)[:：]/; // an answer to a ✅待確認 ("@名字 核准：…"), even when the name has a space
export const stripMeta = text =>
  String(text || '')
    .replace(/^（這則是在回覆[\s\S]*?請針對這一則回答。）\n?/, '')
    .replace(/^(?:@\S+\s+)+/, '')
    .trim();
// the user asked for something to happen on a schedule ("每天 15:30 把房況貼到群組")
export function scheduleAsk(text) {
  const t = stripMeta(text);
  if (!t || APPROVAL_TEXT.test(t) || SCHED_NOT.test(clockWords(t))) return [];
  return scheduleIn(t, true).slice(0, 6);
}
const CORRECT_RE =
  /不對|不是這樣|不是啦|不是喔|錯了|搞錯|弄錯|應該(要|是|用|先|只)?|以後|之後都|從現在起|記得|記住|不要再|別再|不准|不可以|每次都|一律|永遠|下次|規則是|我說過|說過了|跟你說過|講過/;
// the user corrected the bot or set a rule; the text to keep as a rule candidate (null when it isn't one)
export function correctionAsk(text) {
  const t = stripMeta(text);
  if (t.length < 4 || APPROVAL_TEXT.test(t) || /^（|^〔/.test(t) || !CORRECT_RE.test(t) || scheduleAsk(t).length) return null;
  return clean(t.replace(/\s+/g, ' '), 200);
}
// times written in a standing task: the sentences come out, each with the routine it stands for
export function splitTaskSchedules(task) {
  const keep = [],
    moved = [];
  for (const line of String(task || '').split('\n')) {
    if (!line.trim()) {
      keep.push(line);
      continue;
    }
    const left = [];
    for (const part of line.split(/(?<=[。；;])/)) {
      if (/不要|不用|不必|別做|勿|停止|取消|暫停|已刪|刪掉/.test(part)) {
        left.push(part);
        continue;
      } // "07:30 不要做…" is a rule, not a schedule
      const found = scheduleIn(part.replace(/^[\s\-•·*]+|^\s*\d+[.)、]\s*/g, ''));
      if (found.length) {
        for (const r of found) moved.push({ ...r, line: clean(part.replace(/^[\s\-•·*]+/, ''), 300) });
        continue;
      }
      left.push(part);
    }
    const rest = left.join('').replace(/[，,、；;]\s*$/, '');
    if (rest.replace(/^[\s\-•·*\d.、)）]+/, '').trim()) keep.push(rest);
  }
  return {
    task: keep
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
    moved
  };
}
// "⏰例行任務：名稱｜08:00,13:30 或 每30分鐘 或 每10分鐘監看 url 或 外部事件｜要做的事" (also the ✅待確認：建立排程 line)
export function routinePlan(n, t, p) {
  const name = clean(n, 40),
    prompt = clean(p, 2000);
  const wm = String(t).match(/監看\s*(https?:\/\/\S+)/),
    every = (String(t).match(/每\s*(\d+)\s*分/) || [])[1];
  if (wm) return { name, times: [], prompt, trigger: 'watch', watch: { url: wm[1], every: +every || 10 } };
  if (/外部事件|webhook/i.test(t)) return { name, times: [], prompt, trigger: 'hook' };
  const times = cleanTimes(
    clockWords(String(t))
      .replace(/每天|每日/g, ' ')
      .replace(/每\s*(\d+)\s*分(鐘)?/g, '*/$1')
      .replace(/每\s*(\d+)\s*小時/g, (_, h) => '*/' + h * 60)
      .split(/[,，、\s]+/)
      .map(x => {
        if (/^\*\/\d+$/.test(x)) return x;
        const mm = x.match(/^(\d{1,2})[:：](\d{2})$/);
        return mm ? mm[1].padStart(2, '0') + ':' + mm[2] : '';
      })
  );
  return name && times.length && prompt ? { name, times, prompt } : null;
}
export const timesWords = ts => ts.map(t => (isEvery(t) ? `每 ${t.slice(2)} 分鐘` : '每天 ' + t)).join('、');
export const localNow = (env, t = now()) => {
  const d = new Date(t + (+env.TZ_OFFSET_MIN || 0) * 60000);
  return { date: d.toISOString().slice(0, 10), hm: d.toISOString().slice(11, 16) };
};
