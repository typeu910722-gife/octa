/* OCTA web app — 4.7: 任務總覽 (every bot and group on one page), 異常主動推播 on this device (一鍵重試),
   and the quota indicator in the sidebar footer (Claude 本週剩 62%). */
'use strict';
/* ---------- 任務總覽 ---------- */
const OV={data:null,filter:store.get('octa_ovf')||'all',sig:'',t:0,busy:false};
const ovOpen=()=>!!$('ovBody');
function openOverview(){
  $('veil').innerHTML=`<div class="sheet page ovw" role="dialog" aria-modal="true" aria-label="任務總覽"><div class="shd"><h2>任務總覽</h2><button type="button" class="ib" id="ovRe" aria-label="重新整理" title="重新整理">${ic('refresh')}</button><button type="button" class="ib x" data-close aria-label="關閉">${ic('x')}</button></div>
    <div class="ov-bar"><div class="seg" id="ovSeg" role="tablist" aria-label="篩選">${[['all','全部'],['bad','有問題的'],['today','今天']].map(([k,t])=>`<button type="button" role="tab" data-f="${k}" class="${OV.filter===k?'on':''}" aria-selected="${OV.filter===k}"><b>${t}</b><small data-u data-fn="${k}"></small></button>`).join('')}</div><div class="ov-sum" id="ovSum" role="status"></div></div>
    <div class="ov-body" id="ovBody"><div class="empty fade">載入中…</div></div></div>`;
  $('veil').hidden=false;paintIcons($('veil'));pageBack=null;
  $('ovSeg').onclick=e=>{const b=e.target.closest('[data-f]');if(!b)return;OV.filter=b.dataset.f;store.set('octa_ovf',OV.filter);
    $('ovSeg').querySelectorAll('[data-f]').forEach(x=>{x.classList.toggle('on',x===b);x.setAttribute('aria-selected',String(x===b))});paintOverview()};
  $('ovRe').onclick=()=>loadOverview(true);
  $('ovBody').onclick=ovClick;
  OV.sig='';loadOverview(true)}
async function loadOverview(force){if(!ovOpen()||OV.busy)return;OV.busy=true;
  try{const d=await api('overview');OV.data=d;OV.t=Date.now();if(ovOpen())paintOverview()}catch(e){if(ovOpen()&&!OV.data)setHTML($('ovBody'),`<div class="empty">${esc(e.message)}</div>`)}
  finally{OV.busy=false}}
// a card is "a problem" when something failed, it is logged out, a routine run failed, or it waits for your 核准
const ovBad=x=>!!(x.failed.length||x.alert||x.routineErr.length||apprWait(x.id));
const ovToday=x=>!!(x.doneN||x.failed.length||x.running.length||x.queued);
const ovWhen=t=>{if(!t)return '';const d=new Date(t),n=new Date(),tm=new Date(n);tm.setDate(n.getDate()+1);
  if(d.toDateString()===n.toDateString())return `<span data-u>${esc(hm(t))}</span>`;
  if(d.toDateString()===tm.toDateString())return `<span>明天</span> <span data-u>${esc(hm(t))}</span>`;
  return `<span data-u>${esc(when(t))}</span>`};
function ovStepHtml(p,paused){if(!p)return `<p class="ov-now"><span>剛開始，還沒有進度</span></p>`;
  const tot=+p.total||(Array.isArray(p.steps)?p.steps.length:0),step=Math.min(+p.step||0,tot||0);
  let h=`<p class="ov-now">${paused?'<i class="ov-tag warn">已暫停</i> ':''}<span data-u>${esc(String(p.text||'').slice(0,140))}</span></p>`;
  if(tot){h+=`<div class="ov-steps" role="progressbar" aria-valuemin="0" aria-valuemax="${tot}" aria-valuenow="${step}"><div class="ov-track"><i style="width:${Math.round(step/tot*100)}%"></i></div><small><b data-u>${step}/${tot}</b> <span>步</span></small></div>`;
    if(Array.isArray(p.steps)&&p.steps.length)h+=`<ol class="ov-sl">${p.steps.slice(0,8).map((s,i)=>`<li class="${i+1<step?'d':i+1===step?'c':''}" data-u>${esc(String(s).slice(0,40))}</li>`).join('')}</ol>`}
  return h}
function ovCard(x,g){
  const bad=ovBad(x),ap=apprWait(x.id),run=x.running.length,st=run?'run':x.queued?'queue':'idle';
  const av=g?`<span class="av grp" data-u>${gStack(x,true)}</span>`:`<span class="av" data-u>${avOf(x.id,true)}</span>`;
  const chip=x.alert?`<i class="ov-chip err">${esc(x.alert.label)}</i>`:ap?'<i class="ov-chip ap">待你核准</i>':run?'<i class="ov-chip run">工作中</i>':x.queued?'<i class="ov-chip">排隊中</i>':'<i class="ov-chip idle">待命</i>';
  let h=`<article class="ov-card${bad?' bad':''}" data-oc="${esc(x.id)}" data-st="${st}">
    <header class="ov-hd">${av}<div class="ov-who"><b data-u>${esc(x.name)}</b>${x.role?`<small data-u>${esc(x.role)}</small>`:`<small class="ov-norole">${g?'還沒有協作規則':'還沒有指定任務'}</small>`}</div>${chip}</header>`;
  if(x.alert)h+=`<div class="ov-alert" role="alert">${ic('info')}<span><b data-u>${esc(x.alert.label)}</b> <span data-u>${ovWhen(x.alert.at)}</span></span><button type="button" class="btn sm" data-retry="${x.alert.job}">${ic('refresh')}<span>一鍵重試</span></button></div>`;
  for(const r of x.running)h+=`<div class="ov-run">${g&&r.bot?`<small class="ov-by" data-u>${esc(nameOf(r.bot))}</small>`:''}<p class="ov-what" data-u>${esc(r.what)}</p>${ovStepHtml(r.progress,r.paused)}</div>`;
  if(x.queued)h+=`<p class="ov-q"><b data-u>${x.queued}</b> <span>件排隊中</span></p>`;
  // today
  h+=`<div class="ov-today"><div class="ov-k"><span class="ov-n ok"><b data-u>${x.doneN}</b> <span>今天完成</span></span>${x.failed.length?`<span class="ov-n err"><b data-u>${x.failed.length}</b> <span>沒做成</span></span>`:''}</div>`;
  if(x.failed.length)h+=`<ul class="ov-fl">${x.failed.map(f=>`<li><span class="ov-fx"><i class="ov-tag err" data-u>${esc(I18N.t(f.label))}</i> <span data-u>${esc(f.what)}</span>${g&&f.bot?` <small data-u>· ${esc(nameOf(f.bot))}</small>`:''}<small class="ov-tm">${ovWhen(f.at)}</small>${f.msg?`<small class="ov-msg" data-u>${esc(f.msg)}</small>`:''}</span><button type="button" class="ghost sm" data-retry="${f.id}">${ic('refresh')}<span>重試</span></button></li>`).join('')}</ul>`;
  if(x.done.length)h+=`<details class="ov-dl"><summary><span>今天做完的</span></summary><ul>${x.done.map(d=>`<li><span data-u>${esc(d.what)}</span><small class="ov-tm">${ovWhen(d.at)}</small></li>`).join('')}</ul></details>`;
  h+='</div>';
  // routines
  const rs=x.routines,re=x.routineErr;
  if(rs.length||re.length||x.events)h+=`<div class="ov-rt">${ic('clock')}<span>${rs.length?`<span>下次例行任務</span> ${rs.slice(0,2).map(r=>`<span class="ov-rn">${ovWhen(r.at)} <span data-u>${esc(r.name)}</span></span>`).join('')}`:x.events?'<span>例行任務由外部事件觸發</span>':''}${re.map(r=>` <i class="ov-tag err">上次沒跑成</i> <span data-u>${esc(r.name)}</span>`).join('')}</span></div>`;
  h+=`<footer class="ov-ft"><button type="button" class="ghost sm" data-open="${esc(x.id)}">${ic('reply')}<span>打開對話</span></button>${g?'':`<button type="button" class="ghost sm" data-mem="${esc(x.id)}">${ic('brain')}<span>它記得什麼</span></button>`}${ap?`<button type="button" class="btn sm" data-ask="${esc(x.id)}">${ic('check')}<span>去核准</span></button>`:''}</footer></article>`;
  return h}
function paintOverview(){const d=OV.data;if(!d||!ovOpen())return;
  const all=[...d.groups.map(x=>[x,true]),...d.bots.map(x=>[x,false])];
  const pass={all:()=>true,bad:([x])=>ovBad(x),today:([x])=>ovToday(x)};
  $('ovSeg').querySelectorAll('[data-fn]').forEach(s=>{const n=all.filter(pass[s.dataset.fn]).length;s.textContent=n?String(n):''});
  const run=d.bots.reduce((a,x)=>a+x.running.length,0),done=d.bots.reduce((a,x)=>a+x.doneN,0),fail=d.bots.reduce((a,x)=>a+x.failed.length,0),aps=apprConvs().length;
  setHTML($('ovSum'),`<span class="ov-s"><b data-u>${run}</b> <span>工作中</span></span><span class="ov-s"><b data-u>${done}</b> <span>今天完成</span></span><span class="ov-s${fail?' err':''}"><b data-u>${fail}</b> <span>沒做成</span></span>${aps?`<span class="ov-s ap"><b data-u>${aps}</b> <span>待你核准</span></span>`:''}`);
  const list=all.filter(pass[OV.filter]);
  // problems first, then working, then the rest (sidebar order)
  const rank=([x])=>ovBad(x)?0:x.running.length?1:x.queued?2:3;
  list.sort((a,b)=>rank(a)-rank(b));
  const sig=JSON.stringify([OV.filter,list.map(([x])=>x),apprConvs().map(x=>x.id),S.busy.map(b=>b.bot_id)]);
  if(sig===OV.sig)return;OV.sig=sig;
  const keep=$('ovBody').scrollTop,open=new Set([...$('ovBody').querySelectorAll('details[open]')].map(x=>x.closest('[data-oc]')?.dataset.oc));
  setHTML($('ovBody'),list.length?`<div class="ov-grid">${list.map(([x,g])=>ovCard(x,g)).join('')}</div>`:
    `<div class="empty ov-empty">${OV.filter==='bad'?'都很順利，沒有需要處理的事 ✓':OV.filter==='today'?'今天還沒有工作紀錄':'還沒有機器人。按右上角的 ＋ 建立一個。'}</div>`);
  $('ovBody').querySelectorAll('details.ov-dl').forEach(x=>{if(open.has(x.closest('[data-oc]')?.dataset.oc))x.open=true});
  $('ovBody').scrollTop=keep}
async function ovClick(e){
  const r=e.target.closest('[data-retry]');if(r){r.disabled=true;await oneRetry(+r.dataset.retry);loadOverview(true);return}
  const o=e.target.closest('[data-open]');if(o){closeSheet();openConv(o.dataset.open);return}
  const m=e.target.closest('[data-mem]');if(m){openMemory(m.dataset.mem,()=>openOverview());return}
  const a=e.target.closest('[data-ask]');if(a){closeSheet();goAsk(a.dataset.ask)}}
async function oneRetry(job){try{await api('alerts/retry','POST',{job});toast(I18N.t('已重新開始'));refresh();return true}catch(err){toast(err.message);return false}}
// live: progress and new results redraw the open page (one request, at most every 2 s)
let ovSeen='';
setInterval(()=>{if(!ovOpen())return;const k=S.rev+':'+S.prog;if(k!==ovSeen||Date.now()-OV.t>30000){ovSeen=k;loadOverview()}},2000);
$('ovBtn').onclick=()=>{if(typeof leaveOk==='function')leaveOk(openOverview);else openOverview()};

/* ---------- 異常主動推播 on this device: a notification, and a 一鍵重試 bar ---------- */
const AL={top:null,timer:0,rev:-2};
async function pollAlerts(){if(!ready())return;
  try{const first=AL.top===null;const d=await api('alerts?after='+(first?0:AL.top));
    let seen=+store.get('octa_alseen')||0;
    const fresh=d.alerts.filter(a=>a.id>seen&&a.pushed&&!a.retry).reverse();
    AL.top=Math.max(AL.top||0,d.top||0);
    // the badge on 任務總覽: alerts of the last day that nobody retried yet
    const open=d.alerts.filter(a=>!a.retry);if(first||fresh.length)ovBadge(first?open.length:(+$('ovBadge').dataset.n||0)+fresh.length);
    if(first&&!seen){store.set('octa_alseen',String(AL.top));return}   // a new device starts from now
    for(const a of fresh)showAlert(a);
    if(AL.top>seen)store.set('octa_alseen',String(AL.top))}catch(e){}}
function ovBadge(n){const b=$('ovBadge');b.dataset.n=String(n);b.hidden=!n;b.textContent=n>9?'9+':String(n||'')}
function showAlert(a){const b=bot(a.bot);if(!b)return;
  if(notiOn()&&'Notification' in window&&Notification.permission==='granted'&&(document.hidden||cur!==a.conv)){
    try{const n=new Notification('OCTA · '+b.name+' '+I18N.t(a.label),{body:I18N.t('點這裡打開，按「一鍵重試」'),icon:'/icon.png',tag:'octa-al-'+a.id,requireInteraction:true});
      n.onclick=()=>{window.focus();window.octaDesktop?.show?.();openConv(a.bot);retryBar(a);n.close()}}catch(e){}}
  if(!document.hidden)retryBar(a)}
// the bar: which bot, what happened, 一鍵重試 (and its browser, to sign in again)
function retryBar(a){const b=bot(a.bot);if(!b)return;$('alBar')?.remove();
  const el=document.createElement('div');el.id='alBar';el.className='al-bar';el.setAttribute('role','alert');
  el.innerHTML=`<span class="av sm" data-u>${avOf(a.bot)}</span><div class="al-t"><b><span data-u>${esc(b.name)}</span> <span>${esc(a.label||'沒有完成工作')}</span></b><small><span>按「一鍵重試」從頭再做一次</span>${/logout|not_logged_in/.test(a.kind||'')?'<span>；要先登入就先打開它的瀏覽器</span>':''}</small></div>
    <div class="al-act">${/logout|not_logged_in/.test(a.kind||'')?`<button type="button" class="ghost sm" data-al="web">${ic('globe')}<span>瀏覽器</span></button>`:''}<button type="button" class="btn sm" data-al="retry">${ic('refresh')}<span>一鍵重試</span></button><button type="button" class="ib sm" data-al="x" aria-label="關閉">${ic('x')}</button></div>`;
  document.body.appendChild(el);
  el.onclick=async e=>{const k=e.target.closest('[data-al]')?.dataset.al;if(!k)return;
    if(k==='x'){el.remove();return}
    if(k==='web'){if(cur!==a.bot)openConv(a.bot);if(typeof goWeb==='function')goWeb(a.bot,a.bot);return}
    e.target.closest('button').disabled=true;if(await oneRetry(a.job))el.remove();else e.target.closest('button').disabled=false}}
// …#web=<bot>&retry=<job>: the 一鍵重試 link in a Telegram / LINE alert (through the phone's /go page) — shows the bar
function retryDeepLink(){let job='',web='';try{job=sessionStorage.getItem('octa_goretry')||'';web=sessionStorage.getItem('octa_goretryb')||'';sessionStorage.removeItem('octa_goretry');sessionStorage.removeItem('octa_goretryb')}catch(e){}
  if(!job||!bot(web))return;if(cur!==web)openConv(web);retryBar({bot:web,job:+job,kind:'',label:'沒有完成工作'});
  api('alerts').then(d=>{const a=(d.alerts||[]).find(x=>x.job===+job&&x.bot===web);if(a&&$('alBar'))retryBar(a)}).catch(()=>{})}   // what happened, when the alert is still there
setInterval(()=>{if(!ready())return;if(AL.rev===-2)retryDeepLink();if(S.rev!==AL.rev){AL.rev=S.rev;pollAlerts()}},1500);

/* ---------- 額度看得到: Claude 本週剩 62% in the sidebar footer ---------- */
const QW_LAB={'7d':'本週剩','5h':'5 小時內剩','30d':'本月剩'};
let quotaT=0;
async function paintQuota(){const q=$('quota');if(!q||!ready())return;
  quotaT=Date.now();let u=null;try{u=await api('ai-usage')}catch(e){return}
  const used=new Set(S.bots.map(b=>b.engine||'claude'));
  let best=null;
  for(const [k,v] of Object.entries(u.usage||{})){if(!v?.windows?.length||(used.size&&!used.has(k)))continue;
    for(const w of v.windows){if(!QW_LAB[w.k])continue;const left=Math.max(0,Math.min(100,Math.round(100-(+w.used||0))));
      // the window that runs out first; on a tie, the longer one (本週) is what people plan with
      if(!best||left<best.left||(left===best.left&&w.k==='7d'))best={k,w,left,plan:v.plan}}}
  if(!best){q.hidden=true;return}
  const name=(typeof ENG!=='undefined'&&ENG[best.k]?.n)||best.k;
  q.hidden=false;q.className='quota'+(best.left<=10?' err':best.left<=25?' warn':'');
  q.title=Object.entries(u.usage||{}).filter(([,v])=>v?.windows?.length).map(([k,v])=>((typeof ENG!=='undefined'&&ENG[k]?.n)||k)+'：'+v.windows.map(w=>I18N.t(QW_LAB[w.k]||w.k)+' '+Math.round(100-(+w.used||0))+'%').join('、')).join('\n');
  setHTML(q,`<span class="qbar" aria-hidden="true"><i style="width:${best.left}%"></i></span><span class="qtx"><span data-u>${esc(name)}</span> <span>${QW_LAB[best.w.k]}</span> <b data-u>${best.left}%</b></span>`);
  q.setAttribute('aria-label',name+' '+I18N.t(QW_LAB[best.w.k])+' '+best.left+'%')}
$('quota').onclick=()=>openSettings('ai');
setInterval(()=>{if(ready()&&!document.hidden&&Date.now()-quotaT>5*60000)paintQuota()},3000);
