// Classifies a model failure and chooses retry, fallback, or stop.
// This is a policy function. It does not call a provider and must not treat every error as quota.

// A short chat reply that is only "the quota is gone" (the model exited 0 and explained it).
// Deliberately narrower than classifyModelFailure: 「人數已達上限」is a real answer, 「人流量不夠」is not an AI quota.
const QUOTA_RE = /quota|usage limit|weekly limit|daily limit|monthly limit|5[- ]hour limit|out of (extra )?credits|insufficient[_\s-]?credit|upgrade your (plan|subscription)|resource[_\s-]?exhausted|out of quota|usage exceeded|you(?:'ve| have) (?:reached|exceeded|hit) your (?:(?:weekly|daily|monthly|5[- ]hour) )?limit|you(?:'ve| have) (?:reached|exceeded) your (?:quota|usage|rate)|額度(用完|不足|已用完)|用量上限|流量(不夠|不足|用完|已用完|耗盡|用盡)|沒有(剩餘)?流量|配額(已)?(用完|不足|用盡|耗盡)|超出配額|資源已?耗盡/i;
// 人流量、車流量、客流量、網路流量 are not an AI quota.
const quotaText = s => String(s || '').replace(/(?:人|車|客|網路)流量/g, ' ');
const RATE_RE = /\b429\b|too many requests|rate limit/i;
export const REFUSAL_MAX = 800;

export function classifyModelFailure(text, flags = {}) {
  if (flags.stopped) return 'cancelled';
  const t = String(text || '');
  if (/使用者按了停止|已停止|aborted by user|operation was aborted/i.test(t)) return 'cancelled';
  if (/invalid[_\s-]?api[_\s-]?key|incorrect api key|authentication_error|\b401\b|unauthorized|invalid token|API Key 無效|憑證無效|登入失效|not logged in|please login|未登入/i.test(t)) return 'auth';
  if (/這台電腦沒有安裝|還沒有下載任何模型/i.test(t)) return 'unavailable';
  if (QUOTA_RE.test(quotaText(t)) || /已達上限/.test(t)) return 'quota';
  if (RATE_RE.test(t)) return 'rate_limit';
  if (/\b(502|503|504)\b|gateway timeout|timed out|timeout|ECONNRESET|EAI_AGAIN|temporarily unavailable|overloaded|服務暫時|網路錯誤/i.test(t)) return 'transient';
  if (/(websearch|搜尋工具|mcp|plugin|技能).{0,40}(fail|失敗|error|不可用)|(fail|失敗).{0,24}(websearch|搜尋工具|mcp|plugin|技能)/i.test(t)) return 'tool';
  return 'execution';
}

// ok:true replies that are really a quota or rate-limit refusal. Empty when the text is a real answer.
export function replyIsProviderRefusal(text, { files = 0 } = {}) {
  const raw = String(text || '');
  const visible = (raw.includes('【回覆】') ? raw.slice(raw.lastIndexOf('【回覆】') + 4) : raw).trim();
  if (!visible || files > 0) return '';
  // Claude prints the weekly limit and then the whole task. The first line is still a refusal.
  const first = quotaText((visible.split('\n').map(s => s.trim()).find(Boolean) || '').slice(0, 400));
  if (QUOTA_RE.test(first)) return 'quota';
  if (visible.length > REFUSAL_MAX) return '';
  const spoke = quotaText(visible);
  if (QUOTA_RE.test(spoke)) return 'quota';
  if (RATE_RE.test(spoke)) return 'rate_limit';
  return '';
}

// Keep the quota / rate-limit / missing-tool lines. A generic "Error:" line must not hide them.
export function providerFailureText(parts) {
  const blob = (Array.isArray(parts) ? parts : [parts]).map(x => String(x || '')).filter(s => s.trim()).join('\n');
  if (!blob.trim()) return '';
  const lines = blob.split('\n').map(s => s.trim()).filter(Boolean);
  const keep = kind => lines.filter(l => classifyModelFailure(l) === kind);
  for (const kind of ['quota', 'rate_limit', 'unavailable', 'auth']) {
    const hit = keep(kind);
    if (hit.length) return hit.slice(-6).join('\n').slice(-1200);
  }
  const kind = classifyModelFailure(blob);
  if (kind === 'quota' || kind === 'rate_limit' || kind === 'unavailable' || kind === 'auth') return blob.slice(-1200);
  return '';
}

function nextLive(chain, index, now) {
  for (let i = index + 1; i < chain.length; i++) {
    if (!(chain[i]?.spentUntil > now)) return i;
  }
  return -1;
}

// chain items: { id, spentUntil }. index is the model that just failed.
// tries counts retries already used on that same model.
export function decideRoute({ kind, tries = 0, chain = [], index = 0, resetsAt = 0, now = Date.now() } = {}) {
  const later = nextLive(chain, index, now);
  if (kind === 'cancelled') return { action: 'stop', reason: 'cancelled', message: '已停止，不會再重試或改用備援。' };
  if (kind === 'auth') return { action: 'stop', reason: 'auth', message: '這個 AI 的登入或 API Key 無效。請到「AI 連線」檢查憑證，系統不會重複呼叫。' };
  if (kind === 'unavailable') {
    if (later < 0) return { action: 'stop', reason: 'unavailable', message: '這個 AI 這台電腦還沒安裝，而且沒有下一個備援。請到「AI 連線」安裝，或改選已經連接的備援。' };
    return { action: 'switch', index: later, reason: 'unavailable', spend: true, message: '這個 AI 這台電腦還沒安裝，改由備援接手。' };
  }
  if (kind === 'tool') return { action: 'stop', reason: 'tool', message: '工具或搜尋失敗。這次不更換模型，請檢查工具與網路後再重試。' };
  if (kind === 'execution' || !kind) return { action: 'stop', reason: 'execution', message: '' };
  if (kind === 'quota') {
    if (later < 0) return { action: 'stop', reason: 'quota', message: '主要模型和備援都無法使用（額度）。任務已保留，可稍後重新執行。' };
    return { action: 'switch', index: later, reason: 'quota', spend: true, message: '額度用完，改由備援接手。已完成的步驟會保留。' };
  }
  if (kind === 'rate_limit') {
    if (resetsAt > now || tries >= 1) {
      if (later < 0) return { action: 'stop', reason: 'rate_limit', message: '目前被限流，而且沒有可用的備援。請稍後再執行。' };
      return { action: 'switch', index: later, reason: 'rate_limit', spend: resetsAt > now, message: '遇到 HTTP 429。同一個模型不會無限重試，已改用備援。' };
    }
    return { action: 'retry', reason: 'rate_limit', message: '遇到 HTTP 429，用同一個模型再試一次。' };
  }
  if (kind === 'transient') {
    if (tries < 2) return { action: 'retry', reason: 'transient', message: '服務暫時故障，用同一個模型再試一次。' };
    if (later < 0) return { action: 'stop', reason: 'transient', message: '服務暫時故障，重試與備援都已用完。任務進度已保留。' };
    return { action: 'switch', index: later, reason: 'transient', message: '服務暫時故障，有限次重試後改用備援。' };
  }
  return { action: 'stop', reason: kind, message: '' };
}

// ---------- why a bot's job failed (shown in 工作紀錄 and notifications) ----------
// Separate from classifyModelFailure, which only chooses retry vs backup AI. These kinds are
// what the user sees, and whether OCTA should try the same job again on its own.
export const FAIL_KINDS = {
  not_logged_in: { label: '需要登入', why: '網站把機器人登出了，或要先登入才能繼續。', next: '在電腦上打開機器人的瀏覽器登入，再按「繼續」。', retry: false },
  site_changed: { label: '網頁變了', why: '網頁上找不到要操作的地方，可能改版或跳出了別的畫面。', next: '看截圖確認畫面；網站改版了就告訴機器人新的位置。', retry: true },
  quota: { label: '額度用完', why: 'AI 的使用額度用完或被限流了。', next: '等額度重置，或在任務設定加一個備援 AI。', retry: false },
  timeout: { label: '逾時', why: '做太久，或 AI 很久沒有回應，已中止。', next: '把工作拆小一點再交代，或稍後按重試。', retry: true },
  tool_error: { label: '工具出錯', why: '瀏覽器、搜尋或其他工具出錯。', next: '確認電腦的網路和瀏覽器正常，再按重試。', retry: true },
  unknown: { label: '其他錯誤', why: '執行時發生錯誤。', next: '看錯誤訊息後按重試；一直失敗就換個說法交代。', retry: true }
};
export const MAX_AUTO_RETRY = 2;
// A program that crashes the same way every time (a failing test, a syntax error) is not helped by running it again.
const SAME_EVERY_TIME = /AssertionError|SyntaxError|ReferenceError|TypeError:|tests? failed|測試(沒過|失敗)/i;
export const autoRetryable = (kind, text) => !!FAIL_KINDS[kind]?.retry && !(kind === 'unknown' && SAME_EVERY_TIME.test(String(text || '')));
const SITE_LOGIN_RE = /需要使用者在電腦上登入|登入(已)?(過期|逾時|失效)|被登出|請(先|重新)登入|要先登入|session (has )?expired|sign ?in (to continue|required)|log ?in required|please (log|sign) ?in|not logged in|未登入/i;
const SITE_CHANGED_RE = /找不到(元素|按鈕|欄位|連結|選項|輸入框|要點的)|頁面(不同|改版|變了|不一樣)|版面(改|變)了?|element (is )?(not found|not attached|not visible)|no (such )?element|ref\b.{0,30}not found|strict mode violation|waiting for (locator|selector)|locator\(|not (found|visible) in (the )?(page|snapshot)/i;
const TIMEOUT_RE = /超過\s*\d+\s*分鐘|很久沒有回應|逾時|timed? ?out|timeout|ETIMEDOUT/i;
const TOOL_RE = /\bmcp\b|playwright|browser_\w+|tool (error|failed)|工具(錯誤|失敗|出錯)|target (page|closed)|net::ERR|ECONNREFUSED|ECONNRESET|瀏覽器(錯誤|失敗|打不開)/i;

export function classifyJobFailure(text, { hint, stalled } = {}) {
  if (hint && FAIL_KINDS[hint]) return hint;
  if (stalled) return 'timeout';
  const t = String(text || '');
  const model = classifyModelFailure(t);
  if (SITE_LOGIN_RE.test(t) || model === 'auth') return 'not_logged_in';
  if (model === 'quota' || model === 'rate_limit') return 'quota';
  if (SITE_CHANGED_RE.test(t)) return 'site_changed';
  if (TIMEOUT_RE.test(t)) return 'timeout';
  if (model === 'tool' || model === 'transient' || model === 'unavailable' || TOOL_RE.test(t)) return 'tool_error';
  return 'unknown';
}
// the job is tried again with the reason attached; earlier notes are replaced, not stacked
const RETRY_NOTE = /\n\n（自動重試 \d+）[\s\S]*$/;
export const stripRetryNote = p => String(p || '').replace(RETRY_NOTE, '');
export function retryPrompt(prompt, n, kind, msg) {
  const base = stripRetryNote(prompt);
  if (n < MAX_AUTO_RETRY) return base;
  const k = FAIL_KINDS[kind] || FAIL_KINDS.unknown;
  const m = String(msg || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  return `${base}\n\n（自動重試 ${n}）前一次失敗了，原因：${k.label}（${k.why}）${m ? '錯誤訊息：' + m : ''}這次請換一種方法做，不要重複上次失敗的步驟。`;
}
// plain words for a notification: which bot, what it was doing, why, what to do next
export function failureNotice(who, prompt, kind, msg) {
  const k = FAIL_KINDS[kind] || FAIL_KINDS.unknown;
  const what = stripRetryNote(prompt).replace(/\s+/g, ' ').trim().slice(0, 100);
  const m = String(msg || '').replace(/^⚠\s*/, '').replace(/\s+/g, ' ').trim().slice(0, 200);
  return [`【OCTA】${who} 沒有完成工作`, what ? `做什麼：${what}` : '', `原因：${k.label}——${k.why}`, m ? `訊息：${m}` : '', `建議：${k.next}`].filter(Boolean).join('\n');
}
