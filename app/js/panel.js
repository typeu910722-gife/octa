/* OCTA web app — the work panel on the right, like Claude's side panel: 工作 · 瀏覽器 · 詳細資料.
   The chat only holds the conversation; what a bot is doing (progress, steps, 停止, the queue), what it did in the
   background (asking or handing work to other bots, routine runs, failures, retries, system notes) and its browser live here.
   Folded or open is remembered on this device; on a phone it is a full page opened from the header. */
'use strict';
const WP_TABS=['work','web','info'];
const WP={tab:WP_TABS.includes(store.get('octa_wpt'))?store.get('octa_wpt'):'work',open:store.get('octa_wp')!=='0',sheet:false,
  steps:{},logs:{},logKey:{},logBusy:{},seen:{},webBot:{},ran:{},keep:new Set(),dock:null};
try{WP.seen=JSON.parse(store.get('octa_wseen')||'{}')}catch(e){}
const wpWide=()=>innerWidth>1180;
if(!wpWide()&&!phoneUI())WP.open=false;   // a medium window starts with it folded: it would cover the chat
const panelOn=()=>!!(cur&&conv(cur))&&!$('app').hidden&&(phoneUI()?WP.sheet:WP.open);
const detailOpen=()=>panelOn()&&WP.tab==='info';

/* ---------- open, fold, tabs ---------- */
// leaving 詳細資料 with unsaved changes asks first
function leaveInfo(then){if(WP.tab==='info'&&isDirty()&&$('detail').contains(DIRTY.el)){leaveOk(then);return false}
  if(DIRTY.el&&$('detail').contains(DIRTY.el))DIRTY.el=null;return true}
function openPanel(tab,o={}){if(!cur||!conv(cur))return;
  if(tab&&tab!==WP.tab){if(!leaveInfo(()=>openPanel(tab,o)))return;if(WP.tab==='info'){$('detail').innerHTML='';DP.id=null}WP.tab=tab;store.set('octa_wpt',tab)}
  if(phoneUI()){if(!WP.sheet){WP.sheet=true;navPush('detail')}}
  else{WP.open=true;store.set('octa_wp','1')}
  renderPanel(true);
  if(o.user&&!phoneUI())$('wp').querySelector('[role=tab][aria-selected=true]')?.focus({preventScroll:true})}
function closePanel(fromHistory){
  if(!leaveInfo(()=>closePanel(fromHistory))){if(fromHistory&&phoneUI())navPush('detail');return}
  if(phoneUI()){if(!WP.sheet)return;WP.sheet=false;if(!fromHistory)navPop('detail')}
  else{WP.open=false;store.set('octa_wp','0')}
  $('detail').innerHTML='';DP.id=null;rtEdit=null;renderPanel()}
const togglePanel=()=>panelOn()?closePanel():openPanel(null,{user:true});
function openDetail(){openPanel('info',{user:true})}
function closeDetail(fromHistory){closePanel(fromHistory)}
function toggleDetail(){detailOpen()?closePanel():openDetail()}
function setTab(t){if(!WP_TABS.includes(t)||t===WP.tab)return;openPanel(t)}
// another chat was opened: same tab, its content
function panelConv(){WP.ran={};if(panelOn())renderPanel(true);else paintBadge()}
$('panelBtn').onclick=()=>togglePanel();
$('browser').onclick=e=>{e.stopPropagation();if(detailOpen()||!panelOn()||WP.tab!=='web')openPanel('web',{user:true});else closePanel()};
$('wp').addEventListener('click',e=>{
  const t=e.target.closest('[data-wt]');if(t){setTab(t.dataset.wt);return}
  if(e.target.closest('[data-wclose]')){closePanel();return}});
$('wp').querySelector('.wp-tabs').addEventListener('keydown',e=>{const k={ArrowRight:1,ArrowLeft:-1}[e.key];if(!k)return;e.preventDefault();
  const i=WP_TABS.indexOf(WP.tab),n=WP_TABS[(i+k+WP_TABS.length)%WP_TABS.length];setTab(n);$('wp').querySelector(`[data-wt="${n}"]`)?.focus()});

/* ---------- drawing ---------- */
function renderPanel(force){
  const on=panelOn(),app=$('app');
  $('wp').hidden=!on;app.classList.toggle('wp-on',on);app.classList.toggle('wp-web',on&&WP.tab==='web');
  $('panelBtn').setAttribute('aria-expanded',String(on));$('panelBtn').setAttribute('aria-pressed',String(on));
  $('browser').setAttribute('aria-pressed',String(on&&WP.tab==='web'));
  trackJobs();
  if(on){
    $('wp').querySelectorAll('[role=tab]').forEach(b=>{const s=b.dataset.wt===WP.tab;b.setAttribute('aria-selected',String(s));b.tabIndex=s?0:-1;b.classList.toggle('on',s)});
    $('wpWork').hidden=WP.tab!=='work';$('wpWeb').hidden=WP.tab!=='web';$('detail').hidden=WP.tab!=='info';
    if(WP.tab==='work')paintWork();else if(WP.tab==='web')paintWeb(force);else infoSync()}
  paintBadge();dockSync()}
function infoSync(){const box=$('detail');
  if(DP.id!==cur||!box.firstChild){if(DP.id&&DP.id!==cur&&isDirty()&&box.contains(DIRTY.el)){leaveOk(()=>{DP.id=null;infoSync()});return}paintDetail(true);return}
  detailLive()}

/* the progress lines a job reported, kept on this device so the panel can list its steps; and when it started */
function trackJobs(){const now=Date.now(),live=new Set();
  for(const x of S.busy||[]){if(x.status!=='running'||!x.job)continue;live.add(x.job);const st=WP.steps[x.job]||(WP.steps[x.job]=[]),p=progOf(x.progress).text;
    if(p&&(!st.length||st[st.length-1].p!==p))st.push({p,t:now});if(st.length>40)st.splice(0,st.length-40)}
  for(const k of Object.keys(WP.steps))if(!live.has(+k))delete WP.steps[k];
  // a job just started here while the panel shows 詳細資料 (and nothing is being edited): show 工作 instead
  const runs=busyIn(cur||'').filter(x=>x.status==='running').map(x=>x.job).join(',');
  if(cur&&WP.ran[cur]!==undefined&&runs&&runs!==WP.ran[cur]&&panelOn()&&WP.tab==='info'&&!isDirty()&&!$('detail').contains(document.activeElement)){WP.tab='work';store.set('octa_wpt','work');$('detail').innerHTML='';DP.id=null;queueMicrotask(()=>renderPanel())}
  if(cur)WP.ran[cur]=runs}

/* ---------- 工作 ---------- */
// this chat's work history (jobs it ran), refreshed when something changes while the tab is open
function loadLogs(id){const k=S.rev+':'+busyIn(id).length;if(WP.logKey[id]===k||WP.logBusy[id])return;WP.logBusy[id]=true;
  api('logs?conv='+encodeURIComponent(id)).then(d=>{WP.logs[id]=d.logs||[];WP.logKey[id]=k;WP.logBusy[id]=false;if(cur===id&&panelOn()&&WP.tab==='work')paintWork()}).catch(()=>{WP.logBusy[id]=false;WP.logKey[id]=k})}
const SYSK=t=>/^🔁/.test(t)?'bg':/^🗜/.test(t)?'note':/^⚡/.test(t)?'event':/^⚠/.test(t)?'warn':/例行任務|排程|待命/.test(t)?'routine':/^已記住|^已存成|^已記下|指定任務|取名/.test(t)?'mem':'sys';
// everything for the timeline, newest first: notes, failures, background requests, finished jobs
function workItems(id){const out=[],bs=BS[id],keys=bgKeysFor(id),since=Date.now()-13*864e5;
  const ms=convMsgs(id).filter(m=>!m.tmp&&msgPlace(m,keys)==='work');
  const bgIds=new Set((bs?.items||[]).map(x=>x.id));
  for(const m of ms){const t=String(m.text||'');
    if(bs?.ok&&m.by==='sys'&&/^🔁/.test(t)&&m.ts>since)continue;   // the 幕後 entry says the same, with the answer
    if(m.kind==='bg'&&keys?.has(bgKey(m.by,m.text)))continue;   // its answer is shown under that entry
    out.push({t:m.ts,k:m.kind==='fail'?'fail':m.kind==='bg'?'bg':m.kind==='note'?'note':SYSK(t),m,key:'m'+m.id})}
  for(const x of bs?.items||[])out.push({t:x.created,k:'ask',x,key:'b'+x.id});
  const inCollab=new Set(collabTop(id).map(x=>x.id));   // 4.7: the newest ones have their own section (同事協作)
  for(let i=out.length-1;i>=0;i--)if(out[i].k==='ask'&&inCollab.has(out[i].x.id))out.splice(i,1);
  for(const j of WP.logs[id]||[]){if(j.status==='pending'||j.status==='running'||bgIds.has(j.id)||j.kind==='open')continue;
    const at=j.finished||j.created;
    if(j.status==='error'&&ms.some(m=>(m.kind==='fail'||/^⚠/.test(m.text||''))&&Math.abs(m.ts-at)<180000))continue;   // the failure note says it better
    out.push({t:at,k:j.status==='error'?'jobfail':'job',j,key:'j'+j.id})}
  return out.sort((a,b)=>b.t-a.t)}
const WI={fail:['x','err','沒有完成'],jobfail:['x','err','失敗'],warn:['info','warn','注意'],job:['check','ok','完成'],bg:['users','bg','幕後'],ask:['users','bg','幕後'],
  note:['note','','紀錄'],event:['zap','','事件'],routine:['clock','','例行任務'],mem:['brain','','記住'],sys:['info','','系統']};
const durTxt=ms=>ms==null?'':ms<60000?Math.max(1,Math.round(ms/1000))+' '+I18N.t('秒'):Math.round(ms/60000)+' '+I18N.t('分鐘');
// one entry: an icon, what happened, the details folded when long
function wiHtml(it){const [icon,tone,lab]=WI[it.k]||WI.sys,open=WP.keep.has(it.key);let title='',body='',more='',acts='';
  if(it.m){const t=String(it.m.text||'').replace(/^⚠\s*/,'');
    title=it.m.by==='sys'?I18N.t(lab):`<span data-u>${esc(nameOf(it.m.by))}</span> · <span>${I18N.t(lab)}</span>`;
    const first=t.split('\n')[0];body=first.length>140?first.slice(0,138)+'…':first;if(t.length>body.length)more=t;
    if(it.k==='fail'&&!busyIn(cur).length)acts=`<button type="button" class="ghost sm" data-wretry="${it.m.id}">${ic('refresh')}<span>重試</span></button>`}
  else if(it.x){const x=it.x,st=x.status==='pending'?'排隊中':x.status==='running'?'進行中':x.status==='error'?'沒有完成':'';
    title=`<span data-u>${esc(nameOf(x.from))}</span> → <span data-u>${esc(nameOf(x.to))}</span> · <span>${x.kind==='give'?'交辦':'詢問'}</span>${st?` · <span>${st}</span>`:''}${x.ms!=null&&!st?` · <span>${durTxt(x.ms)}</span>`:''}`;
    body=x.what||'';if(x.reply)more='↳ '+x.reply}
  else if(it.j){const j=it.j,d=j.finished&&j.started?j.finished-j.started:null;
    title=`<span>${I18N.t(lab)}</span>${d!=null?` · <span>${durTxt(d)}</span>`:''}${j.routine?' · <span>例行任務</span>':''}${j.conv!==cur&&j.convName?` · <span data-u>${esc(j.convName)}</span>`:''}`;
    body=j.prompt||'';if(j.status==='error'&&j.err_msg)more=j.err_msg;
    if(j.status==='error'&&!j.retried)acts=`<button type="button" class="ghost sm" data-wlretry="${j.id}">${ic('refresh')}<span>重試</span></button>`}
  const bodyHtml=more?`<details class="wmore" data-wk="${esc(it.key)}"${open?' open':''}><summary data-u>${esc(body||more.slice(0,120))}</summary><div class="wfull" data-u>${esc(more)}</div></details>`:`<div class="wtx" data-u>${esc(body)}</div>`;
  return `<li class="wi ${tone}"><span class="wic" aria-hidden="true">${ic(icon)}</span><div class="wb"><div class="wtt">${title}<time>${hm(it.t)}</time></div>${body||more?bodyHtml:''}${acts?`<div class="wact">${acts}</div>`:''}</div></li>`}
// what is running now: its face, what it is doing, how long, its last steps, 停止
// 4.7: the bot's own step list (done ✓ / now / next) with 「步驟 2/5」 and a bar; an older runner: the lines it reported
function curCard(x){const st=stateOf(x.bot_id),steps=(WP.steps[x.job]||[]).slice(-5),c=conv(cur),v=progView(x.progress),ps=pauseOf(x);
  const eng=x.eng&&!isG(cur)&&x.eng.split('|')[0]!==(c?.engine||'claude')?` · <span>備援</span> ${esc(ENG_NAME(x.eng.split('|')[0]))}`:'';
  const plan=v.list.length?`<ol class="wsteps plan">${v.list.map((s,i)=>`<li class="${s.st}">${s.st==='done'?`<span class="wck" aria-hidden="true">${ic('check')}</span>`:`<span class="wn" aria-hidden="true">${i+1}</span>`}<span data-u>${esc(s.t)}</span>${s.st==='now'&&v.text&&v.text!==s.t?`<small data-u>${esc(v.text)}</small>`:''}</li>`).join('')}</ol>`
    :steps.length?`<ol class="wsteps">${steps.map((s,i)=>`<li${i===steps.length-1?' class="now"':''}><span data-u>${esc(s.p)}</span></li>`).join('')}</ol>`:`<p class="wsub">${I18N.t('準備中…')}</p>`;
  const head=v.has||ps?`<div class="wprog"><div class="jl">${progLine(x)}</div>${progBar(x)}</div>`:'';
  return `<div class="wcur${ps?' '+ps:''}"><div class="wch"><span class="av" data-u>${avOf(x.bot_id,'always')}</span><div class="t"><b data-u>${esc(nameOf(x.bot_id))}</b>
    <small><span class="pst">${ps==='paused'?I18N.t('已暫停'):x.kind==='open'?I18N.t('打開瀏覽器'):x.kind==='code'?I18N.t('程式任務'):I18N.t(STATE_LABEL[st]||'工作中')}</span>${x.started?` · <span class="el" data-since="${x.started}">${elapsed(x.started)}</span>`:''}${eng}</small></div>
    <div class="wbtns">${x.kind==='open'?'':pauseBtn(x).replace('class="jb"','class="ghost sm jb"')}<button type="button" class="ghost sm" data-wstop>${ic('stop')}<span>停止</span></button></div></div>
    ${head}${plan}
    ${ps==='pausing'?`<p class="wnote">${I18N.t('它會做完目前這一步再暫停。')}</p>`:''}
    ${st==='browsing'&&WP.tab!=='web'?`<button type="button" class="link" data-wt="web">${ic('globe')}<span>在瀏覽器分頁看它操作</span></button>`:''}</div>`}
/* 同事協作: who asked whom, what, waiting / answered / failed, and how long; an open one waiting > 2 minutes stands out */
const collabTop=id=>collabItems(BS[id]?.items).sort((a,b)=>(b.st==='wait'||b.st==='run')-(a.st==='wait'||a.st==='run')||b.at-a.at).slice(0,8);
function collabHtml(id){const xs=collabTop(id);if(!xs.length)return '';
  const ST={wait:['排隊中','wait'],run:['回覆中','run'],ok:['已回覆','ok'],fail:['沒有完成','fail']};
  return `<div class="wsec"><div class="wsh">${ic('users')}<span>同事協作</span></div><ol class="cl">${xs.map(x=>{const [lab,cls]=ST[x.st],open=x.st==='wait'||x.st==='run',stuck=open&&x.dur>120000,k='c'+x.id,kp=WP.keep.has(k);
    const dur=stuck?`<span class="cld stuck"><span>在等</span> <b data-u>${esc(nameOf(x.to))}</b> <span>回覆，已等</span> <span data-wsince="${x.at}">${minTxt(x.at)}</span> <span>分鐘</span></span>`
      :open?`<span class="cld"><span>已等</span> ${durTxt(x.dur)}</span>`:x.dur!=null?`<span class="cld"><span>花了</span> ${durTxt(x.dur)}</span>`:'';
    return `<li class="ci ${cls}${stuck?' stuck':''}"><div class="cwho"><span class="av xs" data-u>${avOf(x.from)}</span><span data-u>${esc(nameOf(x.from))}</span><span class="car" aria-hidden="true">→</span><span class="av xs" data-u>${avOf(x.to,open)}</span><span data-u>${esc(nameOf(x.to))}</span><span class="ck">${x.kind==='give'?'交辦':'詢問'}</span><time>${hm(x.at)}</time></div>
      <div class="cwhat" data-u>${esc(x.what||'')}</div>
      <div class="cst"><span class="cpill ${cls}">${lab}</span>${dur}</div>
      ${x.reply?`<details class="wmore" data-wk="${k}"${kp?' open':''}><summary data-u>↳ ${esc(x.reply.replace(/\s+/g,' ').slice(0,120))}</summary><div class="wfull" data-u>${esc(x.reply)}</div></details>`:''}</li>`}).join('')}</ol></div>`}
function routinesHtml(id){const rs=S.routines.filter(r=>r.conv===id&&r.name!=='外部交接');if(!rs.length)return '';
  return `<div class="wsec"><div class="wsh">${ic('clock')}<span>例行任務</span></div><div class="wrts">${rs.map(r=>{const s=rtStatus(r);
    return `<button type="button" class="wrt${r.enabled?'':' off'}" data-wt="info"><b data-u>${esc(r.name)}</b><small>${!r.enabled?I18N.t('已暫停'):s.next?`<span>下次</span> ${when(s.next)}`:''}${s.last?` · <span>上次</span> ${when(s.last)} ${s.st==='err'?`<i class="bad">${I18N.t('失敗')}</i>`:s.st==='ok'?`<i class="good">${I18N.t('完成')}</i>`:''}`:''}</small></button>`}).join('')}</div></div>`}
function paintWork(){const id=cur,c=conv(id);if(!c)return;loadLogs(id);loadBack(id);
  const bz=busyIn(id),run=bz.filter(x=>x.status==='running'),q=bz.filter(x=>x.status==='pending');
  let h='';
  if(run.length)h+=run.map(curCard).join('');
  else h+=`<div class="wcur idle"><div class="wch"><span class="av" data-u>${isG(id)?gStack(c):avOf(id,'always')}</span><div class="t"><b>${I18N.t('目前沒有工作')}</b><small>${I18N.t(S.runnerOnline?'交代的事、背景工作和例行任務都會出現在這裡':'電腦上的 OCTA 沒有在執行，訊息會先排著')}</small></div></div></div>`;
  if(q.length)h+=`<div class="wq">${ic('clock')}<span><span>排隊中</span> ${q.length} <span>件</span>：<span data-u>${esc([...new Set(q.map(x=>nameOf(x.bot_id)))].join('、'))}</span></span></div>`;
  h+=collabHtml(id);
  h+=routinesHtml(id);
  const items=workItems(id);let day='';
  h+=`<div class="wsec"><div class="wsh">${ic('list')}<span>紀錄</span></div>`+(items.length?'<ol class="tl">'+items.slice(0,80).map(it=>{const d=dayLabel(it.t);const sep=d!==day?`<li class="wday">${esc(day=d)}</li>`:'';return sep+wiHtml(it)}).join('')+'</ol>'
    :`<p class="wempty">${I18N.t('還沒有紀錄。它在背景問其他機器人、例行任務的執行、失敗和重試，都會記在這裡，不會塞進對話。')}</p>`)+'</div>';
  if(setHTML($('wpWork'),h))paintIcons($('wpWork'));
  // seen: the toggle's dot goes away
  const top=items[0]?.t||0;if(top>(WP.seen[id]||0)){WP.seen[id]=top;store.set('octa_wseen',JSON.stringify(WP.seen))}}
$('wpWork').addEventListener('toggle',e=>{const d=e.target;if(d.dataset?.wk)d.open?WP.keep.add(d.dataset.wk):WP.keep.delete(d.dataset.wk)},true);
$('wpWork').addEventListener('click',e=>{const t=e.target;
  if(t.closest('[data-wstop]')){t.closest('[data-wstop]').disabled=true;api('cancel','POST',{conv:cur}).then(()=>{toast(I18N.t('已停止'));refresh()}).catch(err=>toast(err.message));return}
  const jp=t.closest('[data-jpause]');if(jp){jobPause(+jp.dataset.jpause,jp.dataset.on==='1',jp);return}
  const r=t.closest('[data-wretry]');if(r){retryFrom(r.dataset.wretry,r);return}
  const lr=t.closest('[data-wlretry]');if(lr){lr.disabled=true;api('logs/retry','POST',{id:+lr.dataset.wlretry}).then(()=>{toast(I18N.t('已重新排入，會照原本的指示再做一次'));refresh()}).catch(err=>{lr.disabled=false;toast(err.message)});return}});
// 重試: your last instruction before the failure, sent again
function retryFrom(mid,btn){const ms=convMsgs(cur),i=ms.findIndex(x=>String(x.id)===String(mid));
  const last=ms.slice(0,i<0?ms.length:i).reverse().find(x=>x.by==='me');if(!last){toast(I18N.t('找不到上一則指示'));return}
  if(btn)btn.disabled=true;sendMsg(last.text==='（附件）'?'':last.text,(last.files||[]).map(f=>f.id),last.files||[])}

/* ---------- the toggle's dot when folded, and the tabs' dots ---------- */
function newestWork(id){let t=0;for(const m of convMsgs(id))if(!m.tmp&&m.ts>t&&msgPlace(m,bgKeysFor(id))==='work')t=m.ts;return t}
function paintBadge(){const b=$('wpBadge');if(!b)return;const id=cur;if(!id||!conv(id)){b.hidden=true;return}
  const run=busyIn(id).some(x=>x.status==='running'),seen=WP.seen[id];
  if(seen==null&&MSG[id]?.loaded){WP.seen[id]=newestWork(id);store.set('octa_wseen',JSON.stringify(WP.seen))}   // first look: the old history is not news
  const fresh=newestWork(id)>(WP.seen[id]||0),fail=fresh&&!!lastFail(id);
  const on=panelOn(),workShown=on&&WP.tab==='work';
  const kind=workShown?'':fail?'err':run?'run':fresh?'new':'';
  b.hidden=on||!kind;b.className='wbadge'+(kind?' '+kind:'');
  const td=$('wtWork')?.querySelector('.tdot');if(td){td.hidden=!on||workShown||!kind;td.className='tdot'+(kind?' '+kind:'')}
  const ids=isG(id)?conv(id).members:[id],browsing=ids.some(x=>stateOf(x)==='browsing');
  const wd=$('wtWeb')?.querySelector('.tdot');if(wd){wd.hidden=!on||WP.tab==='web'||!browsing;wd.className='tdot run'}}

/* ---------- a job that did not finish: one quiet line above the message box (the details are in 工作) ---------- */
function lastFail(id){const ms=convMsgs(id),keys=bgKeysFor(id);
  for(let i=ms.length-1;i>=0;i--){const m=ms[i];if(m.tmp)continue;
    if(m.kind==='fail')return m;
    if(m.by==='me'||(m.by!=='sys'&&msgPlace(m,keys)==='chat'))return null}
  return null}
function paintFail(c){const bar=$('failbar'),f=lastFail(c.id);
  if(!f||store.get('octa_failx_'+c.id)===String(f.id)||busyIn(c.id).length){bar.hidden=true;return}
  const why=String(f.text||'').replace(/^⚠\s*/,'').split('\n')[0];
  bar.hidden=false;
  if(setHTML(bar,`<span class="fic" aria-hidden="true">${ic('info')}</span><span class="ft"><b>${I18N.t('上次的工作沒有完成')}</b> <span data-u>${esc(why.length>70?why.slice(0,68)+'…':why)}</span></span>
    <button type="button" class="ghost sm" data-fail="see">查看</button><button type="button" class="btn sm" data-fail="retry">${ic('refresh')}<span>重試</span></button><button type="button" class="ib sm" data-fail="x" aria-label="${esc(I18N.t('知道了'))}">${ic('x')}</button>`))paintIcons(bar);
  bar.dataset.mid=f.id}
$('failbar').onclick=e=>{const b=e.target.closest('[data-fail]');if(!b||!cur)return;const k=b.dataset.fail,mid=$('failbar').dataset.mid;
  if(k==='see')openPanel('work',{user:true});
  else if(k==='retry'){store.set('octa_failx_'+cur,mid);retryFrom(mid,b)}
  else{store.set('octa_failx_'+cur,mid);$('failbar').hidden=true}};

/* ---------- 瀏覽器: the computer shows the bot's real browser right here; a phone sees its live picture ---------- */
function webIds(){const c=conv(cur);if(!c)return [];return isG(cur)?c.members.filter(bot):[cur]}
function webBot(){const ids=webIds();let id=WP.webBot[cur];if(!ids.includes(id)){id=ids.find(x=>stateOf(x)==='browsing')||ids[0]||'';WP.webBot[cur]=id}return id}
const embedHere=()=>!!window.octaDesktop?.dock&&!CFG.via;   // a remote control (4.3) watches the host's browser like a phone does
function paintWeb(force){const ids=webIds(),id=webBot(),b=bot(id);
  setHTML($('webHd'),ids.length>1?`<div class="wbots" role="radiogroup" aria-label="${esc(I18N.t('看誰的瀏覽器'))}">${ids.map(x=>`<button type="button" class="wbot${x===id?' on':''}" role="radio" aria-checked="${x===id}" data-wbot="${esc(x)}"><span class="av xs" data-u>${avOf(x,true)}</span><span data-u>${esc(bot(x).name)}</span></button>`).join('')}</div>`:'');
  if(!b){$('webPh').innerHTML=`<p class="wempty">${I18N.t('群組裡還沒有機器人')}</p>`;$('stage').hidden=true;setHTML($('webFt'),'');return}
  const mine=b.browser==='mine',st=stateOf(id),live=embedHere()&&!mine;
  $('wpWeb').classList.toggle('docked',live);
  setHTML($('webPh'),mine?`<div class="wph"><span class="av xl" data-u>${avOf(id,'always')}</span><b>${I18N.t('使用你的 Chrome')}</b><p class="hmuted">${I18N.t('這個機器人使用你的 Chrome，直接在你的 Chrome 裡查看它的分頁群組即可。')}</p></div>`
    :`<div class="wph"><span class="av xl" data-u>${avOf(id,'always')}</span><b>${I18N.t(st==='browsing'?(live?'正在打開瀏覽器…':'它正在用瀏覽器'):'瀏覽器還沒打開')}</b><p class="hmuted">${I18N.t(live?'機器人用瀏覽器時，畫面會出現在這裡。你可以看著它操作，也可以取得控制權自己登入。':'機器人在電腦上用瀏覽器時，這裡會顯示即時畫面。')}</p>
      <button type="button" class="btn sm" data-wopen="${esc(id)}">${ic('globe')}<span>${I18N.t(live?'打開瀏覽器':'在電腦上打開瀏覽器')}</span></button>${b.shot_ts?`<button type="button" class="link" data-wshots>${ic('image')}<span>歷史畫面</span></button>`:''}</div>`);
  paintIcons($('webPh'));
  setHTML($('webFt'),mine?'':live?`<button type="button" class="ghost sm" data-whide="${esc(id)}">${ic('hide')}<span>收到背景</span></button><button type="button" class="ghost sm" data-wurl="${esc(id)}">${ic('link')}<span>讓它打開網址…</span></button><button type="button" class="ghost sm" data-wshots>${ic('image')}<span>歷史畫面</span></button>`
    :`<form class="wurl" id="wurlf"><input id="wurlIn" inputmode="url" autocomplete="url" placeholder="${esc(I18N.t('不填就打開 Google'))}" aria-label="${esc(I18N.t('要打開的網址'))}"><button class="btn sm">${I18N.t('在電腦上打開')}</button></form><button type="button" class="ghost sm" data-wshots>${ic('image')}<span>歷史畫面</span></button>`);
  paintIcons($('webFt'));
  if(!live&&!mine){scrSync();if(!SCR.run||SCR.none){pollLive.force=force||pollLive.force;pollLive()}}else{$('stage').hidden=true;scrSync()}}
$('wpWeb').addEventListener('click',e=>{const t=e.target;
  const wb=t.closest('[data-wbot]');if(wb){WP.webBot[cur]=wb.dataset.wbot;pollLive.ts=0;$('stage').hidden=true;renderPanel(true);return}
  const o=t.closest('[data-wopen]');if(o){o.disabled=true;openBrowser(o.dataset.wopen).finally(()=>{o.disabled=false});return}
  const h=t.closest('[data-whide]');if(h){openBrowser(h.dataset.whide,'',true);return}
  const u=t.closest('[data-wurl]');if(u){urlSheet(u.dataset.wurl);return}
  if(t.closest('[data-wshots]')){shotSheet(webIds());return}});
$('wpWeb').addEventListener('submit',e=>{if(e.target.id!=='wurlf')return;e.preventDefault();const id=webBot();if(id)openBrowser(id,$('wurlIn').value.trim())});

/* the computer: tell the desktop app where the 瀏覽器 tab is, so the bot's real browser sits exactly there.
   null hides it (folded, another tab, the phone layout, a dialog on top) */
let dockSent='',dockRaf=0;
function dockSync(){if(!embedHere())return;if(dockRaf)return;dockRaf=requestAnimationFrame(()=>{dockRaf=0;
  let rect=null,id='';
  if(panelOn()&&WP.tab==='web'&&!phoneUI()&&$('veil').hidden){id=webBot();const b=bot(id);
    if(b&&b.browser!=='mine'){const r=$('webStage').getBoundingClientRect();if(r.width>=120&&r.height>=120)rect={x:Math.round(r.left),y:Math.round(r.top),width:Math.round(r.width),height:Math.round(r.height)}}}
  WP.dock=rect;const k=JSON.stringify([rect,rect?id:'',currentTheme()]);if(k===dockSent)return;dockSent=k;
  window.octaDesktop.dock(rect?{...rect,bot:id,theme:currentTheme()}:null)?.catch?.(()=>{})})}
if(window.ResizeObserver){const ro=new ResizeObserver(()=>dockSync());ro.observe($('webStage'));ro.observe($('wp'))}
addEventListener('resize',()=>{dockSync();if(!phoneUI()&&WP.sheet){WP.sheet=false}renderPanel()});
new MutationObserver(()=>dockSync()).observe($('veil'),{attributes:true,attributeFilter:['hidden']});
// the bot's browser came up on the computer (it started browsing, or you took control): its tab gets a dot
window.octaDesktop?.onStage?.(d=>{if(d?.act==='shown'&&d.bot&&cur&&webIds().includes(d.bot))paintBadge()});

/* ---------- width: drag the panel's left edge (remembered on this device; the browser tab has its own) ---------- */
(()=>{const g=$('wpGrip'),app=$('app');
  const key=()=>WP.tab==='web'?'octa_wpw_web':'octa_wpw',vr=()=>WP.tab==='web'?'--wpw-web':'--wpw';
  const set=(w,save)=>{const max=Math.max(340,innerWidth-(app.classList.contains('rail-collapsed')?0:parseInt(getComputedStyle(app).getPropertyValue('--side-w'))||288)-420);
    w=Math.round(Math.min(max,Math.max(320,w)));app.style.setProperty(vr(),w+'px');if(save)store.set(key(),String(w));dockSync()};
  for(const [k,v] of [['octa_wpw','--wpw'],['octa_wpw_web','--wpw-web']]){const n=+store.get(k);if(n>=320)app.style.setProperty(v,n+'px')}
  let x0=0,w0=0,on=false;
  g.addEventListener('pointerdown',e=>{if(phoneUI()||e.button!==0)return;on=true;x0=e.clientX;w0=$('wp').offsetWidth;g.setPointerCapture(e.pointerId);app.classList.add('wp-drag');e.preventDefault()});
  g.addEventListener('pointermove',e=>{if(on)set(w0+(x0-e.clientX),false)});
  const end=()=>{if(!on)return;on=false;app.classList.remove('wp-drag');set($('wp').offsetWidth,true)};
  g.addEventListener('pointerup',end);g.addEventListener('pointercancel',end);
  g.addEventListener('dblclick',()=>{app.style.removeProperty(vr());store.set(key(),null);dockSync()});
  g.addEventListener('keydown',e=>{const d={ArrowLeft:24,ArrowRight:-24}[e.key];if(!d)return;e.preventDefault();set($('wp').offsetWidth+d,true)})})();
