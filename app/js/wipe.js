/* OCTA web app — 設定 → 進階 → 清除這台電腦的所有資料 (4.5). */
'use strict';
/* ---------- 4.5 清除這台電腦的所有資料 (danger zone) ----------
   Only in the desktop app (window.octaDesktop): phones and other computers can't reach /api/desktop/*. On a remote
   control it clears that computer's own data and drops the link; the host is not touched. */
const WIPE_WORDS=['刪除','删除','DELETE','削除'];
const wipeWord=()=>({en:'DELETE',ja:'削除','zh-CN':'删除'})[I18N.lang]||'刪除';
const wipeOk=v=>{const w=String(v||'').normalize('NFKC').trim();return !!w&&WIPE_WORDS.some(x=>x.toLowerCase()===w.toLowerCase())};
const WIPE_GONE='機器人、群組、對話、例行任務、記憶、設定、附件與輸出檔案、各機器人的網站登入狀態、連結的電腦與手機';
const WIPE_KEPT='電腦上安裝的 AI 工具和帳號（例如 Claude Code 的登入）不會刪除，OCTA 也不會被解除安裝；開機自動啟動的設定不變。';
function paintWipe(el){el.closest('.scard').classList.add('dzone');
  el.innerHTML=`<p class="sdesc">${I18N.t('把這台電腦上的 OCTA 恢復成剛安裝好的樣子，之後會重新啟動並顯示入門畫面。')}</p>
  <dl class="wlist"><dt>${I18N.t('會刪除')}</dt><dd>${I18N.t(WIPE_GONE)}</dd><dt>${I18N.t('不會刪除')}</dt><dd>${I18N.t(WIPE_KEPT)}</dd></dl>
  ${CFG.via?`<p class="note-box">${ic('info')}<span>${I18N.t('這台電腦是遙控器：只會清除這台電腦自己的資料並中斷遙控，不會影響主機電腦上的機器人和對話。')}</span></p>`:''}
  <div class="row2"><button type="button" class="ghost sm danger" id="wipeGo">${ic('trash')}<span>${I18N.t('清除這台電腦的所有資料…')}</span></button></div>`;
  paintIcons(el);$('wipeGo').onclick=wipeSheet}
async function wipeSheet(){let w=null;try{w=await api('desktop/wipe-info')}catch(e){return toast(e.message)}
  const remote=w.role==='remote',word=wipeWord(),gb=n=>(n/1073741824).toFixed(1)+' GB';
  const sh=openSheet(`${sheetHead(I18N.t('清除這台電腦的所有資料'))}
    ${remote?`<p class="note-box warn">${ic('info')}<span><span>${I18N.t('這台電腦目前是遙控器，主機是')}</span> <b data-u>${esc(w.hostName||'')}</b><span>${I18N.t('。只會清除這台電腦自己的 OCTA 資料並中斷遙控；主機電腦上的機器人、對話和檔案都不受影響。')}</span></span></p>`:''}
    <dl class="wlist"><dt>${I18N.t('會刪除')}</dt><dd>${I18N.t(WIPE_GONE)}</dd><dt>${I18N.t('不會刪除')}</dt><dd>${I18N.t(WIPE_KEPT)}</dd></dl>
    ${!remote&&w.computers?`<p class="hmuted">${I18N.t('遙控這台電腦的其他電腦會顯示「主機已清除資料」，不能再遙控。')}</p>`:''}
    ${!remote&&w.phones?`<p class="hmuted">${I18N.t('已配對的手機會被登出，不能再連進來。')}</p>`:''}
    <div class="wopts">
     <label class="pick"><input type="checkbox" id="wBk" checked><span class="grow"><span>${I18N.t('先備份一份到')}</span> <b class="mono" data-u>${esc(w.backupRoot||'')}</b>
       <small class="hmuted">${w.storeOver?I18N.t('檔案資料夾超過 1 GB，備份只包含資料庫和設定；檔案請自己另外複製。'):I18N.t('資料庫、設定和檔案資料夾，放在一個以日期命名的資料夾裡。')}</small></span></label>
     ${w.storeCustom?`<label class="pick"><input type="checkbox" id="wStore"><span class="grow"><span>${I18N.t('也刪除檔案資料夾')}</span> <b class="mono" data-u>${esc(w.store||'')}</b>
       <small class="hmuted">${I18N.t('這是你自己選的資料夾（例如 Google 雲端硬碟），裡面可能有你自己的其他檔案，所以預設保留。不勾的話，裡面的檔案都會留著。')}</small></span></label>`:''}
    </div>
    <label class="field"><span>${I18N.t('輸入「刪除」確認')}</span><input id="wWord" autocomplete="off" spellcheck="false" placeholder="${esc(word)}" data-u></label>
    <div class="errmsg" id="wErr" role="alert"></div>
    <div class="acts"><button type="button" class="ghost" id="sx">取消</button><button type="button" class="btn danger-btn" id="wGo" disabled>${I18N.t('清除並重新啟動')}</button></div>`,'sm wipe');
  paintIcons(sh);$('sx').onclick=closeSheet;
  $('wWord').oninput=()=>{$('wGo').disabled=!wipeOk($('wWord').value)};
  $('wWord').onkeydown=e=>{if(e.key==='Enter'&&!$('wGo').disabled)$('wGo').click()};
  $('wGo').onclick=async()=>{const b=$('wGo');b.disabled=true;$('wErr').textContent='';const bk=$('wBk').checked;
    b.textContent=I18N.t(bk?'正在備份…':'正在清除…');
    try{const r=await api('desktop/wipe','POST',{word:$('wWord').value,backup:bk,deleteStore:!!$('wStore')?.checked,lang:I18N.lang});
      sh.innerHTML=`${sheetHead(I18N.t('正在清除，OCTA 會重新啟動'))}
        ${r.backup?`<p>${I18N.t('備份在：')}</p><p><b class="mono sel" data-u>${esc(r.backup.path)}</b></p>${r.backup.files?'':`<p class="hmuted">${I18N.t('檔案資料夾沒有放進備份（超過 1 GB）。')}</p>`}`:`<p>${I18N.t('這次沒有備份。')}</p>`}
        <p class="hmuted">${I18N.t('重新啟動後會再告訴你備份的位置，也可以直接打開那個資料夾。')}</p>`;paintIcons(sh)}
    catch(e){$('wErr').textContent=e.message;b.textContent=I18N.t('清除並重新啟動');b.disabled=!wipeOk($('wWord').value)}};
  setTimeout(()=>$('wWord')?.focus(),50)}
