// Telegram / LINE notifications.

export async function sendNotify(env, st, text, photo = null) {
  const out = [];
  if (st.tg?.token && st.tg?.chat && photo) {
    // base64 JPEG of the failed job's screen; the text goes as its caption
    let r = null;
    try {
      const fd = new FormData();
      fd.append('chat_id', st.tg.chat);
      fd.append('caption', text.slice(0, 1000));
      fd.append(
        'photo',
        new Blob([Uint8Array.from(atob(photo), c => c.charCodeAt(0))], { type: 'image/jpeg' }),
        'screenshot.jpg'
      );
      r = await fetch(`https://api.telegram.org/bot${st.tg.token}/sendPhoto`, { method: 'POST', body: fd }).catch(() => null);
    } catch {}
    if (r?.ok && text.length <= 1000) {
      out.push('Telegram');
      photo = 'sent';
    }
  }
  if (st.tg?.token && st.tg?.chat && photo !== 'sent') {
    const r = await fetch(`https://api.telegram.org/bot${st.tg.token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: st.tg.chat, text: text.slice(0, 4000) })
    }).catch(() => null);
    out.push(r?.ok ? 'Telegram' : 'Telegram（失敗）');
  }
  if (st.line?.token && st.line?.to) {
    const r = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + st.line.token },
      body: JSON.stringify({ to: st.line.to, messages: [{ type: 'text', text: text.slice(0, 4900) }] })
    }).catch(() => null);
    out.push(r?.ok ? 'LINE' : 'LINE（失敗）');
  }
  return out;
}

export const needsYou = t => /✅待確認|需要使用者|^⚠/m.test(t);
