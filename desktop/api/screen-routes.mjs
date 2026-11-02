// 4.2 手機遙控: the live picture of a bot's browser and the phone's taps / scrolls / typing.
// The stream itself lives in the desktop server (env.screen, desktop/screen-cast.mjs); these routes check who may use it:
// a paired phone or this computer's own window may watch; only while the person has taken over (接手) may it touch the page.
import { J, clean, err } from './util.mjs';

const meta = (f, handed) => ({
  'x-octa-seq': String(f?.seq || 0),
  'x-octa-handed': handed ? '1' : '0',
  'x-octa-meta': encodeURIComponent(JSON.stringify(f?.meta || {})),
  'cache-control': 'no-store'
});
export async function screenRoutes(c) {
  const { env, db, path, m, url, body, U } = c;
  if (!path.startsWith('screen/')) return;
  const [, id, act] = path.split('/');
  const bot = clean(decodeURIComponent(id || ''), 64);
  const row = bot && (await db.prepare('SELECT id, browser FROM bots WHERE id=? AND user_id=?').bind(bot, U).first());
  if (!row) return err('找不到這個機器人', 404);
  if (!env.screen) return err('這台電腦不支援即時畫面', 404);
  const handedNow = async () => !!(await db.prepare('SELECT handed FROM live WHERE bot_id=? AND user_id=?').bind(bot, U).first())?.handed;
  if (!act && m === 'GET') {
    if (row.browser === 'mine') return J({ none: true, why: 'mine' });
    const after = +url.searchParams.get('after') || 0;
    const wait = Math.min(15000, Math.max(0, +url.searchParams.get('wait') || 8000));
    const f = await env.screen.frame(bot, { browser: row.browser || '', after, w: url.searchParams.get('w'), h: url.searchParams.get('h'), wait });
    const handed = await handedNow();
    if (!f) return J({ none: true, why: 'closed', handed });
    if (f.same) return new Response(null, { status: 204, headers: meta(f, handed) });
    return new Response(f.jpeg, { status: 200, headers: { 'content-type': 'image/jpeg', ...meta(f, handed) } });
  }
  if (act === 'bye' && m === 'POST') { env.screen.bye(bot); return J({ ok: true }); }
  if ((act === 'input' || act === 'nav') && m === 'POST') {
    // touching the page is only for the person who took over this bot's browser (the bot is paused meanwhile)
    if (!(await handedNow())) return err('先按「接手」才能操作', 403);
    const r = act === 'input' ? await env.screen.input(bot, body) : await env.screen.nav(bot, body);
    return r.error ? err(r.error, r.status || 400) : J(r);
  }
}
