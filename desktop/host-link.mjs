// 4.3 主機電腦／遙控器: one computer (the host) keeps the data and does all the work; other computers are its
// remote controls. No OCTA server is involved:
// - The host is reached through its own Cloudflare quick tunnel (the same one the phone remote uses). Its address
//   changes every time the tunnel restarts, so the host publishes the current address — encrypted with a secret only
//   the linked computers know — on a free public relay (ntfy.sh). A remote control that lost the host looks there.
// - Linking once: the host shows one 連線碼 (its address + an 8-character code). The remote control pairs with it and
//   gets a long-lived device token and the shared link secret.
// Everything here is pure (fetch is passed in) so it can be tested without the network.
import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export const RELAY = 'https://ntfy.sh';
export const REPUBLISH_MS = 6 * 3600 * 1000;   // ntfy.sh keeps messages about 12 hours
export const LINK_TAG = 'octa-link=';

const sha = s => createHash('sha256').update(s).digest();
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
function base32(buf) {
  let bits = 0, val = 0, out = '';
  for (const b of buf) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits) out += B32[(val << (5 - bits)) & 31];
  return out;
}
export const newSecret = () => randomBytes(32).toString('base64url');
export const newId = () => randomBytes(9).toString('base64url');
// the relay topic and the encryption key both come from the shared secret; the topic alone tells nothing
export const topicOf = secret => base32(sha('octa-topic:' + secret)).slice(0, 32);
const keyOf = secret => sha('octa-key:' + secret);

// AES-256-GCM: "o1." + base64url(iv | tag | ciphertext)
export function seal(obj, secret) {
  const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', keyOf(secret), iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return 'o1.' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url');
}
export function unseal(text, secret) {
  try {
    if (typeof text !== 'string' || !text.startsWith('o1.')) return null;
    const raw = Buffer.from(text.slice(3), 'base64url');
    if (raw.length < 29) return null;
    const d = createDecipheriv('aes-256-gcm', keyOf(secret), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8'));
  } catch { return null; }
}

// an address the host may be at: the tunnel (https), or this computer itself (tests, the same machine)
export function hostUrlOk(u) {
  try {
    const x = new URL(String(u));
    if (x.username || x.password || x.search || x.hash) return false;
    if (x.protocol === 'https:') return true;
    return x.protocol === 'http:' && /^(127\.0\.0\.1|localhost)$/.test(x.hostname);
  } catch { return false; }
}
const trimUrl = u => String(u).trim().replace(/\/+$/, '');

// the one string the host shows: its address with the code after "#octa-link=". Pasting the address and the
// code separately (with a space or a new line between) works too.
export function encodeLinkCode({ url, code }) { return `${trimUrl(url)}#${LINK_TAG}${String(code).toUpperCase()}`; }
export function decodeLinkCode(text, code2) {
  const s = String(text || '').trim();
  let url = s, code = String(code2 || '').trim();
  const i = s.indexOf('#' + LINK_TAG);
  if (i >= 0) { url = s.slice(0, i); code = s.slice(i + 1 + LINK_TAG.length); }
  else { const parts = s.split(/\s+/); if (parts.length === 2) [url, code] = parts; }
  url = trimUrl(url);
  if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;
  code = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!hostUrlOk(url)) return { error: '網址不正確，請貼上主機電腦顯示的完整連線碼' };
  if (code.length !== 8) return { error: '連線碼少了 8 碼的配對碼' };
  return { url, code };
}

const withTimeout = (fetch, ms) => (url, init = {}) => {
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), ms);
  return fetch(url, { ...init, signal: ac.signal }).finally(() => clearTimeout(t));
};

// the host: tell the linked computers where it is now
export async function publishHost({ secret, url, epoch, hostId, hostName, fetch = globalThis.fetch, relay = RELAY, now = Date.now() }) {
  const body = seal({ v: 1, url: trimUrl(url), epoch: +epoch || 0, hostId, hostName: hostName || '', ts: now }, secret);
  const r = await withTimeout(fetch, 15000)(`${relay}/${topicOf(secret)}`, { method: 'POST', body, headers: { 'content-type': 'text/plain' } });
  if (!r.ok) throw Object.assign(new Error('轉送服務回應 ' + r.status), { code: 'relay-down' });
  return true;
}

// a remote control: the newest address the host published (highest epoch, then the latest), or null
export async function pollHost({ secret, fetch = globalThis.fetch, relay = RELAY, since = '24h', now = Date.now() }) {
  let r;
  try { r = await withTimeout(fetch, 15000)(`${relay}/${topicOf(secret)}/json?poll=1&since=${since}`); }
  catch (e) { throw Object.assign(new Error('連不到轉送服務 ntfy.sh'), { code: 'relay-down', cause: e }); }
  if (!r.ok) throw Object.assign(new Error('轉送服務回應 ' + r.status), { code: 'relay-down' });
  let best = null;
  for (const line of (await r.text()).split('\n')) {
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    if (ev?.event !== 'message') continue;
    const m = unseal(ev.message, secret);
    if (!m || m.v !== 1 || !hostUrlOk(m.url) || !Number.isFinite(m.epoch) || typeof m.hostId !== 'string' || !m.hostId) continue;
    if (!Number.isFinite(m.ts) || m.ts > now + 10 * 60000) continue;   // a clock far in the future is not trusted
    if (!best || m.epoch > best.epoch || (m.epoch === best.epoch && m.ts > best.ts)) best = m;
  }
  return best;
}

// is the host at this address, and is it still the host? (needs this computer's device token)
export async function helloHost(url, token, { fetch = globalThis.fetch, timeout = 12000 } = {}) {
  let r;
  try { r = await withTimeout(fetch, timeout)(`${trimUrl(url)}/api/link/hello`, { headers: { authorization: 'Bearer ' + token } }); }
  catch (e) { throw Object.assign(new Error('連不到主機電腦'), { code: 'down', cause: e }); }
  if (r.status === 401) throw Object.assign(new Error('主機電腦已經移除這台電腦'), { code: 'revoked' });
  const d = (r.headers.get('content-type') || '').includes('json') ? await r.json().catch(() => null) : null;
  if (!r.ok || !d?.hostId) throw Object.assign(new Error('連不到主機電腦'), { code: 'down', status: r.status });
  return d;
}

// find the host: the last address first, then the relay. → { url, info, via: 'last' | 'relay' }
// Errors carry .code: 'revoked' (token no longer accepted), 'relay-down' (the address changed and ntfy.sh can't be
// reached), 'down' (the host is not reachable at any known address), 'moved' (another computer is the host now).
export async function findHost({ link, fetch = globalThis.fetch, relay = RELAY, now }) {
  const tried = new Set();
  const attempt = async (url, via) => {
    tried.add(url);
    const info = await helloHost(url, link.token, { fetch });
    if (link.hostId && info.hostId !== link.hostId && !(info.role === 'host' && (+info.epoch || 0) > (+link.epoch || 0)))
      throw Object.assign(new Error('這個網址是另一台電腦'), { code: 'down' });
    return { url, info, via };
  };
  let lastErr = null;
  if (link.lastUrl && hostUrlOk(link.lastUrl)) {
    try { const r = await attempt(link.lastUrl, 'last'); if (r.info.role === 'host') return r; lastErr = Object.assign(new Error('那台電腦已經不是主機'), { code: 'moved', found: r }); }
    catch (e) { if (e.code === 'revoked') throw e; lastErr = e; }
  }
  if (!link.secret) throw lastErr || Object.assign(new Error('沒有主機電腦的網址'), { code: 'down' });
  const m = await pollHost({ secret: link.secret, fetch, relay, now });
  if (!m) throw lastErr?.code === 'moved' ? lastErr : Object.assign(new Error('主機電腦最近沒有上線'), { code: 'down' });
  if (m.hostId !== link.hostId && m.epoch > (+link.epoch || 0))
    // another computer became the host (換成這台當主機 from a third computer): follow it if our token works there
    try { const info = await helloHost(m.url, link.token, { fetch }); return { url: m.url, info, via: 'relay', moved: m }; }
    catch (e) { throw Object.assign(new Error('主機換到「' + (m.hostName || '另一台電腦') + '」了，請重新連線'), { code: e.code === 'down' ? 'down' : 'revoked', moved: m }); }
  if (tried.has(m.url)) throw lastErr || Object.assign(new Error('連不到主機電腦'), { code: 'down' });
  return attempt(m.url, 'relay');
}

// a remote control's connection: keeps the host's address, notices when it is gone and looks it up again with a
// growing pause (5 s … 60 s). getLink/saveLink read and keep the link settings (desktop.json).
export function createRemoteClient({ getLink, saveLink, fetch = globalThis.fetch, relay = RELAY, onState = () => { }, timers = { setTimeout, clearTimeout } }) {
  const st = { state: 'connecting', url: '', info: null, error: '', at: 0, tries: 0 };
  let timer = null, running = null, stopped = false;
  const set = p => { Object.assign(st, p, { at: Date.now() }); try { onState({ ...st }); } catch { } };
  async function connect() {
    if (running) return running;
    running = (async () => {
      timers.clearTimeout(timer); timer = null;
      const link = getLink();
      if (!link || link.role !== 'remote') return null;
      if (!link.token) { set({ state: 'revoked', error: '需要重新連線到主機電腦' }); return null; }
      try {
        const r = await findHost({ link, fetch, relay });
        st.tries = 0;
        const upd = { lastUrl: r.url, hostName: r.info.name || link.hostName };
        if (r.info.hostId !== link.hostId) Object.assign(upd, { hostId: r.info.hostId, epoch: +r.info.epoch || link.epoch });
        if (upd.lastUrl !== link.lastUrl || upd.hostName !== link.hostName || upd.hostId) saveLink({ ...link, ...upd });
        set({ state: 'online', url: r.url, info: r.info, error: '' });
        return r.url;
      } catch (e) {
        st.tries++;
        set({ state: e.code === 'revoked' ? 'revoked' : e.code === 'relay-down' ? 'relay-down' : e.code === 'moved' ? 'moved' : 'offline', url: '', error: e.message });
        if (!stopped && e.code !== 'revoked') timer = timers.setTimeout(() => { connect(); }, Math.min(60000, 5000 * 2 ** Math.min(st.tries - 1, 4)));
        return null;
      }
    })().finally(() => { running = null; });
    return running;
  }
  return {
    status: () => ({ ...st }),
    // the address to use now ('' while looking)
    url: () => (st.state === 'online' ? st.url : ''),
    connect,
    // a request to the host failed: look for it again (once; later failures join the same search)
    lost(why) { if (st.state === 'online') { set({ state: 'offline', url: '', error: why || '連不到主機電腦' }); connect(); } },
    stop() { stopped = true; timers.clearTimeout(timer); timer = null; }
  };
}
