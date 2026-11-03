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
const apprStrip=t=>String(t||'').replace(/^✅\s*待確認[:：].*$/gm,'').replace(/^\s*(?:會)?影響[:：].*$/gm,'').replace(/\n{3,}/g,'\n\n').trim();
// a routine's last and next run (fields from the API: last_run, last_status, last_text, next_run)
function rtStatus(r){if(!r)return null;const st={done:'ok',error:'err',skipped:'skip'}[r.last_status]||(r.last_run?'run':'');
  return {last:+r.last_run||0,st,next:r.enabled!==false&&+r.next_run?+r.next_run:0,text:String(r.last_text||'').slice(0,140),job:r.last_job||null}}
// a group member right now: working (with its progress line), queued, waiting on you, or free
function memberState(id,busy,asks){const run=(busy||[]).find(x=>x.bot_id===id&&x.status==='running');
  if(run)return {k:'run',p:String(run.progress||'').trim()};
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
  const p=String(run.progress||'').trim();
  if(!p||/^(開始工作|AI 沒有回應)/.test(p))return 'thinking';
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
