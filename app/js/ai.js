/* OCTA web app — AI connections: install / sign in / test each AI, remaining quota, AI 待機, Grok Bot handoff. */
'use strict';
const aiTests={},rmsgs={};
function aiInstallCmd(e,os){return e.npm?`npm install -g ${e.npm}`:e[os]}
const pct=n=>Math.max(0,Math.min(100,Math.round(n)));
function quotaHtml(k,U){   // how much of the plan is left, as far as each service lets us know
  const e=ENG[k],stt=engState(k),u=U?.usage?.[k],n=U?.today?.[k]||0;
  if(stt==='no')return '';
  if(stt==='unknown')return '<span class="qt off">電腦上的 OCTA 沒有在執行，無法檢查</span>';
  const today=n?`<small><span>今天 OCTA 用了</span> ${n} <span>次</span></small>`:'';
  if(e.quota==='local')return '<span class="qt">本機 AI，無流量限制</span>';
  if(e.quota==='plan'){
    if(u?.windows?.length){const lab={'5h':'5 小時內','7d':'本週','30d':'本月'};
      return `${u.plan?`<small data-u>${esc(u.plan)}</small>`:''}<span class="qws">${u.windows.map(w=>`<span class="qw"><span class="ql">${lab[w.k]||(/^\d+h$/.test(w.k)?parseInt(w.k)+' 小時內':esc(w.k))}</span><span class="bar"><i style="width:${pct(100-w.used)}%"></i></span><b><span>剩</span> ${pct(100-w.used)}%</b>${w.reset?`<small><span>重置</span> ${when(Date.parse(w.reset))}</small>`:''}</span>`).join('')}</span>${today}`}
    return `${u?.plan?`<small data-u>${esc(u.plan)}</small>`:''}<span class="qt off">${u?.error?'無法讀取剩餘流量':'正在讀取剩餘流量…'}</span>${today}`}
  return `<span class="qt off">官方沒有提供剩餘流量查詢</span>${e.limit?`<small>${e.limit}</small>`:''}${today}`}
SEC.ai=focus=>{
  const el=block('aiBlock','','機器人用這台電腦上登入的 AI 工作，用的是你自己的帳號或訂閱。連一個就能開始，之後在每個機器人的「詳細資料 → AI 與模型」選要用哪個。');
  el.id='aiCards';openAI(focus);
  const warm=block('sWarm','AI 待機','機器人回覆完後，讓它的 AI 保持待機多久。待機中再傳訊息會直接接著做，回覆快很多；待機越久越省等待時間，但會一直佔用一點電腦記憶體。目前只有 Claude 支援待機。');
  warm.innerHTML=`<select id="warmSel" aria-label="AI 待機">${WARMS.map(v=>`<option value="${v}" ${(S.warm??120)===v?'selected':''}>${warmText(v)}${v===120?' '+I18N.t('（建議）'):''}${v===0?' — '+I18N.t('每則訊息都重新啟動 AI（最省記憶體，最慢）'):v===-1?' — '+I18N.t('一直待機，回覆最快；電腦記憶體較少時不建議'):''}</option>`).join('')}</select>`;
  $('warmSel').onchange=async e=>{try{await api('settings','PUT',{warm:+e.target.value});S.warm=+e.target.value;toast(I18N.t('已儲存 ✓'))}catch(x){toast(x.message)}};
  const gb=block('sGrok','Grok Bot ⇄ OCTA','Grok Bot 在 xAI 的雲端工作，可以把任務交派給 OCTA 的機器人：它呼叫一個「交接網址」，指定的 OCTA 機器人就會在你的電腦上自動開始做，結果出現在那個機器人的對話裡。');
  paintGrok(gb)};
/* 4.5: the Grok Bot app for Windows doesn't write the sign-in file grok-bot-cli needs, so on a Windows host only the
   交接網址 is offered (Grok Bot calls OCTA): no install, test or import, and nothing is tried in the background */
const grokWin=()=>S.hostOs==='win32';
function paintGrok(gb){
  const win=grokWin();
  gb.innerHTML=`${win?`<div class="note-box warn" id="gbWin">${ic('info')}<span><b>Windows 不支援，請改用交接網址</b><br><span>Windows 版的 Grok Bot App 不會產生 grok-bot-cli 需要的登入檔，所以無法把 Grok Bot 帶進 OCTA。改成讓 Grok Bot 用交接網址把工作交給 OCTA 的機器人（下面的步驟）。</span></span><button type="button" class="ghost sm" id="gbGoHook">取得交接網址</button></div>`:''}
  <ol class="ol"><li>在下面選一個要接任務的 OCTA 機器人，按「產生交接網址」。</li><li>按「複製給外部 AI 的說明」，貼到 Grok Bot 的對話（或它那個機器人的指示／記憶裡），讓它記住。</li><li>之後跟 Grok Bot 說「把○○交給 OCTA 的△△」，它就會自己傳過來、查結果，不滿意可以叫它指正重做。</li></ol>
  ${hookNote()}
  <div class="rows" id="gbRows">${S.bots.length?S.bots.map(b=>{const r=S.routines.find(x=>x.conv===b.id&&x.hook&&x.name==='外部交接');
    return `<div class="kvrow"><span data-u>${esc(b.avatar||'🤖')} ${esc(b.name)}</span>${r?`<button type="button" class="ghost sm" data-hookspec="${esc(r.id)}">複製給外部 AI 的說明</button>`:`<button type="button" class="ghost sm" data-gbhook="${b.id}">產生交接網址</button>`}</div>`}).join(''):'<p class="hmuted">還沒有機器人，先建立一個。</p>'}</div>
  <p class="hmuted">交接網址等同鑰匙，只給你信任的 AI，不要公開。要停用時，到那個機器人的例行任務，關掉「外部交接」。</p>
  ${win?'':`<div class="row2"><button type="button" class="ghost sm" data-gbimport ${S.runnerOnline?'':'disabled'}>${ic('bot')}<span>帶入 Grok Bot 的機器人…</span></button></div>`}`;
  paintIcons(gb);
  gb.querySelectorAll('[data-gbhook]').forEach(b=>b.onclick=async()=>{b.disabled=true;try{await api('routines','POST',{conv:b.dataset.gbhook,name:'外部交接',trigger:'hook',prompt:'其他 AI 把工作交接給你：照交接內容處理，完成後在這裡回報結果；資訊不夠就直接問使用者。'});await refresh();paintGrok(gb)}catch(e){toast(e.message);b.disabled=false}});
  if($('gbGoHook'))$('gbGoHook').onclick=()=>{const rows=$('gbRows');rows.scrollIntoView({behavior:'smooth',block:'center'});const f=rows.querySelector('button');if(f)f.focus({preventScroll:true})};
  const imp=gb.querySelector('[data-gbimport]');if(imp)imp.onclick=grokImport}
// an AI got installed (live update): redraw the cards if they are on screen
function engineChanged(){if($('aiCards')&&!$('veil').hidden)openAI()}
async function openAI(focus){
  if(!$('aiCards')){openSettings('ai',focus);return}
  const box=$('aiCards'),online=S.runnerOnline,desk=DESK();
  // redrawing (after a test or live update) keeps the cards you opened and where you scrolled
  const keepOpen=[...box.querySelectorAll('.aic[open]')].map(d=>d.dataset.k),keepTop=$('sbody')?.scrollTop||0;
  if(!box.querySelector('.ais'))box.innerHTML='<p class="fade">讀取中…</p>';
  let U=null;try{U=await api('ai-usage');if(U.engines)S.engines=U.engines}catch(e){}
  for(const [k,t] of Object.entries(aiTests))if(t&&t.ok&&S.engines)S.engines[k]=true;   // a passing test means it's connected
  const card=k=>{const e=ENG[k],stt=engState(k),t=aiTests[k];
    const badge=stt==='ok'?'<span class="pill ok">已連接</span>':stt==='no'?'<span class="pill">未連接</span>':'<span class="pill">無法檢查</span>';
    const pre=e.pre?`<li><a href="https://ollama.com/download" target="_blank" rel="noopener">先下載安裝 Ollama</a></li>`:'';
    const steps=desk?`<div class="row2"><button class="btn sm" data-install="${k}">${stt==='ok'?'重新安裝':'一鍵安裝並登入'}</button><button class="ghost sm" data-test="${k}" ${online?'':'disabled'}>測試</button></div>
      <p class="hmuted">${stt==='ok'?'已安裝。如果測試失敗，按「重新安裝」重新登入。':`<span>會打開一個黑色視窗自動安裝，接著：</span>${esc(e.hint)}<span>。</span>`}${e.npm?' <span>這個工具需要先裝</span> <a href="https://nodejs.org" target="_blank" rel="noopener">Node.js</a>。':''}</p>`
     :`<div class="row2"><button class="btn sm" data-rinstall="${k}" ${online?'':'disabled'}>${stt==='ok'?'在電腦上重新安裝':'在電腦上一鍵安裝'}</button><button class="ghost sm" data-test="${k}" ${online?'':'disabled'}>測試</button></div>
      <p class="hmuted">${online?`<span>電腦會自動打開安裝視窗並安裝，裝好這裡會變成「已連接」。登入步驟要在電腦上完成：</span><span>${esc(e.hint)}</span>`:'電腦上的 OCTA 開著時才能安裝和測試。'}</p><p class="fade" data-rmsg="${k}">${esc(rmsgs[k]||'')}</p>`;
    const manual=`<details class="manual"><summary>改成手動安裝</summary><ol class="ol">${pre}<li><span>安裝（PowerShell）：</span><pre class="code">${esc(aiInstallCmd(e,'win'))}</pre>${e.npm?'':`<small>Mac：<code>${esc(aiInstallCmd(e,'mac'))}</code></small>`}</li>
      <li>${e.pre?'下載模型':'登入'}：<span>輸入</span> <code>${esc(e.login)}</code>，${esc(e.hint)}</li><li>回到這裡按「測試」</li></ol></details>`;
    const res=t?(t==='run'?'<p class="fade">測試中，第一次可能要一分鐘…</p>':t.ok?'<p class="okt">成功！這個 AI 可以用了。</p>':`<p class="errmsg" data-u>${esc(t.text)}</p>`):'';
    return `<details class="aic${stt==='ok'?' on':''}" data-k="${k}" ${focus===k?'open':''}><summary><span class="aih"><b>${e.n}</b>${e.tag?` <span class="pill tag">${e.tag}</span>`:''}${badge}</span><small class="aigood">${esc(e.good)}</small><span class="aiq">${quotaHtml(k,U)}</span></summary>
      <div class="aib"><p><span>適合：</span>${esc(e.who)}<span>。</span>${esc(e.cost)}<span>。</span></p>${steps}${res}${manual}<p><a href="${e.site}" target="_blank" rel="noopener">官方說明</a></p></div></details>`};
  if(!$('aiCards'))return;
  box.innerHTML=`<div class="ais">${Object.keys(ENG).filter(k=>!ENG[k].hide&&k!=='grokbot').map(card).join('')}</div>
  <p class="hmuted">剩餘流量每 10 分鐘更新一次。Claude 與 ChatGPT 會顯示方案剩下的比例；其他服務沒有提供查詢，改顯示 OCTA 今天用了幾次。</p>`;
  box.querySelectorAll('pre.code').forEach(p=>p.insertAdjacentHTML('afterend',`<div class="row2"><button type="button" class="ghost sm" data-copy="${esc(p.textContent)}">複製</button></div>`));
  box.querySelectorAll('[data-install]').forEach(b=>b.onclick=async()=>{b.disabled=true;try{await api('desktop/install','POST',{engine:b.dataset.install});b.textContent=I18N.t('已打開安裝視窗')}catch(e){b.disabled=false;alertSheet('無法開啟',e.message)}});
  box.querySelectorAll('[data-test]').forEach(b=>b.onclick=()=>testAI(b.dataset.test));
  box.querySelectorAll('[data-rinstall]').forEach(b=>b.onclick=async()=>{const k=b.dataset.rinstall,say=t=>{rmsgs[k]=t;const m=box.querySelector(`[data-rmsg="${k}"]`);if(m)m.textContent=t};b.disabled=true;say(I18N.t('正在通知電腦…'));
    try{const {id}=await api('engine-install','POST',{engine:k});const t0=Date.now();let j=null;
      while(Date.now()-t0<60000){await new Promise(r=>setTimeout(r,2000));j=await api('job/'+id);if(j.status==='done'||j.status==='error')break}
      say(j&&(j.status==='done'||j.status==='error')?(j.result||''):I18N.t('一分鐘內沒有回應，請確認電腦上的 OCTA 開著'))}catch(e){say(e.message)}b.disabled=false});
  keepOpen.forEach(k=>{const d=box.querySelector(`.aic[data-k="${k}"]`);if(d)d.open=true});if($('sbody'))$('sbody').scrollTop=keepTop;
  if(typeof paintTour==='function')paintTour();
}
/* bring bots from Grok Bot into OCTA: the computer lists them, you pick */
async function grokImport(){
  const back=()=>showSection('ai','grokbot');
  subPage('帶入 Grok Bot 的機器人','<p class="fade">正在讀取你在 Grok Bot 的機器人（電腦上的 OCTA 要開著）…</p>',back);
  let list=null,errm='';
  try{const {id}=await api('grokbot/list','POST');const t0=Date.now();
    while(Date.now()-t0<90000){await new Promise(r=>setTimeout(r,2500));const j=await api('job/'+id);
      if(j.status==='done'||j.status==='error'){const d=JSON.parse(j.result||'null');if(Array.isArray(d))list=d;else errm=d?.error||j.result;break}}
    if(!list&&!errm)errm=I18N.t('一分半內沒有回應，請確認電腦上的 OCTA 開著');
  }catch(e){errm=e.message}
  if(!list||!list.length){subPage('帶入 Grok Bot 的機器人',`<p class="errmsg">${esc(errm||I18N.t('沒有找到任何 Grok Bot 機器人'))}</p><p>請先在這台電腦安裝並登入 Grok Bot 桌面 App，再到「AI 連線」安裝 Grok Bot。</p>`,back);return}
  const have=new Set(S.bots.filter(b=>b.engine==='grokbot').map(b=>b.model));
  subPage('帶入 Grok Bot 的機器人',`<p>勾選要帶進 OCTA 的機器人。帶進來後在 OCTA 傳訊息給它，會轉交給 Grok Bot 裡的它在雲端完成，再把回覆帶回來；排程、事件觸發、核准和通知都用 OCTA 的。</p>
    <div class="picks" id="gbl">${list.map((b,i)=>`<label class="pick"><input type="checkbox" value="${i}" ${have.has(b.name)?'disabled':'checked'}><span data-u class="grow"><b>${esc(b.name)}</b>${b.description?`<br><small class="hmuted">${esc(b.description.slice(0,120))}</small>`:''}</span>${have.has(b.name)?`<small>${esc(I18N.t('已帶入'))}</small>`:''}</label>`).join('')}</div>
    <div class="row2"><button class="btn sm" id="gbGo">帶入選取的機器人</button><span id="gbMsg" class="hmuted"></span></div>`,back);
  $('gbGo').onclick=async()=>{const picks=[...$('gbl').querySelectorAll('input:checked')].map(x=>list[+x.value]);if(!picks.length)return;$('gbGo').disabled=true;let n=0;
    for(const b of picks){let name=b.name.slice(0,20);if(S.bots.some(x=>x.name===name))name=(b.name.slice(0,15)+'（Grok）');
      try{await api('bots','POST',{name,task:b.description||'',engine:'grokbot',model:b.name,avatar:'🤖'});n++}catch(e){$('gbMsg').textContent=e.message}}
    await refresh();toast(I18N.t('已帶入')+' '+n);closeSheet()}}
async function testAI(k){
  aiTests[k]='run';openAI(k);
  try{const {id}=await api('engine-test','POST',{engine:k});const t0=Date.now();
    while(Date.now()-t0<180000){await new Promise(r=>setTimeout(r,3000));const j=await api('job/'+id);
      if(j.status==='done'||j.status==='error'){aiTests[k]={ok:j.status==='done',text:j.result||''};break}}
    if(aiTests[k]==='run')aiTests[k]={ok:false,text:I18N.t('三分鐘內沒有結果，請看電腦上的 OCTA 是否開著。')};
  }catch(e){aiTests[k]={ok:false,text:e.message}}
  await refresh();if($('aiCards'))openAI(k);if(typeof paintTour==='function')paintTour()}
