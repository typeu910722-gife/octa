// 4.7 內部標記收起來: what runner/done takes out of a bot's reply before it is saved, kept in messages.meta (JSON):
//   { notes: [{ type: 'task'|'memory'|'skill'|'routine'|'site'|'page', title, body }],
//     result: { ok: true|false, text, whole? },          // the ✅ 完成／⚠ 沒做成 line (whole: the reply was only that line)
//     approval: { what, to?, content?, when? } }         // the ✅待確認 line and its 對象／內容／時間 lines (they stay in the text too)
// The chat shows people's words only; the app shows notes as small tags and the result as the first line's ✅／⚠.

export function metaOf(raw) {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw);
    return o && typeof o === 'object' ? o : null;
  } catch {
    return null;
  }
}

const cut = (s, n) => String(s ?? '').trim().slice(0, n);

// markers that must never stay in chat text (some are handled by the runner; a leaked one is only dropped here)
const LEAKS = [
  [/【派瀏覽】[\s\S]*?【派完】/g, ''],
  [/^\s*【(派瀏覽|派完|回覆|稍後)】\s*$/gm, ''],
  [/【(開瀏覽器|關瀏覽器)】(\s*https?:\/\/\S+)?/g, ''],
  [/^\s*🧭\s*(步驟[:：].*|第\s*\d+\s*步.*|\d+\s*[/／]\s*\d+.*)$/gm, ''],
  [/📒\s*工作筆記[:：][\s\S]*?📒\s*結束/g, '']
];
export function stripLeaks(text) {
  let t = String(text || '');
  for (const [re, to] of LEAKS) t = t.replace(re, to);
  return t.replace(/\n{3,}/g, '\n\n').trim();
}

// 📍 目前頁面：網址 — the runner keeps the address itself; in the chat it is only a note
export function takePage(text) {
  let page = '';
  const t = String(text || '').replace(/^\s*📍\s*目前頁面[:：]\s*(\S+).*$/gm, (_, u) => {
    page = page || u;
    return '';
  });
  return { text: t.trim(), page };
}

// ✅ 完成：… ／ ⚠ 沒做成：… — the last one is the result; all of them leave the text
const RESULT_LINE = /^\s*(✅\s*完成|⚠\s*沒做成)\s*(?:[（(][^）)\n]{0,20}[）)])?\s*[:：]?\s*(.*)$/;
export function takeResult(text) {
  const lines = String(text || '').split('\n');
  let result = null;
  const kept = [];
  for (const l of lines) {
    const m = l.match(RESULT_LINE);
    if (m) result = { ok: /✅/.test(m[1]), text: cut(m[2], 300) };
    else kept.push(l);
  }
  if (!result) return { text: String(text || ''), result: null };
  let rest = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!rest) {
    rest = result.text || (result.ok ? '完成' : '沒做成');
    result.whole = true;
  }
  return { text: rest, result };
}

// ✅待確認：要做的事 and, under it, 對象：／內容：／時間： (each optional; 內容 may run over several lines)
const FIELD = { 對象: 'to', 內容: 'content', 時間: 'when' };
export function parseApproval(text) {
  const lines = String(text || '').split('\n');
  let i = -1;
  for (let k = lines.length - 1; k >= 0; k--) if (/^\s*✅\s*待確認[:：]/.test(lines[k])) { i = k; break; }
  if (i < 0) return null;
  const a = { what: cut(lines[i].replace(/^\s*✅\s*待確認[:：]\s*/, ''), 300) };
  let cur = null;
  for (let k = i + 1; k < lines.length; k++) {
    const l = lines[k];
    const f = l.match(/^\s*[-・·*]?\s*(對象|內容|時間)\s*[:：]\s*(.*)$/);
    if (f) {
      cur = FIELD[f[1]];
      a[cur] = f[2];
      continue;
    }
    if (/^\s*(✅|❓|⚠|📍|@\S)/.test(l)) break;
    if (cur === 'content') a.content += '\n' + l;
    else if (l.trim()) break;
  }
  for (const k of ['to', 'when']) if (a[k] != null) a[k] = cut(a[k], 200);
  if (a.content != null) a.content = cut(a.content, 4000);
  for (const k of Object.keys(a)) if (!a[k]) delete a[k];
  return a.what ? a : null;
}

// the reply as it is saved: leaks, the page line and the result line out; notes, result and approval in meta
export function replyMeta(text, notes = []) {
  const p = takePage(stripLeaks(text));
  const r = takeResult(p.text);
  const meta = {};
  const list = notes.filter(n => n && n.type && (n.title || n.body)).slice(0, 30);
  if (p.page) list.push({ type: 'page', title: '目前頁面', body: cut(p.page, 500) });
  if (list.length) meta.notes = list.map(n => ({ type: n.type, title: cut(n.title, 80), body: cut(n.body, 3000) }));
  if (r.result) meta.result = r.result;
  const ap = parseApproval(r.text);
  if (ap) meta.approval = ap;
  return { text: r.text, meta: Object.keys(meta).length ? meta : null };
}
