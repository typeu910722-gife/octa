// OCTA runner 4.11 全力模式: run until done. A turn that ends without a result (no ✅ 完成／⚠ 沒做成, no approval,
// question, sign-in or 接手) while the work is clearly not finished goes on in the same session with a short nudge;
// a loop that stops making progress is called stuck and ends with ⚠ 沒做成.
import { CONT_GUARD } from './state.mjs';

// how a turn can end: done, can't, needs the person (approval, question, sign-in, 接手), later, a plan to approve, skipped
const TERMINAL_RE = /✅\s*(完成|待確認)|⚠\s*沒做成|❓|需要使用者在電腦上登入|【稍後】|我先停手|📋\s*計畫|^\s*⚠/m;
const PASSED_RE = /^\s*[（(]\s*略過\s*[)）]\s*$/;
// words of a turn that stopped in the middle of the work
const UNFINISHED_RE = /還沒|尚未|接下來|下一步|稍後|待會|繼續(做|處理|進行)|正在|還要|剩下的?(步驟|部分|工作)|做到一半|先做到這|to be continued|next,? i('ll| will)|i will now|let me continue/i;

export const isTerminal = text => TERMINAL_RE.test(String(text || '')) || PASSED_RE.test(String(text || '').trim());

// should the runner go on? Only for work: an answer to a question (no tools used, no plan, no "還沒…") ends as it is.
export function needsMore(job, text) {
  if (!job?.full || job.side || job.handed) return false;
  const t = String(text || '');
  if (isTerminal(t)) return false;
  const st = job.steps;   // { steps, step } from the progress tracker: a plan with steps still ahead
  const planLeft = !!(st?.steps?.length && (st.step || 0) < st.steps.length);
  return (job.toolCount || 0) > 0 || planLeft || UNFINISHED_RE.test(t) || (!t.trim() && (job.toolCount || 0) > 0);
}

// the nudge: concise, with what was said last and the original instruction (the session already has the rest)
export function contPrompt(job, last, round) {
  const tail = String(last || '').trim();
  const st = job.steps?.steps?.length ? `你的步驟：${job.steps.steps.map((x, i) => `${i + 1}.${x}`).join(' ')}（目前第 ${job.steps.step || 1} 步）` : '';
  return [
    `（OCTA 自動接續 第 ${round} 輪）繼續做，直到完成或確定做不出來。上一則回覆沒有寫結果行，這件工作還沒結束。這件工作沒有時間或回合限制。`,
    '照原本的指示接著做剩下的部分：已經做完的不要重做，做一步就驗證一步。',
    st,
    '- 全部做完：最後的【回覆】寫整件事的完整結果（不只這一輪），最後一行「✅ 完成：一句話結果」。',
    '- 試過不同方法還是確定做不到：最後一行「⚠ 沒做成：原因＋下一步」。',
    '- 需要使用者核准（送出、付款、刪除）或只有使用者才有的資料：照規則寫 ✅待確認 或 ❓問你，然後停下。',
    '- 其實已經做完，或這則只是在回答問題：只回一行「✅ 完成：一句話」。',
    tail ? '你上一則回覆（節錄）：\n' + (tail.length > 1500 ? '…' + tail.slice(-1500) : tail) : '',
    '原本的指示：' + String(job.prompt || '').slice(0, 1500)
  ].filter(Boolean).join('\n');
}

// what counts as progress between two looks: a new (not repeated) tool action, a later step, a new output file;
// for an AI whose tool calls are not visible, new words
export const progressMark = job => ({ sigs: job.toolSigs?.size || 0, step: job.steps?.step || 0, files: job.outCount || 0 });
const norm = t => String(t || '').replace(/\s+/g, '').replace(/（OCTA 自動接續[^）]*）/g, '');
export const sameText = (a, b) => { const x = norm(a), y = norm(b); return x === y || (!!x && !!y && (x.includes(y) || y.includes(x))); };
export function madeProgress(before, after, { toolsVisible, prevText, nextText }) {
  if (after.sigs > before.sigs || after.step > before.step || after.files > before.files) return true;
  return !toolsVisible && !sameText(prevText, nextText);
}
// a tool call, as a signature: the same call again (re-reading the same page) is not progress
export const toolSig = (name, input) => `${name}:${JSON.stringify(input ?? {}).slice(0, 300)}`;

// the markers an earlier round wrote (📌 rule, ⏰ routine, 📝 task, 🧩 skill, 📒 notes…) go with the final reply
const BLOCKS = [/📝\s*任務更新[:：][\s\S]*?📝\s*結束/g, /🧩\s*技能[:：][^\n]*\n[\s\S]*?🧩\s*結束/g, /📒\s*工作筆記[:：][\s\S]*?📒\s*結束/g, /📘\s*手冊[:：][^\n｜|]+\n[\s\S]*?📘\s*結束/g];
const LINES = /^\s*(📌|📇|🗺️?|⏰|📛|📘)\s*\S.*$/gm;
export function carryMarks(text) {
  let t = String(text || '');
  const out = [];
  for (const re of BLOCKS) t = t.replace(re, m => { out.push(m.trim()); return ''; });
  for (const m of t.match(LINES) || []) out.push(m.trim());
  return out;
}
// the reply that goes out: the last round's (it covers the whole job), or the earlier text plus a bare result line
export function mergeReplies(prev, next) {
  const p = String(prev || '').trim(), n = String(next || '').trim();
  if (!p) return n;
  if (!n) return p;
  const lines = n.split('\n').map(l => l.trim()).filter(Boolean);
  const body = lines.length <= 1 && !sameText(p, n) ? `${p}\n\n${n}` : n;
  const carried = body === n ? carryMarks(p).filter(m => !n.includes(m)) : [];
  return carried.length ? `${body}\n${carried.join('\n')}` : body;
}
export const stuckText = n => `⚠ 沒做成：自動接續了 ${n} 輪都沒有新的進展（沒有新的動作、步驟或結果），判斷卡住了，先停下。下一步：看上面做到哪裡，補充需要的資料或換個說法再交代一次。`;

// the loop itself, with the AI turn passed in (so it can be tested without an AI):
// turn(prompt, round) → { ok, text, tokens }; after() → called after each round (connector / browse rounds);
// mark() → progressMark; canGo() → false when 停止／接手／暫停-then-停止
export async function runUntilDone(job, res, { turn, mark = () => progressMark(job), canGo = async () => true, max = 60, guard = CONT_GUARD, toolsVisible = true, progress } = {}) {
  let idle = 0, round = 0, tokens = res.tokens ?? null;
  while (res?.ok && needsMore(job, res.text) && round < max) {
    if (!(await canGo())) break;
    round++;
    progress?.(`繼續做（自動接續第 ${round} 輪）`);
    const before = mark(), prevText = res.text;
    const next = await turn(contPrompt(job, prevText, round), round);
    tokens = (tokens == null && next?.tokens == null) ? null : (tokens || 0) + (next?.tokens || 0);
    if (!next?.ok) {
      // a failure while going on (quota, a crash): what was done so far is kept with it
      return { ...next, tokens, rounds: round, prevText };
    }
    const moved = madeProgress(before, mark(), { toolsVisible, prevText, nextText: next.text });
    idle = moved ? 0 : idle + 1;
    res = { ...next, ok: true, text: mergeReplies(prevText, next.text), tokens };
    if (idle >= guard && needsMore(job, res.text)) {
      res = { ...res, text: `${res.text}\n\n${stuckText(round)}`, stuck: true };
      break;
    }
  }
  if (round >= max && needsMore(job, res?.text)) res = { ...res, text: `${res.text}\n\n${stuckText(round)}`, stuck: true };
  return { ...res, tokens, rounds: round };
}
