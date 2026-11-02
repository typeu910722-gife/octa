/* OCTA web app — dialogs ("sheets"), unsaved-change guard, menus, long-press, phone back navigation. */
'use strict';
/* one 儲存 per sheet: the outer 儲存 also saves what is being edited inside; unsaved edits are flagged beside it,
   and closing or leaving asks first */
const DIRTY={el:null,parts:new Set(),save:null};
function trackDirty(root,save){DIRTY.el=root;DIRTY.parts=new Set();DIRTY.save=save;
  const mark=e=>{const t=e.target;if(!t?.closest||t.closest('[data-nodirty]'))return;markDirty(t.closest('.rform')?'rt':t.closest('#sf_madd')?'mem':'main')};
  if(root._dm){root.removeEventListener('input',root._dm);root.removeEventListener('change',root._dm)}root._dm=mark;   // settings sections share one body
  root.addEventListener('input',mark);root.addEventListener('change',mark);paintDirty()}
function markDirty(part='main'){if(!DIRTY.el)return;DIRTY.parts.add(part);paintDirty()}
function cleanDirty(part){if(part)DIRTY.parts.delete(part);else DIRTY.parts.clear();paintDirty()}
const isDirty=()=>!!(DIRTY.el&&DIRTY.parts.size&&document.contains(DIRTY.el));
function paintDirty(){const on=isDirty();document.querySelectorAll('[data-dirty-flag]').forEach(x=>x.hidden=!on);document.querySelectorAll('[data-dirty-bar]').forEach(x=>x.classList.toggle('on',on))}
function leaveOk(then){if(!isDirty()){DIRTY.el=null;then();return}
  document.querySelector('.dguard')?.remove();
  const d=document.createElement('div');d.className='dguard';
  d.innerHTML=`<div class="dgbox" role="alertdialog" aria-modal="true"><b>還有沒儲存的變更</b><p>關掉前要先儲存嗎？</p><div class="acts"><button type="button" class="ghost" data-g="stay">繼續編輯</button><button type="button" class="ghost danger" data-g="drop">不儲存</button><button type="button" class="btn" data-g="save">儲存</button></div></div>`;
  document.body.appendChild(d);d.querySelector('[data-g=save]').focus();
  d.onclick=async e=>{const b=e.target.closest('[data-g]');if(!b&&e.target!==d)return;const k=b?b.dataset.g:'stay';
    if(k==='stay'){d.remove();return}
    if(k==='drop'){d.remove();DIRTY.el=null;then();return}
    b.disabled=true;let ok=false;try{ok=await DIRTY.save?.()!==false}catch(err){toast(err.message)}
    d.remove();if(ok){DIRTY.el=null;toast(I18N.t('已儲存 ✓'));then()}}}
var pageBack=null;   // a page opened from another page goes back to it (button, Android back, edge swipe)
function closeSheet(force){
  if(force!==true&&isDirty()&&DIRTY.el&&$('veil').contains(DIRTY.el)){leaveOk(()=>closeSheet(true));if(phoneUI()&&!$('veil').hidden&&NAV[NAV.length-1]!=='sheet')navPush('sheet');return}
  document.querySelector('.dguard')?.remove();if(DIRTY.el&&$('veil').contains(DIRTY.el))DIRTY.el=null;
  if(typeof stopCodePoll==='function')stopCodePoll();$('veil').hidden=true;$('veil').innerHTML='';if(typeof rtEdit!=='undefined')rtEdit=null;pageBack=null}
$('veil').onclick=e=>{if(e.target.id==='veil')closeSheet()};
/* a plain dialog: title, body, buttons. Everything in OCTA that floats above the chat goes through #veil */
function openSheet(html,cls=''){$('veil').innerHTML=`<div class="sheet${cls?' '+cls:''}" role="dialog" aria-modal="true">${html}</div>`;$('veil').hidden=false;return $('veil').firstElementChild}
const sheetHead=(title,sub)=>`<div class="shd"><h2>${title}</h2><button type="button" class="ib x" data-close aria-label="關閉">${ic('x')}</button></div>${sub?`<p class="sub">${sub}</p>`:''}`;
$('veil').addEventListener('click',e=>{if(e.target.closest('[data-close]'))closeSheet()});
function alertSheet(t,p){openSheet(`${sheetHead(esc(t))}<p>${esc(p)}</p><div class="acts"><button class="btn" id="sx">知道了</button></div>`,'sm');$('sx').onclick=closeSheet}
function confirmSheet(title,body,okText,danger,onOk){
  openSheet(`${sheetHead(title)}<div class="sbodytext">${body}</div><div class="errmsg" id="cfE"></div><div class="acts"><button class="ghost" id="sx">取消</button><button class="${danger?'btn danger-btn':'btn'}" id="cfOk">${okText}</button></div>`,'sm');
  $('sx').onclick=closeSheet;
  $('cfOk').onclick=async()=>{$('cfOk').disabled=true;try{await onOk();closeSheet(true)}catch(e){$('cfE').textContent=e.message;$('cfOk').disabled=false}}}

/* ---------- menus: a popover beside what you clicked; an action sheet with 取消 on a phone ---------- */
const mi=(a,icon,text,v,cls='')=>`<button type="button" data-a="${a}"${v!=null?` data-v="${esc(v)}"`:''}${cls?` class="${cls}"`:''}><span class="ck">${icon?(ICONS[icon]?ic(icon):`<span class="ckt">${icon}</span>`):''}</span><span class="mt">${text}</span></button>`;
function closeMenu(fromHistory){const had=document.querySelector('.menu.asheet');document.querySelectorAll('.menu,.mveil').forEach(m=>m.remove());if(had&&!fromHistory)navPop('menu')}
document.addEventListener('click',e=>{if(lpHit)return;if(!e.target.closest('.menu'))closeMenu()});   // the lift that ends a long press is not a tap outside
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeMenu()});
function popMenu(anchor,html,handlers){closeMenu();const m=document.createElement('div');m.className='menu';m.setAttribute('role','menu');m.innerHTML=html;
  const phone=phoneUI();
  if(phone){const v=document.createElement('div');v.className='mveil';document.body.appendChild(v);m.classList.add('asheet');m.insertAdjacentHTML('beforeend','<button type="button" class="mcancel">取消</button>')}
  document.body.appendChild(m);
  if(phone)navPush('menu');
  else{const r=anchor.getBoundingClientRect(),w=m.offsetWidth,hh=m.offsetHeight;
    m.style.left=Math.max(8,Math.min(r.right-w,innerWidth-w-8))+'px';m.style.top=(r.bottom+hh+8>innerHeight?Math.max(8,r.top-hh-4):r.bottom+4)+'px'}
  m.onclick=e=>{if(e.target.closest('.mcancel')){e.stopPropagation();closeMenu();return}const b=e.target.closest('button[data-a]');if(!b)return;e.stopPropagation();closeMenu();handlers[b.dataset.a]?.(b.dataset.v)};
  m.onkeydown=e=>{if(e.key!=='ArrowDown'&&e.key!=='ArrowUp')return;e.preventDefault();const bs=[...m.querySelectorAll('button:not(:disabled)')],i=bs.indexOf(document.activeElement);bs[(i+(e.key==='ArrowDown'?1:-1)+bs.length)%bs.length]?.focus()};
  if(!phone)m.querySelector('button')?.focus()}
const pointAnchor=(x,y)=>({getBoundingClientRect:()=>({left:x,right:x+230,top:y,bottom:y,width:230,height:0})});   // a right-click menu opens at the pointer
/* hold a row or a message to get its menu (phone); right-click does the same on a computer */
let lpHit=false;
function holdOn(root,find,open){
  root.addEventListener('pointerdown',e=>{if(e.pointerType==='mouse'||e.button!==0)return;const el=find(e.target);if(!el)return;const x=e.clientX,y=e.clientY;
    let t=setTimeout(()=>{t=null;lpHit=true;try{navigator.vibrate?.(8)}catch(x){}open(el,null)},450);
    const stop=()=>{clearTimeout(t);root.removeEventListener('pointermove',mv);root.removeEventListener('pointerup',stop);root.removeEventListener('pointercancel',stop);setTimeout(()=>lpHit=false,350)};
    const mv=ev=>{if(Math.hypot(ev.clientX-x,ev.clientY-y)>8)stop()};
    root.addEventListener('pointermove',mv);root.addEventListener('pointerup',stop);root.addEventListener('pointercancel',stop)});
  root.addEventListener('contextmenu',e=>{const el=find(e.target);if(!el)return;e.preventDefault();if(lpHit||document.querySelector('.menu'))return;open(el,e)});
  root.addEventListener('click',e=>{if(lpHit){e.stopPropagation();e.preventDefault()}},true)}

/* ---------- phone: Back (button, edge swipe, browser gesture) closes what is on top instead of leaving OCTA ---------- */
const NAV=[],navQueue=[];let navSkip=0;
// history.back() lands later than the code that follows it; pushes made meanwhile wait for the popstate so the stack stays in step
function navPush(k){if(!phoneUI())return;if(navSkip>0){navQueue.push(k);return}NAV.push(k);try{history.pushState({octa:NAV.length},'')}catch(e){}}
function navPop(k){const q=navQueue.lastIndexOf(k);if(q>=0){navQueue.splice(q,1);return}
  if(NAV.length&&NAV[NAV.length-1]===k){NAV.pop();navSkip++;try{history.back()}catch(e){navSkip--}}}
window.addEventListener('popstate',()=>{if(navSkip>0){navSkip--;if(!navSkip)while(navQueue.length)navPush(navQueue.shift());return}const k=NAV.pop();if(!k)return;
  if(k==='menu')closeMenu(true);
  else if(k==='sheet'){if(!$('veil').hidden){const bk=sheetBack();if(bk){bk();if(!$('veil').hidden)navPush('sheet')}else closeSheet()}}
  else if(k==='detail'){closeDetail(true)}
  else if(k==='chat'){saveDraft();$('app').classList.remove('chat');focusBrowser()}});
new MutationObserver(()=>{if(!$('veil').hidden){if(NAV[NAV.length-1]!=='sheet')navPush('sheet')}else navPop('sheet')}).observe($('veil'),{attributes:true,attributeFilter:['hidden']});
// swipe in from the left edge to go back
(function(){let sx=0,sy=0,on=false;
document.addEventListener('touchstart',e=>{const t=e.touches[0];on=false;if(!phoneUI()||t.clientX>=28||document.querySelector('.menu'))return;
  if(!$('veil').hidden&&$('veil').querySelector('.sheet.page'))on='page';   // a full page slides back the same way
  else if($('veil').hidden&&$('app').classList.contains('detail-on'))on='detail';
  else if($('veil').hidden&&$('app').classList.contains('chat'))on='chat';
  sx=t.clientX;sy=t.clientY},{passive:true});
document.addEventListener('touchend',e=>{if(!on)return;const k=on;on=false;const t=e.changedTouches[0];if(t.clientX-sx<70||Math.abs(t.clientY-sy)>=60)return;
  if(k==='page'){const bk=sheetBack();bk?bk():closeSheet()}else if(k==='detail')closeDetail();else $('back').click()},{passive:true})})();
// pull a bottom sheet down to close it
(function(){let y0=0,sh=null,dy=0;
$('veil').addEventListener('touchstart',e=>{sh=null;if(!phoneUI())return;const s=e.target.closest('.sheet');if(!s||s.classList.contains('page')||s.scrollTop>0||e.target.closest('textarea,select,input[type=range]'))return;sh=s;y0=e.touches[0].clientY;dy=0},{passive:true});
$('veil').addEventListener('touchmove',e=>{if(!sh)return;dy=e.touches[0].clientY-y0;if(dy<=0||sh.scrollTop>0){sh.style.transform='';return}e.preventDefault();sh.style.transition='none';sh.style.transform=`translateY(${dy}px)`},{passive:false});
$('veil').addEventListener('touchend',()=>{if(!sh)return;const s=sh;sh=null;s.style.transition='';s.style.transform='';if(dy>110)closeSheet()})})();
// a sheet on a phone: big forms are full pages with ‹ at the top; the rest rise from the bottom
function phoneSheet(){paintIcons($('veil'));const s=$('veil').querySelector(':scope>.sheet');if(!s||!phoneUI()||s.dataset.ph)return;s.dataset.ph='1';
  const page=s.classList.contains('page')||s.classList.contains('settings')||s.classList.contains('wide')||['sf','remoteUrl'].includes(s.id);
  s.classList.toggle('page',page);
  if(!page)return;
  const hd=s.querySelector(':scope>.shd');if(!hd||hd.querySelector('.back2'))return;
  const b=document.createElement('button');b.type='button';b.className='ib back2';b.setAttribute('aria-label',I18N.t('返回'));b.innerHTML=ic('back');
  b.onclick=()=>{const bk=sheetBack();bk?bk():closeSheet()};hd.prepend(b)}
new MutationObserver(phoneSheet).observe($('veil'),{childList:true});
const sheetBack=()=>{if(pageBack)return ()=>leaveOk(pageBack);const sb=$('veil').querySelector('.sheet [data-back]');return sb&&!sb.hidden?()=>sb.click():null};
