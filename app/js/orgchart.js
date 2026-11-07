/* OCTA 4.15 公司組織圖 — the main screen drawn as a company instead of the deep-sea base (設定 → 外觀 → 主畫面樣式).
   Same picture of who does what (seaModel → orgModel in seamodel.js), drawn with plain HTML and SVG: no 3D, almost no cost.
   You at the top, a CEO bot if you name one, then one department per 分區 (總部 for bots without one), each with a lead if
   you name one. A bot at work glows and the line up to it carries light; work handed from one bot to another is a moving arc.
   Each bot has a level from the work it has ever finished (待命巡查 checks don't count). */
'use strict';
const ORG={el:null,body:null,wires:null,total:{},t:0,sig:'',busy:false,edit:false,ro:null};
// 設定 → 外觀與語言 → 主畫面樣式: 深海工作室 (sea, the default) or 公司組織圖 (org); kept on this device
const stageStyle=()=>store.get('octa_stagestyle')==='org'?'org':'sea';
const orgOn=()=>stageStyle()==='org';
function stageStyleSet(k){store.set('octa_stagestyle',k==='org'?'org':null);if(k==='org'&&SEA.g)seaFree(SEA.g);ORG.sig='';stageSync();if(k==='org')orgPaint(true)}
// called from stageSync: the stage shows the chart or the base
function orgSync(){const st=SEA.st,on=orgOn();
  const lab=$('seaHeadBar')?.querySelector('b');if(lab)lab.textContent=I18N.t(on?'公司組織圖':'深海基地');
  $('app').classList.toggle('org-mode',on);if(!st)return;st.classList.toggle('org',on);
  if(!on){if(ORG.el)ORG.el.hidden=true;return}
  if(SEA.g)seaFree(SEA.g);$('seaMsg').hidden=true;orgMount();ORG.el.hidden=false;ORG.el.classList.toggle('still',seaStill());
  ORG.el.style.setProperty('--org-l',(SEA.coverPx||0)+'px');ORG.el.style.setProperty('--org-r',(SEA.rightPx||0)+'px');
  orgPaint()}
function orgMount(){if(ORG.el)return;const el=document.createElement('div');el.className='org';el.id='orgView';
  el.innerHTML=`<div class="org-bar"><span class="org-ttl">${ic('briefcase')}<b>公司組織圖</b></span><span class="org-sum" id="orgSum"></span>
    <button type="button" class="org-edit" id="orgEdit" aria-pressed="false">${ic('sliders')}<span>調整組織</span></button></div>
    <div class="org-sc" id="orgSc"><div class="org-tree" id="orgTree"><svg class="org-wires" id="orgWires" aria-hidden="true"></svg><div id="orgBody"></div></div></div>`;
  SEA.st.appendChild(el);ORG.el=el;ORG.body=el.querySelector('#orgBody');ORG.wires=el.querySelector('#orgWires');
  el.querySelector('#orgEdit').onclick=()=>{ORG.edit=!ORG.edit;el.classList.toggle('editing',ORG.edit);el.querySelector('#orgEdit').setAttribute('aria-pressed',String(ORG.edit));orgPaint(true)};
  el.addEventListener('click',e=>{const b=e.target.closest('[data-org-open]');if(b&&!ORG.edit)seaOpenConv(b.dataset.orgOpen)});
  el.addEventListener('change',e=>{const s=e.target.closest('[data-org-set]');if(s)orgSave(s.dataset.orgSet,s.value)});
  el.addEventListener('pointerover',e=>{const b=e.target.closest('.org-card[data-org-open]');if(b)seaHi(b.dataset.orgOpen)});
  el.addEventListener('pointerleave',()=>seaHi(null));
  if(window.ResizeObserver){ORG.ro=new ResizeObserver(()=>orgLines());ORG.ro.observe(el.querySelector('#orgTree'))}
  paintIcons(el)}
// who is CEO / who leads a department: saved with the account (every device shows the same company)
async function orgSave(k,v){const o={ceo:S.org?.ceo||null,leads:{...(S.org?.leads||{})}};
  if(k==='ceo')o.ceo=v||null;else{if(v)o.leads[k]=v;else delete o.leads[k]}
  S.org=o;ORG.sig='';orgPaint(true);
  try{await api('settings','PUT',{org:o});toast(I18N.t('已儲存 ✓'))}catch(e){toast(e.message)}}
// levels: asked for when the chart comes on screen, then at most once a minute
async function orgLoad(){if(ORG.busy)return;ORG.busy=true;ORG.t=Date.now();
  try{const d=await api('overview/org');ORG.total=d.total||{};ORG.sig='';orgPaint()}catch(e){}finally{ORG.busy=false}}
const orgShown=()=>orgOn()&&!!ORG.el&&!ORG.el.hidden&&seaShown();
function orgPaint(force){if(!orgOn()||!SEA.st||!SEA.m)return;orgMount();if(!seaShown())return;
  if(Date.now()-ORG.t>60000)orgLoad();
  const o=orgModel(SEA.m,{ceo:S.org?.ceo,leads:S.org?.leads,total:ORG.total}),sig=JSON.stringify([o,SEA.sel,ORG.edit,document.documentElement.lang]);
  if(!force&&sig===ORG.sig)return;ORG.sig=sig;ORG.m=o;
  const c=o.counters;
  setHTML($('orgSum'),[`<span><b data-u>${c.working}</b> <span>工作中</span></span>`,c.need?`<span class="need"><b data-u>${c.need}</b> <span>需要你</span></span>`:'',`<span><b data-u>${c.done}</b> <span>今天完成</span></span>`].filter(Boolean).join(''));
  const bots=SEA.m.bots,opt=(list,sel,none)=>`<option value="">${esc(I18N.t(none))}</option>`+list.map(b=>`<option value="${esc(b.id)}"${b.id===sel?' selected':''} data-u>${esc(b.name)}</option>`).join('');
  const me=`<div class="org-me" id="orgMe"><span class="om-ic">${ic('users')}</span><span class="oc-t"><b>${S.nick?`<span data-u>${esc(S.nick)}</span>`:'你'}</b><small>老闆</small></span></div>`;
  const ceo=o.ceo?orgCard(o.ceo,'CEO'):'';
  const ceoPick=ORG.edit?`<label class="org-pick">CEO <select data-org-set="ceo">${opt(bots,o.ceo?.id,'不設 CEO')}</select></label>`:'';
  const depts=o.depts.map(d=>{const all=[d.lead,...d.members].filter(Boolean);
    const leadPick=ORG.edit?`<label class="org-pick">主管 <select data-org-set="${esc(d.id)}">${opt(all,d.lead?.id,'不設主管')}</select></label>`:'';
    return `<section class="org-dept${d.busy?' hot':''}${d.need?' need':''}" data-org-dept="${esc(d.id)}" style="--dc:${esc(d.color)}">
      <header class="od-h"><b${d.hub?'':' data-u'}>${esc(d.hub?I18N.t(d.name):d.name)}</b><small data-u>${d.busy}/${d.n}</small></header>${leadPick}
      ${d.lead?orgCard(d.lead,'主管'):''}<div class="od-m">${d.members.map(b=>orgCard(b)).join('')}</div>
      ${d.rooms.length?`<div class="od-rooms">${d.rooms.map(r=>`<button type="button" class="org-room${r.busy?' on':''}${r.need?' need':''}" data-org-open="${esc(r.id)}">${ic('users')}<span data-u>${esc(r.name)}</span><small data-u>${r.n}</small></button>`).join('')}</div>`:''}
    </section>`}).join('');
  const empty=!o.depts.length&&!o.ceo?`<p class="org-empty">還沒有機器人。建立第一個機器人，它就會出現在組織圖上。</p>`:'';
  setHTML(ORG.body,`<div class="org-top">${me}${ceoPick}${ceo}</div><div class="org-depts">${depts}</div>${empty}`);
  paintIcons(ORG.body);requestAnimationFrame(()=>{orgLines();orgScroll()})}
// a chart wider than the space beside the chat starts centred; the open chat's card is scrolled into view
function orgScroll(){const sc=$('orgSc');if(!sc||!orgShown())return;
  if(!ORG.cx&&sc.scrollWidth>sc.clientWidth){sc.scrollLeft=(sc.scrollWidth-sc.clientWidth)/2;ORG.cx=1}
  if(SEA.sel!==ORG.lastSel){ORG.lastSel=SEA.sel;if(SEA.sel)ORG.el.querySelector(`[data-org-bot="${CSS.escape(SEA.sel)}"]`)?.scrollIntoView({block:'nearest',inline:'center',behavior:seaStill()?'auto':'smooth'})}}
// one bot's card: face, name, what it is doing, level; the bubble says what it is on right now
function orgCard(b,role){const tone=b.bubble?.tone||'';
  const bub=b.bubble&&(b.bubble.lab||b.bubble.txt)?`<span class="oc-bub ${esc(tone)}">${b.bubble.lab?`<b>${esc(I18N.t(b.bubble.lab))}</b>`:''}${b.bubble.txt?`<span data-u>${esc(b.bubble.txt)}</span>`:''}</span>`:'';
  return `<button type="button" class="org-card s-${esc(b.state)}${b.on?' on':''}${b.need?' need':''}${b.fail?' fail':''}${SEA.sel===b.id?' sel':''}${role?' boss':''}" data-org-open="${esc(b.id)}" data-org-bot="${esc(b.id)}"${b.color?` style="--bc:${esc(b.color)}"`:''}>
    <span class="oc-av">${avOf(b.id,'always')}</span><span class="oc-t"><b data-u>${esc(b.name)}</b><small>${role?`<i class="oc-role">${role}</i>`:''}${esc(I18N.t(b.word))}</small></span>
    <i class="oc-lv" title="${esc(I18N.t('完成過的工作'))}: ${b.done}">Lv.<span data-u>${b.lv}</span></i>${bub}</button>`}
/* the wires: you → CEO → each department → its people. A department with someone at work carries light; work handed
   from one bot to another is an arc between their cards. Drawn again whenever the cards move or change size. */
function orgLines(){const t=$('orgTree'),svg=ORG.wires,o=ORG.m;if(!t||!svg||!o||!orgShown())return;
  const R=t.getBoundingClientRect(),z=parseFloat(document.documentElement.style.zoom)||1;
  const box=el=>{if(!el)return null;const r=el.getBoundingClientRect();return {x:(r.left-R.left)/z,y:(r.top-R.top)/z,w:r.width/z,h:r.height/z}};
  const card=id=>box(t.querySelector(`[data-org-bot="${CSS.escape(id)}"]`));
  const W=t.scrollWidth,H=t.scrollHeight;svg.setAttribute('viewBox',`0 0 ${W} ${H}`);svg.setAttribute('width',W);svg.setAttribute('height',H);
  const top=o.ceo?card(o.ceo.id):box($('orgMe'));if(!top){svg.innerHTML='';return}
  const p=[];const bx=top.x+top.w/2,by=top.y+top.h;
  if(o.ceo){const m=box($('orgMe'));if(m)p.push(`<path class="w${o.counters.working?' hot':''}" d="M${m.x+m.w/2} ${m.y+m.h}V${top.y}"/>`)}
  for(const d of o.depts){const h=box(t.querySelector(`[data-org-dept="${CSS.escape(d.id)}"] .od-h`));if(!h)continue;
    const hx=h.x+h.w/2,my=(by+h.y)/2;p.push(`<path class="w${d.busy?' hot':''}" style="--dc:${esc(d.color)}" d="M${bx} ${by}V${my}H${hx}V${h.y}"/>`)}
  for(const k of o.links){const a=card(k.from),b=card(k.to);if(!a||!b)continue;
    const ax=a.x+a.w/2,ay=a.y+a.h/2,bx2=b.x+b.w/2,by2=b.y+b.h/2,lift=Math.max(40,Math.abs(bx2-ax)*.25);
    p.push(`<path class="hand" d="M${ax} ${ay}C${ax} ${ay-lift} ${bx2} ${by2-lift} ${bx2} ${by2}"/>`)}
  svg.innerHTML=p.join('')}
