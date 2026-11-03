/* OCTA web app — 例行任務 (routines): times, web-page watch, external hook; last/next run. */
'use strict';
const hm12=t=>{const [h,m]=t.split(':').map(Number);return new Date(2000,0,1,h,m).toLocaleTimeString(I18N.lang,{hour:'numeric',minute:'2-digit'})};
const EVERY=[0,15,30,60,120,240];
const everyText=n=>n>=60?I18N.t('每')+' '+(n/60)+' '+I18N.t('小時'):I18N.t('每')+' '+n+' '+I18N.t('分鐘');
/* 4.5 交接網址: the public address on the OCTA site (the server says which: /api/config `hook`). It is forwarded to
   this computer's tunnel (found again through ntfy.sh after every restart), so it never changes; the tunnel's own
   address is shown as a detail. */
let REMOTE_URL='';
const hookUrl=r=>(CFG.hook||location.origin).replace(/\/+$/,'')+'/api/hook/'+r.hook;
const hookNote=r=>`<p class="hmuted">這個網址固定不變：經 OCTA 網站轉送到這台電腦（只轉送，不保存內容），電腦重開也不用換。這台電腦要開著 OCTA 才收得到。</p>${r&&S.hookTunnel?`<details class="manual"><summary>直接連到這台電腦的網址</summary><p class="hmuted">每次電腦重開都會換，平常用上面那個。</p><p class="mono" data-u>${esc(S.hookTunnel.replace(/\/+$/,'')+'/api/hook/'+r.hook)}</p></details>`:''}`;
/* what to paste into Grok Bot (or any AI that can make web requests): the whole API with this token filled in.
   Written in English on purpose: the other AI reads it, and it is the same whatever language OCTA is shown in. */
function hookSpec(r,name){const u=hookUrl(r);return [
`OCTA hand-off API for the OCTA bot "${name}" (it works on the user's own computer; replies are in the user's language).`,
`Base URL: ${u}`,
'The URL contains a secret token. Treat it like a password: do not share it or put it anywhere public.',
'Send and receive JSON (Content-Type: application/json). A wrong token always gets HTTP 401.','',
`1) Hand over work: POST ${u}`,
'   body {"text":"what to do, with all the details","from":"Grok Bot"}  ->  {"ok":true,"job":"<job id>"}',
`2) Status and result: GET ${u}/job/<job id>`,
'   -> {"ok":true,"job":"…","status":"running|done|failed","queued":true (only while waiting),"text":"the bot\'s reply or the error","files":[{"id":"…","name":"…"}]}',
'   Ask every 15-30 seconds; most jobs take 1-10 minutes.',
`3) Inbox (finished jobs you have not read yet): GET ${u}/inbox  (add ?peek=1 to look without marking them read)`,
'   -> {"ok":true,"jobs":[{"job":"…","status":"done|failed","text":"…","files":[…],"from":"…","created":<ms>}]}',
`4) Correct a result, the bot redoes it: POST ${u}/feedback`,
'   body {"job":"<job id>","text":"what is wrong and how it should be"}  ->  {"ok":true,"job":"<new job id>"}',
`5) Teach it something to keep doing: POST ${u}/teach`,
'   body {"text":"the rule or the way to do it"}  (add "name" with numbered steps to save a step-by-step manual)  ->  {"ok":true,"saved":"rule|manual"}','',
'Limits: 120 hand-overs/feedback/teach and 900 status reads per 15 minutes; a body up to 64 KB.',
'HTTP 503 means the user\'s computer is off or offline right now: try again later. The bot may ask the user for missing details in OCTA.'].join('\n')}
document.addEventListener('click',e=>{const b=e.target.closest('[data-hookspec]');if(!b)return;const r=S.routines.find(x=>x.id===b.dataset.hookspec);if(!r||!r.hook)return;
  const c=conv(r.conv);navigator.clipboard?.writeText(hookSpec(r,c?.name||r.name)).then(()=>toast(I18N.t('已複製給外部 AI 的說明'))).catch(()=>{})});
const trigText=r=>r.hook?I18N.t('外部事件觸發'):r.watch?I18N.t('網頁有變化時')+' · '+I18N.t('每')+' '+r.watch.every+' '+I18N.t('分鐘')+I18N.t('檢查'):timesText(r.times);
const timesText=ts=>{const ev=ts.find(t=>t.startsWith('*/')),fx=ts.filter(t=>!t.startsWith('*/'));
  return [ev?everyText(+ev.slice(2)):'',fx.length?I18N.t('每天')+' '+fx.map(hm12).join(I18N.lang==='en'?', ':'、'):''].filter(Boolean).join(I18N.lang==='en'?'; ':'；')};
let rtEdit=null;
function renderRoutines(){const box=$('rt');if(!box)return;const rc=box.dataset.conv||cur,list=S.routines.filter(r=>r.conv===rc);
  box.innerHTML=list.map(r=>rtEdit===r.id?rForm(r):`<div class="rrow" data-r="${r.id}" role="button" tabindex="0"><span class="t"><b data-u>${esc(r.name)}</b><small data-u>${trigText(r)}</small>${rtLine(r)}</span><button type="button" class="sw ${r.enabled?'on':''}" data-sw="${r.id}" aria-label="${r.enabled?'停用':'啟用'}" aria-pressed="${r.enabled}"></button></div>`).join('')
   +(rtEdit==='new'?rForm(null):`<button type="button" class="ghost sm" id="rtAdd">${ic('plus')}<span>例行任務</span></button>`);
  box.querySelectorAll('[data-sw]').forEach(b=>b.onclick=async e=>{e.stopPropagation();const r=S.routines.find(x=>x.id===b.dataset.sw);
    r.enabled=!r.enabled;renderRoutines();await api('routines/'+r.id,'PUT',{enabled:r.enabled}).catch(()=>{});refresh()});
  // opening another one first saves the one being edited, so nothing typed there is lost
  const openRt=async id=>{const open=box.querySelector('.rform');if(open&&open._save&&DIRTY.parts.has('rt')&&!(await open._save(true)))return;rtEdit=id;renderRoutines()};
  box.querySelectorAll('.rrow').forEach(row=>{row.onclick=()=>openRt(row.dataset.r);row.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();openRt(row.dataset.r)}}});
  if($('rtAdd'))$('rtAdd').onclick=()=>openRt('new');
  const f=box.querySelector('.rform');if(!f)return;
  f.querySelector('[data-add]').onclick=()=>{const i=document.createElement('input');i.type='time';i.value='08:00';f.querySelector('.times').insertBefore(i,f.querySelector('[data-add]'));markDirty('rt')};
  f.querySelector('[data-cancel]').onclick=()=>{rtEdit=null;cleanDirty('rt');renderRoutines()};
  const del=f.querySelector('[data-del]');if(del)del.onclick=async()=>{if(!del.dataset.sure){del.dataset.sure=1;del.textContent=I18N.t('再按一次刪除');return}
    await api('routines/'+rtEdit,'DELETE');rtEdit=null;cleanDirty('rt');await refresh();renderRoutines()};
  const tw=f.querySelector('[name=rtrig]'),showTrig=()=>{f.querySelectorAll('[data-tr]').forEach(x=>x.hidden=x.dataset.tr!==tw.value)};tw.onchange=showTrig;showTrig();
  f.querySelectorAll('[data-copyhook]').forEach(b=>b.onclick=()=>navigator.clipboard?.writeText(b.dataset.copyhook).then(()=>toast(I18N.t('已複製'))).catch(()=>{}));
  // quiet: called by the panel's own 儲存 (or by opening another routine) — save, don't redraw into a new form
  f._save=async quiet=>{const trig=tw.value;
    if(!f.querySelector('[name=rp]').value.trim()){f.querySelector('.errmsg').textContent=I18N.t('請寫這個例行任務每次要做什麼');f.querySelector('[name=rp]').focus();return false}
    const body={name:f.querySelector('[name=rn]').value,prompt:f.querySelector('[name=rp]').value,trigger:trig==='time'?'':trig,
      watch:{url:f.querySelector('[name=wurl]').value.trim(),sel:f.querySelector('[name=wsel]').value.trim(),every:+f.querySelector('[name=wevery]').value},
      times:trig!=='time'?[]:[...(+f.querySelector('[name=rev]').value?['*/'+f.querySelector('[name=rev]').value]:[]),...[...f.querySelectorAll('.times input')].map(i=>i.value).filter(Boolean)]};
    try{let r;if(rtEdit==='new')r=await api('routines','POST',{...body,conv:rc});else r=await api('routines/'+rtEdit,'PUT',body);
      cleanDirty('rt');
      if(!quiet&&trig==='hook'&&r.hook){rtEdit=r.id||rtEdit;await refresh();renderRoutines();toast(I18N.t('已建立觸發網址'));return true}
      rtEdit=null;await refresh();if(!quiet)renderRoutines();return true}catch(err){f.querySelector('.errmsg').textContent=err.message;return false}};
  f.querySelector('[data-save]').onclick=async()=>{if(await f._save())toast(I18N.t('已儲存 ✓'))};
  f.querySelector('[name=rn]').focus();
}
/* 排程看得到有沒有跑：last run time and ✓/✗, next run, and the last result in a sentence */
function rtWhen(ts){const d=new Date(ts),n=new Date();return d.toDateString()===n.toDateString()?hm(ts):d.toLocaleString(I18N.lang,{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})}
const RT_MARK={ok:['✓','完成'],err:['✗','失敗'],skip:['–','略過'],run:['…','執行中']};
function rtLine(r){const s=rtStatus(r);if(!s||!('last_run' in r||'next_run' in r))return '';const out=[];
  if(s.last){const k=RT_MARK[s.st]||RT_MARK.run;out.push(`<span class="rs ${s.st}" title="${esc(I18N.t(k[1]))}"><span>上次</span> ${rtWhen(s.last)} <i aria-hidden="true">${k[0]}</i></span>`)}
  else if('last_run' in r)out.push('<span class="rs">還沒跑過</span>');
  if(s.next)out.push(`<span class="rs"><span>下次</span> ${rtWhen(s.next)}</span>`);else if(r.enabled===false)out.push('<span class="rs">已停用</span>');
  return out.length?`<span class="rst">${out.join('')}</span>`:''}
function rtLast(r){const s=rtStatus(r);if(!s||!s.last)return '';const k=RT_MARK[s.st]||RT_MARK.run;
  return `<div class="rlast ${s.st}"><b><span>上次</span> ${rtWhen(s.last)} · <span>${k[1]}</span></b>${s.text?`<p data-u>${esc(s.text)}</p>`:'<p class="hmuted">沒有結果摘要</p>'}</div>`}
function rForm(r){const tr=r?.hook?'hook':r?.watch?'watch':'time';return `<div class="rform">${rtLast(r)}<label class="field"><span>名稱</span><input name="rn" maxlength="40" value="${r?esc(r.name):''}" placeholder="例如：早上整理訂單"></label>
  <label class="field"><span>什麼時候開始</span><select name="rtrig"><option value="time" ${tr==='time'?'selected':''}>固定時間／每隔一段時間</option><option value="watch" ${tr==='watch'?'selected':''}>網頁有變化時（例如有新訊息、新訂單）</option><option value="hook" ${tr==='hook'?'selected':''}>外部事件（LINE、表單、Zapier 呼叫網址）</option></select></label>
  <div data-tr="watch" class="stack"><label class="field"><span>要監看的網址（機器人瀏覽器裡已登入的頁面）</span><input name="wurl" value="${esc(r?.watch?.url||'')}" placeholder="例如 https://chat.line.biz/…"></label>
    <label class="field"><span>只看頁面的某一塊（選填，CSS 選擇器）</span><input name="wsel" value="${esc(r?.watch?.sel||'')}" placeholder="例如 .chat-list"></label>
    <label class="field"><span>多久檢查一次</span><select name="wevery">${[5,10,15,30,60].map(n=>`<option value="${n}" ${(r?.watch?.every||10)===n?'selected':''}>${everyText(n)}</option>`).join('')}</select></label>
    <p class="hmuted">電腦會用這個機器人的瀏覽器在背景打開網頁比對，不花 AI 流量；內容有變化才叫機器人開始，並告訴它多了什麼。第一次只會記住目前的內容。</p></div>
  <div data-tr="hook" class="stack">${r?.hook?`<div class="field"><span>觸發網址（任何服務呼叫它就會開始）</span><div class="row2"><input readonly class="mono" value="${esc(hookUrl(r))}" data-u><button type="button" class="ghost sm" data-copyhook="${esc(hookUrl(r))}">複製</button></div></div>
    <div class="row2"><button type="button" class="ghost sm" data-hookspec="${esc(r.id)}">${ic('copy')}<span>複製給外部 AI 的說明</span></button></div><p class="hmuted">給 Grok Bot 這類會呼叫網址的 AI：貼上後它就能交派工作、查結果、指正重做、教它做法。</p>${hookNote(r)}
    <p class="hmuted">LINE 官方帳號：到 LINE Developers → 你的 Messaging API channel → Webhook URL 貼上這個網址並開啟「Use webhook」，客人一傳訊息就會觸發，訊息內容會交給機器人。其他服務（Google 表單、Zapier、IFTTT）用 POST 呼叫這個網址即可。網址等同鑰匙，不要公開。</p>`:'<p class="hmuted">儲存後會產生一個專屬的觸發網址。</p>'}</div>
  <div data-tr="time" class="stack"><label class="field"><span>每隔一段時間做一次（例如巡訊息）</span><select name="rev">${EVERY.map(n=>`<option value="${n}" ${(r?.times||[]).includes('*/'+n)?'selected':''}>${n?everyText(n):I18N.t('不用')}</option>`).join('')}</select></label>
  <div class="field"><span>每天固定的時間（可以不填）</span><div class="times">${(r?r.times.filter(t=>!t.startsWith('*/')):['08:00']).map(t=>`<input type="time" value="${t}">`).join('')}<button type="button" class="ghost sm" data-add>＋ 時間</button></div></div></div>
  <label class="field"><span>每次要做什麼（必填）</span><textarea name="rp" maxlength="2000" placeholder="例如：整理今天的入住名單，貼到這個對話">${r?esc(r.prompt||''):''}</textarea></label>
  <p class="hmuted">每個排程有自己的說明，執行時只照這段做，不會再回去讀指定任務。時間只在這裡設定。</p>
  <div class="errmsg"></div>
  <div class="acts">${r?'<button type="button" class="ghost sm danger" data-del>刪除</button>':''}<span class="grow"></span><button type="button" class="ghost sm" data-cancel>取消</button><button type="button" class="btn sm" data-save>${r?'儲存':'加入'}</button></div></div>`}
/* every routine of every bot: did it run, how did it go, when is the next one; tap for the last result */
function schedList(){const rs=S.routines.filter(r=>conv(r.conv));if(!rs.length)return '<p class="hmuted">還沒有例行任務。打開機器人的詳細資料 → 例行任務加入，或直接跟它說「每天幾點做什麼」。</p>';
  return `<div class="rows scl">${rs.map(r=>{const c=conv(r.conv);return `<details class="rsd${r.enabled?'':' off'}"><summary><span class="t"><b data-u>${esc(r.name)}</b><small><span data-u>${esc(c.name)}</span> · <span data-u>${trigText(r)}</span></small>${rtLine(r)}</span>${ic('chev','sa')}</summary>
    ${rtLast(r)||'<p class="hmuted">還沒有執行結果。</p>'}<div class="row2"><button type="button" class="ghost sm" data-rgo="${esc(r.conv)}">到對話看</button></div></details>`}).join('')}</div>`}
function standNow(ev,auto){return ev?`目前：開啟，每 ${ev} 分鐘巡查一次`:auto?'目前：關閉。填入指定任務後會自動開啟（每 30 分鐘巡查一次）':'目前：關閉'}
