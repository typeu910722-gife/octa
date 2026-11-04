/* OCTA web app — plain functions without page state (approval cards, routine status, group members, chat questions).
   test/app-ui.test.mjs loads this file on its own, so nothing here may touch the page or other scripts. */
const APPR=/^✅\s*待確認[:：]\s*(.+)$/m;
// what became of a ✅待確認 card, read from the messages after it (評論：「核准框有時候沒人看到」「按了就結束」)
//   wait: still needs you · ok / no: you approved / refused (at = when) · answered: you replied in words · stale: the bot moved on
function apprDecision(m,after,who){const a=String(m?.text||'').match(APPR);if(!a)return null;const act=a[1].trim(),plan=/^照計畫/.test(act);
  for(const x of after||[]){
    if(x.by==='me'){const t=String(x.text||'').trim(),to=t.match(/^@(\S+)/);
      if(to&&who&&to[1]!==who)continue;   // in a group, words for another member
      const s=t.replace(/^@\S+\s+/,'');
      if(/^核准[:：]/.test(s))return {state:'ok',act,plan,at:x.ts,always:/一律允許/.test(s)};
      if(/^(不要做|不用了)[:：]/.test(s))return {state:'no',act,plan,at:x.ts};
      return {state:'answered',act,plan,at:x.ts}}
    if(x.by===m.by)return {state:'stale',act,plan,at:x.ts}}
  return {state:'wait',act,plan}}
// what the action will touch: the bot's own 「影響：」 line, otherwise a plain guess from the words
// OCTA's own cards (建立排程／記住規則／整理排程): only 核准 or 不用了
const apprOwn=act=>/^(建立排程|記住規則|整理排程)[:：]/.test(String(act||''));
const APPR_IMPACT=[[/^照計畫/,'照計畫開始做，做完會回報'],[/^建立排程[:：]/,'會新增一個例行任務，時間到就自動執行'],[/^記住規則[:：]/,'會寫進它的規則，之後每次工作都照做'],[/^整理排程[:：]/,'會修改或合併現有的例行任務'],[/更新規則/,'會改寫它的規則，之後每次工作都照新規則做'],[/付款|付錢|轉帳|刷卡|扣款|購買|下單|儲值/,'會花錢，付出去就收不回來'],
  [/刪除|刪掉|清空|移除|作廢/,'刪掉後無法復原'],[/傳送|發送|送出|傳給|寄出|回覆|發訊息|貼文|發布|公告/,'訊息會送到對方那邊，送出就收不回來'],
  [/訂房|預訂|預約|取消|退訂|改期/,'會改到訂單或預約'],[/提交|表單|申請|報名|登記/,'會正式送出申請或表單'],[/密碼|帳號|權限/,'會動到帳號或權限']];
function apprImpact(act,text){const own=String(text||'').match(/^\s*(?:會)?影響[:：]\s*(.+)$/m);if(own)return own[1].trim();
  for(const [re,t] of APPR_IMPACT)if(re.test(String(act||'')))return t;return '照上面寫的去做，做完會回報'}
// the card says it all: take the ✅ line (and an 影響 line) out of the message above it
// 4.7: also the 對象：／內容：／時間： lines under it (shown on the card instead)
const APPR_LINE=/^\s*✅\s*待確認[:：]/,APPR_KEY=/^\s*(對象|內容|時間|預計時間|送出時間)\s*[:：]/,MARK_LEAD=/^\s*[✅⚠❓📌⏰🧩📝🗺📍📇📘🧭@]/u;
const apprStrip=t=>{const L=String(t||'').replace(/\r/g,'').split('\n'),out=[];let inCard=false,inBody=false;
  for(const l of L){if(APPR_LINE.test(l)){inCard=true;inBody=false;continue}
    if(/^\s*(?:會)?影響[:：]/.test(l)){inBody=false;continue}
    if(inCard&&APPR_KEY.test(l)){inBody=/^\s*內容/.test(l);continue}
    if(inCard&&inBody&&l.trim()&&!MARK_LEAD.test(l))continue;   // the rest of a long 內容
    if(inCard&&l.trim())inCard=inBody=false;
    out.push(l)}
  return out.join('\n').replace(/\n{3,}/g,'\n\n').trim()};
/* 4.7 the card's fields: what (act), to whom (to), the full text (content), when it goes out (when), what it touches (impact).
   The bot writes them under ✅待確認 (all optional); 內容 may run over several lines. null: no card in this message */
function apprFields(t){const L=String(t||'').replace(/\r/g,'').split('\n'),i=L.findIndex(l=>APPR_LINE.test(l));if(i<0)return null;
  const f={act:L[i].replace(/^\s*✅\s*待確認[:：]\s*/,'').trim(),to:'',content:'',when:'',impact:''};let k=null;
  const K={對象:'to',內容:'content',時間:'when',預計時間:'when',送出時間:'when',影響:'impact',會影響:'impact'};
  for(let j=i+1;j<L.length;j++){const l=L[j],m=l.match(/^\s*(對象|內容|時間|預計時間|送出時間|會?影響)\s*[:：]\s*(.*)$/);
    if(m){k=K[m[1]];f[k]=(f[k]?f[k]+'\n':'')+m[2];continue}
    if(k==='content'&&!MARK_LEAD.test(l)){f.content+='\n'+l;continue}
    if(l.trim())k=null}
  for(const x of ['to','content','when','impact'])f[x]=f[x].trim();
  f.content=f.content.replace(/^「([\s\S]*)」$/,'$1').trim();
  return f}
// a routine's last and next run (fields from the API: last_run, last_status, last_text, next_run)
function rtStatus(r){if(!r)return null;const st={done:'ok',error:'err',skipped:'skip'}[r.last_status]||(r.last_run?'run':'');
  return {last:+r.last_run||0,st,next:r.enabled!==false&&+r.next_run?+r.next_run:0,text:String(r.last_text||'').slice(0,140),job:r.last_job||null}}
// a group member right now: working (with its progress line), queued, waiting on you, or free
function memberState(id,busy,asks){const run=(busy||[]).find(x=>x.bot_id===id&&x.status==='running');
  if(run)return {k:'run',p:progOf(run.progress).text};
  if((asks||[]).includes(id))return {k:'ask'};
  if((busy||[]).some(x=>x.bot_id===id&&x.status==='pending'))return {k:'queue'};
  return {k:'idle'}}
/* a bot asks you something: the question itself (the ❓ line(s), otherwise the last paragraph) */
const ASKRE={test:t=>/❓/.test(t)||/[？?]\s*$/.test(String(t).trim())};
const askText=t=>{t=String(t);const q=t.split('\n').filter(l=>/❓/.test(l)).map(l=>l.replace(/^\s*❓\s*(問你[:：])?\s*/,''));if(q.length)return q.join('\n');const ps=t.trim().split(/\n\s*\n/);return ps[ps.length-1]};
// "A. 現在重新查 B. 用剛才那份就好" at the end of a question → buttons
const askOpts=t=>{const q=askText(t).split('\n').pop()||'';const out=[];const re=/(?:^|[\s（(：:，,？?。])([A-Da-d])[.．、)）]\s*([^\n]+?)(?=\s*(?:[\s（(，,；;？?。]|^)[A-Da-d][.．、)）]|[？?）)]*\s*$)/g;let m;while((m=re.exec(q))&&out.length<4){const v=m[2].replace(/[？?。]+$/,'').trim();if(v)out.push(m[1].toUpperCase()+'. '+v)}return out.length>=2?out:[]};
// version numbers: -1, 0 or 1
const verCmp=(a,b)=>{const p=v=>String(v||'').replace(/^v/i,'').split(/[.-]/).map(x=>parseInt(x,10)||0);const x=p(a),y=p(b);for(let i=0;i<Math.max(x.length,y.length);i++){const d=(x[i]||0)-(y[i]||0);if(d)return d<0?-1:1}return 0};
// a bot is called with @名字, so its name may not hold spaces (an old name with spaces may stay)
const nameProblem=(v,old)=>{v=String(v||'').trim();if(!v)return '請填名稱';if(/[\s　]/.test(v)&&v!==old)return '名稱不能有空格，才能用 @ 叫它';return ''};
// the pairing code shown on the computer: 8 letters/digits; spaces, dashes and case don't matter
const pairCode=v=>String(v||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
// a name for a new bot that no other bot has yet
const freeName=(base,taken)=>{const s=new Set(taken);if(!s.has(base))return base;for(let n=2;;n++)if(!s.has(base+n))return base+n};
/* ---------- 4.1: the octopus avatar, its colour, and what it is doing ---------- */
// the palette a bot's colour is picked from (desktop/api/engines.mjs has the same list); the first is the default gold
const PALETTE=[['#D6B27A','金'],['#E8A87C','杏桃'],['#D98B5F','陶土'],['#E58C8A','珊瑚'],['#E79AB5','玫瑰'],['#C58BC8','梅紫'],['#B9A3E3','丁香'],
  ['#9DB4F0','長春花'],['#7EC4E6','天空'],['#6CC5B8','湖水'],['#9BD39A','薄荷'],['#BFCB7A','抹茶'],['#C8B6A0','奶茶'],['#9FAAB8','石板']];
const OC_DEFAULT='#D6B27A',OC_STAR='#E2A93B';
const colorHex=c=>{const v=String(c||'').trim().toUpperCase();return /^#[0-9A-F]{6}$/.test(v)?v:''};
// the star under the octopus: the same hue as its body, richer and a little darker (the default gold keeps its own star)
function accentOf(c){const hex=colorHex(c)||OC_DEFAULT;if(hex===OC_DEFAULT)return OC_STAR;
  const n=parseInt(hex.slice(1),16),r=(n>>16&255)/255,g=(n>>8&255)/255,b=(n&255)/255,mx=Math.max(r,g,b),mn=Math.min(r,g,b),l=(mx+mn)/2,d=mx-mn;
  let h=0,s=0;if(d){s=d/(1-Math.abs(2*l-1));h=(mx===r?((g-b)/d+6)%6:mx===g?(b-r)/d+2:(r-g)/d+4)*60}
  const s2=Math.min(.78,s+.14),l2=Math.max(.45,l-.08),a=s2*Math.min(l2,1-l2);
  const ch=k=>{const q=(k+h/30)%12;return Math.round((l2-a*Math.max(-1,Math.min(q-3,9-q,1)))*255).toString(16).padStart(2,'0')};
  return ('#'+ch(0)+ch(8)+ch(4)).toUpperCase()}
// what a bot is doing, for its avatar: idle · thinking (started, nothing to show yet) · working · browsing · chatting (with another bot)
const BROWSE_RE=/^(第 \d+ 步：|打開 \S|點擊「|在「[^」]*」輸入|填寫表單|讀取網頁(內容|資料)?$|截圖|選擇選項|切換分頁|等待網頁載入|按鍵盤|回上一頁|操作瀏覽器|自己重新登入)/;
function botState(id,busy){const run=(busy||[]).find(x=>x.bot_id===id&&x.status==='running');if(!run)return 'idle';
  if(+run.bg)return 'chatting';
  if(run.kind==='open')return 'browsing';
  const pr=progOf(run.progress),p=pr.text;
  if(pr.kind==='browse')return 'browsing';
  if(!p||/^(開始工作|AI 沒有回應)/.test(p))return pr.total?'working':'thinking';
  return BROWSE_RE.test(p)?'browsing':'working'}
/* what belongs in the conversation and what goes to the work panel (工作) beside it.
   The chat keeps what you said, the bots' replies, pictures, files, approval cards and questions for you.
   bgKeys: "bot|first 60 characters" of answers to background requests (older messages carry no kind). */
const LOGIN_NOTE=/需要你在電腦上登入|需要使用者在電腦上登入/;
const bgKey=(by,text)=>by+'|'+String(text||'').replace(/\s+/g,' ').trim().slice(0,60);
function msgPlace(m,bgKeys){if(!m)return 'work';
  if(m.tmp||m.by==='me')return 'chat';
  if(m.kind==='bg'||m.kind==='fail'||m.kind==='note')return 'work';
  if(m.by==='sys')return LOGIN_NOTE.test(String(m.text||''))?'chat':'work';
  if(bgKeys&&bgKeys.has(bgKey(m.by,m.text)))return 'work';
  return 'chat'}
/* 4.2 手機遙控: where a touch on the live picture lands on the bot's page, in the page's CSS pixels.
   pt: the touch {x,y} on the screen · box: the picture area's rect {left,top,width,height} (before the person's zoom)
   img: the frame's size in pixels {w,h}; it is drawn whole inside box (object-fit:contain), centred both ways
   view: the person's own pinch-zoom and pan of the picture {s,x,y} (transform: translate(x,y) scale(s), origin top-left)
   meta: the browser's screencast metadata {deviceWidth,deviceHeight} in DIP (frames from a 2× screen are 2× bigger:
   without metadata dpr says how many frame pixels make one DIP) · zoom: the page's own zoom (CSS px = DIP / zoom).
   null when the touch is on the empty band around the picture (clamp: the nearest edge of the picture instead, for
   a drag that starts there). per: page CSS px moved per screen px dragged. */
function scrMap(pt,o){const box=o.box,img=o.img,v=o.view||{s:1,x:0,y:0},meta=o.meta||{},zoom=+o.zoom||1,dpr=+o.dpr||1;
  if(!box||!img||!(img.w>0)||!(img.h>0)||!(box.width>0)||!(box.height>0))return null;
  const lx=(pt.x-box.left-v.x)/v.s,ly=(pt.y-box.top-v.y)/v.s;
  const k=Math.min(box.width/img.w,box.height/img.h),dw=img.w*k,dh=img.h*k,ox=(box.width-dw)/2,oy=(box.height-dh)/2;
  let fx=(lx-ox)/dw,fy=(ly-oy)/dh;
  if(o.clamp){fx=Math.min(1,Math.max(0,fx));fy=Math.min(1,Math.max(0,fy))}
  if(fx<0||fx>1||fy<0||fy>1)return null;
  const W=+meta.deviceWidth||img.w/dpr,H=+meta.deviceHeight||img.h/dpr;
  const r=n=>Math.round(n*10)/10;
  return {x:r(fx*W/zoom),y:r(fy*H/zoom),per:W/zoom/(dw*v.s)}}
// 4.4 the phone's stable entry (the OCTA site's /go page) opens this app at the computer's current address with
//   #t=<this phone's session token>&web=<bot>&go=<where /go is>
// The token is kept and the fragment taken out of the address bar. go: only the OCTA site (or this computer, for tests).
function octaFrag(hash){const p=new URLSearchParams(String(hash||'').replace(/^#/,'')),o={};
  const t=p.get('t')||'',web=p.get('web')||'',go=p.get('go')||'';
  if(/^[A-Za-z0-9_-]{16,200}$/.test(t))o.t=t;
  if(/^[\w-]{1,64}$/.test(web))o.web=web;
  if(/^(https:\/\/octa\.yzprojecttw\.com|http:\/\/(127\.0\.0\.1|localhost)(:\d+)?)\/go$/.test(go))o.go=go;
  return o}
// the link that sets up /go on this phone (what it keeps: the relay key, which computer, this phone's token)
function goLink(base,g,token,url){const p=new URLSearchParams();for(const [k,v] of [['tp',g.tp],['k',g.k],['h',g.h],['n',g.n],['u',url],['t',token]])if(v)p.set(k,v);return base+'#'+p.toString()}

/* ---------- 4.7: live progress, the bots' markers as chips, layered replies, colleagues ---------- */
/* a running job's progress: jobs.progress is JSON {text, step, total, steps, kind, at} (or already parsed by the API);
   older runners report one plain line, which is read as {text} */
function progOf(p){if(p&&typeof p==='object')return progNorm(p);const s=String(p??'').trim();if(!s)return progNorm({});
  if(s[0]==='{'){try{const o=JSON.parse(s);if(o&&typeof o==='object')return progNorm(o)}catch(e){}}
  return progNorm({text:s})}
function progNorm(o){const steps=Array.isArray(o.steps)?o.steps.map(x=>String(x??'').replace(/\s+/g,' ').trim()).filter(Boolean).slice(0,30):[];
  let total=Math.round(+o.total)>0?Math.round(+o.total):steps.length,step=Math.round(+o.step)>0?Math.round(+o.step):0;
  if(total&&step>total)step=total;
  return {text:String(o.text??'').replace(/\s+/g,' ').trim(),step,total,steps,kind:['browse','think','tool','ask'].includes(o.kind)?o.kind:'',at:+o.at||0}}
/* what the progress line, bar and step list show. step is the one being done now (1-based).
   has: a known 「步驟 2/5」 · pct: the bar · cur: the words · list: each step done / now / next */
function progView(raw){const p=progOf(raw),has=p.total>0&&p.step>0;
  const list=p.steps.map((t,i)=>({t,st:!p.step?'next':i<p.step-1?'done':i===p.step-1?'now':'next'}));
  const cur=p.text||(has&&p.steps[p.step-1])||'';
  return {...p,has,pct:has?Math.min(100,Math.max(4,Math.round((p.step-.5)/p.total*100))):0,cur,list}}
/* the bot's own markers, taken out of the conversation and shown as small chips under the message.
   notes: [{type: task|memory|skill|routine|site|page, title, body, when?, op?}] · result: the ✅ 完成／⚠ 沒做成 line {ok, text}
   steps: the 🧭步驟 list (never shown in the chat). The same markers the API takes out of new replies (contract §3). */
function parseNotes(src){let t=String(src??'').replace(/\r/g,'');const notes=[],steps=[];let result=null;
  const add=(type,title,body,x)=>notes.push({type,title:String(title||'').trim(),body:String(body||'').trim(),...(x||{})});
  t=t.replace(/【派瀏覽】[\s\S]*?(?:【派完】|$)/g,'')
    .replace(/📝\s*任務更新[:：]?[ \t]*([\s\S]*?)(?:📝\s*結束|$)/gu,(_,b)=>{add('task','',b);return ''})
    .replace(/🧩\s*技能[:：]\s*([^\n]*)\n?([\s\S]*?)(?:🧩\s*結束|$)/gu,(_,n,b)=>{add('skill',n,b);return ''});
  const out=[];
  for(const l of t.split('\n')){let m;
    if((m=l.match(/^\s*📌\s*記住[:：]\s*(.*)$/u))){add('memory','',m[1]);continue}
    if((m=l.match(/^\s*📇\s*事實[:：]\s*(.*)$/u))){add('memory','',m[1],{fact:true});continue}
    if((m=l.match(/^\s*📘\s*手冊[:：]\s*([^｜|]*)[｜|]?\s*(.*)$/u))){add('skill',m[1],m[2],{manual:true});continue}
    if((m=l.match(/^\s*⏰\s*例行任務[:：]\s*(.+?)\s*[｜|]\s*(.+?)\s*[｜|]\s*(.*)$/u))){add('routine',m[1],m[3],{when:m[2]});continue}
    if((m=l.match(/^\s*⏰\s*(刪除|停用|啟用)(?:例行任務)?[:：]\s*(.*)$/u))){add('routine',m[2],'',{op:m[1]});continue}
    if((m=l.match(/^\s*⏰\s*例行任務[:：]\s*(.*)$/u))){add('routine',m[1],'');continue}
    if((m=l.match(/^\s*🗺️?\s*網站筆記[:：]\s*([^｜|]*)[｜|]?\s*(.*)$/u))){add('site',m[1],m[2]);continue}
    if((m=l.match(/^\s*📍\s*目前頁面[:：]\s*(.*)$/u))){add('page',m[1],'');continue}
    if((m=l.match(/^\s*🧭\s*步驟[:：]\s*(.*)$/u))){steps.push(...m[1].split(/\s*[｜|]\s*/).map(x=>x.trim()).filter(Boolean));continue}
    if((m=l.match(/^\s*✅\s*完成[:：]\s*(.*)$/))){result={ok:true,text:m[1].trim()};continue}
    if((m=l.match(/^\s*⚠️?\s*沒做成[:：]\s*(.*)$/u))){result={ok:false,text:m[1].trim()};continue}
    if(/^\s*【(開瀏覽器|關瀏覽器|稍後|派完)】/.test(l))continue;
    out.push(l.replace(/【回覆】\s*/g,''))}
  return {text:out.join('\n').replace(/\n{3,}/g,'\n\n').trim(),notes,result,steps}}
// messages.meta (JSON text or an object): {notes, result} the API already took out of the text
function msgMeta(m){let x=m?.meta;if(typeof x==='string'){try{x=JSON.parse(x)}catch(e){x=null}}return x&&typeof x==='object'&&!Array.isArray(x)?x:null}
// what a bot's message shows: the human text, its chips and its result (meta first, then whatever is still in the text)
function msgView(m){const p=parseNotes(m?.text),meta=msgMeta(m),seen=new Set(),notes=[];
  for(const n of [...(Array.isArray(meta?.notes)?meta.notes:[]),...p.notes]){if(!n||!n.type)continue;
    const v={...n,type:String(n.type),title:String(n.title??'').trim(),body:String(n.body??'').trim()},k=v.type+'|'+v.title+'|'+v.body;
    if(seen.has(k))continue;seen.add(k);notes.push(v)}
  const mr=meta?.result,result=mr&&typeof mr==='object'&&(mr.text||mr.ok!=null)?{ok:mr.ok!==false,text:String(mr.text||'').trim()}:p.result;
  return {text:p.text,notes,result}}
/* one chip per kind (several 📌 make one 「已記住 3 條規則」; each ⏰ is its own). daily: the time reads 「每天 09:00」 */
const NOTE_ORDER=['routine','memory','skill','task','site','page'];
const NOTE_ICON={task:'📝',memory:'📌',skill:'🧩',routine:'⏰',site:'🗺️',page:'📍'};
const hostOf=u=>{try{return new URL(u).host||u}catch(e){return u}};
function noteChips(notes){const by={},out=[];for(const n of notes||[])(by[n.type]||(by[n.type]=[])).push(n);
  for(const type of [...NOTE_ORDER,...Object.keys(by).filter(k=>!NOTE_ORDER.includes(k))]){const ns=by[type];if(!ns)continue;
    if(type==='routine'){for(const n of ns){let w=String(n.when||'').trim(),name=n.title,what=n.body;
        if(!w&&!n.op){const p=[name,what].filter(Boolean).join('｜').split(/\s*[｜|]\s*/);if(p.length>=3)[name,w,what]=[p[0],p[1],p.slice(2).join('｜')]}   // meta may keep 名稱｜時間｜事 in one field
        const daily=/^\d{1,2}:\d{2}([,，、\s]+\d{1,2}:\d{2})*$/.test(w);
        out.push({type,icon:NOTE_ICON.routine,label:n.op?{刪除:'已刪除例行任務',停用:'已停用例行任務',啟用:'已啟用例行任務'}[n.op]||'例行任務':'已排程',
          daily,when:daily?w.split(/[,，、\s]+/).join('、'):w,name,items:[{...n,title:name,body:what,when:w}]})}continue}
    if(type==='memory')out.push({type,icon:NOTE_ICON.memory,label:'已記住',n:ns.length,items:ns});
    else if(type==='skill')out.push({type,icon:NOTE_ICON.skill,label:ns.every(n=>n.manual)?'做事手冊':'新技能',name:ns.map(n=>n.title).filter(Boolean).join('、'),items:ns});
    else if(type==='task')out.push({type,icon:NOTE_ICON.task,label:'已更新指定任務',items:ns});
    else if(type==='site')out.push({type,icon:NOTE_ICON.site,label:'網站筆記',name:ns.map(n=>n.title).filter(Boolean).join('、'),items:ns});
    else if(type==='page')out.push({type,icon:NOTE_ICON.page,label:'目前頁面',name:ns.map(n=>hostOf(n.title||n.body)).join('、'),items:ns});
    else out.push({type,icon:'•',label:'紀錄',name:type,items:ns})}
  return out}
/* 回覆分層: a long reply opens with its first paragraph; the rest (tables, lists, details) folds under 「展開詳細」 */
const FOLD_MIN=260,MD_BLOCK=/^\s*(```|#{1,4}\s|[-*•]\s|\d+[.)]\s|>|\|)/;
function foldReply(src){const t=String(src??'').trim();if(!t)return {head:'',rest:''};
  const L=t.split('\n');if(MD_BLOCK.test(L[0]))return {head:t,rest:''};
  let i=0;while(i<L.length&&L[i].trim()&&!MD_BLOCK.test(L[i]))i++;
  const head=L.slice(0,i).join('\n').trim(),rest=L.slice(i).join('\n').trim();
  if(!rest||(t.length<=FOLD_MIN&&L.length<=8&&!/^\s*\|/m.test(rest)))return {head:t,rest:''};
  return {head,rest}}
/* 同事協作: the background requests between bots (/api/backstage rows) as a timeline.
   st: wait (queued) · run (the colleague is on it) · ok (answered) · fail · dur: how long it took, or has been waiting so far */
function collabItems(items,now){now=now||Date.now();return (items||[]).map(x=>{const st=x.status==='pending'?'wait':x.status==='running'?'run':x.status==='error'?'fail':'ok';
  return {id:x.id,from:x.from,to:x.to,kind:x.kind==='give'?'give':'ask',what:String(x.what||''),reply:String(x.reply||''),st,at:+x.created||0,
    dur:st==='wait'||st==='run'?Math.max(0,now-(+x.created||now)):x.ms!=null?+x.ms:null}})}
// a bot here waiting on a colleague right now: its oldest open request {from, to, since, dur, kind, n} or null
function collabWait(items,ids,now){const open=collabItems(items,now).filter(x=>(x.st==='wait'||x.st==='run')&&(ids||[]).includes(x.from)).sort((a,b)=>a.at-b.at);
  const x=open[0];return x?{from:x.from,to:x.to,since:x.at,dur:x.dur,kind:x.kind,n:open.length}:null}
// whole minutes for 「等 研究員 回覆 3 分鐘」
const minsOf=ms=>Math.max(0,Math.floor((+ms||0)/60000));
