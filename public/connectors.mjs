// Services the account has connected. Secrets stay in settings. The model only sees names and results.

const RESERVED = new Set(['Telegram', 'LINE']);

export function checkBase(raw) {
  let u;
  try { u = new URL(String(raw || '')); } catch { return '網址要寫完整的 https 位址'; }
  if (u.protocol !== 'https:') return '只接受 https';
  if (u.username || u.password) return '網址裡不能帶帳號密碼';
  if (privateHost(u.hostname)) return '這個位址不能接';
  return '';
}

function privateHost(host) {
  const h = String(host || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h === '::1' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const n = m.slice(1).map(Number);
  if (n.some(x => x > 255)) return true;
  const [a, b] = n;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

export function joinBase(base, path) {
  const u = new URL(base);
  const extra = String(path || '/');
  const rel = extra.startsWith('/') ? extra : '/' + extra;
  const q = rel.indexOf('?');
  const pathname = q >= 0 ? rel.slice(0, q) : rel;
  const prefix = u.pathname.replace(/\/$/, '');
  u.pathname = (prefix + pathname).replace(/\/{2,}/g, '/') || '/';
  u.search = q >= 0 ? rel.slice(q) : '';
  u.hash = '';
  return u;
}

// What the model and the other devices are allowed to see. No secrets.
export function publicConnectors(st) {
  const out = [];
  if (st?.tg?.token && st?.tg?.chat) out.push({ name: 'Telegram', kind: 'telegram', can: ['送出'] });
  if (st?.line?.token && st?.line?.to) out.push({ name: 'LINE', kind: 'line', can: ['送出'] });
  for (const c of st?.connectors || []) {
    if (c?.name && c.base && c.secret) out.push({ name: c.name, kind: 'http', can: ['讀取', '送出'] });
  }
  return out;
}

export function connectorLines(list) {
  const lines = ['連接器：有接上的服務走這裡。金鑰留在帳號裡，不會出現在對話裡。'];
  if (!list?.length) {
    lines.push('這個帳號還沒有接上任何連接器。Telegram、LINE 或自己的服務要先到設定的「連接器」接上。還沒接上時，公開網頁用 WebFetch，已登入的網頁用【派瀏覽】。');
    return lines;
  }
  for (const c of list) lines.push(`- ${c.name}：可以${c.can.join('、')}${c.kind === 'http' ? '。路徑寫相對路徑，例如 /orders' : '。不用寫路徑'}`);
  lines.push('能用連接器做的事不要開瀏覽器。需要時單獨寫下面這一段，不要同時寫【回覆】：\n【連接器】\n名稱：上面其中一個\n動作：讀取或送出\n路徑：/相對路徑（只有自己的服務要）\n內容：送出的文字\n【接完】');
  lines.push('讀取可以直接做。送出、寄信、付款、刪除要先寫 ✅待確認，使用者回「核准：」之後才寫送出。同意只涵蓋那一次。同一則最多呼叫兩次。');
  return lines;
}

// Mail, calendar, and documents go to a connected tool. The browser is the fallback.
export function toolForBrowse(task, connectors) {
  const text = `${task?.prompt || ''} ${task?.url || ''}`;
  const kind = /信|郵件|gmail|寄信|寄出|inbox/i.test(text) ? 'mail'
    : /行事曆|日曆|calendar/i.test(text) ? 'cal'
    : /文件|試算表|雲端硬碟|\bdocs\b|\bdrive\b|sheet/i.test(text) ? 'doc' : '';
  if (!kind) return null;
  return (connectors || []).find(c => {
    const n = String(c.name || '');
    if (kind === 'mail') return /信|mail|gmail/i.test(n);
    if (kind === 'cal') return /曆|calendar/i.test(n);
    return /文件|drive|sheet|表/i.test(n);
  }) || null;
}
export function takeConnectorTask(text) {
  const m = String(text || '').match(/【連接器】\s*([\s\S]*?)\s*【接完】/);
  if (!m) return null;
  const body = m[1];
  const name = ((body.match(/名稱[:：]\s*(.+)/) || [])[1] || '').trim().slice(0, 40);
  const act = ((body.match(/動作[:：]\s*(\S+)/) || [])[1] || '');
  const action = act.startsWith('送出') ? '送出' : act.startsWith('讀取') ? '讀取' : '';
  const path = ((body.match(/路徑[:：]\s*(\S+)/) || [])[1] || '').slice(0, 200);
  const content = ((body.match(/內容[:：]\s*([\s\S]*)$/) || [])[1] || '').trim().slice(0, 4000);
  if (!name || !action) return null;
  return { name, action, path, content };
}

export function stripConnectorTask(text) {
  return String(text || '').replace(/【連接器】[\s\S]*?【接完】/g, '').trim();
}

export function normalizeCustom(body, list) {
  const name = String(body?.name || '').trim().slice(0, 20);
  if (!/^[\p{L}\p{N}][\p{L}\p{N} _-]{0,19}$/u.test(name)) return { error: '名稱用 1 到 20 個字，不要用符號開頭' };
  if (RESERVED.has(name)) return { error: '這個名稱留給內建連接器' };
  if ((list || []).some(c => c.name === name)) return { error: '已經有這個名稱' };
  const why = checkBase(body?.base);
  if (why) return { error: why };
  const base = new URL(body.base);
  base.hash = ''; base.username = ''; base.password = '';
  const header = String(body?.header || 'Authorization').trim() || 'Authorization';
  if (!/^[A-Za-z][A-Za-z0-9-]{0,39}$/.test(header)) return { error: '標頭名稱不能用' };
  const secret = String(body?.secret || '');
  if (!secret || secret.length > 400) return { error: '要填金鑰' };
  if (/[\r\n]/.test(secret)) return { error: '金鑰不能換行' };
  return { item: { name, base: base.toString(), header, secret } };
}

function redact(text, secrets) {
  let t = String(text || '');
  for (const s of secrets) if (s && String(s).length >= 4) t = t.split(String(s)).join('（已隱藏）');
  return t.slice(0, 4000);
}

export async function runConnector(st, task, opt = {}) {
  const fetchImpl = opt.fetchImpl || globalThis.fetch;
  const known = publicConnectors(st).find(c => c.name === task?.name);
  if (!known) return { ok: false, text: `沒有接上「${task?.name || ''}」。` };
  if (task.action !== '讀取' && task.action !== '送出') return { ok: false, text: '動作只能是讀取或送出。' };
  if (!known.can.includes(task.action)) return { ok: false, text: `「${known.name}」不能${task.action}。` };
  if (task.action === '送出' && !opt.approved) return { ok: false, text: `「${known.name}」這次沒有送出。對別人送出要先取得這一次的同意。` };
  const secrets = [];
  try {
    if (known.kind === 'telegram') {
      secrets.push(st.tg.token);
      const r = await fetchImpl('https://api.telegram.org/bot' + st.tg.token + '/sendMessage', {
        method: 'POST', headers: { 'content-type': 'application/json' }, redirect: 'manual',
        body: JSON.stringify({ chat_id: st.tg.chat, text: String(task.content || '').slice(0, 3500) }),
        signal: AbortSignal.timeout(15000)
      });
      const data = await r.json().catch(() => ({}));
      if (r.status >= 300 && r.status < 400) return { ok: false, text: 'Telegram 轉址了，這次沒有跟著走。' };
      if (!data.ok) return { ok: false, text: redact('Telegram 沒有收下：' + (data.description || r.status), secrets) };
      return { ok: true, text: '已送到 Telegram。' };
    }
    if (known.kind === 'line') {
      secrets.push(st.line.token);
      const r = await fetchImpl('https://api.line.me/v2/bot/message/push', {
        method: 'POST', redirect: 'manual',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + st.line.token },
        body: JSON.stringify({ to: st.line.to, messages: [{ type: 'text', text: String(task.content || '').slice(0, 3500) }] }),
        signal: AbortSignal.timeout(15000)
      });
      if (r.status >= 300 && r.status < 400) return { ok: false, text: 'LINE 轉址了，這次沒有跟著走。' };
      if (!r.ok) return { ok: false, text: redact('LINE 沒有收下：' + (await r.text().catch(() => '')).slice(0, 300), secrets) };
      return { ok: true, text: '已送到 LINE。' };
    }
    const c = (st.connectors || []).find(x => x.name === task.name);
    const why = checkBase(c.base);
    if (why) return { ok: false, text: why };
    let path = task.path || '/';
    if (path.includes('..') || path.length > 200) return { ok: false, text: '路徑不能用。' };
    const url = joinBase(c.base, path);
    if (url.origin !== new URL(c.base).origin) return { ok: false, text: '路徑超出這個連接器。' };
    secrets.push(c.secret);
    const headers = { accept: 'application/json, text/plain;q=0.9', [c.header || 'Authorization']: c.secret };
    const init = { method: task.action === '送出' ? 'POST' : 'GET', headers, redirect: 'manual', signal: AbortSignal.timeout(15000) };
    if (task.action === '送出') {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify({ text: String(task.content || '').slice(0, 4000) });
    }
    const r = await fetchImpl(url, init);
    if (r.status >= 300 && r.status < 400) return { ok: false, text: '這個連接器轉址了，這次沒有跟著走。' };
    const bodyText = await r.text();
    return { ok: r.ok, text: redact(r.status + '\n' + bodyText, secrets) };
  } catch (e) {
    return { ok: false, text: redact('連接器沒有完成：' + (e?.message || '失敗'), secrets) };
  }
}
