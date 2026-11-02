// OCTA runner: calls to the local API, and moving files between it and this computer.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { convDir, freeName, rel, safeName, storeDir } from './files.mjs';
import { CHUNK, cfg, log } from './state.mjs';

// Talks to OCTA's local API (http://127.0.0.1:<port>/api/…) over loopback HTTP.
// every call has a time limit: a connection that died while the computer slept (or the network dropped) used to leave
// the wait for the next job hanging forever, so no job and no routine ran until OCTA was restarted
const API_LIMIT_MS = 3 * 60000, NEXT_LIMIT_MS = 75000;
export function limitSignal(signal, ms) {
  const t = AbortSignal.timeout(ms);
  if (!signal) return t;
  if (AbortSignal.any) return AbortSignal.any([signal, t]);
  const c = new AbortController(), go = s => () => c.abort(s.reason);
  signal.addEventListener('abort', go(signal), { once: true }); t.addEventListener('abort', go(t), { once: true });
  return c.signal;
}
export async function api(path, body, method = 'POST', signal) {
  const r = await fetch(cfg.url + '/api/' + path, {
    method, signal: limitSignal(signal, path === 'runner/next' ? NEXT_LIMIT_MS : API_LIMIT_MS),
    headers: { 'content-type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body || {})
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'HTTP ' + r.status);
  return data;
}

// an uploaded file → this computer's folder; the API's temporary copy is then deleted
export async function saveUpload(f) {
  const d = await api('file/' + f.id, null, 'GET');
  const dir = join(convDir({ id: f.conv, name: f.convName || f.conv }), '附件');
  const p = freeName(dir, safeName(f.name || d.name));
  const buf = Buffer.from(d.data, 'base64');
  writeFileSync(p, buf);
  await api('runner/stored', { id: f.id, path: rel(p), size: buf.length });
  log(`📥 已存到電腦：${rel(p)}`);
  return p;
}
// someone opened a file that lives here: send a temporary copy
export async function sendCopy(f) {
  const p = join(storeDir(), String(f.path || ''));
  if (!f.path || !existsSync(p)) return api('runner/blob', { id: f.id, missing: true });
  const data = readFileSync(p).toString('base64');
  for (let i = 0, n = 0; i < data.length || n === 0; i += CHUNK, n++)
    await api('runner/blob', { id: f.id, n, data: data.slice(i, i + CHUNK), last: i + CHUNK >= data.length });
}

// a system line in the bot's own chat (an older server without runner/note just skips it)
export async function chatNote(botId, text) {
  try { await api('runner/note', { bot: botId, text }); } catch (e) { log('對話提示沒送出：' + e.message); }
}
