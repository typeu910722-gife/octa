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
