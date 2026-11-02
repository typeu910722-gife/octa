/* OCTA web app — start-up and keyboard shortcuts. Loaded last. */
'use strict';
paintIcons();
document.addEventListener('keydown',e=>{
  const app=!$('app').hidden,mod=e.ctrlKey||e.metaKey,k=e.key.toLowerCase();
  if(mod&&e.key===','&&app){e.preventDefault();openSettings()}
  if(app&&((mod&&k==='n'&&window.octaDesktop)||(e.altKey&&k==='n'))){e.preventDefault();newBotSheet()}
  if(mod&&k==='k'&&app){e.preventDefault();focusSearch()}
  if(mod&&k==='i'&&app&&cur){e.preventDefault();togglePanel()}
  if(e.key==='Escape'&&document.querySelector('.dguard')){document.querySelector('.dguard').remove();return}
  if(e.key==='Escape'&&!$('veil').hidden&&!document.querySelector('.menu')){closeSheet();return}
  if(e.key==='Escape'&&panelOn()&&$('veil').hidden&&!document.querySelector('.menu')&&$('wp').contains(document.activeElement))closePanel()});
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&cur)renderChat(false)});
addEventListener('resize',()=>{focusBrowser()});
async function start(){$('pair').hidden=true;
  boot.set(60,I18N.t('讀取機器人與對話…'));
  await refresh();
  if(!S.loaded){if(!$('pair').hidden){boot.hide();return}   // a phone whose pairing ended is back at the pairing screen
    boot.set(50,I18N.t('連不上 OCTA，重試中…'));setTimeout(start,3000);return}
  if(cur)await loadMsgs(cur,'first').catch(()=>{});
  $('app').hidden=false;
  focusBrowser();
  boot.set(100,I18N.t('完成'));boot.hide();
  render(true);live();
  if(tourOn())startTour();else whatsNew()}
(async()=>{boot.set(25,I18N.t('連線中…'));
  try{CFG=await (await fetch('/api/config')).json()}catch(e){}
  boot.set(45,I18N.t('載入介面…'));
  if(CFG.pair&&!TOKEN)showPair();else start()})();
