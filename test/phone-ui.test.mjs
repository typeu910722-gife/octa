import assert from 'node:assert/strict';
import { test } from 'node:test';
import { html, js, css, fnSrc } from './app-source.mjs';

test('phone sheets rise from the bottom and menus become action sheets with a cancel', () => {
  assert.match(css, /\.veil\{padding:0;place-items:end center\}/);
  assert.match(css, /@keyframes sheetup/);
  assert.match(css, /\.menu\.asheet\{/);
  assert.match(fnSrc('popMenu'), /class="mcancel">取消</);
  assert.match(css, /\.mveil\{position:fixed;inset:0/);
  // big forms (settings, details, the phone's address sheet) are full pages with ‹
  assert.match(fnSrc('phoneSheet'), /classList\.contains\('settings'\)/);
  assert.match(css, /\.sheet\.page\{position:fixed;inset:0/);
});

test('holding or right-clicking a row or a message opens its menu, and a message can be sent on', () => {
  assert.match(js, /function holdOn\(root,find,open\)/);
  assert.match(js, /addEventListener\('contextmenu'/);
  assert.match(js, /holdOn\(\$\('list'\)/);
  assert.match(js, /holdOn\(\$\('msgs'\)/);
  assert.match(js, /傳給別的機器人…/);
  assert.match(js, /function pickTarget\(m\)/);
  assert.match(js, /askCopy\(b\.dataset\.to,msg\)/);
  // a long press must not also start a drag, and the lift that ends it must not close the menu it opened
  assert.match(js, /if\(e\.target\.closest\?\.\('\.more'\)\|\|lpHit\)\{e\.preventDefault\(\);return\}/);
  assert.match(js, /document\.addEventListener\('click',e=>\{if\(lpHit\)return;if\(!e\.target\.closest\('\.menu'\)\)closeMenu\(\)\}\)/);
  // the phone header keeps the name readable: the details button and list toggle are for big screens
  assert.match(css, /#detailBtn,#railToggle\{display:none\}/);
});

test('back goes up one level on a phone instead of leaving the page', () => {
  assert.match(js, /window\.addEventListener\('popstate'/);
  assert.match(js, /function navPush\(k\)\{if\(!phoneUI\(\)\)return;if\(navSkip>0\)\{navQueue\.push\(k\);return\}/);
  assert.match(js, /new MutationObserver\(\(\)=>\{if\(!\$\('veil'\)\.hidden\)/);
  assert.match(js, /navPush\('chat'\)/);
  assert.match(js, /navPush\('detail'\)/);
  assert.match(js, /else if\(\$\('veil'\)\.hidden&&\$\('app'\)\.classList\.contains\('chat'\)\)on='chat'/);
  assert.match(js, /if\(dy>110\)closeSheet\(\)/);
});

test('the phone can type an address for the computer browser', () => {
  assert.match(js, /const phoneRemote=\(\)=>phoneUI\(\)&&!window\.octaDesktop/);
  assert.match(js, /id="remoteUrl"/);
  assert.match(js, /電腦上的網址/);
  assert.match(js, /在電腦上打開/);
  assert.match(js, /function paintRemote\(fill\)/);
  assert.match(fnSrc('browserMenu'), /if\(phoneRemote\(\)\)\{remoteUrl\(ids\);return\}/);
  assert.match(js, /t:'\/網址'/);
  assert.match(js, /已送到電腦。打開後，這裡的網址和畫面會自己更新。/);
  assert.match(js, /不填就打開 Google/);
  assert.match(html, /id="stage"/);
  assert.match(html, /id="stHand"/);
  assert.match(html, /接手中，機器人已停止點擊和打字/);
  assert.equal(js.includes('data-usemine'), false);
});

test('chats get day separators and the phone send key is the round arrow', () => {
  assert.match(js, /function dayLabel\(ts\)/);
  assert.match(js, /I18N\.t\('昨天'\)/);
  assert.match(js, /class="day"/);
  assert.match(html, /<span class="sl">送出<\/span><span class="sa2" aria-hidden="true" data-i="send"><\/span>/);
  assert.match(css, /\.send \.sl\{display:none\}/);
  assert.match(js, /const COARSE=matchMedia\('\(hover:none\) and \(pointer:coarse\)'\)\.matches/);
  assert.match(js, /&&!COARSE\)\{e\.preventDefault\(\);\$\('f'\)\.requestSubmit\(\)\}/);
  assert.match(css, /@media \(hover:none\)\{\n  \.item\{padding:12px 8px;min-height:60px\}/);
});
