/* OCTA web app — the message box: drafts, 傳給, @ and / menus, attachments, sending. */
'use strict';
const draftKey=()=>'octa_draft_'+cur;
function saveDraft(){if(!cur)return;store.set(draftKey(),$('msg').value||null)}
function loadDraft(){$('msg').value=store.get(draftKey())||'';grow()}
/* 傳給：the chat (and, in a group, the @members) that gets what is in the box */
const TO={id:'',prev:'',at:0};
function sendTargets(id,text){const c=conv(id);if(!c)return null;if(!isG(id))return {c,names:[]};
  const v=String(text||'');return {c,names:c.members.map(bot).filter(b=>b&&v.includes('@'+b.name)).map(b=>b.name)}}
function paintTo(){const el=$('sendTo');if(!el)return;const t=cur&&sendTargets(cur,$('msg').value);if(!t){el.hidden=true;return}
  if(TO.id!==cur){TO.prev=TO.id;TO.id=cur;TO.at=Date.now()}
  el.hidden=false;el.dataset.to=cur;$('f').dataset.to=cur;const g=isG(cur);
  setHTML(el,`<span class="stl">傳給：</span><span class="av xs${g?' grp':''}"${g?'':' data-u'}>${g?ic('users'):avOf(cur)}</span><b data-u>${esc(t.c.name)}</b>${t.names.length?`<span class="stm" data-u>→ ${t.names.map(n=>'@'+esc(n)).join(' ')}</span>`:''}`)}
let pending=[];
// while it works and the box is empty, the send button is a stop button (like Claude); typing turns it back into 送出
function paintSend(){const f=$('f'),run=!!cur&&busyIn(cur).some(x=>x.status==='running'),on=run&&!$('msg').value.trim()&&!pending.length;
  if(f.classList.contains('stopping')===on)return;f.classList.toggle('stopping',on);$('sendBtn').setAttribute('aria-label',I18N.t(on?'停止':'送出'));$('sendBtn').title=on?I18N.t('停止目前的工作'):''}
function grow(){const t=$('msg');$('f').classList.toggle('empty',!t.value.trim()&&!pending.length);paintSend();if(!t.offsetParent){t.style.height='';return}t.style.height='auto';t.style.height=Math.min(Math.max(t.scrollHeight,24),200)+'px'}   // hidden (phone list view): measure later
$('msg').addEventListener('input',()=>{grow();clearTimeout(grow.t);grow.t=setTimeout(saveDraft,400);paintTo()});

/* "/" at the start: built-in actions, saved instructions and the bot's skills; "@" in a group: members */
let atSel=0;
function slashItems(){const c=conv(cur);if(!c)return [];const ids=isG(cur)?c.members:[cur];
  const items=[...(window.octaDesktop?[{k:'browser',t:'/瀏覽器',d:I18N.t('打開瀏覽器')},{k:'hide',t:'/收起瀏覽器',d:I18N.t('收到背景')}]:[{k:'browser',t:'/瀏覽器',d:I18N.t('看這個機器人的即時畫面')}]),{k:'stop',t:'/停止',d:I18N.t('停止目前的工作')},
    {k:'shots',t:'/歷史畫面',d:I18N.t('以前的截圖')},{k:'edit',t:'/詳細資料',d:I18N.t('名稱、任務、排程、記憶')},{k:'compact',t:'/壓縮對話',d:I18N.t('重點寫進記憶、刪舊訊息，省額度')},{k:'clear',t:'/清空對話',d:I18N.t('清空對話紀錄')}];
  if(phoneRemote())items.splice(1,0,{k:'url',t:'/網址',d:I18N.t('操控電腦上的網址')});
  for(const id of ids)for(const k of ((S.skills||{})[id]||[]))items.push({k:'skill',t:'/'+k.name,d:'🧩 '+(isG(cur)?bot(id)?.name+' · ':'')+I18N.t('技能'),v:k.name,b:id});
  ((S.quick||{})[cur]||[]).forEach(q=>items.push({k:'quick',t:'⚡ '+(q.length>30?q.slice(0,30)+'…':q),d:I18N.t('常用指令'),v:q}));
  return items}
function atList(){const i=$('msg'),c=conv(cur);if(!c)return null;const before=i.value.slice(0,i.selectionStart);
  const sl=before.match(/^\/(\S*)$/);if(sl){const q=sl[1].toLowerCase(),list=slashItems().filter(x=>x.t.toLowerCase().includes(q));return list.length?{slash:true,list}:null}
  if(!isG(cur))return null;const m=before.match(/@([^\s@]*)$/);if(!m)return null;
  const q=m[1].toLowerCase(),list=c.members.map(bot).filter(b=>b&&b.name.toLowerCase().includes(q));return list.length?{q:m[1],list}:null}
function atRender(){const a=atList(),p=$('atpop');if(!a){p.hidden=true;return}atSel=Math.min(atSel,a.list.length-1);
  if(a.slash){p.innerHTML=a.list.map((x,i)=>`<button type="button" class="${i===atSel?'on':''}" data-slash="${i}"><b data-u>${esc(x.t)}</b><small data-u>${esc(x.d)}</small></button>`).join('');p.hidden=false;return}
  p.innerHTML=a.list.map((b,i)=>`<button type="button" class="${i===atSel?'on':''}" data-pick="${esc(b.name)}"><span class="av xs" data-u>${avOf(b.id)}</span><span data-u>${esc(b.name)}</span></button>`).join('');p.hidden=false}
function atPick(name){const i=$('msg'),pos=i.selectionStart,before=i.value.slice(0,pos).replace(/@([^\s@]*)$/,'@'+name+' ');i.value=before+i.value.slice(pos);i.selectionStart=i.selectionEnd=before.length;$('atpop').hidden=true;grow();paintTo();i.focus()}
$('msg').addEventListener('input',()=>{atSel=0;atRender()});
$('msg').addEventListener('blur',()=>setTimeout(()=>$('atpop').hidden=true,150));
$('atpop').addEventListener('mousedown',e=>{const s2=e.target.closest('[data-slash]');if(s2){e.preventDefault();runSlash(slashItems().filter(x=>x.t.toLowerCase().includes(($('msg').value.slice(1)||'').toLowerCase()))[+s2.dataset.slash]);return}
  const b=e.target.closest('[data-pick]');if(b){e.preventDefault();atPick(b.dataset.pick)}});
function runSlash(x){if(!x)return;$('msg').value='';grow();$('atpop').hidden=true;const c=conv(cur);if(!c)return;const first=isG(cur)?c.members.find(bot):cur;
  ({browser:()=>phoneRemote()?remoteUrl(isG(cur)?c.members.filter(bot):[cur]):openBrowser(first),hide:()=>openBrowser(first,'',true),stop:()=>api('cancel','POST',{conv:cur}).then(()=>{toast(I18N.t('已停止'));refresh()}),
    url:()=>remoteUrl(isG(cur)?c.members.filter(bot):[cur]),
    shots:()=>shotSheet(isG(cur)?c.members.filter(bot):[cur]),edit:()=>openDetail(),clear:()=>clearConv(cur),compact:()=>compactConv(cur),
    skill:()=>sendMsg((isG(cur)?'@'+bot(x.b)?.name+' ':'')+'請執行技能「'+x.v+'」'),quick:()=>sendMsg(x.v)})[x.k]?.()}
function startSlash(){const i=$('msg');if(!i.value.startsWith('/'))i.value='/'+i.value;i.focus();i.selectionStart=i.selectionEnd=1;atSel=0;grow();atRender()}
$('slashBtn').onclick=startSlash;
$('msg').addEventListener('keydown',e=>{
  if(!$('atpop').hidden){const a=atList();if(a){
    if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();atSel=(atSel+(e.key==='ArrowDown'?1:-1)+a.list.length)%a.list.length;atRender();return}
    if((e.key==='Enter'||e.key==='Tab')&&!e.isComposing){e.preventDefault();a.slash?runSlash(a.list[atSel]):atPick(a.list[atSel].name);return}
    if(e.key==='Escape'){$('atpop').hidden=true;return}}}
  // a phone keyboard's return makes a new line; the ↑ button sends (Enter still sends on a computer)
  if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing&&!COARSE){e.preventDefault();$('f').requestSubmit()}});
$('quick').onclick=e=>{const b=e.target.closest('[data-q]');if(!b)return;const q=(S.quick||{})[cur]?.[+b.dataset.q];if(!q)return;
  if(e.shiftKey||$('msg').value.trim()){const i=$('msg');i.value=(i.value?i.value+'\n':'')+q;grow();i.focus()}else sendMsg(q)};
$('mention').onclick=e=>{const b=e.target.closest('button');if(!b)return;const i=$('msg');i.value=(i.value+' @'+b.dataset.at+' ').trimStart();grow();paintTo();i.focus()};

/* ---------- attachments ---------- */
function renderAtt(){$('att').innerHTML=pending.map((f,i)=>f.url
    ?`<span class="chip pic${f.up?' up':''}"><img src="${f.url}" alt="${esc(f.name)}">${f.up?'<span class="spin"></span>':''}<button type="button" data-rm="${i}" aria-label="移除">${ic('x')}</button></span>`
    :`<span class="chip file${f.up?' up':''}"><span class="fico">${fico(f.name,f.mime)}</span><span class="ft"><b data-u>${esc(f.name)}</b><small>${esc([fext(f.name),fsize(f.size)].filter(Boolean).join(' · '))}</small></span>${f.up?'<span class="spin"></span>':''}<button type="button" data-rm="${i}" aria-label="移除">${ic('x')}</button></span>`).join('');
  $('f').classList.toggle('empty',!$('msg').value.trim()&&!pending.length)}
const dropUrl=f=>{if(f&&f.url){try{URL.revokeObjectURL(f.url)}catch(e){}}};
$('att').onclick=e=>{const b=e.target.closest('[data-rm]');if(b){dropUrl(pending[+b.dataset.rm]);pending.splice(+b.dataset.rm,1);renderAtt()}};
$('clip').onclick=e=>{if(phoneUI()){e.stopPropagation();plusMenu();return}$('fileIn').click()};
$('fileIn').onchange=()=>{addFiles([...$('fileIn').files]);$('fileIn').value=''};
async function addFiles(list){for(const file of list.slice(0,Math.max(0,6-pending.length))){
    const item={name:file.name,mime:file.type||'application/octet-stream',size:file.size,up:true,url:/^image\//.test(file.type)?URL.createObjectURL(file):''};pending.push(item);renderAtt();
    try{const {blob,body}=await filePayload(file,cur);const {name,mime,data}=body;
      const r=await api('files','POST',body);
      Object.assign(item,r,{name,mime,size:blob.size,up:false});
      fileCache[r.id]=Promise.resolve({name,mime,data})}   // the sent message shows the picture at once, without downloading it again
    catch(err){pending.splice(pending.indexOf(item),1);toast(err.message)}
    renderAtt()}}
/* voice input (browsers with speech recognition, e.g. Chrome on phones) */
(()=>{const SR=window.SpeechRecognition||window.webkitSpeechRecognition;if(!SR||window.octaDesktop)return;$('mic').hidden=false;let rec=null;
  $('mic').onclick=()=>{if(rec){rec.stop();return}rec=new SR();rec.lang=I18N.lang==='en'?'en-US':I18N.lang==='ja'?'ja-JP':I18N.lang;rec.interimResults=true;rec.continuous=false;
    const base=$('msg').value;$('mic').classList.add('rec');
    rec.onresult=e=>{let t='';for(const r of e.results)t+=r[0].transcript;$('msg').value=(base?base+' ':'')+t;grow()};
    rec.onend=()=>{rec=null;$('mic').classList.remove('rec');$('msg').focus()};rec.onerror=()=>{};rec.start()}})();

/* ---------- sending ---------- */
async function sendMsg(v,files=[],meta,reply,to){const c=to||cur,fs=meta||pending.filter(f=>files.includes(f.id)).map(f=>({id:f.id,name:f.name,mime:f.mime,size:f.size}));
  const mc=MSG[c]||(MSG[c]={list:[],more:false,loaded:false});
  mc.list.push({id:'tmp'+Date.now(),tmp:true,conv:c,by:'me',text:v||'（附件）',files:fs,ts:Date.now(),reply:reply||null});render(true);
  try{await api('messages','POST',{conv:c,text:v,files,reply:reply||undefined});refresh();return true}
  catch(err){mc.list=mc.list.filter(m=>!m.tmp);render(false);toast(err.message);return false}}
$('f').onsubmit=async e=>{e.preventDefault();let v=$('msg').value.trim();
  if($('f').classList.contains('stopping')&&!v&&!pending.length){$('sendBtn').disabled=true;api('cancel','POST',{conv:cur}).then(()=>{toast(I18N.t('已停止'));refresh()}).catch(err=>toast(err.message)).finally(()=>{$('sendBtn').disabled=false});return}
  // the chat named in 傳給 when the key is pressed; if it changed a moment ago, ask for one more press
  const to=$('f').dataset.to||cur;
  if(!to||to!==cur||(TO.prev&&Date.now()-TO.at<700)){TO.prev='';paintTo();toast(I18N.t('傳送對象剛換了，確認「傳給」後再按一次送出'));return}
  const slash=v.match(/^\/(\S+)$/);
  if(slash){const hit=(S.skills?.[to]||[]).find(s=>s.name===slash[1]);if(hit)v='請執行技能「'+hit.name+'」'}
  if(pending.some(f=>f.up))return;const files=pending.map(f=>f.id);if(!v&&!files.length)return;
  const keep=pending,rid=replyTo&&replyTo.conv===to?replyTo.id:null;$('msg').value='';grow();store.set(draftKey(),null);
  const ok=await sendMsg(v,files,undefined,rid,to);if(ok){replyTo=null;paintReply();keep.forEach(dropUrl)}
  if(cur!==to){if(!ok){PEND[to]=keep;store.set('octa_draft_'+to,v)}return}   // you went to another chat meanwhile: the failed text waits in its own chat
  pending=ok?[]:keep;renderAtt();if(!ok){$('msg').value=v;grow()}};
// paste or drop files straight into the chat; dragged text lands in the box
function insertText(text){const el=$('msg'),s=el.selectionStart??el.value.length,end=el.selectionEnd??s;
  el.value=el.value.slice(0,s)+text+el.value.slice(end);const n=s+text.length;el.focus();el.setSelectionRange(n,n);grow();saveDraft()}
$('msg').addEventListener('paste',e=>{const fs=[...(e.clipboardData?.files||[])];if(fs.length){e.preventDefault();addFiles(fs)}});
$('pane').addEventListener('dragenter',e=>{
  if(!cur)return;
  const types=[...e.dataTransfer.types];
  if(!types.includes('Files')&&!types.includes('text/plain'))return;
  dragDepth++;e.preventDefault();
  $('pane').classList.toggle('drop',types.includes('Files'));
  $('pane').classList.toggle('droptext',!types.includes('Files'));
});
$('pane').addEventListener('dragover',e=>{
  if(!cur)return;
  const types=[...e.dataTransfer.types];
  if(types.includes('Files')||types.includes('text/plain')){e.preventDefault();e.dataTransfer.dropEffect='copy'}
});
$('pane').addEventListener('dragleave',()=>{dragDepth=Math.max(0,dragDepth-1);if(!dragDepth)$('pane').classList.remove('drop','droptext')});
$('pane').addEventListener('drop',e=>{
  dragDepth=0;$('pane').classList.remove('drop','droptext');
  if(!cur){if(e.dataTransfer.files.length){e.preventDefault();toast(I18N.t('先選一個機器人，再把檔案丟進來'))}return}
  const files=[...e.dataTransfer.files];
  if(files.length){e.preventDefault();addFiles(files);return}
  const text=e.dataTransfer.getData('text/plain');
  if(!text||draggingId||draggingMsg)return;
  e.preventDefault();insertText(text);
});
// the phone's ＋ beside the box: a photo or file, @ a member, a saved instruction, or / for actions
function plusMenu(){const c=conv(cur);if(!c)return;const g=isG(cur),qk=(S.quick||{})[cur]||[];
  popMenu($('clip'),`${mi('file','clip','照片或檔案')}${mi('slash','slash','指令（瀏覽器、停止、歷史畫面…）')}
    ${g?`<hr><div class="lab">指定成員</div>${c.members.filter(bot).map(id=>mi('at','',`<span data-u>@${esc(bot(id).name)}</span>`,bot(id).name)).join('')}`:''}
    ${qk.length?`<hr><div class="lab">常用指令</div>${qk.map((q,i)=>mi('q','zap',`<span data-u>${esc(q.length>40?q.slice(0,40)+'…':q)}</span>`,i)).join('')}`:''}`,
   {file:()=>$('fileIn').click(),slash:startSlash,
    at:v=>{const i=$('msg');i.value=(i.value.trimEnd()+' @'+v+' ').trimStart();grow();paintTo();i.focus()},
    q:v=>{const q=qk[+v];if(!q)return;const i=$('msg');if(i.value.trim()){i.value+='\n'+q;grow();i.focus()}else sendMsg(q)}})}
// the ↓ button floats just above the box, whatever its height
if(window.ResizeObserver)new ResizeObserver(()=>{const h=$('composer').offsetHeight;if(h)$('pane').style.setProperty('--compH',h+'px')}).observe($('composer'));
// keep the newest message in view when the keyboard (or anything else) makes the list shorter
(()=>{const box=$('msgs');let stick=true;box.addEventListener('scroll',()=>{stick=box.scrollHeight-box.scrollTop-box.clientHeight<80},{passive:true});
  if(window.ResizeObserver)new ResizeObserver(()=>{if(!phoneUI()||box.hidden)return;if(stick)box.scrollTop=box.scrollHeight}).observe(box)})();
