/* OCTA web app — 4.7「它記得什麼」: one page per bot with everything it keeps — 📌 rules, 📇 facts, 📘 manuals,
   🧩 skills, 一律允許 — and one for what all bots share (共用資料, 分區資料, 🗺️ site notes). Search, edit in place,
   delete, add; each item says who set it and when. */
'use strict';
const MV={id:null,data:null,q:'',edit:null};
const MV_KINDS=[['rule','📌','規則','它被糾正或學到的做法，每次工作都會照做。'],['fact','📇','事實','固定的資料，例如名單、網址、帳號名稱。'],['manual','📘','做事手冊','做完多步驟的工作後寫下的流程，做類似的事時會照著做。'],
  ['skill','🧩','技能','存起來可以再叫它做的流程，輸入 / 叫用。'],['allow','✅','一律允許','做這些事不會再問你。']];
const MV_SRC={user:'你設定的',bot:'機器人自己記的',hook:'外部 AI 教的（交接網址）',fix:'你糾正後核准的',review:'每週自我檢討，你核准的',tpl:'範本預設',old:'來源不明（舊資料）',github:'從 GitHub 學的，你核准的',trusted:'從信任的 GitHub 來源自動學的',catalog:'OCTA 內建'};
const mvNamed=k=>k==='manual'||k==='skill';
function openMemory(id,back){
  MV.id=id||'shared';MV.q='';MV.edit=null;MV.data=null;
  const opts=[...S.bots.map(b=>`<option value="${esc(b.id)}" data-u ${b.id===MV.id?'selected':''}>${esc(b.name)}</option>`),`<option value="shared" ${MV.id==='shared'?'selected':''}>${esc(I18N.t('共用資料（所有機器人）'))}</option>`].join('');
  $('veil').innerHTML=`<div class="sheet page memv" role="dialog" aria-modal="true" aria-label="它記得什麼"><div class="shd"><h2>它記得什麼</h2><button type="button" class="ib x" data-close aria-label="關閉">${ic('x')}</button></div>
    <div class="mv-bar"><select id="mvWho" aria-label="看誰的記憶">${opts}</select><label class="sbox mv-q"><span class="si" aria-hidden="true">${ic('search')}</span><input id="mvQ" type="search" placeholder="搜尋記憶" autocomplete="off" aria-label="搜尋記憶"></label></div>
    <div class="mv-body" id="mvBody"><div class="empty fade">載入中…</div></div></div>`;
  $('veil').hidden=false;paintIcons($('veil'));
  pageBack=back||null;
  $('mvWho').onchange=e=>{MV.id=e.target.value;MV.edit=null;loadMemory()};
  $('mvQ').oninput=e=>{MV.q=e.target.value.trim().toLowerCase();paintMemory()};
  $('mvBody').onclick=mvClick;$('mvBody').onsubmit=mvSubmit;
  loadMemory()}
async function loadMemory(){const id=MV.id;
  try{const d=await api('memview?id='+encodeURIComponent(id));if(MV.id!==id||!$('mvBody'))return;MV.data=d;paintMemory()}
  catch(e){if($('mvBody'))setHTML($('mvBody'),`<div class="empty">${esc(e.message)}</div>`)}}
const mvHit=(...t)=>!MV.q||t.some(x=>String(x||'').toLowerCase().includes(MV.q));
function mvSrc(it){return `<small class="mv-src${it.by==='old'?' old':''}"><span>${MV_SRC[it.by]||MV_SRC.bot}</span>${it.ts?` · <span data-u>${esc(when(it.ts))}</span>`:''}</small>`}
function mvItem(kind,it,owner){const named=mvNamed(kind),key=named?it.name:it.text,editing=MV.edit&&MV.edit.kind===kind&&MV.edit.key===key&&MV.edit.owner===owner;
  if(editing)return `<form class="mv-it ed" data-kind="${kind}" data-key="${esc(key)}" data-owner="${esc(owner)}">${named?`<input name="name" maxlength="40" value="${esc(it.name)}" aria-label="名稱"><textarea name="steps" rows="4" maxlength="${kind==='skill'?3000:1500}" aria-label="步驟">${esc(it.steps)}</textarea>`:`<textarea name="text" rows="2" maxlength="${kind==='allow'?120:300}" aria-label="內容">${esc(it.text)}</textarea>`}
    <div class="mv-acts"><button type="button" class="ghost sm" data-mvx>取消</button><button class="btn sm">儲存</button></div></form>`;
  return `<div class="mv-it" data-kind="${kind}" data-key="${esc(key)}" data-owner="${esc(owner)}"><div class="mv-tx">${named?`<b data-u>${esc(it.name)}</b><p data-u class="mv-steps">${esc(it.steps)}</p>`:`<p data-u>${esc(it.text)}</p>`}${mvSrc(it)}</div>
    <div class="mv-acts"><button type="button" class="ib sm" data-mved aria-label="編輯" title="編輯">${ic('edit')}</button><button type="button" class="ib sm" data-mvdel aria-label="刪除" title="刪除">${ic('trash')}</button></div></div>`}
function mvAdd(kind,owner){const named=mvNamed(kind);
  return `<form class="mv-add" data-kind="${kind}" data-owner="${esc(owner)}" data-add>${named?`<input name="name" maxlength="40" placeholder="名稱" aria-label="名稱"><textarea name="steps" rows="2" maxlength="${kind==='skill'?3000:1500}" placeholder="步驟（例如：1. 打開後台 2. 匯出 3. 寄給我）" aria-label="步驟"></textarea>`:`<input name="text" maxlength="${kind==='allow'?120:300}" placeholder="${esc(I18N.t({rule:'例如：回覆客人要用敬語',fact:'例如：後台網址是 https://…',allow:'例如：在 OCTA 對話裡發提醒',site:'例如：訂單在左邊選單的「訂單管理」'}[kind]||''))}" aria-label="新增">`}<button class="ghost sm">${ic('plus')}<span>加入</span></button></form>`}
function paintMemory(){const d=MV.data,box=$('mvBody');if(!d||!box)return;let h='',shown=0;
  if(d.bot){const b=d.bot;
    h+=`<div class="mv-hero"><span class="av xl" data-u>${avOf(b.id,'always')}</span><div><b data-u>${esc(b.name)}</b>${b.task?`<p class="hmuted" data-u>${esc(b.task.slice(0,200))}</p>`:'<p class="hmuted">還沒有指定任務</p>'}</div></div>`;
    for(const [k,emo,title,desc] of MV_KINDS){const list=(d.items[k]||[]).filter(it=>mvHit(it.text,it.name,it.steps));shown+=list.length;
      if(MV.q&&!list.length)continue;
      h+=`<section class="mv-sec" data-sec="${k}"><h3><span aria-hidden="true">${emo}</span> <span>${title}</span> <small data-u>${(d.items[k]||[]).length}</small></h3><p class="hmuted">${desc}</p>
        <div class="mv-list">${list.map(it=>mvItem(k,it,b.id)).join('')||'<p class="mv-none">還沒有</p>'}</div>${MV.q?'':mvAdd(k,b.id)}</section>`}
    h+=mvLearned(d,b);   // 4.12 學來的技能
    if(d.folder)h+=`<p class="hmuted mv-link"><span>它也會讀分區資料：</span><button type="button" class="link" data-mvshared><span data-u>${esc(d.folder.name)}</span></button></p>`;
    h+=`<p class="hmuted mv-link"><span>所有機器人都會讀的共用資料和網站筆記：</span><button type="button" class="link" data-mvshared>共用資料（所有機器人）</button></p>`}
  else{const sh=d.shared;
    h+=`<section class="mv-sec"><h3><span aria-hidden="true">📒</span> <span>共用資料</span></h3><p class="hmuted">每個機器人工作時都會讀這段，例如店名、營業時間、常用網址。</p>
      <form class="mv-notes" data-notes=""><textarea name="notes" rows="5" maxlength="20000">${esc(sh.notes)}</textarea><div class="mv-acts"><button class="btn sm">儲存</button></div></form></section>`;
    for(const f of d.folders||[])if(mvHit(f.name,f.notes))h+=`<section class="mv-sec"><h3><span aria-hidden="true">🗂️</span> <span>分區資料</span> <small data-u>${esc(f.name)}</small></h3><p class="hmuted">這個分區的機器人都會讀。</p>
      <form class="mv-notes" data-notes="${esc(f.id)}"><textarea name="notes" rows="4" maxlength="20000">${esc(f.notes)}</textarea><div class="mv-acts"><button class="btn sm">儲存</button></div></form></section>`;
    const sites=sh.sites.map(s=>({...s,items:s.items.filter(it=>mvHit(s.domain,it.text))})).filter(s=>s.items.length||!MV.q);shown+=sites.length;
    h+=`<section class="mv-sec" data-sec="site"><h3><span aria-hidden="true">🗺️</span> <span>網站筆記</span> <small data-u>${sh.sites.reduce((a,s)=>a+s.items.length,0)}</small></h3><p class="hmuted">機器人在網站上摸索出來的做法，所有機器人共用。</p>
      ${sites.map(s=>`<div class="mv-site"><b class="mono" data-u>${esc(s.domain)}</b><div class="mv-list">${s.items.map(it=>mvItem('site',it,s.domain)).join('')}</div>${MV.q?'':mvAdd('site',s.domain)}</div>`).join('')||'<p class="mv-none">還沒有</p>'}
      ${MV.q?'':`<form class="mv-add" data-kind="site" data-owner="" data-add><input name="domain" maxlength="60" placeholder="網站，例如 shop.example.com" aria-label="網站"><input name="text" maxlength="300" placeholder="${esc(I18N.t('例如：訂單在左邊選單的「訂單管理」'))}" aria-label="新增"><button class="ghost sm">${ic('plus')}<span>加入</span></button></form>`}</section>`}
  if(MV.q&&!shown)h+=`<div class="empty"><span>找不到「</span><span data-u>${esc(MV.q)}</span><span>」</span></div>`;
  setHTML(box,h);paintIcons(box);
  const ed=box.querySelector('.mv-it.ed textarea,.mv-it.ed input');if(ed)ed.focus()}
// 4.12: skills learned from GitHub or built in — source and version, how they reach this bot's AI, 更新／移除／給其他機器人
function mvLearned(d,b){const list=(d.items.lskill||[]).filter(it=>mvHit(it.name,it.desc,it.repo));if(MV.q&&!list.length)return '';
  const others=(d.bots||[]).filter(x=>x.id!==b.id);
  return `<section class="mv-sec" data-sec="lskill"><h3><span aria-hidden="true">🧠</span> <span>學來的技能</span> <small data-u>${(d.items.lskill||[]).length}</small></h3><p class="hmuted">從 GitHub 學的或 OCTA 內建的技能。做相關的工作時會照它做。</p>
    <div class="mv-list">${list.map(it=>`<div class="mv-it" data-ls="${esc(it.name)}"><div class="mv-tx"><b data-u>${esc(it.name)}</b><p data-u class="mv-steps">${esc(it.desc||'')}</p>
      <div class="mv-ls">${it.url?`<a href="${esc(it.url)}" target="_blank" rel="noopener" class="pill" data-u>${esc(it.repo||'')}@${esc(it.ver)}</a>`:`<span class="pill">${esc(I18N.t('OCTA 內建'))}</span>`}${it.scripts?` <span class="pill warn"><span>含程式</span> <span data-u>${it.scripts}</span></span>`:''} <small class="hmuted" data-u>${esc(it.where||'')}</small></div>${mvSrc(it)}</div>
      <div class="mv-acts">${it.src==='github'?`<button type="button" class="ghost sm" data-lsupd="${esc(it.name)}">更新</button>`:''}<button type="button" class="ib sm" data-lsdel="${esc(it.name)}" aria-label="從這個機器人移除" title="從這個機器人移除">${ic('trash')}</button></div></div>`).join('')||'<p class="mv-none">還沒有。說「去 GitHub 學 pdf」，它會找適合自己的技能給你核准。</p>'}</div>
    ${list.length&&others.length&&!MV.q?`<div class="row2 mv-add"><select data-lsname aria-label="技能">${list.map(it=>`<option value="${esc(it.name)}" data-u>${esc(it.name)}</option>`).join('')}</select><select data-lsto aria-label="給哪個機器人">${others.map(x=>`<option value="${esc(x.id)}" data-u>${esc(x.name)}</option>`).join('')}</select><button type="button" class="ghost sm" data-lsadd>也給它</button></div>`:''}</section>`}
async function mvLs(e){const t=e.target,d=MV.data,b=d?.bot;if(!b)return false;
  const it=n=>(d.items.lskill||[]).find(x=>x.name===n);
  const u=t.closest('[data-lsupd]');if(u){u.disabled=true;try{const r=await api('skills/update','POST',{name:u.dataset.lsupd});toast(r.text||I18N.t('有新版本，核准卡在對話裡'))}catch(x){toast(x.message)}u.disabled=false;return true}
  const del=t.closest('[data-lsdel]');if(del){const s=it(del.dataset.lsdel);if(!s)return true;
    confirmIn(del.closest('.mv-it'),async()=>{const all=(d.bots||[]).map(x=>x.id),cur=s.bots===null?all:s.bots,rest=cur.filter(x=>x!==b.id);
      try{if(rest.length)await api('skills/assign','POST',{name:s.name,bots:rest});else await api('skills/'+encodeURIComponent(s.name),'DELETE');toast(I18N.t('已移除'));loadMemory()}catch(x){toast(x.message)}});return true}
  if(t.closest('[data-lsadd]')){const sec=t.closest('.mv-sec'),s=it(sec.querySelector('[data-lsname]').value),to=sec.querySelector('[data-lsto]').value;if(!s)return true;
    if(s.bots===null){toast(I18N.t('所有機器人都已經有了'));return true}
    try{await api('skills/assign','POST',{name:s.name,bots:[...new Set([...s.bots,to])]});toast(I18N.t('已儲存 ✓'));loadMemory()}catch(x){toast(x.message)}return true}
  return false}
async function mvSave(body){try{await api('memview/item','POST',body);toast(I18N.t('已儲存 ✓'));MV.edit=null;await loadMemory();refresh();return true}catch(e){toast(e.message);return false}}
function mvClick(e){if(e.target.closest('[data-lsupd],[data-lsdel],[data-lsadd]')){mvLs(e);return}const it=e.target.closest('.mv-it');
  if(e.target.closest('[data-mvshared]')){$('mvWho').value='shared';MV.id='shared';MV.edit=null;loadMemory();return}
  if(e.target.closest('[data-mvx]')){MV.edit=null;paintMemory();return}
  if(!it)return;const kind=it.dataset.kind,key=it.dataset.key,owner=it.dataset.owner;
  if(e.target.closest('[data-mved]')){MV.edit={kind,key,owner};paintMemory();return}
  if(e.target.closest('[data-mvdel]'))confirmIn(it,()=>mvSave({kind,op:'del',old:key,...(kind==='site'?{domain:owner}:{bot:owner})}))}
// delete asks once, in place (no second sheet over this page)
function confirmIn(row,go){if(row.querySelector('.mv-sure'))return;const s=document.createElement('div');s.className='mv-sure';
  s.innerHTML=`<span>要刪除這一項嗎？</span><button type="button" class="ghost sm" data-n>取消</button><button type="button" class="ghost sm danger" data-y>刪除</button>`;row.appendChild(s);
  s.onclick=ev=>{ev.stopPropagation();if(ev.target.closest('[data-y]'))go();else if(ev.target.closest('[data-n]'))s.remove()}}
async function mvSubmit(e){e.preventDefault();const f=e.target,v=n=>f.elements[n]?.value??'';
  if(f.matches('[data-notes]')){const btn=f.querySelector('button');btn.disabled=true;
    try{await api('memview/notes','PUT',{folder:f.dataset.notes||null,notes:v('notes')});toast(I18N.t('已儲存 ✓'));refresh()}catch(x){toast(x.message)}btn.disabled=false;return}
  const kind=f.dataset.kind,owner=f.dataset.owner||v('domain'),named=mvNamed(kind);
  const body={kind,op:f.hasAttribute('data-add')?'add':'edit',...(kind==='site'?{domain:owner}:{bot:owner}),...(named?{name:v('name'),steps:v('steps')}:{text:v('text')})};
  if(body.op==='edit')body.old=f.dataset.key;
  f.querySelectorAll('button').forEach(b=>b.disabled=true);
  if(!(await mvSave(body)))f.querySelectorAll('button').forEach(b=>b.disabled=false)}
