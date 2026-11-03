// AI engines, backups (fb), models and avatars.
import { clean, now } from './util.mjs';

export const ENGINES = ['claude', 'codex', 'gemini', 'grok', 'grokbot', 'copilot', 'cursor', 'qwen', 'opencode'];
// 4.5: the Grok Bot app for Windows doesn't write gateway-descriptor.json, so grok-bot-cli can't work there.
// On a Windows host Grok Bot is offered only through the 交接網址 (Grok Bot calls OCTA, not the other way round).
export const GROKBOT_WIN = 'Windows 不支援，請改用交接網址';
export const grokBotOff = env => (env?.hostOs || '') === 'win32';
// backup AIs: up to three "engine|model" entries (two backups plus an optional local Ollama / opencode)
export const fbParse = v => {
  try {
    const a = JSON.parse(v || '[]');
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
};
export const fbOk = v =>
  JSON.stringify(
    (Array.isArray(v) ? v : [])
      .map(x => String(x || '').split('|'))
      .filter(([e]) => ENGINES.includes(e) && !['copilot', 'cursor', 'qwen', 'grok'].includes(e))
      .slice(0, 3)
      .map(([e, m]) => e + (clean(m, 80) ? '|' + clean(m, 80) : ''))
  );
const CODE_FB = ['ollama', 'opencode', 'claude', 'codex', 'gemini'];
export const codeFbOk = v =>
  JSON.stringify(
    (Array.isArray(v) ? v : [])
      .map(x => String(x || '').split('|'))
      .filter(([e]) => CODE_FB.includes(e))
      .slice(0, 2)
      .map(([e, m]) => e + (clean(m, 80) ? '|' + clean(m, 80) : ''))
  );

// "Resets in 156h16m" or "5 小時後" → when that AI can be used again. Unknown windows wait an hour, not forever.
export const resetAt = t => {
  const s = String(t);
  const dated = s.match(/resets?\s+([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,|\s)+(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
  if (dated) {
    const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
    const month = months[dated[1].slice(0, 3).toLowerCase()];
    if (month != null) {
      let hour = +dated[3];
      const minute = dated[4] ? +dated[4] : 0;
      const ap = dated[5].toLowerCase();
      if (ap === 'pm' && hour < 12) hour += 12;
      if (ap === 'am' && hour === 12) hour = 0;
      const year = new Date().getUTCFullYear();
      let utc = Date.UTC(year, month, +dated[2], hour - 8, minute);
      if (utc < now() - 86400000) utc = Date.UTC(year + 1, month, +dated[2], hour - 8, minute);
      if (utc > now()) return utc;
    }
  }
  const m = s.match(/resets? in\s*(?:(\d+)\s*h(?:ours?)?)?\s*(?:(\d+)\s*m(?:in(?:ute)?s?)?)?/i);
  if (m && (m[1] || m[2])) return now() + ((+m[1] || 0) * 60 + (+m[2] || 0)) * 60000;
  const zh = s.match(/(\d+)\s*個?\s*小時/);
  const zm = s.match(/(\d+)\s*分鐘/);
  if (zh || zm) {
    const mins = (zh ? +zh[1] * 60 : 0) + (zm ? +zm[1] : 0);
    if (mins > 0 && mins < 14 * 24 * 60) return now() + mins * 60000;
  }
  return now() + 60 * 60000;
};
// job.eng is "engine" or "engine|model". A saved model that no longer matches exactly (opus → sonnet)
// still belongs to that engine, so a failure there must not be charged to the primary again.
export const chainIndex = (chain, current) => {
  const id = String(current || '');
  const exact = chain.indexOf(id);
  if (exact >= 0) return exact;
  const head = id.split('|')[0];
  if (!head) return 0;
  const loose = chain.findIndex(x => x === head || String(x).startsWith(head + '|'));
  return loose >= 0 ? loose : 0;
};
export const ENGINE_NAMES = {
  claude: 'Claude',
  codex: 'ChatGPT',
  gemini: 'Antigravity',
  grokbot: 'Grok Bot',
  opencode: 'Ollama'
};
export const engineOk = e => (ENGINES.includes(e) ? e : 'claude');
export const avatarOk = a => {
  const v = clean(a, 16);
  return v && !/[<>&"']/.test(v) ? v : null;
};
// 4.1: every bot is the OCTA octopus in a colour picked from this palette (app/js/pure.js has the same list).
// A custom #RRGGBB is accepted too. null = the default gold.
export const PALETTE = ['#D6B27A', '#E8A87C', '#D98B5F', '#E58C8A', '#E79AB5', '#C58BC8', '#B9A3E3', '#9DB4F0', '#7EC4E6', '#6CC5B8', '#9BD39A', '#BFCB7A', '#C8B6A0', '#9FAAB8'];
// '' / null → null (default); a palette value or #rrggbb → upper-case #RRGGBB; anything else → undefined (refused)
export const colorOk = c => {
  if (c == null || String(c).trim() === '') return null;
  const v = String(c).trim().toUpperCase();
  return /^#[0-9A-F]{6}$/.test(v) ? v : undefined;
};
// grokbot: the model field holds the Grok Bot's name. opencode is only used with local Ollama models (no paid APIs): "qwen3" → "ollama/qwen3"
export const modelOk = (engine, m) => {
  const v = clean(m, 80) || null;
  if (!v || engine !== 'opencode') return v;
  return 'ollama/' + v.replace(/^ollama\//, '').replace(/^.*\//, '');
};
