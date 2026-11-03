// OCTA /go — the phone's stable way back to its host computer (4.4).
//
// The host computer's address (a Cloudflare quick tunnel) changes every time OCTA restarts. The host publishes the
// current address on ntfy.sh, encrypted (desktop/host-link.mjs `seal`); this page, on the OCTA site (a stable origin,
// static hosting only), keeps what the phone needs in its own localStorage, reads the newest message, checks it is
// from the right host, and opens the app there with the phone's session token in the URL fragment.
//
// Nothing here talks to an OCTA server: the fragment never leaves the phone, ntfy.sh only sees an encrypted blob.
// Pure functions + WebCrypto only (works in browsers and in Node ≥ 20, where the tests run it).

export const RELAY = 'https://ntfy.sh';
export const STORE_KEY = 'octa_go_host';
const enc = new TextEncoder(), dec = new TextDecoder();
const subtle = () => globalThis.crypto.subtle;

export function b64uEncode(bytes) {
  let s = ''; for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function b64uDecode(str) {
  const s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '==='.slice((s.length + 3) % 4));
  const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const keyOf = async secret => subtle().importKey('raw', await subtle().digest('SHA-256', enc.encode('octa-key:' + secret)), 'AES-GCM', false, ['encrypt', 'decrypt']);

// "o1." + base64url(iv(12) | tag(16) | ciphertext) — the same format as desktop/host-link.mjs (WebCrypto puts the
// tag after the ciphertext, Node's format puts it before)
export async function unseal(text, secret) {
  try {
    if (typeof text !== 'string' || !text.startsWith('o1.')) return null;
    const raw = b64uDecode(text.slice(3));
    if (raw.length < 29) return null;
    const iv = raw.subarray(0, 12), tag = raw.subarray(12, 28), ct = raw.subarray(28);
    const both = new Uint8Array(ct.length + 16); both.set(ct, 0); both.set(tag, ct.length);
    const plain = await subtle().decrypt({ name: 'AES-GCM', iv, tagLength: 128 }, await keyOf(secret), both);
    return JSON.parse(dec.decode(plain));
  } catch { return null; }
}
export async function seal(obj, secret) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const out = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, tagLength: 128 }, await keyOf(secret), enc.encode(JSON.stringify(obj))));
  const ct = out.subarray(0, out.length - 16), tag = out.subarray(out.length - 16);
  const raw = new Uint8Array(28 + ct.length); raw.set(iv, 0); raw.set(tag, 12); raw.set(ct, 28);
  return 'o1.' + b64uEncode(raw);
}

// an address the host may be at: its tunnel (https), or this computer itself (tests)
export function hostUrlOk(u) {
  try {
    const x = new URL(String(u));
    if (x.username || x.password || x.search || x.hash) return false;
    if (x.protocol === 'https:') return true;
    return x.protocol === 'http:' && /^(127\.0\.0\.1|localhost)$/.test(x.hostname);
  } catch { return false; }
}

// ---------- the fragment ----------
// from the host (QR / link):  #tp=<topic>&k=<phone key>&h=<host id>&n=<host name>&u=<address now>&c=<pairing code>
// from the app on the phone:  … &t=<this phone's session token> instead of c
// from a notification:        #web=<bot id>   (only which bot to open; the rest comes from storage)
const B64U = /^[A-Za-z0-9_-]{8,200}$/;
export function parseFragment(hash) {
  const p = new URLSearchParams(String(hash || '').replace(/^#/, ''));
  const g = k => (p.get(k) || '').trim();
  const out = {};
  const web = g('web'); if (/^[\w-]{1,64}$/.test(web)) out.web = web;
  const tp = g('tp'), k = g('k'), h = g('h');
  if (/^[a-z2-7]{16,64}$/.test(tp) && B64U.test(k) && /^[A-Za-z0-9_-]{2,64}$/.test(h)) {
    const host = { tp, k, h, n: g('n').slice(0, 40) };
    if (hostUrlOk(g('u'))) host.u = g('u').replace(/\/+$/, '');
    const t = g('t'), c = g('c').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (/^[A-Za-z0-9_-]{16,200}$/.test(t)) host.t = t;
    else if (c.length === 8) host.c = c;
    out.host = host;
  }
  return out;
}
export function buildFragment(o) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v != null && v !== '') p.set(k, String(v));
  return '#' + p.toString();
}

// ---------- what the phone keeps (localStorage) ----------
export function loadHost(storage) {
  try { const h = JSON.parse(storage.getItem(STORE_KEY) || 'null'); return h && h.tp && h.k && h.h ? h : null; } catch { return null; }
}
export function saveHost(storage, h) { try { storage.setItem(STORE_KEY, JSON.stringify(h)); return true; } catch { return false; } }
// a new link for the same host keeps what is not in it (the last address…); another host replaces it
export function mergeHost(old, nu) {
  const same = old && old.h === nu.h;
  const m = { ...(same ? old : {}), ...nu, at: Date.now() };
  if (nu.t) delete m.c;   // signed in: the pairing code is not needed any more
  if (nu.c) delete m.t;   // scanned the host's QR (again): this phone pairs afresh
  return m;
}

// ---------- finding the host ----------
// the newest message on the topic this phone can open, from its own host (highest epoch, then the latest)
export async function readRelay({ tp, k, h }, { fetch = globalThis.fetch, relay = RELAY, now = Date.now(), since = '24h' } = {}) {
  let r;
  try { r = await fetch(`${relay}/${tp}/json?poll=1&since=${since}`, { cache: 'no-store' }); }
  catch (e) { throw Object.assign(new Error('relay'), { code: 'relay-down' }); }
  if (!r.ok) throw Object.assign(new Error('relay ' + r.status), { code: 'relay-down' });
  let best = null;
  for (const line of (await r.text()).split('\n')) {
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    if (ev?.event !== 'message') continue;
    const m = await unseal(ev.message, k);
    if (!m || m.v !== 1 || m.hostId !== h || !hostUrlOk(m.url) || !Number.isFinite(m.epoch) || !Number.isFinite(m.ts) || m.ts > now + 10 * 60000) continue;
    if (!best || m.epoch > best.epoch || (m.epoch === best.epoch && m.ts > best.ts)) best = m;
  }
  return best;
}
// is OCTA there, and is it this host? (the ping answers with the host id, and whether the phone remote is on)
// → 'on' | 'off' (OCTA is there but 手機遠端 was turned off) | '' (not there)
export async function ping(url, h, { fetch = globalThis.fetch, timeout = 8000 } = {}) {
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), timeout);
  try {
    const r = await fetch(url.replace(/\/+$/, '') + '/__octa_ping', { cache: 'no-store', signal: ac.signal });
    if (!r.ok) return '';
    const id = r.headers.get('x-octa-host');
    if (id && id !== h) return '';
    return r.headers.get('x-octa-phone') === 'off' ? 'off' : 'on';
  } catch { return ''; } finally { clearTimeout(t); }
}
// → { url, via: 'relay' | 'last', name? } or throws { code: 'down' | 'relay-down' | 'off' }
export async function locate(host, opts = {}) {
  let m = null, relayErr = null, off = false;
  try { m = await readRelay(host, opts); } catch (e) { relayErr = e; }
  const tried = new Set();
  for (const [url, via] of [[m?.url, 'relay'], [host.u, 'last']]) {
    if (!url || tried.has(url)) continue;
    tried.add(url);
    const p = await ping(url, host.h, opts);
    if (p === 'on') return { url, via, ...(via === 'relay' ? { name: m.hostName || '' } : {}) };
    if (p === 'off') off = true;
  }
  throw Object.assign(new Error('down'), { code: off ? 'off' : relayErr && !m ? 'relay-down' : 'down' });
}
// a phone scanned the host's QR: trade the pairing code for this phone's own session token
export async function pairWith(url, code, { fetch = globalThis.fetch } = {}) {
  const r = await fetch(url.replace(/\/+$/, '') + '/api/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, via: 'go' }) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.token) throw Object.assign(new Error(d.error || 'pair ' + r.status), { code: r.status === 401 ? 'code' : 'down' });
  return d.token;
}
// the app on the host's address, signed in with this phone's token (in the fragment, never sent to a server)
export function appUrl(url, { t, web, go }) {
  return url.replace(/\/+$/, '') + '/' + buildFragment({ t, web, go });
}
