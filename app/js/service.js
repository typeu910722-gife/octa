/* OCTA web app — 4.16 客服模式: a bot watches one chat page for a while and answers each new message.
   The computer looks at the page every few seconds without the AI (no tokens); the bot is called only for new messages.
   Started here (詳細資料 → 客服模式) or by telling the bot in chat; it ends by itself when the time is up. */
'use strict';
const SVC_SECS=[5,10,20,30,60],SVC_MINS=[15,30,60,120,240,480,0];
const svcOn=id=>S.svc?.[id]||null;
const svcMinTxt=v=>v?(v>=60?`<span data-u>${v/60}</span> <span>小時</span>`:`<span data-u>${v}</span> <span>分鐘</span>`):'<span>直到我停止</span>';
function svcLeft(s){if(!s.until)return '<span>直到你停止</span>';const m=Math.max(0,Math.round((s.until-Date.now())/60000));
  return `<span>剩</span> ${m>=60?`<span data-u>${Math.floor(m/60)}</span> <span>小時</span> `:''}<span data-u>${m%60}</span> <span>分鐘</span>`}
// 4.16.2 詳細資料 → 瀏覽器: 瀏覽器一直開著 (saved at once; 客服模式 keeps it open anyway)
function keepPaint(){const box=$('keepBox');if(!box)return;const id=box.dataset.conv,on=!!S.keepBr?.[id],sv=!!svcOn(id);
  setHTML(box,`<label class="prow chk"><input type="checkbox" id="keepBr" ${on||sv?'checked':''} ${sv?'disabled':''}><span><b>瀏覽器一直開著</b><small>${sv?I18N.t('客服模式進行中，瀏覽器會一直開著。'):I18N.t('不會因為閒置自動關掉，關掉或當掉了也會自己重新打開，登入和分頁都保留，接到工作就能馬上開始。會一直佔用一些電腦記憶體。')}</small></span></label>`);
  const cb=$('keepBr');if(cb&&!sv)cb.onchange=async()=>{cb.disabled=true;try{await api('settings','PUT',{keepBr:{bot:id,on:cb.checked}});S.keepBr={...(S.keepBr||{}),[id]:cb.checked?1:undefined};toast(I18N.t('已儲存 ✓'))}catch(e){cb.checked=!cb.checked;toast(e.message)}cb.disabled=false}}
// 詳細資料 → 客服模式
function svcPaint(){keepPaint();const box=$('svcBox');if(!box)return;const id=box.dataset.conv,s=svcOn(id);
  if(s){setHTML(box,`<div class="svc-on"><p class="svc-st"><b>🎧 <span>客服模式進行中</span></b></p>
    <p class="svc-m"><span>正在看</span> <a href="${esc(s.url)}" target="_blank" rel="noopener" data-u>${esc(s.url)}</a></p>
    <p class="svc-m"><span>每</span> <span data-u>${s.sec}</span> <span>秒看一次</span> · ${svcLeft(s)} · <span>已回覆</span> <b data-u>${s.replies}</b> <span>次</span></p>
    <p class="svc-m"><span>${s.mode==='draft'?'先擬稿給我確認':'直接回覆客人'}</span>${s.wait?` · <span>先等</span> <span data-u>${s.wait}</span> <span>秒</span>`:''}</p>
    ${s.rules?`<p class="svc-m svc-r" data-u>${esc(s.rules)}</p>`:''}
    <button type="button" class="btn sm danger" data-svcstop="${esc(id)}">${ic('stop')}<span>停止客服模式</span></button></div>`);paintIcons(box);return}
  setHTML(box,`<p class="hmuted">它會在一段時間內一直看著一個聊天畫面（LINE 官方帳號、蝦皮聊聊、網站客服…），有新訊息就回覆。檢查畫面不用 AI、不花流量，有新訊息才會叫它。也可以直接在對話裡跟它說，例如「接下來一小時幫我顧 LINE 客服」。</p>
    <label class="field"><span>聊天畫面的網址</span><input id="svcUrl" type="url" inputmode="url" placeholder="https://chat.line.biz/…" autocomplete="off"></label>
    <div class="row2"><label class="field"><span>多久看一次</span><select id="svcSec">${SVC_SECS.map(v=>`<option value="${v}"${v===10?' selected':''}>${v} ${I18N.t('秒')}</option>`).join('')}</select></label>
    <label class="field"><span>持續多久</span><select id="svcMin">${SVC_MINS.map(v=>`<option value="${v}"${v===60?' selected':''}>${v?(v>=60?`${v/60} ${I18N.t('小時')}`:`${v} ${I18N.t('分鐘')}`):I18N.t('直到我停止')}</option>`).join('')}</select></label></div>
    <div class="row2"><label class="field"><span>回覆方式</span><select id="svcMode"><option value="reply">${I18N.t('直接回覆客人')}</option><option value="draft">${I18N.t('先擬稿給我確認')}</option></select></label>
    <label class="field"><span>先等多久再回</span><select id="svcWait">${[0,10,30,60].map(v=>`<option value="${v}">${v?`${v} ${I18N.t('秒')}`:I18N.t('不用等')}</option>`).join('')}</select></label></div>
    <p class="hmuted">先等幾秒，讓 LINE 自動回應或真人客服先回；它回之前會再看一次聊天室，已經有人回、或客人是手動聊天，就不會搶答。價格、折扣、退款一律先給你確認。這個機器人有 LINE Webhook 的例行任務時，Webhook 只當門鈴：訊息一來就馬上看聊天室，不會另外自己回。</p>
    <label class="field"><span>回覆規則（可不填）</span><textarea id="svcRules" maxlength="2000" rows="3" placeholder="例如：訂房問題照官網價格回答；要退款或客人生氣時先說「我幫您確認一下」再問我"></textarea></label>
    <p class="hmuted">先在它的瀏覽器登入那個聊天後台。開始後畫面要保持打開，它會用同一個分頁回覆。</p>
    <button type="button" class="btn sm" id="svcGo">${ic('play')}<span>開始客服模式</span></button><span class="se" id="svcErr"></span>`);
  paintIcons(box);
  $('svcGo').onclick=async()=>{const b=$('svcGo');b.disabled=true;$('svcErr').textContent='';
    try{await api('svc/'+id,'POST',{url:$('svcUrl').value.trim(),sec:+$('svcSec').value,minutes:+$('svcMin').value,rules:$('svcRules').value.trim(),mode:$('svcMode').value,wait:+$('svcWait').value});toast(I18N.t('客服模式開始了'));await refresh();svcPaint()}
    catch(e){$('svcErr').textContent=e.message;b.disabled=false}}}
// the 工作 tab: while it is on, a card at the top with 停止
function svcCard(id){const s=svcOn(id);if(!s)return '';
  return `<div class="wsvc"><b>🎧 <span>客服模式中</span></b><small><span>每</span> <span data-u>${s.sec}</span> <span>秒看一次</span> · ${svcLeft(s)} · <span>已回覆</span> <span data-u>${s.replies}</span> <span>次</span></small><button type="button" class="ghost sm" data-svcstop="${esc(id)}">${ic('stop')}<span>停止</span></button></div>`}
document.addEventListener('click',async e=>{const b=e.target.closest('[data-svcstop]');if(!b)return;b.disabled=true;
  try{await api('svc/'+b.dataset.svcstop+'/stop','POST',{});toast(I18N.t('客服模式已停止'));await refresh();svcPaint()}catch(x){b.disabled=false;toast(x.message)}});
