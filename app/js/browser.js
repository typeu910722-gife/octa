/* OCTA web app — each bot's own browser: open, hide, open an address, past screenshots, the phone's live view. */
'use strict';
const showBrowserLabel=()=>window.octaDesktop?'打開瀏覽器':'在電腦上打開瀏覽器';
const browserHint=()=>window.octaDesktop?'這個視窗裡的瀏覽器':'電腦上 OCTA 的瀏覽器';
async function openBrowser(id,url,hide){const b=bot(id);if(!b)return false;
  if(!hide&&window.octaDesktop?.focusBot){try{await window.octaDesktop.focusBot(id)}catch(e){}}
  try{await api('open','POST',{bot:id,conv:cur,url:url||'',hide:!!hide,expand:!hide});toast(I18N.t(!S.runnerOnline?'電腦上的 OCTA 沒有在執行，開始後就會處理':hide?'已收到背景':(window.octaDesktop?'已打開':'已請電腦打開瀏覽器')));refresh();return true}
  catch(e){toast(e.message);return false}}
const phoneRemote=()=>phoneUI()&&!window.octaDesktop;
function browserMenu(anchor){
  const c=conv(cur);if(!c)return;
  const ids=isG(cur)?c.members.filter(bot):[cur];
  if(phoneRemote()){remoteUrl(ids);return}
  const one=id=>{const b=bot(id);return b.browser==='mine'
    ?`<div class="lab" data-u>${esc(b.name)}</div>${mi('note','info','使用你的 Chrome（在 Chrome 看它的分頁群組）',id)}`
    :`${isG(cur)?`<div class="lab" data-u>${esc(b.name)}</div>`:''}${mi('open','monitor',showBrowserLabel(),id)}${mi('hide','hide','收到背景',id)}${isG(cur)?'':mi('url','link','讓它打開網址…',id)}`};
  popMenu(anchor,ids.map(one).join('<hr>')+'<hr>'+mi('shots','image','歷史畫面'),
    {open:id=>openBrowser(id),hide:id=>openBrowser(id,'',true),url:id=>urlSheet(id),shots:()=>shotSheet(ids),note:()=>toast(I18N.t('這個機器人使用你的 Chrome，直接在你的 Chrome 裡查看它的分頁群組即可。'))})}
$('browser').onclick=e=>{e.stopPropagation();browserMenu($('browser'))};
function urlSheet(id){const b=bot(id);
  $('veil').innerHTML=`<form class="sheet sm" id="uf">${sheetHead('讓它打開網址')}<p><span>用</span>「<span data-u>${esc(b.name)}</span>」<span>的瀏覽器打開，畫面在</span><span>${I18N.t(browserHint())}</span>：</p>
  <label class="field"><span>網址</span><input id="uu" placeholder="不填就打開 Google" value="${esc(b.page||'')}" inputmode="url"></label>
  <div class="acts"><button type="button" class="ghost" id="sx">取消</button><button class="btn">在電腦上開啟</button></div></form>`;
  $('veil').hidden=false;$('uu').focus();$('uu').select();$('sx').onclick=closeSheet;
  $('uf').onsubmit=ev=>{ev.preventDefault();const u=$('uu').value.trim();closeSheet();openBrowser(id,u)}}
const shownPage=p=>p&&!/^(data:|about:|chrome:)/.test(p)?p:'';
/* the phone: the address and picture of what the computer's browser shows, and a box to send it a new address */
function remoteUrl(ids){
  const list=ids.filter(id=>bot(id));if(!list.length)return;
  $('veil').innerHTML=`<form class="sheet" id="remoteUrl" data-ids="${esc(list.join(','))}">${sheetHead('電腦上的網址','不填就在電腦上打開內嵌的 Google。要去別的網站再打網址。登入仍在電腦上完成。')}
  ${list.length>1?`<label class="field"><span>機器人</span><select id="ruBot">${list.map(id=>`<option value="${esc(id)}" data-u>${esc(bot(id).name)}</option>`).join('')}</select></label>`:''}
  <div class="bw" id="ruView"></div>
  <label class="field"><span>要打開的網址</span><input id="uu" inputmode="url" autocomplete="url" placeholder="不填就打開 Google"></label>
  <p id="ruStat" class="hmuted"></p>
  <div class="acts"><button type="button" class="ghost" id="sx">關閉</button><button class="btn" type="submit">在電腦上打開</button></div></form>`;
  $('veil').hidden=false;paintRemote(true);$('uu').focus();
  $('sx').onclick=closeSheet;
  if($('ruBot'))$('ruBot').onchange=()=>paintRemote(true);
  $('remoteUrl').onsubmit=async ev=>{ev.preventDefault();const u=$('uu').value.trim();const ok=await sendRemote(false,u);
    if($('ruStat'))$('ruStat').textContent=I18N.t(ok?'已送到電腦。打開後，這裡的網址和畫面會自己更新。':'沒有送到電腦')}};
function remoteBot(){const form=$('remoteUrl');if(!form)return '';return $('ruBot')?.value||String(form.dataset.ids||'').split(',')[0]}
async function sendRemote(hide,url){const id=remoteBot();if(!id)return false;return openBrowser(id,hide?'':(url||''),!!hide)}
function paintRemote(fill){
  const form=$('remoteUrl');if(!form||$('veil').hidden)return;
  const id=remoteBot(),b=bot(id);if(!b)return;
  const page=shownPage(b.page),view=$('ruView'),shot=String(b.shot_ts||'');
  const now=()=>`<span>電腦目前：</span>${page?`<span data-u>${esc(page)}</span>`:'<span>還沒有網址</span>'}`;
  if(view.dataset.bot!==id||view.dataset.shot!==shot){
    view.dataset.bot=id;view.dataset.shot=shot;
    view.innerHTML=`<div class="hd"><span class="av sm" data-u>${avOf(b.id)}</span><b data-u>${esc(b.name)}</b></div>
      <div class="meta" id="ruPage">${now()}</div>
      ${b.shot_ts?`<img class="shot" alt="${esc(b.name)}" id="ruShot">`:`<div class="noshot">電腦打開網頁後，畫面會出現在這裡。</div>`}`;
    if(b.shot_ts)api('shot/'+id).then(d=>d.file?fileData(d.file):d).then(d=>{const im=$('ruShot');if(im&&d.data&&view.dataset.shot===shot)im.src=`data:${d.mime};base64,${d.data}`}).catch(()=>{});
  }else{const meta=$('ruPage');if(meta)meta.innerHTML=now()}
  const input=$('uu');if(fill&&input&&document.activeElement!==input)input.value=page||'';
}
function shotSheet(ids){
  openSheet(`${sheetHead('機器人的瀏覽器',window.octaDesktop?'平常縮成圓角小卡，可以拖到你要的位置。打開後是這個機器人自己的側邊視窗，可以拖、也可以拉大小。換到別的機器人不會把這個瀏覽器帶過去。':'每個機器人在電腦上的 OCTA 裡有自己的瀏覽器。這裡是它最後停在哪一頁。')}
  ${ids.map(id=>{const b=bot(id);return `<div class="bw" data-id="${id}"><div class="hd"><span class="av sm" data-u>${avOf(b.id)}</span><b data-u>${esc(b.name)}</b>${botRunning(id)?'<span class="pill warn">工作中</span>':''}</div>
    ${b.shot_ts?`<img class="shot" alt="${esc(b.name)}" id="img_${id}"><div class="meta"><span>截圖：</span>${ago(b.shot_ts)}${b.page?' · <span data-u>'+esc(b.page)+'</span>':''}</div>`:`<div class="noshot">還沒有畫面。機器人用過瀏覽器後，這裡會顯示它最後停在哪一頁。</div>`}
    ${b.browser==='mine'?`<div class="meta">這個機器人使用你的 Chrome，直接在你的 Chrome 裡查看它的分頁群組即可。</div>`:`${DESK()?`<div data-bm="${id}"></div>`:''}<div class="row2"><button class="btn sm" data-open="${id}">${I18N.t(showBrowserLabel())}</button><button class="ghost sm" data-hide="${id}">收到背景</button><button class="ghost sm" data-url="${id}">讓它打開網址…</button></div>`}</div>`}).join('')}
  <div class="acts"><button class="btn" id="sx">關閉</button></div>`);
  $('sx').onclick=closeSheet;browserModes($('veil'));
  ids.forEach(id=>{if(bot(id).shot_ts)api('shot/'+id).then(d=>d.file?fileData(d.file):d).then(d=>{const im=$('img_'+id);if(im&&d.data)im.src=`data:${d.mime};base64,${d.data}`}).catch(e=>{const im=$('img_'+id);if(im)im.replaceWith(Object.assign(document.createElement('div'),{className:'noshot',textContent:e.message}))})});
  $('veil').querySelectorAll('[data-open]').forEach(x=>x.onclick=()=>{closeSheet();openBrowser(x.dataset.open)});
  $('veil').querySelectorAll('[data-url]').forEach(x=>x.onclick=()=>urlSheet(x.dataset.url));
  $('veil').querySelectorAll('[data-hide]').forEach(x=>x.onclick=()=>{closeSheet();openBrowser(x.dataset.hide,'',true)});
  $('veil').querySelectorAll('.shot').forEach(im=>im.onclick=()=>{const id=im.id.slice(4);closeSheet();openBrowser(id)});
}
// a bot whose browser went to a Chrome window because Google refused the sign-in in OCTA: say why, and offer the way back
function browserModes(root){if(!DESK())return;root.querySelectorAll('[data-bm]').forEach(el=>{const id=el.dataset.bm;
  api('desktop/browser-mode','POST',{bot:id}).then(d=>{if(!d?.chrome||!el.isConnected)return;
    el.innerHTML=`<div class="note-box"><b>目前用 Chrome 視窗</b> <span>${d.why==='google'?'因 Google 登入改用 Chrome 視窗':'改用 Chrome 視窗'}</span>${d.stay?'<br><span>剛改回內建又被 Google 擋下，先固定用 Chrome 視窗</span>':''}
      <div class="row2"><button type="button" class="ghost sm" data-embed>改回內建瀏覽器</button></div><p class="hmuted">會把 Chrome 視窗裡的登入（Google 和其他網站）帶進 OCTA 內建瀏覽器，然後關掉 Chrome 視窗。如果 Google 又擋下內建瀏覽器的登入，會再自動改用 Chrome 視窗。</p></div>`;
    el.querySelector('[data-embed]').onclick=async e=>{const b=e.currentTarget;b.disabled=true;b.textContent=I18N.t('切換中…');
      try{await api('desktop/browser-embed','POST',{bot:id,name:bot(id)?.name||''});toast(I18N.t('已改回內建瀏覽器'));el.innerHTML=''}
      catch(err){b.disabled=false;b.textContent=I18N.t('改回內建瀏覽器');toast(I18N.t(errText(err)))}}}).catch(()=>{})})}
/* the phone (no embedded browser): a live picture of the bot's browser while it works, with 接手 / 繼續 */
$('stHand').onclick=()=>{if(!cur||isG(cur))return;api('handoff','POST',{bot:cur,on:true}).then(()=>{toast(I18N.t('已接手，機器人停止點擊'));pollLive()}).catch(e=>toast(e.message))};
$('stGo').onclick=()=>{if(!cur||isG(cur))return;api('handoff','POST',{bot:cur,on:false}).catch(()=>{});sendMsg('登入好了，繼續剛才的工作')};
async function pollLive(){
  const box=$('stage');if(!box)return;
  if(window.octaDesktop||!cur||isG(cur)||$('app').hidden){box.hidden=true;return}
  // only while the bot is working (or you took over) and this page is in front: an idle browser doesn't change
  const working=busyIn(cur).some(x=>x.status==='running'),key=cur;
  if(document.hidden||(!working&&!pollLive.hand&&pollLive.seen===key&&Date.now()-(pollLive.at||0)<60000))return;
  pollLive.at=Date.now();pollLive.seen=key;
  let d={};try{d=await api('live/'+encodeURIComponent(cur)+(pollLive.ts&&pollLive.tsFor===key?'?since='+pollLive.ts:''))}catch(e){return}
  if(cur!==key)return;
  pollLive.hand=!!d.handed;
  if(d.same){box.hidden=false;$('stHold').hidden=!d.handed;return}
  if(!d.ts){box.hidden=true;return}
  pollLive.ts=d.ts;pollLive.tsFor=key;
  box.hidden=false;
  $('stTitle').textContent=d.title||I18N.t('瀏覽器');
  $('stUrl').textContent=d.url||'';
  if(d.data)$('stPic').src='data:image/jpeg;base64,'+d.data;
  $('stHold').hidden=!d.handed;
}
setInterval(()=>{if(!$('app').hidden)pollLive()},1500);
