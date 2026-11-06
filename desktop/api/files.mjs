// Files: stored pieces (chunks), copies, and the file routes.
import { bump, nap } from './db.mjs';
import { CHUNK, J, MAX_FILE, MIN, clean, err, now, uid } from './util.mjs';

// a second record of the same bytes, so the copy survives if the source conversation is deleted
export async function cloneFile(db, userId, fileId, conv) {
  const f = await db
    .prepare('SELECT id,name,mime,data,loc,path,size,pc FROM files WHERE id=? AND user_id=?')
    .bind(fileId, userId)
    .first();
  if (!f) return null;
  const id = 'file-' + uid();
  if (f.loc === 'pc' && f.path) {
    await db
      .prepare("INSERT INTO files (id,user_id,name,mime,data,ts,conv,loc,path,size,pc) VALUES (?,?,?,?,'',?,?,'pc',?,?,?)")
      .bind(id, userId, f.name, f.mime, now(), conv, f.path, f.size, f.pc)
      .run();
  } else if (f.data) {
    await db
      .prepare('INSERT INTO files (id,user_id,name,mime,data,ts,conv,loc,size) VALUES (?,?,?,?,?,?,?,?,?)')
      .bind(id, userId, f.name, f.mime, f.data, now(), conv, f.loc || 'db', f.size)
      .run();
  } else {
    const data = await readChunks(db, f.id);
    if (data) await storeChunks(db, id, data);
    await db
      .prepare("INSERT INTO files (id,user_id,name,mime,data,ts,conv,loc,size) VALUES (?,?,?,?,'',?,?,'cloud',?)")
      .bind(id, userId, f.name, f.mime, now(), conv, f.size || (data ? Math.round(data.length * 0.75) : null))
      .run();
  }
  return { id, name: f.name, mime: f.mime };
}

const MIMES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  mp4: 'video/mp4', // 4.12 產生影片: shown with a player
  webm: 'video/webm',
  mov: 'video/quicktime',
  pdf: 'application/pdf',
  txt: 'text/plain',
  csv: 'text/csv',
  md: 'text/markdown',
  json: 'application/json',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
};
export const mimeOf = (name, given) =>
  clean(given, 100) || MIMES[String(name).split('.').pop().toLowerCase()] || 'application/octet-stream';
export const safePath = p => {
  const v = clean(p, 400).replace(/\\/g, '/');
  return v && !v.split('/').includes('..') && !/^\/|^[a-z]:/i.test(v) ? v : null;
};

// ---------- files ----------
async function storeChunks(db, fileId, data) {
  const st = [];
  for (let i = 0, n = 0; i < data.length; i += CHUNK, n++)
    st.push(
      db
        .prepare('INSERT OR REPLACE INTO chunks (file_id,n,data,ts) VALUES (?,?,?,?)')
        .bind(fileId, n, data.slice(i, i + CHUNK), now())
    );
  for (let i = 0; i < st.length; i += 20) await db.batch(st.slice(i, i + 20));
}
async function readChunks(db, fileId) {
  return (await db.prepare('SELECT data FROM chunks WHERE file_id=? ORDER BY n').bind(fileId).all()).results
    .map(r => r.data)
    .join('');
}

export async function fileRoutes(c) {
  const { env, db, path, m, url, body, U, ok } = c;
  // ---------- files ----------
  if (path.startsWith('file/') && m === 'GET') {
    const id = path.slice(5);
    let f = await db
      .prepare('SELECT id,name,mime,data,loc,want,path,size,pc FROM files WHERE id=? AND user_id=?')
      .bind(id, U)
      .first();
    if (!f) return err('找不到檔案', 404);
    // where the file is: the desktop app reads it from its own disk instead of through the API
    if (url.searchParams.has('meta'))
      return J({
        name: f.name,
        mime: f.mime,
        loc: f.loc || (f.data ? 'db' : 'cloud'),
        path: f.loc === 'pc' ? f.path : null,
        size: f.size || null
      });
    if (f.data) return J({ name: f.name, mime: f.mime, data: f.data }); // older files kept in the database
    if (f.loc === 'pc' && f.want !== -1) {
      // the file is on this computer's disk: ask the runner for a temporary copy and wait
      if (!f.want || now() - f.want > MIN) {
        await db.prepare('UPDATE files SET want=? WHERE id=?').bind(now(), id).run();
        await bump(db, U);
      }
      const t0 = now();
      while (now() - t0 < 20000) {
        await nap(env, 1000);
        f = await db.prepare('SELECT want FROM files WHERE id=?').bind(id).first();
        if (f?.want === -1) break;
      }
      if (f?.want !== -1) return err('電腦還在讀取檔案，請稍後再試', 503);
      f = await db.prepare('SELECT name,mime FROM files WHERE id=?').bind(id).first();
    }
    return J({ name: f.name, mime: f.mime, data: await readChunks(db, id) });
  }
  if (path === 'files' && m === 'POST') {
    // upload: kept in the database only until the runner saves it to disk

    const data = String(body.data || ''),
      name = clean(body.name, 120).replace(/[\\/:*?"<>|]/g, '_') || '檔案';
    if (!data) return err('檔案是空的');
    if (data.length > MAX_FILE * 1.37) return err('檔案太大（上限 10MB）');
    const conv = clean(body.conv, 64) || null;
    const id = 'file-' + uid();
    await storeChunks(db, id, data);
    await db
      .prepare("INSERT INTO files (id,user_id,name,mime,data,ts,conv,loc,size) VALUES (?,?,?,?,'',?,?,'cloud',?)")
      .bind(id, U, name, mimeOf(name, body.mime), now(), conv, Math.round(data.length * 0.75))
      .run();
    return ok({ id, name, mime: mimeOf(name, body.mime) });
  }
}
