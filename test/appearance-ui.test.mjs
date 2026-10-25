import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const page = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const api = readFileSync(new URL('../functions/api/[[path]].js', import.meta.url), 'utf8');
const log = JSON.parse(readFileSync(new URL('../public/changelog.json', import.meta.url), 'utf8'));
const pkg = JSON.parse(readFileSync(new URL('../desktop/package.json', import.meta.url), 'utf8'));

test('the look is switched only inside Settings, and the colours fade across', () => {
  assert.doesNotMatch(page, /data-theme-btn/);
  assert.doesNotMatch(page, /id="hTheme"|id="lTheme"|id="theme"/);
  assert.match(page, /h\.classList\.add\('theming'\)/);
  assert.match(page, /html\.theming,html\.theming \*,html\.theming \*::before,html\.theming \*::after\{transition:background-color \.45s ease,color \.45s ease/);
  assert.match(page, /data-set-theme="dark"/);
  assert.match(page, /data-set-theme="light"/);
});

test('text size applies to the whole interface and is remembered on the device', () => {
  assert.match(page, /function applyFs\(raw\)/);
  assert.match(page, /localStorage\.setItem\('octa_fs',String\(p\)\)/);
  assert.match(page, /type="range" min="80" max="200"/);
  assert.match(page, /xl:2/);
  assert.match(page, /function fragmentSheet/);
  assert.match(page, /選取片段/);
  assert.match(page, /id="frag"/);
  assert.match(page, /function buddySync/);
  assert.match(page, /主人！我來了～/);
  assert.match(page, /id="buddy"/);
  assert.match(page, /\/buddy\.png/);
  assert.match(page, /octa_buddy/);
  assert.match(page, /focusBot\(id\)/);
  // applied before first paint, like the theme, including the old named sizes
  assert.match(page, /var f=localStorage\.getItem\('octa_fs'\);var map=\{s:\.93,m:1,l:1\.12,xl:2\}/);
  assert.match(page, /html\[data-fs="s"\]\{--fz:\.93\}html\[data-fs="l"\]\{--fz:1\.12\}html\[data-fs="xl"\]\{--fz:2\}/);
  assert.match(page, /html\[data-fs\] body\{font-size:calc\(15px \* var\(--fz\)\)\}/);
  assert.match(page, /html\[data-fs\] \.bub\{font-size:calc\(15px \* var\(--fz\)\)\}/);
});

test('settings on a big screen is one wide two-pane page; the phone keeps the stacked list', () => {
  assert.match(page, /const settingsShell=\(\)=>!phoneUI\(\)/);
  assert.match(page, /function settingsFrame\(\)/);
  assert.match(page, /<div class="sheet settings">/);
  assert.match(page, /<nav class="snav"/);
  assert.match(page, /<div class="sbody" id="sbody">/);
  assert.match(page, /\.sgrid\{display:grid;grid-template-columns:236px minmax\(0,1fr\)/);
  assert.match(page, /\.sheet\.settings\{width:min\(980px,100%\)/);
  // the first page is 外觀 (look): theme, text size, language
  assert.match(page, /\['look','🎨','外觀','深色或紙色、字體大小、語言'\]/);
  assert.match(page, /function openLook\(\)/);
  assert.match(page, /if\(settingsShell\(\)&&!opts\.solo\)\{/);
  // pages opened from elsewhere still render inside the shell; what's-new stays its own sheet
  assert.match(page, /\{back:closeSheet,solo:true\}/);
  // coding pages render into the shell too, and leaving them stops the poll
  assert.match(page, /function codeFrame\(inner\)/);
  assert.match(page, /if\(typeof stopCodePoll==='function'\)stopCodePoll\(\);settingsGo\[b\.dataset\.s\]\(\)/);
  // the phone list no longer carries the theme buttons inline
  const phoneList = page.slice(page.indexOf('function openSettings(k)'), page.indexOf('const when=t=>'));
  assert.doesNotMatch(phoneList, /theme-pick/);
  assert.match(phoneList, /<nav class="smenu">/);
});

test('attachments show as thumbnails or file cards before and after sending', () => {
  assert.match(page, /class="chip pic\$\{f\.up\?' up':''\}"><img src="\$\{f\.url\}"/);
  assert.match(page, /class="chip file\$\{f\.up\?' up':''\}"><span class="fico">/);
  assert.match(page, /url:\/\^image\\\/\/\.test\(file\.type\)\?URL\.createObjectURL\(file\):''/);
  assert.match(page, /fileCache\[r\.id\]=Promise\.resolve\(\{name,mime,data\}\)/);
  assert.match(page, /class="fcard" data-open-file="\$\{esc\(f\.id\)\}"/);
  assert.match(page, /function fico\(name,mime\)/);
  assert.match(page, /const fsize=n=>/);
  assert.match(page, /\.chip\.pic\{position:relative;padding:0;border-radius:12px;overflow:hidden;width:64px;height:64px/);
  // the server keeps the size with the message so cards show it after a reload, in the order they were attached
  assert.match(api, /SELECT id,name,mime,size FROM files WHERE user_id=\? AND id IN/);
  assert.match(api, /files\.sort\(\(x, y\) => fileIds\.indexOf\(x\.id\) - fileIds\.indexOf\(y\.id\)\)/);
});

test('the desktop version matches the changelog, and the appearance release is still recorded', () => {
  assert.equal(pkg.version, log[0].v);
  assert.equal(log[0].v, '3.0.24');
  assert.ok(log[0].notes.some(n => n.includes('角色圖')));
  assert.ok(log[0].notes.some(n => n.includes('瀏覽器')));
  const pet = log.find(x => x.v === '3.0.23');
  assert.ok(pet.notes.some(n => n.includes('金色章魚')));
  const line = log.find(x => x.v === '3.0.22');
  assert.ok(line.notes.some(n => n.includes('Chrome')));
  assert.ok(line.notes.some(n => n.includes('選一段')));
  const side = log.find(x => x.v === '3.0.21');
  assert.ok(side.notes.some(n => n.includes('側邊視窗')));
  assert.ok(side.notes.some(n => n.includes('分頁可以關掉')));
  const quota = log.find(x => x.v === '3.0.20');
  assert.ok(quota.notes.some(n => n.includes('流量不夠')));
  const bar = log.find(x => x.v === '3.0.19');
  assert.ok(bar.notes.some(n => n.includes('返回上一頁')));
  const phone = log.find(x => x.v === '3.0.18');
  assert.ok(phone.notes.some(n => n.includes('電腦上的網址')));
  const frame = log.find(x => x.v === '3.0.17');
  assert.ok(frame.notes.some(n => n.includes('畫面框架')));
  const xl = log.find(x => x.v === '3.0.16');
  assert.ok(xl.notes.some(n => n.includes('兩倍')));
  const look = log.find(x => x.v === '3.0.13');
  assert.ok(look.notes.some(n => n.includes('字體大小')));
  assert.ok(look.notes.some(n => n.includes('縮圖')));
});
