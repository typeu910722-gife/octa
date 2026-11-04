// OCTA runner 4.7: 步驟進度. The AI starts with a plan line 「🧭步驟：a｜b｜c」 and marks each step 「🧭第2步」;
// the runner reads them from what the AI streams (Claude: stream-json text; others: their printed lines),
// and with the tool it is using reports {text, step, total, steps, kind} to runner/progress.

// 「🧭步驟：打開後台｜找今天訂單｜整理名單」 → ['打開後台', '找今天訂單', '整理名單'] (2–7 steps), or null
export function parsePlan(text) {
  const m = String(text || '').match(/🧭\s*步驟\s*[:：]\s*([^\n]+)/);
  if (!m) return null;
  const steps = m[1].split(/[｜|]/).map(s => s.replace(/^\s*\d+[.、)）]\s*/, '').trim().slice(0, 40)).filter(Boolean).slice(0, 7);
  return steps.length >= 2 ? steps : null;
}
// 「🧭第2步」「🧭 2/5」 → 2 (the last one in the text), or 0
export function parseStep(text) {
  let n = 0;
  for (const m of String(text || '').matchAll(/🧭\s*(?:第\s*(\d+)\s*步|(\d+)\s*[/／]\s*\d+)/g)) n = +(m[1] || m[2]);
  return n;
}
// the markers never reach the chat
export function stripStepMarks(text) {
  return String(text || '').replace(/^\s*🧭\s*(步驟[:：].*|第\s*\d+\s*步.*|\d+\s*[/／]\s*\d+.*)$/gm, '').replace(/🧭\s*第\s*\d+\s*步[:：]?\s*/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

// one job's progress. send(payload) posts it (the caller throttles); every change goes through here.
export function stepTracker() {
  const st = { text: '開始工作', kind: 'think', steps: null, step: 0 };
  return {
    // a piece of the AI's own words: picks up the plan and the step it is on
    said(text) {
      const plan = parsePlan(text);
      if (plan) { st.steps = plan; if (!st.step) st.step = 1; }
      const n = parseStep(text);
      if (n && st.steps) st.step = Math.min(n, st.steps.length);
      else if (n) st.step = n;
      return !!(plan || n);
    },
    // what it does right now (a tool, reading, writing the reply)
    doing(text, kind) { if (text) st.text = String(text).slice(0, 120); if (kind) st.kind = kind; },
    done() { if (st.steps) st.step = st.steps.length; },
    get state() { return st; },
    payload() {
      const p = { text: st.steps && st.step ? `${st.steps[st.step - 1] || st.text}` + (st.text && st.text !== st.steps[st.step - 1] ? `：${st.text}` : '') : st.text, kind: st.kind };
      if (st.steps) { p.steps = st.steps; p.total = st.steps.length; if (st.step) p.step = st.step; }
      return p;
    }
  };
}
// the kind of work a tool call is (browse: the bot's browser; tool: files, search, commands)
export const toolKind = name => (/^(mcp__browser__)?browser_/.test(String(name)) ? 'browse' : 'tool');
