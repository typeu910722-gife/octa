/* OCTA web app — first run (connect an AI → create the first bot), the empty states, and phone pairing. */
'use strict';
const TOUR={force:false,chrome:null};
const ONB_ENG=['claude','codex','gemini','opencode'];
function tourOn(){return S.loaded&&(TOUR.force||(!S.bots.length&&!store.get('ebot_guided')))}
function startTour(){TOUR.force=true;cur=null;store.set('ebot_cur',null);$('app').classList.remove('chat');if(detailOpen())closeDetail();render(false);
  if(DESK()&&TOUR.chrome==null)api('desktop/status').then(d=>{TOUR.chrome=!!d?.chrome;paintTour()}).catch(()=>{})}
function endTour(){TOUR.force=false;store.set('ebot_guided','1');render(false)}
function renderBlank(){const b=$('blank');
  if(!S.loaded){setHTML(b,'');return}
  if(tourOn()){if(!b.querySelector('.onb')){b.innerHTML=`<div class="onb"><div class="onb-hd"><img src="/icon.png" alt="" class="onb-logo"><h1>歡迎使用 OCTA</h1>
      <p>用聊天指揮你的 AI 小幫手。它們在這台電腦上工作，用的是你自己的 AI 帳號，付錢、刪除、傳訊息給別人之前都會先問你。</p></div>
      ${DESK()?`<div class="onb-pc"><span class="oe-t"><b>已經有一台電腦在用 OCTA？</b><small>把這台電腦當那台的遙控器：看到同一份機器人和對話，工作都在那台電腦上做。</small></span><button type="button" class="ghost sm" id="onbPc">${ic('monitor')}<span>連到另一台電腦（當遙控器）</span></button></div>`:''}
      <ol class="onb-steps"><li class="step" id="onb1"></li><li class="step" id="onb2"></li></ol>
      <div class="onb-ft"><button type="button" class="link" id="onbSkip">先跳過，我自己看看</button></div></div>`;b._h='';
      $('onbSkip').onclick=endTour;if($('onbPc'))$('onbPc').onclick=()=>linkSheet(false);paintIcons(b);
      if(DESK()&&TOUR.chrome==null)api('desktop/status').then(d=>{TOUR.chrome=!!d?.chrome;paintTour()}).catch(()=>{})}
    paintTour();return}
  if(!S.bots.length){setHTML(b,`<div class="empty-state"><span class="es-ic">${ic('bot')}</span><h2>還沒有機器人</h2><p>取個名字，然後直接跟它說要做什麼；或從範本開始。</p><div class="row2 center"><button type="button" class="btn" data-blank="new">${ic('plus')}<span>新機器人</span></button><button type="button" class="ghost" data-blank="tour">入門導覽</button></div>${tplHtml()}</div>`);bindTpl(b);return}
  setHTML(b,`<div class="empty-state"><img src="/icon.png" alt="" class="es-logo"><h2>選一個機器人，直接跟它說</h2><p>檔案丟進對話就會附上，文字拖進輸入框就會貼上。</p>
    <div class="tips"><div><kbd data-u>${/Mac/.test(navigator.platform)?'⌘':'Ctrl'} K</kbd><span>搜尋機器人</span></div><div><kbd data-u>Alt N</kbd><span>新機器人</span></div><div><kbd data-u>/</kbd><span>在輸入框叫出指令</span></div><div><kbd data-u>@</kbd><span>在群組指定成員</span></div></div></div>`)}
document.addEventListener('click',e=>{const a=e.target.closest('[data-blank]');if(!a)return;if(a.dataset.blank==='new')newBotSheet();else startTour()});
function paintTour(){const s1=$('onb1'),s2=$('onb2');if(!s1||!s2)return;
  const ok=anyAI(),online=S.runnerOnline,desk=DESK();
  const eng=k=>{const e=ENG[k],stt=engState(k),t=aiTests[k];
    const act=stt==='ok'?`<span class="pill ok">${ic('check')}<span>已連接</span></span>`
      :t==='run'?'<span class="pill warn">測試中…</span>'
      :desk?`<button type="button" class="ghost sm" data-oinst="${k}">一鍵安裝並登入</button><button type="button" class="ghost sm" data-otest="${k}" ${online?'':'disabled'}>測試</button>`
      :`<button type="button" class="ghost sm" data-orin="${k}" ${online?'':'disabled'}>在電腦上安裝</button><button type="button" class="ghost sm" data-otest="${k}" ${online?'':'disabled'}>測試</button>`;
    return `<div class="oeng${stt==='ok'?' on':''}"><span class="oe-t"><b>${e.n}</b>${e.tag?`<span class="pill tag">${e.tag}</span>`:''}<small>${esc(e.who)}</small>${t&&t!=='run'&&!t.ok?`<small class="errmsg" data-u>${esc(String(t.text).slice(0,160))}</small>`:''}</span><span class="oe-a">${act}</span></div>`};
  setHTML(s1,`<span class="sn">${ok?ic('check'):'1'}</span><div class="sc"><h3>連接一個 AI</h3><p>選一個你已經有帳號的 AI。最推薦 Claude；沒有付費方案可以先用 Gemini 的免費額度，或電腦上的 Ollama。</p>
    ${!online?`<p class="note-box">${DESK()?'OCTA 正在準備這台電腦，稍等一下按鈕就能按。':'電腦上的 OCTA 沒有在執行。打開電腦上的 OCTA 後，就能在這裡安裝和測試。'}</p>`:''}
    ${TOUR.chrome===false?`<p class="note-box warn">${ic('info')}<span>找不到 Google Chrome。機器人用 Chrome 操作網站，請先</span> <a href="https://www.google.com/chrome/" target="_blank" rel="noopener">下載 Chrome</a>。</p>`:''}
    <div class="oengs">${ONB_ENG.map(eng).join('')}</div>
    <button type="button" class="link" data-oall>${ic('plug')}<span>更多 AI 與手動安裝方式</span></button></div>`);
  s1.className='step'+(ok?' done':' now');
  if(!s2.dataset.ready){s2.dataset.ready='1';
    s2.innerHTML=`<span class="sn">2</span><div class="sc"><h3>建立第一個機器人</h3><p>取個名字就好，建立後直接跟它說要做什麼。也可以從範本開始。</p>
      <form class="row2" id="onbNew"><input id="onbName" class="grow" maxlength="20" placeholder="例如：客服小幫手" autocomplete="off" aria-label="名稱"><button class="btn">建立</button></form><p class="errmsg" id="onbE"></p>
      <details class="adv"><summary>${ic('sparkle')}<span>從範本開始</span></summary>${tplHtml()}</details></div>`;
    paintIcons(s2);
    bindTpl(s2,()=>{endTour();const b=S.bots[S.bots.length-1];if(b)openConv(b.id)});
    $('onbNew').onsubmit=async e=>{e.preventDefault();const raw=$('onbName').value.trim(),name=raw||freeName(I18N.t('新機器人'),S.bots.map(b=>b.name));
      const bad=raw?nameProblem(raw,''):'';if(bad){$('onbE').textContent=I18N.t(bad);return}
      try{const r=await api('bots','POST',{name,task:'',engine:firstEngine(),avatar:'🤖'});store.set('ebot_guided','1');TOUR.force=false;await refresh();openConv(r.id);
        $('msg').placeholder=I18N.t('跟它說要幫你做什麼…');$('msg').focus()}catch(err){$('onbE').textContent=err.message}}}
  s2.className='step'+(ok?' now':'');
  s1.querySelectorAll('[data-oinst]').forEach(b=>b.onclick=async()=>{b.disabled=true;try{await api('desktop/install','POST',{engine:b.dataset.oinst});b.textContent=I18N.t('已打開安裝視窗');toast(I18N.t('照黑色視窗的說明登入，完成後按「測試」'))}catch(e){b.disabled=false;alertSheet('無法開啟',e.message)}});
  s1.querySelectorAll('[data-orin]').forEach(b=>b.onclick=async()=>{b.disabled=true;try{await api('engine-install','POST',{engine:b.dataset.orin});toast(I18N.t('電腦會打開安裝視窗，登入步驟要在電腦上完成'))}catch(e){b.disabled=false;toast(e.message)}});
  s1.querySelectorAll('[data-otest]').forEach(b=>b.onclick=()=>testAI(b.dataset.otest));
  const all=s1.querySelector('[data-oall]');if(all)all.onclick=()=>openSettings('ai')}

/* ---------- the phone: pair with the code shown on the computer ---------- */
let PAIRED_NOW=false;
// 4.4: just paired with the code: offer the home-screen shortcut (/go) so the next restart of the computer needs no pairing
function goHint(){confirmSheet('把 OCTA 加到手機主畫面',`<p>${I18N.t('電腦每次重開，這個網址都會換。從主畫面的捷徑打開，就會自動找到電腦，不用再配對。')}</p>${goHow()}`,'設定捷徑',false,()=>openGoSetup())}
function showPair(){$('app').hidden=true;$('pair').hidden=false;closeSheet(true);boot.hide();
  toShell('unpaired');   // 4.14.1 inside /go: it explains how to pair this phone again (and can let you type a code here)
  $('pairLang').innerHTML=I18N.select('pairLangSel');$('pairLangSel').onchange=e=>I18N.set(e.target.value);
  setTimeout(()=>$('pairCode').focus(),50)}
$('pairCode').addEventListener('input',e=>{const v=pairCode(e.target.value);if(v!==e.target.value)e.target.value=v;$('pairErr').textContent=''});
$('pairForm').onsubmit=async e=>{e.preventDefault();const code=pairCode($('pairCode').value);
  if(code.length<4){$('pairErr').textContent=I18N.t('請輸入電腦上顯示的配對碼');return}
  $('pairGo').disabled=true;$('pairErr').textContent='';
  try{const d=await api('pair','POST',{code});TOKEN=d.token;store.set('ebot_token',TOKEN);PAIRED_NOW=!SHELL;if(SHELL){toShell('paired',{t:TOKEN});try{history.replaceState(history.state,'',location.pathname+'#'+new URLSearchParams({t:TOKEN,go:GOF.go,sh:'1'}))}catch(e){}}$('pairCode').value='';$('pair').hidden=true;boot.show(I18N.t('連線中…'));start()}
  catch(err){$('pairErr').textContent=err.message}finally{$('pairGo').disabled=false}};
