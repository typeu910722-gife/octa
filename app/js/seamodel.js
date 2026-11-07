/* OCTA 4.9 深海基地 — what the deep-sea base shows, worked out from the state the app already polls (no page, no three.js).
   Uses pure.js (botState, progView, needTag, firstSent). test/seabase.test.mjs loads the two files on their own.
   seaModel: modules (分區 → pods, the hub for bots without one, groups → meeting rooms), each bot's state, its speech
   bubble and the counters at the top · seaLayout: where everything sits on the sea floor · seaRoute: the way a bot swims
   through the tubes · seaLoop: the render loop (rate decided each frame, stops while hidden) · seaRate: 30 / 10 / 0 frames a
   second (4.10, the base is the main screen) · seaFrameOf: aim the camera beside the chat panel · seaDispose: frees GPU memory. */
'use strict';
// each module's light (the hub is always teal); bots keep their own colour
const SEA_POD_COLS=['#3EE6E0','#B59CFF','#FFB86B','#FF86BE','#7CEFA0','#78B8FF','#F4DF6E','#FF9A7A'];
const SEA_DEPTH0=120,SEA_DEPTH_STEP=20;
// a short line for a bubble: whole words, at most n characters
function seaCut(t,n){t=String(t??'').replace(/\s+/g,' ').trim();n=n||26;if(t.length<=n)return t;
  const c=t.slice(0,n-1),at=Math.max(c.lastIndexOf('，'),c.lastIndexOf('、'),c.lastIndexOf(' '),c.lastIndexOf('；'),c.lastIndexOf(','));
  return (at>=n*.55?c.slice(0,at):c)+'…'}
const SEA_STATE_WORD={idle:'待命',thinking:'思考中',working:'工作中',browsing:'操作瀏覽器',chatting:'和同事交流'};
/* d: {bots, groups, folders, busy, last (S.last rows), lastJob, gask, done ({bot: n finished today}), now}
   → {pods, rooms, bots, links, counters} */
function seaModel(d){d=d||{};const bots=d.bots||[],groups=d.groups||[],folders=d.folders||[],busy=d.busy||[],now=d.now||Date.now();
  const lastOf=id=>(d.last||[]).find(x=>x.conv===id);
  const name=id=>(bots.find(b=>b.id===id)||groups.find(g=>g.id===id)||{}).name||'';
  const gids=new Set(groups.map(g=>g.id)),fids=new Set(folders.map(f=>f.id));
  const podOf=f=>f&&fids.has(f)?f:'hub';
  const pods=[{id:'hub',kind:'hub',name:'中央大廳',color:SEA_POD_COLS[0],depth:SEA_DEPTH0,bots:[],rooms:[]}];
  folders.forEach((f,i)=>pods.push({id:f.id,kind:'pod',name:f.name,color:SEA_POD_COLS[(i+1)%SEA_POD_COLS.length],depth:SEA_DEPTH0+SEA_DEPTH_STEP*(i+1),bots:[],rooms:[]}));
  const pod=id=>pods.find(p=>p.id===id);
  const rooms=groups.map(g=>({id:g.id,name:g.name,pod:podOf(g.folder),members:(g.members||[]).filter(m=>bots.some(b=>b.id===m)),need:'',busy:false}));
  rooms.forEach(r=>pod(r.pod).rooms.push(r.id));
  const links=[];
  const out=bots.map(b=>{
    const mine=busy.filter(x=>x.bot_id===b.id),run=mine.filter(x=>x.status==='running'),
      job=run.find(x=>!+x.bg&&x.kind==='chat')||run.find(x=>!+x.bg)||run[0]||null;
    const st=botState(b.id,busy),v=job?progView(job.progress):null,paused=!!(job&&job.paused);
    const nt=needTag(lastOf(b.id),(d.lastJob||{})[b.id]),need=['ap','login','ask'].includes(nt.k)?nt.k:'',fail=!job&&nt.k==='fail';
    const from=job&&+job.bg&&job.from&&job.from!==b.id?job.from:null;
    if(from)links.push({from,to:b.id,job:job.job});
    const x={id:b.id,name:b.name,color:b.color||'',pod:podOf(b.folder),state:st,word:SEA_STATE_WORD[st]||'待命',job:job?job.job:null,paused,need,fail,
      queued:mine.filter(x=>x.status==='pending').length,from,room:job&&gids.has(job.conv)?job.conv:null,visit:null,bubble:null};
    if(paused)x.word='已暫停';else if(need)x.word=nt.label;else if(fail)x.word='沒做成';else if(!job&&x.queued)x.word='排隊中';
    // the bubble: what it is doing now (step N/M), what it waits for, or why it stopped
    const l=lastOf(b.id);
    if(job){const step=v.has?v.step+'/'+v.total:'',cur=seaCut(v.cur,24);
      if(paused)x.bubble={lab:'已暫停',txt:[step,cur].filter(Boolean).join(' '),tone:'pause'};
      else if(from)x.bubble={lab:'幫同事',txt:seaCut(name(from),10)+(cur?'：'+cur:''),tone:'chat'};
      else x.bubble={lab:cur?'':st==='thinking'?'思考中…':'工作中…',txt:[step,cur].filter(Boolean).join(' '),tone:'run'}}
    else if(need)x.bubble={lab:nt.label,txt:need==='ap'&&l?.awhat?seaCut(l.awhat,22):'',tone:'need'};
    else if(fail){const j=(d.lastJob||{})[b.id];x.bubble={lab:'沒做成',txt:seaCut(j?.msg||'',22),tone:'fail'}}
    else if(x.queued)x.bubble={lab:'排隊中',txt:'',tone:'idle'};
    else if(l&&l.by===b.id&&now-(+l.ts||0)<864e5){const t=String(l.rtext||l.text||'').replace(/^\s*[✅⚠❓📌⏰🧩📝]\s*(已完成|完成|待確認)?[:：]?\s*/u,'');const s=typeof firstSent==='function'?firstSent(t,40):t;x.bubble={lab:'',txt:seaCut(s,24),tone:'idle'}}
    return x});
  // a bot that handed work over (and has nothing of its own running) swims to the colleague and waits beside it
  for(const k of links){const a=out.find(x=>x.id===k.from);if(a&&!a.job&&!a.visit){a.visit=k.to;if(!a.need&&!a.fail)a.bubble={lab:'等回覆',txt:seaCut(name(k.to),10),tone:'chat'}}}
  for(const x of out){pod(x.pod).bots.push(x.id);if(x.room)rooms.find(r=>r.id===x.room).busy=true}
  // 4.9.2 nothing to do: no dozing at the desk — each finds something to do (two of them play together); work always wins
  const acts=seaActs(out.filter(seaIsFree).map(x=>x.id),now);
  for(const x of out){const a=acts[x.id]||null;x.act=a;if(!a)continue;
    x.word=SEA_ACTS[a.k].word;x.bubble={lab:SEA_ACTS[a.k].word,txt:a.with?seaCut(name(a.with),8):'',tone:a.k==='nap'?'idle':'play'}}
  for(const r of rooms){const nt=needTag(lastOf(r.id),(d.lastJob||{})[r.id]);r.need=(d.gask||{})[r.id]?'ap':['ap','login','ask'].includes(nt.k)?nt.k:''}
  const need=out.filter(x=>x.need).length+rooms.filter(r=>r.need).length;
  const counters={working:out.filter(x=>x.job&&!x.paused).length,need,done:Object.values(d.done||{}).reduce((a,n)=>a+(+n||0),0),fail:out.filter(x=>x.fail).length};
  return {pods,rooms,bots:out,links,counters}}
/* 4.9.2 what an idle bot does instead of dozing. two: a game for two at a table in 遊戲角 (the play corner beside the hub);
   at: where it happens (t0 / t1 tables, arcade, juke, bean in 遊戲角; desk, edge of its own dome, lap round it);
   pose: the octopus drawing; w: how often it is picked (a nap is rare) */
const SEA_ACTS={
  pingpong:{two:1,at:'t0',word:'打桌球中 🏓',pose:'working'},
  chess:{two:1,at:'t1',word:'下棋中 ♟️',pose:'thinking'},
  cards:{two:1,at:'t1',word:'玩牌中 🃏',pose:'working'},
  arcade:{at:'arcade',one:1,word:'挑戰街機高分 🕹️',pose:'working',w:3},
  dance:{at:'juke',one:1,word:'跟著音樂跳舞 🎵',pose:'working',w:2},
  read:{at:'bean',one:1,word:'窩在懶骨頭看書 📖',pose:'thinking',w:3},
  juggle:{at:'desk',word:'玩泡泡雜耍',pose:'working',w:3},
  yoyo:{at:'desk',word:'玩溜溜球',pose:'working',w:2},
  feed:{at:'edge',word:'餵小魚 🐟',pose:'working',w:2},
  coral:{at:'edge',word:'照顧發光珊瑚',pose:'thinking',w:2},
  lap:{at:'lap',word:'繞著艙室游一圈',pose:'working',w:2},
  nap:{at:'desk',word:'小睡一下',pose:'idle',w:1}};
const SEA_SOLO=Object.keys(SEA_ACTS).filter(k=>!SEA_ACTS[k].two);
const SEA_PAIR_MS=45000;
// free to play: nothing running, queued, waiting for you, failed, or waiting on a colleague
const seaIsFree=x=>!x.job&&!x.queued&&!x.need&&!x.fail&&!x.visit&&!x.paused;
function seaHash(s){let h=2166136261;for(const c of String(s)){h^=c.codePointAt(0);h=Math.imul(h,16777619)}
  h^=h>>>16;h=Math.imul(h,2246822507);h^=h>>>13;h=Math.imul(h,3266489909);h^=h>>>16;return h>>>0}   // FNV-1a, then mixed (similar names and slots differ)
/* ids: the bots free to play; now: the time. → {id: {k, at, with?, side?}}
   The same bots at the same moment always get the same answer. Pairs change every 45 s (up to two tables, each used
   about three times in four); everyone else changes on their own rhythm, every 20–60 s; the arcade cabinet, the jukebox
   and the bean bag take one bot at a time. */
function seaActs(ids,now){const out={},slot=Math.floor(now/SEA_PAIR_MS);
  const order=[...ids].sort((a,b)=>(seaHash(a+':'+slot)-seaHash(b+':'+slot))||(a<b?-1:1));let i=0;
  for(const [at,kinds] of [['t0',['pingpong']],['t1',['chess','cards']]]){if(order.length-i<2)break;if(seaHash(at+'#'+slot)%4===3)continue;
    const a=order[i++],b=order[i++],k=kinds[seaHash(at+':'+slot)%kinds.length];out[a]={k,at,with:b,side:0};out[b]={k,at,with:a,side:1}}
  const taken=new Set(),W=SEA_SOLO.reduce((n,k)=>n+SEA_ACTS[k].w,0);
  for(const id of [...ids].sort()){if(out[id])continue;
    const per=20000+seaHash(id)%40000,s=Math.floor((now+seaHash(id+'~')%per)/per);let r=seaHash(id+':'+s)%W,j=0;
    while(r>=SEA_ACTS[SEA_SOLO[j]].w){r-=SEA_ACTS[SEA_SOLO[j]].w;j++}
    for(let n=0;n<SEA_SOLO.length;n++){const k=SEA_SOLO[(j+n)%SEA_SOLO.length];if(SEA_ACTS[k].one&&taken.has(k))continue;if(SEA_ACTS[k].one)taken.add(k);out[id]={k,at:SEA_ACTS[k].at};break}}
  return out}
// the sea floor: the hub in the middle, modules around it, each meeting room beside its module. Units are metres.
function seaLayout(m){const P={},R={},B={};
  const podR=n=>n<=1?3.4:Math.min(11,2.6+n*.78);
  const hub=m.pods[0];P.hub={x:0,z:0,r:Math.max(4.6,podR(hub.bots.length)+.8)};
  const ring=m.pods.slice(1),maxR=Math.max(3.4,...ring.map(p=>podR(p.bots.length)));
  ring.forEach((p,i)=>{const a=-Math.PI/2+Math.PI*2*i/Math.max(ring.length,1)+(ring.length===2?Math.PI/6:0),r=podR(p.bots.length);
    const dist=P.hub.r+maxR+(ring.length>4?6.5:4.8);P[p.id]={x:Math.cos(a)*dist,z:Math.sin(a)*dist,r,a}});
  // desks around the inside of the dome, facing out
  for(const p of m.pods){const c=P[p.id],n=p.bots.length,rr=n<=1?0:c.r*.56,hubPad=p.id==='hub'?1.3:0;
    p.bots.forEach((id,i)=>{const a=(n<=1?Math.PI/2:Math.PI*2*i/n+Math.PI/2),rad=n<=1?(p.id==='hub'?2.2:0):Math.max(rr,hubPad+1.4);
      B[id]={x:c.x+Math.cos(a)*rad,z:c.z+Math.sin(a)*rad,face:a,pod:p.id}})}
  // meeting rooms: halfway out from their module, to the side
  const per={};for(const r of m.rooms){const k=r.pod;per[k]=(per[k]||0)+1;const i=per[k]-1,c=P[k];
    const base=k==='hub'?Math.PI/2+i*.9:(c.a||0)+(i%2?-1:1)*(.62+Math.floor(i/2)*.45);
    const d=c.r+4.2;R[r.id]={x:c.x+Math.cos(base)*d,z:c.z+Math.sin(base)*d,r:2.5,pod:k}}
  // 4.9.2 遊戲角: a small dome beside the hub, where the free bots play; the nearest spot clear of everything else
  const LR=5.2,others=[...Object.values(P),...Object.values(R)];let pl=null;
  for(let i=0;i<24;i++){const a=i/24*Math.PI*2+.13;for(let d=P.hub.r+LR+3;d<P.hub.r+LR+60;d+=.5){const x=Math.cos(a)*d,z=Math.sin(a)*d;
    const clear=Math.min(...others.map(o=>Math.hypot(o.x-x,o.z-z)-o.r-LR));if(clear>2.6){if(!pl||d<pl.d-.01)pl={x,z,r:LR,a,d};break}}}
  const S={};
  if(pl){P.play={x:pl.x,z:pl.z,r:LR,a:pl.a};
    // spots in the dome: u points away from the hub, v across
    const ux=Math.cos(pl.a),uz=Math.sin(pl.a),at=(u,v,face)=>({x:pl.x+ux*u-uz*v,z:pl.z+uz*u+ux*v,face});
    Object.assign(S,{t0:at(0,-2.2),t0a:at(0,-3.95),t0b:at(0,-.45),t1:at(-1.2,2.4),t1a:at(-2.5,2.4),t1b:at(.1,2.4),
      arcade:at(3.9,-.5),arcadeB:at(2.85,-.5),juke:at(2.6,-3.6),jukeB:at(1.9,-2.6),bean:at(2.2,3.2),beanB:at(2.2,3.1)})}
  let span=10;for(const k in P)span=Math.max(span,Math.hypot(P[k].x,P[k].z)+P[k].r);for(const k in R)span=Math.max(span,Math.hypot(R[k].x,R[k].z)+R[k].r);
  return {pods:P,rooms:R,desks:B,span,spots:S}}
// where a bot is meant to be: its desk, a seat at its group's table, or beside the colleague it handed work to
function seaSpot(m,L,b){if(b.room&&L.rooms[b.room]){const r=L.rooms[b.room],ms=m.bots.filter(x=>x.room===b.room),i=ms.indexOf(b),a=Math.PI*2*i/Math.max(ms.length,1)+Math.PI/2;
    return {x:r.x+Math.cos(a)*1.25,z:r.z+Math.sin(a)*1.25,node:'room:'+b.room}}
  if(b.visit&&L.desks[b.visit]){const t=L.desks[b.visit],a=t.face+Math.PI/2;return {x:t.x+Math.cos(a)*1.55-Math.cos(t.face)*.5,z:t.z+Math.sin(a)*1.55-Math.sin(t.face)*.5,node:'pod:'+t.pod}}
  const d=L.desks[b.id];
  // 4.9.2 playing: at a table, the arcade, the jukebox or the bean bag in 遊戲角, or near its own desk (only while free)
  const a=b.act&&!b.job?b.act:null;
  if(a&&d){const S=L.spots||{};
    if(a.with!=null&&S[a.at+(a.side?'b':'a')]){const s=S[a.at+(a.side?'b':'a')];return {x:s.x,z:s.z,node:'pod:play'}}
    if(S[a.at+'B']){const s=S[a.at+'B'];return {x:s.x,z:s.z,node:'pod:play'}}
    if(a.at==='edge'){const p=L.pods[d.pod],k=Math.max(0,p.r-1.1);return {x:p.x+Math.cos(d.face)*k,z:p.z+Math.sin(d.face)*k,node:'pod:'+d.pod}}}
  return d?{x:d.x,z:d.z,node:'pod:'+d.pod}:{x:0,z:0,node:'pod:hub'}}
// the way from one place to another, through the tubes: up to the hub and down again (points {x,z})
function seaRoute(L,fromNode,toNode,a,b){if(fromNode===toNode)return [a,b];
  const up=n=>{const [k,id]=n.split(':');if(k==='room'){const r=L.rooms[id];return r?['pod:'+r.pod]:[]}return id==='hub'?[]:['pod:hub']};
  const chain=n=>{const c=[n];let x=n;for(let i=0;i<3;i++){const u=up(x);if(!u.length)break;x=u[0];c.push(x)}return c};
  const A=chain(fromNode),Bc=chain(toNode),meet=A.find(x=>Bc.includes(x))||'pod:hub';
  const nodes=[...A.slice(0,A.indexOf(meet)+1),...Bc.slice(0,Bc.indexOf(meet)).reverse()];
  const at=n=>{const [k,id]=n.split(':'),o=k==='room'?L.rooms[id]:L.pods[id];return o?{x:o.x,z:o.z}:{x:0,z:0}};
  // through each place's door: the edge of its dome toward the next one
  const pts=[a];for(let i=0;i<nodes.length;i++){const c=at(nodes[i]),r=(nodes[i].startsWith('room')?L.rooms:L.pods)[nodes[i].split(':')[1]]?.r||3;
    const prev=i>0?at(nodes[i-1]):null,next=i<nodes.length-1?at(nodes[i+1]):null;
    const door=o=>{const dx=o.x-c.x,dz=o.z-c.z,l=Math.hypot(dx,dz)||1;return {x:c.x+dx/l*r,z:c.z+dz/l*r}};
    if(prev)pts.push(door(prev));if(i>0&&next)pts.push(c);if(next)pts.push(door(next))}
  pts.push(b);return pts}
/* the render loop: at most fps frames a second, nothing while hidden or stopped, and only while something moves
   (animate()) or after kick(n) asked for n more frames (a change, a drag, the camera settling).
   o: {raf, caf, now, frame(dt, t), hidden(), animate(), fps} */
/* the render loop. 4.10: the base is the main screen, so how often it draws is decided every frame by o.rate()
   (frames a second: 30, 10, or 0 = only the frames asked for with kick, e.g. a still picture after a change).
   30 and up waits for the display (requestAnimationFrame), slower rates sleep in between (no wake-ups at 60 Hz).
   Without o.rate: 30 a second while o.animate() says something moves (4.9). Nothing at all while o.hidden(). */
function seaLoop(o){let id=0,tm=0,last=0,on=false,dirty=0,frames=0;
  const later=o.later||((f,ms)=>setTimeout(f,ms)),clear=o.clear||(x=>clearTimeout(x));
  const rate=()=>o.rate?o.rate():o.animate()?(o.fps||30):0;
  const tick=()=>{id=0;if(!on||o.hidden())return;const t=o.now(),r=rate(),gap=r?1000/r-(r<20?25:2):0;
    if(!last||t-last>=gap||(dirty>0&&!r)){const dt=last?Math.min(.1,(t-last)/1000):1/30;last=t;frames++;o.frame(dt,t);if(dirty>0)dirty--}
    sched()};
  const sched=()=>{if(id||tm||!on||o.hidden())return;const r=rate();
    if(r>=20||dirty>0)id=o.raf(tick);
    else if(r>0)tm=later(()=>{tm=0;if(on&&!o.hidden()&&!id)id=o.raf(tick)},Math.max(0,1000/r-20))};
  const kick=n=>{dirty=Math.max(dirty,n||1);if(tm){clear(tm);tm=0}sched()};
  return {start(){on=true;last=0;kick(2)},stop(){on=false;if(id)o.caf(id);if(tm)clear(tm);id=tm=0},kick,
    get running(){return !!(id||tm)},get on(){return on},get frames(){return frames}}}
/* 4.10 how fast the main screen's base draws (frames a second). o: {on (主畫面 3D 基地), gl, hidden (window hidden or
   minimised, or the base not on screen: a narrow window, the phone's chat screen, its folded header), blurMs (how long the
   window has been in the background), still (省電模式 or reduced motion), moving (the camera is still gliding),
   covered (share of the stage under the chat panel), typing (the message box has the focus), focused}.
   30 while you watch it; 10 when the chat covers most of it, you type, or the window is in the background; nothing after
   30 s in the background, while hidden, or as a still picture (省電模式 / reduced motion: redrawn when something changes). */
const SEA_BLUR_MS=30000;
function seaRate(o){o=o||{};
  if(!o.on||!o.gl||o.hidden)return 0;
  if(!o.focused&&(o.blurMs||0)>SEA_BLUR_MS)return 0;
  if(o.still)return o.moving?30:0;
  if(!o.focused||o.typing||(o.covered||0)>.6)return 10;
  return 30}
/* 4.10 where the picture is aimed. w×h: the stage; left: how far the chat panel covers it from the left (0 when the chat
   is minimised or not open); right: a right panel floating over it (761–1180 px wide windows); top: the HUD. The camera's view is shifted so whatever it looks at sits in the middle
   of the part you can see: ox/oy go to camera.setViewOffset; cx/cy is that middle on the stage; xl is the visible part's
   left / right edges in clip space (-1…1), cover how much of the stage is covered. */
function seaFrameOf(v){const w=Math.max(1,v.w||1),h=Math.max(1,v.h||1),left=Math.max(0,Math.min(w*.85,v.left||0)),right=Math.max(0,Math.min(w*.85-left,v.right||0)),top=Math.max(0,v.top||0);
  return {ox:-(left-right)/2,oy:-top/2,cx:(left+w-right)/2,cy:(top+h)/2,xl:-1+2*left/w,xr:1-2*right/w,cover:(left+right)/w}}
// free everything a scene holds on the GPU: geometries, materials, their textures (also in shader uniforms)
function seaDispose(root,extra){const seen=new Set(),n={geo:0,mat:0,tex:0};
  const tex=t=>{if(t&&t.isTexture&&!seen.has(t)){seen.add(t);t.dispose();n.tex++}};
  const mat=m=>{if(!m||seen.has(m))return;seen.add(m);for(const k in m){const v=m[k];if(v&&v.isTexture)tex(v)}
    if(m.uniforms)for(const k in m.uniforms)tex(m.uniforms[k]&&m.uniforms[k].value);m.dispose();n.mat++};
  const walk=o=>{if(o.geometry&&!seen.has(o.geometry)){seen.add(o.geometry);o.geometry.dispose();n.geo++}
    (Array.isArray(o.material)?o.material:[o.material]).forEach(mat);(o.children||[]).forEach(walk)};
  if(root)walk(root);(extra||[]).forEach(x=>x&&x.isTexture?tex(x):x&&x.isMaterial?mat(x):x&&x.dispose&&!seen.has(x)&&(seen.add(x),x.dispose()));
  return n}
/* 4.15 公司組織圖: the same model drawn as a company. o: {ceo, leads: {分區 id ('hub' = 總部): bot id}, total: {bot: work ever done}}
   → {ceo, depts, links, counters}. The CEO leaves its department; a lead must belong to the department it leads. */
const orgLevel=n=>Math.min(99,1+Math.floor(Math.sqrt(Math.max(0,+n||0)/3)));   // 1 at the start, 2 after 3 jobs, 3 after 12, 5 after 48…
function orgModel(m,o){o=o||{};const leads=o.leads||{},total=o.total||{},ids=new Set(m.bots.map(b=>b.id)),byId=id=>m.bots.find(b=>b.id===id);
  const ceo=o.ceo&&ids.has(o.ceo)?o.ceo:null;
  const card=b=>({id:b.id,name:b.name,color:b.color,state:b.state,word:b.word,bubble:b.bubble,need:b.need,fail:b.fail,paused:b.paused,
    on:!!(b.job&&!b.paused),lv:orgLevel(total[b.id]),done:+total[b.id]||0});
  const depts=m.pods.map(p=>{const bs=p.bots.filter(id=>id!==ceo).map(byId).filter(Boolean),lead=bs.find(b=>b.id===leads[p.id])||null;
    const rooms=p.rooms.map(id=>m.rooms.find(r=>r.id===id)).filter(Boolean).map(r=>({id:r.id,name:r.name,busy:r.busy,need:r.need,n:r.members.length}));
    return {id:p.id,name:p.kind==='hub'?'總部':p.name,hub:p.kind==='hub',color:p.color,lead:lead?card(lead):null,members:bs.filter(b=>b!==lead).map(card),rooms,
      busy:bs.filter(b=>b.job&&!b.paused).length,n:bs.length,need:bs.some(b=>b.need)||rooms.some(r=>r.need)}}).filter(d=>d.n||d.rooms.length);
  const c=ceo?byId(ceo):null;
  return {ceo:c?card(c):null,depts,links:m.links.filter(k=>ids.has(k.from)&&ids.has(k.to)),counters:m.counters}}
