/* OCTA web app — 設定 → 進階 → Gmail（應用程式密碼） (4.7 郵件連接器). */
'use strict';
/* ---------- 4.7 Gmail with an app password ----------
   Bots read, search, tidy and send mail over IMAP / SMTP, without signing in to Gmail in a browser (Google refuses
   sign-in inside embedded browsers). The password is kept on the computer and only ever comes back masked (••••abcd).
   Sending still waits for the user's 核准 (or 一律允許). Other providers (Yahoo, iCloud, Outlook, your own server)
   use the 進階 fields. */
const MAIL_PROV=[['gmail','Gmail'],['yahoo','Yahoo'],['icloud','iCloud'],['outlook','Outlook'],['custom','自訂主機']];
const MAIL_DEF={gmail:['imap.gmail.com',993,'smtp.gmail.com',465],yahoo:['imap.mail.yahoo.com',993,'smtp.mail.yahoo.com',465],icloud:['imap.mail.me.com',993,'smtp.mail.me.com',587],outlook:['outlook.office365.com',993,'smtp.office365.com',587],custom:['',993,'',465]};
const mailGuess=u=>{const d=String(u||'').split('@')[1]?.toLowerCase()||'';return /^(gmail|googlemail)\.com$/.test(d)?'gmail':/^(yahoo|ymail)\./.test(d)?'yahoo':/^(icloud|me|mac)\.com$/.test(d)?'icloud':/^(outlook|hotmail|live|msn)\./.test(d)?'outlook':''};
async function paintMail(el){
  let d={mail:[]};try{d=await api('connectors')}catch(e){}
  const list=d.mail||[];
  const rows=list.map(c=>`<div class="kvrow"><span class="grow"><b data-u>${esc(c.name)}</b> <small class="hmuted" data-u>${esc(c.user)}</small> <small class="hmuted mono" data-u>${esc(c.secret||'')}</small></span>
    <span class="row2"><button type="button" class="ghost sm" data-mtest="${esc(c.id)}">測試連線</button><button type="button" class="ghost sm" data-medit="${esc(c.id)}">更改</button><button type="button" class="ghost sm" data-mrm="${esc(c.id)}">移除</button></span></div>
    <p class="hmuted" id="mres_${esc(c.id)}" role="status"></p>`).join('');
  el.innerHTML=`${list.length?`<div class="kvs">${rows}</div>`:''}
  <details class="adv" id="mForm"${list.length?'':' open'}><summary>${ic('plus')}<span id="mFormT">${list.length?'接上另一個信箱':'接上 Gmail'}</span></summary><div class="stack" data-nodirty></div></details>`;
  paintIcons(el);
  const form=(c)=>{const box=el.querySelector('#mForm .stack'),p=c?.provider||'gmail',dv=MAIL_DEF[p];
    box.innerHTML=`<input type="hidden" id="mId" value="${esc(c?.id||'')}">
    <label class="field"><span>電子郵件</span><input id="mUser" type="email" autocomplete="off" spellcheck="false" placeholder="you@gmail.com" value="${esc(c?.user||'')}"></label>
    <label class="field"><span>應用程式密碼</span><input id="mPass" type="password" autocomplete="new-password" spellcheck="false" placeholder="${c?esc(c.secret):'16 個英文字母'}"></label>
    <div id="mHow"></div>
    <details class="adv"><summary>${ic('sliders')}<span>進階：其他信箱或自訂主機</span></summary><div class="stack">
      <label class="field"><span>信箱服務</span><select id="mProv">${MAIL_PROV.map(([k,n])=>`<option value="${k}"${k===p?' selected':''}>${n}</option>`).join('')}</select></label>
      <label class="field"><span>名稱（機器人用這個名字叫它）</span><input id="mName" maxlength="20" placeholder="Gmail" value="${esc(c?.name||'')}"></label>
      <div class="row2"><label class="field grow"><span>收信伺服器（IMAP）</span><input id="mIH" spellcheck="false" value="${esc(c?.imapHost||dv[0])}"></label><label class="field"><span>連接埠</span><input id="mIP" inputmode="numeric" size="5" value="${esc(String(c?.imapPort||dv[1]))}"></label></div>
      <div class="row2"><label class="field grow"><span>寄信伺服器（SMTP）</span><input id="mSH" spellcheck="false" value="${esc(c?.smtpHost||dv[2])}"></label><label class="field"><span>連接埠</span><input id="mSP" inputmode="numeric" size="5" value="${esc(String(c?.smtpPort||dv[3]))}"></label></div>
      <p class="hmuted">連線一律加密：993、465 一開始就加密，其他連接埠用 STARTTLS；伺服器不支援加密就不連。</p></div></details>
    <div class="row2"><button type="button" class="ghost sm" id="mTest">測試連線</button><button type="button" class="btn sm" id="mSave">儲存</button>${c?'<button type="button" class="ghost sm" id="mCancel">取消</button>':''}</div>
    <p class="hmuted" id="mMsg" role="status"></p>`;
    paintIcons(box);
    const how=()=>{const pv=$('mProv').value;$('mHow').innerHTML=pv==='gmail'?`<ol class="ol">
      <li><span>到 Google 帳戶開啟</span> <a href="https://myaccount.google.com/signinoptions/twosv" target="_blank" rel="noopener">兩步驟驗證</a><span>（已經開了就跳過）。</span></li>
      <li><span>打開</span> <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noopener">myaccount.google.com/apppasswords</a><span>（會用你的瀏覽器打開）。</span></li>
      <li>輸入一個名稱，例如 OCTA，按「建立」。</li>
      <li>把畫面上的 16 個英文字母貼到上面的「應用程式密碼」（中間的空格會自動拿掉），按「測試連線」再「儲存」。</li></ol>
      <p class="hmuted">這組密碼只給 OCTA 用，不是你平常登入 Gmail 的密碼；隨時可以在同一頁刪掉。公司或學校的帳號看不到這個選項時，要請管理員開放。</p>`
      :`<p class="hmuted">${pv==='outlook'?'Outlook／Hotmail 個人帳號已經不接受應用程式密碼登入信箱，可能連不上；公司帳號要管理員開放。':'到信箱服務的帳戶安全設定建立「應用程式密碼」，貼到上面。'}</p>`};
    how();
    $('mProv').onchange=()=>{const v=MAIL_DEF[$('mProv').value];$('mIH').value=v[0];$('mIP').value=v[1];$('mSH').value=v[2];$('mSP').value=v[3];how()};
    $('mUser').oninput=()=>{const g=mailGuess($('mUser').value);if(g&&g!==$('mProv').value&&!$('mId').value){$('mProv').value=g;$('mProv').onchange()}};
    const body=()=>({id:$('mId').value||undefined,user:$('mUser').value,secret:$('mPass').value,provider:$('mProv').value,name:$('mName').value,imapHost:$('mIH').value,imapPort:$('mIP').value,smtpHost:$('mSH').value,smtpPort:$('mSP').value});
    $('mTest').onclick=async()=>{const b=$('mTest');b.disabled=true;$('mMsg').textContent=I18N.t('連線中…');
      try{const r=await api('connectors/mail-test','POST',body());$('mMsg').textContent=I18N.t(r.text||'')}catch(e){$('mMsg').textContent=e.message}b.disabled=false};
    $('mSave').onclick=async()=>{try{await api('connectors/mail','POST',body());toast(I18N.t('已接上'));paintMail(el)}catch(e){$('mMsg').textContent=e.message}};
    if($('mCancel'))$('mCancel').onclick=()=>paintMail(el)};
  form(null);
  el.querySelectorAll('[data-mtest]').forEach(b=>b.onclick=async()=>{const id=b.dataset.mtest,c=list.find(x=>x.id===id),out=$('mres_'+id);b.disabled=true;out.textContent=I18N.t('連線中…');
    try{const r=await api('connectors/mail-test','POST',{id,user:c.user,provider:c.provider,imapHost:c.imapHost,imapPort:c.imapPort,smtpHost:c.smtpHost,smtpPort:c.smtpPort});out.textContent=I18N.t(r.text||'')}catch(e){out.textContent=e.message}b.disabled=false});
  el.querySelectorAll('[data-medit]').forEach(b=>b.onclick=()=>{const c=list.find(x=>x.id===b.dataset.medit);$('mForm').open=true;$('mFormT').innerHTML=`<span>更改</span> <b data-u>${esc(c.name)}</b>`;form(c);$('mUser').focus()});
  el.querySelectorAll('[data-mrm]').forEach(b=>b.onclick=async()=>{try{await api('connectors/'+b.dataset.mrm,'DELETE');paintMail(el)}catch(e){toast(e.message)}})}
