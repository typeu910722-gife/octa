// Request routing.
import { chatRoutes } from './chat-routes.mjs';
import { codeRoutes } from './code-routes.mjs';
import { auth, blocked, bump, ensureSchema, failed, newSession } from './db.mjs';
import { fileRoutes } from './files.mjs';
import { manageRoutes } from './manage-routes.mjs';
import { describeEvent, fireEvent } from './routines.mjs';
import { runnerRoutes } from './runner-routes.mjs';
import { screenRoutes } from './screen-routes.mjs';
import { settingsRoutes } from './settings-routes.mjs';
import { J, err } from './util.mjs';

// requests that don't change anything other devices need to see
const NO_BUMP = /^(pair|wait|notify\/|settings|screen\/|runner\/(next|blob|hello|bye|progress|live))/;

export async function onRequest(ctx) {
  const { request: req, env, params } = ctx;
  const path = (params.path || []).join('/');
  await ensureSchema(ctx.env.DB);
  const res = await route(ctx);
  if (req.method !== 'GET' && res.status < 300 && res._u && !NO_BUMP.test(path)) {
    try {
      await bump(env.DB, res._u);
    } catch {}
  }
  return res;
}

// handlers in the order the old single router checked them; each returns a Response or nothing
const HANDLERS = [fileRoutes, runnerRoutes, screenRoutes, chatRoutes, manageRoutes, codeRoutes, settingsRoutes];

async function route({ request: req, env, params }) {
  const db = env.DB;
  const path = (params.path || []).join('/');
  const m = req.method;
  const url = new URL(req.url);
  let body = {},
    rawBody = '';
  if (m !== 'GET') {
    rawBody = await req.text().catch(() => '');
    try {
      body = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      body = {};
    }
  }

  try {
    // ---------- public ----------
    if (path === 'config' && m === 'GET') return J({ local: !!env.isLocal, pair: !!env.pairCheck });
    if (path === 'pair' && m === 'POST') {
      // a phone reaching this computer through the tunnel pairs with the code shown on the computer
      if (!env.pairCheck) return err('這個版本不使用配對碼', 404);
      if (!env.pairCheck(String(body.code || ''))) return err('配對碼錯誤或已失效', 401);
      return J({ token: await newSession(db, 'local', 'web', 'phone') });
    }
    if (path.startsWith('hook/')) {
      // external event: LINE webhook, Zapier, a form… (the key itself is the secret)
      const key = path.slice(5);
      if (!/^[0-9a-f]{48}$/.test(key)) return err('找不到', 404);
      const r = await db.prepare('SELECT * FROM routines WHERE hook=?').bind(key).first();
      if (!r) return err('找不到', 404);
      if (m === 'GET') return J({ ok: true, routine: r.name }); // lets services check the address
      if (!r.enabled) return J({ ok: true, skipped: 'disabled' });
      const raw = rawBody || '';
      const what = describeEvent(raw, body);
      if (Array.isArray(body.events) && !body.events.length) return J({ ok: true }); // LINE "Verify" sends no events
      const lim = [['hook:' + key, 120]];
      if (await blocked(db, lim)) return J({ ok: false, error: 'too many events' }, 429);
      await failed(db, lim); // counts events per 15 minutes
      return J({ ok: true, result: await fireEvent(env, db, r, what || '（沒有內容）') });
    }

    // this computer (desktop window, built-in runner) is trusted; a phone must have paired
    const me = env.isLocal ? { user_id: 'local', kind: 'local', name: '本機', label: 'local' } : await auth(req, db);
    if (!me) return err('請先登入', 401);
    const U = me.user_id;
    const ok = (data = { ok: true }) => {
      const r = J(data);
      r._u = U;
      return r;
    }; // a change other devices should see

    const c = { req, env, db, path, m, url, body, rawBody, me, U, ok };
    for (const handle of HANDLERS) {
      const res = await handle(c);
      if (res) return res;
    }
    return err('找不到這個 API', 404);
  } catch (e) {
    return err('伺服器錯誤：' + (e.message || e), 500);
  }
}
