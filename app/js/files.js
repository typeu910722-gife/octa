/* OCTA web app — files: attachments, pictures, the browser-side cache, opening on this computer. */
'use strict';
const fileCache={},fileMeta={},FCACHE='octa-files-v1';
// files never change once saved: keep a copy in the browser so opening one again doesn't download it again
async function cacheGet(id){try{if(!window.caches)return null;const r=await (await caches.open(FCACHE)).match('/__octa_file/'+id);return r?await r.json():null}catch(e){return null}}
async function cachePut(id,d){try{if(!window.caches||!d?.data||d.data.length>12e6)return;await (await caches.open(FCACHE)).put('/__octa_file/'+id,new Response(JSON.stringify(d),{headers:{'content-type':'application/json'}}))}catch(e){}}
function metaOf(id){return fileMeta[id]||(fileMeta[id]=api('file/'+id+'?meta=1').catch(e=>{delete fileMeta[id];throw e}))}
async function loadFile(id){
  if(DESK()){   // on the computer itself: read the copy straight from disk
    try{const m=await metaOf(id);if(m.path){const r=await api('desktop/file','POST',{path:m.path});if(r.data)return {name:m.name,mime:m.mime,data:r.data,local:m.path}}}catch(e){}}
  const hit=await cacheGet(id);if(hit)return hit;
  const d=await api('file/'+id);cachePut(id,d);return d}
async function fileData(id){const p=fileCache[id]||(fileCache[id]=loadFile(id));p.catch(()=>delete fileCache[id]);return p}

/* what is about to be sent, and what was sent: pictures as squares, other files as a card with type and size */
const fsize=n=>!n?'':n<1024?n+' B':n<1048576?(n/1024).toFixed(n<10240?1:0)+' KB':(n/1048576).toFixed(1)+' MB';
function fext(name){const m=/\.([a-z0-9]{1,6})$/i.exec(name||'');return m?m[1].toUpperCase():''}
function fico(name,mime){const e=fext(name).toLowerCase();
  if(/^image\//.test(mime||''))return '🖼';if(/^audio\//.test(mime||'')||/^(mp3|wav|m4a|ogg)$/.test(e))return '🎵';if(/^video\//.test(mime||'')||/^(mp4|mov|webm|mkv)$/.test(e))return '🎬';
  if(e==='pdf')return '📕';if(/^(xlsx?|csv|numbers)$/.test(e))return '📊';if(/^(docx?|txt|md|rtf|pages)$/.test(e))return '📝';if(/^(pptx?|key)$/.test(e))return '📽';if(/^(json|xml|ya?ml|toml)$/.test(e))return '🧾';if(/^(zip|rar|7z|gz|tar)$/.test(e))return '🗜';if(/^(js|mjs|ts|py|go|rs|java|c|cpp|h|css|html|sh)$/.test(e))return '💻';return '📄'}
function filesHtml(fs){if(!fs||!fs.length)return '';return `<div class="files">${fs.map(f=>/^image\//.test(f.mime)?`<img class="thumb" data-file="${esc(f.id)}" alt="${esc(f.name)}">`
  :/^video\//.test(f.mime)?`<button type="button" class="fcard vcard" data-vplay="${esc(f.id)}" title="${esc(f.name)}"><span class="fico">▶</span><span class="ft"><b data-u>${esc(f.name)}</b><small><span>播放影片</span>${f.size?' · '+fsize(f.size):''}</small></span></button>`   // 4.12: a generated video plays right in the chat
  :`<button type="button" class="fcard" data-open-file="${esc(f.id)}" title="${esc(f.name)}"><span class="fico">${fico(f.name,f.mime)}</span><span class="ft"><b data-u>${esc(f.name)}</b><small data-u>${esc([fext(f.name)||I18N.t('檔案'),fsize(f.size)].filter(Boolean).join(' · '))}</small></span></button>`).join('')}</div>`}
function loadThumbs(root){root.querySelectorAll('img[data-file]:not([src]):not([data-err])').forEach(im=>fileData(im.dataset.file).then(d=>im.src=`data:${d.mime};base64,${d.data}`).catch(e=>{im.dataset.err=1;im.replaceWith(Object.assign(document.createElement('button'),{type:'button',className:'fchip',textContent:'🖼 '+(im.alt||'')+' · '+I18N.t('點一下重新載入'),onclick(){openFile(im.dataset.file)}}))}))}
// 4.12: the video loads only when you press play (it can be tens of MB)
async function playVideo(btn){const id=btn.dataset.vplay;btn.disabled=true;
  try{const d=await fileData(id);const u=URL.createObjectURL(await (await fetch(`data:${d.mime};base64,${d.data}`)).blob());
    const v=document.createElement('video');v.className='vplay';v.controls=true;v.autoplay=true;v.playsInline=true;v.src=u;v.setAttribute('aria-label',d.name);btn.replaceWith(v)}
  catch(e){btn.disabled=false;toast(e.message)}}
document.addEventListener('click',e=>{const b=e.target.closest('[data-vplay]');if(b)playVideo(b)});
async function openFile(id){const t=setTimeout(()=>toast(I18N.t('讀取檔案中…')),400);
  try{const d=await fileData(id);clearTimeout(t);const u=URL.createObjectURL(await (await fetch(`data:${d.mime};base64,${d.data}`)).blob());
    if(/^image\//.test(d.mime))return viewImage(d,u);
    if(d.local&&!/^text\/|pdf$/.test(d.mime)){await api('desktop/open-file','POST',{path:d.local});return}   // on the computer: open with its usual app
    if(/^text\/|pdf$/.test(d.mime))window.open(u,'_blank');else{const a=document.createElement('a');a.href=u;a.download=d.name;a.click()}}
  catch(e){clearTimeout(t);toast(e.message)}}
// pictures open inside OCTA (no new window, no download); download only when you ask
function viewImage(d,u){
  $('veil').innerHTML=`<div class="lbox"><img src="${u}" alt=""><div class="lbar"><span data-u>${esc(d.name)}</span><span class="grow"></span>
    <a class="ghost" href="${u}" download="${esc(d.name)}">下載</a>${d.local?'<button type="button" class="ghost" id="lbShow">在資料夾中顯示</button>':''}<button type="button" class="btn" id="lbX">關閉</button></div></div>`;
  $('veil').hidden=false;$('lbX').onclick=closeSheet;if($('lbShow'))$('lbShow').onclick=()=>api('desktop/show-file','POST',{path:d.local}).catch(e=>toast(e.message));
  $('veil').querySelector('.lbox').onclick=e=>{if(e.target.classList.contains('lbox'))closeSheet()}}
const b64=blob=>new Promise((ok,no)=>{const r=new FileReader();r.onload=()=>ok(String(r.result).split(',')[1]);r.onerror=no;r.readAsDataURL(blob)});
async function shrink(file){const img=await createImageBitmap(file);const k=Math.min(1,1600/Math.max(img.width,img.height));
  const c=document.createElement('canvas');c.width=Math.round(img.width*k);c.height=Math.round(img.height*k);c.getContext('2d').drawImage(img,0,0,c.width,c.height);
  return new Promise(ok=>c.toBlob(ok,'image/jpeg',.82))}
// one file → {conv,name,mime,data} for POST files (pictures are shrunk to 1600px JPEG, GIFs kept)
async function filePayload(file,convId){const isImg=/^image\//.test(file.type)&&file.type!=='image/gif';const blob=isImg?await shrink(file):file;
  if(blob.size>10_000_000)throw new Error(file.name+' '+I18N.t('太大（上限 10MB）'));
  return {blob,body:{conv:convId,name:isImg?file.name.replace(/\.\w+$/,'')+'.jpg':file.name,mime:isImg?'image/jpeg':(file.type||'application/octet-stream'),data:await b64(blob)}}}
