// Classifies a model failure and chooses retry, fallback, or stop.
// This is a policy function. It does not call a provider and must not treat every error as quota.

// A short chat reply that is only "the quota is gone" (the model exited 0 and explained it).
// Deliberately narrower than classifyModelFailure: 「人數已達上限」is a real answer, 「人流量不夠」is not an AI quota.
const QUOTA_RE = /quota|usage limit|out of (extra )?credits|insufficient[_\s-]?credit|upgrade your (plan|subscription)|resource[_\s-]?exhausted|out of quota|usage exceeded|you(?:'ve| have) (?:reached|exceeded) your (?:quota|limit|usage|rate)|額度(用完|不足|已用完)|用量上限|流量(不夠|不足|用完|已用完|耗盡|用盡)|沒有(剩餘)?流量|配額(已)?(用完|不足|用盡|耗盡)|超出配額|資源已?耗盡/i;
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
  if (!visible || visible.length > REFUSAL_MAX || files > 0) return '';
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
