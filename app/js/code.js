/* OCTA web app — 程式任務 (coding tasks): an isolated worktree on this computer, tests, diff review, approvals. */
'use strict';
let codeTimer=null,codeFlash='';
function stopCodePoll(){clearInterval(codeTimer);codeTimer=null}
const CODE_DONE=new Set(['tested','failed','cancelled','blocked']);
const CODE_LABELS={queued:'排隊',inspecting:'檢查儲存庫',planning:'規劃',editing:'修改',testing:'測試',repairing:'修復',reviewing:'審查差異',paused:'暫停',tested:'已測試',failed:'失敗',cancelled:'已取消',blocked:'受阻'};
const CODE_ENG='<option value="ollama">Ollama</option><option value="opencode">OpenCode</option><option value="claude">Claude</option><option value="codex">ChatGPT</option><option value="gemini">Antigravity</option>';
function codeBadge(on,yes,no){return `<span class="pill ${on?'ok':''}">${on?yes:no}</span>`}
// the coding pages live inside Settings; leaving them stops the poll
function codePage(title,html,back){const keep=$('sbody')?.dataset.code===title?$('sbody').scrollTop:0;subPage(title,html,()=>{stopCodePoll();(back||(()=>showSection('adv')))()});$('sbody').dataset.code=title;$('sbody').scrollTop=keep}
async function openCode(focus){
  stopCodePoll();
  if(!settingsOpen())openSettings('adv');
  if(!$('sbody').dataset.code)codePage('程式任務','<p class="fade">讀取中…</p>');
  let repos=[],tasks=[],prov=null;
  try{const [a,b,c]=await Promise.all([api('code/repos'),api('code/tasks'),api('code/providers')]);repos=a.repos||[];tasks=b.tasks||[];prov=c}
  catch(e){codePage('程式任務',`<p class="errmsg">${esc(e.message)}</p>`);return}
  if(!settingsOpen())return;
  if(focus){
    let detail=null;try{detail=await api('code/tasks/'+encodeURIComponent(focus))}catch(e){detail={error:e.message}}
    const task=detail.task||tasks.find(t=>t.id===focus);
    if(!task){openCode();return}
    const s=task.summary||{},tests=s.tests||[],files=s.files||[],ev=detail.events||s.events||[];
    codePage(esc(task.title),`<div class="cstat">
        <span class="pill ${task.status==='tested'?'ok':CODE_DONE.has(task.status)?'':'warn'}">${esc(CODE_LABELS[task.status]||task.status)}</span>
        <span class="pill">${esc(task.role||'—')} · ${esc(task.phase||'')}</span>
        ${codeBadge(!!s.plan,'計畫已產生','計畫未產生')}${codeBadge(files.length,'已修改檔案','尚未修改')}${codeBadge(!!s.testsPassed,'測試通過','測試未通過')}${codeBadge(!!(task.approval&&task.approval.merge),'已核准合併','未核准')}${codeBadge(false,'已部署','未部署')}
      </div>
      <p class="hmuted"><span>完成只看測試結束碼和驗收條件，不看模型自己說的成功。</span> <span data-u>${s.providerNote?esc(s.providerNote):''} ${s.providerId?esc(s.providerId):''} ${task.engine?esc(task.engine)+(task.model?' / '+esc(task.model):''):''} ${task.branch?esc(task.branch):''}</span></p>
      ${(s.modelSwitches||[]).length?`<div class="field"><span>模型切換</span>${s.modelSwitches.map(x=>`<div data-u>${esc(x.kind||'')} → ${esc(x.action||'')} ${esc(x.engine||'')}${x.model?' / '+esc(x.model):''}</div>`).join('')}</div>`:''}
      ${s.reason||s.error?`<p class="errmsg" data-u>${esc(s.reason||'')} ${esc(s.error||'')}</p>`:''}
      <p data-u>${esc(task.prompt)}</p>
      <div class="field"><span>驗收條件</span><div data-u>${(s.criteria||[]).map(c=>`<div>${c.met?'✓':'○'} ${esc(c.text)}${c.evidence?' — '+esc(c.evidence):''}</div>`).join('')||esc(task.criteria||'')}</div></div>
      <div class="field"><span>測試</span>${tests.length?tests.map(t=>`<div class="log"><div class="lh"><span class="pill ${t.passed?'ok':'err'}">${t.passed?'通過':'失敗'} ${t.code??''}</span><b data-u>${esc(t.cmd)}</b></div><small data-u>${esc((t.stderr||t.stdout||'').slice(0,500))}</small></div>`).join(''):'<p class="hmuted">還沒有測試紀錄</p>'}</div>
      <div class="field"><span>變更的檔案</span>${files.length?files.map(f=>`<div data-u class="mono">${esc(f.path)}</div>`).join(''):'<p class="hmuted">還沒有變更</p>'}</div>
      <div class="field"><span>git diff</span><pre class="code cdiff" data-u>${esc(s.diff||'（還沒有差異）')}</pre></div>
      <div class="field"><span>紀錄</span>${ev.length?ev.slice(-12).map(e=>`<div class="log"><div class="lh"><span class="pill">${esc(e.role||'')}</span><b data-u>${esc(e.kind||'')}</b></div><small data-u>${esc(e.text||'')}</small></div>`).join(''):'<p class="hmuted">還沒有紀錄</p>'}</div>
      <div class="row2">${CODE_DONE.has(task.status)?'':`<button class="ghost sm" id="cCancel">取消任務</button>`}<button class="ghost sm" id="cMerge">核准合併（不執行）</button><button class="ghost sm" id="cDeploy">核准正式部署（不執行）</button></div>
      <p class="errmsg" id="cMsg">${esc(I18N.t(codeFlash))}</p>`,()=>openCode());
    codeFlash='';
    if($('cCancel'))$('cCancel').onclick=async()=>{try{await api('code/tasks/'+task.id+'/cancel','POST',{});openCode(task.id)}catch(e){$('cMsg').textContent=e.message}};
    $('cMerge').onclick=async()=>{try{await api('code/tasks/'+task.id+'/approve','POST',{action:'merge',allow:true});codeFlash='已記錄合併核准，合併尚未執行';openCode(task.id)}catch(e){$('cMsg').textContent=e.message}};
    $('cDeploy').onclick=async()=>{try{await api('code/tasks/'+task.id+'/approve','POST',{action:'deploy',allow:true,target:'production'});codeFlash='已記錄正式部署核准，這次沒有部署。';openCode(task.id)}catch(e){$('cMsg').textContent=e.message}};
    if(!CODE_DONE.has(task.status))codeTimer=setInterval(()=>openCode(task.id),2000);
    return}
  const provHtml=(prov?.providers||[]).map(p=>`<span class="pill ${p.available?'ok':''}">${esc(p.label)}：${p.available?I18N.t('可用'):esc(p.reason||I18N.t('不可用'))}</span>`).join(' ');
  const repoOpts=repos.map(r=>`<option value="${esc(r.id)}" data-u>${esc(r.name)}</option>`).join('');
  codePage('程式任務',`<p>在這台電腦的隔離 git worktree 裡檢查、修改、測試、最多自動修復 3 次，再給你看實際 diff。正式部署一定要核准，而且核准後也不會自動部署。</p>
    <div class="cstat">${provHtml||'<span class="pill">電腦尚未回報模型</span>'}</div>
    <div class="logs">${tasks.length?tasks.map(t=>`<button type="button" class="rrow" data-ct="${esc(t.id)}"><span class="t"><b data-u>${esc(t.title)}</b><small><span>${esc(CODE_LABELS[t.status]||t.status)}</span> · <span data-u>${esc(t.engine)}${t.model?' / '+esc(t.model):''}</span></small></span><span class="pill ${t.status==='tested'?'ok':CODE_DONE.has(t.status)?'':'warn'}">${esc(CODE_LABELS[t.status]||t.status)}</span></button>`).join(''):'<p class="hmuted">還沒有程式任務</p>'}</div>
    <form class="scard inset" id="cTask"><h4>新任務</h4>
      <input id="ctTitle" maxlength="80" placeholder="標題">
      <textarea id="ctPrompt" maxlength="4000" placeholder="要做的修改"></textarea>
      <textarea id="ctCrit" maxlength="2000" placeholder="驗收條件，一行一條。例如：測試要通過"></textarea>
      <div class="row2"><select id="ctEngine" class="grow">${CODE_ENG}</select><input id="ctModel" class="grow" maxlength="80" placeholder="模型（Ollama 可留空）"></div>
      <div class="row2"><select id="ctFb0" class="grow"><option value="">第一備援：不使用</option>${CODE_ENG}</select><select id="ctFb1" class="grow"><option value="">第二備援：不使用</option>${CODE_ENG}</select></div>
      <select id="ctRepo">${repoOpts||'<option value="">先登記儲存庫</option>'}</select>
      <div class="row2"><button class="btn sm" type="submit">建立任務</button></div>
    </form>
    <form class="scard inset" id="cRepo"><h4>授權儲存庫</h4>
      <input id="crName" maxlength="40" placeholder="名稱">
      <input id="crPath" maxlength="500" placeholder="這台電腦上的絕對路徑，例如 /home/me/app">
      <div class="row2"><button class="ghost sm" type="submit">登記儲存庫</button></div>
    </form>
    <p class="errmsg" id="cMsg"></p>`);
  $('cRepo').onsubmit=async ev=>{ev.preventDefault();try{await api('code/repos','POST',{name:$('crName').value.trim(),path:$('crPath').value.trim()});openCode()}catch(e){$('cMsg').textContent=e.message}};
  $('cTask').onsubmit=async ev=>{ev.preventDefault();try{const r=await api('code/tasks','POST',{repoId:$('ctRepo').value,title:$('ctTitle').value.trim(),prompt:$('ctPrompt').value.trim(),criteria:$('ctCrit').value.trim(),engine:$('ctEngine').value,model:$('ctModel').value.trim(),fallbacks:[$('ctFb0').value,$('ctFb1').value].filter(Boolean)});openCode(r.id)}catch(e){$('cMsg').textContent=e.message}};
  $('veil').querySelectorAll('[data-ct]').forEach(b=>b.onclick=()=>openCode(b.dataset.ct));
  if(tasks.some(t=>!CODE_DONE.has(t.status)))codeTimer=setInterval(()=>{const a=document.activeElement;if(a&&/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))return;openCode()},2500);
}
