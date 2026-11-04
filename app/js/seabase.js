/* OCTA 4.9 深海基地 — every bot at work in an underwater research base (seamodel.js works out what it shows).
   4.10 「深海基地就是主畫面」: no separate page any more. On a computer the base is the stage in the middle of the main
   window (sidebar | base | right panel with 總覽 · 工作 · 瀏覽器 · 詳細資料); the open chat floats over it as a glass panel
   that can be folded to a slim bar. Picking a bot (sidebar, card or its octopus) opens its chat and swims the camera to it,
   aimed beside the chat panel. On a phone the base is a foldable header above the chat list.
   three.js (app/vendor) is loaded after the first paint, once; switching chats only moves the camera, nothing is rebuilt.
   How often it draws: seaRate (30 / 10 / 0 frames a second: watching, covered or typing or in the background, hidden or
   省電模式). Turning 主畫面 3D 基地 off frees every GPU resource. */
'use strict';
const SEA_LIB='/vendor/three-0.170.0.module.min.js';
const SEA={st:null,g:null,m:null,L:null,done:{},sig:'',ssig:'',focus:null,sel:null,ac:null,iv:0,hover:null,ovSeen:'',booted:false,gl:null,loading:false,blurAt:0,coverPx:0,rightPx:0,cover:0};
// the chat panel over the stage: folded to a bar (收起對話) or not
const STAGE={min:false};
const seaOpen=()=>!!SEA.g;
const seaPodName=p=>p.kind==='hub'?I18N.t(p.name):p.name;
const seaLow=()=>store.get('octa_lowpower')==='1';
const seaReduced=()=>matchMedia('(prefers-reduced-motion: reduce)').matches;
const seaStill=()=>seaLow()||seaReduced();
// 設定 → 外觀與語言 → 主畫面 3D 基地 (on unless turned off)
const seaEnabled=()=>store.get('octa_stage3d')!=='0';
// a computer (1024 px and wider): the base is the main screen; narrower windows keep the list ↔ chat layout
const stageMode=()=>!phoneUI()&&innerWidth>=1024&&seaEnabled();
// the phone's header can be folded to a strip (remembered): nothing is drawn then
const seaFolded=()=>store.get('octa_seafold')==='1';
let SEA_MOD=null;
const seaLib=()=>SEA_MOD||(SEA_MOD=import(SEA_LIB).catch(e=>{SEA_MOD=null;throw e}));
// can this device draw 3D? (the test context is let go at once)
function seaHasGL(){try{const c=document.createElement('canvas'),x=c.getContext('webgl2')||c.getContext('webgl');if(!x)return false;x.getExtension('WEBGL_lose_context')?.loseContext();return true}catch(e){return false}}
const seaInput=()=>({bots:ordered(S.bots),groups:S.groups,folders:S.folders,busy:S.busy,last:S.last,lastJob:S.lastJob,gask:S.gask,done:SEA.done,now:Date.now()});
const seaW=()=>SEA.st?.clientWidth||1,seaH=()=>SEA.st?.clientHeight||1;
const seaTyping=()=>{const a=document.activeElement;return !!a&&(a.tagName==='TEXTAREA'||a.isContentEditable||(a.tagName==='INPUT'&&!/^(checkbox|radio|range|button|submit)$/.test(a.type)))};
// is the base on screen right now? (the computer's stage, or the phone's unfolded header on the list screen)
function seaShown(){if(!SEA.st||$('app').hidden||!seaEnabled()||!SEA.st.isConnected)return false;
  if(phoneUI()){const a=$('app');return !seaFolded()&&!a.classList.contains('chat')&&!a.classList.contains('wp-on')&&!$('seaHead').hidden}
  return stageMode()}
// what seaRate is told, now
function seaRateNow(){const G=SEA.g;
  return seaRate({on:seaEnabled(),gl:!!G,hidden:document.hidden||!seaShown(),blurMs:SEA.blurAt?Date.now()-SEA.blurAt:0,still:seaStill(),
    moving:!!G&&seaMoving(G),covered:SEA.cover,typing:seaTyping(),focused:document.hasFocus()})}

/* ---------- the stage: made once, after the first paint; moved between the computer's main screen and the phone's header ---------- */
function seaMount(){if(SEA.st)return SEA.st;
  const st=document.createElement('section');st.className='sea-stage';st.id='seaStage';st.setAttribute('aria-label',I18N.t('深海基地'));
  st.innerHTML=`<div class="sea-bg" aria-hidden="true"></div><div class="sea-tags" id="seaTags" aria-hidden="true"></div>
    <div class="sea-hud"><button type="button" class="sea-all" id="seaAll" hidden>${ic('back')}<span>回到全景</span></button><div class="sea-depth" id="seaDepth" aria-hidden="true"></div></div>
    <p class="sea-hint" id="seaHint"><span>拖曳轉動</span> · <span>滾輪或雙指縮放</span> · <span>點章魚打開對話</span></p>
    <div class="sea-tip" id="seaTip" hidden></div><div class="sea-msg" id="seaMsg" hidden></div>`;
  SEA.st=st;paintIcons(st);
  st.querySelector('#seaAll').onclick=()=>seaFocus(null);
  return st}
function seaBoot(){if(SEA.booted||$('app').hidden)return;SEA.booted=true;seaMount();stageSync();seaRefresh(true);SEA.iv=setInterval(seaTick,1000);
  addEventListener('resize',stageSync);
  // the phone's header: fold / unfold (remembered)
  $('seaHeadBar').onclick=()=>{store.set('octa_seafold',seaFolded()?null:'1');stageSync();if(SEA.g&&!seaFolded())requestAnimationFrame(()=>{seaResize();SEA.g.loop.kick(3)})};
  seaEnsure()}
// load three.js and build the scene, when the base is to be shown and can be (once; later calls do nothing)
function seaEnsure(){if(!SEA.booted||SEA.g||SEA.loading||SEA.gl===false||!seaEnabled()||!seaShown())return;
  if(SEA.gl==null&&!seaHasGL()){seaFallback();return}SEA.gl=true;
  SEA.loading=true;
  seaLib().then(T=>{SEA.loading=false;if(seaEnabled()&&!SEA.g&&SEA.st)seaInit(T)}).catch(()=>{SEA.loading=false;seaFallback()})}
// once a second: the picture follows the polled state; the cards ask the API again when work moved (at most every 1.5 s, or every 30 s)
function seaTick(){if($('app').hidden)return;seaRefresh();
  if(!ovShown())return;const k=S.rev+':'+S.prog;
  if((k!==SEA.ovSeen&&Date.now()-OV.t>1500)||Date.now()-OV.t>30000){SEA.ovSeen=k;loadOverview()}}
// no WebGL: a still deep-sea gradient behind the chat (the app works the same); the phone shows no header
function seaFallback(){if(SEA.gl===false)return;SEA.gl=false;if(!SEA.st)return;SEA.st.classList.add('flat');const m=$('seaMsg');m.hidden=false;
  setHTML(m,`<b>這台裝置沒辦法顯示 3D 畫面</b><span>對話和總覽一樣可以用。</span>`);stageSync()}
// 主畫面 3D 基地 on or off (Settings). Off: the scene and its GL context are freed, the chat fills the middle again
function seaSet(on){store.set('octa_stage3d',on?null:'0');if(!on&&SEA.g)seaFree(SEA.g);stageSync();if(on)seaEnsure()}
// 省電模式 or reduced motion changed
function seaPrefs(){const G=SEA.g;$('ovWrap')?.classList.toggle('still',seaStill());if(G){G.pr=seaPR();G.q=null;G.r.setPixelRatio(G.pr);seaResize();G.loop.kick(2)}}
const seaPR=()=>Math.min(devicePixelRatio||1,seaLow()?1:1.5);

/* ---------- the main screen's layout: which state the chat panel is in, where the stage and the cards live ---------- */
// chat: a chat is open over the base · min: folded to the bar · none: no chat (the base fills the stage, with a hint) ·
// blank: nothing to show yet (no bots, or the tour) — the welcome sits in the glass panel
function stageState(o){if(!o.stage)return 'classic';if(o.conv)return o.min?'min':'chat';return o.bots&&!o.tour?'none':'blank'}
function stageSync(){const app=$('app');if(!app)return;
  const on=stageMode(),c=cur&&conv(cur),bots=!!(S.bots.length||S.groups.length),st=stageState({stage:on,conv:!!c,min:STAGE.min,bots,tour:typeof tourOn==='function'&&tourOn()});
  app.classList.toggle('stage',on);app.classList.toggle('chat-min',st==='min');app.classList.toggle('stage-none',st==='none');
  app.dataset.stage=st;
  $('chatMin').hidden=st!=='min';$('stageHint').hidden=st!=='none';
  if(st==='min')paintChatMin(c);
  // the phone: the base as a header above the list (not without WebGL or when turned off), and 聊天 | 總覽
  const ph=phoneUI(),head=$('seaHead');head.hidden=!seaEnabled()||SEA.gl===false;head.classList.toggle('folded',seaFolded());
  $('seaHeadBar').setAttribute('aria-expanded',String(!seaFolded()));$('seaHeadBar').title=I18N.t(seaFolded()?'展開 3D 畫面':'收起 3D 畫面');
  $('side').classList.toggle('seg-ov',ph&&LSEG.k==='ov');
  document.querySelectorAll('[data-lseg]').forEach(b=>{const s=b.dataset.lseg===LSEG.k;b.setAttribute('aria-selected',String(s));b.classList.toggle('on',s)});
  if(SEA.st){SEA.st.classList.toggle('light',currentTheme()==='light');seaPlace()}
  $('ovWrap').classList.toggle('still',seaStill());
  // the chat that is open is the one picked in the base (after the cover is known: the camera aims beside the panel)
  seaCover();if(SEA.sel!==((c&&cur)||null))seaPick((c&&cur)||null);
  seaEnsure();if(SEA.g){seaThemeSync();SEA.g.loop.kick()}}
function seaPlace(){const st=SEA.st,host=phoneUI()?$('seaHostP'):$('seaHostD');if(st.parentNode!==host){host.appendChild(st);if(SEA.g)requestAnimationFrame(seaResize)}
  const ov=$('ovWrap'),oh=phoneUI()?$('lov'):$('wpOv');if(ov.parentNode!==oh)oh.appendChild(ov)}
// the slim bar of a folded chat: who, what it is doing, 展開對話
function paintChatMin(c){if(!c)return;const g=isG(c.id),b=SEA.m?.bots.find(x=>x.id===c.id);
  const av=$('cmAv');av.className='av'+(g?' grp':'');setHTML(av,g?gStack(c,true):avOf(c.id,'always'));
  setHTML($('cmName'),esc(c.name));setHTML($('cmSub'),b?`<span>${esc(I18N.t(b.word))}</span>${b.bubble?.txt&&!b.act?` · <span data-u>${esc(b.bubble.txt)}</span>`:''}`:'');
  const n=unread(c.id);$('cmNew').hidden=!n;$('cmNew').textContent=n>9?'9+':String(n||'')}
// 收起對話 / 展開對話
function chatMinimise(on){if(!stageMode()||!cur)return;STAGE.min=!!on;stageSync();
  if(on){seaFocus(SEA.focus);$('chatMinGo').focus({preventScroll:true})}else{if(SEA.sel)seaLook(SEA.sel);$('msg').focus({preventScroll:true})}}
// how much of the stage the chat panel (left) and a floating right panel (761–1180 px) cover: the camera aims at the rest
function seaCover(){let l=0,r=0,b=phoneUI()?6:38;const st=SEA.st,a=$('app');
  if(stageMode()&&st){const p=$('chatp');if(p.offsetParent&&!a.classList.contains('chat-min'))l=p.offsetLeft+p.offsetWidth+8;
    const wp=$('wp');if(!wp.hidden&&getComputedStyle(wp).position==='fixed')r=wp.offsetWidth;
    // the folded chat's bar and the hint sit at the bottom: the whole base stays above them
    if(a.classList.contains('chat-min'))b=$('chatMin').offsetHeight+28;else if(a.classList.contains('stage-none'))b=104}
  const w=st?.clientWidth||0;SEA.coverPx=l;SEA.rightPx=r;SEA.cover=w?Math.min(1,(l+r)/w):0;
  st?.classList.toggle('narrow',!!w&&w-l-r<300);   // little of the base left beside the chat: no depth gauge over it
  const G=SEA.g;if(G&&(G.l!==l||G.rr!==r||G.bb!==b)){const fresh=G.l==null;G.l=l;G.rr=r;G.bb=b;if(G.h)G.bot=G.h-b;seaAim(G);if(!fresh&&!SEA.focus&&!SEA.sel)seaFocus(null);G.loop.kick(2)}}
// the chat panel's width: drag its edge (remembered; double-click for the default; arrow keys too)
(()=>{const g=$('chatGrip'),pane=$('pane');if(!g)return;let on=false,x0=0,w0=0;
  const set=(w,save)=>{const max=Math.max(360,pane.clientWidth-180);w=Math.round(Math.max(340,Math.min(max,w)));pane.style.setProperty('--chatw',w+'px');if(save)store.set('octa_chatw',String(w));seaCover();return w};
  const n=+store.get('octa_chatw');if(n>=340)pane.style.setProperty('--chatw',n+'px');
  g.addEventListener('pointerdown',e=>{if(e.button!==0)return;on=true;x0=e.clientX;w0=$('chatp').offsetWidth;g.setPointerCapture(e.pointerId);pane.classList.add('sizing');e.preventDefault()});
  g.addEventListener('pointermove',e=>{if(on)set(w0+(e.clientX-x0)/(parseFloat(document.documentElement.style.zoom)||1),false)});
  const end=()=>{if(!on)return;on=false;pane.classList.remove('sizing');set($('chatp').offsetWidth,true)};
  g.addEventListener('pointerup',end);g.addEventListener('pointercancel',end);
  g.addEventListener('dblclick',()=>{pane.style.removeProperty('--chatw');store.set('octa_chatw',null);seaCover()});
  g.addEventListener('keydown',e=>{const d={ArrowLeft:-32,ArrowRight:32}[e.key];if(!d)return;e.preventDefault();set($('chatp').offsetWidth+d,true)});
  if(window.ResizeObserver)new ResizeObserver(()=>seaCover()).observe($('chatp'));
  $('chatMinBtn').onclick=()=>chatMinimise(true);
  $('chatMinGo').onclick=()=>chatMinimise(false)})();

/* ---------- the picture follows the state; the counters and the cards are painted by overview.js ---------- */
function seaRefresh(force){
  const m=seaModel(seaInput()),sig=JSON.stringify(m);if(!force&&sig===SEA.sig)return;SEA.sig=sig;
  SEA.m=m;SEA.L=seaLayout(m);
  seaDepth();if(SEA.g)seaSync();if(ovShown())paintOverview();
  const c=m.counters;setHTML($('seaHeadSum'),[c.working?`<span data-u>${c.working}</span> <span>工作中</span>`:'',c.need?`<b><span data-u>${c.need}</span> <span>需要你</span></b>`:''].filter(Boolean).join(' · '));
  if($('app').classList.contains('chat-min'))paintChatMin(cur&&conv(cur))}
function seaDepth(){const m=SEA.m,el=$('seaDepth');if(!m||!el)return;const p=m.pods.find(x=>x.id===SEA.focus)||m.pods[0];
  setHTML(el,`<small>深度</small><b data-u>${p.depth}</b><small data-u>m</small><i class="sea-gauge"><i style="height:${Math.min(100,Math.round((p.depth-100)/Math.max(1,(m.pods.length)*20+20)*100))}%"></i></i>`)}
const SEA_OCT=2.2;   // an octopus is this tall (metres)
// light up one bot (or meeting room) in both places: its octopus (name, bubble, halo) and its card
function seaHi(id){if(SEA.hover===id)return;SEA.hover=id;ovMark();if(SEA.g)SEA.g.loop.kick()}
/* the open chat is the picked one: its card is marked, its octopus gets the ring, and the camera swims there
   (on a phone the small header keeps the whole base). null: nothing picked */
function seaPick(id){SEA.sel=id||null;ovMark();if(id&&!phoneUI())seaLook(id);else if(SEA.g)SEA.g.loop.kick()}
// an octopus, a meeting room or a card was picked: open that chat (unfolding the chat panel) and look at it
function seaOpenConv(id){if(!conv(id))return;STAGE.min=false;
  if(cur===id){stageSync();seaLook(id);if(!phoneUI())$('msg').focus({preventScroll:true})}else openConv(id);
  ovReveal(id)}
function seaLook(id){const G=SEA.g,L=SEA.L,m=SEA.m;if(!G||!L||!m||!seaShown())return;
  const b=m.bots.find(x=>x.id===id),r=L.rooms[id],e=G.bots[id];let x,z,d;
  if(b&&e){const p=e.goal||e.pos;x=p.x;z=p.z;d=19}else if(r){x=r.x;z=r.z;d=17}else return;
  SEA.focus=b?b.pod:m.rooms.find(q=>q.id===id)?.pod||null;$('seaAll').hidden=false;seaDepth();ovMark();
  // as close as the part of the stage beside the chat panel allows
  const g=G.goal,asp=Math.max(.3,((G.w||1)-(G.l||0)-(G.rr||0))/(G.h||1));g.tx=x;g.tz=z;g.d=d/Math.min(1,asp*1.05);g.ph=.92;
  const tw=Math.PI*2;g.th=G.view.th+((((g.th-G.view.th+Math.PI)%tw)+tw)%tw)-Math.PI;
  if(seaReduced())Object.assign(G.view,g);G.loop.kick(3)}

/* ---------- the 3D scene: built once; freed only when 主畫面 3D 基地 is turned off ---------- */
// the water: deep (深海, dark) or a lighter sea (light)
const SEA_PAL={deep:{bg:0x021019,fog:0x042132,fd:.0135,lo:[.008,.05,.08],hi:[.03,.24,.32],gl:[.05,.22,.25],hemi:1.15,sun:1.7,amb:.45,exp:1.05},
  light:{bg:0x2b7e9c,fog:0x3a8cab,fd:.0095,lo:[.09,.32,.42],hi:[.36,.70,.82],gl:[.22,.40,.40],hemi:1.55,sun:2.1,amb:.75,exp:1.12}};
function seaThemeSync(){const G=SEA.g;if(!G)return;const k=currentTheme()==='light'?'light':'deep';if(G.pal===k)return;G.pal=k;const P=SEA_PAL[k];
  G.scene.background.setHex(P.bg);G.scene.fog.color.setHex(P.fog);G.fd=P.fd;G.r.toneMappingExposure=P.exp;
  G.hemi.intensity=P.hemi;G.sun.intensity=P.sun;G.amb.intensity=P.amb;
  if(G.sky){const u=G.sky.material.uniforms;u.uLo.value.fromArray(P.lo);u.uHi.value.fromArray(P.hi);u.uGl.value.fromArray(P.gl)}
  SEA.st?.classList.toggle('light',k==='light');G.loop.kick(2)}
function seaInit(T){const st=SEA.st;
  const cv=document.createElement('canvas');cv.className='sea-cv';cv.setAttribute('aria-hidden','true');st.insertBefore(cv,st.firstChild.nextSibling);
  let r;try{r=new T.WebGLRenderer({canvas:cv,antialias:true,powerPreference:'default',stencil:false})}catch(e){cv.remove();seaFallback();return}
  SEA.ac=new AbortController();const sig={signal:SEA.ac.signal};
  r.setPixelRatio(seaPR());r.toneMapping=T.ACESFilmicToneMapping;r.toneMappingExposure=1.05;
  const scene=new T.Scene();scene.background=new T.Color(0x021019);scene.fog=new T.FogExp2(0x042132,.0135);
  const cam=new T.PerspectiveCamera(40,1,.1,500);
  const U={uTime:{value:0}};
  const G={T,r,scene,cam,U,cv,pr:seaPR(),tex:{},alive:true,bots:{},labels:{},base:null,env:null,t:0,fd:.0135,
    view:{th:.55,ph:.98,d:60,tx:0,tz:0},goal:{th:.55,ph:.98,d:60,tx:0,tz:0},ptr:new Map(),moved:0,ray:new T.Raycaster(),
    glow:seaGlowTex(T),pick:[],pp:[null,null],off:null,l:null,rr:null};
  G.loop=seaLoop({raf:f=>requestAnimationFrame(f),caf:id=>cancelAnimationFrame(id),now:()=>performance.now(),frame:(dt)=>seaFrame(G,dt),
    hidden:()=>document.hidden||!seaShown(),rate:seaRateNow});
  SEA.g=G;
  G.hemi=new T.HemisphereLight(0x7fdcf0,0x081820,1.15);scene.add(G.hemi);
  G.sun=new T.DirectionalLight(0xc6f4ff,1.7);G.sun.position.set(12,40,6);scene.add(G.sun);
  const fill=new T.DirectionalLight(0x6a7dff,.35);fill.position.set(-20,8,-14);scene.add(fill);
  G.amb=new T.AmbientLight(0x1d5a6e,.45);scene.add(G.amb);
  G.env=seaEnv(G);scene.add(G.env);
  // the picked octopus (the open chat) stands in a soft ring
  G.ring=new T.Mesh(new T.RingGeometry(1.05,1.32,48).rotateX(-Math.PI/2),new T.MeshBasicMaterial({color:0x8ff8f4,transparent:true,opacity:.7,depthWrite:false,blending:T.AdditiveBlending,toneMapped:false}));
  G.ring.visible=false;G.ring.renderOrder=3;scene.add(G.ring);
  seaThemeSync();
  seaSync();seaResize();seaFocus(null,true);if(SEA.sel&&!phoneUI())seaLook(SEA.sel);
  seaControls(G);
  // when it draws: the window shown or hidden, in front or behind (30 s behind: it stops), typing, the stage resized
  document.addEventListener('visibilitychange',()=>G.loop.kick(),sig);
  addEventListener('blur',()=>{SEA.blurAt=Date.now();G.loop.kick()},sig);
  addEventListener('focus',()=>{SEA.blurAt=0;G.loop.kick()},sig);
  document.addEventListener('focusin',()=>G.loop.kick(),sig);document.addEventListener('focusout',()=>G.loop.kick(),sig);
  matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change',()=>seaPrefs(),sig);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change',()=>seaThemeSync(),sig);
  document.addEventListener('keydown',seaKey,sig);
  if(window.ResizeObserver){G.ro=new ResizeObserver(()=>seaResize());G.ro.observe(st)}
  st.classList.add('ready');G.loop.start()}
function seaFree(G){G.alive=false;G.loop.stop();SEA.ac?.abort();SEA.ac=null;if(G.ro&&SEA.st)G.ro.unobserve(SEA.st);
  for(const id in G.labels)G.labels[id].el.remove();
  const n=seaDispose(G.scene,[...Object.values(G.tex),G.glow,...(G.extra||[])]);
  G.r.renderLists?.dispose();G.r.dispose();try{G.r.forceContextLoss()}catch(e){}G.cv.remove();G.scene.clear();G.tex={};G.bots={};G.labels={};
  SEA.g=null;SEA.ssig='';SEA.hover=null;SEA.st?.classList.remove('ready');$('seaTip').hidden=true;
  SEA.freed=n}
function seaResize(){const G=SEA.g;if(!G||!SEA.st)return;const w=SEA.st.clientWidth,h=SEA.st.clientHeight;if(!w||!h)return;
  if(w!==G.w||h!==G.h){G.w=w;G.h=h;G.r.setSize(w,h,false);G.cam.aspect=w/h;G.off=null}
  G.top=34;G.bot=h-(G.bb??38);seaCover();seaAim(G);if(!SEA.focus&&!SEA.sel)seaFocus(null,true);G.loop.kick(2)}
// aim the view at the part of the stage the chat panel leaves free (eased in seaFrame)
function seaAim(G){if(!G.w)return;G.fr=seaFrameOf({w:G.w,h:G.h,left:G.l||0,right:G.rr||0,top:0});G.loop.kick(2)}
function seaKey(e){if(e.key!=='Escape'||!$('veil').hidden||!seaShown()||document.querySelector('.menu'))return;
  const a=document.activeElement;if(a&&a!==document.body&&a!==SEA.g?.cv&&!SEA.st.contains(a))return;
  if(SEA.focus){e.preventDefault();seaFocus(null)}}

function seaMoving(G){const v=G.view,g=G.goal,o=G.off,f=G.fr;if(o&&f&&Math.abs(o.x-f.ox)+Math.abs(o.y-f.oy)>.5)return true;if(Math.abs(v.th-g.th)+Math.abs(v.ph-g.ph)+Math.abs(v.d-g.d)/10+Math.abs(v.tx-g.tx)/10+Math.abs(v.tz-g.tz)/10>.002)return true;
  for(const id in G.bots)if(G.bots[id].route)return true;return false}

/* one frame: time, camera, octopuses, pulses, labels, then draw */
function seaFrame(G,dt){if(!G.alive)return;const T=G.T,still=seaStill();
  // a computer that cannot keep up (under 20 frames a second) gets fewer pixels, down to 60 %
  if(!still){const q=G.q||(G.q={n:0,s:0});q.n++;q.s+=dt;if(q.n>=45){const slow=q.s/q.n>.05;q.n=q.s=0;if(slow&&G.pr>.6){G.pr=Math.max(.6,G.pr-.2);G.r.setPixelRatio(G.pr);seaResize()}}}
  if(!still)G.t+=dt;   // still pictures keep the time where it was
  const t=G.t;G.U.uTime.value=t;
  // the camera eases toward where you dragged or clicked
  const v=G.view,g=G.goal,k=seaReduced()?1:1-Math.exp(-dt*7);for(const x of ['th','ph','d','tx','tz'])v[x]+=(g[x]-v[x])*k;
  // 4.10 the view slides over when the chat panel opens, folds or changes width (what it looks at stays beside the panel)
  const f=G.fr;if(f&&G.w){const o=G.off||(G.off={x:f.ox,y:f.oy,s:''});o.x+=(f.ox-o.x)*k;o.y+=(f.oy-o.y)*k;if(Math.abs(f.ox-o.x)<.5){o.x=f.ox;o.y=f.oy}
    const s=G.w+'|'+G.h+'|'+o.x.toFixed(1)+'|'+o.y.toFixed(1);if(s!==o.s){o.s=s;G.cam.setViewOffset(G.w,G.h,o.x,o.y,G.w,G.h);G.cam.updateProjectionMatrix()}}
  G.scene.fog.density=(G.fd||.0135)*Math.max(.4,Math.min(1,48/v.d));   // far out, less murk: the base stays readable
  const c=G.cam,sp=Math.sin(v.ph);c.position.set(v.tx+v.d*sp*Math.sin(v.th),v.d*Math.cos(v.ph)+.5,v.tz+v.d*sp*Math.cos(v.th));c.lookAt(v.tx,1.2,v.tz);
  // toward the camera and to its right, on the floor (props sit in front of their octopus)
  {const fx=c.position.x-v.tx,fz=c.position.z-v.tz,fl=Math.hypot(fx,fz)||1;G.fx=fx/fl;G.fz=fz/fl}
  G.pp[0]=G.pp[1]=null;G.t1='';G.arc=0;G.juke=0;
  // octopuses
  const scrC=G.scrC||(G.scrC=new T.Color());let scrDirty=false;
  for(const id in G.bots){const e=G.bots[id],b=e.b;if(!b)continue;let x=e.pos.x,z=e.pos.z,y=.92,swim=0;
    if(e.route){e.s+=dt*3.4/Math.max(1,e.route.len);const p=seaAlong(e.route,Math.min(1,e.s));x=p.x;z=p.z;swim=Math.sin(Math.min(1,e.s)*Math.PI);y=.92+swim*.35;e.pos={x,z};
      if(e.s>=1){e.route=null;e.pos={x:e.goal.x,z:e.goal.z}}}
    const bob=still||b.paused?0:b.state==='idle'?Math.sin(t*1.3+e.ph)*.05:b.state==='working'?Math.abs(Math.sin(t*4.2+e.ph))*.1:b.state==='thinking'?Math.sin(t*1.8+e.ph)*.07:Math.sin(t*2.6+e.ph)*.06;
    // 4.9.2 playing: props, a dance, a lap round its dome (once it got there; work makes it swim straight back)
    const ak=!e.route&&b.act&&!b.job?b.act.k:'';if(e.ak!==ak){e.ak=ak;seaPropSet(G,e,ak)}
    let py=y+bob+(swim?Math.sin(t*6)*.08:0),rot=null;e.hop=0;
    e.lk+=((ak==='lap'?1:0)-e.lk)*Math.min(1,dt*2.5);
    if(e.lk>.002){const p=SEA.L?.pods[b.pod];if(p){const an=t*.4+e.ph,R=Math.max(1.3,p.r*.7);x+=(p.x+Math.cos(an)*R-x)*e.lk;z+=(p.z+Math.sin(an)*R-z)*e.lk;py+=e.lk*1.4;rot=Math.sin(t*5)*.12*e.lk}}
    if(ak){const r=seaPlay(G,e,b,ak,x,py,z,t);if(r!=null)rot=r}
    e.sp.position.set(x,py+e.hop,z);
    const sq=still||b.paused?1:b.state==='working'?1+Math.sin(t*8.4+e.ph)*.035:1+Math.sin(t*2+e.ph)*.015;e.sp.scale.set(SEA_OCT/sq,SEA_OCT*sq,1);
    e.sp.material.rotation=rot!=null?rot:still?0:b.state==='thinking'?Math.sin(t*1.6+e.ph)*.1:swim?Math.sin(t*5)*.12:0;
    e.sh.position.set(x,.53,z);e.sh.scale.setScalar(1-bob*.8);
    e.halo.position.set(x,py+e.hop+1.2,z);const hl=SEA.hover===id||SEA.sel===id;e.halo.scale.set(hl?4:2.6,hl?4:2.6,1);e.halo.material.opacity=hl?.75:b.job&&!b.paused?.34+(still?0:Math.sin(t*3+e.ph)*.08):.14;
    if(e.beam){e.beam.position.set(x,0,z);const u=e.beam.userData,ph=still?.35:(t*.7+e.ph)%1;u.ring.scale.setScalar(1+ph*1.6);u.ring.material.opacity=.85*(1-ph);
      u.lamp.material.opacity=still?1:.55+.45*Math.sin(t*(u.tone==='need'?5:2.2));u.lamp.position.y=2.45+bob;u.beam.material.opacity=u.tone==='need'?.32+(still?0:.08*Math.sin(t*5)):.18}
    // the desk screen: lit in the bot's colour while it works, flickering with the typing; dim when it rests
    const i=G.deskIdx[id];if(i!=null){const col=colorHex(b.color)||OC_DEFAULT;
      if(b.fail)scrC.set(0xff5a5a).multiplyScalar(.7+(still?0:.3*Math.sin(t*2)));
      else if(b.need)scrC.set(0xffb547).multiplyScalar(.8);
      else if(b.job&&!b.paused&&b.room==null&&!b.from)scrC.set(col).lerp(new T.Color(0x9ff6ff),.35).multiplyScalar(1.05+(still?0:.25*Math.sin(t*13+e.ph)*Math.sin(t*3.1)));
      else if(b.job)scrC.set(0x5fb0c4).multiplyScalar(.6);
      else scrC.set(0x0f3346);
      G.scr.setColorAt(i,scrC);scrDirty=true}}
  if(scrDirty)G.scr.instanceColor.needsUpdate=true;
  // 4.10 the open chat's octopus (or meeting room) stands in a soft ring
  {const se=SEA.sel&&G.bots[SEA.sel],rm=!se&&SEA.sel&&SEA.L?.rooms[SEA.sel],R=G.ring;
    if(R&&(se||rm)){const x=se?se.sp.position.x:rm.x,z=se?se.sp.position.z:rm.z,p=still?0:Math.sin(t*2.4),s=(se?1:Math.max(1.6,(rm.r||2)*.8))*(1+p*.05);
      R.visible=true;R.position.set(x,.56,z);R.scale.set(s,1,s);R.material.opacity=.55+p*.15}else if(R)R.visible=false}
  seaLoungeFrame(G,t,still);
  // light pulses along the tubes (brighter where work is being handed over)
  const hot=new Set();for(const k of SEA.m?.links||[]){const a=SEA.m.bots.find(x=>x.id===k.from),b=SEA.m.bots.find(x=>x.id===k.to);if(a&&b){hot.add('hub>'+a.pod);hot.add('hub>'+b.pod)}}
  for(const tb of G.tubes||[]){const h=hot.has(tb.key);tb.pulses.forEach((s,i)=>{const u=((t*(h?.42:.16)*(8/Math.max(4,tb.len)))+i*.5)%1;s.position.copy(tb.curve.getPointAt(h&&i?1-u:u));s.material.opacity=still?.5:Math.sin(u*Math.PI)*(h?1:.6);s.scale.setScalar(h?1.2:.8)})}
  for(const s of G.pulses||[])s.material.opacity=still?.6:.45+.3*Math.sin(t*1.4+s.userData.pulse);
  for(const s of G.pulses2||[])s.material.opacity=still?.8:.6+.4*Math.sin(t*2.2+(s.userData.pulse||0));
  for(const s of G.spin||[])s.rotation.z=still?0:t*(.4+s.userData.spin*.15);
  for(const h of G.holos||[])h.rotation.y=t*.6;
  for(const j of G.jelly||[]){const u=j.userData,k=Math.sin(t*.9+u.ph);j.position.y=u.y+Math.sin(t*.25+u.ph)*1.2+(still?0:k*.15);j.scale.set(u.sz*(1+k*.06),u.sz*(1-k*.08),1)}
  for(const r of G.rays||[]){r.rotation.y=Math.atan2(c.position.x-r.position.x,c.position.z-r.position.z);r.rotation.z=r.userData.tilt}
  if(G.fish){const f=G.fish,M=new T.Matrix4(),Q=new T.Quaternion(),E=new T.Euler(),V=new T.Vector3(),one=new T.Vector3(1,1,1),R=(SEA.L?.span||26)+16;
    f.userData.seed.forEach(([a,b,cc],i)=>{const ang=t*.07+a*.9,rr=R+b*5+Math.sin(t*.5+i)*.6;V.set(Math.cos(ang)*rr,5.5+cc*2.5+Math.sin(t*.8+i)*.25,Math.sin(ang)*rr);E.set(0,-ang,Math.sin(t*3+i)*.15);Q.setFromEuler(E);M.compose(V,Q,one);f.setMatrixAt(i,M)});f.instanceMatrix.needsUpdate=true}
  G.r.render(G.scene,c);
  seaTags(G)}
// names and bubbles follow their octopus on the screen; bubbles that would cover each other step up
function seaScreen(id){const G=SEA.g,e=G?.bots[id];if(!e)return null;const v=new G.T.Vector3(e.sp.position.x,e.sp.position.y+SEA_OCT*.95,e.sp.position.z).project(G.cam);
  if(v.z>1)return null;return {x:(v.x+1)/2*seaW(),y:(1-v.y)/2*seaH()}}
function seaTags(G){const W=seaW(),H=seaH(),V=new G.T.Vector3(),cam=G.cam,placed=[],far=G.view.d>48,fp=SEA.focus,top=(G.top||100)+6,bottom=G.bot||H,lf=G.l||0,rt=W-(G.rr||0);
  const list=[];
  for(const key in G.labels){const lb=G.labels[key];let at=lb.at,b=null,bp=null;   // bp: where it is now (遊戲角 while it plays)
    if(key[0]==='b'){const e=G.bots[key.slice(2)];if(!e)continue;b=e.b;at={x:e.sp.position.x,y:e.sp.position.y+SEA_OCT*.92,z:e.sp.position.z};bp=e.node&&e.node.startsWith('pod:')?e.node.slice(4):b?.pod}
    else{const dx=cam.position.x-at.x,dz=cam.position.z-at.z,l=Math.hypot(dx,dz)||1;at={x:at.x+dx/l*at.r,y:.15,z:at.z+dz/l*at.r}}   // a nameplate on the front of the base
    V.set(at.x,at.y,at.z).project(cam);let show=V.z<1&&V.x>-1.1&&V.x<1.1&&V.y>-1.2&&V.y<1.2;
    // far away, a quiet bot shows only its name; in a module you look into, the others step back
    const quiet=b&&(!b.bubble||b.bubble.tone==='idle'||(W<760&&!fp&&!['need','fail'].includes(b.bubble.tone)));   // a phone shows what needs you first
    if(b&&fp&&bp!==fp&&quiet&&SEA.hover!==b.id&&SEA.sel!==b.id)show=false;
    list.push({lb,show,x:(V.x+1)/2*W,y:(1-V.y)/2*H,z:V.z,b,bp,quiet,pod:key[0]!=='b'})}
  // places first (they stay put), then the octopuses nearest the camera
  // what needs you is placed first, then work in progress, then the rest; nearer first
  const rank=it=>it.pod?9:it.b&&(SEA.sel===it.b.id||SEA.hover===it.b.id)?-1:!it.b.bubble?4:{need:0,fail:0,run:1,chat:1,pause:2}[it.b.bubble.tone]??3;
  list.sort((a,b)=>(rank(a)-rank(b))||(a.z-b.z));
  for(const it of list){const lb=it.lb;let show=it.show;
    if(show){const el=lb.el;
      const hl=!!(it.b&&(SEA.hover===it.b.id||SEA.sel===it.b.id));if(lb.hl!==hl){lb.hl=hl;lb.el.classList.toggle('hl',hl)}
      let small=it.b&&far&&!fp&&it.quiet&&!hl;
      // sizes with and without the bubble, measured once per change of text
      if(it.b&&!lb.fw){el.classList.remove('nob');lb.fw=el.offsetWidth;lb.fh=el.offsetHeight;el.classList.add('nob');lb.nw=el.offsetWidth;lb.nh=el.offsetHeight;lb.small=null}
      if(!it.b&&!lb.w){lb.w=el.offsetWidth;lb.hh=el.offsetHeight}
      let y=it.y,w=it.b?(small?lb.nw:lb.fw):lb.w,h=it.b?(small?lb.nh:lb.fh):lb.hh;
      if(it.pod){if(y+h>bottom+4||y<top||placed.some(p=>Math.abs(p.x-it.x)<(p.w+w)/2&&y<p.y&&y+h>p.y-p.h))show=false}   // a nameplate gives way to an octopus
      else for(let pass=0;pass<5;pass++){const hit=placed.find(p=>Math.abs(p.x-it.x)<(p.w+w)/2+3&&Math.abs((p.y-p.h/2)-(y-h/2))<(p.h+h)/2+2);if(!hit)break;
        y=hit.y-hit.h-3}
      // no room above: just the name, where it belongs
      if(it.b&&!small&&y-h<top-12){small=true;y=it.y;w=lb.nw;h=lb.nh;
        if(placed.some(p=>Math.abs(p.x-it.x)<(p.w+w)/2&&Math.abs((p.y-p.h/2)-(y-h/2))<(p.h+h)/2))show=false}
      if(it.b&&lb.small!==small){lb.small=small;el.classList.toggle('nob',!!small)}
      if(!it.pod&&(y-h<top-12||y>bottom+4))show=false;
      // 4.10 nothing under the chat panel: a label just past its edge moves out beside it, one further in is not shown
      if(it.pod&&(it.x-w/2<lf+4||it.x+w/2>rt-4))show=false;
      if(!it.pod&&(it.x<lf-36||it.x>rt+36))show=false;
      if(show&&it.pod){const x=Math.round(it.x),yy=Math.round(y);if(x!==lb.x||yy!==lb.y){lb.x=x;lb.y=yy;lb.el.style.transform=`translate(${x}px,${yy}px) translate(-50%,6px)`}}
      else if(show){placed.push({x:it.x,y,w,h});
        lb.el.classList.toggle('dim',!!(it.b&&fp&&it.bp!==fp));
        const x=Math.round(Math.max(lf+w/2+4,Math.min(rt-w/2-4,it.x))),yy=Math.round(y);if(x!==lb.x||yy!==lb.y){lb.x=x;lb.y=yy;lb.el.style.transform=`translate(${x}px,${yy}px) translate(-50%,-100%)`}}}
    if(lb.vis!==show){lb.vis=show;lb.el.style.visibility=show?'':'hidden'}}}

/* ---------- moving around: drag to turn, right-drag / two fingers / Shift to pan, wheel or pinch to zoom, click a dome ---------- */
function seaFocus(id,now){const G=SEA.g;SEA.focus=id;if($('seaAll'))$('seaAll').hidden=!id;seaDepth();ovMark();
  if(!G||!SEA.L)return;const L=SEA.L,g=G.goal;
  if(id&&L.pods[id]){const p=L.pods[id],va=Math.max(.3,((G.w||1)-(G.l||0)-(G.rr||0))/(G.h||1));g.tx=p.x;g.tz=p.z;g.d=(p.r*2.6+9)/Math.min(1,va*1.05);g.ph=.9;g.th=id==='hub'?g.th:Math.atan2(p.x,p.z)||g.th}
  else{g.ph=.86;seaFit(G,g,!G.fitted||!now);G.fitted=true}
  const tw=Math.PI*2;g.th=G.view.th+((((g.th-G.view.th+Math.PI)%tw)+tw)%tw)-Math.PI;   // the short way round
  if(now||seaReduced())Object.assign(G.view,g);G.loop.kick(3)}
// the whole base in view, in the part of the stage beside the chat panel: centre on its middle, then the nearest distance that fits
function seaFit(G,g,turn){const L=SEA.L,T=G.T,pts=[];let x0=1e9,x1=-1e9,z0=1e9,z1=-1e9;
  for(const o of [...Object.values(L.pods),...Object.values(L.rooms)]){x0=Math.min(x0,o.x-o.r);x1=Math.max(x1,o.x+o.r);z0=Math.min(z0,o.z-o.r);z1=Math.max(z1,o.z+o.r);
    for(const [dx,dz] of [[1,0],[-1,0],[0,1],[0,-1]])pts.push(new T.Vector3(o.x+dx*(o.r+.6),0,o.z+dz*(o.r+.6)));pts.push(new T.Vector3(o.x,o.r+2.4,o.z))}
  g.tx=(x0+x1)/2;g.tz=(z0+z1)/2;
  const c=G.cam.clone(),H=seaH()||800,W=seaW()||1,yTop=1-2*((G.top||100)+52)/H,yBot=1-2*(G.bot||H)/H,V=new T.Vector3(),fr=G.fr||seaFrameOf({w:W,h:H});
  // the camera as it will be: shifted beside the chat panel
  c.setViewOffset(W,H,fr.ox,fr.oy,W,H);c.updateProjectionMatrix();const xl=fr.xl+.06,xr=(fr.xr??1)-.06;
  const fits=d=>{const sp=Math.sin(g.ph);c.position.set(g.tx+d*sp*Math.sin(g.th),d*Math.cos(g.ph)+.5,g.tz+d*sp*Math.cos(g.th));c.lookAt(g.tx,1.2,g.tz);c.updateMatrixWorld();
    return pts.every(p=>{V.copy(p).project(c);return V.z<1&&V.x>xl&&V.x<xr&&V.y<yTop&&V.y>yBot})};
  const best=()=>{let lo=8,hi=180;for(let i=0;i<13;i++){const m=(lo+hi)/2;if(fits(m))hi=m;else lo=m}return hi};
  // the first time (and 回到全景): turn to the side that shows the base biggest
  // (and no module hidden behind another: domes that cover each other on the screen count against a side)
  const cover=d=>{fits(d);const ps=[...Object.values(L.pods),...Object.values(L.rooms)].map(o=>{V.set(o.x,o.r*.5,o.z).project(c);return {x:V.x,y:V.y*H/(seaW()||1),r:o.r/Math.max(1,c.position.distanceTo(new T.Vector3(o.x,0,o.z)))*2.2}});
    let n=0;for(let i=0;i<ps.length;i++)for(let j=i+1;j<ps.length;j++){const a=ps[i],b=ps[j];if(Math.hypot(a.x-b.x,(a.y-b.y))<(a.r+b.r)*.85)n++}return n};
  if(turn){let bt=g.th,bd=1e9,bs=1e9;for(let i=0;i<12;i++){g.th=i*Math.PI/6+.3;const d=best(),sc=d*(1+.35*cover(d));if(sc<bs-.5){bs=sc;bd=d;bt=g.th}}g.th=bt;g.d=bd}else g.d=best()}
function seaControls(G){const cv=G.cv,sig={signal:SEA.ac.signal},P=G.ptr;let pinch=0,mid=null;
  const clampG=()=>{const g=G.goal,L=SEA.L;g.ph=Math.max(.32,Math.min(1.36,g.ph));g.d=Math.max(6,Math.min(170,g.d));const lim=(L?.span||26)+8;g.tx=Math.max(-lim,Math.min(lim,g.tx));g.tz=Math.max(-lim,Math.min(lim,g.tz))};
  const pan=(dx,dy)=>{const g=G.goal,s=g.d*.0016,c=Math.cos(g.th),n=Math.sin(g.th);g.tx-=(dx*c-dy*n*1.3)*s;g.tz-=(-dx*n-dy*c*1.3)*s};
  cv.addEventListener('pointerdown',e=>{cv.setPointerCapture(e.pointerId);P.set(e.pointerId,{x:e.clientX,y:e.clientY,b:e.button,sh:e.shiftKey});G.moved=0;
    if(P.size===2){const [a,b]=[...P.values()];pinch=Math.hypot(a.x-b.x,a.y-b.y);mid={x:(a.x+b.x)/2,y:(a.y+b.y)/2}}},sig);
  cv.addEventListener('pointermove',e=>{const p=P.get(e.pointerId);
    if(!p){if(e.pointerType==='mouse')seaHover(e);return}
    const dx=e.clientX-p.x,dy=e.clientY-p.y;p.x=e.clientX;p.y=e.clientY;G.moved+=Math.abs(dx)+Math.abs(dy);
    if(P.size>=2){const [a,b]=[...P.values()],d=Math.hypot(a.x-b.x,a.y-b.y),m={x:(a.x+b.x)/2,y:(a.y+b.y)/2};if(pinch)G.goal.d*=pinch/Math.max(10,d);pinch=d;if(mid)pan(m.x-mid.x,m.y-mid.y);mid=m}
    else if(p.b===2||p.b===1||p.sh)pan(dx,dy);
    else{G.goal.th-=dx*.0065;G.goal.ph-=dy*.005}
    clampG();if(seaReduced())Object.assign(G.view,G.goal);G.loop.kick(2);$('seaTip').hidden=true},sig);
  const up=e=>{const p=P.get(e.pointerId);P.delete(e.pointerId);if(P.size<2){pinch=0;mid=null}
    if(p&&G.moved<6&&e.type==='pointerup'&&P.size===0)seaClick(e)};
  cv.addEventListener('pointerup',up,sig);cv.addEventListener('pointercancel',up,sig);
  cv.addEventListener('pointerleave',()=>{if(SEA.hover){SEA.hover=null;cv.style.cursor=''}$('seaTip').hidden=true},sig);
  cv.addEventListener('wheel',e=>{e.preventDefault();G.goal.d*=Math.exp(Math.max(-.6,Math.min(.6,e.deltaY*.0013)));clampG();if(seaReduced())Object.assign(G.view,G.goal);G.loop.kick(2)},{...sig,passive:false});
  cv.addEventListener('contextmenu',e=>e.preventDefault(),sig);
  cv.addEventListener('dblclick',()=>seaFocus(null),sig)}
function seaHit(e){const G=SEA.g;if(!G)return null;const r=G.cv.getBoundingClientRect(),z=typeof pageZoom==='function'?pageZoom():1;
  const nx=((e.clientX/z-r.left)/r.width)*2-1,ny=-((e.clientY/z-r.top)/r.height)*2+1;G.ray.setFromCamera({x:nx,y:ny},G.cam);
  const hits=G.ray.intersectObjects(G.pick,false);const bh=hits.find(h=>h.object.userData.bot);return (bh||hits[0])?.object.userData||null}
function seaHover(e){const G=SEA.g;if(!G||G.hv)return;G.hv=requestAnimationFrame(()=>{G.hv=0;if(!SEA.g)return;const u=seaHit(e),tip=$('seaTip');
  const hb=u?.bot||u?.room||null;if(hb!==SEA.hover){SEA.hover=hb;ovMark();G.loop.kick()}
  G.cv.style.cursor=u?'pointer':'';if(!u){tip.hidden=true;return}
  const m=SEA.m;let h='';
  if(u.bot){const b=m.bots.find(x=>x.id===u.bot);if(b)h=`<b data-u>${esc(b.name)}</b><span>${esc(I18N.t(b.word))}</span>${b.bubble?.txt&&!b.act?`<small data-u>${esc(b.bubble.txt)}</small>`:''}<small>點一下打開對話</small>`}
  else if(u.pod==='play')h=`<b>遊戲角</b><span>沒有工作的機器人在這裡玩</span>`;
  else if(u.pod){const p=m.pods.find(x=>x.id===u.pod);if(p){const bs=p.bots.map(id=>m.bots.find(b=>b.id===id));h=`<b data-u>${esc(seaPodName(p))}</b><span><span data-u>${bs.length}</span> <span>個機器人</span> · <span data-u>${bs.filter(b=>b.job).length}</span> <span>工作中</span></span><small>點一下進入</small>`}}
  else if(u.room){const r=m.rooms.find(x=>x.id===u.room);if(r)h=`<b data-u>${esc(r.name)}</b><span>會議室</span><small>點一下打開群組</small>`}
  if(!h){tip.hidden=true;return}if(tip.dataset.k!==h){tip.dataset.k=h;setHTML(tip,h)}tip.hidden=false;
  const R=SEA.st.getBoundingClientRect(),W=seaW();tip.style.transform=`translate(${Math.min(W-tip.offsetWidth-10,e.clientX-R.left+16)}px,${e.clientY-R.top+14}px)`})}
// a click in the picture: an octopus or a meeting room → its chat opens (and its card is shown); a dome → go in, and its 分區 in the cards
function seaClick(e){const u=seaHit(e);if(!u)return;
  if(u.bot){seaOpenConv(u.bot);return}
  if(u.room){seaOpenConv(u.room);return}
  if(u.pod){seaFocus(u.pod);if(u.pod!=='play')ovRevealPod(u.pod)}}

