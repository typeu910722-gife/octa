// 4.5 交接網址 on the OCTA site: https://octa.yzprojecttw.com/api/hook/<token>[/<rest>] → the host computer.
//
// The host computer is only reachable through its own Cloudflare quick tunnel, whose address changes every time OCTA
// restarts. For each hook token the host publishes its current address on ntfy.sh (desktop/host-link.mjs
// publishHook): topic = base32(sha256('octa-hook-topic:' + token)).slice(0, 32), sealed with
// key = sha256('octa-hook-key:' + token) in the same "o1." AES-256-GCM format as the rest of OCTA.
// This forwarder derives both from the token in the request, reads the newest address, and passes the request on.
// It is stateless: no account, no database, nothing kept except a 30-second in-memory cache of the address.
// A token nobody published (or a wrong one) gets the same 401 as a token the host refuses.
// Pure WebCrypto + fetch (Cloudflare Pages Functions; Node ≥ 20 in the tests).

export const RELAY = 'https://ntfy.sh';
export const TOKEN_RE = /^[0-9a-f]{48}$/;
export const CACHE_MS = 30000;
const MISS_MS = 10000;          // a token with no address is asked again sooner (the host may have just made it)
export const FORWARD_MS = 25000;
const MAX_BODY = 64 * 1024, MAX_REPLY = 1024 * 1024;
const enc = new TextEncoder(), dec = new TextDecoder();
const subtle = () => globalThis.crypto.subtle;

export const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '600'
};
const J = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...CORS } });
// the same body the host answers with, so a wrong token and an unknown one look alike
export const BAD_TOKEN = { error: '交接網址不正確' };
export const HOST_DOWN = { error: '主機電腦沒有連線' };

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
function base32(buf) {
  let bits = 0, val = 0, out = '';
  for (const b of buf) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits) out += B32[(val << (5 - bits)) & 31];
  return out;
}
const sha = async s => new Uint8Array(await subtle().digest('SHA-256', enc.encode(s)));
function b64uDecode(str) {
  const s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '==='.slice((s.length + 3) % 4));
  const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64uEncode(bytes) {
  let s = ''; for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export const hookTopic = async token => base32(await sha('octa-hook-topic:' + token)).slice(0, 32);
const hookKey = async token => subtle().importKey('raw', await sha('octa-hook-key:' + token), 'AES-GCM', false, ['encrypt', 'decrypt']);

// "o1." + base64url(iv(12) | tag(16) | ciphertext): Node puts the tag before the ciphertext, WebCrypto after it
export async function unsealHook(text, token) {
  try {
    if (typeof text !== 'string' || !text.startsWith('o1.')) return null;
    const raw = b64uDecode(text.slice(3));
    if (raw.length < 29) return null;
    const iv = raw.subarray(0, 12), tag = raw.subarray(12, 28), ct = raw.subarray(28);
    const both = new Uint8Array(ct.length + 16); both.set(ct, 0); both.set(tag, ct.length);
    return JSON.parse(dec.decode(await subtle().decrypt({ name: 'AES-GCM', iv, tagLength: 128 }, await hookKey(token), both)));
  } catch { return null; }
}
export async function sealHook(obj, token) {   // the host's side, for the tests
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const out = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, tagLength: 128 }, await hookKey(token), enc.encode(JSON.stringify(obj))));
  const ct = out.subarray(0, out.length - 16), tag = out.subarray(out.length - 16);
  const raw = new Uint8Array(28 + ct.length); raw.set(iv, 0); raw.set(tag, 12); raw.set(ct, 28);
  return 'o1.' + b64uEncode(raw);
}

// where a request may be passed on: a Cloudflare quick tunnel only (so the forwarder can't be pointed anywhere else
// by someone who publishes under a token of their own). `allow`: extra origins, for tests and a local check.
export function hostAllowed(u, allow = []) {
  try {
    const x = new URL(String(u));
    if (x.username || x.password || x.search || x.hash || (x.pathname !== '/' && x.pathname !== '')) return false;
    if (allow.includes(x.origin)) return true;
    return x.protocol === 'https:' && /^[a-z0-9-]+\.trycloudflare\.com$/.test(x.hostname) && !x.port;
  } catch { return false; }
}

const withTimeout = (fetch, ms) => (url, init = {}) => {
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), ms);
  return fetch(url, { ...init, signal: ac.signal }).finally(() => clearTimeout(t));
};

// topic → { url | null, at }. Lives as long as the worker isolate; holds only addresses (not tokens or bodies).
const cache = new Map();
export const clearCache = () => cache.clear();
// the host's newest address for this token, or null. Throws { code: 'relay-down' } when ntfy.sh can't be read.
export async function findHookHost(token, { fetch = globalThis.fetch, relay = RELAY, allow = [], now = Date.now(), fresh = false } = {}) {
  const topic = await hookTopic(token);
  const c = cache.get(topic);
  if (!fresh && c && now - c.at < (c.url ? CACHE_MS : MISS_MS)) return c.url;
  let r;
  try { r = await withTimeout(fetch, 10000)(`${relay}/${topic}/json?poll=1&since=24h`); }
  catch (e) { throw Object.assign(new Error('relay unreachable'), { code: 'relay-down', cause: e }); }
  if (!r.ok) throw Object.assign(new Error('relay ' + r.status), { code: 'relay-down' });
  let best = null;
  for (const line of (await r.text()).split('\n')) {
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    if (ev?.event !== 'message') continue;
    const m = await unsealHook(ev.message, token);
    if (!m || m.v !== 1 || !hostAllowed(m.url, allow) || !Number.isFinite(m.ts) || m.ts > now + 10 * 60000) continue;
    if (!best || m.ts > best.ts) best = m;
  }
  const url = best ? String(best.url).replace(/\/+$/, '') : null;
  if (cache.size > 2000) cache.clear();
  cache.set(topic, { url, at: now });
  return url;
}

// one request: OPTIONS, then find the host and pass method, body and content type on; the host's JSON comes back as is.
// opts: { fetch, relay, allow, timeoutMs }
export async function forwardHook(request, token, rest, opts = {}) {
  const fetch = opts.fetch || globalThis.fetch;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (!['GET', 'POST'].includes(request.method)) return J({ error: '只接受 GET 或 POST' }, 405);
  if (!TOKEN_RE.test(String(token || ''))) return J(BAD_TOKEN, 401);
  rest = String(rest || '');
  if (rest.length > 200 || !/^[A-Za-z0-9/_-]*$/.test(rest)) return J({ error: '找不到' }, 404);
  let body;
  if (request.method === 'POST') {
    const len = +(request.headers.get('content-length') || 0);
    if (len > MAX_BODY) return J({ error: '內容太大（上限 64 KB）' }, 413);
    body = await request.arrayBuffer();
    if (body.byteLength > MAX_BODY) return J({ error: '內容太大（上限 64 KB）' }, 413);
  }
  const find = fresh => findHookHost(token, { fetch, relay: opts.relay, allow: opts.allow, fresh });
  let url;
  try { url = await find(false); }
  catch { return J({ error: '轉送服務暫時連不上，請稍後再試' }, 503); }
  if (!url) return J(BAD_TOKEN, 401);
  const search = new URL(request.url).search.slice(0, 200);
  const headers = { 'content-type': request.headers.get('content-type') || 'application/json', 'x-octa-relay': '1' };
  if (request.headers.get('x-line-signature')) headers['x-line-signature'] = request.headers.get('x-line-signature');   // LINE webhooks
  const send = to => withTimeout(fetch, opts.timeoutMs || FORWARD_MS)(`${to}/api/hook/${token}${rest ? '/' + rest : ''}${search}`, {
    method: request.method, body, redirect: 'manual', headers
  });
  let res;
  try { res = await send(url); }
  catch {
    // the cached address may be an old tunnel: look again once, and try the new address if there is one
    let again = null;
    try { again = await find(true); } catch { }
    if (!again || again === url) return J(HOST_DOWN, 503);
    try { res = await send(again); } catch { return J(HOST_DOWN, 503); }
  }
  // only the host's own JSON answers come back; a Cloudflare error page (tunnel gone) means the host is not there
  if (!(res.headers.get('content-type') || '').includes('application/json')) return J(HOST_DOWN, 503);
  const text = await res.text();
  if (text.length > MAX_REPLY) return J({ error: '回覆太大' }, 502);
  return new Response(text, { status: res.status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...CORS } });
}
