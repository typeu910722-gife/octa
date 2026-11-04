/* OCTA web app — the sidebar: conversations by 分區, pins, approvals, search, drag and drop, row menus. */
'use strict';
let FOLDED=new Set();try{FOLDED=new Set(JSON.parse(store.get('octa_folded')||'[]'))}catch(e){}
const gStack=(g,live)=>{const ms=g.members.filter(bot).slice(0,3);return ms.length?`<span class="gst" aria-hidden="true">${ms.map(id=>`<span class="gsa">${avOf(id,live)}</span>`).join('')}</span>`:ic('users')};
function listTag(id){return apprWait(id)?'<i class="need ap">待你核准</i>':needsYou(id)?'<i class="need">待你處理</i>':cur!==id&&unread(id)?`<i class="ub">${unread(id)}</i>`:''}
// 4.7: a working bot's row says how far it is (「工作中… 2/5」, 已暫停) with a thin bar along its bottom
function runLine(id,st){const x=runOf(id),v=x&&progView(x.progress),n=v?.has?` <b class="lstep">${v.step}/${v.total}</b>`:'';
  return (x&&pauseOf(x)==='paused'?'<span>已暫停</span>':esc(I18N.t(STATE_LABEL[st]))+'…')+n}
function runBar(id){const x=runOf(id),v=x&&progView(x.progress);return v?.has?`<i class="lbar" aria-hidden="true"><i style="width:${v.pct}%"></i></i>`:''}
// a bot's face moves only while it is doing something (many rows: the idle ones stay still)
function rowHtml(c){const g=isG(c.id),on=cur===c.id,muted=(S.mute||{})[c.id],st=g?'':stateOf(c.id);
  return `<div class="iw" draggable="true" data-drag="${c.id}" data-dragname="${esc(c.name)}" data-dropbot="${c.id}"><button class="item${on?' on':''}" data-id="${c.id}"${on?' aria-current="true"':''}>
    <span class="av${g?' grp':''}" data-u${st&&st!=='idle'?` title="${esc(I18N.t(STATE_LABEL[st]))}"`:''}>${g?gStack(c,true):avOf(c.id,true)}</span>
    <span class="t"><span class="l1"><b data-u>${esc(c.name)}</b>${muted?`<span class="mut" title="已關閉通知">${ic('belloff')}</span>`:''}<span class="tm">${listTime(c.id)}</span></span><span class="l2">${st&&st!=='idle'&&!apprWait(c.id)?`<small class="lw">${runLine(c.id,st)}</small>`:`<small data-u>${esc(preview(c.id))}</small>`}${listTag(c.id)}</span></span>
  ${st&&st!=='idle'?runBar(c.id):''}</button><button class="more" data-more="${c.id}" aria-label="更多">${ic('more')}</button></div>`}
function renderList(){
  if(VIA())paintVia();   // a remote control (4.3): which computer it controls, and whether it is connected
  else{$('online').classList.toggle('on',!!S.runnerOnline);
  $('onlineT').textContent=I18N.t(S.runnerOnline?'電腦在線':'電腦離線');
  $('online').title=I18N.t(S.runnerOnline?'機器人在這台電腦上工作中':'電腦上的 OCTA 沒有在執行，訊息會先排隊')}
  let h='';
  if(!S.loaded)h+=`<div class="empty fade">載入中…</div>`;
  const q=($('q')?.value||'').trim().toLowerCase(),hit=x=>!q||x.name.toLowerCase().includes(q)||(x.task||'').toLowerCase().includes(q);
  const pins=S.pins||[],pinned=id=>pins.includes(id);
  // everything waiting for your 核准, at the top of the list: one tap goes to the next one
  const aps=S.loaded?apprConvs():[];
  if(aps.length&&!q){const go=aps.find(x=>x.id!==cur)||aps[0];
    h+=`<button type="button" class="apbar" data-apgo="${esc(go.id)}"><span class="apn">${aps.length}</span><span class="apl"><b>件待你核准</b><small data-u>${esc(aps.map(x=>x.name).join('、'))}</small></span>${ic('chev','sa')}</button>`}
  const sect=(f,title)=>{const gs=S.groups.filter(g=>(g.folder||null)===f&&hit(g)&&!pinned(g.id)),bs=S.bots.filter(b=>(b.folder||null)===f&&hit(b)&&!pinned(b.id));
    if((!f||q)&&!gs.length&&!bs.length)return '';
    const key=f||'_',closed=!q&&FOLDED.has(key);
    return `<div class="fold${closed?' closed':''}" data-drop="${f||''}"><div class="sec"><button type="button" class="sect" data-fold="${esc(key)}" aria-expanded="${!closed}">${ic('chev','chv')}<span${f?' data-u':''}>${esc(title)}</span><span class="cnt">${gs.length+bs.length}</span></button>${f?`<button class="more" data-folder="${f}" aria-label="分區選項">${ic('more')}</button>`:''}</div>`+
      (closed?'':gs.length||bs.length?gs.map(rowHtml).join('')+bs.map(rowHtml).join(''):'<div class="empty">這裡還沒有人。把機器人拖進來。</div>')+'</div>'};
  const pg=S.groups.filter(g=>pinned(g.id)&&hit(g)),pb=S.bots.filter(b=>pinned(b.id)&&hit(b));
  if(pg.length||pb.length)h+=`<div class="fold"><div class="sec"><span class="sect st">${ic('pin','chv')}<span>置頂</span></span></div>`+pg.map(rowHtml).join('')+pb.map(rowHtml).join('')+'</div>';
  S.folders.forEach(f=>h+=sect(f.id,f.name));
  h+=sect(null,S.folders.length?'未分區':'機器人');
  if(S.loaded&&!S.bots.length&&!S.groups.length&&!q)h+=`<div class="empty">還沒有機器人。按右上角的 ＋ 建立一個。</div>`;
  if(q&&!h.includes('class="iw"'))h+=`<div class="empty">找不到「${esc(q)}」</div>`;
  if(!q&&(S.codeTasks||[]).length)h+=`<div class="fold"><div class="sec"><span class="sect st">${ic('code','chv')}<span>程式任務</span></span></div>`+(S.codeTasks||[]).map(t=>`<button type="button" class="item" data-code="${esc(t.id)}"><span class="av">${ic('code')}</span><span class="t"><span class="l1"><b data-u>${esc(t.title)}</b></span><span class="l2"><small>${esc(t.status)} · ${esc(t.engine)}${t.model?' / '+esc(t.model):''}</small></span></span></button>`).join('')+'</div>';
  setHTML($('list'),h);
  const tot=[...S.bots,...S.groups].reduce((a,x)=>a+(x.id===cur&&!document.hidden?0:unread(x.id)),0);document.title=(aps.length?`✅${aps.length} `:'')+(tot?`(${tot}) `:'')+'OCTA 奧克塔'}

$('list').onclick=e=>{
  const fo=e.target.closest('[data-fold]');if(fo){const k=fo.dataset.fold;FOLDED.has(k)?FOLDED.delete(k):FOLDED.add(k);store.set('octa_folded',JSON.stringify([...FOLDED]));renderList();return}
  const mo=e.target.closest('[data-more]');if(mo){e.stopPropagation();itemMenu(mo,mo.dataset.more);return}
  const fm=e.target.closest('[data-folder]');if(fm){e.stopPropagation();folderMenu(fm,fm.dataset.folder);return}
  const ct=e.target.closest('[data-code]');if(ct){openCode(ct.dataset.code);return}
  const ag=e.target.closest('[data-apgo]');if(ag){goAsk(ag.dataset.apgo);return}
  const it=e.target.closest('.item');if(!it)return;openConv(it.dataset.id)};
/* search: Ctrl/⌘+K anywhere, Enter opens the first match, Esc clears */
$('qKbd').textContent=/Mac|iPhone|iPad/.test(navigator.platform)?'⌘K':'Ctrl K';
$('q').addEventListener('input',()=>renderList());
$('q').addEventListener('keydown',e=>{if(e.key==='Enter'){const f=$('list').querySelector('.item[data-id]');if(f){openConv(f.dataset.id);$('q').value='';renderList()}}if(e.key==='Escape'){$('q').value='';renderList();$('q').blur()}});
function focusSearch(){$('app').classList.remove('chat');focusBrowser();$('q').focus();$('q').select()}

/* ---------- drag and drop: a bot into a group or a 分區, a message or files onto another chat ---------- */
let draggingId='',draggingMsg=null,dragDepth=0;
function clearDrop(){$('list').querySelectorAll('.dragging,.over').forEach(n=>{n.classList.remove('dragging','over');n.removeAttribute('data-hint')})}
document.addEventListener('dragstart',e=>{
  if(e.target.closest?.('.more')||lpHit){e.preventDefault();return}
  const row=e.target.closest?.('[data-drag]');
  if(row){draggingId=row.dataset.drag;draggingMsg=null;e.dataTransfer.setData('application/x-octa-conv',row.dataset.drag);e.dataTransfer.setData('text/plain','@'+row.dataset.dragname);e.dataTransfer.effectAllowed='copyMove';row.classList.add('dragging');return}
  const bub=e.target.closest?.('[data-dragmsg]');
  if(!bub)return;
  const mid=bub.closest('[data-mid]')?.dataset.mid;
  const m=convMsgs(cur).find(x=>String(x.id)===String(mid));
  if(!m||m.tmp){e.preventDefault();return}
  draggingMsg={id:m.id,conv:cur,text:m.text||'',files:(m.files||[]).map(f=>({id:f.id,name:f.name,mime:f.mime}))};
  draggingId='';
  e.dataTransfer.setData('application/x-octa-msg',String(m.id));
  e.dataTransfer.setData('text/plain',(m.text||'').trim());
  e.dataTransfer.effectAllowed='copy';
});
document.addEventListener('dragend',()=>{draggingId='';draggingMsg=null;dragDepth=0;$('pane').classList.remove('drop','droptext');clearDrop()});
function markRow(el,hint){if(!el)return;el.classList.add('over');el.dataset.hint=I18N.t(hint)}
$('list').addEventListener('dragover',e=>{
  const botEl=e.target.closest('[data-dropbot]');
  const zone=e.target.closest('[data-drop], [data-dropbot]');
  const types=[...e.dataTransfer.types];
  if(draggingMsg){
    if(!botEl||botEl.dataset.dropbot===draggingMsg.conv)return;
    e.preventDefault();e.dataTransfer.dropEffect='copy';
    $('list').querySelectorAll('.iw.over').forEach(n=>{if(n!==botEl){n.classList.remove('over');n.removeAttribute('data-hint')}});
    markRow(botEl,'複製到這裡');return}
  if(draggingId&&botEl&&isG(botEl.dataset.dropbot)&&bot(draggingId)){
    e.preventDefault();e.dataTransfer.dropEffect='copy';
    markRow(botEl,'加入群組');return}
  if(!zone)return;
  if(!draggingId&&!types.includes('application/x-octa-conv')&&!types.includes('Files'))return;
  e.preventDefault();
  e.dataTransfer.dropEffect=types.includes('Files')?'copy':'move';
  if(types.includes('Files')&&botEl)markRow(botEl,'傳給這裡');
  else (e.target.closest('.fold')||zone).classList.add('over');
});
$('list').addEventListener('dragleave',e=>{
  const zone=e.target.closest('.fold');if(zone&&!zone.contains(e.relatedTarget))zone.classList.remove('over');
  const row=e.target.closest('.iw');if(row&&!row.contains(e.relatedTarget)){row.classList.remove('over');row.removeAttribute('data-hint')}
});
$('list').addEventListener('drop',async e=>{
  const botEl=e.target.closest('[data-dropbot]');
  const target=botEl?.dataset.dropbot||'';
  const msg=draggingMsg;
  clearDrop();
  if(msg&&target&&target!==msg.conv){e.preventDefault();askCopy(target,{...msg,files:(msg.files||[]).map(f=>({...f}))});return}
  if(draggingId&&target&&isG(target)&&bot(draggingId)){e.preventDefault();joinGroup(draggingId,target);return}
  const files=[...e.dataTransfer.files];
  if(files.length&&botEl){e.preventDefault();askSendFiles(target,files);return}
  const zone=e.target.closest('[data-drop]');
  const id=e.dataTransfer.getData('application/x-octa-conv')||draggingId;
  if(!zone||!id)return;
  e.preventDefault();
  const folder=zone.dataset.drop||null;
  const c=conv(id);
  if((c?.folder||null)===(folder||null))return;
  try{await api('move','POST',{id,folder});toast(I18N.t(folder?'已拖進這個分區':'已移回未分區'));refresh()}catch(err){toast(err.message)}
});
async function joinGroup(botId,groupId){
  const g=S.groups.find(x=>x.id===groupId),b=bot(botId);if(!g||!b)return;
  if(g.members.includes(botId)){toast(I18N.t('已經在這個群組'));return}
  try{await api('groups/'+groupId,'PUT',{name:g.name,task:g.task||'',members:[...g.members,botId],folder:g.folder||null});
    toast('「'+b.name+'」'+I18N.t('已加入')+'「'+g.name+'」');await refresh()}catch(err){toast(err.message)}}
function askCopy(targetId,msg){
  const target=conv(targetId);if(!target||!msg)return;
  const who=esc(target.name);
  const pv=esc((msg.text||'').replace(/\s+/g,' ').trim().slice(0,80)||I18N.t('（沒有文字）'));
  const extra=msg.files?.length?`<span>，含</span> ${msg.files.length} <span>個圖片或檔案</span>`:'';
  openSheet(`${sheetHead('確定要複製？')}
    <p><span>複製到</span>「<b data-u>${who}</b>」${extra}<span>。那邊會開始處理這則。</span></p>
    <blockquote class="quote" data-u>${pv}</blockquote>
    <p class="hmuted"><span>「複製並蓋掉原本的訊息」會把這邊這一則刪掉，只留在</span>「<span data-u>${who}</span>」。</p>
    <div class="errmsg" id="cfE"></div>
    <div class="acts"><button type="button" class="ghost" id="sx">取消</button><button type="button" class="ghost danger" id="cfOver">複製並蓋掉原本的訊息</button><button type="button" class="btn" id="cfKeep">複製</button></div>`,'sm');
  $('sx').onclick=closeSheet;
  const go=replace=>async()=>{$('cfKeep').disabled=$('cfOver').disabled=true;
    try{await copyDropped(targetId,msg,replace);closeSheet()}catch(e){$('cfE').textContent=e.message;$('cfKeep').disabled=$('cfOver').disabled=false}};
  $('cfKeep').onclick=go(false);$('cfOver').onclick=go(true)}
async function copyDropped(targetId,msg,replace){
  await api('messages/copy','POST',{to:targetId,from:msg.conv,id:msg.id,replace:!!replace});
  if(replace&&MSG[msg.conv])MSG[msg.conv].list=MSG[msg.conv].list.filter(m=>String(m.id)!==String(msg.id));
  toast(I18N.t(replace?'已複製，原本的訊息已蓋掉':'已複製'));
  await refresh();
  if(MSG[targetId]?.loaded)await loadMsgs(targetId,'new');
  if(cur===targetId||cur===msg.conv)render(true)}
function askSendFiles(targetId,files){
  const target=conv(targetId);if(!target)return;
  const list=[...files].slice(0,6);
  confirmSheet('確定要複製？',`<p><span>要把</span> ${list.length} <span>個檔案傳給</span>「<b data-u>${esc(target.name)}</b>」？<span>那邊會開始處理。</span></p>`,'複製過去',false,()=>sendFilesTo(targetId,list))}
async function sendFilesTo(convId,list){
  const ids=[];
  for(const file of list){const {body}=await filePayload(file,convId);const r=await api('files','POST',body);ids.push(r.id)}
  if(!ids.length)return;
  await api('messages','POST',{conv:convId,text:'',files:ids});
  toast(I18N.t('已複製過去'));await refresh();
  if(MSG[convId]?.loaded)await loadMsgs(convId,'new');
  if(cur===convId)render(true)}

/* ---------- row menus ---------- */
holdOn($('list'),t=>t.closest('.iw[data-drag]'),(row,e)=>itemMenu(e?pointAnchor(e.clientX,e.clientY):row.querySelector('.more')||row,row.dataset.drag));
async function togglePin(id){const p=S.pins||[];await api('settings','PUT',{pins:p.includes(id)?p.filter(x=>x!==id):[id,...p]});await refresh()}
async function toggleMute(id){const was=!!(S.mute||{})[id];await api('settings','PUT',{mute:{bot:id,on:!was}});toast(I18N.t(was?'已開啟通知':'已關閉通知'));await refresh()}
function moveMenuHtml(c){return `<div class="lab">移到分區</div>${S.folders.map(f=>mi('mv',c.folder===f.id?'check':'',`<span data-u>${esc(f.name)}</span>`,f.id)).join('')}${mi('mv',!c.folder?'check':'','未分區','')}<hr>${mi('nf','plus','建立分區並移入')}`}
function itemMenu(anchor,id){const c=conv(id);if(!c)return;const g=isG(id),pin=(S.pins||[]).includes(id),mute=!!(S.mute||{})[id];
  popMenu(anchor,`${mi('ed','panel','詳細資料')}${mi('pin','pin',pin?'取消置頂':'置頂')}${mi('mute',mute?'bell':'belloff',mute?'開啟通知':'關閉通知')}<hr>${moveMenuHtml(c)}<hr>
    ${g?'':mi('dup','copy','複製這個機器人')}${g?'':mi('cmp','compress','壓縮對話（省額度）')}${mi('clr','eraser','清空對話紀錄')}${mi('del','trash',g?'刪除群組':'刪除機器人','','danger')}`,
   {mv:async v=>{await api('move','POST',{id,folder:v||null});refresh()},
    nf:()=>folderSheet(null,id),
    cmp:()=>compactConv(id),clr:()=>clearConv(id),del:()=>deleteConv(id),dup:()=>dupBot(id),
    pin:()=>togglePin(id),mute:()=>toggleMute(id),
    ed:()=>{if(cur!==id)openConv(id);openDetail()}})}
function folderMenu(anchor,fid){
  popMenu(anchor,`${mi('rn','edit','分區名稱與資料')}${mi('del','trash','刪除分區（內容移到未分區）','','danger')}`,
   {rn:()=>folderSheet(fid),del:()=>confirmSheet('刪除分區',`<p>分區裡的機器人和群組會移到「未分區」，不會被刪除。</p>`,'刪除分區',true,async()=>{await api('folders/'+fid,'DELETE');refresh()})})}
function folderSheet(fid,moveId){const f=fid&&S.folders.find(x=>x.id===fid);
  $('veil').innerHTML=`<form class="sheet" id="ff">${sheetHead(f?'分區名稱與資料':'建立分區','分區用來區隔不同門市或專案。同一個分區的機器人可以互相詢問、協作；不同分區互不干擾。')}
  <label class="field"><span>分區名稱</span><input id="fn" required maxlength="20" value="${f?esc(f.name):''}" placeholder="例如：台南店、高雄店"></label>
  <label class="field"><span>分區資料（這個分區的機器人都會讀）</span><textarea id="fnotes" maxlength="20000" placeholder="例如：房號清單、門鎖密碼規則、停車說明、入住訊息範本、試算表連結">${f?esc(f.notes||''):''}</textarea></label>
  <div class="errmsg" id="fe"></div><div class="acts"><span class="dflag" data-dirty-flag hidden>有未儲存的變更</span><button type="button" class="ghost" id="sx">取消</button><button class="btn">${f?'儲存':'建立'}</button></div></form>`;
  $('veil').hidden=false;$('fn').focus();$('sx').onclick=closeSheet;
  const save=async()=>{if(!$('fn').value.trim()){$('fe').textContent=I18N.t('請填分區名稱');$('fn').focus();return false}
    try{if(f)await api('folders/'+fid,'PUT',{name:$('fn').value,notes:$('fnotes').value});
      else{const r=await api('folders','POST',{name:$('fn').value,notes:$('fnotes').value});if(moveId)await api('move','POST',{id:moveId,folder:r.id})}
      cleanDirty();refresh();return true}catch(err){$('fe').textContent=err.message;return false}};
  trackDirty($('ff'),save);
  $('ff').onsubmit=async e=>{e.preventDefault();if(await save()){closeSheet(true);toast(I18N.t(f?'已儲存 ✓':'已建立'))}}}
/* ＋: a new bot (just a name), a group, a 分區, or ready-made templates */
function plusMenuTop(anchor){popMenu(anchor,`${mi('nb','bot','新機器人')}${mi('ng','users','新群組')}${mi('nf','folder','新分區')}<hr>${mi('tpl','sparkle','從範本建立…')}`,
  {nb:()=>newBotSheet(),ng:()=>groupSheet(),nf:()=>folderSheet(null),tpl:()=>tplSheet()})}
$('plus').onclick=e=>{e.stopPropagation();plusMenuTop($('plus'))};
