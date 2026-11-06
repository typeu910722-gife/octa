// OCTA runner 4.12: learned skills on this computer. Each approved skill is kept once under <data>/skills/<name>@<commit>/
// (fetched from the local API the first time), then linked into the folder where the bot's AI loads skills —
// .claude/skills for Claude Code, .agents/skills for Codex and Antigravity — or, for other AI tools, its instructions
// go into the prompt when the task matches (prompts.mjs → lib/skills.mjs skillPromptLines).
// OCTA only touches the entries it put there (listed in .octa-skills.json); the bot's own skills stay as they are.
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { ENGINE_SKILLS, MANAGED_FILE, parseFrontMatter, skillWay } from '../lib/skills.mjs';
import { api } from './api-client.mjs';
import { WIN, cfg, log } from './state.mjs';

export const skillsRoot = () => join(cfg.home || '.', 'skills');
const safeId = id => String(id || '').replace(/[^\w.@-]/g, '_').slice(0, 100);
export const skillDir = s => join(skillsRoot(), safeId(s.id));
// a path inside the skill folder (never outside it)
function inside(root, rel) {
  if (!rel || isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) return null;
  const p = resolve(root, normalize(rel));
  return p.startsWith(resolve(root) + sep) ? p : null;
}
// the files of one skill version, from the local API, written once (a half-written folder never stays)
export async function ensureSkill(s, fetchFiles = id => api('runner/skill?id=' + encodeURIComponent(id), undefined, 'GET')) {
  const dir = skillDir(s);
  if (existsSync(join(dir, 'SKILL.md'))) return dir;
  const { files } = await fetchFiles(s.id);
  const tmp = dir + '.part';
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  for (const [rel, f] of Object.entries(files || {})) {
    const p = inside(tmp, rel);
    if (!p) continue;
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, f.t === 'b64' ? Buffer.from(String(f.d || ''), 'base64') : String(f.d ?? ''));
  }
  rmSync(dir, { recursive: true, force: true });
  renameSync(tmp, dir);
  return dir;
}
const readManaged = d => {
  try {
    return JSON.parse(readFileSync(join(d, MANAGED_FILE), 'utf8')).names || [];
  } catch {
    return [];
  }
};
const unlink = p => {
  try {
    rmSync(p, { recursive: true, force: true });
  } catch {}
};
// is this entry already the link (or copy) of that version?
function same(link, target) {
  try {
    const st = lstatSync(link);
    if (st.isSymbolicLink()) return resolve(dirname(link), readlinkSync(link)) === resolve(target);
    return existsSync(join(link, '.octa-version')) && readFileSync(join(link, '.octa-version'), 'utf8') === target;
  } catch {
    return false;
  }
}
// link a skill folder into a skills folder; Windows without symlink rights gets a junction, and if that fails a copy
export function linkSkill(target, link) {
  unlink(link);
  mkdirSync(dirname(link), { recursive: true });
  try {
    symlinkSync(target, link, WIN ? 'junction' : 'dir');
    return 'link';
  } catch {
    cpSync(target, link, { recursive: true });
    writeFileSync(join(link, '.octa-version'), target);
    return 'copy';
  }
}
// make the bot's work folder match its learned skills for the AI it runs on now (other AIs' folders are cleaned)
export async function syncSkills(job, dir, opts = {}) {
  const list = job.lskills || [];
  const engine = job.bot?.engine || 'claude';
  const way = skillWay(engine);
  const out = { way, ok: [], failed: [] };
  for (const s of list) {
    try {
      s.dir = await ensureSkill(s, opts.fetchFiles);
      out.ok.push(s.name);
    } catch (e) {
      out.failed.push(s.name);
      log(`🧩 技能「${s.name}」讀取失敗：${e.message}`);
    }
  }
  const want = way === 'native' ? ENGINE_SKILLS[engine].dir : null;
  for (const rel of new Set(Object.values(ENGINE_SKILLS).map(x => x.dir))) {
    const d = join(dir, ...rel.split('/'));
    const had = readManaged(d);
    const keep = rel === want ? list.filter(s => s.dir) : [];
    for (const n of had) if (!keep.some(s => s.name === n)) unlink(join(d, n));
    for (const s of keep) {
      const link = join(d, s.name);
      // the bot's own skill of the same name wins (it is not OCTA's to replace)
      if (existsSync(link) && !had.includes(s.name)) continue;
      if (!same(link, s.dir)) linkSkill(s.dir, link);
    }
    const names = keep.filter(s => existsSync(join(d, s.name))).map(s => s.name);
    if (names.length || had.length) {
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, MANAGED_FILE), JSON.stringify({ names, note: 'OCTA 管理的技能（設定 → 技能與工具）。其他資料夾是機器人自己的。' }, null, 2));
    }
  }
  return out;
}
// SKILL.md's instructions (for AIs that get them in the prompt)
export function readSkill(s) {
  try {
    return parseFrontMatter(readFileSync(join(s.dir || skillDir(s), 'SKILL.md'), 'utf8')).body;
  } catch {
    return '';
  }
}
// skill folders the bot's own skills sync (transfer.mjs) must leave out
export const managedNames = d => new Set(readManaged(d));
export const listSkillsRoot = () => {
  try {
    return readdirSync(skillsRoot());
  } catch {
    return [];
  }
};
