/* OCTA web app — the desktop app bridge (window.octaDesktop from desktop/preload.cjs).
   Only on the computer: which bot's browser stays on screen, 接手/繼續 from the browser frame,
   keeping dialogs clear of the browser views, and app updates. */
'use strict';
/* only the open bot's browser stays on screen (none on the phone-sized list view) */
function focusBrowser(){
  if($('app').hidden){window.octaDesktop?.focusBot?.('')?.catch?.(()=>{});return}
  const paneOn=!phoneUI()||$('app').classList.contains('chat');
  const id=paneOn&&cur&&bot(cur)?cur:'';
  window.octaDesktop?.focusBot?.(id)?.catch?.(()=>{})}
// the switch under the bot's browser. 取得控制權 = 接手 (the bot stops clicking), 僅觀看 = 繼續.
// Going back to watching only asks the bot to carry on when it was in the middle of something (or waiting for a sign-in).
const HAND_BUSY=new Set();
const handWaits=id=>{const last=convMsgs(id).filter(x=>x.by===id&&!x.tmp).at(-1);return !!last&&(NEEDLOGIN.test(last.text||'')||/我先停手/.test(last.text||''))};
window.octaDesktop?.onStage?.(d=>{
  if(!d?.bot)return;
  if(d.act==='hand'){if(busyIn(d.bot).some(x=>x.status==='running'))HAND_BUSY.add(d.bot);
    api('handoff','POST',{bot:d.bot,on:true}).then(()=>toast(I18N.t('已取得控制權，機器人先暫停'))).catch(e=>toast(e.message))}
  if(d.act==='go'){const resume=HAND_BUSY.delete(d.bot)||handWaits(d.bot);
    api('handoff','POST',{bot:d.bot,on:false}).catch(()=>{});
    if(resume)api('messages','POST',{conv:d.bot,text:'登入好了，繼續'}).then(()=>refresh()).catch(e=>toast(e.message));
    else toast(I18N.t('已交還，機器人可以繼續操作'))}
});
// the bot's browser is a view above this page. It steps aside while a dialog, menu or the loading screen is up,
// and the newest messages (and the bottom of the detail panel) stay clear of its corner card.
(()=>{const D=window.octaDesktop;if(!D?.cover)return;
  let pip=null,last=null,queued=false;
  const hit=(a,b)=>!!(a&&b)&&a.left<b.x+b.width&&a.right>b.x&&a.top<b.y+b.height&&a.bottom>b.y;
  const under=el=>{if(!pip||pip.mode!=='thumb'||!el||el.hidden)return 0;const r=el.getBoundingClientRect();return pip.x<r.right&&pip.x+pip.width>r.left?Math.max(0,Math.round(r.bottom-pip.y+8)):0};
  const pad=()=>{const h=under($('msgs')),hd=under($('detail'));
    document.documentElement.classList.toggle('pip',h>0||hd>0);document.documentElement.style.setProperty('--pip',h+'px');document.documentElement.style.setProperty('--pipd',hd+'px')};
  const setPip=d=>{pip=d&&Number.isFinite(+d.x)?d:null;pad()};
  const check=()=>{queued=false;const b=$('boot'),menu=document.querySelector('.menu');
    const on=!$('veil').hidden||!!document.querySelector('.mveil')||!!document.querySelector('.dguard')||(!!b&&!b.hidden&&!b.classList.contains('done'))||(!!menu&&hit(menu.getBoundingClientRect(),pip));
    if(on===last)return;const was=last;last=on;
    D.cover(on).then(()=>{if(!on&&was)return D.pip?.().then(setPip)}).catch(()=>{})};
  const soon=()=>{if(!queued){queued=true;requestAnimationFrame(check)}};
  const mo=new MutationObserver(soon);mo.observe(document.body,{childList:true});
  mo.observe($('veil'),{attributes:true,attributeFilter:['hidden']});if($('boot'))mo.observe($('boot'),{attributes:true,attributeFilter:['hidden','class']});
  D.onPip?.(d=>{if(!last)setPip(d)});D.pip?.().then(setPip).catch(()=>{});
  addEventListener('resize',pad);if(window.ResizeObserver){new ResizeObserver(pad).observe($('msgs'));new ResizeObserver(pad).observe($('detail'))}check()})();

/* ---------- app updates (GitHub Releases, through the desktop app) ---------- */
const UPD=window.octaDesktop?.update;
function renderUpd(u){const el=$('upd');if(!el||!u)return;window._upd=u;
  const show=['available','downloading','ready'].includes(u.state)||(u.state==='error'&&u.version);
  el.hidden=!show;if(!show)return;
  el.innerHTML=u.state==='available'?`<span class="ut">${ic('sparkle')}<span><span>有新版本</span> <b data-u>v${esc(u.version)}</b></span></span><div class="row2"><button class="ghost sm" id="updWhat">看更新內容</button><button class="btn sm" id="updGo">更新</button></div>`
    :u.state==='downloading'?`<span class="ut"><span>下載新版本中…</span> <span data-u>${u.percent||0}%</span></span><div class="bar"><i style="width:${u.percent||0}%"></i></div>`
    :u.state==='ready'?`<span class="ut">${ic('check')}<span>新版本已下載好</span></span>${u.admin?'<small class="hmuted">這台電腦的 OCTA 是裝給所有使用者，Windows 會詢問是否允許變更，請按「是」</small>':''}<button class="btn sm" id="updGo">重新啟動並更新</button>`
    :`<span class="ut">${ic('info')}<span>更新失敗，請稍後再試</span></span><button class="ghost sm" id="updGo">重試</button>`;
  if($('updWhat'))$('updWhat').onclick=()=>openSettings('adv','ver');
  const b=$('updGo');if(b)b.onclick=()=>{if(u.state==='ready'){boot.show(I18N.t('正在更新，OCTA 會自動重新開啟…'));UPD.install()}else UPD.download()};
  if(u.state==='downloading'&&!$('boot').hidden)boot.set(u.percent,I18N.t('下載新版本中…'))}
if(UPD){UPD.onChange(renderUpd);UPD.status().then(renderUpd).catch(()=>{})}
