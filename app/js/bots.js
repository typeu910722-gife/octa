/* OCTA web app — bots and groups: creating one (just a name), the detail panel where everything else lives,
   memory, permissions, templates, duplicate / compact / clear / delete. */
'use strict';
const ENG={
  claude:{n:'Claude',full:'Claude（Claude Code）',tag:'推薦',good:'大型專案開發、跨檔案修改、複雜程式除錯',who:'有 Claude Pro／Max 訂閱',cost:'用你的 Claude 訂閱，不另外收費',site:'https://code.claude.com',quota:'plan',
    win:'irm https://claude.ai/install.ps1 | iex',mac:'curl -fsSL https://claude.ai/install.sh | bash',login:'claude',hint:'出現畫面後輸入 /login，選 Claude 訂閱帳號',m:'例如 sonnet、opus'},
  codex:{n:'ChatGPT',full:'ChatGPT（Codex CLI）',good:'企劃規劃、邏輯推理、資料分析、創意與圖片生成',who:'有 ChatGPT Plus／Pro 等方案',cost:'用你的 ChatGPT 訂閱',site:'https://developers.openai.com/codex/cli',quota:'plan',
    npm:'@openai/codex',login:'codex login',hint:'瀏覽器會打開，用 ChatGPT 帳號登入',m:'例如 gpt-5.5'},
  gemini:{n:'Gemini',full:'Gemini（Antigravity CLI）',tag:'免費額度',good:'Google 服務整合、長文件分析、多模態理解、資料研究',who:'有 Google 帳號就能用',cost:'免費 Google 帳號也能用，AI Pro／Ultra 額度更多',site:'https://antigravity.google/docs/cli',quota:'count',limit:'在 agy 裡輸入 /usage 可查剩餘量',
    win:'irm https://antigravity.google/cli/install.ps1 | iex',mac:'curl -fsSL https://antigravity.google/cli/install.sh | bash',login:'agy',hint:'瀏覽器會打開，用 Google 帳號登入，完成後輸入 /quit 離開',m:'例如 gemini-3.8-flash-medium'},
  copilot:{hide:1,n:'GitHub Copilot',full:'GitHub Copilot（GPT／Claude／Gemini）',good:'程式碼補全、日常編碼、程式碼審查、測試輔助',who:'有 GitHub Copilot 訂閱',cost:'一個訂閱可選多家模型',site:'https://github.com/github/copilot-cli',quota:'count',
    npm:'@github/copilot',login:'copilot',hint:'出現畫面後輸入 /login，用 GitHub 帳號登入',m:'例如 gpt-5.5、claude-sonnet-4.6'},
  cursor:{hide:1,n:'Cursor',full:'Cursor（Cursor CLI）',good:'多檔案修改、程式重構、專案除錯、AI Agent 開發',who:'有 Cursor 訂閱',cost:'用你的 Cursor 訂閱',site:'https://cursor.com/cli',quota:'count',
    win:"irm 'https://cursor.com/install?win32=true' | iex",mac:'curl https://cursor.com/install -fsS | bash',login:'agent login',hint:'瀏覽器會打開，用 Cursor 帳號登入',m:'例如 gpt-5、sonnet-4'},
  qwen:{hide:1,n:'通義千問',full:'通義千問（Qwen Code）',good:'中文理解與生成、長篇文件分析、程式碼生成、數學推理、多模態分析（圖片、音訊、影片）、AI Agent 工具調用、自動化工作流程，以及開放模型部署',who:'有阿里雲／Qwen 帳號',cost:'依 Qwen 官方方案',site:'https://github.com/QwenLM/qwen-code',quota:'count',
    npm:'@qwen-code/qwen-code',login:'qwen',hint:'依畫面選擇登入方式，完成後輸入 /quit 離開',m:'例如 qwen3-coder-plus'},
  grok:{hide:1,n:'Grok',full:'Grok（xAI Grok CLI）',good:'即時資訊與 X（Twitter）趨勢、網路研究、推理與寫作、程式開發',who:'有 X Premium／SuperGrok 等 Grok 方案',cost:'用你的 Grok 帳號；依 xAI 方案',site:'https://docs.x.ai/build/overview',quota:'count',
    win:'irm https://x.ai/cli/install.ps1 | iex',mac:'curl -fsSL https://x.ai/cli/install.sh | bash',login:'grok login',hint:'瀏覽器會打開，用你的 X／Grok 帳號登入',m:''},
  grokbot:{hide:1,n:'Grok Bot',full:'Grok Bot（帶入你在 Grok Bot 的機器人）',tag:'第三方',good:'把 Grok Bot 裡設定好的機器人帶進 OCTA：它在 xAI 的雲端電腦上工作，OCTA 負責排程、事件觸發、核准和通知',who:'有 Grok Bot（SuperGrok 或 Cursor 方案），並在這台電腦裝好、登入 Grok Bot 桌面 App',cost:'用你的 Grok Bot 方案。透過開源工具 grok-bot-cli 連接（第三方，不是 xAI 官方），它會使用這台電腦上 Grok Bot App 的登入狀態',site:'https://github.com/ScriptedAlchemy/grok-bot-cli',quota:'count',
    npm:'grok-bot-cli',login:'gbot bots list',hint:'先在這台電腦安裝並登入 Grok Bot 桌面 App，裝好會列出你的 Grok Bot 機器人',m:''},
  opencode:{n:'Ollama',full:'Ollama 本機模型（免費）',tag:'免費',good:'本機部署開源模型、私有化 AI、中文處理、程式開發',who:'想用免費的開源模型，資料不離開電腦',cost:'免費，在你的電腦上執行（需要較好的顯示卡或 16GB 以上記憶體）',site:'https://ollama.com',quota:'local',
    npm:'opencode-ai',pre:'winget install -e --id Ollama.Ollama',login:'ollama pull qwen3',hint:'會先安裝 Ollama，再下載 qwen3 模型（約 5 GB）',m:'例如 qwen3、gemma3、llama3.1（空白就用電腦上第一個模型）'}};
// model menu: fixed lists for AIs that can't list their models; the computer reports the rest
const MODELS={claude:['sonnet','opus','haiku'],codex:['gpt-5-codex','gpt-5.5','gpt-5.4','gpt-5.4-mini'],gemini:[],
  grok:[],grokbot:[],copilot:[],cursor:[],qwen:['qwen3-coder-plus'],opencode:[]};
const modelsFor=k=>[...new Set([...(MODELS[k]||[]),...((S.models||{})[k]||[])])];
const engState=k=>S.engines?(S.engines[k]?'ok':'no'):'unknown';
const ENG_ORDER=['claude','codex','gemini','opencode'];
const firstEngine=()=>ENG_ORDER.find(k=>!ENG[k]?.hide&&engState(k)==='ok')||'claude';
const anyAI=()=>Object.entries(S.engines||{}).some(([k,v])=>v&&ENG[k]&&!ENG[k].hide);
const TPL=['用瀏覽器打開網站後台','整理成清單或表格','寫入 Google 試算表','擬好訊息給我確認再發','做完回報重點'];
const TEMPLATES=[{k:'assistant',n:'一般助理',d:'一個機器人，什麼都可以問',e:'🤖'},{k:'research',n:'研究小組',d:'查資料 → 整理摘要',e:'🔎'},
  {k:'shop',n:'門市小幫手',d:'訂單、客服回覆、日報',e:'🛒'},{k:'lodging',n:'民宿入住流程',d:'訂房、打掃清單、入住訊息',e:'🏨'},
  {k:'remind',n:'排程發訊',d:'定時發送訊息、提醒',e:'📅'},{k:'tidy',n:'資料整理',d:'整理表格、名單並輸出檔案',e:'📊'},
  {k:'watch',n:'網站監看',d:'網頁有變化就通知你',e:'👀'},{k:'game',n:'遊戲自動化',d:'定時開遊戲網頁做重複操作',e:'🎮'}];
const tplHtml=()=>`<div class="tpls">${TEMPLATES.map(t=>`<button type="button" class="tplc" data-t="${t.k}"><span class="te" aria-hidden="true">${t.e}</span><span class="tt"><b>${t.n}</b><small>${t.d}</small></span></button>`).join('')}</div>`;
function bindTpl(root,after){root.querySelectorAll('[data-t]').forEach(b=>b.onclick=async()=>{if(b.disabled)return;b.disabled=true;
  try{await api('template','POST',{name:b.dataset.t,lang:I18N.lang});b.querySelector('small').textContent=I18N.t('已加入 ✓');b.classList.add('done');await refresh();after&&after()}catch(e){b.disabled=false;toast(e.message)}})}
function tplSheet(){openSheet(`${sheetHead('從範本建立','一鍵建立一組常用的機器人，之後都能改名、改任務。')}${tplHtml()}<div class="acts"><button class="btn" id="sx">完成</button></div>`);$('sx').onclick=closeSheet;bindTpl($('veil'))}

/* ---------- a new bot: a name and a colour, nothing else ---------- */
function newBotSheet(){
  const first=PALETTE[S.bots.length%PALETTE.length][0];   // a new colour each time, so bots are easy to tell apart
  $('veil').innerHTML=`<form class="sheet sm" id="nbf">${sheetHead('新機器人','取個名字、挑個顏色就好。建立後直接跟它說要做什麼，它會自己記住工作。')}
    <div class="nbhero"><span class="av xl" id="nbAv">${octSvg('idle',first,true)}</span><label class="field grow"><span>名稱</span><input id="nbName" maxlength="20" placeholder="例如：客服小幫手" autocomplete="off"></label></div>
    <div class="field"><span>顏色</span>${paletteHtml(first,'nbPal')}</div>
    <div class="errmsg" id="nbE"></div>
    <div class="acts"><button type="button" class="link" id="nbTpl">${ic('sparkle')}<span>從範本建立</span></button><span class="grow"></span><button type="button" class="ghost" id="sx">取消</button><button class="btn" id="nbGo">建立</button></div></form>`;
  $('veil').hidden=false;paintIcons($('veil'));$('nbName').focus();$('sx').onclick=closeSheet;$('nbTpl').onclick=tplSheet;
  const pal=bindPalette($('nbPal'),c=>setHTML($('nbAv'),octSvg('idle',c,true)));
  $('nbName').oninput=()=>{$('nbE').textContent=''};
  $('nbf').onsubmit=async e=>{e.preventDefault();const raw=$('nbName').value.trim(),name=raw||freeName(I18N.t('新機器人'),S.bots.map(b=>b.name));
    const bad=raw?nameProblem(raw,''):'';if(bad){$('nbE').textContent=I18N.t(bad);$('nbName').focus();return}
    $('nbGo').disabled=true;
    try{const r=await api('bots','POST',{name,task:'',engine:firstEngine(),color:pal.get(),folder:conv(cur)?.folder||null});closeSheet(true);await refresh();openConv(r.id);
      $('msg').placeholder=I18N.t(raw?'跟它說要幫你做什麼…':'跟它說要幫你做什麼…（它會自己記住、取名字）');$('msg').focus();toast(I18N.t('已建立'))}
    catch(err){$('nbE').textContent=err.message;$('nbGo').disabled=false}}}
const membersPicker=c=>`<div class="picks" id="picks">${(c?[...c.members.filter(bot),...S.bots.map(b=>b.id).filter(x=>!c.members.includes(x))]:S.bots.map(b=>b.id)).map(id=>{const b=bot(id);return `<label class="pick"><input type="checkbox" value="${b.id}" ${!c||c.members.includes(b.id)?'checked':''}><span class="av xs" data-u>${avOf(b.id)}</span><span data-u class="grow">${esc(b.name)}</span><button type="button" class="ib sm mv" data-up aria-label="往上">↑</button><button type="button" class="ib sm mv" data-down aria-label="往下">↓</button></label>`}).join('')}</div>`;
function bindPicker(root){root.querySelector('#picks').onclick=e=>{const b=e.target.closest('.mv');if(!b)return;e.preventDefault();const row=b.closest('.pick');
  if(b.hasAttribute('data-up')&&row.previousElementSibling)row.parentNode.insertBefore(row,row.previousElementSibling);
  if(b.hasAttribute('data-down')&&row.nextElementSibling)row.parentNode.insertBefore(row.nextElementSibling,row);markDirty()}}
function groupSheet(){
  if(!S.bots.length){alertSheet('先建立機器人','群組需要至少一個機器人成員。');return}
  $('veil').innerHTML=`<form class="sheet" id="ngf">${sheetHead('新群組','讓幾個機器人一起合作：交代一件事，成員由上到下依序接手，也可以用 @名字 指定誰做。')}
    <label class="field"><span>名稱</span><input id="ngName" required maxlength="20" placeholder="例如：退房檢查"></label>
    <div class="field"><span>成員（由上到下依序執行）</span>${membersPicker(null)}</div>
    <label class="field"><span>協作規則（選填）</span><textarea id="ngRule" maxlength="4000" placeholder="可以不填：成員依上面的順序輪流做；也可以寫誰先做、做完交給誰"></textarea></label>
    <div class="errmsg" id="ngE"></div>
    <div class="acts"><button type="button" class="ghost" id="sx">取消</button><button class="btn">建立</button></div></form>`;
  $('veil').hidden=false;$('ngName').focus();$('sx').onclick=closeSheet;bindPicker($('veil'));
  $('ngf').onsubmit=async e=>{e.preventDefault();const members=[...$('veil').querySelectorAll('.picks input:checked')].map(i=>i.value);
    if(!members.length){$('ngE').textContent=I18N.t('請至少選一個成員');return}
    try{const r=await api('groups','POST',{name:$('ngName').value,task:$('ngRule').value,members,folder:conv(cur)?.folder||null});closeSheet(true);await refresh();openConv(r.id);toast(I18N.t('已建立'))}
    catch(err){$('ngE').textContent=err.message}}}

/* ---------- memory in three kinds: 規則 (📌), 事實 (📇), 做事手冊 (📘) ---------- */
const MEMT={rule:['規則','memory','它被糾正或學到的做法，每次工作都會照做。','例如：回覆客人要用敬語'],fact:['事實','facts','固定的資料，例如名單、網址、帳號名稱。','例如：後台網址是 https://…'],manual:['做事手冊','manuals','成功做完多步驟的工作後它自己寫下的流程（📘），做類似的事時會照著做。','']};
const memList=(c,t)=>((S[MEMT[t][1]]||{})[c.id]||[]);
function memHtml(c){return `<div class="seg mseg" id="sf_mt" role="tablist" aria-label="記憶分類">${Object.entries(MEMT).map(([k,v],i)=>`<button type="button" role="tab" data-mt="${k}" class="${i?'':'on'}"><b>${v[0]}</b><small>${memList(c,k).length}</small></button>`).join('')}</div>
  <p class="hmuted" id="sf_mtip"></p><div class="picks" id="sf_mem"></div>
  <div class="row2" id="sf_madd"><input id="sf_mnew" maxlength="300" class="grow"><button type="button" class="ghost sm" id="sf_mgo">加入</button></div>`}
let addMem=null;
function bindMem(c){let t='rule';
  const draw=()=>{const list=memList(c,t);$('sf_mtip').textContent=I18N.t(MEMT[t][2]);$('sf_madd').hidden=t==='manual';$('sf_mnew').placeholder=I18N.t(MEMT[t][3]);
    $('sf_mt').querySelectorAll('[data-mt]').forEach(b=>{b.classList.toggle('on',b.dataset.mt===t);b.setAttribute('aria-selected',String(b.dataset.mt===t));b.querySelector('small').textContent=memList(c,b.dataset.mt).length});
    $('sf_mem').innerHTML=list.length?list.map((x,i)=>t==='manual'?`<div class="pick mman"><details class="grow"><summary data-u>${esc(x.name)}</summary><div class="msteps" data-u>${esc(x.steps)}</div></details><small class="hmuted"><span>用過</span> ${+x.used||0}</small><button type="button" class="ib sm mv" data-unmem="${i}" aria-label="刪除">${ic('x')}</button></div>`
      :`<div class="pick"><span data-u class="grow">${esc(x)}</span><button type="button" class="ib sm mv" data-unmem="${i}" aria-label="忘記">${ic('x')}</button></div>`).join(''):`<p class="hmuted">${I18N.t('還沒有')}</p>`};
  const save=async list=>{await api('settings','PUT',{memory:{bot:c.id,type:t,list}});S[MEMT[t][1]]=S[MEMT[t][1]]||{};S[MEMT[t][1]][c.id]=list;draw()};
  $('sf_mt').onclick=e=>{const b=e.target.closest('[data-mt]');if(b){t=b.dataset.mt;draw()}};
  $('sf_mem').onclick=async e=>{const x=e.target.closest('[data-unmem]');if(!x)return;const list=[...memList(c,t)];list.splice(+x.dataset.unmem,1);
    try{await save(list);toast(I18N.t(t==='manual'?'已刪除':'已忘記'))}catch(err){toast(err.message)}};
  const add=async()=>{const v=$('sf_mnew').value.trim();if(!v)return true;try{await save([...memList(c,t).filter(x=>x!==v),v]);$('sf_mnew').value='';cleanDirty('mem');toast(I18N.t('已加入'));return true}catch(err){toast(err.message);return false}};
  addMem=add;   // the panel's 儲存 adds a line typed here but not added yet
  $('sf_mgo').onclick=add;$('sf_mnew').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();add()}};
  draw()}

/* ---------- the detail panel: everything about one bot or group ---------- */
const DP={id:null,sig:''};
// what the panel shows; when it changes (and nothing is being edited) the panel redraws itself
function detailSig(c){return JSON.stringify([c,S.routines.filter(r=>r.conv===c.id),(S.memory||{})[c.id],(S.facts||{})[c.id],(S.manuals||{})[c.id],(S.allow||{})[c.id],(S.skills||{})[c.id],(S.nsk||{})[c.id],(S.quick||{})[c.id],(S.pins||[]).includes(c.id),!!(S.mute||{})[c.id],S.folders.map(f=>f.id+f.name),S.engines,S.models,botRunning(c.id),S.shareBrowser])}
function detailLive(){if(!detailOpen())return;const c=conv(DP.id);if(!c){DIRTY.el=null;DP.id=null;return}
  if(DP.id!==cur||isDirty()||rtEdit!=null||$('detail').contains(document.activeElement))return;
  if(detailSig(c)!==DP.sig)paintDetail(false)}
const dsec=(k,title,icon,body,open)=>{const shut=store.get('octa_dsec_'+k);const isOpen=shut==null?open:shut==='1';
  return `<details class="dsec" data-sec="${k}"${isOpen?' open':''}><summary>${ic(icon)}<span>${title}</span>${ic('chev','chv')}</summary><div class="dsb">${body}</div></details>`};
function paintDetail(top){const c=conv(cur),box=$('detail');if(!c)return;const g=isG(c.id),id=c.id;
  const keep=top||DP.id!==id?0:(box.querySelector('.dp-body')?.scrollTop||0);
  DP.id=id;DP.sig=detailSig(c);rtEdit=null;addMem=null;
  const pinned=(S.pins||[]).includes(id),muted=!!(S.mute||{})[id];
  const q=(k,icon,label,on)=>`<button type="button" class="dq${on?' on':''}" data-dq="${k}">${ic(icon)}<span>${label}</span></button>`;
  const quick=`<div class="dquick">${q('br','globe','瀏覽器')}${q('pin','pin',pinned?'已置頂':'置頂',pinned)}${q('mute',muted?'belloff':'bell',muted?'已靜音':'靜音',muted)}${g?'':q('cmp','compress','壓縮')}${q('shots','image','畫面')}</div>`;
  let body='';
  if(g){
    body+=dsec('task','協作','users',`<div class="field"><span>成員（由上到下依序執行）</span>${membersPicker(c)}</div>
      <label class="field"><span>協作規則（選填）</span><textarea id="st" maxlength="4000" placeholder="可以不填：成員依上面的順序輪流做；也可以寫誰先做、做完交給誰">${esc(c.task||'')}</textarea></label>`,true);
  }else{
    body+=dsec('task','它的工作','briefcase',`<label class="field"><span>指定任務</span><textarea id="st" maxlength="4000" placeholder="可以先不填：直接傳訊息告訴它要做什麼，它會自己整理成指定任務">${esc(c.task||'')}</textarea></label>
      <div class="tpl">${TPL.map(t=>`<button type="button" class="chip-btn">${t}</button>`).join('')}</div>
      <p class="hmuted">時間請寫在例行任務：這裡只寫工作內容，排程時間（每天幾點、每隔多久）寫在這裡不會執行。</p>`,true);
  }
  body+=dsec('rt','例行任務','clock',`<div class="rt" id="rt" data-conv="${esc(id)}"></div>`,true);
  if(!g){
    body+=dsec('mem','記憶','brain',memHtml(c),false);
    const opts=Object.entries(ENG).filter(([k,v])=>!v.hide).flatMap(([k,v])=>[[k,v.full+(k==='claude'?'（預設 sonnet，較省額度）':'（預設模型）')],...modelsFor(k).map(m=>[k+'|'+m,v.full+'・'+m])]),fb=c.fb||[];
    const sel=(i,only)=>`<select id="sf_fb${i}"><option value="">不使用</option>${opts.filter(([v])=>!only||v.split('|')[0]===only).map(([v,l])=>`<option value="${esc(v)}"${fb[i]===v?' selected':''}>${esc(l)}${engState(v.split('|')[0])==='ok'?'':'（還沒連接）'}</option>`).join('')}</select>`;
    body+=dsec('ai','AI 與模型','sparkle',`<label class="field"><span>AI 引擎</span><select id="sf_e">${Object.entries(ENG).filter(([k,v])=>!v.hide||c.engine===k).map(([k,v])=>`<option value="${k}" ${(c.engine||'claude')===k?'selected':''}>${v.full}${engState(k)==='ok'?'　✓ 已連接':engState(k)==='no'?'　（還沒連接）':''}</option>`).join('')}</select></label>
      <label class="field"><span>模型</span><select id="sf_m"></select></label><p class="hmuted" id="sf_hint"></p>
      <div class="field"><span>備援 AI</span><div class="fbs"><label><small>第一備援</small>${sel(0)}</label><label><small>第二備援</small>${sel(1)}</label><label><small>本機 Ollama</small>${sel(2,'opencode')}</label></div></div>
      <p class="hmuted">第一、第二備援，以及可選的本機 Ollama。模型說流量不夠或額度用完，會立刻改叫下一個備援，接手後該查的頁面、該建的例行任務一樣要做；這台電腦沒裝的會跳過。HTTP 429 先重試一次再切換。登入或 API Key 無效不會重複呼叫。程式錯誤不會因此換模型。</p>`,false);
    body+=dsec('auth','做事權限','shield',`<div class="bchoice" id="sf_au">${[['auto','直接做','看得懂就直接做完，不用先給你看計畫。付款、刪除、改帳號還是會先問你。'],['report','做完告知（建議）','一般工作直接做，做完跟你說做了什麼。大任務先給你看計畫；送出訊息、刪除、付款前先問你。'],['ask','重要動作先問','送出訊息、提交表單、刪除、付款這類收不回來的事，每一次都先問你。大任務先給你看計畫。']].map(([v,t,d])=>`<label class="bc"><input type="radio" name="sf_au" value="${v}" ${(c.autonomy||'report')===v?'checked':''}><span><b>${t}</b><small>${d}</small></span></label>`).join('')}</div>
      ${((S.allow||{})[id]||[]).length?`<div class="field"><span>一律允許的事（機器人做這些不會再問你）</span><div class="picks" id="sf_al">${S.allow[id].map((t,i)=>`<div class="pick"><span data-u class="grow">${esc(t)}</span><button type="button" class="ib sm mv" data-unallow="${i}" aria-label="收回">${ic('x')}</button></div>`).join('')}</div></div>`:''}`,false);
    body+=dsec('brw','瀏覽器','globe',`<div class="bchoice" id="sf_b">
      <label class="bc"><input type="radio" name="sf_b" value="own" ${c.browser!=='mine'?'checked':''}><span><b>機器人專屬瀏覽器</b><small>${S.shareBrowser!==false?'它自己的瀏覽器，可以和其他機器人同時工作；登入共用，在任何一個機器人登入過的網站它也能用。不會動到你的 Chrome。':'這個機器人自己的瀏覽器和登入，不會動到你的 Chrome。第一次用某網站要在「瀏覽器」幫它登入一次。'}</small></span></label>
      <label class="bc"><input type="radio" name="sf_b" value="mine" ${c.browser==='mine'?'checked':''}><span><b>使用我的 Chrome</b><small>直接用你 Chrome 已登入的網站和已儲存的密碼。需要先在「設定 → 瀏覽器」連接 Chrome。</small></span></label>
    </div>${DESK()&&c.browser!=='mine'?`<div data-bm="${id}"></div>`:''}`,false);
  }
  const stand=(()=>{if(g)return '';const r=S.routines.find(x=>x.conv===id&&x.name==='待命巡查'),ev=r&&r.enabled?((r.times||[]).find(t=>/^\*\//.test(t))||'').slice(2):'';
    return `<label class="field"><span>24 小時待命</span><select id="sf_stand" data-nodirty>${[['','不待命'],['10','每 10 分鐘巡一次'],['30','每 30 分鐘巡一次'],['60','每小時巡一次']].map(([v,l])=>`<option value="${v}"${v===ev?' selected':''}>${l}</option>`).join('')}</select></label><p class="hmuted">開啟後它會照指定任務定時自己檢查、有事就處理，需要時在背景找其他機器人幫忙；沒事不會出聲。這台電腦要開著。</p><p class="hmuted" id="sf_standnow">${standNow(ev,!r&&!c.stood)}</p>`})();
  const hook=(()=>{if(g)return '';const r=S.routines.find(x=>x.conv===id&&x.hook&&x.name==='外部交接');return `<div class="field"><span>從其他 AI 交接工作（例如 Grok Bot）</span>${r?`<div class="row2"><input readonly class="mono grow" value="${esc(hookUrl(r))}" data-u><button type="button" class="ghost sm" id="sf_hcopy">複製</button></div>${hookNote()}
    <p class="hmuted" data-u>${esc(I18N.t('把這段話給你的 Grok Bot（或其他 AI）：'))}「${esc(handoffSay(c.name,hookUrl(r)))}」</p>`:`<div class="row2"><button type="button" class="ghost sm" id="sf_hmake">產生交接網址</button></div><p class="hmuted">其他 AI 用這個網址把工作交給這個機器人，它會自動開始做。</p>`}</div>`})();
  body+=dsec('more','更多設定','sliders',`${stand}${hook}
    <label class="field"><span>常用指令（一行一個，會變成輸入框上方的快速按鈕）</span><textarea id="sf_q" maxlength="2000" placeholder="例如：整理今天的訂單&#10;把結果寫進試算表">${esc(((S.quick||{})[id]||[]).join('\n'))}</textarea></label>
    ${!g&&((S.skills||{})[id]||[]).length?`<div class="field"><span>它會的技能（🧩，輸入 / 叫用）</span><div class="picks" id="sf_sk">${S.skills[id].map((k,i)=>`<div class="pick"><span data-u class="grow" title="${esc(k.steps)}">${esc(k.name)}</span><button type="button" class="ib sm mv" data-unsk="${i}" aria-label="刪除">${ic('x')}</button></div>`).join('')}</div></div>`:''}
    ${!g&&((S.nsk||{})[id]||[]).length?`<div class="field"><span>Claude Code 技能（存在它的資料夾）</span><div class="picks">${S.nsk[id].map(n=>`<div class="pick"><span data-u>${esc(n)}</span></div>`).join('')}</div></div>`:''}
    <label class="field"><span>分區</span><select id="sf_f"><option value="">未分區</option>${S.folders.map(f=>`<option data-u value="${f.id}" ${c.folder===f.id?'selected':''}>${esc(f.name)}</option>`).join('')}</select></label>`,false);
  body+=`<div class="dzone">${g?'':`<button type="button" class="ghost sm" data-dz="dup">${ic('copy')}<span>複製這個機器人</span></button>`}<button type="button" class="ghost sm" data-dz="clr">${ic('eraser')}<span>清空對話紀錄</span></button><button type="button" class="ghost sm danger" data-dz="del">${ic('trash')}<span>${g?'刪除群組':'刪除機器人'}</span></button></div>`;
  box.innerHTML=`<div class="dp">
  <form class="dp-body" id="sf" autocomplete="off">
    <div class="dhero">
      <span class="av xl${g?' grp':''}" id="dAv">${g?gStack(c):avOf(id,'always')}</span>
      <div class="dname"><input id="sn" required maxlength="20" value="${esc(c.name)}" aria-label="名稱" data-u><small>${subLine(c)}</small></div>
    </div>
    ${g?'':`<div class="field dcol"><span>顏色</span>${paletteHtml(c.color,'dPal')}</div>`}
    <p class="errmsg" id="se"></p>
    ${quick}
    ${body}
  </form>
  <footer class="dp-ft" data-dirty-bar><span class="dflag">有未儲存的變更</span><button type="button" class="ghost sm" id="sfUndo">復原</button><button type="button" class="btn sm" id="sfSave">儲存</button></footer></div>`;
  paintIcons(box);
  const body2=box.querySelector('.dp-body');body2.scrollTop=keep;
  box.querySelectorAll('details.dsec').forEach(d=>d.addEventListener('toggle',()=>store.set('octa_dsec_'+d.dataset.sec,d.open?'1':'0')));
  // the quick row
  const dq={br:()=>setTab('web'),pin:()=>togglePin(id),mute:()=>toggleMute(id),cmp:()=>compactConv(id),shots:()=>shotSheet(g?c.members.filter(bot):[id])};
  box.querySelectorAll('[data-dq]').forEach(b=>b.onclick=e=>{e.stopPropagation();dq[b.dataset.dq]?.()});
  box.querySelectorAll('[data-dz]').forEach(b=>b.onclick=()=>({dup:()=>dupBot(id),clr:()=>clearConv(id),del:()=>deleteConv(id)})[b.dataset.dz]());
  const nm0=c.name;const nameOk=()=>{const bad=g?(!$('sn').value.trim()?'請填名稱':''):nameProblem($('sn').value,nm0);$('se').textContent=bad?I18N.t(bad):'';$('sn').setAttribute('aria-invalid',bad?'true':'false');return !bad};
  $('sn').addEventListener('input',nameOk);
  let pal=null;
  if(!g){pal=bindPalette($('dPal'),col=>{setHTML($('dAv'),octSvg(stateOf(id),col,true));markDirty()});
    if(c.name&&/[\s　]/.test(c.name))$('se').textContent=I18N.t('名稱有空格，群組裡 @ 不到它，建議改名');
    const fillModels=()=>{const k=$('sf_e').value,list=modelsFor(k),curM=(c.engine===k?c.model:'')||'',curShort=k==='opencode'?curM.replace(/^ollama\//,''):curM;
      const opts=[...list];if(curShort&&!opts.includes(curShort))opts.push(curShort);
      if(k==='grokbot'){$('sf_m').innerHTML=opts.length?opts.map(m=>`<option value="${esc(m)}" ${m===curShort?'selected':''} data-u>${esc(m)}</option>`).join(''):`<option value="">${esc(I18N.t('讀不到 Grok Bot 機器人，先到 AI 連線測試'))}</option>`;return}
      $('sf_m').innerHTML=(k==='opencode'&&!opts.length?`<option value="">${esc(I18N.t('這台電腦還沒下載模型，先到 AI 連線下載'))}</option>`:`<option value="">${esc(I18N.t('預設（推薦）'))}</option>`)+opts.map(m=>`<option value="${esc(m)}" ${m===curShort?'selected':''} data-u>${esc(m)}</option>`).join('')};
    const upd=()=>{const k=$('sf_e').value;fillModels();$('sf_hint').innerHTML=engState(k)==='ok'?'<span class="okt">這台電腦已連接這個 AI。</span>':`<span>這台電腦還沒連接這個 AI。</span><a href="#" id="sf_conn">看怎麼連接</a>`;if($('sf_conn'))$('sf_conn').onclick=ev=>{ev.preventDefault();openSettings('ai',k)}};$('sf_e').onchange=upd;upd();
    bindMem(c);browserModes(box);
    box.querySelectorAll('.tpl button').forEach(b=>b.onclick=()=>{const t=$('st');t.value=(t.value?t.value+'；':'')+b.textContent;markDirty()});
    if($('sf_stand'))$('sf_stand').onchange=async e=>{const v=e.target.value,old=S.routines.find(x=>x.conv===id&&x.name==='待命巡查');e.target.disabled=true;try{if(old)await api('routines/'+old.id,'DELETE');if(v)await api('routines','POST',{conv:id,name:'待命巡查',times:['*/'+v],prompt:'（待命巡查）照你的指定任務檢查有沒有新狀況要處理（例如新訊息、新訂單、到期的事）。有就處理，需要同事幫忙就 @同事；處理完簡短回報。完全沒事就只回「（略過）」。'});await refresh();toast(I18N.t(v?'已開啟 24 小時待命':'已關閉待命'));if($('sf_standnow'))$('sf_standnow').textContent=I18N.t(standNow(v,false))}catch(x){toast(x.message)}e.target.disabled=false};
    if($('sf_hmake'))$('sf_hmake').onclick=async()=>{$('sf_hmake').disabled=true;try{await api('routines','POST',{conv:id,name:'外部交接',trigger:'hook',prompt:'其他 AI 把工作交接給你：照交接內容處理，完成後在這裡回報結果；資訊不夠就直接問使用者。'});await refresh();paintDetail(false)}catch(e){toast(e.message);$('sf_hmake').disabled=false}};
    if($('sf_hcopy'))$('sf_hcopy').onclick=()=>{const r=S.routines.find(x=>x.conv===id&&x.hook&&x.name==='外部交接');navigator.clipboard?.writeText(hookUrl(r)).then(()=>toast(I18N.t('已複製'))).catch(()=>{})};
    if($('sf_sk'))$('sf_sk').onclick=async e=>{const x=e.target.closest('[data-unsk]');if(!x)return;const list=[...S.skills[id]];list.splice(+x.dataset.unsk,1);
      try{await api('settings','PUT',{skills:{bot:id,list}});S.skills[id]=list;x.closest('.pick').remove();toast(I18N.t('已刪除'))}catch(err){toast(err.message)}};
    if($('sf_al'))$('sf_al').onclick=async e=>{const x=e.target.closest('[data-unallow]');if(!x)return;const list=[...S.allow[id]];list.splice(+x.dataset.unallow,1);
      try{await api('settings','PUT',{allow:{bot:id,list}});S.allow[id]=list;x.closest('.pick').remove();toast(I18N.t('已收回'))}catch(err){toast(err.message)}};
  }else bindPicker(box);
  renderRoutines();
  // one 儲存: an open 例行任務 form and a typed-but-not-added memory line are saved together with the rest
  const saveAll=async()=>{$('se').textContent='';if(!nameOk()){$('sn').focus();return false}
    const rf=$('rt')?.querySelector('.rform');if(rf&&rf._save&&!(await rf._save(true))){rf.scrollIntoView({block:'center'});return false}
    if($('sf_mnew')?.value.trim()&&addMem&&!(await addMem()))return false;
    const body={name:$('sn').value.trim(),task:$('st').value,folder:$('sf_f').value||null};
    if(!g){body.autonomy=box.querySelector('input[name=sf_au]:checked')?.value||'report';body.color=pal?pal.get():(c.color||null);body.browser=box.querySelector('input[name=sf_b]:checked')?.value||'own';body.engine=$('sf_e').value;body.model=$('sf_m').value.trim();body.fb=[$('sf_fb0')?.value,$('sf_fb1')?.value,$('sf_fb2')?.value].filter(Boolean)}
    else{body.members=[...box.querySelectorAll('.picks input:checked')].map(i=>i.value);if(!body.members.length){$('se').textContent=I18N.t('請至少選一個成員');return false}}
    try{await api((g?'groups/':'bots/')+id,'PUT',body);
      const ql=$('sf_q').value.split('\n').map(x=>x.trim()).filter(Boolean).slice(0,12);
      if(ql.join('\n')!==((S.quick||{})[id]||[]).join('\n'))await api('settings','PUT',{quick:{conv:id,list:ql}});
      cleanDirty();return true}
    catch(err){$('se').textContent=err.message;return false}};
  trackDirty(box.querySelector('.dp'),saveAll);
  $('sf').onsubmit=e=>{e.preventDefault();$('sfSave').click()};
  $('sfSave').onclick=async()=>{const b=$('sfSave');b.disabled=true;const ok=await saveAll();b.disabled=false;if(!ok)return;toast(I18N.t('已儲存 ✓'));DIRTY.el=null;await refresh();paintDetail(false)};
  $('sfUndo').onclick=()=>{cleanDirty();DIRTY.el=null;paintDetail(false)};
  focusBrowser()}
const handoffSay=(name,url)=>`要把工作交給 OCTA 的「${name}」時，用 HTTP POST 傳 JSON 到 ${url} ，格式 {"text":"工作內容","from":"你的名字"}（Content-Type: application/json）。收到 {"ok":true} 就是交接成功，對方會自動開始做。`;

/* ---------- delete / duplicate / compact / clear, each with a clear confirmation ---------- */
function deleteConv(id){const c=conv(id);if(!c)return;const g=isG(id);
  const inGroups=g?[]:S.groups.filter(x=>x.members.includes(id));
  const rn=S.routines.filter(r=>r.conv===id).length;
  confirmSheet(g?'刪除群組':'刪除機器人',`<p><span>確定要刪除</span>「<b data-u>${esc(c.name)}</b>」？</p><ul class="cfl">
    <li>對話紀錄會一起刪除</li>${rn?`<li><span>例行任務</span> ${rn} <span>個會一起刪除</span></li>`:''}
    ${inGroups.length?`<li><span>會從這些群組移除：</span><span data-u>${esc(inGroups.map(x=>x.name).join('、'))}</span></li>`:''}
    <li>電腦上的檔案資料夾會保留，不會刪除</li></ul><p>刪除後無法復原。</p>`,g?'刪除群組':'刪除機器人',true,
    async()=>{await api((g?'groups/':'bots/')+id,'DELETE');delete MSG[id];if(cur===id){if(detailOpen()){DIRTY.el=null;closeDetail()}cur=null;$('app').classList.remove('chat');focusBrowser()}toast(I18N.t('已刪除'));await refresh()})}
async function dupBot(id){const b=bot(id);if(!b)return;
  let name=b.name.slice(0,16)+I18N.t('（複製）');for(let n=2;S.bots.some(x=>x.name===name);n++)name=b.name.slice(0,14)+I18N.t('（複製）')+n;
  try{const r=await api('bots','POST',{name:name.slice(0,20),task:b.task,folder:b.folder,engine:b.engine,model:b.model,avatar:b.avatar,color:b.color||null,browser:b.browser==='mine'?'mine':'own'});
    const q=(S.quick||{})[id];if(q?.length)await api('settings','PUT',{quick:{conv:r.id,list:q}});
    toast(I18N.t('已複製，可以改名或改任務'));await refresh();openConv(r.id);openDetail()}catch(e){toast(e.message)}}
/* standing approval: the bot may do this kind of thing from now on without asking (until revoked) */
const RISKY=/付款|付錢|轉帳|刷卡|扣款|購買|下單|刪除|刪掉|清空|移除|密碼|帳號設定/;
function alwaysSheet(m){const b=bot(m.by);if(!b)return;const act=m.text.match(APPR)[1].trim();const risky=RISKY.test(act);
  $('veil').innerHTML=`<form class="sheet sm" id="awf">${sheetHead('一律允許')}
  <p><span>以後</span>「<b data-u>${esc(b.name)}</b>」<span>遇到這類事情就直接做，做完在對話裡回報，不再等你按核准。適合每天排程重複做的事。</span></p>
  <label class="field"><span>允許的事（可以改得更通用，例如去掉日期、人數）</span><input id="awT" maxlength="120" value="${esc(act)}"></label>
  ${risky?'<p class="note-box warn">這件事看起來涉及付款、刪除或帳號，建議只核准這次。就算設定一律允許，這類事機器人仍會每次問你。</p>':''}
  <p class="hmuted">隨時可以在這個機器人的「詳細資料 → 做事權限」收回。</p>
  <div class="errmsg" id="awE"></div>
  <div class="acts"><button type="button" class="ghost" id="sx">取消</button><button class="btn">一律允許並執行這次</button></div></form>`;
  $('veil').hidden=false;$('sx').onclick=closeSheet;$('awT').focus();
  $('awf').onsubmit=async ev=>{ev.preventDefault();const t=$('awT').value.trim();if(!t)return;
    try{const list=[...new Set([...((S.allow||{})[b.id]||[]),t])].slice(0,20);await api('settings','PUT',{allow:{bot:b.id,list}});
      closeSheet();toast(I18N.t('已設定一律允許'));const at=isG(cur)?'@'+b.name+' ':'';sendMsg(at+'核准：'+act+'（以後這類事一律允許：'+t+'）')}
    catch(e){$('awE').textContent=e.message}}}
function compactConv(id){const c=conv(id);if(!c)return;if(isG(id)){toast(I18N.t('群組請到各機器人的對話裡壓縮'));return}
  confirmSheet('壓縮對話',`<p><span>讓</span>「<b data-u>${esc(c.name)}</b>」<span>把這段對話的重點寫進它的記憶，再寫一段目前進度，然後刪掉舊訊息。</span></p><p class="hmuted">機器人本身、記憶、技能、任務設定和例行任務都會保留；之後每次送給 AI 的文字會少很多，比較省額度。</p>`,'壓縮',false,
    async()=>{try{await api('compact','POST',{conv:id});toast(I18N.t('開始壓縮，完成後舊訊息會自動刪掉'));await refresh();if(cur===id){await loadMsgs(id,'first');render(true)}}catch(e){toast(e.message)}})}
function clearConv(id){const c=conv(id);if(!c)return;
  confirmSheet('清空對話紀錄',`<p><span>清空</span>「<b data-u>${esc(c.name)}</b>」<span>的所有訊息？機器人之後不會再看到這些舊對話。機器人本身、任務設定和例行任務都會保留。</span></p>`,'清空',true,
    async()=>{await api('clear','POST',{conv:id});delete MSG[id];toast(I18N.t('已清空'));await refresh();if(cur===id){await loadMsgs(id,'first');render(true)}})}
