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
function seaPrefs(){if(!SEA.el)return;SEA.el.classList.toggle('still',seaStill());if(SEA.g){SEA.g.pr=seaPR();SEA.g.q=null;SEA.g.r.setPixelRatio(SEA.g.pr);seaResize();SEA.g.loop.kick(2)}}
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

function seaInit(T){const el=SEA.el;
  const cv=document.createElement('canvas');cv.className='sea-cv';cv.setAttribute('aria-hidden','true');el.insertBefore(cv,el.firstChild.nextSibling);
  let r;try{r=new T.WebGLRenderer({canvas:cv,antialias:true,powerPreference:'default',stencil:false})}catch(e){cv.remove();seaFallback();return}
  r.setPixelRatio(seaPR());r.toneMapping=T.ACESFilmicToneMapping;r.toneMappingExposure=1.05;
  const scene=new T.Scene();scene.background=new T.Color(0x021019);scene.fog=new T.FogExp2(0x042132,.0135);
  const cam=new T.PerspectiveCamera(40,1,.1,500);
  const U={uTime:{value:0}};
  const G={T,r,scene,cam,U,cv,pr:seaPR(),tex:{},alive:true,bots:{},labels:{},base:null,env:null,t:0,
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

function seaMoving(G){const v=G.view,g=G.goal;if(Math.abs(v.th-g.th)+Math.abs(v.ph-g.ph)+Math.abs(v.d-g.d)/10+Math.abs(v.tx-g.tx)/10+Math.abs(v.tz-g.tz)/10>.002)return true;
  for(const id in G.bots)if(G.bots[id].route)return true;return false}

/* one frame: time, camera, octopuses, pulses, labels, then draw */
function seaFrame(G,dt){if(!G.alive)return;const T=G.T,still=seaStill();
  // a computer that cannot keep up (under 20 frames a second) gets fewer pixels, down to 60 %
  if(!still){const q=G.q||(G.q={n:0,s:0});q.n++;q.s+=dt;if(q.n>=45){const slow=q.s/q.n>.05;q.n=q.s=0;if(slow&&G.pr>.6){G.pr=Math.max(.6,G.pr-.2);G.r.setPixelRatio(G.pr);seaResize()}}}
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
  // what needs you is placed first, then work in progress, then the rest; nearer first
  const rank=it=>it.pod?9:!it.b.bubble?4:{need:0,fail:0,run:1,chat:1,pause:2}[it.b.bubble.tone]??3;
  list.sort((a,b)=>(rank(a)-rank(b))||(a.z-b.z));
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
      if(it.b&&!small&&y-h<top-12){small=true;y=it.y;w=lb.nw;h=lb.nh;
        if(placed.some(p=>Math.abs(p.x-it.x)<(p.w+w)/2&&Math.abs((p.y-p.h/2)-(y-h/2))<(p.h+h)/2))show=false}
      if(it.b&&lb.small!==small){lb.small=small;el.classList.toggle('nob',!!small)}
      if(!it.pod&&(y-h<top-12||y>bottom+4))show=false;
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
