// 4.7 郵件連接器: a small IMAP (read) and SMTP (send) client on Node's own tls/net, for an app password
// (Gmail by default; Yahoo, iCloud, Outlook or your own server too). No packages: only the commands OCTA needs.
// Everything here talks to one mailbox; connectors.mjs decides what a bot may do with it.
import net from 'node:net';
import tls from 'node:tls';
import { randomBytes } from 'node:crypto';

// ---------- providers ----------
// port 993 / 465: TLS from the start; 143 / 587: STARTTLS (required — the password never goes in the clear)
export const PROVIDERS = {
  gmail: { label: 'Gmail', imap: { host: 'imap.gmail.com', port: 993 }, smtp: { host: 'smtp.gmail.com', port: 465 }, gmail: true },
  yahoo: { label: 'Yahoo', imap: { host: 'imap.mail.yahoo.com', port: 993 }, smtp: { host: 'smtp.mail.yahoo.com', port: 465 } },
  icloud: { label: 'iCloud', imap: { host: 'imap.mail.me.com', port: 993 }, smtp: { host: 'smtp.mail.me.com', port: 587 } },
  outlook: { label: 'Outlook', imap: { host: 'outlook.office365.com', port: 993 }, smtp: { host: 'smtp.office365.com', port: 587 } },
  custom: { label: '信箱', imap: { host: '', port: 993 }, smtp: { host: '', port: 465 } }
};
export const providerOf = user => {
  const d = String(user || '').split('@')[1]?.toLowerCase() || '';
  if (/^(gmail|googlemail)\.com$/.test(d)) return 'gmail';
  if (/^(yahoo|ymail)\./.test(d)) return 'yahoo';
  if (/^(icloud|me|mac)\.com$/.test(d)) return 'icloud';
  if (/^(outlook|hotmail|live|msn)\./.test(d)) return 'outlook';
  return '';
};
export const ADDR_RE = /^[^\s@<>()",;:\\[\]]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
export const HOST_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

// ---------- a line/literal reader over a socket ----------
class Wire {
  constructor(sock, timeoutMs) {
    this.sock = sock; this.buf = Buffer.alloc(0); this.waiters = []; this.err = null; this.timeoutMs = timeoutMs || 30000;
    this.bind(sock);
  }
  bind(sock) {
    this.sock = sock;
    sock.on('data', d => { this.buf = Buffer.concat([this.buf, d]); this.kick(); });
    sock.on('error', e => { this.err = e; this.kick(); });
    sock.on('close', () => { this.err = this.err || new Error('連線被對方關閉'); this.kick(); });
  }
  kick() { const w = this.waiters.splice(0); for (const f of w) f(); }
  wait() {
    if (this.err) throw this.err;
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('郵件伺服器沒有回應')), this.timeoutMs);
      this.waiters.push(() => { clearTimeout(t); res(); });
    });
  }
  // one CRLF line (SMTP) as a string
  async line() {
    for (;;) {
      const i = this.buf.indexOf('\r\n');
      if (i >= 0) { const l = this.buf.subarray(0, i).toString('utf8'); this.buf = this.buf.subarray(i + 2); return l; }
      if (this.err) throw this.err;
      if (this.buf.length > 1e6) throw new Error('郵件伺服器的回應太長');
      await this.wait();
    }
  }
  // one IMAP response: a line, with any {n} literals and the rest of the line after each
  async item(max = 60e6) {
    let pos = 0;
    for (;;) {
      const i = this.buf.indexOf('\r\n', pos);
      if (i >= 0) {
        const head = this.buf.subarray(Math.max(pos, i - 24), i).toString('latin1');
        const m = head.match(/\{(\d+)\+?\}$/);
        if (!m) { const raw = this.buf.subarray(0, i); this.buf = this.buf.subarray(i + 2); return raw; }
        const n = +m[1];
        if (i + 2 + n > max) throw new Error('信件太大');
        if (this.buf.length >= i + 2 + n) { pos = i + 2 + n; continue; }
      }
      if (this.err) throw this.err;
      await this.wait();
    }
  }
  write(s) { this.sock.write(s); }
  end() { try { this.sock.end(); } catch { } try { this.sock.destroy(); } catch { } }
}

function dial({ host, port, secure, connect, timeoutMs }) {
  return new Promise((res, rej) => {
    const sock = connect ? connect({ host, port, secure }) : secure
      ? tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, minVersion: 'TLSv1.2' })
      : net.connect({ host, port });
    const t = setTimeout(() => { sock.destroy(); rej(new Error('連不上郵件伺服器（逾時）')); }, timeoutMs || 20000);
    sock.once(secure && !connect ? 'secureConnect' : 'connect', () => { clearTimeout(t); res(sock); });
    sock.once('error', e => { clearTimeout(t); rej(new Error('連不上郵件伺服器：' + (e.code || e.message))); });
  });
}
function upgrade(sock, host, opt) {
  if (opt.connect) return Promise.resolve(opt.upgrade ? opt.upgrade(sock) : sock);   // tests: a plain socket stays plain
  return new Promise((res, rej) => {
    const s = tls.connect({ socket: sock, servername: net.isIP(host) ? undefined : host, minVersion: 'TLSv1.2' }, () => res(s));
    s.once('error', e => rej(new Error('加密連線失敗：' + (e.code || e.message))));
  });
}

// ---------- IMAP response parsing ----------
// a response as nested lists: atoms (strings), quoted strings, literals (Buffer), NIL (null)
export function parseImap(raw) {
  const s = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8');
  let i = 0;
  const root = [], stack = [root];
  const top = () => stack[stack.length - 1];
  while (i < s.length) {
    const c = s[i];
    if (c === 0x20 || c === 0x0d || c === 0x0a) { i++; continue; }
    if (c === 0x28) { const l = []; top().push(l); stack.push(l); i++; continue; }
    if (c === 0x29) { if (stack.length > 1) stack.pop(); i++; continue; }
    if (c === 0x22) {   // "quoted"
      let out = [], j = i + 1;
      while (j < s.length && s[j] !== 0x22) { if (s[j] === 0x5c && j + 1 < s.length) j++; out.push(s[j]); j++; }
      top().push(Buffer.from(out).toString('utf8')); i = j + 1; continue;
    }
    if (c === 0x7b) {   // {n}\r\n literal
      const close = s.indexOf(0x7d, i);
      const n = parseInt(s.subarray(i + 1, close).toString('latin1'), 10);
      const start = s.indexOf('\n', close) + 1;
      if (close > 0 && start > 0 && Number.isFinite(n)) { top().push(s.subarray(start, start + n)); i = start + n; continue; }
    }
    let j = i, depth = 0;
    while (j < s.length) {
      const d = s[j];
      if (d === 0x5b) depth++;
      else if (d === 0x5d) depth = Math.max(0, depth - 1);
      else if (!depth && (d === 0x20 || d === 0x28 || d === 0x29 || d === 0x0d || d === 0x0a)) break;
      j++;
    }
    const atom = s.subarray(i, j).toString('utf8');
    top().push(atom.toUpperCase() === 'NIL' ? null : atom);
    i = j === i ? i + 1 : j;
  }
  return root;
}
const str = v => (v == null ? '' : Buffer.isBuffer(v) ? v.toString('utf8') : String(v));

// modified UTF-7 for mailbox names (RFC 3501 5.1.3): Gmail's own folders are named in the account's language
export function encodeMailbox(name) {
  return String(name).replace(/&/g, '&-').replace(/[^\x20-\x7e]+/g, run => {
    const b = Buffer.alloc(run.length * 2 + 4);
    let n = 0;
    for (const ch of run) { const cp = ch.codePointAt(0); const units = cp > 0xffff ? [0xd800 + ((cp - 0x10000) >> 10), 0xdc00 + ((cp - 0x10000) & 0x3ff)] : [cp]; for (const u of units) { b.writeUInt16BE(u, n); n += 2; } }
    return '&' + b.subarray(0, n).toString('base64').replace(/=+$/, '').replace(/\//g, ',') + '-';
  });
}
export function decodeMailbox(name) {
  return String(name).replace(/&([^-]*)-/g, (_, b) => {
    if (!b) return '&';
    const buf = Buffer.from(b.replace(/,/g, '/'), 'base64');
    let out = '';
    for (let i = 0; i + 1 < buf.length; i += 2) out += String.fromCharCode(buf.readUInt16BE(i));
    return out;
  });
}

// ---------- IMAP client ----------
export class Imap {
  constructor(opt) { this.opt = opt; this.n = 0; this.caps = new Set(); }
  async open() {
    const { host, port } = this.opt;
    const implicit = +port === 993 || this.opt.secure === true;
    const sock = await dial({ host, port, secure: implicit, connect: this.opt.connect, timeoutMs: this.opt.timeoutMs });
    this.w = new Wire(sock, this.opt.timeoutMs);
    const hi = str(await this.w.item());
    if (/^\* BYE/i.test(hi)) throw new Error('郵件伺服器拒絕連線');
    this.capsFrom(hi);
    if (!implicit && !this.opt.insecure) {
      if (!this.caps.size) await this.cmd('CAPABILITY');
      if (!this.caps.has('STARTTLS')) throw new Error('這個郵件伺服器不支援加密連線，為了安全不連');
      await this.cmd('STARTTLS');
      const s = await upgrade(this.w.sock, host, this.opt);
      this.w = new Wire(s, this.opt.timeoutMs); this.caps.clear();
    }
    if (!this.caps.size) await this.cmd('CAPABILITY');
    return this;
  }
  capsFrom(line) {
    const m = String(line).match(/CAPABILITY ([^\]\r\n]*)/i);
    if (m) { this.caps = new Set(m[1].trim().toUpperCase().split(/\s+/)); }
  }
  get gmail() { return this.caps.has('X-GM-EXT-1'); }
  // parts: strings and { lit: string } (sent as {n} literals, waiting for "+" each time)
  async cmd(...parts) {
    const tag = 'A' + (++this.n);
    const out = [];
    let line = tag + ' ';
    for (const p of parts) {
      if (p && typeof p === 'object' && 'lit' in p) {
        const b = Buffer.from(String(p.lit), 'utf8');
        this.w.write(line + `{${b.length}}\r\n`); line = '';
        for (;;) {
          const r = str(await this.w.item());
          if (r.startsWith('+')) break;
          if (r.startsWith(tag + ' ')) throw imapError(r);
          out.push(r);
        }
        this.w.write(b);
      } else line += p;
    }
    this.w.write(line + '\r\n');
    for (;;) {
      const raw = await this.w.item(this.opt.maxBytes || 60e6);
      const head = raw.subarray(0, 40).toString('latin1');
      if (head.startsWith(tag + ' ')) {
        const t = str(raw);
        this.capsFrom(t);
        if (!/^\S+ OK/i.test(t)) throw imapError(t);
        return out;
      }
      if (/^\* CAPABILITY /i.test(head)) this.capsFrom(str(raw));
      out.push(raw);
    }
  }
  q(s) {   // a string argument: quoted when plain ASCII, a literal otherwise
    s = String(s);
    return /^[\x20-\x7e]*$/.test(s) ? '"' + s.replace(/[\\"]/g, m => '\\' + m) + '"' : { lit: s };
  }
  async login(user, pass) {
    try { await this.cmd('LOGIN ', this.q(user), ' ', this.q(pass)); }
    catch (e) { const er = new Error(/AUTHENTICATIONFAILED|Invalid credentials|LOGIN failed|authentication failed|incorrect|NO /i.test(e.message) ? '登入失敗：電子郵件或應用程式密碼不對' : e.message); er.login = true; throw er; }
  }
  async list() {
    const rows = await this.cmd('LIST "" "*"');
    return rows.map(r => parseImap(r)).filter(p => /^LIST$/i.test(p[1])).map(p => {
      const flags = (p[2] || []).map(f => String(f).toUpperCase());
      const name = Buffer.isBuffer(p[4]) ? p[4].toString('utf8') : str(p[4]);
      return { name: decodeMailbox(name), raw: name, flags, noselect: flags.includes('\\NOSELECT') };
    });
  }
  async status(box) {
    const rows = await this.cmd('STATUS ', this.q(encodeMailbox(box)), ' (MESSAGES UNSEEN)');
    const p = rows.map(r => parseImap(r)).find(x => /^STATUS$/i.test(x[1]));
    const l = (p && p[3]) || [];
    const o = {};
    for (let i = 0; i + 1 < l.length; i += 2) o[String(l[i]).toUpperCase()] = +l[i + 1];
    return { messages: o.MESSAGES || 0, unseen: o.UNSEEN || 0 };
  }
  async select(box, readOnly) {
    const rows = await this.cmd(readOnly ? 'EXAMINE ' : 'SELECT ', this.q(encodeMailbox(box)));
    const ex = rows.map(r => str(r)).map(t => t.match(/^\* (\d+) EXISTS/i)).find(Boolean);
    this.box = box;
    return { exists: ex ? +ex[1] : 0 };
  }
  // criteria: array of strings and { lit } parts, already joined with spaces by the caller
  async search(parts) {
    const utf = parts.some(p => typeof p === 'object');
    const rows = await this.cmd('UID SEARCH ', ...(utf ? ['CHARSET UTF-8 '] : []), ...parts);
    const ids = [];
    for (const r of rows) { const t = str(r); if (/^\* SEARCH/i.test(t)) for (const x of t.slice(8).trim().split(/\s+/)) if (/^\d+$/.test(x)) ids.push(+x); }
    return ids;
  }
  async fetch(uids, items) {
    if (!uids.length) return [];
    const rows = await this.cmd(`UID FETCH ${uids.join(',')} (${items})`);
    const out = [];
    for (const r of rows) {
      const p = parseImap(r);
      if (!/^FETCH$/i.test(p[2]) || !Array.isArray(p[3])) continue;
      const o = {};
      for (let i = 0; i + 1 < p[3].length; i += 2) o[String(p[3][i]).toUpperCase().replace(/\.PEEK/, '')] = p[3][i + 1];
      out.push(o);
    }
    return out;
  }
  async store(uids, op, flags) { await this.cmd(`UID STORE ${uids.join(',')} ${op} (${flags})`); }
  async logout() { try { await Promise.race([this.cmd('LOGOUT'), new Promise(r => setTimeout(r, 1500))]); } catch { } this.w?.end(); }
  close() { this.w?.end(); }
}
function imapError(t) {
  const msg = String(t).replace(/^\S+ (NO|BAD)\s*/i, '').replace(/^\[[^\]]*\]\s*/, '').trim();
  const e = new Error(msg || '郵件伺服器拒絕了這個動作'); e.imap = true; return e;
}

// ---------- MIME ----------
const decoders = new Map();
export function decodeText(buf, charset) {
  let cs = String(charset || 'utf-8').trim().toLowerCase().replace(/^"|"$/g, '');
  if (cs === 'ks_c_5601-1987') cs = 'euc-kr';
  if (/^(us-)?ascii$/.test(cs)) cs = 'utf-8';
  try {
    let d = decoders.get(cs);
    if (!d) { d = new TextDecoder(cs); decoders.set(cs, d); }
    return d.decode(buf);
  } catch { return Buffer.from(buf).toString('utf8'); }
}
function qp(s, header) {
  const bytes = [];
  const t = header ? s.replace(/_/g, ' ') : s.replace(/=\r?\n/g, '');
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(t.slice(i + 1, i + 3))) { bytes.push(parseInt(t.slice(i + 1, i + 3), 16)); i += 2; }
    else bytes.push(t.charCodeAt(i) & 0xff);
  }
  return Buffer.from(bytes);
}
// =?charset?B|Q?…?= words (adjacent words join without the space between them)
export function decodeWords(v) {
  return String(v || '').replace(/(=\?[^?]+\?[BbQq]\?[^?]*\?=)\s+(?==\?)/g, '$1').replace(/=\?([^?*]+)(?:\*[^?]*)?\?([BbQq])\?([^?]*)\?=/g, (_, cs, enc, txt) => {
    const b = /b/i.test(enc) ? Buffer.from(txt, 'base64') : qp(txt, true);
    return decodeText(b, cs);
  });
}
function headerBlock(text) {
  const lines = text.split(/\r?\n/), h = {};
  let cur = null;
  for (const l of lines) {
    if (/^[ \t]/.test(l) && cur) { h[cur][h[cur].length - 1] += ' ' + l.trim(); continue; }
    const m = l.match(/^([!-9;-~]+):\s*(.*)$/);
    if (!m) continue;
    cur = m[1].toLowerCase();
    (h[cur] = h[cur] || []).push(m[2]);
  }
  return h;
}
// "text/plain; charset=utf-8; name*=UTF-8''%E5…" → { value, params }
export function headerParams(v) {
  const parts = [];
  let cur = '', q = false;
  for (const ch of String(v || '')) {
    if (ch === '"') q = !q;
    if (ch === ';' && !q) { parts.push(cur); cur = ''; } else cur += ch;
  }
  parts.push(cur);
  const params = {}, star = {};
  for (const p of parts.slice(1)) {
    const m = p.match(/^\s*([^=\s]+)\s*=\s*(.*)$/s);
    if (!m) continue;
    let k = m[1].toLowerCase(), val = m[2].trim();
    if (/^".*"$/s.test(val)) val = val.slice(1, -1).replace(/\\(.)/g, '$1');
    const sm = k.match(/^([^*]+)\*(\d+)?(\*)?$/);
    if (sm) { (star[sm[1]] = star[sm[1]] || []).push({ n: +(sm[2] || 0), enc: !!sm[3] || (!sm[2] && k.endsWith('*')), val }); continue; }
    params[k] = decodeWords(val);
  }
  for (const [k, list] of Object.entries(star)) {   // RFC 2231
    list.sort((a, b) => a.n - b.n);
    let cs = 'utf-8', bytes = [];
    list.forEach((x, i) => {
      let val = x.val;
      if (x.enc && i === 0) { const m = val.match(/^([^']*)'[^']*'(.*)$/s); if (m) { cs = m[1] || cs; val = m[2]; } }
      if (x.enc) val.replace(/%([0-9A-Fa-f]{2})|([^%]+|%)/g, (_, hx, rest) => { if (hx) bytes.push(parseInt(hx, 16)); else bytes.push(...Buffer.from(rest, 'latin1')); return ''; });
      else bytes.push(...Buffer.from(val, 'utf8'));
    });
    params[k] = decodeText(Buffer.from(bytes), cs);
  }
  return { value: parts[0].trim().toLowerCase(), params };
}
function bodyBytes(raw, enc) {
  enc = String(enc || '').trim().toLowerCase();
  if (enc === 'base64') return Buffer.from(raw.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
  if (enc === 'quoted-printable') return qp(raw.toString('latin1'));
  return raw;
}
// raw message (Buffer) → { headers, from, to, cc, subject, date, messageId, references, text, html, attachments: [{ name, type, size, data }] }
export function parseMail(raw, depth = 0) {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8');
  const out = { text: '', html: '', attachments: [] };
  const top = splitPart(buf);
  out.headers = top.h;
  const one = k => decodeWords((top.h[k] || [''])[0]).trim();
  Object.assign(out, { from: one('from'), to: one('to'), cc: one('cc'), subject: one('subject'), date: one('date'), messageId: (top.h['message-id'] || [''])[0].trim(), references: (top.h.references || [''])[0].trim(), replyTo: one('reply-to') });
  walk(top, out, depth);
  return out;
}
function splitPart(buf) {
  const s = buf.toString('latin1');
  let i = s.search(/\r?\n\r?\n/);
  if (i < 0) i = s.length;
  const m = s.slice(i).match(/^\r?\n\r?\n/);
  return { h: headerBlock(s.slice(0, i)), body: buf.subarray(i + (m ? m[0].length : 0)) };
}
function walk(part, out, depth) {
  const ct = headerParams((part.h['content-type'] || ['text/plain'])[0]);
  const cd = headerParams((part.h['content-disposition'] || [''])[0]);
  const enc = (part.h['content-transfer-encoding'] || [''])[0];
  if (ct.value.startsWith('multipart/') && ct.params.boundary && depth < 12) {
    const b = '--' + ct.params.boundary;
    let s = part.body.toString('latin1');
    const end = s.search(new RegExp('(?:^|\\r?\\n)' + b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '--'));
    if (end >= 0) s = s.slice(0, end);
    const pieces = s.split(new RegExp('(?:^|\\r?\\n)' + b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:--)?[ \\t]*(?=\\r?\\n|$)'));
    for (const p of pieces.slice(1)) {
      const t = p.replace(/^\r?\n/, '');
      if (!t.trim()) continue;
      walk(splitPart(Buffer.from(t, 'latin1')), out, depth + 1);
    }
    return;
  }
  const name = cd.params.filename || ct.params.name || '';
  const data = bodyBytes(part.body, enc);
  const attach = cd.value === 'attachment' || (name && !/^text\/(plain|html)$/.test(ct.value)) || (!ct.value.startsWith('text/') && ct.value !== '');
  if (ct.value === 'message/rfc822' || attach) {
    out.attachments.push({ name: cleanName(name || (ct.value === 'message/rfc822' ? 'message.eml' : 'attachment')), type: ct.value || 'application/octet-stream', size: data.length, data, inline: cd.value === 'inline', cid: (part.h['content-id'] || [''])[0].replace(/[<>]/g, '').trim() });
    return;
  }
  const text = decodeText(data, ct.params.charset);
  if (ct.value === 'text/html') { if (!out.html) out.html = text; }
  else if (!out.text) out.text = text;
  else out.text += '\n\n' + text;
}
export function cleanName(n) {
  const s = String(n || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+/, '').trim().slice(0, 120);
  return s || 'attachment';
}
const ENT = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', copy: '©', reg: '®', middot: '·', bull: '•', yen: '¥', euro: '€' };
export function htmlToText(html) {
  return String(html || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|head|title|template|svg)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<a\b[^>]*href\s*=\s*["']?(https?:[^"'\s>]+)["']?[^>]*>([\s\S]*?)<\/a>/gi, (_, href, t) => { const tx = t.replace(/<[^>]+>/g, '').trim(); return tx && !tx.includes(href) && tx.length < 80 ? `${tx} (${href})` : tx || href; })
    .replace(/<(br|hr)\b[^>]*>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote|section|article|header|footer)>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '• ')
    .replace(/<\/t[dh]>/gi, '\t')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e) => {
      if (e[0] === '#') { const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1); try { return String.fromCodePoint(cp); } catch { return ''; } }
      return ENT[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
// what a bot reads from a mail: plain text, no control characters, and none of OCTA's own markers
// (a mail is written by someone else; its "instructions" must not look like the bot's)
export function safeText(t, max = 8000) {
  let s = String(t || '').replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f​-‏‪-‮⁦-⁩]/g, '');
  s = s.replace(/【/g, '[').replace(/】/g, ']').replace(/✅\s*待確認/g, '(待確認)').replace(/(📌|🧩|📝|⏰|🗺️|📍|🧭)/gu, '')
    .replace(/^\s*(核准|不要做)\s*[:：]/gm, '$1 -').replace(/\n{3,}/g, '\n\n').trim();
  return s.length > max ? s.slice(0, max) + '\n…（後面省略，共 ' + s.length + ' 字）' : s;
}

// ---------- building a message ----------
const enc = s => (/^[\x20-\x7e]*$/.test(s) ? s : '=?UTF-8?B?' + Buffer.from(s, 'utf8').toString('base64') + '?=');
// long non-ASCII headers: split into encoded words of up to ~45 bytes each (on character boundaries)
function encLong(s) {
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  const words = []; let cur = '';
  for (const ch of s) { if (Buffer.byteLength(cur + ch) > 45) { words.push(cur); cur = ''; } cur += ch; }
  if (cur) words.push(cur);
  return words.map(w => '=?UTF-8?B?' + Buffer.from(w, 'utf8').toString('base64') + '?=').join('\r\n ');
}
const wrap76 = b64 => b64.replace(/.{1,76}/g, '$&\r\n');
const MIME = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', txt: 'text/plain', csv: 'text/csv', html: 'text/html', json: 'application/json', zip: 'application/zip', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', md: 'text/markdown', mp3: 'audio/mpeg', mp4: 'video/mp4', eml: 'message/rfc822' };
export const mimeOf = n => MIME[String(n).split('.').pop().toLowerCase()] || 'application/octet-stream';
const fmtAddr = a => (a.name ? `${enc(a.name.replace(/["\r\n]/g, ''))} <${a.addr}>` : a.addr);

// m: { from: {name, addr}, to: [addr], cc: [addr], subject, text, inReplyTo, references, attachments: [{ name, data }] }
export function buildMail(m) {
  const domain = String(m.from.addr).split('@')[1] || 'octa.local';
  const id = `<${Date.now().toString(36)}.${randomBytes(8).toString('hex')}@${domain}>`;
  const h = [
    `From: ${fmtAddr(m.from)}`,
    `To: ${m.to.join(', ')}`,
    ...(m.cc?.length ? [`Cc: ${m.cc.join(', ')}`] : []),
    `Subject: ${encLong(String(m.subject || '').replace(/[\r\n]+/g, ' '))}`,
    `Date: ${new Date().toUTCString().replace(/GMT$/, '+0000')}`,
    `Message-ID: ${id}`,
    ...(m.inReplyTo ? [`In-Reply-To: ${m.inReplyTo}`, `References: ${(m.references ? m.references + ' ' : '') + m.inReplyTo}`.slice(0, 900)] : []),
    'MIME-Version: 1.0',
    'X-Mailer: OCTA'
  ];
  const text = String(m.text || '').replace(/\r?\n/g, '\r\n');
  const textPart = ['Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', wrap76(Buffer.from(text, 'utf8').toString('base64'))].join('\r\n');
  let body;
  if (!m.attachments?.length) body = h.join('\r\n') + '\r\n' + textPart;
  else {
    const b = 'octa-' + randomBytes(12).toString('hex');
    const parts = [textPart, ...m.attachments.map(a => {
      const nm = String(a.name).replace(/["\r\n\\]/g, '_');
      const ascii = /^[\x20-\x7e]*$/.test(nm);
      return [
        `Content-Type: ${a.type || mimeOf(nm)}; name="${ascii ? nm : enc(nm)}"`,
        `Content-Disposition: attachment; ${ascii ? `filename="${nm}"` : `filename*=UTF-8''${encodeURIComponent(nm)}`}`,
        'Content-Transfer-Encoding: base64', '', wrap76(Buffer.from(a.data).toString('base64'))
      ].join('\r\n');
    })];
    body = h.join('\r\n') + `\r\nContent-Type: multipart/mixed; boundary="${b}"\r\n\r\n` + parts.map(p => `--${b}\r\n${p}`).join('\r\n') + `\r\n--${b}--\r\n`;
  }
  return { id, raw: body };
}

// ---------- SMTP ----------
async function reply(w) {
  let code = 0, lines = [];
  for (;;) {
    const l = await w.line();
    const m = l.match(/^(\d{3})([ -])(.*)$/);
    if (!m) { lines.push(l); continue; }
    code = +m[1]; lines.push(m[3]);
    if (m[2] === ' ') return { code, text: lines.join('\n') };
  }
}
async function say(w, line, okCodes) {
  w.write(line + '\r\n');
  const r = await reply(w);
  if (!okCodes.includes(r.code)) {
    const e = new Error(r.text.replace(/\s+/g, ' ').slice(0, 300)); e.code = r.code; throw e;
  }
  return r;
}
// opt: { host, port, user, pass, connect?, insecure? }; env: { from, rcpt: [] } (null: sign in and stop); raw: buildMail().raw
export async function smtpSend(opt, env, raw) {
  const implicit = +opt.port === 465 || opt.secure === true;
  const sock = await dial({ host: opt.host, port: opt.port, secure: implicit, connect: opt.connect, timeoutMs: opt.timeoutMs });
  let w = new Wire(sock, opt.timeoutMs || 60000);
  try {
    const hi = await reply(w);
    if (hi.code !== 220) throw new Error('寄信伺服器拒絕連線：' + hi.text);
    let ehlo = await say(w, 'EHLO octa.local', [250]);
    if (!implicit && !opt.insecure) {
      if (!/^STARTTLS\b/im.test(ehlo.text)) throw new Error('這個寄信伺服器不支援加密連線，為了安全不寄');
      await say(w, 'STARTTLS', [220]);
      w = new Wire(await upgrade(w.sock, opt.host, opt), opt.timeoutMs || 60000);
      ehlo = await say(w, 'EHLO octa.local', [250]);
    }
    const auth = (ehlo.text.match(/^AUTH[ =](.*)$/im) || [])[1]?.toUpperCase() || 'PLAIN LOGIN';
    try {
      if (/\bPLAIN\b/.test(auth)) await say(w, 'AUTH PLAIN ' + Buffer.from(`\0${opt.user}\0${opt.pass}`, 'utf8').toString('base64'), [235]);
      else {
        await say(w, 'AUTH LOGIN', [334]);
        await say(w, Buffer.from(opt.user, 'utf8').toString('base64'), [334]);
        await say(w, Buffer.from(opt.pass, 'utf8').toString('base64'), [235]);
      }
    } catch (e) { const er = new Error(e.code === 535 || e.code === 534 ? '寄信登入失敗：電子郵件或應用程式密碼不對' : '寄信登入失敗：' + e.message); er.login = true; throw er; }
    if (!env) { try { w.write('QUIT\r\n'); } catch { } return true; }   // only checking the sign-in
    await say(w, `MAIL FROM:<${env.from}>`, [250]);
    for (const r of env.rcpt) await say(w, `RCPT TO:<${r}>`, [250, 251]);
    await say(w, 'DATA', [354]);
    const data = raw.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
    w.write(data + (data.endsWith('\r\n') ? '' : '\r\n'));
    await say(w, '.', [250]);
    try { w.write('QUIT\r\n'); } catch { }
    return true;
  } finally { setTimeout(() => w.end(), 200); }
}
