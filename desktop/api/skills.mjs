// 4.12 技能與工具 (server side): skills learned from GitHub, the toolbox, and the keys for image / video generation.
//   - 🧩找技能：關鍵字 (a bot) or 設定 → 技能與工具 (the person): search GitHub for what suits that bot's AI, fetch the best
//     skill folder, review it in code (lib/skills.mjs), and post an approval card (✅待確認：安裝技能：名稱（#id）).
//     Nothing is installed until 核准 — except a skill without any program from a repo the person marked as trusted.
//   - 核准 → the files are kept here (table lskills, with source repo, commit, who approved, when) and every runner job of
//     an assigned bot gets the list; the runner puts them where that bot's AI loads skills (or into its prompt).
//   - 🧰安裝：名稱 → a catalog tool is installed right away by the runner (checksum-verified); anything else gets a card.
//   - Keys for OpenAI / Gemini / Replicate (st.connectors, kind 'gen', masked like other connector secrets) and the
//     two catalog skills that tell bots how to ask for pictures and videos.
import { GEN_PROVIDERS, GEN_SKILLS, genSkillMd } from '../lib/gen.mjs';
import {
  ENGINE_SKILLS, engineLabel, extensionAsSkill, githubClient, rankCandidates, reviewSkill, reviewText, safeSkillName, skillWay
} from '../lib/skills.mjs';
import { CATALOG, catalogItem, catalogView, mcpName, parseToolAsk, pickAsset, toolKey } from '../lib/toolbox.mjs';
import { addMsg, bump, getSettings, loadAll, mask, putSettings } from './db.mjs';
import { ensureMemSrc } from './memory-edit.mjs';
import { J, clean, err, now } from './util.mjs';

const ready = new WeakSet();
export async function ensureSkillTables(db) {
  if (ready.has(db)) return;
  await db.batch([
    db.prepare(
      'CREATE TABLE IF NOT EXISTS lskills (user_id TEXT NOT NULL, name TEXT NOT NULL, ver TEXT NOT NULL, src TEXT NOT NULL, repo TEXT, path TEXT, url TEXT, license TEXT, descr TEXT, files TEXT, review TEXT, bots TEXT, by_ TEXT, ts INTEGER, engine TEXT, PRIMARY KEY (user_id, name))'
    ),
    db.prepare(
      'CREATE TABLE IF NOT EXISTS skill_reqs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, kind TEXT NOT NULL, name TEXT, bots TEXT, data TEXT, status TEXT NOT NULL, conv TEXT, by_ TEXT, ts INTEGER, done_ts INTEGER)'
    ),
    db.prepare('CREATE TABLE IF NOT EXISTS gh_cache (k TEXT PRIMARY KEY, ts INTEGER NOT NULL, body TEXT)')
  ]);
  ready.add(db);
}
export const skillSet = st => ({
  token: String(st.skillset?.token || ''),
  selfFind: st.skillset?.selfFind !== false,
  trusted: Array.isArray(st.skillset?.trusted) ? st.skillset.trusted : []
});
const isTrusted = (ss, repo) => ss.trusted.some(t => String(t).toLowerCase() === String(repo || '').toLowerCase());
const cacheOf = db => ({
  async get(k, ttl) {
    const r = await db.prepare('SELECT ts, body FROM gh_cache WHERE k=?').bind(k).first();
    if (r && now() - r.ts < ttl) {
      try {
        return JSON.parse(r.body);
      } catch {}
    }
    return undefined;
  },
  async set(k, body) {
    const s = JSON.stringify(body);
    if (s.length > 500000) return;
    await db.prepare('INSERT OR REPLACE INTO gh_cache (k,ts,body) VALUES (?,?,?)').bind(k, now(), s).run();
  }
});
export const ghFor = (env, db, st) => githubClient({ token: skillSet(st).token, fetchImpl: env.fetch || globalThis.fetch, cache: cacheOf(db) });

// background work (a bot's 🧩找技能 after runner/done): tests wait for it with skillWork()
const work = new Set();
export function later(p) {
  const q = Promise.resolve(p).catch(() => {}).finally(() => work.delete(q));
  work.add(q);
  return q;
}
// runner/done queues its 🧩／🧰 work here; the router starts it after the reply is saved (so the card comes after it)
const queued = [];
export const afterDone = fn => queued.push(fn);
export const flushAfter = () => {
  while (queued.length) later(queued.shift()());
};
export const skillWork = async () => {
  while (work.size) await Promise.all([...work]);
};

const where = engine => (skillWay(engine) === 'native' ? `${engineLabel(engine)}，裝進 ${ENGINE_SKILLS[engine || 'claude'].dir}` : `${engineLabel(engine)}，工作時放進提示`);
async function botsOf(db, U, ids) {
  const { bots } = await loadAll(db, U);
  return ids === null ? bots : bots.filter(b => ids.includes(b.id));
}

// ---------- find → review → card (or install right away from a trusted repo with no programs) ----------
// opts: { query, bot (asking bot id), bots (who gets it), conv, engine?, from: 'bot'|'user', update? (name) }
export async function findSkill(env, db, U, opts) {
  await ensureSkillTables(db);
  const st = await getSettings(db, U),
    ss = skillSet(st);
  const { bots } = await loadAll(db, U);
  const asker = bots.find(b => b.id === opts.bot) || bots.find(b => (opts.bots || []).includes(b.id));
  if (!asker) return { error: '找不到要學技能的機器人' };
  const engine = opts.engine || asker.engine || 'claude';
  const conv = opts.conv || asker.id;
  const query = clean(opts.query, 80);
  if (!query && !opts.pin) return { error: '要說找什麼技能' };
  const gh = ghFor(env, db, st);
  let ranked = [];
  if (opts.pin) ranked = [{ ...opts.pin, kind: opts.pin.kind || 'skill' }];
  else {
    let found = await gh.search(query, engine);
    // a skills collection found by topic: look inside it for the keyword (one more search)
    const coll = found.filter(c => c.kind === 'repo').slice(0, 1);
    for (const r of coll) {
      try {
        const d = await gh.get(`/search/code?q=${encodeURIComponent(`${query} repo:${r.repo} filename:SKILL.md`)}&per_page=10`, { ttl: 6 * 3600_000 });
        for (const it of d.items || [])
          found.push({ repo: r.repo, path: it.path.split('/').slice(0, -1).join('/'), sha: (String(it.url).match(/[?&]ref=([0-9a-f]{40})/) || [])[1] || '', kind: 'skill', fit: r.fit, stars: r.stars, pushed: r.pushed, license: r.license });
      } catch (e) {
        if (e.limited) {
          if (!found.some(c => c.kind !== 'repo')) throw e;
          break;
        }
      }
    }
    found = found.filter(c => c.kind !== 'repo');
    if (!found.length) return { error: `GitHub 上沒有找到跟「${query}」有關的技能。換個英文關鍵字試試（例如 pdf、excel、slides）。`, none: true };
    // stars / last update / license of the repos that look best
    const metas = {};
    for (const name of [...new Set(found.map(c => c.repo))].slice(0, 6)) {
      try {
        metas[name] = await gh.repo(name);
      } catch (e) {
        if (e.limited) break;
      }
    }
    ranked = rankCandidates(found.map(c => ({ ...c, ...(metas[c.repo] || {}) })), { engine, trusted: ss.trusted, keyword: query });
  }
  let pick = null,
    files = null,
    lastErr = null;
  for (const c of ranked.slice(0, 3)) {
    try {
      const sha = /^[0-9a-f]{40}$/.test(c.sha || '') ? c.sha : await gh.latestSha(c.repo, c.path, c.branch);
      let f = await gh.fetchFolder({ repo: c.repo, path: c.path, sha });
      let mcp = [];
      if (c.kind === 'gemini-ext' || (!f['SKILL.md'] && f['gemini-extension.json'])) ({ files: f, mcp } = extensionAsSkill(f));
      if (!f['SKILL.md']) throw new Error('這個資料夾沒有 SKILL.md');
      pick = { ...c, sha, mcp };
      files = f;
      break;
    } catch (e) {
      lastErr = e;
      if (e.limited) break;
    }
  }
  if (!pick) return { error: '技能下載不下來：' + (lastErr?.message || '不明原因'), limited: !!lastErr?.limited };
  const rv = reviewSkill(files, pick);
  if (pick.mcp?.length) rv.flags.push({ k: 'mcp', label: '附帶 MCP 伺服器設定（不會一起裝；要用請另外核准安裝）', files: pick.mcp.slice(0, 4) });
  const url = `https://github.com/${pick.repo}/tree/${pick.sha}${pick.path ? '/' + pick.path : ''}`;
  const name = opts.update || rv.name;
  const assigned = opts.bots?.length ? opts.bots : [asker.id];
  // already the same version for these bots
  const have = await db.prepare('SELECT * FROM lskills WHERE user_id=? AND name=?').bind(U, name).first();
  if (have && have.ver === pick.sha && have.repo === pick.repo) {
    const hb = have.bots ? JSON.parse(have.bots) : null;
    if (hb === null || assigned.every(id => hb.includes(id))) return { same: true, name, text: `已經學會「${name}」了（${pick.repo}@${pick.sha.slice(0, 7)}），不用再裝。` };
  }
  const data = {
    cand: { repo: pick.repo, path: pick.path, sha: pick.sha, url, stars: pick.stars ?? null, license: pick.license || '', pushed: pick.pushed || null, kind: pick.kind, score: pick.score ?? null },
    review: rv,
    files,
    engine,
    query,
    update: opts.update || null,
    alts: ranked.slice(0, 5).filter(c => !(c.repo === pick.repo && c.path === pick.path)).map(c => ({ repo: c.repo, path: c.path, score: c.score }))
  };
  // a trusted repo and nothing that runs: no card (still shown in the work timeline and 它記得什麼)
  if (isTrusted(ss, pick.repo) && rv.noScripts && rv.level === 'low') {
    const out = await installSkill(db, U, { name, data, bots: assigned }, 'trusted');
    await bump(db, U);
    return { installed: out.name, text: `已學會「${out.name}」（信任的來源 ${pick.repo}、沒有程式，直接裝好）` };
  }
  const r = await db
    .prepare("INSERT INTO skill_reqs (user_id,kind,name,bots,data,status,conv,by_,ts) VALUES (?,'skill',?,?,?,'wait',?,?,?)")
    .bind(U, name, JSON.stringify(assigned), JSON.stringify(data), conv, asker.id, now())
    .run();
  const id = r.meta.last_row_id;
  const who = await botsOf(db, U, assigned);
  const always = rv.noScripts && rv.level === 'low';
  const lead = opts.update
    ? `「${name}」在 GitHub 有新版本，我看過新的內容了，你核准才會更新：`
    : `我在 GitHub 找到適合我（${engineLabel(engine)}）的技能「${name}」，已經先看過內容，你核准才會裝：`;
  const content = reviewText(rv, { ...data.cand, url });
  const text = [
    lead,
    `✅待確認：安裝技能：${name}（#${id}）`,
    `對象：${who.map(b => `${b.name}（${where(b.engine)}）`).join('、')}`,
    `內容：${content.split('\n').join('\n')}${data.alts.length ? `\n其他候選：${data.alts.slice(0, 3).map(a => a.repo + (a.path ? '/' + a.path : '')).join('、')}` : ''}`,
    `影響：${rv.level === 'high' ? '風險高：它的說明或程式有可疑的地方，建議拒絕' : rv.scripts.length ? '它之後做相關的工作會照這個技能做，也可能執行裡面的程式' : '它之後做相關的工作會照這個技能做（只有說明，沒有程式）'}`
  ].join('\n');
  await addMsg(db, U, conv, asker.id, text, null, null, null, { skillreq: { id, kind: 'skill', always, level: rv.level } });
  await bump(db, U);
  return { req: id, name, review: rv, text };
}

// store an approved skill (one version per name), and note where it came from for 它記得什麼
export async function installSkill(db, U, { name, data, bots }, by) {
  await ensureSkillTables(db);
  const c = data.cand || {};
  let nm = safeSkillName(name) || 'skill';
  const get = n => db.prepare('SELECT repo, bots FROM lskills WHERE user_id=? AND name=?').bind(U, n).first();
  let have = await get(nm);
  // the same name from another place: keep both (owner added)
  if (have && (have.repo || null) !== (c.repo || null) && !data.update) {
    nm = safeSkillName(nm + '-' + String(c.repo || 'x').split('/')[0]);
    have = await get(nm);
  }
  const prev = have ? botsCol(have.bots) : [];
  const merged = bots === null || prev === null ? null : [...new Set([...prev, ...bots])];
  await db
    .prepare(
      'INSERT OR REPLACE INTO lskills (user_id,name,ver,src,repo,path,url,license,descr,files,review,bots,by_,ts,engine) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
    )
    .bind(U, nm, c.sha || data.ver || 'v1', data.src || 'github', c.repo || null, c.path || null, c.url || null, clean(data.review?.license, 80), clean(data.review?.desc, 600),
      JSON.stringify(data.files || {}), JSON.stringify({ ...(data.review || {}), paths: (data.review?.paths || []).slice(0, 40) }), merged === null ? null : JSON.stringify(merged), by, now(), data.engine || null)
    .run();
  await ensureMemSrc(db);
  const all = merged === null ? (await loadAll(db, U)).bots.map(b => b.id) : merged;
  const src = data.src === 'catalog' ? 'catalog' : by === 'trusted' ? 'trusted' : 'github';
  for (const id of all)
    await db.prepare('INSERT OR REPLACE INTO mem_src (user_id,kind,owner,k,by_,ts) VALUES (?,?,?,?,?,?)').bind(U, 'lskill', id, nm, src, now()).run();
  const whence = data.src === 'catalog' ? 'OCTA 內建' : `來源 ${c.repo}@${String(c.sha || '').slice(0, 7)}`;
  const howOk = by === 'trusted' ? '信任的來源，自動' : by === 'catalog' ? '內建' : '你核准';
  for (const id of all.slice(0, 20)) await addMsg(db, U, id, 'sys', `🧩 學會技能「${nm}」（${whence}，${howOk}）`, null, null, 'note');
  return { name: nm };
}
export async function removeSkill(db, U, name) {
  await ensureSkillTables(db);
  const have = await db.prepare('SELECT bots FROM lskills WHERE user_id=? AND name=?').bind(U, name).first();
  if (!have) return false;
  await db.prepare('DELETE FROM lskills WHERE user_id=? AND name=?').bind(U, name).run();
  await ensureMemSrc(db);
  await db.prepare("DELETE FROM mem_src WHERE user_id=? AND kind='lskill' AND k=?").bind(U, name).run();
  return true;
}
const botsCol = v => (v ? JSON.parse(v) : null);
// what a runner job of this bot gets: the names and where to fetch the files (the files themselves on request)
export async function skillsForBot(db, U, botId) {
  await ensureSkillTables(db);
  const rows = (await db.prepare('SELECT name, ver, src, repo, descr, bots, url FROM lskills WHERE user_id=? ORDER BY name').bind(U).all()).results;
  return rows
    .filter(r => {
      const b = botsCol(r.bots);
      return b === null || b.includes(botId);
    })
    .map(r => ({ name: r.name, id: `${r.name}@${String(r.ver).slice(0, 12)}`, desc: r.descr || '', src: r.src, repo: r.repo || '', words: GEN_SKILLS[r.name]?.words || '' }));
}
// for 它記得什麼: a bot's learned skills with where they came from, and how each reaches its AI
export async function skillsView(db, U, botId, engine) {
  await ensureSkillTables(db);
  const rows = (await db.prepare('SELECT name, ver, src, repo, path, url, license, descr, bots, by_, ts, review FROM lskills WHERE user_id=? ORDER BY name').bind(U).all()).results;
  return rows
    .filter(r => botId == null || botsCol(r.bots) === null || botsCol(r.bots).includes(botId))
    .map(r => {
      let rv = {};
      try {
        rv = JSON.parse(r.review || '{}');
      } catch {}
      return {
        name: r.name, ver: String(r.ver).slice(0, 7), src: r.src, repo: r.repo, path: r.path, url: r.url, license: r.license, desc: r.descr, by: r.by_, ts: r.ts,
        bots: botsCol(r.bots), scripts: (rv.scripts || []).length, level: rv.level || 'low',
        ...(engine ? { way: skillWay(engine), where: where(engine) } : {})
      };
    });
}

// ---------- tools: catalog right away, anything else after approval ----------
const toolSt = st => st._tools || {}; // what the runner on this computer reports: { platform, gpu, installed: { key: {...} } }
const assignOf = (st, key) => (st.toolset?.assign && key in st.toolset.assign ? st.toolset.assign[key] : undefined);
export async function queueTool(db, U, spec) {
  const r = await db
    .prepare("INSERT INTO jobs (user_id,conv,bot_id,chain,prompt,created,kind,url) VALUES (?,'__test',?,'[]',?,?,'tool',?)")
    .bind(U, 'tool:' + spec.key, JSON.stringify(spec), now(), spec.key)
    .run();
  return r.meta.last_row_id;
}
// look up an off-catalog tool before asking: version, size, license, whether it runs install scripts
export async function toolInfo(env, ask, platform) {
  const f = env.fetch || globalThis.fetch;
  const getJ = async u => {
    const r = await f(u, { headers: { accept: 'application/json', 'user-agent': 'OCTA-desktop' }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(r.status === 404 ? '找不到這個套件' : '查詢失敗（' + r.status + '）');
    return r.json();
  };
  if (ask.type === 'npm' || ask.type === 'mcp') {
    const d = await getJ(`https://registry.npmjs.org/${ask.pkg.replace('/', '%2F')}`);
    const v = ask.version && d.versions?.[ask.version] ? ask.version : d['dist-tags']?.latest;
    const m = d.versions?.[v] || {};
    const sc = m.scripts || {};
    return {
      version: v, size: m.dist?.unpackedSize || 0, license: String(m.license || d.license || '未標示'), source: `https://www.npmjs.com/package/${ask.pkg}`,
      repo: String(m.repository?.url || '').replace(/^git\+/, ''), summary: clean(m.description || d.description, 200), integrity: m.dist?.integrity || '',
      scripts: ['preinstall', 'install', 'postinstall'].filter(k => sc[k]), bins: Object.keys(typeof m.bin === 'string' ? { [ask.pkg.split('/').pop()]: 1 } : m.bin || {})
    };
  }
  if (ask.type === 'pip') {
    const d = await getJ(`https://pypi.org/pypi/${encodeURIComponent(ask.pkg)}/${ask.version ? encodeURIComponent(ask.version) + '/' : ''}json`);
    const files = d.urls || [];
    return {
      version: d.info?.version, size: Math.max(0, ...files.map(x => +x.size || 0)), license: clean(d.info?.license_expression || d.info?.license || '未標示', 80),
      source: `https://pypi.org/project/${ask.pkg}/`, summary: clean(d.info?.summary, 200), scripts: files.some(x => x.packagetype === 'sdist') && !files.some(x => x.packagetype === 'bdist_wheel') ? ['setup.py'] : [], bins: []
    };
  }
  if (ask.type === 'github') {
    const d = await getJ(`https://api.github.com/repos/${ask.repo}/releases/${ask.tag ? 'tags/' + encodeURIComponent(ask.tag) : 'latest'}`);
    const a = ask.asset ? (d.assets || []).find(x => x.name === ask.asset) : pickAsset(d.assets, platform);
    if (!a) throw new Error('這個版本沒有適合這台電腦的檔案');
    return {
      version: d.tag_name, size: a.size, license: '看專案說明', source: d.html_url, summary: clean(d.name, 120), asset: a.name, url: a.browser_download_url,
      sha256: String(a.digest || '').replace(/^sha256:/, ''), scripts: [], bins: []
    };
  }
  return null;
}
const kb = n => (!n ? '未知' : n < 1048576 ? Math.round(n / 1024) + ' KB' : (n / 1048576).toFixed(1) + ' MB');
// a tool asked for by a bot (🧰安裝：…) or the person (settings): catalog → installed now; off-catalog → card
export async function askTool(env, db, U, { what, bot, conv, bots }) {
  await ensureSkillTables(db);
  const ask = parseToolAsk(what);
  if (!ask) return { error: `不認得「${clean(what, 60)}」。可以寫 ffmpeg、imagemagick、yt-dlp、uv、python，或 npm:套件、pip:套件、mcp:套件、github:擁有者/專案` };
  const st = await getSettings(db, U);
  const here = toolSt(st);
  const key = toolKey(ask);
  const { bots: all } = await loadAll(db, U);
  const asker = all.find(b => b.id === bot);
  if (ask.type === 'catalog') {
    const item = catalogItem(ask.id);
    if (item.later) return { error: `${item.label} 之後的版本才會開放（只在有 NVIDIA 顯示卡的電腦）。` };
    if (here.installed?.[key]?.ok) return { same: true, text: `${item.label} 已經裝好了。` };
    await queueTool(db, U, { key, type: 'catalog', id: item.id, conv: conv || asker?.id || null, bots: bots ?? null, by: asker?.id || 'me' });
    if (bots !== undefined) setAssign(st, key, bots);
    await putSettings(db, U, st);
    return { queued: key, text: `正在安裝 ${item.label}（OCTA 驗證過的官方檔案，不用核准）` };
  }
  if (!asker) return { error: '要指定是哪個機器人要用' };
  let info;
  try {
    info = await toolInfo(env, ask, here.platform);
  } catch (e) {
    return { error: `查不到 ${key}：${e.message}` };
  }
  const flags = [];
  if (info.scripts?.length) flags.push(`安裝時會執行它自己的程式（${info.scripts.join('、')}）`);
  if (ask.type === 'mcp') flags.push('會讓 AI 多一組工具（MCP 伺服器），能做什麼由這個套件決定');
  if (ask.type === 'github' && !info.sha256) flags.push('GitHub 沒有提供這個檔案的檢查碼，裝的時候只記錄下載到的檢查碼');
  if (ask.type === 'github') flags.push('是可以直接執行的程式');
  const data = { ask, info, key };
  const r = await db
    .prepare("INSERT INTO skill_reqs (user_id,kind,name,bots,data,status,conv,by_,ts) VALUES (?,'tool',?,?,?,'wait',?,?,?)")
    .bind(U, key, JSON.stringify(bots?.length ? bots : [asker.id]), JSON.stringify(data), conv || asker.id, asker.id, now())
    .run();
  const id = r.meta.last_row_id;
  const label = ask.type === 'mcp' ? `MCP 伺服器 ${ask.pkg}` : ask.type === 'github' ? `${ask.repo} 的 ${info.asset}` : `${ask.type} 套件 ${ask.pkg}`;
  const text = [
    `我需要 ${label} 才能做這件事。它不在 OCTA 驗證過的工具清單裡，你核准才會裝：`,
    `✅待確認：安裝工具：${key}（#${id}）`,
    `對象：${asker.name}（只裝在這台電腦的 OCTA 工具資料夾，不需要管理員權限）`,
    `內容：${info.summary || label}\n來源：${info.source}\n版本：${info.version || '最新'}，大小：${kb(info.size)}，授權：${info.license}${info.sha256 ? `\n檢查碼：${info.sha256.slice(0, 16)}…` : ''}${flags.length ? '\n' + flags.map(x => '注意：' + x).join('\n') : ''}`,
    `影響：會下載並安裝到這台電腦，機器人之後可以執行它`
  ].join('\n');
  await addMsg(db, U, conv || asker.id, asker.id, text, null, null, null, { skillreq: { id, kind: 'tool', always: false } });
  await bump(db, U);
  return { req: id, text };
}
function setAssign(st, key, bots) {
  st.toolset = st.toolset || {};
  st.toolset.assign = st.toolset.assign || {};
  st.toolset.assign[key] = bots === null ? null : [...new Set(bots)].slice(0, 200);
}
// what a bot's job gets: installed tools given to it ({id, what, bin}) and its MCP servers
export function toolsForBot(st, botId) {
  const inst = toolSt(st).installed || {};
  const out = [],
    mcp = [];
  for (const [key, t] of Object.entries(inst)) {
    if (!t?.ok) continue;
    const a = assignOf(st, key);
    if (a !== undefined && a !== null && !a.includes(botId)) continue;
    if (a === undefined && t.type && t.type !== 'catalog' && t.by && t.by !== botId && t.by !== 'me') continue; // off-catalog: only the bot that asked, until given to others
    if (t.type === 'mcp') mcp.push({ name: mcpName(t.pkg), command: 'npx', args: ['-y', `${t.pkg}@${t.version}`] });
    else {
      const item = catalogItem(key);
      out.push({ id: key, what: item?.what || t.summary || key, bin: (t.bins || item?.bins || [key]).slice(0, 3).join('／') });
    }
  }
  return { tools: out, mcp };
}

// ---------- 核准／拒絕 a card (sent as a chat message, like OCTA's other own cards) ----------
export async function skillApproval(env, db, U, conv, text) {
  const m = String(text || '')
    .replace(/^@\S+\s+/, '')
    .match(/^(核准|不要做|不用了)[:：]\s*安裝(技能|工具)[:：][^\n]*?（#(\d+)）/);
  if (!m) return false;
  await ensureSkillTables(db);
  const [, verb, , idS] = m;
  const req = await db.prepare('SELECT * FROM skill_reqs WHERE id=? AND user_id=?').bind(+idS, U).first();
  if (!req) return false;
  if (req.status !== 'wait') {
    await addMsg(db, U, conv, 'sys', '這張已經處理過了。');
    return true;
  }
  const yes = verb === '核准';
  await db.prepare('UPDATE skill_reqs SET status=?, done_ts=? WHERE id=?').bind(yes ? 'ok' : 'no', now(), req.id).run();
  const data = JSON.parse(req.data || '{}'),
    bots = botsCol(req.bots);
  if (!yes) {
    await addMsg(db, U, conv, 'sys', req.kind === 'skill' ? `好，不裝「${req.name}」。` : `好，不裝 ${req.name}。`, null, null, 'note');
    return true;
  }
  if (req.kind === 'skill') {
    const always = /一律允許/.test(text) && data.review?.noScripts && data.review?.level === 'low';
    await installSkill(db, U, { name: req.name, data, bots }, 'user');
    if (always) {
      const st = await getSettings(db, U);
      st.skillset = { ...skillSet(st), trusted: [...new Set([...skillSet(st).trusted, data.cand.repo])].slice(0, 50) };
      await putSettings(db, U, st);
      await addMsg(db, U, conv, 'sys', `以後 ${data.cand.repo} 裡沒有程式的技能會直接學，不再問你（設定 → 技能與工具 可以改）。`, null, null, 'note');
    }
    return true;
  }
  const st = await getSettings(db, U);
  setAssign(st, data.key, bots);
  await putSettings(db, U, st);
  await queueTool(db, U, { key: data.key, type: data.ask.type, ask: data.ask, info: data.info, conv, bots, by: req.by_ });
  await addMsg(db, U, conv, 'sys', `🧰 正在安裝 ${data.key}…`, null, null, 'note');
  return true;
}

// runner/done of a tool job: the runner's new list of what is installed here, and a line in the work timeline
export async function toolDone(db, U, job, body) {
  let spec = {};
  try {
    spec = JSON.parse(job.prompt || '{}');
  } catch {}
  const good = body.ok !== false;
  await db.prepare('UPDATE jobs SET status=?, finished=?, result=? WHERE id=?').bind(good ? 'done' : 'error', now(), clean(body.text, 2000), job.id).run();
  const st = await getSettings(db, U);
  if (body.tools && typeof body.tools === 'object' && JSON.stringify(body.tools).length < 100000) st._tools = body.tools;
  await putSettings(db, U, st);
  const label = catalogItem(spec.key)?.label || spec.key;
  const line = spec.op === 'remove' ? (good ? `🧰 移除了 ${label}` : `⚠ ${label} 沒有移除：${clean(body.text, 300)}`) : good ? `🧰 安裝了 ${label}${body.version ? `（${body.version}）` : ''}` : `⚠ ${label} 沒有裝好：${clean(body.text, 300)}`;
  const to = new Set([spec.conv, ...(spec.bots || [])].filter(Boolean));
  for (const c of [...to].slice(0, 20)) await addMsg(db, U, c, 'sys', line, null, null, good ? 'note' : null);
  await bump(db, U);
}

// ---------- generation keys and their two catalog skills ----------
const genList = st => (st.connectors || []).filter(c => c.kind === 'gen');
export function genKeys(st) {
  const out = {};
  for (const c of genList(st)) out[c.provider] = { secret: c.secret, model: c.model || {} };
  return out;
}
async function ensureGenSkills(db, U, st) {
  const have = new Set(genList(st).flatMap(c => GEN_PROVIDERS[c.provider]?.kinds || []));
  for (const [name, kind] of [['octa-image', 'image'], ['octa-video', 'video']]) {
    const row = await db.prepare('SELECT 1 AS n FROM lskills WHERE user_id=? AND name=?').bind(U, name).first();
    if (have.has(kind) && !row)
      await installSkill(db, U, { name, bots: null, data: { src: 'catalog', ver: 'octa-4.12', review: { desc: GEN_SKILLS[name].desc, license: 'MIT', paths: ['SKILL.md'], scripts: [], level: 'low', noScripts: true }, files: { 'SKILL.md': { t: 'text', d: genSkillMd(name) } } } }, 'catalog');
    if (!have.has(kind) && row) await removeSkill(db, U, name);
  }
}

// ---------- routes ----------
export async function skillRoutes(c) {
  const { env, db, path, m, url, body, U, me, ok } = c;
  if (path === 'runner/skill' && m === 'GET') {
    if (me.kind !== 'local') return err('需要執行器金鑰', 403);
    await ensureSkillTables(db);
    const id = String(url.searchParams.get('id') || ''),
      [name, ver] = id.split('@');
    const r = await db.prepare('SELECT files, ver FROM lskills WHERE user_id=? AND name=?').bind(U, name).first();
    if (!r || !String(r.ver).startsWith(ver || '')) return err('找不到這個技能', 404);
    return J({ files: JSON.parse(r.files || '{}') });
  }
  if (path === 'runner/genkeys' && m === 'POST') {
    if (me.kind !== 'local') return err('需要執行器金鑰', 403);
    return J({ keys: genKeys(await getSettings(db, U)) }); // only the runner on this computer, never the AI
  }
  if (!/^(skills|tools|gen-keys)(\/|$)/.test(path)) return null;
  await ensureSkillTables(db);
  if (path === 'skills' && m === 'GET') {
    const st = await getSettings(db, U),
      ss = skillSet(st),
      here = toolSt(st);
    const pending = (await db.prepare("SELECT id, kind, name, bots, conv, ts FROM skill_reqs WHERE user_id=? AND status='wait' ORDER BY id DESC LIMIT 30").bind(U).all()).results;
    return J({
      installed: await skillsView(db, U, null),
      pending: pending.map(p => ({ ...p, bots: botsCol(p.bots) })),
      settings: { selfFind: ss.selfFind, trusted: ss.trusted, token: ss.token ? mask(ss.token) : '' },
      tools: {
        platform: here.platform || '',
        gpu: !!here.gpu,
        catalog: catalogView(here.platform || undefined, !!here.gpu),
        installed: Object.fromEntries(Object.entries(here.installed || {}).map(([k, v]) => [k, { ...v, assign: assignOf(st, k) ?? null }])),
        seen: !!here.platform
      },
      gen: Object.fromEntries(Object.entries(GEN_PROVIDERS).map(([k, p]) => {
        const c2 = genList(st).find(x => x.provider === k);
        return [k, { label: p.label, kinds: p.kinds, cost: p.cost, site: p.site, key: c2 ? mask(c2.secret) : '' }];
      }))
    });
  }
  if (path === 'skills/settings' && m === 'PUT') {
    const st = await getSettings(db, U),
      cur = skillSet(st);
    const next = { ...cur };
    if ('selfFind' in body) next.selfFind = !!body.selfFind;
    if ('token' in body) {
      const t = String(body.token || '').trim();
      if (t && !/^[\w-]{20,255}$/.test(t)) return err('GitHub token 的格式不對');
      next.token = t;
    }
    if (Array.isArray(body.trusted))
      next.trusted = [...new Set(body.trusted.map(x => String(x).trim().replace(/^https:\/\/github\.com\//, '').replace(/\/+$/, '')).filter(x => /^[\w.-]+\/[\w.-]+$/.test(x)))].slice(0, 50);
    st.skillset = next;
    await putSettings(db, U, st);
    return ok();
  }
  if (path === 'skills/find' && m === 'POST') {
    try {
      const r = await findSkill(env, db, U, { query: body.query, bot: clean(body.bot, 64), bots: Array.isArray(body.bots) ? body.bots.map(x => clean(x, 64)) : undefined, from: 'user' });
      return r.error ? err(r.error, r.limited ? 429 : 400) : ok(r);
    } catch (e) {
      return err(e.message || '找不到', e.limited ? 429 : 502);
    }
  }
  if (path === 'skills/assign' && m === 'POST') {
    const name = clean(body.name, 80),
      bots = body.bots === null ? null : (Array.isArray(body.bots) ? body.bots : []).map(x => clean(x, 64));
    const r = await db.prepare('UPDATE lskills SET bots=? WHERE user_id=? AND name=?').bind(bots === null ? null : JSON.stringify(bots), U, name).run();
    if (!r.meta?.changes) return err('找不到這個技能', 404);
    await ensureMemSrc(db);
    const all = bots === null ? (await loadAll(db, U)).bots.map(b => b.id) : bots;
    const row = await db.prepare('SELECT src, by_ FROM lskills WHERE user_id=? AND name=?').bind(U, name).first();
    await db.prepare("DELETE FROM mem_src WHERE user_id=? AND kind='lskill' AND k=?").bind(U, name).run();
    for (const id of all)
      await db.prepare('INSERT OR REPLACE INTO mem_src (user_id,kind,owner,k,by_,ts) VALUES (?,?,?,?,?,?)').bind(U, 'lskill', id, name, row.src === 'catalog' ? 'catalog' : row.by_ === 'trusted' ? 'trusted' : 'github', now()).run();
    return ok();
  }
  if (path === 'skills/update' && m === 'POST') {
    const row = await db.prepare('SELECT * FROM lskills WHERE user_id=? AND name=?').bind(U, clean(body.name, 80)).first();
    if (!row) return err('找不到這個技能', 404);
    if (row.src !== 'github') return ok({ same: true, text: '內建的技能跟著 OCTA 一起更新。' });
    const st = await getSettings(db, U);
    try {
      const sha = await ghFor(env, db, st).latestSha(row.repo, row.path || '');
      if (sha === row.ver) return ok({ same: true, text: `「${row.name}」已經是最新版（${sha.slice(0, 7)}）。` });
      const bots = botsCol(row.bots);
      const first = bots?.[0] || (await loadAll(db, U)).bots[0]?.id;
      const r = await findSkill(env, db, U, { pin: { repo: row.repo, path: row.path || '', sha, license: row.license }, bot: first, bots: bots || undefined, update: row.name });
      return r.error ? err(r.error, 400) : ok(r);
    } catch (e) {
      return err(e.message, e.limited ? 429 : 502);
    }
  }
  if (path.startsWith('skills/') && m === 'DELETE') {
    const name = decodeURIComponent(path.slice(7));
    if (!(await removeSkill(db, U, name))) return err('找不到這個技能', 404);
    return ok();
  }
  if (path === 'tools/install' && m === 'POST') {
    const r = await askTool(env, db, U, { what: clean(body.what || body.id, 120), bot: clean(body.bot, 64), conv: clean(body.bot, 64) || null, bots: body.bots === undefined ? undefined : body.bots });
    return r.error ? err(r.error, 400) : ok(r);
  }
  if (path === 'tools/remove' && m === 'POST') {
    const key = clean(body.id, 120);
    if (!toolSt(await getSettings(db, U)).installed?.[key]) return err('這台電腦沒有裝這個工具', 404);
    await queueTool(db, U, { key, op: 'remove', conv: null, bots: [] });
    return ok({ queued: key });
  }
  if (path === 'tools/assign' && m === 'POST') {
    const st = await getSettings(db, U);
    setAssign(st, clean(body.id, 120), body.bots === null ? null : (Array.isArray(body.bots) ? body.bots : []).map(x => clean(x, 64)));
    await putSettings(db, U, st);
    return ok();
  }
  if (path === 'gen-keys' && m === 'POST') {
    const provider = String(body.provider || '');
    if (!GEN_PROVIDERS[provider]) return err('不認得這個服務');
    const secret = String(body.secret || '').trim();
    if (!secret || secret.length > 400 || /[\s]/.test(secret)) return err('金鑰格式不對');
    const st = await getSettings(db, U);
    st.connectors = [...(st.connectors || []).filter(x => !(x.kind === 'gen' && x.provider === provider)), { id: 'gen-' + provider, kind: 'gen', provider, name: GEN_PROVIDERS[provider].label, secret }];
    await putSettings(db, U, st);
    await ensureGenSkills(db, U, st);
    return ok();
  }
  if (path.startsWith('gen-keys/') && m === 'DELETE') {
    const provider = path.slice(9);
    const st = await getSettings(db, U);
    st.connectors = (st.connectors || []).filter(x => !(x.kind === 'gen' && x.provider === provider));
    await putSettings(db, U, st);
    await ensureGenSkills(db, U, st);
    return ok();
  }
  return null;
}
export { CATALOG };
