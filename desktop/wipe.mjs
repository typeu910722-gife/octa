// 4.5 清除這台電腦的 OCTA 資料: the file side of the wipe (no Electron here, so it can be tested with plain Node).
// - makeBackup: a dated folder in Documents with the database, desktop.json and (≤ 1 GB) the files folder
// - planWipe: which folders are emptied (the data folder, Electron's own folder, the files folder only when asked)
// - wipeTargets: empties them now (retrying files Windows still holds open)
// - writeMarker / finishPendingWipe: whatever could not be removed is removed at the very start of the next launch
//   (before Electron opens anything), and the next launch shows where the backup went.
import { existsSync, mkdirSync, readdirSync, lstatSync, statSync, copyFileSync, cpSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, parse, dirname } from 'node:path';
import os from 'node:os';

export const WIPE_MARKER = 'wipe-pending';
export const BACKUP_LIMIT = 1024 * 1024 * 1024;   // the files folder goes into the backup up to this size (same as 換主機)
// Chromium's single-instance lock (and the marker itself) stay; everything else in the folders goes
export const KEEP = new Set(['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'lockfile', WIPE_MARKER]);
// the word typed to confirm: any of these, whatever the interface language
export const CONFIRM_WORDS = ['刪除', '删除', 'DELETE', '削除'];
export const confirmWordFor = lang => ({ en: 'DELETE', ja: '削除', 'zh-CN': '删除' }[lang] || '刪除');
export function confirmOk(word) {
  const w = String(word ?? '').normalize('NFKC').trim().replace(/^[「『"']|[」』"']$/g, '').trim();
  return !!w && CONFIRM_WORDS.some(x => x.toLowerCase() === w.toLowerCase());
}

const WIN = process.platform === 'win32';
const norm = p => { const r = resolve(String(p)); return WIN ? r.toLowerCase() : r; };
// is child the same folder as parent, or inside it
export function isInside(child, parent) {
  if (!child || !parent) return false;
  const r = relative(norm(parent), norm(child));
  return r === '' || (!!r && !r.startsWith('..') && !isAbsolute(r));
}

// the size of a folder, stopping once it is over cap (a big Google Drive folder is not walked to the end)
export function dirSize(dir, cap = Infinity) {
  let bytes = 0, over = false;
  const walk = d => {
    let names = [];
    try { names = readdirSync(d); } catch { return; }
    for (const n of names) {
      if (over) return;
      const f = join(d, n);
      let s; try { s = lstatSync(f); } catch { continue; }
      if (s.isSymbolicLink()) continue;
      if (s.isDirectory()) walk(f);
      else { bytes += s.size; if (bytes > cap) over = true; }
    }
  };
  if (existsSync(dir)) walk(dir);
  return { bytes, over };
}

const pad = n => String(n).padStart(2, '0');
const BACKUP_WORD = { en: 'backup', ja: 'バックアップ', 'zh-CN': '备份' };
export function backupName(date = new Date(), lang = 'zh-TW') {
  const d = date;
  return `OCTA-${BACKUP_WORD[lang] || '備份'}-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

// never empty a drive, the home folder (or a folder above it) or one of the user's own standard folders
export function safeTarget(p, protect = []) {
  if (!p || !isAbsolute(String(p))) return false;
  const r = resolve(String(p));
  if (r === parse(r).root) return false;
  const home = os.homedir();
  if (isInside(home, r)) return false;   // the home folder itself, or something above it
  for (const x of protect) if (x && norm(x) === norm(r)) return false;
  return true;
}

// targets: [{path, whole}] — whole: the folder itself goes too (the files folder); otherwise only what is inside
export function planWipe({ dataDir, userData, store, deleteStore = false, protect = [] }) {
  const storeCustom = !!store && !isInside(store, dataDir) && !(userData && isInside(store, userData));
  const targets = [];
  const add = (path, whole) => { if (path && !targets.some(t => norm(t.path) === norm(path))) targets.push({ path: resolve(path), whole: !!whole }); };
  add(dataDir, false);
  if (userData) add(userData, false);
  if (storeCustom && deleteStore) add(store, true);
  for (const t of targets) if (!safeTarget(t.path, protect)) return { error: '這個資料夾不能清除：' + t.path, targets: [], storeCustom };
  return { targets, storeCustom, keepStore: storeCustom && !deleteStore ? resolve(store) : '' };
}

const README = {
  'zh-TW': p => `這是清除 OCTA 資料前的備份（${p.when}）。\n\n- ebot.sqlite：機器人、群組、對話、例行任務、記憶與設定\n- desktop.json：這台電腦的 OCTA 設定\n${p.files ? '- files：附件與機器人輸出的檔案\n' : `- 檔案資料夾超過 1 GB，沒有放進備份（位置：${p.store}）\n`}\n要還原：先結束 OCTA（右下角章魚圖示按右鍵 →「結束」），把 ebot.sqlite 和 desktop.json 複製回 OCTA 資料夾（${p.dataDir}），再打開 OCTA。\n`,
  'zh-CN': p => `这是清除 OCTA 数据前的备份（${p.when}）。\n\n- ebot.sqlite：机器人、群组、对话、例行任务、记忆与设置\n- desktop.json：这台电脑的 OCTA 设置\n${p.files ? '- files：附件与机器人输出的文件\n' : `- 文件夹超过 1 GB，没有放进备份（位置：${p.store}）\n`}\n要还原：先退出 OCTA，把 ebot.sqlite 和 desktop.json 复制回 OCTA 数据文件夹（${p.dataDir}），再打开 OCTA。\n`,
  en: p => `Backup made before OCTA's data was cleared (${p.when}).\n\n- ebot.sqlite: bots, groups, chats, routines, memory and settings\n- desktop.json: OCTA's settings on this computer\n${p.files ? '- files: attachments and the files the bots made\n' : `- The files folder is over 1 GB and was not copied (it is at ${p.store})\n`}\nTo restore: quit OCTA (right-click the octopus icon → Quit), copy ebot.sqlite and desktop.json back into the OCTA data folder (${p.dataDir}), then open OCTA.\n`,
  ja: p => `OCTA のデータを消去する前のバックアップです（${p.when}）。\n\n- ebot.sqlite：ボット、グループ、会話、定期タスク、メモリ、設定\n- desktop.json：このパソコンの OCTA 設定\n${p.files ? '- files：添付ファイルとボットが出力したファイル\n' : `- ファイルフォルダーが 1 GB を超えるためコピーしていません（場所：${p.store}）\n`}\n復元するには：OCTA を終了し、ebot.sqlite と desktop.json を OCTA のデータフォルダー（${p.dataDir}）に戻してから OCTA を開きます。\n`
};
const README_NAME = { en: 'README.txt', ja: 'お読みください.txt', 'zh-CN': '说明.txt' };

// root: where the backup folder goes (Documents). Returns {path, files, filesBytes, filesOver}.
export function makeBackup({ dataDir, store, root, lang = 'zh-TW', now = new Date(), limit = BACKUP_LIMIT }) {
  if (!root) throw new Error('找不到可以放備份的資料夾');
  mkdirSync(root, { recursive: true });
  let dest = join(root, backupName(now, lang));
  for (let i = 2; existsSync(dest); i++) dest = join(root, backupName(now, lang) + '-' + i);
  mkdirSync(dest, { recursive: true });
  for (const f of ['ebot.sqlite', 'desktop.json']) if (existsSync(join(dataDir, f))) copyFileSync(join(dataDir, f), join(dest, f));
  const size = store && existsSync(store) ? dirSize(store, limit) : { bytes: 0, over: false };
  const files = !!store && existsSync(store) && !size.over;
  if (files) cpSync(store, join(dest, 'files'), { recursive: true, dereference: false, errorOnExist: false });
  const text = (README[lang] || README['zh-TW'])({ when: now.toLocaleString(), files: files || !size.bytes, store, dataDir });
  writeFileSync(join(dest, README_NAME[lang] || '說明.txt'), '﻿' + text);
  // the copy must really have the database before anything is deleted
  if (existsSync(join(dataDir, 'ebot.sqlite')) && statSync(join(dest, 'ebot.sqlite')).size !== statSync(join(dataDir, 'ebot.sqlite')).size) throw new Error('備份的資料庫大小不對');
  return { path: dest, files, filesBytes: size.bytes, filesOver: size.over };
}

const entriesOf = t => {
  if (!existsSync(t.path)) return [];
  if (t.whole) return [t.path];
  try { return readdirSync(t.path).filter(n => !KEEP.has(n)).map(n => join(t.path, n)); } catch { return []; }
};
// empties the targets now; files still held open (Windows) are tried again a few times. → paths left over
export async function wipeTargets(targets, { tries = 5, delay = 400 } = {}) {
  let left = targets.flatMap(entriesOf);
  for (let i = 0; i < tries && left.length; i++) {
    if (i) await new Promise(r => setTimeout(r, delay));
    const next = [];
    for (const p of left) {
      try { await rm(p, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }); } catch { }
      if (existsSync(p)) next.push(p);
    }
    left = next;
  }
  return left;
}

export function writeMarker(dir, data) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, WIPE_MARKER), JSON.stringify(data, null, 2));
}
export function readMarker(dir) {
  try { return JSON.parse(readFileSync(join(dir, WIPE_MARKER), 'utf8')); } catch { return existsSync(join(dir, WIPE_MARKER)) ? {} : null; }
}
// The very start of the next launch (nothing is open yet): finish emptying the folders the marker names, then drop
// the marker. Only the folders written into the marker by the wipe are touched. → null (nothing pending) or
// {marker, left: [paths that still could not be removed]}
export function finishPendingWipe(dir, { tries = 4 } = {}) {
  const marker = readMarker(dir);
  if (!marker) return null;
  const targets = (Array.isArray(marker.targets) ? marker.targets : []).filter(t => t && typeof t.path === 'string' && safeTarget(t.path));
  let left = targets.flatMap(entriesOf);
  for (let i = 0; i < tries && left.length; i++) {
    if (i) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);   // the old copy of OCTA may still be closing
    left = left.filter(p => { try { rmSync(p, { recursive: true, force: true, maxRetries: 1, retryDelay: 100 }); } catch { } return existsSync(p); });
  }
  try { rmSync(join(dir, WIPE_MARKER), { force: true }); } catch { }
  // a legacy data folder (E·BOT) that is now empty goes too, so the next start uses the normal one
  for (const t of targets) if (!t.whole && norm(t.path) !== norm(dir)) { try { if (!readdirSync(t.path).length) rmSync(t.path, { recursive: true, force: true }); } catch { } }
  return { marker, left };
}

// the message shown once after the restart (the main process speaks the language the page used)
const DONE = {
  'zh-TW': { title: '已清除這台電腦的 OCTA 資料', ok: '好', open: '打開備份資料夾', backup: '清除前的備份在：', none: '這次沒有備份。', left: '有些檔案還在使用中，沒能刪除：' },
  'zh-CN': { title: '已清除这台电脑的 OCTA 数据', ok: '好', open: '打开备份文件夹', backup: '清除前的备份在：', none: '这次没有备份。', left: '有些文件还在使用中，没能删除：' },
  en: { title: 'OCTA’s data on this computer has been cleared', ok: 'OK', open: 'Open backup folder', backup: 'The backup made before clearing is in:', none: 'No backup was made.', left: 'Some files were still in use and could not be deleted:' },
  ja: { title: 'このパソコンの OCTA データを消去しました', ok: 'OK', open: 'バックアップフォルダーを開く', backup: '消去前のバックアップ：', none: '今回はバックアップしていません。', left: '使用中のため削除できなかったファイルがあります：' }
};
export function doneText(lang, backup, left = []) {
  const t = DONE[lang] || DONE['zh-TW'];
  const detail = (backup ? `${t.backup}\n${backup}` : t.none) + (left.length ? `\n\n${t.left}\n${left.slice(0, 5).join('\n')}` : '');
  return { title: 'OCTA', message: t.title, detail, buttons: backup ? [t.open, t.ok] : [t.ok] };
}

// where the backup goes: Documents, else Downloads, else the home folder
export function backupRootFrom(paths = {}) {
  for (const p of [paths.documents, paths.downloads, paths.home || os.homedir()]) {
    if (!p) continue;
    try { if (existsSync(p) || existsSync(dirname(p))) return p; } catch { }
  }
  return os.homedir();
}
