/* OCTA web app — talking to the local API, the shared state, live updates, notifications. */
'use strict';
let CFG={};                      // GET /api/config: {local, pair, …}
// 4.4: opened from the phone's stable entry (the OCTA site's /go page): keep the token it passed, remember where /go is
// (to look for the computer again when this address stops working), and take it all out of the address bar
(()=>{const f=octaFrag(location.hash);if(!f.t&&!f.web)return;
  if(f.t)store.set('ebot_token',f.t);
  if(f.go)store.set('octa_go',f.go);
  if(f.web)try{sessionStorage.setItem('octa_goweb',f.web)}catch(e){}
  if(f.retry)try{sessionStorage.setItem('octa_goretry',f.retry);sessionStorage.setItem('octa_goretryb',f.web)}catch(e){}   // 4.7 overview.js
  history.replaceState(null,'',location.pathname+location.search)})();
// this address stopped answering (the computer restarted: its address changed): back to /go, which finds the new one
// (at most once a minute, only when the phone itself is online)
function backToGo(){const go=store.get('octa_go');if(!go||DESK()||!navigator.onLine)return false;
  let last=0;try{last=+sessionStorage.getItem('octa_goback')||0}catch(e){}
  if(Date.now()-last<60000)return false;
  try{sessionStorage.setItem('octa_goback',String(Date.now()))}catch(e){}
  location.replace(go);return true}
let TOKEN=store.get('ebot_token');   // only a paired phone has one; the computer itself needs none
let myDev=store.get('octa_dev')||'';
if(!/^[a-z0-9]{8,40}$/i.test(myDev)){myDev=Math.random().toString(36).slice(2,10)+Date.now().toString(36);store.set('octa_dev',myDev)}
const EMPTY_S=()=>({bots:[],groups:[],folders:[],routines:[],last:[],ur:[],busy:[],runnerOnline:false,me:'',rev:-1,lastJob:{},queue:{}});
let S=EMPTY_S(), cur=store.get('ebot_cur'), liveOn=false;
/* messages are loaded per conversation: MSG[conv] = {list, more, loaded} */
let MSG={};

// this computer's own features (Chrome status, install an AI, files on disk…): the desktop app, or the page served to this computer
// (not while this computer is a remote control of another one: 4.3, CFG.via — those features belong to the host)
const DESK=()=>!CFG.via&&(!!window.octaDesktop||(!!CFG.local&&!CFG.pair));
// the desktop app showing its own data (labels such as 打開瀏覽器 vs 在電腦上打開瀏覽器)
const OWN_PC=()=>!!window.octaDesktop&&!CFG.via;
const ready=()=>!!(S.loaded&&!$('app').hidden);

const HEAVY=/^(template|pair|engine-test|desktop\/install|desktop\/remote|desktop\/autostart)/;
async function api(path,method='GET',body){
  const quiet=/^(state|wait|busy|job\/|file\/|messages|shot\/|ai-usage|code\/|focus$|live\/|backstage|logs\?|settings$)/.test(path);
  if(!quiet)ybar.on(HEAVY.test(path));
  try{return await api_(path,method,body)}finally{if(!quiet)ybar.off()}
}
async function api_(path,method,body){
  const r=await fetch('/api/'+path,{method,headers:{'content-type':'application/json',...(TOKEN?{authorization:'Bearer '+TOKEN}:{})},body:body?JSON.stringify(body):undefined});
  const d=await r.json().catch(()=>({error:I18N.t('網路錯誤')+`（HTTP ${r.status}）`}));
  if(r.status===401&&path!=='pair'){unpaired();throw new Error(d.error||I18N.t('需要重新配對'))}
  if(!r.ok)throw new Error(d.error||I18N.t('發生錯誤'));
  return d;
}
/* the phone lost its pairing (code changed, remote turned off and on): back to the pairing screen */
function unpaired(){TOKEN=null;store.set('ebot_token',null);liveOn=false;S=EMPTY_S();MSG={};if(typeof showPair==='function')showPair()}

/* ---------- data ---------- */
// one light request for the lists; messages are fetched per conversation
async function refresh(){
  try{const d=await api('state');if(!S.loaded)boot.set(85,'整理畫面…');
    const prevTop=S.loaded?topBotId():null,prevEng=JSON.stringify(S.engines||null);
    Object.assign(S,{me:d.me,prog:d.prog||0,bots:d.bots,groups:d.groups,folders:d.folders,routines:d.routines,busy:d.busy,runnerOnline:d.runnerOnline,engines:d.engines,
      last:d.last,ur:d.ur,rev:d.rev,lastJob:d.lastJob||{},queue:d.queue||S.queue||{},quick:d.quick||{},allow:d.allow||{},warm:d.warm??120,tokens:d.tokens||{},models:d.models||{},pins:d.pins||[],mute:d.mute||{},gask:d.gask||{},
      memory:d.memory||{},facts:d.facts||{},manuals:d.manuals||{},review:d.review!==false,skills:d.skills||{},nsk:d.nsk||{},shareBrowser:d.shareBrowser!==false,nick:d.nick||'',hostOs:d.hostOs||'',hookTunnel:d.hookTunnel||''});
    if(cur&&!conv(cur))cur=null;
    // another device looking at another chat never moves this screen: at most a small hint you can tap
    if(d.focus?.conv&&d.focus.dev&&d.focus.dev!==myDev&&conv(d.focus.conv))followRemote(d.focus);
    if(cur)await loadMsgs(cur,'new');
    if(prevTop!==null)notifyNew(prevTop);
    S.loaded=true;
    render(false);
    if(!$('veil').hidden&&$('remoteUrl'))paintRemote(false);   // the phone is watching the address open on the computer
    if(prevEng!==JSON.stringify(S.engines))engineChanged();      // an AI just got installed
  }catch(e){}
}
// live updates: the server answers as soon as anything changes (long-poll)
async function live(){
  if(liveOn)return;liveOn=true;let fails=0;
  while(liveOn){
    try{const d=await Promise.race([api('wait?rev='+S.rev+'&prog='+(S.prog||0)),new Promise((_,no)=>setTimeout(()=>no(new Error('timeout')),45000))]);fails=0;if(!liveOn)break;
      if(d.rev!==S.rev)await refresh();
      else if(d.prog!=null&&d.prog!==S.prog){const b=await api('busy');S.busy=b.busy||S.busy;S.prog=b.prog;if(b.queue)S.queue=b.queue;render(false)}}   // only a progress line changed: no full reload
    catch(e){fails++;if(fails>=3&&TOKEN&&backToGo())return;await new Promise(r=>setTimeout(r,Math.min(30000,1000*2**fails)))}
  }
  liveOn=false}
const awake=()=>{if(S.loaded&&!$('app').hidden){refresh();if(!liveOn)live()}};
document.addEventListener('visibilitychange',()=>{if(!document.hidden)awake()});
// after sleep or a network drop the long-poll can hang: catch up on focus / reconnect, and every minute regardless
['focus','online'].forEach(ev=>window.addEventListener(ev,awake));
setInterval(()=>{if(S.loaded&&!document.hidden&&!$('app').hidden)refresh()},60000);
async function loadMsgs(id,mode){   // mode: 'first' | 'new' | 'older'
  const c=MSG[id]||(MSG[id]={list:[],more:false,loaded:false});
  const real=c.list.filter(m=>!m.tmp);
  if(mode==='new'&&!c.loaded)mode='first';
  let q='messages?conv='+encodeURIComponent(id);
  if(mode==='new')q+='&after='+(real.length?real[real.length-1].id:0)+(c.at?'&since='+c.at:'');
  if(mode==='older')q+='&before='+(real.length?real[0].id:0);
  const d=await api(q);
  if(d.now&&mode!=='older')c.at=d.now-2000;
  // 4.8: a reply rewritten after it was posted (a follow-up of the same turn folded into it) replaces the copy here
  for(const x of d.changed||[]){const i=c.list.findIndex(m=>m.id===x.id);if(i>=0)c.list[i]=x}
  if(mode==='first'){c.list=[...d.msgs,...c.list.filter(m=>m.tmp)];c.more=d.more;c.loaded=true}
  else if(mode==='older'){c.list=[...d.msgs,...c.list];c.more=d.more}
  else if(d.msgs.length)c.list=[...real,...d.msgs];   // the server copy of what I sent replaces the "sending…" one
  return c}

/* ---------- lookups ---------- */
const bot=id=>S.bots.find(b=>b.id===id);
const conv=id=>bot(id)||S.groups.find(g=>g.id===id);
const isG=id=>!!id&&id.startsWith('g-');
const init=n=>esc((n||'?').slice(0,1));
const nameOf=by=>by==='me'?I18N.t('你'):by==='sys'?I18N.t('系統'):(bot(by)?.name||I18N.t('已刪除'));
const convMsgs=id=>MSG[id]?.list||[];
const busyIn=id=>S.busy.filter(b=>b.conv===id);
const botRunning=id=>S.busy.some(x=>x.bot_id===id&&x.status==='running');
const lastOf=id=>S.last.find(x=>x.conv===id);
const folderName=id=>S.folders.find(f=>f.id===id)?.name;
let SEEN={};try{SEEN=JSON.parse(store.get('octa_seen')||'{}')}catch(e){}
const unread=id=>S.ur.filter(([c,i])=>c===id&&i>(SEEN[id]||0)).length;
const topBotId=()=>S.ur.length?S.ur[0][1]:0;
function markSeen(id){const ids=[...convMsgs(id).filter(m=>!m.tmp).map(m=>m.id),...S.ur.filter(([c])=>c===id).map(([,i])=>i)];if(!ids.length)return;
  const top=Math.max(...ids);if((SEEN[id]||0)>=top)return;SEEN[id]=top;store.set('octa_seen',JSON.stringify(SEEN))}
// a bot is waiting for you: its newest message asks for approval or a sign-in
const needsYou=id=>!!needOf(id).k;
// 4.8: what this conversation needs from you (待你核准／要你登入／待你回答／未完成), from its newest message and its newest work
const needOf=id=>{if(busyIn(id).some(x=>x.status==='running'||x.status==='pending'))return apprWait(id)?{k:'ap',label:'待你核准'}:{k:'',label:''};
  const j=(S.lastJob||{})[id],t=needTag(lastOf(id),j);
  if(t.k==='fail'&&j&&FAILSEEN[id]>=j.job)return apprWait(id)?{k:'ap',label:'待你核准'}:{k:'',label:''};   // you have looked at it since
  return t.k?t:apprWait(id)?{k:'ap',label:'待你核准'}:t};
let FAILSEEN={};try{FAILSEEN=JSON.parse(store.get('octa_failseen')||'{}')}catch(e){}
function failSeen(id){const j=(S.lastJob||{})[id];if(!j||j.ok||FAILSEEN[id]>=j.job)return;FAILSEEN[id]=j.job;store.set('octa_failseen',JSON.stringify(FAILSEEN))}   // ask: the ✅ line even when it is past the preview's 140 characters
const apprWait=id=>{if((S.gask||{})[id])return true;const l=lastOf(id);return !!l&&l.by!=='me'&&l.by!=='sys'&&(APPR.test(l.ask||'')||APPR.test(l.text||''))};   // gask: a group's open card even when someone spoke after it
const apprConvs=()=>[...S.bots,...S.groups].filter(x=>apprWait(x.id));
function preview(id){const ms=convMsgs(id).filter(x=>!x.tmp&&msgPlace(x)==='chat'&&x.by!=='sys'),l=lastOf(id),m=ms.length&&(!l||ms[ms.length-1].id>=l.id)?ms[ms.length-1]:l;
  if(!m)return conv(id).task||'';
  // 4.8: the conclusion first — the result line, else the reply's first sentence (markers out), cut where a phrase ends
  const plain=m.by==='me'?String(m.text||'').replace(/\s+/g,' ').trim():msgGist(m,46);
  return (m.by==='me'?I18N.t('你：'):isG(id)?nameOf(m.by)+'：':'')+plain}
// one line for a bot's message: a loaded message (meta) or a /api/state last row (rok/rtext/awhat)
function msgGist(m,n){if(!m)return '';if(m.meta||!('rok' in m)){const v=msgView(m),mm=msgMeta(m);return gistOf(v.text,v.result,mm?.approval?.what,n)}
  return gistOf(m.text,m.rtext?{ok:+m.rok!==0,text:m.rtext}:null,m.awhat,n)}
function listTime(id){const l=lastOf(id),ms=convMsgs(id).filter(m=>!m.tmp&&msgPlace(m)==='chat'),m=ms[ms.length-1],ts=Math.max(l?.ts||0,m?.ts||0);if(!ts)return '';
  const d=new Date(ts),n=new Date(),y=new Date(n);y.setDate(n.getDate()-1);
  if(d.toDateString()===n.toDateString())return hm(ts);if(d.toDateString()===y.toDateString())return I18N.t('昨天');
  if(n-d<6*864e5)return d.toLocaleDateString(I18N.lang,{weekday:'short'});
  return d.toLocaleDateString(I18N.lang,{month:'numeric',day:'numeric',...(d.getFullYear()!==n.getFullYear()?{year:'2-digit'}:{})})}

/* ---------- notifications on this device: new bot replies you're not looking at ---------- */
const NOTI_KEY='octa_notify';
const notiOn=()=>{const v=store.get(NOTI_KEY);return v===null?!!window.octaDesktop:v==='1'};
function notifyNew(prevTop){
  const fresh=S.ur.filter(([,i])=>i>prevTop);if(!fresh.length)return;
  const convs=[...new Set(fresh.map(([c])=>c))];
  for(const c of convs){const l=lastOf(c),cv=conv(c);if(!l||!cv||l.by==='me'||l.by==='sys'||(S.mute||{})[c])continue;
    const looking=c===cur&&!document.hidden;if(looking)continue;
    const who=isG(c)?nameOf(l.by)+' · '+cv.name:cv.name;
    // a chat is open: a small hint you can tap (the screen itself never moves); none open: the usual toast
    const ml=convMsgs(c).find(x=>x.id===l.id),what=msgGist(ml||l,90),need=needOf(c);   // 4.8: the line says what happened
    if(!document.hidden){if(cur&&conv(cur))showHint(c,need.k?'ask':'new','n:'+c+':'+l.id,what,need);else toast(who+'：'+what)}
    if(notiOn()&&'Notification' in window&&Notification.permission==='granted'&&(document.hidden||c!==cur)){
      try{const n=new Notification('OCTA · '+who+(need.k?' · '+I18N.t(need.label):''),{body:what||l.text.replace(/\s+/g,' ').slice(0,180),icon:'/icon.png',tag:'octa-'+c});
        n.onclick=()=>{window.focus();window.octaDesktop?.show?.();if(needsHand(l.text)&&bot(l.by)&&!embedHere())goWeb(c,l.by);else openConv(c);n.close()}}catch(e){}}}}   // it needs you to sign in: its 瀏覽器 tab, ready to 接手
/* 核准 nobody looked at for 15 minutes: one more notice on this device (Telegram / LINE are sent by the server) */
const NAG_MS=15*60000;
function apprNag(){if(!ready())return;let seen=[];try{seen=JSON.parse(store.get('octa_nag')||'[]')}catch(e){}
  const t=Date.now();let changed=false;
  for(const x of apprConvs()){const l=(S.gask||{})[x.id]||lastOf(x.id);if(!l||t-(l.ts||0)<NAG_MS||seen.includes(l.id)||(S.mute||{})[x.id])continue;seen.push(l.id);changed=true;
    const act=((l.ask||l.text||'').match(APPR)||[])[1]||'',who=isG(x.id)?nameOf(l.by)+' · '+x.name:x.name;
    if(!document.hidden&&cur&&x.id!==cur)showHint(x.id,'ask','g:'+l.id,I18N.t('要你核准：')+firstSent(act,60),{k:'ap',label:'待你核准'});
    if(notiOn()&&'Notification' in window&&Notification.permission==='granted'){
      try{const n=new Notification('OCTA · '+I18N.t('還在等你核准'),{body:who+'：'+act.slice(0,160),icon:'/icon.png',tag:'octa-ap-'+l.id,requireInteraction:true});
        n.onclick=()=>{window.focus();window.octaDesktop?.show?.();goAsk(x.id);n.close()}}catch(e){}}}
  if(changed)store.set('octa_nag',JSON.stringify(seen.slice(-200)))}
setInterval(apprNag,60000);
