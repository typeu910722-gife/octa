// 4.7「它記得什麼」: everything a bot keeps (📌 rules, 📇 facts, 📘 manuals, 🧩 skills, 一律允許) and what all bots share
// (共用資料, 分區資料, 🗺️ site notes) — listed, searched, edited, deleted and added in one place.
// The data stays exactly where the runner reads it (users.settings: memory / facts / manuals / skills / allow / sites,
// folders.notes); this module only adds where each item came from (mem_src) so the page can say who set it and when.
import { bump, getSettings, putSettings } from './db.mjs';
import { MANUAL_MAX } from './memory.mjs';
import { J, clean, err, now } from './util.mjs';
import { skillsView } from './skills.mjs';

// kind → [settings key, item cap, item length]
export const MEM_KINDS = {
  rule: ['memory', 40, 300],
  fact: ['facts', 60, 300],
  manual: ['manuals', MANUAL_MAX, 1500],
  skill: ['skills', 20, 3000],
  allow: ['allow', 20, 120],
  site: ['sites', 12, 300]
};
// who set an item: the person here or in 任務設定 (user), the bot itself from a conversation (bot), another AI through
// a 交接網址 (hook), a correction the person approved (fix), the weekly self-review the person approved (review),
// a role template (tpl); old: it was there before 4.7 started keeping this
// 4.12 learned skills (kind lskill): github (you approved), trusted (a repo you trust, no programs), catalog (OCTA's own)
export const SOURCES = ['user', 'bot', 'hook', 'fix', 'review', 'tpl', 'old', 'github', 'trusted', 'catalog'];
const KEY_MAX = 300;
const keyOf = (kind, item) => clean(kind === 'manual' || kind === 'skill' ? item?.name : item, KEY_MAX);

const ready = new WeakSet();
// the table is created here (once per database), so an older database needs no separate migration
export async function ensureMemSrc(db) {
  if (ready.has(db)) return;
  await db
    .prepare(
      'CREATE TABLE IF NOT EXISTS mem_src (user_id TEXT NOT NULL, kind TEXT NOT NULL, owner TEXT NOT NULL, k TEXT NOT NULL, by_ TEXT NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (user_id, kind, owner, k))'
    )
    .run();
  ready.add(db);
}
// every item kept in the settings, as [kind, owner, key]
function allItems(st) {
  const out = [];
  for (const [kind, [key]] of Object.entries(MEM_KINDS))
    for (const [owner, list] of Object.entries(st[key] || {}))
      for (const it of Array.isArray(list) ? list : []) {
        const k = keyOf(kind, it);
        if (k) out.push([kind, owner, k]);
      }
  return out;
}
// The first time 4.7 runs: everything already saved is marked 「來源不明（舊資料）」. After that, an item with no
// record was written by something that doesn't record (the bot's own 📌記住 / 🧩 / 🗺️ in runner/done) → 'bot'.
const based = new WeakSet();
export async function memSrcBaseline(db) {
  if (based.has(db)) return;
  await ensureMemSrc(db);
  const users = (await db.prepare('SELECT id, settings FROM users').all()).results;
  for (const u of users) {
    const has = await db.prepare("SELECT 1 AS n FROM mem_src WHERE user_id=? AND kind='_base' LIMIT 1").bind(u.id).first();
    if (has) continue;
    let st = {};
    try {
      st = JSON.parse(u.settings || '{}');
    } catch {}
    const t = now();
    const rows = allItems(st).map(([kind, owner, k]) =>
      db.prepare('INSERT OR IGNORE INTO mem_src (user_id,kind,owner,k,by_,ts) VALUES (?,?,?,?,?,?)').bind(u.id, kind, owner, k, 'old', 0)
    );
    rows.push(db.prepare("INSERT OR IGNORE INTO mem_src (user_id,kind,owner,k,by_,ts) VALUES (?,'_base','','',?,?)").bind(u.id, 'old', t));
    for (let i = 0; i < rows.length; i += 200) await db.batch(rows.slice(i, i + 200));
  }
  based.add(db);
}
// record who set these items (kept only for the newest write of the same text)
export async function noteSrc(db, U, kind, owner, items, by) {
  if (!SOURCES.includes(by) || !MEM_KINDS[kind]) return;
  try {
    await ensureMemSrc(db);
    const keys = [...new Set((items || []).map(it => keyOf(kind, it)).filter(Boolean))];
    if (!keys.length) return;
    await db.batch(
      keys.map(k =>
        db
          .prepare(
            'INSERT INTO mem_src (user_id,kind,owner,k,by_,ts) VALUES (?,?,?,?,?,?) ON CONFLICT(user_id,kind,owner,k) DO UPDATE SET by_=excluded.by_, ts=excluded.ts'
          )
          .bind(U, kind, clean(owner, 200), k, by, now())
      )
    );
  } catch {}
}
// 任務設定 saves a whole list: the items that weren't in it before were added by the person
export async function noteListChange(db, U, kind, owner, before, after, by = 'user') {
  const had = new Set((before || []).map(it => keyOf(kind, it)));
  const fresh = (after || []).filter(it => !had.has(keyOf(kind, it)));
  if (fresh.length) await noteSrc(db, U, kind, owner, fresh, by);
}
async function srcMap(db, U, owners) {
  await ensureMemSrc(db);
  const m = new Map();
  if (!owners.length) return m;
  const rows = (
    await db
      .prepare(`SELECT kind, owner, k, by_, ts FROM mem_src WHERE user_id=? AND owner IN (${owners.map(() => '?').join(',')})`)
      .bind(U, ...owners)
      .all()
  ).results;
  for (const r of rows) m.set(r.kind + '\u0000' + r.owner + '\u0000' + r.k, { by: r.by_, ts: r.ts || null });
  return m;
}
const srcOf = (m, kind, owner, k) => m.get(kind + '\u0000' + owner + '\u0000' + k) || { by: 'bot', ts: null };

// what the page shows for one bot: every kind, each item with where it came from
export async function botMemory(db, U, botId) {
  const st = await getSettings(db, U);
  const src = await srcMap(db, U, [botId]);
  const out = {};
  for (const kind of ['rule', 'fact', 'manual', 'skill', 'allow']) {
    const list = (st[MEM_KINDS[kind][0]] || {})[botId] || [];
    out[kind] = list.map(it => {
      const s = srcOf(src, kind, botId, keyOf(kind, it));
      return kind === 'manual' || kind === 'skill'
        ? { name: it.name, steps: it.steps, used: +it.used || 0, by: s.by, ts: s.ts }
        : { text: String(it), by: s.by, ts: s.ts };
    });
  }
  return out;
}
export async function sharedMemory(db, U) {
  const st = await getSettings(db, U);
  const domains = Object.keys(st.sites || {});
  const src = await srcMap(db, U, domains);
  return {
    notes: st.notes || '',
    sites: domains.map(d => ({
      domain: d,
      items: (st.sites[d] || []).map(t => {
        const s = srcOf(src, 'site', d, keyOf('site', t));
        return { text: String(t), by: s.by, ts: s.ts };
      })
    }))
  };
}

// one change: op add | edit | del. Items are found by their text (rule, fact, allow, site) or name (manual, skill).
export function applyEdit(list, kind, op, b) {
  const [, cap, max] = MEM_KINDS[kind];
  const named = kind === 'manual' || kind === 'skill';
  const make = () =>
    named ? { name: clean(String(b.name ?? '').replace(/[\r\n｜|]+/g, ' '), 40), steps: clean(b.steps, max) } : clean(String(b.text ?? '').replace(/\s+/g, ' '), max);
  const valid = v => (named ? v.name && v.steps : !!v);
  const cur = [...(list || [])];
  const at = b.old == null ? -1 : cur.findIndex(x => keyOf(kind, x) === clean(b.old, KEY_MAX));
  if (op === 'del') {
    if (at < 0) return { error: '找不到這一項，可能已經被改過了' };
    cur.splice(at, 1);
    return { list: cur, item: null };
  }
  const v = make();
  if (!valid(v)) return { error: named ? '名稱和步驟都要填' : '內容要填' };
  const dup = cur.findIndex(x => keyOf(kind, x) === keyOf(kind, v));
  if (op === 'add') {
    if (dup >= 0) return { error: '已經有一樣的了' };
    const item = kind === 'manual' ? { ...v, ts: now(), used: 0 } : v;
    cur.push(item);
    return { list: cur.slice(-cap), item };
  }
  if (op === 'edit') {
    if (at < 0) return { error: '找不到這一項，可能已經被改過了' };
    if (dup >= 0 && dup !== at) return { error: '已經有一樣的了' };
    const item = kind === 'manual' ? { ...v, ts: now(), used: +cur[at].used || 0 } : v;
    cur[at] = item;
    return { list: cur, item };
  }
  return { error: '不認得這個動作' };
}

export async function memoryRoutes(c) {
  const { db, path, m, url, body, U } = c;
  if (!path.startsWith('memview')) return null;
  const st0 = () => getSettings(db, U);
  if (path === 'memview' && m === 'GET') {
    const id = clean(url.searchParams.get('id'), 64);
    if (id === 'shared') {
      const folders = (await db.prepare('SELECT id,name,notes FROM folders WHERE user_id=? ORDER BY created').bind(U).all()).results;
      return J({ shared: await sharedMemory(db, U), folders: folders.map(f => ({ id: f.id, name: f.name, notes: f.notes || '' })) });
    }
    const b = await db.prepare('SELECT id,name,task,folder,engine FROM bots WHERE id=? AND user_id=?').bind(id, U).first();
    if (!b) return err('找不到這個機器人', 404);
    const f = b.folder ? await db.prepare('SELECT id,name FROM folders WHERE id=? AND user_id=?').bind(b.folder, U).first() : null;
    const items = await botMemory(db, U, b.id);
    // 4.12: skills learned from GitHub or the catalog — source, version, and how they reach this bot's AI
    const src = await srcMap(db, U, [b.id]);
    items.lskill = (await skillsView(db, U, b.id, b.engine || 'claude')).map(x => ({ ...x, by: src.get('lskill\u0000' + b.id + '\u0000' + x.name)?.by || (x.src === 'catalog' ? 'catalog' : x.by === 'trusted' ? 'trusted' : 'github') }));
    const all = (await db.prepare('SELECT id,name,engine FROM bots WHERE user_id=?').bind(U).all()).results;
    return J({ bot: { id: b.id, name: b.name, task: b.task || '', engine: b.engine || 'claude' }, folder: f, items, bots: all.map(x => ({ id: x.id, name: x.name, engine: x.engine || 'claude' })) });
  }
  if (path === 'memview/item' && m === 'POST') {
    const kind = String(body.kind || '');
    if (!MEM_KINDS[kind]) return err('不認得這種記憶');
    const op = String(body.op || '');
    const st = await st0();
    const key = MEM_KINDS[kind][0];
    let owner;
    if (kind === 'site') {
      owner = clean(String(body.domain || '').toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''), 60);
      if (!owner) return err('網站要填');
    } else {
      owner = clean(body.bot, 64);
      if (!(await db.prepare('SELECT 1 AS n FROM bots WHERE id=? AND user_id=?').bind(owner, U).first())) return err('找不到這個機器人', 404);
    }
    st[key] = st[key] || {};
    const r = applyEdit(st[key][owner], kind, op, body);
    if (r.error) return err(r.error);
    if (r.list.length) st[key][owner] = r.list;
    else delete st[key][owner];
    await putSettings(db, U, st);
    if (r.item) await noteSrc(db, U, kind, owner, [r.item], 'user');
    await bump(db, U);
    return J({ ok: true });
  }
  if (path === 'memview/notes' && m === 'PUT') {
    // 共用資料 (every bot) or one 分區's 資料
    if (body.folder) {
      const r = await db
        .prepare('UPDATE folders SET notes=? WHERE id=? AND user_id=?')
        .bind(clean(body.notes, 20000), clean(body.folder, 64), U)
        .run();
      if (!r.meta?.changes) return err('找不到這個分區', 404);
    } else {
      const st = await st0();
      st.notes = clean(body.notes, 20000);
      await putSettings(db, U, st);
    }
    await bump(db, U);
    return J({ ok: true });
  }
  return null;
}
