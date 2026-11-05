/* OCTA web app — Settings: one page, eight sections.
   外觀與語言 · AI 連線 · 瀏覽器 · 通知 · 手機遠端 · 電腦（4.3, link.js） · 工作與排程 · 進階 */
'use strict';
const SECTIONS=[
  ['look','外觀與語言','palette','配色、主題色、字體大小、版面、快捷鍵、語言'],
  ['ai','AI 連線','plug','連接 AI、剩餘流量、待機'],
  ['browser','瀏覽器','globe','共用登入、使用我的 Chrome'],
  ['noti','通知','bell','這個裝置、Telegram、LINE'],
  ['remote','手機遠端','phone','用手機指揮這台電腦'],
  ['pcs','電腦','monitor','另一台電腦當遙控器、換主機'],
  ['work','工作與排程','clock','例行任務、工作時間、紀錄'],
  ['adv','進階','sliders','共用資料、檔案、連接器、版本']];
const SEC={};   // section key → render(arg)
let secNow='';
function settingsOpen(){return !!$('sbody')}
function settingsFrame(){
  if(settingsOpen())return;
  $('veil').innerHTML=`<div class="sheet settings page" role="dialog" aria-modal="true" aria-label="設定"><div class="shd"><button type="button" class="ib back2 sback" id="sBack" data-back hidden aria-label="返回">${ic('back')}</button><h2 id="sTitle">設定</h2><button type="button" class="ib x" data-close aria-label="關閉">${ic('x')}</button></div>
  <div class="sgrid at-nav" id="sgrid"><nav class="snav" aria-label="設定分類">${SECTIONS.filter(([k])=>k!=='pcs'||DESK()||CFG.via).map(([k,t,i,d])=>`<button type="button" data-s="${k}">${ic(i,'si')}<span class="st"><b>${t}</b><small>${d}</small></span>${ic('chev','sa')}</button>`).join('')}</nav>
  <div class="sbody" id="sbody"></div></div></div>`;
  $('veil').hidden=false;
  $('veil').querySelectorAll('.snav [data-s]').forEach(b=>b.onclick=()=>leaveOk(()=>{if(typeof stopCodePoll==='function')stopCodePoll();showSection(b.dataset.s)}));
  $('sBack').onclick=()=>leaveOk(()=>{if(typeof stopCodePoll==='function')stopCodePoll();if(SUB.back){const f=SUB.back;SUB.back=null;f()}else{secNow='';$('sgrid').classList.add('at-nav');$('sBack').hidden=true;$('sTitle').textContent=I18N.t('設定');markNav('')}})}
function markNav(k){$('veil').querySelectorAll('.snav [data-s]').forEach(b=>{b.classList.toggle('on',b.dataset.s===k);b.toggleAttribute('aria-current',b.dataset.s===k)})}
function openSettings(k,arg){settingsFrame();if(!k&&phoneUI())return;showSection(k&&SEC[k]?k:'look',arg)}
const SUB={back:null};
function showSection(k,arg){if(DIRTY.el&&$('veil').contains(DIRTY.el))DIRTY.el=null;SUB.back=null;secNow=k;delete $('sbody').dataset.code;
  const row=SECTIONS.find(r=>r[0]===k);$('sgrid').classList.remove('at-nav');markNav(k);
  $('sBack').hidden=!phoneUI();$('sTitle').textContent=I18N.t(phoneUI()?row[1]:'設定');
  $('sbody').innerHTML=`<div class="stitle"><h2>${row[1]}</h2><p>${row[3]}</p></div><div class="sblocks" id="sblocks"></div>`;$('sbody').scrollTop=0;
  SEC[k](arg)}
/* a page inside a section (工作紀錄, 成果看板, 程式任務, 版本紀錄…) with a way back */
function subPage(title,html,back){settingsFrame();if(DIRTY.el&&$('veil').contains(DIRTY.el))DIRTY.el=null;$('sgrid').classList.remove('at-nav');
  SUB.back=back||(()=>showSection(secNow||'adv'));$('sBack').hidden=false;$('sTitle').textContent=I18N.t(phoneUI()?title:'設定');
  $('sbody').innerHTML=`<div class="stitle sub"><button type="button" class="link" id="subBack">${ic('back')}<span>返回</span></button><h2>${title}</h2></div><div class="sblocks">${html}</div>`;$('sbody').scrollTop=0;
  $('subBack').onclick=()=>$('sBack').click();paintIcons($('sbody'))}
// one card in a section; returns the card element so it can draw (and redraw) itself
function block(id,title,desc){const el=document.createElement('section');el.className='scard';el.id=id;el.innerHTML=(title?`<h3>${title}</h3>`:'')+(desc?`<p class="sdesc">${desc}</p>`:'')+'<div class="scb"></div>';$('sblocks').appendChild(el);return el.querySelector('.scb')}
const toggleRow=(id,label,on,desc,attrs='')=>`<div class="toggle"><span class="tl"><span>${label}</span>${desc?`<small>${desc}</small>`:''}</span><button type="button" class="sw ${on?'on':''}" id="${id}" role="switch" aria-checked="${!!on}" aria-label="${label}"${attrs}></button></div>`;
const swSet=(el,on)=>{el.classList.toggle('on',on);el.setAttribute('aria-checked',String(on))};
const copyRow=(v,id)=>`<div class="row2"><input readonly class="mono grow" value="${esc(v)}" data-u${id?` id="${id}"`:''}><button type="button" class="ghost sm" data-copy="${esc(v)}">複製</button></div>`;
document.addEventListener('click',e=>{const b=e.target.closest('#veil [data-copy]');if(!b)return;navigator.clipboard?.writeText(b.dataset.copy).then(()=>{b.textContent=I18N.t('已複製 ✓')}).catch(()=>{})});

/* ---------- 外觀與語言 ---------- */
// SEC.look (外觀與語言) is in prefs.js, next to what it sets

/* ---------- 瀏覽器 ---------- */
SEC.browser=async()=>{
  const sh=block('sShare','登入共用');
  sh.innerHTML=toggleRow('dShare','所有機器人共用登入',S.shareBrowser!==false,'開著：在任何一個機器人的瀏覽器登入過的網站（LINE、Google…），其他機器人下次工作時也直接能用。每個機器人還是有自己的瀏覽器，可以同時工作。關掉：每個機器人的登入各自獨立。');
  $('dShare').onclick=async()=>{const on=!$('dShare').classList.contains('on');swSet($('dShare'),on);
    try{await api('settings','PUT',{shareBrowser:on});S.shareBrowser=on;toast(I18N.t(on?'已改成共用登入，下次工作時生效':'已改成每個機器人的登入各自獨立，下次工作時生效'))}catch(e){swSet($('dShare'),!on);toast(e.message)}};
  if(!DESK()){block('sBrNote','',CFG.via?'Chrome 和「使用我的 Chrome」要在主機電腦上的 OCTA 設定（機器人在那台電腦上用瀏覽器）。':'Chrome 和「使用我的 Chrome」要在電腦上的 OCTA 設定。');return}
  const box=block('sMine','使用我的 Chrome','讓選了「使用我的 Chrome」的機器人，直接用你 Chrome 已登入的網站和已儲存的密碼。每個機器人會在自己的分頁群組裡工作，不會動到你其他分頁。');
  const chrome=block('sChrome','Google Chrome');
  box.innerHTML=chrome.innerHTML='<p class="fade">讀取中…</p>';
  let ds=null;try{ds=await api('desktop/status')}catch(e){}
  if(ds?.remote?.url)REMOTE_URL=ds.remote.on?ds.remote.url:'';
  chrome.innerHTML=ds?.chrome?`<p class="okt">${ic('check')}<span>已安裝。每個機器人會用自己獨立的瀏覽器工作。</span></p>`:`<p class="note-box warn">找不到 Google Chrome。機器人用 Chrome 操作網站，請安裝後重新打開這頁。</p><div class="row2"><a class="btn sm" href="https://www.google.com/chrome/" target="_blank" rel="noopener">下載 Chrome</a></div>`;
  box.innerHTML=`<div class="row2">${ds?.extToken?'<span class="pill ok">已連接</span>':'<span class="pill">未連接</span>'}</div>
    <ol class="ol"><li>在 Chrome 安裝 <a href="https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm" target="_blank" rel="noopener">Playwright Extension</a></li>
    <li>點 Chrome 右上角的擴充功能圖示，複製畫面上的 PLAYWRIGHT_MCP_EXTENSION_TOKEN</li>
    <li>貼在這裡並儲存：<div class="row2"><input id="dExt" type="password" autocomplete="off" class="grow" placeholder="${ds?.extToken?'已儲存（要更換再貼上新的）':'貼上 token'}"><button class="btn sm" id="dExtSave">儲存</button>${ds?.extToken?'<button class="ghost sm" id="dExtDel">移除</button>':''}</div></li></ol>`;
  const saveExt=async t=>{try{await api('desktop/ext-token','POST',{token:t});toast(I18N.t(t?'已連接 Chrome':'已移除'));showSection('browser')}catch(e){toast(e.message)}};
  $('dExtSave').onclick=()=>{const t=$('dExt').value.trim();if(t)saveExt(t)};if($('dExtDel'))$('dExtDel').onclick=()=>saveExt('')};

/* ---------- 通知 ---------- */
SEC.noti=async()=>{
  const dev=block('sDev','這個裝置','機器人回覆時，在這個裝置跳出通知（不在那個對話裡或視窗在背景時）。手機要把 OCTA 加到主畫面才收得到。');
  const perm='Notification' in window?Notification.permission:'unsupported';
  dev.innerHTML=toggleRow('nDev','在這個裝置跳出通知',notiOn()&&perm==='granted','',perm==='unsupported'?' disabled':'')+(perm==='denied'?'<p class="note-box warn">瀏覽器封鎖了通知，請在網址列左邊的網站設定裡允許通知。</p>':perm==='unsupported'?'<p class="hmuted">這個瀏覽器不支援通知。</p>':'');
  $('nDev').onclick=async()=>{const want=!$('nDev').classList.contains('on');
    if(want&&Notification.permission!=='granted'){const p=await Notification.requestPermission().catch(()=>'denied');if(p!=='granted'){toast(I18N.t('沒有取得通知權限'));return showSection('noti')}}
    store.set(NOTI_KEY,want?'1':'0');swSet($('nDev'),want);
    if(want)try{new Notification('OCTA',{body:I18N.t('通知已開啟'),icon:'/icon.png'})}catch(e){}};
  const tg=block('sTg','Telegram／LINE','機器人卡住、需要你核准、出錯時通知你。');
  tg.innerHTML='<p class="fade">讀取中…</p>';
  let st={notifyAll:false,tg:{},line:{}};try{st=await api('settings')}catch(e){}
  tg.innerHTML=`<label class="field"><span>Telegram Bot Token</span><input id="tgTok" value="${esc(st.tg?.token||'')}" placeholder="從 @BotFather 取得" autocomplete="off"></label>
  <label class="field"><span>Telegram Chat ID</span><div class="row2"><input id="tgChat" class="grow" value="${esc(st.tg?.chat||'')}" placeholder="Chat ID"><button type="button" class="ghost sm" id="tgDet">自動偵測</button></div></label>
  <label class="field"><span>LINE Messaging API Channel Access Token</span><input id="lnTok" value="${esc(st.line?.token||'')}" placeholder="LINE Developers 後台取得" autocomplete="off"></label>
  <label class="field"><span>LINE 接收者 User ID</span><input id="lnTo" value="${esc(st.line?.to||'')}" placeholder="U 開頭"></label>
  ${toggleRow('nAll','完成工作也通知',st.notifyAll)}
  <div class="row2"><button class="btn sm" id="sSave">儲存</button><button class="ghost sm" id="nTest">傳測試通知</button><span class="dflag" data-dirty-flag hidden>有未儲存的變更</span><span id="sMsg" class="hmuted"></span></div>`;
  $('nAll').onclick=()=>{swSet($('nAll'),!$('nAll').classList.contains('on'));markDirty()};
  const say=t=>$('sMsg').textContent=t;
  const saveS=()=>api('settings','PUT',{notifyAll:$('nAll').classList.contains('on'),tg:{token:$('tgTok').value,chat:$('tgChat').value},line:{token:$('lnTok').value,to:$('lnTo').value}}).then(r=>{cleanDirty();return r});
  trackDirty(tg,async()=>{try{await saveS();say(I18N.t('已儲存 ✓'));return true}catch(e){say(e.message);return false}});
  $('sSave').onclick=async()=>{try{await saveS();say(I18N.t('已儲存 ✓'));toast(I18N.t('已儲存 ✓'))}catch(e){say(e.message)}};
  $('nTest').onclick=async()=>{try{await saveS();const r=await api('notify/test','POST');say(I18N.t('已送出：')+r.sent.join('、'))}catch(e){say(e.message)}};
  $('tgDet').onclick=async()=>{try{await saveS();const r=await api('notify/detect','POST');$('tgChat').value=r.chat;say(I18N.t('找到 Chat ID ✓'))}catch(e){say(e.message)}}};

/* ---------- 手機遠端 ---------- */
// 4.4: a phone scans the /go QR once (it pairs and remembers this computer); after that it opens OCTA from its home
// screen even when this computer restarted (new address). The 網址＋配對碼 still work for a quick one-off.
function remoteInfo(r){return `<div class="remote"><div class="kv"><span>網址</span><b class="mono sel" data-u>${esc(r.url)}</b><span>配對碼</span><b class="code-out" data-u>${esc(r.code)}</b></div></div>
  <div class="row2"><button type="button" class="ghost sm" data-copy="${esc(r.url)}">複製網址</button></div>
  <p class="hmuted">網址每次開啟都會不同。配對碼只給信任的人。</p>`}
function goHow(){return `<ol class="gohow"><li>${ic('phone')}<span><b>iPhone（Safari）</b>分享 →「加入主畫面」</span></li><li>${ic('phone')}<span><b>Android（Chrome）</b>右上角 ⋮ →「加到主畫面」</span></li></ol>`}
function remoteGo(r){return `<div class="goqr">${r.goQr?`<img class="qr" src="${r.goQr}" alt="用手機相機掃描">`:''}<div class="gotx">
    <p><b>用手機相機掃描</b>：會自動配對，並記住這台電腦。</p>
    <p class="hmuted">以後從手機主畫面的 OCTA 打開，這台電腦重開、網址換了也不用再配對。</p>${goHow()}
    <div class="row2"><button type="button" class="ghost sm" data-copy="${esc(r.go)}">複製捷徑連結</button></div></div></div>
  ${r.relay?.error?`<p class="note-box warn">${ic('info')}<span>暫時連不到 ntfy.sh，手機可能找不到這台電腦的新網址：<span data-u>${esc(r.relay.error)}</span></span></p>`:''}`}
async function paintPhones(box){let d={phones:[]};try{d=await api('desktop/phones')}catch(e){}
  box.innerHTML=d.phones.length?d.phones.map(p=>`<div class="kvrow"><span class="pcn">${ic('phone')}<span><b>${esc(I18N.t(p.name))}</b><small class="hmuted">${I18N.t('最近使用')} <span data-u>${agoTxt(p.seen)}</span> · ${I18N.t('配對於')} <span data-u>${new Date(p.created).toLocaleDateString(I18N.lang)}</span></small></span></span><button type="button" class="ghost sm danger" data-phx="${esc(p.id)}" data-phname="${esc(I18N.t(p.name))}">移除</button></div>`).join('')
    :`<p class="hmuted">還沒有配對的手機。</p>`;
  box.querySelectorAll('[data-phx]').forEach(b=>b.onclick=()=>confirmSheet(I18N.t('移除手機'),`<p><b data-u>${esc(b.dataset.phname)}</b>${I18N.t('會立刻登出，不能再連到這台電腦。之後要再用，需要重新掃描或輸入配對碼。')}</p>`,I18N.t('移除'),true,async()=>{await api('desktop/phones','POST',{remove:b.dataset.phx});toast(I18N.t('已移除'));paintPhones(box)}));
  paintIcons(box)}
SEC.remote=async()=>{
  if(CFG.via){block('sViaPhone','','手機請直接連到主機電腦：在主機電腦的「設定 → 手機遠端」開啟，用那裡顯示的網址和配對碼。這台電腦現在是遙控器，不開手機遠端。');return}
  if(!DESK()){const b=block('sPaired','這支手機');
    b.innerHTML=`<p>${TOKEN?'這支手機已經和電腦配對，正在透過手機遠端連線。':'這個裝置正在透過網路連到電腦。'}</p>${TOKEN?`<div class="row2"><button class="btn sm" id="goHome">${ic('phone')}<span>把 OCTA 加到手機主畫面</span></button><button class="ghost sm danger" id="unpair">${ic('x')}<span>中斷這支手機的連線</span></button></div>
      <p class="hmuted">從主畫面的捷徑打開，電腦重開、網址換了也會自動連上，不用再配對。</p>`:''}`;
    if($('goHome'))$('goHome').onclick=()=>openGoSetup();
    if($('unpair'))$('unpair').onclick=()=>confirmSheet('中斷連線','<p>之後要再用，需要輸入電腦上新的配對碼。</p>','中斷連線',true,async()=>{unpaired()});paintIcons(b);return}
  const b=block('sRemote','','開著的時候，手機可以從外面連到這台電腦。連線走這台電腦自己開的 Cloudflare 通道，資料不經過其他伺服器。電腦重開後會自動再打開，已配對的手機不用重新配對；關掉就斷開所有手機。');
  b.innerHTML='<p class="fade">讀取中…</p>';
  let ds=null;try{ds=await api('desktop/status')}catch(e){}
  REMOTE_URL=ds?.remote?.on?ds.remote.url:'';
  b.innerHTML=`${toggleRow('dRemote','手機遠端',!!ds?.remote?.on)}<div id="dRemoteNote"></div>`;
  const go=block('sGo','把這個捷徑加到手機主畫面','第一次用：手機掃描下面的 QR code。');
  const ph=block('sPhones','已配對的手機','這些手機可以指揮這台電腦。移除後立刻登出。');
  const man=block('sManual','或在手機輸入網址和配對碼','不方便掃描時用。這個網址電腦重開後會換；之後請從主畫面的捷徑打開。');
  const paint=r=>{const on=!!r?.on;go.parentNode.hidden=man.parentNode.hidden=!on;go.innerHTML=on?remoteGo(r):'';man.innerHTML=on?remoteInfo(r):'';paintIcons(go)};
  paint(ds?.remote);paintPhones(ph);
  block('sHook','外部事件與交接網址','例行任務的「外部事件」網址和給其他 AI 的交接網址，不用打開手機遠端也能從外面呼叫：網址在 OCTA 網站，會轉送到這台電腦，電腦重開也不用換。只要有這類網址，OCTA 開著時就會保持連線。');
  $('dRemote').onclick=async()=>{const on=!$('dRemote').classList.contains('on'),sw=$('dRemote');sw.disabled=true;swSet(sw,on);
    $('dRemoteNote').innerHTML=on?'<p class="fade">連線中，第一次會下載連線工具，約 30 秒…</p>':'';paint(null);
    try{const r=await api('desktop/remote','POST',{on});REMOTE_URL=on?r.url||'':'';$('dRemoteNote').innerHTML='';paint(r);paintPhones(ph)}
    catch(e){swSet(sw,!on);$('dRemoteNote').innerHTML=`<p class="errmsg">${esc(e.message)}</p>`}finally{sw.disabled=false}}};
// a phone paired with the code (or on an old address): set up /go on it — the page remembers this computer
// (a moment later: closing the sheet steps back in the phone's history, which would cancel the page change)
async function openGoSetup(){try{const g=await api('phone/go'),to=goLink(g.go,g,TOKEN,location.origin);setTimeout(()=>location.assign(to),350)}catch(e){toast(e.message)}}

/* ---------- 工作與排程 ---------- */
const WARMS=[0,30,60,120,300,600,-1];
function warmText(v){return v===0?I18N.t('不待機'):v===-1?I18N.t('永不（一直待機）'):v<60?v+' '+I18N.t('秒'):v/60+' '+I18N.t('分鐘')}
SEC.work=async()=>{
  const all=block('sAll','每個例行任務');all.innerHTML=schedList();
  all.querySelectorAll('[data-rgo]').forEach(b=>b.onclick=()=>{const id=b.dataset.rgo;closeSheet();openConv(id)});
  // 4.11 全力模式: on by default; off brings back the economical limits
  const pw=block('sFull','全力模式','開著：機器人沒有時間、回合和 token 的限制，AI 一直待機，自己一路做到完成或確定做不到才停（需要你核准、回答或登入時會停下等你）。額度用完會等重置後自動繼續；例行任務在額度快用完時自動延後。關掉：恢復省額度的做法（精簡工具、單件工作最長 60 分鐘、待機 2 分鐘、重試最多 2 次）。');
  let st={};try{st=await api('settings')}catch(e){}
  const full=st.full!==false;
  pw.innerHTML=toggleRow('scFull','全力模式',full,'會用比較多 AI 額度。每個機器人也可以在「詳細資料 → AI 與模型」單獨設定。');
  $('scFull').onclick=async()=>{const on=!$('scFull').classList.contains('on');try{await api('settings','PUT',{full:on});S.full=on;S.warm=on?-1:120;swSet($('scFull'),on);toast(I18N.t('已儲存 ✓'));showSection('work')}catch(e){toast(e.message)}};
  const job=block('sJob','單件工作最長時間','一件工作最多做多久就中止。機器人只要還在動作、有在回報進度，就不會被提早中止；超過 20 分鐘完全沒有回報、而且電腦上的執行器也說它不在做了，才會當成中斷。');
  const jm=st.jobMax??(full?0:60),opts=full?[0,15,30,60,120,180]:[15,30,60,120,180];
  job.innerHTML=`<select id="jobMax">${opts.map(v=>`<option value="${v}" ${jm===v?'selected':''}>${v===0?I18N.t('不限'):v<60?v+' '+I18N.t('分鐘'):v/60+' '+I18N.t('小時')}${v===(full?0:60)?' '+I18N.t('（建議）'):''}</option>`).join('')}</select>`;
  $('jobMax').onchange=async e=>{try{await api('settings','PUT',{jobMax:+e.target.value});toast(I18N.t('已儲存 ✓'))}catch(x){toast(x.message)}};
  const rev=block('sRev','每週自我檢討','每週一次，每個有工作的機器人回顧過去 7 天的失敗和被你糾正的事，提出要新增或修改的規則，用「核准」按鈕問你；你按核准才會寫入規則。');
  rev.innerHTML=`${toggleRow('scRev','每週自我檢討',S.review!==false)}<div class="row2"><button type="button" class="ghost sm" id="scRevNow">現在檢討一次</button><span id="scRevMsg" class="hmuted"></span></div>`;
  $('scRev').onclick=async()=>{const on=!$('scRev').classList.contains('on');try{await api('settings','PUT',{review:on});S.review=on;swSet($('scRev'),on);toast(I18N.t('已儲存 ✓'))}catch(e){toast(e.message)}};
  $('scRevNow').onclick=async()=>{$('scRevNow').disabled=true;try{const r=await api('review/run','POST');$('scRevMsg').textContent=I18N.t(r.sent?'已請機器人檢討，有建議會傳到它的對話':'這 7 天沒有失敗或糾正，不用檢討')}catch(e){$('scRevMsg').textContent=e.message}$('scRevNow').disabled=false};
  const more=block('sMore','紀錄與成果');
  more.innerHTML=`<div class="rows"><button type="button" class="rrow" id="goLogs">${ic('list','ri')}<span class="t"><b>工作紀錄</b><small>最近 100 筆執行結果、失敗原因與截圖</small></span>${ic('chev','sa')}</button>
    <button type="button" class="rrow" id="goBoard">${ic('chart','ri')}<span class="t"><b>成果看板</b><small>近 7 天／30 天每個機器人的成果</small></span>${ic('chev','sa')}</button></div>`;
  $('goLogs').onclick=()=>openLogs();$('goBoard').onclick=()=>openBoard()};
// why a job failed, in plain words, with its screenshot and a 重試 button (工作紀錄)
const FAILK={not_logged_in:['需要登入','網站把機器人登出了，或要先登入才能繼續。'],logout:['被登出','網站把機器人登出了。'],api:['API 出錯','用到的網站或服務的 API 沒有正常回應。'],missing:['資料沒出現','應該出現的清單或資料這次沒有出現。'],site_changed:['網頁變了','網頁上找不到要操作的地方，可能改版或跳出了別的畫面。'],quota:['額度用完','AI 的使用額度用完或被限流了。'],interrupted:['中斷','電腦斷線、睡眠或重新啟動，工作做到一半停了。'],timeout:['逾時','做太久，或 AI 很久沒有回應，已中止。'],browser:['瀏覽器沒有回應','機器人的瀏覽器沒有回應，OCTA 自動重開後還是不行。'],tool_error:['工具出錯','瀏覽器、搜尋或其他工具出錯。'],handed:['等你接手','你按了接手，機器人停下來等你處理畫面。'],need_user:['需要你提供資料','機器人缺少資料或看不到要處理的東西，要你補給它。'],unknown:['其他錯誤','執行時發生錯誤。']};
function logFail(l){const k=l.err_kind&&(FAILK[l.err_kind]||FAILK.unknown);if(!k&&l.status!=='error')return '';
  const canRetry=(l.kind||'chat')==='chat'&&l.status==='error'&&!l.retried;
  return `<div class="lfail">${k?`<span class="pill err">${k[0]}</span><span>${k[1]}</span>`:''}${l.retried?'<span class="pill">已自動重試</span>':''}
    ${l.err_msg?`<small data-u>${esc(String(l.err_msg).slice(0,300))}</small>`:''}
    <span class="lact">${l.shot?`<button type="button" class="ghost sm" data-lshot="${esc(l.shot)}">看截圖</button>`:''}${canRetry?`<button type="button" class="ghost sm" data-lretry="${l.id}">↻ 重試</button>`:''}</span></div>`}
async function openLogs(){
  subPage('工作紀錄','<p class="fade">讀取中…</p>',()=>showSection('work'));
  let d={logs:[]};try{d=await api('logs')}catch(e){}
  const dur=l=>l.finished&&l.started?new Intl.NumberFormat(I18N.lang,{style:'unit',unit:'second',unitDisplay:'short'}).format(Math.max(1,Math.round((l.finished-l.started)/1000))):'';
  const stc={done:['ok','完成'],error:['err','失敗'],running:['warn','執行中'],pending:['','排隊']};
  subPage('工作紀錄',`<div class="logs">${d.logs.length?d.logs.map(l=>`<div class="log"><div class="lh">${(()=>{const o=l.status==='done'||l.status==='error'?jobOutcome(l):null;   // 4.8: a run that did not work out is never 完成
    return o&&o.tone!=='ok'?`<span class="pill ${o.tone==='err'?'err':'warn'}">${l.err_kind==='not_logged_in'?'待登入':o.label}</span>`:`<span class="pill ${stc[l.status]?.[0]||''}">${stc[l.status]?.[1]||l.status}</span>`})()}${runUse(l)?`<small class="luse">${esc(runUse(l))}</small>`:''}<b><span data-u>${esc(l.kind==='test'?(ENG[l.url]?.n||l.url):l.bot)}</span>${l.kind==='open'?'<span>（開瀏覽器）</span>':l.kind==='test'?'<span>（連線測試）</span>':l.kind==='code'?'<span>（程式任務）</span>':''}</b><span class="lt">${when(l.created)} ${dur(l)}</span></div><small data-u>${esc(l.convName)}${l.convName?'：':''}${esc(l.prompt)}</small>${logFail(l)}</div>`).join(''):'<p class="hmuted">還沒有紀錄</p>'}</div>`,()=>showSection('work'));
  document.querySelectorAll('[data-lshot]').forEach(b=>b.onclick=()=>openFile(b.dataset.lshot));
  document.querySelectorAll('[data-lretry]').forEach(b=>b.onclick=()=>{b.disabled=true;api('logs/retry','POST',{id:+b.dataset.lretry}).then(()=>{toast(I18N.t('已重新排入，會照原本的指示再做一次'));refresh()}).catch(e=>{b.disabled=false;toast(e.message)})})}
/* results board: per bot, last 7 / 30 days, from the per-day totals */
async function openBoard(span){
  span=span==='d30'?'d30':'d7';
  let d=null;try{d=await api('board')}catch(e){subPage('成果看板',`<p class="errmsg">${esc(e.message)}</p>`,()=>showSection('work'));return}
  const nf=new Intl.NumberFormat(I18N.lang),secs=s=>s==null?'—':s<60?`${s} ${I18N.t('秒')}`:`${Math.floor(s/60)} ${I18N.t('分')} ${s%60} ${I18N.t('秒')}`;
  const mins=m=>m<60?`${m} ${I18N.t('分鐘')}`:`${(m/60).toFixed(1)} ${I18N.t('小時')}`;
  const rows=d.bots.map(b=>({...b,v:b[span]})).filter(b=>b.v.done||b.v.failed).sort((a,b)=>b.v.done-a.v.done);
  const max=Math.max(1,...rows.map(b=>b.v.done+b.v.failed));
  const sum=rows.reduce((a,b)=>({done:a.done+b.v.done,failed:a.failed+b.v.failed,tokens:a.tokens+b.v.tokens,saved:a.saved+b.v.savedMin}),{done:0,failed:0,tokens:0,saved:0});
  subPage('成果看板',`<div class="seg" id="bdSpan" role="group" aria-label="期間"><button type="button" data-span="d7" class="${span==='d7'?'on':''}"><b>近 7 天</b></button><button type="button" data-span="d30" class="${span==='d30'?'on':''}"><b>近 30 天</b></button></div>
  <div class="bdsum"><div><b>${nf.format(sum.done)}</b><small>完成</small></div><div><b>${nf.format(sum.failed)}</b><small>失敗</small></div><div><b>${sum.done+sum.failed?Math.round(sum.done/(sum.done+sum.failed)*100)+'%':'—'}</b><small>成功率</small></div><div><b>${mins(sum.saved)}</b><small>估計省下</small></div></div>
  <div class="board">${rows.length?rows.map(b=>`<div class="bdrow"><div class="bdname"><span data-u>${esc(b.avatar||'🤖')}</span><b data-u>${esc(b.name)}</b><small>${b.v.rate==null?'—':b.v.rate+'%'}</small></div>
    <div class="bdbar" role="img" aria-label="${b.v.done} / ${b.v.failed}"><span class="ok" style="width:${b.v.done/max*100}%"></span><span class="bad" style="width:${b.v.failed/max*100}%"></span></div>
    <div class="bdnums"><span>完成 <b>${nf.format(b.v.done)}</b></span><span>失敗 <b>${nf.format(b.v.failed)}</b></span><span>平均耗時 <b>${secs(b.v.avgSec)}</b></span><span>tokens <b>${b.v.tokens?nf.format(b.v.tokens):'—'}</b></span><span>估計省下 <b>${mins(b.v.savedMin)}</b></span></div></div>`).join(''):'<p class="hmuted">這段期間還沒有完成的工作</p>'}</div>
  <p class="hmuted">「估計省下」是粗略估計：每件完成的工作算 ${d.est.task} 分鐘，有用到瀏覽器的再加 ${d.est.web} 分鐘，不是實際量測。tokens 只計算有回報用量的 AI。最多保留 60 天。</p>`,()=>showSection('work'));
  $('bdSpan').onclick=e=>{const b=e.target.closest('[data-span]');if(b&&b.dataset.span!==span)openBoard(b.dataset.span)}}

/* ---------- 進階 ---------- */
SEC.adv=async arg=>{
  const notes=block('sNotes','共用資料','所有機器人都會讀的固定資訊。只給某個分區的資料，請在側邊欄分區名稱旁的 ⋯ →「分區名稱與資料」填寫。');
  const mail=block('sMail','Gmail（應用程式密碼）','讓機器人讀信、搜尋、整理和寄信，不用開瀏覽器登入 Gmail。密碼只存在這台電腦，不會進對話；寄信前一樣會先問你。');   // 4.7 (mail.js)
  const conn=block('sConn','連接器','有接上的服務，機器人直接問它，金鑰留在這台電腦，不會進對話。沒有接上的，才會改開瀏覽器。');
  const files=block('sFiles','檔案儲存');
  const tpl=block('sTpl','範本','一鍵建立一組常用的機器人，之後都能改名、改任務。');
  const tools=block('sTools','工具');
  const ver=block('sVer','版本與更新');
  if(window.octaDesktop?.isDesktop)paintWipe(block('sWipe','清除這台電腦的所有資料'));   // 4.5: only in the desktop app itself (never on a phone)
  tpl.innerHTML=tplHtml();bindTpl(tpl);
  tools.innerHTML=`<div class="rows"><button type="button" class="rrow" id="goCode">${ic('code','ri')}<span class="t"><b>程式任務</b><small>隔離工作區、測試與差異審查</small></span>${ic('chev','sa')}</button>
    <button type="button" class="rrow" id="goGuide">${ic('help','ri')}<span class="t"><b>重新看一次入門導覽</b><small>連接 AI、建立第一個機器人</small></span>${ic('chev','sa')}</button></div>
    ${DESK()?`<div id="autoRow"></div>`:''}`;
  $('goCode').onclick=()=>openCode();$('goGuide').onclick=()=>{closeSheet();startTour()};
  paintVersion(ver);
  let st={notes:''};try{st=await api('settings')}catch(e){}
  notes.innerHTML=`<textarea id="gNotes" maxlength="20000" class="tall" placeholder="例如：公司名稱、常用網站、聯絡方式、做事原則">${esc(st.notes||'')}</textarea>
  <div class="row2"><button class="btn sm" id="gSave">儲存</button><span class="dflag" data-dirty-flag hidden>有未儲存的變更</span><span id="gMsg" class="hmuted"></span></div>`;
  const save=async()=>{try{await api('settings','PUT',{notes:$('gNotes').value});cleanDirty();$('gMsg').textContent=I18N.t('已儲存 ✓');return true}catch(e){$('gMsg').textContent=e.message;return false}};
  trackDirty(notes,save);
  $('gSave').onclick=async()=>{if(await save())toast(I18N.t('已儲存 ✓'))};
  paintConnectors(conn);
  paintMail(mail);
  paintStore(files);
  if(DESK()){let ds=null;try{ds=await api('desktop/status')}catch(e){}if($('autoRow')){$('autoRow').innerHTML=toggleRow('dAuto','開機自動啟動',!!ds?.autostart,'電腦開機後自動打開 OCTA，例行任務才會準時執行。');
    $('dAuto').onclick=async()=>{const on=!$('dAuto').classList.contains('on');swSet($('dAuto'),on);await api('desktop/autostart','POST',{on}).catch(()=>{})}}}
  if(arg==='ver')$('sVer')?.scrollIntoView({block:'start'})};
async function paintConnectors(el){
  let d={builtins:[],custom:[]};try{d=await api('connectors')}catch(e){}
  const rows=(d.builtins||[]).map(b=>`<div class="kvrow"><span>${esc(b.name)}</span>${b.on?'<span class="pill ok">已接上</span>':'<span class="pill">尚未接上</span>'}</div>`).join('');
  const custom=(d.custom||[]).map(c=>`<div class="kvrow"><span><b data-u>${esc(c.name)}</b> <small class="hmuted" data-u>${esc(c.base)}</small></span><button type="button" class="ghost sm" data-rmc="${esc(c.id)}">移除</button></div>`).join('')||'<p class="hmuted">還沒有自己的服務。</p>';
  el.innerHTML=`<div class="kvs">${rows}</div><p class="hmuted">Telegram／LINE 用「通知」裡的金鑰。接上之後機器人可以送一則文字，送出前仍會先問你。</p>
  <h4>自己的服務</h4><p class="hmuted">只接受公開的 https。機器人可以讀取，送出要先得到你這一次的同意。</p>
  <div class="kvs">${custom}</div>
  <details class="adv"><summary>${ic('plus')}<span>接上一個服務</span></summary><div class="stack" data-nodirty>
  <label class="field"><span>名稱</span><input id="cName" maxlength="20" placeholder="例如 訂單"></label>
  <label class="field"><span>https 網址</span><input id="cBase" placeholder="https://api.example.com/v1"></label>
  <label class="field"><span>金鑰放在哪個標頭</span><input id="cHead" placeholder="Authorization" value="Authorization"></label>
  <label class="field"><span>金鑰</span><input id="cSec" type="password" autocomplete="off"></label>
  <div class="row2"><button class="btn sm" id="cAdd">接上</button><span id="cMsg" class="hmuted"></span></div></div></details>`;
  paintIcons(el);
  $('cAdd').onclick=async()=>{try{await api('connectors','POST',{name:$('cName').value,base:$('cBase').value,header:$('cHead').value,secret:$('cSec').value});toast(I18N.t('已接上'));paintConnectors(el)}catch(e){$('cMsg').textContent=e.message}};
  el.querySelectorAll('[data-rmc]').forEach(b=>b.onclick=async()=>{try{await api('connectors/'+b.dataset.rmc,'DELETE');paintConnectors(el)}catch(e){toast(e.message)}})}
async function paintStore(el){
  if(!DESK()){el.innerHTML=CFG.via?'<p class="hmuted">附件、截圖和機器人做出的檔案都存在主機電腦的 OCTA 資料夾。在這台電腦打開時，會從主機電腦即時讀取並下載。要改存的位置，請在主機電腦上的 OCTA 設定。</p>':'<p class="hmuted">附件、截圖和機器人做出的檔案都存在電腦上的 OCTA 資料夾，每個機器人和群組各有一個資料夾。手機要看時會從電腦即時讀取。要改存的位置，請在電腦上的 OCTA 設定。</p>';return}
  let st=null;try{st=await api('desktop/store')}catch(e){}
  el.innerHTML=`<p class="sdesc">附件、截圖和機器人做出的檔案存在這個資料夾，每個機器人和群組各一個資料夾，機器人之間可以互相讀取。</p>
  <div class="kv"><span>目前位置</span><b data-u class="mono">${esc(st?.path||'')}</b></div>
  <div class="row2"><button class="ghost sm" id="stOpen">${ic('folder')}<span>打開資料夾</span></button></div>
  <div class="bchoice" data-nodirty>
   <label class="bc"><input type="radio" name="stw" value="default" ${st?.isDefault?'checked':''}><span><b>這台電腦（預設）</b><small>OCTA 程式資料夾裡的 files。</small></span></label>
   <label class="bc"><input type="radio" name="stw" value="google" ${st?.onGoogle?'checked':''} ${st?.google?'':'disabled'}><span><b>Google 雲端硬碟</b><small>${st?.google?`<span>存到</span> <span data-u>${esc(st.google)}</span><span>，會自動同步到你的 Google 雲端硬碟，手機也能直接看。</span>`:'需要先安裝「Google 雲端硬碟電腦版」並登入，裝好後重新打開這頁。'}</small></span></label>
   <label class="bc"><input type="radio" name="stw" value="pick" ${!st?.isDefault&&!st?.onGoogle?'checked':''}><span><b>自己選資料夾…</b><small>例如 OneDrive、Dropbox 或外接硬碟。</small></span></label></div>
  ${toggleRow('stMove','把現有檔案一起搬過去',true)}
  <div class="row2"><button class="btn sm" id="stApply">套用</button><span id="stMsg" class="hmuted"></span></div>
  ${st?.google?'':'<p><a href="https://www.google.com/drive/download/" target="_blank" rel="noopener">下載 Google 雲端硬碟電腦版</a></p>'}`;
  paintIcons(el);
  $('stOpen').onclick=()=>api('desktop/open-store','POST').catch(()=>{});
  $('stMove').onclick=()=>swSet($('stMove'),!$('stMove').classList.contains('on'));
  $('stApply').onclick=async()=>{const v=el.querySelector('input[name=stw]:checked')?.value;if(!v)return;
    const b=$('stApply');b.disabled=true;$('stMsg').textContent=I18N.t('套用中，搬移檔案可能要一點時間…');
    try{await api('desktop/store','POST',{set:v,move:$('stMove')?.classList.contains('on')});toast(I18N.t('已儲存 ✓'));paintStore(el)}catch(e){b.disabled=false;$('stMsg').textContent=e.message}}}
/* version & what's new */
let CHANGES=null;
async function changelog(){if(CHANGES)return CHANGES;try{CHANGES=await (await fetch('/changelog.json',{cache:'no-cache'})).json()}catch(e){CHANGES=[]}return CHANGES}
const notesOf=y=>(I18N.lang==='en'&&y.notes_en)||(I18N.lang==='ja'&&y.notes_ja)||y.notes||[];
async function paintVersion(el){
  const log=await changelog(),web=log[0]?.v||'';
  const app=window.octaDesktop?await window.octaDesktop.version().catch(()=>''):'';
  const u=window._upd;
  el.innerHTML=`<div class="kv"><span>介面</span><b data-u>v${esc(web)}</b>${app?`<span>桌面版（這台電腦）</span><b data-u>v${esc(app)}</b>`:''}</div>
  ${!UPD?'':u&&['available','downloading','ready'].includes(u.state)?`<p><span>有新版本</span> <b data-u>v${esc(u.version)}</b></p><div class="row2"><button class="btn sm" id="vGo">${u.state==='ready'?'重新啟動並更新':u.state==='downloading'?'下載中…':'更新'}</button></div>${u.notes?`<pre class="notes" data-u>${esc(u.notes)}</pre>`:''}`
    :`<div class="row2"><button class="ghost sm" id="vChk">檢查更新</button><span id="vMsg" class="hmuted"></span></div>`}
  <div class="row2"><button class="link" id="vLog">${ic('list')}<span>看全部更新內容</span></button></div>`;
  paintIcons(el);
  $('vLog').onclick=()=>openChanges();
  if($('vGo'))$('vGo').onclick=()=>{if(u.state==='ready'){boot.show(I18N.t('正在更新，OCTA 會自動重新開啟…'));UPD.install()}else if(u.state!=='downloading'){UPD.download();toast(I18N.t('下載新版本中…'));closeSheet()}};
  if($('vChk'))$('vChk').onclick=async()=>{$('vMsg').textContent=I18N.t('檢查中…');let x=await UPD.check();
    for(let i=0;i<20&&['idle','checking'].includes(x.state);i++){await new Promise(r=>setTimeout(r,700));x=await UPD.status()}
    renderUpd(x);if(['available','ready','downloading'].includes(x.state))return paintVersion(el);
    $('vMsg').textContent=I18N.t(x.state==='none'?'已是最新版':x.state==='error'?'無法檢查更新':'檢查中…')}}
async function openChanges(){const log=await changelog();
  subPage('更新內容',`<div class="chg">${log.map(x=>`<div><b data-u>v${esc(x.v)}</b> <small data-u>${esc(x.date||'')}</small><ul data-u>${notesOf(x).map(n=>`<li>${esc(n)}</li>`).join('')}</ul></div>`).join('')||'<p>讀不到更新內容</p>'}</div>`,()=>showSection('adv','ver'))}
// once after every update: what the latest version added
async function whatsNew(){const log=await changelog(),x=log[0];if(!x)return;const seen=store.get('octa_seen_v');store.set('octa_seen_v',x.v);
  if(seen===x.v||(!seen&&!S.bots.length)||!$('veil').hidden)return;
  let k=seen?log.findIndex(y=>y.v===seen):-1;if(k<1)k=1;const vs=log.slice(0,Math.min(k,4));
  openSheet(`${sheetHead('更新完成')}<p><span>OCTA 已更新到</span> <b data-u>v${esc(x.v)}</b><span>，這次新增了：</span></p>${vs.map(y=>`${vs.length>1?`<p class="hmuted" data-u>v${esc(y.v)}</p>`:''}<ul class="chg" data-u>${notesOf(y).map(n=>`<li>${esc(n)}</li>`).join('')}</ul>`).join('')}<div class="acts"><button class="ghost" id="wnAll">看全部更新內容</button><button class="btn" id="sx">好</button></div>`);
  $('sx').onclick=closeSheet;$('wnAll').onclick=()=>{closeSheet();openSettings('adv');openChanges()}}

/* ---------- language ---------- */
function setLang(l){I18N.set(l);api('settings','PUT',{lang:l}).catch(()=>{})}
window.addEventListener('octa-lang',()=>{if(S.loaded)render(false);if(detailOpen()&&!isDirty())paintDetail(false)});
$('settings').onclick=()=>openSettings();
