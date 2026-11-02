// Coding tasks: helpers and the code/* routes (the runner executes them; this API only stores state).
import { getSettings } from './db.mjs';
import { codeFbOk, fbParse } from './engines.mjs';
import { J, clean, err, now, parseJson, uid } from './util.mjs';

const CODE_ENGINES = [
  'ollama',
  'opencode',
  'claude',
  'codex',
  'gemini',
  'grok',
  'grokbot',
  'copilot',
  'cursor',
  'qwen',
  'fixture'
];
const codeEngineOk = e => (CODE_ENGINES.includes(e) ? e : '');
const repoPathOk = p => {
  const v = String(p || '').trim();
  if (v.length < 2 || v.length > 500 || v.includes('\0') || v.split(/[\\/]/).includes('..')) return null;
  if (!v.startsWith('/') && !/^[a-zA-Z]:[\\/]/.test(v)) return null;
  return v;
};

export function publicCodeTask(row) {
  return {
    id: row.id,
    repoId: row.repo_id,
    title: row.title,
    prompt: row.prompt,
    criteria: row.criteria,
    engine: row.engine,
    model: row.model || '',
    fb: fbParse(row.fb),
    status: row.status,
    phase: row.phase,
    role: row.role || '',
    workspaceId: row.workspace_id || '',
    branch: row.branch || '',
    baseRef: row.base_ref || '',
    headRef: row.head_ref || '',
    retries: row.retries,
    maxRetries: row.max_retries,
    jobId: row.job_id,
    summary: parseJson(row.summary),
    approval: parseJson(row.approval),
    cancel: !!row.cancel,
    created: row.created,
    updated: row.updated,
    finished: row.finished,
    deployed: false,
    merged: false
  };
}

export async function codeRoutes(c) {
  const { env, db, path, m, body, U, ok } = c;
  // ---------- coding tasks (the runner executes them; this API only stores state) ----------
  if (path === 'code/providers' && m === 'GET') {
    const st = await getSettings(db, U);
    const info = st._coding || null;
    const engines = parseJson((await db.prepare('SELECT engines FROM users WHERE id=?').bind(U).first())?.engines);

    const row = (id, label, available, reason, models) => ({
      id,
      label,
      available: !!available,
      reason: reason || (available ? '' : '主機尚未回報'),
      models: models || []
    });
    return J({
      limits: { maxRepairs: 3, maxWritersPerWorktree: 1 },
      fixture: env.OCTA_CODE_ALLOW_FIXTURE === '1',
      providers: [
        row('ollama', 'Ollama 本機模型', info?.ollama?.available, info?.ollama?.reason, info?.ollama?.models),
        row('opencode', 'OpenCode', info?.opencode?.available, info?.opencode?.reason),
        row('claude', 'Claude Code', engines?.claude, engines ? '' : '主機尚未回報'),
        row('codex', 'ChatGPT / Codex', engines?.codex, engines ? '' : '主機尚未回報'),
        row('gemini', 'Antigravity', engines?.gemini, engines ? '' : '主機尚未回報'),
        row('unity', 'Unity', info?.unity?.available, info?.unity?.reason || '未偵測到 Unity'),
        row('unreal', 'Unreal', info?.unreal?.available, info?.unreal?.reason || '未偵測到 Unreal')
      ]
    });
  }
  if (path === 'code/repos' && m === 'GET') {
    const rows = (await db.prepare('SELECT * FROM code_repos WHERE user_id=? ORDER BY created').bind(U).all()).results;
    return J({ repos: rows });
  }
  if (path === 'code/repos' && m === 'POST') {
    const name = clean(body.name, 40),
      pathName = repoPathOk(body.path);
    if (!name || !pathName) return err('名稱和絕對路徑都要填，路徑不能含 ..');
    const id = 'cr-' + uid();
    await db
      .prepare('INSERT INTO code_repos (id,user_id,name,path,validated,created) VALUES (?,?,?,?,0,?)')
      .bind(id, U, name, pathName, now())
      .run();
    return ok({ id });
  }
  if (path.startsWith('code/repos/') && m === 'DELETE') {
    const id = path.slice('code/repos/'.length);
    const open = await db
      .prepare(
        "SELECT 1 FROM code_tasks WHERE user_id=? AND repo_id=? AND status NOT IN ('tested','failed','cancelled','blocked')"
      )
      .bind(U, id)
      .first();
    if (open) return err('這個儲存庫還有進行中的程式任務', 409);
    await db.prepare('DELETE FROM code_repos WHERE id=? AND user_id=?').bind(id, U).run();
    return ok();
  }
  if (path === 'code/tasks' && m === 'GET') {
    const rows = (await db.prepare('SELECT * FROM code_tasks WHERE user_id=? ORDER BY created DESC LIMIT 50').bind(U).all())
      .results;
    return J({ tasks: rows.map(publicCodeTask) });
  }
  if (path === 'code/tasks' && m === 'POST') {
    const repo = await db.prepare('SELECT * FROM code_repos WHERE id=? AND user_id=?').bind(clean(body.repoId, 80), U).first();
    if (!repo) return err('找不到授權的儲存庫', 404);
    const title = clean(body.title, 80),
      prompt = clean(body.prompt, 8000),
      criteria = clean(body.criteria, 4000);
    const engine = codeEngineOk(body.engine);
    if (!engine) return err('要選擇模型或引擎');
    if (engine === 'fixture' && env.OCTA_CODE_ALLOW_FIXTURE !== '1') return err('測試替身未啟用');
    if (!title || !prompt) return err('標題和任務內容都要填');
    const maxRetries = Math.max(0, Math.min(3, Number.isFinite(+body.maxRetries) ? Math.floor(+body.maxRetries) : 3));
    const id = 'ct-' + uid();
    const t = now();
    const fb = codeFbOk(body.fallbacks);
    await db
      .prepare(
        `INSERT INTO code_tasks (id,user_id,repo_id,title,prompt,criteria,engine,model,fb,status,phase,retries,max_retries,cancel,created,updated)
        VALUES (?,?,?,?,?,?,?,?,?,'queued','queued',0,?,0,?,?)`
      )
      .bind(id, U, repo.id, title, prompt, criteria || '測試要通過', engine, clean(body.model, 80) || null, fb, maxRetries, t, t)
      .run();
    const job = await db
      .prepare("INSERT INTO jobs (user_id,conv,bot_id,chain,prompt,created,kind,url) VALUES (?,?,?,'[]',?,?,'code',?)")
      .bind(U, 'code:' + id, 'code-agent', title, t, id)
      .run();
    await db.prepare('UPDATE code_tasks SET job_id=? WHERE id=?').bind(job.meta.last_row_id, id).run();
    await db
      .prepare('INSERT INTO code_events (task_id,user_id,ts,role,kind,text) VALUES (?,?,?,?,?,?)')
      .bind(id, U, t, 'orchestrator', 'queued', '已排隊，等待主機電腦執行')
      .run();
    return ok({ id, jobId: job.meta.last_row_id });
  }
  const codeTaskMatch = path.match(/^code\/tasks\/([^/]+)$/);
  if (codeTaskMatch && m === 'GET') {
    const id = codeTaskMatch[1];
    const task = await db.prepare('SELECT * FROM code_tasks WHERE id=? AND user_id=?').bind(id, U).first();
    if (!task) return err('找不到程式任務', 404);
    const events = (
      await db
        .prepare('SELECT id,ts,role,kind,text,data FROM code_events WHERE task_id=? AND user_id=? ORDER BY id DESC LIMIT 80')
        .bind(id, U)
        .all()
    ).results.reverse();
    return J({ task: publicCodeTask(task), events: events.map(e => ({ ...e, data: parseJson(e.data) })) });
  }
  const codeCancel = path.match(/^code\/tasks\/([^/]+)\/cancel$/);
  if (codeCancel && m === 'POST') {
    const id = codeCancel[1];
    const task = await db.prepare('SELECT * FROM code_tasks WHERE id=? AND user_id=?').bind(id, U).first();
    if (!task) return err('找不到程式任務', 404);
    await db.prepare('UPDATE code_tasks SET cancel=1, updated=? WHERE id=? AND user_id=?').bind(now(), id, U).run();
    if (task.status === 'queued' && task.job_id) {
      await db.prepare("DELETE FROM jobs WHERE id=? AND user_id=? AND status='pending'").bind(task.job_id, U).run();
      await db
        .prepare("UPDATE code_tasks SET status='cancelled', phase='cancelled', finished=? WHERE id=? AND user_id=?")
        .bind(now(), id, U)
        .run();
    }
    await db
      .prepare('INSERT INTO code_events (task_id,user_id,ts,role,kind,text) VALUES (?,?,?,?,?,?)')
      .bind(id, U, now(), 'orchestrator', 'cancel', '使用者取消任務')
      .run();
    return ok({ cancelled: task.status === 'queued', stopping: task.status !== 'queued' });
  }
  const codeApprove = path.match(/^code\/tasks\/([^/]+)\/approve$/);
  if (codeApprove && m === 'POST') {
    const id = codeApprove[1];
    const task = await db.prepare('SELECT * FROM code_tasks WHERE id=? AND user_id=?').bind(id, U).first();
    if (!task) return err('找不到程式任務', 404);
    const action = body.action === 'deploy' ? 'deploy' : body.action === 'merge' ? 'merge' : '';
    if (!action) return err('要指定 merge 或 deploy');
    if (body.allow !== true) return err('需要明確核准');
    if (action === 'deploy' && body.target !== 'production') return err('正式部署要明示 target=production');
    const approval = parseJson(task.approval, {}) || {};
    approval[action] = { allow: true, by: 'user', target: action === 'deploy' ? 'production' : 'branch', at: now() };
    await db
      .prepare('UPDATE code_tasks SET approval=?, updated=? WHERE id=? AND user_id=?')
      .bind(JSON.stringify(approval), now(), id, U)
      .run();
    await db
      .prepare('INSERT INTO code_events (task_id,user_id,ts,role,kind,text,data) VALUES (?,?,?,?,?,?,?)')
      .bind(
        id,
        U,
        now(),
        'policy',
        'approval',
        action === 'deploy' ? '已記錄正式部署核准，尚未部署' : '已記錄合併核准，尚未合併',
        JSON.stringify({ action, executed: false })
      )
      .run();
    return ok({ executed: false, deployed: false, merged: false, approval });
  }
}
