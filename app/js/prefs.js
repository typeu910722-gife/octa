/* OCTA web app — 4.8 personal look and feel (loaded after settings.js: it adds the 外觀與語言 section), kept on this device and applied the moment they change (no 儲存 button):
   accent colour, density (舒適／緊湊), chat width, sidebar width (drag its edge), the order of the sidebar rows (drag),
   and the keyboard shortcut list. The look is applied before first paint by the script in index.html. */
'use strict';
/* ---------- accent colour: the app's buttons, links, focus ring and your own bubbles ---------- */
const hexRgb=h=>{const m=String(h||'').match(/^#?([0-9a-f]{6})$/i);if(!m)return null;const n=parseInt(m[1],16);return [n>>16&255,n>>8&255,n&255]};
const rgbHex=c=>'#'+c.map(v=>Math.round(Math.max(0,Math.min(255,v))).toString(16).padStart(2,'0')).join('');
const lum=c=>{const f=v=>{v/=255;return v<=.03928?v/12.92:((v+.055)/1.055)**2.4};return .2126*f(c[0])+.7152*f(c[1])+.0722*f(c[2])};
const contrast=(a,b)=>{const x=lum(a),y=lum(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05)};
const mixRgb=(a,b,t)=>a.map((v,i)=>v+(b[i]-v)*t);
// move the colour toward black (light look) or white (dark look) until it reads on the surface
function readable(c,bg,min,toward){let x=c.slice();for(let i=0;i<40&&contrast(x,bg)<min;i++)x=mixRgb(x,toward,.06);return x}
function accentCss(hex){const c=hexRgb(hex);if(!c)return '';
  const W=[255,255,255],K=[0,0,0],rgba=(x,a)=>`rgba(${x.map(Math.round).join(',')},${a})`;
  const la=readable(c,W,4.6,K),lh=mixRgb(la,K,.12),li=readable(c,[247,246,243],5.2,K);
  const da=readable(c,[28,27,25],5.5,W),dh=mixRgb(da,W,.12),di=readable(c,[28,27,25],6,W);
  const light=`--brand:${rgbHex(c)};--accent:${rgbHex(la)};--accent-h:${rgbHex(lh)};--on-accent:#fff;--accent-soft:${rgba(c,.16)};--accent-ink:${rgbHex(li)};--me:${rgbHex(mixRgb(c,W,.8))};--sel:${rgba(c,.14)};--ring:0 0 0 3px ${rgba(c,.34)}`;
  const dark=`--brand:${rgbHex(c)};--accent:${rgbHex(da)};--accent-h:${rgbHex(dh)};--on-accent:${lum(da)>.35?'#15120c':'#fff'};--accent-soft:${rgba(da,.16)};--accent-ink:${rgbHex(di)};--me:${rgbHex(mixRgb(c,[28,27,25],.78))};--sel:${rgba(da,.16)};--ring:0 0 0 3px ${rgba(da,.4)}`;
  return `:root{${light}}@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){${dark}}}:root[data-theme="dark"]{${dark}}`}
function applyAccent(hex){const css=hex?accentCss(hex):'';let el=$('accentCss');
  if(!el){el=document.createElement('style');el.id='accentCss';document.head.appendChild(el)}
  el.textContent=css;store.set('octa_accent',css?hex:null);store.set('octa_accent_css',css||null);
  if(typeof dockSync==='function')dockSync()}
/* ---------- density, chat width ---------- */
function applyDensity(v){const d=document.documentElement;if(v==='compact')d.dataset.density='compact';else delete d.dataset.density;store.set('octa_density',v==='compact'?'compact':null)}
function applyChatWidth(v){const d=document.documentElement;if(v==='narrow'||v==='wide')d.dataset.cw=v;else delete d.dataset.cw;store.set('octa_cw',v==='narrow'||v==='wide'?v:null)}
const prefOf=k=>({density:store.get('octa_density')==='compact'?'compact':'comfy',cw:['narrow','wide'].includes(store.get('octa_cw'))?store.get('octa_cw'):'normal',accent:store.get('octa_accent')||''})[k];

// the page's zoom (text size below 100%): pointer moves are in screen pixels, widths in CSS pixels
const pageZoom=()=>parseFloat(document.documentElement.style.zoom)||1;
/* ---------- the sidebar's width: drag its right edge (double-click: back to normal) ---------- */
(()=>{const side=$('side');if(!side)return;const g=document.createElement('div');g.className='side-grip';g.id='sideGrip';g.setAttribute('role','separator');g.setAttribute('aria-orientation','vertical');g.tabIndex=0;
  g.setAttribute('aria-label',I18N.t('調整對話列表寬度'));side.appendChild(g);
  const root=document.documentElement,set=(w,save)=>{w=Math.round(Math.min(440,Math.max(220,w)));root.style.setProperty('--side-w',w+'px');if(save)store.set('octa_sidew',String(w));if(typeof dockSync==='function')dockSync()};
  let x0=0,w0=0,on=false;
  g.addEventListener('pointerdown',e=>{if(phoneUI()||e.button!==0)return;on=true;x0=e.clientX;w0=side.offsetWidth;g.setPointerCapture(e.pointerId);$('app').classList.add('side-drag');e.preventDefault()});
  g.addEventListener('pointermove',e=>{if(on)set(w0+(e.clientX-x0)/pageZoom(),false)});
  const end=()=>{if(!on)return;on=false;$('app').classList.remove('side-drag');set(side.offsetWidth,true)};
  g.addEventListener('pointerup',end);g.addEventListener('pointercancel',end);
  g.addEventListener('dblclick',()=>{root.style.removeProperty('--side-w');store.set('octa_sidew',null);if(typeof dockSync==='function')dockSync()});
  g.addEventListener('keydown',e=>{const d={ArrowLeft:-16,ArrowRight:16}[e.key];if(!d)return;e.preventDefault();set(side.offsetWidth+d,true)})})();

/* ---------- the order of the sidebar rows: drag a row above or below another (kept on this device) ---------- */
let ORDER=[];try{ORDER=JSON.parse(store.get('octa_order')||'[]')}catch(e){}
// rows in your order; the ones you never moved keep their usual place after them
function ordered(list){if(!ORDER.length)return list;const at=new Map(ORDER.map((id,i)=>[id,i]));
  return list.map((x,i)=>[x,i]).sort((a,b)=>(at.has(a[0].id)?at.get(a[0].id):1e6+a[1])-(at.has(b[0].id)?at.get(b[0].id):1e6+b[1])).map(a=>a[0])}
function moveRow(id,target,after){if(id===target)return;const all=[...S.pins||[],...S.groups.map(g=>g.id),...S.bots.map(b=>b.id)];
  let o=ordered([...S.groups,...S.bots]).map(x=>x.id);o=o.filter(x=>x!==id);let i=o.indexOf(target);if(i<0)i=o.length;o.splice(after?i+1:i,0,id);
  ORDER=o.filter(x=>all.includes(x));store.set('octa_order',JSON.stringify(ORDER));renderList()}
function resetOrder(){ORDER=[];store.set('octa_order',null);renderList()}

/* ---------- Settings → 外觀與語言 ---------- */
SEC.look=()=>{
  // 4.8: everything here applies the moment you pick it (no 儲存); it is kept on this device
  const theme=themeChoice(),fs=currentFsPercent();
  block('sLook','配色').innerHTML=`<div class="theme-pick" role="radiogroup" aria-label="配色">
    ${[['system','跟隨系統','monitor'],['light','淺色','sun'],['dark','深色','moon']].map(([k,t,i])=>`<button type="button" role="radio" data-set-theme="${k}" class="${theme===k?'on':''}" aria-checked="${theme===k}"><span class="swatch ${k}"></span><span class="tp">${ic(i)}<b>${t}</b></span></button>`).join('')}</div>`;
  const acc=prefOf('accent');
  block('sAccent','主題色','按鈕、連結和你的對話泡泡用的顏色。').innerHTML=`<div class="swatches" role="radiogroup" aria-label="主題色">
    <button type="button" role="radio" class="sw0${acc?'':' on'}" data-accent="" aria-checked="${!acc}" title="${esc(I18N.t('預設（金色）'))}"><span style="background:#b8862e"></span></button>
    ${PALETTE.map(([h,n])=>`<button type="button" role="radio" class="sw0${acc.toLowerCase()===h.toLowerCase()?' on':''}" data-accent="${h}" aria-checked="${acc.toLowerCase()===h.toLowerCase()}" title="${esc(I18N.t(n))}" aria-label="${esc(I18N.t(n))}"><span style="background:${h}"></span></button>`).join('')}</div>`;
  block('sSize','字體大小').innerHTML=`<div class="fslide"><span class="a1">A</span><input id="fsRange" type="range" min="70" max="200" step="5" value="${fs}" aria-label="字體大小" list="fsMarks"><datalist id="fsMarks"><option value="75"></option><option value="100"></option><option value="150"></option></datalist><span class="a2">A</span></div>
    <div class="fsrow"><div class="fslab" id="fsLab">${fsName(fs)} · ${fs}%</div><div class="fsq">${[75,90,100,115].map(v=>`<button type="button" class="ghost sm" data-fs="${v}">${v}%</button>`).join('')}</div></div>
    <div class="sample" aria-hidden="true"><div class="sb me2">幫我整理這週的進度</div><div class="sb">好，整理好了，重點有三項。</div></div>`;
  const seg=(id,label,cur,opts)=>`<div class="seg pref" id="${id}" role="radiogroup" aria-label="${esc(I18N.t(label))}">${opts.map(([k,t,d])=>`<button type="button" role="radio" data-v="${k}" class="${cur===k?'on':''}" aria-checked="${cur===k}"><b>${t}</b>${d?`<small>${d}</small>`:''}</button>`).join('')}</div>`;
  block('sDensity','版面').innerHTML=`<div class="prow"><span class="plab">密度</span>${seg('pDensity','密度',prefOf('density'),[['comfy','舒適','留白多、預覽兩行'],['compact','緊湊','一眼看到更多']])}</div>
    <div class="prow"><span class="plab">對話寬度</span>${seg('pCw','對話寬度',prefOf('cw'),[['narrow','窄',''],['normal','標準',''],['wide','寬','']])}</div>
    <div class="prow"><span class="plab">側邊欄與工作面板</span><span class="pnote">拖它們的邊緣就能調整寬度，會記在這台裝置。</span><button type="button" class="ghost sm" id="pReset">${ic('refresh')}<span>恢復預設寬度與排序</span></button></div>`;
  block('sKeys','鍵盤快捷鍵').innerHTML=`<div class="row2"><span class="pnote">在任何畫面按 <kbd>?</kbd> 也能叫出來。</span><button type="button" class="ghost sm" id="pKeys">${ic('keyboard')}<span>看全部快捷鍵</span></button></div>`;
  block('sLang','語言','介面文字和機器人回覆用的語言。').innerHTML=`<div class="row2">${I18N.select('sLangSel')}</div>`;
  const nick=block('sNick','怎麼稱呼你','沒填的話，機器人會直接用「你」稱呼你。規則或資料裡寫的「老闆」，機器人也會當成是你。');
  nick.innerHTML=`<div class="row2"><input id="nick" maxlength="20" class="grow" value="${esc(S.nick||'')}" placeholder="例如：Yz、阿哲"><span class="saved" id="nickOk" hidden>${ic('check')}<span>已儲存</span></span></div>`;
  paintIcons($('sblocks'));
  document.querySelectorAll('[data-set-theme]').forEach(x=>x.addEventListener('click',()=>x.parentNode.querySelectorAll('[role=radio]').forEach(r=>r.setAttribute('aria-checked',String(r===x)))));
  $('sLangSel').onchange=e=>setLang(e.target.value);
  $('fsRange').oninput=e=>applyFs(e.target.value);
  $('sSize').querySelectorAll('[data-fs]').forEach(b=>b.onclick=()=>{$('fsRange').value=b.dataset.fs;applyFs(b.dataset.fs)});
  const pick=(box,fn)=>box.onclick=e=>{const b=e.target.closest('[role=radio]');if(!b)return;box.querySelectorAll('[role=radio]').forEach(r=>{const on=r===b;r.classList.toggle('on',on);r.setAttribute('aria-checked',String(on))});fn(b.dataset.v??b.dataset.accent)};
  pick($('sAccent').querySelector('.swatches'),applyAccent);
  pick($('sDensity').querySelector('#pDensity'),applyDensity);
  pick($('sDensity').querySelector('#pCw'),applyChatWidth);
  $('pReset').onclick=()=>{document.documentElement.style.removeProperty('--side-w');store.set('octa_sidew',null);$('app').style.removeProperty('--wpw');$('app').style.removeProperty('--wpw-web');store.set('octa_wpw',null);store.set('octa_wpw_web',null);resetOrder();toast(I18N.t('已恢復預設寬度與排序'))};
  $('pKeys').onclick=()=>shortcutSheet();
  // the name saves itself a moment after you stop typing
  let t=0;const save=async()=>{const v=$('nick').value.trim();if(v===(S.nick||''))return;try{await api('settings','PUT',{nick:v});S.nick=v;const ok=$('nickOk');if(ok){ok.hidden=false;clearTimeout(save.t);save.t=setTimeout(()=>{ok.hidden=true},1600)}}catch(e){toast(e.message)}};
  $('nick').oninput=()=>{clearTimeout(t);t=setTimeout(save,700)};$('nick').onblur=()=>{clearTimeout(t);save()};
  $('nick').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();clearTimeout(t);save()}};
};

/* ---------- keyboard shortcuts (？ or Settings → 外觀與語言) ---------- */
const MODK=/Mac|iPhone|iPad/.test(navigator.platform)?'⌘':'Ctrl';
const SHORTCUTS=[[MODK+' K','搜尋機器人'],[MODK+' I','打開或收起工作面板'],[MODK+' ,','設定'],['Alt N','新增機器人'],['Enter','送出（Shift Enter 換行）'],['Esc','關閉對話框或面板'],['Alt ↑ / Alt ↓','上一個／下一個對話'],['?','這張快捷鍵表']];
function shortcutSheet(){openSheet(`${sheetHead('鍵盤快捷鍵')}<dl class="keys">${SHORTCUTS.map(([k,t])=>`<div><dt>${k.split(' ').map(x=>x==='/'?'<span>/</span>':`<kbd>${esc(x)}</kbd>`).join(' ')}</dt><dd>${esc(I18N.t(t))}</dd></div>`).join('')}</dl><div class="acts"><button type="button" class="btn" id="sx">好</button></div>`,'sm');$('sx').onclick=closeSheet}
// Alt+↑／↓: the conversation above / below in the sidebar
function stepConv(d){const ids=[...$('list').querySelectorAll('.item[data-id]')].map(x=>x.dataset.id);if(!ids.length)return;
  const i=ids.indexOf(cur),n=ids[Math.max(0,Math.min(ids.length-1,(i<0?(d>0?-1:ids.length):i)+d))];if(n&&n!==cur)openConv(n)}
document.addEventListener('keydown',e=>{if($('app').hidden)return;const typing=/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName||'')||document.activeElement?.isContentEditable;
  if(e.key==='?'&&!typing&&!e.ctrlKey&&!e.metaKey&&$('veil').hidden){e.preventDefault();shortcutSheet();return}
  if(e.altKey&&!e.ctrlKey&&!e.metaKey&&(e.key==='ArrowUp'||e.key==='ArrowDown')&&$('veil').hidden){e.preventDefault();stepConv(e.key==='ArrowUp'?-1:1)}});
