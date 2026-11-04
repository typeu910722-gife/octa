/* OCTA 4.9 深海基地 — every bot at work in an underwater research base (seamodel.js works out what it shows).
   three.js (app/vendor, loaded only when the view opens) draws the sea floor, glass domes and tubes; each bot is its
   own octopus (the avatar drawing, as a sprite); names, speech bubbles and the HUD are plain HTML on top.
   Smooth on an ordinary laptop: at most 30 frames a second, pixel ratio ≤ 1.5, nothing drawn while hidden or minimised,
   省電模式 / reduced motion: still pictures redrawn only when something changes. Closing frees every GPU resource. */
'use strict';
const SEA_LIB='/vendor/three-0.170.0.module.min.js';
const SEA={el:null,g:null,m:null,L:null,done:{},doneT:0,doneRev:-1,sig:'',ssig:'',focus:null,qc:null,ac:null,iv:0,hover:null};
const seaOpen=()=>!!SEA.el;
const seaPodName=p=>p.kind==='hub'?I18N.t(p.name):p.name;
const seaLow=()=>store.get('octa_lowpower')==='1';
const seaReduced=()=>matchMedia('(prefers-reduced-motion: reduce)').matches;
const seaStill=()=>seaLow()||seaReduced();
let SEA_MOD=null;
const seaLib=()=>SEA_MOD||(SEA_MOD=import(SEA_LIB).catch(e=>{SEA_MOD=null;throw e}));
function seaHasGL(){try{const c=document.createElement('canvas');return !!(c.getContext('webgl2')||c.getContext('webgl'))}catch(e){return false}}
const seaInput=()=>({bots:ordered(S.bots),groups:S.groups,folders:S.folders,busy:S.busy,last:S.last,lastJob:S.lastJob,gask:S.gask,done:SEA.done,now:Date.now()});

/* ---------- open / close ---------- */
function openSea(){if(SEA.el)return;if(typeof closeMenu==='function')closeMenu();
  const el=document.createElement('div');el.className='seaview';el.id='sea';el.setAttribute('role','dialog');el.setAttribute('aria-modal','true');el.setAttribute('aria-label',I18N.t('深海基地'));
  el.innerHTML=`<div class="sea-bg" aria-hidden="true"></div><div class="sea-tags" id="seaTags" aria-hidden="true"></div>
    <header class="sea-hud">
      <div class="sea-ttl"><button type="button" class="sea-x" id="seaX" aria-label="關閉深海基地" title="關閉（Esc）">${ic('back')}</button>
        <span class="sea-logo" aria-hidden="true">${octSvg('working','#3EE6E0',false)}</span><h2><span>深海</span><b>基地</b></h2></div>
      <div class="sea-cnt" id="seaCnt" role="status"></div>
      <div class="sea-depth" id="seaDepth" aria-hidden="true"></div>
    </header>
    <button type="button" class="sea-all" id="seaAll" hidden>${ic('back')}<span>回到全景</span></button>
    <p class="sea-hint" id="seaHint"><span>拖曳轉動</span> · <span>滾輪或雙指縮放</span> · <span>點艙室進入</span></p>
    <nav class="sea-cards" id="seaCards" aria-label="艙室"></nav>
    <div class="sea-tip" id="seaTip" hidden></div>
    <div class="sea-qc" id="seaQc" hidden></div>
    <div class="sea-msg" id="seaMsg" hidden></div>`;
  document.body.appendChild(el);SEA.el=el;SEA.ac=new AbortController();SEA.focus=null;SEA.sig='';SEA.ssig='';
  el.classList.toggle('still',seaStill());
  const sig={signal:SEA.ac.signal};
  $('seaX').addEventListener('click',()=>closeSea(),sig);
  $('seaAll').addEventListener('click',()=>seaFocus(null),sig);
  $('seaCards').addEventListener('click',seaCardClick,sig);
  $('seaQc').addEventListener('click',seaQcClick,sig);
  document.addEventListener('keydown',seaKey,sig);
  document.addEventListener('visibilitychange',()=>{if(SEA.g){if(document.hidden)SEA.g.loop.stop();else{SEA.g.loop.start()}}},sig);
  addEventListener('resize',()=>seaResize(),sig);
  matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change',()=>seaPrefs(),sig);
  navPush('sea');if(typeof dockSync==='function')dockSync();
  seaRefresh(true);seaLoadDone();
  SEA.iv=setInterval(()=>{if(!SEA.el)return;seaRefresh();if(S.rev!==SEA.doneRev&&Date.now()-SEA.doneT>5000)seaLoadDone()},1000);
  paintIcons(el);$('seaX').focus({preventScroll:true});
  if(!seaHasGL()){seaFallback();return}
  seaLib().then(T=>{if(SEA.el===el)seaInit(T)}).catch(()=>{if(SEA.el===el)seaFallback()})}
function closeSea(fromHistory){const el=SEA.el;if(!el)return;
  clearInterval(SEA.iv);SEA.iv=0;SEA.ac?.abort();SEA.ac=null;
  if(SEA.g){seaFree(SEA.g);SEA.g=null}
  el.remove();SEA.el=null;SEA.m=null;SEA.L=null;SEA.qc=null;SEA.hover=null;
  if(!fromHistory)navPop('sea');if(typeof dockSync==='function')dockSync();$('seaBtn')?.focus({preventScroll:true})}
function seaKey(e){if(e.key!=='Escape'||!$('veil').hidden)return;e.preventDefault();
  if(!$('seaQc').hidden){seaQc(null);return}if(SEA.focus){seaFocus(null);return}closeSea()}
function seaFallback(){const m=$('seaMsg');if(!m)return;m.hidden=false;
  m.innerHTML=`<b>這台裝置沒辦法顯示 3D 畫面</b><span>下面的艙室卡片一樣可以看每個機器人在做什麼。</span>`;SEA.el.classList.add('flat')}
async function seaLoadDone(){SEA.doneT=Date.now();SEA.doneRev=S.rev;
  try{const d=await api('overview');SEA.done=Object.fromEntries((d.bots||[]).map(x=>[x.id,+x.doneN||0]));SEA.sig='';seaRefresh()}catch(e){}}
// 省電模式 or reduced motion changed while open
function seaPrefs(){if(!SEA.el)return;SEA.el.classList.toggle('still',seaStill());if(SEA.g){SEA.g.r.setPixelRatio(seaPR());seaResize();SEA.g.loop.kick(2)}}
const seaPR=()=>Math.min(devicePixelRatio||1,seaLow()?1:1.5);

/* ---------- the HUD and the module cards (also the keyboard way in) ---------- */
function seaRefresh(force){if(!SEA.el)return;
  const m=seaModel(seaInput()),sig=JSON.stringify(m);if(!force&&sig===SEA.sig)return;SEA.sig=sig;
  SEA.m=m;SEA.L=seaLayout(m);
  const c=m.counters;
  setHTML($('seaCnt'),`<span class="sea-c run"><b data-u>${c.working}</b> <span>工作中</span></span><span class="sea-c need${c.need?' on':''}"><b data-u>${c.need}</b> <span>需要你</span></span><span class="sea-c ok"><b data-u>${c.done}</b> <span>今天完成</span></span>${c.fail?`<span class="sea-c bad"><b data-u>${c.fail}</b> <span>沒做成</span></span>`:''}`);
  seaDepth();seaCards();if(SEA.g)seaSync();if(SEA.qc)seaQc(SEA.qc,true)}
function seaDepth(){const m=SEA.m;if(!m)return;const p=m.pods.find(x=>x.id===SEA.focus)||m.pods[0];
  setHTML($('seaDepth'),`<small>深度</small><b data-u>${p.depth}</b><small data-u>m</small><i class="sea-gauge"><i style="height:${Math.min(100,Math.round((p.depth-100)/Math.max(1,(m.pods.length)*20+20)*100))}%"></i></i>`)}
const SEA_OCT=2.2;   // an octopus is this tall (metres)
function seaChip(b){const tone=b.need?'need':b.fail?'bad':b.paused?'pause':b.job?'run':'idle';
  return `<button type="button" class="sea-bot ${tone}" data-sbot="${esc(b.id)}" aria-label="${esc(b.name+' · '+I18N.t(b.word))}"><i style="--c:${esc(colorHex(b.color)||OC_DEFAULT)}"></i><span class="nm" data-u>${esc(b.name)}</span><small>${esc(b.word)}</small></button>`}
function seaCards(){const m=SEA.m;if(!m)return;
  const h=m.pods.map(p=>{const bs=p.bots.map(id=>m.bots.find(b=>b.id===id)),run=bs.filter(b=>b.job&&!b.paused).length,need=bs.filter(b=>b.need).length+m.rooms.filter(r=>r.pod===p.id&&r.need).length;
    const rooms=m.rooms.filter(r=>r.pod===p.id);
    return `<section class="sea-card${SEA.focus===p.id?' on':''}" style="--pc:${p.color}" data-spod="${esc(p.id)}">
      <button type="button" class="sea-ch" data-sgo="${esc(p.id)}" aria-pressed="${SEA.focus===p.id}"><i class="sea-pd"></i><b data-u>${esc(seaPodName(p))}</b><small><span data-u>${p.depth}m</span> · <span data-u>${run}</span> <span>工作中</span>${need?` · <span class="nd"><span data-u>${need}</span> <span>需要你</span></span>`:''}</small></button>
      <div class="sea-bots">${bs.map(seaChip).join('')||'<small class="sea-none">還沒有機器人</small>'}</div>
      ${rooms.length?`<div class="sea-rooms">${rooms.map(r=>`<button type="button" class="sea-room${r.need?' need':''}" data-sroom="${esc(r.id)}">${ic('users')}<span>會議室</span> <span data-u>${esc(r.name)}</span></button>`).join('')}</div>`:''}
    </section>`}).join('');
  const box=$('seaCards'),k=box.dataset.k;if(k===h)return;box.dataset.k=h;
  const sl=box.scrollLeft;setHTML(box,h);paintIcons(box);box.scrollLeft=sl;if(SEA.g)seaResize()}
function seaCardClick(e){const g=e.target.closest('[data-sgo]');if(g){seaFocus(SEA.focus===g.dataset.sgo?null:g.dataset.sgo);return}
  const b=e.target.closest('[data-sbot]');if(b){seaQc({bot:b.dataset.sbot,from:b});return}
  const r=e.target.closest('[data-sroom]');if(r)seaQc({room:r.dataset.sroom,from:r})}

/* ---------- the quick card: 打開對話 · 工作 · 它記得什麼 · 暫停 ---------- */
function seaQc(o,refresh){const box=$('seaQc');if(!box)return;
  if(!o){box.hidden=true;SEA.qc=null;if(SEA.g)SEA.g.loop.kick();return}
  const m=SEA.m;SEA.qc=o;let h='';
  if(o.bot){const b=m.bots.find(x=>x.id===o.bot);if(!b){seaQc(null);return}
    const x=S.busy.find(j=>j.job===b.job),pz=x?pauseOf(x):'';
    const bub=b.bubble?`<p class="sea-qb ${b.bubble.tone}">${b.bubble.lab?`<b>${esc(b.bubble.lab)}</b> `:''}<span data-u>${esc(b.bubble.txt)}</span></p>`:'';
    h=`<div class="sea-qh"><span class="av" data-u>${avOf(b.id,true)}</span><div><b data-u>${esc(b.name)}</b><small><span>${esc(b.word)}</span>${b.queued?` · <span data-u>${b.queued}</span> <span>件排隊中</span>`:''}</small></div><button type="button" class="ib sm" data-qx aria-label="關閉">${ic('x')}</button></div>${bub}
      <div class="sea-qa"><button type="button" class="btn sm" data-qo>${ic('reply')}<span>打開對話</span></button><button type="button" class="ghost sm" data-qw>${ic('panel')}<span>工作</span></button><button type="button" class="ghost sm" data-qm>${ic('brain')}<span>它記得什麼</span></button>${b.job?`<button type="button" class="ghost sm" data-qp="${b.job}" data-on="${pz==='paused'||pz==='pausing'?0:1}">${ic(pz==='paused'||pz==='pausing'?'play':'pause')}<span>${pz==='paused'||pz==='pausing'?'繼續':'暫停'}</span></button>`:''}</div>`}
  else if(o.room){const r=m.rooms.find(x=>x.id===o.room);if(!r){seaQc(null);return}
    h=`<div class="sea-qh"><span class="av grp" data-u>${gStack(conv(r.id)||{members:r.members},true)}</span><div><b data-u>${esc(r.name)}</b><small><span>會議室</span> · <span data-u>${r.members.length}</span> <span>位成員</span></small></div><button type="button" class="ib sm" data-qx aria-label="關閉">${ic('x')}</button></div>
      ${r.need?`<p class="sea-qb need"><b>${esc(r.need==='ap'?'待你核准':'需要你')}</b></p>`:''}<div class="sea-qa"><button type="button" class="btn sm" data-qo>${ic('reply')}<span>打開群組對話</span></button></div>`}
  if(refresh&&box.dataset.k===h)return;box.dataset.k=h;
  setHTML(box,h);paintIcons(box);box.hidden=false;seaQcPlace();
  if(!refresh)box.querySelector('[data-qo]')?.focus({preventScroll:true})}
function seaQcPlace(){const box=$('seaQc'),o=SEA.qc;if(!box||box.hidden||!o)return;
  if(phoneUI()||!SEA.g||!o.bot){box.classList.add('dock');return}
  const p=seaScreen(o.bot);if(!p){box.classList.add('dock');return}
  box.classList.remove('dock');const w=box.offsetWidth,h=box.offsetHeight,W=SEA.el.clientWidth,H=SEA.el.clientHeight;
  const x=Math.max(12,Math.min(W-w-12,p.x+28)),y=Math.max(70,Math.min(H-h-150,p.y-h/2));box.style.transform=`translate(${x}px,${y}px)`}
function seaQcClick(e){const o=SEA.qc;if(!o)return;const id=o.bot||o.room;
  if(e.target.closest('[data-qx]')){seaQc(null);return}
  if(e.target.closest('[data-qo]')){closeSea();openConv(id);return}
  if(e.target.closest('[data-qw]')){closeSea();openConv(id);setTimeout(()=>openPanel('work',{user:true}),0);return}
  if(e.target.closest('[data-qm]')){openMemory(id);return}
  const p=e.target.closest('[data-qp]');if(p){jobPause(+p.dataset.qp,p.dataset.on==='1',p).then(()=>seaQc(SEA.qc,true))}}

/* ---------- the 3D scene ---------- */
const SEA_GLSL_FOG_V='\n#include <fog_pars_vertex>\n',SEA_GLSL_FOG_F='\n#include <fog_pars_fragment>\n';
function seaMat(T,U,o){const u=T.UniformsUtils.merge([T.UniformsLib.fog,o.uniforms||{}]);u.uTime=U.uTime;
  return new T.ShaderMaterial({uniforms:u,vertexShader:o.v,fragmentShader:o.f,transparent:o.transparent!==false,depthWrite:!!o.depthWrite,fog:true,side:o.side??T.FrontSide,blending:o.add?T.AdditiveBlending:T.NormalBlending})}
// a soft round glow (white), tinted per sprite
function seaGlowTex(T,inner){const c=document.createElement('canvas');c.width=c.height=64;const x=c.getContext('2d'),g=x.createRadialGradient(32,32,0,32,32,32);
  g.addColorStop(0,'rgba(255,255,255,1)');g.addColorStop(inner||.25,'rgba(255,255,255,.55)');g.addColorStop(1,'rgba(255,255,255,0)');x.fillStyle=g;x.fillRect(0,0,64,64);
  const t=new T.CanvasTexture(c);t.colorSpace=T.SRGBColorSpace;return t}
// the octopus avatar as a picture for a sprite: the still pose of the state, in the bot's colour, with a soft glow
const SEA_OCT_CSS=c=>{const s=accentOf(c);return `.oa *{transform-box:view-box}.oa-legs{fill:none;stroke:${c};stroke-width:34;stroke-linecap:round}.oa-body{fill:${c}}.oa-eye{fill:#1c140a;transform-box:fill-box;transform-origin:center}.oa-shut{fill:none;stroke:#1c140a;stroke-width:11;stroke-linecap:round}.oa-star{fill:${s}}.oa-zs{fill:${c};font-family:system-ui,sans-serif;font-weight:800}.oa-dk{fill:#2e241a;stroke:${c};stroke-width:5}.oa-dm,.oa-m1,.oa-m3,.oa-ln{fill:${c}}.oa-ln{opacity:.6}.oa-scr{fill:#FFF6E0}.oa-m2{fill:#2e241a}.oa-tap{fill:none;stroke:${c};stroke-width:22;stroke-linecap:round}.oa-leg{transform-origin:var(--o)}.oa-o{transform-origin:256px 215px}.oa-z1{opacity:.95;transform:translate(10px,-22px)}.oa-z2{opacity:.65;transform:translate(28px,-56px)}.oa-z3{opacity:.35;transform:translate(42px,-82px)}.s-thinking .oa-eyes{transform:translate(10px,-14px)}.oa-o1{transform:rotate(-137deg)}.oa-o2{transform:rotate(223deg)}.oa-o3{transform:rotate(-240deg)}.oa-o4{transform:rotate(260deg)}.oa-dev-b{opacity:0}.oa-dev-f{transform:translate(var(--fx),var(--fy)) var(--r1)}.s-browsing .oa-eyes{transform:translateY(-6px)}.s-chatting .oa-eyes{transform:translate(12px,8px)}`};
function seaOctTex(G,state,color){const c=colorHex(color)||OC_DEFAULT,k=state+c;if(G.tex[k])return G.tex[k];const T=G.T;
  const cv=document.createElement('canvas');cv.width=cv.height=256;const t=new T.CanvasTexture(cv);t.colorSpace=T.SRGBColorSpace;t.anisotropy=2;G.tex[k]=t;
  const s=OA_DRAW[state]?state:'idle',svg=`<svg xmlns="http://www.w3.org/2000/svg" class="oa s-${s}" viewBox="-6 -40 524 524" width="512" height="512"><style>${SEA_OCT_CSS(c)}</style>${OA_CACHE[s]||(OA_CACHE[s]=OA_DRAW[s]())}</svg>`;
  const img=new Image();img.onload=()=>{if(!G.alive)return;const x=cv.getContext('2d');x.clearRect(0,0,256,256);x.shadowColor=c+'aa';x.shadowBlur=18;x.drawImage(img,14,14,228,228);x.shadowBlur=0;x.drawImage(img,14,14,228,228);t.needsUpdate=true;G.loop.kick()};
  img.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg);return t}
const SEA_V_GLASS=`varying vec3 vN;varying vec3 vV;varying vec3 vW;${SEA_GLSL_FOG_V}
void main(){vec4 wp=modelMatrix*vec4(position,1.);vW=wp.xyz;vec4 mvPosition=viewMatrix*wp;vN=normalize(normalMatrix*normal);vV=normalize(-mvPosition.xyz);gl_Position=projectionMatrix*mvPosition;
#include <fog_vertex>
}`;
const SEA_F_GLASS=`uniform vec3 uRim;uniform float uTime;uniform float uBase;uniform float uLines;varying vec3 vN;varying vec3 vV;varying vec3 vW;${SEA_GLSL_FOG_F}
void main(){vec3 n=normalize(vN);float f=pow(1.-abs(dot(n,normalize(vV))),2.4);
float ln=uLines*(1.-smoothstep(0.,.05,abs(fract(vW.y*1.25-uTime*.04)-.5)-.44));
float sp=pow(max(dot(reflect(-normalize(vV),n),normalize(vec3(-.35,.8,.45))),0.),40.);
vec3 c=uRim*(f*1.5+ln*.6)+vec3(.85,.97,1.)*sp*.8;float a=uBase+f*.7+ln*.09+sp*.5;gl_FragColor=vec4(c,clamp(a,0.,1.));
#include <fog_fragment>
}`;
function seaGlass(T,U,rim,base,lines){return seaMat(T,U,{uniforms:{uRim:{value:new T.Color(rim)},uBase:{value:base??.05},uLines:{value:lines??1}},v:SEA_V_GLASS,f:SEA_F_GLASS})}

function seaInit(T){const el=SEA.el;
  const cv=document.createElement('canvas');cv.className='sea-cv';cv.setAttribute('aria-hidden','true');el.insertBefore(cv,el.firstChild.nextSibling);
  let r;try{r=new T.WebGLRenderer({canvas:cv,antialias:true,powerPreference:'default',stencil:false})}catch(e){cv.remove();seaFallback();return}
  r.setPixelRatio(seaPR());r.toneMapping=T.ACESFilmicToneMapping;r.toneMappingExposure=1.05;
  const scene=new T.Scene();scene.background=new T.Color(0x021019);scene.fog=new T.FogExp2(0x042132,.0135);
  const cam=new T.PerspectiveCamera(40,1,.1,500);
  const U={uTime:{value:0}};
  const G={T,r,scene,cam,U,cv,tex:{},alive:true,bots:{},labels:{},base:null,env:null,t:0,
    view:{th:.55,ph:.98,d:60,tx:0,tz:0},goal:{th:.55,ph:.98,d:60,tx:0,tz:0},ptr:new Map(),moved:0,ray:new T.Raycaster(),
    glow:seaGlowTex(T),pick:[]};
  G.loop=seaLoop({raf:f=>requestAnimationFrame(f),caf:id=>cancelAnimationFrame(id),now:()=>performance.now(),frame:(dt)=>seaFrame(G,dt),
    hidden:()=>document.hidden||!SEA.el,animate:()=>!seaStill()||seaMoving(G)});
  SEA.g=G;
  scene.add(new T.HemisphereLight(0x7fdcf0,0x081820,1.15));
  const sun=new T.DirectionalLight(0xc6f4ff,1.7);sun.position.set(12,40,6);scene.add(sun);
  const fill=new T.DirectionalLight(0x6a7dff,.35);fill.position.set(-20,8,-14);scene.add(fill);
  scene.add(new T.AmbientLight(0x1d5a6e,.45));
  G.env=seaEnv(G);scene.add(G.env);
  seaSync();seaResize();seaFocus(null,true);
  seaControls(G);
  el.classList.add('ready');G.loop.start()}
function seaFree(G){G.alive=false;G.loop.stop();
  for(const id in G.labels)G.labels[id].el.remove();
  const n=seaDispose(G.scene,[...Object.values(G.tex),G.glow,...(G.extra||[])]);
  G.r.renderLists?.dispose();G.r.dispose();try{G.r.forceContextLoss()}catch(e){}G.cv.remove();G.scene.clear();G.tex={};G.bots={};G.labels={};
  SEA.freed=n}
function seaResize(){const G=SEA.g;if(!G||!SEA.el)return;const w=SEA.el.clientWidth,h=SEA.el.clientHeight;if(!w||!h)return;
  G.r.setSize(w,h,false);G.cam.aspect=w/h;
  // the HUD on top and the cards below: the picture's centre moves to the middle of what is left
  const top=$('seaCnt')?.getBoundingClientRect().bottom||100,bot=$('seaCards')?.offsetHeight||0,off=Math.round((bot-top)/2);
  G.cam.setViewOffset(w,h,0,off,w,h);G.cam.updateProjectionMatrix();G.top=top;G.bot=h-bot;$('seaHint').style.bottom=(bot+8)+'px';if(!SEA.focus)seaFocus(null,true);G.loop.kick(2)}

/* the sea itself: floor with moving caustics, rocks, kelp, glowing coral, light shafts from above, drifting snow, bubbles, fish */
function seaEnv(G){const T=G.T,U=G.U,grp=new T.Group();G.extra=[];
  // a dome of water: brighter where the light comes from
  const sky=new T.Mesh(new T.SphereGeometry(240,32,16),new T.ShaderMaterial({side:T.BackSide,depthWrite:false,fog:false,uniforms:{},
    vertexShader:'varying vec3 vP;void main(){vP=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
    fragmentShader:'varying vec3 vP;void main(){float h=normalize(vP).y;vec3 c=mix(vec3(.008,.05,.08),vec3(.03,.24,.32),smoothstep(-.1,.9,h));c+=vec3(.05,.22,.25)*pow(max(h,0.),6.);gl_FragColor=vec4(c,1.);}'}));
  sky.renderOrder=-1;grp.add(sky);
  // the floor: flat where the base stands, dunes and ridges further out
  const fg=new T.PlaneGeometry(320,320,96,96);fg.rotateX(-Math.PI/2);const pos=fg.attributes.position;
  const span=(SEA.L?.span||26)+6;
  for(let i=0;i<pos.count;i++){const x=pos.getX(i),z=pos.getZ(i),d=Math.hypot(x,z),k=Math.max(0,Math.min(1,(d-span)/40));
    const n=Math.sin(x*.11)*Math.cos(z*.13)*1.6+Math.sin(x*.031+z*.04)*3.2+Math.sin(z*.27+x*.05)*.5;pos.setY(i,-.02+k*k*(n+4+k*6)+(1-k)*Math.sin(x*.4)*Math.cos(z*.37)*.06)}
  fg.computeVertexNormals();
  const fm=new T.MeshStandardMaterial({color:0x1d4448,roughness:.95,metalness:0,flatShading:true});
  fm.onBeforeCompile=sh=>{sh.uniforms.uTime=U.uTime;
    sh.vertexShader=sh.vertexShader.replace('#include <common>','#include <common>\nvarying vec3 vWp;').replace('#include <begin_vertex>','#include <begin_vertex>\nvWp=(modelMatrix*vec4(position,1.)).xyz;');
    sh.fragmentShader=sh.fragmentShader.replace('#include <common>',`#include <common>
uniform float uTime;varying vec3 vWp;
float seaCaus(vec2 p,float t){vec2 q=p+vec2(sin(p.y*1.3+t),cos(p.x*1.1-t*.8))*.6;float v=sin(q.x*2.1+t)*sin(q.y*2.3-t*.7);
vec2 r=p*1.7+vec2(cos(p.y*.9-t*.6),sin(p.x*1.4+t*.5))*.8;v+=sin(r.x*1.9-t*.4)*sin(r.y*2.-t*.9)*.8;return pow(max(0.,1.-abs(v)*1.4),4.);}`)
      .replace('#include <emissivemap_fragment>','#include <emissivemap_fragment>\nfloat cz=seaCaus(vWp.xz*.55,uTime*.5)*.7+seaCaus(vWp.xz*.31+3.1,uTime*.38)*.45;totalEmissiveRadiance+=vec3(.3,.78,.82)*cz*.075*(1.-smoothstep(14.,46.,length(vWp.xz)));')};
  const floor=new T.Mesh(fg,fm);grp.add(floor);
  // a soft lit disc under the base, like work lights on the sand
  const pad=new T.Mesh(new T.CircleGeometry(span+4,64).rotateX(-Math.PI/2),new T.MeshBasicMaterial({map:G.glow,color:0x1f8a96,transparent:true,opacity:.28,depthWrite:false,blending:T.AdditiveBlending}));pad.position.y=.03;grp.add(pad);
  const rnd=seaRand(7);
  // rocks
  const rockG=new T.DodecahedronGeometry(1,0),rockM=new T.MeshStandardMaterial({color:0x24525a,roughness:1,flatShading:true});
  const rocks=new T.InstancedMesh(rockG,rockM,46),M=new T.Matrix4(),Q=new T.Quaternion(),E=new T.Euler(),V=new T.Vector3(),Sc=new T.Vector3();
  for(let i=0;i<46;i++){const a=rnd()*Math.PI*2,d=span+3+rnd()*42,s=.5+rnd()*rnd()*3.2;E.set(rnd()*3,rnd()*3,rnd()*3);Q.setFromEuler(E);
    V.set(Math.cos(a)*d,s*.3,Math.sin(a)*d);Sc.set(s*(1+rnd()*.6),s*(.5+rnd()*.5),s);M.compose(V,Q,Sc);rocks.setMatrixAt(i,M)}
  grp.add(rocks);
  // coral: bioluminescent fans and knobs
  const corG=new T.ConeGeometry(.35,1.4,5,1),corM=new T.MeshBasicMaterial({color:0xffffff}),cn=70,coral=new T.InstancedMesh(corG,corM,cn),C=new T.Color();
  const CC=[0xff6fae,0xb07cff,0x4ff0e0,0xffa860,0x7dffb2];
  for(let i=0;i<cn;i++){const cl=Math.floor(i/7),a=(cl*.97+rnd()*.12)*Math.PI*2/1.0,d=span+2+((cl*13)%9)*2.1+rnd()*2,s=.4+rnd()*.9;
    E.set((rnd()-.5)*.9,rnd()*6,(rnd()-.5)*.9);Q.setFromEuler(E);V.set(Math.cos(a)*d+(rnd()-.5)*2.4,s*.55,Math.sin(a)*d+(rnd()-.5)*2.4);Sc.set(s,s*(1+rnd()),s);M.compose(V,Q,Sc);coral.setMatrixAt(i,M);
    C.setHex(CC[cl%CC.length]).multiplyScalar(.55+rnd()*.5);coral.setColorAt(i,C)}
  grp.add(coral);
  // glowing anemones among the coral
  for(let i=0;i<16;i++){const a=rnd()*Math.PI*2,d=span+2+rnd()*16,sp=new T.Sprite(new T.SpriteMaterial({map:G.glow,color:CC[i%CC.length],transparent:true,opacity:.65,depthWrite:false,blending:T.AdditiveBlending}));
    sp.position.set(Math.cos(a)*d,.5+rnd()*.5,Math.sin(a)*d);const s=1+rnd()*1.6;sp.scale.set(s,s,1);sp.userData.pulse=rnd()*6;grp.add(sp);(G.pulses||(G.pulses=[])).push(sp)}
  // kelp: one mesh, every strand sways in the shader
  const kp=[],kh=[],ks=[],ki=[];let vi=0;
  for(let c=0;c<11;c++){const ca=c/11*Math.PI*2+rnd()*.4,cd=span+5+rnd()*20,cx=Math.cos(ca)*cd,cz=Math.sin(ca)*cd,n=4+Math.floor(rnd()*5);
    for(let s=0;s<n;s++){const x0=cx+(rnd()-.5)*4,z0=cz+(rnd()-.5)*4,h=5+rnd()*9,w=.35+rnd()*.3,yaw=rnd()*Math.PI,seg=10,sd=rnd();
      for(let j=0;j<=seg;j++){const f=j/seg,ww=w*(1-f*.65),dx=Math.cos(yaw)*ww,dz=Math.sin(yaw)*ww;
        kp.push(x0-dx,f*h,z0-dz,x0+dx,f*h,z0+dz);kh.push(f,f);ks.push(sd,sd);
        if(j<seg)ki.push(vi,vi+1,vi+2,vi+1,vi+3,vi+2);vi+=2}}}
  const kg=new T.BufferGeometry();kg.setAttribute('position',new T.Float32BufferAttribute(kp,3));kg.setAttribute('aH',new T.Float32BufferAttribute(kh,1));kg.setAttribute('aS',new T.Float32BufferAttribute(ks,1));kg.setIndex(ki);
  const kelp=new T.Mesh(kg,seaMat(T,U,{transparent:false,depthWrite:true,side:T.DoubleSide,
    v:`attribute float aH;attribute float aS;uniform float uTime;varying float vH;${SEA_GLSL_FOG_V}
void main(){vec3 p=position;float k=aH*aH;p.x+=sin(uTime*.7+aS*6.28+aH*2.2)*k*1.1;p.z+=cos(uTime*.55+aS*4.+aH*1.7)*k*.8;vH=aH;vec4 mvPosition=modelViewMatrix*vec4(p,1.);gl_Position=projectionMatrix*mvPosition;
#include <fog_vertex>
}`,
    f:`varying float vH;${SEA_GLSL_FOG_F}
void main(){vec3 c=mix(vec3(.02,.09,.07),vec3(.08,.42,.3),vH);c+=vec3(.2,.9,.7)*smoothstep(.86,1.,vH)*.5;gl_FragColor=vec4(c,1.);
#include <fog_fragment>
}`}));
  grp.add(kelp);
  // light shafts from the surface (turned to face the camera every frame)
  const rayM=seaMat(T,U,{add:true,side:T.DoubleSide,uniforms:{uSeed:{value:0}},
    v:`varying vec2 vU;void main(){vU=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
    f:`uniform float uTime;uniform float uSeed;varying vec2 vU;void main(){float e=smoothstep(0.,.45,vU.x)*smoothstep(1.,.55,vU.x);float h=smoothstep(0.,.75,vU.y)*smoothstep(1.,.88,vU.y);
float fl=.55+.45*sin(uTime*.5+uSeed*7.+vU.y*3.);gl_FragColor=vec4(vec3(.45,.9,1.)*e*e*h*fl*.12,1.);}`});
  rayM.fog=false;G.rays=[];
  for(let i=0;i<7;i++){const m=rayM.clone();m.uniforms.uTime=U.uTime;m.uniforms.uSeed={value:rnd()*10};const w=5+rnd()*7,h=50;
    const ray=new T.Mesh(new T.PlaneGeometry(w,h),m);const a=rnd()*Math.PI*2,d=4+rnd()*(span+6);ray.position.set(Math.cos(a)*d,h/2-2,Math.sin(a)*d);ray.userData.tilt=(rnd()-.5)*.35;grp.add(ray);G.rays.push(ray)}
  G.extra.push(rayM);
  // drifting snow and rising bubbles: the shader moves them, the CPU does nothing
  const pts=(n,box,f)=>{const g=new T.BufferGeometry(),p=new Float32Array(n*3),s=new Float32Array(n);for(let i=0;i<n;i++){const [x,y,z]=f(i);p[i*3]=x;p[i*3+1]=y;p[i*3+2]=z;s[i]=rnd()}
    g.setAttribute('position',new T.BufferAttribute(p,3));g.setAttribute('aS',new T.BufferAttribute(s,1));return g};
  const snowM=seaMat(T,U,{uniforms:{uPR:{value:G.r.getPixelRatio()}},
    v:`attribute float aS;uniform float uTime;uniform float uPR;varying float vA;${SEA_GLSL_FOG_V}
void main(){vec3 p=position;p.y=mod(p.y-uTime*(.12+aS*.22),26.)-1.;p.x+=sin(uTime*.25+aS*30.)*.8;p.z+=cos(uTime*.2+aS*17.)*.8;vec4 mvPosition=modelViewMatrix*vec4(p,1.);
gl_PointSize=(1.2+aS*2.6)*uPR*(60./max(1.,-mvPosition.z));vA=(.25+.55*aS)*smoothstep(-1.,2.,p.y);gl_Position=projectionMatrix*mvPosition;
#include <fog_vertex>
}`,
    f:`varying float vA;${SEA_GLSL_FOG_F}
void main(){float d=length(gl_PointCoord-.5);float a=smoothstep(.5,.0,d)*vA;gl_FragColor=vec4(.78,.96,1.,a);
#include <fog_fragment>
}`});
  const snow=new T.Points(pts(600,0,()=>[(rnd()-.5)*110,rnd()*26,(rnd()-.5)*110]),snowM);grp.add(snow);G.snowM=snowM;
  const bubM=seaMat(T,U,{uniforms:{uPR:{value:G.r.getPixelRatio()}},
    v:`attribute float aS;uniform float uTime;uniform float uPR;varying float vA;${SEA_GLSL_FOG_V}
void main(){vec3 p=position;float y=mod(uTime*(.9+aS*.9)+aS*30.,22.);p.y+=y;p.x+=sin(y*1.7+aS*9.)*.25;p.z+=cos(y*1.3+aS*5.)*.25;vec4 mvPosition=modelViewMatrix*vec4(p,1.);
gl_PointSize=(2.+aS*4.)*uPR*(60./max(1.,-mvPosition.z));vA=smoothstep(22.,14.,y)*.8;gl_Position=projectionMatrix*mvPosition;
#include <fog_vertex>
}`,
    f:`varying float vA;${SEA_GLSL_FOG_F}
void main(){vec2 q=gl_PointCoord-.5;float d=length(q);float ring=smoothstep(.5,.42,d)*smoothstep(.24,.4,d);float hi=smoothstep(.16,.0,length(q-vec2(-.14,-.14)));
gl_FragColor=vec4(vec3(.75,.97,1.),(ring*.75+hi*.9)*vA);
#include <fog_fragment>
}`});
  const vents=[];for(let i=0;i<9;i++){const a=rnd()*Math.PI*2,d=span+2+rnd()*12;vents.push([Math.cos(a)*d,Math.sin(a)*d])}
  const bub=new T.Points(pts(180,0,i=>{const v=vents[i%vents.length];return [v[0]+(rnd()-.5)*.8,0,v[1]+(rnd()-.5)*.8]}),bubM);grp.add(bub);G.bubM=bubM;
  // a school of little fish circling far out
  const fishG=new T.ConeGeometry(.16,.7,4,1).rotateZ(-Math.PI/2),fish=new T.InstancedMesh(fishG,new T.MeshBasicMaterial({color:0x7fd8e8}),36);
  fish.userData.seed=[...Array(36)].map(()=>[rnd(),rnd(),rnd()]);fish.frustumCulled=false;grp.add(fish);G.fish=fish;
  return grp}
function seaRand(s){return ()=>{s=(s*16807)%2147483647;return (s-1)/2147483646}}

/* the base: domes, tubes, desks, octopuses. Rebuilt when modules or bots come and go; states update in place */
function seaSync(){const G=SEA.g,m=SEA.m,L=SEA.L;if(!G||!m)return;
  const ssig=JSON.stringify([m.pods.map(p=>[p.id,p.name,p.bots]),m.rooms.map(r=>[r.id,r.pod,r.name])]);
  if(ssig!==SEA.ssig){SEA.ssig=ssig;seaBuild(G,m,L)}
  for(const b of m.bots)seaBotState(G,b,m,L);
  G.loop.kick(2)}
function seaBuild(G,m,L){const T=G.T,U=G.U;
  if(G.base){G.scene.remove(G.base);seaDispose(G.base)}
  for(const id in G.labels)G.labels[id].el.remove();G.labels={};const keep=G.bots;G.bots={};G.pick=[];
  const base=new T.Group();G.base=base;G.scene.add(base);
  const metal=new T.MeshStandardMaterial({color:0x2a5568,roughness:.45,metalness:.6}),dark=new T.MeshStandardMaterial({color:0x0f2632,roughness:.6,metalness:.5});
  const floorM=new T.MeshStandardMaterial({color:0x1d4656,roughness:.6,metalness:.25});
  const dome=(x,z,r,col,id,kind)=>{const g=new T.Group();g.position.set(x,0,z);
    const plat=new T.Mesh(new T.CylinderGeometry(r+.35,r+.75,.5,48),metal);plat.position.y=.25;g.add(plat);
    const fl=new T.Mesh(new T.CircleGeometry(r+.2,48).rotateX(-Math.PI/2),floorM);fl.position.y=.505;g.add(fl);
    const ringM=new T.MeshBasicMaterial({color:col,toneMapped:false});
    const ring=new T.Mesh(new T.TorusGeometry(r+.42,.055,6,96).rotateX(Math.PI/2),ringM);ring.position.y=.52;g.add(ring);
    const inner=new T.Mesh(new T.RingGeometry(r*.32,r*.32+.05,64).rotateX(-Math.PI/2),new T.MeshBasicMaterial({color:col,transparent:true,opacity:.35,toneMapped:false}));inner.position.y=.51;g.add(inner);
    const gl=new T.Mesh(new T.SphereGeometry(r+.36,48,20,0,Math.PI*2,0,Math.PI/2),seaGlass(T,U,col,.035,1));gl.position.y=.5;gl.renderOrder=2;gl.userData[kind]=id;g.add(gl);G.pick.push(gl);
    const ribM=new T.MeshStandardMaterial({color:0x2a5566,roughness:.4,metalness:.7,emissive:new T.Color(col),emissiveIntensity:.08});
    for(let i=0;i<3;i++){const rib=new T.Mesh(new T.TorusGeometry(r+.37,.045,5,40,Math.PI),ribM);rib.rotation.y=i*Math.PI/3;rib.position.y=.5;g.add(rib)}
    const cap=new T.Mesh(new T.CylinderGeometry(.35,.5,.35,12),dark);cap.position.y=.5+r+.45;g.add(cap);
    const bc=new T.Sprite(new T.SpriteMaterial({map:G.glow,color:col,transparent:true,depthWrite:false,blending:T.AdditiveBlending}));bc.position.y=.5+r+.85;bc.scale.set(1.4,1.4,1);bc.userData.pulse=x*.3;g.add(bc);(G.pulses2||(G.pulses2=[])).push(bc);
    for(let i=0;i<8;i++){const a=i/8*Math.PI*2,l=new T.Sprite(new T.SpriteMaterial({map:G.glow,color:col,transparent:true,opacity:.7,depthWrite:false,blending:T.AdditiveBlending}));l.position.set(Math.cos(a)*(r+.6),.32,Math.sin(a)*(r+.6));l.scale.set(.55,.55,1);g.add(l)}
    base.add(g);return g};
  G.pulses2=[];
  for(const p of m.pods){const c=L.pods[p.id];const g=dome(c.x,c.z,c.r,p.color,p.id,'pod');
    if(p.id==='hub'){// the hub's tower: through the dome, rings of light up to a beacon
      const tw=new T.Mesh(new T.CylinderGeometry(.42,.6,c.r+9,16),metal);tw.position.y=(c.r+9)/2+.5;g.add(tw);
      for(let i=0;i<4;i++){const rg=new T.Mesh(new T.TorusGeometry(.95-i*.08,.05,6,40).rotateX(Math.PI/2),new T.MeshBasicMaterial({color:p.color,toneMapped:false}));rg.position.y=c.r+2.4+i*1.7;rg.userData.spin=i;g.add(rg);(G.spin||(G.spin=[])).push(rg)}
      const top=new T.Sprite(new T.SpriteMaterial({map:G.glow,color:0x9ff7ff,transparent:true,depthWrite:false,blending:T.AdditiveBlending}));top.position.y=c.r+10;top.scale.set(3,3,1);g.add(top);G.pulses2.push(top);
      const holo=new T.Mesh(new T.CylinderGeometry(.9,1.25,.3,24),dark);holo.position.y=.65;g.add(holo)}
    seaLabel(G,'p:'+p.id,{x:c.x,y:0,z:c.z,r:c.r+.9},`<b data-u>${esc(seaPodName(p))}</b><small><span>深度</span> <span data-u>${p.depth}m</span></small>`,'sea-pl',p.color)}
  for(const r of m.rooms){const c=L.rooms[r.id],p=m.pods.find(x=>x.id===r.pod);const g=dome(c.x,c.z,c.r,p.color,r.id,'room');
    const tb=new T.Mesh(new T.CylinderGeometry(1,1,.08,32),new T.MeshStandardMaterial({color:0x24495a,roughness:.3,metalness:.6}));tb.position.y=1.15;g.add(tb);
    const leg=new T.Mesh(new T.CylinderGeometry(.18,.3,.6,10),dark);leg.position.y=.82;g.add(leg);
    const holo=new T.Mesh(new T.ConeGeometry(.75,1.3,24,1,true),new T.MeshBasicMaterial({color:p.color,transparent:true,opacity:.16,blending:T.AdditiveBlending,depthWrite:false,side:T.DoubleSide,toneMapped:false}));holo.rotation.x=Math.PI;holo.position.y=1.85;g.add(holo);G.holos=(G.holos||[]);G.holos.push(holo);
    seaLabel(G,'r:'+r.id,{x:c.x,y:0,z:c.z,r:c.r+.9},`<small><span>會議室</span></small><b data-u>${esc(r.name)}</b>`,'sea-pl room',p.color)}
  // tubes: the hub to each module, each module to its meeting rooms; light pulses run along them
  G.tubes=[];const glassT=seaGlass(T,U,0x6ff3ff,.03,0),collarM=new T.MeshStandardMaterial({color:0x2c5a6b,roughness:.4,metalness:.7,emissive:new T.Color(0x2fd8e6),emissiveIntensity:.25});
  const tube=(a,b,ra,rb,col,key)=>{const dx=b.x-a.x,dz=b.z-a.z,l=Math.hypot(dx,dz)||1,ux=dx/l,uz=dz/l;
    const p0=new T.Vector3(a.x+ux*(ra+.1),1.1,a.z+uz*(ra+.1)),p1=new T.Vector3(b.x-ux*(rb+.1),1.1,b.z-uz*(rb+.1)),mid=p0.clone().lerp(p1,.5);mid.y=1.7;
    const curve=new T.CatmullRomCurve3([p0,mid,p1]),tg=new T.TubeGeometry(curve,32,.62,14,false),mesh=new T.Mesh(tg,glassT);mesh.renderOrder=3;base.add(mesh);
    const walk=new T.Mesh(new T.TubeGeometry(curve,24,.16,6,false),dark);walk.position.y=-.52;base.add(walk);
    const len=curve.getLength(),nc=Math.max(2,Math.floor(len/2.4)),col2=new T.InstancedMesh(new T.TorusGeometry(.66,.06,6,24),collarM,nc),M=new T.Matrix4(),Q=new T.Quaternion(),Z=new T.Vector3(0,0,1),V1=new T.Vector3(1,1,1);
    for(let i=0;i<nc;i++){const t=(i+.5)/nc,p=curve.getPointAt(t),tan=curve.getTangentAt(t);Q.setFromUnitVectors(Z,tan);M.compose(p,Q,V1);col2.setMatrixAt(i,M)}base.add(col2);
    const pulses=[];for(let i=0;i<2;i++){const s=new T.Sprite(new T.SpriteMaterial({map:G.glow,color:col,transparent:true,depthWrite:false,blending:T.AdditiveBlending}));s.scale.set(.9,.9,1);base.add(s);pulses.push(s)}
    G.tubes.push({key,curve,len,pulses,hot:0})};
  for(const p of m.pods.slice(1)){const a=L.pods.hub,b=L.pods[p.id];tube(a,b,a.r+.4,b.r+.4,p.color,'hub>'+p.id)}
  for(const r of m.rooms){const a=L.pods[r.pod],b=L.rooms[r.id];tube(a,b,a.r+.4,b.r+.4,m.pods.find(x=>x.id===r.pod).color,r.pod+'>'+r.id)}
  // desks: one mesh each for tops, monitors, screens and stools (instanced)
  const ids=m.bots.map(b=>b.id),n=Math.max(1,ids.length);
  const top=new T.InstancedMesh(new T.BoxGeometry(1.35,.07,.66),new T.MeshStandardMaterial({color:0x5d8fa0,roughness:.35,metalness:.3}),n);
  const legs=new T.InstancedMesh(new T.BoxGeometry(1.15,.62,.06),dark,n);
  const mon=new T.InstancedMesh(new T.BoxGeometry(.86,.52,.05),new T.MeshStandardMaterial({color:0x10242e,roughness:.4,metalness:.4,emissive:new T.Color(0x1a5566),emissiveIntensity:.5}),n);
  const scr=new T.InstancedMesh(new T.PlaneGeometry(.78,.44),new T.MeshBasicMaterial({color:0xffffff,toneMapped:false}),n);
  const stool=new T.InstancedMesh(new T.CylinderGeometry(.32,.38,.42,14),metal,n);
  const M=new T.Matrix4(),Q=new T.Quaternion(),V=new T.Vector3(),one=new T.Vector3(1,1,1),Y=new T.Vector3(0,1,0),C=new T.Color(0x0e2a3a);
  ids.forEach((id,i)=>{const d=L.desks[id],dx=Math.cos(d.face),dz=Math.sin(d.face),ry=-d.face+Math.PI/2;Q.setFromAxisAngle(Y,ry);
    V.set(d.x+dx*.95,1.22,d.z+dz*.95);M.compose(V,Q,one);top.setMatrixAt(i,M);
    V.set(d.x+dx*.95,.86,d.z+dz*.95);M.compose(V,Q,one);legs.setMatrixAt(i,M);
    V.set(d.x+dx*1.15,1.56,d.z+dz*1.15);M.compose(V,Q,one);mon.setMatrixAt(i,M);
    const qs=new T.Quaternion().setFromAxisAngle(Y,ry+Math.PI);V.set(d.x+dx*1.12,1.56,d.z+dz*1.12);M.compose(V,qs,one);scr.setMatrixAt(i,M);scr.setColorAt(i,C);
    V.set(d.x,.71,d.z);M.compose(V,Q,one);stool.setMatrixAt(i,M)});
  base.add(top,legs,mon,scr,stool);G.scr=scr;G.deskIdx=Object.fromEntries(ids.map((id,i)=>[id,i]));
  // the octopuses
  const shadowM=new T.MeshBasicMaterial({map:G.glow,color:0x000000,transparent:true,opacity:.5,depthWrite:false});G.extra.push(shadowM);
  for(const b of m.bots){const old=keep[b.id],sp=new T.Sprite(new T.SpriteMaterial({map:seaOctTex(G,b.state,b.color),transparent:true,depthWrite:true,alphaTest:.12,fog:false,toneMapped:false}));
    sp.center.set(.5,.1);sp.scale.set(SEA_OCT,SEA_OCT,1);sp.userData.bot=b.id;sp.renderOrder=5;base.add(sp);G.pick.push(sp);
    const sh=new T.Mesh(new T.PlaneGeometry(1.4,1.4).rotateX(-Math.PI/2),shadowM);base.add(sh);
    const halo=new T.Sprite(new T.SpriteMaterial({map:G.glow,color:new T.Color(colorHex(b.color)||OC_DEFAULT),transparent:true,opacity:.3,depthWrite:false,blending:T.AdditiveBlending}));halo.scale.set(2.6,2.6,1);base.add(halo);
    const e={sp,sh,halo,beam:null,ph:Math.random()*6,pos:old?old.pos:null,route:null,s:0,node:null,state:''};G.bots[b.id]=e;
    seaLabel(G,'b:'+b.id,null,'','sea-bt',colorHex(b.color)||OC_DEFAULT)}}
// what a bot looks like now: its pose, screen, beacon, bubble — and where it should be (it swims there through the tubes)
function seaBotState(G,b,m,L){const T=G.T,e=G.bots[b.id];if(!e)return;
  if(e.state!==b.state+b.color){e.state=b.state+b.color;e.sp.material.map=seaOctTex(G,b.state,b.color);e.sp.material.needsUpdate=true}
  e.sp.material.color.set(b.paused?0x8a99a3:0xffffff);
  const tone=b.need?'need':b.fail?'fail':'';
  if(tone&&!e.beam){const col=tone==='need'?0xffb547:0xff4d4d,g=new T.Group();
    const beam=new T.Mesh(new T.CylinderGeometry(.28,.5,7,16,1,true),new T.MeshBasicMaterial({color:col,transparent:true,opacity:.2,blending:T.AdditiveBlending,depthWrite:false,side:T.DoubleSide,toneMapped:false}));beam.position.y=4.6;g.add(beam);
    const ring=new T.Mesh(new T.RingGeometry(.7,.86,40).rotateX(-Math.PI/2),new T.MeshBasicMaterial({color:col,transparent:true,opacity:.8,blending:T.AdditiveBlending,depthWrite:false,toneMapped:false}));ring.position.y=.55;g.add(ring);
    const lamp=new T.Sprite(new T.SpriteMaterial({map:G.glow,color:col,transparent:true,depthWrite:false,blending:T.AdditiveBlending}));lamp.position.y=2.45;lamp.scale.set(1.1,1.1,1);g.add(lamp);
    g.userData={beam,ring,lamp,tone};G.base.add(g);e.beam=g}
  if(e.beam&&e.beam.userData.tone!==tone){G.base.remove(e.beam);seaDispose(e.beam);e.beam=null;if(tone)return seaBotState(G,b,m,L)}
  const spot=seaSpot(m,L,b);
  if(!e.pos){e.pos={x:spot.x,z:spot.z};e.node=spot.node}
  else if(Math.hypot(spot.x-(e.goal?.x??e.pos.x),spot.z-(e.goal?.z??e.pos.z))>.05){
    if(seaStill()){e.pos={x:spot.x,z:spot.z};e.route=null}
    else{const pts=seaRoute(L,e.node||spot.node,spot.node,{x:e.pos.x,z:e.pos.z},spot);e.route=seaPath(pts);e.s=0}
    e.node=spot.node}
  e.goal={x:spot.x,z:spot.z};e.b=b;
  // the label: a name tag, and a bubble when there is something to say
  const lb=G.labels['b:'+b.id];if(lb){const bb=b.bubble;
    const h=`${bb&&(bb.lab||bb.txt)?`<div class="sea-bub ${bb.tone}">${bb.lab?`<b>${esc(bb.lab)}</b>`:''}${bb.txt?`<span data-u>${esc(bb.txt)}</span>`:''}</div>`:''}<div class="sea-nm"><i></i><span data-u>${esc(b.name)}</span></div>`;
    if(lb.h!==h){lb.h=h;setHTML(lb.el,h);lb.w=0;lb.fw=0}const tc='t-'+(bb?.tone||'none');if(lb.tc!==tc){if(lb.tc)lb.el.classList.remove(lb.tc);lb.el.classList.add(tc);lb.tc=tc}}}
function seaPath(pts){const seg=[];let len=0;for(let i=1;i<pts.length;i++){const l=Math.hypot(pts[i].x-pts[i-1].x,pts[i].z-pts[i-1].z);seg.push(l);len+=l}return {pts,seg,len}}
function seaAlong(r,s){let d=s*r.len;for(let i=0;i<r.seg.length;i++){if(d<=r.seg[i]||i===r.seg.length-1){const k=r.seg[i]?Math.min(1,d/r.seg[i]):1,a=r.pts[i],b=r.pts[i+1];return {x:a.x+(b.x-a.x)*k,z:a.z+(b.z-a.z)*k}}d-=r.seg[i]}return r.pts[r.pts.length-1]}
function seaLabel(G,key,at,html,cls,col){const el=document.createElement('div');el.className='sea-tag '+cls;el.style.setProperty('--c',col);if(html)setHTML(el,html);$('seaTags').appendChild(el);
  G.labels[key]={el,at,h:html,x:-1e4,y:-1e4,w:0,vis:true}}
function seaMoving(G){const v=G.view,g=G.goal;if(Math.abs(v.th-g.th)+Math.abs(v.ph-g.ph)+Math.abs(v.d-g.d)/10+Math.abs(v.tx-g.tx)/10+Math.abs(v.tz-g.tz)/10>.002)return true;
  for(const id in G.bots)if(G.bots[id].route)return true;return false}

/* one frame: time, camera, octopuses, pulses, labels, then draw */
function seaFrame(G,dt){if(!G.alive)return;const T=G.T,still=seaStill();
  if(!still)G.t+=dt;   // still pictures keep the time where it was
  const t=G.t;G.U.uTime.value=t;
  // the camera eases toward where you dragged or clicked
  const v=G.view,g=G.goal,k=seaReduced()?1:1-Math.exp(-dt*7);for(const x of ['th','ph','d','tx','tz'])v[x]+=(g[x]-v[x])*k;
  G.scene.fog.density=.0135*Math.max(.4,Math.min(1,48/v.d));   // far out, less murk: the base stays readable
  const c=G.cam,sp=Math.sin(v.ph);c.position.set(v.tx+v.d*sp*Math.sin(v.th),v.d*Math.cos(v.ph)+.5,v.tz+v.d*sp*Math.cos(v.th));c.lookAt(v.tx,1.2,v.tz);
  // octopuses
  const scrC=new T.Color();let scrDirty=false;
  for(const id in G.bots){const e=G.bots[id],b=e.b;if(!b)continue;let x=e.pos.x,z=e.pos.z,y=.92,swim=0;
    if(e.route){e.s+=dt*3.4/Math.max(1,e.route.len);const p=seaAlong(e.route,Math.min(1,e.s));x=p.x;z=p.z;swim=Math.sin(Math.min(1,e.s)*Math.PI);y=.92+swim*.35;e.pos={x,z};
      if(e.s>=1){e.route=null;e.pos={x:e.goal.x,z:e.goal.z}}}
    const bob=still||b.paused?0:b.state==='idle'?Math.sin(t*1.3+e.ph)*.05:b.state==='working'?Math.abs(Math.sin(t*4.2+e.ph))*.1:b.state==='thinking'?Math.sin(t*1.8+e.ph)*.07:Math.sin(t*2.6+e.ph)*.06;
    e.sp.position.set(x,y+bob+(swim?Math.sin(t*6)*.08:0),z);
    const sq=still||b.paused?1:b.state==='working'?1+Math.sin(t*8.4+e.ph)*.035:1+Math.sin(t*2+e.ph)*.015;e.sp.scale.set(SEA_OCT/sq,SEA_OCT*sq,1);
    e.sp.material.rotation=still?0:b.state==='thinking'?Math.sin(t*1.6+e.ph)*.1:swim?Math.sin(t*5)*.12:0;
    e.sh.position.set(x,.53,z);e.sh.scale.setScalar(1-bob*.8);
    e.halo.position.set(x,y+1.2+bob,z);e.halo.material.opacity=b.job&&!b.paused?.34+(still?0:Math.sin(t*3+e.ph)*.08):.14;
    if(e.beam){e.beam.position.set(x,0,z);const u=e.beam.userData,ph=still?.35:(t*.7+e.ph)%1;u.ring.scale.setScalar(1+ph*1.6);u.ring.material.opacity=.85*(1-ph);
      u.lamp.material.opacity=still?1:.55+.45*Math.sin(t*(u.tone==='need'?5:2.2));u.lamp.position.y=2.45+bob;u.beam.material.opacity=u.tone==='need'?.2:.12}
    // the desk screen: lit in the bot's colour while it works, flickering with the typing; dim when it rests
    const i=G.deskIdx[id];if(i!=null){const col=colorHex(b.color)||OC_DEFAULT;
      if(b.fail)scrC.set(0xff5a5a).multiplyScalar(.7+(still?0:.3*Math.sin(t*2)));
      else if(b.need)scrC.set(0xffb547).multiplyScalar(.8);
      else if(b.job&&!b.paused&&b.room==null&&!b.from)scrC.set(col).lerp(new T.Color(0x9ff6ff),.35).multiplyScalar(1.05+(still?0:.25*Math.sin(t*13+e.ph)*Math.sin(t*3.1)));
      else if(b.job)scrC.set(0x5fb0c4).multiplyScalar(.6);
      else scrC.set(0x0f3346);
      G.scr.setColorAt(i,scrC);scrDirty=true}}
  if(scrDirty)G.scr.instanceColor.needsUpdate=true;
  // light pulses along the tubes (brighter where work is being handed over)
  const hot=new Set();for(const k of SEA.m?.links||[]){const a=SEA.m.bots.find(x=>x.id===k.from),b=SEA.m.bots.find(x=>x.id===k.to);if(a&&b){hot.add('hub>'+a.pod);hot.add('hub>'+b.pod)}}
  for(const tb of G.tubes||[]){const h=hot.has(tb.key);tb.pulses.forEach((s,i)=>{const u=((t*(h?.42:.16)*(8/Math.max(4,tb.len)))+i*.5)%1;s.position.copy(tb.curve.getPointAt(h&&i?1-u:u));s.material.opacity=still?.5:Math.sin(u*Math.PI)*(h?1:.6);s.scale.setScalar(h?1.2:.8)})}
  for(const s of G.pulses||[])s.material.opacity=still?.6:.45+.3*Math.sin(t*1.4+s.userData.pulse);
  for(const s of G.pulses2||[])s.material.opacity=still?.8:.6+.4*Math.sin(t*2.2+(s.userData.pulse||0));
  for(const s of G.spin||[])s.rotation.z=still?0:t*(.4+s.userData.spin*.15);
  for(const h of G.holos||[])h.rotation.y=t*.6;
  for(const r of G.rays||[]){r.rotation.y=Math.atan2(c.position.x-r.position.x,c.position.z-r.position.z);r.rotation.z=r.userData.tilt}
  if(G.fish){const f=G.fish,M=new T.Matrix4(),Q=new T.Quaternion(),E=new T.Euler(),V=new T.Vector3(),one=new T.Vector3(1,1,1),R=(SEA.L?.span||26)+16;
    f.userData.seed.forEach(([a,b,cc],i)=>{const ang=t*.07+a*.9,rr=R+b*5+Math.sin(t*.5+i)*.6;V.set(Math.cos(ang)*rr,5.5+cc*2.5+Math.sin(t*.8+i)*.25,Math.sin(ang)*rr);E.set(0,-ang,Math.sin(t*3+i)*.15);Q.setFromEuler(E);M.compose(V,Q,one);f.setMatrixAt(i,M)});f.instanceMatrix.needsUpdate=true}
  G.r.render(G.scene,c);
  seaTags(G)}
// names and bubbles follow their octopus on the screen; bubbles that would cover each other step up
function seaScreen(id){const G=SEA.g,e=G?.bots[id];if(!e)return null;const v=new G.T.Vector3(e.sp.position.x,e.sp.position.y+SEA_OCT*.95,e.sp.position.z).project(G.cam);
  if(v.z>1)return null;return {x:(v.x+1)/2*SEA.el.clientWidth,y:(1-v.y)/2*SEA.el.clientHeight}}
function seaTags(G){const W=SEA.el.clientWidth,H=SEA.el.clientHeight,V=new G.T.Vector3(),cam=G.cam,placed=[],far=G.view.d>48,fp=SEA.focus,top=(G.top||100)+6,bottom=G.bot||H;
  const list=[];
  for(const key in G.labels){const lb=G.labels[key];let at=lb.at,b=null;
    if(key[0]==='b'){const e=G.bots[key.slice(2)];if(!e)continue;b=e.b;at={x:e.sp.position.x,y:e.sp.position.y+SEA_OCT*.92,z:e.sp.position.z}}
    else{const dx=cam.position.x-at.x,dz=cam.position.z-at.z,l=Math.hypot(dx,dz)||1;at={x:at.x+dx/l*at.r,y:.15,z:at.z+dz/l*at.r}}   // a nameplate on the front of the base
    V.set(at.x,at.y,at.z).project(cam);let show=V.z<1&&V.x>-1.1&&V.x<1.1&&V.y>-1.2&&V.y<1.2;
    // far away, a quiet bot shows only its name; in a module you look into, the others step back
    const quiet=b&&(!b.bubble||b.bubble.tone==='idle'||(W<760&&!fp&&!['need','fail'].includes(b.bubble.tone)));   // a phone shows what needs you first
    if(b&&fp&&b.pod!==fp&&quiet&&SEA.hover!==b.id)show=false;
    list.push({lb,show,x:(V.x+1)/2*W,y:(1-V.y)/2*H,z:V.z,b,quiet,pod:key[0]!=='b'})}
  // places first (they stay put), then the octopuses nearest the camera
  list.sort((a,b)=>(a.pod-b.pod)||(a.z-b.z));
  for(const it of list){const lb=it.lb;let show=it.show;
    if(show){const el=lb.el;
      let small=it.b&&far&&!fp&&it.quiet&&SEA.hover!==it.b.id;
      // sizes with and without the bubble, measured once per change of text
      if(it.b&&!lb.fw){el.classList.remove('nob');lb.fw=el.offsetWidth;lb.fh=el.offsetHeight;el.classList.add('nob');lb.nw=el.offsetWidth;lb.nh=el.offsetHeight;lb.small=null}
      if(!it.b&&!lb.w){lb.w=el.offsetWidth;lb.hh=el.offsetHeight}
      let y=it.y,w=it.b?(small?lb.nw:lb.fw):lb.w,h=it.b?(small?lb.nh:lb.fh):lb.hh;
      if(it.pod){if(y+h>bottom+4||y<top||placed.some(p=>Math.abs(p.x-it.x)<(p.w+w)/2&&y<p.y&&y+h>p.y-p.h))show=false}   // a nameplate gives way to an octopus
      else for(let pass=0;pass<5;pass++){const hit=placed.find(p=>Math.abs(p.x-it.x)<(p.w+w)/2+3&&Math.abs((p.y-p.h/2)-(y-h/2))<(p.h+h)/2+2);if(!hit)break;
        y=hit.y-hit.h-3}
      // no room above: just the name, where it belongs
      if(it.b&&!small&&y-h<top-12){small=true;y=it.y;w=lb.nw;h=lb.nh}
      if(it.b&&lb.small!==small){lb.small=small;el.classList.toggle('nob',!!small)}
      if(!it.pod&&(y-h<top-12||y>bottom+h*.5))show=false;
      if(show&&it.pod){const x=Math.round(it.x),yy=Math.round(y);if(x!==lb.x||yy!==lb.y){lb.x=x;lb.y=yy;lb.el.style.transform=`translate(${x}px,${yy}px) translate(-50%,6px)`}}
      else if(show){placed.push({x:it.x,y,w,h});
        lb.el.classList.toggle('dim',!!(it.b&&fp&&it.b.pod!==fp));
        const x=Math.round(Math.max(w/2+4,Math.min(W-w/2-4,it.x))),yy=Math.round(y);if(x!==lb.x||yy!==lb.y){lb.x=x;lb.y=yy;lb.el.style.transform=`translate(${x}px,${yy}px) translate(-50%,-100%)`}}}
    if(lb.vis!==show){lb.vis=show;lb.el.style.visibility=show?'':'hidden'}}
  if(SEA.qc)seaQcPlace()}

/* ---------- moving around: drag to turn, right-drag / two fingers / Shift to pan, wheel or pinch to zoom, click a dome ---------- */
function seaFocus(id,now){const G=SEA.g;SEA.focus=id;$('seaAll').hidden=!id;seaCards();seaDepth();
  if(!G)return;const L=SEA.L,g=G.goal,asp=G.cam.aspect||1;
  if(id&&L.pods[id]){const p=L.pods[id];g.tx=p.x;g.tz=p.z;g.d=(p.r*2.6+9)/Math.min(1,asp*1.05);g.ph=.9;g.th=id==='hub'?g.th:Math.atan2(p.x,p.z)||g.th}
  else{g.ph=.86;seaFit(G,g,!G.fitted||!now);G.fitted=true}
  const tw=Math.PI*2;g.th=G.view.th+((((g.th-G.view.th+Math.PI)%tw)+tw)%tw)-Math.PI;   // the short way round
  if(now||seaReduced())Object.assign(G.view,g);G.loop.kick(3)}
// the whole base in view, between the HUD and the cards: centre on its middle, then the nearest distance that fits
function seaFit(G,g,turn){const L=SEA.L,T=G.T,pts=[];let x0=1e9,x1=-1e9,z0=1e9,z1=-1e9;
  for(const o of [...Object.values(L.pods),...Object.values(L.rooms)]){x0=Math.min(x0,o.x-o.r);x1=Math.max(x1,o.x+o.r);z0=Math.min(z0,o.z-o.r);z1=Math.max(z1,o.z+o.r);
    for(const [dx,dz] of [[1,0],[-1,0],[0,1],[0,-1]])pts.push(new T.Vector3(o.x+dx*(o.r+.6),0,o.z+dz*(o.r+.6)));pts.push(new T.Vector3(o.x,o.r+2.4,o.z))}
  g.tx=(x0+x1)/2;g.tz=(z0+z1)/2;
  const c=G.cam.clone(),H=SEA.el.clientHeight||800,yTop=1-2*((G.top||100)+52)/H,yBot=1-2*(G.bot||H)/H,V=new T.Vector3();
  const fits=d=>{const sp=Math.sin(g.ph);c.position.set(g.tx+d*sp*Math.sin(g.th),d*Math.cos(g.ph)+.5,g.tz+d*sp*Math.cos(g.th));c.lookAt(g.tx,1.2,g.tz);c.updateMatrixWorld();
    return pts.every(p=>{V.copy(p).project(c);return V.z<1&&Math.abs(V.x)<.94&&V.y<yTop&&V.y>yBot})};
  const best=()=>{let lo=8,hi=180;for(let i=0;i<13;i++){const m=(lo+hi)/2;if(fits(m))hi=m;else lo=m}return hi};
  // the first time (and 回到全景): turn to the side that shows the base biggest
  // (and no module hidden behind another: domes that cover each other on the screen count against a side)
  const cover=d=>{fits(d);const ps=[...Object.values(L.pods),...Object.values(L.rooms)].map(o=>{V.set(o.x,o.r*.5,o.z).project(c);return {x:V.x,y:V.y*H/(SEA.el.clientWidth||1),r:o.r/Math.max(1,c.position.distanceTo(new T.Vector3(o.x,0,o.z)))*2.2}});
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
function seaHover(e){const G=SEA.g;if(!G||G.hv)return;G.hv=requestAnimationFrame(()=>{G.hv=0;if(!SEA.el)return;const u=seaHit(e),tip=$('seaTip');
  const hb=u?.bot||null;if(hb!==SEA.hover){SEA.hover=hb;G.loop.kick()}
  G.cv.style.cursor=u?'pointer':'';if(!u){tip.hidden=true;return}
  const m=SEA.m;let h='';
  if(u.bot){const b=m.bots.find(x=>x.id===u.bot);if(b)h=`<b data-u>${esc(b.name)}</b><span>${esc(b.word)}</span>${b.bubble?.txt?`<small data-u>${esc(b.bubble.txt)}</small>`:''}`}
  else if(u.pod){const p=m.pods.find(x=>x.id===u.pod);if(p){const bs=p.bots.map(id=>m.bots.find(b=>b.id===id));h=`<b data-u>${esc(seaPodName(p))}</b><span><span data-u>${bs.length}</span> <span>個機器人</span> · <span data-u>${bs.filter(b=>b.job).length}</span> <span>工作中</span></span><small>點一下進入</small>`}}
  else if(u.room){const r=m.rooms.find(x=>x.id===u.room);if(r)h=`<b data-u>${esc(r.name)}</b><span>會議室</span><small>點一下看群組</small>`}
  if(!h){tip.hidden=true;return}if(tip.dataset.k!==h){tip.dataset.k=h;setHTML(tip,h)}tip.hidden=false;
  const W=SEA.el.clientWidth;tip.style.transform=`translate(${Math.min(W-tip.offsetWidth-10,e.clientX+16)}px,${e.clientY+14}px)`})}
function seaClick(e){const u=seaHit(e);if(!u){if(!$('seaQc').hidden)seaQc(null);return}
  if(u.bot){seaQc({bot:u.bot});return}
  if(u.pod){seaQc(null);seaFocus(u.pod);return}
  if(u.room){seaQc({room:u.room})}}

$('seaBtn').onclick=()=>{if(typeof leaveOk==='function')leaveOk(openSea);else openSea()};
