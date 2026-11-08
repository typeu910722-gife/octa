/* OCTA web app — the open conversation: header, messages, approval cards, questions, hints, message menus. */
'use strict';
const SYSOPEN=new Set(),OPENED=new Set();
const ENG_NAME=k=>(ENG[k]||{n:k}).n;
ICONS.pause=ICONS.pause||'<rect x="7" y="5.5" width="3.2" height="13" rx="1"/><rect x="13.8" y="5.5" width="3.2" height="13" rx="1"/>';

function fmt(t){return esc(t).replace(/(https?:\/\/[^\s<]+)/g,'<a href="$1" target="_blank" rel="noopener">$1</a>').replace(/@([^\s@，。、]+)/g,'<span class="at">@$1</span>')}
/* bot replies: a small, safe Markdown subset (everything is escaped first) */
function inl(t){return esc(t)
  .replace(/`([^`]+)`/g,'<code>$1</code>')
  .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,'<a href="$2" target="_blank" rel="noopener">$1</a>')
  .replace(/(^|[^"'>=])(https?:\/\/[^\s<]+)/g,'$1<a href="$2" target="_blank" rel="noopener">$2</a>')
  .replace(/\*\*([^*]+)\*\*/g,'<b>$1</b>').replace(/__([^_]+)__/g,'<b>$1</b>')
  .replace(/(^|[^*])\*([^*\s][^*]*)\*/g,'$1<i>$2</i>')
  .replace(/~~([^~]+)~~/g,'<s>$1</s>')
  .replace(/(^|\s)@([^\s@，。、<]+)/g,'$1<span class="at">@$2</span>')}
function md(src){
  const L=String(src).replace(/\r/g,'').split('\n'),out=[];let i=0;
  const isRow=l=>/^\s*\|.*\|\s*$/.test(l),cells=l=>l.trim().replace(/^\||\|$/g,'').split('|').map(c=>c.trim());
  while(i<L.length){const l=L[i];
    if(/^\s*```/.test(l)){const buf=[];i++;while(i<L.length&&!/^\s*```/.test(L[i]))buf.push(L[i++]);i++;
      out.push(`<div class="cb"><button type="button" class="cbc" data-copy-code>複製</button><pre><code>${esc(buf.join('\n'))}</code></pre></div>`);continue}
    if(isRow(l)&&i+1<L.length&&/^\s*\|?\s*:?-{2,}/.test(L[i+1])){const head=cells(l);i+=2;const rows=[];while(i<L.length&&isRow(L[i]))rows.push(cells(L[i++]));
      out.push(`<div class="tw"><table><thead><tr>${head.map(c=>`<th>${inl(c)}</th>`).join('')}</tr></thead><tbody>${rows.map(r=>`<tr>${r.map(c=>`<td>${inl(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);continue}
    let m;
    if((m=l.match(/^(#{1,4})\s+(.+)/))){out.push(`<div class="h${m[1].length}">${inl(m[2])}</div>`);i++;continue}
    if(/^\s*([-*•]|\d+[.)])\s+/.test(l)){const ol=/^\s*\d/.test(l),items=[];
      while(i<L.length&&/^\s*([-*•]|\d+[.)])\s+/.test(L[i])){items.push(L[i].replace(/^\s*([-*•]|\d+[.)])\s+/,''));i++}
      out.push(`<${ol?'ol':'ul'}>${items.map(x=>`<li>${inl(x)}</li>`).join('')}</${ol?'ol':'ul'}>`);continue}
    if(/^\s*>\s?/.test(l)){const q=[];while(i<L.length&&/^\s*>\s?/.test(L[i]))q.push(L[i++].replace(/^\s*>\s?/,''));out.push(`<blockquote>${q.map(inl).join('<br>')}</blockquote>`);continue}
    if(/^\s*(-{3,}|\*{3,})\s*$/.test(l)){out.push('<hr>');i++;continue}
    if(!l.trim()){i++;continue}
    const p=[];while(i<L.length&&L[i].trim()&&!/^\s*(```|#{1,4}\s|[-*•]\s|\d+[.)]\s|>|\|)/.test(L[i]))p.push(L[i++]);
    if(!p.length)p.push(L[i++]);
    out.push(`<p>${p.map(inl).join('<br>')}</p>`)}
  return out.join('')}

/* ---------- cards under a message ---------- */
// a failed reply: offer to send the same instruction again
const NEEDLOGIN=/需要使用者在電腦上登入|需要.{0,6}登入/;
function retryHtml(m){if(!/^⚠/.test(m.text)||NEEDLOGIN.test(m.text))return '';const ms=convMsgs(m.conv);if(ms.some(x=>x.id>m.id&&!x.tmp&&x.by!=='sys'))return '';
  return `<div class="appr"><button type="button" class="ghost sm" data-retry="${m.id}">${ic('refresh')}<span>重試</span></button></div>`}
function loginHtml(m){const b=bot(m.by);if(!b||b.browser==='mine'||!NEEDLOGIN.test(m.text))return '';
  if(convMsgs(m.conv).some(x=>x.id>m.id&&x.by===m.by))return '';
  return `<div class="logincard"><div class="appr"><button type="button" class="btn sm" data-hand="${esc(m.by)}">${ic('hand')}<span>接手</span></button><button type="button" class="ghost sm" data-resume="${esc(m.by)}">${ic('play')}<span>繼續</span></button></div><small class="hint2">機器人已停止點擊。在旁邊的即時畫面上自己登入，再按繼續。密碼不要貼到聊天裡。</small></div>`}
/* ✅待確認 as one clear card: what will be done, by whom, what it touches; once decided it says who decided and when */
function apprHtml(m){if(!APPR.test(m.text||''))return '';
  const ms=chatMsgs(m.conv||cur),i=ms.findIndex(x=>x.id===m.id),after=i<0?[]:ms.slice(i+1).filter(x=>x.by!=='sys');
  const d=apprDecision(m,after,nameOf(m.by));if(!d)return '';
  const who=esc(nameOf(m.by)),me=S.nick?`<span data-u>${esc(S.nick)}</span>`:'<span>你</span>';
  const head=(icon,lab)=>`<div class="aph"><span class="apic" aria-hidden="true">${icon}</span><span class="apt"><small>${lab}</small><b data-u>${esc(d.plan?I18N.t('照計畫執行'):d.act)}</b></span></div>`;
  if(d.state!=='wait'){const t=d.at?hm(d.at):'';
    const line={ok:`${me} · <span>${t}</span> <span>${d.plan?'同意照做':'核准'}</span>${d.always?' · <span>以後一律允許</span>':''}`,no:`${me} · <span>${t}</span> <span>拒絕</span>`,
      answered:`${me} · <span>${t}</span> <span>用訊息回覆了</span>`,stale:`<span data-u>${who}</span> · <span>${t}</span> <span>又傳了新訊息，這張不用再處理</span>`}[d.state];
    const lab={ok:d.plan?'已同意':'已核准',no:'已拒絕',answered:'已回覆',stale:'已略過'}[d.state];
    return `<div class="apcard ${d.state}" data-ap="${m.id}">${head({ok:ic('check'),no:ic('x'),answered:ic('reply'),stale:'–'}[d.state],lab)}<div class="apwho">${line}</div></div>`}
  const btns=d.plan?`<button type="button" class="btn sm" data-approve="${m.id}">照做</button><button type="button" class="ghost sm" data-revise="${m.id}" data-plan="1">修改</button>`   // 📋計畫: run it as written, or say what to change
    :apprInstall(d.act)?`<button type="button" class="btn sm" data-approve="${m.id}">${ic('check')}<span>核准</span></button>${msgMeta(m)?.skillreq?.always?`<button type="button" class="ghost sm" data-skalways="${m.id}">一律允許</button>`:''}<button type="button" class="ghost sm danger" data-deny="${m.id}">拒絕</button>`   // 4.12 安裝技能／安裝工具
    :apprOwn(d.act)?`<button type="button" class="btn sm" data-approve="${m.id}">核准</button><button type="button" class="ghost sm" data-deny="${m.id}">不用了</button>`   // OCTA's own: 建立排程／記住規則／整理排程
    :`<button type="button" class="btn sm" data-approve="${m.id}">${ic('check')}<span>核准（只這次）</span></button><button type="button" class="ghost sm" data-always="${m.id}">一律允許</button><button type="button" class="ghost sm" data-revise="${m.id}">${ic('edit')}<span>修改</span></button><button type="button" class="ghost sm danger" data-deny="${m.id}">拒絕</button>`;
  // 4.7: 對象／內容／時間 written under ✅待確認 (contract §4); without them, the one-line card as before
  const f=apprFields(m.text)||{},full=!d.plan&&(apprInstall(d.act)||!apprOwn(d.act))&&(f.to||f.content||f.when);
  const impact=`<span>會影響</span><span>${esc(apprImpact(d.act,m.text))}</span>`;
  if(AED.mid===m.id&&full)return `<div class="apcard wait editing" data-ap="${m.id}" role="group" aria-label="修改後核准">${head(ic('edit'),'修改後核准')}
    <div class="aped">${f.to?`<div class="apkv"><span>對象</span><b data-u>${esc(f.to)}</b></div>`:''}
      <label class="field"><span>內容</span><textarea data-aedit="content" rows="5" maxlength="3800">${esc(AED.content)}</textarea></label>
      ${f.when?`<label class="field"><span>時間</span><input data-aedit="when" maxlength="80" value="${esc(AED.when)}"></label>`:''}
      <small class="hint2">送出後它會照你改過的版本做，不用再按核准。</small></div>
    <div class="appr"><button type="button" class="btn sm" data-aesend="${m.id}">${ic('check')}<span>用這個版本核准</span></button><button type="button" class="ghost sm" data-aecancel>取消</button></div></div>`;
  if(!full)return `<div class="apcard wait" data-ap="${m.id}" role="group" aria-label="待你核准">${head(ic('shield'),'待你核准')}
    <div class="apkv"><span>誰要做</span><b data-u>${who}</b>${impact}</div>
    <div class="appr">${btns}</div></div>`;
  const long=f.content.length>160||f.content.split('\n').length>4,op=APOPEN.has(m.id);
  return `<div class="apcard wait full" data-ap="${m.id}" role="group" aria-label="待你核准">${head(ic('shield'),'待你核准')}
    <div class="apkv"><span>誰要做</span><b data-u>${who}</b>${f.to?`<span>對象</span><b data-u>${esc(f.to)}</b>`:''}<span>時間</span><span>${f.when?`<span data-u>${esc(f.when)}</span>`:'<span>核准後馬上做</span>'}</span>${impact}</div>
    ${f.content?`<div class="apbody${long&&!op?' clip':''}"><div class="apbl">內容</div><div class="apct" data-u>${esc(f.content)}</div>${long?`<button type="button" class="more3" data-apopen="${m.id}">${op?'收合':'展開全文'}</button>`:''}</div>`:''}
    <div class="appr">${btns}</div></div>`}
// you asked to go there (a tap): open the chat and bring its waiting card into view
function goAsk(id){if(id!==cur)openConv(id);const show=()=>{const c=[...document.querySelectorAll('#msgs .apcard.wait')].pop();if(c){c.scrollIntoView({block:'center',behavior:'smooth'});c.classList.add('qhit');setTimeout(()=>c.classList.remove('qhit'),1400)}return !!c};
  if(!show())setTimeout(show,500)}
const lastOpen=m=>{const ms=chatMsgs(m.conv||cur).filter(x=>!x.tmp&&x.by!=='sys');return ms.length&&ms[ms.length-1].id===m.id};
// the choices are shown as a card: take them out of the question line so they don't appear twice
function optText(m){if(!optsHtml(m))return m.text;const ls=String(m.text).split('\n');for(let i=ls.length-1;i>=0;i--)if(/❓|[？?]/.test(ls[i])&&/[A-Da-d][.．、)）]/.test(ls[i])){ls[i]=ls[i].replace(/\s*[（(]?[A-Da-d][.．、)）][\s\S]*$/,'');break}return ls.join('\n')}
function optsHtml(m){if(!lastOpen(m)||!ASKRE.test(String(m.text)))return '';const o=askOpts(m.text);if(!o.length)return '';
  return `<div class="opts">${o.map(v=>`<button type="button" data-opt="${esc(v)}" data-who="${esc(nameOf(m.by))}"><span class="optk">${esc(v.slice(0,1))}</span><span data-u>${esc(v.slice(3))}</span></button>`).join('')}</div>`}
let replyTo=null;
function quoteHtml(m){if(!m?.reply)return '';
  const src=convMsgs(m.conv||cur).find(x=>String(x.id)===String(m.reply));
  const who=src?nameOf(src.by):I18N.t('先前的訊息');
  const bit=src?String(src.text||'').replace(/\s+/g,' ').trim().slice(0,80):'';
  return `<button type="button" class="qref" data-jump="${m.reply}"><b data-u>${esc(who)}</b><span data-u>${esc(bit||I18N.t('（這則沒有留在目前畫面上）'))}</span></button>`}

/* ---------- 幕後: what bots asked of / handed to each other. Shown in the work panel (工作), never in the chat ---------- */
const BS={};
function loadBack(id){const real=convMsgs(id).filter(m=>!m.tmp),k=(real.length?real[real.length-1].id:0)+':'+busyIn(id).length+':'+S.busy.filter(x=>+x.bg).map(x=>x.job+x.status).join('.'),b=BS[id];   // 4.7: a colleague's answer finishing elsewhere refreshes it too
  if(b&&(b.k===k||b.busy))return;BS[id]={items:b?.items||[],ok:!!b?.ok,k,busy:true,keys:b?.keys||new Set()};
  api('backstage?conv='+encodeURIComponent(id)).then(d=>{const items=d.items||[];
    BS[id]={items,ok:true,k,busy:false,keys:new Set(items.filter(x=>x.reply).map(x=>bgKey(x.to,x.reply)))};if(cur===id)render(false)}).catch(()=>{BS[id].busy=false})}
// answers to another bot's background request (older messages carry no kind): matched by their first words
const bgKeysFor=id=>BS[id]?.keys||null;
const chatMsgs=id=>convMsgs(id).filter(m=>msgPlace(m,bgKeysFor(id))==='chat');

/* ---------- render ---------- */
function render(scroll){queueMicrotask(renderAsks);renderList();renderChat(scroll);if(typeof renderPanel==='function')renderPanel();if(typeof stageSync==='function')stageSync()}
/* a group: who is doing what right now — working with its progress line, queued, waiting on you, free */
const GM_LABEL={run:'工作中',queue:'排隊中',ask:'等你核准',idle:'待命'};
function groupAsks(id){const ms=chatMsgs(id).filter(m=>m.by!=='sys');const out=[];
  ms.forEach((m,i)=>{if(m.by!=='me'&&!m.tmp&&APPR.test(m.text||'')&&apprDecision(m,ms.slice(i+1),nameOf(m.by))?.state==='wait')out.push(m.by)});return out}
function paintMembers(c,g){const box=$('gmem');if(!g){box.hidden=true;return}
  const asks=[...groupAsks(c.id),...c.members.filter(id=>apprWait(id))];
  box.hidden=false;
  setHTML(box,c.members.filter(bot).map(id=>{const s=memberState(id,S.busy,asks),b=bot(id);
    return `<button type="button" class="gm ${s.k}" data-gm="${esc(id)}" title="${esc(I18N.t(GM_LABEL[s.k]))}${s.p?' · '+esc(s.p):''}"><span class="av xs" data-u>${avOf(id)}</span><b data-u>${esc(b.name)}</b><span class="gs"><i class="gd" aria-hidden="true"></i><span>${GM_LABEL[s.k]}</span></span>${s.k==='run'&&s.p?`<span class="gp" data-u>${esc(s.p.length>40?s.p.slice(0,40)+'…':s.p)}</span>`:''}</button>`}).join(''))}
$('gmem').onclick=e=>{const b=e.target.closest('[data-gm]');if(!b)return;const id=b.dataset.gm;
  if(b.classList.contains('ask')){if(groupAsks(cur).includes(id))goAsk(cur);else goAsk(id);return}   // its 核准 card (here, or in its own chat — your tap)
  const nm=bot(id)?.name;if(!nm)return;const i=$('msg');if(!i.value.includes('@'+nm)){i.value=(i.value.trimEnd()+' @'+nm+' ').trimStart();grow();paintTo()}i.focus()};   // otherwise: talk to it
const tkOf=ids=>ids.reduce((a,id)=>{const x=(S.tokens||{})[id];return x?{t:a.t+(x.t||0),n:a.n+x.n,known:a.known||x.t!=null}:a},{t:0,n:0,known:false});
// the line under the name: 分區 · AI (and a backup when one took over) · routines · today's use
function subLine(c){const g=isG(c.id),fn=folderName(c.folder),rn=S.routines.filter(r=>r.conv===c.id&&r.enabled).length;
  const tk=tkOf(g?c.members:[c.id]);
  const tkHtml=tk.n?` · <span class="tk" title="${esc(I18N.t('今天執行'))} ${tk.n} ${esc(I18N.t('次'))}">${tk.known?`${I18N.t('今天')} ${fmtTok(tk.t)} tokens`:`${I18N.t('今天')} ${tk.n} ${I18N.t('次')}`}</span>`:'';
  const runNow=busyIn(c.id).find(x=>x.status==='running'&&x.kind==='chat'&&x.eng);
  const activeEng=runNow?String(runNow.eng).split('|')[0]:(c.engine||'claude');
  const activeModel=runNow?String(runNow.eng).split('|')[1]||'':(c.model||'');
  const modelHtml=g?`<span>${c.members.filter(bot).length} <span>位成員</span></span>`:`${esc(ENG_NAME(activeEng))}${activeModel?` <span data-u>${esc(activeModel)}</span>`:''}${activeEng!==(c.engine||'claude')?' · <span>換了備援</span>':''}`;
  return (fn?`<span data-u>${esc(fn)}</span> · `:'')+modelHtml+(rn?` · <span>例行</span> ${rn}`:'')+tkHtml}
function welcomeHtml(c,g){const ex=g?['@'+(bot(c.members[0])?.name||'')+' 先整理今天的資料，再交給下一位']
    :['每天早上 9 點幫我整理今天的待辦','打開這個網站，看看有沒有新公告：','把我傳的檔案整理成表格'];
  return `<div class="welcome"><span class="av xl${g?' grp':''}"${g?'':' data-u'}>${g?gStack(c):avOf(c.id)}</span><h3 data-u>${esc(c.name)}</h3>
    <p>${g?'在群組裡交代的事，成員會依序接手；用 @名字 指定誰做。':'直接跟它說要做什麼。它會自己記住工作、需要時建立例行任務，做重要的事前會先問你。'}</p>
    <div class="sugg">${ex.map(t=>`<button type="button" data-sugg="${esc(t)}">${ic('sparkle')}<span data-u>${esc(t)}</span></button>`).join('')}</div>
    ${g?'':`<button type="button" class="link" data-d="open">${ic('panel')}<span>設定它的 AI、瀏覽器、例行任務</span></button>`}</div>`}
function renderChat(scroll){
  const c=cur&&conv(cur);
  $('app').classList.toggle('has-conv',!!c);$('app').classList.toggle('tour',!c&&tourOn());
  ['ph','msgs','composer'].forEach(k=>$(k).hidden=!c);$('blank').hidden=!!c;
  if(!c){$('offb').hidden=true;$('gmem').hidden=true;if($('cwait'))$('cwait').hidden=true;$('jump').hidden=true;$('failbar').hidden=true;renderBlank();$('mention').innerHTML='';setHTML($('quick'),'');paintReply();return}
  const g=isG(cur);
  paintMembers(c,g);
  paintCollab(c,g);
  const pav=$('pav');pav.className='av'+(g?' grp':'');setHTML(pav,g?gStack(c,true):avOf(c.id,'always'));pav.setAttribute('data-u','');
  $('pname').textContent=c.name;
  // while it works, the line under the name says what it is doing (the details are in the work panel)
  const st=g?(busyIn(cur).some(x=>x.status==='running')?'working':''):stateOf(cur);
  const rj=runOf(cur),ps=rj&&pauseOf(rj);
  // 4.8: no step count here — progress lives in the 工作 panel only (評論：「步驟 1/3 出現三次」)
  setHTML($('psub'),psubHtml(c,st,ps));
  const off=!S.runnerOnline;$('offb').hidden=!off;
  if(off)setHTML($('offb'),`${ic('info')}<span>${DESK()?'機器人目前沒有在工作。訊息會先排著，OCTA 準備好就會做。':CFG.via?'主機電腦上的 OCTA 沒有在執行。訊息會先排著，主機電腦開機後就會做。':'電腦上的 OCTA 沒有在執行。訊息會先排著，電腦開機後就會做。'}</span>`);
  $('msg').placeholder=I18N.t(g&&!phoneUI()?'輸入指示，可用 @ 指定誰做':'輸入指示…');
  const qk=(S.quick||{})[cur]||[];
  setHTML($('quick'),qk.length?qk.map((q,i)=>`<button type="button" data-q="${i}" title="${esc(q)}">${ic('zap')}<span data-u>${esc(q.length>24?q.slice(0,24)+'…':q)}</span></button>`).join(''):'');
  setHTML($('mention'),g&&!phoneUI()?c.members.map(id=>bot(id)?`<button type="button" data-at="${esc(bot(id).name)}" data-u>@${esc(bot(id).name)}</button>`:'').join(''):'');
  paintTo();
  const box=$('msgs'),atBottom=box.scrollHeight-box.scrollTop-box.clientHeight<120;
  const switched=box._conv!==cur;box._conv=cur;
  // 4.8: a reply that just arrived rises in (once); opening a chat shows its history as it is
  const seenIds=box._seen&&!switched?box._seen:null,nowIds=new Set();
  const freshK=m=>{nowIds.add(m.id);return seenIds&&!seenIds.has(m.id)?' fresh':''};
  const mc=MSG[cur];
  let mh=!mc?.loaded?'<div class="sys fade">載入中…</div>':mc.more?'<button type="button" class="ghost sm older" id="older">載入更早的訊息</button>':'';
  let prevDay='';
  const acts=(m,mine)=>`<div class="mact" role="toolbar"><button type="button" data-reply="${m.id}" aria-label="回覆這則" title="回覆">${ic('reply')}</button><button type="button" data-copy-msg="${m.id}" aria-label="複製" title="複製">${ic('copy')}</button><button type="button" data-mmenu="${m.id}" aria-label="更多" title="更多">${ic('more')}</button></div>`;
  const row=(m,rk='')=>{
    if(m.by==='sys'){const t=String(m.text||''),first=t.split('\n')[0],long=t.length>70||t.includes('\n');
      if(!long)return `<div class="sys"><span>${esc(t)}</span><span class="ts">${hm(m.ts)}</span></div>`;
      const head=first.length>48?first.slice(0,46)+'…':first;   // long background notes: one line, the rest on tap
      return `<details class="sys sysd"${SYSOPEN.has(String(m.id))?' open':''} data-sid="${esc(String(m.id))}"><summary><span>${esc(head)}</span><span class="ts">${hm(m.ts)}</span></summary><div class="sysfull">${esc(t)}</div></details>`}
    if(m.by==='me')return `<div class="m me${m.tmp?' tmp':''}${rk}${m.tmp?' fresh':''}" data-mid="${m.id}"><div class="bx">${quoteHtml(m)}<div class="bub"${m.tmp?'':' data-dragmsg="1"'} data-u>${fmt(m.text)}${filesHtml(m.files)}</div><div class="meta">${m.tmp?'<span>傳送中…</span>':hm(m.ts)}</div></div>${m.tmp?'':acts(m,true)}</div>`;
    // 4.7: only the human words; the bot's markers become chips under it, its ✅ 完成／⚠ 沒做成 line leads, long replies fold
    // 4.8: when the ✅／⚠ line says what the reply opens with, it is said once (the pill), not twice
    const v=msgView(m),open=OPENED.has(m.id),rb=resultBody(v.text,v.result,msgMeta(m)?.result?.whole),mv={...m,text:rb.text};
    const body=APPR.test(rb.text)?apprStrip(optText(mv)):optText(mv),f=foldReply(body);
    const long=!f.rest&&(body.length>1400||body.split('\n').length>30);
    const shown=f.rest?f.head+(open?'\n\n'+f.rest:''):body;
    const res=v.result&&rb.pill?`<div class="rres ${v.result.ok?'ok':'bad'}"><span class="rri" aria-hidden="true">${v.result.ok?ic('check'):'!'}</span><span class="rrt"><b class="rrk">${v.result.ok?'完成':'未完成'}</b>${v.result.text?`<span data-u>${inl(v.result.text)}</span>`:''}</span></div>`:'';
    const more=f.rest?`<button type="button" class="more3 fold" data-expand="${m.id}" aria-expanded="${open}">${ic('chev','fch')}<span>${open?'收合詳細':'展開詳細'}</span></button>`
      :long?`<button type="button" class="more3" data-expand="${m.id}">${open?'收合':'顯示全部'}</button>`:'';
    return `<div class="m bot${rk}${freshK(m)}" data-mid="${m.id}"><span class="av sm" data-u>${avOf(m.by)}</span><div class="bx"><div class="mh"><b data-u>${esc(nameOf(m.by))}</b><span class="ts">${hm(m.ts)}</span></div>${quoteHtml(m)}${res||shown||(m.files||[]).length?`<div class="bub md${long&&!open?' long':''}${res?' hasres':''}" data-dragmsg="1">${res}${shown?`<div data-u>${md(shown)}</div>`:''}${filesHtml(m.files)}</div>`:''}${more}${notesHtml(m,v.notes)}${apprHtml(m)}${loginHtml(m)}${retryHtml(m)}${optsHtml(m)}</div>${acts(m,false)}</div>`};
  loadBack(cur);   // 幕後 (for the work panel, and to tell older background answers apart)
  // the conversation only: what you said, replies, pictures and files, approvals, questions. The rest is in the work panel.
  const shown=chatMsgs(cur),same=(a,b)=>!!a&&!!b&&a.by!=='sys'&&a.by===b.by&&Math.abs((b.ts||0)-(a.ts||0))<5*60000&&new Date(a.ts).toDateString()===new Date(b.ts).toDateString();
  if(mc?.loaded&&!shown.length&&!busyIn(cur).length&&!mc.more)mh+=welcomeHtml(c,g);
  mh+=shown.map((m,i)=>{const k=m.ts?new Date(m.ts).toDateString():'';let sep='';if(k&&k!==prevDay){prevDay=k;sep=`<div class="day"><span>${esc(dayLabel(m.ts))}</span></div>`}return sep+row(m,(same(shown[i-1],m)&&!sep?' cont':'')+(same(m,shown[i+1])?'':' tail'))}).join('');
  // it is answering you: only a small 「…」 with its face (a tap opens 工作, where the steps, 暫停 and 停止 are). 4.8: one place for progress
  const typing=busyIn(cur).filter(x=>x.status==='running'&&(x.kind==='chat'||x.kind==='code')&&!+x.bg&&bot(x.bot_id));
  if(typing.length)mh+=typing.map(typingDots).join('');
  const ed=AED.mid!=null&&document.activeElement?.dataset?.aedit,sel=ed?[document.activeElement.selectionStart,document.activeElement.selectionEnd]:null;
  box._seen=new Set([...(seenIds||[]),...nowIds]);
  const changed=morph(box,mh);if(changed){loadThumbs(box);paintIcons(box)}
  if(changed&&AED.mid!=null&&(ed||AED.focus)){const el=box.querySelector(`[data-aedit="${ed||AED.focus}"]`);if(el){el.focus({preventScroll:!!ed});if(sel)el.setSelectionRange(...sel);else{el.setSelectionRange(el.value.length,el.value.length);el.scrollIntoView({block:'nearest'})}}AED.focus=null}   // the editor keeps what you type and where
  if(switched||scroll){box.scrollTop=box.scrollHeight;$('jump').hidden=true}
  else if(changed){if(atBottom)box.scrollTo({top:box.scrollHeight,behavior:'smooth'});else $('jump').hidden=false}
  if(atBottom||switched||scroll){markSeen(cur);failSeen(cur)}
  paintReply();
  paintFail(c);
  paintSend();
}
$('msgs').addEventListener('toggle',e=>{const d=e.target;if(d.dataset?.sid)d.open?SYSOPEN.add(d.dataset.sid):SYSOPEN.delete(d.dataset.sid)},true);

/* ---------- hints: the chat on screen changes only when you pick one ---------- */
const HINT={gone:new Set(),key:''};
function hideFollow(){const bar=$('followbar');if(bar)bar.hidden=true;HINT.key=''}
// is something being written here? then nothing may take this chat away
const composing=()=>!!((($('msg')&&$('msg').value)||'').trim()||pending.length||replyTo);
// 4.8: the hint says what happened (the reply's first sentence, the approval's what, why it did not work out), not just 「有新動態」
function showHint(id,kind,key,what,need){const c=conv(id),bar=$('followbar');if(!c||!bar||id===cur||HINT.gone.has(key))return;
  HINT.key=key;bar.dataset.conv=id;bar.dataset.key=key;bar.hidden=false;bar.classList.toggle('needs',!!need?.k);
  setHTML($('followBit'),kind==='remote'?`<span>另一台裝置正在看</span> <b data-u>「${esc(c.name)}」</b>`
    :`<span class="fav av xs" data-u>${isG(id)?gStack(c):avOf(id)}</span><b data-u>${esc(c.name)}</b>${need?.k?`<i class="need ${need.k}">${esc(I18N.t(need.label))}</i>`:''}<span class="fw" data-u>${esc(what||I18N.t(kind==='ask'?'在等你核准':'有新動態'))}</span>`)
  $('followGo').textContent=I18N.t(need?.k==='ap'?'去核准':need?.k==='login'?'去登入':'打開')}
function followRemote(f){
  if(!f?.conv||f.conv===cur||!conv(f.conv)||Date.now()-(f.at||0)>180000){if(String(HINT.key).startsWith('f:'))hideFollow();return}
  showHint(f.conv,'remote','f:'+f.conv+':'+(f.at||0))}
function publishFocus(id){if(!id||!myDev)return;api('focus','PUT',{conv:id,dev:myDev}).catch(()=>{})}
$('followGo').onclick=()=>{const id=$('followbar').dataset.conv;if(id)openConv(id)};
$('followX').onclick=()=>{const k=$('followbar').dataset.key;if(k)HINT.gone.add(k);hideFollow()};

const PEND={};   // attachments waiting in another chat stay with that chat
function openConv(id,opt){
  if(opt&&opt.auto&&id!==cur&&composing()){showHint(id,'new','a:'+id);return false}   // never leave a half-written message
  saveDraft();if(replyTo&&replyTo.conv!==id)replyTo=null;
  if(cur&&cur!==id&&pending.length){PEND[cur]=pending;pending=[]}
  const changed=cur!==id;
  cur=id;store.set('ebot_cur',cur);
  if(typeof STAGE!=='undefined')STAGE.min=false;   // 4.10: picking a chat unfolds the chat panel over the base
  hideFollow();
  if(!$('app').classList.contains('chat'))navPush('chat');
  if(PEND[id]){pending=PEND[id];delete PEND[id]}
  renderAtt();loadDraft();render(true);$('app').classList.add('chat');
  if(changed)panelConv();
  focusBrowser();
  loadMsgs(id,MSG[id]?.loaded?'new':'first').then(()=>{if(cur===id)render(true)}).catch(()=>{});
  publishFocus(id);
  if(!phoneUI())$('msg').focus()}

$('jump').onclick=()=>{const b=$('msgs');b.scrollTo({top:b.scrollHeight,behavior:'smooth'});$('jump').hidden=true};
$('msgs').addEventListener('scroll',()=>{const b=$('msgs');if(b.scrollHeight-b.scrollTop-b.clientHeight<60){$('jump').hidden=true;if(cur&&unread(cur)){markSeen(cur);render(false)}}},{passive:true});
$('back').onclick=()=>{saveDraft();$('app').classList.remove('chat');navPop('chat');focusBrowser()};
$('who').onclick=()=>{if(cur)toggleDetail()};   // the name opens 詳細資料 in the work panel
// a big screen can fold the conversation list away (remembered on this device)
function setRail(open){$('app').classList.toggle('rail-collapsed',!open);$('railToggle').setAttribute('aria-pressed',String(!open));store.set('octa_rail',open?null:'0')}
$('railToggle').onclick=()=>{setRail($('app').classList.contains('rail-collapsed'));focusBrowser()};
if(store.get('octa_rail')==='0')setRail(false);
$('more2').onclick=e=>{e.stopPropagation();if(!cur)return;itemMenu($('more2'),cur)};

/* ---------- clicks inside the conversation ---------- */
const msgById=id=>convMsgs(cur).find(x=>String(x.id)===String(id));
$('msgs').onclick=e=>{const t=e.target;
  if(t.closest('[data-wgo]')){openPanel(t.closest('[data-wgo]').dataset.wgo,{user:true});return}
  const jp=t.closest('[data-jump]');if(jp){const el=document.querySelector(`#msgs [data-mid="${jp.dataset.jump}"]`);if(el){el.scrollIntoView({block:'center',behavior:'smooth'});el.classList.add('qhit');setTimeout(()=>el.classList.remove('qhit'),1200)}return}
  if(t.id==='older'){const box=$('msgs'),h0=box.scrollHeight,id=cur;t.disabled=true;
    loadMsgs(id,'older').then(()=>{if(cur!==id)return;renderChat(false);box.scrollTop=box.scrollHeight-h0}).catch(()=>{t.disabled=false});return}
  const sg=t.closest('[data-sugg]');if(sg){const i=$('msg');i.value=sg.dataset.sugg;grow();paintTo();i.focus();i.setSelectionRange(i.value.length,i.value.length);return}
  if(t.closest('[data-d="open"]')){openDetail();return}
  const rp=t.closest('[data-reply]');if(rp){setReply(msgById(rp.dataset.reply));return}
  const mm=t.closest('[data-mmenu]');if(mm){const m=msgById(mm.dataset.mmenu);if(m)msgMenu(mm,m);return}
  const cp=t.closest('[data-copy-msg]');if(cp){const m=msgById(cp.dataset.copyMsg);if(m)navigator.clipboard?.writeText(m.text).then(()=>toast(I18N.t('已複製'))).catch(()=>{});return}
  const op=t.closest('[data-opt]');if(op){op.disabled=true;sendMsg((isG(cur)?'@'+op.dataset.who+' ':'')+op.dataset.opt);return}
  const ex=t.closest('[data-expand]');if(ex){const id=+ex.dataset.expand;OPENED.has(id)?OPENED.delete(id):OPENED.add(id);renderChat(false);return}
  const cc=t.closest('[data-copy-code]');if(cc){navigator.clipboard?.writeText(cc.nextElementSibling.textContent).then(()=>toast(I18N.t('已複製'))).catch(()=>{});return}
  const rt=t.closest('[data-retry]');if(rt){const ms=convMsgs(cur),i=ms.findIndex(x=>String(x.id)===rt.dataset.retry);
    const last=ms.slice(0,i).reverse().find(x=>x.by==='me');if(!last){toast(I18N.t('找不到上一則指示'));return}
    rt.disabled=true;sendMsg(last.text==='（附件）'?'':last.text,(last.files||[]).map(f=>f.id),last.files||[]);return}
  const rs=t.closest('[data-resume]');if(rs){rs.disabled=true;window.octaDesktop?.control?.(rs.dataset.resume,false);api('handoff','POST',{bot:rs.dataset.resume,on:false}).catch(()=>{});SCR.hand=false;scrPaint();sendMsg('登入好了，繼續剛才的工作');return}   // the earlier instruction is already in the chat, don't send it again
  const hd=t.closest('[data-hand]');if(hd){if(cur&&webIds().includes(hd.dataset.hand)){WP.webBot[cur]=hd.dataset.hand;openPanel('web',{user:true})}window.octaDesktop?.control?.(hd.dataset.hand,true);api('handoff','POST',{bot:hd.dataset.hand,on:true}).then(()=>{toast(I18N.t('已接手，機器人停止點擊'));SCR.hand=true;SCR.ready='';scrPaint();pollLive()}).catch(err=>toast(err.message));return}
  const ob=t.closest('[data-openb]');if(ob){ob.disabled=true;openBrowser(ob.dataset.openb);return}
  const im=t.closest('img[data-file]');if(im)openFile(im.dataset.file);
  const fc=t.closest('[data-open-file]');if(fc)openFile(fc.dataset.openFile);
  const dn=t.closest('[data-deny]');if(dn){const m=msgById(dn.dataset.deny);if(m){dn.closest('.apcard')?.querySelectorAll('button').forEach(b=>b.disabled=true);const act=m.text.match(APPR)[1].trim();sendMsg((isG(cur)?'@'+nameOf(m.by)+' ':'')+(apprOwn(act)?'不用了：'+act:'不要做：'+act+'。這件事先停下，不用再問。'))}return}
  const al=t.closest('[data-always]');if(al){const m=msgById(al.dataset.always);if(m)alwaysSheet(m);return}
  const sa=t.closest('[data-skalways]');if(sa){const m=msgById(sa.dataset.skalways);if(m){sa.closest('.apcard')?.querySelectorAll('button').forEach(b=>b.disabled=true);sendMsg((isG(cur)?'@'+nameOf(m.by)+' ':'')+'核准：'+m.text.match(APPR)[1].trim()+'（以後這類事一律允許：同一個來源、沒有程式的技能）')}return}   // 4.12: trust this repo for skills without programs
  const ap=t.closest('[data-approve]'),rv=t.closest('[data-revise]');
  if(ap||rv){const m=msgById((ap||rv).dataset[ap?'approve':'revise']);if(!m)return;
    const at=isG(cur)?'@'+nameOf(m.by)+' ':'';
    if(ap){ap.closest('.apcard')?.querySelectorAll('button').forEach(b=>b.disabled=true);sendMsg(at+'核准：'+m.text.match(APPR)[1])}   // one press: the card turns into 已核准 right away
    else{const f=!rv.dataset.plan&&apprFields(m.text);
      if(f&&(f.to||f.content||f.when)){AED.mid=m.id;AED.content=f.content||f.act;AED.when=f.when;AED.focus='content';renderChat(false);return}   // 4.7: edit the text right in the card
      $('msg').value=at+(rv.dataset.plan?I18N.t('計畫要改：'):'');grow();$('msg').focus()}
    return}
  const nt=t.closest('[data-note]');if(nt){const k=nt.dataset.note;NOTEOPEN.has(k)?NOTEOPEN.delete(k):NOTEOPEN.add(k);renderChat(false);return}
  const ao=t.closest('[data-apopen]');if(ao){const id=+ao.dataset.apopen;APOPEN.has(id)?APOPEN.delete(id):APOPEN.add(id);renderChat(false);return}
  if(t.closest('[data-aecancel]')){AED.mid=null;renderChat(false);return}
  const as=t.closest('[data-aesend]');if(as){const m=msgById(as.dataset.aesend);if(m){as.disabled=true;apprEditSend(m)}return}
  const jp2=t.closest('[data-jpause]');if(jp2){jobPause(+jp2.dataset.jpause,jp2.dataset.on==='1',jp2);return}
  if(t.closest('[data-jstop]')){const b=t.closest('[data-jstop]');b.disabled=true;api('cancel','POST',{conv:cur}).then(()=>{toast(I18N.t('已停止'));refresh()}).catch(err=>{b.disabled=false;toast(err.message)});return}};
$('msgs').addEventListener('input',e=>{const k=e.target.dataset?.aedit;if(k)AED[k]=e.target.value});
$('msgs').addEventListener('keydown',e=>{if(e.target.dataset?.aedit&&e.key==='Escape'){AED.mid=null;renderChat(false)}});

/* ---------- reply to one message, copy, send it on ---------- */
function paintReply(){const bar=$('replybar');if(!bar)return;const on=!!(replyTo&&replyTo.conv===cur);bar.hidden=!on;if(!on)return;
  $('replyWho').textContent=I18N.t('回覆')+' '+replyTo.who;$('replyBit').textContent=replyTo.text||I18N.t('（這則沒有文字）')}
function setReply(m){if(!m||m.tmp)return;
  replyTo={id:m.id,conv:cur,who:nameOf(m.by),text:String(m.text||'').replace(/\s+/g,' ').trim().slice(0,80)};
  paintReply();$('msg').focus()}
$('replyx').onclick=()=>{replyTo=null;paintReply();$('msg').focus()};
holdOn($('msgs'),t=>t.closest('[data-dragmsg]'),(bub,e)=>{const m=msgById(bub.closest('[data-mid]')?.dataset.mid);if(m)msgMenu(e?pointAnchor(e.clientX,e.clientY):bub,m)});
function msgMenu(anchor,m){if(!m||m.tmp)return;
  popMenu(anchor,`${mi('re','reply','回覆這則')}${mi('cp','copy','複製文字')}${mi('frag','edit','選取片段')}${mi('to','external','傳給別的機器人…')}${m.by==='me'?mi('again','refresh','再傳一次'):''}`,
   {re:()=>setReply(m),
    cp:()=>navigator.clipboard?.writeText(m.text||'').then(()=>toast(I18N.t('已複製'))).catch(()=>{}),
    frag:()=>fragmentSheet(m),
    to:()=>pickTarget(m),
    again:()=>sendMsg(m.text==='（附件）'?'':m.text,(m.files||[]).map(f=>f.id),m.files||[])})}
function fragmentSheet(m){const text=m?.text||'';
  openSheet(`${sheetHead('選取片段','拖過要複製的文字，或一次複製全部。')}<div id="frag" class="frag" tabindex="0" data-u>${text?esc(text):''}</div><div class="acts"><button type="button" class="ghost" id="sx">關閉</button><button type="button" class="ghost" id="fragAll">複製全部</button><button type="button" class="btn" id="fragBit">複製選取的片段</button></div>`);
  $('sx').onclick=closeSheet;
  const copy=t=>{if(!String(t||'').trim()){toast(I18N.t('沒有文字'));return}navigator.clipboard?.writeText(t).then(()=>{toast(I18N.t('已複製'));closeSheet()}).catch(()=>toast(I18N.t('沒有複製到')))};
  $('fragAll').onclick=()=>copy(text);
  $('fragBit').onclick=()=>{const sel=window.getSelection?.();const bit=String(sel||'').trim();const node=sel?.anchorNode;if(!bit||!node||!$('frag').contains(node)){toast(I18N.t('先在上面選一段'));return}copy(bit)}}
// the phone has no drag: pick who gets a copy, then the same 確定要複製？ as a drag
function pickTarget(m){const list=[...S.groups,...S.bots].filter(c=>c.id!==cur);
  if(!list.length){toast(I18N.t('還沒有別的機器人'));return}
  const msg={id:m.id,conv:cur,text:m.text||'',files:(m.files||[]).map(f=>({id:f.id,name:f.name,mime:f.mime}))};
  openSheet(`${sheetHead('傳給誰？','會先問你確定要複製，那邊收到後就開始處理。')}<div class="rows">${list.map(c=>`<button type="button" class="rrow" data-to="${esc(c.id)}"><span class="av${isG(c.id)?' grp':''}"${isG(c.id)?'':' data-u'}>${isG(c.id)?gStack(c):avOf(c.id)}</span><span class="t"><b data-u>${esc(c.name)}</b><small data-u>${esc(isG(c.id)?I18N.t('群組'):(c.task||'').replace(/\s+/g,' ').slice(0,40))}</small></span>${ic('chev','sa')}</button>`).join('')}</div>
    <div class="acts"><button type="button" class="ghost" id="sx">取消</button></div>`);
  $('sx').onclick=closeSheet;
  $('veil').querySelectorAll('[data-to]').forEach(b=>b.onclick=()=>askCopy(b.dataset.to,msg))}

/* ---------- a group member asks you something: a side card to answer that one bot ---------- */
function askDismissed(){try{return JSON.parse(store.get('octa_askx')||'[]')}catch(e){return []}}
function openAsks(){if(!cur||!isG(cur))return [];const c=conv(cur);if(!c)return [];const ms=chatMsgs(cur).filter(m=>!m.tmp&&m.by!=='sys'),gone=askDismissed(),out=[];
  for(const id of c.members){const b=bot(id);if(!b)continue;let i=ms.length-1;while(i>=0&&ms[i].by!==id)i--;
    if(i<0||!ASKRE.test(String(ms[i].text))||/@\S/.test(String(ms[i].text).trim().split('\n').pop())||gone.includes(ms[i].id))continue;   // a question @ another member isn't for you
    const after=ms.slice(i+1),mine=after.filter(m=>m.by==='me');
    if(mine.some(m=>m.text.includes('@'+b.name))||(after[0]&&after[0].by==='me'&&!/@\S/.test(after[0].text)))continue;
    out.push({b,m:ms[i]})}
  return out}
function renderAsks(){const p=$('askp');if(!p)return;const list=openAsks(),key=list.map(x=>x.m.id).join(',');
  document.body.classList.toggle('asking',!!list.length);if(!list.length){p.hidden=true;p.dataset.k='';return}
  if(p.dataset.k===key&&!p.hidden)return;   // same questions: keep what you are typing
  const typed={};p.querySelectorAll('.askc').forEach(c=>{typed[c.dataset.mid]=c.querySelector('textarea').value});
  p.dataset.k=key;p.hidden=false;const wasOpen=p.classList.contains('open');
  p.innerHTML=`<button type="button" class="askt"><span>❓ ${list.length===1?`<span data-u>${esc(list[0].b.name)}</span> <span>有問題要問你</span>`:'<span>機器人有問題要問你</span>'}</span><span class="pill">${list.length}</span></button>`+list.map(({b,m})=>{const q=askText(m.text),tail=q.length>400?q.slice(0,400)+'…':q;
    return `<div class="askc" data-mid="${m.id}" data-name="${esc(b.name)}"><div class="askh"><span class="av sm" data-u>${avOf(b.id)}</span><b data-u>${esc(b.name)}</b><small>私下問你</small><button type="button" class="ib sm askx" aria-label="之後再說">${ic('x')}</button></div>
      <div class="askq" data-u>${esc(tail)}</div>${askOpts(m.text).length?`<div class="opts">${askOpts(m.text).map(v=>`<button type="button" data-aopt="${esc(v)}" data-u>${esc(v)}</button>`).join('')}</div>`:''}<textarea rows="2" placeholder="${esc(I18N.t('回覆給'))} ${esc(b.name)}${esc(I18N.t('（只有它會收到）'))}">${esc(typed[m.id]||'')}</textarea>
      <div class="row2"><button type="button" class="btn sm askgo">回覆</button><button type="button" class="ghost sm askto">在對話中查看</button></div></div>`}).join('');
  if(wasOpen)p.classList.add('open');
  p.querySelector('.askt').onclick=()=>{p.classList.toggle('open');if(p.classList.contains('open'))p.querySelector('textarea')?.focus()};
  p.querySelectorAll('.askc').forEach(c=>{const ta=c.querySelector('textarea'),go=async()=>{const v=ta.value.trim();if(!v)return ta.focus();c.querySelector('.askgo').disabled=true;
      if(await sendMsg('@'+c.dataset.name+' '+v)){p.dataset.k=''}else c.querySelector('.askgo').disabled=false};
    c.querySelector('.askgo').onclick=go;c.querySelectorAll('[data-aopt]').forEach(b=>b.onclick=()=>{ta.value=b.dataset.aopt;go()});ta.onkeydown=e=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();go()}};
    c.querySelector('.askx').onclick=()=>{const g=askDismissed();g.push(+c.dataset.mid);store.set('octa_askx',JSON.stringify(g.slice(-200)));p.dataset.k='';renderAsks()};
    c.querySelector('.askto').onclick=()=>{const el=document.querySelector(`#msgs [data-mid="${c.dataset.mid}"]`);if(el)el.scrollIntoView({block:'center',behavior:'smooth'});else $('msgs').scrollTop=$('msgs').scrollHeight}})}
