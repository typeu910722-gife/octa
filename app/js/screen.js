/* OCTA web app — 4.2 手機遙控: the bot's browser on the phone, like Grok Bot's phone app.
   Watch its page live; when it needs you (a password, a code, a CAPTCHA) press 接手 and tap, scroll and type on the
   picture yourself — the bot pauses — then press 我好了 and it carries on. Only where the real embedded browser is not
   on this screen (a phone, or the page opened in an ordinary browser on the computer).
   Frames: GET /api/screen/<bot>?after=<seq> waits for the next frame (long-poll) and answers with the JPEG itself. */
'use strict';
const SCR={bot:'',seq:0,run:false,gen:0,meta:{},hand:false,none:false,view:{s:1,x:0,y:0},ready:'',q:Promise.resolve(),times:[],lat:0,url:''};
const scrHeaders=(json)=>({...(json?{'content-type':'application/json'}:{}),...(TOKEN?{authorization:'Bearer '+TOKEN}:{})});
const scrOn=()=>!embedHere()&&!!cur&&!$('app').hidden&&panelOn()&&WP.tab==='web'&&!document.hidden;
function scrBot(){const id=webBot(),b=bot(id);return b&&b.browser!=='mine'?id:''}
const scrWait=ms=>new Promise(r=>setTimeout(r,ms));
/* start / stop with the 瀏覽器 tab: the computer only streams while somebody looks */
function scrSync(){const id=scrOn()?scrBot():'';
  if(!id){if(SCR.run||SCR.bot)scrStop();return}
  if(SCR.bot!==id){scrStop();SCR.bot=id;SCR.seq=0;SCR.none=false;SCR.view={s:1,x:0,y:0};scrApply();scrPaint()}
  if(!SCR.run)scrLoop(++SCR.gen)}
function scrStop(){const id=SCR.bot;SCR.gen++;SCR.run=false;SCR.bot='';SCR.hand=false;
  if(id)fetch('/api/screen/'+encodeURIComponent(id)+'/bye',{method:'POST',headers:scrHeaders(true),body:'{}',keepalive:true}).catch(()=>{});
  $('wpWeb').classList.remove('scr-on');$('webCtl').hidden=true}
async function scrLoop(gen){SCR.run=true;let fails=0;
  while(gen===SCR.gen&&scrOn()&&scrBot()===SCR.bot){
    const id=SCR.bot,r0=$('scr').getBoundingClientRect(),dpr=Math.min(3,devicePixelRatio||1);
    // frames as sharp as this screen shows them (zoomed in: sharper), never bigger than needed
    const w=Math.round(Math.max(320,r0.width||innerWidth)*dpr*Math.min(2,SCR.view.s)),h=Math.round(Math.max(320,r0.height||innerHeight)*dpr*Math.min(2,SCR.view.s));
    try{
      const r=await fetch(`/api/screen/${encodeURIComponent(id)}?after=${SCR.seq}&w=${w}&h=${h}`,{headers:scrHeaders()});
      if(gen!==SCR.gen)break;
      if(r.status===401){unpaired();break}
      if(!r.ok&&r.status!==204)throw new Error('HTTP '+r.status);
      if((r.headers.get('content-type')||'').includes('json')){const d=await r.json();scrNone(d);await scrWait(3000);continue}
      scrHead(r);
      if(r.status===204)continue;
      const blob=await r.blob();if(gen!==SCR.gen)break;
      scrShow(blob);fails=0}
    catch(e){fails++;await scrWait(Math.min(5000,400*fails))}}
  if(gen===SCR.gen)SCR.run=false}
/* the browser is not open on the computer: the older picture (if any) and the 打開瀏覽器 button */
function scrNone(d){SCR.none=true;SCR.hand=!!d.handed;$('wpWeb').classList.remove('scr-on');scrPaint();
  pollLive.force=true;pollLive()}
function scrHead(r){const hand=r.headers.get('x-octa-handed')==='1';
  try{SCR.meta=JSON.parse(decodeURIComponent(r.headers.get('x-octa-meta')||'%7B%7D'))}catch(e){}
  SCR.seq=+r.headers.get('x-octa-seq')||SCR.seq;
  if(SCR.meta.at)SCR.lat=Math.max(0,Date.now()-SCR.meta.at);
  if(hand!==SCR.hand||SCR.none){SCR.hand=hand;SCR.none=false;scrPaint()}
  const t=SCR.meta.title||'',u=SCR.meta.url||'';
  if($('stTitle').textContent!==t)$('stTitle').textContent=t||I18N.t('瀏覽器');
  if($('stUrl').textContent!==u)$('stUrl').textContent=u;
  if(u!==SCR.url){SCR.url=u;if(document.activeElement!==$('scrAddr'))$('scrAddr').value=u}}
function scrShow(blob){const im=$('stPic'),old=im.dataset.blob,u=URL.createObjectURL(blob);
  im.onload=()=>{if(old)URL.revokeObjectURL(old)};im.src=u;im.dataset.blob=u;
  const t=performance.now();SCR.times.push(t);while(SCR.times.length&&t-SCR.times[0]>3000)SCR.times.shift();
  const s=$('scr');s.dataset.fps=(SCR.times.length/3).toFixed(1);s.dataset.lat=String(SCR.lat);s.dataset.mode=SCR.meta.mode||'';
  if($('stage').hidden||!$('wpWeb').classList.contains('scr-on')){$('stage').hidden=false;$('wpWeb').classList.add('scr-on');scrPaint()}}
/* watch only ↔ 接手: what the buttons, the address bar and the keyboard row show */
function scrPaint(){const on=!!SCR.bot&&!SCR.none,h=SCR.hand;
  $('scrBar').hidden=!on;$('webCtl').hidden=!(on&&h);
  $('scrAddr').readOnly=!h;$('scrBack').disabled=!h;$('scrReload').disabled=!h;
  $('stHand').hidden=h;$('stGo').hidden=!h;$('stHold').hidden=!h;
  $('stage').classList.toggle('taken',h);
  const ask=!h&&SCR.ready===SCR.bot&&!!SCR.bot;$('scrAsk').hidden=!ask;$('stHand').classList.toggle('pulse',ask);
  const tag=$('scrTag');tag.hidden=!on;$('stage').classList.toggle('live',on);tag.textContent=I18N.t(h?'你正在操作，機器人已暫停':'僅觀看');tag.classList.toggle('mine',h);
  $('scrHint').textContent=I18N.t(h?'點一下＝點擊　上下滑＝捲動　雙指＝放大':'雙指可以放大畫面')}
async function scrTake(){const id=SCR.bot||webBot();if(!id)return;
  if(S.busy.some(x=>x.bot_id===id&&x.status==='running'))HAND_BUSY.add(id);
  try{await api('handoff','POST',{bot:id,on:true});SCR.hand=true;SCR.ready='';scrPaint();toast(I18N.t('已接手，機器人停止點擊'))}catch(e){toast(e.message)}}
// 我好了: hand back. The bot carries on only when it was in the middle of something or waiting for you (same as the computer's switch)
async function scrDone(){const id=SCR.bot||webBot();if(!id)return;
  const resume=HAND_BUSY.delete(id)||handWaits(id);
  SCR.hand=false;scrPaint();
  try{await api('handoff','POST',{bot:id,on:false})}catch(e){}
  if(resume)sendMsg((isG(cur)?'@'+bot(id).name+' ':'')+'登入好了，繼續剛才的工作');
  else toast(I18N.t('已交還，機器人可以繼續操作'))}
$('stHand').onclick=()=>scrTake();
$('stGo').onclick=()=>scrDone();

/* ---------- touching the picture ---------- */
// tap = click there · one finger drag = scroll the page · two fingers = zoom / move the picture on this phone only
function scrApply(){const v=SCR.view;$('scrIn').style.transform=v.s>1.001||v.x||v.y?`translate(${v.x}px,${v.y}px) scale(${v.s})`:'';$('scrZoom').hidden=v.s<=1.01;$('scrHint').hidden=v.s>1.01}
function scrClamp(){const v=SCR.view,r=$('scr').getBoundingClientRect();v.s=Math.min(5,Math.max(1,v.s));
  v.x=Math.min(0,Math.max(r.width*(1-v.s),v.x));v.y=Math.min(0,Math.max(r.height*(1-v.s),v.y));if(v.s<=1.01)Object.assign(v,{s:1,x:0,y:0})}
function scrAt(x,y,clamp){const im=$('stPic');if(!im.naturalWidth)return null;
  return scrMap({x,y},{box:$('scr').getBoundingClientRect(),img:{w:im.naturalWidth,h:im.naturalHeight},view:SCR.view,meta:SCR.meta,zoom:1,dpr:1,clamp})}
function scrRipple(x,y,bad){const r=$('scr').getBoundingClientRect(),d=document.createElement('i');d.className='scr-rip'+(bad?' bad':'');
  d.style.left=(x-r.left)+'px';d.style.top=(y-r.top)+'px';$('scr').appendChild(d);setTimeout(()=>d.remove(),650)}
// one at a time and in order; a page that does not answer drops the queue instead of piling up
function scrSend(path,body){const id=SCR.bot;if(!id)return Promise.resolve(null);
  SCR.q=SCR.q.then(async()=>{const r=await fetch('/api/screen/'+encodeURIComponent(id)+'/'+path,{method:'POST',headers:scrHeaders(true),body:JSON.stringify(body)});
    const d=await r.json().catch(()=>({}));
    if(r.status===403){SCR.hand=false;scrPaint();toast(I18N.t('先按「接手」才能操作'))}
    else if(!r.ok&&r.status!==429)toast(d.error||I18N.t('發生錯誤'));
    return r.ok?d:null}).catch(()=>null);
  return SCR.q}
(()=>{const el=$('scr'),pts=new Map();let g=null,acc={x:0,y:0},flush=0,told=0;
  const dist=()=>{const [a,b]=[...pts.values()];return Math.hypot(a.x-b.x,a.y-b.y)||1};
  const mid=()=>{const [a,b]=[...pts.values()];return {x:(a.x+b.x)/2,y:(a.y+b.y)/2}};
  const sendScroll=()=>{flush=0;if(!g||g.kind!=='scroll'||(!acc.x&&!acc.y))return;
    const p=scrAt(g.x0,g.y0,true);if(!p){acc={x:0,y:0};return}
    const dx=Math.round(-acc.x*p.per),dy=Math.round(-acc.y*p.per);acc={x:0,y:0};
    if(dx||dy)scrSend('input',{type:'scroll',x:p.x,y:p.y,dx,dy})};
  el.addEventListener('pointerdown',e=>{if(e.target.closest('button'))return;e.preventDefault();try{el.setPointerCapture(e.pointerId)}catch(_){}
    pts.set(e.pointerId,{x:e.clientX,y:e.clientY});
    if(pts.size===1)g={kind:'tap',x0:e.clientX,y0:e.clientY,lx:e.clientX,ly:e.clientY,t0:Date.now()};
    else if(pts.size===2){const m=mid(),r=el.getBoundingClientRect();g={kind:'pinch',d0:dist(),m0:m,v0:{...SCR.view},r}}});
  el.addEventListener('pointermove',e=>{if(!pts.has(e.pointerId)||!g)return;pts.set(e.pointerId,{x:e.clientX,y:e.clientY});
    if(g.kind==='pinch'&&pts.size===2){const m=mid(),s=Math.min(5,Math.max(1,g.v0.s*dist()/g.d0)),k=s/g.v0.s;
      // the point between the fingers stays under them; moving both fingers moves the picture
      SCR.view={s,x:(m.x-g.r.left)-(g.m0.x-g.r.left-g.v0.x)*k,y:(m.y-g.r.top)-(g.m0.y-g.r.top-g.v0.y)*k};scrClamp();scrApply();return}
    if(g.kind==='tap'&&Math.hypot(e.clientX-g.x0,e.clientY-g.y0)>8)g.kind=SCR.hand?'scroll':(SCR.view.s>1?'pan':'none');
    const dx=e.clientX-g.lx,dy=e.clientY-g.ly;g.lx=e.clientX;g.ly=e.clientY;
    if(g.kind==='pan'){SCR.view.x+=dx;SCR.view.y+=dy;scrClamp();scrApply()}
    if(g.kind==='scroll'){acc.x+=dx;acc.y+=dy;if(!flush)flush=setTimeout(sendScroll,60)}});
  const end=e=>{if(!pts.has(e.pointerId))return;pts.delete(e.pointerId);
    if(g?.kind==='tap'&&e.type==='pointerup'&&Date.now()-g.t0<700){
      if(!SCR.hand){if(Date.now()-told>4000){told=Date.now();toast(I18N.t('僅觀看中。要自己操作，先按「接手」'))}$('stHand').classList.add('pulse')}
      else{const p=scrAt(g.x0,g.y0);scrRipple(g.x0,g.y0,!p);if(p)scrSend('input',{type:'tap',x:p.x,y:p.y})}}
    if(g?.kind==='scroll'){clearTimeout(flush);sendScroll()}
    if(!pts.size)g=null;else if(g?.kind==='pinch')g={kind:'none'}};
  el.addEventListener('pointerup',end);el.addEventListener('pointercancel',end);
  // a mouse wheel on the computer's own window scrolls the page too
  el.addEventListener('wheel',e=>{if(!SCR.hand)return;e.preventDefault();const p=scrAt(e.clientX,e.clientY,true);if(p)scrSend('input',{type:'scroll',x:p.x,y:p.y,dx:Math.round(e.deltaX),dy:Math.round(e.deltaY)})},{passive:false});
  // no double-tap or pinch zoom of OCTA itself while the hands are on the picture (iOS ignores user-scalable)
  for(const t of ['gesturestart','gesturechange'])el.addEventListener(t,e=>e.preventDefault());
  $('scrZoom').onclick=()=>{SCR.view={s:1,x:0,y:0};scrApply()}})();

/* ---------- the address bar and the keyboard row ---------- */
$('scrBar').onsubmit=e=>{e.preventDefault();if(!SCR.hand)return;const u=$('scrAddr').value.trim();$('scrAddr').blur();
  scrSend('nav',{act:'go',url:u}).then(d=>{if(d?.url){$('scrAddr').value=d.url;SCR.url=d.url}})};
$('scrBack').onclick=()=>scrSend('nav',{act:'back'});
$('scrReload').onclick=()=>scrSend('nav',{act:'reload'});
$('scrAddr').addEventListener('focus',()=>{if(!SCR.hand)$('scrAddr').blur()});
$('scrKb').onsubmit=e=>{e.preventDefault();const i=$('scrText'),t=i.value;if(!t)return;i.value='';
  scrSend('input',{type:'text',text:t}).then(d=>{if(d)toast(I18N.t('已輸入'))});i.focus()};
$('scrEye').onclick=()=>{const i=$('scrText'),hide=i.type!=='password';i.type=hide?'password':'text';$('scrEye').setAttribute('aria-pressed',String(hide));$('scrEye').classList.toggle('on',hide);i.focus()};
$('webCtl').addEventListener('click',e=>{const k=e.target.closest('[data-key]');if(k){scrSend('input',{type:'key',key:k.dataset.key});return}});
$('scrPaste').onclick=async()=>{let t='';try{t=await navigator.clipboard.readText()}catch(e){}
  if(t)scrSend('input',{type:'text',text:t.slice(0,2000)}).then(d=>{if(d)toast(I18N.t('已貼上'))});
  else{$('scrText').focus();toast(I18N.t('讀不到剪貼簿。請長按上面的輸入框貼上，再按送出'))}};

/* ---------- 「需要你處理」: a notification or a link opens this bot's 瀏覽器 tab, ready to 接手 ---------- */
function goWeb(c,id){if(!conv(c)||!bot(id))return;if(cur!==c)openConv(c);WP.webBot[c]=id;SCR.ready=id;openPanel('web',{user:true});scrPaint()}
const needsHand=t=>NEEDLOGIN.test(String(t||''))||/接手/.test(String(t||''));
// …#web=<bot>: the link in a Telegram / LINE notice (4.4: through /go). Read at start (api.js), kept through pairing.
function scrDeepLink(){let id='';try{id=sessionStorage.getItem('octa_goweb')||'';sessionStorage.removeItem('octa_goweb')}catch(e){}
  if(id&&bot(id))goWeb(id,id)}
document.addEventListener('visibilitychange',()=>{if(document.hidden)scrStop();else scrSync()});
addEventListener('pagehide',()=>scrStop());
setInterval(()=>{if(!$('app').hidden)scrSync()},1000);
