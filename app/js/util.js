/* OCTA web app — small shared helpers: DOM, escaping, icons, look, toasts, time. Loaded first. */
'use strict';
/* keep the page in the area above the phone keyboard */
(function(){const vv=window.visualViewport;if(!vv)return;const root=document.documentElement;const pin=()=>{const gap=Math.max(0,Math.round(window.innerHeight-vv.height-vv.offsetTop));const on=gap>60;
  root.classList.toggle('kb',on);
  if(on){root.style.setProperty('--kb',gap+'px');root.style.setProperty('--vvt',Math.round(vv.offsetTop)+'px');root.style.setProperty('--vvh',Math.round(vv.height)+'px');window.scrollTo(0,0)}
  else{root.style.removeProperty('--kb');root.style.removeProperty('--vvt');root.style.removeProperty('--vvh')}};
vv.addEventListener('resize',pin);vv.addEventListener('scroll',pin);pin();
document.addEventListener('focusin',e=>{if(e.target.matches?.('input,textarea,select'))setTimeout(()=>e.target.scrollIntoView({block:'nearest'}))});})();

const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const store={get(k,d=null){try{const v=localStorage.getItem(k);return v===null?d:v}catch(e){return d}},set(k,v){try{v==null?localStorage.removeItem(k):localStorage.setItem(k,v)}catch(e){}}};

/* ---------- icons: one stroke set (24×24, 1.8px) so the chrome is consistent; content keeps its emoji ---------- */
const ICONS={
  plus:'<path d="M12 5v14M5 12h14"/>',
  search:'<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4-4"/>',
  settings:'<path d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Z"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
  globe:'<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3Z"/>',
  sidebar:'<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M9.5 4.5v15"/>',
  panel:'<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M14.5 4.5v15"/>',
  more:'<circle cx="5.5" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.3" fill="currentColor" stroke="none"/>',
  back:'<path d="m14.5 5-7 7 7 7"/>',
  chev:'<path d="m9.5 6 6 6-6 6"/>',
  down:'<path d="M12 5v14M6 13l6 6 6-6"/>',
  x:'<path d="M6 6l12 12M18 6 6 18"/>',
  send:'<path d="M12 19V5M6 11l6-6 6 6"/>',
  clip:'<path d="m20.5 11.5-8.4 8.4a5 5 0 0 1-7.1-7.1l8.8-8.8a3.3 3.3 0 0 1 4.7 4.7l-8.8 8.8a1.7 1.7 0 0 1-2.4-2.4l8-8"/>',
  slash:'<path d="M15.5 4 8.5 20"/>',
  mic:'<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>',
  reply:'<path d="M9.5 8 5 12.5 9.5 17"/><path d="M5 12.5h9a5 5 0 0 1 5 5V19"/>',
  check:'<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  copy:'<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5"/>',
  edit:'<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4Z"/><path d="m13.5 6.5 4 4"/>',
  trash:'<path d="M4.5 7h15M10 11v6M14 11v6M6.5 7l1 12a2 2 0 0 0 2 1.8h5a2 2 0 0 0 2-1.8l1-12M9.5 7V4.8c0-.5.4-.8.8-.8h3.4c.5 0 .8.3.8.8V7"/>',
  pin:'<path d="M9 4h6l-1 6 3.5 3.5V15h-11v-1.5L10 10 9 4Z"/><path d="M12 15v5"/>',
  bell:'<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 1.5h-15L6 16.5ZM10 20.5a2 2 0 0 0 4 0"/>',
  belloff:'<path d="M6 16.5V11c0-1 .2-1.9.7-2.7M9 5.6A6 6 0 0 1 18 11v4M4 4l16 16M10 20.5a2 2 0 0 0 4 0M4.5 18h12"/>',
  folder:'<path d="M3.5 7.5A2 2 0 0 1 5.5 5.5H10l2 2h6.5a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-10Z"/>',
  users:'<circle cx="9" cy="8.5" r="3.3"/><path d="M3 19.5a6 6 0 0 1 12 0"/><path d="M15.5 5.6a3.3 3.3 0 0 1 0 6M17.5 14.2a6 6 0 0 1 3.5 5.3"/>',
  bot:'<rect x="4.5" y="8" width="15" height="11" rx="3"/><path d="M12 4.5V8M9 13h.01M15 13h.01M9.5 16.5h5"/>',
  sparkle:'<path d="M12 3.5c.6 3.9 2.6 5.9 6.5 6.5-3.9.6-5.9 2.6-6.5 6.5-.6-3.9-2.6-5.9-6.5-6.5 3.9-.6 5.9-2.6 6.5-6.5Z"/><path d="M18.5 15.5c.2 1.6 1 2.4 2.5 2.5-1.5.2-2.3 1-2.5 2.5-.2-1.5-1-2.3-2.5-2.5 1.5-.1 2.3-.9 2.5-2.5Z"/>',
  clock:'<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  brain:'<path d="M9 4.5a3 3 0 0 0-3 3 3 3 0 0 0-1.5 5.5A3 3 0 0 0 7 18a2.5 2.5 0 0 0 5 .5V6A2 2 0 0 0 9 4.5ZM15 4.5a3 3 0 0 1 3 3 3 3 0 0 1 1.5 5.5A3 3 0 0 1 17 18a2.5 2.5 0 0 1-5 .5"/>',
  shield:'<path d="M12 3.5 5 6v5.5c0 4.3 3 7.6 7 9 4-1.4 7-4.7 7-9V6l-7-2.5Z"/><path d="m9 12 2 2 4-4"/>',
  link:'<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  phone:'<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
  code:'<path d="m9 8-4.5 4L9 16M15 8l4.5 4-4.5 4"/>',
  list:'<path d="M9 6.5h11M9 12h11M9 17.5h11M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01"/>',
  chart:'<path d="M4.5 19.5h15M7.5 16v-5M12 16V7M16.5 16v-8"/>',
  info:'<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.8h.01"/>',
  sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"/>',
  moon:'<path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10Z"/>',
  monitor:'<rect x="3" y="4.5" width="18" height="12" rx="2"/><path d="M8.5 20h7M12 16.5V20"/>',
  stop:'<rect x="6.5" y="6.5" width="11" height="11" rx="2"/>',
  compress:'<path d="M4 9.5h5.5V4M20 9.5h-5.5V4M4 14.5h5.5V20M20 14.5h-5.5V20"/>',
  eraser:'<path d="M8.5 20h11M5.3 14.7l8.9-8.9a2 2 0 0 1 2.8 0l2.2 2.2a2 2 0 0 1 0 2.8l-7.6 7.6a2 2 0 0 1-1.4.6H8.6a2 2 0 0 1-1.4-.6l-1.9-1.9a1.3 1.3 0 0 1 0-1.8Z"/>',
  image:'<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="m20.5 16-4.8-4.8L6 19.5"/>',
  zap:'<path d="M13 3 5 13.5h6L10.5 21 19 10h-6L13 3Z"/>',
  file:'<path d="M14 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-10L14 3.5Z"/><path d="M14 3.5v5h5"/>',
  note:'<path d="M5.5 4.5h13v15h-13z"/><path d="M8.5 8.5h7M8.5 12h7M8.5 15.5h4"/>',
  help:'<circle cx="12" cy="12" r="8.5"/><path d="M9.6 9.4a2.5 2.5 0 0 1 4.8 1c0 1.7-2.4 2.2-2.4 3.6M12 17h.01"/>',
  refresh:'<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3L19.5 9"/><path d="M19.5 4.5V9H15"/>',
  play:'<path d="M8 5.5v13l10.5-6.5L8 5.5Z"/>',
  hand:'<path d="M8.5 12V6.5a1.5 1.5 0 0 1 3 0V11M11.5 10.5v-6a1.5 1.5 0 0 1 3 0v6M14.5 10.5V7a1.5 1.5 0 0 1 3 0v7a6.5 6.5 0 0 1-6.5 6.5h-.5a6 6 0 0 1-4.6-2.2L3.6 15a1.6 1.6 0 0 1 2.3-2.2L8.5 15"/>',
  wrench:'<path d="M14.5 5.5a4.5 4.5 0 0 0-5.4 5.8l-5 5a1.8 1.8 0 0 0 2.6 2.6l5-5a4.5 4.5 0 0 0 5.8-5.4l-2.6 2.6-2.4-.6-.6-2.4 2.6-2.6Z"/>',
  sliders:'<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
  palette:'<path d="M12 3.5a8.5 8.5 0 0 0 0 17c1.2 0 1.8-.8 1.8-1.7 0-.9-.6-1.3-.6-2.1 0-.9.7-1.6 1.6-1.6h2a3.7 3.7 0 0 0 3.7-3.7c0-4.4-3.8-7.9-8.5-7.9Z"/><circle cx="7.5" cy="11.5" r="1" fill="currentColor"/><circle cx="10" cy="7.5" r="1" fill="currentColor"/><circle cx="14.5" cy="7.5" r="1" fill="currentColor"/>',
  plug:'<path d="M9 3.5v4M15 3.5v4M6.5 7.5h11v3a5.5 5.5 0 0 1-11 0v-3ZM12 16v4.5"/>',
  briefcase:'<rect x="3.5" y="7" width="17" height="12.5" rx="2"/><path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7M3.5 12.5h17"/>',
  external:'<path d="M14 4.5h5.5V10M19.5 4.5 11 13M18 14v4a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18V7a1.5 1.5 0 0 1 1.5-1.5h4"/>',
  hide:'<path d="M12 5v10M7.5 10.5 12 15l4.5-4.5M5 19.5h14"/>'
};
const ic=(n,cls='')=>`<svg class="icon${cls?' '+cls:''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n]||ICONS.info}</svg>`;
function paintIcons(root=document){root.querySelectorAll('[data-i]').forEach(el=>{if(el.dataset.iDone===el.dataset.i)return;el.dataset.iDone=el.dataset.i;el.insertAdjacentHTML('afterbegin',ic(el.dataset.i))})}

/* ---------- loading screen and progress ---------- */
const boot={set(p,t){const f=$('bootFill');if(!f)return;f.style.width=p+'%';$('bootPct').textContent=Math.round(p)+'%';if(t)$('bootMsg').textContent=t},
  show(t){const b=$('boot');b.hidden=false;b.classList.remove('done');this.set(15,t)},
  hide(){const b=$('boot');if(b.hidden)return;b.classList.add('done');setTimeout(()=>{if(b.classList.contains('done'))b.hidden=true},320)}};
/* a thin bar for slow requests, a full overlay (blocks input) for heavy ones */
const ybar={n:0,t:null,on(block){this.n++;clearTimeout(this.t);this.t=setTimeout(()=>{document.body.classList.add('yloading');if(block)document.body.classList.add('yblock')},block?0:250)},
  off(){if(--this.n<=0){this.n=0;clearTimeout(this.t);document.body.classList.remove('yloading','yblock')}}};

function toast(t){let el=$('toast');if(!el){el=document.createElement('div');el.id='toast';el.className='toast';el.setAttribute('role','status');document.body.appendChild(el)}
  el.textContent=t;el.classList.add('on');clearTimeout(toast.t);toast.t=setTimeout(()=>el.classList.remove('on'),2200)}
const errText=e=>String(e?.message||e||'').replace(/^Error invoking remote method '[^']+': (Error: )?/,'');

/* ---------- look: system / light / dark (kept on this device) ---------- */
function themeChoice(){const s=store.get('octa_theme');return s==='light'||s==='dark'?s:'system'}
function currentTheme(){const t=document.documentElement.dataset.theme;if(t==='light'||t==='dark')return t;return matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}
function applyTheme(t,persist){
  const h=document.documentElement,was=currentTheme();
  if(t==='light'||t==='dark')h.dataset.theme=t;else delete h.dataset.theme;
  // colours fade over to the other look instead of snapping
  if(persist!==false&&was!==currentTheme()){h.classList.add('theming');clearTimeout(applyTheme.t);applyTheme.t=setTimeout(()=>h.classList.remove('theming'),420)}
  if(persist!==false)store.set('octa_theme',t==='light'||t==='dark'?t:null);
  document.querySelectorAll('[data-set-theme]').forEach(x=>x.classList.toggle('on',x.dataset.setTheme===themeChoice()))}
document.addEventListener('click',e=>{const set=e.target.closest('[data-set-theme]');if(set)applyTheme(set.dataset.setTheme)});

/* text size for the whole interface (kept on this device). 80–200, and 200 is twice the standard size. */
function fsName(p){return p<=90?'小':p<=105?'標準':p<150?'大':'特大'}
function currentFsPercent(){const f=store.get('octa_fs');const map={s:93,m:100,l:112,xl:200};if(map[f])return map[f];const n=Math.round(Number(f));return n>=80&&n<=200?n:100}
function applyFs(raw){let p=Math.round(Number(raw));if(!Number.isFinite(p))p=100;p=Math.min(200,Math.max(80,p));const z=p/100;const root=document.documentElement;root.style.setProperty('--fz',String(z));
  if(z>=1.6)root.dataset.fs='xl';else if(z>=1.08)root.dataset.fs='l';else if(z<=0.95)root.dataset.fs='s';else delete root.dataset.fs;
  store.set('octa_fs',String(p));const lab=$('fsLab');if(lab)lab.textContent=I18N.t(fsName(p))+' · '+p+'%';if(typeof grow==='function')grow()}

/* ---------- time ---------- */
const hm=ts=>ts?new Date(ts).toLocaleTimeString(I18N.lang,{hour:'2-digit',minute:'2-digit'}):'';
function dayLabel(ts){const d=new Date(ts),n=new Date(),same=(a,b)=>a.toDateString()===b.toDateString();
  if(same(d,n))return I18N.t('今天');const y=new Date(n);y.setDate(n.getDate()-1);if(same(d,y))return I18N.t('昨天');
  return d.toLocaleDateString(I18N.lang,{month:'short',day:'numeric',weekday:'short',...(d.getFullYear()!==n.getFullYear()?{year:'numeric'}:{})})}
const fmtTok=n=>n>=1e6?(n/1e6).toFixed(n>=1e7?0:1)+'M':n>=1e3?(n/1e3).toFixed(n>=1e4?0:1)+'K':String(n);
const elapsed=t=>{const s=Math.max(0,Math.round((Date.now()-t)/1000));return Math.floor(s/60)+':'+String(s%60).padStart(2,'0')};
setInterval(()=>document.querySelectorAll('.el[data-since]').forEach(e=>e.textContent=elapsed(+e.dataset.since)),1000);
const ago=t=>{const m=Math.round((Date.now()-t)/60000),rt=new Intl.RelativeTimeFormat(I18N.lang,{numeric:'auto'});return m<60?rt.format(-m,'minute'):m<1440?rt.format(-Math.round(m/60),'hour'):rt.format(-Math.round(m/1440),'day')};
const when=t=>t?new Date(t).toLocaleString(I18N.lang,{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}):'';
const setHTML=(el,h)=>{if(el._h!==h){el._h=h;el.innerHTML=h;return true}return false};

/* phone layout (one column) and touch screens */
const phoneUI=()=>matchMedia('(max-width:760px)').matches;
const COARSE=matchMedia('(hover:none) and (pointer:coarse)').matches;
