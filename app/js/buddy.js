/* OCTA web app — 小八, the little octopus beside the conversation: who is working, who waits for you, quick actions. */
'use strict';
const OCT={hold:0,busy:null,greeted:new Set(),askKey:''};
const OCT_HI=['嗨！我是小八','要我幫你看看誰在忙嗎？','點我有快捷功能喔','今天也一起加油！'];
function buddyStore(k,v){if(v==null)return store.get(k);store.set(k,v);return null}
function buddyOn(){return buddyStore('octa_buddy')!=='0'}
function octSay(t,ms=4200){const n=$('buddySay');if(!n)return;n.textContent=t?I18N.t(t):'';n.classList.toggle('on',!!t);clearTimeout(octSay.t);if(t)octSay.t=setTimeout(()=>{n.textContent='';n.classList.remove('on')},ms)}
function octMood(m,line,hold){const el=$('buddy');if(!el)return;if(el.dataset.mood!==m)el.dataset.mood=m;if(line)octSay(line);if(hold)OCT.hold=Date.now()+hold}
function octAsks(){return [...S.bots,...S.groups].filter(x=>needsYou(x.id))}
function buddySync(){
  const el=$('buddy');if(!el)return;
  const show=buddyOn()&&!$('app').hidden&&!!(cur&&conv(cur))&&(!phoneUI()||$('app').classList.contains('chat'))&&!(phoneUI()&&detailOpen());
  el.hidden=!show;if(!show){$('octMenu').hidden=true;return}
  const na=apprConvs().length;$('octN').hidden=!na;$('octN').textContent=na?String(na):'';   // how many 核准 are waiting, on his head
  // a bot finished (or got stuck) since last time: hop and say so
  const running=new Set(S.busy.filter(x=>x.status==='running').map(x=>x.bot_id));
  if(OCT.busy)for(const id of OCT.busy)if(!running.has(id)){const l=lastOf(id),nm=nameOf(id);
    if(l&&/^⚠/.test(l.text||''))octMood('err',nm+' '+I18N.t('卡住了，點我看看'),6000);else octMood('done',nm+' '+I18N.t('做好了！'),5000)}
  OCT.busy=running;
  if(Date.now()<OCT.hold)return;
  const asks=octAsks(),key=asks.map(x=>x.id).join();
  if(asks.length){octMood('ask',key!==OCT.askKey?(asks.length===1?asks[0].name:asks.length+' '+I18N.t('隻機器人'))+' '+I18N.t('在等你回覆'):'');OCT.askKey=key;return}
  OCT.askKey='';
  if(busyIn(cur).some(x=>x.status==='running')){octMood('work');return}
  if(($('msg')?.value||'').trim()){octMood('listen');return}
  if(!OCT.greeted.has(cur)){OCT.greeted.add(cur);octMood('hi',OCT.greeted.size===1?OCT_HI[0]:'',2600);return}
  const last=convMsgs(cur).reduce((a,m)=>Math.max(a,m.ts||0),0);
  octMood(!last||Date.now()-last>180000?'sleep':'idle')}
function octMenu(){
  const box=$('octMenu');const c=conv(cur),isBot=c&&!isG(cur);
  const run=S.busy.filter(x=>x.kind!=='test'),asks=octAsks();
  const unreadList=[...S.bots,...S.groups].filter(x=>x.id!==cur&&unread(x.id));
  const row=(id,sub)=>`<button type="button" class="om-it" data-go="${id}"><span class="av xs"${isG(id)?'':' data-u'}>${isG(id)?ic('users'):avOf(id)}</span><span class="omt" data-u>${esc(conv(id)?.name||nameOf(id))}</span><small data-u>${esc(I18N.t(sub||''))}</small></button>`;
  box.innerHTML=`<div class="om-hd"><b>小八</b><small>${run.length?run.length+' '+I18N.t('件工作中'):I18N.t('大家都有空')}</small></div>
    ${asks.length?`<div class="om-sec">等你回覆</div>${asks.map(x=>row(x.id,apprWait(x.id)?'待你核准':'待你處理')).join('')}`:''}
    <div class="om-sec">正在工作</div>${run.length?run.map(x=>row(x.bot_id,x.status==='running'?(x.progress||'處理中'):'排隊中')).join(''):'<div class="om-empty">目前沒有機器人在工作</div>'}
    ${unreadList.length?`<div class="om-sec">有新訊息</div>${unreadList.slice(0,5).map(x=>row(x.id,unread(x.id)+' '+I18N.t('則'))).join('')}`:''}
    <div class="om-sec">快速動作</div>
    ${isBot?`<button type="button" class="om-it" data-act="sum"><span class="em">📝</span>整理這段對話的重點</button><button type="button" class="om-it" data-act="next"><span class="em">👉</span>接下來該做什麼？</button><button type="button" class="om-it" data-act="what"><span class="em">🧭</span>你會做哪些事？</button>`:''}
    <button type="button" class="om-it" data-act="new"><span class="em">🤖</span>新機器人</button>
    <button type="button" class="om-it" data-act="hide"><span class="em">🙈</span>先把小八藏起來</button>`;
  box.querySelectorAll('[data-go]').forEach(b=>b.onclick=()=>{box.hidden=true;apprWait(b.dataset.go)?goAsk(b.dataset.go):openConv(b.dataset.go)});
  const say={sum:'用三到五句話整理我們這段對話的重點，還沒做完的事也列出來。',next:'根據目前的對話，接下來最該做的三件事是什麼？',what:'用幾句話告訴我你現在能幫我做哪些事、需要我給你什麼。'};
  box.querySelectorAll('[data-act]').forEach(b=>b.onclick=()=>{box.hidden=true;$('octHit').setAttribute('aria-expanded','false');const a=b.dataset.act;
    if(say[a]){sendMsg(say[a]);octMood('work','交給它了！',2500)}
    else if(a==='new')newBotSheet();
    else if(a==='hide'){buddyStore('octa_buddy','0');buddySync();toast(I18N.t('小八先躲起來了，到設定可以叫他回來'))}})}
function buddyBoot(){
  const el=$('buddy');if(!el||el.dataset.ready)return;el.dataset.ready='1';
  const hit=$('octHit'),menu=$('octMenu');
  hit.onclick=e=>{e.stopPropagation();const open=menu.hidden;if(open)octMenu();menu.hidden=!open;hit.setAttribute('aria-expanded',String(open));if(open)octMood(el.dataset.mood==='sleep'?'hi':el.dataset.mood,'',1500)};
  document.addEventListener('click',e=>{if(!menu.hidden&&!e.target.closest('#octMenu,#octHit')){menu.hidden=true;hit.setAttribute('aria-expanded','false')}});
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!menu.hidden){menu.hidden=true;hit.setAttribute('aria-expanded','false');hit.focus()}});
  // his eyes follow the pointer while he's idle
  let raf=0;document.addEventListener('pointermove',e=>{if(raf||el.hidden)return;raf=requestAnimationFrame(()=>{raf=0;if(!['idle','listen','hi','ask'].includes(el.dataset.mood))return;
    const r=hit.getBoundingClientRect(),dx=e.clientX-(r.left+r.width/2),dy=e.clientY-(r.top+r.height*.45),d=Math.hypot(dx,dy)||1,k=Math.min(1.8,d/40);
    el.querySelectorAll('.pupil').forEach(p=>p.style.transform=`translate(${(dx/d*k).toFixed(2)}px,${(dy/d*k).toFixed(2)}px)`)})},{passive:true});
  $('msg').addEventListener('input',()=>{if(!el.hidden)buddySync()});
  setInterval(()=>{if(!el.hidden)buddySync()},6000)}
