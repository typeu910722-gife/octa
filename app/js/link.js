/* OCTA web app — 4.3 主機電腦／遙控器 (設定 → 電腦).
   One computer (the host) keeps the data and runs the bots. Another computer can be its remote control: it shows the
   host's bots, chats and settings, and everything still runs on the host. Linking is done once with a 連線碼 shown on
   the host. The host's address changes when it restarts; it is passed on encrypted through the free public relay
   ntfy.sh (no OCTA server). 換成這台當主機 moves the data to the remote control and swaps the two.
   Talks only to this computer's own server (/api/desktop/link); the page's other API calls are forwarded to the host. */
'use strict';
const VIA=()=>!!CFG.via;
const LINK={st:null,timer:0};
const VIA_TXT={online:'已連線',connecting:'連線中…',offline:'重新連線中…','relay-down':'找不到主機的新網址',revoked:'需要重新連線',moved:'主機換到另一台電腦了'};
const RELAY_HELP='這台電腦的網址每次重新開機都會改變。OCTA 用免費的公開轉送服務 ntfy.sh 傳遞加密後的連線網址，不經過 OCTA 伺服器；只有連結過的電腦解得開。';
async function linkGet(){try{LINK.st=await api_('desktop/link','GET')}catch(e){}return LINK.st}
const linkDo=body=>api('desktop/link','POST',body);

/* ---------- the remote control: "遙控 店裡電腦" in the sidebar, a banner while the host can't be reached ---------- */
function viaHost(){return LINK.st?.host||{name:CFG.via?.name||'',state:'connecting'}}
function paintVia(){if(!VIA())return;const h=viaHost(),ok=h.state==='online';
  const el=$('online');el.classList.toggle('on',ok);el.classList.toggle('via',true);el.classList.toggle('bad',!ok&&h.state!=='connecting');
  $('onlineT').textContent=I18N.t('遙控')+' '+(h.name||I18N.t('主機電腦'));$('onlineT').dataset.u='';
  el.title=I18N.t(ok?'這台電腦是遙控器，機器人在主機電腦上工作':VIA_TXT[h.state]||'連線中…');
  let b=$('viab');if(!b){b=document.createElement('div');b.id='viab';b.className='viab';b.setAttribute('role','status');document.body.appendChild(b)}
  const down=['offline','relay-down','revoked','moved'].includes(h.state);
  b.hidden=!down;if(!down)return;
  const msg=h.state==='revoked'?'主機電腦已經移除這台電腦，請重新連線':h.state==='relay-down'?'找不到主機電腦的新網址，可以貼上主機顯示的網址':h.state==='moved'?'主機換到另一台電腦了，請重新連線':'連不到主機電腦，重新連線中…';
  setHTML(b,`<span class="vdot" aria-hidden="true"></span><span>${I18N.t(msg)}</span><button type="button" class="link" data-via="open">${I18N.t('查看')}</button>`)}
document.addEventListener('click',e=>{if(e.target.closest('[data-via=open]'))openSettings('pcs')});
// while this computer is a remote control: keep the mark fresh; the page reloads when the role changes
async function viaTick(){clearTimeout(LINK.timer);const st=await linkGet();
  if(st&&(st.role==='remote')!==VIA()&&!(st.switching&&!st.switching.done)){location.reload();return}
  paintVia();if(settingsOpen()&&secNow==='pcs'&&!$('sbody').contains(document.activeElement))SEC.pcs();
  LINK.timer=setTimeout(viaTick,LINK.st?.host?.state==='online'?8000:3000)}
function viaStart(){if(VIA()){paintVia();viaTick()}}

/* ---------- linking this computer to another one (onboarding and settings) ---------- */
function linkSheet(replace){
  openSheet(`${sheetHead('連到另一台電腦（當遙控器）')}
    <p>${I18N.t('在另一台已經在用 OCTA 的電腦（主機）打開「設定 → 電腦 → 讓另一台電腦連進來」，按「產生連線碼」，把連線碼貼在這裡。')}</p>
    <form id="lkF" class="lkform"><textarea id="lkCode" rows="3" class="mono" spellcheck="false" autocomplete="off" placeholder="https://…trycloudflare.com#octa-link=ABCD2345" aria-label="${esc(I18N.t('連線碼'))}"></textarea>
    <ul class="lkpts"><li>${I18N.t('連上後，這台電腦會顯示主機的機器人和對話，工作都在主機上做。')}</li><li>${I18N.t('這台電腦原本的資料會保留不動，停止遙控就回來。')}</li><li>${I18N.t(RELAY_HELP)}</li></ul>
    <div class="errmsg" id="lkE" role="alert"></div>
    <div class="acts"><button type="button" class="ghost" id="sx">取消</button><button class="btn" id="lkGo">連線</button></div></form>`,'sm');
  $('sx').onclick=closeSheet;setTimeout(()=>$('lkCode').focus(),50);
  $('lkF').onsubmit=async e=>{e.preventDefault();const code=$('lkCode').value.trim();if(!code){$('lkE').textContent=I18N.t('請貼上主機電腦顯示的連線碼');return}
    $('lkGo').disabled=true;$('lkE').textContent='';
    try{await linkDo({act:'connect',code,replace:!!replace});$('lkGo').textContent=I18N.t('已連線，載入主機的資料…');setTimeout(()=>location.reload(),600)}
    catch(err){$('lkE').textContent=err.message;$('lkGo').disabled=false}}}

/* ---------- 設定 → 電腦 ---------- */
const agoTxt=ts=>{const m=Math.round((Date.now()-ts)/60000);return m<2?I18N.t('剛剛'):m<60?m+' '+I18N.t('分鐘前'):m<1440?Math.round(m/60)+' '+I18N.t('小時前'):new Date(ts).toLocaleDateString(I18N.lang)};
SEC.pcs=async()=>{const st=await linkGet();if(secNow!=='pcs')return;$('sblocks').innerHTML='';
  if(!st){block('sPcErr','').innerHTML=`<p class="errmsg">${I18N.t('讀取失敗，請稍後再試')}</p>`;return}
  if(st.role==='remote')return pcsRemote(st);
  // ----- the host -----
  const inv=block('sPcInvite','讓另一台電腦連進來','另一台電腦（例如家裡的電腦）貼上連線碼後，就能看到並指揮這台電腦的機器人，工作仍在這台電腦上做。連線碼 10 分鐘內有效，只能用一次。');
  const paintInv=i=>{inv.innerHTML=i?`<div class="lkcode"><label class="hmuted" for="lkOut">${I18N.t('連線碼（網址＋配對碼）')}</label>${copyRow(i.linkCode,'lkOut')}
      <div class="kv"><span>${I18N.t('網址')}</span><b class="mono sel" data-u>${esc(i.url)}</b><span>${I18N.t('配對碼')}</span><b class="code-out" data-u>${esc(i.code)}</b></div>
      <p class="hmuted">${I18N.t('有效到')} <span data-u>${new Date(i.until).toLocaleTimeString(I18N.lang,{hour:'2-digit',minute:'2-digit'})}</span></p></div>`
    :`<div class="row2"><button type="button" class="btn sm" id="lkMake">${ic('link')}<span>${I18N.t('產生連線碼')}</span></button></div>`;
    inv.insertAdjacentHTML('beforeend',`<p class="hmuted">${I18N.t(RELAY_HELP)}</p>`);
    if($('lkMake'))$('lkMake').onclick=async()=>{const b=$('lkMake');b.disabled=true;b.lastChild.textContent=I18N.t('開啟連線中，第一次約 30 秒…');
      try{paintInv(await linkDo({act:'invite'}))}catch(e){b.disabled=false;b.lastChild.textContent=I18N.t('產生連線碼');toast(e.message)}};paintIcons(inv)};
  paintInv(st.invite);
  const list=block('sPcList','已連結的電腦','這些電腦可以遙控這台電腦。移除後，那台電腦就連不進來了。');
  list.innerHTML=(st.handing?`<p class="note-box warn">${ic('info')}<span>${I18N.t('正在把資料交給')} <b data-u>${esc(st.handing.name||'')}</b>${I18N.t('，這段時間機器人暫停工作。')}</span></p>`:'')
    +(st.computers.length?st.computers.map(c=>`<div class="kvrow"><span class="pcn">${ic('monitor')}<span><b data-u>${esc(c.name)}</b><small class="hmuted">${I18N.t('最近使用')} <span data-u>${agoTxt(c.seen)}</span></small></span></span><button type="button" class="ghost sm danger" data-pcx="${esc(c.id)}" data-pcname="${esc(c.name)}">${I18N.t('移除')}</button></div>`).join('')
      :`<p class="hmuted">${I18N.t('還沒有連結的電腦。')}</p>`)
    +(st.computers.length&&st.relay?.error?`<p class="note-box warn">${ic('info')}<span>${I18N.t('暫時連不到 ntfy.sh，遙控器可能找不到這台電腦的新網址：')} <span data-u>${esc(st.relay.error)}</span></span></p>`:'');
  list.querySelectorAll('[data-pcx]').forEach(b=>b.onclick=()=>confirmSheet(I18N.t('移除這台電腦'),`<p>${I18N.t('移除後，')}<b data-u>${esc(b.dataset.pcname)}</b>${I18N.t('就不能再遙控這台電腦。之後要再連，需要新的連線碼。')}</p>`,I18N.t('移除'),true,async()=>{await linkDo({act:'remove',id:b.dataset.pcx});toast(I18N.t('已移除'));SEC.pcs()}));
  paintIcons(list);
  const me=block('sPcMe','把這台電腦當遙控器','如果另一台電腦已經在跑 OCTA，可以讓這台電腦變成它的遙控器：打開 OCTA 就看到那台電腦的機器人和對話，工作都在那台電腦上做。這台電腦現有的資料會保留，停止遙控就回來。');
  me.innerHTML=`<div class="row2"><button type="button" class="ghost sm" id="lkTo">${ic('monitor')}<span>${I18N.t('連到另一台電腦…')}</span></button></div>`;
  $('lkTo').onclick=()=>linkSheet(false);paintIcons(me)};

function pcsRemote(st){const h=st.host||{},ok=h.state==='online';
  const cur=block('sPcVia',I18N.t('正在遙控')+'「'+esc(h.name||I18N.t('主機電腦'))+'」','這台電腦現在是遙控器：看到的機器人、對話和設定都在主機電腦上，工作也在那裡做。');
  cur.innerHTML=`<div class="kv"><span>${I18N.t('狀態')}</span><b><span class="pill ${ok?'ok':h.state==='connecting'?'':'warn'}">${I18N.t(VIA_TXT[h.state]||'連線中…')}</span></b>
      ${h.url?`<span>${I18N.t('網址')}</span><b class="mono sel" data-u>${esc(h.url)}</b>`:''}</div>
    ${h.error&&!ok?`<p class="hmuted" data-u>${esc(h.error)}</p>`:''}
    ${h.state==='relay-down'?`<p class="note-box warn">${ic('info')}<span>${I18N.t('主機電腦的網址換了，但暫時連不到 ntfy.sh 查新網址。可以在主機電腦的「設定 → 電腦」看網址，貼在這裡：')}</span></p>
      <form class="row2" id="lkAddr"><input id="lkAddrIn" class="grow mono" placeholder="https://…trycloudflare.com" aria-label="${esc(I18N.t('主機電腦的網址'))}"><button class="btn sm">${I18N.t('連線')}</button></form>`:''}
    ${h.state==='revoked'||h.state==='moved'?`<div class="row2"><button type="button" class="btn sm" id="lkRe">${ic('link')}<span>${I18N.t('輸入新的連線碼…')}</span></button></div>`
      :`<div class="row2"><button type="button" class="ghost sm" id="lkRetry">${ic('refresh')}<span>${I18N.t('立即重新連線')}</span></button></div>`}
    <p class="hmuted">${I18N.t(RELAY_HELP)}</p>`;
  if($('lkRetry'))$('lkRetry').onclick=async()=>{$('lkRetry').disabled=true;try{await linkDo({act:'retry'})}catch(e){toast(e.message)}SEC.pcs()};
  if($('lkRe'))$('lkRe').onclick=()=>linkSheet(true);
  if($('lkAddr'))$('lkAddr').onsubmit=async e=>{e.preventDefault();try{await linkDo({act:'address',code:$('lkAddrIn').value});SEC.pcs()}catch(err){toast(err.message)}};
  paintIcons(cur);
  const sw=block('sPcSwitch','換成這台當主機','把資料搬到這台電腦，之後機器人在這台電腦上工作，原本的主機改當這台的遙控器。例如店裡的電腦要送修，或想改由家裡的電腦執行。');
  sw.innerHTML=st.switching&&!st.switching.done?switchProgress(st.switching)
    :`${st.switching?.done&&!st.switching.ok?`<p class="note-box warn">${ic('info')}<span>${I18N.t('上次換主機沒有完成，已經復原：')} <span data-u>${esc(st.switching.error||'')}</span></span></p>`:''}
      <div class="row2"><button type="button" class="btn sm" id="lkSwitch" ${ok?'':'disabled'}>${ic('monitor')}<span>${I18N.t('換成這台當主機…')}</span></button></div>${ok?'':`<p class="hmuted">${I18N.t('要先連上主機電腦才能換。')}</p>`}`;
  if($('lkSwitch'))$('lkSwitch').onclick=()=>switchSheet(h.name||I18N.t('主機電腦'));
  paintIcons(sw);
  const stop=block('sPcStop','停止遙控','回到這台電腦自己的資料（遙控期間這台電腦的資料沒有變動）。之後要再遙控，需要新的連線碼。');
  stop.innerHTML=`<div class="row2"><button type="button" class="ghost sm danger" id="lkStop">${ic('x')}<span>${I18N.t('停止遙控，回到這台電腦自己的資料')}</span></button></div>`;
  $('lkStop').onclick=()=>confirmSheet(I18N.t('停止遙控'),`<p>${I18N.t('這台電腦會改回顯示自己的資料，也會在這台電腦上執行機器人。主機電腦照常工作。')}</p>`,I18N.t('停止遙控'),true,async()=>{await linkDo({act:'disconnect'});setTimeout(()=>location.reload(),300)});
  paintIcons(stop)}

const switchProgress=s=>`<div class="lkprog"><span class="bar"><i style="width:${Math.max(3,s.p||0)}%"></i></span><p class="hmuted" data-u>${esc(I18N.t(s.text||'準備中…'))}</p></div>`;
function switchSheet(name){
  openSheet(`${sheetHead('換成這台當主機')}<div class="sbodytext"><p>${I18N.t('會發生這些事：')}</p><ol class="lkpts">
    <li><b data-u>${esc(name)}</b> ${I18N.t('先暫停工作，不再接新的工作（做到一半的工作會在這台電腦接著做）。')}</li>
    <li>${I18N.t('資料庫和檔案資料夾（1 GB 以內）透過你們的連線複製到這台電腦，並核對筆數。')}</li>
    <li>${I18N.t('這台電腦原本的資料會先備份。')}</li>
    <li>${I18N.t('完成後機器人在這台電腦上工作，')}<b data-u>${esc(name)}</b> ${I18N.t('改當這台的遙控器。')}</li>
    <li>${I18N.t('中途失敗會自動復原，原本的主機繼續工作。')}</li></ol>
    <p class="note-box">${ic('info')}<span>${I18N.t('這台電腦也要安裝並登入機器人用的 AI（例如 Claude）和 Chrome；網站的登入不會搬過來，機器人需要時會請你登入；手機要重新配對。')}</span></p></div>
    <div class="errmsg" id="swE"></div><div id="swP"></div>
    <div class="acts"><button type="button" class="ghost" id="sx">取消</button><button class="btn" id="swGo">${I18N.t('開始搬移')}</button></div>`,'sm');
  paintIcons($('veil'));$('sx').onclick=closeSheet;
  $('swGo').onclick=async()=>{$('swGo').disabled=true;$('sx').disabled=true;$('swE').textContent='';
    try{await linkDo({act:'switch'})}catch(e){$('swE').textContent=e.message;$('swGo').disabled=false;$('sx').disabled=false;return}
    const tick=async()=>{const st=await linkGet(),s=st?.switching;if(!$('swP'))return;
      if(s)$('swP').innerHTML=switchProgress(s);
      if(s?.done){if(s.ok){$('swP').innerHTML=`<p class="note-box">${ic('check')}<span>${I18N.t('完成，這台電腦現在是主機。')}</span></p>${s.filesNote?`<p class="note-box warn"><span data-u>${esc(s.filesNote)}</span></p>`:''}`;paintIcons($('swP'));
          $('swGo').hidden=true;$('sx').disabled=false;$('sx').textContent=I18N.t('知道了');$('sx').onclick=()=>{linkDo({act:'switch-clear'}).catch(()=>{});location.reload()};return}
        $('swE').textContent=I18N.t('沒有換成功，已經復原：')+(s.error||'');$('sx').disabled=false;$('swGo').disabled=false;linkDo({act:'switch-clear'}).catch(()=>{});return}
      setTimeout(tick,700)};
    tick()}}
