// Request routing.
import { chatRoutes } from './chat-routes.mjs';
import { codeRoutes } from './code-routes.mjs';
import { auth, bump, ensureSchema, newSession } from './db.mjs';
import { fileRoutes } from './files.mjs';
import { grokRoutes } from './grokcloud.mjs';
import { hookRoute } from './hooks.mjs';
import { mailRoutes } from './mail-routes.mjs';
import { manageRoutes } from './manage-routes.mjs';
import { memSrcBaseline, memoryRoutes } from './memory-edit.mjs';
import { alertRoutes, alertSweep } from './notify.mjs';
import { overviewRoutes } from './overview.mjs';
import { jobRoutes } from './progress.mjs';
import { rolesRoutes } from './roles.mjs';
import { runnerRoutes } from './runner-routes.mjs';
import { screenRoutes } from './screen-routes.mjs';
import { settingsRoutes } from './settings-routes.mjs';
import { flushAfter, skillRoutes } from './skills.mjs';
import { J, err } from './util.mjs';

// requests that don't change anything other devices need to see
const NO_BUMP = /^(pair|wait|notify\/|settings|screen\/|runner\/(next|blob|hello|bye|progress|live))/;

export async function onRequest(ctx) {
  const { request: req, env, params } = ctx;
  const path = (params.path || []).join('/');
  await ensureSchema(ctx.env.DB);
  try {
    await memSrcBaseline(ctx.env.DB); // 4.7: once — what was remembered before is marked 「來源不明（舊資料）」
  } catch {}
  const res = await route(ctx);
  // 4.7 異常主動推播: a job that just ended logged out / with a broken API / without its data is pushed at once
  if (path === 'runner/done' && req.method === 'POST' && res.status < 300)
    try {
      await alertSweep(env, env.DB, res._u || 'local');
    } catch {}
  if (path === 'runner/done') flushAfter(); // 4.12: a bot's 🧩找技能／🧰安裝, now that its reply is saved
  if (req.method !== 'GET' && res.status < 300 && res._u && !NO_BUMP.test(path)) {
    try {
      await bump(env.DB, res._u);
    } catch {}
  }
  return res;
}

// handlers in the order the old single router checked them; each returns a Response or nothing
// mailRoutes before runnerRoutes: a bot's call to a mailbox (4.7) is answered there
// skillRoutes before runnerRoutes: runner/skill and runner/genkeys (4.12) are answered there
const HANDLERS = [fileRoutes, mailRoutes, skillRoutes, runnerRoutes, screenRoutes, chatRoutes, jobRoutes, manageRoutes, codeRoutes, settingsRoutes, overviewRoutes, memoryRoutes, alertRoutes, rolesRoutes, grokRoutes];

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
    // hook: the public base of the 交接網址 (https://octa.yzprojecttw.com → /api/hook/<token>)
    if (path === 'config' && m === 'GET') return J({ local: !!env.isLocal, pair: !!env.pairCheck, hook: env.hookBase || '' });
    if (path === 'pair' && m === 'POST') {
      // a phone reaching this computer through the tunnel pairs with the code shown on the computer
      if (!env.pairCheck) return err('這個版本不使用配對碼', 404);
      if (!env.pairCheck(String(body.code || ''))) return err('配對碼錯誤或已失效', 401);
      // the name in 設定 → 手機遠端 (paired phones): what kind of device, from its browser
      const ua = req.headers.get('user-agent') || '';
      const label = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? (/Mobile/.test(ua) ? 'Android 手機' : 'Android 平板') : /Macintosh|Windows|Linux|CrOS/.test(ua) ? '電腦的瀏覽器' : '手機';
      return J({ token: await newSession(db, 'local', 'web', label, ua.slice(0, 300)) });
    }
    // 交接網址 / external events: LINE webhook, Zapier, a form, another AI (the key itself is the secret; hooks.mjs)
    if (path === 'hook' || path.startsWith('hook/')) return await hookRoute({ req, env, db, path, m, url, body, rawBody });

    // this computer (desktop window, built-in runner) is trusted; a phone must have paired
    const me = env.isLocal ? { user_id: 'local', kind: 'local', name: '本機', label: 'local' } : await auth(req, db);
    if (!me) return err('請先登入', 401);
    const U = me.user_id;
    const ok = (data = { ok: true }) => {
      const r = J(data);
      r._u = U;
      return r;
    }; // a change other devices should see

    // 4.4: what this phone's /go page needs to find the computer again after a restart (site/go-core.js)
    if (path === 'phone/go' && m === 'GET') {
      const g = me.kind === 'web' && env.phoneGo ? await env.phoneGo() : null;
      return g ? J(g) : err('只有配對的手機需要', 404);
    }
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
