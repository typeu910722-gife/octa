// OCTA 4.0 is fully local. Users of the old cloud version (octa.yzprojecttw.com) get their data moved onto this
// computer once, the first time 4.0 starts: the frozen legacy cloud API still answers `host/export` for the
// computer's old runner key. No Electron or sql.js here, so it can be tested with plain Node.

export const LEGACY_CLOUD = (process.env.OCTA_CLOUD || 'https://octa.yzprojecttw.com').replace(/\/+$/, '');

// settings first (account name), then the tables; ids are kept so messages, files and jobs stay linked
export const MOVE_TABLES = ['settings', 'folders', 'bots', 'groups_', 'routines', 'messages', 'jobs', 'files', 'chunks', 'stats', 'code_repos', 'code_tasks'];
const LABEL = { settings: '設定', folders: '分區', bots: '機器人', groups_: '群組', routines: '例行任務', messages: '對話', jobs: '工作紀錄', files: '檔案', chunks: '檔案內容', stats: '成果看板', code_repos: '程式專案', code_tasks: '程式任務' };
export const tableLabel = t => LABEL[t] || t;

// call(path, body) for the old cloud: POST with the computer's runner key → the JSON answer (throws with .status)
export function cloudCaller(token, { cloud = LEGACY_CLOUD, fetch: f = fetch, timeoutMs = 60000 } = {}) {
  return async (path, body) => {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await f(cloud + '/api/' + path, { method: 'POST', signal: ctl.signal, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: JSON.stringify(body || {}) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        const e = new Error(r.status === 401 || r.status === 403 ? '雲端已不認得這台電腦（' + (d.error || r.status) + '）' : d.error || 'HTTP ' + r.status);
        e.status = r.status; throw e;
      }
      return d;
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('連線雲端逾時，請稍後重試');
      throw e;
    } finally { clearTimeout(t); }
  };
}

// db: D1-like (prepare/bind/all/first/run, batch). Writes every row with user_id → localUser.
// insert 'replace' for a fresh database; 'ignore' to add only what is new.
// → { counts: {table: rows}, lastMessage }
export async function importFromCloud({ call, db, localUser = 'local', tables = MOVE_TABLES, start = {}, insert = 'replace', verify = true, onProgress = () => { } }) {
  const counts = {};
  let lastMessage = start.messages || 0;
  for (let i = 0; i < tables.length; i++) {
    const t = tables[i];
    const cols = t === 'settings' ? [] : (await db.prepare(`PRAGMA table_info(${t})`).all()).results.map(r => r.name);
    let after = start[t] || 0, got = 0, expect = null;
    for (; ;) {
      const d = await call('host/export', { table: t, after });
      if (!d || !Array.isArray(d.rows)) throw new Error(`雲端沒有回傳「${tableLabel(t)}」`);
      if (expect === null) expect = +d.count || 0;
      if (t === 'settings') {
        const r = d.rows[0] || {};
        let st = {};
        try { st = JSON.parse(r.settings || '{}') || {}; } catch { }
        st.sched = 'pc';   // routines run on this computer's clock
        await db.prepare('UPDATE users SET settings=?, engines=COALESCE(?, engines) WHERE id=?').bind(JSON.stringify(st), r.engines || null, localUser).run();
        if (r.name) await db.prepare('UPDATE users SET name=? WHERE id=?').bind(String(r.name).slice(0, 32), localUser).run();
      } else if (d.rows.length) {
        const stmts = d.rows.map(row => {
          const keys = Object.keys(row).filter(k => cols.includes(k));
          const vals = keys.map(k => (k === 'user_id' ? localUser : row[k]));
          return db.prepare(`INSERT OR ${insert === 'ignore' ? 'IGNORE' : 'REPLACE'} INTO ${t} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).bind(...vals);
        });
        await db.batch(stmts);
        if (t === 'messages') lastMessage = Math.max(lastMessage, ...d.rows.map(r => +r.id || 0));
      }
      got += d.rows.length;
      onProgress({ table: t, label: tableLabel(t), index: i, total: tables.length, got, expect });
      if (d.next == null) break;
      if (+d.next <= after) throw new Error('雲端分頁游標不正確');
      after = +d.next;
    }
    if (verify && t !== 'settings') {
      const n = (await db.prepare(t === 'chunks' ? 'SELECT COUNT(*) AS n FROM chunks' : `SELECT COUNT(*) AS n FROM ${t} WHERE user_id=?`).bind(...(t === 'chunks' ? [] : [localUser])).first())?.n ?? 0;
      if (n !== got || got < expect) throw new Error(`「${tableLabel(t)}」只搬到 ${n} / ${Math.max(expect, got)} 筆，請重試`);
    }
    counts[t] = got;
  }
  if (tables.includes('jobs'))   // whatever the cloud was running did not finish here
    await db.prepare("UPDATE jobs SET status='error', err_kind='timeout', err_msg='搬到這台電腦時中止' WHERE user_id=? AND status='running'").bind(localUser).run();
  return { counts, lastMessage };
}

// desktop.json from 3.x → 4.0: always local. Returns { cfg, pending } where pending is the old cloud runner key
// still to import from (kept in cfg.cloudImport until the import succeeds, so it can be retried from settings).
const LEGACY_KEYS = ['runnerToken', 'runnerUser', 'hostKey', 'hostUser', 'hostMoved'];
export function migrateConfig(cfg = {}) {
  const next = { ...cfg };
  let ci = next.cloudImport || null;
  if (cfg.mode === 'cloud' && cfg.runnerToken && !ci) ci = { token: cfg.runnerToken, state: 'pending', at: 0 };
  for (const k of LEGACY_KEYS) delete next[k];
  next.mode = 'local';
  if (ci) next.cloudImport = ci; else delete next.cloudImport;
  return { cfg: next, pending: ci && ci.state !== 'done' && ci.token ? ci.token : '' };
}
// what the page may see (never the key itself)
export const importStatus = (ci, running = false) => ci
  ? { state: running ? 'running' : ci.state, at: ci.at || 0, error: ci.error || '', counts: ci.counts || null, backup: ci.backup || '' }
  : { state: running ? 'running' : 'none' };
