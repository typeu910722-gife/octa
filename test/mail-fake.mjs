// A fake IMAP and SMTP server on 127.0.0.1 (plain TCP) for the 郵件連接器 tests.
import net from 'node:net';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const repo = join(import.meta.dirname, '..');
const { parseImap, encodeMailbox, decodeMailbox } = await import(pathToFileURL(join(repo, 'desktop/lib/mail.mjs')).href);

const str = v => (v == null ? '' : Buffer.isBuffer(v) ? v.toString('utf8') : String(v));
const lit = b => { const x = Buffer.isBuffer(b) ? b : Buffer.from(b, 'utf8'); return Buffer.concat([Buffer.from(`{${x.length}}\r\n`), x]); };

// boxes: { name: [{ uid, flags: [], date: '03-Nov-2026 10:00:00 +0800', raw, labels: [] }] }
export function fakeImap({ user, pass, gmail = true, starttls = false, boxes }) {
  const log = [];
  const srv = net.createServer(sock => {
    let buf = Buffer.alloc(0), cur = [], need = 0, authed = false, sel = null;
    const caps = `IMAP4rev1 UIDPLUS MOVE${gmail ? ' X-GM-EXT-1' : ''}${starttls ? ' STARTTLS' : ''}`;
    const w = b => sock.write(b);
    w(`* OK [CAPABILITY ${caps}] fake ready\r\n`);
    sock.on('error', () => { });
    sock.on('data', d => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (need) {
          if (buf.length < need) return;
          cur.push(buf.subarray(0, need)); buf = buf.subarray(need); need = 0; continue;
        }
        const i = buf.indexOf('\r\n');
        if (i < 0) return;
        const line = buf.subarray(0, i); buf = buf.subarray(i + 2);
        cur.push(line);
        const m = line.toString('latin1').match(/\{(\d+)\}$/);
        if (m) { cur.push(Buffer.from('\r\n')); need = +m[1]; w('+ go on\r\n'); if (!need) need = 0; continue; }
        const raw = Buffer.concat(cur); cur = [];
        try { handle(raw); } catch (e) { w(`* BAD ${e.message}\r\n`); }
      }
    });
    function handle(raw) {
      const text = raw.toString('utf8');
      const p = parseImap(raw);
      const tag = p[0], cmd = String(p[1] || '').toUpperCase();
      log.push(text.replace(/\{\d+\}\r\n/g, ''));
      const ok = (s = 'done') => w(`${tag} OK ${s}\r\n`);
      if (cmd === 'CAPABILITY') { w(`* CAPABILITY ${caps}\r\n`); return ok(); }
      if (cmd === 'LOGOUT') { w('* BYE bye\r\n'); ok(); return sock.end(); }
      if (cmd === 'LOGIN') {
        if (str(p[2]) === user && str(p[3]) === pass) { authed = true; return ok('[CAPABILITY ' + caps + '] logged in'); }
        return w(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)\r\n`);
      }
      if (!authed) return w(`${tag} BAD not logged in\r\n`);
      if (cmd === 'LIST') {
        for (const name of Object.keys(boxes)) w(`* LIST (\\HasNoChildren${/所有郵件|All Mail/.test(name) ? ' \\All' : /Archive/.test(name) ? ' \\Archive' : ''}) "/" "${encodeMailbox(name)}"\r\n`);
        return ok();
      }
      if (cmd === 'STATUS') {
        const b = boxes[decodeMailbox(str(p[2]))] || [];
        w(`* STATUS "${str(p[2])}" (MESSAGES ${b.length} UNSEEN ${b.filter(x => !x.flags.includes('\\Seen')).length})\r\n`);
        return ok();
      }
      if (cmd === 'SELECT' || cmd === 'EXAMINE') {
        const name = decodeMailbox(str(p[2]));
        if (!boxes[name]) return w(`${tag} NO no such mailbox\r\n`);
        sel = name; w(`* ${boxes[name].length} EXISTS\r\n`); return ok(cmd === 'EXAMINE' ? '[READ-ONLY]' : '[READ-WRITE]');
      }
      if (cmd !== 'UID' || !sel) return w(`${tag} BAD unknown\r\n`);
      const sub = String(p[2]).toUpperCase(), msgs = boxes[sel];
      const pick = set => String(set).split(',').map(Number).map(u => msgs.find(x => x.uid === u)).filter(Boolean);
      if (sub === 'SEARCH') {
        let hits = [...msgs];
        const a = p.slice(3);
        for (let i = 0; i < a.length; i++) {
          const k = String(a[i]).toUpperCase(), v = str(a[i + 1]).toLowerCase();
          const hdr = (x, h) => (x.raw.toString('utf8').match(new RegExp('^' + h + ':(.*)$', 'mi')) || [])[1]?.toLowerCase() || '';
          if (k === 'CHARSET') { i++; continue; }
          if (k === 'UNSEEN') hits = hits.filter(x => !x.flags.includes('\\Seen'));
          else if (k === 'FROM') { hits = hits.filter(x => hdr(x, 'From').includes(v)); i++; }
          else if (k === 'SUBJECT') { hits = hits.filter(x => (x.subject || hdr(x, 'Subject')).toLowerCase().includes(v)); i++; }
          else if (k === 'TEXT') { hits = hits.filter(x => x.raw.toString('utf8').toLowerCase().includes(v)); i++; }
          else if (k === 'SINCE') { const t = Date.parse(v.replace(/-/g, ' ')); hits = hits.filter(x => Date.parse(x.date.replace(/^(\d+)-(\w+)-(\d+)/, '$1 $2 $3')) >= t); i++; }
          else if (k === 'X-GM-RAW') { const f = v.match(/from:(\S+)/); hits = hits.filter(x => f ? hdr(x, 'From').includes(f[1]) : x.raw.toString('utf8').toLowerCase().includes(v)); i++; }
        }
        w(`* SEARCH${hits.map(x => ' ' + x.uid).join('')}\r\n`); return ok();
      }
      if (sub === 'FETCH') {
        const want = text.toUpperCase();
        for (const x of pick(p[3])) {
          const seq = msgs.indexOf(x) + 1;
          const parts = [Buffer.from(`* ${seq} FETCH (UID ${x.uid}`)];
          if (want.includes('FLAGS')) parts.push(Buffer.from(` FLAGS (${x.flags.join(' ')})`));
          if (want.includes('INTERNALDATE')) parts.push(Buffer.from(` INTERNALDATE "${x.date}"`));
          if (want.includes('RFC822.SIZE')) parts.push(Buffer.from(` RFC822.SIZE ${x.raw.length}`));
          if (want.includes('BODYSTRUCTURE')) parts.push(Buffer.from(x.att ? ' BODYSTRUCTURE (("text" "plain" ("charset" "utf-8") NIL NIL "7bit" 10 1 NIL NIL NIL)("application" "pdf" ("name" "a.pdf") NIL NIL "base64" 100 NIL ("attachment" ("filename" "a.pdf")) NIL) "mixed")' : ' BODYSTRUCTURE ("text" "plain" ("charset" "utf-8") NIL NIL "7bit" 10 1 NIL NIL NIL)'));
          if (want.includes('HEADER.FIELDS')) {
            const s = x.raw.toString('latin1'), end = s.indexOf('\r\n\r\n');
            const h = s.slice(0, end).split('\r\n').filter(l => /^(From|Subject|Date):/i.test(l)).join('\r\n') + '\r\n\r\n';
            parts.push(Buffer.from(' BODY[HEADER.FIELDS (FROM SUBJECT DATE)] '), lit(Buffer.from(h, 'latin1')));
          }
          if (/BODY\.PEEK\[\]/.test(want)) parts.push(Buffer.from(' BODY[] '), lit(x.raw));
          parts.push(Buffer.from(')\r\n'));
          w(Buffer.concat(parts));
        }
        return ok();
      }
      if (sub === 'STORE') {
        const op = String(p[4]).toUpperCase(), flags = (p[5] || []).map(str);
        for (const x of pick(p[3])) {
          if (op.includes('X-GM-LABELS')) { x.labels = x.labels || []; if (op.startsWith('+')) x.labels.push(...flags.map(decodeMailbox)); else x.labels = x.labels.filter(l => !flags.includes(l)); if (op.startsWith('-') && flags.includes('\\Inbox')) x.archived = true; }
          else if (op.startsWith('+')) x.flags = [...new Set([...x.flags, ...flags])];
          else x.flags = x.flags.filter(f => !flags.includes(f));
        }
        return ok();
      }
      if (sub === 'MOVE') {
        const dest = decodeMailbox(str(p[4]));
        if (!boxes[dest]) return w(`${tag} NO no such mailbox\r\n`);
        for (const x of pick(p[3])) { msgs.splice(msgs.indexOf(x), 1); boxes[dest].push(x); }
        return ok();
      }
      w(`${tag} BAD unknown\r\n`);
    }
  });
  return new Promise(res => srv.listen(0, '127.0.0.1', () => res({ port: srv.address().port, log, close: () => srv.close(), srv })));
}

export function fakeSmtp({ user, pass, starttls = false }) {
  const sent = [], log = [];
  const srv = net.createServer(sock => {
    let buf = '', data = null, mail = null;
    const w = s => sock.write(s + '\r\n');
    sock.on('error', () => { });
    w('220 fake smtp');
    sock.on('data', d => {
      buf += d.toString('latin1');
      for (;;) {
        if (data != null) {
          const end = buf.indexOf('\r\n.\r\n');
          if (end < 0) return;
          data += buf.slice(0, end); buf = buf.slice(end + 5);
          mail.data = Buffer.from(data.replace(/^\.\./gm, '.'), 'latin1').toString('utf8'); sent.push(mail); data = null; w('250 queued'); continue;
        }
        const i = buf.indexOf('\r\n');
        if (i < 0) return;
        const l = buf.slice(0, i); buf = buf.slice(i + 2);
        log.push(l);
        if (/^EHLO/i.test(l)) { w('250-fake'); if (starttls) w('250-STARTTLS'); w('250 AUTH PLAIN LOGIN'); }
        else if (/^AUTH PLAIN /i.test(l)) { const [, u, pw] = Buffer.from(l.slice(11), 'base64').toString('utf8').split('\0'); w(u === user && pw === pass ? '235 ok' : '535 5.7.8 Username and Password not accepted'); }
        else if (/^MAIL FROM:<(.*)>/i.test(l)) { mail = { from: l.match(/<(.*)>/)[1], rcpt: [] }; w('250 ok'); }
        else if (/^RCPT TO:<(.*)>/i.test(l)) { mail.rcpt.push(l.match(/<(.*)>/)[1]); w('250 ok'); }
        else if (/^DATA/i.test(l)) { data = ''; w('354 go'); }
        else if (/^QUIT/i.test(l)) { w('221 bye'); sock.end(); }
        else w('502 no');
      }
    });
  });
  return new Promise(res => srv.listen(0, '127.0.0.1', () => res({ port: srv.address().port, sent, log, close: () => srv.close() })));
}

// connect hook: whatever host the account names, go to the fake server on that port
export const plainConnect = ({ port }) => net.connect({ host: '127.0.0.1', port });

export function sampleMail({ from = 'Boss <boss@example.com>', to = 'me@gmail.com', subject = 'Q4 報表', body = '請看附件。', attach = true, msgId = '<m1@example.com>' } = {}) {
  const subj = /^[\x20-\x7e]*$/.test(subject) ? subject : '=?UTF-8?B?' + Buffer.from(subject).toString('base64') + '?=';
  const head = [`From: ${from}`, `To: ${to}`, `Subject: ${subj}`, 'Date: Mon, 03 Nov 2026 10:00:00 +0800', `Message-ID: ${msgId}`, 'MIME-Version: 1.0'];
  if (!attach) return Buffer.from([...head, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: 8bit', '', body, ''].join('\r\n'), 'utf8');
  const b = 'BOUNDARY42';
  return Buffer.from([...head, `Content-Type: multipart/mixed; boundary="${b}"`, '', 'preamble', `--${b}`,
    'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', Buffer.from(body, 'utf8').toString('base64'),
    `--${b}`, 'Content-Type: application/pdf; name="=?UTF-8?B?' + Buffer.from('報表.pdf').toString('base64') + '?="',
    "Content-Disposition: attachment; filename*=UTF-8''%E5%A0%B1%E8%A1%A8.pdf", 'Content-Transfer-Encoding: base64', '', Buffer.from('%PDF-1.4 fake').toString('base64'),
    `--${b}--`, 'epilogue', ''].join('\r\n'), 'utf8');
}
