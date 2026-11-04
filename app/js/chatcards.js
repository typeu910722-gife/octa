/* OCTA web app — 4.7 pieces of the conversation: a running job's line (步驟 2/5, 暫停／繼續, 停止), the bot's markers as chips,
   the approval card's editor and the header line when a bot waits on a colleague. Used by chat.js, panel.js and list.js. */
'use strict';
/* ---------- 4.7 a running job: 「步驟 2/5：正在讀…」, a thin bar, 暫停／繼續 and 停止 (chat line, work panel, sidebar) ---------- */
const PAUSE={};   // job → {on, at}: what you pressed, until the runner says so (paused)
function pauseOf(x){const p=PAUSE[x.job],on=!!+x.paused;
  if(p&&(p.on===on||Date.now()-p.at>120000))delete PAUSE[x.job];
  const q=PAUSE[x.job];return q?(q.on?(on?'paused':'pausing'):'resuming'):on?'paused':''}
// the running job of a chat that you would want to see first (yours, not a colleague's background question)
const runOf=id=>{const r=busyIn(id).filter(x=>x.status==='running');return r.find(x=>!+x.bg&&x.kind==='chat')||r.find(x=>!+x.bg)||r[0]||null};
function progLine(x){const v=progView(x.progress),ps=pauseOf(x);
  const st=ps==='pausing'?'<span class="jps">這一步做完會暫停</span>':ps==='paused'?'<span class="jps">已暫停</span>':ps==='resuming'?'<span class="jps">正在繼續…</span>':'';
  const txt=v.cur?`<span class="jcur" data-u>${esc(v.cur)}</span>`:`<span class="jcur">${x.kind==='open'?'打開瀏覽器':esc(STATE_LABEL[stateOf(x.bot_id)]||'工作中')}</span>`;
  return st+(v.has?`<b class="jstep"><span>步驟</span> ${v.step}/${v.total}</b><span class="jsep">：</span>`:'')+txt}
const progBar=x=>{const v=progView(x.progress);return v.has?`<i class="jbar" role="progressbar" aria-valuemin="0" aria-valuemax="${v.total}" aria-valuenow="${v.step-1}"><i style="width:${v.pct}%"></i></i>`:''};
function pauseBtn(x){const ps=pauseOf(x),resume=ps==='paused'||ps==='pausing';
  return `<button type="button" class="jb" data-jpause="${x.job}" data-on="${resume?0:1}"${ps==='resuming'?' disabled':''} title="${resume?'繼續':'暫停'}">${ic(resume?'play':'pause')}<span>${resume?'繼續':'暫停'}</span></button>`}
function jobChip(x){const ps=pauseOf(x);
  return `<div class="jchip${ps?' '+ps:''}" data-job="${x.job}"><button type="button" class="jmain" data-wgo="work" title="在工作面板看每一步"><span class="av sm" data-u>${avOf(x.bot_id,'always')}</span>
    <span class="jtx"><span class="jl">${progLine(x)}</span>${progBar(x)}</span><span class="el" data-since="${x.started||x.created}">${elapsed(x.started||x.created)}</span></button>
    ${x.kind==='open'?'':pauseBtn(x)}<button type="button" class="jb stop" data-jstop title="停止">${ic('stop')}<span>停止</span></button></div>`}
async function jobPause(job,on,btn){if(!job)return;if(btn)btn.disabled=true;PAUSE[job]={on,at:Date.now()};render(false);
  try{await api('job/'+job+'/pause','POST',{on});refresh()}
  catch(err){delete PAUSE[job];render(false);toast(err.message)}}
/* 同事協作: a bot here waits on a colleague's answer — a small line in the header (the timeline is in 工作) */
function paintCollab(c,g){const el=$('cwait');if(!el)return;const w=collabWait(BS[c.id]?.items,g?c.members:[c.id]);
  if(!w){el.hidden=true;return}el.hidden=false;
  setHTML(el,`<span class="cwi" aria-hidden="true">${ic('users')}</span>${g?`<span class="cwf" data-u>${esc(nameOf(w.from))}</span>`:''}<span class="cwl">在等</span> <b data-u>${esc(nameOf(w.to))}</b> <span class="cwl">回覆，已等</span> <span class="cwm" data-wsince="${w.since}">${minTxt(w.since)}</span> <span>分鐘</span>`)}
const minTxt=t=>{const n=minsOf(Date.now()-t);return n<1?'<1':String(n)};
setInterval(()=>document.querySelectorAll('[data-wsince]').forEach(e=>{const v=minTxt(+e.dataset.wsince);if(e.textContent!==v)e.textContent=v}),15000);
$('cwait')&&($('cwait').onclick=()=>openPanel('work',{user:true}));

// 4.7 修改 on a card with 內容: an editor in the card; what you type survives the chat redrawing around it
const AED={mid:null,content:'',when:'',focus:null},APOPEN=new Set();
function apprEditSend(m){const f=apprFields(m.text)||{},act=f.act||(m.text.match(APPR)||[])[1]||'',at=isG(cur)?'@'+nameOf(m.by)+' ':'';
  const content=AED.content.trim();if(!content){toast(I18N.t('內容不能是空的'));return}
  const msg=at+'核准：'+act.trim()+'\n（照我改過的版本做，內容以這裡為準）'+(f.to?'\n對象：'+f.to:'')+'\n內容：'+content+(f.when?'\n時間：'+(AED.when.trim()||f.when):'');
  AED.mid=null;sendMsg(msg)}
/* ---------- the bot's markers as small chips under its message (📌 已記住 1 條規則 · ⏰ 已排程：每天 09:00 …); a tap shows the full text ---------- */
const NOTEOPEN=new Set();
const NOTE_LAB={已排程:'已排程：',新技能:'新技能：',做事手冊:'做事手冊：',網站筆記:'網站筆記：',目前頁面:'目前頁面：',已刪除例行任務:'已刪除例行任務：',已停用例行任務:'已停用例行任務：',已啟用例行任務:'已啟用例行任務：',例行任務:'例行任務：',紀錄:'紀錄：'};
function chipLabel(c){const lab=`<span>${esc(NOTE_LAB[c.label]||c.label)}</span>`;
  if(c.type==='memory')return `<span>已記住</span> ${c.n} <span>${c.items.every(n=>n.fact)?'項資料':'條規則'}</span>`;
  if(c.type==='task')return lab;
  if(c.type==='routine')return lab+(c.daily?'<span>每天</span> ':'')+(c.when?`<span data-u>${esc(c.when)}</span> `:'')+`<span data-u>${esc(c.name||'')}</span>`;
  return lab+`<span data-u>${esc(c.name||'')}</span>`}
function noteFull(c){return c.items.map(n=>{
    if(c.type==='page'){const u=n.title||n.body;return /^https?:\/\//.test(u)?`<a href="${esc(u)}" target="_blank" rel="noopener" data-u>${esc(u)}</a>`:`<span data-u>${esc(u)}</span>`}
    if(c.type==='routine')return `<div class="nfi"><b data-u>${esc(n.title||'')}</b>${n.when?`<div class="nkv"><span>時間</span><span data-u>${esc(n.when)}</span></div>`:''}${n.body?`<div class="nkv"><span>每次要做的事</span><span data-u>${esc(n.body)}</span></div>`:''}</div>`;
    return `<div class="nfi">${n.title?`<b data-u>${esc(n.title)}</b>`:''}${n.body?`<div class="nbody" data-u>${esc(n.body)}</div>`:''}</div>`}).join('')}
function notesHtml(m,notes){const cs=noteChips(notes);if(!cs.length)return '';
  return `<div class="nchips">${cs.map((c,i)=>{const k=m.id+':'+i,on=NOTEOPEN.has(k);
    return `<button type="button" class="nchip ${c.type}${on?' on':''}" data-note="${esc(k)}" aria-expanded="${on}"><span class="nci" aria-hidden="true">${c.icon}</span><span class="nct">${chipLabel(c)}</span></button>`}).join('')}</div>`
    +cs.map((c,i)=>NOTEOPEN.has(m.id+':'+i)?`<div class="nfull ${c.type}">${noteFull(c)}</div>`:'').join('')}
