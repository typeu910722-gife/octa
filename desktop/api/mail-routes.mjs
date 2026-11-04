// 4.7 郵件連接器: saving and testing a mailbox (設定 → 進階 → 連接器), and a bot's mail calls.
// A bot's 【連接器】 call for a mailbox is answered here (before runner-routes), because mail needs more than the
// other connectors: the bot's own folder (attachments in and out) and the bot's 一律允許 list.
import { existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { runConnector } from '../lib/connectors.mjs';
import { isMail, normalizeMail, testMail } from '../lib/mail-connector.mjs';
import { getSettings, putSettings } from './db.mjs';
import { J, clean, err, uid } from './util.mjs';

// the bot's or group's folder in the file folder, named like the runner names it ("名稱_編號")
const safeName = s => String(s || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+/, '').trim().slice(0, 60) || '未命名';
const shortId = id => String(id).replace(/^g-/, '').replace(/[^\w]/g, '').slice(0, 8);
export function convFolder(root, conv) {
  const tag = '_' + shortId(conv.id), want = join(root, safeName(conv.name) + tag);
  mkdirSync(root, { recursive: true });
  if (!existsSync(want)) {
    const old = readdirSync(root).find(f => f.endsWith(tag));
    if (old) { try { renameSync(join(root, old), want); } catch { return join(root, old); } }
  }
  for (const sub of ['附件', '截圖', '輸出']) mkdirSync(join(want, sub), { recursive: true });
  return want;
}
// tests hand in a plain socket instead of TLS (env.mailConnect); a real computer never has it
const mailOpt = env => (env.mailConnect ? { mailConnect: env.mailConnect, mailInsecure: true } : {});

export async function mailRoutes(c) {
  const { env, db, path, m, body, U, ok } = c;
  if (path === 'runner/connector' && m === 'POST') {
    const st = await getSettings(db, U);
    const name = clean(body.name, 40);
    if (!(st.connectors || []).some(x => x.name === name && isMail(x))) return;   // not a mailbox: runner-routes answers
    const job = await db.prepare('SELECT id,prompt,bot_id,conv FROM jobs WHERE id=? AND user_id=?').bind(+body.job, U).first();
    if (!job) return err('找不到這次工作', 404);
    let dir = '', store = '';
    try {
      store = env.getStore ? env.getStore() : '';
      if (store) {
        const conv = (await db.prepare('SELECT id,name FROM bots WHERE id=? AND user_id=?').bind(job.conv, U).first())
          || (await db.prepare('SELECT id,name FROM groups_ WHERE id=? AND user_id=?').bind(job.conv, U).first());
        if (conv) dir = convFolder(store, conv);
      }
    } catch { dir = ''; }
    const task = { name, action: clean(body.action, 10), path: clean(body.path, 200), content: clean(body.content, 4000) };
    return J(await runConnector(st, task, {
      approved: /核准[:：]/.test(job.prompt || ''),
      allowed: (st.allow || {})[job.bot_id] || [],
      prompt: job.prompt || '', dir, store, ...mailOpt(env)
    }));
  }
  if (path === 'connectors/mail' && m === 'POST') {
    // add a mailbox, or change one (an empty or masked password keeps the saved one)
    const st = await getSettings(db, U);
    const list = st.connectors || [];
    const old = body.id ? list.find(x => x.id === body.id && x.kind === 'mail') : null;
    if (body.id && !old) return err('找不到這個連接器', 404);
    if (!old && list.length >= 8) return err('最多接 8 個連接器');
    const n = normalizeMail(body, list, old);
    if (n.error) return err(n.error);
    const id = old?.id || 'm-' + uid();
    st.connectors = old ? list.map(x => (x.id === id ? { ...n.item, id } : x)) : [...list, { ...n.item, id }];
    await putSettings(db, U, st);
    return ok({ id });
  }
  if (path === 'connectors/mail-test' && m === 'POST') {
    // 測試連線 before or after saving: what is typed now, with the saved password when the box still shows ••••
    const st = await getSettings(db, U);
    const list = st.connectors || [];
    const old = body.id ? list.find(x => x.id === body.id && x.kind === 'mail') : null;
    const n = normalizeMail({ ...body, name: old?.name || 'test' }, [], old);
    if (n.error) return J({ ok: false, text: n.error });
    return J(await testMail(n.item, { connect: env.mailConnect, insecure: !!env.mailConnect, timeoutMs: 20000 }));
  }
}
