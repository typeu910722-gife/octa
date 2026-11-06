/* OCTA web app — start-up and keyboard shortcuts. Loaded last. */
'use strict';
paintIcons();
document.addEventListener('keydown',e=>{
  const app=!$('app').hidden,mod=e.ctrlKey||e.metaKey,k=e.key.toLowerCase();
  if(mod&&e.key===','&&app){e.preventDefault();openSettings()}
  if(app&&((mod&&k==='n'&&window.octaDesktop)||(e.altKey&&k==='n'))){e.preventDefault();newBotSheet()}
  if(mod&&k==='k'&&app){e.preventDefault();focusSearch()}
  if(mod&&k==='i'&&app&&cur){e.preventDefault();togglePanel()}
  // 4.10 Alt+O 總覽 (the whole base and every card); Alt+M folds / unfolds the chat over the base
  if(app&&e.altKey&&!mod&&e.code==='KeyO'&&$('veil').hidden){e.preventDefault();goOverview()}
  if(app&&e.altKey&&!mod&&e.code==='KeyM'&&$('veil').hidden&&stageMode()&&cur){e.preventDefault();chatMinimise(!STAGE.min)}
  if(e.key==='Escape'&&document.querySelector('.dguard')){document.querySelector('.dguard').remove();return}
  if(e.key==='Escape'&&!$('veil').hidden&&!document.querySelector('.menu')){closeSheet();return}
  if(e.key==='Escape'&&panelOn()&&$('veil').hidden&&!document.querySelector('.menu')&&$('wp').contains(document.activeElement))closePanel()});
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&cur)renderChat(false)});
addEventListener('resize',()=>{focusBrowser()});
let startFails=0;
async function start(){$('pair').hidden=true;
  boot.set(60,I18N.t('讀取機器人與對話…'));
  await refresh();
  if(!S.loaded){if(!$('pair').hidden){boot.hide();return}   // a phone whose pairing ended is back at the pairing screen
    if(++startFails>=2&&TOKEN&&backToGo()&&!SHELL)return;
    boot.set(50,I18N.t('連不上 OCTA，重試中…'));setTimeout(start,3000);return}
  if(cur)await loadMsgs(cur,'first').catch(()=>{});
  $('app').hidden=false;
  toShell('ready',{title:document.title});shellLook();shellPrefs();   // 4.14.1: /go takes its cover away
  focusBrowser();
  boot.set(100,I18N.t('完成'));boot.hide();
  render(true);live();scrDeepLink();viaStart();
  // 4.10 the deep-sea base on the main screen: three.js is fetched after the first paint, so starting is not slowed
  requestAnimationFrame(()=>setTimeout(seaBoot,250));
  if(PAIRED_NOW&&!store.get('octa_go')){PAIRED_NOW=false;goHint()}else if(tourOn())startTour();else whatsNew()}
(async()=>{boot.set(25,I18N.t('連線中…'));
  try{CFG=await (await fetch('/api/config')).json()}catch(e){}
  boot.set(45,I18N.t('載入介面…'));
  if(CFG.pair&&!TOKEN)showPair();else start();
  if(CFG.via)document.documentElement.classList.add('via')})();
