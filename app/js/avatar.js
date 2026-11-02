/* OCTA web app — every bot is the OCTA octopus (app/avatar/*.svg), drawn inline (zoomed in so it fills a small circle) so it takes the bot's colour.
   Five states: idle · thinking · working · browsing · chatting (botState in pure.js decides which).
   Only avatars that matter move (.live); everything else is a still pose, and nothing moves with reduced motion.
   No ids inside the drawing, so any number of them can be on the page. */
'use strict';
const OA_STAR='M 0 -26 Q 4 -4 26 0 Q 4 4 0 26 Q -4 4 -26 0 Q -4 -4 0 -26 Z';
const OA_LEGS='<g class="oa-legs"><path class="oa-leg oa-l1" style="--o:160px 300px" d="M 160 300 C 120 350 80 370 64 342 C 54 322 72 302 92 314"/><path class="oa-leg oa-l2" style="--o:210px 340px" d="M 210 340 C 196 410 168 440 140 430 C 120 422 124 398 144 400"/><path class="oa-leg oa-r1" style="--o:352px 300px" d="M 352 300 C 392 350 432 370 448 342 C 458 322 440 302 420 314"/><path class="oa-leg oa-r2" style="--o:302px 340px" d="M 302 340 C 316 410 344 440 372 430 C 392 422 388 398 368 400"/></g>';
const OA_BODY='<circle class="oa-body" cx="256" cy="215" r="140"/>';
const OA_EYES='<g class="oa-eyes"><g transform="translate(208 225) rotate(-14)"><path class="oa-eye" d="M 0 -46 Q 27 0 0 46 Q -27 0 0 -46 Z"/></g><g transform="translate(304 225) rotate(14)"><path class="oa-eye" d="M 0 -46 Q 27 0 0 46 Q -27 0 0 -46 Z"/></g></g>';
const OA_SHUT='<g class="oa-eyes oa-shut"><path transform="translate(208 236) rotate(-8)" d="M -26 -6 Q 0 16 26 -6"/><path transform="translate(304 236) rotate(8)" d="M -26 -6 Q 0 16 26 -6"/></g>';
const oaStar=(x,y,k)=>`<g class="oa-star"><path transform="translate(${x} ${y}) scale(${k})" d="${OA_STAR}"/></g>`;
const OA_LAPTOP=`<rect class="oa-dk" x="-75" y="-55" width="150" height="100" rx="12"/><path class="oa-dm" transform="translate(0 -5) scale(.55)" d="${OA_STAR}"/><rect class="oa-dk" x="-92" y="45" width="184" height="15" rx="7.5"/>`;
const OA_PHONE='<rect class="oa-dk" x="-38" y="-66" width="76" height="132" rx="16"/><rect class="oa-scr" x="-29" y="-54" width="58" height="104" rx="8"/><rect class="oa-m oa-m1" x="-23" y="-46" width="30" height="12" rx="6"/><rect class="oa-m oa-m2" x="-5" y="-28" width="30" height="12" rx="6"/><rect class="oa-m oa-m3" x="-23" y="-10" width="36" height="12" rx="6"/><g class="oa-ln"><rect x="-23" y="18" width="46" height="5" rx="2.5"/><rect x="-23" y="28" width="46" height="5" rx="2.5"/><rect x="-23" y="38" width="46" height="5" rx="2.5"/></g>';
const oaDev=(inner,v)=>[`<g class="oa-dev oa-dev-b" style="${v}">${inner}</g>`,`<g class="oa-dev oa-dev-f" style="${v}">${inner}</g>`];
const OA_DRAW={
  idle:()=>OA_LEGS+OA_BODY+OA_SHUT+oaStar(256,410,.7)+'<g class="oa-zs"><text class="oa-z oa-z1" x="368" y="140" font-size="46">z</text><text class="oa-z oa-z2" x="368" y="140" font-size="36">z</text><text class="oa-z oa-z3" x="368" y="140" font-size="28">z</text></g>',
  working:()=>OA_LEGS+OA_BODY+OA_EYES+oaStar(256,410,.7),
  thinking:()=>OA_LEGS+OA_BODY+OA_EYES+[[45,.6],[65,.42],[27,.5],[55,.36],[37,.3]].map(([y,k],i)=>`<g class="oa-o oa-o${i}">${oaStar(256,y,k)}</g>`).join(''),
  browsing:()=>{const [b,f]=oaDev(OA_LAPTOP,'--r0:rotate(0deg);--r1:rotate(0deg);--tx:330px;--ty:20px;--fx:256px;--fy:352px');
    return b+OA_LEGS+OA_BODY+OA_EYES+f+'<g class="oa-show oa-tap"><path class="oa-tapA" d="M 150 420 C 158 400 168 392 182 392"/><path class="oa-tapB" d="M 362 420 C 354 400 344 392 330 392"/></g>'},
  chatting:()=>{const [b,f]=oaDev(OA_PHONE,'--r0:rotate(0deg);--r1:rotate(-12deg);--tx:372px;--ty:4px;--fx:338px;--fy:350px');
    return b+OA_LEGS+OA_BODY+OA_EYES+f+'<g class="oa-show oa-tap"><path class="oa-tapA" d="M 236 420 C 262 424 292 414 312 396"/></g>'}};
const OA_CACHE={};
// one drawing: state, body colour, moving or still
function octSvg(state,color,live){const s=OA_DRAW[state]?state:'idle',c=colorHex(color)||OC_DEFAULT;
  const inner=OA_CACHE[s]||(OA_CACHE[s]=OA_DRAW[s]());
  return `<svg class="oa s-${s}${live?' live':''}" viewBox="0 0 512 512" style="--oc:${c};--os:${accentOf(c)}" aria-hidden="true" focusable="false"><g transform="translate(-10.4 35.7) scale(1.0418)"><g class="oa-bob">${inner}</g></g></svg>`}
const colorOf=id=>colorHex(bot(id)?.color)||OC_DEFAULT;
const stateOf=id=>botState(id,S.busy);
// a bot's face. live: it moves while the bot is doing something (sidebar rows, the open chat's header, the work panel)
function avOf(id,live){const b=bot(id);if(!b)return init(nameOf(id));const st=live?stateOf(id):'idle';return octSvg(st,b.color,live&&st!=='idle'||live==='always')}
const STATE_LABEL={idle:'待命',thinking:'思考中',working:'工作中',browsing:'操作瀏覽器',chatting:'和其他機器人交流'};

/* ---------- the colour picker: a palette of swatches (Grok Bot style), arrow keys move, Enter/Space picks ---------- */
function paletteHtml(sel,id='pal'){const cur=colorHex(sel)||OC_DEFAULT;
  return `<div class="pal" id="${id}" role="radiogroup" aria-label="${esc(I18N.t('顏色'))}">${PALETTE.map(([c,n])=>{const on=c===cur;
    return `<button type="button" class="sw8${on?' on':''}" role="radio" aria-checked="${on}" tabindex="${on?0:-1}" data-col="${c}" style="--oc:${c}" title="${esc(I18N.t(n))}" aria-label="${esc(I18N.t(n))}">${ic('check')}</button>`}).join('')}</div>`}
function bindPalette(box,onPick){if(!box)return {get:()=>OC_DEFAULT};let val=box.querySelector('.sw8.on')?.dataset.col||OC_DEFAULT;
  const pick=(b,focus)=>{if(!b)return;val=b.dataset.col;box.querySelectorAll('.sw8').forEach(x=>{const on=x===b;x.classList.toggle('on',on);x.setAttribute('aria-checked',String(on));x.tabIndex=on?0:-1});if(focus)b.focus();onPick?.(val)};
  box.onclick=e=>pick(e.target.closest('.sw8'));
  box.onkeydown=e=>{const all=[...box.querySelectorAll('.sw8')],i=all.indexOf(document.activeElement);if(i<0)return;
    const cols=Math.max(1,Math.round(box.clientWidth/(all[0].offsetWidth+6)))||7;
    const step={ArrowRight:1,ArrowLeft:-1,ArrowDown:cols,ArrowUp:-cols,Home:-i,End:all.length-1-i}[e.key];
    if(step!=null){e.preventDefault();pick(all[Math.max(0,Math.min(all.length-1,i+step))],true)}};
  return {get:()=>val}}
