/* OCTA web app — 4.12 設定 → 技能與工具: learning skills from GitHub (find, token, trusted sources, 自己找),
   the skills learned so far (version, source, which bots, 更新／移除), the toolbox on this computer and the keys for
   image / video generation. Installs from GitHub and off-catalog tools always come back as an approval card in a chat. */
'use strict';
const SKU={d:null};
const skBots=ids=>ids===null?I18N.t('全部機器人'):(ids||[]).map(id=>bot(id)?.name).filter(Boolean).join('、')||I18N.t('（沒有）');
const skBotOpts=sel=>S.bots.map(b=>`<option value="${esc(b.id)}" data-u ${b.id===sel?'selected':''}>${esc(b.name)}</option>`).join('');
const SK_SRC={github:'GitHub',trusted:'GitHub（信任的來源）',catalog:'OCTA 內建',user:'GitHub'};
// who has it: 全部機器人 or a few — one small form, used for skills and tools
function skAssign(kind,key,cur){const all=cur===null;
  return `<details class="adv skas"><summary><span>給哪些機器人</span> <small class="hmuted" data-u>${esc(skBots(cur))}</small></summary><div class="stack" data-nodirty>
    <label class="chk"><input type="checkbox" data-skall ${all?'checked':''}><span>全部機器人</span></label>
    <div class="skbots">${S.bots.map(b=>`<label class="chk"><input type="checkbox" value="${esc(b.id)}" ${all||(cur||[]).includes(b.id)?'checked':''}><span data-u>${esc(b.name)}</span></label>`).join('')}</div>
    <div class="row2"><button type="button" class="btn sm" data-skassign="${kind}" data-key="${esc(key)}">儲存</button></div></div></details>`}
SEC.skills=async()=>{
  const learn=block('skLearn','學技能','機器人可以到 GitHub 學別人寫好的技能（Agent Skills）。OCTA 會先看過內容，列出它會做什麼、有沒有程式、會不會連網路，你核准才會裝。');
  const have=block('skHave','已學會的技能');
  const box=block('skTools','工具箱','機器人做影片、圖片要用的工具，裝在 OCTA 自己的資料夾，不需要管理員權限，也只給你指定的機器人用。');
  const gen=block('skGen','產生圖片與影片','用你自己的 API 金鑰產生圖片和影片。金鑰只存在這台電腦，機器人看不到。費用由那個服務直接向你收。');
  learn.innerHTML='<p class="fade">讀取中…</p>';
  let d;try{d=await api('skills')}catch(e){learn.innerHTML=`<p class="note-box warn" data-u>${esc(e.message)}</p>`;return}
  if(secNow!=='skills')return;SKU.d=d;
  skLearn(learn,d);skHave(have,d);skBox(box,d);skGen(gen,d);paintIcons($('sblocks'))};
function skLearn(el,d){const s=d.settings;
  el.innerHTML=`${toggleRow('skSelf','允許機器人自己找技能',s.selfFind,'開著：機器人發現自己不會時，會自己到 GitHub 找適合它那個 AI 的技能（安裝前一樣要你核准）。關掉：只有你說「去 GitHub 學…」才會找。')}
    <h4>幫機器人找一個技能</h4>
    <div class="row2 skfind"><select id="skBot" aria-label="給哪個機器人">${skBotOpts(S.bots[0]?.id)}</select><input id="skQ" maxlength="80" placeholder="英文關鍵字，例如 pdf、excel、slides" aria-label="關鍵字"><button type="button" class="btn sm" id="skGo">找技能</button></div>
    <p class="hmuted" id="skMsg">找到後會在那個機器人的對話裡出現核准卡。</p>
    <details class="adv"><summary>${ic('link')}<span>GitHub token（選填）</span> <small class="hmuted" data-u>${esc(s.token||'')}</small></summary><div class="stack" data-nodirty>
      <p class="hmuted">不填也能用，但 GitHub 每小時只讓查幾次。填一個只有公開資料權限的 token 可以查比較多次。只存在這台電腦。</p>
      <label class="field"><span>token</span><input id="skTok" type="password" autocomplete="off" placeholder="github_pat_…"></label>
      <div class="row2"><button type="button" class="btn sm" id="skTokSave">儲存</button>${s.token?'<button type="button" class="ghost sm" id="skTokDel">移除</button>':''}</div></div></details>
    <details class="adv"><summary>${ic('shield')}<span>信任的來源</span> <small class="hmuted" data-u>${s.trusted.length||''}</small></summary><div class="stack" data-nodirty>
      <p class="hmuted">這些 GitHub 專案裡「沒有程式」的技能會直接學，不再問你；有程式的還是會問。一行一個，例如 anthropics/skills。</p>
      <textarea id="skTrust" rows="3" placeholder="anthropics/skills">${esc(s.trusted.join('\n'))}</textarea>
      <div class="row2"><button type="button" class="btn sm" id="skTrustSave">儲存</button></div></div></details>`;
  const put=async(b,msg)=>{try{await api('skills/settings','PUT',b);toast(I18N.t(msg||'已儲存 ✓'));SEC.skills()}catch(e){toast(e.message)}};
  $('skSelf').onclick=()=>{const on=!$('skSelf').classList.contains('on');swSet($('skSelf'),on);put({selfFind:on})};
  $('skTokSave').onclick=()=>put({token:$('skTok').value.trim()});
  if($('skTokDel'))$('skTokDel').onclick=()=>put({token:''},'已移除');
  $('skTrustSave').onclick=()=>put({trusted:$('skTrust').value.split(/\n+/).map(x=>x.trim()).filter(Boolean)});
  $('skGo').onclick=async()=>{const q=$('skQ').value.trim(),b=$('skBot').value;if(!q||!b)return;$('skGo').disabled=true;$('skMsg').textContent=I18N.t('在 GitHub 找，下載並檢查內容中…');
    try{const r=await api('skills/find','POST',{query:q,bot:b});$('skMsg').textContent=r.text&&!r.req?r.text:I18N.t('找到了，核准卡在那個機器人的對話裡。');if(r.req||r.installed)SEC.skills()}
    catch(e){$('skMsg').textContent=e.message}$('skGo').disabled=false}}
function skHave(el,d){
  const pend=(d.pending||[]).map(p=>`<div class="kvrow"><span><span>等你核准：</span><b data-u>${esc(p.name)}</b> <small class="hmuted">${p.kind==='tool'?'工具':'技能'}</small></span><button type="button" class="ghost sm" data-skgo="${esc(p.conv)}">去核准</button></div>`).join('');
  const rows=(d.installed||[]).map(s=>`<div class="skrow"><div class="sktx"><b data-u>${esc(s.name)}</b> <span class="pill">${esc(I18N.t(SK_SRC[s.src==='catalog'?'catalog':s.by]||'GitHub'))}</span>${s.scripts?` <span class="pill warn"><span>含程式</span> <span data-u>${s.scripts}</span></span>`:''}
      <p class="hmuted" data-u>${esc((s.desc||'').slice(0,180))}</p>
      <small class="hmuted">${s.url?`<a href="${esc(s.url)}" target="_blank" rel="noopener" data-u>${esc(s.repo||'')}@${esc(s.ver)}</a> · `:''}<span data-u>${esc(s.license||'')}</span>${s.ts?` · <span data-u>${esc(when(s.ts))}</span>`:''}</small>
      ${skAssign('skill',s.name,s.bots)}</div>
    <div class="mv-acts">${s.src==='github'?`<button type="button" class="ghost sm" data-skupd="${esc(s.name)}">更新</button>`:''}${s.src!=='catalog'?`<button type="button" class="ghost sm danger" data-skdel="${esc(s.name)}">移除</button>`:''}</div></div>`).join('');
  el.innerHTML=(pend?`<div class="kvs">${pend}</div>`:'')+(rows||'<p class="hmuted">還沒有。說「去 GitHub 學 pdf」或在上面找一個。</p>');
  el.onclick=async e=>{const t=e.target;
    const g=t.closest('[data-skgo]');if(g){closeSheet();openConv(g.dataset.skgo);return}
    const u=t.closest('[data-skupd]');if(u){u.disabled=true;try{const r=await api('skills/update','POST',{name:u.dataset.skupd});toast(r.text||I18N.t('有新版本，核准卡在對話裡'));SEC.skills()}catch(x){toast(x.message);u.disabled=false}return}
    const x=t.closest('[data-skdel]');if(x){confirmIn(x.closest('.skrow'),async()=>{try{await api('skills/'+encodeURIComponent(x.dataset.skdel),'DELETE');toast(I18N.t('已移除'));SEC.skills()}catch(y){toast(y.message)}});return}
    skAssignClick(e)}}
// 全部機器人 ↔ each bot's box, and saving who has it
function skAssignClick(e){const t=e.target;
  if(t.matches('[data-skall]')){t.closest('.stack').querySelectorAll('.skbots input').forEach(i=>i.checked=t.checked);return}
  const a=t.closest('[data-skassign]');if(!a)return;const st=a.closest('.stack');
  const bots=st.querySelector('[data-skall]').checked?null:[...st.querySelectorAll('.skbots input:checked')].map(i=>i.value);
  api(a.dataset.skassign==='tool'?'tools/assign':'skills/assign','POST',a.dataset.skassign==='tool'?{id:a.dataset.key,bots}:{name:a.dataset.key,bots}).then(()=>{toast(I18N.t('已儲存 ✓'));SEC.skills()}).catch(x=>toast(x.message))}
function skBox(el,d){const T=d.tools,inst=T.installed||{};
  const row=t=>{const i=inst[t.id];
    const state=i?.ok?`<span class="pill ok"><span>已安裝</span> <span data-u>${esc(i.version||'')}</span></span>`
      :t.way==='download'||t.way==='uv-python'||t.way==='bundled'?`<button type="button" class="btn sm" data-tlin="${esc(t.id)}">安裝</button>`
      :t.way==='later'?'<span class="pill">之後開放</span>':t.how?`<small class="hmuted"><span>請自己安裝：</span><code data-u>${esc(t.how)}</code></small>`:'<span class="pill">這台電腦不支援</span>';
    return `<div class="skrow"><div class="sktx"><b data-u>${esc(t.label)}</b> <small class="hmuted" data-u>${esc(t.version||'')}</small><p class="hmuted" data-u>${esc(t.what)}</p>
      <small class="hmuted"><a href="${esc(t.source)}" target="_blank" rel="noopener">${esc(I18N.t('官方來源'))}</a>${t.sha256?` · <span>SHA-256</span> <code data-u>${esc(t.sha256.slice(0,12))}…</code>`:''}${t.size?' · '+fsize(t.size):''}</small>
      ${i?.ok?skAssign('tool',t.id,i.assign):''}</div><div class="mv-acts">${state}${i?.ok&&t.way!=='bundled'?`<button type="button" class="ghost sm danger" data-tlrm="${esc(t.id)}">移除</button>`:''}</div></div>`};
  const others=Object.entries(inst).filter(([k])=>!T.catalog.some(t=>t.id===k)).map(([k,i])=>`<div class="skrow"><div class="sktx"><b data-u>${esc(k)}</b> <small class="hmuted" data-u>${esc(i.version||'')}</small>${i.source?`<p class="hmuted"><a href="${esc(i.source)}" target="_blank" rel="noopener" data-u>${esc(i.source)}</a></p>`:''}${skAssign('tool',k,i.assign)}</div>
    <div class="mv-acts"><button type="button" class="ghost sm danger" data-tlrm="${esc(k)}">移除</button></div></div>`).join('');
  el.innerHTML=`${T.seen?'':'<p class="note-box">電腦上的 OCTA 還沒回報它裝了哪些工具，等一下再打開這頁。</p>'}
    <h4>OCTA 驗證過的工具（直接安裝）</h4><p class="hmuted">固定版本、官方來源、下載後比對檢查碼，對不上就不裝。裝好之後機器人在指令列直接能用。</p>
    ${T.catalog.map(row).join('')}
    <h4>其他來源（要你核准）</h4>${others||'<p class="hmuted">還沒有。</p>'}
    <div class="row2 skfind"><select id="tlBot" aria-label="給哪個機器人">${skBotOpts(S.bots[0]?.id)}</select><input id="tlQ" maxlength="120" placeholder="npm:套件、pip:套件、mcp:套件、github:擁有者/專案" aria-label="要裝什麼"><button type="button" class="ghost sm" id="tlGo">申請安裝</button></div>
    <p class="hmuted">會先查好版本、大小和授權，在那個機器人的對話裡出現核准卡。</p>
    ${T.gpu?'':'<p class="hmuted">本機產生圖片影片（ComfyUI）需要 NVIDIA 顯示卡，這台電腦沒有偵測到。</p>'}`;
  el.onclick=async e=>{const t=e.target;
    const i=t.closest('[data-tlin]');if(i){i.disabled=true;try{const r=await api('tools/install','POST',{id:i.dataset.tlin,bots:null});toast(r.text||I18N.t('安裝中'))}catch(x){toast(x.message);i.disabled=false}return}
    const r=t.closest('[data-tlrm]');if(r){confirmIn(r.closest('.skrow'),async()=>{try{await api('tools/remove','POST',{id:r.dataset.tlrm});toast(I18N.t('移除中'))}catch(y){toast(y.message)}});return}
    if(t.closest('#tlGo')){const q=$('tlQ').value.trim();if(!q)return;try{const x=await api('tools/install','POST',{what:q,bot:$('tlBot').value});toast(x.text&&!x.req?x.text:I18N.t('核准卡在那個機器人的對話裡'))}catch(y){toast(y.message)}return}
    skAssignClick(e)}}
function skGen(el,d){const kinds=k=>k.map(x=>x==='video'?I18N.t('影片'):I18N.t('圖片')).join('、');
  el.innerHTML=Object.entries(d.gen).map(([k,p])=>`<div class="skrow"><div class="sktx"><b data-u>${esc(p.label)}</b> <small class="hmuted">${kinds(p.kinds)}</small><p class="hmuted" data-u>${esc(p.cost)}</p>
      ${p.key?`<small class="hmuted"><span>金鑰</span> <code data-u>${esc(p.key)}</code></small>`:`<div class="row2"><input type="password" autocomplete="off" data-genk="${k}" placeholder="API key" aria-label="API key"><button type="button" class="btn sm" data-gensave="${k}">儲存</button><a class="ghost sm" href="${esc(p.site)}" target="_blank" rel="noopener">取得金鑰</a></div>`}</div>
    <div class="mv-acts">${p.key?`<button type="button" class="ghost sm danger" data-gendel="${k}">移除</button>`:''}</div></div>`).join('')+
    '<p class="hmuted">填了金鑰，所有機器人都會學會「產生圖片」或「產生影片」的技能（可以在「已學會的技能」改成只給某些機器人）。做出來的圖片和影片會存在機器人的「輸出」資料夾，直接出現在對話裡。價格是大約的，以各服務的帳單為準。</p>';
  el.onclick=async e=>{const t=e.target;
    const s=t.closest('[data-gensave]');if(s){const k=s.dataset.gensave,v=el.querySelector(`[data-genk="${k}"]`).value.trim();if(!v)return;try{await api('gen-keys','POST',{provider:k,secret:v});toast(I18N.t('已儲存 ✓'));SEC.skills()}catch(x){toast(x.message)}return}
    const g=t.closest('[data-gendel]');if(g){try{await api('gen-keys/'+g.dataset.gendel,'DELETE');toast(I18N.t('已移除'));SEC.skills()}catch(x){toast(x.message)}}}}
