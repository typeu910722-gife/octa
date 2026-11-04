/* OCTA 4.9 深海基地 — what the deep-sea base shows, worked out from the state the app already polls (no page, no three.js).
   Uses pure.js (botState, progView, needTag, firstSent). test/seabase.test.mjs loads the two files on their own.
   seaModel: modules (分區 → pods, the hub for bots without one, groups → meeting rooms), each bot's state, its speech
   bubble and the counters at the top · seaLayout: where everything sits on the sea floor · seaRoute: the way a bot swims
   through the tubes · seaLoop: the render loop (30 fps cap, stops while hidden) · seaDispose: frees GPU memory on close. */
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
  for(const r of rooms){const nt=needTag(lastOf(r.id),(d.lastJob||{})[r.id]);r.need=(d.gask||{})[r.id]?'ap':['ap','login','ask'].includes(nt.k)?nt.k:''}
  const need=out.filter(x=>x.need).length+rooms.filter(r=>r.need).length;
  const counters={working:out.filter(x=>x.job&&!x.paused).length,need,done:Object.values(d.done||{}).reduce((a,n)=>a+(+n||0),0),fail:out.filter(x=>x.fail).length};
  return {pods,rooms,bots:out,links,counters}}
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
  let span=10;for(const k in P)span=Math.max(span,Math.hypot(P[k].x,P[k].z)+P[k].r);for(const k in R)span=Math.max(span,Math.hypot(R[k].x,R[k].z)+R[k].r);
  return {pods:P,rooms:R,desks:B,span}}
// where a bot is meant to be: its desk, a seat at its group's table, or beside the colleague it handed work to
function seaSpot(m,L,b){if(b.room&&L.rooms[b.room]){const r=L.rooms[b.room],ms=m.bots.filter(x=>x.room===b.room),i=ms.indexOf(b),a=Math.PI*2*i/Math.max(ms.length,1)+Math.PI/2;
    return {x:r.x+Math.cos(a)*1.25,z:r.z+Math.sin(a)*1.25,node:'room:'+b.room}}
  if(b.visit&&L.desks[b.visit]){const t=L.desks[b.visit],a=t.face+Math.PI/2;return {x:t.x+Math.cos(a)*1.55-Math.cos(t.face)*.5,z:t.z+Math.sin(a)*1.55-Math.sin(t.face)*.5,node:'pod:'+t.pod}}
  const d=L.desks[b.id];return d?{x:d.x,z:d.z,node:'pod:'+d.pod}:{x:0,z:0,node:'pod:hub'}}
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
function seaLoop(o){const fps=o.fps||30,gap=1000/fps-2;let id=0,last=0,on=false,dirty=0,frames=0;
  const tick=()=>{id=0;if(!on||o.hidden())return;const t=o.now();
    if(!last||t-last>=gap){const dt=last?Math.min(.1,(t-last)/1000):1/fps;last=t;frames++;o.frame(dt,t);if(dirty>0)dirty--}
    if(on&&!o.hidden()&&(o.animate()||dirty>0))id=o.raf(tick)};
  const kick=n=>{dirty=Math.max(dirty,n||1);if(on&&!id&&!o.hidden())id=o.raf(tick)};
  return {start(){on=true;last=0;kick(2)},stop(){on=false;if(id)o.caf(id);id=0},kick,
    get running(){return !!id},get on(){return on},get frames(){return frames}}}
// free everything a scene holds on the GPU: geometries, materials, their textures (also in shader uniforms)
function seaDispose(root,extra){const seen=new Set(),n={geo:0,mat:0,tex:0};
  const tex=t=>{if(t&&t.isTexture&&!seen.has(t)){seen.add(t);t.dispose();n.tex++}};
  const mat=m=>{if(!m||seen.has(m))return;seen.add(m);for(const k in m){const v=m[k];if(v&&v.isTexture)tex(v)}
    if(m.uniforms)for(const k in m.uniforms)tex(m.uniforms[k]&&m.uniforms[k].value);m.dispose();n.mat++};
  const walk=o=>{if(o.geometry&&!seen.has(o.geometry)){seen.add(o.geometry);o.geometry.dispose();n.geo++}
    (Array.isArray(o.material)?o.material:[o.material]).forEach(mat);(o.children||[]).forEach(walk)};
  if(root)walk(root);(extra||[]).forEach(x=>x&&x.isTexture?tex(x):x&&x.isMaterial?mat(x):x&&x.dispose&&!seen.has(x)&&(seen.add(x),x.dispose()));
  return n}
